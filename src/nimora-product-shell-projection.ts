import type {
  ProjectMissionPresentation,
  ProjectMissionPresentationMission,
  ProjectMissionPresentationProject,
} from "./project-mission-presentation.js";
import type { TaskTodo, TaskProgress } from "./task-contract.js";

export type NimoraProjectStatus = "active" | "completed" | "attention";

export interface NimoraShellOwnerHealth {
  owner: "projects" | "tasks" | "collaboration";
  label: string;
  status: "available" | "unavailable";
  detail?: string;
}

export type NimoraMissionGraphState = "active" | "ready" | "waiting" | "completed" | "attention" | "cancelled";

export interface NimoraMissionGraphNode {
  missionId: string;
  goal: string;
  role: ProjectMissionPresentationMission["semanticRole"];
  depth: number;
  state: NimoraMissionGraphState;
  status: string;
  workerLabel?: string;
  isRoot: boolean;
  openProblemCount: number;
  blockingProblemCount: number;
}

export interface NimoraMissionGraphEdge {
  relationId: string;
  sourceMissionId: string;
  targetMissionId: string;
  type: string;
  label: string;
  tone: "hierarchy" | "dependency" | "attention" | "knowledge" | "validation" | "lifecycle";
}

export interface NimoraShellMission {
  missionId: string;
  projectId: string;
  goal: string;
  role: ProjectMissionPresentationMission["semanticRole"];
  plane: ProjectMissionPresentationMission["plane"];
  status: string;
  terminal: boolean;
  activeWorkerCount: number;
  workerLabel?: string;
  executionCount: number;
  failedExecutionCount: number;
  artifactCount: number;
  todos: TaskTodo[];
  progress?: TaskProgress;
  executions: Array<{
    executionId: string;
    toolName: string;
    status: string;
    requestedAt: string;
    finishedAt?: string;
    detail?: string;
  }>;
  artifacts: Array<{
    artifactId: string;
    title: string;
    kind: string;
    uri?: string;
    createdAt: string;
  }>;
  problems: Array<{
    exchangeId: string;
    state: "Open" | "Answered";
    blocking: boolean;
    question: string;
    answers: string[];
    evidence: string[];
  }>;
  collaboration: Array<{
    exchangeId: string;
    kind: string;
    createdAt: string;
    title: string;
    detail?: string;
  }>;
}

export interface NimoraShellActivity {
  id: string;
  projectId: string;
  missionId?: string;
  at: string;
  kind: "execution" | "artifact" | "problem" | "answer" | "handoff" | "decision";
  tone: "neutral" | "success" | "attention" | "unknown";
  title: string;
  detail?: string;
}

export interface NimoraShellAttentionItem {
  id: string;
  projectId: string;
  missionId?: string;
  kind: "problem" | "execution-failed" | "execution-unknown" | "mission-failed" | "mission-waiting-user" | "proposal-awaiting-human" | "proposal-confirmed";
  severity: "attention" | "blocking";
  title: string;
  detail?: string;
  at?: string;
}

export interface NimoraShellProject {
  projectId: string;
  title: string;
  goal: string;
  workspace?: string;
  status: NimoraProjectStatus;
  sourceState: {
    metadata: ProjectMissionPresentationProject["metadataState"];
    decisions: ProjectMissionPresentationProject["decisionsState"];
    collaboration: ProjectMissionPresentationProject["collaborationState"];
  };
  missionCount: number;
  activeMissionCount: number;
  completedMissionCount: number;
  attentionCount: number;
  artifactCount: number;
  decisionCount: number;
  unknownExecutionCount: number;
  progress: {
    completed: number;
    total: number;
    percent: number;
    running: number;
    ready: number;
    waiting: number;
    failed: number;
    cancelled: number;
    successfulExecutions: number;
    failedExecutions: number;
    completedTodos: number;
    totalTodos: number;
  };
  graph: {
    nodes: NimoraMissionGraphNode[];
    edges: NimoraMissionGraphEdge[];
    maxDepth: number;
    activeMissionIds: string[];
    waitingMissionIds: string[];
  };
  attentions: NimoraShellAttentionItem[];
  artifacts: Array<{
    artifactId: string;
    missionId: string;
    title: string;
    kind: string;
    uri?: string;
    createdAt: string;
  }>;
  decisions: Array<{
    decisionId: string;
    summary: string;
    rationale?: string;
    committedAt: string;
  }>;
  governance: Array<{
    proposalId: string;
    contentDigest: string;
    summary: string;
    rationale?: string;
    scopeLabel: string;
    proposedAt: string;
    state: "awaiting-human" | "confirmed-awaiting-commit";
  }>;
  missions: NimoraShellMission[];
  activities: NimoraShellActivity[];
}

