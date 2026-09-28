"""Score a model (base or RL checkpoint) on the held-out prompts with the RL reward.
    .venv/bin/python rl/evaluate.py --tag base
    .venv/bin/python rl/evaluate.py --tag rl --checkpoint river://.../sampler_weights/world-rl-v1-final
"""
import argparse
import asyncio
import json
import os
import statistics
from contextlib import closing

import river_client as river
from river_client.renderers import get_renderer

from common import BASE_MODEL, RL, TOOL_SPEC, build_args, messages, rows, score


async def run(a):
    renderer = get_renderer(BASE_MODEL)
    eval_rows = rows("eval")
    out = RL / "results" / f"eval_{a.tag}.jsonl"
    out.unlink(missing_ok=True)
    results = []
    with closing(river.Client(api_key=os.environ["RIVER_API_KEY"])) as client, client.session(experiment="world-rl", role=f"eval-{a.tag}") as session:
        async def one(row, k):
            prompt = renderer.build_sample_prompt(messages(row), tools=[TOOL_SPEC]).prompt
            kwargs = dict(base_model=BASE_MODEL, max_tokens=32000, temperature=0.7, seed=k, tokenizer=renderer.tokenizer)
            if a.checkpoint:
                kwargs["checkpoint"] = a.checkpoint
            sample = (await asyncio.to_thread(session.sample, prompt, **kwargs))[0][0]
            args = build_args(renderer.parse_response(sample.text, tools=[TOOL_SPEC]).message)
            res = {"reward": 0.0, "n": 0, "geo": 0, "judgeScore": None} if args is None else await score(row, args, tag=f"eval-{a.tag}")
            rec = {"prompt": row["prompt"], "k": k, "tokens": len(sample.tokens), "no_tool_call": args is None,
                   **{key: res.get(key) for key in ("id", "reward", "geo", "judgeScore", "n", "judge", "geometry")}}
            out.open("a").write(json.dumps(rec) + "\n")
            results.append(rec)
            print(f"{rec['reward']:.3f} n={rec['n']} {row['prompt'][:60]}", flush=True)

        await asyncio.gather(*(one(row, k) for row in eval_rows for k in range(a.samples)))
    mean = lambda xs: statistics.mean(xs) if xs else None
    js = [r["judgeScore"] for r in results if r["judgeScore"] is not None]
    summary = {"tag": a.tag, "n": len(results), "reward": mean([r["reward"] for r in results]),
               "geo": mean([r["geo"] or 0 for r in results]), "judge": mean(js),
               "objects": mean([r["n"] or 0 for r in results]), "no_tool_call": sum(r["no_tool_call"] for r in results)}
    (RL / "results" / f"eval_{a.tag}.summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--checkpoint")
    ap.add_argument("--samples", type=int, default=2)
    asyncio.run(run(ap.parse_args()))
