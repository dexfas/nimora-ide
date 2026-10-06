import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-webmcp-no-progress-'));
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

const { WebMcpCommandTransport, DEFAULT_WEBMCP_NO_PROGRESS_TIMEOUT_MS } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

const target = {
  pageId: 'page-r13',
  sessionId: 'session-r13',
  site: 'deepseek',
  origin: 'https://chat.deepseek.com',
  href: 'https://chat.deepseek.com/a/chat/r13',
  transport: 'binding',
  status: { enabled: true, composerFound: true },
};

class ScenarioCommands {
  calls = [];
  sendCount = 0;
  interruptCount = 0;
  pollCount = 0;
  interrupted = false;
  nowMs = 0;
  mode;

  constructor(mode) {
    this.mode = mode;
  }

  snapshot(inputId, state, events, text = '', toolCallCount = 0) {
    return { inputId, state, text, toolCallCount, events };
  }

  baseEvents() {
    return [
      { seq: 1, type: 'status', name: 'sending' },
      { seq: 2, type: 'status', name: 'sent' },
    ];
  }

  async executeCommand(command, arg) {
    this.calls.push({ command, arg });
    if (command === '_shuncode.webMcp.workerConnect') return { ...target };
    if (command === '_shuncode.webMcp.workerSend') {
      this.sendCount += 1;
      this.pollCount = 0;
      this.interrupted = false;
      if (this.mode === 'send-rejected') {
        throw new Error('DeepSeek provider user-message admission was not confirmed after the single submit gesture');
      }
      if (this.mode === 'admission-converged-capability') {
        return this.snapshot(arg.input.inputId, 'running', [
          ...this.baseEvents(),
          {
            seq: 3,
            type: 'capability_call',
            callId: 'deliver-phase11-proof-021',
            name: 'nimora.coordinator.deliverExplicitMissionInput',
            occurrenceId: 'deepseek-message:deepseek-item%3A2::call:1::provider:deliver-phase11-proof-021',
            arguments: {},
            dispatch: 'host-requested',
          },
        ], '', 1);
      }
      return this.snapshot(arg.input.inputId, 'running', this.baseEvents());
    }
    if (command === '_shuncode.webMcp.workerInterrupt') {
      this.interruptCount += 1;
      this.interrupted = true;
      return true;
    }
    if (command === '_shuncode.webMcp.workerPoll') {
      if (this.interrupted) {
        return this.snapshot(arg.inputId, 'cancelled', [
          ...this.baseEvents(),
          { seq: 90, type: 'cancelled', interrupted: true },
        ]);
      }
      this.pollCount += 1;
      this.nowMs += 10;
      if (this.mode === 'zero') {
        return this.snapshot(arg.inputId, 'running', [
          ...this.baseEvents(),
          { seq: 2 + this.pollCount, type: 'status', name: 'scan_observed' },
        ]);
      }
      if (this.mode === 'normal') {
        if (this.pollCount === 1) {
          return this.snapshot(arg.inputId, 'running', [
            ...this.baseEvents(),
            { seq: 3, type: 'assistant_text', text: 'still working' },
          ], 'still working');
        }
        return this.snapshot(arg.inputId, 'completed', [
          ...this.baseEvents(),
          { seq: 3, type: 'assistant_text', text: 'still working' },
          { seq: 4, type: 'assistant_text', text: ' done' },
          { seq: 5, type: 'completed', text: 'still working done' },
        ], 'still working done');
      }
      if (this.mode === 'capability-progress') {
        if (this.pollCount === 1) {
          return this.snapshot(arg.inputId, 'running', [
            ...this.baseEvents(),
            { seq: 3, type: 'capability_call', callId: 'call-1', name: 'read_files', occurrenceId: 'occurrence-1', arguments: { files: [{ path: 'README.md' }] }, dispatch: 'host-requested' },
          ], '', 1);
        }
        if (this.pollCount === 2) {
          return this.snapshot(arg.inputId, 'running', [
            ...this.baseEvents(),
            { seq: 3, type: 'capability_call', callId: 'call-1', name: 'read_files', occurrenceId: 'occurrence-1', arguments: { files: [{ path: 'README.md' }] }, dispatch: 'host-requested' },
            { seq: 4, type: 'status', name: 'scan_observed' },
          ], '', 1);
        }
        if (this.pollCount === 3) {
          return this.snapshot(arg.inputId, 'running', [
            ...this.baseEvents(),
            { seq: 3, type: 'capability_call', callId: 'call-1', name: 'read_files', occurrenceId: 'occurrence-1', arguments: { files: [{ path: 'README.md' }] }, dispatch: 'host-requested' },
            { seq: 5, type: 'capability_result', callId: 'call-1', name: 'read_files', occurrenceId: 'occurrence-1', text: 'READ_OK', isError: false },
            { seq: 6, type: 'status', name: 'capability_result_delivered', callId: 'call-1', capability: 'read_files' },
          ], '', 1);
        }
        if (this.pollCount === 4) {
          return this.snapshot(arg.inputId, 'running', [
            ...this.baseEvents(),
            { seq: 3, type: 'capability_call', callId: 'call-1', name: 'read_files', occurrenceId: 'occurrence-1', arguments: { files: [{ path: 'README.md' }] }, dispatch: 'host-requested' },
            { seq: 5, type: 'capability_result', callId: 'call-1', name: 'read_files', occurrenceId: 'occurrence-1', text: 'READ_OK', isError: false },
            { seq: 6, type: 'status', name: 'capability_result_delivered', callId: 'call-1', capability: 'read_files' },
            { seq: 7, type: 'assistant_text', text: 'final answer' },
          ], 'final answer', 1);
        }
        return this.snapshot(arg.inputId, 'completed', [
          ...this.baseEvents(),
          { seq: 3, type: 'capability_call', callId: 'call-1', name: 'read_files', occurrenceId: 'occurrence-1', arguments: { files: [{ path: 'README.md' }] }, dispatch: 'host-requested' },
          { seq: 5, type: 'capability_result', callId: 'call-1', name: 'read_files', occurrenceId: 'occurrence-1', text: 'READ_OK', isError: false },
          { seq: 6, type: 'status', name: 'capability_result_delivered', callId: 'call-1', capability: 'read_files' },
          { seq: 7, type: 'assistant_text', text: 'final answer' },
          { seq: 8, type: 'completed', text: 'final answer' },
        ], 'final answer', 1);
      }
      if (this.mode === 'admission-converged-capability') {
        return this.snapshot(arg.inputId, 'completed', [
          ...this.baseEvents(),
          {
            seq: 3,
            type: 'capability_call',
            callId: 'deliver-phase11-proof-021',
            name: 'nimora.coordinator.deliverExplicitMissionInput',
            occurrenceId: 'deepseek-message:deepseek-item%3A2::call:1::provider:deliver-phase11-proof-021',
            arguments: {},
            dispatch: 'host-requested',
          },
          { seq: 4, type: 'completed', text: '' },
        ], '', 1);
      }
      if (this.mode === 'explicit') return this.snapshot(arg.inputId, 'running', this.baseEvents());
      throw new Error(`Unknown scenario ${this.mode}`);
    }
    if (command === '_shuncode.webMcp.workerDisconnect') return { disconnected: true };
    throw new Error(`Unexpected command ${command}`);
  }
}

