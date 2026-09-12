import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import * as vscode from "vscode";
import { fetchThroughExtensionHostProxy, resolveExtensionHostProxy } from "./extension-host-proxy.mjs";
import type { IdeToolBroker } from "./ide-tool-broker.js";

interface RpcResponse {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

export class RuntimeRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(`Runtime ${code}: ${message}`);
    this.name = "RuntimeRpcError";
  }
}

export interface RuntimeHello {
  name: string;
  protocolVersion: number;
  pid: number;
  node: string;
  platform: string;
  tools: string[];
  capabilities?: {
    history?: boolean;
    traceNotifications?: boolean;
    bidirectionalRpc?: boolean;
    ideToolBroker?: boolean;
    unboundedAgentLoop?: boolean;
    cancellation?: boolean;
    imageInput?: boolean;
    deepSeekV4?: boolean;
    streamingModelResponses?: boolean;
    recoverableCheckpoints?: boolean;
    extensionHostFetchProxy?: boolean;
  };
}

export interface AgentHistoryItem {
  role: "user" | "assistant";
  content: string;
  images?: AgentImageInput[];
}

export interface AgentImageInput {
  mimeType: string;
  data: string;
  name?: string;
}

export interface RuntimeTraceItem {
  type: "model" | "model_delta" | "model_thinking_delta" | "tool_call" | "tool_result";
  step: number;
  data: unknown;
}

export interface RuntimeAgentCheckpoint {
  version: 1;
  model: string;
  workspaceRoot: string;
  nextStep: number;
  toolNames: string[];
  messages: Array<Record<string, unknown>>;
  createdAt: string;
}

export interface RuntimeToolDefinition {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export class RuntimeClient implements vscode.Disposable {
  private process: ChildProcessWithoutNullStreams | undefined;
  private pending = new Map<number, PendingRequest>();
  private traceListeners = new Map<string, (item: RuntimeTraceItem) => void>();
  private checkpointListeners = new Map<string, (checkpoint: RuntimeAgentCheckpoint) => void>();
  private runContexts = new Map<string, {
    toolInvocationToken?: vscode.ChatParticipantToolToken;
    cancellationToken: vscode.CancellationToken;
    registeredToolNames: Set<string>;
  }>();
  private networkFetchControllers = new Map<string, AbortController>();
  private nextId = 1;
  private nextRunId = 1;
  private starting: Promise<RuntimeHello> | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly ideToolBroker: IdeToolBroker,
  ) {}

  async start(): Promise<RuntimeHello> {
    if (this.process && !this.process.killed) {
      return this.request<RuntimeHello>("runtime/hello", {}, 10_000);
    }
    if (this.starting) return this.starting;

    this.starting = this.startProcess();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async restart(): Promise<RuntimeHello> {
    this.stop();
    return this.start();
  }

  async runAgent(
    params: {
      protocol?: "chat-completions" | "codex-responses" | "openai-responses" | "anthropic-messages";
      baseUrl: string;
      apiKey?: string;
      codexAuth?: {
        accessToken: string;
        accountId: string;
        originator: string;
        userAgent: string;
        betaHeader: string;
      };
      model: string;
      firstTokenTimeoutMs?: number;
      idleTimeoutMs?: number;
      totalTimeoutMs?: number;
      requestTimeoutMs?: number;
      retries?: number;
      deepSeek?: boolean;
      imageInput?: boolean;
      thinking?: "enabled" | "disabled";
      reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
      serviceTier?: "default" | "priority" | "fast";
      contextWindow?: number;
      maxOutputTokens?: number;
      prompt: string;
      images?: AgentImageInput[];
      workspaceRoot: string;
      history?: AgentHistoryItem[];
      allowedTools?: string[];
      externalTools?: RuntimeToolDefinition[];
      modeInstructions?: string;
      checkpoint?: RuntimeAgentCheckpoint;
    },
    onTrace?: (item: RuntimeTraceItem) => void,
    onCheckpoint?: (checkpoint: RuntimeAgentCheckpoint) => void,
    invocationContext?: { toolInvocationToken?: vscode.ChatParticipantToolToken; cancellationToken: vscode.CancellationToken },
  ): Promise<any> {
    await this.start();
    const runId = `run-${Date.now()}-${this.nextRunId++}`;
    if (onTrace) this.traceListeners.set(runId, onTrace);
    if (onCheckpoint) this.checkpointListeners.set(runId, onCheckpoint);
    if (invocationContext) {
      this.runContexts.set(runId, {
        ...invocationContext,
        registeredToolNames: new Set((params.externalTools ?? []).map((tool) => tool.name)),
      });
    }
    const runPromise = this.request("agent/run", { ...params, runId });
    const cancellation = invocationContext?.cancellationToken.onCancellationRequested(() => {
      void this.request("agent/cancel", { runId }, 10_000).catch((error) => {
        this.output.appendLine(`[runtime] failed to cancel ${runId}: ${error instanceof Error ? error.message : String(error)}`);
      });
    });
    if (invocationContext?.cancellationToken.isCancellationRequested) {
      void this.request("agent/cancel", { runId }, 10_000).catch(() => undefined);
    }
    try {
      return await runPromise;
    } finally {
      cancellation?.dispose();
      this.traceListeners.delete(runId);
      this.checkpointListeners.delete(runId);
      this.runContexts.delete(runId);
    }
  }

  async hello(): Promise<RuntimeHello> {
    await this.start();
    return this.request<RuntimeHello>("runtime/hello", {}, 10_000);
  }

  dispose(): void {
    this.stop();
  }

  private resolveEntryPoint(): string {
    const configured = vscode.workspace.getConfiguration("shuncode").get<string>("runtime.entryPoint")?.trim();
    const candidates = [
      configured,
      process.env.SHUNCODE_AGENT_HOST_ENTRY,
      this.context.asAbsolutePath(path.join("runtime", "agent-host.js")),
      ...(vscode.workspace.workspaceFolders ?? []).map((folder) => path.join(folder.uri.fsPath, "dist", "src", "agent-host.js")),
    ].filter((value): value is string => Boolean(value));

    const fs = require("node:fs") as typeof import("node:fs");
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) return path.resolve(found);

    throw new Error(
      "ShunCode Agent Runtime was not found. Run the carrier through scripts/shuncode-dev.bat or set shuncode.runtime.entryPoint to dist/src/agent-host.js.",
    );
  }

