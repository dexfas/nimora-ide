import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { randomBytes } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport, type EventStore } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, type CallToolResult, isInitializeRequest, type JSONRPCMessage, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as vscode from "vscode";
import { capabilityMcpFields } from "../../../src/capability-registry.js";
import { FILE_TOOL_DEFINITIONS, invokeFileTool, isFileToolName } from "../../../src/file-tool-registry.js";
import { BRIDGE_EXCLUDED_TOOL_NAMES, getIdeToolDefinition, IDE_TOOL_DEFINITIONS } from "../../../src/ide-tool-definitions.js";
import type { TaskProgress, TaskTodo } from "../../../src/task-contract.js";
import { normalizeBridgeProgress, normalizeBridgeTodos } from "./bridge-task-coordination.js";
import type { IdeToolBroker } from "./ide-tool-broker.js";
import { fetchWithExtensionHostFallbacks, resolveExtensionHostProxy } from "./extension-host-proxy.mjs";
import type { TaskShadowRecorder } from "./task-shadow.js";

const execFileAsync = promisify(execFile);
const ROUTE_TOKEN_SECRET = "shuncode.bridge.routeToken";
const NGROK_DOMAIN_SETTING = "bridge.ngrokDomain";
const NGROK_DOMAIN_STATE_KEY = "shuncode.bridge.ngrokDomain";
const CLOUDFLARE_NAMED_DOMAIN_SETTING = "bridge.cloudflareNamedDomain";
const CLOUDFLARE_NAMED_DOMAIN_STATE_KEY = "shuncode.bridge.cloudflareNamedDomain";
const CLOUDFLARE_NAMED_TOKEN_SECRET = "shuncode.bridge.cloudflareNamedTunnelToken";
const CLOUDFLARE_NAMED_LOCAL_PORT_SETTING = "bridge.cloudflareNamedLocalPort";
const TUNNEL_PROVIDER_SETTING = "bridge.tunnelProvider";
const NGROK_USE_HTTP_PROXY_SETTING = "bridge.ngrokUseHttpProxy";
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_ACTIVITY = 60;
const MAX_TODOS = 24;
/** Idle sessions are retained long enough for ChatGPT to pause and resume without being forced to reinitialize. */
const SESSION_IDLE_TIMEOUT_MS = 60 * 60 * 1000;
const SESSION_PRUNE_INTERVAL_MS = 60_000;
const MAX_SESSIONS = 64;
/** Explicitly pin transport behavior instead of depending on SDK defaults. */
const SESSION_KEEPALIVE_INTERVAL_MS = 15_000;
const SESSION_RETRY_INTERVAL_MS = 2_000;
const SESSION_EVENT_STORE_LIMIT = 512;
const DEFAULT_PUBLIC_HEALTH_STARTUP_TIMEOUT_MS = 20_000;
const PUBLIC_HEALTH_STARTUP_TIMEOUT_SETTING = "bridge.startupTimeoutMs";
const PUBLIC_HEALTH_REQUEST_TIMEOUT_MS = 5_000;
const PUBLIC_HEALTH_POLL_INTERVAL_MS = 750;
const PUBLIC_HEALTH_DETERMINISTIC_FAILURE_LIMIT = 3;
const TUNNEL_RESTART_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
const CLOUDFLARED_WINGET_PACKAGE = "Cloudflare.cloudflared";
const DEFAULT_CLOUDFLARE_NAMED_LOCAL_PORT = 48271;

interface PublicHealthFailure {
  /** Human-readable cause chain surfaced in startup errors and the Bridge UI. */
  readonly reason: string;
  /** Primary error code when Node reported one (e.g. ENOTFOUND, ECONNRESET). */
  readonly code?: string;
  /** HTTP status when a response arrived. */
  readonly status?: number;
  /** True when retrying with the current network configuration cannot succeed. */
  readonly deterministic: boolean;
}

function publicHealthFailure(error: unknown): PublicHealthFailure {
  const messages: string[] = [];
  const codes: string[] = [];
  let current = error;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth++) {
    if (typeof current === "object") {
      const record = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
      if (typeof record.code === "string") codes.push(record.code);
      if (typeof record.message === "string") messages.push(record.message);
      current = record.cause;
    } else {
      messages.push(String(current));
      current = undefined;
    }
  }
  const reason = messages.join(": ") || (error instanceof Error ? error.message : String(error));
  const detail = `${codes.join(",")} ${reason}`.toLowerCase();
  const deterministic = codes.some((code) => code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "EPIPE")
    || detail.includes("certificate") || detail.includes("self-signed") || detail.includes("tls") || detail.includes("ssl") || detail.includes("wrong version number");
  return { reason, code: codes.length ? codes[0] : undefined, deterministic };
}

function cloudflaredEdgeFailureHint(output: string): string {
  const lower = output.toLowerCase();
  const blocked = ["unable to establish", "dial tcp", "connection refused", "connection reset", "no such host", "i/o timeout", "context deadline", "quic"].some((marker) => lower.includes(marker));
  return blocked
    ? " This usually means cloudflared cannot reach the Cloudflare edge from this network. ShunCode passes a resolvable VS Code/system HTTP proxy to tunnel processes; if that still fails, verify the proxy supports tunnel traffic or use a system/global (TUN) proxy."
    : "";
}

export type BridgeTunnelProvider = "cloudflare" | "cloudflare-named" | "ngrok";

const BRIDGE_SERVER_INSTRUCTIONS = `You are connected to the currently open ShunCode workspace.

ShunCode executes tools and displays your task state, progress, and tool activity to the local user.

Use:
- list_directory/find_files to discover files
- search_files for raw text search
- lsp for semantic code navigation
- read_files before editing
- apply_patch for workspace changes
- get_diagnostics after edits
- run_command for builds and tests
- set_todos to maintain the complete task list for multi-step work
- report_progress to report transient progress for the current task

Task coordination:
- Use set_todos for multi-step work, significant replanning, or validation workflows.
- Send the complete ordered todo list whenever task state changes.
- Keep at most one todo in_progress.
- Use stable todo IDs across updates.
- Keep todos at the goal level; do not create one todo per tool call.
- Use report_progress for what you are doing right now, not for durable task state.
- When there is exactly one in_progress todo, report_progress is automatically associated with it.
- Pass todo_id only when an explicit association is needed.
- Send an empty todo list when the task state should be cleared.

Tool guidance:
- Prefer semantic navigation over broad text search when locating code symbols.
- Do not assume an empty LSP result means a symbol does not exist.
- Use search_files for exact text and lsp for symbols, definitions, references, and type information.
- Reread affected files after stale patch or context-mismatch failures before retrying.
- Prefer small, focused patches with enough unique context.
- Run diagnostics and relevant tests after meaningful edits.
- Report meaningful progress periodically during long work, but avoid progress updates for every tool call.`;

