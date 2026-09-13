import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createIntegratedBrowserProvider } from './integrated-browser-provider.mjs';
import { createManagedBrowserProvider } from './managed-browser-provider.mjs';
import { createPersonalEdgeProvider, PersonalEdgeControlError, PersonalEdgePollAbortedError } from './personal-edge-provider.mjs';
import { GatewayProviderRegistry } from './provider-registry.mjs';
import { createUpstreamMcpProvider } from './upstream-mcp-provider.mjs';

const PORT = Number(process.env.PORT || 48321);
const UPSTREAM_URL = process.env.SHUNCODE_MCP_URL || '';
const INTEGRATED_BROWSER_BRIDGE = process.env.SHUNCODE_INTEGRATED_BROWSER_BRIDGE || 'http://127.0.0.1:48322';
const EDGE_PATH = process.env.EDGE_PATH || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PROFILE_DIR = path.resolve(process.env.BROWSER_PROFILE || './browser-profile');
const SCREENSHOT_DIR = path.resolve('./screenshots');
const CHAT_AGENT_PATH = path.resolve('./generic-chat-agent.js');
const SHARED_PAGE_CORE_PATH = process.env.SHUNCODE_WEBMCP_PAGE_CORE_PATH || '';
const SHARED_SITE_ADAPTERS_PATH = process.env.SHUNCODE_WEBMCP_SITE_ADAPTERS_PATH || '';
const SHARED_PAGE_AGENT_PATH = process.env.SHUNCODE_WEBMCP_PAGE_AGENT_PATH || '';
const PERSONAL_EDGE_BRIDGE_TOKEN = process.env.SHUNCODE_PERSONAL_EDGE_TOKEN || 'shuncode-local-development';
const integratedBrowserProvider = createIntegratedBrowserProvider({ bridgeUrl: INTEGRATED_BROWSER_BRIDGE });
const upstreamMcpProvider = createUpstreamMcpProvider({ url: UPSTREAM_URL });
const managedBrowserProvider = createManagedBrowserProvider({ edgePath: EDGE_PATH, profileDir: PROFILE_DIR, screenshotDir: SCREENSHOT_DIR });
const personalEdgeProvider = createPersonalEdgeProvider({ token: PERSONAL_EDGE_BRIDGE_TOKEN });
const pageAgentSessions = new WeakMap();
let chatAgentFactorySource;

// WebMCP is intended to let chat pages work on the ShunCode workspace, not to
// repeatedly drive ShunCode's protected browser-opening UI.  The native
// open_browser_page tool intentionally prompts the user for every new page
// (especially file:// previews), which caused models to spam confirmation
// dialogs while "verifying" files they had just created.
const webMcpHiddenIntegratedTools = new Set(['open_browser_page']);

async function listAllTools() {
  return await gatewayProviders().listTools();
}

async function listShunCodeTools() {
  return await gatewayProviders().listTools({
    filter: (tool, provider) => provider.id !== 'integrated-browser' || !webMcpHiddenIntegratedTools.has(tool.name),
  });
}

async function callAnyTool(name, args = {}) {
  return await gatewayProviders().callTool(name, args);
}

async function callShunCodeTool(name, args = {}) {
  if (webMcpHiddenIntegratedTools.has(name)) {
    throw new Error(`WebMCP tool '${name}' is intentionally disabled to avoid repeated ShunCode browser confirmation dialogs. Do not retry it. Ask the user to open/preview the local file manually if visual verification is actually needed.`);
  }
  return await gatewayProviders().callTool(name, args);
}

let providerRegistry;

function gatewayProviders() {
  if (providerRegistry) return providerRegistry;
  providerRegistry = new GatewayProviderRegistry([
    upstreamMcpProvider,
    integratedBrowserProvider,
    managedBrowserProvider,
    personalEdgeProvider,
  ]);
  return providerRegistry;
}

