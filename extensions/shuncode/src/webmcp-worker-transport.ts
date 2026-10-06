import type {
  WebWorkerTransport,
  WebWorkerTransportDescriptor,
  WebWorkerTransportEvent,
  WebWorkerTransportInput,
  WebWorkerTransportSession,
  WebWorkerTransportSessionOptions,
} from "../../../src/web-worker-adapter.js";
import type { WorkerDescriptor, WorkerHealth } from "../../../src/worker-contract.js";
import type { WorkerCapabilityResultInput } from "../../../src/worker-contract.js";

export interface WebMcpCommandExecutor {
  executeCommand<T>(command: string, ...args: unknown[]): PromiseLike<T | undefined>;
}

export interface WebMcpCommandTransportOptions {
  pollIntervalMs?: number;
  noProgressTimeoutMs?: number;
  now?: () => Date;
  capabilityProjection?: WorkerDescriptor["capabilityProjection"] | (() => WorkerDescriptor["capabilityProjection"]);
  prepareInput?: (input: WebWorkerTransportInput) => WebWorkerTransportInput;
}

export const DEFAULT_WEBMCP_NO_PROGRESS_TIMEOUT_MS = 300_000;

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
  toolCallCount?: number;
  events: WebMcpPageEvent[];
  controlLineage?: {
    sessionId?: string;
    origin?: string;
    href?: string;
    site?: string;
  };
}

interface WebMcpInterruptAttempt {
  inputId: string;
  reason: "explicit" | "timeout";
  promise: Promise<void>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`WebMCP command transport is missing ${label}.`);
  return value;
}

export class WebMcpCommandTransport implements WebWorkerTransport {
  private readonly activeInputs = new Map<string, string>();
  private readonly interruptAttempts = new Map<string, WebMcpInterruptAttempt>();
  private readonly pollIntervalMs: number;
  private readonly noProgressTimeoutMs: number;
  private readonly now: () => Date;
  private readonly capabilityProjection: WebMcpCommandTransportOptions["capabilityProjection"];
  private readonly prepareInput: ((input: WebWorkerTransportInput) => WebWorkerTransportInput) | undefined;

