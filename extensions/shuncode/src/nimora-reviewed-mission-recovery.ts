import type { createMissionWorkProductionComposition } from './mission-work-production-composition.js';

type Composition = ReturnType<typeof createMissionWorkProductionComposition>;
export interface ReviewedMissionWorkers {
  rootMissionId: string;
  coordinationMissionId: string;
  rootSessionId: string;
  coordinatorSessionId: string;
  /** Native identities approved for these exact roles, never an arbitrary old planning page. */
  pageIds: string[];
}

export interface ReviewedReadRecoveryState {
  phase: string;
  previousAttempt?: { state: string };
  dispatchIdentity?: unknown;
  rootSessionId?: string;
  coordinatorSessionId?: string;
  lastFeedback?: { terminalStatus: string; observedAt: string; targetInputId?: string };
  consumedDispatches?: Array<{ identity: Readonly<Record<string, string>>; state: 'consumed-no-replay'; reviewedAt: string }>;
  practice?: import('./nimora-reviewed-practice-entry.js').ReviewedPracticeState;
  replacement?: { mutationStarted?: boolean; nativeApprovedPageIds?: readonly string[];
    assigned?: Partial<Record<'coordinator' | 'target' | 'practice', string>> };
}

export interface ReviewedActiveMissionWorkerState extends ReviewedMissionWorkers {
  practiceMissionId: string;
  practiceSessionId: string;
  practicePageId: string;
}

type ReviewedRecoveryRole = 'coordinator' | 'target' | 'practice';

function executionDeliveryIsSettled(execution: {
  status?: string;
  deliveryStatus?: string;
  deliveryAbandonedAt?: string;
  deliveryAbandonmentReason?: string;
}): boolean {
  if (execution.status !== 'succeeded' && execution.status !== 'failed') return false;
  if (execution.deliveryStatus === 'delivered') return true;
  return execution.deliveryStatus === 'abandoned'
    && typeof execution.deliveryAbandonedAt === 'string' && !!execution.deliveryAbandonedAt
    && typeof execution.deliveryAbandonmentReason === 'string' && !!execution.deliveryAbandonmentReason.trim();
}

/**
 * Generic restart recovery for an already-active reviewed Mission tree.
 * This proves lifecycle facts only. It never interprets or replays old work.
 */
