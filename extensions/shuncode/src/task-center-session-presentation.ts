import type { TaskCenterTaskDetail, TaskCenterTaskSummary } from "../../../src/task-center-projection.js";

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

export interface TaskSessionArtifactPresentation {
  artifactId: string;
  kind: TaskCenterTaskDetail["artifacts"][number]["kind"];
  title: string;
  uri?: string;
  files: string[];
  additions?: number;
  deletions?: number;
  diffTruncated: boolean;
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

export function presentTaskSessionArtifacts(detail: TaskCenterTaskDetail): TaskSessionArtifactPresentation[] {
  return detail.artifacts.map(artifact => {
    const metadata = artifact.metadata;
    const files = Array.isArray(metadata?.files)
      ? [...new Set(metadata.files.map(safeWorkspaceRelativePath).filter((value): value is string => Boolean(value)))]
      : [];
    const uri = typeof artifact.uri === "string" && artifact.uri.trim() ? artifact.uri.trim() : undefined;
    return {
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      title: oneLine(artifact.title, 240) ?? artifact.kind,
      uri,
      files,
      additions: metadataNumber(metadata, "additions"),
      deletions: metadataNumber(metadata, "deletions"),
      diffTruncated: metadata?.diffTruncated === true,
    };
  });
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
        const delivery = entry.deliveryStatus === "pending" ? " · result pending delivery" : entry.deliveryStatus === "delivered" ? " · delivered" : "";
        const detailText = entry.error ? ` · ${oneLine(entry.error, 240)}` : entry.resultSummary ? ` · ${oneLine(entry.resultSummary, 240)}` : "";
        lines.push(`- **${oneLine(entry.title, 120) ?? "Action"}:** ${entry.status}${delivery}${detailText}`);
      } else {
        lines.push(`- **Artifact:** ${oneLine(entry.title, 240) ?? entry.artifactKind}`);
      }
    }
  }

  return lines.join("\n").slice(0, 24_000);
}
