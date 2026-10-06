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
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-practice-entry-'));
try {
  const bundle = path.join(temp, 'practice.cjs');
  await esbuild.build({ entryPoints: [path.join(root, 'extensions/shuncode/src/nimora-reviewed-practice-entry.ts')], outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { prepareReviewedPractice: prepare, assertReviewedPracticeReady: ready, practiceFailureDigest, practiceOutcomeDigest, practiceNeedsFailureReview } = require(bundle);
  const recoveryBundle = path.join(temp, 'recovery.cjs');
  await esbuild.build({ entryPoints: [path.join(root, 'extensions/shuncode/src/nimora-reviewed-read-continuation.ts')], outfile: recoveryBundle,
    bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { recoverReviewedSettledReadWorkers: recover } = require(recoveryBundle);
  const base = { phase: 'mission-sent', rootMissionId: 'root', coordinationMissionId: 'coord', rootSessionId: 'target', coordinatorSessionId: 'coordinator',
    pageIds: ['coord-page', 'target-page'], dispatchIdentity: { coordinatorInputId: 'coord-input', targetInputId: 'read-input', coordinatorSessionId: 'coordinator', targetSessionId: 'target' },
    lastFeedback: { terminalStatus: 'completed', targetInputId: 'read-input', observedAt: '2026-10-03T04:02:16Z' } };
  const plan = { phase: 'creating', pageId: 'practice-page', candidateId: 'free-page', instruction: 'Create the approved local deliverables and test; no delete, install or external network.',
    operation: { projectId: 'project', managedRootMissionId: 'root', parentMissionId: 'root', operationKey: 'once', plane: 'practice', missionType: 'implementation-and-testing', goal: 'Deliver and test', completionCriteria: ['actual files', 'actual tests'] } };
  function env() {
    const effects = [], checkpoints = [];
    const sessions = Object.fromEntries([['root', 'target'], ['coord', 'coordinator']].map(([taskId, managedSessionId]) => [managedSessionId,
      { taskId, managedSessionId, workerId: 'nimora.web-worker', adapterSessionId: taskId + '-adapter' }]));
    const tasks = Object.fromEntries([['root', 'target', 'cognition'], ['coord', 'coordinator', 'coordination']].map(([taskId, id, plane]) => [taskId,
      { taskId, status: 'ready', goal: taskId, mission: { projectId: 'project', rootMissionId: 'root', plane }, interactions: {}, executions: {}, workerSessions: { [id]: { ...sessions[id] } } }]));
    tasks.root.executions.read = { toolName: 'read_files', capabilityId: 'workspace.read-files', status: 'succeeded', deliveryStatus: 'delivered', duplicateObservations: 0,
      finishedAt: '2026-10-03T04:02:04Z', origin: { kind: 'worker', managedSessionId: 'target', workerId: 'nimora.web-worker', inputId: 'read-input', callId: 'call' },
      resultPayload: { inputId: 'read-input', callId: 'call', name: 'read_files', isError: false } };
    const candidate = { candidateId: 'free-page', workerId: 'nimora.web-worker', provider: 'deepseek', availability: 'available', health: { status: 'healthy' } };
    const composition = { owners: {
      projects: { initialize: async () => {}, getProject: () => ({ formationReceipt: { project: { workspace: '/test' }, authorization: { kind: 'human-confirmed' } } }) },
      tasks: { initialize: async () => {}, getTask: id => tasks[id], listTasks: () => Object.values(tasks) },
      workers: { listSessions: ({ taskId } = {}) => Object.values(sessions).filter(row => !taskId || row.taskId === taskId), getSession: id => sessions[id],
        getSessionByAdapterIdentity: (_worker, adapter) => Object.values(sessions).find(row => row.adapterSessionId === adapter),
        withAdapterSessionRetirementScope: async (_ids, fn) => fn({ isKnownSettled: () => true }) } },
      webCandidates: { enumerateCandidates: async () => [candidate], refreshCandidate: async () => candidate,
        materializeSessionOptions: async () => ({ extensions: { webMcpTarget: { pageId: 'practice-page', pageSessionId: 'practice-adapter' } } }) },
      coordinator: { inspectManagedScope: async () => ({ coordinationMissionId: 'coord', missions: Object.values(tasks).map(task => ({ missionId: task.taskId })) }),
        ensureMission: async operation => { effects.push(['create', operation]); tasks.practice = { taskId: 'practice', status: 'ready', goal: operation.goal,
          mission: { projectId: 'project', rootMissionId: 'root', parentMissionId: 'root', plane: 'practice', missionType: operation.missionType, completionCriteria: operation.completionCriteria },
          workerSessions: {}, executions: {}, interactions: {} }; return tasks.practice; } },
      application: { assignInitialWorker: async (input, selection) => { effects.push(['assign', input, selection]);
        sessions['practice-worker'] = { taskId: 'practice', managedSessionId: 'practice-worker', workerId: 'nimora.web-worker', adapterSessionId: 'practice-adapter' };
        tasks.practice.workerSessions['practice-worker'] = { ...sessions['practice-worker'] }; return { state: 'assigned', assignment: { managedSessionId: 'practice-worker' } }; } } };
    const run = (checkpoint = async () => {}) => prepare(composition, 'project', '/test', base, structuredClone(plan), async state => { checkpoints.push(structuredClone(state)); await checkpoint(state); });
    return { composition, tasks, sessions, effects, checkpoints, run };
  }
  const ok = env(); const prepared = await ok.run();
  assert.equal(prepared.phase, 'ready'); assert.equal(prepared.missionId, 'practice');
  assert.deepEqual(ok.checkpoints.map(row => row.phase), ['creating', 'assigning', 'ready']);
  assert.deepEqual(ok.effects.map(row => row[0]), ['create', 'assign']);
  assert.equal(ok.effects[1][2].exactCandidateId, plan.candidateId);
  await ready(ok.composition, 'project', '/test', base, prepared);
  assert.equal(ok.tasks.root.mission.plane, 'cognition', 'no root plane promotion');
  assert.equal(Object.keys(ok.tasks).length, 3, 'one same-Project support Mission only');
  const unsafe = env(); unsafe.sessions.other = { adapterSessionId: 'practice-adapter' };
  await assert.rejects(() => unsafe.run(), /归属/); assert.equal(unsafe.effects.length, 0);
  const storage = env(); await assert.rejects(() => storage.run(async () => { throw Error('storage-failed'); }), /storage-failed/);
  assert.equal(storage.effects.length, 0, 'creation is after durable ingress checkpoint');
  const race = env(); await assert.rejects(() => race.run(async state => { if (state.phase === 'creating') race.tasks.root.executions.read.deliveryStatus = 'unknown'; }));
  assert.equal(race.effects.length, 0);
  const partial = env(); partial.composition.application.assignInitialWorker = async () => { throw Error('assignment-unknown'); };
  await assert.rejects(() => partial.run(), /assignment-unknown/); assert.equal(partial.checkpoints.at(-1).phase, 'assigning'); assert.ok(partial.tasks.practice);
  for (const mutate of [x => { x.tasks.practice.mission.plane = 'cognition'; }, x => { x.tasks.practice.mission.rootMissionId = 'foreign'; },
    x => { x.tasks.practice.goal = 'foreign'; }, x => { x.tasks.practice.executions.old = { status: 'unknown', deliveryStatus: 'unknown' }; },
    x => { x.sessions['practice-worker'].taskId = 'foreign'; }]) {
    const x = env(); const p = await x.run(); mutate(x); await assert.rejects(() => ready(x.composition, 'project', '/test', base, p));
  }
  const unknownEnv = env(), unknownPrepared = await unknownEnv.run();
  unknownEnv.tasks.practice.executions.proof = { executionId: 'proof', toolName: 'read_files', status: 'succeeded', deliveryStatus: 'delivered', duplicateObservations: 0,
    finishedAt: '2026-10-03T04:10:00Z', origin: { kind: 'worker', workerId: 'nimora.web-worker', managedSessionId: 'practice-worker', inputId: 'unknown-input', callId: 'proof' },
    resultPayload: { inputId: 'unknown-input', callId: 'proof', name: 'read_files', isError: false } };
  const unknownState = { ...unknownPrepared, phase: 'unknown', dispatchIdentity: {
    coordinatorInputId: 'unknown-coord', targetInputId: 'unknown-input', coordinatorSessionId: 'coordinator', targetSessionId: 'practice-worker' },
    lastFeedback: { terminalStatus: 'unknown', targetInputId: 'unknown-input', observedAt: '2026-10-03T04:11:00Z' } };
  const unknownExecution = structuredClone(unknownEnv.tasks.practice.executions.proof);
  await assert.rejects(() => ready(unknownEnv.composition, 'project', '/test', base, unknownState), /不确定/);
  await assert.rejects(() => ready(unknownEnv.composition, 'project', '/test', base, unknownState, { inspectUnknownOutcome: true }), /不确定/);
  await assert.rejects(() => ready(unknownEnv.composition, 'project', '/test', base, unknownState,
    { ownership: 'orphan', inspectUnknownOutcome: true }), /当前宿主/);
  unknownEnv.composition.owners.workers.listSessions = () => [];
  unknownEnv.composition.owners.workers.getSession = () => undefined;
  await ready(unknownEnv.composition, 'project', '/test', base, unknownState, { ownership: 'orphan', inspectUnknownOutcome: true });
  const unknownReviewed = { ...unknownState, phase: 'reviewed-unknown', outcomeReview: { disposition: 'consumed-no-replay',
    terminalStatus: 'unknown', originalObservedAt: unknownState.lastFeedback.observedAt,
    identity: { ...unknownState.dispatchIdentity }, executionDigest: practiceOutcomeDigest(unknownEnv.tasks.practice), executionCount: 1,
    reviewedAt: '2026-10-03T04:12:00Z' } };
  await ready(unknownEnv.composition, 'project', '/test', base, unknownReviewed, { ownership: 'orphan' });
  assert.equal(unknownReviewed.lastFeedback.terminalStatus, 'unknown', 'review does not invent completed transport');
  for (const mutation of [s => { delete s.outcomeReview; }, s => { s.outcomeReview.identity.targetInputId = 'other'; },
    s => { s.outcomeReview.executionCount = 2; }, s => { s.outcomeReview.reviewedAt = 'invalid'; },
    s => { s.lastFeedback.terminalStatus = 'completed'; }]) {
    const altered = structuredClone(unknownReviewed); mutation(altered);
    await assert.rejects(() => ready(unknownEnv.composition, 'project', '/test', base, altered, { ownership: 'orphan' }));
  }
  unknownEnv.tasks.practice.executions.proof.resultPayload.text = 'changed';
  await assert.rejects(() => ready(unknownEnv.composition, 'project', '/test', base, unknownReviewed, { ownership: 'orphan' }), /核实记录/);
  for (const status of ['unknown', 'executing']) {
    unknownEnv.tasks.practice.executions.proof.status = status;
    await assert.rejects(() => ready(unknownEnv.composition, 'project', '/test', base, unknownState,
      { ownership: 'orphan', inspectUnknownOutcome: true }), /未收敛/);
  }
  unknownEnv.tasks.practice.executions.proof.status = 'succeeded';
  unknownEnv.tasks.practice.executions.proof.deliveryStatus = 'unknown';
  await assert.rejects(() => ready(unknownEnv.composition, 'project', '/test', base, unknownState,
    { ownership: 'orphan', inspectUnknownOutcome: true }), /未收敛/);
  unknownEnv.tasks.practice.executions = {};
  await assert.rejects(() => ready(unknownEnv.composition, 'project', '/test', base, unknownState,
    { ownership: 'orphan', inspectUnknownOutcome: true }), /缺少本轮/);
  assert.equal(unknownEnv.effects.length, 2, 'outcome inspection never sends, assigns or changes owners');

  const audited = env(), auditedReady = await audited.run();
  const completed = { ...auditedReady, phase: 'sent', dispatchIdentity: {
    coordinatorInputId: 'practice-coord', targetInputId: 'practice-input', coordinatorSessionId: 'coordinator', targetSessionId: 'practice-worker',
  }, lastFeedback: { terminalStatus: 'completed', targetInputId: 'practice-input', observedAt: '2026-10-03T04:11:00Z' } };
  audited.tasks.practice.executions.failed = { executionId: 'failed', toolName: 'apply_patch', status: 'failed', deliveryStatus: 'delivered', duplicateObservations: 0,
    finishedAt: '2026-10-03T04:10:00Z', origin: { kind: 'worker', workerId: 'nimora.web-worker', managedSessionId: 'practice-worker', inputId: 'practice-input', callId: 'failed-call' },
    resultPayload: { kind: 'worker-capability', inputId: 'practice-input', callId: 'failed-call', name: 'apply_patch', isError: true, text: 'Malformed patch; no mutation.' } };
  await assert.rejects(() => ready(audited.composition, 'project', '/test', base, completed), /先核实/);
  await ready(audited.composition, 'project', '/test', base, completed, { allowUnreviewedFailures: true });
  const reviewed = { ...completed, failureReview: { digest: practiceFailureDigest(audited.tasks.practice), failureCount: 1, reviewedAt: '2026-10-03T04:12:00Z' } };
  assert.equal(practiceNeedsFailureReview(audited.tasks.practice), true, 'unreviewed exact failure blocks continuation');
  assert.equal(practiceNeedsFailureReview(audited.tasks.practice, reviewed.failureReview), false);
  const sameCountDifferentFailure = structuredClone(audited.tasks.practice);
  sameCountDifferentFailure.executions.failed.resultPayload.text += ' later changed';
  assert.equal(practiceNeedsFailureReview(sameCountDifferentFailure, reviewed.failureReview), true,
    'same failure count must not bypass human review when canonical failure details differ');
  assert.equal(practiceNeedsFailureReview(audited.tasks.practice, { ...reviewed.failureReview, reviewedAt: 'invalid' }), true);
  await ready(audited.composition, 'project', '/test', base, reviewed);
  const stopped = { ...reviewed, lastFeedback: { ...reviewed.lastFeedback, terminalStatus: 'error' } };
  await ready(audited.composition, 'project', '/test', base, stopped);
  await assert.rejects(() => ready(audited.composition, 'project', '/test', base,
    { ...stopped, dispatchIdentity: { ...stopped.dispatchIdentity, targetInputId: 'other-input' }, lastFeedback: { ...stopped.lastFeedback, targetInputId: 'other-input' } }), /缺少匹配/);
  await assert.rejects(() => ready(audited.composition, 'project', '/test', base,
    { ...stopped, lastFeedback: { ...stopped.lastFeedback, terminalStatus: 'unknown' } }), /不确定/);
  audited.composition.owners.workers.withAdapterSessionRetirementScope = async (_ids, fn) => fn({ isKnownSettled: () => false });
  await assert.rejects(() => ready(audited.composition, 'project', '/test', base, stopped), /收尾未确认/);
  const coordinationFailure = { coordinatorInputId: stopped.dispatchIdentity.coordinatorInputId,
    targetInputId: stopped.dispatchIdentity.targetInputId, error: 'provider result receipt UNKNOWN',
    observedAt: '2026-10-03T04:12:01Z' };
  const reviewableStopped = { ...stopped, coordinationFailure };
  await ready(audited.composition, 'project', '/test', base, reviewableStopped,
    { historicalOutcomeReviewOnly: true, allowUnreviewedFailures: true });
  const orphanReview = env(), orphanPrepared = await orphanReview.run();
  orphanReview.tasks.practice.executions.failed = structuredClone(audited.tasks.practice.executions.failed);
  orphanReview.tasks.practice.executions.failed.origin.managedSessionId = 'practice-worker';
  orphanReview.composition.owners.workers.listSessions = () => [];
  orphanReview.composition.owners.workers.getSession = () => undefined;
  const orphanReviewedState = { ...orphanPrepared, phase: 'sent', dispatchIdentity: {
    ...stopped.dispatchIdentity }, lastFeedback: { ...stopped.lastFeedback }, coordinationFailure: { ...coordinationFailure } };
  await ready(orphanReview.composition, 'project', '/test', base, orphanReviewedState,
    { ownership: 'orphan', historicalOutcomeReviewOnly: true, allowUnreviewedFailures: true });
  await assert.rejects(() => ready(orphanReview.composition, 'project', '/test', base, orphanReviewedState,
    { allowUnreviewedFailures: true }), /原网页连接已失去|Worker/,
  'historical review after a normal Extension Host restart must not authorize a live new provider turn');

  const orphanFailureReview = env(), orphanFailurePrepared = await orphanFailureReview.run();
  orphanFailureReview.tasks.practice.executions.failed = structuredClone(audited.tasks.practice.executions.failed);
  orphanFailureReview.tasks.practice.executions.failed.origin.managedSessionId = 'practice-worker';
  orphanFailureReview.tasks.practice.executions.laterFailed = {
    ...structuredClone(audited.tasks.practice.executions.failed), executionId: 'later-failed',
    finishedAt: '2026-10-03T05:30:00Z',
    origin: { ...structuredClone(audited.tasks.practice.executions.failed.origin), managedSessionId: 'practice-worker', inputId: 'later-autonomy-input', callId: 'later-failed-call' },
    resultPayload: { ...structuredClone(audited.tasks.practice.executions.failed.resultPayload), inputId: 'later-autonomy-input', callId: 'later-failed-call' },
  };
  orphanFailureReview.composition.owners.workers.listSessions = () => [];
  orphanFailureReview.composition.owners.workers.getSession = () => undefined;
  const orphanFailureState = { ...orphanFailurePrepared, phase: 'sent', dispatchIdentity: { ...completed.dispatchIdentity },
    lastFeedback: { ...completed.lastFeedback } };
  const orphanFailureEffectsBefore = orphanFailureReview.effects.length;
  await ready(orphanFailureReview.composition, 'project', '/test', base, orphanFailureState,
    { ownership: 'orphan', historicalFailureReviewOnly: true, allowUnreviewedFailures: true });
  assert.equal(orphanFailureReview.effects.length, orphanFailureEffectsBefore,
    'post-restart historical failure review reads durable facts only and never assigns/sends/retires a Worker');
  orphanFailureReview.tasks.practice.executions.laterFailed.deliveryStatus = 'unknown';
  await assert.rejects(() => ready(orphanFailureReview.composition, 'project', '/test', base, orphanFailureState,
    { ownership: 'orphan', historicalFailureReviewOnly: true, allowUnreviewedFailures: true }), /未收敛/,
  'later autonomy execution is reviewable only when its result delivery is fully settled');
  orphanFailureReview.tasks.practice.executions.laterFailed.deliveryStatus = 'delivered';
  await assert.rejects(() => ready(orphanFailureReview.composition, 'project', '/test', base, orphanFailureState,
    { historicalFailureReviewOnly: true, allowUnreviewedFailures: true }), /orphan-only/,
  'historical failure review cannot run under live ownership semantics');
  await assert.rejects(() => ready(orphanFailureReview.composition, 'project', '/test', base, orphanFailureState,
    { ownership: 'orphan', historicalFailureReviewOnly: true }), /orphan-only/,
  'historical failure review requires explicit unreviewed-failure review mode');

  await assert.rejects(() => ready(audited.composition, 'project', '/test', base, reviewableStopped),
    /收尾未确认/,'historical review is not permission to dispatch a new Worker turn');
  await assert.rejects(() => ready(audited.composition, 'project', '/test', base,
    { ...reviewableStopped, coordinationFailure: { ...coordinationFailure, targetInputId: 'wrong' } },
    { historicalOutcomeReviewOnly: true, allowUnreviewedFailures: true }), /历史只读审核缺少/);
  await assert.rejects(() => ready(audited.composition, 'project', '/test', base, reviewableStopped,
    { historicalOutcomeReviewOnly: true }), /历史只读审核缺少/);
  audited.composition.owners.workers.withAdapterSessionRetirementScope = async (_ids, fn) => fn({ isKnownSettled: () => true });
  audited.tasks.practice.executions.failed.resultPayload.text += ' Changed';
  assert.equal(practiceNeedsFailureReview(audited.tasks.practice, reviewed.failureReview), true);
  await assert.rejects(() => ready(audited.composition, 'project', '/test', base, reviewed), /先核实/);
  audited.tasks.practice.executions.failed.deliveryStatus = 'unknown';
  await assert.rejects(() => ready(audited.composition, 'project', '/test', base, completed, { allowUnreviewedFailures: true }), /未收敛/);
  audited.tasks.practice.executions.failed.deliveryStatus = 'delivered';
  const pages = ['coord-page', 'target-page', 'practice-page'].map((pageId, i) => ({ pageId, site: 'deepseek', origin: 'https://chat.deepseek.com',
    ready: true, nativeMcpBypass: false, sessionIdentityCompatible: true, workerTurnState: 'completed', resourceIdentity: ['a','b','c'][i].repeat(64) }));
  audited.composition.owners.workers.listSessions = () => [];
  audited.composition.owners.workers.getSession = () => undefined;
  const recoveryEffects = [];
  audited.composition.application.recoverOrphanedAssignedWorker = async input => { recoveryEffects.push(['proof', input.missionId]); };
  audited.composition.application.assignInitialWorker = async input => { recoveryEffects.push(['assign', input.missionId]); return { state: 'assigned', assignment: { managedSessionId: 'restored-' + input.missionId } }; };
  const restore = () => recover(audited.composition, 'project', '/test', base, async () => pages, async () => {},
    async (role, id) => { recoveryEffects.push(['checkpoint', role, id]); }, { missionId: 'practice', sessionId: 'practice-worker', pageId: 'practice-page',
      assertSettled: () => ready(audited.composition, 'project', '/test', base, completed, { ownership: 'orphan', allowUnreviewedFailures: true }) });
  await assert.rejects(() => recover(audited.composition, 'project', '/test', base, async () => pages.slice(0, 2), async () => {},
    async (role, id) => { recoveryEffects.push(['checkpoint', role, id]); }, { missionId: 'practice', sessionId: 'practice-worker', pageId: 'practice-page',
      assertSettled: () => ready(audited.composition, 'project', '/test', base, completed, { ownership: 'orphan', allowUnreviewedFailures: true }) }),
  /Practice.*未出现在已共享/);
  assert.equal(recoveryEffects.length, 0, 'missing original Practice page cannot partially restore Coordinator or Cognition');
  const restored = await restore(); assert.equal(restored.practiceSessionId, 'restored-practice');
  assert.deepEqual(recoveryEffects.map(row => row[0]), ['proof','assign','checkpoint','proof','assign','checkpoint','proof','assign','checkpoint']);
  assert.equal(Object.keys(audited.tasks).length, 3); assert.equal(audited.tasks.practice.executions.failed.status, 'failed', 'recovery never rewrites failed facts');
  recoveryEffects.length = 0; audited.tasks.practice.executions.failed.deliveryStatus = 'unknown';
  await assert.rejects(restore); assert.equal(recoveryEffects.length, 0, 'UNKNOWN blocks all three recoveries');
  audited.tasks.practice.executions.failed.deliveryStatus = 'delivered';
  audited.composition.application.recoverOrphanedAssignedWorker = async () => { throw Error('owner-not-dead'); };
  await assert.rejects(restore, /owner-not-dead/); assert.equal(recoveryEffects.length, 0, 'no assignment without canonical process-death proof');
  // Exercise actual extension send callback, independently of mocked provider text.
  const source = await fs.readFile(path.join(root, 'extensions/shuncode/src/extension.ts'), 'utf8');
  unknownEnv.tasks.practice.executions = { proof: structuredClone(unknownExecution) };
  const reconciliationSection = source.slice(source.indexOf('  const reconcileReviewedPractice ='), source.indexOf('  const runReviewedPracticeEntry ='));
  let reconciliationState = { ...structuredClone(base), practice: structuredClone(unknownState) }, acceptReview = false, reviewRace = false, reviewWrites = 0;
  const reviewPages = ['coord-page', 'target-page', 'practice-page'].map((pageId, i) => ({ pageId, site: 'deepseek', origin: 'https://chat.deepseek.com',
    ready: true, nativeMcpBypass: false, sessionIdentityCompatible: true, workerTurnState: 'completed', resourceIdentity: ['a','b','c'][i].repeat(64) }));
  const reconciliationSandbox = { reviewedTakeoverInFlight: false, webProjectStartInFlight: false, reviewedFirstMissionInFlight: new Set(),
    settledReadState: () => reconciliationState, takeoverStates: () => ({ project: reconciliationState }), oneTrustedWorkspace: () => '/test',
    productionWorkersReady: Promise.resolve(), missionWorkProduction: unknownEnv.composition, assertReviewedPracticeReady: ready,
    taskRuntime: unknownEnv.composition.owners.tasks, practiceOutcomeDigest, practiceFailureDigest,
    recordTakeover: async (_id, next) => { reviewWrites++; reconciliationState = next; },
    vscode: { commands: { executeCommand: async name => { assert.equal(name, '_shuncode.webMcp.workerListResources'); return reviewPages; } },
      window: { showWarningMessage: async () => {
        if (reviewRace) unknownEnv.tasks.practice.executions.proof.resultPayload.text = 'changed-during-review';
        return acceptReview ? '保留 UNKNOWN，禁止重放' : undefined;
      }, setStatusBarMessage() {} } }, result: undefined };
  vm.createContext(reconciliationSandbox);
  vm.runInContext(esbuild.transformSync(reconciliationSection + '\nresult={reconcileReviewedPractice};', { loader: 'ts', target: 'node24' }).code, reconciliationSandbox);
  await reconciliationSandbox.result.reconcileReviewedPractice('project');
  assert.equal(reviewWrites, 0, 'cancel does not record consent or clear UNKNOWN');
  acceptReview = true; reviewPages[2].workerTurnState = 'running';
  await assert.rejects(() => reconciliationSandbox.result.reconcileReviewedPractice('project'), /仍运行/);
  assert.equal(reviewWrites, 0);
  reviewPages[2].workerTurnState = 'completed'; reviewRace = true;
  await assert.rejects(() => reconciliationSandbox.result.reconcileReviewedPractice('project'), /执行记录改变/);
  assert.equal(reviewWrites, 0, 'same-count changed effects cannot be silently reviewed');
  reviewRace = false; unknownEnv.tasks.practice.executions.proof = structuredClone(unknownExecution);
  await reconciliationSandbox.result.reconcileReviewedPractice('project');
  assert.equal(reviewWrites, 1); assert.equal(reconciliationState.practice.phase, 'reviewed-unknown');
  assert.equal(reconciliationState.practice.lastFeedback.terminalStatus, 'unknown');
  assert.deepEqual(reconciliationState.practice.dispatchIdentity, unknownState.dispatchIdentity);
  assert.equal(reconciliationState.practice.outcomeReview.executionDigest, practiceOutcomeDigest(unknownEnv.tasks.practice));
  assert.equal(unknownEnv.effects.length, 2, 'actual review callback does not assign, send, execute or finalize');

  // The old coordinator ACK can be UNKNOWN after a normal Dev restart: there
  // are no live Worker sessions in the new host, yet settled local failures
  // must remain reviewable WITHOUT granting a new provider send or retirement.
  const postRestart = env(), postRestartReady = await postRestart.run();
  const oneFailure = { executionId: 'old-reviewed-failure', toolName: 'apply_patch', status: 'failed',
    deliveryStatus: 'delivered', duplicateObservations: 0, finishedAt: '2026-10-03T04:10:00Z',
    origin: { kind: 'worker', managedSessionId: 'practice-worker', workerId: 'nimora.web-worker',
      inputId: 'practice-input', callId: 'original-fail-call' },
    resultPayload: { inputId: 'practice-input', callId: 'original-fail-call', name: 'apply_patch',
      isError: true, text: 'The original failed patch was not applied' } };
  postRestart.tasks.practice.executions.first = structuredClone(oneFailure);
  const oldDigest = practiceFailureDigest(postRestart.tasks.practice);
  const newFailure = structuredClone(oneFailure);
  newFailure.executionId = 'last-unreviewed-failure'; newFailure.origin.callId = 'last-fail-call';
  newFailure.resultPayload.callId = 'last-fail-call';
  newFailure.resultPayload.text = 'The later tool failed to read command output';
  postRestart.tasks.practice.executions.last = newFailure;
  const priorDispatch = { coordinatorInputId: 'practice-coord', targetInputId: 'practice-input',
    coordinatorSessionId: 'coordinator', targetSessionId: 'practice-worker' };
  let archived = { ...structuredClone(base), practice: { ...postRestartReady, phase: 'sent',
    dispatchIdentity: priorDispatch, lastFeedback: { terminalStatus: 'error', targetInputId: priorDispatch.targetInputId,
      observedAt: '2026-10-03T04:11:00Z' },
    coordinationFailure: { coordinatorInputId: priorDispatch.coordinatorInputId,
      targetInputId: priorDispatch.targetInputId, error: 'Last provider ACK unknown', observedAt: '2026-10-03T04:12:00Z' },
    failureReview: { digest: oldDigest, failureCount: 1, reviewedAt: '2026-10-03T04:10:30Z' } } };
  assert.equal(practiceNeedsFailureReview(postRestart.tasks.practice, archived.practice.failureReview), true);
  postRestart.composition.owners.workers.getSession = () => undefined;
  postRestart.composition.owners.workers.listSessions = () => [];
  let sentReviewWrites = 0, renderedFailureCount = 0;
  const ownershipSelections = [];
  const postRestartSandbox = { reviewedTakeoverInFlight: false, webProjectStartInFlight: false,
    reviewedFirstMissionInFlight: new Set(), settledReadState: () => archived,
    takeoverStates: () => ({ project: archived }), oneTrustedWorkspace: () => '/test',
    productionWorkersReady: Promise.resolve(), missionWorkProduction: postRestart.composition,
    assertReviewedPracticeReady: async (...args) => { ownershipSelections.push(args[5]); return ready(...args); },
    taskRuntime: postRestart.composition.owners.tasks, practiceFailureDigest,
    recordTakeover: async (_id, value) => { sentReviewWrites++; archived = value; },
    vscode: { window: { showWarningMessage: async (_title, opts) => {
      assert.match(opts.detail, /其中 2 条工具失败/);
      renderedFailureCount += 1; return '仅保留历史执行事实';
    }, setStatusBarMessage: () => {} } }, result: undefined };
  vm.createContext(postRestartSandbox);
  vm.runInContext(esbuild.transformSync(reconciliationSection + '\nresult={reconcileReviewedPractice};',
    { loader: 'ts', target: 'node24' }).code, postRestartSandbox);
  await postRestartSandbox.result.reconcileReviewedPractice('project');
  assert.equal(renderedFailureCount, 1);
  assert.equal(sentReviewWrites, 1);
  assert.equal(archived.practice.failureReview.failureCount, 2,
    'restarting the Dev must not silently trust the obsolete one-failure digest');
  assert.equal(archived.practice.failureReview.digest, practiceFailureDigest(postRestart.tasks.practice));
  assert.equal(archived.practice.coordinationFailure.error, 'Last provider ACK unknown',
    'history review must preserve the old uncertain Coordinator receipt');
  assert.deepEqual(ownershipSelections.map(row => row.ownership), ['orphan', 'orphan']);
  const priorReviewWrites = sentReviewWrites;
  postRestart.composition.owners.workers.getSession = id => id === 'coordinator'
    ? postRestart.sessions.coordinator : undefined;
  postRestart.composition.owners.workers.listSessions = ({ taskId } = {}) =>
    taskId === 'coord' ? [postRestart.sessions.coordinator] : [];
  await assert.rejects(() => postRestartSandbox.result.reconcileReviewedPractice('project'),
    /原网页连接已失去|Worker/, 'a partially restored old set must never be treated as an orphan-only review');
  assert.equal(sentReviewWrites, priorReviewWrites);
  assert.equal(ownershipSelections.at(-1).ownership, 'live');

  const section = source.slice(source.indexOf('  const runReviewedPracticeEntry ='), source.indexOf('  const showReviewedWorkerOperations ='));
  let stored = { ...structuredClone(base), practice: structuredClone(prepared) }, sends = 0, failStorage = false, driverError;
  let grantError, failApprovalStore = false, humanApproved = true, grantCalls = 0, observeBeforeError = false;
  const sandbox = { createHash, settledReadState: () => stored, takeoverStates: () => ({ project: stored }), oneTrustedWorkspace: () => '/test',
    reviewedTakeoverInFlight: false, webProjectStartInFlight: false, reviewedFirstMissionInFlight: new Set(), productionWorkersReady: Promise.resolve(),
    assertReviewedPracticeReady: async () => {}, enableExplicitWebCapabilities: async () => true,
    taskRuntime: {}, preapproveWorkerSessionCapabilities: async (_tasks, input) => {
      grantCalls++; if (grantError) throw grantError;
      assert.equal(input.taskId, 'practice'); assert.equal(input.managedSessionId, 'practice-worker');
      assert.deepEqual(Array.from(input.capabilityIds), ['workspace.apply-patch', 'terminal.run-command']);
      return { managedSessionId: 'practice-worker' };
    },
    automationApprovalsKey: 'approvals', automationApprovals: () => [], context: { workspaceState: { update: async () => { if (failApprovalStore) throw Error('approval-store-failed'); } } },
    missionEntryCapabilityMaterialization: ids => { assert.ok(ids.includes('workspace.apply-patch')); return { ids }; },
    recordTakeover: async (_id, next) => { if (failStorage) throw Error('storage-failed'); stored = next; },
    webTaskChars: 0, webTaskOutput: { clear() {}, show() {} }, webTargetText() {}, output: { appendLine() {} },
    vscode: { ProgressLocation: { Window: 1 }, window: { showWarningMessage: async () => humanApproved ? '授权并启动' : undefined, withProgress: async (_opt, run) => run(), setStatusBarMessage() {} } },
    missionWorkProduction: { userEntry: { continue: async (scope, _request, _cancel, _onText, _policy, checkpoint, checkpointTarget) => {
      assert.equal(scope.missionId, 'practice'); await checkpoint({ coordinatorInputId: 'fresh-coord', targetInputId: 'fresh-practice', coordinatorSessionId: 'coordinator', targetSessionId: 'practice-worker' });
      assert.equal(stored.practice.phase, 'unknown'); sends++;
      if (observeBeforeError) await checkpointTarget({ kind: 'coordinator-live-transport-observation', inputId: 'fresh-practice', targetMissionId: 'practice', terminalStatus: 'completed' });
      if (driverError) throw driverError;
      return { state: 'executed', observation: { terminalStatus: 'completed' } };
    } } }, result: undefined };
  vm.createContext(sandbox); vm.runInContext(esbuild.transformSync(section + '\nresult={runReviewedPracticeEntry};', { loader: 'ts', target: 'node24' }).code, sandbox);
  await sandbox.result.runReviewedPracticeEntry('project'); assert.equal(sends, 1); assert.equal(stored.practice.phase, 'sent');
  assert.deepEqual(stored.dispatchIdentity, base.dispatchIdentity, 'root consumed input remains unchanged');
  assert.equal(stored.practice.lastFeedback.targetInputId, 'fresh-practice');
  await assert.rejects(() => sandbox.result.runReviewedPracticeEntry('project', plan.instruction), /已消费/); assert.equal(sends, 1);
  stored = { ...structuredClone(base), practice: structuredClone(prepared) }; failStorage = true;
  await assert.rejects(() => sandbox.result.runReviewedPracticeEntry('project'), /storage-failed/); assert.equal(sends, 1);
  failStorage = false; driverError = new Error('transport-lost');
  await assert.rejects(() => sandbox.result.runReviewedPracticeEntry('project'), error => error === driverError);
  assert.equal(stored.practice.phase, 'unknown'); assert.equal(stored.practice.dispatchIdentity.targetInputId, 'fresh-practice');
  assert.equal(stored.practice.lastFeedback.terminalStatus, 'unknown'); assert.equal(sandbox.reviewedFirstMissionInFlight.size, 0);
  stored = { ...structuredClone(base), practice: structuredClone(prepared) }; observeBeforeError = true;
  await assert.rejects(() => sandbox.result.runReviewedPracticeEntry('project'), /Target 结束状态 completed 已记录/);
  assert.equal(stored.practice.phase, 'sent'); assert.equal(stored.practice.lastFeedback.terminalStatus, 'completed');
  assert.equal(stored.practice.coordinationFailure.targetInputId, 'fresh-practice');
  assert.match(stored.practice.coordinationFailure.error, /transport-lost/);
  observeBeforeError = false;
  driverError = undefined; stored = { ...structuredClone(base), practice: structuredClone(prepared) }; humanApproved = false;
  const previousGrants = grantCalls, previousSends = sends;
  await sandbox.result.runReviewedPracticeEntry('project'); assert.equal(sends, previousSends); assert.equal(grantCalls, previousGrants, 'cancel grants nothing');
  humanApproved = true; grantError = Error('preapproval-failed');
  await assert.rejects(() => sandbox.result.runReviewedPracticeEntry('project'), /preapproval-failed/); assert.equal(sends, previousSends);
  grantError = undefined; failApprovalStore = true;
  await assert.rejects(() => sandbox.result.runReviewedPracticeEntry('project'), /approval-store-failed/); assert.equal(sends, previousSends, 'approval policy persistence must precede provider send');
  console.log('PASS Practice product ingress: canonical child/no root promotion, exact independent owner, checkpoint-before-create/send, partial/UNKNOWN preserved, actual callback dispatch');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
