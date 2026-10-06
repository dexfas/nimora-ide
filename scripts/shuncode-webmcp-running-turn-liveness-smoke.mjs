import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
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
assert.ok(edgePath, 'Microsoft Edge executable is required for the WebMCP running-turn liveness smoke');

const [coreSource, siteSource, agentSource] = await Promise.all([
  readFile(path.join(webMcpDir, 'webmcp-page-core.js'), 'utf8'),
  readFile(path.join(webMcpDir, 'webmcp-site-adapters.js'), 'utf8'),
  readFile(path.join(webMcpDir, 'arena-agent-bridge.js'), 'utf8'),
]);

const composedSource = `(function shunCodeWebMcpComposedAgent(config) {
  const createCore = (${coreSource.trim()});
  const createSiteAdapter = (${siteSource.trim()});
  const agent = (${agentSource.trim()});
  return agent(config, { createCore, createSiteAdapter });
})`;

const html = `<!doctype html>
<html>
  <body>
    <main id="messages"></main>
    <div id="composer-host"></div>
    <script>
      window.__submittedMessages = [];
      window.__nextDeepSeekUserVirtualKey = -1;
      window.__installComposer = () => {
        const host = document.getElementById('composer-host');
        host.textContent = '';
        const form = document.createElement('form');
        form.id = 'composer-form';
        const composer = document.createElement('textarea');
        composer.setAttribute('aria-label', 'Ask anything');
        const send = document.createElement('button');
        send.type = 'submit';
        send.setAttribute('aria-label', 'Send');
        send.textContent = 'Send';
        form.append(composer, send);
        form.addEventListener('submit', event => {
          event.preventDefault();
          const text = composer.value;
          window.__submittedMessages.push(text);
          const item = document.createElement('div');
          item.setAttribute('data-virtual-list-item-key', String(window.__nextDeepSeekUserVirtualKey--));
          const message = document.createElement('div');
          message.className = 'user-message ds-message';
          message.textContent = text;
          item.appendChild(message);
          document.getElementById('messages').appendChild(item);
          composer.value = '';
          composer.dispatchEvent(new Event('input', { bubbles: true }));
        });
        host.appendChild(form);
      };
      window.__installComposer();
    </script>
  </body>
</html>`;

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
  return `[SHUNCODE_TOOL]\nid=${id}\nname=read_files\narg.files.0.path=${file}\n[/SHUNCODE_TOOL]`;
}

async function appendAssistant(page, text, id = '') {
  await page.evaluate(({ text, id }) => {
    window.__nextDeepSeekVirtualKey = (window.__nextDeepSeekVirtualKey || 0) + 1;
    const item = document.createElement('div');
    item.setAttribute('data-virtual-list-item-key', String(window.__nextDeepSeekVirtualKey));
    const response = document.createElement('div');
    response.className = 'ds-assistant-message-main-content';
    if (id) response.dataset.testId = id;
    response.innerText = text;
    item.appendChild(response);
    document.getElementById('messages').appendChild(item);
  }, { text, id });
}

async function removeAssistant(page, id) {
  await page.evaluate(id => {
    const response = document.querySelector(`[data-test-id="${id}"]`);
    const item = response?.closest('[data-virtual-list-item-key]');
    if (item) item.remove();
    else response?.remove();
  }, id);
}

