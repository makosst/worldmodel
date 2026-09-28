import asyncio, json, os, time
from contextlib import closing
import river_client as river
from river_client.renderers import get_renderer
from common import BASE_MODEL, TOOL_SPEC, build_args, messages, rows, score
row = rows("eval")[1]
r = get_renderer(BASE_MODEL)
with closing(river.Client(api_key=os.environ["RIVER_API_KEY"])) as c:
    t = time.time()
    s = c.sample(r.build_sample_prompt(messages(row), tools=[TOOL_SPEC]).prompt, base_model=BASE_MODEL, max_tokens=28000, temperature=0.7, tokenizer=r.tokenizer)[0]
    print("sample", round(time.time()-t), "s", len(s.tokens), "tokens")
    args = build_args(r.parse_response(s.text, tools=[TOOL_SPEC]).message)
    print("objects in call:", None if args is None else len(args.get("objects", [])))
    t = time.time()
    res = asyncio.run(score(row, args, tag="smoke"))
    print("score", round(time.time()-t), "s", json.dumps({k: res.get(k) for k in ("id","reward","geo","judgeScore","n","judge","judgeError")}))
    print(json.dumps(res["geometry"]))
