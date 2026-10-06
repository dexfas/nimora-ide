import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const extensionDirectory = path.join(root, 'extensions', 'shuncode-webmcp');
const operationSource = await fs.readFile(path.join(extensionDirectory, 'webmcp-internal-browser-operations.js'), 'utf8');
const extensionSource = await fs.readFile(path.join(extensionDirectory, 'extension.js'), 'utf8');
const adapterSource = await fs.readFile(path.join(root, 'src', 'vs', 'workbench', 'contrib', 'browserView', 'electron-browser', 'webMcpInternalBrowserOperations.ts'), 'utf8');
const runPlaywrightSource = await fs.readFile(path.join(root, 'src', 'vs', 'workbench', 'contrib', 'browserView', 'electron-browser', 'tools', 'runPlaywrightCodeTool.ts'), 'utf8');
const executeOperation = new Function(`return (${operationSource.trim()});`)();
const require = createRequire(path.join(root, 'package.json'));
const { invokeWithDeadline } = require(path.join(extensionDirectory, 'bounded-browser-tool.js'));
const esbuild = require(path.join(root, 'build', 'node_modules', 'esbuild', 'lib', 'main.js'));

class StorageFixture {
  values = new Map();
  writes = 0;
  seed(key, value) { this.values.set(String(key), String(value)); }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
  setItem(key, value) { this.writes += 1; this.values.set(String(key), String(value)); }
  removeItem(key) { this.writes += 1; this.values.delete(String(key)); }
}

function createFixture(href = 'https://chat.deepseek.com/a/chat/fixed-control', sessionId = 'session-control-A') {
  const url = new URL(href);
  const location = { href: url.href, origin: url.origin, hostname: url.hostname, pathname: url.pathname };
  const sessionStorage = new StorageFixture();
  sessionStorage.seed('shuncode-webmcp-page-session-id', sessionId);
  const state = {
    activeTurn: null,
    sendCount: 0,
    interruptCount: 0,
    resolveInvocationCount: 0,
    resolveSideEffectCount: 0,
    delivered: new Set(),
  };
  const snapshot = turn => ({ inputId: turn.inputId, state: turn.state, events: [] });
  const runtime = {
    version: 25,
    status: () => ({
      version: 25,
      enabled: true,
      composerFound: true,
      isDeepSeekAuthPage: false,
      pageSessionId: sessionId,
      workerTurn: state.activeTurn ? { inputId: state.activeTurn.inputId, state: state.activeTurn.state } : null,
    }),
    workerSession: () => ({ sessionId, site: url.hostname.endsWith('deepseek.com') ? 'deepseek' : 'generic', origin: location.origin, href: location.href, transport: 'test' }),
    workerSend: async input => {
      state.sendCount += 1;
      if (state.activeTurn?.state === 'running') throw new Error(`turn already running: ${state.activeTurn.inputId}`);
      state.activeTurn = { inputId: String(input.inputId), state: 'running' };
      return snapshot(state.activeTurn);
    },
    workerPoll: async inputId => {
      if (!state.activeTurn || state.activeTurn.inputId !== String(inputId)) throw new Error(`Unknown WebMCP worker turn: ${inputId}`);
      return snapshot(state.activeTurn);
    },
    workerInterrupt: async inputId => {
      if (!state.activeTurn || state.activeTurn.inputId !== String(inputId) || state.activeTurn.state !== 'running') return false;
      state.interruptCount += 1;
      state.activeTurn.state = 'cancelled';
      return true;
    },
    workerResolveCapability: async result => {
      state.resolveInvocationCount += 1;
      if (!state.activeTurn || state.activeTurn.inputId !== String(result.inputId) || state.activeTurn.state !== 'running') throw new Error(`Unknown WebMCP worker turn: ${result.inputId}`);
      const key = `${result.callId}\u0000${result.name}`;
      if (!state.delivered.has(key)) {
        state.delivered.add(key);
        state.resolveSideEffectCount += 1;
      }
      return snapshot(state.activeTurn);
    },
  };
  return { window: { __shuncodeWebMcp: runtime }, document: {}, location, sessionStorage, state, runtime, sessionId };
}

const syntheticSiteAdapterSource = `(function createFixedControlSiteAdapter() {
  return { id: location.hostname.endsWith('deepseek.com') ? 'deepseek' : 'generic' };
})`;

