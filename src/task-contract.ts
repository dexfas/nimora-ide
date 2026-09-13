export type TaskStatus = "draft" | "ready" | "running" | "waiting_user" | "waiting_external" | "completed" | "failed" | "cancelled";
export type TaskSourceKind = "native-chat" | "bridge";
export type TaskTodoStatus = "pending" | "in_progress" | "completed";
export type TaskInteractionOutcome = "completed" | "cancelled" | "interrupted" | "blocked" | "error";
export type TaskExecutionStatus = "requested" | "executing" | "succeeded" | "failed" | "unknown";
export type TaskDeliveryStatus = "not-prepared" | "pending" | "delivered" | "unknown";

export interface TaskSource {
  kind: TaskSourceKind;
  /** Stable identity inside the source surface, e.g. Chat session URI or MCP session id. */
  key: string;
  workspace?: string;
}

export interface TaskTodo {
  id: string;
  title: string;
  status: TaskTodoStatus;
}

export interface TaskProgress {
  message: string;
  phase?: string;
  percent?: number;
  todoId?: string;
  at: string;
}

export interface TaskInteraction {
  interactionId: string;
  surface: "native-chat" | "bridge";
  startedAt: string;
  finishedAt?: string;
  mode?: string;
  model?: string;
  outcome?: TaskInteractionOutcome;
  durationMs?: number;
  error?: string;
}

export interface TaskExecution {
  executionId: string;
  toolName: string;
  capabilityId?: string;
  risk?: string;
  argumentsDigest?: string;
  status: TaskExecutionStatus;
  deliveryStatus: TaskDeliveryStatus;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  resultSummary?: string;
  duplicateObservations: number;
}

