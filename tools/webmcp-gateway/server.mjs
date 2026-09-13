import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { defineGatewayCapability } from './capability-contract.mjs';
import { createIntegratedBrowserProvider } from './integrated-browser-provider.mjs';
import { createManagedBrowserProvider } from './managed-browser-provider.mjs';
import { defineGatewayProvider, GatewayProviderRegistry } from './provider-registry.mjs';
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
const pageAgentSessions = new WeakMap();
let chatAgentFactorySource;
let personalEdgeClient = { clientId: '', shared: false, lastSeen: 0, tab: null };
const personalEdgeCommandQueue = [];
const personalEdgePendingResults = new Map();
const personalEdgePollWaiters = [];

const personalEdgeMetadata = (id, title, risk, idempotency, retry, approval, { destructive = false, tags = [] } = {}) => ({
  id,
  version: 1,
  title,
  category: 'browser',
  tags,
  environment: 'personal-browser',
  risk,
  idempotency,
  retry,
  approval,
  destructive,
  openWorld: true,
});

const personalEdgeTools = [
  defineGatewayCapability({
    name: 'personal_edge_status',
    description: 'PERSONAL EDGE BRIDGE: report whether the user explicitly shared a tab from their normal Microsoft Edge and return that tab metadata.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }, personalEdgeMetadata('browser.personal.status', 'Personal Edge Status', 'read', 'safe', 'automatic', 'none', { tags: ['browser', 'personal', 'read'] })),
  defineGatewayCapability({
    name: 'personal_edge_read',
    description: 'PERSONAL EDGE BRIDGE (READ ONLY): read title, URL and visible body text from the single normal http/https Edge tab the user explicitly shared. Does not click, type, navigate, or evaluate arbitrary JavaScript.',
    inputSchema: { type: 'object', properties: { max_chars: { type: 'integer', minimum: 1, maximum: 50000, default: 20000 } }, additionalProperties: false },
  }, personalEdgeMetadata('browser.personal.read', 'Read Personal Edge Page', 'read', 'safe', 'automatic', 'none', { tags: ['browser', 'personal', 'read'] })),
  defineGatewayCapability({
    name: 'personal_edge_elements',
    description: 'PERSONAL EDGE BRIDGE (READ ONLY): inspect visible interactive elements in the shared personal Edge tab. Returns generated CSS selectors plus safe metadata such as tag/text/role/placeholder; does not return current input values.',
    inputSchema: { type: 'object', properties: { max_elements: { type: 'integer', minimum: 1, maximum: 200, default: 100 } }, additionalProperties: false },
  }, personalEdgeMetadata('browser.personal.elements', 'Inspect Personal Edge Elements', 'read', 'safe', 'automatic', 'none', { tags: ['browser', 'personal', 'read', 'elements'] })),
  defineGatewayCapability({
    name: 'personal_edge_click',
    description: 'PERSONAL EDGE BRIDGE: click one element in the user-shared personal Edge tab by CSS selector. This can cause account/page side effects and is subject to WebMCP approval.',
    inputSchema: { type: 'object', required: ['selector'], properties: { selector: { type: 'string', minLength: 1 } }, additionalProperties: false },
  }, personalEdgeMetadata('browser.personal.click', 'Click Personal Edge Element', 'external-side-effect', 'non-idempotent', 'never', 'session', { destructive: true, tags: ['browser', 'personal', 'interaction'] })),
  defineGatewayCapability({
    name: 'personal_edge_fill',
    description: 'PERSONAL EDGE BRIDGE: replace text in an input, textarea, or contenteditable element in the user-shared personal Edge tab. Subject to WebMCP approval.',
    inputSchema: { type: 'object', required: ['selector', 'value'], properties: { selector: { type: 'string', minLength: 1 }, value: { type: 'string' } }, additionalProperties: false },
  }, personalEdgeMetadata('browser.personal.fill', 'Fill Personal Edge Field', 'external-side-effect', 'non-idempotent', 'never', 'session', { destructive: true, tags: ['browser', 'personal', 'interaction'] })),
  defineGatewayCapability({
    name: 'personal_edge_navigate',
    description: 'PERSONAL EDGE BRIDGE: navigate the user-shared personal Edge tab to an http/https URL. The same tab remains shared. Subject to WebMCP approval.',
    inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string', minLength: 1 } }, additionalProperties: false },
  }, personalEdgeMetadata('browser.personal.navigate', 'Navigate Personal Edge', 'external-side-effect', 'non-idempotent', 'never', 'session', { destructive: true, tags: ['browser', 'personal', 'navigate'] })),
  defineGatewayCapability({
    name: 'personal_edge_reload',
    description: 'PERSONAL EDGE BRIDGE: reload the user-shared personal Edge tab. Subject to WebMCP approval because it can discard transient page state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }, personalEdgeMetadata('browser.personal.reload', 'Reload Personal Edge', 'external-side-effect', 'non-idempotent', 'never', 'session', { destructive: true, tags: ['browser', 'personal', 'navigate'] })),
];

function personalEdgeStatusData() {
  const connected = !!personalEdgeClient.clientId && Date.now() - personalEdgeClient.lastSeen < 90000;
  return {
    connected,
    shared: connected && !!personalEdgeClient.shared,
    lastSeen: personalEdgeClient.lastSeen || null,
    tab: connected && personalEdgeClient.shared ? personalEdgeClient.tab || null : null,
  };
}

function personalEdgeSharedTab() {
  const status = personalEdgeStatusData();
  if (!status.connected) throw new Error('Personal Edge Bridge is not connected. Make sure the Edge extension is installed and active.');
  if (!status.shared || !status.tab) throw new Error('No Personal Edge tab is shared. Click the ShunCode Personal Edge Bridge extension on the target tab so its badge shows ON.');
  if (!/^https?:/i.test(String(status.tab.url || ''))) {
    throw new Error('The shared Personal Edge tab is a privileged/non-web page. Share a normal http/https page instead.');
  }
  return status.tab;
}

function takeQueuedPersonalEdgeCommand() {
  while (personalEdgeCommandQueue.length) {
    const command = personalEdgeCommandQueue.shift();
    if (personalEdgePendingResults.has(command.id)) return command;
  }
  return null;
}

function dispatchPersonalEdgeCommand(command) {
  while (personalEdgePollWaiters.length) {
    const finish = personalEdgePollWaiters.shift();
    if (finish(command)) return;
  }
  personalEdgeCommandQueue.push(command);
}

function requestPersonalEdgeCommand(command) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      personalEdgePendingResults.delete(command.id);
      const index = personalEdgeCommandQueue.findIndex(item => item.id === command.id);
      if (index >= 0) personalEdgeCommandQueue.splice(index, 1);
      reject(new Error('Personal Edge command timed out waiting for the shared tab extension'));
    }, 15000);
    personalEdgePendingResults.set(command.id, { resolve, reject, timer });
    dispatchPersonalEdgeCommand(command);
  });
}

