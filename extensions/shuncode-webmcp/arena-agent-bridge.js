(function shunCodeWebMcpAgent(config) {
  if (!config || !config.bridge || !config.token) throw new Error('Missing ShunCode Web MCP config');
  const BRIDGE = String(config.bridge).replace(/\/$/, '');
  const TOKEN = String(config.token);
  if (window.__shuncodeWebMcp?.version === 24 && window.__shuncodeWebMcp?.matchesConfig?.(BRIDGE, TOKEN)) {
    return window.__shuncodeWebMcp.status();
  }
  try { window.__shuncodeWebMcp?.stop?.(); } catch {}

  const PRIME_CONTEXT_MARKER = 'SHUNCODE_WEBMCP_CONTEXT_V24';
  const pageSessionStorageKey = 'shuncode-webmcp-page-session-id';
  let pageSessionId = '';
  try {
    pageSessionId = sessionStorage.getItem(pageSessionStorageKey) || '';
    if (!pageSessionId) {
      pageSessionId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(pageSessionStorageKey, pageSessionId);
    }
  } catch {
    pageSessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  const seen = new Set();
  const pendingDeliveries = new Map();
  const seenStorageKey = `shuncode-webmcp-seen:${location.origin}${location.pathname}`;
  const isDeepSeek = /(^|\.)deepseek\.com$/i.test(location.hostname);
  const isDeepSeekAuthPage = isDeepSeek && /^\/(?:sign_in|sign_up|forgot_password)(?:\/|$)/i.test(location.pathname);
  const sendStateKey = `shuncode-webmcp-send-state:${location.origin}`;
  let enabled = true;
  let busy = false;
  let primed = false;
  let lockedLane = '';
  let scanTimer = null;
  let scanTimerDue = 0;
  let scanRequestedWhileBusy = false;
  let lastScanAt = 0;
  let lastHandledCallKey = '';
  let lastDeliveryError = '';
  const responseWatchTimers = new Set();
  let lastAutomaticSendAt = 0;
  let rateLimitCooldownUntil = 0;
  let rateLimitStrikes = 0;
  let recentAutomaticSendTimes = [];

  const short = (value, max = 12000) => String(value ?? '').slice(0, max);
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function scheduleScan(delayMs = 0) {
    if (!enabled) return;
    const due = Date.now() + Math.max(0, Number(delayMs) || 0);
    if (scanTimer && scanTimerDue <= due) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimerDue = due;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      scanTimerDue = 0;
      scan();
    }, Math.max(0, due - Date.now()));
  }

  function armResponseScanBurst() {
    for (const delay of [350, 900, 1800, 3500, 6000, 10000]) {
      const timer = setTimeout(() => {
        responseWatchTimers.delete(timer);
        scheduleScan(0);
      }, delay);
      responseWatchTimers.add(timer);
    }
  }

  try {
    const state = JSON.parse(sessionStorage.getItem(sendStateKey) || '{}');
    lastAutomaticSendAt = Number(state.lastAutomaticSendAt || 0);
    rateLimitCooldownUntil = Number(state.rateLimitCooldownUntil || 0);
    rateLimitStrikes = Number(state.rateLimitStrikes || 0);
    recentAutomaticSendTimes = Array.isArray(state.recentAutomaticSendTimes)
      ? state.recentAutomaticSendTimes.map(Number).filter(Number.isFinite)
      : [];
  } catch {}

  function persistSendState() {
    try {
      sessionStorage.setItem(sendStateKey, JSON.stringify({
        lastAutomaticSendAt,
        rateLimitCooldownUntil,
        rateLimitStrikes,
        recentAutomaticSendTimes: recentAutomaticSendTimes.slice(-8),
      }));
    } catch {}
  }

  function trimRecentAutomaticSends(now = Date.now()) {
    recentAutomaticSendTimes = recentAutomaticSendTimes.filter(timestamp => now - timestamp < 30000);
  }

  function deepSeekAdaptiveIntervalMs(now = Date.now()) {
    if (!isDeepSeek) return 0;
    trimRecentAutomaticSends(now);
    if (recentAutomaticSendTimes.length <= 1) return 3000;
    if (recentAutomaticSendTimes.length === 2) return 4500;
    return 6000;
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

  async function waitForAutomaticSendWindow() {
    // v12: user explicitly prefers the original fast chat round-trip behavior.
    // Keep this hook so pacing can be reintroduced later without touching sendMessage,
    // but do not impose any automatic delay now.
    return;
  }

  function recordDeepSeekRateLimit() {
    if (!isDeepSeek) return;
    rateLimitStrikes = Math.min(3, rateLimitStrikes + 1);
    const cooldownMs = Math.min(120000, 30000 * (2 ** (rateLimitStrikes - 1)));
    rateLimitCooldownUntil = Date.now() + cooldownMs;
    persistSendState();
    console.warn(`[ShunCode Web MCP] DeepSeek rate limit detected; cooling down for ${cooldownMs}ms.`);
  }

  function recordSuccessfulDeepSeekSend() {
    if (!isDeepSeek) return;
    const now = Date.now();
    lastAutomaticSendAt = now;
    trimRecentAutomaticSends(now);
    recentAutomaticSendTimes.push(now);
    if (rateLimitStrikes > 0 && now >= rateLimitCooldownUntil) rateLimitStrikes -= 1;
    if (rateLimitStrikes === 0) rateLimitCooldownUntil = 0;
    persistSendState();
  }

  async function verifyDeepSeekAcceptedSend(previousNotices) {
    // v12: do not add a post-send wait. If DeepSeek rejects a message for rate
    // limiting, its own UI retry control remains available to the user.
    return;
  }

  async function request(path, options = {}) {
    const response = await fetch(`${BRIDGE}${path}`, {
      ...options,
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        'x-shuncode-webmcp-token': TOKEN,
        ...(options.headers || {}),
      },
    });
    const body = await response.json();
    if (!response.ok || body?.ok === false) throw new Error(body?.error || `Web MCP bridge HTTP ${response.status}`);
    return body;
  }

  async function fetchTools() {
    const body = await request('/webmcp/tools');
    return Array.isArray(body.tools) ? body.tools : [];
  }

  async function invokeTool(name, args) {
    const body = await request('/webmcp/invoke', {
      method: 'POST',
      body: JSON.stringify({
        name,
        arguments: args || {},
        page: {
          sessionId: pageSessionId,
          origin: location.origin,
          href: location.href,
        },
      }),
    });
    return body.result;
  }

  function visible(element) {
    return !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
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

  function findResumeWorkButton() {
    return [...document.querySelectorAll('button')].find(button => {
      if (!visible(button) || button.disabled) return false;
      const text = String(button.textContent || button.getAttribute('aria-label') || '').trim();
      return /^(继续工作|继续处理|continue working|continue work|keep working)$/i.test(text);
    }) || null;
  }

  async function ensureComposer() {
    let composer = findComposer();
    if (composer) return composer;
    const resume = findResumeWorkButton();
    if (resume) {
      resume.click();
      const deadline = Date.now() + 6000;
      while (Date.now() < deadline) {
        await sleep(150);
        composer = findComposer();
        if (composer) return composer;
      }
    }
    throw new Error('No compatible chat input found');
  }

  function setComposerText(element, text) {
    if (!element) throw new Error('Chat composer not found');
    element.focus();
    if ('value' in element) {
      const prototype = element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      setter ? setter.call(element, text) : (element.value = text);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, text); } catch {}
      if (!inserted) element.textContent = text;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function composerText(element) {
    if (!element) return '';
    return 'value' in element ? String(element.value || '') : String(element.textContent || '');
  }

  function findSendButton(composer) {
    const rect = composer.getBoundingClientRect();
    const candidates = [...document.querySelectorAll('button')].map(button => {
      if (!visible(button) || button.disabled) return { button, score: -Infinity };
      const label = String(button.getAttribute('aria-label') || '').trim().toLowerCase();
      const title = String(button.title || '').trim().toLowerCase();
      const text = String(button.textContent || '').trim().toLowerCase();
      const attrs = `${label} ${title} ${text}`;
      let score = 0;
      if (/^(send message|send|发送|提交)$/.test(label) || /^(send message|send|发送|提交)$/.test(text)) score += 100;
      else if (/send|submit|message|发送|提交/.test(attrs)) score += 40;
      if (button.type === 'submit') score += 20;
      if (button.closest('form') && button.closest('form') === composer.closest('form')) score += 25;
      const buttonRect = button.getBoundingClientRect();
      score -= Math.min((Math.abs(buttonRect.top - rect.top) + Math.abs(buttonRect.left - rect.right)) / 80, 20);
      return { button, score };
    }).filter(item => item.score > 5).sort((a, b) => b.score - a.score);
    return candidates[0]?.button || null;
  }

  function outboundToolResultId(text) {
    if (!/^\s*\[SHUNCODE_TOOL_RESULT\]/.test(String(text || ''))) return '';
    return String(text || '').match(/"id"\s*:\s*"([^"]+)"/)?.[1] || '';
  }

  function completedResultCountForId(id) {
    if (!id) return 0;
    return extractCompletedCallCounts(document.body?.innerText || '').get(String(id)) || 0;
  }

  async function waitForMessageSubmission(composer, expected, resultId = '', resultCountBaseline = 0, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(120);
      if (!document.contains(composer)) return true;
      if (composerText(composer) !== expected) return true;
      // DeepSeek can accept a message before it clears/replaces the composer.
      // If the corresponding tool-result block has appeared in chat, treat
      // that as positive submission evidence and do not retry the send.
      if (resultId && completedResultCountForId(resultId) > resultCountBaseline) return true;
    }
    return false;
  }

  async function submitComposer(composer) {
    await sleep(220);
    const sendButton = findSendButton(composer);
    if (sendButton) return sendButton.click();
    const form = composer.closest('form');
    if (form && typeof form.requestSubmit === 'function') return form.requestSubmit();
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  }

  async function sendMessage(text) {
    await waitForAutomaticSendWindow();
    const previousRateLimitNotices = new Set(deepSeekRateLimitNotices());
    const composer = await ensureComposer();
    const existing = composerText(composer);
    if (existing && existing !== text) {
      if (/^\s*\[SHUNCODE_TOOL_RESULT\]/.test(existing) || /^\s*You have LIVE access to the user's ShunCode workspace/.test(existing)) {
        setComposerText(composer, '');
        await sleep(80);
      } else {
        throw new Error('Chat composer contains user text; Web MCP refused to overwrite it');
      }
    }
    setComposerText(composer, text);
    const resultId = outboundToolResultId(text);
    const resultCountBaseline = resultId ? completedResultCountForId(resultId) : 0;
    if (isDeepSeek) {
      lastAutomaticSendAt = Date.now();
      persistSendState();
    }
    await submitComposer(composer);
    if (await waitForMessageSubmission(composer, text, resultId, resultCountBaseline, 5000)) {
      await verifyDeepSeekAcceptedSend(previousRateLimitNotices);
      return;
    }

    const form = composer.closest('form');
    if (form && typeof form.requestSubmit === 'function') {
      try { form.requestSubmit(); } catch {}
      if (await waitForMessageSubmission(composer, text, resultId, resultCountBaseline, 2500)) {
        await verifyDeepSeekAcceptedSend(previousRateLimitNotices);
        return;
      }
    }

    const current = findComposer() || composer;
    if (composerText(current) === text) setComposerText(current, '');
    throw new Error('Chat message submission was not confirmed; cleared unsent Web MCP text');
  }

  function toolResultText(result) {
    if (result == null) return 'null';
    if (Array.isArray(result.content)) {
      const text = result.content.map(part => part?.text ?? part?.value ?? '').filter(Boolean).join('\n');
      if (text) return short(text, 10000);
    }
    try { return short(JSON.stringify(result, null, 2), 10000); }
    catch { return short(result, 10000); }
  }

  async function sendToolResult(call, result, error) {
    const payload = error ? { id: call.id || null, name: call.name, ok: false, error: short(error?.message || error, 5000) } : { id: call.id || null, name: call.name, ok: true, result: toolResultText(result) };
    await sendMessage(`[SHUNCODE_TOOL_RESULT]\n${JSON.stringify(payload, null, 2)}\n[/SHUNCODE_TOOL_RESULT]\nContinue the task. If another tool is needed, request exactly one tool and wait for its result.`);
    armResponseScanBurst();
  }

  function parseJsonObjectAt(text, startIndex) {
    const start = text.indexOf('{', startIndex);
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          const raw = text.slice(start, index + 1);
          try { return { value: JSON.parse(raw), endIndex: index + 1 }; }
          catch { return null; }
        }
      }
    }
    return null;
  }

  function parseToolJsonObject(text, markerIndex, markerLength) {
    const parsed = parseJsonObjectAt(text, markerIndex + markerLength);
    if (parsed) return parsed;

    // DeepSeek occasionally renders a completed tool fence with one or more
    // trailing object braces missing, especially for very large apply_patch
    // payloads. Only attempt repair once the explicit closing tool marker is
    // present, so streaming/incomplete responses can never execute early.
    const closeMarkerIndex = text.indexOf('[/SHUNCODE_TOOL]', markerIndex + markerLength);
    if (closeMarkerIndex < 0) return null;
    const start = text.indexOf('{', markerIndex + markerLength);
    if (start < 0 || start >= closeMarkerIndex) return null;

    const raw = text.slice(start, closeMarkerIndex).trim();
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = 0; index < raw.length; index += 1) {
      const char = raw[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      if (depth < 0) return null;
    }
    if (inString || depth < 1 || depth > 3) return null;

    const repaired = raw + '}'.repeat(depth);
    try {
      return { value: JSON.parse(repaired), endIndex: closeMarkerIndex, repairedTrailingBraces: depth };
    } catch {
      return null;
    }
  }

  function parseLineScalar(value) {
    const text = String(value ?? '').trim();
    if (text === 'true') return true;
    if (text === 'false') return false;
    if (text === 'null') return null;
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return Number(text);
    if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
      try { return JSON.parse(text); } catch {}
    }
    return text;
  }

  function setLineArgument(target, dottedPath, value) {
    const parts = String(dottedPath || '').split('.').filter(Boolean);
    if (!parts.length) return;
    let current = target;
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const key = /^\d+$/.test(part) ? Number(part) : part;
      if (index === parts.length - 1) {
        current[key] = value;
        return;
      }
      const nextIsArray = /^\d+$/.test(parts[index + 1]);
      if (!current[key] || typeof current[key] !== 'object') current[key] = nextIsArray ? [] : {};
      current = current[key];
    }
  }

  function parseToolLineObject(text, markerIndex, markerLength) {
    const closeMarker = '[/SHUNCODE_TOOL]';
    const closeMarkerIndex = text.indexOf(closeMarker, markerIndex + markerLength);
    if (closeMarkerIndex < 0) return null;
    const raw = text.slice(markerIndex + markerLength, closeMarkerIndex).trim();
    if (!raw || raw.startsWith('{')) return null;

    const lines = raw.split(/\r?\n/);
    const call = { arguments: {} };
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].trim();
      if (!line) continue;
      const heredoc = line.match(/^arg\.([A-Za-z0-9_.-]+)<<([A-Za-z0-9_-]+)$/);
      if (heredoc) {
        const [, dottedPath, terminator] = heredoc;
        const chunks = [];
        let closed = false;
        for (index += 1; index < lines.length; index += 1) {
          if (lines[index].trim() === terminator) {
            closed = true;
            break;
          }
          chunks.push(lines[index]);
        }
        if (!closed) return null;
        setLineArgument(call.arguments, dottedPath, chunks.join('\n'));
        continue;
      }
      const pair = line.match(/^(id|name|arg\.([A-Za-z0-9_.-]+))=(.*)$/);
      if (!pair) continue;
      if (pair[1] === 'id') call.id = pair[3].trim();
      else if (pair[1] === 'name') call.name = pair[3].trim();
      else setLineArgument(call.arguments, pair[2], parseLineScalar(pair[3]));
    }
    if (typeof call.name !== 'string' || !call.name) return null;
    return { value: call, endIndex: closeMarkerIndex + closeMarker.length, lineProtocol: true };
  }

  function parseToolObject(text, markerIndex, markerLength) {
    return parseToolJsonObject(text, markerIndex, markerLength)
      || parseToolLineObject(text, markerIndex, markerLength);
  }

  function extractCalls(text) {
    const calls = [];
    const markers = ['[SHUNCODE_TOOL]', '```SHUNCODE_TOOL'];
    for (const marker of markers) {
      let fromIndex = 0;
      while (fromIndex < text.length) {
        const markerIndex = text.indexOf(marker, fromIndex);
        if (markerIndex < 0) break;
        const parsed = parseToolObject(text, markerIndex, marker.length);
        fromIndex = parsed?.endIndex || markerIndex + marker.length;
        const call = parsed?.value;
        if (!call || typeof call.name !== 'string') continue;
        if (call.name === '__example__' || call.name === 'TOOL_NAME' || String(call.id || '').startsWith('example-')) continue;
        calls.push(call);
      }
    }
    return calls;
  }

  function extractCompletedCallCounts(text) {
    const counts = new Map();
    const marker = '[SHUNCODE_TOOL_RESULT]';
    let fromIndex = 0;
    while (fromIndex < text.length) {
      const markerIndex = text.indexOf(marker, fromIndex);
      if (markerIndex < 0) break;
      const parsed = parseJsonObjectAt(text, markerIndex + marker.length);
      fromIndex = parsed?.endIndex || markerIndex + marker.length;
      const id = parsed?.value?.id;
      if (id != null) {
        const key = String(id);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    return counts;
  }

  function assistantTextCandidates() {
    const selectors = ['[data-message-author-role="assistant"]', '[data-role="assistant"]', '[class*="assistant-message"]', '.ds-assistant-message-main-content', '.ds-message .md-code-block pre', 'main article', 'main pre', 'main code', 'main .prose'];
    const candidates = [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))]
      .filter(element => !element.isContentEditable && !['TEXTAREA', 'INPUT'].includes(element.tagName))
      .filter(element => !element.closest('[class*="bg-surface-raised"]'))
      .filter(element => (element.textContent || '').includes('[SHUNCODE_TOOL]'));
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

  function callBaseKey(call) {
    return String(call.id || `${call.name}:${JSON.stringify(call.arguments || {})}`);
  }

  function toolCallOccurrences() {
    const counts = new Map();
    const occurrences = [];
    for (const element of assistantTextCandidates()) {
      const laneKey = laneKeyFor(element);
      for (const call of extractCalls(element.innerText || element.textContent || '')) {
        const baseKey = callBaseKey(call);
        const ordinal = (counts.get(baseKey) || 0) + 1;
        counts.set(baseKey, ordinal);
        occurrences.push({ call, laneKey, baseKey, ordinal, key: `${baseKey}::occurrence:${ordinal}` });
      }
    }
    return occurrences;
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

  async function deliverPending(key, delivery) {
    if (!delivery || Date.now() < delivery.nextAttemptAt) return false;
    try {
      await sendToolResult(delivery.call, delivery.result, delivery.error);
      pendingDeliveries.delete(key);
      lastDeliveryError = '';
      return true;
    } catch (error) {
      delivery.attempts += 1;
      delivery.nextAttemptAt = Date.now() + Math.min(8000, 1800 * delivery.attempts);
      lastDeliveryError = short(error?.message || error, 1000);
      if (delivery.attempts >= 8) {
        pendingDeliveries.delete(key);
        console.error('[ShunCode Web MCP] result delivery failed permanently:', error);
      } else {
        console.warn('[ShunCode Web MCP] result delivery failed; will retry without re-running tool:', error);
        scheduleScan(Math.max(60, delivery.nextAttemptAt - Date.now()));
      }
      return false;
    }
  }

  async function handleCall(call, laneKey = '', key = callBaseKey(call)) {
    if (seen.has(key)) return false;
    if (lockedLane && laneKey && laneKey !== lockedLane) return false;
    if (!lockedLane && laneKey) lockedLane = laneKey;
    seen.add(key);
    lastHandledCallKey = key;
    try {
      const stored = JSON.parse(sessionStorage.getItem(seenStorageKey) || '[]');
      const values = Array.isArray(stored) ? stored.map(String) : [];
      if (!values.includes(key)) values.push(key);
      sessionStorage.setItem(seenStorageKey, JSON.stringify(values.slice(-200)));
    } catch {}
    let result = null;
    let invocationError = null;
    try {
      result = await invokeTool(call.name, call.arguments || {});
    } catch (error) {
      invocationError = error;
    }
    const delivery = { call, result, error: invocationError, attempts: 0, nextAttemptAt: 0 };
    pendingDeliveries.set(key, delivery);
    await deliverPending(key, delivery);
    return true;
  }

  async function scan() {
    if (!enabled) return;
    if (busy) {
      scanRequestedWhileBusy = true;
      return;
    }
    busy = true;
    scanRequestedWhileBusy = false;
    lastScanAt = Date.now();
    try {
      for (const [key, delivery] of pendingDeliveries) {
        if (Date.now() >= delivery.nextAttemptAt) {
          await deliverPending(key, delivery);
          return;
        }
      }
      for (const occurrence of toolCallOccurrences().slice(-60)) {
        const { call, laneKey, key } = occurrence;
        if (lockedLane && laneKey && laneKey !== lockedLane) continue;
        if (await handleCall(call, laneKey, key)) return;
      }
    } finally {
      busy = false;
      if (scanRequestedWhileBusy) scheduleScan(60);
    }
  }

  function seedSeenFromHistory() {
    const occurrences = toolCallOccurrences();
    const completedCounts = extractCompletedCallCounts(document.body?.innerText || '');
    for (const occurrence of occurrences) {
      if (occurrence.ordinal <= (completedCounts.get(occurrence.baseKey) || 0)) seen.add(occurrence.key);
    }
    try {
      const stored = JSON.parse(sessionStorage.getItem(seenStorageKey) || '[]');
      if (Array.isArray(stored)) {
        for (const rawKey of stored.map(String)) {
          if (rawKey.includes('::occurrence:')) {
            seen.add(rawKey);
            continue;
          }
          const legacyOccurrence = occurrences.find(item => item.baseKey === rawKey && !seen.has(item.key));
          if (legacyOccurrence) seen.add(legacyOccurrence.key);
        }
      }
    } catch {}
  }

  function hasPrimingPrompt() {
    const text = document.body?.innerText || '';
    return text.includes(PRIME_CONTEXT_MARKER) && text.includes('IMPORTANT TRANSPORT RULE');
  }

  function summarizeTool(tool) {
    const props = tool?.inputSchema?.properties || {};
    const required = new Set(tool?.inputSchema?.required || []);
    const args = Object.keys(props).map(name => `${name}${required.has(name) ? '*' : ''}`).join(', ');
    return `- ${tool.name}${args ? `(${args})` : ''}: ${short(tool.description || tool.name, 180)}`;
  }

  function environmentModelPrompt(tools) {
    const names = new Set(tools.map(tool => String(tool?.name || '')));
    const lines = [
      'TWO-ENVIRONMENT MODEL — IMPORTANT:',
      '- There are TWO real environments available to reason about: (1) the SHUNCODE INTERNAL ENVIRONMENT and (2) the EXTERNAL WINDOWS COMPUTER ENVIRONMENT. Never collapse them into one.',
      '- SHUNCODE INTERNAL ENVIRONMENT: the IDE, its workspace/code tools, ShunCode-managed terminals, and ShunCode Integrated Browser/shared pages.',
      '- EXTERNAL WINDOWS COMPUTER ENVIRONMENT: the user\'s actual Windows computer outside the IDE, including OS processes, installed applications, broader filesystem/system resources, and external browsers exposed by tools.',
      '- ShunCode is only an application running on that Windows computer. The workspace is only one working directory; neither one is the whole machine.',
      '- IMPORTANT: ShunCode Integrated Browser is used as the convenient HOST for injecting WebMCP into AI chat pages. That hosting choice does NOT mean the AI is restricted to the Integrated Browser for later browser tasks.',
    ];
    if (names.has('run_command')) {
      lines.push('- EXTERNAL WINDOWS via run_command: it executes a real Windows PowerShell/ConPTY session as the current Windows user. Use it proactively for OS commands, processes, installed CLI/program discovery, environment information, system files allowed by Windows permissions, or launching an application/URL.');
    }
    if (names.has('list_browser_pages')) {
      lines.push('- INTERNAL BROWSER: list_browser_pages / read_page / click_element / type_in_page / navigate_page / run_playwright_code operate ShunCode Integrated Browser pages shared with the agent. These are valid browser tools, not merely WebMCP transport plumbing.');
      lines.push('- Protect the active AI chat page that carries WebMCP: do not navigate that chat tab away just to browse another site. Prefer another shared internal page or the external browser tools for unrelated browsing.');
    }
    if (names.has('browser_open')) {
      lines.push('- EXTERNAL BROWSER: browser_open / browser_pages / browser_click / browser_fill / browser_get_text / browser_dom / browser_evaluate / browser_screenshot operate a gateway-managed persistent Microsoft Edge OUTSIDE ShunCode Integrated Browser. Use this external browser whenever it better fits the task.');
      lines.push('- The gateway-managed external Edge has its own persistent profile/session. Do NOT assume it is the same process/profile as an already-running personal Edge window unless the tool result proves that.');
    }
    if (names.has('personal_edge_status')) {
      lines.push('- PERSONAL EDGE BRIDGE: personal_edge_status reports whether the user explicitly shared a tab from their normal Microsoft Edge. personal_edge_read reads title/URL/visible text; personal_edge_elements lists safe interactive-element metadata/selectors without exposing current input values.');
      lines.push('- When personal_edge_click / personal_edge_fill / personal_edge_navigate / personal_edge_reload are listed, they operate ONLY the currently shared personal Edge tab and preserve the user\'s real browser login/session. These interaction tools are high-impact and follow WebMCP approval mode. No arbitrary JavaScript execution is provided.');
      lines.push('- If a task needs the user\'s already logged-in personal browser, check personal_edge_status before claiming the existing Edge is unavailable. If no tab is shared, ask the user to click the bridge extension on the desired tab.');
    }
    lines.push('- OTHER EXTERNAL WINDOWS APPS: applications outside ShunCode exist independently. You may launch or inspect them with system tools where possible, but do not claim arbitrary precise GUI control unless an available tool/API actually provides it.');
    lines.push('- Choose by environment and task: ShunCode code/workspace work → internal workspace tools; ShunCode shared-page work → internal browser tools; Windows/system/app work → run_command; external web automation → browser_* tools. One user task may cross both environments and use several categories.');
    lines.push('- Before saying something is inaccessible, first inspect BOTH environments and the actual available tools. Never require the user to remind you that Windows or external browsers exist.');
    return lines.join('\n');
  }

  async function prime() {
    if (isDeepSeekAuthPage) throw new Error('DeepSeek authentication page is not a chat page');
    if (primed || hasPrimingPrompt()) {
      primed = true;
      return { ok: true, alreadyPrimed: true };
    }
    const tools = await fetchTools();
    const transportRule = isDeepSeek
      ? `DEEPSEEK TRANSPORT RULE: Do NOT use JSON and do NOT use a Markdown code fence for tool requests. When a tool is needed, reply with exactly one block and no prose:\n[SHUNCODE_TOOL]\nid=unique-call-id\nname=TOOL_NAME\narg.path=.\narg.depth=1\n[/SHUNCODE_TOOL]\nUse one arg.<name>=<value> line per argument. Use dotted paths for nested values and numeric indexes for arrays, for example arg.files.0.path=README.md. Numbers and booleans should be unquoted. For a multiline string use arg.patch<<SHUNCODE_EOF on one line, then the exact multiline value, then SHUNCODE_EOF on its own line. Always include [/SHUNCODE_TOOL]. Wait for [SHUNCODE_TOOL_RESULT] before continuing.`
      : `IMPORTANT TRANSPORT RULE: Chat renderers can corrupt JSON, quotes, backslashes, HTML and patch text unless the entire tool request is inside a code fence. Whenever a tool is needed, reply with exactly ONE FOUR-BACKTICK text fence and no prose. Inside that outer fence put exactly this request format:\n\n\`\`\`\`text\n[SHUNCODE_TOOL]\n{"id":"unique-call-id","name":"TOOL_NAME","arguments":{}}\n[/SHUNCODE_TOOL]\n\`\`\`\`\n\nDo not omit the outer four-backtick fence. Do not omit [/SHUNCODE_TOOL]. Keep JSON valid and preserve all backslashes exactly. Wait for [SHUNCODE_TOOL_RESULT] before continuing.`;
    const prompt = `${PRIME_CONTEXT_MARKER}\nYou have LIVE access to the user's ShunCode environment through Web MCP.\n\n${environmentModelPrompt(tools)}\n\nAvailable tools (* = required argument):\n${tools.map(summarizeTool).join('\n')}\n\n${transportRule}\n\nNever invent tool results. If the user asks you to create or modify a workspace file, you MUST actually use apply_patch or an appropriate ShunCode tool; do not merely print code in chat and claim the file was created. Prefer read/search/diagnostic tools before edits or commands. Minimize tool round-trips: batch compatible file reads in one read_files call, prefer one multi-file apply_patch instead of many tiny patches, and do not perform redundant verification calls. Do not open local files in the browser or start a local preview server merely to visually verify work unless the user explicitly asks for a preview; this self-verification restriction does NOT mean you should avoid browser tools when the user's actual task involves the web. Keep using the appropriate workspace, Windows, and browser tools until the user's task is complete.`;
    await sendMessage(prompt);
    primed = true;
    return { ok: true, toolCount: tools.length };
  }

  const observer = new MutationObserver(() => scheduleScan(180));
  seedSeenFromHistory();
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  scheduleScan(0);

  window.__shuncodeWebMcp = {
    version: 24,
    matchesConfig: (bridge, token) => String(bridge || '').replace(/\/$/, '') === BRIDGE && String(token || '') === TOKEN,
    prime,
    scan,
    invokeTool,
    fetchTools,
    status: () => ({ version: 24, enabled, primed, composerFound: !!findComposer(), resumeButtonFound: !!findResumeWorkButton(), seen: seen.size, pendingDeliveries: pendingDeliveries.size, lockedLane, isDeepSeek, isDeepSeekAuthPage, deepSeekPacing: 'disabled-user-preference', dedupeMode: 'call-occurrence-v2', lastScanAt, lastHandledCallKey, lastDeliveryError }),
    stop: () => {
      enabled = false;
      observer.disconnect();
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = null;
      scanTimerDue = 0;
      for (const timer of responseWatchTimers) clearTimeout(timer);
      responseWatchTimers.clear();
    },
  };
  return window.__shuncodeWebMcp.status();
})
