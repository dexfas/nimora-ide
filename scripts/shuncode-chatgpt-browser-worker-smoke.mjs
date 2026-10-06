import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { createChatGptWorkerController } = require('../extensions/shuncode-webmcp/chatgpt-worker-controller.js');
const chatGptResources = require('../extensions/shuncode-webmcp/chatgpt-worker-resources.js');
const internalOperationSource = await fs.readFile(path.join(root, 'extensions', 'shuncode-webmcp', 'webmcp-internal-browser-operations.js'), 'utf8');
const executeInternalOperation = new Function(`return (${internalOperationSource.trim()});`)();

const PAGE_ID = '11111111-1111-4111-8111-111111111111';
let href = 'https://chatgpt.com/';
let composerFound = true;
let streaming = false;
let responseComplete = false;
let assistantTexts = [];
let userTexts = [];
let pendingPrompt = '';
let unsafeDecoratedMultilineKeyEvents = 0;
let sentCount = 0;
let interrupted = false;
let transientPreConversationObservations = 0;
let unchangedReads = 0;
let listedPageId = PAGE_ID;
let delayedFirstConversationPrompt = '';
let delayedFirstConversationStage = 0;
let ambiguousComposer = false;
let exactComposerMismatch = false;
let composerTrailingEmptyParagraphs = 0;
let composerTrailingEmptyParagraphTag = 'P';
let liveShapeComposerRepresentation = false;
let semanticPreExactRepresentation = false;
let semanticPreObservedAsciiMismatch = false;
let semanticPreObservedNbspMismatch = false;
let flattenProviderUserSnapshot = false;
let liveShapeProviderUserRepresentation = false;
let providerUserDomTransform = null;
let exactProviderUserExtras = [];
let exactProviderUserProjection = null;
let providerUserRepresentationVersion = 2;
let accessibilitySyntheticUsers = [];
let submitMode = 'success';
let submitControlMode = 'single';
let pageVisible = true;
let activationMode = 'success';
let activationCount = 0;
let composerPluginMentionName = '';
let composerPluginMentionDriftOnPrompt = false;
let composerLeadingDecorationSeparator = false;
let composerNbspIndentation = false;
const browserCalls = [];
const forcedReadPageTexts = [];
const MULTILINE_PROMPT = '# Nimora Explicit Mission Input\nline two\nline three';
const LIVE_SHAPE_PROPERTY_ROWS = [
  '  "version": 1,',
  '  "kind": "explicit-mission-input",',
  '  "projectId": "project",',
  '  "managedRootMissionId": "root",',
  '  "coordinationMissionId": "coordinator",',
  '  "targetMissionId": "target",',
  '  "instructionKind": "final-live-proof",',
  '  "instruction": "Final WO#1 Real Live Proof 020.\\n\\nUse only the provider-originated Mission-native MCP authority.\\n\\n  Preserve semantic indentation exactly.",',
  '  "referenceIds": []',
];
const REAL_SHAPE_CONTEXT_ROWS = Array.from({ length: 18 }, (_, index) =>
  `- {"authority":"durable-fact","content":{"ordinal":${index},"text":"Phase-8 bounded context row ${index}"}}`);
const REAL_SHAPE_PROMPT = [
  '# Nimora Explicit Mission Input',
  'Project: project',
  'Managed root Mission: root',
  'Coordinator Mission: coordinator',
  'Target Mission: target',
  '',
  '## Cognition-authored bounded instruction',
  '{',
  ...LIVE_SHAPE_PROPERTY_ROWS,
  '}',
  '',
  '## Owner-backed Mission Context',
  '# Nimora Mission Context',
  '',
  '## history/handoff',
  ...REAL_SHAPE_CONTEXT_ROWS,
].join('\n');
const REAL_SHAPE_FLATTENED_SNAPSHOT_TEXT = REAL_SHAPE_PROMPT
  .split('\n')
  .map(line => line.trim())
  .filter(Boolean)
  .join(' ');

function pluginMentionDecoration(name) {
  const path = `plugin://${name}@openai-curated-remote`;
  return {
    kind: 'plugin-mention',
    tagName: 'SPAN',
    name,
    path,
    href: path,
    label: `@${name}`,
  };
}

function pluginMentionObservationDecoration() {
  if (!composerPluginMentionName) return [];
  const name = composerPluginMentionDriftOnPrompt && pendingPrompt
    ? `${composerPluginMentionName}-drift`
    : composerPluginMentionName;
  return [pluginMentionDecoration(name)];
}
const realShapeFlattenedParserProbe = chatGptResources.parseReadPageResult(
  { pageId: PAGE_ID, title: 'ChatGPT', url: 'https://chatgpt.com/c/real-shape-flattened-parser-probe' },
  [
    'Page Title: ChatGPT',
    'URL: https://chatgpt.com/c/real-shape-flattened-parser-probe',
    'Snapshot:',
    '- heading "You said:" [level=4] [ref=real-shape-user]',
    `  - generic [ref=real-shape-text]: ${JSON.stringify(REAL_SHAPE_FLATTENED_SNAPSHOT_TEXT)}`,
    '- group "Your message actions"',
    '- textbox "Message ChatGPT" [active] [ref=composer]:',
    '  - paragraph: "Message ChatGPT"',
  ].join('\n'),
);
assert.equal(realShapeFlattenedParserProbe.userMessages.length, 1, 'real 020-shaped accessibility snapshot must expose one user occurrence');
assert.equal(
  realShapeFlattenedParserProbe.userMessages[0].text,
  REAL_SHAPE_FLATTENED_SNAPSHOT_TEXT,
  'regression must faithfully model the accessibility snapshot flattening that falsified 020',
);
assert.notEqual(
  realShapeFlattenedParserProbe.userMessages[0].text,
  REAL_SHAPE_PROMPT,
  'flattened accessibility text must remain visibly non-equal to the admitted multiline prompt',
);
assert.match(
  realShapeFlattenedParserProbe.userMessages[0].text,
  /^# Nimora Explicit Mission Input Project:/,
  'real 020-shaped parser falsifier must preserve the observed flattened header prefix',
);

const responseCompleteParserProbe = chatGptResources.parseReadPageResult(
  { pageId: PAGE_ID, title: 'ChatGPT', url: 'https://chatgpt.com/c/terminal-probe' },
  [
    'Page Title: ChatGPT',
    'URL: https://chatgpt.com/c/terminal-probe',
    'Snapshot:',
    '- heading "ChatGPT said:" [level=4] [ref=assistant-terminal]',
    '  - paragraph [ref=assistant-terminal-text]: "FINAL"',
    '- status [ref=response-complete]: 回答已完成',
  ].join('\n'),
);
assert.equal(
  responseCompleteParserProbe.responseComplete,
  true,
  'real ChatGPT Chinese provider terminal marker must be parsed as response-complete truth',
);

const streamingParserProbe = chatGptResources.parseReadPageResult(
  { pageId: PAGE_ID, title: 'ChatGPT', url: 'https://chatgpt.com/c/parser-probe' },
  [
    'Page Title: ChatGPT',
    'URL: https://chatgpt.com/c/parser-probe',
    'Snapshot:',
    '- heading "ChatGPT said:" [level=4] [ref=assistant-heading]',
    '  - generic [ref=assistant-body]:',
    '    - paragraph [ref=assistant-text]: PARTIAL_ASSISTANT_TEXT',
    '    - generic [ref=thinking-ui]: Thinking',
    '- generic [ref=footer-ui]: ChatGPT can make mistakes.',
    '- textbox "Message ChatGPT" [ref=composer]:',
    '  - paragraph: Message ChatGPT',
  ].join('\n'),
);
assert.deepEqual(streamingParserProbe.assistantTexts, ['PARTIAL_ASSISTANT_TEXT'], 'assistant streaming extraction must exclude generic page chrome/status text');

const multilineParserProbe = chatGptResources.parseReadPageResult(
  { pageId: PAGE_ID, title: 'ChatGPT', url: 'https://chatgpt.com/c/multiline-parser-probe' },
  [
    'Page Title: ChatGPT',
    'URL: https://chatgpt.com/c/multiline-parser-probe',
    'Snapshot:',
    '- textbox "Message ChatGPT" [active] [ref=composer]:',
    '  - paragraph: "# Nimora Explicit Mission Input"',
    '  - paragraph: "line two"',
    '  - paragraph: "line three"',
    '  - generic [ref=toolbar]:',
    '    - button "Model" [ref=model] [cursor=pointer]:',
    '      - generic: GPT-5',
    '    - button "Start dictation" [ref=dictation] [cursor=pointer]',
  ].join('\n'),
);
assert.equal(multilineParserProbe.composerText, MULTILINE_PROMPT, 'multiline composer leaves must reconstruct the exact logical prompt');
assert.equal(multilineParserProbe.composerAmbiguous, false, 'known nested action chrome must not make composer content ambiguous');

const placeholderParserProbe = chatGptResources.parseReadPageResult(
  { pageId: PAGE_ID, title: 'ChatGPT', url: 'https://chatgpt.com/c/placeholder-parser-probe' },
  'Page Title: ChatGPT\nURL: https://chatgpt.com/c/placeholder-parser-probe\nSnapshot:\n- textbox "Message ChatGPT" [ref=composer]:\n  - paragraph: "Message ChatGPT"',
);
assert.equal(placeholderParserProbe.composerText, '', 'placeholder-only composer must remain logically empty');

const ambiguousParserProbe = chatGptResources.parseReadPageResult(
  { pageId: PAGE_ID, title: 'ChatGPT', url: 'https://chatgpt.com/c/ambiguous-parser-probe' },
  'Page Title: ChatGPT\nURL: https://chatgpt.com/c/ambiguous-parser-probe\nSnapshot:\n- textbox "Message ChatGPT" [ref=composer]:\n  - generic: "UNCLASSIFIED COMPOSER TEXT"',
);
assert.equal(ambiguousParserProbe.composerAmbiguous, true, 'unclassified non-interactive composer text must fail closed as ambiguous');

const exactSubmitParserProbe = chatGptResources.parseReadPageResult(
  { pageId: PAGE_ID, title: 'ChatGPT', url: 'https://chatgpt.com/c/submit-probe' },
  [
    'Page Title: ChatGPT',
    'URL: https://chatgpt.com/c/submit-probe',
    'Snapshot:',
    '- textbox "Message ChatGPT" [active] [ref=composer]:',
    '  - paragraph: "ready to send"',
    '  - generic [ref=toolbar]:',
    '    - button "Attach files" [ref=attach] [cursor=pointer]',
    '    - button "Model" [ref=model] [cursor=pointer]',
    '    - button [ref=send] [cursor=pointer]',
    '      - img',
  ].join('\n'),
);
assert.equal(exactSubmitParserProbe.sendButtonRef, 'send', 'one structurally isolated unlabeled action beside labeled toolbar controls is the exact submit control');
assert.equal(exactSubmitParserProbe.sendButtonAmbiguous, false);

