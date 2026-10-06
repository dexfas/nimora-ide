import type { createMissionWorkProductionComposition } from './mission-work-production-composition.js';
import { assertReviewedReadContinuation, type ReviewedReadContinuationState } from './nimora-reviewed-read-continuation.js';
import { assertReviewedPracticeReady, practiceNeedsFailureReview, type ReviewedPracticeState } from './nimora-reviewed-practice-entry.js';
import type { CommandEvidenceReference } from '../../../src/mission-collaboration-contract.js';
import { createHash } from 'node:crypto';

type Composition = ReturnType<typeof createMissionWorkProductionComposition>;
type Role = 'coordinator' | 'target' | 'practice';
export type FreshReplacementPage = Readonly<{ pageId: string; candidateId: string }>;

function autonomyEvidenceId(projectId: string, practiceMissionId: string, targetInputId: string): string {
  const digest = createHash('sha256')
    .update(`mission-autonomy-practice-report-v1\0${projectId}\0${practiceMissionId}\0${targetInputId}`)
    .digest('hex');
  return `autonomy:evidence:v1:${digest}`;
}

/** Canonical autonomy Evidence can be newer than the legacy reviewed-takeover
 * projection. This path proves settled Reality facts directly; it never
 * fabricates the old Coordinator dispatch identity. */
async function assertNewerAutonomyPracticeEvidence(
  composition: Composition, projectId: string, base: ReviewedReadContinuationState, practice: ReviewedPracticeState,
): Promise<boolean> {
  await Promise.all([composition.owners.tasks.initialize(), composition.owners.collaboration.initialize()]);
  const reviewedAt = Date.parse(practice.lastFeedback?.observedAt ?? '');
  const exchanges = composition.owners.collaboration.listExchanges(projectId)
    .filter(exchange => exchange.kind === 'Evidence' && exchange.sourceMissionId === practice.missionId
      && exchange.targetMissionId === base.rootMissionId && /^autonomy:evidence:v1:[a-f0-9]{64}$/.test(exchange.exchangeId)
      && Number.isFinite(Date.parse(exchange.createdAt))
      && (!Number.isFinite(reviewedAt) || Date.parse(exchange.createdAt) > reviewedAt))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  if (!exchanges.length) return false;
  const evidence = exchanges[0];
  if (evidence.kind !== 'Evidence') throw new Error('较新的 autonomy proof 不是 Evidence exchange。');
  const turnRefs = evidence.payload.references.filter((reference): reference is CommandEvidenceReference => reference.type === 'command'
    && reference.command.startsWith('nimora-worker-turn:'));
  if (turnRefs.length !== 1 || !/terminal=completed(?:;|$)/.test(turnRefs[0].observation)) {
    throw new Error('较新的 autonomy Evidence 缺少唯一且 completed 的 Worker turn 证明，不能替换 Worker。');
  }
  const targetInputId = turnRefs[0].command.slice('nimora-worker-turn:'.length);
  if (!targetInputId || evidence.exchangeId !== autonomyEvidenceId(projectId, practice.missionId!, targetInputId)) {
    throw new Error('较新的 autonomy Evidence 身份摘要与 Project/Practice/target input 不一致。');
  }
  const task = composition.owners.tasks.getTask(practice.missionId!)!;
  const evidenceAt = Date.parse(evidence.createdAt);
  const executions = Object.values(task.executions);
  const matching = executions.filter(execution => execution.origin?.inputId === targetInputId);
  if (!matching.length) throw new Error('较新的 autonomy Evidence 缺少对应 target input 的持久工具执行，不能据此接班。');
  const targetSessions = new Set(matching.map(execution => execution.origin?.managedSessionId).filter(Boolean));
  if (targetSessions.size !== 1) throw new Error('较新的 autonomy Evidence 对应多个 Practice WorkerSession，拒绝推测。');
  const targetSessionId = [...targetSessions][0]!;
  const targetSessionRef = task.workerSessions[targetSessionId];
  if (!targetSessionRef || targetSessionRef.workerId !== 'nimora.web-worker') {
    throw new Error('较新的 autonomy Evidence 缺少持久 Practice WorkerSession 来源。');
  }
  if (Object.keys(task.interactions).length || executions.some(execution =>
    !['succeeded', 'failed'].includes(execution.status) || execution.deliveryStatus !== 'delivered'
    || execution.duplicateObservations !== 0 || execution.origin?.kind !== 'worker'
    || execution.origin.workerId !== 'nimora.web-worker' || !task.workerSessions[execution.origin.managedSessionId]
    || !execution.finishedAt || !Number.isFinite(Date.parse(execution.finishedAt)) || Date.parse(execution.finishedAt) > evidenceAt
    || execution.resultPayload?.inputId !== execution.origin.inputId || execution.resultPayload.callId !== execution.origin.callId
    || execution.resultPayload.name !== execution.toolName || execution.resultPayload.isError !== (execution.status === 'failed'))) {
    throw new Error('较新的 autonomy Evidence 之后仍有未覆盖、未收敛或来源不一致的 Practice 执行；不会替换 Worker。');
  }
  if (practiceNeedsFailureReview(task, practice.failureReview)) {
    throw new Error('较新的 autonomy Evidence 之外仍存在未审核的历史工具失败；先核实事实。');
  }
  return true;
}