export const SET_TODOS_TOOL = {
  name: "set_todos",
  description: "Set the complete durable task list for the current remote-agent job in ShunCode. Use this for multi-step work so the local user can see what is done, in progress, and still pending. Send the full list whenever the plan changes; keep at most one item in_progress. Use report_progress for transient details about the current step instead of creating tool-call-sized todos. Send an empty list to clear task state.",
  inputSchema: {
    type: "object",
    required: ["todos"],
    properties: {
      todos: {
        type: "array",
        maxItems: MAX_TODOS,
        description: "Complete ordered todo snapshot for the current job.",
        items: {
          type: "object",
          required: ["id", "title", "status"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 80, description: "Stable id reused across later set_todos updates." },
            title: { type: "string", minLength: 1, maxLength: 400, description: "Goal-level task title, not an individual tool call." },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
} as const;

export const REPORT_PROGRESS_TOOL = {
  name: "report_progress",
  description: "Report concise transient progress for the current Task. Progress is durably owned by Task Runtime and shown in Nimora Work Sessions. For multi-step work, maintain durable task state with set_todos and use report_progress for what you are doing right now. todo_id is optional: when omitted, ShunCode automatically associates progress with the sole in_progress todo. This tool does not modify workspace files.",
  inputSchema: {
    type: "object",
    required: ["message"],
    properties: {
      message: { type: "string", minLength: 1, maxLength: 2000, description: "Human-readable progress update." },
      phase: { type: "string", maxLength: 160, description: "Optional short phase label, such as Reading, Editing, Testing, or Done." },
      percent: { type: "integer", minimum: 0, maximum: 100, description: "Optional completion estimate from 0 to 100 for the current activity/todo." },
      todo_id: { type: "string", minLength: 1, maxLength: 80, description: "Optional todo id from set_todos. Omit when there is exactly one in_progress todo; ShunCode will link it automatically." },
    },
    additionalProperties: false,
  },
} as const;

export const BRIDGE_TOOL_DEFINITIONS = [
  ...FILE_TOOL_DEFINITIONS,
  ...IDE_TOOL_DEFINITIONS
    .filter((tool) => !BRIDGE_EXCLUDED_TOOL_NAMES.has(tool.name))
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  SET_TODOS_TOOL,
  REPORT_PROGRESS_TOOL,
].map((tool) => ({ ...tool, ...capabilityMcpFields(tool.name) }));

export interface BridgeActivity {
  readonly id: number;
  readonly at: string;
  readonly tool: string;
  readonly status: "running" | "completed" | "error" | "progress";
  readonly durationMs?: number;
  readonly message?: string;
  readonly phase?: string;
  readonly percent?: number;
  readonly todoId?: string;
  readonly todoTitle?: string;
  readonly presentation?: BridgeActivityPresentation;
}

export interface BridgeTodo {
  readonly id: string;
  readonly title: string;
  readonly status: "pending" | "in_progress" | "completed";
}

export interface BridgeActivityPresentation {
  readonly kind: "edit" | "terminal" | "generic";
  readonly title: string;
  readonly subtitle?: string;
  readonly input?: string;
  readonly output?: string;
  readonly files?: string[];
  readonly items?: BridgeActivityItem[];
  readonly diff?: string;
  readonly diffPreview?: BridgeDiffFilePreview[];
  readonly terminalId?: string;
  readonly commandId?: string;
  readonly exitCode?: number | null;
}

export interface BridgeDiffFilePreview {
  readonly path: string;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly hunks: BridgeDiffHunkPreview[];
  readonly truncated?: boolean;
}

export interface BridgeDiffHunkPreview {
  readonly oldStart: number;
  readonly newStart: number;
  readonly lines: BridgeDiffLinePreview[];
  readonly truncated?: boolean;
}

export interface BridgeDiffLinePreview {
  readonly kind: "context" | "add" | "delete";
  readonly oldLine?: number;
  readonly newLine?: number;
  readonly text: string;
}

export interface BridgeActivityItem {
  readonly kind: "file";
  readonly path: string;
  readonly line?: number;
  readonly column?: number;
  readonly label?: string;
  readonly description?: string;
  readonly additions?: number;
  readonly deletions?: number;
}

export interface BridgeStatus {
  readonly state: "stopped" | "starting" | "running" | "error";
  readonly transport: "streamable-http";
  readonly tunnelProvider: BridgeTunnelProvider;
  readonly domain: string;
  readonly configuredDomain: string;
  readonly configuredNamedDomain: string;
  readonly namedTunnelTokenConfigured: boolean;
  readonly namedTunnelLocalPort: number;
  readonly namedTunnelOriginUrl: string;
  readonly localUrl?: string;
  readonly publicUrl?: string;
  readonly localPort?: number;
  readonly tunnelInstalled?: boolean;
  readonly tunnelVersion?: string;
  readonly tunnelConfigValid?: boolean;
  readonly lastError?: string;
  readonly toolNames: string[];
  readonly toolCount: number;
  readonly activeRequests: number;
  readonly connected: boolean;
  readonly revision: number;
  readonly stats: {
    readonly toolCalls: number;
    readonly completedToolCalls: number;
    readonly failedToolCalls: number;
    readonly averageDurationMs: number;
    readonly successRate: number;
    readonly lastTool?: string;
    readonly lastToolAt?: string;
  };
  /** @deprecated Task coordination is presented by Nimora Work Sessions. Kept empty for compatibility. */
  readonly todos: BridgeTodo[];
  readonly activities: BridgeActivity[];
  readonly health?: BridgeHealthReport;
}

export interface BridgeHealthProbe {
  readonly ok: boolean;
  readonly url?: string;
  readonly latencyMs?: number;
  readonly error?: string;
}

export interface BridgeHealthReport {
  readonly at: string;
  readonly ok: boolean;
  readonly state: BridgeStatus["state"];
  readonly durationMs: number;
  readonly local: BridgeHealthProbe;
  readonly public?: BridgeHealthProbe;
  readonly tunnelProcessAlive: boolean;
  readonly sessions: number;
  readonly activeRequests: number;
  readonly lastSessionActivityAt?: string;
  readonly summary: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function boundedText(value: unknown, maxChars = 16_000): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return undefined;
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…[truncated for Bridge UI]`;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value?.trim())).map((value) => value.trim()))];
}

function stringField(text: string | undefined, field: string): string | undefined {
  if (!text) return undefined;
  const match = text.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  if (!match) return undefined;
  const raw = match[1].trim();
  if (raw === "null") return undefined;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : String(parsed);
  } catch {
    return raw;
  }
}

function numberField(text: string | undefined, field: string): number | null | undefined {
  const raw = stringField(text, field);
  if (raw === undefined) return undefined;
  if (raw === "null") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function blockBetween(text: string | undefined, begin: string, end: string): string | undefined {
  if (!text) return undefined;
  const start = text.indexOf(begin);
  if (start < 0) return undefined;
  const contentStart = start + begin.length;
  const finish = text.indexOf(end, contentStart);
  const value = text.slice(contentStart, finish >= 0 ? finish : undefined).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return value || undefined;
}

const MAX_DIFF_PREVIEW_FILES = 8;
const MAX_DIFF_PREVIEW_HUNKS_PER_FILE = 4;
const MAX_DIFF_PREVIEW_LINES_PER_HUNK = 18;

function diffPath(header: string): string | undefined {
  const value = header.trim();
  if (!value || value === "/dev/null") return undefined;
  return value.replace(/^[ab]\//, "");
}

function parseUnifiedDiffPreview(diff: string | undefined): BridgeDiffFilePreview[] {
  if (!diff) return [];
  const lines = diff.split(/\r?\n/);
  const files: BridgeDiffFilePreview[] = [];
  let currentFile: { oldPath?: string; newPath?: string; hunks: BridgeDiffHunkPreview[]; truncated?: boolean } | undefined;
  let currentHunk: { oldStart: number; newStart: number; lines: BridgeDiffLinePreview[]; truncated?: boolean } | undefined;
  let oldLine = 0;
  let newLine = 0;

  const finishHunk = () => {
    if (!currentFile || !currentHunk) return;
    if (currentFile.hunks.length < MAX_DIFF_PREVIEW_HUNKS_PER_FILE) currentFile.hunks.push(currentHunk);
    else currentFile.truncated = true;
    currentHunk = undefined;
  };

  const finishFile = () => {
    finishHunk();
    if (!currentFile) return;
    const path = currentFile.newPath ?? currentFile.oldPath;
    if (path) {
      if (files.length < MAX_DIFF_PREVIEW_FILES) files.push({ path, ...currentFile });
      else if (files.length > 0) files[files.length - 1] = { ...files[files.length - 1]!, truncated: true };
    }
    currentFile = undefined;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("--- ")) {
      finishFile();
      const oldPath = diffPath(line.slice(4));
      const next = lines[index + 1];
      const newPath = next?.startsWith("+++ ") ? diffPath(next.slice(4)) : undefined;
      currentFile = { oldPath, newPath, hunks: [] };
      if (next?.startsWith("+++ ")) index += 1;
      continue;
    }
    if (!currentFile) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      finishHunk();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      currentHunk = { oldStart: oldLine, newStart: newLine, lines: [] };
      continue;
    }
    if (!currentHunk || line === "\\ No newline at end of file" || line === "... <diff truncated>") continue;
    const marker = line[0];
    if (marker !== " " && marker !== "+" && marker !== "-") continue;
    const previewLine: BridgeDiffLinePreview = marker === "+"
      ? { kind: "add", newLine, text: line.slice(1) }
      : marker === "-"
        ? { kind: "delete", oldLine, text: line.slice(1) }
        : { kind: "context", oldLine, newLine, text: line.slice(1) };
    if (currentHunk.lines.length < MAX_DIFF_PREVIEW_LINES_PER_HUNK) currentHunk.lines.push(previewLine);
    else currentHunk.truncated = true;
    if (marker !== "+") oldLine += 1;
    if (marker !== "-") newLine += 1;
  }
  finishFile();
  return files;
}

function bridgePresentation(
  toolName: string,
  args: Record<string, unknown>,
  resultText?: string,
  structuredContent?: Record<string, unknown>,
  isError = false,
): BridgeActivityPresentation {
  const input = boundedText(args, 8_000);
  const output = boundedText(resultText, 24_000);
  const structured = structuredContent ?? {};

  if (toolName === "apply_patch") {
    const fileRows = recordArray(structured.files);
    const files = uniqueStrings(fileRows.map((file) => typeof file.destination_path === "string"
      ? file.destination_path
      : typeof file.path === "string" ? file.path : undefined));
    const summary = asRecord(structured.summary);
    const additions = typeof summary.additions === "number" ? summary.additions : undefined;
    const deletions = typeof summary.deletions === "number" ? summary.deletions : undefined;
    const changeSummary = additions !== undefined || deletions !== undefined ? `+${additions ?? 0} -${deletions ?? 0}` : undefined;
    const diff = boundedText(structured.diff, 32_000);
    return {
      kind: "edit",
      title: files.length === 1 ? `Edited ${files[0]}` : `Edited ${files.length || "workspace"} files`,
      subtitle: isError ? "Edit failed" : changeSummary,
      files,
      items: fileRows.flatMap((file) => typeof file.path === "string" ? [{
        kind: "file" as const,
        path: typeof file.destination_path === "string" ? file.destination_path : file.path,
        description: typeof file.action === "string" ? file.action : undefined,
        additions: typeof file.additions === "number" ? file.additions : undefined,
        deletions: typeof file.deletions === "number" ? file.deletions : undefined,
      }] : []),
      input: undefined,
      output: isError ? output : undefined,
      diff,
      diffPreview: parseUnifiedDiffPreview(diff),
    };
  }

  if (toolName === "run_command") {
    const command = typeof args.command === "string" ? args.command.trim() : "Run command";
    const cwd = typeof args.cwd === "string" && args.cwd.trim() ? args.cwd.trim() : undefined;
    const terminalId = stringField(resultText, "terminal_id");
    const terminalName = stringField(resultText, "terminal_name");
    const commandId = stringField(resultText, "command_id");
    const exitCode = numberField(resultText, "exit_code");
    const terminalOutput = blockBetween(resultText, "--- OUTPUT BEGIN ---", "--- OUTPUT END ---");
    const status = stringField(resultText, "status");
    const subtitle = [terminalName, cwd, status && status !== "completed" ? status : undefined, exitCode !== undefined && exitCode !== null ? `exit ${exitCode}` : undefined].filter(Boolean).join(" · ") || undefined;
    return { kind: "terminal", title: command || "Run command", subtitle, input: undefined, output: terminalOutput ?? (isError ? output : undefined), terminalId, commandId, exitCode };
  }

  if (toolName === "get_command_output") {
    const commandId = typeof args.command_id === "string" ? args.command_id : undefined;
    return {
      kind: "terminal",
      title: "Read command output",
      subtitle: [stringField(resultText, "terminal_name"), stringField(resultText, "status") ?? commandId].filter(Boolean).join(" · ") || undefined,
      input: undefined,
      output: blockBetween(resultText, "--- OUTPUT BEGIN ---", "--- OUTPUT END ---") ?? output,
      terminalId: stringField(resultText, "terminal_id"),
      commandId,
      exitCode: numberField(resultText, "exit_code"),
    };
  }

  if (toolName === "send_command_input") {
    const commandId = typeof args.command_id === "string" ? args.command_id : undefined;
    return { kind: "terminal", title: "Sent command input", subtitle: commandId, input: boundedText(args.input, 2_000), terminalId: stringField(resultText, "terminal_id"), commandId, output: isError ? output : undefined };
  }

  return { kind: "generic", title: toolName, input, output };
}

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastActivity: number;
  activeRequests: number;
  activeStreams: number;
}

class BoundedInMemoryEventStore implements EventStore {
  private readonly events = new Map<string, { streamId: string; message: JSONRPCMessage }>();
  private readonly order: string[] = [];
  private sequence = 0;

  constructor(private readonly limit = SESSION_EVENT_STORE_LIMIT) {}

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}-${randomUUID()}`;
    this.events.set(eventId, { streamId, message });
    this.order.push(eventId);
    while (this.order.length > this.limit) {
      const oldest = this.order.shift();
      if (oldest) this.events.delete(oldest);
    }
    return eventId;
  }

  async replayEventsAfter(lastEventId: string, { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> }): Promise<string> {
    const previous = this.events.get(lastEventId);
    if (!previous) return "";
    let found = false;
    for (const eventId of this.order) {
      if (eventId === lastEventId) {
        found = true;
        continue;
      }
      if (!found) continue;
      const event = this.events.get(eventId);
      if (event?.streamId === previous.streamId) {
        await send(eventId, event.message);
      }
    }
    return previous.streamId;
  }
}

function normalizeHttpsHostname(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`${label} is not a valid hostname.`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password || url.port) {
    throw new Error(`Enter only the ${label.toLowerCase()}, without a path, query, port, username, or password.`);
  }
  return url.hostname.toLowerCase();
}

function normalizeNgrokDomain(value: string): string {
  return normalizeHttpsHostname(value, "ngrok reserved domain");
}

function normalizeCloudflareNamedDomain(value: string): string {
  return normalizeHttpsHostname(value, "Cloudflare Named Tunnel hostname");
}

function normalizeNamedTunnelLocalPort(value: number): number {
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error("Cloudflare Named Tunnel local port must be an integer from 1024 to 65535.");
  }
  return value;
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > MAX_REQUEST_BYTES) {
        reject(new Error(`MCP request body exceeds ${MAX_REQUEST_BYTES} bytes.`));
        request.destroy();
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("MCP request body is not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function writeJsonError(response: ServerResponse, statusCode: number, message: string): void {
  if (response.headersSent) return;
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({
    jsonrpc: "2.0",
    error: { code: statusCode === 404 ? -32004 : -32000, message },
    id: null,
  }));
}

function cancellationFromAbortSignal(signal: AbortSignal | undefined): { token?: vscode.CancellationToken; dispose(): void } {
  if (!signal) return { token: undefined, dispose: () => undefined };
  const source = new vscode.CancellationTokenSource();
  const listener = () => source.cancel();
  if (signal.aborted) source.cancel();
  else signal.addEventListener("abort", listener, { once: true });
  return {
    token: source.token,
    dispose: () => {
      signal.removeEventListener("abort", listener);
      source.dispose();
    },
  };
}

export class BridgeManager implements vscode.Disposable {
  private state: BridgeStatus["state"] = "stopped";
  private tunnelProvider: BridgeTunnelProvider = "cloudflare";
  private domain = "";
  private configuredDomain = "";
  private configuredNamedDomain = "";
  private namedTunnelToken = "";
  private namedTunnelLocalPort = DEFAULT_CLOUDFLARE_NAMED_LOCAL_PORT;
  private routeToken = "";
  private readonly sessions = new Map<string, McpSession>();
  private httpServer: HttpServer | undefined;
  private tunnelProcess: ChildProcessWithoutNullStreams | undefined;
  private localPort: number | undefined;
  private lastError: string | undefined;
  private toolCallsSinceLastReport = 0;
  private tunnelInstalled: boolean | undefined;
  private tunnelVersion: string | undefined;
  private tunnelConfigValid: boolean | undefined;
  private cloudflaredExecutable = "cloudflared";
  private ngrokExecutable = "ngrok";
  private activeRequests = 0;
  private readonly activities: BridgeActivity[] = [];
  private nextActivityId = 1;
  private revision = 0;
  private toolCalls = 0;
  private completedToolCalls = 0;
  private failedToolCalls = 0;
  private totalToolDurationMs = 0;
  private lastTool: string | undefined;
  private lastToolAt: string | undefined;
  private lastHealth: BridgeHealthReport | undefined;
  private startPromise: Promise<BridgeStatus> | undefined;
  private sessionPruneTimer: ReturnType<typeof setInterval> | undefined;
  private tunnelRecoveryPromise: Promise<void> | undefined;
  private tunnelRecoveryGeneration: number | undefined;
  private tunnelGeneration = 0;
  private stoppingResources = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly ideToolBroker: IdeToolBroker,
    private readonly taskShadow: TaskShadowRecorder,
    private readonly authorizeStart: () => Promise<void>,
  ) {}

  async initialize(): Promise<void> {
    this.routeToken = await this.context.secrets.get(ROUTE_TOKEN_SECRET) ?? "";
    if (!this.routeToken) {
      this.routeToken = randomBytes(16).toString("hex");
      await this.context.secrets.store(ROUTE_TOKEN_SECRET, this.routeToken);
    }
    this.tunnelProvider = this.readTunnelProvider();
    this.namedTunnelToken = await this.context.secrets.get(CLOUDFLARE_NAMED_TOKEN_SECRET) ?? "";
    this.namedTunnelLocalPort = this.readNamedTunnelLocalPort();
    await this.restorePersistedDomain();
    await this.restorePersistedNamedDomain();
    this.domain = this.configuredDomainForProvider(this.tunnelProvider);
  }

  getStatus(): BridgeStatus {
    if (this.state !== "running" && this.state !== "starting") {
      this.tunnelProvider = this.readTunnelProvider();
      this.restoreConfiguredDomain();
      this.restoreConfiguredNamedDomain();
      this.namedTunnelLocalPort = this.readNamedTunnelLocalPort();
      this.domain = this.configuredDomainForProvider(this.tunnelProvider);
    }
    const localUrl = this.localPort && this.routeToken ? `http://127.0.0.1:${this.localPort}/mcp/${this.routeToken}` : undefined;
    const publicUrl = this.domain && this.routeToken ? `https://${this.domain}/mcp/${this.routeToken}` : undefined;
    return {
      state: this.state,
      transport: "streamable-http",
      tunnelProvider: this.tunnelProvider,
      domain: this.domain,
      configuredDomain: this.configuredDomain,
      configuredNamedDomain: this.configuredNamedDomain,
      namedTunnelTokenConfigured: Boolean(this.namedTunnelToken),
      namedTunnelLocalPort: this.namedTunnelLocalPort,
      namedTunnelOriginUrl: `http://127.0.0.1:${this.namedTunnelLocalPort}`,
      localUrl,
      publicUrl,
      localPort: this.localPort,
      tunnelInstalled: this.tunnelInstalled,
      tunnelVersion: this.tunnelVersion,
      tunnelConfigValid: this.tunnelConfigValid,
      lastError: this.lastError,
      toolNames: BRIDGE_TOOL_DEFINITIONS.map((tool) => tool.name),
      toolCount: BRIDGE_TOOL_DEFINITIONS.length,
      activeRequests: this.activeRequests,
      connected: this.sessions.size > 0,
      revision: this.revision,
      stats: {
        toolCalls: this.toolCalls,
        completedToolCalls: this.completedToolCalls,
        failedToolCalls: this.failedToolCalls,
        averageDurationMs: this.completedToolCalls > 0 ? Math.round(this.totalToolDurationMs / this.completedToolCalls) : 0,
        successRate: this.completedToolCalls > 0 ? ((this.completedToolCalls - this.failedToolCalls) / this.completedToolCalls) * 100 : 100,
        lastTool: this.lastTool,
        lastToolAt: this.lastToolAt,
      },
      todos: [],
      activities: this.activities.slice(-MAX_ACTIVITY),
      health: this.lastHealth,
    };
  }

  private readConfiguredDomain(): string {
    return vscode.workspace.getConfiguration("shuncode").get<string>(NGROK_DOMAIN_SETTING, "").trim();
  }

  private readConfiguredNamedDomain(): string {
    return vscode.workspace.getConfiguration("shuncode").get<string>(CLOUDFLARE_NAMED_DOMAIN_SETTING, "").trim();
  }

  private readNamedTunnelLocalPort(): number {
    const value = vscode.workspace.getConfiguration("shuncode").get<number>(CLOUDFLARE_NAMED_LOCAL_PORT_SETTING, DEFAULT_CLOUDFLARE_NAMED_LOCAL_PORT);
    try {
      return normalizeNamedTunnelLocalPort(value);
    } catch {
      return DEFAULT_CLOUDFLARE_NAMED_LOCAL_PORT;
    }
  }

  private configuredDomainForProvider(provider: BridgeTunnelProvider): string {
    return provider === "ngrok" ? this.configuredDomain : provider === "cloudflare-named" ? this.configuredNamedDomain : "";
  }

  private readTunnelProvider(): BridgeTunnelProvider {
    const provider = vscode.workspace.getConfiguration("shuncode").get<BridgeTunnelProvider>(TUNNEL_PROVIDER_SETTING, "cloudflare");
    return provider === "ngrok" || provider === "cloudflare-named" ? provider : "cloudflare";
  }

  private readPersistedDomain(): string {
    return this.context.globalState.get<string>(NGROK_DOMAIN_STATE_KEY, "").trim();
  }

  private readPersistedNamedDomain(): string {
    return this.context.globalState.get<string>(CLOUDFLARE_NAMED_DOMAIN_STATE_KEY, "").trim();
  }

  /**
   * Restore the Bridge domain from either VS Code configuration or the extension's own
   * persistent memento. The memento is intentionally a second source of truth because
   * carrier/user-data migrations can temporarily present an empty configuration value on
   * startup. Whichever store still has the domain repairs the other one.
   */
  private async restorePersistedDomain(): Promise<void> {
    const configured = this.readConfiguredDomain();
    const persisted = this.readPersistedDomain();
    const candidate = configured || persisted;
    if (!candidate) return;

    this.configuredDomain = normalizeNgrokDomain(candidate);
    if (persisted !== this.configuredDomain) {
      await this.context.globalState.update(NGROK_DOMAIN_STATE_KEY, this.configuredDomain);
    }
    if (configured !== this.configuredDomain) {
      try {
        await vscode.workspace.getConfiguration("shuncode").update(NGROK_DOMAIN_SETTING, this.configuredDomain, vscode.ConfigurationTarget.Global);
      } catch (error) {
        this.output.appendLine(`[bridge] could not repair ngrok domain setting: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private restoreConfiguredDomain(): void {
    const candidate = this.readConfiguredDomain() || this.readPersistedDomain();
    if (!candidate) return;
    try {
      this.configuredDomain = normalizeNgrokDomain(candidate);
    } catch {
      // Keep the last known-good in-memory value. Invalid external settings should not erase it.
    }
  }

  private async persistDomain(domain: string): Promise<void> {
    this.configuredDomain = normalizeNgrokDomain(domain);
    if (this.tunnelProvider === "ngrok") this.domain = this.configuredDomain;

    // Persist to the extension memento first so a configuration write failure cannot make the
    // domain disappear after a restart.
    await this.context.globalState.update(NGROK_DOMAIN_STATE_KEY, this.configuredDomain);
    try {
      await vscode.workspace.getConfiguration("shuncode").update(NGROK_DOMAIN_SETTING, this.configuredDomain, vscode.ConfigurationTarget.Global);
    } catch (error) {
      this.output.appendLine(`[bridge] ngrok domain saved to extension state, but settings.json update failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async configure(domain: string): Promise<BridgeStatus> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before changing its ngrok domain.");
    }
    await this.persistDomain(domain);
    this.lastError = undefined;
    return this.getStatus();
  }

  private async restorePersistedNamedDomain(): Promise<void> {
    const configured = this.readConfiguredNamedDomain();
    const persisted = this.readPersistedNamedDomain();
    const candidate = configured || persisted;
    if (!candidate) return;

    this.configuredNamedDomain = normalizeCloudflareNamedDomain(candidate);
    if (persisted !== this.configuredNamedDomain) {
      await this.context.globalState.update(CLOUDFLARE_NAMED_DOMAIN_STATE_KEY, this.configuredNamedDomain);
    }
    if (configured !== this.configuredNamedDomain) {
      try {
        await vscode.workspace.getConfiguration("shuncode").update(CLOUDFLARE_NAMED_DOMAIN_SETTING, this.configuredNamedDomain, vscode.ConfigurationTarget.Global);
      } catch (error) {
        this.output.appendLine(`[bridge] could not repair Cloudflare Named Tunnel hostname setting: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private restoreConfiguredNamedDomain(): void {
    const candidate = this.readConfiguredNamedDomain() || this.readPersistedNamedDomain();
    if (!candidate) return;
    try {
      this.configuredNamedDomain = normalizeCloudflareNamedDomain(candidate);
    } catch {
      // Keep the last known-good in-memory value. Invalid external settings should not erase it.
    }
  }

  async configureNamedTunnel(input: { domain: string; token?: string; localPort: number }): Promise<BridgeStatus> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before changing its Cloudflare Named Tunnel configuration.");
    }
    const domain = normalizeCloudflareNamedDomain(input.domain);
    const localPort = normalizeNamedTunnelLocalPort(input.localPort);
    const token = input.token?.trim();
    if (token !== undefined && !token) throw new Error("Cloudflare Tunnel Token cannot be empty.");

    this.configuredNamedDomain = domain;
    this.namedTunnelLocalPort = localPort;
    await this.context.globalState.update(CLOUDFLARE_NAMED_DOMAIN_STATE_KEY, domain);
    await vscode.workspace.getConfiguration("shuncode").update(CLOUDFLARE_NAMED_DOMAIN_SETTING, domain, vscode.ConfigurationTarget.Global);
    await vscode.workspace.getConfiguration("shuncode").update(CLOUDFLARE_NAMED_LOCAL_PORT_SETTING, localPort, vscode.ConfigurationTarget.Global);
    if (token !== undefined) {
      this.namedTunnelToken = token;
      await this.context.secrets.store(CLOUDFLARE_NAMED_TOKEN_SECRET, token);
    }
    if (this.tunnelProvider === "cloudflare-named") this.domain = domain;
    this.tunnelConfigValid = undefined;
    this.lastError = undefined;
    return await this.checkNamedTunnel();
  }

  async clearNamedTunnelToken(): Promise<BridgeStatus> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before clearing its Cloudflare Tunnel Token.");
    }
    this.namedTunnelToken = "";
    await this.context.secrets.delete(CLOUDFLARE_NAMED_TOKEN_SECRET);
    this.tunnelConfigValid = false;
    this.lastError = "Cloudflare Named Tunnel Token is not configured.";
    return this.getStatus();
  }

  async setTunnelProvider(provider: string): Promise<BridgeStatus> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before changing its tunnel provider.");
    }
    if (provider !== "cloudflare" && provider !== "cloudflare-named" && provider !== "ngrok") {
      throw new Error("Bridge tunnel provider must be cloudflare, cloudflare-named, or ngrok.");
    }
    this.tunnelProvider = provider;
    this.domain = this.configuredDomainForProvider(provider);
    this.tunnelInstalled = undefined;
    this.tunnelVersion = undefined;
    this.tunnelConfigValid = undefined;
    this.lastError = undefined;
    await vscode.workspace.getConfiguration("shuncode").update(TUNNEL_PROVIDER_SETTING, provider, vscode.ConfigurationTarget.Global);
    return this.getStatus();
  }

  async rotateEndpoint(): Promise<BridgeStatus> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before rotating its endpoint URL.");
    }
    this.routeToken = randomBytes(16).toString("hex");
    await this.context.secrets.store(ROUTE_TOKEN_SECRET, this.routeToken);
    return this.getStatus();
  }

  async checkTunnel(): Promise<BridgeStatus> {
    this.tunnelProvider = this.readTunnelProvider();
    return this.tunnelProvider === "ngrok"
      ? await this.checkNgrok()
      : this.tunnelProvider === "cloudflare-named"
        ? await this.checkNamedTunnel()
        : await this.checkCloudflared();
  }

  /**
   * Clears the tool-call timeline and resets the call statistics. Calls that are
   * still running are kept so their completion is still recorded consistently.
   * Task coordination lives in Task Runtime / Work Sessions and is unaffected.
   */
  clearActivityLog(): BridgeStatus {
    const running = this.activities.filter((item) => item.status === "running");
    const removed = this.activities.length - running.length;
    this.activities.splice(0, this.activities.length, ...running);
    this.toolCalls = running.length;
    this.completedToolCalls = 0;
    this.failedToolCalls = 0;
    this.totalToolDurationMs = 0;
    const newest = running.length ? running[running.length - 1] : undefined;
    this.lastTool = newest?.tool;
    this.lastToolAt = newest?.at;
    this.revision += 1;
    this.output.appendLine(`[bridge] tool activity log cleared: ${removed} entr${removed === 1 ? "y" : "ies"} removed${running.length ? `, ${running.length} running call(s) kept` : ""}`);
    return this.getStatus();
  }

  /**
   * Probes the Bridge end to end: local HTTP server, public tunnel endpoint,
   * tunnel process liveness and active MCP sessions. The report is kept on the
   * status so the Bridge panel can show the latest result.
   */
  async checkHealth(): Promise<BridgeStatus> {
    const startedAt = Date.now();
    const running = this.state === "running";
    const [local, publicProbe] = await Promise.all([
      this.probeLocalHealth(),
      running && this.domain && this.routeToken ? this.probePublicHealth() : Promise.resolve(undefined),
    ]);
    const tunnel = this.tunnelProcess;
    const tunnelProcessAlive = Boolean(tunnel && tunnel.exitCode === null && tunnel.signalCode === null);
    let lastSessionActivity = 0;
    for (const session of this.sessions.values()) {
      lastSessionActivity = Math.max(lastSessionActivity, session.lastActivity);
    }
    const ok = running && local.ok && publicProbe?.ok === true && tunnelProcessAlive;
    const problems: string[] = [];
    if (!running) problems.push(`Bridge is ${this.state}`);
    if (!local.ok) problems.push(`local: ${local.error ?? "failed"}`);
    if (running && !publicProbe) problems.push("public endpoint not assigned");
    if (publicProbe && !publicProbe.ok) problems.push(`public: ${publicProbe.error ?? "failed"}`);
    if (running && !tunnelProcessAlive) problems.push("tunnel process not running");
    const summary = ok
      ? `healthy · local ${local.latencyMs ?? 0} ms · public ${publicProbe?.latencyMs ?? 0} ms · ${this.sessions.size} MCP session(s)`
      : `unhealthy · ${problems.join("; ")}`;
    const report: BridgeHealthReport = {
      at: new Date().toISOString(),
      ok,
      state: this.state,
      durationMs: Date.now() - startedAt,
      local,
      public: publicProbe,
      tunnelProcessAlive,
      sessions: this.sessions.size,
      activeRequests: this.activeRequests,
      lastSessionActivityAt: lastSessionActivity ? new Date(lastSessionActivity).toISOString() : undefined,
      summary,
    };
    this.lastHealth = report;
    this.output.appendLine(`[bridge] health check: ${summary}`);
    return this.getStatus();
  }

  private async probeLocalHealth(): Promise<BridgeHealthProbe> {
    if (!this.localPort || !this.routeToken) {
      return { ok: false, error: this.state === "running" ? "local HTTP port unavailable" : "Bridge is not running" };
    }
    const url = `http://127.0.0.1:${this.localPort}/healthz/${this.routeToken}`;
    const started = Date.now();
    try {
      const response = await fetch(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(3_000) });
      const latencyMs = Date.now() - started;
      if (!response.ok) return { ok: false, url, latencyMs, error: `HTTP ${response.status}` };
      const payload = await response.json().catch(() => undefined) as { ok?: unknown } | undefined;
      return payload?.ok === true
        ? { ok: true, url, latencyMs }
        : { ok: false, url, latencyMs, error: "health response did not confirm ok" };
    } catch (error) {
      return { ok: false, url, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async probePublicHealth(): Promise<BridgeHealthProbe> {
    const url = this.publicHealthUrl();
    const started = Date.now();
    const result = await this.requestPublicHealth(PUBLIC_HEALTH_REQUEST_TIMEOUT_MS * 2);
    const latencyMs = Date.now() - started;
    return result.ok
      ? { ok: true, url, latencyMs }
      : { ok: false, url, latencyMs, error: result.failure.reason };
  }

  async checkNgrok(): Promise<BridgeStatus> {
    let lastError: unknown;
    for (const executable of this.ngrokExecutableCandidates()) {
      try {
        const version = await execFileAsync(executable, ["version"], { windowsHide: true, timeout: 10_000 });
        this.ngrokExecutable = executable;
        this.tunnelInstalled = true;
        this.tunnelVersion = String(version.stdout || version.stderr).trim().split(/\r?\n/)[0] || "ngrok";
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!this.tunnelInstalled || lastError) {
      this.tunnelInstalled = false;
      this.tunnelConfigValid = false;
      this.tunnelVersion = undefined;
      this.lastError = `ngrok was not found: ${lastError instanceof Error ? lastError.message : String(lastError ?? "not installed")}`;
      return this.getStatus();
    }

    try {
      await execFileAsync(this.ngrokExecutable, ["config", "check"], { windowsHide: true, timeout: 10_000 });
      this.tunnelConfigValid = true;
      this.lastError = undefined;
    } catch (error) {
      this.tunnelConfigValid = false;
      this.lastError = `ngrok config check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    return this.getStatus();
  }

  private async checkCloudflared(): Promise<BridgeStatus> {
    let lastError: unknown;
    for (const executable of this.cloudflaredExecutableCandidates()) {
      try {
        const version = await execFileAsync(executable, ["--version"], { windowsHide: true, timeout: 10_000 });
        this.cloudflaredExecutable = executable;
        this.tunnelInstalled = true;
        this.tunnelVersion = String(version.stdout || version.stderr).trim().split(/\r?\n/)[0] || "cloudflared";
        this.tunnelConfigValid = true;
        this.lastError = undefined;
        return this.getStatus();
      } catch (error) {
        lastError = error;
      }
    }
    this.tunnelInstalled = false;
    this.tunnelConfigValid = false;
    this.tunnelVersion = undefined;
    this.lastError = `cloudflared was not found: ${lastError instanceof Error ? lastError.message : String(lastError ?? "not installed")}`;
    return this.getStatus();
  }

  private async checkNamedTunnel(): Promise<BridgeStatus> {
    await this.checkCloudflared();
    if (!this.tunnelInstalled) return this.getStatus();

    this.namedTunnelToken = await this.context.secrets.get(CLOUDFLARE_NAMED_TOKEN_SECRET) ?? "";
    this.restoreConfiguredNamedDomain();
    this.namedTunnelLocalPort = this.readNamedTunnelLocalPort();
    this.domain = this.configuredNamedDomain;

    if (!this.namedTunnelToken) {
      this.tunnelConfigValid = false;
      this.lastError = "Cloudflare Named Tunnel Token is not configured.";
      return this.getStatus();
    }
    if (!this.configuredNamedDomain) {
      this.tunnelConfigValid = false;
      this.lastError = "Cloudflare Named Tunnel hostname is not configured.";
      return this.getStatus();
    }
    try {
      this.namedTunnelLocalPort = normalizeNamedTunnelLocalPort(this.namedTunnelLocalPort);
    } catch (error) {
      this.tunnelConfigValid = false;
      this.lastError = error instanceof Error ? error.message : String(error);
      return this.getStatus();
    }

    this.tunnelConfigValid = true;
    this.lastError = undefined;
    return this.getStatus();
  }

  private cloudflaredExecutableCandidates(): string[] {
    const candidates = [this.cloudflaredExecutable, "cloudflared"];
    if (process.platform === "win32") {
      if (process.env.LOCALAPPDATA) {
        candidates.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "cloudflared.exe"));
        candidates.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "cloudflared.exe"));
      }
      if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, "cloudflared", "cloudflared.exe"));
      if (process.env["ProgramFiles(x86)"]) candidates.push(path.join(process.env["ProgramFiles(x86)"]!, "cloudflared", "cloudflared.exe"));
    }
    return [...new Set(candidates.filter(Boolean))];
  }

  private ngrokExecutableCandidates(): string[] {
    const candidates = [this.ngrokExecutable, "ngrok"];
    if (process.platform === "win32") {
      if (process.env.LOCALAPPDATA) {
        candidates.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", "ngrok.exe"));
        candidates.push(path.join(process.env.LOCALAPPDATA, "Microsoft", "WindowsApps", "ngrok.exe"));
      }
      if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, "ngrok", "ngrok.exe"));
      if (process.env["ProgramFiles(x86)"]) candidates.push(path.join(process.env["ProgramFiles(x86)"]!, "ngrok", "ngrok.exe"));
    }
    return [...new Set(candidates.filter(Boolean))];
  }

  async installCloudflared(): Promise<BridgeStatus> {
    if (this.state === "running" || this.state === "starting") {
      throw new Error("Stop the Bridge before installing cloudflared.");
    }
    this.tunnelProvider = this.readTunnelProvider();
    if (this.tunnelProvider !== "cloudflare" && this.tunnelProvider !== "cloudflare-named") {
      throw new Error("Select a Cloudflare tunnel mode before installing cloudflared.");
    }
    const existing = await this.checkCloudflared();
    if (existing.tunnelInstalled) return this.tunnelProvider === "cloudflare-named" ? await this.checkNamedTunnel() : existing;
    if (process.platform !== "win32") {
      throw new Error("One-click cloudflared installation is currently supported on Windows with Winget.");
    }

    this.output.appendLine(`[bridge] installing cloudflared with Winget package ${CLOUDFLARED_WINGET_PACKAGE}...`);
    try {
      const result = await execFileAsync("winget", [
        "install",
        "--id", CLOUDFLARED_WINGET_PACKAGE,
        "--exact",
        "--source", "winget",
        "--silent",
        "--disable-interactivity",
        "--accept-package-agreements",
        "--accept-source-agreements",
      ], {
        windowsHide: false,
        timeout: 10 * 60 * 1000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const output = String(result.stdout || result.stderr).trim();
      if (output) this.output.appendLine(`[winget] ${output}`);
    } catch (error) {
      const details = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
      const output = [details.message, String(details.stdout ?? "").trim(), String(details.stderr ?? "").trim()].filter(Boolean).join("\n");
      this.lastError = `cloudflared installation failed: ${output}`;
      throw new Error(this.lastError);
    }

    const installed = await this.checkCloudflared();
    if (!installed.tunnelInstalled) {
      this.lastError = "cloudflared installation completed, but ShunCode could not locate the executable. Restart ShunCode and check the tunnel again.";
      throw new Error(this.lastError);
    }
    this.output.appendLine(`[bridge] cloudflared installation verified: ${installed.tunnelVersion ?? "installed"}`);
    return this.tunnelProvider === "cloudflare-named" ? await this.checkNamedTunnel() : installed;
  }

  async start(domain?: string): Promise<BridgeStatus> {
    if (this.state === "running") return this.getStatus();
    if (this.startPromise) return this.startPromise;
    // During automatic tunnel recovery the local HTTP/MCP runtime is intentionally kept alive.
    // A manual Start click must not create a second listener/tunnel while that recovery owns it.
    if (this.state === "starting" && this.httpServer) return this.getStatus();
    this.startPromise = this.startInternal(domain);
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  /** Development-only transport smoke: opens the exact local Streamable HTTP MCP server without a public tunnel. */
  async startLocalSmoke(): Promise<BridgeStatus> {
    if (this.context.extensionMode !== vscode.ExtensionMode.Development || process.env.SHUNCODE_BRIDGE_SMOKE_LOCAL !== "1") {
      throw new Error("Local Bridge smoke mode is available only in an Extension Development Host with SHUNCODE_BRIDGE_SMOKE_LOCAL=1.");
    }
    if (this.state === "running") return this.getStatus();
    if (!this.routeToken) await this.initialize();
    if (!vscode.workspace.workspaceFolders?.length) throw new Error("Open a workspace folder before starting the Bridge smoke server.");
    this.state = "starting";
    this.lastError = undefined;
    try {
      await this.startHttpServer();
      await this.verifyLocalHealth();
      this.state = "running";
      this.output.appendLine(`[bridge-smoke] local Streamable HTTP server running on 127.0.0.1:${this.localPort}`);
      return this.getStatus();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = "error";
      await this.stopResources(false);
      throw error;
    }
  }

  private async startInternal(domain?: string): Promise<BridgeStatus> {
    // Final defense-in-depth boundary. Authorization happens before state changes,
    // local TCP listeners, MCP sessions, or tunnel processes are created.
    try {
      await this.authorizeStart();
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.state = "error";
      throw error;
    }
    this.stoppingResources = false;
    this.state = "starting";
    this.lastError = undefined;
    try {
      if (!this.routeToken) await this.initialize();
      this.tunnelProvider = this.readTunnelProvider();
      if (this.tunnelProvider === "ngrok") {
        const resolvedDomain = domain ?? (this.configuredDomain || this.readConfiguredDomain() || this.readPersistedDomain());
        await this.persistDomain(resolvedDomain);
      } else if (this.tunnelProvider === "cloudflare-named") {
        this.namedTunnelToken = await this.context.secrets.get(CLOUDFLARE_NAMED_TOKEN_SECRET) ?? "";
        this.restoreConfiguredNamedDomain();
        this.namedTunnelLocalPort = this.readNamedTunnelLocalPort();
        this.domain = this.configuredNamedDomain;
      } else {
        this.domain = "";
      }

      const folders = vscode.workspace.workspaceFolders;
      if (!folders?.length) throw new Error("Open a workspace folder before starting the Bridge.");

      const tunnel = await this.checkTunnel();
      if (!tunnel.tunnelInstalled) throw new Error(this.lastError ?? `${this.tunnelProvider} tunnel client is not installed.`);
      if (!tunnel.tunnelConfigValid) throw new Error(this.lastError ?? `${this.tunnelProvider} tunnel configuration is invalid.`);

      await this.startHttpServer();
      await this.verifyLocalHealth();
      await this.startTunnelOnce();

      this.state = "running";
      const publicUrl = this.getStatus().publicUrl;
      this.output.appendLine(`[bridge] running ${publicUrl} -> 127.0.0.1:${this.localPort}`);
      return this.getStatus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      this.state = "error";
      await this.stopResources(false);
      throw error;
    }
  }

  private async startHttpServer(): Promise<void> {
    const endpointPath = `/mcp/${this.routeToken}`;
    const healthPath = `/healthz/${this.routeToken}`;
    const server = createHttpServer((request, response) => {
      void this.handleHttpRequest(endpointPath, healthPath, request, response).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.output.appendLine(`[bridge] HTTP error: ${message}`);
        writeJsonError(response, 500, message);
      });
    });
    this.httpServer = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error & { code?: string }) => {
        server.off("listening", onListening);
        if (this.tunnelProvider === "cloudflare-named" && error.code === "EADDRINUSE") {
          reject(new Error(`Cloudflare Named Tunnel local port ${this.namedTunnelLocalPort} is already in use. Choose another port and update the Cloudflare published application Service URL.`));
          return;
        }
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.tunnelProvider === "cloudflare-named" ? this.namedTunnelLocalPort : 0, "127.0.0.1");
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Bridge local HTTP server did not expose a TCP port.");
    this.localPort = address.port;
    server.on("error", (error) => {
      if (this.httpServer !== server || this.stoppingResources) return;
      const message = `Bridge local HTTP server failed after startup: ${error.message}`;
      this.output.appendLine(`[bridge] ${message}`);
      this.lastError = message;
      this.state = "error";
      this.revision += 1;
      void this.stopResources(false);
    });
    server.on("close", () => {
      if (this.httpServer !== server || this.stoppingResources) return;
      const message = "Bridge local HTTP server closed unexpectedly.";
      this.httpServer = undefined;
      this.localPort = undefined;
      this.output.appendLine(`[bridge] ${message}`);
      this.lastError = message;
      this.state = "error";
      this.revision += 1;
      void this.stopResources(false);
    });
    this.sessionPruneTimer = setInterval(() => this.pruneSessions(), SESSION_PRUNE_INTERVAL_MS);
    this.sessionPruneTimer.unref?.();
  }

  private async verifyLocalHealth(): Promise<void> {
    if (!this.localPort) throw new Error("Bridge local HTTP port is unavailable after startup.");
    const url = new URL(`http://127.0.0.1:${this.localPort}/healthz/${this.routeToken}`);
    let response: Response;
    try {
      response = await fetch(url, { method: "GET", cache: "no-store", signal: AbortSignal.timeout(3_000) });
    } catch (error) {
      throw new Error(`Bridge local HTTP health check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`Bridge local HTTP health check returned HTTP ${response.status}.`);
    const payload = await response.json().catch(() => undefined) as { ok?: unknown } | undefined;
    if (payload?.ok !== true) throw new Error("Bridge local HTTP health check did not confirm readiness.");
    this.output.appendLine(`[bridge] local health verified: ${url}`);
  }

  private tunnelProcessEnvironment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (this.tunnelProvider === "ngrok") {
      return this.ngrokProcessEnvironment(env);
    }
    const httpConfiguration = vscode.workspace.getConfiguration("http");
    const proxySupport = httpConfiguration.get<string>("proxySupport");
    const configuredProxy = httpConfiguration.get<string>("proxy")?.trim();
    if (proxySupport !== "off") {
      const proxyUrl = resolveExtensionHostProxy(new URL("https://www.cloudflare.com/"), configuredProxy);
      if (proxyUrl) {
        const forceConfiguredProxy = Boolean(configuredProxy);
        const hasAllProxy = Boolean(env.ALL_PROXY || env.all_proxy);
        if (forceConfiguredProxy || (!env.HTTPS_PROXY && !env.https_proxy && !hasAllProxy)) env.HTTPS_PROXY = proxyUrl;
        if (forceConfiguredProxy || (!env.HTTP_PROXY && !env.http_proxy && !hasAllProxy)) env.HTTP_PROXY = proxyUrl;
        this.output.appendLine("[bridge] tunnel process will use configured/system HTTP proxy settings.");
      }
    }
    if (this.tunnelProvider === "cloudflare-named") env.TUNNEL_TOKEN = this.namedTunnelToken;
    return env;
  }

  /**
   * ngrok Free rejects agents that connect through an HTTP/S proxy with
   * ERR_NGROK_9009, so the ngrok process runs in direct mode by default and
   * inherited proxy variables are stripped (both case variants). Users with
   * an ngrok Pay-as-you-go plan can opt into the resolved proxy explicitly
   * via shuncode.bridge.ngrokUseHttpProxy.
   */
  private ngrokProcessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    if (this.ngrokUseHttpProxyEnabled()) {
      const httpConfiguration = vscode.workspace.getConfiguration("http");
      const configuredProxy = httpConfiguration.get<string>("proxy")?.trim();
      const proxyUrl = httpConfiguration.get<string>("proxySupport") === "off"
        ? undefined
        : resolveExtensionHostProxy(new URL("https://www.cloudflare.com/"), configuredProxy);
      if (proxyUrl) {
        env.HTTPS_PROXY = proxyUrl;
        env.HTTP_PROXY = proxyUrl;
        this.output.appendLine("[bridge] ngrok process will use the resolved HTTP proxy (shuncode.bridge.ngrokUseHttpProxy); this requires an ngrok Pay-as-you-go plan.");
      } else {
        this.output.appendLine("[bridge] shuncode.bridge.ngrokUseHttpProxy is enabled, but no HTTP proxy was resolved; the ngrok process will connect directly.");
      }
      return env;
    }
    for (const key of Object.keys(env)) {
      if (/^(https?|all)_proxy$/i.test(key)) delete env[key];
    }
    this.output.appendLine("[bridge] ngrok process will connect directly; inherited proxy variables were removed (ngrok Free rejects HTTP proxies with ERR_NGROK_9009).");
    return env;
  }

  private ngrokUseHttpProxyEnabled(): boolean {
    return vscode.workspace.getConfiguration("shuncode").get<boolean>(NGROK_USE_HTTP_PROXY_SETTING, false) === true;
  }

  private startTunnelProcess(): ChildProcessWithoutNullStreams {
    if (!this.localPort) throw new Error("Bridge local HTTP port is unavailable.");
    const isCloudflare = this.tunnelProvider === "cloudflare" || this.tunnelProvider === "cloudflare-named";
    const command = isCloudflare ? this.cloudflaredExecutable : this.ngrokExecutable;
    const commandLabel = isCloudflare ? "cloudflared" : "ngrok";
    const args = this.tunnelProvider === "cloudflare"
      ? ["tunnel", "--url", `http://127.0.0.1:${this.localPort}`]
      : this.tunnelProvider === "cloudflare-named"
        ? ["tunnel", "run"]
        : ["http", String(this.localPort), "--url", `https://${this.configuredDomain}`, "--log=stdout", "--log-format=json"];
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: this.tunnelProcessEnvironment(),
    });
    this.tunnelProcess = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.output.append(`[${commandLabel}] ${String(chunk)}`));
    child.stderr.on("data", (chunk) => this.output.append(`[${commandLabel}] ${String(chunk)}`));
    child.on("error", (error) => {
      this.output.appendLine(`[${commandLabel}] process error: ${error.message}`);
      this.lastError = error.message;
      if (this.tunnelProcess === child && !this.stoppingResources && this.httpServer && this.state === "running") {
        this.tunnelProcess = undefined;
        if (this.tunnelProvider === "cloudflare") this.domain = "";
        this.state = "starting";
        this.revision += 1;
        if (!child.killed) child.kill();
        this.beginTunnelRecovery();
      }
    });
    child.on("exit", (code, signal) => {
      if (this.tunnelProcess === child) this.tunnelProcess = undefined;
      if (!this.stoppingResources && this.httpServer && this.state === "running") {
        const message = `${commandLabel} exited unexpectedly (code=${String(code)}, signal=${String(signal)}); reconnecting without stopping the local MCP server.`;
        this.output.appendLine(`[bridge] ${message}`);
        this.lastError = message;
        if (this.tunnelProvider === "cloudflare") this.domain = "";
        this.state = "starting";
        this.revision += 1;
        this.beginTunnelRecovery();
      }
    });
    return child;
  }

  private async waitForTunnelStartup(child: ChildProcessWithoutNullStreams): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let output = "";
      const cleanup = () => {
        clearTimeout(timer);
        child.off("exit", onExit);
        child.off("error", onError);
        child.stdout.off("data", onData);
        child.stderr.off("data", onData);
      };
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error); else resolve();
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        const detail = output.trim().slice(-4_000);
        finish(new Error(`${this.tunnelProvider} tunnel exited during startup (code=${String(code)}, signal=${String(signal)}).${detail ? ` ${detail}` : ""}`));
      };
      const onError = (error: Error) => finish(error);
      const onData = (chunk: Buffer | string) => {
        output = `${output}${String(chunk)}`.slice(-16_000);
        const lower = output.toLowerCase();
        if (this.tunnelProvider === "cloudflare") {
          const matches = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/ig);
          const tunnelUrl = matches?.find((candidate) => new URL(candidate).hostname.toLowerCase() !== "api.trycloudflare.com");
          if (tunnelUrl) {
            this.domain = new URL(tunnelUrl).hostname.toLowerCase();
            this.revision += 1;
            finish();
          }
          return;
        }
        if (this.tunnelProvider === "cloudflare-named") {
          if (lower.includes("invalid tunnel token") || lower.includes("failed to parse token") || lower.includes("authentication failed") || lower.includes("unauthorized")) {
            finish(new Error(`Cloudflare Named Tunnel authentication failed. Rotate or recopy the Tunnel Token. ${output.trim().slice(-4_000)}`));
            return;
          }
          if (lower.includes("registered tunnel connection") || lower.includes("connection registered") || lower.includes("initial protocol")) {
            finish();
          }
          return;
        }
        if (lower.includes('"msg":"started tunnel"') && lower.includes(this.configuredDomain.toLowerCase())) {
          finish();
          return;
        }
        if (lower.includes("err_ngrok_9009") || lower.includes("pay-as-you-go")) {
          finish(new Error(`ngrok cannot run through an HTTP/S proxy on the Free plan (ERR_NGROK_9009). Bridge starts ngrok with proxy variables removed, so check the ngrok config file (for example %LOCALAPPDATA%\\ngrok\\ngrok.yml) for a proxy_url entry and remove it, switch the proxy client to TUN mode with the system proxy off, or upgrade ngrok to a Pay-as-you-go plan and set shuncode.bridge.ngrokUseHttpProxy to reuse this proxy. ${output.trim().slice(-2_000)}`));
          return;
        }
        if (lower.includes("err_ngrok_") || lower.includes("endpoint is already online") || lower.includes("failed to start tunnel")) {
          finish(new Error(`ngrok failed to establish the reserved domain. ${output.trim().slice(-4_000)}`));
        }
      };
      child.once("exit", onExit);
      child.once("error", onError);
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      // Public HTTPS health is the source of truth. Quick Tunnel must emit its generated hostname;
      // Named Tunnel and ngrok log wording can vary between releases.
      const timer = setTimeout(() => {
        if (this.tunnelProvider === "cloudflare") {
          finish(new Error(`cloudflared did not provide a trycloudflare.com URL.${cloudflaredEdgeFailureHint(output)} ${output.trim().slice(-4_000)}`));
        } else {
          finish();
        }
      }, this.tunnelProvider === "cloudflare" ? 45_000 : 5_000);
    });
  }

  private publicHealthUrl(): string {
    return `https://${this.domain}/healthz/${this.routeToken}`;
  }

  private async requestPublicHealth(totalTimeoutMs = PUBLIC_HEALTH_REQUEST_TIMEOUT_MS * 3): Promise<{ ok: true } | { ok: false; failure: PublicHealthFailure }> {
    try {
      const url = new URL(this.publicHealthUrl());
      const headers = this.tunnelProvider === "ngrok" ? { "ngrok-skip-browser-warning": "true" } : undefined;
      const httpConfiguration = vscode.workspace.getConfiguration("http");
      const configuredProxy = httpConfiguration.get<string>("proxy")?.trim();
      const proxySupport = httpConfiguration.get<string>("proxySupport");
      const proxyUrl = proxySupport === "off" ? undefined : resolveExtensionHostProxy(url, configuredProxy);
      const boundedTimeoutMs = Math.max(1_000, Math.min(totalTimeoutMs, PUBLIC_HEALTH_REQUEST_TIMEOUT_MS * 3));
      const response = await fetchWithExtensionHostFallbacks(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(boundedTimeoutMs),
        proxyUrl,
        rejectUnauthorized: httpConfiguration.get<boolean>("proxyStrictSSL", true),
        useElectron: proxySupport !== "off",
        attemptTimeoutMs: Math.min(PUBLIC_HEALTH_REQUEST_TIMEOUT_MS, boundedTimeoutMs),
      });
      if (!response.ok) {
        return { ok: false, failure: { reason: `HTTP ${response.status} ${response.statusText ?? ""}`.trim(), code: `HTTP_${response.status}`, status: response.status, deterministic: false } };
      }
      const payload = await response.json().catch(() => undefined) as { ok?: unknown } | undefined;
      return payload?.ok === true
        ? { ok: true }
        : { ok: false, failure: { reason: "health response did not confirm ok", status: response.status, deterministic: false } };
    } catch (error) {
      return { ok: false, failure: publicHealthFailure(error) };
    }
  }

  private async waitForPublicHealth(child: ChildProcessWithoutNullStreams): Promise<void> {
    const configuredTimeout = vscode.workspace.getConfiguration("shuncode").get<number>(PUBLIC_HEALTH_STARTUP_TIMEOUT_SETTING, DEFAULT_PUBLIC_HEALTH_STARTUP_TIMEOUT_MS);
    const timeoutMs = typeof configuredTimeout === "number" && Number.isFinite(configuredTimeout)
      ? Math.min(Math.max(configuredTimeout, 5_000), 120_000)
      : DEFAULT_PUBLIC_HEALTH_STARTUP_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    let consecutiveDeterministicFailures = 0;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null || this.tunnelProcess !== child) {
        throw new Error(`${this.tunnelProvider} tunnel exited before the public Bridge health endpoint became reachable.`);
      }
      const result = await this.requestPublicHealth(Math.max(1_000, deadline - Date.now()));
      if (result.ok) return;
      consecutiveDeterministicFailures = result.failure.deterministic ? consecutiveDeterministicFailures + 1 : 0;
      if (result.failure.deterministic && consecutiveDeterministicFailures >= PUBLIC_HEALTH_DETERMINISTIC_FAILURE_LIMIT) {
        throw new Error(this.publicHealthUnreachableMessage(result.failure));
      }
      await new Promise<void>((resolve) => setTimeout(resolve, PUBLIC_HEALTH_POLL_INTERVAL_MS));
    }
    if (this.tunnelProvider === "cloudflare-named") {
      throw new Error(`Cloudflare Named Tunnel connected, but ${this.publicHealthUrl()} could not reach Bridge. In Cloudflare Tunnels, set the published application hostname to ${this.configuredNamedDomain} and its Service URL to http://127.0.0.1:${this.namedTunnelLocalPort}.`);
    }
    throw new Error(`Public Bridge health check timed out after ${Math.round(timeoutMs / 1000)} seconds: ${this.publicHealthUrl()}`);
  }

  private publicHealthUnreachableMessage(failure: PublicHealthFailure): string {
    const httpConfiguration = vscode.workspace.getConfiguration("http");
    const hasProxy = Boolean(httpConfiguration.get<string>("proxy")?.trim()
      || process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.HTTP_PROXY || process.env.http_proxy);
    const guidance = hasProxy
      ? "The health request was routed through the configured HTTP proxy and still failed. Verify the proxy can reach Cloudflare, or enable a system/global (TUN) proxy."
      : "This machine cannot reach the public endpoint directly. Set http.proxy to a working HTTP proxy or enable a system/global (TUN) proxy so the health check can route around the block.";
    return `Public Bridge health endpoint unreachable: ${this.publicHealthUrl()} (${failure.reason}). ${guidance}`;
  }

  private async startTunnelOnce(): Promise<void> {
    const child = this.startTunnelProcess();
    try {
      await this.waitForTunnelStartup(child);
      // Align with codexpro: a Cloudflare quick tunnel is considered ready as
      // soon as cloudflared reports a trycloudflare.com URL. The public
      // healthz round-trip depends on the user's outbound network and proxies
      // (e.g. Cloudflare domains blocked on 443 while a local HTTP proxy is
      // configured), so it must not gate startup or kill a working tunnel.
      // Stable hostname modes keep the health round-trip because they are
      // used with user-managed domains where a missing route is actionable.
      if (this.tunnelProvider === "cloudflare") {
        this.output.appendLine(`[bridge] quick tunnel URL received; local health is ready and public health is not used as a startup gate: ${this.publicHealthUrl()}`);
      } else {
        await this.waitForPublicHealth(child);
        this.output.appendLine(`[bridge] public health verified: ${this.publicHealthUrl()}`);
      }
      if (this.tunnelProcess !== child) throw new Error(`${this.tunnelProvider} tunnel changed before health verification completed.`);
    } catch (error) {
      if (this.tunnelProcess === child) this.tunnelProcess = undefined;
      if (!child.killed) child.kill();
      throw error;
    }
  }

  private isDeterministicTunnelFailure(message: string): boolean {
    if (this.tunnelProvider !== "ngrok") return false;
    const lower = message.toLowerCase();
    return lower.includes("err_ngrok_9009") || lower.includes("pay-as-you-go") || lower.includes("authentication failed");
  }

  private beginTunnelRecovery(): void {
    if (this.stoppingResources || !this.httpServer) return;
    if (this.tunnelRecoveryPromise && this.tunnelRecoveryGeneration === this.tunnelGeneration) return;
    const generation = this.tunnelGeneration;
    const recovery = (async () => {
      let attempt = 0;
      while (!this.stoppingResources && this.httpServer && generation === this.tunnelGeneration) {
        const delayMs = TUNNEL_RESTART_BACKOFF_MS[Math.min(attempt, TUNNEL_RESTART_BACKOFF_MS.length - 1)];
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
        if (this.stoppingResources || !this.httpServer || generation !== this.tunnelGeneration) return;
        try {
          this.output.appendLine(`[bridge] ${this.tunnelProvider} reconnect attempt ${attempt + 1}...`);
          await this.startTunnelOnce();
          if (generation !== this.tunnelGeneration || this.stoppingResources) return;
          this.state = "running";
          this.lastError = undefined;
          this.revision += 1;
          this.output.appendLine(`[bridge] ${this.tunnelProvider} tunnel recovered: ${this.getStatus().publicUrl}`);
          return;
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.output.appendLine(`[bridge] ${this.tunnelProvider} reconnect attempt ${attempt + 1} failed: ${this.lastError}`);
          if (this.isDeterministicTunnelFailure(this.lastError)) {
            this.output.appendLine(`[bridge] ${this.tunnelProvider} stopped reconnecting: this failure is deterministic and will not resolve by retrying.`);
            return;
          }
          attempt += 1;
        }
      }
    });
    let trackedRecovery!: Promise<void>;
    trackedRecovery = recovery().finally(() => {
      if (this.tunnelRecoveryPromise === trackedRecovery) {
        this.tunnelRecoveryPromise = undefined;
        this.tunnelRecoveryGeneration = undefined;
      }
    });
    this.tunnelRecoveryGeneration = generation;
    this.tunnelRecoveryPromise = trackedRecovery;
  }

  private async handleHttpRequest(endpointPath: string, healthPath: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === healthPath) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        writeJsonError(response, 405, "Method not allowed.");
        return;
      }
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.writeHead(200);
      if (request.method !== "HEAD") {
        response.end(JSON.stringify({ ok: true, name: "shuncode-bridge", sessions: this.sessions.size }));
      } else {
        response.end();
      }
      return;
    }
    if (url.pathname !== endpointPath) {
      writeJsonError(response, 404, "Not found");
      return;
    }

    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "content-type, accept, mcp-session-id, mcp-protocol-version, mcp-method, mcp-name, last-event-id, authorization");
    response.setHeader("Access-Control-Expose-Headers", "mcp-session-id");
    response.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    // Route to existing session by mcp-session-id header
    const sessionId = request.headers["mcp-session-id"] as string | undefined;

    if (request.method === "POST") {
      const body = await readJsonBody(request);
      await this.handlePost(request, response, body, sessionId);
      return;
    }

    if (request.method === "GET") {
      await this.handleGet(request, response, sessionId);
      return;
    }

    if (request.method === "DELETE") {
      await this.handleDelete(request, response, sessionId);
      return;
    }

    writeJsonError(response, 405, "Method not allowed.");
  }

  private async handlePost(request: IncomingMessage, response: ServerResponse, body: unknown, sessionId: string | undefined): Promise<void> {
    // If sessionId is provided, route to existing session
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        writeJsonError(response, 404, "Session not found. The MCP session may have expired.");
        return;
      }
      session.lastActivity = Date.now();
      session.activeRequests += 1;
      this.activeRequests += 1;
      try {
        await session.transport.handleRequest(request, response, body);
      } finally {
        session.activeRequests = Math.max(0, session.activeRequests - 1);
        session.lastActivity = Date.now();
        this.activeRequests = Math.max(0, this.activeRequests - 1);
      }
      return;
    }

    if (!isInitializeRequest(body)) {
      writeJsonError(response, 400, "Bad Request: a POST without Mcp-Session-Id must be an MCP initialize request.");
      return;
    }
    this.makeRoomForSession();
    if (this.sessions.size >= MAX_SESSIONS) {
      writeJsonError(response, 503, "Bridge session capacity reached. Close an existing MCP session and retry.");
      return;
    }

    // No session ID: validated initialization request. Create a new session.
    const { transport, server } = this.createSession();
    this.activeRequests += 1;
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch (error) {
      // If session creation failed during initialization, clean up
      const newSessionId = transport.sessionId;
      if (newSessionId) this.destroySession(newSessionId);
      throw error;
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
    }
  }

  private async handleGet(request: IncomingMessage, response: ServerResponse, sessionId: string | undefined): Promise<void> {
    if (this.tunnelProvider === "cloudflare") {
      response.setHeader("Allow", "POST, DELETE, OPTIONS");
      writeJsonError(response, 405, "Standalone SSE is disabled for Cloudflare Quick Tunnel; use Streamable HTTP POST responses.");
      return;
    }
    if (!sessionId) {
      writeJsonError(response, 400, "Bad Request: Mcp-Session-Id header is required for GET requests.");
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      writeJsonError(response, 404, "Session not found. The MCP session may have expired.");
      return;
    }
    session.lastActivity = Date.now();
    session.activeStreams += 1;
    let released = false;
    const releaseStream = () => {
      if (released) return;
      released = true;
      session.activeStreams = Math.max(0, session.activeStreams - 1);
      session.lastActivity = Date.now();
    };
    response.once("close", releaseStream);
    try {
      await session.transport.handleRequest(request, response);
    } finally {
      response.off("close", releaseStream);
      releaseStream();
    }
  }

  private async handleDelete(request: IncomingMessage, response: ServerResponse, sessionId: string | undefined): Promise<void> {
    if (!sessionId) {
      writeJsonError(response, 400, "Bad Request: Mcp-Session-Id header is required for DELETE requests.");
      return;
    }
    const session = this.sessions.get(sessionId);
    if (!session) {
      writeJsonError(response, 404, "Session not found.");
      return;
    }
    await session.transport.handleRequest(request, response);
    this.destroySession(sessionId);
  }

  private createSession(): { transport: StreamableHTTPServerTransport; server: McpServer } {
    const packageVersion = this.context.extension?.packageJSON?.version;
    const server = new McpServer(
      { name: "shuncode-bridge", version: typeof packageVersion === "string" && packageVersion ? packageVersion : "0.0.0" },
      { capabilities: { tools: {}, logging: {} }, instructions: BRIDGE_SERVER_INSTRUCTIONS },
    );
    let transport!: StreamableHTTPServerTransport;
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: this.tunnelProvider === "cloudflare",
      eventStore: new BoundedInMemoryEventStore(),
      keepAliveMs: SESSION_KEEPALIVE_INTERVAL_MS,
      retryInterval: SESSION_RETRY_INTERVAL_MS,
      onsessioninitialized: (sid) => {
        this.sessions.set(sid, {
          transport,
          server,
          lastActivity: Date.now(),
          activeRequests: 0,
          activeStreams: 0,
        });
        this.revision += 1;
        this.output.appendLine(`[bridge] new MCP session: ${sid}`);
      },
      onsessionclosed: (sid) => {
        this.destroySession(sid);
      },
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: BRIDGE_TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        _meta: tool._meta,
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const toolName = request.params.name;
      const args = request.params.arguments ?? {};
      this.toolCallsSinceLastReport += 1;
      const sessionKey = extra.sessionId?.trim() || "unscoped";
      const taskId = await this.taskShadow.ensureBridgeTask(sessionKey, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
      const executionId = `mcp:${sessionKey}:${String(extra.requestId)}`;
      const execution = await this.taskShadow.beginExecution(taskId, executionId, toolName, args);
      const shadowStartedAt = Date.now();
      try {
        const result = await this.handleToolCall(toolName, args, { signal: extra.signal, taskId });
        const resultText = result.content.map(item => item.text).join("\n");
        await this.taskShadow.finishExecution(execution, result.isError ? "failed" : "succeeded", {
          durationMs: Date.now() - shadowStartedAt,
          error: result.isError ? resultText : undefined,
          resultSummary: resultText,
        });
        if (toolName === "apply_patch" && !result.isError) {
          await this.taskShadow.recordChangeset(execution, result.structuredContent);
        } else if (!result.isError) {
          await this.taskShadow.recordFileNavigationArtifact(execution, toolName, result.structuredContent);
          if (toolName === "get_diagnostics") {
            await this.taskShadow.recordDiagnosticsArtifact(execution, args, resultText);
          } else if (toolName === "list_directory") {
            await this.taskShadow.recordDirectoryArtifact(execution, args, resultText);
          } else if (toolName === "lsp") {
            await this.taskShadow.recordLspArtifact(execution, args, resultText);
          }
        }
        // At this layer we know a CallToolResult exists, but not whether the
        // remote client actually received it. Delivery intentionally remains
        // pending until a transport-observable acknowledgement exists.
        await this.taskShadow.markResultPrepared(execution);
        return {
          content: result.content,
          isError: result.isError,
          structuredContent: result.structuredContent as Record<string, unknown> | undefined,
        } as CallToolResult;
      } catch (error) {
        await this.taskShadow.finishExecution(execution, "failed", {
          durationMs: Date.now() - shadowStartedAt,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) this.destroySession(sid);
    };

    return { transport, server };
  }

  takeToolCallsSinceLastReport(): number {
    const count = this.toolCallsSinceLastReport;
    this.toolCallsSinceLastReport = 0;
    return count;
  }

  returnToolCallsSinceLastReport(count: number): void {
    if (Number.isFinite(count) && count > 0) {
      this.toolCallsSinceLastReport += count;
    }
  }

  private async handleToolCall(
    toolName: string,
    args: Record<string, unknown>,
    extra: { signal?: AbortSignal; taskId?: string },
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean; structuredContent?: Record<string, unknown> }> {
    if (toolName === SET_TODOS_TOOL.name) {
      const todos = normalizeBridgeTodos(args);
      const snapshot = await this.taskShadow.setTodosOwned(extra.taskId, todos);
      return this.acknowledgeTodos(snapshot.todos);
    }
    if (toolName === REPORT_PROGRESS_TOOL.name) {
      const current = await this.taskShadow.getTaskOwned(extra.taskId);
      const normalized = normalizeBridgeProgress(args, current.todos);
      const snapshot = await this.taskShadow.reportProgressOwned(extra.taskId, normalized.progress);
      return this.acknowledgeProgress(snapshot.progress!, snapshot.todos);
    }

    const activityId = this.pushActivity({
      tool: toolName,
      status: "running",
      presentation: bridgePresentation(toolName, args),
    });
    const startedAt = Date.now();
    try {
      if (isFileToolName(toolName)) {
        const result = await invokeFileTool(toolName, args, {
          workspaceRoots: this.workspaceRoots(),
          signal: extra.signal,
        });
        this.finishActivity(
          activityId,
          "completed",
          Date.now() - startedAt,
          undefined,
          bridgePresentation(toolName, args, result.text, result.structuredContent as Record<string, unknown>),
        );
        return {
          content: [{ type: "text" as const, text: result.text }],
          structuredContent: result.structuredContent as Record<string, unknown>,
        };
      }

      if (BRIDGE_EXCLUDED_TOOL_NAMES.has(toolName)) {
        throw new Error(`The ${toolName} tool is not available in Bridge mode.`);
      }

      const definition = getIdeToolDefinition(toolName);
      if (definition) {
        const cancellation = cancellationFromAbortSignal(extra.signal);
        try {
          const result = await this.ideToolBroker.invokeDirect(toolName, asRecord(args), cancellation.token);
          this.finishActivity(
            activityId,
            result.isError ? "error" : "completed",
            Date.now() - startedAt,
            result.isError ? result.text : undefined,
            bridgePresentation(toolName, args, result.text, undefined, result.isError),
          );
          return {
            isError: result.isError || undefined,
            content: [{ type: "text" as const, text: result.text }],
          };
        } finally {
          cancellation.dispose();
        }
      }

      throw new Error(`Unknown Bridge tool: ${toolName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.finishActivity(activityId, "error", Date.now() - startedAt, message, bridgePresentation(toolName, args, message, undefined, true));
      return {
        isError: true,
        content: [{ type: "text" as const, text: message }],
      };
    }
  }

  private isSessionActive(session: McpSession): boolean {
    return session.activeRequests > 0 || session.activeStreams > 0;
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (!this.isSessionActive(session) && now - session.lastActivity >= SESSION_IDLE_TIMEOUT_MS) {
        this.destroySession(sessionId);
      }
    }
    this.trimInactiveSessions(MAX_SESSIONS);
  }

  private makeRoomForSession(): void {
    this.trimInactiveSessions(MAX_SESSIONS - 1);
  }

  private trimInactiveSessions(maxSize: number): void {
    while (this.sessions.size > maxSize) {
      const oldestInactive = [...this.sessions.entries()]
        .filter(([, session]) => !this.isSessionActive(session))
        .sort((a, b) => a[1].lastActivity - b[1].lastActivity)[0];
      if (!oldestInactive) return;
      this.destroySession(oldestInactive[0]);
    }
  }

  private destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.revision += 1;
    try { void session.transport.close(); } catch { /* ignore */ }
    try { void session.server.close(); } catch { /* ignore */ }
    this.output.appendLine(`[bridge] session destroyed: ${sessionId}`);
  }

  private acknowledgeProgress(progress: TaskProgress, todos: readonly TaskTodo[]): { content: Array<{ type: "text"; text: string }> } {
    const linkedTodo = progress.todoId ? todos.find(todo => todo.id === progress.todoId) : undefined;
    this.output.appendLine(`[bridge-progress]${linkedTodo ? ` [${linkedTodo.id}]` : ""}${progress.phase ? ` ${progress.phase}:` : ""} ${progress.message}${progress.percent !== undefined ? ` (${progress.percent}%)` : ""}`);
    return { content: [{ type: "text", text: linkedTodo ? `Progress reported to Nimora Work Sessions for todo ${linkedTodo.id}.` : "Progress reported to Nimora Work Sessions." }] };
  }

  private acknowledgeTodos(todos: readonly TaskTodo[]): { content: Array<{ type: "text"; text: string }> } {
    const completed = todos.filter((todo) => todo.status === "completed").length;
    const current = todos.find((todo) => todo.status === "in_progress");
    this.output.appendLine(todos.length
      ? `[bridge-todos] ${completed}/${todos.length} completed${current ? ` · current: [${current.id}] ${current.title}` : ""}`
      : "[bridge-todos] cleared");
    return {
      content: [{
        type: "text",
        text: todos.length
          ? `Todo state updated in Nimora Work Sessions: ${completed}/${todos.length} completed${current ? `; current todo ${current.id}: ${current.title}` : ""}.`
          : "Todo state cleared in Nimora Work Sessions.",
      }],
    };
  }

  private workspaceRoots(): string[] {
    const roots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
    if (!roots.length) throw new Error("No workspace folder is open.");
    return roots;
  }

  private pushActivity(input: Omit<BridgeActivity, "id" | "at">): number {
    const at = new Date().toISOString();
    const item: BridgeActivity = {
      id: this.nextActivityId++,
      at,
      ...input,
    };
    this.activities.push(item);
    if (this.activities.length > MAX_ACTIVITY) this.activities.splice(0, this.activities.length - MAX_ACTIVITY);
    if (input.status !== "progress") {
      this.toolCalls += 1;
      this.lastTool = input.tool;
      this.lastToolAt = at;
    }
    this.revision += 1;
    return item.id;
  }

  private finishActivity(
    id: number,
    status: "completed" | "error",
    durationMs: number,
    message?: string,
    presentation?: BridgeActivityPresentation,
  ): void {
    const index = this.activities.findIndex((item) => item.id === id);
    if (index < 0) return;
    const current = this.activities[index];
    if (current.status === "running") {
      this.completedToolCalls += 1;
      this.totalToolDurationMs += durationMs;
      if (status === "error") this.failedToolCalls += 1;
    }
    this.activities[index] = { ...current, status, durationMs, message: message ?? current.message, presentation: presentation ?? current.presentation };
    this.revision += 1;
  }

  async stop(): Promise<BridgeStatus> {
    await this.stopResources(true);
    return this.getStatus();
  }

  private async stopResources(markStopped: boolean): Promise<void> {
    this.stoppingResources = true;
    this.tunnelGeneration += 1;
    if (this.sessionPruneTimer) {
      clearInterval(this.sessionPruneTimer);
      this.sessionPruneTimer = undefined;
    }

    // Tear down all active sessions
    for (const sid of [...this.sessions.keys()]) this.destroySession(sid);

    const tunnel = this.tunnelProcess;
    this.tunnelProcess = undefined;
    if (tunnel && !tunnel.killed) {
      if (process.platform === "win32" && tunnel.pid) {
        try {
          await execFileAsync("taskkill", ["/PID", String(tunnel.pid), "/T", "/F"], { windowsHide: true, timeout: 5_000 });
        } catch {
          tunnel.kill();
        }
      } else {
        tunnel.kill();
      }
    }

    this.activeRequests = 0;

    const server = this.httpServer;
    this.httpServer = undefined;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.localPort = undefined;
    if (this.tunnelProvider === "cloudflare") this.domain = "";
    if (markStopped) {
      this.state = "stopped";
      this.lastError = undefined;
      this.output.appendLine("[bridge] stopped");
    }
    this.stoppingResources = false;
  }

  async disposeAsync(): Promise<void> {
    await this.stopResources(true);
  }

  dispose(): void {
    void this.stopResources(true);
  }
}

