import { randomUUID } from 'node:crypto';
import { defineGatewayCapability } from './capability-contract.mjs';
import { defineGatewayProvider } from './provider-registry.mjs';

const personalEdgeMetadata = (id, title, risk, idempotency, retry, approval, { destructive = false, tags = [] } = {}) => ({
  id,
  version: 1,
  title,
  category: 'browser',
  tags,
  environment: 'personal-browser',
  risk,
  idempotency,
  retry,
  approval,
  destructive,
  openWorld: true,
});

const personalEdgeTools = [
  defineGatewayCapability({ name: 'personal_edge_status', description: 'PERSONAL EDGE BRIDGE: report whether the user explicitly shared a tab from their normal Microsoft Edge and return that tab metadata.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, personalEdgeMetadata('browser.personal.status', 'Personal Edge Status', 'read', 'safe', 'automatic', 'none', { tags: ['browser', 'personal', 'read'] })),
  defineGatewayCapability({ name: 'personal_edge_read', description: 'PERSONAL EDGE BRIDGE (READ ONLY): read title, URL and visible body text from the single normal http/https Edge tab the user explicitly shared. Does not click, type, navigate, or evaluate arbitrary JavaScript.', inputSchema: { type: 'object', properties: { max_chars: { type: 'integer', minimum: 1, maximum: 50000, default: 20000 } }, additionalProperties: false } }, personalEdgeMetadata('browser.personal.read', 'Read Personal Edge Page', 'read', 'safe', 'automatic', 'none', { tags: ['browser', 'personal', 'read'] })),
  defineGatewayCapability({ name: 'personal_edge_elements', description: 'PERSONAL EDGE BRIDGE (READ ONLY): inspect visible interactive elements in the shared personal Edge tab. Returns generated CSS selectors plus safe metadata such as tag/text/role/placeholder; does not return current input values.', inputSchema: { type: 'object', properties: { max_elements: { type: 'integer', minimum: 1, maximum: 200, default: 100 } }, additionalProperties: false } }, personalEdgeMetadata('browser.personal.elements', 'Inspect Personal Edge Elements', 'read', 'safe', 'automatic', 'none', { tags: ['browser', 'personal', 'read', 'elements'] })),
  defineGatewayCapability({ name: 'personal_edge_click', description: 'PERSONAL EDGE BRIDGE: click one element in the user-shared personal Edge tab by CSS selector. This can cause account/page side effects and is subject to WebMCP approval.', inputSchema: { type: 'object', required: ['selector'], properties: { selector: { type: 'string', minLength: 1 } }, additionalProperties: false } }, personalEdgeMetadata('browser.personal.click', 'Click Personal Edge Element', 'external-side-effect', 'non-idempotent', 'never', 'session', { destructive: true, tags: ['browser', 'personal', 'interaction'] })),
  defineGatewayCapability({ name: 'personal_edge_fill', description: 'PERSONAL EDGE BRIDGE: replace text in an input, textarea, or contenteditable element in the user-shared personal Edge tab. Subject to WebMCP approval.', inputSchema: { type: 'object', required: ['selector', 'value'], properties: { selector: { type: 'string', minLength: 1 }, value: { type: 'string' } }, additionalProperties: false } }, personalEdgeMetadata('browser.personal.fill', 'Fill Personal Edge Field', 'external-side-effect', 'non-idempotent', 'never', 'session', { destructive: true, tags: ['browser', 'personal', 'interaction'] })),
  defineGatewayCapability({ name: 'personal_edge_navigate', description: 'PERSONAL EDGE BRIDGE: navigate the user-shared personal Edge tab to an http/https URL. The same tab remains shared. Subject to WebMCP approval.', inputSchema: { type: 'object', required: ['url'], properties: { url: { type: 'string', minLength: 1 } }, additionalProperties: false } }, personalEdgeMetadata('browser.personal.navigate', 'Navigate Personal Edge', 'external-side-effect', 'non-idempotent', 'never', 'session', { destructive: true, tags: ['browser', 'personal', 'navigate'] })),
  defineGatewayCapability({ name: 'personal_edge_reload', description: 'PERSONAL EDGE BRIDGE: reload the user-shared personal Edge tab. Subject to WebMCP approval because it can discard transient page state.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }, personalEdgeMetadata('browser.personal.reload', 'Reload Personal Edge', 'external-side-effect', 'non-idempotent', 'never', 'session', { destructive: true, tags: ['browser', 'personal', 'navigate'] })),
];

function textResult(text, structuredContent) {
  return { content: [{ type: 'text', text }], ...(structuredContent ? { structuredContent } : {}) };
}

export class PersonalEdgeControlError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = 'PersonalEdgeControlError';
    this.statusCode = statusCode;
  }
}

export class PersonalEdgePollAbortedError extends Error {
  constructor() {
    super('Personal Edge poll disconnected.');
    this.name = 'PersonalEdgePollAbortedError';
  }
}

export function createPersonalEdgeProvider({
  token,
  now = Date.now,
  newId = randomUUID,
  commandTimeoutMs = 15000,
  pollTimeoutMs = 20000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let client = { clientId: '', shared: false, lastSeen: 0, tab: null };
  const commandQueue = [];
  const pendingResults = new Map();
  const pollWaiters = [];

  function assertToken(value) {
    if (String(value || '') !== token) throw new PersonalEdgeControlError(403, 'invalid personal Edge bridge token');
  }

  function assertClient(clientId) {
    const normalized = String(clientId || '').trim();
    if (!normalized || normalized !== client.clientId) {
      throw new PersonalEdgeControlError(409, 'personal Edge client is not the active registered client');
    }
    return normalized;
  }

  function status() {
    const connected = !!client.clientId && now() - client.lastSeen < 90000;
    return {
      connected,
      shared: connected && !!client.shared,
      lastSeen: client.lastSeen || null,
      tab: connected && client.shared ? client.tab || null : null,
    };
  }

  function sharedTab() {
    const current = status();
    if (!current.connected) throw new Error('Personal Edge Bridge is not connected. Make sure the Edge extension is installed and active.');
    if (!current.shared || !current.tab) throw new Error('No Personal Edge tab is shared. Click the ShunCode Personal Edge Bridge extension on the target tab so its badge shows ON.');
    if (!/^https?:/i.test(String(current.tab.url || ''))) throw new Error('The shared Personal Edge tab is a privileged/non-web page. Share a normal http/https page instead.');
    return current.tab;
  }

  function register(input = {}) {
    assertToken(input.token);
    const clientId = String(input.clientId || '').trim();
    if (!clientId) throw new PersonalEdgeControlError(400, 'clientId is required');
    client = {
      clientId,
      shared: input.shared === true,
      lastSeen: now(),
      tab: input.tab && typeof input.tab === 'object' ? input.tab : null,
    };
    return status();
  }

  function takeQueuedCommand() {
    while (commandQueue.length) {
      const command = commandQueue.shift();
      if (pendingResults.has(command.id)) return command;
    }
    return null;
  }

  function dispatchCommand(command) {
    while (pollWaiters.length) {
      const waiter = pollWaiters.shift();
      if (waiter.finish(command)) return;
    }
    commandQueue.push(command);
  }

  function requestCommand(command) {
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => {
        pendingResults.delete(command.id);
        const index = commandQueue.findIndex(item => item.id === command.id);
        if (index >= 0) commandQueue.splice(index, 1);
        reject(new Error('Personal Edge command timed out waiting for the shared tab extension'));
      }, commandTimeoutMs);
      pendingResults.set(command.id, { resolve, reject, timer });
      dispatchCommand(command);
    });
  }

  function poll({ token: providedToken, clientId, signal } = {}) {
    assertToken(providedToken);
    assertClient(clientId);
    const queued = takeQueuedCommand();
    if (queued) return Promise.resolve(queued);

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const waiter = {
        finish(command) {
          if (settled) return false;
          settled = true;
          if (timer) clearTimer(timer);
          signal?.removeEventListener?.('abort', onAbort);
          const index = pollWaiters.indexOf(waiter);
          if (index >= 0) pollWaiters.splice(index, 1);
          resolve(command || null);
          return true;
        },
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimer(timer);
        const index = pollWaiters.indexOf(waiter);
        if (index >= 0) pollWaiters.splice(index, 1);
        reject(new PersonalEdgePollAbortedError());
      };
      timer = setTimer(() => waiter.finish(null), pollTimeoutMs);
      pollWaiters.push(waiter);
      if (signal?.aborted) onAbort();
      else signal?.addEventListener?.('abort', onAbort, { once: true });
    });
  }

  function submitResult(input = {}) {
    assertToken(input.token);
    assertClient(input.clientId);
    const id = String(input.id || '').trim();
    const pending = pendingResults.get(id);
    if (!pending) throw new PersonalEdgeControlError(410, 'personal Edge command is no longer pending');
    pendingResults.delete(id);
    clearTimer(pending.timer);
    const errorText = String(input.error || '').trim();
    if (errorText) pending.reject(new Error(errorText));
    else pending.resolve(input.result ?? null);
  }

  async function callTool(name, args = {}) {
    if (name === 'personal_edge_status') {
      const data = status();
      return textResult(JSON.stringify(data, null, 2), data);
    }
    const tab = sharedTab();
    if (name === 'personal_edge_read') {
      const maxChars = Math.max(1, Math.min(50000, Number(args.max_chars || 20000)));
      const data = await requestCommand({ id: newId(), op: 'read', tabId: Number(tab.id), maxChars });
      return textResult(JSON.stringify(data, null, 2), data);
    }
    if (name === 'personal_edge_elements') {
      const maxElements = Math.max(1, Math.min(200, Number(args.max_elements || 100)));
      const data = await requestCommand({ id: newId(), op: 'elements', tabId: Number(tab.id), maxElements });
      return textResult(JSON.stringify(data, null, 2), data);
    }
    if (name === 'personal_edge_click') {
      const selector = String(args.selector || '').trim();
      if (!selector) throw new Error('personal_edge_click requires selector');
      const data = await requestCommand({ id: newId(), op: 'click', tabId: Number(tab.id), selector });
      return textResult(JSON.stringify(data, null, 2), data);
    }
    if (name === 'personal_edge_fill') {
      const selector = String(args.selector || '').trim();
      if (!selector) throw new Error('personal_edge_fill requires selector');
      const data = await requestCommand({ id: newId(), op: 'fill', tabId: Number(tab.id), selector, value: String(args.value ?? '') });
      return textResult(JSON.stringify(data, null, 2), data);
    }
    if (name === 'personal_edge_navigate') {
      const url = String(args.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('personal_edge_navigate only accepts absolute http/https URLs');
      const data = await requestCommand({ id: newId(), op: 'navigate', tabId: Number(tab.id), url });
      return textResult(JSON.stringify(data, null, 2), data);
    }
    if (name === 'personal_edge_reload') {
      const data = await requestCommand({ id: newId(), op: 'reload', tabId: Number(tab.id) });
      return textResult(JSON.stringify(data, null, 2), data);
    }
    throw new Error(`Unknown Personal Edge tool: ${name}`);
  }

  return defineGatewayProvider({
    id: 'personal-edge',
    listTools: async () => personalEdgeTools,
    owns: name => personalEdgeTools.some(tool => tool.name === name),
    callTool,
    status,
    register,
    poll,
    submitResult,
  });
}
