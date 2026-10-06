import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild');
const Module = require('node:module');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-ui-host-'));
const bundle = path.join(temp, 'product-shell.cjs');
await esbuild.build({
  stdin: { contents: `export { registerNimoraProductShell } from './extensions/shuncode/src/nimora-product-shell.ts';
    export { ProjectStore } from './src/project-store.ts'; export { TaskRuntime } from './src/task-runtime.ts';
    export { ProjectFormationService } from './src/project-formation-service.ts'; export { buildProjectFormationReceipt } from './src/project-contract.ts';`, resolveDir: root, loader: 'ts' },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: ['es2022'],
  external: ['vscode'], logLevel: 'silent',
});

const commands = new Map();
const executions = [];
let panel;
let receiveMessage;
let disposePanel;
let userInput = 'Create a bounded project through the accepted Formation ingress';
const hostMessages = [];
const commandResponses = new Map();
const uiErrors = [];
const previewDirectory = process.env.NIMORA_UI_PREVIEW_DIR;
async function capturePreview(name) {
  if (!previewDirectory) return;
  await fs.mkdir(previewDirectory, { recursive: true });
  await fs.writeFile(path.join(previewDirectory, name + '.html'), panel.webview.html);
}
const mock = {
  StatusBarAlignment: { Left: 1 },
  ViewColumn: { Active: -1, One: 1 },
  ProgressLocation: { Notification: 1 },
  ThemeIcon: class { constructor(name) { this.name = name; } },
  Disposable: { from: (...items) => ({ dispose: () => items.forEach(item => item.dispose?.()) }) },
  Uri: { from: value => ({ ...value, toJSON: () => value }), parse: value => ({ value }), file: fsPath => ({ scheme: 'file', fsPath }) },
  workspace: { workspaceFolders: [{ name: 'isolated-test-workspace', uri: { scheme: 'file', fsPath: temp } }], isTrusted: true },
  commands: {
    registerCommand: (name, callback) => {
      assert.equal(commands.has(name), false, 'test UI must not register a command twice');
      commands.set(name, callback);
      return { dispose: () => commands.delete(name) };
    },
    executeCommand: async (name, ...args) => { executions.push({ name, args }); return commandResponses.get(name)?.(...args); },
  },
  window: {
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    createWebviewPanel: (type, title, column, options) => {
      panel = {
        type, title, column, options, iconPath: undefined,
        webview: { html: '', postMessage: async message => { hostMessages.push(message); return true; }, onDidReceiveMessage: callback => { receiveMessage = callback; return { dispose() {} }; } },
        reveal() {},
        onDidDispose: callback => { disposePanel = callback; return { dispose() {} }; },
      };
      return panel;
    },
    showInputBox: async () => userInput,
    showOpenDialog: async () => undefined,
    showErrorMessage: async message => { uiErrors.push(message); },
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    withProgress: async (_, callback) => callback(),
  },
};

const originalLoad = Module._load;
Module._load = function(request, ...args) {
  if (request === 'vscode') return mock;
  return originalLoad.call(this, request, ...args);
};

