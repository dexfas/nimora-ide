import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const resourceHelpers = require(path.join(root, 'extensions', 'shuncode-webmcp', 'worker-page-resources.js'));
const siteAdapterSource = await fs.readFile(path.join(root, 'extensions', 'shuncode-webmcp', 'webmcp-site-adapters.js'), 'utf8');
const resourceHelperSource = await fs.readFile(path.join(root, 'extensions', 'shuncode-webmcp', 'worker-page-resources.js'), 'utf8');
const extensionSource = await fs.readFile(path.join(root, 'extensions', 'shuncode-webmcp', 'extension.js'), 'utf8');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-webmcp-candidates-bundle-'));
const bundlePath = path.join(bundleDirectory, 'webmcp-candidates.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { TaskRuntime } from './src/task-runtime.ts';
      export { WorkerSessionManager } from './src/worker-session-manager.ts';
      export { MissionWorkerAssignmentService, WorkerAssignmentCreateFailedError, WorkerAssignmentNoAdmissibleCandidateError } from './src/worker-assignment.ts';
      export { WebWorkerAdapter } from './src/web-worker-adapter.ts';
      export { WebMcpCommandTransport } from './extensions/shuncode/src/webmcp-worker-transport.ts';
      export { WebMcpWorkerAssignmentCandidateSource } from './extensions/shuncode/src/webmcp-worker-candidate-source.ts';
    `,
    resolveDir: root,
    sourcefile: 'webmcp-worker-candidate-entry.ts',
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
  WorkerAssignmentCreateFailedError,
  WorkerAssignmentNoAdmissibleCandidateError,
  WebWorkerAdapter,
  WebMcpCommandTransport,
  WebMcpWorkerAssignmentCandidateSource,
} = require(bundlePath);

function observedPage({ pageId, url, visible = false, site = 'generic', composerFound = true, auth = false, sessionId = '', runtimeVersion = 25, workerTurnState = '' }) {
  return resourceHelpers.normalizeObservedResource(
    { pageId, title: `Page ${pageId.slice(0, 4)}`, url, visible },
    {
      href: url,
      origin: new URL(url).origin,
      site,
      composerFound,
      isDeepSeekAuthPage: auth,
      runtimeVersion,
      runtimeEnabled: true,
      runtimePageSessionId: sessionId,
      storedPageSessionId: sessionId,
      workerTurnState,
    },
    false,
  );
}

function changedSession(resource, sessionId) {
  return observedPage({
    pageId: resource.pageId,
    url: resource.href,
    visible: resource.visible,
    site: resource.site,
    composerFound: resource.composerFound,
    auth: resource.isDeepSeekAuthPage,
    sessionId,
    runtimeVersion: resource.runtimeVersion,
    workerTurnState: resource.workerTurnState,
  });
}

class FakeWebMcpCommands {
  resources = [];
  calls = [];
  connectCalls = [];
  sendCount = 0;
  disappearOnConnectPageId = '';
  identityChangeOnConnectPageId = '';
  hangList = false;
  hangProbe = false;

  setResources(resources) {
    this.resources = resources.map(resource => structuredClone(resource));
  }

  resource(pageId) {
    return this.resources.find(resource => resource.pageId === pageId);
  }

  async executeCommand(command, arg) {
    this.calls.push({ command, arg: structuredClone(arg) });
    if (command === '_shuncode.webMcp.workerListResources') {
      if (this.hangList) return await new Promise(() => {});
      return structuredClone(this.resources);
    }
    if (command === '_shuncode.webMcp.workerProbeResource') {
      if (this.hangProbe) return await new Promise(() => {});
      return structuredClone(this.resource(arg.pageId));
    }
    if (command === '_shuncode.webMcp.workerConnect') {
      const target = arg?.target;
      this.connectCalls.push(structuredClone(target));
      if (target?.pageId === this.disappearOnConnectPageId) throw new Error(`Selected WebMCP page disappeared: ${target.pageId}`);
      const current = this.resource(target?.pageId);
      if (!current) throw new Error(`Selected WebMCP page disappeared: ${target?.pageId}`);
      if (target?.pageId === this.identityChangeOnConnectPageId) throw new Error(`Selected WebMCP page identity changed: ${target.pageId}`);
      if (target?.resourceIdentity !== current.resourceIdentity) throw new Error(`Selected WebMCP page identity changed: ${target.pageId}`);
      return {
        pageId: current.pageId,
        sessionId: current.pageSessionId || `session:${current.resourceIdentity.slice(0, 16)}`,
        site: current.site,
        origin: current.origin,
        href: current.href,
        transport: 'http',
        status: { version: 25, enabled: true, composerFound: true, isDeepSeekAuthPage: false },
      };
    }
    if (command === '_shuncode.webMcp.workerHealth') return { status: { enabled: true, composerFound: true, isDeepSeekAuthPage: false } };
    if (command === '_shuncode.webMcp.workerDisconnect') return { disconnected: true };
    if (command === '_shuncode.webMcp.workerSend') {
      this.sendCount += 1;
      throw new Error('assignment smoke must not send');
    }
    if (command === '_shuncode.webMcp.workerInterrupt') return { interrupted: true };
    if (command === '_shuncode.webMcp.workerResolve') return { state: 'running', events: [] };
    if (command === '_shuncode.webMcp.workerPoll') return { state: 'completed', inputId: arg.inputId, events: [] };
    throw new Error(`Unexpected WebMCP command: ${command}`);
  }
}

let missionSequence = 0;

async function createMission(tasks, projectId = 'project-webmcp-candidate') {
  const task = await tasks.ensureTask({ kind: 'mission', key: `webmcp-candidate-mission-${++missionSequence}` }, 'WebMCP Candidate Mission');
  await tasks.configureMission(task.taskId, {
    projectId,
    rootMissionId: task.taskId,
    plane: 'practice',
    missionType: 'webmcp-candidate-smoke',
    completionCriteria: ['Exact WebMCP candidate binding is proven'],
  });
  return tasks.getTask(task.taskId);
}

function requestFor(mission, constraints = undefined) {
  return {
    projectId: mission.mission.projectId,
    rootMissionId: mission.mission.rootMissionId,
    missionId: mission.taskId,
    ...(constraints ? { constraints } : {}),
  };
}

const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-webmcp-candidate-task-'));

try {
  // Pure WebMCP resource helpers: bounded page parsing, native bypass and read-only observation shape.
  const listedText = [
    '- [11111111-1111-1111-1111-111111111111] DeepSeek (https://chat.deepseek.com/chat) (not visible)',
    '- [22222222-2222-2222-2222-222222222222] Other AI (https://claude.ai/new) (visible)',
  ].join('\n');
  const parsed = resourceHelpers.parseSharedBrowserPages(listedText);
  assert.deepEqual(parsed.map(page => page.pageId), [
    '11111111-1111-1111-1111-111111111111',
    '22222222-2222-2222-2222-222222222222',
  ]);
  assert.equal(parsed[1].visible, true);
  const readOnlyProbeCode = resourceHelpers.buildReadOnlyProbeCode(siteAdapterSource);
  assert.equal(readOnlyProbeCode.includes('__shuncodeWebMcp.prime()'), false, 'read-only discovery must not prime');
  assert.equal(readOnlyProbeCode.includes('__shuncodeWebMcp?.stop'), false, 'read-only discovery must not stop a runtime');
  assert.equal(readOnlyProbeCode.includes('workerSend('), false, 'read-only discovery must not send a Worker turn');
  assert.equal(/getArenaAgentSource|shunCodeWebMcpComposedAgent/.test(readOnlyProbeCode), false, 'read-only discovery must not inject/reinject the page agent');
  const probeImplementation = resourceHelperSource.slice(
    resourceHelperSource.indexOf('function buildReadOnlyProbeCode'),
    resourceHelperSource.indexOf('function normalizeObservedResource'),
  );
  assert.equal(/assistantMessage|assistantText|document\.body\?\.innerText|provider transcript/i.test(probeImplementation), false, 'read-only probe implementation must not read provider transcript surfaces');

  const bypass = resourceHelpers.normalizeBypassResource({
    pageId: '33333333-3333-3333-3333-333333333333',
    title: 'ChatGPT',
    url: 'https://chatgpt.com/',
    visible: true,
  });
  assert.equal(bypass.nativeMcpBypass, true);
  assert.equal(bypass.ready, false);

  const pageA = observedPage({
    pageId: '11111111-1111-1111-1111-111111111111',
    url: 'https://chat.deepseek.com/chat',
    site: 'deepseek',
    sessionId: 'page-session-A',
  });
  const pageB = observedPage({
    pageId: '22222222-2222-2222-2222-222222222222',
    url: 'https://claude.ai/new',
    site: 'generic',
    visible: true,
    sessionId: 'page-session-B',
  });
  resourceHelpers.assertExactTargetCompatible({ pageId: pageA.pageId, resourceIdentity: pageA.resourceIdentity }, pageA);
  assert.throws(
    () => resourceHelpers.assertExactTargetCompatible({ pageId: pageA.pageId, resourceIdentity: pageA.resourceIdentity }, changedSession(pageA, 'page-session-A2')),
    /identity changed/,
  );

  // Production exact-connect source must resolve the explicit page id and must not use visible/last fallback on the exact path.
  assert.match(extensionSource, /resolveExactWebMcpWorkerPage\(exactTarget\)/);
  assert.match(extensionSource, /find\(item => item\.pageId === pageId\)/);
  assert.match(extensionSource, /const page = exact\?\.page \|\| await getOrShareCurrentBrowserPage\(output\)/);

  const tasks = new TaskRuntime({ storageDirectory: taskDirectory });
  await tasks.initialize();
  const commands = new FakeWebMcpCommands();
  commands.setResources([pageA, pageB, bypass]);
  const transport = new WebMcpCommandTransport(commands, { pollIntervalMs: 1 });
  const adapter = new WebWorkerAdapter(transport);
  let managedSequence = 0;
  const manager = new WorkerSessionManager({ taskBindings: tasks, newId: () => `webmcp-managed-${++managedSequence}` });
  await manager.register(adapter);
  const source = new WebMcpWorkerAssignmentCandidateSource(manager, commands, { now: () => new Date('2026-09-15T13:00:00.000Z') });

  const discovered = await source.enumerateCandidates();
  assert.equal(manager.listWorkers().length, 1, 'multiple Web pages must remain under one stable Worker definition');
  assert.equal(manager.listWorkers()[0].id, 'nimora.web-worker');
  assert.equal(discovered.length, 2, 'two admissible shared pages must become two candidates; native bypass must not');
  assert.equal(new Set(discovered.map(candidate => candidate.candidateId)).size, 2);
  assert.ok(discovered.every(candidate => candidate.workerId === 'nimora.web-worker'));
  assert.ok(discovered.some(candidate => candidate.provider === 'deepseek'));
  assert.ok(discovered.some(candidate => candidate.provider === 'https://claude.ai'));
  assert.equal(discovered.some(candidate => candidate.provider === 'generic'), false, 'generic site label must never become fictional provider identity');
  assert.equal(discovered.some(candidate => candidate.candidateId.includes(pageA.pageId)), false, 'generic candidate id must not expose raw pageId');

  // A freshly shared planning page can have no pageSessionId until its first
  // real connection. Reserve its exact pageId before opening worker pages;
  // otherwise the planner could reappear as a free Coordinator candidate.
  const freshPlanner = observedPage({
    pageId: '44444444-4444-4444-4444-444444444444',
    url: 'https://chat.deepseek.com/chat', site: 'deepseek', sessionId: '',
  });
  assert.equal(freshPlanner.pageSessionId, undefined, 'preconnect page-session identity is legitimately optional');
  const reservedSource = new WebMcpWorkerAssignmentCandidateSource(manager, commands);
  commands.setResources([freshPlanner, pageB, bypass]);
  reservedSource.reservePlanningPage(freshPlanner.pageId);
  const afterReservation = await reservedSource.enumerateCandidates();
  assert.equal(afterReservation.length, 1);
  assert.equal(afterReservation[0].provider, 'https://claude.ai', 'planner must remain excluded without pageSessionId');
  reservedSource.releasePlanningPage(freshPlanner.pageId);
  assert.equal((await reservedSource.enumerateCandidates()).length, 2, 'retired planner must release explicit source reservation');
  commands.setResources([pageA, pageB, bypass]);

  // Select A although B is visible and listed after A. Exact target must remain A.
  const missionA = await createMission(tasks);
  const assignmentA = new MissionWorkerAssignmentService(tasks, manager, [source]);
  const resultA = await assignmentA.assignInitial(requestFor(missionA, { allowedProviders: ['deepseek'] }));
  assert.equal(resultA.workerId, 'nimora.web-worker');
  assert.equal(manager.getSession(resultA.managedSessionId).adapterSessionId, 'page-session-A');
  assert.equal(commands.connectCalls.at(-1).pageId, pageA.pageId, 'visible/last page B must not substitute for selected A');

  const afterA = await new WebMcpWorkerAssignmentCandidateSource(manager, commands).enumerateCandidates();
  assert.equal(afterA.some(candidate => candidate.provider === 'deepseek'), false, 'page-session A owned by another Mission must not be offered again');
  assert.equal(afterA.some(candidate => candidate.provider === 'https://claude.ai'), true);

  // Independent assignment selects B, producing a distinct provider-native session and managed id while sharing workerId.
  const missionB = await createMission(tasks);
  const resultB = await new MissionWorkerAssignmentService(tasks, manager, [new WebMcpWorkerAssignmentCandidateSource(manager, commands)]).assignInitial(
    requestFor(missionB, { allowedProviders: ['https://claude.ai'] }),
  );
  assert.equal(resultB.workerId, 'nimora.web-worker');
  assert.notEqual(resultA.managedSessionId, resultB.managedSessionId);
  assert.notEqual(manager.getSession(resultA.managedSessionId).adapterSessionId, manager.getSession(resultB.managedSessionId).adapterSessionId);
  assert.equal(manager.getSession(resultB.managedSessionId).adapterSessionId, 'page-session-B');
  assert.equal(commands.sendCount, 0, 'discovery/assignment must not send model input');

  // Session generation change invalidates the old resource identity without creating a Mission.
  const pageC = observedPage({
    pageId: '44444444-4444-4444-4444-444444444444',
    url: 'https://example-ai.test/chat',
    site: 'generic',
    sessionId: 'page-session-C1',
  });
  commands.setResources([pageC]);
  const generationSource = new WebMcpWorkerAssignmentCandidateSource(manager, commands, { now: () => new Date('2026-09-15T13:01:00.000Z') });
  const oldGenerationCandidate = (await generationSource.enumerateCandidates())[0];
  const taskCountBeforeGenerationChange = tasks.listTasks().length;
  const pageC2 = changedSession(pageC, 'page-session-C2');
  commands.setResources([pageC2]);
  assert.equal(await generationSource.refreshCandidate(oldGenerationCandidate), undefined, 'old candidate must die when page-session generation changes');
  const newGenerationCandidate = (await generationSource.enumerateCandidates())[0];
  assert.notEqual(oldGenerationCandidate.candidateId, newGenerationCandidate.candidateId);
  assert.equal(tasks.listTasks().length, taskCountBeforeGenerationChange, 'resource generation change must not create a Mission');

  // DeepSeek auth, missing composer, running turn and session-identity mismatch are never fresh healthy candidates.
  const authPage = observedPage({ pageId: '55555555-5555-5555-5555-555555555555', url: 'https://chat.deepseek.com/sign_in', site: 'deepseek', auth: true, sessionId: 'auth-session' });
  const noComposer = observedPage({ pageId: '66666666-6666-6666-6666-666666666666', url: 'https://other-ai.test/chat', site: 'generic', composerFound: false, sessionId: 'no-composer-session' });
  const running = observedPage({ pageId: '77777777-7777-7777-7777-777777777777', url: 'https://running-ai.test/chat', site: 'generic', sessionId: 'running-session', workerTurnState: 'running' });
  const incompatible = resourceHelpers.normalizeObservedResource(
    { pageId: '88888888-8888-8888-8888-888888888888', title: 'Mismatch', url: 'https://mismatch-ai.test/chat', visible: false },
    { href: 'https://mismatch-ai.test/chat', origin: 'https://mismatch-ai.test', site: 'generic', composerFound: true, isDeepSeekAuthPage: false, runtimeVersion: 25, runtimeEnabled: true, runtimePageSessionId: 'runtime-x', storedPageSessionId: 'stored-y', workerTurnState: '' },
    false,
  );
  commands.setResources([authPage, noComposer, running, incompatible, bypass]);
  const unhealthy = await new WebMcpWorkerAssignmentCandidateSource(manager, commands).enumerateCandidates();
  assert.ok(unhealthy.filter(candidate => candidate.availability === 'available').length === 0);
  assert.equal(unhealthy.some(candidate => candidate.candidateId === `webmcp:${incompatible.resourceIdentity}`), false, 'incompatible page/session identity must not be offered');
  assert.equal(unhealthy.some(candidate => candidate.provider === 'generic'), false);

  // Selected A disappears after fresh candidate refresh but before exact connect: fail A, never substitute B.
  const disappearA = observedPage({ pageId: '99999999-9999-9999-9999-999999999999', url: 'https://chat.deepseek.com/chat?d=1', site: 'deepseek', sessionId: 'disappear-A' });
  const fallbackB = observedPage({ pageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', url: 'https://fallback-ai.test/chat', site: 'generic', visible: true, sessionId: 'fallback-B' });
  commands.setResources([disappearA, fallbackB]);
  commands.disappearOnConnectPageId = disappearA.pageId;
  const disappearMission = await createMission(tasks);
  const connectsBeforeDisappear = commands.connectCalls.length;
  await assert.rejects(
    () => new MissionWorkerAssignmentService(tasks, manager, [new WebMcpWorkerAssignmentCandidateSource(manager, commands)]).assignInitial(
      requestFor(disappearMission, { allowedProviders: ['deepseek'] }),
    ),
    error => error instanceof WorkerAssignmentCreateFailedError && /disappeared/.test(error.message),
  );
  const disappearConnects = commands.connectCalls.slice(connectsBeforeDisappear);
  assert.deepEqual(disappearConnects.map(target => target.pageId), [disappearA.pageId], 'disappeared selected page must never connect fallback page B');
  assert.equal(manager.listSessions({ taskId: disappearMission.taskId }).length, 0);
  commands.disappearOnConnectPageId = '';

  // Exact selected resource changes identity between refresh and connect: fail closed without substitution.
  const identityA = observedPage({ pageId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', url: 'https://chat.deepseek.com/chat?identity=1', site: 'deepseek', sessionId: 'identity-A' });
  const identityB = observedPage({ pageId: 'cccccccc-cccc-cccc-cccc-cccccccccccc', url: 'https://identity-fallback.test/chat', site: 'generic', visible: true, sessionId: 'identity-B' });
  commands.setResources([identityA, identityB]);
  commands.identityChangeOnConnectPageId = identityA.pageId;
  const identityMission = await createMission(tasks);
  const connectsBeforeIdentity = commands.connectCalls.length;
  await assert.rejects(
    () => new MissionWorkerAssignmentService(tasks, manager, [new WebMcpWorkerAssignmentCandidateSource(manager, commands)]).assignInitial(
      requestFor(identityMission, { allowedProviders: ['deepseek'] }),
    ),
    error => error instanceof WorkerAssignmentCreateFailedError && /identity changed/.test(error.message),
  );
  const identityConnects = commands.connectCalls.slice(connectsBeforeIdentity);
  assert.deepEqual(identityConnects.map(target => target.pageId), [identityA.pageId]);
  assert.equal(manager.listSessions({ taskId: identityMission.taskId }).length, 0);
  commands.identityChangeOnConnectPageId = '';

  // An inventory with no shared pages is simply empty; no interactive share path exists in candidate discovery.
  commands.setResources([]);
  const emptyCandidates = await new WebMcpWorkerAssignmentCandidateSource(manager, commands).enumerateCandidates();
  assert.deepEqual(emptyCandidates, []);
  const emptyMission = await createMission(tasks);
  await assert.rejects(
    () => new MissionWorkerAssignmentService(tasks, manager, [new WebMcpWorkerAssignmentCandidateSource(manager, commands)]).assignInitial(requestFor(emptyMission)),
    error => error instanceof WorkerAssignmentNoAdmissibleCandidateError,
  );

  // A discovery transport timeout is explicit incomplete truth, not an empty inventory.
  const hangingCommands = new FakeWebMcpCommands();
  hangingCommands.setResources([pageA]);
  hangingCommands.hangList = true;
  const hangingSource = new WebMcpWorkerAssignmentCandidateSource(manager, hangingCommands, { discoveryTimeoutMs: 25, probeTimeoutMs: 25 });
  const discoveryStartedAt = Date.now();
  await assert.rejects(
    () => hangingSource.enumerateCandidates(),
    /WebMCP worker resource discovery exceeded deadline \(25ms\)/,
  );
  assert.ok(Date.now() - discoveryStartedAt < 1000, 'candidate discovery timeout must be observably bounded');
  const discoveryFailureMission = await createMission(tasks);
  await assert.rejects(
    () => new MissionWorkerAssignmentService(tasks, manager, [new WebMcpWorkerAssignmentCandidateSource(manager, hangingCommands, { discoveryTimeoutMs: 25 })]).assignInitial(requestFor(discoveryFailureMission)),
    error => !(error instanceof WorkerAssignmentNoAdmissibleCandidateError) && /resource discovery exceeded deadline/.test(String(error?.message ?? error)),
    'discovery failure must not be reported as no-admissible-candidate',
  );
  assert.equal(hangingCommands.connectCalls.length, 0, 'discovery failure must not connect');
  assert.equal(hangingCommands.sendCount, 0, 'discovery failure must not send');
  assert.equal(manager.listSessions({ taskId: discoveryFailureMission.taskId }).length, 0, 'discovery failure must not create a WorkerSession');

  // Exact refresh has an independent bound and cannot masquerade as page disappearance.
  const hangingProbeCommands = new FakeWebMcpCommands();
  hangingProbeCommands.setResources([pageC2]);
  const hangingProbeSource = new WebMcpWorkerAssignmentCandidateSource(manager, hangingProbeCommands, { discoveryTimeoutMs: 25, probeTimeoutMs: 25 });
  const probeCandidate = (await hangingProbeSource.enumerateCandidates())[0];
  hangingProbeCommands.hangProbe = true;
  const probeStartedAt = Date.now();
  await assert.rejects(
    () => hangingProbeSource.refreshCandidate(probeCandidate),
    /resource probe .* exceeded deadline \(25ms\)/,
  );
  assert.ok(Date.now() - probeStartedAt < 1000, 'exact resource probe timeout must be observably bounded');
  assert.equal(hangingProbeCommands.connectCalls.length, 0);

  const commandNames = new Set(commands.calls.map(call => call.command));
  assert.equal(commandNames.has('_shuncode.webMcp.workerSend'), false, 'candidate discovery/refresh/assignment must not send');
  assert.ok(commandNames.has('_shuncode.webMcp.workerListResources'));
  assert.ok(commandNames.has('_shuncode.webMcp.workerProbeResource'));
  const files = await fs.readdir(taskDirectory);
  assert.equal(files.some(name => /assignment|pool|page.*journal|transcript/i.test(name)), false, 'WO#2 must not create assignment/page-pool/transcript journals');

  console.log(JSON.stringify({
    result: 'PASS',
    sharedWorkerDefinitions: manager.listWorkers().length,
    twoSharedPagesTwoCandidates: true,
    exactASelectedWhileBVisibleLast: true,
    disappearedExactTargetSubstitution: false,
    changedExactTargetSubstitution: false,
    nativeBypassCandidate: false,
    genericProviderIsOriginEvidence: true,
    discoveryPrimeCount: 0,
    discoverySendCount: commands.sendCount,
    discoveryRuntimeStopOrReinject: false,
    transcriptReadAuthority: false,
    crossMissionPageSessionReuse: false,
    sessionGenerationChangesCandidateIdentity: true,
    differentManagedSessionsSameWorkerDefinition: true,
    assignmentJournal: false,
    boundedDiscoveryFailureIsNotEmptyInventory: true,
    boundedProbeFailureIsNotDisappearance: true,
  }, null, 2));
} finally {
  await fs.rm(taskDirectory, { recursive: true, force: true });
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
