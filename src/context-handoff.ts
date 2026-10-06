import type { MissionPlane, TaskArtifactRef, TaskExecution, TaskSnapshot, TaskTodo } from "./task-contract.js";

export interface ContextHandoffOptions {
  targetWorkerId?: string;
  sourceManagedSessionId?: string;
  generatedAt?: string;
  maxChars?: number;
  maxTodos?: number;
  maxArtifacts?: number;
  maxExecutions?: number;
  maxWorkerSessions?: number;
}

export interface ContextHandoffExecution {
  executionId: string;
  toolName: string;
  capabilityId?: string;
  status: TaskExecution["status"];
  deliveryStatus: TaskExecution["deliveryStatus"];
  resultSummary?: string;
  error?: string;
}

export interface ContextHandoffArtifact {
  artifactId: string;
  kind: TaskArtifactRef["kind"];
  title: string;
  uri?: string;
}

export interface ContextHandoffWorker {
  managedSessionId: string;
  workerId: string;
  model?: string;
  attachedAt: string;
  detachedAt?: string;
}

export interface ContextHandoffPackage {
  version: 1;
  taskId: string;
  projectId?: string;
  missionId?: string;
  missionPlane?: MissionPlane;
  missionType?: string;
  generatedAt: string;
  targetWorkerId?: string;
  sourceManagedSessionId?: string;
  status: TaskSnapshot["status"];
  goal?: string;
  summary?: string;
  constraints: string[];
  decisions: string[];
  relevantFiles: string[];
  progress?: TaskSnapshot["progress"];
  todos: TaskTodo[];
  artifacts: ContextHandoffArtifact[];
  recentExecutions: ContextHandoffExecution[];
  workerSessions: ContextHandoffWorker[];
  omitted: string[];
}

export interface RenderedContextHandoff {
  package: ContextHandoffPackage;
  text: string;
  truncatedSections: string[];
}

export interface ContextHandoffRenderSection {
  name: string;
  lines: readonly string[];
}

export interface StructuredContextHandoffRenderInput {
  title: string;
  preambleLines?: readonly string[];
  sections: readonly ContextHandoffRenderSection[];
}

const DEFAULT_MAX_CHARS = 12_000;

function recentExecutions(snapshot: TaskSnapshot, limit: number): ContextHandoffExecution[] {
  return Object.values(snapshot.executions)
    .sort((a, b) => (b.finishedAt ?? b.startedAt ?? b.requestedAt).localeCompare(a.finishedAt ?? a.startedAt ?? a.requestedAt))
    .slice(0, limit)
    .map(execution => ({
      executionId: execution.executionId,
      toolName: execution.toolName,
      capabilityId: execution.capabilityId,
      status: execution.status,
      deliveryStatus: execution.deliveryStatus,
      resultSummary: execution.resultSummary,
      error: execution.error,
    }));
}

function recentArtifacts(snapshot: TaskSnapshot, limit: number): ContextHandoffArtifact[] {
  return [...snapshot.artifacts]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit)
    .map(artifact => ({
      artifactId: artifact.artifactId,
      kind: artifact.kind,
      title: artifact.title,
      uri: artifact.uri,
    }));
}

function recentWorkers(snapshot: TaskSnapshot, limit: number): ContextHandoffWorker[] {
  return Object.values(snapshot.workerSessions)
    .sort((a, b) => b.attachedAt.localeCompare(a.attachedAt))
    .slice(0, limit)
    .map(worker => ({
      managedSessionId: worker.managedSessionId,
      workerId: worker.workerId,
      model: worker.model,
      attachedAt: worker.attachedAt,
      detachedAt: worker.detachedAt,
    }));
}

export function buildContextHandoffPackage(snapshot: TaskSnapshot, options: ContextHandoffOptions = {}): ContextHandoffPackage {
  const maxTodos = Math.max(0, options.maxTodos ?? 24);
  const maxArtifacts = Math.max(0, options.maxArtifacts ?? 12);
  const maxExecutions = Math.max(0, options.maxExecutions ?? 12);
  const maxWorkerSessions = Math.max(0, options.maxWorkerSessions ?? 8);
  const todos = snapshot.todos.slice(0, maxTodos).map(todo => ({ ...todo }));
  const artifacts = recentArtifacts(snapshot, maxArtifacts);
  const executions = recentExecutions(snapshot, maxExecutions);
  const workers = recentWorkers(snapshot, maxWorkerSessions);
  const omitted: string[] = [];
  if (snapshot.todos.length > todos.length) omitted.push(`todos:${snapshot.todos.length - todos.length}`);
  if (snapshot.artifacts.length > artifacts.length) omitted.push(`artifacts:${snapshot.artifacts.length - artifacts.length}`);
  if (Object.keys(snapshot.executions).length > executions.length) omitted.push(`executions:${Object.keys(snapshot.executions).length - executions.length}`);
  if (Object.keys(snapshot.workerSessions).length > workers.length) omitted.push(`workerSessions:${Object.keys(snapshot.workerSessions).length - workers.length}`);

  return {
    version: 1,
    taskId: snapshot.taskId,
    projectId: snapshot.mission?.projectId,
    missionId: snapshot.mission ? snapshot.taskId : undefined,
    missionPlane: snapshot.mission?.plane,
    missionType: snapshot.mission?.missionType,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    targetWorkerId: options.targetWorkerId,
    sourceManagedSessionId: options.sourceManagedSessionId,
    status: snapshot.status,
    goal: snapshot.goal,
    summary: snapshot.context.summary,
    constraints: [...snapshot.context.constraints],
    decisions: [...snapshot.context.decisions],
    relevantFiles: [...snapshot.context.relevantFiles],
    progress: snapshot.progress ? { ...snapshot.progress } : undefined,
    todos,
    artifacts,
    recentExecutions: executions,
    workerSessions: workers,
    omitted,
  };
}

