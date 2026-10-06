import * as vscode from "vscode";
import { createHash } from "node:crypto";
import { taskHasUnsettledWork } from "../../../src/task-runtime.js";
import type { TaskSnapshot } from "../../../src/task-contract.js";
import type { createMissionWorkProductionComposition } from "./mission-work-production-composition.js";

export interface RetiredCleanupTarget { pageId: string; provider: "deepseek" | "chatgpt"; expectedHref: string; conversationId: string; adapterSessionId: string; missionId: string; managedSessionId: string; }
export function retiredCleanupTargets(tasks: readonly TaskSnapshot[], resources: readonly unknown[]): RetiredCleanupTarget[] {
  if (tasks.some(task => taskHasUnsettledWork(task))) return [];
  const result: RetiredCleanupTarget[] = [];
  for (const raw of resources) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    if (row.ready !== true || typeof row.pageId !== "string" || typeof row.href !== "string") continue;
    let url: URL; try { url = new URL(row.href); } catch { continue; }
    const provider = url.hostname === "chat.deepseek.com" ? "deepseek" : ["chatgpt.com", "chat.openai.com"].includes(url.hostname) ? "chatgpt" : undefined;
    if (!provider || url.protocol !== "https:") continue;
    // A successful turn remains completed after its Worker is retired. It is
    // settled without resetting the native page state or replaying the input.
    if (provider === "deepseek" ? row.workerTurnState !== "idle" && row.workerTurnState !== "completed"
      : typeof row.stopButtonRef !== "string" || row.stopButtonRef !== "") continue;
    const nativeId = provider === "deepseek" ? row.pageSessionId : row.lifecycleIdentity;
    if (typeof nativeId !== "string" || !nativeId) continue;
    const match = provider === "deepseek" ? url.pathname.match(/^\/(?:a\/)?chat\/(?:s\/)?([^/?#]+)/) : url.pathname.match(/^\/c\/([^/?#]+)/);
    if (!match) continue;
    const refs = tasks.flatMap(task => Object.values(task.workerSessions).filter(ref => ref.adapterSessionId === nativeId).map(ref => ({ task, ref })));
    if (refs.length !== 1 || !refs[0].ref.retiredAt) continue;
    const { task, ref } = refs[0];
    let conversationId: string; try { conversationId = decodeURIComponent(match[1]); } catch { continue; }
    result.push({ pageId: row.pageId, provider, expectedHref: row.href, conversationId, adapterSessionId: nativeId,
      missionId: task.taskId, managedSessionId: ref.managedSessionId });
  }
  return result;
}

export function registerNimoraProviderCleanup(context: vscode.ExtensionContext, composition: ReturnType<typeof createMissionWorkProductionComposition>): vscode.Disposable {
  const active = new Set<string>();
  return vscode.commands.registerCommand("shuncode.nimora.archiveRetiredConversation", async (input?: { projectId?: string }) => {
    if (!vscode.workspace.isTrusted || vscode.workspace.workspaceFolders?.length !== 1) throw new Error("归档需要可信的单文件夹工作区。");
    let projectId = input?.projectId;
    if (!projectId) {
      await composition.owners.projects.initialize();
      const picked = await vscode.window.showQuickPick(composition.owners.projects.listProjects().filter(project =>
        project.workspace === vscode.workspace.workspaceFolders![0].uri.fsPath).map(project => ({
          label: project.title ?? project.goal ?? project.projectId, projectId: project.projectId,
        })), { title: "选择需要归档旧会话的 Project" });
      if (!picked) return { state: "cancelled" }; projectId = picked.projectId;
    }
    if (!projectId || composition.owners.projects.getProject(projectId)?.workspace !== vscode.workspace.workspaceFolders[0].uri.fsPath) throw new Error("请选择当前工作区的确切 Project。");
    if (active.has(projectId)) throw new Error("原会话归档流程仍在进行。"); active.add(projectId);
    try {
      const read = async () => {
        const tasks = await Promise.all(composition.owners.tasks.listTasks().filter(task => task.mission?.projectId === projectId).map(task => composition.owners.tasks.rereadTask(task.taskId)));
        if (tasks.some(task => !task)) throw new Error("Mission 真值无法完整读取。");
        const resources = await Promise.all([vscode.commands.executeCommand("_shuncode.webMcp.workerListResources"), vscode.commands.executeCommand("_shuncode.chatgptWorker.listResources")]);
        return retiredCleanupTargets(tasks as TaskSnapshot[], resources.flatMap(value => Array.isArray(value) ? value : []));
      };
      const targets = await read();
      if (!targets.length) throw new Error("没有确切匹配已退休 Worker、空闲且仍共享的旧会话；不会根据 URL 猜测归档对象。");
      const picked = await vscode.window.showQuickPick(targets.map(target => ({ label: target.provider, description: target.missionId,
        detail: target.expectedHref, target })), { title: "选择已退休 Worker 的旧会话" });
      if (!picked) return { state: "cancelled" };
      const exact = picked.target;
      const confirmed = await vscode.window.showInformationMessage("归档这个已退休 Worker 的网页会话？", { modal: true,
        detail: exact.expectedHref + "\nMission 与产物保留。网页只尝试归档一次；没有归档控件或结果不明时停止。" }, "归档", "取消");
      if (confirmed !== "归档") return { state: "cancelled" };
      if (!(await read()).some(row => JSON.stringify(row) === JSON.stringify(exact))) throw new Error("归档审核期间 Worker／页面真值变化。");
      if (!vscode.workspace.isTrusted || vscode.workspace.workspaceFolders?.length !== 1
        || composition.owners.projects.getProject(projectId)?.workspace !== vscode.workspace.workspaceFolders[0].uri.fsPath) {
        throw new Error("归档审核期间工作区或信任状态变化。");
      }
      const key = "nimora.providerCleanupAttempts.v1";
      const identity = createHash("sha256").update(JSON.stringify([projectId, exact.managedSessionId, exact.provider, exact.conversationId])).digest("hex");
      const attempts = context.workspaceState.get<Record<string, unknown>>(key, {});
      if (attempts[identity]) throw new Error("该会话归档身份已经消费；核实网页结果，不得重放。");
      await context.workspaceState.update(key, { ...attempts, [identity]: { phase: "consumed", at: new Date().toISOString() } });
      const result = await vscode.commands.executeCommand<{ verified?: boolean }>("_shuncode.webMcp.archiveRetiredConversation", exact);
      if (result?.verified !== true) throw new Error("网页归档结果未确认，原身份仍已消费。");
      await context.workspaceState.update(key, { ...context.workspaceState.get<Record<string, unknown>>(key, {}), [identity]: { phase: "verified", at: new Date().toISOString() } });
      return result;
    } finally { active.delete(projectId); }
  });
}
