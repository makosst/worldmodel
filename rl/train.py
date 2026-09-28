"""RL-train a single-shot world builder on River.

The policy writes ONE build_world call; rl/scorer.mjs builds, renders and judges it.
    .venv/bin/python rl/train.py --steps 25
"""
import argparse
import inspect
import json
import os
import random
import time
from contextlib import closing

import river_client as river
from river_client import rl
from river_client.renderers import get_renderer

from common import BASE_MODEL, RL, TOOL_SPEC, build_args, messages, rows, score


async def _unused(**kwargs):  # the tool is never executed; on_turn ends the episode
    return ""


BUILD_TOOL = rl.Tool(_unused, TOOL_SPEC, inspect.signature(_unused))


class WorldEnv(rl.Env):
    tools = [BUILD_TOOL]
    recovery = "stateless"

    async def reset(self, row):
        return messages(row)

    async def on_turn(self, traj):
        return None  # single shot: the first assistant turn is the whole episode

    async def reward(self, traj, row):
        args = build_args(traj.messages[-1])
        if args is None:
            traj.metrics["no_tool_call"] = 1.0
            return 0.0
        result = await score(row, args)
        traj.metrics["objects"] = float(result.get("n") or 0)
        traj.metrics["geo"] = float(result.get("geo") or 0)
        if result.get("judgeScore") is not None:
            traj.metrics["judge"] = float(result["judgeScore"])
        else:
            traj.metrics["judge_missing"] = 1.0
        return float(result["reward"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=25)
    ap.add_argument("--run", default="v1")
    ap.add_argument("--lr", type=float, default=1.5e-5)
    ap.add_argument("--groups", type=int, default=8)
    ap.add_argument("--group-size", type=int, default=8)
    a = ap.parse_args()

    run_dir = RL / "runs" / a.run
    run_dir.mkdir(parents=True, exist_ok=True)
    log = open(run_dir / "log.jsonl", "a")
    train_rows, eval_rows = rows("train"), rows("eval")
    random.Random(0).shuffle(train_rows)
    renderer = get_renderer(BASE_MODEL)
    # max_turns=2: a turn ending in a tool call needs a second slot, or the rollout counts as truncated before on_turn ends it.
    budget = rl.Budget(max_turns=2, max_generated_tokens=32000, max_context_tokens=65536, segment_tokens=8192)

    def log_step(step):
        rec = {"batch": step.n, "model_step": step.model_step, "t": time.time(), **step.metrics}
        log.write(json.dumps(rec) + "\n")
        log.flush()
        keys = ["reward/mean", "train/updated", "train/batch_seconds", "truncated/generated_tokens", "reward/zero_variance_group_frac"]
        print(json.dumps({k: rec.get(k) for k in ["batch", *keys]}), flush=True)

    with closing(river.Client(api_key=os.environ["RIVER_API_KEY"])) as client:
        with client.session(experiment="world-rl", role="train") as session, \
             client.session(experiment="world-rl", role="eval") as eval_session:
            model = session.create_model(base_model=BASE_MODEL, tokenizer=renderer.tokenizer,
                                         lora=river.LoraConfig(rank=32, seed=0))

            def evaluation_engine(checkpoint, variant):
                return rl.RolloutEngine(
                    rl.CheckpointSampler(eval_session, base_model=BASE_MODEL, checkpoint=checkpoint, tokenizer=renderer.tokenizer),
                    env=WorldEnv, renderer=renderer, budget=budget, schedule=rl.Schedule(concurrency=32), temperature=0.7, seed=1)

            def eval_sink(result):
                rec = {"eval_step": result.step, "t": time.time(), **result.metrics}
                (run_dir / "eval.jsonl").open("a").write(json.dumps(rec) + "\n")
                print("EVAL", json.dumps(rec), flush=True)

            evaluator = rl.Evaluator(eval_rows, engine_factory=evaluation_engine, every=10, group_size=2,
                                     final_group_size=2, sink=eval_sink)
            engine = rl.RolloutEngine(model, env=WorldEnv, renderer=renderer, budget=budget,
                                      schedule=rl.Schedule(concurrency=a.groups * a.group_size * 2), temperature=1.0, seed=0)
            trainer = rl.AsyncTrainer(
                engine=engine, optimizer=rl.Adam(lr=a.lr), advantage=rl.GroupCentered(),
                completion=rl.GroupCompletion(mode="wait"), normalize="token", loss="cispo",
                groups_per_step=a.groups, group_size=a.group_size, max_staleness=1,
                checkpoint=rl.Checkpointing(str(run_dir / "state"), weights_every=5, on_signal=("SIGINT", "SIGTERM")),
                evaluator=evaluator, run_config={"reward_version": 1, "prompt_version": 1},
            )
            rl.run(trainer, train_rows, steps=a.steps, on_step=log_step)
            ckpt = model.save_weights(f"world-rl-{a.run}-final", mode="inference")
            (run_dir / "final_checkpoint.txt").write_text(ckpt.path + "\n")
            print(json.dumps({"checkpoint": ckpt.path}), flush=True)


if __name__ == "__main__":
    main()