let registration;
try {
  const { registerNimoraProductShell, ProjectStore, TaskRuntime, ProjectFormationService, buildProjectFormationReceipt } = require(bundle);
  const memento = new Map();
  const globalMemento = new Map();
  let taskUnavailable = false;
  let observedProviders = [];
  let observedLiveWorkers = [];
  const owners = {
    projects: { initialize: async () => {}, listProjects: () => [], listDecisions: () => [] },
    tasks: {
      initialize: async () => { if (taskUnavailable) throw Error('TaskRuntime unavailable sentinel'); },
      listTasks: () => [],
    },
    collaboration: { initialize: async () => {}, listRelations: () => [], listExchanges: () => [] },
  };
  registration = registerNimoraProductShell(
    { subscriptions: [], globalStorageUri: { fsPath: temp },
      workspaceState: { get: (key, fallback) => memento.get(key) ?? fallback, update: async (key, value) => memento.set(key, value) },
      globalState: { get: (key, fallback) => globalMemento.get(key) ?? fallback, update: async (key, value) => globalMemento.set(key, value) } }, owners, undefined, undefined,
    { read: async () => ({ generatedAt: new Date().toISOString(), candidateReadState: 'available', candidateErrors: [], providers: observedProviders, liveWorkers: observedLiveWorkers }) },
  );
  assert.ok(commands.has('shuncode.nimora.open'), 'real Product Shell must register Open');
  await commands.get('shuncode.nimora.open')();
  assert.equal(panel.type, 'nimora.productShell');
  assert.equal(panel.column, mock.ViewColumn.Active, 'Nimora must open in the active editor group instead of being forced into a narrow first group');
  assert.equal(panel.options.enableScripts, true);
  assert.match(panel.webview.html, /从一个真实目标开始/, 'available empty owners must show real onboarding');
  assert.match(panel.webview.html, /选择位置并新建项目/, 'empty work surface must expose one direct primary creation action');
  assert.match(panel.webview.html, /先设置 AI 资源/, 'empty work surface must keep resource setup as a clear secondary action');
  assert.match(panel.webview.html, /id="action-feedback"/, 'long-running product actions must have an aria-live feedback surface');
  assert.match(panel.webview.html, /@media\(max-width:760px\)/, 'Product Shell must collapse cleanly in narrow editor layouts');
  assert.match(panel.webview.html, /Nimora/, 'Webview must render the actual product shell');
  assert.match(panel.webview.html, /执行权限 · 按任务确认/);
  await capturePreview('empty');
  const script = panel.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/);
  assert.ok(script, 'rendered product HTML must include a CSP-approved client script');
  new vm.Script(script[1], { filename: 'nimora-product-webview.js' });
  // Exercise the rendered client click path, not a hand-written host message:
  // recovery actions used to fall through and silently lose the Project ID.
  const clientMessages = [];
  const clientListeners = new Map();
  const clientWindowListeners = new Map();
  vm.runInNewContext(script[1], {
    acquireVsCodeApi: () => ({ postMessage: message => clientMessages.push(message), getState: () => ({}) }),
    window: { addEventListener: (event, listener) => clientWindowListeners.set(event, listener) },
    document: {
      addEventListener: (event, listener) => clientListeners.set(event, listener),
      querySelectorAll: () => [], getElementById: () => undefined, body: { contains: () => true },
    },
  });
  for (const action of ['takeoverReviewedWebWorkers', 'resumeReviewedWebWorkers', 'startReviewedFirstMission', 'reconcileReviewedFirstRead', 'sendReviewedFreshRead', 'restoreReviewedSettledRead', 'replaceReviewedClosedPages', 'resumeReviewedFreshReplacement', 'prepareReviewedPractice', 'runReviewedPractice', 'reconcileReviewedPractice', 'diagnoseReviewedSettlement', 'reviewProjectCompletion', 'assignReadyWebMissions', 'runWebAutonomy', 'startNextProjectGoal', 'resumeNextProjectGoal', 'selectProjectSkills', 'archiveRetiredConversation', 'openProjectWorkspace', 'changeProjectLocation', 'archiveProjectFromList', 'restoreArchivedProject', 'enterProjectWork']) {
    clientWindowListeners.get('message')({ data: { type: 'nimoraActionState', busy: false } });
    const fakeButton = { dataset: { action, project: 'exact-recovered-project' }, textContent: action, setAttribute() {}, removeAttribute() {} };
    clientListeners.get('click')({ target: { closest: () => fakeButton } });
    assert.deepEqual(JSON.parse(JSON.stringify(clientMessages.at(-1))), {
      type: action, projectId: 'exact-recovered-project',
    }, 'actual recovery button must carry its exact Project identity to the host');
  }
  clientWindowListeners.get('message')({ data: { type: 'nimoraActionState', busy: true } });
  const blockedCount = clientMessages.length;
  clientListeners.get('click')({ target: { closest: () => ({ dataset: { action: 'newWebProject' } }) } });
  assert.equal(clientMessages.length, blockedCount, 'busy client must not dispatch a second execution action');
  clientListeners.get('click')({ target: { closest: () => ({ dataset: { action: 'selectView', view: 'settings' } }) } });
  assert.equal(clientMessages.at(-1).type, 'selectView', 'view navigation remains available during work');
  clientWindowListeners.get('message')({ data: { type: 'nimoraActionState', busy: false } });

  async function dispatch(message) {
    receiveMessage(message);
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  mock.workspace.workspaceFolders = [];
  await dispatch({ type: 'refresh' });
  assert.match(panel.webview.html, /data-action="openWorkspace"/);
  await dispatch({ type: 'openWorkspace' });
  assert.ok(executions.some(entry => entry.name === 'workbench.action.files.openFolder'));
  mock.workspace.workspaceFolders = [{ name: 'isolated-test-workspace', uri: { scheme: 'file', fsPath: temp } }];
  mock.workspace.isTrusted = false;
  await dispatch({ type: 'refresh' });
  assert.match(panel.webview.html, /data-action="manageWorkspaceTrust"/);
  await dispatch({ type: 'manageWorkspaceTrust' });
  assert.ok(executions.some(entry => entry.name === 'workbench.trust.manage'));
  assert.equal(mock.workspace.isTrusted, false, 'onboarding must open the native trust UI without granting trust');
  mock.workspace.isTrusted = true;
  let finishResourceSetup;
  commandResponses.set('shuncode.nimora.configureResources', () => new Promise(resolve => { finishResourceSetup = resolve; }));
  await dispatch({ type: 'configureResources' });
  await dispatch({ type: 'selectView', view: 'settings' });
  assert.match(panel.webview.html, /setActionState\(true,/, 'refresh and navigation must retain the host busy state');
  const pendingSetupCount = executions.filter(entry => entry.name === 'shuncode.nimora.configureResources').length;
  await dispatch({ type: 'configureResources' });
  assert.equal(executions.filter(entry => entry.name === 'shuncode.nimora.configureResources').length, pendingSetupCount, 'host must reject duplicate actions even after client reload');
  finishResourceSetup();
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(hostMessages.at(-1).busy, false, 'only actual command settlement clears busy state');
  commandResponses.set('shuncode.nimora.configureResources', () => { throw Error('UI_TEST_FAILURE </script>'); });
  await dispatch({ type: 'configureResources' });
  assert.match(hostMessages.at(-1).error, /UI_TEST_FAILURE/);
  assert.equal(hostMessages.at(-1).busy, false);
  await dispatch({ type: 'refresh' });
  assert.match(panel.webview.html, /UI_TEST_FAILURE \\u003c\/script>/, 'inline feedback must escape script delimiters across render');
  await capturePreview('action-error');
  commandResponses.delete('shuncode.nimora.configureResources');
  await dispatch({ type: 'configureResources' });
  assert.equal(hostMessages.at(-1).error, undefined, 'a new explicit operation clears old feedback');
  await dispatch({ type: 'selectView', view: 'connections' });
  assert.match(panel.webview.html, /<h1>AI 资源<\/h1>/, 'navigation must show the user-facing AI Resources surface');
  assert.match(panel.webview.html, /高级 · 连接与运行诊断/, 'technical connection state must remain available behind Advanced diagnostics');
  assert.doesNotMatch(panel.webview.html, /<aside class="context-sidebar"/, 'global AI Resources view must not duplicate the Project context sidebar');
  await capturePreview('connections');
  observedProviders = [
    { provider: 'deepseek', workerId: 'nimora.web-worker', kind: 'web', availability: 'available', models: [], health: { status: 'healthy', checkedAt: new Date().toISOString() }, observedAt: new Date().toISOString() },
    { provider: 'deepseek', workerId: 'nimora.web-worker', kind: 'web', availability: 'unavailable', models: [], health: { status: 'degraded', checkedAt: new Date().toISOString() }, observedAt: new Date().toISOString() },
  ];
  await dispatch({ type: 'refresh' });
  assert.match(panel.webview.html, /1 个连接可用/, 'primary provider card must expose a concise usable-resource count');
  assert.match(panel.webview.html, /2 个候选 · 1 个健康/, 'candidate-level observation detail must remain available in Advanced diagnostics');
  assert.doesNotMatch(panel.webview.html, /本轮观测：/, 'candidate observation jargon must not leak into the primary resource card');
  observedProviders = [];
  await dispatch({ type: 'selectView', view: 'projects' });
  assert.match(panel.webview.html, /id="project-management-filter"/, 'Project management must expose a dedicated search field');
  assert.doesNotMatch(panel.webview.html, /<aside class="context-sidebar"/, 'Project management must not duplicate the Work context sidebar');
  taskUnavailable = true;
  await dispatch({ type: 'refresh' });
  assert.match(panel.webview.html, /当前无法完整读取 Nimora 工作区/, 'failed owner must not appear as empty projects');
  assert.match(panel.webview.html, /TaskRuntime unavailable sentinel/, 'provider failure must be inspectable');
  await capturePreview('degraded');
  taskUnavailable = false;
  await dispatch({ type: 'refresh' });
  assert.match(panel.webview.html, /<h1>项目管理<\/h1>/, 'recovered owners must restore the selected first-class Project management surface');

  await dispatch({ type: 'newWebProject' });
  const webStart = executions.find(entry => entry.name === 'shuncode.nimora.startWebProject');
  assert.equal(webStart?.args[0]?.request, userInput, 'Web Project must use the separate web-Cognition production command');
  assert.equal(executions.some(entry => entry.name === 'workbench.action.chat.open'), false, 'web button must not quietly use quota-limited native API Chat');
  await fs.mkdir(path.join(temp, 'recovery'), { recursive: true });
  await fs.writeFile(path.join(temp, 'recovery', 'reviewed-formation-cognition.json'), '{}');
  await dispatch({ type: 'refresh' });
  assert.match(panel.webview.html, /接入已完成的 DeepSeek 分析 · 仅建项/, 'restored Cognition must have a visible, separate recovery entry');
  await dispatch({ type: 'adoptReviewedWebCognition' });
  assert.equal(executions.filter(entry => entry.name === 'shuncode.nimora.adoptReviewedWebCognition').length, 1,
    'recovery button must route directly to distinct local reviewed-JSON ingress, not to Web Cognition');
  assert.equal(executions.filter(entry => entry.name === 'shuncode.nimora.startWebProject').length, 1,
    'reviewed recovery UI must not silently submit the original provider prompt again');
  const source = await fs.readFile(path.join(root, 'extensions/shuncode/src/nimora-product-shell.ts'), 'utf8');
  assert.match(source, /data-action="takeoverReviewedWebWorkers"/, 'existing recovered Project must expose a separate new-page takeover button');
  assert.match(source, /data-action="startReviewedFirstMission"/, 'first read-only Mission must require a separate explicit button');
  assert.match(source, /takeoverPhase === "ready"/, 'first send remains disabled until the exact new Worker bindings are confirmed');
  assert.match(source, /接管状态待人工核实/, 'restart, partial assignment and ambiguous sends must not show an enabled retry button');
  assert.match(source, /practiceNeedsFailureReview\(practiceTask, selectedPractice\.failureReview\)/,
    'the real Product Shell must use exact canonical failure provenance, not a displayed failure count, before offering a new send');
  assert.match(source, /practiceReviewState === 'unavailable'/,
    'missing canonical Practice task must disable the send action instead of treating it as reviewed');
  assert.match(source, /data-action="replaceReviewedClosedPages"/, 'original three-Mission Project must expose an explicit NEW-page replacement path');
  assert.match(source, /takeoverPhase === "replacing-new-workers"/, 'partial new-page replacement is visible and cannot silently retry');
  assert.match(source, /data-action="resumeReviewedFreshReplacement"/, 'only pre-mutation native-consent pages have an explicit inspection/continuation entry');
  assert.match(source, /practice\.coordinationFailure[\s\S]*?data-action="diagnoseReviewedSettlement"/,
    'a stranded Coordinator receipt must visibly route to read-only diagnosis, not another provider send');
  assert.match(source, /previousWorkersDisconnected \? [\s\S]*?data-action="replaceReviewedClosedPages"/,
    'only a project whose original live Workers are all gone may display a new-page recovery choice');
  assert.match(source, /practice\.coordinationFailure\s*\?/, 'a known Coordinator failure must precede a generic continue action');
  assert.match(source, /shuncode\.nimora\.\$\{message\.type\}/, 'recovery buttons must route to their Project-scoped commands');
  assert.match(source, /case "startReviewedFirstMission"[\s\S]*?shuncode\.nimora\.\$\{message\.type\}/, 'new UI must route each separately approved Project-scoped action');
  assert.match(source, /data-action="runWebAutonomy"/, 'managed autonomy must retain the bounded production autonomy entry behind product controls');
  assert.match(source, /selectedManagedAutonomy/, 'Product Shell must not interpret the legacy managed-project set as proof of Web-only execution');
  assert.match(source, /让 Nimora 继续推进/, 'managed task detail must route ordinary continuation through project-level autonomy');
  assert.match(source, /selected\.unknownExecutionCount/, 'autonomy UI must stay unavailable when canonical UNKNOWN exists');
  assert.match(source, /shuncode\.nimora\.runWebAutonomy/, 'Webview must delegate autonomy to the production command instead of owning orchestration');
  await dispatch({ type: 'selectView', view: 'connections' });
  assert.match(panel.webview.html, /连接 DeepSeek|打开并连接/, 'Connections must expose direct Web AI entry');
  await dispatch({ type: 'connectWebAi', provider: 'deepseek' });
  assert.equal(executions.some(entry => entry.name === 'shuncode.nimora.connectWebAi' && entry.args[0]?.provider === 'deepseek'), true);
  await dispatch({ type: 'openArtifact', uri: 'command:evil.run' });
  assert.equal(executions.some(entry => entry.name === 'vscode.open'), false, 'forged Webview URIs must not reach host open command');

  await dispatch({ type: 'newProject' });
  assert.ok(executions.some(entry => entry.name === 'workbench.action.chat.newLocalChat'), 'new project must start a fresh Chat');
  const chat = executions.find(entry => entry.name === 'workbench.action.chat.open');
  assert.match(chat.args[0].query, /^@shuncode Create a bounded project/, 'new project must reuse actual native Formation ingress');
  assert.equal(chat.args[0].blockOnResponse, true);
  assert.match(panel.webview.html, /从一个真实目标开始/, 'no phantom Project when a stubbed Formation did not create one');
  const projects = new ProjectStore({ storageDirectory: path.join(temp, 'projects') });
  const tasks = new TaskRuntime({ storageDirectory: path.join(temp, 'tasks') });
  const formed = await new ProjectFormationService(projects, tasks).ensureFormation(buildProjectFormationReceipt({ formationId: 'shell-later', project: { goal: 'first', workspace: temp },
    initialRoot: { goal: 'first', plane: 'cognition', missionType: 'project-goal', completionCriteria: ['verified'] }, authorization: { kind: 'clear-intent-cognition' } }));
  await tasks.finalizeMissionStrict(formed.rootMission.taskId, { handoffRequired: false }); await tasks.archiveMissionStrict(formed.rootMission.taskId);
  owners.projects.listProjects = () => projects.listProjects(); owners.tasks.listTasks = () => tasks.listTasks();
  memento.set('nimora.webProjectIds', [formed.project.projectId]);
  await dispatch({ type: 'refresh' });
  assert.match(panel.webview.html, /data-action="startNextProjectGoal"/, 'completed ordinary Web Project exposes next work');
  await dispatch({ type: 'selectView', view: 'work' });
  await capturePreview('completed-work');
  assert.match(panel.webview.html, /任务已结束 1/, 'formal Mission completion must not be confused with the completed todo count');
  await dispatch({ type: 'selectView', view: 'projects' });
  await capturePreview('projects');
  await dispatch({ type: 'selectView', view: 'work' });
  userInput = 'new goal for same Project';
  await dispatch({ type: 'startNextProjectGoal', projectId: formed.project.projectId });
  assert.deepEqual(executions.find(row => row.name === 'shuncode.nimora.startNextProjectGoal').args[0], { projectId: formed.project.projectId, request: userInput });
  memento.set('nimora.pendingLaterRoot.v1', { [formed.project.projectId]: { request: 'original pending goal' } });
  await dispatch({ type: 'refresh' });
  assert.match(panel.webview.html, /data-action="resumeNextProjectGoal"/, 'pending saved operation wins over completed-history action');
  await dispatch({ type: 'resumeNextProjectGoal', projectId: formed.project.projectId });
  assert.equal(executions.filter(row => row.name === 'shuncode.nimora.startNextProjectGoal').at(-1).args[0].request, 'original pending goal');
  const readyProject = await new ProjectFormationService(projects, tasks).ensureFormation(buildProjectFormationReceipt({ formationId: 'shell-ready-ui', project: { goal: '待启动的界面验收任务', workspace: temp },
    initialRoot: { goal: '读取说明并验证结果', plane: 'cognition', missionType: 'project-goal', completionCriteria: ['verified'] }, authorization: { kind: 'clear-intent-cognition' } }));
  await dispatch({ type: 'selectProject', projectId: readyProject.project.projectId });
  assert.match(panel.webview.html, /等待启动或继续/);
  assert.doesNotMatch(panel.webview.html, /正在理解与规划/, 'an unfinalized Mission alone must not imply that its Worker is running');
  await capturePreview('ready-work');
  observedLiveWorkers = [{ managedSessionId: 'ui-running-worker', workerId: 'nimora.web-worker', adapterSessionId: 'ui-page', taskId: readyProject.rootMission.taskId, state: 'running' }];
  await dispatch({ type: 'refresh' });
  assert.match(panel.webview.html, /正在理解与规划/);
  await capturePreview('running-work');
  observedLiveWorkers = [];
  assert.deepEqual(uiErrors, ['Nimora 操作失败：UI_TEST_FAILURE </script>'], 'no unexpected host UI errors');
  console.log('PASS actual Product Shell host command, Webview, web-vs-API ingress, connector navigation, degraded/recovery, completed Project next goal and pending recovery smoke');
} finally {
  disposePanel?.();
  registration?.dispose();
  Module._load = originalLoad;
  await fs.rm(temp, { recursive: true, force: true });
}