export interface NimoraProductShellState {
  version: 1;
  generatedAt: string;
  selectedProjectId?: string;
  selectedMissionId?: string;
  system: {
    mode: "ready" | "degraded" | "empty" | "unavailable";
    reconstruction: "ready" | "partial";
    owners: NimoraShellOwnerHealth[];
    integrityIssueCount: number;
    integrityIssues: Array<{
      code: string;
      projectId: string;
      missionId?: string;
      detail: string;
    }>;
    legacyTaskCount: number;
    emptyReason?: "no-projects" | "project-owner-unavailable" | "task-owner-unavailable" | "owners-unavailable";
  };
  projects: NimoraShellProject[];
  totalProjects: number;
  activeProjects: number;
  activeMissions: number;
  attentionCount: number;
  unknownExecutionCount: number;
}

function activeWorkers(mission: ProjectMissionPresentationMission): ProjectMissionPresentationMission["workers"] {
  return mission.workers.filter(worker => !worker.detachedAt && !worker.retiredAt);
}

function graphState(mission: ProjectMissionPresentationMission, project: ProjectMissionPresentationProject): NimoraMissionGraphState {
  const openProblems = project.problems.filter(problem =>
    problem.answerState === "Open"
    && (problem.sourceMissionId === mission.missionId || problem.targetMissionId === mission.missionId));
  if (openProblems.some(problem => problem.blocking) || mission.taskStatus === "failed") return "attention";
  if (mission.taskStatus === "cancelled") return "cancelled";
  if (mission.terminal) return "completed";
  if (mission.taskStatus === "waiting_user" || mission.taskStatus === "waiting_external") return "waiting";
  if (mission.taskStatus === "draft" || mission.taskStatus === "ready") return "ready";
  return "active";
}

function relationPresentation(type: string): Pick<NimoraMissionGraphEdge, "label" | "tone"> {
  switch (type) {
    case "parent_of": return { label: "包含", tone: "hierarchy" };
    case "depends_on": return { label: "依赖", tone: "dependency" };
    case "blocks": return { label: "阻塞", tone: "attention" };
    case "informs": return { label: "提供信息", tone: "knowledge" };
    case "answers": return { label: "回答", tone: "knowledge" };
    case "validates": return { label: "验证", tone: "validation" };
    case "spawned_by": return { label: "由其产生", tone: "lifecycle" };
    case "supersedes": return { label: "取代", tone: "lifecycle" };
    default: return { label: type, tone: "knowledge" };
  }
}

