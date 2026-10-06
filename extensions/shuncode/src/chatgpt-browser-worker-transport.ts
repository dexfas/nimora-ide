import type {
  WebWorkerTransport,
  WebWorkerTransportDescriptor,
  WebWorkerTransportEvent,
  WebWorkerTransportInput,
  WebWorkerTransportSession,
  WebWorkerTransportSessionOptions,
} from "../../../src/web-worker-adapter.js";
import type { WorkerDescriptor, WorkerHealth } from "../../../src/worker-contract.js";
import type { WebMcpCommandExecutor } from "./webmcp-worker-transport.js";

interface ConnectedChatGptPage {
  pageId: string;
  sessionId: string;
  site?: string;
  origin?: string;
  href?: string;
  conversationId?: string;
  transport?: string;
}

interface ChatGptPageEvent {
  seq: number;
  type: string;
  text?: string;
  reset?: boolean;
  name?: string;
  error?: string;
  [key: string]: unknown;
}

interface ChatGptTurnSnapshot {
  inputId: string;
  state: "running" | "completed" | "cancelled" | "error";
  text?: string;
  error?: string | null;
  events: ChatGptPageEvent[];
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`ChatGPT browser transport is missing ${label}.`);
  return value;
}

export interface ChatGptBrowserCommandTransportOptions {
  pollIntervalMs?: number;
  now?: () => Date;
  capabilityProjection?: WorkerDescriptor["capabilityProjection"] | (() => WorkerDescriptor["capabilityProjection"]);
}

/**
 * Distinct ChatGPT browser-chat Worker transport. It uses exact shared-page
 * Integrated Browser tools; it never injects the WebMCP page/tool protocol.
 */
export class ChatGptBrowserCommandTransport implements WebWorkerTransport {
  private readonly activeInputs = new Map<string, string>();
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly capabilityProjection: ChatGptBrowserCommandTransportOptions["capabilityProjection"];

  constructor(
    private readonly commands: WebMcpCommandExecutor,
    options: ChatGptBrowserCommandTransportOptions = {},
  ) {
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 300);
    this.now = options.now ?? (() => new Date());
    this.capabilityProjection = options.capabilityProjection;
  }

  async describe(): Promise<WebWorkerTransportDescriptor> {
    const capabilityProjection = typeof this.capabilityProjection === "function"
      ? this.capabilityProjection()
      : this.capabilityProjection;
    return {
      id: "chatgpt.integrated-browser",
      label: "ChatGPT · Integrated Browser",
      site: "chatgpt",
      availability: "available",
      capabilities: {
        streaming: true,
        reasoning: false,
        capabilityRequests: false,
        imageInput: false,
        checkpoints: false,
        interruption: true,
        persistentContext: true,
      },
      capabilityProjection,
      extensions: {
        control: "vscode-command",
        nativeMcp: capabilityProjection?.nativeByName === true,
        webMcpInjection: false,
      },
    };
  }

  async connect(options: WebWorkerTransportSessionOptions): Promise<WebWorkerTransportSession> {
    const connected = await this.execute<ConnectedChatGptPage>("_shuncode.chatgptWorker.connect", {
      target: options.extensions?.chatGptTarget,
      model: options.model,
      workspaceRoot: options.workspaceRoot,
      contextHandle: options.contextHandle,
      extensions: options.extensions,
    });
    const sessionId = requiredString(connected.sessionId, "browser session id");
    return {
      sessionId,
      site: "chatgpt",
      origin: connected.origin,
      href: connected.href,
      model: options.model,
      createdAt: this.now().toISOString(),
      extensions: {
        pageId: requiredString(connected.pageId, "page id"),
        conversationId: connected.conversationId,
        transport: connected.transport,
      },
    };
  }

  async *send(session: WebWorkerTransportSession, input: WebWorkerTransportInput): AsyncIterable<WebWorkerTransportEvent> {
    const pageId = this.pageId(session);
    if (this.activeInputs.has(session.sessionId)) throw new Error(`ChatGPT browser session already has an active input: ${session.sessionId}`);
    this.activeInputs.set(session.sessionId, input.inputId);
    let cursor = 0;
    let terminal = false;
    try {
      let snapshot = await this.execute<ChatGptTurnSnapshot>("_shuncode.chatgptWorker.send", {
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
          yield this.snapshotTerminal(snapshot);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, this.pollIntervalMs));
        snapshot = await this.execute<ChatGptTurnSnapshot>("_shuncode.chatgptWorker.poll", {
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
    await this.execute("_shuncode.chatgptWorker.interrupt", {
      pageId: this.pageId(session),
      sessionId: session.sessionId,
      inputId,
    });
  }

  async health(session?: WebWorkerTransportSession): Promise<WorkerHealth> {
    if (!session) {
      return { status: "healthy", checkedAt: this.now().toISOString(), message: "ChatGPT browser command transport loaded." };
    }
    try {
      const response = await this.execute<{ observation?: { ready?: boolean; composerFound?: boolean } }>("_shuncode.chatgptWorker.health", {
        pageId: this.pageId(session),
        sessionId: session.sessionId,
      });
      const healthy = response.observation?.ready === true && response.observation?.composerFound === true;
      return {
        status: healthy ? "healthy" : "degraded",
        checkedAt: this.now().toISOString(),
        message: healthy ? undefined : "ChatGPT shared page is connected but not ready for a worker turn.",
        extensions: { observation: response.observation },
      };
    } catch (error) {
      return { status: "offline", checkedAt: this.now().toISOString(), message: error instanceof Error ? error.message : String(error) };
    }
  }

  async disconnect(session: WebWorkerTransportSession): Promise<void> {
    await this.execute("_shuncode.chatgptWorker.disconnect", {
      pageId: this.pageId(session),
      sessionId: session.sessionId,
    });
    this.activeInputs.delete(session.sessionId);
  }

  private mapEvent(event: ChatGptPageEvent, snapshot: ChatGptTurnSnapshot): WebWorkerTransportEvent[] {
    switch (event.type) {
      case "assistant_text":
        return event.reset
          ? [{ type: "status", name: "assistant_text_reset", data: { seq: event.seq } }, { type: "assistant_text", text: String(event.text ?? "") }]
          : [{ type: "assistant_text", text: String(event.text ?? "") }];
      case "status":
        return [{ type: "status", name: String(event.name ?? "chatgpt"), data: { ...event } }];
      case "completed":
        return [{ type: "completed", result: { text: snapshot.text ?? event.text ?? "" } }];
      case "cancelled":
        return [{ type: "cancelled", result: { interrupted: event.interrupted === true } }];
      case "error":
        return [{ type: "error", error: String(event.error ?? snapshot.error ?? "ChatGPT browser worker turn failed") }];
      default:
        return [{ type: "status", name: `chatgpt.${event.type || "event"}`, data: { ...event } }];
    }
  }

  private snapshotTerminal(snapshot: ChatGptTurnSnapshot): WebWorkerTransportEvent {
    if (snapshot.state === "completed") return { type: "completed", result: { text: snapshot.text ?? "" } };
    if (snapshot.state === "cancelled") return { type: "cancelled" };
    return { type: "error", error: snapshot.error || "ChatGPT browser worker turn failed." };
  }

  private pageId(session: WebWorkerTransportSession): string {
    return requiredString(session.extensions?.pageId, "page id");
  }

  private async execute<T = unknown>(command: string, arg: unknown): Promise<T> {
    const result = await this.commands.executeCommand<T>(command, arg);
    if (result === undefined) throw new Error(`ChatGPT browser command returned no result: ${command}`);
    return result;
  }
}
