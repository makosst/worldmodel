// Detects which side of each library model is its FRONT, so rotation 0 can always mean
// "front faces south (+z)". Renders every model alone from the south, east, north and
// west (tiles A–D), asks a vision LLM which tile shows the front, and caches the
// resulting yaw in data/library/orient.json. build-library.mjs merges it into the index.
//
//   node scripts/orient-library.mjs            (server must be running for render.html)
//   WORLD_URL=http://127.0.0.1:5173 ORIENT_MODEL=sonnet node scripts/orient-library.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { LIBRARY_OUT } from '../server/library.js';

const BASE = process.env.WORLD_URL || 'http://127.0.0.1:5173';
const MODEL = process.env.ORIENT_MODEL || 'sonnet';
const PAGES = Number(process.env.ORIENT_PAGES || 6);
const JUDGES = Number(process.env.ORIENT_JUDGES || 16);
const PER_CALL = 6; // tiles per LLM call
const TILE_DIR = path.join(LIBRARY_OUT, 'orient-tiles');
const OUT = path.join(LIBRARY_OUT, 'orient.json');
fs.mkdirSync(TILE_DIR, { recursive: true });

// Tile letter -> heading of the camera, i.e. the direction the model's front faces if that tile shows it.
const TILES = [['A', 0], ['B', 90], ['C', 180], ['D', 270]];
// Yaw that turns a front facing `heading` to face +z (heading 0).
const yawFor = (heading) => (360 - heading) % 360;

const lib = JSON.parse(fs.readFileSync(path.join(LIBRARY_OUT, 'index.json'), 'utf8'));
const orient = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const only = process.argv.slice(2);
const todo = lib.models.filter((m) => (only.length ? only.includes(m.id) : !orient[m.id]));
const safe = (id) => id.replace(/[^\w.-]+/g, '_');
const tileFile = (m) => path.join(TILE_DIR, `${safe(m.id)}.jpg`);

function snapshotFor(m) {
  const [w, h, d] = m.localSize.map((v) => v * m.scale);
  const obj = {
    id: '1', model: m.id, url: `/library/${m.file.split('/').map(encodeURIComponent).join('/')}`,
    pivot: m.pivot, nodes: m.nodes, scale: m.scale, userScale: 1, rotation: 0, x: 5, y: 0, z: 5, extent: { w, d, h },
  };
  return { snapshot: { size: 10, environment: { ground: 'stone', sky: 'overcast', fog: 0 }, spawn: { x: 5, z: 9, facing: 180 }, objects: [obj] }, w, h, d };
}

// Eye views around the object. render.js looks at height y*0.55, so y≈0.91h centers the object vertically.
function viewsFor({ w, h, d }) {
  const dist = 1.2 * Math.max(w, h, d) + 0.1;
  const y = Math.max(0.91 * h, 0.05);
  return TILES.map(([, heading]) => {
    const a = (heading * Math.PI) / 180;
    return { type: 'eye', x: 5 + Math.sin(a) * dist, z: 5 + Math.cos(a) * dist, y, look_at_x: 5, look_at_z: 5 };
  });
}

