import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  applyTaskEvent,
  replayTaskEvents,
  taskSourceIdentity,
  type TaskArtifactRef,
  type TaskCapabilityGrant,
  type TaskCapabilityGrantScope,
  type TaskContextState,
  type TaskEvent,
  type TaskExecution,
  type TaskExecutionResultPayload,
  type TaskInputAccessPolicy,
  type TaskInteractionOutcome,
  type TaskMissionMetadata,
  type TaskProgress,
  type TaskSnapshot,
  type TaskSource,
  type TaskTodo,
  type TaskWorkerSessionRef,
} from "./task-contract.js";

const MAX_GOAL_CHARS = 8_000;
const MAX_RESULT_SUMMARY_CHARS = 2_000;
const MAX_EXECUTION_RESULT_CHARS = 64_000;
const MAX_CONTEXT_SUMMARY_CHARS = 12_000;
const MAX_CONTEXT_ITEM_CHARS = 1_500;
const MAX_CONTEXT_ITEMS = 64;
const MAX_MISSION_ID_CHARS = 240;
const MAX_MISSION_TYPE_CHARS = 160;
const MAX_COMPLETION_CRITERIA = 32;
const MAX_COMPLETION_CRITERION_CHARS = 1_000;
const MAX_RETIREMENT_REASON_CHARS = 240;
const TASK_EVENT_TYPES = new Set<TaskEvent["type"]>([
  "TaskCreated",
  "TaskMissionConfigured",
  "TaskMissionFinalized",
  "TaskMissionArchived",
  "TaskGoalUpdated",
  "TaskContextUpdated",
  "TaskStatusChanged",
  "TaskTodosUpdated",
  "TaskProgressUpdated",
  "TaskInteractionStarted",
  "TaskInteractionFinished",
  "TaskWorkerAttached",
  "TaskWorkerDetached",
  "TaskWorkerRetired",
  "TaskWorkerOrphanRetirementClassified",
  "TaskCapabilityGranted",
  "TaskCapabilityRevoked",
  "TaskInputAccessPolicyRecorded",
  "TaskExecutionRequested",
  "TaskExecutionStarted",
  "TaskExecutionDuplicateObserved",
  "TaskExecutionFinished",
  "TaskExecutionResultPrepared",
  "TaskExecutionDelivered",
  "TaskExecutionDeliveryAbandoned",
  "TaskArtifactProduced",
]);

export interface TaskRuntimeOptions {
  storageDirectory: string;
  log?: (message: string) => void;
  now?: () => Date;
  newId?: () => string;
  onDidChange?: (task: TaskSnapshot, event: TaskEvent) => void;
  /** Trusted host-only owner provenance stamped onto every new Worker attachment. */
  workerOwnerProvenance?: () => { ownerRuntimeIncarnationId: string; ownerProcessId: number };
}

export interface BeginExecutionInput {
  executionId: string;
  toolName: string;
  capabilityId?: string;
  risk?: string;
  arguments?: unknown;
  origin?: TaskExecution["origin"];
}

export interface FinalizeMissionInput {
  handoffRequired: boolean;
  handoff?: Omit<TaskArtifactRef, "artifactId" | "createdAt"> & { artifactId?: string; createdAt?: string };
  handoffFactory?: (
    snapshot: TaskSnapshot,
    completedAt: string,
  ) => Omit<TaskArtifactRef, "artifactId" | "createdAt"> & { artifactId?: string; createdAt?: string };
}

export interface EnsureMissionInitialContextInput {
  summary?: string;
  constraints?: readonly string[];
}

function executionIdentityMatches(current: TaskExecution, input: BeginExecutionInput): boolean {
  const argumentsDigest = input.arguments === undefined ? undefined : taskArgumentsDigest(input.arguments);
  return current.toolName === input.toolName
    && current.capabilityId === input.capabilityId
    && current.risk === input.risk
    && current.argumentsDigest === argumentsDigest
    && stableJson(current.origin) === stableJson(input.origin);
}

function boundText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
}

function boundTextList(values: readonly string[] | undefined, maxItems = MAX_CONTEXT_ITEMS): string[] {
  if (!values?.length) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const bounded = boundText(value, MAX_CONTEXT_ITEM_CHARS);
    if (!bounded || seen.has(bounded)) continue;
    seen.add(bounded);
    result.push(bounded);
    if (result.length >= maxItems) break;
  }
  return result;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`;
}

function missionIdentity(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > MAX_MISSION_ID_CHARS) throw new Error(`${label} must be at most ${MAX_MISSION_ID_CHARS} characters.`);
  return normalized;
}

function normalizeMissionMetadata(input: TaskMissionMetadata): TaskMissionMetadata {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Mission metadata is required.");
  const plane = input.plane;
  if (plane !== "coordination" && plane !== "cognition" && plane !== "practice") {
    throw new Error(`Unsupported Mission plane: ${String(plane)}`);
  }
  if (typeof input.missionType !== "string") throw new Error("Mission type must be a string.");
  const missionType = input.missionType.trim();
  if (!missionType) throw new Error("Mission type must not be empty.");
  if (missionType.length > MAX_MISSION_TYPE_CHARS) throw new Error(`Mission type must be at most ${MAX_MISSION_TYPE_CHARS} characters.`);
  if (!Array.isArray(input.completionCriteria) || input.completionCriteria.length === 0) {
    throw new Error("Mission completion criteria must contain at least one item.");
  }
  if (input.completionCriteria.length > MAX_COMPLETION_CRITERIA) {
    throw new Error(`Mission completion criteria must contain at most ${MAX_COMPLETION_CRITERIA} items.`);
  }
  const completionCriteria = input.completionCriteria.map((criterion, index) => {
    if (typeof criterion !== "string") throw new Error(`Mission completion criterion ${index + 1} must be a string.`);
    const normalized = criterion.trim();
    if (!normalized) throw new Error(`Mission completion criterion ${index + 1} must not be empty.`);
    if (normalized.length > MAX_COMPLETION_CRITERION_CHARS) {
      throw new Error(`Mission completion criterion ${index + 1} must be at most ${MAX_COMPLETION_CRITERION_CHARS} characters.`);
    }
    return normalized;
  });
  return {
    projectId: missionIdentity(input.projectId, "Project id"),
    rootMissionId: missionIdentity(input.rootMissionId, "Root Mission id"),
    ...(input.parentMissionId === undefined ? {} : { parentMissionId: missionIdentity(input.parentMissionId, "Parent Mission id") }),
    plane,
    missionType,
    completionCriteria,
  };
}

function missionMetadataMatches(a: TaskMissionMetadata, b: TaskMissionMetadata): boolean {
  return stableJson(a) === stableJson(b);
}

/** Lifecycle readiness includes unresolved effects/results, even with idle Workers. */
export function taskHasUnsettledWork(task: TaskSnapshot): boolean {
  return Object.values(task.interactions).some(interaction => !interaction.finishedAt)
    || Object.values(task.executions).some(execution => execution.status === "requested" || execution.status === "executing"
      || execution.status === "unknown" || execution.deliveryStatus === "pending" || execution.deliveryStatus === "unknown");
}

function exactStringListMatches(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function normalizeWorkspacePathPrefixes(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length === 0 || values.length > 64) {
    throw new Error("Input access policy requires 1-64 workspace path prefixes.");
  }
  const normalized = values.map((value, index) => {
    if (typeof value !== "string") throw new Error(`Workspace path prefix ${index + 1} must be a string.`);
    let text = value.trim().replace(/\\/g, "/");
    if (!text || text.length > 512) throw new Error(`Workspace path prefix ${index + 1} is invalid.`);
    text = text.replace(/^\.\//, "").replace(/\/+$/g, "");
    if (!text) text = ".";
    if (text.startsWith("/") || /^[A-Za-z]:\//.test(text) || text.split("/").some(part => part === "..")) {
      throw new Error(`Workspace path prefix must stay relative to the workspace: ${value}`);
    }
    return text;
  });
  return [...new Set(normalized)].sort();
}

function taskHasPostFormationWork(task: TaskSnapshot): boolean {
  return task.status !== "ready"
    || task.todos.length > 0
    || task.progress !== undefined
    || Object.keys(task.interactions).length > 0
    || Object.keys(task.workerSessions).length > 0
    || Object.keys(task.capabilityGrants).length > 0
    || Object.keys(task.executions).length > 0
    || task.artifacts.length > 0
    || task.context.decisions.length > 0
    || task.context.relevantFiles.length > 0
    || task.missionFinalization !== undefined;
}

function exactContextText(value: unknown, maxChars: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters.`);
  return normalized;
}

