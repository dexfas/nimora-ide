import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-phase10-formation-orchestration-'));
const bundlePath = path.join(tempRoot, 'formation-orchestration-smoke.cjs');

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
    `,
    resolveDir: root,
    sourcefile: 'phase10-formation-orchestration-entry.ts',
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
} = require(bundlePath);

const FIXED_AT = '2026-09-17T15:00:00.000Z';
const now = () => new Date(FIXED_AT);

function idFactory(prefix) {
  let seq = 0;
  return () => `${prefix}-${++seq}`;
}

async function directory(name) {
  const value = path.join(tempRoot, name);
  await fs.mkdir(value, { recursive: true });
  return value;
}

function resource(pageId, digestChar, origin, extra = {}) {
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
    resourceIdentity: digestChar.repeat(64),
    ...extra,
  };
}

class FakeWebMcpCommands {
  constructor(resources = []) {
    this.resources = resources.map(value => structuredClone(value));
    this.calls = [];
    this.sends = [];
    this.resolves = [];
    this.sessions = new Map();
    this.expectedCoordinator = undefined;
    this.coordinatorAdapterSessionId = undefined;
    this.throwInputIds = new Set();
    this.failDisconnectSessions = new Set();
  }

  async executeCommand(command, arg) {
    this.calls.push({ command, arg: structuredClone(arg) });
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
        if (!found) throw new Error('FAKE_EXACT_WEBMCP_TARGET_NOT_FOUND');
        const sessionId = `page-session:${found.pageId}`;
        found.pageSessionId = sessionId;
        this.sessions.set(sessionId, { pageId: found.pageId });
        return {
          pageId: found.pageId,
          sessionId,
          site: found.site,
          origin: found.origin,
          href: found.href,
          transport: 'fake-production-equivalent-webmcp',
          status: { enabled: true, composerFound: true },
        };
      }
      case '_shuncode.webMcp.workerHealth':
        return { status: { enabled: true, composerFound: true, isDeepSeekAuthPage: false } };
      case '_shuncode.webMcp.workerSend': {
        this.sends.push({ pageId: arg.pageId, sessionId: arg.sessionId, input: structuredClone(arg.input) });
        if (this.throwInputIds.has(arg.input.inputId)) {
          throw new Error(`INJECTED_TRANSPORT_OUTCOME_UNKNOWN:${arg.input.inputId}`);
        }
        if (arg.sessionId === this.coordinatorAdapterSessionId && this.expectedCoordinator) {
          const commandValue = this.expectedCoordinator;
          return {
            inputId: arg.input.inputId,
            state: 'completed',
            text: 'coordinator exact command transported',
            events: [
              {
                seq: 1,
                type: 'capability_call',
                callId: `call:${arg.input.inputId}`,
                name: missionCoordinatorCommandCapabilityName(commandValue),
                arguments: {},
                dispatch: 'host-requested',
              },
              { seq: 2, type: 'completed', text: 'coordinator exact command transported' },
            ],
          };
        }
        return {
          inputId: arg.input.inputId,
          state: 'completed',
          text: 'target completed exact input',
          events: [{ seq: 1, type: 'completed', text: 'target completed exact input' }],
        };
      }
      case '_shuncode.webMcp.workerResolve':
        this.resolves.push(structuredClone(arg));
        return { ok: true };
      case '_shuncode.webMcp.workerPoll':
        throw new Error('Unexpected poll: fake sends are terminal in the first snapshot.');
      case '_shuncode.webMcp.workerInterrupt':
        return { ok: true };
      case '_shuncode.webMcp.workerDisconnect':
        if (this.failDisconnectSessions.has(arg.sessionId)) throw new Error(`INJECTED_PROVIDER_DISCONNECT_FAILURE:${arg.sessionId}`);
        this.sessions.delete(arg.sessionId);
        return { ok: true };
      default:
        throw new Error(`Unexpected fake WebMCP command: ${command}`);
    }
  }
}

async function createEnvironment(name, resources = [], options = {}) {
  const projectsDirectory = await directory(`${name}-projects`);
  const tasksDirectory = await directory(`${name}-tasks`);
  const collaborationDirectory = await directory(`${name}-collaboration`);
  const clock = options.now ?? now;
  const projects = new ProjectStore({ storageDirectory: projectsDirectory, newId: idFactory(`${name}-project`), now: clock });
  const tasks = new TaskRuntime({
    storageDirectory: tasksDirectory,
    newId: idFactory(`${name}-task`),
    now: clock,
    ...(options.workerOwnerProvenance ? { workerOwnerProvenance: options.workerOwnerProvenance } : {}),
  });
  const collaboration = new MissionCollaborationStore({
    storageDirectory: collaborationDirectory,
    projects,
    tasks,
    newId: idFactory(`${name}-exchange`),
    now: clock,
  });
  const workers = new WorkerSessionManager({
    taskBindings: tasks,
    executionProjection: tasks,
    newId: idFactory(`${name}-managed`),
    now: clock,
  });
  const commands = new FakeWebMcpCommands(resources);
  const transport = new WebMcpCommandTransport(commands, { pollIntervalMs: 1, now: clock });
  const adapter = new WebWorkerAdapter(transport);
  await workers.register(adapter);
  await workers.register(new WebWorkerAdapter(new ChatGptBrowserCommandTransport(commands), 'nimora.chatgpt-browser-worker'));
  const owners = { projects, tasks, collaboration, workers };
  const composition = createMissionWorkProductionComposition(owners, commands, undefined, undefined, options.applicationOptions ?? {});
  return { projectsDirectory, tasksDirectory, collaborationDirectory, projects, tasks, collaboration, workers, commands, transport, adapter, owners, composition };
}

async function reopenEnvironment(name, previous, resources = [], options = {}) {
  const clock = options.now ?? now;
  const projects = new ProjectStore({ storageDirectory: previous.projectsDirectory, newId: idFactory(`${name}-project`), now: clock });
  const tasks = new TaskRuntime({
    storageDirectory: previous.tasksDirectory,
    newId: idFactory(`${name}-task`),
    now: clock,
    ...(options.workerOwnerProvenance ? { workerOwnerProvenance: options.workerOwnerProvenance } : {}),
  });
  const collaboration = new MissionCollaborationStore({
    storageDirectory: previous.collaborationDirectory,
    projects,
    tasks,
    newId: idFactory(`${name}-exchange`),
    now: clock,
  });
  const workers = new WorkerSessionManager({
    taskBindings: tasks,
    executionProjection: tasks,
    newId: idFactory(`${name}-managed`),
    now: clock,
  });
  const commands = new FakeWebMcpCommands(resources);
  const transport = new WebMcpCommandTransport(commands, { pollIntervalMs: 1, now: clock });
  const adapter = new WebWorkerAdapter(transport);
  await workers.register(adapter);
  await workers.register(new WebWorkerAdapter(new ChatGptBrowserCommandTransport(commands), 'nimora.chatgpt-browser-worker'));
  const owners = { projects, tasks, collaboration, workers };
  const composition = createMissionWorkProductionComposition(owners, commands, undefined, undefined, options.applicationOptions ?? {});
  return {
    projectsDirectory: previous.projectsDirectory,
    tasksDirectory: previous.tasksDirectory,
    collaborationDirectory: previous.collaborationDirectory,
    projects,
    tasks,
    collaboration,
    workers,
    commands,
    transport,
    adapter,
    owners,
    composition,
  };
}

async function projectEvents(projectsDirectory) {
  try {
    const text = await fs.readFile(path.join(projectsDirectory, PROJECT_JOURNAL), 'utf8');
    return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function withRealTaskAppendUnknownOnce(tasksDirectory, eventType, operation) {
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
        throw new Error(`INJECTED_REAL_APPEND_UNKNOWN_${eventType}`);
      }
    }
    return result;
  };
  try {
    return await operation();
  } finally {
    fs.appendFile = originalAppendFile;
    assert.equal(injected, true, `real append UNKNOWN must be injected for ${eventType}`);
  }
}

function formationOutcome(formationId, classification = 'clear-intent', overrides = {}) {
  return {
    formationId,
    classification,
    project: {
      title: 'Production Formation Blog',
      goal: 'Deliver the bounded production-formation blog.',
      workspace: '/workspace/formation-blog',
      ...(overrides.project ?? {}),
    },
    initialRoot: {
      goal: 'Execute the exact bounded initial root objective.',
      plane: 'practice',
      missionType: 'automatic-project-root',
      completionCriteria: ['Execute the exact bounded objective.', 'Preserve verified Mission Work authority boundaries.'],
      contextSummary: 'Bounded Formation Cognition result only; no provider transcript authority.',
      constraints: ['Do not invent additional Project strategy.'],
      ...(overrides.initialRoot ?? {}),
    },
  };
}

function phase8Spec() {
  return {
    profile: 'practice',
    budget: {
      maxInstructionChars: 30_000,
      maxContextChars: 50_000,
      maxSkillChars: 10_000,
      maxSchemaChars: 50_000,
      maxCombinedChars: 120_000,
    },
  };
}

async function freshCompositionFrom(environment, name) {
  const projects = new ProjectStore({ storageDirectory: environment.projectsDirectory, newId: idFactory(`${name}-project`), now });
  const tasks = new TaskRuntime({ storageDirectory: environment.tasksDirectory, newId: idFactory(`${name}-task`), now });
  const collaboration = new MissionCollaborationStore({
    storageDirectory: environment.collaborationDirectory,
    projects,
    tasks,
    newId: idFactory(`${name}-exchange`),
    now,
  });
  const workers = new WorkerSessionManager({ taskBindings: tasks, executionProjection: tasks, newId: idFactory(`${name}-managed`), now });
  const commands = new FakeWebMcpCommands([]);
  const transport = new WebMcpCommandTransport(commands, { pollIntervalMs: 1, now });
  await workers.register(new WebWorkerAdapter(transport));
  await workers.register(new WebWorkerAdapter(new ChatGptBrowserCommandTransport(commands), 'nimora.chatgpt-browser-worker'));
  const owners = { projects, tasks, collaboration, workers };
  return { projects, tasks, collaboration, workers, commands, composition: createMissionWorkProductionComposition(owners, commands) };
}

try {
  const extensionSource = await fs.readFile(path.join(root, 'extensions/shuncode/src/extension.ts'), 'utf8');
  assert.equal((extensionSource.match(/new ProjectStore\(/g) ?? []).length, 1, 'production extension must create one canonical ProjectStore');
  assert.match(extensionSource, /const taskRuntime = taskShadow\.executionRuntime\(\);[\s\S]*tasks: taskRuntime,[\s\S]*createMissionWorkProductionComposition\(\s*missionWorkCanonicalOwners,\s*webMcpCommands,\s*hostCapabilityExecution,\s*missionNativeMcp,/, 'Mission Work production composition must consume the canonical TaskRuntime object and only additive stateless execution/binding seams');
  assert.equal((extensionSource.match(/new MissionCollaborationStore\(/g) ?? []).length, 1, 'production extension must create one canonical CollaborationStore');
  assert.equal((extensionSource.match(/new WorkerSessionManager\(/g) ?? []).length, 1, 'production extension must create one canonical WorkerSessionManager');
  assert.equal((extensionSource.match(/new TaskRuntime\(/g) ?? []).length, 0, 'production extension must not create a second TaskRuntime');
  assert.match(extensionSource, /const runtimeIncarnationId = randomUUID\(\);/);
  assert.match(extensionSource, /currentRuntimeIncarnationId:\s*runtimeIncarnationId/);
  assert.match(extensionSource, /currentProcessId:\s*process\.pid/);
  assert.match(extensionSource, /currentSystemBootAt:\s*\(\)\s*=>\s*new Date\(Date\.now\(\) - uptime\(\) \* 1000\)/);
  assert.match(extensionSource, /observeProcess:\s*observeTrustedHostProcess/);
  const processObservationSource = await fs.readFile(path.join(root, 'extensions/shuncode/src/trusted-process-observation.ts'), 'utf8');
  const processMetadataNativeSource = await fs.readFile(path.join(root, 'extensions/shuncode/native/process-metadata/src/process_metadata.cc'), 'utf8');
  assert.match(processObservationSource, /shuncode_process_metadata\.node/);
  assert.match(processObservationSource, /process\.kill\(processId, 0\)/, 'non-Windows/native-unavailable fallback may prove only PID absence and must not invent process generation');
  assert.match(processMetadataNativeSource, /OpenProcess\(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, process_id\)/);
  assert.match(processMetadataNativeSource, /GetProcessTimes\(process, &creation_time, &exit_time, &kernel_time, &user_time\)/);
  assert.match(
    extensionSource,
    /registerCommand\("_shuncode\.projectFormation\.retireAssignedWorker",[\s\S]*?missionWorkProduction\.application\.retireAssignedWorker\(input\)/,
    'Extension Host retirement command must delegate the exact scoped request to the canonical application owner',
  );
  assert.match(
    extensionSource,
    /registerCommand\("_shuncode\.projectFormation\.recoverOrphanedAssignedWorker",[\s\S]*?missionWorkProduction\.application\.recoverOrphanedAssignedWorker\(input\)/,
    'Extension Host orphan recovery command must delegate exact scope to the canonical application owner',
  );

  const clearEnv = await createEnvironment('clear', [
    resource('page-alpha', 'a', 'https://alpha.example'),
    resource('page-beta', 'b', 'https://beta.example'),
    resource('page-native-bypass', 'c', 'https://native.example', { nativeMcpBypass: true }),
  ]);
  const { projects, tasks, collaboration, workers, composition, commands } = clearEnv;
  assert.equal(composition.owners.projects, projects);
  assert.equal(composition.owners.tasks, tasks);
  assert.equal(composition.owners.collaboration, collaboration);
  assert.equal(composition.owners.workers, workers);
  assert.equal(composition.assignmentCandidateSources.length, 2);
  assert.equal(composition.assignmentCandidateSources[0], composition.chatGptCandidates, 'ChatGPT browser Worker must be first in the Phase 11 production pool');
  assert.equal(composition.assignmentCandidateSources[1], composition.webCandidates, 'DeepSeek/WebMCP remains the second production candidate route');

  let legacyCreateCalls = 0;
  projects.createProject = async () => {
    legacyCreateCalls += 1;
    throw new Error('LEGACY_CREATE_PROJECT_BYPASS_FORBIDDEN');
  };

  const mintedFormationId = composition.application.mintFormationId();
  assert.ok(mintedFormationId && !mintedFormationId.includes('provider') && !mintedFormationId.includes('session'));
  const clearOutcome = formationOutcome(mintedFormationId);
  await assert.rejects(
    () => composition.application.submitCognitionOutcome({ ...clearOutcome, rawUserIntent: '完成一个静态个人博客' }),
    /unsupported field: rawUserIntent/,
  );
  assert.equal((await projectEvents(clearEnv.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 0, 'raw chat arrival alone cannot create Project authority');

  const originalEnsureCoordinator = composition.coordinator.ensureCoordinatorMission.bind(composition.coordinator);
  let coordinatorOrderingChecks = 0;
  composition.coordinator.ensureCoordinatorMission = async scope => {
    const project = projects.getProject(scope.projectId);
    const rootTask = await tasks.rereadTask(scope.managedRootMissionId);
    assert.ok(project?.formationReceipt, 'Project receipt must already be durable before Coordinator ensure');
    assert.equal(rootTask?.mission?.projectId, scope.projectId, 'root Mission must already be durable before Coordinator ensure');
    coordinatorOrderingChecks += 1;
    return originalEnsureCoordinator(scope);
  };

  const clearResult = await composition.application.submitCognitionOutcome(clearOutcome);
  assert.equal(clearResult.state, 'formed');
  assert.equal(clearResult.project.formationReceipt.authorization.kind, 'clear-intent-cognition');
  assert.equal(composition.application.getPendingFormation(mintedFormationId), undefined, 'clear intent must not create Human-confirmation ceremony');
  assert.equal(legacyCreateCalls, 0, 'production automatic formation must never call legacy createProject()');
  assert.equal((await projectEvents(clearEnv.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 1);
  assert.ok(coordinatorOrderingChecks >= 1);

  const clearRetry = await composition.application.submitCognitionOutcome(clearOutcome);
  assert.equal(clearRetry.project.projectId, clearResult.project.projectId);
  assert.equal(clearRetry.rootMission.taskId, clearResult.rootMission.taskId);
  assert.equal(clearRetry.coordinatorMission.taskId, clearResult.coordinatorMission.taskId, 'Coordinator retry must converge deterministically');
  assert.equal((await projectEvents(clearEnv.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 1);

  const restartedClear = await freshCompositionFrom(clearEnv, 'clear-restart');
  const clearAfterRestart = await restartedClear.composition.application.submitCognitionOutcome(clearOutcome);
  assert.equal(clearAfterRestart.project.projectId, clearResult.project.projectId);
  assert.equal(clearAfterRestart.rootMission.taskId, clearResult.rootMission.taskId);
  assert.equal(clearAfterRestart.coordinatorMission.taskId, clearResult.coordinatorMission.taskId, 'fresh owner restart must reconstruct the same deterministic Coordinator');

  const coordinatorAssignment = await composition.application.assignInitialWorker({
    projectId: clearResult.project.projectId,
    rootMissionId: clearResult.rootMission.taskId,
    missionId: clearResult.coordinatorMission.taskId,
    constraints: { allowedKinds: ['web'] },
  });
  assert.equal(coordinatorAssignment.state, 'assigned');
  assert.equal(coordinatorAssignment.assignment.provider, 'https://alpha.example', 'generic site adapter must project real origin, not provider fiction');
  const coordinatorSession = workers.getSession(coordinatorAssignment.assignment.managedSessionId);
  commands.coordinatorAdapterSessionId = coordinatorSession.adapterSessionId;
  assert.equal(workers.getWorker(coordinatorAssignment.assignment.workerId).provider, 'webmcp.integrated-browser', 'Worker definition provider must remain the transport identity, distinct from candidate origin');

  const discoveryBeforeExistingRetry = commands.calls.filter(call => call.command === '_shuncode.webMcp.workerListResources').length;
  const connectsBeforeExistingRetry = commands.calls.filter(call => call.command === '_shuncode.webMcp.workerConnect').length;
  const coordinatorAssignmentRetry = await composition.application.assignInitialWorker({
    projectId: clearResult.project.projectId,
    rootMissionId: clearResult.rootMission.taskId,
    missionId: clearResult.coordinatorMission.taskId,
    constraints: { allowedKinds: ['web'] },
  });
  assert.equal(coordinatorAssignmentRetry.state, 'already-assigned');
  assert.equal(coordinatorAssignmentRetry.managedSessionId, coordinatorAssignment.assignment.managedSessionId, 'provider-neutral retry must converge to the exact existing managedSessionId');
  assert.equal(Object.prototype.hasOwnProperty.call(coordinatorAssignmentRetry, 'provider'), false, 'already-assigned must not fabricate unavailable candidate provider truth');
  assert.equal(JSON.stringify(coordinatorAssignmentRetry).includes('webmcp.integrated-browser'), false, 'Worker-definition provider must never be relabelled as assignment provider');
  assert.equal(commands.calls.filter(call => call.command === '_shuncode.webMcp.workerListResources').length, discoveryBeforeExistingRetry, 'coherent retry must not rediscover candidates');
  assert.equal(commands.calls.filter(call => call.command === '_shuncode.webMcp.workerConnect').length, connectsBeforeExistingRetry, 'coherent retry must not create a duplicate Worker');

  const expectExistingConstraintConflict = async (constraints, messagePattern) => {
    const discoveryBefore = commands.calls.filter(call => call.command === '_shuncode.webMcp.workerListResources').length;
    const connectsBefore = commands.calls.filter(call => call.command === '_shuncode.webMcp.workerConnect').length;
    await assert.rejects(
      () => composition.application.assignInitialWorker({
        projectId: clearResult.project.projectId,
        rootMissionId: clearResult.rootMission.taskId,
        missionId: clearResult.coordinatorMission.taskId,
        constraints,
      }),
      messagePattern,
    );
    assert.equal(commands.calls.filter(call => call.command === '_shuncode.webMcp.workerListResources').length, discoveryBefore, 'existing-assignment conflict must fail before candidate discovery');
    assert.equal(commands.calls.filter(call => call.command === '_shuncode.webMcp.workerConnect').length, connectsBefore, 'existing-assignment conflict must not create/fallback/rebind a Worker');
    assert.equal(workers.getSession(coordinatorAssignment.assignment.managedSessionId)?.taskId, clearResult.coordinatorMission.taskId, 'existing binding must remain untouched after hard-constraint conflict');
  };
  await expectExistingConstraintConflict(
    { allowedProviders: ['https://beta.example'] },
    /candidate provider is not reconstructible/,
  );
  await expectExistingConstraintConflict(
    { forbiddenProviders: ['https://alpha.example'] },
    /candidate provider is not reconstructible/,
  );
  await expectExistingConstraintConflict(
    { allowedKinds: ['api'] },
    /Worker kind web violates/,
  );
  await expectExistingConstraintConflict(
    { requiredModel: 'model-that-is-not-bound' },
    /violates requiredModel/,
  );
  await expectExistingConstraintConflict(
    { requiredCapabilities: { reasoning: true } },
    /capability reasoning=false violates/,
  );

  const ownerLedgerNames = [
    ...(await fs.readdir(clearEnv.projectsDirectory)),
    ...(await fs.readdir(clearEnv.tasksDirectory)),
    ...(await fs.readdir(clearEnv.collaborationDirectory)),
  ];
  assert.equal(ownerLedgerNames.some(name => /(assignment|candidate|provider)/i.test(name)), false, 'repair must not add a durable assignment/provider/candidate ledger');

  const rootAssignment = await composition.application.assignInitialWorker({
    projectId: clearResult.project.projectId,
    rootMissionId: clearResult.rootMission.taskId,
    missionId: clearResult.rootMission.taskId,
    constraints: { allowedKinds: ['web'] },
  });
  assert.equal(rootAssignment.state, 'assigned');
  assert.equal(rootAssignment.assignment.provider, 'https://beta.example');
  const assignmentRetry = await composition.application.assignInitialWorker({
    projectId: clearResult.project.projectId,
    rootMissionId: clearResult.rootMission.taskId,
    missionId: clearResult.rootMission.taskId,
    constraints: { allowedKinds: ['web'] },
  });
  assert.equal(assignmentRetry.state, 'already-assigned', 'retry must inspect TaskRuntime + WorkerSessionManager before any new create');
  assert.equal(assignmentRetry.managedSessionId, rootAssignment.assignment.managedSessionId);
  assert.equal(Object.prototype.hasOwnProperty.call(assignmentRetry, 'provider'), false, 'provider-neutral root retry must not manufacture the Worker-definition provider');

  const discoveryCommands = commands.calls.map(call => call.command);
  assert.ok(discoveryCommands.includes('_shuncode.webMcp.workerListResources'));
  assert.ok(discoveryCommands.includes('_shuncode.webMcp.workerProbeResource'));
  assert.ok(discoveryCommands.includes('_shuncode.webMcp.workerConnect'));
  assert.equal(commands.calls.filter(call => call.command === '_shuncode.webMcp.workerConnect').some(call => call.arg.target?.pageId === 'page-native-bypass'), false, 'native-MCP bypass resource must never become assignment candidate');

  const exactInstruction = 'Execute this exact Cognition-authored bounded production instruction and do not invent additional work.';
  const exactCommand = {
    kind: 'deliverExplicitMissionInput',
    arguments: {
      projectId: clearResult.project.projectId,
      managedRootMissionId: clearResult.rootMission.taskId,
      coordinationMissionId: clearResult.coordinatorMission.taskId,
      targetMissionId: clearResult.rootMission.taskId,
      managedSessionId: rootAssignment.assignment.managedSessionId,
      inputId: 'production-target-input-1',
      instructionKind: 'bounded-work-order',
      instruction: exactInstruction,
      phase8Materialization: phase8Spec(),
    },
  };
  commands.expectedCoordinator = exactCommand;
  const exactTurn = await composition.application.executeCoordinatorCommandTurn({
    projectId: clearResult.project.projectId,
    managedRootMissionId: clearResult.rootMission.taskId,
    coordinationMissionId: clearResult.coordinatorMission.taskId,
    managedSessionId: coordinatorAssignment.assignment.managedSessionId,
    inputId: 'production-coordinator-turn-1',
    command: exactCommand,
  });
  assert.equal(exactTurn.commandExecuted, true);
  assert.equal(exactTurn.commandResult.terminalStatus, 'completed');
  assert.equal(exactTurn.commandResult.compositionInspector.profile.resolved, 'practice-v1');
  assert.equal(exactTurn.commandResult.compositionInspector.lower.skill.selectedCount, 0, 'no production Skill source is preferable to invented trust');
  const targetSend = commands.sends.find(send => send.input.inputId === 'production-target-input-1');
  assert.ok(targetSend, 'exact target Worker input must reach the assigned WebMCP session');
  assert.equal(targetSend.sessionId, workers.getSession(rootAssignment.assignment.managedSessionId).adapterSessionId);
  assert.match(targetSend.input.prompt, new RegExp(exactInstruction.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(JSON.stringify(targetSend.input).includes('PROVIDER_PRIVATE_TRANSCRIPT_SENTINEL'), false, 'provider-private transcript content must never become Mission Context');
  assert.equal(JSON.stringify(targetSend.input).includes('contextHandle'), false, 'provider session context handle must not become Worker input authority');

  // Transport outcome uncertainty is observed once and never grants replay,
  // reassignment or fallback authority in this production composition. The
  // accepted Phase 7/8 E2E gate separately covers literal adapter-send UNKNOWN.
  const uncertainCommand = {
    ...exactCommand,
    arguments: { ...exactCommand.arguments, inputId: 'production-target-unknown-1', instruction: 'Potentially admitted exactly once.' },
  };
  commands.expectedCoordinator = uncertainCommand;
  commands.throwInputIds.add('production-target-unknown-1');
  const connectsBeforeUnknown = commands.calls.filter(call => call.command === '_shuncode.webMcp.workerConnect').length;
  const uncertainTurn = await composition.application.executeCoordinatorCommandTurn({
    projectId: clearResult.project.projectId,
    managedRootMissionId: clearResult.rootMission.taskId,
    coordinationMissionId: clearResult.coordinatorMission.taskId,
    managedSessionId: coordinatorAssignment.assignment.managedSessionId,
    inputId: 'production-coordinator-unknown-turn',
    command: uncertainCommand,
  });
  assert.equal(uncertainTurn.commandResult.terminalStatus, 'error');
  assert.equal(commands.sends.filter(send => send.input.inputId === 'production-target-unknown-1').length, 1, 'uncertain target input must not auto-resend');
  assert.equal(commands.calls.filter(call => call.command === '_shuncode.webMcp.workerConnect').length, connectsBeforeUnknown, 'uncertainty must not auto-create/fallback to a Worker');
  assert.equal(workers.getSession(rootAssignment.assignment.managedSessionId)?.taskId, clearResult.rootMission.taskId, 'uncertainty must not auto-retire the assigned Worker');

  // Stale exact WorkerSession identity fails before a second target send.
  await workers.retire(rootAssignment.assignment.managedSessionId, { reason: 'focused-stale-session-proof' });
  const staleCommand = {
    ...exactCommand,
    arguments: { ...exactCommand.arguments, inputId: 'production-stale-target-input', instruction: 'This must fail before target send.' },
  };
  commands.expectedCoordinator = staleCommand;
  const targetSendCountBeforeStale = commands.sends.filter(send => send.sessionId !== commands.coordinatorAdapterSessionId).length;
  await assert.rejects(
    () => composition.application.executeCoordinatorCommandTurn({
      projectId: clearResult.project.projectId,
      managedRootMissionId: clearResult.rootMission.taskId,
      coordinationMissionId: clearResult.coordinatorMission.taskId,
      managedSessionId: coordinatorAssignment.assignment.managedSessionId,
      inputId: 'production-coordinator-stale-turn',
      command: staleCommand,
    }),
    /WorkerSession does not exist/,
  );
  assert.equal(commands.sends.filter(send => send.sessionId !== commands.coordinatorAdapterSessionId).length, targetSendCountBeforeStale, 'stale target session must fail before target Worker send');

  const humanEnv = await createEnvironment('human', []);
  let humanLegacyCreates = 0;
  humanEnv.projects.createProject = async () => {
    humanLegacyCreates += 1;
    throw new Error('LEGACY_CREATE_PROJECT_BYPASS_FORBIDDEN');
  };
  const humanId = humanEnv.composition.application.mintFormationId();
  const humanCandidateA = formationOutcome(humanId, 'requires-human-confirmation');
  const pendingA = await humanEnv.composition.application.submitCognitionOutcome(humanCandidateA);
  assert.equal(pendingA.state, 'awaiting-human-confirmation');
  assert.equal((await projectEvents(humanEnv.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 0, 'requires-human candidate must not create Project before exact confirmation');

  await assert.rejects(
    () => humanEnv.composition.application.confirmHumanFormation({ formationId: humanId, formationDigest: `sha256:${'0'.repeat(64)}` }),
    /stale or incorrect/,
  );
  await assert.rejects(
    () => humanEnv.composition.application.confirmHumanFormation({ formationId: humanId, formationDigest: pendingA.formationDigest, assent: 'yes' }),
    /unsupported field: assent/,
  );
  assert.equal((await projectEvents(humanEnv.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 0, 'wrong/unrelated assent must create zero Project authority');

  // Pre-confirm process/service loss has no durable authority and cannot recover
  // from raw chat/transcript. A fresh application over the same unborn owners has
  // no pending confirmation memory.
  const processLossComposition = createMissionWorkProductionComposition(humanEnv.owners, humanEnv.commands);
  await assert.rejects(
    () => processLossComposition.application.confirmHumanFormation({ formationId: humanId, formationDigest: pendingA.formationDigest }),
    /no session-local pending Human confirmation/,
  );
  assert.equal((await projectEvents(humanEnv.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 0);

  const pendingAgain = await processLossComposition.application.submitCognitionOutcome(humanCandidateA);
  const humanCandidateB = formationOutcome(humanId, 'requires-human-confirmation', {
    initialRoot: { goal: 'Changed semantic candidate requires a fresh exact confirmation.' },
  });
  const pendingB = await processLossComposition.application.submitCognitionOutcome(humanCandidateB);
  assert.notEqual(pendingB.formationDigest, pendingAgain.formationDigest, 'changed Formation Result must change digest');
  await assert.rejects(
    () => processLossComposition.application.confirmHumanFormation({ formationId: humanId, formationDigest: pendingAgain.formationDigest }),
    /stale or incorrect/,
  );
  assert.equal(processLossComposition.application.cancelPendingFormation(humanId), true);
  await assert.rejects(
    () => processLossComposition.application.confirmHumanFormation({ formationId: humanId, formationDigest: pendingB.formationDigest }),
    /no session-local pending Human confirmation/,
  );
  assert.equal((await projectEvents(humanEnv.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 0, 'cancel/dismiss must leave Project count zero');

  const exactPending = await processLossComposition.application.submitCognitionOutcome(humanCandidateB);
  const humanFormed = await processLossComposition.application.confirmHumanFormation({ formationId: humanId, formationDigest: exactPending.formationDigest });
  assert.equal(humanFormed.state, 'formed');
  assert.equal(humanFormed.project.formationReceipt.authorization.kind, 'human-confirmed');
  const humanRetry = await processLossComposition.application.confirmHumanFormation({ formationId: humanId, formationDigest: exactPending.formationDigest });
  assert.equal(humanRetry.project.projectId, humanFormed.project.projectId);
  assert.equal(humanRetry.rootMission.taskId, humanFormed.rootMission.taskId);
  assert.equal(humanRetry.coordinatorMission.taskId, humanFormed.coordinatorMission.taskId);
  const humanEvents = await projectEvents(humanEnv.projectsDirectory);
  assert.equal(humanEvents.filter(event => event.type === 'ProjectCreated').length, 1);
  assert.equal(humanEvents.some(event => event.type === 'ProjectProposalHumanConfirmed'), false, 'pre-Project Human confirmation must not be forged as Project governance event');
  assert.equal(humanLegacyCreates, 0);

  const noCandidateEnv = await createEnvironment('no-candidate', []);
  const noCandidateOutcome = formationOutcome(noCandidateEnv.composition.application.mintFormationId());
  const noCandidateFormed = await noCandidateEnv.composition.application.submitCognitionOutcome(noCandidateOutcome);
  const noCandidateProjectId = noCandidateFormed.project.projectId;
  const noCandidateRootId = noCandidateFormed.rootMission.taskId;
  const noCandidateCoordinatorId = noCandidateFormed.coordinatorMission.taskId;
  const noCandidate = await noCandidateEnv.composition.application.assignInitialWorker({
    projectId: noCandidateProjectId,
    rootMissionId: noCandidateRootId,
    missionId: noCandidateCoordinatorId,
    constraints: { allowedKinds: ['web'] },
  });
  assert.deepEqual(noCandidate, { state: 'no-admissible-candidate', missionId: noCandidateCoordinatorId });
  assert.equal(noCandidateEnv.projects.getProject(noCandidateProjectId)?.projectId, noCandidateProjectId, 'no-candidate Reality must not roll back Project');
  assert.equal(noCandidateEnv.tasks.getTask(noCandidateRootId)?.taskId, noCandidateRootId, 'no-candidate Reality must not roll back root');
  assert.equal(noCandidateEnv.tasks.getTask(noCandidateCoordinatorId)?.taskId, noCandidateCoordinatorId, 'no-candidate Reality must not roll back Coordinator');
  assert.equal((await projectEvents(noCandidateEnv.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 1, 'no-candidate Reality must not rebirth Project');
  assert.equal(noCandidateEnv.workers.listSessions().length, 0, 'no-candidate Reality must not fabricate fallback Worker');

  // Worker create/bind UNKNOWN: TaskWorkerAttached reaches durable storage, then
  // append reports failure before TaskRuntime applies it. Manager cleans the live
  // session. The next production retry must reread canonical Task bytes and fail
  // closed on durable/live partial truth before discovery or another connect.
  const bindingUnknownEnv = await createEnvironment('binding-unknown', [
    resource('page-binding-unknown', 'd', 'https://binding.example'),
  ]);
  const bindingFormed = await bindingUnknownEnv.composition.application.submitCognitionOutcome(
    formationOutcome(bindingUnknownEnv.composition.application.mintFormationId()),
  );
  await assert.rejects(
    () => withRealTaskAppendUnknownOnce(
      bindingUnknownEnv.tasksDirectory,
      'TaskWorkerAttached',
      () => bindingUnknownEnv.composition.application.assignInitialWorker({
        projectId: bindingFormed.project.projectId,
        rootMissionId: bindingFormed.rootMission.taskId,
        missionId: bindingFormed.coordinatorMission.taskId,
        constraints: { allowedKinds: ['web'] },
      }),
    ),
    /automatic fallback is not authorized|Strict task persistence failed for TaskWorkerAttached/,
  );
  assert.equal(bindingUnknownEnv.workers.listSessions({ taskId: bindingFormed.coordinatorMission.taskId }).length, 0, 'failed create/bind must leave no live Manager session');
  assert.equal(
    Object.values(bindingUnknownEnv.tasks.getTask(bindingFormed.coordinatorMission.taskId).workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt).length,
    0,
    'before retry the live TaskRuntime projection must still be stale',
  );
  const connectsBeforeBindingRetry = bindingUnknownEnv.commands.calls.filter(call => call.command === '_shuncode.webMcp.workerConnect').length;
  const discoveryBeforeBindingRetry = bindingUnknownEnv.commands.calls.filter(call => call.command === '_shuncode.webMcp.workerListResources').length;
  await assert.rejects(
    () => bindingUnknownEnv.composition.application.assignInitialWorker({
      projectId: bindingFormed.project.projectId,
      rootMissionId: bindingFormed.rootMission.taskId,
      missionId: bindingFormed.coordinatorMission.taskId,
      constraints: { allowedKinds: ['web'] },
    }),
    /partial or ambiguous/,
    'retry must durable-reread Task owner truth and fail closed rather than allocate another Worker',
  );
  assert.equal(bindingUnknownEnv.commands.calls.filter(call => call.command === '_shuncode.webMcp.workerConnect').length, connectsBeforeBindingRetry, 'binding UNKNOWN retry must not connect a fallback Worker');
  assert.equal(bindingUnknownEnv.commands.calls.filter(call => call.command === '_shuncode.webMcp.workerListResources').length, discoveryBeforeBindingRetry, 'binding UNKNOWN retry must fail before candidate discovery');
  assert.equal(
    Object.values(bindingUnknownEnv.tasks.getTask(bindingFormed.coordinatorMission.taskId).workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt).length,
    1,
    'retry durable reread must expose the unresolved Task-owned binding instead of hiding it',
  );

  // Phase 11 Repair WO#1C: provider-death retirement is Mission-scoped at the
  // production application boundary; clean dispose remains a distinct primitive.
  const retireEnv = await createEnvironment('retire-assignment', [
    resource('page-retire-a', 'd', 'https://retire-a.example'),
    resource('page-retire-b', 'e', 'https://retire-b.example'),
  ]);
  const retireOutcome = formationOutcome(retireEnv.composition.application.mintFormationId());
  const retireFormed = await retireEnv.composition.application.submitCognitionOutcome(retireOutcome);
  const retireScope = {
    projectId: retireFormed.project.projectId,
    rootMissionId: retireFormed.rootMission.taskId,
    missionId: retireFormed.coordinatorMission.taskId,
  };
  const retireAssignmentA = await retireEnv.composition.application.assignInitialWorker({ ...retireScope, constraints: { allowedKinds: ['web'] } });
  assert.equal(retireAssignmentA.state, 'assigned');
  assert.equal(retireAssignmentA.assignment.provider, 'https://retire-a.example');
  const retireA = retireEnv.workers.getSession(retireAssignmentA.assignment.managedSessionId);
  assert.ok(retireA);
  retireEnv.commands.failDisconnectSessions.add(retireA.adapterSessionId);

  await assert.rejects(
    () => retireEnv.workers.dispose(retireA.managedSessionId),
    /INJECTED_PROVIDER_DISCONNECT_FAILURE/,
    'clean dispose must remain provider-cleanup-first and fail without releasing ownership',
  );
  assert.ok(retireEnv.workers.getSession(retireA.managedSessionId), 'clean dispose failure must keep Manager ownership');
  assert.equal(
    Object.values(retireEnv.tasks.getTask(retireScope.missionId).workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt).length,
    1,
    'clean dispose failure must keep durable Task ownership',
  );

  const retireRequest = { ...retireScope, managedSessionId: retireA.managedSessionId, reason: 'known-settled-provider-death' };
  const assertRetireRejectedWithoutMutation = async (request, pattern, label) => {
    const beforeTask = JSON.stringify(retireEnv.tasks.getTask(retireScope.missionId).workerSessions);
    const beforeLive = retireEnv.workers.listSessions({ taskId: retireScope.missionId }).map(session => session.managedSessionId).sort();
    await assert.rejects(() => retireEnv.composition.application.retireAssignedWorker(request), pattern, label);
    assert.equal(JSON.stringify(retireEnv.tasks.getTask(retireScope.missionId).workerSessions), beforeTask, `${label}: durable ownership unchanged`);
    assert.deepEqual(retireEnv.workers.listSessions({ taskId: retireScope.missionId }).map(session => session.managedSessionId).sort(), beforeLive, `${label}: Manager ownership unchanged`);
  };
  await assertRetireRejectedWithoutMutation({ ...retireRequest, projectId: 'wrong-project' }, /Unknown Project/, 'wrong Project');
  await assertRetireRejectedWithoutMutation({ ...retireRequest, rootMissionId: 'wrong-root' }, /Root Mission .* does not match Project/, 'wrong root Mission');
  await assertRetireRejectedWithoutMutation({ ...retireRequest, missionId: 'wrong-mission' }, /Unknown Mission/, 'wrong Mission');
  await assertRetireRejectedWithoutMutation({ ...retireRequest, managedSessionId: 'wrong-session' }, /does not match requested retirement session/, 'wrong managedSessionId');

  // live-only partial ownership must fail closed.
  await retireEnv.tasks.detachWorkerSession(retireScope.missionId, retireA.managedSessionId);
  await assert.rejects(
    () => retireEnv.composition.application.retireAssignedWorker(retireRequest),
    /partial or ambiguous \(durable=0, live=1\)/,
  );
  await retireEnv.tasks.attachWorkerSession(retireScope.missionId, {
    managedSessionId: retireA.managedSessionId,
    workerId: retireA.workerId,
    adapterSessionId: retireA.adapterSessionId,
    ...(retireA.model === undefined ? {} : { model: retireA.model }),
  });

  // unexpected durable-only second ownership makes the scope ambiguous.
  await retireEnv.tasks.attachWorkerSession(retireScope.missionId, {
    managedSessionId: 'phantom-durable-session',
    workerId: 'phantom-worker',
    adapterSessionId: 'phantom-adapter-session',
  });
  await assert.rejects(
    () => retireEnv.composition.application.retireAssignedWorker(retireRequest),
    /partial or ambiguous \(durable=2, live=1\)/,
  );
  await retireEnv.tasks.detachWorkerSession(retireScope.missionId, 'phantom-durable-session');

  // Durable retirement persistence failure must keep old live ownership and block replacement.
  const originalRetireStrict = retireEnv.tasks.retireWorkerSessionStrict.bind(retireEnv.tasks);
  retireEnv.tasks.retireWorkerSessionStrict = async () => { throw new Error('INJECTED_DURABLE_RETIREMENT_FAILURE'); };
  await assert.rejects(
    () => retireEnv.composition.application.retireAssignedWorker(retireRequest),
    /INJECTED_DURABLE_RETIREMENT_FAILURE/,
  );
  assert.ok(retireEnv.workers.getSession(retireA.managedSessionId), 'durable retirement failure must preserve Manager ownership');
  assert.equal(retireEnv.tasks.getTask(retireScope.missionId).workerSessions[retireA.managedSessionId].retiredAt, undefined, 'durable retirement failure must leave Task owner current');
  retireEnv.tasks.retireWorkerSessionStrict = originalRetireStrict;

  const retiredA = await retireEnv.composition.application.retireAssignedWorker(retireRequest);
  assert.equal(retiredA.state, 'retired');
  assert.equal(retiredA.missionId, retireScope.missionId);
  assert.equal(retiredA.managedSessionId, retireA.managedSessionId);
  assert.match(retiredA.retired.disposeError, /INJECTED_PROVIDER_DISCONNECT_FAILURE/, 'provider cleanup failure after durable retirement must be preserved as disposeError');
  assert.equal(retiredA.retired.ownershipPersistenceError, undefined);
  assert.equal(retireEnv.workers.getSession(retireA.managedSessionId), undefined, 'retirement must remove old Manager live ownership');
  assert.equal(retireEnv.tasks.getTask(retireScope.missionId).workerSessions[retireA.managedSessionId].retiredAt !== undefined, true, 'Task retirement must be durable');
  assert.equal(await retireEnv.workers.isAdapterSessionRetired(retireA.workerId, retireA.adapterSessionId), true, 'old provider adapter identity must be retired');

  // Replacement is a fresh normal assignment to the SAME persistent Mission.
  retireEnv.commands.resources = retireEnv.commands.resources.filter(value => value.pageId === 'page-retire-b');
  const retireAssignmentB = await retireEnv.composition.application.assignInitialWorker({ ...retireScope, constraints: { allowedKinds: ['web'] } });
  assert.equal(retireAssignmentB.state, 'assigned');
  assert.equal(retireAssignmentB.assignment.missionId, retireScope.missionId);
  assert.equal(retireAssignmentB.assignment.provider, 'https://retire-b.example');
  assert.notEqual(retireAssignmentB.assignment.managedSessionId, retireA.managedSessionId);
  assert.equal(retireEnv.workers.listSessions({ taskId: retireScope.missionId }).length, 1, 'same-Mission replacement must leave exactly one current live Worker');
  assert.equal(
    Object.values(retireEnv.tasks.getTask(retireScope.missionId).workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt).length,
    1,
    'same-Mission replacement must leave exactly one current durable Worker',
  );

  // Restart keeps old provider identity retired and the replacement as the sole durable current Worker.
  await retireEnv.tasks.flush();
  const retireTasksRestarted = new TaskRuntime({ storageDirectory: retireEnv.tasksDirectory });
  await retireTasksRestarted.initialize();
  const retireWorkersRestarted = new WorkerSessionManager({ taskBindings: retireTasksRestarted, executionProjection: retireTasksRestarted });
  assert.equal(await retireWorkersRestarted.isAdapterSessionRetired(retireA.workerId, retireA.adapterSessionId), true, 'restart must preserve retired provider identity truth');
  const restartedRetireMission = retireTasksRestarted.getTask(retireScope.missionId);
  assert.equal(restartedRetireMission.workerSessions[retireA.managedSessionId].retiredAt !== undefined, true);
  assert.equal(Object.values(restartedRetireMission.workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt).length, 1, 'restart must retain replacement B as sole durable current Worker');

  // Phase 11 Repair WO#1D: abrupt restart orphan recovery requires trusted
  // owner provenance/death proof and remains distinct from live WO#1C retirement.
  const ownerA = { ownerRuntimeIncarnationId: 'runtime-incarnation-a', ownerProcessId: 41001 };
  const hostA = {
    currentRuntimeIncarnationId: ownerA.ownerRuntimeIncarnationId,
    currentProcessId: ownerA.ownerProcessId,
    currentSystemBootAt: () => new Date('2026-09-17T14:00:00.000Z'),
    observeProcess: () => ({ liveness: 'alive', startedAt: new Date('2026-09-17T14:30:00.000Z') }),
  };
  const orphanEnvA = await createEnvironment('orphan-new-format', [
    resource('page-orphan-a', '7', 'https://orphan-a.example'),
    resource('page-orphan-b', '8', 'https://orphan-b.example'),
  ], {
    workerOwnerProvenance: () => ({ ...ownerA }),
    applicationOptions: { orphanRecoveryHost: hostA },
  });
  const orphanFormed = await orphanEnvA.composition.application.submitCognitionOutcome(
    formationOutcome(orphanEnvA.composition.application.mintFormationId()),
  );
  const orphanScope = {
    projectId: orphanFormed.project.projectId,
    rootMissionId: orphanFormed.rootMission.taskId,
    missionId: orphanFormed.coordinatorMission.taskId,
  };
  const orphanAssignmentA = await orphanEnvA.composition.application.assignInitialWorker({ ...orphanScope, constraints: { allowedKinds: ['web'] } });
  assert.equal(orphanAssignmentA.state, 'assigned');
  const orphanA = orphanEnvA.workers.getSession(orphanAssignmentA.assignment.managedSessionId);
  assert.ok(orphanA);
  const orphanDurableA = orphanEnvA.tasks.getTask(orphanScope.missionId).workerSessions[orphanA.managedSessionId];
  assert.equal(orphanDurableA.ownerRuntimeIncarnationId, ownerA.ownerRuntimeIncarnationId, 'new canonical attachment must persist trusted runtime incarnation');
  assert.equal(orphanDurableA.ownerProcessId, ownerA.ownerProcessId, 'new canonical attachment must persist trusted owner PID');
  const orphanRequest = { ...orphanScope, managedSessionId: orphanA.managedSessionId, reason: 'proven-abrupt-restart-orphan' };
  await assert.rejects(
    () => orphanEnvA.composition.application.recoverOrphanedAssignedWorker(orphanRequest),
    /requires zero local live WorkerSessions \(live=1\)/,
    'a live current Manager must defeat orphan recovery even when another caller could see durable-only truth',
  );
  await orphanEnvA.tasks.flush();

  let ownerAObservation = { liveness: 'alive', startedAt: new Date(Date.parse(orphanDurableA.attachedAt) - 10_000) };
  const hostB = {
    currentRuntimeIncarnationId: 'runtime-incarnation-b',
    currentProcessId: 42002,
    currentSystemBootAt: () => new Date('2026-09-17T14:00:00.000Z'),
    observeProcess: processId => processId === ownerA.ownerProcessId ? ownerAObservation : { liveness: 'unknown' },
  };
  const orphanEnvB = await reopenEnvironment('orphan-new-format-restart', orphanEnvA, [
    resource('page-orphan-a', '7', 'https://orphan-a.example'),
  ], {
    workerOwnerProvenance: () => ({ ownerRuntimeIncarnationId: hostB.currentRuntimeIncarnationId, ownerProcessId: hostB.currentProcessId }),
    applicationOptions: { orphanRecoveryHost: hostB },
  });
  assert.equal(orphanEnvB.workers.listSessions({ taskId: orphanScope.missionId }).length, 0, 'fresh Manager after abrupt restart must begin without synthetic live ownership');

  const assertOrphanRejectedWithoutMutation = async (request, pattern, label) => {
    const before = JSON.stringify((await orphanEnvB.tasks.rereadTask(orphanScope.missionId)).workerSessions);
    await assert.rejects(() => orphanEnvB.composition.application.recoverOrphanedAssignedWorker(request), pattern, label);
    const after = JSON.stringify((await orphanEnvB.tasks.rereadTask(orphanScope.missionId)).workerSessions);
    assert.equal(after, before, `${label}: durable ownership must remain unchanged`);
    assert.equal(orphanEnvB.workers.listSessions({ taskId: orphanScope.missionId }).length, 0, `${label}: no synthetic live Worker may be created`);
  };
  await assertOrphanRejectedWithoutMutation({ ...orphanRequest, projectId: 'wrong-project' }, /Unknown Project/, 'orphan wrong Project');
  await assertOrphanRejectedWithoutMutation({ ...orphanRequest, rootMissionId: 'wrong-root' }, /Root Mission .* does not match Project/, 'orphan wrong root Mission');
  await assertOrphanRejectedWithoutMutation({ ...orphanRequest, missionId: 'wrong-mission' }, /Unknown Mission/, 'orphan wrong Mission');
  await assertOrphanRejectedWithoutMutation({ ...orphanRequest, managedSessionId: 'wrong-session' }, /does not match requested orphan recovery session/, 'orphan wrong managedSessionId');
  await assert.rejects(
    () => orphanEnvB.composition.application.recoverOrphanedAssignedWorker({ ...orphanScope, missionId: orphanScope.rootMissionId, managedSessionId: 'no-worker' }),
    /requires one current Worker or the exact already-retired Worker/,
    'durable count zero must reject orphan recovery',
  );

  await assertOrphanRejectedWithoutMutation(orphanRequest, /trusted start time is not conclusively later/, 'recorded owner process alive in a possible original generation');
  ownerAObservation = { liveness: 'unknown' };
  await assertOrphanRejectedWithoutMutation(orphanRequest, /owner process 41001 liveness is unknown/, 'recorded owner process liveness unknown');
  ownerAObservation = { liveness: 'dead' };
  hostB.currentRuntimeIncarnationId = ownerA.ownerRuntimeIncarnationId;
  await assertOrphanRejectedWithoutMutation(orphanRequest, /claims the current runtime incarnation/, 'same current runtime incarnation inconsistency');
  hostB.currentRuntimeIncarnationId = 'runtime-incarnation-b';
  hostB.currentProcessId = ownerA.ownerProcessId;
  ownerAObservation = { liveness: 'alive', startedAt: new Date(Date.parse(orphanDurableA.attachedAt) - 10_000) };
  await assertOrphanRejectedWithoutMutation(orphanRequest, /claims the current host process under a different runtime incarnation/, 'current PID provenance contradiction');
  hostB.currentProcessId = 42002;
  ownerAObservation = { liveness: 'dead' };

  await orphanEnvB.tasks.attachWorkerSession(orphanScope.missionId, {
    managedSessionId: 'orphan-phantom-durable',
    workerId: 'phantom-worker',
    adapterSessionId: 'phantom-adapter',
  });
  await assertOrphanRejectedWithoutMutation(orphanRequest, /different workerId/, 'multiple durable current owners with a different Worker lineage');
  await orphanEnvB.tasks.detachWorkerSession(orphanScope.missionId, 'orphan-phantom-durable');

  await orphanEnvB.tasks.attachWorkerSession(orphanScope.missionId, {
    managedSessionId: 'orphan-different-adapter-durable',
    workerId: orphanA.workerId,
    adapterSessionId: 'different-provider-native-session',
  });
  await assertOrphanRejectedWithoutMutation(orphanRequest, /different adapterSessionId/, 'multiple durable current owners with a different provider-native lineage');
  await orphanEnvB.tasks.detachWorkerSession(orphanScope.missionId, 'orphan-different-adapter-durable');

  const originalOrphanConditionalRetireStrict = orphanEnvB.tasks.retireWorkerSessionIfCurrentSetMatchesStrict.bind(orphanEnvB.tasks);
  orphanEnvB.tasks.retireWorkerSessionIfCurrentSetMatchesStrict = async () => { throw new Error('INJECTED_ORPHAN_DURABLE_RETIREMENT_FAILURE'); };
  await assert.rejects(
    () => orphanEnvB.composition.application.recoverOrphanedAssignedWorker(orphanRequest),
    /INJECTED_ORPHAN_DURABLE_RETIREMENT_FAILURE/,
  );
  assert.equal((await orphanEnvB.tasks.rereadTask(orphanScope.missionId)).workerSessions[orphanA.managedSessionId].retiredAt, undefined, 'failed orphan retirement persistence must keep old durable ownership current');
  orphanEnvB.tasks.retireWorkerSessionIfCurrentSetMatchesStrict = originalOrphanConditionalRetireStrict;

  const orphanRecovered = await orphanEnvB.composition.application.recoverOrphanedAssignedWorker(orphanRequest);
  assert.equal(orphanRecovered.state, 'orphan-retired');
  assert.equal(orphanRecovered.ownerDeathProof, 'owner-process-conclusively-dead');
  assert.deepEqual(orphanRecovered.providerCleanup, { state: 'unavailable', reason: 'no-live-worker-session' });
  assert.ok(orphanRecovered.retired.retiredAt);
  assert.equal(orphanRecovered.retired.retirementKind, 'orphan-owner-death', 'machine-proven host orphan must be durably distinguished from provider retirement');
  assert.equal(await orphanEnvB.workers.isAdapterSessionRetired(orphanA.workerId, orphanA.adapterSessionId), false, 'host-orphan retirement must not permanently retire a still-rediscoverable provider-native identity');

  const orphanAssignmentB = await orphanEnvB.composition.application.assignInitialWorker({ ...orphanScope, constraints: { allowedKinds: ['web'] } });
  assert.equal(orphanAssignmentB.state, 'assigned');
  assert.equal(orphanAssignmentB.assignment.missionId, orphanScope.missionId, 'replacement must reuse the SAME persistent Mission');
  assert.equal(orphanAssignmentB.assignment.provider, 'https://orphan-a.example');
  assert.notEqual(orphanAssignmentB.assignment.managedSessionId, orphanA.managedSessionId);
  const orphanB = orphanEnvB.workers.getSession(orphanAssignmentB.assignment.managedSessionId);
  assert.ok(orphanB);
  assert.equal(orphanB.adapterSessionId, orphanA.adapterSessionId, 'host restart recovery must rebind the exact same provider-native session identity under a fresh managed wrapper');
  const orphanReplacementDurable = (await orphanEnvB.tasks.rereadTask(orphanScope.missionId)).workerSessions[orphanAssignmentB.assignment.managedSessionId];
  assert.equal(orphanReplacementDurable.ownerRuntimeIncarnationId, 'runtime-incarnation-b');
  assert.equal(orphanReplacementDurable.ownerProcessId, 42002);
  assert.equal(Object.values((await orphanEnvB.tasks.rereadTask(orphanScope.missionId)).workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt).length, 1);
  assert.equal(orphanEnvB.workers.listSessions({ taskId: orphanScope.missionId }).length, 1);

  await orphanEnvB.tasks.flush();
  const orphanEnvC = await reopenEnvironment('orphan-new-format-second-restart', orphanEnvB, [], {
    workerOwnerProvenance: () => ({ ownerRuntimeIncarnationId: 'runtime-incarnation-c', ownerProcessId: 43003 }),
    applicationOptions: {
      orphanRecoveryHost: {
        currentRuntimeIncarnationId: 'runtime-incarnation-c',
        currentProcessId: 43003,
        currentSystemBootAt: () => new Date('2026-09-17T14:00:00.000Z'),
        observeProcess: () => ({ liveness: 'unknown' }),
      },
    },
  });
  assert.equal(await orphanEnvC.workers.isAdapterSessionRetired(orphanA.workerId, orphanA.adapterSessionId), false, 'restart replay must preserve host-orphan rebindability without reviving the old managed wrapper');

  const rewriteTempAttachedProvenance = async (environment, missionId, mutate) => {
    const journalPath = path.join(environment.tasksDirectory, `${missionId}.jsonl`);
    const events = (await fs.readFile(journalPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const attached = [...events].reverse().find(event => event.type === 'TaskWorkerAttached');
    assert.ok(attached, 'test fixture must contain a TaskWorkerAttached event');
    mutate(attached.payload.workerSession);
    await fs.writeFile(journalPath, `${events.map(event => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  };

  // Reopened Phase 11 WO#1D: multiple durable refs may be recovered only when
  // they are exact aliases of one provider-native lineage and every recorded
  // owner is independently proven dead. Recovery remains one exact alias per call.
  const createAliasRecoveryFixture = async (name, options = {}) => {
    const ownerA = { ownerRuntimeIncarnationId: `${name}-owner-a`, ownerProcessId: 71001 };
    const ownerB = { ownerRuntimeIncarnationId: `${name}-owner-b`, ownerProcessId: 71002 };
    let attachmentOwner = ownerA;
    const observations = new Map([
      [ownerA.ownerProcessId, { liveness: 'dead' }],
      [ownerB.ownerProcessId, { liveness: 'dead' }],
    ]);
    const recoveryHost = {
      currentRuntimeIncarnationId: `${name}-current-runtime`,
      currentProcessId: 72000,
      currentSystemBootAt: () => new Date('2026-09-17T14:00:00.000Z'),
      observeProcess: processId => observations.get(processId) ?? { liveness: 'unknown' },
    };
    const environmentA = await createEnvironment(name, [resource(`page-${name}`, 'a', `https://${name}.example`)], {
      workerOwnerProvenance: () => attachmentOwner ? { ...attachmentOwner } : undefined,
      applicationOptions: { orphanRecoveryHost: recoveryHost },
    });
    const formed = await environmentA.composition.application.submitCognitionOutcome(formationOutcome(environmentA.composition.application.mintFormationId()));
    const scope = { projectId: formed.project.projectId, rootMissionId: formed.rootMission.taskId, missionId: formed.coordinatorMission.taskId };
    const assignment = await environmentA.composition.application.assignInitialWorker({ ...scope, constraints: { allowedKinds: ['web'] } });
    assert.equal(assignment.state, 'assigned');
    const aliasA = environmentA.workers.getSession(assignment.assignment.managedSessionId);
    assert.ok(aliasA);
    attachmentOwner = options.omitSecondOwner ? undefined : ownerB;
    const aliasBManagedSessionId = `${name}-managed-alias-b`;
    await environmentA.tasks.attachWorkerSession(scope.missionId, {
      managedSessionId: aliasBManagedSessionId,
      workerId: options.secondWorkerId ?? aliasA.workerId,
      adapterSessionId: options.secondAdapterSessionId ?? aliasA.adapterSessionId,
    });
    await environmentA.tasks.flush();
    if (options.mutateSecondProvenance) {
      await rewriteTempAttachedProvenance(environmentA, scope.missionId, options.mutateSecondProvenance);
    }
    const environmentB = await reopenEnvironment(`${name}-restart`, environmentA, [], {
      workerOwnerProvenance: () => ({ ownerRuntimeIncarnationId: recoveryHost.currentRuntimeIncarnationId, ownerProcessId: recoveryHost.currentProcessId }),
      applicationOptions: { orphanRecoveryHost: recoveryHost },
    });
    return { environmentA, environmentB, scope, aliasA, aliasBManagedSessionId, ownerA, ownerB, observations, recoveryHost };
  };

  const assertAliasFixtureRejectedWithoutMutation = async (fixture, request, pattern, label) => {
    const before = JSON.stringify((await fixture.environmentB.tasks.rereadTask(fixture.scope.missionId)).workerSessions);
    await assert.rejects(() => fixture.environmentB.composition.application.recoverOrphanedAssignedWorker(request), pattern, label);
    assert.equal(JSON.stringify((await fixture.environmentB.tasks.rereadTask(fixture.scope.missionId)).workerSessions), before, `${label}: durable alias truth must not mutate`);
    assert.equal(fixture.environmentB.workers.listSessions({ taskId: fixture.scope.missionId }).length, 0, `${label}: no synthetic live Worker may be created`);
  };

  const installFirstOwnerObservationGate = fixture => {
    let releaseObservation = () => {};
    let markObserved = () => {};
    const observed = new Promise(resolve => { markObserved = resolve; });
    const released = new Promise(resolve => { releaseObservation = resolve; });
    let blocked = false;
    fixture.recoveryHost.observeProcess = async processId => {
      if (!blocked) {
        blocked = true;
        markObserved(processId);
        await released;
      }
      return fixture.observations.get(processId) ?? { liveness: 'unknown' };
    };
    return { observed, release: () => releaseObservation() };
  };

  const readAliasFixtureWorkerEvents = async fixture => {
    const journalPath = path.join(fixture.environmentB.tasksDirectory, `${fixture.scope.missionId}.jsonl`);
    return (await fs.readFile(journalPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  };

  // Candidate #2 decisive Race A: a different-lineage current row appears
  // after Stage-A proof begins but before the recovery mutation linearizes.
  const aliasRaceDifferent = await createAliasRecoveryFixture('orphan-alias-race-different-lineage');
  const aliasRaceDifferentGate = installFirstOwnerObservationGate(aliasRaceDifferent);
  const aliasRaceDifferentReason = 'stale-proof-race-different-lineage';
  const aliasRaceDifferentRecovery = aliasRaceDifferent.environmentB.composition.application.recoverOrphanedAssignedWorker({
    ...aliasRaceDifferent.scope,
    managedSessionId: aliasRaceDifferent.aliasA.managedSessionId,
    reason: aliasRaceDifferentReason,
  });
  await aliasRaceDifferentGate.observed;
  const aliasRaceDifferentC = 'orphan-alias-race-different-lineage-managed-c';
  await aliasRaceDifferent.environmentB.tasks.attachWorkerSession(aliasRaceDifferent.scope.missionId, {
    managedSessionId: aliasRaceDifferentC,
    workerId: 'race-different-worker',
    adapterSessionId: 'race-different-adapter',
  });
  const aliasRaceDifferentRejected = assert.rejects(
    async () => aliasRaceDifferentRecovery,
    /recovery proof is stale because the durable current set changed before retirement/,
    'different-lineage attachment during owner proof must stale the proof before recovery retirement',
  );
  aliasRaceDifferentGate.release();
  await aliasRaceDifferentRejected;
  const aliasRaceDifferentEvents = await readAliasFixtureWorkerEvents(aliasRaceDifferent);
  assert.equal(aliasRaceDifferentEvents.filter(event => event.type === 'TaskWorkerRetired').length, 0, 'Race A must leave the journal with zero TaskWorkerRetired events');
  assert.equal(aliasRaceDifferentEvents.filter(event => event.type === 'TaskWorkerRetired' && event.payload?.reason === aliasRaceDifferentReason).length, 0, 'Race A stale recovery must write zero TaskWorkerRetired events');
  const aliasRaceDifferentCurrent = Object.values((await aliasRaceDifferent.environmentB.tasks.rereadTask(aliasRaceDifferent.scope.missionId)).workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt);
  assert.equal(aliasRaceDifferentCurrent.some(worker => worker.managedSessionId === aliasRaceDifferent.aliasA.managedSessionId), true, 'Race A alias A must remain current');
  assert.equal(aliasRaceDifferentCurrent.some(worker => worker.managedSessionId === aliasRaceDifferent.aliasBManagedSessionId), true, 'Race A alias B must remain current');
  assert.equal(aliasRaceDifferentCurrent.some(worker => worker.managedSessionId === aliasRaceDifferentC), true, 'Race A different-lineage C must remain current');

  // Candidate #2 decisive Race B: even a new same-lineage alias invalidates the
  // old A+B proof because its owner provenance has not been proven by that run.
  const aliasRaceSame = await createAliasRecoveryFixture('orphan-alias-race-same-lineage');
  const aliasRaceSameGate = installFirstOwnerObservationGate(aliasRaceSame);
  const aliasRaceSameReason = 'stale-proof-race-same-lineage';
  const aliasRaceSameRecovery = aliasRaceSame.environmentB.composition.application.recoverOrphanedAssignedWorker({
    ...aliasRaceSame.scope,
    managedSessionId: aliasRaceSame.aliasA.managedSessionId,
    reason: aliasRaceSameReason,
  });
  await aliasRaceSameGate.observed;
  const aliasRaceSameC = 'orphan-alias-race-same-lineage-managed-c';
  await aliasRaceSame.environmentB.tasks.attachWorkerSession(aliasRaceSame.scope.missionId, {
    managedSessionId: aliasRaceSameC,
    workerId: aliasRaceSame.aliasA.workerId,
    adapterSessionId: aliasRaceSame.aliasA.adapterSessionId,
  });
  const aliasRaceSameRejected = assert.rejects(
    async () => aliasRaceSameRecovery,
    /recovery proof is stale because the durable current set changed before retirement/,
    'same-lineage attachment during owner proof must stale the old A+B proof before recovery retirement',
  );
  aliasRaceSameGate.release();
  await aliasRaceSameRejected;
  const aliasRaceSameEvents = await readAliasFixtureWorkerEvents(aliasRaceSame);
  assert.equal(aliasRaceSameEvents.filter(event => event.type === 'TaskWorkerRetired').length, 0, 'Race B must leave the journal with zero TaskWorkerRetired events');
  assert.equal(aliasRaceSameEvents.filter(event => event.type === 'TaskWorkerRetired' && event.payload?.reason === aliasRaceSameReason).length, 0, 'Race B stale recovery must write zero TaskWorkerRetired events');
  const aliasRaceSameCurrent = Object.values((await aliasRaceSame.environmentB.tasks.rereadTask(aliasRaceSame.scope.missionId)).workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt);
  assert.equal(aliasRaceSameCurrent.length, 3, 'Race B must leave A+B+C current after stale proof rejection');
  assert.equal(aliasRaceSameCurrent.some(worker => worker.managedSessionId === aliasRaceSame.aliasA.managedSessionId), true, 'Race B alias A must remain current');
  assert.equal(aliasRaceSameCurrent.some(worker => worker.managedSessionId === aliasRaceSame.aliasBManagedSessionId), true, 'Race B alias B must remain current');
  assert.equal(aliasRaceSameCurrent.some(worker => worker.managedSessionId === aliasRaceSameC), true, 'Race B same-lineage C must remain current');

  const aliasRaceDetach = await createAliasRecoveryFixture('orphan-alias-race-detach');
  const aliasRaceDetachGate = installFirstOwnerObservationGate(aliasRaceDetach);
  const aliasRaceDetachReason = 'stale-proof-race-detach';
  const aliasRaceDetachRecovery = aliasRaceDetach.environmentB.composition.application.recoverOrphanedAssignedWorker({
    ...aliasRaceDetach.scope,
    managedSessionId: aliasRaceDetach.aliasA.managedSessionId,
    reason: aliasRaceDetachReason,
  });
  await aliasRaceDetachGate.observed;
  await aliasRaceDetach.environmentB.tasks.detachWorkerSession(aliasRaceDetach.scope.missionId, aliasRaceDetach.aliasBManagedSessionId);
  const aliasRaceDetachRejected = assert.rejects(async () => aliasRaceDetachRecovery, /recovery proof is stale because the durable current set changed before retirement/);
  aliasRaceDetachGate.release();
  await aliasRaceDetachRejected;
  const aliasRaceDetachEvents = await readAliasFixtureWorkerEvents(aliasRaceDetach);
  assert.equal(aliasRaceDetachEvents.filter(event => event.type === 'TaskWorkerRetired').length, 0, 'detach during proof must leave zero TaskWorkerRetired events');
  assert.equal(aliasRaceDetachEvents.filter(event => event.type === 'TaskWorkerRetired' && event.payload?.reason === aliasRaceDetachReason).length, 0, 'detach during proof must cause zero recovery retirement writes');
  assert.ok((await aliasRaceDetach.environmentB.tasks.rereadTask(aliasRaceDetach.scope.missionId)).workerSessions[aliasRaceDetach.aliasBManagedSessionId].detachedAt, 'concurrent detach must remain authoritative after stale recovery rejection');

  const aliasRaceRetire = await createAliasRecoveryFixture('orphan-alias-race-retire');
  const aliasRaceRetireGate = installFirstOwnerObservationGate(aliasRaceRetire);
  const aliasRaceRetireReason = 'stale-proof-race-retire-other';
  const aliasRaceRetireRecovery = aliasRaceRetire.environmentB.composition.application.recoverOrphanedAssignedWorker({
    ...aliasRaceRetire.scope,
    managedSessionId: aliasRaceRetire.aliasA.managedSessionId,
    reason: aliasRaceRetireReason,
  });
  await aliasRaceRetireGate.observed;
  await aliasRaceRetire.environmentB.tasks.retireWorkerSessionStrict(aliasRaceRetire.scope.missionId, aliasRaceRetire.aliasBManagedSessionId, { reason: 'concurrent-control-retire-b' });
  const aliasRaceRetireRejected = assert.rejects(async () => aliasRaceRetireRecovery, /recovery proof is stale because the durable current set changed before retirement/);
  aliasRaceRetireGate.release();
  await aliasRaceRetireRejected;
  const aliasRaceRetireEvents = await readAliasFixtureWorkerEvents(aliasRaceRetire);
  assert.equal(aliasRaceRetireEvents.filter(event => event.type === 'TaskWorkerRetired' && event.payload?.reason === aliasRaceRetireReason).length, 0, 'retirement of an expected alias during proof must cause zero stale-recovery retirement writes');
  assert.equal(aliasRaceRetireEvents.filter(event => event.type === 'TaskWorkerRetired' && event.payload?.reason === 'concurrent-control-retire-b').length, 1, 'the independent concurrent retirement must remain the only retirement in its race');

  const aliasRaceRequested = await createAliasRecoveryFixture('orphan-alias-race-requested-retire');
  const aliasRaceRequestedGate = installFirstOwnerObservationGate(aliasRaceRequested);
  const aliasRaceRequestedReason = 'stale-proof-race-requested-retire';
  const aliasRaceRequestedRecovery = aliasRaceRequested.environmentB.composition.application.recoverOrphanedAssignedWorker({
    ...aliasRaceRequested.scope,
    managedSessionId: aliasRaceRequested.aliasA.managedSessionId,
    reason: aliasRaceRequestedReason,
  });
  await aliasRaceRequestedGate.observed;
  await aliasRaceRequested.environmentB.tasks.retireWorkerSessionStrict(aliasRaceRequested.scope.missionId, aliasRaceRequested.aliasA.managedSessionId, { reason: 'concurrent-control-retire-requested-a' });
  const aliasRaceRequestedRejected = assert.rejects(async () => aliasRaceRequestedRecovery, /recovery proof is stale because the durable current set changed before retirement/);
  aliasRaceRequestedGate.release();
  await aliasRaceRequestedRejected;
  const aliasRaceRequestedEvents = await readAliasFixtureWorkerEvents(aliasRaceRequested);
  assert.equal(aliasRaceRequestedEvents.filter(event => event.type === 'TaskWorkerRetired' && event.payload?.reason === aliasRaceRequestedReason).length, 0, 'requested alias state change during proof must cause zero stale-recovery retirement writes');
  assert.equal(aliasRaceRequestedEvents.filter(event => event.type === 'TaskWorkerRetired' && event.payload?.reason === 'concurrent-control-retire-requested-a').length, 1, 'requested-alias race must preserve only the independent concurrent retirement');

  const aliasFixture = await createAliasRecoveryFixture('orphan-same-lineage-alias');
  const aliasRequestA = { ...aliasFixture.scope, managedSessionId: aliasFixture.aliasA.managedSessionId, reason: 'same-lineage-alias-a' };
  const aliasRequestB = { ...aliasFixture.scope, managedSessionId: aliasFixture.aliasBManagedSessionId, reason: 'same-lineage-alias-b' };
  const currentAliasRefs = async () => Object.values((await aliasFixture.environmentB.tasks.rereadTask(aliasFixture.scope.missionId)).workerSessions)
    .filter(worker => !worker.detachedAt && !worker.retiredAt);
  const assertAliasRejectedWithoutMutation = async (request, pattern, label) => {
    const before = JSON.stringify((await aliasFixture.environmentB.tasks.rereadTask(aliasFixture.scope.missionId)).workerSessions);
    await assert.rejects(() => aliasFixture.environmentB.composition.application.recoverOrphanedAssignedWorker(request), pattern, label);
    assert.equal(JSON.stringify((await aliasFixture.environmentB.tasks.rereadTask(aliasFixture.scope.missionId)).workerSessions), before, `${label}: durable alias truth must not mutate`);
    assert.equal(aliasFixture.environmentB.workers.listSessions({ taskId: aliasFixture.scope.missionId }).length, 0, `${label}: no synthetic live Worker may be created`);
  };

  const liveAliasBefore = JSON.stringify((await aliasFixture.environmentA.tasks.rereadTask(aliasFixture.scope.missionId)).workerSessions);
  await assert.rejects(
    () => aliasFixture.environmentA.composition.application.recoverOrphanedAssignedWorker(aliasRequestA),
    /requires zero local live WorkerSessions \(live=1\)/,
    'same-lineage aliases must still reject recovery while a live current Worker exists',
  );
  assert.equal(JSON.stringify((await aliasFixture.environmentA.tasks.rereadTask(aliasFixture.scope.missionId)).workerSessions), liveAliasBefore, 'live current Worker rejection must not mutate durable alias truth');
  await assertAliasRejectedWithoutMutation({ ...aliasRequestA, managedSessionId: 'alias-not-current' }, /does not contain requested orphan recovery session/, 'requested alias must be current');
  aliasFixture.observations.set(aliasFixture.ownerB.ownerProcessId, { liveness: 'alive', startedAt: new Date('2026-09-17T14:30:00.000Z') });
  await assertAliasRejectedWithoutMutation(aliasRequestA, /not conclusively later/, 'one alias owner still alive');
  aliasFixture.observations.set(aliasFixture.ownerB.ownerProcessId, { liveness: 'unknown' });
  await assertAliasRejectedWithoutMutation(aliasRequestA, /liveness is unknown/, 'one alias owner liveness unknown');
  aliasFixture.observations.set(aliasFixture.ownerB.ownerProcessId, { liveness: 'dead' });
  const aliasCurrentRuntime = aliasFixture.recoveryHost.currentRuntimeIncarnationId;
  aliasFixture.recoveryHost.currentRuntimeIncarnationId = aliasFixture.ownerB.ownerRuntimeIncarnationId;
  await assertAliasRejectedWithoutMutation(aliasRequestA, /claims the current runtime incarnation/, 'one alias claims current runtime incarnation');
  aliasFixture.recoveryHost.currentRuntimeIncarnationId = aliasCurrentRuntime;
  const aliasCurrentProcess = aliasFixture.recoveryHost.currentProcessId;
  aliasFixture.recoveryHost.currentProcessId = aliasFixture.ownerB.ownerProcessId;
  await assertAliasRejectedWithoutMutation(aliasRequestA, /claims the current host process/, 'one alias claims current host process under a different runtime');
  aliasFixture.recoveryHost.currentProcessId = aliasCurrentProcess;

  let releaseAliasFinalizing;
  let markAliasFinalizing;
  const aliasFinalizingEntered = new Promise(resolve => { markAliasFinalizing = resolve; });
  const aliasFinalizingRelease = new Promise(resolve => { releaseAliasFinalizing = resolve; });
  const aliasFinalizingFence = aliasFixture.environmentB.tasks.withMissionFinalizationStabilization(aliasFixture.scope.missionId, async () => {
    markAliasFinalizing();
    await aliasFinalizingRelease;
  });
  await aliasFinalizingEntered;
  await assertAliasRejectedWithoutMutation(aliasRequestA, /is finalizing and cannot recover its orphaned assigned Worker/, 'finalizing Mission alias recovery');
  releaseAliasFinalizing();
  await aliasFinalizingFence;

  const aliasJournalPath = path.join(aliasFixture.environmentB.tasksDirectory, `${aliasFixture.scope.missionId}.jsonl`);
  const retiredEventCount = async managedSessionId => (await fs.readFile(aliasJournalPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(event => event.type === 'TaskWorkerRetired' && event.payload?.managedSessionId === managedSessionId).length;
  const aliasRecoveredA = await aliasFixture.environmentB.composition.application.recoverOrphanedAssignedWorker(aliasRequestA);
  assert.equal(aliasRecoveredA.ownerDeathProof, 'owner-process-conclusively-dead');
  assert.equal(await retiredEventCount(aliasFixture.aliasA.managedSessionId), 1, 'first exact alias recovery must write exactly one TaskWorkerRetired for alias A');
  assert.equal((await currentAliasRefs()).length, 1, 'first alias retirement must leave exactly one durable current alias');
  assert.equal((await currentAliasRefs())[0].managedSessionId, aliasFixture.aliasBManagedSessionId, 'first alias retirement must leave alias B current');
  assert.equal(aliasFixture.environmentB.workers.listSessions({ taskId: aliasFixture.scope.missionId }).length, 0, 'first alias retirement must not synthesize live ownership');
  assert.equal(await aliasFixture.environmentB.workers.isAdapterSessionRetired(aliasFixture.aliasA.workerId, aliasFixture.aliasA.adapterSessionId), false, 'host-orphan alias retirement must not permanently retire the shared provider-native identity');
  await assert.rejects(
    () => aliasFixture.environmentB.composition.application.assignInitialWorker({ ...aliasFixture.scope, constraints: { allowedKinds: ['web'] } }),
    /owner truth is partial or ambiguous \(durable=1, live=0\)/,
    'assignment must remain blocked while the remaining durable alias is current',
  );
  const aliasRecoveredB = await aliasFixture.environmentB.composition.application.recoverOrphanedAssignedWorker(aliasRequestB);
  assert.equal(aliasRecoveredB.ownerDeathProof, 'owner-process-conclusively-dead');
  assert.equal(await retiredEventCount(aliasFixture.aliasBManagedSessionId), 1, 'second exact alias recovery must write exactly one TaskWorkerRetired for alias B');
  assert.equal((await currentAliasRefs()).length, 0, 'second alias retirement must converge durable current ownership to zero');
  assert.equal(aliasFixture.environmentB.workers.listSessions({ taskId: aliasFixture.scope.missionId }).length, 0, 'second alias retirement must keep live ownership at zero');
  assert.equal(await aliasFixture.environmentB.workers.isAdapterSessionRetired(aliasFixture.aliasA.workerId, aliasFixture.aliasA.adapterSessionId), false, 'after all host-orphan aliases retire, the provider-native identity remains eligible for exact rediscovery/rebind');
  const aliasAssignmentEmpty = await aliasFixture.environmentB.composition.application.assignInitialWorker({ ...aliasFixture.scope, constraints: { allowedKinds: ['web'] } });
  assert.equal(aliasAssignmentEmpty.state, 'no-admissible-candidate', 'after final alias retirement assignment owner truth must be empty rather than ambiguous');

  const aliasPartial = await createAliasRecoveryFixture('orphan-alias-partial-provenance', {
    mutateSecondProvenance: worker => { delete worker.ownerProcessId; },
  });
  await assertAliasFixtureRejectedWithoutMutation(
    aliasPartial,
    { ...aliasPartial.scope, managedSessionId: aliasPartial.aliasA.managedSessionId },
    /owner provenance is partial/,
    'one partial alias owner provenance must reject the entire alias recovery before mutation',
  );
  const aliasMissing = await createAliasRecoveryFixture('orphan-alias-missing-provenance', {
    mutateSecondProvenance: worker => { delete worker.ownerRuntimeIncarnationId; delete worker.ownerProcessId; },
  });
  await assertAliasFixtureRejectedWithoutMutation(
    aliasMissing,
    { ...aliasMissing.scope, managedSessionId: aliasMissing.aliasA.managedSessionId },
    /alias owner provenance must be complete/,
    'one missing alias owner provenance must reject the entire alias recovery before mutation',
  );
  const aliasInvalid = await createAliasRecoveryFixture('orphan-alias-invalid-provenance', {
    mutateSecondProvenance: worker => { worker.ownerRuntimeIncarnationId = ''; worker.ownerProcessId = 0; },
  });
  await assertAliasFixtureRejectedWithoutMutation(
    aliasInvalid,
    { ...aliasInvalid.scope, managedSessionId: aliasInvalid.aliasA.managedSessionId },
    /owner provenance is invalid/,
    'one invalid alias owner provenance must reject the entire alias recovery before mutation',
  );

  const aliasTerminal = await createAliasRecoveryFixture('orphan-alias-terminal');
  await aliasTerminal.environmentB.tasks.finalizeMissionStrict(aliasTerminal.scope.missionId, { handoffRequired: false });
  await assertAliasFixtureRejectedWithoutMutation(
    aliasTerminal,
    { ...aliasTerminal.scope, managedSessionId: aliasTerminal.aliasA.managedSessionId },
    /is terminal .* cannot recover its orphaned assigned Worker/,
    'finalized Mission must reject alias recovery before owner mutation',
  );

  // Corrupted durable provenance fixtures exercise recovery fail-closed behavior;
  // these edits are isolated to the disposable smoke-test journal, never production state.
  const partialEnvA = await createEnvironment('orphan-partial-provenance', [resource('page-partial', 'e', 'https://partial.example')]);
  const partialFormed = await partialEnvA.composition.application.submitCognitionOutcome(formationOutcome(partialEnvA.composition.application.mintFormationId()));
  const partialScope = { projectId: partialFormed.project.projectId, rootMissionId: partialFormed.rootMission.taskId, missionId: partialFormed.coordinatorMission.taskId };
  const partialAssignment = await partialEnvA.composition.application.assignInitialWorker({ ...partialScope, constraints: { allowedKinds: ['web'] } });
  assert.equal(partialAssignment.state, 'assigned');
  await partialEnvA.tasks.flush();
  await rewriteTempAttachedProvenance(partialEnvA, partialScope.missionId, worker => { worker.ownerRuntimeIncarnationId = 'partial-runtime'; });
  const partialEnvB = await reopenEnvironment('orphan-partial-provenance-restart', partialEnvA, [], {
    applicationOptions: {
      orphanRecoveryHost: {
        currentRuntimeIncarnationId: 'partial-current-runtime',
        currentProcessId: 64004,
        currentSystemBootAt: () => new Date('2026-09-17T14:00:00.000Z'),
        observeProcess: () => ({ liveness: 'dead' }),
      },
    },
  });
  await assert.rejects(
    () => partialEnvB.composition.application.recoverOrphanedAssignedWorker({ ...partialScope, managedSessionId: partialAssignment.assignment.managedSessionId }),
    /owner provenance is partial/,
    'partial durable owner provenance must reject recovery',
  );
  assert.equal((await partialEnvB.tasks.rereadTask(partialScope.missionId)).workerSessions[partialAssignment.assignment.managedSessionId].retiredAt, undefined);

  const invalidEnvA = await createEnvironment('orphan-invalid-provenance', [resource('page-invalid', 'f', 'https://invalid.example')]);
  const invalidFormed = await invalidEnvA.composition.application.submitCognitionOutcome(formationOutcome(invalidEnvA.composition.application.mintFormationId()));
  const invalidScope = { projectId: invalidFormed.project.projectId, rootMissionId: invalidFormed.rootMission.taskId, missionId: invalidFormed.coordinatorMission.taskId };
  const invalidAssignment = await invalidEnvA.composition.application.assignInitialWorker({ ...invalidScope, constraints: { allowedKinds: ['web'] } });
  assert.equal(invalidAssignment.state, 'assigned');
  await invalidEnvA.tasks.flush();
  await rewriteTempAttachedProvenance(invalidEnvA, invalidScope.missionId, worker => {
    worker.ownerRuntimeIncarnationId = '';
    worker.ownerProcessId = 0;
  });
  const invalidEnvB = await reopenEnvironment('orphan-invalid-provenance-restart', invalidEnvA, [], {
    applicationOptions: {
      orphanRecoveryHost: {
        currentRuntimeIncarnationId: 'invalid-current-runtime',
        currentProcessId: 65005,
        currentSystemBootAt: () => new Date('2026-09-17T14:00:00.000Z'),
        observeProcess: () => ({ liveness: 'dead' }),
      },
    },
  });
  await assert.rejects(
    () => invalidEnvB.composition.application.recoverOrphanedAssignedWorker({ ...invalidScope, managedSessionId: invalidAssignment.assignment.managedSessionId }),
    /owner provenance is invalid/,
    'invalid durable owner provenance must reject recovery',
  );
  assert.equal((await invalidEnvB.tasks.rereadTask(invalidScope.missionId)).workerSessions[invalidAssignment.assignment.managedSessionId].retiredAt, undefined);

  // Phase 11 Repair WO#1H: PID number is not process identity. An alive PID
  // can prove reuse only when trusted process start is conclusively later than
  // the durable attachment; all ambiguous/missing machine evidence fails closed.
  const reuseAttachedAt = '2026-09-19T08:48:49.885Z';
  const reuseNow = () => new Date(reuseAttachedAt);
  const reuseOwner = { ownerRuntimeIncarnationId: 'reuse-runtime-a', ownerProcessId: 61001 };
  const reuseEnvA = await createEnvironment('orphan-pid-reuse', [
    resource('page-reuse-a', 'b', 'https://reuse-a.example'),
    resource('page-reuse-b', 'c', 'https://reuse-b.example'),
  ], {
    now: reuseNow,
    workerOwnerProvenance: () => ({ ...reuseOwner }),
    applicationOptions: {
      orphanRecoveryHost: {
        currentRuntimeIncarnationId: reuseOwner.ownerRuntimeIncarnationId,
        currentProcessId: reuseOwner.ownerProcessId,
        currentSystemBootAt: () => new Date('2026-09-19T07:00:00.000Z'),
        observeProcess: () => ({ liveness: 'alive', startedAt: new Date('2026-09-19T08:00:00.000Z') }),
      },
    },
  });
  const reuseFormed = await reuseEnvA.composition.application.submitCognitionOutcome(formationOutcome(reuseEnvA.composition.application.mintFormationId()));
  const reuseScope = { projectId: reuseFormed.project.projectId, rootMissionId: reuseFormed.rootMission.taskId, missionId: reuseFormed.coordinatorMission.taskId };
  const reuseAssignmentA = await reuseEnvA.composition.application.assignInitialWorker({ ...reuseScope, constraints: { allowedKinds: ['web'] } });
  assert.equal(reuseAssignmentA.state, 'assigned');
  const reuseA = reuseEnvA.workers.getSession(reuseAssignmentA.assignment.managedSessionId);
  assert.ok(reuseA);
  const reuseDurableA = reuseEnvA.tasks.getTask(reuseScope.missionId).workerSessions[reuseA.managedSessionId];
  assert.equal(reuseDurableA.attachedAt, reuseAttachedAt);
  await reuseEnvA.tasks.flush();

  let reuseObservation = { liveness: 'alive', startedAt: new Date(Date.parse(reuseAttachedAt) - 1_000) };
  let reuseObserverFailure = false;
  const reuseHost = {
    currentRuntimeIncarnationId: 'reuse-runtime-b',
    currentProcessId: 62002,
    currentSystemBootAt: () => new Date('2026-09-19T07:00:00.000Z'),
    observeProcess: processId => {
      assert.equal(processId, reuseOwner.ownerProcessId, 'machine observation must be scoped to the exact durable owner PID');
      if (reuseObserverFailure) throw new Error('INJECTED_PROCESS_OBSERVER_FAILURE');
      return reuseObservation;
    },
  };
  const reuseEnvB = await reopenEnvironment('orphan-pid-reuse-restart', reuseEnvA, [resource('page-reuse-b', 'c', 'https://reuse-b.example')], {
    now: () => new Date('2026-09-19T09:40:00.000Z'),
    workerOwnerProvenance: () => ({ ownerRuntimeIncarnationId: reuseHost.currentRuntimeIncarnationId, ownerProcessId: reuseHost.currentProcessId }),
    applicationOptions: { orphanRecoveryHost: reuseHost },
  });
  const reuseRequest = { ...reuseScope, managedSessionId: reuseA.managedSessionId, reason: 'pid-reuse-proof' };
  const assertReuseRejectedWithoutMutation = async (request, pattern, label) => {
    const before = JSON.stringify((await reuseEnvB.tasks.rereadTask(reuseScope.missionId)).workerSessions);
    await assert.rejects(() => reuseEnvB.composition.application.recoverOrphanedAssignedWorker(request), pattern, label);
    assert.equal(JSON.stringify((await reuseEnvB.tasks.rereadTask(reuseScope.missionId)).workerSessions), before, `${label}: durable truth must not mutate`);
    assert.equal(reuseEnvB.workers.listSessions({ taskId: reuseScope.missionId }).length, 0, `${label}: recovery must create no synthetic live Worker`);
  };

  await assertReuseRejectedWithoutMutation(reuseRequest, /not conclusively later/, 'alive PID starting before attachedAt');
  reuseObservation = { liveness: 'alive', startedAt: new Date(Date.parse(reuseAttachedAt) + 1_000) };
  await assertReuseRejectedWithoutMutation(reuseRequest, /not conclusively later/, 'alive PID inside conservative start-time tolerance');
  reuseObservation = { liveness: 'alive' };
  await assertReuseRejectedWithoutMutation(reuseRequest, /process-start evidence is unavailable/, 'alive PID missing process-start evidence');
  reuseObservation = { liveness: 'alive', startedAt: new Date(Number.NaN) };
  await assertReuseRejectedWithoutMutation(reuseRequest, /process-start evidence is invalid/, 'alive PID malformed process-start evidence');
  reuseObservation = { liveness: 'invalid-machine-value' };
  await assertReuseRejectedWithoutMutation(reuseRequest, /machine observation is invalid/, 'malformed process observer result');
  reuseObserverFailure = true;
  await assertReuseRejectedWithoutMutation(reuseRequest, /machine observation failed/, 'process observer failure');
  reuseObserverFailure = false;
  reuseObservation = { liveness: 'alive', startedAt: new Date(Date.parse(reuseAttachedAt) + 10_000) };
  await assertReuseRejectedWithoutMutation({ ...reuseRequest, processStartedAt: 'forged' }, /contains unsupported field: processStartedAt/, 'caller process-start evidence injection');
  await assertReuseRejectedWithoutMutation({ ...reuseRequest, pidReused: true }, /contains unsupported field: pidReused/, 'caller PID-reuse authority injection');

  const reuseRecovered = await reuseEnvB.composition.application.recoverOrphanedAssignedWorker(reuseRequest);
  assert.equal(reuseRecovered.ownerDeathProof, 'owner-pid-reused');
  assert.equal(reuseEnvB.workers.listSessions({ taskId: reuseScope.missionId }).length, 0, 'PID-reuse recovery must not synthesize a live WorkerSession');
  assert.equal(await reuseEnvB.workers.isAdapterSessionRetired(reuseA.workerId, reuseA.adapterSessionId), false, 'PID-reuse proves the old managed owner is stale without permanently retiring a provider-native identity');
  const reuseJournalPath = path.join(reuseEnvB.tasksDirectory, `${reuseScope.missionId}.jsonl`);
  const reuseJournalEvents = (await fs.readFile(reuseJournalPath, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert.equal(reuseJournalEvents.filter(event => event.type === 'TaskWorkerRetired' && event.payload?.managedSessionId === reuseA.managedSessionId).length, 1, 'PID-reuse recovery must write exactly one durable TaskWorkerRetired event');

  const reuseAssignmentB = await reuseEnvB.composition.application.assignInitialWorker({ ...reuseScope, constraints: { allowedKinds: ['web'] } });
  assert.equal(reuseAssignmentB.state, 'assigned');
  assert.equal(reuseAssignmentB.assignment.missionId, reuseScope.missionId, 'PID-reuse recovery replacement must remain on the SAME Coordinator Mission');
  assert.notEqual(reuseAssignmentB.assignment.managedSessionId, reuseA.managedSessionId);
  assert.equal(reuseEnvB.workers.listSessions({ taskId: reuseScope.missionId }).length, 1, 'canonical replacement must create exactly one live Worker');
  assert.equal(Object.values((await reuseEnvB.tasks.rereadTask(reuseScope.missionId)).workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt).length, 1, 'canonical replacement must create exactly one durable current Worker');

  // The current host process is never accepted as orphan-death authority for a
  // durable Worker, even if the runtime incarnation differs. This avoids a
  // current-process provenance contradiction being treated as ordinary PID reuse.
  const currentReuseOwner = { ownerRuntimeIncarnationId: 'reuse-current-runtime-a', ownerProcessId: 63003 };
  const currentReuseEnvA = await createEnvironment('orphan-current-pid-reuse', [resource('page-current-reuse-a', 'd', 'https://current-reuse.example')], {
    now: reuseNow,
    workerOwnerProvenance: () => ({ ...currentReuseOwner }),
  });
  const currentReuseFormed = await currentReuseEnvA.composition.application.submitCognitionOutcome(formationOutcome(currentReuseEnvA.composition.application.mintFormationId()));
  const currentReuseScope = { projectId: currentReuseFormed.project.projectId, rootMissionId: currentReuseFormed.rootMission.taskId, missionId: currentReuseFormed.coordinatorMission.taskId };
  const currentReuseAssignment = await currentReuseEnvA.composition.application.assignInitialWorker({ ...currentReuseScope, constraints: { allowedKinds: ['web'] } });
  assert.equal(currentReuseAssignment.state, 'assigned');
  await currentReuseEnvA.tasks.flush();
  let reusedCurrentProcessStillAlive = true;
  const currentReuseEnvB = await reopenEnvironment('orphan-current-pid-reuse-restart', currentReuseEnvA, [], {
    now: () => new Date('2026-09-19T09:40:00.000Z'),
    workerOwnerProvenance: () => ({ ownerRuntimeIncarnationId: 'reuse-current-runtime-b', ownerProcessId: currentReuseOwner.ownerProcessId }),
    applicationOptions: {
      orphanRecoveryHost: {
        currentRuntimeIncarnationId: 'reuse-current-runtime-b',
        currentProcessId: currentReuseOwner.ownerProcessId,
        currentSystemBootAt: () => new Date('2026-09-19T07:00:00.000Z'),
        observeProcess: processId => {
          assert.equal(processId, currentReuseOwner.ownerProcessId);
          return reusedCurrentProcessStillAlive
            ? { liveness: 'alive', startedAt: new Date(Date.parse(reuseAttachedAt) + 10_000) }
            : { liveness: 'dead' };
        },
      },
    },
  });
  await assert.rejects(
    () => currentReuseEnvB.composition.application.recoverOrphanedAssignedWorker({
      ...currentReuseScope,
      managedSessionId: currentReuseAssignment.assignment.managedSessionId,
      reason: 'current-process-provenance-conflict',
    }),
    /claims the current host process under a different runtime incarnation/,
    'same current process with a different runtime incarnation must reject orphan recovery',
  );
  assert.equal(reusedCurrentProcessStillAlive, true, 'recovery must not kill the current process that reused the old PID');
  assert.equal(currentReuseEnvB.workers.listSessions({ taskId: currentReuseScope.missionId }).length, 0);

  // Legacy migration: missing provenance is not death proof inside the current
  // boot, but a conservative pre-boot attachment may be recovered.
  const legacyCurrentEnvA = await createEnvironment('orphan-legacy-current', [resource('page-legacy-current', '9', 'https://legacy-current.example')]);
  const legacyCurrentFormed = await legacyCurrentEnvA.composition.application.submitCognitionOutcome(formationOutcome(legacyCurrentEnvA.composition.application.mintFormationId()));
  const legacyCurrentScope = {
    projectId: legacyCurrentFormed.project.projectId,
    rootMissionId: legacyCurrentFormed.rootMission.taskId,
    missionId: legacyCurrentFormed.coordinatorMission.taskId,
  };
  const legacyCurrentAssignment = await legacyCurrentEnvA.composition.application.assignInitialWorker({ ...legacyCurrentScope, constraints: { allowedKinds: ['web'] } });
  assert.equal(legacyCurrentAssignment.state, 'assigned');
  await legacyCurrentEnvA.tasks.flush();
  const legacyCurrentHost = {
    currentRuntimeIncarnationId: 'legacy-current-runtime',
    currentProcessId: 51001,
    currentSystemBootAt: () => new Date('2026-09-17T14:00:00.000Z'),
    observeProcess: () => ({ liveness: 'dead' }),
  };
  const legacyCurrentEnvB = await reopenEnvironment('orphan-legacy-current-restart', legacyCurrentEnvA, [], { applicationOptions: { orphanRecoveryHost: legacyCurrentHost } });
  await assert.rejects(
    () => legacyCurrentEnvB.composition.application.recoverOrphanedAssignedWorker({
      ...legacyCurrentScope,
      managedSessionId: legacyCurrentAssignment.assignment.managedSessionId,
    }),
    /Legacy durable Worker attachment is not conclusively older than the current system boot/,
    'legacy current-boot attachment must fail closed',
  );
  await legacyCurrentEnvB.tasks.finalizeMissionStrict(legacyCurrentScope.missionId, { handoffRequired: false });
  await assert.rejects(
    () => legacyCurrentEnvB.composition.application.recoverOrphanedAssignedWorker({
      ...legacyCurrentScope,
      managedSessionId: legacyCurrentAssignment.assignment.managedSessionId,
    }),
    /terminal \(completed\)/,
    'finalized Mission must reject orphan recovery before owner mutation',
  );

  const legacyOldNow = () => new Date('2026-09-17T12:00:00.000Z');
  const legacyOldEnvA = await createEnvironment('orphan-legacy-preboot', [resource('page-legacy-old', 'a', 'https://legacy-old.example')], { now: legacyOldNow });
  const legacyOldFormed = await legacyOldEnvA.composition.application.submitCognitionOutcome(formationOutcome(legacyOldEnvA.composition.application.mintFormationId()));
  const legacyOldScope = {
    projectId: legacyOldFormed.project.projectId,
    rootMissionId: legacyOldFormed.rootMission.taskId,
    missionId: legacyOldFormed.coordinatorMission.taskId,
  };
  const legacyOldAssignment = await legacyOldEnvA.composition.application.assignInitialWorker({ ...legacyOldScope, constraints: { allowedKinds: ['web'] } });
  assert.equal(legacyOldAssignment.state, 'assigned');
  const legacyOldDurable = legacyOldEnvA.tasks.getTask(legacyOldScope.missionId).workerSessions[legacyOldAssignment.assignment.managedSessionId];
  assert.equal(legacyOldDurable.ownerRuntimeIncarnationId, undefined);
  assert.equal(legacyOldDurable.ownerProcessId, undefined);
  await legacyOldEnvA.tasks.flush();
  const legacyOldEnvB = await reopenEnvironment('orphan-legacy-preboot-restart', legacyOldEnvA, [], {
    applicationOptions: {
      orphanRecoveryHost: {
        currentRuntimeIncarnationId: 'legacy-new-runtime',
        currentProcessId: 52002,
        currentSystemBootAt: () => new Date('2026-09-17T14:00:00.000Z'),
        observeProcess: () => ({ liveness: 'unknown' }),
      },
    },
  });
  const legacyRecovered = await legacyOldEnvB.composition.application.recoverOrphanedAssignedWorker({
    ...legacyOldScope,
    managedSessionId: legacyOldAssignment.assignment.managedSessionId,
    reason: 'legacy-preboot-proof',
  });
  assert.equal(legacyRecovered.ownerDeathProof, 'attachment-predates-current-boot');
  assert.equal(await legacyOldEnvB.workers.isAdapterSessionRetired(legacyRecovered.workerId, legacyRecovered.adapterSessionId), false);

  console.log(JSON.stringify({
    result: 'PASS',
    formationAuthority: 'clear-intent immediate; exact human digest required; pending confirmation session-local only',
    canonicalOwners: 'one ProjectStore / TaskRuntime / CollaborationStore / WorkerSessionManager shared by production composition',
    coordinator: 'Project+root first; deterministic Coordinator; exact Cognition-authored command only',
    assignment: 'truthful WebMCP discovery/refresh/exact-page assignment only; no hidden provider pool or fallback',
    existingAssignmentConvergence: 'candidate provider is never reconstructed from WorkerDescriptor; provider/kind/model/capability hard conflicts fail closed before discovery/connect; compatible retry keeps exact managedSessionId',
    phase8: 'owner-backed Context/Capability/empty-truthful-Skill composition reaches exact assigned WorkerSession',
    uncertainty: 'transport uncertainty observed once with no auto-resend/reassignment; binding append UNKNOWN durable-rereads and fails closed; stale exact session fails before target send',
    scopedRetirement: 'clean dispose failure preserves ownership; Mission-scoped retirement is durable-first, preserves disposeError, rejects wrong/partial/ambiguous scope, and permits same-Mission replacement',
    restartOrphanRecovery: 'trusted owner provenance + PID-generation-aware machine proof only; same/ambiguous generations, missing/invalid evidence, observer failures, current-runtime and live ownership reject; dead/preboot/PID-reuse proof retires durably and reuses the same Mission assignment path',
    legacyCreateProjectCalls: legacyCreateCalls + humanLegacyCreates,
    outOfScopeStateCreated: false,
  }, null, 2));
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
