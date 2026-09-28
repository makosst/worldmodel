"""SFT a LoRA on the best-scoring candidate per train prompt (rejection sampling).

    .venv/bin/python rl/sft.py --run sft1 --epochs 3 --lr 1e-4
Picks, per prompt, the best of rl/sft/candidates_{base,opus}.jsonl if its reward >= --min-reward
(falls back to the top --top-frac overall). Base samples train on their exact sampled tokens;
Opus worlds are rendered as an assistant build_world tool call with a short reasoning block.
"""
import argparse
import json
import os
import random
import time
from contextlib import closing

import river_client as river
from river_client.renderers import get_renderer

from common import BASE_MODEL, RL, TOOL_SPEC, messages, rows

SFT = RL / "sft"


def load(name):
    p = SFT / f"candidates_{name}.jsonl"
    return [json.loads(l) for l in p.read_text().splitlines()] if p.exists() else []


def select(min_reward, top_frac):
    best = {}
    for c in load("base") + load("opus"):
        if c.get("source") == "base" and (not c.get("exact") or c.get("stop") == "length"):
            continue
        if c["slug"] not in best or c["reward"] > best[c["slug"]]["reward"]:
            best[c["slug"]] = c
    chosen = [c for c in best.values() if c["reward"] >= min_reward]
    if len(chosen) < top_frac * len(best):
        chosen = sorted(best.values(), key=lambda c: -c["reward"])[: max(1, int(top_frac * len(best)))]
    return chosen


def datum(renderer, row, c):
    if c["source"] == "base":
        ids = c["prompt_tokens"] + c["completion_tokens"]
        weights = [0.0] * len(c["prompt_tokens"]) + [1.0] * len(c["completion_tokens"])
    else:
        msg = {"role": "assistant", "content": "", "reasoning_content": c.get("plan") or "Plan the layout, then build it.",
               "tool_calls": [{"type": "function", "id": "call_0",
                               "function": {"name": "build_world", "arguments": json.dumps(c["args"])}}]}
        ex = renderer.build_training_example(messages(row) + [msg], tools=[TOOL_SPEC])
        ids, weights = ex.input_ids, ex.weights
    # Pre-shift contract: the weight at position i trains the prediction of ids[i+1].
    w = weights[1:] + [0.0]
    return {"input_ids": ids, "weights": w, "target_tokens": ids[1:] + [ids[-1]]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", default="sft1")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--batch", type=int, default=8)
    ap.add_argument("--min-reward", type=float, default=0.55)
    ap.add_argument("--top-frac", type=float, default=0.4)
    a = ap.parse_args()

    by_slug = {r["slug"]: r for r in rows("train")}
    chosen = [c for c in select(a.min_reward, a.top_frac) if c["slug"] in by_slug]
    run_dir = RL / "runs" / a.run
    run_dir.mkdir(parents=True, exist_ok=True)
    src = {s: sum(c["source"] == s for c in chosen) for s in ("base", "opus")}
    print(json.dumps({"examples": len(chosen), "sources": src, "mean_reward": sum(c["reward"] for c in chosen) / len(chosen)}), flush=True)
    (run_dir / "selected.json").write_text(json.dumps([{k: c[k] for k in ("slug", "source", "reward", "n")} for c in chosen], indent=1))

    renderer = get_renderer(BASE_MODEL)
    data = [datum(renderer, by_slug[c["slug"]], c) for c in chosen]
    log = open(run_dir / "log.jsonl", "a")
    rng = random.Random(0)
    with closing(river.Client(api_key=os.environ["RIVER_API_KEY"])) as client, \
            client.session(experiment="world-rl", role=f"sft-{a.run}") as session:
        model = session.create_model(base_model=BASE_MODEL, tokenizer=renderer.tokenizer, lora=river.LoraConfig(rank=32, seed=0))
        steps_per_epoch = (len(data) + a.batch - 1) // a.batch
        total = steps_per_epoch * a.epochs
        step = 0
        for epoch in range(a.epochs):
            rng.shuffle(data)
            for i in range(0, len(data), a.batch):
                batch = data[i: i + a.batch]
                ntok = sum(sum(1 for w in d["weights"] if w > 0) for d in batch)
                lr = a.lr * (1 - step / total) if step > 1 else a.lr * (step + 1) / 2  # short warmup, linear decay
                t = time.time()
                fb = model.forward_backward(batch, loss_fn="cross_entropy")
                model.optim_step(lr=lr, grad_clip_norm=1.0, gradient_scale=1.0 / max(1, ntok))
                rec = {"epoch": epoch, "step": step, "loss_per_token": fb.metrics["loss"] / max(1, ntok), "lr": lr,
                       "tokens": ntok, "s": round(time.time() - t, 1)}
                log.write(json.dumps(rec) + "\n"); log.flush()
                print(json.dumps(rec), flush=True)
                step += 1
            ck = model.save_weights(f"world-{a.run}-e{epoch + 1}", mode="inference")
            (run_dir / f"checkpoint_e{epoch + 1}.txt").write_text(ck.path + "\n")
            print(json.dumps({"epoch": epoch + 1, "checkpoint": ck.path}), flush=True)
        ck = model.save_weights(f"world-{a.run}-final-train", mode="training")
        (run_dir / "checkpoint_training.txt").write_text(ck.path + "\n")


if __name__ == "__main__":
    main()
