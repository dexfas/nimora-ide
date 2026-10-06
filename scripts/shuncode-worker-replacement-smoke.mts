import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-worker-assignment-bundle-'));
const bundlePath = path.join(bundleDirectory, 'worker-assignment-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { TaskRuntime } from './src/task-runtime.ts';
      export { WorkerSessionManager } from './src/worker-session-manager.ts';
      export { MissionFinalizationService } from './src/mission-finalization-service.ts';
      export {
        MissionWorkerAssignmentService,
        WorkerAssignmentCandidateUnavailableError,
        WorkerAssignmentBoundSessionInvalidError,
        WorkerAssignmentCreateFailedError,
        WorkerAssignmentConflictError,
        WorkerAssignmentNoAdmissibleCandidateError,
      } from './src/worker-assignment.ts';
    `,
    resolveDir: root,
    sourcefile: 'worker-assignment-smoke-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});

const {
  TaskRuntime,
  WorkerSessionManager,
  MissionFinalizationService,
  MissionWorkerAssignmentService,
  WorkerAssignmentCandidateUnavailableError,
  WorkerAssignmentBoundSessionInvalidError,
  WorkerAssignmentCreateFailedError,
  WorkerAssignmentConflictError,
  WorkerAssignmentNoAdmissibleCandidateError,
} = require(bundlePath);

const healthyCapabilities = Object.freeze({
  streaming: true,
  reasoning: true,
  capabilityRequests: true,
  imageInput: true,
  checkpoints: true,
  interruption: true,
  persistentContext: true,
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class FakeAdapter {
  createCount = 0;
  sendCount = 0;
  disposeCount = 0;
  describeCount = 0;
  createdSessionIds = [];
  disposedSessionIds = [];
  failCreate = false;
  describeError = undefined;
  sessionModelOverride = undefined;
  createGate = undefined;

  constructor(id, options = {}) {
    this.id = id;
    this.provider = options.provider ?? `definition.${id}`;
    this.kind = options.kind ?? 'api';
    this.models = options.models ?? ['model-a', 'model-b', 'model-c'];
    this.capabilities = options.capabilities ?? healthyCapabilities;
    this.availability = options.availability ?? 'available';
  }

  async describe() {
    this.describeCount += 1;
    if (this.describeError) throw this.describeError;
    return {
      id: this.id,
      provider: this.provider,
      kind: this.kind,
      label: `Fake ${this.id}`,
      availability: this.availability,
      models: [...this.models],
      capabilities: { ...this.capabilities },
    };
  }

  async createSession(options) {
    this.createCount += 1;
    const sessionId = `${this.id}-native-${this.createCount}`;
    this.createdSessionIds.push(sessionId);
    const gate = this.createGate;
    if (gate) {
      gate.started.resolve(sessionId);
      await gate.release.promise;
      if (this.createGate === gate) this.createGate = undefined;
    }
    if (this.failCreate) throw new Error(`ambiguous create failure from ${this.id}`);
    const now = new Date().toISOString();
    return {
      sessionId,
      workerId: this.id,
      state: 'idle',
      model: this.sessionModelOverride ?? options.model,
      contextHandle: options.contextHandle,
      createdAt: now,
      lastActiveAt: now,
    };
  }

  async *send(_session, input) {
    this.sendCount += 1;
    yield { type: 'terminal', inputId: input.inputId, status: 'completed' };
  }

  async interrupt() {}

  async dispose(session) {
    this.disposeCount += 1;
    this.disposedSessionIds.push(session.sessionId);
    session.state = 'disposed';
  }

  async health() {
    return { status: 'healthy', checkedAt: new Date().toISOString() };
  }
}

class FakeCandidateSource {
  enumerateCount = 0;
  refreshCount = new Map();
  materializeCount = new Map();
  refreshOverrides = new Map();
  materializeErrors = new Map();

  constructor(candidates) {
    this.candidates = candidates;
  }

  async enumerateCandidates() {
    this.enumerateCount += 1;
    return structuredClone(this.candidates);
  }

  async refreshCandidate(candidate) {
    this.refreshCount.set(candidate.candidateId, (this.refreshCount.get(candidate.candidateId) ?? 0) + 1);
    if (this.refreshOverrides.has(candidate.candidateId)) {
      const override = this.refreshOverrides.get(candidate.candidateId);
      if (override instanceof Error) throw override;
      return override === undefined ? undefined : structuredClone(override);
    }
    return freshCandidate(candidate);
  }

  async materializeSessionOptions(candidate, selection) {
    this.materializeCount.set(candidate.candidateId, (this.materializeCount.get(candidate.candidateId) ?? 0) + 1);
    const error = this.materializeErrors.get(candidate.candidateId);
    if (error) throw error;
    return {
      model: selection.model,
      extensions: { opaqueCandidateLocator: `opaque:${candidate.candidateId}:${candidate.observationId}` },
    };
  }
}

function candidate(candidateId, workerId, overrides = {}) {
  return {
    candidateId,
    workerId,
    provider: overrides.provider ?? 'provider-a',
    kind: overrides.kind ?? 'api',
    availability: overrides.availability ?? 'available',
    models: overrides.models ?? ['model-a', 'model-b'],
    capabilities: { ...healthyCapabilities, ...(overrides.capabilities ?? {}) },
    observationId: overrides.observationId ?? `observed:${candidateId}:1`,
    observedAt: overrides.observedAt ?? '2026-09-15T12:00:00.000Z',
    health: overrides.health === null ? undefined : (overrides.health ?? {
      status: 'healthy',
      checkedAt: '2026-09-15T12:00:00.000Z',
    }),
  };
}

function freshCandidate(input, overrides = {}) {
  return {
    ...structuredClone(input),
    ...overrides,
    observationId: overrides.observationId ?? `${input.observationId}:fresh`,
    observedAt: overrides.observedAt ?? '2026-09-15T12:00:01.000Z',
    health: overrides.health === null ? undefined : (overrides.health ?? {
      status: 'healthy',
      checkedAt: '2026-09-15T12:00:01.000Z',
    }),
  };
}

let managedId = 0;
let missionKey = 0;

async function createHarness(label, taskBindingsFactory = undefined) {
  const storageDirectory = await fs.mkdtemp(path.join(os.tmpdir(), `nimora-assignment-${label}-`));
  const tasks = new TaskRuntime({ storageDirectory });
  await tasks.initialize();
  const taskBindings = taskBindingsFactory ? taskBindingsFactory(tasks) : tasks;
  const manager = new WorkerSessionManager({ taskBindings, newId: () => `assignment-managed-${++managedId}` });
  return { storageDirectory, tasks, manager, adapters: [] };
}

async function registerAdapter(harness, id, options = {}) {
  const adapter = new FakeAdapter(id, options);
  harness.adapters.push(adapter);
  await harness.manager.register(adapter);
  return adapter;
}

async function createRootMission(tasks, projectId = 'project-assignment') {
  const task = await tasks.ensureTask({ kind: 'mission', key: `assignment-mission-${++missionKey}` }, 'Assignment Mission');
  await tasks.configureMission(task.taskId, {
    projectId,
    rootMissionId: task.taskId,
    plane: 'practice',
    missionType: 'assignment-smoke',
    completionCriteria: ['Assignment safety is mechanically proven'],
  });
  return tasks.getTask(task.taskId);
}

function requestFor(mission, overrides = {}) {
  return {
    projectId: mission.mission.projectId,
    rootMissionId: mission.mission.rootMissionId,
    missionId: mission.taskId,
    ...overrides,
  };
}

const cleanupDirectories = [];
async function fixture(label) {
  const h = await createHarness(`replacement-${label}`); cleanupDirectories.push(h.storageDirectory);
  const a = await registerAdapter(h, `a.${label}`, { provider: 'provider-a' });
  const b = await registerAdapter(h, `b.${label}`, { provider: 'provider-b' });
  const mission = await createRootMission(h.tasks);
  const source = new FakeCandidateSource([
    candidate(`a-${label}`, a.id, { provider: 'provider-a' }),
    candidate(`b-${label}`, b.id, { provider: 'provider-b' }),
  ]);
  const service = new MissionWorkerAssignmentService(h.tasks, h.manager, [source]);
  const old = await service.assignInitial(requestFor(mission, { constraints: { allowedProviders: ['provider-a'], requiredModel: 'model-a' } }));
  const next = requestFor(mission, { constraints: { allowedProviders: ['provider-b'], requiredModel: 'model-b' } });
  return { ...h, a, b, mission, source, service, old, next };
}
try {
  const cross = await fixture('cross');
  const swapped = await cross.service.replaceSettled(cross.next, cross.old.managedSessionId);
  assert.equal(swapped.provider, 'provider-b'); assert.equal(swapped.model, 'model-b');
  assert.equal(swapped.missionId, cross.mission.taskId);
  assert.equal(cross.a.disposeCount, 1); assert.equal(cross.b.createCount, 1);
  assert.equal(cross.a.sendCount + cross.b.sendCount, 0, 'replacement does not execute or replay');
  assert(cross.tasks.getTask(cross.mission.taskId).workerSessions[cross.old.managedSessionId].retiredAt);
  await assert.rejects(() => cross.service.replaceSettled(cross.next, cross.old.managedSessionId), /exact live/);
  const restarted = new TaskRuntime({ storageDirectory: cross.storageDirectory }); await restarted.initialize();
  const durable = restarted.getTask(cross.mission.taskId);
  assert.deepEqual(durable.mission, cross.tasks.getTask(cross.mission.taskId).mission);
  assert.equal(Object.values(durable.workerSessions).filter(ref => !ref.retiredAt && !ref.detachedAt).length, 1);
  assert.equal(durable.workerSessions[swapped.managedSessionId].model, 'model-b');
  const emptyManager = new WorkerSessionManager({ taskBindings: restarted });
  const restartService = new MissionWorkerAssignmentService(restarted, emptyManager, [cross.source]);
  await assert.rejects(() => restartService.replaceSettled(cross.next, swapped.managedSessionId), /UNKNOWN/);

  // Canonical Task work outcomes are not the Mission death boundary.
  // Append legal status rows only inside these disposable test journals.
  for (const status of ['completed', 'failed', 'cancelled']) {
    const h = await fixture('status-only-' + status);
    await h.tasks.flush();
    await fs.appendFile(path.join(h.storageDirectory, h.mission.taskId + '.jsonl'), JSON.stringify({
      version: 1, eventId: 'status-only-' + status, taskId: h.mission.taskId,
      at: new Date().toISOString(), type: 'TaskStatusChanged', payload: { status },
    }) + '\n', 'utf8');
    await h.tasks.rereadTask(h.mission.taskId);
    assert.equal(h.tasks.getTask(h.mission.taskId).status, status);
    const replacement = await h.service.replaceSettled(h.next, h.old.managedSessionId);
    assert.equal(replacement.missionId, h.mission.taskId);
    assert.equal(h.tasks.getTask(h.mission.taskId).missionFinalization, undefined);
    assert.equal(h.a.sendCount + h.b.sendCount, 0);
    const finalizer = new MissionFinalizationService(h.tasks, h.manager);
    await finalizer.finalizeMission(h.mission.taskId);
    await assert.rejects(() => h.service.assignInitial(h.next), /terminal/,
      'genuine Mission finalization must still reject assignment');
  }

  const invalid = await fixture('invalid');
  await assert.rejects(() => invalid.service.replaceSettled({ ...invalid.next, constraints: { allowedProviders: [] } }, invalid.old.managedSessionId), /must not be empty/);
  assert.equal(invalid.a.disposeCount, 0);
  let accessorRead = false;
  const constraints = {}; Object.defineProperty(constraints, 'allowedProviders', { get() { accessorRead = true; return ['provider-b']; } });
  await assert.rejects(() => invalid.service.replaceSettled({ ...invalid.next, constraints }, invalid.old.managedSessionId), /own data/);
  assert.equal(accessorRead, false);

  for (const status of ['requested', 'executing', 'unknown']) {
    const h = await fixture(status);
    await h.tasks.beginExecution(h.mission.taskId, { executionId: status, toolName: 'test' });
    if (status === 'unknown') await h.tasks.finishExecution(h.mission.taskId, status, 'unknown');
    await assert.rejects(() => h.service.replaceSettled(h.next, h.old.managedSessionId), /known-settled/);
    assert.equal(h.a.disposeCount, 0); assert.equal(h.b.createCount, 0);
  }

  const unsettled = await fixture('ambiguous-send');
  unsettled.a.send = async function* () { throw new Error('provider-outcome-unknown'); };
  await assert.rejects(async () => { for await (const _ of unsettled.manager.send(unsettled.old.managedSessionId, { inputId: 'ambiguous', prompt: 'do work' })) {} }, /provider-outcome-unknown/);
  assert.equal(unsettled.manager.getSession(unsettled.old.managedSessionId).state, 'idle');
  await assert.rejects(() => unsettled.service.replaceSettled(unsettled.next, unsettled.old.managedSessionId), /known-settled/);
  assert.equal(unsettled.b.createCount, 0, 'idle after ambiguous send is not settlement');

  const settled = await fixture('settled-send');
  for await (const _ of settled.manager.send(settled.old.managedSessionId, { inputId: 'done', prompt: 'do work' })) {}
  await settled.service.replaceSettled(settled.next, settled.old.managedSessionId);

  const busy = await fixture('busy'); const started = deferred(), release = deferred();
  busy.a.send = async function* (_session, input) { started.resolve(); await release.promise; yield { type: 'terminal', status: 'completed', inputId: input.inputId }; };
  const sending = (async () => { for await (const _ of busy.manager.send(busy.old.managedSessionId, { inputId: 'busy', prompt: 'wait' })) {} })();
  await started.promise;
  await assert.rejects(() => busy.service.replaceSettled(busy.next, busy.old.managedSessionId), /known-settled/);
  release.resolve(); await sending;

  const race = await fixture('race');
  const outcomes = await Promise.allSettled([race.service.replaceSettled(race.next, race.old.managedSessionId), race.service.replaceSettled(race.next, race.old.managedSessionId)]);
  assert.equal(outcomes.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(race.b.createCount, 1);

  const failure = await fixture('create-failure'); failure.b.failCreate = true;
  await assert.rejects(() => failure.service.replaceSettled(failure.next, failure.old.managedSessionId), /ambiguous create/);
  assert.equal(failure.a.createCount, 1, 'never fallback to retired provider');
  assert.equal(failure.b.createCount, 1);

  const cleanup = await fixture('cleanup-failure'); cleanup.a.dispose = async () => { throw new Error('cleanup unknown'); };
  await assert.rejects(() => cleanup.service.replaceSettled(cleanup.next, cleanup.old.managedSessionId), /cleanup or ownership/);
  assert.equal(cleanup.b.createCount, 0);
  console.log('WO2 replacement smoke passed: cross-provider/model, restart truth, ambiguity, active send, races, no replay/fallback, cleanup failures.');
} finally {
  for (const dir of [...cleanupDirectories, bundleDirectory]) {
    const resolved = path.resolve(dir);
    assert(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('nimora-'));
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
