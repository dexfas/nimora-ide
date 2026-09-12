function shunCodeWebMcpAgent(config) {
  if (window.top !== window) return;
  if (!config || !config.token || !config.listBinding || !config.invokeBinding) return;

  const TOOL_TAG_RE = /\[SHUNCODE_TOOL\]\s*([\s\S]*?)\s*\[\/SHUNCODE_TOOL\]/g;
  const LEGACY_TOOL_RE = /```SHUNCODE_TOOL\s*([\s\S]*?)```/g;
  const HIGH_IMPACT = new Set(['apply_patch', 'run_command', 'send_command_input']);
  const IGNORE_NAMES = new Set(['TOOL_NAME', '__example__']);
  const seen = new Set();
  const isDeepSeek = /(^|\.)deepseek\.com$/i.test(location.hostname);
  const isDeepSeekAuthPage = isDeepSeek && /^\/(?:sign_in|sign_up|forgot_password)(?:\/|$)/i.test(location.pathname);
  let enabled = true;
  let busy = false;
  let primed = false;
  let observer;
  let scanTimer;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const short = (value, max = 12000) => String(value ?? '').slice(0, max);
  const visible = element => !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
  const binding = name => window[name];

  async function fetchTools() {
    const fn = binding(config.listBinding);
    if (typeof fn !== 'function') throw new Error('ShunCode tool bridge is unavailable');
    return await fn(config.token);
  }

  async function invokeTool(name, args) {
    const fn = binding(config.invokeBinding);
    if (typeof fn !== 'function') throw new Error('ShunCode tool bridge is unavailable');
    return await fn(config.token, name, args || {});
  }

  function composerScore(element) {
    if (!visible(element) || element.disabled || element.readOnly) return -Infinity;
    const rect = element.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 20) return -Infinity;
    const attrs = [
      element.getAttribute('placeholder'), element.getAttribute('aria-label'),
      element.getAttribute('data-placeholder'), element.getAttribute('role'),
      element.className, element.id,
    ].filter(Boolean).join(' ').toLowerCase();
    let score = rect.top / Math.max(1, window.innerHeight) * 8;
    if (/ask|message|chat|prompt|type|send|reply|问|消息|输入|聊天|提问/.test(attrs)) score += 20;
    if (element.matches('textarea')) score += 10;
    if (element.isContentEditable) score += 8;
    if (element.closest('form')) score += 4;
    if (element.closest('main')) score += 3;
    return score;
  }

  function findComposer() {
    if (isDeepSeekAuthPage) return null;
    const selectors = [
      'textarea',
      '[contenteditable="true"][role="textbox"]',
      '[contenteditable="true"][data-lexical-editor="true"]',
      '[contenteditable="true"]',
      'input[type="text"]',
    ];
    const candidates = [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))];
    return candidates
      .map(element => ({ element, score: composerScore(element) }))
      .filter(item => Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score)[0]?.element || null;
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
      return;
    }
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

  function sendButtonScore(button, composer) {
    if (!visible(button) || button.disabled) return -Infinity;
    const attrs = [button.getAttribute('aria-label'), button.title, button.textContent, button.className]
      .filter(Boolean).join(' ').toLowerCase();
    let score = 0;
    if (/send|submit|message|arrow.?up|发送|提交/.test(attrs)) score += 30;
    if (button.type === 'submit') score += 15;
    if (button.querySelector('svg')) score += 3;
    const buttonRect = button.getBoundingClientRect();
    const composerRect = composer.getBoundingClientRect();
    const distance = Math.abs(buttonRect.top - composerRect.top) + Math.abs(buttonRect.left - composerRect.right);
    score -= Math.min(distance / 100, 12);
    if (button.closest('form') && button.closest('form') === composer.closest('form')) score += 12;
    return score;
  }

  async function submitComposer() {
    await sleep(120);
    const composer = findComposer();
    if (!composer) throw new Error('Chat composer disappeared before submit');
    const buttons = [...document.querySelectorAll('button')]
      .map(button => ({ button, score: sendButtonScore(button, composer) }))
      .filter(item => item.score > 2)
      .sort((a, b) => b.score - a.score);
    if (buttons[0]) {
      buttons[0].button.click();
      return true;
    }
    const form = composer.closest('form');
    if (form && typeof form.requestSubmit === 'function') {
      form.requestSubmit();
      return true;
    }
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    composer.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
    return true;
  }

  function summarizeTool(tool) {
    const schema = tool?.inputSchema || {};
    const properties = schema.properties || {};
    const required = new Set(schema.required || []);
    const args = Object.entries(properties).map(([name, value]) => {
      const type = Array.isArray(value?.type) ? value.type.join('|') : (value?.type || 'any');
      return `${name}:${type}${required.has(name) ? '*' : ''}`;
    }).join(', ');
    const description = short(tool?.description || '', 140).replace(/\s+/g, ' ');
    return `- ${tool.name}(${args})${description ? ` — ${description}` : ''}`;
  }

  async function buildPrompt() {
    const tools = await fetchTools();
    const list = tools.map(summarizeTool).join('\n');
    return `You can use ShunCode MCP tools through this chat.\n\nAvailable tools (* = required argument):\n${list}\n\nWhen a tool is needed, reply with exactly ONE tool request and no other text in this format:\n[SHUNCODE_TOOL]\n{"id":"unique-id","name":"TOOL_NAME","arguments":{}}\n[/SHUNCODE_TOOL]\n\nDo not wrap the request in Markdown fences. Wait for a [SHUNCODE_TOOL_RESULT] message before continuing. Never invent tool results. Prefer read/search/diagnostic tools before write or command tools. Calls that edit files or execute commands require user confirmation.`;
  }

  async function prime() {
    if (primed) return { ok: true, primed: true, alreadyPrimed: true };
    if (isDeepSeekAuthPage) return { ok: false, primed: false, reason: 'deepseek-auth-page' };
    const composer = findComposer();
    if (!composer) return { ok: false, primed: false, reason: 'composer-not-found' };
    const prompt = await buildPrompt();
    setComposerText(composer, prompt);
    await submitComposer();
    primed = true;
    return { ok: true, primed: true, toolCount: (await fetchTools()).length };
  }

  function extractResultText(result) {
    if (result == null) return null;
    let text;
    if (Array.isArray(result.content)) {
      text = result.content.map(part => part?.text || (part?.type === 'text' ? part.text : '')).filter(Boolean).join('\n');
    } else {
      text = typeof result === 'string' ? result : JSON.stringify(result);
    }
    if (text.includes('=== APPLY_PATCH BEGIN ===')) text = text.split('--- CANONICAL APPLIED DIFF ---')[0].trim();
    return short(text, 10000);
  }

  async function sendToolResult(call, result, error) {
    const payload = error
      ? { id: call.id || null, name: call.name, ok: false, error: short(error?.message || error, 5000) }
      : { id: call.id || null, name: call.name, ok: true, result: extractResultText(result) };
    const text = `[SHUNCODE_TOOL_RESULT]\n${JSON.stringify(payload, null, 2)}\n[/SHUNCODE_TOOL_RESULT]\nContinue the task. If another tool is needed, request exactly one tool and wait for its result.`;
    const composer = findComposer();
    if (!composer) throw new Error('Chat composer not found while returning tool result');
    setComposerText(composer, text);
    await submitComposer();
  }

  async function handleCall(raw) {
    const call = JSON.parse(raw);
    if (!call || typeof call.name !== 'string') throw new Error('Invalid SHUNCODE_TOOL payload');
    if (IGNORE_NAMES.has(call.name) || String(call.id || '').startsWith('example-')) return;
    const key = call.id || `${call.name}:${JSON.stringify(call.arguments || {})}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (HIGH_IMPACT.has(call.name)) {
      const ok = confirm(`${location.hostname} wants to run ShunCode tool: ${call.name}\n\n${JSON.stringify(call.arguments || {}, null, 2).slice(0, 3000)}\n\nAllow?`);
      if (!ok) {
        await sendToolResult(call, null, new Error('User denied this tool call'));
        return;
      }
    }
    try {
      const result = await invokeTool(call.name, call.arguments || {});
      await sendToolResult(call, result, null);
    } catch (error) {
      await sendToolResult(call, null, error);
    }
  }

  function collectCalls(text) {
    const calls = [];
    for (const regex of [TOOL_TAG_RE, LEGACY_TOOL_RE]) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(text))) calls.push(match[1].trim());
    }
    return calls;
  }

  function seedSeenFromHistory() {
    const text = document.body?.innerText || '';
    for (const raw of collectCalls(text)) {
      try {
        const call = JSON.parse(raw);
        if (!call || typeof call.name !== 'string' || IGNORE_NAMES.has(call.name)) continue;
        const key = call.id || `${call.name}:${JSON.stringify(call.arguments || {})}`;
        seen.add(key);
      } catch {}
    }
  }

  async function scan() {
    if (!enabled || busy || !document.body) return;
    busy = true;
    try {
      const calls = collectCalls(document.body.innerText || '');
      for (const raw of calls.slice(-12)) {
        try { await handleCall(raw); } catch {}
      }
    } finally {
      busy = false;
    }
  }

  function status() {
    const composer = findComposer();
    return {
      host: location.hostname,
      url: location.href,
      enabled,
      primed,
      isDeepSeek,
      isDeepSeekAuthPage,
      composerFound: !!composer,
      composerTag: composer?.tagName || null,
      seenCalls: seen.size,
    };
  }

  function stop() {
    enabled = false;
    observer?.disconnect();
    clearTimeout(scanTimer);
  }

  function start() {
    if (!document.documentElement) return;
    if (window.__shuncodeWebMcp?.stop) window.__shuncodeWebMcp.stop();
    seedSeenFromHistory();
    observer = new MutationObserver(() => {
      clearTimeout(scanTimer);
      scanTimer = setTimeout(() => void scan(), 300);
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    window.__shuncodeWebMcp = { status, prime, scan, stop, fetchTools };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
}
