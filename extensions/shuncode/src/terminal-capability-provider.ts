import * as vscode from "vscode";
import type { IdeCapabilityProvider } from "./ide-capability-provider.js";
import { asInteger, asString, normalizeRelativePath, toolResult } from "./ide-provider-utils.js";

export interface TerminalCapabilityBackend extends vscode.Disposable {
  run(input: Record<string, unknown>): Promise<string>;
  getOutput(input: Record<string, unknown>): string;
  sendInput(input: Record<string, unknown>): string;
  revealTerminal(terminalId: string): boolean;
}

function summarizeCommand(command: string, maxLength = 48): string {
  const firstLine = command.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine) return "command";
  if (firstLine.length <= maxLength) return firstLine;
  return `${firstLine.slice(0, maxLength - 1)}…`;
}

function parseExitCode(text: string): number | null | undefined {
  const match = text.match(/^exit_code: (-?\d+|null)$/m);
  if (!match) return undefined;
  return match[1] === "null" ? null : Number.parseInt(match[1], 10);
}

export class TerminalCapabilityProvider implements IdeCapabilityProvider {
  readonly id = "terminal";

  constructor(private readonly backend: TerminalCapabilityBackend) {}

  dispose(): void {
    this.backend.dispose();
  }

  async invoke(name: string, input: Record<string, unknown>): Promise<vscode.LanguageModelToolResult> {
    switch (name) {
      case "run_command": return this.terminalResult(name, input, await this.backend.run(input));
      case "get_command_output": return this.terminalResult(name, input, this.backend.getOutput(input));
      case "send_command_input": return this.terminalResult(name, input, this.backend.sendInput(input));
      case "wait": return toolResult(await this.wait(input));
      default: throw new Error(`Terminal provider does not handle ${name}.`);
    }
  }

  async prepareInvocation(name: string, input: Record<string, unknown>): Promise<vscode.PreparedToolInvocation | undefined> {
    if (name !== "run_command") {
      const title = name === "get_command_output"
        ? "Read command output"
        : name === "send_command_input"
          ? "Send command input"
          : name === "wait"
            ? "Wait"
            : name;
      return { invocationMessage: title };
    }
    const command = asString(input.command).trim();
    const cwd = normalizeRelativePath(asString(input.cwd, "."));
    const background = typeof input.background === "boolean" ? input.background : false;
    const markdown = new vscode.MarkdownString();
    markdown.appendMarkdown(`Run this command in the integrated terminal?\n\n`);
    markdown.appendCodeblock(command || "(empty command)", "shell");
    markdown.appendMarkdown(`\nWorking directory: \`${cwd}\`\n\nBackground: \`${background}\``);
    return {
      invocationMessage: `Run ${summarizeCommand(command)}`,
      confirmationMessages: { title: "Run terminal command", message: markdown },
    };
  }

  async runSmokeTest(): Promise<string> {
    const firstCommand = process.platform === "win32"
      ? "$env:SHUNCODE_PERSISTENT_SMOKE='yes'; Write-Output 'shuncode-terminal-smoke-1'"
      : "export SHUNCODE_PERSISTENT_SMOKE=yes; printf 'shuncode-terminal-smoke-1\\n'";
    const secondCommand = process.platform === "win32"
      ? "Write-Output ('shuncode-terminal-smoke-2:' + $env:SHUNCODE_PERSISTENT_SMOKE)"
      : "printf 'shuncode-terminal-smoke-2:%s\\n' \"$SHUNCODE_PERSISTENT_SMOKE\"";
    const first = await this.backend.run({ command: firstCommand, cwd: ".", background: false, timeout_ms: 15_000 });
    const second = await this.backend.run({ command: secondCommand, background: false, timeout_ms: 15_000 });
    return `${first}\n--- SECOND COMMAND ---\n${second}`;
  }

  revealTerminal(terminalId: string): boolean {
    return this.backend.revealTerminal(terminalId);
  }

  private async wait(input: Record<string, unknown>): Promise<string> {
    const ms = asInteger(input.ms, 10_000, 100, 120_000);
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return `Waited ${ms} ms.`;
  }

  private terminalResult(name: string, input: Record<string, unknown>, text: string): vscode.LanguageModelToolResult {
    const result = new vscode.ExtendedLanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    const exitCode = parseExitCode(text);
    const command = typeof input.command === "string" ? input.command.trim() : "";
    const summary = summarizeCommand(command || (typeof input.input === "string" ? input.input : ""));
    switch (name) {
      case "run_command":
        result.toolResultMessage = exitCode === undefined || exitCode === null
          ? `Ran ${summary}`
          : exitCode === 0
            ? `Ran ${summary} · exit 0`
            : `Command failed: ${summary} · exit ${exitCode}`;
        break;
      case "get_command_output":
        result.toolResultMessage = exitCode === undefined || exitCode === null || exitCode === 0
          ? "Read command output"
          : `Command output · exit ${exitCode}`;
        break;
      case "send_command_input":
        result.toolResultMessage = typeof input.command_id === "string" && input.command_id
          ? `Sent command input · ${input.command_id}`
          : "Sent command input";
        break;
    }
    return result;
  }
}
