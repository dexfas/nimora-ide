import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-worker-abandonment-'));
const bundlePath = path.join(bundleDirectory, 'worker-abandonment-smoke.mjs');

await esbuild.build({
  stdin: {
    contents: `
      export { WorkerSessionManager } from ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'src', 'worker-session-manager.ts'))};
      export { WebWorkerAdapter } from ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'src', 'web-worker-adapter.ts'))};
    `,
    resolveDir: path.resolve(import.meta.dirname, '..'),
    sourcefile: 'worker-abandonment-smoke-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['es2022'],
  logLevel: 'silent',
});

const { WorkerSessionManager, WebWorkerAdapter } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class AbandonmentTransport {
  constructor(sessionId = 'page-session-abandonment') {
    this.sessionId = sessionId;
  }

  mode = 'long-host';
  activeInputId = '';
  running = false;
  pendingHostCapabilities = 0;
  sendCount = 0;
  interruptCalls = [];
  submittedResults = [];
  failInterrupts = 0;
  interruptGate = undefined;
  interruptEntered = undefined;

  async describe() {
    return {
      id: 'webmcp.abandonment',
      label: 'Abandonment Test Web',
      site: 'fake.example',
      availability: 'available',
      capabilities: { streaming: true, reasoning: false, interruption: true },
    };
  }

  async connect() {
    return {
      sessionId: this.sessionId,
      site: 'fake.example',
      origin: 'https://fake.example',
      href: 'https://fake.example/chat',
      createdAt: '2026-09-19T00:00:00.000Z',
    };
  }

  async *send(_session, input) {
    this.sendCount += 1;
    if (this.mode === 'pre-send-failure') throw new Error('PRE_SEND_FAILURE');
    this.activeInputId = input.inputId;
    this.running = true;
    try {
      if (this.mode === 'completed') {
        yield { type: 'assistant_text', text: 'done' };
        this.running = false;
        yield { type: 'completed', result: { ok: true } };
        return;
      }
      if (this.mode === 'cancelled-terminal') {
        this.running = false;
        yield { type: 'cancelled', result: { alreadyCancelled: true } };
        return;
      }
      if (this.mode === 'error-terminal') {
        this.running = false;
        yield { type: 'error', error: 'PROVIDER_TERMINAL_ERROR' };
        return;
      }
      if (this.mode === 'routing-invalid-call') {
        yield {
          type: 'capability_call',
          callId: undefined,
          name: 'read_files',
          arguments: { files: [{ path: 'README.md' }] },
          dispatch: 'host-requested',
        };
        await new Promise(() => {});
        return;
      }
      if (this.mode === 'projection-call') {
        yield {
          type: 'capability_call',
          callId: `projection-${input.inputId}`,
          name: 'read_files',
          arguments: { files: [{ path: 'README.md' }] },
          dispatch: 'observed',
        };
        await new Promise(() => {});
        return;
      }
      this.pendingHostCapabilities = 1;
      yield {
        type: 'capability_call',
        callId: `call-${input.inputId}`,
        name: 'read_files',
        arguments: { files: [{ path: 'README.md' }] },
        dispatch: 'host-requested',
      };
      await new Promise(() => {});
    } finally {
      if (!this.running) {
        this.activeInputId = '';
        this.pendingHostCapabilities = 0;
      }
    }
  }

  async interrupt() {
    this.interruptCalls.push(this.activeInputId);
    this.interruptEntered?.resolve();
    if (this.interruptGate) await this.interruptGate.promise;
    if (this.failInterrupts > 0) {
      this.failInterrupts -= 1;
      throw new Error('INTERRUPT_FAILED');
    }
    if (!this.activeInputId) return;
    this.running = false;
    this.pendingHostCapabilities = 0;
  }

  async submitCapabilityResult(_session, result) {
    this.submittedResults.push(result);
  }

  async health() {
    return { status: 'healthy', checkedAt: '2026-09-19T00:00:00.000Z' };
  }

  async disconnect() {
    this.running = false;
    this.activeInputId = '';
    this.pendingHostCapabilities = 0;
  }
}

const transport = new AbandonmentTransport();
const adapter = new WebWorkerAdapter(transport, 'nimora.web-worker.abandonment');
let nextId = 0;
const manager = new WorkerSessionManager({ newId: () => `managed-abandonment-${++nextId}` });

async function consumeTerminal(managedSessionId, inputId, mode) {
  transport.mode = mode;
  const beforeInterrupts = transport.interruptCalls.length;
  const events = [];
  for await (const event of manager.send(managedSessionId, { inputId, prompt: inputId })) events.push(event);
  assert.equal(events.at(-1)?.type, 'terminal');
  assert.equal(transport.interruptCalls.length, beforeInterrupts, `${mode} terminal must cause zero extra interrupt`);
  return events.at(-1);
}

try {
  await manager.register(adapter);
  const session = await manager.createSession('nimora.web-worker.abandonment', {});

  transport.mode = 'long-host';
  const successful = manager.send(session.managedSessionId, {
    inputId: 'abandon-success',
    prompt: 'abandon-success',
  })[Symbol.asyncIterator]();
  assert.equal((await successful.next()).value.type, 'capability_call');
  assert.equal(manager.getSession(session.managedSessionId)?.state, 'running');
  assert.equal(transport.activeInputId, 'abandon-success');
  await successful.return();
  assert.deepEqual(transport.interruptCalls, ['abandon-success']);
  assert.equal(transport.activeInputId, '');
  assert.equal(transport.pendingHostCapabilities, 0);
  assert.equal(manager.getSession(session.managedSessionId)?.state, 'interrupted');
  await assert.rejects(
    () => manager.submitCapabilityResult(session.managedSessionId, {
      inputId: 'abandon-success',
      callId: 'call-abandon-success',
      name: 'read_files',
      text: 'MUST_NOT_DELIVER',
    }),
    /No outstanding host-requested capability call/,
  );
  assert.equal(transport.submittedResults.length, 0);

  transport.mode = 'long-host';
  const thrown = manager.send(session.managedSessionId, {
    inputId: 'abandon-throw',
    prompt: 'abandon-throw',
  })[Symbol.asyncIterator]();
  assert.equal((await thrown.next()).value.type, 'capability_call');
  await assert.rejects(() => thrown.throw(new Error('CONSUMER_ABORTED')), /CONSUMER_ABORTED/);
  assert.equal(transport.interruptCalls.at(-1), 'abandon-throw');
  assert.equal(transport.activeInputId, '');

  // Candidate #2: automatic cleanup already in-flight + concurrent public
  // interrupt must join the exact same Manager-owned attempt.
  transport.mode = 'long-host';
  const automaticWins = manager.send(session.managedSessionId, {
    inputId: 'race-automatic-first',
    prompt: 'race-automatic-first',
  })[Symbol.asyncIterator]();
  assert.equal((await automaticWins.next()).value.type, 'capability_call');
  const automaticGate = deferred();
  const automaticEntered = deferred();
  transport.interruptGate = automaticGate;
  transport.interruptEntered = automaticEntered;
  const interruptsBeforeAutomaticRace = transport.interruptCalls.length;
  const automaticCleanup = automaticWins.return();
  await automaticEntered.promise;
  const concurrentExplicit = manager.interrupt(session.managedSessionId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    transport.interruptCalls.length,
    interruptsBeforeAutomaticRace + 1,
    'concurrent public interrupt must join the in-flight automatic cleanup attempt',
  );
  automaticGate.resolve();
  await Promise.all([automaticCleanup, concurrentExplicit]);
  assert.equal(transport.interruptCalls.length, interruptsBeforeAutomaticRace + 1);
  assert.equal(transport.interruptCalls.at(-1), 'race-automatic-first');
  assert.equal(transport.activeInputId, '');
  transport.interruptGate = undefined;
  transport.interruptEntered = undefined;

  // Reverse race: public interrupt wins while the send is still active. The
  // later iterator abandonment must observe the already-owned exact attempt.
  transport.mode = 'long-host';
  const explicitWins = manager.send(session.managedSessionId, {
    inputId: 'race-explicit-first',
    prompt: 'race-explicit-first',
  })[Symbol.asyncIterator]();
  assert.equal((await explicitWins.next()).value.type, 'capability_call');
  const explicitGate = deferred();
  const explicitEntered = deferred();
  transport.interruptGate = explicitGate;
  transport.interruptEntered = explicitEntered;
  const interruptsBeforeExplicitRace = transport.interruptCalls.length;
  const explicitFirst = manager.interrupt(session.managedSessionId);
  await explicitEntered.promise;
  const laterAutomatic = explicitWins.return();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(
    transport.interruptCalls.length,
    interruptsBeforeExplicitRace + 1,
    'later automatic cleanup must not interrupt an exact send already owned by public interrupt',
  );
  explicitGate.resolve();
  await Promise.all([explicitFirst, laterAutomatic]);
  assert.equal(transport.interruptCalls.length, interruptsBeforeExplicitRace + 1);
  assert.equal(transport.interruptCalls.at(-1), 'race-explicit-first');
  transport.interruptGate = undefined;
  transport.interruptEntered = undefined;

  // Failure while attempt #1 is held: concurrent caller joins the same failed
  // attempt. Only a later explicit call after settlement may create attempt #2.
  transport.mode = 'long-host';
  const failedRace = manager.send(session.managedSessionId, {
    inputId: 'race-failed-first-attempt',
    prompt: 'race-failed-first-attempt',
  })[Symbol.asyncIterator]();
  assert.equal((await failedRace.next()).value.type, 'capability_call');
  const failedGate = deferred();
  const failedEntered = deferred();
  transport.interruptGate = failedGate;
  transport.interruptEntered = failedEntered;
  transport.failInterrupts = 1;
  const interruptsBeforeFailedRace = transport.interruptCalls.length;
  const automaticFailedAttempt = failedRace.return();
  await failedEntered.promise;
  const concurrentFailedJoin = manager.interrupt(session.managedSessionId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(transport.interruptCalls.length, interruptsBeforeFailedRace + 1);
  failedGate.resolve();
  const failedAttemptResults = await Promise.allSettled([automaticFailedAttempt, concurrentFailedJoin]);
  assert.equal(failedAttemptResults[0].status, 'rejected');
  assert.equal(failedAttemptResults[1].status, 'rejected');
  assert.match(String(failedAttemptResults[0].reason), /INTERRUPT_FAILED/);
  assert.match(String(failedAttemptResults[1].reason), /INTERRUPT_FAILED/);
  assert.equal(transport.interruptCalls.length, interruptsBeforeFailedRace + 1);
  assert.equal(transport.activeInputId, 'race-failed-first-attempt');
  assert.equal(manager.getSession(session.managedSessionId)?.state, 'running');
  transport.interruptGate = undefined;
  transport.interruptEntered = undefined;
  await manager.interrupt(session.managedSessionId);
  assert.equal(
    transport.interruptCalls.length,
    interruptsBeforeFailedRace + 2,
    'later explicit retry after failed attempt settlement must create exactly one new interrupt attempt',
  );
  assert.equal(transport.interruptCalls.at(-1), 'race-failed-first-attempt');
  assert.equal(transport.activeInputId, '');

  // A Manager routing validation throw is not provider-ended proof. Cleanup
  // must interrupt the still-running exact input before releasing ownership.
  transport.mode = 'routing-invalid-call';
  const routingThrow = manager.send(session.managedSessionId, {
    inputId: 'routing-throw-input',
    prompt: 'routing-throw-input',
  })[Symbol.asyncIterator]();
  const interruptsBeforeRoutingThrow = transport.interruptCalls.length;
  await assert.rejects(() => routingThrow.next(), /without callId/);
  assert.equal(transport.interruptCalls.length, interruptsBeforeRoutingThrow + 1);
  assert.equal(transport.interruptCalls.at(-1), 'routing-throw-input');
  assert.equal(transport.running, false);
  assert.equal(transport.activeInputId, '');
  assert.notEqual(manager.getSession(session.managedSessionId)?.state, 'running');

  // If the routing-error cleanup interrupt itself fails, exact input/send
  // ownership remains addressable, new sends stay blocked, and one later
  // canonical interrupt retries that same input.
  transport.mode = 'routing-invalid-call';
  transport.failInterrupts = 1;
  const routingCleanupFailure = manager.send(session.managedSessionId, {
    inputId: 'routing-throw-cleanup-failure',
    prompt: 'routing-throw-cleanup-failure',
  })[Symbol.asyncIterator]();
  const interruptsBeforeRoutingFailure = transport.interruptCalls.length;
  await assert.rejects(() => routingCleanupFailure.next(), /INTERRUPT_FAILED/);
  assert.equal(transport.interruptCalls.length, interruptsBeforeRoutingFailure + 1);
  assert.equal(transport.interruptCalls.at(-1), 'routing-throw-cleanup-failure');
  assert.equal(transport.activeInputId, 'routing-throw-cleanup-failure');
  assert.equal(transport.running, true);
  assert.equal(manager.getSession(session.managedSessionId)?.state, 'running');
  const blockedAfterRoutingFailure = manager.send(session.managedSessionId, {
    inputId: 'routing-failure-must-block-new-send',
    prompt: 'blocked',
  })[Symbol.asyncIterator]();
  await assert.rejects(() => blockedAfterRoutingFailure.next(), /unresolved abandoned provider input/);
  await manager.interrupt(session.managedSessionId);
  assert.equal(transport.interruptCalls.length, interruptsBeforeRoutingFailure + 2);
  assert.equal(transport.interruptCalls.at(-1), 'routing-throw-cleanup-failure');
  assert.equal(transport.activeInputId, '');
  assert.equal(transport.running, false);

  transport.mode = 'long-host';
  transport.failInterrupts = 1;
  const failed = manager.send(session.managedSessionId, {
    inputId: 'abandon-failed-cleanup',
    prompt: 'abandon-failed-cleanup',
  })[Symbol.asyncIterator]();
  assert.equal((await failed.next()).value.type, 'capability_call');
  const sendsBeforeFailure = transport.sendCount;
  const interruptsBeforeFailure = transport.interruptCalls.length;
  await assert.rejects(() => failed.return(), /INTERRUPT_FAILED/);
  assert.equal(transport.interruptCalls.length, interruptsBeforeFailure + 1);
  assert.equal(transport.interruptCalls.at(-1), 'abandon-failed-cleanup');
  assert.equal(transport.activeInputId, 'abandon-failed-cleanup');
  assert.equal(transport.pendingHostCapabilities, 1);
  assert.equal(manager.getSession(session.managedSessionId)?.state, 'running');

  const blocked = manager.send(session.managedSessionId, {
    inputId: 'must-not-send-during-unresolved-cleanup',
    prompt: 'blocked',
  })[Symbol.asyncIterator]();
  await assert.rejects(() => blocked.next(), /unresolved abandoned provider input/);
  assert.equal(transport.sendCount, sendsBeforeFailure);
  await assert.rejects(() => manager.retire(session.managedSessionId), /Cannot retire running worker session/);

  await manager.interrupt(session.managedSessionId);
  assert.equal(transport.interruptCalls.at(-1), 'abandon-failed-cleanup');
  assert.equal(transport.interruptCalls.length, interruptsBeforeFailure + 2);
  assert.equal(transport.activeInputId, '');
  assert.equal(transport.pendingHostCapabilities, 0);
  assert.equal(manager.getSession(session.managedSessionId)?.state, 'interrupted');

  assert.equal((await consumeTerminal(session.managedSessionId, 'normal-completed', 'completed')).status, 'completed');
  assert.equal((await consumeTerminal(session.managedSessionId, 'normal-cancelled', 'cancelled-terminal')).status, 'cancelled');
  assert.equal((await consumeTerminal(session.managedSessionId, 'normal-error', 'error-terminal')).status, 'error');

  transport.mode = 'pre-send-failure';
  const beforePreSendInterrupts = transport.interruptCalls.length;
  const preSendEvents = [];
  for await (const event of manager.send(session.managedSessionId, {
    inputId: 'pre-send-failure',
    prompt: 'pre-send-failure',
  })) preSendEvents.push(event);
  assert.equal(preSendEvents.at(-1)?.type, 'terminal');
  assert.equal(preSendEvents.at(-1)?.status, 'error');
  assert.match(preSendEvents.at(-1)?.error || '', /PRE_SEND_FAILURE/);
  assert.equal(transport.interruptCalls.length, beforePreSendInterrupts);

  await manager.dispose(session.managedSessionId);

  // Execution projection/store failures are Manager-owned wrapper errors, not
  // provider-terminal proof. Use a separate exact session and a projection
  // that deterministically fails before the provider terminal.
  const projectionTransport = new AbandonmentTransport('page-session-projection');
  const projectionAdapter = new WebWorkerAdapter(projectionTransport, 'nimora.web-worker.projection');
  let projectionManagedId = 0;
  let projectionBeginCalls = 0;
  const projectionManager = new WorkerSessionManager({
    newId: () => `managed-projection-${++projectionManagedId}`,
    taskBindings: {
      attachWorkerSession: async () => undefined,
      detachWorkerSession: async () => undefined,
      isWorkerAdapterSessionRetired: async () => false,
      assertWorkerSessionContinuationAllowed: async () => undefined,
    },
    executionProjection: {
      beginWorkerExecution: async () => {
        projectionBeginCalls += 1;
        throw new Error('PROJECTION_BEGIN_FAILED');
      },
      completeWorkerExecution: async () => undefined,
      markWorkerExecutionDelivered: async () => undefined,
    },
  });
  await projectionManager.register(projectionAdapter);
  const projectionSession = await projectionManager.createSession(
    'nimora.web-worker.projection',
    {},
    'projection-task',
  );
  projectionTransport.mode = 'projection-call';
  const projectionThrow = projectionManager.send(projectionSession.managedSessionId, {
    inputId: 'projection-throw-input',
    prompt: 'projection-throw-input',
  })[Symbol.asyncIterator]();
  await assert.rejects(() => projectionThrow.next(), /PROJECTION_BEGIN_FAILED/);
  assert.equal(projectionBeginCalls, 1);
  assert.deepEqual(
    projectionTransport.interruptCalls,
    ['projection-throw-input'],
    'projection/store wrapper throw must canonically interrupt the exact still-running provider input once',
  );
  assert.equal(projectionTransport.running, false);
  assert.equal(projectionTransport.activeInputId, '');
  assert.notEqual(projectionManager.getSession(projectionSession.managedSessionId)?.state, 'running');
  await projectionManager.dispose(projectionSession.managedSessionId);

  console.log('[smoke] non-terminal consumer abandonment cleanup/fail-closed retry lifecycle ok');
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
