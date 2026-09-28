// Indexes an external model library (e.g. ~/dev/3dmodels) for world generation:
// measures each glTF model, splits multi-object "set" files into separately
// placeable parts, and embeds the descriptions with OpenAI.
// Writes data/library/index.json and data/library/embeddings.f32 (row i = models[i]).
//
//   node --env-file=.env scripts/build-library.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { LIBRARY_OUT, EMBED_MODEL, embedTexts } from '../server/library.js';

const LIB = path.resolve(process.env.WORLD_LIBRARY_DIR || path.join(process.env.HOME, 'dev', '3dmodels'));
// Which art styles to index (regex on art_style). Default: the realistic Poly Haven models.
const STYLES = new RegExp(process.env.WORLD_LIBRARY_STYLES || '^realistic');
// Optional comma-separated collection filter (strict_style_group), e.g. nature-kit,furniture-kit.
const COLLECTIONS = process.env.WORLD_LIBRARY_COLLECTIONS ? new Set(process.env.WORLD_LIBRARY_COLLECTIONS.split(',')) : null;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const r3 = (v) => Math.round(v * 1000) / 1000;

// Parts of a set that touch (within this gap, meters) belong to the same object.
const TOUCH_GAP = 0.01;
// Drop set parts smaller than these fractions of the set's largest part (splinters, planks, twigs).
const MIN_PART_FRACTION = 0.3; // of its largest dimension
const MIN_PART_VOLUME = 0.02; // of its bounding-box volume
const MAX_PARTS = 12;

// The canonical file is FBX; the renderer and bounds code need glTF, which most records have.
function gltfPath(rec) {
  if (/^(glb|gltf)$/.test(rec.preview_format)) return rec.preview_path;
  const alt = (rec.alternate_paths || []).find((p) => /\.(glb|gltf)$/i.test(p));
  if (alt) return alt;
  const base = rec.path.replace(/\.fbx$/i, '');
  for (const ext of ['.glb', '.gltf']) if (fs.existsSync(path.join(LIB, base + ext))) return base + ext;
  return null;
}

// Units vary per file (meters, centimeters, arbitrary), so the default scale comes from
// estimateScales() below; the agent can still pass its own scale on top.
const defaultScale = () => 1;

function describe(rec) {
  const object = rec.tags.find((t) => t.startsWith('object:'))?.slice(7) || rec.name;
  const features = rec.tags.filter((t) => t.startsWith('feature:')).map((t) => t.slice(8)).filter((f) => !object.includes(f));
  const extra = rec.source_description ? ` — ${rec.source_description.slice(0, 120)}` : '';
  return `${object} (${rec.category}${features.length ? `; ${features.join(', ')}` : ''})${extra}`;
}

const boxOf = (b) => ({ min: [...b.min], max: [...b.max] });
const size = (b) => [0, 1, 2].map((i) => b.max[i] - b.min[i]);
const merge = (a, b) => ({ min: a.min.map((v, i) => Math.min(v, b.min[i])), max: a.max.map((v, i) => Math.max(v, b.max[i])) });
const touches = (a, b) => [0, 1, 2].every((i) => a.min[i] <= b.max[i] + TOUCH_GAP && b.min[i] <= a.max[i] + TOUCH_GAP);

// Top-level objects of a file: the scene's children, looking through single wrapper nodes.
function units(scene) {
  let nodes = scene.listChildren();
  while (nodes.length === 1 && !nodes[0].getMesh() && nodes[0].listChildren().length) nodes = nodes[0].listChildren();
  return nodes.map((node) => ({ node, box: boxOf(getBounds(node)) })).filter((u) => size(u.box).every((v) => isFinite(v) && v >= 0));
}

// Groups touching units (union-find); each group is one placeable object.
function clusters(us) {
  const parent = us.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < us.length; i++) for (let j = i + 1; j < us.length; j++) if (touches(us[i].box, us[j].box)) parent[find(i)] = find(j);
  const groups = new Map();
  us.forEach((u, i) => groups.set(find(i), [...(groups.get(find(i)) || []), u]));
  return [...groups.values()].map((g) => ({ units: g, box: g.map((u) => u.box).reduce(merge) }));
}

