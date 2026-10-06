import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const extensionDirectory = path.join(root, 'extensions', 'shuncode-webmcp');
const operationSource = await fs.readFile(path.join(extensionDirectory, 'webmcp-internal-browser-operations.js'), 'utf8');
const siteAdapterSource = await fs.readFile(path.join(extensionDirectory, 'webmcp-site-adapters.js'), 'utf8');
const extensionSource = await fs.readFile(path.join(extensionDirectory, 'extension.js'), 'utf8');
const adapterSource = await fs.readFile(path.join(root, 'src', 'vs', 'workbench', 'contrib', 'browserView', 'electron-browser', 'webMcpInternalBrowserOperations.ts'), 'utf8');
const runPlaywrightSource = await fs.readFile(path.join(root, 'src', 'vs', 'workbench', 'contrib', 'browserView', 'electron-browser', 'tools', 'runPlaywrightCodeTool.ts'), 'utf8');
const internalPolicy = JSON.parse(await fs.readFile(path.join(extensionDirectory, 'webmcp-internal-browser-policy.json'), 'utf8'));
const executeOperation = new Function(`return (${operationSource.trim()});`)();

// Run the real Workbench adapter with a visible editor whose native view is
// hidden by an overlay. That combination previously passed provider preflight.
const require = createRequire(path.join(root, 'build/package.json'));
const nativeHelpers = adapterSource.slice(adapterSource.indexOf('function isNativeMcpBypassUrl'), adapterSource.indexOf('export function registerWebMcpInternalBrowserOperationCommand'));
const { code: nativeHelperCode } = await require('esbuild').transform(nativeHelpers, { loader: 'ts', target: 'es2022' });
let nativeInvokes = 0;
let nativeWaits = 0;
const owners = new Map();
const nativeAdapter = new Function('BrowserViewSharingState', 'loadAssets', 'MAX_OBSERVE_TIMEOUT_MS', 'MAX_CONNECT_TIMEOUT_MS', 'MAX_CONTROL_TIMEOUT_MS', 'INTERNAL_SESSION_ID', 'deferredOwners', 'controlIdentity',
  `${nativeHelperCode}\nreturn { listSharedPages, executeFixedOperation };`)(
  { Shared: 'shared' }, async () => ({ nativeMcpBypassHosts: [], operationSource, siteAdapterSource, pageCoreSource: '', agentBridgeSource: '' }),
  5000, 20000, 20000, 'synthetic-native-visibility', owners, value => JSON.stringify(value));
const nativeModel = { sharingState: 'shared', visible: false, url: 'https://chat.deepseek.com/' };
const nativeInput = { title: 'Synthetic DeepSeek', url: nativeModel.url, resolve: async () => nativeModel };
const nativePages = { getKnownBrowserViews: () => new Map([['exact-page', nativeInput]]) };
const nativePlaywright = { isPageTracked: async () => true,
  invokeFunction: async () => { nativeInvokes++; return { result: { synthetic: true } }; },
  waitForDeferredResult: async () => { nativeWaits++; return { result: { synthetic: true } }; } };
assert.equal((await nativeAdapter.listSharedPages(nativePages, nativePlaywright, { visibleEditors: [nativeInput] }))[0].visible, false,
  'an editor covered by a notification must not claim native-page visibility');
nativeModel.visible = true;
assert.equal((await nativeAdapter.listSharedPages(nativePages, nativePlaywright, { visibleEditors: [nativeInput] }))[0].visible, true);
assert.equal((await nativeAdapter.listSharedPages(nativePages, nativePlaywright, { visibleEditors: [] }))[0].visible, false);
nativeModel.visible = false;
const nativeControl = { action: 'send', sessionId: 'synthetic-session', expectedOrigin: 'https://chat.deepseek.com', expectedHref: nativeModel.url, expectedSite: 'deepseek', input: { inputId: 'synthetic-input' } };
const nativeRequest = { operationId: 'control', pageId: 'exact-page', control: nativeControl };
await assert.rejects(() => nativeAdapter.executeFixedOperation(nativePages, nativePlaywright, {}, {}, nativeRequest), /hidden before provider submission/);
assert.equal(nativeInvokes, 0, 'hidden native page must be rejected before any provider gesture');
await nativeAdapter.executeFixedOperation(nativePages, nativePlaywright, {}, {}, { ...nativeRequest, control: { ...nativeControl, action: 'poll' } });
assert.equal(nativeInvokes, 1, 'read-only polling of an existing turn is not a new submission');
owners.set('synthetic-deferred', { operationId: 'control', pageId: 'exact-page', controlIdentity: JSON.stringify(nativeControl) });
await nativeAdapter.executeFixedOperation(nativePages, nativePlaywright, {}, {}, { ...nativeRequest, deferredResultId: 'synthetic-deferred' });
assert.equal(nativeWaits, 1, 'deferred completion must resume observation rather than submit again');
assert.equal(nativeInvokes, 1);
nativeModel.visible = true;
await nativeAdapter.executeFixedOperation(nativePages, nativePlaywright, {}, {}, nativeRequest);
assert.equal(nativeInvokes, 2, 'an exact shared visible page can submit normally');
nativeModel.sharingState = 'unshared';
await assert.rejects(() => nativeAdapter.executeFixedOperation(nativePages, nativePlaywright, {}, {}, nativeRequest), /not shared/);
assert.equal(nativeInvokes, 2, 'visibility never replaces the sharing requirement');

class CountingStorage {
  values = new Map();
  writes = 0;
  seed(key, value) { this.values.set(String(key), String(value)); }
  getItem(key) { return this.values.has(String(key)) ? this.values.get(String(key)) : null; }
  setItem(key, value) { this.writes += 1; this.values.set(String(key), String(value)); }
  removeItem(key) { this.writes += 1; this.values.delete(String(key)); }
}

