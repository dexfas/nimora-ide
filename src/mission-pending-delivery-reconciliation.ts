import type { TaskSnapshot } from "./task-contract.js";

/** Read-only picker projection. Canonical application/runtime guards own mutation. */
export interface MissionPendingDeliveryCandidate {
  projectId: string;
  rootMissionId: string;
  missionId: string;
  executionId: string;
  toolName: string;
  executionStatus: "succeeded" | "failed";
  requestedAt: string;
  argumentsDigest?: string;
  managedSessionId: string;
  workerId: string;
  inputId: string;
  callId?: string;
  adapterSessionId: string;
  workerAttachedAt: string;
}

export const MISSION_PENDING_DELIVERY_RECONCILIATION_REASON =
  "Stop future result delivery for the retired or detached origin WorkerSession; this does not determine prior provider receipt; preserve execution facts and do not replay.";

export function missionPendingDeliveryCandidates(task: TaskSnapshot): Readonly<MissionPendingDeliveryCandidate>[] {
  // Task status is only a work projection. Durable Mission finalization alone
  // makes the Mission terminal; status-only completed/failed/cancelled may recover.
  if (!task.mission || task.missionFinalization) return [];
  const candidates: Readonly<MissionPendingDeliveryCandidate>[] = [];
  for (const execution of Object.values(task.executions)) {
    if (execution.deliveryStatus !== "pending" || (execution.status !== "succeeded" && execution.status !== "failed")) continue;
    const origin = execution.origin;
    if (!origin?.managedSessionId) continue;
    const worker = task.workerSessions[origin.managedSessionId];
    if (!worker || worker.workerId !== origin.workerId || (!worker.detachedAt && !worker.retiredAt)) continue;
    candidates.push(Object.freeze({
      projectId: task.mission.projectId,
      rootMissionId: task.mission.rootMissionId,
      missionId: task.taskId,
      executionId: execution.executionId,
      toolName: execution.toolName,
      executionStatus: execution.status,
      requestedAt: execution.requestedAt,
      argumentsDigest: execution.argumentsDigest,
      managedSessionId: origin.managedSessionId,
      workerId: origin.workerId,
      inputId: origin.inputId,
      callId: origin.callId,
      adapterSessionId: worker.adapterSessionId,
      workerAttachedAt: worker.attachedAt,
    }));
  }
  return candidates;
}

/** Reject selection drift; never resolve an execution by a current/replacement route. */
export function requireCurrentMissionPendingDeliveryCandidate(
  task: TaskSnapshot | undefined,
  selected: Readonly<MissionPendingDeliveryCandidate>,
): Readonly<MissionPendingDeliveryCandidate> {
  const current = task && missionPendingDeliveryCandidates(task).find(value => value.executionId === selected.executionId);
  if (!current || Object.keys(current).some(key =>
    current[key as keyof MissionPendingDeliveryCandidate] !== selected[key as keyof MissionPendingDeliveryCandidate])) {
    throw new Error("The selected pending delivery changed or is no longer eligible. Reopen the command to inspect current Mission state.");
  }
  return current;
}
