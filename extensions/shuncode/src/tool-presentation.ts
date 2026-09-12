import * as vscode from "vscode";
import { boundedTechnicalText } from "./chat-history.mjs";

export interface StoredToolInvocation {
  toolName: string;
  args: Record<string, unknown>;
}

export interface ToolPresentationResult {
  title: string;
  data: vscode.ChatSimpleToolResultData;
}

interface ParsedPresentation {
  title: string;
  summary?: string;
  items?: NonNullable<vscode.ChatSimpleToolResultData["items"]>;
  metrics?: NonNullable<vscode.ChatSimpleToolResultData["metrics"]>;
  output?: string;
  terminalId?: string;
  diff?: string;
  diffPreview?: NonNullable<vscode.ChatSimpleToolResultData["diffPreview"]>;
}

const MAX_PREVIEW_ITEMS = 12;

function presentationKind(toolName: string): NonNullable<vscode.ChatSimpleToolResultData["presentationKind"]> {
  switch (toolName) {
    case "find_files":
    case "read_files":
    case "list_directory":
      return "files";
    case "search_files":
      return "search";
    case "apply_patch":
      return "edit";
    case "run_command":
    case "get_command_output":
    case "send_command_input":
      return "terminal";
    case "get_diagnostics":
      return "diagnostics";
    case "lsp":
      return "lsp";
    default:
      return "generic";
  }
}

