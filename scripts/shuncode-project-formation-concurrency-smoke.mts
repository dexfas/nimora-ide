import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-phase10-formation-concurrency-'));
const bundlePath = path.join(tempRoot, 'formation-concurrency.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { ProjectStore, PROJECT_JOURNAL } from './src/project-store.ts';
      export { buildProjectFormationReceipt } from './src/project-contract.ts';
      export { ProjectFormationService, projectFormationRootMetadata, projectFormationRootSource } from './src/project-formation-service.ts';
      export { ProjectRootOperationService, projectLaterRootSource } from './src/project-root-operation-service.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
      export { MissionCollaborationStore } from './src/mission-collaboration-store.ts';
      export { MissionFeedbackService } from './src/mission-feedback-service.ts';
      export { MissionCoordinatorService } from './src/mission-coordinator-service.ts';
    `,
    resolveDir: root,
    sourcefile: 'formation-concurrency-entry.ts',
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
  PROJECT_JOURNAL,
  buildProjectFormationReceipt,
  ProjectFormationService,
  projectFormationRootMetadata,
  projectFormationRootSource,
  ProjectRootOperationService,
  projectLaterRootSource,
  TaskRuntime,
  MissionCollaborationStore,
  MissionFeedbackService,
  MissionCoordinatorService,
} = require(bundlePath);

let tick = 0;
const now = () => new Date(Date.UTC(2026, 8, 18, 2, 0, tick++));

function idFactory(prefix) {
  let seq = 0;
  return () => `${prefix}-${++seq}`;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function directory(name) {
  const value = path.join(tempRoot, name);
  await fs.mkdir(value, { recursive: true });
  return value;
}

function receipt(formationId, overrides = {}) {
  return buildProjectFormationReceipt({
    formationId,
    project: {
      title: 'Concurrent Static Blog',
      goal: 'Deliver one bounded static blog.',
      workspace: '/workspace/concurrent-static-blog',
      ...(overrides.project ?? {}),
    },
    initialRoot: {
      goal: 'Implement and verify the bounded static blog.',
      plane: 'practice',
      missionType: 'automatic-project-root',
      completionCriteria: ['The bounded static blog is complete.', 'The bounded result is verified.'],
      contextSummary: 'Canonical concurrent Formation context.',
      constraints: ['No unrelated scope.', 'Use the canonical workspace only.'],
      ...(overrides.initialRoot ?? {}),
    },
    authorization: { kind: 'clear-intent-cognition', ...(overrides.authorization ?? {}) },
  });
}

async function coreEnvironment(name) {
  const projectsDirectory = await directory(`${name}-projects`);
  const tasksDirectory = await directory(`${name}-tasks`);
  const projects = new ProjectStore({ storageDirectory: projectsDirectory, newId: idFactory(`${name}-project`), now });
  const tasks = new TaskRuntime({ storageDirectory: tasksDirectory, newId: idFactory(`${name}-task`), now });
  return { projectsDirectory, tasksDirectory, projects, tasks };
}

async function laterEnvironment(name) {
  const env = await coreEnvironment(name);
  const collaborationDirectory = await directory(`${name}-collaboration`);
  const collaboration = new MissionCollaborationStore({
    storageDirectory: collaborationDirectory,
    projects: env.projects,
    tasks: env.tasks,
    newId: idFactory(`${name}-exchange`),
    now,
  });
  const feedback = new MissionFeedbackService(env.projects, env.tasks, collaboration);
  const coordinator = new MissionCoordinatorService(env.projects, env.tasks, collaboration, feedback);
  const laterRoots = new ProjectRootOperationService(env.projects, env.tasks, coordinator);
  return { ...env, collaborationDirectory, collaboration, feedback, coordinator, laterRoots };
}

async function projectEvents(projectsDirectory) {
  const raw = await fs.readFile(path.join(projectsDirectory, PROJECT_JOURNAL), 'utf8');
  return raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function taskEvents(tasksDirectory, taskId) {
  const raw = await fs.readFile(path.join(tasksDirectory, `${taskId}.jsonl`), 'utf8');
  return raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function count(events, type) {
  return events.filter(event => event.type === type).length;
}

function sourceMatches(task, source) {
  return task.source.kind === source.kind
    && task.source.key === source.key
    && task.source.workspace === source.workspace;
}

async function withRealTaskAppendUnknownOnce(tasksDirectory, eventType, observeBeforeThrow, operation) {
  const originalAppendFile = fs.appendFile.bind(fs);
  let injected = false;
  fs.appendFile = async (...args) => {
    const result = await originalAppendFile(...args);
    const [file, data] = args;
    if (!injected && path.dirname(path.resolve(String(file))) === path.resolve(tasksDirectory)) {
      let event;
      try { event = JSON.parse(String(data).trim()); } catch { event = undefined; }
      if (event?.type === eventType) {
        injected = true;
        observeBeforeThrow?.(event);
        throw new Error(`INJECTED_REAL_APPEND_UNKNOWN_${eventType}`);
      }
    }
    return result;
  };
  try {
    const value = await operation();
    assert.equal(injected, true, `must inject real append UNKNOWN for ${eventType}`);
    return value;
  } finally {
    fs.appendFile = originalAppendFile;
  }
}

function laterOperation(projectId, suffix = 'canonical') {
  return {
    rootOperationId: `later-root-${suffix}`,
    projectId,
    goal: 'Add one bounded synchronized-lyrics feature.',
    plane: 'practice',
    missionType: 'later-project-root',
    completionCriteria: ['The bounded synchronized-lyrics feature is implemented and verified.'],
    contextSummary: 'Canonical later-root context.',
    constraints: ['Keep the same Project identity.', 'Do not inherit provider transcript state.'],
  };
}

async function assertExactRootInitialization(tasksDirectory, taskId) {
  const events = await taskEvents(tasksDirectory, taskId);
  assert.equal(count(events, 'TaskCreated'), 1, `TaskCreated must be exact-once for ${taskId}`);
  assert.equal(count(events, 'TaskMissionConfigured'), 1, `TaskMissionConfigured must be exact-once for ${taskId}`);
  assert.equal(count(events, 'TaskContextUpdated'), 1, `TaskContextUpdated must be exact-once for ${taskId}`);
  return events;
}

try {
  // Mandatory deterministic stale-install interleaving. The first source scan
  // captures TaskCreated-only bytes, then an exact Task mutation advances the
  // durable + live Mission state before the source reread is allowed to proceed.
  // The repaired source primitive must acquire the exact Task lane and fresh
  // reread rather than install its captured old image.
  const barrierEnv = await coreEnvironment('barrier');
  await barrierEnv.tasks.initialize();
  const barrierSource = { kind: 'mission', key: 'barrier-source', workspace: '/workspace/barrier' };
  const barrierTask = await barrierEnv.tasks.ensureTask(barrierSource, 'Barrier-controlled stale install proof.');
  const barrierMission = {
    projectId: 'barrier-project',
    rootMissionId: barrierTask.taskId,
    plane: 'practice',
    missionType: 'barrier-proof',
    completionCriteria: ['Older source reread cannot regress newer exact Task mutation.'],
  };
  const barrierFile = path.resolve(barrierEnv.tasksDirectory, `${barrierTask.taskId}.jsonl`);
  const originalReadFile = fs.readFile.bind(fs);
  const olderReadCaptured = deferred();
  const releaseOlderRead = deferred();
  let targetReadCount = 0;
  fs.readFile = async (...args) => {
    if (path.resolve(String(args[0])) === barrierFile) {
      targetReadCount += 1;
      if (targetReadCount === 1) {
        const captured = await originalReadFile(...args);
        olderReadCaptured.resolve();
        await releaseOlderRead.promise;
        return captured;
      }
    }
    return originalReadFile(...args);
  };
  let barrierReread;
  try {
    const rereadPromise = barrierEnv.tasks.rereadTaskBySource(barrierSource);
    await olderReadCaptured.promise;
    const configured = await barrierEnv.tasks.configureMission(barrierTask.taskId, barrierMission);
    assert.deepEqual(configured.mission, barrierMission, 'exact Task mutation must advance live state while old source bytes are held');
    releaseOlderRead.resolve();
    barrierReread = await rereadPromise;
  } finally {
    releaseOlderRead.resolve();
    fs.readFile = originalReadFile;
  }
  assert.ok(targetReadCount >= 2, 'repaired source reread must perform a fresh exact-owner revalidation after lane acquisition');
  assert.deepEqual(barrierReread.mission, barrierMission, 'source reread must return fresh Mission state, not captured TaskCreated-only state');
  assert.deepEqual(barrierEnv.tasks.getTask(barrierTask.taskId).mission, barrierMission, 'older source reread must not regress live Task projection');
  assert.equal(count(await taskEvents(barrierEnv.tasksDirectory, barrierTask.taskId), 'TaskMissionConfigured'), 1);

  // Full Formation concurrency from empty canonical storage. Each fresh round
  // uses one exact receipt and one shared canonical owner pair; every caller must
  // fulfill with the same identities and exact durable initialization counts.
  const stressWidths = [2, 4, 8, 12, 16, 24, 24, 16, 12, 8, 24, 24];
  let stressCallerCount = 0;
  let restartFixture;
  for (let round = 0; round < stressWidths.length; round += 1) {
    const width = stressWidths[round];
    stressCallerCount += width;
    const env = await coreEnvironment(`formation-stress-${round + 1}`);
    const service = new ProjectFormationService(env.projects, env.tasks);
    const exactReceipt = receipt(`formation-stress-${round + 1}`);
    const results = await Promise.all(Array.from({ length: width }, () => service.ensureFormation(exactReceipt)));
    const projectIds = new Set(results.map(result => result.project.projectId));
    const rootIds = new Set(results.map(result => result.rootMission.taskId));
    assert.equal(projectIds.size, 1, `round ${round + 1}: all callers must converge to one Project`);
    assert.equal(rootIds.size, 1, `round ${round + 1}: all callers must converge to one root`);
    assert.equal((await projectEvents(env.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 1);
    await assertExactRootInitialization(env.tasksDirectory, results[0].rootMission.taskId);
    if (round === stressWidths.length - 1) restartFixture = { env, receipt: exactReceipt, result: results[0] };
  }
  assert.ok(restartFixture);

  const restartProjects = new ProjectStore({ storageDirectory: restartFixture.env.projectsDirectory, newId: idFactory('restart-project'), now });
  const restartTasks = new TaskRuntime({ storageDirectory: restartFixture.env.tasksDirectory, newId: idFactory('restart-task'), now });
  const restartFormation = new ProjectFormationService(restartProjects, restartTasks);
  const restartResult = await restartFormation.ensureFormation(restartFixture.receipt);
  assert.equal(restartResult.project.projectId, restartFixture.result.project.projectId);
  assert.equal(restartResult.rootMission.taskId, restartFixture.result.rootMission.taskId);
  assert.deepEqual(restartResult.rootMission.mission, restartFixture.result.rootMission.mission);
  assert.deepEqual(restartResult.rootMission.context, restartFixture.result.rootMission.context);
  assert.equal(restartTasks.listTasks().filter(task => sourceMatches(task, projectFormationRootSource(restartResult.project))).length, 1);
  await assertExactRootInitialization(restartFixture.env.tasksDirectory, restartResult.rootMission.taskId);

  // Mixed semantics concurrency: exact canonical caller wins the formationId
  // operation lane; changed semantics waits, then fails collision without any
  // duplicate Project/root/config/context durability.
  const mixedEnv = await coreEnvironment('mixed-semantics');
  await mixedEnv.projects.initialize();
  const canonicalReceipt = receipt('formation-mixed-semantics');
  const changedReceipt = receipt('formation-mixed-semantics', {
    initialRoot: { goal: 'Changed semantic competitor must never replace canonical Formation.' },
  });
  const originalProjectCommit = mixedEnv.projects.commit.bind(mixedEnv.projects);
  const canonicalCommitEntered = deferred();
  const releaseCanonicalCommit = deferred();
  let projectCommitCalls = 0;
  mixedEnv.projects.commit = async event => {
    projectCommitCalls += 1;
    if (projectCommitCalls === 1) {
      canonicalCommitEntered.resolve();
      await releaseCanonicalCommit.promise;
    }
    return originalProjectCommit(event);
  };
  const mixedService = new ProjectFormationService(mixedEnv.projects, mixedEnv.tasks);
  const canonicalPromise = mixedService.ensureFormation(canonicalReceipt);
  await canonicalCommitEntered.promise;
  const changedPromise = mixedService.ensureFormation(changedReceipt);
  releaseCanonicalCommit.resolve();
  const [canonicalSettled, changedSettled] = await Promise.allSettled([canonicalPromise, changedPromise]);
  assert.equal(canonicalSettled.status, 'fulfilled');
  assert.equal(changedSettled.status, 'rejected');
  assert.match(String(changedSettled.reason?.message ?? changedSettled.reason), /identity\/content collision/);
  assert.equal((await projectEvents(mixedEnv.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 1);
  await assertExactRootInitialization(mixedEnv.tasksDirectory, canonicalSettled.value.rootMission.taskId);
  assert.equal(mixedEnv.tasks.listTasks().filter(task => sourceMatches(task, projectFormationRootSource(canonicalSettled.value.project))).length, 1);

  // Same later-root operation concurrency uses the repaired TaskRuntime source
  // primitive. All callers converge on one later root + deterministic Coordinator.
  const laterEnv = await laterEnvironment('later-concurrent');
  const laterReceipt = receipt('later-concurrent-project');
  const laterProject = await laterEnv.projects.ensureProjectFormation(laterReceipt);
  const laterInput = laterOperation(laterProject.projectId, 'concurrent');
  const laterResults = await Promise.all(Array.from({ length: 24 }, () => laterEnv.laterRoots.ensureLaterRoot(laterInput)));
  assert.equal(new Set(laterResults.map(result => result.rootMission.taskId)).size, 1);
  assert.equal(new Set(laterResults.map(result => result.coordinatorMission.taskId)).size, 1);
  const laterRootId = laterResults[0].rootMission.taskId;
  await assertExactRootInitialization(laterEnv.tasksDirectory, laterRootId);
  assert.equal(laterEnv.tasks.listTasks().filter(task => sourceMatches(task, projectLaterRootSource(laterInput, laterProject.workspace))).length, 1);
  await assert.rejects(
    () => laterEnv.laterRoots.ensureLaterRoot({ ...laterInput, goal: 'Changed later-root semantics under same operation id.' }),
    /identity\/content collision/,
  );
  await assertExactRootInitialization(laterEnv.tasksDirectory, laterRootId);

  const laterRestartProjects = new ProjectStore({ storageDirectory: laterEnv.projectsDirectory, newId: idFactory('later-restart-project'), now });
  const laterRestartTasks = new TaskRuntime({ storageDirectory: laterEnv.tasksDirectory, newId: idFactory('later-restart-task'), now });
  const laterRestartCollaboration = new MissionCollaborationStore({
    storageDirectory: laterEnv.collaborationDirectory,
    projects: laterRestartProjects,
    tasks: laterRestartTasks,
    newId: idFactory('later-restart-exchange'),
    now,
  });
  const laterRestartFeedback = new MissionFeedbackService(laterRestartProjects, laterRestartTasks, laterRestartCollaboration);
  const laterRestartCoordinator = new MissionCoordinatorService(laterRestartProjects, laterRestartTasks, laterRestartCollaboration, laterRestartFeedback);
  const laterRestartService = new ProjectRootOperationService(laterRestartProjects, laterRestartTasks, laterRestartCoordinator);
  const laterRestart = await laterRestartService.ensureLaterRoot(laterInput);
  assert.equal(laterRestart.rootMission.taskId, laterResults[0].rootMission.taskId);
  assert.equal(laterRestart.coordinatorMission.taskId, laterResults[0].coordinatorMission.taskId);
  await assertExactRootInitialization(laterEnv.tasksDirectory, laterRootId);

  // Initial-root real append-UNKNOWN regression for create/config/context.
  for (const eventType of ['TaskCreated', 'TaskMissionConfigured', 'TaskContextUpdated']) {
    const env = await coreEnvironment(`initial-unknown-${eventType}`);
    const exactReceipt = receipt(`initial-unknown-${eventType}`);
    const service = new ProjectFormationService(env.projects, env.tasks);
    let liveAtThrow;
    const result = await withRealTaskAppendUnknownOnce(
      env.tasksDirectory,
      eventType,
      event => { liveAtThrow = env.tasks.getTask(event.taskId); },
      () => service.ensureFormation(exactReceipt),
    );
    if (eventType === 'TaskCreated') assert.equal(liveAtThrow, undefined, 'TaskCreated UNKNOWN must throw before live creation apply');
    if (eventType === 'TaskMissionConfigured') assert.equal(liveAtThrow?.mission, undefined, 'Mission config UNKNOWN must throw before live Mission apply');
    if (eventType === 'TaskContextUpdated') assert.equal(liveAtThrow?.context?.summary, undefined, 'Context UNKNOWN must throw before live context apply');
    const events = await taskEvents(env.tasksDirectory, result.rootMission.taskId);
    assert.equal(count(events, eventType), 1, `${eventType} UNKNOWN must leave exactly one durable semantic event`);
    await assertExactRootInitialization(env.tasksDirectory, result.rootMission.taskId);
  }

  // Later-root real append-UNKNOWN regression for create/config/context. Project
  // birth is durable first; each later-root operation must recover the exact root
  // and then create its deterministic Coordinator without duplicate root events.
  for (const eventType of ['TaskCreated', 'TaskMissionConfigured', 'TaskContextUpdated']) {
    const env = await laterEnvironment(`later-unknown-${eventType}`);
    const formedProject = await env.projects.ensureProjectFormation(receipt(`later-unknown-project-${eventType}`));
    const input = laterOperation(formedProject.projectId, `unknown-${eventType}`);
    let liveAtThrow;
    const result = await withRealTaskAppendUnknownOnce(
      env.tasksDirectory,
      eventType,
      event => { liveAtThrow = env.tasks.getTask(event.taskId); },
      () => env.laterRoots.ensureLaterRoot(input),
    );
    if (eventType === 'TaskCreated') assert.equal(liveAtThrow, undefined, 'later TaskCreated UNKNOWN must throw before live creation apply');
    if (eventType === 'TaskMissionConfigured') assert.equal(liveAtThrow?.mission, undefined, 'later Mission config UNKNOWN must throw before live Mission apply');
    if (eventType === 'TaskContextUpdated') assert.equal(liveAtThrow?.context?.summary, undefined, 'later context UNKNOWN must throw before live context apply');
    const events = await taskEvents(env.tasksDirectory, result.rootMission.taskId);
    assert.equal(count(events, eventType), 1, `later ${eventType} UNKNOWN must leave exactly one durable semantic event`);
    await assertExactRootInitialization(env.tasksDirectory, result.rootMission.taskId);
    const freshTasks = new TaskRuntime({ storageDirectory: env.tasksDirectory, newId: idFactory(`later-unknown-restart-${eventType}`), now });
    await freshTasks.initialize();
    assert.equal(freshTasks.listTasks().filter(task => sourceMatches(task, projectLaterRootSource(input, formedProject.workspace))).length, 1);
  }

  // Durable source ambiguity remains corruption and fails closed.
  const ambiguityDirectory = await directory('ambiguity-tasks');
  const ambiguityRuntime = new TaskRuntime({ storageDirectory: ambiguityDirectory, newId: idFactory('ambiguity'), now });
  await ambiguityRuntime.initialize();
  const ambiguousSource = { kind: 'mission', key: 'ambiguous-source', workspace: '/workspace/ambiguous' };
  for (const [index, taskId] of ['ambiguous-a', 'ambiguous-b'].entries()) {
    const row = {
      version: 1,
      eventId: `ambiguous-event-${index + 1}`,
      taskId,
      at: `2026-09-18T02:30:0${index}.000Z`,
      type: 'TaskCreated',
      payload: { source: ambiguousSource, goal: 'Ambiguity must fail closed.' },
    };
    await fs.writeFile(path.join(ambiguityDirectory, `${taskId}.jsonl`), `${JSON.stringify(row)}\n`, 'utf8');
  }
  await assert.rejects(() => ambiguityRuntime.rereadTaskBySource(ambiguousSource), /Durable Task source ambiguity/);

  // ENOENT / ENOTDIR mean no enumerable canonical journal; EACCES remains an
  // unreadable-owner ambiguity and must propagate/fail closed.
  const enoentDirectory = await directory('enoent-tasks');
  const enoentRuntime = new TaskRuntime({ storageDirectory: enoentDirectory, newId: idFactory('enoent'), now });
  await enoentRuntime.initialize();
  await fs.rm(enoentDirectory, { recursive: true, force: true });
  assert.equal(await enoentRuntime.rereadTaskBySource({ kind: 'bridge', key: 'enoent-source' }), undefined);

  const enotdirPath = await directory('enotdir-tasks');
  const enotdirRuntime = new TaskRuntime({ storageDirectory: enotdirPath, newId: idFactory('enotdir'), now });
  await enotdirRuntime.initialize();
  await fs.rm(enotdirPath, { recursive: true, force: true });
  await fs.writeFile(enotdirPath, 'not a directory', 'utf8');
  assert.equal(await enotdirRuntime.rereadTaskBySource({ kind: 'bridge', key: 'enotdir-source' }), undefined);

  const eaccesDirectory = await directory('eacces-tasks');
  const eaccesRuntime = new TaskRuntime({ storageDirectory: eaccesDirectory, newId: idFactory('eacces'), now });
  await eaccesRuntime.initialize();
  const originalReaddir = fs.readdir.bind(fs);
  fs.readdir = async (...args) => {
    if (path.resolve(String(args[0])) === path.resolve(eaccesDirectory)) {
      const error = new Error('INJECTED_EACCES_SOURCE_ENUMERATION');
      error.code = 'EACCES';
      throw error;
    }
    return originalReaddir(...args);
  };
  try {
    await assert.rejects(
      () => eaccesRuntime.rereadTaskBySource({ kind: 'bridge', key: 'eacces-source' }),
      error => error?.code === 'EACCES',
    );
  } finally {
    fs.readdir = originalReaddir;
  }

  console.log(JSON.stringify({
    result: 'PASS',
    blocker: 'P10-FIV-CONCURRENCY-001',
    deterministicInterleaving: {
      staleCandidateCapturedBeforeMutation: true,
      freshReadsAfterLaneAcquisition: targetReadCount,
      liveRegression: false,
      taskMissionConfiguredCount: 1,
    },
    fullFormationConcurrency: {
      freshRounds: stressWidths.length,
      widths: stressWidths,
      simultaneousCallers: stressCallerCount,
      everyCallerFulfilled: true,
      exactDurableCounts: 'ProjectCreated=1 TaskCreated=1 TaskMissionConfigured=1 TaskContextUpdated=1 per round',
      freshRestartEquivalent: true,
    },
    mixedSemantics: 'canonical exact semantics survives; changed same-formationId competitor fails collision without duplicate root initialization',
    laterRootConcurrency: '24/24 converge to one later root + one deterministic Coordinator; exact root create/config/context counts=1',
    appendUnknown: 'initial + later TaskCreated/TaskMissionConfigured/TaskContextUpdated all real-write-then-throw recover exact-once',
    sourceRecovery: 'ambiguity fail-closed; ENOENT/ENOTDIR absent; EACCES fail-closed',
    newDurableSynchronizationState: false,
  }, null, 2));
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
