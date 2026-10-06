import { createHash } from "node:crypto";

export type TaskStatus = "draft" | "ready" | "running" | "waiting_user" | "waiting_external" | "completed" | "failed" | "cancelled";
export type TaskSourceKind = "native-chat" | "bridge" | "mission";
export type TaskTodoStatus = "pending" | "in_progress" | "completed";
export type TaskInteractionOutcome = "completed" | "cancelled" | "interrupted" | "blocked" | "error";
export type TaskExecutionStatus = "requested" | "executing" | "succeeded" | "failed" | "unknown";
export type TaskDeliveryStatus = "not-prepared" | "pending" | "delivered" | "abandoned" | "unknown";
export type MissionPlane = "coordination" | "cognition" | "practice";

export interface TaskMissionMetadata {
  projectId: string;
  rootMissionId: string;
  parentMissionId?: string;
  plane: MissionPlane;
  missionType: string;
  completionCriteria: string[];
}

export interface TaskMissionFinalization {
  state: "completed" | "archived";
  handoffRequired: boolean;
  handoffArtifactId?: string;
  handoffSourceEventId?: string;
  handoffSourceEventCount?: number;
  handoffContentDigest?: string;
  completedAt: string;
  archivedAt?: string;
}

export interface TaskSource {
  kind: TaskSourceKind;
  /** Stable identity inside the source surface, e.g. Chat session URI, MCP session id, or Mission-owned operation key. */
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

export interface TaskContextState {
  summary?: string;
  constraints: string[];
  decisions: string[];
  relevantFiles: string[];
  updatedAt?: string;
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
  origin?: {
    kind: "worker";
    managedSessionId: string;
    workerId: string;
    inputId: string;
    callId?: string;
  };
  status: TaskExecutionStatus;
  deliveryStatus: TaskDeliveryStatus;
  requestedAt: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  resultSummary?: string;
  resultPayload?: TaskExecutionResultPayload;
  deliveryAbandonedAt?: string;
  deliveryAbandonmentReason?: string;
  duplicateObservations: number;
}

export interface TaskExecutionResultPayload {
  kind: "worker-capability";
  inputId: string;
  callId: string;
  name: string;
  text?: string;
  isError: boolean;
  durationMs?: number;
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
  /** Trusted host runtime provenance for restart-orphan proof. Legacy rows omit these fields. */
  ownerRuntimeIncarnationId?: string;
  ownerProcessId?: number;
  attachedAt: string;
  detachedAt?: string;
  retiredAt?: string;
  retirementReason?: string;
  /**
   * A managed owner may retire because its host process died while the
   * provider-native conversation itself remains healthy and rediscoverable.
   * Absence means ordinary/provider retirement and remains non-rebindable.
   */
  retirementKind?: "orphan-owner-death";
}

export type TaskCapabilityGrantScope = "task" | "worker-session";

export interface TaskCapabilityGrant {
  grantId: string;
  capabilityId: string;
  capabilityVersion: 1;
  scope: TaskCapabilityGrantScope;
  managedSessionId?: string;
  workerSessionAttachedAt?: string;
  grantedAt: string;
  revokedAt?: string;
}

export interface TaskInputAccessPolicy {
  inputId: string;
  managedSessionId: string;
  allowedWorkspacePathPrefixes: string[];
  recordedAt: string;
}

export interface TaskSnapshot {
  version: 1;
  taskId: string;
  source: TaskSource;
  status: TaskStatus;
  goal?: string;
  context: TaskContextState;
  createdAt: string;
  updatedAt: string;
  todos: TaskTodo[];
  progress?: TaskProgress;
  interactions: Record<string, TaskInteraction>;
  workerSessions: Record<string, TaskWorkerSessionRef>;
  capabilityGrants: Record<string, TaskCapabilityGrant>;
  inputAccessPolicies: Record<string, TaskInputAccessPolicy>;
  executions: Record<string, TaskExecution>;
  artifacts: TaskArtifactRef[];
  mission?: TaskMissionMetadata;
  missionFinalization?: TaskMissionFinalization;
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
  | TaskEventBase<"TaskMissionConfigured", { mission: TaskMissionMetadata; adoptedWorkerSessions?: TaskWorkerSessionRef[] }>
  | TaskEventBase<"TaskMissionFinalized", {
      completedAt: string;
      handoffRequired: boolean;
      handoff?: TaskArtifactRef;
      handoffSourceEventId?: string;
      handoffSourceEventCount?: number;
      handoffContentDigest?: string;
    }>
  | TaskEventBase<"TaskMissionArchived", { archivedAt: string }>
  | TaskEventBase<"TaskGoalUpdated", { goal: string }>
  | TaskEventBase<"TaskContextUpdated", { context: TaskContextState }>
  | TaskEventBase<"TaskStatusChanged", { status: TaskStatus }>
  | TaskEventBase<"TaskTodosUpdated", { todos: TaskTodo[] }>
  | TaskEventBase<"TaskProgressUpdated", { progress: TaskProgress }>
  | TaskEventBase<"TaskInteractionStarted", { interaction: TaskInteraction }>
  | TaskEventBase<"TaskInteractionFinished", { interactionId: string; outcome: TaskInteractionOutcome; finishedAt: string; durationMs?: number; error?: string }>
  | TaskEventBase<"TaskWorkerAttached", { workerSession: TaskWorkerSessionRef }>
  | TaskEventBase<"TaskWorkerDetached", { managedSessionId: string; detachedAt: string }>
  | TaskEventBase<"TaskWorkerRetired", { managedSessionId: string; retiredAt: string; reason?: string; retirementKind?: "orphan-owner-death" }>
  | TaskEventBase<"TaskWorkerOrphanRetirementClassified", { managedSessionId: string; classifiedAt: string }>
  | TaskEventBase<"TaskCapabilityGranted", { grant: TaskCapabilityGrant }>
  | TaskEventBase<"TaskCapabilityRevoked", { grantId: string; revokedAt: string }>
  | TaskEventBase<"TaskInputAccessPolicyRecorded", { policy: TaskInputAccessPolicy }>
  | TaskEventBase<"TaskExecutionRequested", { execution: TaskExecution }>
  | TaskEventBase<"TaskExecutionStarted", { executionId: string; startedAt: string }>
  | TaskEventBase<"TaskExecutionDuplicateObserved", { executionId: string }>
  | TaskEventBase<"TaskExecutionFinished", { executionId: string; status: "succeeded" | "failed" | "unknown"; finishedAt: string; durationMs?: number; error?: string; resultSummary?: string }>
  | TaskEventBase<"TaskExecutionResultPrepared", { executionId: string; result?: TaskExecutionResultPayload }>
  | TaskEventBase<"TaskExecutionDelivered", { executionId: string }>
  | TaskEventBase<"TaskExecutionDeliveryAbandoned", { executionId: string; abandonedAt: string; reason: string }>
  | TaskEventBase<"TaskArtifactProduced", { artifact: TaskArtifactRef }>;

function hasRunningWork(interactions: Record<string, TaskInteraction>, executions: Record<string, TaskExecution>): boolean {
  return Object.values(interactions).some(interaction => !interaction.finishedAt)
    || Object.values(executions).some(execution => execution.status === "requested" || execution.status === "executing");
}

function finalHandoffEventIsCoherent(snapshot: TaskSnapshot, event: Extract<TaskEvent, { type: "TaskMissionFinalized" }>): boolean {
  if (!snapshot.mission) return false;
  const handoff = event.payload.handoff;
  if (event.payload.handoffRequired && !handoff) return false;
  if (!handoff) return true;
  if (handoff.kind !== "report" || snapshot.artifacts.some(artifact => artifact.artifactId === handoff.artifactId)) return false;
  if (handoff.metadata?.missionFinalHandoff !== true || handoff.metadata?.missionId !== snapshot.taskId) return false;
  if (handoff.metadata?.projectId !== snapshot.mission.projectId) return false;
  // Any final Handoff must prove the exact Task revision it was rendered from.
  // Legacy Tasks and legal no-Handoff finalizations remain compatible because
  // this contract is only entered when a Handoff artifact is actually present.
  if (typeof event.payload.handoffSourceEventId !== "string" || !event.payload.handoffSourceEventId) return false;
  if (!Number.isInteger(event.payload.handoffSourceEventCount) || (event.payload.handoffSourceEventCount ?? 0) < 1) return false;
  if (typeof handoff.metadata?.sourceTaskEventId !== "string" || !handoff.metadata.sourceTaskEventId) return false;
  if (!Number.isInteger(handoff.metadata?.sourceTaskEventCount) || (handoff.metadata?.sourceTaskEventCount as number) < 1) return false;
  if (event.payload.handoffSourceEventId !== snapshot.lastEventId || handoff.metadata.sourceTaskEventId !== snapshot.lastEventId) return false;
  if (event.payload.handoffSourceEventCount !== snapshot.eventCount || handoff.metadata.sourceTaskEventCount !== snapshot.eventCount) return false;
  if (event.payload.handoffSourceEventId !== handoff.metadata.sourceTaskEventId) return false;
  if (event.payload.handoffSourceEventCount !== handoff.metadata.sourceTaskEventCount) return false;
  const declaredDigest = event.payload.handoffContentDigest;
  const content = handoff.metadata?.content;
  if (typeof declaredDigest !== "string" || typeof content !== "string") return false;
  if (handoff.metadata?.contentDigest !== declaredDigest) return false;
  const actualDigest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (actualDigest !== declaredDigest) return false;
  return true;
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
      context: { constraints: [], decisions: [], relevantFiles: [] },
      createdAt: event.at,
      updatedAt: event.at,
      todos: [],
      interactions: {},
      workerSessions: {},
      capabilityGrants: {},
      inputAccessPolicies: {},
      executions: {},
      artifacts: [],
      eventCount: 1,
      lastEventId: event.eventId,
    };
  }
  if (!snapshot) throw new Error(`Task event ${event.type} arrived before TaskCreated for ${event.taskId}.`);
  if (snapshot.taskId !== event.taskId) throw new Error(`Task event ${event.eventId} targets the wrong task.`);

