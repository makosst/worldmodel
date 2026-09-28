import { NodeIO, getBounds } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const r = (v) => v.map((x) => x.toFixed(2)).join(',');
for (const name of process.argv.slice(2)) {
  const dir = `/Users/makosst/dev/3dmodels/assets/polyhaven-realistic/${name}`;
  const f = (await import('node:fs')).readdirSync(dir).find((x) => x.endsWith('.gltf'));
  const doc = await io.read(`${dir}/${f}`);
  const scene = doc.getRoot().getDefaultScene();
  const show = (n, d) => { const b = getBounds(n); console.log(' '.repeat(d * 2) + (n.getName() || '?') + (n.getMesh() ? ' [mesh]' : '') + `  min ${r(b.min)} max ${r(b.max)}`); if (d < 2) n.listChildren().forEach((c) => show(c, d + 1)); };
  console.log(`== ${name}`); scene.listChildren().forEach((n) => show(n, 1));
}
