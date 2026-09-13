import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-worker-adapter-'));
const bundlePath = path.join(bundleDirectory, 'worker-smoke.mjs');

await esbuild.build({
  stdin: {
    contents: `
      export { ApiWorkerAdapter } from ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'extensions', 'shuncode', 'src', 'api-worker-adapter.ts'))};
      export { workerEventToRuntimeTrace } from ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'extensions', 'shuncode', 'src', 'worker-runtime-trace-compat.ts'))};
    `,
    resolveDir: path.resolve(import.meta.dirname, '..'),
    sourcefile: 'worker-smoke-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['es2022'],
  logLevel: 'silent',
});

const { ApiWorkerAdapter, workerEventToRuntimeTrace } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

class FakeRuntime {
  calls = [];
  invocations = [];
  interrupted = false;

  async hello() {
    return {
      name: 'fake-runtime',
      protocolVersion: 1,
      pid: 1,
      node: process.version,
      platform: process.platform,
      tools: ['read_files'],
      capabilities: {
        streamingModelResponses: true,
        ideToolBroker: true,
        imageInput: true,
        recoverableCheckpoints: true,
        cancellation: true,
      },
    };
  }

  async runAgent(params, onTrace, onCheckpoint, invocationContext) {
    this.calls.push(params);
    this.invocations.push(invocationContext);
    onTrace?.({ type: 'model_thinking_delta', step: 0, data: { content: 'think' } });
    onTrace?.({ type: 'model_delta', step: 0, data: { content: 'hello' } });
    onTrace?.({ type: 'tool_call', step: 1, data: { id: 'call-1', name: 'read_files', arguments: { files: [{ path: 'README.md' }] } } });
    onTrace?.({ type: 'tool_result', step: 1, data: { id: 'call-1', name: 'read_files', text: 'ok', isError: false, duration_ms: 17 } });
    onCheckpoint?.({ version: 1, model: params.model, workspaceRoot: params.workspaceRoot, nextStep: 2, toolNames: ['read_files'], messages: [], createdAt: new Date().toISOString() });
    await new Promise(resolve => setTimeout(resolve, 5));
    if (invocationContext?.cancellationToken?.isCancellationRequested) {
      this.interrupted = true;
      return { status: 'interrupted', interruption: { kind: 'cancelled' } };
    }
    return { status: 'completed', answer: 'hello', answerStreamed: true };
  }
}

try {
  const runtime = new FakeRuntime();
  const adapter = new ApiWorkerAdapter(runtime);
  const descriptor = await adapter.describe();
  assert.equal(descriptor.kind, 'api');
  assert.equal(descriptor.availability, 'available');
  assert.equal(descriptor.capabilities.checkpoints, true);

  const session = await adapter.createSession({
    model: 'fake-model',
    workspaceRoot: '/workspace',
    runtime: { baseUrl: 'https://example.invalid/v1' },
  });

  const events = [];
  for await (const event of adapter.send(session, {
    inputId: 'turn-1',
    prompt: 'hello',
    allowedCapabilities: ['read_files'],
    externalCapabilities: [{ name: 'external_tool', inputSchema: { type: 'object' } }],
    runtimeInvocation: { toolInvocationToken: 'opaque-tool-token' },
  })) {
    events.push(event);
  }
  assert.deepEqual(events.map(event => event.type), [
    'reasoning_delta',
    'text_delta',
    'capability_call',
    'capability_result',
    'checkpoint',
    'terminal',
  ]);
  assert.equal(events.at(-1)?.status, 'completed');
  assert.equal(session.state, 'idle');
  assert.deepEqual(runtime.calls[0].allowedTools, ['read_files']);
  assert.equal(runtime.calls[0].externalTools[0].name, 'external_tool');
  assert.equal(runtime.invocations[0].toolInvocationToken, 'opaque-tool-token');
  assert.equal(events.find(event => event.type === 'capability_call').dispatch, 'observed');
  const toolCallTrace = workerEventToRuntimeTrace(events.find(event => event.type === 'capability_call'));
  assert.deepEqual(toolCallTrace, {
    type: 'tool_call',
    step: 1,
    data: { id: 'call-1', name: 'read_files', arguments: { files: [{ path: 'README.md' }] } },
  });
  const toolResultTrace = workerEventToRuntimeTrace(events.find(event => event.type === 'capability_result'));
  assert.deepEqual(toolResultTrace, {
    type: 'tool_result',
    step: 1,
    data: { id: 'call-1', name: 'read_files', text: 'ok', isError: false, duration_ms: 17 },
  });
  assert.equal(workerEventToRuntimeTrace(events.find(event => event.type === 'text_delta'))?.type, 'model_delta');
  assert.equal(workerEventToRuntimeTrace(events.find(event => event.type === 'reasoning_delta'))?.type, 'model_thinking_delta');

  const checkpoint = { version: 1, model: 'fake-model', workspaceRoot: '/workspace', nextStep: 2, toolNames: [], messages: [], createdAt: new Date().toISOString() };
  await adapter.resume(session, checkpoint);
  assert.equal(session.state, 'idle');
  const resumed = [];
  for await (const event of adapter.send(session, { inputId: 'turn-2', prompt: 'continue' })) resumed.push(event);
  assert.deepEqual(runtime.calls[1].checkpoint, checkpoint);
  assert.equal(resumed.at(-1)?.status, 'completed');

  const cancelling = adapter.send(session, { inputId: 'turn-3', prompt: 'cancel me' });
  await adapter.interrupt(session);
  assert.equal(session.state, 'interrupted');
  const cancelled = [];
  for await (const event of cancelling) cancelled.push(event);
  assert.equal(cancelled.at(-1)?.type, 'terminal');
  assert.equal(cancelled.at(-1)?.status, 'cancelled');
  assert.equal(runtime.interrupted, true);

  const health = await adapter.health(session);
  assert.equal(health.status, 'healthy');
  await adapter.dispose(session);
  await assert.rejects(async () => adapter.health(session), /Unknown or disposed worker session/);

  console.log('[smoke] Worker contract + ApiWorkerAdapter streaming/checkpoint/cancel/health ok');
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
