// Scores a bench run: geometry metrics from the saved worlds, plus a blinded
// quality judgement from Claude Code (Opus) looking at three renders per world.
//
//   node bench/analyze.mjs bench/results/<runId>.json [--judge-model opus] [--no-judge]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { capture } from '../server/capture.js';
import { loadWorld } from '../server/store.js';
import { World } from '../server/world.js';

const BASE = process.env.WORLD_URL || 'http://127.0.0.1:5173';
const file = process.argv[2];
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};
const JUDGE_MODEL = arg('judge-model', 'opus');
const JUDGE = !process.argv.includes('--no-judge');
const RENDER_DIR = path.join(import.meta.dirname, 'renders');
fs.mkdirSync(RENDER_DIR, { recursive: true });

const { runs } = JSON.parse(fs.readFileSync(file, 'utf8'));

// Ground-level footprint overlaps between objects that are not stacked on each other.
function overlapCount(objects) {
  let n = 0;
  for (let i = 0; i < objects.length; i++) {
    for (let j = i + 1; j < objects.length; j++) {
      const a = World.box(objects[i]);
      const b = World.box(objects[j]);
      const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
      const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      if (ox > 0.1 && oz > 0.1 && oy > 0.05) n++;
    }
  }
  return n;
}

const JUDGE_PROMPT = (prompt, files) => `You are judging a small 3D world generated from the description: "${prompt}".
The world is a 10x10 m floating island a player explores in first person (walks, jumps ~1.1 m).
Read these three renders of it: ${files.join(', ')}
(top-down view with a 1 m grid and object ids, an overview from the south-east, and the player's view from spawn.)

Score 1-10 for each:
- prompt: how well the world matches the description (all requested elements present and recognisable)
- layout: coherent composition, sensible spacing and orientation, no objects clipping into each other
- playability: open walkable space, reachable/climbable features, a good spawn view
- appeal: how good it looks overall as a small game scene
Be strict and use the whole scale. Reply with ONLY a JSON object:
{"prompt":n,"layout":n,"playability":n,"appeal":n,"note":"one short sentence on the biggest flaw"}`;

function judge(prompt, files) {
  return new Promise((resolve) => {
    const args = ['-p', '--model', JUDGE_MODEL, '--output-format', 'json', '--tools', 'Read', '--allowedTools', 'Read',
      '--setting-sources', '', '--no-session-persistence', '--max-turns', '6'];
    const proc = spawn('claude', args, { cwd: RENDER_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (c) => (out += c));
    proc.stdin.end(JUDGE_PROMPT(prompt, files));
    proc.on('close', () => {
      try {
        const text = JSON.parse(out).result;
        resolve(JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)));
      } catch (e) {
        resolve({ error: `judge failed: ${out.slice(-300)}` });
      }
    });
  });
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

const rows = await pool(runs, 6, async (run) => {
  const rec = run.id && loadWorld(run.id);
  const row = {
    model: run.model, prompt: run.prompt, id: run.id, status: rec?.status || run.status,
    seconds: rec?.durationMs != null ? rec.durationMs / 1000 : null,
    apiSeconds: rec?.apiMs != null ? rec.apiMs / 1000 : null,
    outputTokens: rec?.outputTokens ?? null, cost: rec?.cost ?? null,
    objects: rec?.objectCount ?? 0,
    dropped: (rec?.problems || []).filter((p) => /^objects\[/.test(p)).length,
    spawnMoved: (rec?.problems || []).some((p) => p.startsWith('spawn moved')),
    overlaps: rec ? overlapCount(rec.world.objects) : null,
  };
  if (!rec || !JUDGE) return row;
  const files = [];
  for (const view of ['top', 'overview', 'player']) {
    const f = `${run.id}_${view}.jpg`;
    if (!fs.existsSync(path.join(RENDER_DIR, f))) {
      const [img] = await capture(BASE, rec.world, [view]);
      fs.writeFileSync(path.join(RENDER_DIR, f), Buffer.from(img.data, 'base64'));
    }
    files.push(f);
  }
  row.judge = await judge(run.prompt, files);
  if (!row.judge.error) row.quality = (row.judge.prompt + row.judge.layout + row.judge.playability + row.judge.appeal) / 4;
  console.log(`${row.model.padEnd(55)} q=${row.quality ?? '-'} ${row.seconds?.toFixed(0)}s  ${row.prompt}`);
  return row;
});

const out = file.replace(/\.json$/, '.scored.json');
fs.writeFileSync(out, JSON.stringify(rows, null, 1));

// Per-model summary
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const by = new Map();
for (const r of rows) by.set(r.model, [...(by.get(r.model) || []), r]);
const summary = [...by].map(([model, rs]) => {
  const ok = rs.filter((r) => r.status === 'done' && r.objects > 0);
  return {
    model, runs: rs.length, ok: ok.length,
    quality: mean(ok.map((r) => r.quality).filter((q) => q != null)),
    prompt: mean(ok.map((r) => r.judge?.prompt).filter(Boolean)),
    layout: mean(ok.map((r) => r.judge?.layout).filter(Boolean)),
    playability: mean(ok.map((r) => r.judge?.playability).filter(Boolean)),
    appeal: mean(ok.map((r) => r.judge?.appeal).filter(Boolean)),
    medianSeconds: median(rs.map((r) => r.seconds).filter((s) => s != null)),
    meanSeconds: mean(rs.map((r) => r.seconds).filter((s) => s != null)),
    meanTokens: mean(rs.map((r) => r.outputTokens).filter((s) => s != null)),
    objects: mean(ok.map((r) => r.objects)), dropped: mean(ok.map((r) => r.dropped)), overlaps: mean(ok.map((r) => r.overlaps)),
    cost: mean(rs.map((r) => r.cost).filter((c) => c != null)),
  };
}).sort((a, b) => (b.quality ?? -1) - (a.quality ?? -1));
fs.writeFileSync(file.replace(/\.json$/, '.summary.json'), JSON.stringify(summary, null, 1));
console.table(summary.map((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 100) / 100 : v]))));
process.exit(0);
