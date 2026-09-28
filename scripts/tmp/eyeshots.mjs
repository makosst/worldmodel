// Render overview + 2 free eye views for world ids.
import fs from 'node:fs';
import { World } from '../../server/world.js';
import { freeViewpoints } from '../../server/views.js';
import { capture } from '../../server/capture.js';
import { loadWorld } from '../../server/store.js';
const out = '/private/tmp/claude-501/-Users-makosst-dev-worldmodel/f306e6f6-7dbb-4e44-8808-427f30fca738/scratchpad/shots';
for (const id of process.argv.slice(2)) {
  const rec = loadWorld(id);
  const w = new World({});
  for (const o of rec.world.objects) w.objects.set(o.id, o);
  const views = ['overview', ...freeViewpoints(w, 2)];
  const imgs = await capture('http://127.0.0.1:5173', rec.world, views);
  imgs.forEach((im, i) => fs.writeFileSync(`${out}/${id.slice(0, 8)}_v${i}.jpg`, Buffer.from(im.data, 'base64')));
  console.log(id.slice(0, 8), rec.requestedModel, rec.objectCount);
}
process.exit(0);
