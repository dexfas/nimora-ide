const { createHash } = require('node:crypto');

const CHATGPT_HOSTS = new Set(['chatgpt.com', 'chat.openai.com']);

function normalizedUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return CHATGPT_HOSTS.has(url.hostname.toLowerCase()) ? url : null;
  } catch {
    return null;
  }
}

function conversationIdFromHref(value) {
  const url = normalizedUrl(value);
  if (!url) return '';
  const match = url.pathname.match(/(?:^|\/)c\/([^/?#]+)/i);
  return match ? decodeURIComponent(match[1]) : '';
}

function unquoteSnapshotText(value) {
  const text = String(value || '').trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch {}
    return text.slice(1, -1);
  }
  return text;
}

function snapshotLeafText(line) {
  const match = String(line || '').match(/^\s*-\s+(?:<(?:changed|unchanged)>\s+)?(?:generic|paragraph|code|pre|listitem)(?:\s+\[[^\]]+\])?:\s*(.+?)\s*$/i);
  if (!match) return '';
  return unquoteSnapshotText(match[1]);
}

function snapshotAssistantContentText(line) {
  const value = String(line || '');
  const leaf = value.match(/^\s*-\s+(?:<(?:changed|unchanged)>\s+)?(?:paragraph|code|pre|listitem|cell)(?:\s+\[[^\]]+\])?:\s*(.+?)\s*$/i);
  if (leaf) return unquoteSnapshotText(leaf[1]);
  const heading = value.match(/^\s*-\s+(?:<(?:changed|unchanged)>\s+)?heading\s+"([^"]+)"\s+\[level=([1-3])\](?:\s+\[[^\]]+\])?/i);
  return heading ? unquoteSnapshotText(heading[1]) : '';
}

function parseRoleMessages(snapshot) {
  const userMessages = [];
  const assistantMessages = [];
  const orderedMessages = [];
  const lines = String(snapshot || '').split(/\r?\n/);
  let role = '';
  let roleKey = '';
  let parts = [];
  const flush = () => {
    const text = parts.map(value => String(value || '').trim()).filter(Boolean).join('\n').trim();
    if (text) {
      const entry = { role, key: roleKey || '', text };
      if (role === 'user') userMessages.push(entry);
      else if (role === 'assistant') assistantMessages.push(entry);
      if (role === 'user' || role === 'assistant') orderedMessages.push(entry);
    }
    parts = [];
  };
  for (const line of lines) {
    const userHeading = /heading\s+"(?:你说：|You said:|User:)"\s+\[level=4\]/i.test(line)
      || /heading(?:\s+\[[^\]]+\])+\s*:\s*(?:你说：|You said:|User:)\s*$/i.test(line);
    const assistantHeading = /heading\s+"(?:ChatGPT 说：|ChatGPT said:)"\s+\[level=4\]/i.test(line)
      || /heading(?:\s+\[[^\]]+\])+\s*:\s*(?:ChatGPT 说：|ChatGPT said:)\s*$/i.test(line);
    if (userHeading) {
      flush();
      role = 'user';
      roleKey = line.match(/\[ref=([^\]]+)\]/i)?.[1] || '';
      continue;
    }
    if (assistantHeading) {
      flush();
      role = 'assistant';
      roleKey = line.match(/\[ref=([^\]]+)\]/i)?.[1] || '';
      continue;
    }
    if (role && /^\s*-\s+(?:<(?:changed|unchanged)>\s+)?group(?:\s+"[^"]*")?(?:\s+\[[^\]]+\])?\s*:?\s*$/i.test(line)) {
      flush();
      role = '';
      roleKey = '';
      continue;
    }
    if (role && /^\s*-\s+(?:<(?:changed|unchanged)>\s+)?textbox\b/i.test(line)) {
      flush();
      role = '';
      roleKey = '';
      continue;
    }
    if (!role) continue;
    const text = role === 'assistant' ? snapshotAssistantContentText(line) : snapshotLeafText(line);
    if (text) parts.push(text);
  }
  flush();
  return {
    userMessages: userMessages.slice(-80),
    assistantMessages: assistantMessages.slice(-80),
    messages: orderedMessages.slice(-160),
    userTexts: userMessages.map(entry => entry.text).slice(-80),
    assistantTexts: assistantMessages.map(entry => entry.text).slice(-80),
  };
}