const labeledSubmitParserProbe = chatGptResources.parseReadPageResult(
  { pageId: PAGE_ID, title: 'ChatGPT', url: 'https://chatgpt.com/c/labeled-submit-probe' },
  'Page Title: ChatGPT\nURL: https://chatgpt.com/c/labeled-submit-probe\nSnapshot:\n- textbox "Message ChatGPT" [active] [ref=composer]:\n  - paragraph: "ready to send"\n  - generic [ref=toolbar]:\n    - button "Attach files" [ref=attach] [cursor=pointer]\n    - button "Send" [ref=semantic-send] [cursor=pointer]',
);
assert.equal(labeledSubmitParserProbe.sendButtonRef, 'semantic-send', 'an explicitly labeled Send control must be preferred as exact submit identity');
assert.equal(labeledSubmitParserProbe.sendButtonAmbiguous, false);

const currentZhSubmitParserProbe = chatGptResources.parseReadPageResult(
  { pageId: PAGE_ID, title: 'ChatGPT', url: 'https://chatgpt.com/c/current-zh-submit-probe' },
  'Page Title: ChatGPT\nURL: https://chatgpt.com/c/current-zh-submit-probe\nSnapshot:\n- textbox "与 ChatGPT 聊天" [active] [ref=composer]:\n  - paragraph: "ready to send"\n  - generic [ref=toolbar]:\n    - button "添加文件等" [ref=attach] [cursor=pointer]\n    - button "发送提示词" [ref=semantic-send-zh] [cursor=pointer]',
);
assert.equal(currentZhSubmitParserProbe.sendButtonRef, 'semantic-send-zh', 'the exact current 发送提示词 label must be admitted as submit semantics');
assert.equal(currentZhSubmitParserProbe.sendButtonAmbiguous, false);

const disabledSubmitParserProbe = chatGptResources.parseReadPageResult(
  { pageId: PAGE_ID, title: 'ChatGPT', url: 'https://chatgpt.com/c/disabled-submit-probe' },
  'Page Title: ChatGPT\nURL: https://chatgpt.com/c/disabled-submit-probe\nSnapshot:\n- textbox "Message ChatGPT" [active] [ref=composer]:\n  - paragraph: "ready to send"\n  - generic [ref=toolbar]:\n    - button "Send" [disabled] [ref=disabled-send]',
);
assert.equal(disabledSubmitParserProbe.sendButtonRef, '', 'disabled Send control must not be admitted as a submit gesture');

const missingSubmitParserProbe = chatGptResources.parseReadPageResult(
  { pageId: PAGE_ID, title: 'ChatGPT', url: 'https://chatgpt.com/c/missing-submit-probe' },
  'Page Title: ChatGPT\nURL: https://chatgpt.com/c/missing-submit-probe\nSnapshot:\n- textbox "Message ChatGPT" [active] [ref=composer]:\n  - paragraph: "ready to send"\n  - generic [ref=toolbar]:\n    - button "Attach files" [ref=attach] [cursor=pointer]\n    - button "Model" [ref=model] [cursor=pointer]',
);
assert.equal(missingSubmitParserProbe.sendButtonRef, '', 'labeled non-submit toolbar controls must never be guessed as submit');
assert.equal(missingSubmitParserProbe.sendButtonAmbiguous, false);

const ambiguousSubmitParserProbe = chatGptResources.parseReadPageResult(
  { pageId: PAGE_ID, title: 'ChatGPT', url: 'https://chatgpt.com/c/ambiguous-submit-probe' },
  'Page Title: ChatGPT\nURL: https://chatgpt.com/c/ambiguous-submit-probe\nSnapshot:\n- textbox "Message ChatGPT" [active] [ref=composer]:\n  - paragraph: "ready to send"\n  - generic [ref=toolbar]:\n    - button [ref=unknown-a] [cursor=pointer]\n    - button [ref=unknown-b] [cursor=pointer]',
);
assert.equal(ambiguousSubmitParserProbe.sendButtonRef, '', 'multiple unlabeled action controls must not select a submit target');
assert.equal(ambiguousSubmitParserProbe.sendButtonAmbiguous, true, 'multiple unlabeled action controls must be reported as ambiguous');

function listText() {
  return `- [${listedPageId}] ChatGPT (${href}) ${pageVisible ? 'visible' : 'not visible'}`;
}

function composerContentSnapshot(text, indent = '    ') {
  if (ambiguousComposer) return `${indent}- generic: "UNCLASSIFIED COMPOSER TEXT"`;
  const logical = text || 'Message ChatGPT';
  return logical.split('\n').map((line, index) => {
    if (line === '') return `${indent}- paragraph [ref=composer-line-${index}]`;
    const lossySnapshotLine = line.replace(/^\s+/, '');
    return `${indent}- paragraph [ref=composer-line-${index}]: ${JSON.stringify(lossySnapshotLine)}`;
  }).join('\n');
}

function readText(observationHref = href) {
  const blocks = [];
  const count = Math.max(userTexts.length, assistantTexts.length);
  for (let index = 0; index < count; index += 1) {
    if (userTexts[index]) {
      const snapshotText = flattenProviderUserSnapshot
        ? userTexts[index].split('\n').map(line => line.trim()).filter(Boolean).join(' ')
        : userTexts[index];
      blocks.push(
        `      - heading "You said:" [level=4] [ref=user${index}]`,
        `      - generic [ref=u${index}]: ${JSON.stringify(snapshotText)}`,
        '      - group "Your message actions"',
      );
    }
    if (assistantTexts[index]) {
      blocks.push(
        `      - heading "ChatGPT said:" [level=4] [ref=assistant${index}]`,
        `      - paragraph [ref=a${index}]: ${JSON.stringify(assistantTexts[index])}`,
        '      - group "Response actions"',
      );
    }
  }
  for (let index = 0; index < accessibilitySyntheticUsers.length; index += 1) {
    blocks.push(
      `      - heading "You said:" [level=4] [ref=synthetic-user-${index}]`,
      `      - generic [ref=synthetic-user-text-${index}]: ${JSON.stringify(accessibilitySyntheticUsers[index])}`,
      '      - group "Your message actions"',
    );
  }
  if (composerFound) {
    blocks.push('  - textbox "Message ChatGPT" [active] [ref=composer]', composerContentSnapshot(pendingPrompt));
    blocks.push(
      '    - generic [ref=toolbar]',
      '      - button "Attach files" [ref=attach] [cursor=pointer]',
      '      - button "Model" [ref=model] [cursor=pointer]',
      '        - generic: High',
    );
    if (pendingPrompt && submitControlMode === 'single') blocks.push('      - button [ref=send] [cursor=pointer]', '        - img');
    if (pendingPrompt && submitControlMode === 'explicit') blocks.push('      - button "Send" [ref=send] [cursor=pointer]');
    if (pendingPrompt && submitControlMode === 'current-zh') blocks.push('      - button "发送提示词" [ref=send] [cursor=pointer]');
    if (pendingPrompt && submitControlMode === 'ambiguous') {
      blocks.push('      - button [ref=send-a] [cursor=pointer]', '        - img', '      - button [ref=send-b] [cursor=pointer]', '        - img');
    }
    if (!streaming && !pendingPrompt) blocks.push('      - button "Start dictation" [ref=dictation] [cursor=pointer]');
  }
  if (streaming) blocks.push('  - button "Stop generating" [ref=stop]');
  if (responseComplete) blocks.push('  - status [ref=response-complete]: Response complete');
  return `Page Title: ChatGPT\nURL: ${observationHref}\nSnapshot:\n${blocks.join('\n')}`;
}

function composerDelta(text) {
  const controls = [
    '  - generic [ref=toolbar]:',
    '    - button "Attach files" [ref=attach] [cursor=pointer]',
    '    - button "Model" [ref=model] [cursor=pointer]',
    '      - generic: High',
  ];
  if (text && submitControlMode === 'single') controls.push('    - button [ref=send] [cursor=pointer]', '      - img');
  if (text && submitControlMode === 'explicit') controls.push('    - button "Send" [ref=send] [cursor=pointer]');
  if (text && submitControlMode === 'current-zh') controls.push('    - button "发送提示词" [ref=send] [cursor=pointer]');
  if (text && submitControlMode === 'ambiguous') controls.push('    - button [ref=send-a] [cursor=pointer]', '      - img', '    - button [ref=send-b] [cursor=pointer]', '      - img');
  if (!text) controls.push('    - button "Start dictation" [ref=dictation] [cursor=pointer]');
  return `Page Title: ChatGPT\nURL: ${href}\nSnapshot:\n- <changed> textbox "Message ChatGPT" [active] [ref=composer]:\n${composerContentSnapshot(text, '  ')}\n${controls.join('\n')}`;
}

function submittedDelta(prompt) {
  const snapshotPrompt = flattenProviderUserSnapshot
    ? String(prompt || '').split('\n').map(line => line.trim()).filter(Boolean).join(' ')
    : prompt;
  return `Page Title: ChatGPT\nURL: ${href}\nSnapshot:\n- <changed> generic [ref=turn${sentCount}]:\n  - heading "You said:" [level=4] [ref=user${sentCount}]\n  - generic [ref=usertext${sentCount}]: ${JSON.stringify(snapshotPrompt)}\n  - group "Your message actions"\n- <changed> textbox "Message ChatGPT" [active] [ref=composer]:\n  - paragraph: "Message ChatGPT"\n- <changed> button "Stop generating" [ref=stop]`;
}

function assistantDelta(text, index = 0) {
  return `Page Title: ChatGPT\nURL: ${href}\nSnapshot:\n- <changed> heading "ChatGPT said:" [level=4] [ref=assistant${index}]\n  - <changed> paragraph [ref=a${index}]: ${JSON.stringify(text)}\n  - group "Response actions"`;
}

function fixedComposerDomObservation(page, logicalText, {
  liveShape = false,
  semanticPreExact = false,
  semanticPreObservedAscii = false,
  semanticPreObservedNbsp = false,
} = {}) {
  const textNode = data => ({ nodeType: 3, data, nodeValue: data });
  const elementNode = (tagName, childNodes = []) => ({
    nodeType: 1,
    tagName,
    childNodes,
    textContent: childNodes.map(child => child?.nodeType === 3 ? String(child.data || '') : String(child?.textContent || '')).join(''),
  });
  let lines = String(logicalText || '').split('\n');
  const lineTags = lines.map(() => 'P');
  if (liveShape) lines = lines.map(line => line.startsWith('  "') ? `\u00a0 ${line.slice(2)}` : line);
  if (semanticPreExact) lineTags[0] = 'PRE';
  if (semanticPreObservedAscii) {
    lineTags[0] = 'PRE';
    if (lines[0].startsWith('\u00a0 ')) lines[0] = `  ${lines[0].slice(2)}`;
  }
  if (semanticPreObservedNbsp) {
    lineTags[0] = 'PRE';
    if (lines[0].startsWith('  ')) lines[0] = `\u00a0 ${lines[0].slice(2)}`;
  }
  const composer = {
    ...elementNode('DIV', lines.map((line, index) => elementNode(lineTags[index], line === '' ? [elementNode('BR')] : [textNode(line)]))),
    id: 'prompt-textarea',
    isContentEditable: true,
    offsetWidth: 640,
    offsetHeight: 120,
    getClientRects: () => [{}],
  };
  const url = new URL(page.url);
  return executeInternalOperation({
    operationId: 'chatgptObserveComposer',
    input: { expectedHref: page.url },
    window: {},
    document: { querySelectorAll: selector => selector === '#prompt-textarea' || selector === '[contenteditable="true"][role="textbox"]' ? [composer] : [] },
    location: { href: url.href, origin: url.origin, hostname: url.hostname, pathname: url.pathname },
    sessionStorage: { getItem: () => null, setItem: () => { throw new Error('fixed composer observation must be read-only'); }, removeItem: () => { throw new Error('fixed composer observation must be read-only'); } },
  });
}

