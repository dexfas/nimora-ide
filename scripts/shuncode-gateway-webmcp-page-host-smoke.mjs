import assert from 'node:assert/strict';
import { createWebMcpPageHost, serializeWebMcpPageValue } from '../tools/webmcp-gateway/webmcp-page-host.mjs';

class FakePage {
  constructor(url = 'https://chat.example.test/') {
    this.currentUrl = url;
    this.bindings = new Map();
    this.initScripts = [];
    this.injections = [];
    this.status = { version: 25, composerFound: true, primed: false, siteAdapter: 'generic' };
    this.primeCount = 0;
  }

  url() {
    return this.currentUrl;
  }

  async exposeBinding(name, handler) {
    if (this.bindings.has(name)) throw new Error(`binding already exists: ${name}`);
    this.bindings.set(name, handler);
  }

  async addInitScript({ content }) {
    this.initScripts.push(content);
  }

  async evaluate(expression) {
    if (typeof expression === 'string') {
      this.injections.push(expression);
      return undefined;
    }
    const source = String(expression);
    if (source.includes('status?.()')) return { ...this.status };
    if (source.includes('prime?.()')) {
      this.primeCount += 1;
      this.status = { ...this.status, primed: true };
      return { ok: true, primed: true };
    }
    return undefined;
  }
}

const page = new FakePage();
const managedBrowser = {
  async currentPage() { return page; },
  async pages() { return [page]; },
  async pageInfo(target, pageId) { return { page_id: pageId, title: 'Fake Chat', url: target.url() }; },
};

const readCalls = [];
const sources = new Map([
  ['core.js', 'function createCore() { return { core: true }; }'],
  ['site.js', 'function createSiteAdapter() { return { site: true }; }'],
  ['agent.js', 'function agent(config, deps) { return { config, deps }; }'],
  ['fallback.js', 'function fallbackAgent(config) { return config; }'],
]);
const readFile = async (file, encoding) => {
  readCalls.push({ file, encoding });
  if (!sources.has(file)) throw new Error(`missing fake source: ${file}`);
  return sources.get(file);
};
const toolCalls = [];
const ids = ['suffix-1234567890', 'page-token'];
const host = createWebMcpPageHost({
  managedBrowser,
  listTools: async () => [
    { name: 'read_files', description: 'Read files', inputSchema: { type: 'object' }, ignored: true },
    { name: 'fallback_description', modelDescription: 'Fallback description' },
  ],
  callTool: async (name, args) => {
    toolCalls.push({ name, args });
    return { content: [{ type: 'data', bytes: new Uint8Array([1, 2, 3]) }], raw: new Uint8Array([4, 5]) };
  },
  fallbackAgentPath: 'fallback.js',
  sharedPageCorePath: 'core.js',
  sharedSiteAdaptersPath: 'site.js',
  sharedPageAgentPath: 'agent.js',
  readFile,
  newId: () => ids.shift(),
});

const factory = await host.getFactorySource();
assert.match(factory, /shunCodeWebMcpComposedAgent/);
assert.match(factory, /createCore/);
assert.match(factory, /createSiteAdapter/);
assert.match(factory, /return agent\(config, \{ createCore, createSiteAdapter \}\)/);
assert.equal(readCalls.length, 3);
assert.equal(await host.getFactorySource(), factory);
assert.equal(readCalls.length, 3, 'composed source must be cached');

const session = await host.ensure(page);
assert.equal(page.bindings.size, 2);
assert.equal(page.initScripts.length, 1);
assert.equal(page.injections.length, 1, 'live http page should receive immediate injection once');
assert.match(session.listBinding, /^__shuncodeListTools_/);
assert.match(session.invokeBinding, /^__shuncodeInvokeTool_/);
assert.match(session.expression, /page-token/);
assert.equal(await host.ensure(page), session, 'same page must reuse one binding/token session');
assert.equal(page.bindings.size, 2);
assert.equal(page.initScripts.length, 1);

const listBinding = page.bindings.get(session.listBinding);
await assert.rejects(() => listBinding({}, 'wrong-token'), /Invalid ShunCode page bridge token/);
assert.deepEqual(await listBinding({}, session.token), [
  { name: 'read_files', description: 'Read files', inputSchema: { type: 'object' } },
  { name: 'fallback_description', description: 'Fallback description', inputSchema: { type: 'object' } },
]);

const invokeBinding = page.bindings.get(session.invokeBinding);
await assert.rejects(() => invokeBinding({}, 'wrong-token', 'read_files', {}), /Invalid ShunCode page bridge token/);
const invoked = await invokeBinding({}, session.token, 'read_files', { path: 'README.md' });
assert.deepEqual(toolCalls, [{ name: 'read_files', args: { path: 'README.md' } }]);
assert.equal(invoked.raw, '[Uint8Array 2 bytes]');
assert.equal(invoked.content[0].bytes, '[Uint8Array 3 bytes]');

const connected = await host.connect({ prime: true });
assert.equal(connected.ok, true);
assert.equal(connected.page.page_id, 0);
assert.equal(connected.chatDetected, true);
assert.equal(connected.status.version, 25);
assert.equal(connected.status.primed, true);
assert.deepEqual(connected.primeResult, { ok: true, primed: true });
assert.equal(page.primeCount, 1);
await host.connect({ prime: true });
assert.equal(page.primeCount, 1, 'already-primed page must not be primed twice');

assert.deepEqual(serializeWebMcpPageValue({ bytes: new Uint8Array([9]) }), { bytes: '[Uint8Array 1 bytes]' });

const fallbackReads = [];
const fallbackHost = createWebMcpPageHost({
  managedBrowser,
  listTools: async () => [],
  callTool: async () => ({}),
  fallbackAgentPath: 'fallback.js',
  readFile: async (file, encoding) => {
    fallbackReads.push({ file, encoding });
    return sources.get(file);
  },
});
assert.equal(await fallbackHost.getFactorySource(), sources.get('fallback.js'));
assert.deepEqual(fallbackReads, [{ file: 'fallback.js', encoding: 'utf8' }]);

console.log('[smoke] WebMCP page host source/session/token/binding/prime/fallback contract ok');