  private async startProcess(): Promise<RuntimeHello> {
    const entryPoint = this.resolveEntryPoint();
    this.output.appendLine(`[runtime] starting ${entryPoint}`);

    const child = spawn(process.execPath, [entryPoint], {
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionPath,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.process = child;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => this.output.append(String(chunk)));
    child.on("exit", (code, signal) => {
      this.output.appendLine(`[runtime] exited code=${String(code)} signal=${String(signal)}`);
      if (this.process === child) this.process = undefined;
      this.rejectPending(new Error(`ShunCode Agent Runtime exited (code=${String(code)}, signal=${String(signal)}).`));
    });
    child.on("error", (error) => {
      this.output.appendLine(`[runtime] process error: ${error.message}`);
      this.rejectPending(error);
    });

    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.handleLine(line));

    return this.request<RuntimeHello>("runtime/hello", {}, 15_000);
  }

  private request<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    const child = this.process;
    if (!child || child.killed) return Promise.reject(new Error("ShunCode Agent Runtime is not running."));

    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Runtime request timed out: ${method}`));
          }, timeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });

      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`, (error) => {
        if (!error) return;
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private handleLine(line: string): void {
    let response: RpcResponse;
    try {
      response = JSON.parse(line) as RpcResponse;
    } catch {
      this.output.appendLine(`[runtime] non-JSON stdout: ${line}`);
      return;
    }

    if (response.method === "ide/tool/invoke" && response.id !== undefined) {
      void this.handleIdeToolRequest(response);
      return;
    }

    if (response.method === "network/fetch" && response.id !== undefined) {
      void this.handleNetworkFetchRequest(response);
      return;
    }

    if (response.method === "network/fetch/cancel") {
      const params = response.params && typeof response.params === "object" ? response.params as Record<string, unknown> : {};
      const streamId = typeof params.streamId === "string" ? params.streamId : "";
      this.networkFetchControllers.get(streamId)?.abort(new Error("Runtime canceled the network request."));
      return;
    }

    if (response.method === "agent/trace") {
      const params = response.params as { runId?: unknown; item?: unknown } | undefined;
      const runId = typeof params?.runId === "string" ? params.runId : undefined;
      if (runId) {
        const listener = this.traceListeners.get(runId);
        if (listener && params?.item && typeof params.item === "object") {
          listener(params.item as RuntimeTraceItem);
        }
      }
      return;
    }

    if (response.method === "agent/checkpoint") {
      const params = response.params as { runId?: unknown; checkpoint?: unknown } | undefined;
      const runId = typeof params?.runId === "string" ? params.runId : undefined;
      if (runId && params?.checkpoint && typeof params.checkpoint === "object" && !Array.isArray(params.checkpoint)) {
        this.checkpointListeners.get(runId)?.(params.checkpoint as RuntimeAgentCheckpoint);
      }
      return;
    }

    if (response.id === undefined) {
      this.output.appendLine(`[runtime] unexpected notification: ${line}`);
      return;
    }

    const id = Number(response.id);
    const pending = this.pending.get(id);
    if (!pending) {
      this.output.appendLine(`[runtime] unexpected response id=${String(response.id)}`);
      return;
    }

    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(id);
    if (response.error) {
      pending.reject(new RuntimeRpcError(response.error.code, response.error.message, response.error.data));
    } else {
      pending.resolve(response.result);
    }
  }

  private async handleIdeToolRequest(request: RpcResponse): Promise<void> {
    const child = this.process;
    if (!child || child.killed || request.id === undefined) return;
    const params = request.params && typeof request.params === "object" ? request.params as Record<string, unknown> : {};
    const runId = typeof params.runId === "string" ? params.runId : "";
    const name = typeof params.name === "string" ? params.name : "";
    const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
      ? params.arguments as Record<string, unknown>
      : {};
    const context = this.runContexts.get(runId);
    try {
      if (!context) throw new Error(`Unknown or inactive runId: ${runId}`);
      if (!name) throw new Error("IDE tool request is missing a tool name.");
      const result = await this.ideToolBroker.invoke(name, args, context, context.registeredToolNames.has(name));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32010, message } })}\n`);
    }
  }

  private errorChain(error: unknown): string {
    const messages: string[] = [];
    let current: unknown = error;
    for (let depth = 0; depth < 6 && current; depth += 1) {
      const message = current instanceof Error ? current.message : String(current);
      if (message && !messages.includes(message)) messages.push(message);
      current = current instanceof Error ? current.cause : undefined;
    }
    return messages.join(": ") || "Unknown network error";
  }

  private async handleNetworkFetchRequest(request: RpcResponse): Promise<void> {
    const child = this.process;
    if (!child || child.killed || request.id === undefined) return;
    const streamId = String(request.id);
    const params = request.params && typeof request.params === "object" && !Array.isArray(request.params)
      ? request.params as Record<string, unknown>
      : {};
    const controller = new AbortController();
    this.networkFetchControllers.set(streamId, controller);
    let responseStarted = false;
    const send = (payload: unknown): void => {
      if (!child.killed) child.stdin.write(`${JSON.stringify(payload)}\n`);
    };
    try {
      const url = typeof params.url === "string" ? params.url : "";
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error("Only HTTP and HTTPS URLs are supported.");
      const headers = new Headers();
      if (params.headers && typeof params.headers === "object" && !Array.isArray(params.headers)) {
        for (const [key, value] of Object.entries(params.headers as Record<string, unknown>)) {
          if (typeof value === "string") headers.set(key, value);
        }
      }
      const method = typeof params.method === "string" ? params.method : "GET";
      const httpConfiguration = vscode.workspace.getConfiguration("http");
      const configuredProxy = httpConfiguration.get<string>("proxy")?.trim();
      const proxySupport = httpConfiguration.get<string>("proxySupport");
      const proxyUrl = proxySupport === "off" ? undefined : resolveExtensionHostProxy(parsedUrl, configuredProxy);
      const response = proxyUrl
        ? await fetchThroughExtensionHostProxy(parsedUrl, {
          method,
          headers,
          body: typeof params.body === "string" ? params.body : undefined,
          signal: controller.signal,
          proxyUrl,
          rejectUnauthorized: httpConfiguration.get<boolean>("proxyStrictSSL", true),
        })
        : await fetch(parsedUrl, {
          method,
          headers,
          body: typeof params.body === "string" ? params.body : undefined,
          signal: controller.signal,
        });
      responseStarted = true;
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries()),
        },
      });
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            for (let offset = 0; offset < chunk.value.byteLength; offset += 64 * 1024) {
              const slice = chunk.value.subarray(offset, Math.min(chunk.value.byteLength, offset + 64 * 1024));
              send({ jsonrpc: "2.0", method: "network/fetch/chunk", params: { streamId, data: Buffer.from(slice).toString("base64") } });
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      send({ jsonrpc: "2.0", method: "network/fetch/end", params: { streamId } });
    } catch (error) {
      const message = this.errorChain(error);
      if (responseStarted) {
        send({ jsonrpc: "2.0", method: "network/fetch/error", params: { streamId, message } });
      } else {
        send({ jsonrpc: "2.0", id: request.id, error: { code: -32020, message: `Extension-host fetch failed: ${message}` } });
      }
    } finally {
      this.networkFetchControllers.delete(streamId);
    }
  }

  private stop(): void {
    const child = this.process;
    this.process = undefined;
    if (child && !child.killed) child.kill();
    this.traceListeners.clear();
    this.runContexts.clear();
    for (const controller of this.networkFetchControllers.values()) controller.abort(new Error("ShunCode Agent Runtime stopped."));
    this.networkFetchControllers.clear();
    this.rejectPending(new Error("ShunCode Agent Runtime stopped."));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
