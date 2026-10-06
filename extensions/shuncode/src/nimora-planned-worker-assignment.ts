import * as vscode from "vscode";
import { requireActiveProjectRoot } from "../../../src/project-active-root.js";
import type { createMissionWorkProductionComposition } from "./mission-work-production-composition.js";
import type { NimoraWebCognitionPool } from "./nimora-web-cognition.js";
import { defaultResourcePolicy, readResourcePolicy, resourceAssignment } from "../../../src/mission-resource-policy.js";
import { resourceConsentText } from "./nimora-resource-settings.js";

type Composition = ReturnType<typeof createMissionWorkProductionComposition>;

/** Explicit product entry for the existing parallel assignment owner. It never
 * generates goals, sends Work Orders or silently authorizes new capabilities. */
export function registerNimoraPlannedWorkerAssignment(
  context: vscode.ExtensionContext,
  composition: Composition,
  planner: NimoraWebCognitionPool,
  workersReady: Promise<unknown>,
): vscode.Disposable {
  return vscode.commands.registerCommand("shuncode.nimora.assignReadyWebMissions", async (request?: { projectId?: string }) => {
    const projectId = request?.projectId;
    const folders = vscode.workspace.workspaceFolders;
    if (!projectId || !vscode.workspace.isTrusted || folders?.length !== 1 || folders[0].uri.scheme !== "file") {
      throw new Error("请选择当前可信单文件夹工作区中的准确 Project。");
    }
    if (!context.workspaceState.get<string[]>("nimora.webProjectIds", []).includes(projectId)
      || context.workspaceState.get<string[]>("nimora.reviewedWebFormedOnlyProjectIds", []).includes(projectId)) {
      throw new Error("并行分配仅支持全新、正式网页 Formation 的 Project；旧接管保留独立恢复合同。");
    }
    await workersReady;
    await Promise.all([composition.owners.projects.initialize(), composition.owners.tasks.initialize()]);
    const project = composition.owners.projects.getProject(projectId);
    const missions = composition.owners.tasks.listTasks().filter(task => task.mission?.projectId === projectId);
    const root = requireActiveProjectRoot(missions, projectId);
    if (!project?.formationReceipt || project.workspace !== folders[0].uri.fsPath
      || root.missionFinalization) {
      throw new Error("并行分配需要当前工作区中唯一、活动的 Cognition Root。");
    }
    const resources = readResourcePolicy(root) ?? defaultResourcePolicy();
    const plannerPageId = planner.getHealthyPlannerPageId(projectId);
    if (resources.planner === "deepseek-web" && !plannerPageId) throw new Error("原规划页面未能在当前宿主核实；请先处理恢复状态。");
    if (resources.planner === "api" && !planner.hasHealthyLocalReference(projectId)) throw new Error("原 API 规划连接未能核实；请先处理恢复状态。");
    if (missions.some(task => Object.values(task.executions).some(row =>
      row.status === "unknown" || row.status === "executing" || row.status === "requested"
      || row.deliveryStatus === "unknown" || row.deliveryStatus === "pending"))) {
      throw new Error("Project 存在未收敛的 execution/delivery；不能未经核实就分配新的执行资源。");
    }
    const scope = { projectId, rootMissionId: root.taskId };
    const frontier = await composition.parallelReadiness.inspect(scope);
    const ready = frontier.missions.filter(mission => mission.state === "ready-unassigned");
    if (!ready.length) {
      await vscode.window.showInformationMessage("当前没有尚未分配且满足依赖条件的子 Mission。");
      return;
    }
    if (resources.mode !== "web") {
      const selected = ready.slice(0, resources.maxParallel);
      const confirmed = await vscode.window.showInformationMessage("按本轮资源策略为就绪 Mission 分配 Worker？", { modal: true, detail: resourceConsentText(resources) + " 只建立绑定，不发送指令、不授予工具权限。" }, "确认分配", "取消");
      if (confirmed !== "确认分配") return;
      const fresh = await composition.owners.tasks.rereadTask(root.taskId);
      if (!fresh || JSON.stringify(readResourcePolicy(fresh)) !== JSON.stringify(resources)) throw new Error("分配期间本轮资源策略变化。");
      return composition.plannedWork.assignReady({ ...scope, requests: selected.map(m => resourceAssignment(resources, scope, m.missionId, "practice")) });
    }
    const observed = await composition.webCandidates.enumerateCandidates();
    const candidates: { candidateId: string; pageId: string }[] = [];
    for (const candidate of observed) {
      if (candidate.kind !== "web" || candidate.provider !== "deepseek"
        || candidate.availability !== "available" || candidate.health?.status !== "healthy") continue;
      const options = await composition.webCandidates.materializeSessionOptions(candidate, {});
      const page = options.extensions?.webMcpTarget as { pageId?: string; pageSessionId?: string } | undefined;
      // A fresh page can legitimately lack pageSessionId until assigned.
      // Trust the verified native page/resource identity and exact candidate
      // admission; check adapter-session ownership when it is present.
      if (!page?.pageId || page.pageId === plannerPageId
        || candidates.some(row => row.pageId === page.pageId)
        || (page.pageSessionId && composition.owners.workers.getSessionByAdapterIdentity(candidate.workerId, page.pageSessionId))) continue;
      candidates.push({ candidateId: candidate.candidateId, pageId: page.pageId });
    }
    const selected = ready.slice(0, Math.min(8, candidates.length));
    if (!selected.length) {
      await vscode.window.showWarningMessage(`${ready.length} 个子 Mission 已就绪，但暂无可确认身份的空闲 DeepSeek 执行网页。请先从 Connections 连接新的独立网页。`);
      return;
    }
    const confirmed = await vscode.window.showInformationMessage("为就绪的独立 Mission 分配网页 Worker？", {
      modal: true,
      detail: `此次可为 ${selected.length}/${ready.length} 个 Mission 分配各不相同的已共享网页。只建立 Worker 绑定，不发送指令、安装权限或自动重试。\n\n${selected.map(m => m.missionId).join("\n")}`,
    }, "确认分配", "取消");
    if (confirmed !== "确认分配") return;
    const outcome = await composition.plannedWork.assignReady({
      ...scope,
      requests: selected.map(mission => ({
        ...scope, missionId: mission.missionId,
        constraints: { allowedKinds: ["web"], allowedProviders: ["deepseek"] },
      })),
      exactCandidateIds: Object.fromEntries(selected.map((mission, index) => [mission.missionId, candidates[index].candidateId])),
    });
    await vscode.window.showInformationMessage(`Worker 分配完成：${outcome.outcomes.filter(row => row.state === "assigned").length} 个绑定成功，${outcome.outcomes.filter(row => row.state !== "assigned").length} 个未分配。请在 Mission 查看真实状态；不自动重试失败结果。`);
    return outcome;
  });
}
