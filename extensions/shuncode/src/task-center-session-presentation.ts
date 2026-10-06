import type { TaskCenterTaskDetail, TaskCenterTaskSummary } from "../../../src/task-center-projection.js";
import type {
  ProjectMissionPresentation,
  ProjectMissionPresentationMission,
  ProjectMissionPresentationProject,
} from "../../../src/project-mission-presentation.js";

export type TaskSessionPresentationStatus = "failed" | "completed" | "in_progress" | "needs_input";

export interface TaskSessionPresentation {
  taskId: string;
  label: string;
  description: string;
  badge: string;
  status: TaskSessionPresentationStatus;
  createdAt: number;
  updatedAt: number;
  terminal: boolean;
}

function taskStatusText(status: TaskCenterTaskSummary["status"]): string {
  return status.replace(/_/g, " ");
}

function projectForMission(
  projection: ProjectMissionPresentation,
  mission: ProjectMissionPresentationMission,
): ProjectMissionPresentationProject | undefined {
  return projection.projects.find(project => project.projectId === mission.projectId);
}

function missionLifecycleText(mission: ProjectMissionPresentationMission): string {
  if (mission.finalization?.state === "archived") return "Mission archived";
  if (mission.finalization?.state === "completed") return "Mission completed";
  return "Mission not finalized";
}

function missionStatusPresentation(
  mission: ProjectMissionPresentationMission,
): { status: TaskSessionPresentationStatus; badge: string; terminal: boolean } {
  if (mission.finalized) {
    return {
      status: "completed",
      badge: mission.finalization?.state === "archived" ? "Mission archived" : "Mission completed",
      terminal: true,
    };
  }
  if (mission.taskStatus === "waiting_user") {
    return { status: "needs_input", badge: "Task waiting user", terminal: false };
  }
  return { status: "in_progress", badge: `Task ${taskStatusText(mission.taskStatus)}`, terminal: false };
}

export function presentProjectMissionSession(
  task: TaskCenterTaskSummary,
  projection: ProjectMissionPresentation,
  mission: ProjectMissionPresentationMission,
): TaskSessionPresentation {
  const project = projectForMission(projection, mission);
  const status = missionStatusPresentation(mission);
  const projectIdentity = project?.metadataState === "available"
    ? `Project · ${oneLine(project.title, 80) ?? mission.projectId}`
    : project?.metadataState === "missing"
      ? `Project · ${mission.projectId} · metadata missing`
      : `Project · ${mission.projectId} · metadata unavailable`;
  const description = [
    projectIdentity,
    mission.semanticRole,
    oneLine(mission.missionType, 80),
    `Task ${taskStatusText(mission.taskStatus)}`,
    missionLifecycleText(mission),
  ].filter((part): part is string => Boolean(part)).join(" · ");
  return {
    taskId: task.taskId,
    label: oneLine(`${mission.semanticRole} · ${mission.goal ?? mission.missionType ?? mission.missionId}`, 120) ?? `${mission.semanticRole} · Mission`,
    description: oneLine(description, 220) ?? projectIdentity,
    badge: status.badge,
    status: status.status,
    createdAt: Date.parse(task.createdAt),
    updatedAt: Date.parse(task.updatedAt),
    terminal: status.terminal,
  };
}

export interface TaskSessionArtifactPresentation {
  artifactId: string;
  kind: TaskCenterTaskDetail["artifacts"][number]["kind"];
  title: string;
  uri?: string;
  files: string[];
  additions?: number;
  deletions?: number;
  diffTruncated: boolean;
  resultTruncated: boolean;
  locations: TaskSessionArtifactLocation[];
  locationCount?: number;
  locationsTruncated: boolean;
  entries: TaskSessionArtifactEntry[];
  entryCount?: number;
  content?: string;
  contentLanguage?: string;
  contentTruncated: boolean;
  terminal?: TaskSessionTerminalPresentation;
}

