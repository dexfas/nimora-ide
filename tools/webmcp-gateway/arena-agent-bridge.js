(function () {
  if (location.hostname !== 'arena.ai' && !location.hostname.endsWith('.arena.ai')) return;
  const BRIDGE = 'http://127.0.0.1:48324';
  const PANEL_ID = 'shuncode-agent-bridge-panel';
  const TOOL_RE = /```SHUNCODE_TOOL\s*([\s\S]*?)```/g;
  const HIGH_IMPACT = new Set(['run_command', 'send_command_input']);
  const seen = new Set();
  let enabled = true;
  let busy = false;

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const short = (s, n = 12000) => String(s ?? '').slice(0, n);

  async function fetchTools() {
    const r = await fetch(`${BRIDGE}/tools`);
    if (!r.ok) throw new Error(`Bridge HTTP ${r.status}`);
    return (await r.json()).tools || [];
  }

  async function invokeTool(name, args) {
    const r = await fetch(`${BRIDGE}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, arguments: args || {} }),
    });
    const body = await r.json();
    if (!r.ok || !body.ok) throw new Error(body.error || `Bridge HTTP ${r.status}`);
    return body.result;
  }

  function findComposer() {
    return document.querySelector('textarea[placeholder*="Ask"], textarea[aria-label*="Ask"], [contenteditable="true"][data-lexical-editor="true"], [contenteditable="true"][role="textbox"], textarea');
  }

  function setComposerText(el, text) {
    if (!el) throw new Error('Arena composer not found');
    el.focus();
    if ('value' in el) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
      setter ? setter.call(el, text) : (el.value = text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = text;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    }
  }

  async function submitComposer() {
    await sleep(150);
    const buttons = [...document.querySelectorAll('button')];
    const send = buttons.find(b => /send message|send/i.test(b.getAttribute('aria-label') || b.title || b.textContent || '') && !b.disabled)
      || buttons.find(b => !b.disabled && b.querySelector('svg') && b.closest('form'));
    if (send) return send.click();
    const el = findComposer();
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    el?.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  }

  async function sendToolResult(call, result, error) {
    const text = error
      ? `[SHUNCODE_TOOL_RESULT]\n${JSON.stringify({ id: call.id || null, name: call.name, ok: false, error: short(error.message || error) })}\n[/SHUNCODE_TOOL_RESULT]\nContinue the task. If another tool is needed, emit exactly one SHUNCODE_TOOL block.`
      : `[SHUNCODE_TOOL_RESULT]\n${JSON.stringify({ id: call.id || null, name: call.name, ok: true, result }, null, 2).slice(0, 9000)}\n[/SHUNCODE_TOOL_RESULT]\nContinue the task. If another tool is needed, emit exactly one SHUNCODE_TOOL block.`;
    const composer = findComposer();
    setComposerText(composer, text);
    await submitComposer();
  }

  function extractResultText(result) {
    if (!result) return null;
    let text;
    if (Array.isArray(result.content)) {
      text = result.content.map(p => p?.text || (p?.type === 'text' ? p.text : '')).filter(Boolean).join('\n');
    } else {
      text = typeof result === 'string' ? result : JSON.stringify(result);
    }
    if (text.includes('=== APPLY_PATCH BEGIN ===')) {
      text = text.split('--- CANONICAL APPLIED DIFF ---')[0].trim();
    }
    return short(text, 8000);
  }

  async function handleCall(raw) {
    const call = JSON.parse(raw);
    if (!call || typeof call.name !== 'string') throw new Error('Invalid SHUNCODE_TOOL payload');
    if (String(call.id || '').startsWith('example-') || call.name === '__example__') return;
    const key = call.id || `${call.name}:${JSON.stringify(call.arguments || {})}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (HIGH_IMPACT.has(call.name)) {
      const ok = confirm(`Arena wants to run ShunCode tool: ${call.name}\n\n${JSON.stringify(call.arguments || {}, null, 2).slice(0, 2500)}\n\nAllow?`);
      if (!ok) {
        await sendToolResult(call, null, new Error('User denied this tool call'));
        return;
      }
    }
    try {
      setStatus(`running ${call.name}…`, '#fbbf24');
      const result = await invokeTool(call.name, call.arguments || {});
      await sendToolResult(call, extractResultText(result), null);
      setStatus(`done: ${call.name}`, '#34d399');
    } catch (e) {
      await sendToolResult(call, null, e);
      setStatus(`error: ${call.name}`, '#f87171');
    }
  }

  async function scan() {
    if (!enabled || busy) return;
    busy = true;
    try {
      const nodes = [...document.querySelectorAll('main code, main pre, main [data-message-author-role="assistant"], main article')]
        .filter(el => !el.closest(`#${PANEL_ID}`) && !['TEXTAREA', 'INPUT'].includes(el.tagName) && !el.isContentEditable)
        .filter(el => !el.closest('[class*="bg-surface-raised"][class*="w-fit"]'))
        .filter(el => el.textContent?.includes('```SHUNCODE_TOOL'));
      for (const node of nodes.slice(-40)) {
        const text = node.textContent || '';
        TOOL_RE.lastIndex = 0;
        let m;
        while ((m = TOOL_RE.exec(text))) await handleCall(m[1].trim());
      }
    } finally { busy = false; }
  }

  function seedSeenFromHistory() {
    const nodes = [...document.querySelectorAll('main code, main pre, main [data-message-author-role="assistant"], main article')]
      .filter(el => !el.closest(`#${PANEL_ID}`) && !['TEXTAREA', 'INPUT'].includes(el.tagName) && !el.isContentEditable)
      .filter(el => !el.closest('[class*="bg-surface-raised"][class*="w-fit"]'))
      .filter(el => el.textContent?.includes('```SHUNCODE_TOOL'));
    for (const node of nodes) {
      TOOL_RE.lastIndex = 0;
      let m;
      while ((m = TOOL_RE.exec(node.textContent || ''))) {
        try {
          const call = JSON.parse(m[1].trim());
          if (!call || typeof call.name !== 'string') continue;
          const key = call.id || `${call.name}:${JSON.stringify(call.arguments || {})}`;
          seen.add(key);
        } catch {}
      }
    }
  }

  function setStatus(text, color = '#9ca3af') {
    const el = document.querySelector(`#${PANEL_ID} [data-status]`);
    if (el) { el.textContent = text; el.style.color = color; }
  }

  function button(text, attrs = {}) {
    const el = document.createElement('button');
    el.textContent = text;
    Object.assign(el.dataset, attrs.dataset || {});
    el.style.cssText = attrs.style || '';
    return el;
  }

  async function injectPanel() {
    if (!document.body) {
      await new Promise(resolve => {
        if (document.readyState !== 'loading') return resolve();
        document.addEventListener('DOMContentLoaded', resolve, { once: true });
      });
    }
    if (!document.body) return;
    document.getElementById(PANEL_ID)?.remove();
    const root = document.createElement('div');
    root.id = PANEL_ID;
    root.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;width:390px;background:#111827;color:#fff;border:1px solid #374151;border-radius:12px;box-shadow:0 12px 36px rgba(0,0,0,.4);font:13px system-ui;padding:12px';
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;gap:8px';
    const title = document.createElement('b'); title.textContent = 'ShunCode Agent Bridge';
    const status = document.createElement('span'); status.dataset.status = ''; status.textContent = 'checking…'; status.style.cssText = 'margin-left:auto;color:#9ca3af';
    const close = button('×', { dataset: { close: '' }, style: 'background:#374151;color:#fff;border:0;border-radius:6px;padding:2px 7px;cursor:pointer' });
    top.append(title, status, close);

    const actions = document.createElement('div');
    actions.style.cssText = 'margin-top:9px;display:flex;gap:8px';
    const toggle = button('Auto tools: ON', { dataset: { toggle: '' }, style: 'flex:1;background:#059669;color:white;border:0;border-radius:7px;padding:7px;cursor:pointer' });
    const copy = button('Copy agent prompt', { dataset: { copy: '' }, style: 'flex:1;background:#2563eb;color:white;border:0;border-radius:7px;padding:7px;cursor:pointer' });
    actions.append(toggle, copy);

    const note = document.createElement('div');
    note.textContent = 'Read/write tools run automatically. Terminal execution/input requires confirmation.';
    note.style.cssText = 'margin-top:8px;color:#9ca3af;font-size:12px;line-height:1.4';
    root.append(top, actions, note);
    document.body.appendChild(root);
    root.querySelector('[data-close]').onclick = () => root.remove();
    root.querySelector('[data-toggle]').onclick = e => { enabled = !enabled; e.currentTarget.textContent = `Auto tools: ${enabled ? 'ON' : 'OFF'}`; e.currentTarget.style.background = enabled ? '#059669' : '#6b7280'; };
    root.querySelector('[data-copy]').onclick = async () => {
      const tools = await fetchTools();
      const names = tools.map(t => t.name).join(', ');
      const prompt = `You have access to ShunCode tools through a local bridge. Available tools: ${names}. When a tool is required, output ONLY a four-backtick fenced text block whose content is exactly a three-backtick SHUNCODE_TOOL block, like this:\n\n\`\`\`\`text\n\`\`\`SHUNCODE_TOOL\n{"id":"example-format-only","name":"__example__","arguments":{}}\n\`\`\`\n\`\`\`\`\n\nFor real calls, replace the id, name and arguments with the actual tool call. Wait for the [SHUNCODE_TOOL_RESULT] message, then continue. Never invent tool results. Prefer read/search tools before write/terminal tools.`;
      await navigator.clipboard.writeText(prompt);
      setStatus('agent prompt copied', '#34d399');
    };
    try { const tools = await fetchTools(); setStatus(`${tools.length} tools ready`, '#34d399'); }
    catch (e) { setStatus('bridge offline', '#f87171'); }
  }

  const observer = new MutationObserver(() => { clearTimeout(window.__scScanTimer); window.__scScanTimer = setTimeout(scan, 250); });
  const start = async () => {
    await injectPanel();
    seedSeenFromHistory();
    if (document.documentElement) observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
    window.__shuncodeAgentBridge = { scan, invokeTool, fetchTools, stop: () => observer.disconnect() };
  };
  start();
})();
