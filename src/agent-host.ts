import readline from "node:readline";
import { FILE_TOOL_NAMES } from "./file-tool-registry.js";
import { IDE_TOOL_DEFINITIONS, IDE_TOOL_NAMES } from "./ide-tool-definitions.js";
import { runOpenAICompatibleAgent, type AgentCheckpoint, type AgentHistoryItem, type AgentImageInput, type AgentTraceItem, type RunAgentInput } from "./openai-agent.js";

interface RpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: unknown;
}

interface RpcSuccess {
  jsonrpc: "2.0";
  id: string | number;
  result: unknown;
}

interface RpcFailure {
  jsonrpc: "2.0";
  id: string | number | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface RpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface PendingPeerRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface PeerFetchStream {
  controller: ReadableStreamDefaultController<Uint8Array>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

const PROTOCOL_VERSION = 8;
const TOOL_NAMES = [...FILE_TOOL_NAMES, ...IDE_TOOL_NAMES];
const peerPending = new Map<string, PendingPeerRequest>();
const peerFetchStreams = new Map<string, PeerFetchStream>();
const activeRuns = new Map<string, AbortController>();
let nextPeerRequestId = 1;

function writeMessage(message: RpcRequest | RpcSuccess | RpcFailure | RpcNotification): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("params must be an object");
  }
  return value as Record<string, unknown>;
}