function fixedAppMentionComposerObservation(page, { malformed = false, visibleTextMismatch = false } = {}) {
  const name = 'nimora-phase-11-mcp-r28-target-live';
  const displayName = 'Nimora Phase 11 MCP R28 Target Live';
  const attrs = {
    contenteditable: 'false',
    'app-mention-name': name,
    'app-mention-display-name': displayName,
    'app-mention-path': 'app://asdk_app_6abc1aebe3d481918c95d6ee4736fc0e',
    'data-prompt-link-href': malformed
      ? 'app://asdk_app_wrong'
      : 'app://asdk_app_6abc1aebe3d481918c95d6ee4736fc0e',
    'data-prompt-link-label': `$${name}`,
  };
  const mention = {
    nodeType: 1,
    tagName: 'SPAN',
    childNodes: [],
    textContent: visibleTextMismatch ? `${displayName} altered` : displayName,
    getAttribute: name => attrs[name] ?? null,
    hasAttribute: () => false,
  };
  const literalPaste = {
    nodeType: 1,
    tagName: 'SPAN',
    childNodes: [{ nodeType: 3, data: ' ', nodeValue: ' ' }],
    textContent: ' ',
    getAttribute: name => name === 'data-prompt-literal-paste' ? '' : null,
    hasAttribute: name => name === 'data-prompt-literal-paste',
  };
  const paragraph = {
    nodeType: 1,
    tagName: 'P',
    childNodes: [mention, literalPaste],
    textContent: mention.textContent + ' ',
    getAttribute: () => null,
    hasAttribute: () => false,
  };
  const composer = {
    nodeType: 1,
    tagName: 'DIV',
    childNodes: [paragraph],
    textContent: mention.textContent + ' ',
    id: 'prompt-textarea',
    isContentEditable: true,
    offsetWidth: 640,
    offsetHeight: 120,
    getClientRects: () => [{}],
    getAttribute: () => null,
    hasAttribute: () => false,
  };
  const url = new URL(page.url);
  return executeInternalOperation({
    operationId: 'chatgptObserveComposer',
    input: { expectedHref: page.url },
    window: {},
    document: { querySelectorAll: selector => selector === '#prompt-textarea' || selector === '[contenteditable="true"][role="textbox"]' ? [composer] : [] },
    location: { href: url.href, origin: url.origin, hostname: url.hostname, pathname: url.pathname },
    sessionStorage: { getItem: () => null, setItem: () => { throw new Error('fixed composer observation must be read-only'); }, removeItem: () => { throw new Error('fixed composer observation must be read-only'); } },
  });
}

const appMentionProbe = fixedAppMentionComposerObservation({ url: 'https://chatgpt.com/' });
assert.equal(appMentionProbe.composerAmbiguous, false, 'self-consistent app mention with distinct slug/display name must be accepted as a decoration');
assert.equal(appMentionProbe.composerText, '', 'current app mention must not become human composer text');
assert.deepEqual(appMentionProbe.composerDecorations, [{
  kind: 'app-mention',
  tagName: 'SPAN',
  name: 'nimora-phase-11-mcp-r28-target-live',
  path: 'app://asdk_app_6abc1aebe3d481918c95d6ee4736fc0e',
  href: 'app://asdk_app_6abc1aebe3d481918c95d6ee4736fc0e',
  label: '$nimora-phase-11-mcp-r28-target-live',
}], 'current app mention identity must be preserved exactly');
const malformedAppMentionProbe = fixedAppMentionComposerObservation({ url: 'https://chatgpt.com/' }, { malformed: true });
assert.equal(malformedAppMentionProbe.composerAmbiguous, true, 'inconsistent app mention identity must remain fail-closed');
const mismatchedVisibleAppMentionProbe = fixedAppMentionComposerObservation({ url: 'https://chatgpt.com/' }, { visibleTextMismatch: true });
assert.equal(mismatchedVisibleAppMentionProbe.composerAmbiguous, true, 'app mention visible text that disagrees with displayName must remain fail-closed');

async function invokeBrowserTool(name, input) {
  browserCalls.push({ name, input: structuredClone(input ?? {}) });
  if (name === 'list_browser_pages') return { text: listText() };
  if (name === 'activate_browser_page') {
    activationCount += 1;
    if (activationMode === 'fail') throw new Error('synthetic exact-page activation failed');
    pageVisible = true;
    return { text: `Exact shared browser page activated: ${PAGE_ID}` };
  }
  if (name === 'type_in_page') {
    if (typeof input?.text === 'string') {
      if (!input?.ref && composerPluginMentionName && input.text.includes('\n') && input?.literalText !== true) {
        unsafeDecoratedMultilineKeyEvents += input.text.split('\n').length - 1;
        throw new Error('synthetic decorated multiline keyboard typing would emit Enter semantics');
      }
      pendingPrompt = input.text;
      if (input?.ref && composerPluginMentionName && input?.literalText !== true) composerPluginMentionName = '';
    }
    if (input?.key === 'Enter') throw new Error('Production ChatGPT submit must not press Enter');
    return { text: composerDelta(pendingPrompt) };
  }
  if (name === 'click_element') {
    if (input?.ref === 'composer') {
      return { text: composerDelta(pendingPrompt) };
    }
    if (input?.ref === 'stop') {
      interrupted = true;
      streaming = false;
      return { text: composerDelta('') };
    }
    if (!['send', 'send-a', 'send-b'].includes(input?.ref)) {
      throw new Error('Non-submit toolbar control must not be clicked: ' + String(input?.ref || ''));
    }
    sentCount += 1;
    const admittedPrompt = pendingPrompt;
    if (submitMode === 'noop-retain') {
      streaming = false;
      return { text: composerDelta(pendingPrompt) };
    }
    if (submitMode === 'clear-no-admission') {
      pendingPrompt = '';
      streaming = false;
      return { text: composerDelta('') };
    }
    if (submitMode === 'error-no-admission') {
      throw new Error('synthetic click UNKNOWN before visible admission');
    }
    if (submitMode === 'navigation-no-admission') {
      pendingPrompt = '';
      streaming = true;
      href = 'https://chatgpt.com/?first-send-navigation=unstable';
      return { text: readText() };
    }
    if (submitMode === 'page-id-drift') {
      pendingPrompt = '';
      streaming = true;
      listedPageId = '22222222-2222-4222-8222-222222222222';
      return { text: readText() };
    }
    if (submitMode === 'origin-drift') {
      pendingPrompt = '';
      streaming = true;
      href = 'https://chat.openai.com/first-send-navigation';
      return { text: readText() };
    }
    if (submitMode === 'delayed-first-conversation-admission') {
      pendingPrompt = '';
      streaming = true;
      delayedFirstConversationPrompt = admittedPrompt;
      delayedFirstConversationStage = 2;
      href = 'https://chatgpt.com/?first-send-navigation=creating';
      return { text: readText() };
    }
    if (submitMode === 'unexpected-text') {
      userTexts.push('UNEXPECTED_PROVIDER_TEXT');
      pendingPrompt = '';
      streaming = true;
      return { text: submittedDelta(userTexts[userTexts.length - 1]) };
    }
    if (submitMode === 'multiple-users') {
      userTexts.push(admittedPrompt, 'SECOND_PROVIDER_USER');
      pendingPrompt = '';
      streaming = true;
      return { text: readText() };
    }
    userTexts.push(admittedPrompt);
    pendingPrompt = '';
    streaming = true;
    if (sentCount === 1) {
      href = 'https://chatgpt.com/c/conversation-A';
      transientPreConversationObservations = 1;
    }
    unchangedReads = 1;
    const result = { text: submittedDelta(userTexts[userTexts.length - 1]) };
    if (submitMode === 'error-after-admit') {
      throw new Error('synthetic click UNKNOWN after provider accepted exact prompt');
    }
    return result;
  }
  if (name === 'read_page') {
    if (forcedReadPageTexts.length > 0) {
      return { text: forcedReadPageTexts.shift() };
    }
    if (delayedFirstConversationPrompt) {
      if (delayedFirstConversationStage === 2) {
        delayedFirstConversationStage = 1;
        return { text: readText('https://chatgpt.com/') };
      }
      if (delayedFirstConversationStage === 1) {
        delayedFirstConversationStage = 0;
        return { text: readText() };
      }
      const admitted = delayedFirstConversationPrompt;
      delayedFirstConversationPrompt = '';
      href = 'https://chatgpt.com/c/conversation-A';
      userTexts.push(admitted);
      return { text: readText() };
    }
    if (unchangedReads > 0 && !streaming) {
      unchangedReads -= 1;
      return { text: `Page Title: ChatGPT\nURL: ${href}\nSnapshot: <unchanged>` };
    }
    const observationHref = transientPreConversationObservations > 0
      ? (transientPreConversationObservations--, 'https://chatgpt.com/')
      : href;
    return { text: readText(observationHref) };
  }
  throw new Error(`Unexpected browser tool: ${name}`);
}