async function getChatAgentFactorySource() {
  if (!chatAgentFactorySource) {
    if (SHARED_PAGE_CORE_PATH && SHARED_SITE_ADAPTERS_PATH && SHARED_PAGE_AGENT_PATH) {
      const [coreSource, siteAdaptersSource, agentSource] = await Promise.all([
        fs.readFile(SHARED_PAGE_CORE_PATH, 'utf8'),
        fs.readFile(SHARED_SITE_ADAPTERS_PATH, 'utf8'),
        fs.readFile(SHARED_PAGE_AGENT_PATH, 'utf8'),
      ]);
      chatAgentFactorySource = `(function shunCodeWebMcpComposedAgent(config) {\n`
        + `  const createCore = (${coreSource.trim()});\n`
        + `  const createSiteAdapter = (${siteAdaptersSource.trim()});\n`
        + `  const agent = (${agentSource.trim()});\n`
        + `  return agent(config, { createCore, createSiteAdapter });\n`
        + `})`;
    } else {
      chatAgentFactorySource = await fs.readFile(CHAT_AGENT_PATH, 'utf8');
    }
  }
  return chatAgentFactorySource;
}

function serializeForPage(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (item instanceof Uint8Array) return `[Uint8Array ${item.byteLength} bytes]`;
    return item;
  }));
}

async function ensureChatAgent(page) {
  let session = pageAgentSessions.get(page);
  if (session) return session;

  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const token = randomUUID();
  const listBinding = `__shuncodeListTools_${suffix}`;
  const invokeBinding = `__shuncodeInvokeTool_${suffix}`;

  await page.exposeBinding(listBinding, async (_source, providedToken) => {
    if (providedToken !== token) throw new Error('Invalid ShunCode page bridge token');
    const tools = await listAllTools();
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description || tool.modelDescription || tool.name,
      inputSchema: tool.inputSchema || { type: 'object' },
    }));
  });
  await page.exposeBinding(invokeBinding, async (_source, providedToken, name, args) => {
    if (providedToken !== token) throw new Error('Invalid ShunCode page bridge token');
    const result = await callAnyTool(String(name || ''), args && typeof args === 'object' ? args : {});
    return serializeForPage(result);
  });

  const factorySource = await getChatAgentFactorySource();
  const expression = `(${factorySource})(${JSON.stringify({ token, listBinding, invokeBinding })});`;
  await page.addInitScript({ content: expression });
  if (/^https?:/i.test(page.url())) {
    try { await page.evaluate(expression); } catch {}
  }
  session = { token, listBinding, invokeBinding, expression };
  pageAgentSessions.set(page, session);
  return session;
}

async function connectCurrentChatPage({ prime = true } = {}) {
  const page = await managedBrowserProvider.currentPage();
  const pages = await managedBrowserProvider.pages();
  await ensureChatAgent(page);

  let status = null;
  if (/^https?:/i.test(page.url())) {
    try { status = await page.evaluate(() => window.__shuncodeWebMcp?.status?.() || null); } catch {}
  }

  let primeResult = null;
  if (prime && status?.composerFound && !status?.primed) {
    try { primeResult = await page.evaluate(() => window.__shuncodeWebMcp?.prime?.()); }
    catch (error) { primeResult = { ok: false, reason: error instanceof Error ? error.message : String(error) }; }
    try { status = await page.evaluate(() => window.__shuncodeWebMcp?.status?.() || null); } catch {}
  }

  const info = await managedBrowserProvider.pageInfo(page, pages.indexOf(page));
  return { ok: true, page: info, chatDetected: !!status?.composerFound, status, primeResult };
}

function createServer() {
  const server = new Server(
    { name: 'shuncode-browser-gateway', version: '0.1.0' },
    { capabilities: { tools: {}, logging: {} }, instructions: 'ShunCode tools plus persistent browser DOM/click/fill automation.' },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: await listAllTools() };
  });
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args = {} } = request.params;
    return await callAnyTool(name, args);
  });
  return server;
}

const app = express();
app.use(express.json({ limit: '8mb' }));
const sessions = new Map();

app.get('/control/healthz', (_req, res) => {
  res.json({ ok: true, integratedWebMcp: true, controlVersion: 2, browserRunning: managedBrowserProvider.isRunning(), profile: managedBrowserProvider.profileDir, personalEdge: personalEdgeProvider.status() });
});