function projectGraph(
  project: ProjectMissionPresentationProject,
  sourceMissions: readonly ProjectMissionPresentationMission[],
): NimoraShellProject["graph"] {
  const missionIds = new Set(sourceMissions.map(mission => mission.missionId));
  const nodes = sourceMissions.map(mission => {
    const workers = activeWorkers(mission);
    const worker = workers[workers.length - 1];
    const openProblems = project.problems.filter(problem =>
      problem.answerState === "Open"
      && (problem.sourceMissionId === mission.missionId || problem.targetMissionId === mission.missionId));
    return {
      missionId: mission.missionId,
      goal: mission.goal?.trim() || mission.missionType || mission.missionId,
      role: mission.semanticRole,
      depth: mission.hierarchyDepth ?? 0,
      state: graphState(mission, project),
      status: mission.presentationState,
      workerLabel: worker ? [worker.workerId, worker.model].filter(Boolean).join(" · ") : undefined,
      isRoot: mission.rootMissionId === mission.missionId,
      openProblemCount: openProblems.length,
      blockingProblemCount: openProblems.filter(problem => problem.blocking).length,
    } satisfies NimoraMissionGraphNode;
  }).sort((a, b) => a.depth - b.depth || a.missionId.localeCompare(b.missionId));
  const edgeById = new Map<string, NimoraMissionGraphEdge>();
  for (const relation of [...project.hierarchyRelations, ...project.relations]) {
    if (!missionIds.has(relation.sourceMissionId) || !missionIds.has(relation.targetMissionId)) continue;
    const presentation = relationPresentation(relation.type);
    edgeById.set(relation.relationId, {
      relationId: relation.relationId,
      sourceMissionId: relation.sourceMissionId,
      targetMissionId: relation.targetMissionId,
      type: relation.type,
      label: presentation.label,
      tone: presentation.tone,
    });
  }
  const edges = [...edgeById.values()].sort((a, b) => a.type.localeCompare(b.type) || a.relationId.localeCompare(b.relationId));
  return {
    nodes,
    edges,
    maxDepth: nodes.reduce((max, node) => Math.max(max, node.depth), 0),
    activeMissionIds: nodes.filter(node => node.state === "active" || node.state === "ready").map(node => node.missionId),
    waitingMissionIds: nodes.filter(node => node.state === "waiting" || node.state === "attention").map(node => node.missionId),
  };
}

function toolLabel(toolName: string): string {
  const labels: Record<string, string> = {
    read_files: "读取文件",
    write_file: "写入文件",
    apply_patch: "修改文件",
    run_command: "运行命令",
    list_directory: "查看目录",
    find_files: "查找文件",
    search_files: "搜索代码",
    get_diagnostics: "检查诊断",
  };
  return labels[toolName] ?? toolName.replaceAll("_", " ");
}

function exchangeSummary(exchange: ProjectMissionPresentationProject["exchanges"][number]): { title: string; detail?: string } {
  if (exchange.kind === "Problem") return { title: exchange.payload.blocking ? "阻塞问题" : "发现问题", detail: exchange.payload.preciseQuestion };
  if (exchange.kind === "Answer") return { title: "问题回答", detail: exchange.payload.answer };
  if (exchange.kind === "Finding") return { title: "工作发现", detail: exchange.payload.summary };
  if (exchange.kind === "Evidence") return { title: "补充证据", detail: exchange.payload.summary };
  return { title: "Mission 交接", detail: `Artifact ${exchange.payload.artifactId}` };
}