function parseImages(value: unknown, label: string): AgentImageInput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array when provided`);
  if (value.length > 8) throw new Error(`${label} may contain at most 8 images`);
  return value.map((item, index) => {
    const row = asRecord(item);
    if (typeof row.mimeType !== "string" || !row.mimeType.startsWith("image/")) throw new Error(`${label}[${index}].mimeType must be an image MIME type`);
    if (typeof row.data !== "string" || !row.data) throw new Error(`${label}[${index}].data must be base64 text`);
    return {
      mimeType: row.mimeType,
      data: row.data,
      name: typeof row.name === "string" ? row.name : undefined,
    };
  });
}

function parseHistory(value: unknown): AgentHistoryItem[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("history must be an array when provided");
  return value.map((item, index) => {
    const row = asRecord(item);
    if (row.role !== "user" && row.role !== "assistant") {
      throw new Error(`history[${index}].role must be user or assistant`);
    }
    if (typeof row.content !== "string") {
      throw new Error(`history[${index}].content must be a string`);
    }
    return { role: row.role, content: row.content, images: parseImages(row.images, `history[${index}].images`) };
  });
}

function parseExternalTools(value: unknown): RunAgentInput["externalTools"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("externalTools must be an array when provided");
  if (value.length > 512) throw new Error("externalTools may contain at most 512 tools");
  const seen = new Set<string>();
  return value.map((item, index) => {
    const row = asRecord(item);
    const name = typeof row.name === "string" ? row.name.trim() : "";
    if (!name) throw new Error(`externalTools[${index}].name must be a non-empty string`);
    if (seen.has(name)) throw new Error(`externalTools contains duplicate tool name: ${name}`);
    seen.add(name);
    if (row.description !== undefined && typeof row.description !== "string") {
      throw new Error(`externalTools[${index}].description must be a string when provided`);
    }
    const inputSchema = row.inputSchema === undefined
      ? { type: "object", properties: {} }
      : asRecord(row.inputSchema);
    return {
      name,
      description: typeof row.description === "string" ? row.description : "",
      inputSchema,
    };
  });
}

function parseAgentCheckpoint(value: unknown): AgentCheckpoint | undefined {
  if (value === undefined) return undefined;
  const row = asRecord(value);
  if (row.version !== 1) throw new Error("checkpoint.version must be 1");
  if (typeof row.model !== "string" || !row.model) throw new Error("checkpoint.model must be a non-empty string");
  if (typeof row.workspaceRoot !== "string" || !row.workspaceRoot) throw new Error("checkpoint.workspaceRoot must be a non-empty string");
  if (!Number.isInteger(row.nextStep) || Number(row.nextStep) < 1) throw new Error("checkpoint.nextStep must be a positive integer");
  if (!Array.isArray(row.toolNames) || row.toolNames.some(name => typeof name !== "string")) {
    throw new Error("checkpoint.toolNames must be an array of strings");
  }
  if (!Array.isArray(row.messages) || row.messages.length > 10_000) {
    throw new Error("checkpoint.messages must be an array with at most 10000 entries");
  }
  const messages = row.messages.map((message, index) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error(`checkpoint.messages[${index}] must be an object`);
    }
    return message as Record<string, unknown>;
  });
  return {
    version: 1,
    model: row.model,
    workspaceRoot: row.workspaceRoot,
    nextStep: Number(row.nextStep),
    toolNames: row.toolNames as string[],
    messages,
    createdAt: typeof row.createdAt === "string" ? row.createdAt : new Date().toISOString(),
  };
}

function parseAgentRunInput(params: unknown): RunAgentInput & { runId?: string } {
  const row = asRecord(params);
  for (const key of ["baseUrl", "model", "workspaceRoot"] as const) {
    if (typeof row[key] !== "string" || !row[key].trim()) {
      throw new Error(`${key} must be a non-empty string`);
    }
  }
  if (typeof row.prompt !== "string") throw new Error("prompt must be a string");
  if (row.protocol !== undefined && row.protocol !== "chat-completions" && row.protocol !== "codex-responses"
    && row.protocol !== "openai-responses" && row.protocol !== "anthropic-messages") {
    throw new Error("protocol must be chat-completions, codex-responses, openai-responses, or anthropic-messages when provided");
  }
  if (row.apiKey !== undefined && typeof row.apiKey !== "string") throw new Error("apiKey must be a string when provided");
  let codexAuth: RunAgentInput["codexAuth"];
  if (row.codexAuth !== undefined) {
    const auth = asRecord(row.codexAuth);
    for (const key of ["accessToken", "accountId", "originator", "userAgent", "betaHeader"] as const) {
      if (typeof auth[key] !== "string" || !String(auth[key]).trim()) {
        throw new Error(`codexAuth.${key} must be a non-empty string`);
      }
    }
    codexAuth = {
      accessToken: String(auth.accessToken),
      accountId: String(auth.accountId),
      originator: String(auth.originator),
      userAgent: String(auth.userAgent),
      betaHeader: String(auth.betaHeader),
    };
  }
  if (row.runId !== undefined && typeof row.runId !== "string") throw new Error("runId must be a string when provided");
  if (row.allowedTools !== undefined && (!Array.isArray(row.allowedTools) || row.allowedTools.some((name) => typeof name !== "string"))) {
    throw new Error("allowedTools must be an array of strings when provided");
  }
  if (row.modeInstructions !== undefined && typeof row.modeInstructions !== "string") {
    throw new Error("modeInstructions must be a string when provided");
  }
  if (row.requestTimeoutMs !== undefined && (!Number.isInteger(row.requestTimeoutMs) || Number(row.requestTimeoutMs) < 1_000 || Number(row.requestTimeoutMs) > 300_000)) {
    throw new Error("requestTimeoutMs must be an integer between 1000 and 300000 when provided");
  }
  for (const key of ["firstTokenTimeoutMs", "idleTimeoutMs", "totalTimeoutMs"] as const) {
    if (row[key] !== undefined && (!Number.isInteger(row[key]) || Number(row[key]) < 1_000 || Number(row[key]) > 1_800_000)) {
      throw new Error(`${key} must be an integer between 1000 and 1800000 when provided`);
    }
  }
  if (row.retries !== undefined && (!Number.isInteger(row.retries) || Number(row.retries) < 0 || Number(row.retries) > 5)) {
    throw new Error("retries must be an integer between 0 and 5 when provided");
  }
  if (row.deepSeek !== undefined && typeof row.deepSeek !== "boolean") {
    throw new Error("deepSeek must be a boolean when provided");
  }
  if (row.imageInput !== undefined && typeof row.imageInput !== "boolean") {
    throw new Error("imageInput must be a boolean when provided");
  }
  if (row.thinking !== undefined && row.thinking !== "enabled" && row.thinking !== "disabled") {
    throw new Error("thinking must be enabled or disabled when provided");
  }
  if (row.reasoningEffort !== undefined && row.reasoningEffort !== "none" && row.reasoningEffort !== "minimal" && row.reasoningEffort !== "low" && row.reasoningEffort !== "medium" && row.reasoningEffort !== "high" && row.reasoningEffort !== "xhigh" && row.reasoningEffort !== "max" && row.reasoningEffort !== "ultra") {
    throw new Error("reasoningEffort must be none, minimal, low, medium, high, xhigh, max, or ultra when provided");
  }
  if (row.serviceTier !== undefined && row.serviceTier !== "default" && row.serviceTier !== "priority" && row.serviceTier !== "fast") {
    throw new Error("serviceTier must be default, priority, or fast when provided");
  }
  if (row.contextWindow !== undefined && (!Number.isInteger(row.contextWindow) || Number(row.contextWindow) < 1_024 || Number(row.contextWindow) > 10_000_000)) {
    throw new Error("contextWindow must be an integer between 1024 and 10000000 when provided");
  }
  if (row.maxOutputTokens !== undefined && (!Number.isInteger(row.maxOutputTokens) || Number(row.maxOutputTokens) < 1 || Number(row.maxOutputTokens) > 1_000_000)) {
    throw new Error("maxOutputTokens must be an integer between 1 and 1000000 when provided");
  }

  const images = parseImages(row.images, "images");
  const checkpoint = parseAgentCheckpoint(row.checkpoint);
  if (!String(row.prompt).trim() && !images?.length && !checkpoint) throw new Error("prompt, at least one image, or a checkpoint is required");
  return {
    protocol: row.protocol === "chat-completions" || row.protocol === "codex-responses" || row.protocol === "openai-responses" || row.protocol === "anthropic-messages"
      ? row.protocol
      : undefined,
    baseUrl: String(row.baseUrl),
    model: String(row.model),
    prompt: String(row.prompt),
    images,
    workspaceRoot: String(row.workspaceRoot),
    apiKey: typeof row.apiKey === "string" ? row.apiKey : undefined,
    codexAuth,
    firstTokenTimeoutMs: Number.isInteger(row.firstTokenTimeoutMs) ? Number(row.firstTokenTimeoutMs) : undefined,
    idleTimeoutMs: Number.isInteger(row.idleTimeoutMs) ? Number(row.idleTimeoutMs) : undefined,
    totalTimeoutMs: Number.isInteger(row.totalTimeoutMs) ? Number(row.totalTimeoutMs) : undefined,
    requestTimeoutMs: Number.isInteger(row.requestTimeoutMs) ? Number(row.requestTimeoutMs) : undefined,
    retries: Number.isInteger(row.retries) ? Number(row.retries) : undefined,
    deepSeek: typeof row.deepSeek === "boolean" ? row.deepSeek : undefined,
    imageInput: typeof row.imageInput === "boolean" ? row.imageInput : undefined,
    thinking: row.thinking === "enabled" || row.thinking === "disabled" ? row.thinking : undefined,
    reasoningEffort: row.reasoningEffort === "none" || row.reasoningEffort === "minimal" || row.reasoningEffort === "low" || row.reasoningEffort === "medium" || row.reasoningEffort === "high" || row.reasoningEffort === "xhigh" || row.reasoningEffort === "max" || row.reasoningEffort === "ultra" ? row.reasoningEffort : undefined,
    serviceTier: row.serviceTier === "default" || row.serviceTier === "priority" || row.serviceTier === "fast" ? row.serviceTier : undefined,
    contextWindow: Number.isInteger(row.contextWindow) ? Number(row.contextWindow) : undefined,
    maxOutputTokens: Number.isInteger(row.maxOutputTokens) ? Number(row.maxOutputTokens) : undefined,
    history: parseHistory(row.history),
    allowedTools: Array.isArray(row.allowedTools) ? row.allowedTools as string[] : undefined,
    externalTools: parseExternalTools(row.externalTools),
    modeInstructions: typeof row.modeInstructions === "string" ? row.modeInstructions : undefined,
    checkpoint,
    runId: typeof row.runId === "string" ? row.runId : undefined,
  };
}

function clearPeerRequest(id: string, pending: PendingPeerRequest): void {
  clearTimeout(pending.timer);
  if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
  peerPending.delete(id);
}

function createPeerRequest(method: string, params: unknown, timeoutMs = 180_000, signal?: AbortSignal): { id: string; promise: Promise<unknown> } {
  const id = `host-${nextPeerRequestId++}`;
  const promise = new Promise<unknown>((resolve, reject) => {
    let pending: PendingPeerRequest;
    const finish = (error?: Error, value?: unknown) => {
      clearPeerRequest(id, pending);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`IDE tool broker timed out: ${method}`)), timeoutMs);
    const onAbort = signal
      ? () => finish(signal.reason instanceof Error ? signal.reason : new Error("Agent run canceled."))
      : undefined;
    pending = {
      resolve: value => finish(undefined, value),
      reject: error => finish(error),
      timer,
      signal,
      onAbort,
    };
    peerPending.set(id, pending);
    if (signal?.aborted) {
      onAbort?.();
      return;
    }
    if (signal && onAbort) signal.addEventListener("abort", onAbort, { once: true });
    writeMessage({ jsonrpc: "2.0", id, method, params });
  });
  return { id, promise };
}

function requestPeer(method: string, params: unknown, timeoutMs = 180_000, signal?: AbortSignal): Promise<unknown> {
  return createPeerRequest(method, params, timeoutMs, signal).promise;
}

function cleanupPeerFetchStream(streamId: string): PeerFetchStream | undefined {
  const stream = peerFetchStreams.get(streamId);
  if (!stream) return undefined;
  peerFetchStreams.delete(streamId);
  if (stream.signal && stream.onAbort) stream.signal.removeEventListener("abort", stream.onAbort);
  return stream;
}

function cancelPeerFetch(streamId: string, reason: unknown): void {
  const stream = cleanupPeerFetchStream(streamId);
  if (!stream) return;
  try {
    stream.controller.error(reason instanceof Error ? reason : new Error(String(reason ?? "Network request canceled.")));
  } catch {
    // The response stream may already be closed.
  }
  writeMessage({ jsonrpc: "2.0", method: "network/fetch/cancel", params: { streamId } });
}

async function fetchThroughExtensionHost(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const requestHeaders = new Headers(input instanceof Request ? input.headers : undefined);
  for (const [key, value] of new Headers(init?.headers).entries()) requestHeaders.set(key, value);
  const body = init?.body;
  if (body !== undefined && body !== null && typeof body !== "string") {
    throw new Error("The extension-host fetch proxy accepts string request bodies only.");
  }

  let streamId = "";
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel(reason) {
      if (streamId) cancelPeerFetch(streamId, reason ?? new Error("Response stream canceled."));
    },
  });
  const peer = createPeerRequest("network/fetch", {
    url,
    method: init?.method ?? (input instanceof Request ? input.method : "GET"),
    headers: Object.fromEntries(requestHeaders.entries()),
    body: typeof body === "string" ? body : undefined,
  }, 1_800_000, init?.signal ?? undefined);
  streamId = peer.id;
  const onAbort = init?.signal
    ? () => cancelPeerFetch(streamId, init.signal?.reason ?? new Error("Network request canceled."))
    : undefined;
  peerFetchStreams.set(streamId, { controller: streamController, signal: init?.signal ?? undefined, onAbort });
  if (init?.signal && onAbort) {
    if (init.signal.aborted) onAbort();
    else init.signal.addEventListener("abort", onAbort, { once: true });
  }

  try {
    const metadata = asRecord(await peer.promise);
    const status = Number(metadata.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error("Extension-host fetch returned an invalid HTTP status.");
    const headers = metadata.headers && typeof metadata.headers === "object" && !Array.isArray(metadata.headers)
      ? metadata.headers as Record<string, string>
      : {};
    return new Response(stream, {
      status,
      statusText: typeof metadata.statusText === "string" ? metadata.statusText : "",
      headers,
    });
  } catch (error) {
    const pendingStream = cleanupPeerFetchStream(streamId);
    if (pendingStream) {
      try { pendingStream.controller.error(error); } catch { /* already closed */ }
    }
    throw error;
  }
}

function handlePeerFetchNotification(message: RpcNotification): boolean {
  if (message.method !== "network/fetch/chunk" && message.method !== "network/fetch/end" && message.method !== "network/fetch/error") return false;
  const params = message.params && typeof message.params === "object" && !Array.isArray(message.params)
    ? message.params as Record<string, unknown>
    : {};
  const streamId = typeof params.streamId === "string" ? params.streamId : "";
  const stream = peerFetchStreams.get(streamId);
  if (!stream) return true;
  try {
    if (message.method === "network/fetch/chunk") {
      const encoded = typeof params.data === "string" ? params.data : "";
      if (encoded) {
        const bytes = Buffer.from(encoded, "base64");
        stream.controller.enqueue(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      }
      return true;
    }
    cleanupPeerFetchStream(streamId);
    if (message.method === "network/fetch/error") {
      stream.controller.error(new Error(typeof params.message === "string" ? params.message : "Extension-host response stream failed."));
    } else {
      stream.controller.close();
    }
  } catch {
    cleanupPeerFetchStream(streamId);
  }
  return true;
}

async function dispatch(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case "runtime/hello":
      return {
        name: "shuncode-agent-host",
        protocolVersion: PROTOCOL_VERSION,
        pid: process.pid,
        node: process.version,
        platform: process.platform,
        tools: [...TOOL_NAMES],
        capabilities: {
          history: true,
          traceNotifications: true,
          bidirectionalRpc: true,
          ideToolBroker: true,
          unboundedAgentLoop: true,
          cancellation: true,
          imageInput: true,
          deepSeekV4: true,
          streamingModelResponses: true,
          recoverableCheckpoints: true,
          extensionHostFetchProxy: true,
        },
      };
    case "runtime/ping":
      return { ok: true, now: new Date().toISOString() };
    case "tools/list":
      return { tools: [...TOOL_NAMES] };
    case "agent/run": {
      const parsed = parseAgentRunInput(params);
      const { runId, ...input } = parsed;
      const abortController = new AbortController();
      if (runId) activeRuns.set(runId, abortController);
      try {
        const dynamicExternalTools = input.externalTools ?? [];
        const reservedExternalToolNames = new Set(IDE_TOOL_DEFINITIONS.map((tool) => tool.name));
        return await runOpenAICompatibleAgent({
          ...input,
          signal: abortController.signal,
          externalTools: [
            ...IDE_TOOL_DEFINITIONS.map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema,
            })),
            ...dynamicExternalTools.filter((tool) => !reservedExternalToolNames.has(tool.name)),
          ],
          executeExternalTool: async (name, args) => {
            if (!runId) throw new Error(`IDE-native tool ${name} requires an agent runId.`);
            abortController.signal.throwIfAborted();
            const result = asRecord(await requestPeer("ide/tool/invoke", { runId, name, arguments: args }, 180_000, abortController.signal));
            return {
              text: typeof result.text === "string" ? result.text : JSON.stringify(result),
              isError: result.isError === true,
            };
          },
          onTrace: runId
            ? (item: AgentTraceItem) => {
                writeMessage({ jsonrpc: "2.0", method: "agent/trace", params: { runId, item } });
              }
            : undefined,
          onCheckpoint: runId
            ? (checkpoint: AgentCheckpoint) => {
                writeMessage({ jsonrpc: "2.0", method: "agent/checkpoint", params: { runId, checkpoint } });
              }
            : undefined,
        }, {
          fetch: input.protocol === "codex-responses" ? fetchThroughExtensionHost : undefined,
        });
      } finally {
        if (runId) activeRuns.delete(runId);
      }
    }
    case "agent/cancel": {
      const row = asRecord(params);
      const runId = typeof row.runId === "string" ? row.runId : "";
      if (!runId) throw new Error("runId must be a non-empty string");
      const controller = activeRuns.get(runId);
      if (!controller) return { canceled: false, reason: "not_running" };
      controller.abort(new Error("Agent run canceled by user."));
      return { canceled: true };
    }
    default:
      throw Object.assign(new Error(`Unknown method: ${method}`), { rpcCode: -32601 });
  }
}

function handlePeerResponse(message: RpcSuccess | RpcFailure): boolean {
  const key = String(message.id);
  const pending = peerPending.get(key);
  if (!pending) return false;
  if ("error" in message) {
    pending.reject(new Error(`IDE broker ${message.error.code}: ${message.error.message}`));
  } else {
    pending.resolve(message.result);
  }
  return true;
}

async function handleIncomingRequest(request: RpcRequest): Promise<void> {
  try {
    const result = await dispatch(request.method, request.params);
    writeMessage({ jsonrpc: "2.0", id: request.id, result });
  } catch (error) {
    const row = error as Error & { rpcCode?: number };
    writeMessage({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: row.rpcCode ?? -32000, message: row.message || "Agent host request failed" },
    });
  }
}

function handleLine(line: string): void {
  if (!line.trim()) return;
  let message: RpcRequest | RpcSuccess | RpcFailure | RpcNotification;
  try {
    message = JSON.parse(line.replace(/^\uFEFF/, "")) as RpcRequest | RpcSuccess | RpcFailure | RpcNotification;
  } catch (error) {
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON", data: String(error) } });
    return;
  }

  if (!message || message.jsonrpc !== "2.0") {
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    return;
  }

  if (!("id" in message) || message.id === undefined) {
    if ("method" in message && typeof message.method === "string" && handlePeerFetchNotification(message as RpcNotification)) return;
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
    return;
  }

  if (!("method" in message) || typeof message.method !== "string") {
    if (!handlePeerResponse(message as RpcSuccess | RpcFailure)) {
      process.stderr.write(`[agent-host] unexpected peer response id=${String(message.id)}\n`);
    }
    return;
  }

  // Requests must not block stdin processing: an agent/run can synchronously request IDE-native
  // tools back from the extension over this same bidirectional JSON-RPC stream.
  void handleIncomingRequest(message as RpcRequest);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", handleLine);
input.on("close", () => {
  for (const controller of activeRuns.values()) controller.abort(new Error("IDE peer disconnected."));
  activeRuns.clear();
  for (const pending of peerPending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("IDE peer disconnected."));
  }
  peerPending.clear();
  for (const [streamId, stream] of peerFetchStreams) {
    cleanupPeerFetchStream(streamId);
    try { stream.controller.error(new Error("IDE peer disconnected.")); } catch { /* already closed */ }
  }
  process.exit(0);
});

process.stderr.write(`[agent-host] ready protocol=${PROTOCOL_VERSION} pid=${process.pid}\n`);
