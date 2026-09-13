import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-webmcp-command-transport-'));
const bundlePath = path.join(bundleDirectory, 'transport.mjs');

await esbuild.build({
  entryPoints: [path.resolve(import.meta.dirname, '..', 'extensions', 'shuncode', 'src', 'webmcp-worker-transport.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['es2022'],
  logLevel: 'silent',
});

const { WebMcpCommandTransport } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

class FakeCommands {
  calls = [];
  pollCount = 0;
  interrupted = false;
  mode = 'completed';

  async executeCommand(command, arg) {
    this.calls.push({ command, arg });
    if (command === '_shuncode.webMcp.workerConnect') {
      return {
        pageId: 'page-1',
        sessionId: 'page-session-1',
        site: 'deepseek',
        origin: 'https://chat.deepseek.com',
        href: 'https://chat.deepseek.com/chat',
        transport: 'http',
        status: { enabled: true, composerFound: true },
      };
    }
    if (command === '_shuncode.webMcp.workerSend') {
      this.pollCount = 0;
      return {
        inputId: arg.input.inputId,
        state: 'running',
        text: '',
        events: [
          { seq: 1, type: 'status', name: 'sending' },
          { seq: 2, type: 'status', name: 'sent' },
        ],
      };
    }
    if (command === '_shuncode.webMcp.workerPoll') {
      this.pollCount += 1;
      if (this.mode === 'interrupt' && this.interrupted) {
        return {
          inputId: arg.inputId,
          state: 'cancelled',
          text: '',
          events: [
            { seq: 1, type: 'status', name: 'sending' },
            { seq: 2, type: 'status', name: 'sent' },
            { seq: 3, type: 'cancelled', interrupted: true },
          ],
        };
      }
      if (this.mode === 'interrupt') {
        return {
          inputId: arg.inputId,
          state: 'running',
          text: '',
          events: [
            { seq: 1, type: 'status', name: 'sending' },
            { seq: 2, type: 'status', name: 'sent' },
          ],
        };
      }
      return {
        inputId: arg.inputId,
        state: 'completed',
        text: 'done',
        events: [
          { seq: 1, type: 'status', name: 'sending' },
          { seq: 2, type: 'status', name: 'sent' },
          { seq: 3, type: 'assistant_text', text: 'working ' },
          { seq: 4, type: 'capability_call', callId: 'call-1', name: 'read_files', arguments: { files: [{ path: 'README.md' }] } },
          { seq: 5, type: 'capability_result', callId: 'call-1', name: 'read_files', text: 'ok', isError: false },
          { seq: 6, type: 'assistant_text', text: 'done' },
          { seq: 7, type: 'completed', text: 'done' },
        ],
      };
    }
    if (command === '_shuncode.webMcp.workerInterrupt') {
      this.interrupted = true;
      return { interrupted: true };
    }
    if (command === '_shuncode.webMcp.workerResolve') {
      return { inputId: arg.result.inputId, state: 'running', events: [] };
    }
    if (command === '_shuncode.webMcp.workerHealth') {
      return { status: { enabled: true, composerFound: true, isDeepSeekAuthPage: false } };
    }
    if (command === '_shuncode.webMcp.workerDisconnect') return { disconnected: true };
    throw new Error(`Unexpected command ${command}`);
  }
}

try {
  const commands = new FakeCommands();
  const transport = new WebMcpCommandTransport(commands, { pollIntervalMs: 1, now: () => new Date('2026-09-13T00:00:00.000Z') });
  const descriptor = await transport.describe();
  assert.equal(descriptor.id, 'webmcp.integrated-browser');
  assert.equal(descriptor.capabilities.interruption, true);

  const session = await transport.connect({ model: 'web-model', contextHandle: 'task-context' });
  assert.equal(session.sessionId, 'page-session-1');
  assert.equal(session.extensions.pageId, 'page-1');
  assert.equal(session.createdAt, '2026-09-13T00:00:00.000Z');

  await transport.submitCapabilityResult(session, {
    inputId: 'host-turn-1',
    callId: 'host-call-1',
    name: 'read_files',
    text: 'HOST_RESULT_OK',
  });
  const resolveCall = commands.calls.find(call => call.command === '_shuncode.webMcp.workerResolve');
  assert.equal(resolveCall.arg.pageId, 'page-1');
  assert.equal(resolveCall.arg.sessionId, 'page-session-1');
  assert.deepEqual(resolveCall.arg.result, {
    inputId: 'host-turn-1',
    callId: 'host-call-1',
    name: 'read_files',
    text: 'HOST_RESULT_OK',
  });

  const events = [];
  for await (const event of transport.send(session, { inputId: 'turn-1', prompt: 'do the task' })) events.push(event);
  assert.deepEqual(events.map(event => event.type), [
    'status', 'status', 'assistant_text', 'capability_call', 'capability_result', 'assistant_text', 'completed',
  ]);
  assert.equal(events.find(event => event.type === 'capability_call').name, 'read_files');
  assert.equal(events.filter(event => event.type === 'status' && event.name === 'sending').length, 1, 'event cursor must suppress replayed page events');
  assert.equal(events.at(-1).result.text, 'done');
  assert.equal((await transport.health(session)).status, 'healthy');

  commands.mode = 'interrupt';
  commands.interrupted = false;
  const cancelling = transport.send(session, { inputId: 'turn-2', prompt: 'long task' });
  const iterator = cancelling[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.type, 'status');
  await transport.interrupt(session);
  const remaining = [];
  for (;;) {
    const next = await iterator.next();
    if (next.done) break;
    remaining.push(next.value);
  }
  assert.equal(remaining.at(-1).type, 'cancelled');
  assert.ok(commands.calls.some(call => call.command === '_shuncode.webMcp.workerInterrupt' && call.arg.inputId === 'turn-2'));

  await transport.disconnect(session);
  assert.ok(commands.calls.some(call => call.command === '_shuncode.webMcp.workerDisconnect'));
  console.log('[smoke] WebMcpCommandTransport command bridge/cursor/terminal/interrupt/health/disconnect ok');
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