function locationFor(href) {
  const url = new URL(href);
  return { href: url.href, origin: url.origin, hostname: url.hostname, pathname: url.pathname };
}

function composerElement() {
  return {
    offsetWidth: 480,
    offsetHeight: 48,
    disabled: false,
    readOnly: false,
    isContentEditable: false,
    tagName: 'TEXTAREA',
    className: 'chat-input',
    id: 'chat-input',
    getClientRects: () => [{}],
    getBoundingClientRect: () => ({ width: 480, height: 48, top: 700, bottom: 748 }),
    getAttribute: name => name === 'placeholder' ? 'Ask anything' : name === 'role' ? 'textbox' : '',
    matches: selector => selector === 'textarea',
    closest: () => null,
  };
}

function documentFixture({ composer = true, auth = false, running = false } = {}) {
  const textarea = composerElement();
  return {
    __authPage: auth,
    __workerTurnState: running ? 'running' : '',
    querySelectorAll(selector) { return composer && selector === 'textarea' ? [textarea] : []; },
  };
}

function envFor(href, { composer = true, runtime = false, running = false, sessionId = 'session-A' } = {}) {
  const storage = new CountingStorage();
  const location = locationFor(href);
  const document = documentFixture({ composer, running });
  const window = { innerHeight: 800, __injectionCount: 0, __primeCount: 0 };
  if (runtime) {
    storage.seed('shuncode-webmcp-page-session-id', sessionId);
    window.__shuncodeWebMcp = {
      version: 25,
      status: () => ({ version: 25, enabled: true, pageSessionId: sessionId, workerTurn: running ? { state: 'running' } : null }),
      workerSession: () => ({ sessionId, site: location.hostname.endsWith('deepseek.com') ? 'deepseek' : 'generic', origin: location.origin, href: location.href }),
    };
  }
  return { window, document, location, sessionStorage: storage };
}

function textNode(data) {
  return { nodeType: 3, data, nodeValue: data };
}

function elementNode(tagName, childNodes = [], attributes = {}) {
  return {
    nodeType: 1,
    tagName,
    childNodes,
    textContent: childNodes.map(child => child?.nodeType === 3 ? String(child.data || '') : String(child?.textContent || '')).join(''),
    isContentEditable: String(attributes.contenteditable || '').toLowerCase() === 'false' ? false : undefined,
    getAttribute: name => Object.prototype.hasOwnProperty.call(attributes, name) ? String(attributes[name]) : null,
  };
}

function pluginMentionNode(name = 'dev-r21-plugin') {
  const pluginPath = `plugin://${name}@openai-curated-remote`;
  return elementNode('SPAN', [elementNode('SPAN', [textNode('Display label is not identity')])], {
    contenteditable: 'false',
    'plugin-mention-name': name,
    'plugin-mention-display-name': 'Display label is not identity',
    'plugin-mention-path': pluginPath,
    'data-prompt-link-href': pluginPath,
    'data-prompt-link-label': `@${name}`,
  });
}

function chatGptComposerElement(lines) {
  const childNodes = lines.map(line => {
    const tagName = typeof line === 'string' ? 'P' : String(line?.tagName || 'P').toUpperCase();
    if (typeof line !== 'string' && Array.isArray(line?.childNodes)) {
      return elementNode(tagName, line.childNodes, line.attributes || {});
    }
    const text = typeof line === 'string' ? line : String(line?.text ?? '');
    return elementNode(tagName, text === '' ? [elementNode('BR')] : [textNode(text)]);
  });
  return {
    ...elementNode('DIV', childNodes),
    id: 'prompt-textarea',
    isContentEditable: true,
    offsetWidth: 640,
    offsetHeight: 120,
    getClientRects: () => [{}],
  };
}

function chatGptEnv(href, lines, count = 1) {
  const location = locationFor(href);
  const sessionStorage = new CountingStorage();
  const composers = Array.from({ length: count }, () => chatGptComposerElement(lines));
  const document = {
    querySelectorAll(selector) {
      if (selector === '#prompt-textarea' || selector === '[contenteditable="true"][role="textbox"]') return composers;
      return [];
    },
  };
  return { window: {}, document, location, sessionStorage };
}

function chatGptProviderUserEnv(href, texts, { explicit = false, duplicateIdentity = false, semanticPre = false, inlineCodeBody = null } = {}) {
  const location = locationFor(href);
  const sessionStorage = new CountingStorage();
  const turns = texts.map((text, index) => {
    const identity = duplicateIdentity ? 'conversation-turn-duplicate' : `conversation-turn-${index}`;
    const article = {
      ...elementNode('ARTICLE'),
      getAttribute: name => name === 'data-testid' ? identity : '',
    };
    const content = {
      ...elementNode('DIV', [textNode(text)]),
      innerText: text,
      getAttribute: () => '',
      matches: selector => semanticPre && selector === 'pre, code',
      querySelector: selector => semanticPre && selector === 'pre, code' ? { tagName: 'PRE' } : null,
      querySelectorAll: selector => selector === '.whitespace-pre-wrap' && inlineCodeBody ? [inlineCodeBody] : [],
      closest: selector => selector === 'article' ? article : null,
    };
    const heading = {
      ...elementNode('H4', [textNode('你说：')]),
      innerText: '你说：',
      nextElementSibling: content,
      parentElement: article,
      closest: selector => selector === 'article' ? article : null,
    };
    return { article, content, heading };
  });
  const document = {
    querySelectorAll(selector) {
      if (selector === 'main [data-message-author-role="user"]') return explicit ? turns.map(turn => turn.content) : [];
      if (selector === 'main [data-role="user"]') return [];
      if (selector === 'main h4' || selector === 'h4') return explicit ? [] : turns.map(turn => turn.heading);
      return [];
    },
  };
  return { window: {}, document, location, sessionStorage };
}