/** A vanished browser is NOT evidence of a settled execution or dead owner.
 * This gate checks canonical task facts and exact old page absence without
 * modifying the project or opening a provider page.
 */
export async function assertReviewedFreshReplacementEligible(
  composition: Composition, projectId: string, workspace: string,
  base: ReviewedReadContinuationState, practice: ReviewedPracticeState,
  listResources: () => Promise<unknown>,
): Promise<void> {
  if (!practice?.missionId || !practice.managedSessionId || !practice.pageId
    || base.pageIds?.length !== 2 || new Set([...base.pageIds, practice.pageId]).size !== 3) {
    throw new Error('原三个 Mission 和网页身份不完整，不得打开新 Worker。');
  }
  await assertReviewedReadContinuation(composition, projectId, workspace, base, 'orphan', practice.missionId);
  if (!(await assertNewerAutonomyPracticeEvidence(composition, projectId, base, practice))) {
    await assertReviewedPracticeReady(composition, projectId, workspace, base, practice, { ownership: 'orphan' });
  }
  const resources = await listResources();
  if (!Array.isArray(resources) || resources.length > 32
    || resources.some(row => !row || typeof row !== 'object' || typeof row.pageId !== 'string')) {
    throw new Error('无法核实完整原生共享网页清单，不能判定旧页面已经关闭。');
  }
  if (resources.some(row => [...base.pageIds, practice.pageId].includes(row.pageId))) {
    throw new Error('至少一张原网页仍出现在共享清单；旧身份必须先单独对账，禁止整组三页替换。');
  }
}

/** Human-authorized NEW-page succession on the SAME durable Mission tree.
 * Exact replacement candidates are supplied only by three fresh native-consent
 * receipts and verified again immediately before the FIRST owner mutation.
 * Partial assignment is checkpointed by the caller, never automatically retried.
 */
