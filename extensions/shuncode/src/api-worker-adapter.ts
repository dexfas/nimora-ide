import { randomUUID } from "node:crypto";
import type {
  WorkerAdapter,
  WorkerDescriptor,
  WorkerEvent,
  WorkerHealth,
  WorkerInput,
  WorkerSessionHandle,
  WorkerSessionOptions,
} from "../../../src/worker-contract.js";
import type { RuntimeAgentCheckpoint, RuntimeClient, RuntimeTraceItem } from "./runtime-client.js";

type RuntimeParams = Parameters<RuntimeClient["runAgent"]>[0];
type RuntimeResult = Awaited<ReturnType<RuntimeClient["runAgent"]>>;

interface RuntimeLike {
  runAgent(
    params: RuntimeParams,
    onTrace?: (item: RuntimeTraceItem) => void,
    onCheckpoint?: (checkpoint: RuntimeAgentCheckpoint) => void,
    invocationContext?: any,
  ): Promise<RuntimeResult>;
  hello(): ReturnType<RuntimeClient["hello"]>;
}

export interface ApiWorkerSessionOptions extends WorkerSessionOptions {
  model: string;
  workspaceRoot: string;
  runtime: Omit<RuntimeParams, "model" | "workspaceRoot" | "prompt" | "history" | "images" | "allowedTools" | "externalTools" | "modeInstructions" | "checkpoint">;
}

/** Extension-local fields required while Native Chat still owns VS Code UI. */
export interface ApiWorkerInput extends WorkerInput {
  runtimeInvocation?: {
    toolInvocationToken?: unknown;
  };
}

interface ApiSessionRecord {
  handle: WorkerSessionHandle;
  options: ApiWorkerSessionOptions;
  active?: { inputId: string; cancellation: AdapterCancellation };
  resumeCheckpoint?: unknown;
}

class AdapterCancellation {
  private listeners = new Set<() => void>();
  private cancelled = false;
  readonly token: {
    readonly isCancellationRequested: boolean;
    onCancellationRequested(listener: () => unknown, thisArgs?: unknown): { dispose(): void };
  };

  constructor() {
    const owner = this;
    this.token = {
      get isCancellationRequested(): boolean {
        return owner.cancelled;
      },
      onCancellationRequested(listener: () => unknown, thisArgs?: unknown): { dispose(): void } {
        if (owner.cancelled) {
          queueMicrotask(() => listener.call(thisArgs));
          return { dispose: () => undefined };
        }
        const wrapped = () => { listener.call(thisArgs); };
        owner.listeners.add(wrapped);
        return { dispose: () => owner.listeners.delete(wrapped) };
      },
    };
  }

  cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const listener of [...this.listeners]) listener();
    this.listeners.clear();
  }
}

class WorkerEventQueue implements AsyncIterable<WorkerEvent> {
  private values: WorkerEvent[] = [];
  private waiters: Array<(result: IteratorResult<WorkerEvent>) => void> = [];
  private finished = false;