function chatGptStructuralProviderUserEnv(href, specs) {
  const location = locationFor(href);
  const sessionStorage = new CountingStorage();
  const turns = specs.map((spec, index) => {
    const kind = String(spec?.kind || 'provider');
    const identity = String(spec?.identity || `structural-turn-${index}`);
    const stable = spec?.stable !== false;
    const virtualized = spec?.virtualized === true;
    const text = String(spec?.text || `structural text ${index}`);
    const turnRoot = elementNode('DIV', [], stable ? { 'data-turn-key': identity } : {});
    const third = elementNode('DIV', [], kind === 'context' ? { class: 'group flex flex-col' } : { class: 'structural-third' });
    const second = elementNode('DIV', [], kind === 'provider'
      ? { class: 'group flex flex-col pb-2 pt-2' }
      : kind === 'context'
        ? { class: 'flex flex-col gap-0' }
        : { class: 'structural-second' });
    const firstAttributes = kind === 'provider'
      ? { class: 'flex flex-col gap-3 browser:gap-1' }
      : kind === 'context'
        ? { class: virtualized ? 'flex flex-col gap-0' : 'flex flex-col', ...(virtualized ? { 'data-virtualized-turn-content': '' } : {}) }
        : { class: 'flex flex-col structural-unknown' };
    const first = elementNode('DIV', [], firstAttributes);
    const block = elementNode('DIV');
    block.parentElement = first;
    first.parentElement = second;
    second.parentElement = third;
    third.parentElement = turnRoot;
    const content = {
      ...elementNode('DIV', [textNode(text)], stable ? { 'data-chatgpt-search-message-ids': `${identity}-message` } : {}),
      innerText: text,
      parentElement: block,
      matches: () => false,
      querySelector: () => null,
      closest: () => null,
    };
    const heading = {
      ...elementNode('H4', [textNode('你说：')]),
      innerText: '你说：',
      nextElementSibling: content,
      parentElement: block,
      closest: () => null,
    };
    return { heading, content };
  });
  const document = {
    querySelectorAll(selector) {
      if (selector === 'main [data-message-author-role="user"]' || selector === 'main [data-role="user"]') return [];
      if (selector === 'main h4' || selector === 'h4') return turns.map(turn => turn.heading);
      return [];
    },
  };
  return { window: {}, document, location, sessionStorage };
}

function targetFor(pageId, href, site = 'deepseek', pageSessionId = '') {
  return {
    pageId,
    resourceIdentity: `resource:${pageId}`,
    origin: new URL(href).origin,
    href: new URL(href).href,
    site,
    ...(pageSessionId ? { pageSessionId } : {}),
  };
}

async function execute(env, operationId, input = {}, agentBridgeSource = '(function unexpectedAgent() { throw new Error("unexpected mutation"); })') {
  const names = ['window', 'document', 'location', 'sessionStorage'];
  const previous = new Map(names.map(name => [name, Object.prototype.hasOwnProperty.call(globalThis, name) ? globalThis[name] : undefined]));
  const had = new Map(names.map(name => [name, Object.prototype.hasOwnProperty.call(globalThis, name)]));
  globalThis.window = env.window;
  globalThis.document = env.document;
  globalThis.location = env.location;
  globalThis.sessionStorage = env.sessionStorage;
  try {
    return await executeOperation({
      ...env,
      operationId,
      input,
      siteAdapterSource,
      pageCoreSource: '(function syntheticCore() {})',
      agentBridgeSource,
    });
  } finally {
    for (const name of names) {
      if (had.get(name)) globalThis[name] = previous.get(name);
      else delete globalThis[name];
    }
  }
}

const deepSeekHref = 'https://chat.deepseek.com/a/chat/synthetic';
const healthy = envFor(deepSeekHref);
const healthyObservation = await execute(healthy, 'observe');
assert.equal(healthyObservation.href, deepSeekHref);
assert.equal(healthyObservation.origin, 'https://chat.deepseek.com');
assert.equal(healthyObservation.site, 'deepseek');
assert.equal(healthyObservation.composerFound, true);
assert.equal(healthyObservation.isDeepSeekAuthPage, false);
assert.equal(healthyObservation.runtimeVersion, null);
assert.equal(healthy.sessionStorage.writes, 0, 'read-only observation must perform zero storage mutation');
assert.equal(healthy.window.__injectionCount, 0, 'read-only observation must not inject a runtime');
assert.equal(healthy.window.__primeCount, 0, 'read-only observation must not prime a runtime');

const auth = envFor('https://chat.deepseek.com/sign_in');
const authObservation = await execute(auth, 'observe');
assert.equal(authObservation.isDeepSeekAuthPage, true);
assert.equal(authObservation.composerFound, false);
assert.equal(auth.sessionStorage.writes, 0);

const running = envFor(deepSeekHref, { runtime: true, running: true });
const runningObservation = await execute(running, 'observe');
assert.equal(runningObservation.workerTurnState, 'running');
assert.equal(running.sessionStorage.writes, 0);

const noComposer = envFor(deepSeekHref, { composer: false });
await assert.rejects(
  () => execute(noComposer, 'connect', { target: targetFor('no-composer', deepSeekHref), bridgePort: 48322, token: 'token', prime: true }),
  /not ready before connect/,
);
assert.equal(noComposer.sessionStorage.writes, 0, 'composer rejection must happen before injection');

const runningConnect = envFor(deepSeekHref, { runtime: true, running: true });
await assert.rejects(
  () => execute(runningConnect, 'connect', { target: targetFor('running', deepSeekHref, 'deepseek', 'session-A'), bridgePort: 48322, token: 'token', prime: true }),
  /not ready before connect/,
);
assert.equal(runningConnect.sessionStorage.writes, 0, 'running-turn rejection must happen before injection');

