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
      export { createMissionNativeChatEntry } from './extensions/shuncode/src/mission-user-entry.ts';
      export { connectMissionNativeMcp } from './extensions/shuncode/src/mission-native-mcp-connection.ts';
      export { missionEntryCapabilityMaterialization } from './src/mission-user-entry-application.ts';
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
  plugins: [{ name: 'vscode-test-surface', setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test-vscode' }));
    build.onLoad({ filter: /.*/, namespace: 'test-vscode' }, () => ({ loader: 'js', contents: 'module.exports = globalThis.__nimoraTestVscode;' }));
  } }],
});

let confirmations = 0;
globalThis.__nimoraTestVscode = {
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: '/workspace/entry' } }] },
  env: { clipboard: { writeText: async () => {} } },
  window: { async showInformationMessage() { confirmations++; return '确认并开始'; } },
};

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
  createMissionNativeChatEntry,
  connectMissionNativeMcp,
  missionEntryCapabilityMaterialization,
} = require(bundlePath);
const readPolicy = missionEntryCapabilityMaterialization([]);
assert.deepEqual(readPolicy.capability.allowedCapabilityIds, []);
assert.deepEqual(missionEntryCapabilityMaterialization(['workspace.read-files', 'workspace.apply-patch']).capability, {
  requiredCapabilityIds: ['workspace.read-files', 'workspace.apply-patch'],
  allowedCapabilityIds: ['workspace.read-files', 'workspace.apply-patch'],
});

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

async function freshCompositionFrom(environment, name, resources = [], applicationOptions = {}) {
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
  const commands = new FakeWebMcpCommands(resources);
  const transport = new WebMcpCommandTransport(commands, { pollIntervalMs: 1, now });
  await workers.register(new WebWorkerAdapter(transport));
  await workers.register(new WebWorkerAdapter(new ChatGptBrowserCommandTransport(commands), 'nimora.chatgpt-browser-worker'));
  const owners = { projects, tasks, collaboration, workers };
  return { projects, tasks, collaboration, workers, commands, composition: createMissionWorkProductionComposition(owners, commands, undefined, undefined, applicationOptions) };
}

