// Reference photos per prompt from Openverse (photographs only, no book scans), using the
// short search queries in data/queries.json. Replaces rl/refs/<slug>/ref*.jpg and sheet.jpg.
//   node rl/fetch_refs.mjs
import fs from 'node:fs';
import path from 'node:path';

const RL = import.meta.dirname;
const queries = JSON.parse(fs.readFileSync(path.join(RL, 'data/queries.json'), 'utf8'));
const UA = { 'user-agent': 'worldmodel-rl/0.1 (research; contact km@getmanta.ai)' };
const BAD = /book|scan|page|illustration|map|diagram|logo|poster|drawing/i;

async function urlsFor(q) {
  const r = await fetch(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=20&category=photograph&mature=false`, { headers: UA });
  if (!r.ok) return [];
  return ((await r.json()).results || [])
    .filter((x) => !/internet archive/i.test(x.creator || '') && !BAD.test(x.title || '') && (x.width || 0) >= 400)
    .map((x) => x.url);
}

async function fetchOne([slug, q]) {
  const dir = path.join(RL, 'refs', slug);
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
  let urls = [];
  try { urls = await urlsFor(q); } catch {}
  if (urls.length < 3) try { urls.push(...(await urlsFor(q.split(' ').slice(0, 2).join(' ')))); } catch {}
  let k = 0;
  for (const u of urls) {
    if (k >= 4) break;
    try {
      const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(15000) });
      const type = r.headers.get('content-type') || '';
      if (!r.ok || !/jpeg|png/.test(type)) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 15000) continue;
      fs.writeFileSync(path.join(dir, `ref${k++}.${type.includes('png') ? 'png' : 'jpg'}`), buf);
    } catch {}
  }
  return k;
}

const entries = Object.entries(queries);
let i = 0, ok = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (i < entries.length) { const e = entries[i++]; if ((await fetchOne(e)) > 0) ok++; }
}));
console.log(`reference photos for ${ok} of ${entries.length} prompts`);