export interface TaskSessionTerminalPresentation {
  terminalId?: string;
  commandId?: string;
  terminalName?: string;
  execution?: string;
  status?: string;
  cwd?: string;
  command?: string;
  commandTruncated: boolean;
  exitCode?: number;
  background?: boolean;
  openable: boolean;
  outputLost: boolean;
  hasMore: boolean;
  bytesSent?: number;
}

export interface TaskSessionArtifactLocation {
  path: string;
  line: number;
  column?: number;
  label?: string;
}

export interface TaskSessionArtifactEntry {
  path: string;
  kind: "file" | "folder" | "link" | "other";
}

export interface TaskSessionFileTreeNode {
  name: string;
  children?: TaskSessionFileTreeNode[];
}

function oneLine(value: string | undefined, maxChars: number): string | undefined {
  const line = value?.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  return line.length <= maxChars ? line : `${line.slice(0, Math.max(0, maxChars - 1))}…`;
}

function statusPresentation(task: TaskCenterTaskSummary): { status: TaskSessionPresentationStatus; badge: string; terminal: boolean } {
  switch (task.status) {
    case "failed":
      return { status: "failed", badge: "Failed", terminal: true };
    case "completed":
      return { status: "completed", badge: "Completed", terminal: true };
    case "cancelled":
      return { status: "completed", badge: "Cancelled", terminal: true };
    case "waiting_user":
      return { status: "needs_input", badge: "Needs input", terminal: false };
    case "waiting_external":
      return { status: "in_progress", badge: "Waiting", terminal: false };
    default:
      if (typeof task.progress?.percent === "number") {
        return { status: "in_progress", badge: `${Math.round(task.progress.percent)}%`, terminal: false };
      }
      return { status: "in_progress", badge: task.progress?.phase ? oneLine(task.progress.phase, 32) ?? "In progress" : "In progress", terminal: false };
  }
}

export function presentTaskSession(task: TaskCenterTaskSummary): TaskSessionPresentation {
  const status = statusPresentation(task);
  const completed = task.todoCounts.completed;
  const total = task.todoCounts.total;
  const parts = [
    total ? `${completed}/${total} todos` : undefined,
    task.activeWorkerCount ? `${task.activeWorkerCount} active AI${task.activeWorkerCount === 1 ? "" : "s"}` : task.workerCount ? `${task.workerCount} AI session${task.workerCount === 1 ? "" : "s"}` : undefined,
    task.executionCounts.total ? `${task.executionCounts.total} action${task.executionCounts.total === 1 ? "" : "s"}` : undefined,
    task.artifactCount ? `${task.artifactCount} artifact${task.artifactCount === 1 ? "" : "s"}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return {
    taskId: task.taskId,
    label: oneLine(task.goal, 120) ?? "Nimora task",
    description: parts.join(" · ") || oneLine(task.progress?.message, 160) || "Task-owned work session",
    badge: status.badge,
    status: status.status,
    createdAt: Date.parse(task.createdAt),
    updatedAt: Date.parse(task.updatedAt),
    terminal: status.terminal,
  };
}

function markdownText(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function safeWorkspaceRelativePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return undefined;
  const segments = normalized.split("/").filter(Boolean);
  if (!segments.length || segments.some(segment => segment === "." || segment === ".." || segment.includes("\0"))) return undefined;
  return segments.join("/");
}

function metadataNumber(metadata: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string, maxChars: number): string | undefined {
  const value = metadata?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= maxChars ? trimmed : trimmed.slice(0, maxChars);
}

function artifactTerminal(kind: TaskSessionArtifactPresentation["kind"], metadata: Record<string, unknown> | undefined): TaskSessionTerminalPresentation | undefined {
  if (kind !== "terminal") return undefined;
  return {
    terminalId: oneLine(metadataString(metadata, "terminalId", 240), 240),
    commandId: oneLine(metadataString(metadata, "commandId", 240), 240),
    terminalName: oneLine(metadataString(metadata, "terminalName", 240), 240),
    execution: oneLine(metadataString(metadata, "execution", 32), 32),
    status: oneLine(metadataString(metadata, "status", 32), 32),
    cwd: oneLine(metadataString(metadata, "cwd", 1_000), 1_000),
    command: metadataString(metadata, "command", 4_000),
    commandTruncated: metadata?.commandTruncated === true,
    exitCode: metadataNumber(metadata, "exitCode"),
    background: typeof metadata?.background === "boolean" ? metadata.background : undefined,
    openable: metadata?.terminalOpenable === true,
    outputLost: metadata?.outputLost === true,
    hasMore: metadata?.hasMore === true,
    bytesSent: metadataNumber(metadata, "bytesSent"),
  };
}

function artifactContent(metadata: Record<string, unknown> | undefined): { content?: string; truncated: boolean } {
  const value = typeof metadata?.content === "string" ? metadata.content.trim() : "";
  if (!value) return { content: undefined, truncated: metadata?.contentTruncated === true };
  const maxChars = 24_000;
  return {
    content: value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n…[truncated for Work Sessions]`,
    truncated: metadata?.contentTruncated === true || value.length > maxChars,
  };
}

