import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const esbuild = require('esbuild');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-autonomy-loop-'));
try {
  const outfile = path.join(tmp, 'autonomy.cjs');
  await esbuild.build({
    stdin: { contents: [
      "export { ProjectStore } from './src/project-store.ts';",
      "export { TaskRuntime } from './src/task-runtime.ts';",
      "export { MissionCollaborationStore } from './src/mission-collaboration-store.ts';",
      "export { WorkerSessionManager } from './src/worker-session-manager.ts';",
      "export { MissionFeedbackService } from './src/mission-feedback-service.ts';",
      "export { MissionCoordinatorService } from './src/mission-coordinator-service.ts';",
      "export { MissionCoordinatorLiveDriver } from './src/mission-coordinator-live-driver.ts';",
      "export { ProjectDecisionService } from './src/project-decision-service.ts';",
      "export { MissionFinalizationService } from './src/mission-finalization-service.ts';",
      "export { MissionContextMaterializer } from './src/mission-context-materializer.ts';",
      "export { MissionCapabilityMaterializer } from './src/mission-capability-materializer.ts';",
      "export { NimoraSkillIndex } from './src/mission-skill-index.ts';",
      "export { MissionSkillMaterializer } from './src/mission-skill-materializer.ts';",
      "export { MissionWorkerInputMaterializer } from './src/mission-worker-input-materializer.ts';",
      "export { MissionWorkerAssignmentService } from './src/worker-assignment.ts';",
      "export { MissionParallelReadinessService, MissionParallelAssignmentService } from './src/mission-parallel-orchestration.ts';",
      "export { MissionCognitionPlanService } from './src/mission-cognition-plan.ts';",
      "export { MissionAutonomyLoopService, parsePracticeReport, parseCognitionDecision } from './src/mission-autonomy-loop.ts';",
    ].join('\n'), resolveDir: root, sourcefile: 'autonomy-loop-entry.ts', loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'cjs', target: 'es2022', logLevel: 'silent',
  });
  const lib = require(outfile);
  const wireDecision = { version: 1, kind: 'nimora-cognition-decision', summary: 'Quoted criteria: ["SEED.txt"] and \\paths\nremain exact.',
    answers: [], workOrders: [], additionalMissions: [], finalizeMissionIds: [], projectCompletionCandidate: false };
  const wireReport = { version: 1, kind: 'nimora-practice-report', summary: wireDecision.summary,
    findings: ['Exact quotes: "verified"'], problems: [], completionCandidate: false };
  for (const [parse, value] of [[lib.parseCognitionDecision, wireDecision], [lib.parsePracticeReport, wireReport]]) {
    const json = JSON.stringify(value);
    assert.deepEqual(parse('```json\n' + json + '\n```'), parse(json), 'whole-reply fence preserves escaped strings and strict schema');
    assert.deepEqual(parse('```\r\n' + json + '\r\n```'), parse(json));
    for (const invalid of ['Prose\n```json\n' + json + '\n```', '```json\n' + json + '\n```\nProse',
      '```json\n' + json + '\n```\n```json\n' + json + '\n```', '```json\n' + json + '\n' + json + '\n```',
      '```json\n{"summary":"unescaped "quotes""}\n```', '```javascript\n' + json + '\n```']) {
      assert.throws(() => parse(invalid), /exactly one valid JSON object/, 'no substring salvage, quote repair or multiple values');
    }
    assert.throws(() => parse('```json\n' + JSON.stringify({ ...value, unauthorized: true }) + '\n```'), /unsupported fields/);
    assert.throws(() => parse('```json\n' + JSON.stringify({ ...value, kind: 'wrong-contract' }) + '\n```'), /Unsupported/);
    assert.throws(() => parse('```json\n' + ' '.repeat(64_001) + json + '\n```'), /Invalid/);
  }
  class FakeAdapter {
    constructor(id, responder) { this.id = id; this.responder = responder; this.created = 0; this.inputs = []; this.results = []; }
    async describe() { return { id: this.id, provider: 'fake', kind: 'api', label: this.id, availability: 'available', models: ['fake'],
      capabilities: { streaming: true, reasoning: true, capabilityRequests: true, imageInput: false, checkpoints: false, interruption: true, persistentContext: true },
      capabilityProjection: { nativeByName: false, externalDefinitions: true, executionRoutes: [] } }; }
    async createSession(options) { const now = new Date().toISOString(); return { sessionId: this.id + '-session-' + (++this.created), workerId: this.id, state: 'idle', model: options.model, createdAt: now, lastActiveAt: now }; }
    async *send(session, input) {
      this.inputs.push(structuredClone(input)); session.state = 'running';
      try {
        const response = await this.responder(input, this.inputs.length);
        if (response && response.coordinator === true) {
          yield { type: 'capability_call', inputId: input.inputId, callId: 'call-' + input.inputId,
            name: input.externalCapabilities[0].name, arguments: {}, dispatch: 'host-requested' };
        } else if (typeof response === 'string') {
          yield { type: 'text_delta', inputId: input.inputId, text: response };
        } else if (response && typeof response.finalText === 'string') {
          yield { type: 'text_delta', inputId: input.inputId, text: String(response.presentationText ?? response.finalText) };
        }
        session.state = 'idle';
        const finalText = typeof response === 'string' ? response : response && typeof response.finalText === 'string' ? response.finalText : undefined;
        yield { type: 'terminal', inputId: input.inputId, status: 'completed', ...(finalText === undefined ? {} : { result: { text: finalText } }) };
      } finally { if (session.state === 'running') session.state = 'idle'; }
    }
    async submitCapabilityResult(_session, result) { this.results.push(structuredClone(result)); }
    async interrupt(session) { session.state = 'interrupted'; }
    async dispose(session) { session.state = 'disposed'; }
    async health() { return { status: 'healthy', checkedAt: new Date().toISOString() }; }
  }

  let taskSeq = 0;
  const projects = new lib.ProjectStore({ storageDirectory: path.join(tmp, 'projects'), newId: () => 'autonomy-project' });
  const tasks = new lib.TaskRuntime({ storageDirectory: path.join(tmp, 'tasks'), newId: () => 'autonomy-task-' + (++taskSeq) });
  await Promise.all([projects.initialize(), tasks.initialize()]);
  const project = await projects.createProject({ title: 'Autonomy loop', goal: 'Close Practice feedback through owning Cognition.' });
  const rootTask = await tasks.ensureTask({ kind: 'mission', key: 'autonomy-root' }, 'Own planning and reconcile Practice reality');
  const rootMission = await tasks.configureMission(rootTask.taskId, { projectId: project.projectId, rootMissionId: rootTask.taskId,
    plane: 'cognition', missionType: 'project-cognition', completionCriteria: ['A and B verified'] });
  const collaboration = new lib.MissionCollaborationStore({ storageDirectory: path.join(tmp, 'collaboration'), projects, tasks });
  await collaboration.initialize();
  const feedback = new lib.MissionFeedbackService(projects, tasks, collaboration);
  const coordinator = new lib.MissionCoordinatorService(projects, tasks, collaboration, feedback);
  const coordinatorMission = await coordinator.ensureCoordinatorMission({ projectId: project.projectId, managedRootMissionId: rootMission.taskId });
  const practiceA = await coordinator.ensureMission({ projectId: project.projectId, managedRootMissionId: rootMission.taskId,
    operationKey: 'autonomy-practice-a', parentMissionId: rootMission.taskId, goal: 'Practice A', plane: 'practice',
    missionType: 'implementation', completionCriteria: ['A verified'] });
  const practiceB = await coordinator.ensureMission({ projectId: project.projectId, managedRootMissionId: rootMission.taskId,
    operationKey: 'autonomy-practice-b', parentMissionId: rootMission.taskId, goal: 'Practice B', plane: 'practice',
    missionType: 'implementation', completionCriteria: ['B verified'] });
  for (let index = 0; index < 80; index += 1) {
    await collaboration.recordExchange({
      exchangeId: `historical-finding-${index}`, projectId: project.projectId,
      sourceMissionId: practiceA.taskId, targetMissionId: rootMission.taskId, kind: 'Finding',
      payload: { summary: `Historical verbose fact ${index}: ${'x'.repeat(2000)}`, evidenceExchangeIds: [] },
    });
  }

  const manager = new lib.WorkerSessionManager({ taskBindings: tasks, newId: (() => { let n = 0; return () => 'autonomy-managed-' + (++n); })() });
  let cognitionCall = 0;
  const coordinatorAdapter = new FakeAdapter('coord-worker', async () => ({ coordinator: true }));
  const cognitionAdapter = new FakeAdapter('cognition-worker', async input => {
    cognitionCall += 1;
    if (cognitionCall === 1) return JSON.stringify({ version: 1, kind: 'nimora-cognition-decision',
      summary: 'Invalid first decision must be corrected.', answers: [],
      workOrders: [{ targetMissionId: practiceA.taskId, instruction: 'Execute A and verify it.', requiredCapabilityIds: [], allowedWorkspacePathPrefixes: ['.'] }],
      additionalMissions: [], finalizeMissionIds: [rootMission.taskId], projectCompletionCandidate: false });
    if (cognitionCall === 2) {
      assert.match(input.prompt, /NEW bounded decision turn, not a replay/);
      assert.match(input.prompt, /cannot target root or Coordinator/);
      return JSON.stringify({ version: 1, kind: 'nimora-cognition-decision',
      summary: 'A and B are independent.', answers: [],
      workOrders: [
        { targetMissionId: practiceA.taskId, instruction: 'Execute A and verify it.', requiredCapabilityIds: [], allowedWorkspacePathPrefixes: ['.'] },
        { targetMissionId: practiceB.taskId, instruction: 'Execute B and report blocking reality.', requiredCapabilityIds: [], allowedWorkspacePathPrefixes: ['.'] },
      ], additionalMissions: [], finalizeMissionIds: [], projectCompletionCandidate: false });
    }
    if (cognitionCall === 3) {
      const problem = input.prompt.match(/autonomy:problem:v1:[a-f0-9]+/)?.[0];
      const evidence = input.prompt.match(/autonomy:evidence:v1:[a-f0-9]+/)?.[0];
      assert(problem && evidence, 'round 2 Cognition must receive durable Problem/Evidence');
      return JSON.stringify({ version: 1, kind: 'nimora-cognition-decision', summary: 'A complete; revise B.',
        answers: [{ problemExchangeId: problem, answer: 'Follow Reality Y.', evidenceExchangeIds: [evidence] }],
        workOrders: [{ targetMissionId: practiceB.taskId, instruction: 'Use revised cognition and verify B.', requiredCapabilityIds: [], allowedWorkspacePathPrefixes: ['.'] }],
        additionalMissions: [], finalizeMissionIds: [practiceA.taskId], projectCompletionCandidate: false });
    }
    return JSON.stringify({ version: 1, kind: 'nimora-cognition-decision', summary: 'Both Practices verified.',
      answers: [], workOrders: [], additionalMissions: [], finalizeMissionIds: [practiceB.taskId], projectCompletionCandidate: true });
  });
  let practiceATurn = 0;
  const practiceAAdapter = new FakeAdapter('practice-a-worker', async input => {
    practiceATurn += 1;
    const finalText = JSON.stringify({ version: 1, kind: 'nimora-practice-report',
      summary: 'A completed at reality boundary.', findings: ['A is internally consistent.'], problems: [], completionCandidate: true });
    if (practiceATurn === 1) {
      return { presentationText: 'All checks pass before the contract. ' + finalText,
        finalText: 'All checks pass before the contract. ' + finalText };
    }
    assert.match(input.prompt, /immediately previous Work Order is already fully settled/);
    assert.match(input.prompt, /Do NOT repeat any work, do NOT call tools/);
    return { presentationText: finalText, finalText };
  });
  let practiceBTurn = 0;
  const practiceBAdapter = new FakeAdapter('practice-b-worker', async () => {
    practiceBTurn += 1;
    if (practiceBTurn === 1) return JSON.stringify({ version: 1, kind: 'nimora-practice-report', summary: 'B hit a mismatch.',
      findings: [], problems: [{ currentGoal: 'Complete B', previousAssumption: 'Assumption X', observedReality: 'Reality Y contradicts X',
        preciseQuestion: 'Should B follow Reality Y?', blocking: true }], completionCandidate: false });
    return JSON.stringify({ version: 1, kind: 'nimora-practice-report', summary: 'B now verifies.',
      findings: ['B verification passes.'], problems: [{ currentGoal: 'Document a small follow-up', previousAssumption: 'No caveat remains',
        observedReality: 'A non-blocking documentation caveat remains', preciseQuestion: 'Should this be noted later?', blocking: false }], completionCandidate: true });
  });
  for (const adapter of [coordinatorAdapter, cognitionAdapter, practiceAAdapter, practiceBAdapter]) await manager.register(adapter);
  const coordSession = await manager.createSession(coordinatorAdapter.id, { model: 'fake' }, coordinatorMission.taskId);
  await manager.createSession(cognitionAdapter.id, { model: 'fake' }, rootMission.taskId);
  await manager.createSession(practiceAAdapter.id, { model: 'fake' }, practiceA.taskId);
  await manager.createSession(practiceBAdapter.id, { model: 'fake' }, practiceB.taskId);

  const context = new lib.MissionContextMaterializer(projects, tasks, collaboration, manager);
  const capability = new lib.MissionCapabilityMaterializer(projects, tasks, manager, []);
  const skills = new lib.MissionSkillMaterializer(projects, tasks, manager, new lib.NimoraSkillIndex([]));
  const materializer = new lib.MissionWorkerInputMaterializer(context, capability, skills, tasks, manager);
  const decisions = new lib.ProjectDecisionService(projects, tasks);
  const finalization = new lib.MissionFinalizationService(tasks, manager);
  const driver = new lib.MissionCoordinatorLiveDriver(projects, tasks, collaboration, coordinator, feedback, decisions, manager, undefined, materializer);
  const assignments = new lib.MissionWorkerAssignmentService(tasks, manager, []);
  const readiness = new lib.MissionParallelReadinessService(projects, tasks, collaboration, manager);
  const parallel = new lib.MissionParallelAssignmentService(readiness, assignments);
  const plannedWork = new lib.MissionCognitionPlanService(coordinator, collaboration, readiness, parallel);
  const autonomy = new lib.MissionAutonomyLoopService(tasks, collaboration, manager, coordinator, driver, plannedWork, readiness, finalization);

  assert.throws(() => lib.parsePracticeReport('~~~json {}'), /exactly one valid JSON/);
  assert.throws(() => lib.parseCognitionDecision(JSON.stringify({ version: 1, kind: 'nimora-cognition-decision', summary: 'bad',
    answers: [], workOrders: [
      { targetMissionId: practiceA.taskId, instruction: 'x', requiredCapabilityIds: [], allowedWorkspacePathPrefixes: ['.'] },
      { targetMissionId: practiceA.taskId, instruction: 'y', requiredCapabilityIds: [], allowedWorkspacePathPrefixes: ['.'] },
    ], additionalMissions: [], finalizeMissionIds: [], projectCompletionCandidate: false })), /at most one Work Order/);
  assert.throws(() => lib.parseCognitionDecision(JSON.stringify({ version: 1, kind: 'nimora-cognition-decision', summary: 'bad path scope',
    answers: [], workOrders: [
      { targetMissionId: practiceA.taskId, instruction: 'x', requiredCapabilityIds: [] },
    ], additionalMissions: [], finalizeMissionIds: [], projectCompletionCandidate: false })), /workspace path prefixes/);

  const outcome = await autonomy.run({ projectId: project.projectId, rootMissionId: rootMission.taskId,
    coordinationMissionId: coordinatorMission.taskId }, { maxRounds: 4 });
  assert.equal(outcome.state, 'completion-candidate');
  assert.equal(outcome.rounds.length, 3);
  assert.equal(outcome.rounds[0].work.length, 2, 'first Coordinator Work Order turn must fan out A+B');
  assert.equal(practiceAAdapter.inputs.length, 2, 'malformed-but-settled Practice report gets exactly one tools-free normalization turn');
  assert.equal(practiceAAdapter.inputs[1].externalCapabilities.length, 0,
    'report normalization must not expose any capability/tool surface');
  assert.equal(practiceBAdapter.inputs.length, 2);
  assert.equal(cognitionAdapter.inputs.length, 4, 'one invalid completed decision gets exactly one fresh correction turn');
  assert(cognitionAdapter.inputs.every(input => input.prompt.length < 24_000), 'Cognition receives a bounded working set instead of the full durable history');
  assert.match(cognitionAdapter.inputs[0].prompt, /\\"total\\":80/);
  assert.match(cognitionAdapter.inputs[0].prompt, /workspace\.read-files/, 'Cognition receives exact canonical capability ids');
  assert.match(cognitionAdapter.inputs[0].prompt, /requiredCapabilityIds must use exact ids from capabilityCatalog/);
  assert.match(cognitionAdapter.inputs[0].prompt, /allowedWorkspacePathPrefixes must contain the smallest workspace-relative literal/);
  assert.match(cognitionAdapter.inputs[0].prompt, /finalizeMissionIds must be a subset of finalizableMissionIds/);
  const finalizableStart = cognitionAdapter.inputs[0].prompt.lastIndexOf('finalizableMissionIds');
  const finalizableEnd = cognitionAdapter.inputs[0].prompt.indexOf(']', finalizableStart);
  assert(finalizableStart >= 0 && finalizableEnd > finalizableStart, 'finalizableMissionIds array must be materialized into the Cognition prompt');
  const finalizableSection = cognitionAdapter.inputs[0].prompt.slice(finalizableStart, finalizableEnd + 1);
  const finalizableIds = new Set(finalizableSection.match(/autonomy-task-\d+/g) ?? []);
  assert(finalizableIds.has(practiceA.taskId));
  assert(finalizableIds.has(practiceB.taskId));
  assert(!finalizableIds.has(rootMission.taskId), 'root must never be offered as a child finalization target');
  assert(!finalizableIds.has(coordinatorMission.taskId), 'Coordinator must never be offered as a child finalization target');
  assert.doesNotMatch(cognitionAdapter.inputs[0].prompt, /exact capability semantic id/);
  assert.equal(coordinatorAdapter.inputs.length, 7, '3 valid Cognition reviews + 1 bounded correction + 2 Work Order turns + 1 report-normalization turn');
  assert.equal(manager.getSession(coordSession.managedSessionId)?.state, 'idle');
  const exchanges = collaboration.listExchanges(project.projectId);
  const problem = exchanges.find(exchange => exchange.kind === 'Problem' && exchange.sourceMissionId === practiceB.taskId);
  assert(problem);
  const answer = exchanges.find(exchange => exchange.kind === 'Answer' && exchange.replyToExchangeId === problem.exchangeId);
  assert(answer && answer.sourceMissionId === rootMission.taskId && answer.targetMissionId === practiceB.taskId);
  const evidence = exchanges.filter(exchange => exchange.kind === 'Evidence');
  assert.equal(evidence.length, 3);
  assert(evidence.every(exchange => exchange.payload.references.some(ref => ref.type === 'command' && ref.command.startsWith('nimora-worker-turn:'))));
  const nonBlockingProblem = exchanges.find(exchange => exchange.kind === 'Problem' && exchange.sourceMissionId === practiceB.taskId
    && exchange.payload.blocking === false);
  assert(nonBlockingProblem, 'non-blocking Practice Problem is still durable Reality');
  assert.equal(collaboration.listRelations(project.projectId).some(relation => relation.basisExchangeId === nonBlockingProblem.exchangeId), false,
    'a non-blocking Problem must not be mislabeled as a Finding-backed informs relation');
  assert(tasks.getTask(practiceA.taskId).missionFinalization);
  assert(tasks.getTask(practiceB.taskId).missionFinalization);
  assert.equal(tasks.getTask(rootMission.taskId).missionFinalization, undefined, 'root stays behind canonical Project completion');
  assert.equal(manager.listSessions({ taskId: practiceA.taskId }).length, 0);
  assert.equal(manager.listSessions({ taskId: practiceB.taskId }).length, 0);
  assert.equal(coordinatorAdapter.results.length, 7);

  // A later root has only Cognition + Coordinator. Decomposition must enter the
  // next round with canonical ids, then execute once and retain formal root gate.
  const laterTask = await tasks.ensureTask({ kind: 'mission', key: 'later-empty-root' }, 'Create and verify bounded follow-up work');
  const laterRoot = await tasks.configureMission(laterTask.taskId, { projectId: project.projectId, rootMissionId: laterTask.taskId,
    plane: 'cognition', missionType: 'project-cognition', completionCriteria: ['Follow-up verified'] });
  const laterCoord = await coordinator.ensureCoordinatorMission({ projectId: project.projectId, managedRootMissionId: laterRoot.taskId });
  let laterCalls = 0;
  const laterPracticeAdapter = new FakeAdapter('later-practice-worker', async input => {
    assert.match(input.prompt, /single fenced json code block/);
    return '```json\n' + JSON.stringify({ ...wireReport, summary: 'Follow-up verified.', findings: ['Observed bounded result.'], completionCandidate: true }) + '\n```';
  });
  const laterCognitionAdapter = new FakeAdapter('later-cognition-worker', async input => {
    laterCalls++;
    assert.match(input.prompt, /never the root Cognition or Coordinator/);
    assert.match(input.prompt, /leave workOrders empty and projectCompletionCandidate=false/);
    const children = tasks.listTasks().filter(t => t.mission?.rootMissionId === laterRoot.taskId && t.mission?.plane === 'practice');
    let decision;
    if (laterCalls === 1) {
      assert.equal(children.length, 0);
      decision = { ...wireDecision, additionalMissions: [{ key: 'follow-up', goal: 'Verify bounded follow-up', plane: 'practice',
        missionType: 'verification', completionCriteria: ['Observed result verifies'], dependsOn: [] }] };
    } else {
      assert.equal(children.length, 1, 'one established child, no repeated decomposition');
      assert(input.prompt.includes(children[0].taskId), 'next decision receives the canonical Practice id');
      decision = laterCalls === 2 ? { ...wireDecision, workOrders: [{ targetMissionId: children[0].taskId, instruction: 'Verify the bounded result.',
        requiredCapabilityIds: [], allowedWorkspacePathPrefixes: ['SEED.txt'] }] }
        : { ...wireDecision, finalizeMissionIds: [children[0].taskId], projectCompletionCandidate: true };
    }
    return '```json\n' + JSON.stringify(decision) + '\n```';
  });
  await manager.register(laterPracticeAdapter);
  await manager.register(laterCognitionAdapter);
  await manager.createSession(coordinatorAdapter.id, { model: 'fake' }, laterCoord.taskId);
  await manager.createSession(laterCognitionAdapter.id, { model: 'fake' }, laterRoot.taskId);
  const laterOutcome = await autonomy.run({ projectId: project.projectId, rootMissionId: laterRoot.taskId,
    coordinationMissionId: laterCoord.taskId }, { maxRounds: 3, ensureAssigned: async ids => {
      assert.equal(ids.length, 1);
      await manager.createSession(laterPracticeAdapter.id, { model: 'fake' }, ids[0]);
    } });
  assert.equal(laterOutcome.state, 'completion-candidate');
  assert.equal(laterOutcome.rounds.length, 3, 'decomposition -> canonical Work Order -> evidence reconciliation');
  assert.equal(laterOutcome.rounds[0].work.length, 0);
  assert.equal(laterPracticeAdapter.inputs.length, 1, 'Work Order delivered once');
  assert.equal(new Set(laterCognitionAdapter.inputs.map(input => input.inputId)).size, 3, 'new decisions never replay consumed inputs');
  assert.equal(tasks.getTask(laterRoot.taskId).missionFinalization, undefined, 'formal completion remains independent');

  const serialTask = await tasks.ensureTask({ kind: 'mission', key: 'serial-root' }, 'Respect the single-task parallel limit');
  const serialRoot = await tasks.configureMission(serialTask.taskId, { projectId: project.projectId, rootMissionId: serialTask.taskId,
    plane: 'cognition', missionType: 'project-cognition', completionCriteria: ['Two independent results verified'] });
  const serialCoord = await coordinator.ensureCoordinatorMission({ projectId: project.projectId, managedRootMissionId: serialTask.taskId });
  const serialChildren = [];
  for (const key of ['serial-a', 'serial-b']) serialChildren.push(await coordinator.ensureMission({ projectId: project.projectId,
    managedRootMissionId: serialTask.taskId, operationKey: key, parentMissionId: serialTask.taskId,
    goal: key, plane: 'practice', missionType: 'verification', completionCriteria: ['Verified'] }));
  let serialDecisions = 0;
  const serialCognition = new FakeAdapter('serial-cognition', async () => JSON.stringify(++serialDecisions === 1
    ? { ...wireDecision, workOrders: serialChildren.map(child => ({ targetMissionId: child.taskId,
      instruction: 'Verify this independent result.', requiredCapabilityIds: [], allowedWorkspacePathPrefixes: ['SEED.txt'] })) }
    : { ...wireDecision, finalizeMissionIds: serialChildren.map(child => child.taskId), projectCompletionCandidate: true }));
  await manager.register(serialCognition);
  await manager.createSession(serialCognition.id, { model: 'fake' }, serialTask.taskId);
  await manager.createSession(coordinatorAdapter.id, { model: 'fake' }, serialCoord.taskId);
  for (const child of serialChildren) {
    const adapter = new FakeAdapter('worker-' + child.taskId, async () => JSON.stringify({ ...wireReport, completionCandidate: true }));
    await manager.register(adapter);
    await manager.createSession(adapter.id, { model: 'fake' }, child.taskId);
  }
  const serialBatchSizes = [];
  const serialDriver = { executeCoordinatorCommandTurn: async (...args) => {
    if (args[0].command.kind === 'deliverParallelExplicitMissionInputs') serialBatchSizes.push(args[0].command.arguments.deliveries.length);
    return driver.executeCoordinatorCommandTurn(...args);
  } };
  const serialAutonomy = new lib.MissionAutonomyLoopService(tasks, collaboration, manager, coordinator, serialDriver, plannedWork, readiness, finalization);
  const serialScope = { projectId: project.projectId, rootMissionId: serialRoot.taskId, coordinationMissionId: serialCoord.taskId };
  await assert.rejects(() => serialAutonomy.run(serialScope, { maxParallel: 3 }), /parallel bound must be one or two/);
  assert.equal(serialCognition.inputs.length, 0, 'invalid parallel limit is refused before any provider turn');
  const serialOutcome = await serialAutonomy.run(serialScope, { maxRounds: 2, maxParallel: 1 });
  assert.equal(serialOutcome.state, 'completion-candidate');
  assert.deepEqual(serialBatchSizes, [1, 1], 'two independent Practice orders run in separate owned batches');
  assert.equal(serialOutcome.rounds[0].work.length, 2, 'both settled results remain in the same Cognition round');

  const limitedTask = await tasks.ensureTask({ kind: 'mission', key: 'limited-decomposition-root' }, 'Bound planning-only rounds');
  const limitedRoot = await tasks.configureMission(limitedTask.taskId, { projectId: project.projectId, rootMissionId: limitedTask.taskId,
    plane: 'cognition', missionType: 'project-cognition', completionCriteria: ['Bounded plan'] });
  const limitedCoord = await coordinator.ensureCoordinatorMission({ projectId: project.projectId, managedRootMissionId: limitedRoot.taskId });
  const limitedAdapter = new FakeAdapter('limited-cognition-worker', async () => JSON.stringify({ ...wireDecision,
    additionalMissions: [{ key: 'next-work', goal: 'Bounded planned work', plane: 'practice', missionType: 'verification',
      completionCriteria: ['Verified'], dependsOn: [] }] }));
  await manager.register(limitedAdapter);
  await manager.createSession(limitedAdapter.id, { model: 'fake' }, limitedRoot.taskId);
  await manager.createSession(coordinatorAdapter.id, { model: 'fake' }, limitedCoord.taskId);
  const limitedOutcome = await autonomy.run({ projectId: project.projectId, rootMissionId: limitedRoot.taskId,
    coordinationMissionId: limitedCoord.taskId }, { maxRounds: 99 });
  assert.equal(limitedOutcome.state, 'round-limit');
  assert.equal(limitedOutcome.rounds.length, 8, 'planning-only continuation cannot bypass the existing eight-round ceiling');
  assert.equal(limitedAdapter.inputs.length, 8, 'no hidden ninth turn');
  assert(limitedOutcome.rounds.every(round => round.work.length === 0));

  // A settled host capability error is Reality, not UNKNOWN. It must become
  // durable Evidence + a blocking Problem, then return to owning Cognition in
  // a fresh decision turn without replaying the failed Practice input.
  const failureRootTask = await tasks.ensureTask({ kind: 'mission', key: 'autonomy-failure-root' }, 'Own deterministic Practice failure reconciliation');
  const failureRoot = await tasks.configureMission(failureRootTask.taskId, { projectId: project.projectId, rootMissionId: failureRootTask.taskId,
    plane: 'cognition', missionType: 'project-cognition', completionCriteria: ['Failure reconciled'] });
  const failureCoordinator = await coordinator.ensureCoordinatorMission({ projectId: project.projectId, managedRootMissionId: failureRoot.taskId });
  const failurePractice = await coordinator.ensureMission({ projectId: project.projectId, managedRootMissionId: failureRoot.taskId,
    operationKey: 'autonomy-failure-practice', parentMissionId: failureRoot.taskId, goal: 'Exercise a deterministic host tool failure', plane: 'practice',
    missionType: 'verification', completionCriteria: ['Failure becomes durable feedback'] });
  const failureWebAdapter = new FakeAdapter('nimora.web-worker', async () => { throw new Error('failure stub driver must own transport'); });
  await manager.register(failureWebAdapter);
  await manager.createSession(coordinatorAdapter.id, { model: 'fake' }, failureCoordinator.taskId);
  await manager.createSession(cognitionAdapter.id, { model: 'fake' }, failureRoot.taskId);
  const failurePracticeSession = await manager.createSession(failureWebAdapter.id, { model: 'fake' }, failurePractice.taskId);
  let failureCognitionTurns = 0;
  let failureWorkTurns = 0;
  const failureDriver = {
    async executeCoordinatorCommandTurn(input, onTargetText, _checkpointTargetObservation, onTargetTerminalText) {
      if (input.command.kind === 'deliverExplicitMissionInput') {
        failureCognitionTurns += 1;
        const prompt = input.command.arguments.instruction;
        let decision;
        if (failureCognitionTurns === 1) {
          decision = { version: 1, kind: 'nimora-cognition-decision', summary: 'Exercise one bounded Practice tool path.', answers: [],
            workOrders: [{ targetMissionId: failurePractice.taskId, instruction: 'Check the bounded terminal fact and report reality.', requiredCapabilityIds: [], allowedWorkspacePathPrefixes: ['.'] }],
            additionalMissions: [], finalizeMissionIds: [], projectCompletionCandidate: false };
        } else {
          const problemId = prompt.match(/autonomy:transport-problem:v1:[a-f0-9]+/)?.[0];
          const evidenceId = prompt.match(/autonomy:transport-evidence:v1:[a-f0-9]+/)?.[0];
          assert(problemId && evidenceId, 'next Cognition round must receive host-derived capability-error Problem/Evidence');
          decision = { version: 1, kind: 'nimora-cognition-decision', summary: 'The failed input is not replayed; stop after reconciling the tool contract.',
            answers: [{ problemExchangeId: problemId, answer: 'Use the exact run_command command_id on any future new Work Order; do not replay this failed input.', evidenceExchangeIds: [evidenceId] }],
            workOrders: [], additionalMissions: [], finalizeMissionIds: [], projectCompletionCandidate: false };
        }
        onTargetText?.(JSON.stringify(decision), failureRoot.taskId);
        onTargetTerminalText?.(JSON.stringify(decision), failureRoot.taskId);
        return { commandResult: { version: 1, kind: 'coordinator-live-transport-observation', targetMissionId: failureRoot.taskId,
          inputId: input.command.arguments.inputId, terminalStatus: 'completed', observedEventKinds: ['text_delta', 'terminal'], eventCount: 2 } };
      }
      if (input.command.kind === 'deliverParallelExplicitMissionInputs') {
        failureWorkTurns += 1;
        assert.equal(failureWorkTurns, 1, 'failed Practice input must never be replayed');
        const delivery = input.command.arguments.deliveries[0];
        assert.equal(delivery.targetMissionId, failurePractice.taskId);
        assert.match(delivery.instruction, /callId is NOT a terminal command_id/);
        assert.match(delivery.instruction, /copy the exact command_id returned by run_command/);
        const executionId = `synthetic-capability-error:${delivery.inputId}`;
        await tasks.claimExecution(failurePractice.taskId, { executionId, toolName: 'get_command_output', capabilityId: 'terminal.get-command-output',
          origin: { kind: 'worker', managedSessionId: failurePracticeSession.managedSessionId, workerId: 'nimora.web-worker',
            inputId: delivery.inputId, callId: 'synthetic-bad-command-id' } });
        await tasks.finishExecutionStrict(failurePractice.taskId, executionId, 'failed', {
          error: 'Unknown command_id: synthetic-call-id', resultSummary: 'Unknown command_id: synthetic-call-id',
        });
        await tasks.markResultPreparedStrict(failurePractice.taskId, executionId, { kind: 'worker-capability', inputId: delivery.inputId,
          callId: 'synthetic-bad-command-id', name: 'get_command_output', text: 'Unknown command_id: synthetic-call-id', isError: true });
        await tasks.markDeliveredStrict(failurePractice.taskId, executionId);
        return { commandResult: [{ version: 1, kind: 'coordinator-live-transport-observation', targetMissionId: failurePractice.taskId,
          inputId: delivery.inputId, terminalStatus: 'error', hostStopReason: 'capability-error',
          terminalError: '自动执行已停止：get_command_output 返回工具错误。执行和结果投递记录已保留；不会继续调用、重试或重放本轮。',
          observedEventKinds: ['capability_call'], eventCount: 1 }] };
      }
      throw new Error(`Unexpected failure-driver command: ${input.command.kind}`);
    },
  };
  const failureAutonomy = new lib.MissionAutonomyLoopService(tasks, collaboration, manager, coordinator, failureDriver, plannedWork, readiness, finalization);
  const failureOutcome = await failureAutonomy.run({ projectId: project.projectId, rootMissionId: failureRoot.taskId,
    coordinationMissionId: failureCoordinator.taskId }, { maxRounds: 3 });
  assert.equal(failureOutcome.state, 'quiescent');
  assert.equal(failureOutcome.rounds.length, 2, 'settled capability error must return to Cognition as a new round');
  assert.equal(failureWorkTurns, 1, 'failed Practice input is consumed once');
  const failureExchanges = collaboration.listExchanges(project.projectId).filter(exchange =>
    exchange.sourceMissionId === failurePractice.taskId || exchange.targetMissionId === failureRoot.taskId);
  const transportEvidence = failureExchanges.find(exchange => exchange.kind === 'Evidence' && exchange.exchangeId.startsWith('autonomy:transport-evidence:v1:'));
  const transportProblem = failureExchanges.find(exchange => exchange.kind === 'Problem' && exchange.exchangeId.startsWith('autonomy:transport-problem:v1:'));
  assert(transportEvidence && transportProblem, 'settled capability error must persist host-derived Evidence and Problem');
  assert(transportProblem.payload.evidenceExchangeIds.includes(transportEvidence.exchangeId));
  const transportAnswer = collaboration.listExchanges(project.projectId).find(exchange =>
    exchange.kind === 'Answer' && exchange.replyToExchangeId === transportProblem.exchangeId);
  assert(transportAnswer && transportAnswer.sourceMissionId === failureRoot.taskId && transportAnswer.targetMissionId === failurePractice.taskId);

  console.log('PASS mission autonomy loop: strict whole-reply JSON encoding, bounded Cognition correction, later-root decomposition -> canonical Practice -> once-only Work Order, eight-round ceiling, parallel fan-out, report feedback, settled capability-error -> durable Problem/Evidence without replay, child finalization, root completion gate preserved');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
