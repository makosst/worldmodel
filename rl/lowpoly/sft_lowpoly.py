"""Distill Opus low-poly worlds into Qwen3.8-27B: each finished Opus world becomes one
place_objects call (the whole world) followed by finish, trained on the exact system
prompt the generator used.  .venv/bin/python rl/lowpoly/sft_lowpoly.py"""
import glob, json, os, random, sys, time
from contextlib import closing
import river_client as river
from river_client.renderers import get_renderer
from river_client.renderers.base import TrainOnWhat

BASE = "Qwen/Qwen3.8-27B-FP8"
HERE = os.path.dirname(__file__)
TOOLS = json.load(open(f"{HERE}/tools.json"))
train = set(json.load(open(f"{HERE}/prompts.json"))["train"])

def world_call(rec):
    w = rec["world"]
    objs = []
    for o in sorted(w["objects"], key=lambda o: (o["y"], int(o["id"]))):
        d = {"model": o["model"], "x": o["x"], "z": o["z"], "rotation": o["rotation"]}
        if o["y"] > 0.01: d["y"] = o["y"]
        if abs(o.get("userScale", 1) - 1) > 1e-3: d["scale"] = o["userScale"]
        objs.append(d)
    env = {k: v for k, v in w["environment"].items() if k in ("ground", "sky", "weather", "shading", "fog") and v not in (None, "")}
    sp = w["spawn"]
    args = {"environment": env, "spawn": {"x": sp["x"], "z": sp["z"]}, "objects": objs}
    return args

# IDS_FILE: JSON list of world ids to train on (e.g. judge-filtered); default: every Opus train world.
ids = set(json.load(open(os.environ["IDS_FILE"]))) if os.environ.get("IDS_FILE") else None
recs = []
for f in glob.glob("data/worlds/*.json"):
    r = json.load(open(f))
    if ids is not None and r.get("id") not in ids:
        continue
    if r.get("requestedModel") == "opus" and r.get("prompt") in train and r.get("agentInput") and r.get("objectCount", 0) >= 25:
        recs.append(r)
print(json.dumps({"examples": len(recs), "mean_objects": sum(r["objectCount"] for r in recs) / max(1, len(recs))}), flush=True)
if len(recs) < 4: sys.exit("not enough demos yet")

renderer = get_renderer(BASE)
data = []
for r in recs:
    args = world_call(r)
    msgs = [{"role": "system", "content": r["agentInput"]["system"]}, {"role": "user", "content": r["agentInput"]["user"]},
            {"role": "assistant", "content": "", "reasoning_content": "I'll lay out the frame, the main functional groups and the small details in one dense placement, then finish.",
             "tool_calls": [{"type": "function", "id": "call_0", "function": {"name": "place_objects", "arguments": json.dumps(args)}}]},
            {"role": "tool", "tool_call_id": "call_0", "name": "place_objects", "content": f"Placed {len(args['objects'])} objects."},
            {"role": "assistant", "content": "", "reasoning_content": "The world is complete.",
             "tool_calls": [{"type": "function", "id": "call_1", "function": {"name": "finish", "arguments": json.dumps({"summary": r["prompt"]})}}]}]
    ex = renderer.build_training_example(msgs, tools=TOOLS, train_on=TrainOnWhat.ALL_ASSISTANT)
    ids, w = list(ex.input_ids), list(ex.weights)
    data.append({"input_ids": ids, "weights": w[1:] + [0.0], "target_tokens": ids[1:] + [ids[-1]]})

EPOCHS, LR, B = int(os.environ.get("EPOCHS", 3)), float(os.environ.get("LR", 1e-4)), 8
rng = random.Random(0)
with closing(river.Client(api_key=os.environ["RIVER_API_KEY"])) as client, client.session() as session:
    model = session.create_model(base_model=BASE, tokenizer=renderer.tokenizer, lora=river.LoraConfig(rank=32, seed=0))
    for ep in range(EPOCHS):
        rng.shuffle(data)
        for i in range(0, len(data), B):
            batch = data[i:i + B]
            ntok = sum(sum(1 for x in d["weights"] if x > 0) for d in batch)
            t = time.time()
            fb = model.forward_backward(batch, loss_fn="cross_entropy")
            model.optim_step(lr=LR, grad_clip_norm=1.0, gradient_scale=1.0 / max(1, ntok))
            print(json.dumps({"epoch": ep, "loss_per_token": round(fb.metrics["loss"] / max(1, ntok), 4), "tokens": ntok, "s": round(time.time() - t, 1)}), flush=True)
    name = os.environ.get("RUN", "lowpoly-distill")
    ck = model.save_weights(name, mode="inference")
    open(f"{HERE}/checkpoint{'' if name == 'lowpoly-distill' else '-' + name}.txt", "w").write(ck.path + "\n")
    print(json.dumps({"checkpoint": ck.path}), flush=True)
