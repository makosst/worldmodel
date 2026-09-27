"""World-building agent backed by a River model.

Mirrors how the server runs Claude Code: same system prompt, same build_world
tool, same two-turn limit, and the same stream-json events on stdout, so
server/index.js handles both backends with one code path.

stdin: {"model", "system", "user", "tool": {name, description, parameters},
        "build_url", "max_turns"}
env:   RIVER_API_KEY
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from contextlib import closing

import river_client as river
from river_client.renderers import get_renderer, get_text_content

MAX_TOKENS = 32768  # River's per-request cap. The plain Kimi-K2.6 and GLM-5.2 contexts are
# too small for prompt + 32768; use their -262K variants.


def emit(event):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def call_build(url, args):
    req = urllib.request.Request(url, data=json.dumps(args).encode(), headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return json.loads(res.read()), None
    except urllib.error.HTTPError as e:
        try:
            return None, json.loads(e.read()).get("error") or f"HTTP {e.code}"
        except ValueError:
            return None, f"HTTP {e.code}"


def main():
    job = json.load(sys.stdin)
    model, tool = job["model"], job["tool"]
    started = time.time()
    api_ms, out_tokens, turns = 0, 0, 0
    emit({"type": "system", "subtype": "init", "model": model, "mcp_servers": [{"name": "world", "status": "connected"}]})

    renderer = get_renderer(model)
    msgs = [{"role": "system", "content": job["system"]}, {"role": "user", "content": job["user"]}]
    built, error = False, None
    with closing(river.Client(api_key=os.environ["RIVER_API_KEY"])) as client:
        for _ in range(job.get("max_turns", 2)):
            prompt = renderer.build_sample_prompt(msgs, tools=[tool]).prompt
            t = time.time()
            sample = client.sample(prompt, base_model=model, max_tokens=MAX_TOKENS, temperature=0.7, top_p=0.95,
                                   tokenizer=renderer.tokenizer)[0]
            api_ms += int((time.time() - t) * 1000)
            out_tokens += len(sample.tokens)
            turns += 1
            msg = renderer.parse_response(sample.text, tools=[tool]).message
            msgs.append(msg)

            content = []
            text = get_text_content(msg).strip()
            if text:
                content.append({"type": "text", "text": text})
            calls = msg.get("tool_calls") or []
            for i, c in enumerate(calls):
                args = c["function"]["arguments"]
                try:
                    args = json.loads(args) if isinstance(args, str) else args
                except ValueError:
                    args = {"_unparsed": args}
                c["_args"] = args
                content.append({"type": "tool_use", "id": c.get("id") or f"call_{turns}_{i}",
                                "name": f"mcp__world__{c['function']['name']}", "input": args})
            emit({"type": "assistant", "message": {"content": content}})

            results = []
            for i, c in enumerate(calls):
                cid = c.get("id") or f"call_{turns}_{i}"
                if c["function"]["name"] != tool["name"]:
                    data, err = None, f"No such tool: {c['function']['name']}"
                elif "_unparsed" in c["_args"]:
                    data, err = None, "Tool arguments were not valid JSON"
                else:
                    data, err = call_build(job["build_url"], c["_args"])
                if data is not None:
                    built = True
                    text = f"World built with {data['placed']} objects."
                    if data["problems"]:
                        text += " Skipped/adjusted: " + "; ".join(data["problems"])
                    text += "\nThe world is final. Reply with one short sentence describing it."
                else:
                    text = f"Error: {err}"
                results.append({"type": "tool_result", "tool_use_id": cid, "is_error": data is None, "content": text})
                msgs.append({"role": "tool", "tool_call_id": cid, "name": c["function"]["name"], "content": text})
            for b in msg.get("unparsed_tool_calls") or []:
                text = f"Error: tool call could not be parsed ({b['error']})"
                results.append({"type": "tool_result", "tool_use_id": "unparsed", "is_error": True, "content": text})
                msgs.append({"role": "user", "content": text})
            if results:
                emit({"type": "user", "message": {"content": results}})
            else:
                if sample.stop_reason == "length":
                    error = f"Ran out of tokens ({len(sample.tokens)}) before calling build_world"
                break  # no tool call: the conversation is over, as with Claude Code
    if not built and error is None:
        error = "The model never produced a valid build_world call"
    emit({"type": "result", "is_error": not built, "result": error or "", "num_turns": turns,
          "duration_ms": int((time.time() - started) * 1000), "duration_api_ms": api_ms,
          "total_cost_usd": None, "usage": {"output_tokens": out_tokens}})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # report instead of dying silently, like a CLI error
        emit({"type": "result", "is_error": True, "result": f"{type(e).__name__}: {e}", "num_turns": 0})
        sys.exit(1)
