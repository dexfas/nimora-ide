import * as vscode from "vscode";
import type { IdeCapabilityProvider } from "./ide-capability-provider.js";
import { asBoolean, asInteger, asString, resolveWorkspacePath, toolResult } from "./ide-provider-utils.js";

const COMMON_EXCLUDES = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "target", "vendor"]);

export class WorkspaceCapabilityProvider implements IdeCapabilityProvider {
  readonly id = "workspace";

  dispose(): void {}

  async invoke(name: string, input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
    if (name !== "list_directory") throw new Error(`Workspace provider does not handle ${name}.`);
    return toolResult(await this.listDirectory(input));
  }

  private async listDirectory(input: Record<string, unknown>): Promise<string> {
    const scope = resolveWorkspacePath(asString(input.path, "."));
    const depth = asInteger(input.depth, 1, 1, 2);
    const includeHidden = asBoolean(input.include_hidden, false);
    const noIgnore = asBoolean(input.no_ignore, false);
    const maxEntries = asInteger(input.max_entries, 200, 1, 500);
    const entries: Array<{ type: "dir" | "file" | "symlink" | "unknown"; path: string }> = [];
    let truncated = false;

    const visit = async (uri: vscode.Uri, relative: string, level: number): Promise<void> => {
      if (truncated) return;
      const children = await vscode.workspace.fs.readDirectory(uri);
      children.sort((a, b) => {
        const ad = a[1] === vscode.FileType.Directory ? 0 : 1;
        const bd = b[1] === vscode.FileType.Directory ? 0 : 1;
        return ad - bd || a[0].localeCompare(b[0]);
      });
      for (const [childName, type] of children) {
        if (!includeHidden && childName.startsWith(".")) continue;
        if (!noIgnore && COMMON_EXCLUDES.has(childName)) continue;
        const childRelative = relative === "." ? childName : `${relative}/${childName}`;
        entries.push({
          type: type === vscode.FileType.Directory ? "dir" : type === vscode.FileType.File ? "file" : type === vscode.FileType.SymbolicLink ? "symlink" : "unknown",
          path: childRelative,
        });
        if (entries.length >= maxEntries) {
          truncated = true;
          break;
        }
        if (level < depth && type === vscode.FileType.Directory) {
          await visit(vscode.Uri.joinPath(uri, childName), childRelative, level + 1);
          if (truncated) break;
        }
      }
    };

    await visit(scope.uri, scope.relative, 1);
    return [
      "=== LIST_DIRECTORY BEGIN ===",
      `path: ${JSON.stringify(scope.relative)}`,
      `depth: ${depth}`,
      `include_hidden: ${includeHidden}`,
      `no_ignore: ${noIgnore}`,
      `returned_entries: ${entries.length}`,
      `truncated: ${truncated}`,
      "--- ENTRIES ---",
      ...entries.map((entry) => `${entry.type === "dir" ? "[DIR]" : entry.type === "file" ? "[FILE]" : entry.type === "symlink" ? "[LINK]" : "[OTHER]"} ${entry.path}`),
      "=== LIST_DIRECTORY END ===",
    ].join("\n");
  }
}