const controller = createChatGptWorkerController({
  invokeBrowserTool,
  ensureExactPageVisible: async ({ pageId, expectedUrl, expectedOrigin }) => {
    assert.equal(pageId, PAGE_ID);
    assert.equal(expectedUrl, href);
    assert.equal(expectedOrigin, new URL(href).origin);
    if (!pageVisible) await invokeBrowserTool('activate_browser_page', { pageId });
    if (!pageVisible) throw new Error('synthetic exact-page activation did not make page visible');
    return { pageId: PAGE_ID, title: 'ChatGPT', url: href, visible: true };
  },
  observeExactComposer: async page => {
    if ((liveShapeComposerRepresentation || semanticPreExactRepresentation || semanticPreObservedAsciiMismatch || semanticPreObservedNbspMismatch) && pendingPrompt) {
      return await fixedComposerDomObservation(page, pendingPrompt, {
        liveShape: liveShapeComposerRepresentation,
        semanticPreExact: semanticPreExactRepresentation,
        semanticPreObservedAscii: semanticPreObservedAsciiMismatch,
        semanticPreObservedNbsp: semanticPreObservedNbspMismatch,
      });
    }
    const decorations = pluginMentionObservationDecoration();
    let observedComposerText = exactComposerMismatch && pendingPrompt
      ? pendingPrompt.slice(0, -1) + (pendingPrompt.endsWith('X') ? 'Y' : 'X')
      : pendingPrompt;
    if (composerNbspIndentation) observedComposerText = observedComposerText.replace(/^  /gm, '\u00a0 ');
    if (pendingPrompt && decorations.length === 1 && composerLeadingDecorationSeparator) {
      observedComposerText = ` ${observedComposerText}`;
    }
    if (pendingPrompt && composerTrailingEmptyParagraphs > 0) {
      observedComposerText += '\n'.repeat(composerTrailingEmptyParagraphs);
    }
    const composerLineTags = observedComposerText.split('\n').map(() => 'P');
    if (pendingPrompt && composerTrailingEmptyParagraphs > 0) {
      for (let index = composerLineTags.length - composerTrailingEmptyParagraphs; index < composerLineTags.length; index += 1) {
        composerLineTags[index] = composerTrailingEmptyParagraphTag;
      }
    }
    return {
      href: page.url,
      origin: new URL(page.url).origin,
      composerFound,
      composerAmbiguous: ambiguousComposer,
      composerText: observedComposerText,
      composerLineTags,
      composerDecorations: ambiguousComposer ? [] : decorations,
      composerDecorationFingerprint: ambiguousComposer ? '' : JSON.stringify(decorations),
      rawComposerText: `${observedComposerText}${decorations.length ? 'PROVIDER_PLUGIN_DECORATION' : ''}`,
    };
  },
  observeExactProviderUsers: async page => {
    const baseTurns = userTexts.map((logicalText, index) => {
      let observedText = logicalText;
      if (liveShapeProviderUserRepresentation) {
        observedText = observedText.split('\n').map(line => line.startsWith('  "') ? `\u00a0 ${line.slice(2)}` : line).join('\n');
      }
      if (typeof providerUserDomTransform === 'function') {
        observedText = String(providerUserDomTransform(observedText, index, userTexts.length));
      }
      return {
        identity: `conversation-turn-${index}`,
        text: observedText,
        lineTags: observedText.split('\n').map(() => 'USER_TEXT'),
        identitySource: 'data-turn-key',
        identityStable: true,
        presentationKind: 'provider-user-turn',
        virtualized: false,
      };
    });
    const extras = exactProviderUserExtras.map((entry, index) => {
      const text = String(entry?.text || '');
      return {
        identity: String(entry?.identity || `synthetic-extra-${index}`),
        text,
        lineTags: Array.isArray(entry?.lineTags) ? entry.lineTags : text.split('\n').map(() => 'USER_TEXT'),
        identitySource: String(entry?.identitySource || 'data-turn-key'),
        identityStable: entry?.identityStable !== false,
        presentationKind: String(entry?.presentationKind || 'work-context-turn'),
        virtualized: entry?.virtualized === true,
      };
    });
    const combined = [...baseTurns, ...extras];
    const turns = typeof exactProviderUserProjection === 'function'
      ? exactProviderUserProjection(combined.map(entry => ({ ...entry })))
      : combined;
    return {
      href: page.url,
      origin: new URL(page.url).origin,
      userTurns: turns,
      providerUserRepresentationVersion,
      providerUsersAmbiguous: false,
    };
  },
  getSiteAdapterSource: () => '(function fakeSite(){ return {}; })',
  resultText: result => String(result?.text || ''),
  structuredValue: result => result?.value,
  now: (() => {
    let tick = 0;
    return () => 1_000 + (++tick * 2_000);
  })(),
});
const enterCount = () => browserCalls.filter(call => call.name === 'type_in_page' && call.input?.key === 'Enter').length;
const submitClickCount = () => browserCalls.filter(call => call.name === 'click_element' && ['send', 'send-a', 'send-b'].includes(call.input?.ref)).length;
const nonSubmitToolbarClickCount = () => browserCalls.filter(call => call.name === 'click_element' && ['attach', 'model', 'dictation'].includes(call.input?.ref)).length;

const resourcesBefore = await controller.listResources();
assert.equal(resourcesBefore.length, 1);
assert.equal(resourcesBefore[0].pageId, PAGE_ID);
assert.equal(resourcesBefore[0].href, 'https://chatgpt.com/');
assert.equal(resourcesBefore[0].ready, true);
assert.equal(resourcesBefore[0].composerText, '', 'placeholder-only initial composer must be logically empty');
assert.equal(resourcesBefore[0].composerAmbiguous, false);
assert.equal(sentCount, 0, 'candidate discovery must not mutate the provider conversation');

const target = {
  pageId: resourcesBefore[0].pageId,
  resourceIdentity: resourcesBefore[0].resourceIdentity,
  lifecycleIdentity: resourcesBefore[0].lifecycleIdentity,
  origin: resourcesBefore[0].origin,
  href: resourcesBefore[0].href,
};
const session = await controller.connect({ target });
assert.equal(session.pageId, PAGE_ID);
assert.equal(controller.sessionCount(), 1);

for (const staleVersion of [undefined, 1]) {
  providerUserRepresentationVersion = staleVersion;
  const mutationsBefore = browserCalls.filter(call => ['type_in_page', 'click_element'].includes(call.name)).length;
  await assert.rejects(
    () => controller.control({
      action: 'send', pageId: PAGE_ID, sessionId: session.sessionId,
      input: { inputId: `stale-reader-${staleVersion}`, prompt: 'Do not send through a stale fixed reader' },
    }),
    /fixed provider-user reader is stale; reload the workbench/,
  );
  assert.equal(browserCalls.filter(call => ['type_in_page', 'click_element'].includes(call.name)).length, mutationsBefore,
    'a stale renderer reader must reject before composer typing or provider click');
  assert.equal(sentCount, 0, 'stale-reader rejection must not submit');
}
providerUserRepresentationVersion = 2;

assert.deepEqual(await controller.listResources(), [], 'an actively-owned ChatGPT tab must not remain assignable');
assert.equal(await controller.probeResource(PAGE_ID), undefined, 'probe must hide an actively-owned ChatGPT tab');
await assert.rejects(
  () => controller.connect({ target }),
  /already owned by another WorkerSession/,
);

pageVisible = false;
activationMode = 'fail';
const activationFailureTypeBefore = browserCalls.filter(call => call.name === 'type_in_page').length;
const activationFailureClickBefore = submitClickCount();
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-hidden-activation-failure', prompt: 'Must fail before provider mutation' },
  }),
  /activation failed/,
);
assert.equal(browserCalls.filter(call => call.name === 'type_in_page').length, activationFailureTypeBefore, 'activation failure must prevent composer mutation');
assert.equal(submitClickCount(), activationFailureClickBefore, 'activation failure must prevent provider submit gesture');
activationMode = 'success';
pageVisible = true;

composerPluginMentionName = 'dev-r21-plugin';
pendingPrompt = 'HUMAN_DRAFT';
const pluginDraftTypeBefore = browserCalls.filter(call => call.name === 'type_in_page').length;
const pluginDraftSubmitBefore = submitClickCount();
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-plugin-mention-human-draft', prompt: 'Must not overwrite the human draft' },
  }),
  /composer contains user text/,
);
assert.equal(browserCalls.filter(call => call.name === 'type_in_page').length, pluginDraftTypeBefore, 'plugin mention must not weaken the real user-draft overwrite guard');
assert.equal(submitClickCount(), pluginDraftSubmitBefore, 'plugin mention plus human draft must fail before submit');
assert.equal(composerPluginMentionName, 'dev-r21-plugin');
pendingPrompt = '';

const pluginPreservePrompt = 'Preserve the provider plugin mention\nwhile entering this multiline prompt\nwithout Enter semantics';
const pluginPreserveCallStart = browserCalls.length;
const pluginPreserveSubmitBefore = submitClickCount();
const pluginPreserveSentBefore = sentCount;
const unsafeDecoratedMultilineKeyEventsBefore = unsafeDecoratedMultilineKeyEvents;
composerTrailingEmptyParagraphs = 1;
composerTrailingEmptyParagraphTag = 'P';
submitMode = 'noop-retain';
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-plugin-mention-preserve', prompt: pluginPreservePrompt },
  }),
  /submission was not confirmed; worker will not issue a second submit gesture/,
);
const pluginPreserveCalls = browserCalls.slice(pluginPreserveCallStart);
const pluginFocusCall = pluginPreserveCalls.find(call => call.name === 'click_element' && call.input?.ref === 'composer');
const pluginTypeCall = pluginPreserveCalls.find(call => call.name === 'type_in_page' && call.input?.text === pluginPreservePrompt);
assert.ok(pluginTypeCall, 'plugin-preserving input must issue one prompt insertion operation');
assert.equal(pluginFocusCall, undefined, 'plugin-preserving input must not click the decorated composer because the provider plugin mention can activate navigation');
assert.equal(pluginTypeCall.input?.ref, 'composer', 'plugin-preserving input must target the exact composer while using the non-click literal focus path');
assert.equal(pluginTypeCall.input?.literalText, true, 'decorated multiline Work prompt must request literal text insertion instead of keyboard typing');
assert.equal(unsafeDecoratedMultilineKeyEvents, unsafeDecoratedMultilineKeyEventsBefore, 'decorated multiline Work prompt fill must emit zero Enter-like key events');
assert.equal(composerPluginMentionName, 'dev-r21-plugin', 'literal text insertion must preserve the provider plugin mention identity');
assert.equal(submitClickCount(), pluginPreserveSubmitBefore + 1, 'stable plugin mention path may reach exactly one submit-control click');
submitMode = 'success';
pendingPrompt = '';
sentCount = pluginPreserveSentBefore;
composerTrailingEmptyParagraphs = 0;

const leadingDecorationSeparatorPrompt = 'Reconcile exactly one provider app-mention separator space';
const leadingDecorationSeparatorSubmitBefore = submitClickCount();
const leadingDecorationSeparatorSentBefore = sentCount;
composerLeadingDecorationSeparator = true;
submitMode = 'noop-retain';
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-plugin-leading-decoration-separator', prompt: leadingDecorationSeparatorPrompt },
  }),
  /submission was not confirmed; worker will not issue a second submit gesture/,
);
assert.equal(submitClickCount(), leadingDecorationSeparatorSubmitBefore + 1, 'one exact app-mention separator space must reconcile and reach exactly one submit-control click');
assert.equal(composerPluginMentionName, 'dev-r21-plugin', 'app-mention separator reconciliation must preserve the provider app identity');
composerLeadingDecorationSeparator = false;
submitMode = 'success';
pendingPrompt = '';
sentCount = leadingDecorationSeparatorSentBefore;

// Each browser representation is already supported individually. Their composition
// must preserve the same exact prompt, with no extra submit or semantic normalization.
for (const shape of [
  { leading: true, trailing: 0 },
  { leading: false, trailing: 1 },
  { leading: true, trailing: 1 },
]) {
  for (const mismatch of [false, true]) {
    const clicksBefore = submitClickCount();
    const sentBefore = sentCount;
    composerLeadingDecorationSeparator = shape.leading;
    composerTrailingEmptyParagraphs = shape.trailing;
    composerNbspIndentation = true;
    exactComposerMismatch = mismatch;
    submitMode = 'noop-retain';
    await assert.rejects(
      () => controller.control({
        action: 'send', pageId: PAGE_ID, sessionId: session.sessionId,
        input: { inputId: `combined-representation-${shape.leading}-${shape.trailing}-${mismatch}`, prompt: REAL_SHAPE_PROMPT },
      }),
      mismatch ? /composer did not stably contain/ : /submission was not confirmed; worker will not issue a second submit gesture/,
    );
    assert.equal(submitClickCount(), clicksBefore + (mismatch ? 0 : 1), 'combined representations must pass only for the exact whole prompt');
    assert.equal(composerPluginMentionName, 'dev-r21-plugin');
    pendingPrompt = '';
    sentCount = sentBefore;
  }
}
composerLeadingDecorationSeparator = false;
composerTrailingEmptyParagraphs = 0;
composerNbspIndentation = false;
exactComposerMismatch = false;
submitMode = 'success';