async function createHarness(browser, label, invokeHandler = async () => ({ content: [{ type: 'text', text: 'READ_OK' }] }), options = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const listName = `__shuncodeListTools_${label}`;
  const invokeName = `__shuncodeInvokeTool_${label}`;
  let invokeCount = 0;
  const invocations = [];
  await page.exposeFunction(listName, async token => {
    assert.equal(token, `${label}-token`);
    return [readTool];
  });
  await page.exposeFunction(invokeName, async (token, name, args) => {
    assert.equal(token, `${label}-token`);
    invokeCount += 1;
    invocations.push({ name, args: structuredClone(args) });
    return await invokeHandler({ count: invokeCount, name, args });
  });
  await page.route('https://chat.deepseek.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  await page.goto(`https://chat.deepseek.com/a/chat/${label}`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ useNativeMutationObserver }) => {
    const nativeSetTimeout = window.setTimeout.bind(window);
    window.__nativeSetTimeout = nativeSetTimeout;
    const responseBurstDelays = new Set([350, 900, 1800, 3500, 6000, 10000]);
    window.setTimeout = (fn, delay = 0, ...args) => nativeSetTimeout(fn, responseBurstDelays.has(Number(delay)) ? 5 : delay, ...args);
    if (!useNativeMutationObserver) {
      window.MutationObserver = class SilentMutationObserver {
        observe() {}
        disconnect() {}
        takeRecords() { return []; }
      };
    }
    window.__legacyStopped = false;
    window.__shuncodeWebMcp = {
      version: 25,
      matchesConfig: () => true,
      status: () => ({
        version: 25,
        runningTurnPollScan: true,
        virtualizedOccurrenceIdentity: true,
        occurrenceScopedResultRouting: false,
      }),
      stop: () => { window.__legacyStopped = true; },
    };
  }, { useNativeMutationObserver: options.useNativeMutationObserver === true });
  const status = await page.evaluate(({ source, token, listBinding, invokeBinding }) => {
    const factory = (0, eval)(source);
    return factory({ token, listBinding, invokeBinding });
  }, { source: composedSource, token: `${label}-token`, listBinding: listName, invokeBinding: invokeName });
  assert.equal(status.version, 25);
  assert.equal(status.runningTurnPollScan, true);
  assert.equal(status.virtualizedOccurrenceIdentity, true);
  assert.equal(status.occurrenceScopedResultRouting, true);
  assert.equal(status.backgroundScanCoalescingTruth, true);
  assert.equal(await page.evaluate(() => window.__legacyStopped), true, 'same-v25 Candidate #2 runtime without occurrence-scoped result routing must be replaced');
  return {
    context,
    page,
    get invokeCount() { return invokeCount; },
    get invocations() { return invocations; },
    async exhaustBurstAndGetLastScan() {
      await page.waitForTimeout(60);
      return await page.evaluate(() => window.__shuncodeWebMcp.status().lastScanAt);
    },
    async restoreNativeTimers() {
      await page.evaluate(() => { window.setTimeout = window.__nativeSetTimeout; });
    },
  };
}

const hostManagedInput = inputId => ({
  inputId,
  prompt: 'Request read_files and wait for the host result.',
  allowedCapabilities: ['read_files'],
  externalCapabilities: [readTool],
  extensions: { hostManagedCapabilities: true },
});

const browser = await chromium.launch({ executablePath: edgePath, headless: true });

