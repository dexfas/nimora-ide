import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-agent-host-worker-'));
const bundlePath = path.join(bundleDirectory, 'agent-host-worker-smoke.mjs');

await esbuild.build({
  stdin: {
    contents: `
      export { AgentHostWorkerAdapter } from ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'src', 'agent-host-worker-adapter.ts'))};
      export { URI } from ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'src', 'vs', 'base', 'common', 'uri.ts'))};
      export { ActionType } from ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'src', 'vs', 'platform', 'agentHost', 'common', 'state', 'sessionActions.ts'))};
      export { StateComponents } from ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'src', 'vs', 'platform', 'agentHost', 'common', 'state', 'sessionState.ts'))};
    `,
    resolveDir: path.resolve(import.meta.dirname, '..'),
    sourcefile: 'agent-host-worker-smoke-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['es2022'],
  logLevel: 'silent',
});

const { AgentHostWorkerAdapter, URI, ActionType, StateComponents } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

class FakeSubscription {
  value;
  verifiedValue;
  listeners = new Set();
  errorListeners = new Set();

  constructor(value) {
    this.value = value;
    this.verifiedValue = value;
  }

  onDidChange(listener) {
    return { dispose() {} };
  }

  onDidError(listener) {
    this.errorListeners.add(listener);
    return { dispose: () => this.errorListeners.delete(listener) };
  }

  onWillApplyAction() {
    return { dispose() {} };
  }

  onDidApplyAction(listener) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  emit(action, channel) {
    const envelope = { channel, action, serverSeq: 1, origin: undefined };
    for (const listener of [...this.listeners]) listener(envelope);
  }
}

class FakeConnection {
  sessionUri = URI.parse('ahp-session://fake/session-1');
  chatUri = URI.parse('ahp-chat://default/fake');
  rootState = new FakeSubscription({
    agents: [{ provider: 'fake', displayName: 'Fake Agent', description: 'fake', models: [{ id: 'fake-model', provider: 'fake', name: 'Fake Model' }] }],
  });
  sessionState = new FakeSubscription({ resource: this.sessionUri.toString(), defaultChat: this.chatUri.toString() });
  chatState = new FakeSubscription({ resource: this.chatUri.toString(), title: 'Fake', status: 'idle', modifiedAt: new Date().toISOString(), turns: [] });
  dispatches = [];
  disposedSessions = [];

  async createSession(config) {
    this.createConfig = config;
    return this.sessionUri;
  }

  async disposeSession(session) {
    this.disposedSessions.push(session.toString());
  }

  getSubscription(kind) {
    const object = kind === StateComponents.Session ? this.sessionState : this.chatState;
    return { object, dispose() {} };
  }

  dispatch(channel, action) {
    this.dispatches.push({ channel, action });
    if (action.type === ActionType.ChatTurnStarted) {
      if (action.message.text === 'cancel me') return;
      queueMicrotask(() => {
        this.emit({ type: ActionType.ChatResponsePart, turnId: action.turnId, part: { kind: 'markdown', id: 'text-1', content: '' } });
        this.emit({ type: ActionType.ChatDelta, turnId: action.turnId, partId: 'text-1', content: 'hello' });
        this.emit({ type: ActionType.ChatResponsePart, turnId: action.turnId, part: { kind: 'reasoning', id: 'reason-1', content: '' } });
        this.emit({ type: ActionType.ChatReasoning, turnId: action.turnId, partId: 'reason-1', content: 'think' });
        this.emit({ type: ActionType.ChatToolCallStart, turnId: action.turnId, toolCallId: 'tool-1', toolName: 'read_files', displayName: 'Read files' });
        this.emit({ type: ActionType.ChatToolCallReady, turnId: action.turnId, toolCallId: 'tool-1', invocationMessage: 'Reading', toolInput: '{"files":[{"path":"README.md"}]}' });
        this.emit({ type: ActionType.ChatToolCallComplete, turnId: action.turnId, toolCallId: 'tool-1', result: { success: true, pastTenseMessage: 'Read files', content: [{ type: 'text', text: 'ok' }] } });
        this.emit({ type: ActionType.ChatUsage, turnId: action.turnId, usage: { inputTokens: 10, outputTokens: 4, model: 'fake-model' } });
        this.emit({ type: ActionType.ChatTurnComplete, turnId: action.turnId, duration: 12 });
      });
      return;
    }
    if (action.type === ActionType.ChatTurnCancelled) {
      queueMicrotask(() => this.emit({ type: ActionType.ChatTurnCancelled, turnId: action.turnId, duration: 1 }));
    }
  }

  emit(action) {
    this.chatState.emit(action, this.chatUri.toString());
  }
}

try {
  const connection = new FakeConnection();
  const adapter = new AgentHostWorkerAdapter(connection);
  const descriptor = await adapter.describe();
  assert.equal(descriptor.kind, 'agent-host');
  assert.equal(descriptor.availability, 'available');
  assert.deepEqual(descriptor.models, ['fake-model']);

  const session = await adapter.createSession({ provider: 'fake', model: 'fake-model', workspaceRoot: '/workspace' });
  assert.equal(session.sessionId, connection.sessionUri.toString());
  assert.equal(connection.createConfig.provider, 'fake');
  assert.equal(connection.createConfig.model.id, 'fake-model');

  const events = [];
  for await (const event of adapter.send(session, { inputId: 'turn-1', prompt: 'hello' })) events.push(event);
  assert.deepEqual(events.map(event => event.type), [
    'provider_event',
    'text_delta',
    'provider_event',
    'reasoning_delta',
    'provider_event',
    'capability_call',
    'capability_result',
    'usage',
    'terminal',
  ]);
  const capabilityCall = events.find(event => event.type === 'capability_call');
  assert.equal(capabilityCall.name, 'read_files');
  assert.deepEqual(capabilityCall.arguments, { files: [{ path: 'README.md' }] });
  assert.equal(capabilityCall.dispatch, 'observed');
  const capabilityResult = events.find(event => event.type === 'capability_result');
  assert.equal(capabilityResult.name, 'read_files');
  assert.equal(capabilityResult.text, 'ok');
  assert.equal(events.find(event => event.type === 'usage').usage.inputTokens, 10);
  assert.equal(events.at(-1).status, 'completed');
  assert.equal(session.state, 'idle');

  const cancelling = adapter.send(session, { inputId: 'turn-2', prompt: 'cancel me' });
  await adapter.interrupt(session);
  const cancelled = [];
  for await (const event of cancelling) cancelled.push(event);
  assert.equal(cancelled.at(-1).type, 'terminal');
  assert.equal(cancelled.at(-1).status, 'cancelled');
  assert.equal(session.state, 'interrupted');

  const health = await adapter.health(session);
  assert.equal(health.status, 'healthy');
  await adapter.dispose(session);
  assert.deepEqual(connection.disposedSessions, [connection.sessionUri.toString()]);
  await assert.rejects(async () => adapter.health(session), /Unknown or disposed worker session/);

  const attachedAdapter = new AgentHostWorkerAdapter(connection, 'nimora.agent-host.attached');
  const attached = await attachedAdapter.createSession({ provider: 'fake', model: 'fake-model', backendSession: connection.sessionUri });
  await attachedAdapter.dispose(attached);
  assert.deepEqual(connection.disposedSessions, [connection.sessionUri.toString()]);

  console.log('[smoke] AgentHostWorkerAdapter AHP send/stream/tool/usage/cancel/health ok');
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