function artifactLocations(metadata: Record<string, unknown> | undefined): TaskSessionArtifactLocation[] {
  if (!Array.isArray(metadata?.locations)) return [];
  return metadata.locations.flatMap(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const path = safeWorkspaceRelativePath(row.path);
    const line = typeof row.line === "number" && Number.isInteger(row.line) && row.line >= 1 ? row.line : undefined;
    if (!path || line === undefined) return [];
    const column = typeof row.column === "number" && Number.isInteger(row.column) && row.column >= 1 ? row.column : undefined;
    return [{
      path,
      line,
      column,
      label: oneLine(typeof row.label === "string" ? row.label : undefined, 240),
    }];
  }).slice(0, 40);
}

function artifactEntries(metadata: Record<string, unknown> | undefined): TaskSessionArtifactEntry[] {
  if (!Array.isArray(metadata?.entries)) return [];
  return metadata.entries.flatMap(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const path = safeWorkspaceRelativePath(row.path);
    const kind = row.kind;
    if (!path || (kind !== "file" && kind !== "folder" && kind !== "link" && kind !== "other")) return [];
    return [{ path, kind }];
  });
}

export function presentTaskSessionArtifacts(detail: TaskCenterTaskDetail): TaskSessionArtifactPresentation[] {
  return detail.artifacts.map(artifact => {
    const metadata = artifact.metadata;
    const files = Array.isArray(metadata?.files)
      ? [...new Set(metadata.files.map(safeWorkspaceRelativePath).filter((value): value is string => Boolean(value)))]
      : [];
    const uri = typeof artifact.uri === "string" && artifact.uri.trim() ? artifact.uri.trim() : undefined;
    const locations = artifactLocations(metadata);
    const entries = artifactEntries(metadata);
    const content = artifactContent(metadata);
    const terminal = artifactTerminal(artifact.kind, metadata);
    return {
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      title: oneLine(artifact.title, 240) ?? artifact.kind,
      uri,
      files,
      additions: metadataNumber(metadata, "additions"),
      deletions: metadataNumber(metadata, "deletions"),
      diffTruncated: metadata?.diffTruncated === true,
      resultTruncated: metadata?.resultTruncated === true,
      locations,
      locationCount: metadataNumber(metadata, "locationCount"),
      locationsTruncated: metadata?.locationsTruncated === true,
      entries,
      entryCount: metadataNumber(metadata, "entryCount"),
      content: content.content,
      contentLanguage: oneLine(typeof metadata?.contentLanguage === "string" ? metadata.contentLanguage : undefined, 32),
      contentTruncated: content.truncated,
      terminal,
    };
  });
}

