"""Multi-shot world-building agent backed by a River model.

Mirrors how the server runs Claude Code: same system prompt, same tools, same turn
limit, and the same stream-json events on stdout, so server/index.js handles both
backends with one code path. Vision-capable models get capture_view images; the
rest get the text layout only.

stdin: {"model", "system", "user", "tools": [{name, description, parameters, action}],
        "internal_url", "max_turns"}
env:   RIVER_API_KEY
"""
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from contextlib import closing

import river_client as river
from river_client.renderers import get_renderer, get_text_content, image_part

MAX_TOKENS = 32768  # River's per-request cap. The plain Kimi-K2.6 and GLM-5.2 contexts are
# too small for prompt + 32768; use their -262K variants.
VISION = re.compile(r"qwen3\.[568]|kimi-k2\.[56]", re.I)
CAPTURE_W, CAPTURE_H = 960, 720  # server/capture.js viewport


def emit(event):
    sys.stdout.write(json.dumps(event) + "\n")
    sys.stdout.flush()


def call(url, args):
    req = urllib.request.Request(url, data=json.dumps(args).encode(), headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=300) as res:
            return json.loads(res.read()), None
    except urllib.error.HTTPError as e:
        try:
            return None, json.loads(e.read()).get("error") or f"HTTP {e.code}"
        except ValueError:
            return None, f"HTTP {e.code}"


def main():
    job = json.load(sys.stdin)
    model, tools = job["model"], job["tools"]
    # "<base model>@river://..." samples from a trained LoRA checkpoint of that base model.
    model, _, checkpoint = model.partition("@")
    specs = [{k: t[k] for k in ("name", "description", "parameters")} for t in tools]
    action = {t["name"]: t["action"] for t in tools}
    vision = bool(VISION.search(model))
    started = time.time()
    api_ms, out_tokens, turns = 0, 0, 0
    emit({"type": "system", "subtype": "init", "model": model, "mcp_servers": [{"name": "world", "status": "connected"}]})

    # The distilled checkpoint builds directly; long reasoning only made it run out of tokens.
    renderer = get_renderer(model, thinking=False) if checkpoint or not job.get("thinking", True) else get_renderer(model)
    msgs = [{"role": "system", "content": job["system"]}, {"role": "user", "content": job["user"]}]
    built, finished, error = False, False, None
    with closing(river.Client(api_key=os.environ["RIVER_API_KEY"])) as client, client.session() as session:
        while turns < job.get("max_turns", 30) and not finished:
            sp = renderer.build_sample_prompt(msgs, tools=specs)
            t = time.time()
            kwargs = {"images": list(sp.images)} if sp.images else {}
            if checkpoint:
                kwargs["checkpoint"] = checkpoint
            sample = session.sample(sp.prompt, base_model=model, max_tokens=MAX_TOKENS, temperature=0.7, top_p=0.95,
                                    tokenizer=renderer.tokenizer, **kwargs)[0][0]
            api_ms += int((time.time() - t) * 1000)
            out_tokens += len(sample.tokens)
            turns += 1
            msg = renderer.parse_response(sample.text, tools=specs).message
            msgs.append(msg)

            content = []
            text = get_text_content(msg).strip()
            if text:
                content.append({"type": "text", "text": text})
            calls = msg.get("tool_calls") or []
            for i, c in enumerate(calls):
                c["id"] = c.get("id") or f"call_{turns}_{i}"
                args = c["function"]["arguments"]
                try:
                    args = json.loads(args) if isinstance(args, str) else (args or {})
                    # Models sometimes double-encode a nested value ("objects": "[{...}]"); decode it.
                    for k, v in list(args.items()):
                        if isinstance(v, str) and v.strip()[:1] in "[{":
                            try:
                                args[k] = json.loads(v)
                            except ValueError:
                                pass
                except ValueError:
                    args = None
                c["_args"] = args
                content.append({"type": "tool_use", "id": c["id"], "name": f"mcp__world__{c['function']['name']}", "input": args or {}})
            emit({"type": "assistant", "message": {"content": content}})

            results = []
            for c in calls:
                name = c["function"]["name"]
                if name not in action:
                    data, err = None, f"No such tool: {name}"
                elif c["_args"] is None:
                    data, err = None, "Tool arguments were not valid JSON"
                else:
                    data, err = call(f"{job['internal_url']}/{action[name]}", c["_args"])
                if data is None:
                    text = f"Error: {err}"
                    reply = text
                else:
                    text = data.get("text", "ok")
                    if action.get(name) == "place" and data.get("placed"):
                        built = True
                    if action.get(name) == "finish":
                        finished = True
                    images = data.get("images") or []
                    if images and vision:
                        # Only the latest capture keeps its images; older ones shrink to their text.
                        for m in msgs:
                            if m.get("role") == "tool" and isinstance(m.get("content"), list):
                                m["content"] = get_text_content(m) + "\n(older capture images omitted)"
                        reply = [{"type": "text", "text": text}] + [
                            image_part(base64.b64decode(im["data"]), format="jpeg", height=CAPTURE_H, width=CAPTURE_W) for im in images
                        ]
                    else:
                        reply = text
                results.append({"type": "tool_result", "tool_use_id": c["id"], "is_error": data is None, "content": text[:2000]})
                msgs.append({"role": "tool", "tool_call_id": c["id"], "name": name, "content": reply})
            for b in msg.get("unparsed_tool_calls") or []:
                text = f"Error: tool call could not be parsed ({b['error']})"
                results.append({"type": "tool_result", "tool_use_id": "unparsed", "is_error": True, "content": text})
                msgs.append({"role": "user", "content": text})
            if results:
                emit({"type": "user", "message": {"content": results}})
            else:
                if sample.stop_reason == "length":
                    error = f"Ran out of tokens ({len(sample.tokens)}) in one turn"
                break  # no tool call: the agent is done, as with Claude Code
    if not built and error is None:
        error = "The model never placed any objects"
    emit({"type": "result", "is_error": not built, "result": error or "", "num_turns": turns,
          "duration_ms": int((time.time() - started) * 1000), "duration_api_ms": api_ms,
          "total_cost_usd": None, "usage": {"output_tokens": out_tokens}})


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # report instead of dying silently, like a CLI error
        emit({"type": "result", "is_error": True, "result": f"{type(e).__name__}: {e}", "num_turns": 0})
        sys.exit(1)
