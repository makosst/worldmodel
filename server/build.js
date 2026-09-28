// Incremental world building for multi-shot agents: place, move and remove objects
// across many tool calls. Problems are collected for the saved record.
import { World } from './world.js';

const r2 = (v) => Math.round(v * 100) / 100;

export class WorldBuilder {
  constructor(world) {
    this.world = world;
    this.problems = [];
  }

  environment(env) {
    if (!env) return;
    try {
      this.world.setEnvironment(env);
    } catch (e) {
      this.problems.push(`environment: ${e.message}`);
      return `environment: ${e.message}`;
    }
  }

  spawn(sp) {
    if (!sp) return;
    try {
      this.world.setSpawn(sp);
    } catch (e) {
      this.problems.push(`spawn: ${e.message}`);
      return `spawn: ${e.message}`;
    }
  }

  // objects: list of specs; on_top_of = index within this list, on_top_of_id = existing id.
  place({ objects = [], environment, spawn }) {
    const problems = [];
    const note = (p) => p && problems.push(p);
    note(this.environment(environment));
    const placed = [];
    const idByIndex = new Map();
    objects.forEach((spec, index) => {
      const { on_top_of, on_top_of_id, ...rest } = spec || {};
      try {
        const args = { ...rest };
        if (on_top_of_id != null) args.on_top_of = String(on_top_of_id);
        else if (on_top_of != null) {
          const id = idByIndex.get(Number(on_top_of));
          if (!id) throw new Error(`on_top_of ${on_top_of} is not an earlier object in this call`);
          args.on_top_of = id;
        }
        const { object, warnings } = this.world.place(args);
        idByIndex.set(index, object.id);
        placed.push({ index, id: object.id, model: object.model });
        for (const w of warnings) problems.push(`#${object.id} ${object.model}: ${w}`);
      } catch (e) {
        problems.push(`objects[${index}] ${spec?.model}: dropped — ${e.message}`);
      }
    });
    note(this.spawn(spawn));
    this.problems.push(...problems.filter((p) => p.includes('dropped')));
    return { placed, problems, total: this.world.objects.size };
  }

  move({ id, x, z, rotation, y }) {
    const key = String(id);
    const o = this.world.objects.get(key);
    if (!o) throw new Error(`No object with id ${id}`);
    const m = this.world.catalog[o.model];
    const rot = rotation ?? o.rotation;
    const extent = World.extent(m, o.userScale, rot);
    const moved = { ...o, x: r2(x), z: r2(z), y: r2(y ?? o.y), rotation: Math.round(rot), extent: { w: r2(extent.w), d: r2(extent.d), h: r2(extent.h) } };
    const b = World.box(moved);
    if (b.minX < -0.05 || b.maxX > 10.05 || b.minZ < -0.05 || b.maxZ > 10.05) {
      throw new Error(`Would stick out of the world: footprint x ${r2(b.minX)}..${r2(b.maxX)}, z ${r2(b.minZ)}..${r2(b.maxZ)}`);
    }
    // Re-emit as remove + add so viewers rebuild the object at its new placement.
    this.world.remove(key);
    this.world.objects.set(key, moved);
    this.world.emit({ type: 'object_added', object: moved });
    return { moved: key, overlaps: this.world.overlaps(moved) };
  }

  remove({ ids = [] }) {
    const removed = [];
    const missing = [];
    for (const id of ids) {
      try {
        this.world.remove(id);
        removed.push(String(id));
      } catch {
        missing.push(String(id));
      }
    }
    return { removed, missing, total: this.world.objects.size };
  }
}