export interface TaskArtifactRef {
  artifactId: string;
  kind: "changeset" | "file" | "terminal" | "browser" | "report" | "other";
  title: string;
  uri?: string;
  executionId?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface TaskWorkerSessionRef {
  managedSessionId: string;
  workerId: string;
  adapterSessionId: string;
  model?: string;
  attachedAt: string;
  detachedAt?: string;
}

export interface TaskSnapshot {
  version: 1;
  taskId: string;
  source: TaskSource;
  status: TaskStatus;
  goal?: string;
  createdAt: string;
  updatedAt: string;
  todos: TaskTodo[];
  progress?: TaskProgress;
  interactions: Record<string, TaskInteraction>;
  workerSessions: Record<string, TaskWorkerSessionRef>;
  executions: Record<string, TaskExecution>;
  artifacts: TaskArtifactRef[];
  eventCount: number;
  lastEventId: string;
}

interface TaskEventBase<T extends string, P> {
  version: 1;
  eventId: string;
  taskId: string;
  at: string;
  type: T;
  payload: P;
}

export type TaskEvent =
  | TaskEventBase<"TaskCreated", { source: TaskSource; goal?: string }>
  | TaskEventBase<"TaskGoalUpdated", { goal: string }>
  | TaskEventBase<"TaskStatusChanged", { status: TaskStatus }>
  | TaskEventBase<"TaskTodosUpdated", { todos: TaskTodo[] }>
  | TaskEventBase<"TaskProgressUpdated", { progress: TaskProgress }>
  | TaskEventBase<"TaskInteractionStarted", { interaction: TaskInteraction }>
  | TaskEventBase<"TaskInteractionFinished", { interactionId: string; outcome: TaskInteractionOutcome; finishedAt: string; durationMs?: number; error?: string }>
  | TaskEventBase<"TaskWorkerAttached", { workerSession: TaskWorkerSessionRef }>
  | TaskEventBase<"TaskWorkerDetached", { managedSessionId: string; detachedAt: string }>
  | TaskEventBase<"TaskExecutionRequested", { execution: TaskExecution }>
  | TaskEventBase<"TaskExecutionStarted", { executionId: string; startedAt: string }>
  | TaskEventBase<"TaskExecutionDuplicateObserved", { executionId: string }>
  | TaskEventBase<"TaskExecutionFinished", { executionId: string; status: "succeeded" | "failed" | "unknown"; finishedAt: string; durationMs?: number; error?: string; resultSummary?: string }>
  | TaskEventBase<"TaskExecutionResultPrepared", { executionId: string }>
  | TaskEventBase<"TaskExecutionDelivered", { executionId: string }>
  | TaskEventBase<"TaskArtifactProduced", { artifact: TaskArtifactRef }>;

function hasRunningWork(interactions: Record<string, TaskInteraction>, executions: Record<string, TaskExecution>): boolean {
  return Object.values(interactions).some(interaction => !interaction.finishedAt)
    || Object.values(executions).some(execution => execution.status === "requested" || execution.status === "executing");
}

function withEventBase(snapshot: TaskSnapshot, event: TaskEvent): TaskSnapshot {
  return {
    ...snapshot,
    updatedAt: event.at,
    eventCount: snapshot.eventCount + 1,
    lastEventId: event.eventId,
  };
}

export function taskSourceIdentity(source: TaskSource): string {
  return `${source.kind}:${source.key}`;
}

export function applyTaskEvent(snapshot: TaskSnapshot | undefined, event: TaskEvent): TaskSnapshot {
  if (event.type === "TaskCreated") {
    if (snapshot) throw new Error(`Task ${event.taskId} was created more than once.`);
    return {
      version: 1,
      taskId: event.taskId,
      source: { ...event.payload.source },
      status: "ready",
      goal: event.payload.goal,
      createdAt: event.at,
      updatedAt: event.at,
      todos: [],
      interactions: {},
      workerSessions: {},
      executions: {},
      artifacts: [],
      eventCount: 1,
      lastEventId: event.eventId,
    };
  }
  if (!snapshot) throw new Error(`Task event ${event.type} arrived before TaskCreated for ${event.taskId}.`);
  if (snapshot.taskId !== event.taskId) throw new Error(`Task event ${event.eventId} targets the wrong task.`);

  const base = withEventBase(snapshot, event);
  switch (event.type) {
    case "TaskGoalUpdated":
      return { ...base, goal: event.payload.goal };
    case "TaskStatusChanged":
      return { ...base, status: event.payload.status };
    case "TaskTodosUpdated":
      return { ...base, todos: event.payload.todos.map(todo => ({ ...todo })) };
    case "TaskProgressUpdated":
      return { ...base, progress: { ...event.payload.progress } };
    case "TaskInteractionStarted":
      return {
        ...base,
        status: "running",
        interactions: { ...base.interactions, [event.payload.interaction.interactionId]: { ...event.payload.interaction } },
      };
    case "TaskInteractionFinished": {
      const current = base.interactions[event.payload.interactionId];
      if (!current) return base;
      const interactions = {
        ...base.interactions,
        [event.payload.interactionId]: {
          ...current,
          outcome: event.payload.outcome,
          finishedAt: event.payload.finishedAt,
          durationMs: event.payload.durationMs,
          error: event.payload.error,
        },
      };
      return {
        ...base,
        status: hasRunningWork(interactions, base.executions) ? "running" : "ready",
        interactions,
      };
    }
    case "TaskWorkerAttached":
      return {
        ...base,
        workerSessions: {
          ...base.workerSessions,
          [event.payload.workerSession.managedSessionId]: { ...event.payload.workerSession },
        },
      };
    case "TaskWorkerDetached": {
      const current = base.workerSessions[event.payload.managedSessionId];
      if (!current) return base;
      return {
        ...base,
        workerSessions: {
          ...base.workerSessions,
          [event.payload.managedSessionId]: { ...current, detachedAt: event.payload.detachedAt },
        },
      };
    }
    case "TaskExecutionRequested":
      return {
        ...base,
        status: "running",
        executions: { ...base.executions, [event.payload.execution.executionId]: { ...event.payload.execution } },
      };
    case "TaskExecutionStarted": {
      const current = base.executions[event.payload.executionId];
      if (!current) return base;
      return {
        ...base,
        executions: {
          ...base.executions,
          [event.payload.executionId]: { ...current, status: "executing", startedAt: event.payload.startedAt },
        },
      };
    }
    case "TaskExecutionDuplicateObserved": {
      const current = base.executions[event.payload.executionId];
      if (!current) return base;
      return {
        ...base,
        executions: {
          ...base.executions,
          [event.payload.executionId]: { ...current, duplicateObservations: current.duplicateObservations + 1 },
        },
      };
    }
    case "TaskExecutionFinished": {
      const current = base.executions[event.payload.executionId];
      if (!current) return base;
      const executions = {
        ...base.executions,
        [event.payload.executionId]: {
          ...current,
          status: event.payload.status,
          finishedAt: event.payload.finishedAt,
          durationMs: event.payload.durationMs,
          error: event.payload.error,
          resultSummary: event.payload.resultSummary,
        },
      };
      return {
        ...base,
        status: hasRunningWork(base.interactions, executions) ? "running" : "ready",
        executions,
      };
    }
    case "TaskExecutionResultPrepared": {
      const current = base.executions[event.payload.executionId];
      if (!current) return base;
      return {
        ...base,
        executions: {
          ...base.executions,
          [event.payload.executionId]: { ...current, deliveryStatus: "pending" },
        },
      };
    }
    case "TaskExecutionDelivered": {
      const current = base.executions[event.payload.executionId];
      if (!current) return base;
      return {
        ...base,
        executions: {
          ...base.executions,
          [event.payload.executionId]: { ...current, deliveryStatus: "delivered" },
        },
      };
    }
    case "TaskArtifactProduced":
      return { ...base, artifacts: [...base.artifacts, { ...event.payload.artifact }] };
    default:
      return base;
  }
}

export function replayTaskEvents(events: readonly TaskEvent[]): TaskSnapshot | undefined {
  let snapshot: TaskSnapshot | undefined;
  for (const event of events) snapshot = applyTaskEvent(snapshot, event);
  return snapshot;
}
