import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { selectModels, loadLibrary } from './library.js';
import { selectEnvironment, TEXTURES_DIR } from './textures.js';
import { World } from './world.js';
import { capture } from './capture.js';
import { systemPrompt } from './prompt.js';
import { WorldBuilder } from './build.js';
import { saveWorld, loadWorld, listWorlds, thumbPath } from './store.js';
import { TOOLS, TOOL_BY_ACTION, argsSchema, toolSpecs } from './tools.js';
import { freeViewpoints } from './views.js';

const PORT = Number(process.env.PORT || 5173);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const ROOT = path.resolve(import.meta.dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const THREE_DIR = path.join(ROOT, 'node_modules', 'three');
const LEGACY_MODELS_DIR = path.join(ROOT, 'models'); // only for worlds saved before the library
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const AGENT_MODEL = process.env.WORLD_AGENT_MODEL || 'sonnet';
const AGENT_EFFORT = process.env.WORLD_AGENT_EFFORT || 'low';
const RIVER_PYTHON = process.env.RIVER_PYTHON || path.join(ROOT, '.venv', 'bin', 'python');
const RIVER_AGENT = path.join(ROOT, 'river', 'agent.py');
// WORLD_THINKING=off disables model reasoning for every backend (River renderer, Claude Code).
const THINKING = process.env.WORLD_THINKING !== 'off';
const WORK_DIR = path.join(os.tmpdir(), 'worldmodel-agent');
fs.mkdirSync(WORK_DIR, { recursive: true });

const MAX_TURNS = Number(process.env.WORLD_MAX_TURNS || 30);

const sessions = new Map(); // id -> { id, prompt, world, status, log, clients, proc }

function broadcast(session, event) {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of session.clients) res.write(line);
}

function log(session, entry) {
  entry.t = Date.now() - session.startedAt;
  session.log.push(entry);
  broadcast(session, { type: 'log', entry });
}

function setStatus(session, status, extra = {}) {
  session.status = status;
  broadcast(session, { type: 'status', status, ...extra });
}

// model: a Claude Code model alias/id (e.g. "sonnet", "opus", "claude-opus-5-5")
// or "river:<base model>" (e.g. "river:Qwen/Qwen3.8-27B-FP8"), optionally with "@river://<checkpoint>"
// to sample from a trained LoRA checkpoint of that base model.
function agentCommand(model, catalog, id, prompt, envOptions) {
  if (model.startsWith('river:')) {
    const job = {
      model: model.slice('river:'.length),
      system: systemPrompt(catalog, envOptions),
      user: `Build this world: ${prompt}`,
      tools: toolSpecs(),
      internal_url: `${BASE_URL}/internal/${id}`,
      max_turns: MAX_TURNS,
      thinking: THINKING,
    };
    return { bin: RIVER_PYTHON, args: [RIVER_AGENT], stdin: JSON.stringify(job) };
  }
  const mcpConfig = {
    mcpServers: {
      world: {
        command: process.execPath,
        args: [path.join(import.meta.dirname, 'mcp.js')],
        env: { WORLD_URL: BASE_URL, WORLD_SESSION: id },
      },
    },
  };
  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', model,
    '--effort', AGENT_EFFORT,
    '--system-prompt', systemPrompt(catalog, envOptions),
    '--mcp-config', JSON.stringify(mcpConfig),
    '--strict-mcp-config',
    '--setting-sources', '',
    '--tools', '',
    '--allowedTools', TOOLS.map((t) => `mcp__world__${t.name}`).join(','),
    '--no-session-persistence',
    '--max-turns', String(MAX_TURNS), // multi-shot: place, capture, fix, finish
  ];
  return { bin: CLAUDE_BIN, args, stdin: `Build this world: ${prompt}` };
}

