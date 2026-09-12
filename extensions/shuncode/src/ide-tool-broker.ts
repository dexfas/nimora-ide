import * as vscode from "vscode";
import { IDE_TOOL_DEFINITIONS, getIdeToolDefinition } from "../../../src/ide-tool-definitions.js";
import { DiagnosticsCapabilityProvider } from "./diagnostics-capability-provider.js";
import { assertUniqueProviderIds, providerById, type IdeCapabilityProvider } from "./ide-capability-provider.js";
import { asRecord, resultText } from "./ide-provider-utils.js";
import { LspCapabilityProvider } from "./lsp-capability-provider.js";
import { CHAT_CAPTURE_INPUT_KEY, TerminalCommandManager } from "./terminal-command-manager.js";
import { TerminalCapabilityProvider } from "./terminal-capability-provider.js";
import { WorkspaceCapabilityProvider } from "./workspace-capability-provider.js";

export interface IdeToolInvocationContext {
  toolInvocationToken?: vscode.ChatParticipantToolToken;
  cancellationToken: vscode.CancellationToken;
}

export class IdeToolBroker implements vscode.Disposable {
  private readonly terminalProvider = new TerminalCapabilityProvider(new TerminalCommandManager());
  private readonly lspProvider = new LspCapabilityProvider();
  private readonly providers: readonly IdeCapabilityProvider[] = [
    new WorkspaceCapabilityProvider(),
    this.terminalProvider,
    new DiagnosticsCapabilityProvider(),
    this.lspProvider,
  ];
  private readonly registrations: vscode.Disposable[] = [];

  async runTerminalSmokeTest(): Promise<string> {
    return this.terminalProvider.runSmokeTest();
  }

  async runLspSmokeTest(): Promise<string> {
    return this.lspProvider.runSmokeTest();
  }

  revealTerminal(terminalId: string): boolean {
    return this.terminalProvider.revealTerminal(terminalId);
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
    const definition = getIdeToolDefinition(name);
    if (!definition) throw new Error(`Unsupported IDE tool: ${name}`);
    const provider = providerById(this.providers, definition.provider);
    if (!provider) throw new Error(`IDE capability provider ${definition.provider} is unavailable for ${name}.`);
    return provider.invoke(name, input);
  }

  constructor() {
    assertUniqueProviderIds(this.providers);
    for (const definition of IDE_TOOL_DEFINITIONS) {
      const provider = providerById(this.providers, definition.provider);
      if (!provider) throw new Error(`No IDE capability provider ${definition.provider} exists for ${definition.name}.`);
      this.registrations.push(vscode.lm.registerTool<Record<string, unknown>>(definition.vscodeToolName, {
        prepareInvocation: async (options) => {
          const input = asRecord(options.input);
          return provider.prepareInvocation
            ? await provider.prepareInvocation(definition.name, input)
            : { invocationMessage: definition.name };
        },
        invoke: async (options) => provider.invoke(definition.name, asRecord(options.input)),
      }));
    }
  }

  async invoke(
    name: string,
    args: Record<string, unknown>,
    context: IdeToolInvocationContext,
    allowRegisteredTool = false,
  ): Promise<{ text: string; isError: boolean }> {
    const definition = getIdeToolDefinition(name);
    if (!definition && !allowRegisteredTool) return { text: `Unknown IDE tool: ${name}`, isError: true };
    try {
      const result = await vscode.lm.invokeTool(definition?.vscodeToolName ?? name, {
        input: definition?.name === "run_command"
          ? { ...args, [CHAT_CAPTURE_INPUT_KEY]: true }
          : args,
        toolInvocationToken: context.toolInvocationToken,
      }, context.cancellationToken);
      return { text: resultText(result), isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const mcpHint = !definition && (name.startsWith("mcp__") || /could not be started|MCP server/i.test(message))
        ? " The MCP server may be disconnected; restart it from the MCP servers view and send a new message."
        : "";
      return { text: `${definition ? "IDE" : "Registered"} tool ${name} failed: ${message}${mcpHint}`, isError: true };
    }
  }

  /**
   * Executes the same implementation registered with vscode.lm, but without a native Chat
   * invocation token. The HTTP Bridge uses this path because the remote MCP client owns its
   * confirmation UX; tool semantics, terminal state, diagnostics and LSP behavior remain shared.
   */
  async invokeDirect(
    name: string,
    args: Record<string, unknown>,
    cancellationToken?: vscode.CancellationToken,
  ): Promise<{ text: string; isError: boolean }> {
    if (!getIdeToolDefinition(name)) return { text: `Unknown IDE tool: ${name}`, isError: true };
    if (cancellationToken?.isCancellationRequested) return { text: `IDE tool ${name} canceled.`, isError: true };
    try {
      const result = await this.executeTool(name, args);
      if (cancellationToken?.isCancellationRequested) return { text: `IDE tool ${name} canceled.`, isError: true };
      return { text: resultText(result), isError: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { text: `IDE tool ${name} failed: ${message}`, isError: true };
    }
  }

  dispose(): void {
    for (const provider of this.providers) provider.dispose();
    for (const registration of this.registrations) registration.dispose();
  }
}

