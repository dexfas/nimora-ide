import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gatewayDir = path.join(root, 'tools', 'webmcp-gateway');
const webMcpDir = path.join(root, 'extensions', 'shuncode-webmcp');

const edgeCandidates = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

let edgePath = '';
for (const candidate of edgeCandidates) {
  try {
    await access(candidate);
    edgePath = candidate;
    break;
  } catch {}
}
assert.ok(edgePath, 'Microsoft Edge executable is required for the gateway shared-agent smoke');

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

const gatewayPort = await freePort();
const pagePort = await freePort();
const profileDir = await mkdtemp(path.join(os.tmpdir(), 'nimora-webmcp-gateway-profile-'));
const pageHtml = `<!doctype html><html><body><main></main><form><textarea aria-label="Ask"></textarea><button type="submit">Send</button></form></body></html>`;
const pageServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(pageHtml);
});
await new Promise((resolve, reject) => {
  pageServer.once('error', reject);
  pageServer.listen(pagePort, '127.0.0.1', resolve);
});

let stdout = '';
let stderr = '';
const gateway = spawn(process.execPath, ['server.mjs'], {
  cwd: gatewayDir,
  env: {
    ...process.env,
    PORT: String(gatewayPort),
    EDGE_PATH: edgePath,
    BROWSER_PROFILE: profileDir,
    SHUNCODE_WEBMCP_PAGE_CORE_PATH: path.join(webMcpDir, 'webmcp-page-core.js'),
    SHUNCODE_WEBMCP_SITE_ADAPTERS_PATH: path.join(webMcpDir, 'webmcp-site-adapters.js'),
    SHUNCODE_WEBMCP_PAGE_AGENT_PATH: path.join(webMcpDir, 'arena-agent-bridge.js'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});
gateway.stdout.on('data', chunk => { stdout += String(chunk); });
gateway.stderr.on('data', chunk => { stderr += String(chunk); });

const base = `http://127.0.0.1:${gatewayPort}`;

async function waitForGateway() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (gateway.exitCode != null) throw new Error(`Gateway exited early (${gateway.exitCode})\n${stderr || stdout}`);
    try {
      const response = await fetch(`${base}/control/healthz`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for gateway\n${stderr || stdout}`);
}

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok || body?.ok === false) throw new Error(body?.error || `HTTP ${response.status}`);
  return body;
}

try {
  await waitForGateway();
  await jsonRequest(`${base}/control/start-browser`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await jsonRequest(`${base}/control/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${pagePort}/chat` }),
  });
  const connected = await jsonRequest(`${base}/control/connect-current`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prime: false }),
  });
  assert.equal(connected.chatDetected, true);
  assert.equal(connected.status.version, 25);
  assert.equal(connected.status.coreVersion, 1);
  assert.equal(connected.status.siteAdapter, 'generic');
  assert.equal(connected.status.transport, 'binding');
  assert.equal(connected.status.composerFound, true);
  await jsonRequest(`${base}/control/stop-browser`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  console.log('[smoke] Gateway loads canonical WebMCP v25 Core/Site/Agent over binding transport ok');
} finally {
  await new Promise(resolve => pageServer.close(resolve));
  if (gateway.exitCode == null) {
    gateway.kill();
    await Promise.race([
      new Promise(resolve => gateway.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 3000)),
    ]);
  }
  await rm(profileDir, { recursive: true, force: true });
}
