import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const { createChatGptWorkerController } = require('../extensions/shuncode-webmcp/chatgpt-worker-controller.js');

const browserBridge = String(process.env.SHUNCODE_INTEGRATED_BROWSER_BRIDGE || 'http://127.0.0.1:48322').replace(/\/$/, '');
const expectedChatGptPageId = String(process.env.PHASE11_CHATGPT_PAGE_ID || '').trim();
const nativeMcpAvailable = /^(?:1|true|yes)$/i.test(String(process.env.PHASE11_CHATGPT_NATIVE_MCP_AVAILABLE || '').trim());
const manifestPath = path.join(os.tmpdir(), 'nimora-phase11-live-provider-current.json');
const controlPath = path.join(os.tmpdir(), 'nimora-phase11-live-provider-control.json');
await fs.rm(manifestPath, { force: true });
await fs.rm(controlPath, { force: true });
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p11-live-bundle-'));
const projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p11-live-project-'));
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p11-live-task-'));
const workspaceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p11-live-workspace-'));
const bundlePath = path.join(bundleDirectory, 'phase11-live.cjs');
const vscodeStubPath = path.join(bundleDirectory, 'vscode-stub.mjs');
const siteAdapterSource = (await fs.readFile(path.join(root, 'extensions', 'shuncode-webmcp', 'webmcp-site-adapters.js'), 'utf8')).trim();

await fs.writeFile(path.join(workspaceDirectory, 'README.md'), 'PHASE11_LIVE_NATIVE_MCP_SENTINEL\n', 'utf8');
await fs.writeFile(vscodeStubPath, `
export const ExtensionMode = Object.freeze({ Production: 1, Development: 2, Test: 3 });
export const ConfigurationTarget = Object.freeze({ Global: 1, Workspace: 2, WorkspaceFolder: 3 });
export class CancellationTokenSource {
  constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }; }
  cancel() { this.token.isCancellationRequested = true; }
  dispose() {}
}
const values = new Map();
export const workspace = {
  workspaceFolders: [{ uri: { fsPath: process.env.PHASE11_LIVE_WORKSPACE_ROOT || process.cwd() } }],
  getConfiguration(section) {
    return {
      get(key, fallback) {
        const exact = section + '.' + key;
        if (values.has(exact)) return values.get(exact);
        if (exact === 'shuncode.bridge.tunnelProvider') return 'cloudflare';
        if (exact === 'http.proxySupport') return 'on';
        return fallback;
      },
      async update(key, value) { values.set(section + '.' + key, value); },
    };
  },
};
`, 'utf8');

await esbuild.build({
  stdin: {
    contents: `
      export { ProjectStore } from './src/project-store.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
      export { WorkerSessionManager } from './src/worker-session-manager.ts';
      export { MissionWorkerAssignmentService } from './src/worker-assignment.ts';
      export { WebWorkerAdapter } from './src/web-worker-adapter.ts';
      export { MissionCapabilityMaterializer } from './src/mission-capability-materializer.ts';
      export { HostCapabilityExecutionCoordinator } from './src/host-capability-execution-coordinator.ts';
      export { TaskHostCapabilityExecutionStore } from './src/task-host-capability-execution-store.ts';
      export { CapabilityMetadataHostAuthorizer } from './src/host-capability-policy-authorizer.ts';
      export { TaskCapabilityGrantResolver } from './src/task-capability-grant-resolver.ts';
      export { FileToolHostCapabilityExecutor } from './src/file-host-capability-executor.ts';
      export { ChatGptBrowserCommandTransport } from './extensions/shuncode/src/chatgpt-browser-worker-transport.ts';
      export { ChatGptBrowserWorkerCandidateSource } from './extensions/shuncode/src/chatgpt-browser-worker-candidate-source.ts';
      export { SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES, shunCodeMissionCapabilityExecutionRoutes } from './extensions/shuncode/src/bridge-task-tool-definitions.ts';
      export { MissionNativeMcpBindingService } from './extensions/shuncode/src/mission-native-mcp-binding.ts';
      export { BridgeManager } from './extensions/shuncode/src/bridge-server.ts';
    `,
    resolveDir: root,
    sourcefile: 'phase11-live-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node22'],
  logLevel: 'silent',
  plugins: [{
    name: 'phase11-vscode-stub',
    setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: vscodeStubPath }));
    },
  }],
});

