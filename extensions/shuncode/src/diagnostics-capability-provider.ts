import path from "node:path";
import * as vscode from "vscode";
import type { IdeCapabilityProvider } from "./ide-capability-provider.js";
import { asInteger, asString, isInside, resolveWorkspacePath, toolResult, workspaceRoot } from "./ide-provider-utils.js";

function severityName(severity: vscode.DiagnosticSeverity): "error" | "warning" | "information" | "hint" {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error: return "error";
    case vscode.DiagnosticSeverity.Warning: return "warning";
    case vscode.DiagnosticSeverity.Information: return "information";
    default: return "hint";
  }
}

function diagnosticCode(code: vscode.Diagnostic["code"]): string | number | undefined {
  if (code === undefined) return undefined;
  if (typeof code === "string" || typeof code === "number") return code;
  return code.value;
}

export class DiagnosticsCapabilityProvider implements IdeCapabilityProvider {
  readonly id = "diagnostics";

  dispose(): void {}

  async invoke(name: string, input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
    if (name !== "get_diagnostics") throw new Error(`Diagnostics provider does not handle ${name}.`);
    return toolResult(this.getDiagnostics(input));
  }

  private getDiagnostics(input: Record<string, unknown>): string {
    const root = workspaceRoot();
    const scope = input.path === undefined ? undefined : resolveWorkspacePath(asString(input.path));
    const severities = Array.isArray(input.severity) ? new Set(input.severity.filter((value): value is string => typeof value === "string")) : undefined;
    const maxResults = asInteger(input.max_results, 100, 1, 500);
    const rows: Array<Record<string, unknown>> = [];
    let totalMatching = 0;

    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== "file" || !isInside(root, uri.fsPath)) continue;
      if (scope) {
        const scopePath = path.resolve(scope.absolute);
        const candidate = path.resolve(uri.fsPath);
        if (!(candidate === scopePath || candidate.startsWith(`${scopePath}${path.sep}`))) continue;
      }
      for (const diagnostic of diagnostics) {
        const severity = severityName(diagnostic.severity);
        if (severities && !severities.has(severity)) continue;
        totalMatching += 1;
        if (rows.length >= maxResults) continue;
        rows.push({
          path: path.relative(root, uri.fsPath).replace(/\\/g, "/"),
          line: diagnostic.range.start.line + 1,
          column: diagnostic.range.start.character + 1,
          end_line: diagnostic.range.end.line + 1,
          end_column: diagnostic.range.end.character + 1,
          severity,
          source: diagnostic.source ?? null,
          code: diagnosticCode(diagnostic.code) ?? null,
          message: diagnostic.message,
        });
      }
    }

    rows.sort((a, b) => {
      const order: Record<string, number> = { error: 0, warning: 1, information: 2, hint: 3 };
      return (order[String(a.severity)] ?? 9) - (order[String(b.severity)] ?? 9)
        || String(a.path).localeCompare(String(b.path))
        || Number(a.line) - Number(b.line)
        || Number(a.column) - Number(b.column);
    });
    const returned = rows.slice(0, maxResults);
    return [
      "=== GET_DIAGNOSTICS BEGIN ===",
      `scope: ${JSON.stringify(scope?.relative ?? ".")}`,
      `returned: ${returned.length}`,
      `total_matching: ${totalMatching}`,
      `truncated: ${totalMatching > returned.length}`,
      "--- DIAGNOSTICS ---",
      ...returned.map((row, index) => [
        `--- DIAGNOSTIC ${index + 1} ---`,
        `${row.path}:${row.line}:${row.column}`,
        `severity: ${row.severity}`,
        `source: ${JSON.stringify(row.source)}`,
        `code: ${JSON.stringify(row.code)}`,
        String(row.message),
      ].join("\n")),
      "=== GET_DIAGNOSTICS END ===",
    ].join("\n");
  }
}