export async function recoverReviewedSettledMissionWorkers(
  composition: Composition,
  projectId: string,
  workspace: string,
  original: ReviewedActiveMissionWorkerState,
  listResources: () => Promise<unknown>,
  beforeMutation: () => Promise<void>,
  onAttached: (role: ReviewedRecoveryRole, managedSessionId: string) => Promise<void>,
): Promise<ReviewedMissionWorkers & { practiceSessionId: string }> {
  if (!original || original.pageIds?.length !== 2 || new Set([...original.pageIds, original.practicePageId]).size !== 3
    || !original.rootMissionId || !original.coordinationMissionId || !original.practiceMissionId
    || new Set([original.rootMissionId, original.coordinationMissionId, original.practiceMissionId]).size !== 3
    || !original.rootSessionId || !original.coordinatorSessionId || !original.practiceSessionId
    || new Set([original.rootSessionId, original.coordinatorSessionId, original.practiceSessionId]).size !== 3) {
    throw new Error('活动 Mission 恢复要求三个不同 Mission、Worker 与原生页面的精确身份。');
  }
  await Promise.all([composition.owners.projects.initialize(), composition.owners.tasks.initialize()]);
  const project = composition.owners.projects.getProject(projectId);
  if (project?.formationReceipt?.project.workspace !== workspace
    || project.formationReceipt.authorization.kind !== 'human-confirmed') {
    throw new Error('Project 的人工审核或工作区身份不一致，不能恢复活动 Mission Worker。');
  }
  const roles = [
    { role: 'coordinator' as const, missionId: original.coordinationMissionId, sessionId: original.coordinatorSessionId, pageId: original.pageIds[0], plane: 'coordination' },
    { role: 'target' as const, missionId: original.rootMissionId, sessionId: original.rootSessionId, pageId: original.pageIds[1], plane: 'cognition' },
    { role: 'practice' as const, missionId: original.practiceMissionId, sessionId: original.practiceSessionId, pageId: original.practicePageId, plane: 'practice' },
  ];

  const assertCanonicalScope = async () => {
    const inspection = await composition.coordinator.inspectManagedScope({ projectId, managedRootMissionId: original.rootMissionId });
    if (inspection.coordinationMissionId !== original.coordinationMissionId || inspection.missions.length !== 3
      || !roles.every(role => inspection.missions.some(mission => mission.missionId === role.missionId))) {
      throw new Error('活动 Project 的三 Mission 范围已改变，不能按旧 Worker 身份恢复。');
    }
    const durableByRole = new Map<ReviewedRecoveryRole, { workerId: string; adapterSessionId: string }>();
    for (const role of roles) {
      const task = composition.owners.tasks.getTask(role.missionId);
      const refs = task && Object.values(task.workerSessions).filter(ref => !ref.detachedAt && !ref.retiredAt);
      if (!task?.mission || task.mission.projectId !== projectId || task.mission.rootMissionId !== original.rootMissionId
        || task.mission.plane !== role.plane || task.missionFinalization
        || ['completed', 'failed', 'cancelled'].includes(task.status)
        || !refs || refs.length !== 1 || refs[0].managedSessionId !== role.sessionId
        || refs[0].workerId !== 'nimora.web-worker' || typeof refs[0].adapterSessionId !== 'string' || !refs[0].adapterSessionId
        || Object.values(task.interactions).some(interaction => !interaction.finishedAt)
        || Object.values(task.executions).some(execution => !executionDeliveryIsSettled(execution))) {
        throw new Error(`${role.role} Mission 的持久执行、结果投递或 Worker 身份尚未完全收敛；不能恢复 owner。`);
      }
      if (composition.owners.workers.listSessions({ taskId: role.missionId }).some(session => session.state !== 'disposed')) {
        throw new Error(`${role.role} Mission 仍有当前 Host 的 live Worker；不能采用 orphan restart recovery。`);
      }
      durableByRole.set(role.role, { workerId: refs[0].workerId, adapterSessionId: refs[0].adapterSessionId });
    }
    return durableByRole;
  };

  const inspectPages = async (durableByRole: Map<ReviewedRecoveryRole, { workerId: string; adapterSessionId: string }>) => {
    const raw = await listResources();
    if (!Array.isArray(raw) || raw.length > 32) throw new Error('共享页面清单无法完整读取，不能恢复活动 Mission Worker。');
    const pages = roles.map(role => {
      const matches = raw.filter(row => row?.pageId === role.pageId);
      const row = matches.length === 1 ? matches[0] as Record<string, unknown> : undefined;
      const durable = durableByRole.get(role.role)!;
      const turn = typeof row?.workerTurnState === 'string' ? row.workerTurnState : '';
      if (!row || row.site !== 'deepseek' || row.origin !== 'https://chat.deepseek.com'
        || row.ready !== true || row.nativeMcpBypass !== false || row.sessionIdentityCompatible !== true
        || !['', 'idle', 'completed', 'cancelled', 'error'].includes(turn)
        || typeof row.resourceIdentity !== 'string' || !/^[a-f0-9]{64}$/.test(row.resourceIdentity)
        || typeof row.pageSessionId !== 'string' || row.pageSessionId !== durable.adapterSessionId) {
        throw new Error(`${role.role} 的原 DeepSeek 页面未就绪、仍在运行、Provider 身份改变或不再唯一；不能恢复。`);
      }
      return { ...role, candidateId: `webmcp:${row.resourceIdentity}`, adapterSessionId: durable.adapterSessionId };
    });
    if (new Set(pages.map(page => page.candidateId)).size !== 3) throw new Error('三个原页面的当前资源身份发生冲突。');
    return pages;
  };

  let durableByRole = await assertCanonicalScope();
  const observed = await inspectPages(durableByRole);
  await beforeMutation();
  durableByRole = await assertCanonicalScope();
  const fresh = await inspectPages(durableByRole);
  if (fresh.some((row, index) => row.candidateId !== observed[index].candidateId
    || row.adapterSessionId !== observed[index].adapterSessionId)) {
    throw new Error('确认期间原 Provider 页面身份发生变化；没有恢复 Worker。');
  }

  const attached: Partial<Record<ReviewedRecoveryRole, string>> = {};
  for (const role of fresh) {
    await composition.application.recoverOrphanedAssignedWorker({
      projectId, rootMissionId: original.rootMissionId, missionId: role.missionId,
      managedSessionId: role.sessionId, reason: 'reviewed-settled-mission-restart-no-replay',
    });
    const candidates = await composition.webCandidates.enumerateCandidates();
    const candidate = candidates.filter(candidate => candidate.candidateId === role.candidateId
      && candidate.workerId === 'nimora.web-worker' && candidate.provider === 'deepseek'
      && candidate.kind === 'web' && candidate.availability === 'available' && candidate.health?.status === 'healthy');
    if (candidate.length !== 1) throw new Error(`${role.role} 原页面在旧 owner 退休后未形成唯一健康候选；保留部分恢复事实，不自动重试。`);
    const refreshed = await composition.webCandidates.refreshCandidate(candidate[0]);
    if (!refreshed || refreshed.candidateId !== role.candidateId || refreshed.availability !== 'available'
      || refreshed.health?.status !== 'healthy') throw new Error(`${role.role} 原页面刚刚失去健康状态；保留部分恢复事实。`);
    const options = await composition.webCandidates.materializeSessionOptions(refreshed, {});
    const target = options.extensions?.webMcpTarget as { pageId?: string; resourceIdentity?: string; pageSessionId?: string } | undefined;
    if (!target || target.pageId !== role.pageId || target.resourceIdentity !== role.candidateId.slice('webmcp:'.length)
      || target.pageSessionId !== role.adapterSessionId) {
      throw new Error(`${role.role} 原页面无法证明同一 provider-native 会话身份；禁止恢复。`);
    }
    const result = await composition.application.assignInitialWorker({
      projectId, rootMissionId: original.rootMissionId, missionId: role.missionId,
      constraints: { allowedKinds: ['web'], allowedProviders: ['deepseek'],
        ...(role.role === 'coordinator' ? { requiredCapabilities: { capabilityRequests: true } } : {}) },
    }, { exactCandidateId: role.candidateId });
    if (result.state !== 'assigned' || result.assignment.candidateId !== role.candidateId
      || Object.values(attached).includes(result.assignment.managedSessionId)) {
      throw new Error(`${role.role} 原页面未能形成唯一的新 canonical owner；保留部分恢复事实，禁止重放。`);
    }
    attached[role.role] = result.assignment.managedSessionId;
    await onAttached(role.role, result.assignment.managedSessionId);
  }
  return {
    rootMissionId: original.rootMissionId,
    coordinationMissionId: original.coordinationMissionId,
    rootSessionId: attached.target!,
    coordinatorSessionId: attached.coordinator!,
    pageIds: [...original.pageIds],
    practiceSessionId: attached.practice!,
  };
}

