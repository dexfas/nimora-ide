import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-feedback-task-'));
const projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-feedback-project-'));
const collaborationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-feedback-collaboration-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-feedback-bundle-'));
const bundlePath = path.join(bundleDirectory, 'mission-feedback-smoke.cjs');

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
        missionFeedbackAnswersRelationId,
      } from './src/mission-feedback-service.ts';
      export { buildMissionFeedbackWorkerInput } from './src/mission-feedback-worker-input.ts';
      export { WorkerSessionManager } from './src/worker-session-manager.ts';
      export { buildRenderedContextHandoff } from './src/context-handoff.ts';
    `,
    resolveDir: root,
    sourcefile: 'mission-feedback-smoke-entry.ts',
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
  missionFeedbackAnswersRelationId,
  buildMissionFeedbackWorkerInput,
  WorkerSessionManager,
  buildRenderedContextHandoff,
} = require(bundlePath);

let projectId = 0;
let taskId = 0;
let tick = 0;
const newProjectId = () => `phase4-project-${++projectId}`;
const newTaskId = () => `phase4-task-${++taskId}`;
const now = () => new Date(Date.UTC(2026, 8, 15, 6, 30, tick++));
const STALE_TRANSCRIPT_SENTINEL = 'STALE_TRANSCRIPT_SENTINEL_DO_NOT_REPLAY';

async function configureRootMission(tasks, project, key, plane, missionType) {
  const task = await tasks.ensureTask({ kind: 'bridge', key }, `${missionType} goal`);
  await tasks.configureMission(task.taskId, {
    projectId: project.projectId,
    rootMissionId: task.taskId,
    plane,
    missionType,
    completionCriteria: [`${missionType} complete`],
  });
  return tasks.getTask(task.taskId);
}

async function readTaskJournals(directory) {
  const files = (await fs.readdir(directory)).filter(file => file.endsWith('.jsonl')).sort();
  return (await Promise.all(files.map(file => fs.readFile(path.join(directory, file), 'utf8')))).join('\n');
}

class Phase4FakeAdapter {
  constructor(providerPrefix) {
    this.providerPrefix = providerPrefix;
  }

  id = 'worker.phase4';
  nextSession = 0;
  forcedNextSessionId = undefined;
  inputs = [];
  disposed = [];
  providerHistory = new Map();

  async describe() {
    return {
      id: this.id,
      provider: 'phase4-fake',
      kind: 'api',
      label: 'Phase 4 deterministic fake Worker',
      availability: 'available',
      capabilities: {
        streaming: true,
        reasoning: true,
        capabilityRequests: false,
        imageInput: false,
        checkpoints: false,
        interruption: true,
        persistentContext: true,
      },
    };
  }

  async createSession(options) {
    const sessionId = this.forcedNextSessionId ?? `${this.providerPrefix}-${++this.nextSession}`;
    this.forcedNextSessionId = undefined;
    const at = new Date().toISOString();
    return {
      sessionId,
      workerId: this.id,
      state: 'idle',
      model: options.model,
      contextHandle: options.contextHandle,
      createdAt: at,
      lastActiveAt: at,
    };
  }

  async *send(session, input) {
    session.state = 'running';
    session.lastActiveAt = new Date().toISOString();
    this.inputs.push(structuredClone(input));
    try {
      yield { type: 'text_delta', inputId: input.inputId, text: 'practice-continuation-observed' };
      if (input.inputId === 'phase4-unknown-send') throw new Error('INJECTED_UNKNOWN_PROVIDER_SEND_BOUNDARY');
      yield { type: 'terminal', inputId: input.inputId, status: 'completed' };
    } finally {
      session.state = 'idle';
      session.lastActiveAt = new Date().toISOString();
    }
  }

  async interrupt(session) {
    session.state = 'interrupted';
  }

  async dispose(session) {
    this.disposed.push(session.sessionId);
    session.state = 'disposed';
  }

  async health() {
    return { status: 'healthy', checkedAt: new Date().toISOString() };
  }
}

try {
  const projects = new ProjectStore({ storageDirectory: projectDirectory, newId: newProjectId, now });
  const tasks = new TaskRuntime({ storageDirectory: taskDirectory, newId: newTaskId, now });
  await Promise.all([projects.initialize(), tasks.initialize()]);
  const project = await projects.createProject({
    title: 'Phase 4 deterministic feedback loop',
    goal: 'Let Practice reality revise Cognition without transcript inheritance.',
  });

  const cognitionA = await configureRootMission(tasks, project, 'phase4-cognition-a', 'cognition', 'initial-cognition');
  const practiceB = await configureRootMission(tasks, project, 'phase4-practice-b', 'practice', 'implementation-practice');
  await tasks.updateContext(practiceB.taskId, {
    summary: 'Practice B local durable context survives Worker replacement.',
    constraints: ['Cross-Mission updates arrive only through bounded typed feedback facts.'],
    decisions: ['Worker replacement must keep the same Practice Mission identity.'],
    relevantFiles: ['src/mission-feedback-service.ts', 'src/worker-session-manager.ts'],
  });
  assert.equal(
    tasks.listTasks().filter(task => task.mission?.projectId === project.projectId && task.mission?.plane === 'practice').length,
    1,
    'canonical setup starts with exactly one Practice Mission B',
  );

  const collaboration = new MissionCollaborationStore({
    storageDirectory: collaborationDirectory,
    projects,
    tasks,
    now,
  });
  await collaboration.initialize();

  const initialFinding = await collaboration.recordExchange({
    exchangeId: 'phase4-finding-a-x',
    projectId: project.projectId,
    sourceMissionId: cognitionA.taskId,
    targetMissionId: practiceB.taskId,
    kind: 'Finding',
    payload: {
      summary: 'Assumption X: Task-created Missions still have only native-chat or bridge source provenance.',
      evidenceExchangeIds: [],
    },
  });
  await collaboration.recordRelation({
    relationId: 'phase4-informs-a-b',
    projectId: project.projectId,
    sourceMissionId: cognitionA.taskId,
    targetMissionId: practiceB.taskId,
    type: 'informs',
    basisExchangeId: initialFinding.exchangeId,
  });

  // This is deliberately provider-only history. It is never handed to the
  // collaboration/service layer and therefore must never become replay state.
  const staleProviderHistory = new Map([
    [practiceB.taskId, `old provider turn: keep believing X; ${STALE_TRANSCRIPT_SENTINEL}`],
  ]);
  assert.match(staleProviderHistory.get(practiceB.taskId), new RegExp(STALE_TRANSCRIPT_SENTINEL));

  // Practice B observes repository Reality rather than trusting Finding A.
  const taskContractText = await fs.readFile(path.join(root, 'src', 'task-contract.ts'), 'utf8');
  assert.match(taskContractText, /TaskSourceKind\s*=.*"mission"/s, 'repository Reality must expose the new provider-neutral Mission source');
  const realityEvidence = await collaboration.recordExchange({
    exchangeId: 'phase4-evidence-reality-y',
    projectId: project.projectId,
    sourceMissionId: practiceB.taskId,
    kind: 'Evidence',
    payload: {
      summary: 'Reality Y: TaskSourceKind includes the provider-neutral mission source.',
      references: [
        { type: 'file', path: 'src/task-contract.ts', detail: 'TaskSourceKind includes "mission".' },
        { type: 'command', command: 'inspect src/task-contract.ts TaskSourceKind', observation: 'Reality Y observed: mission source is present.' },
      ],
    },
  });
  const problem = await collaboration.recordExchange({
    exchangeId: 'phase4-problem-x-vs-y',
    projectId: project.projectId,
    sourceMissionId: practiceB.taskId,
    kind: 'Problem',
    payload: {
      currentGoal: 'Create feedback Cognition without spoofing a transport-created Task.',
      previousAssumption: 'X: only native-chat or bridge can identify a Task source.',
      observedReality: 'Y: TaskSourceKind now has a provider-neutral mission source intended for Mission-created operations.',
      preciseQuestion: 'What source provenance should this deterministic feedback-created Cognition Mission use?',
      blocking: true,
      evidenceExchangeIds: [realityEvidence.exchangeId],
    },
  });
  await Promise.all([projects.flush(), tasks.flush(), collaboration.flush()]);

  // Restart point A: only durable Project/Mission/Problem/Evidence facts survive.
  const projectsAfterProblem = new ProjectStore({ storageDirectory: projectDirectory });
  const tasksAfterProblem = new TaskRuntime({ storageDirectory: taskDirectory });
  const collaborationAfterProblem = new MissionCollaborationStore({
    storageDirectory: collaborationDirectory,
    projects: projectsAfterProblem,
    tasks: tasksAfterProblem,
  });
  const feedbackAfterProblem = new MissionFeedbackService(projectsAfterProblem, tasksAfterProblem, collaborationAfterProblem);
  const routeIdentity = {
    projectId: project.projectId,
    practiceMissionId: practiceB.taskId,
    problemExchangeId: problem.exchangeId,
  };
  const firstRoute = await feedbackAfterProblem.ensureCognitionForProblem(routeIdentity);
  const cognitionC = firstRoute.cognitionMission;
  assert.equal(cognitionC.source.kind, 'mission', 'feedback-created Cognition must not impersonate bridge/native-chat');
  assert.deepEqual(cognitionC.source, missionFeedbackCognitionSource(routeIdentity));
  assert.equal(cognitionC.mission?.plane, 'cognition');
  assert.equal(cognitionC.mission?.projectId, project.projectId);
  assert.equal(cognitionC.mission?.rootMissionId, cognitionC.taskId, 'feedback Cognition uses existing TaskRuntime membership only');
  assert.equal(cognitionC.mission?.parentMissionId, undefined, 'feedback provenance is spawned_by, not a duplicated parent_of fact');

  const spawnedId = missionFeedbackSpawnedByRelationId(routeIdentity);
  const spawned = collaborationAfterProblem.getRelation(spawnedId);
  assert.ok(spawned);
  assert.equal(spawned.type, 'spawned_by');
  assert.equal(spawned.sourceMissionId, cognitionC.taskId);
  assert.equal(spawned.targetMissionId, practiceB.taskId);
  assert.equal(spawned.basisExchangeId, problem.exchangeId);

  assert.equal(firstRoute.input.practiceMissionId, practiceB.taskId);
  assert.equal(firstRoute.input.cognitionMissionId, cognitionC.taskId);
  assert.equal(firstRoute.input.problem.previousAssumption.startsWith('X:'), true);
  assert.equal(firstRoute.input.problem.observedReality.startsWith('Y:'), true);
  assert.deepEqual(firstRoute.input.evidence.map(item => item.exchangeId), [realityEvidence.exchangeId]);
  assert.doesNotMatch(JSON.stringify(firstRoute.input), new RegExp(STALE_TRANSCRIPT_SENTINEL));
  assert.doesNotMatch(JSON.stringify(firstRoute.input), /phase4-finding-a-x/, 'old Finding is historical, not implicit Cognition C input authority');

  const taskCountAfterFirstRoute = tasksAfterProblem.listTasks().length;
  const secondRoute = await feedbackAfterProblem.ensureCognitionForProblem(routeIdentity);
  assert.equal(secondRoute.cognitionMission.taskId, cognitionC.taskId, 'same semantic feedback operation must reuse Cognition C');
  assert.equal(tasksAfterProblem.listTasks().length, taskCountAfterFirstRoute, 'idempotent retry must not create duplicate Cognition Missions');
  assert.deepEqual(secondRoute.input, firstRoute.input);

  // Simulate Answer durable but answers-relation write interrupted. Retrying the
  // semantic operation must reuse both C and the exact Answer identity.
  const answerInput = {
    ...routeIdentity,
    answerExchangeId: 'phase4-answer-use-y',
    answer: 'Use source kind "mission" with the stable feedback-operation source key; Y supersedes assumption X for this continuation.',
    evidenceExchangeIds: [realityEvidence.exchangeId],
  };
  const originalRecordRelation = collaborationAfterProblem.recordRelation.bind(collaborationAfterProblem);
  let interruptAnswerRelation = true;
  collaborationAfterProblem.recordRelation = async input => {
    if (interruptAnswerRelation && input.type === 'answers' && input.basisExchangeId === answerInput.answerExchangeId) {
      interruptAnswerRelation = false;
      throw new Error('INJECTED_ANSWER_RELATION_INTERRUPTION');
    }
    return originalRecordRelation(input);
  };
  await assert.rejects(
    () => feedbackAfterProblem.recordAnswer(answerInput),
    /INJECTED_ANSWER_RELATION_INTERRUPTION/,
  );
  const durablePartialAnswer = collaborationAfterProblem.getExchange(answerInput.answerExchangeId);
  assert.equal(durablePartialAnswer?.kind, 'Answer', 'Answer must already be durable at the injected adjacent partial-progress boundary');
  assert.equal(
    collaborationAfterProblem.getRelation(missionFeedbackAnswersRelationId(routeIdentity, answerInput.answerExchangeId)),
    undefined,
    'interrupted answers provenance write must remain visibly incomplete',
  );
  collaborationAfterProblem.recordRelation = originalRecordRelation;
  const recorded = await feedbackAfterProblem.recordAnswer(answerInput);
  assert.equal(recorded.answer.exchangeId, answerInput.answerExchangeId);
  assert.equal(recorded.answer.replyToExchangeId, problem.exchangeId);
  assert.equal(recorded.answer.targetMissionId, practiceB.taskId);
  assert.equal(recorded.answer.sourceMissionId, cognitionC.taskId);
  assert.equal(recorded.continuation.practiceMissionId, practiceB.taskId);
  assert.equal(recorded.continuation.route.targetMissionId, practiceB.taskId);
  assert.equal(recorded.continuation.cognitionMissionId, cognitionC.taskId);
  assert.equal(recorded.continuation.answer.answer.includes('Y supersedes assumption X'), true);
  assert.doesNotMatch(JSON.stringify(recorded.continuation), new RegExp(STALE_TRANSCRIPT_SENTINEL));
  assert.equal(
    tasksAfterProblem.listTasks().filter(task => task.mission?.projectId === project.projectId && task.mission?.plane === 'practice').length,
    1,
    'canonical feedback route must continue original Practice B instead of creating B2',
  );
  assert.equal(tasksAfterProblem.getTask(practiceB.taskId)?.taskId, practiceB.taskId);
  assert.ok(collaborationAfterProblem.getExchange(initialFinding.exchangeId), 'the old incorrect Finding remains durable historical fact');
  const collaborationJournalPath = path.join(collaborationDirectory, MISSION_COLLABORATION_JOURNAL);

  let oldManagedSessionId;
  let oldAdapterSessionId;
  {
    let managed = 0;
    const liveAdapter = new Phase4FakeAdapter('phase4-old-provider');
    liveAdapter.providerHistory.set('old-practice-provider-history', `old provider-only context; ${STALE_TRANSCRIPT_SENTINEL}`);
    const liveManager = new WorkerSessionManager({
      taskBindings: tasksAfterProblem,
      newId: () => `phase4-live-managed-${++managed}`,
    });
    await liveManager.register(liveAdapter);
    const liveSession = await liveManager.createSession('worker.phase4', { model: 'phase4-fake-model' }, practiceB.taskId);
    oldManagedSessionId = liveSession.managedSessionId;
    oldAdapterSessionId = liveSession.adapterSessionId;
    assert.equal(liveManager.getSession(liveSession.managedSessionId)?.taskId, practiceB.taskId);

    const liveWorkerInput = buildMissionFeedbackWorkerInput({
      continuation: recorded.continuation,
      practiceMission: tasksAfterProblem.getTask(practiceB.taskId),
      session: liveManager.getSession(liveSession.managedSessionId),
      inputId: 'phase4-live-same-worker',
    });
    assert.equal('history' in liveWorkerInput, false, 'Phase 4 host input must not inherit provider history');
    assert.match(liveWorkerInput.prompt, /Y supersedes assumption X/);
    assert.match(liveWorkerInput.prompt, /Reality Y: TaskSourceKind includes the provider-neutral mission source/);
    assert.match(liveWorkerInput.prompt, /phase4-problem-x-vs-y/);
    assert.doesNotMatch(liveWorkerInput.prompt, new RegExp(STALE_TRANSCRIPT_SENTINEL));
    assert.doesNotMatch(liveWorkerInput.prompt, new RegExp(oldAdapterSessionId));

    const liveEvents = [];
    for await (const event of liveManager.send(liveSession.managedSessionId, liveWorkerInput)) liveEvents.push(event);
    assert.equal(liveEvents.at(-1)?.type, 'terminal');
    assert.equal(liveEvents.at(-1)?.status, 'completed');
    assert.equal(liveManager.getSession(liveSession.managedSessionId)?.taskId, practiceB.taskId, 'successful turn must remain bound to original Practice B');
    assert.equal(liveAdapter.inputs.length, 1);
    assert.equal(liveAdapter.inputs[0].prompt, liveWorkerInput.prompt);
    assert.equal(
      tasksAfterProblem.listTasks().filter(task => task.mission?.projectId === project.projectId && task.mission?.plane === 'practice').length,
      1,
      'live continuation must not create Practice B2',
    );

    const collaborationCountBeforeUnknown = collaborationAfterProblem.listExchanges(project.projectId).length;
    const relationCountBeforeUnknown = collaborationAfterProblem.listRelations(project.projectId, { includeDerivedParent: false }).length;
    const unknownInput = buildMissionFeedbackWorkerInput({
      continuation: recorded.continuation,
      practiceMission: tasksAfterProblem.getTask(practiceB.taskId),
      session: liveManager.getSession(liveSession.managedSessionId),
      inputId: 'phase4-unknown-send',
    });
    const unknownIterator = liveManager.send(liveSession.managedSessionId, unknownInput)[Symbol.asyncIterator]();
    assert.equal((await unknownIterator.next()).value.type, 'text_delta', 'provider may have observed the input before uncertainty');
    await assert.rejects(() => unknownIterator.next(), /INJECTED_UNKNOWN_PROVIDER_SEND_BOUNDARY/);
    const sendsAfterUnknown = liveAdapter.inputs.length;

    const rebuiltServiceAfterUnknown = new MissionFeedbackService(projectsAfterProblem, tasksAfterProblem, collaborationAfterProblem);
    const rebuiltAfterUnknown = await rebuiltServiceAfterUnknown.buildPracticeContinuation({
      ...routeIdentity,
      answerExchangeId: answerInput.answerExchangeId,
    });
    assert.deepEqual(rebuiltAfterUnknown, recorded.continuation, 'unknown provider outcome must not mutate durable Answer routing truth');
    assert.equal(liveAdapter.inputs.length, sendsAfterUnknown, 'reconstructing feedback must not automatically resend');
    assert.equal(collaborationAfterProblem.listExchanges(project.projectId).length, collaborationCountBeforeUnknown, 'unknown send must not invent a delivery exchange');
    assert.equal(collaborationAfterProblem.listRelations(project.projectId, { includeDerivedParent: false }).length, relationCountBeforeUnknown, 'unknown send must not invent a delivery relation');
    assert.equal(collaborationAfterProblem.getExchange(answerInput.answerExchangeId)?.kind, 'Answer', 'durable Answer remains an Answer, not consumed/delivered workflow state');
    assert.equal(
      tasksAfterProblem.listTasks().filter(task => task.mission?.projectId === project.projectId && task.mission?.plane === 'practice').length,
      1,
      'unknown send reconstruction must not create Practice B2',
    );
    assert.doesNotMatch(await fs.readFile(collaborationJournalPath, 'utf8'), /phase4-unknown-send|"delivered"/i, 'provider send outcome must not be persisted into collaboration state');
  }

  const projectSnapshot = projectsAfterProblem.getProject(project.projectId);
  assert.equal('missionIds' in projectSnapshot, false, 'ProjectStore must not acquire a second Project→Mission membership truth');
  const collaborationJournal = await fs.readFile(collaborationJournalPath, 'utf8');
  assert.doesNotMatch(collaborationJournal, /"type":"parent_of"/, 'parent_of remains derived from Task mission metadata and is never persisted here');
  assert.doesNotMatch(collaborationJournal, new RegExp(STALE_TRANSCRIPT_SENTINEL));
  assert.doesNotMatch(await readTaskJournals(taskDirectory), new RegExp(STALE_TRANSCRIPT_SENTINEL));
  assert.doesNotMatch(await fs.readFile(path.join(projectDirectory, 'projects-v1.jsonl'), 'utf8'), /missionIds/);

  await Promise.all([projectsAfterProblem.flush(), tasksAfterProblem.flush(), collaborationAfterProblem.flush()]);

  // Restart point B: Answer + provenance are durable; no provider history/service
  // memory is available, yet the exact Answer→Problem→Practice route rebuilds.
  const projectsAfterAnswer = new ProjectStore({ storageDirectory: projectDirectory });
  const tasksAfterAnswer = new TaskRuntime({ storageDirectory: taskDirectory });
  const collaborationAfterAnswer = new MissionCollaborationStore({
    storageDirectory: collaborationDirectory,
    projects: projectsAfterAnswer,
    tasks: tasksAfterAnswer,
  });
  const feedbackAfterAnswer = new MissionFeedbackService(projectsAfterAnswer, tasksAfterAnswer, collaborationAfterAnswer);
  const replayedContinuation = await feedbackAfterAnswer.buildPracticeContinuation({
    ...routeIdentity,
    answerExchangeId: answerInput.answerExchangeId,
  });
  assert.deepEqual(replayedContinuation, recorded.continuation, 'restart must reconstruct the same bounded continuation from durable facts');
  assert.equal(replayedContinuation.route.targetMissionId, practiceB.taskId);
  assert.equal(replayedContinuation.practiceMissionId, practiceB.taskId);
  assert.doesNotMatch(JSON.stringify(replayedContinuation), new RegExp(STALE_TRANSCRIPT_SENTINEL));
  const replayedC = tasksAfterAnswer.findTaskBySource(missionFeedbackCognitionSource(routeIdentity));
  assert.equal(replayedC?.taskId, cognitionC.taskId, 'Mission-created source identity must replay to the exact Cognition C');
  assert.equal(replayedC?.source.kind, 'mission');
  assert.match(await fs.readFile(path.join(taskDirectory, `${cognitionC.taskId}.jsonl`), 'utf8'), /"kind":"mission"/);

  const replacementHandoff = buildRenderedContextHandoff(tasksAfterAnswer.getTask(practiceB.taskId), {
    targetWorkerId: 'worker.phase4',
    generatedAt: '2026-09-15T07:30:00.000Z',
    maxChars: 8_000,
    maxWorkerSessions: 0,
  });
  assert.equal(replacementHandoff.package.taskId, practiceB.taskId);
  assert.equal(replacementHandoff.package.missionId, practiceB.taskId);
  assert.equal(replacementHandoff.package.missionPlane, 'practice');
  assert.match(replacementHandoff.text, /Practice B local durable context survives Worker replacement/);
  assert.deepEqual(replacementHandoff.package.workerSessions, [], 'old Worker identities are not a replacement prerequisite');
  assert.doesNotMatch(JSON.stringify(replacementHandoff), new RegExp(STALE_TRANSCRIPT_SENTINEL));
  assert.doesNotMatch(JSON.stringify(replacementHandoff), new RegExp(oldManagedSessionId));
  assert.doesNotMatch(JSON.stringify(replacementHandoff), new RegExp(oldAdapterSessionId));

  let replacementManaged = 0;
  const replacementAdapter = new Phase4FakeAdapter('phase4-replacement-provider');
  const replacementManager = new WorkerSessionManager({
    taskBindings: tasksAfterAnswer,
    newId: () => `phase4-replacement-managed-${++replacementManaged}`,
  });
  await replacementManager.register(replacementAdapter);
  const replacementSession = await replacementManager.createSession('worker.phase4', { model: 'phase4-fake-model' }, practiceB.taskId);
  assert.notEqual(replacementSession.managedSessionId, oldManagedSessionId);
  assert.notEqual(replacementSession.adapterSessionId, oldAdapterSessionId);
  assert.equal(replacementSession.taskId, practiceB.taskId);
  assert.equal(replacementManager.getSession(replacementSession.managedSessionId)?.taskId, practiceB.taskId);

  const replacementInput = buildMissionFeedbackWorkerInput({
    continuation: replayedContinuation,
    practiceMission: tasksAfterAnswer.getTask(practiceB.taskId),
    session: replacementManager.getSession(replacementSession.managedSessionId),
    inputId: 'phase4-replacement-continuation',
    contextHandoff: replacementHandoff,
  });
  assert.match(replacementInput.prompt, /## Same-Mission Context Handoff/);
  assert.match(replacementInput.prompt, /## Cross-Mission Revised Cognition/);
  assert.match(replacementInput.prompt, /Practice B local durable context survives Worker replacement/);
  assert.match(replacementInput.prompt, /Y supersedes assumption X/);
  assert.doesNotMatch(replacementInput.prompt, new RegExp(STALE_TRANSCRIPT_SENTINEL));
  assert.doesNotMatch(replacementInput.prompt, new RegExp(oldManagedSessionId));
  assert.doesNotMatch(replacementInput.prompt, new RegExp(oldAdapterSessionId));
  const replacementEvents = [];
  for await (const event of replacementManager.send(replacementSession.managedSessionId, replacementInput)) replacementEvents.push(event);
  assert.equal(replacementEvents.at(-1)?.type, 'terminal');
  assert.equal(replacementEvents.at(-1)?.status, 'completed');
  assert.equal(replacementManager.getSession(replacementSession.managedSessionId)?.taskId, practiceB.taskId);
  assert.equal(replacementAdapter.inputs.length, 1);
  assert.equal(replacementAdapter.inputs[0].prompt, replacementInput.prompt);
  assert.equal(
    tasksAfterAnswer.listTasks().filter(task => task.mission?.projectId === project.projectId && task.mission?.plane === 'practice').length,
    1,
    'restart replacement must continue original Practice B rather than create B2',
  );

  const unboundSession = await replacementManager.createSession('worker.phase4', { model: 'phase4-fake-model' });
  assert.throws(
    () => buildMissionFeedbackWorkerInput({
      continuation: replayedContinuation,
      practiceMission: tasksAfterAnswer.getTask(practiceB.taskId),
      session: replacementManager.getSession(unboundSession.managedSessionId),
      inputId: 'phase4-unbound-reject',
    }),
    /not bound to a Task\/Mission/,
  );
  const wrongProject = await projectsAfterAnswer.createProject({ title: 'Phase 4 wrong routing Project' });
  const wrongBoundMission = await configureRootMission(tasksAfterAnswer, wrongProject, 'phase4-wrong-bound-mission', 'practice', 'wrong-bound-practice');
  const wrongBoundSession = await replacementManager.createSession('worker.phase4', { model: 'phase4-fake-model' }, wrongBoundMission.taskId);
  assert.throws(
    () => buildMissionFeedbackWorkerInput({
      continuation: replayedContinuation,
      practiceMission: tasksAfterAnswer.getTask(practiceB.taskId),
      session: replacementManager.getSession(wrongBoundSession.managedSessionId),
      inputId: 'phase4-wrong-bound-reject',
    }),
    /is bound to .* not Practice Mission/,
  );
  assert.throws(
    () => buildMissionFeedbackWorkerInput({
      continuation: { ...replayedContinuation, route: { targetMissionId: wrongBoundMission.taskId } },
      practiceMission: tasksAfterAnswer.getTask(practiceB.taskId),
      session: replacementManager.getSession(replacementSession.managedSessionId),
      inputId: 'phase4-wrong-route-reject',
    }),
    /route does not target its originating Practice Mission/,
  );
  assert.throws(
    () => buildMissionFeedbackWorkerInput({
      continuation: { ...replayedContinuation, answer: { ...replayedContinuation.answer, replyToExchangeId: 'wrong-problem' } },
      practiceMission: tasksAfterAnswer.getTask(practiceB.taskId),
      session: replacementManager.getSession(replacementSession.managedSessionId),
      inputId: 'phase4-wrong-reply-reject',
    }),
    /Answer replies to a different Problem/,
  );

  const retiredProbe = await replacementManager.createSession('worker.phase4', { model: 'phase4-fake-model' }, practiceB.taskId);
  await replacementManager.retire(retiredProbe.managedSessionId, { reason: 'phase4-retired-probe' });
  assert.throws(
    () => replacementManager.send(retiredProbe.managedSessionId, { inputId: 'retired-send', prompt: 'must not send' }),
    /retired/,
  );
  replacementAdapter.forcedNextSessionId = retiredProbe.adapterSessionId;
  await assert.rejects(
    () => replacementManager.createSession('worker.phase4', { model: 'phase4-fake-model' }, practiceB.taskId),
    /Adapter session is retired and cannot be reused/,
    'replacement must not resurrect a retired provider-native Worker identity',
  );

  // Required cross-store partial progress: C/configuration succeeds, spawned_by
  // write is interrupted, then retry reuses that exact semantic C and completes.
  const retryProblem = await collaborationAfterAnswer.recordExchange({
    exchangeId: 'phase4-problem-partial-retry',
    projectId: project.projectId,
    sourceMissionId: practiceB.taskId,
    kind: 'Problem',
    payload: {
      currentGoal: 'Prove retry after cross-store partial progress.',
      previousAssumption: 'A failed relation write might require a new Cognition Mission.',
      observedReality: 'Task and collaboration journals have no cross-store transaction.',
      preciseQuestion: 'Can retry reuse the already durable feedback Cognition Mission?',
      blocking: true,
      evidenceExchangeIds: [realityEvidence.exchangeId],
    },
  });
  const retryIdentity = { ...routeIdentity, problemExchangeId: retryProblem.exchangeId };
  const retrySource = missionFeedbackCognitionSource(retryIdentity);
  const originalRetryRecordRelation = collaborationAfterAnswer.recordRelation.bind(collaborationAfterAnswer);
  let interruptSpawnedRelation = true;
  collaborationAfterAnswer.recordRelation = async input => {
    if (interruptSpawnedRelation && input.type === 'spawned_by' && input.basisExchangeId === retryProblem.exchangeId) {
      interruptSpawnedRelation = false;
      throw new Error('INJECTED_SPAWNED_RELATION_INTERRUPTION');
    }
    return originalRetryRecordRelation(input);
  };
  const taskCountBeforePartial = tasksAfterAnswer.listTasks().length;
  await assert.rejects(
    () => feedbackAfterAnswer.ensureCognitionForProblem(retryIdentity),
    /INJECTED_SPAWNED_RELATION_INTERRUPTION/,
  );
  const partialC = tasksAfterAnswer.findTaskBySource(retrySource);
  assert.ok(partialC?.mission, 'Cognition C must remain durably configured when spawned_by write is interrupted');
  assert.equal(partialC.mission.plane, 'cognition');
  assert.equal(collaborationAfterAnswer.getRelation(missionFeedbackSpawnedByRelationId(retryIdentity)), undefined);
  collaborationAfterAnswer.recordRelation = originalRetryRecordRelation;
  const completedRetry = await feedbackAfterAnswer.ensureCognitionForProblem(retryIdentity);
  assert.equal(completedRetry.cognitionMission.taskId, partialC.taskId, 'retry must reuse exact partial-progress C');
  assert.equal(tasksAfterAnswer.listTasks().length, taskCountBeforePartial + 1, 'partial-progress retry must create exactly one Cognition Mission total');
  assert.equal(
    collaborationAfterAnswer.getRelation(missionFeedbackSpawnedByRelationId(retryIdentity))?.basisExchangeId,
    retryProblem.exchangeId,
  );

  // Negative routing validation: wrong Project/source/Problem and wrong Answer
  // target/reply fail closed instead of guessing a route.
  const projectQ = await projectsAfterAnswer.createProject({ title: 'Other Project' });
  await assert.rejects(
    () => feedbackAfterAnswer.ensureCognitionForProblem({ ...routeIdentity, projectId: projectQ.projectId }),
    /does not belong to Project/,
    'wrong Project must fail before orchestration',
  );
  const otherPractice = await configureRootMission(tasksAfterAnswer, project, 'phase4-other-practice', 'practice', 'other-practice');
  await assert.rejects(
    () => feedbackAfterAnswer.ensureCognitionForProblem({ ...routeIdentity, practiceMissionId: otherPractice.taskId }),
    /different Practice Mission/,
    'Problem source Mission is durable routing authority',
  );
  await assert.rejects(
    () => feedbackAfterAnswer.ensureCognitionForProblem({ ...routeIdentity, problemExchangeId: realityEvidence.exchangeId }),
    /requires a Problem exchange/,
    'non-Problem exchange cannot drive feedback orchestration',
  );
  await assert.rejects(
    () => collaborationAfterAnswer.recordExchange({
      exchangeId: 'phase4-answer-wrong-target',
      projectId: project.projectId,
      sourceMissionId: cognitionC.taskId,
      targetMissionId: otherPractice.taskId,
      kind: 'Answer',
      replyToExchangeId: problem.exchangeId,
      payload: { answer: 'wrong target', evidenceExchangeIds: [realityEvidence.exchangeId] },
    }),
    /targetMissionId must route back to the originating Problem Mission/,
  );
  await assert.rejects(
    () => collaborationAfterAnswer.recordExchange({
      exchangeId: 'phase4-answer-wrong-reply',
      projectId: project.projectId,
      sourceMissionId: cognitionC.taskId,
      targetMissionId: practiceB.taskId,
      kind: 'Answer',
      replyToExchangeId: initialFinding.exchangeId,
      payload: { answer: 'wrong reply', evidenceExchangeIds: [realityEvidence.exchangeId] },
    }),
    /must reference a Problem/,
  );

  // An Answer for a different Problem is legal in isolation but cannot be used
  // as the continuation authority for this Problem.
  const otherProblem = await collaborationAfterAnswer.recordExchange({
    exchangeId: 'phase4-problem-other',
    projectId: project.projectId,
    sourceMissionId: practiceB.taskId,
    kind: 'Problem',
    payload: {
      currentGoal: 'Other question',
      previousAssumption: 'Other assumption',
      observedReality: 'Other reality',
      preciseQuestion: 'Other question?',
      blocking: false,
      evidenceExchangeIds: [realityEvidence.exchangeId],
    },
  });
  const otherIdentity = { ...routeIdentity, problemExchangeId: otherProblem.exchangeId };
  const otherAnswer = await feedbackAfterAnswer.recordAnswer({
    ...otherIdentity,
    answerExchangeId: 'phase4-answer-other-problem',
    answer: 'Answer to the other Problem.',
    evidenceExchangeIds: [realityEvidence.exchangeId],
  });
  await assert.rejects(
    () => feedbackAfterAnswer.buildPracticeContinuation({
      ...routeIdentity,
      answerExchangeId: otherAnswer.answer.exchangeId,
    }),
    /replies to a different Problem/,
  );

  // Stable source identity collision must fail closed rather than silently
  // adopting a Task configured with incompatible Mission semantics.
  const collisionProblem = await collaborationAfterAnswer.recordExchange({
    exchangeId: 'phase4-problem-source-collision',
    projectId: project.projectId,
    sourceMissionId: practiceB.taskId,
    kind: 'Problem',
    payload: {
      currentGoal: 'Detect feedback identity collision.',
      previousAssumption: 'Stable source is unclaimed.',
      observedReality: 'A conflicting Task can already claim the same source identity.',
      preciseQuestion: 'Does feedback fail closed on incompatible Mission metadata?',
      blocking: true,
      evidenceExchangeIds: [realityEvidence.exchangeId],
    },
  });
  const collisionIdentity = { ...routeIdentity, problemExchangeId: collisionProblem.exchangeId };
  const collisionTask = await tasksAfterAnswer.ensureTask(missionFeedbackCognitionSource(collisionIdentity), 'Conflicting source claimant');
  await tasksAfterAnswer.configureMission(collisionTask.taskId, {
    projectId: project.projectId,
    rootMissionId: collisionTask.taskId,
    plane: 'cognition',
    missionType: 'conflicting-cognition-purpose',
    completionCriteria: ['Remain intentionally incompatible with Phase 4 feedback Cognition.'],
  });
  await assert.rejects(
    () => feedbackAfterAnswer.ensureCognitionForProblem(collisionIdentity),
    /already configured as a different Mission/,
    'stable source collision must not be repurposed',
  );
  assert.equal(
    collaborationAfterAnswer.getRelation(missionFeedbackSpawnedByRelationId(collisionIdentity)),
    undefined,
    'identity collision must not create misleading spawned_by provenance',
  );

  const finalizationProbe = await replacementManager.createSession('worker.phase4', { model: 'phase4-fake-model' }, practiceB.taskId);
  await tasksAfterAnswer.finalizeMissionStrict(practiceB.taskId, { handoffRequired: false });
  assert.throws(
    () => buildMissionFeedbackWorkerInput({
      continuation: replayedContinuation,
      practiceMission: tasksAfterAnswer.getTask(practiceB.taskId),
      session: replacementManager.getSession(finalizationProbe.managedSessionId),
      inputId: 'phase4-finalized-host-reject',
    }),
    /finalized and cannot receive feedback continuation work/,
  );
  await assert.rejects(
    () => replacementManager.createSession('worker.phase4', { model: 'phase4-fake-model' }, practiceB.taskId),
    /terminal .* cannot create a WorkerSession/,
  );
  const finalizedSend = replacementManager.send(finalizationProbe.managedSessionId, {
    inputId: 'phase4-finalized-send',
    prompt: 'must not run',
  })[Symbol.asyncIterator]();
  await assert.rejects(() => finalizedSend.next(), /retired|terminal/);

  await Promise.all([projectsAfterAnswer.flush(), tasksAfterAnswer.flush(), collaborationAfterAnswer.flush()]);
  const finalCollaborationJournal = await fs.readFile(collaborationJournalPath, 'utf8');
  const finalTaskJournals = await readTaskJournals(taskDirectory);
  assert.doesNotMatch(finalCollaborationJournal, new RegExp(STALE_TRANSCRIPT_SENTINEL));
  assert.doesNotMatch(finalTaskJournals, new RegExp(STALE_TRANSCRIPT_SENTINEL));
  assert.doesNotMatch(finalCollaborationJournal, /"type":"parent_of"/);

  // Final replay proves all successful feedback identities/provenance remain
  // reconstructible without the in-memory services used above.
  const replayProjects = new ProjectStore({ storageDirectory: projectDirectory });
  const replayTasks = new TaskRuntime({ storageDirectory: taskDirectory });
  const replayCollaboration = new MissionCollaborationStore({
    storageDirectory: collaborationDirectory,
    projects: replayProjects,
    tasks: replayTasks,
  });
  const replayFeedback = new MissionFeedbackService(replayProjects, replayTasks, replayCollaboration);
  const finalInput = await replayFeedback.buildCognitionInput(routeIdentity);
  const finalContinuation = await replayFeedback.buildPracticeContinuation({ ...routeIdentity, answerExchangeId: answerInput.answerExchangeId });
  assert.equal(finalInput.cognitionMissionId, cognitionC.taskId);
  assert.deepEqual(finalContinuation, recorded.continuation);
  assert.equal(replayCollaboration.getRelation(spawnedId)?.basisExchangeId, problem.exchangeId);
  assert.equal(replayCollaboration.getExchange(answerInput.answerExchangeId)?.targetMissionId, practiceB.taskId);
  assert.equal(replayCollaboration.getExchange(answerInput.answerExchangeId)?.replyToExchangeId, problem.exchangeId);
  assert.ok(replayCollaboration.getExchange(initialFinding.exchangeId), 'false initial Finding remains replayable as history');
  assert.doesNotMatch(JSON.stringify({ finalInput, finalContinuation }), new RegExp(STALE_TRANSCRIPT_SENTINEL));

  console.log('[smoke] Phase 4 deterministic feedback + live/replacement Worker continuation + unknown-send boundary ok');
  console.log(`[smoke] practice=${practiceB.taskId} cognition=${cognitionC.taskId} oldManaged=${oldManagedSessionId} oldAdapter=${oldAdapterSessionId} replacementManaged=${replacementSession.managedSessionId} replacementAdapter=${replacementSession.adapterSessionId}`);
} finally {
  await Promise.all([
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(projectDirectory, { recursive: true, force: true }),
    fs.rm(collaborationDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
