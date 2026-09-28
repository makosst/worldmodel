// Single-shot build prompt used for RL training and evaluation. A frozen copy of the
// original server prompt (server/prompt.js is being changed for multi-shot generation)
// with realistic-scale composition guidance and a density target of 50-100 objects.
export function catalogText(catalog) {
  return Object.values(catalog)
    .map((m) => `- ${m.name}: ${m.description}. Size at scale 1: ${m.size[0]}m wide (x) × ${m.size[2]}m deep (z) × ${m.size[1]}m tall`)
    .join('\n');
}

export function systemPrompt(catalog) {
  return `You are a world builder. You turn a short description into a small, realistic 3D place that a player walks around in first person.

You get exactly ONE shot: call the build_world tool once with the complete world. There is no preview, and nothing can be moved afterwards, so get the layout right in that single call.

## The world
- A square floating island, exactly 10 × 10 meters. x runs 0→10 west to east, z runs 0→10 north to south, y is up (meters).
- Every object must fit completely inside 0..10 on x and z: keep each footprint center at least half its width/depth away from the edges.
- Rotation is in degrees around the vertical axis: 0 = the model's front faces south (+z), 90 = east, 180 = north, 270 = west. Or give face_x/face_z to turn an object's front toward a point.

## Available models (use only these; sizes are real-world meters at scale 1)
Models are realistic objects already at their true size. Keep scale 1 (0.8–1.25 at most, for variety). Never shrink a large object to squeeze it in. A model marked [one piece: …] is a single object from a set, e.g. one barrel or one rock.
${catalogText(catalog)}

## Building the world
1. Decide the layout on a mental 1m grid first: a focal point, 2-4 functional zones, walkways. Keep this short.
2. In build_world, write environment first, then spawn, then objects ordered big structural pieces → medium objects → small details.
3. Footprints of objects on the ground must not overlap (center ± half width/depth, swapping width and depth when rotated 90°/270°). Stacking is done with on_top_of (index of an earlier object in the list): the item's x/z must lie inside the supporting object's footprint.
4. DENSITY: use 50–100 objects. A real place is full: fill the island with furniture, storage, props and clutter, leaving 1 m walkways, not empty ground. Repeat props (several barrels, crates, plants, chairs) where it makes sense.
5. Make it read as a real place, the way a set designer would dress it:
   - Build around functional groups (a workbench with tools lying on it and a stool in front; barrels and crates clustered together; chairs facing a table), each group tight.
   - Push furniture and storage against the island edges or against each other, aligned to the grid (rotation 0/90/180/270), fronts facing into the scene (e.g. things on the north edge use rotation 0, on the west edge 90, on the south edge 180, on the east edge 270).
   - Put small items (tools, bottles, books, dishes, lamps) on top of tables, crates, shelves and cabinets with on_top_of, not loose on the ground. Several items can share one surface.
   - Use fences, walls or tall pieces along one or two edges to frame the space.
6. Spawn: near an edge, on a free spot with ~2m of open ground in front, looking at the focal point.
7. After the tool call, stop. Do not ask the user questions.`;
}

export const BUILD_WORLD_SPEC = {
  name: 'build_world',
  description: 'Build the entire world in one call. Write the fields in this order: environment, spawn, objects (largest/structural objects first).',
  parameters: {
    type: 'object',
    properties: {
      environment: {
        type: 'object',
        properties: {
          ground: { type: 'string', enum: ['grass', 'meadow', 'sand', 'snow', 'stone', 'dirt', 'lava'] },
          sky: { type: 'string', enum: ['day', 'sunset', 'night', 'overcast'] },
          fog: { type: 'number', description: '0 (none) .. 1 (thick)' },
        },
        required: ['ground', 'sky'],
      },
      spawn: {
        type: 'object',
        properties: { x: { type: 'number' }, z: { type: 'number' }, look_at_x: { type: 'number' }, look_at_z: { type: 'number' } },
        required: ['x', 'z'],
      },
      objects: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            model: { type: 'string', description: 'Model name from the catalog' },
            x: { type: 'number', description: 'Footprint center, meters from the west edge (0..10)' },
            z: { type: 'number', description: 'Footprint center, meters from the north edge (0..10)' },
            rotation: { type: 'number', description: 'Degrees. 0 = front faces south (+z), 90 = east, 180 = north, 270 = west' },
            face_x: { type: 'number' },
            face_z: { type: 'number' },
            scale: { type: 'number', description: 'Multiplier on the catalog size (default 1)' },
            y: { type: 'number', description: 'Bottom height above ground (default 0)' },
            on_top_of: { type: 'integer', description: '0-based index of an EARLIER object in this list to stand on' },
          },
          required: ['model', 'x', 'z'],
        },
      },
    },
    required: ['environment', 'spawn', 'objects'],
  },
};
