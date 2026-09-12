import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const HOST = '127.0.0.1';
const PORT = 48324;
const MCP_URL = 'http://127.0.0.1:48321/mcp';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_SCRIPT = path.join(HERE, 'arena-agent-bridge.js');

const cors = {
  'Access-Control-Allow-Origin': 'https://arena.ai',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '600',
  'Vary': 'Origin',
};

let client;
let connecting;

async function getClient() {
  if (client) return client;
  if (!connecting) {
    connecting = (async () => {
      const c = new Client({ name: 'arena-shuncode-rest-bridge', version: '0.1.0' }, { capabilities: {} });
      await c.connect(new StreamableHTTPClientTransport(new URL(MCP_URL)));
      client = c;
      return c;
    })().finally(() => { connecting = undefined; });
  }
  return connecting;
}

function json(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors);
    return res.end();
  }
  try {
    if (req.method === 'GET' && req.url === '/agent.js') {
      const text = await fs.readFile(AGENT_SCRIPT, 'utf8');
      res.writeHead(200, {
        ...cors,
        'Content-Type': 'application/javascript; charset=utf-8',
        'Content-Length': Buffer.byteLength(text),
        'Cache-Control': 'no-store',
      });
      return res.end(text);
    }
    if (req.method === 'GET' && req.url === '/healthz') {
      const tools = await (await getClient()).listTools();
      return json(res, 200, { ok: true, toolCount: tools.tools.length });
    }
    if (req.method === 'GET' && req.url === '/tools') {
      const tools = await (await getClient()).listTools();
      return json(res, 200, { ok: true, tools: tools.tools });
    }
    if (req.method === 'POST' && req.url === '/invoke') {
      const body = await readJson(req);
      const result = await (await getClient()).callTool({ name: String(body.name || ''), arguments: body.arguments || {} });
      return json(res, 200, { ok: true, result });
    }
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    client = undefined;
    return json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}).listen(PORT, HOST, () => console.log(`Arena → ShunCode REST bridge: http://${HOST}:${PORT}`));
