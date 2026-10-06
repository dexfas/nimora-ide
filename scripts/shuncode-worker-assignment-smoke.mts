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

try {
  // Exact scope validation and unsupported requirement keys fail before resource observation/creation.
  {
    const harness = await createHarness('scope'); cleanupDirectories.push(harness.storageDirectory);
    const adapter = await registerAdapter(harness, 'worker.scope');
    const mission = await createRootMission(harness.tasks, 'project-scope');
    const source = new FakeCandidateSource([candidate('candidate-scope', adapter.id)]);
    const service = new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]);
    await assert.rejects(() => service.assignInitial({ ...requestFor(mission), projectId: 'wrong-project' }), /does not belong to Project/);
    await assert.rejects(() => service.assignInitial({ ...requestFor(mission), rootMissionId: 'wrong-root' }), /does not belong to root Mission/);
    await assert.rejects(() => service.assignInitial({ ...requestFor(mission), missionId: 'unknown-mission' }), /Unknown task/);
    await assert.rejects(
      () => service.assignInitial({ ...requestFor(mission), constraints: { unsupportedRequirement: true } }),
      /unsupported key.*unsupportedRequirement/,
    );
    await assert.rejects(
      () => service.assignInitial({ ...requestFor(mission), constraints: { requiredCapabilities: { inventedCapability: true } } }),
      /unsupported key.*inventedCapability/,
    );
    assert.equal(source.enumerateCount, 0, 'wrong scope/unknown constraints must reject before candidate enumeration');
    assert.equal(adapter.createCount, 0, 'wrong scope must reject before resource creation');
  }

  // P7-WO1-R1: explicit empty hard allowlists fail closed before candidate observation/creation.
  {
    const harness = await createHarness('empty-allowlists'); cleanupDirectories.push(harness.storageDirectory);
    const adapter = await registerAdapter(harness, 'worker.empty-allowlists');
    const mission = await createRootMission(harness.tasks);
    const source = new FakeCandidateSource([candidate('candidate-empty-allowlists', adapter.id)]);
    const service = new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]);
    await assert.rejects(
      () => service.assignInitial({ ...requestFor(mission), constraints: { allowedProviders: [] } }),
      /allowedProviders must not be empty/,
    );
    await assert.rejects(
      () => service.assignInitial({ ...requestFor(mission), constraints: { allowedKinds: [] } }),
      /allowedKinds must not be empty/,
    );
    assert.equal(source.enumerateCount, 0, 'empty hard allowlists must reject before candidate observation');
    assert.equal(adapter.createCount, 0, 'empty hard allowlists must never create a WorkerSession');
    assert.equal(adapter.sendCount, 0, 'empty hard allowlists must never send');
  }

  // Finalized Missions reject before candidate observation.
  {
    const harness = await createHarness('terminal'); cleanupDirectories.push(harness.storageDirectory);
    const adapter = await registerAdapter(harness, 'worker.terminal');
    const mission = await createRootMission(harness.tasks);
    const finalizer = new MissionFinalizationService(harness.tasks, harness.manager);
    await finalizer.finalizeMission(mission.taskId, { requireHandoff: false });
    const source = new FakeCandidateSource([candidate('candidate-terminal', adapter.id)]);
    const service = new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]);
    await assert.rejects(() => service.assignInitial(requestFor(mission)), /terminal.*cannot accept an initial Worker assignment|terminal/);
    assert.equal(source.enumerateCount, 0);
    assert.equal(adapter.createCount, 0);
  }

  // Hard constraints: capability/model/provider/kind/availability are mechanical filters.
  {
    const harness = await createHarness('constraints'); cleanupDirectories.push(harness.storageDirectory);
    const adapter = await registerAdapter(harness, 'worker.constraints');
    const scenarios = [
      { candidate: candidate('missing-capability', adapter.id, { capabilities: { reasoning: false } }), constraints: { requiredCapabilities: { reasoning: true } } },
      { candidate: candidate('unsupported-model', adapter.id, { models: ['model-a'] }), constraints: { requiredModel: 'model-c' } },
      { candidate: candidate('forbidden-provider', adapter.id, { provider: 'provider-forbidden' }), constraints: { forbiddenProviders: ['provider-forbidden'] } },
      { candidate: candidate('provider-not-allowed', adapter.id, { provider: 'provider-other' }), constraints: { allowedProviders: ['provider-allowed'] } },
      { candidate: candidate('wrong-kind', adapter.id), constraints: { allowedKinds: ['web'] } },
      { candidate: candidate('unavailable', adapter.id, { availability: 'unavailable' }), constraints: {} },
      { candidate: candidate('offline', adapter.id, { availability: 'offline' }), constraints: {} },
    ];
    for (const scenario of scenarios) {
      const mission = await createRootMission(harness.tasks);
      const source = new FakeCandidateSource([scenario.candidate]);
      const service = new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]);
      await assert.rejects(
        () => service.assignInitial({ ...requestFor(mission), constraints: scenario.constraints }),
        error => error instanceof WorkerAssignmentNoAdmissibleCandidateError,
      );
    }
    assert.equal(adapter.createCount, 0, 'hard-inadmissible resources must never create sessions');
  }

  // Hard constraints outrank soft provider/model preferences.
  {
    const harness = await createHarness('hard-soft'); cleanupDirectories.push(harness.storageDirectory);
    const forbiddenAdapter = await registerAdapter(harness, 'worker.preferred');
    const allowedAdapter = await registerAdapter(harness, 'worker.allowed');
    const mission = await createRootMission(harness.tasks);
    const beforeMissionMetadata = structuredClone(mission.mission);
    const source = new FakeCandidateSource([
      candidate('candidate-preferred', forbiddenAdapter.id, { provider: 'provider-preferred', models: ['model-a'] }),
      candidate('candidate-allowed', allowedAdapter.id, { provider: 'provider-allowed', models: ['model-b'] }),
    ]);
    const service = new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]);
    const result = await service.assignInitial({
      ...requestFor(mission),
      constraints: { forbiddenProviders: ['provider-preferred'] },
      preferences: { providerOrder: ['provider-preferred', 'provider-allowed'], modelOrder: ['model-a', 'model-b'] },
    });
    assert.equal(result.candidateId, 'candidate-allowed');
    assert.equal(result.model, 'model-b');
    assert.equal(forbiddenAdapter.createCount, 0);
    assert.equal(allowedAdapter.createCount, 1);
    assert.deepEqual(harness.tasks.getTask(mission.taskId).mission, beforeMissionMetadata, 'assignment must not mutate TaskMissionMetadata');
    const files = await fs.readdir(harness.storageDirectory);
    assert.equal(files.some(name => /assignment|pool|scheduler/i.test(name)), false, 'assignment must not create a new journal/queue file');
  }

  // Equal score uses stable candidateId independent of enumeration order.
  {
    const harness = await createHarness('tie'); cleanupDirectories.push(harness.storageDirectory);
    const adapterA = await registerAdapter(harness, 'worker.tie-a');
    const adapterB = await registerAdapter(harness, 'worker.tie-b');
    const a = candidate('candidate-a', adapterA.id, { provider: 'provider-tie' });
    const b = candidate('candidate-b', adapterB.id, { provider: 'provider-tie' });
    const mission1 = await createRootMission(harness.tasks);
    const mission2 = await createRootMission(harness.tasks);
    const result1 = await new MissionWorkerAssignmentService(harness.tasks, harness.manager, [new FakeCandidateSource([b, a])]).assignInitial(requestFor(mission1));
    const result2 = await new MissionWorkerAssignmentService(harness.tasks, harness.manager, [new FakeCandidateSource([a, b])]).assignInitial(requestFor(mission2));
    assert.equal(result1.candidateId, 'candidate-a');
    assert.equal(result2.candidateId, 'candidate-a');
  }

  // Fresh refresh controls admission: stale/unhealthy candidate is skipped; degraded-only is rejected.
  {
    const harness = await createHarness('fresh'); cleanupDirectories.push(harness.storageDirectory);
    const adapterA = await registerAdapter(harness, 'worker.stale');
    const adapterB = await registerAdapter(harness, 'worker.fresh');
    const stale = candidate('candidate-a-stale', adapterA.id);
    const fresh = candidate('candidate-b-fresh', adapterB.id);
    const source = new FakeCandidateSource([stale, fresh]);
    source.refreshOverrides.set(stale.candidateId, freshCandidate(stale, {
      availability: 'unavailable',
      health: { status: 'offline', checkedAt: '2026-09-15T12:00:01.000Z' },
    }));
    const mission = await createRootMission(harness.tasks);
    const result = await new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]).assignInitial(requestFor(mission));
    assert.equal(result.candidateId, fresh.candidateId);
    assert.equal(adapterA.createCount, 0);
    assert.equal(adapterB.createCount, 1);

    const degradedMission = await createRootMission(harness.tasks);
    const degraded = candidate('candidate-degraded', adapterA.id);
    const degradedSource = new FakeCandidateSource([degraded]);
    degradedSource.refreshOverrides.set(degraded.candidateId, freshCandidate(degraded, {
      health: { status: 'degraded', checkedAt: '2026-09-15T12:00:01.000Z' },
    }));
    await assert.rejects(
      () => new MissionWorkerAssignmentService(harness.tasks, harness.manager, [degradedSource]).assignInitial(requestFor(degradedMission)),
      error => error instanceof WorkerAssignmentNoAdmissibleCandidateError,
    );
    assert.equal(adapterA.createCount, 0, 'degraded-only candidate must not auto-create');

    const missingHealthMission = await createRootMission(harness.tasks);
    const missingHealth = candidate('candidate-missing-health', adapterA.id);
    const missingHealthSource = new FakeCandidateSource([missingHealth]);
    missingHealthSource.refreshOverrides.set(missingHealth.candidateId, freshCandidate(missingHealth, { health: null }));
    await assert.rejects(
      () => new MissionWorkerAssignmentService(harness.tasks, harness.manager, [missingHealthSource]).assignInitial(requestFor(missingHealthMission)),
      error => error instanceof WorkerAssignmentNoAdmissibleCandidateError,
    );

    const unrefreshableMission = await createRootMission(harness.tasks);
    const unrefreshable = candidate('candidate-unrefreshable', adapterA.id);
    const unrefreshableSource = new FakeCandidateSource([unrefreshable]);
    unrefreshableSource.refreshOverrides.set(unrefreshable.candidateId, undefined);
    await assert.rejects(
      () => new MissionWorkerAssignmentService(harness.tasks, harness.manager, [unrefreshableSource]).assignInitial(requestFor(unrefreshableMission)),
      error => error instanceof WorkerAssignmentNoAdmissibleCandidateError,
    );

    const replayedObservationMission = await createRootMission(harness.tasks);
    const replayedObservation = candidate('candidate-replayed-observation', adapterA.id);
    const replayedObservationSource = new FakeCandidateSource([replayedObservation]);
    replayedObservationSource.refreshOverrides.set(replayedObservation.candidateId, structuredClone(replayedObservation));
    await assert.rejects(
      () => new MissionWorkerAssignmentService(harness.tasks, harness.manager, [replayedObservationSource]).assignInitial(requestFor(replayedObservationMission)),
      error => error instanceof WorkerAssignmentNoAdmissibleCandidateError,
    );
    assert.equal(adapterA.createCount, 0, 'missing-health, unrefreshable, and stale replayed observations must not auto-create');
  }

  // P7-WO1-R3: cached registration state cannot authorize create after the exact Worker definition changes.
  {
    const harness = await createHarness('fresh-definition'); cleanupDirectories.push(harness.storageDirectory);
    const unavailableAdapter = await registerAdapter(harness, 'worker.definition-unavailable');
    const degradedAdapter = await registerAdapter(harness, 'worker.definition-degraded');
    const capabilityAdapter = await registerAdapter(harness, 'worker.definition-capability');
    const modelAdapter = await registerAdapter(harness, 'worker.definition-model');

    unavailableAdapter.availability = 'unavailable';
    const unavailableMission = await createRootMission(harness.tasks);
    const unavailableSource = new FakeCandidateSource([candidate('candidate-definition-unavailable', unavailableAdapter.id)]);
    await assert.rejects(
      () => new MissionWorkerAssignmentService(harness.tasks, harness.manager, [unavailableSource]).assignInitial(requestFor(unavailableMission)),
      error => error instanceof WorkerAssignmentNoAdmissibleCandidateError,
    );
    assert.equal(unavailableAdapter.describeCount, 2, 'definition must be refreshed after registration');
    assert.equal(unavailableAdapter.createCount, 0, 'fresh unavailable definition must reject before create');

    degradedAdapter.availability = 'degraded';
    const degradedMission = await createRootMission(harness.tasks);
    const degradedSource = new FakeCandidateSource([candidate('candidate-definition-degraded', degradedAdapter.id)]);
    await assert.rejects(
      () => new MissionWorkerAssignmentService(harness.tasks, harness.manager, [degradedSource]).assignInitial(requestFor(degradedMission)),
      error => error instanceof WorkerAssignmentNoAdmissibleCandidateError,
    );
    assert.equal(degradedAdapter.describeCount, 2);
    assert.equal(degradedAdapter.createCount, 0, 'fresh degraded definition must reject before create');

    capabilityAdapter.capabilities = { ...healthyCapabilities, reasoning: false };
    const capabilityMission = await createRootMission(harness.tasks);
    const capabilitySource = new FakeCandidateSource([candidate('candidate-definition-capability', capabilityAdapter.id)]);
    await assert.rejects(
      () => new MissionWorkerAssignmentService(harness.tasks, harness.manager, [capabilitySource]).assignInitial({
        ...requestFor(capabilityMission),
        constraints: { requiredCapabilities: { reasoning: true } },
      }),
      error => error instanceof WorkerAssignmentNoAdmissibleCandidateError,
    );
    assert.equal(capabilityAdapter.createCount, 0, 'fresh definition capability shrink must reject stale candidate claims');
    assert.equal(capabilityAdapter.sendCount, 0, 'fresh definition capability shrink must reject before send');
    assert.equal(harness.manager.listSessions({ taskId: capabilityMission.taskId }).length, 0, 'fresh definition capability shrink must publish no Worker binding');

    modelAdapter.models = ['model-a'];
    const modelMission = await createRootMission(harness.tasks);
    const modelSource = new FakeCandidateSource([candidate('candidate-definition-model', modelAdapter.id, { models: ['model-a', 'model-b'] })]);
    await assert.rejects(
      () => new MissionWorkerAssignmentService(harness.tasks, harness.manager, [modelSource]).assignInitial(requestFor(modelMission)),
      error => error instanceof WorkerAssignmentNoAdmissibleCandidateError,
    );
    assert.equal(modelAdapter.createCount, 0, 'fresh definition model shrink must reject stale candidate claims');

    const recoveredAdapter = await registerAdapter(harness, 'worker.definition-recovered');
    recoveredAdapter.availability = 'unavailable';
    await harness.manager.refresh(recoveredAdapter.id);
    recoveredAdapter.availability = 'available';
    const recoveredMission = await createRootMission(harness.tasks);
    const recoveredSource = new FakeCandidateSource([candidate('candidate-definition-recovered', recoveredAdapter.id)]);
    const recovered = await new MissionWorkerAssignmentService(harness.tasks, harness.manager, [recoveredSource]).assignInitial(requestFor(recoveredMission));
    assert.equal(recovered.workerId, recoveredAdapter.id, 'stale cached unavailability must not suppress a fresh recovered definition');
    assert.equal(recoveredAdapter.describeCount, 3, 'recovered Worker must be refreshed again immediately before create');
  }

  // P7-FIV-001: every caller-authored boolean hard capability requirement must
  // still exact-match the final freshly refreshed WorkerDescriptor. Explicit
  // false is a requirement, not an omitted/don't-care value.
  {
    const harness = await createHarness('definition-hard-capability-equality'); cleanupDirectories.push(harness.storageDirectory);

    const falseRejectAdapter = await registerAdapter(harness, 'worker.required-false-reject', {
      capabilities: { ...healthyCapabilities, imageInput: false },
    });
    falseRejectAdapter.capabilities = { ...healthyCapabilities, imageInput: true };
    const falseRejectMission = await createRootMission(harness.tasks);
    const falseRejectSource = new FakeCandidateSource([
      candidate('candidate-required-false-reject', falseRejectAdapter.id, { capabilities: { imageInput: false } }),
    ]);
    await assert.rejects(
      () => new MissionWorkerAssignmentService(harness.tasks, harness.manager, [falseRejectSource]).assignInitial({
        ...requestFor(falseRejectMission),
        constraints: { requiredCapabilities: { imageInput: false } },
      }),
      error => error instanceof WorkerAssignmentNoAdmissibleCandidateError,
    );
    assert.equal(falseRejectAdapter.describeCount, 2, 'explicit false proof must reach the final fresh definition refresh');
    assert.equal(falseRejectAdapter.createCount, 0, 'explicit false/fresh true mismatch must reject before create');
    assert.equal(falseRejectAdapter.sendCount, 0, 'explicit false/fresh true mismatch must never send');
    assert.equal(harness.manager.listSessions({ taskId: falseRejectMission.taskId }).length, 0, 'explicit false/fresh true mismatch must publish no Manager session');
    assert.equal(
      Object.values(harness.tasks.getTask(falseRejectMission.taskId).workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt).length,
      0,
      'explicit false/fresh true mismatch must publish no authoritative Task binding',
    );

    const falseMatchAdapter = await registerAdapter(harness, 'worker.required-false-match', {
      capabilities: { ...healthyCapabilities, imageInput: false },
    });
    const falseMatchMission = await createRootMission(harness.tasks);
    const falseMatchSource = new FakeCandidateSource([
      candidate('candidate-required-false-match', falseMatchAdapter.id, { capabilities: { imageInput: false } }),
    ]);
    const falseMatch = await new MissionWorkerAssignmentService(harness.tasks, harness.manager, [falseMatchSource]).assignInitial({
      ...requestFor(falseMatchMission),
      constraints: { requiredCapabilities: { imageInput: false } },
    });
    assert.equal(falseMatch.workerId, falseMatchAdapter.id, 'matching explicit false must remain eligible');
    assert.equal(falseMatchAdapter.createCount, 1);
    assert.equal(falseMatchAdapter.sendCount, 0);

    const growthAdapter = await registerAdapter(harness, 'worker.unconstrained-growth', {
      capabilities: { ...healthyCapabilities, imageInput: false },
    });
    growthAdapter.capabilities = { ...healthyCapabilities, imageInput: true };
    const growthMission = await createRootMission(harness.tasks);
    const growthSource = new FakeCandidateSource([
      candidate('candidate-unconstrained-growth', growthAdapter.id, { capabilities: { imageInput: false } }),
    ]);
    const growth = await new MissionWorkerAssignmentService(harness.tasks, harness.manager, [growthSource]).assignInitial(requestFor(growthMission));
    assert.equal(growth.workerId, growthAdapter.id, 'unspecified false->true descriptor growth must not be rejected merely because capability grew');
    assert.equal(growthAdapter.describeCount, 2);
    assert.equal(growthAdapter.createCount, 1);

    const fallbackRejectAdapter = await registerAdapter(harness, 'worker.required-false-fallback-reject', {
      capabilities: { ...healthyCapabilities, imageInput: false },
    });
    const fallbackMatchAdapter = await registerAdapter(harness, 'worker.required-false-fallback-match', {
      capabilities: { ...healthyCapabilities, imageInput: false },
    });
    fallbackRejectAdapter.capabilities = { ...healthyCapabilities, imageInput: true };
    const fallbackMission = await createRootMission(harness.tasks);
    const fallbackSource = new FakeCandidateSource([
      candidate('candidate-a-required-false-reject', fallbackRejectAdapter.id, { capabilities: { imageInput: false } }),
      candidate('candidate-b-required-false-match', fallbackMatchAdapter.id, { capabilities: { imageInput: false } }),
    ]);
    const fallback = await new MissionWorkerAssignmentService(harness.tasks, harness.manager, [fallbackSource]).assignInitial({
      ...requestFor(fallbackMission),
      constraints: { requiredCapabilities: { imageInput: false } },
    });
    assert.equal(fallback.candidateId, 'candidate-b-required-false-match', 'known final-definition hard-constraint mismatch may fall through to the next independently admissible candidate');
    assert.equal(fallbackRejectAdapter.createCount, 0, 'final-definition mismatch is a known pre-create rejection');
    assert.equal(fallbackRejectAdapter.sendCount, 0);
    assert.equal(fallbackMatchAdapter.createCount, 1);
    assert.equal(fallbackMatchAdapter.sendCount, 0);
  }

  // Definition refresh failure is ambiguous and must not become fallback authority.
  {
    const harness = await createHarness('definition-refresh-error'); cleanupDirectories.push(harness.storageDirectory);
    const adapterA = await registerAdapter(harness, 'worker.definition-refresh-error');
    const adapterB = await registerAdapter(harness, 'worker.definition-refresh-fallback');
    adapterA.describeError = new Error('definition refresh ambiguous');
    const mission = await createRootMission(harness.tasks);
    const source = new FakeCandidateSource([
      candidate('candidate-a-definition-refresh-error', adapterA.id),
      candidate('candidate-b-definition-fallback', adapterB.id),
    ]);
    await assert.rejects(
      () => new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]).assignInitial(requestFor(mission)),
      /definition refresh ambiguous/,
    );
    assert.equal(adapterA.createCount, 0);
    assert.equal(adapterB.createCount, 0, 'ambiguous definition refresh must not fall through to another candidate');
  }

  // Explicit pre-create unavailability may fall through, and assignment never sends Mission input.
  {
    const harness = await createHarness('fallback'); cleanupDirectories.push(harness.storageDirectory);
    const adapterA = await registerAdapter(harness, 'worker.precreate-unavailable');
    const adapterB = await registerAdapter(harness, 'worker.precreate-next');
    const first = candidate('candidate-a-first', adapterA.id);
    const second = candidate('candidate-b-next', adapterB.id);
    const source = new FakeCandidateSource([first, second]);
    source.materializeErrors.set(first.candidateId, new WorkerAssignmentCandidateUnavailableError('resource disappeared before create'));
    const mission = await createRootMission(harness.tasks);
    const result = await new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]).assignInitial(requestFor(mission));
    assert.equal(result.candidateId, second.candidateId);
    assert.equal(adapterA.createCount, 0, 'pre-create unavailability must be classified before Manager create');
    assert.equal(adapterB.createCount, 1);
    assert.equal(adapterA.sendCount + adapterB.sendCount, 0, 'assignment must never send model input');
  }

  // Arbitrary create/bind failure must not blind-create a fallback session.
  {
    const harness = await createHarness('create-failure'); cleanupDirectories.push(harness.storageDirectory);
    const adapterA = await registerAdapter(harness, 'worker.create-fails');
    const adapterB = await registerAdapter(harness, 'worker.must-not-fallback');
    adapterA.failCreate = true;
    const mission = await createRootMission(harness.tasks);
    const source = new FakeCandidateSource([
      candidate('candidate-a-create-fails', adapterA.id),
      candidate('candidate-b-must-not-run', adapterB.id),
    ]);
    await assert.rejects(
      () => new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]).assignInitial(requestFor(mission)),
      error => error instanceof WorkerAssignmentCreateFailedError && /automatic fallback is not authorized/.test(error.message),
    );
    assert.equal(adapterA.createCount, 1);
    assert.equal(adapterB.createCount, 0, 'arbitrary create failure must not create the next candidate');
  }

  // P7-WO1-R2: authoritative bound-session model must preserve the selected/required model.
  // A post-bind mismatch is retired through Manager lifecycle ownership and never falls back.
  {
    const harness = await createHarness('bound-model-mismatch'); cleanupDirectories.push(harness.storageDirectory);
    const adapterA = await registerAdapter(harness, 'worker.bound-model-mismatch');
    const adapterB = await registerAdapter(harness, 'worker.bound-model-fallback');
    adapterA.sessionModelOverride = 'model-b';
    const mission = await createRootMission(harness.tasks);
    const source = new FakeCandidateSource([
      candidate('candidate-a-bound-model-mismatch', adapterA.id, { models: ['model-a', 'model-b'] }),
      candidate('candidate-b-bound-model-fallback', adapterB.id, { models: ['model-a', 'model-b'] }),
    ]);
    await assert.rejects(
      () => new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]).assignInitial({
        ...requestFor(mission),
        constraints: { requiredModel: 'model-a' },
      }),
      error => error instanceof WorkerAssignmentBoundSessionInvalidError && /authoritative model model-b does not equal selected model model-a/.test(error.message),
    );
    assert.equal(adapterA.createCount, 1, 'mismatching provider session must have actually crossed create+bind');
    assert.equal(adapterB.createCount, 0, 'post-create model mismatch must never fall through to another candidate');
    assert.equal(adapterA.sendCount + adapterB.sendCount, 0, 'model mismatch cleanup must not send');
    assert.equal(harness.manager.listSessions({ taskId: mission.taskId }).length, 0, 'mismatching bound session must leave no active Manager session');
    const retired = harness.manager.listRetiredSessions({ taskId: mission.taskId });
    assert.equal(retired.length, 1, 'exact mismatching session must be retired through Manager ownership');
    assert.equal(retired[0].model, 'model-b');
    assert.equal(retired[0].retirementReason, 'assignment-model-mismatch');
    assert.equal(retired[0].disposeError, undefined, 'successful mismatch cleanup must dispose the provider handle');
    assert.ok(adapterA.disposedSessionIds.includes(retired[0].adapterSessionId));
    const activeTaskBindings = Object.values(harness.tasks.getTask(mission.taskId).workerSessions)
      .filter(worker => !worker.detachedAt && !worker.retiredAt);
    assert.equal(activeTaskBindings.length, 0, 'mismatching session must leave no active Task Worker binding');
    assert.ok(harness.tasks.getTask(mission.taskId).workerSessions[retired[0].managedSessionId].retiredAt, 'Task must retain only retired lifecycle history');
  }

  // An authoritative model that was never advertised by the refreshed candidate is equally invalid,
  // even when no exact model was selected by the request/preferences.
  {
    const harness = await createHarness('bound-unadvertised-model'); cleanupDirectories.push(harness.storageDirectory);
    const adapter = await registerAdapter(harness, 'worker.bound-unadvertised-model');
    adapter.sessionModelOverride = 'model-c';
    const mission = await createRootMission(harness.tasks);
    const source = new FakeCandidateSource([candidate('candidate-bound-unadvertised-model', adapter.id, { models: ['model-a', 'model-b'] })]);
    await assert.rejects(
      () => new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]).assignInitial(requestFor(mission)),
      error => error instanceof WorkerAssignmentBoundSessionInvalidError && /model-c was not advertised/.test(error.message),
    );
    assert.equal(harness.manager.listSessions({ taskId: mission.taskId }).length, 0);
    assert.equal(harness.manager.listRetiredSessions({ taskId: mission.taskId }).length, 1);
    assert.equal(adapter.sendCount, 0);
  }

  // If strict ownership retirement itself is uncertain, assignment must surface that uncertainty,
  // keep the existing Manager/Task ownership visible, and never create a fallback Worker.
  {
    const harness = await createHarness('bound-model-cleanup-uncertain', tasks => ({
      attachWorkerSession: (taskId, input) => tasks.attachWorkerSession(taskId, input),
      detachWorkerSession: (taskId, managedSessionId) => tasks.detachWorkerSession(taskId, managedSessionId),
      retireWorkerSessionStrict: async () => { throw new Error('retirement persistence uncertain'); },
      isWorkerAdapterSessionRetired: (workerId, adapterSessionId) => tasks.isWorkerAdapterSessionRetired(workerId, adapterSessionId),
      assertWorkerSessionContinuationAllowed: (taskId, operation) => tasks.assertWorkerSessionContinuationAllowed(taskId, operation),
      assertWorkerSessionAdmittedTurnContinuationAllowed: (taskId, operation) => tasks.assertWorkerSessionAdmittedTurnContinuationAllowed(taskId, operation),
    }));
    cleanupDirectories.push(harness.storageDirectory);
    const adapterA = await registerAdapter(harness, 'worker.cleanup-uncertain');
    const adapterB = await registerAdapter(harness, 'worker.cleanup-uncertain-fallback');
    adapterA.sessionModelOverride = 'model-b';
    const mission = await createRootMission(harness.tasks);
    const source = new FakeCandidateSource([
      candidate('candidate-a-cleanup-uncertain', adapterA.id, { models: ['model-a', 'model-b'] }),
      candidate('candidate-b-cleanup-uncertain-fallback', adapterB.id, { models: ['model-a', 'model-b'] }),
    ]);
    await assert.rejects(
      () => new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]).assignInitial({
        ...requestFor(mission),
        constraints: { requiredModel: 'model-a' },
      }),
      error => error instanceof WorkerAssignmentBoundSessionInvalidError
        && /lifecycle cleanup is uncertain/.test(error.message)
        && /retirement persistence uncertain/.test(error.message),
    );
    assert.equal(adapterB.createCount, 0, 'cleanup uncertainty must never authorize fallback creation');
    assert.equal(adapterA.disposeCount, 0, 'Manager must not claim provider retirement after strict ownership persistence failed');
    assert.equal(harness.manager.listSessions({ taskId: mission.taskId }).length, 1, 'uncertain cleanup must leave the exact active Manager session visible');
    assert.equal(Object.values(harness.tasks.getTask(mission.taskId).workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt).length, 1, 'uncertain cleanup must leave Task active ownership visible');
    assert.equal(adapterA.sendCount + adapterB.sendCount, 0);
  }

  // Same-Mission initial assignment lane: concurrent calls produce at most one new active binding.
  {
    const harness = await createHarness('concurrent'); cleanupDirectories.push(harness.storageDirectory);
    const adapter = await registerAdapter(harness, 'worker.concurrent');
    const mission = await createRootMission(harness.tasks);
    const source = new FakeCandidateSource([candidate('candidate-concurrent', adapter.id)]);
    const service = new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]);
    const reconstructedService = new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]);
    const gate = { started: deferred(), release: deferred() };
    adapter.createGate = gate;
    const first = service.assignInitial(requestFor(mission));
    await gate.started.promise;
    const second = reconstructedService.assignInitial(requestFor(mission));
    gate.release.resolve();
    const firstResult = await first;
    await assert.rejects(() => second, error => error instanceof WorkerAssignmentConflictError);
    assert.equal(adapter.createCount, 1);
    assert.equal(harness.manager.listSessions({ taskId: mission.taskId }).length, 1);
    assert.equal(Object.values(harness.tasks.getTask(mission.taskId).workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt).length, 1);
    assert.equal(harness.manager.getSession(firstResult.managedSessionId).taskId, mission.taskId);
  }

  // Existing WorkerSession owned by another Mission is never rebound/reused.
  {
    const harness = await createHarness('cross-mission'); cleanupDirectories.push(harness.storageDirectory);
    const adapter = await registerAdapter(harness, 'worker.cross-mission');
    const otherMission = await createRootMission(harness.tasks);
    const targetMission = await createRootMission(harness.tasks);
    const unrelated = await harness.manager.createSession(adapter.id, { model: 'model-a' }, otherMission.taskId);
    const source = new FakeCandidateSource([candidate('candidate-target', adapter.id)]);
    source.refreshOverrides.set('candidate-target', freshCandidate(candidate('candidate-target', adapter.id), { models: ['model-a'] }));
    const result = await new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]).assignInitial({
      ...requestFor(targetMission),
      constraints: { requiredModel: 'model-a' },
    });
    assert.notEqual(result.managedSessionId, unrelated.managedSessionId);
    assert.notEqual(harness.manager.getSession(result.managedSessionId).adapterSessionId, unrelated.adapterSessionId);
    assert.equal(harness.manager.getSession(unrelated.managedSessionId).taskId, otherMission.taskId, 'unrelated session ownership must remain unchanged');
    assert.equal(harness.manager.getSession(result.managedSessionId).taskId, targetMission.taskId);
  }

  // Deterministic finalization race: finalization starts after provider create admission but before bind.
  // Existing Manager -> TaskRuntime owner gate must reject the late binding and dispose the unbound handle.
  {
    const harness = await createHarness('finalization-race'); cleanupDirectories.push(harness.storageDirectory);
    const adapter = await registerAdapter(harness, 'worker.finalization-race');
    const mission = await createRootMission(harness.tasks);
    const source = new FakeCandidateSource([candidate('candidate-finalization-race', adapter.id)]);
    const service = new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]);
    const finalizer = new MissionFinalizationService(harness.tasks, harness.manager);
    const gate = { started: deferred(), release: deferred() };
    adapter.createGate = gate;
    const assigning = service.assignInitial(requestFor(mission));
    const providerSessionId = await gate.started.promise;
    const finalized = await finalizer.finalizeMission(mission.taskId, { requireHandoff: false });
    assert.equal(finalized.mission.missionFinalization.state, 'archived');
    gate.release.resolve();
    await assert.rejects(
      () => assigning,
      error => error instanceof WorkerAssignmentCreateFailedError && /terminal|finaliz/.test(error.message),
    );
    assert.deepEqual(harness.tasks.getTask(mission.taskId).workerSessions, {}, 'late Task Worker binding must not publish after finalization wins');
    assert.equal(harness.manager.listSessions({ taskId: mission.taskId }).length, 0);
    assert.ok(adapter.disposedSessionIds.includes(providerSessionId), 'Manager must dispose provider handle whose bind lost to finalization');
  }

  // Public assignment surface contains no send/planning/completion/feedback/Commit/Phase-8 routing authority.
  {
    const harness = await createHarness('authority'); cleanupDirectories.push(harness.storageDirectory);
    const adapter = await registerAdapter(harness, 'worker.authority');
    const source = new FakeCandidateSource([candidate('candidate-authority', adapter.id)]);
    const service = new MissionWorkerAssignmentService(harness.tasks, harness.manager, [source]);
    for (const forbidden of ['send', 'ensureMission', 'createMission', 'finalizeMission', 'completeMission', 'routeFeedback', 'commitProjectDecision', 'planCapabilities']) {
      assert.equal(typeof service[forbidden], 'undefined', `assignment service must not expose ${forbidden} authority`);
    }
    const productionSource = await fs.readFile(path.join(root, 'src', 'worker-assignment.ts'), 'utf8');
    assert.equal(/\.send\s*\(/.test(productionSource), false, 'assignment production source must not call WorkerSessionManager.send');
    assert.equal(/\.jsonl|assignment-journal|pool-journal|scheduler-journal/i.test(productionSource), false, 'assignment service must not own a journal/queue');
  }

  console.log(JSON.stringify({
    result: 'PASS',
    scopeRejectedBeforeCreation: true,
    finalizedRejected: true,
    hardConstraintsFailClosed: true,
    emptyHardAllowlistsFailClosed: true,
    deterministicTieBreak: 'candidateId',
    freshHealthRequired: true,
    freshDefinitionRequired: true,
    freshDefinitionHardCapabilityEquality: true,
    explicitFalseCapabilityRequirementPreserved: true,
    unspecifiedCapabilityGrowthAllowed: true,
    authoritativeBoundModelRequired: true,
    boundModelMismatchCleanup: 'retired-no-fallback-no-send',
    degradedAutoFallback: false,
    explicitPreCreateFallback: true,
    arbitraryCreateFallback: false,
    concurrentInitialBindings: 'at-most-one',
    crossMissionReuse: false,
    finalizationRaceLateBinding: false,
    sendsPerformedByAssignment: 0,
    assignmentJournal: false,
    taskMissionMetadataChanged: false,
  }, null, 2));
} finally {
  await Promise.allSettled(cleanupDirectories.map(directory => fs.rm(directory, { recursive: true, force: true })));
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
