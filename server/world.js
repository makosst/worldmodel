// World state for one generation session. Coordinates: x and z run 0..10 meters,
// y is up. The top view shows +x to the right and +z downwards (south).
export const WORLD_SIZE = 10;

export const GROUNDS = {
  grass: '#6fae4f',
  meadow: '#8cc063',
  sand: '#e2cf8f',
  snow: '#f2f5f8',
  stone: '#9a9a9a',
  dirt: '#8a6a45',
  lava: '#3a2a26',
};

export const SKIES = ['day', 'sunset', 'night', 'overcast'];
export const WEATHERS = ['clear', 'rain', 'snow', 'fog', 'dust'];
export const SHADINGS = ['bright', 'soft', 'golden', 'moody', 'night'];

const r2 = (v) => Math.round(v * 100) / 100;

// Rotation (degrees, 0 = +z/south, 90 = +x/east) that points from (x, z) toward (tx, tz).
function headingTo(x, z, tx, tz) {
  if (Math.hypot(tx - x, tz - z) < 1e-6) return 0;
  return ((Math.atan2(tx - x, tz - z) * 180) / Math.PI + 360) % 360;
}

export class World {
  // envOptions: { ground: {id: {maps, tile}}, sky: {id: {hdr}} } offered textures/HDRIs for this session.
  constructor(catalog, envOptions = { ground: {}, sky: {} }) {
    this.catalog = catalog;
    this.envOptions = envOptions;
    this.objects = new Map();
    this.nextId = 1;
    this.environment = { ground: 'grass', sky: 'day', fog: 0 };
    this.spawn = { x: 5, z: 9.3, facing: 180 };
    this.listeners = new Set();
  }

  emit(event) {
    for (const fn of this.listeners) fn(event);
  }

  snapshot() {
    return {
      size: WORLD_SIZE,
      environment: this.environment,
      spawn: this.spawn,
      objects: [...this.objects.values()],
    };
  }

  // Axis-aligned footprint/height of an object after rotation and scale. model.yaw is the
  // per-model turn that makes its front face +z at rotation 0 (from orient-library.mjs).
  static extent(model, scale, rotationDeg) {
    const s = model.scale * scale;
    const [w, h, d] = model.localSize.map((v) => v * s);
    const a = ((rotationDeg + (model.yaw || 0)) * Math.PI) / 180;
    const c = Math.abs(Math.cos(a));
    const sn = Math.abs(Math.sin(a));
    return { w: w * c + d * sn, d: w * sn + d * c, h };
  }

  static box(o) {
    return {
      minX: o.x - o.extent.w / 2,
      maxX: o.x + o.extent.w / 2,
      minZ: o.z - o.extent.d / 2,
      maxZ: o.z + o.extent.d / 2,
      minY: o.y,
      maxY: o.y + o.extent.h,
    };
  }

