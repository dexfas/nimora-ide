import type { createMissionWorkProductionComposition } from './mission-work-production-composition.js';
import type { MissionEntryDispatchIdentity } from '../../../src/mission-user-entry-application.js';
import type { EnsureMissionInstruction } from '../../../src/mission-coordinator-service.js';
import { assertReviewedReadContinuation, assertReviewedReadHistoricalFactsForReview, type ReviewedReadContinuationState } from './nimora-reviewed-read-continuation.js';
import { createHash } from 'node:crypto';
import type { TaskSnapshot } from '../../../src/task-contract.js';

type Composition = ReturnType<typeof createMissionWorkProductionComposition>;
export interface ReviewedPracticeState {
  phase: 'creating' | 'assigning' | 'ready' | 'unknown' | 'sent' | 'reviewed-unknown';
  operation: EnsureMissionInstruction;
  instruction: string;
  pageId: string;
  candidateId: string;
  missionId?: string;
  managedSessionId?: string;
  dispatchIdentity?: MissionEntryDispatchIdentity;
  lastFeedback?: { terminalStatus: string; targetInputId: string; observedAt: string };
  /** Coordinator delivery failure never overwrites an already observed Target terminal. */
  coordinationFailure?: { coordinatorInputId: string; targetInputId: string; error: string; observedAt: string };
  consumedInputs?: MissionEntryDispatchIdentity[];
  failureReview?: { digest: string; failureCount: number; reviewedAt: string };
  /** Reviewed effects only: this NEVER changes the original unknown terminal. */
  outcomeReview?: { disposition: 'consumed-no-replay'; identity: MissionEntryDispatchIdentity;
    terminalStatus: 'unknown'; originalObservedAt: string; executionDigest: string; executionCount: number; reviewedAt: string };
}

export function practiceOutcomeDigest(task: TaskSnapshot): string {
  return createHash('sha256').update(JSON.stringify(Object.values(task.executions)
    .sort((a, b) => a.executionId.localeCompare(b.executionId)))).digest('hex');
}

/** Exact fingerprint of retained failures, never an instruction to retry them. */
export function practiceFailureDigest(task: TaskSnapshot): string {
  const failures = Object.values(task.executions).filter(row => row.status === 'failed').sort((a, b) => a.executionId.localeCompare(b.executionId));
  return createHash('sha256').update(JSON.stringify(failures)).digest('hex');
}

/** A displayed failure count is not review authority: the exact settled failure
 * records must still match the human-reviewed durable fingerprint. */
export function practiceNeedsFailureReview(task: TaskSnapshot, review?: ReviewedPracticeState['failureReview']): boolean {
  const failureCount = Object.values(task.executions).filter(row => row.status === 'failed').length;
  return failureCount > 0 && (!review || review.failureCount !== failureCount
    || review.digest !== practiceFailureDigest(task) || !Number.isFinite(Date.parse(review.reviewedAt)));
}

/** Observe an exact shared free page through the existing adaptation boundary.
 * No browser send, creation, sharing or private controller is performed here.
 */
export async function inspectPracticePage(composition: Composition, base: ReviewedReadContinuationState,
  selection: { pageId: string; candidateId: string }): Promise<void> {
  if (!selection.pageId || base.pageIds.includes(selection.pageId)) throw new Error('执行 Worker 必须使用独立的已共享网页。');
  const candidate = (await composition.webCandidates.enumerateCandidates()).find(row => row.candidateId === selection.candidateId);
  if (!candidate || candidate.workerId !== 'nimora.web-worker' || candidate.provider !== 'deepseek'
    || candidate.availability !== 'available' || candidate.health?.status !== 'healthy') throw new Error('所选执行网页不可用。');
  const fresh = await composition.webCandidates.refreshCandidate(candidate);
  if (!fresh || fresh.candidateId !== candidate.candidateId || fresh.availability !== 'available' || fresh.health?.status !== 'healthy') throw new Error('执行网页身份或状态改变。');
  const options = await composition.webCandidates.materializeSessionOptions(fresh, {});
  const target = options.extensions?.webMcpTarget as { pageId?: string; pageSessionId?: string } | undefined;
  if (target?.pageId !== selection.pageId) throw new Error('执行网页与审核页面不一致。');
  if (target.pageSessionId && (composition.owners.workers.getSessionByAdapterIdentity(candidate.workerId, target.pageSessionId)
    || composition.owners.tasks.listTasks().some(task => Object.values(task.workerSessions).some(ref => ref.workerId === candidate.workerId && ref.adapterSessionId === target.pageSessionId)))) {
    throw new Error('执行网页已有其它 Worker 或持久 Mission 归属，不能抢用。');
  }
}