async function callPersonalEdgeTool(name, args = {}) {
  if (name === 'personal_edge_status') {
    const data = personalEdgeStatusData();
    return textResult(JSON.stringify(data, null, 2), data);
  }
  if (name === 'personal_edge_read') {
    const tab = personalEdgeSharedTab();
    const maxChars = Math.max(1, Math.min(50000, Number(args.max_chars || 20000)));
    const data = await requestPersonalEdgeCommand({ id: randomUUID(), op: 'read', tabId: Number(tab.id), maxChars });
    return textResult(JSON.stringify(data, null, 2), data);
  }
  if (name === 'personal_edge_elements') {
    const tab = personalEdgeSharedTab();
    const maxElements = Math.max(1, Math.min(200, Number(args.max_elements || 100)));
    const data = await requestPersonalEdgeCommand({ id: randomUUID(), op: 'elements', tabId: Number(tab.id), maxElements });
    return textResult(JSON.stringify(data, null, 2), data);
  }
  if (name === 'personal_edge_click') {
    const tab = personalEdgeSharedTab();
    const selector = String(args.selector || '').trim();
    if (!selector) throw new Error('personal_edge_click requires selector');
    const data = await requestPersonalEdgeCommand({ id: randomUUID(), op: 'click', tabId: Number(tab.id), selector });
    return textResult(JSON.stringify(data, null, 2), data);
  }
  if (name === 'personal_edge_fill') {
    const tab = personalEdgeSharedTab();
    const selector = String(args.selector || '').trim();
    if (!selector) throw new Error('personal_edge_fill requires selector');
    const data = await requestPersonalEdgeCommand({ id: randomUUID(), op: 'fill', tabId: Number(tab.id), selector, value: String(args.value ?? '') });
    return textResult(JSON.stringify(data, null, 2), data);
  }
  if (name === 'personal_edge_navigate') {
    const tab = personalEdgeSharedTab();
    const url = String(args.url || '').trim();
    if (!/^https?:\/\//i.test(url)) throw new Error('personal_edge_navigate only accepts absolute http/https URLs');
    const data = await requestPersonalEdgeCommand({ id: randomUUID(), op: 'navigate', tabId: Number(tab.id), url });
    return textResult(JSON.stringify(data, null, 2), data);
  }
  if (name === 'personal_edge_reload') {
    const tab = personalEdgeSharedTab();
    const data = await requestPersonalEdgeCommand({ id: randomUUID(), op: 'reload', tabId: Number(tab.id) });
    return textResult(JSON.stringify(data, null, 2), data);
  }
  throw new Error(`Unknown Personal Edge tool: ${name}`);
}

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
    defineGatewayProvider({
      id: 'personal-edge',
      listTools: async () => personalEdgeTools,
      owns: name => personalEdgeTools.some(tool => tool.name === name),
      callTool: (name, args) => callPersonalEdgeTool(name, args),
    }),
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
  res.json({ ok: true, integratedWebMcp: true, controlVersion: 2, browserRunning: managedBrowserProvider.isRunning(), profile: managedBrowserProvider.profileDir, personalEdge: personalEdgeStatusData() });
});

