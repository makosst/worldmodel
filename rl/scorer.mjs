// Reward service for RL: POST /score {id, slug, prompt, args} -> {reward, geo, judge, ...}
// Builds the world exactly like production (World + the prompt's selected catalog),
// scores its geometry, renders eye-level views from free spots plus top/overview,
// and asks a vision LLM judge to compare the renders with reference photos.
//
//   node --env-file=.env rl/scorer.mjs   (port 5176)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { World } from '../server/world.js';
import { freeViewpoints } from '../server/views.js';

const PORT = Number(process.env.RL_SCORER_PORT || 5176);
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const RL = path.join(ROOT, 'rl');
const PAGES = Number(process.env.RL_PAGES || 8);
const JUDGES = Number(process.env.RL_JUDGES || 24);
const JUDGE_MODEL = process.env.RL_JUDGE_MODEL || 'sonnet';
const LIB_ROOT = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/library/index.json'), 'utf8')).root;

// ---------- static files for the render page ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bin': 'application/octet-stream' };
function sendFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}
function serveFrom(res, dir, rel) {
  const file = path.join(dir, decodeURIComponent(rel));
  if (!file.startsWith(dir + path.sep)) { res.writeHead(403); return res.end(); }
  sendFile(res, file);
}

// ---------- browser pool ----------
let browser;
const idle = [];
const waiters = [];
async function newPage() {
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  await page.goto(`${BASE}/render.html`);
  await page.waitForFunction(() => window.ready === true);
  return page;
}
async function withPage(fn) {
  const page = idle.pop() || (await new Promise((r) => waiters.push(r)));
  try {
    return await fn(page);
  } catch (e) {
    // Replace a broken page so the pool keeps its size.
    page.close().catch(() => {});
    newPage().then(release, () => {});
    throw e;
  } finally {
    if (!page.isClosed()) release(page);
  }
}
function release(page) {
  const w = waiters.shift();
  if (w) w(page); else idle.push(page);
}
async function render(snapshot, views) {
  return withPage(async (page) => {
    const out = [];
    for (const view of views) {
      await page.evaluate(([s, v]) => window.renderView(s, v), [snapshot, view]);
      out.push(await page.screenshot({ type: 'jpeg', quality: 80 }));
    }
    return out;
  });
}
// A contact sheet (grid of images) as one JPEG, so the judge reads 2 images, not 10.
async function sheet(buffers, cols, cellW, cellH, labels = []) {
  return withPage(async (page) => {
    const rows = Math.ceil(buffers.length / cols);
    const cells = buffers.map((b, i) => `<div style="position:relative;width:${cellW}px;height:${cellH}px;overflow:hidden">
      <img src="data:image/jpeg;base64,${b.toString('base64')}" style="width:100%;height:100%;object-fit:cover">
      ${labels[i] ? `<span style="position:absolute;left:4px;top:4px;background:#000a;color:#fff;font:600 13px sans-serif;padding:2px 5px">${labels[i]}</span>` : ''}</div>`).join('');
    const p2 = await browser.newPage({ viewport: { width: cols * cellW, height: rows * cellH } });
    try {
      await p2.setContent(`<body style="margin:0;display:grid;grid-template-columns:repeat(${cols},${cellW}px)">${cells}</body>`);
      await p2.waitForFunction(() => [...document.images].every((i) => i.complete));
      return await p2.screenshot({ type: 'jpeg', quality: 80 });
    } finally {
      await p2.close();
    }
  });
}

// ---------- world building (same semantics as production build_world) ----------
const catalogs = new Map();
function catalogFor(slug) {
  if (!catalogs.has(slug)) catalogs.set(slug, JSON.parse(fs.readFileSync(path.join(RL, 'data/catalogs', `${slug}.json`), 'utf8')));
  return catalogs.get(slug);
}
function build(catalog, args) {
  const world = new World(catalog);
  const problems = [];
  const idByIndex = new Map();
  try { if (args.environment) world.setEnvironment(args.environment); } catch (e) { problems.push(`environment: ${e.message}`); }
  const objects = Array.isArray(args.objects) ? args.objects : [];
  objects.forEach((spec, index) => {
    try {
      const { on_top_of, ...rest } = spec || {};
      const a = { ...rest };
      if (on_top_of != null) {
        const id = idByIndex.get(Number(on_top_of));
        if (!id) throw new Error(`on_top_of ${on_top_of} is not an earlier placed object`);
        a.on_top_of = id;
      }
      for (const k of ['x', 'z', 'rotation', 'scale', 'y', 'face_x', 'face_z']) if (a[k] != null) a[k] = Number(a[k]);
      const { object } = world.place(a);
      if (on_top_of != null) object.onTop = true;
      idByIndex.set(index, object.id);
    } catch (e) {
      problems.push(`objects[${index}]: ${e.message}`);
    }
  });
  try { if (args.spawn) world.setSpawn(args.spawn); } catch (e) { problems.push(`spawn: ${e.message}`); }
  try { world.fixSpawn?.(); } catch {}
  return { world, attempted: objects.length, problems };
}

