import type { NimoraShellProject } from "./nimora-product-shell-projection.js";

export type NimoraHumanExperienceState = "working" | "waiting-external" | "needs-human" | "completed";
export type NimoraHumanPrimaryAction = "continue-project" | "review-completion" | "open-attention" | "open-work-sessions" | "none";

export interface NimoraHumanExperienceHint {
  state: NimoraHumanExperienceState;
  headline: string;
  detail: string;
  action: NimoraHumanPrimaryAction;
  actionLabel?: string;
  technicalDetail?: string;
}

export interface NimoraHumanExperienceContext {
  managedAutonomy: boolean;
  recoveredOnly: boolean;
  completionCandidate: boolean;
  providerObservationAvailable: boolean;
}

/**
 * A display-only translation of canonical/operational facts. This function
 * never owns Project truth, completion authority, assignment or retry rights.
 */
export function projectHumanExperience(
  project: NimoraShellProject,
  context: NimoraHumanExperienceContext,
): NimoraHumanExperienceHint {
  if (project.status === "completed") {
    return { state: "completed", headline: "项目已完成", detail: "这一轮正式工作已经结束，产物、决定和历史仍然保留。", action: "none" };
  }
  if (project.unknownExecutionCount > 0) {
    return {
      state: "needs-human",
      headline: "有一次执行结果需要核实",
      detail: "为了避免重复修改，Nimora 已停止自动重试。先确认原执行事实，再继续。",
      action: "open-work-sessions",
      actionLabel: "查看并核实",
      technicalDetail: String(project.unknownExecutionCount) + " execution(s) remain UNKNOWN",
    };
  }
  const humanGovernance = project.attentions.find(item =>
    item.kind === "proposal-awaiting-human"
    || item.kind === "proposal-confirmed"
    || item.kind === "mission-waiting-user");
  if (humanGovernance) {
    return {
      state: "needs-human",
      headline: humanGovernance.title,
      detail: humanGovernance.detail ?? "这里需要你的授权、输入或治理判断；Nimora 不会替你决定。",
      action: "open-attention",
      actionLabel: "查看需要我处理的事项",
    };
  }
  if (context.completionCandidate) {
    return {
      state: "needs-human",
      headline: "工作已收敛，等待你的最终确认",
      detail: "负责规划的文已经没有新的工作指令。Nimora 会先独立核对结果，再由你决定是否正式结束项目。",
      action: "review-completion",
      actionLabel: "审核并完成项目",
    };
  }
  if (context.recoveredOnly) {
    return {
      state: "waiting-external",
      headline: "正在等待安全接班",
      detail: "这是从历史状态恢复的项目。Nimora 会保留旧执行事实，不会把恢复动作当成新工作。",
      action: "open-work-sessions",
      actionLabel: "查看恢复状态",
    };
  }
  if (context.managedAutonomy) {
    return {
      state: context.providerObservationAvailable ? "working" : "waiting-external",
      headline: context.providerObservationAvailable ? "Nimora 可以继续自主推进" : "AI 资源尚未就绪",
      detail: context.providerObservationAvailable
        ? "文会根据真实证据决定下一步；资源分配、并行和正常接班由 Nimora 自己处理。只有网页登录或共享、付费授权、安全权限或治理判断确实需要你时才会介入。"
        : "继续后，Nimora 会按当前资源授权为任务准备可用 AI；如果网页登录、共享、付费或安全权限需要确认，会明确请你介入。",
      action: "continue-project",
      actionLabel: "继续自动工作",
    };
  }
  return {
    state: "working",
    headline: "项目可以继续",
    detail: "当前项目使用兼容入口；Nimora 仍会保留任务身份和执行事实。",
    action: "open-work-sessions",
    actionLabel: "打开工作记录",
  };
}