try {
  // Phase 11 late Coordinator capability regression: a host-managed DeepSeek
  // turn must not terminalize merely because provider prose became stable
  // before the tool block finished mounting. The bounded host-managed grace is
  // authority-preserving: it only keeps the exact admitted turn observable;
  // it never executes a capability by itself.
  const lateHost = await createHarness(browser, 'phase11-late-host');
  const lateStart = await lateHost.page.evaluate(
    input => window.__shuncodeWebMcp.workerSend(input),
    hostManagedInput('phase11-late-host-turn'),
  );
  assert.equal(lateStart.state, 'running');
  await appendAssistant(lateHost.page, 'I am preparing the requested capability.', 'phase11-late-prose');
  await lateHost.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('phase11-late-host-turn'));
  await lateHost.page.waitForTimeout(1250);
  const beforeLateCapability = await lateHost.page.evaluate(
    () => window.__shuncodeWebMcp.workerPoll('phase11-late-host-turn'),
  );
  assert.equal(
    beforeLateCapability.state,
    'running',
    'host-managed turn must remain live through the bounded late-capability convergence window',
  );
  await appendAssistant(lateHost.page, toolBlock('phase11-late-host-call'), 'phase11-late-call-node');
  const lateAdmitted = await lateHost.page.evaluate(
    () => window.__shuncodeWebMcp.workerPoll('phase11-late-host-turn'),
  );
  const lateCall = lateAdmitted.events.find(
    event => event.type === 'capability_call' && event.callId === 'phase11-late-host-call',
  );
  assert.ok(lateCall, 'late stable host-managed capability must still admit on the exact running turn');
  assert.equal(lateCall.dispatch, 'host-requested');
  assert.equal(lateHost.invokeCount, 0, 'late host-managed capability must never fall through to generic page-local execution');
  await lateHost.page.evaluate(async occurrenceId => await window.__shuncodeWebMcp.workerResolveCapability({
    inputId: 'phase11-late-host-turn',
    callId: 'phase11-late-host-call',
    name: 'read_files',
    text: 'PHASE11_LATE_HOST_OK',
    isError: false,
    extensions: { occurrenceId },
  }), lateCall.occurrenceId);
  await appendAssistant(lateHost.page, 'PHASE11_LATE_HOST_FINAL', 'phase11-late-final');
  await lateHost.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('phase11-late-host-turn'));
  await lateHost.page.waitForTimeout(1250);
  const lateDone = await lateHost.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('phase11-late-host-turn'));
  assert.equal(lateDone.state, 'completed');
  const callsAtCompletion = lateDone.events.filter(event => event.type === 'capability_call').length;
  await appendAssistant(lateHost.page, toolBlock('phase11-post-terminal-call'), 'phase11-post-terminal-node');
  await lateHost.page.evaluate(async () => await window.__shuncodeWebMcp.scan());
  const afterTerminalScan = await lateHost.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('phase11-late-host-turn'));
  assert.equal(afterTerminalScan.events.filter(event => event.type === 'capability_call').length, callsAtCompletion);
  assert.equal(lateHost.invokeCount, 0, 'post-terminal host-managed occurrence must stay quarantined from generic execution');
  await lateHost.context.close();

  // R11 exact shape: silent observer + exhausted finite burst + late valid
  // host-managed call + canonical poll must admit exactly once.
  const host = await createHarness(browser, 'r11-host');
  const hostStart = await host.page.evaluate(input => window.__shuncodeWebMcp.workerSend(input), hostManagedInput('r11-host-turn'));
  assert.equal(hostStart.state, 'running');
  const beforeLateScan = await host.exhaustBurstAndGetLastScan();
  assert.ok(beforeLateScan > 0);
  await appendAssistant(host.page, toolBlock('r11-host-call'), 'r11-host-call-node');
  await host.page.waitForTimeout(20);
  assert.equal(await host.page.evaluate(() => window.__shuncodeWebMcp.status().lastScanAt), beforeLateScan, 'silent observer must not accidentally scan the late call');

  const wrongBefore = await host.page.evaluate(() => window.__shuncodeWebMcp.status().lastScanAt);
  await assert.rejects(
    () => host.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('wrong-input')),
    /Unknown WebMCP worker turn/,
  );
  assert.equal(await host.page.evaluate(() => window.__shuncodeWebMcp.status().lastScanAt), wrongBefore, 'wrong input poll must not scan');

  await host.page.waitForTimeout(10);
  const admitted = await host.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r11-host-turn'));
  const admittedStatus = await host.page.evaluate(() => window.__shuncodeWebMcp.status());
  assert.ok(admittedStatus.lastScanAt > beforeLateScan, 'canonical running-turn poll must advance scan observation');
  assert.equal(admitted.toolCallCount, 1);
  assert.equal(admittedStatus.pendingHostCapabilities, 1);
  assert.equal(host.invokeCount, 0, 'host-managed late call must never use page-local invoke');
  assert.equal(admitted.events.filter(event => event.type === 'capability_call' && event.callId === 'r11-host-call').length, 1);
  const admittedCall = admitted.events.find(event => event.type === 'capability_call' && event.callId === 'r11-host-call');
  assert.equal(admittedCall?.dispatch, 'host-requested');
  assert.ok(admittedCall?.occurrenceId, 'host-managed page event must expose exact logical occurrence authority');

  const overlapping = await host.page.evaluate(async () => await Promise.all(
    Array.from({ length: 8 }, () => window.__shuncodeWebMcp.workerPoll('r11-host-turn')),
  ));
  assert.equal(overlapping.length, 8);
  const overlapLast = overlapping.at(-1);
  assert.equal(overlapLast.events.filter(event => event.type === 'capability_call' && event.callId === 'r11-host-call').length, 1, 'overlapping polls must not duplicate admission');
  assert.equal(await host.page.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 1);
  assert.equal(host.invokeCount, 0);

  const resolved = await host.page.evaluate(async occurrenceId => await window.__shuncodeWebMcp.workerResolveCapability({
    inputId: 'r11-host-turn',
    callId: 'r11-host-call',
    name: 'read_files',
    text: 'HOST_R11_OK',
    isError: false,
    extensions: { occurrenceId },
  }), admittedCall.occurrenceId);
  assert.equal(resolved.state, 'running');
  assert.equal(await host.page.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 0);
  await host.page.waitForFunction(() => window.__submittedMessages.some(text => text.includes('HOST_R11_OK')));
  const resolvedAgain = await host.page.evaluate(async occurrenceId => await window.__shuncodeWebMcp.workerResolveCapability({
    inputId: 'r11-host-turn',
    callId: 'r11-host-call',
    name: 'read_files',
    text: 'HOST_R11_OK',
    isError: false,
    extensions: { occurrenceId },
  }), admittedCall.occurrenceId);
  assert.equal(resolvedAgain.events.filter(event => event.type === 'capability_result' && event.callId === 'r11-host-call').length, 1);
  assert.equal(await host.page.evaluate(() => window.__submittedMessages.filter(text => text.includes('HOST_R11_OK')).length), 1, 'host result must be delivered once');
  await host.page.waitForTimeout(60);
  const retained = await host.page.evaluate(async () => await Promise.all(
    Array.from({ length: 5 }, () => window.__shuncodeWebMcp.workerPoll('r11-host-turn')),
  ));
  assert.equal(retained.at(-1).events.filter(event => event.type === 'capability_call' && event.callId === 'r11-host-call').length, 1, 'same rendered occurrence must stay deduped');

  await appendAssistant(host.page, 'HOST_R11_FINAL', 'r11-host-final');
  await host.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r11-host-turn'));
  await host.page.waitForTimeout(1250);
  const hostDone = await host.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r11-host-turn'));
  assert.equal(hostDone.state, 'completed');
  const completedLastScan = await host.page.evaluate(() => window.__shuncodeWebMcp.status().lastScanAt);
  await appendAssistant(host.page, toolBlock('completed-late-call'), 'completed-late-node');
  const completedPoll = await host.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r11-host-turn'));
  assert.equal(completedPoll.state, 'completed');
  assert.equal(completedPoll.events.filter(event => event.type === 'capability_call').length, 1, 'completed turn poll must not admit a new call');
  assert.equal(await host.page.evaluate(() => window.__shuncodeWebMcp.status().lastScanAt), completedLastScan, 'completed turn poll must not run scan');
  await removeAssistant(host.page, 'completed-late-node');

  const cancelStart = await host.page.evaluate(input => window.__shuncodeWebMcp.workerSend(input), hostManagedInput('r11-cancel-turn'));
  assert.equal(cancelStart.state, 'running');
  await host.exhaustBurstAndGetLastScan();
  await host.page.evaluate(() => {
    const stop = document.createElement('button');
    stop.id = 'r11-stop';
    stop.setAttribute('aria-label', 'Stop generating');
    stop.textContent = 'Stop';
    document.body.appendChild(stop);
  });
  assert.equal(await host.page.evaluate(() => window.__shuncodeWebMcp.workerInterrupt('r11-cancel-turn')), true);
  const cancelLastScan = await host.page.evaluate(() => window.__shuncodeWebMcp.status().lastScanAt);
  await appendAssistant(host.page, toolBlock('cancelled-late-call'), 'cancelled-late-node');
  const cancelled = await host.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r11-cancel-turn'));
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.events.filter(event => event.type === 'capability_call').length, 0);
  assert.equal(await host.page.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 0);
  assert.equal(await host.page.evaluate(() => window.__shuncodeWebMcp.status().lastScanAt), cancelLastScan, 'cancelled turn poll must not scan');
  await removeAssistant(host.page, 'cancelled-late-node');
  await host.page.evaluate(() => document.getElementById('r11-stop')?.remove());

  await host.page.evaluate(() => document.getElementById('composer-form')?.remove());
  await assert.rejects(
    () => host.page.evaluate(() => window.__shuncodeWebMcp.workerSend({ inputId: 'r11-error-turn', prompt: 'must fail before send' })),
    /No compatible chat input found/,
  );
  await host.page.evaluate(() => window.__installComposer());
  const errorLastScan = await host.page.evaluate(() => window.__shuncodeWebMcp.status().lastScanAt);
  await appendAssistant(host.page, toolBlock('error-late-call'), 'error-late-node');
  const errored = await host.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r11-error-turn'));
  assert.equal(errored.state, 'error');
  assert.equal(errored.events.filter(event => event.type === 'capability_call').length, 0);
  assert.equal(await host.page.evaluate(() => window.__shuncodeWebMcp.status().lastScanAt), errorLastScan, 'error turn poll must not scan');
  await host.context.close();

  // Non-host-managed Worker mode retains page-local execution while gaining the
  // same late-call liveness and call-occurrence-v2 dedupe.
  const local = await createHarness(browser, 'r11-local');
  const localStart = await local.page.evaluate(() => window.__shuncodeWebMcp.workerSend({
    inputId: 'r11-local-turn',
    prompt: 'Use page-local read_files.',
  }));
  assert.equal(localStart.state, 'running');
  const localBefore = await local.exhaustBurstAndGetLastScan();
  const repeatedBlock = toolBlock('r11-repeat-id', 'README.md');
  await appendAssistant(local.page, repeatedBlock, 'repeat-one');
  await local.page.waitForTimeout(20);
  assert.equal(await local.page.evaluate(() => window.__shuncodeWebMcp.status().lastScanAt), localBefore);
  const localFirst = await local.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r11-local-turn'));
  assert.equal(localFirst.toolCallCount, 1);
  assert.equal(local.invokeCount, 1);
  await local.page.waitForTimeout(60);
  await appendAssistant(local.page, repeatedBlock, 'repeat-two');
  const localOverlap = await local.page.evaluate(async () => await Promise.all(
    Array.from({ length: 6 }, () => window.__shuncodeWebMcp.workerPoll('r11-local-turn')),
  ));
  assert.equal(local.invokeCount, 2, 'two identical rendered call occurrences must execute once each');
  assert.equal(localOverlap.at(-1).events.filter(event => event.type === 'capability_call' && event.callId === 'r11-repeat-id').length, 2);
  await local.page.waitForTimeout(60);
  await local.page.evaluate(async () => await Promise.all(
    Array.from({ length: 5 }, () => window.__shuncodeWebMcp.workerPoll('r11-local-turn')),
  ));
  assert.equal(local.invokeCount, 2, 'repeated polls must not replay either identical occurrence');
  await local.context.close();

  // Poll-while-busy must enqueue a later observation opportunity. The first
  // scan is blocked inside page-local invoke; the second call appears while it
  // is busy and a second poll must observe it after serialization.
  let busyRelease;
  let busyStartedResolve;
  const busyStarted = new Promise(resolve => { busyStartedResolve = resolve; });
  const busyGate = new Promise(resolve => { busyRelease = resolve; });
  const busyHarness = await createHarness(browser, 'r11-busy', async ({ count }) => {
    if (count === 1) {
      busyStartedResolve();
      await busyGate;
    }
    return { content: [{ type: 'text', text: `BUSY_READ_${count}` }] };
  });
  await busyHarness.page.evaluate(() => window.__shuncodeWebMcp.workerSend({ inputId: 'r11-busy-turn', prompt: 'Process two page-local calls.' }));
  await busyHarness.exhaustBurstAndGetLastScan();
  await busyHarness.restoreNativeTimers();
  await appendAssistant(busyHarness.page, toolBlock('busy-call-1', 'A.md'), 'busy-one');
  await busyHarness.page.evaluate(() => {
    window.__r11BusyPollOne = window.__shuncodeWebMcp.workerPoll('r11-busy-turn');
  });
  await busyStarted;
  await appendAssistant(busyHarness.page, toolBlock('busy-call-2', 'B.md'), 'busy-two');
  await busyHarness.page.evaluate(() => {
    window.__r11BusyPollTwo = window.__shuncodeWebMcp.workerPoll('r11-busy-turn');
  });
  busyRelease();
  const busySnapshots = await busyHarness.page.evaluate(async () => await Promise.all([window.__r11BusyPollOne, window.__r11BusyPollTwo]));
  assert.equal(busySnapshots.length, 2);
  assert.equal(busyHarness.invokeCount, 2, 'poll queued while scan is busy must receive a later observation opportunity');
  assert.equal(busyHarness.invocations[0].args.files[0].path, 'A.md');
  assert.equal(busyHarness.invocations[1].args.files[0].path, 'B.md');
  assert.equal(busySnapshots.at(-1).events.filter(event => event.type === 'capability_call').length, 2);
  await busyHarness.context.close();

  // Background DOM observation is level-triggered, not one work item per
  // mutation. While an explicit scan is busy, many MutationObserver/response
  // burst requests must collapse into one follow-up opportunity. This is the
  // fresh-provider regression for the R8 gap where a later capability was
  // already rendered but stale background scans delayed the host poll.
  let coalesceRelease;
  let coalesceStartedResolve;
  const coalesceStarted = new Promise(resolve => { coalesceStartedResolve = resolve; });
  const coalesceGate = new Promise(resolve => { coalesceRelease = resolve; });
  const coalesceHarness = await createHarness(browser, 'r11-background-coalesce', async ({ count }) => {
    if (count === 1) {
      coalesceStartedResolve();
      await coalesceGate;
    }
    return { content: [{ type: 'text', text: `COALESCED_READ_${count}` }] };
  }, { useNativeMutationObserver: true });
  await coalesceHarness.page.evaluate(() => window.__shuncodeWebMcp.workerSend({
    inputId: 'r11-background-coalesce-turn',
    prompt: 'Process two page-local calls while background DOM scans fire.',
  }));
  await coalesceHarness.restoreNativeTimers();
  await coalesceHarness.page.waitForTimeout(260);
  await appendAssistant(coalesceHarness.page, toolBlock('coalesce-call-1', 'A.md'), 'coalesce-one');
  await coalesceHarness.page.evaluate(() => {
    window.__r11CoalescePoll = window.__shuncodeWebMcp.workerPoll('r11-background-coalesce-turn');
  });
  await coalesceStarted;
  await appendAssistant(coalesceHarness.page, toolBlock('coalesce-call-2', 'B.md'), 'coalesce-two');
  for (let i = 0; i < 4; i += 1) {
    await coalesceHarness.page.evaluate(i => {
      const node = document.createElement('span');
      node.dataset.backgroundMutation = String(i);
      node.textContent = `mutation-${i}`;
      document.getElementById('messages').appendChild(node);
    }, i);
    await coalesceHarness.page.waitForTimeout(210);
    const status = await coalesceHarness.page.evaluate(() => window.__shuncodeWebMcp.status());
    assert.equal(status.scanQueueDepth, 1, 'background scans must not enqueue behind the one busy explicit poll');
    assert.equal(status.backgroundScanFollowupPending, true, 'busy background observation must retain one follow-up wakeup');
  }
  coalesceRelease();
  await coalesceHarness.page.evaluate(async () => await window.__r11CoalescePoll);
  const coalesceDeadline = Date.now() + 4000;
  while (coalesceHarness.invokeCount < 2 && Date.now() < coalesceDeadline) {
    await coalesceHarness.page.waitForTimeout(40);
  }
  assert.equal(coalesceHarness.invokeCount, 2, 'one coalesced background follow-up must observe the later occurrence exactly once');
  assert.equal(coalesceHarness.invocations[0].args.files[0].path, 'A.md');
  assert.equal(coalesceHarness.invocations[1].args.files[0].path, 'B.md');
  await coalesceHarness.page.waitForTimeout(300);
  assert.equal(coalesceHarness.invokeCount, 2, 'background follow-up must not replay either occurrence');
  const coalescedStatus = await coalesceHarness.page.evaluate(() => window.__shuncodeWebMcp.status());
  assert.equal(coalescedStatus.scanQueueDepth, 0);
  assert.equal(coalescedStatus.backgroundScanFollowupPending, false);
  await coalesceHarness.context.close();

  // Pending delivery retry may resend only the result. The original page-local
  // tool execution is deliberately made successful exactly once while the
  // first result delivery loses its composer.
  let retryInvokeStartedResolve;
  const retryInvokeStarted = new Promise(resolve => { retryInvokeStartedResolve = resolve; });
  const retryHarness = await createHarness(browser, 'r11-retry', async ({ count }) => {
    retryInvokeStartedResolve();
    await new Promise(resolve => setTimeout(resolve, 80));
    return { content: [{ type: 'text', text: `RETRY_READ_${count}` }] };
  });
  await retryHarness.page.evaluate(() => window.__shuncodeWebMcp.workerSend({ inputId: 'r11-retry-turn', prompt: 'Exercise result redelivery only.' }));
  await retryHarness.exhaustBurstAndGetLastScan();
  await retryHarness.restoreNativeTimers();
  await appendAssistant(retryHarness.page, toolBlock('retry-call-1', 'retry.md'), 'retry-one');
  await retryHarness.page.evaluate(() => {
    window.__r11RetryPoll = window.__shuncodeWebMcp.workerPoll('r11-retry-turn');
  });
  await retryInvokeStarted;
  await retryHarness.page.evaluate(() => document.getElementById('composer-form')?.remove());
  await retryHarness.page.evaluate(async () => await window.__r11RetryPoll);
  assert.equal(retryHarness.invokeCount, 1);
  assert.equal(await retryHarness.page.evaluate(() => window.__shuncodeWebMcp.status().pendingDeliveries), 1);
  await retryHarness.page.evaluate(() => window.__installComposer());
  await retryHarness.page.waitForFunction(() => window.__shuncodeWebMcp.status().pendingDeliveries === 0, null, { timeout: 5000 });
  const retryDelivered = await retryHarness.page.evaluate(() => window.__shuncodeWebMcp.workerPoll('r11-retry-turn'));
  assert.equal(retryHarness.invokeCount, 1, 'delivery retry must not replay original page-local execution');
  assert.equal(await retryHarness.page.evaluate(() => window.__shuncodeWebMcp.status().pendingDeliveries), 0);
  assert.equal(await retryHarness.page.evaluate(() => window.__submittedMessages.filter(text => text.includes('RETRY_READ_1')).length), 1);
  assert.equal(retryDelivered.events.filter(event => event.type === 'capability_call' && event.callId === 'retry-call-1').length, 1);
  await retryHarness.context.close();

  console.log(JSON.stringify({
    result: 'PASS',
    observerSilentLateHostManagedAdmission: true,
    lastScanAtAdvancedByCanonicalPoll: true,
    repeatedPollCapabilityAdmissions: 1,
    hostManagedPendingIdentityCount: 1,
    hostManagedPageLocalInvokes: 0,
    hostResultDeliveredOnce: true,
    retainedRenderedCallReplay: 0,
    pageLocalLateInvokePerOccurrence: 1,
    overlappingPollDuplicateExecution: 0,
    busyPollLostWakeups: 0,
    wrongInputScanSideEffects: 0,
    completedTurnLateAdmissions: 0,
    cancelledTurnLateAdmissions: 0,
    errorTurnLateAdmissions: 0,
    interruptPostCancelAdmissions: 0,
    mutationObserverFastPathRetainedByExistingBrowserSmoke: true,
    finiteBurstRetainedAsOptimization: true,
    callOccurrenceV2RepeatedIdExecutions: 2,
    pendingDeliveryOriginalExecutionCount: 1,
    legacyV25RuntimeUpgradeMarker: true,
  }, null, 2));
} finally {
  await browser.close();
}
