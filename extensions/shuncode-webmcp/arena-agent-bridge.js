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
  const PROVIDER_ADMISSION_TIMEOUT_MS = Number.isFinite(config.providerAdmissionTimeoutMs)
    ? Math.min(10000, Math.max(100, Number(config.providerAdmissionTimeoutMs)))
    // A new DeepSeek conversation may mount its virtualized chat history
    // slowly. Observe the same one-click submit without retrying or weakening
    // exact provider-user identity/text admission.
    : 10000;
  const HOST_MANAGED_TERMINAL_CAPABILITY_GRACE_MS = 10000;
  // Version/feature flags alone do not identify the actual injected modules.
  // Retained browser tabs can outlive an Extension Host/source rebuild.
  const implementationSources = [modules.createCore, modules.createSiteAdapter, shunCodeWebMcpAgent]
    .map(factory => Function.prototype.toString.call(factory));
  if (window.__shuncodeWebMcp?.version === 25
    && window.__shuncodeWebMcp?.matchesConfig?.(TRANSPORT_KEY, TOKEN)
    && window.__shuncodeWebMcp?.matchesImplementation?.(modules, shunCodeWebMcpAgent, PROVIDER_ADMISSION_TIMEOUT_MS) === true
    && window.__shuncodeWebMcp?.status?.()?.runningTurnPollScan === true
    && window.__shuncodeWebMcp?.status?.()?.virtualizedOccurrenceIdentity === true
    && window.__shuncodeWebMcp?.status?.()?.virtualizedResponseTextTruth === true
    && window.__shuncodeWebMcp?.status?.()?.occurrenceScopedResultRouting === true
    && window.__shuncodeWebMcp?.status?.()?.providerUserAdmissionTruth === true
    && window.__shuncodeWebMcp?.status?.()?.providerAdmissionStabilizationTruth === true
    && window.__shuncodeWebMcp?.status?.()?.admittedTurnOccurrenceGateTruth === true
    && window.__shuncodeWebMcp?.status?.()?.failedTurnOccurrenceQuarantineTruth === true
    && window.__shuncodeWebMcp?.status?.()?.toolOnlyCapabilityAdmissionLivenessTruth === true
    && window.__shuncodeWebMcp?.status?.()?.hostManagedTerminalCapabilityGraceTruth === true
    && window.__shuncodeWebMcp?.status?.()?.exactSubmitControlTruth === true
    && window.__shuncodeWebMcp?.status?.()?.exactSubmitActionabilityTruth === true
    && window.__shuncodeWebMcp?.status?.()?.deepSeekNoFormSubmitAssociationTruth === true
    && window.__shuncodeWebMcp?.status?.()?.deepSeekNoFormSubmitSemanticTruth === true
    && window.__shuncodeWebMcp?.status?.()?.stableUserAnchorAdmissionTruth === true
    && window.__shuncodeWebMcp?.status?.()?.hostResultUncertainTerminalTruth === true) {
    return window.__shuncodeWebMcp.status();
  }
  const previousRuntimeStatus = window.__shuncodeWebMcp?.status?.();
  if (previousRuntimeStatus?.workerTurn?.state === 'running'
    || previousRuntimeStatus?.pendingHostCapabilities > 0
    || previousRuntimeStatus?.pendingDeliveries > 0
    || previousRuntimeStatus?.resultDeliveryUncertain
    || previousRuntimeStatus?.lastDeliveryError) {
    throw new Error('WebMCP page implementation changed while previous work is unsettled; reconcile the original turn before replacing its runtime');
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
  // A hard reload of the SAME tab must not forget an ambiguous Provider ACK.
  // Store only receipt identities, never the tool output or provider prompt.
  const uncertainResultStorageKey = `shuncode-webmcp-unconfirmed-host-result:${pageSessionId}`;
  let retainedUnconfirmedHostResult = null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(uncertainResultStorageKey) || 'null');
    if (saved && typeof saved.inputId === 'string' && saved.inputId
      && typeof saved.callId === 'string' && saved.callId
      && typeof saved.occurrenceId === 'string' && saved.occurrenceId) {
      retainedUnconfirmedHostResult = {
        inputId: saved.inputId, callId: saved.callId, occurrenceId: saved.occurrenceId,
      };
    }
  } catch {
    // A failed storage read never authorizes replay of an in-memory uncertain turn.
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
  let scanQueued = 0;
  let scanTail = Promise.resolve();
  let backgroundScanFollowupRequested = false;
  let lastScanAt = 0;
  let lastHandledCallKey = '';
  let lastDeliveryError = '';
  let lastOccurrenceIdentityError = '';
  let lastSubmitDiagnostic = { state: 'idle', candidateCount: 0, method: '', semantic: '' };
  let lastAdmissionDiagnostic = null;
  let activeWorkerTurn = null;
  const outboundProviderGestureKeys = new Set();
  const responseWatchTimers = new Set();
  const initialDeepSeekBoundary = site.isDeepSeek && typeof site.conversationItemBoundary === 'function'
    ? site.conversationItemBoundary()
    : null;
  const deepSeekRuntimeFloor = initialDeepSeekBoundary?.valid === true && Number.isSafeInteger(initialDeepSeekBoundary.order)
    ? initialDeepSeekBoundary.order
    : null;

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
      // MutationObserver/response-burst scans are level-triggered observation,
      // not distinct work items. Coalesce them while a scan is already busy or
      // queued so stale background observations cannot build an unbounded tail
      // ahead of the exact host Worker poll. One follow-up scan is sufficient
      // because occurrence identity remains the capability authority/dedupe.
      if (busy || scanQueued > 0) {
        backgroundScanFollowupRequested = true;
        return;
      }
      void scan().catch(error => console.warn('[ShunCode Web MCP] background scan failed:', error));
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

  const exactSubmitLabels = new Set(['send message', 'send', '发送', '提交']);
  const deepSeekNoFormSubmitTokens = ['ds-button', 'ds-button--primary', 'ds-button--filled', 'ds-button--circle', 'ds-button--m'];
  const composerLikeSelector = 'textarea, [contenteditable="true"][role="textbox"], [contenteditable="true"][data-lexical-editor="true"], [contenteditable="true"], input[type="text"]';

  function setSubmitDiagnostic(state, details = {}) {
    lastSubmitDiagnostic = {
      state,
      candidateCount: Number.isFinite(details.candidateCount) ? details.candidateCount : 0,
      method: String(details.method || ''),
      semantic: short(details.semantic || '', 120),
      previousState: String(details.previousState || ''),
      admissionAmbiguityObservations: Number.isFinite(details.admissionAmbiguityObservations)
        ? Math.max(0, Number(details.admissionAmbiguityObservations))
        : 0,
      admission: lastAdmissionDiagnostic ? { ...lastAdmissionDiagnostic } : null,
      at: Date.now(),
    };
  }

  function exactSubmitSemantic(button) {
    const authoritative = [
      ['aria-label', button.getAttribute('aria-label')],
      ['title', button.getAttribute('title')],
      ['text', button.textContent],
    ]
      .map(([source, raw]) => ({ source, value: String(raw || '').trim() }))
      .find(entry => !!entry.value);
    if (!authoritative) return '';
    if (!exactSubmitLabels.has(authoritative.value.toLowerCase())) return '';
    return `${authoritative.source}:${authoritative.value}`;
  }

  function deepSeekNoFormControlShape(control) {
    if (!site.isDeepSeek || control?.getAttribute?.('role')?.toLowerCase() !== 'button') return false;
    return deepSeekNoFormSubmitTokens.every(token => control.classList?.contains(token));
  }

  function explicitSubmitSemantic(control) {
    return [
      ['aria-label', control.getAttribute('aria-label')],
      ['title', control.getAttribute('title')],
      ['text', control.textContent],
    ]
      .map(([source, raw]) => ({ source, value: String(raw || '').trim() }))
      .find(entry => !!entry.value) || null;
  }

  function deepSeekNoFormSubmitSemantic(control) {
    if (!deepSeekNoFormControlShape(control)) return '';
    const explicit = explicitSubmitSemantic(control);
    if (explicit) {
      if (!exactSubmitLabels.has(explicit.value.toLowerCase())) return '';
      return `${explicit.source}:${explicit.value}`;
    }
    return `deepseek-design-system:${deepSeekNoFormSubmitTokens.join('+')}`;
  }

  function deepSeekNoFormControlDomain(owner) {
    return [...owner.querySelectorAll('[role="button"]')]
      .filter(control => deepSeekNoFormControlShape(control));
  }

  function deepSeekNoFormSemanticConflicts(owner) {
    return deepSeekNoFormControlDomain(owner)
      .filter(control => {
        const explicit = explicitSubmitSemantic(control);
        return !!explicit && !exactSubmitLabels.has(explicit.value.toLowerCase());
      });
  }

  function deepSeekNoFormComposerShell(composer) {
    if (!site.isDeepSeek || composer?.closest?.('form')) return null;
    let current = composer?.parentElement || null;
    for (let depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
      if (current === document.body || current === document.documentElement || current.tagName === 'MAIN') break;
      if (!current.contains(composer)) continue;
      if (current.querySelector('[data-virtual-list-item-key]')) continue;
      const composerCandidates = [...current.querySelectorAll(composerLikeSelector)]
        .filter(element => visible(element) && !element.disabled && !element.readOnly);
      if (composerCandidates.length !== 1 || composerCandidates[0] !== composer) continue;
      const actionSurface = [...current.querySelectorAll('[role="button"], [tabindex]')]
        .filter(element => element !== composer && visible(element));
      if (actionSurface.length === 0 || actionSurface.length > 12) continue;
      if (deepSeekNoFormControlDomain(current).length === 0) continue;
      return current;
    }
    return null;
  }

  function submitAssociation(composer) {
    const form = composer?.closest?.('form') || null;
    if (form) return { kind: 'form', element: form };
    const deepSeekShell = deepSeekNoFormComposerShell(composer);
    return deepSeekShell ? { kind: 'deepseek-no-form', element: deepSeekShell } : null;
  }

  function sameSubmitAssociation(left, right) {
    return !!left && !!right && left.kind === right.kind && left.element === right.element;
  }

  function isSubmitActionable(button, association) {
    const owner = association?.element || null;
    if (!button || !button.isConnected || !owner || !owner.isConnected) return false;
    if (!owner.contains(button)) return false;
    const rect = button.getBoundingClientRect();
    if (!(rect.width > 0 && rect.height > 0 && button.getClientRects().length > 0)) return false;
    for (let current = button; current; current = current.parentElement) {
      if (current.hidden || current.getAttribute?.('aria-hidden')?.toLowerCase() === 'true' || current.hasAttribute?.('inert')) return false;
      const style = getComputedStyle(current);
      if (style.display === 'none'
        || style.visibility === 'hidden'
        || style.visibility === 'collapse'
        || Number.parseFloat(style.opacity || '1') === 0
        || style.pointerEvents === 'none') return false;
      if (current === owner) break;
    }
    return true;
  }

  function isSubmitEffectivelyEnabled(button, association) {
    if (!isSubmitActionable(button, association)) return false;
    if (button.disabled || button.matches(':disabled')) return false;
    if (button.getAttribute('aria-disabled')?.toLowerCase() === 'true') return false;
    if (association?.kind === 'deepseek-no-form') {
      if (button.classList?.contains('ds-button--disabled')) return false;
      const style = getComputedStyle(button);
      if (style.cursor === 'not-allowed') return false;
      const opacity = Number.parseFloat(style.opacity || '1');
      if (Number.isFinite(opacity) && opacity < 1 && button.classList?.contains('ds-button--disabled')) return false;
    }
    const owner = association?.element || null;
    for (let current = button; current; current = current.parentElement) {
      if (current.hasAttribute?.('inert')) return false;
      if (current !== button && current.getAttribute?.('aria-disabled')?.toLowerCase() === 'true') return false;
      if (current === owner) break;
    }
    return true;
  }

  function exactSubmitCandidates(composer, expectedAssociation = null) {
    const association = submitAssociation(composer);
    if (!association || (expectedAssociation && !sameSubmitAssociation(association, expectedAssociation))) return [];
    const buttons = association.kind === 'form'
      ? [...association.element.querySelectorAll('button')]
      : deepSeekNoFormControlDomain(association.element);
    return buttons
      .map(button => ({
        button,
        association,
        semantic: association.kind === 'form'
          ? exactSubmitSemantic(button)
          : deepSeekNoFormSubmitSemantic(button),
        actionable: isSubmitActionable(button, association),
        enabled: isSubmitEffectivelyEnabled(button, association),
      }))
      .filter(candidate => !!candidate.semantic);
  }

  function preflightExactSubmitControl(composer) {
    const association = submitAssociation(composer);
    if (!association) {
      setSubmitDiagnostic('association-missing', { candidateCount: 0 });
      throw new Error('Exact chat submit association is missing; WebMCP refused document-wide submit discovery');
    }
    if (association.kind === 'deepseek-no-form') {
      const semanticConflicts = deepSeekNoFormSemanticConflicts(association.element);
      if (semanticConflicts.length > 0) {
        const explicit = explicitSubmitSemantic(semanticConflicts[0]);
        setSubmitDiagnostic('semantic-conflict', {
          candidateCount: semanticConflicts.length,
          method: 'deepseek-control.click',
          semantic: explicit ? `${explicit.source}:${explicit.value}` : '',
        });
        throw new Error('Exact DeepSeek no-form submit semantic conflicts with explicit control semantics; WebMCP refused class-token override');
      }
    }
    const candidates = exactSubmitCandidates(composer);
    const actionable = candidates.filter(candidate => candidate.actionable);
    if (actionable.length > 1) {
      setSubmitDiagnostic('ambiguous', { candidateCount: actionable.length });
      throw new Error(`Exact chat submit control is ambiguous (${actionable.length} admissible controls); WebMCP refused to guess`);
    }
    const resolved = actionable[0] || null;
    if (!resolved) {
      setSubmitDiagnostic('missing', { candidateCount: 0 });
      throw new Error('Exact chat submit control is missing or not actionable; WebMCP refused to guess or use requestSubmit/Enter fallback');
    }
    setSubmitDiagnostic('preflight', { candidateCount: 1, method: association.kind === 'form' ? 'button.click' : 'deepseek-control.click', semantic: resolved.semantic });
    return resolved;
  }

  async function resolveExactSubmitControl(composer, preflight) {
    await sleep(220);
    const association = submitAssociation(composer);
    const method = preflight.association.kind === 'form' ? 'button.click' : 'deepseek-control.click';
    if (!association || !sameSubmitAssociation(association, preflight.association)) {
      setSubmitDiagnostic('association-drift', { candidateCount: 0, method, semantic: preflight.semantic });
      throw new Error('Exact chat submit association changed during composer fill; WebMCP refused to guess');
    }
    if (!preflight.button.isConnected || !association.element.contains(preflight.button)) {
      setSubmitDiagnostic('identity-drift', { candidateCount: 0, method, semantic: preflight.semantic });
      throw new Error('Exact chat submit control identity changed during composer fill; WebMCP refused to guess');
    }
    const currentSemantic = association.kind === 'form'
      ? exactSubmitSemantic(preflight.button)
      : deepSeekNoFormSubmitSemantic(preflight.button);
    if (currentSemantic !== preflight.semantic) {
      setSubmitDiagnostic('semantic-drift', { candidateCount: 0, method, semantic: currentSemantic });
      throw new Error('Exact chat submit semantic identity changed during composer fill; WebMCP refused to guess');
    }
    if (!isSubmitActionable(preflight.button, association)) {
      setSubmitDiagnostic('actionability-drift', { candidateCount: 0, method, semantic: preflight.semantic });
      throw new Error('Exact chat submit control became non-actionable during composer fill; WebMCP refused to guess');
    }
    if (!isSubmitEffectivelyEnabled(preflight.button, association)) {
      setSubmitDiagnostic('disabled-after-fill', { candidateCount: 0, method, semantic: preflight.semantic });
      throw new Error('Exact chat submit control is not effectively enabled after composer fill; WebMCP refused requestSubmit/Enter fallback');
    }
    const enabled = exactSubmitCandidates(composer, preflight.association)
      .filter(candidate => candidate.actionable && candidate.enabled);
    if (enabled.length !== 1) {
      setSubmitDiagnostic('ambiguous', { candidateCount: enabled.length });
      throw new Error(`Exact chat submit control is ambiguous (${enabled.length} admissible controls); WebMCP refused to guess`);
    }
    const resolved = enabled[0];
    if (resolved.button !== preflight.button
      || resolved.semantic !== preflight.semantic
      || !sameSubmitAssociation(resolved.association, preflight.association)) {
      setSubmitDiagnostic('identity-drift', { candidateCount: 1, method, semantic: resolved.semantic });
      throw new Error('Exact chat submit control identity changed during composer fill; WebMCP refused to guess');
    }
    setSubmitDiagnostic('resolved', { candidateCount: 1, method, semantic: resolved.semantic });
    return resolved;
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

  async function submitComposer(resolved) {
    const previousState = lastSubmitDiagnostic.state;
    try {
      const result = resolved.button.click();
      setSubmitDiagnostic('gesture-attempted', {
        candidateCount: 1,
        method: 'button.click',
        semantic: resolved.semantic,
        previousState,
      });
      return result;
    } catch (error) {
      setSubmitDiagnostic('click-unknown', {
        candidateCount: 1,
        method: 'button.click',
        semantic: resolved.semantic,
        previousState,
      });
      throw error;
    }
  }

  async function waitForDeepSeekProviderAdmission(baseline, expected, previousNotices, timeoutMs = 5000) {
    const startedAt = Date.now();
    const deadline = Date.now() + timeoutMs;
    let lastObservation = null;
    let ambiguityObservations = 0;
    const stabilizableReasons = new Set([
      'multiple-new-provider-user-identities',
      'user-message-missing-stable-identity',
      'user-message-identity-ambiguous',
      'assistant-message-missing-stable-identity',
      'provider-message-identity-ambiguous',
      'provider-user-order-ambiguous',
      'provider-user-role-ambiguous',
    ]);
    while (Date.now() < deadline) {
      await sleep(120);
      await site.verifyAcceptedSend(previousNotices);
      lastObservation = site.observeProviderUserAdmission(baseline, expected);
      lastAdmissionDiagnostic = {
        ...site.providerUserAdmissionDiagnostics(),
        baselineUserMessages: Object.keys(baseline?.userTexts || {}).length,
        observation: lastObservation?.status || 'missing',
        reason: lastObservation?.reason || '',
        elapsedMs: Date.now() - startedAt,
      };
      if (lastObservation?.status === 'admitted') return { ...lastObservation, ambiguityObservations };
      if (lastObservation?.status === 'rejected') {
        if (stabilizableReasons.has(lastObservation.reason)) {
          ambiguityObservations += 1;
          continue;
        }
        throw new Error(`DeepSeek provider user-message admission rejected: ${lastObservation.reason || 'unknown'}`);
      }
    }
    if (lastObservation?.status === 'rejected'
      && lastObservation.reason === 'multiple-new-provider-user-identities') {
      throw new Error('DeepSeek provider user-message admission rejected: multiple-new-provider-user-identities');
    }
    throw new Error(`DeepSeek provider user-message admission was not confirmed after the single submit gesture${lastObservation?.reason ? ` (${lastObservation.reason})` : ''}; observation=${JSON.stringify(lastAdmissionDiagnostic)}`);
  }

  async function sendMessage(text, outboundGestureKey = '') {
    lastAdmissionDiagnostic = null;
    const normalizedGestureKey = String(outboundGestureKey || '').trim();
    if (normalizedGestureKey && outboundProviderGestureKeys.has(normalizedGestureKey)) {
      throw new Error(`WebMCP outbound occurrence already used its single provider submit gesture: ${normalizedGestureKey}`);
    }
    await site.beforeAutomaticSend();
    const previousRateLimitNotices = site.captureRateLimitNotices();
    const providerUserBaseline = site.isDeepSeek && typeof site.providerUserBoundary === 'function'
      ? site.providerUserBoundary()
      : null;
    if (site.isDeepSeek && providerUserBaseline?.valid !== true) {
      throw new Error(`DeepSeek provider-user admission baseline is not trustworthy: ${providerUserBaseline?.reason || 'unknown'}`);
    }
    const composer = await ensureComposer();
    const existing = composerText(composer);
    if (existing && existing !== text) {
      if (!/^\s*\[SHUNCODE_TOOL_RESULT\]/.test(existing) && !/^\s*You have LIVE access to the user's ShunCode workspace/.test(existing)) {
        throw new Error('Chat composer contains user text; Web MCP refused to overwrite it');
      }
    }
    const preflightSubmit = preflightExactSubmitControl(composer);
    if (existing && existing !== text) {
      setComposerText(composer, '');
      await sleep(80);
    }
    setComposerText(composer, text);
    const resultId = outboundToolResultId(text);
    const resultCountBaseline = resultId ? completedResultCountForId(resultId) : 0;
    let resolvedSubmit = null;
    try {
      resolvedSubmit = await resolveExactSubmitControl(composer, preflightSubmit);
    } catch (error) {
      const current = findComposer() || composer;
      if (composerText(current) === text) setComposerText(current, '');
      throw error;
    }
    if (normalizedGestureKey) outboundProviderGestureKeys.add(normalizedGestureKey);
    site.onAutomaticSendAttempt();
    let submitError = null;
    try {
      await submitComposer(resolvedSubmit);
    } catch (error) {
      submitError = error;
    }
    if (site.isDeepSeek) {
      try {
        const admission = await waitForDeepSeekProviderAdmission(providerUserBaseline, text, previousRateLimitNotices, PROVIDER_ADMISSION_TIMEOUT_MS);
        setSubmitDiagnostic('admitted', {
          candidateCount: 1,
          method: 'button.click',
          semantic: resolvedSubmit.semantic,
          previousState: lastSubmitDiagnostic.state,
          admissionAmbiguityObservations: admission?.ambiguityObservations || 0,
        });
        return;
      } catch (admissionError) {
        setSubmitDiagnostic('admission-failed', {
          candidateCount: 1,
          method: 'button.click',
          semantic: resolvedSubmit.semantic,
          previousState: lastSubmitDiagnostic.state,
        });
        if (submitError) {
          throw new Error(`DeepSeek submit gesture was uncertain and exact provider-user admission was not confirmed: ${short(submitError?.message || submitError, 500)}; ${short(admissionError?.message || admissionError, 1000)}`);
        }
        throw admissionError;
      }
    }
    if (await waitForMessageSubmission(composer, text, resultId, resultCountBaseline, 5000)) {
      await site.verifyAcceptedSend(previousRateLimitNotices);
      return;
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

  async function sendToolResult(call, result, error, outboundGestureKey = '') {
    const payload = error ? { id: call.id || null, name: call.name, ok: false, error: short(error?.message || error, 5000) } : { id: call.id || null, name: call.name, ok: true, result: toolResultText(result) };
    await sendMessage(`[SHUNCODE_TOOL_RESULT]\n${JSON.stringify(payload, null, 2)}\n[/SHUNCODE_TOOL_RESULT]\nContinue the task. If another tool is needed, request exactly one tool and wait for its result.`, outboundGestureKey);
    armResponseScanBurst();
  }

  function isProvenDeepSeekPreAdmissionRateLimit(error) {
    const message = String(error?.message || error || '');
    return site.isDeepSeek
      && /before exact user-message admission/i.test(message)
      && /消息发送过于频繁|too\s+many\s+requests|too\s+frequent|rate[ -]?limit|try\s+again\s+later/i.test(message);
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
      const messageIdentity = site.isDeepSeek && typeof site.assistantMessageIdentity === 'function'
        ? String(site.assistantMessageIdentity(element) || '')
        : '';
      const messageOrder = site.isDeepSeek && typeof site.assistantMessageOrder === 'function'
        ? site.assistantMessageOrder(element)
        : null;
      const calls = extractCalls(element.innerText || element.textContent || '');
      for (let callIndex = 0; callIndex < calls.length; callIndex += 1) {
        const call = calls[callIndex];
        const baseKey = callBaseKey(call);
        const ordinal = (counts.get(baseKey) || 0) + 1;
        counts.set(baseKey, ordinal);
        const stableDeepSeekIdentity = !!messageIdentity && Number.isSafeInteger(messageOrder) && messageOrder >= 0;
        const key = stableDeepSeekIdentity
          ? 'deepseek-message:' + encodeURIComponent(messageIdentity) + '::call:' + (callIndex + 1) + '::provider:' + encodeURIComponent(baseKey)
          : baseKey + '::occurrence:' + ordinal;
        occurrences.push({
          call,
          laneKey,
          baseKey,
          ordinal,
          key,
          callIndex,
          stableDeepSeekIdentity,
          messageIdentity,
          messageOrder: stableDeepSeekIdentity ? messageOrder : null,
        });
      }
    }
    return occurrences;
  }

  function occurrenceEligibleForCurrentScope(occurrence) {
    if (!site.isDeepSeek) return true;
    const runningTurn = activeWorkerTurn?.state === 'running' ? activeWorkerTurn : null;
    const hostTurn = activeWorkerTurn?.hostManagedCapabilities ? activeWorkerTurn : null;
    // A host-managed turn with an empty capability allowlist is a pure text
    // turn. Do not interpret provider text as a tool request even if the model
    // echoes the transport syntax from prior context. The stable response is
    // surfaced as ordinary text and the owning host parser remains the only
    // authority for the requested JSON/text contract.
    if (hostTurn && hostTurn.allowedCapabilities?.size === 0) return false;
    const failedPreAdmissionQuarantine = !!hostTurn
      && !hostTurn.sentAt
      && hostTurn.state !== 'running'
      && hostTurn.terminalOrigin === String(location.origin || '')
      && hostTurn.terminalPathname === String(location.pathname || '');
    const scopedTurn = hostTurn && (hostTurn.state === 'running' || !!hostTurn.sentAt || failedPreAdmissionQuarantine)
      ? hostTurn
      : runningTurn;
    // Once an admitted host-managed turn reaches any terminal state, every
    // later post-floor occurrence remains owned by that terminal turn for
    // quarantine purposes only. Never let it fall through to generic WebMCP
    // execution merely because handleCall only has a running Worker authority.
    if (hostTurn && hostTurn.state !== 'running') return false;
    if (!occurrence.stableDeepSeekIdentity) {
      if (scopedTurn?.hostManagedCapabilities) {
        lastOccurrenceIdentityError = 'DeepSeek host-managed capability candidate lacks one exact stable virtual-list message identity/order.';
        return false;
      }
      return true;
    }
    const floor = scopedTurn && Number.isSafeInteger(scopedTurn.deepSeekMessageFloor)
      ? scopedTurn.deepSeekMessageFloor
      : deepSeekRuntimeFloor;
    if (!Number.isSafeInteger(floor)) {
      if (scopedTurn?.hostManagedCapabilities) {
        lastOccurrenceIdentityError = 'DeepSeek host-managed turn lacks a trustworthy pre-send virtual-list boundary.';
        return false;
      }
      return true;
    }
    if (occurrence.messageOrder <= floor) return false;
    if (scopedTurn?.hostManagedCapabilities && !scopedTurn.sentAt) {
      // The exact host-managed turn owns every post-floor occurrence before
      // provider admission. Keep it visible for a later rescan, but do not
      // consume/dispatch it. If admission terminally failed, retain the same
      // quarantine only on the captured provider conversation lineage.
      return false;
    }
    lastOccurrenceIdentityError = '';
    return true;
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
    const zeroCapabilityHostTurn = !!turn?.hostManagedCapabilities && turn.allowedCapabilities?.size === 0;
    if (site.isDeepSeek && Number.isSafeInteger(turn?.deepSeekMessageFloor)) {
      const postFloor = site.assistantMessageCandidates()
        .map(element => ({
          order: typeof site.assistantMessageOrder === 'function' ? site.assistantMessageOrder(element) : null,
          text: site.assistantMessageText(element),
        }))
        .filter(item => Number.isSafeInteger(item.order)
          && item.order > turn.deepSeekMessageFloor
          && item.text
          && (zeroCapabilityHostTurn || !item.text.includes('[SHUNCODE_TOOL]')))
        .sort((a, b) => a.order - b.order)
        .map(item => item.text);
      return postFloor.join('\n\n').trim();
    }
    const current = zeroCapabilityHostTurn
      ? site.assistantMessageCandidates().map(site.assistantMessageText).filter(Boolean)
      : assistantMessageTexts();
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
    // DeepSeek can expose stable assistant prose and report non-streaming
    // before the provider's tool block mounts into the virtualized response.
    // For an exact host-managed turn that has not admitted any capability yet,
    // keep the same turn observable for one bounded convergence window. This
    // does not execute anything: only a subsequently scanned, exact post-floor
    // occurrence can create capability authority. Once a tool was admitted,
    // normal post-result completion timing remains unchanged.
    const awaitingInitialHostCapability = turn.hostManagedCapabilities
      && turn.allowedCapabilities?.size > 0
      && turn.toolCallCount === 0
      && now - turn.lastChangeAt < HOST_MANAGED_TERMINAL_CAPABILITY_GRACE_MS;
    const hostResultIsTerminal = turn.terminalAfterHostCapabilityResult === true
      && turn.toolCallCount > 0
      && turn.hostResultDelivered.size > 0
      && core.pendingDeliveryCount() === 0
      && turn.pendingHostCapabilities.size === 0
      && !site.isResponseStreaming();
    if (hostResultIsTerminal || (stable && !awaitingInitialHostCapability && postToolResponseObserved && core.pendingDeliveryCount() === 0 && turn.pendingHostCapabilities.size === 0 && !site.isResponseStreaming())) {
      turn.state = 'completed';
      turn.completedAt = now;
      appendWorkerEvent(turn, 'completed', { text: turn.text });
    }
    return turn;
  }

  function normalizeWorkerTurnCapabilityScope(input) {
    const allowed = Array.isArray(input?.allowedCapabilities)
      ? [...new Set(input.allowedCapabilities.map(value => String(value || '').trim()).filter(Boolean))]
      : [];
    const definitions = Array.isArray(input?.externalCapabilities)
      ? input.externalCapabilities
          .filter(value => value && typeof value === 'object' && !Array.isArray(value))
          .map(value => ({
            name: String(value.name || '').trim(),
            description: typeof value.description === 'string' ? value.description : '',
            inputSchema: value.inputSchema && typeof value.inputSchema === 'object' && !Array.isArray(value.inputSchema)
              ? value.inputSchema
              : null,
          }))
          .filter(value => value.name && value.inputSchema)
      : [];
    const hostManaged = input?.extensions?.hostManagedCapabilities === true;
    const terminalAfterHostCapabilityResult = input?.extensions?.terminalAfterHostCapabilityResult === true;
    if (hostManaged) {
      const allowedSet = new Set(allowed);
      const definitionNames = new Set(definitions.map(value => value.name));
      const missing = allowed.filter(name => !definitionNames.has(name));
      const extra = definitions.filter(value => !allowedSet.has(value.name)).map(value => value.name);
      if (missing.length || extra.length) {
        throw new Error(`Host-managed WebMCP capability scope is inconsistent (missing schemas: ${missing.join(', ') || 'none'}; extra schemas: ${extra.join(', ') || 'none'})`);
      }
    }
    if (terminalAfterHostCapabilityResult && (!hostManaged || allowed.length !== 1 || definitions.length !== 1)) {
      throw new Error('terminalAfterHostCapabilityResult requires one exact host-managed capability.');
    }
    return { allowed, definitions, hostManaged, terminalAfterHostCapabilityResult };
  }

  function workerTurnPrompt(input, scope) {
    const prompt = String(input?.prompt || '');
    if (!scope.hostManaged) return prompt;
    if (!scope.allowed.length) {
      return [
        prompt,
        '',
        '## ShunCode Mission Capability Scope — this turn only',
        'Allowed tool names: (none)',
        'No ShunCode capability is admitted for this turn.',
        'Do not emit [SHUNCODE_TOOL], tool-call JSON, or any tool protocol. Return only the normal assistant response requested above.',
      ].join('\n');
    }
    const schemas = scope.definitions.map(definition => [
      `TOOL ${definition.name}`,
      definition.description ? `Description: ${definition.description}` : '',
      `Input schema: ${JSON.stringify(definition.inputSchema)}`,
    ].filter(Boolean).join('\n')).join('\n\n');
    const names = scope.allowed.join(', ');
    return [
      prompt,
      '',
      '## ShunCode Mission Capability Scope — this turn only',
      `Allowed tool names: ${names}`,
      'Only the tool names above are executable for this Mission turn. Do not request any other ShunCode tool even if an older conversation message mentioned it.',
      site.transportRule(),
      `Exact admitted schemas:\n${schemas}`,
    ].join('\n');
  }

  async function workerSend(input) {
    const inputId = String(input?.inputId || '').trim();
    const capabilityScope = normalizeWorkerTurnCapabilityScope(input);
    const prompt = workerTurnPrompt(input, capabilityScope);
    if (!inputId) throw new Error('WebMCP worker inputId is required');
    if (!prompt.trim()) throw new Error('WebMCP worker prompt is required');
    if (retainedUnconfirmedHostResult || activeWorkerTurn?.resultDeliveryUncertain || activeWorkerTurn?.pendingHostCapabilities?.size) {
      throw new Error('Previous host tool result has unconfirmed provider admission. Preserve the old turn and use reviewed reconciliation; no new provider send.');
    }
    if (activeWorkerTurn && activeWorkerTurn.state === 'running') throw new Error(`WebMCP worker turn is already running: ${activeWorkerTurn.inputId}`);
    const now = Date.now();
    const currentDeepSeekBoundary = site.isDeepSeek && typeof site.conversationItemBoundary === 'function'
      ? site.conversationItemBoundary()
      : null;
    if (site.isDeepSeek
      && capabilityScope.hostManaged
      && (currentDeepSeekBoundary?.valid !== true || !Number.isSafeInteger(currentDeepSeekBoundary.order))) {
      throw new Error('DeepSeek host-managed Worker send requires a trustworthy numeric virtual-list boundary.');
    }
    lastOccurrenceIdentityError = '';
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
      hostManagedCapabilities: capabilityScope.hostManaged,
      terminalAfterHostCapabilityResult: capabilityScope.terminalAfterHostCapabilityResult,
      allowedCapabilities: new Set(capabilityScope.allowed),
      externalCapabilityNames: capabilityScope.definitions.map(value => value.name),
      pendingHostCapabilities: new Set(),
      pendingHostRoutes: new Map(),
      hostResultObserved: new Set(),
      hostResultDelivered: new Set(),
      resultDeliveryUncertain: null,
      hostRouteLastDelivered: new Map(),
      hostOccurrenceRoutes: new Map(),
      deepSeekMessageFloor: currentDeepSeekBoundary?.valid === true && Number.isSafeInteger(currentDeepSeekBoundary.order)
        ? currentDeepSeekBoundary.order
        : null,
      providerOrigin: String(location.origin || ''),
      providerPathname: String(location.pathname || ''),
      admittedOrigin: '',
      admittedPathname: '',
      terminalOrigin: '',
      terminalPathname: '',
      nextEventSeq: 1,
      events: [],
    };
    activeWorkerTurn = turn;
    appendWorkerEvent(turn, 'status', { name: 'sending' });
    try {
      await sendMessage(prompt, 'worker-input:' + inputId);
      if (turn.state !== 'running') {
        throw new Error(`WebMCP worker turn ended before provider admission completed: ${turn.state}`);
      }
      turn.admittedOrigin = String(location.origin || '');
      turn.admittedPathname = String(location.pathname || '');
      turn.sentAt = Date.now();
      appendWorkerEvent(turn, 'status', { name: 'sent' });
      // A valid host-managed DeepSeek capability can finish rendering while
      // provider-user admission is still stabilizing. It is intentionally
      // quarantined while sentAt is unset; synchronously rescan at the exact
      // admission boundary so that already-rendered stable post-floor
      // occurrences converge before the transport no-progress clock starts.
      if (turn.hostManagedCapabilities && site.isDeepSeek) await scan(turn.inputId);
      armResponseScanBurst();
      return workerTurnSnapshot(turn);
    } catch (error) {
      if (turn.state === 'running') {
        turn.state = 'error';
        turn.error = short(error?.message || error, 2000);
        turn.completedAt = Date.now();
      }
      if (!turn.sentAt) {
        turn.terminalOrigin = String(location.origin || '');
        turn.terminalPathname = String(location.pathname || '');
      }
      if (turn.state === 'error') appendWorkerEvent(turn, 'error', { error: turn.error });
      throw error;
    }
  }

  async function workerPoll(inputId) {
    if (!activeWorkerTurn || activeWorkerTurn.inputId !== String(inputId || '')) throw new Error(`Unknown WebMCP worker turn: ${inputId}`);
    const turn = activeWorkerTurn;
    if (turn.state === 'running') await scan(turn.inputId);
    refreshWorkerTurn(turn);
    return workerTurnSnapshot(turn);
  }

  async function workerInterrupt(inputId) {
    if (!activeWorkerTurn || activeWorkerTurn.inputId !== String(inputId || '')) return false;
    if (activeWorkerTurn.state !== 'running') return false;
    const interrupted = await site.interruptGeneration();
    activeWorkerTurn.state = 'cancelled';
    activeWorkerTurn.completedAt = Date.now();
    if (!activeWorkerTurn.sentAt) {
      activeWorkerTurn.terminalOrigin = String(location.origin || '');
      activeWorkerTurn.terminalPathname = String(location.pathname || '');
    }
    activeWorkerTurn.pendingHostCapabilities.clear();
    activeWorkerTurn.pendingHostRoutes.clear();
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
    const routeKey = callId + '\u0000' + name;
    const requestedOccurrenceId = typeof input?.extensions?.occurrenceId === 'string'
      ? String(input.extensions.occurrenceId).trim()
      : '';
    let resultIdentity = 'legacy-host-result:' + routeKey;
    if (activeWorkerTurn.hostManagedCapabilities) {
      if (requestedOccurrenceId) {
        const knownRoute = activeWorkerTurn.hostOccurrenceRoutes.get(requestedOccurrenceId);
        if (!knownRoute) {
          throw new Error(`WebMCP host-managed capability result has unknown logical occurrence authority for ${callId}/${name}`);
        }
        if (knownRoute !== routeKey) {
          throw new Error(`WebMCP host-managed capability result occurrence route mismatch for ${callId}/${name}`);
        }
        if (activeWorkerTurn.hostResultDelivered.has(requestedOccurrenceId)) {
          return workerTurnSnapshot(activeWorkerTurn);
        }
        if (!activeWorkerTurn.pendingHostCapabilities.has(requestedOccurrenceId)) {
          throw new Error(`WebMCP host-managed capability result occurrence is not pending for ${callId}/${name}`);
        }
        resultIdentity = requestedOccurrenceId;
      } else {
        const pendingIdentity = activeWorkerTurn.pendingHostRoutes.get(routeKey);
        if (!pendingIdentity) {
          if (activeWorkerTurn.hostRouteLastDelivered.has(routeKey)) return workerTurnSnapshot(activeWorkerTurn);
          throw new Error(`WebMCP host-managed capability result has no pending occurrence for ${callId}/${name}`);
        }
        if (activeWorkerTurn.hostRouteLastDelivered.has(routeKey)) {
          throw new Error(`WebMCP host-managed capability result requires exact logical occurrence authority after provider route reuse for ${callId}/${name}`);
        }
        resultIdentity = pendingIdentity;
      }
    }
    if (activeWorkerTurn.hostResultDelivered.has(resultIdentity)) return workerTurnSnapshot(activeWorkerTurn);

    if (!activeWorkerTurn.hostResultObserved.has(resultIdentity)) {
      activeWorkerTurn.hostResultObserved.add(resultIdentity);
      appendWorkerEvent(activeWorkerTurn, 'status', { name: 'capability_result_received', callId, capability: name });
      appendWorkerEvent(activeWorkerTurn, 'capability_result', {
        callId,
        name,
        occurrenceId: resultIdentity,
        text: short(input?.text || '', 10000),
        isError: input?.isError === true,
        durationMs: Number.isFinite(input?.durationMs) ? Number(input.durationMs) : undefined,
      });
    }

    const result = input?.data !== undefined
      ? input.data
      : { content: [{ type: 'text', text: String(input?.text || '') }] };
    const error = input?.isError === true ? new Error(String(input?.text || 'Host capability execution failed')) : null;
    const resultTurn = activeWorkerTurn;
    try {
      await sendToolResult({ id: callId, name }, result, error, 'host-result:' + resultIdentity);
      refreshWorkerTurn(activeWorkerTurn);
      activeWorkerTurn.revisionAtLastDelivery = activeWorkerTurn.revision;
      activeWorkerTurn.hostResultDelivered.add(resultIdentity);
      if (activeWorkerTurn.hostManagedCapabilities) {
        activeWorkerTurn.pendingHostCapabilities.delete(resultIdentity);
        if (activeWorkerTurn.pendingHostRoutes.get(routeKey) === resultIdentity) {
          activeWorkerTurn.pendingHostRoutes.delete(routeKey);
        }
        activeWorkerTurn.hostRouteLastDelivered.set(routeKey, resultIdentity);
      }
      lastDeliveryError = '';
      appendWorkerEvent(activeWorkerTurn, 'status', { name: 'capability_result_delivered', callId, capability: name, occurrenceId: resultIdentity, source: 'host' });
      refreshWorkerTurn(activeWorkerTurn);
      armResponseScanBurst();
      return workerTurnSnapshot(activeWorkerTurn);
    } catch (deliveryError) {
      lastDeliveryError = short(deliveryError?.message || deliveryError, 1000);
      if (isProvenDeepSeekPreAdmissionRateLimit(deliveryError)) {
        // DeepSeek explicitly rejected this exact Host result before provider
        // admission, so no duplicate provider message can exist. Preserve the
        // pending durable occurrence and release only its one-gesture guard;
        // the extension-host-wide FIFO may resend the SAME result once after
        // the global cooldown. Any admission ambiguity still follows the
        // fail-closed uncertain-delivery path below.
        outboundProviderGestureKeys.delete('host-result:' + resultIdentity);
        appendWorkerEvent(resultTurn, 'status', {
          name: 'capability_result_rate_limited_pre_admission',
          callId,
          capability: name,
          occurrenceId: resultIdentity,
          source: 'host',
          error: lastDeliveryError,
        });
        throw deliveryError;
      }
      // A gesture may have reached DeepSeek even when exact DOM acknowledgement
      // failed. Terminalize the ORIGINAL input so the host can end its local
      // send/lease, but retain an explicit unresolved provider-result receipt.
      // Neither this turn nor a following turn may re-send the old result.
      resultTurn.resultDeliveryUncertain = { inputId, callId, occurrenceId: resultIdentity };
      retainedUnconfirmedHostResult = { ...resultTurn.resultDeliveryUncertain };
      try { sessionStorage.setItem(uncertainResultStorageKey, JSON.stringify(retainedUnconfirmedHostResult)); } catch {}
      appendWorkerEvent(resultTurn, 'status', { name: 'capability_result_delivery_unconfirmed',
        callId, capability: name, occurrenceId: resultIdentity, source: 'host', error: lastDeliveryError });
      if (resultTurn.state === 'running') {
        resultTurn.state = 'error';
        resultTurn.error = 'Host capability result provider acknowledgement is unconfirmed: ' + lastDeliveryError;
        resultTurn.completedAt = Date.now();
        appendWorkerEvent(resultTurn, 'error', { error: resultTurn.error, code: 'WEBMCP_HOST_RESULT_PROVIDER_UNCONFIRMED' });
      }
      throw deliveryError;
    }
  }

  async function deliverPending(key, delivery) {
    if (!delivery || Date.now() < delivery.nextAttemptAt) return false;
    try {
      await sendToolResult(delivery.call, delivery.result, delivery.error, 'tool-result:' + key);
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

  async function handleCall(call, laneKey = '', key = callBaseKey(call), expectedWorkerInputId = '') {
    if (core.hasSeen(key)) return false;
    if (expectedWorkerInputId) {
      if (!activeWorkerTurn
        || activeWorkerTurn.inputId !== expectedWorkerInputId
        || activeWorkerTurn.state !== 'running') {
        return false;
      }
    }
    const workerTurn = activeWorkerTurn?.state === 'running' ? activeWorkerTurn : null;
    const hostManaged = !!workerTurn?.hostManagedCapabilities;
    if (hostManaged && !workerTurn.sentAt) return false;
    if (lockedLane && laneKey && laneKey !== lockedLane) return false;
    if (!lockedLane && laneKey) lockedLane = laneKey;
    if (hostManaged && !call.id) throw new Error(`Host-managed WebMCP capability requires a stable call id: ${call.name}`);
    const pendingHostRouteKey = hostManaged ? String(call.id) + '\u0000' + String(call.name) : '';
    if (hostManaged && workerTurn.pendingHostRoutes.has(pendingHostRouteKey)) return false;
    core.rememberSeen(key);
    lastHandledCallKey = key;
    if (hostManaged && !workerTurn.allowedCapabilities.has(call.name)) {
      refreshWorkerTurn(workerTurn);
      workerTurn.toolCallCount += 1;
      const rejection = new Error(`Capability ${call.name} is outside the exact admitted Mission capability scope for this turn.`);
      appendWorkerEvent(workerTurn, 'status', {
        name: 'capability_rejected',
        callId: call.id || null,
        capability: call.name,
        reason: rejection.message,
      });
      const delivery = { call, result: null, error: rejection, attempts: 0, nextAttemptAt: 0, workerInputId: workerTurn.inputId };
      core.setPendingDelivery(key, delivery);
      await deliverPending(key, delivery);
      return true;
    }
    if (workerTurn) {
      refreshWorkerTurn(workerTurn);
      workerTurn.toolCallCount += 1;
      appendWorkerEvent(workerTurn, 'capability_call', {
        callId: call.id || null,
        name: call.name,
        occurrenceId: key,
        arguments: call.arguments || {},
        dispatch: hostManaged ? 'host-requested' : 'observed',
      });
      if (hostManaged) {
        workerTurn.pendingHostCapabilities.add(key);
        workerTurn.pendingHostRoutes.set(pendingHostRouteKey, key);
        workerTurn.hostOccurrenceRoutes.set(key, pendingHostRouteKey);
        return true;
      }
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

  async function scanPass(expectedWorkerInputId = '') {
    if (!enabled) return;
    busy = true;
    lastScanAt = Date.now();
    try {
      if (expectedWorkerInputId
        && (!activeWorkerTurn
          || activeWorkerTurn.inputId !== expectedWorkerInputId
          || activeWorkerTurn.state !== 'running')) {
        return;
      }
      for (const [key, delivery] of core.pendingDeliveryEntries()) {
        if (Date.now() >= delivery.nextAttemptAt) {
          await deliverPending(key, delivery);
          return;
        }
      }
      for (const occurrence of toolCallOccurrences().slice(-60)) {
        if (expectedWorkerInputId
          && (!activeWorkerTurn
            || activeWorkerTurn.inputId !== expectedWorkerInputId
            || activeWorkerTurn.state !== 'running')) {
          return;
        }
        const { call, laneKey, key } = occurrence;
        if (!occurrenceEligibleForCurrentScope(occurrence)) continue;
        if (lockedLane && laneKey && laneKey !== lockedLane) continue;
        if (await handleCall(call, laneKey, key, expectedWorkerInputId)) return;
      }
    } finally {
      busy = false;
    }
  }

  function scan(expectedWorkerInputId = '') {
    if (!enabled) return Promise.resolve();
    scanQueued += 1;
    if (busy || scanQueued > 1) scanRequestedWhileBusy = true;
    const requested = scanTail.then(
      () => scanPass(expectedWorkerInputId),
      () => scanPass(expectedWorkerInputId),
    );
    scanTail = requested.catch(() => {});
    return requested.finally(() => {
      scanQueued = Math.max(0, scanQueued - 1);
      scanRequestedWhileBusy = scanQueued > 0;
      if (scanQueued === 0 && backgroundScanFollowupRequested && enabled) {
        backgroundScanFollowupRequested = false;
        scheduleScan(0);
      }
    });
  }

  function seedSeenFromHistory() {
    const occurrences = toolCallOccurrences();
    const completedCounts = extractCompletedCallCounts(document.body?.innerText || '');
    core.seedSeenFromHistory(occurrences, completedCounts);
    if (site.isDeepSeek && Number.isSafeInteger(deepSeekRuntimeFloor)) {
      for (const occurrence of occurrences) {
        if (occurrence.stableDeepSeekIdentity && occurrence.messageOrder <= deepSeekRuntimeFloor) {
          core.rememberSeen(occurrence.key);
        }
      }
    }
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
    matchesImplementation: (nextModules, nextAgent, timeoutMs) => {
      const nextFactories = [nextModules?.createCore, nextModules?.createSiteAdapter, nextAgent];
      return timeoutMs === PROVIDER_ADMISSION_TIMEOUT_MS
        && nextFactories.every((factory, index) => typeof factory === 'function'
          && Function.prototype.toString.call(factory) === implementationSources[index]);
    },
    prime,
    scan,
    invokeTool,
    fetchTools,
    workerSend,
    workerPoll,
    workerInterrupt,
    workerResolveCapability,
    workerSession: () => ({ sessionId: pageSessionId, site: site.id, origin: location.origin, href: location.href, transport: BINDING_TRANSPORT ? 'binding' : 'http' }),
    status: () => ({ version: 25, coreVersion: 1, runningTurnPollScan: true, virtualizedOccurrenceIdentity: true, virtualizedResponseTextTruth: true, occurrenceScopedResultRouting: true, providerUserAdmissionTruth: true, providerAdmissionStabilizationTruth: true, admittedTurnOccurrenceGateTruth: true, failedTurnOccurrenceQuarantineTruth: true, toolOnlyCapabilityAdmissionLivenessTruth: true, hostManagedTerminalCapabilityGraceTruth: true, exactSubmitControlTruth: true, exactSubmitActionabilityTruth: true, deepSeekNoFormSubmitAssociationTruth: true, deepSeekNoFormSubmitSemanticTruth: true, stableUserAnchorAdmissionTruth: true, hostResultUncertainTerminalTruth: true, backgroundScanCoalescingTruth: true, siteAdapter: site.id, transport: BINDING_TRANSPORT ? 'binding' : 'http', pageSessionId, enabled, primed, composerFound: !!findComposer(), resumeButtonFound: !!findResumeWorkButton(), seen: core.seenCount(), pendingDeliveries: core.pendingDeliveryCount(), pendingHostCapabilities: activeWorkerTurn?.pendingHostCapabilities?.size || 0, resultDeliveryUncertain: retainedUnconfirmedHostResult ? { ...retainedUnconfirmedHostResult } : activeWorkerTurn?.resultDeliveryUncertain ? { ...activeWorkerTurn.resultDeliveryUncertain } : null, lockedLane, isDeepSeek: site.isDeepSeek, isDeepSeekAuthPage: site.isDeepSeekAuthPage, deepSeekPacing: site.pacingMode, dedupeMode: 'call-occurrence-v2', workerTurn: activeWorkerTurn ? { inputId: activeWorkerTurn.inputId, state: activeWorkerTurn.state, hostManagedCapabilities: activeWorkerTurn.hostManagedCapabilities === true } : null, scanQueueDepth: scanQueued, backgroundScanFollowupPending: backgroundScanFollowupRequested, lastSubmitDiagnostic: { ...lastSubmitDiagnostic }, lastScanAt, lastHandledCallKey, lastDeliveryError, lastOccurrenceIdentityError }),
    stop: () => {
      enabled = false;
      observer.disconnect();
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = null;
      scanTimerDue = 0;
      backgroundScanFollowupRequested = false;
      for (const timer of responseWatchTimers) clearTimeout(timer);
      responseWatchTimers.clear();
    },
  };
  return window.__shuncodeWebMcp.status();
})
