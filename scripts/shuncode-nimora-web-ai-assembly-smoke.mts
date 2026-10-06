import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const Module = require('node:module');
const esbuild = require('esbuild');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-web-ai-assembly-'));
try {
  for (const name of ['nimora-web-ai-onboarding', 'nimora-web-cognition']) {
    await esbuild.build({
      entryPoints: [path.join(root, 'extensions', 'shuncode', 'src', `${name}.ts`)],
      outfile: path.join(temp, `${name}.cjs`), bundle: true, platform: 'node', format: 'cjs', target: 'es2022',
      external: ['vscode'], logLevel: 'silent',
    });
  }
  const originalLoad = Module._load;
  Module._load = function(request, ...args) {
    if (request === 'vscode') return {};
    return originalLoad.call(this, request, ...args);
  };
  let prepareNimoraWebAi;
  let NimoraWebCognitionPool;
  try {
    ({ prepareNimoraWebAi } = require(path.join(temp, 'nimora-web-ai-onboarding.cjs')));
    ({ NimoraWebCognitionPool } = require(path.join(temp, 'nimora-web-cognition.cjs')));
  } finally { Module._load = originalLoad; }

  const createCandidate = (id, provider = 'deepseek') => ({
    candidateId: `webmcp:${id}`, workerId: 'nimora.web-worker', provider, kind: 'web', availability: 'available', models: [],
    capabilities: { streaming: true, reasoning: false, capabilityRequests: true, imageInput: false, checkpoints: false, interruption: true, persistentContext: true },
    observationId: `obs-${id}`, observedAt: new Date().toISOString(), health: { status: 'healthy', checkedAt: new Date().toISOString() },
  });
  let pages = 1;
  let opened = 0;
  let shared = 0;
  const sources = {
    enumerateCandidates: async () => Array.from({ length: pages }, (_, i) => createCandidate(i)),
  };
  const host = {
    activateBridge: async () => {},
    openIntegratedPage: async url => { assert.equal(url, 'https://chat.deepseek.com'); opened++; pages++; },
    requestNativeShare: async provider => { assert.equal(provider, 'deepseek'); shared++; return true; },
    promptManualShare: async () => assert.fail('Native sharing is available in this host'),
    wait: async () => {},
  };
  const reused = await prepareNimoraWebAi('deepseek', sources, host);
  assert.equal(reused.state, 'ready');
  assert.equal(reused.reused, true);
  assert.equal(opened, 0, 'a free ready page must be reused');
  const expanded = await prepareNimoraWebAi('deepseek', sources, host, { minReady: 3, attempts: 2, intervalMs: 1 });
  assert.equal(expanded.state, 'ready');
  assert.equal(opened, 2, 'three distinct unowned pages must exist for new web project');
  assert.equal(shared, 2, 'each new page passes through native consent');

  // Real-world reconnect: three tabs may already be open and shared while two
  // composers are still loading. Do not mistake degraded pages for missing tabs.
  let progress = [];
  let discoveryRound = 0;
  const degraded = id => ({ ...createCandidate(id), availability: 'unavailable', health: { status: 'degraded', checkedAt: new Date().toISOString() } });
  const settling = {
    enumerateCandidates: async () => ++discoveryRound === 1
      ? [createCandidate('settled'), degraded('loading-1'), degraded('loading-2')]
      : [createCandidate('settled'), createCandidate('loading-1'), createCandidate('loading-2')],
  };
  const openedBeforeSettle = opened;
  const settled = await prepareNimoraWebAi('deepseek', settling, host, {
    minReady: 3, attempts: 2, intervalMs: 1, onProgress: state => progress.push(state),
  });
  assert.equal(settled.state, 'ready');
  assert.equal(settled.reused, true, 'newly healthy existing shared tabs count as reused');
  assert.equal(opened, openedBeforeSettle, 'three already-shared pages must not open a fourth tab');
  assert.ok(progress.some(state => state.observed === 3 && state.healthy === 1));
  const refusedDiscovery = await prepareNimoraWebAi('deepseek', {
    enumerateCandidates: async () => { throw new Error('mock discovery budget exceeded'); },
  }, host, { minReady: 3, attempts: 2 });
  assert.equal(refusedDiscovery.state, 'awaiting-user-share');
  assert.match(refusedDiscovery.detail, /discovery budget exceeded/);
  assert.equal(opened, openedBeforeSettle, 'unreadable inventory cannot authorize duplicate tabs');

  const permanentlyDegraded = await prepareNimoraWebAi('deepseek', {
    enumerateCandidates: async () => [createCandidate('ok'), degraded('slow-1'), degraded('slow-2')],
  }, host, { minReady: 3, attempts: 2, intervalMs: 1 });
  assert.equal(permanentlyDegraded.state, 'awaiting-user-share');
  assert.match(permanentlyDegraded.detail, /1\/3.*3 个共享候选/);
  assert.equal(opened, openedBeforeSettle, 'unhealthy existing tabs remain visible but do not trigger extra tabs');

  const boundedWait = await prepareNimoraWebAi('deepseek', {
    enumerateCandidates: async () => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return [createCandidate('ok'), degraded('slow-1'), degraded('slow-2')];
    },
  }, host, { minReady: 3, maxWaitMs: 1, attempts: 20, intervalMs: 1000 });
  assert.equal(boundedWait.state, 'awaiting-user-share');
  assert.match(boundedWait.detail, /整体等待时限/);
  assert.equal(opened, openedBeforeSettle, 'expired preparation may not open additional pages');

  pages = 0;
  let deniedOpen = 0;
  const denied = await prepareNimoraWebAi('deepseek', sources, { ...host,
    openIntegratedPage: async () => { deniedOpen++; },
    requestNativeShare: async () => false,
  }, { attempts: 1 });
  assert.equal(denied.state, 'sharing-declined');
  assert.equal(deniedOpen, 1);
  const noShare = await prepareNimoraWebAi('deepseek', sources, { ...host,
    openIntegratedPage: async () => {},
    requestNativeShare: async () => undefined,
    promptManualShare: async () => {},
  }, { attempts: 2, intervalMs: 1 });
  assert.equal(noShare.state, 'awaiting-user-share', 'unshared pages never become an invented ready candidate');

  const workbenchSource = await fs.readFile(path.join(root, 'src/vs/workbench/contrib/browserView/electron-browser/features/browserTabManagementFeatures.ts'), 'utf8');
  const onboardingSource = await fs.readFile(path.join(root, 'extensions/shuncode/src/nimora-web-ai-onboarding.ts'), 'utf8');
  const atomicShare = workbenchSource.slice(workbenchSource.indexOf('class NimoraOpenAndShareProviderPageAction'), workbenchSource.indexOf('class OpenFileInIntegratedBrowserAction'));
  assert.match(atomicShare, /BrowserViewUri\.forId\(generateUuid\(\)\)/, 'each connection must create one distinct page identity');
  assert.match(atomicShare, /editor\.resource\.toString\(\) !== resource\.toString\(\)/, 'share must target the newly opened page exactly');
  assert.match(atomicShare, /model\.setSharedWithAgent\(true\)/, 'native browser remains sharing consent authority');
  assert.doesNotMatch(atomicShare, /activeEditor/, 'active-tab switching must never redirect the share request');
  assert.match(onboardingSource, /workbench\.action\.browser\.nimoraOpenAndShareProviderPage/, 'onboarding must invoke the atomic native action');

  const production = await fs.readFile(path.join(root, 'extensions/shuncode/src/extension.ts'), 'utf8');
  // Notification progress hides the native BrowserView while it overlaps it.
  // Check the actual preparation wrappers, including recovery and Connections.
  for (const title of ['Nimora · 安全接管两张全新 DeepSeek 网页', 'Nimora · 三条原 Mission 的全新 Worker 接班', 'Nimora · 先准备一张需求规划网页', 'Nimora · 准备执行网页', 'Nimora · 连接']) {
    const titleOffset = production.indexOf(title);
    assert.ok(titleOffset > 0, `missing preparation progress: ${title}`);
    const wrapperStart = production.lastIndexOf('vscode.window.withProgress(', titleOffset);
    assert.match(production.slice(wrapperStart, titleOffset), /location: vscode\.ProgressLocation\.Window/,
      `${title} must not cover the browser while waiting for login/share/readiness`);
  }
  assert.doesNotMatch(onboardingSource.slice(onboardingSource.indexOf('async promptManualShare'), onboardingSource.indexOf('wait(ms)')),
    /showInformationMessage/, 'manual sharing guidance may not spawn a browser-obscuring toast');
  assert.match(onboardingSource, /setStatusBarMessage/, 'manual sharing retains status-bar guidance');
  const webFormation = production.slice(production.indexOf('const createWebProject ='), production.indexOf('const continueWebMission ='));
  assert.match(webFormation, /openDeepSeekPages\(1, progress\)/, 'first request must need just one real planner page');
  assert.ok(webFormation.indexOf('openDeepSeekPages(1, progress)') < webFormation.indexOf('interpretThroughWeb(input, cognitionSessionId, resources)'), 'planner must run after one-page preparation');
  assert.ok(webFormation.indexOf('interpretThroughWeb(input, cognitionSessionId, resources)') < webFormation.indexOf('openDeepSeekPages(2, progress)'), 'two NEW worker pages must be prepared only after reserved planning');
  assert.ok(webFormation.indexOf('context.workspaceState.update(webFormationPlanKey, { workspace') < webFormation.indexOf('openDeepSeekPages(2, progress)'), 'completed planning must checkpoint before blocked page setup');
  assert.match(webFormation, /cachedPlan\?\.json/, 'same request must resume without repeating provider planning');
  assert.match(webFormation, /userEntry\.start\(/, 'web entry must reuse the existing canonical Mission entry owner');
  assert.match(webFormation, /interpretThroughWeb\(/, 'web entry must use real webpage Cognition');
  assert.doesNotMatch(webFormation, /runtime\.runAgent\(|codexAuthManager/, 'web entry must not silently charge or depend on the API/Codex model');

  const sessions = new Map();
  let sends = 0;
  const sentInputs = [];
  let nextStream = async function*() {
    yield { type: 'text_delta', text: '{"instruction":"read requirement"}' };
    yield { type: 'terminal', status: 'completed', result: { text: '{"instruction":"read requirement"}' } };
  };
  const workers = {
    refresh: async () => ({ id: 'nimora.web-worker', kind: 'web', availability: 'available', models: [], capabilities: createCandidate('planning').capabilities }),
    health: async () => ({ status: 'healthy', checkedAt: '2026-10-06T00:00:00.000Z' }),
    createSession: async (workerId, options) => {
      assert.equal(workerId, 'nimora.web-worker');
      const value = { managedSessionId: 'planning-session', adapterSessionId: 'exact-native-planner', state: 'idle', workerId, ...options };
      sessions.set(value.managedSessionId, value);
      return value;
    },
    getSession: id => sessions.get(id),
    send: (_id, input) => { sends++; sentInputs.push(input); assert.deepEqual(input.allowedCapabilities, []); assert.deepEqual(input.externalCapabilities, []); return nextStream(); },
    retire: async id => { sessions.delete(id); return {}; },
  };
  const reservedPlannerPages = new Set();
  const source = {
    enumerateCandidates: async () => [createCandidate('planning')],
    refreshCandidate: async candidate => ({ ...candidate, observationId: 'fresh-observation' }),
    materializeSessionOptions: async () => ({ extensions: { webMcpTarget: { pageId: 'planning-page' } } }),
    reservePlanningPage: pageId => reservedPlannerPages.add(pageId),
    releasePlanningPage: pageId => reservedPlannerPages.delete(pageId),
  };
  const jsonFailures = [];
  const pool = new NimoraWebCognitionPool(workers, source, event => jsonFailures.push(event));
  const sessionId = await pool.acquire('my-test-project');
  assert.deepEqual([...reservedPlannerPages], ['planning-page'], 'owned planning page is not assignable before any pageSessionId exists');
  const backend = await pool.inspectBackend(sessionId);
  assert.equal(backend.basis, 'owned-tools-free-planner');
  assert.equal(backend.capabilities.reasoning, false, 'Cognition semantics do not imply transport reasoning events');
  assert.equal(sends, 0, 'backend observation sends no provider input');
  assert.deepEqual([...reservedPlannerPages], ['planning-page'], 'backend evidence does not release planner into Mission pool');
  const originalHealth = workers.health;
  workers.health = async () => ({ status: 'offline', checkedAt: '2026-10-06T00:00:00.000Z' });
  await assert.rejects(pool.inspectBackend(sessionId), /漂移或不健康/);
  workers.health = async () => { sessions.get(sessionId).adapterSessionId = 'drifted'; return { status: 'healthy', checkedAt: '2026-10-06T00:00:00.000Z' }; };
  await assert.rejects(pool.inspectBackend(sessionId), /漂移或不健康/);
  sessions.get(sessionId).adapterSessionId = 'exact-native-planner';
  workers.health = originalHealth;
  assert.equal(await pool.run(sessionId, 'plan in JSON'), '{"instruction":"read requirement"}');
  assert.equal(await pool.acquire('my-test-project'), sessionId, 'Project continuation reuses same dedicated planning page');
  assert.equal(sends, 1);
  const escapedJson = JSON.stringify({ instruction: 'Use exactly ["workspace.read-files"] and preserve \\ and\nnewlines' });
  nextStream = async function*() { yield { type: 'terminal', status: 'completed', result: { text: '```json\n' + escapedJson + '\n```' } }; };
  assert.deepEqual(JSON.parse(await pool.runJson(sessionId, 'preserve quoted restrictions')), JSON.parse(escapedJson));
  assert.equal(sends, 2, 'valid fenced JSON needs no correction');
  let formatTurn = 0;
  nextStream = async function*() {
    yield { type: 'terminal', status: 'completed', result: { text: formatTurn++ === 0
      ? '{"instruction":"Use ["workspace.read-files"]"}' : '```json\n' + escapedJson + '\n```' } };
  };
  assert.deepEqual(JSON.parse(await pool.runJson(sessionId, 'only read the named file')), JSON.parse(escapedJson));
  assert.equal(sends, 4, 'known completed invalid syntax admits exactly one format-correction input');
  assert.notEqual(sentInputs[2].inputId, sentInputs[3].inputId, 'correction never reuses consumed input identity');
  assert.match(sentInputs[3].prompt, /not permission to execute or repeat work/);
  assert.deepEqual(jsonFailures.map(e => e.attempt), [1]);
  assert.match(jsonFailures[0].replySHA256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(jsonFailures[0], 'reply'), false, 'observations retain hashes, not transcripts');
  nextStream = async function*() { yield { type: 'terminal', status: 'completed', result: { text: 'Prose\n```json\n{}\n```\nextra' } }; };
  await assert.rejects(pool.runJson(sessionId, 'bounded request'), /一次有界格式纠正/);
  assert.equal(sends, 6, 'invalid correction stops after two inputs, no loop or substring salvage');
  nextStream = async function*() { yield { type: 'terminal', status: 'completed', result: { text: 'null' } }; };
  assert.equal(await pool.runJson(sessionId, 'semantic validation remains owned by Formation'), 'null');
  assert.equal(sends, 7, 'valid syntax with invalid semantics must not trigger correction');
  nextStream = async function*() { yield { type: 'capability_call', inputId: 'x', name: 'workspace.apply-patch', dispatch: 'host-requested' }; };
  await assert.rejects(pool.runJson(sessionId, 'unsafe'), /不允许任何工具调用/);
  assert.equal(sends, 8, 'tool request does not admit format correction');
  await assert.rejects(pool.run(sessionId, 'blind replay'), /不能盲目重发/);
  await assert.rejects(pool.inspectBackend(sessionId), /原规划会话/);
  await assert.rejects(pool.acquire('my-test-project'), /不可核实/);
  await pool.retireUnused(sessionId);
  assert.equal(sessions.has(sessionId), true, 'unsettled page cannot be silently retired or reused');
  const failedSessions = new Map([['failed', { managedSessionId: 'failed', workerId: 'nimora.web-worker' }]]);
  let failedSends = 0;
  const failedPool = new NimoraWebCognitionPool({ getSession: id => failedSessions.get(id),
    createSession: async () => failedSessions.get('failed'),
    send: async function*() { failedSends++; yield { type: 'terminal', status: 'failed', error: 'unknown send outcome' }; } }, source);
  await assert.rejects(failedPool.runJson('failed', 'not owned'), /规划需要/);
  await failedPool.acquire();
  await assert.rejects(failedPool.runJson('failed', 'plan'), /不得直接重试/);
  await assert.rejects(failedPool.runJson('failed', 'repeat'), /不能盲目重发/);
  assert.equal(failedSends, 1, 'transport/provider failure remains quarantined and never gets a JSON correction');
  console.log('PASS Nimora Web AI assembly: ready-page reuse, atomic native sharing, three-page preparation, denial/timeout, tools-free Cognition and no blind replay');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
