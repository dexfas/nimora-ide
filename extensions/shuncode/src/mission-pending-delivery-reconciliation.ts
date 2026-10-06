import * as vscode from "vscode";
import {
  MISSION_PENDING_DELIVERY_RECONCILIATION_REASON,
  missionPendingDeliveryCandidates,
  requireCurrentMissionPendingDeliveryCandidate,
} from "../../../src/mission-pending-delivery-reconciliation.js";
import type { createMissionWorkProductionComposition } from "./mission-work-production-composition.js";

type MissionComposition = ReturnType<typeof createMissionWorkProductionComposition>;
const STOP_FUTURE_DELIVERY = "Stop Future Delivery";

/** Explicit user reconciliation of one exact old result; sends/execution are never retried. */
export async function reconcileMissionPendingDelivery(composition: MissionComposition, ready: Promise<unknown>): Promise<void> {
  if (!vscode.workspace.isTrusted) throw new Error("Pending result reconciliation requires a trusted workspace.");
  await ready;
  const tasks = composition.owners.tasks;
  await tasks.initialize();
  const items = [];
  for (const task of tasks.listTasks()) {
    if (!task.mission || task.missionFinalization) continue;
    const current = await tasks.rereadTask(task.taskId);
    if (!current) continue;
    for (const candidate of missionPendingDeliveryCandidates(current)) {
      items.push({
        label: `${candidate.toolName} · ${candidate.executionStatus}`,
        description: current.goal || candidate.missionId,
        detail: `Mission ${candidate.missionId} | execution ${candidate.executionId} | input ${candidate.inputId} | origin ${candidate.managedSessionId}`,
        candidate,
      });
    }
  }
  if (!items.length) {
    void vscode.window.showInformationMessage("No terminal pending results from retired or detached Mission Workers require reconciliation.");
    return;
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: "Nimora: Reconcile Pending Result Delivery",
    placeHolder: "Select one exact execution whose future result delivery should stop",
    matchOnDescription: true,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!picked) return;
  if (!items.includes(picked)) throw new Error("Pending delivery selection did not match the displayed execution inventory.");
  const selected = picked.candidate;
  requireCurrentMissionPendingDeliveryCandidate(await tasks.rereadTask(selected.missionId), selected);
  const confirmation = await vscode.window.showWarningMessage(
    `Stop future result delivery for this old WorkerSession?\nMission: ${selected.missionId}\nExecution: ${selected.executionId}\nInput: ${selected.inputId}\nCall: ${selected.callId ?? "(none)"}\nOrigin: ${selected.managedSessionId}`,
    {
      modal: true,
      detail: "The execution facts and any workspace changes are preserved. Pending means no durable delivery acknowledgement; this action makes no claim about whether the provider previously received the result. It does not replay requests or tools and does not mark the result Delivered.",
    },
    STOP_FUTURE_DELIVERY,
  );
  if (confirmation !== STOP_FUTURE_DELIVERY) return;
  const current = requireCurrentMissionPendingDeliveryCandidate(await tasks.rereadTask(selected.missionId), selected);
  await composition.application.reconcilePendingExecutionDelivery({
    projectId: current.projectId,
    rootMissionId: current.rootMissionId,
    missionId: current.missionId,
    executionId: current.executionId,
    reason: MISSION_PENDING_DELIVERY_RECONCILIATION_REASON,
  });
  // Informational presentation must not wait for notification dismissal.
  void vscode.window.showInformationMessage(`Future result delivery stopped for execution ${current.executionId}. Execution facts are preserved.`);
}