async function renderAll() {
  const need = todo.filter((m) => !fs.existsSync(tileFile(m)));
  if (!need.length) return;
  console.log(`rendering ${need.length} models`);
  const browser = await chromium.launch({ args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: PAGES }, async () => {
    let page = null, used = 0;
    const open = async () => {
      if (page) await page.close();
      page = await browser.newPage({ viewport: { width: 960, height: 720 } });
      await page.goto(`${BASE}/render.html`);
      await page.waitForFunction(() => window.ready === true);
      used = 0;
    };
    await open();
    while (next < need.length) {
      const m = need[next++];
      try {
        if (used++ > 60) await open(); // drop the page's model cache now and then
        const s = snapshotFor(m);
        const shots = [];
        for (const view of viewsFor(s)) {
          await page.evaluate(([snap, v]) => window.renderView(snap, v), [s.snapshot, view]);
          shots.push((await page.screenshot({ type: 'jpeg', quality: 70, clip: { x: 120, y: 60, width: 720, height: 600 } })).toString('base64'));
        }
        const comp = await browser.newPage({ viewport: { width: 960, height: 800 } });
        await comp.setContent(`<body style="margin:0;display:grid;grid-template-columns:480px 480px;background:#fff;font:bold 44px sans-serif">${
          shots.map((b, i) => `<div style="position:relative;width:480px;height:400px"><img src="data:image/jpeg;base64,${b}" style="width:480px;height:400px">` +
            `<span style="position:absolute;left:10px;top:6px;color:#e00;background:#fff;padding:0 8px">${TILES[i][0]}</span></div>`).join('')}</body>`);
        fs.writeFileSync(tileFile(m), await comp.screenshot({ type: 'jpeg', quality: 75 }));
        await comp.close();
      } catch (e) {
        console.warn(`render failed ${m.id}: ${e.message}`);
        await open().catch(() => {});
      }
      if (++done % 50 === 0) console.log(`  rendered ${done}/${need.length}`);
    }
    await page.close();
  }));
  await browser.close();
}

const PROMPT = (items) => `Each image below shows ONE 3D object seen from four sides (tiles A, B, C, D = four horizontal camera directions 90° apart).
For each image decide which tile shows the object's FRONT: the side a person faces or uses — the seat side of chairs/sofas/benches, the doors/drawers side of cabinets/dressers, the screen of TVs/monitors, the user side of desks/workbenches, the face of statues/figures/animals, the display side of signs, the opening of fireplaces/ovens, the business end of machines, and for vehicles the NOSE seen head-on (a narrow end with headlights/hood — never a side view).
The front is always seen head-on in its tile (the object looks roughly symmetric left-right there); a side profile is never the front.
Answer "none" if the object has no meaningful front (barrels, rocks, plants, trees, bottles, balls, round tables, most tools lying flat, symmetric items).
Read each file with the Read tool:
${items.map((it) => `- ${it.id}: ${it.file}  (${it.desc})`).join('\n')}
Reply with ONLY a JSON object mapping each id to "A", "B", "C", "D" or "none".`;

function ask(items) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--model', MODEL, '--output-format', 'json', '--tools', 'Read', '--allowedTools', 'Read',
      '--setting-sources', '', '--no-session-persistence', '--max-turns', String(items.length + 3)], { cwd: TILE_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (c) => (out += c));
    proc.stdin.end(PROMPT(items));
    proc.on('close', () => {
      try {
        const text = JSON.parse(out).result;
        resolve(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
      } catch {
        reject(new Error(`judge failed: ${out.slice(-200)}`));
      }
    });
  });
}

async function judgeAll() {
  const need = todo.filter((m) => fs.existsSync(tileFile(m)));
  const batches = [];
  for (let i = 0; i < need.length; i += PER_CALL) batches.push(need.slice(i, i + PER_CALL));
  console.log(`judging ${need.length} models in ${batches.length} calls with ${MODEL}`);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: JUDGES }, async () => {
    while (next < batches.length) {
      const batch = batches[next++];
      const items = batch.map((m) => ({ id: m.id, file: path.basename(tileFile(m)), desc: m.description.slice(0, 80) }));
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const got = await ask(items);
          for (const m of batch) {
            const a = got[m.id];
            const tile = TILES.find(([l]) => l === a);
            if (tile) orient[m.id] = { front: a, yaw: yawFor(tile[1]) };
            else if (a === 'none') orient[m.id] = { front: 'none', yaw: 0 };
          }
          fs.writeFileSync(OUT, JSON.stringify(orient, null, 1));
          break;
        } catch (e) {
          console.warn(e.message);
        }
      }
      done += batch.length;
      if (done % 60 < PER_CALL) console.log(`  judged ${done}/${need.length}`);
    }
  }));
}

await renderAll();
await judgeAll();
const vals = Object.values(orient);
console.log(`orient.json: ${vals.length} models, ${vals.filter((v) => v.yaw).length} with non-zero yaw, ${vals.filter((v) => v.front === 'none').length} without a front`);
process.exit(0);
