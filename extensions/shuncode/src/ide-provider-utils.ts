import path from "node:path";
import * as vscode from "vscode";

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
}

export function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized || ".";
}

export function isInside(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(candidate);
  const rootCmp = process.platform === "win32" ? rootResolved.toLowerCase() : rootResolved;
  const candidateCmp = process.platform === "win32" ? candidateResolved.toLowerCase() : candidateResolved;
  return candidateCmp === rootCmp || candidateCmp.startsWith(`${rootCmp}${path.sep}`);
}

export function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder is open.");
  return folder.uri.fsPath;
}

export function resolveWorkspacePath(relative = "."): { root: string; absolute: string; relative: string; uri: vscode.Uri } {
  const root = workspaceRoot();
  const rel = normalizeRelativePath(relative);
  if (path.isAbsolute(rel)) throw new Error("Path must be workspace-relative.");
  const absolute = path.resolve(root, rel);
  if (!isInside(root, absolute)) throw new Error(`Path is outside the workspace: ${relative}`);
  const normalizedRelative = path.relative(root, absolute).replace(/\\/g, "/") || ".";
  return { root, absolute, relative: normalizedRelative, uri: vscode.Uri.file(absolute) };
}

export function toolResult(text: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
}

export function resultText(result: vscode.LanguageModelToolResult): string {
  return result.content.map((part: any) => {
    if (typeof part?.value === "string") return part.value;
    if (part?.value && typeof part.value.value === "string") return part.value.value;
    return JSON.stringify(part);
  }).filter(Boolean).join("\n");
}
