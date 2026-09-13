import type {
  WebWorkerTransport,
  WebWorkerTransportDescriptor,
  WebWorkerTransportEvent,
  WebWorkerTransportInput,
  WebWorkerTransportSession,
  WebWorkerTransportSessionOptions,
} from "../../../src/web-worker-adapter.js";
import type { WorkerHealth } from "../../../src/worker-contract.js";
import type { WorkerCapabilityResultInput } from "../../../src/worker-contract.js";

export interface WebMcpCommandExecutor {
  executeCommand<T>(command: string, ...args: unknown[]): PromiseLike<T | undefined>;
}

export interface WebMcpCommandTransportOptions {
  pollIntervalMs?: number;
  now?: () => Date;
}

interface WebMcpConnectedPage {
  pageId: string;
  sessionId: string;
  site?: string;
  origin?: string;
  href?: string;
  transport?: string;
  status?: Record<string, unknown>;
}

interface WebMcpPageEvent {
  seq: number;
  type: string;
  text?: string;
  reset?: boolean;
  name?: string;
  callId?: string | null;
  arguments?: unknown;
  isError?: boolean;
  error?: string;
  [key: string]: unknown;
}

interface WebMcpTurnSnapshot {
  inputId: string;
  state: "running" | "completed" | "cancelled" | "error";
  text?: string;
  error?: string | null;
  events: WebMcpPageEvent[];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`WebMCP command transport is missing ${label}.`);
  return value;
}