async function startSession(prompt, model = AGENT_MODEL) {
  const startedAt = Date.now();
  // Only models, ground textures and skies close to the prompt are offered.
  const [picked, envOptions] = await Promise.all([selectModels(prompt), selectEnvironment(prompt)]);
  const catalog = picked.catalog;
  const id = randomUUID();
  const world = new World(catalog, envOptions);
  const session = { id, prompt, world, status: 'starting', log: [], clients: new Set(), proc: null, startedAt, agentModel: model, requestedModel: model, selection: picked.selection, captures: 0, toolCalls: 0 };
  session.builder = new WorldBuilder(world);
  world.listeners.add((e) => broadcast(session, e));
  sessions.set(id, session);

  const cmd = agentCommand(model, catalog, id, prompt, envOptions);
  // Exact agent input, kept with the saved world (used to build fine-tuning data).
  session.agentInput = { system: systemPrompt(catalog, envOptions), user: `Build this world: ${prompt}` };
  const env = THINKING ? process.env : { ...process.env, MAX_THINKING_TOKENS: '0' };
  const proc = spawn(cmd.bin, cmd.args, { cwd: WORK_DIR, env, stdio: ['pipe', 'pipe', 'pipe'] });
  session.proc = proc;
  proc.stdin.end(cmd.stdin);
  setStatus(session, 'generating');
  console.log(`[${id.slice(0, 8)}] generating with ${model}: ${prompt}`);

  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleAgentLine(session, line);
    }
  });
  let stderr = '';
  proc.stderr.on('data', (c) => (stderr += c));
  proc.on('error', (e) => {
    log(session, { kind: 'error', text: `Could not start the agent (${cmd.bin}): ${e.message}` });
    setStatus(session, 'error');
  });
  proc.on('close', (code) => {
    session.proc = null;
    if (session.status === 'generating') {
      if (code === 0 || session.built) setStatus(session, 'done');
      else {
        log(session, { kind: 'error', text: stderr.trim().slice(-500) || `Claude Code exited with code ${code}` });
        setStatus(session, 'error');
      }
    }
    session.durationMs = Date.now() - session.startedAt;
    console.log(`[${id.slice(0, 8)}] ${session.status} in ${(session.durationMs / 1000).toFixed(0)}s, ${world.objects.size} objects`);
    persist(session).catch((e) => console.error(`[${id.slice(0, 8)}] save failed:`, e));
  });
  return session;
}

async function persist(session) {
  if (!session.world.objects.size) return;
  // Agents can't always see that the spawn is blocked; move it to the nearest clear spot.
  const moved = session.world.fixSpawn();
  if (moved) session.builder.problems.push(moved);
  const snapshot = session.world.snapshot();
  const [thumb] = await capture(BASE_URL, snapshot, ['player']);
  const record = {
    id: session.id,
    prompt: session.prompt,
    model: session.agentModel,
    requestedModel: session.requestedModel,
    status: session.status,
    createdAt: session.startedAt,
    durationMs: session.durationMs,
    objectCount: snapshot.objects.length,
    cost: session.result?.cost ?? null,
    problems: session.builder.problems,
    turns: session.result?.turns ?? null,
    toolCalls: session.toolCalls,
    captures: session.captures,
    finished: !!session.finished,
    apiMs: session.result?.apiMs ?? null,
    selection: session.selection,
    agentInput: session.agentInput,
    outputTokens: session.result?.outputTokens ?? null,
    world: snapshot,
  };
  saveWorld(record, Buffer.from(thumb.data, 'base64'));
  broadcast(session, { type: 'saved' });
}