const COMPOSER_PLACEHOLDER = /^(?:问问\s*ChatGPT|与\s*ChatGPT\s*聊天|Message\s+ChatGPT|Ask\s+(?:ChatGPT|anything)|Send\s+a\s+message)$/i;
const CHATGPT_SUBMIT_CONTROL_LABEL = /^(?:send(?:\s+message)?|submit|发送|提交|发送提示词)$/i;

function snapshotNode(line) {
  const match = String(line || '').match(/^(\s*)-\s+(?:<(?:changed|unchanged)>\s+)?([a-z][a-z0-9_-]*)\b/i);
  return match ? { indent: match[1].length, type: match[2].toLowerCase() } : null;
}

function snapshotComposerContentLeaf(line) {
  const match = String(line || '').match(/^\s*-\s+(?:<(?:changed|unchanged)>\s+)?(?:paragraph|code|pre|listitem)(?:\s+\[[^\]]+\])?:\s*(.*?)\s*$/i);
  if (!match) return { matched: false, text: '' };
  return { matched: true, text: unquoteSnapshotText(match[1]) };
}

function parseComposer(snapshot) {
  const lines = String(snapshot || '').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    const match = line.match(/^(\s*)-\s+(?:<(?:changed|unchanged)>\s+)?textbox(?:\s+"[^"]*")?(?:\s+\[active\])?\s+\[ref=([^\]]+)\]/i);
    if (!match) continue;
    const indent = match[1].length;
    const containerIndent = Math.max(0, indent - 2);
    const composerParts = [];
    let composerAmbiguous = false;
    const subtreeStack = [];
    const actionButtons = [];
    for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
      const child = lines[childIndex];
      const node = snapshotNode(child);
      const childIndent = node?.indent ?? (child.match(/^(\s*)/)?.[1].length ?? 0);
      if (child.trim().startsWith('- ') && childIndent <= containerIndent) break;
      const buttonMatch = child.match(/^\s*-\s+(?:<(?:changed|unchanged)>\s+)?button(?:\s+"([^"]*)")?[^\n]*?\[ref=([^\]]+)\]/i);
      if (buttonMatch && childIndent > indent && !/\[disabled\]/i.test(child)) {
        actionButtons.push({ label: String(buttonMatch[1] || '').trim(), ref: buttonMatch[2] });
      }

      if (!node || childIndent <= indent) continue;
      while (subtreeStack.length && subtreeStack[subtreeStack.length - 1].indent >= childIndent) subtreeStack.pop();
      const underInteractiveChrome = subtreeStack.some(ancestor => ancestor.type === 'button' || ancestor.type === 'link');
      const contentLeaf = snapshotComposerContentLeaf(child);
      if (contentLeaf.matched && !underInteractiveChrome) {
        composerParts.push(contentLeaf.text);
      } else if (!underInteractiveChrome && node.type === 'generic' && snapshotLeafText(child)) {
        composerAmbiguous = true;
      }
      subtreeStack.push(node);
    }
    let composerText = composerParts.join('\n');
    if (composerParts.length === 1 && COMPOSER_PLACEHOLDER.test(composerParts[0])) composerText = '';
    const actionButtonRefs = actionButtons.map(button => button.ref);
    const explicitSubmitRefs = actionButtons
      .filter(button => CHATGPT_SUBMIT_CONTROL_LABEL.test(button.label))
      .map(button => button.ref);
    const unlabeledActionRefs = actionButtons
      .filter(button => !button.label)
      .map(button => button.ref);
    const structuralSubmitRefs = explicitSubmitRefs.length === 0 && composerText && unlabeledActionRefs.length === 1
      ? unlabeledActionRefs
      : [];
    const submitRefs = explicitSubmitRefs.length > 0 ? explicitSubmitRefs : structuralSubmitRefs;
    const sendButtonAmbiguous = explicitSubmitRefs.length > 1
      || (explicitSubmitRefs.length === 0 && !!composerText && unlabeledActionRefs.length > 1);
    return {
      composerFound: true,
      composerRef: match[2],
      composerText,
      composerAmbiguous,
      actionButtonRefs,
      sendButtonRef: !sendButtonAmbiguous && submitRefs.length === 1 ? submitRefs[0] : '',
      sendButtonAmbiguous,
    };
  }
  return { composerFound: false, composerRef: '', composerText: '', composerAmbiguous: false, actionButtonRefs: [], sendButtonRef: '', sendButtonAmbiguous: false };
}

