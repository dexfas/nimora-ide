'use strict';

const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);
const DEEPSEEK_HOSTS = new Set(['chat.deepseek.com']);

const CONTEXT_LIMIT_PATTERNS = [
  /maximum context (?:length|window).*(?:exceed|reach|full)/i,
  /context (?:length|window).*(?:exceed|reach|full|too long)/i,
  /conversation (?:is )?too long/i,
  /too many tokens/i,
  /prompt is too long/i,
  /input is too long/i,
  /上下文.{0,20}(?:已满|满了|超出|超过|过长|达到.{0,6}上限)/i,
  /(?:对话|聊天).{0,12}(?:过长|已满|达到.{0,6}上限)/i,
  /コンテキスト.{0,20}(?:上限|長すぎ|超え)/i,
];

const ARCHIVE_LABELS = new Set([
  'archive', 'archive chat', 'archive conversation',
  '归档', '归档聊天', '归档对话',
]);
const DELETE_LABELS = new Set([
  'delete', 'delete chat', 'delete conversation',
  '删除', '删除聊天', '删除对话',
]);
const MENU_LABELS = new Set([
  'more', 'more options', 'conversation options', 'chat options',
  '更多', '更多选项', '对话选项', '聊天选项',
]);

function boundedText(value, max = 2000000) {
  const text = String(value || '');
  return text.length <= max ? text : text.slice(0, max);
}