function taskArtifactContentDigest(artifact: TaskArtifactRef | undefined): string | undefined {
  const content = artifact?.metadata?.content;
  return typeof content === "string"
    ? `sha256:${createHash("sha256").update(content).digest("hex")}`
    : undefined;
}

function resolveFinalHandoffArtifact(task: TaskSnapshot): TaskArtifactRef | undefined {
  const finalization = task.missionFinalization;
  const artifactId = finalization?.handoffArtifactId;
  if (!artifactId) return undefined;
  const matches = task.artifacts.filter(artifact => artifact.artifactId === artifactId);
  if (matches.length !== 1) return undefined;
  const artifact = matches[0];
  if (artifact.kind !== "report" || artifact.metadata?.missionFinalHandoff !== true) return undefined;
  if (artifact.metadata?.missionId !== task.taskId) return undefined;
  if (task.mission?.projectId && artifact.metadata?.projectId !== task.mission.projectId) return undefined;
  if (typeof finalization?.handoffSourceEventId !== "string" || !finalization.handoffSourceEventId) return undefined;
  if (!Number.isInteger(finalization.handoffSourceEventCount) || (finalization.handoffSourceEventCount ?? 0) < 1) return undefined;
  if (artifact.metadata?.sourceTaskEventId !== finalization.handoffSourceEventId) return undefined;
  if (artifact.metadata?.sourceTaskEventCount !== finalization.handoffSourceEventCount) return undefined;
  if (!finalization?.handoffContentDigest) return undefined;
  if (artifact.metadata?.contentDigest !== finalization.handoffContentDigest) return undefined;
  if (taskArtifactContentDigest(artifact) !== finalization.handoffContentDigest) return undefined;
  return artifact;
}

export function taskArgumentsDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function eventFileName(taskId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) throw new Error(`Unsafe task id: ${taskId}`);
  return `${taskId}.jsonl`;
}

function isTaskEvent(value: unknown): value is TaskEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.version === 1 && typeof row.eventId === "string" && typeof row.taskId === "string"
    && typeof row.at === "string" && typeof row.type === "string"
    && TASK_EVENT_TYPES.has(row.type as TaskEvent["type"]) && row.payload !== undefined;
}

export class TaskRuntime {
  private readonly options: TaskRuntimeOptions;
  private readonly tasks = new Map<string, TaskSnapshot>();
  private readonly sourceTaskIds = new Map<string, string>();
  private readonly writeChains = new Map<string, Promise<void>>();
  private readonly operationChains = new Map<string, Promise<void>>();
  private readonly finalizingMissions = new Map<string, number>();
  private readonly sourceCreates = new Map<string, Promise<TaskSnapshot>>();
  private initializePromise: Promise<void> | undefined;

  constructor(options: TaskRuntimeOptions) {
    this.options = options;
  }

  async initialize(): Promise<void> {
    if (!this.initializePromise) this.initializePromise = this.load();
    return this.initializePromise;
  }

  async ensureTask(source: TaskSource, initialGoal?: string): Promise<TaskSnapshot> {
    await this.initialize();
    const sourceId = taskSourceIdentity(source);
    const existingId = this.sourceTaskIds.get(sourceId);
    if (existingId) return this.tasks.get(existingId)!;
    const creating = this.sourceCreates.get(sourceId);
    if (creating) return creating;

    const promise = (async () => {
      const secondCheck = this.sourceTaskIds.get(sourceId);
      if (secondCheck) return this.tasks.get(secondCheck)!;
      const durable = await this.rereadTaskBySource(source);
      if (durable) return durable;
      const taskId = this.newId();
      try {
        await this.commit({
          version: 1,
          eventId: this.newId(),
          taskId,
          at: this.now(),
          type: "TaskCreated",
          payload: { source: { ...source }, goal: boundText(initialGoal, MAX_GOAL_CHARS) },
        }, true);
      } catch (error) {
        const recovered = await this.rereadTaskBySource(source);
        if (recovered) return recovered;
        throw error;
      }
      return this.tasks.get(taskId)!;
    })();
    this.sourceCreates.set(sourceId, promise);
    try {
      return await promise;
    } finally {
      this.sourceCreates.delete(sourceId);
    }
  }

  getTask(taskId: string): TaskSnapshot | undefined {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : undefined;
  }

  findTaskBySource(source: TaskSource): TaskSnapshot | undefined {
    const taskId = this.sourceTaskIds.get(taskSourceIdentity(source));
    return taskId ? this.getTask(taskId) : undefined;
  }

  /**
   * Reconstruct one exact Task from its canonical journal and install that owner
   * truth into the live projection. This is intentionally narrower than a second
   * runtime/recovery brain: TaskRuntime remains the sole reader/owner of Task
   * journals and callers only receive the resulting snapshot.
   */
  async rereadTask(taskId: string): Promise<TaskSnapshot | undefined> {
    return this.exclusive(taskId, async () => {
      await this.initialize();
      const snapshot = await this.rereadTaskOwned(taskId);
      return snapshot ? structuredClone(snapshot) : undefined;
    });
  }

  /**
   * Re-read canonical Task journals by the existing TaskSource identity law.
   * Multiple durable owners for one source are an ambiguity/collision and must
   * fail closed instead of choosing a newer Task or allocating a replacement.
   */
  async rereadTaskBySource(source: TaskSource): Promise<TaskSnapshot | undefined> {
    await this.initialize();
    await this.settleAllTaskWrites();
    const sourceId = taskSourceIdentity(source);
    // First resolve only the durable source owner identity. Do not install this
    // snapshot: an exact-Task mutation may advance journal + live owner state
    // after this read but before installation.
    const candidates = await this.readDurableTasksBySource(sourceId);
    this.assertSingleDurableSourceOwner(sourceId, candidates);
    const candidate = candidates[0];
    if (!candidate) return undefined;

    // Once the source resolves to one Task identity, linearize the durable
    // reread/install decision with that exact Task's operation lane. Re-read
    // canonical bytes after acquiring the lane so a stale phase-1 image can
    // never regress a newer configure/context/finalization projection.
    return this.exclusive(candidate.taskId, async () => {
      await this.settleTaskWrite(candidate.taskId);
      const freshMatches = await this.readDurableTasksBySource(sourceId);
      this.assertSingleDurableSourceOwner(sourceId, freshMatches);
      const fresh = freshMatches[0];
      if (!fresh) return undefined;
      if (fresh.taskId !== candidate.taskId) {
        throw new Error(`Durable Task source owner changed during reread: ${sourceId} resolved ${candidate.taskId}, then ${fresh.taskId}.`);
      }
      this.installDurableSnapshot(fresh);
      return structuredClone(fresh);
    });
  }

