"""Rejection-sampling candidates for SFT: base-model samples and Claude Opus teacher
worlds for every train prompt, each scored with the RL reward.

    .venv/bin/python rl/collect.py --source base --samples 8
    .venv/bin/python rl/collect.py --source opus --samples 2
Appends to rl/sft/candidates_<source>.jsonl; re-runs skip (slug, k) pairs already done.
"""
import argparse
import asyncio
import json
import os
import subprocess
from contextlib import closing

from common import BASE_MODEL, RL, TOOL_SPEC, build_args, messages, rows, score

OUT = RL / "sft"
OUT.mkdir(exist_ok=True)

OPUS_INSTRUCTIONS = """

## Output format for this request
Do not call tools. Reply with ONLY one JSON object, no prose and no code fences:
{"plan": "<2-4 sentences: layout plan, groups, where the focal point and walkways are>", "args": {"environment": {...}, "spawn": {...}, "objects": [...]}}
"args" are exactly the build_world arguments (environment, spawn, objects in the schema described above). Aim for 50-100 objects, dense functional groups, small items on surfaces via on_top_of."""


def done_keys(path):
    if not path.exists():
        return set()
    return {(r["slug"], r["k"]) for r in map(json.loads, path.read_text().splitlines()) if r.get("slug")}


async def scored(row, args, tag):
    if args is None:
        return {"reward": 0.0, "n": 0, "geo": 0.0, "judgeScore": None}
    try:
        return await score(row, args, tag=tag)
    except Exception as e:  # infrastructure failure: skip rather than record a zero
        return {"error": str(e)}


async def base_source(a, todo, out):
    from river_client.renderers import get_renderer
    import river_client as river

    renderer = get_renderer(BASE_MODEL)
    sem = asyncio.Semaphore(a.concurrency)
    with closing(river.Client(api_key=os.environ["RIVER_API_KEY"])) as client, \
            client.session(experiment="world-rl", role="collect") as session:
        async def one(row):
            async with sem:
                prompt = renderer.build_sample_prompt(messages(row), tools=[TOOL_SPEC]).prompt
                samples = (await asyncio.to_thread(session.sample, prompt, base_model=BASE_MODEL, num_samples=a.samples,
                                                   max_tokens=32000, temperature=0.8, tokenizer=renderer.tokenizer))[0]
            async def rec(k, s):
                args = build_args(renderer.parse_response(s.text, tools=[TOOL_SPEC]).message)
                res = await scored(row, args, "collect-base")
                if "error" in res:
                    return
                r = {"slug": row["slug"], "k": k, "source": "base", "reward": res["reward"], "judge": res.get("judgeScore"),
                     "geo": res.get("geo"), "n": res.get("n"), "id": res.get("id"),
                     "prompt_tokens": renderer.tokenizer.encode(prompt), "completion_tokens": list(s.tokens),
                     "exact": bool(s.token_data_is_exact), "stop": s.stop_reason}
                out.open("a").write(json.dumps(r) + "\n")
                print(f"base {r['reward']:.3f} n={r['n']} {row['slug'][:50]}", flush=True)
            await asyncio.gather(*(rec(k, s) for k, s in enumerate(samples)))

        await asyncio.gather(*(one(row) for row in {r["slug"]: r for r, _ in todo}.values()))


async def opus_source(a, todo, out):
    sem = asyncio.Semaphore(a.concurrency)

    async def one(row, k):
        async with sem:
            proc = await asyncio.create_subprocess_exec(
                "claude", "-p", "--model", "opus", "--output-format", "json", "--tools", "", "--setting-sources", "",
                "--no-session-persistence", "--max-turns", "1", "--system-prompt", row["system"] + OPUS_INSTRUCTIONS,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            stdout, _ = await asyncio.wait_for(proc.communicate(row["user"].encode()), timeout=900)
        try:
            text = json.loads(stdout)["result"]
            obj = json.loads(text[text.index("{"): text.rindex("}") + 1])
            args, plan = obj["args"], obj.get("plan", "")
        except Exception:
            print(f"opus parse failed {row['slug'][:50]}", flush=True)
            return
        res = await scored(row, args, "collect-opus")
        if "error" in res:
            return
        r = {"slug": row["slug"], "k": k, "source": "opus", "reward": res["reward"], "judge": res.get("judgeScore"),
             "geo": res.get("geo"), "n": res.get("n"), "id": res.get("id"), "plan": plan, "args": args}
        out.open("a").write(json.dumps(r) + "\n")
        print(f"opus {r['reward']:.3f} n={r['n']} {row['slug'][:50]}", flush=True)

    await asyncio.gather(*(one(row, k) for row, k in todo))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["base", "opus"], required=True)
    ap.add_argument("--samples", type=int, default=8)
    ap.add_argument("--concurrency", type=int, default=24)
    a = ap.parse_args()
    out = OUT / f"candidates_{a.source}.jsonl"
    have = done_keys(out)
    todo = [(row, k) for row in rows("train") for k in range(a.samples) if (row["slug"], k) not in have]
    if a.source == "base":  # base samples come in groups per prompt; redo whole prompts that are incomplete
        slugs = {row["slug"] for row, _ in todo}
        todo = [(row, 0) for row in rows("train") if row["slug"] in slugs]
    print(f"{a.source}: {len(todo)} to collect", flush=True)
    asyncio.run((base_source if a.source == "base" else opus_source)(a, todo, out))


if __name__ == "__main__":
    main()
