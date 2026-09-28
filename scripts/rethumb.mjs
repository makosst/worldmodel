// Re-render gallery thumbnails (player view) for worlds that use ground/sky options,
// so they show the current flat-color ground and sky.  node scripts/rethumb.mjs [baseUrl]
import fs from 'node:fs';
import path from 'node:path';
import { capture } from '../server/capture.js';
import { DATA_DIR, loadWorld } from '../server/store.js';
const base = process.argv[2] || 'http://127.0.0.1:5173';
const ids = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
let n = 0;
for (const id of ids) {
  const r = loadWorld(id);
  if (!r?.world?.environment?.groundTexture && !r?.world?.environment?.skyHdr) continue;
  const [img] = await capture(base, r.world, ['player']);
  fs.writeFileSync(path.join(DATA_DIR, `${id}.jpg`), Buffer.from(img.data, 'base64'));
  n++;
}
console.log(`re-rendered ${n} thumbnails`);
process.exit(0);
