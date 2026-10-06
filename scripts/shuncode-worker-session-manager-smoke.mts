import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-worker-manager-task-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-worker-manager-bundle-'));
const bundlePath = path.join(bundleDirectory, 'worker-session-manager-smoke.mjs');

await esbuild.build({
  stdin: {
    contents: `
      export { WorkerSessionManager } from ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'src', 'worker-session-manager.ts'))};
      export { TaskRuntime } from ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'src', 'task-runtime.ts'))};
    `,
    resolveDir: path.resolve(import.meta.dirname, '..'),
    sourcefile: 'worker-session-manager-smoke-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['es2022'],
  logLevel: 'silent',
});

const { WorkerSessionManager, TaskRuntime } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

class FakeAdapter {
  disposed = [];
  interrupted = [];
  checkpoints = [];
  submittedResults = [];
  hostResultResolvers = new Map();
  nextSessionId = 'provider-session';

  constructor(id, label) {
    this.id = id;
    this.label = label;
  }

  async describe() {
    return {
      id: this.id,
      provider: this.id,
      kind: 'api',
      label: this.label,
      availability: 'available',
      models: ['fake-model'],
      capabilities: {
        streaming: true,
        reasoning: true,
        capabilityRequests: true,
        imageInput: false,
        checkpoints: true,
        interruption: true,
        persistentContext: true,
      },
    };
  }

  async createSession(options) {
    const now = new Date().toISOString();
    return {
      sessionId: this.nextSessionId,
      workerId: this.id,
      state: 'idle',
      model: options.model,
      contextHandle: options.contextHandle,
      createdAt: now,
      lastActiveAt: now,
    };
  }

  async *send(session, input) {
    session.state = 'running';
    session.lastActiveAt = new Date().toISOString();
    let hostResultResolver;
    try {
      if (input.prompt === 'throw') throw new Error('provider send failed');
      if (input.prompt === 'host-request') {
        let resolveHostResult;
        const hostResult = new Promise(resolve => { resolveHostResult = resolve; });
        hostResultResolver = resolveHostResult;
        const resolvers = this.hostResultResolvers.get(input.inputId) ?? new Set();
        resolvers.add(resolveHostResult);
        this.hostResultResolvers.set(input.inputId, resolvers);
        yield { type: 'capability_call', inputId: input.inputId, callId: 'call-host-result', name: 'read_files', arguments: { files: [{ path: 'README.md' }] }, dispatch: 'host-requested' };
        await hostResult;
        yield { type: 'capability_result', inputId: input.inputId, callId: 'call-host-result', name: 'read_files', text: 'HOST_RESULT_OK', isError: false };
        yield { type: 'terminal', inputId: input.inputId, status: 'completed' };
        return;
      }
      if (input.prompt === 'host-request-then-throw') {
        yield { type: 'capability_call', inputId: input.inputId, callId: 'call-host-result', name: 'read_files', arguments: { files: [{ path: 'README.md' }] }, dispatch: 'host-requested' };
        throw new Error('provider failed after host request');
      }
      yield { type: 'text_delta', inputId: input.inputId, text: `${this.id}:hello` };
      yield { type: 'terminal', inputId: input.inputId, status: 'completed' };
    } finally {
      if (hostResultResolver) {
        const resolvers = this.hostResultResolvers.get(input.inputId);
        resolvers?.delete(hostResultResolver);
        if (resolvers?.size === 0) this.hostResultResolvers.delete(input.inputId);
      }
      session.state = 'idle';
      session.lastActiveAt = new Date().toISOString();
    }
  }

  async interrupt(session) {
    this.interrupted.push(session.sessionId);
    session.state = 'interrupted';
  }

  async submitCapabilityResult(session, result) {
    this.submittedResults.push({ sessionId: session.sessionId, result });
    const resolvers = this.hostResultResolvers.get(result.inputId);
    const resolve = resolvers?.values().next().value;
    if (resolve) {
      resolvers.delete(resolve);
      if (resolvers.size === 0) this.hostResultResolvers.delete(result.inputId);
      resolve();
    }
  }

  async resume(session, checkpoint) {
    this.checkpoints.push(checkpoint);
    session.state = 'idle';
  }

  async dispose(session) {
    this.disposed.push(session.sessionId);
    session.state = 'disposed';
  }

  async health() {
    return { status: 'healthy', checkedAt: new Date().toISOString() };
  }
}

let managerId = 0;
const newManagedId = () => `managed-${++managerId}`;

try {
  let admissionAllowed = false;
  let admittedSends = 0;
  const observations = [];
  class AdmissionAdapter extends FakeAdapter {
    async *send(session, input) { admittedSends++; yield* super.send(session, input); }
  }
  const admissionManager = new WorkerSessionManager({
    beforeSend: async () => { if (!admissionAllowed) throw Error('resource policy changed before send'); },
    observeTurn: observation => { observations.push(observation); throw Error('non-owning observation sink failed'); },
  });
  await admissionManager.register(new AdmissionAdapter('admission-worker', 'Admission'));
  const admissionSession = await admissionManager.createSession('admission-worker', { model: 'fake-model' });
  await assert.rejects(async () => { for await (const _event of admissionManager.send(admissionSession.managedSessionId,
    { inputId: 'denied-before-send', prompt: 'must not send' })) {} }, /resource policy changed/);
  assert.equal(admittedSends, 0, 'resource drift is rejected before invoking the provider');
  assert.equal(observations.length, 0, 'a denied request is not a provider latency sample');
  admissionAllowed = true;
  const admittedEvents = [];
  for await (const event of admissionManager.send(admissionSession.managedSessionId,
    { inputId: 'fresh-admitted-send', prompt: 'hello' })) admittedEvents.push(event);
  assert.equal(admittedEvents.at(-1).status, 'completed', 'observation failure cannot change the owning terminal');
  assert.equal(admittedSends, 1);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].basis, 'managed-provider-turn');
  assert.equal(observations[0].model, 'fake-model');
  assert(Number.isFinite(observations[0].durationMs) && observations[0].durationMs >= 0);
  await admissionManager.dispose(admissionSession.managedSessionId);

  const tasks = new TaskRuntime({ storageDirectory: taskDirectory });
  await tasks.initialize();
  const taskA = await tasks.ensureTask({ kind: 'bridge', key: 'worker-manager-a' }, 'Task A');
  const taskB = await tasks.ensureTask({ kind: 'bridge', key: 'worker-manager-b' }, 'Task B');
  const taskC = await tasks.ensureTask({ kind: 'bridge', key: 'worker-manager-c' }, 'Task C');

  const api = new FakeAdapter('worker.api', 'API Worker');
  const agent = new FakeAdapter('worker.agent', 'Agent Worker');
  const manager = new WorkerSessionManager({ newId: newManagedId, taskBindings: tasks });
  await manager.register(api);
  await manager.register(agent);
  await assert.rejects(async () => manager.register(api), /already registered/);
  assert.deepEqual(manager.listWorkers().map(worker => worker.id).sort(), ['worker.agent', 'worker.api']);

  const apiSession = await manager.createSession('worker.api', { model: 'fake-model', contextHandle: 'ctx-a' }, taskA.taskId);
  const agentSession = await manager.createSession('worker.agent', { model: 'fake-model' }, taskA.taskId);
  assert.notEqual(apiSession.managedSessionId, agentSession.managedSessionId, 'manager ids must remain unique even when provider-native session ids collide');
  assert.equal(apiSession.adapterSessionId, agentSession.adapterSessionId, 'smoke intentionally uses colliding provider-native ids');
  assert.equal(manager.listSessions({ taskId: taskA.taskId }).length, 2);
  assert.equal(tasks.getTask(taskA.taskId).workerSessions[apiSession.managedSessionId].adapterSessionId, 'provider-session');

  await assert.rejects(
    () => manager.submitCapabilityResult(apiSession.managedSessionId, { inputId: 'turn-host-result', callId: 'call-host-result', name: 'read_files', text: 'EARLY' }),
    /No outstanding host-requested capability call/,
  );
  const hostStream = manager.send(apiSession.managedSessionId, { inputId: 'turn-host-result', prompt: 'host-request' })[Symbol.asyncIterator]();
  const hostCall = await hostStream.next();
  assert.equal(hostCall.value.type, 'capability_call');
  assert.equal(hostCall.value.dispatch, 'host-requested');
  await manager.submitCapabilityResult(apiSession.managedSessionId, {
    inputId: 'turn-host-result', callId: 'call-host-result', name: 'read_files', text: 'HOST_RESULT_OK',
  });
  assert.deepEqual(api.submittedResults, [{
    sessionId: 'provider-session',
    result: { inputId: 'turn-host-result', callId: 'call-host-result', name: 'read_files', text: 'HOST_RESULT_OK' },
  }]);
  assert.equal((await hostStream.next()).value.type, 'capability_result');
  assert.equal((await hostStream.next()).value.status, 'completed');
  await assert.rejects(
    () => manager.submitCapabilityResult(apiSession.managedSessionId, { inputId: 'turn-host-result', callId: 'call-host-result', name: 'read_files', text: 'LATE' }),
    /No outstanding host-requested capability call/,
  );

  const firstDuplicateIdentityStream = manager.send(apiSession.managedSessionId, { inputId: 'turn-host-duplicate-identity', prompt: 'host-request' })[Symbol.asyncIterator]();
  assert.equal((await firstDuplicateIdentityStream.next()).value.type, 'capability_call');
  const secondDuplicateIdentityStream = manager.send(apiSession.managedSessionId, { inputId: 'turn-host-duplicate-identity', prompt: 'host-request' })[Symbol.asyncIterator]();
  await assert.rejects(
    () => secondDuplicateIdentityStream.next(),
    /reused host-requested call identity.*across active sends/,
    'a second active send must not borrow or replace the same input/call continuation identity',
  );
  await manager.submitCapabilityResult(apiSession.managedSessionId, {
    inputId: 'turn-host-duplicate-identity', callId: 'call-host-result', name: 'read_files', text: 'FIRST-TURN-STILL-OWNS-RESULT',
  });
  assert.equal((await firstDuplicateIdentityStream.next()).value.type, 'capability_result', 'failed duplicate send cleanup must not revoke the first send continuation authority');
  assert.equal((await firstDuplicateIdentityStream.next()).value.status, 'completed');

  const cancelledHostStream = manager.send(apiSession.managedSessionId, { inputId: 'turn-host-cancelled', prompt: 'host-request' })[Symbol.asyncIterator]();
  assert.equal((await cancelledHostStream.next()).value.type, 'capability_call');
  assert.equal(manager.getSession(apiSession.managedSessionId).state, 'running');
  await cancelledHostStream.return();
  assert.equal(manager.getSession(apiSession.managedSessionId).state, 'idle', 'consumer close after host request must release the admitted send lease');
  await assert.rejects(
    () => manager.submitCapabilityResult(apiSession.managedSessionId, { inputId: 'turn-host-cancelled', callId: 'call-host-result', name: 'read_files', text: 'STALE' }),
    /No outstanding host-requested capability call/,
    'consumer close must revoke pending host-result continuation authority',
  );

  const failedHostStream = manager.send(apiSession.managedSessionId, { inputId: 'turn-host-provider-failed', prompt: 'host-request-then-throw' })[Symbol.asyncIterator]();
  assert.equal((await failedHostStream.next()).value.type, 'capability_call');
  await assert.rejects(() => failedHostStream.next(), /provider failed after host request/);
  assert.equal(manager.getSession(apiSession.managedSessionId).state, 'idle', 'provider failure after host request must release the admitted send lease');
  await assert.rejects(
    () => manager.submitCapabilityResult(apiSession.managedSessionId, { inputId: 'turn-host-provider-failed', callId: 'call-host-result', name: 'read_files', text: 'STALE' }),
    /No outstanding host-requested capability call/,
    'provider failure must revoke pending host-result continuation authority',
  );

  const stream = manager.send(apiSession.managedSessionId, { inputId: 'turn-1', prompt: 'hello' })[Symbol.asyncIterator]();
  const first = await stream.next();
  assert.equal(first.value.type, 'text_delta');
  assert.equal(manager.getSession(apiSession.managedSessionId).state, 'running');
  await assert.rejects(async () => manager.bindTask(apiSession.managedSessionId, taskB.taskId), /Cannot rebind running/);
  const terminal = await stream.next();
  assert.equal(terminal.value.status, 'completed');
  assert.equal(manager.getSession(apiSession.managedSessionId).state, 'idle');

  const cancelledStream = manager.send(apiSession.managedSessionId, { inputId: 'turn-cancelled', prompt: 'cancel-after-first-event' })[Symbol.asyncIterator]();
  assert.equal((await cancelledStream.next()).value.type, 'text_delta');
  assert.equal(manager.getSession(apiSession.managedSessionId).state, 'running');
  await cancelledStream.return();
  assert.equal(manager.getSession(apiSession.managedSessionId).state, 'idle', 'consumer return must release the manager send lease');

  const errorStream = manager.send(apiSession.managedSessionId, { inputId: 'turn-provider-error', prompt: 'throw' })[Symbol.asyncIterator]();
  await assert.rejects(() => errorStream.next(), /provider send failed/);
  assert.equal(manager.getSession(apiSession.managedSessionId).state, 'idle', 'provider error must release the manager send lease');

  const thrownStream = manager.send(apiSession.managedSessionId, { inputId: 'turn-consumer-throw', prompt: 'throw-from-consumer-after-first-event' })[Symbol.asyncIterator]();
  assert.equal((await thrownStream.next()).value.type, 'text_delta');
  await assert.rejects(() => thrownStream.throw(new Error('consumer aborted stream')), /consumer aborted stream/);
  assert.equal(manager.getSession(apiSession.managedSessionId).state, 'idle', 'consumer throw must release the manager send lease');

  await manager.resume(apiSession.managedSessionId, { checkpoint: 1 });
  assert.deepEqual(api.checkpoints, [{ checkpoint: 1 }]);
  assert.equal((await manager.health(apiSession.managedSessionId)).status, 'healthy');
  assert.equal((await manager.healthWorker('worker.api')).status, 'healthy');

  await manager.bindTask(apiSession.managedSessionId, taskB.taskId);
  assert.ok(tasks.getTask(taskA.taskId).workerSessions[apiSession.managedSessionId].detachedAt);
  assert.equal(tasks.getTask(taskB.taskId).workerSessions[apiSession.managedSessionId].workerId, 'worker.api');

  await manager.interrupt(agentSession.managedSessionId);
  assert.equal(manager.getSession(agentSession.managedSessionId).state, 'interrupted');
  assert.deepEqual(agent.interrupted, ['provider-session']);

  await manager.dispose(apiSession.managedSessionId);
  await manager.dispose(agentSession.managedSessionId);
  assert.ok(tasks.getTask(taskB.taskId).workerSessions[apiSession.managedSessionId].detachedAt);
  assert.ok(tasks.getTask(taskA.taskId).workerSessions[agentSession.managedSessionId].detachedAt);
  assert.equal(manager.listSessions().length, 0);

  // Durable provider-native death must be authoritative even when this Manager
  // has no local tombstone. Re-wrap the same native identity first, then retire
  // only the historical Task-owned ref directly in durable Task state.
  api.nextSessionId = 'provider-durable-death';
  const durableOwner = await manager.createSession('worker.api', { model: 'fake-model' }, taskA.taskId);
  await manager.dispose(durableOwner.managedSessionId);
  const durableFresh = await manager.createSession('worker.api', { model: 'fake-model' }, taskB.taskId);
  const durableHostStream = manager.send(durableFresh.managedSessionId, {
    inputId: 'durable-death-host-result',
    prompt: 'host-request',
  })[Symbol.asyncIterator]();
  const durableHostCall = await durableHostStream.next();
  assert.equal(durableHostCall.value.type, 'capability_call');
  await tasks.retireWorkerSessionStrict(taskA.taskId, durableOwner.managedSessionId, { reason: 'durable-native-death-test' });
  await assert.rejects(
    () => manager.submitCapabilityResult(durableFresh.managedSessionId, {
      inputId: 'durable-death-host-result', callId: 'call-host-result', name: 'read_files', text: 'MUST_NOT_DELIVER',
    }),
    /retired/,
    'durable provider-native death must reject host capability result delivery without relying on a Manager-local tombstone',
  );
  await durableHostStream.return();
  const durableDeadSend = manager.send(durableFresh.managedSessionId, {
    inputId: 'durable-death-send',
    prompt: 'must not start',
  })[Symbol.asyncIterator]();
  await assert.rejects(
    () => durableDeadSend.next(),
    /retired/,
    'durable provider-native death must reject first send consumption without a Manager-local tombstone',
  );
  await assert.rejects(
    () => manager.resume(durableFresh.managedSessionId, { checkpoint: 'must-not-resume' }),
    /retired/,
    'durable provider-native death must reject resume on an already-published fresh wrapper',
  );
  await assert.rejects(
    () => manager.bindTask(durableFresh.managedSessionId, taskC.taskId),
    /retired/,
    'durable provider-native death must reject rebind on an already-published fresh wrapper',
  );
  api.nextSessionId = 'provider-after-durable-death';
  const durableReplacement = await manager.createSession('worker.api', { model: 'fake-model' }, taskB.taskId);
  assert.equal(durableReplacement.adapterSessionId, 'provider-after-durable-death', 'the Task remains able to use a genuinely new provider-native Worker');
  await manager.dispose(durableReplacement.managedSessionId);

  await tasks.configureMission(taskC.taskId, {
    projectId: 'worker-manager-project',
    rootMissionId: taskC.taskId,
    plane: 'practice',
    missionType: 'direct-finalization-native-death',
    completionCriteria: ['Finalization itself establishes durable provider-native death'],
  });
  api.nextSessionId = 'provider-direct-finalization';
  const directFinalizedWorker = await manager.createSession('worker.api', { model: 'fake-model' }, taskC.taskId);
  await tasks.finalizeMissionStrict(taskC.taskId, { handoffRequired: false });
  assert.equal(
    await tasks.isWorkerAdapterSessionRetired('worker.api', directFinalizedWorker.adapterSessionId),
    true,
    'durable Mission finalization itself must make every owned provider-native identity dead before explicit retirement bookkeeping',
  );
  const directFinalizedSend = manager.send(directFinalizedWorker.managedSessionId, {
    inputId: 'direct-finalized-send', prompt: 'must not run after terminal Mission state',
  })[Symbol.asyncIterator]();
  await assert.rejects(() => directFinalizedSend.next(), /retired/);
  await assert.rejects(
    () => manager.createSession('worker.api', { model: 'fake-model' }, taskB.taskId),
    /Adapter session is retired and cannot be reused/,
    'a fresh wrapper cannot resurrect a native identity whose owning Mission is durably finalized',
  );

  manager.unregister('worker.api');
  manager.unregister('worker.agent');

  await tasks.flush();
  const restarted = new TaskRuntime({ storageDirectory: taskDirectory });
  await restarted.initialize();
  assert.deepEqual(restarted.getTask(taskA.taskId).workerSessions, tasks.getTask(taskA.taskId).workerSessions);
  assert.deepEqual(restarted.getTask(taskB.taskId).workerSessions, tasks.getTask(taskB.taskId).workerSessions);

  console.log('[smoke] WorkerSessionManager registry/routing/task binding/replay ok');
} finally {
  await Promise.all([
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