function entry(rec, file, box, extra = {}) {
  const s = size(box);
  return {
    id: rec.id, name: rec.name, file, sha256: rec.sha256,
    description: describe(rec), embedding_text: rec.embedding_text,
    art_style: rec.art_style, style_group: rec.style_group, strict_style_group: rec.strict_style_group,
    category: rec.category, triangles: rec.triangles,
    // Bottom-center of the bounding box: the agent places footprint centers on the ground.
    pivot: [r3((box.min[0] + box.max[0]) / 2), r3(box.min[1]), r3((box.min[2] + box.max[2]) / 2)],
    localSize: s.map(r3), scale: defaultScale(s),
    ...extra,
  };
}

const records = fs.readFileSync(path.join(LIB, 'models.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((r) => STYLES.test(r.art_style) && (!COLLECTIONS || COLLECTIONS.has(r.strict_style_group)));
fs.mkdirSync(LIBRARY_OUT, { recursive: true });

const models = [];
let skipped = 0, failed = 0, sets = 0;
for (const rec of records) {
  const file = gltfPath(rec);
  if (!file) { skipped++; continue; }
  try {
    const doc = await io.read(path.join(LIB, file));
    const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0];
    const nodeIndex = new Map(doc.getRoot().listNodes().map((n, i) => [n, i]));
    const us = units(scene);
    let parts = us.length > 1 ? clusters(us) : [];
    if (parts.length > 1) {
      const vol = (p) => size(p.box).reduce((a, b) => a * b, 1);
      const biggest = Math.max(...parts.map((p) => Math.max(...size(p.box))));
      const biggestVol = Math.max(...parts.map(vol));
      parts = parts
        .filter((p) => Math.max(...size(p.box)) >= MIN_PART_FRACTION * biggest && vol(p) >= MIN_PART_VOLUME * biggestVol)
        .sort((a, b) => Math.max(...size(b.box)) - Math.max(...size(a.box)))
        .slice(0, MAX_PARTS);
    }
    if (parts.length > 1) {
      sets++;
      // Label a part by what its node names add to the set's shared name prefix, e.g. "barrel01".
      const all = us.map((u) => u.node.getName());
      let prefix = all.reduce((a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return a.slice(0, i); });
      prefix = prefix.slice(0, prefix.search(/[^_\-\s]*$/));
      const used = new Set();
      parts.forEach((p, k) => {
        const names = p.units.map((u) => u.node.getName().slice(prefix.length)).filter(Boolean);
        let label = (names[0] || `part${k + 1}`).replace(/[^\w-]/g, '_');
        if (used.has(label)) label = `${label}_${k + 1}`;
        used.add(label);
        models.push(entry(rec, file, p.box, {
          id: `${rec.id}#${label}`, parent: rec.id, part: label,
          nodes: p.units.map((u) => nodeIndex.get(u.node)),
          description: `${describe(rec)} [one piece: "${label}"]`,
        }));
      });
    } else if (parts.length === 1) {
      // A set with one real object left after dropping debris: keep only its nodes.
      models.push(entry(rec, file, parts[0].box, { nodes: parts[0].units.map((u) => nodeIndex.get(u.node)) }));
    } else {
      const box = boxOf(getBounds(scene));
      if (!size(box).every((v) => isFinite(v) && v > 0)) throw new Error('empty bounds');
      models.push(entry(rec, file, box));
    }
  } catch (e) {
    failed++;
    console.warn(`skip ${rec.id}: ${e.message}`);
  }
}
models.sort((a, b) => a.id.localeCompare(b.id));

// ---------- real-world size normalisation ----------
// An LLM gives each object's typical real-world size (largest dimension, meters) and a
// plausible range. A file whose measurement already falls inside the range keeps its
// units; otherwise it is scaled to the typical size. Parts of one file share its units,
// so a file gets the median factor of its parts. Cached in data/library/sizes.json.
const SIZE_MODEL = process.env.WORLD_SIZE_MODEL || 'haiku';
const sizesFile = path.join(LIBRARY_OUT, 'sizes.json');
const sizes = fs.existsSync(sizesFile) ? JSON.parse(fs.readFileSync(sizesFile, 'utf8')) : {};

function askSizes(batch) {
  const lines = batch.map((m) => `${m.id}\t${m.description}\tmeasured ${m.localSize.map((v) => +v.toPrecision(3)).join(' x ')} (w x h x d)`).join('\n');
  const prompt = `For each 3D model below, give the typical real-world size of the object's LARGEST dimension in meters, ` +
    `and a generous plausible range (a small and a large real example). The measured size is in unknown file units; use it only for ` +
    `proportions and to tell which object it is. A set piece "[one piece: X]" is that single piece.\n\n${lines}\n\n` +
    `Reply with ONLY a JSON object mapping each id to [typical, min, max], e.g. {"polyhaven/ArmChair_01": [1.0, 0.7, 1.3]}.`;
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--model', SIZE_MODEL, '--output-format', 'json', '--tools', '', '--setting-sources', '',
      '--no-session-persistence', '--max-turns', '1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (c) => (out += c));
    proc.stdin.end(prompt);
    proc.on('close', () => {
      try {
        const text = JSON.parse(out).result;
        resolve(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
      } catch (e) {
        reject(new Error(`size estimate failed: ${out.slice(-300)}`));
      }
    });
  });
}

