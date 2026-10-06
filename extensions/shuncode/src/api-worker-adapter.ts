import { createHash, randomUUID } from "node:crypto";
import { IDE_TOOL_NAMES } from "../../../src/ide-tool-definitions.js";
import {
  FILE_MISSION_CAPABILITY_SCHEMA_SOURCE_ID,
  IDE_MISSION_CAPABILITY_SCHEMA_SOURCE_ID,
} from "../../../src/mission-capability-schema-ids.js";
import type {
  WorkerAdapter,
  WorkerCapabilityExecutionRoute,
  WorkerDescriptor,
  WorkerEvent,
  WorkerHealth,
  WorkerInput,
  WorkerSessionHandle,
  WorkerSessionOptions,
  WorkerCapabilityResultInput,
} from "../../../src/worker-contract.js";
import type { RuntimeAgentCheckpoint, RuntimeClient, RuntimeHello, RuntimeTraceItem } from "./runtime-client.js";
import { shunCodeMissionCapabilityExecutionRoutes } from "./bridge-task-tool-definitions.js";

type RuntimeParams = Parameters<RuntimeClient["runAgent"]>[0];
type RuntimeResult = Awaited<ReturnType<RuntimeClient["runAgent"]>>;

function apiCapabilityExecutionRoutes(hello: RuntimeHello): WorkerCapabilityExecutionRoute[] {
  const advertisedTools = [...(hello.tools ?? [])];
  const ideNames = new Set(IDE_TOOL_NAMES);
  const routes: WorkerCapabilityExecutionRoute[] = [];
  const fileToolNames = advertisedTools.filter(toolName => !ideNames.has(toolName as (typeof IDE_TOOL_NAMES)[number]));
  if (fileToolNames.length) routes.push({
    routeId: "api.workspace-mcp.file-tools",
    projectionMode: "native-by-name",
    schemaSourceId: FILE_MISSION_CAPABILITY_SCHEMA_SOURCE_ID,
    toolNames: fileToolNames,
    basis: "Exact runtime/hello advertises these canonical file names; Runtime Agent lists matching workspace MCP schemas and executes them through its workspace tool client.",
  });
  const ideToolNames = hello.capabilities?.ideToolBroker === false
    ? []
    : IDE_TOOL_NAMES.filter(toolName => advertisedTools.includes(toolName));
  if (ideToolNames.length) routes.push({
    routeId: "api.runtime.ide-tool-broker",
    projectionMode: "native-by-name",
    schemaSourceId: IDE_MISSION_CAPABILITY_SCHEMA_SOURCE_ID,
    toolNames: ideToolNames,
    basis: "Exact runtime/hello advertises these IDE names with ideToolBroker support; Runtime Agent executes them through ide/tool/invoke to IdeToolBroker.",
  });
  return routes;
}

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
  pendingTools?: Map<string, { name: string; resolve(result: WorkerCapabilityResultInput): void; submitted: Promise<void>; complete(error?: Error): void; resultSubmitted?: boolean }>;
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
    private readonly hostManagedCapabilities = false,
  ) {}

  async describe(): Promise<WorkerDescriptor> {
    try {
      const hello = await this.runtime.hello();
      const capabilities = hello.capabilities ?? {};
      const executionRoutes = this.hostManagedCapabilities
        ? shunCodeMissionCapabilityExecutionRoutes("external-schema", "api.mission-tool-broker", "Exact Runtime hello advertises missionToolBroker; host-requested external schemas execute through canonical Mission authorization and delivery.")
        : apiCapabilityExecutionRoutes(hello);
      return {
        id: this.workerId,
        provider: this.provider,
        kind: "api",
        label: "Nimora API Runtime",
        availability: this.hostManagedCapabilities && capabilities.missionToolBroker !== true ? "unavailable" : "available",
        capabilityProjection: {
          nativeByName: !this.hostManagedCapabilities,
          externalDefinitions: true,
          executionRoutes: this.hostManagedCapabilities && capabilities.missionToolBroker !== true ? [] : executionRoutes,
        },
        capabilities: {
          streaming: capabilities.streamingModelResponses !== false,
          reasoning: true,
          capabilityRequests: this.hostManagedCapabilities ? capabilities.missionToolBroker === true : capabilities.ideToolBroker !== false,
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
        capabilityProjection: {
          nativeByName: true,
          externalDefinitions: true,
          executionRoutes: [],
        },
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
    this.sessions.set(handle.sessionId, { handle, options: structuredClone(options) });
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

  async submitCapabilityResult(session: WorkerSessionHandle, result: WorkerCapabilityResultInput): Promise<void> {
    const record = this.requireSession(session);
    if (record.active?.inputId !== result.inputId || !result.callId) throw new Error("API result has no exact active input/call identity.");
    const pending = record.pendingTools?.get(result.callId);
    if (!pending) throw new Error("API result has no pending host-requested call; replay is forbidden.");
    if (pending.name !== result.name) throw new Error("API result capability does not match the exact pending call.");
    if (pending.resultSubmitted) throw new Error("API result already submitted for this occurrence; replay is forbidden.");
    pending.resultSubmitted = true;
    pending.resolve(result);
    // Written to the runtime pipe is local submission, never provider acceptance.
    await pending.submitted;
    record.pendingTools!.delete(result.callId);
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
      // Provider function names have a narrower alphabet than canonical Mission
      // capability IDs. Translate only the wire spelling; broker admission,
      // events, execution and result binding keep the original exact identity.
      const canonicalToWire = new Map<string, string>();
      const wireToCanonical = new Map<string, string>();
      if (this.hostManagedCapabilities) {
        for (const name of new Set([...(input.allowedCapabilities ?? []), ...(input.externalCapabilities ?? []).map(tool => tool.name)])) {
          const wire = /^[A-Za-z0-9_-]{1,64}$/.test(name) ? name
            : `nimora_tool_${createHash("sha256").update(name).digest("hex").slice(0,48)}`;
          if (wireToCanonical.has(wire) && wireToCanonical.get(wire) !== name) throw new Error("API capability wire-name collision; refusing provider send.");
          canonicalToWire.set(name, wire);
          wireToCanonical.set(wire, name);
        }
      }
      const aliases = [...canonicalToWire].filter(([canonical, wire]) => canonical !== wire);
      // A provider may invent a dummy field for an argumentless function.
      // Encode the host's exact empty single-command envelope explicitly on
      // the API wire; only this exact input-bound encoding can decode to {}.
      const commandTool = this.hostManagedCapabilities && input.extensions?.terminalAfterHostCapabilityResult === true
        && input.externalCapabilities?.length === 1 ? input.externalCapabilities[0] : undefined;
      const schema = commandTool?.inputSchema as Record<string, unknown> | undefined;
      const emptyRecord = (value: unknown): boolean => !!value && typeof value === "object"
        && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).length === 0;
      const encodedCommandName = commandTool && input.allowedCapabilities?.length === 1
        && input.allowedCapabilities[0] === commandTool.name && schema?.type === "object"
        && schema.additionalProperties === false && emptyRecord(schema.properties) && emptyRecord(schema.const)
        ? commandTool.name : undefined;
      const commandWireInstructions = encodedCommandName
        ? `API wire encoding for the single host-bound command: invoke ${canonicalToWire.get(encodedCommandName)} exactly once with ${JSON.stringify({ invocation_id: input.inputId })}. This is the transport encoding of the canonical empty object; the host retains every semantic argument. Copy invocation_id exactly. Do not send {}, dummy, project, mission, instruction or any other field. Only this API wire encoding applies to the exposed function schema.`
        : "";
      const result = await this.runtime.runAgent({
        ...record.options.runtime,
        model: record.options.model,
        workspaceRoot: record.options.workspaceRoot,
        prompt: [input.prompt, ...(aliases.length ? [`Provider function wire names (canonical authority unchanged):\n${aliases.map(([canonical, wire]) => `${canonical} => ${wire}`).join("\n")}\nInvoke only the function spellings provided in the tool schemas.`] : []), commandWireInstructions].filter(Boolean).join("\n\n"),
        history: input.history,
        images: input.images,
        allowedTools: input.allowedCapabilities?.map(name => canonicalToWire.get(name) ?? name),
        externalTools: input.externalCapabilities?.map(tool => ({ ...tool, name: canonicalToWire.get(tool.name) ?? tool.name,
          ...(tool.name === encodedCommandName ? { inputSchema: { type: "object", properties: {
            invocation_id: { type: "string", enum: [input.inputId] },
          }, required: ["invocation_id"], additionalProperties: false } } : {}),
        })),
        modeInstructions: [input.modeInstructions, commandWireInstructions].filter(Boolean).join("\n\n"),
        checkpoint: (input.checkpoint ?? record.resumeCheckpoint) as RuntimeAgentCheckpoint | undefined,
        hostManagedTools: this.hostManagedCapabilities,
        terminalAfterExternalToolResult: this.hostManagedCapabilities && input.extensions?.terminalAfterHostCapabilityResult === true,
      }, item => this.emitTrace(input.inputId, item, queue), checkpoint => {
        queue.push({ type: "checkpoint", inputId: input.inputId, checkpoint });
      }, {
        toolInvocationToken: input.runtimeInvocation?.toolInvocationToken,
        cancellationToken: cancellation.token,
        ...(this.hostManagedCapabilities ? {
          invokeMissionTool: async (requestId: string | number, wireName: string, args: unknown) => {
            const name = wireToCanonical.get(wireName);
            const callId = `api-rpc:${JSON.stringify(requestId)}`;
            if (record.active?.inputId !== input.inputId || cancellation.token.isCancellationRequested
              || !name || !input.allowedCapabilities?.includes(name)) throw new Error("API capability is outside the exact active Mission input.");
            let canonicalArguments = args;
            if (name === encodedCommandName) {
              if (!args || typeof args !== "object" || Object.getPrototypeOf(args) !== Object.prototype
                || Reflect.ownKeys(args).length !== 1) throw new Error("API command wire envelope must contain only the exact invocation_id; no host command was invoked.");
              const identity = Object.getOwnPropertyDescriptor(args, "invocation_id");
              if (!identity || !("value" in identity) || !identity.enumerable || identity.value !== input.inputId) {
                throw new Error("API command wire invocation_id does not match the exact active input; no host command was invoked.");
              }
              canonicalArguments = {};
            }
            record.pendingTools ??= new Map();
            if (record.pendingTools.has(callId)) throw new Error("API call occurrence already exists; no replay.");
            let complete!: (error?: Error) => void;
            const submitted = new Promise<void>((resolve, reject) => { complete = error => error ? reject(error) : resolve(); });
            // Rejections can precede the delivery waiter when transport dies.
            void submitted.catch(() => undefined);
            let resolveResult!: (result: WorkerCapabilityResultInput) => void;
            const resultPromise = new Promise<WorkerCapabilityResultInput>(resolve => { resolveResult = resolve; });
            record.pendingTools.set(callId, { name, resolve: resolveResult, submitted, complete });
            const cancelled = cancellation.token.onCancellationRequested(() => {
              complete(new Error("API Mission tool submission cancelled; delivery is unconfirmed."));
              resolveResult({ inputId: input.inputId, callId, name, isError: true, text: "Mission cancelled." });
            });
            queue.push({ type: "capability_call", inputId: input.inputId, callId, name, arguments: canonicalArguments, dispatch: "host-requested" });
            try {
              const result = await resultPromise;
              return { text: result.text, isError: result.isError };
            } finally { cancelled.dispose(); }
          },
          missionToolSubmitted: (requestId: string | number, error?: Error) => record.pendingTools?.get(`api-rpc:${JSON.stringify(requestId)}`)?.complete(error),
        } : {}),
      });

      const interrupted = result?.status === "interrupted";
      queue.push({
        type: "terminal",
        inputId: input.inputId,
        status: cancellation.token.isCancellationRequested ? "cancelled" : interrupted ? "interrupted" : "completed",
        // Mission semantic consumers read only the owning terminal text. Model
        // deltas are presentation; the Runtime's completed answer is the fact.
        result: { ...result, text: result.answer },
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
      for (const [callId, pending] of record.pendingTools ?? []) {
        pending.complete(new Error("API Runtime ended before confirmed result submission."));
        pending.resolve({ inputId: input.inputId, callId, name: "unknown", isError: true, text: "Runtime ended; no provider delivery was confirmed." });
      }
      record.pendingTools?.clear();
      queue.close();
    }
  }

  private emitTrace(inputId: string, item: RuntimeTraceItem, queue: WorkerEventQueue): void {
    if (this.hostManagedCapabilities && (item.type === "tool_call" || item.type === "tool_result")) return;
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
        dispatch: "observed",
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