app.post('/control/personal-edge/register', (req, res) => {
  try {
    if (String(req.body?.token || '') !== PERSONAL_EDGE_BRIDGE_TOKEN) {
      return res.status(403).json({ ok: false, error: 'invalid personal Edge bridge token' });
    }
    const clientId = String(req.body?.clientId || '').trim();
    if (!clientId) return res.status(400).json({ ok: false, error: 'clientId is required' });
    personalEdgeClient = {
      clientId,
      shared: req.body?.shared === true,
      lastSeen: Date.now(),
      tab: req.body?.tab && typeof req.body.tab === 'object' ? req.body.tab : null,
    };
    res.json({ ok: true, personalEdge: personalEdgeStatusData() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/control/personal-edge/poll', (req, res) => {
  try {
    if (String(req.query?.token || '') !== PERSONAL_EDGE_BRIDGE_TOKEN) {
      return res.status(403).json({ ok: false, error: 'invalid personal Edge bridge token' });
    }
    const clientId = String(req.query?.clientId || '').trim();
    if (!clientId || clientId !== personalEdgeClient.clientId) {
      return res.status(409).json({ ok: false, error: 'personal Edge client is not the active registered client' });
    }
    const queued = takeQueuedPersonalEdgeCommand();
    if (queued) return res.json({ ok: true, command: queued });

    let settled = false;
    const finish = command => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      const index = personalEdgePollWaiters.indexOf(finish);
      if (index >= 0) personalEdgePollWaiters.splice(index, 1);
      if (!res.headersSent) res.json({ ok: true, command: command || null });
      return true;
    };
    const timer = setTimeout(() => finish(null), 20000);
    personalEdgePollWaiters.push(finish);
    res.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const index = personalEdgePollWaiters.indexOf(finish);
      if (index >= 0) personalEdgePollWaiters.splice(index, 1);
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/control/personal-edge/result', (req, res) => {
  try {
    if (String(req.body?.token || '') !== PERSONAL_EDGE_BRIDGE_TOKEN) {
      return res.status(403).json({ ok: false, error: 'invalid personal Edge bridge token' });
    }
    const clientId = String(req.body?.clientId || '').trim();
    if (!clientId || clientId !== personalEdgeClient.clientId) {
      return res.status(409).json({ ok: false, error: 'personal Edge client is not the active registered client' });
    }
    const id = String(req.body?.id || '').trim();
    const pending = personalEdgePendingResults.get(id);
    if (!pending) return res.status(410).json({ ok: false, error: 'personal Edge command is no longer pending' });
    personalEdgePendingResults.delete(id);
    clearTimeout(pending.timer);
    const errorText = String(req.body?.error || '').trim();
    if (errorText) pending.reject(new Error(errorText));
    else pending.resolve(req.body?.result ?? null);
    res.json({ ok: true });
  } catch (error) {
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