const todoSizes = models.filter((m) => !sizes[m.id]);
if (todoSizes.length) console.log(`estimating real-world sizes for ${todoSizes.length} models with ${SIZE_MODEL}`);
const batches = [];
for (let i = 0; i < todoSizes.length; i += 40) batches.push(todoSizes.slice(i, i + 40));
let nextBatch = 0;
await Promise.all(Array.from({ length: batches.length }, async () => { // all batches at once
  while (nextBatch < batches.length) {
    const batch = batches[nextBatch++];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const got = await askSizes(batch);
        for (const m of batch) if (Array.isArray(got[m.id]) && got[m.id].every((v) => v > 0)) sizes[m.id] = got[m.id];
        fs.writeFileSync(sizesFile, JSON.stringify(sizes, null, 1));
        break;
      } catch (e) {
        console.warn(e.message);
      }
    }
  }
}));

const factorsByFile = new Map();
for (const m of models) {
  const est = sizes[m.id];
  if (!est) continue;
  const [typical, lo, hi] = est;
  const measured = Math.max(...m.localSize);
  const f = measured >= lo && measured <= hi ? 1 : typical / measured;
  factorsByFile.set(m.file, [...(factorsByFile.get(m.file) || []), f]);
}
let rescaled = 0;
for (const m of models) {
  const fs_ = (factorsByFile.get(m.file) || [1]).sort((a, b) => a - b);
  const f = fs_[Math.floor(fs_.length / 2)];
  m.scale = +f.toPrecision(4);
  if (f !== 1) rescaled++;
}
console.log(`${rescaled} models rescaled to real-world size`);

// Front orientation from scripts/orient-library.mjs: yaw that makes the front face +z.
const orientFile = path.join(LIBRARY_OUT, 'orient.json');
const orient = fs.existsSync(orientFile) ? JSON.parse(fs.readFileSync(orientFile, 'utf8')) : {};
for (const m of models) m.yaw = orient[m.id]?.yaw || 0;
console.log(`${models.filter((m) => m.yaw).length} models turned to face +z (${Object.keys(orient).length} orientations known)`);

// Embeddings, deduplicated by text (parts share their set's text) and cached across runs.
const cacheFile = path.join(LIBRARY_OUT, 'embed-cache.json');
const cache = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
const hash = (s) => createHash('sha1').update(`${EMBED_MODEL}\n${s}`).digest('hex');
const missing = [...new Set(models.map((m) => m.embedding_text))].filter((t) => !cache[hash(t)]);
console.log(`embedding ${missing.length} new texts with ${EMBED_MODEL}`);
for (let i = 0; i < missing.length; i += 400) {
  const batch = missing.slice(i, i + 400);
  const vecs = await embedTexts(batch);
  batch.forEach((t, j) => (cache[hash(t)] = Array.from(vecs[j])));
  fs.writeFileSync(cacheFile, JSON.stringify(cache));
}
const D = cache[hash(models[0].embedding_text)].length;
const emb = new Float32Array(models.length * D);
models.forEach((m, i) => emb.set(cache[hash(m.embedding_text)], i * D));
fs.writeFileSync(path.join(LIBRARY_OUT, 'embeddings.f32'), Buffer.from(emb.buffer));
fs.writeFileSync(path.join(LIBRARY_OUT, 'index.json'), JSON.stringify({ root: LIB, embedModel: EMBED_MODEL, dim: D, models }));
console.log(`indexed ${models.length} placeable models from ${records.length - skipped - failed} files matching /${STYLES.source}/ ` +
  `(${sets} sets split into parts, ${skipped} without glTF, ${failed} unreadable) → ${LIBRARY_OUT}`);
