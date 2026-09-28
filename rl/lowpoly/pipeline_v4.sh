#!/bin/bash
# Thinking-on Opus worlds -> judge -> select best -> SFT v4 -> eval on 10 held-out prompts -> judge.
set -e
cd "$(dirname "$0")/../.."
set -a; . ./.env; set +a
while [ "$(wc -l < rl/lowpoly/demos_think.jsonl)" -lt 160 ]; do sleep 20; done
python3 - <<'PY'
import json
runs=[{'id':x['id'],'model':'opus-think','prompt':x['prompt'],'status':x['status']} for x in map(json.loads,open('rl/lowpoly/demos_think.jsonl')) if x['status']=='done']
json.dump({'runs':runs},open('bench/results/demos_think.json','w'))
PY
WORLD_URL=http://127.0.0.1:5181 node bench/analyze.mjs bench/results/demos_think.json
python3 - <<'PY'
import json, statistics as st
r=[x for x in json.load(open('bench/results/demos_think.scored.json')) if x.get('quality') is not None and x['objects']>=25]
best={}
for x in r:
    if x['quality']>best.get(x['prompt'],{'quality':-1})['quality']: best[x['prompt']]=x
keep={x['id'] for x in best.values() if x['quality']>=5.5}|{x['id'] for x in r if x['quality']>=6}
sel=[x for x in r if x['id'] in keep]
print(json.dumps({'judged':len(r),'mean':round(st.mean(x['quality'] for x in r),2),'selected':len(sel),'selected_mean':round(st.mean(x['quality'] for x in sel),2),'objects':round(st.mean(x['objects'] for x in sel),1)}))
json.dump(sorted(keep),open('rl/lowpoly/select_v4.json','w'))
PY
IDS_FILE=rl/lowpoly/select_v4.json RUN=lowpoly-v4 EPOCHS=4 .venv/bin/python rl/lowpoly/sft_lowpoly.py
CK=$(cat rl/lowpoly/checkpoint-lowpoly-v4.txt)
python3 rl/lowpoly/submit.py rl/lowpoly/eval_v4.jsonl "river:Qwen/Qwen3.8-27B-FP8@$CK" eval 1 5
python3 - <<'PY'
import json
runs=[{'id':x['id'],'model':'qwen-tuned-v4','prompt':x['prompt'],'status':x['status']} for x in map(json.loads,open('rl/lowpoly/eval_v4.jsonl'))]
json.dump({'runs':runs},open('bench/results/eval10_v4.json','w'))
PY
WORLD_URL=http://127.0.0.1:5180 node bench/analyze.mjs bench/results/eval10_v4.json
echo PIPELINE_DONE
