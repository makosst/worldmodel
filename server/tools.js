// The build_world tool definition, shared by the MCP server (Claude Code agents)
// and the River agent runner, so every model sees exactly the same tool.
import { z } from 'zod';

const objectSchema = z.object({
  model: z.string().describe('Model name from the catalog'),
  x: z.number().describe('Footprint center, meters from the west edge (0..10)'),
  z: z.number().describe('Footprint center, meters from the north edge (0..10)'),
  rotation: z.number().optional().describe('Degrees around the vertical axis. 0 = front faces south (+z), 90 = east (+x), 180 = north, 270 = west'),
  face_x: z.number().optional().describe('With face_z: turn the front toward this point instead of giving rotation'),
  face_z: z.number().optional(),
  scale: z.number().optional().describe('Multiplier on the catalog size (default 1)'),
  y: z.number().optional().describe('Height of the object bottom above ground in meters (default 0)'),
  on_top_of: z.number().int().optional().describe('0-based index of an EARLIER object in this list to stand on'),
});

export const BUILD_WORLD = {
  name: 'build_world',
  description:
    'Build the entire world in one call. Can only be called once; objects cannot be moved or removed afterwards. ' +
    'Write the fields in this order: environment, spawn, objects (largest/structural objects first).',
  inputSchema: {
    environment: z.object({
      ground: z.enum(['grass', 'meadow', 'sand', 'snow', 'stone', 'dirt', 'lava']),
      sky: z.enum(['day', 'sunset', 'night', 'overcast']),
      fog: z.number().optional().describe('0 (none) .. 1 (thick)'),
    }),
    spawn: z.object({
      x: z.number(),
      z: z.number(),
      look_at_x: z.number().optional().describe('Point the player looks at (default 5)'),
      look_at_z: z.number().optional(),
    }),
    objects: z.array(objectSchema),
  },
};

export const buildWorldArgs = z.object(BUILD_WORLD.inputSchema);

// OpenAI-style function spec for non-MCP agents.
export function buildWorldSpec() {
  const { $schema, ...parameters } = z.toJSONSchema(buildWorldArgs);
  return { name: BUILD_WORLD.name, description: BUILD_WORLD.description, parameters };
}

// Text returned to the agent after a build, identical for every backend.
export function buildResultText(data) {
  let msg = `World built with ${data.placed} objects.`;
  if (data.problems.length) msg += ` Skipped/adjusted: ${data.problems.join('; ')}`;
  return `${msg}\nThe world is final. Reply with one short sentence describing it.`;
}
