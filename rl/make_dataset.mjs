// Builds the RL dataset: per prompt, the production model selection (catalog), the
// single-shot system prompt, and reference photos from Openverse / Wikimedia Commons.
//   node --env-file=.env rl/make_dataset.mjs
import fs from 'node:fs';
import path from 'node:path';
import { selectModels } from '../server/library.js';
import { systemPrompt } from './prompt.mjs';

const RL = import.meta.dirname;
const out = JSON.parse(fs.readFileSync(path.join(RL, 'data/gen_out.json'), 'utf8')).result;
let prompts = JSON.parse(out.slice(out.indexOf('['), out.lastIndexOf(']') + 1));
const bench = JSON.parse(fs.readFileSync(path.join(RL, '..', 'bench/prompts-realistic.json'), 'utf8'));
prompts = [...new Set(prompts.map((p) => p.trim()).filter(Boolean))].filter((p) => !bench.includes(p));
const slug = (p) => p.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// Held out: the 6 benchmark prompts + every 14th generated prompt (~10).
const evalSet = [...bench, ...prompts.filter((_, i) => i % 14 === 7)];
const trainSet = prompts.filter((p) => !evalSet.includes(p));

fs.mkdirSync(path.join(RL, 'data/catalogs'), { recursive: true });
const UA = { 'user-agent': 'worldmodel-rl/0.1 (research; contact km@getmanta.ai)' };

async function searchImages(q) {
  const urls = [];
  try {
    const r = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=12&mature=false`, { headers: UA });
    if (r.ok) for (const x of (await r.json()).results || []) if (x.url) urls.push(x.thumbnail || x.url, x.url);
  } catch {}
  if (urls.length < 4) {
    try {
      const r = await fetch(`https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=12&gsrsearch=${encodeURIComponent(q)}&prop=imageinfo&iiprop=url&iiurlwidth=640`, { headers: UA });
      if (r.ok) for (const pg of Object.values((await r.json()).query?.pages || {})) { const ii = pg.imageinfo?.[0]; if (ii?.thumburl) urls.push(ii.thumburl); }
    } catch {}
  }
  return urls;
}

async function fetchRefs(p) {
  const dir = path.join(RL, 'refs', slug(p));
  fs.mkdirSync(dir, { recursive: true });
  if (fs.readdirSync(dir).filter((f) => f.startsWith('ref')).length >= 3) return;
  // Full prompt first, then a shorter query (the place itself) if too few results.
  const short = p.split(/,| with | and /)[0].replace(/^(a|an|the)\s+/i, '');
  let urls = await searchImages(p);
  if (urls.length < 4) urls = [...urls, ...(await searchImages(short))];
  let k = 0;
  for (const u of urls) {
    if (k >= 4) break;
    try {
      const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(15000) });
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !/jpeg|png/.test(type)) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 8000) continue;
      fs.writeFileSync(path.join(dir, `ref${k++}.${type.includes('png') ? 'png' : 'jpg'}`), buf);
    } catch {}
  }
}

async function row(p) {
  const s = slug(p);
  const f = path.join(RL, 'data/catalogs', `${s}.json`);
  let catalog;
  if (fs.existsSync(f)) catalog = JSON.parse(fs.readFileSync(f, 'utf8'));
  else {
    catalog = (await selectModels(p)).catalog;
    fs.writeFileSync(f, JSON.stringify(catalog));
  }
  return { slug: s, prompt: p, system: systemPrompt(catalog), user: `Build this world: ${p}` };
}

async function pool(items, n, fn) {
  const res = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k]); } }));
  return res;
}

const [trainRows, evalRows] = [await pool(trainSet, 8, row), await pool(evalSet, 8, row)];
fs.writeFileSync(path.join(RL, 'data/train.jsonl'), trainRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
fs.writeFileSync(path.join(RL, 'data/eval.jsonl'), evalRows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`train ${trainRows.length}, eval ${evalRows.length}; fetching reference photos`);
await pool([...evalSet, ...trainSet], 8, fetchRefs);
const withRefs = [...evalSet, ...trainSet].filter((p) => fs.readdirSync(path.join(RL, 'refs', slug(p))).some((f) => f.startsWith('ref'))).length;
console.log(`reference photos for ${withRefs} of ${evalSet.length + trainSet.length} prompts`);
