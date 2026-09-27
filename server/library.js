// External model library (built by scripts/build-library.mjs). For each prompt,
// only models whose descriptions are close to it by cosine similarity are offered
// to the agent, all from one art style so the world looks consistent.
import fs from 'node:fs';
import path from 'node:path';

export const LIBRARY_OUT = path.resolve(process.env.WORLD_LIBRARY_INDEX || path.join(import.meta.dirname, '..', 'data', 'library'));
export const EMBED_MODEL = process.env.WORLD_EMBED_MODEL || 'text-embedding-3-small';

// Selection knobs (see selectModels).
const MAX_MODELS = Number(process.env.WORLD_MAX_MODELS || 60);
const PER_PROMPT = 30; // candidates from the whole prompt
const PER_PHRASE = 12; // candidates from each phrase of the prompt
const MARGIN = 0.15; // keep models within this cosine of a query's best match
const EXCLUDED_STYLES = new Set(['untextured base mesh']);

export async function embedTexts(texts) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
    });
    const data = await res.json();
    if (res.ok) return data.data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
    if (res.status !== 429 || attempt >= 20) throw new Error(`OpenAI embeddings failed: ${data.error?.message || res.status}`);
    // Rate limited: wait as long as OpenAI asks ("try again in 35.5s").
    const wait = Number(/try again in ([\d.]+)s/.exec(data.error?.message || '')?.[1] || 20);
    await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
  }
}

let library = null;
export function loadLibrary() {
  if (library) return library;
  const indexFile = path.join(LIBRARY_OUT, 'index.json');
  if (!fs.existsSync(indexFile)) return null;
  const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  const emb = new Float32Array(fs.readFileSync(path.join(LIBRARY_OUT, 'embeddings.f32')).buffer.slice(0));
  // Normalise rows once so a dot product is the cosine.
  const D = index.dim;
  for (let i = 0; i < index.models.length; i++) {
    const row = emb.subarray(i * D, (i + 1) * D);
    let n = 0;
    for (const v of row) n += v * v;
    n = Math.sqrt(n) || 1;
    for (let j = 0; j < D; j++) row[j] /= n;
  }
  library = { ...index, emb };
  return library;
}

// "a desert temple with columns and a trophy on a pedestal" ->
// ["desert temple", "columns", "trophy", "pedestal"]
export function phrases(prompt) {
  return prompt
    .toLowerCase()
    .split(/,|;|\band\b|\bwith\b|\baround\b|\bon top of\b|\bon\b|\bnear\b|\bnext to\b|\bin\b|\bof\b/)
    .map((s) => s.replace(/\b(a|an|the|some|few|a few|lots|many|several)\b/g, ' ').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 2);
}

function cosines(lib, q) {
  const D = lib.dim, N = lib.models.length;
  let n = 0;
  for (const v of q) n += v * v;
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    const o = i * D;
    for (let j = 0; j < D; j++) s += lib.emb[o + j] * q[j];
    out[i] = s / n;
  }
  return out;
}

// Returns { catalog, selection } where catalog has the same shape as loadCatalog().
export async function selectModels(prompt) {
  const lib = loadLibrary();
  if (!lib) return null;
  const t0 = Date.now();
  const queries = [prompt, ...phrases(prompt).filter((p) => p !== prompt.toLowerCase())];
  const vecs = await embedTexts(queries);
  const sims = vecs.map((v) => cosines(lib, v));

  // 1. Art style: the one whose best few matches fit all queries best.
  const byStyle = new Map();
  lib.models.forEach((m, i) => {
    if (EXCLUDED_STYLES.has(m.art_style)) return;
    const key = m.art_style.startsWith('realistic') ? 'realistic' : m.art_style; // PBR and scanned PBR mix fine
    if (!byStyle.has(key)) byStyle.set(key, []);
    byStyle.get(key).push(i);
  });
  let style = null, best = -Infinity;
  for (const [s, idx] of byStyle) {
    let score = 0;
    for (const q of sims) {
      const top = idx.map((i) => q[i]).sort((a, b) => b - a).slice(0, 5);
      score += top.reduce((a, b) => a + b, 0) / top.length;
    }
    if (score > best) [best, style] = [score, s];
  }
  const pool = byStyle.get(style);

  // 2. Within that style, each query contributes its closest models (within MARGIN of its best).
  const picked = new Map(); // index -> best cosine over queries
  sims.forEach((q, qi) => {
    const ranked = [...pool].sort((a, b) => q[b] - q[a]);
    const floor = q[ranked[0]] - MARGIN;
    for (const i of ranked.slice(0, qi === 0 ? PER_PROMPT : PER_PHRASE)) {
      if (q[i] < floor) break;
      picked.set(i, Math.max(picked.get(i) ?? -1, q[i]));
    }
  });
  const chosen = [...picked].sort((a, b) => b[1] - a[1]).slice(0, MAX_MODELS);

  const catalog = {};
  for (const [i, sim] of chosen) {
    const m = lib.models[i];
    catalog[m.id] = {
      name: m.id,
      file: m.file,
      url: `/library/${m.file.split('/').map(encodeURIComponent).join('/')}`,
      description: m.description,
      scale: m.scale,
      pivot: m.pivot,
      localSize: m.localSize,
      size: m.localSize.map((v) => Math.round(v * m.scale * 100) / 100),
      similarity: Math.round(sim * 1000) / 1000,
    };
  }
  return {
    catalog,
    selection: { style, queries, count: chosen.length, ms: Date.now() - t0 },
  };
}
