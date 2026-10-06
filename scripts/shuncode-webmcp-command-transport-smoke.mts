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
  currentHref = 'https://chat.deepseek.com/chat';

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
      if (arg.input.inputId === 'turn-canonical-1') this.currentHref = 'https://chat.deepseek.com/a/chat/s/CANONICAL-ONE';
      return {
        inputId: arg.input.inputId,
        state: 'running',
        text: '',
        controlLineage: { sessionId: 'page-session-1', origin: 'https://chat.deepseek.com', href: this.currentHref, site: 'deepseek' },
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
        controlLineage: { sessionId: 'page-session-1', origin: 'https://chat.deepseek.com', href: this.currentHref, site: 'deepseek' },
        events: [
          { seq: 1, type: 'status', name: 'sending' },
          { seq: 2, type: 'status', name: 'sent' },
          { seq: 3, type: 'assistant_text', text: 'working ' },
          { seq: 4, type: 'capability_call', callId: 'call-1', name: 'read_files', occurrenceId: 'deepseek-message:21::call:1::provider:call-1', arguments: { files: [{ path: 'README.md' }] } },
          { seq: 5, type: 'capability_result', callId: 'call-1', name: 'read_files', occurrenceId: 'deepseek-message:21::call:1::provider:call-1', text: 'ok', isError: false },
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

  const exactTarget = {
    pageId: 'page-1', resourceIdentity: 'a'.repeat(64), pageSessionId: 'page-session-1',
    origin: 'https://chat.deepseek.com', href: 'https://chat.deepseek.com/chat', site: 'deepseek',
  };
  const session = await transport.connect({ model: 'web-model', contextHandle: 'task-context', extensions: { webMcpTarget: exactTarget } });
  assert.equal(session.sessionId, 'page-session-1');
  assert.equal(session.extensions.pageId, 'page-1');
  assert.equal(session.createdAt, '2026-09-13T00:00:00.000Z');
  const connectCall = commands.calls.find(call => call.command === '_shuncode.webMcp.workerConnect');
  assert.deepEqual(connectCall.arg.target, exactTarget, 'exact WebMCP target must be forwarded explicitly to workerConnect');

  await transport.submitCapabilityResult(session, {
    inputId: 'host-turn-1',
    callId: 'host-call-1',
    name: 'read_files',
    text: 'HOST_RESULT_OK',
    extensions: { occurrenceId: 'host-occurrence-1' },
  });
  const resolveCall = commands.calls.find(call => call.command === '_shuncode.webMcp.workerResolve');
  assert.equal(resolveCall.arg.pageId, 'page-1');
  assert.equal(resolveCall.arg.sessionId, 'page-session-1');
  assert.equal(resolveCall.arg.expectedOrigin, 'https://chat.deepseek.com');
  assert.equal(resolveCall.arg.expectedHref, 'https://chat.deepseek.com/chat');
  assert.equal(resolveCall.arg.expectedSite, 'deepseek');
  assert.deepEqual(resolveCall.arg.result, {
    inputId: 'host-turn-1',
    callId: 'host-call-1',
    name: 'read_files',
    text: 'HOST_RESULT_OK',
    extensions: { occurrenceId: 'host-occurrence-1' },
  });

  const events = [];
  for await (const event of transport.send(session, { inputId: 'turn-1', prompt: 'do the task' })) events.push(event);
  const sendCall = commands.calls.find(call => call.command === '_shuncode.webMcp.workerSend' && call.arg.input?.inputId === 'turn-1');
  assert.equal(sendCall.arg.expectedHref, session.href, 'workerSend expectedHref must derive from the connected WebWorkerTransportSession');
  assert.equal(sendCall.arg.expectedOrigin, session.origin);
  assert.equal(sendCall.arg.expectedSite, session.site);
  assert.deepEqual(events.map(event => event.type), [
    'status', 'status', 'assistant_text', 'capability_call', 'capability_result', 'assistant_text', 'completed',
  ]);
  assert.equal(events.find(event => event.type === 'capability_call').name, 'read_files');
  assert.equal(events.find(event => event.type === 'capability_call').extensions.occurrenceId, 'deepseek-message:21::call:1::provider:call-1');
  assert.equal(events.find(event => event.type === 'capability_result').extensions.occurrenceId, 'deepseek-message:21::call:1::provider:call-1');
  assert.equal(events.filter(event => event.type === 'status' && event.name === 'sending').length, 1, 'event cursor must suppress replayed page events');
  assert.equal(events.at(-1).result.text, 'done');

  const canonicalEvents = [];
  for await (const event of transport.send(session, { inputId: 'turn-canonical-1', prompt: 'create canonical provider conversation' })) canonicalEvents.push(event);
  assert.equal(canonicalEvents.at(-1).type, 'completed');
  assert.equal(session.href, 'https://chat.deepseek.com/a/chat/s/CANONICAL-ONE', 'accepted DeepSeek initial provider navigation must advance the session canonical href exactly once');
  for await (const _event of transport.send(session, { inputId: 'turn-canonical-2', prompt: 'continue same canonical provider conversation' })) {}
  const canonicalSecondSend = commands.calls.find(call => call.command === '_shuncode.webMcp.workerSend' && call.arg.input?.inputId === 'turn-canonical-2');
  assert.equal(canonicalSecondSend.arg.expectedHref, 'https://chat.deepseek.com/a/chat/s/CANONICAL-ONE', 'next send must be pinned to the evolved canonical href');

  commands.currentHref = 'https://chat.deepseek.com/a/chat/s/DIFFERENT-CONVERSATION';
  await assert.rejects(async () => {
    for await (const _event of transport.send(session, { inputId: 'turn-canonical-drift', prompt: 'must reject conversation substitution' })) {}
  }, /href changed outside the admitted provider canonical transition/);
  commands.currentHref = session.href;
  assert.equal((await transport.health(session)).status, 'healthy');
  const healthCall = commands.calls.find(call => call.command === '_shuncode.webMcp.workerHealth');
  assert.equal(healthCall.arg.expectedOrigin, 'https://chat.deepseek.com');
  assert.equal(healthCall.arg.expectedHref, session.href);
  assert.equal(healthCall.arg.expectedSite, 'deepseek');

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
  assert.ok(commands.calls.filter(call => call.command === '_shuncode.webMcp.workerPoll').every(call => call.arg.expectedOrigin === 'https://chat.deepseek.com' && call.arg.expectedSite === 'deepseek'));
  assert.ok(commands.calls.filter(call => call.command === '_shuncode.webMcp.workerPoll' && call.arg.inputId === 'turn-2').every(call => call.arg.expectedHref === session.href));

  await transport.disconnect(session);
  assert.ok(commands.calls.some(call => call.command === '_shuncode.webMcp.workerDisconnect' && call.arg.expectedOrigin === 'https://chat.deepseek.com' && call.arg.expectedHref === session.href && call.arg.expectedSite === 'deepseek'));
  console.log('[smoke] WebMcpCommandTransport exact-target bridge/cursor/terminal/interrupt/health/disconnect ok');
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
