import fs from 'node:fs';
import { World } from '../../server/world.js';
import { capture } from '../../server/capture.js';
import { loadWorld, saveWorld, thumbPath } from '../../server/store.js';
for (const id of process.argv.slice(2)) {
  const r = loadWorld(id);
  const w = new World({});
  for (const o of r.world.objects) w.objects.set(o.id, o);
  w.spawn = r.world.spawn;
  const moved = w.fixSpawn();
  console.log(id.slice(0, 8), moved || 'spawn ok');
  if (!moved) continue;
  r.world.spawn = w.spawn;
  r.problems = [...(r.problems || []), moved];
  const [img] = await capture('http://127.0.0.1:5180', r.world, ['player']);
  saveWorld(r, Buffer.from(img.data, 'base64'));
}
process.exit(0);
