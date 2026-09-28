// Camera viewpoints for looking at a world from inside it: eye-height cameras standing
// on free ground (no object within CLEARANCE), spread out, looking at the scene.
// Render them with capture(baseUrl, snapshot, views); render.js understands { type: 'eye' }.
import { World } from './world.js';

const CLEARANCE = 0.5;

function center(world) {
  const objs = [...world.objects.values()];
  if (!objs.length) return { x: 5, z: 5 };
  return { x: objs.reduce((s, o) => s + o.x, 0) / objs.length, z: objs.reduce((s, o) => s + o.z, 0) / objs.length };
}

// Returns up to n eye views from free spots, spread apart (farthest-point sampling),
// each looking at the scene's center of mass.
export function freeViewpoints(world, n = 4) {
  const target = center(world);
  const free = [];
  for (let x = 0.5; x <= 9.5; x += 0.5) {
    for (let z = 0.5; z <= 9.5; z += 0.5) {
      if (world.under(x, z, CLEARANCE).length) continue;
      if (Math.hypot(x - target.x, z - target.z) < 2) continue; // too close to see the scene
      free.push({ x, z });
    }
  }
  if (!free.length) return [];
  // Start from the free spot farthest from the center, then keep adding the spot farthest from those chosen.
  const chosen = [free.reduce((a, b) => (Math.hypot(b.x - target.x, b.z - target.z) > Math.hypot(a.x - target.x, a.z - target.z) ? b : a))];
  while (chosen.length < n && chosen.length < free.length) {
    let best = null, bestD = -1;
    for (const p of free) {
      const d = Math.min(...chosen.map((c) => Math.hypot(c.x - p.x, c.z - p.z)));
      if (d > bestD) [best, bestD] = [p, d];
    }
    chosen.push(best);
  }
  return chosen.map((p) => ({ type: 'eye', x: p.x, z: p.z, y: 1.6, look_at_x: target.x, look_at_z: target.z }));
}

export { World };
