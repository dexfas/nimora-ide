import path from 'node:path';
import express from 'express';
import { createIntegratedBrowserProvider } from './integrated-browser-provider.mjs';
import { createManagedBrowserProvider } from './managed-browser-provider.mjs';
import { createGatewayMcpExposureAdapter } from './mcp-exposure-adapter.mjs';
import { createPersonalEdgeProvider, PersonalEdgeControlError, PersonalEdgePollAbortedError } from './personal-edge-provider.mjs';
import { GatewayProviderRegistry } from './provider-registry.mjs';
import { createUpstreamMcpProvider } from './upstream-mcp-provider.mjs';
import { createWebMcpPageHost } from './webmcp-page-host.mjs';

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

const webMcpPageHost = createWebMcpPageHost({
  managedBrowser: managedBrowserProvider,
  listTools: listAllTools,
  callTool: callAnyTool,
  fallbackAgentPath: CHAT_AGENT_PATH,
  sharedPageCorePath: SHARED_PAGE_CORE_PATH,
  sharedSiteAdaptersPath: SHARED_SITE_ADAPTERS_PATH,
  sharedPageAgentPath: SHARED_PAGE_AGENT_PATH,
});
const mcpExposure = createGatewayMcpExposureAdapter({ listTools: listAllTools, callTool: callAnyTool });

const app = express();
app.use(express.json({ limit: '8mb' }));

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
    res.json({ ok: true, result: webMcpPageHost.serialize(result) });
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
    res.json(await webMcpPageHost.connect({ prime: req.body?.prime !== false }));
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
    await mcpExposure.handlePost(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

for (const method of ['get', 'delete']) {
  app[method]('/mcp', async (req, res) => {
    await mcpExposure.handleSessionRequest(req, res);
  });
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`ShunCode Browser MCP Gateway: http://127.0.0.1:${PORT}/mcp`);
  console.log(`Upstream: ${UPSTREAM_URL || '(set SHUNCODE_MCP_URL)'}`);
});
