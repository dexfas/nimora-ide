import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const esbuild = require('esbuild');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-reviewed-new-page-replacement-'));
try {
  const bundle = path.join(temp, 'replacement.cjs');
  await esbuild.build({ entryPoints: [path.join(root, 'extensions/shuncode/src/nimora-reviewed-fresh-worker-replacement.ts')],
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { assertReviewedFreshReplacementEligible: eligible, replaceReviewedClosedPages: replace } = require(bundle);
  const failureBundle = path.join(temp, 'practice.cjs');
  await esbuild.build({ entryPoints: [path.join(root, 'extensions/shuncode/src/nimora-reviewed-practice-entry.ts')],
    outfile: failureBundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { practiceFailureDigest, assertReviewedPracticeReady } = require(failureBundle);
  const readBundle = path.join(temp, 'read.cjs');
  await esbuild.build({ entryPoints: [path.join(root, 'extensions/shuncode/src/nimora-reviewed-read-continuation.ts')],
    outfile: readBundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { assertReviewedReadContinuation } = require(readBundle);
  const base = { phase: 'mission-sent', rootMissionId: 'root', coordinationMissionId: 'coord',
    rootSessionId: 'old-cognition', coordinatorSessionId: 'old-coordinator', pageIds: ['old-coord-page', 'old-cognition-page'],
    dispatchIdentity: { coordinatorInputId: 'old-coordinator-input', targetInputId: 'old-read-input',
      coordinatorSessionId: 'old-coordinator', targetSessionId: 'old-cognition' },
    lastFeedback: { terminalStatus: 'completed', observedAt: '2026-10-03T10:00:00Z', targetInputId: 'old-read-input' } };
  const pages = ['a', 'b', 'c'].map((ch, i) => ({
    pageId: '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0'), candidateId: 'webmcp:' + ch.repeat(64),
  }));
  function env() {
    const effects = [];
    const op = { projectId: 'project', managedRootMissionId: 'root', parentMissionId: 'root', plane: 'practice',
      missionType: 'implementation-and-testing', goal: 'Deliver verified files', completionCriteria: ['real artifacts'] };
    const task = (taskId, plane, sessionId) => ({ taskId, goal: taskId === 'practice' ? op.goal : taskId,
      status: 'ready', mission: { projectId: 'project', rootMissionId: 'root', plane,
        ...(plane === 'practice' ? { parentMissionId: 'root', missionType: op.missionType, completionCriteria: op.completionCriteria } : {}) },
      executions: {}, interactions: {}, workerSessions: { [sessionId]: { managedSessionId: sessionId,
        workerId: 'nimora.web-worker', adapterSessionId: 'old-adapter-' + plane } } });
    const tasks = { root: task('root', 'cognition', 'old-cognition'),
      coord: task('coord', 'coordination', 'old-coordinator'), practice: task('practice', 'practice', 'old-practice') };
    tasks.root.executions.read = { executionId: 'read', toolName: 'read_files', capabilityId: 'workspace.read-files',
      status: 'succeeded', deliveryStatus: 'delivered', duplicateObservations: 0,
      origin: { kind: 'worker', workerId: 'nimora.web-worker', managedSessionId: 'old-cognition', inputId: 'old-read-input', callId: 'read-call' },
      resultPayload: { inputId: 'old-read-input', callId: 'read-call', name: 'read_files', isError: false }, finishedAt: '2026-10-03T09:58:00Z' };
    tasks.practice.executions.fail = { executionId: 'fail', toolName: 'apply_patch', status: 'failed', deliveryStatus: 'delivered',
      duplicateObservations: 0, origin: { kind: 'worker', workerId: 'nimora.web-worker',
        managedSessionId: 'old-practice', inputId: 'old-practice-input', callId: 'fail-call' },
      resultPayload: { inputId: 'old-practice-input', callId: 'fail-call', name: 'apply_patch', isError: true, text: 'Old known failed patch' },
      finishedAt: '2026-10-03T10:02:00Z' };
    const practice = { phase: 'sent', operation: op, missionId: 'practice', managedSessionId: 'old-practice',
      pageId: 'old-practice-page', candidateId: 'webmcp:' + 'd'.repeat(64), instruction: 'Create verified files',
      dispatchIdentity: { coordinatorInputId: 'old-practice-coord-input', targetInputId: 'old-practice-input',
        coordinatorSessionId: 'old-coordinator', targetSessionId: 'old-practice' },
      lastFeedback: { terminalStatus: 'error', observedAt: '2026-10-03T10:05:00Z', targetInputId: 'old-practice-input' },
      failureReview: { digest: practiceFailureDigest(tasks.practice), failureCount: 1, reviewedAt: '2026-10-03T10:06:00Z' } };
    const exchanges = [];
    const composition = { owners: {
      projects: { initialize: async () => {}, getProject: () => ({ formationReceipt: { project: { workspace: '/test' }, authorization: { kind: 'human-confirmed' } } }) },
      tasks: { initialize: async () => {}, getTask: id => tasks[id], listTasks: () => Object.values(tasks) },
      collaboration: { initialize: async () => {}, listExchanges: () => exchanges },
      workers: { listSessions: () => [], getSession: () => undefined, getSessionByAdapterIdentity: () => undefined },
    }, coordinator: { inspectManagedScope: async () => ({ coordinationMissionId: 'coord',
      missions: Object.keys(tasks).map(missionId => ({ missionId })) }) },
    webCandidates: {
      enumerateCandidates: async () => pages.map(page => ({ candidateId: page.candidateId,
        workerId: 'nimora.web-worker', provider: 'deepseek', kind: 'web',
        availability: 'available', health: { status: 'healthy' } })),
      refreshCandidate: async candidate => candidate,
      materializeSessionOptions: async candidate => {
        const index = pages.findIndex(page => page.candidateId === candidate.candidateId);
        return { extensions: { webMcpTarget: { pageId: pages[index].pageId,
          resourceIdentity: pages[index].candidateId.slice('webmcp:'.length), pageSessionId: 'fresh-adapter-' + index } } };
      },
    },
    application: {
      recoverOrphanedAssignedWorker: async input => {
        effects.push(['machine-proof', input.missionId]);
        assert.equal(input.rootMissionId, 'root');
        assert.ok(tasks[input.missionId].workerSessions[input.managedSessionId]);
        tasks[input.missionId].workerSessions[input.managedSessionId].retiredAt = '2026-10-03T10:08:00Z';
      },
      assignInitialWorker: async (input, selection) => {
        effects.push(['assign', input.missionId, selection.exactCandidateId]);
        const newId = 'new-' + input.missionId;
        tasks[input.missionId].workerSessions[newId] = { managedSessionId: newId,
          workerId: 'nimora.web-worker', adapterSessionId: 'new-adapter-' + input.missionId };
        return { state: 'assigned', assignment: { managedSessionId: newId, candidateId: selection.exactCandidateId } };
      },
    } };
    const inventory = [];
    const read = async () => inventory;
    const inspect = async () => pages;
    const run = (before = async () => { effects.push(['human-approved']); }, observe = inspect) =>
      replace(composition, 'project', '/test', base, practice, pages, read, observe, before,
        async (role, id) => { effects.push(['checkpoint', role, id]); });
    return { composition, tasks, practice, effects, inventory, exchanges, read, run };
  }
  const happy = env();
  await eligible(happy.composition, 'project', '/test', base, happy.practice, happy.read);
  const done = await happy.run();
  assert.deepEqual(done.pageIds, pages.slice(0, 2).map(p => p.pageId));
  assert.equal(done.practicePageId, pages[2].pageId);
  assert.equal(done.coordinatorSessionId, 'new-coord');
  assert.equal(done.rootSessionId, 'new-root');
  assert.equal(done.practiceSessionId, 'new-practice');
  assert.deepEqual(happy.effects.map(e => e[0]), ['human-approved', 'machine-proof','assign','checkpoint', 'machine-proof','assign','checkpoint','machine-proof','assign','checkpoint']);
  assert.equal(Object.keys(happy.tasks).length, 3);
  assert.equal(happy.tasks.root.executions.read.status, 'succeeded');
  assert.equal(happy.tasks.practice.executions.fail.status, 'failed', 'historic failure is not rewritten');
  assert.deepEqual(happy.tasks.root.workerSessions['new-root'].managedSessionId, 'new-root');
  const replacementSessions = Object.fromEntries(['root','coord','practice'].map(taskId => {
    const managedSessionId = 'new-' + taskId;
    return [managedSessionId, { taskId, managedSessionId, workerId: 'nimora.web-worker', adapterSessionId: 'new-adapter-' + taskId }];
  }));
  happy.composition.owners.workers.getSession = id => replacementSessions[id];
  happy.composition.owners.workers.listSessions = ({ taskId } = {}) =>
    Object.values(replacementSessions).filter(session => !taskId || session.taskId === taskId);
  happy.composition.owners.workers.withAdapterSessionRetirementScope = async (_, callback) =>
    callback({ isKnownSettled: () => true });
  const continuedBase = { ...base, rootSessionId: done.rootSessionId, coordinatorSessionId: done.coordinatorSessionId,
    pageIds: done.pageIds };
  const continuedPractice = { ...happy.practice, managedSessionId: done.practiceSessionId, pageId: done.practicePageId,
    candidateId: done.practiceCandidateId };
  await assertReviewedReadContinuation(happy.composition, 'project', '/test', continuedBase, 'live', 'practice');
  await assertReviewedPracticeReady(happy.composition, 'project', '/test', continuedBase, continuedPractice,
    { ownership: 'live' });
  assert.equal(continuedPractice.dispatchIdentity.targetSessionId, 'old-practice',
    'new Worker ownership never forges or replaces the old consumed origin');

  const autonomySettled = env();
  const autonomyInputId = 'autonomy-practice-input';
  autonomySettled.tasks.practice.executions.autonomy = {
    executionId: 'autonomy', toolName: 'read_files', status: 'succeeded', deliveryStatus: 'delivered', duplicateObservations: 0,
    origin: { kind: 'worker', workerId: 'nimora.web-worker', managedSessionId: 'old-practice', inputId: autonomyInputId, callId: 'autonomy-read' },
    resultPayload: { inputId: autonomyInputId, callId: 'autonomy-read', name: 'read_files', isError: false },
    finishedAt: '2026-10-03T10:07:00Z',
  };
  const evidenceDigest = (await import('node:crypto')).createHash('sha256')
    .update(`mission-autonomy-practice-report-v1\0project\0practice\0${autonomyInputId}`).digest('hex');
  autonomySettled.exchanges.push({
    exchangeId: `autonomy:evidence:v1:${evidenceDigest}`, projectId: 'project', sourceMissionId: 'practice', targetMissionId: 'root',
    createdAt: '2026-10-03T10:08:00Z', kind: 'Evidence', payload: { summary: 'Autonomy Reality settled.', references: [
      { type: 'command', command: `nimora-worker-turn:${autonomyInputId}`, observation: 'terminal=completed; events=5; hostExecutions=1; artifacts=0' },
    ] },
  });
  await eligible(autonomySettled.composition, 'project', '/test', base, autonomySettled.practice, autonomySettled.read);
  assert.equal(autonomySettled.practice.dispatchIdentity.targetInputId, 'old-practice-input',
    'canonical autonomy proof must not fabricate or rewrite the legacy reviewed dispatch identity');
  const afterEvidence = env();
  afterEvidence.tasks.practice.executions.autonomy = structuredClone(autonomySettled.tasks.practice.executions.autonomy);
  afterEvidence.exchanges.push(structuredClone(autonomySettled.exchanges[0]));
  afterEvidence.tasks.practice.executions.late = {
    executionId: 'late', toolName: 'read_files', status: 'succeeded', deliveryStatus: 'delivered', duplicateObservations: 0,
    origin: { kind: 'worker', workerId: 'nimora.web-worker', managedSessionId: 'old-practice', inputId: 'late-input', callId: 'late-call' },
    resultPayload: { inputId: 'late-input', callId: 'late-call', name: 'read_files', isError: false },
    finishedAt: '2026-10-03T10:09:00Z',
  };
  await assert.rejects(eligible(afterEvidence.composition, 'project', '/test', base, afterEvidence.practice, afterEvidence.read), /未覆盖、未收敛或来源不一致/);

  const oldPage = env(); oldPage.inventory.push({ pageId: 'old-cognition-page' });
  await assert.rejects(oldPage.run(), /原网页仍出现在共享清单/);
  assert.equal(oldPage.effects.length, 0);
  const unreviewed = env(); unreviewed.practice.failureReview = undefined;
  await assert.rejects(unreviewed.run(), /先核实/); assert.equal(unreviewed.effects.length, 0);
  const mutated = env(); mutated.tasks.practice.executions.fail.resultPayload.text += ' altered';
  await assert.rejects(mutated.run(), /先核实/); assert.equal(mutated.effects.length, 0);
  const preSession = env();
  const materialize = preSession.composition.webCandidates.materializeSessionOptions;
  preSession.composition.webCandidates.materializeSessionOptions = async candidate => {
    const options = await materialize(candidate);
    delete options.extensions.webMcpTarget.pageSessionId;
    return options;
  };
  const preSessionResult = await preSession.run();
  assert.equal(preSessionResult.practicePageId, pages[2].pageId,
    'exactly approved new pages can be bound when the optional session identity is minted only on connection');
  assert.equal(preSession.effects.filter(row => row[0] === 'assign').length, 3);
  const wrongResource = env();
  wrongResource.composition.webCandidates.materializeSessionOptions = async candidate => ({
    extensions: { webMcpTarget: { pageId: pages.find(page => page.candidateId === candidate.candidateId).pageId,
      resourceIdentity: '0'.repeat(64) } },
  });
  await assert.rejects(wrongResource.run(), /页面\/资源身份/);
  assert.equal(wrongResource.effects.length, 0, 'wrong resourceIdentity never triggers a user-confirmation or owner mutation');
  const busyPage = env(); busyPage.tasks.practice.workerSessions.historical = {
    workerId: 'nimora.web-worker', adapterSessionId: 'fresh-adapter-0', retiredAt: '2026-10-03T09:00:00Z' };
  await assert.rejects(busyPage.run(), /重复或已属于/); assert.equal(busyPage.effects.length, 0);
  const probeLost = env(); probeLost.composition.webCandidates.refreshCandidate = async () => undefined;
  await assert.rejects(probeLost.run(), /刚刚发生状态变化/); assert.equal(probeLost.effects.length, 0);
  const noPages = env(); await assert.rejects(noPages.run(async () => {}, async () => pages.slice(0, 2)), /尚未全部就绪/);
  assert.equal(noPages.effects.length, 0);
  const race = env(); let observations = 0;
  await assert.rejects(race.run(async () => { race.effects.push(['human-approved']); }, async () => {
    if (++observations === 2) return pages.slice(0, 2);
    return pages;
  }), /尚未全部就绪/);
  assert.deepEqual(race.effects.map(e => e[0]), ['human-approved'], 'second observation failure cannot mutate owners');
  const noConsent = env(); await assert.rejects(noConsent.run(async () => { throw Error('consent-declined'); }), /consent-declined/);
  assert.equal(noConsent.effects.length, 0);
  const partial = env(); partial.composition.application.recoverOrphanedAssignedWorker = async input => {
    partial.effects.push(['machine-proof', input.missionId]);
    if (input.missionId === 'root') throw Error('trusted-owner-death-unproven');
    partial.tasks[input.missionId].workerSessions[input.managedSessionId].retiredAt = '2026-10-03T10:08:00Z';
  };
  await assert.rejects(partial.run(), /trusted-owner-death-unproven/);
  assert.deepEqual(partial.effects.map(e => e[0]), ['human-approved','machine-proof','assign','checkpoint','machine-proof']);
  assert.equal(partial.tasks.practice.workerSessions['old-practice'].retiredAt, undefined);
  assert.equal(partial.tasks.coord.workerSessions['new-coord'].managedSessionId, 'new-coord');

  const extension = await fs.readFile(path.join(root, 'extensions/shuncode/src/extension.ts'), 'utf8');
  const replacementSection = extension.slice(extension.indexOf('  const replaceReviewedClosedPageWorkers ='), extension.indexOf('  const continueReviewedRead ='));
  assert.match(replacementSection, /count: stillNeeded/);
  assert.match(replacementSection, /onNativePageApproved/);
  assert.match(extension, /action: "replace-new-pages"/, 'native Worker operations must expose a non-Webview fallback for closed pages');
  assert.match(replacementSection, /coordinationFailure: undefined/,
    'old unconfirmed Coordinator receipt is archived only after all three fresh Worker bindings succeed');
  assert.match(replacementSection, /previous: \{ pageIds:[\s\S]*?coordinationFailure:/,
    'an explicit fresh Worker replacement preserves old Coordinator failure provenance in its durable predecessor record');
  assert.match(extension, /禁止复用这张旧网页/,
    'explicit original-page restore must reject any previously unconfirmed Coordinator provider receipt');
  assert.match(extension, /action: "resume-new-pages"/, 'only pre-mutation native-approved pages may resume explicitly');
  assert.match(replacementSection, /recordTakeover\(projectId, \{ \.\.\.before, phase: "mission-sent"/);
  assert.doesNotMatch(replacementSection, /userEntry\.continue\(/, 'replacing browsers must not dispatch an old instruction');
  console.log('PASS Phase12 three NEW-page Worker replacement: canonical/consent/identity preflight, precise partial checkpoints, no replay, fail-closed negatives');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
