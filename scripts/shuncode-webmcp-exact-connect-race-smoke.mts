import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'package.json'));
const workerPageResources = require(path.join(root, 'extensions', 'shuncode-webmcp', 'worker-page-resources.js'));
const extensionSource = await fs.readFile(path.join(root, 'extensions', 'shuncode-webmcp', 'extension.js'), 'utf8');
const internalOperationSource = await fs.readFile(path.join(root, 'extensions', 'shuncode-webmcp', 'webmcp-internal-browser-operations.js'), 'utf8');
const executeInternalOperation = new Function(`return (${internalOperationSource.trim()});`)();

const functionStart = extensionSource.indexOf('async function connectWebMcpWorkerPage');
const functionEnd = extensionSource.indexOf('\nasync function controlWebMcpWorkerPage', functionStart);
assert.ok(functionStart >= 0 && functionEnd > functionStart, 'production connectWebMcpWorkerPage must be extractable');
const productionConnectSource = extensionSource.slice(functionStart, functionEnd);

function instantiateProductionConnect(dependencies) {
  const names = Object.keys(dependencies);
  const values = Object.values(dependencies);
  return new Function(...names, `return (${productionConnectSource});`)(...values);
}

class FakeStorage {
  #values = new Map();
  getItem(key) { return this.#values.has(String(key)) ? this.#values.get(String(key)) : null; }
  setItem(key, value) { this.#values.set(String(key), String(value)); }
  removeItem(key) { this.#values.delete(String(key)); }
}

class FakePage {
  constructor(href) {
    this.sessionStorage = new FakeStorage();
    this.window = { __injectionCount: 0, __primeCount: 0 };
    this.document = {};
    this.setHref(href);
  }

  setHref(href) {
    const url = new URL(href);
    if (!this.location) this.location = {};
    Object.assign(this.location, { href: url.href, origin: url.origin, hostname: url.hostname });
  }

  async evaluate(fn, payload) {
    const names = ['window', 'document', 'location', 'sessionStorage'];
    const previous = new Map(names.map(name => [name, Object.prototype.hasOwnProperty.call(globalThis, name) ? globalThis[name] : undefined]));
    const had = new Map(names.map(name => [name, Object.prototype.hasOwnProperty.call(globalThis, name)]));
    globalThis.window = this.window;
    globalThis.document = this.document;
    globalThis.location = this.location;
    globalThis.sessionStorage = this.sessionStorage;
    try {
      return await fn(payload);
    } finally {
      for (const name of names) {
        if (had.get(name)) globalThis[name] = previous.get(name);
        else delete globalThis[name];
      }
    }
  }
}

const syntheticSiteAdapterSource = `(function createSyntheticSiteAdapter() {
  return {
    id: String(document.__siteId || 'generic'),
    isDeepSeekAuthPage: document.__authPage === true,
    findComposer: () => document.__composerFound === false ? null : ({ ready: true }),
  };
})`;

const syntheticAgentSource = `(function syntheticExactTargetAgent() {
  window.__injectionCount = Number(window.__injectionCount || 0) + 1;
  let sessionId = sessionStorage.getItem('shuncode-webmcp-page-session-id') || String(window.__initialInjectedSessionId || '');
  if (!sessionId) {
    sessionId = 'synthetic-created-session';
  }
  sessionStorage.setItem('shuncode-webmcp-page-session-id', sessionId);
  window.__shuncodeWebMcp = {
    version: 25,
    prime: async () => {
      window.__primeCount = Number(window.__primeCount || 0) + 1;
      if (typeof window.__onPrime === 'function') await window.__onPrime();
      if (window.__primeSessionReplacement) {
        sessionId = String(window.__primeSessionReplacement);
        sessionStorage.setItem('shuncode-webmcp-page-session-id', sessionId);
      }
      return { ok: true };
    },
    workerSession: () => ({
      sessionId,
      site: String(document.__runtimeSite || document.__siteId || 'generic'),
      origin: String(document.__runtimeOrigin || location.origin),
      href: String(document.__runtimeHref || location.href),
      transport: 'test',
    }),
    status: () => ({
      version: 25,
      enabled: document.__runtimeEnabled !== false,
      pageSessionId: sessionId,
      workerTurn: document.__workerTurnState ? { state: document.__workerTurnState } : null,
    }),
  };
  return { version: 25, enabled: true, siteAdapter: 'generic', composerFound: true };
})`;

function observedTarget(pageId, href, pageSessionId = '') {
  const observation = workerPageResources.normalizeObservedResource(
    { pageId, title: 'Synthetic AI', url: href, visible: false },
    {
      href,
      origin: new URL(href).origin,
      site: 'generic',
      composerFound: true,
      isDeepSeekAuthPage: false,
      runtimeVersion: pageSessionId ? 25 : null,
      runtimeEnabled: !!pageSessionId,
      runtimePageSessionId: pageSessionId,
      storedPageSessionId: pageSessionId,
      workerTurnState: '',
    },
    false,
  );
  return {
    pageId,
    resourceIdentity: observation.resourceIdentity,
    origin: observation.origin,
    href: observation.href,
    site: observation.site,
    ...(pageSessionId ? { pageSessionId } : {}),
  };
}

function dependenciesFor(page, target, resolveExact, counters) {
  return {
    ensureWebMcpGateway: async () => undefined,
    resolveExactWebMcpWorkerPage: resolveExact,
    getOrShareCurrentBrowserPage: async () => { counters.fallback += 1; throw new Error('exact path must not use fallback'); },
    shouldBypassWebMcp: url => ['chatgpt.com', 'chat.openai.com'].includes(new URL(url).hostname.toLowerCase()),
    getArenaAgentSource: () => syntheticAgentSource,
    HOST: '127.0.0.1',
    PORT: 48322,
    WEB_MCP_PAGE_TOKEN: 'repair-smoke-token',
    workerPageResources,
    getWebMcpSiteAdapterSource: () => syntheticSiteAdapterSource,
    WEB_MCP_NATIVE_BYPASS_HOSTS: new Set(['chatgpt.com', 'chat.openai.com']),
    runDeferredInternalBrowserOperation: async request => {
      assert.equal(request.operationId, 'connect');
      counters.browser += 1;
      assert.equal(request.pageId, target.pageId);
      const result = await page.evaluate(payload => executeInternalOperation({
        ...payload,
        window,
        document,
        location,
        sessionStorage,
      }), {
        operationId: request.operationId,
        input: request.input,
        siteAdapterSource: syntheticSiteAdapterSource,
        pageCoreSource: '(function syntheticCore() {})',
        agentBridgeSource: syntheticAgentSource,
      });
      return { result, executionCount: 1 };
    },
    invokeBuiltinBrowserTool: async () => { throw new Error('exact path must not invoke run_playwright_code'); },
    playwrightResultValue: value => value,
  };
}

const cases = [];

// P7-WO2-R1(a): no prior page-session. The initial read-only authority sees A,
// then the same pageId navigates before the side-effecting browser call.
{
  const initialHref = 'https://example-ai.test/initial';
  const changedHref = 'https://example-ai.test/changed';
  const page = new FakePage(initialHref);
  const target = observedTarget('race-page-no-session', initialHref);
  const counters = { browser: 0, fallback: 0, resolve: 0 };
  const connect = instantiateProductionConnect(dependenciesFor(page, target, async exactTarget => {
    counters.resolve += 1;
    assert.equal(page.location.href, exactTarget.href);
    page.setHref(changedHref);
    return { page: { pageId: exactTarget.pageId, url: exactTarget.href } };
  }, counters));
  await assert.rejects(() => connect({ appendLine() {} }, { prime: true, target }), /identity changed before connect/);
  assert.equal(page.window.__injectionCount, 0, 'navigation drift must reject before injection');
  assert.equal(page.window.__primeCount, 0, 'navigation drift must reject before prime');
  assert.deepEqual(counters, { browser: 1, fallback: 0, resolve: 1 });
  cases.push('no-session-navigation-drift');
}

// P7-WO2-R1(b): an existing page-session is valid at observation time, then its
// generation changes before the side-effecting browser call.
{
  const href = 'https://example-ai.test/existing';
  const page = new FakePage(href);
  page.sessionStorage.setItem('shuncode-webmcp-page-session-id', 'session-old');
  page.window.__shuncodeWebMcp = {
    version: 25,
    status: () => ({ version: 25, enabled: true, pageSessionId: 'session-old', workerTurn: null }),
    workerSession: () => ({ sessionId: 'session-old', site: 'generic', origin: page.location.origin, href: page.location.href }),
  };
  const target = observedTarget('race-page-existing-session', href, 'session-old');
  const counters = { browser: 0, fallback: 0, resolve: 0 };
  const connect = instantiateProductionConnect(dependenciesFor(page, target, async exactTarget => {
    counters.resolve += 1;
    assert.equal(page.window.__shuncodeWebMcp.workerSession().sessionId, exactTarget.pageSessionId);
    page.sessionStorage.setItem('shuncode-webmcp-page-session-id', 'session-new');
    page.window.__shuncodeWebMcp = {
      version: 25,
      status: () => ({ version: 25, enabled: true, pageSessionId: 'session-new', workerTurn: null }),
      workerSession: () => ({ sessionId: 'session-new', site: 'generic', origin: page.location.origin, href: page.location.href }),
    };
    return { page: { pageId: exactTarget.pageId, url: exactTarget.href } };
  }, counters));
  await assert.rejects(() => connect({ appendLine() {} }, { prime: true, target }), /identity changed before connect/);
  assert.equal(page.window.__injectionCount, 0, 'session-generation drift must reject before reinjection');
  assert.equal(page.window.__primeCount, 0, 'session-generation drift must reject before prime');
  assert.deepEqual(counters, { browser: 1, fallback: 0, resolve: 1 });
  cases.push('existing-session-generation-drift');
}

// An unchanged exact target with no old page-session may create the first
// provider-native page-session, but only after the atomic identity check passes.
{
  const href = 'https://example-ai.test/stable';
  const page = new FakePage(href);
  const target = observedTarget('stable-page-no-session', href);
  const counters = { browser: 0, fallback: 0, resolve: 0 };
  const connect = instantiateProductionConnect(dependenciesFor(page, target, async exactTarget => {
    counters.resolve += 1;
    return { page: { pageId: exactTarget.pageId, url: exactTarget.href } };
  }, counters));
  const connected = await connect({ appendLine() {} }, { prime: true, target });
  assert.equal(connected.pageId, target.pageId);
  assert.equal(connected.sessionId, 'synthetic-created-session');
  assert.equal(page.window.__injectionCount, 1);
  assert.equal(page.window.__primeCount, 1);
  assert.deepEqual(counters, { browser: 1, fallback: 0, resolve: 1 });
  cases.push('stable-no-session-creates-after-check');
}

// P7-WO2-R2(A): after the exact pre-side-effect fence passes, provider-native
// conversation creation may evolve href on the same origin/site while keeping
// one self-consistent provider-native page-session generation.
{
  const initialHref = 'https://example-ai.test/text/direct?model=max';
  const evolvedHref = 'https://example-ai.test/c/provider-conversation';
  const page = new FakePage(initialHref);
  page.window.__onPrime = async () => page.setHref(evolvedHref);
  const target = observedTarget('post-prime-same-origin-evolution', initialHref);
  const counters = { browser: 0, fallback: 0, resolve: 0 };
  const connect = instantiateProductionConnect(dependenciesFor(page, target, async exactTarget => {
    counters.resolve += 1;
    return { page: { pageId: exactTarget.pageId, url: exactTarget.href } };
  }, counters));
  const connected = await connect({ appendLine() {} }, { prime: true, target });
  assert.equal(connected.pageId, target.pageId);
  assert.equal(connected.sessionId, 'synthetic-created-session');
  assert.equal(connected.href, evolvedHref);
  assert.equal(connected.origin, 'https://example-ai.test');
  assert.equal(page.window.__injectionCount, 1);
  assert.equal(page.window.__primeCount, 1);
  assert.deepEqual(counters, { browser: 1, fallback: 0, resolve: 1 });
  cases.push('post-prime-same-origin-href-evolution');
}

// P7-WO2-R2(B): a provider mutation that crosses origin is not same-resource
// session evolution and must fail closed.
{
  const href = 'https://example-ai.test/start';
  const page = new FakePage(href);
  page.window.__onPrime = async () => page.setHref('https://other-provider.test/conversation');
  const target = observedTarget('post-prime-cross-origin', href);
  const counters = { browser: 0, fallback: 0, resolve: 0 };
  const connect = instantiateProductionConnect(dependenciesFor(page, target, async exactTarget => {
    counters.resolve += 1;
    return { page: { pageId: exactTarget.pageId, url: exactTarget.href } };
  }, counters));
  await assert.rejects(() => connect({ appendLine() {} }, { prime: true, target }), /identity changed after connect began/);
  assert.equal(page.window.__injectionCount, 1);
  assert.equal(page.window.__primeCount, 1);
  assert.deepEqual(counters, { browser: 1, fallback: 0, resolve: 1 });
  cases.push('post-prime-cross-origin-rejected');
}

// P7-WO2-R2(C): a target with no prior page-session may establish one new
// generation during injection, but prime may not replace it with another.
{
  const href = 'https://example-ai.test/new-session';
  const page = new FakePage(href);
  page.window.__primeSessionReplacement = 'synthetic-replaced-session';
  const target = observedTarget('post-prime-generation-replacement', href);
  const counters = { browser: 0, fallback: 0, resolve: 0 };
  const connect = instantiateProductionConnect(dependenciesFor(page, target, async exactTarget => {
    counters.resolve += 1;
    return { page: { pageId: exactTarget.pageId, url: exactTarget.href } };
  }, counters));
  await assert.rejects(() => connect({ appendLine() {} }, { prime: true, target }), /session generation changed after injection/);
  assert.equal(page.window.__injectionCount, 1);
  assert.equal(page.window.__primeCount, 1);
  assert.deepEqual(counters, { browser: 1, fallback: 0, resolve: 1 });
  cases.push('post-prime-generation-replacement-rejected');
}

// P7-WO2-R2(D): when admission already has a provider-native page-session,
// injection/prime must preserve that exact generation.
{
  const href = 'https://example-ai.test/existing-stable';
  const page = new FakePage(href);
  page.sessionStorage.setItem('shuncode-webmcp-page-session-id', 'session-existing');
  page.window.__shuncodeWebMcp = {
    version: 25,
    status: () => ({ version: 25, enabled: true, pageSessionId: 'session-existing', workerTurn: null }),
    workerSession: () => ({ sessionId: 'session-existing', site: 'generic', origin: page.location.origin, href: page.location.href }),
  };
  const target = observedTarget('post-prime-existing-session-stable', href, 'session-existing');
  const counters = { browser: 0, fallback: 0, resolve: 0 };
  const connect = instantiateProductionConnect(dependenciesFor(page, target, async exactTarget => {
    counters.resolve += 1;
    return { page: { pageId: exactTarget.pageId, url: exactTarget.href } };
  }, counters));
  const connected = await connect({ appendLine() {} }, { prime: true, target });
  assert.equal(connected.sessionId, 'session-existing');
  assert.equal(connected.href, href);
  assert.equal(page.window.__injectionCount, 1);
  assert.equal(page.window.__primeCount, 1);
  assert.deepEqual(counters, { browser: 1, fallback: 0, resolve: 1 });
  cases.push('post-prime-existing-session-preserved');
}

// P7-WO2-R2(E): same-origin navigation is not sufficient. The evolved route
// must still classify as a ready, non-auth chat resource after prime.
{
  const href = 'https://example-ai.test/chat';
  const page = new FakePage(href);
  page.window.__onPrime = async () => {
    page.setHref('https://example-ai.test/auth');
    page.document.__authPage = true;
  };
  const target = observedTarget('post-prime-auth-route', href);
  const counters = { browser: 0, fallback: 0, resolve: 0 };
  const connect = instantiateProductionConnect(dependenciesFor(page, target, async exactTarget => {
    counters.resolve += 1;
    return { page: { pageId: exactTarget.pageId, url: exactTarget.href } };
  }, counters));
  await assert.rejects(() => connect({ appendLine() {} }, { prime: true, target }), /not ready after connect began/);
  assert.equal(page.window.__injectionCount, 1);
  assert.equal(page.window.__primeCount, 1);
  assert.deepEqual(counters, { browser: 1, fallback: 0, resolve: 1 });
  cases.push('post-prime-same-origin-auth-route-rejected');
}

console.log(JSON.stringify({
  result: 'PASS',
  productionConnectFunctionExercised: true,
  cases,
  navigationDriftInjectionCount: 0,
  navigationDriftPrimeCount: 0,
  sessionGenerationDriftInjectionCount: 0,
  sessionGenerationDriftPrimeCount: 0,
  fallbackSubstitution: false,
}, null, 2));
