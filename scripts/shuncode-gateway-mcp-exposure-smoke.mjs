import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGatewayMcpExposureAdapter } from '../tools/webmcp-gateway/mcp-exposure-adapter.mjs';

async function freePort() {
  const probe = net.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise(resolve => probe.close(resolve));
  return port;
}

const calls = [];
let sessionSequence = 0;
const exposure = createGatewayMcpExposureAdapter({
  listTools: async () => [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object' } }],
  callTool: async (name, args) => {
    calls.push({ name, args });
    return { content: [{ type: 'text', text: `ECHO:${args.text ?? ''}` }] };
  },
  serverName: 'exposure-smoke',
  serverVersion: '1.0.0',
  instructions: 'Exposure smoke.',
  newSessionId: () => `session-${++sessionSequence}`,
});

const app = express();
app.use(express.json({ limit: '1mb' }));
app.post('/mcp', async (req, res) => {
  try { await exposure.handlePost(req, res, req.body); }
  catch (error) { if (!res.headersSent) res.status(500).json({ error: String(error) }); }
});
for (const method of ['get', 'delete']) {
  app[method]('/mcp', async (req, res) => exposure.handleSessionRequest(req, res));
}

const port = await freePort();
const server = http.createServer(app);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});
const endpoint = `http://127.0.0.1:${port}/mcp`;
const client = new Client({ name: 'gateway-exposure-smoke', version: '1.0.0' });

try {
  const badPost = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
  });
  assert.equal(badPost.status, 400);
  assert.match(JSON.stringify(await badPost.json()), /Invalid or missing MCP session ID/);

  const badGet = await fetch(endpoint);
  assert.equal(badGet.status, 400);
  assert.equal(await badGet.text(), 'Invalid or missing MCP session ID');

  const transport = new StreamableHTTPClientTransport(new URL(endpoint));
  await client.connect(transport);
  assert.equal(exposure.sessionCount(), 1);

  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name), ['echo']);
  const result = await client.callTool({ name: 'echo', arguments: { text: 'nimora' } });
  assert.match(result.content.map(part => part.type === 'text' ? part.text : '').join('\n'), /ECHO:nimora/);
  assert.deepEqual(calls, [{ name: 'echo', args: { text: 'nimora' } }]);

  console.log('[smoke] Gateway MCP exposure initialize/session/list/call/invalid-session contract ok');
} finally {
  try { await client.close(); } catch {}
  await new Promise(resolve => server.close(resolve));
}