/** A reviewed human implementation instruction adds a Practice CHILD through
 * the canonical semantic owner; the existing Cognition root is never upgraded.
 * Every possible mutation is checkpointed. Partial/unknown outcomes must be
 * inspected; calling this helper again is not a recovery mechanism.
 */
export async function prepareReviewedPractice(composition: Composition, projectId: string, workspace: string,
  base: ReviewedReadContinuationState, plan: ReviewedPracticeState, checkpoint: (state: ReviewedPracticeState) => Promise<void>): Promise<ReviewedPracticeState> {
  if (plan.phase !== 'creating' || plan.missionId || plan.managedSessionId || plan.dispatchIdentity
    || plan.operation.projectId !== projectId || plan.operation.managedRootMissionId !== base.rootMissionId
    || plan.operation.parentMissionId !== base.rootMissionId || plan.operation.plane !== 'practice'
    || !plan.instruction.trim() || plan.instruction.length > 24_000) throw new Error('执行计划范围无效，没有创建或发送。');
  await assertReviewedReadContinuation(composition, projectId, workspace, base);
  await inspectPracticePage(composition, base, plan);
  await checkpoint({ ...plan });
  await assertReviewedReadContinuation(composition, projectId, workspace, base);
  await inspectPracticePage(composition, base, plan);
  const task = await composition.coordinator.ensureMission(plan.operation);
  let state: ReviewedPracticeState = { ...plan, missionId: task.taskId, phase: 'assigning' };
  await checkpoint(state);
  await inspectPracticePage(composition, base, plan);
  const assignment = await composition.application.assignInitialWorker({ projectId, rootMissionId: base.rootMissionId, missionId: task.taskId,
    constraints: { allowedKinds: ['web'], allowedProviders: ['deepseek'], requiredCapabilities: { capabilityRequests: true } } }, { exactCandidateId: plan.candidateId });
  if (assignment.state !== 'assigned') throw new Error('Practice 尚未分配 Worker；实际子 Mission 已保留，不会重复创建。');
  state = { ...state, managedSessionId: assignment.assignment.managedSessionId, phase: 'ready' };
  await checkpoint(state);
  return state;
}

