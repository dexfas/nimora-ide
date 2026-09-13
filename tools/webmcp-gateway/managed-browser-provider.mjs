import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { defineGatewayCapability } from './capability-contract.mjs';
import { defineGatewayProvider } from './provider-registry.mjs';

const managedBrowserMetadata = (id, title, risk, idempotency, retry, approval, { destructive = false, openWorld = true, tags = [] } = {}) => ({
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

const managedBrowserTools = [
  defineGatewayCapability({ name: 'browser_open', description: 'EXTERNAL COMPUTER BROWSER: open a URL in the gateway-managed persistent Microsoft Edge. This browser is outside ShunCode Integrated Browser and keeps its own persistent profile/session across calls.', inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string' }, new_tab: { type: 'boolean', default: false } }, additionalProperties: false } }, managedBrowserMetadata('browser.managed.open', 'Open Managed Browser URL', 'external-side-effect', 'unknown', 'never', 'none', { tags: ['browser', 'managed', 'navigate'] })),
  defineGatewayCapability({ name: 'browser_pages', description: 'EXTERNAL COMPUTER BROWSER: list tabs in the gateway-managed persistent Edge with page_id, title and URL.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, managedBrowserMetadata('browser.managed.pages', 'List Managed Browser Pages', 'read', 'safe', 'automatic', 'none', { tags: ['browser', 'managed', 'read'] })),
  defineGatewayCapability({ name: 'browser_click', description: 'EXTERNAL COMPUTER BROWSER: click a DOM element in the gateway-managed Edge by CSS selector.', inputSchema: { type: 'object', required: ['selector'], properties: { selector: { type: 'string' }, page_id: { type: 'integer', minimum: 0 }, timeout_ms: { type: 'integer', minimum: 100, maximum: 120000, default: 15000 } }, additionalProperties: false } }, managedBrowserMetadata('browser.managed.click', 'Click Managed Browser Element', 'external-side-effect', 'non-idempotent', 'never', 'none', { destructive: true, tags: ['browser', 'managed', 'interaction'] })),
  defineGatewayCapability({ name: 'browser_fill', description: 'EXTERNAL COMPUTER BROWSER: fill an input, textarea, or contenteditable element in the gateway-managed Edge.', inputSchema: { type: 'object', required: ['selector', 'value'], properties: { selector: { type: 'string' }, value: { type: 'string' }, page_id: { type: 'integer', minimum: 0 }, timeout_ms: { type: 'integer', minimum: 100, maximum: 120000, default: 15000 } }, additionalProperties: false } }, managedBrowserMetadata('browser.managed.fill', 'Fill Managed Browser Field', 'external-side-effect', 'non-idempotent', 'never', 'none', { destructive: true, tags: ['browser', 'managed', 'interaction'] })),
  defineGatewayCapability({ name: 'browser_get_text', description: 'EXTERNAL COMPUTER BROWSER: read visible text from a selector or full page body in the gateway-managed Edge.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, page_id: { type: 'integer', minimum: 0 }, max_chars: { type: 'integer', minimum: 1, maximum: 100000, default: 20000 } }, additionalProperties: false } }, managedBrowserMetadata('browser.managed.read-text', 'Read Managed Browser Text', 'read', 'safe', 'automatic', 'none', { tags: ['browser', 'managed', 'read'] })),
  defineGatewayCapability({ name: 'browser_dom', description: 'EXTERNAL COMPUTER BROWSER: read DOM HTML from a selector or full document in the gateway-managed Edge.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, page_id: { type: 'integer', minimum: 0 }, max_chars: { type: 'integer', minimum: 1, maximum: 200000, default: 50000 } }, additionalProperties: false } }, managedBrowserMetadata('browser.managed.dom', 'Read Managed Browser DOM', 'read', 'safe', 'automatic', 'none', { tags: ['browser', 'managed', 'dom', 'read'] })),
  defineGatewayCapability({ name: 'browser_evaluate', description: 'EXTERNAL COMPUTER BROWSER: evaluate JavaScript in the gateway-managed Edge page and return a JSON-serializable result.', inputSchema: { type: 'object', required: ['expression'], properties: { expression: { type: 'string' }, page_id: { type: 'integer', minimum: 0 } }, additionalProperties: false } }, managedBrowserMetadata('browser.managed.evaluate', 'Evaluate Managed Browser JavaScript', 'external-side-effect', 'unknown', 'never', 'none', { destructive: true, tags: ['browser', 'managed', 'javascript'] })),
  defineGatewayCapability({ name: 'browser_screenshot', description: 'EXTERNAL COMPUTER BROWSER: take a screenshot of a gateway-managed Edge page and save it under this MCP project.', inputSchema: { type: 'object', properties: { page_id: { type: 'integer', minimum: 0 }, full_page: { type: 'boolean', default: false }, filename: { type: 'string' } }, additionalProperties: false } }, managedBrowserMetadata('browser.managed.screenshot', 'Capture Managed Browser Screenshot', 'write', 'unknown', 'never', 'none', { openWorld: false, tags: ['browser', 'managed', 'artifact'] })),
];

function textResult(text, structuredContent) {
  return { content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}) };
}

export function createManagedBrowserProvider({
  edgePath,
  profileDir,
  screenshotDir,
  chromiumImpl = chromium,
  fsImpl = fs,
} = {}) {
  if (typeof edgePath !== 'string' || !edgePath.trim()) throw new Error('Managed Browser provider requires edgePath.');
  if (typeof profileDir !== 'string' || !profileDir.trim()) throw new Error('Managed Browser provider requires profileDir.');
  if (typeof screenshotDir !== 'string' || !screenshotDir.trim()) throw new Error('Managed Browser provider requires screenshotDir.');

  let browserContext;
  let browserConnectPromise;

  async function getContext() {
    if (browserContext) return browserContext;
    if (!browserConnectPromise) {
      browserConnectPromise = (async () => {
        const context = await chromiumImpl.launchPersistentContext(profileDir, {
          executablePath: edgePath,
          headless: false,
          viewport: null,
          args: ['--start-maximized'],
        });
        browserContext = context;
        context.on('close', () => {
          if (browserContext === context) browserContext = undefined;
        });
        return context;
      })().finally(() => { browserConnectPromise = undefined; });
    }
    return browserConnectPromise;
  }

  async function pageInfo(page, pageId = -1) {
    let title = '';
    try { title = await page.title(); } catch {}
    return { page_id: pageId, title, url: page.url() };
  }

  async function pages() {
    return (await getContext()).pages();
  }

  async function currentPage() {
    const context = await getContext();
    const openPages = context.pages().filter(page => !page.isClosed());
    if (!openPages.length) return await context.newPage();
    for (let i = openPages.length - 1; i >= 0; i--) {
      const page = openPages[i];
      try {
        if (await page.evaluate(() => document.visibilityState === 'visible')) return page;
      } catch {}
    }
    return openPages.findLast(page => /^https?:/i.test(page.url())) || openPages.at(-1);
  }

  async function pageFor(args = {}) {
    const context = await getContext();
    let openPages = context.pages();
    if (!openPages.length) openPages = [await context.newPage()];
    const id = Number.isInteger(args.page_id) ? args.page_id : openPages.length - 1;
    if (!openPages[id]) throw new Error(`page_id ${id} does not exist; available page ids: 0..${openPages.length - 1}`);
    return openPages[id];
  }

  async function start() {
    const context = await getContext();
    let openPages = context.pages();
    if (!openPages.length) openPages = [await context.newPage()];
    return { browserRunning: true, pages: await Promise.all(openPages.map((page, index) => pageInfo(page, index))) };
  }

  async function status() {
    if (!browserContext) return { browserRunning: false, pages: [] };
    const openPages = browserContext.pages();
    return { browserRunning: true, pages: await Promise.all(openPages.map((page, index) => pageInfo(page, index))) };
  }

  async function open(url) {
    const page = await currentPage();
    await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 60000 });
    const openPages = (await getContext()).pages();
    return pageInfo(page, openPages.indexOf(page));
  }

  async function stop() {
    const context = browserContext;
    browserContext = undefined;
    browserConnectPromise = undefined;
    if (context) await context.close();
    return { browserRunning: false };
  }

  async function callTool(name, args = {}) {
    if (name === 'browser_open') {
      const context = await getContext();
      let openPages = context.pages();
      const page = args.new_tab || !openPages.length ? await context.newPage() : openPages[openPages.length - 1];
      await page.goto(String(args.url), { waitUntil: 'domcontentloaded', timeout: 60000 });
      openPages = context.pages();
      const data = await pageInfo(page, openPages.indexOf(page));
      return textResult(JSON.stringify(data, null, 2), data);
    }
    if (name === 'browser_pages') {
      const openPages = await pages();
      const data = await Promise.all(openPages.map((page, pageId) => pageInfo(page, pageId)));
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
      await fsImpl.mkdir(screenshotDir, { recursive: true });
      const safe = String(args.filename || `shot-${Date.now()}.png`).replace(/[^a-zA-Z0-9._-]/g, '_');
      const output = path.join(screenshotDir, safe.endsWith('.png') ? safe : `${safe}.png`);
      await page.screenshot({ path: output, fullPage: Boolean(args.full_page) });
      return textResult(output, { path: output });
    }
    throw new Error(`Unknown browser tool: ${name}`);
  }

  return defineGatewayProvider({
    id: 'managed-browser',
    listTools: async () => managedBrowserTools,
    owns: name => managedBrowserTools.some(tool => tool.name === name),
    callTool,
    profileDir,
    isRunning: () => !!browserContext,
    start,
    status,
    open,
    stop,
    pages,
    currentPage,
    pageInfo,
  });
}
