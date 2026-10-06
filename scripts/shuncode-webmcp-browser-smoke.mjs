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
assert.ok(edgePath, 'Microsoft Edge executable is required for the WebMCP browser smoke');

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
    <main id="messages" class="ds-virtual-list-visible-items"></main>
    <form id="composer-form">
      <textarea aria-label="Ask anything"></textarea>
      <button type="submit" aria-label="Send">Send</button>
    </form>
    <script>
      window.__submittedMessages = [];
      window.__submitEvents = 0;
      window.__sendButtonClicks = 0;
      window.__requestSubmitCalls = 0;
      window.__enterSubmitEvents = 0;
      window.__composerInputEvents = 0;
      window.__lastProviderAdmissionAt = 0;
      window.__providerAdmissionMode = 'admit';
      window.__nextDeepSeekUserVirtualKey = -1;
      window.__nextDeepSeekAssistantShellKey = 9000;
      const form = document.getElementById('composer-form');
      const composer = form.querySelector('textarea');
      const sendButton = form.querySelector('button[type="submit"]');
      sendButton.addEventListener('click', () => { window.__sendButtonClicks += 1; });
      composer.addEventListener('input', () => { window.__composerInputEvents += 1; });
      composer.addEventListener('keydown', event => {
        if (event.key === 'Enter') window.__enterSubmitEvents += 1;
      });
      const nativeRequestSubmit = form.requestSubmit.bind(form);
      form.requestSubmit = (...args) => {
        window.__requestSubmitCalls += 1;
        return nativeRequestSubmit(...args);
      };
      window.__installSubmitClickThrowAfterSubmit = () => {
        const nativeClick = sendButton.click.bind(sendButton);
        sendButton.click = () => {
          nativeClick();
          throw new Error('synthetic submit UNKNOWN after dispatch');
        };
      };
      window.__appendDeepSeekUser = (text, key) => {
        const item = document.createElement('div');
        const resolvedKey = key ?? window.__nextDeepSeekUserVirtualKey--;
        item.setAttribute('data-virtual-list-item-key', String(resolvedKey));
        const message = document.createElement('div');
        message.className = 'user-message ds-message';
        message.textContent = text;
        item.appendChild(message);
        document.getElementById('messages').appendChild(item);
        window.__lastProviderAdmissionAt = Date.now();
        return item;
      };
      window.__appendTransientDeepSeekAssistantShell = (delayMs = 560) => {
        const item = document.createElement('div');
        item.setAttribute('data-virtual-list-item-key', String(++window.__nextDeepSeekAssistantShellKey));
        const message = document.createElement('div');
        message.className = 'ds-message';
        message.textContent = 'transient assistant shell';
        item.appendChild(message);
        document.getElementById('messages').appendChild(item);
        setTimeout(() => message.classList.add('ds-assistant-message-main-content'), delayMs);
        return item;
      };
      form.addEventListener('submit', event => {
        event.preventDefault();
        window.__submitEvents += 1;
        const text = composer.value;
        window.__submittedMessages.push(text);
        const mode = window.__providerAdmissionMode;
        if (mode === 'admit' || mode === 'admit-retain') window.__appendDeepSeekUser(text);
        if (mode === 'mismatch') window.__appendDeepSeekUser(text + ' MISMATCH');
        if (mode === 'multiple') {
          window.__appendDeepSeekUser(text);
          window.__appendDeepSeekUser(text);
        }
        if (mode === 'delayed-new-conversation-admit') {
          // The sole provider submit is accepted before the new conversation
          // URL and its virtualized stable user message are mounted.
          setTimeout(() => {
            history.pushState({}, '', '/a/chat/s/delayed-provider-conversation');
            window.__appendDeepSeekUser(text);
          }, 6200);
        }
        if (mode === 'transient-assistant-shell') {
          window.__appendDeepSeekUser(text);
          window.__appendTransientDeepSeekAssistantShell();
        }
        if (mode === 'unstable') {
          const message = document.createElement('div');
          message.className = 'user-message ds-message';
          message.textContent = text;
          document.getElementById('messages').appendChild(message);
        }
        if (mode === 'conversation-drift') {
          history.pushState({}, '', '/a/chat/s/drifted');
          window.__appendDeepSeekUser(text);
        }
        if (mode === 'rerender') {
          const existing = document.querySelector('[data-virtual-list-item-key="-90"]');
          if (existing) {
            const replacement = existing.cloneNode(true);
            existing.replaceWith(replacement);
          }
        }
        if (mode === 'rate-limit') {
          const notice = document.createElement('div');
          notice.textContent = 'rate limit reached, try again';
          notice.style.position = 'fixed';
          notice.style.left = '10px';
          notice.style.top = '10px';
          notice.style.width = '240px';
          notice.style.height = '30px';
          document.body.appendChild(notice);
        }
        if (mode !== 'admit-retain') {
          composer.value = '';
          composer.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
    </script>
  </body>
</html>`;

const deepSeekNoFormHtml = `<!doctype html>
<html>
  <body>
    <main id="messages" class="ds-virtual-list-visible-items"></main>
    <div id="outside-send" role="button" class="ds-button ds-button--primary ds-button--filled ds-button--circle ds-button--m _outsideHash" style="width:36px;height:36px">Outside</div>
    <section id="composer-shell" class="_020ab5b" style="width:720px;padding:8px">
      <div id="composer-input-owner">
        <textarea id="deepseek-composer" aria-label="Ask anything" style="width:600px;height:80px"></textarea>
      </div>
      <div id="composer-actions">
        <div id="deep-think" tabindex="0" class="ds-button ds-button--iconLabelPrimary ds-button--s" style="display:inline-block;width:90px;height:32px">Deep Think</div>
        <div id="search-action" tabindex="0" class="ds-button ds-button--iconLabelPrimary ds-button--s" style="display:inline-block;width:70px;height:32px">Search</div>
        <div id="capsule-action" role="button" class="ds-button ds-button--iconLabelPrimary ds-button--icon ds-button--capsule ds-button--s" style="display:inline-block;width:80px;height:32px">Capsule</div>
        <div id="deepseek-send" role="button" class="ds-button ds-button--primary ds-button--filled ds-button--circle ds-button--m ds-button--disabled _52c986b" style="display:inline-block;width:36px;height:36px;opacity:0.4;cursor:not-allowed"></div>
      </div>
    </section>
    <script>
      window.__submittedMessages = [];
      window.__submitEvents = 0;
      window.__sendButtonClicks = 0;
      window.__requestSubmitCalls = 0;
      window.__enterSubmitEvents = 0;
      window.__composerInputEvents = 0;
      window.__capsuleClicks = 0;
      window.__outsideSendClicks = 0;
      window.__lastProviderAdmissionAt = 0;
      window.__providerAdmissionMode = 'admit';
      window.__nextDeepSeekUserVirtualKey = -1;
      window.__forceNoFormDisabled = false;
      const composer = document.getElementById('deepseek-composer');
      const sendButton = document.getElementById('deepseek-send');
      const capsule = document.getElementById('capsule-action');
      const outside = document.getElementById('outside-send');
      window.__appendDeepSeekUser = (text, key) => {
        const item = document.createElement('div');
        const resolvedKey = key ?? window.__nextDeepSeekUserVirtualKey--;
        item.setAttribute('data-virtual-list-item-key', String(resolvedKey));
        const message = document.createElement('div');
        message.className = 'user-message ds-message';
        message.textContent = text;
        item.appendChild(message);
        document.getElementById('messages').appendChild(item);
        window.__lastProviderAdmissionAt = Date.now();
        return item;
      };
      window.__syncDeepSeekSend = () => {
        const enabled = composer.value.trim().length > 0 && !window.__forceNoFormDisabled;
        sendButton.classList.toggle('ds-button--disabled', !enabled);
        sendButton.style.opacity = enabled ? '1' : '0.4';
        sendButton.style.cursor = enabled ? 'pointer' : 'not-allowed';
      };
      composer.addEventListener('input', () => {
        window.__composerInputEvents += 1;
        window.__syncDeepSeekSend();
      });
      composer.addEventListener('keydown', event => {
        if (event.key === 'Enter') window.__enterSubmitEvents += 1;
      });
      capsule.addEventListener('click', () => { window.__capsuleClicks += 1; });
      outside.addEventListener('click', () => { window.__outsideSendClicks += 1; });
      sendButton.addEventListener('click', () => {
        window.__sendButtonClicks += 1;
        if (sendButton.classList.contains('ds-button--disabled')
          || sendButton.getAttribute('aria-disabled') === 'true'
          || sendButton.hasAttribute('inert')
          || getComputedStyle(sendButton).pointerEvents === 'none'
          || getComputedStyle(sendButton).cursor === 'not-allowed') return;
        window.__submitEvents += 1;
        const text = composer.value;
        window.__submittedMessages.push(text);
        const mode = window.__providerAdmissionMode;
        if (mode === 'admit' || mode === 'admit-retain') window.__appendDeepSeekUser(text);
        if (mode === 'mismatch') window.__appendDeepSeekUser(text + ' MISMATCH');
        if (mode === 'multiple') {
          window.__appendDeepSeekUser(text);
          window.__appendDeepSeekUser(text);
        }
        if (mode !== 'admit-retain') {
          composer.value = '';
          composer.dispatchEvent(new Event('input', { bubbles: true }));
        }
      });
      window.__syncDeepSeekSend();
    </script>
  </body>
</html>`;

const browser = await chromium.launch({ executablePath: edgePath, headless: true });
let invokeCount = 0;
let lastInvoke = null;
const r16Evidence = {};

async function pollWorkerUntil(page, inputId, expectedState, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let snapshot = null;
  while (Date.now() < deadline) {
    snapshot = await page.evaluate(id => window.__shuncodeWebMcp.workerPoll(id), inputId);
    if (snapshot.state === expectedState) return snapshot;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for worker turn ${inputId} to reach ${expectedState}; last=${JSON.stringify(snapshot)}`);
}

async function appendDeepSeekAssistant(page, text) {
  await page.evaluate(text => {
    window.__nextDeepSeekVirtualKey = (window.__nextDeepSeekVirtualKey || 0) + 1;
    const item = document.createElement('div');
    item.setAttribute('data-virtual-list-item-key', String(window.__nextDeepSeekVirtualKey));
    const response = document.createElement('div');
    response.className = 'ds-assistant-message-main-content';
    response.innerText = text;
    item.appendChild(response);
    document.getElementById('messages').appendChild(item);
  }, text);
}

async function appendDeepSeekAssistantAtVirtualKey(page, text, virtualKey) {
  await page.evaluate(({ text, virtualKey }) => {
    const item = document.createElement('div');
    item.setAttribute('data-virtual-list-item-key', String(virtualKey));
    const response = document.createElement('div');
    response.className = 'ds-assistant-message-main-content';
    response.innerText = text;
    item.appendChild(response);
    document.getElementById('messages').appendChild(item);
  }, { text, virtualKey });
}

async function createAdmissionScenarioPage(mode = 'admit', initialPath = '/chat', providerAdmissionTimeoutMs = 250) {
  const context = await browser.newContext();
  const page = await context.newPage();
  let genericInvokeCount = 0;
  await page.route('https://chat.deepseek.com/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/localbridge/webmcp/tools') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          tools: [{
            name: 'read_files',
            description: 'Read files',
            inputSchema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] },
          }],
        }),
      });
      return;
    }
    if (url.pathname === '/localbridge/webmcp/invoke') {
      genericInvokeCount += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, result: { content: [{ type: 'text', text: 'R16_GENERIC_INVOKE_SHOULD_BE_QUARANTINED' }] } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await page.goto('https://chat.deepseek.com' + initialPath, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ source, mode, providerAdmissionTimeoutMs }) => {
    window.__providerAdmissionMode = mode;
    const factory = (0, eval)(source);
    factory({
      bridge: 'https://chat.deepseek.com/localbridge',
      token: 'admission-regression-token',
      providerAdmissionTimeoutMs,
    });
  }, { source: composedSource, mode, providerAdmissionTimeoutMs });
  return { context, page, getGenericInvokeCount: () => genericInvokeCount };
}

async function createNoFormAdmissionScenarioPage(mode = 'admit', initialPath = '/chat') {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('https://chat.deepseek.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/localbridge/webmcp/tools') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          tools: [{
            name: 'read_files',
            description: 'Read files',
            inputSchema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] },
          }],
        }),
      });
      return;
    }
    if (url.pathname === '/localbridge/webmcp/invoke') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, result: { content: [{ type: 'text', text: 'NOFORM_PAGE_LOCAL_OK' }] } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: deepSeekNoFormHtml });
  });
  await page.goto('https://chat.deepseek.com' + initialPath, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ source, mode }) => {
    window.__providerAdmissionMode = mode;
    const factory = (0, eval)(source);
    factory({
      bridge: 'https://chat.deepseek.com/localbridge',
      token: 'no-form-admission-regression-token',
      providerAdmissionTimeoutMs: 250,
    });
  }, { source: composedSource, mode });
  return { context, page };
}

async function submissionCounters(page) {
  return await page.evaluate(() => ({
    submitEvents: window.__submitEvents,
    sendButtonClicks: window.__sendButtonClicks,
    requestSubmitCalls: window.__requestSubmitCalls,
    enterSubmitEvents: window.__enterSubmitEvents,
    composerInputEvents: window.__composerInputEvents,
    submitDiagnostic: window.__shuncodeWebMcp?.status?.().lastSubmitDiagnostic || null,
    providerUsers: [...document.querySelectorAll('.user-message')].map(element => ({
      identity: element.closest('[data-virtual-list-item-key]')?.getAttribute('data-virtual-list-item-key') || '',
      text: element.textContent || '',
    })),
  }));
}