function handleAgentLine(session, line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.type === 'system' && msg.subtype === 'init') {
    const s = msg.mcp_servers?.find((m) => m.name === 'world');
    if (msg.model) session.agentModel = msg.model;
    if (s && s.status !== 'connected') log(session, { kind: 'error', text: `world tools not connected: ${s.status}` });
    else log(session, { kind: 'text', text: 'Planning the layout…' });
  } else if (msg.type === 'assistant') {
    for (const block of msg.message?.content || []) {
      if (block.type === 'text' && block.text.trim()) log(session, { kind: 'text', text: block.text.trim() });
      else if (block.type === 'tool_use') log(session, { kind: 'tool', name: block.name.replace(/^mcp__world__/, ''), input: {} });
    }
  } else if (msg.type === 'user') {
    for (const block of msg.message?.content || []) {
      if (block.type !== 'tool_result' || !block.is_error) continue;
      const t = Array.isArray(block.content) ? block.content.map((c) => c.text || '').join(' ') : String(block.content);
      log(session, { kind: 'tool_error', text: t.slice(0, 400) });
    }
  } else if (msg.type === 'result') {
    session.result = { cost: msg.total_cost_usd, turns: msg.num_turns, duration: msg.duration_ms, apiMs: msg.duration_api_ms, outputTokens: msg.usage?.output_tokens, isError: msg.is_error };
    if (msg.is_error && !session.built) {
      log(session, { kind: 'error', text: msg.result || 'Agent failed' });
      setStatus(session, 'error');
    } else setStatus(session, 'done', { result: session.result });
  }
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.bin': 'application/octet-stream',
};

function sendFile(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
}

function serveFrom(res, dir, rel) {
  const file = path.join(dir, decodeURIComponent(rel));
  if (!file.startsWith(dir + path.sep)) return json(res, 403, { error: 'forbidden' });
  sendFile(res, file);
}

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const c of req) data += c;
  return data ? JSON.parse(data) : {};
}

const CAPTURE_VIEWS = ['top', 'overview', 'eye', 'eye'];

