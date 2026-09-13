export type WorkerKind = "web" | "api" | "local" | "agent-host" | "remote";
export type WorkerAvailability = "available" | "degraded" | "unavailable";
export type WorkerSessionState = "idle" | "running" | "interrupted" | "disposed";

export interface WorkerCapabilities {
  streaming: boolean;
  reasoning: boolean;
  capabilityRequests: boolean;
  imageInput: boolean;
  checkpoints: boolean;
  interruption: boolean;
  persistentContext: boolean;
  extensions?: Record<string, unknown>;
}

export interface WorkerDescriptor {
  id: string;
  provider: string;
  kind: WorkerKind;
  label: string;
  availability: WorkerAvailability;
  models?: readonly string[];
  capabilities: WorkerCapabilities;
  extensions?: Record<string, unknown>;
}

export interface WorkerSessionOptions {
  model?: string;
  workspaceRoot?: string;
  contextHandle?: string;
  extensions?: Record<string, unknown>;
}

export interface WorkerSessionHandle {
  sessionId: string;
  workerId: string;
  state: WorkerSessionState;
  model?: string;
  contextHandle?: string;
  createdAt: string;
  lastActiveAt: string;
  extensions?: Record<string, unknown>;
}

export interface WorkerHistoryItem {
  role: "user" | "assistant";
  content: string;
  images?: WorkerImageInput[];
}

export interface WorkerImageInput {
  mimeType: string;
  data: string;
  name?: string;
}

export interface WorkerCapabilityDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface WorkerInput {
  /** Stable identity for one turn/send inside the logical WorkerSession. */
  inputId: string;
  prompt: string;
  history?: WorkerHistoryItem[];
  images?: WorkerImageInput[];
  allowedCapabilities?: string[];
  externalCapabilities?: WorkerCapabilityDefinition[];
  modeInstructions?: string;
  /** Adapter-owned opaque checkpoint previously emitted by this worker. */
  checkpoint?: unknown;
  extensions?: Record<string, unknown>;
}

export type WorkerTerminalStatus = "completed" | "interrupted" | "cancelled" | "error";

export type WorkerEvent =
  | { type: "text_delta"; inputId: string; text: string }
  | { type: "reasoning_delta"; inputId: string; text: string }
  | { type: "capability_call"; inputId: string; callId?: string; name: string; arguments?: unknown; extensions?: Record<string, unknown> }
  | { type: "capability_result"; inputId: string; callId?: string; name: string; text?: string; isError?: boolean; durationMs?: number; extensions?: Record<string, unknown> }
  | { type: "artifact_proposal"; inputId: string; artifact: unknown; extensions?: Record<string, unknown> }
  | { type: "checkpoint"; inputId: string; checkpoint: unknown }
  | { type: "usage"; inputId: string; usage: Record<string, unknown> }
  | { type: "provider_event"; inputId: string; name: string; data: unknown }
  | { type: "terminal"; inputId: string; status: WorkerTerminalStatus; result?: unknown; error?: string };

export interface WorkerHealth {
  status: "healthy" | "degraded" | "offline";
  checkedAt: string;
  message?: string;
  extensions?: Record<string, unknown>;
}

/**
 * Semantic Worker boundary. Adapters are free to use JSON-RPC, AHP state
 * actions, DOM/WebMCP, HTTP APIs, or an in-process model underneath this API.
 * Provider-specific capabilities belong in typed adapter options/extensions;
 * callers must not assume identical wire protocols or identical feature sets.
 */
export interface WorkerAdapter<
  TSessionOptions extends WorkerSessionOptions = WorkerSessionOptions,
  TInput extends WorkerInput = WorkerInput,
> {
  describe(): Promise<WorkerDescriptor>;
  createSession(options: TSessionOptions): Promise<WorkerSessionHandle>;
  send(session: WorkerSessionHandle, input: TInput): AsyncIterable<WorkerEvent>;
  interrupt(session: WorkerSessionHandle): Promise<void>;
  resume?(session: WorkerSessionHandle, checkpoint: unknown): Promise<void>;
  dispose(session: WorkerSessionHandle): Promise<void>;
  health(session?: WorkerSessionHandle): Promise<WorkerHealth>;
}

export function isTerminalWorkerEvent(event: WorkerEvent): event is Extract<WorkerEvent, { type: "terminal" }> {
  return event.type === "terminal";
}