  // Finalized Mission working facts are frozen. Historical/forged late work
  // events are ignored during replay so they cannot reactivate or downgrade a
  // terminal Mission. Retirement/archive are the only post-completion lifecycle
  // events intentionally allowed to refine terminal lifecycle bookkeeping.
  if (snapshot.missionFinalization
    && event.type !== "TaskWorkerRetired"
    && event.type !== "TaskMissionArchived") {
    return snapshot;
  }

  const base = withEventBase(snapshot, event);
  switch (event.type) {
    case "TaskMissionConfigured":
      return {
        ...base,
        mission: {
          ...event.payload.mission,
          completionCriteria: [...event.payload.mission.completionCriteria],
        },
        workerSessions: {
          ...base.workerSessions,
          ...Object.fromEntries((event.payload.adoptedWorkerSessions ?? []).map(worker => [worker.managedSessionId, { ...worker }])),
        },
      };
    case "TaskMissionFinalized":
      if (!snapshot.mission) return snapshot;
      if (hasRunningWork(snapshot.interactions, snapshot.executions)) return snapshot;
      if (!finalHandoffEventIsCoherent(snapshot, event)) return snapshot;
      return {
        ...base,
        status: "completed",
        missionFinalization: {
          state: "completed",
          handoffRequired: event.payload.handoffRequired,
          handoffArtifactId: event.payload.handoff?.artifactId,
          handoffSourceEventId: event.payload.handoffSourceEventId,
          handoffSourceEventCount: event.payload.handoffSourceEventCount,
          handoffContentDigest: event.payload.handoffContentDigest,
          completedAt: event.payload.completedAt,
        },
        artifacts: event.payload.handoff
          ? [...base.artifacts, { ...event.payload.handoff }]
          : base.artifacts,
      };
    case "TaskMissionArchived": {
      const finalization = snapshot.missionFinalization;
      if (!finalization || finalization.state === "archived") return snapshot;
      if (hasRunningWork(snapshot.interactions, snapshot.executions)) return snapshot;
      if (Object.values(snapshot.workerSessions).some(worker => !worker.retiredAt)) return snapshot;
      return {
        ...base,
        missionFinalization: {
          ...finalization,
          state: "archived",
          archivedAt: event.payload.archivedAt,
        },
      };
    }
    case "TaskGoalUpdated":
      return { ...base, goal: event.payload.goal };
    case "TaskContextUpdated":
      return {
        ...base,
        context: {
          ...event.payload.context,
          constraints: [...event.payload.context.constraints],
          decisions: [...event.payload.context.decisions],
          relevantFiles: [...event.payload.context.relevantFiles],
        },
      };
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
    case "TaskWorkerRetired": {
      const current = base.workerSessions[event.payload.managedSessionId];
      if (!current) return base;
      if (current.retiredAt) return snapshot;
      return {
        ...base,
        workerSessions: {
          ...base.workerSessions,
          [event.payload.managedSessionId]: {
            ...current,
            detachedAt: current.detachedAt ?? event.payload.retiredAt,
            retiredAt: event.payload.retiredAt,
            retirementReason: event.payload.reason,
            retirementKind: event.payload.retirementKind,
          },
        },
      };
    }
    case "TaskWorkerOrphanRetirementClassified": {
      const current = base.workerSessions[event.payload.managedSessionId];
      if (!current?.retiredAt) return base;
      if (current.retirementKind === "orphan-owner-death") return snapshot;
      return {
        ...base,
        workerSessions: {
          ...base.workerSessions,
          [event.payload.managedSessionId]: {
            ...current,
            retirementKind: "orphan-owner-death",
          },
        },
      };
    }
    case "TaskCapabilityGranted":
      return {
        ...base,
        capabilityGrants: {
          ...base.capabilityGrants,
          [event.payload.grant.grantId]: { ...event.payload.grant },
        },
      };
    case "TaskCapabilityRevoked": {
      const current = base.capabilityGrants[event.payload.grantId];
      if (!current) return base;
      return {
        ...base,
        capabilityGrants: {
          ...base.capabilityGrants,
          [event.payload.grantId]: { ...current, revokedAt: event.payload.revokedAt },
        },
      };
    }
    case "TaskInputAccessPolicyRecorded":
      return {
        ...base,
        inputAccessPolicies: {
          ...base.inputAccessPolicies,
          [event.payload.policy.inputId]: {
            ...event.payload.policy,
            allowedWorkspacePathPrefixes: [...event.payload.policy.allowedWorkspacePathPrefixes],
          },
        },
      };
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
          [event.payload.executionId]: {
            ...current,
            deliveryStatus: "pending",
            resultPayload: event.payload.result ? { ...event.payload.result } : current.resultPayload,
          },
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
    case "TaskExecutionDeliveryAbandoned": {
      const current = base.executions[event.payload.executionId];
      if (!current) return base;
      return {
        ...base,
        executions: {
          ...base.executions,
          [event.payload.executionId]: {
            ...current,
            deliveryStatus: "abandoned",
            deliveryAbandonedAt: event.payload.abandonedAt,
            deliveryAbandonmentReason: event.payload.reason,
          },
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
