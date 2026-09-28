// Downloads a curated set of CC0 ground textures and sky HDRIs from Poly Haven,
// then indexes and embeds them so each prompt can be offered the closest options.
// Writes data/textures/{ground,sky}/<id>/..., data/textures/index.json, data/textures/embeddings.f32.
//
//   node --env-file=.env scripts/fetch-textures.mjs
// Resumable: files that already exist are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { embedTexts } from '../server/library.js';

const OUT = path.resolve(import.meta.dirname, '..', 'data', 'textures');
const API = 'https://api.polyhaven.com';

// [label, test on "name categories tags" text, how many]
const GROUND_QUOTAS = [
  ['grass', /\bgrass|lawn|meadow/, 8], ['dirt', /\bdirt|soil|ground|earth/, 7], ['mud', /\bmud/, 4],
  ['sand', /\bsand\b|beach|dune/, 6], ['gravel', /gravel|pebble/, 5], ['rock', /\brock|stone ground|cliff/, 6],
  ['snow', /\bsnow|ice\b/, 5], ['forest floor', /forest|leaves|leaf|moss|needles|pine/, 7],
  ['cobblestone', /cobble/, 6], ['paving', /paving|pavement|brick floor|sidewalk|flagstone/, 6],
  ['concrete', /concrete/, 6], ['asphalt', /asphalt|road/, 5], ['wood floor', /plank|floorboard|parquet|wood floor|laminate|wooden floor/, 8],
  ['tiles', /\btile/, 6], ['carpet', /carpet|rug|fabric|wool|fleece/, 4], ['metal floor', /metal plate|diamond plate|grate/, 2],
];
const SKY_QUOTAS = [
  ['clear day', (a) => a.categories.includes('clear') && a.categories.includes('midday'), 7],
  ['partly cloudy', (a) => a.categories.includes('partly cloudy') && a.categories.includes('outdoor'), 7],
  ['overcast', (a) => a.categories.includes('overcast') && a.categories.includes('outdoor'), 6],
  ['sunset', (a) => a.categories.includes('sunrise-sunset') && a.categories.includes('outdoor'), 7],
  ['night', (a) => a.categories.includes('night'), 6],
  ['indoor', (a) => a.categories.includes('indoor'), 7],
  ['urban', (a) => a.categories.includes('urban') && a.categories.includes('outdoor'), 5],
  ['forest', (a) => /forest|woods|trees/.test(a.tags.join(' ')), 4],
  ['beach', (a) => /beach|sea|coast|ocean/.test(a.tags.join(' ')), 3],
  ['snow', (a) => /snow|winter/.test(a.tags.join(' ')), 3],
];

async function json(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function download(url, file) {
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const item = items[next++];
      try { await fn(item); } catch (e) { console.warn(`skip ${item.id}: ${e.message}`); item.failed = true; }
    }
  }));
}

function pick(assets, quotas, test) {
  const chosen = new Map();
  const ranked = Object.entries(assets).map(([id, a]) => ({ id, ...a })).sort((a, b) => (b.download_count || 0) - (a.download_count || 0));
  for (const [label, rule, n] of quotas) {
    let got = 0;
    for (const a of ranked) {
      if (got >= n) break;
      if (chosen.has(a.id) || !test(a, rule)) continue;
      chosen.set(a.id, { ...a, group: label });
      got++;
    }
  }
  return [...chosen.values()];
}

const textText = (a) => `${a.name} ${a.categories.join(' ')} ${a.tags.join(' ')}`.toLowerCase();

const [texAssets, hdriAssets] = await Promise.all([json(`${API}/assets?t=textures`), json(`${API}/assets?t=hdris`)]);
// Ground: floor/terrain textures only (no walls, bark, roofing).
const ground = pick(texAssets, GROUND_QUOTAS, (a, rule) =>
  (a.categories.includes('floor') || a.categories.includes('terrain')) && rule.test(textText(a)));
const sky = pick(hdriAssets, SKY_QUOTAS, (a, rule) => rule(a));
console.log(`downloading ${ground.length} ground textures and ${sky.length} skies`);

await pool(ground, 12, async (a) => {
  const files = await json(`${API}/files/${a.id}`);
  const dir = path.join(OUT, 'ground', a.id);
  const maps = { diff: files.Diffuse?.['1k']?.jpg?.url, nor: files.nor_gl?.['1k']?.jpg?.url, rough: files.Rough?.['1k']?.jpg?.url };
  if (!maps.diff) throw new Error('no 1k diffuse');
  for (const [k, url] of Object.entries(maps)) if (url) await download(url, path.join(dir, `${k}.jpg`));
  a.maps = Object.fromEntries(Object.entries(maps).filter(([, u]) => u).map(([k]) => [k, `/textures/ground/${a.id}/${k}.jpg`]));
});
await pool(sky, 12, async (a) => {
  const files = await json(`${API}/files/${a.id}`);
  const url = files.hdri?.['1k']?.hdr?.url;
  if (!url) throw new Error('no 1k hdr');
  await download(url, path.join(OUT, 'sky', `${a.id}.hdr`));
  a.hdr = `/textures/sky/${a.id}.hdr`;
});

// Real-world size of one texture tile in meters (Poly Haven "dimensions" are in mm), used for tiling.
const tileMeters = (a) => {
  const mm = a.dimensions?.[0];
  return mm ? Math.min(6, Math.max(0.5, mm / 1000)) : 2;
};
const describe = (a) => {
  const d = (a.description || '').replace(/^Free (\dK |HDRI )?/i, '').split(/ - | – |\. /)[0];
  return `${a.name}${d ? `: ${d.slice(0, 90)}` : ''}`;
};
const entries = [
  ...ground.filter((a) => !a.failed).map((a) => ({ kind: 'ground', id: a.id, group: a.group, name: a.name, description: describe(a),
    maps: a.maps, tile: tileMeters(a), embedding_text: `${a.name}. ${a.group}. ${a.categories.join(', ')}. ${a.tags.join(', ')}` })),
  ...sky.filter((a) => !a.failed).map((a) => ({ kind: 'sky', id: a.id, group: a.group, name: a.name, description: describe(a),
    hdr: a.hdr, attributes: a.attributes || {}, embedding_text: `${a.name}. ${a.group}. ${a.categories.join(', ')}. ${a.tags.join(', ')}` })),
];

const vecs = await embedTexts(entries.map((e) => e.embedding_text));
const D = vecs[0].length;
const emb = new Float32Array(entries.length * D);
vecs.forEach((v, i) => emb.set(v, i * D));
fs.writeFileSync(path.join(OUT, 'embeddings.f32'), Buffer.from(emb.buffer));
fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ dim: D, entries }, null, 1));
console.log(`indexed ${entries.filter((e) => e.kind === 'ground').length} ground textures, ${entries.filter((e) => e.kind === 'sky').length} skies → ${OUT}`);