export async function replaceReviewedClosedPages(
  composition: Composition, projectId: string, workspace: string,
  base: ReviewedReadContinuationState, practice: ReviewedPracticeState,
  pages: readonly FreshReplacementPage[], listResources: () => Promise<unknown>,
  inspectFresh: () => Promise<readonly FreshReplacementPage[]>,
  beforeMutation: () => Promise<void>,
  onAssigned: (role: Role, sessionId: string) => Promise<void>,
): Promise<Readonly<{ rootSessionId: string; coordinatorSessionId: string; practiceSessionId: string;
  pageIds: string[]; candidateIds: string[]; practicePageId: string; practiceCandidateId: string }>> {
  if (!Array.isArray(pages) || pages.length !== 3
    || pages.some(page => !page || typeof page.pageId !== 'string' || typeof page.candidateId !== 'string'
      || !/^webmcp:[a-f0-9]{64}$/.test(page.candidateId) || !page.pageId)
    || new Set(pages.map(page => page.pageId)).size !== 3
    || new Set(pages.map(page => page.candidateId)).size !== 3
    || pages.some(page => [...base.pageIds, practice.pageId].includes(page.pageId))) {
    throw new Error('必须使用三张不同的全新原生共享 DeepSeek 页面；不能重用原页面身份。');
  }
  await assertReviewedFreshReplacementEligible(composition, projectId, workspace, base, practice, listResources);
  const inspect = async () => {
    const observed = await inspectFresh();
    if (pages.some(page => observed.filter(actual =>
      actual.pageId === page.pageId && actual.candidateId === page.candidateId).length !== 1)) {
      throw new Error('全新网页尚未全部就绪或不再是精确批准的三个空白页面，未改变 Worker 归属。');
    }
    await composition.owners.tasks.initialize();
    const candidates = await composition.webCandidates.enumerateCandidates();
    const nativeIds = new Set<string>();
    for (const page of pages) {
      const matches = candidates.filter(candidate => candidate.candidateId === page.candidateId
        && candidate.workerId === 'nimora.web-worker' && candidate.provider === 'deepseek'
        && candidate.kind === 'web' && candidate.availability === 'available' && candidate.health?.status === 'healthy');
      if (matches.length !== 1) throw new Error('三张新网页缺少精确、健康且唯一的 WebMCP 候选身份。');
      const fresh = await composition.webCandidates.refreshCandidate(matches[0]);
      if (!fresh || fresh.candidateId !== page.candidateId || fresh.availability !== 'available'
        || fresh.health?.status !== 'healthy') throw new Error('新网页刚刚发生状态变化，禁止接班。');
      const options = await composition.webCandidates.materializeSessionOptions(fresh, {});
      const target = options.extensions?.webMcpTarget as { pageId?: string; resourceIdentity?: string; pageSessionId?: string } | undefined;
      if (!target || target.pageId !== page.pageId || target.resourceIdentity !== page.candidateId.slice('webmcp:'.length)) {
        throw new Error('新网页缺少精确且唯一的原生页面/资源身份，禁止接班。');
      }
      // pageSessionId is optional BEFORE the first provider/adapter connection.
      // A fresh page is established by native consent + exact pageId and
      // resourceIdentity, not by inventing an adapter session prematurely.
      const adapterId = target.pageSessionId;
      if (adapterId && (nativeIds.has(adapterId)
        || composition.owners.workers.getSessionByAdapterIdentity('nimora.web-worker', adapterId)
        || composition.owners.tasks.listTasks().some(task => Object.values(task.workerSessions).some(ref =>
          ref.workerId === 'nimora.web-worker' && ref.adapterSessionId === adapterId)))) {
        throw new Error('新网页的 provider-native 身份重复或已属于另一个持久 Mission；禁止接班。');
      }
      if (adapterId) nativeIds.add(adapterId);
    }
  };
  await inspect();
  await beforeMutation();
  await assertReviewedFreshReplacementEligible(composition, projectId, workspace, base, practice, listResources);
  await inspect();

  const roles = [
    { role: 'coordinator' as const, missionId: base.coordinationMissionId, old: base.coordinatorSessionId, page: pages[0] },
    { role: 'target' as const, missionId: base.rootMissionId, old: base.rootSessionId, page: pages[1] },
    { role: 'practice' as const, missionId: practice.missionId!, old: practice.managedSessionId!, page: pages[2] },
  ];
  const assigned: Partial<Record<Role, string>> = {};
  for (const role of roles) {
    // Trusted canonical host proves the old owner process dead; mere absence
    // from browser inventory is NEVER permission to retire its durable ref.
    await composition.application.recoverOrphanedAssignedWorker({
      projectId, rootMissionId: base.rootMissionId, missionId: role.missionId,
      managedSessionId: role.old, reason: 'human-reviewed-explicit-new-page-worker-replacement',
    });
    const result = await composition.application.assignInitialWorker({
      projectId, rootMissionId: base.rootMissionId, missionId: role.missionId,
      constraints: { allowedKinds: ['web'], allowedProviders: ['deepseek'],
        ...(role.role === 'coordinator' ? { requiredCapabilities: { capabilityRequests: true } } : {}) },
    }, { exactCandidateId: role.page.candidateId });
    if (result.state !== 'assigned' || result.assignment.candidateId !== role.page.candidateId
      || Object.values(assigned).includes(result.assignment.managedSessionId)) {
      throw new Error(`${role.role} 新 Worker 未能得到独立的 canonical 绑定；保留已完成的部分接班记录，禁止重试。`);
    }
    assigned[role.role] = result.assignment.managedSessionId;
    await onAssigned(role.role, result.assignment.managedSessionId);
  }
  return {
    coordinatorSessionId: assigned.coordinator!, rootSessionId: assigned.target!,
    practiceSessionId: assigned.practice!,
    pageIds: pages.slice(0, 2).map(page => page.pageId),
    candidateIds: pages.slice(0, 2).map(page => page.candidateId),
    practicePageId: pages[2].pageId, practiceCandidateId: pages[2].candidateId,
  };
}