const clamp = (v) => Math.max(0, Math.min(1, v));
function geometry(world, attempted) {
  const objs = [...world.objects.values()];
  const n = objs.length;
  if (!n) return { score: 0, n: 0 };
  let overlaps = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const a = World.box(objs[i]), b = World.box(objs[j]);
    const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
    const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
    const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
    if (ox > 0.1 && oz > 0.1 && oy > 0.05) overlaps++;
  }
  let covered = 0;
  for (let x = 0.5; x < 10; x++) for (let z = 0.5; z < 10; z++) if (world.under(x, z, 0.25).length) covered++;
  const coverage = covered / 100;
  const small = objs.filter((o) => Math.max(o.extent.w, o.extent.d) < 0.6 && o.extent.h < 0.8);
  const stacked = small.filter((o) => o.y > 0.05).length;
  const unique = new Set(objs.map((o) => o.model)).size;
  // Objects hugging an edge should face into the island (rotation convention of the prompt).
  const edge = objs.filter((o) => o.y < 0.05 && Math.max(o.extent.w, o.extent.d) > 0.3);
  let edgeN = 0, edgeOk = 0;
  for (const o of edge) {
    const b = World.box(o);
    const want = b.minZ < 1.0 ? 0 : b.maxZ > 9.0 ? 180 : b.minX < 1.0 ? 90 : b.maxX > 9.0 ? 270 : null;
    if (want == null) continue;
    edgeN++;
    const d = Math.abs((((o.rotation - want) % 360) + 540) % 360 - 180);
    if (d <= 45) edgeOk++;
  }
  const c = {
    density: clamp(n / 50) * (n > 140 ? 0.7 : 1),
    validity: attempted ? n / attempted : 0,
    overlap: clamp(1 - (2 * overlaps) / n),
    coverage: clamp(coverage / 0.45) * (coverage > 0.9 ? 0.6 : 1),
    stacking: small.length ? clamp(stacked / small.length / 0.5) : 0.3,
    variety: clamp(unique / n / 0.3),
    orientation: edgeN ? edgeOk / edgeN : 0.5,
  };
  const score = 0.25 * c.density + 0.15 * c.validity + 0.2 * c.overlap + 0.15 * c.coverage + 0.1 * c.stacking + 0.05 * c.variety + 0.1 * c.orientation;
  return { score, n, overlaps, coverage, small: small.length, stacked, unique, ...Object.fromEntries(Object.entries(c).map(([k, v]) => [`c_${k}`, v])) };
}

// ---------- judge ----------
let judging = 0;
const judgeQueue = [];
async function judgeSlot(fn) {
  if (judging >= JUDGES) await new Promise((r) => judgeQueue.push(r));
  judging++;
  try { return await fn(); } finally { judging--; judgeQueue.shift()?.(); }
}
const JUDGE_PROMPT = (prompt, refFile, worldFile) => `You judge a small realistic 3D scene (a 10x10 m island) generated for the description: "${prompt}".
Read ${refFile ? `${refFile} (real reference photos of such a place) and ` : ''}${worldFile} (renders of the generated scene: a top-down map with a 1 m grid, an overview, and eye-level views from open spots).
Score 1-10 each, strictly, using the whole scale:
- prompt: the requested elements are present and recognisable
- realism: it looks like a believable real place${refFile ? ' comparable to the reference photos' : ''} (sensible scale, objects upright and grounded, no floating or clipping)
- composition: functional grouping, alignment, walkways, framing; not a random scatter
- density: as full and detailed as a real place of this kind (empty ground scores low)
- orientation: furniture and props face sensible directions (chairs toward tables, shelves against edges facing inward)
Reply with ONLY JSON: {"prompt":n,"realism":n,"composition":n,"density":n,"orientation":n,"note":"biggest flaw in a few words"}`;
function runJudge(prompt, refFile, worldFile) {
  return new Promise((resolve, reject) => {
    const args = ['-p', '--model', JUDGE_MODEL, '--output-format', 'json', '--tools', 'Read', '--allowedTools', 'Read',
      '--setting-sources', '', '--no-session-persistence', '--max-turns', '5'];
    const proc = spawn('claude', args, { cwd: RL, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 240_000);
    proc.stdout.on('data', (c) => (out += c));
    proc.stdin.end(JUDGE_PROMPT(prompt, refFile, worldFile));
    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const text = JSON.parse(out).result;
        const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
        for (const k of ['prompt', 'realism', 'composition', 'density', 'orientation']) if (!(j[k] >= 1 && j[k] <= 10)) throw new Error(`bad ${k}`);
        resolve(j);
      } catch (e) {
        reject(new Error(`judge failed: ${e.message} ${out.slice(-200)}`));
      }
    });
  });
}

