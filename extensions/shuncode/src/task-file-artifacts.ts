import type { TaskArtifactRef } from "../../../src/task-contract.js";

export type TaskFileNavigationToolName = "read_files" | "find_files" | "search_files";

export type TaskFileNavigationArtifactInput = Omit<TaskArtifactRef, "artifactId" | "createdAt" | "executionId">;

const MAX_SEARCH_LOCATIONS = 40;
const MAX_SEARCH_LABEL_CHARS = 240;
const MAX_LSP_HOVER_ARTIFACT_CONTENT_CHARS = 24_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function uniquePaths(values: unknown[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const row = asRecord(value);
    const path = typeof row?.path === "string" ? row.path.trim() : "";
    if (!path || seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

function oneLine(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, Math.max(0, maxChars - 1))}…`;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function resultField(text: string, field: string): string | undefined {
  const match = text.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

function resultInteger(text: string, field: string): number | undefined {
  const raw = resultField(text, field);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function resultBoolean(text: string, field: string): boolean {
  return resultField(text, field) === "true";
}

function resultJsonString(text: string, field: string): string | undefined {
  const raw = resultField(text, field);
  if (raw === undefined || raw === "null") return undefined;
  try {
    const value = JSON.parse(raw);
    return typeof value === "string" ? value : undefined;
  } catch {
    return raw;
  }
}

function resultBlock(text: string, begin: string, end: string): string | undefined {
  const start = text.indexOf(begin);
  if (start < 0) return undefined;
  const contentStart = start + begin.length;
  const finish = text.indexOf(end, contentStart);
  const value = text.slice(contentStart, finish >= 0 ? finish : undefined).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return value || undefined;
}

function boundedContent(value: string, maxChars: number): { content: string; truncated: boolean } {
  if (value.length <= maxChars) return { content: value, truncated: false };
  return { content: `${value.slice(0, maxChars)}\n…[truncated]`, truncated: true };
}

export function taskDiagnosticsArtifact(args: unknown, resultText: string): TaskFileNavigationArtifactInput | undefined {
  if (!resultText.includes("=== GET_DIAGNOSTICS BEGIN ===")) return undefined;
  const input = asRecord(args);
  const scope = typeof input?.path === "string" && input.path.trim() ? input.path.trim() : "workspace";
  const blocks = resultText.split(/--- DIAGNOSTIC \d+ ---/).slice(1);
  const entries = blocks.flatMap(block => {
    const lines = block.trim().split(/\r?\n/);
    const location = lines[0]?.match(/^(.+):(\d+):(\d+)$/);
    if (!location) return [];
    const line = positiveInteger(Number(location[2]));
    const column = positiveInteger(Number(location[3]));
    if (line === undefined) return [];
    const severity = resultField(block, "severity");
    const messageStart = lines.findIndex(item => item.startsWith("code:"));
    const message = messageStart >= 0 ? oneLine(lines.slice(messageStart + 1).join(" "), MAX_SEARCH_LABEL_CHARS) : undefined;
    const label = [severity ? `[${severity}]` : undefined, message].filter((value): value is string => Boolean(value)).join(" ") || undefined;
    return [{ path: location[1], line, column, label }];
  });
  const files = [...new Set(entries.map(entry => entry.path))];
  const total = resultInteger(resultText, "total_matching") ?? resultInteger(resultText, "returned") ?? entries.length;
  const locations = entries.slice(0, MAX_SEARCH_LOCATIONS);
  return {
    kind: files.length ? "file" : "report",
    title: total === 0 ? `No diagnostics · ${scope}` : `Diagnostics · ${scope} · ${total} issue${total === 1 ? "" : "s"}`,
    metadata: {
      files,
      locations,
      locationCount: total,
      locationsTruncated: entries.length > locations.length,
      sourceTool: "get_diagnostics",
      resultTruncated: resultBoolean(resultText, "truncated"),
    },
  };
}

export function taskDirectoryArtifact(args: unknown, resultText: string): TaskFileNavigationArtifactInput | undefined {
  if (!resultText.includes("=== LIST_DIRECTORY BEGIN ===")) return undefined;
  const input = asRecord(args);
  const target = resultJsonString(resultText, "path") ?? (typeof input?.path === "string" && input.path.trim() ? input.path.trim() : ".");
  const entries = [...resultText.matchAll(/^\[(DIR|FILE|LINK|OTHER)\]\s+(.+)$/gm)].flatMap(match => {
    const path = match[2]?.trim();
    if (!path) return [];
    const kind = match[1] === "DIR" ? "folder" : match[1] === "FILE" ? "file" : match[1] === "LINK" ? "link" : "other";
    return [{ path, kind }];
  });
  const total = resultInteger(resultText, "returned_entries") ?? entries.length;
  return {
    kind: "report",
    title: target === "." ? "Explored workspace" : `Explored ${target}`,
    metadata: {
      entries,
      entryCount: total,
      sourceTool: "list_directory",
      resultTruncated: resultBoolean(resultText, "truncated"),
    },
  };
}

export function taskLspLocationArtifact(args: unknown, resultText: string): TaskFileNavigationArtifactInput | undefined {
  if (!resultText.includes("=== LSP BEGIN ===")) return undefined;
  const input = asRecord(args);
  const operation = typeof input?.operation === "string" ? input.operation : resultField(resultText, "operation");
  if (!operation || operation === "hover") return undefined;
  const supported = new Set(["workspace_symbols", "document_symbols", "definition", "references", "implementation"]);
  if (!supported.has(operation)) return undefined;

  const blocks = resultText.split(/--- RESULT \d+ ---/).slice(1);
  const entries = blocks.flatMap(block => {
    const path = resultJsonString(block, "path");
    if (!path || /^[a-z]+:\/\//i.test(path)) return [];
    const range = resultField(block, "selection_range") ?? resultField(block, "range");
    const position = range?.match(/^(\d+):(\d+)/);
    if (!position) return [];
    const line = positiveInteger(Number(position[1]));
    const column = positiveInteger(Number(position[2]));
    if (line === undefined) return [];
    const name = resultJsonString(block, "name");
    const kind = resultField(block, "kind");
    const container = resultJsonString(block, "container");
    const label = oneLine([name, kind, container].filter(Boolean).join(" · "), MAX_SEARCH_LABEL_CHARS);
    return [{ path, line, column, label }];
  });
  const files = [...new Set(entries.map(entry => entry.path))];
  const total = resultInteger(resultText, "total_results") ?? resultInteger(resultText, "returned_results") ?? entries.length;
  const locations = entries.slice(0, MAX_SEARCH_LOCATIONS);
  const operationLabel = operation.replace(/_/g, " ");
  return {
    kind: files.length ? "file" : "report",
    title: total === 0 ? `LSP · ${operationLabel} · no results` : `LSP · ${operationLabel} · ${total} result${total === 1 ? "" : "s"}`,
    metadata: {
      files,
      locations,
      locationCount: total,
      locationsTruncated: entries.length > locations.length,
      sourceTool: "lsp",
      operation,
      resultTruncated: resultBoolean(resultText, "truncated"),
      providerState: resultField(resultText, "provider_state"),
      semanticResultInconclusive: resultBoolean(resultText, "semantic_result_inconclusive"),
    },
  };
}

export function taskLspHoverArtifact(args: unknown, resultText: string): TaskFileNavigationArtifactInput | undefined {
  if (!resultText.includes("=== LSP BEGIN ===")) return undefined;
  const input = asRecord(args);
  const operation = typeof input?.operation === "string" ? input.operation : resultField(resultText, "operation");
  if (operation !== "hover") return undefined;

  const source = resultJsonString(resultText, "source");
  const position = resultField(resultText, "position")?.match(/^(\d+):(\d+)$/);
  const line = position ? positiveInteger(Number(position[1])) : undefined;
  const column = position ? positiveInteger(Number(position[2])) : undefined;
  const workspaceSource = source && !/^[a-z]+:\/\//i.test(source) ? source : undefined;
  const locations = workspaceSource && line !== undefined ? [{ path: workspaceSource, line, column, label: "Hover source" }] : [];
  const files = workspaceSource ? [workspaceSource] : [];
  const blocks = resultText.split(/--- RESULT \d+ ---/).slice(1);
  const rawContent = blocks
    .map(block => resultBlock(block, "--- CONTENT BEGIN ---", "--- CONTENT END ---"))
    .filter((value): value is string => Boolean(value))
    .join("\n\n");
  const bounded = boundedContent(rawContent, MAX_LSP_HOVER_ARTIFACT_CONTENT_CHARS);
  const total = resultInteger(resultText, "total_results") ?? resultInteger(resultText, "returned_results") ?? blocks.length;
  const sourceLabel = workspaceSource && line !== undefined ? `${workspaceSource}:${line}:${column ?? 1}` : undefined;
  return {
    kind: "report",
    title: sourceLabel ? `LSP · hover · ${sourceLabel}` : `LSP · hover · ${total} result${total === 1 ? "" : "s"}`,
    metadata: {
      files,
      locations,
      locationCount: locations.length,
      sourceTool: "lsp",
      operation,
      resultCount: total,
      resultTruncated: resultBoolean(resultText, "truncated"),
      content: bounded.content,
      contentTruncated: bounded.truncated || resultBoolean(resultText, "content_truncated"),
      providerState: resultField(resultText, "provider_state"),
      semanticResultInconclusive: resultBoolean(resultText, "semantic_result_inconclusive"),
    },
  };
}

export function taskLspArtifact(args: unknown, resultText: string): TaskFileNavigationArtifactInput | undefined {
  return taskLspLocationArtifact(args, resultText) ?? taskLspHoverArtifact(args, resultText);
}

export function taskFileNavigationArtifact(
  toolName: string,
  structuredContent: unknown,
): TaskFileNavigationArtifactInput | undefined {
  if (toolName !== "read_files" && toolName !== "find_files" && toolName !== "search_files") return undefined;
  const row = asRecord(structuredContent);
  if (!row) return undefined;

  if (toolName === "search_files") {
    if (!Array.isArray(row.matches)) return undefined;
    const files = uniquePaths(row.matches);
    if (!files.length) return undefined;
    const eligibleLocations = row.matches.flatMap(item => {
      const match = asRecord(item);
      const path = typeof match?.path === "string" ? match.path.trim() : "";
      const line = positiveInteger(match?.line);
      if (!path || line === undefined) return [];
      return [{
        path,
        line,
        column: positiveInteger(match?.column),
        label: oneLine(match?.text, MAX_SEARCH_LABEL_CHARS),
      }];
    });
    const locations = eligibleLocations.slice(0, MAX_SEARCH_LOCATIONS);
    const summary = asRecord(row.summary);
    const matchCount = typeof summary?.returned_matches === "number" && Number.isFinite(summary.returned_matches)
      ? Math.max(0, Math.trunc(summary.returned_matches))
      : row.matches.length;
    const pattern = oneLine(row.pattern, 120);
    return {
      kind: "file",
      title: pattern ? `Searched “${pattern}”` : `Search results in ${files.length} workspace file${files.length === 1 ? "" : "s"}`,
      metadata: {
        files,
        locations,
        locationCount: matchCount,
        locationsTruncated: eligibleLocations.length > locations.length,
        sourceTool: toolName,
        resultTruncated: summary?.truncated === true,
      },
    };
  }

  if (!Array.isArray(row.files)) return undefined;

  const files = toolName === "read_files"
    ? uniquePaths(row.files.filter(item => asRecord(item)?.status === "success"))
    : uniquePaths(row.files);
  if (!files.length) return undefined;

  const summary = asRecord(row.summary);
  const resultTruncated = toolName === "read_files"
    ? typeof summary?.truncated === "number" && summary.truncated > 0
    : summary?.truncated === true;
  const title = toolName === "read_files"
    ? files.length === 1 ? `Read ${files[0]}` : `Read ${files.length} workspace files`
    : `Found ${files.length} workspace file${files.length === 1 ? "" : "s"}`;

  return {
    kind: "file",
    title,
    metadata: {
      files,
      sourceTool: toolName,
      resultTruncated,
    },
  };
}
