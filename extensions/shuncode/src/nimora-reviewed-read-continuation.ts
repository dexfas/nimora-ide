import type { createMissionWorkProductionComposition } from './mission-work-production-composition.js';
import type { MissionEntryDispatchIdentity } from '../../../src/mission-user-entry-application.js';
import type { ReviewedMissionWorkers, ReviewedReadRecoveryState } from './nimora-reviewed-mission-recovery.js';

type Composition = ReturnType<typeof createMissionWorkProductionComposition>;
export interface ReviewedReadContinuationState extends ReviewedMissionWorkers {
  phase: string;
  dispatchIdentity?: MissionEntryDispatchIdentity;
  lastFeedback?: { terminalStatus: string; observedAt: string; targetInputId?: string };
}

/** Presentation may offer an action; this predicate NEVER authorizes dispatch. */
export function reviewedReadContinuationAction(state: ReviewedReadRecoveryState | undefined,
  live: readonly { managedSessionId: string }[]): 'continue-read' | 'restore-read' | undefined {
  const identity = state?.dispatchIdentity && typeof state.dispatchIdentity === 'object'
    ? state.dispatchIdentity as Partial<MissionEntryDispatchIdentity> : undefined;
  if (state?.phase !== 'mission-sent' || state.lastFeedback?.terminalStatus !== 'completed'
    || !identity?.targetInputId || state.lastFeedback.targetInputId !== identity.targetInputId
    || !state.rootSessionId || !state.coordinatorSessionId) return undefined;
  return [state.rootSessionId, state.coordinatorSessionId].every(id => live.filter(row => row.managedSessionId === id).length === 1)
    ? 'continue-read' : 'restore-read';
}

/** Narrow continuation of an actually successful, delivered Cognition READ.
 * The memento is provenance only; canonical execution/delivery and live
 * provider settlement remain independent gates. No write policy is granted.
 */
