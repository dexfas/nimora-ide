import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-web-worker-bundle-'));
const bundlePath = path.join(bundleDirectory, 'web-worker-smoke.mjs');

await esbuild.build({
  entryPoints: [path.resolve(import.meta.dirname, '..', 'src', 'web-worker-adapter.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['es2022'],
  logLevel: 'silent',
});

const { WebWorkerAdapter } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

class FakeWebTransport {
  disconnected = [];
  interrupted = [];
  submittedResults = [];
  lastInput = null;

  async describe() {
    return {
      id: 'webmcp.fake',
      label: 'Fake Web AI',
      site: 'fake.example',
      availability: 'available',
      models: ['web-model'],
      capabilities: { streaming: true, reasoning: true, interruption: true },
    };
  }

  async connect(options) {
    this.connectOptions = options;
    return {
      sessionId: 'page-session-1',
      site: 'fake.example',
      origin: 'https://fake.example',
      href: 'https://fake.example/chat',
      model: options.model,
      createdAt: '2026-09-13T00:00:00.000Z',
    };
  }

  async *send(_session, input) {
    this.lastInput = input;
    yield { type: 'assistant_text', text: 'working ' };
    yield { type: 'reasoning', text: 'checking' };
    yield { type: 'capability_call', callId: 'call-1', name: 'read_files', arguments: { files: [{ path: 'README.md' }] }, dispatch: 'observed' };
    yield { type: 'capability_result', callId: 'call-1', name: 'read_files', text: 'ok', isError: false };
    yield { type: 'status', name: 'site', data: { lane: 'A' } };
    yield { type: 'usage', usage: { inputTokens: 12 } };
    yield { type: 'assistant_text', text: 'done' };
    yield { type: 'completed', result: { final: true } };
  }

  async interrupt(session) {
    this.interrupted.push(session.sessionId);
  }

  async submitCapabilityResult(session, result) {
    this.submittedResults.push({ sessionId: session.sessionId, result });
  }

  async health() {
    return { status: 'healthy', checkedAt: '2026-09-13T00:00:00.000Z' };
  }

  async disconnect(session) {
    this.disconnected.push(session.sessionId);
  }
}

try {
  const transport = new FakeWebTransport();
  const adapter = new WebWorkerAdapter(transport);
  const descriptor = await adapter.describe();
  assert.equal(descriptor.kind, 'web');
  assert.equal(descriptor.provider, 'webmcp.fake');
  assert.equal(descriptor.capabilities.streaming, true);
  assert.equal(descriptor.capabilities.reasoning, true);
  assert.equal(descriptor.capabilities.imageInput, false);

  const session = await adapter.createSession({ model: 'web-model', contextHandle: 'task-context', transport: { lane: 'A' } });
  assert.equal(session.sessionId, 'page-session-1');
  assert.equal(session.extensions.origin, 'https://fake.example');
  assert.equal(transport.connectOptions.extensions.lane, 'A');

  const events = [];
  for await (const event of adapter.send(session, {
    inputId: 'turn-1',
    prompt: 'continue task',
    allowedCapabilities: ['workspace.read'],
    modeInstructions: 'review only',
  })) events.push(event);
  assert.deepEqual(events.map(event => event.type), [
    'text_delta', 'reasoning_delta', 'capability_call', 'capability_result', 'provider_event', 'usage', 'text_delta', 'terminal',
  ]);
  assert.equal(events.find(event => event.type === 'capability_call').name, 'read_files');
  assert.equal(events.find(event => event.type === 'capability_call').dispatch, 'observed');
  assert.equal(events.at(-1).status, 'completed');
  assert.deepEqual(transport.lastInput.allowedCapabilities, ['workspace.read']);
  assert.equal(session.state, 'idle');

  await assert.rejects(async () => {
    for await (const _event of adapter.send(session, { inputId: 'turn-image', prompt: 'image', images: [{ mimeType: 'image/png', data: 'x' }] })) {}
  }, /does not support image input/);

  transport.send = async function* (_session, input) {
    yield { type: 'assistant_text', text: input.prompt };
    await new Promise(resolve => setTimeout(resolve, 10));
    yield { type: 'cancelled' };
  };
  const cancelling = adapter.send(session, { inputId: 'turn-2', prompt: 'cancel me' });
  const iterator = cancelling[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, 'text_delta');
  await assert.rejects(
    () => adapter.submitCapabilityResult(session, { inputId: 'wrong-turn', callId: 'host-call-1', name: 'read_files', text: 'wrong' }),
    /does not match the active input/,
  );
  await adapter.submitCapabilityResult(session, { inputId: 'turn-2', callId: 'host-call-1', name: 'read_files', text: 'HOST_RESULT_OK' });
  assert.deepEqual(transport.submittedResults, [{
    sessionId: 'page-session-1',
    result: { inputId: 'turn-2', callId: 'host-call-1', name: 'read_files', text: 'HOST_RESULT_OK' },
  }]);
  await adapter.interrupt(session);
  assert.deepEqual(transport.interrupted, ['page-session-1']);
  assert.equal((await iterator.next()).value.status, 'cancelled');

  assert.equal((await adapter.health(session)).status, 'healthy');
  await adapter.dispose(session);
  assert.deepEqual(transport.disconnected, ['page-session-1']);
  await assert.rejects(async () => adapter.health(session), /Unknown or disposed web worker session/);

  const missingTerminalTransport = new FakeWebTransport();
  missingTerminalTransport.send = async function* () { yield { type: 'assistant_text', text: 'partial' }; };
  const missingTerminalAdapter = new WebWorkerAdapter(missingTerminalTransport, 'nimora.web-worker.missing-terminal');
  const missingTerminalSession = await missingTerminalAdapter.createSession({});
  const missingTerminalEvents = [];
  for await (const event of missingTerminalAdapter.send(missingTerminalSession, { inputId: 'turn-3', prompt: 'test' })) missingTerminalEvents.push(event);
  assert.equal(missingTerminalEvents.at(-1).status, 'error');
  assert.match(missingTerminalEvents.at(-1).error, /without a terminal event/);
  await missingTerminalAdapter.dispose(missingTerminalSession);

  const conservativeTransport = new FakeWebTransport();
  conservativeTransport.describe = async () => ({ id: 'webmcp.conservative', label: 'Conservative Web', availability: 'available' });
  const conservativeAdapter = new WebWorkerAdapter(conservativeTransport, 'nimora.web-worker.conservative');
  assert.equal((await conservativeAdapter.describe()).capabilities.streaming, false, 'adapter must not advertise transport features that were not declared');

  console.log('[smoke] WebWorkerAdapter transport mapping/session/cancel/terminal guard ok');
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
