import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-mission-tasks-'));
const projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-project-store-'));
const blockedProjectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-project-store-blocked-'));
const blockedTaskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-mission-task-blocked-'));
const terminalTaskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-mission-terminal-admission-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-project-mission-bundle-'));
const bundlePath = path.join(bundleDirectory, 'project-mission-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { ProjectStore } from './src/project-store.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
    `,
    resolveDir: root,
    sourcefile: 'project-mission-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});

const { ProjectStore, TaskRuntime } = require(bundlePath);

let taskId = 0;
const newTaskId = () => `task-id-${++taskId}`;
let projectId = 0;
const newProjectId = () => `project-id-${++projectId}`;
let tick = 0;
const now = () => new Date(Date.UTC(2026, 8, 13, 12, 0, tick++));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const legacyEvent = {
  version: 1,
  eventId: 'legacy-created',
  taskId: 'legacy-task',
  at: '2026-09-12T00:00:00.000Z',
  type: 'TaskCreated',
  payload: {
    source: { kind: 'bridge', key: 'pre-phase1-session', workspace: '/legacy-workspace' },
    goal: 'Pre-Phase1 task',
  },
};
const legacyJournal = path.join(taskDirectory, 'legacy-task.jsonl');
const legacyJournalText = `${JSON.stringify(legacyEvent)}\n`;

try {
  await fs.writeFile(legacyJournal, legacyJournalText, 'utf8');

  const runtime = new TaskRuntime({ storageDirectory: taskDirectory, newId: newTaskId, now });
  await runtime.initialize();
  assert.equal(runtime.getTask('legacy-task')?.mission, undefined, 'pre-Phase1 Task journals must replay with mission undefined');
  assert.equal(await fs.readFile(legacyJournal, 'utf8'), legacyJournalText, 'Task startup must not rewrite or migrate a legacy journal');

  const projects = new ProjectStore({ storageDirectory: projectDirectory, newId: newProjectId, now });
  await projects.initialize();
  const project = await projects.createProject({
    title: ' Nimora Mission Work ',
    goal: 'Persist Project identity without a second runtime',
    workspace: ' /workspace/nimora ',
  });
  assert.equal(project.projectId, 'project-id-1');
  assert.equal(project.title, 'Nimora Mission Work');
  assert.equal(project.workspace, '/workspace/nimora');
  assert.deepEqual(projects.getProject(project.projectId), project, 'Project get must return the durable snapshot');
  assert.deepEqual(projects.listProjects(), [project], 'Project list must expose the created Project');
  assert.equal('missionIds' in project, false, 'Project snapshot must not duplicate Project→Mission membership');
  assert.equal(JSON.parse(JSON.stringify(project)).projectId, project.projectId, 'Project identity must survive serialization');

  const rootTask = await runtime.ensureTask({ kind: 'bridge', key: 'mission-root' }, 'Root Mission');
  assert.equal(rootTask.mission, undefined, 'new Tasks remain legacy-compatible until explicitly missionized');
  const rootMission = {
    projectId: project.projectId,
    rootMissionId: rootTask.taskId,
    plane: 'coordination',
    missionType: 'root-coordination',
    completionCriteria: ['Phase 1 contract is durable', 'Regression baseline passes'],
  };
  const configuredRoot = await runtime.configureMission(rootTask.taskId, rootMission);
  assert.deepEqual(configuredRoot.mission, rootMission);
  assert.equal(configuredRoot.mission?.rootMissionId, configuredRoot.taskId, 'root Mission identity must equal its Task id');
  assert.equal(configuredRoot.mission?.parentMissionId, undefined, 'root Mission must have no parent');

  const rootJournal = path.join(taskDirectory, `${rootTask.taskId}.jsonl`);
  const rootLinesAfterFirstConfig = (await fs.readFile(rootJournal, 'utf8')).trim().split(/\r?\n/);
  const createdEvent = JSON.parse(rootLinesAfterFirstConfig[0]);
  assert.equal(createdEvent.type, 'TaskCreated');
  assert.equal('mission' in createdEvent.payload, false, 'TaskCreated payload must remain unchanged');
  assert.equal(rootLinesAfterFirstConfig.filter(line => JSON.parse(line).type === 'TaskMissionConfigured').length, 1);
  const configuredEventCount = configuredRoot.eventCount;
  const idempotentRoot = await runtime.configureMission(rootTask.taskId, rootMission);
  assert.equal(idempotentRoot.eventCount, configuredEventCount, 'same Mission metadata must be idempotent without another event');
  assert.equal((await fs.readFile(rootJournal, 'utf8')).trim().split(/\r?\n/).length, rootLinesAfterFirstConfig.length);
  await assert.rejects(
    () => runtime.configureMission(rootTask.taskId, { ...rootMission, missionType: 'conflicting-reconfiguration' }),
    /already configured as a different Mission/,
    'Mission identity is one-time and conflicting reconfiguration must fail',
  );

  const childTask = await runtime.ensureTask({ kind: 'native-chat', key: 'mission-child' }, 'Child Mission');
  const childMission = {
    projectId: project.projectId,
    rootMissionId: rootTask.taskId,
    parentMissionId: rootTask.taskId,
    plane: 'practice',
    missionType: 'implementation',
    completionCriteria: ['Implementation is verified'],
  };
  await assert.rejects(
    () => runtime.configureMission(childTask.taskId, { ...childMission, parentMissionId: undefined }),
    /Child Mission requires parentMissionId/,
  );
  const configuredChild = await runtime.configureMission(childTask.taskId, childMission);
  assert.deepEqual(configuredChild.mission, childMission);
  assert.equal(configuredChild.mission?.rootMissionId, rootTask.taskId);
  assert.equal(configuredChild.mission?.parentMissionId, rootTask.taskId);

  const invalidTask = await runtime.ensureTask({ kind: 'bridge', key: 'mission-validation' }, 'Validation Mission');
  const validSelfRoot = {
    projectId: 'validation-project',
    rootMissionId: invalidTask.taskId,
    plane: 'cognition',
    missionType: 'x'.repeat(160),
    completionCriteria: ['y'.repeat(1_000)],
  };
  await assert.rejects(
    () => runtime.configureMission(invalidTask.taskId, { ...validSelfRoot, plane: 'invalid-plane' }),
    /Unsupported Mission plane/,
  );
  await assert.rejects(
    () => runtime.configureMission(invalidTask.taskId, { ...validSelfRoot, missionType: 'x'.repeat(161) }),
    /Mission type must be at most 160 characters/,
  );
  await assert.rejects(
    () => runtime.configureMission(invalidTask.taskId, { ...validSelfRoot, completionCriteria: Array.from({ length: 33 }, (_, index) => `criterion-${index}`) }),
    /at most 32 items/,
  );
  await assert.rejects(
    () => runtime.configureMission(invalidTask.taskId, { ...validSelfRoot, completionCriteria: ['z'.repeat(1_001)] }),
    /at most 1000 characters/,
  );
  await assert.rejects(
    () => runtime.configureMission(invalidTask.taskId, { ...validSelfRoot, parentMissionId: rootTask.taskId }),
    /Root Mission must not have parentMissionId/,
  );
  assert.equal(runtime.getTask(invalidTask.taskId)?.mission, undefined, 'invalid Mission configuration must not mutate live Task state');
  const boundedMission = await runtime.configureMission(invalidTask.taskId, validSelfRoot);
  assert.equal(boundedMission.mission?.missionType.length, 160, 'missionType maximum bound must be accepted');
  assert.equal(boundedMission.mission?.completionCriteria[0]?.length, 1_000, 'completion criterion maximum bound must be accepted');

  const strictAttachTask = await runtime.ensureTask({ kind: 'bridge', key: 'mission-strict-attach' }, 'Strict attach Mission');
  await runtime.configureMission(strictAttachTask.taskId, {
    projectId: project.projectId,
    rootMissionId: strictAttachTask.taskId,
    plane: 'practice',
    missionType: 'strict-worker-ownership',
    completionCriteria: ['Worker ownership is durable'],
  });
  const strictAttachJournal = path.join(taskDirectory, `${strictAttachTask.taskId}.jsonl`);
  const strictAttachJournalText = await fs.readFile(strictAttachJournal, 'utf8');
  await fs.rm(strictAttachJournal, { force: true });
  await fs.mkdir(strictAttachJournal);
  try {
    await assert.rejects(
      () => runtime.attachWorkerSession(strictAttachTask.taskId, {
        managedSessionId: 'strict-attach-worker',
        workerId: 'worker.strict',
        adapterSessionId: 'provider-strict',
      }),
      /Strict task persistence failed for TaskWorkerAttached/,
      'attach-after-Mission-config must fail closed instead of creating memory-only ownership',
    );
  } finally {
    await fs.rm(strictAttachJournal, { recursive: true, force: true });
    await fs.writeFile(strictAttachJournal, strictAttachJournalText, 'utf8');
  }
  assert.equal(runtime.getTask(strictAttachTask.taskId)?.workerSessions['strict-attach-worker'], undefined);

  const adoptTask = await runtime.ensureTask({ kind: 'bridge', key: 'mission-adopt-worker' }, 'Adopt legacy Worker ownership');
  const adoptJournal = path.join(taskDirectory, `${adoptTask.taskId}.jsonl`);
  const adoptJournalBeforeAttach = await fs.readFile(adoptJournal, 'utf8');
  await fs.rm(adoptJournal, { force: true });
  await fs.mkdir(adoptJournal);
  await runtime.attachWorkerSession(adoptTask.taskId, {
    managedSessionId: 'legacy-memory-worker',
    workerId: 'worker.legacy',
    adapterSessionId: 'provider-legacy-owned',
    model: 'legacy-model',
  });
  assert.equal(runtime.getTask(adoptTask.taskId)?.workerSessions['legacy-memory-worker']?.adapterSessionId, 'provider-legacy-owned', 'legacy fail-open path intentionally creates the memory-only precondition');
  await fs.rm(adoptJournal, { recursive: true, force: true });
  await fs.writeFile(adoptJournal, adoptJournalBeforeAttach, 'utf8');
  await runtime.configureMission(adoptTask.taskId, {
    projectId: project.projectId,
    rootMissionId: adoptTask.taskId,
    plane: 'practice',
    missionType: 'legacy-worker-adoption',
    completionCriteria: ['Pre-Mission Worker ownership is adopted durably'],
  });

  const wrongProjectChild = await runtime.ensureTask({ kind: 'bridge', key: 'wrong-project-child' }, 'Wrong Project child');
  await assert.rejects(
    () => runtime.configureMission(wrongProjectChild.taskId, {
      ...childMission,
      projectId: 'other-project',
      rootMissionId: rootTask.taskId,
      parentMissionId: rootTask.taskId,
    }),
    /same Project root|same Project\/root/,
    'child Mission must remain inside the configured root/parent Project chain',
  );

  // TaskRuntime owns Mission membership/lifecycle admission. A new child cannot
  // be configured below a terminal root or parent, while an identical Mission
  // that was configured before the owner became terminal remains an idempotent
  // read. This must survive replay without changing legacy Task behavior.
  let terminalTaskId = 0;
  const terminalRuntime = new TaskRuntime({
    storageDirectory: terminalTaskDirectory,
    newId: () => `terminal-task-${++terminalTaskId}`,
    now,
  });
  await terminalRuntime.initialize();
  const terminalRootTask = await terminalRuntime.ensureTask({ kind: 'mission', key: 'terminal-root' }, 'Terminal root');
  const terminalRootMission = {
    projectId: 'terminal-project',
    rootMissionId: terminalRootTask.taskId,
    plane: 'coordination',
    missionType: 'terminal-root',
    completionCriteria: ['Root lifecycle admission is enforced'],
  };
  await terminalRuntime.configureMission(terminalRootTask.taskId, terminalRootMission);
  const existingTerminalChildTask = await terminalRuntime.ensureTask({ kind: 'mission', key: 'existing-terminal-child' }, 'Existing child');
  const existingTerminalChildMission = {
    projectId: 'terminal-project',
    rootMissionId: terminalRootTask.taskId,
    parentMissionId: terminalRootTask.taskId,
    plane: 'practice',
    missionType: 'existing-child',
    completionCriteria: ['Existing Mission identity remains readable'],
  };
  const existingTerminalChild = await terminalRuntime.configureMission(existingTerminalChildTask.taskId, existingTerminalChildMission);
  await terminalRuntime.finalizeMissionStrict(terminalRootTask.taskId, { handoffRequired: false });
  await terminalRuntime.archiveMissionStrict(terminalRootTask.taskId);

  const rootBlockedChildTask = await terminalRuntime.ensureTask({ kind: 'mission', key: 'root-blocked-child' }, 'Must not configure');
  await assert.rejects(
    () => terminalRuntime.configureMission(rootBlockedChildTask.taskId, {
      ...existingTerminalChildMission,
      missionType: 'root-blocked-child',
      completionCriteria: ['Must remain unconfigured below an archived root'],
    }),
    /Root Mission .* is terminal \(archived\).*cannot accept a new child Mission/,
    'direct TaskRuntime path must reject a new child below an archived root',
  );
  assert.equal(terminalRuntime.getTask(rootBlockedChildTask.taskId)?.mission, undefined);
  const terminalChildReread = await terminalRuntime.configureMission(existingTerminalChildTask.taskId, existingTerminalChildMission);
  assert.equal(terminalChildReread.eventCount, existingTerminalChild.eventCount, 'pre-existing identical child remains idempotently readable after root finalization');

  const parentRootTask = await terminalRuntime.ensureTask({ kind: 'mission', key: 'parent-terminal-root' }, 'Parent terminal root');
  await terminalRuntime.configureMission(parentRootTask.taskId, {
    projectId: 'terminal-project',
    rootMissionId: parentRootTask.taskId,
    plane: 'coordination',
    missionType: 'parent-terminal-root',
    completionCriteria: ['Parent-specific lifecycle case is exercised'],
  });
  const terminalParentTask = await terminalRuntime.ensureTask({ kind: 'mission', key: 'terminal-parent' }, 'Terminal parent');
  await terminalRuntime.configureMission(terminalParentTask.taskId, {
    projectId: 'terminal-project',
    rootMissionId: parentRootTask.taskId,
    parentMissionId: parentRootTask.taskId,
    plane: 'cognition',
    missionType: 'terminal-parent',
    completionCriteria: ['Parent reaches terminal state'],
  });
  await terminalRuntime.finalizeMissionStrict(terminalParentTask.taskId, { handoffRequired: false });
  const parentBlockedGrandchildTask = await terminalRuntime.ensureTask({ kind: 'mission', key: 'parent-blocked-grandchild' }, 'Must not configure');
  await assert.rejects(
    () => terminalRuntime.configureMission(parentBlockedGrandchildTask.taskId, {
      projectId: 'terminal-project',
      rootMissionId: parentRootTask.taskId,
      parentMissionId: terminalParentTask.taskId,
      plane: 'practice',
      missionType: 'parent-blocked-grandchild',
      completionCriteria: ['Must remain unconfigured below a finalized parent'],
    }),
    /Parent Mission .* is terminal \(completed\).*cannot accept a new child Mission/,
    'direct TaskRuntime path must reject a new child below a finalized parent',
  );
  assert.equal(terminalRuntime.getTask(parentBlockedGrandchildTask.taskId)?.mission, undefined);

  // Deterministic root finalization-wins race. Pause the child before it enters
  // the multi-Mission admission boundary, let root stabilization close admission,
  // then release the already-started child. It must observe the fence and reject.
  const rootRaceFinalizationWins = await terminalRuntime.ensureTask({ kind: 'mission', key: 'race-root-finalization-wins' }, 'Root race finalization wins');
  await terminalRuntime.configureMission(rootRaceFinalizationWins.taskId, {
    projectId: 'terminal-project',
    rootMissionId: rootRaceFinalizationWins.taskId,
    plane: 'coordination',
    missionType: 'race-root-finalization-wins',
    completionCriteria: ['Finalization closes child admission linearly'],
  });
  const rootRaceBlockedChild = await terminalRuntime.ensureTask({ kind: 'mission', key: 'race-root-finalization-wins-child' }, 'Late child must reject');
  const rootRaceBlockedMetadata = {
    projectId: 'terminal-project',
    rootMissionId: rootRaceFinalizationWins.taskId,
    parentMissionId: rootRaceFinalizationWins.taskId,
    plane: 'practice',
    missionType: 'race-root-blocked-child',
    completionCriteria: ['Must never become configured after finalization wins'],
  };
  {
    const admissionObserved = deferred();
    const admissionRelease = deferred();
    const finalizationFenceObserved = deferred();
    const finalizationRelease = deferred();
    const originalExclusiveTasks = terminalRuntime.exclusiveTasks;
    let interceptAdmission = true;
    terminalRuntime.exclusiveTasks = async (taskIds, operation) => {
      if (interceptAdmission && taskIds.includes(rootRaceBlockedChild.taskId)) {
        interceptAdmission = false;
        admissionObserved.resolve([...taskIds]);
        await admissionRelease.promise;
      }
      return originalExclusiveTasks.call(terminalRuntime, taskIds, operation);
    };
    try {
      const childPromise = terminalRuntime.configureMission(rootRaceBlockedChild.taskId, rootRaceBlockedMetadata);
      const requestedLanes = await admissionObserved.promise;
      assert.equal(new Set(requestedLanes).size, 2, 'root==parent race requests child + one owner identity before deduped acquisition');
      const finalizationPromise = terminalRuntime.withMissionFinalizationStabilization(rootRaceFinalizationWins.taskId, async () => {
        finalizationFenceObserved.resolve();
        await finalizationRelease.promise;
        return terminalRuntime.finalizeMissionStrict(rootRaceFinalizationWins.taskId, { handoffRequired: false });
      });
      await finalizationFenceObserved.promise;
      admissionRelease.resolve();
      await assert.rejects(
        () => childPromise,
        /Root Mission .* is finalizing and cannot accept a new child Mission/,
        'root finalization fence must win against an already-started but not-admitted child',
      );
      assert.equal(terminalRuntime.getTask(rootRaceBlockedChild.taskId)?.mission, undefined);
      finalizationRelease.resolve();
      const finalizedRoot = await finalizationPromise;
      assert.equal(finalizedRoot.missionFinalization?.state, 'completed');
    } finally {
      admissionRelease.resolve();
      finalizationRelease.resolve();
      terminalRuntime.exclusiveTasks = originalExclusiveTasks;
    }
  }

  // Deterministic root child-wins race. Pause exactly at TaskMissionConfigured
  // while the child/root admission lanes are already held. A concurrent root
  // finalizer must queue until the durable child write releases those lanes.
  const rootRaceChildWins = await terminalRuntime.ensureTask({ kind: 'mission', key: 'race-root-child-wins' }, 'Root race child wins');
  await terminalRuntime.configureMission(rootRaceChildWins.taskId, {
    projectId: 'terminal-project',
    rootMissionId: rootRaceChildWins.taskId,
    plane: 'coordination',
    missionType: 'race-root-child-wins',
    completionCriteria: ['Durable child birth may precede later root finalization'],
  });
  const rootRaceWinningChild = await terminalRuntime.ensureTask({ kind: 'mission', key: 'race-root-child-wins-child' }, 'Child wins root race');
  const rootRaceWinningMetadata = {
    projectId: 'terminal-project',
    rootMissionId: rootRaceChildWins.taskId,
    parentMissionId: rootRaceChildWins.taskId,
    plane: 'practice',
    missionType: 'race-root-winning-child',
    completionCriteria: ['Durable before root finalization boundary'],
  };
  let rootRaceWinningConfigured;
  {
    const appendObserved = deferred();
    const appendRelease = deferred();
    const finalizationAttempted = deferred();
    const originalAppend = terminalRuntime.append;
    const originalExclusive = terminalRuntime.exclusive;
    let interceptAppend = true;
    let phase = 'child';
    const childLaneAcquisitions = [];
    terminalRuntime.append = async (taskId, type, payload, strictPersistence) => {
      if (interceptAppend && taskId === rootRaceWinningChild.taskId && type === 'TaskMissionConfigured') {
        interceptAppend = false;
        appendObserved.resolve();
        await appendRelease.promise;
      }
      return originalAppend.call(terminalRuntime, taskId, type, payload, strictPersistence);
    };
    terminalRuntime.exclusive = async (taskId, operation) => {
      if (phase === 'child') childLaneAcquisitions.push(taskId);
      if (phase === 'finalization' && taskId === rootRaceChildWins.taskId) finalizationAttempted.resolve();
      return originalExclusive.call(terminalRuntime, taskId, operation);
    };
    try {
      const childPromise = terminalRuntime.configureMission(rootRaceWinningChild.taskId, rootRaceWinningMetadata);
      await appendObserved.promise;
      assert.equal(childLaneAcquisitions.filter(id => id === rootRaceChildWins.taskId).length, 1, 'root==parent must acquire its owner lane exactly once');
      assert.equal(childLaneAcquisitions.filter(id => id === rootRaceWinningChild.taskId).length, 1, 'child lane must be acquired exactly once');
      phase = 'finalization';
      const finalizationPromise = terminalRuntime.withMissionFinalizationStabilization(
        rootRaceChildWins.taskId,
        () => terminalRuntime.finalizeMissionStrict(rootRaceChildWins.taskId, { handoffRequired: false }),
      );
      await finalizationAttempted.promise;
      assert.equal(terminalRuntime.getTask(rootRaceChildWins.taskId)?.missionFinalization, undefined, 'root finalization cannot cross while child owns admission lanes');
      appendRelease.resolve();
      rootRaceWinningConfigured = await childPromise;
      const finalizedRoot = await finalizationPromise;
      assert.equal(finalizedRoot.missionFinalization?.state, 'completed');
      assert.deepEqual(terminalRuntime.getTask(rootRaceWinningChild.taskId)?.mission, rootRaceWinningMetadata);
    } finally {
      appendRelease.resolve();
      terminalRuntime.append = originalAppend;
      terminalRuntime.exclusive = originalExclusive;
    }
  }

  // Distinct-parent finalization-wins ordering: root stays active while a
  // non-root parent closes its own child-admission boundary first.
  const parentRaceRootFinalizationWins = await terminalRuntime.ensureTask({ kind: 'mission', key: 'race-parent-fw-root' }, 'Distinct parent race root');
  await terminalRuntime.configureMission(parentRaceRootFinalizationWins.taskId, {
    projectId: 'terminal-project',
    rootMissionId: parentRaceRootFinalizationWins.taskId,
    plane: 'coordination',
    missionType: 'race-parent-fw-root',
    completionCriteria: ['Root remains active during parent race'],
  });
  const parentRaceFinalizationWins = await terminalRuntime.ensureTask({ kind: 'mission', key: 'race-parent-finalization-wins' }, 'Distinct parent finalization wins');
  await terminalRuntime.configureMission(parentRaceFinalizationWins.taskId, {
    projectId: 'terminal-project',
    rootMissionId: parentRaceRootFinalizationWins.taskId,
    parentMissionId: parentRaceRootFinalizationWins.taskId,
    plane: 'cognition',
    missionType: 'race-parent-finalization-wins',
    completionCriteria: ['Parent finalization closes only its descendant admission'],
  });
  const parentRaceBlockedGrandchild = await terminalRuntime.ensureTask({ kind: 'mission', key: 'race-parent-finalization-wins-grandchild' }, 'Late grandchild must reject');
  const parentRaceBlockedMetadata = {
    projectId: 'terminal-project',
    rootMissionId: parentRaceRootFinalizationWins.taskId,
    parentMissionId: parentRaceFinalizationWins.taskId,
    plane: 'practice',
    missionType: 'race-parent-blocked-grandchild',
    completionCriteria: ['Must remain unconfigured after parent finalization wins'],
  };
  {
    const admissionObserved = deferred();
    const admissionRelease = deferred();
    const finalizationFenceObserved = deferred();
    const finalizationRelease = deferred();
    const originalExclusiveTasks = terminalRuntime.exclusiveTasks;
    let interceptAdmission = true;
    terminalRuntime.exclusiveTasks = async (taskIds, operation) => {
      if (interceptAdmission && taskIds.includes(parentRaceBlockedGrandchild.taskId)) {
        interceptAdmission = false;
        admissionObserved.resolve([...taskIds]);
        await admissionRelease.promise;
      }
      return originalExclusiveTasks.call(terminalRuntime, taskIds, operation);
    };
    try {
      const grandchildPromise = terminalRuntime.configureMission(parentRaceBlockedGrandchild.taskId, parentRaceBlockedMetadata);
      const requestedLanes = await admissionObserved.promise;
      assert.equal(new Set(requestedLanes).size, 3, 'distinct-parent race must coordinate child + root + parent identities');
      const finalizationPromise = terminalRuntime.withMissionFinalizationStabilization(parentRaceFinalizationWins.taskId, async () => {
        finalizationFenceObserved.resolve();
        await finalizationRelease.promise;
        return terminalRuntime.finalizeMissionStrict(parentRaceFinalizationWins.taskId, { handoffRequired: false });
      });
      await finalizationFenceObserved.promise;
      admissionRelease.resolve();
      await assert.rejects(
        () => grandchildPromise,
        /Parent Mission .* is finalizing and cannot accept a new child Mission/,
        'distinct parent finalization fence must reject an already-started late grandchild',
      );
      assert.equal(terminalRuntime.getTask(parentRaceBlockedGrandchild.taskId)?.mission, undefined);
      assert.equal(terminalRuntime.getTask(parentRaceRootFinalizationWins.taskId)?.missionFinalization, undefined, 'distinct parent race must not finalize the root');
      finalizationRelease.resolve();
      const finalizedParent = await finalizationPromise;
      assert.equal(finalizedParent.missionFinalization?.state, 'completed');
    } finally {
      admissionRelease.resolve();
      finalizationRelease.resolve();
      terminalRuntime.exclusiveTasks = originalExclusiveTasks;
    }
  }

  // Distinct-parent child-wins ordering: the grandchild holds root + parent +
  // child lanes through its durable append; parent finalization queues behind it.
  const parentRaceRootChildWins = await terminalRuntime.ensureTask({ kind: 'mission', key: 'race-parent-cw-root' }, 'Distinct parent child-wins root');
  await terminalRuntime.configureMission(parentRaceRootChildWins.taskId, {
    projectId: 'terminal-project',
    rootMissionId: parentRaceRootChildWins.taskId,
    plane: 'coordination',
    missionType: 'race-parent-cw-root',
    completionCriteria: ['Root remains active while grandchild wins'],
  });
  const parentRaceChildWins = await terminalRuntime.ensureTask({ kind: 'mission', key: 'race-parent-child-wins' }, 'Distinct parent child wins');
  await terminalRuntime.configureMission(parentRaceChildWins.taskId, {
    projectId: 'terminal-project',
    rootMissionId: parentRaceRootChildWins.taskId,
    parentMissionId: parentRaceRootChildWins.taskId,
    plane: 'cognition',
    missionType: 'race-parent-child-wins',
    completionCriteria: ['Grandchild may become durable before parent finalization'],
  });
  const parentRaceWinningGrandchild = await terminalRuntime.ensureTask({ kind: 'mission', key: 'race-parent-child-wins-grandchild' }, 'Grandchild wins parent race');
  const parentRaceWinningMetadata = {
    projectId: 'terminal-project',
    rootMissionId: parentRaceRootChildWins.taskId,
    parentMissionId: parentRaceChildWins.taskId,
    plane: 'practice',
    missionType: 'race-parent-winning-grandchild',
    completionCriteria: ['Durable before parent finalization boundary'],
  };
  let parentRaceWinningConfigured;
  {
    const appendObserved = deferred();
    const appendRelease = deferred();
    const finalizationAttempted = deferred();
    const originalAppend = terminalRuntime.append;
    const originalExclusive = terminalRuntime.exclusive;
    let interceptAppend = true;
    let phase = 'child';
    const childLaneAcquisitions = [];
    terminalRuntime.append = async (taskId, type, payload, strictPersistence) => {
      if (interceptAppend && taskId === parentRaceWinningGrandchild.taskId && type === 'TaskMissionConfigured') {
        interceptAppend = false;
        appendObserved.resolve();
        await appendRelease.promise;
      }
      return originalAppend.call(terminalRuntime, taskId, type, payload, strictPersistence);
    };
    terminalRuntime.exclusive = async (taskId, operation) => {
      if (phase === 'child') childLaneAcquisitions.push(taskId);
      if (phase === 'finalization' && taskId === parentRaceChildWins.taskId) finalizationAttempted.resolve();
      return originalExclusive.call(terminalRuntime, taskId, operation);
    };
    try {
      const grandchildPromise = terminalRuntime.configureMission(parentRaceWinningGrandchild.taskId, parentRaceWinningMetadata);
      await appendObserved.promise;
      assert.deepEqual(
        [...new Set(childLaneAcquisitions)].sort(),
        [parentRaceWinningGrandchild.taskId, parentRaceRootChildWins.taskId, parentRaceChildWins.taskId].sort(),
        'distinct parent child admission must acquire exactly the child/root/parent lanes',
      );
      assert.equal(childLaneAcquisitions.length, 3, 'distinct parent child admission must not duplicate any lane acquisition');
      phase = 'finalization';
      const finalizationPromise = terminalRuntime.withMissionFinalizationStabilization(
        parentRaceChildWins.taskId,
        () => terminalRuntime.finalizeMissionStrict(parentRaceChildWins.taskId, { handoffRequired: false }),
      );
      await finalizationAttempted.promise;
      assert.equal(terminalRuntime.getTask(parentRaceChildWins.taskId)?.missionFinalization, undefined, 'parent finalization cannot cross while grandchild owns admission lanes');
      appendRelease.resolve();
      parentRaceWinningConfigured = await grandchildPromise;
      const finalizedParent = await finalizationPromise;
      assert.equal(finalizedParent.missionFinalization?.state, 'completed');
      assert.deepEqual(terminalRuntime.getTask(parentRaceWinningGrandchild.taskId)?.mission, parentRaceWinningMetadata);
      assert.equal(terminalRuntime.getTask(parentRaceRootChildWins.taskId)?.missionFinalization, undefined);
    } finally {
      appendRelease.resolve();
      terminalRuntime.append = originalAppend;
      terminalRuntime.exclusive = originalExclusive;
    }
  }

  // Concurrent identical retry while the first configure owns all admission
  // lanes must queue and converge on the same single durable configuration.
  const retryRoot = await terminalRuntime.ensureTask({ kind: 'mission', key: 'race-identical-retry-root' }, 'Concurrent retry root');
  await terminalRuntime.configureMission(retryRoot.taskId, {
    projectId: 'terminal-project',
    rootMissionId: retryRoot.taskId,
    plane: 'coordination',
    missionType: 'race-identical-retry-root',
    completionCriteria: ['Concurrent identical child retry converges'],
  });
  const retryChild = await terminalRuntime.ensureTask({ kind: 'mission', key: 'race-identical-retry-child' }, 'Concurrent retry child');
  const retryMetadata = {
    projectId: 'terminal-project',
    rootMissionId: retryRoot.taskId,
    parentMissionId: retryRoot.taskId,
    plane: 'practice',
    missionType: 'race-identical-retry-child',
    completionCriteria: ['One durable TaskMissionConfigured event only'],
  };
  {
    const appendObserved = deferred();
    const appendRelease = deferred();
    const secondAttemptObserved = deferred();
    const originalAppend = terminalRuntime.append;
    const originalExclusiveTasks = terminalRuntime.exclusiveTasks;
    let interceptAppend = true;
    let admissionAttempts = 0;
    terminalRuntime.append = async (taskId, type, payload, strictPersistence) => {
      if (interceptAppend && taskId === retryChild.taskId && type === 'TaskMissionConfigured') {
        interceptAppend = false;
        appendObserved.resolve();
        await appendRelease.promise;
      }
      return originalAppend.call(terminalRuntime, taskId, type, payload, strictPersistence);
    };
    terminalRuntime.exclusiveTasks = async (taskIds, operation) => {
      if (taskIds.includes(retryChild.taskId)) {
        admissionAttempts += 1;
        if (admissionAttempts === 2) secondAttemptObserved.resolve();
      }
      return originalExclusiveTasks.call(terminalRuntime, taskIds, operation);
    };
    try {
      const firstRetry = terminalRuntime.configureMission(retryChild.taskId, retryMetadata);
      await appendObserved.promise;
      const secondRetry = terminalRuntime.configureMission(retryChild.taskId, retryMetadata);
      await secondAttemptObserved.promise;
      appendRelease.resolve();
      const [firstConfigured, secondConfigured] = await Promise.all([firstRetry, secondRetry]);
      assert.equal(firstConfigured.taskId, retryChild.taskId);
      assert.equal(secondConfigured.taskId, retryChild.taskId);
      assert.equal(firstConfigured.eventCount, secondConfigured.eventCount, 'identical concurrent retry must converge after the first durable configure');
      const retryJournal = await fs.readFile(path.join(terminalTaskDirectory, `${retryChild.taskId}.jsonl`), 'utf8');
      assert.equal(
        retryJournal.trim().split(/\r?\n/).filter(line => JSON.parse(line).type === 'TaskMissionConfigured').length,
        1,
        'concurrent identical retry must persist exactly one TaskMissionConfigured event',
      );
    } finally {
      appendRelease.resolve();
      terminalRuntime.append = originalAppend;
      terminalRuntime.exclusiveTasks = originalExclusiveTasks;
    }
  }
  await terminalRuntime.flush();

  let replayTerminalTaskId = 0;
  const replayedTerminalRuntime = new TaskRuntime({
    storageDirectory: terminalTaskDirectory,
    newId: () => `replay-terminal-task-${++replayTerminalTaskId}`,
    now,
  });
  await replayedTerminalRuntime.initialize();
  const replayRootBlockedTask = await replayedTerminalRuntime.ensureTask({ kind: 'mission', key: 'replay-root-blocked-child' }, 'Replay root reject');
  await assert.rejects(
    () => replayedTerminalRuntime.configureMission(replayRootBlockedTask.taskId, {
      ...existingTerminalChildMission,
      missionType: 'replay-root-blocked-child',
      completionCriteria: ['Replay must preserve archived-root admission'],
    }),
    /Root Mission .* is terminal \(archived\)/,
    'restart/replay must preserve archived-root child admission rejection',
  );
  const replayParentBlockedTask = await replayedTerminalRuntime.ensureTask({ kind: 'mission', key: 'replay-parent-blocked-child' }, 'Replay parent reject');
  await assert.rejects(
    () => replayedTerminalRuntime.configureMission(replayParentBlockedTask.taskId, {
      projectId: 'terminal-project',
      rootMissionId: parentRootTask.taskId,
      parentMissionId: terminalParentTask.taskId,
      plane: 'practice',
      missionType: 'replay-parent-blocked-child',
      completionCriteria: ['Replay must preserve finalized-parent admission'],
    }),
    /Parent Mission .* is terminal \(completed\)/,
    'restart/replay must preserve finalized-parent child admission rejection',
  );
  const replayedExistingTerminalChild = await replayedTerminalRuntime.configureMission(existingTerminalChildTask.taskId, existingTerminalChildMission);
  assert.deepEqual(replayedExistingTerminalChild.mission, existingTerminalChildMission);
  assert.equal(replayedExistingTerminalChild.eventCount, existingTerminalChild.eventCount, 'replay preserves legal idempotent reread below later-terminal root');
  const replayRaceRootBlockedTask = await replayedTerminalRuntime.ensureTask({ kind: 'mission', key: 'replay-race-root-blocked-child' }, 'Replay race root reject');
  await assert.rejects(
    () => replayedTerminalRuntime.configureMission(replayRaceRootBlockedTask.taskId, {
      ...rootRaceBlockedMetadata,
      missionType: 'replay-race-root-blocked-child',
      completionCriteria: ['Completed race root remains closed after replay'],
    }),
    /Root Mission .* is terminal \(completed\)/,
    'restart must preserve finalization-wins root admission closure',
  );
  const replayRaceParentBlockedTask = await replayedTerminalRuntime.ensureTask({ kind: 'mission', key: 'replay-race-parent-blocked-grandchild' }, 'Replay race parent reject');
  await assert.rejects(
    () => replayedTerminalRuntime.configureMission(replayRaceParentBlockedTask.taskId, {
      ...parentRaceBlockedMetadata,
      missionType: 'replay-race-parent-blocked-grandchild',
      completionCriteria: ['Completed distinct parent remains closed after replay'],
    }),
    /Parent Mission .* is terminal \(completed\)/,
    'restart must preserve finalization-wins distinct-parent admission closure',
  );
  const replayedRootRaceWinner = await replayedTerminalRuntime.configureMission(rootRaceWinningChild.taskId, rootRaceWinningMetadata);
  assert.deepEqual(replayedRootRaceWinner.mission, rootRaceWinningMetadata);
  assert.equal(replayedRootRaceWinner.eventCount, rootRaceWinningConfigured.eventCount, 'pre-existing root-race child remains idempotently rereadable after terminal root replay');
  const replayedParentRaceWinner = await replayedTerminalRuntime.configureMission(parentRaceWinningGrandchild.taskId, parentRaceWinningMetadata);
  assert.deepEqual(replayedParentRaceWinner.mission, parentRaceWinningMetadata);
  assert.equal(replayedParentRaceWinner.eventCount, parentRaceWinningConfigured.eventCount, 'pre-existing grandchild remains idempotently rereadable after terminal parent replay');

  await Promise.all([runtime.flush(), projects.flush()]);
  assert.equal(await fs.readFile(legacyJournal, 'utf8'), legacyJournalText, 'other Mission writes must not touch legacy Task journals');
  const projectJournal = path.join(projectDirectory, 'projects-v1.jsonl');
  const projectJournalText = await fs.readFile(projectJournal, 'utf8');
  assert.doesNotMatch(projectJournalText, /missionIds/, 'Project persistence must not store Mission membership');
  assert.equal(projectJournalText.trim().split(/\r?\n/).length, 1, 'Phase 1 Project persistence needs only ProjectCreated');

  await fs.appendFile(rootJournal, '{"version":1,"eventId":"torn-task"', 'utf8');
  await fs.appendFile(projectJournal, '{"version":1,"eventId":"torn-project"', 'utf8');

  const restartedRuntime = new TaskRuntime({ storageDirectory: taskDirectory });
  const restartedProjects = new ProjectStore({ storageDirectory: projectDirectory });
  await Promise.all([restartedRuntime.initialize(), restartedProjects.initialize()]);
  assert.deepEqual(restartedProjects.getProject(project.projectId), project, 'Project identity/metadata must survive restart and a torn tail');
  assert.equal(restartedRuntime.getTask('legacy-task')?.mission, undefined, 'legacy and Mission Tasks must coexist after restart');
  assert.deepEqual(restartedRuntime.getTask(rootTask.taskId)?.mission, rootMission, 'root Mission metadata must survive restart/replay');
  assert.deepEqual(restartedRuntime.getTask(childTask.taskId)?.mission, childMission, 'child Mission metadata must survive restart/replay');
  assert.equal(
    restartedRuntime.getTask(adoptTask.taskId)?.workerSessions['legacy-memory-worker']?.adapterSessionId,
    'provider-legacy-owned',
    'strict configureMission must durably adopt a pre-existing legacy/memory-only Worker ref',
  );
  const derivedProjectMissionIds = restartedRuntime.listTasks()
    .filter((task: any) => task.mission?.projectId === project.projectId)
    .map((task: any) => task.taskId)
    .sort();
  assert.deepEqual(
    derivedProjectMissionIds,
    [adoptTask.taskId, childTask.taskId, rootTask.taskId, strictAttachTask.taskId].sort(),
    'Project→Missions must derive only from Task snapshots',
  );
  assert.equal('missionIds' in restartedProjects.getProject(project.projectId), false);

  const blockedProjects = new ProjectStore({ storageDirectory: blockedProjectDirectory, newId: () => 'blocked-project' });
  await blockedProjects.initialize();
  await fs.rm(blockedProjectDirectory, { recursive: true, force: true });
  await fs.writeFile(blockedProjectDirectory, 'block Project persistence', 'utf8');
  await assert.rejects(
    () => blockedProjects.createProject({ title: 'Must not become live' }),
    /Project persistence failed/,
  );
  assert.equal(blockedProjects.listProjects().length, 0, 'Project-owned writes must fail closed');

  const blockedRuntime = new TaskRuntime({ storageDirectory: blockedTaskDirectory, newId: (() => {
    let id = 0;
    return () => `blocked-task-${++id}`;
  })() });
  await blockedRuntime.initialize();
  const blockedTask = await blockedRuntime.ensureTask({ kind: 'bridge', key: 'blocked-mission' }, 'Blocked Mission');
  await fs.rm(blockedTaskDirectory, { recursive: true, force: true });
  await fs.writeFile(blockedTaskDirectory, 'block Mission persistence', 'utf8');
  await assert.rejects(
    () => blockedRuntime.configureMission(blockedTask.taskId, {
      projectId: 'blocked-project',
      rootMissionId: blockedTask.taskId,
      plane: 'practice',
      missionType: 'blocked',
      completionCriteria: ['Must persist before becoming live'],
    }),
    /Strict task persistence failed for TaskMissionConfigured/,
  );
  assert.equal(blockedRuntime.getTask(blockedTask.taskId)?.mission, undefined, 'failed strict Mission persistence must not update live Task state');

  console.log('[smoke] ProjectStore + Task Mission metadata/replay/idempotency/source-of-truth contract ok');
} finally {
  await Promise.all([
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(projectDirectory, { recursive: true, force: true }),
    fs.rm(blockedProjectDirectory, { recursive: true, force: true }),
    fs.rm(blockedTaskDirectory, { recursive: true, force: true }),
    fs.rm(terminalTaskDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
