import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { defaultResourcePolicy, normalizeResourcePolicy, type MissionResourcePolicy } from "../../../src/mission-resource-policy.js";
const KEY = "nimora.resourcePreferences.v1";
export function resourcePreferences(context: vscode.ExtensionContext): MissionResourcePolicy {
  return normalizeResourcePolicy(context.globalState.get(KEY, defaultResourcePolicy()));
}
/** Preferences alone grant nothing. The ordinary native start confirmation
 * commits the chosen classes to the exact durable root before assignment. */
export function registerResourceSettings(context: vscode.ExtensionContext): vscode.Disposable {
  return vscode.commands.registerCommand("shuncode.nimora.configureResources", async () => {
    const picked = await vscode.window.showQuickPick([
      { label: "DeepSeek 网页", mode: "web" as const, planner: "deepseek-web" as const, detail: "使用网页执行；登录、逐页共享与工具授权仍需确认。" },
      { label: "API 全流程", mode: "api" as const, planner: "api" as const, detail: "规划、协调和执行均使用已配置 API；启动时明确确认付费调用。" },
      { label: "网页总文 + 网页/API 执行", mode: "mixed" as const, planner: "deepseek-web" as const, detail: "独立任务按已配置的 Provider 偏好分配；允许 API 费用。" },
      { label: "API 总文 + 网页/API 执行", mode: "mixed" as const, planner: "api" as const, detail: "允许 API 规划、审核及执行费用。" },
    ], { title: "Nimora · 后续工作的资源偏好" });
    if (!picked) return;
    const maxParallel = await vscode.window.showQuickPick([{ label: "串行", value: 1 as const }, { label: "最多两个独立任务并行", value: 2 as const }], { title: "执行并发" });
    if (!maxParallel) return;
    const preference = picked.mode === "mixed" ? await vscode.window.showQuickPick(["优先网页", "优先 API"], { title: "同等能力时的资源偏好；未知成本不按零计算" }) : undefined;
    if (picked.mode === "mixed" && !preference) return;
    await context.globalState.update(KEY, normalizeResourcePolicy({ version: 1, revision: randomUUID(), mode: picked.mode, planner: picked.planner,
      providerOrder: picked.mode === "api" || preference === "优先 API" ? ["nimora-api", "deepseek"] : ["deepseek", "nimora-api"], modelOrder: [], maxParallel: maxParallel.value }));
    void vscode.window.showInformationMessage("资源偏好已保存；已有本轮资源授权保持不变，下一轮启动会明确确认。");
  });
}
export function resourceConsentText(policy: MissionResourcePolicy): string {
  return `总文：${policy.planner === "api" ? "已配置 API" : "DeepSeek 网页"}；执行：${policy.mode === "mixed" ? "网页与 API" : policy.mode === "api" ? "API" : "DeepSeek 网页"}；最多 ${policy.maxParallel} 个独立任务并行。${policy.mode !== "web" ? "本轮允许已配置 API 的模型调用及其费用；尚不提供严格金额上限。" : ""}`;
}
