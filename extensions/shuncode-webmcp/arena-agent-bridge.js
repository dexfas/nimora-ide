(function shunCodeWebMcpAgent(config, modules) {
  if (!config || !config.token) throw new Error('Missing ShunCode Web MCP config');
  if (typeof modules?.createCore !== 'function' || typeof modules?.createSiteAdapter !== 'function') throw new Error('Missing Web MCP Core/Site Adapter modules');
  const TOKEN = String(config.token);
  const LIST_BINDING = String(config.listBinding || '');
  const INVOKE_BINDING = String(config.invokeBinding || '');
  const BINDING_TRANSPORT = !!LIST_BINDING && !!INVOKE_BINDING;
  const BRIDGE = String(config.bridge || '').replace(/\/$/, '');
  if (!BINDING_TRANSPORT && !BRIDGE) throw new Error('Missing Web MCP HTTP bridge or page bindings');
  const TRANSPORT_KEY = BINDING_TRANSPORT ? `binding:${LIST_BINDING}:${INVOKE_BINDING}` : `http:${BRIDGE}`;
  if (window.__shuncodeWebMcp?.version === 25 && window.__shuncodeWebMcp?.matchesConfig?.(TRANSPORT_KEY, TOKEN)) {
    return window.__shuncodeWebMcp.status();
  }
  try { window.__shuncodeWebMcp?.stop?.(); } catch {}

  const PRIME_CONTEXT_MARKER = 'SHUNCODE_WEBMCP_CONTEXT_V25';
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
  const seenStorageKey = `shuncode-webmcp-seen:${location.origin}${location.pathname}`;
  const core = modules.createCore({ storage: sessionStorage, seenStorageKey });
  const site = modules.createSiteAdapter({ window, document, location, visible, storage: sessionStorage });
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
  let activeWorkerTurn = null;
  const responseWatchTimers = new Set();

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

  async function request(path, options = {}) {
    if (BINDING_TRANSPORT) throw new Error('HTTP request is unavailable for binding WebMCP transport');
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
    if (BINDING_TRANSPORT) {
      const fn = window[LIST_BINDING];
      if (typeof fn !== 'function') throw new Error('ShunCode list-tools page binding is unavailable');
      const tools = await fn(TOKEN);
      return Array.isArray(tools) ? tools : [];
    }
    const body = await request('/webmcp/tools');
    return Array.isArray(body.tools) ? body.tools : [];
  }

  async function invokeTool(name, args) {
    if (BINDING_TRANSPORT) {
      const fn = window[INVOKE_BINDING];
      if (typeof fn !== 'function') throw new Error('ShunCode invoke-tool page binding is unavailable');
      return await fn(TOKEN, name, args || {});
    }
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

  function findComposer() {
    return site.findComposer();
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
    await site.beforeAutomaticSend();
    const previousRateLimitNotices = site.captureRateLimitNotices();
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
    site.onAutomaticSendAttempt();
    await submitComposer(composer);
    if (await waitForMessageSubmission(composer, text, resultId, resultCountBaseline, 5000)) {
      await site.verifyAcceptedSend(previousRateLimitNotices);
      return;
    }

    const form = composer.closest('form');
    if (form && typeof form.requestSubmit === 'function') {
      try { form.requestSubmit(); } catch {}
      if (await waitForMessageSubmission(composer, text, resultId, resultCountBaseline, 2500)) {
        await site.verifyAcceptedSend(previousRateLimitNotices);
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

  const parseJsonObjectAt = core.parseJsonObjectAt;
  const extractCalls = core.extractCalls;
  const extractCompletedCallCounts = core.extractCompletedCallCounts;

  function assistantTextCandidates() {
    return site.assistantTextCandidates();
  }

  function callBaseKey(call) {
    return core.callBaseKey(call);
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
    return site.laneKeyFor(element);
  }

  function assistantMessageTexts() {
    return site.assistantMessageCandidates()
      .map(site.assistantMessageText)
      .filter(text => text && !text.includes('[SHUNCODE_TOOL]'));
  }

  function appendWorkerEvent(turn, type, data = {}) {
    turn.events.push({ seq: turn.nextEventSeq++, type, at: Date.now(), ...data });
    if (turn.events.length > 200) turn.events.splice(0, turn.events.length - 200);
  }

  function workerTurnSnapshot(turn) {
    return {
      inputId: turn.inputId,
      state: turn.state,
      text: turn.text,
      error: turn.error || null,
      startedAt: turn.startedAt,
      sentAt: turn.sentAt || null,
      completedAt: turn.completedAt || null,
      toolCallCount: turn.toolCallCount,
      pendingDeliveries: core.pendingDeliveryCount(),
      events: turn.events.map(event => ({ ...event })),
    };
  }

  function currentWorkerResponseText(turn) {
    const current = assistantMessageTexts();
    if (current.length > turn.baselineMessages.length) return current.slice(turn.baselineMessages.length).join('\n\n').trim();
    if (current.length && turn.baselineMessages.length && current.at(-1) !== turn.baselineMessages.at(-1)) return current.at(-1).trim();
    return '';
  }

  function refreshWorkerTurn(turn) {
    if (!turn || turn.state !== 'running') return turn;
    const now = Date.now();
    const nextText = currentWorkerResponseText(turn);
    if (nextText !== turn.text) {
      const previousText = turn.text;
      turn.text = nextText;
      turn.revision += 1;
      turn.lastChangeAt = now;
      const delta = nextText.startsWith(previousText) ? nextText.slice(previousText.length) : nextText;
      if (delta) appendWorkerEvent(turn, 'assistant_text', { text: delta, reset: !!previousText && !nextText.startsWith(previousText) });
    }
    const postToolResponseObserved = turn.toolCallCount === 0 || turn.revision > turn.revisionAtLastDelivery;
    const stable = !!turn.text && now - turn.lastChangeAt >= 1200;
    if (stable && postToolResponseObserved && core.pendingDeliveryCount() === 0 && !site.isResponseStreaming()) {
      turn.state = 'completed';
      turn.completedAt = now;
      appendWorkerEvent(turn, 'completed', { text: turn.text });
    }
    return turn;
  }

  async function workerSend(input) {
    const inputId = String(input?.inputId || '').trim();
    const prompt = String(input?.prompt || '');
    if (!inputId) throw new Error('WebMCP worker inputId is required');
    if (!prompt.trim()) throw new Error('WebMCP worker prompt is required');
    if (activeWorkerTurn && activeWorkerTurn.state === 'running') throw new Error(`WebMCP worker turn is already running: ${activeWorkerTurn.inputId}`);
    const now = Date.now();
    const turn = {
      inputId,
      state: 'running',
      text: '',
      error: '',
      baselineMessages: assistantMessageTexts(),
      startedAt: now,
      sentAt: 0,
      completedAt: 0,
      lastChangeAt: now,
      revision: 0,
      revisionAtLastDelivery: 0,
      toolCallCount: 0,
      hostResultObserved: new Set(),
      hostResultDelivered: new Set(),
      nextEventSeq: 1,
      events: [],
    };
    activeWorkerTurn = turn;
    appendWorkerEvent(turn, 'status', { name: 'sending' });
    try {
      await sendMessage(prompt);
      turn.sentAt = Date.now();
      appendWorkerEvent(turn, 'status', { name: 'sent' });
      armResponseScanBurst();
      return workerTurnSnapshot(turn);
    } catch (error) {
      turn.state = 'error';
      turn.error = short(error?.message || error, 2000);
      turn.completedAt = Date.now();
      appendWorkerEvent(turn, 'error', { error: turn.error });
      throw error;
    }
  }

  function workerPoll(inputId) {
    if (!activeWorkerTurn || activeWorkerTurn.inputId !== String(inputId || '')) throw new Error(`Unknown WebMCP worker turn: ${inputId}`);
    refreshWorkerTurn(activeWorkerTurn);
    return workerTurnSnapshot(activeWorkerTurn);
  }

  async function workerInterrupt(inputId) {
    if (!activeWorkerTurn || activeWorkerTurn.inputId !== String(inputId || '')) return false;
    if (activeWorkerTurn.state !== 'running') return false;
    const interrupted = await site.interruptGeneration();
    activeWorkerTurn.state = 'cancelled';
    activeWorkerTurn.completedAt = Date.now();
    appendWorkerEvent(activeWorkerTurn, 'cancelled', { interrupted });
    return interrupted;
  }

  async function workerResolveCapability(input) {
    const inputId = String(input?.inputId || '').trim();
    const callId = String(input?.callId || '').trim();
    const name = String(input?.name || '').trim();
    if (!activeWorkerTurn || activeWorkerTurn.inputId !== inputId) throw new Error(`Unknown WebMCP worker turn: ${inputId}`);
    if (activeWorkerTurn.state !== 'running') throw new Error(`WebMCP worker turn is not running: ${inputId}`);
    if (!callId) throw new Error('WebMCP host-managed capability result requires callId');
    if (!name) throw new Error('WebMCP host-managed capability result requires capability name');
    const key = `${callId}\u0000${name}`;
    if (activeWorkerTurn.hostResultDelivered.has(key)) return workerTurnSnapshot(activeWorkerTurn);

    if (!activeWorkerTurn.hostResultObserved.has(key)) {
      activeWorkerTurn.hostResultObserved.add(key);
      appendWorkerEvent(activeWorkerTurn, 'status', { name: 'capability_result_received', callId, capability: name });
      appendWorkerEvent(activeWorkerTurn, 'capability_result', {
        callId,
        name,
        text: short(input?.text || '', 10000),
        isError: input?.isError === true,
        durationMs: Number.isFinite(input?.durationMs) ? Number(input.durationMs) : undefined,
      });
    }

    const result = input?.data !== undefined
      ? input.data
      : { content: [{ type: 'text', text: String(input?.text || '') }] };
    const error = input?.isError === true ? new Error(String(input?.text || 'Host capability execution failed')) : null;
    try {
      await sendToolResult({ id: callId, name }, result, error);
      refreshWorkerTurn(activeWorkerTurn);
      activeWorkerTurn.revisionAtLastDelivery = activeWorkerTurn.revision;
      activeWorkerTurn.hostResultDelivered.add(key);
      lastDeliveryError = '';
      appendWorkerEvent(activeWorkerTurn, 'status', { name: 'capability_result_delivered', callId, capability: name, source: 'host' });
      armResponseScanBurst();
      return workerTurnSnapshot(activeWorkerTurn);
    } catch (deliveryError) {
      lastDeliveryError = short(deliveryError?.message || deliveryError, 1000);
      appendWorkerEvent(activeWorkerTurn, 'status', { name: 'capability_result_delivery_failed', callId, capability: name, source: 'host', error: lastDeliveryError });
      throw deliveryError;
    }
  }

  async function deliverPending(key, delivery) {
    if (!delivery || Date.now() < delivery.nextAttemptAt) return false;
    try {
      await sendToolResult(delivery.call, delivery.result, delivery.error);
      core.deletePendingDelivery(key);
      lastDeliveryError = '';
      if (activeWorkerTurn?.state === 'running' && delivery.workerInputId === activeWorkerTurn.inputId) {
        refreshWorkerTurn(activeWorkerTurn);
        activeWorkerTurn.revisionAtLastDelivery = activeWorkerTurn.revision;
        appendWorkerEvent(activeWorkerTurn, 'status', { name: 'capability_result_delivered', callId: delivery.call.id || null, capability: delivery.call.name });
      }
      return true;
    } catch (error) {
      delivery.attempts += 1;
      delivery.nextAttemptAt = Date.now() + Math.min(8000, 1800 * delivery.attempts);
      lastDeliveryError = short(error?.message || error, 1000);
      if (delivery.attempts >= 8) {
        core.deletePendingDelivery(key);
        console.error('[ShunCode Web MCP] result delivery failed permanently:', error);
      } else {
        console.warn('[ShunCode Web MCP] result delivery failed; will retry without re-running tool:', error);
        scheduleScan(Math.max(60, delivery.nextAttemptAt - Date.now()));
      }
      return false;
    }
  }

  async function handleCall(call, laneKey = '', key = callBaseKey(call)) {
    if (core.hasSeen(key)) return false;
    if (lockedLane && laneKey && laneKey !== lockedLane) return false;
    if (!lockedLane && laneKey) lockedLane = laneKey;
    core.rememberSeen(key);
    lastHandledCallKey = key;
    const workerTurn = activeWorkerTurn?.state === 'running' ? activeWorkerTurn : null;
    if (workerTurn) {
      refreshWorkerTurn(workerTurn);
      workerTurn.toolCallCount += 1;
      appendWorkerEvent(workerTurn, 'capability_call', {
        callId: call.id || null,
        name: call.name,
        arguments: call.arguments || {},
      });
    }
    let result = null;
    let invocationError = null;
    try {
      result = await invokeTool(call.name, call.arguments || {});
    } catch (error) {
      invocationError = error;
    }
    if (workerTurn) {
      appendWorkerEvent(workerTurn, 'capability_result', {
        callId: call.id || null,
        name: call.name,
        text: invocationError ? short(invocationError?.message || invocationError, 5000) : toolResultText(result),
        isError: !!invocationError,
      });
    }
    const delivery = { call, result, error: invocationError, attempts: 0, nextAttemptAt: 0, workerInputId: workerTurn?.inputId || '' };
    core.setPendingDelivery(key, delivery);
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
      for (const [key, delivery] of core.pendingDeliveryEntries()) {
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
    core.seedSeenFromHistory(occurrences, completedCounts);
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
    if (site.isDeepSeekAuthPage) throw new Error('DeepSeek authentication page is not a chat page');
    if (primed || hasPrimingPrompt()) {
      primed = true;
      return { ok: true, alreadyPrimed: true };
    }
    const tools = await fetchTools();
    const transportRule = site.transportRule();
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
    version: 25,
    matchesConfig: (transportKey, token) => String(transportKey || '') === TRANSPORT_KEY && String(token || '') === TOKEN,
    prime,
    scan,
    invokeTool,
    fetchTools,
    workerSend,
    workerPoll,
    workerInterrupt,
    workerResolveCapability,
    workerSession: () => ({ sessionId: pageSessionId, site: site.id, origin: location.origin, href: location.href, transport: BINDING_TRANSPORT ? 'binding' : 'http' }),
    status: () => ({ version: 25, coreVersion: 1, siteAdapter: site.id, transport: BINDING_TRANSPORT ? 'binding' : 'http', pageSessionId, enabled, primed, composerFound: !!findComposer(), resumeButtonFound: !!findResumeWorkButton(), seen: core.seenCount(), pendingDeliveries: core.pendingDeliveryCount(), lockedLane, isDeepSeek: site.isDeepSeek, isDeepSeekAuthPage: site.isDeepSeekAuthPage, deepSeekPacing: site.pacingMode, dedupeMode: 'call-occurrence-v2', workerTurn: activeWorkerTurn ? { inputId: activeWorkerTurn.inputId, state: activeWorkerTurn.state } : null, lastScanAt, lastHandledCallKey, lastDeliveryError }),
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
