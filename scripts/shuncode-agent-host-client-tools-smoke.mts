import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const esbuild = require('esbuild');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-client-tools-'));
const outfile = path.join(directory, 'test.mjs');
await esbuild.build({ stdin: { contents: `
export { AgentHostClientToolBridge } from ${JSON.stringify(path.join(root, 'src/agent-host-client-tool-bridge.ts'))};
export { URI } from ${JSON.stringify(path.join(root, 'src/vs/base/common/uri.ts'))};
export { ActionType } from ${JSON.stringify(path.join(root, 'src/vs/platform/agentHost/common/state/sessionActions.ts'))};
export { StateComponents } from ${JSON.stringify(path.join(root, 'src/vs/platform/agentHost/common/state/sessionState.ts'))};
`, resolveDir: root, loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent' });
const { AgentHostClientToolBridge, URI, ActionType, StateComponents } = await import(pathToFileURL(outfile).href);
class Subscription {
  listeners = new Set();
  value;
  constructor(value) { this.value = value; }
  onDidApplyAction(listener) { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
  onDidChange() { return { dispose() {} }; }
  onDidError() { return { dispose() {} }; }
  emit(action, origin?) { for (const listener of [...this.listeners]) listener({ channel: 'ahp-chat://default/test', action, origin, serverSeq: 1 }); }
}
class Connection {
  clientId = 'owner';
  session = URI.parse('copilotcli:/owned');
  chat = 'ahp-chat://default/test';
  rootState = new Subscription({ agents: [{ provider: 'copilotcli', models: [{ id: 'model', name: 'model' }] }],
    config: { schema: { properties: { clientToolScopeProtocolVersion: { enum: [1], readOnly: true } } } } });
  sessionState = new Subscription({ resource: this.session.toString(), defaultChat: this.chat });
  chatState = new Subscription({ resource: this.chat, turns: [], status: 'idle' });
  config;
  turnId;
  results = [];
  async createSession(config) { this.config = config; return this.session; }
  async disposeSession() {}
  getSubscription(kind) { return { object: kind === StateComponents.Session ? this.sessionState : this.chatState, dispose() {} }; }
  dispatch(channel, action) {
    if (action.type === ActionType.ChatTurnStarted) {
      this.turnId = action.turnId;
      queueMicrotask(() => {
        this.emit({ type: ActionType.ChatToolCallStart, toolCallId: 'call-1', toolName: 'mission_read' });
        // SDK's early unmarked observation must not run a tool.
        this.emit({ type: ActionType.ChatToolCallReady, toolCallId: 'call-1', toolInput: '{}' });
        const scope = JSON.parse(this.config.config.clientToolScope);
        this.emit({ type: ActionType.ChatToolCallReady, toolCallId: 'call-1', toolInput: '{"path":"test.txt"}',
          _meta: { clientToolScopeRequest: { version: 1, scopeId: scope.scopeId, clientId: scope.clientId } } });
        // Duplicate server Ready must not run a tool twice.
        this.emit({ type: ActionType.ChatToolCallReady, toolCallId: 'call-1', toolInput: '{}',
          _meta: { clientToolScopeRequest: { version: 1, scopeId: scope.scopeId, clientId: scope.clientId } } });
      });
    } else if (action.type === ActionType.ChatToolCallComplete) {
      this.results.push(action);
      // Client echo with a forged receipt is not an SDK acknowledgement.
      const scope = JSON.parse(this.config.config.clientToolScope);
      this.chatState.emit({ ...action, _meta: { clientToolScopeReceipt: scope } }, { clientId: this.clientId, clientSeq: 2 });
    } else if (action.type === ActionType.ChatTurnCancelled) this.emit(action);
  }
  emit(action) { this.chatState.emit({ turnId: this.turnId, ...action }); }
  receipt() {
    const scope = JSON.parse(this.config.config.clientToolScope);
    this.emit({ ...this.results[0], _meta: { clientToolScopeReceipt: { version: 1, scopeId: scope.scopeId, clientId: scope.clientId } } });
  }
}
const input = { inputId: 'fresh-1', prompt: 'read', externalCapabilities: [{ name: 'mission_read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }] };
async function drain(bridge, handle, until) {
  const events = [];
  for (let i = 0; i < 10; i++) { const batch = await bridge.poll(handle); events.push(...batch.events); if (until(events, batch.active)) return events; }
  throw new Error('Test did not receive expected event');
}
try {
  const oldHost = new Connection(); oldHost.rootState.value.config = undefined;
  assert.throws(() => new AgentHostClientToolBridge(oldHost).create({ provider: 'copilotcli' }), /server does not advertise/);
  assert.equal(oldHost.config, undefined);
  const connection = new Connection(), bridge = new AgentHostClientToolBridge(connection);
  const handle = bridge.create({ provider: 'copilotcli', model: 'model' });
  assert.equal(connection.config, undefined, 'logical allocation must not send a provider turn');
  bridge.start(handle, input);
  const events = await drain(bridge, handle, items => items.some(item => item.type === 'capability_call'));
  const calls = events.filter(event => event.type === 'capability_call'); assert.equal(calls.length, 1);
  assert.equal(calls[0].dispatch, 'host-requested'); assert.equal(calls[0].name, 'mission_read');
  assert.deepEqual(calls[0].arguments, { path: 'test.txt' });
  assert.equal(connection.config.provider, 'copilotcli');
  assert.deepEqual(connection.config.activeClient.tools, input.externalCapabilities.map(tool => ({ ...tool, description: undefined })));
  let delivered = false;
  const result = { inputId: input.inputId, callId: 'call-1', name: 'mission_read', text: 'content' };
  const delivery = bridge.complete(handle, result).then(() => { delivered = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(delivered, false, 'client echo must not acknowledge delivery');
  await assert.rejects(() => bridge.complete(handle, result), /consumed/);
  connection.receipt(); await delivery;
  assert.equal(delivered, true); assert.equal(connection.results.length, 1);
  connection.emit({ type: ActionType.ChatTurnComplete, duration: 1 });
  const final = await drain(bridge, handle, (_events, active) => !active);
  assert.equal(final.filter(event => event.type === 'capability_result').length, 1);
  assert.equal(final.at(-1).status, 'completed');
  bridge.start(handle, input);
  const replay = await drain(bridge, handle, (_events, active) => !active);
  assert.match(replay.at(-1).error, /consumed/); assert.equal(connection.results.length, 1);
  bridge.start(handle, { ...input, inputId: 'drift', externalCapabilities: [] });
  assert.match((await drain(bridge, handle, (_events, active) => !active)).at(-1).error, /frozen/i);
  await bridge.dispose(handle); assert.equal(connection.chatState.listeners.size, 0);
  await assert.rejects(() => bridge.complete(handle, result), /Unknown/);

  const cancelling = new Connection(), cancelBridge = new AgentHostClientToolBridge(cancelling);
  const cancelHandle = cancelBridge.create({ provider: 'copilotcli', model: 'model' });
  cancelBridge.start(cancelHandle, { ...input, inputId: 'cancel-fresh' });
  await drain(cancelBridge, cancelHandle, items => items.some(item => item.type === 'capability_call'));
  const cancelDelivery = cancelBridge.complete(cancelHandle, { ...result, inputId: 'cancel-fresh' });
  const cancelled = assert.rejects(cancelDelivery, /interrupted|ended/);
  await cancelBridge.interrupt(cancelHandle); await cancelled;
  await drain(cancelBridge, cancelHandle, (_events, active) => !active); await cancelBridge.dispose(cancelHandle);
  console.log('Scoped AgentHost bridge PASS: fresh allocation, frozen schemas, server-only requests, exactly one execution, SDK receipt versus echo, result replay refusal, input replay refusal, schema drift, cancellation and listener cleanup. No real Provider contacted.');
} finally {
  const resolved = path.resolve(directory);
  assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('nimora-client-tools-'));
  await fs.rm(resolved, { recursive: true, force: true });
}