  listTasks(): TaskSnapshot[] {
    return [...this.tasks.values()].map(task => structuredClone(task)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async isWorkerAdapterSessionRetired(workerId: string, adapterSessionId: string): Promise<boolean> {
    await this.initialize();
    return [...this.tasks.values()].some(task => Object.values(task.workerSessions).some(worker =>
      worker.workerId === workerId
      && worker.adapterSessionId === adapterSessionId
      && (!!task.missionFinalization || (!!worker.retiredAt && worker.retirementKind !== "orphan-owner-death"))
    ));
  }

  /**
   * Linearization check used by WorkerSessionManager while it already owns a
   * provider-native lifecycle barrier. This briefly enters the task-exclusive
   * lane so continuation cannot leapfrog Mission finalization stabilization.
   */
  async assertWorkerSessionContinuationAllowed(taskId: string, operation = "continue WorkerSession work"): Promise<void> {
    await this.exclusive(taskId, async () => {
      await this.initialize();
      const task = this.tasks.get(taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      if (task.missionFinalization) {
        throw new Error(`Mission ${taskId} is terminal (${task.missionFinalization.state}) and cannot ${operation}.`);
      }
      if ((this.finalizingMissions.get(taskId) ?? 0) > 0) {
        throw new Error(`Mission ${taskId} is finalizing and cannot ${operation}.`);
      }
    });
  }

  /**
   * Narrow continuation check for a provider turn that already won admission.
   * The caller must independently prove ownership of a still-active send lease
   * and an exact pending continuation identity. Unlike new-work admission this
   * intentionally remains available while the in-memory finalization fence is
   * waiting for that turn to finish, but durable terminal Mission state remains
   * authoritative and always rejects continuation.
   */
  async assertWorkerSessionAdmittedTurnContinuationAllowed(taskId: string, operation = "continue an admitted WorkerSession turn"): Promise<void> {
    await this.exclusive(taskId, async () => {
      await this.initialize();
      const task = this.tasks.get(taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      if (task.missionFinalization) {
        throw new Error(`Mission ${taskId} is terminal (${task.missionFinalization.state}) and cannot ${operation}.`);
      }
    });
  }

  /**
   * Installs a short-lived Mission-level admission fence before the finalizer
   * derives provider-native identities. The task lock is released before the
   * supplied operation acquires provider barriers, preserving one lock order:
   * provider barrier -> task-exclusive check/write, never task lock -> barrier.
   */
  async withMissionFinalizationStabilization<T>(taskId: string, operation: (snapshot: TaskSnapshot) => Promise<T>): Promise<T> {
    let snapshot: TaskSnapshot | undefined;
    await this.exclusive(taskId, async () => {
      await this.initialize();
      const task = this.tasks.get(taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      if (!task.mission) throw new Error(`Task ${taskId} is not configured as a Mission.`);
      this.finalizingMissions.set(taskId, (this.finalizingMissions.get(taskId) ?? 0) + 1);
      snapshot = structuredClone(task);
    });

    try {
      return await operation(snapshot!);
    } finally {
      await this.exclusive(taskId, async () => {
        const remaining = Math.max(0, (this.finalizingMissions.get(taskId) ?? 1) - 1);
        if (remaining === 0) this.finalizingMissions.delete(taskId);
        else this.finalizingMissions.set(taskId, remaining);
      });
    }
  }

  async configureMission(taskId: string, input: TaskMissionMetadata): Promise<TaskSnapshot> {
    const mission = normalizeMissionMetadata(input);
    const admissionTaskIds = mission.rootMissionId === taskId
      ? [taskId]
      : [taskId, mission.rootMissionId, ...(mission.parentMissionId ? [mission.parentMissionId] : [])];
    return this.exclusiveTasks(admissionTaskIds, async () => {
      await this.initialize();
      const task = this.tasks.get(taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      if (task.mission) {
        if (missionMetadataMatches(task.mission, mission)) return structuredClone(task);
        throw new Error(`Task ${taskId} is already configured as a different Mission.`);
      }

      if (mission.rootMissionId === taskId) {
        if (mission.parentMissionId !== undefined) throw new Error("Root Mission must not have parentMissionId.");
      } else {
        if (!mission.parentMissionId) throw new Error("Child Mission requires parentMissionId.");
        if (mission.parentMissionId === taskId) throw new Error("Child Mission cannot be its own parent.");
        const root = this.tasks.get(mission.rootMissionId);
        if (!root?.mission) throw new Error(`Root Mission is not configured: ${mission.rootMissionId}`);
        if (root.mission.projectId !== mission.projectId
          || root.mission.rootMissionId !== root.taskId
          || root.mission.parentMissionId !== undefined) {
          throw new Error(`Root Mission ${mission.rootMissionId} does not identify the same Project root.`);
        }
        if (root.missionFinalization) {
          throw new Error(`Root Mission ${mission.rootMissionId} is terminal (${root.missionFinalization.state}) and cannot accept a new child Mission.`);
        }
        if ((this.finalizingMissions.get(root.taskId) ?? 0) > 0) {
          throw new Error(`Root Mission ${mission.rootMissionId} is finalizing and cannot accept a new child Mission.`);
        }
        const parent = this.tasks.get(mission.parentMissionId);
        if (!parent?.mission) throw new Error(`Parent Mission is not configured: ${mission.parentMissionId}`);
        if (parent.mission.projectId !== mission.projectId || parent.mission.rootMissionId !== mission.rootMissionId) {
          throw new Error(`Parent Mission ${mission.parentMissionId} does not belong to the same Project/root.`);
        }
        if (parent.missionFinalization) {
          throw new Error(`Parent Mission ${mission.parentMissionId} is terminal (${parent.missionFinalization.state}) and cannot accept a new child Mission.`);
        }
        if ((this.finalizingMissions.get(parent.taskId) ?? 0) > 0) {
          throw new Error(`Parent Mission ${mission.parentMissionId} is finalizing and cannot accept a new child Mission.`);
        }
      }

      try {
        await this.append(taskId, "TaskMissionConfigured", {
          mission,
          adoptedWorkerSessions: Object.values(task.workerSessions).map(worker => structuredClone(worker)),
        }, true);
      } catch (error) {
        const durable = await this.rereadTaskOwned(taskId);
        if (durable?.mission) {
          if (missionMetadataMatches(durable.mission, mission)) return structuredClone(durable);
          throw new Error(`Task ${taskId} is durably configured as a different Mission.`);
        }
        throw error;
      }
      return structuredClone(this.tasks.get(taskId)!);
    });
  }

  async finalizeMissionStrict(taskId: string, input: FinalizeMissionInput): Promise<TaskSnapshot> {
    return this.exclusive(taskId, async () => {
      await this.initialize();
      const task = this.tasks.get(taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      if (!task.mission) throw new Error(`Task ${taskId} is not configured as a Mission.`);
      if (typeof input.handoffRequired !== "boolean") throw new Error("Mission handoff policy must declare handoffRequired.");
      if (taskHasUnsettledWork(task)) throw new Error(`Mission ${taskId} still has running work or unresolved execution/result delivery and cannot be finalized.`);
      if (task.missionFinalization) {
        if (task.missionFinalization.handoffRequired !== input.handoffRequired) {
          throw new Error(`Mission ${taskId} is already finalized with a different Handoff policy.`);
        }
        if (task.missionFinalization.handoffRequired && !resolveFinalHandoffArtifact(task)) {
          throw new Error(`Mission ${taskId} is missing or has an invalid required final Handoff artifact.`);
        }
        return structuredClone(task);
      }
      if (input.handoff && input.handoffFactory) throw new Error("Mission finalization accepts either handoff or handoffFactory, not both.");
      if (input.handoffRequired && !input.handoff && !input.handoffFactory) throw new Error(`Mission ${taskId} requires a final Handoff before completion.`);

      const completedAt = this.now();
      let handoff: TaskArtifactRef | undefined;
      const handoffInput = input.handoffFactory?.(structuredClone(task), completedAt) ?? input.handoff;
      if (handoffInput) {
        if (handoffInput.kind !== "report") throw new Error("Mission final Handoff must be a report artifact.");
        const title = boundText(handoffInput.title, 500);
        if (!title) throw new Error("Mission final Handoff title must not be empty.");
        const artifactId = handoffInput.artifactId?.trim() || this.newId();
        if (!artifactId) throw new Error("Mission final Handoff artifact id must not be empty.");
        if (task.artifacts.some(artifact => artifact.artifactId === artifactId)) {
          throw new Error(`Mission final Handoff artifact id collision: ${artifactId} already exists in Mission ${taskId}.`);
        }
        const sourceTaskEventId = task.lastEventId;
        const sourceTaskEventCount = task.eventCount;
        handoff = {
          ...handoffInput,
          artifactId,
          title,
          createdAt: handoffInput.createdAt ?? completedAt,
          metadata: {
            ...handoffInput.metadata,
            missionFinalHandoff: true,
            projectId: task.mission.projectId,
            missionId: task.taskId,
            sourceTaskEventId,
            sourceTaskEventCount,
          },
        };
        const contentDigest = taskArtifactContentDigest(handoff);
        if (!contentDigest) throw new Error("Mission final Handoff must contain textual metadata.content for digest verification.");
        handoff.metadata = { ...handoff.metadata, contentDigest };
      }

      await this.append(taskId, "TaskMissionFinalized", {
        completedAt,
        handoffRequired: input.handoffRequired,
        handoff,
        handoffSourceEventId: handoff?.metadata?.sourceTaskEventId as string | undefined,
        handoffSourceEventCount: handoff?.metadata?.sourceTaskEventCount as number | undefined,
        handoffContentDigest: taskArtifactContentDigest(handoff),
      }, true);
      return structuredClone(this.tasks.get(taskId)!);
    });
  }

  async archiveMissionStrict(taskId: string): Promise<TaskSnapshot> {
    return this.exclusive(taskId, async () => {
      await this.initialize();
      const task = this.tasks.get(taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      if (!task.mission) throw new Error(`Task ${taskId} is not configured as a Mission.`);
      const finalization = task.missionFinalization;
      if (!finalization) throw new Error(`Mission ${taskId} must be finalized before archive.`);
      if (taskHasUnsettledWork(task)) throw new Error(`Mission ${taskId} still has running work or unresolved execution/result delivery and cannot be archived.`);
      if (finalization.state === "archived") return structuredClone(task);
      if (finalization.handoffRequired && !resolveFinalHandoffArtifact(task)) {
        throw new Error(`Mission ${taskId} is missing or has an invalid required final Handoff artifact.`);
      }
      const unretiredWorkers = Object.values(task.workerSessions).filter(worker => !worker.retiredAt);
      if (unretiredWorkers.length) {
        throw new Error(`Mission ${taskId} still has ${unretiredWorkers.length} unretired WorkerSession ref(s) and cannot be archived.`);
      }
      await this.append(taskId, "TaskMissionArchived", { archivedAt: this.now() }, true);
      return structuredClone(this.tasks.get(taskId)!);
    });
  }

  async setTodos(taskId: string, todos: readonly TaskTodo[]): Promise<void> {
    await this.exclusive(taskId, async () => {
      const task = await this.requireMutableTask(taskId, "update todos");
      await this.append(task.taskId, "TaskTodosUpdated", { todos: todos.map(todo => ({ ...todo })) });
    });
  }

  async setTodosStrict(taskId: string, todos: readonly TaskTodo[]): Promise<TaskSnapshot> {
    return this.exclusive(taskId, async () => {
      const task = await this.requireMutableTask(taskId, "update todos");
      await this.append(task.taskId, "TaskTodosUpdated", { todos: todos.map(todo => ({ ...todo })) }, true);
      return structuredClone(this.tasks.get(taskId)!);
    });
  }

  /**
   * Strict/idempotent initialization for Formation-owned root context. Unlike
   * legacy updateContext(), it never truncates/deduplicates authorized content
   * and never uses the shadow fail-open persistence path.
   */
  async ensureMissionInitialContextStrict(taskId: string, input: EnsureMissionInitialContextInput): Promise<TaskSnapshot> {
    return this.exclusive(taskId, async () => {
      const task = await this.requireMutableTask(taskId, "initialize Mission context");
      if (!task.mission) throw new Error(`Task ${taskId} is not configured as a Mission.`);

      const summary = input.summary === undefined
        ? undefined
        : exactContextText(input.summary, MAX_CONTEXT_SUMMARY_CHARS, "Mission initial context summary");
      if (input.constraints !== undefined && !Array.isArray(input.constraints)) {
        throw new Error("Mission initial context constraints must be an array.");
      }
      if ((input.constraints?.length ?? 0) > MAX_CONTEXT_ITEMS) {
        throw new Error(`Mission initial context constraints must contain at most ${MAX_CONTEXT_ITEMS} items.`);
      }
      const constraints = (input.constraints ?? []).map((constraint, index) =>
        exactContextText(constraint, MAX_CONTEXT_ITEM_CHARS, `Mission initial context constraint ${index + 1}`));

      const summaryMatches = task.context.summary === summary;
      const constraintsMatch = exactStringListMatches(task.context.constraints, constraints);
      if (summaryMatches && constraintsMatch) return structuredClone(task);

      const summaryCanFill = task.context.summary === undefined && summary !== undefined;
      const constraintsCanFill = task.context.constraints.length === 0 && constraints.length > 0;
      if ((!summaryMatches && !summaryCanFill)
        || (!constraintsMatch && !constraintsCanFill)
        || taskHasPostFormationWork(task)) {
        throw new Error(`Mission ${taskId} initial context conflicts with its authorized formation seed.`);
      }

      const context: TaskContextState = {
        ...(summary === undefined ? {} : { summary }),
        constraints: [...constraints],
        decisions: [...task.context.decisions],
        relevantFiles: [...task.context.relevantFiles],
        updatedAt: this.now(),
      };
      try {
        await this.append(taskId, "TaskContextUpdated", { context }, true);
      } catch (error) {
        const durable = await this.rereadTaskOwned(taskId);
        if (durable && stableJson(durable.context) === stableJson(context)) return structuredClone(durable);
        throw error;
      }
      return structuredClone(this.tasks.get(taskId)!);
    });
  }

  /** Human-owned constraint change with strict persistence and compare-and-swap.
   * Unlike shadow context updates, failure never grants resource authority. */
  async replaceMissionConstraintsStrict(taskId: string, expected: readonly string[], constraints: readonly string[]): Promise<TaskSnapshot> {
    return this.exclusive(taskId, async () => {
      const task = await this.requireMutableTask(taskId, "change Mission constraints");
      if (!task.mission || !exactStringListMatches(task.context.constraints, expected)) throw new Error("Mission constraints changed before approval was committed.");
      if (!Array.isArray(constraints) || constraints.length > MAX_CONTEXT_ITEMS) throw new Error("Mission constraints exceed bounds.");
      const normalized = constraints.map((c, i) => exactContextText(c, MAX_CONTEXT_ITEM_CHARS, `Mission constraint ${i + 1}`));
      if (exactStringListMatches(expected, normalized)) return structuredClone(task);
      await this.append(taskId, "TaskContextUpdated", { context: { ...task.context, constraints: normalized, updatedAt: this.now() } }, true);
      const durable = await this.rereadTaskOwned(taskId);
      if (!durable || !exactStringListMatches(durable.context.constraints, normalized)) throw new Error("Mission resource constraint persistence could not be verified.");
      return structuredClone(durable);
    });
  }

  async updateContext(taskId: string, input: Partial<Pick<TaskContextState, "summary" | "constraints" | "decisions" | "relevantFiles">>): Promise<TaskContextState> {
    return this.exclusive(taskId, async () => {
      const task = await this.requireMutableTask(taskId, "update context");
      const current = task.context;
      const context: TaskContextState = {
        summary: input.summary === undefined ? current.summary : boundText(input.summary, MAX_CONTEXT_SUMMARY_CHARS),
        constraints: input.constraints === undefined ? [...current.constraints] : boundTextList(input.constraints),
        decisions: input.decisions === undefined ? [...current.decisions] : boundTextList(input.decisions),
        relevantFiles: input.relevantFiles === undefined ? [...current.relevantFiles] : boundTextList(input.relevantFiles, 128),
        updatedAt: this.now(),
      };
      await this.append(taskId, "TaskContextUpdated", { context });
      return structuredClone(this.tasks.get(taskId)!.context);
    });
  }

  async reportProgress(taskId: string, progress: Omit<TaskProgress, "at">): Promise<void> {
    await this.exclusive(taskId, async () => {
      await this.requireMutableTask(taskId, "report progress");
      await this.append(taskId, "TaskProgressUpdated", { progress: { ...progress, at: this.now() } });
    });
  }

  async reportProgressStrict(taskId: string, progress: Omit<TaskProgress, "at">): Promise<TaskSnapshot> {
    return this.exclusive(taskId, async () => {
      await this.requireMutableTask(taskId, "report progress");
      await this.append(taskId, "TaskProgressUpdated", { progress: { ...progress, at: this.now() } }, true);
      return structuredClone(this.tasks.get(taskId)!);
    });
  }

  async startInteraction(taskId: string, input: { interactionId: string; surface: "native-chat" | "bridge"; mode?: string; model?: string }): Promise<{ duplicate: boolean }> {
    return this.exclusive(taskId, async () => {
      const snapshot = await this.requireMutableTask(taskId, "start interaction");
      if (snapshot?.interactions[input.interactionId]) return { duplicate: true };
      await this.append(taskId, "TaskInteractionStarted", {
        interaction: { ...input, startedAt: this.now() },
      });
      return { duplicate: false };
    });
  }

  async finishInteraction(taskId: string, interactionId: string, outcome: TaskInteractionOutcome, options: { durationMs?: number; error?: string } = {}): Promise<void> {
    await this.exclusive(taskId, async () => {
      await this.requireMutableTask(taskId, "finish interaction");
      await this.append(taskId, "TaskInteractionFinished", {
        interactionId,
        outcome,
        finishedAt: this.now(),
        durationMs: options.durationMs,
        error: boundText(options.error, MAX_RESULT_SUMMARY_CHARS),
      });
    });
  }

  async attachWorkerSession(taskId: string, input: Omit<TaskWorkerSessionRef, "attachedAt" | "detachedAt" | "retiredAt" | "retirementReason" | "ownerRuntimeIncarnationId" | "ownerProcessId">): Promise<{ duplicate: boolean; workerSession: TaskWorkerSessionRef }> {
    return this.exclusive(taskId, async () => {
      await this.initialize();
      if (Object.prototype.hasOwnProperty.call(input as object, "ownerRuntimeIncarnationId")
        || Object.prototype.hasOwnProperty.call(input as object, "ownerProcessId")) {
        throw new Error("Worker owner provenance is trusted-host metadata and cannot be supplied by the attachment caller.");
      }
      const task = this.tasks.get(taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      if (task.missionFinalization) throw new Error(`Mission ${taskId} is finalized and cannot accept a WorkerSession.`);
      if ((this.finalizingMissions.get(taskId) ?? 0) > 0) throw new Error(`Mission ${taskId} is finalizing and cannot accept a WorkerSession.`);
      const existing = task.workerSessions[input.managedSessionId];
      if (existing && (existing.workerId !== input.workerId || existing.adapterSessionId !== input.adapterSessionId)) {
        throw new Error(`Worker session identity mismatch for ${input.managedSessionId}.`);
      }
      if (existing?.retiredAt) throw new Error(`Worker session ${input.managedSessionId} is retired and cannot be reattached.`);
      if (existing && !existing.detachedAt) return { duplicate: true, workerSession: structuredClone(existing) };
      const owner = this.options.workerOwnerProvenance?.();
      if (owner) {
        if (typeof owner.ownerRuntimeIncarnationId !== "string" || !owner.ownerRuntimeIncarnationId.trim()) {
          throw new Error("Worker owner runtime incarnation id must be a non-empty trusted host value.");
        }
        if (!Number.isSafeInteger(owner.ownerProcessId) || owner.ownerProcessId <= 0) {
          throw new Error("Worker owner process id must be a positive safe integer trusted host value.");
        }
      }
      const workerSession: TaskWorkerSessionRef = {
        managedSessionId: input.managedSessionId,
        workerId: input.workerId,
        adapterSessionId: input.adapterSessionId,
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(owner ? {
          ownerRuntimeIncarnationId: owner.ownerRuntimeIncarnationId.trim(),
          ownerProcessId: owner.ownerProcessId,
        } : {}),
        attachedAt: this.now(),
      };
      await this.append(taskId, "TaskWorkerAttached", { workerSession }, !!task.mission);
      return { duplicate: false, workerSession: structuredClone(this.tasks.get(taskId)!.workerSessions[input.managedSessionId]) };
    });
  }

  async detachWorkerSession(taskId: string, managedSessionId: string): Promise<void> {
    await this.exclusive(taskId, async () => {
      const task = await this.requireMutableTask(taskId, "detach WorkerSession");
      const current = task.workerSessions[managedSessionId];
      if (!current || current.detachedAt) return;
      await this.append(taskId, "TaskWorkerDetached", { managedSessionId, detachedAt: this.now() });
    });
  }

  async retireWorkerSessionStrict(taskId: string, managedSessionId: string, input: { retiredAt?: string; reason?: string } = {}): Promise<TaskWorkerSessionRef> {
    return this.exclusive(taskId, async () => {
      await this.initialize();
      const task = this.tasks.get(taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      const current = task.workerSessions[managedSessionId];
      if (!current) throw new Error(`Mission ${taskId} has no WorkerSession binding ${managedSessionId}.`);
      if (current.retiredAt) return structuredClone(current);
      const retiredAt = input.retiredAt?.trim() || this.now();
      const reason = boundText(input.reason, MAX_RETIREMENT_REASON_CHARS);
      await this.append(taskId, "TaskWorkerRetired", { managedSessionId, retiredAt, reason }, true);
      return structuredClone(this.tasks.get(taskId)!.workerSessions[managedSessionId]);
    });
  }

  /**
   * Narrow conditional retirement used when an external proof authorizes a
   * mutation only for one exact durable-current WorkerSession set. The proof is
   * produced outside the Task lane; this method owns the linearization point by
   * comparing that expected set to fresh durable Task truth and appending the
   * requested retirement without releasing the per-Task exclusive lane.
   */
  async retireWorkerSessionIfCurrentSetMatchesStrict(
    taskId: string,
    managedSessionId: string,
    expectedCurrent: readonly TaskWorkerSessionRef[],
    input: { retiredAt?: string; reason?: string; retirementKind?: "orphan-owner-death" } = {},
  ): Promise<TaskWorkerSessionRef> {
    return this.exclusive(taskId, async () => {
      await this.initialize();
      const task = await this.rereadTaskOwned(taskId);
      if (!task) throw new Error(`Unknown task: ${taskId}`);
      if (!task.mission) throw new Error(`Task ${taskId} is not configured as a Mission.`);
      if (task.missionFinalization) {
        throw new Error(`Mission ${taskId} is terminal (${task.missionFinalization.state}) and cannot retire a WorkerSession from an externally proven current set.`);
      }
      if ((this.finalizingMissions.get(taskId) ?? 0) > 0) {
        throw new Error(`Mission ${taskId} is finalizing and cannot retire a WorkerSession from an externally proven current set.`);
      }

      const proofIdentity = (worker: TaskWorkerSessionRef): string => JSON.stringify([
        worker.managedSessionId,
        worker.workerId,
        worker.adapterSessionId,
        worker.model ?? null,
        worker.ownerRuntimeIncarnationId ?? null,
        worker.ownerProcessId ?? null,
        worker.attachedAt,
        worker.detachedAt ?? null,
        worker.retiredAt ?? null,
      ]);
      const expectedIds = new Set<string>();
      const expected = expectedCurrent.map(worker => {
        if (worker.detachedAt || worker.retiredAt) {
          throw new Error(`Mission ${taskId} expected-current WorkerSession ${worker.managedSessionId} is not current; conditional retirement refused.`);
        }
        if (!worker.managedSessionId || expectedIds.has(worker.managedSessionId)) {
          throw new Error(`Mission ${taskId} expected-current WorkerSession set is invalid or duplicated; conditional retirement refused.`);
        }
        expectedIds.add(worker.managedSessionId);
        return proofIdentity(worker);
      }).sort();
      if (expected.length === 0) {
        throw new Error(`Mission ${taskId} expected-current WorkerSession set must not be empty; conditional retirement refused.`);
      }

      const currentWorkers = Object.values(task.workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt);
      const current = currentWorkers.map(proofIdentity).sort();
      if (current.length !== expected.length || current.some((identity, index) => identity !== expected[index])) {
        throw new Error(`Mission ${taskId} WorkerSession recovery proof is stale because the durable current set changed before retirement.`);
      }

      const requested = currentWorkers.find(worker => worker.managedSessionId === managedSessionId);
      if (!requested) {
        throw new Error(`Mission ${taskId} WorkerSession recovery proof is stale because requested binding ${managedSessionId} is no longer current.`);
      }
      const retiredAt = input.retiredAt?.trim() || this.now();
      const reason = boundText(input.reason, MAX_RETIREMENT_REASON_CHARS);
      await this.append(taskId, "TaskWorkerRetired", { managedSessionId, retiredAt, reason, retirementKind: input.retirementKind }, true);
      return structuredClone(this.tasks.get(taskId)!.workerSessions[managedSessionId]);
    });
  }

  /**
   * Classify an already-retired managed wrapper as a machine-proven host orphan.
   * The old managed owner stays retired; this only records that the provider
   * conversation itself was not retired and may be rediscovered/rebound.
   */
  async classifyWorkerOrphanRetirementStrict(taskId: string, managedSessionId: string): Promise<TaskWorkerSessionRef> {
    return this.exclusive(taskId, async () => {
      const task = await this.requireMutableTask(taskId, "classify orphan Worker retirement");
      const current = task.workerSessions[managedSessionId];
      if (!current) throw new Error(`Mission ${taskId} has no WorkerSession binding ${managedSessionId}.`);
      if (!current.retiredAt) throw new Error(`WorkerSession ${managedSessionId} is still current and cannot be classified as an orphan retirement.`);
      if (current.retirementKind === "orphan-owner-death") return structuredClone(current);
      await this.append(taskId, "TaskWorkerOrphanRetirementClassified", {
        managedSessionId,
        classifiedAt: this.now(),
      }, true);
      return structuredClone(this.tasks.get(taskId)!.workerSessions[managedSessionId]);
    });
  }

  async grantCapabilityStrict(taskId: string, input: {
    capabilityId: string;
    capabilityVersion: 1;
    scope: TaskCapabilityGrantScope;
    managedSessionId?: string;
  }): Promise<TaskCapabilityGrant> {
    return this.exclusive(taskId, async () => {
      const task = await this.requireMutableTask(taskId, "grant capability");
      const capabilityId = input.capabilityId.trim();
      if (!capabilityId) throw new Error("Capability grant requires capabilityId.");
      if (input.capabilityVersion !== 1) throw new Error(`Unsupported capability grant version: ${input.capabilityVersion}`);
      let workerSessionAttachedAt: string | undefined;
      if (input.scope === "worker-session") {
        if (!input.managedSessionId) throw new Error("Worker-session capability grant requires managedSessionId.");
        const workerSession = task.workerSessions[input.managedSessionId];
        if (!workerSession || workerSession.detachedAt) {
          throw new Error(`Worker-session capability grant requires an active Worker session: ${input.managedSessionId}`);
        }
        workerSessionAttachedAt = workerSession.attachedAt;
      } else if (input.managedSessionId !== undefined) {
        throw new Error("Task-scoped capability grant must not include managedSessionId.");
      }

      const existing = Object.values(task.capabilityGrants).find(grant =>
        !grant.revokedAt
        && grant.capabilityId === capabilityId
        && grant.capabilityVersion === input.capabilityVersion
        && grant.scope === input.scope
        && grant.managedSessionId === input.managedSessionId
        && grant.workerSessionAttachedAt === workerSessionAttachedAt
      );
      if (existing) return structuredClone(existing);

      const grant: TaskCapabilityGrant = {
        grantId: this.newId(),
        capabilityId,
        capabilityVersion: input.capabilityVersion,
        scope: input.scope,
        managedSessionId: input.managedSessionId,
        workerSessionAttachedAt,
        grantedAt: this.now(),
      };
      await this.append(taskId, "TaskCapabilityGranted", { grant }, true);
      return structuredClone(this.tasks.get(taskId)!.capabilityGrants[grant.grantId]);
    });
  }

  async revokeCapabilityGrantStrict(taskId: string, grantId: string): Promise<void> {
    await this.exclusive(taskId, async () => {
      const task = await this.requireMutableTask(taskId, "revoke capability");
      const grant = task.capabilityGrants[grantId];
      if (!grant || grant.revokedAt) return;
      await this.append(taskId, "TaskCapabilityRevoked", { grantId, revokedAt: this.now() }, true);
    });
  }

  async recordInputAccessPolicyStrict(taskId: string, input: {
    inputId: string;
    managedSessionId: string;
    allowedWorkspacePathPrefixes: readonly string[];
  }): Promise<TaskInputAccessPolicy> {
    return this.exclusive(taskId, async () => {
      const task = await this.requireMutableTask(taskId, "record input access policy");
      const inputId = missionIdentity(input.inputId, "Input id");
      const managedSessionId = missionIdentity(input.managedSessionId, "Managed session id");
      const worker = task.workerSessions[managedSessionId];
      if (!worker || worker.detachedAt || worker.retiredAt) {
        throw new Error(`Input access policy requires the exact active WorkerSession: ${managedSessionId}`);
      }
      const allowedWorkspacePathPrefixes = normalizeWorkspacePathPrefixes(input.allowedWorkspacePathPrefixes);
      const existing = task.inputAccessPolicies[inputId];
      if (existing) {
        if (existing.managedSessionId !== managedSessionId
          || !exactStringListMatches(existing.allowedWorkspacePathPrefixes, allowedWorkspacePathPrefixes)) {
          throw new Error(`Input access policy identity mismatch for ${inputId}.`);
        }
        return structuredClone(existing);
      }
      const policy: TaskInputAccessPolicy = {
        inputId,
        managedSessionId,
        allowedWorkspacePathPrefixes,
        recordedAt: this.now(),
      };
      await this.append(taskId, "TaskInputAccessPolicyRecorded", { policy }, true);
      return structuredClone(this.tasks.get(taskId)!.inputAccessPolicies[inputId]);
    });
  }

  async beginExecution(taskId: string, input: BeginExecutionInput): Promise<{ duplicate: boolean; execution: TaskExecution | undefined }> {
    return this.beginExecutionWithDurability(taskId, input, false, false);
  }

  /**
   * Durable fail-closed execution claim for future host-owned side effects.
   * Unlike shadow beginExecution(), persistence failure is fatal and an
   * existing execution id must have exactly the same semantic identity.
   */
  async claimExecution(taskId: string, input: BeginExecutionInput): Promise<{ duplicate: boolean; execution: TaskExecution | undefined }> {
    return this.beginExecutionWithDurability(taskId, input, true, true);
  }

  private async beginExecutionWithDurability(
    taskId: string,
    input: BeginExecutionInput,
    strictPersistence: boolean,
    validateDuplicateIdentity: boolean,
  ): Promise<{ duplicate: boolean; execution: TaskExecution | undefined }> {
    return this.exclusive(taskId, async () => {
      const task = await this.requireMutableTask(taskId, "begin execution");
      const current = task.executions[input.executionId];
      if (current) {
        if (validateDuplicateIdentity && !executionIdentityMatches(current, input)) {
          throw new Error(`Execution identity mismatch for ${input.executionId}.`);
        }
        await this.append(taskId, "TaskExecutionDuplicateObserved", { executionId: input.executionId }, strictPersistence);
        return { duplicate: true, execution: this.tasks.get(taskId)?.executions[input.executionId] };
      }
      const requestedAt = this.now();
      await this.append(taskId, "TaskExecutionRequested", {
        execution: {
          executionId: input.executionId,
          toolName: input.toolName,
          capabilityId: input.capabilityId,
          risk: input.risk,
          argumentsDigest: input.arguments === undefined ? undefined : taskArgumentsDigest(input.arguments),
          origin: input.origin ? { ...input.origin } : undefined,
          status: "requested",
          deliveryStatus: "not-prepared",
          requestedAt,
          duplicateObservations: 0,
        },
      }, strictPersistence);
      await this.append(taskId, "TaskExecutionStarted", { executionId: input.executionId, startedAt: this.now() }, strictPersistence);
      return { duplicate: false, execution: this.tasks.get(taskId)?.executions[input.executionId] };
    });
  }

  async finishExecution(taskId: string, executionId: string, status: "succeeded" | "failed" | "unknown", options: { durationMs?: number; error?: string; resultSummary?: string } = {}): Promise<void> {
    await this.finishExecutionWithDurability(taskId, executionId, status, options, false);
  }

  async finishExecutionStrict(taskId: string, executionId: string, status: "succeeded" | "failed" | "unknown", options: { durationMs?: number; error?: string; resultSummary?: string } = {}): Promise<void> {
    await this.finishExecutionWithDurability(taskId, executionId, status, options, true);
  }

  private async finishExecutionWithDurability(taskId: string, executionId: string, status: "succeeded" | "failed" | "unknown", options: { durationMs?: number; error?: string; resultSummary?: string }, strictPersistence: boolean): Promise<void> {
    await this.exclusive(taskId, async () => {
      await this.requireMutableTask(taskId, "finish execution");
      await this.append(taskId, "TaskExecutionFinished", {
        executionId,
        status,
        finishedAt: this.now(),
        durationMs: options.durationMs,
        error: boundText(options.error, MAX_RESULT_SUMMARY_CHARS),
        resultSummary: boundText(options.resultSummary, MAX_RESULT_SUMMARY_CHARS),
      }, strictPersistence);
    });
  }

  async markResultPrepared(taskId: string, executionId: string, result?: TaskExecutionResultPayload): Promise<void> {
    await this.markResultPreparedWithDurability(taskId, executionId, result, false);
  }

  async markResultPreparedStrict(taskId: string, executionId: string, result?: TaskExecutionResultPayload): Promise<void> {
    await this.markResultPreparedWithDurability(taskId, executionId, result, true);
  }

  private async markResultPreparedWithDurability(taskId: string, executionId: string, result: TaskExecutionResultPayload | undefined, strictPersistence: boolean): Promise<void> {
    const durableResult = result ? {
      ...result,
      text: boundText(result.text, MAX_EXECUTION_RESULT_CHARS),
      durationMs: typeof result.durationMs === "number" && Number.isFinite(result.durationMs) && result.durationMs >= 0
        ? result.durationMs
        : undefined,
    } : undefined;
    await this.exclusive(taskId, async () => {
      await this.requireMutableTask(taskId, "prepare execution result");
      await this.append(taskId, "TaskExecutionResultPrepared", { executionId, result: durableResult }, strictPersistence);
    });
  }

  async markDelivered(taskId: string, executionId: string): Promise<void> {
    await this.exclusive(taskId, async () => {
      await this.requireMutableTask(taskId, "deliver execution result");
      await this.append(taskId, "TaskExecutionDelivered", { executionId });
    });
  }

  async markDeliveredStrict(taskId: string, executionId: string): Promise<void> {
    await this.exclusive(taskId, async () => {
      await this.requireMutableTask(taskId, "deliver execution result");
      await this.append(taskId, "TaskExecutionDelivered", { executionId }, true);
    });
  }

  /**
   * Explicitly reconcile a result that is durably prepared but is known to
   * have never been delivered and must never be replayed. This preserves the
   * non-delivery fact instead of misclassifying it as delivered.
   */
  async abandonPendingDeliveryStrict(taskId: string, executionId: string, reason: string): Promise<TaskExecution> {
    return this.exclusive(taskId, async () => {
      const task = await this.requireMutableTask(taskId, "reconcile pending execution delivery");
      const current = task.executions[executionId];
      if (!current) throw new Error(`Unknown execution: ${executionId}`);
      const boundedReason = boundText(reason, MAX_RESULT_SUMMARY_CHARS);
      if (!boundedReason) throw new Error("Delivery abandonment reason must be a non-empty string.");
      if (current.deliveryStatus === "abandoned") {
        if (current.deliveryAbandonmentReason !== boundedReason) throw new Error(`Execution ${executionId} is already abandoned with a different reason.`);
        return { ...current };
      }
      if (current.deliveryStatus !== "pending") throw new Error(`Execution ${executionId} delivery is ${current.deliveryStatus}, not pending.`);
      if (current.status !== "succeeded" && current.status !== "failed") throw new Error(`Execution ${executionId} is not terminal; pending delivery cannot be abandoned.`);
      if (!current.origin?.managedSessionId) throw new Error(`Execution ${executionId} has no WorkerSession origin; explicit delivery abandonment is not authorized.`);
      const originWorker = task.workerSessions[current.origin.managedSessionId];
      if (!originWorker) throw new Error(`Execution ${executionId} origin WorkerSession is absent from durable Task history.`);
      if (!originWorker.detachedAt && !originWorker.retiredAt) throw new Error(`Execution ${executionId} origin WorkerSession is still current; pending delivery cannot be abandoned.`);
      await this.append(taskId, "TaskExecutionDeliveryAbandoned", {
        executionId,
        abandonedAt: this.now(),
        reason: boundedReason,
      }, true);
      return { ...this.tasks.get(taskId)!.executions[executionId] };
    });
  }

  async recordArtifact(taskId: string, artifact: Omit<TaskArtifactRef, "artifactId" | "createdAt"> & { artifactId?: string; createdAt?: string }): Promise<TaskArtifactRef> {
    return this.recordArtifactWithDurability(taskId, artifact, false);
  }

  async recordArtifactStrict(taskId: string, artifact: Omit<TaskArtifactRef, "artifactId" | "createdAt"> & { artifactId?: string; createdAt?: string }): Promise<TaskArtifactRef> {
    return this.recordArtifactWithDurability(taskId, artifact, true);
  }

  private async recordArtifactWithDurability(taskId: string, artifact: Omit<TaskArtifactRef, "artifactId" | "createdAt"> & { artifactId?: string; createdAt?: string }, strictPersistence: boolean): Promise<TaskArtifactRef> {
    return this.exclusive(taskId, async () => {
      const task = await this.requireMutableTask(taskId, "record artifact");
      const value: TaskArtifactRef = {
        ...artifact,
        artifactId: artifact.artifactId?.trim() || this.newId(),
        createdAt: artifact.createdAt ?? this.now(),
      };
      if (task.artifacts.some(existing => existing.artifactId === value.artifactId)) {
        throw new Error(`Task ${taskId} artifact id collision: ${value.artifactId} already exists.`);
      }
      await this.append(taskId, "TaskArtifactProduced", { artifact: value }, strictPersistence);
      return value;
    });
  }

  async flush(): Promise<void> {
    await Promise.all([...this.writeChains.values()]);
  }

  private async requireMutableTask(taskId: string, operation: string): Promise<TaskSnapshot> {
    await this.initialize();
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (task.missionFinalization) {
      throw new Error(`Mission ${taskId} is terminal (${task.missionFinalization.state}) and cannot ${operation}.`);
    }
    return task;
  }

  private async load(): Promise<void> {
    await fs.mkdir(this.options.storageDirectory, { recursive: true });
    let files: string[] = [];
    try {
      files = (await fs.readdir(this.options.storageDirectory)).filter(file => file.endsWith(".jsonl")).sort();
    } catch (error) {
      this.log(`failed to list task journals: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const file of files) {
      let snapshot: TaskSnapshot | undefined;
      try {
        snapshot = await this.readDurableTaskFile(file);
      } catch (error) {
        this.log(`failed to replay ${file}: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      if (!snapshot) continue;
      const sourceId = taskSourceIdentity(snapshot.source);
      const existing = this.sourceTaskIds.get(sourceId);
      if (existing && existing !== snapshot.taskId) {
        throw new Error(`Durable Task source ambiguity during replay: ${sourceId} maps to ${existing}, ${snapshot.taskId}.`);
      }
      this.installDurableSnapshot(snapshot);
    }
    this.log(`loaded ${this.tasks.size} shadow task(s)`);
  }

  private async readDurableTaskFile(file: string, expectedTaskId?: string): Promise<TaskSnapshot | undefined> {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(this.options.storageDirectory, file), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const events: TaskEvent[] = [];
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (isTaskEvent(parsed)) events.push(parsed);
        else this.log(`ignored invalid task event ${file}:${index + 1}`);
      } catch {
        this.log(`ignored incomplete/corrupt task event ${file}:${index + 1}`);
      }
    }
    const snapshot = replayTaskEvents(events);
    if (!snapshot) return undefined;
    if (expectedTaskId && snapshot.taskId !== expectedTaskId) {
      throw new Error(`Durable Task journal identity mismatch: expected ${expectedTaskId}, replayed ${snapshot.taskId}.`);
    }
    return snapshot;
  }

  private async rereadTaskOwned(taskId: string): Promise<TaskSnapshot | undefined> {
    await this.settleTaskWrite(taskId);
    const snapshot = await this.readDurableTaskFile(eventFileName(taskId), taskId);
    if (!snapshot) return undefined;
    this.installDurableSnapshot(snapshot);
    return snapshot;
  }

  private async readDurableTasksBySource(sourceId: string): Promise<TaskSnapshot[]> {
    let files: string[];
    try {
      files = (await fs.readdir(this.options.storageDirectory)).filter(file => file.endsWith(".jsonl")).sort();
    } catch (error) {
      this.log(`failed to list task journals for source reread: ${error instanceof Error ? error.message : String(error)}`);
      const code = (error as NodeJS.ErrnoException)?.code;
      // If the configured storage path is absent or is currently not a
      // directory, there cannot be a canonical Task journal to recover for this
      // source. Treat only those two shapes as "durable owner absent" so the
      // caller reaches the normal strict create/persistence boundary. Other I/O
      // failures remain fail-closed because durable owner truth may exist but be
      // temporarily unreadable.
      if (code === "ENOENT" || code === "ENOTDIR") return [];
      throw error;
    }
    const matches: TaskSnapshot[] = [];
    for (const file of files) {
      const snapshot = await this.readDurableTaskFile(file);
      if (snapshot && taskSourceIdentity(snapshot.source) === sourceId) matches.push(snapshot);
    }
    return matches;
  }

  private assertSingleDurableSourceOwner(sourceId: string, matches: readonly TaskSnapshot[]): void {
    if (matches.length > 1) {
      throw new Error(`Durable Task source ambiguity: ${sourceId} maps to ${matches.map(task => task.taskId).sort().join(", ")}.`);
    }
  }

  private installDurableSnapshot(snapshot: TaskSnapshot): void {
    const sourceId = taskSourceIdentity(snapshot.source);
    const existingSourceTaskId = this.sourceTaskIds.get(sourceId);
    if (existingSourceTaskId && existingSourceTaskId !== snapshot.taskId) {
      throw new Error(`Durable Task source ambiguity: ${sourceId} maps to ${existingSourceTaskId}, ${snapshot.taskId}.`);
    }
    const previous = this.tasks.get(snapshot.taskId);
    if (previous) {
      const previousSourceId = taskSourceIdentity(previous.source);
      if (previousSourceId !== sourceId && this.sourceTaskIds.get(previousSourceId) === snapshot.taskId) {
        this.sourceTaskIds.delete(previousSourceId);
      }
    }
    this.tasks.set(snapshot.taskId, snapshot);
    this.sourceTaskIds.set(sourceId, snapshot.taskId);
  }

  private async settleTaskWrite(taskId: string): Promise<void> {
    const write = this.writeChains.get(taskId);
    if (write) await write.catch(() => undefined);
  }

  private async settleAllTaskWrites(): Promise<void> {
    await Promise.all([...this.writeChains.values()].map(write => write.catch(() => undefined)));
  }

  private async append<T extends TaskEvent["type"]>(taskId: string, type: T, payload: Extract<TaskEvent, { type: T }>["payload"], strictPersistence = false): Promise<void> {
    await this.initialize();
    if (!this.tasks.has(taskId)) throw new Error(`Unknown task: ${taskId}`);
    await this.commit({ version: 1, eventId: this.newId(), taskId, at: this.now(), type, payload } as TaskEvent, strictPersistence);
  }

  private async commit(event: TaskEvent, strictPersistence = false): Promise<void> {
    // Apply exactly the representation that is durable on disk. JSON drops
    // optional properties whose value is undefined; canonicalizing before both
    // persistence and projection keeps the live snapshot replay-equivalent.
    const canonicalEvent = JSON.parse(JSON.stringify(event)) as TaskEvent;
    const previous = this.writeChains.get(event.taskId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const beforeWrite = this.tasks.get(canonicalEvent.taskId);
      if (beforeWrite?.missionFinalization
        && canonicalEvent.type !== "TaskWorkerRetired"
        && canonicalEvent.type !== "TaskMissionArchived") {
        throw new Error(`Mission ${canonicalEvent.taskId} is terminal (${beforeWrite.missionFinalization.state}) and rejects ${canonicalEvent.type}.`);
      }
      try {
        await fs.mkdir(this.options.storageDirectory, { recursive: true });
        await fs.appendFile(path.join(this.options.storageDirectory, eventFileName(canonicalEvent.taskId)), `${JSON.stringify(canonicalEvent)}\n`, "utf8");
      } catch (error) {
        // Shadow mode must never break the existing Chat/Bridge path. Keep the
        // in-memory projection useful and make persistence failure observable.
        this.log(`failed to persist ${canonicalEvent.type} task=${canonicalEvent.taskId}: ${error instanceof Error ? error.message : String(error)}`);
        if (strictPersistence) throw new Error(`Strict task persistence failed for ${canonicalEvent.type}: ${error instanceof Error ? error.message : String(error)}`);
      }
      const current = this.tasks.get(canonicalEvent.taskId);
      const updated = applyTaskEvent(current, canonicalEvent);
      this.tasks.set(canonicalEvent.taskId, updated);
      this.sourceTaskIds.set(taskSourceIdentity(updated.source), updated.taskId);
      try {
        this.options.onDidChange?.(structuredClone(updated), structuredClone(canonicalEvent));
      } catch (error) {
        this.log(`task change listener failed for ${canonicalEvent.type} task=${canonicalEvent.taskId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    this.writeChains.set(canonicalEvent.taskId, next);
    try {
      await next;
    } finally {
      if (this.writeChains.get(canonicalEvent.taskId) === next) this.writeChains.delete(canonicalEvent.taskId);
    }
  }

  private async exclusive<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationChains.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const current = previous.then(() => gate);
    this.operationChains.set(taskId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.operationChains.get(taskId) === current) this.operationChains.delete(taskId);
    }
  }

  /**
   * Acquires all Task/Mission operation lanes in one stable order. Child Mission
   * admission holds child + root + parent ownership through the durable
   * TaskMissionConfigured write, so owner finalization and child birth share one
   * linearizable boundary. Duplicate ids (notably root === parent) are collapsed
   * before acquisition to avoid self-deadlock.
   *
   * This helper never crosses into provider-native lifecycle barriers. Phase 2
   * finalization keeps its provider barrier -> task lane ordering; this composes
   * TaskRuntime lanes only.
   */
  private async exclusiveTasks<T>(taskIds: readonly string[], operation: () => Promise<T>): Promise<T> {
    const orderedTaskIds = [...new Set(taskIds)].sort();
    const acquire = async (index: number): Promise<T> => {
      if (index >= orderedTaskIds.length) return operation();
      return this.exclusive(orderedTaskIds[index], () => acquire(index + 1));
    };
    return acquire(0);
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  private newId(): string {
    return (this.options.newId ?? randomUUID)();
  }

  private log(message: string): void {
    this.options.log?.(`[task-runtime] ${message}`);
  }
}