const chatGptHref = 'https://chatgpt.com/';
const chatGpt = envFor(chatGptHref);
await assert.rejects(
  () => execute(chatGpt, 'connect', { target: targetFor('chatgpt', chatGptHref, 'generic'), bridgePort: 48322, token: 'token', prime: true }),
  /native-MCP bypass target/,
);
assert.equal(chatGpt.sessionStorage.writes, 0, 'native-MCP bypass must reject before injection');

const exactComposerLines = ['# Nimora Explicit Mission Input', '{', '  "version": 1,', '', '  "kind": "explicit-mission-input"  ', '}', ''];
const exactChatGpt = chatGptEnv(chatGptHref, exactComposerLines);
const exactChatGptObservation = await execute(exactChatGpt, 'chatgptObserveComposer');
assert.equal(exactChatGptObservation.composerFound, true);
assert.equal(exactChatGptObservation.composerAmbiguous, false);
assert.equal(exactChatGptObservation.composerText, exactComposerLines.join('\n'), 'fixed ChatGPT DOM observation must preserve leading/trailing whitespace and empty logical lines exactly');
assert.equal(exactChatGpt.sessionStorage.writes, 0, 'fixed ChatGPT composer observation must be read-only');

const pluginOnlyChatGpt = chatGptEnv(chatGptHref, [{ tagName: 'P', childNodes: [pluginMentionNode(), textNode(' ')] }]);
const pluginOnlyObservation = await execute(pluginOnlyChatGpt, 'chatgptObserveComposer');
assert.equal(pluginOnlyObservation.composerAmbiguous, false, 'a structurally valid provider plugin mention must be a recognized decoration');
assert.equal(pluginOnlyObservation.composerText, '', 'a provider plugin mention must not be misclassified as user-authored composer text');
assert.equal(pluginOnlyObservation.composerDecorations.length, 1);
assert.equal(pluginOnlyObservation.composerDecorations[0].kind, 'plugin-mention');
assert.equal(pluginOnlyObservation.composerDecorations[0].name, 'dev-r21-plugin');
assert.equal(pluginOnlyObservation.composerDecorations[0].path, 'plugin://dev-r21-plugin@openai-curated-remote');
assert.equal(pluginOnlyObservation.composerDecorations[0].href, 'plugin://dev-r21-plugin@openai-curated-remote');
assert.equal(pluginOnlyObservation.composerDecorations[0].label, '@dev-r21-plugin');
assert.equal(pluginOnlyObservation.composerDecorationFingerprint.includes('Display label is not identity'), false, 'decoration identity must not depend on provider display-name text');

const pluginWithUserTextChatGpt = chatGptEnv(chatGptHref, [{
  tagName: 'P',
  childNodes: [textNode('HUMAN_DRAFT'), pluginMentionNode(), textNode(' ')],
}]);
const pluginWithUserTextObservation = await execute(pluginWithUserTextChatGpt, 'chatgptObserveComposer');
assert.equal(pluginWithUserTextObservation.composerAmbiguous, false);
assert.equal(pluginWithUserTextObservation.composerText, 'HUMAN_DRAFT', 'real user text must remain visible even when a valid provider plugin mention is present');
assert.equal(pluginWithUserTextObservation.composerDecorations.length, 1);

const malformedDecorationChatGpt = chatGptEnv(chatGptHref, [{
  tagName: 'P',
  childNodes: [elementNode('SPAN', [textNode('UNKNOWN_NON_EDITABLE')], { contenteditable: 'false' })],
}]);
const malformedDecorationObservation = await execute(malformedDecorationChatGpt, 'chatgptObserveComposer');
assert.equal(malformedDecorationObservation.composerAmbiguous, true, 'unknown non-editable composer content must fail closed');
assert.equal(malformedDecorationObservation.composerText, '');
assert.deepEqual(malformedDecorationObservation.composerDecorations, []);

const liveLogicalPropertyRows = [
  '  "version": 1,',
  '  "kind": "explicit-mission-input",',
  '  "projectId": "project",',
  '  "managedRootMissionId": "root",',
  '  "coordinationMissionId": "coordinator",',
  '  "targetMissionId": "target",',
  '  "instructionKind": "final-live-proof",',
  '  "instruction": "bounded",',
  '  "referenceIds": []',
];
const liveLogicalComposerLines = ['# Nimora Explicit Mission Input', '{', ...liveLogicalPropertyRows, '}', '', 'trailing spaces stay exact  '];
const liveDomComposerLines = liveLogicalComposerLines.map(line => line.startsWith('  "') ? `\u00a0 ${line.slice(2)}` : line);
assert.equal(liveDomComposerLines.filter(line => line.startsWith('\u00a0 ')).length, 9, 'live regression must model all nine NBSP + ASCII-space JSON property rows');
const liveShapeChatGpt = chatGptEnv(chatGptHref, liveDomComposerLines);
const liveShapeObservation = await execute(liveShapeChatGpt, 'chatgptObserveComposer');
assert.equal(liveShapeObservation.composerText, liveDomComposerLines.join('\n'), 'fixed ChatGPT DOM observation must preserve the raw browser NBSP representation for expected-aware reconciliation');
assert.equal(liveShapeObservation.composerLineTags.length, liveDomComposerLines.length, 'fixed ChatGPT DOM observation must preserve line provenance alongside raw text');
assert.deepEqual(liveShapeObservation.composerLineTags.slice(2, 11), Array(9).fill('P'), 'all nine live-shape property rows must be provenance-marked as ordinary paragraph blocks');
assert.equal(liveShapeChatGpt.sessionStorage.writes, 0, 'live-shape logical reconstruction must remain read-only');

