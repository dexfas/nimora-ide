import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gatewayDir = path.join(root, 'tools', 'webmcp-gateway');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function listen(app, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function closeServer(server) {
  if (!server) return;
  await new Promise(resolve => server.close(resolve));
}

const upstreamPort = await freePort();
const integratedPort = await freePort();
const gatewayPort = await freePort();
const upstreamCalls = [];
const integratedCalls = [];

const upstreamSessions = new Map();
const upstreamApp = express();
upstreamApp.use(express.json({ limit: '1mb' }));
function createUpstreamServer() {
  const server = new Server({ name: 'gateway-federation-upstream', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'upstream_only', description: 'upstream only', inputSchema: { type: 'object' } },
      { name: 'shared_name', description: 'upstream duplicate', inputSchema: { type: 'object' } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    upstreamCalls.push({ name: request.params.name, arguments: request.params.arguments ?? {} });
    return { content: [{ type: 'text', text: `UPSTREAM:${request.params.name}` }] };
  });
  return server;
}
upstreamApp.post('/mcp', async (req, res) => {
  try {
    const sid = req.headers['mcp-session-id'];
    let transport = typeof sid === 'string' ? upstreamSessions.get(sid) : undefined;
    if (!transport && !sid && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => `upstream-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        onsessioninitialized: id => upstreamSessions.set(id, transport),
      });
      transport.onclose = () => { if (transport.sessionId) upstreamSessions.delete(transport.sessionId); };
      await createUpstreamServer().connect(transport);
    } else if (!transport) {
      res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'invalid session' }, id: null });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
for (const method of ['get', 'delete']) {
  upstreamApp[method]('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'];
    const transport = typeof sid === 'string' ? upstreamSessions.get(sid) : undefined;
    if (!transport) return res.status(400).send('invalid session');
    await transport.handleRequest(req, res);
  });
}

const integratedApp = express();
integratedApp.use(express.json({ limit: '1mb' }));
integratedApp.get('/tools', (_req, res) => {
  res.json({
    tools: [
      { name: 'integrated_only', description: 'integrated only', inputSchema: { type: 'object' } },
      { name: 'shared_name', description: 'integrated duplicate', inputSchema: { type: 'object' } },
    ],
  });
});
integratedApp.post('/invoke', (req, res) => {
  integratedCalls.push({ name: req.body?.name, input: req.body?.input ?? {} });
  res.json({ ok: true, result: { content: [{ type: 'text', text: `INTEGRATED:${req.body?.name}` }] } });
});

const upstreamHttp = await listen(upstreamApp, upstreamPort);
const integratedHttp = await listen(integratedApp, integratedPort);
let stdout = '';
let stderr = '';
const gateway = spawn(process.execPath, ['server.mjs'], {
  cwd: gatewayDir,
  env: {
    ...process.env,
    PORT: String(gatewayPort),
    SHUNCODE_MCP_URL: `http://127.0.0.1:${upstreamPort}/mcp`,
    SHUNCODE_INTEGRATED_BROWSER_BRIDGE: `http://127.0.0.1:${integratedPort}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
gateway.stdout.on('data', chunk => { stdout += String(chunk); });
gateway.stderr.on('data', chunk => { stderr += String(chunk); });

async function waitForGateway() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (gateway.exitCode != null) throw new Error(`Gateway exited early (${gateway.exitCode})\n${stderr || stdout}`);
    try {
      const response = await fetch(`http://127.0.0.1:${gatewayPort}/control/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for gateway\n${stderr || stdout}`);
}

const client = new Client({ name: 'gateway-federation-smoke', version: '1.0.0' });
try {
  await waitForGateway();
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${gatewayPort}/mcp`));
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name);
  assert.ok(names.includes('upstream_only'));
  assert.ok(names.includes('integrated_only'));
  assert.equal(names.filter(name => name === 'shared_name').length, 2, 'tool presentation must retain both provider definitions during compatibility phase');
  assert.ok(names.indexOf('upstream_only') < names.indexOf('integrated_only'), 'upstream tools must remain first in presentation order');

  const local = await client.callTool({ name: 'shared_name', arguments: { value: 1 } });
  assert.equal(local.isError, undefined);
  assert.match(local.content.map(part => part.type === 'text' ? part.text : '').join('\n'), /INTEGRATED:shared_name/);
  assert.deepEqual(integratedCalls, [{ name: 'shared_name', input: { value: 1 } }]);
  assert.deepEqual(upstreamCalls, [], 'local explicit owner must prevent duplicate upstream execution');

  const upstream = await client.callTool({ name: 'upstream_only', arguments: { value: 2 } });
  assert.match(upstream.content.map(part => part.type === 'text' ? part.text : '').join('\n'), /UPSTREAM:upstream_only/);
  assert.deepEqual(upstreamCalls, [{ name: 'upstream_only', arguments: { value: 2 } }]);

  const integrated = await client.callTool({ name: 'integrated_only', arguments: { value: 3 } });
  assert.match(integrated.content.map(part => part.type === 'text' ? part.text : '').join('\n'), /INTEGRATED:integrated_only/);
  assert.equal(upstreamCalls.length, 1);

  console.log('[smoke] Gateway MCP federation local-owner precedence + upstream fallback ok');
} finally {
  try { await client.close(); } catch {}
  if (gateway.exitCode == null) {
    gateway.kill();
    await Promise.race([
      new Promise(resolve => gateway.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
  }
  await Promise.all([closeServer(upstreamHttp), closeServer(integratedHttp)]);
}
