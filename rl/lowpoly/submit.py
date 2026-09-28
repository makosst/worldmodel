"""Submit generations to a running server and wait for them.
    python3 rl/lowpoly/submit.py <out.jsonl> <model> <prompts.json key|file> [repeats] [concurrency]"""
import json, sys, time, urllib.request, concurrent.futures as cf
import os
BASE = os.environ.get("WORLD_URL", "http://127.0.0.1:5180")
out, model, which = sys.argv[1], sys.argv[2], sys.argv[3]
reps = int(sys.argv[4]) if len(sys.argv) > 4 else 1
conc = int(sys.argv[5]) if len(sys.argv) > 5 else 12
P = json.load(open("rl/lowpoly/prompts.json"))
prompts = P[which] if which in P else json.load(open(which))
def call(path, body=None):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body else None, headers={"content-type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read())
def run(p):
    wid = call("/api/generate", {"prompt": p, "model": model})["id"]
    t = time.time()
    while time.time() - t < 1200:
        time.sleep(4)
        st = call(f"/api/world/{wid}")["status"]
        if st in ("done", "error"):
            time.sleep(6)  # let the record save
            return {"id": wid, "prompt": p, "model": model, "status": st}
    return {"id": wid, "prompt": p, "model": model, "status": "timeout"}
jobs = [p for _ in range(reps) for p in prompts]
with cf.ThreadPoolExecutor(conc) as ex, open(out, "a") as f:
    for r in ex.map(run, jobs):
        f.write(json.dumps(r) + "\n"); f.flush()
print("done", len(jobs))
