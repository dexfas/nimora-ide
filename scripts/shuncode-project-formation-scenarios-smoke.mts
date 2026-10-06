import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-phase10-scenarios-'));
const bundlePath = path.join(tempRoot, 'phase10-scenarios.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { ProjectStore, PROJECT_JOURNAL } from './src/project-store.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
      export { MissionCollaborationStore } from './src/mission-collaboration-store.ts';
      export { WorkerSessionManager } from './src/worker-session-manager.ts';
      export { WebWorkerAdapter } from './src/web-worker-adapter.ts';
      export { WebMcpCommandTransport } from './extensions/shuncode/src/webmcp-worker-transport.ts';
      export { ChatGptBrowserCommandTransport } from './extensions/shuncode/src/chatgpt-browser-worker-transport.ts';
      export { createMissionWorkProductionComposition } from './extensions/shuncode/src/mission-work-production-composition.ts';
      export { missionCoordinatorCommandCapabilityName } from './src/mission-coordinator-worker-input.ts';
      export { readProjectMissionPresentation } from './src/project-mission-presentation.ts';
      export { projectLaterRootSource } from './src/project-root-operation-service.ts';
    `,
    resolveDir: root,
    sourcefile: 'phase10-scenarios-entry.ts',
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
  TaskRuntime,
  MissionCollaborationStore,
  WorkerSessionManager,
  WebWorkerAdapter,
  WebMcpCommandTransport,
  ChatGptBrowserCommandTransport,
  createMissionWorkProductionComposition,
  missionCoordinatorCommandCapabilityName,
  readProjectMissionPresentation,
  projectLaterRootSource,
} = require(bundlePath);

const PROVIDER_TRANSCRIPT_SENTINEL = 'SCENARIO_A_PROVIDER_PRIVATE_TRANSCRIPT_SENTINEL';
let tick = 0;
const now = () => new Date(Date.UTC(2026, 8, 18, 0, 0, tick++));

function idFactory(prefix) {
  let seq = 0;
  return () => `${prefix}-${++seq}`;
}

async function ensureDirectory(name) {
  const directory = path.join(tempRoot, name);
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

function resource(pageId, identityChar, origin) {
  return {
    pageId,
    href: `${origin}/chat`,
    origin,
    site: 'generic',
    nativeMcpBypass: false,
    composerFound: true,
    isDeepSeekAuthPage: false,
    runtimeVersion: 25,
    runtimeEnabled: true,
    workerTurnState: 'idle',
    sessionIdentityCompatible: true,
    ready: true,
    resourceIdentity: identityChar.repeat(64),
  };
}

function resources(prefix, count) {
  const result = [];
  const hex = '0123456789abcdef';
  for (let index = 0; index < count; index += 1) {
    result.push(resource(`${prefix}-page-${index + 1}`, hex[index % hex.length], `https://${prefix}-${index + 1}.example`));
  }
  return result;
}

class ControlledWebMcpCommands {
  constructor(initialResources) {
    this.resources = initialResources.map(value => structuredClone(value));
  }

  calls = [];
  sends = [];
  resolves = [];
  disconnects = [];
  expectedCoordinatorByInputId = new Map();
  sessions = new Map();
  connectSequence = 0;
  forcedNextConnectSessionId = undefined;

