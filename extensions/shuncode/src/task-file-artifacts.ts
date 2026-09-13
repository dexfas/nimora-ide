import type { TaskArtifactRef } from "../../../src/task-contract.js";

export type TaskFileNavigationToolName = "read_files" | "find_files";

export type TaskFileNavigationArtifactInput = Omit<TaskArtifactRef, "artifactId" | "createdAt" | "executionId">;

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

export function taskFileNavigationArtifact(
  toolName: string,
  structuredContent: unknown,
): TaskFileNavigationArtifactInput | undefined {
  if (toolName !== "read_files" && toolName !== "find_files") return undefined;
  const row = asRecord(structuredContent);
  if (!row || !Array.isArray(row.files)) return undefined;

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