const semanticNbspLines = ['\u00a0"version": 1,', '  "kind": "semantic\u00a0nbsp",', 'tail \u00a0'];
const semanticNbspChatGpt = chatGptEnv(chatGptHref, semanticNbspLines);
const semanticNbspObservation = await execute(semanticNbspChatGpt, 'chatgptObserveComposer');
assert.equal(semanticNbspObservation.composerText, semanticNbspLines.join('\n'), 'isolated/internal/trailing semantic NBSP must not be broadly normalized');
assert.notEqual(semanticNbspObservation.composerText, semanticNbspLines.join('\n').replaceAll('\u00a0', ' '), 'non-representational NBSP differences must remain visible to strict equality');

const semanticPreText = '\u00a0 semantic-pre';
const semanticPreChatGpt = chatGptEnv(chatGptHref, [{ tagName: 'PRE', text: semanticPreText }]);
const semanticPreObservation = await execute(semanticPreChatGpt, 'chatgptObserveComposer');
assert.equal(semanticPreObservation.composerText, semanticPreText, 'PRE semantic NBSP + ASCII-space content must remain raw and exact');
assert.deepEqual([...semanticPreObservation.composerText.slice(0, 3)].map(char => char.codePointAt(0)), [160, 32, 115], 'PRE semantic prefix codepoints must remain U+00A0 U+0020 without observer normalization');
assert.deepEqual(semanticPreObservation.composerLineTags, ['PRE'], 'PRE provenance must remain explicit for expected-aware reconciliation');
assert.equal(semanticPreChatGpt.sessionStorage.writes, 0, 'semantic PRE observation must remain read-only');

const ambiguousChatGpt = chatGptEnv(chatGptHref, ['ambiguous'], 2);
const ambiguousChatGptObservation = await execute(ambiguousChatGpt, 'chatgptObserveComposer');
assert.equal(ambiguousChatGptObservation.composerAmbiguous, true, 'multiple fixed ChatGPT composer candidates must fail closed');

const wrongChatGptHost = chatGptEnv('https://example.com/', ['must reject']);
await assert.rejects(
  () => execute(wrongChatGptHost, 'chatgptObserveComposer'),
  /rejected non-ChatGPT page/,
);

const realProviderUserLogicalLines = [
  '# Nimora Explicit Mission Input',
  'Project: project',
  'Managed root Mission: root',
  '',
  '## Cognition-authored bounded instruction',
  '{',
  '  "version": 1,',
  '  "kind": "explicit-mission-input",',
  '  "instruction": "line one\\n\\n  indented line",',
  '  "referenceIds": []',
  '}',
];
const realProviderUserDomLines = realProviderUserLogicalLines.map(line => line.startsWith('  "') ? `\u00a0 ${line.slice(2)}` : line);
const fixedProviderUser = chatGptProviderUserEnv('https://chatgpt.com/c/provider-user', [realProviderUserDomLines.join('\n')]);
const fixedProviderUserObservation = await execute(fixedProviderUser, 'chatgptObserveProviderUsers');
assert.equal(fixedProviderUserObservation.providerUsersAmbiguous, false);
assert.equal(fixedProviderUserObservation.userTurns.length, 1, 'fixed provider-user observation must preserve exactly one provider occurrence');
assert.equal(fixedProviderUserObservation.userTurns[0].identity, 'data-testid:conversation-turn-0', 'provider-user identity must come from stable turn structure when available');
assert.equal(fixedProviderUserObservation.userTurns[0].text, realProviderUserDomLines.join('\n'), 'fixed provider-user observation must preserve logical newlines, blank lines, and raw representation whitespace');
assert.deepEqual(fixedProviderUserObservation.userTurns[0].lineTags, Array(realProviderUserDomLines.length).fill('USER_TEXT'), 'ordinary provider-user text must carry bounded representation provenance');
assert.equal(fixedProviderUser.sessionStorage.writes, 0, 'fixed provider-user observation must be read-only');

const semanticProviderUser = chatGptProviderUserEnv('https://chatgpt.com/c/provider-user-pre', ['\u00a0 semantic pre'], { semanticPre: true });
const semanticProviderUserObservation = await execute(semanticProviderUser, 'chatgptObserveProviderUsers');
assert.deepEqual(semanticProviderUserObservation.userTurns[0].lineTags, ['PRE'], 'semantic PRE/CODE provider-user content must not receive ordinary-text reconciliation provenance');

const inlineBody = { ...elementNode('DIV', [textNode('Read '), elementNode('CODE', [textNode('.build/file.txt')]), textNode(' once.\n')]),
  innerText: 'Read .build/file.txt once.\n', closest: () => null };
const inlineEnv = chatGptProviderUserEnv('https://chatgpt.com/c/inline-code', [inlineBody.innerText + '…\n显示更多'], { inlineCodeBody: inlineBody });
const inlineObservation = await execute(inlineEnv, 'chatgptObserveProviderUsers');
assert.equal(inlineObservation.userTurns[0].text, 'Read .build/file.txt once.\n…\n显示更多', 'raw provider text is never replaced by observer');
assert.equal(inlineObservation.userTurns[0].inlineCodeText, 'Read `.build/file.txt` once.\n…\n显示更多', 'only plain direct inline CODE boundaries supply an expected-aware candidate');
assert.equal(inlineEnv.sessionStorage.writes, 0);
inlineBody.innerText = 'Read different visible text once.\n';
inlineEnv.document.querySelectorAll('main h4')[0].nextElementSibling.innerText = inlineBody.innerText + '…\n显示更多';
assert.equal((await execute(inlineEnv, 'chatgptObserveProviderUsers')).userTurns[0].inlineCodeText, '', 'hidden or altered DOM text must not supply other bytes');
inlineBody.innerText = 'Read .build/file.txt once.\n';
inlineEnv.document.querySelectorAll('main h4')[0].nextElementSibling.innerText = inlineBody.innerText + '…\n显示更多';
inlineBody.childNodes[1].tagName = 'SPAN';
assert.equal((await execute(inlineEnv, 'chatgptObserveProviderUsers')).userTurns[0].inlineCodeText, '', 'unknown formatted element must not supply a candidate');
inlineBody.childNodes[1].tagName = 'CODE';
inlineBody.closest = () => ({ tagName: 'PRE' });
assert.equal((await execute(inlineEnv, 'chatgptObserveProviderUsers')).userTurns[0].inlineCodeText, '', 'semantic PRE must not be reinterpreted');