const intentionalTrailingLfPrompt = 'Preserve an intentional user-authored trailing LF\n';
const intentionalTrailingLfSubmitBefore = submitClickCount();
const intentionalTrailingLfSentBefore = sentCount;
composerTrailingEmptyParagraphs = 1;
composerTrailingEmptyParagraphTag = 'P';
submitMode = 'noop-retain';
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-plugin-trailing-lf-preserve', prompt: intentionalTrailingLfPrompt },
  }),
  /submission was not confirmed; worker will not issue a second submit gesture/,
);
assert.equal(submitClickCount(), intentionalTrailingLfSubmitBefore + 1, 'one structural trailing empty P must reconcile even when the admitted prompt already ends in LF');
submitMode = 'success';
pendingPrompt = '';
sentCount = intentionalTrailingLfSentBefore;
composerTrailingEmptyParagraphs = 0;

const doubleTrailingSubmitBefore = submitClickCount();
composerTrailingEmptyParagraphs = 2;
composerTrailingEmptyParagraphTag = 'P';
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-plugin-double-trailing-empty', prompt: 'Two structural trailing empty paragraphs must fail closed' },
  }),
  /composer did not stably contain the admitted Worker prompt after fill/,
);
assert.equal(submitClickCount(), doubleTrailingSubmitBefore, 'two extra trailing LFs must fail before submit');
pendingPrompt = '';
composerTrailingEmptyParagraphs = 0;

const nonPSubmitBefore = submitClickCount();
composerTrailingEmptyParagraphs = 1;
composerTrailingEmptyParagraphTag = 'PRE';
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-plugin-non-p-trailing-empty', prompt: 'Non-P trailing structural content must fail closed' },
  }),
  /composer did not stably contain the admitted Worker prompt after fill/,
);
assert.equal(submitClickCount(), nonPSubmitBefore, 'non-P extra trailing line must fail before submit');
pendingPrompt = '';
composerTrailingEmptyParagraphs = 0;
composerTrailingEmptyParagraphTag = 'P';

composerPluginMentionDriftOnPrompt = true;
const pluginDriftSubmitBefore = submitClickCount();
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-plugin-mention-drift', prompt: 'Decoration drift must fail closed' },
  }),
  /composer decoration identity changed during prompt entry/,
);
assert.equal(submitClickCount(), pluginDriftSubmitBefore, 'plugin mention identity drift must fail before submit');
composerPluginMentionDriftOnPrompt = false;
composerPluginMentionName = '';
pendingPrompt = '';

const mismatchClickBefore = submitClickCount();
exactComposerMismatch = true;
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-exact-mismatch', prompt: 'Exact mismatch must fail X' },
  }),
  /composer did not stably contain the admitted Worker prompt after fill/,
);
assert.equal(submitClickCount(), mismatchClickBefore, 'one real character mismatch must fail before submit');
exactComposerMismatch = false;
pendingPrompt = '';

const semanticNbspClickBefore = submitClickCount();
semanticPreObservedNbspMismatch = true;
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-observed-semantic-nbsp-mismatch', prompt: '  semantic-pre' },
  }),
  /composer did not stably contain the admitted Worker prompt after fill/,
);
assert.equal(submitClickCount(), semanticNbspClickBefore, 'PRE semantic NBSP versus unrelated expected ASCII spaces must fail before submit');
semanticPreObservedNbspMismatch = false;
pendingPrompt = '';

const semanticExpectedNbspClickBefore = submitClickCount();
semanticPreObservedAsciiMismatch = true;
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-expected-semantic-nbsp-mismatch', prompt: '\u00a0 semantic-pre' },
  }),
  /composer did not stably contain the admitted Worker prompt after fill/,
);
assert.equal(submitClickCount(), semanticExpectedNbspClickBefore, 'expected literal NBSP versus observed PRE ASCII spaces must fail before submit');
semanticPreObservedAsciiMismatch = false;
pendingPrompt = '';

const semanticPreExactClickBefore = submitClickCount();
const semanticPreExactSentBefore = sentCount;
submitMode = 'noop-retain';
semanticPreExactRepresentation = true;
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-semantic-pre-exact', prompt: '\u00a0 semantic-pre' },
  }),
  /submission was not confirmed; worker will not issue a second submit gesture/,
);
assert.equal(submitClickCount(), semanticPreExactClickBefore + 1, 'exact semantic PRE NBSP content must pass the strict composer guard without conversion');
semanticPreExactRepresentation = false;
submitMode = 'success';
pendingPrompt = '';
sentCount = semanticPreExactSentBefore;

ambiguousComposer = true;
const ambiguousSubmitBefore = submitClickCount();
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-ambiguous', prompt: 'Must not overwrite ambiguous content' },
  }),
  /composer observation is ambiguous/,
);
assert.equal(submitClickCount(), ambiguousSubmitBefore, 'ambiguous composer observation must fail before provider submit');
ambiguousComposer = false;

submitMode = 'navigation-no-admission';
const navigationOnlyClickBefore = submitClickCount();
const navigationOnlyEnterBefore = enterCount();
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-navigation-only-no-admission', prompt: 'Navigation alone is not provider admission' },
  }),
  /submission was not confirmed; worker will not issue a second submit gesture/,
);
assert.equal(submitClickCount(), navigationOnlyClickBefore + 1, 'navigation-only first-send transition must use exactly one submit gesture');
assert.equal(enterCount(), navigationOnlyEnterBefore, 'navigation-only first-send transition must not fall back to Enter');
await assert.rejects(
  () => controller.control({
    action: 'poll',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    inputId: 'turn-navigation-only-no-admission',
  }),
  /Unknown ChatGPT worker turn/,
  'navigation-only transition without provider admission must not establish activeTurn authority',
);
href = 'https://chatgpt.com/';
streaming = false;
pendingPrompt = '';
submitMode = 'success';

submitMode = 'page-id-drift';
const pageDriftClickBefore = submitClickCount();
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-first-send-page-id-drift', prompt: 'Exact page generation must remain owned' },
  }),
  /exact page origin\/generation changed/,
);
assert.equal(submitClickCount(), pageDriftClickBefore + 1, 'page-id drift must not trigger a second submit gesture');
listedPageId = PAGE_ID;
href = 'https://chatgpt.com/';
streaming = false;
pendingPrompt = '';
submitMode = 'success';

submitMode = 'origin-drift';
const originDriftClickBefore = submitClickCount();
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-first-send-origin-drift', prompt: 'Exact origin must remain owned' },
  }),
  /exact page origin\/generation changed/,
);
assert.equal(submitClickCount(), originDriftClickBefore + 1, 'origin drift must not trigger a second submit gesture');
href = 'https://chatgpt.com/';
streaming = false;
pendingPrompt = '';
submitMode = 'success';

const multilineClickBefore = submitClickCount();
const multilineEnterBefore = enterCount();
const toolbarClickBefore = nonSubmitToolbarClickCount();
const hiddenActivationBefore = activationCount;
pageVisible = false;
submitControlMode = 'current-zh';
liveShapeComposerRepresentation = true;
liveShapeProviderUserRepresentation = true;
flattenProviderUserSnapshot = true;
submitMode = 'delayed-first-conversation-admission';
const first = await controller.control({
  action: 'send',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
  input: { inputId: 'turn-1', prompt: REAL_SHAPE_PROMPT },
});
submitMode = 'success';
liveShapeComposerRepresentation = false;
assert.equal(first.state, 'running');
assert.equal(activationCount, hiddenActivationBefore + 1, 'hidden ChatGPT page must activate exactly once before fill/click');
assert.equal(pageVisible, true, 'hidden ChatGPT page must be freshly visible before mutation');
const hiddenActivationIndex = browserCalls.findIndex((call, index) => index >= 0 && call.name === 'activate_browser_page' && call.input?.pageId === PAGE_ID);
const firstMutationIndex = browserCalls.findIndex(call => call.name === 'type_in_page' && call.input?.text === REAL_SHAPE_PROMPT);
assert.ok(hiddenActivationIndex >= 0 && firstMutationIndex > hiddenActivationIndex, 'exact-page activation must precede the first ChatGPT composer mutation');
assert.equal(submitClickCount(), multilineClickBefore + 1, 'live NBSP-preservation shape must reconstruct to exact logical text and lead to exactly one submit-control click');
assert.equal(enterCount(), multilineEnterBefore, 'production ChatGPT submit must not press Enter');
assert.equal(nonSubmitToolbarClickCount(), toolbarClickBefore, 'model/attachment/dictation controls must never be clicked as submit');
assert.equal(userTexts[userTexts.length - 1], REAL_SHAPE_PROMPT, 'provider user-message admission must preserve the exact full real-shape prompt');
assert.equal(href, 'https://chatgpt.com/c/conversation-A', 'first admitted send may create provider conversation lineage');

exactProviderUserExtras = [{
  identity: 'work-context-r22-live',
  text: 'OPAQUE_R22_WORK_CONTEXT',
  identitySource: 'data-turn-key',
  identityStable: true,
  presentationKind: 'work-context-turn',
  virtualized: false,
}];
accessibilitySyntheticUsers = ['OPAQUE_R22_WORK_CONTEXT'];
const r22ContextHealth = await controller.control({
  action: 'health',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
});
assert.equal(r22ContextHealth.observation.providerUserObservation, 'fixed-read-only-work-context-window');
assert.deepEqual(
  r22ContextHealth.observation.userTexts,
  [REAL_SHAPE_PROMPT],
  'structurally admitted Work context must not become a provider-user turn',
);

exactProviderUserProjection = turns => turns
  .filter(turn => turn.presentationKind === 'work-context-turn')
  .map(turn => ({ ...turn, virtualized: true }));
const r22VirtualizedHealth = await controller.control({
  action: 'health',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
});
assert.deepEqual(
  r22VirtualizedHealth.observation.userTexts,
  [REAL_SHAPE_PROMPT],
  'virtualized exact-window shrink must not erase previously admitted provider-user history',
);

exactProviderUserProjection = null;
exactProviderUserExtras = [{
  identity: 'unknown-r22-exact',
  text: 'OPAQUE_R22_UNKNOWN_EXACT',
  identitySource: 'data-turn-key',
  identityStable: true,
  presentationKind: 'unknown-user-turn',
  virtualized: false,
}];
accessibilitySyntheticUsers = ['OPAQUE_R22_UNKNOWN_EXACT'];
await assert.rejects(
  () => controller.control({ action: 'health', pageId: PAGE_ID, sessionId: session.sessionId }),
  /untrusted exact user-shaped occurrence at the context-learning boundary|untrusted structurally unknown occurrence/,
  'unknown stable user-shaped exact provenance must fail closed',
);

exactProviderUserExtras = [{
  identity: 'unstable-r22-context',
  text: 'OPAQUE_R22_UNSTABLE_CONTEXT',
  identitySource: 'none',
  identityStable: false,
  presentationKind: 'work-context-turn',
  virtualized: false,
}];
accessibilitySyntheticUsers = ['OPAQUE_R22_UNSTABLE_CONTEXT'];
await assert.rejects(
  () => controller.control({ action: 'health', pageId: PAGE_ID, sessionId: session.sessionId }),
  /untrusted exact user-shaped occurrence at the context-learning boundary/,
  'unstable Work-context identity must fail closed instead of recycling an ordinal identity',
);