  push(value: WorkerEvent): void {
    if (this.finished) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  close(): void {
    if (this.finished) return;
    this.finished = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<WorkerEvent> {
    return {
      next: async () => {
        const value = this.values.shift();
        if (value) return { value, done: false };
        if (this.finished) return { value: undefined, done: true };
        return await new Promise<IteratorResult<WorkerEvent>>(resolve => this.waiters.push(resolve));
      },
    };
  }
}

function traceData(item: RuntimeTraceItem): Record<string, unknown> {
  return item.data && typeof item.data === "object" && !Array.isArray(item.data) ? item.data as Record<string, unknown> : {};
}

export class ApiWorkerAdapter implements WorkerAdapter<ApiWorkerSessionOptions, ApiWorkerInput> {
  private readonly sessions = new Map<string, ApiSessionRecord>();

  constructor(
    private readonly runtime: RuntimeLike,
    private readonly workerId = "nimora.api-runtime",
    private readonly provider = "nimora-api",
  ) {}

  async describe(): Promise<WorkerDescriptor> {
    try {
      const hello = await this.runtime.hello();
      const capabilities = hello.capabilities ?? {};
      return {
        id: this.workerId,
        provider: this.provider,
        kind: "api",
        label: "Nimora API Runtime",
        availability: "available",
        capabilities: {
          streaming: capabilities.streamingModelResponses !== false,
          reasoning: true,
          capabilityRequests: capabilities.ideToolBroker !== false,
          imageInput: capabilities.imageInput === true,
          checkpoints: capabilities.recoverableCheckpoints === true,
          interruption: capabilities.cancellation !== false,
          persistentContext: false,
          extensions: { runtimeHello: capabilities },
        },
      };
    } catch (error) {
      return {
        id: this.workerId,
        provider: this.provider,
        kind: "api",
        label: "Nimora API Runtime",
        availability: "unavailable",
        capabilities: {
          streaming: true,
          reasoning: true,
          capabilityRequests: true,
          imageInput: false,
          checkpoints: false,
          interruption: true,
          persistentContext: false,
        },
        extensions: { healthError: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  async createSession(options: ApiWorkerSessionOptions): Promise<WorkerSessionHandle> {
    const now = new Date().toISOString();
    const handle: WorkerSessionHandle = {
      sessionId: randomUUID(),
      workerId: this.workerId,
      state: "idle",
      model: options.model,
      contextHandle: options.contextHandle,
      createdAt: now,
      lastActiveAt: now,
    };
    this.sessions.set(handle.sessionId, { handle, options });
    return handle;
  }

  send(session: WorkerSessionHandle, input: ApiWorkerInput): AsyncIterable<WorkerEvent> {
    const record = this.requireSession(session);
    if (record.active) throw new Error(`Worker session ${session.sessionId} already has an active input.`);
    const queue = new WorkerEventQueue();
    const cancellation = new AdapterCancellation();
    record.active = { inputId: input.inputId, cancellation };
    this.touch(record, "running");
    void this.run(record, input, queue, cancellation);
    return queue;
  }

  async interrupt(session: WorkerSessionHandle): Promise<void> {
    const record = this.requireSession(session);
    record.active?.cancellation.cancel();
    if (record.active) this.touch(record, "interrupted");
  }

  async resume(session: WorkerSessionHandle, checkpoint: unknown): Promise<void> {
    const record = this.requireSession(session);
    if (record.active) throw new Error(`Cannot change checkpoint while worker session ${session.sessionId} is running.`);
    record.resumeCheckpoint = checkpoint;
    this.touch(record, "idle");
  }

  async dispose(session: WorkerSessionHandle): Promise<void> {
    const record = this.requireSession(session);
    record.active?.cancellation.cancel();
    this.touch(record, "disposed");
    this.sessions.delete(session.sessionId);
  }

  async health(session?: WorkerSessionHandle): Promise<WorkerHealth> {
    if (session) this.requireSession(session);
    try {
      const hello = await this.runtime.hello();
      return { status: "healthy", checkedAt: new Date().toISOString(), extensions: { capabilities: hello.capabilities ?? {} } };
    } catch (error) {
      return { status: "offline", checkedAt: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async run(record: ApiSessionRecord, input: ApiWorkerInput, queue: WorkerEventQueue, cancellation: AdapterCancellation): Promise<void> {
    try {
      const result = await this.runtime.runAgent({
        ...record.options.runtime,
        model: record.options.model,
        workspaceRoot: record.options.workspaceRoot,
        prompt: input.prompt,
        history: input.history,
        images: input.images,
        allowedTools: input.allowedCapabilities,
        externalTools: input.externalCapabilities,
        modeInstructions: input.modeInstructions,
        checkpoint: (input.checkpoint ?? record.resumeCheckpoint) as RuntimeAgentCheckpoint | undefined,
      }, item => this.emitTrace(input.inputId, item, queue), checkpoint => {
        queue.push({ type: "checkpoint", inputId: input.inputId, checkpoint });
      }, {
        toolInvocationToken: input.runtimeInvocation?.toolInvocationToken,
        cancellationToken: cancellation.token,
      });

      const interrupted = result?.status === "interrupted";
      queue.push({
        type: "terminal",
        inputId: input.inputId,
        status: cancellation.token.isCancellationRequested ? "cancelled" : interrupted ? "interrupted" : "completed",
        result,
      });
      this.touch(record, cancellation.token.isCancellationRequested || interrupted ? "interrupted" : "idle");
    } catch (error) {
      const cancelled = cancellation.token.isCancellationRequested;
      queue.push({
        type: "terminal",
        inputId: input.inputId,
        status: cancelled ? "cancelled" : "error",
        error: cancelled ? undefined : error instanceof Error ? error.message : String(error),
      });
      this.touch(record, cancelled ? "interrupted" : "idle");
    } finally {
      if (record.active?.inputId === input.inputId) record.active = undefined;
      record.resumeCheckpoint = undefined;
      queue.close();
    }
  }

  private emitTrace(inputId: string, item: RuntimeTraceItem, queue: WorkerEventQueue): void {
    const data = traceData(item);
    if (item.type === "model_delta") {
      if (typeof data.content === "string" && data.content) queue.push({ type: "text_delta", inputId, text: data.content });
      return;
    }
    if (item.type === "model_thinking_delta") {
      if (typeof data.content === "string" && data.content) queue.push({ type: "reasoning_delta", inputId, text: data.content });
      return;
    }
    if (item.type === "tool_call") {
      queue.push({
        type: "capability_call",
        inputId,
        callId: typeof data.id === "string" ? data.id : undefined,
        name: typeof data.name === "string" ? data.name : "unknown",
        arguments: data.arguments,
        extensions: { step: item.step },
      });
      return;
    }
    if (item.type === "tool_result") {
      queue.push({
        type: "capability_result",
        inputId,
        callId: typeof data.id === "string" ? data.id : undefined,
        name: typeof data.name === "string" ? data.name : "unknown",
        text: typeof data.text === "string" ? data.text : undefined,
        isError: data.isError === true,
        durationMs: typeof data.duration_ms === "number" ? data.duration_ms : undefined,
        extensions: { step: item.step },
      });
      return;
    }
    queue.push({ type: "provider_event", inputId, name: item.type, data: item });
  }

  private requireSession(session: WorkerSessionHandle): ApiSessionRecord {
    if (session.workerId !== this.workerId) throw new Error(`Worker session ${session.sessionId} belongs to ${session.workerId}, not ${this.workerId}.`);
    const record = this.sessions.get(session.sessionId);
    if (!record) throw new Error(`Unknown or disposed worker session: ${session.sessionId}`);
    return record;
  }

  private touch(record: ApiSessionRecord, state: WorkerSessionHandle["state"]): void {
    record.handle.state = state;
    record.handle.lastActiveAt = new Date().toISOString();
  }
}