function field(text: string, name: string): string | undefined {
  const match = text.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

function integerField(text: string, name: string): number | undefined {
  const value = field(text, name);
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseJsonString(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value.replace(/^"|"$/g, "");
  }
}

function blockBetween(text: string, begin: string, end: string): string | undefined {
  const start = text.indexOf(begin);
  if (start < 0) return undefined;
  const contentStart = start + begin.length;
  const finish = text.indexOf(end, contentStart);
  const value = text.slice(contentStart, finish >= 0 ? finish : undefined).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return value || undefined;
}

function relativeResource(root: vscode.Uri | undefined, relativePath: string, line?: number, column?: number): vscode.Uri | vscode.Location | undefined {
  if (!root || !relativePath || relativePath.startsWith("(") || relativePath.startsWith("…")) return undefined;
  const clean = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const uri = vscode.Uri.joinPath(root, ...clean.split("/").filter(Boolean));
  if (!line) return uri;
  const start = new vscode.Position(Math.max(0, line - 1), Math.max(0, (column ?? 1) - 1));
  return new vscode.Location(uri, new vscode.Range(start, start));
}

function durationMetric(durationMs: number | undefined): Array<{ label: string; value: string }> {
  if (durationMs === undefined) return [];
  return [{ label: "Duration", value: durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(1)} s` }];
}

function formatDurationMs(ms: number): string {
  return ms >= 1_000 && ms % 1_000 === 0 ? `${ms / 1_000} s` : `${ms} ms`;
}

function withOverflowItem<T extends { label: string }>(items: T[], total: number): T[] {
  if (items.length <= MAX_PREVIEW_ITEMS) return items;
  const visible = items.slice(0, MAX_PREVIEW_ITEMS);
  visible.push({ label: `… ${Math.max(0, total - MAX_PREVIEW_ITEMS)} more` } as T);
  return visible;
}

function findFilesPresentation(text: string, root: vscode.Uri | undefined, durationMs: number | undefined) {
  const total = integerField(text, "returned_files") ?? 0;
  const marker = "--- FILES ---";
  const section = text.includes(marker) ? text.split(marker, 2)[1] ?? "" : "";
  const paths = section
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("===") && !line.startsWith("NOTE:") && line !== "(no matching files)");
  const pattern = field(text, "patterns");
  const scope = parseJsonString(field(text, "scope")) ?? ".";
  return {
    title: total === 1 ? "Found 1 file" : `Found ${total} files`,
    summary: pattern ? `Searched ${scope} for ${pattern}.` : `Searched ${scope}.`,
    items: withOverflowItem(paths.map((path) => ({ label: path, resource: relativeResource(root, path) })), total),
    metrics: [{ label: "Files", value: String(total) }, ...durationMetric(durationMs)],
  };
}

function searchFilesPresentation(text: string, root: vscode.Uri | undefined, durationMs: number | undefined) {
  const total = integerField(text, "returned_matches") ?? 0;
  const files = integerField(text, "files_with_matches") ?? 0;
  const pattern = parseJsonString(field(text, "pattern")) ?? "";
  const scope = parseJsonString(field(text, "scope")) ?? ".";
  const items: Array<{ label: string; description?: string; resource?: vscode.Uri | vscode.Location }> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/^(.+?):(\d+):(\d+)$/gm)) {
    const path = match[1]?.trim();
    const line = Number(match[2]);
    const column = Number(match[3]);
    const key = `${path}:${line}:${column}`;
    if (!path || seen.has(key)) continue;
    seen.add(key);
    items.push({ label: path, description: `Line ${line}`, resource: relativeResource(root, path, line, column) });
  }
  return {
    title: total === 1 ? "Found 1 match" : `Found ${total} matches`,
    summary: pattern ? `Searched ${scope} for “${pattern}”.` : `Searched ${scope}.`,
    items: withOverflowItem(items, total),
    metrics: [{ label: "Matches", value: String(total) }, { label: "Files", value: String(files) }, ...durationMetric(durationMs)],
  };
}

function readFilesPresentation(text: string, root: vscode.Uri | undefined, durationMs: number | undefined) {
  const requested = integerField(text, "requested") ?? 0;
  const succeeded = integerField(text, "succeeded") ?? requested;
  const failed = integerField(text, "failed") ?? 0;
  const truncated = integerField(text, "truncated") ?? 0;
  const items: Array<{ label: string; description?: string; resource?: vscode.Uri | vscode.Location }> = [];
  for (const block of text.split("=== FILE BEGIN ===").slice(1)) {
    const path = parseJsonString(field(block, "path"));
    if (!path) continue;
    const status = field(block, "status") ?? "unknown";
    const lines = field(block, "lines");
    const startLine = lines ? Number.parseInt(lines.split("-", 1)[0] ?? "1", 10) : undefined;
    items.push({
      label: path,
      description: status === "success" ? (lines ? `Lines ${lines}` : "Read") : status,
      resource: relativeResource(root, path, Number.isFinite(startLine) ? startLine : undefined),
    });
  }
  return {
    title: succeeded === 1 ? "Read 1 file" : `Read ${succeeded} files`,
    summary: failed > 0 ? `${succeeded} succeeded and ${failed} failed.` : `${succeeded} file${succeeded === 1 ? "" : "s"} read successfully.`,
    items: withOverflowItem(items, items.length),
    metrics: [
      { label: "Requested", value: String(requested) },
      ...(truncated ? [{ label: "Truncated", value: String(truncated) }] : []),
      ...durationMetric(durationMs),
    ],
  };
}

function applyPatchPresentation(text: string, root: vscode.Uri | undefined, durationMs: number | undefined) {
  const filesChanged = integerField(text, "files_changed") ?? 0;
  const additions = integerField(text, "additions") ?? 0;
  const deletions = integerField(text, "deletions") ?? 0;
  const items: Array<{ label: string; description?: string; resource?: vscode.Uri; added?: number; removed?: number }> = [];
  for (const block of text.split("--- FILE ---").slice(1)) {
    const path = parseJsonString(field(block, "destination_path")) ?? parseJsonString(field(block, "path"));
    if (!path) continue;
    items.push({
      label: path,
      description: field(block, "action") ?? "updated",
      resource: relativeResource(root, path) as vscode.Uri | undefined,
      added: integerField(block, "additions"),
      removed: integerField(block, "deletions"),
    });
  }
  const diff = blockBetween(text, "--- CANONICAL APPLIED DIFF ---", "=== APPLY_PATCH END ===")?.replace(/\r?\nNOTE: Diff display was truncated;[\s\S]*$/, "");
  return {
    title: filesChanged === 1 ? "Updated 1 file" : `Updated ${filesChanged} files`,
    summary: `${additions} line${additions === 1 ? "" : "s"} added and ${deletions} removed.`,
    items: withOverflowItem(items, filesChanged),
    metrics: [
      { label: "Files", value: String(filesChanged) },
      { label: "Added", value: `+${additions}` },
      { label: "Removed", value: `−${deletions}` },
      ...durationMetric(durationMs),
    ],
    diff,
    diffPreview: parseUnifiedDiffPreview(diff),
  };
}

const MAX_DIFF_PREVIEW_FILES = 8;
const MAX_DIFF_PREVIEW_HUNKS_PER_FILE = 4;
const MAX_DIFF_PREVIEW_LINES_PER_HUNK = 18;

function diffPath(header: string): string | undefined {
  const value = header.trim();
  if (!value || value === "/dev/null") return undefined;
  return value.replace(/^[ab]\//, "");
}

function parseUnifiedDiffPreview(diff: string | undefined): NonNullable<vscode.ChatSimpleToolResultData["diffPreview"]> {
  if (!diff) return [];
  const lines = diff.split(/\r?\n/);
  const files: NonNullable<vscode.ChatSimpleToolResultData["diffPreview"]> = [];
  let currentFile: NonNullable<vscode.ChatSimpleToolResultData["diffPreview"]>[number] | undefined;
  let currentHunk: NonNullable<vscode.ChatSimpleToolResultData["diffPreview"]>[number]["hunks"][number] | undefined;
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
    if (files.length < MAX_DIFF_PREVIEW_FILES) files.push(currentFile);
    else if (files.length) files[files.length - 1]!.truncated = true;
    currentFile = undefined;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.startsWith("--- ")) {
      finishFile();
      const oldPath = diffPath(line.slice(4));
      const next = lines[index + 1];
      const newPath = next?.startsWith("+++ ") ? diffPath(next.slice(4)) : undefined;
      const path = newPath ?? oldPath;
      if (path) currentFile = { path, hunks: [] };
      if (next?.startsWith("+++ ")) index += 1;
      continue;
    }
    if (!currentFile) continue;
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      finishHunk();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      currentHunk = { lines: [] };
      continue;
    }
    if (!currentHunk || line === "\\ No newline at end of file" || line === "... <diff truncated>") continue;
    const marker = line[0];
    if (marker !== " " && marker !== "+" && marker !== "-") continue;
    const previewLine = marker === "+"
      ? { kind: "add" as const, newLine, text: line.slice(1) }
      : marker === "-"
        ? { kind: "delete" as const, oldLine, text: line.slice(1) }
        : { kind: "context" as const, oldLine, newLine, text: line.slice(1) };
    if (currentHunk.lines.length < MAX_DIFF_PREVIEW_LINES_PER_HUNK) currentHunk.lines.push(previewLine);
    else currentHunk.truncated = true;
    if (marker !== "+") oldLine += 1;
    if (marker !== "-") newLine += 1;
  }
  finishFile();
  return files;
}

function listDirectoryPresentation(text: string, root: vscode.Uri | undefined, durationMs: number | undefined, args: Record<string, unknown>): ParsedPresentation {
  const items = [...text.matchAll(/^\[(DIR|FILE|LINK|OTHER)\]\s+(.+)$/gm)].map((match) => {
    const path = match[2]?.trim() ?? "";
    return { label: path, description: match[1] === "DIR" ? "Folder" : undefined, resource: relativeResource(root, path) };
  }).filter((item) => item.label);
  const target = typeof args.path === "string" && args.path.trim() ? args.path.trim() : "workspace";
  return {
    title: `Explored ${target}`,
    summary: `${items.length} item${items.length === 1 ? "" : "s"}.`,
    items: withOverflowItem(items, items.length),
    metrics: [{ label: "Items", value: String(items.length) }, ...durationMetric(durationMs)],
  };
}

function diagnosticsPresentation(text: string, root: vscode.Uri | undefined, durationMs: number | undefined): ParsedPresentation {
  const total = integerField(text, "returned") ?? integerField(text, "total_matching") ?? 0;
  const items: NonNullable<vscode.ChatSimpleToolResultData["items"]> = [];
  for (const block of text.split(/--- DIAGNOSTIC \d+ ---/).slice(1)) {
    const lines = block.trim().split(/\r?\n/);
    const location = lines[0]?.match(/^(.+):(\d+):(\d+)$/);
    if (!location) continue;
    const severity = field(block, "severity");
    const messageStart = lines.findIndex((line) => line.startsWith("code:"));
    const message = messageStart >= 0 ? lines.slice(messageStart + 1).join(" ").trim() : undefined;
    items.push({
      label: message || location[1]!,
      description: [severity, `${location[1]}:${location[2]}:${location[3]}`].filter(Boolean).join(" · "),
      resource: relativeResource(root, location[1]!, Number(location[2]), Number(location[3])),
    });
  }
  return {
    title: total === 0 ? "No diagnostics" : total === 1 ? "Found 1 diagnostic" : `Found ${total} diagnostics`,
    summary: total === 0 ? "No matching editor or language-service diagnostics." : undefined,
    items: withOverflowItem(items, total),
    metrics: [{ label: "Diagnostics", value: String(total) }, ...durationMetric(durationMs)],
  };
}

function lspPresentation(text: string, root: vscode.Uri | undefined, durationMs: number | undefined, args: Record<string, unknown>): ParsedPresentation {
  const total = integerField(text, "returned_results") ?? integerField(text, "returned") ?? 0;
  const items: NonNullable<vscode.ChatSimpleToolResultData["items"]> = [];
  for (const block of text.split(/--- RESULT \d+ ---/).slice(1)) {
    const path = parseJsonString(field(block, "path"));
    if (!path || /^[a-z]+:\/\//i.test(path)) continue;
    const range = field(block, "selection_range") ?? field(block, "range");
    const position = range?.match(/^(\d+):(\d+)/);
    const line = position ? Number(position[1]) : undefined;
    const column = position ? Number(position[2]) : undefined;
    items.push({
      label: parseJsonString(field(block, "name")) ?? path,
      description: [field(block, "kind"), field(block, "container"), line ? `${path}:${line}:${column ?? 1}` : path].filter(Boolean).join(" · "),
      resource: relativeResource(root, path, line, column),
    });
  }
  const operation = typeof args.operation === "string" ? args.operation : "LSP query";
  return {
    title: `${operation.replaceAll("_", " ")} · ${total} result${total === 1 ? "" : "s"}`,
    summary: field(text, "provider_state") ? `Provider: ${field(text, "provider_state")}` : undefined,
    items: withOverflowItem(items, total),
    metrics: [{ label: "Results", value: String(total) }, ...durationMetric(durationMs)],
  };
}

function terminalPresentation(text: string, durationMs: number | undefined, args: Record<string, unknown>, toolName: string): ParsedPresentation {
  const command = typeof args.command === "string" ? args.command.trim() : typeof args.input === "string" ? args.input.trim() : "";
  const terminalId = field(text, "terminal_id");
  const terminalName = field(text, "terminal_name");
  const status = field(text, "status");
  const exitCode = field(text, "exit_code");
  const output = blockBetween(text, "--- OUTPUT BEGIN ---", "--- OUTPUT END ---");
  const title = toolName === "run_command" ? `Ran ${command || "terminal command"}` : toolName === "get_command_output" ? "Read command output" : "Sent command input";
  return {
    title,
    summary: [terminalName, status && status !== "completed" ? status : undefined, exitCode && exitCode !== "null" ? `exit ${exitCode}` : undefined].filter(Boolean).join(" · ") || undefined,
    output,
    terminalId,
    metrics: [...(exitCode && exitCode !== "null" ? [{ label: "Exit", value: exitCode }] : []), ...durationMetric(durationMs)],
  };
}

function waitPresentation(text: string, durationMs: number | undefined): ParsedPresentation {
  const match = text.match(/Waited (\d+) ms\./);
  const requestedMs = match ? Number(match[1]) : undefined;
  return {
    title: requestedMs !== undefined && Number.isFinite(requestedMs) ? `Waited ${formatDurationMs(requestedMs)}` : "Waited",
    summary: "Wait completed.",
    metrics: durationMetric(durationMs),
  };
}

function runningPresentation(toolName: string, args: Record<string, unknown>, root: vscode.Uri | undefined): ParsedPresentation {
  switch (toolName) {
    case "find_files": {
      const patterns = Array.isArray(args.patterns) ? args.patterns.filter((value): value is string => typeof value === "string") : [];
      return { title: "Finding files", summary: patterns.length ? `Searching for ${patterns.join(", ")}.` : "Searching workspace paths.", items: [] };
    }
    case "search_files":
      return { title: "Searching files", summary: typeof args.pattern === "string" ? `Searching for “${args.pattern}”.` : "Searching file contents.", items: [] };
    case "read_files": {
      const files = Array.isArray(args.files) ? args.files.filter((file): file is Record<string, unknown> => !!file && typeof file === "object") : [];
      return {
        title: files.length === 1 ? "Reading 1 file" : `Reading ${files.length} files`,
        summary: "Reading requested source ranges.",
        items: withOverflowItem(files.map((file) => {
          const path = typeof file.path === "string" ? file.path : "file";
          const start = typeof file.start_line === "number" ? file.start_line : undefined;
          const end = typeof file.end_line === "number" ? file.end_line : undefined;
          return { label: path, description: start ? `Lines ${start}${end ? `–${end}` : "–EOF"}` : undefined, resource: relativeResource(root, path, start) };
        }), files.length),
      };
    }
    case "apply_patch": {
      const patch = typeof args.patch === "string" ? args.patch : "";
      const paths = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((match) => match[1]?.trim()).filter((value): value is string => !!value);
      return { title: paths.length === 1 ? "Updating 1 file" : `Updating ${paths.length || "workspace"} files`, summary: "Applying source changes.", items: withOverflowItem(paths.map((path) => ({ label: path, resource: relativeResource(root, path) })), paths.length) };
    }
    case "list_directory":
      return { title: `Exploring ${typeof args.path === "string" && args.path.trim() ? args.path.trim() : "workspace"}`, summary: "Reading directory contents.", items: [] };
    case "get_diagnostics":
      return { title: "Checking diagnostics", summary: "Reading current editor and language-service diagnostics.", items: [] };
    case "lsp":
      return { title: typeof args.operation === "string" ? args.operation.replaceAll("_", " ") : "Running code intelligence", summary: "Querying active language services.", items: [] };
    case "run_command":
      return { title: `Running ${typeof args.command === "string" ? args.command.trim() : "terminal command"}`, summary: typeof args.cwd === "string" ? args.cwd : undefined, items: [] };
    case "get_command_output":
      return { title: "Reading command output", summary: typeof args.command_id === "string" ? args.command_id : undefined, items: [] };
    case "send_command_input":
      return { title: "Sending command input", summary: typeof args.command_id === "string" ? args.command_id : undefined, items: [] };
    case "wait": {
      const ms = typeof args.ms === "number" && Number.isFinite(args.ms) ? args.ms : undefined;
      return { title: "Waiting", summary: ms !== undefined ? `Waiting ${formatDurationMs(ms)}.` : "Waiting for the requested duration.", items: [] };
    }
    default:
      return { title: `${toolName} running`, summary: undefined, items: [] };
  }
}

export function createToolPresentation(
  invocation: StoredToolInvocation,
  output: unknown,
  options: { isComplete: boolean; isError?: boolean; durationMs?: number; workspaceRoot?: vscode.Uri; useShunCodeStyle?: boolean },
): ToolPresentationResult {
  const rawOutput = options.isComplete ? boundedTechnicalText(output ?? "") : "";
  const technicalInput = boundedTechnicalText(invocation.args);
  const parsed: ParsedPresentation | undefined = options.isComplete && typeof output === "string"
    ? invocation.toolName === "find_files" ? findFilesPresentation(output, options.workspaceRoot, options.durationMs)
      : invocation.toolName === "search_files" ? searchFilesPresentation(output, options.workspaceRoot, options.durationMs)
        : invocation.toolName === "read_files" ? readFilesPresentation(output, options.workspaceRoot, options.durationMs)
          : invocation.toolName === "apply_patch" && !options.isError ? applyPatchPresentation(output, options.workspaceRoot, options.durationMs)
            : invocation.toolName === "list_directory" ? listDirectoryPresentation(output, options.workspaceRoot, options.durationMs, invocation.args)
              : invocation.toolName === "get_diagnostics" ? diagnosticsPresentation(output, options.workspaceRoot, options.durationMs)
                : invocation.toolName === "lsp" ? lspPresentation(output, options.workspaceRoot, options.durationMs, invocation.args)
                  : ["run_command", "get_command_output", "send_command_input"].includes(invocation.toolName) ? terminalPresentation(output, options.durationMs, invocation.args, invocation.toolName)
                    : invocation.toolName === "wait" ? waitPresentation(output, options.durationMs)
                      : undefined
    : undefined;
  const presentation = parsed ?? runningPresentation(invocation.toolName, invocation.args, options.workspaceRoot);
  const failedTitle = options.isError ? `${invocation.toolName} failed` : presentation.title;
  const kind = presentationKind(invocation.toolName);
  return {
    title: failedTitle,
    data: {
      input: options.isError || kind === "generic" ? technicalInput : "",
      output: options.isError ? rawOutput : presentation.output ?? (kind === "generic" ? rawOutput : ""),
      presentationStyle: options.useShunCodeStyle ? "shuncode" : undefined,
      presentationKind: kind,
      isError: Boolean(options.isError),
      durationMs: options.durationMs,
      terminalId: presentation.terminalId,
      diff: presentation.diff,
      diffPreview: presentation.diffPreview,
      summary: options.isError ? "The tool did not complete successfully. Open technical details for the reported error." : presentation.summary,
      detailsLabel: "Technical details",
      items: presentation.items,
      metrics: options.isComplete ? presentation.metrics : undefined,
    },
  };
}

