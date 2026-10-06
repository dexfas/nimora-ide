import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-coordinator-task-'));
const projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-coordinator-project-'));
const collaborationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-coordinator-collaboration-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-coordinator-bundle-'));
const bundlePath = path.join(bundleDirectory, 'mission-coordinator-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { ProjectStore } from './src/project-store.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
      export { MissionCollaborationStore, MISSION_COLLABORATION_JOURNAL } from './src/mission-collaboration-store.ts';
      export {
        MissionFeedbackService,
        missionFeedbackCognitionSource,
        missionFeedbackSpawnedByRelationId,
      } from './src/mission-feedback-service.ts';
      export {
        MissionCoordinatorService,
        missionCoordinatorBootstrapSource,
        missionCoordinatorEnsureMissionSource,
      } from './src/mission-coordinator-service.ts';
    `,
    resolveDir: root,
    sourcefile: 'mission-coordinator-smoke-entry.ts',
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
  MissionCollaborationStore,
  MISSION_COLLABORATION_JOURNAL,
  MissionFeedbackService,
  missionFeedbackCognitionSource,
  missionFeedbackSpawnedByRelationId,
  MissionCoordinatorService,
  missionCoordinatorBootstrapSource,
  missionCoordinatorEnsureMissionSource,
} = require(bundlePath);

let projectId = 0;
let taskId = 0;
let tick = 0;
const newProjectId = () => `phase6-project-${++projectId}`;
const newTaskId = () => `phase6-task-${++taskId}`;
const now = () => new Date(Date.UTC(2026, 8, 15, 10, 0, tick++));
const PROVIDER_HISTORY_SENTINEL = 'PROVIDER_TRANSCRIPT_HISTORY_MUST_NOT_ENTER_COORDINATOR_INSPECTION';
const PROVIDER_MODEL_SENTINEL = 'provider-model-must-not-enter-inspection';

async function configureRootMission(tasks, project, key, plane = 'cognition', missionType = 'managed-root') {
  const task = await tasks.ensureTask({ kind: 'mission', key }, `${missionType} goal`);
  return tasks.configureMission(task.taskId, {
    projectId: project.projectId,
    rootMissionId: task.taskId,
    plane,
    missionType,
    completionCriteria: [`${missionType} complete`],
  });
}

async function durableSnapshot(directories) {
  const snapshot = {};
  for (const directory of directories) {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort();
    for (const file of entries) {
      snapshot[`${path.basename(directory)}/${file}`] = await fs.readFile(path.join(directory, file), 'utf8');
    }
  }
  return snapshot;
}

try {
  const projects = new ProjectStore({ storageDirectory: projectDirectory, newId: newProjectId, now });
  const tasks = new TaskRuntime({ storageDirectory: taskDirectory, newId: newTaskId, now });
  await Promise.all([projects.initialize(), tasks.initialize()]);
  const project = await projects.createProject({ title: 'Phase 6 explicit-command Coordinator bridge' });
  const rootMission = await configureRootMission(tasks, project, 'phase6-managed-root');
  const scope = { projectId: project.projectId, managedRootMissionId: rootMission.taskId };
  const collaboration = new MissionCollaborationStore({
    storageDirectory: collaborationDirectory,
    projects,
    tasks,
    now,
  });
  await collaboration.initialize();
  const feedback = new MissionFeedbackService(projects, tasks, collaboration);
  const coordinator = new MissionCoordinatorService(projects, tasks, collaboration, feedback);

  // Bootstrap is deterministic, provider-neutral, and separate from any Worker
  // identity. Same scope converges to one ordinary coordination Mission.
  const coordinatorMission = await coordinator.ensureCoordinatorMission(scope);
  assert.deepEqual(coordinatorMission.source, missionCoordinatorBootstrapSource(scope));
  assert.equal(coordinatorMission.mission?.projectId, project.projectId);
  assert.equal(coordinatorMission.mission?.rootMissionId, rootMission.taskId);
  assert.equal(coordinatorMission.mission?.parentMissionId, rootMission.taskId);
  assert.equal(coordinatorMission.mission?.plane, 'coordination');
  assert.equal(coordinatorMission.workerSessions && Object.keys(coordinatorMission.workerSessions).length, 0);
  const bootstrapEventCount = coordinatorMission.eventCount;
  const bootstrapRetry = await coordinator.ensureCoordinatorMission(scope);
  assert.equal(bootstrapRetry.taskId, coordinatorMission.taskId);
  assert.equal(bootstrapRetry.eventCount, bootstrapEventCount, 'bootstrap retry must not add another event');
  assert.equal(
    tasks.listTasks().filter(task => task.source.kind === 'mission' && task.source.key === coordinatorMission.source.key).length,
    1,
    'bootstrap source identity must resolve to exactly one Coordinator Mission',
  );

  // A claimed deterministic bootstrap identity with different Mission meaning
  // fails closed rather than being repurposed.
  const collisionProject = await projects.createProject({ title: 'Bootstrap collision project' });
  const collisionRoot = await configureRootMission(tasks, collisionProject, 'phase6-collision-root');
  const collisionScope = { projectId: collisionProject.projectId, managedRootMissionId: collisionRoot.taskId };
  const collisionTask = await tasks.ensureTask(
    missionCoordinatorBootstrapSource(collisionScope),
    `Execute explicit semantic instructions for managed root Mission ${collisionRoot.taskId}.`,
  );
  await tasks.configureMission(collisionTask.taskId, {
    projectId: collisionProject.projectId,
    rootMissionId: collisionRoot.taskId,
    parentMissionId: collisionRoot.taskId,
    plane: 'practice',
    missionType: 'conflicting-bootstrap-meaning',
    completionCriteria: ['Intentionally conflict with Coordinator bootstrap meaning'],
  });
  await assert.rejects(
    () => coordinator.ensureCoordinatorMission(collisionScope),
    /bootstrap identity\/content collision/,
    'bootstrap identity/content collision must fail closed',
  );

  const practiceInstruction = {
    ...scope,
    operationKey: 'practice-implementation-v1',
    goal: 'Implement the explicitly authorized bounded slice.',
    parentMissionId: rootMission.taskId,
    plane: 'practice',
    missionType: 'implementation',
    completionCriteria: ['The authorized slice is implemented and evidence is returned.'],
  };
  const practiceMission = await coordinator.ensureMission(practiceInstruction);
  assert.deepEqual(practiceMission.source, missionCoordinatorEnsureMissionSource(practiceInstruction));
  assert.equal(practiceMission.mission?.plane, 'practice');
  assert.equal(practiceMission.mission?.parentMissionId, rootMission.taskId);
  const practiceEventCount = practiceMission.eventCount;
  assert.equal((await coordinator.ensureMission(practiceInstruction)).taskId, practiceMission.taskId);
  assert.equal((await coordinator.ensureMission(practiceInstruction)).eventCount, practiceEventCount);

  for (const [label, mutation] of [
    ['goal', { goal: 'Different semantic goal.' }],
    ['plane', { plane: 'cognition' }],
    ['missionType', { missionType: 'different-type' }],
    ['completionCriteria', { completionCriteria: ['Different completion meaning.'] }],
  ]) {
    await assert.rejects(
      () => coordinator.ensureMission({ ...practiceInstruction, ...mutation }),
      /operation identity\/content collision/,
      `same operation key with changed ${label} must fail closed`,
    );
  }

  // Wrong Project/root/parent and self-parent are mechanical scope errors, not
  // invitations for the bridge to reinterpret or repair the instruction.
  await assert.rejects(
    () => coordinator.ensureMission({ ...practiceInstruction, projectId: collisionProject.projectId, operationKey: 'wrong-project' }),
    /does not identify the exact Project root/,
  );
  await assert.rejects(
    () => coordinator.ensureMission({ ...practiceInstruction, managedRootMissionId: coordinatorMission.taskId, operationKey: 'wrong-root' }),
    /does not identify the exact Project root/,
  );
  const otherRoot = await configureRootMission(tasks, project, 'phase6-other-root', 'cognition', 'other-root');
  await assert.rejects(
    () => coordinator.ensureMission({ ...practiceInstruction, operationKey: 'out-of-scope-parent', parentMissionId: otherRoot.taskId }),
    /outside the managed Coordinator scope/,
  );
  const selfInstruction = {
    ...practiceInstruction,
    operationKey: 'self-parent-operation',
    goal: 'Self parent must reject.',
  };
  const selfClaim = await tasks.ensureTask(missionCoordinatorEnsureMissionSource(selfInstruction), selfInstruction.goal);
  await assert.rejects(
    () => coordinator.ensureMission({ ...selfInstruction, parentMissionId: selfClaim.taskId }),
    /cannot make a Mission its own parent/,
  );
  assert.equal(tasks.getTask(selfClaim.taskId)?.mission, undefined);

  // Bridge preflight rejects new work under terminal parents before creating a
  // deterministic Task, while TaskRuntime itself owns the same invariant.
  const terminalParentInstruction = {
    ...scope,
    operationKey: 'terminal-parent',
    goal: 'Parent that will finalize.',
    parentMissionId: rootMission.taskId,
    plane: 'cognition',
    missionType: 'terminal-parent',
    completionCriteria: ['Parent is finalized for admission proof.'],
  };
  const terminalParent = await coordinator.ensureMission(terminalParentInstruction);
  await tasks.finalizeMissionStrict(terminalParent.taskId, { handoffRequired: false });
  const blockedGrandchildInstruction = {
    ...scope,
    operationKey: 'blocked-by-terminal-parent',
    goal: 'Must never configure below finalized parent.',
    parentMissionId: terminalParent.taskId,
    plane: 'practice',
    missionType: 'blocked-grandchild',
    completionCriteria: ['Must remain absent.'],
  };
  await assert.rejects(
    () => coordinator.ensureMission(blockedGrandchildInstruction),
    /Parent Mission .* terminal \(completed\).*cannot accept new routed work/,
  );
  assert.equal(tasks.findTaskBySource(missionCoordinatorEnsureMissionSource(blockedGrandchildInstruction)), undefined);

  const terminalRootProject = await projects.createProject({ title: 'Terminal root bridge proof' });
  const terminalRoot = await configureRootMission(tasks, terminalRootProject, 'phase6-terminal-root');
  const terminalRootScope = { projectId: terminalRootProject.projectId, managedRootMissionId: terminalRoot.taskId };
  await coordinator.ensureCoordinatorMission(terminalRootScope);
  await tasks.finalizeMissionStrict(terminalRoot.taskId, { handoffRequired: false });
  await tasks.archiveMissionStrict(terminalRoot.taskId);
  const blockedByRootInstruction = {
    ...terminalRootScope,
    operationKey: 'blocked-by-terminal-root',
    goal: 'Must never configure below archived root.',
    parentMissionId: terminalRoot.taskId,
    plane: 'practice',
    missionType: 'blocked-child',
    completionCriteria: ['Must remain absent.'],
  };
  await assert.rejects(
    () => coordinator.ensureMission(blockedByRootInstruction),
    /Managed root Mission .* terminal \(archived\).*cannot accept new routed work/,
  );
  assert.equal(tasks.findTaskBySource(missionCoordinatorEnsureMissionSource(blockedByRootInstruction)), undefined);

  // Provider identity may exist in Task-owned Worker bookkeeping, but bounded
  // Coordinator inspection deliberately omits Worker/provider/session state.
  await tasks.attachWorkerSession(practiceMission.taskId, {
    managedSessionId: 'phase6-provider-managed-sentinel',
    workerId: 'worker.phase6.provider-sentinel',
    adapterSessionId: 'phase6-provider-session-sentinel',
    model: PROVIDER_MODEL_SENTINEL,
  });
  const providerOnlyHistory = new Map([[practiceMission.taskId, PROVIDER_HISTORY_SENTINEL]]);
  assert.match(providerOnlyHistory.get(practiceMission.taskId), new RegExp(PROVIDER_HISTORY_SENTINEL));

  const evidence = await collaboration.recordExchange({
    exchangeId: 'phase6-practice-evidence',
    projectId: project.projectId,
    sourceMissionId: practiceMission.taskId,
    kind: 'Evidence',
    payload: {
      summary: 'Practice observed a bounded repository fact.',
      references: [{ type: 'file', path: 'src/mission-coordinator-service.ts', detail: 'Explicit route is required.' }],
    },
  });
  const problem = await collaboration.recordExchange({
    exchangeId: 'phase6-practice-problem',
    projectId: project.projectId,
    sourceMissionId: practiceMission.taskId,
    kind: 'Problem',
    payload: {
      currentGoal: practiceInstruction.goal,
      previousAssumption: 'Observation might itself trigger routing.',
      observedReality: 'Coordinator is required to wait for an explicit semantic route instruction.',
      preciseQuestion: 'What bounded Cognition answer should Practice use next?',
      blocking: true,
      evidenceExchangeIds: [evidence.exchangeId],
    },
  });
  await Promise.all([projects.flush(), tasks.flush(), collaboration.flush()]);

  const taskCountBeforeInspection = tasks.listTasks().length;
  const explicitRelationCountBeforeInspection = collaboration.listRelations(project.projectId, { includeDerivedParent: false }).length;
  const durableBeforeInspection = await durableSnapshot([projectDirectory, taskDirectory, collaborationDirectory]);
  const inspection = await coordinator.inspectManagedScope(scope);
  const durableAfterInspection = await durableSnapshot([projectDirectory, taskDirectory, collaborationDirectory]);
  assert.deepEqual(durableAfterInspection, durableBeforeInspection, 'inspection must cause zero durable mutation');
  assert.equal(tasks.listTasks().length, taskCountBeforeInspection, 'inspection must not create a Mission');
  assert.equal(collaboration.listRelations(project.projectId, { includeDerivedParent: false }).length, explicitRelationCountBeforeInspection);
  assert.equal(
    tasks.findTaskBySource(missionFeedbackCognitionSource({
      projectId: project.projectId,
      practiceMissionId: practiceMission.taskId,
      problemExchangeId: problem.exchangeId,
    })),
    undefined,
    'recording/inspecting a blocking Problem must not create feedback Cognition',
  );
  assert.equal(
    collaboration.getRelation(missionFeedbackSpawnedByRelationId({
      projectId: project.projectId,
      practiceMissionId: practiceMission.taskId,
      problemExchangeId: problem.exchangeId,
    })),
    undefined,
    'recording/inspecting a blocking Problem must not create spawned_by provenance',
  );
  assert.equal(inspection.coordinationMissionId, coordinatorMission.taskId);
  assert.ok(inspection.missions.some(item => item.missionId === practiceMission.taskId));
  assert.ok(inspection.relations.some(item => item.type === 'parent_of' && item.derived && item.targetMissionId === practiceMission.taskId));
  assert.deepEqual(
    inspection.exchanges.find(item => item.exchangeId === problem.exchangeId),
    {
      exchangeId: problem.exchangeId,
      kind: 'Problem',
      sourceMissionId: practiceMission.taskId,
      blocking: true,
    },
  );
  assert.doesNotMatch(JSON.stringify(inspection), new RegExp(PROVIDER_HISTORY_SENTINEL));
  assert.doesNotMatch(JSON.stringify(inspection), new RegExp(PROVIDER_MODEL_SENTINEL));
  for (const mission of inspection.missions) {
    for (const forbiddenField of ['workerSessions', 'interactions', 'executions', 'context', 'todos', 'artifacts', 'eventCount', 'lastEventId']) {
      assert.equal(forbiddenField in mission, false, `inspection Mission projection must omit TaskSnapshot field ${forbiddenField}`);
    }
  }

  // Only this explicit route call may create/reuse the deterministic feedback
  // Cognition path. No WorkerSessionManager or send operation participates.
  const routeInput = {
    ...scope,
    practiceMissionId: practiceMission.taskId,
    problemExchangeId: problem.exchangeId,
  };
  const routed = await coordinator.routePracticeProblem(routeInput);
  assert.equal(routed.cognitionMission.mission?.plane, 'cognition');
  assert.equal(routed.cognitionMission.source.kind, 'mission');
  const cognitionMissionId = routed.cognitionMission.taskId;
  const spawnedRelationId = missionFeedbackSpawnedByRelationId(routeInput);
  assert.equal(collaboration.getRelation(spawnedRelationId)?.basisExchangeId, problem.exchangeId);
  assert.equal((await coordinator.routePracticeProblem(routeInput)).cognitionMission.taskId, cognitionMissionId);
  assert.equal(
    collaboration.listRelations(project.projectId, { includeDerivedParent: false })
      .filter(relation => relation.type === 'spawned_by' && relation.basisExchangeId === problem.exchangeId).length,
    1,
    'explicit route retry must not create a second provenance path',
  );

  const answered = await feedback.recordAnswer({
    projectId: project.projectId,
    practiceMissionId: practiceMission.taskId,
    problemExchangeId: problem.exchangeId,
    answerExchangeId: 'phase6-feedback-answer',
    answer: 'Use the explicit-command bridge route and keep planning authority in Cognition.',
    evidenceExchangeIds: [evidence.exchangeId],
  });
  assert.equal(answered.continuation.route.targetMissionId, practiceMission.taskId);
  const inspectionAfterAnswer = await coordinator.inspectManagedScope(scope);
  assert.deepEqual(
    inspectionAfterAnswer.exchanges.find(item => item.exchangeId === answered.answer.exchangeId),
    {
      exchangeId: answered.answer.exchangeId,
      kind: 'Answer',
      sourceMissionId: cognitionMissionId,
      targetMissionId: practiceMission.taskId,
      replyToExchangeId: problem.exchangeId,
    },
    'bounded inspection exposes Answer route identity without transcript payloads',
  );

  // The public facade has no Human Confirmation/Commit, Worker selection/send,
  // provider/model selection, or delivery-ledger action surface.
  for (const forbiddenMethod of [
    'confirmProposalHuman',
    'commitProposal',
    'createSession',
    'register',
    'send',
    'markDelivered',
    'markDeliveredStrict',
    'selectWorker',
    'selectProvider',
    'selectModel',
  ]) {
    assert.equal(typeof coordinator[forbiddenMethod], 'undefined', `Coordinator API must not expose ${forbiddenMethod}`);
  }
  const coordinatorSourceText = await fs.readFile(path.join(root, 'src', 'mission-coordinator-service.ts'), 'utf8');
  assert.doesNotMatch(coordinatorSourceText, /worker-session-manager|WorkerSessionManager/);
  assert.doesNotMatch(coordinatorSourceText, /project-decision-service|confirmProposalHuman|commitProposal/);
  assert.doesNotMatch(coordinatorSourceText, /\.send\s*\(|markDelivered(?:Strict)?\s*\(/);

  // Phase 3 ownership remains unchanged: membership derives from Task mission
  // metadata and parent_of is a read-time derived relation, never journal data.
  assert.equal('missionIds' in projects.getProject(project.projectId), false);
  const collaborationJournalPath = path.join(collaborationDirectory, MISSION_COLLABORATION_JOURNAL);
  assert.doesNotMatch(await fs.readFile(collaborationJournalPath, 'utf8'), /"type":"parent_of"/);

  await Promise.all([projects.flush(), tasks.flush(), collaboration.flush()]);
  const restartedProjects = new ProjectStore({ storageDirectory: projectDirectory });
  const restartedTasks = new TaskRuntime({ storageDirectory: taskDirectory });
  const restartedCollaboration = new MissionCollaborationStore({
    storageDirectory: collaborationDirectory,
    projects: restartedProjects,
    tasks: restartedTasks,
  });
  const restartedFeedback = new MissionFeedbackService(restartedProjects, restartedTasks, restartedCollaboration);
  const restartedCoordinator = new MissionCoordinatorService(
    restartedProjects,
    restartedTasks,
    restartedCollaboration,
    restartedFeedback,
  );
  const replayedCoordinatorMission = await restartedCoordinator.ensureCoordinatorMission(scope);
  assert.equal(replayedCoordinatorMission.taskId, coordinatorMission.taskId, 'restart bootstrap must converge to the exact Coordinator Mission');
  const replayedPractice = await restartedCoordinator.ensureMission(practiceInstruction);
  assert.equal(replayedPractice.taskId, practiceMission.taskId, 'restart ensure-Mission must converge to the exact child Mission');
  const replayedRoute = await restartedCoordinator.routePracticeProblem(routeInput);
  assert.equal(replayedRoute.cognitionMission.taskId, cognitionMissionId, 'restart explicit Problem route must reuse the exact Cognition Mission');
  assert.equal(
    restartedCollaboration.listRelations(project.projectId, { includeDerivedParent: false })
      .filter(relation => relation.type === 'spawned_by' && relation.basisExchangeId === problem.exchangeId).length,
    1,
    'restart must not create a second Problem provenance path',
  );
  const replayedInspection = await restartedCoordinator.inspectManagedScope(scope);
  assert.equal(replayedInspection.coordinationMissionId, coordinatorMission.taskId);
  assert.ok(replayedInspection.exchanges.some(item => item.exchangeId === answered.answer.exchangeId && item.replyToExchangeId === problem.exchangeId));
  assert.doesNotMatch(JSON.stringify(replayedInspection), new RegExp(PROVIDER_HISTORY_SENTINEL));
  assert.doesNotMatch(JSON.stringify(replayedInspection), new RegExp(PROVIDER_MODEL_SENTINEL));

  console.log('[smoke] Phase 6 explicit-command Coordinator bridge bootstrap/ensure/inspection/Problem-route boundaries ok');
  console.log(`[smoke] root=${rootMission.taskId} coordinator=${coordinatorMission.taskId} practice=${practiceMission.taskId} feedbackCognition=${cognitionMissionId}`);
} finally {
  await Promise.all([
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(projectDirectory, { recursive: true, force: true }),
    fs.rm(collaborationDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
