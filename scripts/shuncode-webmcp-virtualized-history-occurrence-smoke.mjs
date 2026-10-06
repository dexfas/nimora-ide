import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gatewayDir = path.join(root, 'tools', 'webmcp-gateway');
const require = createRequire(path.join(gatewayDir, 'package.json'));
const { chromium } = require('playwright-core');
const webMcpDir = path.join(root, 'extensions', 'shuncode-webmcp');

const edgeCandidates = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
let edgePath = '';
for (const candidate of edgeCandidates) {
  try {
    await access(candidate);
    edgePath = candidate;
    break;
  } catch {}
}
assert.ok(edgePath, 'Microsoft Edge executable is required for the R12 virtualized-history occurrence smoke');

const [coreSource, siteSource, agentSource] = await Promise.all([
  readFile(path.join(webMcpDir, 'webmcp-page-core.js'), 'utf8'),
  readFile(path.join(webMcpDir, 'webmcp-site-adapters.js'), 'utf8'),
  readFile(path.join(webMcpDir, 'arena-agent-bridge.js'), 'utf8'),
]);

const createCore = vm.runInNewContext(coreSource.trim(), {}, { filename: 'webmcp-page-core.js' });
const parserCore = createCore();
const parserProbe = parserCore.extractCalls([
  '[SHUNCODE_TOOL]',
  'id=r12-parser-id',
  'name=read_files',
  'arg.files.0.path=README.md',
  '[/SHUNCODE_TOOL]',
].join('\n'));
assert.equal(parserProbe.length, 1, 'DeepSeek line protocol parser must remain unchanged');
assert.equal(parserProbe[0].id, 'r12-parser-id');

const composedSource = '(function shunCodeWebMcpComposedAgent(config) {\n'
  + '  const createCore = (' + coreSource.trim() + ');\n'
  + '  const createSiteAdapter = (' + siteSource.trim() + ');\n'
  + '  const agent = (' + agentSource.trim() + ');\n'
  + '  return agent(config, { createCore, createSiteAdapter });\n'
  + '})';

const html = [
  '<!doctype html>',
  '<html><body>',
  '<main id="messages"></main>',
  '<div id="composer-host"></div>',
  '<script>',
  'window.__submittedMessages = [];',
  'window.__nextDeepSeekUserVirtualKey = -1;',
  'window.__installComposer = () => {',
  '  const host = document.getElementById("composer-host");',
  '  host.textContent = "";',
  '  const form = document.createElement("form");',
  '  form.id = "composer-form";',
  '  const composer = document.createElement("textarea");',
  '  composer.setAttribute("aria-label", "Ask anything");',
  '  const send = document.createElement("button");',
  '  send.type = "submit"; send.setAttribute("aria-label", "Send"); send.textContent = "Send";',
  '  form.append(composer, send);',
  '  form.addEventListener("submit", event => {',
  '    event.preventDefault();',
  '    const text = composer.value;',
  '    window.__submittedMessages.push(text);',
  '    const item = document.createElement("div");',
  '    item.setAttribute("data-virtual-list-item-key", String(window.__nextDeepSeekUserVirtualKey--));',
  '    const message = document.createElement("div");',
  '    message.className = "user-message ds-message"; message.textContent = text;',
  '    item.appendChild(message);',
  '    document.getElementById("messages").appendChild(item);',
  '    composer.value = ""; composer.dispatchEvent(new Event("input", { bubbles: true }));',
  '  });',
  '  host.appendChild(form);',
  '};',
  'window.__installComposer();',
  '</script>',
  '</body></html>',
].join('');

const readTool = {
  name: 'read_files',
  description: 'Read files',
  inputSchema: {
    type: 'object',
    properties: { files: { type: 'array' } },
    required: ['files'],
    additionalProperties: false,
  },
};

function toolBlock(id, file = 'README.md') {
  return [
    '[SHUNCODE_TOOL]',
    'id=' + id,
    'name=read_files',
    'arg.files.0.path=' + file,
    '[/SHUNCODE_TOOL]',
  ].join('\n');
}

