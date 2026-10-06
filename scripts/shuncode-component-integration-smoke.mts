import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { canonicalPageAssets } from '../tools/webmcp-gateway/canonical-page-assets.mjs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-components-'));
let platformSkills: any[] = [], fileType = 1, fileSize = 12, bytes = new TextEncoder().encode('bounded skill');
const commands = new Map<string, Function>();
let resources: any[] = [], cleanupCalls = 0, cleanupVerified = true;
const state = new Map();
const vscode = { CancellationTokenSource: class { token = {}; dispose() {} }, FileType: { File: 1 },
  Uri: { parse: value => ({ toString: () => value }) }, chat: { getSkills: async () => platformSkills },
  workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: temp } }], fs: { stat: async () => ({ type: fileType, size: fileSize }), readFile: async () => bytes } },
  window: { showQuickPick: async rows => rows[0], showInformationMessage: async () => '归档' },
  commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; }, executeCommand: async id => {
    if (id === '_shuncode.webMcp.archiveRetiredConversation') { cleanupCalls++; return { verified: cleanupVerified }; }
    return id === '_shuncode.webMcp.workerListResources' ? resources : [];
  } } };
(globalThis as any).componentVscode = vscode;
try {
  await require('esbuild').build({ stdin: { contents: `
    export { createPlatformSkillSource } from './extensions/shuncode/src/platform-skill-source.ts';
    export { PlatformAgentHostWorkerAdapter, AgentHostWorkerCandidateSource } from './extensions/shuncode/src/agent-host-worker-candidate-source.ts';
    export { ApiWorkerCandidateSource } from './extensions/shuncode/src/api-worker-candidate-source.ts';
    export { retiredCleanupTargets, registerNimoraProviderCleanup } from './extensions/shuncode/src/nimora-provider-cleanup.ts';
    export { agentHostWorkerDiscovery } from './src/agent-host-worker-discovery.ts';
    export { MissionObservationBuffer } from './src/mission-observation-buffer.ts';
    export { ProjectStore } from './src/project-store.ts';
    export { TaskRuntime } from './src/task-runtime.ts';
    export { WorkerSessionManager } from './src/worker-session-manager.ts';
    export { buildProjectFormationReceipt } from './src/project-contract.ts';
    export { ProjectFormationService } from './src/project-formation-service.ts';
  `, resolveDir: root, loader: 'ts' }, outfile: path.join(temp, 'test.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'platform-fixture', setup(build) { build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: 'const v = globalThis.componentVscode; export const {CancellationTokenSource,FileType,Uri,chat,workspace,window,commands} = v;' })); } }] });
  const api = require(path.join(temp, 'test.cjs'));

  // Run the actual two Core mapping methods without loading a Workbench.
  const ts = require('typescript');
  const method = async (file, name, globals) => {
    const text = await fs.readFile(path.join(root, file), 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    let found; const visit = node => { if (ts.isMethodDeclaration(node) && node.name.getText(source) === name) found = node; ts.forEachChild(node, visit); }; visit(source);
    assert.ok(found?.body, name);
    const parameters = found.parameters.map(p => p.name.getText(source)).join(',');
    const transpiled = ts.transpileModule(`globalThis.fn = function(${parameters}) ${found.body.getText(source)}`, { compilerOptions: { target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true });
    assert.equal(transpiled.diagnostics.length, 0);
    const context = vm.createContext(globals); vm.runInContext(transpiled.outputText, context); return context.fn;
  };
  const uri = { toString: () => 'file:///skills/a/SKILL.md' };
  const disabled = new Set();
  const toDto = await method('src/vs/workbench/api/browser/mainThreadChatAgents2.ts', '_toSkillDto', { PromptsType: { skill: 'skill' } });
  const owner = { _promptsService: { getDisabledPromptFiles: () => disabled }, _toChatResourceSource: value => value };
  const raw = { uri, name: 'a', storage: 'user' };
  assert.equal(toDto.call(owner, raw).enabled, true); disabled.add(uri); assert.equal(toDto.call(owner, raw).enabled, false);
  const toSkill = await method('src/vs/workbench/api/common/extHostChatAgents2.ts', 'toSkill', { URI: { revive: value => value } });
  assert.equal(toSkill(toDto.call(owner, raw)).enabled, false); assert.equal(toSkill({ uri, enabled: true }).enabled, true);
  assert.equal(toSkill({ uri }).enabled, false, 'old hosts cannot silently grant Skill enablement');
  const source = api.createPlatformSkillSource();
  platformSkills = [{ uri, name: 'a', description: 'safe', source: 'user', enabled: true }];
  let rows = await source.listSkills(); assert.equal(rows[0].enabled, true); assert.equal((await source.loadContent(rows[0])).content, 'bounded skill');
  platformSkills[0].enabled = false; await assert.rejects(source.loadContent(rows[0]), /enablement/);
  delete platformSkills[0].enabled; assert.equal((await source.listSkills())[0].enabled, false);
  platformSkills[0].enabled = true; rows = await source.listSkills(); platformSkills[0].description = 'changed'; await assert.rejects(source.loadContent(rows[0]), /provenance/);
  rows = await source.listSkills(); fileType = 65; await assert.rejects(source.loadContent(rows[0]), /regular file/); fileType = 1;
  fileSize = 64_001; await assert.rejects(source.loadContent(rows[0]), /bounded/); fileSize = 12;
  bytes = Uint8Array.from([255]); await assert.rejects(source.loadContent(rows[0])); bytes = new TextEncoder().encode('bounded skill');

  // Native discovery never leaks connection internals or converts observation into execution authority.
  const discovery = api.agentHostWorkerDiscovery({ agents: [{ provider: 'native', displayName: 'Native', models: [{ id: 'm' }], credential: 'PRIVATE_SENTINEL' }], sessions: ['PRIVATE_SENTINEL'] });
  assert.doesNotMatch(JSON.stringify(discovery), /PRIVATE_SENTINEL/);
  const workers = new api.WorkerSessionManager();
  await workers.register(new api.PlatformAgentHostWorkerAdapter(async () => discovery));
  const native = new api.AgentHostWorkerCandidateSource(workers, () => true);
  const nativeRows = await native.enumerateCandidates(); assert.equal(nativeRows.length, 1); assert.equal(nativeRows[0].availability, 'unavailable');
  await assert.rejects(native.materializeSessionOptions(nativeRows[0], {}), /cannot enforce/);
  assert.equal((await new api.AgentHostWorkerCandidateSource(workers, () => false).enumerateCandidates()).length, 0);
  assert.equal((await new api.PlatformAgentHostWorkerAdapter(async () => undefined).describe()).availability, 'unavailable');
    assert.equal((await new api.PlatformAgentHostWorkerAdapter(async () => ({ state: 'connected', providers: [null] })).describe()).models.length, 0);
    let scopedSnapshot = { state: 'connected', missionToolPolicy: false, clientToolWorkerVersion: 1,
      providers: [{ id: 'copilotcli', label: 'Copilot', models: ['scoped-model'] }, { id: 'claude', label: 'Claude', models: ['other-model'] }] };
    const nativeOperations = [];
    const scopedAdapter = new api.PlatformAgentHostWorkerAdapter(async () => scopedSnapshot, 'nimora.agent-host', async request => {
      nativeOperations.push(request);
      if (request.operation === 'create') return { sessionId: 'fresh-owned-handle', workerId: 'nimora.agent-host', state: 'idle', createdAt: 'now', lastActiveAt: 'now' };
      if (request.operation === 'poll') return { active: false, events: [{ type: 'terminal', inputId: 'bounded-turn', status: 'completed' }] };
    });
    const scopedWorkers = new api.WorkerSessionManager(); await scopedWorkers.register(scopedAdapter);
    const scopedSource = new api.AgentHostWorkerCandidateSource(scopedWorkers, () => true);
    const scopedRows = await scopedSource.enumerateCandidates();
    assert.equal(scopedRows.find(row => row.provider === 'copilotcli').availability, 'available');
    assert.equal(scopedRows.find(row => row.provider === 'claude').availability, 'unavailable');
    assert.equal(scopedRows.find(row => row.provider === 'claude').capabilities.capabilityRequests, false);
    const scopedOptions = await scopedSource.materializeSessionOptions(scopedRows.find(row => row.provider === 'copilotcli'), { model: 'scoped-model' });
    await assert.rejects(scopedAdapter.createSession({ ...scopedOptions, model: 'wrong-model' }), /unsupported/);
    assert.equal(nativeOperations.length, 0);
    const scopedHandle = await scopedAdapter.createSession(scopedOptions);
    const scopedEvents = []; for await (const event of scopedAdapter.send(scopedHandle, { inputId: 'bounded-turn', prompt: 'bounded' })) scopedEvents.push(event);
    assert.equal(scopedEvents.at(-1).status, 'completed');
    await scopedAdapter.dispose(scopedHandle);
    scopedSnapshot = { ...scopedSnapshot, clientToolWorkerVersion: 2 };
    assert.equal((await scopedAdapter.describe()).availability, 'unavailable');
    await assert.rejects(scopedSource.materializeSessionOptions(scopedRows.find(row => row.provider === 'copilotcli'), { model: 'scoped-model' }), /cannot enforce/);
  assert.deepEqual(await new api.ApiWorkerCandidateSource(workers, async () => { throw new Error('optional secret unavailable'); }).enumerateCandidates(), []);

  // Commit hooks preserve canonical truth; diagnostic payloads remain bounded and private.
  const observations = new api.MissionObservationBuffer(4);
  const tasks = new api.TaskRuntime({ storageDirectory: path.join(temp, 'tasks'), onDidChange: (task, event) => observations.recordTask(task, event) });
  const projects = new api.ProjectStore({ storageDirectory: path.join(temp, 'projects'), onDidChange: event => observations.recordProject(event, tasks.listTasks()) });
  const formation = await new api.ProjectFormationService(projects, tasks).ensureFormation(api.buildProjectFormationReceipt({ formationId: 'components',
    project: { goal: 'PRIVATE_SENTINEL', workspace: temp }, initialRoot: { goal: 'PRIVATE_SENTINEL', plane: 'cognition', missionType: 'project-goal', completionCriteria: ['verified'] }, authorization: { kind: 'clear-intent-cognition' } }));
  assert.ok(observations.snapshot().some(row => row.name === 'project.created'));
  assert.ok(observations.snapshot().some(row => row.source.owner === 'task-runtime'));
  const rootTask = formation.rootMission;
  observations.recordExchange({ kind: 'Evidence', exchangeId: 'exchange', sourceMissionId: rootTask.taskId, projectId: formation.project.projectId, createdAt: new Date().toISOString(), payload: { transcript: 'PRIVATE_SENTINEL' } }, [rootTask]);
  assert.ok(observations.snapshot().some(row => row.source.sourceRecordId === 'exchange'));
  for (let i = 0; i < 8; i++) observations.recordBrowser(rootTask, { workerId: 'web', managedSessionId: 'managed', adapterSessionId: 'exact-page' }, { transport: 'connected', page: 'exact', conversation: 'exact', turn: 'unknown', auth: 'ready', capability: 'unknown' });
  const snapshot = observations.snapshot(); assert.equal(snapshot.length, 4); assert.equal(snapshot[0].facts.turnSettlement, 'unknown');
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_SENTINEL|"payload"/); snapshot[0].name = 'changed'; assert.notEqual(observations.snapshot()[0].name, 'changed');
  const broken = new api.ProjectStore({ storageDirectory: path.join(temp, 'broken-projects'), onDidChange: () => { throw new Error('observer'); } });
  const committed = await broken.createProject({ goal: 'canonical survives observer failure' });
  const restored = new api.ProjectStore({ storageDirectory: path.join(temp, 'broken-projects') }); await restored.initialize(); assert.deepEqual(restored.getProject(committed.projectId), committed);

  const retiredTask = { ...rootTask, interactions: {}, executions: {}, workerSessions: { managed: { managedSessionId: 'managed', adapterSessionId: 'page-native', retiredAt: 'now' } } };
  resources = [{ pageId: 'p', href: 'https://chat.deepseek.com/a/chat/s/conversation', ready: true, workerTurnState: 'idle', pageSessionId: 'page-native' }];
  assert.equal(api.retiredCleanupTargets([retiredTask], resources).length, 1);
  resources = [{ ...resources[0], workerTurnState: 'completed' }];
  assert.equal(api.retiredCleanupTargets([retiredTask], resources).length, 1, 'successful retired turns stay completed on real pages');
  assert.equal(api.retiredCleanupTargets([{ ...retiredTask, workerSessions: { managed: { ...retiredTask.workerSessions.managed, retiredAt: undefined } } }], resources).length, 0, 'completed alone does not authorize cleanup of an active Worker');
  for (const workerTurnState of ['running', 'failed', 'unknown', 'interrupted', undefined]) {
    assert.equal(api.retiredCleanupTargets([retiredTask], [{ ...resources[0], workerTurnState }]).length, 0);
  }
  assert.equal(api.retiredCleanupTargets([{ ...retiredTask, executions: { pending: { status: 'unknown' } } }], resources).length, 0);
  for (const deliveryStatus of ['pending', 'unknown']) {
    assert.equal(api.retiredCleanupTargets([{ ...retiredTask, executions: { pending: { status: 'succeeded', deliveryStatus } } }], resources).length, 0, 'completed page cannot override unresolved delivery');
  }
  assert.equal(api.retiredCleanupTargets([retiredTask, retiredTask], resources).length, 0);
  assert.equal(api.retiredCleanupTargets([retiredTask], [{ ...resources[0], workerTurnState: 'unknown' }]).length, 0);
  assert.equal(api.retiredCleanupTargets([retiredTask], [{ ...resources[0], href: 'https://chat.deepseek.com/a/chat/s/%ZZ' }]).length, 0);
  const composition = { owners: { projects: { getProject: () => ({ workspace: temp }) }, tasks: { listTasks: () => [retiredTask], rereadTask: async () => retiredTask } } };
  const context = { workspaceState: { get: (key, fallback) => state.get(key) ?? fallback, update: async (key, value) => state.set(key, value) } };
  api.registerNimoraProviderCleanup(context, composition); const cleanup = commands.get('shuncode.nimora.archiveRetiredConversation');
  vscode.window.showInformationMessage = async () => { vscode.workspace.isTrusted = false; return '归档'; };
  await assert.rejects(cleanup({ projectId: formation.project.projectId }), /工作区或信任/); assert.equal(cleanupCalls, 0);
  vscode.workspace.isTrusted = true; vscode.window.showInformationMessage = async () => '归档';
  cleanupVerified = false; await assert.rejects(cleanup({ projectId: formation.project.projectId }), /未确认/);
  cleanupVerified = true; await assert.rejects(cleanup({ projectId: formation.project.projectId }), /已经消费/); assert.equal(cleanupCalls, 1);
  const lifecycle = createRequire(import.meta.url)(path.join(root, 'extensions/shuncode-webmcp/conversation-lifecycle.js'));
  let read = 0, clicks = 0;
  await assert.rejects(lifecycle.runProviderConversationCleanup({ readPage: async () => ++read === 1 ? 'URL: https://chatgpt.com/c/exact\n- button "Archive" [ref=archive]' : 'page disappeared', clickElement: async () => { clicks++; } },
    { pageId: 'exact', expectedHref: 'https://chatgpt.com/c/exact', conversationId: 'exact', mode: 'archive-only' }), /unverified/);
  assert.equal(clicks, 1, 'missing post-action URL cannot be reported as verified or retried');

  const canonical = canonicalPageAssets({});
  const packaged = canonicalPageAssets({}, path.join(root, 'extensions/shuncode-webmcp/gateway'));
  for (const key of Object.keys(canonical)) assert.deepEqual(await fs.readFile(canonical[key]), await fs.readFile(packaged[key]), 'staged bytes equal canonical extension assets');
  assert.throws(() => canonicalPageAssets({}, path.join(temp, 'missing')), /missing/);
  console.log('Component integration PASS: Core Skill DTO, disabled/provenance/file-bound Skills, gated AHP discovery, optional API failure isolation, durable commit observations, bounded/private diagnostics, retired cleanup no-replay, canonical staged assets.');
} finally {
  delete (globalThis as any).componentVscode;
  assert.equal(path.dirname(temp), os.tmpdir()); assert.ok(path.basename(temp).startsWith('nimora-components-')); await fs.rm(temp, { recursive: true, force: true });
}
