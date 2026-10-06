import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-mission-finalization-task-'));
const projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-mission-finalization-project-'));
const blockedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-mission-finalization-blocked-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-mission-finalization-bundle-'));
const bundlePath = path.join(bundleDirectory, 'mission-finalization-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { ProjectStore } from './src/project-store.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
      export { WorkerSessionManager } from './src/worker-session-manager.ts';
      export { MissionFinalizationService, getMissionFinalHandoffText } from './src/mission-finalization-service.ts';
      export { HostCapabilityExecutionCoordinator } from './src/host-capability-execution-coordinator.ts';
      export { TaskHostCapabilityExecutionStore } from './src/task-host-capability-execution-store.ts';
    `,
    resolveDir: root,
    sourcefile: 'mission-finalization-smoke-entry.ts',
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
  ProjectStore,
  TaskRuntime,
  WorkerSessionManager,
  MissionFinalizationService,
  getMissionFinalHandoffText,
  HostCapabilityExecutionCoordinator,
  TaskHostCapabilityExecutionStore,
} = require(bundlePath);

class FakeAdapter {
  constructor(id = 'worker.fake') {
    this.id = id;
  }

  nextSession = 0;
  forcedSessionId = undefined;
  disposed = [];
  inputs = [];
  failDispose = new Set();
  providerTranscripts = new Map();
  createGates = new Map();
  sendStarts = [];
  sendGates = new Map();
  disposeGates = new Map();
  submittedResults = [];
  hostResultResolvers = new Map();

  async describe() {
    return {
      id: this.id,
      provider: 'fake',
      kind: 'api',
      label: 'Fake Worker',
      availability: 'available',
      capabilities: {
        streaming: true,
        reasoning: true,
        capabilityRequests: true,
        imageInput: false,
        checkpoints: false,
        interruption: true,
        persistentContext: true,
      },
    };
  }

  async createSession(options) {
    const sessionId = this.forcedSessionId ?? `provider-${++this.nextSession}`;
    const gate = this.createGates.get(sessionId);
    if (gate) {
      gate.started.resolve();
      await gate.release.promise;
      this.createGates.delete(sessionId);
    }
    const now = new Date().toISOString();
    return {
      sessionId,
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
    this.sendStarts.push({ sessionId: session.sessionId, inputId: input.inputId });
    const gate = this.sendGates.get(input.inputId);
    gate?.started.resolve();
    try {
      if (gate) await gate.release.promise;
      if (input.prompt === 'host-request') {
        const callId = `call-${input.inputId}`;
        let resolveHostResult;
        const hostResult = new Promise(resolve => { resolveHostResult = resolve; });
        this.hostResultResolvers.set(`${input.inputId}\u0000${callId}`, resolveHostResult);
        yield {
          type: 'capability_call',
          inputId: input.inputId,
          callId,
          name: 'read_files',
          arguments: { files: [{ path: 'README.md' }] },
          dispatch: 'host-requested',
        };
        await hostResult;
        yield { type: 'capability_result', inputId: input.inputId, callId, name: 'read_files', text: 'HOST_RESULT_OK', isError: false };
        yield { type: 'terminal', inputId: input.inputId, status: 'completed' };
        return;
      }
      this.inputs.push({ sessionId: session.sessionId, input: structuredClone(input) });
      yield { type: 'text_delta', inputId: input.inputId, text: 'continued-from-bounded-state' };
      yield { type: 'terminal', inputId: input.inputId, status: 'completed' };
    } finally {
      session.state = 'idle';
      session.lastActiveAt = new Date().toISOString();
    }
  }

  async submitCapabilityResult(session, result) {
    this.submittedResults.push({ sessionId: session.sessionId, result: structuredClone(result) });
    const key = `${result.inputId}\u0000${result.callId}`;
    const resolve = this.hostResultResolvers.get(key);
    if (resolve) {
      this.hostResultResolvers.delete(key);
      resolve();
    }
  }

  async interrupt(session) {
    session.state = 'interrupted';
  }

  async dispose(session) {
    const gate = this.disposeGates.get(session.sessionId);
    if (gate) {
      gate.started.resolve();
      await gate.release.promise;
      this.disposeGates.delete(session.sessionId);
    }
    if (this.failDispose.has(session.sessionId)) throw new Error(`provider refused dispose ${session.sessionId}`);
    this.disposed.push(session.sessionId);
    session.state = 'disposed';
  }

  async health() {
    return { status: 'healthy', checkedAt: new Date().toISOString() };
  }
}

let tick = 0;
const clock = () => new Date(Date.UTC(2026, 8, 13, 14, 0, tick++));
let managedId = 0;

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

try {
  const tasks = new TaskRuntime({ storageDirectory: taskDirectory, now: clock });
  const projects = new ProjectStore({ storageDirectory: projectDirectory, now: clock });
  await Promise.all([tasks.initialize(), projects.initialize()]);
  const project = await projects.createProject({ title: 'Disposable AI lifecycle', goal: 'Project state outlives Mission workers' });

  for (const status of ['succeeded', 'failed', 'unknown']) {
    const unresolved = await tasks.ensureTask({ kind: 'mission', key: `unresolved-${status}` }, 'Unsettled results cannot authorize lifecycle death');
    await tasks.configureMission(unresolved.taskId, { projectId: project.projectId, rootMissionId: unresolved.taskId, plane: 'practice', missionType: 'unsettled-test', completionCriteria: ['Resolve effects and result ownership'] });
    await tasks.attachWorkerSession(unresolved.taskId, { managedSessionId: `origin-${status}`, workerId: 'test-worker', adapterSessionId: `provider-${status}` });
    await tasks.beginExecution(unresolved.taskId, { executionId: 'effect', toolName: 'read_files', origin: { kind: 'worker', managedSessionId: `origin-${status}`, workerId: 'test-worker', inputId: 'consumed-test', callId: 'once' } });
    await tasks.finishExecutionStrict(unresolved.taskId, 'effect', status, {});
    if (status !== 'unknown') await tasks.markResultPreparedStrict(unresolved.taskId, 'effect', { kind: 'worker-capability', inputId: 'consumed-test', callId: 'once', name: 'read_files', text: status, isError: status === 'failed' });
    await tasks.retireWorkerSessionStrict(unresolved.taskId, `origin-${status}`, { reason: 'Test origin settled' });
    await assert.rejects(() => tasks.finalizeMissionStrict(unresolved.taskId, { handoffRequired: false }), /unresolved execution\/result delivery/);
    assert.equal(tasks.getTask(unresolved.taskId).missionFinalization, undefined);
    if (status === 'unknown') {
      await assert.rejects(() => tasks.abandonPendingDeliveryStrict(unresolved.taskId, 'effect', 'Not allowed'), /not pending|not terminal/);
      continue;
    }
    if (status === 'succeeded') await tasks.markDeliveredStrict(unresolved.taskId, 'effect');
    else await tasks.abandonPendingDeliveryStrict(unresolved.taskId, 'effect', 'Explicit future delivery stop in test');
    await tasks.finalizeMissionStrict(unresolved.taskId, { handoffRequired: false });
    assert.equal((await tasks.archiveMissionStrict(unresolved.taskId)).missionFinalization.state, 'archived');
  }

  const adapter = new FakeAdapter();
  // Reconstruct an unsafe legacy completion only in the disposable journal.
  // Archive and idempotent finalization must not validate that historical state.
  const legacyUnsafe = await tasks.ensureTask({ kind: 'mission', key: 'legacy-pending-completion' }, 'Legacy pending result is not safe archive authority');
  await tasks.configureMission(legacyUnsafe.taskId, { projectId: project.projectId, rootMissionId: legacyUnsafe.taskId, plane: 'practice', missionType: 'legacy-test', completionCriteria: ['Resolve pending results'] });
  await tasks.beginExecution(legacyUnsafe.taskId, { executionId: 'pending-legacy', toolName: 'read_files' });
  await tasks.finishExecutionStrict(legacyUnsafe.taskId, 'pending-legacy', 'succeeded', {});
  await tasks.markResultPreparedStrict(legacyUnsafe.taskId, 'pending-legacy');
  await tasks.flush();
  await fs.appendFile(path.join(taskDirectory, `${legacyUnsafe.taskId}.jsonl`), JSON.stringify({ version: 1, eventId: 'legacy-unsafe-completion', taskId: legacyUnsafe.taskId,
    at: clock().toISOString(), type: 'TaskMissionFinalized', payload: { completedAt: clock().toISOString(), handoffRequired: false } }) + '\n');
  await tasks.rereadTask(legacyUnsafe.taskId);
  await assert.rejects(() => tasks.archiveMissionStrict(legacyUnsafe.taskId), /unresolved execution\/result delivery/);
  await assert.rejects(() => tasks.finalizeMissionStrict(legacyUnsafe.taskId, { handoffRequired: false }), /unresolved execution\/result delivery/);
  assert.equal(tasks.getTask(legacyUnsafe.taskId).missionFinalization.state, 'completed');

  const manager = new WorkerSessionManager({
    taskBindings: tasks,
    newId: () => `managed-${++managedId}`,
    now: clock,
  });
  await manager.register(adapter);
  const finalizer = new MissionFinalizationService(tasks, manager, { now: clock, defaultMaxHandoffChars: 4_000 });

  const missionA = await tasks.ensureTask({ kind: 'bridge', key: 'mission-a' }, 'Coordinate Phase 2 lifecycle');
  await tasks.configureMission(missionA.taskId, {
    projectId: project.projectId,
    rootMissionId: missionA.taskId,
    plane: 'coordination',
    missionType: 'root-coordination',
    completionCriteria: ['Final Handoff is durable', 'Owned workers are retired'],
  });
  await tasks.updateContext(missionA.taskId, {
    summary: 'Mission A established the durable lifecycle boundary.',
    constraints: ['Do not inherit provider transcripts.'],
    decisions: ['Project persists; Mission workers are disposable.'],
    relevantFiles: ['src/mission-finalization-service.ts'],
  });
  await tasks.setTodos(missionA.taskId, [{ id: 'finalize', title: 'Finalize Mission A', status: 'completed' }]);

  const workerA = await manager.createSession('worker.fake', { model: 'fake-model' }, missionA.taskId);
  adapter.providerTranscripts.set(workerA.adapterSessionId, 'TRANSCRIPT-SECRET-DO-NOT-INHERIT');
  await tasks.attachWorkerSession(missionA.taskId, {
    managedSessionId: 'orphaned-worker-a',
    workerId: 'worker.fake',
    adapterSessionId: 'provider-lost-before-restart',
    model: 'fake-model',
  });

  await assert.rejects(() => tasks.archiveMissionStrict(missionA.taskId), /must be finalized before archive/);
  await assert.rejects(
    () => tasks.finalizeMissionStrict(missionA.taskId, { handoffRequired: true }),
    /requires a final Handoff/,
  );
  assert.equal(tasks.getTask(missionA.taskId).missionFinalization, undefined, 'rejected finalization must not mutate Mission state');

  const finalizedA = await finalizer.finalizeMission(missionA.taskId);
  assert.equal(finalizedA.mission.status, 'completed');
  assert.equal(finalizedA.mission.missionFinalization.state, 'archived');
  assert.equal(finalizedA.mission.missionFinalization.handoffRequired, true);
  assert.ok(finalizedA.mission.missionFinalization.archivedAt);
  assert.equal(finalizedA.retiredWorkers.length, 1, 'live manager-owned Worker A must retire');
  assert.deepEqual(finalizedA.logicallyRetiredOrphans, ['orphaned-worker-a'], 'lost provider sessions must still receive durable logical retirement');
  assert.deepEqual(finalizedA.cleanupWarnings, []);
  assert.equal(manager.getSession(workerA.managedSessionId), undefined);
  assert.equal(manager.getRetiredSession(workerA.managedSessionId).retirementReason, 'mission-finalized');
  assert.ok(adapter.disposed.includes(workerA.adapterSessionId));
  assert.equal(tasks.getTask(missionA.taskId).workerSessions[workerA.managedSessionId].retirementReason, 'mission-finalized');
  assert.equal(tasks.getTask(missionA.taskId).workerSessions['orphaned-worker-a'].retirementReason, 'mission-finalized-orphaned');

  const handoffTextA = getMissionFinalHandoffText(finalizedA.mission);
  assert.ok(handoffTextA?.includes(`Project: ${project.projectId}`));
  assert.ok(handoffTextA?.includes(`Mission: ${missionA.taskId} · coordination · root-coordination`));
  assert.ok(handoffTextA?.includes('Mission A established the durable lifecycle boundary.'));
  assert.ok(handoffTextA?.includes('Project persists; Mission workers are disposable.'));
  assert.doesNotMatch(handoffTextA ?? '', /TRANSCRIPT-SECRET-DO-NOT-INHERIT/);
  assert.equal(finalizedA.handoff.metadata.missionFinalHandoff, true);
  assert.equal(finalizedA.handoff.kind, 'report');
  const missingSourceIdSnapshot = structuredClone(finalizedA.mission);
  delete missingSourceIdSnapshot.missionFinalization.handoffSourceEventId;
  assert.equal(getMissionFinalHandoffText(missingSourceIdSnapshot), undefined, 'final Handoff accessor must fail closed when source event id binding is missing');
  const missingSourceCountSnapshot = structuredClone(finalizedA.mission);
  delete missingSourceCountSnapshot.missionFinalization.handoffSourceEventCount;
  assert.equal(getMissionFinalHandoffText(missingSourceCountSnapshot), undefined, 'final Handoff accessor must fail closed when source event count binding is missing');
  const missingDigestSnapshot = structuredClone(finalizedA.mission);
  delete missingDigestSnapshot.missionFinalization.handoffContentDigest;
  assert.equal(getMissionFinalHandoffText(missingDigestSnapshot), undefined, 'final Handoff accessor must fail closed when content digest binding is missing');

  await assert.rejects(() => tasks.updateContext(missionA.taskId, { summary: 'must not mutate after archive' }), /finalized|archived|terminal/);
  await assert.rejects(() => tasks.setTodos(missionA.taskId, [{ id: 'late', title: 'late', status: 'pending' }]), /finalized|archived|terminal/);
  await assert.rejects(() => tasks.reportProgress(missionA.taskId, { message: 'late progress' }), /finalized|archived|terminal/);
  await assert.rejects(() => tasks.startInteraction(missionA.taskId, { interactionId: 'late-interaction', surface: 'bridge' }), /finalized|archived|terminal/);
  await assert.rejects(() => tasks.finishInteraction(missionA.taskId, 'late-interaction', 'completed'), /finalized|archived|terminal/);
  await assert.rejects(() => tasks.attachWorkerSession(missionA.taskId, {
    managedSessionId: 'late-worker', workerId: 'worker.fake', adapterSessionId: 'late-provider',
  }), /finalized|archived|terminal/);
  await assert.rejects(() => tasks.beginExecution(missionA.taskId, {
    executionId: 'late-execution', toolName: 'read_files',
  }), /finalized|archived|terminal/);
  await assert.rejects(() => tasks.finishExecution(missionA.taskId, 'late-execution', 'succeeded'), /finalized|archived|terminal/);
  await assert.rejects(() => tasks.markResultPrepared(missionA.taskId, 'late-execution'), /finalized|archived|terminal/);
  await assert.rejects(() => tasks.markDelivered(missionA.taskId, 'late-execution'), /finalized|archived|terminal/);
  await assert.rejects(() => tasks.grantCapabilityStrict(missionA.taskId, {
    capabilityId: 'workspace.read-files', capabilityVersion: 1, scope: 'task',
  }), /finalized|archived|terminal/);
  await assert.rejects(() => tasks.recordArtifact(missionA.taskId, {
    artifactId: 'late-artifact', kind: 'report', title: 'late artifact',
  }), /finalized|archived|terminal/);
  assert.equal(getMissionFinalHandoffText(tasks.getTask(missionA.taskId)), handoffTextA, 'rejected post-terminal mutation must leave the frozen final Handoff unchanged');

  const missionAEventCount = finalizedA.mission.eventCount;
  const finalizedAgain = await finalizer.finalizeMission(missionA.taskId);
  assert.equal(finalizedAgain.mission.eventCount, missionAEventCount, 'Mission finalization/archive must be idempotent after retirement');

  const policyMission = await tasks.ensureTask({ kind: 'bridge', key: 'policy-mismatch' }, 'Do not weaken Handoff policy on retry');
  await tasks.configureMission(policyMission.taskId, {
    projectId: project.projectId,
    rootMissionId: policyMission.taskId,
    plane: 'cognition',
    missionType: 'policy-mismatch-test',
    completionCriteria: ['Finalization retry preserves the original Handoff policy'],
  });
  await tasks.finalizeMissionStrict(policyMission.taskId, { handoffRequired: false });
  await assert.rejects(
    () => tasks.finalizeMissionStrict(policyMission.taskId, { handoffRequired: true }),
    /already finalized with a different Handoff policy/,
    'strict finalization idempotency must not silently accept a conflicting Handoff policy',
  );
  await assert.rejects(
    () => finalizer.finalizeMission(policyMission.taskId),
    /already finalized with a different Handoff policy/,
    'default required-Handoff finalization must not archive a Mission previously finalized with Handoff disabled',
  );
  assert.equal(tasks.getTask(policyMission.taskId).missionFinalization.state, 'completed', 'conflicting policy retry must not archive the Mission');
  const policyFinalized = await finalizer.finalizeMission(policyMission.taskId, { requireHandoff: false });
  assert.equal(policyFinalized.mission.missionFinalization.state, 'archived');

  const missionB = await tasks.ensureTask({ kind: 'bridge', key: 'mission-b' }, 'Continue from Project + Mission A Handoff');
  await tasks.configureMission(missionB.taskId, {
    projectId: project.projectId,
    rootMissionId: missionB.taskId,
    plane: 'practice',
    missionType: 'implementation',
    completionCriteria: ['Continue without Mission A provider transcript'],
  });
  await assert.rejects(() => manager.bindTask(workerA.managedSessionId, missionB.taskId), /retired/);
  adapter.forcedSessionId = workerA.adapterSessionId;
  await assert.rejects(
    () => manager.createSession('worker.fake', { model: 'fake-model' }, missionB.taskId),
    /Adapter session is retired and cannot be reused/,
    'the same provider-native conversation must not be wrapped in a fresh managed id after Mission A retires',
  );
  adapter.forcedSessionId = undefined;

  const workerB = await manager.createSession('worker.fake', { model: 'fake-model' }, missionB.taskId);
  await assert.rejects(
    () => manager.bindTask(workerB.managedSessionId, missionA.taskId),
    /finalized|archived|terminal/,
    'a live replacement Worker from Mission B cannot be rebound into terminal Mission A',
  );
  assert.equal(manager.getSession(workerB.managedSessionId).taskId, missionB.taskId, 'failed rebind to a terminal Mission must restore the prior Mission B ownership');
  const continuationPrompt = [
    `Project goal: ${project.goal}`,
    'Previous Mission final Handoff:',
    handoffTextA,
  ].join('\n\n');
  const bEvents = [];
  for await (const event of manager.send(workerB.managedSessionId, { inputId: 'mission-b-turn-1', prompt: continuationPrompt })) bEvents.push(event);
  assert.equal(bEvents.at(-1).status, 'completed');
  const bInput = adapter.inputs.find(row => row.sessionId === workerB.adapterSessionId)?.input;
  assert.ok(bInput);
  assert.equal(bInput.history, undefined, 'Mission B continuation must not require Mission A transcript/history');
  assert.match(bInput.prompt, /Mission A established the durable lifecycle boundary/);
  assert.doesNotMatch(bInput.prompt, /TRANSCRIPT-SECRET-DO-NOT-INHERIT/);

  const recoveryMission = await tasks.ensureTask({ kind: 'bridge', key: 'worker-recovery' }, 'Survive a Worker crash');
  await tasks.configureMission(recoveryMission.taskId, {
    projectId: project.projectId,
    rootMissionId: recoveryMission.taskId,
    plane: 'practice',
    missionType: 'recovery-test',
    completionCriteria: ['Replacement Worker continues the same Mission'],
  });
  const crashedWorker = await manager.createSession('worker.fake', {}, recoveryMission.taskId);
  await manager.dispose(crashedWorker.managedSessionId);
  const crashedRef = tasks.getTask(recoveryMission.taskId).workerSessions[crashedWorker.managedSessionId];
  assert.ok(crashedRef.detachedAt);
  assert.equal(crashedRef.retiredAt, undefined, 'ordinary Worker failure/disposal is not Mission retirement');
  assert.equal(tasks.getTask(recoveryMission.taskId).missionFinalization, undefined, 'Worker death must not finalize the Mission');
  const replacement = await manager.createSession('worker.fake', {}, recoveryMission.taskId);
  const recoveryEvents = [];
  for await (const event of manager.send(replacement.managedSessionId, { inputId: 'recovery-turn', prompt: 'continue the same Mission' })) recoveryEvents.push(event);
  assert.equal(recoveryEvents.at(-1).status, 'completed');
  await finalizer.finalizeMission(recoveryMission.taskId);
  assert.equal(manager.getRetiredSession(replacement.managedSessionId).retirementReason, 'mission-finalized');
  const finalizedRecovery = tasks.getTask(recoveryMission.taskId);
  assert.equal(finalizedRecovery.workerSessions[crashedWorker.managedSessionId].retirementReason, 'mission-finalized-history', 'a previously detached/crashed Worker must become permanently retired when its Mission dies');
  adapter.forcedSessionId = crashedWorker.adapterSessionId;
  await assert.rejects(
    () => manager.createSession('worker.fake', {}, missionB.taskId),
    /Adapter session is retired and cannot be reused/,
    'a crashed Worker conversation may be reused inside its live Mission but must not revive after that Mission finalizes',
  );
  adapter.forcedSessionId = undefined;

  const cleanupMission = await tasks.ensureTask({ kind: 'bridge', key: 'dispose-warning' }, 'Retire even if provider cleanup fails');
  await tasks.configureMission(cleanupMission.taskId, {
    projectId: project.projectId,
    rootMissionId: cleanupMission.taskId,
    plane: 'cognition',
    missionType: 'cleanup-warning-test',
    completionCriteria: ['Logical retirement survives provider cleanup failure'],
  });
  const cleanupWorker = await manager.createSession('worker.fake', {}, cleanupMission.taskId);
  adapter.failDispose.add(cleanupWorker.adapterSessionId);
  const cleanupResult = await finalizer.finalizeMission(cleanupMission.taskId);
  assert.equal(cleanupResult.mission.missionFinalization.state, 'archived');
  assert.equal(cleanupResult.cleanupWarnings.length, 1);
  assert.match(cleanupResult.cleanupWarnings[0], /provider refused dispose/);
  assert.ok(manager.getRetiredSession(cleanupWorker.managedSessionId).disposeError);
  assert.throws(() => manager.send(cleanupWorker.managedSessionId, { inputId: 'must-not-run', prompt: 'reuse' }), /retired/);
  adapter.failDispose.delete(cleanupWorker.adapterSessionId);
  const cleanupRetried = await manager.retire(cleanupWorker.managedSessionId);
  assert.equal(cleanupRetried.disposeError, undefined, 'retired cleanup may be retried without reviving the WorkerSession');

  const escapedMission = await tasks.ensureTask({ kind: 'bridge', key: 'escaped-live-worker' }, 'Retire Mission-owned Workers even after unbind');
  await tasks.configureMission(escapedMission.taskId, {
    projectId: project.projectId,
    rootMissionId: escapedMission.taskId,
    plane: 'practice',
    missionType: 'escaped-worker-test',
    completionCriteria: ['A previously bound live Worker cannot survive Mission death by unbinding first'],
  });
  const escapedWorker = await manager.createSession('worker.fake', {}, escapedMission.taskId);
  await manager.unbindTask(escapedWorker.managedSessionId);
  assert.equal(manager.getSession(escapedWorker.managedSessionId).taskId, undefined, 'adversarial Worker is intentionally live but currently unbound');
  assert.ok(tasks.getTask(escapedMission.taskId).workerSessions[escapedWorker.managedSessionId].detachedAt);
  const escapedResult = await finalizer.finalizeMission(escapedMission.taskId);
  assert.equal(escapedResult.mission.missionFinalization.state, 'archived');
  assert.equal(escapedResult.retiredWorkers.length, 1, 'finalizer must retire live Manager sessions by durable Mission ownership, not only current taskId');
  assert.equal(manager.getSession(escapedWorker.managedSessionId), undefined);
  assert.equal(manager.getRetiredSession(escapedWorker.managedSessionId).retirementReason, 'mission-finalized');
  assert.equal(tasks.getTask(escapedMission.taskId).workerSessions[escapedWorker.managedSessionId].retirementReason, 'mission-finalized-history');
  assert.throws(
    () => manager.send(escapedWorker.managedSessionId, { inputId: 'escaped-must-not-run', prompt: 'continue after Mission death' }),
    /retired/,
  );

  const freshOwnerMission = await tasks.ensureTask({ kind: 'bridge', key: 'fresh-wrapper-owner' }, 'Retire provider-native identity across fresh wrappers');
  await tasks.configureMission(freshOwnerMission.taskId, {
    projectId: project.projectId,
    rootMissionId: freshOwnerMission.taskId,
    plane: 'practice',
    missionType: 'fresh-wrapper-owner-test',
    completionCriteria: ['Mission death retires every live wrapper around its provider-native conversations'],
  });
  const freshTargetMission = await tasks.ensureTask({ kind: 'bridge', key: 'fresh-wrapper-target' }, 'Remain alive after a foreign provider identity is retired');
  await tasks.configureMission(freshTargetMission.taskId, {
    projectId: project.projectId,
    rootMissionId: freshTargetMission.taskId,
    plane: 'practice',
    missionType: 'fresh-wrapper-target-test',
    completionCriteria: ['A replacement Worker can continue this Mission'],
  });
  adapter.forcedSessionId = 'provider-pre-finalization-fresh-wrapper';
  const freshOriginal = await manager.createSession('worker.fake', {}, freshOwnerMission.taskId);
  await manager.dispose(freshOriginal.managedSessionId);
  const freshOriginalRef = tasks.getTask(freshOwnerMission.taskId).workerSessions[freshOriginal.managedSessionId];
  assert.ok(freshOriginalRef.detachedAt, 'ordinary disposal must only detach before Mission death');
  assert.equal(freshOriginalRef.retiredAt, undefined);
  const freshWrapper = await manager.createSession('worker.fake', {}, freshTargetMission.taskId);
  assert.notEqual(freshWrapper.managedSessionId, freshOriginal.managedSessionId, 'same provider conversation is intentionally wrapped under a fresh managed id');
  assert.equal(freshWrapper.adapterSessionId, freshOriginal.adapterSessionId);
  adapter.sendStarts.length = 0;
  const staleFreshSend = manager.send(freshWrapper.managedSessionId, {
    inputId: 'fresh-wrapper-stale-lazy-send',
    prompt: 'must never start after Mission A dies',
  })[Symbol.asyncIterator]();
  assert.equal(adapter.sendStarts.length, 0, 'issuing a lazy send capability must not start provider work before first consumption');
  adapter.failDispose.add(freshWrapper.adapterSessionId);
  const freshResult = await finalizer.finalizeMission(freshOwnerMission.taskId);
  assert.equal(freshResult.mission.missionFinalization.state, 'archived');
  assert.ok(freshResult.retiredWorkers.some(worker => worker.managedSessionId === freshWrapper.managedSessionId), 'Mission A must retire the live fresh wrapper by provider-native identity');
  assert.ok(freshResult.cleanupWarnings.some(warning => warning.includes(freshWrapper.managedSessionId)), 'fresh-wrapper provider cleanup failure must be reported without blocking logical retirement');
  assert.equal(manager.getSession(freshWrapper.managedSessionId), undefined);
  assert.equal(manager.getRetiredSession(freshWrapper.managedSessionId).retirementReason, 'mission-finalized');
  assert.match(manager.getRetiredSession(freshWrapper.managedSessionId).disposeError, /dispose/);
  assert.throws(
    () => manager.send(freshWrapper.managedSessionId, { inputId: 'fresh-wrapper-must-not-run', prompt: 'continue escaped conversation' }),
    /retired/,
  );
  await assert.rejects(
    () => staleFreshSend.next(),
    /retired|Unknown managed worker session/,
    'a send iterable issued before retirement must be revoked if first consumed after retirement',
  );
  assert.equal(adapter.sendStarts.length, 0, 'revoked stale iterable must not start provider send body after Mission death');
  adapter.failDispose.delete(freshWrapper.adapterSessionId);
  const freshCleanupRetried = await manager.retire(freshWrapper.managedSessionId);
  assert.equal(freshCleanupRetried.disposeError, undefined, 'fresh-wrapper provider cleanup may retry without resurrecting routing');
  assert.equal(manager.getSession(freshWrapper.managedSessionId), undefined);
  assert.ok(tasks.getTask(freshOwnerMission.taskId).workerSessions[freshOriginal.managedSessionId].retiredAt);
  assert.equal(tasks.getTask(freshOwnerMission.taskId).workerSessions[freshOriginal.managedSessionId].retirementReason, 'mission-finalized-history');
  assert.ok(tasks.getTask(freshTargetMission.taskId).workerSessions[freshWrapper.managedSessionId].retiredAt, 'cross-Mission fresh wrapper retirement must be durable on its current Mission');
  assert.equal(tasks.getTask(freshTargetMission.taskId).missionFinalization, undefined, 'retiring a Worker borrowed by Mission B must not finalize Mission B');
  assert.equal(await tasks.isWorkerAdapterSessionRetired('worker.fake', freshOriginal.adapterSessionId), true);
  adapter.forcedSessionId = undefined;
  const freshReplacement = await manager.createSession('worker.fake', {}, freshTargetMission.taskId);
  const freshReplacementEvents = [];
  for await (const event of manager.send(freshReplacement.managedSessionId, { inputId: 'fresh-target-replacement', prompt: 'continue Mission B with a genuinely fresh provider session' })) freshReplacementEvents.push(event);
  assert.equal(freshReplacementEvents.at(-1).status, 'completed');
  assert.equal(tasks.getTask(freshTargetMission.taskId).missionFinalization, undefined);
  await manager.dispose(freshReplacement.managedSessionId);

  const strictOwnerMission = await tasks.ensureTask({ kind: 'bridge', key: 'fresh-wrapper-strict-owner' }, 'Fail closed if cross-Mission retirement cannot persist');
  await tasks.configureMission(strictOwnerMission.taskId, {
    projectId: project.projectId,
    rootMissionId: strictOwnerMission.taskId,
    plane: 'practice',
    missionType: 'fresh-wrapper-strict-owner-test',
    completionCriteria: ['Archive waits for strict retirement of the live fresh wrapper'],
  });
  const strictTargetMission = await tasks.ensureTask({ kind: 'bridge', key: 'fresh-wrapper-strict-target' }, 'Keep routing coherent on strict retirement failure');
  await tasks.configureMission(strictTargetMission.taskId, {
    projectId: project.projectId,
    rootMissionId: strictTargetMission.taskId,
    plane: 'practice',
    missionType: 'fresh-wrapper-strict-target-test',
    completionCriteria: ['Retirement failure does not silently remove the live Worker'],
  });
  adapter.forcedSessionId = 'provider-strict-cross-mission';
  const strictOriginal = await manager.createSession('worker.fake', {}, strictOwnerMission.taskId);
  await manager.dispose(strictOriginal.managedSessionId);
  const strictFresh = await manager.createSession('worker.fake', {}, strictTargetMission.taskId);
  const strictTargetJournal = path.join(taskDirectory, `${strictTargetMission.taskId}.jsonl`);
  const strictTargetJournalText = await fs.readFile(strictTargetJournal, 'utf8');
  await fs.rm(strictTargetJournal, { force: true });
  await fs.mkdir(strictTargetJournal);
  let strictFailureResult;
  try {
    strictFailureResult = await finalizer.finalizeMission(strictOwnerMission.taskId);
  } finally {
    await fs.rm(strictTargetJournal, { recursive: true, force: true });
    await fs.writeFile(strictTargetJournal, strictTargetJournalText, 'utf8');
  }
  assert.equal(strictFailureResult.mission.missionFinalization.state, 'archived', 'Mission A durable native death authority must not depend on persisting a foreign Mission B retirement ref');
  assert.ok(tasks.getTask(strictOwnerMission.taskId).workerSessions[strictOriginal.managedSessionId].retiredAt, 'Mission A history must durably establish provider-native death');
  assert.equal(tasks.getTask(strictTargetMission.taskId).workerSessions[strictFresh.managedSessionId].retiredAt, undefined);
  assert.equal(tasks.getTask(strictTargetMission.taskId).missionFinalization, undefined, 'foreign identity death must not finalize Mission B');
  assert.equal(manager.getSession(strictFresh.managedSessionId), undefined, 'old provider-native identity must leave routing even when Mission B retirement bookkeeping fails');
  assert.throws(() => manager.send(strictFresh.managedSessionId, { inputId: 'strict-failure-dead', prompt: 'must stay dead' }), /retired|Unknown managed worker session/);
  adapter.forcedSessionId = undefined;
  const strictReplacement = await manager.createSession('worker.fake', {}, strictTargetMission.taskId);
  const strictReplacementEvents = [];
  for await (const event of manager.send(strictReplacement.managedSessionId, { inputId: 'strict-failure-replacement', prompt: 'Mission B continues with a new identity' })) strictReplacementEvents.push(event);
  assert.equal(strictReplacementEvents.at(-1).status, 'completed');
  await manager.dispose(strictReplacement.managedSessionId);

  const boundaryOwner = await tasks.ensureTask({ kind: 'bridge', key: 'finalizer-boundary-owner' }, 'Linearize finalizer against first send');
  await tasks.configureMission(boundaryOwner.taskId, {
    projectId: project.projectId,
    rootMissionId: boundaryOwner.taskId,
    plane: 'practice',
    missionType: 'finalizer-boundary-owner',
    completionCriteria: ['No first send crosses durable Mission death'],
  });
  const boundaryTarget = await tasks.ensureTask({ kind: 'bridge', key: 'finalizer-boundary-target' }, 'Hold fresh wrapper for boundary race');
  await tasks.configureMission(boundaryTarget.taskId, {
    projectId: project.projectId,
    rootMissionId: boundaryTarget.taskId,
    plane: 'practice',
    missionType: 'finalizer-boundary-target',
    completionCriteria: ['Replacement may continue after old identity dies'],
  });
  adapter.forcedSessionId = 'provider-finalizer-boundary';
  const boundaryOriginal = await manager.createSession('worker.fake', {}, boundaryOwner.taskId);
  await manager.dispose(boundaryOriginal.managedSessionId);
  const boundaryFresh = await manager.createSession('worker.fake', {}, boundaryTarget.taskId);
  adapter.sendStarts.length = 0;
  const boundaryIterator = manager.send(boundaryFresh.managedSessionId, {
    inputId: 'boundary-first-send', prompt: 'must not cross finalization',
  })[Symbol.asyncIterator]();
  const retirementObserved = deferred();
  const retirementRelease = deferred();
  const originalRetireWorkerSessionStrict = tasks.retireWorkerSessionStrict.bind(tasks);
  tasks.retireWorkerSessionStrict = async (...args) => {
    const retired = await originalRetireWorkerSessionStrict(...args);
    if (args[0] === boundaryOwner.taskId && args[1] === boundaryOriginal.managedSessionId) {
      retirementObserved.resolve();
      await retirementRelease.promise;
    }
    return retired;
  };
  const boundaryFinalization = finalizer.finalizeMission(boundaryOwner.taskId);
  await retirementObserved.promise;
  assert.equal(await tasks.isWorkerAdapterSessionRetired('worker.fake', boundaryOriginal.adapterSessionId), true, 'durable native death must be established at the paused boundary');
  const boundaryNextPromise = boundaryIterator.next();
  await new Promise(resolve => setImmediate(resolve));
  const boundaryStartsBeforeRelease = adapter.sendStarts.length;
  retirementRelease.resolve();
  const boundaryResult = await boundaryFinalization;
  await assert.rejects(() => boundaryNextPromise, /retired|Unknown managed worker session/);
  assert.equal(boundaryStartsBeforeRelease, 0, 'first provider send must not start after durable death while finalizer still owns the native boundary');
  tasks.retireWorkerSessionStrict = originalRetireWorkerSessionStrict;
  assert.equal(boundaryResult.mission.missionFinalization.state, 'archived');
  assert.equal(manager.getSession(boundaryFresh.managedSessionId), undefined);
  adapter.forcedSessionId = undefined;

  const sendRetirementRaceOwner = await tasks.ensureTask({ kind: 'bridge', key: 'send-retirement-race-owner' }, 'Retirement wins against a deferred send start');
  await tasks.configureMission(sendRetirementRaceOwner.taskId, {
    projectId: project.projectId,
    rootMissionId: sendRetirementRaceOwner.taskId,
    plane: 'practice',
    missionType: 'send-retirement-race-owner',
    completionCriteria: ['Retirement revokes a queued first consumption before provider work starts'],
  });
  const sendRetirementRaceTarget = await tasks.ensureTask({ kind: 'bridge', key: 'send-retirement-race-target' }, 'Stay alive while the foreign provider identity is retired');
  await tasks.configureMission(sendRetirementRaceTarget.taskId, {
    projectId: project.projectId,
    rootMissionId: sendRetirementRaceTarget.taskId,
    plane: 'practice',
    missionType: 'send-retirement-race-target',
    completionCriteria: ['Only the retired Worker dies'],
  });
  adapter.forcedSessionId = 'provider-send-retirement-race';
  const sendRetirementRaceOriginal = await manager.createSession('worker.fake', {}, sendRetirementRaceOwner.taskId);
  await manager.dispose(sendRetirementRaceOriginal.managedSessionId);
  const sendRetirementRaceFresh = await manager.createSession('worker.fake', {}, sendRetirementRaceTarget.taskId);
  adapter.sendStarts.length = 0;
  const sendRetirementRaceIterator = manager.send(sendRetirementRaceFresh.managedSessionId, {
    inputId: 'retirement-wins-stale-send',
    prompt: 'queued before retirement, consumed while retirement owns the native barrier',
  })[Symbol.asyncIterator]();
  const retirementDisposeGate = { started: deferred(), release: deferred() };
  adapter.disposeGates.set(sendRetirementRaceFresh.adapterSessionId, retirementDisposeGate);
  const sendRetirementFinalizePromise = finalizer.finalizeMission(sendRetirementRaceOwner.taskId);
  await retirementDisposeGate.started.promise;
  assert.equal(manager.getSession(sendRetirementRaceFresh.managedSessionId), undefined, 'retirement must remove routing before provider cleanup waits');
  const retirementWinsStaleNext = assert.rejects(
    () => sendRetirementRaceIterator.next(),
    /retired|Unknown managed worker session/,
    'first consumption queued behind a retirement-owned native barrier must fail closed',
  );
  assert.equal(adapter.sendStarts.length, 0, 'queued first consumption must not jump ahead of retirement while cleanup is gated');
  retirementDisposeGate.release.resolve();
  const sendRetirementRaceResult = await sendRetirementFinalizePromise;
  await retirementWinsStaleNext;
  assert.equal(sendRetirementRaceResult.mission.missionFinalization.state, 'archived');
  assert.equal(adapter.sendStarts.length, 0, 'retirement-wins race must never start provider work');
  assert.ok(tasks.getTask(sendRetirementRaceTarget.taskId).workerSessions[sendRetirementRaceFresh.managedSessionId].retiredAt);
  assert.equal(tasks.getTask(sendRetirementRaceTarget.taskId).missionFinalization, undefined);
  adapter.forcedSessionId = undefined;

  const sendStartWinsMission = await tasks.ensureTask({ kind: 'bridge', key: 'send-start-wins' }, 'Do not archive while an already-started send is active');
  await tasks.configureMission(sendStartWinsMission.taskId, {
    projectId: project.projectId,
    rootMissionId: sendStartWinsMission.taskId,
    plane: 'practice',
    missionType: 'send-start-wins',
    completionCriteria: ['An active send is visible to Mission finalization'],
  });
  const sendStartWinsWorker = await manager.createSession('worker.fake', {}, sendStartWinsMission.taskId);
  const sendStartGate = { started: deferred(), release: deferred() };
  adapter.sendGates.set('send-start-wins-turn', sendStartGate);
  adapter.sendStarts.length = 0;
  const sendStartWinsIterator = manager.send(sendStartWinsWorker.managedSessionId, {
    inputId: 'send-start-wins-turn',
    prompt: 'start first, then race finalization',
  })[Symbol.asyncIterator]();
  const sendStartFirstEvent = sendStartWinsIterator.next();
  await sendStartGate.started.promise;
  assert.equal(adapter.sendStarts.length, 1, 'send-start-wins harness must prove provider work already began');
  assert.equal(manager.getSession(sendStartWinsWorker.managedSessionId).state, 'running', 'manager-owned lease must expose the active send before provider completion');
  let sendStartFinalizationSettled = false;
  const sendStartFinalization = finalizer.finalizeMission(sendStartWinsMission.taskId).finally(() => {
    sendStartFinalizationSettled = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sendStartFinalizationSettled, false, 'send-start-wins finalizer must wait for the active send lease instead of failing or archiving through it');
  assert.equal(tasks.getTask(sendStartWinsMission.taskId).missionFinalization, undefined, 'Mission death must not become durable while the winning send is still active');
  sendStartGate.release.resolve();
  assert.equal((await sendStartFirstEvent).value.type, 'text_delta');
  assert.equal((await sendStartWinsIterator.next()).value.status, 'completed');
  const sendStartWinsFinalized = await sendStartFinalization;
  assert.equal(sendStartWinsFinalized.mission.missionFinalization.state, 'archived');
  assert.equal(manager.getSession(sendStartWinsWorker.managedSessionId), undefined, 'waiting finalizer must retire routing immediately after the winning send releases its lease');
  adapter.sendGates.delete('send-start-wins-turn');

  const hostContinuationMission = await tasks.ensureTask({ kind: 'bridge', key: 'send-host-continuation-wins' }, 'Let an admitted provider turn finish through host-result continuation');
  await tasks.configureMission(hostContinuationMission.taskId, {
    projectId: project.projectId,
    rootMissionId: hostContinuationMission.taskId,
    plane: 'practice',
    missionType: 'send-host-continuation-wins',
    completionCriteria: ['Finalization waits without revoking the exact admitted host-result continuation'],
  });
  const hostContinuationWorker = await manager.createSession('worker.fake', {}, hostContinuationMission.taskId);
  const wrongContinuationWorker = await manager.createSession('worker.fake', {}, hostContinuationMission.taskId);
  const lateAttachCandidate = await manager.createSession('worker.fake', {});
  const hostContinuationIterator = manager.send(hostContinuationWorker.managedSessionId, {
    inputId: 'host-continuation-turn',
    prompt: 'host-request',
  })[Symbol.asyncIterator]();
  const hostCapabilityCall = await hostContinuationIterator.next();
  assert.equal(hostCapabilityCall.value.type, 'capability_call');
  assert.equal(hostCapabilityCall.value.dispatch, 'host-requested');
  assert.equal(manager.getSession(hostContinuationWorker.managedSessionId).state, 'running');

  let hostContinuationFinalizationSettled = false;
  const hostContinuationFinalization = finalizer.finalizeMission(hostContinuationMission.taskId).finally(() => {
    hostContinuationFinalizationSettled = true;
  });
  let finalizationFenceObserved = false;
  for (let attempt = 0; attempt < 20 && !finalizationFenceObserved; attempt += 1) {
    await new Promise(resolve => setImmediate(resolve));
    try {
      await tasks.assertWorkerSessionContinuationAllowed(hostContinuationMission.taskId, 'probe new work');
    } catch (error) {
      if (/finalizing/.test(String(error))) finalizationFenceObserved = true;
      else throw error;
    }
  }
  assert.equal(finalizationFenceObserved, true, 'harness must observe the Mission admission fence while the admitted turn is still active');
  assert.equal(hostContinuationFinalizationSettled, false, 'finalizer must wait for the admitted host-result turn instead of settling early');
  assert.equal(tasks.getTask(hostContinuationMission.taskId).missionFinalization, undefined, 'durable Mission death must wait until the admitted turn reaches terminal');

  const blockedLateSend = manager.send(wrongContinuationWorker.managedSessionId, {
    inputId: 'finalization-wins-new-send',
    prompt: 'must not start after admission closes',
  })[Symbol.asyncIterator]();
  await assert.rejects(() => blockedLateSend.next(), /finalizing/, 'new send admission must remain closed while admitted continuation is allowed');
  await assert.rejects(
    () => manager.createSession('worker.fake', {}, hostContinuationMission.taskId),
    /finalizing/,
    'new create publication must remain closed while admitted continuation is allowed',
  );
  await assert.rejects(
    () => manager.bindTask(lateAttachCandidate.managedSessionId, hostContinuationMission.taskId),
    /finalizing/,
    'new attach/rebind must remain closed while admitted continuation is allowed',
  );

  const hostResult = {
    inputId: 'host-continuation-turn',
    callId: hostCapabilityCall.value.callId,
    name: 'read_files',
    text: 'HOST_RESULT_OK',
  };
  await assert.rejects(
    () => manager.submitCapabilityResult(hostContinuationWorker.managedSessionId, { ...hostResult, inputId: 'wrong-input' }),
    /No outstanding host-requested capability call/,
  );
  await assert.rejects(
    () => manager.submitCapabilityResult(hostContinuationWorker.managedSessionId, { ...hostResult, callId: 'wrong-call' }),
    /No outstanding host-requested capability call/,
  );
  await assert.rejects(
    () => manager.submitCapabilityResult(hostContinuationWorker.managedSessionId, { ...hostResult, name: 'wrong_capability' }),
    /name mismatch/,
  );
  await assert.rejects(
    () => manager.submitCapabilityResult(wrongContinuationWorker.managedSessionId, hostResult),
    /No outstanding host-requested capability call/,
    'a different managed Worker must not borrow the admitted turn continuation authority',
  );

  let hostCapabilityExecutions = 0;
  const hostExecution = new HostCapabilityExecutionCoordinator({
    durableStore: new TaskHostCapabilityExecutionStore(tasks),
    authorizer: { async authorize() {} },
    executor: {
      async execute(request) {
        hostCapabilityExecutions += 1;
        assert.equal(request.managedSessionId, hostContinuationWorker.managedSessionId);
        assert.equal(request.workerId, 'worker.fake');
        assert.equal(request.inputId, hostResult.inputId);
        assert.equal(request.callId, hostResult.callId);
        assert.equal(request.name, hostResult.name);
        return { text: hostResult.text };
      },
    },
  });
  const hostExecutionRequest = {
    executionId: 'host-continuation-execution',
    managedSessionId: hostContinuationWorker.managedSessionId,
    workerId: 'worker.fake',
    taskId: hostContinuationMission.taskId,
    inputId: hostResult.inputId,
    callId: hostResult.callId,
    name: hostResult.name,
    arguments: hostCapabilityCall.value.arguments,
  };
  const [deliveredHostResult, concurrentDuplicateHostResult] = await Promise.all([
    hostExecution.executeAndDeliver(hostExecutionRequest, manager),
    hostExecution.executeAndDeliver({ ...hostExecutionRequest }, manager),
  ]);
  assert.deepEqual(deliveredHostResult, concurrentDuplicateHostResult, 'duplicate host dispatch must share the one durable execution/result');
  assert.equal(hostCapabilityExecutions, 1, 'host capability side effect must execute exactly once');
  const durableHostExecution = tasks.getTask(hostContinuationMission.taskId).executions[hostExecutionRequest.executionId];
  assert.equal(durableHostExecution.status, 'succeeded', 'host result must be durable before the admitted provider turn completes');
  assert.equal(durableHostExecution.deliveryStatus, 'delivered', 'result delivery confirmation must remain a separate durable transition');
  assert.equal(durableHostExecution.resultPayload.text, hostResult.text);
  assert.equal(
    adapter.submittedResults.filter(entry => entry.result.inputId === hostResult.inputId && entry.result.callId === hostResult.callId).length,
    1,
    'the exact host result must be delivered once to the admitted provider turn',
  );
  await assert.rejects(
    () => manager.submitCapabilityResult(hostContinuationWorker.managedSessionId, hostResult),
    /No outstanding host-requested capability call/,
    'result delivery is single-use even while the provider turn is still active',
  );
  assert.equal((await hostContinuationIterator.next()).value.type, 'capability_result');
  assert.equal((await hostContinuationIterator.next()).value.status, 'completed');
  const hostContinuationFinalized = await hostContinuationFinalization;
  assert.equal(hostContinuationFinalized.mission.missionFinalization.state, 'archived');
  assert.equal(manager.getSession(hostContinuationWorker.managedSessionId), undefined);
  assert.equal(manager.getSession(wrongContinuationWorker.managedSessionId), undefined);
  assert.ok(tasks.getTask(hostContinuationMission.taskId).workerSessions[hostContinuationWorker.managedSessionId].retiredAt);
  assert.ok(tasks.getTask(hostContinuationMission.taskId).workerSessions[wrongContinuationWorker.managedSessionId].retiredAt);
  await assert.rejects(
    () => manager.submitCapabilityResult(hostContinuationWorker.managedSessionId, hostResult),
    /retired|Unknown managed worker session/,
    'terminal/retired turns must not retain continuation authority',
  );
  await manager.dispose(lateAttachCandidate.managedSessionId);

  const cancelledContinuationMission = await tasks.ensureTask({ kind: 'bridge', key: 'send-host-continuation-cancelled' }, 'Release finalization when an admitted host-result turn is cancelled');
  await tasks.configureMission(cancelledContinuationMission.taskId, {
    projectId: project.projectId,
    rootMissionId: cancelledContinuationMission.taskId,
    plane: 'practice',
    missionType: 'send-host-continuation-cancelled',
    completionCriteria: ['Consumer cancellation revokes continuation authority and releases the finalizer wait'],
  });
  const cancelledContinuationWorker = await manager.createSession('worker.fake', {}, cancelledContinuationMission.taskId);
  const cancelledContinuationIterator = manager.send(cancelledContinuationWorker.managedSessionId, {
    inputId: 'host-continuation-cancelled-turn',
    prompt: 'host-request',
  })[Symbol.asyncIterator]();
  const cancelledCapabilityCall = await cancelledContinuationIterator.next();
  assert.equal(cancelledCapabilityCall.value.type, 'capability_call');
  let cancelledFinalizationSettled = false;
  const cancelledFinalization = finalizer.finalizeMission(cancelledContinuationMission.taskId).finally(() => {
    cancelledFinalizationSettled = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelledFinalizationSettled, false, 'finalizer must initially wait on the cancelled-turn send lease');
  await cancelledContinuationIterator.return();
  await assert.rejects(
    () => manager.submitCapabilityResult(cancelledContinuationWorker.managedSessionId, {
      inputId: 'host-continuation-cancelled-turn',
      callId: cancelledCapabilityCall.value.callId,
      name: 'read_files',
      text: 'STALE-AFTER-CANCEL',
    }),
    /No outstanding host-requested capability call|retired|Unknown managed worker session/,
    'consumer cancellation must revoke the exact pending continuation before or as finalization retires the Worker',
  );
  const cancelledFinalized = await cancelledFinalization;
  assert.equal(cancelledFinalized.mission.missionFinalization.state, 'archived', 'lease cleanup after consumer cancellation must unblock finalization through archive');
  assert.equal(manager.getSession(cancelledContinuationWorker.managedSessionId), undefined);

  const lateAttachMission = await tasks.ensureTask({ kind: 'bridge', key: 'late-attach-after-finalizer-snapshot' }, 'Close late attach after the finalizer identity snapshot');
  await tasks.configureMission(lateAttachMission.taskId, {
    projectId: project.projectId,
    rootMissionId: lateAttachMission.taskId,
    plane: 'practice',
    missionType: 'late-attach-finalization-race',
    completionCriteria: ['A provider identity created after the finalizer snapshot cannot attach or start send'],
  });
  const lateAttachOriginal = await manager.createSession('worker.fake', {}, lateAttachMission.taskId);
  const lateCreateGate = { started: deferred(), release: deferred() };
  adapter.forcedSessionId = 'provider-late-attach-after-snapshot';
  adapter.createGates.set('provider-late-attach-after-snapshot', lateCreateGate);
  const lateCreatePromise = manager.createSession('worker.fake', {}, lateAttachMission.taskId);
  await lateCreateGate.started.promise;

  const finalizationScopeObserved = deferred();
  const finalizationScopeRelease = deferred();
  const lateAttachCheckObserved = deferred();
  const lateAttachCheckRelease = deferred();
  const originalRetirementScope = manager.withAdapterSessionRetirementScope.bind(manager);
  const originalContinuationCheck = tasks.assertWorkerSessionContinuationAllowed.bind(tasks);
  let interceptFinalizationScope = true;
  let interceptLateAttachCheck = true;
  manager.withAdapterSessionRetirementScope = async (identities, operation) => {
    if (interceptFinalizationScope && identities.some(identity => identity.adapterSessionId === lateAttachOriginal.adapterSessionId)) {
      interceptFinalizationScope = false;
      finalizationScopeObserved.resolve(identities.map(identity => ({ ...identity })));
      await finalizationScopeRelease.promise;
    }
    return originalRetirementScope(identities, operation);
  };
  tasks.assertWorkerSessionContinuationAllowed = async (taskId, operation) => {
    if (interceptLateAttachCheck && taskId === lateAttachMission.taskId && operation === 'attach a WorkerSession') {
      interceptLateAttachCheck = false;
      lateAttachCheckObserved.resolve();
      await lateAttachCheckRelease.promise;
    }
    return originalContinuationCheck(taskId, operation);
  };

  let lateAttachFinalization;
  try {
    lateAttachFinalization = finalizer.finalizeMission(lateAttachMission.taskId);
    const snapshottedIdentities = await finalizationScopeObserved.promise;
    assert.deepEqual(
      snapshottedIdentities.map(identity => identity.adapterSessionId),
      [lateAttachOriginal.adapterSessionId],
      'adversarial harness must prove the finalizer identity snapshot happened before the new provider identity existed',
    );

    lateCreateGate.release.resolve();
    await lateAttachCheckObserved.promise;
    const transientLateWrapper = manager.getSessionByAdapterIdentity('worker.fake', 'provider-late-attach-after-snapshot');
    assert.ok(transientLateWrapper, 'adversarial harness must expose the transient late wrapper after snapshot and before attach admission resolves');
    const lateSendIterator = manager.send(transientLateWrapper.managedSessionId, {
      inputId: 'late-attach-send-start',
      prompt: 'must queue behind attach ownership and never reach provider send',
    })[Symbol.asyncIterator]();
    const lateSendNext = lateSendIterator.next();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(
      adapter.sendStarts.some(entry => entry.inputId === 'late-attach-send-start'),
      false,
      'queued send-start must not invoke provider code while the late attach still owns its provider-native barrier',
    );

    lateAttachCheckRelease.resolve();
    await assert.rejects(() => lateCreatePromise, /finalizing/, 'late attach must fail closed against the Mission stabilization fence');
    await assert.rejects(() => lateSendNext, /Unknown managed worker session|retired/, 'queued send-start must die when the rejected late wrapper is unpublished');
    assert.equal(manager.getSessionByAdapterIdentity('worker.fake', 'provider-late-attach-after-snapshot'), undefined);
    assert.equal(
      Object.values(tasks.getTask(lateAttachMission.taskId).workerSessions).some(worker => worker.adapterSessionId === 'provider-late-attach-after-snapshot'),
      false,
      'rejected late attach must not split durable Worker ownership from live routing',
    );
    assert.equal(
      adapter.sendStarts.some(entry => entry.inputId === 'late-attach-send-start'),
      false,
      'finalization-wins ordering must never start the provider turn for the late wrapper',
    );
    finalizationScopeRelease.resolve();
    const lateAttachResult = await lateAttachFinalization;
    assert.equal(lateAttachResult.mission.missionFinalization.state, 'archived');
    assert.equal(manager.getSession(lateAttachOriginal.managedSessionId), undefined);
  } finally {
    lateCreateGate.release.resolve();
    lateAttachCheckRelease.resolve();
    finalizationScopeRelease.resolve();
    manager.withAdapterSessionRetirementScope = originalRetirementScope;
    tasks.assertWorkerSessionContinuationAllowed = originalContinuationCheck;
    adapter.forcedSessionId = undefined;
  }

  const rebindOwnerMission = await tasks.ensureTask({ kind: 'bridge', key: 'rebind-owner' }, 'Retain Mission death authority over an exact rebound conversation');
  await tasks.configureMission(rebindOwnerMission.taskId, {
    projectId: project.projectId,
    rootMissionId: rebindOwnerMission.taskId,
    plane: 'practice',
    missionType: 'rebind-owner-test',
    completionCriteria: ['Exact provider-native rebind cannot escape the original Mission death boundary'],
  });
  const rebindTargetMission = await tasks.ensureTask({ kind: 'bridge', key: 'rebind-target' }, 'Stay unfinalized when a rebound Worker is retired');
  await tasks.configureMission(rebindTargetMission.taskId, {
    projectId: project.projectId,
    rootMissionId: rebindTargetMission.taskId,
    plane: 'practice',
    missionType: 'rebind-target-test',
    completionCriteria: ['Mission continues with a replacement Worker after rebound conversation retirement'],
  });
  const rebound = await manager.createSession('worker.fake', {}, rebindOwnerMission.taskId);
  await manager.bindTask(rebound.managedSessionId, rebindTargetMission.taskId);
  const reboundResult = await finalizer.finalizeMission(rebindOwnerMission.taskId);
  assert.equal(reboundResult.mission.missionFinalization.state, 'archived');
  assert.equal(manager.getSession(rebound.managedSessionId), undefined);
  assert.ok(tasks.getTask(rebindOwnerMission.taskId).workerSessions[rebound.managedSessionId].retiredAt);
  assert.ok(tasks.getTask(rebindTargetMission.taskId).workerSessions[rebound.managedSessionId].retiredAt);
  assert.equal(tasks.getTask(rebindTargetMission.taskId).missionFinalization, undefined, 'cross-Mission Worker retirement must not imply Mission B death');
  const reboundReplacement = await manager.createSession('worker.fake', {}, rebindTargetMission.taskId);
  const reboundReplacementEvents = [];
  for await (const event of manager.send(reboundReplacement.managedSessionId, { inputId: 'rebind-replacement', prompt: 'continue after original conversation retirement' })) reboundReplacementEvents.push(event);
  assert.equal(reboundReplacementEvents.at(-1).status, 'completed');
  await manager.dispose(reboundReplacement.managedSessionId);

  const mismatchOwner = await tasks.ensureTask({ kind: 'bridge', key: 'identity-mismatch-adapter-owner' }, 'Do not retire same managed id with a different provider session');
  await tasks.configureMission(mismatchOwner.taskId, {
    projectId: project.projectId,
    rootMissionId: mismatchOwner.taskId,
    plane: 'practice',
    missionType: 'identity-mismatch-adapter-owner',
    completionCriteria: ['Provider identity, not managed id alone, controls retirement'],
  });
  const mismatchTarget = await tasks.ensureTask({ kind: 'bridge', key: 'identity-mismatch-adapter-target' }, 'Keep unrelated same-managed-id session alive');
  await tasks.configureMission(mismatchTarget.taskId, {
    projectId: project.projectId,
    rootMissionId: mismatchTarget.taskId,
    plane: 'practice',
    missionType: 'identity-mismatch-adapter-target',
    completionCriteria: ['Unrelated session remains routeable'],
  });
  const mismatchAdapter = new FakeAdapter();
  const mismatchManager = new WorkerSessionManager({ taskBindings: tasks, newId: () => 'managed-reused-adapter-identity', now: clock });
  await mismatchManager.register(mismatchAdapter);
  mismatchAdapter.forcedSessionId = 'provider-identity-old';
  const mismatchOld = await mismatchManager.createSession('worker.fake', {}, mismatchOwner.taskId);
  await mismatchManager.dispose(mismatchOld.managedSessionId);
  mismatchAdapter.forcedSessionId = 'provider-identity-unrelated';
  const mismatchLive = await mismatchManager.createSession('worker.fake', {}, mismatchTarget.taskId);
  assert.equal(mismatchLive.managedSessionId, mismatchOld.managedSessionId, 'test intentionally reuses the managed id');
  await new MissionFinalizationService(tasks, mismatchManager, { now: clock }).finalizeMission(mismatchOwner.taskId);
  assert.ok(mismatchManager.getSession(mismatchLive.managedSessionId), 'different adapterSessionId must not be killed merely because managedSessionId matches Mission history');
  const mismatchEvents = [];
  for await (const event of mismatchManager.send(mismatchLive.managedSessionId, { inputId: 'identity-mismatch-adapter-send', prompt: 'unrelated provider session survives' })) mismatchEvents.push(event);
  assert.equal(mismatchEvents.at(-1).status, 'completed');
  await mismatchManager.dispose(mismatchLive.managedSessionId);

  const workerMismatchOwner = await tasks.ensureTask({ kind: 'bridge', key: 'identity-mismatch-worker-owner' }, 'Do not retire a different worker with the same native id');
  await tasks.configureMission(workerMismatchOwner.taskId, {
    projectId: project.projectId,
    rootMissionId: workerMismatchOwner.taskId,
    plane: 'practice',
    missionType: 'identity-mismatch-worker-owner',
    completionCriteria: ['workerId participates in provider-native retirement identity'],
  });
  const workerMismatchTarget = await tasks.ensureTask({ kind: 'bridge', key: 'identity-mismatch-worker-target' }, 'Keep different worker identity alive');
  await tasks.configureMission(workerMismatchTarget.taskId, {
    projectId: project.projectId,
    rootMissionId: workerMismatchTarget.taskId,
    plane: 'practice',
    missionType: 'identity-mismatch-worker-target',
    completionCriteria: ['Different Worker remains routeable'],
  });
  const workerMismatchManager = new WorkerSessionManager({ taskBindings: tasks, newId: () => 'managed-reused-worker-identity', now: clock });
  const workerMismatchA = new FakeAdapter('worker.fake');
  const workerMismatchB = new FakeAdapter('worker.other');
  workerMismatchA.forcedSessionId = 'provider-shared-across-workers';
  workerMismatchB.forcedSessionId = 'provider-shared-across-workers';
  await workerMismatchManager.register(workerMismatchA);
  await workerMismatchManager.register(workerMismatchB);
  const workerMismatchOld = await workerMismatchManager.createSession('worker.fake', {}, workerMismatchOwner.taskId);
  await workerMismatchManager.dispose(workerMismatchOld.managedSessionId);
  const workerMismatchLive = await workerMismatchManager.createSession('worker.other', {}, workerMismatchTarget.taskId);
  assert.equal(workerMismatchLive.managedSessionId, workerMismatchOld.managedSessionId);
  await new MissionFinalizationService(tasks, workerMismatchManager, { now: clock }).finalizeMission(workerMismatchOwner.taskId);
  assert.ok(workerMismatchManager.getSession(workerMismatchLive.managedSessionId), 'different workerId must not be killed when provider-native session id and managed id collide');
  const workerMismatchEvents = [];
  for await (const event of workerMismatchManager.send(workerMismatchLive.managedSessionId, { inputId: 'identity-mismatch-worker-send', prompt: 'different worker survives' })) workerMismatchEvents.push(event);
  assert.equal(workerMismatchEvents.at(-1).status, 'completed');
  await workerMismatchManager.dispose(workerMismatchLive.managedSessionId);

  const raceOwner = await tasks.ensureTask({ kind: 'bridge', key: 'provider-race-owner' }, 'Serialize fresh-wrapper publication against Mission retirement');
  await tasks.configureMission(raceOwner.taskId, {
    projectId: project.projectId,
    rootMissionId: raceOwner.taskId,
    plane: 'practice',
    missionType: 'provider-race-owner',
    completionCriteria: ['An in-flight fresh wrapper cannot survive the provider-native retirement barrier'],
  });
  const raceTarget = await tasks.ensureTask({ kind: 'bridge', key: 'provider-race-target' }, 'Remain alive after raced Worker retirement');
  await tasks.configureMission(raceTarget.taskId, {
    projectId: project.projectId,
    rootMissionId: raceTarget.taskId,
    plane: 'practice',
    missionType: 'provider-race-target',
    completionCriteria: ['Only the raced Worker dies, not this Mission'],
  });
  const raceCheckObserved = deferred();
  const raceCheckRelease = deferred();
  let blockRaceCheck = false;
  const raceBindings = {
    attachWorkerSession: (...args) => tasks.attachWorkerSession(...args),
    detachWorkerSession: (...args) => tasks.detachWorkerSession(...args),
    retireWorkerSessionStrict: (...args) => tasks.retireWorkerSessionStrict(...args),
    isWorkerAdapterSessionRetired: async (workerId, adapterSessionId) => {
      const retired = await tasks.isWorkerAdapterSessionRetired(workerId, adapterSessionId);
      if (blockRaceCheck && workerId === 'worker.fake' && adapterSessionId === 'provider-race-native') {
        raceCheckObserved.resolve(retired);
        await raceCheckRelease.promise;
      }
      return retired;
    },
  };
  let raceManagedId = 0;
  const raceManager = new WorkerSessionManager({ taskBindings: raceBindings, newId: () => `race-managed-${++raceManagedId}`, now: clock });
  const raceAdapter = new FakeAdapter();
  raceAdapter.forcedSessionId = 'provider-race-native';
  await raceManager.register(raceAdapter);
  const raceOriginal = await raceManager.createSession('worker.fake', {}, raceOwner.taskId);
  await raceManager.dispose(raceOriginal.managedSessionId);
  blockRaceCheck = true;
  const raceCreatePromise = raceManager.createSession('worker.fake', {}, raceTarget.taskId);
  assert.equal(await raceCheckObserved.promise, false, 'adversarial harness must observe a pre-retirement durable check that already read false');
  const raceFinalizer = new MissionFinalizationService(tasks, raceManager, { now: clock });
  const raceFinalizePromise = raceFinalizer.finalizeMission(raceOwner.taskId);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tasks.getTask(raceOwner.taskId).missionFinalization, undefined, 'finalizer must wait behind an in-flight create that already owns the same provider-native barrier');
  assert.equal(await tasks.isWorkerAdapterSessionRetired('worker.fake', 'provider-race-native'), false, 'durable death cannot leapfrog the create that won the native-identity barrier');
  assert.equal(raceManager.getSessionByAdapterIdentity('worker.fake', 'provider-race-native'), undefined, 'fresh wrapper is not published while its identity lock is held at the stale durable check');
  raceCheckRelease.resolve();
  const raceFresh = await raceCreatePromise;
  const raceResult = await raceFinalizePromise;
  assert.equal(raceResult.mission.missionFinalization.state, 'archived');
  assert.equal(raceManager.getSession(raceFresh.managedSessionId), undefined, 'finalizer waiting on the same identity barrier must retire a wrapper published from the stale check before it can escape');
  assert.ok(raceManager.getRetiredSession(raceFresh.managedSessionId));
  assert.ok(tasks.getTask(raceTarget.taskId).workerSessions[raceFresh.managedSessionId].retiredAt, 'raced wrapper current-Mission retirement must persist before removal from routing');
  assert.equal(tasks.getTask(raceTarget.taskId).missionFinalization, undefined);
  assert.throws(() => raceManager.send(raceFresh.managedSessionId, { inputId: 'race-must-not-run', prompt: 'must be retired' }), /retired/);

  const handoffRaceMission = await tasks.ensureTask({ kind: 'bridge', key: 'handoff-snapshot-race' }, 'Linearize final Handoff snapshot');
  await tasks.configureMission(handoffRaceMission.taskId, {
    projectId: project.projectId,
    rootMissionId: handoffRaceMission.taskId,
    plane: 'cognition',
    missionType: 'handoff-snapshot-race',
    completionCriteria: ['Final Handoff reflects the final durable context revision'],
  });
  await tasks.updateContext(handoffRaceMission.taskId, { summary: 'STALE-HANDOFF-CONTEXT' });
  const originalFinalizeMissionStrict = tasks.finalizeMissionStrict.bind(tasks);
  let injectedFinalContext = false;
  tasks.finalizeMissionStrict = async (...args) => {
    if (args[0] === handoffRaceMission.taskId && !injectedFinalContext) {
      injectedFinalContext = true;
      await tasks.updateContext(handoffRaceMission.taskId, { summary: 'LATEST-HANDOFF-CONTEXT' });
    }
    return originalFinalizeMissionStrict(...args);
  };
  const handoffRaceResult = await finalizer.finalizeMission(handoffRaceMission.taskId);
  tasks.finalizeMissionStrict = originalFinalizeMissionStrict;
  assert.match(getMissionFinalHandoffText(handoffRaceResult.mission) ?? '', /LATEST-HANDOFF-CONTEXT/, 'final Handoff must be generated inside the same task-linearized completion protocol');
  assert.doesNotMatch(getMissionFinalHandoffText(handoffRaceResult.mission) ?? '', /STALE-HANDOFF-CONTEXT/);

  const collisionMission = await tasks.ensureTask({ kind: 'bridge', key: 'handoff-artifact-collision' }, 'Reject ambiguous final Handoff identity');
  await tasks.configureMission(collisionMission.taskId, {
    projectId: project.projectId,
    rootMissionId: collisionMission.taskId,
    plane: 'practice',
    missionType: 'handoff-artifact-collision',
    completionCriteria: ['Final Handoff identity cannot collide with an older artifact'],
  });
  await tasks.recordArtifact(collisionMission.taskId, {
    artifactId: 'handoff-collision-id',
    kind: 'report',
    title: 'Older report',
    metadata: { content: 'OLD-REPORT-CONTENT' },
  });
  await assert.rejects(
    () => tasks.finalizeMissionStrict(collisionMission.taskId, {
      handoffRequired: true,
      handoff: {
        artifactId: 'handoff-collision-id',
        kind: 'report',
        title: 'Mission final Handoff',
        metadata: { missionFinalHandoff: true, missionId: collisionMission.taskId, content: 'NEW-FINAL-HANDOFF-CONTENT' },
      },
    }),
    /artifact.*collision|collision.*artifact|already exists/i,
    'final Handoff must reject an artifact identity that already resolves to older content',
  );
  assert.equal(tasks.getTask(collisionMission.taskId).missionFinalization, undefined, 'collision rejection must not partially finalize the Mission');

  const terminalReplayMission = await tasks.ensureTask({ kind: 'bridge', key: 'terminal-replay' }, 'Terminal Mission replay invariant');
  await tasks.configureMission(terminalReplayMission.taskId, {
    projectId: project.projectId,
    rootMissionId: terminalReplayMission.taskId,
    plane: 'practice',
    missionType: 'terminal-replay',
    completionCriteria: ['Archived Mission cannot become running again'],
  });
  await tasks.startInteraction(terminalReplayMission.taskId, { interactionId: 'running-before-finalize', surface: 'bridge' });
  await assert.rejects(() => finalizer.finalizeMission(terminalReplayMission.taskId), /running work|running WorkerSession|running/);
  await tasks.finishInteraction(terminalReplayMission.taskId, 'running-before-finalize', 'completed');
  const terminalReplayResult = await finalizer.finalizeMission(terminalReplayMission.taskId);
  assert.equal(terminalReplayResult.mission.missionFinalization.state, 'archived');
  const terminalReplayJournal = path.join(taskDirectory, `${terminalReplayMission.taskId}.jsonl`);
  await fs.appendFile(terminalReplayJournal, `${JSON.stringify({
    version: 1,
    eventId: 'forged-late-interaction-start',
    taskId: terminalReplayMission.taskId,
    at: '2026-09-14T23:59:58.000Z',
    type: 'TaskInteractionStarted',
    payload: { interaction: { interactionId: 'forged-late', surface: 'bridge', startedAt: '2026-09-14T23:59:58.000Z' } },
  })}\n${JSON.stringify({
    version: 1,
    eventId: 'forged-late-interaction-finish',
    taskId: terminalReplayMission.taskId,
    at: '2026-09-14T23:59:59.000Z',
    type: 'TaskInteractionFinished',
    payload: { interactionId: 'forged-late', outcome: 'completed', finishedAt: '2026-09-14T23:59:59.000Z' },
  })}\n`, 'utf8');

  const replayHandoffIntegrityTaskId = 'replay-handoff-integrity';
  const replayHandoffIntegrityJournal = path.join(taskDirectory, `${replayHandoffIntegrityTaskId}.jsonl`);
  const replaySourceEventId = 'replay-handoff-configured';
  const replaySourceEventCount = 2;
  const digest = content => `sha256:${createHash('sha256').update(content).digest('hex')}`;
  const forgedDeclaredDigest = digest('DECLARED-BUT-NOT-ACTUAL-CONTENT');
  const wrongMetadataDigest = digest('WRONG-METADATA-DIGEST');
  const validReplayHandoffContent = 'VALID-REPLAY-HANDOFF-CONTENT';
  const validReplayHandoffDigest = digest(validReplayHandoffContent);
  const replayHandoffEvent = ({
    eventId,
    artifactId,
    content,
    projectId = project.projectId,
    missionId = replayHandoffIntegrityTaskId,
    eventSourceEventId = replaySourceEventId,
    eventSourceEventCount = replaySourceEventCount,
    artifactSourceEventId = replaySourceEventId,
    artifactSourceEventCount = replaySourceEventCount,
    omitEventSourceId = false,
    omitEventSourceCount = false,
    omitArtifactSourceId = false,
    omitArtifactSourceCount = false,
    eventDigest = digest(content),
    metadataDigest = eventDigest,
  }) => {
    const metadata = {
      missionFinalHandoff: true,
      missionId,
      projectId,
      content,
      contentDigest: metadataDigest,
    };
    if (!omitArtifactSourceId) metadata.sourceTaskEventId = artifactSourceEventId;
    if (!omitArtifactSourceCount) metadata.sourceTaskEventCount = artifactSourceEventCount;
    const payload = {
      completedAt: '2026-09-14T20:00:00.000Z',
      handoffRequired: true,
      handoff: {
        artifactId,
        kind: 'report',
        title: 'Replay Handoff',
        createdAt: '2026-09-14T20:00:00.000Z',
        metadata,
      },
      handoffContentDigest: eventDigest,
    };
    if (!omitEventSourceId) payload.handoffSourceEventId = eventSourceEventId;
    if (!omitEventSourceCount) payload.handoffSourceEventCount = eventSourceEventCount;
    return {
      version: 1,
      eventId,
      taskId: replayHandoffIntegrityTaskId,
      at: '2026-09-14T20:00:00.000Z',
      type: 'TaskMissionFinalized',
      payload,
    };
  };
  await fs.writeFile(replayHandoffIntegrityJournal, [
    {
      version: 1, eventId: 'replay-handoff-created', taskId: replayHandoffIntegrityTaskId, at: '2026-09-14T19:59:58.000Z', type: 'TaskCreated',
      payload: { source: { kind: 'bridge', key: 'replay-handoff-integrity' }, goal: 'Reject forged replay Handoff identity' },
    },
    {
      version: 1, eventId: replaySourceEventId, taskId: replayHandoffIntegrityTaskId, at: '2026-09-14T19:59:59.000Z', type: 'TaskMissionConfigured',
      payload: { mission: { projectId: project.projectId, rootMissionId: replayHandoffIntegrityTaskId, plane: 'practice', missionType: 'replay-handoff-integrity', completionCriteria: ['Only actual content with coherent identity may finalize replay'] }, adoptedWorkerSessions: [] },
    },
    replayHandoffEvent({
      eventId: 'replay-handoff-forged-content', artifactId: 'replay-handoff-forged-content-artifact', content: 'TAMPERED-ACTUAL-CONTENT', eventDigest: forgedDeclaredDigest, metadataDigest: forgedDeclaredDigest,
    }),
    replayHandoffEvent({
      eventId: 'replay-handoff-omit-all-source-binding', artifactId: 'replay-handoff-omit-all-source-binding-artifact', content: 'OMIT-ALL-SOURCE-BINDING',
      omitEventSourceId: true, omitEventSourceCount: true, omitArtifactSourceId: true, omitArtifactSourceCount: true,
    }),
    replayHandoffEvent({
      eventId: 'replay-handoff-omit-event-source-binding', artifactId: 'replay-handoff-omit-event-source-binding-artifact', content: 'OMIT-EVENT-SOURCE-BINDING',
      omitEventSourceId: true, omitEventSourceCount: true,
    }),
    replayHandoffEvent({
      eventId: 'replay-handoff-omit-artifact-source-binding', artifactId: 'replay-handoff-omit-artifact-source-binding-artifact', content: 'OMIT-ARTIFACT-SOURCE-BINDING',
      omitArtifactSourceId: true, omitArtifactSourceCount: true,
    }),
    replayHandoffEvent({
      eventId: 'replay-handoff-omit-source-id-only', artifactId: 'replay-handoff-omit-source-id-only-artifact', content: 'OMIT-SOURCE-ID-ONLY',
      omitEventSourceId: true, omitArtifactSourceId: true,
    }),
    replayHandoffEvent({
      eventId: 'replay-handoff-omit-source-count-only', artifactId: 'replay-handoff-omit-source-count-only-artifact', content: 'OMIT-SOURCE-COUNT-ONLY',
      omitEventSourceCount: true, omitArtifactSourceCount: true,
    }),
    replayHandoffEvent({
      eventId: 'replay-handoff-wrong-source-id', artifactId: 'replay-handoff-wrong-source-id-artifact', content: 'WRONG-SOURCE-ID-CONTENT',
      eventSourceEventId: 'wrong-source-event', artifactSourceEventId: 'wrong-source-event',
    }),
    replayHandoffEvent({
      eventId: 'replay-handoff-wrong-source-count', artifactId: 'replay-handoff-wrong-source-count-artifact', content: 'WRONG-SOURCE-COUNT-CONTENT',
      eventSourceEventCount: 999, artifactSourceEventCount: 999,
    }),
    replayHandoffEvent({
      eventId: 'replay-handoff-source-mismatch', artifactId: 'replay-handoff-source-mismatch-artifact', content: 'SOURCE-MISMATCH-CONTENT',
      artifactSourceEventId: 'artifact-source-does-not-match-event',
    }),
    replayHandoffEvent({
      eventId: 'replay-handoff-wrong-project', artifactId: 'replay-handoff-wrong-project-artifact', content: 'WRONG-PROJECT-CONTENT', projectId: 'wrong-project',
    }),
    replayHandoffEvent({
      eventId: 'replay-handoff-wrong-mission', artifactId: 'replay-handoff-wrong-mission-artifact', content: 'WRONG-MISSION-CONTENT', missionId: 'wrong-mission',
    }),
    replayHandoffEvent({
      eventId: 'replay-handoff-digest-disagreement', artifactId: 'replay-handoff-digest-disagreement-artifact', content: 'DIGEST-DISAGREEMENT-CONTENT', metadataDigest: wrongMetadataDigest,
    }),
    replayHandoffEvent({
      eventId: 'replay-handoff-valid', artifactId: 'replay-handoff-valid-artifact', content: validReplayHandoffContent, eventDigest: validReplayHandoffDigest, metadataDigest: validReplayHandoffDigest,
    }),
    {
      version: 1, eventId: 'replay-handoff-archive', taskId: replayHandoffIntegrityTaskId, at: '2026-09-14T20:00:01.000Z', type: 'TaskMissionArchived', payload: { archivedAt: '2026-09-14T20:00:01.000Z' },
    },
  ].map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8');

  const finalizedBeforeConfiguredTaskId = 'finalized-before-configured';
  await fs.writeFile(path.join(taskDirectory, `${finalizedBeforeConfiguredTaskId}.jsonl`), [
    {
      version: 1, eventId: 'fbc-created', taskId: finalizedBeforeConfiguredTaskId, at: '2026-09-14T20:10:00.000Z', type: 'TaskCreated',
      payload: { source: { kind: 'bridge', key: 'finalized-before-configured' }, goal: 'Original goal' },
    },
    {
      version: 1, eventId: 'fbc-illegal-finalized', taskId: finalizedBeforeConfiguredTaskId, at: '2026-09-14T20:10:01.000Z', type: 'TaskMissionFinalized',
      payload: { completedAt: '2026-09-14T20:10:01.000Z', handoffRequired: false },
    },
    {
      version: 1, eventId: 'fbc-configured', taskId: finalizedBeforeConfiguredTaskId, at: '2026-09-14T20:10:02.000Z', type: 'TaskMissionConfigured',
      payload: { mission: { projectId: project.projectId, rootMissionId: finalizedBeforeConfiguredTaskId, plane: 'practice', missionType: 'configured-after-illegal-finalized', completionCriteria: ['Illegal Finalized must not freeze later legal configuration'] }, adoptedWorkerSessions: [] },
    },
    {
      version: 1, eventId: 'fbc-goal-updated', taskId: finalizedBeforeConfiguredTaskId, at: '2026-09-14T20:10:03.000Z', type: 'TaskGoalUpdated',
      payload: { goal: 'Legal work after ignored illegal finalization' },
    },
  ].map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8');

  await manager.dispose(workerB.managedSessionId);
  await Promise.all([tasks.flush(), projects.flush()]);
  const restartedTasks = new TaskRuntime({ storageDirectory: taskDirectory });
  const restartedProjects = new ProjectStore({ storageDirectory: projectDirectory });
  await Promise.all([restartedTasks.initialize(), restartedProjects.initialize()]);
  const replayedA = restartedTasks.getTask(missionA.taskId);
  assert.equal(replayedA.missionFinalization.state, 'archived');
  assert.equal(replayedA.workerSessions[workerA.managedSessionId].retirementReason, 'mission-finalized');
  assert.equal(replayedA.workerSessions['orphaned-worker-a'].retirementReason, 'mission-finalized-orphaned');
  assert.equal(getMissionFinalHandoffText(replayedA), handoffTextA, 'final Handoff must survive restart/replay');
  assert.equal(restartedTasks.getTask(policyMission.taskId).missionFinalization.state, 'archived');
  assert.equal(restartedTasks.getTask(policyMission.taskId).missionFinalization.handoffRequired, false, 'original Handoff policy must survive restart/replay');
  await assert.rejects(
    () => restartedTasks.finalizeMissionStrict(policyMission.taskId, { handoffRequired: true }),
    /already finalized with a different Handoff policy/,
    'replayed finalization must preserve Handoff policy identity',
  );
  const replayedEscaped = restartedTasks.getTask(escapedMission.taskId);
  assert.equal(replayedEscaped.missionFinalization.state, 'archived');
  assert.equal(replayedEscaped.workerSessions[escapedWorker.managedSessionId].retirementReason, 'mission-finalized-history');
  const replayedTerminal = restartedTasks.getTask(terminalReplayMission.taskId);
  assert.equal(replayedTerminal.status, 'completed', 'late replay events must not downgrade terminal Task status');
  assert.equal(replayedTerminal.missionFinalization.state, 'archived', 'late replay events must not reactivate an archived Mission');
  assert.equal(replayedTerminal.interactions['forged-late'], undefined, 'late replay work must not mutate frozen Mission working facts');
  const replayedHandoffIntegrity = restartedTasks.getTask(replayHandoffIntegrityTaskId);
  assert.equal(replayedHandoffIntegrity.missionFinalization.state, 'archived', 'a valid finalization following forged replay attempts must still be accepted');
  assert.equal(replayedHandoffIntegrity.missionFinalization.handoffArtifactId, 'replay-handoff-valid-artifact');
  assert.equal(replayedHandoffIntegrity.missionFinalization.handoffSourceEventId, replaySourceEventId);
  assert.equal(replayedHandoffIntegrity.missionFinalization.handoffSourceEventCount, replaySourceEventCount);
  assert.equal(getMissionFinalHandoffText(replayedHandoffIntegrity), validReplayHandoffContent, 'forged content/project/source/digest declarations must be ignored without freezing the later valid Handoff');
  assert.equal(replayedHandoffIntegrity.artifacts.length, 1, 'only the coherent final Handoff artifact may enter replayed Mission state');
  const replayedFinalizedBeforeConfigured = restartedTasks.getTask(finalizedBeforeConfiguredTaskId);
  assert.equal(replayedFinalizedBeforeConfigured.missionFinalization, undefined, 'Finalized-before-Configured replay must fail closed without establishing terminal Mission state');
  assert.equal(replayedFinalizedBeforeConfigured.mission.missionType, 'configured-after-illegal-finalized', 'legal Mission configuration after the ignored illegal event must still replay');
  assert.equal(replayedFinalizedBeforeConfigured.goal, 'Legal work after ignored illegal finalization', 'illegal Finalized replay must not install a terminal freeze that swallows later legal work');
  assert.equal(replayedFinalizedBeforeConfigured.status, 'ready');
  assert.equal(restartedProjects.getProject(project.projectId).projectId, project.projectId);

  const restartedAdapter = new FakeAdapter();
  restartedAdapter.forcedSessionId = workerA.adapterSessionId;
  const restartedManager = new WorkerSessionManager({ taskBindings: restartedTasks, newId: () => `restart-managed-${++managedId}` });
  await restartedManager.register(restartedAdapter);
  await assert.rejects(
    () => restartedManager.createSession('worker.fake', {}, missionB.taskId),
    /Adapter session is retired and cannot be reused/,
    'durable Task replay must prevent a retired provider-native conversation from being rebound after process restart',
  );
  restartedAdapter.forcedSessionId = escapedWorker.adapterSessionId;
  await assert.rejects(
    () => restartedManager.createSession('worker.fake', {}, missionB.taskId),
    /Adapter session is retired and cannot be reused/,
    'an unbound-but-live Worker retired at Mission death must stay retired after replay',
  );
  restartedAdapter.forcedSessionId = freshOriginal.adapterSessionId;
  await assert.rejects(
    () => restartedManager.createSession('worker.fake', {}, missionB.taskId),
    /Adapter session is retired and cannot be reused/,
    'a provider-native identity retired through a pre-finalization fresh wrapper must stay retired after replay',
  );
  restartedAdapter.forcedSessionId = raceOriginal.adapterSessionId;
  await assert.rejects(
    () => restartedManager.createSession('worker.fake', {}, missionB.taskId),
    /Adapter session is retired and cannot be reused/,
    'a provider-native identity closed through the create/finalize race must stay retired after replay',
  );
  restartedAdapter.forcedSessionId = strictOriginal.adapterSessionId;
  await assert.rejects(
    () => restartedManager.createSession('worker.fake', {}, strictTargetMission.taskId),
    /Adapter session is retired and cannot be reused/,
    'cross-Mission bookkeeping failure must not resurrect the old provider-native identity after replay',
  );

  const blocked = new TaskRuntime({ storageDirectory: blockedDirectory });
  await blocked.initialize();
  const blockedMission = await blocked.ensureTask({ kind: 'bridge', key: 'blocked-finalize' }, 'Fail closed on finalization persistence');
  await blocked.configureMission(blockedMission.taskId, {
    projectId: 'blocked-project',
    rootMissionId: blockedMission.taskId,
    plane: 'practice',
    missionType: 'blocked-finalize',
    completionCriteria: ['Do not become completed without durable write'],
  });
  await fs.rm(blockedDirectory, { recursive: true, force: true });
  await fs.writeFile(blockedDirectory, 'block strict journal append', 'utf8');
  await assert.rejects(() => blocked.finalizeMissionStrict(blockedMission.taskId, { handoffRequired: false }), /Strict task persistence failed/);
  assert.equal(blocked.getTask(blockedMission.taskId).missionFinalization, undefined);
  assert.notEqual(blocked.getTask(blockedMission.taskId).status, 'completed');

  console.log('[smoke] Mission finalization + provider-native retirement barrier + required Handoff + recovery/replay ok');
} finally {
  await Promise.all([
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(projectDirectory, { recursive: true, force: true }),
    fs.rm(blockedDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