const hostManagedInput = inputId => ({
  inputId,
  prompt: 'Request read_files and wait for the host result.',
  allowedCapabilities: ['read_files'],
  externalCapabilities: [readTool],
  extensions: { hostManagedCapabilities: true },
});

async function appendVirtualAssistant(page, key, text, nodeId) {
  await page.evaluate(({ key, text, nodeId }) => {
    const item = document.createElement('div');
    item.setAttribute('data-virtual-list-item-key', String(key));
    if (nodeId) item.setAttribute('data-r12-node', nodeId);
    const response = document.createElement('div');
    response.className = 'ds-assistant-message-main-content';
    response.innerText = text;
    item.appendChild(response);
    document.getElementById('messages').appendChild(item);
  }, { key, text, nodeId });
}

async function appendVirtualNonAssistant(page, key, text, nodeId) {
  await page.evaluate(({ key, text, nodeId }) => {
    const item = document.createElement('div');
    item.setAttribute('data-virtual-list-item-key', String(key));
    if (nodeId) item.setAttribute('data-r12-node', nodeId);
    const message = document.createElement('div');
    message.className = 'd29f3d7d ds-message _63c77b1';
    message.innerText = text;
    item.appendChild(message);
    document.getElementById('messages').appendChild(item);
  }, { key, text, nodeId });
}

async function replaceVirtualAssistant(page, nodeId, key, text) {
  await page.evaluate(({ nodeId, key, text }) => {
    document.querySelector('[data-r12-node="' + nodeId + '"]')?.remove();
    const item = document.createElement('div');
    item.setAttribute('data-virtual-list-item-key', String(key));
    item.setAttribute('data-r12-node', nodeId);
    const response = document.createElement('div');
    response.className = 'ds-assistant-message-main-content';
    response.innerText = text;
    item.appendChild(response);
    document.getElementById('messages').appendChild(item);
  }, { nodeId, key, text });
}

async function removeNode(page, nodeId) {
  await page.evaluate(nodeId => document.querySelector('[data-r12-node="' + nodeId + '"]')?.remove(), nodeId);
}

async function pollUntilState(page, inputId, expectedState, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = null;
  while (Date.now() < deadline) {
    snapshot = await page.evaluate(id => window.__shuncodeWebMcp.workerPoll(id), inputId);
    if (snapshot.state === expectedState) return snapshot;
    await page.waitForTimeout(250);
  }
  throw new Error('Timed out waiting for ' + inputId + ' -> ' + expectedState + '; last=' + JSON.stringify(snapshot));
}

async function createDeepSeekHarness(browser, label, setup = async () => {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const listName = '__r12List_' + label;
  const invokeName = '__r12Invoke_' + label;
  let invokeCount = 0;
  await page.exposeFunction(listName, async () => [readTool]);
  await page.exposeFunction(invokeName, async (_token, name, args) => {
    invokeCount += 1;
    return { content: [{ type: 'text', text: 'LOCAL_' + name + '_' + String(args?.files?.[0]?.path || '') }] };
  });
  await page.route('https://chat.deepseek.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto('https://chat.deepseek.com/a/chat/' + label, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    window.MutationObserver = class SilentMutationObserver {
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  });
  await setup(page);
  const status = await page.evaluate(({ source, listName, invokeName, label }) => {
    const factory = (0, eval)(source);
    return factory({ token: 'r12-' + label, listBinding: listName, invokeBinding: invokeName });
  }, { source: composedSource, listName, invokeName, label });
  return {
    context,
    page,
    status,
    get invokeCount() { return invokeCount; },
  };
}

const browser = await chromium.launch({ executablePath: edgePath, headless: true });

