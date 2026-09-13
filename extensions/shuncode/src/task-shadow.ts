import path from "node:path";
import * as vscode from "vscode";
import { getCapabilityMetadata } from "../../../src/capability-registry.js";
import { TaskRuntime } from "../../../src/task-runtime.js";
import type { TaskArtifactRef, TaskInteractionOutcome, TaskProgress, TaskSnapshot, TaskTodo } from "../../../src/task-contract.js";
import type { WorkerExecutionProjectionStore, WorkerTaskBindingStore } from "../../../src/worker-session-manager.js";

export interface ShadowExecutionHandle {
  taskId: string;
  executionId: string;
  duplicate: boolean;
}

/**
 * Fail-open compatibility layer for Phase 3 shadow mode. Task journaling must
 * never break the established Chat, Bridge, tool execution, or UI path.
 */
export class TaskShadowRecorder implements vscode.Disposable, WorkerTaskBindingStore, WorkerExecutionProjectionStore {
  private readonly runtime: TaskRuntime;
  private readonly ready: Promise<void>;
  private initializationError: Error | undefined;

  constructor(context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    this.runtime = new TaskRuntime({
      storageDirectory: path.join(context.globalStorageUri.fsPath, "task-runtime-v1"),
      log: message => this.output.appendLine(message),
    });
    this.ready = this.runtime.initialize().catch(error => {
      this.initializationError = error instanceof Error ? error : new Error(String(error));
      this.logFailure("initialize", error);
    });
  }

  /** Strict execution-owner APIs share the same durable TaskRuntime but bypass fail-open shadow wrappers. */
  executionRuntime(): TaskRuntime {
    return this.runtime;
  }

  async ensureNativeChatTask(sourceKey: string, workspace: string | undefined, initialGoal: string): Promise<string | undefined> {
    return this.safe("ensure native chat task", async () => {
      await this.ready;
      const task = await this.runtime.ensureTask({ kind: "native-chat", key: sourceKey, workspace }, initialGoal);
      return task.taskId;
    });
  }

  async ensureBridgeTask(sourceKey: string, workspace?: string): Promise<string | undefined> {
    return this.safe("ensure bridge task", async () => {
      await this.ready;
      const task = await this.runtime.ensureTask({ kind: "bridge", key: sourceKey, workspace });
      return task.taskId;
    });
  }

  async startInteraction(taskId: string | undefined, interactionId: string, input: { surface: "native-chat" | "bridge"; mode?: string; model?: string }): Promise<void> {
    if (!taskId) return;
    await this.safe("start interaction", async () => {
      const result = await this.runtime.startInteraction(taskId, { interactionId, ...input });
      if (result.duplicate) this.output.appendLine(`[task-shadow] duplicate interaction observed task=${taskId} interaction=${interactionId}`);
    });
  }

  async finishInteraction(taskId: string | undefined, interactionId: string, outcome: TaskInteractionOutcome, options: { durationMs?: number; error?: string } = {}): Promise<void> {
    if (!taskId) return;
    await this.safe("finish interaction", () => this.runtime.finishInteraction(taskId, interactionId, outcome, options));
  }

  async setTodos(taskId: string | undefined, todos: readonly TaskTodo[]): Promise<void> {
    if (!taskId) return;
    await this.safe("set todos", () => this.runtime.setTodos(taskId, todos));
  }

  async reportProgress(taskId: string | undefined, progress: Omit<TaskProgress, "at">): Promise<void> {
    if (!taskId) return;
    await this.safe("report progress", () => this.runtime.reportProgress(taskId, progress));
  }

  async getTaskOwned(taskId: string | undefined): Promise<TaskSnapshot> {
    if (!taskId) throw new Error("Task Runtime is required for durable Bridge coordination state.");
    await this.ready;
    if (this.initializationError) throw this.initializationError;
    const task = this.runtime.getTask(taskId);
    if (!task) throw new Error(`Unknown Task Runtime task: ${taskId}`);
    return task;
  }

  async setTodosOwned(taskId: string | undefined, todos: readonly TaskTodo[]): Promise<TaskSnapshot> {
    if (!taskId) throw new Error("Task Runtime is required for durable Bridge todo state.");
    await this.ready;
    if (this.initializationError) throw this.initializationError;
    return await this.runtime.setTodosStrict(taskId, todos);
  }

  async reportProgressOwned(taskId: string | undefined, progress: Omit<TaskProgress, "at">): Promise<TaskSnapshot> {
    if (!taskId) throw new Error("Task Runtime is required for durable Bridge progress state.");
    await this.ready;
    if (this.initializationError) throw this.initializationError;
    return await this.runtime.reportProgressStrict(taskId, progress);
  }

