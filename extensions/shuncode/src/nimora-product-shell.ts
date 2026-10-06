import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import {
  projectNimoraProductShell,
  type NimoraProductShellState,
  type NimoraShellProject,
} from "../../../src/nimora-product-shell-projection.js";
import {
  readProjectMissionPresentation,
  type ProjectMissionPresentationOwners,
} from "../../../src/project-mission-presentation.js";
import type { ProjectGovernanceHumanApplication } from "../../../src/project-governance-human-application.js";
import { projectHumanExperience } from "../../../src/nimora-human-attention.js";
import type { NimoraProductOperationalSnapshot, NimoraProductOperationalSource } from "./nimora-product-operations.js";
import { buildNimoraProductDiagnostics } from "./nimora-product-diagnostics.js";
import { exportNimoraProjectBackup, prepareNimoraProjectRestore, verifyNimoraProjectBackup } from "./nimora-project-backup.js";
import { reviewedReadAction, type ReviewedReadRecoveryState } from "./nimora-reviewed-mission-recovery.js";
import { reviewedReadContinuationAction } from "./nimora-reviewed-read-continuation.js";
import { practiceNeedsFailureReview } from "./nimora-reviewed-practice-entry.js";

const PANEL_TYPE = "nimora.productShell";
const OPEN_COMMAND = "shuncode.nimora.open";
const EXPORT_DIAGNOSTICS_COMMAND = "shuncode.nimora.exportDiagnostics";
const EXPORT_BACKUP_COMMAND = "shuncode.nimora.exportProjectBackup";
const RESTORE_BACKUP_COMMAND = "shuncode.nimora.restoreProjectBackup";
const AUTONOMY_OUTCOME_KEY = "nimora.autonomyOutcome.v1";
const ARCHIVED_PROJECTS_KEY = "nimora.productShell.archivedProjectIds.v1";
type NimoraAutonomyUiOutcome = { state: string; reason?: string; recordedAt: string };

type ShellView = "work" | "projects" | "activity" | "workers" | "connections" | "settings";

type ShellMessage =
  | { type: "refresh" }
  | { type: "selectView"; view: ShellView }
  | { type: "selectProject"; projectId: string }
  | { type: "manageProject"; projectId: string }
  | { type: "selectMission"; projectId: string; missionId: string }
  | { type: "newProject" }
  | { type: "newWebProject" }
  | { type: "newProjectAtLocation" }
  | { type: "openProjectWorkspace"; projectId: string }
  | { type: "changeProjectLocation"; projectId: string }
  | { type: "archiveProjectFromList"; projectId: string }
  | { type: "restoreArchivedProject"; projectId: string }
  | { type: "enterProjectWork"; projectId: string }
  | { type: "startNextProjectGoal"; projectId: string }
  | { type: "resumeNextProjectGoal"; projectId: string }
  | { type: "selectProjectSkills"; projectId: string }
  | { type: "archiveRetiredConversation"; projectId: string }
  | { type: "pairPersonalEdge" }
  | { type: "adoptReviewedWebCognition" }
  | { type: "takeoverReviewedWebWorkers"; projectId: string }
  | { type: "resumeReviewedWebWorkers"; projectId: string }
  | { type: "startReviewedFirstMission"; projectId: string }
  | { type: "reconcileReviewedFirstRead"; projectId: string }
  | { type: "sendReviewedFreshRead"; projectId: string }
  | { type: "restoreReviewedSettledRead"; projectId: string }
  | { type: "replaceReviewedClosedPages"; projectId: string }
  | { type: "resumeReviewedFreshReplacement"; projectId: string }
  | { type: "prepareReviewedPractice"; projectId: string }
  | { type: "runReviewedPractice"; projectId: string }
  | { type: "reconcileReviewedPractice"; projectId: string }
  | { type: "diagnoseReviewedSettlement"; projectId: string }
  | { type: "continueMission"; projectId: string; missionId: string }
  | { type: "continueWebMission"; projectId: string; missionId: string }
  | { type: "reviewProjectCompletion"; projectId: string }
  | { type: "assignReadyWebMissions"; projectId: string }
  | { type: "runWebAutonomy"; projectId: string }
  | { type: "continueProject"; projectId: string }
  | { type: "openWorkSessions" }
  | { type: "selectWorker" }
  | { type: "connectWebAi"; provider: "deepseek" | "chatgpt" }
  | { type: "permissions" }
  | { type: "exportDiagnostics" }
  | { type: "exportProjectBackup"; projectId: string }
  | { type: "restoreProjectBackup" }
  | { type: "workerStatus" }
  | { type: "connectMcp" }
  | { type: "configureModel" }
  | { type: "configureApiProfiles" }
  | { type: "configureResources" }
  | { type: "openWorkspace" }
  | { type: "manageWorkspaceTrust" }
  | { type: "codexLogin" }
  | { type: "runtimeStatus" }
  | { type: "acceptProposal"; projectId: string; proposalId: string; contentDigest: string; summary: string }
  | { type: "commitProposal"; projectId: string; proposalId: string; contentDigest: string; summary: string }
  | { type: "openArtifact"; uri: string };

function htmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function statusLabel(status: NimoraShellProject["status"]): string {
  if (status === "attention") return "需要关注";
  if (status === "active") return "进行中";
  return "已完成";
}

function taskStatusLabel(status: string): string {
  if (status === "draft") return "准备中";
  if (status === "ready") return "待开始";
  if (status === "running") return "进行中";
  if (status === "waiting_user") return "等待你处理";
  if (status === "waiting_external") return "等待外部结果";
  if (status === "completed") return "已完成";
  if (status === "archived") return "已归档";
  if (status === "failed") return "失败";
  if (status === "cancelled") return "已取消";
  return status;
}

function executionStatusLabel(status: string): string {
  if (status === "succeeded") return "成功";
  if (status === "failed") return "失败";
  if (status === "unknown") return "待核实";
  if (status === "running") return "执行中";
  return status;
}

function missionRoleLabel(role: NimoraShellProject["missions"][number]["role"]): string {
  if (role === "文") return "文 · 理解与规划";
  if (role === "理") return "理 · 实践与验证";
  return "协调 · 传递与编排";
}

function collaborationKindLabel(kind: string): string {
  if (kind === "Finding") return "发现";
  if (kind === "Evidence") return "证据";
  if (kind === "Problem") return "问题";
  if (kind === "Answer") return "回答";
  if (kind === "Handoff") return "交接";
  return kind;
}

function missionGraphStateLabel(state: NimoraShellProject["graph"]["nodes"][number]["state"]): string {
  if (state === "active") return "进行中";
  if (state === "ready") return "待开始";
  if (state === "waiting") return "等待中";
  if (state === "completed") return "已完成";
  if (state === "attention") return "需要关注";
  return "已取消";
}

function workerStateLabel(state: NimoraProductOperationalSnapshot["liveWorkers"][number]["state"]): string {
  if (state === "running") return "执行中";
  if (state === "idle") return "就绪";
  if (state === "interrupted") return "已中断";
  return "已结束";
}

function providerAvailabilityLabel(availability: NimoraProductOperationalSnapshot["providers"][number]["availability"]): string {
  if (availability === "available") return "可用";
  if (availability === "degraded") return "降级";
  if (availability === "offline") return "离线";
  return "不可用";
}

function providerDisplayName(name: string): string {
  const normalized = name.toLocaleLowerCase();
  if (normalized === "deepseek") return "DeepSeek";
  if (normalized === "chatgpt") return "ChatGPT";
  if (normalized === "nimora-api" || normalized === "api") return "API";
  if (normalized === "agenthost" || normalized === "agent-host") return "Agent Host";
  return name;
}

function loadingPageHtml(nonce: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}';"><style nonce="${nonce}">body{margin:0;display:grid;place-items:center;min-height:100vh;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font:13px/1.5 var(--vscode-font-family)}.state{max-width:460px;text-align:center}.mark{display:grid;place-items:center;width:46px;height:46px;margin:0 auto 14px;border-radius:14px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);font-size:19px;font-weight:800}.state p{color:var(--vscode-descriptionForeground)}</style></head><body><main class="state" aria-busy="true" aria-live="polite"><div class="mark">N</div><h1>正在读取 Nimora 工作区</h1><p>正在恢复项目、任务与协作状态。</p></main></body></html>`;
}

function errorPageHtml(nonce: string, detail: string): string {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">body{margin:0;display:grid;place-items:center;min-height:100vh;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font:13px/1.5 var(--vscode-font-family)}.state{max-width:560px;padding:28px;text-align:center}.state p{color:var(--vscode-descriptionForeground)}button{font:inherit;border:0;border-radius:6px;padding:8px 13px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);cursor:pointer}button:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.detail{margin:14px 0;padding:10px;border:1px solid var(--vscode-panel-border);border-radius:8px;text-align:left;word-break:break-word}</style></head><body><main class="state" role="alert"><h1>Nimora 暂时无法读取工作区</h1><p>读取失败不会被当成“没有项目”，现有项目和任务也不会因此被修改。</p><div class="detail">${htmlEscape(detail)}</div><button data-action="refresh" autofocus>重新读取</button></main><script nonce="${nonce}">const vscode=acquireVsCodeApi();document.querySelector('[data-action="refresh"]').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));</script></body></html>`;
}

