"""Shared pieces for RL training and evaluation: dataset rows, the build_world tool,
and the reward call to rl/scorer.mjs."""
import asyncio
import json
import os
import urllib.request
import uuid
from pathlib import Path

RL = Path(__file__).resolve().parent
BASE_MODEL = os.environ.get("RL_BASE_MODEL", "Qwen/Qwen3.8-27B-FP8")
SCORER = os.environ.get("RL_SCORER", "http://127.0.0.1:5176/score")
TOOL_SPEC = json.loads((RL / "data" / "tool_spec.json").read_text())


def rows(name):
    return [json.loads(l) for l in (RL / "data" / f"{name}.jsonl").read_text().splitlines() if l.strip()]


def messages(row):
    return [{"role": "system", "content": row["system"]}, {"role": "user", "content": row["user"]}]


def build_args(message):
    """The build_world arguments from a parsed assistant message, or None."""
    for call in message.get("tool_calls") or []:
        if call["function"]["name"] != "build_world":
            continue
        args = call["function"].get("arguments")
        try:
            args = json.loads(args) if isinstance(args, str) else args
        except ValueError:
            return None
        return args if isinstance(args, dict) else None
    return None


def _post(payload, timeout):
    req = urllib.request.Request(SCORER, data=json.dumps(payload).encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read())


async def score(row, args, tag="train", judge=True):
    payload = {"id": f"{tag}-{row['slug'][:40]}-{uuid.uuid4().hex[:8]}", "slug": row["slug"], "prompt": row["prompt"],
               "args": args, "judge": judge}
    return await asyncio.to_thread(_post, payload, 900)
