import type { TaskArtifactRef } from "../../../src/task-contract.js";

const MAX_CHANGESET_CONTENT_CHARS = 24_000;

/** Projection of an actual apply_patch executor result, never provider prose. */
export function taskChangesetArtifact(data: unknown): Omit<TaskArtifactRef, "artifactId" | "createdAt" | "executionId"> | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  const row = data as Record<string, unknown>;
  const files = Array.isArray(row.files) ? row.files.flatMap(file => {
    if (!file || typeof file !== "object" || Array.isArray(file)) return [];
    const item = file as Record<string, unknown>;
    const candidate = typeof item.destination_path === "string" ? item.destination_path : typeof item.path === "string" ? item.path : undefined;
    return candidate ? [candidate] : [];
  }) : [];
  const summary = row.summary && typeof row.summary === "object" && !Array.isArray(row.summary) ? row.summary as Record<string, unknown> : {};
  const rawDiff = typeof row.diff === "string" ? row.diff.trim() : "";
  const content = rawDiff.slice(0, MAX_CHANGESET_CONTENT_CHARS);
  return {
    kind: "changeset",
    title: files.length === 1 ? `Changed ${files[0]}` : `Changed ${files.length} workspace files`,
    metadata: {
      files,
      filesChanged: typeof summary.files_changed === "number" ? summary.files_changed : files.length,
      additions: typeof summary.additions === "number" ? summary.additions : undefined,
      deletions: typeof summary.deletions === "number" ? summary.deletions : undefined,
      diffTruncated: row.diff_truncated === true,
      content: content || undefined,
      contentLanguage: content ? "diff" : undefined,
      contentTruncated: row.diff_truncated === true || rawDiff.length > MAX_CHANGESET_CONTENT_CHARS,
    },
  };
}