export class WebMcpCommandTransport implements WebWorkerTransport {
  private readonly activeInputs = new Map<string, string>();
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly commands: WebMcpCommandExecutor,
    options: WebMcpCommandTransportOptions = {},
  ) {
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 250);
    this.now = options.now ?? (() => new Date());
  }

  async describe(): Promise<WebWorkerTransportDescriptor> {
    return {
      id: "webmcp.integrated-browser",
      label: "Web AI · Integrated Browser",
      site: "dynamic",
      availability: "available",
      capabilities: {
        streaming: true,
        reasoning: false,
        capabilityRequests: true,
        imageInput: false,
        checkpoints: false,
        interruption: true,
        persistentContext: true,
      },
      extensions: { control: "vscode-command", pageRuntime: "webmcp-v25" },
    };
  }

  async connect(options: WebWorkerTransportSessionOptions): Promise<WebWorkerTransportSession> {
    const connected = await this.execute<WebMcpConnectedPage>("_shuncode.webMcp.workerConnect", {
      prime: true,
      model: options.model,
      workspaceRoot: options.workspaceRoot,
      contextHandle: options.contextHandle,
      extensions: options.extensions,
    });
    const sessionId = requiredString(connected.sessionId, "page session id");
    const pageId = requiredString(connected.pageId, "page id");
    return {
      sessionId,
      site: connected.site,
      origin: connected.origin,
      href: connected.href,
      model: options.model,
      createdAt: this.now().toISOString(),
      extensions: {
        pageId,
        transport: connected.transport,
        status: connected.status,
      },
    };
  }

  async *send(session: WebWorkerTransportSession, input: WebWorkerTransportInput): AsyncIterable<WebWorkerTransportEvent> {
    const pageId = this.pageId(session);
    if (this.activeInputs.has(session.sessionId)) throw new Error(`WebMCP page session already has an active input: ${session.sessionId}`);
    this.activeInputs.set(session.sessionId, input.inputId);
    let cursor = 0;
    let terminal = false;
    try {
      let snapshot = await this.execute<WebMcpTurnSnapshot>("_shuncode.webMcp.workerSend", {
        pageId,
        sessionId: session.sessionId,
        input,
      });
      while (true) {
        for (const event of [...(snapshot.events ?? [])].sort((a, b) => a.seq - b.seq)) {
          if (!Number.isFinite(event.seq) || event.seq <= cursor) continue;
          cursor = event.seq;
          for (const mapped of this.mapEvent(event, snapshot)) {
            if (mapped.type === "completed" || mapped.type === "cancelled" || mapped.type === "error") terminal = true;
            yield mapped;
          }
        }
        if (terminal) return;
        if (snapshot.state !== "running") {
          terminal = true;
          yield this.snapshotTerminal(snapshot);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
        snapshot = await this.execute<WebMcpTurnSnapshot>("_shuncode.webMcp.workerPoll", {
          pageId,
          sessionId: session.sessionId,
          inputId: input.inputId,
        });
      }
    } finally {
      if (this.activeInputs.get(session.sessionId) === input.inputId) this.activeInputs.delete(session.sessionId);
    }
  }

  async interrupt(session: WebWorkerTransportSession): Promise<void> {
    const inputId = this.activeInputs.get(session.sessionId);
    if (!inputId) return;
    await this.execute("_shuncode.webMcp.workerInterrupt", {
      pageId: this.pageId(session),
      sessionId: session.sessionId,
      inputId,
    });
  }

  async submitCapabilityResult(session: WebWorkerTransportSession, result: WorkerCapabilityResultInput): Promise<void> {
    await this.execute("_shuncode.webMcp.workerResolve", {
      pageId: this.pageId(session),
      sessionId: session.sessionId,
      result,
    });
  }

  async health(session?: WebWorkerTransportSession): Promise<WorkerHealth> {
    if (!session) {
      return { status: "healthy", checkedAt: this.now().toISOString(), message: "WebMCP command transport loaded." };
    }
    try {
      const response = await this.execute<{ status?: Record<string, unknown> }>("_shuncode.webMcp.workerHealth", {
        pageId: this.pageId(session),
        sessionId: session.sessionId,
      });
      const status = response.status ?? {};
      const healthy = status.enabled === true && status.composerFound === true && status.isDeepSeekAuthPage !== true;
      return {
        status: healthy ? "healthy" : "degraded",
        checkedAt: this.now().toISOString(),
        message: healthy ? undefined : "WebMCP page is connected but not ready for a worker turn.",
        extensions: { pageStatus: status },
      };
    } catch (error) {
      return { status: "offline", checkedAt: this.now().toISOString(), message: error instanceof Error ? error.message : String(error) };
    }
  }

  async disconnect(session: WebWorkerTransportSession): Promise<void> {
    await this.execute("_shuncode.webMcp.workerDisconnect", {
      pageId: this.pageId(session),
      sessionId: session.sessionId,
    });
    this.activeInputs.delete(session.sessionId);
  }

  private mapEvent(event: WebMcpPageEvent, snapshot: WebMcpTurnSnapshot): WebWorkerTransportEvent[] {
    switch (event.type) {
      case "assistant_text":
        return event.reset
          ? [{ type: "status", name: "assistant_text_reset", data: { seq: event.seq } }, { type: "assistant_text", text: String(event.text ?? "") }]
          : [{ type: "assistant_text", text: String(event.text ?? "") }];
      case "capability_call":
        return [{
          type: "capability_call",
          callId: event.callId || undefined,
          name: String(event.name ?? ""),
          arguments: event.arguments,
          dispatch: event.dispatch === "host-requested" ? "host-requested" : "observed",
        }];
      case "capability_result":
        return [{ type: "capability_result", callId: event.callId || undefined, name: String(event.name ?? ""), text: typeof event.text === "string" ? event.text : undefined, isError: event.isError === true }];
      case "status":
        return [{ type: "status", name: String(event.name ?? "webmcp"), data: { ...event } }];
      case "completed":
        return [{ type: "completed", result: { text: snapshot.text ?? event.text ?? "" } }];
      case "cancelled":
        return [{ type: "cancelled", result: { interrupted: event.interrupted === true } }];
      case "error":
        return [{ type: "error", error: String(event.error ?? snapshot.error ?? "WebMCP worker turn failed") }];
      default:
        return [{ type: "status", name: `webmcp.${event.type || "event"}`, data: { ...event } }];
    }
  }

  private snapshotTerminal(snapshot: WebMcpTurnSnapshot): WebWorkerTransportEvent {
    if (snapshot.state === "completed") return { type: "completed", result: { text: snapshot.text ?? "" } };
    if (snapshot.state === "cancelled") return { type: "cancelled" };
    return { type: "error", error: snapshot.error || "WebMCP worker turn failed." };
  }

  private pageId(session: WebWorkerTransportSession): string {
    return requiredString(session.extensions?.pageId, "page id");
  }

  private async execute<T = unknown>(command: string, arg: unknown): Promise<T> {
    const result = await this.commands.executeCommand<T>(command, arg);
    if (result === undefined) throw new Error(`WebMCP command returned no result: ${command}`);
    return result;
  }
}