app.post('/control/personal-edge/register', (req, res) => {
  try {
    res.json({ ok: true, personalEdge: personalEdgeProvider.register(req.body || {}) });
  } catch (error) {
    if (error instanceof PersonalEdgeControlError) return res.status(error.statusCode).json({ ok: false, error: error.message });
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/control/personal-edge/poll', async (req, res) => {
  const controller = new AbortController();
  res.on('close', () => controller.abort());
  try {
    const command = await personalEdgeProvider.poll({ token: req.query?.token, clientId: req.query?.clientId, signal: controller.signal });
    if (!res.headersSent && !res.destroyed) res.json({ ok: true, command });
  } catch (error) {
    if (error instanceof PersonalEdgePollAbortedError) return;
    if (error instanceof PersonalEdgeControlError) return res.status(error.statusCode).json({ ok: false, error: error.message });
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/control/personal-edge/result', (req, res) => {
  try {
    personalEdgeProvider.submitResult(req.body || {});
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof PersonalEdgeControlError) return res.status(error.statusCode).json({ ok: false, error: error.message });
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/control/status', async (_req, res) => {
  try {
    res.json({ ok: true, ...await managedBrowserProvider.status() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/control/shuncode-tools', async (req, res) => {
  try {
    if (String(req.query?.protocol || '') !== '2') {
      return res.status(409).json({ ok: false, error: 'Legacy Web MCP client blocked for stability; protocol=2 is required' });
    }
    const tools = await listShunCodeTools();
    res.json({ ok: true, tools });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/control/invoke-shuncode', async (req, res) => {
  try {
    if (String(req.query?.protocol || '') !== '2') {
      return res.status(409).json({ ok: false, error: 'Legacy Web MCP client blocked for stability; protocol=2 is required' });
    }
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ ok: false, error: 'tool name is required' });
    const args = req.body?.arguments && typeof req.body.arguments === 'object' ? req.body.arguments : {};
    const result = await callShunCodeTool(name, args);
    res.json({ ok: true, result: serializeForPage(result) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/control/start-browser', async (_req, res) => {
  try {
    res.json({ ok: true, ...await managedBrowserProvider.start() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/control/open', async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
    res.json({ ok: true, page: await managedBrowserProvider.open(url) });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/control/connect-current', async (req, res) => {
  try {
    res.json(await connectCurrentChatPage({ prime: req.body?.prime !== false }));
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/control/stop-browser', async (_req, res) => {
  try {
    res.json({ ok: true, ...await managedBrowserProvider.stop() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/healthz', async (_req, res) => {
  try {
    const tools = await upstreamMcpProvider.probeTools();
    const integratedTools = await integratedBrowserProvider.refreshTools();
    const browserTools = await managedBrowserProvider.listTools();
    res.json({ ok: true, upstream: UPSTREAM_URL, upstream_tools: tools.length, integrated_browser_tools: integratedTools.length, browser_tools: browserTools.length });
  } catch (error) {
    res.status(503).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/mcp', async (req, res) => {
  try {
    const sid = req.headers['mcp-session-id'];
    let transport = typeof sid === 'string' ? sessions.get(sid) : undefined;
    if (!transport && !sid && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: id => sessions.set(id, transport),
      });
      transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
      await createServer().connect(transport);
    } else if (!transport) {
      return res.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or missing MCP session ID' }, id: null });
    }
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

for (const method of ['get', 'delete']) {
  app[method]('/mcp', async (req, res) => {
    const sid = req.headers['mcp-session-id'];
    const transport = typeof sid === 'string' ? sessions.get(sid) : undefined;
    if (!transport) return res.status(400).send('Invalid or missing MCP session ID');
    await transport.handleRequest(req, res);
  });
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`ShunCode Browser MCP Gateway: http://127.0.0.1:${PORT}/mcp`);
  console.log(`Upstream: ${UPSTREAM_URL || '(set SHUNCODE_MCP_URL)'}`);
});