async function handleInternal(session, action, body) {
  const tool = TOOL_BY_ACTION[action];
  if (!tool) throw new Error(`unknown action ${action}`);
  // The MCP server validates Claude's arguments; validate here too so every backend gets the same checks.
  const parsed = argsSchema(tool).safeParse(body);
  if (!parsed.success) throw new Error(`Invalid ${tool.name} arguments: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  const args = parsed.data;
  session.toolCalls++;
  const { world, builder } = session;

  if (action === 'place') {
    const r = builder.place(args);
    if (r.placed.length) session.built = true;
    for (const p of r.problems) log(session, { kind: 'tool_error', text: p });
    const text =
      `Placed ${r.placed.length} object(s): ${r.placed.map((p) => `#${p.id} ${p.model}`).join(', ') || 'none'}. ` +
      `World now has ${r.total} objects.` + (r.problems.length ? `\nProblems: ${r.problems.join('; ')}` : '');
    return { ...r, text };
  }
  if (action === 'move') {
    const r = builder.move(args);
    return { ...r, text: `Moved #${r.moved}.` + (r.overlaps.length ? ` Overlaps: ${r.overlaps.join('; ')}` : '') };
  }
  if (action === 'remove') {
    const r = builder.remove(args);
    return { ...r, text: `Removed ${r.removed.length} object(s).${r.missing.length ? ` Not found: ${r.missing.join(', ')}.` : ''} World now has ${r.total} objects.` };
  }
  if (action === 'capture') {
    session.captures++;
    const wanted = args.views?.length ? args.views : CAPTURE_VIEWS;
    const eyes = freeViewpoints(world, wanted.filter((v) => v === 'eye').length);
    const views = wanted.filter((v) => v !== 'eye').concat(eyes);
    const shots = await capture(BASE_URL, world.snapshot(), views);
    const label = (v) => (typeof v === 'string' ? v : `eye-level view from (x ${v.x}, z ${v.z})`);
    return {
      text: `Images in order: ${shots.map((s) => label(s.view)).join('; ')}.\n${world.describe()}`,
      images: shots.map((s) => ({ label: label(s.view), data: s.data })),
    };
  }
  if (action === 'finish') {
    session.finished = true;
    return { text: 'Finished. Reply with one short sentence describing the world.' };
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, BASE_URL);
  const p = url.pathname;
  try {
    if (req.method === 'POST' && p === '/api/generate') {
      const { prompt, replaces, model } = await readBody(req);
      if (!prompt?.trim()) return json(res, 400, { error: 'prompt required' });
      if (model != null && (typeof model !== 'string' || !/^(river:[\w./:-]+(@river:\/\/[\w./-]+)?|[\w./:-]+)$/.test(model))) return json(res, 400, { error: 'invalid model' });
      sessions.get(replaces)?.proc?.kill('SIGTERM'); // the tab moved on to a new world
      const session = await startSession(prompt.trim().slice(0, 2000), model || AGENT_MODEL);
      return json(res, 200, { id: session.id });
    }
    let m;
    if ((m = p.match(/^\/api\/events\/([\w-]+)$/))) {
      const session = sessions.get(m[1]);
      const stored = !session && loadWorld(m[1]);
      if (!session && !stored) return json(res, 404, { error: 'no such world' });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      if (stored) {
        res.end(`data: ${JSON.stringify({ type: 'snapshot', world: stored.world, status: 'done', log: [], prompt: stored.prompt })}\n\n`);
        return;
      }
      res.write(`data: ${JSON.stringify({ type: 'snapshot', world: session.world.snapshot(), status: session.status, log: session.log, prompt: session.prompt })}\n\n`);
      session.clients.add(res);
      req.on('close', () => session.clients.delete(res));
      return;
    }
    if ((m = p.match(/^\/api\/world\/([\w-]+)$/))) {
      const session = sessions.get(m[1]);
      if (!session) return json(res, 404, { error: 'no such session' });
      return json(res, 200, { ...session.world.snapshot(), status: session.status, prompt: session.prompt, log: session.log, result: session.result });
    }
    if (req.method === 'POST' && (m = p.match(/^\/api\/stop\/([\w-]+)$/))) {
      sessions.get(m[1])?.proc?.kill('SIGTERM');
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && (m = p.match(/^\/internal\/([\w-]+)\/(\w+)$/))) {
      const session = sessions.get(m[1]);
      if (!session) return json(res, 404, { error: 'no such session' });
      try {
        return json(res, 200, await handleInternal(session, m[2], await readBody(req)));
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    if (p === '/api/worlds') return json(res, 200, listWorlds());
    if ((m = p.match(/^\/api\/worlds\/([\w-]+)\.jpg$/))) return sendFile(res, thumbPath(m[1]) || '');
    if (p.startsWith('/vendor/three/')) return serveFrom(res, THREE_DIR, p.slice('/vendor/three/'.length));
    if (p.startsWith('/library/')) return serveFrom(res, loadLibrary().root, p.slice('/library/'.length));
    if (p.startsWith('/textures/')) return serveFrom(res, TEXTURES_DIR, p.slice('/textures/'.length));
    if (p.startsWith('/models/')) return serveFrom(res, LEGACY_MODELS_DIR, p.slice('/models/'.length));
    if (p === '/benchmark') return sendFile(res, path.join(PUBLIC_DIR, 'benchmark.html'));
    if (p === '/api/benchmark') {
      // Judged comparison written by bench/analyze.mjs, joined with the saved worlds.
      const scored = JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'results', 'lowpoly.scored.json'), 'utf8'));
      return json(res, 200, scored.map((r) => {
        const w = loadWorld(r.id) || {};
        return { ...r, durationMs: w.durationMs, objectCount: w.objectCount, turns: w.turns, requestedModel: w.requestedModel };
      }));
    }
    if (p === '/') return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    return serveFrom(res, PUBLIC_DIR, p.slice(1));
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

// Keep SSE connections alive through proxies/idle timeouts.
setInterval(() => {
  for (const s of sessions.values()) for (const res of s.clients) res.write(': ping\n\n');
}, 15000);

const lib = loadLibrary();
if (!lib) throw new Error('No model library index. Run: node --env-file=.env scripts/build-library.mjs');
server.listen(PORT, '127.0.0.1', () => {
  console.log(`World generator running at ${BASE_URL}  (agent model: ${AGENT_MODEL}, library: ${lib.models.length} models from ${lib.root})`);
});