export async function assertReviewedPracticeReady(composition: Composition, projectId: string, workspace: string,
  base: ReviewedReadContinuationState, state: ReviewedPracticeState,
  options: { ownership?: 'live' | 'orphan'; allowUnreviewedFailures?: boolean; inspectUnknownOutcome?: boolean;
    historicalOutcomeReviewOnly?: boolean; historicalFailureReviewOnly?: boolean } = {}): Promise<void> {
  // Inspection of an UNKNOWN ingress is read-only and orphan-only. It cannot
  // admit a send. After explicit review, the digest is checked again on every
  // recovery/send and canonical process-death proof remains mandatory.
  const inspectingUnknown = options.inspectUnknownOutcome === true && options.ownership === 'orphan' && state.phase === 'unknown';
  const reviewedUnknown = state.phase === 'reviewed-unknown';
  if (!state.missionId || !state.managedSessionId || state.operation.projectId !== projectId
    || state.operation.managedRootMissionId !== base.rootMissionId || state.operation.parentMissionId !== base.rootMissionId
    || state.operation.plane !== 'practice' || (state.phase !== 'ready' && state.phase !== 'sent' && !inspectingUnknown && !reviewedUnknown)
    || (state.phase !== 'ready' && (!state.lastFeedback || !(inspectingUnknown || reviewedUnknown ? ['unknown'] : ['completed', 'error']).includes(state.lastFeedback.terminalStatus)
      || !state.dispatchIdentity || state.lastFeedback.targetInputId !== state.dispatchIdentity.targetInputId
      || Object.keys(state.dispatchIdentity).length !== 4
      || (['targetInputId', 'coordinatorInputId', 'targetSessionId', 'coordinatorSessionId'] as const).some(key => typeof state.dispatchIdentity![key] !== 'string' || !state.dispatchIdentity![key] || state.dispatchIdentity![key].length > 160)
      || state.dispatchIdentity.targetInputId === state.dispatchIdentity.coordinatorInputId || state.dispatchIdentity.targetSessionId === state.dispatchIdentity.coordinatorSessionId
      || !Number.isFinite(Date.parse(state.lastFeedback.observedAt))))) {
    throw new Error('执行 Mission 尚未就绪或上一轮结果不确定，不能重发。');
  }
  const ownership = options.ownership ?? 'live';
  const outcomeReviewOnly = options.historicalOutcomeReviewOnly === true;
  const failureReviewOnly = options.historicalFailureReviewOnly === true;
  const reviewOnly = outcomeReviewOnly || failureReviewOnly;
  if (outcomeReviewOnly && (options.allowUnreviewedFailures !== true
    || state.phase !== 'sent' || state.lastFeedback?.terminalStatus !== 'error'
    || !state.coordinationFailure?.coordinatorInputId
    || state.coordinationFailure.coordinatorInputId !== state.dispatchIdentity?.coordinatorInputId
    || state.coordinationFailure.targetInputId !== state.dispatchIdentity?.targetInputId)) {
    throw new Error('历史只读审核缺少确切协调失败/已消费输入身份，不能改变 Worker。');
  }
  if (failureReviewOnly && (options.allowUnreviewedFailures !== true || ownership !== 'orphan'
    || state.phase !== 'sent' || !['completed', 'error'].includes(state.lastFeedback?.terminalStatus ?? '')
    || !state.dispatchIdentity || state.lastFeedback?.targetInputId !== state.dispatchIdentity.targetInputId)) {
    throw new Error('历史失败审核必须是 orphan-only 的已收敛已消费输入；不能借此恢复或发送 Worker。');
  }
  if (reviewOnly) await assertReviewedReadHistoricalFactsForReview(composition, projectId, workspace, base, state.missionId, ownership);
  else await assertReviewedReadContinuation(composition, projectId, workspace, base, ownership, state.missionId);
  const task = composition.owners.tasks.getTask(state.missionId)!;
  if (reviewedUnknown && (!state.outcomeReview || state.outcomeReview.disposition !== 'consumed-no-replay'
    || state.outcomeReview.terminalStatus !== 'unknown' || state.outcomeReview.originalObservedAt !== state.lastFeedback!.observedAt
    || JSON.stringify(state.outcomeReview.identity) !== JSON.stringify(state.dispatchIdentity)
    || state.outcomeReview.executionCount !== Object.keys(task.executions).length
    || state.outcomeReview.executionDigest !== practiceOutcomeDigest(task)
    || !Number.isFinite(Date.parse(state.outcomeReview.reviewedAt))
    || Date.parse(state.outcomeReview.reviewedAt) < Date.parse(state.lastFeedback!.observedAt))) {
    throw new Error('UNKNOWN 核实记录与当前输入或执行事实不匹配，不能恢复或发送。');
  }
  if (task.goal !== state.operation.goal || task.mission?.missionType !== state.operation.missionType
    || JSON.stringify(task.mission.completionCriteria) !== JSON.stringify(state.operation.completionCriteria)) throw new Error('Practice 的持久目标与审核指令不一致。');
  const refs = Object.values(task.workerSessions).filter(ref => !ref.detachedAt && !ref.retiredAt);
  const live = composition.owners.workers.listSessions({ taskId: task.taskId });
  const session = composition.owners.workers.getSession(state.managedSessionId);
  if (refs.length !== 1 || refs[0].managedSessionId !== state.managedSessionId || refs[0].workerId !== 'nimora.web-worker'
    || (ownership === 'orphan' ? !!session || live.length !== 0 : live.length !== 1 || !session || session.taskId !== task.taskId
    || refs[0].managedSessionId !== state.managedSessionId || live[0].managedSessionId !== state.managedSessionId
    || session.workerId !== 'nimora.web-worker' || refs[0].workerId !== session.workerId || refs[0].adapterSessionId !== session.adapterSessionId)) {
    throw new Error('Practice Worker 的实时/持久归属无法核实。');
  }
  const executions = Object.values(task.executions);
  if ((inspectingUnknown || reviewedUnknown) && !executions.some(execution =>
    execution.origin?.inputId === state.dispatchIdentity?.targetInputId
    && execution.origin?.managedSessionId === state.dispatchIdentity?.targetSessionId)) {
    throw new Error('UNKNOWN 请求缺少本轮已收敛的工具事实；此核实入口不能处理零执行或未收敛请求。');
  }
  if (state.lastFeedback?.terminalStatus === 'error' && !executions.some(execution => execution.status === 'failed'
    && execution.origin?.inputId === state.dispatchIdentity?.targetInputId
    && execution.origin?.managedSessionId === state.dispatchIdentity?.targetSessionId)) {
    throw new Error('本轮错误缺少匹配的已知工具失败事实，不能续接。');
  }
  if ((state.phase === 'ready' && executions.length) || Object.keys(task.interactions).length
    || executions.some(execution => !['succeeded', 'failed'].includes(execution.status) || execution.deliveryStatus !== 'delivered' || execution.duplicateObservations !== 0
      || execution.origin?.kind !== 'worker' || execution.origin.workerId !== 'nimora.web-worker' || !task.workerSessions[execution.origin.managedSessionId]
      || !execution.finishedAt || !Number.isFinite(Date.parse(execution.finishedAt))
      // A restart-time failure fingerprint may legitimately include later,
      // fully-settled autonomy turns that the legacy reviewed-takeover memento
      // never projected. This mode records failure facts only; it does NOT
      // claim those later turns completed semantically or authorize a send.
      || (!failureReviewOnly && Date.parse(execution.finishedAt) > Date.parse(state.lastFeedback?.observedAt ?? ''))
      || execution.resultPayload?.inputId !== execution.origin.inputId || execution.resultPayload.callId !== execution.origin.callId
      || execution.resultPayload.name !== execution.toolName || execution.resultPayload.isError !== (execution.status === 'failed'))) {
    throw new Error('Practice 有执行或投递未收敛，不会重复执行。');
  }
  if (state.phase !== 'ready' && (task.workerSessions[state.dispatchIdentity!.targetSessionId]?.workerId !== 'nimora.web-worker'
    || composition.owners.tasks.getTask(base.coordinationMissionId)?.workerSessions[state.dispatchIdentity!.coordinatorSessionId]?.workerId !== 'nimora.web-worker')) throw new Error('原执行输入缺少持久来源。');
  if (!options.allowUnreviewedFailures && practiceNeedsFailureReview(task, state.failureReview)) {
    throw new Error('存在已投递的历史失败，先核实结果；核实不会重放原请求。');
  }
  if (ownership === 'live' && !reviewOnly) await composition.owners.workers.withAdapterSessionRetirementScope([{ workerId: session!.workerId, adapterSessionId: session!.adapterSessionId }], async owner => {
    if (!owner.isKnownSettled({ workerId: session!.workerId, adapterSessionId: session!.adapterSessionId })) throw new Error('Practice 网页仍运行或状态未知，没有新请求。');
  });
}
