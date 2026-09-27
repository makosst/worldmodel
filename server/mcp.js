// Stdio MCP server that Claude Code launches. Single-shot: one build_world call
// carries the whole world, which the main app server applies and streams to the browser.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BUILD_WORLD, buildResultText } from './tools.js';

const BASE = process.env.WORLD_URL;
const SESSION = process.env.WORLD_SESSION;

const server = new McpServer({ name: 'world', version: '2.0.0' });

server.registerTool(
  BUILD_WORLD.name,
  { description: BUILD_WORLD.description, inputSchema: BUILD_WORLD.inputSchema },
  async (args) => {
    try {
      const res = await fetch(`${BASE}/internal/${SESSION}/build`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      return { content: [{ type: 'text', text: buildResultText(data) }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  },
);

await server.connect(new StdioServerTransport());
