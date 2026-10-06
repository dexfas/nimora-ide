(function createShunCodeWebMcpSiteAdapter(env) {
  const { window, document, location, visible, storage } = env;
  const isDeepSeek = /(^|\.)deepseek\.com$/i.test(location.hostname);
  const isDeepSeekAuthPage = isDeepSeek && /^\/(?:sign_in|sign_up|forgot_password)(?:\/|$)/i.test(location.pathname);
  const sendStateKey = `shuncode-webmcp-send-state:${location.origin}`;
  let lastAutomaticSendAt = 0;
  let rateLimitCooldownUntil = 0;
  let rateLimitStrikes = 0;
  let recentAutomaticSendTimes = [];
  const deepSeekAssistantSelectors = ['[data-message-author-role="assistant"]', '[data-role="assistant"]', '[class*="assistant-message"]', '.ds-assistant-message-main-content'];
  const deepSeekUserSelectors = ['[data-message-author-role="user"]', '[data-role="user"]', '[class*="user-message"]', '.ds-message'];

  if (storage) {
    try {
      const state = JSON.parse(storage.getItem(sendStateKey) || '{}');
      lastAutomaticSendAt = Number(state.lastAutomaticSendAt || 0);
      rateLimitCooldownUntil = Number(state.rateLimitCooldownUntil || 0);
      rateLimitStrikes = Number(state.rateLimitStrikes || 0);
      recentAutomaticSendTimes = Array.isArray(state.recentAutomaticSendTimes)
        ? state.recentAutomaticSendTimes.map(Number).filter(Number.isFinite)
        : [];
    } catch {}
  }

  function persistSendState() {
    if (!storage) return;
    try {
      storage.setItem(sendStateKey, JSON.stringify({
        lastAutomaticSendAt,
        rateLimitCooldownUntil,
        rateLimitStrikes,
        recentAutomaticSendTimes: recentAutomaticSendTimes.slice(-8),
      }));
    } catch {}
  }

  function composerScore(element) {
    if (!visible(element) || element.disabled || element.readOnly) return -Infinity;
    const rect = element.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 18) return -Infinity;
    const attrs = [element.getAttribute('placeholder'), element.getAttribute('aria-label'), element.getAttribute('data-placeholder'), element.getAttribute('role'), element.className, element.id].filter(Boolean).join(' ').toLowerCase();
    let score = rect.top / Math.max(1, window.innerHeight) * 8;
    if (/ask|message|chat|prompt|type|send|reply|question|问|消息|输入|聊天|提问/.test(attrs)) score += 20;
    if (element.matches('textarea')) score += 10;
    if (element.isContentEditable) score += 8;
    if (element.closest('form')) score += 4;
    if (element.closest('main')) score += 3;
    return score;
  }

  function findComposer() {
    if (isDeepSeekAuthPage) return null;
    const selectors = ['textarea', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"][data-lexical-editor="true"]', '[contenteditable="true"]', 'input[type="text"]'];
    const candidates = [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))];
    return candidates.map(element => ({ element, score: composerScore(element) })).filter(item => Number.isFinite(item.score)).sort((a, b) => b.score - a.score)[0]?.element || null;
  }

  function assistantMessageCandidates() {
    const selectors = isDeepSeek
      ? deepSeekAssistantSelectors
      : ['[data-message-author-role="assistant"]', '[data-role="assistant"]', '[class*="assistant-message"]', '.ds-assistant-message-main-content', '.ds-message .md-code-block pre', 'main article', 'main pre', 'main code', 'main .prose'];
    const candidates = [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))]
      .filter(element => !element.isContentEditable && !['TEXTAREA', 'INPUT'].includes(element.tagName))
      .filter(element => !element.closest('[class*="bg-surface-raised"]'));
    return candidates
      .filter(element => !candidates.some(other => other !== element && other.contains(element)))
      .sort((a, b) => {
        if (a === b) return 0;
        const position = a.compareDocumentPosition(b);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
  }

  function assistantTextCandidates() {
    return assistantMessageCandidates().filter(element => (element.textContent || '').includes('[SHUNCODE_TOOL]'));
  }

  function deepSeekCodeChromeOnly(text) {
    const normalized = String(text || '').trim().toLowerCase();
    if (!normalized) return true;
    const remainder = normalized
      .replace(/(?:复制代码|复制|拷贝|copy(?:\s+code)?|下载|download)/gi, ' ')
      .replace(/\b(?:text|plaintext|plain\s*text|json|markdown|md|yaml|yml|xml|javascript|typescript|js|ts|python|py|bash|shell|sh)\b/gi, ' ')
      .replace(/[\s|·•:;/_\-]+/g, '');
    return remainder === '';
  }

  function deepSeekAssistantMessageText(element) {
    const clone = element?.cloneNode?.(true);
    if (!clone) return '';
    for (const node of clone.querySelectorAll?.('button,[role="button"],[role="toolbar"],[role="menu"],[role="menuitem"],svg,[aria-hidden="true"]') || []) {
      node.remove();
    }
    for (const pre of [...(clone.querySelectorAll?.('pre') || [])]) {
      const code = pre.querySelector?.('code') || pre;
      const codeText = String(code?.textContent ?? '');
      let wrapper = pre;
      while (wrapper.parentElement && wrapper.parentElement !== clone) {
        const siblingText = [...wrapper.parentElement.childNodes]
          .filter(node => node !== wrapper)
          .map(node => String(node.textContent || ''))
          .join('\n');
        if (!deepSeekCodeChromeOnly(siblingText)) break;
        wrapper = wrapper.parentElement;
      }
      wrapper.replaceWith(document.createTextNode('\n' + codeText + '\n'));
    }
    return String(clone.innerText || clone.textContent || '').trim();
  }

  function assistantMessageText(element) {
    if (isDeepSeek) return deepSeekAssistantMessageText(element);
    return String(element?.innerText || element?.textContent || '').trim();
  }

  function deepSeekVirtualItemInfo(element) {
    if (!isDeepSeek || !element) return null;
    const matches = [];
    let node = element;
    for (let depth = 0; node && depth < 16; depth += 1, node = node.parentElement) {
      if (!node.hasAttribute?.('data-virtual-list-item-key')) continue;
      const raw = String(node.getAttribute('data-virtual-list-item-key') || '').trim();
      if (!/^(?:0|-?[1-9]\d*)$/.test(raw)) return null;
      const order = Number(raw);
      if (!Number.isSafeInteger(order)) return null;
      matches.push({ id: raw, order, element: node });
    }
    if (matches.length !== 1) return null;
    return matches[0];
  }

  function domOrder(a, b) {
    if (a === b) return 0;
    const position = a.compareDocumentPosition(b);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }

  function deepestUniqueCandidate(candidates) {
    const leaves = candidates.filter(candidate => !candidates.some(other => other !== candidate && candidate.contains(other)));
    return leaves.length === 1 ? leaves[0] : null;
  }

  function deepSeekUserEntryState() {
    if (!isDeepSeek) return { valid: true, entries: [] };
    const raw = [...new Set(deepSeekUserSelectors.flatMap(selector => [...document.querySelectorAll(selector)]))]
      .filter(element => !element.isContentEditable && !['TEXTAREA', 'INPUT'].includes(element.tagName))
      .filter(element => !element.closest('[class*="bg-surface-raised"]'));
    const buckets = new Map();
    for (const element of raw) {
      const info = deepSeekVirtualItemInfo(element);
      if (!info) {
        if (element.matches?.('[data-message-author-role="user"], [data-role="user"], [class*="user-message"]')) {
          return { valid: false, reason: 'user-message-missing-stable-identity', entries: [] };
        }
        continue;
      }
      if (deepSeekAssistantSelectors.some(selector => info.element.matches?.(selector) || info.element.querySelector?.(selector))) continue;
      const bucket = buckets.get(info.id) || { info, explicit: [], fallback: [] };
      if (element.matches?.('[data-message-author-role="user"], [data-role="user"], [class*="user-message"]')) bucket.explicit.push(element);
      else if (element.matches?.('.ds-message')) bucket.fallback.push(element);
      buckets.set(info.id, bucket);
    }
    const entries = [];
    for (const bucket of buckets.values()) {
      const preferred = bucket.explicit.length ? bucket.explicit : bucket.fallback;
      const element = deepestUniqueCandidate(preferred);
      if (!element) return { valid: false, reason: 'user-message-identity-ambiguous', entries: [] };
      entries.push({
        identity: 'deepseek-item:' + bucket.info.id,
        rawId: bucket.info.id,
        item: bucket.info.element,
        element,
        text: String(element.textContent ?? element.innerText ?? ''),
      });
    }
    entries.sort((a, b) => domOrder(a.item, b.item));
    return { valid: true, entries };
  }

  function userMessageCandidates() {
    const state = deepSeekUserEntryState();
    return state.valid ? state.entries.map(entry => entry.element) : [];
  }

  function userMessageText(element) {
    return String(element?.textContent ?? element?.innerText ?? '');
  }

  function userMessageIdentity(element) {
    const info = deepSeekVirtualItemInfo(element);
    return info ? 'deepseek-item:' + info.id : '';
  }

  function providerUserBoundary() {
    if (!isDeepSeek) return null;
    const users = deepSeekUserEntryState();
    if (!users.valid) return { valid: false, reason: users.reason || 'user-message-boundary-invalid' };
    const semantic = [];
    for (const assistant of assistantMessageCandidates()) {
      const info = deepSeekVirtualItemInfo(assistant);
      if (!info) return { valid: false, reason: 'assistant-message-missing-stable-identity' };
      semantic.push({ identity: 'deepseek-item:' + info.id, role: 'assistant', item: info.element, text: assistantMessageText(assistant) });
    }
    for (const user of users.entries) semantic.push({ identity: user.identity, role: 'user', item: user.item, text: user.text });
    semantic.sort((a, b) => domOrder(a.item, b.item));
    const identities = semantic.map(entry => entry.identity);
    if (new Set(identities).size !== identities.length) return { valid: false, reason: 'provider-message-identity-ambiguous' };
    return {
      valid: true,
      origin: String(location.origin || ''),
      pathname: String(location.pathname || ''),
      identities,
      roles: Object.fromEntries(semantic.map(entry => [entry.identity, entry.role])),
      userTexts: Object.fromEntries(users.entries.map(entry => [entry.identity, entry.text])),
      tailIdentity: semantic.at(-1)?.identity || '',
    };
  }

  function observeProviderUserAdmission(baseline, expectedText) {
    if (!isDeepSeek || !baseline || baseline.valid !== true) {
      return { status: 'rejected', reason: 'provider-user-baseline-invalid' };
    }
    const current = providerUserBoundary();
    if (!current || current.valid !== true) return { status: 'rejected', reason: current?.reason || 'provider-user-boundary-invalid' };
    if (current.origin !== baseline.origin) return { status: 'rejected', reason: 'provider-conversation-origin-drift' };
    if (current.pathname !== baseline.pathname) {
      const baselineIsFreshRoot = baseline.identities.length === 0 && /^(?:\/|\/chat\/?)$/.test(baseline.pathname);
      const currentIsConversation = /^\/a\/chat\/(?:s\/)?[^/]+/.test(current.pathname);
      if (!baselineIsFreshRoot || !currentIsConversation) return { status: 'rejected', reason: 'provider-conversation-lineage-drift' };
    }
    for (const [identity, text] of Object.entries(baseline.userTexts || {})) {
      if (Object.prototype.hasOwnProperty.call(current.userTexts || {}, identity) && current.userTexts[identity] !== text) {
        return { status: 'rejected', reason: 'historical-user-message-text-changed' };
      }
    }
    let anchorIdentity = baseline.tailIdentity || '';
    let anchorIndex = anchorIdentity ? current.identities.indexOf(anchorIdentity) : -1;
    if (anchorIdentity && anchorIndex < 0) {
      // DeepSeek virtualizes and sometimes remounts the assistant tool-call
      // bubble while the result composer is being submitted. Its DOM identity
      // is not durable enough to be the only admission anchor. Fall back ONLY
      // to the last identical, still-rendered historical USER bubble. That
      // bubble has an exact stable identity and verified unchanged text above.
      // A missing user anchor is not proof of admission and cannot authorize
      // another submit gesture or a new provider turn.
      const stableUserAnchor = baseline.roles?.[baseline.tailIdentity] === 'assistant'
        ? [...baseline.identities].reverse().find(id => baseline.roles?.[id] === 'user'
          && Object.prototype.hasOwnProperty.call(baseline.userTexts || {}, id))
        : '';
      const stableIndex = stableUserAnchor ? current.identities.indexOf(stableUserAnchor) : -1;
      if (stableIndex < 0) return { status: 'pending', reason: 'provider-conversation-boundary-unverifiable' };
      anchorIdentity = stableUserAnchor;
      anchorIndex = stableIndex;
    }
    const baselineIdentities = new Set(baseline.identities || []);
    const newUsers = Object.entries(current.userTexts || {})
      .filter(([identity]) => !baselineIdentities.has(identity))
      .map(([identity, text]) => ({ identity, text, order: current.identities.indexOf(identity) }))
      .filter(entry => !anchorIdentity || entry.order > anchorIndex);
    if (newUsers.length > 1) {
      return {
        status: 'rejected',
        reason: 'multiple-new-provider-user-identities',
        candidates: newUsers.map(entry => ({ identity: entry.identity, text: entry.text, order: entry.order })),
      };
    }
    if (!newUsers.length) return { status: 'pending', reason: 'no-new-provider-user-identity' };
    const admitted = newUsers[0];
    if (admitted.order < 0) return { status: 'rejected', reason: 'provider-user-order-ambiguous' };
    if (current.roles?.[admitted.identity] !== 'user') return { status: 'rejected', reason: 'provider-user-role-ambiguous' };
    if (admitted.text !== String(expectedText ?? '')) return { status: 'rejected', reason: 'provider-user-text-mismatch', identity: admitted.identity };
    return { status: 'admitted', identity: admitted.identity, text: admitted.text,
      order: admitted.order, anchor: anchorIdentity === baseline.tailIdentity ? 'original-tail' : 'stable-user' };
  }

  // Bounded diagnostic facts only; no prompt, conversation URL or authority.
  function providerUserAdmissionDiagnostics() {
    const candidates = [...new Set(deepSeekUserSelectors.flatMap(selector => [...document.querySelectorAll(selector)]))];
    const users = deepSeekUserEntryState();
    return {
      documentVisibility: String(document.visibilityState || 'unknown'),
      rawUserCandidates: candidates.length,
      filteredUserCandidates: candidates.filter(element => element.isContentEditable
        || ['TEXTAREA', 'INPUT'].includes(element.tagName)
        || !!element.closest('[class*="bg-surface-raised"]')).length,
      stableUserMessages: users.valid ? users.entries.length : 0,
      userBoundaryValid: users.valid,
      userBoundaryReason: users.reason || '',
      assistantCandidates: assistantMessageCandidates().length,
    };
  }

  function assistantMessageIdentity(element) {
    const info = deepSeekVirtualItemInfo(element);
    return info ? 'deepseek-item:' + info.id : '';
  }

  function assistantMessageOrder(element) {
    const order = deepSeekVirtualItemInfo(element)?.order;
    return Number.isSafeInteger(order) && order >= 0 ? order : null;
  }

  function conversationItemBoundary() {
    if (!isDeepSeek) return null;
    const assistants = assistantMessageCandidates();
    if (!assistants.length) return { valid: true, order: -1, assistantCount: 0 };
    let order = -1;
    const seenItems = new Set();
    for (const assistant of assistants) {
      const info = deepSeekVirtualItemInfo(assistant);
      if (!info || info.order < 0) return { valid: false, order: null, assistantCount: assistants.length };
      if (seenItems.has(info.id)) continue;
      seenItems.add(info.id);
      order = Math.max(order, info.order);
    }
    return { valid: true, order, assistantCount: seenItems.size };
  }

  function generationStopButton() {
    const pattern = /^(stop|stop generating|cancel generation|停止|停止生成|停止回答|中止)$/i;
    return [...document.querySelectorAll('button')].find(button => {
      if (!visible(button) || button.disabled) return false;
      const text = String(button.getAttribute('aria-label') || button.title || button.textContent || '').trim();
      return pattern.test(text);
    }) || null;
  }

  function isResponseStreaming() {
    return !!generationStopButton();
  }

  async function interruptGeneration() {
    const button = generationStopButton();
    if (!button) return false;
    button.click();
    return true;
  }

  function laneKeyFor(element) {
    let node = element;
    for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
      const text = String(node.innerText || '').slice(0, 260);
      if (/回复\s*A|response\s*A/i.test(text)) return 'A';
      if (/回复\s*B|response\s*B/i.test(text)) return 'B';
    }
    return '';
  }

  function deepSeekRateLimitNotices() {
    if (!isDeepSeek) return [];
    const pattern = /消息发送过于频繁.*稍后重试|rate[ _-]?limit(?:ed| reached|_reached)|too many requests|sending requests too quickly/i;
    return [...document.querySelectorAll('div, span, p')].filter(element => {
      if (!visible(element)) return false;
      const text = String(element.textContent || '').trim();
      if (!text || text.length > 160 || !pattern.test(text)) return false;
      const rect = element.getBoundingClientRect();
      return rect.bottom >= 0 && rect.top <= window.innerHeight;
    });
  }

  function deepSeekSendFailureNotices() {
    if (!isDeepSeek) return [];
    const pattern = /消息发送过于频繁.*稍后重试|发送失败|网络错误|服务器错误|请(?:稍后)?重试|rate[ _-]?limit(?:ed| reached|_reached)|too many requests|send failed|network error|server error|please try again|try again(?: later)?|retry (?:later|after|in \d+)/i;
    const semanticMessageSelector = '[data-message-author-role="user"], [data-role="user"], [class*="user-message"], .ds-message, [data-message-author-role="assistant"], [data-role="assistant"], [class*="assistant-message"], .ds-assistant-message-main-content';
    return [...document.querySelectorAll('div, span, p')].filter(element => {
      if (!visible(element)) return false;
      if (element.closest(semanticMessageSelector) || element.matches?.(semanticMessageSelector) || element.querySelector?.(semanticMessageSelector)) return false;
      const text = String(element.textContent || '').trim();
      if (!text || text.length > 240 || !pattern.test(text)) return false;
      const rect = element.getBoundingClientRect();
      return rect.bottom >= 0 && rect.top <= window.innerHeight;
    });
  }

  async function beforeAutomaticSend() {
    // Preserve the current fast round-trip behavior. This hook remains owned by
    // the site adapter so future DeepSeek pacing changes do not leak into Core.
  }

  function captureRateLimitNotices() {
    return new Set(deepSeekSendFailureNotices());
  }

  function onAutomaticSendAttempt() {
    if (!isDeepSeek) return;
    lastAutomaticSendAt = Date.now();
    persistSendState();
  }

  async function verifyAcceptedSend(previousNotices) {
    if (!isDeepSeek) return;
    const previous = previousNotices instanceof Set ? previousNotices : new Set();
    const freshFailure = deepSeekSendFailureNotices().find(element => !previous.has(element));
    if (freshFailure) {
      throw new Error(`DeepSeek provider reported a send failure before exact user-message admission: ${String(freshFailure.textContent || '').trim().slice(0, 200)}`);
    }
  }

  function transportRule() {
    return isDeepSeek
      ? `DEEPSEEK TRANSPORT RULE: Do NOT use an outer JSON tool-call object. When a tool is needed, reply with exactly ONE FOUR-BACKTICK text fence and no prose. Inside the fence use the line protocol below:\n\`\`\`\`text\n[SHUNCODE_TOOL]\nid=unique-call-id\nname=TOOL_NAME\narg.path=.\narg.depth=1\n[/SHUNCODE_TOOL]\n\`\`\`\`\nThe entire request must stay inside this plain-text code fence: ordinary Markdown rendering can remove patch prefixes, context indentation, lists and HTML. Use one arg.<name>=<value> line per argument. Use dotted paths for nested values and numeric indexes for arrays, for example arg.files.0.path=README.md. Numbers and booleans should be unquoted. For an object with literal file-path keys, use a JSON value on one argument line, for example arg.expected_versions={"README.md":"sha256:FULL_RETURNED_HASH"}; never split filename dots into nested argument paths. For a multiline string use arg.patch<<SHUNCODE_EOF on one line, then the exact multiline value, then SHUNCODE_EOF on its own line. Every patch hunk line must retain its literal leading space, '+' or '-'; blank added lines use '+'. Use a longer outer fence if the value contains four consecutive backticks. Always include [/SHUNCODE_TOOL]. Wait for [SHUNCODE_TOOL_RESULT] before continuing.`
      : `IMPORTANT TRANSPORT RULE: Chat renderers can corrupt JSON, quotes, backslashes, HTML and patch text unless the entire tool request is inside a code fence. Whenever a tool is needed, reply with exactly ONE FOUR-BACKTICK text fence and no prose. Inside that outer fence put exactly this request format:\n\n\`\`\`\`text\n[SHUNCODE_TOOL]\n{"id":"unique-call-id","name":"TOOL_NAME","arguments":{}}\n[/SHUNCODE_TOOL]\n\`\`\`\`\n\nDo not omit the outer four-backtick fence. Do not omit [/SHUNCODE_TOOL]. Keep JSON valid and preserve all backslashes exactly. Wait for [SHUNCODE_TOOL_RESULT] before continuing.`;
  }

  return {
    id: isDeepSeek ? 'deepseek' : 'generic',
    isDeepSeek,
    isDeepSeekAuthPage,
    findComposer,
    assistantMessageCandidates,
    assistantMessageText,
    assistantTextCandidates,
    assistantMessageIdentity,
    assistantMessageOrder,
    conversationItemBoundary,
    userMessageCandidates,
    userMessageText,
    userMessageIdentity,
    providerUserBoundary,
    observeProviderUserAdmission,
    providerUserAdmissionDiagnostics,
    isResponseStreaming,
    interruptGeneration,
    laneKeyFor,
    deepSeekRateLimitNotices,
    beforeAutomaticSend,
    captureRateLimitNotices,
    onAutomaticSendAttempt,
    verifyAcceptedSend,
    pacingMode: isDeepSeek ? 'disabled-user-preference' : 'not-applicable',
    transportRule,
  };
})
