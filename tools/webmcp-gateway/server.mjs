import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { chromium } from 'playwright-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { defineGatewayCapability, retryPolicyForTool } from './capability-contract.mjs';

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

let upstreamClient;
let upstreamConnectPromise;
let upstreamToolsCache = [];
let upstreamToolsCacheAt = 0;
let browserContext;
let browserConnectPromise;
const pageAgentSessions = new WeakMap();
let chatAgentFactorySource;
let personalEdgeClient = { clientId: '', shared: false, lastSeen: 0, tab: null };
const personalEdgeCommandQueue = [];
const personalEdgePendingResults = new Map();
const personalEdgePollWaiters = [];

const gatewayMetadata = (id, title, risk, idempotency, retry, approval, { destructive = false, openWorld = true, tags = [] } = {}) => ({
  id,
  version: 1,
  title,
  category: 'browser',
  tags,
  environment: 'gateway',
  risk,
  idempotency,
  retry,
  approval,
  destructive,
  openWorld,
});

const browserTools = [
  defineGatewayCapability({ name: 'browser_open', description: 'EXTERNAL COMPUTER BROWSER: open a URL in the gateway-managed persistent Microsoft Edge. This browser is outside ShunCode Integrated Browser and keeps its own persistent profile/session across calls.', inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, new_tab: { type: 'boolean', default: false } }, additionalProperties: false } }, gatewayMetadata('browser.managed.open', 'Open Managed Browser URL', 'external-side-effect', 'unknown', 'never', 'none', { tags: ['browser', 'managed', 'navigate'] })),
  defineGatewayCapability({ name: 'browser_pages', description: 'EXTERNAL COMPUTER BROWSER: list tabs in the gateway-managed persistent Edge with page_id, title and URL.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, gatewayMetadata('browser.managed.pages', 'List Managed Browser Pages', 'read', 'safe', 'automatic', 'none', { tags: ['browser', 'managed', 'read'] })),
  defineGatewayCapability({ name: 'browser_click', description: 'EXTERNAL COMPUTER BROWSER: click a DOM element in the gateway-managed Edge by CSS selector.', inputSchema: { type: 'object', required: ['selector'], properties: { selector: { type: 'string' }, page_id: { type: 'integer', minimum: 0 }, timeout_ms: { type: 'integer', minimum: 100, maximum: 120000, default: 15000 } }, additionalProperties: false } }, gatewayMetadata('browser.managed.click', 'Click Managed Browser Element', 'external-side-effect', 'non-idempotent', 'never', 'none', { destructive: true, tags: ['browser', 'managed', 'interaction'] })),
  defineGatewayCapability({ name: 'browser_fill', description: 'EXTERNAL COMPUTER BROWSER: fill an input, textarea, or contenteditable element in the gateway-managed Edge.', inputSchema: { type: 'object', required: ['selector', 'value'], properties: { selector: { type: 'string' }, value: { type: 'string' }, page_id: { type: 'integer', minimum: 0 }, timeout_ms: { type: 'integer', minimum: 100, maximum: 120000, default: 15000 } }, additionalProperties: false } }, gatewayMetadata('browser.managed.fill', 'Fill Managed Browser Field', 'external-side-effect', 'non-idempotent', 'never', 'none', { destructive: true, tags: ['browser', 'managed', 'interaction'] })),
  defineGatewayCapability({ name: 'browser_get_text', description: 'EXTERNAL COMPUTER BROWSER: read visible text from a selector or full page body in the gateway-managed Edge.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, page_id: { type: 'integer', minimum: 0 }, max_chars: { type: 'integer', minimum: 1, maximum: 100000, default: 20000 } }, additionalProperties: false } }, gatewayMetadata('browser.managed.read-text', 'Read Managed Browser Text', 'read', 'safe', 'automatic', 'none', { tags: ['browser', 'managed', 'read'] })),
  defineGatewayCapability({ name: 'browser_dom', description: 'EXTERNAL COMPUTER BROWSER: read DOM HTML from a selector or full document in the gateway-managed Edge.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, page_id: { type: 'integer', minimum: 0 }, max_chars: { type: 'integer', minimum: 1, maximum: 200000, default: 50000 } }, additionalProperties: false } }, gatewayMetadata('browser.managed.dom', 'Read Managed Browser DOM', 'read', 'safe', 'automatic', 'none', { tags: ['browser', 'managed', 'dom', 'read'] })),
  defineGatewayCapability({ name: 'browser_evaluate', description: 'EXTERNAL COMPUTER BROWSER: evaluate JavaScript in the gateway-managed Edge page and return a JSON-serializable result.', inputSchema: { type: 'object', required: ['expression'], properties: { expression: { type: 'string' }, page_id: { type: 'integer', minimum: 0 } }, additionalProperties: false } }, gatewayMetadata('browser.managed.evaluate', 'Evaluate Managed Browser JavaScript', 'external-side-effect', 'unknown', 'never', 'none', { destructive: true, tags: ['browser', 'managed', 'javascript'] })),
  defineGatewayCapability({ name: 'browser_screenshot', description: 'EXTERNAL COMPUTER BROWSER: take a screenshot of a gateway-managed Edge page and save it under this MCP project.', inputSchema: { type: 'object', properties: { page_id: { type: 'integer', minimum: 0 }, full_page: { type: 'boolean', default: false }, filename: { type: 'string' } }, additionalProperties: false } }, gatewayMetadata('browser.managed.screenshot', 'Capture Managed Browser Screenshot', 'write', 'unknown', 'never', 'none', { openWorld: false, tags: ['browser', 'managed', 'artifact'] })),
];

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

let integratedToolsCache = [];
let integratedToolsCacheAt = 0;

async function getIntegratedBrowserTools(force = false) {
  if (!force && Date.now() - integratedToolsCacheAt < 2000) return integratedToolsCache;
  try {
    const response = await fetch(`${INTEGRATED_BROWSER_BRIDGE}/tools`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    integratedToolsCache = Array.isArray(body.tools) ? body.tools : [];
    integratedToolsCacheAt = Date.now();
  } catch {
    integratedToolsCache = [];
    integratedToolsCacheAt = Date.now();
  }
  return integratedToolsCache;
}

async function callIntegratedBrowserTool(name, args) {
  const response = await fetch(`${INTEGRATED_BROWSER_BRIDGE}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, input: args }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || `Integrated Browser Bridge HTTP ${response.status}`);
  const content = Array.isArray(body.result?.content) ? body.result.content : [];
  const mcpContent = content.flatMap(part => {
    if (part?.type === 'text') return [{ type: 'text', text: String(part.text ?? '') }];
    if (part?.type === 'data' && part.base64) return [{ type: 'text', text: `[binary browser result omitted: ${String(part.base64).length} base64 chars]` }];
    return [{ type: 'text', text: JSON.stringify(part) }];
  });
  return { content: mcpContent.length ? mcpContent : [{ type: 'text', text: 'Browser tool completed.' }] };
}

async function listAllTools() {
  const upstreamTools = await listUpstreamToolsStable();
  const integratedTools = await getIntegratedBrowserTools();
  return [...upstreamTools, ...integratedTools, ...browserTools, ...personalEdgeTools];
}

async function listShunCodeTools() {
  const upstreamTools = await listUpstreamToolsStable();
  const integratedTools = await getIntegratedBrowserTools();
  return [...upstreamTools, ...integratedTools.filter(tool => !webMcpHiddenIntegratedTools.has(tool.name)), ...browserTools, ...personalEdgeTools];
}

async function callAnyTool(name, args = {}) {
  const integratedTools = await getIntegratedBrowserTools();
  if (integratedTools.some(tool => tool.name === name)) return await callIntegratedBrowserTool(name, args);
  if (browserTools.some(tool => tool.name === name)) return await callBrowserTool(name, args);
  if (personalEdgeTools.some(tool => tool.name === name)) return await callPersonalEdgeTool(name, args);
  return await callUpstreamToolStable(name, args);
}

async function callShunCodeTool(name, args = {}) {
  if (webMcpHiddenIntegratedTools.has(name)) {
    throw new Error(`WebMCP tool '${name}' is intentionally disabled to avoid repeated ShunCode browser confirmation dialogs. Do not retry it. Ask the user to open/preview the local file manually if visual verification is actually needed.`);
  }
  const integratedTools = await getIntegratedBrowserTools();
  if (integratedTools.some(tool => tool.name === name)) return await callIntegratedBrowserTool(name, args);
  if (browserTools.some(tool => tool.name === name)) return await callBrowserTool(name, args);
  if (personalEdgeTools.some(tool => tool.name === name)) return await callPersonalEdgeTool(name, args);
  return await callUpstreamToolStable(name, args);
}

// Compatibility only for an older upstream Bridge that predates capability
// metadata. Current Nimora Bridge tools carry `nimora/capability` metadata and
// use that as the source of truth for retry policy.
const legacyRetryableReadOnlyUpstreamTools = new Set([
  'find_files', 'read_files', 'search_files', 'list_directory', 'get_diagnostics', 'lsp', 'get_command_output',
]);

async function upstreamToolDefinition(name) {
  let found = upstreamToolsCache.find(tool => tool.name === name);
  if (found) return found;
  try {
    const tools = await listUpstreamToolsStable();
    found = tools.find(tool => tool.name === name);
  } catch {}
  return found;
}

function isUpstreamTransportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket|network|terminated|aborted/i.test(message);
}

async function callUpstreamToolStable(name, args = {}) {
  const toolDefinition = await upstreamToolDefinition(name);
  try {
    return await (await getUpstream()).callTool({ name, arguments: args });
  } catch (error) {
    if (!isUpstreamTransportError(error)) throw error;
    await resetUpstream();
    const retryPolicy = toolDefinition ? retryPolicyForTool(toolDefinition) : undefined;
    if (retryPolicy === 'automatic' || (retryPolicy === undefined && legacyRetryableReadOnlyUpstreamTools.has(name))) {
      await new Promise(resolve => setTimeout(resolve, 180));
      return await (await getUpstream()).callTool({ name, arguments: args });
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Upstream MCP transport failed and was reset: ${message}. This side-effect-capable tool was NOT automatically retried; verify state before retrying to avoid duplicate effects.`);
  }
}

async function getUpstream() {
  if (!UPSTREAM_URL) {
    throw new Error('SHUNCODE_MCP_URL is not configured. Set it to the ShunCode Bridge MCP endpoint before using upstream tools.');
  }
  if (upstreamClient) return upstreamClient;
  if (!upstreamConnectPromise) {
    upstreamConnectPromise = (async () => {
      const client = new Client({ name: 'shuncode-browser-gateway', version: '0.1.0' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(UPSTREAM_URL), {
        requestInit: { headers: { 'ngrok-skip-browser-warning': '1' } },
      });
      await client.connect(transport);
      upstreamClient = client;
      return client;
    })().finally(() => { upstreamConnectPromise = undefined; });
  }
  return upstreamConnectPromise;
}

async function resetUpstream() {
  const client = upstreamClient;
  upstreamClient = undefined;
  upstreamConnectPromise = undefined;
  try { await client?.close?.(); } catch {}
}

async function listUpstreamToolsStable() {
  const load = async () => {
    const response = await (await getUpstream()).listTools();
    const tools = Array.isArray(response?.tools) ? response.tools : [];
    if (tools.length) {
      upstreamToolsCache = tools;
      upstreamToolsCacheAt = Date.now();
    }
    return tools;
  };

  const retryDelays = [0, 250, 700, 1500];
  let lastError;
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    if (attempt > 0) {
      await resetUpstream();
      await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
    }
    try {
      return await load();
    } catch (error) {
      lastError = error;
      console.warn(`[web-mcp] upstream listTools attempt ${attempt + 1}/${retryDelays.length} failed:`, error instanceof Error ? error.message : String(error));
    }
  }

  if (upstreamToolsCache.length) {
    console.warn(`[web-mcp] using cached upstream tool list (${upstreamToolsCache.length} tools, age=${Date.now() - upstreamToolsCacheAt}ms)`);
    return upstreamToolsCache;
  }
  throw lastError || new Error('upstream listTools failed');
}

async function getBrowser() {
  if (browserContext) return browserContext;
  if (!browserConnectPromise) {
    browserConnectPromise = (async () => {
      browserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath: EDGE_PATH,
        headless: false,
        viewport: null,
        args: ['--start-maximized'],
      });
      browserContext.on('close', () => { browserContext = undefined; });
      return browserContext;
    })().finally(() => { browserConnectPromise = undefined; });
  }
  return browserConnectPromise;
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

async function pageInfoWithTitle(page, page_id = -1) {
  let title = '';
  try { title = await page.title(); } catch {}
  return { page_id, title, url: page.url() };
}

async function currentBrowserPage() {
  const context = await getBrowser();
  const pages = context.pages().filter(page => !page.isClosed());
  if (!pages.length) return await context.newPage();
  for (let i = pages.length - 1; i >= 0; i--) {
    const page = pages[i];
    try {
      if (await page.evaluate(() => document.visibilityState === 'visible')) return page;
    } catch {}
  }
  return pages.findLast(page => /^https?:/i.test(page.url())) || pages.at(-1);
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
  const context = await getBrowser();
  const page = await currentBrowserPage();
  const pages = context.pages();
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

  const info = await pageInfoWithTitle(page, pages.indexOf(page));
  return { ok: true, page: info, chatDetected: !!status?.composerFound, status, primeResult };
}

async function pageFor(args = {}) {
  const context = await getBrowser();
  let pages = context.pages();
  if (!pages.length) pages = [await context.newPage()];
  const id = Number.isInteger(args.page_id) ? args.page_id : pages.length - 1;
  if (!pages[id]) throw new Error(`page_id ${id} does not exist; available page ids: 0..${pages.length - 1}`);
  return pages[id];
}

function textResult(text, structuredContent) {
  return { content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}) };
}

async function callBrowserTool(name, args) {
  if (name === 'browser_open') {
    const context = await getBrowser();
    let pages = context.pages();
    const page = args.new_tab || !pages.length ? await context.newPage() : pages[pages.length - 1];
    await page.goto(String(args.url), { waitUntil: 'domcontentloaded', timeout: 60000 });
    pages = context.pages();
    const data = { page_id: pages.indexOf(page), title: await page.title(), url: page.url() };
    return textResult(JSON.stringify(data, null, 2), data);
  }
  if (name === 'browser_pages') {
    const context = await getBrowser();
    const pages = context.pages();
    const data = await Promise.all(pages.map(async (page, page_id) => ({ page_id, title: await page.title(), url: page.url() })));
    return textResult(JSON.stringify(data, null, 2), { pages: data });
  }
  if (name === 'browser_click') {
    const page = await pageFor(args);
    await page.locator(String(args.selector)).click({ timeout: Number(args.timeout_ms || 15000) });
    return textResult(`Clicked ${args.selector}\nURL: ${page.url()}`);
  }
  if (name === 'browser_fill') {
    const page = await pageFor(args);
    await page.locator(String(args.selector)).fill(String(args.value), { timeout: Number(args.timeout_ms || 15000) });
    return textResult(`Filled ${args.selector}`);
  }
  if (name === 'browser_get_text') {
    const page = await pageFor(args);
    const selector = args.selector ? String(args.selector) : 'body';
    const max = Number(args.max_chars || 20000);
    const value = (await page.locator(selector).innerText()).slice(0, max);
    return textResult(value, { selector, text: value });
  }
  if (name === 'browser_dom') {
    const page = await pageFor(args);
    const max = Number(args.max_chars || 50000);
    const html = args.selector ? await page.locator(String(args.selector)).evaluate(el => el.outerHTML) : await page.locator('html').evaluate(el => el.outerHTML);
    const value = String(html).slice(0, max);
    return textResult(value, { html: value, truncated: String(html).length > max });
  }
  if (name === 'browser_evaluate') {
    const page = await pageFor(args);
    const value = await page.evaluate(expression => (0, eval)(expression), String(args.expression));
    return textResult(JSON.stringify(value ?? null, null, 2), { result: value ?? null });
  }
  if (name === 'browser_screenshot') {
    const page = await pageFor(args);
    await fs.mkdir(SCREENSHOT_DIR, { recursive: true });
    const safe = String(args.filename || `shot-${Date.now()}.png`).replace(/[^a-zA-Z0-9._-]/g, '_');
    const output = path.join(SCREENSHOT_DIR, safe.endsWith('.png') ? safe : `${safe}.png`);
    await page.screenshot({ path: output, fullPage: Boolean(args.full_page) });
    return textResult(output, { path: output });
  }
  throw new Error(`Unknown browser tool: ${name}`);
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
  res.json({ ok: true, integratedWebMcp: true, controlVersion: 2, browserRunning: !!browserContext, profile: PROFILE_DIR, personalEdge: personalEdgeStatusData() });
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
    if (!browserContext) return res.json({ ok: true, browserRunning: false, pages: [] });
    const pages = browserContext.pages();
    const infos = await Promise.all(pages.map((page, index) => pageInfoWithTitle(page, index)));
    res.json({ ok: true, browserRunning: true, pages: infos });
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
    const context = await getBrowser();
    let pages = context.pages();
    if (!pages.length) pages = [await context.newPage()];
    const infos = await Promise.all(pages.map((page, index) => pageInfoWithTitle(page, index)));
    res.json({ ok: true, browserRunning: true, pages: infos });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/control/open', async (req, res) => {
  try {
    const url = String(req.body?.url || '').trim();
    if (!url) return res.status(400).json({ ok: false, error: 'url is required' });
    const page = await currentBrowserPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const pages = (await getBrowser()).pages();
    res.json({ ok: true, page: await pageInfoWithTitle(page, pages.indexOf(page)) });
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
    if (browserContext) await browserContext.close();
    browserContext = undefined;
    res.json({ ok: true, browserRunning: false });
  } catch (error) {
    res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});

app.get('/healthz', async (_req, res) => {
  try {
    const tools = await (await getUpstream()).listTools();
    const integratedTools = await getIntegratedBrowserTools(true);
    res.json({ ok: true, upstream: UPSTREAM_URL, upstream_tools: tools.tools.length, integrated_browser_tools: integratedTools.length, browser_tools: browserTools.length });
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
