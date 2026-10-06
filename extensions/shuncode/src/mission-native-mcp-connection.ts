import * as vscode from "vscode";
import type { MissionCapabilityMaterializationRequest } from "../../../src/mission-capability-materializer.js";
import type { createMissionWorkProductionComposition } from "./mission-work-production-composition.js";
import { missionEntryCapabilityMaterialization } from "../../../src/mission-user-entry-application.js";

type Composition = ReturnType<typeof createMissionWorkProductionComposition>;

/** User setup only: advertise exact current schemas; never activate or send a turn. */
export async function connectMissionNativeMcp(composition: Composition, ready: Promise<unknown>,
  prepare: (request: MissionCapabilityMaterializationRequest) => Promise<{ publicUrl?: string }>): Promise<void> {
  if (!vscode.workspace.isTrusted) throw new Error("Trust this workspace before connecting a Mission.");
  await ready;
  await composition.owners.tasks.initialize();
  const choices = composition.owners.tasks.listTasks().flatMap(task => {
    if (!task.mission || task.missionFinalization || ["completed", "failed", "cancelled"].includes(task.status)) return [];
    const durable = Object.values(task.workerSessions).filter(ref => !ref.retiredAt && !ref.detachedAt);
    const live = composition.owners.workers.listSessions({ taskId: task.taskId });
    if (durable.length !== 1 || live.length !== 1 || live[0].workerId !== "nimora.chatgpt-browser-worker"
      || durable[0].managedSessionId !== live[0].managedSessionId
      || durable[0].workerId !== live[0].workerId || durable[0].adapterSessionId !== live[0].adapterSessionId) return [];
    return [{ label: task.goal ?? task.taskId, description: task.mission.plane, task, session: live[0] }];
  });
  if (!choices.length) {
    await vscode.window.showInformationMessage("请先为 Mission 分配 ChatGPT Worker。重启后可使用“Select or Replace Mission Worker”恢复分配。");
    return;
  }
  const chosen = await vscode.window.showQuickPick(choices, { title: "选择要连接 ChatGPT MCP 的 Mission", ignoreFocusOut: true });
  if (!chosen) return;
  const policy = await vscode.window.showQuickPick([
    { label: "读取工作区", ids: ["workspace.read-files"] },
    { label: "读取并编辑工作区", ids: ["workspace.read-files", "workspace.apply-patch"] },
    { label: "读取、编辑并运行验证命令", ids: ["workspace.read-files", "workspace.apply-patch", "terminal.run-command"] },
  ], { title: "选择本次工作的能力范围（执行仍需现有权限审批）", ignoreFocusOut: true });
  if (!policy) return;
  const materialization = missionEntryCapabilityMaterialization(policy.ids);
  const mission = chosen.task.mission!;
  const result = await prepare({ projectId: mission.projectId, rootMissionId: mission.rootMissionId,
    missionId: chosen.task.taskId, managedSessionId: chosen.session.managedSessionId,
    constraints: materialization.capability,
    budget: { maxSchemaChars: 100_000 } });
  if (!result.publicUrl || new URL(result.publicUrl).protocol !== "https:") throw new Error("The Mission MCP public HTTPS route is unavailable.");
  await vscode.env.clipboard.writeText(result.publicUrl);
  const action = await vscode.window.showInformationMessage("Mission MCP 连接地址已准备并已复制", {
    modal: true,
    detail: `在 ChatGPT 的自定义 MCP 应用中使用此地址，并完成连接授权。此步骤尚未连接应用，也未发送执行请求。\n\n${result.publicUrl}`,
  }, "复制连接地址");
  if (action === "复制连接地址") await vscode.env.clipboard.writeText(result.publicUrl);
}
