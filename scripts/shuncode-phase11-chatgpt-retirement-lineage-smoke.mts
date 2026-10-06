import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const { createChatGptWorkerController } = createRequire(import.meta.url)('../extensions/shuncode-webmcp/chatgpt-worker-controller.js');

const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p11-chatgpt-retirement-task-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p11-chatgpt-retirement-bundle-'));
const bundlePath = path.join(bundleDirectory, 'phase11-chatgpt-retirement.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { TaskRuntime } from './src/task-runtime.ts';
      export { WorkerSessionManager } from './src/worker-session-manager.ts';
      export { MissionWorkerAssignmentService } from './src/worker-assignment.ts';
      export { WebWorkerAdapter } from './src/web-worker-adapter.ts';
      export { ChatGptBrowserCommandTransport } from './extensions/shuncode/src/chatgpt-browser-worker-transport.ts';
      export { ChatGptBrowserWorkerCandidateSource } from './extensions/shuncode/src/chatgpt-browser-worker-candidate-source.ts';
    `,
    resolveDir: root,
    sourcefile: 'phase11-chatgpt-retirement-entry.ts',
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
  TaskRuntime,
  WorkerSessionManager,
  MissionWorkerAssignmentService,
  WebWorkerAdapter,
  ChatGptBrowserCommandTransport,
  ChatGptBrowserWorkerCandidateSource,
} = require(bundlePath);

const WORKER_ID = 'nimora.chatgpt-browser-worker';
const FIRST_PAGE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_PAGE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PROMPT = 'Repair WO1A stable retirement lineage';

function createBrowserHarness() {
  let pageId = FIRST_PAGE_ID;
  let href = 'https://chatgpt.com/';
  let pendingPrompt = '';
  let userMessages: Array<{ key: string; text: string }> = [];
  let assistantMessages: Array<{ key: string; text: string }> = [];
  let responseComplete = false;
  let pendingTerminalObservation = false;

  function snapshot() {
    const blocks: string[] = [];
    for (const message of userMessages) {
      blocks.push(
        `  - heading "You said:" [level=4] [ref=${message.key}-heading]`,
        `  - generic [ref=${message.key}]: ${JSON.stringify(message.text)}`,
        '  - group "Your message actions"',
      );
    }
    for (const message of assistantMessages) {
      blocks.push(
        `  - heading "ChatGPT said:" [level=4] [ref=${message.key}-heading]`,
        `  - paragraph [ref=${message.key}]: ${JSON.stringify(message.text)}`,
        '  - group "Response actions"',
      );
    }
    blocks.push(
      '  - textbox "Message ChatGPT" [active] [ref=composer]',
      `    - paragraph: ${JSON.stringify(pendingPrompt || 'Message ChatGPT')}`,
      '  - generic [ref=actions]',
      '    - button "Model" [ref=model] [cursor=pointer]',
      '      - generic: High',
    );
    if (pendingPrompt) blocks.push('    - button [ref=send] [cursor=pointer]', '      - img');
    if (!pendingPrompt) blocks.push('    - button "Start dictation" [ref=dictation] [cursor=pointer]');
    if (responseComplete) blocks.push('  - status [ref=response-complete]: Response complete');
    return `Page Title: ChatGPT\nURL: ${href}\nSnapshot:\n${blocks.join('\n')}`;
  }

  return {
    async invokeBrowserTool(name: string, input: Record<string, any> = {}) {
      if (name === 'list_browser_pages') return { text: `- [${pageId}] ChatGPT (${href}) visible` };
      if (name === 'read_page') {
        const text = snapshot();
        if (pendingTerminalObservation) {
          pendingTerminalObservation = false;
          responseComplete = true;
        }
        return { text };
      }
      if (name === 'type_in_page') {
        if (typeof input.text === 'string') pendingPrompt = input.text;
        if (input.key === 'Enter') throw new Error('Retirement smoke must not rely on Enter submit');
        return { text: snapshot() };
      }
      if (name === 'click_element') {
        if (input.ref === 'send' && pendingPrompt) {
          const admitted = pendingPrompt;
          pendingPrompt = '';
          href = 'https://chatgpt.com/c/conversation-A';
          userMessages.push({ key: `user-${userMessages.length + 1}`, text: admitted });
          assistantMessages.push({ key: `assistant-${assistantMessages.length + 1}`, text: 'RETIREMENT_LINEAGE_READY' });
          responseComplete = false;
          pendingTerminalObservation = true;
        }
        return { text: snapshot() };
      }
      throw new Error(`Unexpected browser tool: ${name}`);
    },
    async observeExactComposer(page: { pageId?: string; url?: string }) {
      const exactHref = String(page?.url || href);
      return {
        href: exactHref,
        origin: new URL(exactHref).origin,
        composerFound: true,
        composerAmbiguous: false,
        composerText: pendingPrompt,
      };
    },
    async observeExactProviderUsers(page: { pageId?: string; url?: string }) {
      const exactHref = String(page?.url || href);
      return {
        href: exactHref,
        origin: new URL(exactHref).origin,
        providerUserRepresentationVersion: 2,
        providerUsersAmbiguous: false,
        userTurns: userMessages.map((message, index) => ({
          identity: `retirement-user-${index}`,
          text: message.text,
          lineTags: message.text.split('\n').map(() => 'USER_TEXT'),
        })),
      };
    },
    current() { return { pageId, href }; },
    moveToFreshPageGeneration() {
      pageId = NEW_PAGE_ID;
      href = 'https://chatgpt.com/';
      pendingPrompt = '';
      userMessages = [];
      assistantMessages = [];
      responseComplete = false;
      pendingTerminalObservation = false;
    },
  };
}

function controllerFor(browser: ReturnType<typeof createBrowserHarness>) {
  let tick = 0;
  return createChatGptWorkerController({
    invokeBrowserTool: browser.invokeBrowserTool,
    ensureExactPageVisible: async ({ pageId, expectedUrl, expectedOrigin }: any) => {
      const current = browser.current();
      assert.equal(pageId, current.pageId);
      assert.equal(expectedUrl, current.href);
      assert.equal(expectedOrigin, new URL(current.href).origin);
      return { pageId: current.pageId, title: 'ChatGPT', url: current.href, visible: true };
    },
    observeExactComposer: browser.observeExactComposer,
    observeExactProviderUsers: browser.observeExactProviderUsers,
    getSiteAdapterSource: () => '(function fakeSite(){ return {}; })',
    resultText: (result: any) => String(result?.text || ''),
    structuredValue: (result: any) => result?.value,
    now: () => 1_000 + (++tick * 2_000),
  });
}

function commandsFor(controller: any) {
  return {
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
        default: throw new Error(`Unexpected ChatGPT command: ${command}`);
      }
    },
  };
}

async function buildOwners(tasks: any, browser: ReturnType<typeof createBrowserHarness>) {
  const controller = controllerFor(browser);
  const commands = commandsFor(controller);
  const workers = new WorkerSessionManager({ taskBindings: tasks, executionProjection: tasks });
  const transport = new ChatGptBrowserCommandTransport(commands, { pollIntervalMs: 1 });
  await workers.register(new WebWorkerAdapter(transport, WORKER_ID));
  const candidates = new ChatGptBrowserWorkerCandidateSource(workers, commands);
  const assignments = new MissionWorkerAssignmentService(tasks, workers, [candidates]);
  return { controller, commands, workers, candidates, assignments };
}

try {
  const browser = createBrowserHarness();
  const tasks = new TaskRuntime({ storageDirectory: taskDirectory });
  await tasks.initialize();
  const task = await tasks.ensureTask({ kind: 'mission', key: 'phase11-chatgpt-retirement-lineage' }, 'Phase 11 ChatGPT retirement lineage');
  await tasks.configureMission(task.taskId, {
    projectId: 'phase11-retirement-project',
    rootMissionId: task.taskId,
    plane: 'practice',
    missionType: 'phase11-chatgpt-retirement-lineage',
    completionCriteria: ['Stable provider lifecycle retirement lineage'],
  });

  const firstOwners = await buildOwners(tasks, browser);
  const preConversationResources = await firstOwners.controller.listResources();
  assert.equal(preConversationResources.length, 1);
  const preConversation = preConversationResources[0];

  const assignment = await firstOwners.assignments.assignInitial({
    projectId: 'phase11-retirement-project',
    rootMissionId: task.taskId,
    missionId: task.taskId,
    constraints: { allowedKinds: ['web'], allowedProviders: ['openai-chatgpt'] },
    preferences: { providerOrder: ['openai-chatgpt'] },
  });
  const managed = firstOwners.workers.getSession(assignment.managedSessionId);
  assert.ok(managed);
  assert.equal(managed.adapterSessionId, preConversation.lifecycleIdentity, 'adapterSessionId must be the stable page-generation lifecycle identity');
  assert.notEqual(managed.adapterSessionId, preConversation.resourceIdentity, 'observation identity must remain distinct from lifecycle identity');

  let terminal: any;
  for await (const event of firstOwners.workers.send(assignment.managedSessionId, { inputId: 'repair-turn-1', prompt: PROMPT })) {
    if (event.type === 'terminal') terminal = event;
  }
  assert.equal(terminal?.status, 'completed');
  assert.equal(terminal?.result?.text, 'RETIREMENT_LINEAGE_READY');
  assert.equal(browser.current().href, 'https://chatgpt.com/c/conversation-A');

  const health = await firstOwners.controller.control({
    action: 'health',
    pageId: FIRST_PAGE_ID,
    sessionId: managed.adapterSessionId,
  });
  assert.equal(health.observation.conversationId, 'conversation-A');
  assert.notEqual(health.observation.resourceIdentity, preConversation.resourceIdentity, 'conversation creation must evolve observation identity');
  assert.equal(health.observation.lifecycleIdentity, preConversation.lifecycleIdentity, 'conversation creation must not mint a new lifecycle identity');

  const retired = await firstOwners.workers.retire(assignment.managedSessionId, { reason: 'repair-wo1a-proof' });
  assert.equal(retired.adapterSessionId, preConversation.lifecycleIdentity);
  const durable = tasks.getTask(task.taskId)?.workerSessions[assignment.managedSessionId];
  assert.equal(durable?.adapterSessionId, preConversation.lifecycleIdentity);
  assert.ok(durable?.retiredAt);

  const rediscoveredAfterRetire = await firstOwners.candidates.enumerateCandidates();
  assert.deepEqual(rediscoveredAfterRetire, [], 'same retired page generation/conversation must be rejected even after observation identity evolved');

  await tasks.flush();
  const restartedTasks = new TaskRuntime({ storageDirectory: taskDirectory });
  await restartedTasks.initialize();
  const restartedOwners = await buildOwners(restartedTasks, browser);
  assert.equal(await restartedOwners.workers.isAdapterSessionRetired(WORKER_ID, preConversation.lifecycleIdentity), true, 'fresh Worker owners must reconstruct durable retirement truth');
  const rediscoveredAfterRestart = await restartedOwners.candidates.enumerateCandidates();
  assert.deepEqual(rediscoveredAfterRestart, [], 'same retired provider lineage must remain rejected after owner reconstruction');

  browser.moveToFreshPageGeneration();
  const freshGenerationCandidates = await restartedOwners.candidates.enumerateCandidates();
  assert.equal(freshGenerationCandidates.length, 1, 'a genuinely new browser page generation must remain admissible');
  const freshResource = (await restartedOwners.controller.listResources())[0];
  assert.notEqual(freshResource.lifecycleIdentity, preConversation.lifecycleIdentity);

  console.log(JSON.stringify({
    result: 'PASS',
    initialResourceIdentityEvolved: true,
    lifecycleIdentityStable: true,
    retiredSameLineageRejected: true,
    restartDurability: true,
    newPageGenerationAdmissible: true,
  }, null, 2));
} finally {
  await fs.rm(taskDirectory, { recursive: true, force: true });
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