exactProviderUserExtras = [];
accessibilitySyntheticUsers = ['OPAQUE_R22_ACCESSIBILITY_ONLY_UNKNOWN'];
await assert.rejects(
  () => controller.control({ action: 'health', pageId: PAGE_ID, sessionId: session.sessionId }),
  /untrusted user-shaped occurrence outside the admitted provider-user ledger/,
  'accessibility-only user-shaped occurrence without exact authority must fail closed',
);

accessibilitySyntheticUsers = [];
exactProviderUserProjection = null;
const r22RestoredHealth = await controller.control({
  action: 'health',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
});
assert.deepEqual(r22RestoredHealth.observation.userTexts, [REAL_SHAPE_PROMPT], 'R22 negative probes must restore the admitted provider ledger without contamination');

assistantTexts = ['CHATGPT_RESULT_A'];
streaming = false;
responseComplete = false;
let prelude = await controller.control({
  action: 'poll',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
  inputId: 'turn-1',
});
prelude = await controller.control({
  action: 'poll',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
  inputId: 'turn-1',
});
assert.equal(
  prelude.state,
  'running',
  'stable assistant prelude without the provider terminal marker must not complete the Worker turn while an app/tool phase may still be pending',
);
responseComplete = true;
let completed = await controller.control({
  action: 'poll',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
  inputId: 'turn-1',
});
for (let attempt = 0; attempt < 4 && completed.state === 'running'; attempt += 1) {
  completed = await controller.control({
    action: 'poll',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    inputId: 'turn-1',
  });
}
assert.equal(completed.state, 'completed');
assert.equal(completed.text, 'CHATGPT_RESULT_A');
assert.ok(completed.events.some(event => event.type === 'assistant_text'));
assert.ok(completed.events.some(event => event.type === 'completed'));
responseComplete = true;
liveShapeProviderUserRepresentation = false;
flattenProviderUserSnapshot = false;
submitControlMode = 'single';

const healthy = await controller.control({
  action: 'health',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
});
assert.equal(healthy.observation.conversationId, 'conversation-A');
assert.notEqual(healthy.observation.resourceIdentity, target.resourceIdentity, 'fresh observation identity must evolve when the provider conversation URL appears');
assert.equal(healthy.observation.lifecycleIdentity, target.lifecycleIdentity, 'provider lifecycle identity must remain stable across admitted first-turn conversation creation');
assert.equal(healthy.observation.snapshotKind, 'full', 'first admitted provider turn must remain coherent after a full snapshot');
assert.deepEqual(
  healthy.observation.messages.map(entry => entry.role),
  ['user', 'assistant'],
  'full first-turn snapshot must preserve chronological user/assistant ordering',
);
assert.equal(healthy.observation.userMessages[0].key, 'fixed-provider-user:conversation-turn-0');
assert.equal(healthy.observation.userMessages[0].text, REAL_SHAPE_PROMPT);
assert.equal(
  healthy.observation.messages.find(entry => entry.role === 'user')?.key,
  healthy.observation.userMessages[0].key,
  'fixed provider-user replacement must keep userMessages/messages on the same occurrence identity',
);
assert.equal(
  healthy.observation.messages.find(entry => entry.role === 'user')?.text,
  healthy.observation.userMessages[0].text,
  'fixed provider-user replacement must keep userMessages/messages on the same logical text',
);

forcedReadPageTexts.push(`Page Title: ChatGPT\nURL: ${href}\nSnapshot: <unchanged>`);
const unchangedHealth = await controller.control({
  action: 'health',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
});
assert.equal(unchangedHealth.observation.snapshotKind, 'unchanged');
assert.deepEqual(
  unchangedHealth.observation.messages.map(entry => [entry.role, entry.key, entry.text]),
  healthy.observation.messages.map(entry => [entry.role, entry.key, entry.text]),
  'unchanged snapshot must preserve the exact coherent chronological state',
);

assistantTexts[0] = 'CHATGPT_RESULT_A_DELTA';
forcedReadPageTexts.push(assistantDelta(assistantTexts[0], 0));
const assistantDeltaHealth = await controller.control({
  action: 'health',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
});
assert.equal(assistantDeltaHealth.observation.snapshotKind, 'delta');
assert.equal(assistantDeltaHealth.observation.assistantMessages.length, 1, 'assistant delta must update the existing occurrence in place');
assert.equal(assistantDeltaHealth.observation.assistantMessages[0].text, 'CHATGPT_RESULT_A_DELTA');
assert.deepEqual(
  assistantDeltaHealth.observation.messages.map(entry => entry.role),
  ['user', 'assistant'],
  'assistant delta must preserve chronological role ordering',
);

forcedReadPageTexts.push(assistantDelta(assistantTexts[0], 0));
const duplicateAssistantDeltaHealth = await controller.control({
  action: 'health',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
});
assert.equal(duplicateAssistantDeltaHealth.observation.messages.length, 2, 'duplicate delta role+key must not duplicate the occurrence');
assert.equal(duplicateAssistantDeltaHealth.observation.assistantMessages.length, 1);

pendingPrompt = '  Human draft must survive\n\nwith trailing spaces  ';
const humanTextSubmitBefore = submitClickCount();
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-human-text', prompt: 'Worker must not overwrite this' },
  }),
  /contains user text; worker refused to overwrite/,
);
assert.equal(pendingPrompt, '  Human draft must survive\n\nwith trailing spaces  ', 'human composer text with whitespace semantics must not be overwritten');
assert.equal(submitClickCount(), humanTextSubmitBefore, 'human-text refusal must happen before any submit gesture');
pendingPrompt = '';

const second = await controller.control({
  action: 'send',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
  input: { inputId: 'turn-2', prompt: 'Long bounded work order' },
});
assert.equal(second.state, 'running');
assert.equal(activationCount, hiddenActivationBefore + 1, 'already-visible ChatGPT page must not activate again');
const secondHealth = await controller.control({
  action: 'health',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
});
assert.equal(secondHealth.observation.userMessages.length, 2, 'second send in the same conversation must append exactly one fixed provider-user occurrence');
assert.deepEqual(
  secondHealth.observation.userTexts,
  [REAL_SHAPE_PROMPT, 'Long bounded work order'],
  'second send must preserve exact logical provider-user text history',
);
assert.deepEqual(
  secondHealth.observation.messages.map(entry => entry.role),
  ['user', 'assistant', 'user'],
  'second same-conversation send must preserve chronological role ordering',
);
streaming = true;
const cancelled = await controller.control({
  action: 'interrupt',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
  inputId: 'turn-2',
});
assert.equal(cancelled.interrupted, true);
assert.equal(cancelled.turn.state, 'cancelled');
assert.equal(interrupted, true);

const third = await controller.control({
  action: 'send',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
  input: { inputId: 'turn-3', prompt: 'Check lineage drift' },
});
assert.equal(third.state, 'running');
const thirdHealth = await controller.control({
  action: 'health',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
});
assert.equal(thirdHealth.observation.userMessages.length, 3, 'third/later send in the same conversation must append exactly one provider-user occurrence');
assert.deepEqual(
  thirdHealth.observation.userTexts,
  [REAL_SHAPE_PROMPT, 'Long bounded work order', 'Check lineage drift'],
);
href = 'https://chatgpt.com/c/conversation-B';
await assert.rejects(
  () => controller.control({
    action: 'poll',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    inputId: 'turn-3',
  }),
  /conversation lineage changed/,
);
href = 'https://chatgpt.com/c/conversation-A';
await controller.control({
  action: 'interrupt',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
  inputId: 'turn-3',
});

submitMode = 'noop-retain';
const retainedPrompt = 'Real R10 shape: prompt remains staged after ineffective Enter-style submission';
const retainedClickBefore = submitClickCount();
const retainedEnterBefore = enterCount();
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-retained-prompt-noop', prompt: retainedPrompt },
  }),
  /submission was not confirmed; worker will not issue a second submit gesture/,
);
assert.equal(submitClickCount(), retainedClickBefore + 1, 'real R10 retained-prompt failure must issue exactly one submit-control click');
assert.equal(enterCount(), retainedEnterBefore, 'real R10 retained-prompt failure must never fall back to Enter');
assert.equal(pendingPrompt, retainedPrompt, 'real R10 failure shape must retain the exact staged prompt after an ineffective submit click');
submitMode = 'success';
pendingPrompt = '';

submitControlMode = 'missing';
const missingClickBefore = submitClickCount();
const missingEnterBefore = enterCount();
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-missing-submit', prompt: 'Missing exact submit control must fail before gesture' },
  }),
  /exact submit control is unavailable/,
);
assert.equal(submitClickCount(), missingClickBefore, 'missing submit control must fail before click');
assert.equal(enterCount(), missingEnterBefore, 'missing submit control must fail before Enter');
pendingPrompt = '';
submitControlMode = 'ambiguous';
const ambiguousControlClickBefore = submitClickCount();
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-ambiguous-submit-control', prompt: 'Ambiguous submit controls must fail closed' },
  }),
  /submit control is ambiguous/,
);
assert.equal(submitClickCount(), ambiguousControlClickBefore, 'ambiguous submit controls must fail before click');
pendingPrompt = '';
submitControlMode = 'single';

submitMode = 'clear-no-admission';
const clearNoAdmissionClickBefore = submitClickCount();
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-clear-without-provider-user', prompt: 'Composer mutation alone is not provider admission' },
  }),
  /submission was not confirmed; worker will not issue a second submit gesture/,
);
assert.equal(submitClickCount(), clearNoAdmissionClickBefore + 1, 'composer-clear UNKNOWN must still use one gesture only');
submitMode = 'success';

submitMode = 'error-after-admit';
const errorAfterAdmissionClickBefore = submitClickCount();
const admittedAfterClickError = await controller.control({
  action: 'send',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
  input: { inputId: 'turn-click-error-after-admission', prompt: 'Provider admission survives click-tool UNKNOWN' },
});
assert.equal(admittedAfterClickError.state, 'running', 'read-only observation may admit the already-submitted exact provider turn after click error');
assert.equal(submitClickCount(), errorAfterAdmissionClickBefore + 1, 'click error after provider admission must not issue a second gesture');
assert.equal(enterCount(), 0, 'no repair path may use Enter as a fallback');
await controller.control({
  action: 'interrupt',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
  inputId: 'turn-click-error-after-admission',
});
submitMode = 'success';

submitMode = 'error-no-admission';
const errorNoAdmissionClickBefore = submitClickCount();
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-click-error-no-admission', prompt: 'Click UNKNOWN without provider admission must fail closed' },
  }),
  /submission was not confirmed; worker will not issue a second submit gesture/,
);
assert.equal(submitClickCount(), errorNoAdmissionClickBefore + 1, 'click UNKNOWN without admission must not retry');
pendingPrompt = '';
submitMode = 'success';