export function buildTaskSessionEntryTree(entries: readonly TaskSessionArtifactEntry[]): TaskSessionFileTreeNode[] {
  interface MutableNode {
    name: string;
    children: Map<string, MutableNode>;
    directory: boolean;
  }
  const root = new Map<string, MutableNode>();
  for (const entry of entries) {
    const path = safeWorkspaceRelativePath(entry.path);
    if (!path) continue;
    const segments = path.split("/");
    let children = root;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      let node = children.get(segment);
      if (!node) {
        node = { name: segment, children: new Map(), directory: false };
        children.set(segment, node);
      }
      if (index < segments.length - 1 || entry.kind === "folder") node.directory = true;
      children = node.children;
    }
  }
  const project = (nodes: Map<string, MutableNode>): TaskSessionFileTreeNode[] => [...nodes.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(node => ({ name: node.name, ...(node.directory || node.children.size ? { children: project(node.children) } : {}) }));
  return project(root);
}

export function buildTaskSessionFileTree(paths: readonly string[]): TaskSessionFileTreeNode[] {
  interface MutableNode {
    name: string;
    children: Map<string, MutableNode>;
  }
  const root = new Map<string, MutableNode>();
  for (const candidate of paths) {
    const path = safeWorkspaceRelativePath(candidate);
    if (!path) continue;
    let children = root;
    for (const segment of path.split("/")) {
      let node = children.get(segment);
      if (!node) {
        node = { name: segment, children: new Map() };
        children.set(segment, node);
      }
      children = node.children;
    }
  }
  const project = (nodes: Map<string, MutableNode>): TaskSessionFileTreeNode[] => [...nodes.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(node => ({ name: node.name, ...(node.children.size ? { children: project(node.children) } : {}) }));
  return project(root);
}

export function formatTaskSessionMarkdown(detail: TaskCenterTaskDetail): string {
  const lines: string[] = [];
  const summary = detail.summary;
  lines.push(`## ${markdownText(oneLine(summary.goal, 200), "Nimora Task")}`);
  lines.push("");
  lines.push(`**Status:** ${summary.status.replace(/_/g, " ")}`);
  if (summary.projectId && summary.missionId) {
    lines.push(`**Project:** ${oneLine(summary.projectId, 240) ?? summary.projectId}`);
    const missionParts = [
      oneLine(summary.missionId, 240) ?? summary.missionId,
      summary.plane,
      oneLine(summary.missionType, 160),
    ].filter((value): value is string => Boolean(value));
    lines.push(`**Mission:** ${missionParts.join(" · ")}`);
    if (summary.parentMissionId) lines.push(`**Parent Mission:** ${oneLine(summary.parentMissionId, 240) ?? summary.parentMissionId}`);
    else if (summary.rootMissionId === summary.missionId) lines.push("**Mission role:** root");
  }
  if (detail.progress) {
    const percent = typeof detail.progress.percent === "number" ? ` · ${Math.round(detail.progress.percent)}%` : "";
    const phase = detail.progress.phase ? ` · ${oneLine(detail.progress.phase, 80)}` : "";
    lines.push(`**Progress:** ${oneLine(detail.progress.message, 300) ?? "Working"}${phase}${percent}`);
  }

  if (detail.todos.length) {
    lines.push("", "### Todos");
    for (const todo of detail.todos) {
      const marker = todo.status === "completed" ? "x" : " ";
      const suffix = todo.status === "in_progress" ? " *(in progress)*" : "";
      lines.push(`- [${marker}] ${oneLine(todo.title, 240) ?? todo.id}${suffix}`);
    }
  }

  if (detail.workers.length) {
    lines.push("", "### AI Workers");
    for (const worker of detail.workers) {
      const label = oneLine(worker.model, 120) ?? oneLine(worker.workerId, 120) ?? "AI worker";
      lines.push(`- ${label}${worker.detachedAt ? " · finished" : " · active"}`);
    }
  }

  const artifacts = presentTaskSessionArtifacts(detail);
  if (artifacts.length) {
    lines.push("", "### Artifacts");
    for (const artifact of artifacts) {
      const stats = [
        artifact.files.length ? `${artifact.files.length} file${artifact.files.length === 1 ? "" : "s"}` : undefined,
        artifact.additions !== undefined ? `+${artifact.additions}` : undefined,
        artifact.deletions !== undefined ? `-${artifact.deletions}` : undefined,
        artifact.diffTruncated ? "diff summary truncated" : undefined,
        artifact.resultTruncated ? "results truncated" : undefined,
        artifact.locationCount !== undefined ? `${artifact.locationCount} location${artifact.locationCount === 1 ? "" : "s"}` : undefined,
        artifact.locationsTruncated ? "location links truncated" : undefined,
        artifact.entryCount !== undefined ? `${artifact.entryCount} entr${artifact.entryCount === 1 ? "y" : "ies"}` : undefined,
        artifact.contentTruncated ? "content truncated" : undefined,
      ].filter((value): value is string => Boolean(value));
      lines.push(`- **${artifact.title}** · ${artifact.kind}${stats.length ? ` · ${stats.join(" · ")}` : ""}`);
      for (const file of artifact.files.slice(0, 12)) lines.push(`  - \`${file}\``);
      if (artifact.files.length > 12) lines.push(`  - …and ${artifact.files.length - 12} more`);
    }
  }

  if (detail.timeline.length) {
    lines.push("", "### Timeline");
    for (const entry of detail.timeline.slice(-40)) {
      if (entry.kind === "progress") {
        const percent = typeof entry.percent === "number" ? ` (${Math.round(entry.percent)}%)` : "";
        lines.push(`- **Progress:** ${oneLine(entry.message, 300) ?? "Updated"}${percent}`);
      } else if (entry.kind === "interaction") {
        lines.push(`- **${entry.title}:** ${entry.status}${entry.model ? ` · ${oneLine(entry.model, 100)}` : ""}`);
      } else if (entry.kind === "execution") {
        const delivery = entry.deliveryStatus === "pending"
          ? " · result pending delivery"
          : entry.deliveryStatus === "delivered"
            ? " · delivered"
            : entry.deliveryStatus === "abandoned"
              ? " · delivery abandoned / no replay"
              : "";
        const detailText = entry.error ? ` · ${oneLine(entry.error, 240)}` : entry.resultSummary ? ` · ${oneLine(entry.resultSummary, 240)}` : "";
        lines.push(`- **${oneLine(entry.title, 120) ?? "Action"}:** ${entry.status}${delivery}${detailText}`);
      } else {
        lines.push(`- **Artifact:** ${oneLine(entry.title, 240) ?? entry.artifactKind}`);
      }
    }
  }

  return lines.join("\n").slice(0, 24_000);
}

function decisionScopeText(scope: ProjectMissionPresentationProject["committedDecisions"][number]["content"]["scope"]): string {
  return scope.kind === "project" ? "project" : `missions: ${scope.missionIds.join(", ")}`;
}

function boundedSection(title: string, groups: readonly (readonly string[])[], maxChars: number, omittedLabel: string): string {
  const lines = [`### ${title}`];
  let omitted = 0;
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index];
    const candidate = [...lines, ...group].join("\n");
    if (candidate.length <= maxChars) {
      lines.push(...group);
      continue;
    }
    omitted = groups.length - index;
    break;
  }
  if (omitted) lines.push(`- _${omitted} additional ${omittedLabel} omitted by bounded native presentation._`);
  return lines.join("\n");
}