async function executeControl(env, control) {
  const names = ['window', 'document', 'location', 'sessionStorage'];
  const previous = new Map(names.map(name => [name, Object.prototype.hasOwnProperty.call(globalThis, name) ? globalThis[name] : undefined]));
  const had = new Map(names.map(name => [name, Object.prototype.hasOwnProperty.call(globalThis, name)]));
  Object.assign(globalThis, { window: env.window, document: env.document, location: env.location, sessionStorage: env.sessionStorage });
  try {
    return await executeOperation({
      ...env,
      operationId: 'control',
      input: { control },
      siteAdapterSource: syntheticSiteAdapterSource,
      pageCoreSource: '(function unusedCore() {})',
      agentBridgeSource: '(function unusedAgent() {})',
    });
  } finally {
    for (const name of names) {
      if (had.get(name)) globalThis[name] = previous.get(name);
      else delete globalThis[name];
    }
  }
}

function controlFor(env, action, extra = {}) {
  return {
    action,
    sessionId: env.sessionId,
    expectedOrigin: env.location.origin,
    expectedHref: env.location.href,
    expectedSite: env.location.hostname.endsWith('deepseek.com') ? 'deepseek' : 'generic',
    ...extra,
  };
}

const healthEnv = createFixture();
const health = await executeControl(healthEnv, controlFor(healthEnv, 'health'));
assert.equal(health.session.sessionId, healthEnv.sessionId);
assert.equal(health.status.enabled, true);
assert.equal(healthEnv.state.sendCount, 0);
assert.equal(healthEnv.state.interruptCount, 0);
assert.equal(healthEnv.state.resolveSideEffectCount, 0);
assert.equal(healthEnv.sessionStorage.writes, 0, 'health must be read-only');

const sendEnv = createFixture();
const sent = await executeControl(sendEnv, controlFor(sendEnv, 'send', { input: { inputId: 'turn-send-1', prompt: 'synthetic only' } }));
assert.equal(sent.inputId, 'turn-send-1');
assert.deepEqual(sent.controlLineage, {
  sessionId: sendEnv.sessionId,
  origin: sendEnv.location.origin,
  href: sendEnv.location.href,
  site: 'deepseek',
}, 'fixed send result must carry page-proven current session lineage');
assert.equal(sendEnv.state.sendCount, 1, 'fixed send must execute exactly once');

const sameOriginDriftEnv = createFixture('https://chat.deepseek.com/a/chat/s/DRIFTED-CONVERSATION');
await assert.rejects(
  () => executeControl(sameOriginDriftEnv, controlFor(sameOriginDriftEnv, 'send', {
    expectedHref: 'https://chat.deepseek.com/a/chat/s/ORIGINAL-CONVERSATION',
    input: { inputId: 'turn-href-drift', prompt: 'must not send' },
  })),
  /href lineage changed before send/,
);
assert.equal(sameOriginDriftEnv.state.sendCount, 0, 'same-origin pre-send href drift must execute workerSend zero times');
assert.equal(sameOriginDriftEnv.state.activeTurn, null, 'same-origin pre-send href drift must not create an admitted runtime turn');

const postAdmissionNavigationEnv = createFixture('https://chat.deepseek.com/a/chat/s/CONNECTED-CONVERSATION');
const connectedHref = postAdmissionNavigationEnv.location.href;
await executeControl(postAdmissionNavigationEnv, controlFor(postAdmissionNavigationEnv, 'send', {
  expectedHref: connectedHref,
  input: { inputId: 'turn-post-admission-nav', prompt: 'synthetic only' },
}));
postAdmissionNavigationEnv.location.href = 'https://chat.deepseek.com/a/chat/s/PROVIDER-TRANSITION';
postAdmissionNavigationEnv.location.pathname = '/a/chat/s/PROVIDER-TRANSITION';
const postNavigationPoll = await executeControl(postAdmissionNavigationEnv, controlFor(postAdmissionNavigationEnv, 'poll', {
  expectedHref: connectedHref,
  inputId: 'turn-post-admission-nav',
}));
assert.equal(postNavigationPoll.inputId, 'turn-post-admission-nav', 'post-admission provider navigation must remain routable by existing runtime lineage authority');
assert.equal(postNavigationPoll.controlLineage.href, 'https://chat.deepseek.com/a/chat/s/PROVIDER-TRANSITION', 'poll must return the page-proven evolved provider href');
const polled = await executeControl(sendEnv, controlFor(sendEnv, 'poll', { inputId: 'turn-send-1' }));
assert.equal(polled.inputId, 'turn-send-1');
await assert.rejects(() => executeControl(sendEnv, controlFor(sendEnv, 'poll', { inputId: 'wrong-turn' })), /Unknown WebMCP worker turn/);

