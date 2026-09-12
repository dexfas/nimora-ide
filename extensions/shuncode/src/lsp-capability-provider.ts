import * as vscode from "vscode";
import type { IdeCapabilityProvider } from "./ide-capability-provider.js";
import { invokeLspTool } from "./lsp-tool.js";
import { toolResult } from "./ide-provider-utils.js";

export class LspCapabilityProvider implements IdeCapabilityProvider {
  readonly id = "lsp";

  dispose(): void {}

  async invoke(name: string, input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
    if (name !== "lsp") throw new Error(`LSP provider does not handle ${name}.`);
    return toolResult(await invokeLspTool(input));
  }

  runSmokeTest(): Promise<string> {
    return invokeLspTool({ operation: "workspace_symbols", query: "RuntimeClient", max_results: 20 });
  }
}