const duplicateProviderIdentity = chatGptProviderUserEnv('https://chatgpt.com/c/provider-user-duplicate', ['one', 'two'], { duplicateIdentity: true });
const duplicateProviderIdentityObservation = await execute(duplicateProviderIdentity, 'chatgptObserveProviderUsers');
assert.equal(duplicateProviderIdentityObservation.providerUsersAmbiguous, true, 'duplicate provider-user structural identities must fail closed');
assert.equal(duplicateProviderIdentityObservation.reason, 'duplicate-provider-user-identity');

const structuralProvider = chatGptStructuralProviderUserEnv('https://chatgpt.com/c/r22-provider', [
  { kind: 'provider', identity: 'provider-turn-r22', text: 'provider payload' },
]);
const structuralProviderObservation = await execute(structuralProvider, 'chatgptObserveProviderUsers');
assert.equal(structuralProviderObservation.providerUsersAmbiguous, false);
assert.equal(structuralProviderObservation.userTurns[0].identity, 'data-turn-key:provider-turn-r22');
assert.equal(structuralProviderObservation.userTurns[0].identityStable, true);
assert.equal(structuralProviderObservation.userTurns[0].identitySource, 'data-turn-key');
assert.equal(structuralProviderObservation.userTurns[0].presentationKind, 'provider-user-turn');
assert.equal(structuralProviderObservation.userTurns[0].virtualized, false);

const structuralWorkContext = chatGptStructuralProviderUserEnv('https://chatgpt.com/c/r22-context', [
  { kind: 'context', identity: 'work-context-r22-live', text: 'opaque live context' },
  { kind: 'context', identity: 'work-context-r22-virtualized', text: 'opaque virtualized context', virtualized: true },
]);
const structuralWorkContextObservation = await execute(structuralWorkContext, 'chatgptObserveProviderUsers');
assert.equal(structuralWorkContextObservation.providerUsersAmbiguous, false);
assert.deepEqual(
  structuralWorkContextObservation.userTurns.map(turn => [turn.presentationKind, turn.identityStable, turn.virtualized]),
  [['work-context-turn', true, false], ['work-context-turn', true, true]],
  'R22 Work context authority must come from stable structural provenance, including virtualized windows',
);

const structuralUnknown = chatGptStructuralProviderUserEnv('https://chatgpt.com/c/r22-unknown', [
  { kind: 'unknown', identity: 'unknown-r22', text: 'opaque unknown user occurrence' },
]);
const structuralUnknownObservation = await execute(structuralUnknown, 'chatgptObserveProviderUsers');
assert.equal(structuralUnknownObservation.providerUsersAmbiguous, false);
assert.equal(structuralUnknownObservation.userTurns[0].presentationKind, 'unknown-user-turn');
assert.equal(structuralUnknownObservation.userTurns[0].identityStable, true);

const unstableStructuralUser = chatGptStructuralProviderUserEnv('https://chatgpt.com/c/r22-unstable', [
  { kind: 'context', stable: false, text: 'opaque unstable context' },
]);
const unstableStructuralUserObservation = await execute(unstableStructuralUser, 'chatgptObserveProviderUsers');
assert.equal(unstableStructuralUserObservation.providerUsersAmbiguous, true, 'R22 must reject ordinal/unstable provider-user identity fallback');
assert.equal(unstableStructuralUserObservation.reason, 'unstable-provider-user-identity');

const wrongProviderUserHost = chatGptProviderUserEnv('https://example.com/', ['must reject']);
await assert.rejects(
  () => execute(wrongProviderUserHost, 'chatgptObserveProviderUsers'),
  /rejected non-ChatGPT page/,
);

const syntheticAgentSource = `(function syntheticInternalAgent() {
  window.__injectionCount = Number(window.__injectionCount || 0) + 1;
  let sessionId = sessionStorage.getItem('shuncode-webmcp-page-session-id') || 'created-session';
  sessionStorage.setItem('shuncode-webmcp-page-session-id', sessionId);
  window.__shuncodeWebMcp = {
    version: 25,
    prime: async () => { window.__primeCount = Number(window.__primeCount || 0) + 1; return { ok: true }; },
    status: () => ({ version: 25, enabled: true, pageSessionId: sessionId, workerTurn: null }),
    workerSession: () => ({ sessionId, site: 'deepseek', origin: location.origin, href: location.href, transport: 'test' }),
  };
  return { version: 25, enabled: true };
})`;
const connectable = envFor(deepSeekHref);
const connected = await execute(
  connectable,
  'connect',
  { target: targetFor('stable', deepSeekHref), bridgePort: 48322, token: 'token', prime: true },
  syntheticAgentSource,
);
assert.equal(connected.workerSession.sessionId, 'created-session');
assert.equal(connectable.window.__injectionCount, 1);
assert.equal(connectable.window.__primeCount, 1);