function missionView(mission: ProjectMissionPresentationMission, project: ProjectMissionPresentationProject): NimoraShellMission {
  const workers = activeWorkers(mission);
  const failedExecutionCount = mission.executions.filter(execution => execution.status === "failed" || execution.status === "unknown").length;
  const worker = workers[workers.length - 1];
  const problemExchangeById = new Map(
    project.exchanges
      .filter(exchange => exchange.kind === "Problem")
      .map(exchange => [exchange.exchangeId, exchange] as const),
  );
  const problems = project.problems
    .filter(problem => problem.sourceMissionId === mission.missionId || problem.targetMissionId === mission.missionId)
    .map(problem => ({
      exchangeId: problem.exchangeId,
      state: problem.answerState,
      blocking: problem.blocking,
      question: problemExchangeById.get(problem.exchangeId)?.payload.preciseQuestion ?? "问题详情不可用",
      answers: problem.answers.map(answer => answer.answer),
      evidence: problem.evidence.map(evidence => evidence.kind === "Evidence" ? evidence.payload.summary : evidence.exchangeId),
    }));
  const collaboration = project.exchanges
    .filter(exchange => exchange.sourceMissionId === mission.missionId || exchange.targetMissionId === mission.missionId)
    .map(exchange => {
      const summary = exchangeSummary(exchange);
      return {
        exchangeId: exchange.exchangeId,
        kind: exchange.kind,
        createdAt: exchange.createdAt,
        title: summary.title,
        detail: summary.detail,
      };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.exchangeId.localeCompare(b.exchangeId));
  return {
    missionId: mission.missionId,
    projectId: mission.projectId,
    goal: mission.goal?.trim() || mission.missionType || mission.missionId,
    role: mission.semanticRole,
    plane: mission.plane,
    status: mission.presentationState,
    terminal: mission.terminal,
    activeWorkerCount: workers.length,
    workerLabel: worker ? [worker.workerId, worker.model].filter(Boolean).join(" · ") : undefined,
    executionCount: mission.executions.length,
    failedExecutionCount,
    artifactCount: mission.artifacts.length,
    todos: (mission.todos ?? []).map(todo => ({ ...todo })),
    progress: mission.progress ? { ...mission.progress } : undefined,
    executions: mission.executions
      .map(execution => ({
        executionId: execution.executionId,
        toolName: toolLabel(execution.toolName),
        status: execution.status,
        requestedAt: execution.requestedAt,
        finishedAt: execution.finishedAt,
        detail: execution.error ?? execution.resultSummary,
      }))
      .sort((a, b) => (b.finishedAt ?? b.requestedAt).localeCompare(a.finishedAt ?? a.requestedAt) || a.executionId.localeCompare(b.executionId)),
    artifacts: mission.artifacts
      .map(artifact => ({
        artifactId: artifact.artifactId,
        title: artifact.title,
        kind: artifact.kind,
        uri: artifact.uri,
        createdAt: artifact.createdAt,
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.artifactId.localeCompare(b.artifactId)),
    problems,
    collaboration,
  };
}

function exchangeActivity(project: ProjectMissionPresentationProject): NimoraShellActivity[] {
  return project.exchanges.map(exchange => {
    const detail = exchange.kind === "Problem"
      ? exchange.payload.preciseQuestion
      : exchange.kind === "Answer"
        ? exchange.payload.answer
        : exchange.kind === "Finding"
          ? exchange.payload.summary
          : exchange.kind === "Handoff"
            ? `Handoff artifact ${exchange.payload.artifactId}`
            : undefined;
    return {
      id: `exchange:${exchange.exchangeId}`,
      projectId: project.projectId,
      missionId: exchange.sourceMissionId,
      at: exchange.createdAt,
      kind: exchange.kind === "Problem" ? "problem"
        : exchange.kind === "Answer" ? "answer"
          : exchange.kind === "Handoff" ? "handoff"
            : "answer",
      tone: exchange.kind === "Problem" && exchange.payload.blocking
        ? "attention"
        : exchange.kind === "Answer" || exchange.kind === "Handoff"
          ? "success"
          : "neutral",
      title: exchange.kind === "Problem" ? "发现需要处理的问题"
        : exchange.kind === "Answer" ? "问题获得回答"
          : exchange.kind === "Handoff" ? "Mission 已交接"
            : "记录了新的工作发现",
      detail,
    };
  });
}

function projectActivities(
  project: ProjectMissionPresentationProject,
  missions: readonly ProjectMissionPresentationMission[],
): NimoraShellActivity[] {
  const activities: NimoraShellActivity[] = [];
  for (const mission of missions) {
    for (const execution of mission.executions) {
      activities.push({
        id: `execution:${execution.executionId}`,
        projectId: project.projectId,
        missionId: mission.missionId,
        at: execution.finishedAt ?? execution.requestedAt,
        kind: "execution",
        tone: execution.status === "succeeded" ? "success"
          : execution.status === "failed" ? "attention"
            : execution.status === "unknown" ? "unknown"
              : "neutral",
        title: execution.status === "succeeded" ? `完成：${toolLabel(execution.toolName)}`
          : execution.status === "failed" ? `失败：${toolLabel(execution.toolName)}`
            : execution.status === "unknown" ? `结果待确认：${toolLabel(execution.toolName)}`
              : `执行：${toolLabel(execution.toolName)}`,
        detail: execution.error ?? execution.resultSummary,
      });
    }
    for (const artifact of mission.artifacts) {
      activities.push({
        id: `artifact:${artifact.artifactId}`,
        projectId: project.projectId,
        missionId: mission.missionId,
        at: artifact.createdAt,
        kind: "artifact",
        tone: "success",
        title: `产物：${artifact.title}`,
        detail: artifact.uri,
      });
    }
  }
  activities.push(...exchangeActivity(project));
  for (const decision of project.committedDecisions) {
    activities.push({
      id: `decision:${decision.decisionId}`,
      projectId: project.projectId,
      at: decision.committedAt,
      kind: "decision",
      tone: "success",
      title: "项目决定已确认",
      detail: decision.content.summary,
    });
  }
  return activities
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    .slice(0, 80);
}

function projectAttentionItems(
  project: ProjectMissionPresentationProject,
  missions: readonly ProjectMissionPresentationMission[],
): NimoraShellAttentionItem[] {
  const missionById = new Map(missions.map(mission => [mission.missionId, mission] as const));
  const problemExchangeById = new Map(
    project.exchanges
      .filter(exchange => exchange.kind === "Problem")
      .map(exchange => [exchange.exchangeId, exchange] as const),
  );
  const items: NimoraShellAttentionItem[] = [];

  for (const proposal of project.pendingProposals ?? []) {
    items.push({
      id: `proposal:${proposal.proposalId}`,
      projectId: project.projectId,
      kind: proposal.state === "awaiting-human" ? "proposal-awaiting-human" : "proposal-confirmed",
      severity: proposal.state === "awaiting-human" ? "blocking" : "attention",
      title: proposal.state === "awaiting-human" ? "有 Project Proposal 等待你的确认" : "Proposal 已确认，等待 Commit",
      detail: proposal.content.summary,
      at: proposal.confirmedAt ?? proposal.proposedAt,
    });
  }

  for (const problem of project.problems) {
    if (problem.answerState !== "Open") continue;
    const exchange = problemExchangeById.get(problem.exchangeId);
    items.push({
      id: `problem:${problem.exchangeId}`,
      projectId: project.projectId,
      missionId: problem.sourceMissionId,
      kind: "problem",
      severity: problem.blocking ? "blocking" : "attention",
      title: problem.blocking ? "Mission 被问题阻塞" : "Mission 有待处理问题",
      detail: exchange?.payload.preciseQuestion ?? missionById.get(problem.sourceMissionId)?.goal,
      at: exchange?.createdAt,
    });
  }

  for (const mission of missions) {
    if (mission.taskStatus === "failed") {
      items.push({
        id: `mission-failed:${mission.missionId}`,
        projectId: project.projectId,
        missionId: mission.missionId,
        kind: "mission-failed",
        severity: "blocking",
        title: "Mission 已失败",
        detail: mission.goal,
      });
    } else if (mission.taskStatus === "waiting_user") {
      items.push({
        id: `mission-waiting-user:${mission.missionId}`,
        projectId: project.projectId,
        missionId: mission.missionId,
        kind: "mission-waiting-user",
        severity: "blocking",
        title: "Mission 正在等待你的输入",
        detail: mission.goal,
      });
    }
    for (const execution of mission.executions) {
      if (execution.status !== "failed" && execution.status !== "unknown") continue;
      items.push({
        id: `execution:${execution.executionId}`,
        projectId: project.projectId,
        missionId: mission.missionId,
        kind: execution.status === "unknown" ? "execution-unknown" : "execution-failed",
        severity: execution.status === "unknown" ? "blocking" : "attention",
        title: execution.status === "unknown"
          ? `执行结果待确认：${execution.toolName}`
          : `执行失败：${execution.toolName}`,
        detail: execution.error ?? execution.resultSummary ?? mission.goal,
        at: execution.finishedAt ?? execution.requestedAt,
      });
    }
  }

  return items.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "blocking" ? -1 : 1;
    return (b.at ?? "").localeCompare(a.at ?? "") || a.id.localeCompare(b.id);
  });
}

function projectView(
  project: ProjectMissionPresentationProject,
  allMissions: readonly ProjectMissionPresentationMission[],
): NimoraShellProject {
  const sourceMissions = allMissions
    .filter(mission => mission.projectId === project.projectId)
    .sort((a, b) => (a.hierarchyDepth ?? 999) - (b.hierarchyDepth ?? 999) || a.missionId.localeCompare(b.missionId));
  const missions = sourceMissions.map(mission => missionView(mission, project));
  const activeMissionCount = missions.filter(mission => !mission.terminal).length;
  const completedMissionCount = missions.filter(mission => mission.terminal && (mission.status === "completed" || mission.status === "archived")).length;
  const attentions = projectAttentionItems(project, sourceMissions);
  const attentionCount = attentions.length;
  const status: NimoraProjectStatus = attentionCount > 0 ? "attention" : activeMissionCount > 0 ? "active" : "completed";
  const artifacts = sourceMissions
    .flatMap(mission => mission.artifacts.map(artifact => ({
      artifactId: artifact.artifactId,
      missionId: mission.missionId,
      title: artifact.title,
      kind: artifact.kind,
      uri: artifact.uri,
      createdAt: artifact.createdAt,
    })))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.artifactId.localeCompare(b.artifactId));
  const decisions = project.committedDecisions
    .map(decision => ({
      decisionId: decision.decisionId,
      summary: decision.content.summary,
      rationale: decision.content.rationale,
      committedAt: decision.committedAt,
    }))
    .sort((a, b) => b.committedAt.localeCompare(a.committedAt) || a.decisionId.localeCompare(b.decisionId));
  const governance = (project.pendingProposals ?? [])
    .map(proposal => ({
      proposalId: proposal.proposalId,
      contentDigest: proposal.contentDigest,
      summary: proposal.content.summary,
      rationale: proposal.content.rationale,
      scopeLabel: proposal.content.scope.kind === "project"
        ? "整个 Project"
        : `${proposal.content.scope.missionIds.length} 个 Mission`,
      proposedAt: proposal.proposedAt,
      state: proposal.state,
    }))
    .sort((a, b) => a.proposedAt.localeCompare(b.proposedAt) || a.proposalId.localeCompare(b.proposalId));
  const progress = {
    completed: completedMissionCount,
    total: missions.length,
    percent: missions.length ? Math.round((completedMissionCount / missions.length) * 100) : 0,
    running: sourceMissions.filter(mission => mission.taskStatus === "running").length,
    ready: sourceMissions.filter(mission => mission.taskStatus === "ready" || mission.taskStatus === "draft").length,
    waiting: sourceMissions.filter(mission => mission.taskStatus === "waiting_user" || mission.taskStatus === "waiting_external").length,
    failed: sourceMissions.filter(mission => mission.taskStatus === "failed").length,
    cancelled: sourceMissions.filter(mission => mission.taskStatus === "cancelled").length,
    successfulExecutions: sourceMissions.reduce((sum, mission) => sum + mission.executions.filter(execution => execution.status === "succeeded").length, 0),
    failedExecutions: sourceMissions.reduce((sum, mission) => sum + mission.executions.filter(execution => execution.status === "failed").length, 0),
    completedTodos: missions.reduce((sum, mission) => sum + mission.todos.filter(todo => todo.status === "completed").length, 0),
    totalTodos: missions.reduce((sum, mission) => sum + mission.todos.length, 0),
  };
  const graph = projectGraph(project, sourceMissions);
  const unknownExecutionCount = sourceMissions.reduce(
    (sum, mission) => sum + mission.executions.filter(execution => execution.status === "unknown").length,
    0,
  );
  return {
    projectId: project.projectId,
    title: project.title?.trim() || project.goal?.trim() || "未命名项目",
    goal: project.goal?.trim() || "暂无项目目标",
    workspace: project.workspace,
    status,
    sourceState: {
      metadata: project.metadataState,
      decisions: project.decisionsState,
      collaboration: project.collaborationState,
    },
    missionCount: missions.length,
    activeMissionCount,
    completedMissionCount,
    attentionCount,
    artifactCount: artifacts.length,
    decisionCount: project.committedDecisions.length,
    unknownExecutionCount,
    progress,
    graph,
    attentions,
    artifacts,
    decisions,
    governance,
    missions,
    activities: projectActivities(project, sourceMissions),
  };
}