  async executeCommand(command, arg) {
    this.calls.push({ command, arg: arg === undefined ? undefined : structuredClone(arg) });
    switch (command) {
      case '_shuncode.chatgptWorker.listResources':
        return [];
      case '_shuncode.webMcp.workerListResources':
        return this.resources.map(value => structuredClone(value));
      case '_shuncode.webMcp.workerProbeResource': {
        const found = this.resources.find(value => value.pageId === arg.pageId);
        return found ? structuredClone(found) : undefined;
      }
      case '_shuncode.webMcp.workerConnect': {
        const target = arg.target;
        const found = this.resources.find(value => value.pageId === target?.pageId && value.resourceIdentity === target?.resourceIdentity);
        if (!found) throw new Error('CONTROLLED_EXACT_WEBMCP_TARGET_NOT_FOUND');
        const sessionId = this.forcedNextConnectSessionId ?? `${found.pageId}:provider-session:${++this.connectSequence}`;
        this.forcedNextConnectSessionId = undefined;
        found.pageSessionId = sessionId;
        this.sessions.set(sessionId, { pageId: found.pageId });
        return {
          pageId: found.pageId,
          sessionId,
          site: found.site,
          origin: found.origin,
          href: found.href,
          transport: 'controlled-production-equivalent-webmcp',
          status: { enabled: true, composerFound: true },
        };
      }
      case '_shuncode.webMcp.workerHealth':
        return { status: { enabled: true, composerFound: true, isDeepSeekAuthPage: false } };
      case '_shuncode.webMcp.workerSend': {
        this.sends.push({ pageId: arg.pageId, sessionId: arg.sessionId, input: structuredClone(arg.input) });
        const expectedCommand = this.expectedCoordinatorByInputId.get(arg.input.inputId);
        if (expectedCommand) {
          return {
            inputId: arg.input.inputId,
            state: 'completed',
            text: 'exact coordinator command transported',
            events: [
              {
                seq: 1,
                type: 'capability_call',
                callId: `call:${arg.input.inputId}`,
                name: missionCoordinatorCommandCapabilityName(expectedCommand),
                arguments: {},
                dispatch: 'host-requested',
              },
              { seq: 2, type: 'completed', text: 'exact coordinator command transported' },
            ],
          };
        }
        const providerText = arg.input.inputId === 'scenario-a-practice-target-1'
          ? PROVIDER_TRANSCRIPT_SENTINEL
          : `controlled completed ${arg.input.inputId}`;
        return {
          inputId: arg.input.inputId,
          state: 'completed',
          text: providerText,
          events: [
            { seq: 1, type: 'text_delta', text: providerText },
            { seq: 2, type: 'completed', text: providerText },
          ],
        };
      }
      case '_shuncode.webMcp.workerResolve':
        this.resolves.push(structuredClone(arg));
        return { ok: true };
      case '_shuncode.webMcp.workerPoll':
        throw new Error('Controlled sends are terminal in the first snapshot.');
      case '_shuncode.webMcp.workerInterrupt':
        return { ok: true };
      case '_shuncode.webMcp.workerDisconnect': {
        this.disconnects.push(structuredClone(arg));
        this.sessions.delete(arg.sessionId);
        const found = this.resources.find(value => value.pageSessionId === arg.sessionId);
        if (found) delete found.pageSessionId;
        return { ok: true };
      }
      default:
        throw new Error(`Unexpected controlled WebMCP command: ${command}`);
    }
  }
}

async function createEnvironment(name, resourceSet, directories) {
  const projectsDirectory = directories?.projectsDirectory ?? await ensureDirectory(`${name}-projects`);
  const tasksDirectory = directories?.tasksDirectory ?? await ensureDirectory(`${name}-tasks`);
  const collaborationDirectory = directories?.collaborationDirectory ?? await ensureDirectory(`${name}-collaboration`);
  const projects = new ProjectStore({ storageDirectory: projectsDirectory, newId: idFactory(`${name}-project`), now });
  const tasks = new TaskRuntime({ storageDirectory: tasksDirectory, newId: idFactory(`${name}-task`), now });
  const collaboration = new MissionCollaborationStore({
    storageDirectory: collaborationDirectory,
    projects,
    tasks,
    newId: idFactory(`${name}-exchange`),
    now,
  });
  const workers = new WorkerSessionManager({
    taskBindings: tasks,
    executionProjection: tasks,
    newId: idFactory(`${name}-managed`),
    now,
  });
  const commands = new ControlledWebMcpCommands(resourceSet);
  const transport = new WebMcpCommandTransport(commands, { pollIntervalMs: 1, now });
  await workers.register(new WebWorkerAdapter(transport));
  await workers.register(new WebWorkerAdapter(new ChatGptBrowserCommandTransport(commands), 'nimora.chatgpt-browser-worker'));
  const owners = { projects, tasks, collaboration, workers };
  const composition = createMissionWorkProductionComposition(owners, commands);
  return {
    projectsDirectory,
    tasksDirectory,
    collaborationDirectory,
    projects,
    tasks,
    collaboration,
    workers,
    commands,
    composition,
  };
}