  place({ model, x, z, rotation = 0, scale = 1, y, on_top_of, face_x, face_z }) {
    if (face_x != null && face_z != null) rotation = headingTo(x, z, face_x, face_z);
    const m = this.catalog[model];
    if (!m) {
      // Suggest close names instead of listing the whole catalog (which costs the agent a lot of tokens).
      const words = String(model).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
      const close = Object.keys(this.catalog).filter((k) => words.some((w) => k.toLowerCase().includes(w))).slice(0, 8);
      throw new Error(`Unknown model "${model}". Use an exact name from the model list${close.length ? `, e.g. ${close.join(', ')}` : ''}.`);
    }
    if (!(scale > 0.05 && scale <= 10)) throw new Error('scale must be between 0.05 and 10');
    const extent = World.extent(m, scale, rotation);
    let baseY = y ?? 0;
    if (on_top_of != null) {
      const below = this.objects.get(String(on_top_of));
      if (!below) throw new Error(`No object with id ${on_top_of}`);
      baseY = below.y + below.extent.h;
    }
    const obj = {
      id: String(this.nextId),
      model,
      url: m.url,
      pivot: m.pivot,
      nodes: m.nodes, // glTF node indices when the model is one piece of a multi-object file
      yaw: m.yaw || undefined, // turn applied inside the object so its front faces its rotation
      scale: m.scale * scale,
      userScale: scale,
      rotation: Math.round(rotation),
      x: r2(x),
      y: r2(baseY),
      z: r2(z),
      extent: { w: r2(extent.w), d: r2(extent.d), h: r2(extent.h) },
    };
    // Nudge objects that stick out a little back inside instead of failing.
    const nudge = [];
    for (const [axis, half] of [['x', extent.w / 2], ['z', extent.d / 2]]) {
      const lo = half - obj[axis];
      const hi = obj[axis] + half - WORLD_SIZE;
      const shift = lo > 0 ? lo : hi > 0 ? -hi : 0;
      if (shift && Math.abs(shift) <= 0.6 && 2 * half <= WORLD_SIZE) {
        obj[axis] = r2(obj[axis] + shift);
        nudge.push(`${axis} moved to ${obj[axis]} to stay inside the world`);
      }
    }
    const b = World.box(obj);
    const tol = 0.05;
    if (b.minX < -tol || b.maxX > WORLD_SIZE + tol || b.minZ < -tol || b.maxZ > WORLD_SIZE + tol) {
      throw new Error(
        `Object would stick out of the 10x10 world: its footprint spans x ${r2(b.minX)}..${r2(b.maxX)}, z ${r2(b.minZ)}..${r2(b.maxZ)} ` +
          `(size ${obj.extent.w}×${obj.extent.d}m). Move it inward or scale it down.`,
      );
    }
    this.nextId++;
    this.objects.set(obj.id, obj);
    this.emit({ type: 'object_added', object: obj });
    return { object: obj, warnings: [...nudge, ...this.overlaps(obj)] };
  }

  overlaps(obj) {
    const a = World.box(obj);
    const hits = [];
    for (const o of this.objects.values()) {
      if (o.id === obj.id) continue;
      const b = World.box(o);
      const ox = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
      const oz = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
      const oy = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
      if (ox > 0.1 && oz > 0.1 && oy > 0.05) hits.push(`overlaps #${o.id} ${o.model} by ${r2(ox)}×${r2(oz)}m`);
    }
    return hits;
  }

  remove(id) {
    const key = String(id);
    const o = this.objects.get(key);
    if (!o) throw new Error(`No object with id ${id}`);
    this.objects.delete(key);
    this.emit({ type: 'object_removed', id: key });
    return o;
  }

  // ground/sky: an offered texture/HDRI id, or a legacy plain color name (older worlds, RL scorer).
  // The snapshot stores the texture/HDRI URLs so saved worlds render without the texture index.
  setEnvironment({ ground, sky, fog, weather, shading }) {
    const env = this.environment;
    if (ground != null) {
      const tex = this.envOptions.ground?.[ground];
      if (tex) Object.assign(env, { ground, groundTexture: { maps: tex.maps, tile: tex.tile } });
      else if (GROUNDS[ground]) { env.ground = ground; delete env.groundTexture; }
      else throw new Error(`ground must be one of the offered textures (${Object.keys(this.envOptions.ground || {}).join(', ')}) or ${Object.keys(GROUNDS).join(', ')}`);
    }
    if (sky != null) {
      const hdri = this.envOptions.sky?.[sky];
      if (hdri) Object.assign(env, { sky, skyHdr: hdri.hdr });
      else if (SKIES.includes(sky)) { env.sky = sky; delete env.skyHdr; }
      else throw new Error(`sky must be one of the offered skies (${Object.keys(this.envOptions.sky || {}).join(', ')}) or ${SKIES.join(', ')}`);
    }
    if (weather != null) {
      if (!WEATHERS.includes(weather)) throw new Error(`weather must be one of ${WEATHERS.join(', ')}`);
      env.weather = weather;
    }
    if (shading != null) {
      if (!SHADINGS.includes(shading)) throw new Error(`shading must be one of ${SHADINGS.join(', ')}`);
      env.shading = shading;
    }
    if (fog != null) env.fog = Math.max(0, Math.min(1, fog));
    this.emit({ type: 'environment', environment: this.environment });
    return this.environment;
  }

