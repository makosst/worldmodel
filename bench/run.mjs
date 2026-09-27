// Runs the same prompts through several agent models via the running server's
// /api/generate, so results land in the normal gallery. Each model works through
// its prompts one at a time (models run in parallel) to keep timings clean.
//
//   node bench/run.mjs [--repeats N] [--models a,b,...] [--prompts file.json]
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.WORLD_URL || 'http://127.0.0.1:5173';
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
};

export const MODELS = [
  'opus',
  'sonnet',
  'river:Qwen/Qwen3.5-9B',
  'river:Qwen/Qwen3.6-35B-A3B-FP8',
  'river:Qwen/Qwen3.8-27B-FP8',
  'river:Qwen/Qwen3.5-122B-A10B-FP8',
  'river:Qwen/Qwen3.5-397B-A17B-FP8',
  'river:nvidia/Kimi-K2.6-NVFP4-262K',
  'river:nvidia/GLM-5.2-NVFP4-262K',
  'river:zai-org/GLM-5.3-Flash',
  'river:deepseek-ai/DeepSeek-V4-Flash-0731',
  'river:deepseek-ai/DeepSeek-V4.1-Flash',
  'river:nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4',
];

export const PROMPTS = [
  'a cozy town square with houses around a fountain',
  'a medieval castle courtyard with a statue',
  'a desert temple with columns and a trophy on a pedestal',
  'a platformer obstacle course with floating platforms, coins and a goal flag',
  'snowy pine forest with ancient ruins at night',
  'a tiny fishing village with a few houses and trees',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function generate(model, prompt) {
  const res = await fetch(`${BASE}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, model }),
  });
  const { id, error } = await res.json();
  if (!id) throw new Error(error || `HTTP ${res.status}`);
  const t0 = Date.now();
  for (;;) {
    await sleep(2000);
    const w = await fetch(`${BASE}/api/world/${id}`).then((r) => r.json());
    if (w.status === 'done' || w.status === 'error') {
      // Wait for the gallery record (written after the thumbnail render).
      for (let i = 0; i < 60; i++) {
        const saved = await fetch(`${BASE}/api/worlds`).then((r) => r.json());
        if (saved.some((s) => s.id === id) || !w.objects.length) break;
        await sleep(1000);
      }
      return { id, model, prompt, status: w.status, wallMs: Date.now() - t0 };
    }
    if (Date.now() - t0 > 30 * 60_000) {
      await fetch(`${BASE}/api/stop/${id}`, { method: 'POST' });
      return { id, model, prompt, status: 'timeout', wallMs: Date.now() - t0 };
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const repeats = Number(arg('repeats', 1));
  const models = arg('models') ? arg('models').split(',') : MODELS;
  const prompts = arg('prompts') ? JSON.parse(fs.readFileSync(arg('prompts'), 'utf8')) : PROMPTS;
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(import.meta.dirname, 'results', `${runId}.json`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const runs = [];
  const save = () => fs.writeFileSync(outFile, JSON.stringify({ runId, base: BASE, runs }, null, 1));

  await Promise.all(
    models.map(async (model) => {
      for (let r = 0; r < repeats; r++) {
        for (const prompt of prompts) {
          try {
            const run = await generate(model, prompt);
            runs.push({ ...run, repeat: r });
            console.log(`${run.status.padEnd(7)} ${(run.wallMs / 1000).toFixed(0).padStart(4)}s  ${model}  ${prompt}`);
          } catch (e) {
            runs.push({ model, prompt, repeat: r, status: 'failed', error: e.message });
            console.log(`failed        ${model}  ${prompt}: ${e.message}`);
          }
          save();
        }
      }
    }),
  );
  console.log(`results: ${outFile}`);
}
