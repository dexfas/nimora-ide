(function createShunCodeWebMcpSiteAdapter(env) {
  const { window, document, location, visible, storage } = env;
  const isDeepSeek = /(^|\.)deepseek\.com$/i.test(location.hostname);
  const isDeepSeekAuthPage = isDeepSeek && /^\/(?:sign_in|sign_up|forgot_password)(?:\/|$)/i.test(location.pathname);
  const sendStateKey = `shuncode-webmcp-send-state:${location.origin}`;
  let lastAutomaticSendAt = 0;
  let rateLimitCooldownUntil = 0;
  let rateLimitStrikes = 0;
  let recentAutomaticSendTimes = [];

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
    const selectors = ['[data-message-author-role="assistant"]', '[data-role="assistant"]', '[class*="assistant-message"]', '.ds-assistant-message-main-content', '.ds-message .md-code-block pre', 'main article', 'main pre', 'main code', 'main .prose'];
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

  function assistantMessageText(element) {
    return String(element?.innerText || element?.textContent || '').trim();
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

  async function beforeAutomaticSend() {
    // Preserve the current fast round-trip behavior. This hook remains owned by
    // the site adapter so future DeepSeek pacing changes do not leak into Core.
  }

  function captureRateLimitNotices() {
    return new Set(deepSeekRateLimitNotices());
  }

  function onAutomaticSendAttempt() {
    if (!isDeepSeek) return;
    lastAutomaticSendAt = Date.now();
    persistSendState();
  }

  async function verifyAcceptedSend(_previousNotices) {
    // Current policy deliberately performs no automatic post-send delay/retry.
    // DeepSeek's UI remains authoritative for a user-visible rate-limit retry.
  }

  function transportRule() {
    return isDeepSeek
      ? `DEEPSEEK TRANSPORT RULE: Do NOT use JSON and do NOT use a Markdown code fence for tool requests. When a tool is needed, reply with exactly one block and no prose:\n[SHUNCODE_TOOL]\nid=unique-call-id\nname=TOOL_NAME\narg.path=.\narg.depth=1\n[/SHUNCODE_TOOL]\nUse one arg.<name>=<value> line per argument. Use dotted paths for nested values and numeric indexes for arrays, for example arg.files.0.path=README.md. Numbers and booleans should be unquoted. For a multiline string use arg.patch<<SHUNCODE_EOF on one line, then the exact multiline value, then SHUNCODE_EOF on its own line. Always include [/SHUNCODE_TOOL]. Wait for [SHUNCODE_TOOL_RESULT] before continuing.`
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