async function rejectedWorkerSend(page, input) {
  return await page.evaluate(async input => {
    try {
      await window.__shuncodeWebMcp.workerSend(input);
      return { rejected: false, error: '' };
    } catch (error) {
      return { rejected: true, error: String(error?.message || error) };
    }
  }, input);
}

function hostManagedReadInput(inputId, prompt) {
  return {
    inputId,
    prompt,
    allowedCapabilities: ['read_files'],
    externalCapabilities: [{
      name: 'read_files',
      description: 'Read exact workspace files.',
      inputSchema: {
        type: 'object',
        properties: { files: { type: 'array' } },
        required: ['files'],
        additionalProperties: false,
      },
    }],
    extensions: { hostManagedCapabilities: true },
  };
}

const realPhase11R16ToolBlock = `[SHUNCODE_TOOL]
id=deliver-phase11-proof-021
name=nimora.coordinator.deliverExplicitMissionInput
arg={}
[/SHUNCODE_TOOL]`;

function hostManagedCoordinatorInput(inputId, prompt) {
  return {
    inputId,
    prompt,
    allowedCapabilities: ['nimora.coordinator.deliverExplicitMissionInput'],
    externalCapabilities: [{
      name: 'nimora.coordinator.deliverExplicitMissionInput',
      description: 'Invoke only the exact host-bound Coordinator semantic command for this turn.',
      inputSchema: { const: {} },
    }],
    extensions: { hostManagedCapabilities: true },
  };
}