async function refSheet(slug) {
  const dir = path.join(RL, 'refs', slug);
  const file = path.join(dir, 'sheet.jpg');
  if (fs.existsSync(file)) return path.relative(RL, file);
  if (!fs.existsSync(dir)) return null;
  const imgs = fs.readdirSync(dir).filter((f) => /^ref\d+\.(jpg|jpeg|png)$/i.test(f)).slice(0, 4).map((f) => fs.readFileSync(path.join(dir, f)));
  if (!imgs.length) return null;
  fs.writeFileSync(file, await sheet(imgs, 2, 480, 360));
  return path.relative(RL, file);
}

async function score({ id, slug, prompt, args, judge = true }) {
  const t0 = Date.now();
  const { world, attempted, problems } = build(catalogFor(slug), args || {});
  const geo = geometry(world, attempted);
  const out = { id, geo: geo.score, geometry: geo, problems: problems.length, n: geo.n };
  if (!geo.n) return { ...out, reward: 0, judge: null, ms: Date.now() - t0 };
  const snapshot = world.snapshot();
  const views = ['top', 'overview', ...freeViewpoints(world, 4)];
  const dir = path.join(RL, 'renders', id);
  fs.mkdirSync(dir, { recursive: true });
  const shots = await render(snapshot, views);
  const labels = ['top map', 'overview', ...views.slice(2).map((_, i) => `eye ${i + 1}`)];
  fs.writeFileSync(path.join(dir, 'world.jpg'), await sheet(shots, 3, 480, 360, labels));
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({ prompt, args, snapshot }));
  let j = null;
  if (judge) {
    const ref = await refSheet(slug);
    for (let attempt = 0; attempt < 2 && !j; attempt++) {
      try { j = await judgeSlot(() => runJudge(prompt, ref, path.relative(RL, path.join(dir, 'world.jpg')))); } catch (e) { out.judgeError = e.message; }
    }
  }
  const js = j ? (j.prompt + j.realism + j.composition + j.density + j.orientation) / 50 : null;
  // Without a judge verdict fall back to geometry alone (flagged), rather than a fake zero.
  const reward = js == null ? geo.score : 0.75 * js + 0.25 * geo.score;
  const result = { ...out, judge: j, judgeScore: js, reward, ms: Date.now() - t0 };
  fs.writeFileSync(path.join(dir, 'score.json'), JSON.stringify(result, null, 1));
  return result;
}

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, BASE).pathname;
  try {
    if (req.method === 'POST' && p === '/score') {
      let body = '';
      for await (const c of req) body += c;
      const result = await score(JSON.parse(body));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(result));
    }
    if (p.startsWith('/vendor/three/')) return serveFrom(res, path.join(ROOT, 'node_modules', 'three'), p.slice('/vendor/three/'.length));
    if (p.startsWith('/library/')) return serveFrom(res, LIB_ROOT, p.slice('/library/'.length));
    if (p.startsWith('/models/')) return serveFrom(res, path.join(ROOT, 'models'), p.slice('/models/'.length));
    return serveFrom(res, path.join(ROOT, 'public'), p.slice(1));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
  }
});
server.requestTimeout = 0;
server.listen(PORT, '127.0.0.1', async () => {
  browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  for (let i = 0; i < PAGES; i++) idle.push(await newPage());
  console.log(`scorer on ${BASE} (${PAGES} pages, ${JUDGES} judges, judge ${JUDGE_MODEL})`);
});
