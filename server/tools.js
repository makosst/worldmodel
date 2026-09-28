// World-building tools, shared by the MCP server (Claude Code agents) and the River
// agent runner, so every model sees exactly the same tools. Each tool maps to an
// /internal/<session>/<action> endpoint on the main server.
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
  on_top_of: z.number().int().optional().describe('Stand on an EARLIER object in this same call: its 0-based index in this objects list'),
  on_top_of_id: z.string().optional().describe('Stand on an object placed in an earlier call: its id (e.g. "12")'),
});

const environmentSchema = z.object({
  ground: z.string().optional().describe('Ground texture id from the offered ground list (plain colors grass/meadow/sand/snow/stone/dirt/lava also work)'),
  sky: z.string().optional().describe('Sky id from the offered sky list; it also sets the ambient light (plain day/sunset/night/overcast also work)'),
  weather: z.enum(['clear', 'rain', 'snow', 'fog', 'dust']).optional().describe('Weather effect (default clear)'),
  shading: z.enum(['bright', 'soft', 'golden', 'moody', 'night']).optional()
    .describe('Lighting mood: bright = midday sun, soft = diffuse, golden = warm low sun, moody = dim and contrasty, night = dark with cool light'),
  fog: z.number().optional().describe('0 (none) .. 1 (thick)'),
});

const spawnSchema = z.object({
  x: z.number(),
  z: z.number(),
  look_at_x: z.number().optional().describe('Point the player looks at (default 5)'),
  look_at_z: z.number().optional(),
});

export const TOOLS = [
  {
    name: 'place_objects',
    action: 'place',
    description:
      'Add objects to the world (can be called many times). Optionally set environment and spawn too. ' +
      'Stack with on_top_of (index within this call) or on_top_of_id (id from an earlier call). ' +
      'Returns the new ids and any problems (dropped objects, overlaps).',
    inputSchema: {
      objects: z.array(objectSchema),
      environment: environmentSchema.optional(),
      spawn: spawnSchema.optional(),
    },
  },
  {
    name: 'move_object',
    action: 'move',
    description: 'Move and/or rotate an existing object by id. Objects stacked on it do not move with it.',
    inputSchema: {
      id: z.string(),
      x: z.number(),
      z: z.number(),
      rotation: z.number().optional().describe('New rotation in degrees (default: keep)'),
      y: z.number().optional().describe('New bottom height (default: keep)'),
    },
  },
  {
    name: 'remove_objects',
    action: 'remove',
    description: 'Delete objects by id.',
    inputSchema: { ids: z.array(z.string()) },
  },
  {
    name: 'capture_view',
    action: 'capture',
    description:
      'Look at the current world: returns images (top-down map with a 1 m grid and object ids, an overview, and eye-level ' +
      'views from open spots) plus a text list of every object with its footprint. Use it after each phase and fix what looks wrong.',
    inputSchema: {
      views: z.array(z.enum(['top', 'overview', 'eye', 'north', 'south', 'east', 'west', 'player'])).optional()
        .describe('Default: top, overview and 2 eye-level views'),
    },
  },
  {
    name: 'finish',
    action: 'finish',
    description: 'Call when the world is complete.',
    inputSchema: { summary: z.string().optional().describe('One sentence describing the world') },
  },
];

export const TOOL_BY_ACTION = Object.fromEntries(TOOLS.map((t) => [t.action, t]));
export const argsSchema = (tool) => z.object(tool.inputSchema);

// OpenAI-style function specs for non-MCP agents, with the endpoint action attached.
export function toolSpecs() {
  return TOOLS.map((t) => {
    const { $schema, ...parameters } = z.toJSONSchema(argsSchema(t));
    return { name: t.name, description: t.description, parameters, action: t.action };
  });
}
