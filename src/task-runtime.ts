import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  applyTaskEvent,
  replayTaskEvents,
  taskSourceIdentity,
  type TaskArtifactRef,
  type TaskContextState,
  type TaskEvent,
  type TaskExecution,
  type TaskExecutionResultPayload,
  type TaskInteractionOutcome,
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
const TASK_EVENT_TYPES = new Set<TaskEvent["type"]>([
  "TaskCreated",
  "TaskGoalUpdated",
  "TaskContextUpdated",
  "TaskStatusChanged",
  "TaskTodosUpdated",
  "TaskProgressUpdated",
  "TaskInteractionStarted",
  "TaskInteractionFinished",
  "TaskWorkerAttached",
  "TaskWorkerDetached",
  "TaskExecutionRequested",
  "TaskExecutionStarted",
  "TaskExecutionDuplicateObserved",
  "TaskExecutionFinished",
  "TaskExecutionResultPrepared",
  "TaskExecutionDelivered",
  "TaskArtifactProduced",
]);

export interface TaskRuntimeOptions {
  storageDirectory: string;
  log?: (message: string) => void;
  now?: () => Date;
  newId?: () => string;
}

export interface BeginExecutionInput {
  executionId: string;
  toolName: string;
  capabilityId?: string;
  risk?: string;
  arguments?: unknown;
  origin?: TaskExecution["origin"];
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
      const taskId = this.newId();
      await this.commit({
        version: 1,
        eventId: this.newId(),
        taskId,
        at: this.now(),
        type: "TaskCreated",
        payload: { source: { ...source }, goal: boundText(initialGoal, MAX_GOAL_CHARS) },
      });
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

  listTasks(): TaskSnapshot[] {
    return [...this.tasks.values()].map(task => structuredClone(task)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async setTodos(taskId: string, todos: readonly TaskTodo[]): Promise<void> {
    await this.append(taskId, "TaskTodosUpdated", { todos: todos.map(todo => ({ ...todo })) });
  }

  async updateContext(taskId: string, input: Partial<Pick<TaskContextState, "summary" | "constraints" | "decisions" | "relevantFiles">>): Promise<TaskContextState> {
    await this.initialize();
    const current = this.tasks.get(taskId)?.context;
    if (!current) throw new Error(`Unknown task: ${taskId}`);
    const context: TaskContextState = {
      summary: input.summary === undefined ? current.summary : boundText(input.summary, MAX_CONTEXT_SUMMARY_CHARS),
      constraints: input.constraints === undefined ? [...current.constraints] : boundTextList(input.constraints),
      decisions: input.decisions === undefined ? [...current.decisions] : boundTextList(input.decisions),
      relevantFiles: input.relevantFiles === undefined ? [...current.relevantFiles] : boundTextList(input.relevantFiles, 128),
      updatedAt: this.now(),
    };
    await this.append(taskId, "TaskContextUpdated", { context });
    return structuredClone(this.tasks.get(taskId)!.context);
  }

  async reportProgress(taskId: string, progress: Omit<TaskProgress, "at">): Promise<void> {
    await this.append(taskId, "TaskProgressUpdated", { progress: { ...progress, at: this.now() } });
  }

  async startInteraction(taskId: string, input: { interactionId: string; surface: "native-chat" | "bridge"; mode?: string; model?: string }): Promise<{ duplicate: boolean }> {
    return this.exclusive(taskId, async () => {
      const snapshot = this.tasks.get(taskId);
      if (snapshot?.interactions[input.interactionId]) return { duplicate: true };
      await this.append(taskId, "TaskInteractionStarted", {
        interaction: { ...input, startedAt: this.now() },
      });
      return { duplicate: false };
    });
  }

  async finishInteraction(taskId: string, interactionId: string, outcome: TaskInteractionOutcome, options: { durationMs?: number; error?: string } = {}): Promise<void> {
    await this.append(taskId, "TaskInteractionFinished", {
      interactionId,
      outcome,
      finishedAt: this.now(),
      durationMs: options.durationMs,
      error: boundText(options.error, MAX_RESULT_SUMMARY_CHARS),
    });
  }

  async attachWorkerSession(taskId: string, input: Omit<TaskWorkerSessionRef, "attachedAt" | "detachedAt">): Promise<{ duplicate: boolean; workerSession: TaskWorkerSessionRef }> {
    return this.exclusive(taskId, async () => {
      const existing = this.tasks.get(taskId)?.workerSessions[input.managedSessionId];
      if (existing && (existing.workerId !== input.workerId || existing.adapterSessionId !== input.adapterSessionId)) {
        throw new Error(`Worker session identity mismatch for ${input.managedSessionId}.`);
      }
      if (existing && !existing.detachedAt) return { duplicate: true, workerSession: structuredClone(existing) };
      const workerSession: TaskWorkerSessionRef = { ...input, attachedAt: this.now() };
      await this.append(taskId, "TaskWorkerAttached", { workerSession });
      return { duplicate: false, workerSession: structuredClone(this.tasks.get(taskId)!.workerSessions[input.managedSessionId]) };
    });
  }

  async detachWorkerSession(taskId: string, managedSessionId: string): Promise<void> {
    await this.exclusive(taskId, async () => {
      const current = this.tasks.get(taskId)?.workerSessions[managedSessionId];
      if (!current || current.detachedAt) return;
      await this.append(taskId, "TaskWorkerDetached", { managedSessionId, detachedAt: this.now() });
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
      const current = this.tasks.get(taskId)?.executions[input.executionId];
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
    await this.append(taskId, "TaskExecutionFinished", {
      executionId,
      status,
      finishedAt: this.now(),
      durationMs: options.durationMs,
      error: boundText(options.error, MAX_RESULT_SUMMARY_CHARS),
      resultSummary: boundText(options.resultSummary, MAX_RESULT_SUMMARY_CHARS),
    }, strictPersistence);
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
    await this.append(taskId, "TaskExecutionResultPrepared", { executionId, result: durableResult }, strictPersistence);
  }

  async markDelivered(taskId: string, executionId: string): Promise<void> {
    await this.append(taskId, "TaskExecutionDelivered", { executionId });
  }

  async markDeliveredStrict(taskId: string, executionId: string): Promise<void> {
    await this.append(taskId, "TaskExecutionDelivered", { executionId }, true);
  }

  async recordArtifact(taskId: string, artifact: Omit<TaskArtifactRef, "artifactId" | "createdAt"> & { artifactId?: string; createdAt?: string }): Promise<TaskArtifactRef> {
    const value: TaskArtifactRef = {
      ...artifact,
      artifactId: artifact.artifactId ?? this.newId(),
      createdAt: artifact.createdAt ?? this.now(),
    };
    await this.append(taskId, "TaskArtifactProduced", { artifact: value });
    return value;
  }

  async flush(): Promise<void> {
    await Promise.all([...this.writeChains.values()]);
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
      try {
        const raw = await fs.readFile(path.join(this.options.storageDirectory, file), "utf8");
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
        if (!snapshot) continue;
        this.tasks.set(snapshot.taskId, snapshot);
        const sourceId = taskSourceIdentity(snapshot.source);
        const existing = this.sourceTaskIds.get(sourceId);
        if (!existing || (this.tasks.get(existing)?.updatedAt ?? "") < snapshot.updatedAt) this.sourceTaskIds.set(sourceId, snapshot.taskId);
      } catch (error) {
        this.log(`failed to replay ${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.log(`loaded ${this.tasks.size} shadow task(s)`);
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