function parseReadPageResult(page, text) {
  const raw = String(text || '');
  const title = raw.match(/^Page Title:\s*(.*)$/mi)?.[1]?.trim() || String(page?.title || '');
  const href = raw.match(/^URL:\s*(\S+)\s*$/mi)?.[1]?.trim() || String(page?.url || '');
  const url = normalizedUrl(href);
  const snapshotIndex = raw.lastIndexOf('Snapshot:');
  const snapshot = snapshotIndex >= 0 ? raw.slice(snapshotIndex + 'Snapshot:'.length) : '';
  const trimmedSnapshot = snapshot.trim();
  const snapshotKind = snapshotIndex < 0
    ? 'none'
    : trimmedSnapshot === '<unchanged>'
    ? 'unchanged'
    : /<(?:changed|unchanged)>/i.test(trimmedSnapshot) ? 'delta' : 'full';
  const composer = parseComposer(snapshot);
  const messages = parseRoleMessages(snapshot);
  const stopMatch = snapshot.match(/button\s+"(?:停止回答|停止生成|Stop|Stop generating)"(?![^\n]*\[disabled\])[^\n]*\[ref=([^\]]+)\]/i);
  const responseCompleteMatch = snapshot.match(/status(?:\s+[^\n]*)?:\s*(?:回答已完成|Response complete(?:d)?|Answer complete(?:d)?|Finished responding)\s*$/im);
  const idleControlsPresent = /button\s+"(?:开始听写|启动语音功能|Start dictation|Start voice mode)"/i.test(snapshot);
  return {
    href: url?.href || '',
    origin: url?.origin || '',
    title,
    snapshotKind,
    composerObserved: composer.composerFound,
    composerFound: composer.composerFound,
    composerRef: composer.composerRef,
    composerText: composer.composerText,
    composerAmbiguous: composer.composerAmbiguous,
    sendButtonRef: composer.sendButtonRef,
    sendButtonAmbiguous: composer.sendButtonAmbiguous,
    streamingKnown: snapshotKind === 'full' || !!stopMatch || idleControlsPresent,
    streaming: !!stopMatch,
    stopButtonRef: stopMatch?.[1] || '',
    responseCompleteKnown: snapshotKind === 'full' || !!stopMatch || !!responseCompleteMatch,
    responseComplete: !!responseCompleteMatch && !stopMatch,
    assistantTexts: messages.assistantTexts,
    userTexts: messages.userTexts,
    assistantMessages: messages.assistantMessages,
    userMessages: messages.userMessages,
    messages: messages.messages,
  };
}

function resourceIdentityFor(pageId, observation) {
  return createHash('sha256').update([
    String(pageId || ''),
    String(observation?.origin || ''),
    String(observation?.href || ''),
    conversationIdFromHref(observation?.href),
  ].join('\u0000')).digest('hex');
}

function lifecycleIdentityFor(pageId) {
  return createHash('sha256').update([
    'openai-chatgpt-page-generation',
    String(pageId || ''),
  ].join('\u0000')).digest('hex');
}

function buildObservationCode(siteAdapterSource) {
  const factorySource = `(${String(siteAdapterSource || '').trim()})`;
  return `
    const factorySource = ${JSON.stringify(factorySource)};
    return await page.evaluate(source => {
      const createSiteAdapter = (0, eval)(source);
      const visible = element => !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
      const site = createSiteAdapter({ window, document, location, visible, storage: sessionStorage });
      const texts = (site.assistantMessageCandidates?.() || []).map(element => site.assistantMessageText?.(element) || String(element?.innerText || element?.textContent || '')).filter(Boolean).slice(-80);
      const userTexts = [...document.querySelectorAll('[data-message-author-role="user"], [data-role="user"]')]
        .map(element => String(element?.innerText || element?.textContent || '').trim())
        .filter(Boolean)
        .slice(-80);
      return {
        href: location.href,
        origin: location.origin,
        composerFound: !!site.findComposer?.(),
        streaming: site.isResponseStreaming?.() === true,
        assistantTexts: texts,
        userTexts,
      };
    }, factorySource);
  `;
}

