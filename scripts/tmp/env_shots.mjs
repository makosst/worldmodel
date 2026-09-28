// Render overview + eye views for worlds on the 5174 server, with optional env overrides.
import fs from 'node:fs';
import { World } from '../../server/world.js';
import { freeViewpoints } from '../../server/views.js';
import { capture } from '../../server/capture.js';
import { loadWorld } from '../../server/store.js';
const [id, tag, override] = process.argv.slice(2);
const rec = loadWorld(id);
const snap = structuredClone(rec.world);
if (override) Object.assign(snap.environment, JSON.parse(override));
const w = new World({});
for (const o of snap.objects) w.objects.set(o.id, o);
const views = ['overview', ...freeViewpoints(w, 1)];
const imgs = await capture('http://127.0.0.1:5174', snap, views);
imgs.forEach((im, i) => fs.writeFileSync(`/tmp/worldmodel-shots/${tag}_${i ? 'eye' : 'overview'}.jpg`, Buffer.from(im.data, 'base64')));
console.log(tag, JSON.stringify(snap.environment).slice(0, 120));
process.exit(0);
