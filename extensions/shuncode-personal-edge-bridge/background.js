const STORAGE_TAB = 'shuncodeSharedTabId';
const STORAGE_CLIENT = 'shuncodeEdgeClientId';
const BRIDGE = 'http://127.0.0.1:48321';
// Local-development pairing token. For packaged releases, replace this together with
// SHUNCODE_PERSONAL_EDGE_TOKEN in the gateway configuration.
const TOKEN = 'shuncode-local-development';
const HEARTBEAT_ALARM = 'shuncodeEdgeHeartbeat';

let sharedTabId = null;
let clientId = '';
let pollLoopRunning = false;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function ensureClientId() {
  const saved = await chrome.storage.local.get([STORAGE_CLIENT]);
  clientId = String(saved[STORAGE_CLIENT] || '');
  if (!clientId) {
    clientId = crypto.randomUUID();
    await chrome.storage.local.set({ [STORAGE_CLIENT]: clientId });
  }
}

async function reportShareState() {
  let tab = null;
  if (sharedTabId != null) {
    try {
      const current = await chrome.tabs.get(sharedTabId);
      tab = { id: current.id, windowId: current.windowId, title: current.title || '', url: current.url || '', active: !!current.active };
    } catch {}
  }
  try {
    await fetch(`${BRIDGE}/control/personal-edge/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: TOKEN, clientId, shared: !!tab, tab }),
      cache: 'no-store',
    });
  } catch {}
}

async function postCommandResult(id, result, error = '') {
  await fetch(`${BRIDGE}/control/personal-edge/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN, clientId, id, result, error }),
    cache: 'no-store',
  });
}

async function getSharedWebTab(command) {
  if (sharedTabId == null || Number(command.tabId) !== sharedTabId) {
    throw new Error('Shared tab changed before command execution');
  }
  const tab = await chrome.tabs.get(sharedTabId);
  if (!/^https?:/i.test(String(tab.url || ''))) {
    throw new Error('Personal Edge tools require a normal http/https page. Share the target web page, not edge:// or another privileged page.');
  }
  return tab;
}

