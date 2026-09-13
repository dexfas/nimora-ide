import type {
  TaskArtifactRef,
  TaskDeliveryStatus,
  TaskExecutionStatus,
  TaskInteractionOutcome,
  TaskProgress,
  TaskSnapshot,
  TaskStatus,
  TaskTodo,
  TaskWorkerSessionRef,
} from "./task-contract.js";

export interface TaskCenterTodoCounts {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
}

export interface TaskCenterExecutionCounts {
  total: number;
  running: number;
  succeeded: number;
  failed: number;
  unknown: number;
  pendingDelivery: number;
}

export interface TaskCenterTaskSummary {
  version: 1;
  taskId: string;
  status: TaskStatus;
  sourceKind: TaskSnapshot["source"]["kind"];
  workspace?: string;
  goal?: string;
  createdAt: string;
  updatedAt: string;
  todoCounts: TaskCenterTodoCounts;
  progress?: TaskProgress;
  workerCount: number;
  activeWorkerCount: number;
  executionCounts: TaskCenterExecutionCounts;
  artifactCount: number;
}

export interface TaskCenterWorker {
  managedSessionId: string;
  workerId: string;
  model?: string;
  attachedAt: string;
  detachedAt?: string;
}

export type TaskCenterTimelineEntry =
  | {
      id: string;
      kind: "progress";
      at: string;
      title: string;
      message: string;
      phase?: string;
      percent?: number;
      todoId?: string;
    }
  | {
      id: string;
      kind: "interaction";
      at: string;
      title: string;
      surface: "native-chat" | "bridge";
      status: TaskInteractionOutcome | "running";
      model?: string;
      durationMs?: number;
      error?: string;
    }
  | {
      id: string;
      kind: "execution";
      at: string;
      title: string;
      status: TaskExecutionStatus;
      deliveryStatus: TaskDeliveryStatus;
      capabilityId?: string;
      risk?: string;
      durationMs?: number;
      error?: string;
      resultSummary?: string;
    }
  | {
      id: string;
      kind: "artifact";
      at: string;
      title: string;
      artifactKind: TaskArtifactRef["kind"];
      executionId?: string;
    };

export interface TaskCenterTaskDetail {
  summary: TaskCenterTaskSummary;
  todos: TaskTodo[];
  progress?: TaskProgress;
  workers: TaskCenterWorker[];
  timeline: TaskCenterTimelineEntry[];
  artifacts: TaskArtifactRef[];
}

export interface TaskCenterState {
  version: 1;
  tasks: TaskCenterTaskSummary[];
  selectedTaskId?: string;
  selected?: TaskCenterTaskDetail;
}

function todoCounts(todos: readonly TaskTodo[]): TaskCenterTodoCounts {
  return {
    total: todos.length,
    pending: todos.filter(todo => todo.status === "pending").length,
    inProgress: todos.filter(todo => todo.status === "in_progress").length,
    completed: todos.filter(todo => todo.status === "completed").length,
  };
}

function executionCounts(task: TaskSnapshot): TaskCenterExecutionCounts {
  const executions = Object.values(task.executions);
  return {
    total: executions.length,
    running: executions.filter(execution => execution.status === "requested" || execution.status === "executing").length,
    succeeded: executions.filter(execution => execution.status === "succeeded").length,
    failed: executions.filter(execution => execution.status === "failed").length,
    unknown: executions.filter(execution => execution.status === "unknown").length,
    pendingDelivery: executions.filter(execution => execution.deliveryStatus === "pending").length,
  };
}

function projectSummary(task: TaskSnapshot): TaskCenterTaskSummary {
  const workers = Object.values(task.workerSessions);
  return {
    version: 1,
    taskId: task.taskId,
    status: task.status,
    sourceKind: task.source.kind,
    workspace: task.source.workspace,
    goal: task.goal,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    todoCounts: todoCounts(task.todos),
    progress: task.progress ? structuredClone(task.progress) : undefined,
    workerCount: workers.length,
    activeWorkerCount: workers.filter(worker => !worker.detachedAt).length,
    executionCounts: executionCounts(task),
    artifactCount: task.artifacts.length,
  };
}

function projectWorker(worker: TaskWorkerSessionRef): TaskCenterWorker {
  return {
    managedSessionId: worker.managedSessionId,
    workerId: worker.workerId,
    model: worker.model,
    attachedAt: worker.attachedAt,
    detachedAt: worker.detachedAt,
  };
}

function projectTimeline(task: TaskSnapshot): TaskCenterTimelineEntry[] {
  const timeline: TaskCenterTimelineEntry[] = [];
  if (task.progress) {
    timeline.push({
      id: `progress:${task.progress.at}`,
      kind: "progress",
      at: task.progress.at,
      title: task.progress.phase || "Progress",
      message: task.progress.message,
      phase: task.progress.phase,
      percent: task.progress.percent,
      todoId: task.progress.todoId,
    });
  }
  for (const interaction of Object.values(task.interactions)) {
    timeline.push({
      id: `interaction:${interaction.interactionId}`,
      kind: "interaction",
      at: interaction.startedAt,
      title: interaction.surface === "native-chat" ? "Chat interaction" : "Bridge interaction",
      surface: interaction.surface,
      status: interaction.outcome ?? "running",
      model: interaction.model,
      durationMs: interaction.durationMs,
      error: interaction.error,
    });
  }
  for (const execution of Object.values(task.executions)) {
    timeline.push({
      id: `execution:${execution.executionId}`,
      kind: "execution",
      at: execution.requestedAt,
      title: execution.toolName,
      status: execution.status,
      deliveryStatus: execution.deliveryStatus,
      capabilityId: execution.capabilityId,
      risk: execution.risk,
      durationMs: execution.durationMs,
      error: execution.error,
      resultSummary: execution.resultSummary,
    });
  }
  for (const artifact of task.artifacts) {
    timeline.push({
      id: `artifact:${artifact.artifactId}`,
      kind: "artifact",
      at: artifact.createdAt,
      title: artifact.title,
      artifactKind: artifact.kind,
      executionId: artifact.executionId,
    });
  }
  return timeline.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

function projectDetail(task: TaskSnapshot): TaskCenterTaskDetail {
  return {
    summary: projectSummary(task),
    todos: task.todos.map(todo => ({ ...todo })),
    progress: task.progress ? structuredClone(task.progress) : undefined,
    workers: Object.values(task.workerSessions)
      .map(projectWorker)
      .sort((a, b) => a.attachedAt.localeCompare(b.attachedAt) || a.managedSessionId.localeCompare(b.managedSessionId)),
    timeline: projectTimeline(task),
    artifacts: task.artifacts.map(artifact => structuredClone(artifact)),
  };
}

export function projectTaskCenterState(tasks: readonly TaskSnapshot[], selectedTaskId?: string): TaskCenterState {
  const ordered = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.taskId.localeCompare(b.taskId));
  const summaries = ordered.map(projectSummary);
  const selectedTask = selectedTaskId ? ordered.find(task => task.taskId === selectedTaskId) : ordered[0];
  return {
    version: 1,
    tasks: summaries,
    selectedTaskId: selectedTask?.taskId,
    selected: selectedTask ? projectDetail(selectedTask) : undefined,
  };
}