const assertProviderUserFidelityRejects = async ({ inputId, prompt, transform, message }) => {
  const clickBefore = submitClickCount();
  const enterBefore = enterCount();
  providerUserDomTransform = (text, index, count) => index === count - 1 ? transform(text) : text;
  await assert.rejects(
    () => controller.control({
      action: 'send',
      pageId: PAGE_ID,
      sessionId: session.sessionId,
      input: { inputId, prompt },
    }),
    /accepted unexpected user text|untrusted structurally unknown occurrence|untrusted user-shaped occurrence|accessibility provider-user occurrence could not be projected/,
    message,
  );
  if (userTexts[userTexts.length - 1] === prompt) userTexts.pop();
  providerUserDomTransform = null;
  streaming = false;
  pendingPrompt = '';
  const clickDelta = submitClickCount() - clickBefore;
  assert.ok(clickDelta === 0 || clickDelta === 1, `${message}: fail closed with at most one submit-control click`);
  assert.equal(enterCount(), enterBefore, `${message}: no Enter fallback`);
};

await assertProviderUserFidelityRejects({
  inputId: 'turn-provider-changed-character',
  prompt: 'character exactness\nline two',
  transform: text => text.replace('exactness', 'exactnesX'),
  message: 'changed provider-user character must fail closed',
});
await assertProviderUserFidelityRejects({
  inputId: 'turn-provider-missing-newline',
  prompt: 'first line\nsecond line',
  transform: text => text.replace('\n', ''),
  message: 'missing provider-user newline must fail closed',
});
await assertProviderUserFidelityRejects({
  inputId: 'turn-provider-extra-newline',
  prompt: 'first line\nsecond line',
  transform: text => text.replace('\n', '\n\n'),
  message: 'extra provider-user newline must fail closed',
});
await assertProviderUserFidelityRejects({
  inputId: 'turn-provider-semantic-indentation',
  prompt: 'header\n  indented row',
  transform: text => text.replace('  indented row', '   indented row'),
  message: 'semantic provider-user indentation change must fail closed',
});

const collapsedProviderPrompt = [
  '# Nimora Explicit Mission Input',
  'Project: project',
  '## Owner-backed Mission Context',
  ...Array.from({ length: 40 }, (_, index) => `history row ${index}: bounded current-context payload`),
].join('\n');
const collapsedClickBefore = submitClickCount();
providerUserDomTransform = (text, index, count) => index === count - 1 ? `${text}\n…\n显示更多` : text;
const collapsedProviderAdmission = await controller.control({
  action: 'send',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
  input: { inputId: 'turn-provider-collapsed-ui-chrome', prompt: collapsedProviderPrompt },
});
assert.equal(
  collapsedProviderAdmission.state,
  'running',
  'known ChatGPT collapsed-message UI chrome must not make an otherwise exact provider-user turn fail admission',
);
providerUserDomTransform = null;
assert.equal(submitClickCount(), collapsedClickBefore + 1, 'collapsed provider-user representation must use exactly one submit gesture');
await controller.control({
  action: 'interrupt',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
  inputId: 'turn-provider-collapsed-ui-chrome',
});

composerPluginMentionName = 'dev-r25-plugin';
const inlineCodePrompt = '# Nimora Explicit Mission Input\n{\n  "instruction": "Read `.build/file.txt`, BEFORE -> `AFTER` once."\n}\n';
exactProviderUserProjection = turns => turns.map((turn, index) => index === turns.length - 1
  ? { ...turn, text: turn.text.replaceAll('`', '') + '…\n显示更多',
    lineTags: (turn.text.replaceAll('`', '') + '…\n显示更多').split('\n').map(() => 'PRE'),
    inlineCodeText: turn.text + '…\n显示更多' } : turn);
const inlineCodeClickBefore = submitClickCount();
const inlineCodeAdmission = await controller.control({ action: 'send', pageId: PAGE_ID, sessionId: session.sessionId,
  input: { inputId: 'turn-provider-inline-code', prompt: inlineCodePrompt } });
assert.equal(inlineCodeAdmission.state, 'running', 'structural inline code candidate must match the entire exact prompt');
assert.equal(submitClickCount(), inlineCodeClickBefore + 1, 'inline code representation must submit once');
exactProviderUserProjection = null;
await controller.control({ action: 'interrupt', pageId: PAGE_ID, sessionId: session.sessionId, inputId: 'turn-provider-inline-code' });
const r25WorkAppPrompt = [
  '# Nimora Explicit Mission Input',
  'Project: project-r25',
  '## Owner-backed Mission Context',
  'provider-user Work app chrome reconciliation',
].join('\n');
const r25WorkAppClickBefore = submitClickCount();
providerUserDomTransform = (text, index, count) => index === count - 1
  ? `${text}\n\nPROVIDER_PLUGIN_DECORATION\n\n…\n显示更多`
  : text;
const r25WorkAppAdmission = await controller.control({
  action: 'send',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
  input: { inputId: 'turn-provider-work-app-collapsed-chrome', prompt: r25WorkAppPrompt },
});
assert.equal(r25WorkAppAdmission.state, 'running', 'exact frozen Work app display text plus collapsed chrome must reconcile to the admitted provider-user prompt');
providerUserDomTransform = null;
assert.equal(submitClickCount(), r25WorkAppClickBefore + 1, 'R25 Work app provider-user reconciliation must use exactly one submit gesture');
await controller.control({
  action: 'interrupt',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
  inputId: 'turn-provider-work-app-collapsed-chrome',
});

const composedProviderPrompt = '# Nimora Explicit Mission Input\n{\n  "instruction": "exact body"\n}';
const nbspProviderBody = text => text.replace('\n  ', '\n\u00a0 ');
for (const [shape, decorate] of [
  ['prefix', text => `PROVIDER_PLUGIN_DECORATION\n ${text}\n\n…\n显示更多`],
  ['suffix', text => `${text}\n\nPROVIDER_PLUGIN_DECORATION\n\n…\n显示更多`],
  ['collapse', text => `${text}\n…\n显示更多`],
]) {
  const clickBefore = submitClickCount();
  providerUserDomTransform = (text, index, count) => index === count - 1
    ? decorate(nbspProviderBody(text)) : text;
  const admitted = await controller.control({
    action: 'send', pageId: PAGE_ID, sessionId: session.sessionId,
    input: { inputId: `turn-provider-composed-${shape}`, prompt: composedProviderPrompt },
  });
  assert.equal(admitted.state, 'running', `${shape} chrome plus bounded USER_TEXT NBSP must preserve the entire exact prompt`);
  assert.equal(submitClickCount(), clickBefore + 1, `${shape} composition must submit only once`);
  providerUserDomTransform = null;
  await controller.control({ action: 'interrupt', pageId: PAGE_ID, sessionId: session.sessionId,
    inputId: `turn-provider-composed-${shape}` });
}
for (const [shape, transform] of [
  ['changed-body', text => `${nbspProviderBody(text).replace('exact body', 'wrong body')}\n\nPROVIDER_PLUGIN_DECORATION\n\n…\n显示更多`],
  ['wrong-label', text => `WRONG_PLUGIN_DECORATION\n ${nbspProviderBody(text)}\n\n…\n显示更多`],
  ['extra-tail', text => `PROVIDER_PLUGIN_DECORATION\n ${nbspProviderBody(text)}\n\n…\n显示更多\nextra`],
]) {
  await assertProviderUserFidelityRejects({ inputId: `turn-provider-composed-reject-${shape}`,
    prompt: `${composedProviderPrompt}\nnegative ${shape}`, transform, message: `${shape} with NBSP must still fail closed` });
}
exactProviderUserProjection = turns => turns.map((turn, index) => {
  if (index !== turns.length - 1) return turn;
  return { ...turn, lineTags: turn.text.split('\n').map((line, i) =>
    line.startsWith('\u00a0 ') ? 'PRE' : turn.lineTags[i]) };
});
await assertProviderUserFidelityRejects({ inputId: 'turn-provider-composed-reject-pre',
  prompt: `${composedProviderPrompt}\nnegative semantic PRE`,
  transform: text => `${nbspProviderBody(text)}\n\nPROVIDER_PLUGIN_DECORATION\n\n…\n显示更多`,
  message: 'semantic PRE indentation must not be reconciled through app chrome' });
exactProviderUserProjection = null;

await assertProviderUserFidelityRejects({
  inputId: 'turn-provider-work-app-wrong-display',
  prompt: 'Wrong Work app display text must fail closed',
  transform: text => `${text}\n\nDIFFERENT_PLUGIN_DECORATION\n\n…\n显示更多`,
  message: 'provider-user Work app chrome with a different display text must fail closed',
});
await assertProviderUserFidelityRejects({
  inputId: 'turn-provider-work-app-missing-show-more',
  prompt: 'Missing Work app collapse chrome must fail closed',
  transform: text => `${text}\n\nPROVIDER_PLUGIN_DECORATION`,
  message: 'provider-user Work app display text without the exact collapse chrome must fail closed',
});
await assertProviderUserFidelityRejects({
  inputId: 'turn-provider-work-app-extra-tail',
  prompt: 'Arbitrary Work app trailing text must fail closed',
  transform: text => `${text}\n\nPROVIDER_PLUGIN_DECORATION\n\n…\n显示更多\nextra`,
  message: 'provider-user Work app chrome with arbitrary trailing text must fail closed',
});

const r25NonUserTagPrompt = 'Work app suffix provenance must remain USER_TEXT';
const r25NonUserTagClickBefore = submitClickCount();
providerUserDomTransform = (text, index, count) => index === count - 1
  ? `${text}\n\nPROVIDER_PLUGIN_DECORATION\n\n…\n显示更多`
  : text;
exactProviderUserProjection = turns => turns.map((turn, index) => {
  if (index !== turns.length - 1) return turn;
  const lineTags = Array.isArray(turn.lineTags) ? [...turn.lineTags] : [];
  if (lineTags.length) lineTags[lineTags.length - 1] = 'PRE';
  return { ...turn, lineTags };
});
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-provider-work-app-non-user-tag', prompt: r25NonUserTagPrompt },
  }),
  /accepted unexpected user text|untrusted structurally unknown occurrence|untrusted user-shaped occurrence/,
  'provider-user Work app suffix with non-USER_TEXT provenance must fail closed',
);
if (userTexts[userTexts.length - 1] === r25NonUserTagPrompt) userTexts.pop();
providerUserDomTransform = null;
exactProviderUserProjection = null;
streaming = false;
pendingPrompt = '';
assert.ok(submitClickCount() - r25NonUserTagClickBefore <= 1, 'non-USER_TEXT Work app suffix must fail with at most one submit gesture');
composerPluginMentionName = '';

submitMode = 'unexpected-text';
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-unexpected-user-text', prompt: 'Expected exact provider user text' },
  }),
  /accepted unexpected user text|untrusted structurally unknown occurrence|untrusted user-shaped occurrence/,
);
if (userTexts[userTexts.length - 1] === 'UNEXPECTED_PROVIDER_TEXT') userTexts.pop();
streaming = false;
submitMode = 'success';
await controller.control({
  action: 'health',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
});

submitMode = 'multiple-users';
await assert.rejects(
  () => controller.control({
    action: 'send',
    pageId: PAGE_ID,
    sessionId: session.sessionId,
    input: { inputId: 'turn-multiple-provider-users', prompt: 'Exactly one provider user identity is required' },
  }),
  /multiple new provider user identities|untrusted structurally unknown occurrence|untrusted user-shaped occurrence/,
);
streaming = false;
submitMode = 'success';

const disconnected = await controller.control({
  action: 'disconnect',
  pageId: PAGE_ID,
  sessionId: session.sessionId,
});
assert.equal(disconnected.disconnected, true);
assert.equal(controller.sessionCount(), 0);
assert.equal((await controller.listResources()).length, 1, 'retired/disconnected page may become a fresh assignment candidate');