assert.match(runPlaywrightSource, /confirmationMessages:\s*\{/);
assert.match(runPlaywrightSource, /Run Playwright Code\?/);
assert.match(runPlaywrightSource, /Make sure you trust the code before continuing/);
assert.match(adapterSource, /assertOnlyKeys\(value, \['operationId', 'pageId', 'expectedHref', 'target', 'prime', 'bridgePort', 'token', 'control', 'deferredResultId', 'timeoutMs'\]/);
assert.equal(/assertOnlyKeys\(value[^\n]*(?:'code'|'script'|'expression'|'javascript'|'functionSource')/.test(adapterSource), false, 'caller schema must expose no executable-source field');
assert.match(adapterSource, /read\('webmcp-internal-browser-operations\.js'\)/);
assert.match(adapterSource, /read\('webmcp-internal-browser-policy\.json'\)/);
assert.match(adapterSource, /model\.sharingState !== BrowserViewSharingState\.Shared/);
assert.match(adapterSource, /playwrightService\.isPageTracked\(pageId\)/);
assert.equal(adapterSource.includes("'chatgpt.com'"), false, 'native-MCP product policy must stay outside generic Workbench adapter code');
assert.equal(adapterSource.includes("'chat.openai.com'"), false, 'native-MCP product policy must stay outside generic Workbench adapter code');
assert.deepEqual(internalPolicy.nativeMcpBypassHosts, ['chatgpt.com', 'chat.openai.com']);
assert.match(adapterSource, /'chatgptObserveComposer'/);
assert.match(adapterSource, /'chatgptObserveProviderUsers'/);
assert.match(adapterSource, /\['listSharedPages', 'observe', 'chatgptObserveComposer', 'chatgptObserveProviderUsers', 'connect', 'control'\]\.includes\(operationId\)/);
assert.match(adapterSource, /nativeMcpMode === 'require'/);
assert.match(adapterSource, /Browser page identity changed before fixed internal operation/);
assert.match(adapterSource, /Deferred internal browser operation identity does not match this page\/operation/);
assert.match(adapterSource, /'action', 'sessionId', 'expectedOrigin', 'expectedHref', 'expectedSite'/);
assert.match(adapterSource, /owner\.controlIdentity !== controlIdentity\(request\.control\)/);
assert.match(adapterSource, /const identity = JSON\.stringify\(control\)/);
const asyncHelperSource = adapterSource.slice(adapterSource.indexOf('async function loadAssets'), adapterSource.indexOf('export function registerWebMcpInternalBrowserOperationCommand'));
assert.equal(asyncHelperSource.includes('accessor.get('), false, 'async internal-browser helpers must not retain the command ServicesAccessor past command invocation');
assert.match(adapterSource, /const browserViewService = accessor\.get\(IBrowserViewWorkbenchService\);/);
assert.match(adapterSource, /const playwrightService = accessor\.get\(IPlaywrightService\);/);
assert.match(adapterSource, /const extensionService = accessor\.get\(IExtensionService\);/);
assert.match(adapterSource, /const fileService = accessor\.get\(IFileService\);/);
assert.match(adapterSource, /`async \(page, payload\) => \{/);
assert.equal(adapterSource.includes('const payload = args[0];'), false, 'IPlaywrightService spreads invokeFunction args into the compiled function parameters');

const observeStart = extensionSource.indexOf('async function observeSharedWebMcpWorkerPage');
const observeEnd = extensionSource.indexOf('\nasync function listSharedWebMcpWorkerResources', observeStart);
const observationRoute = extensionSource.slice(observeStart, observeEnd);
assert.match(observationRoute, /runDeferredInternalBrowserOperation/);
assert.equal(observationRoute.includes('run_playwright_code'), false);
assert.equal(observationRoute.includes('vscode.lm.invokeTool'), false);
assert.match(observationRoute, /shouldBypassWebMcp\(page\?\.url\).*normalizeBypassResource/);

const chatGptObserveStart = extensionSource.indexOf('async function observeExactChatGptComposer');
const chatGptObserveEnd = extensionSource.indexOf('\nfunction parseSharedBrowserPages', chatGptObserveStart);
const chatGptObservationRoute = extensionSource.slice(chatGptObserveStart, chatGptObserveEnd);
assert.ok(chatGptObserveStart >= 0 && chatGptObserveEnd > chatGptObserveStart);
assert.match(chatGptObservationRoute, /operationId: 'chatgptObserveComposer'/);
assert.match(chatGptObservationRoute, /operationId: 'chatgptObserveProviderUsers'/);
assert.equal(chatGptObservationRoute.includes('run_playwright_code'), false, 'fixed ChatGPT composer observation must not expose arbitrary Playwright execution');
assert.equal(chatGptObservationRoute.includes('invokeBuiltinBrowserTool'), false, 'fixed ChatGPT composer observation must stay outside LanguageModelToolsService');

const connectStart = extensionSource.indexOf('async function connectWebMcpWorkerPage');
const connectElse = extensionSource.indexOf('  } else {', connectStart);
const exactConnectRoute = extensionSource.slice(connectStart, connectElse);
assert.match(exactConnectRoute, /runDeferredInternalBrowserOperation/);
assert.equal(exactConnectRoute.includes('run_playwright_code'), false, 'exact connect must not call the arbitrary-code LM tool');
assert.equal(exactConnectRoute.includes('invokeBuiltinBrowserTool'), false, 'exact connect must stay outside LanguageModelToolsService');

const statusBarConnectStart = extensionSource.indexOf('async function connectCurrentWebMcpPage');
const statusBarConnectEnd = extensionSource.indexOf('\nasync function connectWebMcpWorkerPage', statusBarConnectStart);
const statusBarConnectRoute = extensionSource.slice(statusBarConnectStart, statusBarConnectEnd);
assert.ok(statusBarConnectStart >= 0 && statusBarConnectEnd > statusBarConnectStart, 'status-bar connect route must be extractable');
assert.match(statusBarConnectRoute, /listSharedBrowserPagesInternal/);
assert.match(statusBarConnectRoute, /observeSharedWebMcpWorkerPage/);
assert.match(statusBarConnectRoute, /connectWebMcpWorkerPage\(output, \{ target, prime: true \}\)/);
const statusBarNonBypassRoute = statusBarConnectRoute.slice(statusBarConnectRoute.indexOf('const observation'));
assert.equal(statusBarNonBypassRoute.includes('run_playwright_code'), false, 'non-native status-bar connect must not call the arbitrary-code LM tool');

// Exercise the real extension cleanup callback, not merely its helper. The
// visibility owner accepts a named identity object, never positional strings.
const cleanupMarker = "vscode.commands.registerCommand('_shuncode.webMcp.archiveRetiredConversation', ";
const cleanupStart = extensionSource.indexOf(cleanupMarker);
const cleanupEnd = extensionSource.indexOf("\n    vscode.commands.registerCommand('_shuncode.webMcp.workerProbeResource'", cleanupStart);
assert(cleanupStart >= 0 && cleanupEnd > cleanupStart);
const cleanupCallback = extensionSource.slice(cleanupStart + cleanupMarker.length, cleanupEnd).trim().replace(/\),$/, '');
for (const provider of ['deepseek', 'chatgpt']) {
  const request = { provider, pageId: 'retired-exact-page', adapterSessionId: 'retired-exact-session',
    expectedHref: provider === 'deepseek' ? 'https://chat.deepseek.com/a/chat/s/retired' : 'https://chatgpt.com/c/retired' };
  let row = { href: request.expectedHref, ready: true, pageSessionId: request.adapterSessionId,
    workerTurnState: 'idle', lifecycleIdentity: request.adapterSessionId, stopButtonRef: '' };
  const visibilityCalls = [];
  let cleanupCalls = 0;
  let driftAfterVisibility = false;
  let cleanupShouldClick = false;
  let browserClicks = 0;
  const observe = async pageId => { assert.equal(pageId, request.pageId); return row; };
  const callback = new Function('probeSharedWebMcpWorkerResource', 'chatGptWorkerController',
    'ensureExactSharedBrowserPageVisible', 'runProviderConversationCleanup', 'resultText', 'invokeBuiltinBrowserTool',
    `return (${cleanupCallback});`)(observe, { probeResource: observe }, async input => {
      assert.deepEqual(input, { pageId: request.pageId, expectedUrl: request.expectedHref, label: 'retired provider cleanup page' });
      visibilityCalls.push(input);
      if (driftAfterVisibility) row = { ...row, workerTurnState: 'running', stopButtonRef: 'stop' };
    }, async (host, input) => {
      cleanupCalls++;
      assert.equal(visibilityCalls.length, cleanupCalls, 'fresh settled identity and exact visibility must precede each cleanup');
      assert.deepEqual(input, { ...request, mode: 'archive-only' });
      if (cleanupShouldClick) await host.clickElement(request.pageId, 'archive', 'Archive');
      return { state: 'archived' };
    }, value => value, async () => { browserClicks++; return {}; });
  assert.equal((await callback(request)).state, 'archived');
  row = { ...row, href: request.expectedHref + '-drift' };
  await assert.rejects(() => callback(request), /identity or settled state changed/);
  assert.equal(cleanupCalls, 1, 'drift cannot retry cleanup');
  assert.equal(visibilityCalls.length, 1, 'drift stops before presentation or cleanup');
  row = { ...row, href: request.expectedHref, workerTurnState: 'completed' };
  assert.equal((await callback(request)).state, 'archived', 'a completed retired turn is settled');
  if (provider === 'deepseek') {
    const before = cleanupCalls;
    for (const workerTurnState of ['running', 'unknown', 'failed', 'interrupted', undefined]) {
      row = { ...row, workerTurnState };
      await assert.rejects(() => callback(request), /identity or settled state changed/);
    }
    assert.equal(cleanupCalls, before, 'unsettled or unrecognized turns never reach cleanup');
  }
  row = { ...row, workerTurnState: 'completed', stopButtonRef: '' };
  cleanupShouldClick = true;
  driftAfterVisibility = true;
  await assert.rejects(() => callback(request), /identity or settled state changed/);
  assert.equal(browserClicks, 0, 'a fresh running observation blocks the archive click after visibility preparation');
}

assert.equal(/assistantMessage|assistantText|provider transcript|document\.body\?\.innerText/i.test(operationSource), false, 'fixed observation implementation must not read provider transcript surfaces');

console.log(JSON.stringify({
  result: 'PASS',
  hiddenNativePageRejectedBeforeSubmission: true,
  deferredObservationNeverResubmitsHiddenPage: true,
  arbitraryRunPlaywrightStillConfirmationGated: true,
  observationUsesFixedInternalOperation: true,
  exactConnectUsesFixedInternalOperation: true,
  statusBarConnectUsesFixedInternalOperation: true,
  callerControlledExecutableSourceFields: false,
  deepSeekLikeObservationSucceeded: true,
  observationMutationCount: healthy.sessionStorage.writes,
  authNonAdmissible: true,
  composerUnavailableRejectedBeforeMutation: true,
  runningTurnRejectedBeforeMutation: true,
  nativeMcpBypassRejectedBeforeMutation: true,
  chatGptExactComposerObservationReadOnly: true,
  chatGptExactComposerWhitespaceFaithful: true,
  chatGptExactProviderUserObservationReadOnly: true,
  chatGptExactProviderUserLogicalLinesFaithful: true,
  chatGptProviderUserDuplicateIdentityRejected: true,
  chatGptProviderUserStructuralProvenance: true,
  chatGptWorkContextStructuralProvenance: true,
  chatGptVirtualizedWorkContextProvenance: true,
  chatGptUnknownUserProvenanceExposed: true,
  chatGptUnstableProviderUserIdentityRejected: true,
  chatGptAmbiguousComposerRejected: true,
  chatGptWrongHostRejected: true,
  exactConnectStableFixtureSucceeded: true,
  exactSharedPageAndDeferredOwnershipGuardsPresent: true,
  commandServicesCapturedBeforeAsyncWork: true,
  invokeFunctionPayloadUsesSpreadArgumentContract: true,
}, null, 2));
