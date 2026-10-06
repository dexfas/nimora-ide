import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-reviewed-first-read-'));
try {
  const bundle = path.join(temp, 'recovery.cjs');
  await require('esbuild').build({ entryPoints: [path.join(root, 'extensions/shuncode/src/nimora-reviewed-mission-recovery.ts')],
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { recoverReviewedFirstReadWorkers, recoverReviewedSettledMissionWorkers, assertReviewedFreshReadWorkers, reviewedReadRecoveryKind, reviewedReadAction } = require(bundle);
  const original = { rootMissionId: 'root', coordinationMissionId: 'coord', rootSessionId: 'old-target',
    coordinatorSessionId: 'old-coordinator', pageIds: ['approved-coordinator-page', 'approved-target-page'] };
  const resources = original.pageIds.map((pageId, index) => ({ pageId, resourceIdentity: (index ? 'b' : 'a').repeat(64),
    site: 'deepseek', origin: 'https://chat.deepseek.com', ready: true, nativeMcpBypass: false, sessionIdentityCompatible: true, workerTurnState: '' }));
  function environment() {
    const calls = [];
    const tasks = Object.fromEntries(['root', 'coord'].map(id => [id, { taskId: id,
      mission: { projectId: 'project', rootMissionId: 'root' }, executions: {}, interactions: {},
      workerSessions: { [id === 'root' ? 'old-target' : 'old-coordinator']: { managedSessionId: id === 'root' ? 'old-target' : 'old-coordinator' } } }]));
    const composition = {
      owners: { projects: { initialize: async () => {}, getProject: () => ({ formationReceipt: { project: { workspace: '/test' }, authorization: { kind: 'human-confirmed' } } }) },
        tasks: { initialize: async () => {}, getTask: id => tasks[id] }, workers: { getSession: () => undefined } },
      coordinator: { inspectManagedScope: async () => ({ coordinationMissionId: 'coord', missions: [tasks.root, tasks.coord] }) },
      application: {
        recoverOrphanedAssignedWorker: async request => { calls.push({ kind: 'machine-recover', request }); },
        assignInitialWorker: async (request, selection) => { calls.push({ kind: 'assign', request, selection });
          return { state: 'assigned', assignment: { managedSessionId: `new-${request.missionId}` } }; },
      },
    };
    const run = (confirm = async () => {}) => recoverReviewedFirstReadWorkers(composition, 'project', '/test', original,
      async () => resources, async () => { calls.push({ kind: 'confirmed' }); await confirm(); },
      async (role, id) => { calls.push({ kind: 'checkpoint', role, id }); });
    return { calls, composition, tasks, run };
  }
  const ok = environment();
  const result = await ok.run();
  assert.equal(result.rootSessionId, 'new-root'); assert.equal(result.coordinatorSessionId, 'new-coord');
  assert.deepEqual(result.pageIds, original.pageIds);
  assert.deepEqual(ok.calls.map(row => row.kind), ['confirmed', 'machine-recover', 'assign', 'checkpoint', 'machine-recover', 'assign', 'checkpoint']);
  assert.deepEqual(ok.calls.filter(row => row.kind === 'assign').map(row => row.selection.exactCandidateId), ['webmcp:' + 'a'.repeat(64), 'webmcp:' + 'b'.repeat(64)]);
  assert.equal(original.rootSessionId, 'old-target', 'original consumed owner snapshot is immutable');
  for (const alter of [
    env => { env.tasks.root.executions.old = { status: 'succeeded' }; },
    env => { env.tasks.coord.interactions.old = {}; },
    env => { env.tasks.root.missionFinalization = { state: 'completed' }; },
    env => { env.tasks.root.workerSessions['old-target'].managedSessionId = 'different-owner'; },
    env => { env.composition.owners.workers.getSession = () => ({ state: 'idle' }); },
  ]) {
    const env = environment(); alter(env);
    await assert.rejects(() => env.run()); assert.equal(env.calls.length, 0, 'unsafe scope cannot even authorize recovery');
  }
  const proofFails = environment();
  proofFails.composition.application.recoverOrphanedAssignedWorker = async () => { throw Error('OWNER_DEATH_NOT_PROVEN'); };
  await assert.rejects(() => proofFails.run(), /OWNER_DEATH_NOT_PROVEN/);
  assert.deepEqual(proofFails.calls.map(row => row.kind), ['confirmed'], 'missing machine proof cannot create a new attachment');
  const race = environment();
  await assert.rejects(() => race.run(async () => { race.tasks.root.executions.new = { status: 'requested' }; }));
  assert.deepEqual(race.calls.map(row => row.kind), ['confirmed'], 'permission wait requires a fresh canonical gate');
  const partial = environment();
  partial.composition.application.recoverOrphanedAssignedWorker = async request => {
    partial.calls.push({ kind: 'machine-recover', request });
    if (request.missionId === 'root') throw Error('SECOND_OWNER_UNPROVEN');
  };
  await assert.rejects(() => partial.run(), /SECOND_OWNER_UNPROVEN/);
  assert.equal(partial.calls.filter(row => row.kind === 'assign').length, 1);
  assert.equal(partial.calls.filter(row => row.kind === 'checkpoint').length, 1, 'first attachment remains recorded on later failure');
  const unsafe = resources[0]; unsafe.workerTurnState = 'running';
  const busy = environment(); await assert.rejects(() => busy.run()); assert.equal(busy.calls.length, 0);
  unsafe.workerTurnState = '';

  function activeEnvironment() {
    const calls = [];
    const ids = { root: 'active-root', coord: 'active-coord', practice: 'active-practice' };
    const sessions = { root: 'old-root-owner', coord: 'old-coord-owner', practice: 'old-practice-owner' };
    const adapters = { root: 'provider-root', coord: 'provider-coord', practice: 'provider-practice' };
    const pageIds = { coord: 'active-coord-page', root: 'active-root-page', practice: 'active-practice-page' };
    const hashes = { coord: 'c'.repeat(64), root: 'd'.repeat(64), practice: 'e'.repeat(64) };
    const task = (id, plane, sessionId, adapterSessionId, executions = {}) => ({ taskId: id, status: 'ready',
      mission: { projectId: 'active-project', rootMissionId: ids.root, plane }, missionFinalization: undefined,
      executions, interactions: {}, workerSessions: { [sessionId]: { managedSessionId: sessionId, workerId: 'nimora.web-worker', adapterSessionId } } });
    const delivered = (id, status = 'succeeded') => ({ executionId: id, toolName: 'read_files', status, deliveryStatus: 'delivered', duplicateObservations: 0,
      requestedAt: '2026-10-04T00:00:00.000Z', finishedAt: '2026-10-04T00:00:01.000Z' });
    const tasks = {
      [ids.root]: task(ids.root, 'cognition', sessions.root, adapters.root, { rootRead: delivered('rootRead') }),
      [ids.coord]: task(ids.coord, 'coordination', sessions.coord, adapters.coord),
      [ids.practice]: task(ids.practice, 'practice', sessions.practice, adapters.practice, { historicalFailure: delivered('historicalFailure', 'failed') }),
    };
    const resources = [
      { pageId: pageIds.coord, resourceIdentity: hashes.coord, pageSessionId: adapters.coord, workerTurnState: 'completed' },
      { pageId: pageIds.root, resourceIdentity: hashes.root, pageSessionId: adapters.root, workerTurnState: 'completed' },
      { pageId: pageIds.practice, resourceIdentity: hashes.practice, pageSessionId: adapters.practice, workerTurnState: 'cancelled' },
    ].map(row => ({ ...row, site: 'deepseek', origin: 'https://chat.deepseek.com', ready: true, nativeMcpBypass: false, sessionIdentityCompatible: true }));
    const candidateById = new Map(resources.map(row => [`webmcp:${row.resourceIdentity}`, row]));
    const composition = {
      owners: {
        projects: { initialize: async () => {}, getProject: () => ({ formationReceipt: { project: { workspace: '/active' }, authorization: { kind: 'human-confirmed' } } }) },
        tasks: { initialize: async () => {}, getTask: id => tasks[id] },
        workers: { listSessions: () => [] },
      },
      coordinator: { inspectManagedScope: async () => ({ coordinationMissionId: ids.coord,
        missions: Object.values(tasks).map(task => ({ missionId: task.taskId })) }) },
      application: {
        recoverOrphanedAssignedWorker: async request => { calls.push({ kind: 'machine-recover', request }); tasks[request.missionId].workerSessions[request.managedSessionId].retiredAt = '2026-10-04T00:10:00.000Z'; return { state: 'orphan-retired' }; },
        assignInitialWorker: async (request, selection) => { const managedSessionId = `new-${request.missionId}`; calls.push({ kind: 'assign', request, selection, managedSessionId }); return { state: 'assigned', assignment: { managedSessionId, candidateId: selection.exactCandidateId } }; },
      },
      webCandidates: {
        enumerateCandidates: async () => [...candidateById.keys()].map(candidateId => ({ candidateId, workerId: 'nimora.web-worker', provider: 'deepseek', kind: 'web', availability: 'available', health: { status: 'healthy' } })),
        refreshCandidate: async candidate => candidate,
        materializeSessionOptions: async candidate => { const row = candidateById.get(candidate.candidateId); return { extensions: { webMcpTarget: { pageId: row.pageId, resourceIdentity: row.resourceIdentity, pageSessionId: row.pageSessionId } } }; },
      },
    };
    const original = { rootMissionId: ids.root, coordinationMissionId: ids.coord, rootSessionId: sessions.root, coordinatorSessionId: sessions.coord,
      pageIds: [pageIds.coord, pageIds.root], practiceMissionId: ids.practice, practiceSessionId: sessions.practice, practicePageId: pageIds.practice };
    const run = (confirm = async () => {}) => recoverReviewedSettledMissionWorkers(composition, 'active-project', '/active', original,
      async () => resources, async () => { calls.push({ kind: 'confirmed' }); await confirm(); },
      async (role, id) => calls.push({ kind: 'checkpoint', role, id }));
    return { calls, composition, tasks, resources, original, run };
  }
  const active = activeEnvironment();
  const activeRestored = await active.run();
  assert.equal(activeRestored.rootSessionId, 'new-active-root');
  assert.equal(activeRestored.coordinatorSessionId, 'new-active-coord');
  assert.equal(activeRestored.practiceSessionId, 'new-active-practice');
  assert.equal(active.calls.filter(row => row.kind === 'machine-recover').length, 3, 'all three old owners need machine death proof');
  assert.equal(active.calls.filter(row => row.kind === 'assign').length, 3, 'same three provider pages are rebound exactly once');
  assert.equal(active.calls.filter(row => row.kind === 'checkpoint').length, 3, 'partial progress is checkpointed role by role');
  assert(!active.calls.some(row => row.kind === 'send'), 'restart recovery never sends or replays Provider input');
  assert.deepEqual(active.calls.filter(row => row.kind === 'assign').map(row => row.selection.exactCandidateId),
    ['webmcp:' + 'c'.repeat(64), 'webmcp:' + 'd'.repeat(64), 'webmcp:' + 'e'.repeat(64)]);
  const activePending = activeEnvironment();
  activePending.tasks['active-practice'].executions.pending = { status: 'succeeded', deliveryStatus: 'pending' };
  await assert.rejects(() => activePending.run(), /尚未完全收敛/); assert.equal(activePending.calls.length, 0);
  const activeUnknown = activeEnvironment();
  activeUnknown.tasks['active-root'].executions.unknown = { status: 'unknown', deliveryStatus: 'unknown' };
  await assert.rejects(() => activeUnknown.run(), /尚未完全收敛/); assert.equal(activeUnknown.calls.length, 0);
  const activeRunningPage = activeEnvironment(); activeRunningPage.resources[2].workerTurnState = 'running';
  await assert.rejects(() => activeRunningPage.run(), /未就绪、仍在运行/); assert.equal(activeRunningPage.calls.length, 0);
  const activeForeignProvider = activeEnvironment(); activeForeignProvider.resources[1].pageSessionId = 'foreign-provider-session';
  await assert.rejects(() => activeForeignProvider.run(), /Provider 身份改变/); assert.equal(activeForeignProvider.calls.length, 0);
  const activeRace = activeEnvironment();
  await assert.rejects(() => activeRace.run(async () => { activeRace.tasks['active-practice'].executions.race = { status: 'requested', deliveryStatus: 'not-prepared' }; }), /尚未完全收敛/);
  assert.deepEqual(activeRace.calls.map(row => row.kind), ['confirmed'], 'confirmation race is revalidated before owner mutation');

  const reconciled = { phase: 'mission-reconciled', previousAttempt: { state: 'consumed-no-replay' },
    rootSessionId: 'old-target', coordinatorSessionId: 'old-coordinator' };
  assert.equal(reviewedReadRecoveryKind(reconciled), 'unstarted-reconciled');
  assert.equal(reviewedReadAction(reconciled), 'reconcile', 'restart loses handles and must show connection recovery');
  const liveSessions = ['old-target', 'old-coordinator'].map((managedSessionId, index) => ({ managedSessionId,
    taskId: index ? 'coord' : 'root', workerId: 'web', adapterSessionId: `adapter-${index}`, state: 'idle' }));
  assert.equal(reviewedReadAction(reconciled, liveSessions), 'send');
  const consumedIdentity = { targetInputId: 'consumed-target', coordinatorInputId: 'consumed-coordinator', targetSessionId: 'old-target', coordinatorSessionId: 'old-coordinator' };
  const dispatched = { ...reconciled, phase: 'mission-sent', dispatchIdentity: consumedIdentity, lastFeedback: { terminalStatus: 'error', targetInputId: 'consumed-target' } };
  assert.equal(reviewedReadRecoveryKind(dispatched), 'review-dispatched-read');
  assert.equal(reviewedReadAction(dispatched, liveSessions), 'reconcile', 'a failed dispatched turn offers review, never direct resend');
  const transportUnknown = { ...dispatched, phase: 'mission-unknown', lastFeedback: { terminalStatus: 'unknown', targetInputId: 'consumed-target' } };
  assert.equal(reviewedReadRecoveryKind(transportUnknown), 'review-unknown-read');
  assert.equal(reviewedReadAction(transportUnknown, liveSessions), 'reconcile', 'incomplete transport feedback offers canonical review, never a new send');
  for (const changed of [ { ...dispatched, dispatchIdentity: { ...consumedIdentity, targetSessionId: 'foreign' } },
    { ...dispatched, lastFeedback: { terminalStatus: 'completed' } }, { ...dispatched, lastFeedback: { terminalStatus: 'error', targetInputId: 'foreign' } } ]) {
    assert.equal(reviewedReadRecoveryKind(changed), undefined);
  }
  const archived = { ...dispatched, phase: 'mission-reconciled', consumedDispatches: [{ identity: consumedIdentity, state: 'consumed-no-replay', reviewedAt: new Date().toISOString() }] };
  assert.equal(reviewedReadRecoveryKind(archived), 'unstarted-reconciled');
  assert.equal(reviewedReadRecoveryKind({ ...archived, consumedDispatches: [{ ...archived.consumedDispatches[0], identity: { ...consumedIdentity, targetInputId: 'wrong' } }] }), undefined);
  for (const changed of [
    { ...reconciled, phase: 'recovering' }, { ...reconciled, phase: 'mission-unknown' },
    { ...reconciled, dispatchIdentity: { targetInputId: 'fresh-consumed' } },
    { ...reconciled, previousAttempt: { state: 'unverified' } },
  ]) {
    assert.equal(reviewedReadRecoveryKind(changed), undefined, 'later UNKNOWN or consumed new identity is not recovery authority');
    assert.equal(reviewedReadAction(changed, liveSessions), undefined);
  }
  const admission = environment();
  for (const session of liveSessions) Object.assign(admission.tasks[session.taskId].workerSessions[session.managedSessionId], {
    workerId: session.workerId, adapterSessionId: session.adapterSessionId });
  admission.composition.owners.workers.getSession = id => liveSessions.find(row => row.managedSessionId === id);
  admission.composition.owners.workers.listSessions = ({ taskId }) => liveSessions.filter(row => row.taskId === taskId);
  let settled = true;
  admission.composition.owners.workers.withAdapterSessionRetirementScope = async (_identities, operation) => operation({ isKnownSettled: () => settled });
  const admit = () => assertReviewedFreshReadWorkers(admission.composition, 'project', '/test', original);
  await admit(); assert.equal(admission.calls.length, 0, 'admission has no mutation or provider send');
  settled = false; await assert.rejects(admit, /未确认停止/); settled = true;
  liveSessions[0].adapterSessionId = 'wrong-adapter'; await assert.rejects(admit, /身份不一致/);
  liveSessions[0].adapterSessionId = 'adapter-0';
  admission.composition.owners.workers.getSession = () => undefined;
  await assert.rejects(admit, /恢复本次网页连接/);
  admission.tasks.root.executions.new = { status: 'succeeded' };
  await assert.rejects(admit, /已有执行/);
  // Execute the actual extension callbacks with an unresolved informational
  // notification. An awaited toast formerly left takeoverInFlight true.
  const extension = await fs.readFile(path.join(root, 'extensions/shuncode/src/extension.ts'), 'utf8');
  const callbacks = extension.slice(extension.indexOf('  const reconcileReviewedFirstRead ='), extension.indexOf('  const adoptReviewedWebCognition ='));
  const js = await require('esbuild').transform(`(async () => { ${callbacks}; return {reconcileReviewedFirstRead,sendReviewedFreshRead,showReviewedWorkerOperations}; })()`, { loader: 'ts', target: 'es2022' });
  let stored = { ...original, phase: 'mission-unknown' };
  let sent = 0;
  let terminalStatus = 'completed';
  let continuationError;
  let firstInputResolve;
  const firstInput = new Promise(resolve => { firstInputResolve = resolve; });
  let inputs = 0;
  const sandbox = {
    reviewedTakeoverInFlight: false, webProjectStartInFlight: false, reviewedFirstMissionInFlight: new Set(),
    liveReviewedTakeovers: new Map(), productionWorkersReady: Promise.resolve(),
    takeoverStates: () => ({ project: stored }), recordTakeover: async (_id, state) => { stored = state; },
    reviewedReadRecoveryKind, reviewedReadAction, recoverReviewedFirstReadWorkers: async (_composition, _project, _workspace, _original, _list, before, checkpoint) => {
      await before(); await checkpoint('coordinator', original.coordinatorSessionId); await checkpoint('target', original.rootSessionId); return original;
    },
    assertReviewedFreshReadWorkers: async () => {}, oneTrustedWorkspace: () => '/test',
    reviewedRecoveryPendingKey: 'pending', adoptedWebProjectIdsKey: 'adopted', reviewedRecoveryFile: '/reviewed',
    context: { workspaceState: { get: key => key === 'adopted' ? ['project'] : key === 'nimora.reviewedWebCognitionApplied' ? ['digest'] : undefined } },
    output: { appendLine() {} }, webTaskChars: 0, webTaskOutput: { clear() {}, show() {} }, webTargetText() {},
    validateReviewedWebCognition: () => ({ digest: 'digest', instruction: 'old-consumed-request' }), TextDecoder,
    enableExplicitWebCapabilities: async () => true, missionEntryCapabilityMaterialization: ids => ids,
    missionWorkProduction: { owners: { projects: { initialize: async () => {}, getProject: () => ({ title: 'exact project', formationReceipt: { project: { workspace: '/test' }, authorization: { kind: 'human-confirmed' } } }) }, tasks: { getTask: () => ({ mission: { plane: 'cognition' } }) }, workers: { listSessions: () => [] } },
      userEntry: { continue: async (_scope, request, _cancel, _text, capabilities, checkpoint) => {
        assert.equal(request, 'a genuinely new read-only verification'); assert.deepEqual(Array.from(capabilities), ['workspace.read-files']);
        await checkpoint({ targetInputId: 'fresh-target', coordinatorInputId: 'fresh-coordinator', targetSessionId: original.rootSessionId, coordinatorSessionId: original.coordinatorSessionId });
        sent++;
        if (continuationError) throw continuationError;
        return { state: 'executed', observation: { terminalStatus } };
      } } },
    vscode: { Uri: { file: value => value }, ProgressLocation: { Notification: 1, Window: 10 },
      workspace: { isTrusted: true, workspaceFolders: [{}], fs: { readFile: async () => Buffer.from('{}') } }, commands: { executeCommand: async () => [] },
      window: { showWarningMessage: async (title, _options, accept) => accept,
        setStatusBarMessage: () => ({ dispose() {} }),
        showInformationMessage: () => new Promise(() => {}),
        showInputBox: () => ++inputs === 1 ? firstInput : Promise.resolve('a genuinely new read-only verification'),
        withProgress: async (options, operation) => { assert.equal(options.location, 10, 'in-flight browser work must not create a notification overlay that hides its own page'); return operation(); } } },
  };
  const commands = await vm.runInNewContext(js.code, sandbox);
  const pickerSource = extension.slice(extension.indexOf('  const chooseReviewedProjectId ='), extension.indexOf('  const reconcileReviewedFirstRead ='));
  const pickerJs = await require('esbuild').transform(`(async () => { ${pickerSource}; return chooseReviewedProjectId; })()`, { loader: 'ts', target: 'es2022' });
  let picked;
  const picker = await vm.runInNewContext(pickerJs.code, {
    oneTrustedWorkspace: () => '/test', adoptedWebProjectIdsKey: 'adopted',
    context: { workspaceState: { get: () => ['project', 'wrong-workspace', 'unconfirmed'] } },
    missionWorkProduction: { owners: { projects: { initialize: async () => {}, getProject: id => ({ title: id,
      formationReceipt: { project: { workspace: id === 'wrong-workspace' ? '/other' : '/test' }, authorization: { kind: id === 'unconfirmed' ? 'automatic' : 'human-confirmed' } } }) } } },
    vscode: { window: { showQuickPick: async choices => { assert.equal(choices.length, 1); assert.equal(choices[0].projectId, 'project'); return picked ? choices[0] : undefined; } } },
  });
  assert.equal(await picker(), undefined, 'cancelled keyboard selection has no fallback Project');
  picked = true; assert.equal(await picker(), 'project');
  assert.equal(await picker({ projectId: 'explicit-ui-project' }), 'explicit-ui-project', 'existing exact UI argument still reaches authoritative host checks');
  assert.equal((await commands.reconcileReviewedFirstRead('project')).state, 'mission-reconciled');
  assert.equal(sandbox.reviewedTakeoverInFlight, false, 'unacknowledged success toast cannot retain recovery lock');
  let menuSelection;
  sandbox.vscode.window.showQuickPick = async choices => {
    assert.equal(choices.length, 3); assert.equal(choices[0].projectId, 'project'); assert.equal(choices[0].action, 'reconcile');
    return menuSelection ? choices[2] : undefined;
  };
  assert.equal(await commands.showReviewedWorkerOperations(), true, 'cancelled operation menu must not open permission settings');
  menuSelection = 'status'; assert.equal(await commands.showReviewedWorkerOperations(), false, 'only explicit status choice reaches existing settings UI');
  sandbox.liveReviewedTakeovers.clear(); // UI cache loss alone is not ownership loss.
  const pending = commands.sendReviewedFreshRead('project');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(() => commands.sendReviewedFreshRead('project'), /已有新请求/);
  firstInputResolve(undefined); await pending;
  assert.equal(sandbox.reviewedFirstMissionInFlight.size, 0, 'cancelled review releases first-send lock');
  sandbox.vscode.window.showInformationMessage = async () => undefined;
  await commands.sendReviewedFreshRead('project');
  assert.equal(sent, 1); assert.equal(stored.phase, 'mission-sent');
  assert.equal(stored.previousAttempt.state, 'consumed-no-replay');
  assert.equal(stored.dispatchIdentity.targetInputId, 'fresh-target');
  assert.equal(stored.lastFeedback.terminalStatus, 'completed');
  assert.equal(stored.lastFeedback.targetInputId, 'fresh-target');
  await assert.rejects(() => commands.sendReviewedFreshRead('project'), /尚不允许/);
  // A different synthetic scenario checks that an executed Coordinator command
  // carrying failed Target feedback never becomes a successful READ claim.
  stored = { ...original, phase: 'mission-reconciled', previousAttempt: { state: 'consumed-no-replay' } };
  terminalStatus = 'error';
  sandbox.vscode.window.showInformationMessage = () => new Promise(() => {});
  await commands.sendReviewedFreshRead('project');
  assert.equal(stored.lastFeedback.terminalStatus, 'error');
  assert.equal(stored.dispatchIdentity.targetInputId, 'fresh-target');
  assert.equal(sandbox.reviewedFirstMissionInFlight.size, 0, 'terminal presentation cannot retain the send lock');
  await assert.rejects(() => commands.sendReviewedFreshRead('project'), /尚不允许/);
  const failedIdentity = structuredClone(stored.dispatchIdentity);
  const firstConsumption = structuredClone(stored.previousAttempt);
  await commands.reconcileReviewedFirstRead('project');
  assert.deepEqual(stored.dispatchIdentity, failedIdentity, 'connection recovery never deletes the consumed current input identity');
  assert.deepEqual(stored.previousAttempt, firstConsumption, 'original first failure remains immutable');
  assert.equal(stored.consumedDispatches.at(-1).identity.targetInputId, failedIdentity.targetInputId);
  assert.equal(stored.consumedDispatches.at(-1).state, 'consumed-no-replay');
  // A driver exception may occur before or after Target dispatch. Persist
  // bounded failure presentation without inferring settlement or a retry gate.
  const preservedHistory = structuredClone(stored.consumedDispatches);
  stored = { ...original, phase: 'mission-reconciled', previousAttempt: firstConsumption, consumedDispatches: preservedHistory };
  continuationError = new Error('Coordinator terminal provider failure');
  await assert.rejects(() => commands.sendReviewedFreshRead('project'), error => error === continuationError);
  assert.equal(stored.phase, 'mission-unknown');
  assert.equal(stored.lastFeedback.terminalStatus, 'unknown');
  assert.equal(stored.lastFeedback.targetInputId, 'fresh-target');
  assert.deepEqual(stored.previousAttempt, firstConsumption);
  assert.deepEqual(stored.consumedDispatches, preservedHistory);
  assert.equal(sandbox.reviewedFirstMissionInFlight.size, 0);
  assert.equal(reviewedReadRecoveryKind(stored), 'review-unknown-read', 'exception feedback only offers review with independent canonical zero-execution and dead-owner gates');
  assert.equal(reviewedReadAction(stored, liveSessions), 'reconcile', 'exception feedback never offers a direct retry/send');
  await assert.rejects(() => commands.sendReviewedFreshRead('project'), /尚不允许/);
  // If even the presentation checkpoint fails, preserve the actual transport
  // error and the previously persisted UNKNOWN input identity.
  stored = { ...original, phase: 'mission-reconciled', previousAttempt: firstConsumption };
  sandbox.recordTakeover = async (_id, state) => {
    if (state.lastFeedback) throw new Error('feedback storage unavailable');
    stored = state;
  };
  await assert.rejects(() => commands.sendReviewedFreshRead('project'), error => error === continuationError);
  assert.equal(stored.phase, 'mission-unknown');
  assert.equal(stored.dispatchIdentity.targetInputId, 'fresh-target');
  assert.equal(stored.lastFeedback, undefined);
  assert.equal(sandbox.reviewedFirstMissionInFlight.size, 0);
  sandbox.recordTakeover = async (_id, state) => { stored = state; };
  const unknownIdentity = { ...consumedIdentity };
  stored = { ...original, phase: 'mission-unknown', dispatchIdentity: unknownIdentity, previousAttempt: firstConsumption };
  sandbox.missionWorkProduction.owners.tasks.getTask = () => ({ mission: { plane: 'practice' } });
  await assert.rejects(() => commands.reconcileReviewedFirstRead('project'), /不是原 Cognition/);
  assert.equal(stored.phase, 'mission-unknown', 'non-readonly scope cannot enter mutation');
  sandbox.missionWorkProduction.owners.tasks.getTask = () => ({ mission: { plane: 'cognition' } });
  await commands.reconcileReviewedFirstRead('project');
  assert.equal(stored.phase, 'mission-reconciled');
  assert.deepEqual(stored.dispatchIdentity, unknownIdentity, 'review preserves incomplete-feedback consumed identity');
  assert.deepEqual(stored.previousAttempt, firstConsumption);
  assert.deepEqual(structuredClone(stored.consumedDispatches.at(-1).identity), unknownIdentity);
  assert.equal(stored.consumedDispatches.at(-1).state, 'consumed-no-replay');
  console.log('PASS reviewed Mission recovery: first-read zero-execution gate plus active three-Mission settled restart recovery, exact original provider pages, machine-owner proof, no send/replay, UNKNOWN/pending/race fences');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