const dispatchKeys = ['coordinatorInputId', 'targetInputId', 'coordinatorSessionId', 'targetSessionId'] as const;
function dispatchIdentity(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== dispatchKeys.length || dispatchKeys.some(key => typeof row[key] !== 'string' || !row[key] || (row[key] as string).length > 160)
    || row.targetInputId === row.coordinatorInputId || row.targetSessionId === row.coordinatorSessionId) return undefined;
  return row as Readonly<Record<string, string>>;
}

function reviewedConsumedDispatch(state: ReviewedReadRecoveryState): boolean {
  const identity = dispatchIdentity(state.dispatchIdentity);
  return !!identity && !!state.consumedDispatches?.some(attempt => attempt.state === 'consumed-no-replay'
    && !!attempt.reviewedAt && dispatchKeys.every(key => attempt.identity[key] === identity[key]));
}

/** A later dispatched readonly failure needs explicit review and preserved
 * consumption history. UNKNOWN execution never grants recovery authority.
 */
export function reviewedReadRecoveryKind(state: ReviewedReadRecoveryState | undefined): 'failed-first-read' | 'unstarted-reconciled' | 'review-dispatched-read' | 'review-unknown-read' | undefined {
  if (state?.phase === 'mission-unknown' && !state.previousAttempt) return 'failed-first-read';
  if (state?.phase === 'mission-reconciled' && state.previousAttempt?.state === 'consumed-no-replay'
    && (!state.dispatchIdentity || reviewedConsumedDispatch(state))) return 'unstarted-reconciled';
  const identity = dispatchIdentity(state?.dispatchIdentity);
  // mission-sent means the owning driver returned terminal transport feedback,
  // not that any tool ran. Reconciliation still requires explicit evidence
  // review, zero canonical execution/interaction and exact machine owner death.
  if ((state?.phase === 'mission-sent' || state?.phase === 'mission-unknown') && state.previousAttempt?.state === 'consumed-no-replay' && identity
    && identity.targetSessionId === state.rootSessionId && identity.coordinatorSessionId === state.coordinatorSessionId
    && state.lastFeedback?.terminalStatus !== 'completed'
    && (!state.lastFeedback?.targetInputId || state.lastFeedback.targetInputId === identity.targetInputId)
    && (state.consumedDispatches?.length ?? 0) < 32) {
    // This presentation phase is NOT a Task execution status or settlement
    // receipt. Offer review only: canonical zero-execution/interaction checks,
    // absent live ownership and machine-proven orphan retirement still own
    // admission. Running/UNKNOWN execution can never pass those checks.
    return state.phase === 'mission-sent' ? 'review-dispatched-read' : 'review-unknown-read';
  }
  return undefined;
}

