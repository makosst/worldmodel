// Indexes an external model library (e.g. ~/dev/3dmodels) for world generation:
// measures each glTF/GLB model's bounds and embeds its description with OpenAI.
// Writes data/library/index.json and data/library/embeddings.f32 (row i = index[i]).
//
//   node --env-file=.env scripts/build-library.mjs
// Re-running only measures/embeds models that changed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { LIBRARY_OUT, EMBED_MODEL, embedTexts } from '../server/library.js';

const LIB = path.resolve(process.env.WORLD_LIBRARY_DIR || path.join(process.env.HOME, 'dev', '3dmodels'));
// Which art styles to index (regex on art_style). Default: the realistic Poly Haven models.
const STYLES = new RegExp(process.env.WORLD_LIBRARY_STYLES || '^realistic');
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const r3 = (v) => Math.round(v * 1000) / 1000;

// The canonical file is FBX; the renderer and bounds code need glTF, which most records have.
function gltfPath(rec) {
  if (/^(glb|gltf)$/.test(rec.preview_format)) return rec.preview_path;
  const alt = (rec.alternate_paths || []).find((p) => /\.(glb|gltf)$/i.test(p));
  if (alt) return alt;
  const base = rec.path.replace(/\.fbx$/i, '');
  for (const ext of ['.glb', '.gltf']) if (fs.existsSync(path.join(LIB, base + ext))) return base + ext;
  return null;
}

// Publisher units vary (Kenney ~1 unit tiles, some packs in centimeters). Pick a default
// scale that gives a plausible size in meters; the agent can still pass its own scale.
function defaultScale(size) {
  const max = Math.max(...size);
  if (max > 40) return 0.01; // centimeter exports
  if (max < 0.05) return 100;
  return 1;
}

function describe(rec) {
  const object = rec.tags.find((t) => t.startsWith('object:'))?.slice(7) || rec.name;
  const features = rec.tags.filter((t) => t.startsWith('feature:')).map((t) => t.slice(8)).filter((f) => !object.includes(f));
  const extra = rec.source_description ? ` — ${rec.source_description.slice(0, 120)}` : '';
  return `${object} (${rec.category}${features.length ? `; ${features.join(', ')}` : ''})${extra}`;
}

const records = fs.readFileSync(path.join(LIB, 'models.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((r) => STYLES.test(r.art_style));
fs.mkdirSync(LIBRARY_OUT, { recursive: true });
const indexFile = path.join(LIBRARY_OUT, 'index.json');
const old = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : { models: [] };
const oldById = new Map(old.models.map((m, i) => [m.id, { m, i }]));
const oldEmb = fs.existsSync(path.join(LIBRARY_OUT, 'embeddings.f32'))
  ? new Float32Array(fs.readFileSync(path.join(LIBRARY_OUT, 'embeddings.f32')).buffer.slice(0))
  : null;
const dim = old.dim || 0;

const models = [];
let skipped = 0, failed = 0, measured = 0;
const todo = records.map((rec) => ({ rec, file: gltfPath(rec) })).filter((t) => (t.file ? true : (skipped++, false)));
let next = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (next < todo.length) {
    const { rec, file } = todo[next++];
    const prev = oldById.get(rec.id)?.m;
    if (prev && prev.sha256 === rec.sha256 && prev.file === file) {
      models.push(prev);
      continue;
    }
    try {
      const doc = await io.read(path.join(LIB, file));
      const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
      const { min, max } = getBounds(scene);
      const localSize = [0, 1, 2].map((i) => max[i] - min[i]);
      if (localSize.some((v) => !isFinite(v) || v <= 0)) throw new Error('empty bounds');
      measured++;
      models.push({
        id: rec.id, name: rec.name, file, sha256: rec.sha256,
        description: describe(rec), embedding_text: rec.embedding_text,
        art_style: rec.art_style, style_group: rec.style_group, strict_style_group: rec.strict_style_group,
        category: rec.category, triangles: rec.triangles,
        pivot: [r3((min[0] + max[0]) / 2), r3(min[1]), r3((min[2] + max[2]) / 2)],
        localSize: localSize.map(r3), scale: defaultScale(localSize),
      });
    } catch (e) {
      failed++;
    }
    if ((measured + failed) % 500 === 0) console.log(`measured ${measured}, failed ${failed} of ${todo.length}`);
  }
}));
models.sort((a, b) => a.id.localeCompare(b.id));
// Save measurements first so a failed embedding run doesn't redo them.
if (!fs.existsSync(indexFile)) fs.writeFileSync(indexFile, JSON.stringify({ root: LIB, embedModel: EMBED_MODEL, dim: 0, models }));

// Embeddings: reuse rows whose text is unchanged.
const hash = (s) => createHash('sha1').update(s).digest('hex');
const reuse = new Map();
if (oldEmb && dim) for (const m of old.models) reuse.set(m.id + hash(m.embedding_text), oldById.get(m.id).i);
const missing = models.filter((m) => !reuse.has(m.id + hash(m.embedding_text)));
console.log(`embedding ${missing.length} of ${models.length} with ${EMBED_MODEL}`);
const fresh = new Map();
for (let i = 0; i < missing.length; i += 400) {
  const batch = missing.slice(i, i + 400);
  const vecs = await embedTexts(batch.map((m) => m.embedding_text));
  batch.forEach((m, j) => fresh.set(m.id, vecs[j]));
  console.log(`  embedded ${Math.min(i + 400, missing.length)}`);
}
const D = fresh.size ? fresh.values().next().value.length : dim;
const emb = new Float32Array(models.length * D);
models.forEach((m, i) => {
  const v = fresh.get(m.id) || oldEmb.subarray(reuse.get(m.id + hash(m.embedding_text)) * D, (reuse.get(m.id + hash(m.embedding_text)) + 1) * D);
  emb.set(v, i * D);
});
fs.writeFileSync(path.join(LIBRARY_OUT, 'embeddings.f32'), Buffer.from(emb.buffer));
fs.writeFileSync(indexFile, JSON.stringify({ root: LIB, embedModel: EMBED_MODEL, dim: D, models }));
console.log(`indexed ${models.length} models matching /${STYLES.source}/ (${skipped} FBX-only skipped, ${failed} unreadable) → ${LIBRARY_OUT}`);