async function inspectReviewedReadFacts(composition: Composition, projectId: string,
  workspace: string, state: ReviewedReadContinuationState, ownership: 'live' | 'orphan' = 'live',
  practiceMissionId?: string, historicalReviewOnly = false): Promise<void> {
  const identity = state.dispatchIdentity;
  const identityKeys = ['coordinatorInputId', 'targetInputId', 'coordinatorSessionId', 'targetSessionId'] as const;
  if (state.phase !== 'mission-sent' || state.lastFeedback?.terminalStatus !== 'completed' || !identity
    || Object.keys(identity).length !== identityKeys.length || identityKeys.some(key => typeof identity[key] !== 'string' || !identity[key] || identity[key].length > 160)
    || identity.coordinatorInputId === identity.targetInputId || identity.coordinatorSessionId === identity.targetSessionId
    || state.lastFeedback.targetInputId !== identity.targetInputId || !Number.isFinite(Date.parse(state.lastFeedback.observedAt))
    || !state.rootMissionId || !state.coordinationMissionId || state.rootMissionId === state.coordinationMissionId
    || !state.rootSessionId || !state.coordinatorSessionId || state.rootSessionId === state.coordinatorSessionId
    || state.pageIds?.length !== 2 || new Set(state.pageIds).size !== 2) throw new Error('上一轮缺少确切成功身份，不能继续或恢复。');
  await Promise.all([composition.owners.projects.initialize(), composition.owners.tasks.initialize()]);
  const project = composition.owners.projects.getProject(projectId);
  if (project?.formationReceipt?.project.workspace !== workspace || project.formationReceipt.authorization.kind !== 'human-confirmed') {
    throw new Error('Project 的审核或工作区身份已改变，没有发送。');
  }
  const scope = await composition.coordinator.inspectManagedScope({ projectId, managedRootMissionId: state.rootMissionId });
  if (scope.coordinationMissionId !== state.coordinationMissionId || scope.missions.length !== (practiceMissionId ? 3 : 2)) throw new Error('原 Mission 范围已改变，没有发送。');
  if (practiceMissionId) {
    const practice = composition.owners.tasks.getTask(practiceMissionId);
    if (!scope.missions.some(row => row.missionId === practiceMissionId) || !practice?.mission
      || practice.mission.projectId !== projectId || practice.mission.rootMissionId !== state.rootMissionId
      || practice.mission.parentMissionId !== state.rootMissionId || practice.mission.plane !== 'practice'
      || practice.missionFinalization || ['completed', 'failed', 'cancelled'].includes(practice.status)) throw new Error('新增执行子 Mission 的范围不可核实。');
  }
  const identities: Array<{ workerId: string; adapterSessionId: string }> = [];
  for (const [missionId, sessionId, sourceSessionId, plane] of [
    [state.rootMissionId, state.rootSessionId, identity.targetSessionId, 'cognition'],
    [state.coordinationMissionId, state.coordinatorSessionId, identity.coordinatorSessionId, 'coordination'],
  ] as const) {
    const task = composition.owners.tasks.getTask(missionId);
    const refs = task && Object.values(task.workerSessions).filter(ref => !ref.detachedAt && !ref.retiredAt);
    if (!task?.mission || task.mission.projectId !== projectId || task.mission.rootMissionId !== state.rootMissionId
      || task.mission.plane !== plane || task.missionFinalization || ['completed', 'failed', 'cancelled'].includes(task.status)
      || Object.keys(task.interactions).length || !refs || refs.length !== 1 || refs[0].managedSessionId !== sessionId
      || refs[0].workerId !== 'nimora.web-worker' || task.workerSessions[sourceSessionId]?.workerId !== 'nimora.web-worker') {
      throw new Error('Mission、原执行来源或当前 Worker 身份不可核实，没有发送。');
    }
    const executions = Object.values(task.executions);
    if (plane === 'coordination' ? executions.length !== 0 : executions.some(execution => execution.toolName !== 'read_files'
      || execution.capabilityId !== 'workspace.read-files' || execution.status !== 'succeeded' || execution.deliveryStatus !== 'delivered'
      || execution.duplicateObservations !== 0 || execution.origin?.kind !== 'worker'
      || execution.origin.workerId !== 'nimora.web-worker' || !task.workerSessions[execution.origin.managedSessionId]
      || execution.resultPayload?.isError !== false || execution.resultPayload.inputId !== execution.origin.inputId
      || execution.resultPayload.callId !== execution.origin.callId || execution.resultPayload.name !== 'read_files')) {
      throw new Error('存在未收敛、失败或非只读执行，不能继续或恢复。');
    }
    if (plane === 'cognition' && !executions.some(execution => execution.origin?.inputId === identity.targetInputId
      && execution.origin.managedSessionId === identity.targetSessionId && execution.finishedAt
      && Date.parse(execution.finishedAt) <= Date.parse(state.lastFeedback!.observedAt))) {
      throw new Error('上一轮没有实际成功并投递的 READ；网页完成提示不能授权继续。');
    }
    const live = composition.owners.workers.listSessions({ taskId: missionId });
    const session = composition.owners.workers.getSession(sessionId);
    if (ownership === 'orphan') {
      if (session || live.length) throw new Error('原 Worker 仍由当前宿主持有，不能采用孤儿恢复。');
    } else {
      if (!session || live.length !== 1 || live[0].managedSessionId !== sessionId || session.taskId !== missionId
        || session.workerId !== refs[0].workerId || session.adapterSessionId !== refs[0].adapterSessionId) throw new Error('原网页连接已失去，先显式恢复，不会自动续发。');
      identities.push({ workerId: session.workerId, adapterSessionId: session.adapterSessionId });
    }
  }
  if (ownership === 'live' && !historicalReviewOnly) await composition.owners.workers.withAdapterSessionRetirementScope(identities, async owner => {
    const blocked = identities.flatMap((identity, index) => {
      if (owner.isKnownSettled(identity)) return [];
      const facts = owner.inspectSettlement?.(identity);
      if (!facts) return [index === 0 ? 'Cognition：会话结案未确认' : 'Coordinator：会话结案未确认'];
      const reasons = [
        !facts.sessionPresent ? '实时会话不存在' : '',
        facts.state && facts.state !== 'idle' ? `会话状态 ${facts.state}` : '',
        facts.activeSendLeases ? `发送仍持有 ${facts.activeSendLeases} 个租约` : '',
        facts.hostCapabilityRequests ? `${facts.hostCapabilityRequests} 个工具结果回传待确认` : '',
        facts.abandonedSendCleanups ? `${facts.abandonedSendCleanups} 个中断清理未完成` : '',
        facts.unsettledProviderSends ? `${facts.unsettledProviderSends} 个旧 Provider 回执未知` : '',
      ].filter(Boolean);
      return [`${index === 0 ? 'Cognition' : 'Coordinator'}：${reasons.join('、') || '结案依据不足'}`];
    });
    if (blocked.length) throw new Error(`Provider 收尾未确认，已阻止新请求（${blocked.join('；')}）。请审核上轮事实并显式恢复或替换对应 Worker，不能重发旧输入。`);
  });
}

/** READ-ONLY review of settled local task facts; this is NEVER dispatch authority. */
export async function assertReviewedReadHistoricalFactsForReview(composition: Composition, projectId: string,
  workspace: string, state: ReviewedReadContinuationState, practiceMissionId: string,
  ownership: 'live' | 'orphan' = 'live'): Promise<void> {
  if (!practiceMissionId) throw new Error('历史审核必须指定确切 Practice Mission。');
  return inspectReviewedReadFacts(composition, projectId, workspace, state, ownership, practiceMissionId, true);
}

export async function assertReviewedReadContinuation(composition: Composition, projectId: string,
  workspace: string, state: ReviewedReadContinuationState, ownership: 'live' | 'orphan' = 'live', practiceMissionId?: string): Promise<void> {
  return inspectReviewedReadFacts(composition, projectId, workspace, state, ownership, practiceMissionId, false);
}