  async beginExecution(taskId: string | undefined, executionId: string, toolName: string, args: unknown): Promise<ShadowExecutionHandle | undefined> {
    if (!taskId) return undefined;
    return this.safe("begin execution", async () => {
      const capability = getCapabilityMetadata(toolName);
      const result = await this.runtime.beginExecution(taskId, {
        executionId,
        toolName,
        capabilityId: capability?.id,
        risk: capability?.risk,
        arguments: args,
      });
      if (result.duplicate) {
        this.output.appendLine(`[task-shadow] duplicate execution observed task=${taskId} execution=${executionId} tool=${toolName}; shadow mode does not suppress legacy execution`);
      }
      return { taskId, executionId, duplicate: result.duplicate };
    });
  }

  async finishExecution(handle: ShadowExecutionHandle | undefined, status: "succeeded" | "failed" | "unknown", options: { durationMs?: number; error?: string; resultSummary?: string } = {}): Promise<void> {
    if (!handle) return;
    await this.safe("finish execution", () => this.runtime.finishExecution(handle.taskId, handle.executionId, status, options));
  }

  async markResultPrepared(handle: ShadowExecutionHandle | undefined): Promise<void> {
    if (!handle) return;
    await this.safe("prepare execution result", () => this.runtime.markResultPrepared(handle.taskId, handle.executionId));
  }

  async recordChangeset(handle: ShadowExecutionHandle | undefined, structuredContent: unknown): Promise<TaskArtifactRef | undefined> {
    if (!handle || !structuredContent || typeof structuredContent !== "object" || Array.isArray(structuredContent)) return undefined;
    const row = structuredContent as Record<string, unknown>;
    const files = Array.isArray(row.files)
      ? row.files.flatMap(file => {
        if (!file || typeof file !== "object" || Array.isArray(file)) return [];
        const item = file as Record<string, unknown>;
        const candidate = typeof item.destination_path === "string" ? item.destination_path : typeof item.path === "string" ? item.path : undefined;
        return candidate ? [candidate] : [];
      })
      : [];
    const summary = row.summary && typeof row.summary === "object" && !Array.isArray(row.summary) ? row.summary as Record<string, unknown> : {};
    return this.safe("record changeset", () => this.runtime.recordArtifact(handle.taskId, {
      kind: "changeset",
      title: files.length === 1 ? `Changed ${files[0]}` : `Changed ${files.length} workspace files`,
      executionId: handle.executionId,
      metadata: {
        files,
        filesChanged: typeof summary.files_changed === "number" ? summary.files_changed : files.length,
        additions: typeof summary.additions === "number" ? summary.additions : undefined,
        deletions: typeof summary.deletions === "number" ? summary.deletions : undefined,
        diffTruncated: row.diff_truncated === true,
      },
    }));
  }

  async attachWorkerSession(taskId: string, input: { managedSessionId: string; workerId: string; adapterSessionId: string; model?: string }): Promise<unknown> {
    await this.ready;
    if (this.initializationError) throw this.initializationError;
    return await this.runtime.attachWorkerSession(taskId, input);
  }

  async detachWorkerSession(taskId: string, managedSessionId: string): Promise<void> {
    await this.ready;
    if (this.initializationError) throw this.initializationError;
    await this.runtime.detachWorkerSession(taskId, managedSessionId);
  }

  async beginWorkerExecution(taskId: string, input: {
    executionId: string;
    managedSessionId: string;
    workerId: string;
    inputId: string;
    callId?: string;
    toolName: string;
    arguments?: unknown;
  }): Promise<void> {
    await this.safe("begin worker execution", async () => {
      const capability = getCapabilityMetadata(input.toolName);
      const result = await this.runtime.beginExecution(taskId, {
        executionId: input.executionId,
        toolName: input.toolName,
        capabilityId: capability?.id,
        risk: capability?.risk,
        arguments: input.arguments,
        origin: {
          kind: "worker",
          managedSessionId: input.managedSessionId,
          workerId: input.workerId,
          inputId: input.inputId,
          callId: input.callId,
        },
      });
      if (result.duplicate) {
        this.output.appendLine(`[task-shadow] duplicate worker execution observed task=${taskId} execution=${input.executionId} worker=${input.workerId}`);
      }
    });
  }

  async completeWorkerExecution(taskId: string, executionId: string, input: {
    status: "succeeded" | "failed" | "unknown";
    durationMs?: number;
    error?: string;
    resultSummary?: string;
  }): Promise<void> {
    await this.safe("complete worker execution", async () => {
      await this.runtime.finishExecution(taskId, executionId, input.status, input);
      await this.runtime.markResultPrepared(taskId, executionId);
    });
  }

  async markWorkerExecutionDelivered(taskId: string, executionId: string): Promise<void> {
    await this.safe("deliver worker execution result", () => this.runtime.markDelivered(taskId, executionId));
  }

  dispose(): void {
    void this.runtime.flush().catch(error => this.logFailure("flush", error));
  }

  private async safe<T>(operation: string, run: () => Promise<T>): Promise<T | undefined> {
    try {
      return await run();
    } catch (error) {
      this.logFailure(operation, error);
      return undefined;
    }
  }

  private logFailure(operation: string, error: unknown): void {
    this.output.appendLine(`[task-shadow] ${operation} failed open: ${error instanceof Error ? error.message : String(error)}`);
  }
}