async function projectEvents(projectsDirectory) {
  const text = await fs.readFile(path.join(projectsDirectory, PROJECT_JOURNAL), 'utf8');
  return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function phase8Spec(profile) {
  return {
    profile,
    budget: {
      maxInstructionChars: 30_000,
      maxContextChars: 50_000,
      maxSkillChars: 10_000,
      maxSchemaChars: 50_000,
      maxCombinedChars: 120_000,
    },
  };
}

async function assign(application, scope, missionId) {
  const result = await application.assignInitialWorker({
    projectId: scope.projectId,
    rootMissionId: scope.managedRootMissionId,
    missionId,
    constraints: { allowedKinds: ['web'] },
  });
  assert.equal(result.state, 'assigned');
  return result.assignment;
}

async function coordinatorTurn(state, outerInputId, command) {
  state.commands.expectedCoordinatorByInputId.set(outerInputId, command);
  try {
    return await state.composition.application.executeCoordinatorCommandTurn({
      projectId: state.scope.projectId,
      managedRootMissionId: state.scope.managedRootMissionId,
      coordinationMissionId: state.coordinatorMissionId,
      managedSessionId: state.coordinatorManagedSessionId,
      inputId: outerInputId,
      command,
    });
  } finally {
    state.commands.expectedCoordinatorByInputId.delete(outerInputId);
  }
}

function ensureMissionCommand(scope, input) {
  return { kind: 'ensureMission', arguments: { ...scope, ...input } };
}

function explicitInputCommand(scope, coordinationMissionId, targetMissionId, managedSessionId, inputId, instructionKind, instruction, profile) {
  return {
    kind: 'deliverExplicitMissionInput',
    arguments: {
      ...scope,
      coordinationMissionId,
      targetMissionId,
      managedSessionId,
      inputId,
      instructionKind,
      instruction,
      phase8Materialization: phase8Spec(profile),
    },
  };
}

function completeCommand(scope, coordinationMissionId, completionKey) {
  return { kind: 'completeManagedScope', arguments: { ...scope, coordinationMissionId, completionKey } };
}

function semantic(value) {
  return JSON.parse(JSON.stringify(value));
}

try {
  const envA = await createEnvironment('scenario-a', resources('scenario-a', 10));
  const formationId = envA.composition.application.mintFormationId();
  const formationOutcome = {
    formationId,
    classification: 'clear-intent',
    project: {
      title: 'Static personal blog',
      goal: 'Complete one static personal blog.',
      workspace: '/workspace/static-blog',
    },
    initialRoot: {
      goal: 'Complete the bounded static personal blog requested by the user.',
      plane: 'practice',
      missionType: 'automatic-project-root',
      completionCriteria: ['The static personal blog is implemented and independently verified.'],
      contextSummary: 'User intent: 完成一个静态个人博客. Scope is the static personal blog only.',
      constraints: ['Do not add unrelated product scope.'],
    },
  };
  const formed = await envA.composition.application.submitCognitionOutcome(formationOutcome);
  assert.equal(formed.state, 'formed');
  const projectId = formed.project.projectId;
  const rootAId = formed.rootMission.taskId;
  const coordinatorAId = formed.coordinatorMission.taskId;
  const originalFormationReceipt = semantic(formed.project.formationReceipt);
  const formationText = JSON.stringify(originalFormationReceipt).toLowerCase();
  for (const forbidden of ['music player', 'synchronized lyrics', 'deployment target']) {
    assert.equal(formationText.includes(forbidden), false, `Scenario A Formation Result must not smuggle unrelated scope: ${forbidden}`);
  }
  assert.equal((await projectEvents(envA.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 1);

  const scopeA = { projectId, managedRootMissionId: rootAId };
  const coordinatorAAssignment = await assign(envA.composition.application, scopeA, coordinatorAId);
  const stateA = {
    ...envA,
    scope: scopeA,
    coordinatorMissionId: coordinatorAId,
    coordinatorManagedSessionId: coordinatorAAssignment.managedSessionId,
  };

  await assert.rejects(
    () => envA.composition.application.finalizeSupportMission({ projectId, missionId: rootAId }),
    /must be finalized through completeManagedScope/,
    'production application must not bypass managed root completion',
  );
  await assert.rejects(
    () => envA.composition.application.recoverManagedScopeCompletion({
      projectId,
      managedRootMissionId: rootAId,
      coordinationMissionId: coordinatorAId,
      completionKey: 'scenario-a-illegal-active-recovery',
    }),
    /requires existing durable partial finalization state/,
  );

  const researchEnsure = ensureMissionCommand(scopeA, {
    operationKey: 'scenario-a-research',
    goal: 'Research the current static-blog workspace and bounded implementation constraints.',
    parentMissionId: rootAId,
    plane: 'cognition',
    missionType: 'scenario-a-research',
    completionCriteria: ['Produce bounded evidence for the static-blog implementation.'],
  });
  const researchCreated = await coordinatorTurn(stateA, 'coord-a-ensure-research', researchEnsure);
  const researchId = researchCreated.commandResult.missionId;
  const researchAssignment = await assign(envA.composition.application, scopeA, researchId);
  const researchDelivery = await coordinatorTurn(
    stateA,
    'coord-a-deliver-research',
    explicitInputCommand(
      scopeA,
      coordinatorAId,
      researchId,
      researchAssignment.managedSessionId,
      'scenario-a-research-target-1',
      'bounded-research',
      'Inspect only the current static-blog workspace and report implementation-relevant facts.',
      'research',
    ),
  );
  assert.equal(researchDelivery.commandResult.terminalStatus, 'completed');

  const practiceEnsure = ensureMissionCommand(scopeA, {
    operationKey: 'scenario-a-practice',
    goal: 'Implement the bounded static personal blog from current owner-backed research.',
    parentMissionId: rootAId,
    plane: 'practice',
    missionType: 'scenario-a-practice',
    completionCriteria: ['Implement the static-blog change and surface blocking Reality as typed Evidence/Problem.'],
  });
  const practiceCreated = await coordinatorTurn(stateA, 'coord-a-ensure-practice', practiceEnsure);
  const practiceId = practiceCreated.commandResult.missionId;
  const practiceAssignment = await assign(envA.composition.application, scopeA, practiceId);
  const practiceDelivery = await coordinatorTurn(
    stateA,
    'coord-a-deliver-practice',
    explicitInputCommand(
      scopeA,
      coordinatorAId,
      practiceId,
      practiceAssignment.managedSessionId,
      'scenario-a-practice-target-1',
      'bounded-practice',
      'Implement only the static personal blog. Surface a blocking Problem if measured Reality invalidates the current assumption.',
      'practice',
    ),
  );
  assert.equal(practiceDelivery.commandResult.terminalStatus, 'completed');

  const activeBlocked = await coordinatorTurn(stateA, 'coord-a-complete-blocked-active', completeCommand(scopeA, coordinatorAId, 'scenario-a-active-blocker'));
  assert.equal(activeBlocked.commandResult.ready, false);
  assert.ok(activeBlocked.commandResult.blockers.some(blocker => blocker.code === 'active-descendant'));
  assert.equal(activeBlocked.postTurnCompletion, undefined);

  const practiceEvidence = await envA.collaboration.recordExchange({
    exchangeId: 'scenario-a-practice-evidence',
    projectId,
    sourceMissionId: practiceId,
    kind: 'Evidence',
    payload: {
      summary: 'Measured static-blog Reality shows the navigation assumption is incomplete.',
      references: [{ type: 'command', command: 'scenario-a-static-blog-check', observation: 'navigation requires one bounded correction' }],
    },
  });
  const problem = await envA.collaboration.recordExchange({
    exchangeId: 'scenario-a-practice-problem',
    projectId,
    sourceMissionId: practiceId,
    kind: 'Problem',
    payload: {
      currentGoal: 'Complete the bounded static personal blog.',
      previousAssumption: 'The initial navigation assumption was sufficient.',
      observedReality: 'Measured Evidence shows one bounded navigation correction is required.',
      preciseQuestion: 'Should the same Practice Mission continue with that bounded correction?',
      blocking: true,
      evidenceExchangeIds: [practiceEvidence.exchangeId],
    },
  });
  const unresolvedBlocked = await coordinatorTurn(stateA, 'coord-a-complete-blocked-problem', completeCommand(scopeA, coordinatorAId, 'scenario-a-problem-blocker'));
  assert.equal(unresolvedBlocked.commandResult.ready, false);
  assert.ok(unresolvedBlocked.commandResult.blockers.some(blocker => blocker.code === 'unresolved-blocking-problem'));
  assert.equal(unresolvedBlocked.postTurnCompletion, undefined);

  const routeCommand = {
    kind: 'routePracticeProblem',
    arguments: { ...scopeA, practiceMissionId: practiceId, problemExchangeId: problem.exchangeId },
  };
  const routed = await coordinatorTurn(stateA, 'coord-a-route-problem', routeCommand);
  const feedbackCognitionId = routed.commandResult.cognitionMission.missionId;
  const feedbackCognition = envA.tasks.getTask(feedbackCognitionId);
  assert.equal(feedbackCognition.mission.rootMissionId, feedbackCognitionId, 'accepted Phase 4 feedback Cognition remains its own root scope');
  assert.equal(feedbackCognition.mission.parentMissionId, undefined);

  const answerEvidence = await envA.collaboration.recordExchange({
    exchangeId: 'scenario-a-answer-evidence',
    projectId,
    sourceMissionId: feedbackCognitionId,
    targetMissionId: practiceId,
    kind: 'Evidence',
    payload: {
      summary: 'Bounded Cognition confirms the correction stays inside the static-blog goal.',
      references: [{ type: 'command', command: 'scenario-a-feedback-review', observation: 'same Practice continuation is sufficient' }],
    },
  });
  const recordedAnswer = await envA.composition.feedback.recordAnswer({
    projectId,
    practiceMissionId: practiceId,
    problemExchangeId: problem.exchangeId,
    answerExchangeId: 'scenario-a-feedback-answer',
    answer: 'Continue the same Practice Mission with the bounded navigation correction only.',
    evidenceExchangeIds: [answerEvidence.exchangeId],
    limitations: 'No music, lyrics, deployment, or unrelated product scope is authorized by this Answer.',
  });
  assert.equal(recordedAnswer.answer.payload.evidenceExchangeIds[0], answerEvidence.exchangeId);
  assert.match(recordedAnswer.answer.payload.limitations, /No music, lyrics, deployment/);

  const continuationCommand = {
    kind: 'deliverFeedbackContinuation',
    arguments: {
      ...scopeA,
      coordinationMissionId: coordinatorAId,
      practiceMissionId: practiceId,
      problemExchangeId: problem.exchangeId,
      answerExchangeId: recordedAnswer.answer.exchangeId,
      managedSessionId: practiceAssignment.managedSessionId,
      inputId: 'scenario-a-practice-continuation-1',
    },
  };
  const continuation = await coordinatorTurn(stateA, 'coord-a-feedback-continuation', continuationCommand);
  assert.equal(continuation.commandResult.terminalStatus, 'completed');
  assert.equal(
    envA.tasks.listTasks().filter(task => task.mission?.projectId === projectId && task.mission?.plane === 'practice' && task.goal === practiceEnsure.arguments.goal).length,
    1,
    'feedback must continue the exact same Practice Mission rather than create Practice B2',
  );

  const verificationEnsure = ensureMissionCommand(scopeA, {
    operationKey: 'scenario-a-verification',
    goal: 'Freshly verify the static-blog result from canonical owner/workspace truth.',
    parentMissionId: rootAId,
    plane: 'cognition',
    missionType: 'scenario-a-independent-verification',
    completionCriteria: ['Independently verify the bounded static-blog completion without Practice transcript inheritance.'],
  });
  const verificationCreated = await coordinatorTurn(stateA, 'coord-a-ensure-verification', verificationEnsure);
  const verificationId = verificationCreated.commandResult.missionId;
  const verificationAssignment = await assign(envA.composition.application, scopeA, verificationId);
  assert.notEqual(verificationAssignment.managedSessionId, practiceAssignment.managedSessionId);
  assert.notEqual(
    envA.workers.getSession(verificationAssignment.managedSessionId).adapterSessionId,
    envA.workers.getSession(practiceAssignment.managedSessionId).adapterSessionId,
    'Verification must use a fresh provider-native WorkerSession',
  );
  const verificationDelivery = await coordinatorTurn(
    stateA,
    'coord-a-deliver-verification',
    explicitInputCommand(
      scopeA,
      coordinatorAId,
      verificationId,
      verificationAssignment.managedSessionId,
      'scenario-a-verification-target-1',
      'fresh-verification',
      'Verify the static personal blog from current workspace and canonical Project/Mission evidence only.',
      'research',
    ),
  );
  assert.equal(verificationDelivery.commandResult.terminalStatus, 'completed');
  const verificationTargetInput = envA.commands.sends.find(send => send.input.inputId === 'scenario-a-verification-target-1').input;
  assert.equal(JSON.stringify(verificationTargetInput).includes(PROVIDER_TRANSCRIPT_SENTINEL), false, 'Verification input must not inherit Practice provider transcript');

  for (const missionId of [researchId, practiceId, verificationId]) {
    const finalized = await envA.composition.application.finalizeSupportMission({ projectId, missionId, requireHandoff: true });
    assert.equal(finalized.mission.missionFinalization.state, 'archived');
  }
  const feedbackFinalized = await envA.composition.application.finalizeSupportMission({ projectId, missionId: feedbackCognitionId, requireHandoff: true });
  assert.equal(feedbackFinalized.mission.missionFinalization.state, 'archived');
  for (const missionId of [researchId, practiceId, verificationId, feedbackCognitionId]) {
    assert.equal(envA.tasks.getTask(missionId).missionFinalization.state, 'archived');
  }

  const completionA = await coordinatorTurn(stateA, 'coord-a-complete-ready', completeCommand(scopeA, coordinatorAId, 'scenario-a-final-completion'));
  assert.equal(completionA.commandResult.ready, true);
  assert.equal(completionA.postTurnCompletion.coordinator.state, 'archived');
  assert.equal(completionA.postTurnCompletion.root.state, 'archived');
  assert.equal(envA.tasks.getTask(coordinatorAId).missionFinalization.state, 'archived');
  assert.equal(envA.tasks.getTask(rootAId).missionFinalization.state, 'archived');
  assert.ok(envA.workers.getRetiredSession(coordinatorAAssignment.managedSessionId), 'Coordinator Worker must be retired by completion');
  assert.equal(envA.workers.getSession(coordinatorAAssignment.managedSessionId), undefined);
  assert.ok(envA.projects.getProject(projectId), 'Project remains durable after managed root death');
  assert.equal((await projectEvents(envA.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 1);

  const oldAdapterSessionIds = envA.tasks.listTasks()
    .filter(task => task.mission?.projectId === projectId)
    .flatMap(task => Object.values(task.workerSessions).map(worker => worker.adapterSessionId));
  assert.ok(oldAdapterSessionIds.length >= 4);
  for (const task of envA.tasks.listTasks().filter(task => task.mission?.projectId === projectId)) {
    for (const worker of Object.values(task.workerSessions)) assert.ok(worker.retiredAt, `Scenario A Worker ref must be retired: ${worker.managedSessionId}`);
  }

  const presentationBeforeRestart = await readProjectMissionPresentation({
    projects: envA.projects,
    tasks: envA.tasks,
    collaboration: envA.collaboration,
  });
  const aRootPresentation = presentationBeforeRestart.missions.find(mission => mission.missionId === rootAId);
  const aCoordinatorPresentation = presentationBeforeRestart.missions.find(mission => mission.missionId === coordinatorAId);
  assert.equal(aRootPresentation.terminal, true);
  assert.equal(aRootPresentation.presentationState, 'archived');
  assert.equal(aCoordinatorPresentation.terminal, true);
  assert.equal(aCoordinatorPresentation.presentationState, 'archived');

  const envB = await createEnvironment('scenario-b-restart', resources('scenario-b', 8), {
    projectsDirectory: envA.projectsDirectory,
    tasksDirectory: envA.tasksDirectory,
    collaborationDirectory: envA.collaborationDirectory,
  });
  const presentationAfterRestart = await readProjectMissionPresentation({
    projects: envB.projects,
    tasks: envB.tasks,
    collaboration: envB.collaboration,
  });
  assert.deepEqual(semantic(presentationAfterRestart), semantic(presentationBeforeRestart), 'fresh canonical owners must reconstruct equivalent Phase 9 semantic presentation');
  assert.equal(envB.workers.listSessions().length, 0, 'fresh WorkerSessionManager must reconstruct zero live Scenario-A Worker authority');
  assert.deepEqual(semantic(envB.projects.getProject(projectId).formationReceipt), originalFormationReceipt);
  assert.equal(envB.tasks.getTask(rootAId).missionFinalization.state, 'archived');
  assert.equal(envB.tasks.getTask(coordinatorAId).missionFinalization.state, 'archived');

  const oldRevivalDiscoveryBefore = envB.commands.calls.filter(call => call.command === '_shuncode.webMcp.workerListResources').length;
  await assert.rejects(
    () => envB.composition.application.assignInitialWorker({
      projectId,
      rootMissionId: rootAId,
      missionId: coordinatorAId,
      constraints: { allowedKinds: ['web'] },
    }),
    /terminal|finalized|cannot accept|cannot.*Worker/i,
    'terminal Scenario-A Coordinator must not accept a fresh binding after restart',
  );
  assert.equal(envB.commands.calls.filter(call => call.command === '_shuncode.webMcp.workerListResources').length, oldRevivalDiscoveryBefore, 'old Coordinator revival must fail before candidate discovery');
  const oldCoordinatorEnsure = await envB.composition.coordinator.ensureCoordinatorMission({ projectId, managedRootMissionId: rootAId });
  assert.equal(oldCoordinatorEnsure.taskId, coordinatorAId);
  assert.equal(oldCoordinatorEnsure.missionFinalization.state, 'archived', 'deterministic lookup may reconstruct identity but cannot revive terminal Coordinator');

  const laterRootOperation = {
    rootOperationId: 'scenario-b-add-synchronized-lyrics-v1',
    projectId,
    goal: 'Add synchronized lyrics to the existing static personal blog.',
    plane: 'practice',
    missionType: 'later-project-root',
    completionCriteria: ['Synchronized lyrics are added and verified without changing Project identity.'],
    contextSummary: 'Use the current static-blog workspace and canonical Project state; add synchronized lyrics only.',
    constraints: ['Do not recreate the Project or inherit Scenario-A provider transcript/session state.'],
  };
  const laterB = await envB.composition.application.ensureLaterProjectRoot(laterRootOperation);
  const rootBId = laterB.rootMission.taskId;
  const coordinatorBId = laterB.coordinatorMission.taskId;
  assert.equal(laterB.project.projectId, projectId);
  assert.notEqual(rootBId, rootAId);
  assert.notEqual(coordinatorBId, coordinatorAId);
  assert.equal(laterB.rootMission.mission.rootMissionId, rootBId);
  assert.equal(laterB.rootMission.mission.parentMissionId, undefined);
  assert.deepEqual(semantic(laterB.project.formationReceipt), originalFormationReceipt);
  assert.equal((await projectEvents(envB.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 1, 'Scenario B must not create a second Project');

  const laterBRetry = await envB.composition.application.ensureLaterProjectRoot(laterRootOperation);
  assert.equal(laterBRetry.rootMission.taskId, rootBId);
  assert.equal(laterBRetry.coordinatorMission.taskId, coordinatorBId);
  await assert.rejects(
    () => envB.composition.application.ensureLaterProjectRoot({ ...laterRootOperation, goal: 'Changed semantics under the same operation identity.' }),
    /identity\/content collision/,
  );

  const sourceB = projectLaterRootSource(laterRootOperation, envB.projects.getProject(projectId).workspace);
  assert.equal(envB.tasks.listTasks().filter(task => task.source.kind === sourceB.kind && task.source.key === sourceB.key).length, 1);

  const scopeB = { projectId, managedRootMissionId: rootBId };
  const oldProviderNativeSessionId = oldAdapterSessionIds[0];
  envB.commands.forcedNextConnectSessionId = oldProviderNativeSessionId;
  const connectBeforeRetiredReuse = envB.commands.calls.filter(call => call.command === '_shuncode.webMcp.workerConnect').length;
  await assert.rejects(
    () => envB.composition.application.assignInitialWorker({
      projectId,
      rootMissionId: rootBId,
      missionId: coordinatorBId,
      constraints: { allowedKinds: ['web'] },
    }),
    /retired and cannot be reused|create\/bind failed/i,
    'fresh Scenario-B assignment must reject a provider-native identity retired by Scenario A',
  );
  assert.equal(envB.commands.calls.filter(call => call.command === '_shuncode.webMcp.workerConnect').length, connectBeforeRetiredReuse + 1, 'create failure must not silently fallback to another candidate in the same call');

  const coordinatorBAssignment = await assign(envB.composition.application, scopeB, coordinatorBId);
  assert.equal(oldAdapterSessionIds.includes(envB.workers.getSession(coordinatorBAssignment.managedSessionId).adapterSessionId), false);
  const rootBAssignment = await assign(envB.composition.application, scopeB, rootBId);
  assert.equal(oldAdapterSessionIds.includes(envB.workers.getSession(rootBAssignment.managedSessionId).adapterSessionId), false);
  const stateB = {
    ...envB,
    scope: scopeB,
    coordinatorMissionId: coordinatorBId,
    coordinatorManagedSessionId: coordinatorBAssignment.managedSessionId,
  };

  const deliveryB = await coordinatorTurn(
    stateB,
    'coord-b-deliver-root',
    explicitInputCommand(
      scopeB,
      coordinatorBId,
      rootBId,
      rootBAssignment.managedSessionId,
      'scenario-b-root-target-1',
      'later-root-work',
      'Add synchronized lyrics to the existing static blog using current workspace and canonical Project/Handoff/Evidence truth only.',
      'practice',
    ),
  );
  assert.equal(deliveryB.commandResult.terminalStatus, 'completed');
  const scenarioBInput = envB.commands.sends.find(send => send.input.inputId === 'scenario-b-root-target-1').input;
  const scenarioBInputText = JSON.stringify(scenarioBInput);
  assert.match(scenarioBInput.prompt, /Add synchronized lyrics/);
  assert.equal(scenarioBInputText.includes(PROVIDER_TRANSCRIPT_SENTINEL), false);
  assert.equal(scenarioBInputText.includes('contextHandle'), false);
  for (const oldId of oldAdapterSessionIds) assert.equal(scenarioBInputText.includes(oldId), false, `Scenario-B Worker input must not inherit old provider locator ${oldId}`);

  const completionB = await coordinatorTurn(stateB, 'coord-b-complete-ready', completeCommand(scopeB, coordinatorBId, 'scenario-b-final-completion'));
  assert.equal(completionB.commandResult.ready, true);
  assert.equal(completionB.postTurnCompletion.coordinator.state, 'archived');
  assert.equal(completionB.postTurnCompletion.root.state, 'archived');
  assert.equal(envB.tasks.getTask(rootAId).missionFinalization.state, 'archived');
  assert.equal(envB.tasks.getTask(coordinatorAId).missionFinalization.state, 'archived');
  assert.equal(envB.tasks.getTask(rootBId).missionFinalization.state, 'archived');
  assert.equal(envB.tasks.getTask(coordinatorBId).missionFinalization.state, 'archived');
  assert.equal((await projectEvents(envB.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 1);
  assert.deepEqual(semantic(envB.projects.getProject(projectId).formationReceipt), originalFormationReceipt);

  const envBRestart = await createEnvironment('scenario-b-final-restart', resources('scenario-b-final', 4), {
    projectsDirectory: envA.projectsDirectory,
    tasksDirectory: envA.tasksDirectory,
    collaborationDirectory: envA.collaborationDirectory,
  });
  const laterBAfterRestart = await envBRestart.composition.application.ensureLaterProjectRoot(laterRootOperation);
  assert.equal(laterBAfterRestart.rootMission.taskId, rootBId);
  assert.equal(laterBAfterRestart.coordinatorMission.taskId, coordinatorBId);
  assert.equal(laterBAfterRestart.rootMission.missionFinalization.state, 'archived');
  assert.equal(laterBAfterRestart.coordinatorMission.missionFinalization.state, 'archived');
  assert.equal(envBRestart.tasks.listTasks().filter(task => task.source.kind === sourceB.kind && task.source.key === sourceB.key).length, 1, 'Scenario-B retry/restart must reconstruct exactly one later root');
  assert.equal(envBRestart.workers.listSessions().length, 0);
  assert.equal((await projectEvents(envBRestart.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 1);

  const ownerFiles = [
    ...(await fs.readdir(envBRestart.projectsDirectory)),
    ...(await fs.readdir(envBRestart.tasksDirectory)),
    ...(await fs.readdir(envBRestart.collaborationDirectory)),
  ];
  assert.equal(ownerFiles.some(name => /(scheduler|outbox|transcript|root.?registry|provider.?history|assignment.?ledger)/i.test(name)), false);

  console.log(JSON.stringify({
    result: 'PASS',
    projectCreatedAcrossAAndB: 1,
    scenarioA: {
      rootArchived: true,
      coordinatorArchived: true,
      samePracticeContinuation: true,
      freshVerificationWorker: true,
      blockingProblemObserved: true,
      activeDescendantObserved: true,
    },
    productionCompletion: 'MissionCoordinatorCompletionService + MissionFinalizationService through trustworthy completed Coordinator turn',
    restart: 'fresh canonical owners reconstruct equivalent Phase 9 presentation with zero live old WorkerSession authority',
    scenarioB: {
      sameProject: true,
      deterministicLaterRoot: true,
      freshCoordinator: true,
      oldCoordinatorRevival: false,
      oldProviderNativeSessionReuse: false,
      providerTranscriptInheritance: false,
      archived: true,
    },
    forbiddenStateOwnersCreated: false,
  }, null, 2));
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