  constructor(
    private readonly commands: WebMcpCommandExecutor,
    options: WebMcpCommandTransportOptions = {},
  ) {
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 250);
    this.noProgressTimeoutMs = Number.isFinite(options.noProgressTimeoutMs)
      ? Math.max(1, Number(options.noProgressTimeoutMs))
      : DEFAULT_WEBMCP_NO_PROGRESS_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
    this.capabilityProjection = options.capabilityProjection;
    this.prepareInput = options.prepareInput;
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
      capabilityProjection: typeof this.capabilityProjection === "function"
        ? this.capabilityProjection()
        : this.capabilityProjection,
      extensions: {
        control: "vscode-command",
        pageRuntime: "webmcp-v25",
        noProgressTimeoutMs: this.noProgressTimeoutMs,
      },
    };
  }

  async connect(options: WebWorkerTransportSessionOptions): Promise<WebWorkerTransportSession> {
    const connected = await this.execute<WebMcpConnectedPage>("_shuncode.webMcp.workerConnect", {
      // Production Mission turns receive exact Phase-8 schemas in the Worker
      // input. Never prime the shared page with the Gateway's global tool list.
      prime: false,
      model: options.model,
      workspaceRoot: options.workspaceRoot,
      contextHandle: options.contextHandle,
      target: options.extensions?.webMcpTarget,
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
    // A caller may shorten its idle budget, never extend the configured ceiling.
    // This changes observation/interrupt timing only, not retry authority.
    const requestedTimeout = input.extensions?.noProgressTimeoutMs;
    const noProgressTimeoutMs = typeof requestedTimeout === "number" && Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(this.noProgressTimeoutMs, Math.max(1, requestedTimeout)) : this.noProgressTimeoutMs;
    const controlTarget = this.controlTarget(session);
    if (this.activeInputs.has(session.sessionId)) throw new Error(`WebMCP page session already has an active input: ${session.sessionId}`);
    this.activeInputs.set(session.sessionId, input.inputId);
    let cursor = 0;
    let terminal = false;
    let polledAfterAcceptedSend = false;
    let lastProgressAt = 0;
    let observedText = "";
    let observedToolCallCount = 0;
    try {
      const effectiveInput = this.prepareInput ? this.prepareInput(input) : input;
      let snapshot = await this.execute<WebMcpTurnSnapshot>("_shuncode.webMcp.workerSend", {
        ...controlTarget,
        input: effectiveInput,
      });
      this.advanceProviderCanonicalHref(session, snapshot);
      // workerSend returns only after the page runtime crossed its accepted
      // send boundary, so the inactivity clock cannot start before this point.
      lastProgressAt = this.nowMs();
      while (true) {
        for (const event of [...(snapshot.events ?? [])].sort((a, b) => a.seq - b.seq)) {
          if (!Number.isFinite(event.seq) || event.seq <= cursor) continue;
          cursor = event.seq;
          if (this.isProviderProgressEvent(event)) lastProgressAt = this.nowMs();
          for (const mapped of this.mapEvent(event, snapshot)) {
            if (mapped.type === "completed" || mapped.type === "cancelled" || mapped.type === "error") terminal = true;
            yield mapped;
          }
        }
        const snapshotText = typeof snapshot.text === "string" ? snapshot.text : "";
        if (snapshotText !== observedText) {
          observedText = snapshotText;
          lastProgressAt = this.nowMs();
        }
        const snapshotToolCallCount = Number.isFinite(snapshot.toolCallCount) ? Number(snapshot.toolCallCount) : observedToolCallCount;
        if (snapshotToolCallCount > observedToolCallCount) {
          observedToolCallCount = snapshotToolCallCount;
          lastProgressAt = this.nowMs();
        }
        if (terminal) return;
        if (snapshot.state !== "running") {
          terminal = true;
          yield this.snapshotTerminal(snapshot);
          return;
        }
        if (polledAfterAcceptedSend && this.nowMs() - lastProgressAt >= noProgressTimeoutMs) {
          const attempt = this.requestInterrupt(session, input.inputId, "timeout");
          let converged: WebMcpTurnSnapshot;
          try {
            await attempt.promise;
            converged = await this.execute<WebMcpTurnSnapshot>("_shuncode.webMcp.workerPoll", {
              ...controlTarget,
              inputId: input.inputId,
            });
            this.advanceProviderCanonicalHref(session, converged);
          } catch (error) {
            terminal = true;
            yield {
              type: "error",
              error: attempt.reason === "explicit"
                ? `WebMCP explicit interrupt convergence is ambiguous: ${error instanceof Error ? error.message : String(error)}`
                : `WebMCP worker turn timed out after ${noProgressTimeoutMs}ms without provider progress; automatic convergence is ambiguous: ${error instanceof Error ? error.message : String(error)}`,
              data: {
                code: attempt.reason === "explicit" ? "WEBMCP_INTERRUPT_AMBIGUOUS" : "WEBMCP_NO_PROGRESS_TIMEOUT_AMBIGUOUS",
                inputId: input.inputId,
                noProgressTimeoutMs,
              },
            };
            return;
          }
          if (attempt.reason === "explicit") {
            snapshot = converged;
            polledAfterAcceptedSend = true;
            continue;
          }
          terminal = true;
          const convergenceState = converged.state;
          yield {
            type: "error",
            error: convergenceState === "running"
              ? `WebMCP worker turn timed out after ${noProgressTimeoutMs}ms without provider progress; automatic convergence did not reach a terminal state.`
              : `WebMCP worker turn timed out after ${noProgressTimeoutMs}ms without provider progress.`,
            data: {
              code: convergenceState === "running" ? "WEBMCP_NO_PROGRESS_TIMEOUT_AMBIGUOUS" : "WEBMCP_NO_PROGRESS_TIMEOUT",
              inputId: input.inputId,
              noProgressTimeoutMs,
              convergenceState,
            },
          };
          return;
        }
        const remainingMs = Math.max(1, this.noProgressTimeoutMs - Math.max(0, this.nowMs() - lastProgressAt));
        await new Promise(resolve => setTimeout(resolve, Math.min(this.pollIntervalMs, remainingMs)));
        snapshot = await this.execute<WebMcpTurnSnapshot>("_shuncode.webMcp.workerPoll", {
          ...controlTarget,
          inputId: input.inputId,
        });
        this.advanceProviderCanonicalHref(session, snapshot);
        polledAfterAcceptedSend = true;
      }
    } finally {
      if (this.activeInputs.get(session.sessionId) === input.inputId) this.activeInputs.delete(session.sessionId);
      const interruptAttempt = this.interruptAttempts.get(session.sessionId);
      if (interruptAttempt?.inputId === input.inputId) this.interruptAttempts.delete(session.sessionId);
    }
  }

  async interrupt(session: WebWorkerTransportSession): Promise<void> {
    const inputId = this.activeInputs.get(session.sessionId);
    if (!inputId) return;
    await this.requestInterrupt(session, inputId, "explicit").promise;
  }

  async submitCapabilityResult(session: WebWorkerTransportSession, result: WorkerCapabilityResultInput): Promise<void> {
    await this.execute("_shuncode.webMcp.workerResolve", {
      ...this.controlTarget(session),
      result,
    });
  }

  async health(session?: WebWorkerTransportSession): Promise<WorkerHealth> {
    if (!session) {
      return { status: "healthy", checkedAt: this.now().toISOString(), message: "WebMCP command transport loaded." };
    }
    try {
      const response = await this.execute<{ status?: Record<string, unknown> }>("_shuncode.webMcp.workerHealth", {
        ...this.controlTarget(session),
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
      ...this.controlTarget(session),
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
          extensions: typeof event.occurrenceId === "string" && event.occurrenceId
            ? { occurrenceId: event.occurrenceId }
            : undefined,
        }];
      case "capability_result":
        return [{
          type: "capability_result",
          callId: event.callId || undefined,
          name: String(event.name ?? ""),
          text: typeof event.text === "string" ? event.text : undefined,
          isError: event.isError === true,
          extensions: typeof event.occurrenceId === "string" && event.occurrenceId
            ? { occurrenceId: event.occurrenceId }
            : undefined,
        }];
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

  private isProviderProgressEvent(event: WebMcpPageEvent): boolean {
    if (event.type === "assistant_text" || event.type === "capability_call" || event.type === "capability_result") return true;
    if (event.type !== "status") return false;
    return event.name === "capability_rejected"
      || event.name === "capability_result_received"
      || event.name === "capability_result_delivered";
  }

  private requestInterrupt(
    session: WebWorkerTransportSession,
    inputId: string,
    reason: WebMcpInterruptAttempt["reason"],
  ): WebMcpInterruptAttempt {
    const existing = this.interruptAttempts.get(session.sessionId);
    if (existing?.inputId === inputId) return existing;
    const promise = this.execute("_shuncode.webMcp.workerInterrupt", {
      ...this.controlTarget(session),
      inputId,
    }).then(() => undefined);
    const attempt = { inputId, reason, promise };
    this.interruptAttempts.set(session.sessionId, attempt);
    return attempt;
  }

  private nowMs(): number {
    const value = this.now().getTime();
    return Number.isFinite(value) ? value : Date.now();
  }

  private pageId(session: WebWorkerTransportSession): string {
    return requiredString(session.extensions?.pageId, "page id");
  }

  private controlTarget(session: WebWorkerTransportSession) {
    return {
      pageId: this.pageId(session),
      sessionId: requiredString(session.sessionId, "page session id"),
      expectedOrigin: requiredString(session.origin, "page origin"),
      expectedHref: requiredString(session.href, "page href"),
      expectedSite: requiredString(session.site, "page site"),
    };
  }

  private advanceProviderCanonicalHref(session: WebWorkerTransportSession, snapshot: WebMcpTurnSnapshot): void {
    const lineage = snapshot.controlLineage;
    if (!lineage) return;
    const sessionId = requiredString(lineage.sessionId, "control lineage session id");
    const origin = requiredString(lineage.origin, "control lineage origin");
    const href = requiredString(lineage.href, "control lineage href");
    const site = requiredString(lineage.site, "control lineage site");
    if (sessionId !== session.sessionId || origin !== session.origin || site !== session.site) {
      throw new Error("WebMCP control lineage does not match the connected WorkerSession.");
    }
    const previousHref = requiredString(session.href, "page href");
    if (href === previousHref) return;
    if (!this.isDeepSeekInitialCanonicalHrefAdvance(site, origin, previousHref, href)) {
      throw new Error(`WebMCP WorkerSession href changed outside the admitted provider canonical transition: ${previousHref} -> ${href}`);
    }
    session.href = href;
  }

  private isDeepSeekInitialCanonicalHrefAdvance(site: string, origin: string, previousHref: string, nextHref: string): boolean {
    if (site !== "deepseek" || origin !== "https://chat.deepseek.com") return false;
    try {
      const previous = new URL(previousHref);
      const next = new URL(nextHref);
      if (previous.origin !== origin || next.origin !== origin) return false;
      const previousPath = previous.pathname.replace(/\/+$/, "") || "/";
      if (previousPath !== "/" && previousPath !== "/chat") return false;
      return /^\/a\/chat\/s\/[A-Za-z0-9-]+\/?$/.test(next.pathname);
    } catch {
      return false;
    }
  }

  private async execute<T = unknown>(command: string, arg: unknown): Promise<T> {
    const result = await this.commands.executeCommand<T>(command, arg);
    if (result === undefined) throw new Error(`WebMCP command returned no result: ${command}`);
    return result;
  }
}