async function connect(commands, timeoutMs = 25) {
  const transport = new WebMcpCommandTransport(commands, {
    pollIntervalMs: 1,
    noProgressTimeoutMs: timeoutMs,
    now: () => new Date(commands.nowMs),
  });
  const session = await transport.connect({});
  return { transport, session };
}

try {
  assert.equal(DEFAULT_WEBMCP_NO_PROGRESS_TIMEOUT_MS, 300_000, 'production no-progress timeout must stay finite and explicit');

  const zeroCommands = new ScenarioCommands('zero');
  const zero = await connect(zeroCommands);
  const zeroEvents = [];
  for await (const event of zero.transport.send(zero.session, { inputId: 'r13-zero', prompt: 'zero output' })) zeroEvents.push(event);
  const timeoutEvent = zeroEvents.at(-1);
  assert.equal(timeoutEvent.type, 'error');
  assert.match(timeoutEvent.error, /timed out after 25ms without provider progress/);
  assert.equal(timeoutEvent.data.code, 'WEBMCP_NO_PROGRESS_TIMEOUT');
  assert.equal(timeoutEvent.data.convergenceState, 'cancelled');
  assert.equal(zeroCommands.sendCount, 1, 'timeout must not resend provider input');
  assert.equal(zeroCommands.interruptCount, 1, 'timeout must make one canonical convergence attempt');
  assert.ok(zeroCommands.pollCount >= 3, 'repeated zero-progress canonical polls must not refresh the deadline');
  assert.equal(zeroEvents.filter(event => event.type === 'capability_call').length, 0, 'zero-output timeout must not manufacture a capability call');

  for (const [requested, expected] of [[10, 10], [1_000, 25], [-1, 25], [NaN, 25], ['10', 25]]) {
    const commands = new ScenarioCommands('zero');
    const scoped = await connect(commands);
    const events = [];
    for await (const event of scoped.transport.send(scoped.session, { inputId: 'bounded-budget', prompt: 'diagnostic',
      extensions: { noProgressTimeoutMs: requested } })) events.push(event);
    assert.equal(events.at(-1).data.noProgressTimeoutMs, expected, 'per-input budget can only shorten the configured ceiling');
    assert.match(events.at(-1).error, new RegExp(`timed out after ${expected}ms`));
    assert.equal(commands.sendCount, 1); assert.equal(commands.interruptCount, 1);
  }

  const normalCommands = new ScenarioCommands('normal');
  const normal = await connect(normalCommands);
  const normalEvents = [];
  for await (const event of normal.transport.send(normal.session, { inputId: 'r13-normal', prompt: 'normal response' })) normalEvents.push(event);
  assert.equal(normalEvents.at(-1).type, 'completed');
  assert.equal(normalCommands.sendCount, 1);
  assert.equal(normalCommands.interruptCount, 0, 'normal provider progress before deadline must not be interrupted');

  const capabilityCommands = new ScenarioCommands('capability-progress');
  const capability = await connect(capabilityCommands);
  const capabilityEvents = [];
  for await (const event of capability.transport.send(capability.session, { inputId: 'r13-capability', prompt: 'tool response' })) capabilityEvents.push(event);
  assert.equal(capabilityEvents.at(-1).type, 'completed');
  assert.equal(capabilityEvents.filter(event => event.type === 'capability_call').length, 1);
  assert.equal(capabilityEvents.filter(event => event.type === 'capability_result').length, 1);
  assert.equal(capabilityEvents.find(event => event.type === 'capability_call').extensions.occurrenceId, 'occurrence-1');
  assert.equal(capabilityEvents.find(event => event.type === 'capability_result').extensions.occurrenceId, 'occurrence-1');
  assert.equal(capabilityCommands.interruptCount, 0, 'capability call/result progress must refresh inactivity deadline');
  assert.equal(capabilityCommands.sendCount, 1);

  const admissionConvergedCommands = new ScenarioCommands('admission-converged-capability');
  const admissionConverged = await connect(admissionConvergedCommands, 1);
  const admissionConvergedEvents = [];
  for await (const event of admissionConverged.transport.send(admissionConverged.session, {
    inputId: 'r16-real-019-admission-converged',
    prompt: 'real-shaped tool-only capability already converged at provider admission boundary',
  })) admissionConvergedEvents.push(event);
  const admissionConvergedCalls = admissionConvergedEvents.filter(event => event.type === 'capability_call');
  assert.equal(admissionConvergedCalls.length, 1, 'admission-boundary capability convergence must surface exactly once before timeout can cancel');
  assert.equal(admissionConvergedCalls[0].callId, 'deliver-phase11-proof-021');
  assert.equal(admissionConvergedCalls[0].name, 'nimora.coordinator.deliverExplicitMissionInput');
  assert.equal(admissionConvergedCalls[0].dispatch, 'host-requested');
  assert.equal(Reflect.ownKeys(admissionConvergedCalls[0].arguments).length, 0);
  assert.equal(admissionConvergedCommands.interruptCount, 0, 'no-progress timeout must not beat a capability already converged by accepted workerSend');
  assert.equal(admissionConvergedCommands.sendCount, 1);
  assert.equal(admissionConvergedEvents.at(-1).type, 'completed');

  const rejectedCommands = new ScenarioCommands('send-rejected');
  const rejected = await connect(rejectedCommands, 25);
  let rejectedError = '';
  try {
    for await (const _event of rejected.transport.send(rejected.session, { inputId: 'r14-no-admission', prompt: 'not admitted' })) {
      assert.fail('workerSend admission rejection must not yield an accepted transport event');
    }
  } catch (error) {
    rejectedError = String(error?.message || error);
  }
  assert.match(rejectedError, /provider user-message admission was not confirmed/);
  assert.equal(rejectedCommands.sendCount, 1, 'provider admission rejection must not resend');
  assert.equal(rejectedCommands.pollCount, 0, 'R13 no-progress polling must not start before provider admission');
  assert.equal(rejectedCommands.interruptCount, 0, 'R13 timeout convergence must not start before provider admission');

  const explicitCommands = new ScenarioCommands('explicit');
  const explicit = await connect(explicitCommands, 100);
  const explicitIterator = explicit.transport.send(explicit.session, { inputId: 'r13-explicit', prompt: 'explicit interrupt' })[Symbol.asyncIterator]();
  assert.equal((await explicitIterator.next()).value.type, 'status');
  await Promise.all([
    explicit.transport.interrupt(explicit.session),
    explicit.transport.interrupt(explicit.session),
  ]);
  const explicitRemaining = [];
  for (;;) {
    const next = await explicitIterator.next();
    if (next.done) break;
    explicitRemaining.push(next.value);
  }
  assert.equal(explicitCommands.interruptCount, 1, 'concurrent explicit interrupt requests must converge through one exact-turn attempt');
  assert.equal(explicitRemaining.at(-1).type, 'cancelled', 'explicit caller interrupt must retain cancellation terminal behavior');

  console.log(JSON.stringify({
    result: 'PASS',
    productionDefaultNoProgressTimeoutMs: DEFAULT_WEBMCP_NO_PROGRESS_TIMEOUT_MS,
    injectedNoProgressTimeoutMs: 25,
    zeroOutputSendCount: zeroCommands.sendCount,
    zeroOutputCanonicalInterruptCount: zeroCommands.interruptCount,
    zeroOutputTerminal: timeoutEvent.data.code,
    zeroProgressPollsBeforeTimeout: zeroCommands.pollCount,
    semanticCapabilityExecutionsForZeroOutput: 0,
    normalResponseInterruptCount: normalCommands.interruptCount,
    capabilityProgressInterruptCount: capabilityCommands.interruptCount,
    admissionBoundaryCapabilityCalls: admissionConvergedCalls.length,
    admissionBoundaryTimeoutInterruptCount: admissionConvergedCommands.interruptCount,
    noAdmissionPollCount: rejectedCommands.pollCount,
    noAdmissionInterruptCount: rejectedCommands.interruptCount,
    explicitInterruptCommandCount: explicitCommands.interruptCount,
  }));
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
