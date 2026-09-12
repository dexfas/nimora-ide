export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  vscodeToolName: string;
  capability: "read" | "execute";
}

export const IDE_TOOL_DEFINITIONS: readonly AgentToolDefinition[] = [
  {
    name: "list_directory",
    vscodeToolName: "shuncode_list_directory",
    capability: "read",
    description: "List the immediate contents of a workspace directory. Use this to understand what is in a known directory; use find_files when searching by filename/path pattern. Depth is intentionally limited to 1 or 2.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Workspace-relative directory path. Defaults to the workspace root." },
        depth: { type: "integer", enum: [1, 2], default: 1, description: "Directory depth to list. Keep this small; use find_files for recursive discovery." },
        include_hidden: { type: "boolean", default: false, description: "Include dot-prefixed entries." },
        no_ignore: { type: "boolean", default: false, description: "Include common generated/ignored directories such as node_modules, dist and .git." },
        max_entries: { type: "integer", minimum: 1, maximum: 500, default: 200, description: "Maximum returned entries." }
      },
      additionalProperties: false
    }
  },
  {
    name: "run_command",
    vscodeToolName: "shuncode_run_command",
    capability: "execute",
    description: "Run a shell command in a ShunCode-managed persistent real PTY that is independent of the user's terminal profiles and VS Code Shell Integration. Windows is backed by the bundled node-pty runtime and ConPTY, using one long-lived system Windows PowerShell (powershell.exe) with -NoProfile per terminal slot; POSIX uses a long-lived native PTY with /bin/bash without profile files when available, otherwise /bin/sh. Shell state such as environment variables, functions and the current directory persists when the same terminal is reused. Omit cwd to continue from the most recently used idle ShunCode terminal's current directory; the first command defaults to the workspace root. Interactive input, terminal resize and TTY-aware CLI behavior are supported. Concurrent/busy commands may use additional terminals. Always explicitly choose background=true for long-running servers/watchers and background=false for commands whose result should be awaited. Returns a command_id for later output inspection or interactive input. Execution modes: pty (default) runs in the managed persistent terminal above and supports interactive input; direct runs the command through a one-shot child process with piped output and a process-level exit code (no terminal view, no interactive input). Prefer execution=\"direct\" for non-interactive one-shot commands such as builds, tests and scripts; keep the default pty for interactive programs, TUIs, and background=true servers that should stay visible in a terminal. The result header always carries the same fixed fields: facts that would be absent are explicit instead (script_bridge is null when the command was not bridged through a temp script, recovered_by_abort and suspected_parser_error default to false, shell_prompt_seq is null in direct mode, hint is \"none\" when not running) — parse the header by field name, never by line presence.",
    inputSchema: {
      type: "object",
      required: ["command", "background"],
      properties: {
        command: { type: "string", minLength: 1, description: "Shell command to run." },
        cwd: { type: "string", description: "Optional workspace-relative working directory. When omitted, reuse the most recently used idle ShunCode terminal and continue from its current directory; a new terminal starts at the workspace root." },
        background: { type: "boolean", description: "Whether this is expected to keep running. Must be chosen explicitly." },
        timeout_ms: { type: "integer", minimum: 1000, maximum: 120000, default: 120000, description: "For foreground commands, maximum time to wait before returning status=running. The command is not killed on timeout." },
        execution: { type: "string", enum: ["pty", "direct"], default: "pty", description: "pty = managed persistent terminal (interactive, visible in a terminal tab); direct = one-shot child process with a process-level exit code (non-interactive, no terminal view). direct spawns a fresh shell per command (about 1-4s PowerShell cold-start overhead on Windows); prefer the default pty when running many rapid sequential commands that need shell state." }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_command_output",
    vscodeToolName: "shuncode_get_command_output",
    capability: "execute",
    description: "Read new output and status from a previously started run_command using its command_id. Use next_offset on subsequent reads to avoid repeating old output.",
    inputSchema: {
      type: "object",
      required: ["command_id"],
      properties: {
        command_id: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 0, default: 0, description: "Absolute UTF-8 byte offset into captured output." },
        max_bytes: { type: "integer", minimum: 1, maximum: 131072, default: 32768 }
      },
      additionalProperties: false
    }
  },
  {
    name: "send_command_input",
    vscodeToolName: "shuncode_send_command_input",
    capability: "execute",
    description: "Send text to the terminal of a running command. Use for interactive prompts or REPL input. A newline is appended by default.",
    inputSchema: {
      type: "object",
      required: ["command_id", "input"],
      properties: {
        command_id: { type: "string", minLength: 1 },
        input: { type: "string" },
        append_newline: { type: "boolean", default: true }
      },
      additionalProperties: false
    }
  },
  {
    name: "wait",
    vscodeToolName: "shuncode_wait",
    capability: "execute",
    description: "Block for a fixed amount of time (ms), then return. Use to let a background command started with run_command (background=true) make progress before reading its output with get_command_output, or to give a server/watcher time to emit more output. Choose one wait long enough for the expected work (e.g. 10_000-30_000 ms for builds, up to 120_000 for slow compiles) instead of polling get_command_output in a tight loop. The wait only sleeps; it does not check command status.",
    inputSchema: {
      type: "object",
      required: ["ms"],
      properties: {
        ms: { type: "integer", minimum: 100, maximum: 120000, default: 10000, description: "Milliseconds to wait." }
      },
      additionalProperties: false
    }
  },
  {
    name: "get_diagnostics",
    vscodeToolName: "shuncode_get_diagnostics",
    capability: "read",
    description: "Read current diagnostics from VS Code and active language services, including unsaved editor state when providers report it. Use after edits/builds to inspect errors and warnings structurally instead of parsing compiler output when diagnostics are available.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Optional workspace-relative file or directory scope." },
        severity: {
          type: "array",
          items: { type: "string", enum: ["error", "warning", "information", "hint"] },
          uniqueItems: true,
          description: "Optional severity filter. Defaults to all severities."
        },
        max_results: { type: "integer", minimum: 1, maximum: 500, default: 100 }
      },
      additionalProperties: false
    }
  },
  {
    name: "lsp",
    vscodeToolName: "shuncode_lsp",
    capability: "read",
    description: "Navigate code semantically through the language services already active in VS Code. Use this for code symbols rather than text search: workspace/document symbols, go-to-definition, references, implementations, and hover/type information. Results include provider_state, project_anchor, project_anchor_source, warmup_performed, and semantic_result_inconclusive metadata so empty semantic results and heuristic warm-up anchors are not over-interpreted. Use search_files for raw text and read_files after lsp locates the relevant implementation.",
    inputSchema: {
      type: "object",
      required: ["operation"],
      properties: {
        operation: {
          type: "string",
          enum: ["workspace_symbols", "document_symbols", "definition", "references", "implementation", "hover"],
          description: "Semantic operation to execute through VS Code language feature providers."
        },
        path: { type: "string", description: "Workspace source path. Workspace-relative is preferred; absolute paths are accepted only when they remain inside the workspace. Required for document_symbols/definition/references/implementation/hover. Optional for workspace_symbols as a project/file/directory anchor to activate the relevant language project before semantic search." },
        line: { type: "integer", minimum: 1, description: "1-based source line. Required for definition/references/implementation/hover." },
        column: { type: "integer", minimum: 1, description: "1-based UTF-16 source column. Required for definition/references/implementation/hover." },
        query: { type: "string", description: "Symbol query. Required for workspace_symbols." },
        include_declaration: { type: "boolean", default: true, description: "For references, include the symbol declaration/definition when present." },
        max_results: { type: "integer", minimum: 1, maximum: 500, description: "Maximum returned semantic results. Operation-specific defaults are used when omitted." }
      },
      additionalProperties: false
    }
  }
] as const;

export const IDE_TOOL_NAMES = IDE_TOOL_DEFINITIONS.map((tool) => tool.name);

/**
 * IDE tools that only make sense inside the native Chat runtime and must not be
 * exposed over the Bridge MCP surface. Remote agents connected through Bridge
 * have their own pacing; a tool that sleeps on the local terminal is meaningless
 * to them and only pollutes their tool list.
 */
export const BRIDGE_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set(["wait"]);

export function getIdeToolDefinition(name: string): AgentToolDefinition | undefined {
  return IDE_TOOL_DEFINITIONS.find((tool) => tool.name === name);
}