// A Work app provider-user turn may render the exact app display name before the
// admitted prompt and collapsed-message chrome after it. Reconciliation must
// preserve exact prompt identity, and recovery of an already-submitted turn
// must never issue another provider mutation.
href = 'https://chatgpt.com/';
listedPageId = PAGE_ID;
userTexts = [];
assistantTexts = [];
pendingPrompt = '';
streaming = false;
responseComplete = false;
transientPreConversationObservations = 0;
unchangedReads = 0;
delayedFirstConversationPrompt = '';
delayedFirstConversationStage = 0;
ambiguousComposer = false;
exactComposerMismatch = false;
composerTrailingEmptyParagraphs = 0;
composerPluginMentionName = '';
providerUserDomTransform = null;
exactProviderUserExtras = [];
exactProviderUserProjection = null;

const recoveryResource = (await controller.listResources())[0];
assert.ok(recoveryResource, 'recovery falsifier must begin from an assignable pre-conversation page');
const recoverySession = await controller.connect({
  target: {
    pageId: recoveryResource.pageId,
    resourceIdentity: recoveryResource.resourceIdentity,
    lifecycleIdentity: recoveryResource.lifecycleIdentity,
    origin: recoveryResource.origin,
    href: recoveryResource.href,
  },
});
const recoveryPrompt = [
  '# Nimora Explicit Mission Input',
  'Project: recovery-prefix',
  '## Owner-backed Mission Context',
  'adopt the already-submitted provider turn without resend',
].join('\n');
const recoveryWorkApp = 'Nimora Phase11 Current';
providerUserDomTransform = (text, index, count) => index === count - 1
  ? `${recoveryWorkApp}\n ${text}\n\n…\n显示更多`
  : text;
userTexts.push(recoveryPrompt);
href = 'https://chatgpt.com/c/recovered-existing-submission';
streaming = true;
const recoveryTypeBefore = browserCalls.filter(call => call.name === 'type_in_page').length;
const recoveryClickBefore = submitClickCount();
const recoveryEnterBefore = enterCount();
const recoveredExisting = await controller.control({
  action: 'send',
  pageId: PAGE_ID,
  sessionId: recoverySession.sessionId,
  input: {
    inputId: 'turn-recover-existing-work-app-prefix',
    prompt: recoveryPrompt,
    recoverExisting: true,
    workAppDisplayText: recoveryWorkApp,
  },
});
assert.equal(recoveredExisting.state, 'running', 'already-submitted exact Work app turn must be adopted as the active turn');
assert.ok(
  recoveredExisting.events.some(event => event.type === 'status' && event.name === 'recovered-existing-submission'),
  'recovery must record an explicit recovered-existing-submission status',
);
assert.equal(browserCalls.filter(call => call.name === 'type_in_page').length, recoveryTypeBefore, 'existing-submission recovery must perform zero composer writes');
assert.equal(submitClickCount(), recoveryClickBefore, 'existing-submission recovery must perform zero submit clicks');
assert.equal(enterCount(), recoveryEnterBefore, 'existing-submission recovery must perform zero Enter gestures');
const recoveredExistingAgain = await controller.control({
  action: 'send',
  pageId: PAGE_ID,
  sessionId: recoverySession.sessionId,
  input: {
    inputId: 'turn-recover-existing-work-app-prefix',
    prompt: recoveryPrompt,
    recoverExisting: true,
    workAppDisplayText: recoveryWorkApp,
  },
});
assert.equal(recoveredExistingAgain.inputId, recoveredExisting.inputId, 'same inputId retry must be idempotent and return the adopted turn');
assert.equal(submitClickCount(), recoveryClickBefore, 'same inputId retry after recovery must still perform zero submit clicks');
await controller.control({
  action: 'interrupt',
  pageId: PAGE_ID,
  sessionId: recoverySession.sessionId,
  inputId: recoveredExisting.inputId,
});
await controller.control({
  action: 'disconnect',
  pageId: PAGE_ID,
  sessionId: recoverySession.sessionId,
});
const currentConversationResource = (await controller.listResources())[0];
assert.ok(currentConversationResource, 'a fresh controller-style connection must be able to discover the same current conversation after disconnect');
const currentConversationSession = await controller.connect({
  target: {
    pageId: currentConversationResource.pageId,
    resourceIdentity: currentConversationResource.resourceIdentity,
    lifecycleIdentity: currentConversationResource.lifecycleIdentity,
    origin: currentConversationResource.origin,
    href: currentConversationResource.href,
  },
});
const reconnectClickBefore = submitClickCount();
const reconnectTypeBefore = browserCalls.filter(call => call.name === 'type_in_page').length;
const recoveredAfterReconnect = await controller.control({
  action: 'send',
  pageId: PAGE_ID,
  sessionId: currentConversationSession.sessionId,
  input: {
    inputId: 'turn-recover-existing-after-current-conversation-connect',
    prompt: recoveryPrompt,
    recoverExisting: true,
    workAppDisplayText: recoveryWorkApp,
  },
});
assert.equal(recoveredAfterReconnect.state, 'running', 'fresh current-conversation connection must adopt the exact existing provider turn');
assert.equal(submitClickCount(), reconnectClickBefore, 'fresh current-conversation recovery must perform zero submit clicks');
assert.equal(browserCalls.filter(call => call.name === 'type_in_page').length, reconnectTypeBefore, 'fresh current-conversation recovery must perform zero composer writes');
await controller.control({
  action: 'interrupt',
  pageId: PAGE_ID,
  sessionId: currentConversationSession.sessionId,
  inputId: recoveredAfterReconnect.inputId,
});
await controller.control({
  action: 'disconnect',
  pageId: PAGE_ID,
  sessionId: currentConversationSession.sessionId,
});
providerUserDomTransform = null;
streaming = false;

const controllerSource = await fs.readFile(path.join(root, 'extensions', 'shuncode-webmcp', 'chatgpt-worker-controller.js'), 'utf8');
const resourceSource = await fs.readFile(path.join(root, 'extensions', 'shuncode-webmcp', 'chatgpt-worker-resources.js'), 'utf8');
const typeBrowserToolSource = await fs.readFile(path.join(root, 'src', 'vs', 'workbench', 'contrib', 'browserView', 'electron-browser', 'tools', 'typeBrowserTool.ts'), 'utf8');
assert.equal(controllerSource.includes('__shuncodeWebMcp'), false, 'ChatGPT route must not inject the WebMCP tool runtime');
assert.equal(resourceSource.includes('__shuncodeWebMcp'), false, 'ChatGPT page control must remain distinct from WebMCP tool injection');
assert.match(typeBrowserToolSource, /literalText[\s\S]*page\.keyboard\.insertText\(text\)/, 'type_in_page must expose an explicit literal-text path backed by keyboard.insertText');
assert.match(typeBrowserToolSource, /if \(literalText\) \{\s*await locator\.focus\(\);\s*await page\.keyboard\.insertText\(text\);/, 'ref-targeted literalText must focus the exact element without click semantics before insertText');
assert.match(typeBrowserToolSource, /else \{\s*await page\.keyboard\.type\(text\);/, 'default no-ref type_in_page behavior must remain keyboard.type when literalText is not requested');
assert.ok(browserCalls.some(call => call.name === 'read_page'));
assert.ok(browserCalls.some(call => call.name === 'type_in_page'));
assert.ok(browserCalls.some(call => call.name === 'click_element'));
assert.ok(browserCalls.some(call => call.name === 'type_in_page' && call.input?.ref === 'composer' && call.input?.text && call.input?.submit === false), 'ChatGPT send must fill the exact admitted composer without submitting first');
assert.ok(browserCalls.some(call => call.name === 'click_element' && call.input?.ref === 'send' && call.input?.element === 'ChatGPT exact submit button'), 'ChatGPT send must use one exact submit-control click after stable full-read confirmation');
assert.equal(enterCount(), 0, 'ChatGPT production send must have zero Enter submit gestures');
assert.equal(nonSubmitToolbarClickCount(), 0, 'ChatGPT production send must never click known non-submit toolbar controls');
assert.equal(browserCalls.some(call => call.name === 'run_playwright_code'), false, 'ChatGPT Worker route must not require arbitrary Playwright code execution');
assert.equal(browserCalls.some(call => call.name === 'open_browser_page'), false, 'assignment must use an already-shared exact page');
assert.notEqual(
  chatGptResources.lifecycleIdentityFor('22222222-2222-4222-8222-222222222222'),
  target.lifecycleIdentity,
  'a genuinely new browser page generation must receive a distinct lifecycle identity',
);

await import('./shuncode-phase11-chatgpt-retirement-lineage-smoke.mts');
await import('./shuncode-chatgpt-admission-observation-smoke.mjs');

console.log(JSON.stringify({
  result: 'PASS',
  discoveryMutation: false,
  exactSharedPage: true,
  hiddenPageActivatedBeforeMutation: true,
  hiddenPageActivationCount: 1,
  activationFailureProviderMutations: 0,
  alreadyVisibleActivationCount: 0,
  initialConversationCreationAdmitted: true,
  delayedFirstConversationTransitionAdmitted: true,
  navigationOnlyAdmissionRejected: true,
  firstSendPageDriftRejected: true,
  firstSendOriginDriftRejected: true,
  stableLifecycleIdentity: true,
  multilineComposerExact: true,
  realShapeLeadingWhitespaceAndEmptyLinesExact: true,
  exactMismatchRejected: true,
  multilineSingleSubmitClick: true,
  currentZhSubmitLabelExact: true,
  enterSubmitGestures: 0,
  exactSubmitControlRequired: true,
  ambiguousSubmitControlRejected: true,
  retainedPromptNoopNoRetry: true,
  clickUnknownAdmissionRecoveredByObservation: true,
  clickUnknownWithoutAdmissionRejected: true,
  exactProviderUserAdmission: true,
  realShapeAccessibilityFlatteningReproduced: true,
  fixedProviderUserLogicalTextAuthority: true,
  fullSnapshotStateCoherent: true,
  unchangedSnapshotStateCoherent: true,
  repeatedProviderUserDeltaCoherent: true,
  newProviderUserDeltaAppendsOnce: true,
  assistantDeltaChronologyCoherent: true,
  secondSameConversationSendCoherent: true,
  laterSameConversationSendCoherent: true,
  duplicateDeltaRoleKeyDeduped: true,
  providerUserChangedCharacterRejected: true,
  providerUserMissingNewlineRejected: true,
  providerUserExtraNewlineRejected: true,
  providerUserSemanticIndentationRejected: true,
  providerUserDifferentTextRejected: true,
  multipleProviderUserIdentitiesRejected: true,
  placeholderEmpty: true,
  humanTextOverwriteRejected: true,
  uiChromeExcluded: true,
  ambiguousComposerRejected: true,
  unknownSubmitNoResend: true,
  activeTabDoubleAssignment: false,
  conversationDriftRejected: true,
  interrupt: true,
  disconnectThenReassignable: true,
  workAppPrefixProviderUserReconciled: true,
  existingSubmissionRecoveryZeroResend: true,
  existingSubmissionRecoveryAfterCurrentConversationConnect: true,
  webMcpToolInjection: false,
}, null, 2));
