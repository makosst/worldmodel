// Ground textures and sky HDRIs (fetched by scripts/fetch-textures.mjs). For each prompt
// the closest few of each, by cosine similarity, are offered to the agent to choose from.
import fs from 'node:fs';
import path from 'node:path';
import { embedTexts, phrases } from './library.js';

export const TEXTURES_DIR = path.resolve(process.env.WORLD_TEXTURES_DIR || path.join(import.meta.dirname, '..', 'data', 'textures'));

const PER_KIND = 8; // closest options of each kind
// Neutral options always offered so the agent can fall back to something plain.
const FALLBACK = { ground: ['grass', 'dirt', 'concrete', 'wood floor'], sky: ['clear day', 'overcast'] };

export const WEATHER = ['clear', 'rain', 'snow', 'fog', 'dust'];
export const SHADING = ['bright', 'soft', 'golden', 'moody', 'night'];

let index = null;
export function loadTextures() {
  if (index) return index;
  const file = path.join(TEXTURES_DIR, 'index.json');
  if (!fs.existsSync(file)) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const emb = new Float32Array(fs.readFileSync(path.join(TEXTURES_DIR, 'embeddings.f32')).buffer.slice(0));
  const D = data.dim;
  for (let i = 0; i < data.entries.length; i++) {
    const row = emb.subarray(i * D, (i + 1) * D);
    let n = 0;
    for (const v of row) n += v * v;
    n = Math.sqrt(n) || 1;
    for (let j = 0; j < D; j++) row[j] /= n;
  }
  index = { ...data, emb };
  return index;
}

// Short, agent-facing description: drop resolution/marketing words.
const clean = (s) => s.replace(/\b\d+K\b|\bunclipped\b|\bfree\b|\bHDRI( of)?\b|\btexture of\b|\bmaterial:/gi, '').replace(/\s+/g, ' ').replace(/:\s*[,:]\s*/, ': ').trim();

// Returns { ground: {id: entry}, sky: {id: entry} } for the prompt.
export async function selectEnvironment(prompt) {
  const idx = loadTextures();
  if (!idx) return { ground: {}, sky: {} };
  const queries = [prompt, ...phrases(prompt).filter((p) => p !== prompt.toLowerCase())];
  const vecs = await embedTexts(queries);
  const D = idx.dim;
  const score = idx.entries.map((_, i) => {
    let best = -1;
    for (const q of vecs) {
      let s = 0, n = 0;
      for (let j = 0; j < D; j++) { s += idx.emb[i * D + j] * q[j]; n += q[j] * q[j]; }
      best = Math.max(best, s / Math.sqrt(n));
    }
    return best;
  });
  const out = { ground: {}, sky: {} };
  for (const kind of ['ground', 'sky']) {
    const ranked = idx.entries.map((e, i) => ({ e, s: score[i] })).filter((x) => x.e.kind === kind).sort((a, b) => b.s - a.s);
    for (const { e } of ranked.slice(0, PER_KIND)) out[kind][e.id] = { ...e, description: clean(e.description) };
    for (const group of FALLBACK[kind]) {
      const e = ranked.find((x) => x.e.group === group)?.e;
      if (e && !out[kind][e.id]) out[kind][e.id] = { ...e, description: clean(e.description) };
    }
  }
  return out;
}

export function environmentText(options) {
  const list = (kind) => Object.values(options[kind]).map((e) => `- ${e.id}: ${e.description}`).join('\n');
  return { ground: list('ground'), sky: list('sky') };
}
