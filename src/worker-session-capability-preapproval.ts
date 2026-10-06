import { capabilityRegistrySnapshot } from './capability-registry.js';
import type { HostCapabilityExecutionRequest } from './host-capability-execution-coordinator.js';
import type { TaskRuntime } from './task-runtime.js';

/** UX policy only. Actual execution authority remains in TaskCapabilityGranted. */
export interface WorkerSessionAutomationApproval {
  taskId: string;
  managedSessionId: string;
  workerId: string;
  attachedAt: string;
  capabilityIds: string[];
}

export function isAutomationApprovedSession(tasks: TaskRuntime, request: Pick<HostCapabilityExecutionRequest, 'taskId' | 'managedSessionId' | 'workerId'>,
  approvals: readonly WorkerSessionAutomationApproval[]): boolean {
  if (!request.taskId) return false;
  const ref = tasks.getTask(request.taskId)?.workerSessions[request.managedSessionId];
  return !!ref && !ref.detachedAt && !ref.retiredAt && ref.workerId === request.workerId
    && approvals.some(row => row.taskId === request.taskId && row.managedSessionId === request.managedSessionId
      && row.workerId === request.workerId && row.attachedAt === ref.attachedAt);
}

/** Called only AFTER the human accepts the combined execution/permission review.
 * No provider input or tool execution is sent here. Validate the entire list
 * before appending, and fence every append against Worker generation changes.
 */
export async function preapproveWorkerSessionCapabilities(tasks: TaskRuntime,
  input: { taskId: string; managedSessionId: string; workerId: string; capabilityIds: readonly string[] }): Promise<WorkerSessionAutomationApproval> {
  await tasks.initialize();
  const ref = tasks.getTask(input.taskId)?.workerSessions[input.managedSessionId];
  if (!ref || ref.detachedAt || ref.retiredAt || ref.workerId !== input.workerId) throw new Error('自动执行授权的 Worker 归属已改变。');
  const metadata = new Map(capabilityRegistrySnapshot().map(row => [row.id, row]));
  const capabilities = [...new Set(input.capabilityIds)].map(id => {
    const row = metadata.get(id);
    if (!row || (row.approval !== 'none' && row.approval !== 'session')) throw new Error(`不能批量授权该能力：${id}`);
    return row;
  });
  const approval: WorkerSessionAutomationApproval = { taskId: input.taskId, managedSessionId: input.managedSessionId,
    workerId: input.workerId, attachedAt: ref.attachedAt, capabilityIds: capabilities.map(row => row.id) };
  const assertOwner = () => {
    if (!isAutomationApprovedSession(tasks, input, [approval])) throw new Error('自动执行授权期间 Worker 已改变，没有发送任务。');
  };
  for (const capability of capabilities) {
    assertOwner();
    if (capability.approval === 'session') {
      await tasks.grantCapabilityStrict(input.taskId, { capabilityId: capability.id, capabilityVersion: capability.version,
        scope: 'worker-session', managedSessionId: input.managedSessionId });
    }
  }
  assertOwner();
  return approval;
}