const production = require(bundlePath);
const {
  ProjectStore,
  TaskRuntime,
  WorkerSessionManager,
  MissionWorkerAssignmentService,
  WebWorkerAdapter,
  MissionCapabilityMaterializer,
  HostCapabilityExecutionCoordinator,
  TaskHostCapabilityExecutionStore,
  CapabilityMetadataHostAuthorizer,
  TaskCapabilityGrantResolver,
  FileToolHostCapabilityExecutor,
  ChatGptBrowserCommandTransport,
  ChatGptBrowserWorkerCandidateSource,
  SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES,
  shunCodeMissionCapabilityExecutionRoutes,
  MissionNativeMcpBindingService,
  BridgeManager,
} = production;

function textOf(result: any): string {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content.map((part: any) => typeof part?.text === 'string' ? part.text : typeof part?.value === 'string' ? part.value : '').join('\n');
}

function structuredValue(result: any, label = 'browser result'): any {
  const line = textOf(result).split(/\r?\n/).find(value => value.startsWith('Result: '));
  if (!line) throw new Error(`${label} did not return Result JSON.`);
  return JSON.parse(line.slice('Result: '.length));
}

let browserToolSequence = 0;

async function invokeBrowserTool(name: string, input: Record<string, unknown> = {}): Promise<any> {
  const traceId = ++browserToolSequence;
  const startedAt = Date.now();
  console.error('PHASE11_TRACE browserToolStart', JSON.stringify({ traceId, name, pageId: input.pageId }));
  const response = await fetch(`${browserBridge}/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, input }),
    // The Integrated Browser HTTP wrapper also serializes an accessibility
    // snapshot after the Playwright result. Large authenticated ChatGPT pages
    // can make that wrapper substantially slower than the page-side timeout.
    // Keep the production page execution timeout unchanged; only avoid falsely
    // classifying a valid shared page as disappeared at this probe boundary.
    signal: AbortSignal.timeout(120_000),
  });
  const body = await response.json() as any;
  console.error('PHASE11_TRACE browserToolEnd', JSON.stringify({
    traceId,
    name,
    status: response.status,
    ok: body?.ok === true,
    elapsedMs: Date.now() - startedAt,
    resultChars: textOf(body?.result).length,
  }));
  if (!response.ok || body?.ok !== true) {
    if (name === 'activate_browser_page' && /unsupported browser tool|not registered/i.test(String(body?.error || ''))) {
      const pageId = String(input.pageId || '').trim();
      const pages = await invokeBrowserTool('list_browser_pages');
      const active = textOf(pages).split(/\r?\n/).some(line => line.includes(`[${pageId}]`) && /\(active\)\s*$/.test(line));
      if (active) {
        console.log('PHASE11_TRACE activationCompat', JSON.stringify({ pageId, reason: 'old runtime lacks activate_browser_page; exact page already active' }));
        return { content: [{ text: `Exact shared browser page already active: ${pageId}` }] };
      }
    }
    console.log('PHASE11_TRACE browserToolError', JSON.stringify({ name, status: response.status, body }));
    throw new Error(`Integrated Browser ${name} failed: ${JSON.stringify(body)}`);
  }
  return body.result;
}

async function ensureExactLivePageVisible({ pageId, expectedUrl, expectedOrigin, label = 'ChatGPT live probe page' }: any) {
  const exactPageId = String(pageId || '').trim();
  const parseExact = (result: any) => {
    const line = textOf(result).split(/\r?\n/).find((entry: string) => entry.includes(`[${exactPageId}]`));
    if (!line) return undefined;
    const match = line.match(/\((https?:\/\/[^)]+)\)(.*)$/i);
    if (!match) return undefined;
    return { pageId: exactPageId, title: 'ChatGPT', url: match[1], visible: !/not visible/i.test(match[2] || '') };
  };
  const before = parseExact(await invokeBrowserTool('list_browser_pages'));
  if (!before) throw new Error(`${label} disappeared before provider mutation: ${exactPageId}`);
  if (expectedUrl && before.url !== String(expectedUrl)) throw new Error(`${label} URL changed before provider mutation: ${before.url}`);
  if (expectedOrigin && new URL(before.url).origin !== String(expectedOrigin)) throw new Error(`${label} origin changed before provider mutation: ${before.url}`);
  if (before.visible) return before;
  await invokeBrowserTool('activate_browser_page', { pageId: exactPageId });
  const after = parseExact(await invokeBrowserTool('list_browser_pages'));
  if (!after || !after.visible) throw new Error(`${label} did not become visible after exact-page activation: ${exactPageId}`);
  if (after.url !== before.url) throw new Error(`${label} URL changed during exact-page activation: ${after.url}`);
  return after;
}

const controller = createChatGptWorkerController({
  invokeBrowserTool,
  ensureExactPageVisible: ensureExactLivePageVisible,
  getSiteAdapterSource: () => siteAdapterSource,
  resultText: textOf,
  structuredValue,
});

const commands = {
  async executeCommand(command: string, arg?: any) {
    switch (command) {
      case '_shuncode.chatgptWorker.listResources': return controller.listResources();
      case '_shuncode.chatgptWorker.probeResource': return controller.probeResource(arg?.pageId);
      case '_shuncode.chatgptWorker.connect': return controller.connect(arg);
      case '_shuncode.chatgptWorker.send': return controller.control({ ...arg, action: 'send' });
      case '_shuncode.chatgptWorker.poll': return controller.control({ ...arg, action: 'poll' });
      case '_shuncode.chatgptWorker.interrupt': return controller.control({ ...arg, action: 'interrupt' });
      case '_shuncode.chatgptWorker.health': return controller.control({ ...arg, action: 'health' });
      case '_shuncode.chatgptWorker.disconnect': return controller.control({ ...arg, action: 'disconnect' });
      default: throw new Error(`Unsupported live-probe command: ${command}`);
    }
  },
};

const resources = await controller.listResources();
const resource = expectedChatGptPageId
  ? resources.find((item: any) => item.pageId === expectedChatGptPageId)
  : resources.length === 1 ? resources[0] : undefined;
assert.ok(resource, `Expected shared ChatGPT page is not an available resource. Seen: ${JSON.stringify(resources)}`);
assert.equal(resource.ready, true, 'Shared ChatGPT page must be ready before assignment.');

const projects = new ProjectStore({ storageDirectory: projectDirectory });
const tasks = new TaskRuntime({ storageDirectory: taskDirectory });
await Promise.all([projects.initialize(), tasks.initialize()]);
const project = await projects.createProject({ title: 'Phase 11 live provider verification' });
const rootTask = await tasks.ensureTask({ kind: 'mission', key: 'phase11-live-provider' }, 'Phase 11 live provider verification.');
const mission = await tasks.configureMission(rootTask.taskId, {
  projectId: project.projectId,
  rootMissionId: rootTask.taskId,
  plane: 'practice',
  missionType: 'phase11-live-provider',
  completionCriteria: ['Verify real ChatGPT browser Worker and Mission-native MCP route.'],
});

const workers = new WorkerSessionManager({ taskBindings: tasks, executionProjection: tasks });
const chatGptTransport = new ChatGptBrowserCommandTransport(commands, {
  pollIntervalMs: 350,
  capabilityProjection: () => nativeMcpAvailable
    ? {
        nativeByName: true,
        externalDefinitions: false,
        executionRoutes: shunCodeMissionCapabilityExecutionRoutes(
          'native-by-name',
          'chatgpt-native-mcp',
          'Explicit live gate for the exact ChatGPT Mission-native MCP route.',
        ),
      }
    : { nativeByName: false, externalDefinitions: false, executionRoutes: [] },
});
await workers.register(new WebWorkerAdapter(chatGptTransport, 'nimora.chatgpt-browser-worker'));
const chatGptCandidates = new ChatGptBrowserWorkerCandidateSource(workers, commands);
const tracedChatGptCandidates = {
  async enumerateCandidates() {
    const value = await chatGptCandidates.enumerateCandidates();
    console.error('PHASE11_TRACE enumerateCandidates', JSON.stringify(value));
    return value;
  },
  async refreshCandidate(candidate: any) {
    const value = await chatGptCandidates.refreshCandidate(candidate);
    console.error('PHASE11_TRACE refreshCandidate', JSON.stringify({ before: candidate, after: value }));
    return value;
  },
  async materializeSessionOptions(candidate: any, selection: any) {
    const value = await chatGptCandidates.materializeSessionOptions(candidate, selection);
    console.error('PHASE11_TRACE materializeSessionOptions', JSON.stringify(value));
    return value;
  },
};
const originalRefresh = workers.refresh.bind(workers);
workers.refresh = async (workerId: string) => {
  const value = await originalRefresh(workerId);
  console.error('PHASE11_TRACE workerRefresh', JSON.stringify(value));
  return value;
};
const assignments = new MissionWorkerAssignmentService(tasks, workers, [tracedChatGptCandidates]);
const assignment = await assignments.assignInitial({
  projectId: project.projectId,
  rootMissionId: mission.taskId,
  missionId: mission.taskId,
  constraints: { allowedKinds: ['web'], allowedProviders: ['openai-chatgpt'] },
  preferences: { providerOrder: ['openai-chatgpt'] },
});
assert.equal(assignment.candidateId, `chatgpt:${resource.resourceIdentity}`);

const firstInputId = `phase11-live-browser-${Date.now()}`;
let firstTerminal: any;
let firstText = '';
for await (const event of workers.send(assignment.managedSessionId, {
  inputId: firstInputId,
  prompt: 'Phase 11 live Worker transport verification. Reply exactly: PHASE11_CHATGPT_WORKER_READY',
})) {
  if (event.type === 'text_delta') firstText += event.text;
  if (event.type === 'terminal') firstTerminal = event;
}
assert.equal(firstTerminal?.status, 'completed', `Real ChatGPT Worker turn did not complete: ${JSON.stringify(firstTerminal)}`);
const health = await controller.control({
  action: 'health',
  pageId: resource.pageId,
  sessionId: workers.getSession(assignment.managedSessionId).adapterSessionId,
});
assert.equal(health?.observation?.ready, true);

if (!nativeMcpAvailable) {
  const evidence = {
    result: 'PASS',
    state: 'BROWSER_WORKER_COMPLETE_NATIVE_MCP_UNAVAILABLE',
    browserBridge,
    pageId: resource.pageId,
    resourceIdentity: resource.resourceIdentity,
    pageUrl: health.observation.href,
    conversationId: health.observation.conversationId,
    managedSessionId: assignment.managedSessionId,
    firstWorkerTurn: { inputId: firstInputId, terminal: firstTerminal, text: firstText },
    nativeMcpAvailable: false,
  };
  console.log('PHASE11_LIVE_BROWSER_ONLY');
  console.log(JSON.stringify(evidence, null, 2));
  await workers.retire(assignment.managedSessionId, { reason: 'Phase 11 live browser Worker evidence complete; native MCP live gate unavailable.' });
  for (const directory of [bundleDirectory, projectDirectory, taskDirectory, workspaceDirectory]) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  process.exit(0);
}

const materializer = new MissionCapabilityMaterializer(projects, tasks, workers, SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES);
async function materializeCapability() {
  return await materializer.materialize({
    projectId: project.projectId,
    rootMissionId: mission.taskId,
    missionId: mission.taskId,
    managedSessionId: assignment.managedSessionId,
    budget: { maxSchemaChars: 100_000 },
    constraints: { profile: 'research', requiredCapabilityIds: ['workspace.read-files'] },
    generatedAt: new Date().toISOString(),
  });
}
const capability = await materializeCapability();
assert.ok(capability.allowedCapabilities.includes('read_files'));

const execution = new HostCapabilityExecutionCoordinator({
  durableStore: new TaskHostCapabilityExecutionStore(tasks),
  authorizer: new CapabilityMetadataHostAuthorizer(new TaskCapabilityGrantResolver(tasks)),
  executor: new FileToolHostCapabilityExecutor({ workspaceRoots: () => [workspaceDirectory] }),
});
const nativeMcp = new MissionNativeMcpBindingService(
  tasks,
  workers,
  execution,
  SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES,
  'nimora.chatgpt-browser-worker',
);
const binding = await nativeMcp.prepareAdvertisement({
  projectId: project.projectId,
  rootMissionId: mission.taskId,
  missionId: mission.taskId,
  managedSessionId: assignment.managedSessionId,
  capability,
});

const secretState = new Map<string, string>();
const globalState = new Map<string, any>();
const context = {
  extensionMode: 2,
  extension: { packageJSON: { version: 'phase11-live-probe' } },
  secrets: {
    async get(key: string) { return secretState.get(key); },
    async store(key: string, value: string) { secretState.set(key, value); },
    async delete(key: string) { secretState.delete(key); },
  },
  globalState: {
    get(key: string, fallback?: any) { return globalState.has(key) ? globalState.get(key) : fallback; },
    async update(key: string, value: any) { if (value === undefined) globalState.delete(key); else globalState.set(key, value); },
  },
};
const output = {
  append(value: string) { process.stderr.write(`[bridge] ${value}`); },
  appendLine(value: string) { process.stderr.write(`[bridge] ${value}\n`); },
};
const unusedBroker = new Proxy({}, { get: () => () => { throw new Error('Global Bridge tool execution is forbidden in the Phase 11 live probe.'); } });
const unusedTaskShadow = new Proxy({}, { get: () => () => { throw new Error('Global Bridge Task shadow is forbidden in the Phase 11 live probe.'); } });
process.env.PHASE11_LIVE_WORKSPACE_ROOT = workspaceDirectory;
const bridge = new BridgeManager(context, output, unusedBroker, unusedTaskShadow, async () => undefined, nativeMcp);
await bridge.initialize();
const bridgeStatus = await bridge.start();
const urls = bridge.getMissionNativeMcpUrls(binding.token);
assert.ok(urls.publicUrl?.startsWith('https://'), `Public Mission MCP URL unavailable: ${JSON.stringify(bridgeStatus)}`);

let commandSequence = 0;
async function writeManifest(extra: Record<string, unknown> = {}) {
  await fs.writeFile(manifestPath, JSON.stringify({
    state: 'READY_FOR_HUMAN_MCP_INSTALLATION',
    pid: process.pid,
    browserBridge,
    pageId: resource.pageId,
    resourceIdentity: resource.resourceIdentity,
    pageUrl: health.observation.href,
    conversationId: health.observation.conversationId,
    projectId: project.projectId,
    missionId: mission.taskId,
    managedSessionId: assignment.managedSessionId,
    adapterSessionId: workers.getSession(assignment.managedSessionId).adapterSessionId,
    advertisedCapabilities: binding.advertisedCapabilities,
    missionMcpPublicUrl: urls.publicUrl,
    missionMcpLocalUrl: urls.localUrl,
    firstWorkerTurn: { inputId: firstInputId, terminal: firstTerminal, text: firstText },
    controlPath,
    ...extra,
  }, null, 2), 'utf8');
}
await fs.rm(controlPath, { force: true });
await writeManifest();
console.log(`PHASE11_LIVE_READY ${manifestPath}`);
console.log(JSON.stringify({
  state: 'READY_FOR_HUMAN_MCP_INSTALLATION',
  pageId: resource.pageId,
  pageUrl: health.observation.href,
  managedSessionId: assignment.managedSessionId,
  advertisedCapabilities: binding.advertisedCapabilities,
  missionMcpPublicUrl: urls.publicUrl,
}, null, 2));

let stopping = false;
async function cleanup(reason: string) {
  if (stopping) return;
  stopping = true;
  try { await bridge.stop(); } catch {}
  try { await workers.retire(assignment.managedSessionId, { reason }); } catch {}
  try { await fs.rm(manifestPath, { force: true }); } catch {}
  try { await fs.rm(controlPath, { force: true }); } catch {}
  for (const directory of [bundleDirectory, projectDirectory, taskDirectory, workspaceDirectory]) {
    try { await fs.rm(directory, { recursive: true, force: true }); } catch {}
  }
}

process.on('SIGINT', () => { void cleanup('SIGINT').finally(() => process.exit(0)); });
process.on('SIGTERM', () => { void cleanup('SIGTERM').finally(() => process.exit(0)); });

while (!stopping) {
  await new Promise(resolve => setTimeout(resolve, 500));
  let control: any;
  try { control = JSON.parse(await fs.readFile(controlPath, 'utf8')); } catch { continue; }
  if (!control || control.sequence === commandSequence) continue;
  commandSequence = control.sequence;
  if (control.command === 'stop') {
    await cleanup('Phase 11 live probe completed.');
    break;
  }
  if (control.command !== 'activate-native-turn') continue;
  const inputId = `phase11-live-native-${Date.now()}`;
  try {
    const freshCapability = await materializeCapability();
    await nativeMcp.activateTurn({
      projectId: project.projectId,
      rootMissionId: mission.taskId,
      missionId: mission.taskId,
      managedSessionId: assignment.managedSessionId,
      inputId,
      capability: freshCapability,
    });
    let text = '';
    let terminal: any;
    for await (const event of workers.send(assignment.managedSessionId, {
      inputId,
      prompt: 'Use the connected Nimora MCP tool read_files to read README.md. After the tool result arrives, reply with PHASE11_NATIVE_MCP_READ_OK and the first line you read. Do not answer from memory; use the tool.',
      allowedCapabilities: [...freshCapability.allowedCapabilities],
    })) {
      if (event.type === 'text_delta') text += event.text;
      if (event.type === 'terminal') terminal = event;
    }
    const durable = tasks.getTask(mission.taskId);
    const nativeExecutions = Object.values(durable.executions).filter((item: any) => item.executionId.startsWith(`native-mcp:${assignment.managedSessionId}:${inputId}:`));
    await writeManifest({
      state: 'NATIVE_TURN_COMPLETE',
      nativeTurn: { inputId, terminal, text, executionCount: nativeExecutions.length, executions: nativeExecutions },
    });
  } catch (error) {
    await writeManifest({
      state: 'NATIVE_TURN_ERROR',
      nativeTurn: { inputId, error: error instanceof Error ? error.message : String(error) },
    });
  } finally {
    nativeMcp.clearTurn(assignment.managedSessionId, inputId);
    await fs.rm(controlPath, { force: true });
  }
}