const interruptBefore = sendEnv.state.interruptCount;
await assert.rejects(() => executeControl(sendEnv, controlFor(sendEnv, 'interrupt', { inputId: 'wrong-turn' })), /does not match the active turn/);
assert.equal(sendEnv.state.interruptCount, interruptBefore, 'wrong-turn interrupt must have zero side effect');
const interrupted = await executeControl(sendEnv, controlFor(sendEnv, 'interrupt', { inputId: 'turn-send-1' }));
assert.equal(interrupted.interrupted, true);
assert.equal(interrupted.turn.state, 'cancelled', 'interrupt control must await the async terminal poll snapshot');
assert.equal(sendEnv.state.interruptCount, interruptBefore + 1);

const resolveEnv = createFixture();
await executeControl(resolveEnv, controlFor(resolveEnv, 'send', { input: { inputId: 'turn-resolve-1', prompt: 'synthetic only' } }));
const capabilityResult = { inputId: 'turn-resolve-1', callId: 'call-1', name: 'read_files', text: 'ok' };
await executeControl(resolveEnv, controlFor(resolveEnv, 'resolve', { result: capabilityResult }));
await executeControl(resolveEnv, controlFor(resolveEnv, 'resolve', { result: capabilityResult }));
assert.equal(resolveEnv.state.resolveInvocationCount, 2, 'fixed control preserves runtime-level resolve dedupe semantics');
assert.equal(resolveEnv.state.resolveSideEffectCount, 1, 'duplicate resolve must not duplicate the synthetic delivery side effect');

const disconnectEnv = createFixture();
await executeControl(disconnectEnv, controlFor(disconnectEnv, 'send', { input: { inputId: 'turn-disconnect-1', prompt: 'synthetic only' } }));
const disconnected = await executeControl(disconnectEnv, controlFor(disconnectEnv, 'disconnect'));
assert.equal(disconnected.disconnected, true);
assert.equal(disconnectEnv.state.interruptCount, 1, 'disconnect must preserve running-turn interruption semantics');

const wrongSessionEnv = createFixture();
await assert.rejects(
  () => executeControl(wrongSessionEnv, { ...controlFor(wrongSessionEnv, 'health'), sessionId: 'wrong-session' }),
  /page session identity changed/,
);
assert.equal(wrongSessionEnv.state.sendCount, 0);

const storedMismatchEnv = createFixture();
storedMismatchEnv.sessionStorage.seed('shuncode-webmcp-page-session-id', 'different-session');
await assert.rejects(() => executeControl(storedMismatchEnv, controlFor(storedMismatchEnv, 'health')), /page session identity changed/);

const wrongSiteEnv = createFixture();
await assert.rejects(() => executeControl(wrongSiteEnv, { ...controlFor(wrongSiteEnv, 'health'), expectedSite: 'generic' }), /page lineage changed/);

const bypassEnv = createFixture('https://chatgpt.com/');
await assert.rejects(() => executeControl(bypassEnv, controlFor(bypassEnv, 'health')), /native-MCP bypass target/);

const unknownEnv = createFixture();
await assert.rejects(() => executeControl(unknownEnv, { ...controlFor(unknownEnv, 'health'), action: 'unknown' }), /Unsupported fixed WebMCP Worker control action/);

