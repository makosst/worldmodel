// Stdio MCP server that Claude Code launches. Each tool call is forwarded to the main
// app server, which applies it to the session's world and streams it to the browser.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { TOOLS } from './tools.js';

const BASE = process.env.WORLD_URL;
const SESSION = process.env.WORLD_SESSION;

const server = new McpServer({ name: 'world', version: '3.0.0' });

for (const tool of TOOLS) {
  server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, async (args) => {
    try {
      const res = await fetch(`${BASE}/internal/${SESSION}/${tool.action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(args),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // The server formats the text for every backend; captures also carry images.
      const images = data.images || [];
      return {
        content: [{ type: 'text', text: data.text }, ...images.map((im) => ({ type: 'image', data: im.data, mimeType: 'image/jpeg' }))],
      };
    } catch (e) {
      return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
    }
  });
}

await server.connect(new StdioServerTransport());
