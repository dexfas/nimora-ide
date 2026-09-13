import type { TaskArtifactRef } from "../../../src/task-contract.js";

export type TaskTerminalToolName = "run_command" | "get_command_output" | "send_command_input";
export type TaskTerminalArtifactInput = Omit<TaskArtifactRef, "artifactId" | "createdAt" | "executionId">;

const MAX_TERMINAL_CONTENT_CHARS = 24_000;
const MAX_COMMAND_CHARS = 4_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function field(text: string, name: string): string | undefined {
  return text.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim();
}

function jsonStringField(text: string, name: string): string | undefined {
  const raw = field(text, name);
  if (raw === undefined || raw === "null") return undefined;
  try {
    const value = JSON.parse(raw);
    return typeof value === "string" ? value : undefined;
  } catch {
    return raw;
  }
}

function integerField(text: string, name: string): number | undefined {
  const raw = field(text, name);
  if (raw === undefined || raw === "null") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) ? value : undefined;
}

function booleanField(text: string, name: string): boolean | undefined {
  const raw = field(text, name);
  return raw === "true" ? true : raw === "false" ? false : undefined;
}

function outputBlock(text: string): string | undefined {
  const begin = "--- OUTPUT BEGIN ---";
  const end = "--- OUTPUT END ---";
  const start = text.indexOf(begin);
  if (start < 0) return undefined;
  const contentStart = start + begin.length;
  const finish = text.indexOf(end, contentStart);
  const value = text.slice(contentStart, finish >= 0 ? finish : undefined).replace(/^\r?\n/, "").replace(/\r?\n$/, "");
  return value || undefined;
}

function bounded(value: string | undefined, maxChars: number): { value?: string; truncated: boolean } {
  const text = value?.trim();
  if (!text) return { value: undefined, truncated: false };
  return text.length <= maxChars
    ? { value: text, truncated: false }
    : { value: text.slice(0, maxChars), truncated: true };
}

function commandId(args: Record<string, unknown> | undefined, resultText: string): string | undefined {
  return field(resultText, "command_id") ?? (typeof args?.command_id === "string" && args.command_id.trim() ? args.command_id.trim() : undefined);
}

export function taskTerminalArtifact(toolName: string, args: unknown, resultText: string): TaskTerminalArtifactInput | undefined {
  if (toolName !== "run_command" && toolName !== "get_command_output" && toolName !== "send_command_input") return undefined;
  const input = asRecord(args);
  const id = commandId(input, resultText);
  const terminalId = field(resultText, "terminal_id");
  const execution = field(resultText, "execution");
  const terminalOpenable = Boolean(terminalId && terminalId !== "direct" && execution !== "direct");
  const common = {
    sourceTool: toolName,
    commandId: id,
    terminalId,
    terminalName: jsonStringField(resultText, "terminal_name"),
    terminalOpenable,
    execution,
    status: field(resultText, "status"),
    exitCode: integerField(resultText, "exit_code"),
  };

  if (toolName === "send_command_input") {
    if (!resultText.includes("=== SEND_COMMAND_INPUT BEGIN ===")) return undefined;
    return {
      kind: "terminal",
      title: id ? `Sent command input · ${id}` : "Sent command input",
      metadata: {
        ...common,
        bytesSent: integerField(resultText, "bytes_sent"),
        appendNewline: booleanField(resultText, "append_newline"),
      },
    };
  }

  const expectedEnvelope = toolName === "run_command" ? "=== RUN_COMMAND BEGIN ===" : "=== COMMAND_OUTPUT BEGIN ===";
  if (!resultText.includes(expectedEnvelope)) return undefined;
  const output = bounded(outputBlock(resultText), MAX_TERMINAL_CONTENT_CHARS);
  const command = toolName === "run_command"
    ? bounded(typeof input?.command === "string" ? input.command : jsonStringField(resultText, "command"), MAX_COMMAND_CHARS)
    : { value: undefined, truncated: false };
  return {
    kind: "terminal",
    title: toolName === "run_command"
      ? id ? `Terminal command · ${id}` : "Terminal command"
      : id ? `Command output · ${id}` : "Command output",
    metadata: {
      ...common,
      command: command.value,
      commandTruncated: command.truncated,
      cwd: jsonStringField(resultText, "cwd"),
      background: booleanField(resultText, "background"),
      content: output.value,
      contentLanguage: output.value ? "text" : undefined,
      contentTruncated: output.truncated,
      outputLost: booleanField(resultText, "output_lost"),
      hasMore: booleanField(resultText, "has_more"),
      nextOffset: integerField(resultText, "next_offset"),
      totalOutputBytes: integerField(resultText, "total_output_bytes"),
    },
  };
}