function enableCoordinator(env) {
  const original = env.commands.executeCommand.bind(env.commands);
  env.commands.executeCommand = async (command, arg) => {
    const cap = arg?.input?.allowedCapabilities?.find(name => name.startsWith('nimora.coordinator.'));
    if (command === '_shuncode.webMcp.workerSend' && cap) {
      env.commands.coordinatorAdapterSessionId = arg.sessionId;
      env.commands.expectedCoordinator = { kind: cap.slice('nimora.coordinator.'.length), arguments: {} };
    }
    return original(command, arg);
  };
}
async function entryFixture(name) {
  const env = await createEnvironment(name, [resource(`${name}-a`, 'a', 'https://alpha.example'), resource(`${name}-b`, 'b', 'https://beta.example'), resource(`${name}-c`, 'c', 'https://gamma.example')]);
  enableCoordinator(env);
  const candidates = await env.composition.webCandidates.enumerateCandidates();
  assert.equal(candidates.length, 3);
  const result = {
    classification: 'clear-intent', project: { title: 'User entry', goal: 'Durable bounded objective' },
    initialRoot: { goal: 'Complete initial requested work', plane: 'practice', missionType: 'user-request', completionCriteria: ['Return requested result'], contextSummary: 'DURABLE_SEMANTIC_CONTEXT', constraints: ['Preserve original scope'] },
    coordinatorPolicy: { constraints: { allowedProviders: [candidates[0].provider] } },
    workerPolicy: { constraints: { allowedProviders: [candidates[1].provider] } }, instruction: 'Execute the exact user request.', requiredCapabilityIds: [],
  };
  return { ...env, result, candidates };
}
try {
  {
  const ui = globalThis.__nimoraTestVscode;
  const setupTask = { taskId: 'setup-mission', goal: 'Setup only', status: 'pending',
    mission: { projectId: 'setup-project', rootMissionId: 'setup-root', plane: 'practice' },
    workerSessions: { 'setup-session': { managedSessionId: 'setup-session', workerId: 'nimora.chatgpt-browser-worker', adapterSessionId: 'setup-adapter' } } };
  const setupSession = { managedSessionId: 'setup-session', taskId: 'setup-mission', workerId: 'nimora.chatgpt-browser-worker', adapterSessionId: 'setup-adapter' };
  const setupComposition = { owners: { tasks: { initialize: async () => {}, listTasks: () => [setupTask] }, workers: { listSessions: () => [setupSession] } } };
  const originalInformationMessage = ui.window.showInformationMessage;
  let setups = 0, copied = '';
  ui.env.clipboard.writeText = async value => { copied = value; };
  ui.window.showQuickPick = async choices => choices[0];
  ui.window.showInformationMessage = async () => '复制连接地址';
  await connectMissionNativeMcp(setupComposition, Promise.resolve(), async input => {
    setups++; assert.equal(input.missionId, 'setup-mission'); assert.equal(input.managedSessionId, 'setup-session');
    assert.equal(input.projectId, 'setup-project'); assert.equal(input.rootMissionId, 'setup-root');
    assert.deepEqual(input.constraints.requiredCapabilityIds, ['workspace.read-files']);
    return { publicUrl: 'https://mission.example/mcp/exact/mission/current' };
  });
  assert.equal(setups, 1); assert.equal(copied, 'https://mission.example/mcp/exact/mission/current');
  setupSession.adapterSessionId = 'foreign-adapter';
  await connectMissionNativeMcp(setupComposition, Promise.resolve(), async () => { throw new Error('Conflicting ownership must not prepare a binding'); });
  assert.equal(setups, 1);
  ui.workspace.isTrusted = false;
  await assert.rejects(() => connectMissionNativeMcp(setupComposition, Promise.resolve(), async () => { throw new Error('No untrusted setup'); }), /Trust/);
  ui.workspace.isTrusted = true;
  ui.window.showInformationMessage = originalInformationMessage;
  }
  const env = await entryFixture('clear-entry');
  // Human-reviewed, already-answered Cognition must create canonical truth
  // without assigning any Worker or sending another provider message.
  {
    const reviewed = await createEnvironment('reviewed-formed-only');
    const existingJson = JSON.stringify({
      classification: 'requires-human-confirmation',
      project: { title: '个人任务管理器项目', goal: '按需求.txt 完成测试项目' },
      initialRoot: { goal: '读取需求.txt 并确认需求范围', plane: 'cognition', missionType: 'requirements-analysis',
        completionCriteria: ['已读取需求.txt', '确认验收标准'], constraints: ['当前测试文件夹内执行'] },
      coordinatorPolicy: { constraints: {}, preferences: {} },
      workerPolicy: { constraints: {}, preferences: {} },
      instruction: '先读取需求.txt，再向人类确认。',
      requiredCapabilityIds: ['workspace.list-directory', 'workspace.read-files'],
    });
    let invokedCognition = 0, confirmed = 0;
    const formedOnly = await reviewed.composition.userEntry.start('旧结果已完成', '/workspace/reviewed',
      async () => { invokedCognition++; return existingJson; },
      async pending => { confirmed++; assert.equal(pending.project.goal, '按需求.txt 完成测试项目'); return true; },
      () => false, undefined, { stopAfterFormation: true });
    assert.equal(formedOnly.state, 'formed-only');
    assert.equal(invokedCognition, 1, 'only the saved JSON callback is consulted, no provider calls');
    assert.equal(confirmed, 1, 'requires-human-confirmation cannot silently auto-form');
    assert.equal(reviewed.commands.sends.length, 0, 'no fresh DeepSeek prompt is sent during adoption');
    assert.equal(reviewed.commands.calls.filter(row => row.command === '_shuncode.webMcp.workerConnect').length, 0,
      'no Worker assignment opens or inherits a provider session');
    const durable = await reopenEnvironment('reviewed-reopened', reviewed);
    await durable.projects.initialize();
    await durable.tasks.initialize();
    assert.equal(durable.projects.listProjects().length, 1, 'canonical Project must survive a process restart');
    assert.equal(durable.tasks.listTasks().length, 2, 'canonical root and coordination Missions must survive a restart');
    // Three healthy shared pages may include the previous ambiguous Cognition
    // conversation. Exact restricted assignment MUST bind only the two new,
    // separately consented page identities supplied by the host.
    reviewed.commands.resources = [
      resource('old-ambiguous-planning', 'a', 'https://chat.deepseek.com', { site: 'deepseek' }),
      resource('fresh-coordinator', 'b', 'https://chat.deepseek.com', { site: 'deepseek' }),
      resource('fresh-target', 'c', 'https://chat.deepseek.com', { site: 'deepseek' }),
    ];
    const webPolicy = { constraints: { allowedKinds: ['web'], allowedProviders: ['deepseek'] }, preferences: { providerOrder: ['deepseek'] } };
    const coordinator = await reviewed.composition.application.assignInitialWorker({
      projectId: formedOnly.scope.projectId, rootMissionId: formedOnly.scope.rootMissionId,
      missionId: formedOnly.scope.coordinationMissionId,
      ...webPolicy, constraints: { ...webPolicy.constraints, requiredCapabilities: { capabilityRequests: true } },
    }, { exactCandidateId: `webmcp:${'b'.repeat(64)}` });
    assert.equal(coordinator.state, 'assigned');
    assert.equal(coordinator.assignment.candidateId, `webmcp:${'b'.repeat(64)}`);
    assert.equal(reviewed.commands.sessions.get('page-session:fresh-coordinator')?.pageId, 'fresh-coordinator');
    const target = await reviewed.composition.application.assignInitialWorker({
      projectId: formedOnly.scope.projectId, rootMissionId: formedOnly.scope.rootMissionId,
      missionId: formedOnly.scope.rootMissionId, ...webPolicy,
    }, { exactCandidateId: `webmcp:${'c'.repeat(64)}` });
    assert.equal(target.state, 'assigned');
    assert.notEqual(target.assignment.managedSessionId, coordinator.assignment.managedSessionId);
    assert.equal(reviewed.commands.sessions.get('page-session:fresh-target')?.pageId, 'fresh-target');
    assert.equal(reviewed.commands.sessions.has('page-session:old-ambiguous-planning'), false,
      'the old Cognition conversation must never be connected to either Mission');
    assert.equal(reviewed.commands.sends.length, 0, 'binding fresh Workers never sends or replays an instruction');
    await assert.rejects(() => reviewed.composition.application.assignInitialWorker({
      projectId: formedOnly.scope.projectId, rootMissionId: formedOnly.scope.rootMissionId,
      missionId: formedOnly.scope.rootMissionId, ...webPolicy,
    }, { exactCandidateId: `webmcp:${'a'.repeat(64)}` }),
    /already|Existing|bound|provenance|Worker/i, 'a bound Mission must reject a second exact assignment');
    console.log('PASS recovered Project exact assignment: two distinct new DeepSeek pages, old Cognition excluded, no provider sends');
    const rejected = await createEnvironment('reviewed-human-declined');
    const declined = await rejected.composition.userEntry.start('旧结果已完成', '/workspace/reviewed',
      async () => existingJson, async () => false, () => false, undefined, { stopAfterFormation: true });
    assert.equal(declined.state, 'cancelled', 'declining human review must not form a Project');
    assert.equal(rejected.projects.listProjects().length, 0, 'a rejected review creates no canonical Project');
    assert.equal(rejected.commands.sends.length, 0, 'declined review cannot contact the provider');
    console.log('PASS human-reviewed Cognition: one canonical confirmation, zero provider sends, zero Worker connections, durable scope');
  }
  const noPolicy = await entryFixture('missing-capability-policy');
  delete noPolicy.result.requiredCapabilityIds;
  await assert.rejects(() => noPolicy.composition.userEntry.start('Edit a file', '/workspace/entry', async () => JSON.stringify(noPolicy.result), async () => true), /capability IDs/);
  assert.equal(noPolicy.tasks.listTasks().length, 0, 'missing capability policy is rejected before Project/Mission birth');
  const noWriteRoute = await entryFixture('missing-write-route');
  noWriteRoute.result.requiredCapabilityIds = ['workspace.apply-patch'];
  const noWrite = await noWriteRoute.composition.userEntry.start('Edit the bounded file', '/workspace/entry', async () => JSON.stringify(noWriteRoute.result), async () => true);
  assert.equal(noWrite.state, 'blocked');
  assert.match(noWrite.reason, /capability|projection|route/i);
  assert.equal(noWriteRoute.commands.sends.length, 1, 'required write route never silently drops into a readonly Target send');

  const deferred = await entryFixture('deferred-autonomy-entry');
  deferred.result.initialRoot = {
    ...deferred.result.initialRoot,
    plane: 'cognition',
    goal: 'Own planning, evidence reconciliation, Work Order authorization, and completion judgment.',
    missionType: 'project-cognition',
  };
  deferred.result.additionalMissions = [{
    key: 'bounded-practice',
    goal: 'Perform the bounded real-world work and report evidence.',
    plane: 'practice',
    missionType: 'bounded-practice',
    completionCriteria: ['Report verified evidence to Cognition.'],
    dependsOn: [],
  }];
  const deferredResult = await deferred.composition.userEntry.start(
    'Build the bounded result under continuing Cognition.',
    '/workspace/entry',
    async () => JSON.stringify(deferred.result),
    async () => true,
    () => false,
    undefined,
    {
      deferInitialExecution: true,
      onFormedPlan: async (formed, missions) => {
        await deferred.composition.plannedWork.establish({
          projectId: formed.project.projectId,
          rootMissionId: formed.rootMission.taskId,
          planKey: formed.formationDigest,
          additionalMissions: missions,
        });
      },
    },
  );
  assert.equal(deferredResult.state, 'ready-for-autonomy');
  assert.equal(deferred.commands.sends.length, 0, 'deferred Web Formation must bind Root/Coordinator without sending any Work Order');
  const deferredTasks = deferred.tasks.listTasks();
  assert.equal(deferredTasks.length, 3, 'deferred autonomous Formation must persist Cognition root, Coordinator, and Practice child');
  const deferredRoot = deferred.tasks.getTask(deferredResult.scope.rootMissionId);
  assert.equal(deferredRoot.mission.plane, 'cognition');
  assert.equal(Object.values(deferredRoot.workerSessions).filter(ref => !ref.detachedAt && !ref.retiredAt).length, 1);
  const deferredCoordinator = deferred.tasks.getTask(deferredResult.scope.coordinationMissionId);
  assert.equal(Object.values(deferredCoordinator.workerSessions).filter(ref => !ref.detachedAt && !ref.retiredAt).length, 1);
  const deferredPractice = deferredTasks.find(task => task.mission?.parentMissionId === deferredResult.scope.rootMissionId && task.mission?.plane === 'practice');
  assert.ok(deferredPractice, 'Practice child must exist before autonomy starts');
  assert.equal(Object.values(deferredPractice.workerSessions).filter(ref => !ref.detachedAt && !ref.retiredAt).length, 0,
    'Practice child stays unassigned until the existing autonomy/readiness owner dispatches it');

  let cognitionCount = 0;
  const started = await env.composition.userEntry.start('Build the bounded result', '/workspace/entry', async input => {
    cognitionCount++; assert(input.formationId); assert.equal(env.tasks.listTasks().length, 0, 'no pre-Project draft task');
    return JSON.stringify(env.result);
  }, async () => { throw new Error('Clear intent must not require confirmation'); });
  assert.equal(started.state, 'executed', JSON.stringify(started));
  assert.equal(cognitionCount, 1); assert.equal(env.commands.sends.length, 2);
  assert.equal(env.tasks.listTasks().length, 2, 'exactly root and deterministic Coordinator');
  assert.equal((await projectEvents(env.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 1);
  const target = env.commands.sends.find(row => row.sessionId !== env.commands.coordinatorAdapterSessionId);
  assert.match(target.input.prompt, /DURABLE_SEMANTIC_CONTEXT/);
  assert.equal(target.input.history, undefined); assert.equal(target.input.checkpoint, undefined);

  const rootTask = env.tasks.getTask(started.scope.rootMissionId);
  const old = Object.values(rootTask.workerSessions).find(ref => !ref.retiredAt && !ref.detachedAt);
  const replacement = { assignment: { projectId: started.scope.projectId, rootMissionId: started.scope.rootMissionId, missionId: started.scope.rootMissionId, constraints: { allowedProviders: [env.candidates[2].provider] } }, expectedManagedSessionId: old.managedSessionId, coordinationMissionId: started.scope.coordinationMissionId, inputId: 'replacement-preparation', instruction: 'Continue from durable context.' };
  await assert.rejects(() => env.composition.workerSelection.replace({ ...replacement, materialization: { budget: { maxCombinedChars: -1 } } }), /budget|Chars/);
  assert(env.workers.getSession(old.managedSessionId), 'bad policy must fail before retirement');
  const selected = await env.composition.workerSelection.replace(replacement);
  assert.equal(selected.state, 'replaced'); assert.equal(selected.assignment.provider, env.candidates[2].provider);
  assert.equal(selected.materialization.inspector.scope.managedSessionId, selected.assignment.managedSessionId);
  assert.match(selected.materialization.workerInput.prompt, /DURABLE_SEMANTIC_CONTEXT/);
  assert.equal(selected.materialization.workerInput.history, undefined);
  assert.equal(env.commands.sends.length, 2, 'rematerialization itself does not send');
  await assert.rejects(() => env.composition.userEntry.continue(started.scope, 'A new explicit user instruction'), /fresh explicit capability policy/);
  assert.equal(env.commands.sends.length, 2);
  let reservedDispatch;
  await assert.rejects(() => env.composition.userEntry.continue(started.scope, 'New bounded verification', () => false, undefined, readPolicy,
    async identity => {
      reservedDispatch = identity;
      assert.equal(env.commands.sends.length, 2, 'identity storage precedes any new provider send');
      throw Error('DISPATCH_PROVENANCE_STORAGE_FAILED');
    }), /DISPATCH_PROVENANCE_STORAGE_FAILED/);
  assert.ok(reservedDispatch.coordinatorInputId && reservedDispatch.targetInputId);
  assert.notEqual(reservedDispatch.coordinatorInputId, reservedDispatch.targetInputId);
  assert.equal(env.commands.sends.length, 2, 'storage failure cannot consume a provider gesture');
  await env.composition.userEntry.continueWithCognition(started.scope, 'A new explicit user instruction', '/workspace/entry', async input => {
    assert.deepEqual(input.existingScope, started.scope);
    return JSON.stringify({ instruction: input.request, requiredCapabilityIds: [] });
  });
  assert.equal(env.commands.sends.length, 4);
  let checkpointIdentity;
  const targetObservations = [];
  const checkpointed = await env.composition.userEntry.continue(started.scope, 'New explicitly bounded checkpoint proof', () => false,
    undefined, readPolicy, async identity => { checkpointIdentity = identity; }, async observation => {
      assert.equal(observation.inputId, checkpointIdentity.targetInputId);
      assert.equal(observation.targetMissionId, started.scope.rootMissionId);
      targetObservations.push(structuredClone(observation));
    });
  assert.equal(checkpointed.state, 'executed');
  assert.equal(targetObservations.length, 1, 'public entry forwards the owning Target checkpoint once');
  assert.deepEqual(targetObservations[0], checkpointed.observation);
  assert.equal(env.commands.sends.length, 6);

  const restart = await freshCompositionFrom(env, 'restart-entry');
  await assert.rejects(() => restart.composition.userEntry.continue(started.scope, 'continue', undefined, undefined, readPolicy), /UNKNOWN/);
  assert.equal(restart.commands.sends.length, 0);

  const recoveredSessionId = selected.assignment.managedSessionId;
  const recoveryRequest = { ...replacement, expectedManagedSessionId: recoveredSessionId };
  await assert.rejects(() => restart.composition.workerSelection.recoverAfterRestart(recoveryRequest), /trusted host machine evidence/i);
  assert.equal(restart.tasks.getTask(started.scope.rootMissionId).workerSessions[recoveredSessionId].retiredAt, undefined);
  const recovered = await freshCompositionFrom(env, 'recovered-entry', [resource('recovered-c', 'c', 'https://gamma.example')], {
    orphanRecoveryHost: { currentRuntimeIncarnationId: 'new-host', currentProcessId: 4321,
      currentSystemBootAt: () => new Date('2026-09-18T15:00:00.000Z'),
      observeProcess: () => { throw new Error('Legacy attachment predates boot; no process guess required'); } },
  });
  await recovered.tasks.initialize();
  await assert.rejects(() => recovered.composition.workerSelection.recoverAfterRestart({ ...recoveryRequest,
    materialization: { budget: { maxCombinedChars: -1 } } }), /budget|Chars/);
  assert.equal(recovered.tasks.getTask(started.scope.rootMissionId).workerSessions[recoveredSessionId].retiredAt, undefined);
  const recovery = await recovered.composition.workerSelection.recoverAfterRestart(recoveryRequest);
  assert.equal(recovery.state, 'recovered');
  assert.equal(recovery.retired.ownerDeathProof, 'attachment-predates-current-boot');
  assert.equal(recovery.retired.providerCleanup.state, 'unavailable');
  assert.equal(recovery.assignment.missionId, started.scope.rootMissionId);
  assert.notEqual(recovery.assignment.managedSessionId, recoveredSessionId);
  assert.match(recovery.materialization.workerInput.prompt, /DURABLE_SEMANTIC_CONTEXT/);
  assert.equal(recovery.materialization.workerInput.history, undefined);
  assert.equal(recovered.commands.sends.length, 0, 'restart selection never dispatches or replays old work');
  await assert.rejects(() => recovered.composition.workerSelection.recoverAfterRestart(recoveryRequest), /does not match|does not contain/);

  const declined = await entryFixture('decline-entry'); declined.result.classification = 'requires-human-confirmation';
  const canceled = await declined.composition.userEntry.start('Ambiguous request', '/workspace/entry', async () => JSON.stringify(declined.result), async pending => {
    assert.equal(declined.tasks.listTasks().length, 0); assert(pending.formationDigest); return false;
  });
  assert.equal(canceled.state, 'cancelled'); assert.equal((await projectEvents(declined.projectsDirectory)).length, 0); assert.equal(declined.commands.sends.length, 0);

  const confirmed = await entryFixture('confirm-entry'); confirmed.result.classification = 'requires-human-confirmation'; let asked = 0;
  const accepted = await confirmed.composition.userEntry.start('Ambiguous request', '/workspace/entry', async () => JSON.stringify(confirmed.result), async (pending, plan) => {
    asked++; assert.equal(pending.initialRoot.goal, confirmed.result.initialRoot.goal); assert.equal(plan.instruction, confirmed.result.instruction); return true;
  });
  assert.equal(accepted.state, 'executed'); assert.equal(asked, 1);
  assert.equal(confirmed.projects.getProject(accepted.scope.projectId).formationReceipt.authorization.kind, 'human-confirmed');

  for (const invalid of [{ ...env.result, formationId: 'model-forged-id' }, { ...env.result, providerTranscript: 'TRANSCRIPT_SENTINEL' }, { ...env.result, project: { ...env.result.project, workspace: '/other' } }, { ...env.result, workerPolicy: { constraints: { allowedProviders: [] } } }]) {
    const fail = await entryFixture('invalid-' + Math.random());
    await assert.rejects(() => fail.composition.userEntry.start('request', '/workspace/entry', async () => JSON.stringify(invalid), async () => true));
    assert.equal(fail.tasks.listTasks().length, 0); assert.equal(fail.commands.sends.length, 0);
  }
  const cancel = await entryFixture('cancel-entry'); let cancelled = false;
  const cancelResult = await cancel.composition.userEntry.start('request', '/workspace/entry', async () => { cancelled = true; return JSON.stringify(cancel.result); }, async () => true, () => cancelled);
  assert.equal(cancelResult.state, 'cancelled'); assert.equal(cancel.tasks.listTasks().length, 0);

  const ui = await entryFixture('ui-entry'); let runs = 0;
  const runtime = { async runAgent(params, trace, checkpoint) {
    runs++; assert.deepEqual(params.allowedTools, []); assert.deepEqual(params.history, []); assert.equal(params.retries, 0);
    assert.equal(checkpoint, undefined);
    if (runs === 1) { assert.match(params.prompt, /bounded pre-Project Formation Cognition/); return { answer: JSON.stringify(ui.result) }; }
    assert.match(params.prompt, /bounded request Cognition/);
    return { answer: JSON.stringify({ instruction: 'New bounded request', requiredCapabilityIds: [] }) };
  } };
  const providers = { shuncode: { async resolveRuntimeModel() { return { protocol: 'openai-chat-completions', baseUrl: 'https://example.invalid', model: 'formation-test' }; } } };
  const handler = createMissionNativeChatEntry(ui.composition, Promise.resolve(), runtime, providers, '/workspace/entry');
  const request = { id: 'user-request-1', sessionId: 'normal-user-session', prompt: 'Please implement the bounded request', model: { vendor: 'shuncode', id: 'formation-test' } };
  const messages = []; const stream = { markdown: text => messages.push(text), progress() {} }; const token = { isCancellationRequested: false };
  const uiResult = await handler(request, { history: [] }, stream, token);
  assert.equal(uiResult.metadata.nimoraEntryState, 'executed', messages.join('\n'));
  assert.match(messages.join('\n'), /target completed exact input/, 'assigned Worker response reaches the ordinary Chat stream');
  assert.equal(runs, 1); assert.equal(confirmations, 0); assert.equal(ui.commands.sends.length, 2);
  await handler(request, { history: [] }, stream, token);
  assert.equal(ui.commands.sends.length, 2, 'duplicate ordinary request must not resend');
  await handler({ ...request, id: 'user-request-2', prompt: 'Perform this additional explicit instruction' }, { history: [{ result: uiResult }] }, stream, token);
  assert.equal(runs, 2, 'same conversation reinterprets the new request without creating another Project'); assert.equal(ui.commands.sends.length, 4);
  await ui.composition.userEntry.continue(uiResult.metadata.nimoraMissionScope, 'Explicit work with disconnected display', () => false, () => { throw new Error('display closed'); }, readPolicy);
  assert.equal(ui.commands.sends.length, 6, 'display failure must not alter execution or cause replay');

  const uncertain = await entryFixture('uncertain-entry'); let uncertainRuns = 0;
  const originalSubmit = uncertain.composition.application.submitCognitionOutcome.bind(uncertain.composition.application);
  uncertain.composition.application.submitCognitionOutcome = async input => { await originalSubmit(input); throw new Error('simulated acknowledgement loss after durable Formation'); };
  const uncertainRuntime = { async runAgent() { uncertainRuns++; return { answer: JSON.stringify(uncertain.result) }; } };
  const uncertainHandler = createMissionNativeChatEntry(uncertain.composition, Promise.resolve(), uncertainRuntime, providers, '/workspace/entry');
  const unknownResult = await uncertainHandler({ ...request, id: 'uncertain-1' }, { history: [] }, stream, token);
  assert.equal(unknownResult.metadata.nimoraEntryState, 'blocked'); assert(unknownResult.metadata.nimoraUncertainFormationId);
  assert.equal((await projectEvents(uncertain.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 1);
  await uncertainHandler({ ...request, id: 'uncertain-2' }, { history: [ { result: unknownResult } ] }, stream, token);
  const reopenedHandler = createMissionNativeChatEntry(uncertain.composition, Promise.resolve(), uncertainRuntime, providers, '/workspace/entry');
  await reopenedHandler({ ...request, id: 'uncertain-3' }, { history: [ { result: unknownResult } ] }, stream, token);
  assert.equal(uncertainRuns, 1, 'UNKNOWN Formation cannot trigger a second Project, including after handler recreation');
  assert.equal(uncertain.commands.sends.length, 0);

  const reopenedUi = createMissionNativeChatEntry(ui.composition, Promise.resolve(), runtime, providers, '/workspace/entry');
  await reopenedUi({ ...request, id: 'task-center-request', sessionResource: { scheme: 'nimora-task', path: '/' + uiResult.metadata.nimoraMissionScope.rootMissionId, toString() { return 'nimora-task:existing-root'; } } }, { history: [] }, stream, token);
  assert.equal(runs, 3, 'Task Center Mission runs new-request Cognition without forming a new Project'); assert.equal(ui.commands.sends.length, 8);
  const allEvents = JSON.stringify(await projectEvents(ui.projectsDirectory));
  assert(!allEvents.includes('providerTranscript')); assert(!allEvents.includes('formation-test'), 'Cognition model is not Project identity');
  console.log('WO3 user entry smoke passed: real composition/transport, normal UI, clear/confirm/cancel, strict identity, no Draft/transcript, duplicate no-send, replacement rematerialization, restart fail-closed.');
} finally {
  assert(path.resolve(tempRoot).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(tempRoot).startsWith('nimora-'));
  await fs.rm(tempRoot, { recursive: true, force: true });
  delete globalThis.__nimoraTestVscode;
}