function normalizeLabel(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function providerForHref(href) {
  try {
    const host = new URL(String(href || '')).hostname.toLowerCase();
    if (CHATGPT_HOSTS.has(host)) return 'chatgpt';
    if (DEEPSEEK_HOSTS.has(host)) return 'deepseek';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

function conversationIdentity(provider, href) {
  try {
    const url = new URL(String(href || ''));
    if (provider === 'chatgpt' && CHATGPT_HOSTS.has(url.hostname.toLowerCase())) {
      const match = url.pathname.match(/^\/c\/([^/?#]+)/i);
      return match ? decodeURIComponent(match[1]) : '';
    }
    if (provider === 'deepseek' && DEEPSEEK_HOSTS.has(url.hostname.toLowerCase())) {
      const match = url.pathname.match(/^\/(?:a\/)?chat\/(?:s\/)?([^/?#]+)/i);
      return match ? decodeURIComponent(match[1]) : '';
    }
  } catch {}
  return '';
}

function readPageHref(text) {
  const match = boundedText(text).match(/(?:^|\n)URL:\s*(https?:\/\/[^\s]+)\s*(?:\n|$)/i);
  return match ? match[1].trim() : '';
}

function explicitContextLimit(text) {
  const bounded = boundedText(text, 20000);
  return CONTEXT_LIMIT_PATTERNS.some(pattern => pattern.test(bounded));
}

function inspectProviderSnapshot(input) {
  const text = boundedText(input?.readPageText);
  const href = readPageHref(text) || String(input?.href || '');
  const provider = input?.provider || providerForHref(href);
  const snapshotIndex = text.indexOf('Snapshot:');
  const snapshot = snapshotIndex >= 0 ? text.slice(snapshotIndex + 'Snapshot:'.length) : text;
  const messageMarkerCount = provider === 'chatgpt'
    ? (snapshot.match(/heading\s+"(?:You said:|ChatGPT said:|你说：|ChatGPT 说：)"/gi) || []).length
    : (snapshot.match(/(?:ds-message|assistant-message|user-message|message-content)/gi) || []).length;
  return {
    version: 1,
    provider,
    href,
    conversationId: conversationIdentity(provider, href),
    providerExplicitLimit: explicitContextLimit(snapshot),
    providerVisibleCharsFloor: snapshot.length,
    providerVisibleTurnMarkers: messageMarkerCount,
  };
}

function extractControls(text) {
  const controls = [];
  for (const line of boundedText(text).split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+(button|menuitem)\s+"([^"]*)"[^\n]*?\[ref=([^\]]+)\]/i);
    if (!match) continue;
    controls.push({ role: match[1].toLowerCase(), label: match[2], normalizedLabel: normalizeLabel(match[2]), ref: match[3] });
  }
  return controls;
}

function uniqueControl(controls, roles, labels, description) {
  const matches = controls.filter(control => roles.has(control.role) && labels.has(control.normalizedLabel));
  if (matches.length > 1) throw new Error('Provider conversation cleanup is ambiguous: multiple ' + description + ' controls are visible.');
  return matches[0];
}

function assertCleanupIdentity(request, readPageText) {
  const actualHref = readPageHref(readPageText);
  if (!actualHref) throw new Error('Provider conversation cleanup could not read the exact current page URL.');
  const provider = request.provider || providerForHref(actualHref);
  if (provider !== 'chatgpt' && provider !== 'deepseek') throw new Error('Provider conversation cleanup supports only ChatGPT or DeepSeek.');
  if (providerForHref(actualHref) !== provider) throw new Error('Provider conversation cleanup page/provider identity changed.');
  const actualConversationId = conversationIdentity(provider, actualHref);
  const expectedConversationId = String(request.conversationId || conversationIdentity(provider, request.expectedHref) || '');
  if (!expectedConversationId) throw new Error('Provider conversation cleanup requires an exact provider conversation identity.');
  if (actualConversationId !== expectedConversationId) {
    throw new Error('Provider conversation cleanup refused a different provider conversation identity.');
  }
  return { provider, href: actualHref, conversationId: actualConversationId };
}

function chooseCleanupAction(controls, mode) {
  const actionRoles = new Set(['menuitem', 'button']);
  const archive = uniqueControl(controls, actionRoles, ARCHIVE_LABELS, 'archive');
  const deletion = uniqueControl(controls, actionRoles, DELETE_LABELS, 'delete');
  if (mode === 'archive-only') return archive ? { action: 'archive', control: archive } : undefined;
  if (mode === 'delete') return deletion ? { action: 'delete', control: deletion } : undefined;
  if (archive) return { action: 'archive', control: archive };
  if (deletion) return { action: 'delete', control: deletion };
  return undefined;
}

function cleanupPlanStep(readPageText, mode = 'archive-preferred', stage = 'initial') {
  if (!['archive-preferred', 'archive-only', 'delete'].includes(mode)) {
    throw new Error('Unsupported provider conversation cleanup mode: ' + String(mode));
  }
  const controls = extractControls(readPageText);
  if (stage === 'confirm-delete') {
    const confirm = uniqueControl(controls, new Set(['button']), DELETE_LABELS, 'delete confirmation');
    if (!confirm) throw new Error('Provider conversation delete confirmation control is unavailable.');
    return { kind: 'confirm-delete', ref: confirm.ref, label: confirm.label };
  }
  const direct = chooseCleanupAction(controls, mode);
  if (direct) {
    return {
      kind: direct.action === 'archive' ? 'archive' : 'delete',
      ref: direct.control.ref,
      label: direct.control.label,
    };
  }
  const menu = uniqueControl(controls, new Set(['button']), MENU_LABELS, 'conversation menu');
  if (menu) return { kind: 'open-menu', ref: menu.ref, label: menu.label };
  throw new Error('Provider conversation cleanup controls are unavailable or unsupported on the exact current page.');
}

function cleanupVerifiedAfterHref(provider, href) {
  if (!href || providerForHref(href) !== provider) throw new Error('Provider cleanup outcome is unverified: exact provider URL is missing or changed. Do not replay.');
  return conversationIdentity(provider, href);
}

async function runProviderConversationCleanup(browser, request) {
  if (!browser || typeof browser.readPage !== 'function' || typeof browser.clickElement !== 'function') {
    throw new Error('Provider conversation cleanup requires readPage and clickElement browser capabilities.');
  }
  const pageId = String(request?.pageId || '').trim();
  if (!pageId) throw new Error('Provider conversation cleanup requires pageId.');
  const mode = request?.mode || 'archive-preferred';

  let readText = await browser.readPage(pageId);
  const exact = assertCleanupIdentity(request, readText);
  let stage = 'initial';
  let appliedAction = '';

  for (let stepIndex = 0; stepIndex < 4; stepIndex += 1) {
    const step = cleanupPlanStep(readText, mode, stage);
    await browser.clickElement(pageId, step.ref, 'Nimora provider conversation ' + step.kind);
    if (step.kind === 'open-menu') {
      readText = await browser.readPage(pageId);
      assertCleanupIdentity({ ...request, provider: exact.provider, conversationId: exact.conversationId }, readText);
      continue;
    }
    if (step.kind === 'delete') {
      appliedAction = 'deleted';
      stage = 'confirm-delete';
      readText = await browser.readPage(pageId);
      const afterHref = readPageHref(readText);
      if (cleanupVerifiedAfterHref(exact.provider, afterHref) !== exact.conversationId) {
        return { version: 1, state: 'deleted', provider: exact.provider, conversationId: exact.conversationId, verified: true };
      }
      continue;
    }
    if (step.kind === 'confirm-delete') {
      appliedAction = 'deleted';
    } else if (step.kind === 'archive') {
      appliedAction = 'archived';
    }

    const after = await browser.readPage(pageId);
    const afterHref = readPageHref(after);
    if (cleanupVerifiedAfterHref(exact.provider, afterHref) === exact.conversationId) {
      throw new Error('Provider conversation cleanup action was not verified; exact conversation remains current.');
    }
    return {
      version: 1,
      state: appliedAction,
      provider: exact.provider,
      conversationId: exact.conversationId,
      verified: true,
    };
  }
  throw new Error('Provider conversation cleanup exceeded the bounded action sequence without verified completion.');
}

module.exports = {
  providerForHref,
  conversationIdentity,
  readPageHref,
  explicitContextLimit,
  inspectProviderSnapshot,
  extractControls,
  cleanupPlanStep,
  assertCleanupIdentity,
  runProviderConversationCleanup,
};
