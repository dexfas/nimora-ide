import assert from 'node:assert/strict';
import { access, readFile, rm, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const buildRequire = createRequire(path.join(root, 'build', 'package.json'));
const gatewayRequire = createRequire(path.join(root, 'tools', 'webmcp-gateway', 'package.json'));
const esbuild = buildRequire('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const { chromium } = gatewayRequire('playwright-core');

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
assert.ok(edgePath, 'Microsoft Edge executable is required for the R12 occurrence-result-routing smoke');

const bundleDirectory = await mkdtemp(path.join(os.tmpdir(), 'nimora-r12-result-routing-'));
const bundlePath = path.join(bundleDirectory, 'stack.cjs');
await esbuild.build({
  stdin: {
    contents: `
      export { WebMcpCommandTransport } from ${JSON.stringify(path.join(root, 'extensions', 'shuncode', 'src', 'webmcp-worker-transport.ts'))};
      export { WebWorkerAdapter } from ${JSON.stringify(path.join(root, 'src', 'web-worker-adapter.ts'))};
      export { WorkerSessionManager } from ${JSON.stringify(path.join(root, 'src', 'worker-session-manager.ts'))};
      export { HostCapabilityExecutionCoordinator } from ${JSON.stringify(path.join(root, 'src', 'host-capability-execution-coordinator.ts'))};
    `,
    resolveDir: root,
    sourcefile: 'r12-result-routing-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});
const {
  WebMcpCommandTransport,
  WebWorkerAdapter,
  WorkerSessionManager,
  HostCapabilityExecutionCoordinator,
} = buildRequire(bundlePath);

const webMcpDir = path.join(root, 'extensions', 'shuncode-webmcp');
const [coreSource, siteSource, agentSource] = await Promise.all([
  readFile(path.join(webMcpDir, 'webmcp-page-core.js'), 'utf8'),
  readFile(path.join(webMcpDir, 'webmcp-site-adapters.js'), 'utf8'),
  readFile(path.join(webMcpDir, 'arena-agent-bridge.js'), 'utf8'),
]);
const composedSource = '(function shunCodeWebMcpComposedAgent(config) {\n'
  + '  const createCore = (' + coreSource.trim() + ');\n'
  + '  const createSiteAdapter = (' + siteSource.trim() + ');\n'
  + '  const agent = (' + agentSource.trim() + ');\n'
  + '  return agent(config, { createCore, createSiteAdapter });\n'
  + '})';

const html = [
  '<!doctype html><html><body>',
  '<main id="messages"></main>',
  '<form id="composer-form">',
  '<textarea aria-label="Ask anything"></textarea>',
  '<button type="submit" aria-label="Send">Send</button>',
  '</form>',
  '<script>',
  'window.__submittedMessages = [];',
  'window.__nextDeepSeekUserVirtualKey = -1;',
  'const form = document.getElementById("composer-form");',
  'const composer = form.querySelector("textarea");',
  'form.addEventListener("submit", event => {',
  '  event.preventDefault();',
  '  const text = composer.value;',
  '  window.__submittedMessages.push(text);',
  '  const item = document.createElement("div");',
  '  item.setAttribute("data-virtual-list-item-key", String(window.__nextDeepSeekUserVirtualKey--));',
  '  const message = document.createElement("div");',
  '  message.className = "user-message ds-message";',
  '  message.textContent = text;',
  '  item.appendChild(message);',
  '  document.getElementById("messages").appendChild(item);',
  '  composer.value = "";',
  '  composer.dispatchEvent(new Event("input", { bubbles: true }));',
  '});',
  '</script>',
  '</body></html>',
].join('');

const readTool = {
  name: 'read_files',
  description: 'Read exact workspace files.',
  inputSchema: {
    type: 'object',
    properties: { files: { type: 'array' } },
    required: ['files'],
    additionalProperties: false,
  },
};

function toolBlock(id, file) {
  return [
    '[SHUNCODE_TOOL]',
    'id=' + id,
    'name=read_files',
    'arg.files.0.path=' + file,
    '[/SHUNCODE_TOOL]',
  ].join('\n');
}

async function appendAssistant(page, key, text) {
  await page.evaluate(({ key, text }) => {
    const item = document.createElement('div');
    item.setAttribute('data-virtual-list-item-key', String(key));
    const response = document.createElement('div');
    response.className = 'ds-assistant-message-main-content';
    response.innerText = text;
    item.appendChild(response);
    document.getElementById('messages').appendChild(item);
  }, { key, text });
}

async function nextMatching(iterator, predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const next = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timed out waiting for ' + label)), remaining)),
    ]);
    if (next.done) throw new Error('Iterator ended before ' + label);
    if (predicate(next.value)) return next.value;
  }
  throw new Error('Timed out waiting for ' + label);
}

const browser = await chromium.launch({ executablePath: edgePath, headless: true });
const context = await browser.newContext();
const page = await context.newPage();
let pageLocalInvokeCount = 0;
const listBinding = '__r12ResultRoutingList';
const invokeBinding = '__r12ResultRoutingInvoke';
await page.exposeFunction(listBinding, async () => [readTool]);
await page.exposeFunction(invokeBinding, async () => {
  pageLocalInvokeCount += 1;
  return { content: [{ type: 'text', text: 'MUST_NOT_RUN_PAGE_LOCAL' }] };
});
await page.route('https://chat.deepseek.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
await page.goto('https://chat.deepseek.com/a/chat/r12-result-routing', { waitUntil: 'domcontentloaded' });
await page.evaluate(() => {
  window.MutationObserver = class SilentMutationObserver {
    observe() {}
    disconnect() {}
    takeRecords() { return []; }
  };
});
await appendAssistant(page, 20, 'HISTORICAL_ASSISTANT_BASELINE');
const injectedStatus = await page.evaluate(({ source, listBinding, invokeBinding }) => {
  const factory = (0, eval)(source);
  return factory({ token: 'r12-result-routing-token', listBinding, invokeBinding });
}, { source: composedSource, listBinding, invokeBinding });
assert.equal(injectedStatus.virtualizedOccurrenceIdentity, true);
assert.equal(injectedStatus.runningTurnPollScan, true);
assert.equal(injectedStatus.occurrenceScopedResultRouting, true);

class PageCommands {
  calls = [];
  ackLost = false;
  resolveAttempts = [];

  async executeCommand(command, arg) {
    this.calls.push({ command, arg: structuredClone(arg) });
    if (command === '_shuncode.webMcp.workerConnect') {
      const session = await page.evaluate(() => window.__shuncodeWebMcp.workerSession());
      const status = await page.evaluate(() => window.__shuncodeWebMcp.status());
      return {
        pageId: 'page-r12-result-routing',
        sessionId: session.sessionId,
        site: 'deepseek',
        origin: 'https://chat.deepseek.com',
        href: 'https://chat.deepseek.com/a/chat/r12-result-routing',
        transport: 'binding',
        status,
      };
    }
    if (command === '_shuncode.webMcp.workerSend') {
      return await page.evaluate(input => window.__shuncodeWebMcp.workerSend(input), arg.input);
    }
    if (command === '_shuncode.webMcp.workerPoll') {
      return await page.evaluate(inputId => window.__shuncodeWebMcp.workerPoll(inputId), arg.inputId);
    }
    if (command === '_shuncode.webMcp.workerResolve') {
      this.resolveAttempts.push(structuredClone(arg.result));
      const accepted = await page.evaluate(result => window.__shuncodeWebMcp.workerResolveCapability(result), arg.result);
      if (!this.ackLost && arg.result.text === 'RESULT_ONE') {
        this.ackLost = true;
        throw new Error('ACK_LOST_AFTER_PROVIDER_ACCEPT');
      }
      return accepted;
    }
    if (command === '_shuncode.webMcp.workerHealth') {
      return { status: await page.evaluate(() => window.__shuncodeWebMcp.status()) };
    }
    if (command === '_shuncode.webMcp.workerInterrupt') {
      return { interrupted: await page.evaluate(inputId => window.__shuncodeWebMcp.workerInterrupt(inputId), arg.inputId) };
    }
    if (command === '_shuncode.webMcp.workerDisconnect') return { disconnected: true };
    throw new Error('Unexpected command: ' + command);
  }
}

const taskBindings = {
  async attachWorkerSession() {},
  async detachWorkerSession() {},
  async isWorkerAdapterSessionRetired() { return false; },
  async assertWorkerSessionContinuationAllowed() {},
  async assertWorkerSessionAdmittedTurnContinuationAllowed() {},
};
const projection = {
  async beginWorkerExecution() {},
  async completeWorkerExecution() {},
  async markWorkerExecutionDelivered() {},
};

const commands = new PageCommands();
const transport = new WebMcpCommandTransport(commands, { pollIntervalMs: 5 });
const adapter = new WebWorkerAdapter(transport);
let managedSequence = 0;
const manager = new WorkerSessionManager({
  taskBindings,
  executionProjection: projection,
  newId: () => 'r12-result-routing-managed-' + (++managedSequence),
});

const executionCounts = new Map();
const hostExecution = new HostCapabilityExecutionCoordinator({
  authorizer: { async authorize() {} },
  executor: {
    async execute(request) {
      executionCounts.set(request.executionId, (executionCounts.get(request.executionId) || 0) + 1);
      const file = String(request.arguments?.files?.[0]?.path || '');
      if (file === 'one.md') return { text: 'RESULT_ONE', isError: false };
      if (file === 'two.md') return { text: 'RESULT_TWO', isError: false };
      throw new Error('Unexpected capability arguments: ' + JSON.stringify(request.arguments));
    },
  },
});

function hostRequest(session, event) {
  const executionId = String(event.extensions?.executionId || '');
  const occurrenceId = String(event.extensions?.occurrenceId || '');
  assert.ok(executionId, 'Manager must attach execution identity');
  assert.ok(occurrenceId, 'page stable occurrence identity must survive Manager mapping');
  return {
    executionId,
    managedSessionId: session.managedSessionId,
    workerId: session.workerId,
    taskId: session.taskId,
    inputId: event.inputId,
    callId: event.callId,
    name: event.name,
    arguments: event.arguments,
    occurrenceId,
  };
}

try {
  await manager.register(adapter);
  const session = await manager.createSession('nimora.web-worker', {}, 'r12-result-routing-task');
  const inputId = 'r12-result-routing-turn';
  const iterator = manager.send(session.managedSessionId, {
    inputId,
    prompt: 'Request read_files twice and wait for each host result.',
    allowedCapabilities: ['read_files'],
    externalCapabilities: [readTool],
    extensions: { hostManagedCapabilities: true },
  })[Symbol.asyncIterator]();

  const firstCallPromise = nextMatching(
    iterator,
    event => event.type === 'capability_call' && event.callId === 'same-route',
    'logical occurrence #1',
  );
  await page.waitForFunction(() => window.__submittedMessages.length >= 1);
  await appendAssistant(page, 21, toolBlock('same-route', 'one.md'));
  const firstCall = await firstCallPromise;
  assert.equal(firstCall.dispatch, 'host-requested');
  const requestOne = hostRequest(session, firstCall);

  await assert.rejects(
    () => hostExecution.executeAndDeliver(requestOne, manager),
    /ACK_LOST_AFTER_PROVIDER_ACCEPT/,
    'page/provider acceptance followed by upper acknowledgement loss must remain delivery-unknown',
  );
  assert.equal(executionCounts.get(requestOne.executionId), 1, 'capability #1 executes exactly once before ACK loss');
  assert.equal(pageLocalInvokeCount, 0, 'host-managed capability must never execute page-local');

  const afterAckLossPayloads = await page.evaluate(() => [...window.__submittedMessages]);
  assert.equal(afterAckLossPayloads.filter(text => text.includes('RESULT_ONE')).length, 1, 'provider/page accepted result #1 exactly once before ACK loss');
  assert.equal(await page.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 0, 'page has already settled occurrence #1 even though Manager ACK is unknown');

  const secondCallPromise = nextMatching(
    iterator,
    event => event.type === 'capability_call' && event.callId === 'same-route',
    'logical occurrence #2',
  );
  await appendAssistant(page, 22, toolBlock('same-route', 'two.md'));
  const secondCall = await secondCallPromise;
  const requestTwo = hostRequest(session, secondCall);
  assert.equal(secondCall.callId, firstCall.callId);
  assert.equal(secondCall.name, firstCall.name);
  assert.notEqual(requestTwo.occurrenceId, requestOne.occurrenceId, 'same provider route must retain distinct logical occurrence authority');
  assert.notEqual(requestTwo.executionId, requestOne.executionId, 'Manager executions must remain occurrence-distinct');
  assert.equal(await page.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 1, 'occurrence #2 is independently pending at the page');
  await assert.rejects(
    () => manager.submitCapabilityResult(session.managedSessionId, {
      inputId,
      callId: 'same-route',
      name: 'read_files',
      text: 'RESULT_WITHOUT_OCCURRENCE_AUTHORITY',
    }),
    /requires exact logical-occurrence authority/,
    'occurrence-aware reused provider route must fail closed when result occurrence authority is missing',
  );
  assert.equal(await page.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 1);

  await hostExecution.deliverResult(requestOne, manager);
  assert.equal(executionCounts.get(requestOne.executionId), 1, 'canonical retry(result #1) must never reexecute capability #1');
  const afterRetryOnePayloads = await page.evaluate(() => [...window.__submittedMessages]);
  assert.equal(afterRetryOnePayloads.filter(text => text.includes('RESULT_ONE')).length, 1, 'retry(result #1) must be page-idempotent after provider already accepted it');
  assert.equal(await page.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 1, 'retry(result #1) must not consume occurrence #2');
  const pageBeforeTwo = await page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r12-result-routing-turn'));
  assert.equal(
    pageBeforeTwo.events.filter(event => event.type === 'capability_result' && event.occurrenceId === requestTwo.occurrenceId).length,
    0,
    'occurrence #2 must not be falsely settled by stale RESULT_ONE',
  );

  const settledOneResult = hostExecution.getState(requestOne.executionId)?.result;
  assert.ok(settledOneResult);
  await assert.rejects(
    () => manager.submitCapabilityResult(session.managedSessionId, settledOneResult),
    /No outstanding host-requested capability call/,
    'once Manager confirms occurrence #1 retry, another stale #1 retry must not borrow occurrence #2',
  );
  assert.equal(await page.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 1);

  await hostExecution.executeAndDeliver(requestTwo, manager);
  assert.equal(executionCounts.get(requestTwo.executionId), 1, 'capability #2 executes exactly once for occurrence #2');
  assert.equal(await page.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 0);
  const finalPayloads = await page.evaluate(() => [...window.__submittedMessages]);
  assert.equal(finalPayloads.filter(text => text.includes('RESULT_ONE')).length, 1);
  assert.equal(finalPayloads.filter(text => text.includes('RESULT_TWO')).length, 1);
  assert.equal(requestOne.callId, 'same-route');
  assert.equal(requestTwo.callId, 'same-route');

  await appendAssistant(page, 23, 'R12_RESULT_ROUTING_FINAL');
  await page.waitForTimeout(1300);
  const terminal = await nextMatching(iterator, event => event.type === 'terminal', 'trustworthy terminal');
  assert.equal(terminal.status, 'completed');

  assert.equal(commands.resolveAttempts.filter(result => result.text === 'RESULT_ONE').length, 2, 'upper transport should attempt result #1 delivery twice across ACK loss');
  assert.ok(commands.resolveAttempts.filter(result => result.text === 'RESULT_ONE').every(result => result.extensions?.occurrenceId === requestOne.occurrenceId));
  assert.ok(commands.resolveAttempts.filter(result => result.text === 'RESULT_TWO').every(result => result.extensions?.occurrenceId === requestTwo.occurrenceId));

  console.log(JSON.stringify({
    result: 'PASS',
    pageProviderAcceptedResultOneBeforeAckLoss: true,
    managerRetryRetainedOccurrenceOne: true,
    sameRouteOccurrenceTwoDistinct: true,
    missingOccurrenceAuthorityFailClosed: true,
    providerCallIdRetained: firstCall.callId === 'same-route' && secondCall.callId === 'same-route',
    resultOneDeliveryAttemptsAcrossAckLoss: commands.resolveAttempts.filter(result => result.text === 'RESULT_ONE').length,
    resultOneProviderSubmissionCount: finalPayloads.filter(text => text.includes('RESULT_ONE')).length,
    crossOccurrenceResultConsumption: 0,
    occurrenceTwoFalselySettledByResultOne: false,
    resultTwoProviderSubmissionCount: finalPayloads.filter(text => text.includes('RESULT_TWO')).length,
    capabilityOneExecutionCount: executionCounts.get(requestOne.executionId),
    capabilityOneReexecution: (executionCounts.get(requestOne.executionId) || 0) - 1,
    capabilityTwoExecutionCount: executionCounts.get(requestTwo.executionId),
    pageLocalHostManagedInvoke: pageLocalInvokeCount,
    occurrenceScopedResultRoutingMarker: injectedStatus.occurrenceScopedResultRouting,
  }, null, 2));
} finally {
  await context.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  await rm(bundleDirectory, { recursive: true, force: true }).catch(() => undefined);
}