async function waitForTabComplete(tabId, timeoutMs = 8000) {
  try {
    const current = await chrome.tabs.get(tabId);
    if (current.status === 'complete') return current;
  } catch {}
  return await new Promise(resolve => {
    let settled = false;
    const finish = async () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      try { resolve(await chrome.tabs.get(tabId)); }
      catch { resolve(null); }
    };
    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function executeCommand(command) {
  const id = String(command?.id || '');
  if (!id) return;
  try {
    const tab = await getSharedWebTab(command);
    let result;
    if (command.op === 'read') {
      const maxChars = Math.max(1, Math.min(50000, Number(command.maxChars || 20000)));
      const injected = await chrome.scripting.executeScript({
        target: { tabId: sharedTabId },
        func: limit => ({
          title: document.title,
          url: location.href,
          text: String(document.body?.innerText || '').slice(0, limit),
        }),
        args: [maxChars],
      });
      result = injected?.[0]?.result || { title: tab.title || '', url: tab.url || '', text: '' };
    } else if (command.op === 'elements') {
      const maxElements = Math.max(1, Math.min(200, Number(command.maxElements || 100)));
      const injected = await chrome.scripting.executeScript({
        target: { tabId: sharedTabId },
        func: limit => {
          const visible = el => {
            const rect = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
          };
          const selectorFor = el => {
            if (el.id) return `#${CSS.escape(el.id)}`;
            const parts = [];
            let current = el;
            while (current && current.nodeType === 1 && current !== document.documentElement) {
              let part = current.tagName.toLowerCase();
              const parent = current.parentElement;
              if (parent) {
                const sameTag = Array.from(parent.children).filter(child => child.tagName === current.tagName);
                if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
              }
              parts.unshift(part);
              const candidate = parts.join(' > ');
              try { if (document.querySelectorAll(candidate).length === 1) return candidate; } catch {}
              current = parent;
            }
            return parts.join(' > ');
          };
          const nodes = Array.from(document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"]'));
          return nodes.filter(visible).slice(0, limit).map(el => ({
            selector: selectorFor(el),
            tag: el.tagName.toLowerCase(),
            type: String(el.getAttribute('type') || ''),
            role: String(el.getAttribute('role') || ''),
            text: String(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 160),
            ariaLabel: String(el.getAttribute('aria-label') || '').slice(0, 160),
            placeholder: String(el.getAttribute('placeholder') || '').slice(0, 160),
            title: String(el.getAttribute('title') || '').slice(0, 160),
          }));
        },
        args: [maxElements],
      });
      result = { title: tab.title || '', url: tab.url || '', elements: injected?.[0]?.result || [] };
    } else if (command.op === 'click') {
      const selector = String(command.selector || '');
      const injected = await chrome.scripting.executeScript({
        target: { tabId: sharedTabId },
        func: sel => {
          const el = document.querySelector(sel);
          if (!el) throw new Error(`Element not found: ${sel}`);
          el.scrollIntoView({ block: 'center', inline: 'center' });
          if (typeof el.click !== 'function') throw new Error(`Element is not clickable: ${sel}`);
          el.click();
          return { selector: sel, tag: el.tagName.toLowerCase(), text: String(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 200) };
        },
        args: [selector],
      });
      await sleep(250);
      const after = await chrome.tabs.get(sharedTabId);
      result = { ...(injected?.[0]?.result || { selector }), title: after.title || '', url: after.url || '' };
    } else if (command.op === 'fill') {
      const selector = String(command.selector || '');
      const value = String(command.value ?? '');
      const injected = await chrome.scripting.executeScript({
        target: { tabId: sharedTabId },
        func: (sel, nextValue) => {
          const el = document.querySelector(sel);
          if (!el) throw new Error(`Element not found: ${sel}`);
          el.scrollIntoView({ block: 'center', inline: 'center' });
          el.focus();
          if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(el, nextValue); else el.value = nextValue;
          } else if (el.isContentEditable) {
            el.textContent = nextValue;
          } else {
            throw new Error(`Element is not fillable: ${sel}`);
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return { selector: sel, tag: el.tagName.toLowerCase(), length: nextValue.length };
        },
        args: [selector, value],
      });
      result = { ...(injected?.[0]?.result || { selector }), title: tab.title || '', url: tab.url || '' };
    } else if (command.op === 'navigate') {
      const url = String(command.url || '');
      if (!/^https?:\/\//i.test(url)) throw new Error('Navigation only accepts absolute http/https URLs');
      await chrome.tabs.update(sharedTabId, { url });
      const after = await waitForTabComplete(sharedTabId, 8000);
      result = { title: after?.title || '', url: after?.url || url };
    } else if (command.op === 'reload') {
      await chrome.tabs.reload(sharedTabId);
      const after = await waitForTabComplete(sharedTabId, 8000);
      result = { title: after?.title || '', url: after?.url || tab.url || '' };
    } else {
      throw new Error(`Unsupported Personal Edge command: ${command.op}`);
    }
    await postCommandResult(id, result);
  } catch (error) {
    try { await postCommandResult(id, null, error instanceof Error ? error.message : String(error)); } catch {}
  }
}

async function pollLoop() {
  if (pollLoopRunning || sharedTabId == null) return;
  pollLoopRunning = true;
  try {
    while (sharedTabId != null) {
      try {
        const response = await fetch(`${BRIDGE}/control/personal-edge/poll?token=${encodeURIComponent(TOKEN)}&clientId=${encodeURIComponent(clientId)}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Bridge poll HTTP ${response.status}`);
        const body = await response.json();
        if (body?.command) await executeCommand(body.command);
      } catch {
        await sleep(1500);
      }
    }
  } finally {
    pollLoopRunning = false;
  }
}

async function updateBadge() {
  await chrome.action.setBadgeText({ text: sharedTabId == null ? '' : 'ON' });
  await chrome.action.setTitle({
    title: sharedTabId == null
      ? 'Share this tab with ShunCode'
      : 'Stop sharing this tab with ShunCode',
  });
}

async function restoreSharedTab() {
  const saved = await chrome.storage.local.get([STORAGE_TAB]);
  const id = Number(saved[STORAGE_TAB]);
  sharedTabId = Number.isInteger(id) && id >= 0 ? id : null;
  if (sharedTabId != null) {
    try { await chrome.tabs.get(sharedTabId); }
    catch {
      sharedTabId = null;
      await chrome.storage.local.remove(STORAGE_TAB);
    }
  }
  await updateBadge();
  await reportShareState();
  if (sharedTabId != null) pollLoop();
}

chrome.action.onClicked.addListener(async tab => {
  if (!tab?.id) return;
  if (sharedTabId === tab.id) {
    sharedTabId = null;
    await chrome.storage.local.remove(STORAGE_TAB);
  } else {
    sharedTabId = tab.id;
    await chrome.storage.local.set({ [STORAGE_TAB]: tab.id });
  }
  await updateBadge();
  await reportShareState();
  if (sharedTabId != null) pollLoop();
});

chrome.tabs.onRemoved.addListener(async tabId => {
  if (tabId !== sharedTabId) return;
  sharedTabId = null;
  await chrome.storage.local.remove(STORAGE_TAB);
  await updateBadge();
  await reportShareState();
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (tabId !== sharedTabId) return;
  if (!changeInfo.url && !changeInfo.title && changeInfo.status !== 'complete') return;
  await reportShareState();
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== HEARTBEAT_ALARM) return;
  await reportShareState();
});

(async () => {
  await ensureClientId();
  await restoreSharedTab();
  await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
})();
