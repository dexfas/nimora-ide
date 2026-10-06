import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-api-runtime-e2e-'));
let runtime: any;
let modelRequests = 0;
let semanticPhase = true;
let semanticName = '';
let semanticWireName = '';
let semanticWireArguments = '';
let invalidArguments: string | undefined;
let repeatedAcknowledgement = false;
let profilesPhase = false;
let composedPhase = false;
let composedPracticeId = '', composedCognitionTurns = 0, composedPracticeSteps = 0;
const profileCalls: { model: string; authorization: string }[] = [];
const patch = '*** Begin Patch\n*** Update File: fixture.txt\n@@\n-BEFORE\n+AFTER\n*** End Patch';
const model = createServer(async (request, response) => {
  try {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (composedPhase) {
      let call, content;
      if (body.tools?.length === 1 && body.tools[0].function.parameters.properties?.invocation_id) {
        call = { index: 0, id: 'composed-command', type: 'function', function: { name: body.tools[0].function.name,
          arguments: JSON.stringify({ invocation_id: body.tools[0].function.parameters.properties.invocation_id.enum[0] }) } };
      } else if (body.tools?.length === 2) {
        composedPracticeSteps++;
        assert.deepEqual(body.tools.map(t => t.function.name).sort(), ['apply_patch', 'read_files']);
        if (composedPracticeSteps <= 3) call = { index: 0, id: 'composed-file-' + composedPracticeSteps, type: 'function', function: {
          name: composedPracticeSteps === 2 ? 'apply_patch' : 'read_files', arguments: JSON.stringify(composedPracticeSteps === 2
            ? { patch: '*** Begin Patch\n*** Add File: composed-result.txt\n+VERIFIED\n*** End Patch' }
            : { files: [{ path: composedPracticeSteps === 1 ? 'fixture.txt' : 'composed-result.txt' }] }) } };
        else content = JSON.stringify({ version: 1, kind: 'nimora-practice-report', summary: 'Canonical file results verified.', findings: ['VERIFIED'], problems: [], completionCandidate: true });
      } else if (body.messages.some(m => m.role === 'tool')) {
        assert.equal(body.tools, undefined);
        content = 'Provider accepted the exact host result.';
      } else {
        composedCognitionTurns++;
        content = JSON.stringify({ version: 1, kind: 'nimora-cognition-decision', summary: 'Own the bounded file proof.', answers: [],
          workOrders: composedCognitionTurns === 1 ? [{ targetMissionId: composedPracticeId, instruction: 'Read fixture.txt, add composed-result.txt containing VERIFIED and verify it once.',
            requiredCapabilityIds: ['workspace.read-files', 'workspace.apply-patch'], allowedWorkspacePathPrefixes: ['fixture.txt', 'composed-result.txt'] }] : [],
          additionalMissions: [], finalizeMissionIds: composedCognitionTurns === 1 ? [] : [composedPracticeId], projectCompletionCandidate: composedCognitionTurns > 1 });
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: call ? { tool_calls: [call] } : { content }, finish_reason: call ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      return;
    }
    if (profilesPhase) {
      profileCalls.push({ model: body.model, authorization: String(request.headers.authorization) });
      assert.equal(body.tools?.length ?? 0, 0);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: JSON.stringify({ model: body.model }) }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      return;
    }
    if (semanticPhase) {
      modelRequests++;
      const wireName = body.tools?.[0]?.function.name ?? semanticWireName;
      if (modelRequests === 1) {
        assert.equal(body.tools.length, 1);
        semanticWireName = wireName;
        assert.match(wireName, /^[A-Za-z0-9_-]{1,64}$/); assert.notEqual(wireName, semanticName);
        const identity = body.tools[0].function.parameters.properties.invocation_id.enum[0];
        assert.equal(typeof identity, 'string');
        assert.deepEqual(body.tools[0].function.parameters, { type: 'object', properties: { invocation_id: { type: 'string', enum: [identity] } }, required: ['invocation_id'], additionalProperties: false });
        semanticWireArguments = JSON.stringify({ invocation_id: identity });
        assert.match(body.messages[0].content, /API wire encoding/);
      }
      if (modelRequests === 2) {
        assert.equal(body.tools, undefined, 'acknowledgement cannot grant another semantic invocation');
        const previous = body.messages.findLast(message => message.role === 'assistant' && message.tool_calls?.length);
        assert.equal(previous.tool_calls[0].function.name, wireName);
        assert.equal(body.messages.at(-1).content, 'exact inspection result');
      }
      const call = modelRequests === 1 || repeatedAcknowledgement ? { index: 0, id: 'semantic-call-' + modelRequests, type: 'function', function: { name: wireName, arguments: invalidArguments ?? semanticWireArguments } } : undefined;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: call ? { tool_calls: [call] } : { content: 'inspected' }, finish_reason: null }] }) + '\n\n');
      response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
      return;
    }
    assert.deepEqual(body.tools.map(tool => tool.function.name).sort(), ['apply_patch', 'read_files']);
    modelRequests++;
    const call = modelRequests <= 3 ? { index: 0, id: 'model-call-' + modelRequests, type: 'function', function: {
      name: modelRequests === 2 ? 'apply_patch' : 'read_files', arguments: JSON.stringify(modelRequests === 2 ? { patch } : { files: [{ path: 'fixture.txt' }] }) } } : undefined;
    if (modelRequests > 1) assert.match(JSON.stringify(body.messages), modelRequests === 2 ? /BEFORE/ : /AFTER|status: success/);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: call ? { tool_calls: [call] } : { content: 'verified' }, finish_reason: null }] }) + '\n\n');
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
try {
  await fs.writeFile(path.join(temp, 'fixture.txt'), 'BEFORE\n');
  await require('esbuild').build({ stdin: { contents: `
export { RuntimeClient } from './extensions/shuncode/src/runtime-client.ts';
export { ApiWorkerAdapter } from './extensions/shuncode/src/api-worker-adapter.ts';
export { ApiWorkerCandidateSource } from './extensions/shuncode/src/api-worker-candidate-source.ts';
export { AgentHostWorkerCandidateSource, PlatformAgentHostWorkerAdapter } from './extensions/shuncode/src/agent-host-worker-candidate-source.ts';
export { MissionWorkerAssignmentService } from './src/worker-assignment.ts';
export { WorkerSessionManager } from './src/worker-session-manager.ts';
export { TaskRuntime } from './src/task-runtime.ts';
export { HostCapabilityExecutionCoordinator } from './src/host-capability-execution-coordinator.ts';
export { TaskHostCapabilityExecutionStore } from './src/task-host-capability-execution-store.ts';
export { CapabilityMetadataHostAuthorizer } from './src/host-capability-policy-authorizer.ts';
export { TaskCapabilityGrantResolver } from './src/task-capability-grant-resolver.ts';
export { FileToolHostCapabilityExecutor } from './src/file-host-capability-executor.ts';
export { dispatchHostCapabilityRequest } from './src/host-capability-request-dispatcher.ts';
export { FILE_TOOL_DEFINITIONS } from './src/file-tool-registry.ts';
export { buildMissionCoordinatorWorkerInput } from './src/mission-coordinator-worker-input.ts';
export { WorkerPerformanceObservations } from './src/worker-performance-observations.ts';
export { ProjectStore } from './src/project-store.ts';
export { MissionCollaborationStore } from './src/mission-collaboration-store.ts';
export { MissionFeedbackService } from './src/mission-feedback-service.ts';
export { MissionCoordinatorService } from './src/mission-coordinator-service.ts';
export { MissionCoordinatorLiveDriver } from './src/mission-coordinator-live-driver.ts';
export { ProjectDecisionService } from './src/project-decision-service.ts';
export { MissionFinalizationService } from './src/mission-finalization-service.ts';
export { MissionContextMaterializer } from './src/mission-context-materializer.ts';
export { MissionCapabilityMaterializer } from './src/mission-capability-materializer.ts';
export { CORE_MISSION_CAPABILITY_SCHEMA_SOURCES } from './src/mission-capability-schema-source.ts';
export { NimoraSkillIndex } from './src/mission-skill-index.ts';
export { MissionSkillMaterializer } from './src/mission-skill-materializer.ts';
export { MissionWorkerInputMaterializer } from './src/mission-worker-input-materializer.ts';
export { MissionParallelReadinessService, MissionParallelAssignmentService } from './src/mission-parallel-orchestration.ts';
export { MissionCognitionPlanService } from './src/mission-cognition-plan.ts';
export { MissionAutonomyLoopService } from './src/mission-autonomy-loop.ts';
`, resolveDir: root, loader: 'ts' }, outfile: path.join(temp, 'test.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'vscode-fixture', setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const workspace = { getConfiguration: () => ({ get: () => undefined }), get workspaceFolders() { return [{ uri: { fsPath: globalThis.apiFixtureRoot } }]; } };', loader: 'js' }));
    } }] });
  const api = require(path.join(temp, 'test.cjs'));
  (globalThis as any).apiFixtureRoot = temp;
  runtime = new api.RuntimeClient({ extensionPath: temp, asAbsolutePath: file => path.join(root, 'extensions/shuncode', file) }, { appendLine() {}, append() {} }, { invoke() { throw new Error('Legacy IDE broker bypass is forbidden.'); } });
  const hello = await runtime.hello(); assert.equal(hello.capabilities.missionToolBroker, true);
  const tasks = new api.TaskRuntime({ storageDirectory: path.join(temp, 'tasks') });
  const mission = await tasks.ensureTask({ kind: 'mission', key: 'api-real-runtime' }, 'bounded fixture');
  await tasks.configureMission(mission.taskId, { projectId: 'disposable-project', rootMissionId: mission.taskId, plane: 'practice', missionType: 'fixture', completionCriteria: ['verified'] });
  const workers = new api.WorkerSessionManager({ taskBindings: tasks, executionProjection: tasks });
  await workers.register(new api.ApiWorkerAdapter(runtime, 'nimora.api-runtime', 'fixture-api', true));
  await workers.register(new api.PlatformAgentHostWorkerAdapter(async () => ({ state: 'connected', missionToolPolicy: false, providers: [{ id: 'native', label: 'Native', models: ['native-model'] }] })));
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  const config = { provider: 'fixture-api', model: 'local-http-fixture', workspaceRoot: temp,
    runtime: { baseUrl: `http://127.0.0.1:${(model.address() as any).port}/v1`, protocol: 'chat-completions', apiKey: 'LOCAL_STUB_SENTINEL', retries: 0, firstTokenTimeoutMs: 5000, idleTimeoutMs: 5000, totalTimeoutMs: 15000 } };
  const candidates = new api.ApiWorkerCandidateSource(workers, async () => config);
  const observed = await candidates.enumerateCandidates(); assert.equal(observed.length, 1); assert.equal(observed[0].availability, 'available');
  assert.doesNotMatch(JSON.stringify(observed), /LOCAL_STUB_SENTINEL|baseUrl|apiKey/);
  const assigned = await new api.MissionWorkerAssignmentService(tasks, workers, [new api.AgentHostWorkerCandidateSource(workers, () => true), candidates]).assignInitial({ projectId: 'disposable-project', rootMissionId: mission.taskId,
    missionId: mission.taskId, constraints: { allowedKinds: ['api'], allowedProviders: ['fixture-api'], requiredModel: config.model, requiredCapabilities: { capabilityRequests: true } } });
  const session = workers.getSession(assigned.managedSessionId); assert.ok(session);
  const coordinationMission = structuredClone(tasks.getTask(mission.taskId)); coordinationMission.mission.plane = 'coordination';
  const semanticInput = api.buildMissionCoordinatorWorkerInput({ projectId: 'disposable-project', managedRootMissionId: mission.taskId,
    coordinationMission, session, inputId: 'semantic-api-input',
    inspection: { version: 1, projectId: 'disposable-project', managedRootMissionId: mission.taskId, coordinationMissionId: mission.taskId, missions: [], relations: [], exchanges: [] },
    command: { kind: 'inspectManagedScope', arguments: { projectId: 'disposable-project', managedRootMissionId: mission.taskId } } });
  semanticName = semanticInput.externalCapabilities[0].name;
  const semanticEvents = [];
  for await (const event of workers.send(session.managedSessionId, semanticInput)) {
    semanticEvents.push(event);
    if (event.type === 'capability_call') {
      assert.equal(event.name, semanticName); assert.equal(event.dispatch, 'host-requested'); assert.deepEqual(event.arguments, {});
      await workers.submitCapabilityResult(session.managedSessionId, { inputId: event.inputId, callId: event.callId, name: semanticName, text: 'exact inspection result' });
    }
  }
  assert.equal(semanticEvents.at(-1).status, 'completed'); assert.equal(modelRequests, 2);
  assert.equal(semanticEvents.at(-1).result.text, 'inspected', 'API terminal answer is projected to the canonical Mission semantic text');
  assert.equal(semanticEvents.filter(event => event.type === 'capability_call').length, 1);
  assert.match(semanticInput.prompt, /Payload SHA256: [a-f0-9]{64}/);
  assert.doesNotMatch(semanticInput.prompt, /"arguments":/, 'semantic payload is held in the host, not reconstructed by the Provider');
  for (const malformed of ['{', 'null', '[]', '{}', '{"dummy":true}', '{"invocation_id":"wrong"}', '{"invocation_id":"semantic-api-input","dummy":true}']) {
    invalidArguments = malformed; modelRequests = 0;
    const freshSession = await workers.createSession('nimora.api-runtime', config);
    const invalidEvents = [];
    for await (const event of workers.send(freshSession.managedSessionId, { ...semanticInput, inputId: 'bad-json-' + malformed })) invalidEvents.push(event);
    assert.equal(invalidEvents.filter(e => e.type === 'capability_call').length, 0, 'invalid arguments cannot become an empty authority envelope');
    assert.equal(invalidEvents.at(-1).status, 'error');
    assert.match(invalidEvents.at(-1).error, /arguments.*valid JSON|arguments must be a plain object|Host-bound command result failed/);
    assert.equal(modelRequests, 1, 'invalid call has no retry or acknowledgement');
    await workers.dispose(freshSession.managedSessionId);
  }
  invalidArguments = undefined; repeatedAcknowledgement = true; modelRequests = 0;
  const repeatSession = await workers.createSession('nimora.api-runtime', config);
  let acknowledgedHostCalls = 0;
  const repeatEvents = [];
  for await (const event of workers.send(repeatSession.managedSessionId, { ...semanticInput, inputId: 'repeat-in-ack' })) {
    repeatEvents.push(event);
    if (event.type === 'capability_call') {
      acknowledgedHostCalls++;
      await workers.submitCapabilityResult(repeatSession.managedSessionId, { inputId: event.inputId, callId: event.callId, name: event.name, text: 'exact inspection result' });
    }
  }
  assert.equal(acknowledgedHostCalls, 1);
  assert.equal(repeatEvents.at(-1).status, 'error');
  assert.match(repeatEvents.at(-1).error, /another command after the delivered host result/);
  await workers.dispose(repeatSession.managedSessionId);
  repeatedAcknowledgement = false;
  semanticPhase = false; modelRequests = 0;
  const inputId = 'exact-api-input';
  await tasks.recordInputAccessPolicyStrict(mission.taskId, { inputId, managedSessionId: session.managedSessionId, allowedWorkspacePathPrefixes: ['fixture.txt'] });
  await tasks.grantCapabilityStrict(mission.taskId, { capabilityId: 'workspace.apply-patch', capabilityVersion: 1, scope: 'worker-session', managedSessionId: session.managedSessionId });
  const files = new api.FileToolHostCapabilityExecutor({ workspaceRoots: () => [temp], tasks });
  const count: Record<string, number> = {};
  const execution = new api.HostCapabilityExecutionCoordinator({ durableStore: new api.TaskHostCapabilityExecutionStore(tasks),
    authorizer: new api.CapabilityMetadataHostAuthorizer(new api.TaskCapabilityGrantResolver(tasks)), executor: { execute(request, metadata, admission) {
      count[request.name] = (count[request.name] ?? 0) + 1; return files.execute(request, metadata, admission);
    } } });
  const events = [];
  for await (const event of workers.send(session.managedSessionId, { inputId, prompt: 'Read, patch, validate fixture only.', allowedCapabilities: ['read_files', 'apply_patch'],
    externalCapabilities: api.FILE_TOOL_DEFINITIONS.filter(tool => ['read_files', 'apply_patch'].includes(tool.name)).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) })) {
    events.push(event);
    if (event.type === 'capability_call') {
      assert.equal(event.dispatch, 'host-requested');
      const dispatched = await api.dispatchHostCapabilityRequest(execution, { executionId: event.extensions.executionId, managedSessionId: session.managedSessionId,
        workerId: session.workerId, taskId: mission.taskId, inputId, callId: event.callId, name: event.name, arguments: event.arguments }, workers);
      assert.equal(dispatched.status, 'executed'); assert.notEqual(dispatched.result.isError, true);
    }
  }
  assert.equal(events.at(-1).status, 'completed');
  assert.equal(events.at(-1).result.text, 'verified', 'semantic terminal comes from completed Runtime answer, not a delta');
  assert.equal(modelRequests, 4);
  assert.deepEqual(count, { read_files: 2, apply_patch: 1 });
  assert.equal(await fs.readFile(path.join(temp, 'fixture.txt'), 'utf8'), 'AFTER\n');
  const ledger = Object.values(tasks.getTask(mission.taskId).executions) as any[];
  assert.equal(ledger.length, 3); assert.ok(ledger.every(row => row.status === 'succeeded' && row.deliveryStatus === 'delivered'));
  assert.ok(ledger.every(row => row.origin.inputId === inputId && row.origin.managedSessionId === session.managedSessionId));
  await tasks.flush(); const restored = new api.TaskRuntime({ storageDirectory: path.join(temp, 'tasks') }); await restored.initialize();
  assert.deepEqual(restored.getTask(mission.taskId).executions, tasks.getTask(mission.taskId).executions);
  config.model = 'changed'; await assert.rejects(candidates.materializeSessionOptions(observed[0], { model: 'local-http-fixture' }), /configuration changed/);
  await workers.dispose(session.managedSessionId);
  profilesPhase = true;
  const profiles = [1, 2].map(i => ({ provider: 'fixture-api', profileId: 'profile-' + i, configurationRevision: 'revision-1', model: 'model-' + i,
    workspaceRoot: temp, runtime: { ...config.runtime, apiKey: 'LOCAL_PROFILE_SENTINEL_' + i } }));
  const multiSource = new api.ApiWorkerCandidateSource(workers, async () => profiles);
  const multiCandidates = await multiSource.enumerateCandidates(); assert.equal(multiCandidates.length, 2);
  assert.equal(new Set(multiCandidates.map(c => c.candidateId)).size, 2);
  assert.doesNotMatch(JSON.stringify(multiCandidates), /LOCAL_PROFILE|baseUrl|apiKey/);
  const bound = [];
  for (let i = 0; i < 2; i++) {
    const m = await tasks.ensureTask({ kind: 'mission', key: 'profile-mission-' + i }, 'independent profile');
    await tasks.configureMission(m.taskId, { projectId: 'profiles-project', rootMissionId: m.taskId, plane: 'practice', missionType: 'profile', completionCriteria: ['isolated'] });
    const assignment = await new api.MissionWorkerAssignmentService(tasks, workers, [multiSource]).assignInitial({ projectId: 'profiles-project', rootMissionId: m.taskId, missionId: m.taskId,
      constraints: { allowedKinds: ['api'], allowedProviders: ['fixture-api'], requiredModel: 'model-' + (i + 1) } });
    bound.push(assignment);
  }
  profiles[0].runtime.apiKey = 'LOCAL_ROTATED_SENTINEL'; profiles[0].model = 'changed-model';
  await assert.rejects(multiSource.materializeSessionOptions(multiCandidates[0], { model: 'model-1' }), /configuration changed/);
  assert.equal(await multiSource.refreshCandidate(multiCandidates[0]), undefined);
  await Promise.all(bound.map(async (assignment, i) => {
    const events = [];
    for await (const event of workers.send(assignment.managedSessionId, { inputId: 'profile-input-' + i, prompt: 'Return model only.', allowedCapabilities: [], externalCapabilities: [] })) events.push(event);
    assert.equal(events.at(-1).status, 'completed');
    assert.match(events.filter(e => e.type === 'text_delta').map(e => e.text).join(''), new RegExp('model-' + (i + 1)));
  }));
  assert.deepEqual(profileCalls.sort((a, b) => a.model.localeCompare(b.model)), [1, 2].map(i => ({ model: 'model-' + i, authorization: 'Bearer LOCAL_PROFILE_SENTINEL_' + i })), 'existing sessions retain their own frozen endpoint/model/key after configuration rotation');
  for (const assignment of bound) await workers.dispose(assignment.managedSessionId);
  profilesPhase = false; composedPhase = true; config.model = 'local-http-fixture';
  const projects = new api.ProjectStore({ storageDirectory: path.join(temp, 'composed-projects') }); await projects.initialize();
  const project = await projects.createProject({ goal: 'Full API domain/runtime composition', workspace: temp });
  const rootTask = await tasks.ensureTask({ kind: 'mission', key: 'composed-root' }, 'Own the full API loop');
  await tasks.configureMission(rootTask.taskId, { projectId: project.projectId, rootMissionId: rootTask.taskId, plane: 'cognition', missionType: 'project-cognition', completionCriteria: ['Canonical three-tool proof and Evidence'] });
  const collaboration = new api.MissionCollaborationStore({ storageDirectory: path.join(temp, 'composed-collaboration'), projects, tasks }); await collaboration.initialize();
  const feedback = new api.MissionFeedbackService(projects, tasks, collaboration);
  const coordinator = new api.MissionCoordinatorService(projects, tasks, collaboration, feedback);
  const coord = await coordinator.ensureCoordinatorMission({ projectId: project.projectId, managedRootMissionId: rootTask.taskId });
  const practice = await coordinator.ensureMission({ projectId: project.projectId, managedRootMissionId: rootTask.taskId, parentMissionId: rootTask.taskId,
    operationKey: 'composed-practice', goal: 'Read/add/verify', plane: 'practice', missionType: 'verification', completionCriteria: ['Three delivered successful tools'] });
  composedPracticeId = practice.taskId;
  const assignments = new api.MissionWorkerAssignmentService(tasks, workers, [candidates]);
  const sessions = new Map();
  for (const task of [rootTask, coord, practice]) {
    const assigned = await assignments.assignInitial({ projectId: project.projectId, rootMissionId: rootTask.taskId, missionId: task.taskId,
      constraints: { allowedKinds: ['api'], requiredModel: config.model, requiredCapabilities: { capabilityRequests: true } } });
    sessions.set(task.taskId, assigned.managedSessionId);
  }
  await tasks.grantCapabilityStrict(practice.taskId, { capabilityId: 'workspace.apply-patch', capabilityVersion: 1, scope: 'worker-session', managedSessionId: sessions.get(practice.taskId) });
  const materializer = new api.MissionWorkerInputMaterializer(new api.MissionContextMaterializer(projects, tasks, collaboration, workers),
    new api.MissionCapabilityMaterializer(projects, tasks, workers, api.CORE_MISSION_CAPABILITY_SCHEMA_SOURCES),
    new api.MissionSkillMaterializer(projects, tasks, workers, new api.NimoraSkillIndex([])), tasks, workers);
  const finalization = new api.MissionFinalizationService(tasks, workers);
  const driver = new api.MissionCoordinatorLiveDriver(projects, tasks, collaboration, coordinator, feedback,
    new api.ProjectDecisionService(projects, tasks), workers, undefined, materializer, execution);
  const readiness = new api.MissionParallelReadinessService(projects, tasks, collaboration, workers);
  const plannedWork = new api.MissionCognitionPlanService(coordinator, collaboration, readiness, new api.MissionParallelAssignmentService(readiness, assignments));
  const loop = new api.MissionAutonomyLoopService(tasks, collaboration, workers, coordinator, driver, plannedWork, readiness, finalization);
  const composed = await loop.run({ projectId: project.projectId, rootMissionId: rootTask.taskId, coordinationMissionId: coord.taskId }, { maxRounds: 2, maxParallel: 1 });
  assert.equal(composed.state, 'completion-candidate', JSON.stringify(composed));
  assert.equal(composedCognitionTurns, 2, 'completed API terminal JSON drives planning and Evidence reconciliation without empty-response correction');
  assert.equal(composedPracticeSteps, 4, 'three file requests and one semantic report; no tool replay');
  assert.equal(await fs.readFile(path.join(temp, 'composed-result.txt'), 'utf8'), 'VERIFIED\n');
  const composedExecutions = Object.values(tasks.getTask(practice.taskId).executions) as any[];
  assert.equal(composedExecutions.length, 3); assert(composedExecutions.every(e => e.status === 'succeeded' && e.deliveryStatus === 'delivered'));
  const proof = collaboration.listExchanges(project.projectId).find(e => e.kind === 'Evidence' && e.sourceMissionId === practice.taskId && e.targetMissionId === rootTask.taskId);
  assert(proof);
  assert.equal(tasks.getTask(practice.taskId).missionFinalization.state, 'archived');
  assert.equal(tasks.getTask(rootTask.taskId).missionFinalization, undefined, 'formal Root completion stays independent');
  for (const id of [rootTask.taskId, coord.taskId]) await workers.dispose(sessions.get(id));
  console.log('Full actual API Runtime -> Coordinator -> Cognition -> Phase-8 Practice -> three delivered tools -> Evidence -> child archive -> Root completion candidate PASS. Local HTTP model fixture; no account contacted.');
  const metrics = new api.WorkerPerformanceObservations();
  assert.deepEqual(metrics.snapshot(), { turns: [], cost: 'unknown', quality: 'unknown', quota: 'unknown' });
  for (const durationMs of [10, 20]) metrics.record({ workerId: multiCandidates[1].workerId, model: 'model-2', durationMs, status: 'completed', observedAt: new Date().toISOString(), basis: 'managed-provider-turn' });
  assert.equal(metrics.latency(multiCandidates[1]), 20); assert.equal(metrics.latency(multiCandidates[0]), undefined);
  console.log('Multi API Profile real RPC/local HTTP fixture PASS: independent Missions/concurrent frozen credentials and models, rotation rejects stale discovery, no secret metadata; cost/quality/quota remain unknown. Not real-account acceptance.');
  console.log('API real Runtime RPC + local model stub E2E PASS: provider-safe semantic wire alias and exact canonical return, production candidate source and assignment owner, private config, Phase-8-only schemas, read/patch/read, canonical grants/path policy, 3 delivered executions, exactly 1 patch, durable restart parity, config drift refusal; no real Provider contacted.');
} finally {
  const child = runtime?.process;
  const exited = child && child.exitCode === null ? once(child, 'exit') : Promise.resolve();
  runtime?.dispose(); await exited;
  model.closeAllConnections(); if (model.listening) await new Promise<void>(done => model.close(() => done()));
  delete (globalThis as any).apiFixtureRoot;
  assert.equal(path.dirname(temp), os.tmpdir()); assert.ok(path.basename(temp).startsWith('nimora-api-runtime-e2e-')); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