  setSpawn({ x, z, look_at_x = WORLD_SIZE / 2, look_at_z = WORLD_SIZE / 2 }) {
    if (x < 0.3 || x > 9.7 || z < 0.3 || z > 9.7) throw new Error('spawn must be inside the world (0.3..9.7)');
    this.spawn = { x: r2(x), z: r2(z), y: r2(this.standHeight(x, z) ?? 0), facing: Math.round(headingTo(x, z, look_at_x, look_at_z)) };
    this.lookAt = { x: look_at_x, z: look_at_z };
    this.emit({ type: 'spawn', spawn: this.spawn });
    return this.spawn;
  }

  // Objects whose footprint (grown by margin) covers (px, pz).
  under(px, pz, margin) {
    return [...this.objects.values()].filter((o) => {
      const b = World.box(o);
      return px > b.minX - margin && px < b.maxX + margin && pz > b.minZ - margin && pz < b.maxZ + margin;
    });
  }

  // Height the player stands at on (x, z), or null if something tall is in the way.
  // Low things (≤1.2m) are fine to spawn on top of.
  standHeight(x, z) {
    let h = 0;
    for (const o of this.under(x, z, 0.35)) {
      const top = o.y + o.extent.h;
      if (o.y > h + 1.8) continue; // floating overhead
      if (top > 1.2) return null;
      h = Math.max(h, top);
    }
    return h;
  }

  spawnIsClear(x, z, tx, tz) {
    const h = this.standHeight(x, z);
    if (h == null) return false;
    const len = Math.hypot(tx - x, tz - z) || 1;
    const [dx, dz] = [(tx - x) / len, (tz - z) / len];
    for (let d = 0.6; d <= Math.min(2, len - 0.5); d += 0.35) {
      const blocking = this.under(x + dx * d, z + dz * d, 0.1).some((o) => o.y + o.extent.h > h + 1.0 && o.y < h + 1.8);
      if (blocking) return false;
    }
    return true;
  }

  // Single-shot builds can't look at the result, so move a blocked spawn to the
  // nearest clear spot that still looks at the same target.
  fixSpawn() {
    const { x, z } = this.spawn;
    const t = this.lookAt || { x: WORLD_SIZE / 2, z: WORLD_SIZE / 2 };
    if (this.spawnIsClear(x, z, t.x, t.z)) return null;
    let best = null;
    for (let cx = 0.5; cx <= 9.5; cx += 0.25) {
      for (let cz = 0.5; cz <= 9.5; cz += 0.25) {
        if (Math.hypot(t.x - cx, t.z - cz) < 2.5 || !this.spawnIsClear(cx, cz, t.x, t.z)) continue;
        const d = Math.hypot(cx - x, cz - z);
        if (!best || d < best.d) best = { x: cx, z: cz, d };
      }
    }
    if (!best) return null;
    this.setSpawn({ x: best.x, z: best.z, look_at_x: t.x, look_at_z: t.z });
    return `spawn moved from (${x}, ${z}) to (${best.x}, ${best.z}) because it was blocked`;
  }

  describe() {
    const lines = [...this.objects.values()].map((o) => {
      const b = World.box(o);
      return `#${o.id} ${o.model} at (x ${o.x}, z ${o.z}, base y ${o.y}) rot ${o.rotation}° scale ${o.userScale} → footprint x ${r2(b.minX)}..${r2(b.maxX)}, z ${r2(b.minZ)}..${r2(b.maxZ)}, top y ${r2(b.maxY)}`;
    });
    return (
      `Environment: ground ${this.environment.ground}, sky ${this.environment.sky}, weather ${this.environment.weather || 'clear'}, shading ${this.environment.shading || 'default'}, fog ${this.environment.fog}. ` +
      `Player spawn (x ${this.spawn.x}, z ${this.spawn.z}) facing ${this.spawn.facing}°.\n` +
      (lines.length ? lines.join('\n') : 'No objects placed yet.')
    );
  }
}