function pageHtml(state: NimoraProductShellState, nonce: string, view: ShellView, operations?: NimoraProductOperationalSnapshot, managedAutonomyProjectIds: readonly string[] = [], reviewedRecoveryAvailable = false, reviewedFormedOnlyIds: readonly string[] = [], takeoverStatuses: Readonly<Record<string, ReviewedReadRecoveryState>> = {}, practiceReviewState: 'clear' | 'needs-review' | 'unavailable' = 'clear', autonomyOutcomes: Readonly<Record<string, NimoraAutonomyUiOutcome>> = {}, pendingLaterRootIds: readonly string[] = [], archivedProjectIds: readonly string[] = [], actionInFlight = false, actionError?: string): string {
  const currentWorkspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const showContextSidebar = view === "work";
  const archivedProjects = new Set(archivedProjectIds);
  const visibleProjects = state.projects.filter(project => !archivedProjects.has(project.projectId));
  const selected = visibleProjects.find(project => project.projectId === state.selectedProjectId);
  // The persisted `nimora.webProjectIds` key is retained for compatibility,
  // but modern projects in that set may authorize Web, API-only or mixed
  // resources. Product UI therefore treats membership as managed autonomy.
  const selectedManagedAutonomy = !!selected && managedAutonomyProjectIds.includes(selected.projectId);
  const selectedRecoveredOnly = !!selected && reviewedFormedOnlyIds.includes(selected.projectId);
  const selectedAutonomyOutcome = selected ? autonomyOutcomes[selected.projectId] : undefined;
  const humanExperience = selected ? projectHumanExperience(selected, {
    managedAutonomy: selectedManagedAutonomy,
    recoveredOnly: selectedRecoveredOnly,
    completionCandidate: selectedAutonomyOutcome?.state === "completion-candidate",
    providerObservationAvailable: !!operations && (
      operations.providers.some(provider => provider.availability === "available")
      || operations.liveWorkers.some(worker => worker.state !== "disposed")
    ),
  }) : undefined;
  const takeoverPhase = selectedRecoveredOnly && selected ? takeoverStatuses[selected.projectId]?.phase : undefined;
  const readAction = selectedRecoveredOnly && selected ? reviewedReadAction(takeoverStatuses[selected.projectId], operations?.liveWorkers) : undefined;
  const continuationAction = selectedRecoveredOnly && selected ? reviewedReadContinuationAction(takeoverStatuses[selected.projectId], operations?.liveWorkers ?? []) : undefined;
  const practice = selectedRecoveredOnly && selected ? takeoverStatuses[selected.projectId]?.practice : undefined;
  const practiceDisconnected = !!practice?.managedSessionId && !(operations?.liveWorkers ?? []).some(row => row.managedSessionId === practice.managedSessionId);
  const previousWorkersDisconnected = !!selectedRecoveredOnly && !!selected && !!practice?.managedSessionId
    && [takeoverStatuses[selected.projectId]?.rootSessionId, takeoverStatuses[selected.projectId]?.coordinatorSessionId,
      practice.managedSessionId].every(id => !!id && !(operations?.liveWorkers ?? []).some(row => row.managedSessionId === id));
  const practiceCanContinue = practice?.phase === "ready" || practice?.phase === "reviewed-unknown"
    || practice?.phase === "sent" && ["completed", "error"].includes(practice.lastFeedback?.terminalStatus ?? "");
  const recoveredAction = !selectedRecoveredOnly ? "" : takeoverPhase === undefined
    ? `<button class="primary" data-action="takeoverReviewedWebWorkers" data-project="${htmlEscape(selected!.projectId)}">开始安全恢复</button>`
    : takeoverPhase === "preparing"
      ? `<button class="primary" data-action="resumeReviewedWebWorkers" data-project="${htmlEscape(selected!.projectId)}">继续恢复</button>`
    : takeoverPhase === "ready"
      ? `<button class="primary" data-action="startReviewedFirstMission" data-project="${htmlEscape(selected!.projectId)}">审核并启动首个只读任务</button>`
    : takeoverPhase === "replacing-new-workers"
      ? takeoverStatuses[selected!.projectId]?.replacement?.mutationStarted
        || Object.keys(takeoverStatuses[selected!.projectId]?.replacement?.assigned ?? {}).length > 0
        ? `<button disabled title="部分执行资源可能已经接班；需要先核实已有记录，不能重复启动">恢复状态待核实 · 暂不可重试</button>`
        : `<button class="primary" data-action="resumeReviewedFreshReplacement" data-project="${htmlEscape(selected!.projectId)}">核实并继续恢复</button>`
    : practice
      ? practiceReviewState === 'unavailable'
        ? `<button disabled title="缺少当前持久任务的执行记录，不能授权继续">执行记录暂不可用 · 请核实</button>`
      : practice.phase === "unknown"
        ? `<button data-action="reconcileReviewedPractice" data-project="${htmlEscape(selected!.projectId)}">核实上一次执行结果</button>`
      : practice.phase === "sent" && ["completed", "error"].includes(practice.lastFeedback?.terminalStatus ?? "") && practiceReviewState === 'needs-review'
        ? `<button data-action="reconcileReviewedPractice" data-project="${htmlEscape(selected!.projectId)}">核实本轮执行结果 · 保留失败</button>${practice.coordinationFailure ? `<button data-action="diagnoseReviewedSettlement" data-project="${htmlEscape(selected!.projectId)}">只读查看协调端回执状态</button>` : ""}`
      : practice.coordinationFailure
        ? `<button class="primary" data-action="diagnoseReviewedSettlement" data-project="${htmlEscape(selected!.projectId)}">查看未确认的执行状态</button>${previousWorkersDisconnected ? `<button data-action="replaceReviewedClosedPages" data-project="${htmlEscape(selected!.projectId)}">审核新的执行资源接班</button>` : ""}<p class="warn-text">Nimora 已停止自动重发。请先核实已有执行记录，确认旧执行资源已经退出后再恢复。</p>`
      : practiceCanContinue && (continuationAction === "restore-read" || practiceDisconnected)
        ? `<button data-action="restoreReviewedSettledRead" data-project="${htmlEscape(selected!.projectId)}">恢复原三条任务连接</button>${practice.phase === "sent" ? `<button class="primary" data-action="replaceReviewedClosedPages" data-project="${htmlEscape(selected!.projectId)}">原网页已关闭 · 审核新执行资源接班</button>` : ""}`
      : practiceCanContinue
        ? `<button class="primary" data-action="runReviewedPractice" data-project="${htmlEscape(selected!.projectId)}">${practice.phase === "ready" ? "运行实现与测试" : "继续执行任务的新目标"}</button>`
        : `<button disabled title="保留执行身份和实际记录，不能重试不确定操作">${practice.phase === "sent" ? "执行结果待核实，不会重发" : "执行阶段准备中，请查看实际任务"}</button>`
    : readAction === "reconcile"
      ? `<button data-action="reconcileReviewedFirstRead" data-project="${htmlEscape(selected!.projectId)}">${takeoverPhase === "mission-reconciled" ? "恢复本次网页连接" : "核实本轮失败并恢复原 Worker"}</button>`
    : readAction === "send"
      ? `<button class="primary" data-action="sendReviewedFreshRead" data-project="${htmlEscape(selected!.projectId)}">审核并发送新的只读请求</button>`
    : continuationAction === "restore-read"
      ? `<button data-action="restoreReviewedSettledRead" data-project="${htmlEscape(selected!.projectId)}">恢复已读取的原任务连接</button>`
    : continuationAction === "continue-read"
      ? `<button class="primary" data-action="prepareReviewedPractice" data-project="${htmlEscape(selected!.projectId)}">准备实现与测试</button><button data-action="continueWebMission" data-project="${htmlEscape(selected!.projectId)}" data-mission="${htmlEscape((takeoverStatuses[selected!.projectId] as { rootMissionId?: string }).rootMissionId ?? "")}">继续只读目标 · 网页 AI</button>`
      : `<button disabled title="已有接管或任务状态须人工对账，禁止盲目重试">${takeoverPhase === "mission-sent"
        ? takeoverStatuses[selected!.projectId]?.lastFeedback?.terminalStatus && takeoverStatuses[selected!.projectId].lastFeedback!.terminalStatus !== "completed"
          ? "本轮未正常结束 · 已停止，不会重发" : "本轮已发送 · 读取记录待核实"
          : takeoverPhase === "mission-unknown" && takeoverStatuses[selected!.projectId]?.lastFeedback?.terminalStatus === "unknown"
            ? "本轮失败 · 执行状态待核实，不会重发" : "接管状态待人工核实"}</button>`;
  const selectedMission = selected?.missions.find(mission => mission.missionId === state.selectedMissionId);
  const unavailableOwners = state.system.owners.filter(owner => owner.status === "unavailable");
  const ownerHealthHtml = state.system.owners.map(owner => `
    <div class="owner-health ${owner.status}"><span class="owner-dot"></span><span><strong>${htmlEscape(owner.label)}</strong><small>${owner.status === "available" ? "可用" : htmlEscape(owner.detail ?? "暂不可用")}</small></span></div>`).join("");
  const integrityHtml = state.system.integrityIssues.slice(0, 4).map(issue => `<li><strong>${htmlEscape(issue.code)}</strong> · ${htmlEscape(issue.detail)}</li>`).join("");
  const systemBanner = state.system.mode === "degraded" || state.system.mode === "unavailable" ? `
    <section class="system-banner ${state.system.mode}" role="status" aria-live="polite">
      <div><strong>${state.system.mode === "unavailable" ? "当前无法完整读取 Nimora 工作区" : "部分项目状态暂时不可读取"}</strong><p>${state.system.reconstruction === "partial" ? "Nimora 只显示已经确认的数据，缺失信息不会被误判为空。" : "项目数据已经可以重新读取。"}</p></div>
      <details class="advanced"><summary>技术详情</summary><div class="owner-health-grid">${ownerHealthHtml}</div>${state.system.integrityIssueCount ? `<div><strong>${state.system.integrityIssueCount} 个完整性提示</strong><ul>${integrityHtml}</ul></div>` : ""}</details>
      <button data-action="refresh" aria-label="重新读取 Nimora 状态">重新读取</button>
    </section>` : "";
  const unknownBanner = state.unknownExecutionCount ? `
    <section class="unknown-banner" role="alert"><strong>${state.unknownExecutionCount} 个执行结果仍待核实</strong><span>Nimora 不会把不确定结果当作失败，也不会自动重试，以免重复执行现实操作。</span><details class="advanced"><summary>技术详情</summary><span>UNKNOWN 不等于失败，也不授予重试权限。请先完成 reconciliation。</span></details></section>` : "";
  const projectSourceBanner = selected && (selected.sourceState.metadata !== "available" || selected.sourceState.decisions !== "available" || selected.sourceState.collaboration !== "available") ? `
    <section class="source-banner" role="status"><strong>这个项目的信息暂时不完整</strong><span>Nimora 只会显示已经确认的数据，不会补猜缺失内容。</span><details class="advanced"><summary>技术详情</summary><p>Project metadata: ${htmlEscape(selected.sourceState.metadata)} · Decisions: ${htmlEscape(selected.sourceState.decisions)} · Collaboration: ${htmlEscape(selected.sourceState.collaboration)}</p>${selected.sourceState.metadata === "missing" ? `<p>Mission truth 存在，但 canonical Project metadata 缺失；当前标题与目标仅是安全占位，不会被写回 Project truth。</p>` : ""}</details></section>` : "";
  const projectsHtml = visibleProjects.length
    ? visibleProjects.map(project => `
      <button class="project-card ${project.projectId === state.selectedProjectId ? "selected" : ""}" data-action="project" data-project="${htmlEscape(project.projectId)}" aria-label="打开项目：${htmlEscape(project.title)}" ${project.projectId === state.selectedProjectId ? `aria-current="page"` : ""}>
        <span class="project-main">
          <strong>${htmlEscape(project.title)}</strong>
          <span>${htmlEscape(project.goal)}</span>
        </span>
        <span class="project-meta">
          <span class="badge ${project.status}">${statusLabel(project.status)}</span>
          <span>${project.missions.filter(mission => mission.plane !== "coordination" && !mission.terminal).length} 个未结束工作任务 · ${project.artifactCount} 个产物</span>
        </span>
      </button>`).join("")
    : state.system.mode === "empty"
      ? `<div class="sidebar-empty">还没有项目</div>`
      : archivedProjectIds.length && state.projects.length
        ? `<div class="sidebar-empty">当前项目都已移出列表，可在“项目”页恢复。</div>`
        : `<div class="sidebar-empty warning">项目数据暂不可用</div>`;

  const projectManagementListHtml = visibleProjects.length
    ? visibleProjects.map(project => `
      <button class="project-management-card ${project.projectId === state.selectedProjectId ? "selected" : ""}" data-action="manageProject" data-project="${htmlEscape(project.projectId)}">
        <span class="project-management-icon">▣</span>
        <span class="project-management-copy"><strong>${htmlEscape(project.title)}</strong><span>${htmlEscape(project.goal)}</span><small>${project.workspace ? htmlEscape(project.workspace) : "未记录项目位置"}${project.workspace && currentWorkspacePath && project.workspace.toLocaleLowerCase() === currentWorkspacePath.toLocaleLowerCase() ? " · 当前工作区" : ""}</small></span>
        <span class="project-management-status"><span class="status-chip ${project.status === "attention" ? "attention" : project.status === "completed" ? "done" : "active"}">${statusLabel(project.status)}</span><small>推进 ${project.progress.percent}%</small></span>
      </button>`).join("")
    : `<div class="empty-state"><strong>项目列表为空</strong><span>可以在当前工作区新建项目，或选择另一个文件夹作为项目位置。</span></div>`;
  const archivedProjectsHtml = state.projects.filter(project => archivedProjects.has(project.projectId)).map(project => `
    <div class="archived-project-row"><div><strong>${htmlEscape(project.title)}</strong><small>${project.workspace ? htmlEscape(project.workspace) : "未记录位置"}</small></div><button data-action="restoreArchivedProject" data-project="${htmlEscape(project.projectId)}">恢复到列表</button></div>`).join("");

  const primaryMissions = selected?.missions.filter(mission => mission.plane !== "coordination") ?? [];
  const cognitionMissions = primaryMissions.filter(mission => mission.plane === "cognition");
  const practiceMissions = primaryMissions.filter(mission => mission.plane === "practice");
  const coordinationMissionCount = selected?.missions.filter(mission => mission.plane === "coordination").length ?? 0;
  const activeCognitionCount = cognitionMissions.filter(mission => !mission.terminal).length;
  const activePracticeCount = practiceMissions.filter(mission => !mission.terminal).length;
  const completedWorkMissionCount = primaryMissions.filter(mission => mission.terminal).length;
  const uniqueEvidenceCount = new Set((selected?.missions ?? []).flatMap(mission => mission.collaboration.filter(exchange => exchange.kind === "Evidence").map(exchange => exchange.exchangeId))).size;
  const uniqueOpenProblemCount = new Set((selected?.missions ?? []).flatMap(mission => mission.problems.filter(problem => problem.state === "Open").map(problem => problem.exchangeId))).size;
  const missionIsRunning = (mission: NimoraShellProject["missions"][number]): boolean =>
    !mission.terminal && !!operations?.liveWorkers.some(worker => worker.taskId === mission.missionId && worker.state === "running");
  const loopStage = selected?.status === "completed" ? "completed"
    : selected?.unknownExecutionCount || uniqueOpenProblemCount > 0 ? "feedback"
    : selectedAutonomyOutcome?.state === "completion-candidate" ? "review"
    : practiceMissions.some(missionIsRunning) ? "practice"
    : cognitionMissions.some(missionIsRunning) ? "cognition" : "ready";
  const missionsHtml = primaryMissions.length
    ? primaryMissions.map(mission => `
      <button class="mission-row ${mission.missionId === state.selectedMissionId ? "selected" : ""}" data-action="mission" data-project="${htmlEscape(selected!.projectId)}" data-mission="${htmlEscape(mission.missionId)}" aria-label="打开任务：${htmlEscape(mission.goal)}" ${mission.missionId === state.selectedMissionId ? `aria-current="true"` : ""}>
        <span class="mission-role ${mission.plane}">${htmlEscape(mission.role)}</span>
        <span class="mission-copy">
          <strong>${htmlEscape(mission.goal)}</strong>
          <span>${htmlEscape(missionRoleLabel(mission.role))} · ${htmlEscape(taskStatusLabel(mission.status))}</span>
        </span>
        <span class="mission-counts">${mission.artifactCount} 产物</span>
      </button>`).join("")
    : selected?.sourceState.metadata === "unavailable" || state.system.owners.find(owner => owner.owner === "tasks")?.status === "unavailable"
      ? `<div class="subtle warning-text">任务数据暂不可用，当前不能把空列表解释成“没有任务”。</div>`
      : coordinationMissionCount ? `<div class="subtle">当前只有系统协调任务；文 / 理工作任务尚未建立。</div>` : `<div class="subtle">这个项目暂时没有工作任务。</div>`;

  const loopHtml = selected ? `
    <section class="nimora-loop" aria-label="Nimora 文理闭环">
      <div class="loop-head"><div><div class="eyebrow">NIMORA LOOP</div><h2>文理闭环</h2><p>文负责形成当前判断，理负责用实践验证；问题和证据回流后，再由文更新下一步。</p></div><span class="status-chip ${loopStage === "feedback" || loopStage === "review" ? "attention" : loopStage === "completed" ? "done" : "active"}">${loopStage === "cognition" ? "正在理解与规划" : loopStage === "practice" ? "正在实践与验证" : loopStage === "feedback" ? "有问题或执行状态需要核实" : loopStage === "review" ? "等待完成审核与确认" : loopStage === "ready" ? "等待启动或继续" : "本轮已收敛"}</span></div>
      <div class="loop-track">
        <div class="loop-step cognition ${loopStage === "cognition" ? "current" : ""}"><span class="loop-mark">文</span><div><strong>理解与规划</strong><small>${cognitionMissions.length} 个任务 · ${activeCognitionCount} 个未结束</small></div></div>
        <span class="loop-arrow">→</span>
        <div class="loop-step practice ${loopStage === "practice" ? "current" : ""}"><span class="loop-mark">理</span><div><strong>实践与验证</strong><small>${practiceMissions.length} 个任务 · ${activePracticeCount} 个未结束</small></div></div>
        <span class="loop-arrow">→</span>
        <div class="loop-step evidence ${loopStage === "feedback" ? "current" : ""}"><span class="loop-mark">证</span><div><strong>证据与问题</strong><small>${uniqueEvidenceCount} 条证据 · ${uniqueOpenProblemCount} 个开放问题</small></div></div>
        <span class="loop-return"><span>↺</span><small>反馈回文，更新判断</small></span>
      </div>
      <div class="loop-governance"><span class="loop-mark">决</span><div><strong>项目治理在闭环之外</strong><small>只有价值、权限、风险或正式完成等边界需要你决定 · ${selected.decisionCount} 个已提交决定</small></div></div>
      ${coordinationMissionCount ? `<details class="advanced loop-coordination"><summary>系统协调 · ${coordinationMissionCount} 个协调任务</summary><p>协调任务只负责传递已授权的工作指令和结果，不负责替文做规划，因此默认不放进主工作流。</p></details>` : ""}
    </section>` : "";

  const activeWorkMission = selectedMission && selectedMission.plane !== "coordination"
    ? selectedMission
    : primaryMissions.find(mission => !mission.terminal) ?? primaryMissions[0];
  const plannerResource = cognitionMissions.find(mission => !mission.terminal)?.workerLabel
    ?? cognitionMissions.find(mission => mission.workerLabel)?.workerLabel
    ?? "由 Nimora 自动选择";
  const executionResources = [...new Set(practiceMissions
    .filter(mission => !mission.terminal && mission.workerLabel)
    .map(mission => mission.workerLabel!))];
  const executionResourceText = executionResources.length ? executionResources.join(" · ") : "按任务自动分配";

  const activitiesHtml = selected?.activities.length
    ? selected.activities.slice(0, 16).map(activity => `
      <div class="activity-row">
        <span class="activity-dot ${activity.kind} ${activity.tone}"></span>
        <div><strong>${htmlEscape(activity.title)}</strong>
          ${activity.detail ? `<p>${htmlEscape(activity.detail)}</p>` : ""}
          <span class="time">${htmlEscape(new Date(activity.at).toLocaleString())}</span>
        </div>
      </div>`).join("")
    : `<div class="subtle">暂无活动。</div>`;

  const artifactsHtml = selected?.artifacts.length
    ? selected.artifacts.slice(0, 12).map(artifact => `
      <button class="resource-row" ${artifact.uri ? `data-action="openArtifact" data-uri="${htmlEscape(artifact.uri)}"` : ""}>
        <span class="resource-icon">↗</span>
        <span><strong>${htmlEscape(artifact.title)}</strong><small>${htmlEscape(artifact.kind)} · ${htmlEscape(new Date(artifact.createdAt).toLocaleString())}</small></span>
      </button>`).join("")
    : `<div class="subtle">暂无产物。</div>`;

  const decisionsHtml = selected?.decisions.length
    ? selected.decisions.slice(0, 8).map(decision => `
      <div class="decision-row"><strong>${htmlEscape(decision.summary)}</strong>
      ${decision.rationale ? `<p>${htmlEscape(decision.rationale)}</p>` : ""}
      <span class="time">${htmlEscape(new Date(decision.committedAt).toLocaleString())}</span></div>`).join("")
    : `<div class="subtle">暂无已确认决定。</div>`;

  const governanceHtml = selected?.governance.length
    ? selected.governance.map(proposal => `
      <div class="governance-card ${proposal.state}">
        <div class="governance-top"><div><span class="status-chip ${proposal.state === "awaiting-human" ? "attention" : "active"}">${proposal.state === "awaiting-human" ? "等待你的确认" : "已确认 · 待提交"}</span><h3>${htmlEscape(proposal.summary)}</h3></div><span class="time">${htmlEscape(new Date(proposal.proposedAt).toLocaleString())}</span></div>
        ${proposal.rationale ? `<p>${htmlEscape(proposal.rationale)}</p>` : ""}
        <div class="governance-meta">影响：${htmlEscape(proposal.scopeLabel)}</div>
        <div class="governance-actions">
          <button class="primary" data-action="${proposal.state === "awaiting-human" ? "acceptProposal" : "commitProposal"}" data-project="${htmlEscape(selected.projectId)}" data-proposal="${htmlEscape(proposal.proposalId)}" data-digest="${htmlEscape(proposal.contentDigest)}" data-summary="${htmlEscape(proposal.summary)}">${proposal.state === "awaiting-human" ? "确认并提交" : "提交已确认决定"}</button>
        </div>
      </div>`).join("")
    : `<div class="attention-clear"><strong>没有待确认的项目决定</strong><span>需要你明确确认的建议会集中出现在这里。</span></div>`;

  const attentionsHtml = selected?.attentions.length
    ? selected.attentions.slice(0, 8).map(item => `
      <button class="attention-row ${item.severity}" ${item.missionId ? `data-action="mission" data-project="${htmlEscape(item.projectId)}" data-mission="${htmlEscape(item.missionId)}"` : ""}>
        <span class="attention-mark">!</span>
        <span class="attention-copy"><strong>${htmlEscape(item.title)}</strong>
          ${item.detail ? `<span>${htmlEscape(item.detail)}</span>` : ""}
          ${item.at ? `<small>${htmlEscape(new Date(item.at).toLocaleString())}</small>` : ""}
        </span>
      </button>`).join("")
    : `<div class="attention-clear"><strong>现在没有需要你处理的事项</strong><span>Nimora 会在需要确认、阻塞或状态不确定时把它放到这里。</span></div>`;

  const graphNodeById = new Map(selected?.graph.nodes.map(node => [node.missionId, node] as const) ?? []);
  const graphLanesHtml = selected?.graph.nodes.length
    ? Array.from({ length: selected.graph.maxDepth + 1 }, (_, depth) => {
      const laneNodes = selected.graph.nodes.filter(node => node.depth === depth);
      return `<div class="graph-lane"><div class="graph-lane-title">${depth === 0 ? "ROOT" : `LEVEL ${depth}`}</div><div class="graph-lane-nodes" data-keyboard-nav="graph-level-${depth}">${laneNodes.map(node => `
        <button class="graph-node ${node.state} ${node.missionId === state.selectedMissionId ? "selected" : ""}" data-action="mission" data-project="${htmlEscape(selected.projectId)}" data-mission="${htmlEscape(node.missionId)}" aria-label="Mission ${htmlEscape(node.goal)}，${missionGraphStateLabel(node.state)}" ${node.missionId === state.selectedMissionId ? `aria-current="true"` : ""}>
          <span class="graph-node-top"><span class="mission-role">${htmlEscape(node.role)}</span><span class="status-chip ${node.state === "attention" || node.state === "waiting" ? "attention" : node.state === "completed" ? "done" : "active"}">${missionGraphStateLabel(node.state)}</span></span>
          <strong>${htmlEscape(node.goal)}</strong>
          <span>${node.workerLabel ? htmlEscape(node.workerLabel) : node.isRoot ? "Project root Mission" : "暂无 Worker"}</span>
          ${node.blockingProblemCount ? `<small class="graph-problem">${node.blockingProblemCount} 个阻塞问题</small>` : node.openProblemCount ? `<small>${node.openProblemCount} 个开放问题</small>` : ""}
        </button>`).join("")}</div></div>`;
    }).join("")
    : `<div class="subtle">这个 Project 还没有 Mission 图。</div>`;

  const graphRelationsHtml = selected?.graph.edges.length
    ? selected.graph.edges.map(edge => {
      const source = graphNodeById.get(edge.sourceMissionId);
      const target = graphNodeById.get(edge.targetMissionId);
      return `<div class="graph-relation ${edge.tone}">
        <button data-action="mission" data-project="${htmlEscape(selected.projectId)}" data-mission="${htmlEscape(edge.sourceMissionId)}">${htmlEscape(source?.goal ?? edge.sourceMissionId)}</button>
        <span class="relation-label">${htmlEscape(edge.label)}</span>
        <span class="relation-arrow">→</span>
        <button data-action="mission" data-project="${htmlEscape(selected.projectId)}" data-mission="${htmlEscape(edge.targetMissionId)}">${htmlEscape(target?.goal ?? edge.targetMissionId)}</button>
      </div>`;
    }).join("")
    : `<div class="subtle">暂无显式 Mission 关系。</div>`;

  const activePathHtml = selected?.graph.activeMissionIds.length
    ? selected.graph.activeMissionIds.map(missionId => {
      const node = graphNodeById.get(missionId);
      return `<button class="path-chip active" data-action="mission" data-project="${htmlEscape(selected.projectId)}" data-mission="${htmlEscape(missionId)}">${htmlEscape(node?.goal ?? missionId)}</button>`;
    }).join("")
    : `<span class="muted">当前没有 running / ready Mission</span>`;
  const waitingPathHtml = selected?.graph.waitingMissionIds.length
    ? selected.graph.waitingMissionIds.map(missionId => {
      const node = graphNodeById.get(missionId);
      return `<button class="path-chip waiting" data-action="mission" data-project="${htmlEscape(selected.projectId)}" data-mission="${htmlEscape(missionId)}">${htmlEscape(node?.goal ?? missionId)}</button>`;
    }).join("")
    : `<span class="muted">没有等待或需要关注的 Mission</span>`;

  const globalActivities = state.projects
    .flatMap(project => project.activities.map(activity => ({ ...activity, projectTitle: project.title })))
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    .slice(0, 60);
  const globalActivityHtml = globalActivities.length
    ? globalActivities.map(activity => `
      <div class="activity-row global">
        <span class="activity-dot ${activity.kind} ${activity.tone}"></span>
        <div><strong>${htmlEscape(activity.title)}</strong>
          <p>${htmlEscape(activity.projectTitle)}${activity.detail ? ` · ${htmlEscape(activity.detail)}` : ""}</p>
          <span class="time">${htmlEscape(new Date(activity.at).toLocaleString())}</span>
        </div>
      </div>`).join("")
    : `<div class="empty-state"><strong>还没有活动</strong><span>项目开始工作后，重要事件会出现在这里。</span></div>`;

  const missionById = new Map(state.projects.flatMap(project => project.missions.map(mission => [mission.missionId, { project, mission }] as const)));
  const liveWorkersHtml = operations?.liveWorkers.length
    ? operations.liveWorkers.map(worker => {
      const owned = worker.taskId ? missionById.get(worker.taskId) : undefined;
      const statusClass = worker.state === "running" || worker.state === "idle" ? "active" : "attention";
      const identity = [worker.workerId, worker.model].filter(Boolean).join(" · ") || "Worker";
      const inner = `<span class="worker-avatar">${owned ? htmlEscape(owned.mission.role) : "W"}</span>
        <span class="worker-copy"><strong>${htmlEscape(identity)}</strong><span>${owned ? htmlEscape(owned.mission.goal) : "当前没有可显示的 Mission 绑定"}</span><small>${owned ? `${htmlEscape(owned.project.title)} · ` : ""}${workerStateLabel(worker.state)}</small></span>
        <span class="status-chip ${statusClass}">${workerStateLabel(worker.state)}</span>`;
      return owned
        ? `<button class="worker-row" data-action="mission" data-project="${htmlEscape(owned.project.projectId)}" data-mission="${htmlEscape(owned.mission.missionId)}">${inner}</button>`
        : `<div class="worker-row static">${inner}</div>`;
    }).join("")
    : "";
  const durableOnlyWorkers = state.projects.flatMap(project => project.missions
    .filter(mission => mission.activeWorkerCount > 0 && !operations?.liveWorkers.some(worker => worker.taskId === mission.missionId))
    .map(mission => ({ project, mission })));
  const durableOnlyWorkersHtml = durableOnlyWorkers.map(({ project, mission }) => `
    <button class="worker-row durable-only" data-action="mission" data-project="${htmlEscape(project.projectId)}" data-mission="${htmlEscape(mission.missionId)}">
      <span class="worker-avatar">${htmlEscape(mission.role)}</span>
      <span class="worker-copy"><strong>${htmlEscape(mission.workerLabel ?? "Worker")}</strong><span>${htmlEscape(mission.goal)}</span><small>${htmlEscape(project.title)} · 持久绑定存在，但当前运行时没有 live session</small></span>
      <span class="status-chip attention">需恢复</span>
    </button>`).join("");
  const workersHtml = liveWorkersHtml || durableOnlyWorkersHtml
    ? `${liveWorkersHtml}${durableOnlyWorkersHtml}`
    : `<div class="empty-state"><strong>当前没有活跃 Worker</strong><span>Worker 会在 Mission 获得 assignment 后显示；持久 Mission 不依赖 Worker 存活。</span></div>`;

  // A provider is not a page: several DeepSeek tabs may be independent candidate
  // resources. Never collapse their count into a misleading single green badge.
  const providerByName = new Map<string, NonNullable<typeof operations>["providers"]>();
  for (const provider of operations?.providers ?? []) {
    const group = providerByName.get(provider.provider) ?? [];
    group.push(provider);
    providerByName.set(provider.provider, group);
  }
  const providers = [...providerByName.entries()].map(([name, observations]) => ({
    name,
    observations,
    healthy: observations.filter(value => value.availability === "available" && value.health?.status === "healthy").length,
  })).sort((a, b) => a.name.localeCompare(b.name));
  const providersHtml = providers.length
    ? providers.map(provider => {
      const representative = provider.observations.find(value => value.availability === "available" && value.health?.status === "healthy") ?? provider.observations[0];
      const healthy = provider.healthy > 0;
      const kindLabel = representative.kind === "web" ? "网页 AI" : representative.kind === "api" ? "API" : htmlEscape(representative.kind);
      const displayName = providerDisplayName(provider.name);
      return `<section class="provider-card ${healthy ? "available" : "attention"}"><div class="provider-card-head"><div class="connection-icon">${htmlEscape(displayName.slice(0, 2).toUpperCase())}</div><div><strong>${htmlEscape(displayName)}</strong><p>${kindLabel} · ${representative.models.length ? htmlEscape(representative.models.join(" / ")) : "模型由当前服务提供"}</p></div><span class="status-chip ${healthy ? "active" : "attention"}">${healthy ? "可用" : providerAvailabilityLabel(representative.availability)}</span></div><small>${healthy ? `${provider.healthy} 个连接可用` : "当前没有可用连接"}</small></section>`;
    }).join("")
    : `<div class="empty-state"><strong>${operations?.candidateReadState === "unavailable" ? "暂时无法读取 AI 资源状态" : "还没有可用 AI 资源"}</strong><span>可以连接网页 AI 或配置 API 模型。</span></div>`;
  const providerDiagnosticsHtml = providers.length
    ? providers.map(provider => `<div class="diagnostic-row"><strong>${htmlEscape(providerDisplayName(provider.name))}</strong><span>${provider.observations.length} 个候选 · ${provider.healthy} 个健康</span></div>`).join("")
    : `<p class="muted">当前没有可显示的资源观测。</p>`;
  const providerReady = providers.some(provider => provider.healthy > 0);
  const workspaceOpen = vscode.workspace.workspaceFolders?.length === 1;
  const setupChecks = [
    { label: "项目文件夹", ready: workspaceOpen, detail: workspaceOpen ? vscode.workspace.workspaceFolders?.[0]?.name ?? "已打开" : "请打开单个项目文件夹；多文件夹工作区暂不支持自治" },
    { label: "信任工作区", ready: workspaceOpen && vscode.workspace.isTrusted, detail: workspaceOpen && vscode.workspace.isTrusted ? "已信任" : "请在原生工作区信任页面审核；未信任时不会启动工作" },
    { label: "AI 资源", ready: providerReady, detail: providerReady ? "至少一种 AI 资源可用" : "请配置 API 模型或登录网页 AI" },
  ];
  const setupHtml = setupChecks.map(item => `<div class="setup-check ${item.ready ? "ready" : "pending"}"><span>${item.ready ? "✓" : "·"}</span><div><strong>${item.label}</strong><small>${htmlEscape(item.detail)}</small></div></div>`).join("")
    + `<div class="setup-check"><span>↗</span><div><strong>执行权限 · 按任务确认</strong><small>配置资源不代表授权；启动时会确认本轮操作与 API 费用。</small></div></div>`
    + `<div class="setup-actions">${!workspaceOpen ? `<button data-action="openWorkspace">打开项目文件夹</button>` : ""}${workspaceOpen && !vscode.workspace.isTrusted ? `<button data-action="manageWorkspaceTrust">审核工作区信任</button>` : ""}</div>`;
  const setupReady = setupChecks.every(item => item.ready);

  const missionExecutionsHtml = selectedMission?.executions.length
    ? selectedMission.executions.slice(0, 10).map(execution => `
      <div class="execution-row ${htmlEscape(execution.status)}">
        <span class="execution-state">${execution.status === "succeeded" ? "✓" : execution.status === "failed" ? "!" : execution.status === "unknown" ? "?" : "·"}</span>
        <span class="execution-copy"><strong>${htmlEscape(execution.toolName)}</strong>${execution.detail ? `<span>${htmlEscape(execution.detail)}</span>` : ""}<small>${htmlEscape(new Date(execution.finishedAt ?? execution.requestedAt).toLocaleString())}</small></span>
        <span class="status-chip ${execution.status === "succeeded" ? "done" : execution.status === "unknown" || execution.status === "failed" ? "attention" : "active"}">${htmlEscape(executionStatusLabel(execution.status))}</span>
      </div>`).join("")
    : `<div class="subtle">这个任务还没有执行记录。</div>`;

  const missionProblemsHtml = selectedMission?.problems.length
    ? selectedMission.problems.map(problem => `
      <div class="problem-card ${problem.blocking && problem.state === "Open" ? "blocking" : ""}">
        <div class="problem-head"><strong>${problem.blocking ? "阻塞问题" : "问题"}</strong><span class="status-chip ${problem.state === "Open" ? "attention" : "done"}">${problem.state === "Open" ? "待解决" : "已回答"}</span></div>
        <p>${htmlEscape(problem.question)}</p>
        ${problem.answers.length ? `<div class="problem-answer"><span>回答</span>${problem.answers.map(answer => `<p>${htmlEscape(answer)}</p>`).join("")}</div>` : ""}
        ${problem.evidence.length ? `<div class="evidence-list"><span>证据</span>${problem.evidence.map(evidence => `<small>${htmlEscape(evidence)}</small>`).join("")}</div>` : ""}
      </div>`).join("")
    : `<div class="subtle">没有与这个 Mission 关联的问题。</div>`;

  const missionCollaborationHtml = selectedMission?.collaboration.length
    ? selectedMission.collaboration.slice(0, 10).map(exchange => `
      <div class="collaboration-row"><span class="collaboration-kind">${htmlEscape(collaborationKindLabel(exchange.kind))}</span><div><strong>${htmlEscape(exchange.title)}</strong>${exchange.detail ? `<p>${htmlEscape(exchange.detail)}</p>` : ""}<span class="time">${htmlEscape(new Date(exchange.createdAt).toLocaleString())}</span></div></div>`).join("")
    : `<div class="subtle">暂无问题、证据或交接记录。</div>`;

  const missionArtifactsHtml = selectedMission?.artifacts.length
    ? selectedMission.artifacts.map(artifact => `<button class="resource-row" ${artifact.uri ? `data-action="openArtifact" data-uri="${htmlEscape(artifact.uri)}"` : ""}><span class="resource-icon">↗</span><span><strong>${htmlEscape(artifact.title)}</strong><small>${htmlEscape(artifact.kind)} · ${htmlEscape(new Date(artifact.createdAt).toLocaleString())}</small></span></button>`).join("")
    : `<div class="subtle">这个 Mission 还没有产物。</div>`;

  const continuableMission = selectedMission && !selectedMission.terminal
    ? selectedMission
    : selected?.missions.find(mission => !mission.terminal);
  const continuableHasLiveWorker = continuableMission
    ? operations?.liveWorkers.some(worker => worker.taskId === continuableMission.missionId && worker.state !== "disposed")
    : false;
  const continuableNeedsWorker = Boolean(continuableMission && (
    continuableMission.activeWorkerCount === 0
    || (operations !== undefined && !continuableHasLiveWorker)
  ));
  const continueActionHtml = selected?.unknownExecutionCount
    ? `<button data-action="openWorkSessions" title="存在 UNKNOWN execution，必须先完成 reconciliation">先核实 UNKNOWN</button>`
    : selectedRecoveredOnly
      ? recoveredAction
    : selectedManagedAutonomy
      ? `<button data-action="continueProject" data-project="${htmlEscape(selected!.projectId)}">按当前资源策略继续自主工作</button>`
    : continuableNeedsWorker
      ? `<button data-action="selectWorker" title="Mission 持久存在，但需要可用 Worker 才能继续">恢复 / 选择 Worker</button>`
    : continuableMission
      ? `<button data-action="continueMission" data-project="${htmlEscape(selected!.projectId)}" data-mission="${htmlEscape(continuableMission.missionId)}">手动继续这个任务</button>`
      : `<button disabled title="当前没有可继续的非终态任务">项目当前无可继续任务</button>`;
  const completionHtml = selected && pendingLaterRootIds.includes(selected.projectId)
    ? `<section class="completion-banner"><button data-action="resumeNextProjectGoal" data-project="${htmlEscape(selected.projectId)}">恢复上次新增目标</button><p>沿用原目标与操作身份，核实并补齐原工作轮次。</p></section>`
    : selected?.status === "completed"
    ? `<section class="completion-banner"><div><span class="completion-mark">✓</span><div><strong>这个项目当前已完成</strong><p>本轮任务都已结束，产物和已提交决定仍保留在项目中。</p></div></div>${selectedManagedAutonomy && !selectedRecoveredOnly && !pendingLaterRootIds.includes(selected.projectId) ? `<button data-action="startNextProjectGoal" data-project="${htmlEscape(selected.projectId)}">在这个项目中开始下一项工作</button>` : ""}</section>`
    : "";

  const assignReadyHtml = selected && selectedManagedAutonomy && !selectedRecoveredOnly && selected.status !== "completed"
    ? `<button data-action="assignReadyWebMissions" data-project="${htmlEscape(selected.projectId)}">高级 · 手动分配就绪任务</button>`
    : "";
  const autonomyHtml = selected && selectedManagedAutonomy && selected.status !== "completed" && !selected.unknownExecutionCount
    ? `<button data-action="runWebAutonomy" data-project="${htmlEscape(selected.projectId)}">高级 · 执行一次自治循环</button>`
    : "";
  const humanPrimaryActionHtml = selected && humanExperience?.action !== "none"
    ? humanExperience?.action === "continue-project"
      ? `<button class="primary" data-action="continueProject" data-project="${htmlEscape(selected.projectId)}">${htmlEscape(humanExperience.actionLabel ?? "继续")}</button>`
      : humanExperience?.action === "review-completion"
        ? `<button class="primary" data-action="reviewProjectCompletion" data-project="${htmlEscape(selected.projectId)}">${htmlEscape(humanExperience.actionLabel ?? "审核并完成项目")}</button>`
        : humanExperience?.action === "open-attention"
          ? `<button class="primary" data-action="openAttention">${htmlEscape(humanExperience.actionLabel ?? "查看需要我处理的事项")}</button>`
          : `<button class="primary" data-action="openWorkSessions">${htmlEscape(humanExperience?.actionLabel ?? "工作记录")}</button>`
    : "";
  const nowHtml = selected && humanExperience ? `
    <section class="now-card ${htmlEscape(humanExperience.state)}" aria-live="polite">
      <div><div class="eyebrow">NOW</div><h2>${htmlEscape(humanExperience.headline)}</h2><p>${htmlEscape(humanExperience.detail)}</p></div>
      <div class="now-actions">${selectedRecoveredOnly ? recoveredAction : humanPrimaryActionHtml}</div>
      ${humanExperience.technicalDetail ? `<details class="advanced"><summary>技术详情</summary><p>${htmlEscape(humanExperience.technicalDetail)}</p></details>` : ""}
    </section>` : "";
  const advancedProjectControls = selected && !selectedRecoveredOnly && selected.status !== "completed"
    ? `<details class="advanced project-advanced"><summary>高级操作与诊断</summary><div class="hero-actions">${selectedManagedAutonomy ? "" : continueActionHtml}${autonomyHtml}${assignReadyHtml}<button data-action="exportProjectBackup" data-project="${htmlEscape(selected.projectId)}">备份项目</button><button data-action="selectProjectSkills" data-project="${htmlEscape(selected.projectId)}">本轮 Skills</button><button data-action="archiveRetiredConversation" data-project="${htmlEscape(selected.projectId)}">归档旧执行会话</button><button data-action="selectWorker">执行资源</button><button data-action="workerStatus">连接状态</button></div><p>这些入口用于备份、诊断、兼容和手动控制。日常工作优先使用上方主操作；通常不需要直接管理单个执行资源。</p></details>`
    : "";
  const missionFocus = selectedMission ? `
    <section class="focus-card">
      <div class="focus-head"><div><div class="eyebrow">${selectedMission.plane === "cognition" ? "COGNITION · 文" : selectedMission.plane === "practice" ? "PRACTICE · 理" : "COORDINATION"}</div><h2>${htmlEscape(selectedMission.goal)}</h2><p>${htmlEscape(missionRoleLabel(selectedMission.role))} · ${htmlEscape(taskStatusLabel(selectedMission.status))}</p></div>
      <div class="focus-actions"><span class="status-chip ${selectedMission.terminal ? "done" : "active"}">${selectedMission.terminal ? "已结束" : "进行中"}</span>${!selectedMission.terminal && !selected?.unknownExecutionCount ? selectedManagedAutonomy ? `<button data-action="continueProject" data-project="${htmlEscape(selectedMission.projectId)}">让 Nimora 继续推进</button>` : selectedMission.activeWorkerCount === 0 || (operations !== undefined && !operations.liveWorkers.some(worker => worker.taskId === selectedMission.missionId && worker.state !== "disposed")) ? `<button data-action="selectWorker">恢复执行资源</button>` : `<button data-action="continueMission" data-project="${htmlEscape(selectedMission.projectId)}" data-mission="${htmlEscape(selectedMission.missionId)}">手动继续这个任务</button>` : ""}</div></div>
      <div class="mission-detail-grid nimora-mission-summary">
        <div class="mission-purpose-card ${selectedMission.plane}"><span class="worker-avatar large">${htmlEscape(selectedMission.role)}</span><div><span class="label">任务职责</span><strong>${htmlEscape(missionRoleLabel(selectedMission.role))}</strong><p>${selectedMission.plane === "cognition" ? "形成当前最佳理解、计划和下一步工作指令。" : selectedMission.plane === "practice" ? "执行、测试、测量现实，并把问题和证据反馈给文。" : "传递已授权的命令和结果，不拥有规划权。"}</p></div></div>
        <div class="mini-stats">
          <div><strong>${selectedMission.executionCount}</strong><span>执行</span></div>
          <div><strong>${selectedMission.artifactCount}</strong><span>产物</span></div>
          <div><strong>${selectedMission.failedExecutionCount}</strong><span>待确认</span></div>
        </div>
      </div>
      <details class="advanced mission-resource-detail"><summary>执行资源 · ${htmlEscape(selectedMission.workerLabel ?? "由 Nimora 自动分配")}</summary><div class="mission-resource-body"><p>Worker 只是这个任务的临时执行资源；更换 AI 不会改变任务目标、历史和已有结果。</p>${selectedRecoveredOnly ? `<button disabled title="先核实安全接班状态">暂不可更换</button>` : `<button data-action="selectWorker">选择 / 更换执行资源</button>`}</div></details>
      <div class="mission-deep-grid">
        <section class="mission-subpanel"><div class="section-title"><h3>${selectedMission.plane === "cognition" ? "认知进展" : selectedMission.plane === "practice" ? "实践进展" : "协调进展"}</h3><span class="muted">${selectedMission.todos.filter(todo => todo.status === "completed").length} / ${selectedMission.todos.length} 待办已完成</span></div>${selectedMission.progress ? `<p>${htmlEscape(selectedMission.progress.message)}</p><p class="muted">阶段报告${selectedMission.progress.percent !== undefined ? ` · ${selectedMission.progress.percent}%` : ""} · ${htmlEscape(selectedMission.progress.at)}；是否完成仍以实际结果和证据为准。</p>` : `<p class="muted">尚无新的阶段报告，实际执行记录会保留在下方。</p>`}${selectedMission.todos.map(todo => `<p>${todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "▶" : "○"} ${htmlEscape(todo.title)}</p>`).join("")}</section>
        <section class="mission-subpanel"><div class="section-title"><h3>执行</h3><span class="muted">${selectedMission.executionCount}</span></div>${missionExecutionsHtml}</section>
        <section class="mission-subpanel"><div class="section-title"><h3>问题与答案</h3><span class="muted">${selectedMission.problems.length}</span></div>${missionProblemsHtml}</section>
        <section class="mission-subpanel"><div class="section-title"><h3>证据与回流</h3><span class="muted">${selectedMission.collaboration.length}</span></div>${missionCollaborationHtml}</section>
        <section class="mission-subpanel"><div class="section-title"><h3>本任务产物</h3><span class="muted">${selectedMission.artifacts.length}</span></div>${missionArtifactsHtml}</section>
      </div>
    </section>` : "";

  const currentExecutionHtml = activeWorkMission ? `
    <section class="live-execution-card" id="current-execution-section">
      <div class="panel-head compact"><div><div class="eyebrow">CURRENT EXECUTION</div><h2>当前执行</h2></div><span class="live-dot-label"><span class="live-dot ${missionIsRunning(activeWorkMission) ? "" : "inactive"}"></span>${activeWorkMission.terminal ? "已结束" : missionIsRunning(activeWorkMission) ? "正在运行" : taskStatusLabel(activeWorkMission.status)}</span></div>
      <div class="execution-agent-line">
        <span class="execution-avatar">${htmlEscape(activeWorkMission.role)}</span>
        <div><strong>${htmlEscape(missionRoleLabel(activeWorkMission.role))}</strong><small>${htmlEscape(activeWorkMission.workerLabel ?? "由 Nimora 自动分配")}</small></div>
      </div>
      <div class="execution-message">
        <strong>${htmlEscape(activeWorkMission.goal)}</strong>
        <p>${htmlEscape(activeWorkMission.progress?.message ?? (activeWorkMission.terminal ? "本任务已结束，执行记录与产物保留。" : "尚无新的阶段报告，请查看任务状态与实际执行记录。"))}</p>
      </div>
      <div class="execution-ops">
        <div class="execution-ops-title">执行的操作</div>
        ${activeWorkMission.executions.length ? activeWorkMission.executions.slice(0, 6).map(execution => `
          <div class="execution-op-row"><span class="execution-state">${execution.status === "succeeded" ? "✓" : execution.status === "failed" ? "!" : execution.status === "unknown" ? "?" : "·"}</span><span><strong>${htmlEscape(execution.toolName)}</strong><small>${htmlEscape(execution.detail ?? executionStatusLabel(execution.status))}</small></span><time>${htmlEscape(new Date(execution.finishedAt ?? execution.requestedAt).toLocaleTimeString())}</time></div>`).join("") : `<div class="subtle">当前还没有工具执行记录。</div>`}
      </div>
      <div class="execution-footer"><button data-action="mission" data-project="${htmlEscape(activeWorkMission.projectId)}" data-mission="${htmlEscape(activeWorkMission.missionId)}">查看任务详情</button></div>
    </section>` : `<section class="live-execution-card empty-live"><div class="panel-head compact"><h2>当前执行</h2></div><div class="empty-state"><strong>当前没有正在执行的文 / 理任务</strong><span>Nimora 会在开始新的工作后把实时进展显示在这里。</span></div></section>`;

  const workResourceSideHtml = selected ? `
    <aside class="work-resource-side">
      <div class="work-resource-head"><div><div class="eyebrow">AI RESOURCES</div><h2>AI 资源</h2></div><span class="status-chip ${providerReady ? "active" : "attention"}">${providerReady ? "正常" : "待连接"}</span></div>
      <section class="resource-role-card"><span class="resource-role-label">总文 · 规划与决策</span><strong>${htmlEscape(plannerResource)}</strong><small>负责理解目标、规划和下一步判断</small></section>
      <section class="resource-role-card"><span class="resource-role-label">执行资源</span><strong>${htmlEscape(executionResourceText)}</strong><small>按任务、能力和当前可用状态自动分配</small></section>
      <section class="resource-policy-card">
        <div><span>执行模式</span><strong>按项目资源策略</strong></div>
        <div><span>资源选择</span><strong>Nimora 自动调度</strong></div>
        <div><span>API 费用</span><strong>使用前确认</strong></div>
        <button data-action="configureResources">设置后续工作偏好</button>
        <small>已有本轮授权保持不变；下一轮启动时确认新偏好。</small>
      </section>
      <button class="resource-manage-button" data-action="selectView" data-view="connections">管理 AI 资源 →</button>
    </aside>` : "";

  const emptyMain = state.system.mode === "empty" ? `
    <section class="empty-product-state" aria-labelledby="empty-projects-title">
       ${reviewedRecoveryAvailable ? `<button data-action="adoptReviewedWebCognition" ${vscode.workspace.isTrusted ? "" : "disabled"}>接入已完成的 DeepSeek 分析 · 仅建项</button>` : ""}
      <div class="empty-mark">N</div><h1 id="empty-projects-title">从一个真实目标开始</h1><p>选择项目位置，告诉 Nimora 你希望完成什么，之后的任务拆解、执行和结果验证会由 Nimora 组织。</p>
      <div class="setup-panel"><div class="section-title"><div><h2>开始前检查</h2><p>确认工作区、AI 资源与必要权限已经就绪。</p></div></div>${setupHtml}<div class="setup-actions"><button data-action="selectView" data-view="connections">查看 AI 资源</button><button data-action="configureResources">执行偏好</button></div></div>
      <button class="primary" data-action="newProjectAtLocation">选择位置并新建项目</button><button data-action="selectView" data-view="connections">先设置 AI 资源</button>
    </section>` : `
    <section class="empty-product-state unavailable" role="status" aria-labelledby="unavailable-title">
      <div class="empty-mark">!</div><h1 id="unavailable-title">当前无法完整读取 Nimora 工作区</h1><p>Nimora 暂时不能确认全部项目数据，因此不会把缺失信息误判成“没有项目”。</p><details class="advanced"><summary>技术详情</summary><div class="owner-health-grid wide">${ownerHealthHtml}</div></details><button class="primary" data-action="refresh">重新读取</button>
    </section>`;

  const projectManagementMain = `
    <div class="project-page">
    <div class="project-breadcrumb"><span>⌂</span><button data-action="selectView" data-view="projects">项目</button><span>›</span><strong>项目管理</strong></div>
    <div class="page-head project-manager-head"><div><div class="eyebrow">PROJECTS</div><h1>项目管理</h1><p>管理项目、选择位置，并进入项目开始工作。</p></div><div class="hero-actions"><button data-action="newProjectAtLocation">选择位置新建</button><button class="primary" data-action="newWebProject" ${workspaceOpen && vscode.workspace.isTrusted ? "" : "disabled"}>＋ 新建项目</button>${selected ? `<button class="destructive" data-action="archiveProjectFromList" data-project="${htmlEscape(selected.projectId)}">移出列表</button>` : ""}</div></div>
    <div class="project-management-grid">
      <section class="project-manager-list-panel"><div class="section-title"><div><h2>项目列表</h2><p>${visibleProjects.length} 个显示中的项目${archivedProjectIds.length ? ` · ${archivedProjectIds.length} 个已移出列表` : ""}</p></div></div><input id="project-management-filter" class="project-filter" type="search" aria-label="筛选项目" placeholder="按名称、目标或位置筛选…"><div class="project-manager-list" data-keyboard-nav="project-manager">${projectManagementListHtml}</div>${archivedProjectsHtml ? `<details class="advanced archived-projects"><summary>已移出列表（${archivedProjectIds.length}）</summary>${archivedProjectsHtml}</details>` : ""}</section>
      <section class="project-overview-panel">${selected ? `
        <div class="project-overview-head"><div class="project-management-icon large">▣</div><div><div class="eyebrow">当前选择</div><h2>${htmlEscape(selected.title)}</h2><p>${htmlEscape(selected.goal)}</p></div><span class="status-chip ${selected.status === "attention" ? "attention" : selected.status === "completed" ? "done" : "active"}">${statusLabel(selected.status)}</span></div>
        <div class="project-overview-actions"><button data-action="openProjectWorkspace" data-project="${htmlEscape(selected.projectId)}">▣ 查看文件夹</button><button class="primary project-enter-button" data-action="enterProjectWork" data-project="${htmlEscape(selected.projectId)}">▶ ${selected.workspace && currentWorkspacePath && selected.workspace.toLocaleLowerCase() !== currentWorkspacePath.toLocaleLowerCase() ? "打开项目工作区 →" : "进入工作 →"}</button></div>
        <nav class="project-detail-tabs"><button class="active" data-action="scrollSection" data-target="project-overview-detail">项目概览</button><button data-action="enterProjectWork" data-project="${htmlEscape(selected.projectId)}">任务进度</button><button data-action="openProjectWorkspace" data-project="${htmlEscape(selected.projectId)}">文件</button><button data-action="selectView" data-view="settings">设置</button></nav>
        <div class="project-overview-detail" id="project-overview-detail"><div><span>项目位置</span><strong>${selected.workspace ? htmlEscape(selected.workspace) : "未记录"}</strong><button data-action="changeProjectLocation" data-project="${htmlEscape(selected.projectId)}">更改位置</button></div><div><span>项目目标</span><strong>${htmlEscape(selected.goal)}</strong></div><div><span>整体推进</span><strong>${selected.progress.percent}%</strong><progress class="progress-track" value="${selected.progress.percent}" max="100" aria-label="整体推进 ${selected.progress.percent}%">${selected.progress.percent}%</progress><small>已结束 ${completedWorkMissionCount} · 未结束 ${activeCognitionCount + activePracticeCount} · 需要关注 ${selected.attentionCount}</small></div></div>
        <div class="project-overview-activity"><div class="section-title"><div><h3>最近活动</h3><p>只显示对这个项目有意义的变化。</p></div></div>${activitiesHtml}</div>
        <div class="project-danger-zone"><div><strong>从项目列表移除</strong><p>只会隐藏这个项目，不删除磁盘文件、工作历史或已有结果。</p></div><button data-action="archiveProjectFromList" data-project="${htmlEscape(selected.projectId)}">移出列表</button></div>
      ` : `<div class="empty-state"><strong>选择一个项目</strong><span>左侧选择项目后可以查看位置、进度，并进入工作视图。</span></div>`}</section>
    </div></div>`;

  const projectMain = selected ? `
    <div class="work-page">
      ${projectSourceBanner}
      ${completionHtml}
      <div class="work-breadcrumb"><span>⌂</span><button data-action="selectView" data-view="work">工作</button><span>›</span><strong>${htmlEscape(selected.title)}</strong></div>
      <header class="work-titlebar">
        <div class="work-project-identity"><span class="work-project-icon">▣</span><div><h1>${htmlEscape(selected.title)}</h1><p>${htmlEscape(selected.goal)}</p></div></div>
        <div class="work-title-actions"><button data-action="selectView" data-view="projects">项目管理</button><button data-action="openWorkSessions">···</button>${humanPrimaryActionHtml}</div>
      </header>
      <div class="work-layout-grid">
        <div class="work-main-column">
          <section class="work-status-overview">
            <div class="status-overview-cell state ${htmlEscape(humanExperience?.state ?? selected.status)}"><span>当前状态</span><strong><i class="state-dot"></i>${htmlEscape(humanExperience?.headline ?? statusLabel(selected.status))}</strong><small>${htmlEscape(activeWorkMission?.goal ?? "等待下一项工作")}</small></div>
            <div class="status-overview-cell progress"><span>整体推进</span><div class="status-progress-line"><progress class="progress-track" value="${selected.progress.percent}" max="100" aria-label="整体推进 ${selected.progress.percent}%">${selected.progress.percent}%</progress><strong>${selected.progress.percent}%</strong></div><small>任务已结束 ${selected.progress.completed} · 进行中 ${selected.progress.running} · 待开始 ${selected.progress.ready + selected.progress.waiting}</small>${selected.progress.totalTodos ? `<small>待办已完成 ${selected.progress.completedTodos} / ${selected.progress.totalTodos}</small>` : ""}</div>
            <div class="status-overview-cell remaining"><span>当前工作量</span><strong>${activeCognitionCount + activePracticeCount} 个未结束任务</strong><small>${selected.attentionCount ? `${selected.attentionCount} 项需要你处理` : "无需你介入"}</small></div>
          </section>
          <nav class="work-tabs" aria-label="工作视图分区">
            <button class="active" data-action="scrollSection" data-target="workflow-section">任务流程</button>
            <button data-action="scrollSection" data-target="current-execution-section">当前执行</button>
            <button data-action="scrollSection" data-target="messages-section">消息与决定 (${selected.governance.length})</button>
            <button data-action="scrollSection" data-target="artifacts-section">产物 (${selected.artifactCount})</button>
            <button data-action="scrollSection" data-target="attention-section">问题 (${selected.attentionCount})</button>
          </nav>
          <div class="work-core-grid">
            <section class="workflow-panel mock-panel" id="workflow-section">
              <div class="panel-head"><div><div class="eyebrow">WORKFLOW</div><h2>工作流程</h2></div><span class="muted">${completedWorkMissionCount} / ${primaryMissions.length} 已结束</span></div>
              <div class="workflow-timeline" data-keyboard-nav="missions">${missionsHtml}</div>
              <details class="advanced architecture-loop-details"><summary>高级 · 文理闭环与完整结构</summary>${loopHtml}<div class="path-summary"><div><span class="path-label">运行中 / 待开始</span><div class="path-chips">${activePathHtml}</div></div><div><span class="path-label">等待 / 关注</span><div class="path-chips">${waitingPathHtml}</div></div></div><div class="graph-stage">${graphLanesHtml}</div><div class="graph-relations"><div class="graph-relations-title">显式关系</div>${graphRelationsHtml}</div></details>
            </section>
            ${currentExecutionHtml}
            ${workResourceSideHtml}
          </div>
          <section class="work-secondary-section" id="messages-section"><div class="section-title"><div><h2>消息与决定</h2><p>只有确实需要你确认的项目级事项才会出现在这里。</p></div><span class="muted">${selected.governance.length} 待处理</span></div>${governanceHtml}</section>
          <section class="work-secondary-section attention-panel" id="attention-section"><div class="section-title"><div><h2>需要你处理</h2><p>阻塞、不确定状态和真正需要人工介入的问题。</p></div><span class="attention-count ${selected.attentionCount ? "has" : ""}">${selected.attentionCount}</span></div>${attentionsHtml}</section>
          <section class="work-secondary-section" id="artifacts-section"><div class="section-title"><div><h2>产物与证据</h2><p>查看已经形成的文件、输出和可验证结果。</p></div><span class="muted">${selected.artifactCount}</span></div><div class="two-col lower"><section>${artifactsHtml}</section><section><div class="section-title"><h3>已提交决定</h3><span class="muted">${selected.decisionCount}</span></div>${decisionsHtml}</section></div></section>
          <details class="advanced selected-task-details"><summary>高级 · 当前任务完整详情</summary>${missionFocus}</details>
          <details class="advanced project-advanced-shell"><summary>高级操作与诊断</summary>${advancedProjectControls}</details>
        </div>
      </div>
    </div>` : state.projects.length && !visibleProjects.length ? `
      <section class="empty-product-state"><div class="empty-mark">N</div><h1>没有显示中的项目</h1><p>所有项目都已从项目列表移出。它们的文件和历史仍然保留，可以随时恢复。</p><button class="primary" data-action="selectView" data-view="projects">打开项目管理并恢复</button></section>` : emptyMain;

  const globalMain = view === "projects" ? projectManagementMain
    : view === "activity" ? `
    <div class="page-head"><div><div class="eyebrow">HISTORY</div><h1>所有项目的活动</h1><p>查看真正影响项目和任务的历史变化，不展示原始系统日志。</p></div><button data-action="refresh">刷新</button></div>
    <section class="single-panel timeline-panel">${globalActivityHtml}</section>`
    : view === "workers" ? `
      <div class="page-head"><div><div class="eyebrow">RUNTIME RESOURCES</div><h1>执行资源详情</h1><p>这里查看临时 Worker 和运行连接。任务、项目和历史不会因为某个 AI 会话退出而消失。</p></div><button data-action="selectWorker">选择 / 更换执行资源</button></div>
      <div class="connection-grid"><section class="connection-card"><div class="connection-icon">D</div><div><strong>DeepSeek 网页 AI</strong><p>自动打开网页，并请求原生共享授权。</p></div><button data-action="connectWebAi" data-provider="deepseek">连接 DeepSeek</button></section><section class="connection-card"><div class="connection-icon">G</div><div><strong>ChatGPT 网页 AI</strong><p>自动打开网页，或复用现有空闲 Worker。</p></div><button data-action="connectWebAi" data-provider="chatgpt">连接 ChatGPT</button></section></div>
      <section class="provider-panel"><div class="section-title"><div><h2>可调用资源</h2><p>这些只是 Nimora 可分配的计算资源；真正的任务归属仍由 Mission 保持。</p></div><span class="status-chip ${providerReady ? "active" : "attention"}">${providerReady ? "资源可用" : "需要连接"}</span></div><div class="provider-grid">${providersHtml}</div><details class="advanced"><summary>调度技术详情</summary><p>可用性来自只读 candidate observation；最终 assignment 仍由 MissionWorkerAssignmentService 做硬约束筛选。</p></details></section>
      <section class="single-panel"><div class="section-title"><div><h2>当前 Worker 会话</h2><p>Worker 是一次性的执行资源，可以被替换；Project / Mission 才是长期身份。</p></div><span class="muted">${operations?.liveWorkers.length ?? 0} 个运行会话</span></div>${workersHtml}</section>`
      : view === "connections" ? `
        <div class="page-head"><div><div class="eyebrow">AI RESOURCES</div><h1>AI 资源</h1><p>查看哪些 AI 当前可用，并设置 Nimora 应该优先使用网页、API 还是混合执行。</p></div><button data-action="configureResources">执行偏好</button></div>
        <section class="setup-panel settings-setup"><h2>首次使用：选择一种 AI 即可</h2><p>网页方式：打开 DeepSeek，登录并按提示共享页面，再选择“DeepSeek 网页”执行偏好。API 方式：添加端点、模型与密钥，再选择“API 全流程”。密钥只填写在产品密码框中。</p><p class="muted">这两种本机方式无需配置 Cloudflare 公网桥。外部 AI 通过 MCP 连接本机时，才需要外部可达的桥接地址。API 会产生费用，当前没有严格金额上限。</p></section>
        <section class="resource-principle"><div class="resource-principle-mark">N</div><div><strong>AI 是资源，不是项目身份</strong><p>Nimora 会把项目和任务保留在自己的持久状态中，再按任务需要选择 DeepSeek、ChatGPT、API 或其他执行资源。更换 AI 不会重建项目。</p></div></section>
        <section class="provider-panel"><div class="section-title"><div><h2>当前可用 AI</h2><p>Nimora 会在你允许的资源范围内自动选择合适的执行资源。</p></div><span class="status-chip ${providerReady ? "active" : "attention"}">${providerReady ? "有可用资源" : "需要连接"}</span></div><div class="provider-grid">${providersHtml}</div></section>
        <div class="connection-grid">
          <section class="connection-card"><div class="connection-icon">A</div><div><strong>API 模型</strong><p>添加和管理 Nimora 可以调用的 API 模型；涉及付费的工作仍会在启动时明确确认。</p></div><button data-action="configureApiProfiles">管理 API 模型</button><button data-action="configureResources">执行偏好</button></section>
          <section class="connection-card"><div class="connection-icon">D</div><div><strong>DeepSeek 网页 AI</strong><p>无需 API Key；登录与共享仍需你确认。</p></div><button data-action="connectWebAi" data-provider="deepseek">打开并连接</button></section>
          <section class="connection-card"><div class="connection-icon">G</div><div><strong>ChatGPT 网页 AI</strong><p>连接已登录的 ChatGPT 网页；需要共享或登录时 Nimora 会提示你。</p></div><button data-action="connectWebAi" data-provider="chatgpt">打开并连接</button></section>
          <section class="connection-card"><div class="connection-icon">P</div><div><strong>执行权限</strong><p>控制文件、终端和浏览器等操作在什么情况下需要你的确认。</p></div><button data-action="permissions">管理权限</button></section>
        </div>
        <details class="advanced resource-diagnostics"><summary>高级 · 连接与运行诊断</summary>
          <section class="canonical-health-panel"><div class="section-title"><div><h2>运行数据完整性</h2><p>${unavailableOwners.length ? `${unavailableOwners.length} 个内部状态源当前不可用。` : "项目、任务和协作状态均可读取。"}</p></div><span class="status-chip ${unavailableOwners.length ? "attention" : "active"}">${state.system.reconstruction === "ready" ? "正常" : "部分可用"}</span></div><div class="owner-health-grid wide">${ownerHealthHtml}</div></section>
          <section class="provider-panel"><div class="section-title"><div><h2>资源观测详情</h2><p>用于排查可用性和连接问题，不影响普通项目操作。</p></div><button data-action="workerStatus">查看连接状态</button></div><div class="diagnostic-list">${providerDiagnosticsHtml}</div>${operations?.candidateErrors.length ? operations.candidateErrors.map(error => `<p>${htmlEscape(error)}</p>`).join("") : `<p class="muted">当前没有资源观测错误。</p>`}</section>
          <div class="setup-actions"><button data-action="connectMcp">连接 Mission MCP</button><button data-action="pairPersonalEdge">配对 Personal Edge</button><button data-action="selectView" data-view="workers">查看执行资源详情</button></div>
        </details>`
        : view === "settings" ? `
          <div class="page-head"><div><div class="eyebrow">SETTINGS</div><h1>Nimora 设置</h1><p>管理 Nimora 自己的执行偏好、权限、备份和诊断。</p></div></div>
          <section class="setup-panel settings-setup"><div class="section-title"><div><h2>产品就绪状态</h2><p>${setupReady ? "基础使用环境已就绪。" : "还有项目需要处理。"}</p></div><span class="status-chip ${setupReady ? "active" : "attention"}">${setupReady ? "已就绪" : "待设置"}</span></div>${setupHtml}<div class="setup-actions"><button data-action="configureApiProfiles">API 模型</button><button data-action="configureResources">执行偏好</button></div></section>
          <div class="settings-list">
            <section><div><strong>执行权限</strong><p>控制文件、终端和浏览器等操作什么时候需要确认。</p></div><button data-action="permissions">打开权限设置</button></section>
            <section><div><strong>AI 资源</strong><p>检查网页 AI 与 API 模型的可用状态。</p></div><button data-action="selectView" data-view="connections">查看 AI 资源</button></section>
            <section><div><strong>工作记录</strong><p>查看更完整的任务执行历史和异常状态。</p></div><button data-action="openWorkSessions">打开工作记录</button></section>
            <section><div><strong>诊断导出</strong><p>导出不含聊天全文、文件内容、登录态或凭据的机器状态，用于升级、迁移和故障排查。</p></div><button data-action="exportDiagnostics">导出诊断</button></section>
            <section><div><strong>项目恢复</strong><p>从 Nimora 备份恢复项目。只允许恢复到空白环境，不覆盖已有项目。</p></div><button data-action="restoreProjectBackup">恢复备份</button></section>
            <section><div><strong>高级运行状态</strong><p>查看 Runtime、连接与其他开发诊断信息。</p></div><button data-action="runtimeStatus">运行状态</button></section>
          </div>`
          : projectMain;

  const main = `${systemBanner}${unknownBanner}${view === "work" ? projectMain : globalMain}`;

  return `<!DOCTYPE html>
  <html lang="zh-CN"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root{color-scheme:light dark;--bg:var(--vscode-editor-background);--fg:var(--vscode-editor-foreground);--muted:var(--vscode-descriptionForeground);--border:var(--vscode-panel-border);--card:var(--vscode-sideBar-background);--accent:var(--vscode-button-background);--accentFg:var(--vscode-button-foreground);--hover:var(--vscode-list-hoverBackground);--warn:var(--vscode-editorWarning-foreground)}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.5 var(--vscode-font-family);min-width:0}.app{display:grid;grid-template-columns:118px 250px minmax(0,1fr);min-height:100vh}.rail{border-right:1px solid var(--border);background:color-mix(in srgb,var(--card) 78%,var(--bg));padding:12px 10px;display:flex;flex-direction:column;align-items:stretch;gap:7px}.rail-brand{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:var(--accent);color:var(--accentFg);font-weight:800;font-size:17px;margin:0 auto 12px}.rail-button{width:100%;height:38px;padding:0 10px;display:flex;align-items:center;justify-content:flex-start;gap:8px;background:transparent;border:none;color:var(--muted);font-weight:650}.rail-button:hover,.rail-button.active{background:var(--hover);color:var(--fg)}.rail-glyph{width:20px;text-align:center}.rail-section{margin:10px 8px 2px;color:var(--muted);font-size:9px;letter-spacing:1.3px;text-transform:uppercase}.rail-spacer{flex:1}.context-sidebar{border-right:1px solid var(--border);background:var(--card);padding:20px 12px;display:flex;flex-direction:column;gap:16px;min-width:0}.brand{display:flex;align-items:center;justify-content:space-between;padding:0 8px}.brand strong{font-size:19px;letter-spacing:-.4px}.brand span{color:var(--muted);font-size:10px}.project-list{display:flex;flex-direction:column;gap:5px;overflow:auto}.project-card{width:100%;text-align:left;background:transparent;border:1px solid transparent;color:inherit;border-radius:8px;padding:9px;cursor:pointer}.project-card:hover{background:var(--hover)}.project-card.selected{border-color:var(--vscode-focusBorder);background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}.project-main,.project-meta{display:flex;flex-direction:column;gap:2px}.project-main span,.project-meta{font-size:11px;opacity:.75}.project-main span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.project-meta{margin-top:6px;gap:4px}.badge,.status-chip{display:inline-flex;width:max-content;border-radius:999px;padding:2px 7px;font-size:10px;background:color-mix(in srgb,var(--accent) 15%,transparent)}.badge.attention,.status-chip.attention{color:var(--warn);background:color-mix(in srgb,var(--warn) 12%,transparent)}.status-chip.active{color:var(--vscode-testing-iconPassed)}.status-chip.done{color:var(--muted)}.aside-actions{margin-top:auto;display:grid;gap:6px}.aside-advanced{margin-top:4px}.aside-advanced>summary{cursor:pointer;color:var(--muted);padding:6px 3px}.aside-advanced-actions{display:grid;gap:6px;margin-top:7px}
    .app.global-view{grid-template-columns:118px minmax(0,1fr)}
    main{padding:32px clamp(26px,4vw,62px);overflow:hidden}.hero,.page-head{display:flex;justify-content:space-between;gap:30px;align-items:flex-start}.eyebrow{font-size:10px;letter-spacing:1.8px;color:var(--muted);font-weight:700}.hero h1,.page-head h1{font-size:30px;line-height:1.1;margin:6px 0 9px;letter-spacing:-.8px}.hero p,.page-head p{font-size:14px;color:var(--muted);max-width:780px;margin:0}.hero-actions{display:flex;gap:8px}
    button{font:inherit;border:1px solid var(--vscode-button-border,transparent);border-radius:6px;padding:7px 11px;background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);cursor:pointer}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button.primary{background:var(--accent);color:var(--accentFg)}button.primary:hover{background:var(--vscode-button-hoverBackground)}button.link{background:transparent;border:none;padding:0;color:var(--vscode-textLink-foreground)}
    .metric-grid{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:10px;margin:26px 0}.metric-grid>div{border:1px solid var(--border);background:var(--card);border-radius:10px;padding:15px}.metric-grid strong{display:block;font-size:24px}.metric-grid span{color:var(--muted);font-size:11px}.metric-grid.compact{margin:14px 0 0}.attention-card strong{color:var(--warn)}
    .nimora-loop{border:1px solid var(--border);border-radius:12px;background:linear-gradient(135deg,color-mix(in srgb,var(--card) 92%,var(--accent)),var(--card));padding:18px;margin:16px 0}.loop-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.loop-head h2{font-size:20px;margin:3px 0 4px}.loop-head p{margin:0;color:var(--muted);max-width:780px}.loop-track{display:grid;grid-template-columns:minmax(160px,1fr) auto minmax(160px,1fr) auto minmax(160px,1fr) minmax(130px,.7fr);gap:10px;align-items:stretch;margin-top:16px}.loop-step{display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;align-items:center;border:1px solid var(--border);border-radius:10px;padding:12px;background:color-mix(in srgb,var(--bg) 35%,transparent)}.loop-step.current{border-color:var(--vscode-focusBorder);box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--vscode-focusBorder) 35%,transparent)}.loop-step div{display:flex;flex-direction:column;min-width:0}.loop-step small{color:var(--muted);font-size:10px}.loop-mark{display:grid;place-items:center;width:32px;height:32px;border-radius:9px;font-weight:800;background:color-mix(in srgb,var(--accent) 16%,transparent)}.loop-step.practice .loop-mark{background:color-mix(in srgb,var(--vscode-testing-iconPassed) 14%,transparent)}.loop-step.evidence .loop-mark{background:color-mix(in srgb,var(--vscode-editorInfo-foreground) 15%,transparent)}.loop-arrow{display:grid;place-items:center;color:var(--muted);font-size:17px}.loop-return{display:flex;align-items:center;justify-content:center;flex-direction:column;color:var(--vscode-textLink-foreground);text-align:center}.loop-return>span{font-size:22px;font-weight:800}.loop-return small{font-size:10px;color:var(--muted)}.loop-governance{display:grid;grid-template-columns:34px minmax(0,1fr);gap:10px;align-items:center;border-top:1px dashed var(--border);margin-top:13px;padding-top:13px}.loop-governance .loop-mark{background:color-mix(in srgb,var(--warn) 12%,transparent)}.loop-governance div{display:flex;flex-direction:column}.loop-governance small{color:var(--muted)}.loop-coordination{border-top:1px solid var(--border);padding-top:10px}
    .two-col{display:grid;grid-template-columns:minmax(420px,1.2fr) minmax(300px,.8fr);gap:16px}.two-col.lower{margin-top:16px;grid-template-columns:1fr 1fr}.two-col section,.focus-card,.attention-panel,.governance-panel,.single-panel,.workflow-panel,.project-manager-list-panel,.project-overview-panel{border:1px solid var(--border);border-radius:11px;background:var(--card);padding:17px;min-width:0}.section-title,.focus-head{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}.section-title h2,.focus-card h2,.section-title h3{font-size:16px;margin:0}.section-title h3{font-size:13px}.section-title p{margin:2px 0 0;color:var(--muted);font-size:11px}.focus-card{margin:0 0 16px}.focus-card p{margin:4px 0 0;color:var(--muted)}.muted{color:var(--muted)}.attention-panel,.governance-panel,.workflow-panel{margin:0 0 16px}.attention-count{display:grid;place-items:center;min-width:26px;height:26px;border-radius:999px;background:var(--hover);font-weight:700}.attention-count.has{color:var(--warn);background:color-mix(in srgb,var(--warn) 12%,transparent)}
    .mission-row{display:grid;grid-template-columns:32px minmax(0,1fr) auto;gap:10px;align-items:center;width:100%;text-align:left;border:none;border-top:1px solid var(--border);border-radius:0;background:transparent;color:inherit;padding:11px 3px}.mission-row:first-of-type{border-top:none}.mission-row:hover,.mission-row.selected{background:var(--hover)}.mission-role{display:grid;place-items:center;width:28px;height:28px;border-radius:8px;background:color-mix(in srgb,var(--accent) 15%,transparent);font-weight:700}.mission-copy{display:flex;min-width:0;flex-direction:column}.mission-copy strong{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.mission-copy span,.mission-counts{font-size:11px;color:var(--muted)}
    .mission-role.practice{background:color-mix(in srgb,var(--vscode-testing-iconPassed) 14%,transparent)}.mission-role.coordination{background:var(--hover);color:var(--muted)}
    .activity-row{display:grid;grid-template-columns:10px minmax(0,1fr);gap:10px;padding:10px 0;border-top:1px solid var(--border)}.activity-row:first-of-type{border-top:none}.activity-row.global{padding:13px 0}.activity-dot{width:7px;height:7px;border-radius:50%;background:var(--accent);margin-top:6px}.activity-dot.success{background:var(--vscode-testing-iconPassed)}.activity-dot.attention{background:var(--warn)}.activity-dot.unknown{background:var(--vscode-editorInfo-foreground)}.activity-row p{margin:2px 0;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.time{font-size:10px;color:var(--muted)}.empty{max-width:600px;margin:18vh auto;text-align:center}.subtle{color:var(--muted);padding:16px 0}.footer{color:var(--muted);font-size:10px;padding:0 8px}.attention-row{display:grid;grid-template-columns:28px 1fr;gap:10px;width:100%;text-align:left;background:transparent;border:0;border-top:1px solid var(--border);border-radius:0;color:inherit;padding:11px 2px}.attention-row:first-of-type{border-top:none}.attention-row:hover{background:var(--hover)}.attention-mark{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;background:color-mix(in srgb,var(--warn) 15%,transparent);color:var(--warn);font-weight:800}.attention-copy{display:flex;flex-direction:column;gap:2px}.attention-copy span,.attention-copy small{color:var(--muted)}.attention-clear,.empty-state{display:flex;flex-direction:column;gap:3px;padding:16px 2px;color:var(--muted)}.attention-clear strong,.empty-state strong{color:var(--fg)}.mission-detail-grid{display:grid;grid-template-columns:minmax(0,1fr) 260px;gap:14px}.worker-card{border:1px solid var(--border);border-radius:9px;padding:13px}.worker-card>div:first-child{display:flex;align-items:center;gap:10px}.worker-card .label{display:block;color:var(--muted);font-size:10px}.worker-card p{font-size:11px}.worker-avatar{display:grid;place-items:center;width:32px;height:32px;border-radius:9px;background:color-mix(in srgb,var(--accent) 16%,transparent);font-weight:700}.worker-avatar.large{width:38px;height:38px}.mini-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.mini-stats>div{border:1px solid var(--border);border-radius:9px;padding:12px}.mini-stats strong{display:block;font-size:18px}.mini-stats span{font-size:10px;color:var(--muted)}.mission-deep-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px}.mission-subpanel{border:1px solid var(--border);border-radius:9px;padding:13px;min-width:0}.execution-row{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:9px;align-items:center;padding:9px 0;border-top:1px solid var(--border)}.execution-row:first-of-type{border-top:none}.execution-state{display:grid;place-items:center;width:22px;height:22px;border-radius:999px;background:var(--hover);font-weight:800}.execution-row.succeeded .execution-state{color:var(--vscode-testing-iconPassed)}.execution-row.failed .execution-state{color:var(--warn)}.execution-row.unknown .execution-state{color:var(--vscode-editorInfo-foreground)}.execution-copy{display:flex;flex-direction:column;min-width:0}.execution-copy span,.execution-copy small{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.problem-card{border-top:1px solid var(--border);padding:10px 0}.problem-card:first-of-type{border-top:none}.problem-card.blocking{border-left:2px solid var(--warn);padding-left:10px}.problem-head{display:flex;justify-content:space-between;align-items:center;gap:10px}.problem-card>p,.problem-answer p{margin:5px 0;color:var(--fg)}.problem-answer,.evidence-list{margin-top:8px;display:flex;flex-direction:column;gap:3px}.problem-answer>span,.evidence-list>span{font-size:10px;text-transform:uppercase;color:var(--muted)}.evidence-list small{color:var(--muted)}.collaboration-row{display:grid;grid-template-columns:72px minmax(0,1fr);gap:9px;padding:9px 0;border-top:1px solid var(--border)}.collaboration-row:first-of-type{border-top:none}.collaboration-kind{font-size:10px;color:var(--muted);text-transform:uppercase}.collaboration-row p{margin:2px 0;color:var(--muted)}
    .resource-row{display:grid;grid-template-columns:28px 1fr;gap:8px;align-items:center;width:100%;text-align:left;border:none;border-top:1px solid var(--border);border-radius:0;background:transparent;color:inherit;padding:10px 2px}.resource-row:first-of-type{border-top:none}.resource-row[data-uri]:hover{background:var(--hover)}.resource-icon{display:grid;place-items:center;width:24px;height:24px;border-radius:7px;background:color-mix(in srgb,var(--accent) 14%,transparent)}.resource-row span:last-child{display:flex;flex-direction:column;min-width:0}.resource-row small{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.decision-row{padding:10px 2px;border-top:1px solid var(--border)}.decision-row:first-of-type{border-top:none}.decision-row p{margin:3px 0;color:var(--muted)}.governance-card{border:1px solid var(--border);border-radius:9px;padding:13px;margin-top:9px;background:color-mix(in srgb,var(--bg) 55%,transparent)}.governance-card:first-of-type{margin-top:0}.governance-card.awaiting-human{border-color:color-mix(in srgb,var(--warn) 45%,var(--border))}.governance-top{display:flex;justify-content:space-between;gap:16px;align-items:flex-start}.governance-top h3{font-size:14px;margin:6px 0 0}.governance-card p{color:var(--muted);margin:8px 0}.governance-meta{font-size:11px;color:var(--muted)}.governance-actions{margin-top:12px;display:flex;justify-content:flex-end}.worker-row{display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:11px;align-items:center;width:100%;text-align:left;border:0;border-top:1px solid var(--border);border-radius:0;background:transparent;color:inherit;padding:12px 2px}.worker-row:first-of-type{border-top:none}.worker-row:hover{background:var(--hover)}.worker-copy{display:flex;flex-direction:column;min-width:0}.worker-copy span,.worker-copy small{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.connection-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:24px}.connection-card{border:1px solid var(--border);background:var(--card);border-radius:12px;padding:17px;display:flex;flex-direction:column;gap:12px}.connection-card p,.settings-list p{color:var(--muted);margin:4px 0 0}.connection-icon{display:grid;place-items:center;width:38px;height:38px;border-radius:10px;background:color-mix(in srgb,var(--accent) 16%,transparent);font-weight:800}.settings-list{display:grid;gap:10px;margin-top:24px}.settings-list section{border:1px solid var(--border);background:var(--card);border-radius:10px;padding:15px;display:flex;justify-content:space-between;align-items:center;gap:20px}.single-panel{margin-top:24px}.timeline-panel{max-width:900px}.empty{max-width:600px;margin:18vh auto;text-align:center}.subtle{color:var(--muted);padding:16px 0}.footer{color:var(--muted);font-size:10px;padding:0 8px}
    .project-progress-panel,.mission-graph-panel{border:1px solid var(--border);border-radius:11px;background:var(--card);padding:17px;margin:0 0 16px}.progress-head{display:flex;justify-content:space-between;align-items:flex-end;gap:16px}.progress-head h2{font-size:16px;margin:4px 0 0}.progress-head>strong{font-size:24px}.progress-track{appearance:none;-webkit-appearance:none;width:100%;height:8px;border:0;border-radius:999px;overflow:hidden;margin:12px 0 9px;background:transparent}.progress-track::-webkit-progress-bar{background:color-mix(in srgb,var(--fg) 9%,transparent);border-radius:999px}.progress-track::-webkit-progress-value{background:var(--vscode-testing-iconPassed);border-radius:999px}.progress-breakdown{display:flex;gap:14px;flex-wrap:wrap;color:var(--muted);font-size:11px}.warn-text{color:var(--warn)}.path-summary{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px}.path-summary>div{border:1px solid var(--border);border-radius:9px;padding:11px}.path-label{display:block;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-bottom:7px}.path-chips{display:flex;flex-wrap:wrap;gap:6px}.path-chip{padding:4px 8px;border-radius:999px;background:var(--hover);color:var(--fg);border:1px solid transparent;font-size:11px}.path-chip.active{border-color:color-mix(in srgb,var(--vscode-testing-iconPassed) 35%,transparent)}.path-chip.waiting{border-color:color-mix(in srgb,var(--warn) 38%,transparent)}.graph-stage{display:flex;gap:12px;overflow:auto;padding:3px 0 14px}.graph-lane{min-width:220px;flex:1}.graph-lane-title{font-size:9px;letter-spacing:1px;color:var(--muted);margin:0 0 7px 2px}.graph-lane-nodes{display:flex;flex-direction:column;gap:8px}.graph-node{display:flex;flex-direction:column;gap:5px;text-align:left;background:color-mix(in srgb,var(--bg) 48%,transparent);color:var(--fg);border:1px solid var(--border);border-radius:9px;padding:10px;min-height:92px}.graph-node:hover,.graph-node.selected{border-color:var(--vscode-focusBorder);background:var(--hover)}.graph-node.attention{border-left:3px solid var(--warn)}.graph-node.waiting{border-left:3px solid var(--vscode-editorInfo-foreground)}.graph-node.completed{opacity:.72}.graph-node.cancelled{opacity:.58}.graph-node-top{display:flex;justify-content:space-between;align-items:center;gap:8px}.graph-node>strong{font-size:12px}.graph-node>span:not(.graph-node-top),.graph-node>small{color:var(--muted);font-size:10px}.graph-problem{color:var(--warn)!important}.graph-relations{border-top:1px solid var(--border);padding-top:12px}.graph-relations-title{font-size:10px;color:var(--muted);letter-spacing:.8px;text-transform:uppercase;margin-bottom:5px}.graph-relation{display:grid;grid-template-columns:minmax(0,1fr) auto 18px minmax(0,1fr);align-items:center;gap:7px;padding:6px 0}.graph-relation button{background:transparent;border:none;text-align:left;padding:3px 0;color:var(--vscode-textLink-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.relation-label{border:1px solid var(--border);border-radius:999px;padding:2px 7px;font-size:10px;color:var(--muted)}.graph-relation.attention .relation-label{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 40%,var(--border))}.graph-relation.validation .relation-label{color:var(--vscode-testing-iconPassed)}.relation-arrow{color:var(--muted);text-align:center}
    .project-management-grid{display:grid;grid-template-columns:minmax(360px,.85fr) minmax(460px,1.15fr);gap:16px;margin-top:22px}.project-manager-list{display:flex;flex-direction:column;gap:8px}.project-management-card{display:grid;grid-template-columns:42px minmax(0,1fr) auto;gap:11px;align-items:center;width:100%;text-align:left;color:inherit;background:color-mix(in srgb,var(--bg) 45%,transparent);border:1px solid var(--border);border-radius:10px;padding:12px}.project-management-card:hover,.project-management-card.selected{border-color:var(--vscode-focusBorder);background:var(--hover)}.project-management-icon{display:grid;place-items:center;width:38px;height:38px;border-radius:10px;background:color-mix(in srgb,var(--accent) 16%,transparent);font-weight:800}.project-management-icon.large{width:48px;height:48px;font-size:17px}.project-management-copy,.project-management-status{display:flex;flex-direction:column;min-width:0}.project-management-copy span,.project-management-copy small,.project-management-status small{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.project-management-status{align-items:flex-end;gap:6px}.project-overview-head{display:grid;grid-template-columns:48px minmax(0,1fr) auto;gap:13px;align-items:start}.project-overview-head h2{font-size:22px;margin:2px 0 4px}.project-overview-head p{margin:0;color:var(--muted)}.project-overview-actions{display:flex;gap:8px;margin:18px 0}.project-overview-detail{display:grid;gap:10px}.project-overview-detail>div{border:1px solid var(--border);border-radius:9px;padding:12px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px;align-items:center}.project-overview-detail>div>span{grid-column:1/-1;color:var(--muted);font-size:10px}.project-overview-detail>div>strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.project-overview-detail .progress-track{grid-column:1/-1;width:100%;margin:3px 0}.project-overview-detail small{grid-column:1/-1;color:var(--muted)}.project-overview-activity{margin-top:18px;border-top:1px solid var(--border);padding-top:15px}.project-danger-zone{display:flex;justify-content:space-between;align-items:center;gap:18px;border-top:1px solid var(--border);margin-top:18px;padding-top:15px}.project-danger-zone p{margin:3px 0 0;color:var(--muted);font-size:11px}.archived-projects{margin-top:16px}.archived-project-row{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:9px 0;border-top:1px solid var(--border)}.archived-project-row div{display:flex;flex-direction:column;min-width:0}.archived-project-row small{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .skip-link{position:fixed;left:10px;top:8px;z-index:99;transform:translateY(-140%);background:var(--accent);color:var(--accentFg);padding:7px 10px;border-radius:6px;text-decoration:none}.skip-link:focus{transform:none}button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--vscode-focusBorder);outline-offset:2px}.sidebar-empty{padding:8px;color:var(--muted);font-size:11px}.sidebar-empty.warning{color:var(--warn)}.system-banner,.unknown-banner,.source-banner,.canonical-health-panel{border:1px solid var(--border);border-radius:10px;background:var(--card);padding:13px 15px;margin:0 0 16px}.system-banner.degraded,.source-banner{border-left:3px solid var(--vscode-editorInfo-foreground)}.system-banner.unavailable,.unknown-banner{border-left:3px solid var(--warn)}.system-banner p,.source-banner p{margin:3px 0;color:var(--muted)}.system-banner>button{margin-top:10px}.unknown-banner{display:flex;flex-direction:column;gap:2px}.unknown-banner span,.source-banner span{color:var(--muted);font-size:11px}.owner-health-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:7px;margin-top:10px}.owner-health-grid.wide{margin-top:0}.owner-health{display:grid;grid-template-columns:8px minmax(0,1fr);gap:7px;align-items:start;padding:8px;border:1px solid var(--border);border-radius:8px}.owner-dot{width:7px;height:7px;border-radius:50%;background:var(--vscode-testing-iconPassed);margin-top:5px}.owner-health.unavailable .owner-dot{background:var(--warn)}.owner-health span:last-child{display:flex;flex-direction:column;min-width:0}.owner-health small{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.system-banner details{margin-top:9px}.system-banner ul{margin:7px 0 0;padding-left:18px;color:var(--muted)}.empty-product-state{max-width:650px;margin:13vh auto;text-align:center;padding:28px}.empty-product-state p{color:var(--muted);font-size:14px}.empty-mark{display:grid;place-items:center;width:48px;height:48px;border-radius:14px;background:var(--accent);color:var(--accentFg);font-weight:800;font-size:18px;margin:0 auto 14px}.empty-product-state.unavailable .empty-mark{background:color-mix(in srgb,var(--warn) 18%,var(--card));color:var(--warn)}.empty-product-state .owner-health-grid{text-align:left;margin:18px 0}.canonical-health-panel{margin-top:22px}.footer{display:flex;flex-direction:column;gap:2px}.reconstruction-state{font-size:9px}.reconstruction-state.partial{color:var(--warn)}
    button:disabled{opacity:.5;cursor:not-allowed}.focus-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.worker-row.static{cursor:default}.worker-row.durable-only{border-left:2px solid var(--warn)}.provider-panel,.setup-panel{border:1px solid var(--border);border-radius:11px;background:var(--card);padding:17px;margin:0 0 16px}.provider-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.provider-card{border:1px solid var(--border);border-radius:9px;padding:12px;background:color-mix(in srgb,var(--bg) 45%,transparent)}.provider-card.attention{border-left:3px solid var(--warn)}.provider-card-head{display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:10px;align-items:center}.provider-card p{margin:2px 0;color:var(--muted);font-size:11px}.provider-card>small{display:block;margin-top:8px;color:var(--muted)}.advanced{margin-top:12px;color:var(--muted)}.advanced p{font-size:11px;word-break:break-word}.setup-panel{max-width:720px;text-align:left;margin:20px auto}.settings-setup{max-width:none;margin:24px 0 16px}.setup-check{display:grid;grid-template-columns:24px minmax(0,1fr);gap:9px;align-items:start;padding:9px 0;border-top:1px solid var(--border)}.setup-check:first-of-type{border-top:none}.setup-check>span{display:grid;place-items:center;width:22px;height:22px;border-radius:999px;background:var(--hover);font-weight:800}.setup-check.ready>span{color:var(--vscode-testing-iconPassed)}.setup-check.pending>span{color:var(--warn)}.setup-check div{display:flex;flex-direction:column}.setup-check small{color:var(--muted)}.setup-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:12px}.project-filter{width:100%;margin:0 0 7px;border:1px solid var(--border);border-radius:6px;padding:7px 8px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);font:inherit}.project-filter:focus{outline:2px solid var(--vscode-focusBorder);outline-offset:1px}.project-filter::placeholder{color:var(--vscode-input-placeholderForeground)}.completion-banner{display:flex;justify-content:space-between;align-items:center;gap:18px;border:1px solid color-mix(in srgb,var(--vscode-testing-iconPassed) 45%,var(--border));border-radius:11px;background:color-mix(in srgb,var(--vscode-testing-iconPassed) 7%,var(--card));padding:14px 16px;margin:0 0 16px}.completion-banner>div{display:flex;align-items:center;gap:11px}.completion-banner p{margin:2px 0 0;color:var(--muted)}.completion-mark{display:grid;place-items:center;width:30px;height:30px;border-radius:999px;background:color-mix(in srgb,var(--vscode-testing-iconPassed) 16%,transparent);color:var(--vscode-testing-iconPassed);font-weight:800}
    .now-card{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center;border:1px solid var(--border);border-radius:12px;background:var(--card);padding:18px;margin:22px 0 16px}.now-card h2{margin:3px 0 5px;font-size:20px}.now-card p{margin:0;color:var(--muted);max-width:820px}.now-card.needs-human{border-color:color-mix(in srgb,var(--warn) 48%,var(--border))}.now-card.completed{border-color:color-mix(in srgb,var(--vscode-testing-iconPassed) 48%,var(--border))}.now-actions{display:flex;gap:8px}.project-advanced{margin:0 0 16px}.project-advanced .hero-actions{margin-top:10px;flex-wrap:wrap}
    .diagnostic-list{display:grid;gap:2px;margin:8px 0 12px}.diagnostic-row{display:flex;justify-content:space-between;gap:12px;border-top:1px solid var(--border);padding:7px 0}.diagnostic-row:first-child{border-top:none}.diagnostic-row span{color:var(--muted)}
    .mission-purpose-card{border:1px solid var(--border);border-radius:9px;padding:13px;display:grid;grid-template-columns:40px minmax(0,1fr);gap:11px;align-items:start;background:color-mix(in srgb,var(--bg) 35%,transparent)}.mission-purpose-card.practice{border-left:3px solid var(--vscode-testing-iconPassed)}.mission-purpose-card.cognition{border-left:3px solid var(--vscode-focusBorder)}.mission-purpose-card.coordination{border-left:3px solid var(--muted)}.mission-purpose-card>div{display:flex;flex-direction:column;min-width:0}.mission-purpose-card .label{font-size:10px;color:var(--muted)}.mission-purpose-card p{font-size:11px}.mission-resource-detail{border-top:1px solid var(--border);padding-top:10px}.mission-resource-body{display:flex;align-items:center;justify-content:space-between;gap:14px}.mission-resource-body p{margin:0}.resource-principle{display:grid;grid-template-columns:44px minmax(0,1fr);gap:13px;align-items:start;border:1px solid var(--border);border-radius:12px;background:var(--card);padding:16px;margin:22px 0 16px}.resource-principle-mark{display:grid;place-items:center;width:42px;height:42px;border-radius:12px;background:var(--accent);color:var(--accentFg);font-size:16px;font-weight:800}.resource-principle strong{font-size:15px}.resource-principle p{margin:3px 0 0;color:var(--muted)}
    .action-feedback{position:fixed;right:18px;bottom:18px;z-index:10;max-width:340px;padding:9px 12px;border:1px solid var(--border);border-radius:8px;background:var(--card);box-shadow:0 8px 28px color-mix(in srgb,#000 28%,transparent);opacity:0;transform:translateY(6px);pointer-events:none;transition:opacity .15s ease,transform .15s ease;color:var(--fg)}.action-feedback.visible{opacity:1;transform:translateY(0)}[data-pending="true"]{pointer-events:none;opacity:.72;cursor:progress}.sr-only{position:absolute!important;width:1px!important;height:1px!important;padding:0!important;margin:-1px!important;overflow:hidden!important;clip:rect(0,0,0,0)!important;white-space:nowrap!important;border:0!important}
    /* Product layout: intentionally follows the Nimora desktop mock rather than a VS Code admin dashboard. */
    .app{grid-template-columns:194px minmax(0,1fr);background:radial-gradient(circle at 72% -10%,color-mix(in srgb,var(--accent) 7%,transparent),transparent 34%),var(--bg)}
    .app.global-view{grid-template-columns:194px minmax(0,1fr)}
    .context-sidebar{display:none!important}
    .rail{padding:18px 12px 14px;background:color-mix(in srgb,var(--card) 92%,#07101e);gap:6px}
    .rail-brand{display:flex;width:auto;height:auto;justify-content:flex-start;gap:10px;margin:0 5px 16px;padding:0;background:transparent;color:var(--fg);font-size:18px}
    .rail-logo{display:grid;place-items:center;width:31px;height:31px;border-radius:9px;background:linear-gradient(135deg,#1777ff,#3d98ff);color:#fff;font-weight:900;font-style:italic}
    .rail-brand strong{font-size:18px;letter-spacing:-.35px}
    .rail-button{height:42px;padding:0 12px;border-radius:7px;color:color-mix(in srgb,var(--fg) 74%,var(--muted));font-weight:600}
    .rail-button:hover{background:color-mix(in srgb,var(--hover) 78%,transparent);color:var(--fg)}
    .rail-button.active{background:linear-gradient(135deg,#1877f2,#2d83ff);color:#fff;box-shadow:0 8px 22px color-mix(in srgb,#1674ff 25%,transparent)}
    .rail-button.compact{height:35px;font-size:12px}
    .rail-glyph{width:24px;font-size:15px}
    .rail-divider{height:1px;background:var(--border);margin:9px 4px}
    .rail-advanced{margin:0 2px}.rail-advanced>summary{display:flex;justify-content:space-between;align-items:center;padding:5px 9px 8px;color:var(--muted);cursor:pointer;list-style:none;font-size:11px}.rail-advanced>summary::-webkit-details-marker{display:none}.rail-advanced-list{display:grid;gap:2px}
    .rail-health{display:flex;align-items:center;gap:7px;padding:8px 7px 0;color:var(--muted);font-size:10px}.health-dot,.state-dot,.live-dot{width:8px;height:8px;border-radius:50%;background:#24d17e;box-shadow:0 0 12px color-mix(in srgb,#24d17e 65%,transparent)}
    main{padding:0;min-width:0;overflow-x:hidden;overflow-y:auto}
    .work-page{padding:16px 16px 30px;width:100%;max-width:1680px;min-width:0;margin:0 auto}
    .work-breadcrumb{display:flex;align-items:center;gap:8px;height:30px;color:var(--muted);font-size:11px}.work-breadcrumb button{border:0;background:transparent;padding:0;color:var(--muted)}.work-breadcrumb strong{color:var(--fg);font-weight:550}
    .work-titlebar{display:flex;align-items:center;justify-content:space-between;gap:20px;padding:12px 0 16px}
    .work-project-identity{display:flex;align-items:center;gap:13px;min-width:0}.work-project-icon{display:grid;place-items:center;width:48px;height:48px;border:1px solid var(--border);border-radius:11px;background:linear-gradient(145deg,color-mix(in srgb,#3f8cff 24%,var(--card)),var(--card));font-size:20px}.work-project-identity h1{margin:0 0 3px;font-size:25px;line-height:1.1;letter-spacing:-.5px}.work-project-identity p{margin:0;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:760px}
    .work-title-actions{display:flex;align-items:center;gap:8px}.work-title-actions .primary{min-width:150px;padding-inline:18px}
    .work-layout-grid{display:block;width:100%;min-width:0}
    .work-main-column{min-width:0}
    .work-status-overview{display:grid;grid-template-columns:.95fr 1.45fr .9fr;border:1px solid var(--border);border-radius:11px;background:color-mix(in srgb,var(--card) 88%,transparent);overflow:hidden;box-shadow:0 12px 32px color-mix(in srgb,#000 12%,transparent)}
    .status-overview-cell{padding:15px 20px;min-width:0;border-left:1px solid var(--border)}.status-overview-cell:first-child{border-left:none}.status-overview-cell>span{display:block;color:var(--muted);font-size:11px;margin-bottom:7px}.status-overview-cell>strong{display:flex;align-items:center;gap:8px;font-size:16px}.status-overview-cell.state>strong{color:#24d17e}.status-overview-cell small{display:block;margin-top:4px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .status-overview-cell.state.needs-human>strong{color:var(--warn)}.status-overview-cell.state.needs-human .state-dot{background:var(--warn);box-shadow:0 0 12px color-mix(in srgb,var(--warn) 55%,transparent)}.status-overview-cell.state.waiting-external>strong{color:var(--vscode-editorInfo-foreground)}.status-overview-cell.state.waiting-external .state-dot{background:var(--vscode-editorInfo-foreground);box-shadow:0 0 12px color-mix(in srgb,var(--vscode-editorInfo-foreground) 55%,transparent)}.status-overview-cell.state.completed>strong{color:var(--muted)}.status-overview-cell.state.completed .state-dot{background:var(--muted);box-shadow:none}
    .status-progress-line{display:grid;grid-template-columns:minmax(100px,1fr) auto;gap:12px;align-items:center}.status-progress-line .progress-track{margin:0;height:9px}.status-progress-line>strong{font-size:18px}
    .work-tabs{display:flex;gap:7px;padding:14px 0 12px;overflow:auto}.work-tabs button{border:1px solid var(--border);border-radius:999px;padding:7px 18px;background:color-mix(in srgb,var(--card) 88%,transparent);white-space:nowrap}.work-tabs button.active{border-color:#2783ff;background:#237cff;color:#fff}
    .work-core-grid{display:grid;grid-template-columns:minmax(0,1.04fr) minmax(0,.96fr) clamp(220px,22vw,280px);gap:12px;align-items:stretch;min-width:0}
    .mock-panel,.live-execution-card,.work-resource-side,.work-secondary-section{border:1px solid var(--border);border-radius:11px;background:color-mix(in srgb,var(--card) 91%,transparent);box-shadow:0 10px 28px color-mix(in srgb,#000 10%,transparent)}
    .mock-panel{padding:15px 14px;margin:0;border-color:color-mix(in srgb,#2684ff 72%,var(--border));min-width:0}
    .panel-head,.work-resource-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.panel-head.compact{align-items:center}.panel-head h2,.work-resource-head h2{margin:2px 0 0;font-size:18px}
    .workflow-timeline{position:relative;margin-top:8px;padding-left:4px}.workflow-timeline:before{content:"";position:absolute;left:18px;top:22px;bottom:22px;width:1px;background:color-mix(in srgb,var(--muted) 32%,transparent)}
    .workflow-timeline .mission-row{position:relative;grid-template-columns:34px minmax(0,1fr) auto;border:0;border-radius:8px;padding:10px 9px;margin:2px 0;background:transparent;z-index:1}.workflow-timeline .mission-row:hover{background:var(--hover)}.workflow-timeline .mission-row.selected{background:linear-gradient(90deg,color-mix(in srgb,#237cff 24%,transparent),color-mix(in srgb,#237cff 7%,transparent));outline:1px solid color-mix(in srgb,#237cff 44%,transparent)}.workflow-timeline .mission-role{border:1px solid color-mix(in srgb,#79aaff 38%,var(--border));background:var(--card);z-index:2}
    .live-execution-card{padding:15px;border-color:color-mix(in srgb,#b460ff 58%,var(--border));min-width:0;overflow:hidden}.live-dot-label{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:11px}.execution-agent-line{display:flex;gap:10px;align-items:center;margin:12px 0 9px;padding:10px;border-radius:8px;background:color-mix(in srgb,var(--bg) 40%,transparent)}.execution-avatar{display:grid;place-items:center;width:34px;height:34px;border-radius:9px;background:linear-gradient(135deg,#276dff,#744cff);font-weight:800;color:#fff}.execution-agent-line>div{display:flex;flex-direction:column;min-width:0}.execution-agent-line small{color:var(--muted)}.execution-message{padding:2px 3px 12px;min-width:0}.execution-message strong,.execution-message p{overflow-wrap:anywhere}.execution-message p{margin:4px 0 0;color:var(--muted)}.execution-ops{border:1px solid var(--border);border-radius:8px;padding:10px;background:color-mix(in srgb,var(--bg) 30%,transparent)}.execution-ops-title{font-size:11px;font-weight:700;margin-bottom:5px}.execution-op-row{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:8px;align-items:center;padding:6px 0;border-top:1px solid color-mix(in srgb,var(--border) 65%,transparent)}.execution-op-row:first-of-type{border-top:0}.execution-op-row>span:nth-child(2){display:flex;flex-direction:column;min-width:0}.execution-op-row small,.execution-op-row time{color:var(--muted);font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.execution-footer{display:flex;justify-content:flex-end;gap:7px;margin-top:10px}
    .work-resource-side{padding:14px;border-color:color-mix(in srgb,#f0c85b 58%,var(--border));min-width:0;max-width:100%;overflow:hidden}.work-resource-head{align-items:center;margin-bottom:10px}.resource-role-card,.resource-policy-card{border:1px solid var(--border);border-radius:9px;padding:12px;margin-top:9px;background:color-mix(in srgb,var(--bg) 31%,transparent)}.resource-role-card{display:flex;flex-direction:column;gap:3px;min-width:0}.resource-role-label{font-size:11px;color:var(--muted)}.resource-role-card>strong{font-size:13px;overflow-wrap:anywhere}.resource-role-card small{color:#24d17e}.resource-policy-card>div{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-top:1px solid var(--border)}.resource-policy-card>div:first-child{border-top:0}.resource-policy-card span{color:var(--muted)}.resource-policy-card button,.resource-manage-button{width:100%;margin-top:9px}.resource-manage-button{background:transparent}
    .work-secondary-section{padding:15px;margin-top:12px}.work-secondary-section>.section-title{margin-bottom:8px}.selected-task-details,.project-advanced-shell{border-top:1px solid var(--border);padding-top:10px;margin-top:14px}
    .architecture-loop-details .nimora-loop{box-shadow:none;margin:12px 0;background:color-mix(in srgb,var(--bg) 32%,transparent)}
    .project-page{max-width:1540px;margin:0 auto;padding-top:12px}.project-breadcrumb{display:flex;align-items:center;gap:8px;padding:0 22px;height:28px;color:var(--muted);font-size:11px}.project-breadcrumb button{border:0;background:transparent;padding:0;color:var(--muted)}.project-breadcrumb strong{color:var(--fg)}
    .project-manager-head,.page-head{padding:12px 22px 0}.project-manager-head h1{font-size:26px;margin-bottom:5px}.project-management-grid{padding:0 22px 24px;margin-top:14px;grid-template-columns:minmax(340px,.82fr) minmax(460px,1.18fr)}.project-manager-list-panel,.project-overview-panel{border:1px solid var(--border);border-radius:11px;background:color-mix(in srgb,var(--card) 91%,transparent);padding:14px;box-shadow:0 10px 28px color-mix(in srgb,#000 10%,transparent)}.project-management-card{padding:13px;border-radius:9px}.project-management-card.selected{border-color:#2684ff;background:linear-gradient(90deg,color-mix(in srgb,#2684ff 20%,transparent),color-mix(in srgb,#2684ff 5%,transparent));box-shadow:inset 0 0 0 1px color-mix(in srgb,#2684ff 18%,transparent)}.project-overview-actions{display:grid;grid-template-columns:1fr 1fr}.project-overview-actions>button{min-height:40px}.project-enter-button{min-width:220px}.project-detail-tabs{display:flex;gap:8px;border-bottom:1px solid var(--border);margin:0 0 14px;padding:0 3px}.project-detail-tabs button{border:0;border-radius:0;background:transparent;color:var(--muted);padding:10px 12px;border-bottom:2px solid transparent}.project-detail-tabs button.active{color:#3a8bff;border-bottom-color:#3a8bff}.project-overview-detail>div{background:color-mix(in srgb,var(--bg) 26%,transparent)}button.destructive{color:#ff6b72;border-color:color-mix(in srgb,#ff5c66 35%,var(--border));background:color-mix(in srgb,#ff5c66 8%,var(--card))}button.destructive:hover{background:color-mix(in srgb,#ff5c66 14%,var(--card))}
    @media(max-width:1050px){.app,.app.global-view{grid-template-columns:164px minmax(0,1fr)}.work-core-grid,.two-col,.two-col.lower,.mission-deep-grid,.path-summary,.now-card,.project-management-grid{grid-template-columns:1fr}.work-resource-side{grid-column:auto}.hero,.page-head{flex-direction:column}.mission-detail-grid,.connection-grid,.provider-grid{grid-template-columns:1fr}.loop-track{display:flex;flex-direction:column}.loop-arrow{transform:rotate(90deg)}.loop-return{padding:5px 0}.mission-resource-body{align-items:flex-start;flex-direction:column}.work-status-overview{grid-template-columns:1fr 1.35fr}.status-overview-cell.remaining{grid-column:1/-1;border-left:0;border-top:1px solid var(--border)}}
    @media(max-width:760px){.app,.app.global-view{grid-template-columns:72px minmax(0,1fr)}.rail{padding:12px 8px}.rail-button{justify-content:center;padding:0}.rail-button>span:last-child,.rail-advanced>summary,.rail-health>span:last-child{display:none}.rail-glyph{width:auto}.rail-brand{justify-content:center;margin:0 0 12px}.rail-brand strong{display:none}.rail-logo{width:38px;height:38px}.rail-advanced-list{gap:4px}.rail-divider{margin:7px 3px}.work-page{padding:12px 12px 24px}.work-titlebar{align-items:flex-start;flex-direction:column}.work-title-actions{width:100%;flex-wrap:wrap}.work-project-identity p{white-space:normal}.work-status-overview{grid-template-columns:1fr}.status-overview-cell{border-left:0;border-top:1px solid var(--border)}.status-overview-cell:first-child{border-top:0}.work-core-grid{grid-template-columns:1fr}.project-management-grid{padding:0 12px 18px}.project-manager-head,.page-head{padding:16px 12px 0}.project-overview-head{grid-template-columns:40px minmax(0,1fr)}.project-overview-head>.status-chip{grid-column:2;justify-self:start}.project-management-card{grid-template-columns:36px minmax(0,1fr)}.project-management-status{grid-column:2;align-items:flex-start}.settings-list section,.project-danger-zone,.completion-banner{align-items:flex-start;flex-direction:column}.owner-health-grid{grid-template-columns:1fr}.graph-relation{grid-template-columns:minmax(0,1fr) auto}.graph-relation .relation-arrow{display:none}.graph-relation button:last-child{grid-column:1/-1}}
    @media(max-width:520px){.app,.app.global-view{grid-template-columns:56px minmax(0,1fr)}.rail{padding:8px 5px}.rail-logo{width:34px;height:34px;border-radius:10px}.work-page{padding:10px 9px 20px}.work-project-icon{width:40px;height:40px}.work-project-identity h1{font-size:21px}.work-title-actions>button,.project-overview-actions>button,.setup-actions>button{width:100%}.work-tabs button{padding:6px 13px}.section-title,.focus-head,.loop-head,.progress-head,.panel-head{align-items:flex-start;flex-direction:column}.mission-row{grid-template-columns:30px minmax(0,1fr)}.mission-counts{grid-column:2}.provider-card-head{grid-template-columns:34px minmax(0,1fr)}.provider-card-head>.status-chip{grid-column:2;justify-self:start}.mini-stats{grid-template-columns:1fr}.project-overview-detail>div{grid-template-columns:1fr}.project-overview-detail>div>button{justify-self:start}.action-feedback{left:64px;right:9px;bottom:9px;max-width:none}}
    .live-dot.inactive{background:var(--muted);box-shadow:none}.action-feedback{max-width:min(340px,calc(100vw - 36px))}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}
  </style></head>
  <body><a class="skip-link" href="#main-content">跳到主要内容</a><div id="action-feedback" class="action-feedback" role="status" aria-live="polite"></div><div class="app">
    <nav class="rail" aria-label="Nimora 全局导航" data-keyboard-nav="global-navigation">
      <div class="rail-brand"><span class="rail-logo">N</span><strong>Nimora</strong></div>
      <button class="rail-button ${view === "work" ? "active" : ""}" title="工作" aria-label="工作" ${view === "work" ? `aria-current="page"` : ""} data-action="selectView" data-view="work"><span class="rail-glyph">⌂</span><span>工作</span></button>
      <button class="rail-button ${view === "projects" ? "active" : ""}" title="项目" aria-label="项目" ${view === "projects" ? `aria-current="page"` : ""} data-action="selectView" data-view="projects"><span class="rail-glyph">▣</span><span>项目</span></button>
      <button class="rail-button ${view === "activity" ? "active" : ""}" title="历史" aria-label="历史" ${view === "activity" ? `aria-current="page"` : ""} data-action="selectView" data-view="activity"><span class="rail-glyph">◷</span><span>历史</span></button>
      <button class="rail-button ${view === "connections" ? "active" : ""}" title="AI 资源" aria-label="AI 资源" ${view === "connections" ? `aria-current="page"` : ""} data-action="selectView" data-view="connections"><span class="rail-glyph">AI</span><span>AI 资源</span></button>
      <button class="rail-button ${view === "settings" ? "active" : ""}" title="设置" aria-label="设置" ${view === "settings" ? `aria-current="page"` : ""} data-action="selectView" data-view="settings"><span class="rail-glyph">⚙</span><span>设置</span></button>
      <div class="rail-divider"></div>
      <details class="rail-advanced" open>
        <summary>高级 <span>⌄</span></summary>
        <div class="rail-advanced-list">
          <button class="rail-button compact" data-action="scrollSection" data-target="workflow-section"><span class="rail-glyph">☷</span><span>工作结构</span></button>
          <button class="rail-button compact" data-action="openWorkSessions"><span class="rail-glyph">⌘</span><span>执行记录</span></button>
          <button class="rail-button compact" data-action="scrollSection" data-target="artifacts-section"><span class="rail-glyph">▤</span><span>产物与证据</span></button>
          <button class="rail-button compact" data-action="workerStatus"><span class="rail-glyph">⌁</span><span>诊断</span></button>
          ${selected ? `<button class="rail-button compact" data-action="exportProjectBackup" data-project="${htmlEscape(selected.projectId)}"><span class="rail-glyph">▣</span><span>备份与恢复</span></button>` : `<button class="rail-button compact" data-action="restoreProjectBackup"><span class="rail-glyph">▣</span><span>备份与恢复</span></button>`}
        </div>
      </details>
      <div class="rail-spacer"></div>
      <div class="rail-health"><span class="health-dot"></span><span>${state.system.reconstruction === "ready" ? "系统正常" : "部分状态待核实"}</span></div>
    </nav>
    <main id="main-content" tabindex="-1">${main}</main>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const readingKey = ${JSON.stringify([view, selected?.projectId ?? "", state.selectedMissionId ?? ""]).replace(/</g, "\\u003c")}.join(':');
    const detailsElements = Array.from(document.querySelectorAll('details'));
    const savedReading = vscode.getState()?.readingPosition;
    if (savedReading?.key === readingKey) {
      detailsElements.forEach((element, index) => { element.open = savedReading.openDetails?.includes(index) === true; });
      window.requestAnimationFrame(() => {
        if (savedReading.focusedInput) document.getElementById(savedReading.focusedInput)?.focus({preventScroll:true});
        window.scrollTo(0, savedReading.scrollY || 0);
      });
    }
    const saveReadingPosition = () => vscode.setState({...vscode.getState(),readingPosition:{
      key:readingKey,scrollY:window.scrollY,
      openDetails:detailsElements.flatMap((element,index)=>element.open?[index]:[]),
      focusedInput:document.activeElement?.tagName==='INPUT'?document.activeElement.id:undefined,
    }});
    window.addEventListener('scroll',saveReadingPosition,{passive:true});
    document.addEventListener('toggle',saveReadingPosition,true);
    document.addEventListener('focusin',saveReadingPosition);
    const actionFeedback = document.getElementById('action-feedback');
    const localOnlyActions = new Set(['selectView','project','manageProject','mission','enterProjectWork','openAttention','scrollSection','refresh','openWorkSessions','openArtifact','workerStatus','runtimeStatus']);
    let actionInFlight = false;
    const setActionState = (busy, error) => {
      actionInFlight = busy;
      document.querySelectorAll('button[data-action]').forEach(button => {
        if (localOnlyActions.has(button.dataset.action)) return;
        if (busy && !button.disabled) { button.dataset.busyDisabled = 'true'; button.disabled = true; }
        else if (!busy && button.dataset.busyDisabled === 'true') { delete button.dataset.busyDisabled; button.disabled = false; }
        if (!busy && button.dataset.pending === 'true') {
          delete button.dataset.pending;
          button.removeAttribute('aria-busy');
          button.textContent = button.dataset.previousLabel;
          delete button.dataset.previousLabel;
        }
      });
      if (actionFeedback) {
        actionFeedback.textContent = error || (busy ? 'Nimora 正在处理，可能正在等待你的确认或 AI 回复。可以继续查看页面，请勿重复启动。' : '');
        actionFeedback.classList.toggle('visible', busy || !!error);
      }
    };
    window.addEventListener('message', event => {
      if (event.data?.type === 'nimoraActionState') setActionState(event.data.busy === true, event.data.error);
    });
    setActionState(${actionInFlight}, ${JSON.stringify(actionError ?? "").replace(/</g, "\\u003c")});
    const beginActionFeedback = (button, action) => {
      if (localOnlyActions.has(action)) return true;
      if (actionInFlight || button.disabled || button.dataset.pending === 'true') return false;
      button.dataset.pending = 'true';
      button.setAttribute('aria-busy','true');
      button.dataset.previousLabel = button.textContent;
      button.textContent = '正在处理…';
      setActionState(true);
      return true;
    };
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const action = button.dataset.action;
      if (!beginActionFeedback(button, action)) return;
      if (action === 'scrollSection') {
        const target = document.getElementById(button.dataset.target);
        if (target) target.scrollIntoView({behavior:'smooth',block:'start'});
        else vscode.postMessage({type:'selectView',view:'work'});
      }
      else if (action === 'selectView') vscode.postMessage({type:'selectView',view:button.dataset.view});
      else if (action === 'project') vscode.postMessage({type:'selectProject',projectId:button.dataset.project});
      else if (action === 'manageProject') vscode.postMessage({type:'manageProject',projectId:button.dataset.project});
      else if (action === 'mission') vscode.postMessage({type:'selectMission',projectId:button.dataset.project,missionId:button.dataset.mission});
      else if (action === 'diagnoseReviewedSettlement') vscode.postMessage({type:action,projectId:button.dataset.project});
      else if (action === 'takeoverReviewedWebWorkers' || action === 'resumeReviewedWebWorkers' || action === 'startReviewedFirstMission' || action === 'reconcileReviewedFirstRead' || action === 'sendReviewedFreshRead' || action === 'restoreReviewedSettledRead' || action === 'replaceReviewedClosedPages' || action === 'resumeReviewedFreshReplacement' || action === 'prepareReviewedPractice' || action === 'runReviewedPractice' || action === 'reconcileReviewedPractice') vscode.postMessage({type:action,projectId:button.dataset.project});
      else if (action === 'continueMission' || action === 'continueWebMission') vscode.postMessage({type:action,projectId:button.dataset.project,missionId:button.dataset.mission});
      else if (action === 'reviewProjectCompletion' || action === 'assignReadyWebMissions' || action === 'runWebAutonomy' || action === 'continueProject' || action === 'startNextProjectGoal' || action === 'resumeNextProjectGoal' || action === 'selectProjectSkills' || action === 'archiveRetiredConversation' || action === 'openProjectWorkspace' || action === 'changeProjectLocation' || action === 'archiveProjectFromList' || action === 'restoreArchivedProject' || action === 'enterProjectWork') vscode.postMessage({type:action,projectId:button.dataset.project});
      else if (action === 'pairPersonalEdge') vscode.postMessage({type:action});
      else if (action === 'openAttention') document.querySelector('.attention-panel')?.scrollIntoView({behavior:'smooth',block:'center'});
      else if (action === 'exportDiagnostics') vscode.postMessage({type:'exportDiagnostics'});
      else if (action === 'exportProjectBackup') vscode.postMessage({type:'exportProjectBackup',projectId:button.dataset.project});
      else if (action === 'restoreProjectBackup') vscode.postMessage({type:'restoreProjectBackup'});
      else if (action === 'connectWebAi') vscode.postMessage({type:'connectWebAi',provider:button.dataset.provider});
      else if (action === 'openArtifact') vscode.postMessage({type:'openArtifact',uri:button.dataset.uri});
      else if (action === 'acceptProposal' || action === 'commitProposal') vscode.postMessage({type:action,projectId:button.dataset.project,proposalId:button.dataset.proposal,contentDigest:button.dataset.digest,summary:button.dataset.summary});
      else vscode.postMessage({type:action});
    });
    document.querySelectorAll('[data-keyboard-nav]').forEach(group => {
      group.addEventListener('keydown', event => {
        if (!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        const buttons = Array.from(group.querySelectorAll('button:not([disabled])')).filter(button => !button.hidden && !button.closest('[hidden]'));
        if (!buttons.length) return;
        const current = buttons.indexOf(document.activeElement);
        let next = current < 0 ? 0 : current;
        if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = buttons.length - 1;
        else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (Math.max(current, -1) + 1) % buttons.length;
        else next = (current <= 0 ? buttons.length : current) - 1;
        event.preventDefault();
        buttons[next].focus();
      });
    });
    const projectFilter = document.getElementById('project-filter');
    const projectManagementFilter = document.getElementById('project-management-filter');
    const persisted = vscode.getState() || {};
    if (projectFilter) {
      projectFilter.value = persisted.projectFilter || '';
      const applyProjectFilter = () => {
        const query = projectFilter.value.trim().toLocaleLowerCase();
        document.querySelectorAll('.project-card').forEach(card => { card.hidden = !!query && !card.textContent.toLocaleLowerCase().includes(query); });
        vscode.setState({...vscode.getState(),projectFilter:projectFilter.value});
      };
      projectFilter.addEventListener('input', applyProjectFilter);
      applyProjectFilter();
    }
    if (projectManagementFilter) {
      projectManagementFilter.value = persisted.projectManagementFilter || '';
      const applyProjectManagementFilter = () => {
        const query = projectManagementFilter.value.trim().toLocaleLowerCase();
        document.querySelectorAll('.project-management-card').forEach(card => { card.hidden = !!query && !card.textContent.toLocaleLowerCase().includes(query); });
        vscode.setState({...vscode.getState(),projectManagementFilter:projectManagementFilter.value});
      };
      projectManagementFilter.addEventListener('input', applyProjectManagementFilter);
      applyProjectManagementFilter();
    }
    document.addEventListener('keydown', event => {
      if (event.altKey && event.key.toLocaleLowerCase() === 'n') { event.preventDefault(); vscode.postMessage({type:'newProjectAtLocation'}); return; }
      if (event.altKey && event.key.toLocaleLowerCase() === 'r') { event.preventDefault(); vscode.postMessage({type:'refresh'}); return; }
      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey && !['INPUT','TEXTAREA'].includes(document.activeElement?.tagName)) { event.preventDefault(); (projectManagementFilter || projectFilter)?.focus(); }
    });
  </script>
  </body></html>`;
}

