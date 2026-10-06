import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p7-e2e-task-'));
const projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p7-e2e-project-'));
const collaborationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p7-e2e-collab-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p7-e2e-bundle-'));
const bundlePath = path.join(bundleDirectory, 'phase7-e2e.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { ProjectStore } from './src/project-store.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
      export { MissionCollaborationStore } from './src/mission-collaboration-store.ts';
      export { MissionFeedbackService, missionFeedbackCognitionSource } from './src/mission-feedback-service.ts';
      export { MissionCoordinatorService } from './src/mission-coordinator-service.ts';
      export { MissionCoordinatorLiveDriver } from './src/mission-coordinator-live-driver.ts';
      export { ProjectDecisionService } from './src/project-decision-service.ts';
      export { WorkerSessionManager } from './src/worker-session-manager.ts';
      export {
        MissionWorkerAssignmentService,
        WorkerAssignmentCandidateUnavailableError,
        WorkerAssignmentCreateFailedError,
        WorkerAssignmentConflictError,
      } from './src/worker-assignment.ts';
      export { MissionFinalizationService } from './src/mission-finalization-service.ts';
      export { buildRenderedContextHandoff } from './src/context-handoff.ts';
      export { MissionContextMaterializer } from './src/mission-context-materializer.ts';
      export { MissionCapabilityMaterializer } from './src/mission-capability-materializer.ts';
      export { CORE_MISSION_CAPABILITY_SCHEMA_SOURCES } from './src/mission-capability-schema-source.ts';
      export { NimoraSkillIndex } from './src/mission-skill-index.ts';
      export { MissionSkillMaterializer } from './src/mission-skill-materializer.ts';
      export { MissionWorkerInputMaterializer } from './src/mission-worker-input-materializer.ts';
    `,
    resolveDir: root,
    sourcefile: 'phase7-e2e-entry.ts',
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
  MissionFeedbackService,
  missionFeedbackCognitionSource,
  MissionCoordinatorService,
  MissionCoordinatorLiveDriver,
  ProjectDecisionService,
  WorkerSessionManager,
  MissionWorkerAssignmentService,
  WorkerAssignmentCandidateUnavailableError,
  WorkerAssignmentCreateFailedError,
  WorkerAssignmentConflictError,
  MissionFinalizationService,
  buildRenderedContextHandoff,
  MissionContextMaterializer,
  MissionCapabilityMaterializer,
  CORE_MISSION_CAPABILITY_SCHEMA_SOURCES,
  NimoraSkillIndex,
  MissionSkillMaterializer,
  MissionWorkerInputMaterializer,
} = require(bundlePath);

const PROVIDER_TRANSCRIPT_SENTINEL = 'P7_PROVIDER_TRANSCRIPT_SENTINEL_MUST_NOT_PERSIST';
const RAW_OUTPUT_SENTINEL = 'P7_RAW_PROVIDER_OUTPUT_MUST_NOT_BECOME_AUTHORITY';
const RAW_PAGE_ID_SENTINEL = 'p7-private-page-id-sentinel';
let projectSeq = 0;
let taskSeq = 0;
let managedSeq = 0;
let tick = 0;
const now = () => new Date(Date.UTC(2026, 8, 16, 6, 0, tick++));
const newProjectId = () => `p7-e2e-project-${++projectSeq}`;
const newTaskId = () => `p7-e2e-task-${++taskSeq}`;
const newManagedId = () => `p7-e2e-managed-${++managedSeq}`;

const phase8Spec = profile => ({
  profile,
  budget: {
    maxInstructionChars: 20_000,
    maxContextChars: 50_000,
    maxSkillChars: 10_000,
    maxSchemaChars: 50_000,
    maxCombinedChars: 120_000,
  },
  capability: profile === 'practice'
    ? { requiredCapabilityIds: ['workspace.read-files', 'workspace.apply-patch'] }
    : { requiredCapabilityIds: ['workspace.read-files'] },
});

const phase8E2ESkillAdapter = {
  adapterId: 'phase8-e2e-builtins',
  firstPartyBuiltInAuthority: true,
  async listSkills() {
    return [
      {
        sourceId: 'phase8-e2e-source-research', sourceKind: 'builtin', canonicalLocator: 'builtin:///phase8-e2e-research/SKILL.md',
        skillId: 'skill.phase8.e2e.research', name: 'phase8-e2e-research', title: 'Phase 8 E2E Research', storage: 'builtin',
        enabled: true, disableModelInvocation: false, userInvocable: true, eligibleMissionPlanes: ['cognition'], requiredCapabilityIds: [],
      },
      {
        sourceId: 'phase8-e2e-source-practice', sourceKind: 'builtin', canonicalLocator: 'builtin:///phase8-e2e-practice/SKILL.md',
        skillId: 'skill.phase8.e2e.practice', name: 'phase8-e2e-practice', title: 'Phase 8 E2E Practice', storage: 'builtin',
        enabled: true, disableModelInvocation: false, userInvocable: true, eligibleMissionPlanes: ['practice'], requiredCapabilityIds: [],
      },
    ];
  },
  async loadContent(target) {
    if (target.skillId === 'skill.phase8.e2e.research') return { content: 'PHASE8_E2E_RESEARCH_SKILL_SENTINEL: inspect bounded evidence only.' };
    if (target.skillId === 'skill.phase8.e2e.practice') return { content: 'PHASE8_E2E_PRACTICE_SKILL_SENTINEL: change only bounded Reality.' };
    throw new Error(`Unknown Phase 8 E2E Skill: ${target.skillId}`);
  },
};

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

const capabilities = Object.freeze({
  streaming: true,
  reasoning: true,
  capabilityRequests: true,
  imageInput: false,
  checkpoints: false,
  interruption: true,
  persistentContext: true,
});
const phase8ExecutionRoutes = CORE_MISSION_CAPABILITY_SCHEMA_SOURCES.map(source => ({
  routeId: `phase8-e2e.external.${source.sourceId}`,
  projectionMode: 'external-schema',
  schemaSourceId: source.sourceId,
  toolNames: source.listDefinitions().map(definition => definition.toolName),
  basis: `Phase 8 E2E executes exact ${source.sourceId} definitions.`,
}));
const phase8Projection = {
  nativeByName: true,
  externalDefinitions: true,
  executionRoutes: phase8ExecutionRoutes,
};

class Phase7FakeAdapter {
  constructor(id, provider, capabilityProjection, executeExternalCommand = false) {
    this.id = id;
    this.provider = provider;
    this.capabilityProjection = capabilityProjection;
    this.executeExternalCommand = executeExternalCommand;
  }
  nextSession = 0;
  inputs = [];
  submittedResults = [];
  providerTranscripts = new Map();
  offlineSessions = new Set();
  plans = new Map();
  pendingCapabilityResults = new Map();
  forceNextSessionId = undefined;
  nextProjectionOverride = undefined;
  failCreate = false;
  failDispose = false;
  createGate = undefined;
  createCount = 0;
  disposeCount = 0;

  async describe() {
    const projection = this.nextProjectionOverride ?? this.capabilityProjection;
    this.nextProjectionOverride = undefined;
    return {
      id: this.id,
      provider: this.provider,
      kind: 'api',
      label: `Phase 7 fake ${this.id}`,
      availability: 'available',
      models: ['model-a', 'model-b'],
      capabilities: { ...capabilities },
      ...(projection ? { capabilityProjection: structuredClone(projection) } : {}),
    };
  }

  async createSession(options) {
    this.createCount += 1;
    const sessionId = this.forceNextSessionId ?? `${this.id}-native-${++this.nextSession}`;
    this.forceNextSessionId = undefined;
    if (this.createGate) {
      const gate = this.createGate;
      gate.started.resolve(sessionId);
      await gate.release.promise;
      if (this.createGate === gate) this.createGate = undefined;
    }
    if (this.failCreate) throw new Error(`INJECTED_CREATE_FAILURE:${this.id}`);
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
    this.inputs.push(structuredClone(input));
    const plan = this.plans.get(input.inputId) ?? (this.executeExternalCommand && input.externalCapabilities?.length ? { mode: 'exact-command' } : { mode: 'complete' });
    try {
      if (plan.mode === 'unknown') {
        yield { type: 'text_delta', inputId: input.inputId, text: 'provider-may-have-admitted-input' };
        throw new Error('INJECTED_UNKNOWN_SEND');
      }
      if (plan.mode === 'block') {
        yield { type: 'text_delta', inputId: input.inputId, text: 'running-turn-admitted' };
        await plan.release.promise;
        yield { type: 'terminal', inputId: input.inputId, status: 'completed' };
        return;
      }
      if (plan.mode === 'exact-command' && input.externalCapabilities?.length) {
        const exposed = input.externalCapabilities[0];
        const callId = `call-${input.inputId}`;
        const gate = deferred();
        this.pendingCapabilityResults.set(`${input.inputId}\0${callId}`, gate);
        yield {
          type: 'capability_call',
          inputId: input.inputId,
          callId,
          name: exposed.name,
          arguments: structuredClone(exposed.inputSchema?.const),
          dispatch: 'host-requested',
        };
        const result = await gate.promise;
        yield { type: 'capability_result', inputId: input.inputId, callId, name: exposed.name, text: result.text, isError: result.isError };
        yield { type: 'terminal', inputId: input.inputId, status: 'completed' };
        return;
      }
      if (plan.mode === 'raw-sentinel') {
        yield { type: 'text_delta', inputId: input.inputId, text: `raw ${RAW_OUTPUT_SENTINEL}` };
        yield { type: 'reasoning_delta', inputId: input.inputId, text: `reasoning ${RAW_OUTPUT_SENTINEL}` };
        yield { type: 'provider_event', inputId: input.inputId, name: 'provider.raw', data: { sentinel: RAW_OUTPUT_SENTINEL } };
      } else {
        yield { type: 'text_delta', inputId: input.inputId, text: 'bounded-target-observed' };
      }
      yield { type: 'terminal', inputId: input.inputId, status: 'completed' };
    } finally {
      session.state = 'idle';
      session.lastActiveAt = new Date().toISOString();
    }
  }

  async submitCapabilityResult(_session, result) {
    this.submittedResults.push(structuredClone(result));
    const key = `${result.inputId}\0${result.callId}`;
    const gate = this.pendingCapabilityResults.get(key);
    if (!gate) throw new Error(`Missing capability result gate ${key}`);
    this.pendingCapabilityResults.delete(key);
    gate.resolve(structuredClone(result));
  }

  async interrupt(session) { session.state = 'interrupted'; }

  async dispose(session) {
    this.disposeCount += 1;
    if (this.failDispose) throw new Error(`INJECTED_DISPOSE_FAILURE:${this.id}`);
    session.state = 'disposed';
  }

  async health(session) {
    return {
      status: session && this.offlineSessions.has(session.sessionId) ? 'offline' : 'healthy',
      checkedAt: new Date().toISOString(),
    };
  }
}

class Phase7CandidateSource {
  constructor(candidates) { this.candidates = candidates; }
  sequence = 0;
  unavailable = new Set();
  materializeUnavailable = new Set();

  async enumerateCandidates() { return structuredClone(this.candidates.filter(candidate => !this.unavailable.has(candidate.candidateId))); }

  async refreshCandidate(candidate) {
    if (this.unavailable.has(candidate.candidateId)) return undefined;
    const at = new Date(Date.UTC(2026, 8, 16, 7, 0, ++this.sequence)).toISOString();
    return { ...structuredClone(candidate), observationId: `${candidate.observationId}:fresh:${this.sequence}`, observedAt: at, health: { status: 'healthy', checkedAt: at } };
  }

  async materializeSessionOptions(candidate, selection) {
    if (this.materializeUnavailable.has(candidate.candidateId)) {
      throw new WorkerAssignmentCandidateUnavailableError(`candidate unavailable before create: ${candidate.candidateId}`);
    }
    return { model: selection.model, contextHandle: `opaque:${candidate.candidateId}`, extensions: { privatePageLocator: RAW_PAGE_ID_SENTINEL } };
  }
}

function candidate(candidateId, workerId, provider) {
  return {
    candidateId,
    workerId,
    provider,
    kind: 'api',
    availability: 'available',
    models: ['model-a', 'model-b'],
    capabilities: { ...capabilities },
    observationId: `observed:${candidateId}:1`,
    observedAt: '2026-09-16T06:00:00.000Z',
    health: { status: 'healthy', checkedAt: '2026-09-16T06:00:00.000Z' },
  };
}

async function durableText() {
  const chunks = [];
  for (const directory of [taskDirectory, projectDirectory, collaborationDirectory]) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile()) chunks.push(await fs.readFile(path.join(directory, entry.name), 'utf8'));
    }
  }
  return chunks.join('\n');
}

function activeWorkerIds(task) {
  return Object.values(task.workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt).map(worker => worker.managedSessionId).sort();
}

async function explicitReplace({ tasks, workers, assignments, request, currentManagedSessionId, reason }) {
  await tasks.initialize();
  const mission = tasks.getTask(request.missionId);
  if (!mission?.mission) throw new Error(`Replacement Mission does not exist: ${request.missionId}`);
  if (mission.mission.projectId !== request.projectId) throw new Error('Replacement project mismatch.');
  if (mission.mission.rootMissionId !== request.rootMissionId) throw new Error('Replacement root Mission mismatch.');
  if (mission.missionFinalization || ['completed', 'failed', 'cancelled'].includes(mission.status)) throw new Error('Replacement Mission is terminal.');
  const durable = activeWorkerIds(mission);
  const live = workers.listSessions({ taskId: mission.taskId }).map(session => session.managedSessionId).sort();
  if (durable.length !== 1 || live.length !== 1 || durable[0] !== currentManagedSessionId || live[0] !== currentManagedSessionId) {
    throw new Error(`Replacement requires one exact current WorkerSession: ${currentManagedSessionId}`);
  }
  const current = workers.getSession(currentManagedSessionId);
  if (!current || current.taskId !== mission.taskId) throw new Error('Replacement current WorkerSession scope mismatch.');
  const retired = await workers.retire(currentManagedSessionId, { reason });
  if (retired.ownershipPersistenceError || retired.disposeError) throw new Error(`Replacement cleanup uncertain: ${retired.ownershipPersistenceError ?? retired.disposeError}`);
  assert.equal(tasks.getTask(mission.taskId).workerSessions[currentManagedSessionId].retiredAt !== undefined, true);
  return assignments.assignInitial(request);
}

async function createRootMission(tasks, project) {
  const task = await tasks.ensureTask({ kind: 'mission', key: 'p7-e2e-root' }, 'Own Phase 7 assignment/replacement proof.');
  return tasks.configureMission(task.taskId, {
    projectId: project.projectId,
    rootMissionId: task.taskId,
    plane: 'cognition',
    missionType: 'phase7-e2e-root',
    completionCriteria: ['Assignment and replacement boundaries are proven.'],
  });
}

try {
  const projects = new ProjectStore({ storageDirectory: projectDirectory, newId: newProjectId, now });
  const tasks = new TaskRuntime({ storageDirectory: taskDirectory, newId: newTaskId, now });
  await Promise.all([projects.initialize(), tasks.initialize()]);
  const project = await projects.createProject({ title: 'Phase 7 canonical assignment/replacement E2E' });
  const rootMission = await createRootMission(tasks, project);
  const scope = { projectId: project.projectId, managedRootMissionId: rootMission.taskId };
  const collaboration = new MissionCollaborationStore({ storageDirectory: collaborationDirectory, projects, tasks, now });
  await collaboration.initialize();
  const feedback = new MissionFeedbackService(projects, tasks, collaboration);
  const coordinator = new MissionCoordinatorService(projects, tasks, collaboration, feedback);
  const decisions = new ProjectDecisionService(projects, tasks);
  const coordinatorMission = await coordinator.ensureCoordinatorMission(scope);

  const coordinatorAdapter = new Phase7FakeAdapter('worker.p7.coordinator', 'provider-coordinator', undefined, true);
  const researchAdapter = new Phase7FakeAdapter('worker.p7.research', 'provider-research', phase8Projection);
  const practiceAdapterA = new Phase7FakeAdapter('worker.p7.practice-a', 'provider-practice-a', phase8Projection);
  const practiceAdapterB = new Phase7FakeAdapter('worker.p7.practice-b', 'provider-practice-b', phase8Projection);
  const fallbackAdapter = new Phase7FakeAdapter('worker.p7.fallback', 'provider-fallback');
  const failingAdapter = new Phase7FakeAdapter('worker.p7.fail', 'provider-fail');
  const manager = new WorkerSessionManager({ taskBindings: tasks, executionProjection: tasks, newId: newManagedId, now });
  for (const adapter of [coordinatorAdapter, researchAdapter, practiceAdapterA, practiceAdapterB, fallbackAdapter, failingAdapter]) await manager.register(adapter);
  const source = new Phase7CandidateSource([
    candidate('candidate-research', researchAdapter.id, 'provider-research'),
    candidate('candidate-practice-a', practiceAdapterA.id, 'provider-practice-a'),
    candidate('candidate-practice-b', practiceAdapterB.id, 'provider-practice-b'),
    candidate('candidate-fallback', fallbackAdapter.id, 'provider-fallback'),
    candidate('candidate-fail', failingAdapter.id, 'provider-fail'),
  ]);
  const assignments = new MissionWorkerAssignmentService(tasks, manager, [source]);
  const coordinatorSession = await manager.createSession(coordinatorAdapter.id, { model: 'model-a' }, coordinatorMission.taskId);
  const contextMaterializer = new MissionContextMaterializer(projects, tasks, collaboration, manager);
  const capabilityMaterializer = new MissionCapabilityMaterializer(projects, tasks, manager, CORE_MISSION_CAPABILITY_SCHEMA_SOURCES);
  const skillMaterializer = new MissionSkillMaterializer(projects, tasks, manager, new NimoraSkillIndex([phase8E2ESkillAdapter]));
  const phase8Materializer = new MissionWorkerInputMaterializer(contextMaterializer, capabilityMaterializer, skillMaterializer, tasks, manager);
  const driver = new MissionCoordinatorLiveDriver(projects, tasks, collaboration, coordinator, feedback, decisions, manager, undefined, phase8Materializer);

  const coordinatorTurn = (inputId, command) => driver.executeCoordinatorCommandTurn({
    ...scope,
    coordinationMissionId: coordinatorMission.taskId,
    managedSessionId: coordinatorSession.managedSessionId,
    inputId,
    command,
  });

  // Cognition-authored Research Mission A -> bounded assignment -> exact Coordinator route.
  const researchInstruction = {
    ...scope,
    operationKey: 'p7-research-mission-a',
    goal: 'Research current deterministic assignment behavior.',
    parentMissionId: rootMission.taskId,
    plane: 'cognition',
    missionType: 'phase7-research',
    completionCriteria: ['Return bounded Finding/Evidence facts.'],
  };
  await coordinatorTurn('coord-ensure-research', { kind: 'ensureMission', arguments: researchInstruction });
  const researchMission = tasks.listTasks().find(task => task.goal === researchInstruction.goal);
  assert.ok(researchMission?.mission);
  const researchAssignment = await assignments.assignInitial({
    projectId: project.projectId,
    rootMissionId: rootMission.taskId,
    missionId: researchMission.taskId,
    constraints: { allowedProviders: ['provider-research'] },
  });
  assert.equal(researchAssignment.provider, 'provider-research');
  researchAdapter.plans.set('research-input-1', { mode: 'raw-sentinel' });
  const researchTransport = await coordinatorTurn('coord-deliver-research', {
    kind: 'deliverExplicitMissionInput',
    arguments: {
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      targetMissionId: researchMission.taskId,
      managedSessionId: researchAssignment.managedSessionId,
      inputId: 'research-input-1',
      instructionKind: 'research-request',
      instruction: 'Inspect bounded deterministic Reality and return only bounded facts.',
      phase8Materialization: phase8Spec('research'),
    },
  });
  assert.equal(researchTransport.commandExecuted, true);
  assert.equal(JSON.stringify(researchTransport.commandResult).includes(RAW_OUTPUT_SENTINEL), false, 'Coordinator semantic result must not contain raw provider text/reasoning/events');
  const researchComposedInput = researchAdapter.inputs.find(input => input.inputId === 'research-input-1');
  assert.match(researchComposedInput.prompt, /PHASE8_E2E_RESEARCH_SKILL_SENTINEL/);
  assert.doesNotMatch(researchComposedInput.prompt, /PHASE8_E2E_PRACTICE_SKILL_SENTINEL/);
  assert.ok(researchComposedInput.allowedCapabilities.includes('read_files'));
  assert.equal(researchComposedInput.allowedCapabilities.includes('apply_patch'), false, 'research composition must not receive unrelated write capability');
  assert.ok(researchComposedInput.externalCapabilities.length > 0);
  assert.ok(researchTransport.commandResult.compositionInspector.lower.capability.executionRouteIds.every(routeId => routeId.startsWith('phase8-e2e.external.')));
  const researchFinding = await collaboration.recordExchange({
    exchangeId: 'p7-research-finding',
    projectId: project.projectId,
    sourceMissionId: researchMission.taskId,
    kind: 'Finding',
    payload: { summary: 'Deterministic candidate selection remains bounded by explicit constraints.', evidenceExchangeIds: [] },
  });
  const researchEvidence = await collaboration.recordExchange({
    exchangeId: 'p7-research-evidence',
    projectId: project.projectId,
    sourceMissionId: researchMission.taskId,
    kind: 'Evidence',
    payload: { summary: 'Assignment returned one exact managedSessionId.', references: [{ type: 'command', command: 'assignInitial', observation: researchAssignment.managedSessionId }] },
  });
  assert.ok(researchFinding && researchEvidence);

  // Cognition explicitly defines Practice Mission B with a different hard provider requirement.
  const practiceInstruction = {
    ...scope,
    operationKey: 'p7-practice-mission-b',
    goal: 'Execute bounded Phase 7 Practice work and report Reality.',
    parentMissionId: rootMission.taskId,
    plane: 'practice',
    missionType: 'phase7-practice',
    completionCriteria: ['Return durable Evidence/Finding/Problem facts.'],
  };
  await coordinatorTurn('coord-ensure-practice', { kind: 'ensureMission', arguments: practiceInstruction });
  const practiceMission = tasks.listTasks().find(task => task.goal === practiceInstruction.goal);
  assert.ok(practiceMission?.mission);
  await tasks.updateContext(practiceMission.taskId, {
    summary: 'Practice B durable context for replacement.',
    constraints: ['Provider transcripts are not Mission memory.'],
    decisions: ['Worker replacement keeps the same Mission identity.'],
    relevantFiles: ['src/worker-assignment.ts', 'src/worker-session-manager.ts'],
  });
  const practiceRequest = {
    projectId: project.projectId,
    rootMissionId: rootMission.taskId,
    missionId: practiceMission.taskId,
    constraints: { allowedProviders: ['provider-practice-a'] },
  };
  const practiceAssignmentA = await assignments.assignInitial(practiceRequest);
  assert.equal(practiceAssignmentA.provider, 'provider-practice-a');
  const practiceSessionA = manager.getSession(practiceAssignmentA.managedSessionId);
  practiceAdapterA.providerTranscripts.set(practiceSessionA.adapterSessionId, `${PROVIDER_TRANSCRIPT_SENTINEL}:${RAW_PAGE_ID_SENTINEL}`);

  let phase8AccessorRuns = 0;
  const accessorArguments = {
    ...scope,
    coordinationMissionId: coordinatorMission.taskId,
    targetMissionId: practiceMission.taskId,
    managedSessionId: practiceAssignmentA.managedSessionId,
    inputId: 'practice-phase8-accessor-reject',
    instructionKind: 'work-order',
    instruction: 'Must reject malformed Phase 8 host input before any Worker send.',
  };
  Object.defineProperty(accessorArguments, 'phase8Materialization', {
    enumerable: true,
    get() { phase8AccessorRuns += 1; return phase8Spec('practice'); },
  });
  const coordinatorInputsBeforePhase8Accessor = coordinatorAdapter.inputs.length;
  const targetInputsBeforePhase8Accessor = practiceAdapterA.inputs.length;
  await assert.rejects(
    () => coordinatorTurn('coord-phase8-accessor-reject', { kind: 'deliverExplicitMissionInput', arguments: accessorArguments }),
    /phase8Materialization.*own data property/,
  );
  assert.equal(phase8AccessorRuns, 0, 'Phase 8 accessor must be rejected without getter execution');
  assert.equal(coordinatorAdapter.inputs.length, coordinatorInputsBeforePhase8Accessor, 'malformed Phase 8 command must fail before Coordinator Worker send');
  assert.equal(practiceAdapterA.inputs.length, targetInputsBeforePhase8Accessor, 'malformed Phase 8 command must fail before target Worker send');

  const assertNestedPhase8SpecRejectedBeforeTransport = async (caseId, phase8Materialization, expectedError) => {
    const coordinatorSendsBefore = coordinatorAdapter.inputs.length;
    const targetSendsBefore = practiceAdapterA.inputs.length;
    const taskBefore = tasks.getTask(practiceMission.taskId);
    const taskEventCountBefore = taskBefore.eventCount;
    const grantsBefore = JSON.stringify(taskBefore.capabilityGrants);
    const executionsBefore = JSON.stringify(taskBefore.executions);
    const sessionsBefore = JSON.stringify(manager.listSessions({ taskId: practiceMission.taskId }).map(value => ({
      managedSessionId: value.managedSessionId,
      workerId: value.workerId,
      taskId: value.taskId,
      state: value.state,
    })));
    await assert.rejects(
      () => coordinatorTurn(`coord-phase8-nested-${caseId}`, {
        kind: 'deliverExplicitMissionInput',
        arguments: {
          ...scope,
          coordinationMissionId: coordinatorMission.taskId,
          targetMissionId: practiceMission.taskId,
          managedSessionId: practiceAssignmentA.managedSessionId,
          inputId: `outer-authorized-${caseId}`,
          instructionKind: 'work-order',
          instruction: `OUTER_AUTHORIZED_INSTRUCTION_${caseId}`,
          phase8Materialization,
        },
      }),
      expectedError,
    );
    const taskAfter = tasks.getTask(practiceMission.taskId);
    assert.equal(coordinatorAdapter.inputs.length, coordinatorSendsBefore, `${caseId}: reject before Coordinator Worker send`);
    assert.equal(practiceAdapterA.inputs.length, targetSendsBefore, `${caseId}: reject before target Worker send`);
    assert.equal(taskAfter.eventCount, taskEventCountBefore, `${caseId}: no TaskRuntime mutation, including approval/grant/execution state`);
    assert.equal(JSON.stringify(taskAfter.capabilityGrants), grantsBefore, `${caseId}: grants/approval-derived authority unchanged`);
    assert.equal(JSON.stringify(taskAfter.executions), executionsBefore, `${caseId}: executions unchanged`);
    assert.equal(JSON.stringify(manager.listSessions({ taskId: practiceMission.taskId }).map(value => ({
      managedSessionId: value.managedSessionId,
      workerId: value.workerId,
      taskId: value.taskId,
      state: value.state,
    }))), sessionsBefore, `${caseId}: Worker assignment/session binding unchanged`);
  };

  await assertNestedPhase8SpecRejectedBeforeTransport(
    'semantic-overlap',
    { ...phase8Spec('practice'), inputId: 'inner-overridden-input-id', instruction: 'INNER_OVERRIDE_INSTRUCTION_SENTINEL' },
    /phase8Materialization contains unsupported field: inputId/,
  );
  await assertNestedPhase8SpecRejectedBeforeTransport(
    'mission-overlap',
    { ...phase8Spec('practice'), missionId: 'inner-overridden-mission-id' },
    /phase8Materialization contains unsupported field: missionId/,
  );
  await assertNestedPhase8SpecRejectedBeforeTransport(
    'generic-unsupported',
    { ...phase8Spec('practice'), unexpectedPolicyField: true },
    /phase8Materialization contains unsupported field: unexpectedPolicyField/,
  );
  await assertNestedPhase8SpecRejectedBeforeTransport(
    'missing-budget',
    { profile: 'practice' },
    /phase8Materialization is missing required field: budget/,
  );

  practiceAdapterA.nextProjectionOverride = { nativeByName: false, externalDefinitions: false, executionRoutes: [] };
  const targetInputsBeforeRouteDrift = practiceAdapterA.inputs.length;
  await assert.rejects(
    () => coordinatorTurn('coord-phase8-route-drift', {
      kind: 'deliverExplicitMissionInput',
      arguments: {
        ...scope,
        coordinationMissionId: coordinatorMission.taskId,
        targetMissionId: practiceMission.taskId,
        managedSessionId: practiceAssignmentA.managedSessionId,
        inputId: 'practice-route-drift-reject',
        instructionKind: 'work-order',
        instruction: 'Materialize from cached exact assignment, then detect route drift before target send.',
        phase8Materialization: phase8Spec('practice'),
      },
    }),
    /capability route drifted before send/,
  );
  assert.equal(practiceAdapterA.inputs.length, targetInputsBeforeRouteDrift, 'send-time route drift must cause zero target send');
  practiceAdapterA.nextProjectionOverride = phase8Projection;
  await manager.refresh(practiceAdapterA.id);

  const practiceTransportA = await coordinatorTurn('coord-deliver-practice-work', {
    kind: 'deliverExplicitMissionInput',
    arguments: {
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      targetMissionId: practiceMission.taskId,
      managedSessionId: practiceAssignmentA.managedSessionId,
      inputId: 'practice-work-order-1',
      instructionKind: 'work-order',
      instruction: 'Execute the exact bounded Practice work and return durable Evidence/Problem facts.',
      referenceIds: [researchFinding.exchangeId],
      phase8Materialization: phase8Spec('practice'),
    },
  });
  const practiceComposedInputA = practiceAdapterA.inputs.find(input => input.inputId === 'practice-work-order-1');
  assert.match(practiceComposedInputA.prompt, /PHASE8_E2E_PRACTICE_SKILL_SENTINEL/);
  assert.doesNotMatch(practiceComposedInputA.prompt, /PHASE8_E2E_RESEARCH_SKILL_SENTINEL/);
  assert.ok(practiceComposedInputA.allowedCapabilities.includes('read_files'));
  assert.ok(practiceComposedInputA.allowedCapabilities.includes('apply_patch'), 'Practice exact Cognition-authored request may expose apply_patch without executing it');
  assert.ok(practiceComposedInputA.externalCapabilities.some(definition => definition.name === 'apply_patch'));
  assert.ok(practiceTransportA.commandResult.compositionInspector.lower.capability.executionRouteIds.every(routeId => routeId.startsWith('phase8-e2e.external.')));
  assert.equal(Object.keys(tasks.getTask(practiceMission.taskId).executions).length, 0, 'capability visibility during composition must not execute target tools');

  const practiceEvidence = await collaboration.recordExchange({
    exchangeId: 'p7-practice-evidence',
    projectId: project.projectId,
    sourceMissionId: practiceMission.taskId,
    kind: 'Evidence',
    payload: { summary: 'Practice observed a bounded replacement question.', references: [{ type: 'command', command: 'practice-work-order-1', observation: 'settled completed boundary' }] },
  });
  const problem = await collaboration.recordExchange({
    exchangeId: 'p7-practice-problem',
    projectId: project.projectId,
    sourceMissionId: practiceMission.taskId,
    kind: 'Problem',
    payload: {
      currentGoal: 'Continue the same Practice Mission after Worker replacement.',
      previousAssumption: 'The current Worker would remain usable.',
      observedReality: 'The Worker can become known unusable at a settled boundary.',
      preciseQuestion: 'Use authoritative retirement then fresh assignment to the same Mission?',
      blocking: true,
      evidenceExchangeIds: [practiceEvidence.exchangeId],
    },
  });
  const feedbackIdentity = { projectId: project.projectId, practiceMissionId: practiceMission.taskId, problemExchangeId: problem.exchangeId };
  assert.equal(tasks.findTaskBySource(missionFeedbackCognitionSource(feedbackIdentity)), undefined, 'Problem creation/transport must not auto-create feedback Cognition');

  await coordinatorTurn('coord-transport-problem-only', {
    kind: 'deliverMissionExchange',
    arguments: {
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      exchangeId: problem.exchangeId,
      targetMissionId: researchMission.taskId,
      managedSessionId: researchAssignment.managedSessionId,
      inputId: 'problem-transport-only',
    },
  });
  assert.equal(tasks.findTaskBySource(missionFeedbackCognitionSource(feedbackIdentity)), undefined, 'Problem transport alone remains inert');
  const routed = await coordinatorTurn('coord-explicit-route-problem', { kind: 'routePracticeProblem', arguments: { ...scope, practiceMissionId: practiceMission.taskId, problemExchangeId: problem.exchangeId } });
  const feedbackCognitionId = routed.commandResult.cognitionMission.missionId;
  assert.ok(tasks.getTask(feedbackCognitionId)?.mission);
  const answer = await feedback.recordAnswer({
    ...feedbackIdentity,
    answerExchangeId: 'p7-feedback-answer',
    answer: 'Yes. Retire the exact settled Worker through WorkerSessionManager, then explicitly reissue a bounded Assignment Request for the same Mission.',
    evidenceExchangeIds: [practiceEvidence.exchangeId],
  });
  await coordinatorTurn('coord-feedback-continuation', {
    kind: 'deliverFeedbackContinuation',
    arguments: {
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      practiceMissionId: practiceMission.taskId,
      problemExchangeId: problem.exchangeId,
      answerExchangeId: answer.answer.exchangeId,
      managedSessionId: practiceAssignmentA.managedSessionId,
      inputId: 'practice-feedback-continuation-1',
    },
  });
  assert.equal(tasks.listTasks().filter(task => task.mission?.projectId === project.projectId && task.mission?.plane === 'practice' && task.goal === practiceInstruction.goal).length, 1, 'Practice Mission B2 must not be created');

  // Exact replacement admission rejects wrong scope/session before creation.
  const replacementRequest = { ...practiceRequest, constraints: { allowedProviders: ['provider-practice-b'] } };
  const practiceBCreateBeforeWrong = practiceAdapterB.createCount;
  await assert.rejects(() => explicitReplace({ tasks, workers: manager, assignments, request: { ...replacementRequest, projectId: 'wrong-project' }, currentManagedSessionId: practiceAssignmentA.managedSessionId, reason: 'wrong-project' }), /project mismatch/);
  await assert.rejects(() => explicitReplace({ tasks, workers: manager, assignments, request: { ...replacementRequest, rootMissionId: 'wrong-root' }, currentManagedSessionId: practiceAssignmentA.managedSessionId, reason: 'wrong-root' }), /root Mission mismatch/);
  await assert.rejects(() => explicitReplace({ tasks, workers: manager, assignments, request: replacementRequest, currentManagedSessionId: researchAssignment.managedSessionId, reason: 'wrong-session' }), /one exact current WorkerSession/);
  assert.equal(practiceAdapterB.createCount, practiceBCreateBeforeWrong, 'wrong replacement admission must reject before creation');

  // Known settled failure -> retire A -> same Mission -> B.
  practiceAdapterA.offlineSessions.add(practiceSessionA.adapterSessionId);
  assert.equal((await manager.health(practiceAssignmentA.managedSessionId)).status, 'offline');
  const practiceAssignmentB = await explicitReplace({ tasks, workers: manager, assignments, request: replacementRequest, currentManagedSessionId: practiceAssignmentA.managedSessionId, reason: 'known-offline-after-settled-boundary' });
  assert.equal(practiceAssignmentB.missionId, practiceMission.taskId);
  assert.notEqual(practiceAssignmentB.managedSessionId, practiceAssignmentA.managedSessionId);
  const practiceSessionB = manager.getSession(practiceAssignmentB.managedSessionId);
  assert.notEqual(practiceSessionB.adapterSessionId, practiceSessionA.adapterSessionId);
  assert.ok(manager.getRetiredSession(practiceAssignmentA.managedSessionId));
  assert.equal(tasks.getTask(practiceMission.taskId).workerSessions[practiceAssignmentA.managedSessionId].retiredAt !== undefined, true);

  // Retired provider-native identity cannot be reused.
  practiceAdapterA.forceNextSessionId = practiceSessionA.adapterSessionId;
  await assert.rejects(() => manager.createSession(practiceAdapterA.id, { model: 'model-a' }, practiceMission.taskId), /retired and cannot be reused/);

  const replacementHandoff = buildRenderedContextHandoff(tasks.getTask(practiceMission.taskId), {
    targetWorkerId: practiceAssignmentB.workerId,
    sourceManagedSessionId: practiceAssignmentA.managedSessionId,
    generatedAt: '2026-09-16T08:00:00.000Z',
  });
  const handoffJson = JSON.stringify(replacementHandoff);
  assert.doesNotMatch(handoffJson, new RegExp(PROVIDER_TRANSCRIPT_SENTINEL));
  assert.doesNotMatch(handoffJson, new RegExp(RAW_PAGE_ID_SENTINEL));
  assert.doesNotMatch(handoffJson, new RegExp(practiceSessionA.adapterSessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'provider-native session locator must not enter handoff');
  await coordinatorTurn('coord-replacement-new-input', {
    kind: 'deliverExplicitMissionInput',
    arguments: {
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      targetMissionId: practiceMission.taskId,
      managedSessionId: practiceAssignmentB.managedSessionId,
      inputId: 'practice-replacement-new-input-2',
      instructionKind: 'continuation',
      instruction: 'Continue the same Practice Mission from bounded durable state only.',
      phase8Materialization: phase8Spec('practice'),
    },
  });
  assert.equal(practiceAdapterB.inputs.some(input => input.inputId === 'practice-work-order-1'), false, 'replacement must not replay old input');
  assert.equal(practiceAdapterB.inputs.some(input => input.inputId === 'practice-replacement-new-input-2'), true);
  assert.match(practiceAdapterB.inputs.find(input => input.inputId === 'practice-replacement-new-input-2').prompt, /PHASE8_E2E_PRACTICE_SKILL_SENTINEL/);
  assert.doesNotMatch(practiceAdapterB.inputs.find(input => input.inputId === 'practice-replacement-new-input-2').prompt, new RegExp(PROVIDER_TRANSCRIPT_SENTINEL));

  // UNKNOWN does not authorize retirement/reassignment/replay; later new input may be explicitly authorized.
  const unknownInstruction = { ...practiceInstruction, operationKey: 'p7-unknown-mission', goal: 'Prove UNKNOWN does not authorize replacement replay.' };
  await coordinatorTurn('coord-ensure-unknown', { kind: 'ensureMission', arguments: unknownInstruction });
  const unknownMission = tasks.listTasks().find(task => task.goal === unknownInstruction.goal);
  const unknownAssignmentA = await assignments.assignInitial({ ...replacementRequest, missionId: unknownMission.taskId, constraints: { allowedProviders: ['provider-practice-a'] } });
  practiceAdapterA.plans.set('unknown-old-input', { mode: 'unknown' });
  const bCreatesBeforeUnknown = practiceAdapterB.createCount;
  await assert.rejects(() => coordinatorTurn('coord-unknown-target-send', {
    kind: 'deliverExplicitMissionInput',
    arguments: { ...scope, coordinationMissionId: coordinatorMission.taskId, targetMissionId: unknownMission.taskId, managedSessionId: unknownAssignmentA.managedSessionId, inputId: 'unknown-old-input', instructionKind: 'bounded-work', instruction: 'Potentially admitted once.', phase8Materialization: phase8Spec('practice') },
  }), /INJECTED_UNKNOWN_SEND/);
  assert.equal(manager.getSession(unknownAssignmentA.managedSessionId)?.taskId, unknownMission.taskId, 'UNKNOWN must not auto-retire Worker A');
  assert.equal(practiceAdapterB.createCount, bCreatesBeforeUnknown, 'UNKNOWN must not auto-assign Worker B');
  assert.equal(practiceAdapterA.inputs.filter(input => input.inputId === 'unknown-old-input').length, 1, 'UNKNOWN old input must not auto-resend');
  const unknownReplacement = await explicitReplace({ tasks, workers: manager, assignments, request: { ...replacementRequest, missionId: unknownMission.taskId }, currentManagedSessionId: unknownAssignmentA.managedSessionId, reason: 'explicit-post-unknown-future-work-replacement' });
  await coordinatorTurn('coord-unknown-future-input', {
    kind: 'deliverExplicitMissionInput',
    arguments: { ...scope, coordinationMissionId: coordinatorMission.taskId, targetMissionId: unknownMission.taskId, managedSessionId: unknownReplacement.managedSessionId, inputId: 'unknown-future-new-input', instructionKind: 'future-work', instruction: 'New explicit authorization after UNKNOWN handling.', phase8Materialization: phase8Spec('practice') },
  });
  assert.equal(practiceAdapterB.inputs.filter(input => input.inputId === 'unknown-old-input').length, 0);
  assert.equal(practiceAdapterB.inputs.filter(input => input.inputId === 'unknown-future-new-input').length, 1);

  // Running send lease blocks replacement before B creation.
  const runningInstruction = { ...practiceInstruction, operationKey: 'p7-running-mission', goal: 'Prove active send lease blocks replacement.' };
  await coordinatorTurn('coord-ensure-running', { kind: 'ensureMission', arguments: runningInstruction });
  const runningMission = tasks.listTasks().find(task => task.goal === runningInstruction.goal);
  const runningA = await assignments.assignInitial({ ...practiceRequest, missionId: runningMission.taskId });
  const releaseRunning = deferred();
  practiceAdapterA.plans.set('running-input', { mode: 'block', release: releaseRunning });
  const runningIterator = manager.send(runningA.managedSessionId, { inputId: 'running-input', prompt: 'Hold a live send lease.' })[Symbol.asyncIterator]();
  assert.equal((await runningIterator.next()).value.type, 'text_delta');
  const bCreatesBeforeRunning = practiceAdapterB.createCount;
  await assert.rejects(() => explicitReplace({ tasks, workers: manager, assignments, request: { ...replacementRequest, missionId: runningMission.taskId }, currentManagedSessionId: runningA.managedSessionId, reason: 'must-not-retire-running' }), /Cannot retire running worker session/);
  assert.equal(practiceAdapterB.createCount, bCreatesBeforeRunning);
  releaseRunning.resolve();
  await runningIterator.next();
  await manager.retire(runningA.managedSessionId, { reason: 'cleanup-running-proof' });

  // Two concurrent replacement attempts admit at most one replacement Worker.
  const concurrentInstruction = { ...practiceInstruction, operationKey: 'p7-concurrent-mission', goal: 'Prove concurrent replacement safety.' };
  await coordinatorTurn('coord-ensure-concurrent', { kind: 'ensureMission', arguments: concurrentInstruction });
  const concurrentMission = tasks.listTasks().find(task => task.goal === concurrentInstruction.goal);
  const concurrentA = await assignments.assignInitial({ ...practiceRequest, missionId: concurrentMission.taskId });
  const concurrentRequest = { ...replacementRequest, missionId: concurrentMission.taskId };
  const replacements = await Promise.allSettled([
    explicitReplace({ tasks, workers: manager, assignments, request: concurrentRequest, currentManagedSessionId: concurrentA.managedSessionId, reason: 'concurrent-1' }),
    explicitReplace({ tasks, workers: manager, assignments, request: concurrentRequest, currentManagedSessionId: concurrentA.managedSessionId, reason: 'concurrent-2' }),
  ]);
  assert.equal(replacements.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(manager.listSessions({ taskId: concurrentMission.taskId }).length, 1, 'concurrent replacement must leave at most one current Worker');

  // Cleanup ambiguity after authoritative retirement does not authorize speculative B.
  const cleanupInstruction = { ...practiceInstruction, operationKey: 'p7-cleanup-mission', goal: 'Prove cleanup ambiguity stops replacement.' };
  await coordinatorTurn('coord-ensure-cleanup', { kind: 'ensureMission', arguments: cleanupInstruction });
  const cleanupMission = tasks.listTasks().find(task => task.goal === cleanupInstruction.goal);
  const cleanupA = await assignments.assignInitial({ ...practiceRequest, missionId: cleanupMission.taskId });
  practiceAdapterA.failDispose = true;
  const bCreatesBeforeCleanup = practiceAdapterB.createCount;
  await assert.rejects(() => explicitReplace({ tasks, workers: manager, assignments, request: { ...replacementRequest, missionId: cleanupMission.taskId }, currentManagedSessionId: cleanupA.managedSessionId, reason: 'dispose-ambiguous' }), /Replacement cleanup uncertain/);
  assert.equal(practiceAdapterB.createCount, bCreatesBeforeCleanup, 'cleanup ambiguity must not create B');
  assert.equal(activeWorkerIds(tasks.getTask(cleanupMission.taskId)).length, 0, 'authoritative retirement remains durable despite dispose ambiguity');
  practiceAdapterA.failDispose = false;
  await manager.retire(cleanupA.managedSessionId, { reason: 'retry-cleanup' });

  // Safe pre-create unavailability may fall through; arbitrary create failure may not.
  const fallbackInstruction = { ...practiceInstruction, operationKey: 'p7-fallback-mission', goal: 'Prove only safe pre-create fallback is allowed.' };
  await coordinatorTurn('coord-ensure-fallback', { kind: 'ensureMission', arguments: fallbackInstruction });
  const fallbackMission = tasks.listTasks().find(task => task.goal === fallbackInstruction.goal);
  source.materializeUnavailable.add('candidate-practice-a');
  const fallbackResult = await assignments.assignInitial({
    projectId: project.projectId,
    rootMissionId: rootMission.taskId,
    missionId: fallbackMission.taskId,
    constraints: { allowedProviders: ['provider-practice-a', 'provider-fallback'] },
    preferences: { providerOrder: ['provider-practice-a', 'provider-fallback'] },
  });
  assert.equal(fallbackResult.provider, 'provider-fallback');
  source.materializeUnavailable.delete('candidate-practice-a');

  const failInstruction = { ...practiceInstruction, operationKey: 'p7-create-fail-mission', goal: 'Prove arbitrary create failure does not fallback.' };
  await coordinatorTurn('coord-ensure-create-fail', { kind: 'ensureMission', arguments: failInstruction });
  const failMission = tasks.listTasks().find(task => task.goal === failInstruction.goal);
  failingAdapter.failCreate = true;
  const fallbackCreatesBeforeCreateFailure = fallbackAdapter.createCount;
  await assert.rejects(() => assignments.assignInitial({
    projectId: project.projectId,
    rootMissionId: rootMission.taskId,
    missionId: failMission.taskId,
    constraints: { allowedProviders: ['provider-fail', 'provider-fallback'] },
    preferences: { providerOrder: ['provider-fail', 'provider-fallback'] },
  }), error => error instanceof WorkerAssignmentCreateFailedError);
  assert.equal(fallbackAdapter.createCount, fallbackCreatesBeforeCreateFailure, 'ambiguous/arbitrary create failure must not fall through');
  failingAdapter.failCreate = false;

  // Finalization racing a replacement create wins; no late binding survives.
  const finalInstruction = { ...practiceInstruction, operationKey: 'p7-finalize-race', goal: 'Prove finalization defeats late replacement binding.' };
  await coordinatorTurn('coord-ensure-final-race', { kind: 'ensureMission', arguments: finalInstruction });
  const finalMission = tasks.listTasks().find(task => task.goal === finalInstruction.goal);
  const finalA = await assignments.assignInitial({ ...practiceRequest, missionId: finalMission.taskId });
  await manager.retire(finalA.managedSessionId, { reason: 'prepare-finalization-race' });
  const createGate = { started: deferred(), release: deferred() };
  practiceAdapterB.createGate = createGate;
  const lateAssignment = assignments.assignInitial({ ...replacementRequest, missionId: finalMission.taskId });
  await createGate.started.promise;
  const finalizer = new MissionFinalizationService(tasks, manager);
  await finalizer.finalizeMission(finalMission.taskId, { requireHandoff: false });
  createGate.release.resolve();
  await assert.rejects(() => lateAssignment, error => error instanceof WorkerAssignmentCreateFailedError);
  assert.equal(manager.listSessions({ taskId: finalMission.taskId }).length, 0);

  // Restart proof: no provider memory is loaded; durable same-Mission history is sufficient.
  await manager.retire(practiceAssignmentB.managedSessionId, { reason: 'prepare-restart-replacement' });
  await Promise.all([projects.flush(), tasks.flush(), collaboration.flush()]);
  const projectsR = new ProjectStore({ storageDirectory: projectDirectory });
  const tasksR = new TaskRuntime({ storageDirectory: taskDirectory });
  const collaborationR = new MissionCollaborationStore({ storageDirectory: collaborationDirectory, projects: projectsR, tasks: tasksR });
  await Promise.all([projectsR.initialize(), tasksR.initialize(), collaborationR.initialize()]);
  const feedbackR = new MissionFeedbackService(projectsR, tasksR, collaborationR);
  const coordinatorR = new MissionCoordinatorService(projectsR, tasksR, collaborationR, feedbackR);
  const decisionsR = new ProjectDecisionService(projectsR, tasksR);
  const managerR = new WorkerSessionManager({ taskBindings: tasksR, executionProjection: tasksR, newId: newManagedId });
  const coordinatorAdapterR = new Phase7FakeAdapter('worker.p7.coordinator-r', 'provider-coordinator-r', undefined, true);
  const restartAdapter = new Phase7FakeAdapter('worker.p7.restart', 'provider-restart', phase8Projection);
  await managerR.register(coordinatorAdapterR);
  await managerR.register(restartAdapter);
  const restartSource = new Phase7CandidateSource([candidate('candidate-restart', restartAdapter.id, 'provider-restart')]);
  const assignmentsR = new MissionWorkerAssignmentService(tasksR, managerR, [restartSource]);
  const coordinatorMissionR = await coordinatorR.ensureCoordinatorMission(scope);
  const coordinatorSessionR = await managerR.createSession(coordinatorAdapterR.id, { model: 'model-a' }, coordinatorMissionR.taskId);
  const contextMaterializerR = new MissionContextMaterializer(projectsR, tasksR, collaborationR, managerR);
  const capabilityMaterializerR = new MissionCapabilityMaterializer(projectsR, tasksR, managerR, CORE_MISSION_CAPABILITY_SCHEMA_SOURCES);
  const skillMaterializerR = new MissionSkillMaterializer(projectsR, tasksR, managerR, new NimoraSkillIndex([phase8E2ESkillAdapter]));
  const phase8MaterializerR = new MissionWorkerInputMaterializer(contextMaterializerR, capabilityMaterializerR, skillMaterializerR, tasksR, managerR);
  const driverR = new MissionCoordinatorLiveDriver(projectsR, tasksR, collaborationR, coordinatorR, feedbackR, decisionsR, managerR, undefined, phase8MaterializerR);
  const practiceAfterRestart = tasksR.getTask(practiceMission.taskId);
  assert.equal(practiceAfterRestart.taskId, practiceMission.taskId);
  assert.ok(practiceAfterRestart.workerSessions[practiceAssignmentA.managedSessionId].retiredAt);
  assert.ok(practiceAfterRestart.workerSessions[practiceAssignmentB.managedSessionId].retiredAt);
  const restartAssignment = await assignmentsR.assignInitial({ projectId: project.projectId, rootMissionId: rootMission.taskId, missionId: practiceMission.taskId, constraints: { allowedProviders: ['provider-restart'] } });
  assert.equal(restartAssignment.missionId, practiceMission.taskId);
  const restartHandoff = buildRenderedContextHandoff(tasksR.getTask(practiceMission.taskId), { targetWorkerId: restartAssignment.workerId, sourceManagedSessionId: practiceAssignmentB.managedSessionId });
  assert.doesNotMatch(JSON.stringify(restartHandoff), new RegExp(PROVIDER_TRANSCRIPT_SENTINEL));
  assert.doesNotMatch(JSON.stringify(restartHandoff), new RegExp(RAW_PAGE_ID_SENTINEL));
  const driverRTurn = (inputId, command) => driverR.executeCoordinatorCommandTurn({ ...scope, coordinationMissionId: coordinatorMissionR.taskId, managedSessionId: coordinatorSessionR.managedSessionId, inputId, command });
  await driverRTurn('coord-restart-continuation', {
    kind: 'deliverExplicitMissionInput',
    arguments: { ...scope, coordinationMissionId: coordinatorMissionR.taskId, targetMissionId: practiceMission.taskId, managedSessionId: restartAssignment.managedSessionId, inputId: 'restart-new-explicit-input', instructionKind: 'restart-continuation', instruction: 'Continue same Mission using durable bounded state only.', phase8Materialization: phase8Spec('practice') },
  });
  assert.equal(restartAdapter.inputs.some(input => input.inputId === 'practice-work-order-1'), false);
  assert.equal(restartAdapter.inputs.some(input => input.inputId === 'restart-new-explicit-input'), true);
  assert.match(restartAdapter.inputs.find(input => input.inputId === 'restart-new-explicit-input').prompt, /PHASE8_E2E_PRACTICE_SKILL_SENTINEL/);
  assert.doesNotMatch(restartAdapter.inputs.find(input => input.inputId === 'restart-new-explicit-input').prompt, new RegExp(PROVIDER_TRANSCRIPT_SENTINEL));

  const durable = await durableText();
  assert.doesNotMatch(durable, new RegExp(PROVIDER_TRANSCRIPT_SENTINEL));
  assert.doesNotMatch(durable, new RegExp(RAW_OUTPUT_SENTINEL));
  assert.doesNotMatch(durable, new RegExp(RAW_PAGE_ID_SENTINEL));
  assert.equal((await fs.readdir(taskDirectory)).some(name => /assignment|scheduler|queue|pending/i.test(name)), false, 'no assignment/scheduler/pending-action journal');

  console.log(JSON.stringify({
    result: 'PASS',
    researchMissionId: researchMission.taskId,
    practiceMissionId: practiceMission.taskId,
    practiceInitialManagedSessionId: practiceAssignmentA.managedSessionId,
    practiceReplacementManagedSessionId: practiceAssignmentB.managedSessionId,
    restartManagedSessionId: restartAssignment.managedSessionId,
    samePracticeMissionAfterReplacement: practiceAssignmentB.missionId === practiceMission.taskId,
    coordinatorCompositionUsesExactManagedSessionId: true,
    phase8ContextCapabilitySkillCompositionThroughCoordinator: true,
    problemTransportAutoFeedbackCreation: false,
    unknownOldInputAutoResendCount: 0,
    concurrentReplacementCurrentWorkerCount: manager.listSessions({ taskId: concurrentMission.taskId }).length,
    rawProviderAuthorityPersistence: false,
    assignmentJournal: false,
    scheduler: false,
  }, null, 2));
} finally {
  await Promise.allSettled([
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(projectDirectory, { recursive: true, force: true }),
    fs.rm(collaborationDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