function buildInterruptCode(siteAdapterSource) {
  const factorySource = `(${String(siteAdapterSource || '').trim()})`;
  return `
    const factorySource = ${JSON.stringify(factorySource)};
    return await page.evaluate(source => {
      const createSiteAdapter = (0, eval)(source);
      const visible = element => !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
      const site = createSiteAdapter({ window, document, location, visible, storage: sessionStorage });
      return site.interruptGeneration?.() ?? false;
    }, factorySource);
  `;
}

function normalizeObservation(page, value) {
  const url = normalizedUrl(value?.href || page?.url || '');
  const href = url?.href || '';
  const origin = url?.origin || '';
  const conversationId = conversationIdFromHref(href);
  const composerFound = value?.composerFound === true;
  const authLike = !!url && /\/(?:auth|login|signup)(?:\/|$)/i.test(url.pathname);
  const ready = !!url && composerFound && !authLike;
  const observation = {
    pageId: String(page?.pageId || ''),
    title: String(page?.title || ''),
    visible: page?.visible === true,
    href,
    origin,
    conversationId: conversationId || undefined,
    composerFound,
    composerRef: String(value?.composerRef || ''),
    composerText: String(value?.composerText || ''),
    composerAmbiguous: value?.composerAmbiguous === true,
    sendButtonRef: String(value?.sendButtonRef || ''),
    sendButtonAmbiguous: value?.sendButtonAmbiguous === true,
    streaming: value?.streaming === true,
    stopButtonRef: String(value?.stopButtonRef || ''),
    responseComplete: value?.responseComplete === true,
    assistantTexts: Array.isArray(value?.assistantTexts) ? value.assistantTexts.map(text => String(text)).slice(-80) : [],
    userTexts: Array.isArray(value?.userTexts) ? value.userTexts.map(text => String(text)).slice(-80) : [],
    assistantMessages: Array.isArray(value?.assistantMessages)
      ? value.assistantMessages.map(entry => ({ role: 'assistant', key: String(entry?.key || ''), text: String(entry?.text || '') })).slice(-80)
      : [],
    userMessages: Array.isArray(value?.userMessages)
      ? value.userMessages.map(entry => ({ role: 'user', key: String(entry?.key || ''), text: String(entry?.text || '') })).slice(-80)
      : [],
    messages: Array.isArray(value?.messages)
      ? value.messages
        .filter(entry => entry && (entry.role === 'user' || entry.role === 'assistant'))
        .map(entry => ({ role: entry.role, key: String(entry.key || ''), text: String(entry.text || '') }))
        .slice(-160)
      : [],
    ready,
  };
  return {
    ...observation,
    resourceIdentity: resourceIdentityFor(observation.pageId, observation),
    lifecycleIdentity: lifecycleIdentityFor(observation.pageId),
  };
}

function assertExactTarget(target, observation) {
  if (!target || typeof target !== 'object') throw new Error('ChatGPT exact target is missing.');
  const pageId = String(target.pageId || '').trim();
  const resourceIdentity = String(target.resourceIdentity || '').trim();
  const lifecycleIdentity = String(target.lifecycleIdentity || '').trim();
  if (!pageId || !resourceIdentity || !lifecycleIdentity) throw new Error('ChatGPT exact target requires pageId, resourceIdentity and lifecycleIdentity.');
  if (!observation || observation.pageId !== pageId) throw new Error(`Selected ChatGPT page disappeared: ${pageId}`);
  if (observation.resourceIdentity !== resourceIdentity) throw new Error(`Selected ChatGPT page identity changed: ${pageId}`);
  if (observation.lifecycleIdentity !== lifecycleIdentity) throw new Error(`Selected ChatGPT lifecycle identity changed: ${pageId}`);
  if (!observation.ready) throw new Error(`Selected ChatGPT page is not ready: ${observation.href || pageId}`);
  return observation;
}

module.exports = {
  CHATGPT_HOSTS,
  conversationIdFromHref,
  resourceIdentityFor,
  lifecycleIdentityFor,
  parseReadPageResult,
  buildObservationCode,
  buildInterruptCode,
  normalizeObservation,
  assertExactTarget,
};