export function reviewedReadAction(state: ReviewedReadRecoveryState | undefined,
  live: readonly { managedSessionId: string }[] = []): 'reconcile' | 'send' | undefined {
  const kind = reviewedReadRecoveryKind(state);
  if (kind === 'failed-first-read' || kind === 'review-dispatched-read' || kind === 'review-unknown-read') return 'reconcile';
  if (kind !== 'unstarted-reconciled') return undefined;
  return state!.rootSessionId && state!.coordinatorSessionId
    && [state!.rootSessionId, state!.coordinatorSessionId].every(id => live.filter(row => row.managedSessionId === id).length === 1)
    ? 'send' : 'reconcile';
}

/** Read actual canonical + in-process ownership; a UI cache is not authority. */
export async function assertReviewedFreshReadWorkers(composition: Composition,
  projectId: string, workspace: string, original: ReviewedMissionWorkers): Promise<void> {
  await Promise.all([composition.owners.projects.initialize(), composition.owners.tasks.initialize()]);
  const project = composition.owners.projects.getProject(projectId);
  if (project?.formationReceipt?.project.workspace !== workspace
    || project.formationReceipt.authorization.kind !== 'human-confirmed') throw new Error('Project 的人工审核或工作区身份不一致，没有发送。');
  const inspection = await composition.coordinator.inspectManagedScope({ projectId, managedRootMissionId: original.rootMissionId });
  if (inspection.coordinationMissionId !== original.coordinationMissionId || inspection.missions.length !== 2
    || original.rootMissionId === original.coordinationMissionId || original.rootSessionId === original.coordinatorSessionId) {
    throw new Error('原 Project 的双 Mission 或 Worker 身份不一致，没有发送。');
  }
  const identities = [
    [original.rootMissionId, original.rootSessionId], [original.coordinationMissionId, original.coordinatorSessionId],
  ].map(([missionId, sessionId]) => {
    const task = composition.owners.tasks.getTask(missionId);
    const refs = task && Object.values(task.workerSessions).filter(ref => !ref.detachedAt && !ref.retiredAt);
    if (!task?.mission || task.mission.projectId !== projectId || task.mission.rootMissionId !== original.rootMissionId
      || task.missionFinalization || Object.keys(task.executions).length || Object.keys(task.interactions).length
      || !refs || refs.length !== 1 || refs[0].managedSessionId !== sessionId) {
      throw new Error('首个只读范围已有执行、交互、结束或绑定变化；没有发送。');
    }
    const session = composition.owners.workers.getSession(sessionId);
    const live = composition.owners.workers.listSessions({ taskId: missionId });
    if (!session || live.length !== 1 || live[0].managedSessionId !== sessionId) {
      throw new Error('当前进程没有持有原 Worker；请使用“恢复本次网页连接”，没有发送。');
    }
    if (session.taskId !== missionId || session.workerId !== refs[0].workerId || session.adapterSessionId !== refs[0].adapterSessionId) {
      throw new Error('实时 Worker 与持久绑定身份不一致，没有发送。');
    }
    return { workerId: session.workerId, adapterSessionId: session.adapterSessionId };
  });
  await composition.owners.workers.withAdapterSessionRetirementScope(identities, async owner => {
    if (identities.some(identity => !owner.isKnownSettled(identity))) throw new Error('Worker 尚未确认停止或仍有未收敛结果，没有发送。');
  });
}

/** Narrow zero-execution readonly connection recovery, not an UNKNOWN waiver.
 * No provider send, result resolve, transcript import or Task journal editing.
 * The canonical recovery owner must prove the old process dead for each role.
 * Any partial failure stays blocked; this operation is not automatically retried.
 */