function boundedDetailGroup(lines: readonly string[], maxChars: number, label: string): string[] {
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = [...result, lines[index]].join("\n");
    if (candidate.length <= maxChars) {
      result.push(lines[index]);
      continue;
    }
    result.push(`  - _${label} detail truncated by bounded native presentation._`);
    break;
  }
  return result;
}

export function formatProjectMissionSessionMarkdown(
  detail: TaskCenterTaskDetail,
  projection: ProjectMissionPresentation,
  mission: ProjectMissionPresentationMission,
): string {
  const project = projectForMission(projection, mission);
  const projectMissions = projection.missions.filter(candidate => candidate.projectId === mission.projectId);
  const projectIssues = projection.integrityIssues.filter(issue => issue.projectId === mission.projectId);
  const sections: string[] = [];

  sections.push(`## ${markdownText(oneLine(mission.goal, 200), mission.missionType || "Mission")}`);

  const projectGroups: string[][] = [[`- **Project id:** ${oneLine(mission.projectId, 240) ?? mission.projectId}`]];
  if (!project || project.metadataState === "unavailable") {
    projectGroups.push(["- **Project metadata:** unavailable"]);
    if (projection.availability.projects.status === "unavailable") {
      projectGroups.push([`- **Owner detail:** ${oneLine(projection.availability.projects.detail, 500) ?? "ProjectStore unavailable"}`]);
    }
  } else if (project.metadataState === "missing") {
    projectGroups.push(["- **Project metadata:** missing"]);
  } else {
    projectGroups.push(
      [`- **Title:** ${oneLine(project.title, 300) ?? "(untitled)"}`],
      [`- **Goal:** ${oneLine(project.goal, 600) ?? "(not set)"}`],
      [`- **Workspace:** ${oneLine(project.workspace, 600) ?? "(not set)"}`],
    );
  }
  sections.push(boundedSection("Project", projectGroups, 2_000, "Project details"));

  const decisionGroups: string[][] = [];
  if (!project || project.decisionsState === "unavailable") {
    decisionGroups.push(["- Committed Decision state unavailable because ProjectStore is unavailable."]);
  } else if (project.decisionsState === "missing-project") {
    decisionGroups.push(["- Committed Decision state unavailable because the referenced Project is missing."]);
  } else if (!project.committedDecisions.length) {
    decisionGroups.push(["- No committed Project Decisions."]);
  } else {
    for (const decision of project.committedDecisions) {
      decisionGroups.push([`- **${oneLine(decision.content.kind, 40)}:** ${oneLine(decision.content.summary, 500) ?? decision.decisionId} · ${decisionScopeText(decision.content.scope)} · id ${oneLine(decision.decisionId, 160) ?? decision.decisionId}`]);
    }
  }
  sections.push(boundedSection("Current Committed Decisions", decisionGroups, 3_000, "Committed Decisions"));

  sections.push(boundedSection("Mission", [[
    `- **Role:** ${mission.semanticRole}`,
    `- **Mission id:** ${oneLine(mission.missionId, 240) ?? mission.missionId}`,
    `- **Type:** ${oneLine(mission.missionType, 200) ?? mission.missionType}`,
    `- **Goal:** ${oneLine(mission.goal, 600) ?? "(not set)"}`,
    `- **Task work status:** ${taskStatusText(mission.taskStatus)}`,
    `- **Mission finalized:** ${mission.finalized ? "yes" : "no"}`,
    `- **Mission lifecycle:** ${mission.finalization?.state ?? "not finalized"}`,
    `- **Root Mission:** ${oneLine(mission.rootMissionId, 240) ?? mission.rootMissionId}`,
    `- **Parent Mission:** ${mission.parentMissionId ? oneLine(mission.parentMissionId, 240) ?? mission.parentMissionId : "none"}`,
  ]], 2_500, "Mission details"));

  const hierarchyGroups = projectMissions.map(candidate => {
    const relation = candidate.parentMissionId ? `parent ${candidate.parentMissionId}` : candidate.missionId === candidate.rootMissionId ? "root" : "parent missing";
    const depth = candidate.hierarchyDepth === undefined ? "depth unknown" : `depth ${candidate.hierarchyDepth}`;
    return [`- ${candidate.semanticRole} · ${oneLine(candidate.goal, 220) ?? candidate.missionType} · ${candidate.missionId} · ${relation} · ${depth}`];
  });
  sections.push(boundedSection("Project Mission hierarchy", hierarchyGroups, 3_000, "Missions"));

  const relationGroups: string[][] = [];
  if (!project || project.collaborationState === "unavailable") {
    relationGroups.push(["- Collaboration unavailable; absence of relations is not asserted."]);
    if (projection.availability.collaboration.status === "unavailable") {
      relationGroups.push([`- **Owner detail:** ${oneLine(projection.availability.collaboration.detail, 500) ?? "MissionCollaborationStore unavailable"}`]);
    }
  } else if (!project.relations.length) {
    relationGroups.push(["- No explicit collaboration relations."]);
  } else {
    for (const relation of project.relations) {
      relationGroups.push([`- ${relation.type}: ${relation.sourceMissionId} → ${relation.targetMissionId} · id ${relation.relationId}`]);
    }
  }
  sections.push(boundedSection("Explicit collaboration relations", relationGroups, 2_500, "relations"));

  const problemGroups: string[][] = [];
  if (!project || project.collaborationState === "unavailable") {
    problemGroups.push(["- Collaboration unavailable; absence of Problems is not asserted."]);
  } else if (!project.problems.length) {
    problemGroups.push(["- No Problems."]);
  } else {
    const relevant = project.problems.filter(problem => problem.sourceMissionId === mission.missionId || problem.targetMissionId === mission.missionId);
    const relevantIds = new Set(relevant.map(problem => problem.exchangeId));
    const orderedProblems = [...relevant, ...project.problems.filter(problem => !relevantIds.has(problem.exchangeId))];
    const openCount = project.problems.filter(problem => problem.answerState === "Open").length;
    const answeredCount = project.problems.length - openCount;
    const blockingCount = project.problems.filter(problem => problem.blocking).length;
    problemGroups.push([`- **Problem summary:** ${project.problems.length} total · ${openCount} Open · ${answeredCount} Answered · ${blockingCount} Blocking`]);
    for (const problem of orderedProblems) {
      const block = [
        `- **${problem.answerState}** · Blocking: ${problem.blocking ? "yes" : "no"} · Problem ${problem.exchangeId}`,
        `  - Source: ${problem.sourceMissionId}${problem.targetMissionId ? ` → ${problem.targetMissionId}` : ""}`,
      ];
      for (const answer of problem.answers.slice(0, 12)) {
        block.push(`  - Answer ${answer.exchangeId}: ${oneLine(answer.answer, 500) ?? "(empty)"}`);
        if (answer.limitations !== undefined) block.push(`    - Limitations: ${oneLine(answer.limitations, 500) ?? "(empty)"}`);
        for (const evidence of answer.evidence.slice(0, 12)) {
          block.push(`    - Answer Evidence ${evidence.exchangeId}${evidence.kind === "Evidence" ? `: ${oneLine(evidence.payload.summary, 500) ?? "(empty)"}` : ""}`);
        }
        for (const evidenceId of answer.missingEvidenceExchangeIds.slice(0, 12)) {
          block.push(`    - Answer Evidence ${evidenceId}: unavailable / not accepted for this Project`);
        }
      }
      for (const evidence of problem.evidence.slice(0, 12)) {
        block.push(`  - Problem Evidence ${evidence.exchangeId}${evidence.kind === "Evidence" ? `: ${oneLine(evidence.payload.summary, 500) ?? "(empty)"}` : ""}`);
      }
      for (const evidenceId of problem.missingEvidenceExchangeIds.slice(0, 12)) block.push(`  - Problem Evidence ${evidenceId}: unavailable / not accepted for this Project`);
      problemGroups.push(boundedDetailGroup(block, 1_800, `Problem ${problem.exchangeId}`));
    }
  }
  sections.push(boundedSection("Problems", problemGroups, 7_000, "Problems"));

  if (detail.progress) {
    const percent = typeof detail.progress.percent === "number" ? ` · ${Math.round(detail.progress.percent)}%` : "";
    const phase = detail.progress.phase ? ` · ${oneLine(detail.progress.phase, 80)}` : "";
    sections.push(boundedSection("Progress", [[`- ${oneLine(detail.progress.message, 500) ?? "Working"}${phase}${percent}`]], 1_200, "progress details"));
  }
  if (detail.todos.length) {
    const todoGroups = detail.todos.map(todo => {
      const marker = todo.status === "completed" ? "x" : " ";
      const suffix = todo.status === "in_progress" ? " *(in progress)*" : "";
      return [`- [${marker}] ${oneLine(todo.title, 300) ?? todo.id}${suffix}`];
    });
    sections.push(boundedSection("Todos", todoGroups, 2_500, "todos"));
  }

  const artifacts = presentTaskSessionArtifacts(detail);
  const artifactGroups: string[][] = [];
  if (mission.finalHandoff) {
    artifactGroups.push([`- **Validated final Mission Handoff:** ${oneLine(mission.finalHandoff.title, 240) ?? mission.finalHandoff.artifactId} · ${mission.finalHandoff.kind} · id ${mission.finalHandoff.artifactId}`]);
  } else if (mission.finalization?.handoffRequired) {
    artifactGroups.push(["- **Validated final Mission Handoff:** unavailable / invalid under canonical Handoff validation."]);
  } else {
    artifactGroups.push(["- **Validated final Mission Handoff:** none required / none validated."]);
  }
  if (!artifacts.length) {
    artifactGroups.push(["- No Task artifacts."]);
  } else {
    for (const artifact of artifacts) {
      if (mission.finalHandoff?.artifactId === artifact.artifactId) continue;
      artifactGroups.push([`- **Artifact:** ${artifact.title} · ${artifact.kind} · id ${artifact.artifactId}`]);
    }
  }
  sections.push(boundedSection("Artifacts", artifactGroups, 3_000, "artifacts"));

  const executionGroups: string[][] = [];
  const unknownExecutions = mission.executions.filter(execution => execution.status === "unknown").length;
  const unknownDeliveries = mission.executions.filter(execution => execution.deliveryStatus === "unknown").length;
  executionGroups.push([`- **UNKNOWN executions:** ${unknownExecutions} · **UNKNOWN deliveries:** ${unknownDeliveries}`]);
  if (!mission.executions.length) {
    executionGroups.push(["- No executions."]);
  } else {
    const orderedExecutions = [
      ...mission.executions.filter(execution => execution.status === "unknown" || execution.deliveryStatus === "unknown"),
      ...mission.executions.filter(execution => execution.status !== "unknown" && execution.deliveryStatus !== "unknown"),
    ];
    for (const execution of orderedExecutions) {
      const result = execution.error ? ` · ${oneLine(execution.error, 300)}` : execution.resultSummary ? ` · ${oneLine(execution.resultSummary, 300)}` : "";
      executionGroups.push([`- ${execution.toolName} · execution ${execution.status} · delivery ${execution.deliveryStatus}${result}`]);
    }
  }
  if (!mission.workers.length) {
    executionGroups.push(["- Workers: none recorded."]);
  } else {
    executionGroups.push(["- **Workers (secondary diagnostics):**"]);
    for (const worker of mission.workers) {
      const lifecycle = worker.retiredAt ? "retired" : worker.detachedAt ? "detached" : "attached";
      executionGroups.push([`  - ${worker.workerId}${worker.model ? ` · ${oneLine(worker.model, 120)}` : ""} · managed session ${oneLine(worker.managedSessionId, 160) ?? worker.managedSessionId} · ${lifecycle}`]);
    }
  }
  sections.push(boundedSection("Execution diagnostics", executionGroups, 4_000, "execution/Worker diagnostics"));

  if (projectIssues.length) {
    const relevantIssues = projectIssues.filter(issue => issue.missionId === mission.missionId);
    const relevantIssueKeys = new Set(relevantIssues.map(issue => `${issue.code}:${issue.missionId ?? ""}:${issue.relatedId ?? ""}`));
    const orderedIssues = [...relevantIssues, ...projectIssues.filter(issue => !relevantIssueKeys.has(`${issue.code}:${issue.missionId ?? ""}:${issue.relatedId ?? ""}`))];
    const issueGroups = orderedIssues.map(issue => [`- **${issue.code}:** ${oneLine(issue.detail, 600) ?? issue.detail}`]);
    sections.push(boundedSection("Integrity diagnostics", issueGroups, 3_000, "integrity diagnostics"));
  }

  return sections.join("\n\n");
}
