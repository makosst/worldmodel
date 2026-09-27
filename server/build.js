// Single-shot world building: the agent calls build_world once with the whole world.

// Applies world spec pieces to a World, remembering which list index became which id
// so on_top_of (an index into the list) resolves correctly.
export class WorldBuilder {
  constructor(world) {
    this.world = world;
    this.count = 0; // objects consumed from the list so far
    this.idByIndex = new Map();
    this.problems = [];
    this.envSet = false;
    this.spawnSet = false;
  }

  environment(env) {
    if (this.envSet || !env) return;
    try {
      this.world.setEnvironment(env);
      this.envSet = true;
    } catch (e) {
      this.problems.push(`environment: ${e.message}`);
    }
  }

  spawn(sp) {
    if (this.spawnSet || !sp) return;
    try {
      this.world.setSpawn(sp);
      this.spawnSet = true;
    } catch (e) {
      this.problems.push(`spawn: ${e.message}`);
    }
  }

  object(spec) {
    const index = this.count++;
    const { on_top_of, ...rest } = spec || {};
    try {
      const args = { ...rest };
      if (on_top_of != null) {
        const id = this.idByIndex.get(Number(on_top_of));
        if (id) args.on_top_of = id;
        else throw new Error(`on_top_of ${on_top_of} is not an earlier placed object`);
      }
      const { object } = this.world.place(args);
      this.idByIndex.set(index, object.id);
      return object;
    } catch (e) {
      this.problems.push(`objects[${index}] ${spec?.model}: ${e.message}`);
      return null;
    }
  }

  build(spec) {
    this.environment(spec.environment);
    for (const o of Array.isArray(spec.objects) ? spec.objects : []) this.object(o);
    this.spawn(spec.spawn);
    const moved = this.world.fixSpawn();
    if (moved) this.problems.push(moved);
    return { placed: this.world.objects.size, problems: this.problems };
  }
}