export async function recoverReviewedFirstReadWorkers(
  composition: Composition, projectId: string, workspace: string, original: ReviewedMissionWorkers,
  listResources: () => Promise<unknown>,
  beforeMutation: () => Promise<void>,
  onAttached: (role: 'coordinator' | 'target', managedSessionId: string) => Promise<void>,
): Promise<ReviewedMissionWorkers> {
  if (!original || original.pageIds.length !== 2 || new Set(original.pageIds).size !== 2
    || !original.rootSessionId || !original.coordinatorSessionId || original.rootSessionId === original.coordinatorSessionId
    || !original.rootMissionId || !original.coordinationMissionId || original.rootMissionId === original.coordinationMissionId) {
    throw new Error('原接管记录没有两张独立页面及确切 Worker 身份；不能推测恢复对象。');
  }
  await Promise.all([composition.owners.projects.initialize(), composition.owners.tasks.initialize()]);
  const project = composition.owners.projects.getProject(projectId);
  if (project?.formationReceipt?.project.workspace !== workspace
    || project.formationReceipt.authorization.kind !== 'human-confirmed') throw new Error('Project 的人工审核或工作区身份不一致。');
  const inspection = await composition.coordinator.inspectManagedScope({ projectId, managedRootMissionId: original.rootMissionId });
  if (inspection.coordinationMissionId !== original.coordinationMissionId || inspection.missions.length !== 2) {
    throw new Error('原 Project 的双 Mission 范围已改变；不能采用首个只读请求的恢复路径。');
  }
  const roles = [
    { role: 'coordinator' as const, missionId: original.coordinationMissionId, sessionId: original.coordinatorSessionId, pageId: original.pageIds[0] },
    { role: 'target' as const, missionId: original.rootMissionId, sessionId: original.rootSessionId, pageId: original.pageIds[1] },
  ];
  const assertUnexecutedScope = () => {
    for (const role of roles) {
      const task = composition.owners.tasks.getTask(role.missionId);
      const refs = task && Object.values(task.workerSessions).filter(ref => !ref.detachedAt && !ref.retiredAt);
      if (!task?.mission || task.mission.projectId !== projectId || task.mission.rootMissionId !== original.rootMissionId
        || task.missionFinalization || Object.keys(task.executions).length || Object.keys(task.interactions).length
        || !refs || refs.length !== 1 || refs[0].managedSessionId !== role.sessionId) {
        throw new Error('原请求存在执行、交互、结束状态或 Worker 身份变化；必须单独核实，不能恢复首个只读入口。');
      }
      if (composition.owners.workers.getSession(role.sessionId)) {
        throw new Error('旧 Worker 仍由当前进程持有；先保留失败证据并正常重载测试窗口，不能把 idle 当作已收敛。');
      }
    }
  };
  assertUnexecutedScope();
  const inspectPages = async () => {
    const raw = await listResources();
    if (!Array.isArray(raw) || raw.length > 32) throw new Error('共享页面清单无法完整读取。');
    return roles.map(role => {
      const matches = raw.filter(row => row?.pageId === role.pageId);
      const row = matches.length === 1 ? matches[0] : undefined;
      if (!row || row.site !== 'deepseek' || row.origin !== 'https://chat.deepseek.com'
        || row.ready !== true || row.nativeMcpBypass !== false || row.sessionIdentityCompatible !== true
        || row.workerTurnState === 'running' || !/^[a-f0-9]{64}$/.test(row.resourceIdentity)) {
        throw new Error('原角色页面未共享、未就绪或身份不唯一；没有打开替代页面或发送请求。');
      }
      return { ...role, candidateId: `webmcp:${row.resourceIdentity}` };
    });
  };
  const pages = await inspectPages();
  if (pages[0].candidateId === pages[1].candidateId) throw new Error('两个角色的当前资源身份冲突。');
  // Permission/presentation awaits must not turn stale observations into authority.
  await beforeMutation();
  assertUnexecutedScope();
  const fresh = await inspectPages();
  if (fresh.some((row, index) => row.candidateId !== pages[index].candidateId)) throw new Error('确认期间页面身份发生变化；没有恢复 Worker。');
  const attached = { ...original, pageIds: [...original.pageIds] };
  for (const role of pages) {
    await composition.application.recoverOrphanedAssignedWorker({
      projectId, rootMissionId: original.rootMissionId, missionId: role.missionId,
      managedSessionId: role.sessionId, reason: 'human-reconciled-first-read-no-replay-after-native-reload',
    });
    const result = await composition.application.assignInitialWorker({
      projectId, rootMissionId: original.rootMissionId, missionId: role.missionId,
      constraints: { allowedKinds: ['web'], allowedProviders: ['deepseek'],
        ...(role.role === 'coordinator' ? { requiredCapabilities: { capabilityRequests: true } } : {}) },
    }, { exactCandidateId: role.candidateId });
    if (result.state !== 'assigned') throw new Error('原页面未能形成新的 canonical Worker；保留部分恢复事实，不自动重复绑定。');
    if (role.role === 'coordinator') attached.coordinatorSessionId = result.assignment.managedSessionId;
    else attached.rootSessionId = result.assignment.managedSessionId;
    await onAttached(role.role, result.assignment.managedSessionId);
  }
  return attached;
}