export function registerNimoraProductShell(
  context: vscode.ExtensionContext,
  owners: ProjectMissionPresentationOwners,
  onDidChange?: (listener: () => void) => vscode.Disposable,
  governance?: ProjectGovernanceHumanApplication,
  operationalSource?: NimoraProductOperationalSource,
): vscode.Disposable {
  let panel: vscode.WebviewPanel | undefined;
  let view: ShellView = "work";
  let selectedProjectId: string | undefined;
  let selectedMissionId: string | undefined;
  let refreshTimer: NodeJS.Timeout | undefined;
  let refreshPending = false;
  let exclusiveActionInFlight = false;
  let actionError: string | undefined;
  const nonExclusiveMessageTypes = new Set<ShellMessage["type"]>([
    "refresh", "selectView", "manageProject", "selectProject", "selectMission", "enterProjectWork",
    "openWorkSessions", "openArtifact", "workerStatus", "runtimeStatus",
  ]);

  const exportDiagnostics = async (): Promise<void> => {
    const [projection, operations] = await Promise.all([
      readProjectMissionPresentation(owners),
      operationalSource?.read().catch(() => undefined),
    ]);
    const state = projectNimoraProductShell(projection, { projectId: selectedProjectId, missionId: selectedMissionId });
    const report = buildNimoraProductDiagnostics({
      state,
      operations,
      extensionVersion: String(context.extension.packageJSON?.version ?? "unknown"),
      workspaceTrusted: vscode.workspace.isTrusted,
      platform: process.platform,
      arch: process.arch,
      autonomyOutcomes: context.workspaceState?.get<Record<string, NimoraAutonomyUiOutcome>>(AUTONOMY_OUTCOME_KEY, {}) ?? {},
    });
    const observations = await vscode.commands.executeCommand("_shuncode.nimora.observations");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      defaultUri: workspace ? vscode.Uri.joinPath(workspace, `nimora-diagnostics-${stamp}.json`) : undefined,
      filters: { JSON: ["json"] },
      saveLabel: "导出 Nimora 诊断",
      title: "导出 Nimora 诊断",
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(JSON.stringify({ ...report, observations }, null, 2) + "\n"));
    await vscode.window.showInformationMessage("Nimora 诊断已导出。报告不包含聊天全文、文件内容、登录态或凭据。");
  };

  const exportProjectBackup = async (projectId?: string): Promise<void> => {
    const exactProjectId = projectId ?? selectedProjectId;
    if (!exactProjectId) throw new Error("请选择要备份的 Project。");
    const warning = await vscode.window.showWarningMessage(
      "Project backup 会包含 canonical Project/Mission 真值、工具参数与执行结果，可能含有项目敏感内容；不会包含浏览器登录态、Cookies、Provider transcript 或扩展 secrets。继续导出？",
      { modal: true },
      "导出备份",
    );
    if (warning !== "导出备份") return;
    const backup = await exportNimoraProjectBackup(context.globalStorageUri.fsPath, owners, exactProjectId);
    await verifyNimoraProjectBackup(backup);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      defaultUri: workspace ? vscode.Uri.joinPath(workspace, `nimora-project-${exactProjectId}-${stamp}.nimora-backup.json`) : undefined,
      filters: { "Nimora Backup": ["json"] },
      saveLabel: "导出 Project Backup",
      title: "导出 Nimora Project Backup",
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(JSON.stringify(backup, null, 2) + "\n"));
    await vscode.window.showInformationMessage("Nimora Project backup 已导出并通过真实 Store replay 验证。");
  };

  const restoreProjectBackup = async (): Promise<void> => {
    if (owners.projects.listProjects().length || owners.tasks.listTasks().length) {
      throw new Error("当前 profile 已有 Project/Task。恢复只允许空白 profile，现有真值不会被覆盖。");
    }
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      filters: { "Nimora Backup": ["json"] },
      openLabel: "验证备份",
      title: "选择 Nimora Project Backup",
    });
    if (!picked?.[0]) return;
    const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(picked[0]));
    const parsed = JSON.parse(raw);
    const verified = await verifyNimoraProjectBackup(parsed);
    const confirmed = await vscode.window.showWarningMessage(
      `备份 ${verified.projectId} 已通过真实 Store replay 验证。恢复会把 canonical journals 写入当前空白 profile，然后重载窗口；不会恢复网页登录态或旧 Provider 会话。继续？`,
      { modal: true },
      "恢复并重载",
    );
    if (confirmed !== "恢复并重载") return;
    await prepareNimoraProjectRestore(context.globalStorageUri.fsPath, owners, verified);
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
  };

  const render = async (): Promise<void> => {
    if (!panel) return;
    try {
      const [projection, operationalResult] = await Promise.all([
        readProjectMissionPresentation(owners),
        operationalSource?.read().then(value => ({ value })).catch(error => ({ error })),
      ]);
      const archivedProjectIds = context.globalState.get<string[]>(ARCHIVED_PROJECTS_KEY, []);
      const archivedProjects = new Set(archivedProjectIds);
      let state = projectNimoraProductShell(projection, { projectId: selectedProjectId, missionId: selectedMissionId });
      if (state.selectedProjectId && archivedProjects.has(state.selectedProjectId)) {
        const fallback = state.projects.find(project => !archivedProjects.has(project.projectId));
        if (fallback) state = projectNimoraProductShell(projection, { projectId: fallback.projectId });
        else { selectedProjectId = undefined; selectedMissionId = undefined; }
      }
      if (!state.selectedProjectId || !archivedProjects.has(state.selectedProjectId)) {
        selectedProjectId = state.selectedProjectId;
        selectedMissionId = state.selectedMissionId;
      }
      const operations = operationalResult && "value" in operationalResult
        ? operationalResult.value
        : operationalResult && "error" in operationalResult
          ? {
              generatedAt: new Date().toISOString(),
              candidateReadState: "unavailable" as const,
              candidateErrors: [operationalResult.error instanceof Error ? operationalResult.error.message : String(operationalResult.error)],
              providers: [],
              liveWorkers: [],
            }
          : undefined;
      const storageRoot = context.globalStorageUri?.fsPath;
      const reviewedRecoveryAvailable = !!storageRoot && existsSync(join(storageRoot, "recovery", "reviewed-formation-cognition.json"))
        && !(context.workspaceState?.get<string[]>("nimora.reviewedWebCognitionApplied", [])?.length);
      const takeoverStatuses = context.workspaceState?.get<Record<string, ReviewedReadRecoveryState>>("nimora.reviewedWebWorkerTakeover", {}) ?? {};
      const selectedPractice = state.selectedProjectId ? takeoverStatuses[state.selectedProjectId]?.practice : undefined;
      const practiceTask = selectedPractice?.missionId ? owners.tasks.listTasks().find(task => task.taskId === selectedPractice.missionId) : undefined;
      const practiceReviewState = selectedPractice?.phase !== 'sent' ? 'clear'
        : !practiceTask ? 'unavailable'
          : practiceNeedsFailureReview(practiceTask, selectedPractice.failureReview) ? 'needs-review' : 'clear';
      panel.webview.html = pageHtml(state, randomBytes(18).toString("base64"), view, operations,
        context.workspaceState?.get<string[]>("nimora.webProjectIds", []) ?? [], reviewedRecoveryAvailable,
        context.workspaceState?.get<string[]>("nimora.reviewedWebFormedOnlyProjectIds", []) ?? [], takeoverStatuses, practiceReviewState,
        context.workspaceState?.get<Record<string, NimoraAutonomyUiOutcome>>(AUTONOMY_OUTCOME_KEY, {}) ?? {},
        Object.keys(context.workspaceState?.get<Record<string, unknown>>("nimora.pendingLaterRoot.v1", {}) ?? {}),
        archivedProjectIds, exclusiveActionInFlight, actionError);
    } catch (error) {
      panel.webview.html = errorPageHtml(randomBytes(18).toString("base64"), error instanceof Error ? error.message : String(error));
    }
  };

  const queueRefresh = (): void => {
    if (!panel || refreshPending) return;
    refreshPending = true;
    queueMicrotask(() => {
      refreshPending = false;
      void render();
    });
  };

  const ensureProjectWorkspaceForWork = async (projectId: string): Promise<boolean> => {
    const project = (await readProjectMissionPresentation(owners)).projects.find(candidate => candidate.projectId === projectId);
    if (!project) throw new Error("Project 不存在或当前不可读取。");
    if (!project.workspace) return true;
    const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (current && current.toLocaleLowerCase() === project.workspace.toLocaleLowerCase()) return true;
    const open = await vscode.window.showInformationMessage(
      `“${project.title ?? project.goal ?? project.projectId}”属于另一个工作区。为了避免在错误目录执行操作，请先打开它自己的项目位置。`,
      { modal: true, detail: project.workspace }, "在新窗口打开", "取消",
    );
    if (open === "在新窗口打开") await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(project.workspace), { forceNewWindow: true });
    return false;
  };

  const handleMessage = async (message: ShellMessage): Promise<void> => {
    switch (message.type) {
      case "refresh":
        await render();
        break;
      case "exportDiagnostics":
        await exportDiagnostics();
        break;
      case "exportProjectBackup":
        await exportProjectBackup(message.projectId);
        break;
      case "restoreProjectBackup":
        await restoreProjectBackup();
        break;
      case "selectView":
        view = message.view;
        await render();
        break;
      case "selectProject":
        if (!(await ensureProjectWorkspaceForWork(message.projectId))) break;
        view = "work";
        selectedProjectId = message.projectId;
        selectedMissionId = undefined;
        await render();
        break;
      case "manageProject":
        view = "projects";
        selectedProjectId = message.projectId;
        selectedMissionId = undefined;
        await render();
        break;
      case "enterProjectWork":
        if (!(await ensureProjectWorkspaceForWork(message.projectId))) break;
        view = "work";
        selectedProjectId = message.projectId;
        selectedMissionId = undefined;
        await render();
        break;
      case "selectMission":
        if (!(await ensureProjectWorkspaceForWork(message.projectId))) break;
        view = "work";
        selectedProjectId = message.projectId;
        selectedMissionId = message.missionId;
        await render();
        break;
      case "newProjectAtLocation": {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          canSelectFiles: false,
          canSelectFolders: true,
          openLabel: "选择为项目位置",
          title: "选择 Nimora 项目位置",
        });
        if (!picked?.[0]) break;
        const current = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (current && current.toLocaleLowerCase() === picked[0].fsPath.toLocaleLowerCase()) {
          await handleMessage({ type: "newWebProject" });
          break;
        }
        const open = await vscode.window.showInformationMessage(
          "Nimora 会把项目绑定到创建时选择的文件夹。将在新窗口打开这个文件夹；打开后从“项目”页继续新建即可。",
          { modal: true }, "在新窗口打开", "取消",
        );
        if (open === "在新窗口打开") await vscode.commands.executeCommand("vscode.openFolder", picked[0], { forceNewWindow: true });
        break;
      }
      case "openProjectWorkspace": {
        const project = (await readProjectMissionPresentation(owners)).projects.find(candidate => candidate.projectId === message.projectId);
        if (!project?.workspace) {
          await vscode.window.showWarningMessage("这个项目没有可验证的位置记录，因此没有打开任何文件夹。");
          break;
        }
        await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(project.workspace));
        break;
      }
      case "changeProjectLocation": {
        const project = (await readProjectMissionPresentation(owners)).projects.find(candidate => candidate.projectId === message.projectId);
        if (!project) throw new Error("项目不存在或当前不可读取。");
        const confirmed = await vscode.window.showWarningMessage(
          "为避免项目历史和文件位置不一致，当前版本不会直接迁移已有项目。你可以在新位置创建一个新项目，原项目会保持不变。",
          { modal: true, detail: project.workspace ? `当前位置：${project.workspace}` : "当前位置未记录。" }, "在新位置新建", "取消",
        );
        if (confirmed === "在新位置新建") await handleMessage({ type: "newProjectAtLocation" });
        break;
      }
      case "archiveProjectFromList": {
        const projection = await readProjectMissionPresentation(owners);
        const project = projection.projects.find(candidate => candidate.projectId === message.projectId);
        if (!project) throw new Error("项目不存在或当前不可读取。");
        const confirmed = await vscode.window.showWarningMessage(
          `把“${project.title ?? project.goal ?? project.projectId}”从项目列表移出？`,
          { modal: true, detail: "这只会把项目从列表中隐藏，不会删除项目文件、任务历史或已有结果。之后可以从项目页恢复。" }, "移出列表", "取消",
        );
        if (confirmed !== "移出列表") break;
        const archived = new Set(context.globalState.get<string[]>(ARCHIVED_PROJECTS_KEY, []));
        archived.add(message.projectId);
        await context.globalState.update(ARCHIVED_PROJECTS_KEY, [...archived]);
        if (selectedProjectId === message.projectId) {
          selectedProjectId = projection.projects.find(candidate => !archived.has(candidate.projectId))?.projectId;
          selectedMissionId = undefined;
        }
        view = "projects";
        await render();
        break;
      }
      case "restoreArchivedProject": {
        const archived = new Set(context.globalState.get<string[]>(ARCHIVED_PROJECTS_KEY, []));
        archived.delete(message.projectId);
        await context.globalState.update(ARCHIVED_PROJECTS_KEY, [...archived]);
        selectedProjectId = message.projectId;
        selectedMissionId = undefined;
        view = "projects";
        await render();
        break;
      }
      case "newProject":
        if (!vscode.workspace.workspaceFolders?.length) {
          await vscode.window.showErrorMessage("请先打开一个工作区。Nimora Project 的产物需要明确 workspace boundary。");
          break;
        }
        if (!vscode.workspace.isTrusted) {
          await vscode.window.showErrorMessage("请先信任当前工作区。未信任工作区不会启动 Nimora Mission。");
          break;
        }
        {
          const request = await vscode.window.showInputBox({
            title: "新建 Nimora Project",
            prompt: "描述你最终希望 Nimora 完成的结果；可以同时写明范围、约束和完成标准。",
            placeHolder: "例如：为这个仓库完成一个可运行的产品首页，并通过现有测试",
            ignoreFocusOut: true,
            validateInput: value => value.trim() ? undefined : "请输入一个明确目标。",
          });
          if (!request?.trim()) break;
          const before = new Set((await readProjectMissionPresentation(owners)).projects.map(project => project.projectId));
          await vscode.commands.executeCommand("workbench.action.chat.newLocalChat");
          await vscode.commands.executeCommand("workbench.action.chat.open", {
            mode: "agent",
            query: `@shuncode ${request.trim()}`,
            isPartialQuery: false,
            blockOnResponse: true,
          });
          const after = await readProjectMissionPresentation(owners);
          const created = after.projects.find(project => !before.has(project.projectId));
          if (created) {
            selectedProjectId = created.projectId;
            selectedMissionId = undefined;
          }
          view = "work";
          panel?.reveal(vscode.ViewColumn.One);
          await render();
        }
        break;
      case "newWebProject": {
        if (!vscode.workspace.workspaceFolders?.length || !vscode.workspace.isTrusted) {
          await vscode.window.showWarningMessage("请先打开并信任一个项目文件夹，再新建 Nimora 项目。");
          break;
        }
        const request = await vscode.window.showInputBox({
          title: "新建 Nimora 项目",
          prompt: "输入目标。Nimora 会按当前 AI 资源设置组织规划、执行和验证；如果需要网页登录、共享、付费或其他权限，会明确向你确认。",
          placeHolder: "例如：阅读当前文件夹的需求.txt，完成待办网页及测试",
          ignoreFocusOut: true,
          validateInput: value => value.trim() ? undefined : "请输入明确的项目目标。",
        });
        if (!request?.trim()) break;
        const result = await vscode.commands.executeCommand<{ state: string; projectId?: string }>("shuncode.nimora.startWebProject", { request: request.trim() });
        if (result?.projectId) { selectedProjectId = result.projectId; selectedMissionId = undefined; }
        view = "work";
        panel?.reveal(vscode.ViewColumn.One);
        await render();
        break;
      }
      case "resumeNextProjectGoal":
      case "startNextProjectGoal": {
        const projection = await readProjectMissionPresentation(owners);
        if (!vscode.workspace.isTrusted || !projection.projects.some(project => project.projectId === message.projectId)) throw new Error("请选择当前可信工作区中的项目。");
        const pending = context.workspaceState.get<Record<string, import("./nimora-later-root-entry.js").PendingLaterRoot>>("nimora.pendingLaterRoot.v1", {})[message.projectId];
        if (message.type === "resumeNextProjectGoal" && !pending) throw new Error("上一次新增目标已经结束，请刷新项目状态后再继续。");
        const request = pending?.request ?? await vscode.window.showInputBox({ title: "在当前 Project 中开始下一项工作",
          prompt: "历史任务、产物与决定都会保留；输入这次的新目标。", ignoreFocusOut: true,
          validateInput: value => value.trim() && value.length <= 8000 ? undefined : "请输入不超过 8000 字符的新目标。" });
        if (!request?.trim()) break;
        await vscode.commands.executeCommand("shuncode.nimora.startNextProjectGoal", { projectId: message.projectId, request: request.trim() });
        selectedProjectId = message.projectId; selectedMissionId = undefined;
        await render();
        break;
      }
      case "selectProjectSkills":
        await vscode.commands.executeCommand("shuncode.nimora.selectProjectSkills", { projectId: message.projectId });
        await render(); break;
      case "archiveRetiredConversation":
        await vscode.commands.executeCommand("shuncode.nimora.archiveRetiredConversation", { projectId: message.projectId });
        await render(); break;
      case "pairPersonalEdge":
        await vscode.commands.executeCommand("shuncode.webMcp.pairPersonalEdge");
        await render(); break;
      case "adoptReviewedWebCognition": {
        if (!vscode.workspace.isTrusted) {
          await vscode.window.showWarningMessage("接入旧 Cognition 前必须信任当前工作区。");
          break;
        }
        const result = await vscode.commands.executeCommand<{ state: string; projectId?: string }>("shuncode.nimora.adoptReviewedWebCognition");
        if (result?.projectId) { selectedProjectId = result.projectId; selectedMissionId = undefined; }
        view = "work";
        panel?.reveal(vscode.ViewColumn.One);
        await render();
        break;
      }
      case "takeoverReviewedWebWorkers":
      case "resumeReviewedWebWorkers": {
        if (!vscode.workspace.isTrusted || !(await readProjectMissionPresentation(owners)).projects.some(project => project.projectId === message.projectId)) {
          await vscode.window.showWarningMessage("请选择当前可信工作区内的确切 Project。");
          break;
        }
        await vscode.commands.executeCommand(`shuncode.nimora.${message.type}`, { projectId: message.projectId });
        await render();
        break;
      }
      case "startReviewedFirstMission":
      case "reconcileReviewedFirstRead":
      case "restoreReviewedSettledRead":
      case "replaceReviewedClosedPages":
      case "resumeReviewedFreshReplacement":
      case "prepareReviewedPractice":
      case "runReviewedPractice":
      case "reconcileReviewedPractice":
      case "diagnoseReviewedSettlement":
      case "sendReviewedFreshRead": {
        if (!vscode.workspace.isTrusted || !(await readProjectMissionPresentation(owners)).projects.some(project => project.projectId === message.projectId)) {
          await vscode.window.showWarningMessage("请选择当前可信工作区内已接管的 Project。");
          break;
        }
        await vscode.commands.executeCommand(`shuncode.nimora.${message.type}`, { projectId: message.projectId });
        await render();
        break;
      }
      case "reviewProjectCompletion": {
        if (!vscode.workspace.isTrusted || !(await readProjectMissionPresentation(owners)).projects.some(project => project.projectId === message.projectId)) throw new Error("请选择当前可信工作区内的确切 Project。");
        await vscode.commands.executeCommand("shuncode.nimora.reviewProjectCompletion", { projectId: message.projectId });
        await render();
        break;
      }
      case "assignReadyWebMissions": {
        if (!vscode.workspace.isTrusted || !(await readProjectMissionPresentation(owners)).projects.some(project => project.projectId === message.projectId)) throw new Error("请选择当前可信工作区内的确切 Project。");
        await vscode.commands.executeCommand("shuncode.nimora.assignReadyWebMissions", { projectId: message.projectId });
        await render();
        break;
      }
      case "runWebAutonomy": {
        if (!vscode.workspace.isTrusted || !(await readProjectMissionPresentation(owners)).projects.some(project => project.projectId === message.projectId)) throw new Error("请选择当前可信工作区内的确切 Project。");
        await vscode.commands.executeCommand("shuncode.nimora.runWebAutonomy", { projectId: message.projectId });
        await render();
        break;
      }
      case "continueProject": {
        if (!vscode.workspace.isTrusted || !(await readProjectMissionPresentation(owners)).projects.some(project => project.projectId === message.projectId)) throw new Error("请选择当前可信工作区内的确切 Project。");
        const result = await vscode.commands.executeCommand<{ state?: string; reason?: string }>("shuncode.nimora.runWebAutonomy", { projectId: message.projectId });
        if (result?.state === "completion-candidate") {
          await vscode.commands.executeCommand("shuncode.nimora.reviewProjectCompletion", { projectId: message.projectId });
        }
        await render();
        break;
      }
      case "continueWebMission": {
        if (!vscode.workspace.isTrusted) {
          await vscode.window.showWarningMessage("请先信任当前工作区。Nimora 没有继续这个任务。");
          break;
        }
        const projection = await readProjectMissionPresentation(owners);
        const mission = projection.missions.find(candidate => candidate.projectId === message.projectId && candidate.missionId === message.missionId);
        if (!mission || mission.terminal) {
          await vscode.window.showWarningMessage("这个任务不存在或已经结束；Nimora 没有重复执行。");
          break;
        }
        if (mission.executions.some(execution => execution.status === "unknown")) {
          await vscode.window.showWarningMessage("上一次执行结果仍待核实。请先确认原操作结果，Nimora 不会自动重试。");
          await vscode.commands.executeCommand("shuncode.taskCenter.open");
          break;
        }
        const request = await vscode.window.showInputBox({ title: "继续当前任务 · 网页 AI", prompt: mission.goal, ignoreFocusOut: true, validateInput: value => value.trim() ? undefined : "请输入本轮目标。" });
        if (!request?.trim()) break;
        await vscode.commands.executeCommand("shuncode.nimora.continueWebMission", { projectId: mission.projectId, missionId: mission.missionId, request: request.trim() });
        selectedProjectId = mission.projectId;
        selectedMissionId = mission.missionId;
        panel?.reveal(vscode.ViewColumn.One);
        await render();
        break;
      }
      case "continueMission": {
        if (!vscode.workspace.isTrusted) {
          await vscode.window.showErrorMessage("请先信任当前工作区。Nimora 没有继续这个任务。");
          break;
        }
        const projection = await readProjectMissionPresentation(owners);
        const mission = projection.missions.find(candidate => candidate.projectId === message.projectId && candidate.missionId === message.missionId);
        if (!mission) {
          await vscode.window.showErrorMessage("这个任务已不存在或当前不可读取；没有发送任何请求。");
          await render();
          break;
        }
        if (mission.terminal) {
          await vscode.window.showInformationMessage("这个任务已结束。你可以查看产物，或在当前项目中开始下一项工作。");
          await render();
          break;
        }
        if (mission.executions.some(execution => execution.status === "unknown")) {
          await vscode.window.showWarningMessage("这个任务上一次执行的结果仍待核实。请先确认原操作结果；Nimora 不会把不确定状态当成重试许可。");
          await vscode.commands.executeCommand("shuncode.taskCenter.open");
          break;
        }
        const request = await vscode.window.showInputBox({
          title: "继续当前任务",
          prompt: mission.goal ? `当前任务：${mission.goal}` : "描述这一轮希望继续完成的工作。",
          placeHolder: "描述这一轮要继续完成什么",
          ignoreFocusOut: true,
          validateInput: value => value.trim() ? undefined : "请输入本轮请求。",
        });
        if (!request?.trim()) break;
        const resource = vscode.Uri.from({ scheme: "nimora-task", path: `/${encodeURIComponent(mission.missionId)}` });
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Nimora 正在继续任务…", cancellable: false }, async () => {
          await vscode.commands.executeCommand("workbench.action.chat.openSessionWithPrompt.nimora-task", {
            resource: resource.toJSON(),
            prompt: request.trim(),
          });
        });
        selectedProjectId = message.projectId;
        selectedMissionId = message.missionId;
        panel?.reveal(vscode.ViewColumn.One);
        await render();
        break;
      }
      case "openWorkSessions":
        await vscode.commands.executeCommand("shuncode.taskCenter.open");
        break;
      case "selectWorker":
        await vscode.commands.executeCommand("shuncode.nimora.selectProjectWorker", { projectId: selectedProjectId, missionId: selectedMissionId });
        queueRefresh();
        break;
      case "connectWebAi":
        if (message.provider !== "deepseek" && message.provider !== "chatgpt") {
          await vscode.window.showWarningMessage("请选择受支持的网页 AI；没有打开网页或修改 Worker。");
          break;
        }
        const connectedWebIds = context.workspaceState?.get<string[]>("nimora.webProjectIds", []) ?? [];
        const webProjectId = selectedProjectId && connectedWebIds.includes(selectedProjectId) ? selectedProjectId : undefined;
        await vscode.commands.executeCommand("shuncode.nimora.connectWebAi", { provider: message.provider, projectId: webProjectId, missionId: webProjectId ? selectedMissionId : undefined });
        queueRefresh();
        break;
      case "permissions":
        await vscode.commands.executeCommand("shuncode.capabilities.managePermissions");
        break;
      case "workerStatus":
        await vscode.commands.executeCommand("shuncode.webWorker.releaseStatus");
        break;
      case "connectMcp":
        await vscode.commands.executeCommand("shuncode.mission.connectNativeMcp");
        break;
      case "configureModel":
        await vscode.commands.executeCommand("shuncode.configureModel");
        queueRefresh();
        break;
      case "configureApiProfiles":
        await vscode.commands.executeCommand("shuncode.nimora.configureApiProfiles");
        queueRefresh();
        break;
      case "configureResources":
        await vscode.commands.executeCommand("shuncode.nimora.configureResources");
        queueRefresh();
        break;
      case "openWorkspace":
        await vscode.commands.executeCommand("workbench.action.files.openFolder");
        break;
      case "manageWorkspaceTrust":
        await vscode.commands.executeCommand("workbench.trust.manage");
        break;
      case "codexLogin":
        await vscode.commands.executeCommand("shuncode.codex.login");
        queueRefresh();
        break;
      case "runtimeStatus":
        await vscode.commands.executeCommand("shuncode.showRuntimeStatus");
        break;
      case "acceptProposal": {
        if (!governance) {
          await vscode.window.showWarningMessage("当前 Project Governance 服务不可用；未执行任何确认或提交。请检查 Nimora 扩展状态。");
          break;
        }
        const current = await readProjectMissionPresentation(owners);
        const proposal = current.projects.find(project => project.projectId === message.projectId)
          ?.pendingProposals?.find(candidate => candidate.proposalId === message.proposalId);
        if (!proposal || proposal.contentDigest !== message.contentDigest || proposal.state !== "awaiting-human") {
          await vscode.window.showWarningMessage("Project Proposal 已变化或当前不可读取。Nimora 未请求确认，请刷新后重新检查。", { modal: true });
          await render();
          break;
        }
        const confirmed = await vscode.window.showWarningMessage(
          `确认将这个 Proposal 提交为 Project truth？\n\n${proposal.content.summary}`,
          {
            modal: true,
            detail: "只有这次明确的人类确认才会创建 durable Human Confirmation。Worker 或 Chat 文本不会被当作确认。",
          },
          "确认并提交",
        );
        if (confirmed !== "确认并提交") break;
        try {
          const result = await governance.acceptProposal({
            projectId: message.projectId,
            proposalId: message.proposalId,
            contentDigest: message.contentDigest,
          });
          await vscode.window.showInformationMessage(`Project Decision 已提交；${result.impact.routeableMissionIds.length} 个 Mission 可接收该决定。`);
          await render();
        } catch (error) {
          await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
        break;
      }
      case "commitProposal": {
        if (!governance) {
          await vscode.window.showWarningMessage("当前 Project Governance 服务不可用；未执行任何确认或提交。请检查 Nimora 扩展状态。");
          break;
        }
        const current = await readProjectMissionPresentation(owners);
        const proposal = current.projects.find(project => project.projectId === message.projectId)
          ?.pendingProposals?.find(candidate => candidate.proposalId === message.proposalId);
        if (!proposal || proposal.contentDigest !== message.contentDigest || proposal.state !== "confirmed-awaiting-commit") {
          await vscode.window.showWarningMessage("已确认的 Project Proposal 已变化或当前不可读取。Nimora 未提交决定，请刷新后重新检查。", { modal: true });
          await render();
          break;
        }
        const confirmed = await vscode.window.showWarningMessage(
          `这个 Proposal 已有 durable Human Confirmation。现在提交为 Project truth？\n\n${proposal.content.summary}`,
          { modal: true, detail: "Commit 会再次从 canonical Project owner 校验 Proposal identity、digest 和已有 Human Confirmation。" },
          "提交决定",
        );
        if (confirmed !== "提交决定") break;
        try {
          const result = await governance.commitAlreadyConfirmed({
            projectId: message.projectId,
            proposalId: message.proposalId,
            contentDigest: message.contentDigest,
          });
          await vscode.window.showInformationMessage(`Project Decision 已提交；${result.impact.routeableMissionIds.length} 个 Mission 可接收该决定。`);
          await render();
        } catch (error) {
          await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
        }
        break;
      }
      case "openArtifact": {
        // Webview messages are untrusted. Never open an arbitrary URI supplied
        // by a page; resolve it from current canonical Project/Mission artifacts.
        const current = projectNimoraProductShell(await readProjectMissionPresentation(owners));
        const knownArtifact = current.projects.some(project => project.artifacts.some(artifact => artifact.uri === message.uri)
          || project.missions.some(mission => mission.artifacts.some(artifact => artifact.uri === message.uri)));
        if (!knownArtifact) {
          await vscode.window.showWarningMessage("产物链接已变化或不属于当前 canonical Project；没有打开。");
          break;
        }
        const uri = vscode.Uri.parse(message.uri, true);
        if (!["file", "vscode-remote", "http", "https"].includes(uri.scheme)) {
          await vscode.window.showWarningMessage("此产物的 URI 协议不支持安全打开；没有执行 URI 中的指令。");
          break;
        }
        await vscode.commands.executeCommand("vscode.open", uri);
        break;
      }
    }
  };

  const open = async (): Promise<void> => {
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    if (panel) {
      try {
        panel.reveal(vscode.ViewColumn.Active);
        await render();
        return;
      } catch {
        panel = undefined;
      }
    }
    panel = vscode.window.createWebviewPanel(PANEL_TYPE, "Nimora", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.iconPath = new vscode.ThemeIcon("sparkle");
    panel.webview.html = loadingPageHtml(randomBytes(18).toString("base64"));
    panel.webview.onDidReceiveMessage(message => {
      const shellMessage = message as ShellMessage;
      const exclusive = !nonExclusiveMessageTypes.has(shellMessage.type);
      if (exclusive && exclusiveActionInFlight) {
        void vscode.window.showInformationMessage("Nimora 正在处理上一项操作。可以继续查看页面；本次重复操作没有启动，也不会排队自动执行。");
        void panel?.webview.postMessage({ type: "nimoraActionState", busy: true });
        return;
      }
      if (exclusive) {
        exclusiveActionInFlight = true;
        actionError = undefined;
        void panel?.webview.postMessage({ type: "nimoraActionState", busy: true });
      }
      void handleMessage(shellMessage).catch(async error => {
        actionError = `Nimora 操作失败：${error instanceof Error ? error.message : String(error)}`;
        await vscode.window.showErrorMessage(actionError);
        await render();
      }).finally(() => {
        if (exclusive) {
          exclusiveActionInFlight = false;
          void panel?.webview.postMessage({ type: "nimoraActionState", busy: false, error: actionError });
        }
      });
    }, undefined, context.subscriptions);
    panel.onDidDispose(() => {
      panel = undefined;
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = undefined;
    }, undefined, context.subscriptions);
    refreshTimer = setInterval(queueRefresh, 5_000);
    await render();
  };

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  status.text = "$(sparkle) Nimora";
  status.tooltip = "Open Nimora";
  status.command = OPEN_COMMAND;
  status.show();

  const disposables: vscode.Disposable[] = [
    status,
    vscode.commands.registerCommand(OPEN_COMMAND, open),
    vscode.commands.registerCommand(EXPORT_DIAGNOSTICS_COMMAND, exportDiagnostics),
    vscode.commands.registerCommand(EXPORT_BACKUP_COMMAND, (projectId?: string) => exportProjectBackup(projectId)),
    vscode.commands.registerCommand(RESTORE_BACKUP_COMMAND, restoreProjectBackup),
  ];
  if (onDidChange) disposables.push(onDidChange(queueRefresh));
  const disposable = vscode.Disposable.from(...disposables);
  context.subscriptions.push(disposable);
  return disposable;
}

export const NIMORA_PRODUCT_SHELL_OPEN_COMMAND = OPEN_COMMAND;
export const NIMORA_PRODUCT_SHELL_EXPORT_DIAGNOSTICS_COMMAND = EXPORT_DIAGNOSTICS_COMMAND;
export const NIMORA_PRODUCT_SHELL_EXPORT_BACKUP_COMMAND = EXPORT_BACKUP_COMMAND;
export const NIMORA_PRODUCT_SHELL_RESTORE_BACKUP_COMMAND = RESTORE_BACKUP_COMMAND;