try {
  // R14 continuation runtime marker — partial v25 exact-submit runtime must reinject for no-form association truth.
  {
    const legacyContext = await browser.newContext();
    const legacyPage = await legacyContext.newPage();
    await legacyPage.route('https://chat.deepseek.com/**', async route => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
    });
    await legacyPage.goto('https://chat.deepseek.com/chat', { waitUntil: 'domcontentloaded' });
    const reinjected = await legacyPage.evaluate(({ source }) => {
      let stopped = 0;
      window.__shuncodeWebMcp = {
        version: 25,
        matchesConfig: () => true,
        status: () => ({
          runningTurnPollScan: true,
          virtualizedOccurrenceIdentity: true,
          occurrenceScopedResultRouting: true,
          providerUserAdmissionTruth: true,
          exactSubmitControlTruth: true,
          exactSubmitActionabilityTruth: true,
        }),
        stop: () => { stopped += 1; },
      };
      const factory = (0, eval)(source);
      const status = factory({ bridge: 'https://chat.deepseek.com/localbridge', token: 'legacy-exact-submit-marker' });
      return { stopped, status };
    }, { source: composedSource });
    assert.equal(reinjected.stopped, 1, 'partial v25 runtime without deepSeekNoFormSubmitAssociationTruth must be stopped and reinjected');
    assert.equal(reinjected.status.exactSubmitControlTruth, true);
    assert.equal(reinjected.status.exactSubmitActionabilityTruth, true);
    assert.equal(reinjected.status.deepSeekNoFormSubmitAssociationTruth, true);
    assert.equal(reinjected.status.providerUserAdmissionTruth, true);
    await legacyContext.close();
  }

  // R14 semantic continuation runtime marker — the association-repaired v25 runtime must reinject without semantic truth.
  {
    const partialContext = await browser.newContext();
    const partialPage = await partialContext.newPage();
    await partialPage.route('https://chat.deepseek.com/**', async route => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
    });
    await partialPage.goto('https://chat.deepseek.com/chat', { waitUntil: 'domcontentloaded' });
    const reinjected = await partialPage.evaluate(({ source }) => {
      let stopped = 0;
      window.__shuncodeWebMcp = {
        version: 25,
        matchesConfig: () => true,
        status: () => ({
          runningTurnPollScan: true,
          virtualizedOccurrenceIdentity: true,
          occurrenceScopedResultRouting: true,
          providerUserAdmissionTruth: true,
          exactSubmitControlTruth: true,
          exactSubmitActionabilityTruth: true,
          deepSeekNoFormSubmitAssociationTruth: true,
        }),
        stop: () => { stopped += 1; },
      };
      const factory = (0, eval)(source);
      const status = factory({ bridge: 'https://chat.deepseek.com/localbridge', token: 'partial-no-form-semantic-marker' });
      return { stopped, status };
    }, { source: composedSource });
    assert.equal(reinjected.stopped, 1, 'partial v25 runtime without deepSeekNoFormSubmitSemanticTruth must be stopped and reinjected');
    assert.equal(reinjected.status.deepSeekNoFormSubmitAssociationTruth, true);
    assert.equal(reinjected.status.deepSeekNoFormSubmitSemanticTruth, true);
    await partialContext.close();
  }

  // R14 continuation runtime marker — repaired v25 runtime may early-return only with the semantic marker.
  {
    const currentContext = await browser.newContext();
    const currentPage = await currentContext.newPage();
    await currentPage.route('https://chat.deepseek.com/**', async route => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
    });
    await currentPage.goto('https://chat.deepseek.com/chat', { waitUntil: 'domcontentloaded' });
    const retained = await currentPage.evaluate(({ source }) => {
      let stopped = 0;
      const status = {
        version: 25,
        runningTurnPollScan: true,
        virtualizedOccurrenceIdentity: true,
        virtualizedResponseTextTruth: true,
        occurrenceScopedResultRouting: true,
        providerUserAdmissionTruth: true,
        providerAdmissionStabilizationTruth: true,
        admittedTurnOccurrenceGateTruth: true,
        failedTurnOccurrenceQuarantineTruth: true,
        toolOnlyCapabilityAdmissionLivenessTruth: true,
        hostManagedTerminalCapabilityGraceTruth: true,
        exactSubmitControlTruth: true,
        exactSubmitActionabilityTruth: true,
        deepSeekNoFormSubmitAssociationTruth: true,
        deepSeekNoFormSubmitSemanticTruth: true,
        stableUserAnchorAdmissionTruth: true,
        hostResultUncertainTerminalTruth: true,
      };
      window.__shuncodeWebMcp = {
        version: 25,
        matchesConfig: () => true,
        matchesImplementation: () => true,
        status: () => status,
        stop: () => { stopped += 1; },
      };
      const factory = (0, eval)(source);
      const returned = factory({ bridge: 'https://chat.deepseek.com/localbridge', token: 'repaired-exact-submit-marker' });
      return { stopped, returned };
    }, { source: composedSource });
    assert.equal(retained.stopped, 0, 'fully repaired v25 runtime may satisfy early-return compatibility');
    assert.equal(retained.returned.virtualizedResponseTextTruth, true);
    assert.equal(retained.returned.exactSubmitActionabilityTruth, true);
    assert.equal(retained.returned.deepSeekNoFormSubmitAssociationTruth, true);
    assert.equal(retained.returned.deepSeekNoFormSubmitSemanticTruth, true);
    assert.equal(retained.returned.providerAdmissionStabilizationTruth, true);
    assert.equal(retained.returned.admittedTurnOccurrenceGateTruth, true);
    assert.equal(retained.returned.failedTurnOccurrenceQuarantineTruth, true);
    assert.equal(retained.returned.toolOnlyCapabilityAdmissionLivenessTruth, true);
    assert.equal(retained.returned.hostManagedTerminalCapabilityGraceTruth, true);
    await currentContext.close();
  }

  // Retained tabs must identify actual module source/config, not v25 flags.
  // Upgrading a failed turn never dispatches a late old tool block.
  {
    const { context: revisionContext, page: revisionPage, getGenericInvokeCount } = await createAdmissionScenarioPage('clear-only');
    const rejected = await rejectedWorkerSend(revisionPage, hostManagedReadInput('revision-consumed', 'Never replay this failed request.'));
    assert.equal(rejected.rejected, true);
    await appendDeepSeekAssistantAtVirtualKey(revisionPage,
      '[SHUNCODE_TOOL]\nid=revision-old-call\nname=read_files\narg.files.0.path=old.txt\n[/SHUNCODE_TOOL]', 2);
    const revisedSource = composedSource.replace('const deepSeekUserSelectors', '/* exact source revision fixture */ const deepSeekUserSelectors');
    const upgraded = await revisionPage.evaluate(({ source, revisedSource }) => {
      const oldRuntime = window.__shuncodeWebMcp;
      const config = { bridge: 'https://chat.deepseek.com/localbridge', token: 'admission-regression-token', providerAdmissionTimeoutMs: 250 };
      (0, eval)(source)(config);
      const identicalRetained = window.__shuncodeWebMcp === oldRuntime;
      (0, eval)(revisedSource)(config);
      const newRuntime = window.__shuncodeWebMcp;
      (0, eval)(revisedSource)(config);
      return { identicalRetained, replaced: newRuntime !== oldRuntime, revisedRetained: window.__shuncodeWebMcp === newRuntime,
        originalDisabled: oldRuntime.status().enabled === false, turn: newRuntime.status().workerTurn };
    }, { source: composedSource, revisedSource });
    assert.equal(upgraded.identicalRetained, true);
    assert.equal(upgraded.replaced, true, 'same feature flags must not retain outdated module source');
    assert.equal(upgraded.revisedRetained, true);
    assert.equal(upgraded.originalDisabled, true);
    assert.equal(upgraded.turn, null, 'source activation must never revive the consumed input');
    await revisionPage.evaluate(async () => await window.__shuncodeWebMcp.scan());
    assert.equal(getGenericInvokeCount(), 0, 'historical block must not execute after source replacement');
    assert.equal(await revisionPage.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 0);
    const timeoutChanged = await revisionPage.evaluate(revisedSource => {
      const before = window.__shuncodeWebMcp;
      (0, eval)(revisedSource)({ bridge: 'https://chat.deepseek.com/localbridge', token: 'admission-regression-token', providerAdmissionTimeoutMs: 1000 });
      return window.__shuncodeWebMcp !== before;
    }, revisedSource);
    assert.equal(timeoutChanged, true, 'changed effective admission deadline must activate');
    await revisionContext.close();
  }

  // Discovery/source activation must not replace a runtime owning running work.
  {
    const { context: runningContext, page: runningPage } = await createAdmissionScenarioPage('admit');
    await runningPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({inputId: 'revision-running', prompt: 'Keep this running lease.'}));
    const runningGuard = await runningPage.evaluate(source => {
      const before = window.__shuncodeWebMcp;
      try {
        (0, eval)(source)({ bridge: 'https://chat.deepseek.com/localbridge', token: 'admission-regression-token', providerAdmissionTimeoutMs: 250 });
        return { rejected: false };
      } catch (error) {
        return { rejected: true, error: String(error.message), retained: before === window.__shuncodeWebMcp, enabled: before.status().enabled };
      }
    }, composedSource.replace('const deepSeekUserSelectors', '/* changed while running */ const deepSeekUserSelectors'));
    assert.equal(runningGuard.rejected, true);
    assert.match(runningGuard.error, /previous work is unsettled/);
    assert.equal(runningGuard.retained, true);
    assert.equal(runningGuard.enabled, true);
    await runningContext.close();
  }

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('https://chat.deepseek.com/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/localbridge/webmcp/tools') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          tools: [{
            name: 'read_files',
            description: 'Read files',
            inputSchema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] },
          }],
        }),
      });
      return;
    }
    if (url.pathname === '/localbridge/webmcp/invoke') {
      invokeCount += 1;
      lastInvoke = request.postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, result: { content: [{ type: 'text', text: 'SYNTHETIC_READ_OK' }] } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });

  await page.goto('https://chat.deepseek.com/chat', { waitUntil: 'domcontentloaded' });
  const status = await page.evaluate(({ source }) => {
    const factory = (0, eval)(source);
    return factory({ bridge: 'https://chat.deepseek.com/localbridge', token: 'synthetic-token' });
  }, { source: composedSource });
  assert.equal(status.version, 25);
  assert.equal(status.coreVersion, 1);
  assert.equal(status.siteAdapter, 'deepseek');
  assert.equal(status.exactSubmitActionabilityTruth, true);
  assert.equal(status.deepSeekNoFormSubmitAssociationTruth, true);
  assert.equal(status.deepSeekNoFormSubmitSemanticTruth, true);
  assert.equal(status.isDeepSeek, true);
  assert.equal(status.exactSubmitControlTruth, true);

  const prime = await page.evaluate(async () => await window.__shuncodeWebMcp.prime());
  assert.equal(prime.ok, true);
  assert.equal(prime.toolCount, 1);

  await appendDeepSeekAssistant(page, `[SHUNCODE_TOOL]\nid=synthetic-call-1\nname=read_files\narg.files.0.path=README.md\n[/SHUNCODE_TOOL]`);

  await page.waitForFunction(() => window.__submittedMessages.some(text => text.includes('[SHUNCODE_TOOL_RESULT]') && text.includes('SYNTHETIC_READ_OK')), null, { timeout: 10000 });
  try {
    await page.waitForFunction(() => window.__shuncodeWebMcp?.status?.().pendingDeliveries === 0, null, { timeout: 10000 });
  } catch (error) {
    console.error('[smoke] pending delivery diagnostic', await page.evaluate(() => window.__shuncodeWebMcp?.status?.()));
    throw error;
  }
  assert.equal(invokeCount, 1);
  assert.equal(lastInvoke.name, 'read_files');
  assert.equal(lastInvoke.arguments.files[0].path, 'README.md');
  assert.equal(lastInvoke.page.origin, 'https://chat.deepseek.com');

  const afterDelivery = await page.evaluate(() => window.__shuncodeWebMcp.status());
  assert.equal(afterDelivery.pendingDeliveries, 0);
  assert.equal(afterDelivery.seen, 1);

  await page.evaluate(() => {
    document.getElementById('messages').appendChild(document.createTextNode('mutation-after-delivery'));
    window.__shuncodeWebMcp.scan();
  });
  await page.waitForTimeout(700);
  assert.equal(invokeCount, 1, 'repeated DOM scans must never re-run a completed tool occurrence');

  const submitted = await page.evaluate(() => [...window.__submittedMessages]);
  assert.ok(submitted[0].includes('SHUNCODE_WEBMCP_CONTEXT_V25'));
  assert.match(submitted[0], /DEEPSEEK TRANSPORT RULE/);
  assert.ok(submitted.some(text => text.includes('SYNTHETIC_READ_OK')));

  await context.close();

  const bindingContext = await browser.newContext();
  const bindingPage = await bindingContext.newPage();
  const bindingListName = '__shuncodeListTools_smoke';
  const bindingInvokeName = '__shuncodeInvokeTool_smoke';
  let bindingInvokeCount = 0;
  let bindingInvokeArgs = null;
  await bindingPage.exposeFunction(bindingListName, async token => {
    assert.equal(token, 'binding-token');
    return [{
      name: 'read_files',
      description: 'Read files',
      inputSchema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] },
    }];
  });
  await bindingPage.exposeFunction(bindingInvokeName, async (token, name, args) => {
    assert.equal(token, 'binding-token');
    bindingInvokeCount += 1;
    bindingInvokeArgs = { name, args };
    return { content: [{ type: 'text', text: 'BINDING_READ_OK' }] };
  });
  await bindingPage.route('https://chat.deepseek.com/**', async route => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await bindingPage.goto('https://chat.deepseek.com/chat', { waitUntil: 'domcontentloaded' });
  const bindingStatus = await bindingPage.evaluate(({ source, listBinding, invokeBinding }) => {
    const factory = (0, eval)(source);
    return factory({ token: 'binding-token', listBinding, invokeBinding });
  }, { source: composedSource, listBinding: bindingListName, invokeBinding: bindingInvokeName });
  assert.equal(bindingStatus.version, 25);
  assert.equal(bindingStatus.siteAdapter, 'deepseek');
  assert.equal(bindingStatus.transport, 'binding');
  const bindingPrime = await bindingPage.evaluate(async () => await window.__shuncodeWebMcp.prime());
  assert.equal(bindingPrime.toolCount, 1);
  await appendDeepSeekAssistant(bindingPage, `[SHUNCODE_TOOL]\nid=binding-call-1\nname=read_files\narg.files.0.path=README.md\n[/SHUNCODE_TOOL]`);
  await bindingPage.waitForFunction(() => window.__submittedMessages.some(text => text.includes('[SHUNCODE_TOOL_RESULT]') && text.includes('BINDING_READ_OK')), null, { timeout: 10000 });
  await bindingPage.waitForFunction(() => window.__shuncodeWebMcp?.status?.().pendingDeliveries === 0, null, { timeout: 10000 });
  assert.equal(bindingInvokeCount, 1);
  assert.equal(bindingInvokeArgs.name, 'read_files');
  assert.equal(bindingInvokeArgs.args.files[0].path, 'README.md');
  await bindingContext.close();

  // Regression for the live report failure: ordinary Markdown consumes the
  // context-list marker and '+' before a bold addition. A text code block must
  // carry the literal request through the real adapter and core unchanged.
  const patchRenderContext = await browser.newContext();
  const patchRenderPage = await patchRenderContext.newPage();
  await patchRenderPage.setContent('<main><div id="plain"></div><div id="fenced"><pre><code></code></pre></div></main>');
  const renderPatch = '*** Begin Patch\n*** Update File: TEST_REPORT.md\n@@\n 7. Existing ordered list\n+\n+**Source:** independent checks\n+```html\n+<button>Example</button>\n+```\n*** End Patch';
  const patchRenderResult = await patchRenderPage.evaluate(({ siteSource, coreSource, patch }) => {
    const adapter = (0, eval)(siteSource)({ window, document, location: { hostname: 'chat.deepseek.com' }, visible: () => true });
    const core = (0, eval)(coreSource)();
    const header = '[SHUNCODE_TOOL]\nid=render-patch\nname=apply_patch\narg.expected_versions={"TEST_REPORT.md":"sha256:abc"}\narg.patch<<SHUNCODE_EOF\n';
    const footer = '\nSHUNCODE_EOF\n[/SHUNCODE_TOOL]';
    document.querySelector('#fenced code').textContent = header + patch + footer;
    const plain = document.querySelector('#plain');
    plain.innerHTML = '<p>*** Begin Patch<br>*** Update File: TEST_REPORT.md<br>@@</p><ol start="7"><li>Existing ordered list</li></ol><p>+</p><ul><li><strong>Source:</strong> independent checks</li></ul><p>*** End Patch</p>';
    return {
      plain: adapter.assistantMessageText(plain),
      calls: core.extractCalls(adapter.assistantMessageText(document.querySelector('#fenced'))),
    };
  }, { siteSource, coreSource, patch: renderPatch });
  assert.ok(!patchRenderResult.plain.includes(' 7. Existing ordered list'), 'ordinary rendered lists lose the literal patch context');
  assert.ok(!patchRenderResult.plain.includes('+**Source:**'), 'ordinary rendered list/bold additions lose patch syntax');
  assert.equal(patchRenderResult.calls.length, 1);
  assert.equal(patchRenderResult.calls[0].arguments.patch, renderPatch, 'code-rendered line protocol preserves every patch prefix through production adapter/core');
  assert.deepEqual(patchRenderResult.calls[0].arguments.expected_versions, { 'TEST_REPORT.md': 'sha256:abc' });
  await patchRenderContext.close();

  const workerContext = await browser.newContext();
  const workerPage = await workerContext.newPage();
  const workerListName = '__shuncodeListTools_worker_smoke';
  const workerInvokeName = '__shuncodeInvokeTool_worker_smoke';
  let workerInvokeCount = 0;
  await workerPage.exposeFunction(workerListName, async token => {
    assert.equal(token, 'worker-token');
    return [{
      name: 'read_files',
      description: 'Read files',
      inputSchema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] },
    }];
  });
  await workerPage.exposeFunction(workerInvokeName, async (token, name, args) => {
    assert.equal(token, 'worker-token');
    workerInvokeCount += 1;
    assert.equal(name, 'read_files');
    assert.equal(args.files[0].path, 'README.md');
    return { content: [{ type: 'text', text: 'WORKER_READ_OK' }] };
  });
  await workerPage.route('https://chat.deepseek.com/**', async route => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await workerPage.goto('https://chat.deepseek.com/chat', { waitUntil: 'domcontentloaded' });
  await workerPage.evaluate(({ source, listBinding, invokeBinding }) => {
    const factory = (0, eval)(source);
    factory({ token: 'worker-token', listBinding, invokeBinding });
  }, { source: composedSource, listBinding: workerListName, invokeBinding: workerInvokeName });
  await workerPage.evaluate(async () => await window.__shuncodeWebMcp.prime());
  const workerSession = await workerPage.evaluate(() => window.__shuncodeWebMcp.workerSession());
  assert.ok(workerSession.sessionId);
  assert.equal(workerSession.site, 'deepseek');
  assert.equal(workerSession.transport, 'binding');

  const plainStart = await workerPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({ inputId: 'worker-plain-1', prompt: 'Reply with a plain worker response.' }));
  assert.equal(plainStart.state, 'running');
  await appendDeepSeekAssistant(workerPage, 'PLAIN_WORKER_OK');
  const plainDone = await pollWorkerUntil(workerPage, 'worker-plain-1', 'completed');
  assert.equal(plainDone.state, 'completed');
  assert.equal(plainDone.text, 'PLAIN_WORKER_OK');
  assert.ok(plainDone.events.some(event => event.type === 'assistant_text' && event.text.includes('PLAIN_WORKER_OK')));
  assert.ok(plainDone.events.some(event => event.type === 'completed'));

  // A host-managed zero-capability Cognition turn is pure text. Do not teach
  // the provider the tool protocol, and if it still emits a malformed tool-like
  // block, surface that stable text to the owning JSON parser instead of waiting
  // for the five-minute no-progress timeout or sending a capability rejection.
  const zeroToolStart = await workerPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({
    inputId: 'worker-host-managed-zero-tools',
    prompt: 'Return exactly one JSON object and no markdown.',
    allowedCapabilities: [],
    externalCapabilities: [],
    extensions: { hostManagedCapabilities: true },
  }));
  assert.equal(zeroToolStart.state, 'running');
  const zeroToolSubmitted = await workerPage.evaluate(() => window.__submittedMessages.at(-1));
  assert.doesNotMatch(zeroToolSubmitted, /TRANSPORT RULE|id=unique-call-id|name=TOOL_NAME/,
    'zero-capability turns must not expose a tool-call tutorial');
  assert.match(zeroToolSubmitted, /No ShunCode capability is admitted for this turn/);
  await appendDeepSeekAssistant(workerPage, 'text\n[SHUNCODE_TOOL]\nid=none\nname=\n[/SHUNCODE_TOOL]');
  const zeroToolDone = await pollWorkerUntil(workerPage, 'worker-host-managed-zero-tools', 'completed');
  assert.equal(zeroToolDone.state, 'completed');
  assert.match(zeroToolDone.text, /\[SHUNCODE_TOOL\]/,
    'malformed tool-like output must be returned as text for the owning parser to reject');
  assert.equal(zeroToolDone.toolCallCount, 0);
  assert.equal(await workerPage.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 0);
  assert.equal(workerInvokeCount, 0, 'zero-capability malformed output must never invoke a page-local tool');

  const toolStart = await workerPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({ inputId: 'worker-tool-1', prompt: 'Read README.md, then answer.' }));
  assert.equal(toolStart.state, 'running');
  await appendDeepSeekAssistant(workerPage, `[SHUNCODE_TOOL]\nid=worker-call-1\nname=read_files\narg.files.0.path=README.md\n[/SHUNCODE_TOOL]`);
  await workerPage.waitForFunction(() => window.__submittedMessages.some(text => text.includes('[SHUNCODE_TOOL_RESULT]') && text.includes('WORKER_READ_OK')), null, { timeout: 10000 });
  await workerPage.waitForFunction(() => window.__shuncodeWebMcp.status().pendingDeliveries === 0, null, { timeout: 10000 });
  const afterToolDelivery = await workerPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('worker-tool-1'));
  assert.equal(afterToolDelivery.state, 'running', 'tool result delivery must not complete the turn before a post-tool assistant response');
  assert.equal(afterToolDelivery.toolCallCount, 1);
  assert.equal(afterToolDelivery.text, '');
  assert.ok(afterToolDelivery.events.some(event => event.type === 'capability_call' && event.name === 'read_files'));
  assert.ok(afterToolDelivery.events.some(event => event.type === 'capability_result' && event.text.includes('WORKER_READ_OK')));
  assert.ok(afterToolDelivery.events.some(event => event.type === 'status' && event.name === 'capability_result_delivered'));
  assert.equal(workerInvokeCount, 1);
  await appendDeepSeekAssistant(workerPage, 'TOOL_WORKER_FINAL');
  const toolDone = await pollWorkerUntil(workerPage, 'worker-tool-1', 'completed');
  assert.equal(toolDone.state, 'completed');
  assert.equal(toolDone.text, 'TOOL_WORKER_FINAL');
  assert.ok(!toolDone.events.some(event => event.type === 'assistant_text' && event.text.includes('[SHUNCODE_TOOL]')));

  await assert.rejects(
    () => workerPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({
      inputId: 'worker-host-managed-invalid',
      prompt: 'This must fail closed because the schema is missing.',
      allowedCapabilities: ['read_files'],
      extensions: { hostManagedCapabilities: true },
    })),
    /Host-managed WebMCP capability scope is inconsistent/,
  );
  const hostManagedStart = await workerPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({
    inputId: 'worker-host-managed-1',
    prompt: 'Request read_files and wait for the host result.',
    allowedCapabilities: ['read_files'],
    externalCapabilities: [{
      name: 'read_files',
      description: 'Read exact workspace files.',
      inputSchema: {
        type: 'object',
        required: ['files'],
        properties: { files: { type: 'array' } },
        additionalProperties: false,
      },
    }],
    extensions: { hostManagedCapabilities: true },
  }));
  assert.equal(hostManagedStart.state, 'running');
  await appendDeepSeekAssistant(workerPage, `[SHUNCODE_TOOL]\nid=host-managed-call-1\nname=read_files\narg.files.0.path=README.md\n[/SHUNCODE_TOOL]`);
  await workerPage.waitForFunction(() => window.__shuncodeWebMcp.status().pendingHostCapabilities === 1, null, { timeout: 10000 });
  const hostManagedPending = await workerPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('worker-host-managed-1'));
  const hostManagedCall = hostManagedPending.events.find(event => event.type === 'capability_call' && event.callId === 'host-managed-call-1');
  assert.equal(hostManagedCall.dispatch, 'host-requested');
  assert.ok(hostManagedCall.occurrenceId);
  assert.equal(hostManagedPending.events.some(event => event.type === 'capability_result' && event.callId === 'host-managed-call-1'), false);
  assert.equal(workerInvokeCount, 1, 'host-managed capability must not call the page-local invoke binding');
  await workerPage.evaluate(async occurrenceId => await window.__shuncodeWebMcp.workerResolveCapability({
    inputId: 'worker-host-managed-1', callId: 'host-managed-call-1', name: 'read_files', text: 'HOST_MANAGED_READ_OK', isError: false,
    extensions: { occurrenceId },
  }), hostManagedCall.occurrenceId);
  assert.equal(await workerPage.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 0);
  await workerPage.waitForFunction(() => window.__submittedMessages.some(text => text.includes('[SHUNCODE_TOOL_RESULT]') && text.includes('HOST_MANAGED_READ_OK')), null, { timeout: 10000 });
  await appendDeepSeekAssistant(workerPage, 'HOST_MANAGED_WORKER_FINAL');
  const hostManagedDone = await pollWorkerUntil(workerPage, 'worker-host-managed-1', 'completed');
  assert.equal(hostManagedDone.text, 'HOST_MANAGED_WORKER_FINAL');
  assert.equal(workerInvokeCount, 1);

  const hostResultStart = await workerPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({ inputId: 'worker-host-result-1', prompt: 'Wait for a host-managed capability result, then continue.' }));
  assert.equal(hostResultStart.state, 'running');
  const hostResolveInput = { inputId: 'worker-host-result-1', callId: 'host-call-1', name: 'read_files', text: 'HOST_RESULT_OK', isError: false };
  const firstResolve = await workerPage.evaluate(async input => await window.__shuncodeWebMcp.workerResolveCapability(input), hostResolveInput);
  assert.equal(firstResolve.state, 'running');
  const secondResolve = await workerPage.evaluate(async input => await window.__shuncodeWebMcp.workerResolveCapability(input), hostResolveInput);
  assert.equal(secondResolve.state, 'running');
  await workerPage.waitForFunction(() => window.__submittedMessages.some(text => text.includes('[SHUNCODE_TOOL_RESULT]') && text.includes('HOST_RESULT_OK')), null, { timeout: 10000 });
  const hostResultMessages = await workerPage.evaluate(() => window.__submittedMessages.filter(text => text.includes('[SHUNCODE_TOOL_RESULT]') && text.includes('HOST_RESULT_OK')));
  assert.equal(hostResultMessages.length, 1, 'retrying the same host result must not inject it twice after confirmed delivery');
  const hostResolvedTurn = await workerPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('worker-host-result-1'));
  assert.equal(hostResolvedTurn.events.filter(event => event.type === 'capability_result' && event.callId === 'host-call-1').length, 1);
  assert.equal(hostResolvedTurn.events.filter(event => event.type === 'status' && event.name === 'capability_result_delivered' && event.callId === 'host-call-1').length, 1);
  await appendDeepSeekAssistant(workerPage, 'HOST_RESULT_WORKER_FINAL');
  const hostResultDone = await pollWorkerUntil(workerPage, 'worker-host-result-1', 'completed');
  assert.equal(hostResultDone.text, 'HOST_RESULT_WORKER_FINAL');

  const interruptStart = await workerPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({
    inputId: 'worker-cancel-1',
    prompt: 'Start a long response that requests one host capability.',
    allowedCapabilities: ['read_files'],
    externalCapabilities: [{
      name: 'read_files',
      description: 'Read exact workspace files.',
      inputSchema: { type: 'object', properties: { files: { type: 'array' } } },
    }],
    extensions: { hostManagedCapabilities: true },
  }));
  assert.equal(interruptStart.state, 'running');
  await appendDeepSeekAssistant(workerPage, `[SHUNCODE_TOOL]\nid=cancel-host-call-1\nname=read_files\narg.files.0.path=README.md\n[/SHUNCODE_TOOL]`);
  await workerPage.waitForFunction(() => window.__shuncodeWebMcp.status().pendingHostCapabilities === 1, null, { timeout: 10000 });
  await workerPage.evaluate(() => {
    window.__stopClicked = false;
    const stop = document.createElement('button');
    stop.setAttribute('aria-label', 'Stop generating');
    stop.textContent = 'Stop';
    stop.addEventListener('click', () => { window.__stopClicked = true; });
    document.body.appendChild(stop);
  });
  const interrupted = await workerPage.evaluate(async () => await window.__shuncodeWebMcp.workerInterrupt('worker-cancel-1'));
  assert.equal(interrupted, true);
  assert.equal(await workerPage.evaluate(() => window.__stopClicked), true);
  assert.equal(await workerPage.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 0, 'cancelled page turn must not keep an unexecuted host capability live');
  const cancelled = await workerPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('worker-cancel-1'));
  assert.equal(cancelled.state, 'cancelled');
  assert.ok(cancelled.events.some(event => event.type === 'cancelled'));
  await workerContext.close();

  // R14 exact-submit authority — broad toolbar/message labels are never submit identity.
  for (const [inputId, label] of [
    ['r14-submit-message-settings', 'Message settings'],
    ['r14-submit-send-settings', 'send settings'],
    ['r14-submit-message-options', 'message options'],
    ['r14-submit-preferences', 'submit preferences'],
  ]) {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('clear-only');
    await admissionPage.evaluate(label => {
      const form = document.getElementById('composer-form');
      const realSend = form.querySelector('button[type="submit"]');
      realSend.type = 'button';
      realSend.removeAttribute('aria-label');
      realSend.removeAttribute('title');
      realSend.textContent = '';
      window.__nonSendToolbarClicks = 0;
      const toolbar = document.createElement('button');
      toolbar.type = 'button';
      toolbar.setAttribute('aria-label', label);
      toolbar.textContent = label;
      toolbar.addEventListener('click', () => { window.__nonSendToolbarClicks += 1; });
      form.appendChild(toolbar);
    }, label);
    const rejected = await rejectedWorkerSend(admissionPage, { inputId, prompt: 'R14_EXACT_SUBMIT_REQUIRED' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /exact chat submit control is missing/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.composerInputEvents, 0, 'missing exact submit identity must fail before composer mutation');
    assert.equal(await admissionPage.evaluate(() => window.__nonSendToolbarClicks), 0, `${label} must never be clicked as submit authority`);
    assert.equal(counters.submitDiagnostic?.state, 'missing');
    assert.equal(counters.submitDiagnostic?.candidateCount, 0);
    await admissionContext.close();
  }

  // R14 exact-submit authority — duplicate exact Send controls fail before any gesture.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('clear-only');
    await admissionPage.evaluate(() => {
      window.__duplicateSendClicks = 0;
      const duplicate = document.createElement('button');
      duplicate.type = 'button';
      duplicate.setAttribute('aria-label', 'Send');
      duplicate.textContent = 'Send';
      duplicate.addEventListener('click', () => { window.__duplicateSendClicks += 1; });
      document.getElementById('composer-form').appendChild(duplicate);
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-submit-ambiguous', prompt: 'R14_AMBIGUOUS_SUBMIT' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /exact chat submit control is ambiguous \(2 admissible controls\)/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(await admissionPage.evaluate(() => window.__duplicateSendClicks), 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.composerInputEvents, 0, 'ambiguous submit identity must fail before composer mutation');
    assert.equal(counters.submitDiagnostic?.state, 'ambiguous');
    assert.equal(counters.submitDiagnostic?.candidateCount, 2);
    await admissionContext.close();
  }

  // R14 exact-submit authority — disabled control may be identified while empty, but never gestures if it stays disabled.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('clear-only');
    await admissionPage.evaluate(() => {
      const send = document.querySelector('#composer-form button[type="submit"]');
      send.disabled = true;
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-submit-disabled', prompt: 'R14_DISABLED_SUBMIT' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /not effectively enabled after composer fill/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.ok(counters.composerInputEvents > 0, 'disabled-until-filled control is allowed a composer fill but no submit gesture');
    assert.equal(counters.submitDiagnostic?.state, 'disabled-after-fill');
    await admissionContext.close();
  }

  // R14 exact-submit authority — missing exact control fails before composer mutation.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('clear-only');
    await admissionPage.evaluate(() => {
      document.querySelector('#composer-form button[type="submit"]').remove();
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-submit-missing', prompt: 'R14_MISSING_SUBMIT' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /exact chat submit control is missing/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.composerInputEvents, 0, 'missing exact submit identity must not mutate the composer');
    assert.equal(counters.submitDiagnostic?.state, 'missing');
    await admissionContext.close();
  }

  // R14 actionability — hidden/non-interactive exact controls are never provider gesture authority.
  for (const [inputId, mutation] of [
    ['r14-visibility-hidden', { style: ['visibility', 'hidden'] }],
    ['r14-opacity-zero', { style: ['opacity', '0'] }],
    ['r14-pointer-events-none', { style: ['pointerEvents', 'none'] }],
    ['r14-aria-hidden', { attr: ['aria-hidden', 'true'] }],
    ['r14-inert', { attr: ['inert', ''] }],
  ]) {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('clear-only');
    await admissionPage.evaluate(mutation => {
      const send = document.querySelector('#composer-form button[type="submit"]');
      if (mutation.style) send.style[mutation.style[0]] = mutation.style[1];
      if (mutation.attr) send.setAttribute(mutation.attr[0], mutation.attr[1]);
    }, mutation);
    const rejected = await rejectedWorkerSend(admissionPage, { inputId, prompt: 'R14_NON_ACTIONABLE' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /missing or not actionable/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.composerInputEvents, 0);
    assert.equal(counters.providerUsers.length, 0);
    assert.equal(counters.submitDiagnostic?.state, 'missing');
    await admissionContext.close();
  }

  // R14 effective-enabled — aria-disabled is not provider gesture authority.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('clear-only');
    await admissionPage.evaluate(() => {
      document.querySelector('#composer-form button[type="submit"]').setAttribute('aria-disabled', 'true');
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-aria-disabled', prompt: 'R14_ARIA_DISABLED' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /not effectively enabled after composer fill/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.ok(counters.composerInputEvents > 0);
    assert.equal(counters.submitDiagnostic?.state, 'disabled-after-fill');
    await admissionContext.close();
  }

  // R14 effective-enabled / gesture accounting — disabled fieldset is :disabled and must not consume the occurrence gesture key.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('clear-only');
    await admissionPage.evaluate(() => {
      const form = document.getElementById('composer-form');
      const send = form.querySelector('button[type="submit"]');
      const fieldset = document.createElement('fieldset');
      fieldset.id = 'disabled-submit-owner';
      fieldset.disabled = true;
      send.replaceWith(fieldset);
      fieldset.appendChild(send);
    });
    const input = { inputId: 'r14-fieldset-disabled-key', prompt: 'R14_FIELDSET_DISABLED' };
    const first = await rejectedWorkerSend(admissionPage, input);
    assert.equal(first.rejected, true);
    assert.match(first.error, /not effectively enabled after composer fill/i);
    let counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.submitDiagnostic?.state, 'disabled-after-fill');
    await admissionPage.evaluate(() => {
      document.getElementById('disabled-submit-owner').disabled = false;
      window.__providerAdmissionMode = 'admit';
    });
    const retry = await admissionPage.evaluate(async input => await window.__shuncodeWebMcp.workerSend(input), input);
    counters = await submissionCounters(admissionPage);
    assert.equal(retry.state, 'running', 'same occurrence may continue after a true pre-gesture failure because its gesture key was not consumed');
    assert.ok(retry.sentAt);
    assert.equal(counters.submitEvents, 1);
    assert.equal(counters.sendButtonClicks, 1);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    await admissionContext.close();
  }

  // R14 association — a no-form composer never scans unrelated page-level Send buttons.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('clear-only');
    await admissionPage.evaluate(() => {
      const composer = document.querySelector('#composer-form textarea');
      document.body.appendChild(composer);
      window.__unrelatedSendClicks = 0;
      const unrelated = document.createElement('button');
      unrelated.setAttribute('aria-label', 'Send');
      unrelated.textContent = 'Send';
      unrelated.addEventListener('click', () => { window.__unrelatedSendClicks += 1; });
      document.body.appendChild(unrelated);
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-no-form', prompt: 'R14_NO_FORM' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /association is missing/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(await admissionPage.evaluate(() => window.__unrelatedSendClicks), 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.composerInputEvents, 0);
    assert.equal(counters.submitDiagnostic?.state, 'association-missing');
    await admissionContext.close();
  }

  // R14 live-shape A — exact no-form Send may be recognized while empty/disabled but cannot gesture until enabled.
  {
    const { context: admissionContext, page: admissionPage } = await createNoFormAdmissionScenarioPage('admit');
    await admissionPage.evaluate(() => {
      window.__forceNoFormDisabled = true;
      window.__syncDeepSeekSend();
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-noform-disabled-empty', prompt: 'R14_NOFORM_DISABLED_EMPTY' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /not effectively enabled after composer fill/i);
    const counters = await submissionCounters(admissionPage);
    assert.ok(counters.composerInputEvents > 0, 'disabled-empty no-form candidate must be identified before fill rather than rejected as association-missing');
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.submitDiagnostic?.state, 'disabled-after-fill');
    await admissionContext.close();
  }

  // R14 live-shape B/C/D/H — fill enables the same Send once; capsule/outside controls stay untouched; hashed tokens are irrelevant.
  {
    const { context: admissionContext, page: admissionPage } = await createNoFormAdmissionScenarioPage('admit');
    await admissionPage.evaluate(() => {
      document.getElementById('composer-shell').classList.replace('_020ab5b', '_differentShellHash');
      document.getElementById('deepseek-send').classList.replace('_52c986b', '_differentSendHash');
    });
    const start = await admissionPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({
      inputId: 'r14-noform-valid',
      prompt: 'R14_NOFORM_VALID',
    }));
    const counters = await submissionCounters(admissionPage);
    const sideClicks = await admissionPage.evaluate(() => ({
      capsule: window.__capsuleClicks,
      outside: window.__outsideSendClicks,
    }));
    assert.equal(start.state, 'running');
    assert.ok(start.sentAt);
    assert.equal(counters.submitEvents, 1);
    assert.equal(counters.sendButtonClicks, 1);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(sideClicks.capsule, 0);
    assert.equal(sideClicks.outside, 0);
    assert.deepEqual(counters.providerUsers.map(value => value.text), ['R14_NOFORM_VALID']);
    await admissionContext.close();
  }

  // R14 no-form semantic precedence — explicit non-Send aria-label conflicts before composer mutation.
  {
    const { context: admissionContext, page: admissionPage } = await createNoFormAdmissionScenarioPage('admit');
    await admissionPage.evaluate(() => {
      const send = document.getElementById('deepseek-send');
      send.setAttribute('aria-label', 'Message settings');
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-noform-semantic-aria-conflict', prompt: 'R14_NOFORM_SEMANTIC_ARIA_CONFLICT' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /semantic conflicts/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.composerInputEvents, 0);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.submitDiagnostic?.state, 'semantic-conflict');
    assert.equal(counters.submitDiagnostic?.semantic, 'aria-label:Message settings');
    await admissionContext.close();
  }

  // R14 no-form semantic precedence — lower-priority exact title cannot override conflicting aria-label.
  {
    const { context: admissionContext, page: admissionPage } = await createNoFormAdmissionScenarioPage('admit');
    await admissionPage.evaluate(() => {
      const send = document.getElementById('deepseek-send');
      send.setAttribute('aria-label', 'Message settings');
      send.setAttribute('title', 'Send');
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-noform-semantic-aria-title-conflict', prompt: 'R14_NOFORM_SEMANTIC_ARIA_TITLE_CONFLICT' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /semantic conflicts/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.composerInputEvents, 0);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.submitDiagnostic?.state, 'semantic-conflict');
    assert.equal(counters.submitDiagnostic?.semantic, 'aria-label:Message settings');
    await admissionContext.close();
  }

  // R14 no-form semantic precedence — lower-priority exact text cannot override conflicting title when aria is empty.
  {
    const { context: admissionContext, page: admissionPage } = await createNoFormAdmissionScenarioPage('admit');
    await admissionPage.evaluate(() => {
      const send = document.getElementById('deepseek-send');
      send.removeAttribute('aria-label');
      send.setAttribute('title', 'Message settings');
      send.textContent = 'Send';
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-noform-semantic-title-text-conflict', prompt: 'R14_NOFORM_SEMANTIC_TITLE_TEXT_CONFLICT' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /semantic conflicts/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.composerInputEvents, 0);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.submitDiagnostic?.state, 'semantic-conflict');
    assert.equal(counters.submitDiagnostic?.semantic, 'title:Message settings');
    await admissionContext.close();
  }

  // R14 no-form semantic precedence — exact explicit aria-label Send remains admissible.
  {
    const { context: admissionContext, page: admissionPage } = await createNoFormAdmissionScenarioPage('admit');
    await admissionPage.evaluate(() => {
      document.getElementById('deepseek-send').setAttribute('aria-label', 'Send');
    });
    const start = await admissionPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({
      inputId: 'r14-noform-semantic-exact-aria',
      prompt: 'R14_NOFORM_SEMANTIC_EXACT_ARIA',
    }));
    const counters = await submissionCounters(admissionPage);
    assert.equal(start.state, 'running');
    assert.ok(start.sentAt);
    assert.equal(counters.submitEvents, 1);
    assert.equal(counters.sendButtonClicks, 1);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.deepEqual(counters.providerUsers.map(value => value.text), ['R14_NOFORM_SEMANTIC_EXACT_ARIA']);
    await admissionContext.close();
  }

  // R14 no-form semantic fallback — current live shape with no aria/title/text remains token-authorized.
  {
    const { context: admissionContext, page: admissionPage } = await createNoFormAdmissionScenarioPage('admit');
    const explicitBefore = await admissionPage.evaluate(() => {
      const send = document.getElementById('deepseek-send');
      return {
        aria: send.getAttribute('aria-label') || '',
        title: send.getAttribute('title') || '',
        text: String(send.textContent || '').trim(),
      };
    });
    assert.deepEqual(explicitBefore, { aria: '', title: '', text: '' });
    const start = await admissionPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({
      inputId: 'r14-noform-semantic-token-fallback',
      prompt: 'R14_NOFORM_SEMANTIC_TOKEN_FALLBACK',
    }));
    const counters = await submissionCounters(admissionPage);
    assert.equal(start.state, 'running');
    assert.ok(start.sentAt);
    assert.equal(counters.submitEvents, 1);
    assert.equal(counters.sendButtonClicks, 1);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.deepEqual(counters.providerUsers.map(value => value.text), ['R14_NOFORM_SEMANTIC_TOKEN_FALLBACK']);
    await admissionContext.close();
  }

  // R14 live-shape E — duplicate matching Send controls inside the shell are ambiguous before composer mutation.
  {
    const { context: admissionContext, page: admissionPage } = await createNoFormAdmissionScenarioPage('admit');
    await admissionPage.evaluate(() => {
      const send = document.getElementById('deepseek-send');
      const duplicate = send.cloneNode(true);
      duplicate.id = 'deepseek-send-duplicate';
      send.parentElement.appendChild(duplicate);
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-noform-duplicate', prompt: 'R14_NOFORM_DUPLICATE' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /ambiguous/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.composerInputEvents, 0);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.submitDiagnostic?.state, 'ambiguous');
    await admissionContext.close();
  }

  // R14 live-shape F — missing narrow shell fails closed rather than expanding to page/root controls.
  {
    const { context: admissionContext, page: admissionPage } = await createNoFormAdmissionScenarioPage('admit');
    await admissionPage.evaluate(() => {
      document.body.appendChild(document.getElementById('deepseek-composer'));
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-noform-shell-missing', prompt: 'R14_NOFORM_SHELL_MISSING' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /association is missing/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.composerInputEvents, 0);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(await admissionPage.evaluate(() => window.__outsideSendClicks), 0);
    await admissionContext.close();
  }

  // R14 live-shape G — a shell without the complete provider Send token-set fails closed.
  {
    const { context: admissionContext, page: admissionPage } = await createNoFormAdmissionScenarioPage('admit');
    await admissionPage.evaluate(() => {
      document.getElementById('deepseek-send').classList.remove('ds-button--filled');
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-noform-send-missing', prompt: 'R14_NOFORM_SEND_MISSING' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /association is missing|submit control is missing/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.composerInputEvents, 0);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    await admissionContext.close();
  }

  // R14 live-shape I — generic/non-DeepSeek pages never inherit provider-specific no-form token authority.
  {
    const genericContext = await browser.newContext();
    const genericPage = await genericContext.newPage();
    await genericPage.route('https://example.com/**', async route => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: deepSeekNoFormHtml });
    });
    await genericPage.goto('https://example.com/chat', { waitUntil: 'domcontentloaded' });
    await genericPage.evaluate(source => {
      const factory = (0, eval)(source);
      factory({ bridge: 'https://example.com/localbridge', token: 'generic-no-form-token', providerAdmissionTimeoutMs: 250 });
    }, composedSource);
    const rejected = await rejectedWorkerSend(genericPage, { inputId: 'r14-generic-noform', prompt: 'R14_GENERIC_NOFORM' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /association is missing/i);
    assert.equal(await genericPage.evaluate(() => window.__sendButtonClicks), 0);
    assert.equal(await genericPage.evaluate(() => window.__composerInputEvents), 0);
    await genericContext.close();
  }

  // R14 live-shape J — no-form actionability drift after fill fails before provider gesture.
  {
    const { context: admissionContext, page: admissionPage } = await createNoFormAdmissionScenarioPage('admit');
    await admissionPage.evaluate(() => {
      const composer = document.getElementById('deepseek-composer');
      const send = document.getElementById('deepseek-send');
      composer.addEventListener('input', () => {
        if (composer.value) send.style.pointerEvents = 'none';
      });
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-noform-actionability-drift', prompt: 'R14_NOFORM_ACTIONABILITY_DRIFT' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /became non-actionable/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.submitDiagnostic?.state, 'actionability-drift');
    await admissionContext.close();
  }

  // R14 live-shape J — no-form effective-enabled drift after fill fails before provider gesture.
  {
    const { context: admissionContext, page: admissionPage } = await createNoFormAdmissionScenarioPage('admit');
    await admissionPage.evaluate(() => {
      const composer = document.getElementById('deepseek-composer');
      const send = document.getElementById('deepseek-send');
      composer.addEventListener('input', () => {
        if (composer.value) send.setAttribute('aria-disabled', 'true');
      });
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-noform-enabled-drift', prompt: 'R14_NOFORM_ENABLED_DRIFT' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /not effectively enabled after composer fill/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.submitDiagnostic?.state, 'disabled-after-fill');
    await admissionContext.close();
  }

  // R14 semantic precedence — lower-priority title/text can never override a conflicting aria-label.
  for (const [inputId, useTitle] of [
    ['r14-semantic-title-conflict', true],
    ['r14-semantic-text-conflict', false],
  ]) {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('clear-only');
    await admissionPage.evaluate(useTitle => {
      const send = document.querySelector('#composer-form button[type="submit"]');
      send.setAttribute('aria-label', 'Message settings');
      if (useTitle) {
        send.setAttribute('title', 'Send');
        send.textContent = '⚙';
      } else {
        send.removeAttribute('title');
        send.textContent = 'Send';
      }
    }, useTitle);
    const rejected = await rejectedWorkerSend(admissionPage, { inputId, prompt: 'R14_SEMANTIC_PRECEDENCE' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /missing or not actionable/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.composerInputEvents, 0);
    await admissionContext.close();
  }

  // R14 legitimate disabled-empty shape — same exact control may become enabled after fill and click once.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('admit');
    await admissionPage.evaluate(() => {
      const composer = document.querySelector('#composer-form textarea');
      const send = document.querySelector('#composer-form button[type="submit"]');
      send.disabled = true;
      composer.addEventListener('input', () => { send.disabled = composer.value.length === 0; });
    });
    const start = await admissionPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({
      inputId: 'r14-disabled-empty-enables',
      prompt: 'R14_DISABLED_EMPTY_ENABLES',
    }));
    const counters = await submissionCounters(admissionPage);
    assert.equal(start.state, 'running');
    assert.ok(start.sentAt);
    assert.equal(counters.submitEvents, 1);
    assert.equal(counters.sendButtonClicks, 1);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.submitDiagnostic?.state, 'admitted');
    await admissionContext.close();
  }

  // R14 after-fill actionability drift fails before gesture.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('clear-only');
    await admissionPage.evaluate(() => {
      const composer = document.querySelector('#composer-form textarea');
      const send = document.querySelector('#composer-form button[type="submit"]');
      composer.addEventListener('input', () => { send.style.pointerEvents = composer.value ? 'none' : 'auto'; });
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-actionability-drift', prompt: 'R14_ACTIONABILITY_DRIFT' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /became non-actionable/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.submitDiagnostic?.state, 'actionability-drift');
    await admissionContext.close();
  }

  // R14 after-fill association drift fails before gesture.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('clear-only');
    await admissionPage.evaluate(() => {
      const composer = document.querySelector('#composer-form textarea');
      composer.addEventListener('input', () => {
        if (!composer.value) return;
        const replacementOwner = document.createElement('form');
        replacementOwner.id = 'replacement-composer-owner';
        document.body.appendChild(replacementOwner);
        replacementOwner.appendChild(composer);
      }, { once: true });
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-association-drift', prompt: 'R14_ASSOCIATION_DRIFT' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /association changed/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.submitDiagnostic?.state, 'association-drift');
    await admissionContext.close();
  }

  // R14 after-fill semantic drift fails before gesture.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('clear-only');
    await admissionPage.evaluate(() => {
      const composer = document.querySelector('#composer-form textarea');
      const send = document.querySelector('#composer-form button[type="submit"]');
      composer.addEventListener('input', () => {
        if (composer.value) send.setAttribute('aria-label', 'Message settings');
      });
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-semantic-drift', prompt: 'R14_SEMANTIC_DRIFT' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /semantic identity changed/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.submitDiagnostic?.state, 'semantic-drift');
    await admissionContext.close();
  }

  // R14 after-fill DOM identity replacement fails before gesture.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('clear-only');
    await admissionPage.evaluate(() => {
      const composer = document.querySelector('#composer-form textarea');
      const send = document.querySelector('#composer-form button[type="submit"]');
      composer.addEventListener('input', () => {
        if (!composer.value || !send.isConnected) return;
        send.replaceWith(send.cloneNode(true));
      });
    });
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-identity-drift', prompt: 'R14_IDENTITY_DRIFT' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /identity changed/i);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 0);
    assert.equal(counters.sendButtonClicks, 0);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.submitDiagnostic?.state, 'identity-drift');
    await admissionContext.close();
  }

  // Delayed provider mounting is not a failed send. The single submit must
  // stay observable long enough for an exact new-conversation user identity.
  {
    // Explicit null bypasses this fixture helper's 250ms default override,
    // allowing the agent's real 10s default to be exercised.
    const { context: delayedContext, page: delayedPage } =
      await createAdmissionScenarioPage('delayed-new-conversation-admit', '/chat', null);
    let start;
    try {
      start = await delayedPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({
        inputId: 'r14-delayed-conversation-admit', prompt: 'R14_LATE_SINGLE_SUBMIT',
      }));
    } catch (error) {
      const diagnostic = await delayedPage.evaluate(source => {
        const adapter = (0, eval)(source)({ window, document, location, visible: () => true, storage: sessionStorage });
        return { pathname: location.pathname,
          mode: window.__providerAdmissionMode,
          submitEvents: window.__submitEvents,
          userElements: document.querySelectorAll('.user-message').length,
          boundary: adapter.providerUserBoundary(),
        };
      }, siteSource);
      console.log('SYNTHETIC_DELAYED_ADMISSION_DIAGNOSTIC', JSON.stringify(diagnostic));
      throw error;
    }
    const counters = await submissionCounters(delayedPage);
    assert.equal(start.state, 'running');
    assert.ok(start.sentAt, 'only provider-user identity can establish admission');
    assert.equal(counters.submitEvents, 1);
    assert.equal(counters.sendButtonClicks, 1);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.deepEqual(counters.providerUsers.map(item => item.text), ['R14_LATE_SINGLE_SUBMIT']);
    assert.match(delayedPage.url(), /\/a\/chat\/s\/delayed-provider-conversation$/);
    await delayedContext.close();
  }

  // R14 A/K — composer mutation alone is never provider admission.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('clear-only');
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-clear-only', prompt: 'R14_CLEAR_ONLY' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /provider user-message admission was not confirmed/i);
    const turn = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r14-clear-only'));
    const counters = await submissionCounters(admissionPage);
    assert.equal(turn.sentAt, null, 'composer clear without provider admission must not credit sentAt');
    assert.equal(turn.events.filter(event => event.type === 'status' && event.name === 'sent').length, 0);
    assert.equal(counters.submitEvents, 1);
    assert.equal(counters.sendButtonClicks, 1);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.providerUsers.length, 0);
    assert.equal(counters.submitDiagnostic?.state, 'admission-failed');
    assert.equal(counters.submitDiagnostic?.method, 'button.click');
    assert.equal(counters.submitDiagnostic?.admission?.rawUserCandidates, 0);
    assert.equal(counters.submitDiagnostic?.admission?.stableUserMessages, 0);
    assert.equal(counters.submitDiagnostic?.admission?.baselineUserMessages, 0);
    assert.equal(counters.submitDiagnostic?.admission?.reason, 'no-new-provider-user-identity');
    assert.ok(counters.submitDiagnostic?.admission?.elapsedMs > 0);
    assert.doesNotMatch(JSON.stringify(counters.submitDiagnostic?.admission), /R14_CLEAR_ONLY|chat\.deepseek\.com/);
    await admissionContext.close();
  }

  // R14 B — one exact new stable provider-user identity credits sent only after admission.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('admit');
    const start = await admissionPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({
      inputId: 'r14-valid-admission',
      prompt: 'R14_VALID_ADMISSION',
    }));
    const counters = await submissionCounters(admissionPage);
    const admittedAt = await admissionPage.evaluate(() => window.__lastProviderAdmissionAt);
    assert.equal(start.state, 'running');
    assert.ok(start.sentAt >= admittedAt && admittedAt > 0, 'sentAt must occur only after exact provider-user admission');
    assert.equal(start.events.filter(event => event.type === 'status' && event.name === 'sent').length, 1);
    assert.equal(counters.submitEvents, 1);
    assert.equal(counters.sendButtonClicks, 1);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.deepEqual(counters.providerUsers.map(value => value.text), ['R14_VALID_ADMISSION']);
    assert.ok(counters.providerUsers[0].identity);
    assert.equal(counters.submitDiagnostic?.state, 'admitted');
    assert.equal(counters.submitDiagnostic?.candidateCount, 1);
    assert.equal(counters.submitDiagnostic?.method, 'button.click');
    await admissionContext.close();
  }

  // R14 B fixture independence — exact provider admission is sufficient even when composer state does not mutate.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('admit-retain');
    const start = await admissionPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({
      inputId: 'r14-valid-admission-retained-composer',
      prompt: 'R14_ADMISSION_WITH_RETAINED_COMPOSER',
    }));
    const counters = await submissionCounters(admissionPage);
    assert.equal(start.state, 'running');
    assert.ok(start.sentAt);
    assert.equal(start.events.filter(event => event.type === 'status' && event.name === 'sent').length, 1);
    assert.equal(counters.submitEvents, 1);
    assert.equal(counters.sendButtonClicks, 1);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.deepEqual(counters.providerUsers.map(value => value.text), ['R14_ADMISSION_WITH_RETAINED_COMPOSER']);
    assert.equal(await admissionPage.locator('textarea').inputValue(), 'R14_ADMISSION_WITH_RETAINED_COMPOSER', 'provider admission must not depend on composer clear/replacement');
    await admissionContext.close();
  }

  // R16 A continuation — a slow temporary assistant .ds-message fallback
  // (>=500ms) remains admission ambiguity for the bounded observation window,
  // not timing evidence of two stable provider users.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage(
      'transient-assistant-shell',
      '/chat',
      1200,
    );
    const start = await admissionPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({
      inputId: 'r16-transient-role-stabilization',
      prompt: 'R16_TRANSIENT_ROLE_STABILIZATION',
    }));
    const counters = await submissionCounters(admissionPage);
    assert.ok(start.sentAt);
    assert.equal(start.events.filter(event => event.type === 'status' && event.name === 'sent').length, 1);
    assert.ok(
      counters.submitDiagnostic?.admissionAmbiguityObservations >= 1,
      'the transient assistant shell must be observed as ambiguity before exact admission stabilizes',
    );
    assert.equal(counters.submitEvents, 1);
    assert.equal(counters.sendButtonClicks, 1);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.deepEqual(counters.providerUsers.map(value => value.text), ['R16_TRANSIENT_ROLE_STABILIZATION']);
    const providerSubmissions = await admissionPage.evaluate(() => window.__submittedMessages.length);
    assert.equal(providerSubmissions, 1, 'slow transient role ambiguity must never authorize a blind resend');
    r16Evidence.transientRoleStabilization = {
      assistantFallbackMs: 560,
      admissionWindowMs: 1200,
      ambiguityObservations: counters.submitDiagnostic.admissionAmbiguityObservations,
      sentEvents: start.events.filter(event => event.type === 'status' && event.name === 'sent').length,
      providerUserCount: counters.providerUsers.length,
      providerGestures: counters.submitEvents,
      requestSubmitCalls: counters.requestSubmitCalls,
      enterSubmitEvents: counters.enterSubmitEvents,
      providerSubmissions,
      blindResends: providerSubmissions - 1,
    };
    await admissionContext.close();
  }

  // R14 C — historical same text is baseline history, not a new admission.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('clear-only');
    await admissionPage.evaluate(() => window.__appendDeepSeekUser('R14_HISTORICAL_SAME_TEXT', -90));
    const rejected = await rejectedWorkerSend(admissionPage, {
      inputId: 'r14-historical-same',
      prompt: 'R14_HISTORICAL_SAME_TEXT',
    });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /admission was not confirmed/i);
    const turn = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r14-historical-same'));
    const counters = await submissionCounters(admissionPage);
    assert.equal(turn.sentAt, null);
    assert.equal(counters.providerUsers.length, 1, 'historical same-text identity must not be manufactured into a new provider turn');
    assert.equal(counters.submitEvents, 1);
    await admissionContext.close();
  }

  // R14 D — rerender/re-entry of the same historical identity is not new admission.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('rerender');
    await admissionPage.evaluate(() => window.__appendDeepSeekUser('R14_RERENDER', -90));
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-rerender', prompt: 'R14_RERENDER' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /admission was not confirmed/i);
    const counters = await submissionCounters(admissionPage);
    assert.deepEqual(counters.providerUsers.map(value => value.identity), ['-90']);
    assert.equal(counters.submitEvents, 1);
    await admissionContext.close();
  }

  // R14 E/F — unexpected text and multiple new provider identities fail closed.
  for (const [mode, inputId, expectedError] of [
    ['mismatch', 'r14-mismatch', /provider-user-text-mismatch/],
    ['multiple', 'r14-multiple', /multiple-new-provider-user-identities/],
  ]) {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage(mode);
    const rejected = await rejectedWorkerSend(admissionPage, { inputId, prompt: 'R14_EXPECTED_TEXT' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, expectedError);
    const turn = await admissionPage.evaluate(id => window.__shuncodeWebMcp.workerPoll(id), inputId);
    const counters = await submissionCounters(admissionPage);
    assert.equal(turn.sentAt, null);
    assert.equal(turn.events.filter(event => event.type === 'status' && event.name === 'sent').length, 0);
    assert.equal(counters.submitEvents, 1);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    if (mode === 'multiple') {
      r16Evidence.stableDuplicateRejection = {
        rejected: true,
        reason: 'multiple-new-provider-user-identities',
        sentAt: turn.sentAt,
        sentEvents: turn.events.filter(event => event.type === 'status' && event.name === 'sent').length,
        providerGestures: counters.submitEvents,
        requestSubmitCalls: counters.requestSubmitCalls,
        enterSubmitEvents: counters.enterSubmitEvents,
        providerSubmissions: await admissionPage.evaluate(() => window.__submittedMessages.length),
      };
    } else {
      r16Evidence.stableTextMismatchRejection = {
        rejected: true,
        reason: 'provider-user-text-mismatch',
        sentAt: turn.sentAt,
      };
    }
    await admissionContext.close();
  }

  // R14 stable authority — missing stable virtual identity is never admissible.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('unstable');
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-unstable-user', prompt: 'R14_UNSTABLE_USER' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /user-message-missing-stable-identity/);
    const turn = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r14-unstable-user'));
    assert.equal(turn.sentAt, null);
    assert.equal(turn.events.filter(event => event.type === 'status' && event.name === 'sent').length, 0);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 1);
    assert.equal(counters.sendButtonClicks, 1);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    r16Evidence.nonStabilizingAmbiguity = {
      rejected: true,
      sentAt: turn.sentAt,
      sentEvents: turn.events.filter(event => event.type === 'status' && event.name === 'sent').length,
      providerGestures: counters.submitEvents,
      requestSubmitCalls: counters.requestSubmitCalls,
      enterSubmitEvents: counters.enterSubmitEvents,
    };
    await admissionContext.close();
  }

  // R14 conversation lineage — an established provider conversation cannot drift during admission.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('conversation-drift', '/a/chat/s/current');
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-conversation-drift', prompt: 'R14_CONVERSATION_DRIFT' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /provider-conversation-lineage-drift/);
    const turn = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r14-conversation-drift'));
    assert.equal(turn.sentAt, null);
    assert.equal((await submissionCounters(admissionPage)).submitEvents, 1);
    await admissionContext.close();
  }

  // R14 G — first click UNKNOWN may still be admitted by exact read-only provider observation.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('admit');
    await admissionPage.evaluate(() => window.__installSubmitClickThrowAfterSubmit());
    const start = await admissionPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({
      inputId: 'r14-unknown-admitted',
      prompt: 'R14_UNKNOWN_ADMITTED',
    }));
    const counters = await submissionCounters(admissionPage);
    assert.equal(start.state, 'running');
    assert.ok(start.sentAt);
    assert.equal(counters.submitEvents, 1);
    assert.equal(counters.sendButtonClicks, 1);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.deepEqual(counters.providerUsers.map(value => value.text), ['R14_UNKNOWN_ADMITTED']);
    assert.equal(counters.submitDiagnostic?.state, 'admitted');
    assert.equal(counters.submitDiagnostic?.previousState, 'click-unknown');
    await admissionContext.close();
  }

  // R14 H — provider rate-limit/error after the one gesture is truthful failure, never sent/retried.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('rate-limit');
    const rejected = await rejectedWorkerSend(admissionPage, { inputId: 'r14-rate-limit', prompt: 'R14_RATE_LIMIT' });
    assert.equal(rejected.rejected, true);
    assert.match(rejected.error, /provider reported a send failure|admission was not confirmed/i);
    assert.equal(await admissionPage.evaluate(() => document.body.textContent.includes('rate limit reached, try again')), true);
    const turn = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r14-rate-limit'));
    const counters = await submissionCounters(admissionPage);
    assert.equal(turn.sentAt, null);
    assert.equal(counters.submitEvents, 1);
    assert.equal(counters.sendButtonClicks, 1);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.providerUsers.length, 0);
    await admissionContext.close();
  }

  // R14 H false-positive guard — user semantic text that contains an error phrase remains ordinary provider admission.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('admit');
    const prompt = 'Explain why a UI might say please try again later without treating this message as an error.';
    const start = await admissionPage.evaluate(async prompt => await window.__shuncodeWebMcp.workerSend({
      inputId: 'r14-error-phrase-in-user-text',
      prompt,
    }), prompt);
    const counters = await submissionCounters(admissionPage);
    assert.equal(start.state, 'running');
    assert.ok(start.sentAt);
    assert.equal(start.events.filter(event => event.type === 'status' && event.name === 'sent').length, 1);
    assert.equal(counters.submitEvents, 1);
    assert.equal(counters.sendButtonClicks, 1);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.deepEqual(counters.providerUsers.map(value => value.text), [prompt]);
    await admissionContext.close();
  }

  // R14 live-shape K — initial input and host-managed result injection share the same no-form submit owner.
  {
    const { context: admissionContext, page: admissionPage } = await createNoFormAdmissionScenarioPage('admit');
    const hostInput = {
      inputId: 'r14-noform-host-result',
      prompt: 'Request read_files exactly once.',
      allowedCapabilities: ['read_files'],
      externalCapabilities: [{
        name: 'read_files',
        description: 'Read exact workspace files.',
        inputSchema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'], additionalProperties: false },
      }],
      extensions: { hostManagedCapabilities: true },
    };
    const start = await admissionPage.evaluate(async input => await window.__shuncodeWebMcp.workerSend(input), hostInput);
    assert.equal(start.state, 'running');
    await appendDeepSeekAssistant(admissionPage, '[SHUNCODE_TOOL]\nid=r14-noform-host-call\nname=read_files\narg.files.0.path=README.md\n[/SHUNCODE_TOOL]');
    await admissionPage.waitForFunction(() => window.__shuncodeWebMcp.status().pendingHostCapabilities === 1, null, { timeout: 5000 });
    const pending = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r14-noform-host-result'));
    const call = pending.events.find(event => event.type === 'capability_call' && event.callId === 'r14-noform-host-call');
    assert.ok(call?.occurrenceId);
    await admissionPage.evaluate(async occurrenceId => await window.__shuncodeWebMcp.workerResolveCapability({
      inputId: 'r14-noform-host-result',
      callId: 'r14-noform-host-call',
      name: 'read_files',
      text: 'R14_NOFORM_HOST_RESULT_OK',
      isError: false,
      extensions: { occurrenceId },
    }), call.occurrenceId);
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 2, 'no-form initial input plus host result must each use exactly one provider submit');
    assert.equal(counters.sendButtonClicks, 2);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.providerUsers.filter(value => value.text.includes('R14_NOFORM_HOST_RESULT_OK')).length, 1);
    await admissionContext.close();
  }

  // R14 live-shape K — page-local tool-result delivery reuses the same no-form owner.
  {
    const { context: admissionContext, page: admissionPage } = await createNoFormAdmissionScenarioPage('admit');
    const start = await admissionPage.evaluate(async () => await window.__shuncodeWebMcp.workerSend({
      inputId: 'r14-noform-page-local',
      prompt: 'Read README.md exactly once.',
    }));
    assert.equal(start.state, 'running');
    await appendDeepSeekAssistant(admissionPage, '[SHUNCODE_TOOL]\nid=r14-noform-page-local-call\nname=read_files\narg.files.0.path=README.md\n[/SHUNCODE_TOOL]');
    await admissionPage.waitForFunction(
      () => window.__submittedMessages.some(text => text.includes('[SHUNCODE_TOOL_RESULT]') && text.includes('NOFORM_PAGE_LOCAL_OK')),
      null,
      { timeout: 5000 },
    );
    const counters = await submissionCounters(admissionPage);
    assert.equal(counters.submitEvents, 2, 'no-form initial input plus page-local tool result must each use exactly one provider submit');
    assert.equal(counters.sendButtonClicks, 2);
    assert.equal(counters.requestSubmitCalls, 0);
    assert.equal(counters.enterSubmitEvents, 0);
    assert.equal(counters.providerUsers.filter(value => value.text.includes('NOFORM_PAGE_LOCAL_OK')).length, 1);
    await admissionContext.close();
  }

  // R14 I — host tool-result admission uses the same exact owner and never injects twice.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('admit');
    const hostInput = {
      inputId: 'r14-tool-result',
      prompt: 'Request read_files exactly once.',
      allowedCapabilities: ['read_files'],
      externalCapabilities: [{
        name: 'read_files',
        description: 'Read exact workspace files.',
        inputSchema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'], additionalProperties: false },
      }],
      extensions: { hostManagedCapabilities: true },
    };
    const start = await admissionPage.evaluate(async input => await window.__shuncodeWebMcp.workerSend(input), hostInput);
    assert.equal(start.state, 'running');
    await appendDeepSeekAssistant(admissionPage, '[SHUNCODE_TOOL]\nid=r14-tool-call\nname=read_files\narg.files.0.path=README.md\n[/SHUNCODE_TOOL]');
    await admissionPage.waitForFunction(() => window.__shuncodeWebMcp.status().pendingHostCapabilities === 1, null, { timeout: 5000 });
    const pending = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r14-tool-result'));
    const call = pending.events.find(event => event.type === 'capability_call' && event.callId === 'r14-tool-call');
    assert.ok(call?.occurrenceId);
    const resolveInput = {
      inputId: 'r14-tool-result',
      callId: 'r14-tool-call',
      name: 'read_files',
      text: 'R14_TOOL_RESULT_OK',
      isError: false,
      extensions: { occurrenceId: call.occurrenceId },
    };
    await admissionPage.evaluate(async input => await window.__shuncodeWebMcp.workerResolveCapability(input), resolveInput);
    await admissionPage.evaluate(async input => await window.__shuncodeWebMcp.workerResolveCapability(input), resolveInput);
    const after = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r14-tool-result'));
    const counters = await submissionCounters(admissionPage);
    assert.equal(after.events.filter(event => event.type === 'capability_result' && event.callId === 'r14-tool-call').length, 1);
    assert.equal(after.events.filter(event => event.type === 'status' && event.name === 'capability_result_delivered' && event.callId === 'r14-tool-call').length, 1);
    assert.equal(counters.submitEvents, 2, 'initial Worker input plus one provider tool-result injection only');
    assert.equal(counters.providerUsers.filter(value => value.text.includes('[SHUNCODE_TOOL_RESULT]') && value.text.includes('R14_TOOL_RESULT_OK')).length, 1);
    await admissionContext.close();
  }

  // R14 I uncertainty — terminalize local wait, retain unconfirmed receipt;
  // neither ACK retry nor a fresh Worker turn may re-send the provider result.
  {
    const { context: admissionContext, page: admissionPage } = await createAdmissionScenarioPage('admit');
    const hostInput = {
      inputId: 'r14-tool-result-uncertain',
      prompt: 'Request read_files exactly once, then await result.',
      allowedCapabilities: ['read_files'],
      externalCapabilities: [{
        name: 'read_files',
        description: 'Read exact workspace files.',
        inputSchema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'], additionalProperties: false },
      }],
      extensions: { hostManagedCapabilities: true },
    };
    await admissionPage.evaluate(async input => await window.__shuncodeWebMcp.workerSend(input), hostInput);
    await appendDeepSeekAssistant(admissionPage, '[SHUNCODE_TOOL]\nid=r14-tool-call-uncertain\nname=read_files\narg.files.0.path=README.md\n[/SHUNCODE_TOOL]');
    await admissionPage.waitForFunction(() => window.__shuncodeWebMcp.status().pendingHostCapabilities === 1, null, { timeout: 5000 });
    const pending = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r14-tool-result-uncertain'));
    const call = pending.events.find(event => event.type === 'capability_call' && event.callId === 'r14-tool-call-uncertain');
    const resolveInput = {
      inputId: 'r14-tool-result-uncertain',
      callId: 'r14-tool-call-uncertain',
      name: 'read_files',
      text: 'R14_TOOL_RESULT_UNCERTAIN',
      isError: false,
      extensions: { occurrenceId: call.occurrenceId },
    };
    await admissionPage.evaluate(() => { window.__providerAdmissionMode = 'clear-only'; });
    const firstFailure = await admissionPage.evaluate(async input => {
      try { await window.__shuncodeWebMcp.workerResolveCapability(input); return ''; }
      catch (error) { return String(error?.message || error); }
    }, resolveInput);
    assert.match(firstFailure, /admission was not confirmed/i);
    const countersAfterFirst = await submissionCounters(admissionPage);
    const secondFailure = await admissionPage.evaluate(async input => {
      try { await window.__shuncodeWebMcp.workerResolveCapability(input); return ''; }
      catch (error) { return String(error?.message || error); }
    }, resolveInput);
    assert.match(secondFailure, /worker turn is not running|single provider submit gesture/i);
    const countersAfterSecond = await submissionCounters(admissionPage);
    assert.equal(countersAfterFirst.submitEvents, 2);
    assert.equal(countersAfterSecond.submitEvents, 2, 'result-delivery retry must not create a second provider injection');
    assert.equal(countersAfterSecond.requestSubmitCalls, 0);
    assert.equal(countersAfterSecond.enterSubmitEvents, 0);
    const after = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r14-tool-result-uncertain'));
    assert.equal(after.events.filter(event => event.type === 'capability_result' && event.callId === 'r14-tool-call-uncertain').length, 1, 'host result semantic observation must remain exactly once');
    assert.equal(after.state, 'error', 'unconfirmed provider result ends the local polling loop without false completion');
    const failureStatus = await admissionPage.evaluate(() => window.__shuncodeWebMcp.status());
    assert.equal(failureStatus.resultDeliveryUncertain?.callId, 'r14-tool-call-uncertain');
    assert.equal(failureStatus.pendingHostCapabilities, 1, 'unconfirmed result remains available for explicit review');
    await admissionContext.close();
  }

  // R16 F — a post-floor host-managed occurrence that appears while provider
  // admission is pending is quarantined without being consumed. Once the same
  // turn is exactly admitted, that same occurrence is rescanned exactly once.
  {
    const { context: admissionContext, page: admissionPage, getGenericInvokeCount } = await createAdmissionScenarioPage(
      'clear-only',
      '/chat',
      900,
    );
    const input = hostManagedReadInput('r16-pre-admission-occurrence', 'Request read_files exactly once.');
    const sendPromise = admissionPage.evaluate(async input => await window.__shuncodeWebMcp.workerSend(input), input);
    await admissionPage.waitForFunction(() => window.__submitEvents === 1, null, { timeout: 3000 });
    await appendDeepSeekAssistant(
      admissionPage,
      '[SHUNCODE_TOOL]\nid=r16-pre-admission-call\nname=read_files\narg.files.0.path=README.md\n[/SHUNCODE_TOOL]',
    );
    await admissionPage.waitForTimeout(260);
    const before = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r16-pre-admission-occurrence'));
    const beforeStatus = await admissionPage.evaluate(() => window.__shuncodeWebMcp.status());
    const beforeCounters = await submissionCounters(admissionPage);
    assert.equal(before.sentAt, null);
    assert.equal(before.toolCallCount, 0);
    assert.equal(before.events.filter(event => event.type === 'capability_call').length, 0);
    assert.equal(beforeStatus.pendingHostCapabilities, 0);
    assert.equal(beforeStatus.pendingDeliveries, 0);
    assert.equal(getGenericInvokeCount(), 0);
    assert.equal(beforeCounters.submitEvents, 1);

    await admissionPage.evaluate(() => {
      window.__appendDeepSeekUser(window.__submittedMessages[0]);
    });
    const admitted = await sendPromise;
    assert.ok(admitted.sentAt);
    await admissionPage.waitForFunction(
      () => window.__shuncodeWebMcp.status().pendingHostCapabilities === 1,
      null,
      { timeout: 5000 },
    );
    const after = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r16-pre-admission-occurrence'));
    const calls = after.events.filter(event => event.type === 'capability_call' && event.callId === 'r16-pre-admission-call');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].occurrenceId);
    assert.equal(after.toolCallCount, 1);
    assert.equal(getGenericInvokeCount(), 0);
    r16Evidence.preAdmissionOccurrenceGate = {
      preAdmissionCapabilityCalls: before.events.filter(event => event.type === 'capability_call').length,
      preAdmissionToolCallCount: before.toolCallCount,
      preAdmissionGenericInvokes: 0,
      preAdmissionPendingDeliveries: beforeStatus.pendingDeliveries,
      postAdmissionCapabilityCalls: calls.length,
      occurrenceId: calls[0].occurrenceId,
      providerGesturesBeforeAdmission: beforeCounters.submitEvents,
    };
    await admissionContext.close();
  }

  // R16 real 019 shape — DeepSeek can finish a tool-only response while exact
  // provider-user admission is still stabilizing. The stable post-floor
  // occurrence stays quarantined pre-admission, then must converge exactly once
  // at the admission boundary. The provider's bare arg={} line is intentionally
  // ignored by line protocol so the host-requested envelope remains exact {}.
  {
    const { context: admissionContext, page: admissionPage, getGenericInvokeCount } = await createAdmissionScenarioPage(
      'clear-only',
      '/chat',
      900,
    );
    const input = hostManagedCoordinatorInput('r16-real-019-pre-admission', 'Invoke the exact host-bound Coordinator command once.');
    const sendPromise = admissionPage.evaluate(async input => await window.__shuncodeWebMcp.workerSend(input), input);
    await admissionPage.waitForFunction(() => window.__submitEvents === 1, null, { timeout: 3000 });
    await appendDeepSeekAssistantAtVirtualKey(admissionPage, realPhase11R16ToolBlock, 2);
    const renderedShape = await admissionPage.evaluate(() => {
      const response = document.querySelector('.ds-assistant-message-main-content');
      const ancestors = [];
      for (let node = response; node; node = node.parentElement) {
        if (node.hasAttribute?.('data-virtual-list-item-key')) ancestors.push(node.getAttribute('data-virtual-list-item-key'));
      }
      return { text: response?.innerText || '', virtualKeys: ancestors };
    });
    assert.equal(renderedShape.text, realPhase11R16ToolBlock);
    assert.deepEqual(renderedShape.virtualKeys, ['2'], 'real-shaped tool-only response must live under exactly one numeric virtual-list identity');

    const before = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r16-real-019-pre-admission'));
    const beforeStatus = await admissionPage.evaluate(() => window.__shuncodeWebMcp.status());
    assert.equal(before.sentAt, null);
    assert.equal(before.toolCallCount, 0);
    assert.equal(before.events.filter(event => event.type === 'capability_call').length, 0, 'pre-admission stable occurrence must remain quarantined');
    assert.equal(beforeStatus.pendingHostCapabilities, 0);
    assert.equal(getGenericInvokeCount(), 0);

    await admissionPage.evaluate(() => window.__appendDeepSeekUser(window.__submittedMessages[0]));
    const admitted = await sendPromise;
    assert.ok(admitted.sentAt);
    const callsAtAdmission = admitted.events.filter(event => event.type === 'capability_call' && event.callId === 'deliver-phase11-proof-021');
    assert.equal(callsAtAdmission.length, 1, 'admission boundary must synchronously converge the already-rendered stable capability');
    assert.equal(callsAtAdmission[0].name, 'nimora.coordinator.deliverExplicitMissionInput');
    assert.equal(callsAtAdmission[0].dispatch, 'host-requested');
    assert.equal(Reflect.ownKeys(callsAtAdmission[0].arguments).length, 0, 'provider arg={} must remain exact empty invocation authority');
    assert.ok(callsAtAdmission[0].occurrenceId);
    assert.equal(getGenericInvokeCount(), 0, 'host-managed Coordinator capability must never use page-local generic invoke');
    assert.equal(await admissionPage.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 1);

    const rescans = await admissionPage.evaluate(async () => await Promise.all(
      Array.from({ length: 6 }, () => window.__shuncodeWebMcp.workerPoll('r16-real-019-pre-admission')),
    ));
    assert.equal(
      rescans.at(-1).events.filter(event => event.type === 'capability_call' && event.callId === 'deliver-phase11-proof-021').length,
      1,
      'duplicate rescans must not duplicate the real-shaped capability occurrence',
    );
    assert.equal(getGenericInvokeCount(), 0);

    await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerInterrupt('r16-real-019-pre-admission'));
    await appendDeepSeekAssistantAtVirtualKey(admissionPage, realPhase11R16ToolBlock, 3);
    const afterCancel = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r16-real-019-pre-admission'));
    assert.equal(afterCancel.state, 'cancelled');
    assert.equal(
      afterCancel.events.filter(event => event.type === 'capability_call' && event.callId === 'deliver-phase11-proof-021').length,
      1,
      'same capability text rendered only after terminal cancellation must never admit a new occurrence',
    );
    assert.equal(getGenericInvokeCount(), 0);
    r16Evidence.real019PreAdmissionConvergence = {
      preAdmissionCapabilityCalls: 0,
      admissionBoundaryCapabilityCalls: callsAtAdmission.length,
      exactEmptyArguments: Reflect.ownKeys(callsAtAdmission[0].arguments).length === 0,
      dispatch: callsAtAdmission[0].dispatch,
      genericInvokes: 0,
      duplicateRescanCapabilityCalls: rescans.at(-1).events.filter(event => event.type === 'capability_call' && event.callId === 'deliver-phase11-proof-021').length,
      postCancellationNewAdmissions: 0,
    };
    await admissionContext.close();
  }

  // R16 real 019 post-admission shape — an occurrence that first appears just
  // after exact provider admission also admits exactly once with no page-local
  // execution and no provider semantic arguments.
  {
    const { context: admissionContext, page: admissionPage, getGenericInvokeCount } = await createAdmissionScenarioPage('admit');
    const input = hostManagedCoordinatorInput('r16-real-019-post-admission', 'Invoke the exact host-bound Coordinator command once.');
    const start = await admissionPage.evaluate(async input => await window.__shuncodeWebMcp.workerSend(input), input);
    assert.ok(start.sentAt);
    await appendDeepSeekAssistantAtVirtualKey(admissionPage, realPhase11R16ToolBlock, 2);
    const snapshot = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r16-real-019-post-admission'));
    const calls = snapshot.events.filter(event => event.type === 'capability_call' && event.callId === 'deliver-phase11-proof-021');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].dispatch, 'host-requested');
    assert.equal(Reflect.ownKeys(calls[0].arguments).length, 0);
    assert.equal(getGenericInvokeCount(), 0);
    r16Evidence.real019PostAdmissionConvergence = {
      capabilityCalls: calls.length,
      exactEmptyArguments: true,
      dispatch: calls[0].dispatch,
      genericInvokes: 0,
    };
    await admissionContext.close();
  }

  // Coordinator-only terminal boundary — once the single exact host-bound
  // capability result has a confirmed provider delivery, the Coordinator turn
  // is mechanically complete. Provider follow-up prose has no semantic
  // authority and must not be required for convergence.
  {
    const { context: terminalContext, page: terminalPage, getGenericInvokeCount } = await createAdmissionScenarioPage('admit');
    const input = hostManagedCoordinatorInput('coordinator-host-result-terminal', 'Invoke the exact host-bound Coordinator command once.');
    input.extensions.terminalAfterHostCapabilityResult = true;
    const start = await terminalPage.evaluate(async value => await window.__shuncodeWebMcp.workerSend(value), input);
    assert.ok(start.sentAt);
    await appendDeepSeekAssistantAtVirtualKey(terminalPage, realPhase11R16ToolBlock, 2);
    const pending = await terminalPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('coordinator-host-result-terminal'));
    const call = pending.events.find(event => event.type === 'capability_call' && event.callId === 'deliver-phase11-proof-021');
    assert.ok(call?.occurrenceId);
    const resolved = await terminalPage.evaluate(async occurrenceId => await window.__shuncodeWebMcp.workerResolveCapability({
      inputId: 'coordinator-host-result-terminal',
      callId: 'deliver-phase11-proof-021',
      name: 'nimora.coordinator.deliverExplicitMissionInput',
      text: 'COORDINATOR_RESULT_OK',
      isError: false,
      extensions: { occurrenceId },
    }), call.occurrenceId);
    assert.equal(resolved.state, 'completed', 'confirmed Coordinator host result must terminalize without provider follow-up prose');
    assert.equal(resolved.events.filter(event => event.type === 'capability_call').length, 1);
    assert.equal(resolved.events.filter(event => event.type === 'completed').length, 1);
    assert.equal(await terminalPage.evaluate(() => window.__shuncodeWebMcp.status().pendingHostCapabilities), 0);
    assert.equal(getGenericInvokeCount(), 0);
    await terminalContext.close();
  }

  // R16 real-shape identity guard — parseable tool text without exactly one
  // numeric virtual-list identity remains fail-closed.
  {
    const { context: admissionContext, page: admissionPage, getGenericInvokeCount } = await createAdmissionScenarioPage('admit');
    const input = hostManagedCoordinatorInput('r16-real-019-unstable-identity', 'Reject unstable provider occurrence identity.');
    const start = await admissionPage.evaluate(async input => await window.__shuncodeWebMcp.workerSend(input), input);
    assert.ok(start.sentAt);
    await admissionPage.evaluate(text => {
      const response = document.createElement('div');
      response.className = 'ds-assistant-message-main-content';
      response.innerText = text;
      document.getElementById('messages').appendChild(response);
    }, realPhase11R16ToolBlock);
    const snapshot = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r16-real-019-unstable-identity'));
    assert.equal(snapshot.events.filter(event => event.type === 'capability_call').length, 0);
    assert.match(
      await admissionPage.evaluate(() => window.__shuncodeWebMcp.status().lastOccurrenceIdentityError),
      /lacks one exact stable virtual-list message identity\/order/,
    );
    assert.equal(getGenericInvokeCount(), 0);
    r16Evidence.real019UnstableIdentity = {
      capabilityCalls: 0,
      genericInvokes: 0,
      failClosed: true,
    };
    await admissionContext.close();
  }

  // R16 G/H — if admission terminally fails, later same-turn post-floor
  // occurrences remain quarantined from generic WebMCP. A later Worker turn
  // establishes a fresh floor: the old occurrence stays inert and a fresh one
  // routes normally.
  {
    const { context: admissionContext, page: admissionPage, getGenericInvokeCount } = await createAdmissionScenarioPage(
      'clear-only',
      '/chat',
      300,
    );
    const failedInput = hostManagedReadInput('r16-failed-turn', 'This turn must fail provider admission.');
    const rejected = await rejectedWorkerSend(admissionPage, failedInput);
    assert.equal(rejected.rejected, true);
    const failedTurn = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r16-failed-turn'));
    assert.equal(failedTurn.state, 'error');
    assert.equal(failedTurn.sentAt, null);

    await appendDeepSeekAssistant(
      admissionPage,
      '[SHUNCODE_TOOL]\nid=r16-failed-old-call\nname=read_files\narg.files.0.path=README.md\n[/SHUNCODE_TOOL]',
    );
    await admissionPage.evaluate(async () => await window.__shuncodeWebMcp.scan());
    await admissionPage.waitForTimeout(260);
    const failedAfterOccurrence = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r16-failed-turn'));
    const failedStatus = await admissionPage.evaluate(() => window.__shuncodeWebMcp.status());
    const failedCounters = await submissionCounters(admissionPage);
    const submittedAfterFailure = await admissionPage.evaluate(() => window.__submittedMessages.length);
    assert.equal(failedAfterOccurrence.toolCallCount, 0);
    assert.equal(failedAfterOccurrence.events.filter(event => event.type === 'capability_call').length, 0);
    assert.equal(failedStatus.pendingDeliveries, 0);
    assert.equal(failedStatus.pendingHostCapabilities, 0);
    assert.equal(getGenericInvokeCount(), 0);
    assert.equal(failedCounters.submitEvents, 1, 'failed-turn tool occurrence must not consume a tool-result provider gesture');
    assert.equal(submittedAfterFailure, 1);

    await admissionPage.evaluate(() => { window.__providerAdmissionMode = 'admit'; });
    const freshInput = hostManagedReadInput('r16-fresh-turn', 'Request read_files exactly once on the fresh turn.');
    const freshStart = await admissionPage.evaluate(async input => await window.__shuncodeWebMcp.workerSend(input), freshInput);
    assert.ok(freshStart.sentAt);
    await appendDeepSeekAssistant(
      admissionPage,
      '[SHUNCODE_TOOL]\nid=r16-fresh-call\nname=read_files\narg.files.0.path=README.md\n[/SHUNCODE_TOOL]',
    );
    await admissionPage.waitForFunction(
      () => window.__shuncodeWebMcp.status().pendingHostCapabilities === 1,
      null,
      { timeout: 5000 },
    );
    const fresh = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r16-fresh-turn'));
    const freshCalls = fresh.events.filter(event => event.type === 'capability_call');
    assert.equal(freshCalls.length, 1);
    assert.equal(freshCalls[0].callId, 'r16-fresh-call');
    assert.equal(fresh.events.some(event => event.type === 'capability_call' && event.callId === 'r16-failed-old-call'), false);
    assert.equal(getGenericInvokeCount(), 0);
    r16Evidence.failedTurnAndFreshFloor = {
      failedTurnGenericInvokes: 0,
      failedTurnCapabilityCalls: failedAfterOccurrence.events.filter(event => event.type === 'capability_call').length,
      failedTurnPendingDeliveries: failedStatus.pendingDeliveries,
      failedTurnToolResultGestures: failedCounters.submitEvents - 1,
      freshTurnCapabilityCalls: freshCalls.length,
      freshTurnCallId: freshCalls[0].callId,
      oldOccurrenceRoutedOnFreshTurn: false,
    };
    await admissionContext.close();
  }

  // R16 G cancellation variant — cancelling a host-managed turn before exact
  // provider admission keeps its post-floor occurrences quarantined too.
  {
    const { context: admissionContext, page: admissionPage, getGenericInvokeCount } = await createAdmissionScenarioPage(
      'clear-only',
      '/chat',
      700,
    );
    const cancelledInput = hostManagedReadInput('r16-cancelled-turn', 'This turn is cancelled before provider admission.');
    const sendPromise = admissionPage.evaluate(async input => {
      try {
        await window.__shuncodeWebMcp.workerSend(input);
        return { resolved: true, error: '' };
      } catch (error) {
        return { resolved: false, error: String(error?.message || error) };
      }
    }, cancelledInput);
    await admissionPage.waitForFunction(() => window.__submitEvents === 1, null, { timeout: 3000 });
    const interrupted = await admissionPage.evaluate(
      async () => await window.__shuncodeWebMcp.workerInterrupt('r16-cancelled-turn'),
    );
    assert.equal(interrupted, false, 'fixture has no streaming stop control, but cancellation authority must still terminalize the turn');
    const cancelledBeforeOccurrence = await admissionPage.evaluate(
      () => window.__shuncodeWebMcp.workerPoll('r16-cancelled-turn'),
    );
    assert.equal(cancelledBeforeOccurrence.state, 'cancelled');
    assert.equal(cancelledBeforeOccurrence.sentAt, null);
    await appendDeepSeekAssistant(
      admissionPage,
      '[SHUNCODE_TOOL]\nid=r16-cancelled-call\nname=read_files\narg.files.0.path=README.md\n[/SHUNCODE_TOOL]',
    );
    await admissionPage.evaluate(async () => await window.__shuncodeWebMcp.scan());
    await admissionPage.waitForTimeout(260);
    const cancelled = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r16-cancelled-turn'));
    const cancelledStatus = await admissionPage.evaluate(() => window.__shuncodeWebMcp.status());
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.sentAt, null);
    assert.equal(cancelled.toolCallCount, 0);
    assert.equal(cancelled.events.filter(event => event.type === 'capability_call').length, 0);
    assert.equal(cancelledStatus.pendingDeliveries, 0);
    assert.equal(cancelledStatus.pendingHostCapabilities, 0);
    assert.equal(getGenericInvokeCount(), 0);
    const sendOutcome = await sendPromise;
    assert.equal(sendOutcome.resolved, false);
    const cancelledFinal = await admissionPage.evaluate(() => window.__shuncodeWebMcp.workerPoll('r16-cancelled-turn'));
    assert.equal(cancelledFinal.state, 'cancelled', 'late admission timeout must not rewrite explicit cancellation as error');
    assert.equal(cancelledFinal.sentAt, null);
    r16Evidence.cancelledTurnQuarantine = {
      state: cancelledFinal.state,
      sentAt: cancelledFinal.sentAt,
      capabilityCalls: cancelled.events.filter(event => event.type === 'capability_call').length,
      genericInvokes: 0,
      pendingDeliveries: cancelledStatus.pendingDeliveries,
    };
    await admissionContext.close();
  }

  console.log(JSON.stringify({ result: 'PASS', r16Evidence }, null, 2));
  console.log('[smoke] WebMCP v25 DeepSeek stabilized provider admission + admitted-turn occurrence ownership + one-gesture lifecycle ok');
} finally {
  await browser.close();
}
