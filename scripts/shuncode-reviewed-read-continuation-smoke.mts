import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const esbuild = require('esbuild');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-read-continuation-'));
try {
  const bundle = path.join(temp, 'continuation.cjs');
  await esbuild.build({ entryPoints: [path.join(root, 'extensions/shuncode/src/nimora-reviewed-read-continuation.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { assertReviewedReadContinuation: gate, assertReviewedReadHistoricalFactsForReview: reviewFacts,
    recoverReviewedSettledReadWorkers: recover, reviewedReadContinuationAction: action } = require(bundle);
  const state = { phase: 'mission-sent', rootMissionId: 'root', coordinationMissionId: 'coord', rootSessionId: 'target', coordinatorSessionId: 'coordinator',
    pageIds: ['coord-page', 'target-page'], dispatchIdentity: { coordinatorInputId: 'coord-input', targetInputId: 'read-input',
      coordinatorSessionId: 'coordinator', targetSessionId: 'target' }, lastFeedback: { terminalStatus: 'completed', targetInputId: 'read-input', observedAt: '2026-10-03T04:02:16Z' } };
  function env(orphan = false) {
    const effects = [];
    const sessions = Object.fromEntries([['root', 'target'], ['coord', 'coordinator']].map(([taskId, managedSessionId]) => [managedSessionId,
      { taskId, managedSessionId, workerId: 'nimora.web-worker', adapterSessionId: taskId + '-adapter' }]));
    const tasks = Object.fromEntries([['root', 'target', 'cognition'], ['coord', 'coordinator', 'coordination']].map(([taskId, id, plane]) => [taskId,
      { taskId, status: 'ready', mission: { projectId: 'project', rootMissionId: 'root', plane }, interactions: {}, executions: {}, workerSessions: { [id]: { ...sessions[id] } } }]));
    tasks.root.executions.read = { toolName: 'read_files', capabilityId: 'workspace.read-files', status: 'succeeded', deliveryStatus: 'delivered', duplicateObservations: 0,
      finishedAt: '2026-10-03T04:02:04Z', origin: { kind: 'worker', managedSessionId: 'target', workerId: 'nimora.web-worker', inputId: 'read-input', callId: 'call' },
      resultPayload: { inputId: 'read-input', callId: 'call', name: 'read_files', isError: false } };
    const composition = { owners: {
      projects: { initialize: async () => {}, getProject: () => ({ formationReceipt: { project: { workspace: '/test' }, authorization: { kind: 'human-confirmed' } } }) },
      tasks: { initialize: async () => {}, getTask: id => tasks[id] },
      workers: { listSessions: ({ taskId } = {}) => orphan ? [] : Object.values(sessions).filter(row => !taskId || row.taskId === taskId),
        getSession: id => orphan ? undefined : sessions[id], withAdapterSessionRetirementScope: async (_ids, fn) => fn({ isKnownSettled: () => true }) } },
      coordinator: { inspectManagedScope: async () => ({ coordinationMissionId: 'coord', missions: Object.values(tasks) }) },
      application: { recoverOrphanedAssignedWorker: async input => effects.push(['machine-proof', input.managedSessionId]),
        assignInitialWorker: async (input, selection) => { effects.push(['assign', selection.exactCandidateId]); return { state: 'assigned', assignment: { managedSessionId: 'new-' + input.missionId } }; } } };
    const pages = state.pageIds.map((pageId, i) => ({ pageId, site: 'deepseek', origin: 'https://chat.deepseek.com', ready: true,
      nativeMcpBypass: false, sessionIdentityCompatible: true, workerTurnState: 'completed', resourceIdentity: (i ? 'b' : 'a').repeat(64) }));
    const restore = (review = async () => {}) => recover(composition, 'project', '/test', state, async () => pages,
      async () => { effects.push(['review']); await review(); }, async (role, id) => effects.push(['checkpoint', role, id]));
    return { composition, tasks, effects, sessions, pages, restore };
  }
  const good = env(); await gate(good.composition, 'project', '/test', state); assert.equal(good.effects.length, 0);
  const outstanding = env();
  outstanding.composition.owners.workers.withAdapterSessionRetirementScope = async (_ids, fn) => fn({
    isKnownSettled: identity => identity.adapterSessionId !== 'coord-adapter',
    inspectSettlement: identity => ({ sessionPresent: true, state: 'idle', activeSendLeases: 0,
      abandonedSendCleanups: 0, hostCapabilityRequests: 0,
      unsettledProviderSends: identity.adapterSessionId === 'coord-adapter' ? 1 : 0 }),
  });
  await assert.rejects(() => gate(outstanding.composition, 'project', '/test', state),
    /Coordinator.*1 个旧 Provider 回执未知/);
  outstanding.tasks.practice = { taskId: 'practice', missionId: 'practice', status: 'ready', mission: {
    projectId: 'project', rootMissionId: 'root', parentMissionId: 'root', plane: 'practice' } };
  await reviewFacts(outstanding.composition, 'project', '/test', state, 'practice');
  outstanding.tasks.root.executions.read.deliveryStatus = 'unknown';
  await assert.rejects(() => reviewFacts(outstanding.composition, 'project', '/test', state, 'practice'),
    /未收敛/,'historical review cannot bypass an unconfirmed local tool delivery');
  assert.equal(action(state, Object.values(good.sessions)), 'continue-read'); assert.equal(action(state, []), 'restore-read');
  for (const mutate of [
    x => { x.tasks.root.executions = {}; },
    x => { x.tasks.root.executions.read.status = 'unknown'; },
    x => { x.tasks.root.executions.read.deliveryStatus = 'pending'; },
    x => { x.tasks.root.executions.read.deliveryStatus = 'abandoned'; },
    x => { x.tasks.root.executions.read.resultPayload.isError = true; },
    x => { x.tasks.root.executions.read.origin.inputId = 'other'; },
    x => { x.tasks.root.executions.read.toolName = 'apply_patch'; },
    x => { x.tasks.root.executions.read.duplicateObservations = 1; },
    x => { x.tasks.coord.executions.unexpected = x.tasks.root.executions.read; },
    x => { x.tasks.root.mission.plane = 'practice'; },
    x => { x.tasks.root.missionFinalization = {}; },
    x => { x.tasks.root.workerSessions.target.managedSessionId = 'foreign'; },
    x => { x.composition.owners.workers.withAdapterSessionRetirementScope = async (_ids, fn) => fn({ isKnownSettled: () => false }); },
  ]) { const x = env(); mutate(x); await assert.rejects(() => gate(x.composition, 'project', '/test', state)); assert.equal(x.effects.length, 0); }
  await assert.rejects(() => gate(good.composition, 'project', '/wrong', state));
  await assert.rejects(() => gate(good.composition, 'project', '/test', { ...state, phase: 'mission-unknown' }));
  await assert.rejects(() => gate(good.composition, 'project', '/test', { ...state, lastFeedback: { ...state.lastFeedback, targetInputId: 'wrong' } }));
  const malformedIdentity = { ...state.dispatchIdentity }; delete malformedIdentity.coordinatorInputId; malformedIdentity.extra = 'spoof';
  await assert.rejects(() => gate(good.composition, 'project', '/test', { ...state, dispatchIdentity: malformedIdentity }));
  const restored = env(true); const result = await restored.restore();
  assert.equal(result.rootSessionId, 'new-root'); assert.deepEqual(result.pageIds, state.pageIds);
  assert.deepEqual(restored.effects.map(row => row[0]), ['review', 'machine-proof', 'assign', 'checkpoint', 'machine-proof', 'assign', 'checkpoint']);
  for (const [mutate, message] of [
    [x => { x.pages.splice(0, 1); }, /Coordinator.*未出现在已共享/],
    [x => { x.pages[0].ready = false; }, /Coordinator.*尚未就绪/],
    [x => { x.pages[1].workerTurnState = 'running'; }, /Cognition.*仍在运行/],
    [x => { x.pages[1].site = 'unknown'; }, /Cognition.*身份不匹配/],
    [x => { x.pages.push({ ...x.pages[0] }); }, /Coordinator.*身份不唯一/],
  ]) {
    const missing = env(true); mutate(missing);
    await assert.rejects(() => missing.restore(), message);
    assert.equal(missing.effects.length, 0, 'failed exact page preflight must not modify any original Worker owner');
  }
  const proof = env(true); proof.composition.application.recoverOrphanedAssignedWorker = async () => { throw Error('death-unproven'); };
  await assert.rejects(() => proof.restore(), /death-unproven/); assert.equal(proof.effects.filter(row => row[0] === 'assign').length, 0);
  const race = env(true); await assert.rejects(() => race.restore(async () => { race.tasks.root.executions.read.deliveryStatus = 'unknown'; }));
  assert.deepEqual(race.effects.map(row => row[0]), ['review']);
  const pageRace = env(true); await assert.rejects(() => pageRace.restore(async () => { pageRace.pages[0].resourceIdentity = 'c'.repeat(64); }));
  assert.deepEqual(pageRace.effects.map(row => row[0]), ['review']);
  const partial = env(true); partial.composition.application.recoverOrphanedAssignedWorker = async input => {
    partial.effects.push(['machine-proof', input.managedSessionId]); if (input.missionId === 'root') throw Error('second-owner-unproven');
  };
  await assert.rejects(() => partial.restore(), /second-owner-unproven/);
  assert.equal(partial.effects.filter(row => row[0] === 'assign').length, 1);
  assert.equal(partial.effects.filter(row => row[0] === 'checkpoint').length, 1, 'partial attachment stays recorded, never silently retried');
  await assert.rejects(() => good.restore(), /仍由当前宿主/);
  // Run the actual extension callbacks: the new-input checkpoint is before
  // send, old identities stay archived, and a rejected transport stays UNKNOWN.
  const source = await fs.readFile(path.join(root, 'extensions/shuncode/src/extension.ts'), 'utf8');
  const section = source.slice(source.indexOf('  const settledReadState ='), source.indexOf('  const showReviewedWorkerOperations ='));
  let stored = structuredClone(state), sent = 0, failStorage = false, driverError, entered = 0;
  const sandbox = { createHash, adoptedWebProjectIdsKey: 'adopted', reviewedRecoveryPendingKey: 'pending',
    context: { workspaceState: { get: key => key === 'adopted' ? ['project'] : undefined } }, takeoverStates: () => ({ project: stored }),
    oneTrustedWorkspace: () => '/test', reviewedTakeoverInFlight: false, webProjectStartInFlight: false,
    reviewedFirstMissionInFlight: new Set(), productionWorkersReady: Promise.resolve(),
    assertReviewedReadContinuation: async () => { entered++; }, enableExplicitWebCapabilities: async () => true,
    missionEntryCapabilityMaterialization: ids => ({ ids }), webTaskChars: 0, webTaskOutput: { clear() {}, show() {} }, webTargetText() {},
    recordTakeover: async (_id, next) => { if (failStorage) throw Error('storage-down'); stored = next; }, output: { appendLine() {} },
    vscode: { window: { showWarningMessage: async () => '发送这个新目标', withProgress: async (_opt, run) => run(), setStatusBarMessage() {} }, ProgressLocation: { Window: 1 } },
    missionWorkProduction: { userEntry: { continue: async (_scope, _request, _cancel, _onText, _policy, checkpoint) => {
      await checkpoint({ coordinatorInputId: 'new-coord', targetInputId: 'new-read', coordinatorSessionId: 'coordinator', targetSessionId: 'target' });
      sent++; if (driverError) throw driverError; return { state: 'executed', observation: { terminalStatus: 'completed' } };
    } } }, result: undefined };
  vm.createContext(sandbox);
  vm.runInContext(esbuild.transformSync(section + '\nresult={continueReviewedRead};', { loader: 'ts', target: 'node24' }).code, sandbox);
  await sandbox.result.continueReviewedRead('project', 'new distinct readonly goal', 'root');
  assert.equal(sent, 1); assert.equal(stored.phase, 'mission-sent'); assert.equal(stored.dispatchIdentity.targetInputId, 'new-read');
  assert.equal(stored.consumedDispatches[0].identity.targetInputId, 'read-input'); assert.equal(stored.consumedReadRequests.length, 1);
  assert.equal(entered, 3); await assert.rejects(() => sandbox.result.continueReviewedRead('project', 'new distinct readonly goal', 'root'), /已消费/);
  assert.equal(sent, 1); await assert.rejects(() => sandbox.result.continueReviewedRead('project', 'different goal', 'coord'), /原 Cognition/);
  stored = structuredClone(state); failStorage = true;
  await assert.rejects(() => sandbox.result.continueReviewedRead('project', 'another new goal'), /storage-down/); assert.equal(sent, 1);
  failStorage = false; driverError = new Error('transport-lost');
  await assert.rejects(() => sandbox.result.continueReviewedRead('project', 'another new goal'), error => error === driverError);
  assert.equal(stored.phase, 'mission-unknown'); assert.equal(stored.lastFeedback.terminalStatus, 'unknown');
  assert.equal(stored.dispatchIdentity.targetInputId, 'new-read'); assert.equal(stored.consumedDispatches[0].identity.targetInputId, 'read-input');
  assert.equal(sandbox.reviewedFirstMissionInFlight.size, 0);
  console.log('PASS actual READ continuation: canonical success/delivery, exact provenance, settled ownership, same-page machine recovery, new-input-before-send and UNKNOWN no replay');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