const controlStart = extensionSource.indexOf('async function controlWebMcpWorkerPage');
const controlEnd = extensionSource.indexOf('\nasync function stopCurrentWebMcpPage', controlStart);
assert.ok(controlStart >= 0 && controlEnd > controlStart);
const controlRoute = extensionSource.slice(controlStart, controlEnd);
assert.match(controlRoute, /runDeferredInternalBrowserOperation/);
assert.match(controlRoute, /operationId: 'control'/);
assert.match(controlRoute, /deferredInput: \{ control \}/);
assert.equal(controlRoute.includes('run_playwright_code'), false, 'post-connect Worker control must not use arbitrary-code LM tooling');
assert.equal(controlRoute.includes('invokeBuiltinBrowserTool'), false, 'post-connect Worker control must stay outside LanguageModelToolsService');
for (const command of ['workerSend', 'workerPoll', 'workerInterrupt', 'workerResolve', 'workerHealth', 'workerDisconnect']) {
  assert.match(extensionSource, new RegExp(`_shuncode\\.webMcp\\.${command}[^\\n]+controlWebMcpWorkerPage`));
}
assert.match(controlRoute, /if \(action === 'send'\) \{[\s\S]*ensureExactSharedBrowserPageVisible/);
assert.ok(
  controlRoute.indexOf('ensureExactSharedBrowserPageVisible') < controlRoute.indexOf("operationId: 'control'"),
  'host visibility convergence must happen before fixed WebMCP send control enters the provider runtime',
);

assert.match(runPlaywrightSource, /confirmationMessages:\s*\{/);
assert.match(runPlaywrightSource, /Run Playwright Code\?/);
assert.match(adapterSource, /type OperationId = 'listSharedPages' \| 'observe' \| 'chatgptObserveComposer' \| 'chatgptObserveProviderUsers' \| 'connect' \| 'control'/);
assert.match(adapterSource, /model\.sharingState !== BrowserViewSharingState\.Shared/);
assert.match(adapterSource, /playwrightService\.isPageTracked\(pageId\)/);
assert.match(adapterSource, /Browser page is a native-MCP bypass target/);
assert.match(adapterSource, /Deferred Worker control identity does not match the original page\/session\/control request/);
assert.match(adapterSource, /assertStructuredData\(control, 'Fixed Worker control payload'\)/);
assert.match(adapterSource, /'expectedOrigin', 'expectedHref', 'expectedSite'/);
assert.match(adapterSource, /const identity = JSON\.stringify\(control\)/);
const structuredDataStart = adapterSource.indexOf('function assertStructuredData');
const normalizeRequestStart = adapterSource.indexOf('\nfunction normalizeRequest', structuredDataStart);
assert.ok(structuredDataStart >= 0 && normalizeRequestStart > structuredDataStart);
const controlIdentityHarness = esbuild.transformSync(
  `${adapterSource.slice(structuredDataStart, normalizeRequestStart)}\nglobalThis.__nimoraControlIdentity = controlIdentity;`,
  { loader: 'ts', format: 'cjs', target: 'es2022' },
).code;
const productionControlIdentity = new Function(`${controlIdentityHarness}\nreturn globalThis.__nimoraControlIdentity;`)();
delete globalThis.__nimoraControlIdentity;
assert.equal(/assertOnlyKeys\(value[^\n]*(?:'code'|'script'|'expression'|'javascript'|'functionSource')/.test(adapterSource), false, 'fixed internal caller schema must expose no executable-source field');
assert.equal(/visibleEditors.*find|\.at\(-1\).*control|visible.*fallback/i.test(controlRoute), false, 'fixed control must expose no visible/last-page fallback');
assert.match(controlRoute, /expectedUrl: expectedHref/);

const originStart = extensionSource.indexOf('function browserPageOrigin');
const visibilityStart = extensionSource.indexOf('async function ensureExactSharedBrowserPageVisible');
const visibilityEnd = extensionSource.indexOf('\nasync function runDeferredInternalBrowserOperation', visibilityStart);
assert.ok(originStart >= 0 && visibilityStart > originStart && visibilityEnd > visibilityStart);
const originSource = extensionSource.slice(originStart, visibilityStart).trim();
const visibilitySource = extensionSource.slice(visibilityStart, visibilityEnd).trim();
const browserPageOrigin = new Function(`return (${originSource});`)();

async function runVisibilityScenario({ initialVisible = false, initialUrl = 'https://chat.deepseek.com/a/chat/s/r15', activation = 'success', afterUrl = '', expectedUrl = initialUrl, expectedOrigin = 'https://chat.deepseek.com', visibleAfterLists = 0, toastDrift = '', toastFailure = false } = {}) {
  const pageId = 'page-r15-exact';
  let current = { pageId, title: 'DeepSeek', url: initialUrl, visible: initialVisible };
  let listCount = 0;
  let activationCount = 0;
  let providerMutationCount = 0;
  const presentationCommands = [];
  const list = async () => {
    listCount += 1;
    if (activation === 'disappear' && activationCount > 0) return [];
    if (activation === 'delayed' && activationCount > 0 && listCount > visibleAfterLists) current = { ...current, visible: true, url: afterUrl || current.url };
    return [{ ...current }];
  };
  const activate = async (name, input) => {
    assert.equal(name, 'activate_browser_page');
    assert.deepEqual(input, { pageId });
    activationCount += 1;
    if (activation === 'fail') throw new Error('synthetic activation failed');
    if (!['disappear', 'delayed', 'toast', 'modal'].includes(activation)) current = { ...current, visible: true, url: afterUrl || current.url };
  };
  const ensureVisible = new Function(
    'listSharedBrowserPagesInternal',
    'invokeBuiltinBrowserTool',
    'browserPageOrigin',
    'WEB_MCP_EXACT_PAGE_VISIBILITY_TOTAL_MS',
    'WEB_MCP_EXACT_PAGE_VISIBILITY_POLL_MS',
    'vscode',
    `return (${visibilitySource});`,
  )(list, activate, browserPageOrigin, 300, 1, { commands: { async executeCommand(command) {
    assert.equal(command, 'notifications.hideToasts', 'presentation recovery cannot approve, share, navigate or send');
    presentationCommands.push(command);
    if (toastFailure) throw new Error('presentation command unavailable');
    if (activation === 'toast') current = { ...current, visible: true, url: toastDrift || current.url };
  } } });
  const invokeProviderMutation = async () => { providerMutationCount += 1; };
  const args = { pageId, expectedUrl, expectedOrigin, label: 'R15 test page' };
  return { ensureVisible, args, presentationCommands, stats: () => ({ listCount, activationCount, providerMutationCount }), invokeProviderMutation };
}

{
  const scenario = await runVisibilityScenario({ activation: 'toast' });
  const page = await scenario.ensureVisible(scenario.args);
  await scenario.invokeProviderMutation();
  assert.equal(page.visible, true);
  assert.deepEqual(scenario.presentationCommands, ['notifications.hideToasts']);
  assert.deepEqual(scenario.stats(), { listCount: 3, activationCount: 1, providerMutationCount: 1 }, 'native activation -> hide toast -> fresh exact visible observation -> one send');
}
{
  const scenario = await runVisibilityScenario({ activation: 'modal' });
  await assert.rejects(() => scenario.ensureVisible(scenario.args), /did not become visible/);
  assert.deepEqual(scenario.presentationCommands, ['notifications.hideToasts'], 'modal consent remains blocking after one toast-only presentation action');
  assert.equal(scenario.stats().providerMutationCount, 0);
  assert.equal(scenario.stats().activationCount, 1);
}
{
  const scenario = await runVisibilityScenario({ activation: 'toast', toastDrift: 'https://chat.deepseek.com/a/chat/s/drift' });
  await assert.rejects(() => scenario.ensureVisible(scenario.args), /URL changed during exact-page activation/);
  assert.equal(scenario.stats().providerMutationCount, 0);
}
{
  const scenario = await runVisibilityScenario({ activation: 'toast', toastFailure: true });
  await assert.rejects(() => scenario.ensureVisible(scenario.args), /presentation command unavailable/);
  assert.equal(scenario.stats().providerMutationCount, 0);
}

{
  const scenario = await runVisibilityScenario({ activation: 'delayed', visibleAfterLists: 3 });
  const page = await scenario.ensureVisible(scenario.args);
  await scenario.invokeProviderMutation();
  assert.equal(page.visible, true);
  assert.deepEqual(scenario.stats(), { listCount: 4, activationCount: 1, providerMutationCount: 1 }, 'exact page visibility may converge asynchronously after activation, but provider mutation waits for fresh exact-page truth');
}

{
  const scenario = await runVisibilityScenario();
  const page = await scenario.ensureVisible(scenario.args);
  await scenario.invokeProviderMutation();
  assert.equal(page.visible, true);
  assert.deepEqual(scenario.stats(), { listCount: 2, activationCount: 1, providerMutationCount: 1 }, 'hidden exact page must activate exactly once and fresh re-list before provider mutation');
}
{
  const scenario = await runVisibilityScenario({ initialVisible: true });
  const page = await scenario.ensureVisible(scenario.args);
  await scenario.invokeProviderMutation();
  assert.equal(page.visible, true);
  assert.deepEqual(scenario.stats(), { listCount: 1, activationCount: 0, providerMutationCount: 1 }, 'already-visible exact page must not activate');
}
{
  const scenario = await runVisibilityScenario({
    initialVisible: true,
    initialUrl: 'https://chat.deepseek.com/a/chat/s/DRIFTED-CONVERSATION',
    expectedUrl: 'https://chat.deepseek.com/a/chat/s/ORIGINAL-CONVERSATION',
  });
  await assert.rejects(() => scenario.ensureVisible(scenario.args), /URL changed before provider mutation/);
  assert.deepEqual(scenario.stats(), { listCount: 1, activationCount: 0, providerMutationCount: 0 }, 'already-visible same-origin href drift must fail before provider mutation');
}
{
  const scenario = await runVisibilityScenario({ activation: 'fail' });
  await assert.rejects(() => scenario.ensureVisible(scenario.args), /synthetic activation failed/);
  assert.deepEqual(scenario.stats(), { listCount: 1, activationCount: 1, providerMutationCount: 0 }, 'activation failure must fail before provider mutation');
}
{
  const scenario = await runVisibilityScenario({ activation: 'disappear' });
  await assert.rejects(() => scenario.ensureVisible(scenario.args), /disappeared during exact-page activation/);
  assert.deepEqual(scenario.stats(), { listCount: 2, activationCount: 1, providerMutationCount: 0 }, 'page disappearance during activation must fail before provider mutation');
}
{
  const scenario = await runVisibilityScenario({ afterUrl: 'https://chat.deepseek.com/a/chat/s/DRIFTED-CONVERSATION' });
  await assert.rejects(() => scenario.ensureVisible(scenario.args), /URL changed during exact-page activation/);
  assert.deepEqual(scenario.stats(), { listCount: 2, activationCount: 1, providerMutationCount: 0 }, 'URL drift during activation must fail before provider mutation');
}
{
  const scenario = await runVisibilityScenario({ expectedUrl: 'https://chat.deepseek.com/a/chat/s/other' });
  await assert.rejects(() => scenario.ensureVisible(scenario.args), /URL changed before provider mutation/);
  assert.deepEqual(scenario.stats(), { listCount: 1, activationCount: 0, providerMutationCount: 0 }, 'pre-activation lineage drift must fail before provider mutation');
}

const helperStart = extensionSource.indexOf('async function runDeferredInternalBrowserOperation');
const helperEnd = extensionSource.indexOf('\nasync function observeExactChatGptComposer', helperStart);
const helperSource = extensionSource.slice(helperStart, helperEnd);
assert.ok(helperStart >= 0 && helperEnd > helperStart);
const controlIdentity = controlFor(createFixture(), 'send', { input: { inputId: 'deferred-turn', prompt: 'synthetic only' } });
const changedHrefControlIdentity = { ...controlIdentity, expectedHref: 'https://chat.deepseek.com/a/chat/s/DEFERRED-DRIFT' };
assert.notEqual(productionControlIdentity(changedHrefControlIdentity), productionControlIdentity(controlIdentity), 'expectedHref must be part of the production deferred fixed-control identity');
let deferredHrefMismatchResumeCount = 0;
const originalControlIdentity = productionControlIdentity(controlIdentity);
const resumeDeferredControl = async resumedControl => {
  if (productionControlIdentity(resumedControl) !== originalControlIdentity) throw new Error('Deferred Worker control identity does not match the original page/session/control request.');
  deferredHrefMismatchResumeCount += 1;
};
await assert.rejects(() => resumeDeferredControl(changedHrefControlIdentity), /Deferred Worker control identity does not match/);
assert.equal(deferredHrefMismatchResumeCount, 0, 'changed expectedHref must reject before deferred continuation/result replay');
let deferredExecutions = 0;
const deferredCalls = [];
const deferredHelper = new Function('invokeInternalBrowserOperation', `return (${helperSource});`)(async request => {
  deferredCalls.push(structuredClone(request));
  if (!request.deferredResultId) {
    deferredExecutions += 1;
    return { deferredResultId: 'fixed-control-deferred-A' };
  }
  assert.equal(request.deferredResultId, 'fixed-control-deferred-A');
  assert.deepEqual(request.control, controlIdentity);
  return { result: { ok: true } };
});
const deferredCompleted = await deferredHelper({
  operationId: 'control',
  pageId: 'page-deferred-control',
  input: { control: controlIdentity },
  deferredInput: { control: controlIdentity },
  totalMs: 200,
  perAttemptMs: 50,
});
assert.equal(deferredCompleted.executionCount, 1);
assert.equal(deferredExecutions, 1, 'deferred continuation must not replay the original side effect');
assert.equal(deferredCalls.length, 2);

let changedDeferredCall = 0;
const changedDeferredHelper = new Function('invokeInternalBrowserOperation', `return (${helperSource});`)(async () => ({ deferredResultId: ++changedDeferredCall === 1 ? 'A' : 'B' }));
await assert.rejects(() => changedDeferredHelper({
  operationId: 'control', pageId: 'page-changed', input: { control: controlIdentity }, deferredInput: { control: controlIdentity }, totalMs: 100, perAttemptMs: 20,
}), /deferred identity changed from A to B/);

let uncertainExecutions = 0;
const uncertainHelper = new Function('invokeInternalBrowserOperation', `return (${helperSource});`)(async request => {
  if (!request.deferredResultId) uncertainExecutions += 1;
  throw new Error('WebMCP fixed control exceeded deadline (25ms).');
});
await assert.rejects(() => uncertainHelper({
  operationId: 'control', pageId: 'page-unknown', input: { control: controlIdentity }, deferredInput: { control: controlIdentity }, totalMs: 100, perAttemptMs: 20,
}), /exceeded deadline/);
assert.equal(uncertainExecutions, 1, 'UNKNOWN before deferred identity must not auto-replay the side effect');

const invokeStart = extensionSource.indexOf('async function invokeInternalBrowserOperation');
const invokeEnd = extensionSource.indexOf('\nasync function listSharedBrowserPagesInternal', invokeStart);
const invokeSource = extensionSource.slice(invokeStart, invokeEnd);
const neverSettlingVscode = { commands: { executeCommand: async () => await new Promise(() => {}) } };
const boundedInvoke = new Function('vscode', 'invokeWithDeadline', 'WEB_MCP_INTERNAL_BROWSER_COMMAND', `return (${invokeSource});`)(neverSettlingVscode, invokeWithDeadline, '_workbench.browser.webMcpInternalOperation');
const boundedHelper = new Function('invokeInternalBrowserOperation', `return (${helperSource});`)(boundedInvoke);
const boundedStartedAt = Date.now();
await assert.rejects(() => boundedHelper({
  operationId: 'control', pageId: 'page-stalled', input: { control: controlIdentity }, deferredInput: { control: controlIdentity }, totalMs: 30, perAttemptMs: 10,
}), /WebMCP fixed control exceeded deadline/);
assert.ok(Date.now() - boundedStartedAt < 1000, 'fixed control full request path must be bounded before Playwright execution settles');

assert.match(extensionSource, /_shuncode\.chatgptWorker\.send[^\n]+chatGptWorkerController\.control/);
assert.equal(controlRoute.includes('chatGptWorkerController'), false, 'WO#1G must not alter the ChatGPT route');

console.log(JSON.stringify({
  result: 'PASS',
  arbitraryRunPlaywrightConfirmationRetained: true,
  allSixControlsUseFixedInternalOperation: true,
  callerControlledExecutableSource: false,
  exactPageSharedTrackedGuardsPresent: true,
  hiddenExactPageActivationCount: 1,
  alreadyVisibleActivationCount: 0,
  sameOriginHrefDriftWorkerSendCount: sameOriginDriftEnv.state.sendCount,
  hiddenActivationHrefDriftProviderMutationCount: 0,
  deferredHrefMismatchResumeCount,
  postAdmissionProviderNavigationRoutable: true,
  activationFailureProviderMutationCount: 0,
  pageDisappearanceProviderMutationCount: 0,
  activationUrlDriftProviderMutationCount: 0,
  nativeMcpBypassGuardPresent: true,
  healthReadOnly: true,
  sendExactlyOnce: true,
  exactPollInput: true,
  wrongTurnInterruptSideEffects: 0,
  resolveDedupePreserved: true,
  disconnectRunningTurnSemanticsPreserved: true,
  deferredOriginalExecutionCount: deferredExecutions,
  changedDeferredIdentityRejected: true,
  unknownBeforeDeferredIdentityReplayCount: uncertainExecutions,
  fullPathTimeoutBounded: true,
  chatGptRouteUntouched: true,
}, null, 2));
