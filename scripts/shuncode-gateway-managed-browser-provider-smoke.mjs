import assert from 'node:assert/strict';
import path from 'node:path';
import { createManagedBrowserProvider } from '../tools/webmcp-gateway/managed-browser-provider.mjs';

class FakeLocator {
  constructor(page, selector) {
    this.page = page;
    this.selector = selector;
  }

  async click(options) {
    this.page.actions.push({ type: 'click', selector: this.selector, options });
  }

  async fill(value, options) {
    this.page.actions.push({ type: 'fill', selector: this.selector, value, options });
  }

  async innerText() {
    return `TEXT:${this.selector}:abcdefghijklmnopqrstuvwxyz`;
  }

  async evaluate() {
    return `<div data-selector="${this.selector}">content</div>`;
  }
}

class FakePage {
  constructor(url = 'about:blank', { visible = true } = {}) {
    this.currentUrl = url;
    this.visible = visible;
    this.closed = false;
    this.actions = [];
    this.screenshots = [];
  }

  async title() {
    return `Title:${this.currentUrl}`;
  }

  url() {
    return this.currentUrl;
  }

  isClosed() {
    return this.closed;
  }

  async goto(url, options) {
    this.currentUrl = String(url);
    this.actions.push({ type: 'goto', url: this.currentUrl, options });
  }

  async evaluate(fn, arg) {
    const source = String(fn);
    if (source.includes('document.visibilityState')) return this.visible;
    return { evaluated: arg };
  }

  locator(selector) {
    return new FakeLocator(this, selector);
  }

  async screenshot(options) {
    this.screenshots.push(options);
  }
}

class FakeContext {
  constructor() {
    this.openPages = [];
    this.listeners = new Map();
    this.closed = false;
  }

  pages() {
    return [...this.openPages];
  }

  async newPage() {
    const page = new FakePage();
    this.openPages.push(page);
    return page;
  }

  on(name, listener) {
    this.listeners.set(name, listener);
  }

  async close() {
    this.closed = true;
    this.listeners.get('close')?.();
  }
}

const contexts = [];
const launches = [];
const chromiumImpl = {
  async launchPersistentContext(profileDir, options) {
    launches.push({ profileDir, options });
    const context = new FakeContext();
    contexts.push(context);
    return context;
  },
};
const mkdirs = [];
const fsImpl = { async mkdir(dir, options) { mkdirs.push({ dir, options }); } };
const profileDir = path.resolve('tmp-managed-profile');
const screenshotDir = path.resolve('tmp-managed-shots');
const provider = createManagedBrowserProvider({
  edgePath: 'C:\\Fake\\msedge.exe',
  profileDir,
  screenshotDir,
  chromiumImpl,
  fsImpl,
});

assert.equal(provider.id, 'managed-browser');
assert.equal(provider.profileDir, profileDir);
assert.equal(provider.isRunning(), false);
assert.deepEqual(await provider.status(), { browserRunning: false, pages: [] });

const tools = await provider.listTools();
assert.deepEqual(tools.map(tool => tool.name), [
  'browser_open', 'browser_pages', 'browser_click', 'browser_fill',
  'browser_get_text', 'browser_dom', 'browser_evaluate', 'browser_screenshot',
]);
assert.equal(tools.find(tool => tool.name === 'browser_pages')?._meta?.['nimora/capability']?.retry, 'automatic');
assert.equal(tools.find(tool => tool.name === 'browser_click')?._meta?.['nimora/capability']?.idempotency, 'non-idempotent');
assert.equal(tools.find(tool => tool.name === 'browser_screenshot')?._meta?.['nimora/capability']?.openWorld, false);
assert.equal(provider.owns('browser_pages'), true);
assert.equal(provider.owns('read_files'), false);

const started = await provider.start();
assert.equal(started.browserRunning, true);
assert.equal(started.pages.length, 1);
assert.equal(launches.length, 1, 'persistent browser context must launch once');
assert.equal(launches[0].profileDir, profileDir);
assert.equal(launches[0].options.executablePath, 'C:\\Fake\\msedge.exe');
assert.equal(provider.isRunning(), true);
assert.equal((await provider.status()).pages.length, 1);

const opened = await provider.open('https://example.test/chat');
assert.equal(opened.page_id, 0);
assert.equal(opened.url, 'https://example.test/chat');
assert.equal(launches.length, 1, 'control open must reuse persistent context');

const page = contexts[0].openPages[0];
const pagesResult = await provider.callTool('browser_pages');
assert.equal(pagesResult.structuredContent.pages[0].url, 'https://example.test/chat');

await provider.callTool('browser_click', { selector: '#go', timeout_ms: 321 });
await provider.callTool('browser_fill', { selector: '#name', value: 'Nimora', timeout_ms: 654 });
assert.deepEqual(page.actions.filter(action => action.type === 'click' || action.type === 'fill'), [
  { type: 'click', selector: '#go', options: { timeout: 321 } },
  { type: 'fill', selector: '#name', value: 'Nimora', options: { timeout: 654 } },
]);

const text = await provider.callTool('browser_get_text', { selector: 'main', max_chars: 12 });
assert.equal(text.structuredContent.text.length, 12);
assert.equal(text.structuredContent.selector, 'main');

const dom = await provider.callTool('browser_dom', { selector: '#app', max_chars: 18 });
assert.equal(dom.structuredContent.html.length, 18);
assert.equal(dom.structuredContent.truncated, true);

const evaluated = await provider.callTool('browser_evaluate', { expression: '2 + 2' });
assert.deepEqual(evaluated.structuredContent.result, { evaluated: '2 + 2' });

const screenshot = await provider.callTool('browser_screenshot', { filename: '../bad name.png', full_page: true });
assert.equal(mkdirs.length, 1);
assert.equal(mkdirs[0].dir, screenshotDir);
assert.match(screenshot.structuredContent.path, /_bad_name\.png$/);
assert.equal(page.screenshots.length, 1);
assert.equal(page.screenshots[0].fullPage, true);

await assert.rejects(() => provider.callTool('browser_get_text', { page_id: 99 }), /page_id 99 does not exist/);
await assert.rejects(() => provider.callTool('not_a_browser_tool', {}), /Unknown browser tool/);

const stopped = await provider.stop();
assert.deepEqual(stopped, { browserRunning: false });
assert.equal(contexts[0].closed, true);
assert.equal(provider.isRunning(), false);
assert.deepEqual(await provider.status(), { browserRunning: false, pages: [] });

console.log('[smoke] Managed Browser provider lifecycle/control/tools/metadata contract ok');
