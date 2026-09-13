import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  applyTaskEvent,
  replayTaskEvents,
  taskSourceIdentity,
  type TaskArtifactRef,
  type TaskEvent,
  type TaskExecution,
  type TaskInteractionOutcome,
  type TaskProgress,
  type TaskSnapshot,
  type TaskSource,
  type TaskTodo,
} from "./task-contract.js";

const MAX_GOAL_CHARS = 8_000;
const MAX_RESULT_SUMMARY_CHARS = 2_000;
const TASK_EVENT_TYPES = new Set<TaskEvent["type"]>([
  "TaskCreated",
  "TaskGoalUpdated",
  "TaskStatusChanged",
  "TaskTodosUpdated",
  "TaskProgressUpdated",
  "TaskInteractionStarted",
  "TaskInteractionFinished",
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
}

function boundText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 1)}…`;
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

  async beginExecution(taskId: string, input: BeginExecutionInput): Promise<{ duplicate: boolean; execution: TaskExecution | undefined }> {
    return this.exclusive(taskId, async () => {
      const current = this.tasks.get(taskId)?.executions[input.executionId];
      if (current) {
        await this.append(taskId, "TaskExecutionDuplicateObserved", { executionId: input.executionId });
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
          status: "requested",
          deliveryStatus: "not-prepared",
          requestedAt,
          duplicateObservations: 0,
        },
      });
      await this.append(taskId, "TaskExecutionStarted", { executionId: input.executionId, startedAt: this.now() });
      return { duplicate: false, execution: this.tasks.get(taskId)?.executions[input.executionId] };
    });
  }

  async finishExecution(taskId: string, executionId: string, status: "succeeded" | "failed" | "unknown", options: { durationMs?: number; error?: string; resultSummary?: string } = {}): Promise<void> {
    await this.append(taskId, "TaskExecutionFinished", {
      executionId,
      status,
      finishedAt: this.now(),
      durationMs: options.durationMs,
      error: boundText(options.error, MAX_RESULT_SUMMARY_CHARS),
      resultSummary: boundText(options.resultSummary, MAX_RESULT_SUMMARY_CHARS),
    });
  }

  async markResultPrepared(taskId: string, executionId: string): Promise<void> {
    await this.append(taskId, "TaskExecutionResultPrepared", { executionId });
  }

  async markDelivered(taskId: string, executionId: string): Promise<void> {
    await this.append(taskId, "TaskExecutionDelivered", { executionId });
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

  private async append<T extends TaskEvent["type"]>(taskId: string, type: T, payload: Extract<TaskEvent, { type: T }>["payload"]): Promise<void> {
    await this.initialize();
    if (!this.tasks.has(taskId)) throw new Error(`Unknown task: ${taskId}`);
    await this.commit({ version: 1, eventId: this.newId(), taskId, at: this.now(), type, payload } as TaskEvent);
  }

  private async commit(event: TaskEvent): Promise<void> {
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
