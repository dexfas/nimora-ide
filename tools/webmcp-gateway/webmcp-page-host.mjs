import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export function serializeWebMcpPageValue(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => {
    if (item instanceof Uint8Array) return `[Uint8Array ${item.byteLength} bytes]`;
    return item;
  }));
}

export function createWebMcpPageHost({
  managedBrowser,
  listTools,
  callTool,
  fallbackAgentPath,
  sharedPageCorePath = '',
  sharedSiteAdaptersPath = '',
  sharedPageAgentPath = '',
  readFile = fs.readFile,
  newId = randomUUID,
} = {}) {
  if (!managedBrowser || typeof managedBrowser.currentPage !== 'function' || typeof managedBrowser.pages !== 'function' || typeof managedBrowser.pageInfo !== 'function') {
    throw new Error('WebMCP page host requires a managed browser provider.');
  }
  if (typeof listTools !== 'function') throw new Error('WebMCP page host requires listTools().');
  if (typeof callTool !== 'function') throw new Error('WebMCP page host requires callTool().');
  if (typeof fallbackAgentPath !== 'string' || !fallbackAgentPath.trim()) throw new Error('WebMCP page host requires fallbackAgentPath.');

  const pageSessions = new WeakMap();
  let factorySource;

  async function getFactorySource() {
    if (factorySource) return factorySource;
    if (sharedPageCorePath && sharedSiteAdaptersPath && sharedPageAgentPath) {
      const [coreSource, siteAdaptersSource, agentSource] = await Promise.all([
        readFile(sharedPageCorePath, 'utf8'),
        readFile(sharedSiteAdaptersPath, 'utf8'),
        readFile(sharedPageAgentPath, 'utf8'),
      ]);
      factorySource = `(function shunCodeWebMcpComposedAgent(config) {\n`
        + `  const createCore = (${String(coreSource).trim()});\n`
        + `  const createSiteAdapter = (${String(siteAdaptersSource).trim()});\n`
        + `  const agent = (${String(agentSource).trim()});\n`
        + `  return agent(config, { createCore, createSiteAdapter });\n`
        + `})`;
    } else {
      factorySource = await readFile(fallbackAgentPath, 'utf8');
    }
    return factorySource;
  }

  async function ensure(page) {
    let session = pageSessions.get(page);
    if (session) return session;

    const suffix = String(newId()).replaceAll('-', '').slice(0, 12);
    const token = String(newId());
    const listBinding = `__shuncodeListTools_${suffix}`;
    const invokeBinding = `__shuncodeInvokeTool_${suffix}`;

    await page.exposeBinding(listBinding, async (_source, providedToken) => {
      if (providedToken !== token) throw new Error('Invalid ShunCode page bridge token');
      const tools = await listTools();
      return tools.map(tool => ({
        name: tool.name,
        description: tool.description || tool.modelDescription || tool.name,
        inputSchema: tool.inputSchema || { type: 'object' },
      }));
    });
    await page.exposeBinding(invokeBinding, async (_source, providedToken, name, args) => {
      if (providedToken !== token) throw new Error('Invalid ShunCode page bridge token');
      const result = await callTool(String(name || ''), args && typeof args === 'object' ? args : {});
      return serializeWebMcpPageValue(result);
    });

    const source = await getFactorySource();
    const expression = `(${source})(${JSON.stringify({ token, listBinding, invokeBinding })});`;
    await page.addInitScript({ content: expression });
    if (/^https?:/i.test(page.url())) {
      try { await page.evaluate(expression); } catch {}
    }
    session = { token, listBinding, invokeBinding, expression };
    pageSessions.set(page, session);
    return session;
  }

  async function connect({ prime = true } = {}) {
    const page = await managedBrowser.currentPage();
    const pages = await managedBrowser.pages();
    await ensure(page);

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

    const info = await managedBrowser.pageInfo(page, pages.indexOf(page));
    return { ok: true, page: info, chatDetected: !!status?.composerFound, status, primeResult };
  }

  return {
    ensure,
    connect,
    getFactorySource,
    serialize: serializeWebMcpPageValue,
  };
}