export function projectNimoraProductShell(
  presentation: ProjectMissionPresentation,
  selection: { projectId?: string; missionId?: string } = {},
  now: () => Date = () => new Date(),
): NimoraProductShellState {
  const projects = presentation.projects.map(project => projectView(project, presentation.missions));
  const selectedProjectId = selection.projectId && projects.some(project => project.projectId === selection.projectId)
    ? selection.projectId
    : projects[0]?.projectId;
  const selected = projects.find(project => project.projectId === selectedProjectId);
  const selectedMissionId = selection.missionId && selected?.missions.some(mission => mission.missionId === selection.missionId)
    ? selection.missionId
    : undefined;
  const owners: NimoraShellOwnerHealth[] = [
    {
      owner: "projects",
      label: "Project truth",
      status: presentation.availability.projects.status,
      ...(presentation.availability.projects.status === "unavailable" ? { detail: presentation.availability.projects.detail } : {}),
    },
    {
      owner: "tasks",
      label: "Mission runtime",
      status: presentation.availability.tasks.status,
      ...(presentation.availability.tasks.status === "unavailable" ? { detail: presentation.availability.tasks.detail } : {}),
    },
    {
      owner: "collaboration",
      label: "Mission collaboration",
      status: presentation.availability.collaboration.status,
      ...(presentation.availability.collaboration.status === "unavailable" ? { detail: presentation.availability.collaboration.detail } : {}),
    },
  ];
  const unavailableOwners = owners.filter(owner => owner.status === "unavailable");
  const integrityIssues = presentation.integrityIssues.map(issue => ({
    code: issue.code,
    projectId: issue.projectId,
    missionId: issue.missionId,
    detail: issue.detail,
  }));
  const hasMissingProject = projects.some(project => project.sourceState.metadata === "missing");
  const reconstruction = unavailableOwners.length === 0 && integrityIssues.length === 0 && !hasMissingProject ? "ready" as const : "partial" as const;
  let emptyReason: NimoraProductShellState["system"]["emptyReason"];
  if (projects.length === 0) {
    const projectUnavailable = presentation.availability.projects.status === "unavailable";
    const taskUnavailable = presentation.availability.tasks.status === "unavailable";
    emptyReason = projectUnavailable && taskUnavailable
      ? "owners-unavailable"
      : projectUnavailable
        ? "project-owner-unavailable"
        : taskUnavailable
          ? "task-owner-unavailable"
          : "no-projects";
  }
  const mode: NimoraProductShellState["system"]["mode"] = projects.length === 0
    ? emptyReason === "no-projects" ? "empty" : "unavailable"
    : unavailableOwners.length > 0 || integrityIssues.length > 0 || hasMissingProject
      ? "degraded"
      : "ready";
  const unknownExecutionCount = projects.reduce((sum, project) => sum + project.unknownExecutionCount, 0);
  return {
    version: 1,
    generatedAt: now().toISOString(),
    selectedProjectId,
    selectedMissionId,
    system: {
      mode,
      reconstruction,
      owners,
      integrityIssueCount: integrityIssues.length,
      integrityIssues,
      legacyTaskCount: presentation.legacyTaskIds.length,
      ...(emptyReason ? { emptyReason } : {}),
    },
    projects,
    totalProjects: projects.length,
    activeProjects: projects.filter(project => project.status !== "completed").length,
    activeMissions: projects.reduce((sum, project) => sum + project.activeMissionCount, 0),
    attentionCount: projects.reduce((sum, project) => sum + project.attentionCount, 0),
    unknownExecutionCount,
  };
}