try {
  const oldV2Keys = [
    'deliver-explicit-input-1::occurrence:1',
    'deliver-explicit-input-1::occurrence:2',
    'deliver-explicit-input-2::occurrence:1',
    'deliver-explicit-input-3::occurrence:1',
  ];

  const realKeyDomain = await createDeepSeekHarness(browser, 'r12-real-key-domain', async page => {
    await page.evaluate(({ oldV2Keys }) => {
      const storageKey = 'shuncode-webmcp-seen:' + location.origin + location.pathname;
      sessionStorage.setItem(storageKey, JSON.stringify(oldV2Keys));
    }, { oldV2Keys });
    await appendVirtualAssistant(page, 28, 'PRIOR_ASSISTANT_MESSAGE', 'real-28');
    await appendVirtualNonAssistant(page, -8, '# Nimora Explicit Coordinator Command\nCURRENT_USER_COORDINATOR_INPUT', 'real-negative-8');
    await appendVirtualAssistant(page, 30, toolBlock('deliver-explicit-input-1', 'historical-30.md'), 'real-30');
  });
  assert.equal(realKeyDomain.status.virtualizedOccurrenceIdentity, true);
  assert.equal(realKeyDomain.status.occurrenceScopedResultRouting, true);
  const realKeyStart = await realKeyDomain.page.evaluate(input => window.__shuncodeWebMcp.workerSend(input), hostManagedInput('r12-real-key-domain-turn'));
  assert.equal(realKeyStart.state, 'running', 'real 28/-8/30 mounted key family must not reject host-managed send merely because -8 exists');
  assert.equal(await realKeyDomain.page.evaluate(() => window.__submittedMessages.length), 1, 'synthetic host-managed send should pass the assistant-only pre-send boundary');
  await removeNode(realKeyDomain.page, 'real-negative-8');
  await appendVirtualNonAssistant(realKeyDomain.page, -8, toolBlock('negative-non-assistant-call', 'negative.md'), 'real-negative-8-reentry');
  const negativeReentry = await realKeyDomain.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-real-key-domain-turn'));
  assert.equal(negativeReentry.events.filter(event => event.type === 'capability_call').length, 0, 'negative-key non-assistant re-entry must never become a capability candidate');
  await appendVirtualAssistant(realKeyDomain.page, 31, toolBlock('deliver-explicit-input-1', 'new-31.md'), 'real-31');
  const realKeyNew = await realKeyDomain.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-real-key-domain-turn'));
  assert.equal(realKeyNew.events.filter(event => event.type === 'capability_call' && event.callId === 'deliver-explicit-input-1').length, 1, 'new assistant message after trusted assistant floor must be admitted exactly once');
  const realKeyCall = realKeyNew.events.find(event => event.type === 'capability_call' && event.callId === 'deliver-explicit-input-1');
  assert.ok(realKeyCall?.occurrenceId);
  assert.equal(await realKeyDomain.page.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 1);
  assert.equal(realKeyDomain.invokeCount, 0);
  await realKeyDomain.page.evaluate(async occurrenceId => await window.__shuncodeWebMcp.workerResolveCapability({
    inputId: 'r12-real-key-domain-turn',
    callId: 'deliver-explicit-input-1',
    name: 'read_files',
    text: 'R12_REAL_KEY_DOMAIN_OK',
    isError: false,
    extensions: { occurrenceId },
  }), realKeyCall.occurrenceId);
  await replaceVirtualAssistant(realKeyDomain.page, 'real-31', 31, toolBlock('deliver-explicit-input-1', 'new-31.md'));
  const realKeyRerender = await realKeyDomain.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-real-key-domain-turn'));
  assert.equal(realKeyRerender.events.filter(event => event.type === 'capability_call' && event.callId === 'deliver-explicit-input-1').length, 1, 'same logical assistant message rerender must not replay');
  await removeNode(realKeyDomain.page, 'real-30');
  await appendVirtualAssistant(realKeyDomain.page, 30, toolBlock('deliver-explicit-input-1', 'historical-30.md'), 'real-30-reentry');
  const realHistoricalReentry = await realKeyDomain.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-real-key-domain-turn'));
  assert.equal(realHistoricalReentry.events.filter(event => event.type === 'capability_call' && event.callId === 'deliver-explicit-input-1').length, 1, 'historical assistant item at/below trusted floor must not replay after virtualization re-entry');
  await realKeyDomain.context.close();

  const responseVirtualizationGuard = await createDeepSeekHarness(browser, 'r12-response-virtualization-guard', async page => {
    await appendVirtualAssistant(page, 40, 'HISTORICAL_RESPONSE_A', 'response-history-a');
    await appendVirtualAssistant(page, 41, 'HISTORICAL_RESPONSE_B', 'response-history-b');
  });
  const responseVirtualizationStart = await responseVirtualizationGuard.page.evaluate(
    input => window.__shuncodeWebMcp.workerSend(input),
    hostManagedInput('r12-response-virtualization-guard-turn'),
  );
  assert.equal(responseVirtualizationStart.state, 'running');
  await removeNode(responseVirtualizationGuard.page, 'response-history-b');
  const responseVirtualizationFirstPoll = await responseVirtualizationGuard.page.evaluate(
    () => window.__shuncodeWebMcp.workerPoll('r12-response-virtualization-guard-turn'),
  );
  assert.equal(
    responseVirtualizationFirstPoll.events.filter(event => event.type === 'assistant_text').length,
    0,
    'virtual-list eviction of a historical assistant must not synthesize current-turn assistant text',
  );
  await responseVirtualizationGuard.page.waitForTimeout(1400);
  const responseVirtualizationStablePoll = await responseVirtualizationGuard.page.evaluate(
    () => window.__shuncodeWebMcp.workerPoll('r12-response-virtualization-guard-turn'),
  );
  assert.equal(
    responseVirtualizationStablePoll.state,
    'running',
    'historical assistant eviction must not falsely complete a turn that has no post-floor assistant occurrence',
  );
  await responseVirtualizationGuard.context.close();

  const main = await createDeepSeekHarness(browser, 'r12-main', async page => {
    await page.evaluate(({ oldV2Keys }) => {
      const storageKey = 'shuncode-webmcp-seen:' + location.origin + location.pathname;
      sessionStorage.setItem(storageKey, JSON.stringify(oldV2Keys));
      const item = document.createElement('div');
      item.setAttribute('data-virtual-list-item-key', '20');
      const response = document.createElement('div');
      response.className = 'ds-assistant-message-main-content';
      response.innerText = 'HISTORICAL_BASELINE';
      item.appendChild(response);
      document.getElementById('messages').appendChild(item);
    }, { oldV2Keys });
  });

  assert.equal(main.status.virtualizedOccurrenceIdentity, true);
  assert.equal(main.status.runningTurnPollScan, true);
  assert.equal(main.status.occurrenceScopedResultRouting, true);

  const adapterIdentity = await main.page.evaluate(() => {
    const baseline = document.querySelector('[data-virtual-list-item-key="20"] .ds-assistant-message-main-content');
    const runtime = window.__shuncodeWebMcp;
    return {
      marker: runtime.status().virtualizedOccurrenceIdentity,
      baselineKey: baseline?.closest('[data-virtual-list-item-key]')?.getAttribute('data-virtual-list-item-key'),
    };
  });
  assert.equal(adapterIdentity.marker, true);
  assert.equal(adapterIdentity.baselineKey, '20');

  const started = await main.page.evaluate(input => window.__shuncodeWebMcp.workerSend(input), hostManagedInput('r12-main-turn'));
  assert.equal(started.state, 'running');
  await assert.rejects(
    () => main.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('wrong-r12-input')),
    /Unknown WebMCP worker turn/,
  );

  await appendVirtualAssistant(main.page, 21, toolBlock('deliver-explicit-input-1', 'first.md'), 'new-a');
  const first = await main.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-main-turn'));
  assert.equal(first.toolCallCount, 1, 'old v2 ordinal history must not suppress a new stable-message occurrence');
  assert.equal(main.invokeCount, 0, 'host-managed stable occurrence must never invoke page-local tools');
  assert.equal(await main.page.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 1);
  const firstCall = first.events.find(event => event.type === 'capability_call');
  assert.equal(firstCall.callId, 'deliver-explicit-input-1');
  assert.equal(firstCall.dispatch, 'host-requested');
  assert.ok(firstCall.occurrenceId);
  const firstHandledKey = await main.page.evaluate(() => window.__shuncodeWebMcp.status().lastHandledCallKey);
  assert.match(firstHandledKey, /deepseek-message:deepseek-item%3A21::call:1::provider:deliver-explicit-input-1/);

  const overlap = await main.page.evaluate(async () => await Promise.all(
    Array.from({ length: 8 }, () => window.__shuncodeWebMcp.workerPoll('r12-main-turn')),
  ));
  assert.equal(overlap.at(-1).events.filter(event => event.type === 'capability_call').length, 1, 'overlapping polls must not duplicate the stable occurrence');

  await main.page.evaluate(async occurrenceId => await window.__shuncodeWebMcp.workerResolveCapability({
    inputId: 'r12-main-turn',
    callId: 'deliver-explicit-input-1',
    name: 'read_files',
    text: 'R12_FIRST_OK',
    isError: false,
    extensions: { occurrenceId },
  }), firstCall.occurrenceId);
  assert.equal(await main.page.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 0);
  const resolvedFirst = await main.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-main-turn'));
  assert.equal(resolvedFirst.events.filter(event => event.type === 'capability_result' && event.callId === 'deliver-explicit-input-1').length, 1);

  await replaceVirtualAssistant(main.page, 'new-a', 21, toolBlock('deliver-explicit-input-1', 'first.md'));
  const rerendered = await main.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-main-turn'));
  assert.equal(rerendered.events.filter(event => event.type === 'capability_call').length, 1, 'same logical message rerender must not re-admit');

  await removeNode(main.page, 'new-a');
  await appendVirtualAssistant(main.page, 22, toolBlock('deliver-explicit-input-1', 'second.md'), 'new-b');
  const second = await main.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-main-turn'));
  assert.equal(second.events.filter(event => event.type === 'capability_call' && event.callId === 'deliver-explicit-input-1').length, 2, 'different logical message may reuse provider callId exactly once');
  const secondCall = second.events.filter(event => event.type === 'capability_call' && event.callId === 'deliver-explicit-input-1').at(-1);
  assert.ok(secondCall?.occurrenceId);
  assert.notEqual(secondCall.occurrenceId, firstCall.occurrenceId);
  assert.equal(await main.page.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 1);
  await main.page.evaluate(async occurrenceId => await window.__shuncodeWebMcp.workerResolveCapability({
    inputId: 'r12-main-turn',
    callId: 'deliver-explicit-input-1',
    name: 'read_files',
    text: 'R12_SECOND_OK',
    isError: false,
    extensions: { occurrenceId },
  }), secondCall.occurrenceId);

  await removeNode(main.page, 'new-b');
  await appendVirtualAssistant(main.page, 21, toolBlock('deliver-explicit-input-1', 'first.md'), 'historical-a-reentry');
  const reentered = await main.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-main-turn'));
  assert.equal(reentered.events.filter(event => event.type === 'capability_call').length, 2, 'historical stable message re-entry must not replay');

  await appendVirtualAssistant(main.page, 10, toolBlock('historical-virtualized', 'old.md'), 'historical-pre-floor');
  const preFloor = await main.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-main-turn'));
  assert.equal(preFloor.events.filter(event => event.type === 'capability_call').length, 2, 'historical virtualized item below send floor must never enter the current turn');

  const multiText = toolBlock('multi-shared-id', 'multi-a.md') + '\n' + toolBlock('multi-shared-id', 'multi-b.md');
  await appendVirtualAssistant(main.page, 23, multiText, 'multi');
  const multiOne = await main.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-main-turn'));
  assert.equal(multiOne.events.filter(event => event.type === 'capability_call' && event.callId === 'multi-shared-id').length, 1);
  const multiCallOne = multiOne.events.find(event => event.type === 'capability_call' && event.callId === 'multi-shared-id');
  assert.ok(multiCallOne?.occurrenceId);
  const multiKeyOne = await main.page.evaluate(() => window.__shuncodeWebMcp.status().lastHandledCallKey);
  assert.match(multiKeyOne, /::call:1::provider:multi-shared-id$/);
  await main.page.evaluate(async occurrenceId => await window.__shuncodeWebMcp.workerResolveCapability({
    inputId: 'r12-main-turn',
    callId: 'multi-shared-id',
    name: 'read_files',
    text: 'R12_MULTI_1',
    isError: false,
    extensions: { occurrenceId },
  }), multiCallOne.occurrenceId);
  const multiTwo = await main.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-main-turn'));
  assert.equal(multiTwo.events.filter(event => event.type === 'capability_call' && event.callId === 'multi-shared-id').length, 2);
  const multiCallTwo = multiTwo.events.filter(event => event.type === 'capability_call' && event.callId === 'multi-shared-id').at(-1);
  assert.ok(multiCallTwo?.occurrenceId);
  assert.notEqual(multiCallTwo.occurrenceId, multiCallOne.occurrenceId);
  const multiKeyTwo = await main.page.evaluate(() => window.__shuncodeWebMcp.status().lastHandledCallKey);
  assert.match(multiKeyTwo, /::call:2::provider:multi-shared-id$/);
  assert.notEqual(multiKeyOne, multiKeyTwo, 'call position inside one logical message must contribute to internal occurrence identity');
  await main.page.evaluate(async occurrenceId => await window.__shuncodeWebMcp.workerResolveCapability({
    inputId: 'r12-main-turn',
    callId: 'multi-shared-id',
    name: 'read_files',
    text: 'R12_MULTI_2',
    isError: false,
    extensions: { occurrenceId },
  }), multiCallTwo.occurrenceId);

  await main.page.evaluate(text => {
    const response = document.createElement('div');
    response.className = 'ds-assistant-message-main-content';
    response.setAttribute('data-r12-node', 'missing-identity');
    response.innerText = text;
    document.getElementById('messages').appendChild(response);
  }, toolBlock('missing-identity', 'missing.md'));
  const missingIdentity = await main.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-main-turn'));
  assert.equal(missingIdentity.events.filter(event => event.type === 'capability_call' && event.callId === 'missing-identity').length, 0);
  assert.match(await main.page.evaluate(() => window.__shuncodeWebMcp.status().lastOccurrenceIdentityError), /lacks one exact stable/);
  await main.page.evaluate(() => document.querySelector('[data-r12-node="missing-identity"]')?.remove());

  await main.page.evaluate(text => {
    const outer = document.createElement('div');
    outer.setAttribute('data-virtual-list-item-key', '24');
    outer.setAttribute('data-r12-node', 'ambiguous-identity');
    const inner = document.createElement('div');
    inner.setAttribute('data-virtual-list-item-key', '25');
    const response = document.createElement('div');
    response.className = 'ds-assistant-message-main-content';
    response.innerText = text;
    inner.appendChild(response);
    outer.appendChild(inner);
    document.getElementById('messages').appendChild(outer);
  }, toolBlock('ambiguous-identity', 'ambiguous.md'));
  const ambiguousIdentity = await main.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-main-turn'));
  assert.equal(ambiguousIdentity.events.filter(event => event.type === 'capability_call' && event.callId === 'ambiguous-identity').length, 0);
  await main.page.evaluate(() => document.querySelector('[data-r12-node="ambiguous-identity"]')?.remove());

  const persistedSeen = await main.page.evaluate(() => JSON.parse(sessionStorage.getItem('shuncode-webmcp-seen:' + location.origin + location.pathname) || '[]'));
  for (const oldKey of oldV2Keys) assert.ok(persistedSeen.includes(oldKey), 'old v2 replay history must be retained: ' + oldKey);
  assert.ok(persistedSeen.some(key => key.includes('deepseek-message:deepseek-item%3A21')), 'new stable identity must coexist with old v2 history');

  await appendVirtualAssistant(main.page, 26, 'R12_MAIN_FINAL', 'final');
  await main.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-main-turn'));
  const completed = await pollUntilState(main.page, 'r12-main-turn', 'completed');
  assert.equal(completed.state, 'completed');
  const completedCalls = completed.events.filter(event => event.type === 'capability_call').length;
  await appendVirtualAssistant(main.page, 27, toolBlock('completed-late', 'late.md'), 'completed-late');
  const completedLate = await main.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-main-turn'));
  assert.equal(completedLate.events.filter(event => event.type === 'capability_call').length, completedCalls, 'completed turn must fence late admission');

  const cancelStart = await main.page.evaluate(input => window.__shuncodeWebMcp.workerSend(input), hostManagedInput('r12-cancel-turn'));
  assert.equal(cancelStart.state, 'running');
  await appendVirtualAssistant(main.page, 28, toolBlock('cancel-live', 'cancel.md'), 'cancel-live');
  const cancelLive = await main.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-cancel-turn'));
  assert.equal(cancelLive.events.filter(event => event.type === 'capability_call').length, 1);
  await main.page.evaluate(() => {
    const stop = document.createElement('button');
    stop.id = 'r12-stop';
    stop.setAttribute('aria-label', 'Stop generating');
    stop.textContent = 'Stop';
    document.body.appendChild(stop);
  });
  assert.equal(await main.page.evaluate(() => window.__shuncodeWebMcp.workerInterrupt('r12-cancel-turn')), true);
  assert.equal(await main.page.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 0);
  await appendVirtualAssistant(main.page, 29, toolBlock('cancel-late', 'late.md'), 'cancel-late');
  const cancelled = await main.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-cancel-turn'));
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.events.filter(event => event.type === 'capability_call').length, 1, 'cancelled turn must fence late admission');
  await main.page.evaluate(() => document.getElementById('r12-stop')?.remove());

  await main.page.evaluate(() => document.getElementById('composer-form')?.remove());
  await assert.rejects(
    () => main.page.evaluate(input => window.__shuncodeWebMcp.workerSend(input), hostManagedInput('r12-error-turn')),
    /No compatible chat input found/,
  );
  await main.page.evaluate(() => window.__installComposer());
  await appendVirtualAssistant(main.page, 30, toolBlock('error-late', 'late.md'), 'error-late');
  const errored = await main.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-error-turn'));
  assert.equal(errored.state, 'error');
  assert.equal(errored.events.filter(event => event.type === 'capability_call').length, 0, 'error turn must fence late admission');
  await main.context.close();

  const visibleHistory = await createDeepSeekHarness(browser, 'r12-visible-history', async page => {
    await appendVirtualAssistant(page, 5, toolBlock('historical-visible', 'history.md'), 'visible-history');
  });
  await visibleHistory.page.waitForTimeout(100);
  assert.equal(visibleHistory.invokeCount, 0, 'historical visible call at repaired runtime injection must not replay');
  const visibleSeen = await visibleHistory.page.evaluate(() => window.__shuncodeWebMcp.status().seen);
  assert.ok(visibleSeen >= 1, 'historical visible stable occurrence must be seeded into replay protection');
  await visibleHistory.context.close();

  const invalidBoundary = await createDeepSeekHarness(browser, 'r12-invalid-boundary', async page => {
    await page.evaluate(() => {
      const item = document.createElement('div');
      item.setAttribute('data-virtual-list-item-key', 'not-a-number');
      const response = document.createElement('div');
      response.className = 'ds-assistant-message-main-content';
      response.textContent = 'INVALID_ASSISTANT_BOUNDARY';
      item.appendChild(response);
      document.getElementById('messages').appendChild(item);
    });
  });
  await assert.rejects(
    () => invalidBoundary.page.evaluate(input => window.__shuncodeWebMcp.workerSend(input), hostManagedInput('r12-invalid-boundary-turn')),
    /trustworthy numeric virtual-list boundary/,
  );
  await invalidBoundary.context.close();

  const negativeAssistantBoundary = await createDeepSeekHarness(browser, 'r12-negative-assistant-boundary', async page => {
    await appendVirtualAssistant(page, -7, 'NEGATIVE_ASSISTANT_ORDER_IS_NOT_TRUSTED', 'negative-assistant');
  });
  await assert.rejects(
    () => negativeAssistantBoundary.page.evaluate(input => window.__shuncodeWebMcp.workerSend(input), hostManagedInput('r12-negative-assistant-boundary-turn')),
    /trustworthy numeric virtual-list boundary/,
  );
  await negativeAssistantBoundary.context.close();

  const genericContext = await browser.newContext();
  const genericPage = await genericContext.newPage();
  let genericInvokeCount = 0;
  await genericPage.exposeFunction('__r12GenericList', async () => [readTool]);
  await genericPage.exposeFunction('__r12GenericInvoke', async () => {
    genericInvokeCount += 1;
    return { content: [{ type: 'text', text: 'GENERIC_OK' }] };
  });
  await genericPage.route('https://example.ai/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await genericPage.goto('https://example.ai/chat', { waitUntil: 'domcontentloaded' });
  await genericPage.evaluate(({ source }) => {
    const factory = (0, eval)(source);
    factory({ token: 'generic-token', listBinding: '__r12GenericList', invokeBinding: '__r12GenericInvoke' });
  }, { source: composedSource });
  await genericPage.evaluate(() => window.__shuncodeWebMcp.workerSend({ inputId: 'generic-turn', prompt: 'Use read_files twice.' }));
  await genericPage.evaluate(text => {
    for (let i = 0; i < 2; i += 1) {
      const response = document.createElement('div');
      response.className = 'assistant-message';
      response.innerText = text;
      document.getElementById('messages').appendChild(response);
    }
  }, toolBlock('generic-repeat', 'generic.md'));
  await genericPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('generic-turn'));
  await genericPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('generic-turn'));
  assert.equal(genericInvokeCount, 2, 'generic/non-DeepSeek current-DOM occurrence behavior must remain unchanged');
  await genericContext.close();

  console.log(JSON.stringify({
    result: 'PASS',
    marker: 'virtualizedOccurrenceIdentity',
    occurrenceScopedResultRouting: true,
    realKeyDomainMounted: ['28', '-8', '30'],
    negativeNonAssistantDoesNotPoisonBoundary: true,
    realKeyDomainNewAssistantAdmission: 1,
    negativeNonAssistantReentryAdmission: 0,
    negativeAssistantOrderingFailClosed: true,
    oldV2SameIdSuppression: false,
    newSameIdAfterVirtualizationAdmissions: 2,
    sameLogicalRerenderReplay: 0,
    historicalReentryReplay: 0,
    historicalPreSendReplay: 0,
    multiCallStableMessageDistinct: true,
    hostManagedPageLocalInvoke: 0,
    providerCallIdResultRoutingRetained: true,
    oldV2HistoryRetained: true,
    visibleHistoricalReplayAfterInjection: 0,
    missingStableIdentityFailClosed: true,
    ambiguousStableIdentityFailClosed: true,
    wrongInputLateAdmission: 0,
    completedLateAdmission: 0,
    cancelledLateAdmission: 0,
    errorLateAdmission: 0,
    overlappingPollDuplicateAdmission: 0,
    genericBehaviorRetained: true,
    deepSeekLineProtocolRetained: true,
  }, null, 2));
} finally {
  await browser.close();
}