function bullets(values: readonly string[]): string[] {
  return values.map(value => `- ${value}`);
}

function formatExecution(execution: ContextHandoffExecution): string {
  const detail = execution.resultSummary ?? execution.error;
  return `- ${execution.toolName} [${execution.status}/${execution.deliveryStatus}]${detail ? ` — ${detail}` : ""}`;
}

function formatWorker(worker: ContextHandoffWorker): string {
  const lifecycle = worker.detachedAt ? `detached ${worker.detachedAt}` : "attached";
  return `- ${worker.workerId}${worker.model ? ` (${worker.model})` : ""} — ${lifecycle}`;
}

function currentLength(parts: readonly string[]): number {
  return parts.reduce((sum, value) => sum + value.length, 0);
}

function appendSection(parts: string[], name: string, lines: readonly string[], budget: number, truncatedSections: string[]): void {
  if (!lines.length) return;
  const header = `## ${name}\n`;
  const body = `${lines.join("\n")}\n\n`;
  const remaining = budget - currentLength(parts);
  if (remaining <= header.length + 4) {
    truncatedSections.push(name);
    return;
  }
  if (header.length + body.length <= remaining) {
    parts.push(header, body);
    return;
  }
  const available = Math.max(0, remaining - header.length - 2);
  parts.push(header, `${body.slice(0, available).trimEnd()}…\n`);
  truncatedSections.push(name);
}

/**
 * Shared provider-neutral hard-containment renderer. Callers that need semantic
 * item atomicity should pre-select whole items so this guard never becomes the
 * first place an authoritative fact is shortened.
 */
export function renderStructuredContextHandoff(
  input: StructuredContextHandoffRenderInput,
  maxChars = DEFAULT_MAX_CHARS,
): { text: string; truncatedSections: string[] } {
  const budget = Math.max(1, Math.floor(maxChars));
  const parts: string[] = [`# ${input.title}\n`];
  if (input.preambleLines?.length) parts.push(`${input.preambleLines.join("\n")}\n\n`);
  const truncatedSections: string[] = [];
  for (const section of input.sections) {
    appendSection(parts, section.name, section.lines, budget, truncatedSections);
  }
  return { text: parts.join("").slice(0, budget), truncatedSections };
}

export function renderContextHandoff(pkg: ContextHandoffPackage, maxChars = DEFAULT_MAX_CHARS): { text: string; truncatedSections: string[] } {
  return renderStructuredContextHandoff({
    title: "Nimora Task Handoff",
    preambleLines: [
      `Task: ${pkg.taskId}`,
      ...(pkg.projectId ? [`Project: ${pkg.projectId}`] : []),
      ...(pkg.missionId ? [`Mission: ${pkg.missionId}${pkg.missionPlane ? ` · ${pkg.missionPlane}` : ""}${pkg.missionType ? ` · ${pkg.missionType}` : ""}`] : []),
      `Status: ${pkg.status}`,
      ...(pkg.targetWorkerId ? [`Target worker: ${pkg.targetWorkerId}`] : []),
    ],
    sections: [
      { name: "Goal", lines: pkg.goal ? [pkg.goal] : [] },
      { name: "Context summary", lines: pkg.summary ? [pkg.summary] : [] },
      { name: "Constraints", lines: bullets(pkg.constraints) },
      { name: "Decisions", lines: bullets(pkg.decisions) },
      { name: "Relevant files", lines: bullets(pkg.relevantFiles) },
      { name: "Current progress", lines: pkg.progress ? [
        `${pkg.progress.phase ? `${pkg.progress.phase}: ` : ""}${pkg.progress.message}${typeof pkg.progress.percent === "number" ? ` (${pkg.progress.percent}%)` : ""}`,
      ] : [] },
      { name: "Todos", lines: pkg.todos.map(todo => `- [${todo.status}] ${todo.title}`) },
      { name: "Recent artifacts", lines: pkg.artifacts.map(artifact => `- ${artifact.kind}: ${artifact.title}${artifact.uri ? ` — ${artifact.uri}` : ""}`) },
      { name: "Recent executions", lines: pkg.recentExecutions.map(formatExecution) },
      { name: "Worker history", lines: pkg.workerSessions.map(formatWorker) },
      { name: "Omitted by item limits", lines: bullets(pkg.omitted) },
    ],
  }, maxChars);
}

export function buildRenderedContextHandoff(snapshot: TaskSnapshot, options: ContextHandoffOptions = {}): RenderedContextHandoff {
  const pkg = buildContextHandoffPackage(snapshot, options);
  const rendered = renderContextHandoff(pkg, options.maxChars ?? DEFAULT_MAX_CHARS);
  return { package: pkg, ...rendered };
}