/** Recover only the same two pages after canonical successful READ settlement.
 * Canonical orphan owner proves process death. Partial failure stays blocked.
 */
export async function recoverReviewedSettledReadWorkers(composition: Composition, projectId: string,
  workspace: string, state: ReviewedReadContinuationState, listResources: () => Promise<unknown>,
  beforeMutation: () => Promise<void>, onAttached: (role: 'coordinator' | 'target' | 'practice', id: string) => Promise<void>,
  practice?: { missionId: string; sessionId: string; pageId: string; assertSettled: () => Promise<void> }): Promise<ReviewedMissionWorkers & { practiceSessionId?: string }> {
  await assertReviewedReadContinuation(composition, projectId, workspace, state, 'orphan', practice?.missionId);
  await practice?.assertSettled();
  const roles: Array<{ role: 'coordinator' | 'target' | 'practice'; missionId: string; sessionId: string; pageId: string }> = [
    { role: 'coordinator' as const, missionId: state.coordinationMissionId, sessionId: state.coordinatorSessionId, pageId: state.pageIds[0] },
    { role: 'target' as const, missionId: state.rootMissionId, sessionId: state.rootSessionId, pageId: state.pageIds[1] },
  ];
  if (practice) {
    if (!practice.sessionId || !practice.pageId || roles.some(row => row.pageId === practice.pageId || row.sessionId === practice.sessionId)) throw new Error('执行 Worker 的原网页身份冲突。');
    roles.push({ role: 'practice', missionId: practice.missionId, sessionId: practice.sessionId, pageId: practice.pageId });
  }
  const inspect = async () => {
    const raw = await listResources();
    if (!Array.isArray(raw) || raw.length > 32) throw new Error('共享网页清单不可核实。');
    return roles.map(role => {
      const matches = raw.filter(row => row?.pageId === role.pageId);
      const label = role.role === 'coordinator' ? 'Coordinator' : role.role === 'target' ? 'Cognition' : 'Practice';
      if (!matches.length) throw new Error(`${label} 的原 DeepSeek 页面未出现在已共享网页清单。请检查原页面是否仍打开并已共享；不允许用新页面代替原身份。`);
      if (matches.length !== 1) throw new Error(`${label} 的原 DeepSeek 页面身份不唯一，禁止恢复；不自动选择或重新发送。`);
      const row = matches[0];
      if (row.site !== 'deepseek' || row.origin !== 'https://chat.deepseek.com'
        || row.nativeMcpBypass !== false || row.sessionIdentityCompatible !== true
        || !/^[a-f0-9]{64}$/.test(row.resourceIdentity)) {
        throw new Error(`${label} 的原网页提供商、MCP 或资源身份不匹配，禁止恢复；请核实原页面。`);
      }
      if (row.workerTurnState === 'running') throw new Error(`${label} 的原网页仍在运行；必须先核实该轮结果，不得恢复或重发。`);
      if (row.ready !== true) throw new Error(`${label} 的原网页尚未就绪；请检查登录及原页面的共享状态，不会自动更换 Worker。`);
      return { ...role, candidateId: `webmcp:${row.resourceIdentity}` };
    });
  };
  const pages = await inspect();
  if (new Set(pages.map(row => row.candidateId)).size !== pages.length) throw new Error('原网页资源身份冲突。');
  await beforeMutation();
  await assertReviewedReadContinuation(composition, projectId, workspace, state, 'orphan', practice?.missionId);
  await practice?.assertSettled();
  const fresh = await inspect();
  if (fresh.some((row, index) => row.candidateId !== pages[index].candidateId)) throw new Error('审核期间网页身份改变。');
  const restored: ReviewedMissionWorkers & { practiceSessionId?: string } = { rootMissionId: state.rootMissionId, coordinationMissionId: state.coordinationMissionId,
    rootSessionId: state.rootSessionId, coordinatorSessionId: state.coordinatorSessionId, pageIds: [...state.pageIds] };
  for (const role of pages) {
    await composition.application.recoverOrphanedAssignedWorker({ projectId, rootMissionId: state.rootMissionId,
      missionId: role.missionId, managedSessionId: role.sessionId, reason: 'reviewed-successful-read-delivered-no-replay' });
    const result = await composition.application.assignInitialWorker({ projectId, rootMissionId: state.rootMissionId, missionId: role.missionId,
      constraints: { allowedKinds: ['web'], allowedProviders: ['deepseek'],
        ...(role.role === 'coordinator' ? { requiredCapabilities: { capabilityRequests: true } } : {}) } }, { exactCandidateId: role.candidateId });
    if (result.state !== 'assigned') throw new Error('原网页未能恢复 canonical Worker；保留部分状态，不重试。');
    if (role.role === 'coordinator') restored.coordinatorSessionId = result.assignment.managedSessionId;
    else if (role.role === 'target') restored.rootSessionId = result.assignment.managedSessionId;
    else restored.practiceSessionId = result.assignment.managedSessionId;
    await onAttached(role.role, result.assignment.managedSessionId);
  }
  return restored;
}
