import type {
  WorkerAdapter,
  WorkerCapabilities,
  WorkerDescriptor,
  WorkerEvent,
  WorkerHealth,
  WorkerInput,
  WorkerSessionHandle,
  WorkerSessionOptions,
} from "./worker-contract.js";

export interface WebWorkerTransportDescriptor {
  id: string;
  label: string;
  site?: string;
  availability: "available" | "degraded" | "unavailable";
  models?: readonly string[];
  capabilities?: Partial<WorkerCapabilities>;
  extensions?: Record<string, unknown>;
}

export interface WebWorkerTransportSession {
  sessionId: string;
  site?: string;
  origin?: string;
  href?: string;
  model?: string;
  createdAt?: string;
  extensions?: Record<string, unknown>;
}

export interface WebWorkerTransportSessionOptions {
  model?: string;
  workspaceRoot?: string;
  contextHandle?: string;
  extensions?: Record<string, unknown>;
}

export interface WebWorkerTransportInput {
  inputId: string;
  prompt: string;
  history?: WorkerInput["history"];
  allowedCapabilities?: string[];
  modeInstructions?: string;
  extensions?: Record<string, unknown>;
}

export type WebWorkerTransportEvent =
  | { type: "assistant_text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "capability_call"; callId?: string; name: string; arguments?: unknown; extensions?: Record<string, unknown> }
  | { type: "capability_result"; callId?: string; name: string; text?: string; isError?: boolean; durationMs?: number; extensions?: Record<string, unknown> }
  | { type: "usage"; usage: Record<string, unknown> }
  | { type: "status"; name: string; data: unknown }
  | { type: "completed"; result?: unknown }
  | { type: "cancelled"; result?: unknown }
  | { type: "error"; error: string; data?: unknown };

/**
 * Web transport boundary implemented by WebMCP Core / site adapters. The
 * Worker layer deliberately knows nothing about DOM selectors, page tokens,
 * composer heuristics, result-delivery retries, or site-specific protocols.
 */
export interface WebWorkerTransport {
  describe(): Promise<WebWorkerTransportDescriptor>;
  connect(options: WebWorkerTransportSessionOptions): Promise<WebWorkerTransportSession>;
  send(session: WebWorkerTransportSession, input: WebWorkerTransportInput): AsyncIterable<WebWorkerTransportEvent>;
  interrupt?(session: WebWorkerTransportSession): Promise<void>;
  health(session?: WebWorkerTransportSession): Promise<WorkerHealth>;
  disconnect(session: WebWorkerTransportSession): Promise<void>;
}

export interface WebWorkerSessionOptions extends WorkerSessionOptions {
  transport?: Record<string, unknown>;
}

interface WebWorkerSessionRecord {
  handle: WorkerSessionHandle;
  transportSession: WebWorkerTransportSession;
  activeInputId?: string;
}

function defaultCapabilities(overrides: Partial<WorkerCapabilities> | undefined): WorkerCapabilities {
  return {
    streaming: false,
    reasoning: false,
    capabilityRequests: true,
    imageInput: false,
    checkpoints: false,
    interruption: false,
    persistentContext: true,
    ...overrides,
    extensions: overrides?.extensions ? { ...overrides.extensions } : undefined,
  };
}

export class WebWorkerAdapter implements WorkerAdapter<WebWorkerSessionOptions> {
  private readonly sessions = new Map<string, WebWorkerSessionRecord>();

  constructor(
    private readonly transport: WebWorkerTransport,
    private readonly workerId = "nimora.web-worker",
  ) {}

  async describe(): Promise<WorkerDescriptor> {
    const descriptor = await this.transport.describe();
    return {
      id: this.workerId,
      provider: descriptor.id,
      kind: "web",
      label: descriptor.label,
      availability: descriptor.availability,
      models: descriptor.models ? [...descriptor.models] : undefined,
      capabilities: defaultCapabilities(descriptor.capabilities),
      extensions: {
        site: descriptor.site,
        transport: descriptor.id,
        ...(descriptor.extensions ?? {}),
      },
    };
  }

  async createSession(options: WebWorkerSessionOptions): Promise<WorkerSessionHandle> {
    const transportSession = await this.transport.connect({
      model: options.model,
      workspaceRoot: options.workspaceRoot,
      contextHandle: options.contextHandle,
      extensions: {
        ...(options.extensions ?? {}),
        ...(options.transport ?? {}),
      },
    });
    if (!transportSession.sessionId.trim()) {
      await this.transport.disconnect(transportSession).catch(() => undefined);
      throw new Error("Web transport returned an empty session id.");
    }
    if (this.sessions.has(transportSession.sessionId)) {
      throw new Error(`Web transport session is already managed by this adapter: ${transportSession.sessionId}`);
    }
    const now = new Date().toISOString();
    const handle: WorkerSessionHandle = {
      sessionId: transportSession.sessionId,
      workerId: this.workerId,
      state: "idle",
      model: options.model ?? transportSession.model,
      contextHandle: options.contextHandle,
      createdAt: transportSession.createdAt ?? now,
      lastActiveAt: now,
      extensions: {
        site: transportSession.site,
        origin: transportSession.origin,
        href: transportSession.href,
        transportSession: transportSession.extensions,
      },
    };
    this.sessions.set(handle.sessionId, { handle, transportSession });
    return handle;
  }

  send(session: WorkerSessionHandle, input: WorkerInput): AsyncIterable<WorkerEvent> {
    const record = this.requireSession(session);
    if (record.activeInputId) throw new Error(`Worker session ${session.sessionId} already has an active input.`);
    if (input.images?.length) throw new Error("WebWorkerAdapter does not support image input until the site transport explicitly implements it.");
    if (input.checkpoint !== undefined) throw new Error("WebWorkerAdapter does not support checkpoint resume.");
    record.activeInputId = input.inputId;
    this.touch(record, "running");
    return this.mapEvents(record, input);
  }

  async interrupt(session: WorkerSessionHandle): Promise<void> {
    const record = this.requireSession(session);
    if (!record.activeInputId) return;
    if (!this.transport.interrupt) throw new Error("This Web worker transport does not support interruption.");
    await this.transport.interrupt(record.transportSession);
    this.touch(record, "interrupted");
  }

  async dispose(session: WorkerSessionHandle): Promise<void> {
    const record = this.requireSession(session);
    await this.transport.disconnect(record.transportSession);
    record.activeInputId = undefined;
    this.touch(record, "disposed");
    this.sessions.delete(session.sessionId);
  }

  async health(session?: WorkerSessionHandle): Promise<WorkerHealth> {
    if (!session) return await this.transport.health();
    const record = this.requireSession(session);
    return await this.transport.health(record.transportSession);
  }

  private async *mapEvents(record: WebWorkerSessionRecord, input: WorkerInput): AsyncIterable<WorkerEvent> {
    let terminalSeen = false;
    try {
      const events = this.transport.send(record.transportSession, {
        inputId: input.inputId,
        prompt: input.prompt,
        history: input.history,
        allowedCapabilities: input.allowedCapabilities ? [...input.allowedCapabilities] : undefined,
        modeInstructions: input.modeInstructions,
        extensions: input.extensions ? { ...input.extensions } : undefined,
      });
      for await (const event of events) {
        switch (event.type) {
          case "assistant_text":
            yield { type: "text_delta", inputId: input.inputId, text: event.text };
            break;
          case "reasoning":
            yield { type: "reasoning_delta", inputId: input.inputId, text: event.text };
            break;
          case "capability_call":
            yield { type: "capability_call", inputId: input.inputId, callId: event.callId, name: event.name, arguments: event.arguments, extensions: event.extensions };
            break;
          case "capability_result":
            yield { type: "capability_result", inputId: input.inputId, callId: event.callId, name: event.name, text: event.text, isError: event.isError, durationMs: event.durationMs, extensions: event.extensions };
            break;
          case "usage":
            yield { type: "usage", inputId: input.inputId, usage: { ...event.usage } };
            break;
          case "status":
            yield { type: "provider_event", inputId: input.inputId, name: event.name, data: event.data };
            break;
          case "completed":
            terminalSeen = true;
            yield { type: "terminal", inputId: input.inputId, status: "completed", result: event.result };
            return;
          case "cancelled":
            terminalSeen = true;
            yield { type: "terminal", inputId: input.inputId, status: "cancelled", result: event.result };
            return;
          case "error":
            terminalSeen = true;
            yield { type: "terminal", inputId: input.inputId, status: "error", error: event.error, result: event.data };
            return;
        }
      }
      if (!terminalSeen) {
        yield { type: "terminal", inputId: input.inputId, status: "error", error: "Web worker transport ended without a terminal event." };
      }
    } catch (error) {
      if (!terminalSeen) {
        yield { type: "terminal", inputId: input.inputId, status: "error", error: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      record.activeInputId = undefined;
      if (record.handle.state !== "disposed") this.touch(record, record.handle.state === "interrupted" ? "interrupted" : "idle");
    }
  }

  private requireSession(session: WorkerSessionHandle): WebWorkerSessionRecord {
    if (session.workerId !== this.workerId) throw new Error(`Worker session ${session.sessionId} belongs to ${session.workerId}, not ${this.workerId}.`);
    const record = this.sessions.get(session.sessionId);
    if (!record) throw new Error(`Unknown or disposed web worker session: ${session.sessionId}`);
    return record;
  }

  private touch(record: WebWorkerSessionRecord, state: WorkerSessionHandle["state"]): void {
    record.handle.state = state;
    record.handle.lastActiveAt = new Date().toISOString();
  }
}
