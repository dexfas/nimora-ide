import * as child_process from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as vscode from "vscode";
import type { TerminalCapabilityBackend } from "./terminal-capability-provider.js";

const MAX_CAPTURED_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_OUTPUT_BYTES = 32 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_IDLE_TERMINALS = 4;
const PTY_EXIT_DATA_FLUSH_MS = 100;
const COMMAND_ECHO_TIMEOUT_MS = 3000;
const MAX_ECHO_HUNT_BYTES = 1024 * 1024;
const MANAGED_TERMINAL_NAME = /^ShunCode · \d+$/;
const CHAT_CAPTURE_COLUMNS = 1000;
export const CHAT_CAPTURE_INPUT_KEY = "__shuncodeChatCapture";

interface TerminalSlot {
  id: string;
  terminal: vscode.Terminal;
  pty: ManagedCommandPseudoterminal;
  initialCwd: string;
  busyCommandId?: string;
  closed: boolean;
  lastUsedAt: number;
}

interface CommandState {
  id: string;
  kind: "pty" | "direct";
  terminal: vscode.Terminal | null;
  terminalId: string;
  terminalName: string;
  terminalReused: boolean;
  slot?: TerminalSlot;
  command: string;
  cwd: string;
  startedAt: number;
  endedAt?: number;
  background: boolean;
  status: "running" | "completed" | "failed" | "killed";
  exitCode: number | null;
  output: Buffer;
  outputStartOffset: number;
  totalOutputBytes: number;
  ansiPending: string;
  tempScriptPath?: string;
  suspectedParserError?: boolean;
  recoveredByAbort?: boolean;
  child?: child_process.ChildProcess;
  done: Promise<void>;
  resolveDone(): void;
}

interface ManagedShellSpec {
  executable: string;
  args: string[];
  env?: Record<string, string>;
}

interface NodePtyDisposable {
  dispose(): void;
}

interface NodePtyProcess {
  readonly pid: number;
  readonly process: string;
  onData(listener: (data: string) => void): NodePtyDisposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): NodePtyDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

interface NodePtyModule {
  spawn(
    file: string,
    args: string[],
    options: {
      name: string;
      cwd: string;
      env: Record<string, string>;
      cols: number;
      rows: number;
    },
  ): NodePtyProcess;
}

let nodePtyModule: NodePtyModule | undefined;

function getNodePty(): NodePtyModule {
  if (nodePtyModule) return nodePtyModule;

  const candidates = [
    path.join(vscode.env.appRoot, "node_modules.asar", "node-pty"),
    path.join(vscode.env.appRoot, "node_modules", "node-pty"),
  ];
  let lastError: unknown;
  for (const modulePath of candidates) {
    try {
      if (!fs.existsSync(modulePath)) continue;
      const loaded = require(modulePath) as Partial<NodePtyModule>;
      if (typeof loaded.spawn !== "function") throw new Error("module does not export spawn()");
      nodePtyModule = loaded as NodePtyModule;
      return nodePtyModule;
    } catch (error) {
      lastError = error;
    }
  }

  const detail = lastError instanceof Error ? ` ${lastError.message}` : "";
  throw new Error(`ShunCode could not load the bundled node-pty runtime from ${vscode.env.appRoot}.${detail}`);
}

function managedShellSpec(protocolToken: string): ManagedShellSpec {
  if (process.platform === "win32") {
    const windowsRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    const executable = path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    if (!fs.existsSync(executable)) {
      throw new Error(`ShunCode managed terminal cannot find Windows PowerShell at ${executable}.`);
    }
    const markerPrefix = `\u001b]633;ShunCode;${protocolToken};`;
    const initializePrompt = [
      "$global:__ShunCodePromptSequence = 0",
      "$global:LASTEXITCODE = 0",
      "function global:prompt {",
      "  $shunCodeSuccess = $?",
      "  $shunCodeNativeExit = $global:LASTEXITCODE",
      "  if ($shunCodeSuccess) { $shunCodeExit = 0 } elseif (($null -ne $shunCodeNativeExit) -and ([int]$shunCodeNativeExit -ne 0)) { $shunCodeExit = [int]$shunCodeNativeExit } else { $shunCodeExit = 1 }",
      "  $global:LASTEXITCODE = 0",
      "  $global:__ShunCodePromptSequence++",
      "  $shunCodeCwd = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).Path))",
      `  [Console]::Write("${markerPrefix}$global:__ShunCodePromptSequence;$shunCodeExit;$shunCodeCwd\u0007")`,
      "  \"PS $($executionContext.SessionState.Path.CurrentLocation)> \"",
      "}",
    ].join("; ");
    return {
      executable,
      args: [
        "-NoLogo",
        "-NoProfile",
        "-NoExit",
        "-ExecutionPolicy", "Bypass",
        "-Command",
        `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ${initializePrompt}`,
      ],
    };
  }

  const bash = "/bin/bash";
  if (fs.existsSync(bash)) {
    const promptCommand = [
      "__shuncode_ec=$?",
      "__shuncode_seq=$((${__shuncode_seq:-0}+1))",
      "__shuncode_cwd=$(printf '%s' \"$PWD\" | base64 | tr -d '\\r\\n')",
      `printf '\\033]633;ShunCode;${protocolToken};%s;%s;%s\\007' \"$__shuncode_seq\" \"$__shuncode_ec\" \"$__shuncode_cwd\"`,
    ].join("; ");
    return {
      executable: bash,
      args: ["--noprofile", "--norc", "-i"],
      env: {
        PROMPT_COMMAND: promptCommand,
        PS1: "$ ",
      },
    };
  }
  const sh = "/bin/sh";
  if (fs.existsSync(sh)) {
    const promptExpression = [
      "__shuncode_ec=$?",
      "__shuncode_seq=$((${__shuncode_seq:-0}+1))",
      "__shuncode_cwd=$(printf '%s' \"$PWD\" | base64 | tr -d '\\r\\n')",
      `printf '\\033]633;ShunCode;${protocolToken};%s;%s;%s\\007' \"$__shuncode_seq\" \"$__shuncode_ec\" \"$__shuncode_cwd\"`,
    ].join("; ");
    return {
      executable: sh,
      args: ["-i"],
      env: { PS1: `$(${promptExpression})$ ` },
    };
  }
  throw new Error("ShunCode managed terminal cannot find /bin/bash or /bin/sh.");
}

function managedProcessEnvironment(): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  // This process is intentionally independent from VS Code's terminal shell-integration
  // injection. In particular, do not leak an outer terminal's integration markers into it.
  delete env.VSCODE_INJECTION;
  delete env.VSCODE_NONCE;
  delete env.VSCODE_SHELL_INTEGRATION;
  delete env.PROMPT_COMMAND;
  delete env.PS1;
  delete env.ENV;
  delete env.BASH_ENV;
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.SHUNCODE_AGENT_TERMINAL = "1";
  if (process.platform === "win32") {
    // Prefer the product-bundled PSReadLine over the Windows in-box 2.0.0 (known negative
    // cursor-position ConPTY rendering bugs): ConsoleHost resolves PSReadLine through
    // PSModulePath and the first entry wins. The vendor payload only contains PSReadLine,
    // so nothing else is shadowed.
    const vendorModules = bundledModulesDir();
    if (vendorModules) env.PSModulePath = `${vendorModules};${env.PSModulePath ?? ""}`;
  }
  return env;
}

let cachedBundledModulesDir: string | undefined | null;

/**
 * Product-bundled PowerShell modules shipped under extensions/shuncode/vendor. Resolved
 * relative to the compiled bundle first (dist/..) and then relative to the installed
 * extension layout inside the host app. Returns undefined when the payload is absent so the
 * shell silently falls back to the in-box PSReadLine.
 */
function bundledModulesDir(): string | undefined {
  if (cachedBundledModulesDir === null) return undefined;
  if (cachedBundledModulesDir) return cachedBundledModulesDir;
  const candidates = [
    path.join(__dirname, "..", "vendor"),
    path.join(vscode.env.appRoot, "extensions", "shuncode", "vendor"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "PSReadLine", "PSReadLine.psd1"))) {
      cachedBundledModulesDir = dir;
      return dir;
    }
  }
  cachedBundledModulesDir = null;
  return undefined;
}

class ManagedCommandPseudoterminal implements vscode.Pseudoterminal, vscode.Disposable {
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  readonly onDidWrite = this.writeEmitter.event;
  private readonly closeEmitter = new vscode.EventEmitter<void | number>();
  readonly onDidClose = this.closeEmitter.event;
  private readonly protocolToken = `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  private readonly protocolPrefix = `\u001b]633;ShunCode;${this.protocolToken};`;
  private readonly openPromise: Promise<void>;
  private resolveOpen!: () => void;
  private startPromise: Promise<void> | undefined;
  private ready = false;
  private readyResolver: (() => void) | undefined;
  private readyRejecter: ((error: Error) => void) | undefined;
  private protocolBuffer = "";
  // Echo gate state. The shell renders the typed command (and agent-sent input) back into the
  // PTY output stream (PSReadLine/Readline/tty echo), and ConPTY can deliver that rendering
  // late, interleaved with stale prompts, full-screen redraws (chat capture resizes the PTY
  // before each command) and cooked-echo/PSReadLine redraw races. The gate consumes the echo
  // so none of it leaks into the terminal display or the captured tool result.
  private echoExpectation = "";
  private echoMatchIndex = 0;
  private echoGateActive = false;
  private echoHuntBytesRemaining = 0;
  private echoHuntDiscardAll = false;
  private echoHuntingPromptLine = false;
  private echoTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  private activePty: NodePtyProcess | undefined;
  private activePtyDataSubscription: NodePtyDisposable | undefined;
  private activePtyExitSubscription: NodePtyDisposable | undefined;
  private activeCommand: {
    sequence: number;
    started: boolean;
    seqAtStart: number;
    recoveryInitiated?: boolean;
    captureColumns?: number;
    finishing?: boolean;
    finishExitCode?: number | null;
    finishTimer?: ReturnType<typeof setTimeout>;
    onOutput(text: string): void;
    onExit(code: number | null, meta?: { recovered?: boolean }): void;
  } | undefined;
  private nextCommandSequence = 1;
  private lastPromptSequence = 0;
  private continuationPromptSeen = false;
  private currentCwdValue: string;
  private cols = 80;
  private rows = 24;
  private disposed = false;

  constructor(private readonly initialCwd: string) {
    this.currentCwdValue = initialCwd;
    this.openPromise = new Promise<void>((resolve) => { this.resolveOpen = resolve; });
  }

  get currentCwd(): string {
    return this.currentCwdValue;
  }

  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    if (initialDimensions) {
      this.cols = Math.max(1, initialDimensions.columns);
      this.rows = Math.max(1, initialDimensions.rows);
    }
    this.resolveOpen();
  }

  close(): void {
    this.dispose();
  }

  setDimensions(dimensions: vscode.TerminalDimensions): void {
    this.cols = Math.max(1, dimensions.columns);
    this.rows = Math.max(1, dimensions.rows);
    const pty = this.activePty;
    if (!pty) return;
    // Freeze ConPTY resizes while a command runs: a mid-command column change forces full
    // rewraps and PSReadLine cursor recomputes (the SetCursorPosition(top<0) class of
    // failures). The latest display size is applied once after the command finishes
    // (restoreDisplayDimensions always resizes to the current this.cols/this.rows).
    if (this.activeCommand) return;
    try {
      pty.resize(this.cols, this.rows);
    } catch {
      // A PTY may exit between the dimensions event and resize().
    }
  }

  handleInput(data: string): void {
    if (!this.activePty) return;
    this.activePty.write(data);
  }

  writeDisplay(text: string): void {
    if (!this.disposed) this.writeEmitter.fire(text);
  }

  sendInput(text: string, appendNewline: boolean): void {
    if (!this.activePty) {
      throw new Error("The ShunCode managed PTY is not accepting input.");
    }
    // Interactive programs (REPLs, prompts) echo agent-typed input back into the PTY stream;
    // consume that echo so it never pollutes the captured tool result. handleInput() (user
    // keystrokes) stays ungated on purpose: its echo is the visible feedback in the view.
    this.echoExpectation = text.replace(/[\r\n]+/g, "");
    this.echoMatchIndex = 0;
    this.echoHuntBytesRemaining = MAX_ECHO_HUNT_BYTES;
    // Discard everything (bounded) until the echo anchor: a REPL may render its prompt
    // (">>> ") plus stale redraw content in the same chunk that precedes the echo.
    this.echoHuntDiscardAll = true;
    this.echoHuntingPromptLine = false;
    this.echoGateActive = true;
    this.armEchoTimeout();
    this.activePty.write(appendNewline ? `${text}\r` : text);
  }

  async ensureStarted(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.startPersistentShell();
    return this.startPromise;
  }

  async run(
    command: string,
    handlers: {
      onOutput(text: string): void;
      onExit(code: number | null, meta?: { recovered?: boolean }): void;
    },
    captureColumns?: number,
  ): Promise<void> {
    await this.ensureStarted();
    if (this.disposed) throw new Error("The ShunCode managed terminal is closed.");
    if (!this.activePty) throw new Error("The ShunCode managed PTY shell is not running.");
    if (this.activeCommand) throw new Error("The ShunCode managed terminal is already running a command.");
    const sequence = this.nextCommandSequence++;
    this.activeCommand = { sequence, started: false, seqAtStart: this.lastPromptSequence, captureColumns, ...handlers };
    if (captureColumns) {
      try {
        this.activePty.resize(captureColumns, this.rows);
      } catch {
        // The PTY may exit immediately before the command starts.
      }
    }
    this.writeDisplay(`${command.replace(/\r?\n/g, "\r\n")}\r\n`);
    const normalizedCommand = command.replace(/[\r\n]+/g, "");
    // Arm the echo gate BEFORE writing: every byte that arrives from the PTY after the write
    // is either the echo (consume it) or noise that precedes it (stale prompt, resize redraw);
    // the timeout bounds how long the gate may stay closed when no echo ever renders.
    this.echoExpectation = normalizedCommand;
    this.echoMatchIndex = 0;
    this.echoHuntBytesRemaining = MAX_ECHO_HUNT_BYTES;
    // Discard everything (bounded) until the echo anchor for every run: chat capture resizes
    // the PTY (full-screen redraw), and a previous command's restore-resize redraw can be
    // delivered late into the next command's gate window (background snapshots showed the
    // previous commands' full history). Hunting discards that noise and keeps only the echo.
    this.echoHuntDiscardAll = true;
    this.echoHuntingPromptLine = false;
    this.echoGateActive = true;
    this.continuationPromptSeen = false;
    this.armEchoTimeout();
    try {
      // Type the command exactly as a user would. No protocol prefix is written into the
      // input stream: the shell's echo of the typed line is consumed by the echo gate in
      // emitPtyData(), so the terminal view, the shell history, and error source lines never
      // show protocol scaffolding.
      this.activePty.write(`${command}\r`);
    } catch (error) {
      this.activeCommand = undefined;
      this.resetEchoGate();
      this.restoreDisplayDimensions();
      throw error;
    }
  }

  private restoreDisplayDimensions(): void {
    if (!this.activePty) return;
    try {
      this.activePty.resize(this.cols, this.rows);
    } catch {
      // The PTY may have exited while the command was completing.
    }
  }

  /**
   * Cancel whatever the shell currently has buffered (PSReadLine continuation input, an
   * unclosed quote or here-string) with Esc + Ctrl+C, like a user clearing the line. The
   * interrupted command is marked recovered so it can never be reported as a success.
   */
  abortCurrentInput(): void {
    const active = this.activeCommand;
    if (active) active.recoveryInitiated = true;
    this.resetEchoGate();
    if (this.echoTimeoutTimer) {
      clearTimeout(this.echoTimeoutTimer);
      this.echoTimeoutTimer = undefined;
    }
    if (!this.activePty) return;
    try {
      this.activePty.write("\u001b");
    } catch {
      // The PTY may have exited.
    }
    setTimeout(() => {
      try {
        this.activePty?.write("\u0003");
      } catch {
        // The PTY may have exited.
      }
    }, 150);
  }

  get hasContinuationHint(): boolean {
    return this.continuationPromptSeen;
  }

  get lastSeenPromptSequence(): number {
    return this.lastPromptSequence;
  }

  private async startPersistentShell(): Promise<void> {
    await this.openPromise;
    if (this.disposed) throw new Error("The ShunCode managed terminal is closed.");
    const shell = managedShellSpec(this.protocolToken);
    const env = { ...managedProcessEnvironment(), ...shell.env };
    const ptyProcess = getNodePty().spawn(shell.executable, shell.args, {
      name: process.platform === "win32" ? "cmd" : "xterm-256color",
      cwd: this.initialCwd,
      env,
      cols: this.cols,
      rows: this.rows,
    });
    this.activePty = ptyProcess;

    this.activePtyDataSubscription = ptyProcess.onData((data) => {
      this.handlePtyData(data);
    });
    this.activePtyExitSubscription = ptyProcess.onExit((event) => {
      setTimeout(() => {
        if (this.activePty === ptyProcess) this.activePty = undefined;
        const activeCommand = this.activeCommand;
        this.activeCommand = undefined;
        if (activeCommand?.finishTimer) {
          clearTimeout(activeCommand.finishTimer);
          activeCommand.finishTimer = undefined;
        }
        if (!this.ready) {
          this.readyRejecter?.(new Error(`ShunCode managed PTY shell exited before its first prompt (exit_code=${event.exitCode}).`));
        }
        activeCommand?.onExit(event.exitCode, { recovered: activeCommand.recoveryInitiated === true });
        this.disposeActivePtySubscriptions();
        if (!this.disposed) this.closeEmitter.fire(event.exitCode >= 0 ? event.exitCode : 1);
      }, PTY_EXIT_DATA_FLUSH_MS);
    });

    if (!this.ready) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.ready) return;
          reject(new Error("ShunCode managed PTY shell did not reach its first prompt within 8 seconds."));
        }, 8_000);
        const finish = (fn: () => void) => () => {
          clearTimeout(timer);
          fn();
        };
        this.readyResolver = finish(resolve);
        this.readyRejecter = (error) => finish(() => reject(error))();
      });
    }
  }

  private handlePtyData(data: string): void {
    this.protocolBuffer += data;
    while (this.protocolBuffer) {
      const markerStart = this.protocolBuffer.indexOf(this.protocolPrefix);
      if (markerStart < 0) {
        const keep = this.protocolPrefixOverlap(this.protocolBuffer);
        const visible = this.protocolBuffer.slice(0, this.protocolBuffer.length - keep);
        if (visible) this.emitPtyData(visible);
        this.protocolBuffer = keep ? this.protocolBuffer.slice(-keep) : "";
        return;
      }

      if (markerStart > 0) this.emitPtyData(this.protocolBuffer.slice(0, markerStart));
      const markerEnd = this.protocolBuffer.indexOf("\u0007", markerStart + this.protocolPrefix.length);
      if (markerEnd < 0) {
        this.protocolBuffer = this.protocolBuffer.slice(markerStart);
        return;
      }

      const payload = this.protocolBuffer.slice(markerStart + this.protocolPrefix.length, markerEnd);
      this.protocolBuffer = this.protocolBuffer.slice(markerEnd + 1);
      this.handleProtocolMarker(payload);
    }
  }

  private protocolPrefixOverlap(value: string): number {
    const max = Math.min(value.length, this.protocolPrefix.length - 1);
    for (let length = max; length > 0; length--) {
      if (this.protocolPrefix.startsWith(value.slice(-length))) return length;
    }
    return 0;
  }

  private emitPtyData(data: string): void {
    if (this.activeCommand && this.echoGateActive) {
      const rest = this.consumeCommandEcho(data);
      if (rest === null) return;
      this.echoGateActive = false;
      if (this.echoTimeoutTimer) {
        clearTimeout(this.echoTimeoutTimer);
        this.echoTimeoutTimer = undefined;
      }
      data = rest;
    }
    this.writeDisplay(data);
    if (!this.activeCommand) return;
    if (this.activeCommand.finishing) {
      this.activeCommand.onOutput(this.stripPromptText(data));
      return;
    }
    this.activeCommand.onOutput(data);
  }

  /**
   * Consume the shell's rendering of the typed command or agent-sent input. PSReadLine,
   * Readline and tty drivers echo the text back into the PTY output, and ConPTY can deliver
   * that rendering late, preceded by stale prompt text, full-screen redraws (chat capture
   * resizes the PTY to CHAT_CAPTURE_COLUMNS before each command) and cooked-echo fragments
   * (the classic "p<BS>python" race between the console echo and PSReadLine's redraw).
   *
   * The gate therefore does not require the echo to start at the first byte: it hunts for the
   * echo text while discarding known noise (prompt lines, blank lines, ANSI sequences,
   * backspaces; in chat mode everything up to the echo anchor because a resize redraw can
   * re-render arbitrary previous output), matches the text tolerantly (skipping the same
   * control noise, undoing backspace erasures, restarting after carriage-return redraws), and
   * after the full echo swallows only the line-accept newline plus redraw noise — any ordinary
   * byte opens the gate so real program output is never consumed. Hunting is bounded by
   * MAX_ECHO_HUNT_BYTES and by COMMAND_ECHO_TIMEOUT_MS.
   */
  private consumeCommandEcho(data: string): string | null {
    const expectation = this.echoExpectation;
    let index = 0;
    while (index < data.length) {
      const ch = data[index];

      // Line terminators: line wrapping and line acceptance.
      if (ch === "\r" || ch === "\n") { index++; continue; }
      // ANSI sequences: cursor moves, clear-line, bracket-paste markers, redraws.
      const ansi = ansiEscapeLength(data, index);
      if (ansi > 0) { index += ansi; continue; }
      // Backspace: erases the previously rendered character; undo one matched character.
      if (ch === "\b") {
        index++;
        if (this.echoMatchIndex > 0) this.echoMatchIndex--;
        continue;
      }

      if (this.echoMatchIndex === 0) {
        if (this.echoHuntDiscardAll) {
          // Chat capture resized the PTY; ConPTY re-renders the previous screen before the
          // echo. Discard everything (bounded) until the echo anchor shows up.
          if (this.echoHuntBytesRemaining <= 0) {
            this.resetEchoGate();
            return data.slice(index);
          }
          this.echoHuntBytesRemaining--;
          if (data.startsWith(">>", index)) this.continuationPromptSeen = true;
          if (ch === expectation[0]) {
            this.echoMatchIndex++;
            index++;
            continue;
          }
          index++;
          continue;
        }
        // Hunting: skip known noise, then require the echo anchor.
        if (this.echoHuntBytesRemaining <= 0) {
          this.resetEchoGate();
          return data.slice(index);
        }
        this.echoHuntBytesRemaining--;
        if (ch === " " || ch === "\t" || ch === "\u0007") { index++; continue; }
        if (this.echoHuntingPromptLine) {
          // The previous chunk ended inside a "PS ..." prompt line; skip to its newline.
          let cursor = index;
          while (cursor < data.length && data[cursor] !== "\r" && data[cursor] !== "\n") cursor++;
          if (cursor < data.length) this.echoHuntingPromptLine = false;
          index = cursor;
          continue;
        }
        if (data.startsWith(">>", index)) this.continuationPromptSeen = true;
        const promptLength = promptTextLength(data, index);
        if (promptLength === -1) {
          // "PS ..." prompt line continues in a later chunk.
          this.echoHuntingPromptLine = true;
          return null;
        }
        if (promptLength > 0) { index += promptLength; continue; }
        if (ch !== expectation[0]) {
          // Not the echo and not noise: the echo already ended or never rendered.
          this.resetEchoGate();
          return data.slice(index);
        }
        this.echoMatchIndex++;
        index++;
        continue;
      }

      // Matching the echo text. A carriage return mid-line means the shell redrew the whole
      // line from column 0.
      if (ch === "\r") { this.echoMatchIndex = 0; index++; continue; }
      if (this.echoMatchIndex >= expectation.length) break;
      if (ch !== expectation[this.echoMatchIndex]) {
        // False anchor (e.g. redraw content that coincidentally matched the prefix): resume
        // hunting from the mismatch instead of opening the gate.
        this.echoMatchIndex = 0;
        continue;
      }
      this.echoMatchIndex++;
      index++;
    }

    if (this.echoMatchIndex >= expectation.length) {
      // The full echo was consumed; swallow only the line-accept newline and trailing redraw
      // noise. Any ordinary byte is real program output and opens the gate.
      while (index < data.length) {
        const ch = data[index];
        if (ch === "\r" || ch === "\n") { index++; continue; }
        const ansi = ansiEscapeLength(data, index);
        if (ansi > 0) { index += ansi; continue; }
        if (ch === "\b") { index++; continue; }
        break;
      }
      this.resetEchoGate();
      return data.slice(index);
    }
    return null; // Still inside the echo; keep the gate closed.
  }

  private resetEchoGate(): void {
    this.echoExpectation = "";
    this.echoMatchIndex = 0;
    this.echoGateActive = false;
    this.echoHuntBytesRemaining = 0;
    this.echoHuntDiscardAll = false;
    this.echoHuntingPromptLine = false;
  }

  private armEchoTimeout(): void {
    if (this.echoTimeoutTimer) clearTimeout(this.echoTimeoutTimer);
    this.echoTimeoutTimer = setTimeout(() => {
      this.echoTimeoutTimer = undefined;
      // The echo never arrived or could not be consumed; open the gate so output flows.
      this.echoGateActive = false;
      const active = this.activeCommand;
      if (active && !active.started) active.started = true;
      // A ">>" continuation prompt rendered while the gate was closed means the shell is
      // waiting for more input (unclosed quote/here-string). Abort the buffered input now
      // so the command fails fast and honestly instead of hanging until the caller's
      // timeout_ms elapses.
      if (active && !active.finishing && this.continuationPromptSeen) this.abortCurrentInput();
    }, COMMAND_ECHO_TIMEOUT_MS);
  }

  private handleProtocolMarker(payload: string): void {
    if (payload.startsWith("S;")) {
      const sequence = Number.parseInt(payload.slice(2), 10);
      if (this.activeCommand?.sequence === sequence) this.activeCommand.started = true;
      return;
    }
    const [sequenceText, exitCodeText, cwdBase64] = payload.split(";", 3);
    const sequence = Number.parseInt(sequenceText, 10);
    const exitCode = Number.parseInt(exitCodeText, 10);
    if (!Number.isFinite(sequence) || !Number.isFinite(exitCode)) return;
    if (sequence > this.lastPromptSequence) this.lastPromptSequence = sequence;
    if (cwdBase64) {
      try {
        const cwd = Buffer.from(cwdBase64, "base64").toString("utf8");
        if (cwd) this.currentCwdValue = cwd;
      } catch {
        // Keep the last known cwd when a shell cannot encode its current path.
      }
    }

    if (!this.ready) {
      this.ready = true;
      this.readyResolver?.();
      this.readyResolver = undefined;
      this.readyRejecter = undefined;
      return;
    }

    const activeCommand = this.activeCommand;
    if (!activeCommand) return;
    if (activeCommand.finishing) return; // Ignore duplicate exit markers for the same command.
    // Sequence gate: only a prompt rendered after this command was typed may complete it.
    // Stale markers (late delivery from before the write) and prompt churn from other
    // input sources must never finish this command with somebody else's exit code.
    if (sequence <= activeCommand.seqAtStart) return;
    activeCommand.finishing = true;
    activeCommand.finishExitCode = exitCode;
    // Windows PowerShell drains a native command's stdout on an async reader thread, so its
    // last bytes can arrive after the prompt (and its exit marker) has been emitted. Keep the
    // command alive for a short flush window so that late output is still captured; the fixed
    // width of the window bounds the added latency for every command (bridge and chat alike).
    activeCommand.finishTimer = setTimeout(() => {
      this.finishCommand(activeCommand);
    }, PTY_EXIT_DATA_FLUSH_MS);
  }

  private finishCommand(command: NonNullable<typeof this.activeCommand>): void {
    this.resetEchoGate();
    if (command.finishTimer) {
      clearTimeout(command.finishTimer);
      command.finishTimer = undefined;
    }
    if (this.echoTimeoutTimer) {
      clearTimeout(this.echoTimeoutTimer);
      this.echoTimeoutTimer = undefined;
    }
    if (this.activeCommand !== command) return; // Already finished via the PTY exit path.
    this.activeCommand = undefined;
    this.restoreDisplayDimensions();
    this.continuationPromptSeen = false;
    command.onExit(command.finishExitCode ?? null, { recovered: command.recoveryInitiated === true });
  }

  private stripPromptText(text: string): string {
    // Managed shells render a fixed-shape prompt right after the exit marker:
    //   PowerShell: "PS <cwd>> "   bash/sh: "$ "
    return text
      .replace(/(^|[\r\n])PS [^\r\n]*?>/g, "$1")
      .replace(/(^|[\r\n])\$ /g, "$1");
  }

  terminateActiveProcess(): void {
    const activePty = this.activePty;
    if (!activePty) return;
    try {
      activePty.kill();
    } catch {
      // The PTY may already be gone.
    }
  }

  private disposeActivePtySubscriptions(): void {
    this.activePtyDataSubscription?.dispose();
    this.activePtyExitSubscription?.dispose();
    this.activePtyDataSubscription = undefined;
    this.activePtyExitSubscription = undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.terminateActiveProcess();
    this.activePty = undefined;
    if (this.activeCommand?.finishTimer) {
      clearTimeout(this.activeCommand.finishTimer);
      this.activeCommand.finishTimer = undefined;
    }
    if (this.echoTimeoutTimer) {
      clearTimeout(this.echoTimeoutTimer);
      this.echoTimeoutTimer = undefined;
    }
    this.resetEchoGate();
    this.continuationPromptSeen = false;
    this.activeCommand = undefined;
    this.disposeActivePtySubscriptions();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, Number(value)));
}

function stripAnsi(text: string): string {
  return text.replace(/[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~X]))/g, "");
}

/** A trailing fragment that may be the start of a multi-byte ANSI escape split across chunks. */
const PARTIAL_ANSI_SUFFIX_RE = /[\u001B\u009B](?:[\[()#;?]*[0-9;:]*)?$/;

/**
 * Length of the ANSI escape sequence starting at text[index] (0 when none). Returns the
 * remaining length when the sequence is cut off at the end of the chunk so the caller can
 * swallow the fragment instead of leaking it.
 */
function ansiEscapeLength(text: string, index: number): number {
  if (text[index] === "\u009b") {
    let cursor = index + 1;
    while (cursor < text.length && /[0-9;:?<>]/.test(text[cursor])) cursor++;
    if (cursor < text.length && text[cursor] >= "@" && text[cursor] <= "~") return cursor - index + 1;
    return text.length - index;
  }
  if (text[index] !== "\u001b") return 0;
  if (index + 1 >= text.length) return 1;
  const second = text[index + 1];
  if (second === "[") {
    let cursor = index + 2;
    while (cursor < text.length && /[0-9;:?<>]/.test(text[cursor])) cursor++;
    if (cursor < text.length && text[cursor] >= "@" && text[cursor] <= "~") return cursor - index + 1;
    return text.length - index;
  }
  if (second === "]") {
    let cursor = index + 2;
    while (cursor < text.length) {
      if (text[cursor] === "\u0007") return cursor - index + 1;
      if (text[cursor] === "\u001b" && text[cursor + 1] === "\\") return cursor - index + 2;
      cursor++;
    }
    return text.length - index;
  }
  if (second === "(" || second === ")" || second === "#") {
    return index + 2 < text.length ? 3 : text.length - index;
  }
  if ("78=>DEHMcZ".includes(second)) return 2;
  return 0;
}

/**
 * Length of a managed-shell prompt rendered at text[index]; 0 when the text is not a prompt.
 * Returns -1 when a "PS ..." prompt line continues into a later chunk (the caller keeps the
 * gate closed and marks echoHuntingPromptLine).
 */
function promptTextLength(text: string, index: number): number {
  if (text.startsWith("PS ", index)) {
    let cursor = index + 3;
    while (cursor < text.length && text[cursor] !== "\r" && text[cursor] !== "\n" && text[cursor] !== ">") cursor++;
    if (cursor < text.length && text[cursor] === ">") {
      cursor++;
      while (cursor < text.length && (text[cursor] === " " || text[cursor] === "\t")) cursor++;
      return cursor - index;
    }
    return -1;
  }
  if (text.startsWith("$ ", index)) return 2;
  if (text.startsWith(">>> ", index)) return 4; // python / ipython REPL prompt
  if (text.startsWith("... ", index)) return 4; // python REPL continuation prompt
  if (text.startsWith("> ", index)) return 2;   // node & other REPL prompts
  return 0;
}

function normalizeRelativePath(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized || ".";
}

function isInside(root: string, candidate: string): boolean {
  const rootResolved = path.resolve(root);
  const candidateResolved = path.resolve(candidate);
  const rootCmp = process.platform === "win32" ? rootResolved.toLowerCase() : rootResolved;
  const candidateCmp = process.platform === "win32" ? candidateResolved.toLowerCase() : candidateResolved;
  return candidateCmp === rootCmp || candidateCmp.startsWith(`${rootCmp}${path.sep}`);
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder is open.");
  return folder.uri.fsPath;
}

function resolveWorkspacePath(relative = "."): { root: string; absolute: string; relative: string; uri: vscode.Uri } {
  const root = workspaceRoot();
  const rel = normalizeRelativePath(relative);
  if (path.isAbsolute(rel)) throw new Error("Path must be workspace-relative.");
  const absolute = path.resolve(root, rel);
  if (!isInside(root, absolute)) throw new Error(`Path is outside the workspace: ${relative}`);
  const normalizedRelative = path.relative(root, absolute).replace(/\\/g, "/") || ".";
  return { root, absolute, relative: normalizedRelative, uri: vscode.Uri.file(absolute) };
}

/**
 * Write a multi-line command to a temp script so a single one-line command can invoke it.
 * Multi-line input typed into PSReadLine/readline is unreliable in a persistent PTY:
 * continuation-mode buffering can drop lines or append later commands to an unfinished
 * statement. The file bridge preserves the payload byte-for-byte.
 */
function writeTempScript(commandId: string, command: string): string {
  if (process.platform === "win32") {
    const scriptPath = path.join(os.tmpdir(), `shuncode-run-${commandId}.ps1`);
    // UTF-8 BOM: Windows PowerShell 5.1 decodes BOM-less files with the legacy ANSI code
    // page. The encoding prelude keeps the child PowerShell's native output UTF-8. A
    // param() block must stay the first statement, so when one is present the prelude is
    // inserted right after the (quote-aware) matching close paren; without a scannable
    // param block the payload keeps its original shape.
    const prelude = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\r\n";
    let content: string;
    const insertAt = encodingPreludeInsertIndex(command);
    if (insertAt >= 0) {
      content = `\uFEFF${command.slice(0, insertAt)}\r\n${prelude}${command.slice(insertAt)}\r\n`;
    } else if (/^\s*param\s*\(/.test(command)) {
      content = `\uFEFF${command}\r\n`;
    } else {
      content = `\uFEFF${prelude}${command}\r\n`;
    }
    // powershell.exe -File only honors an explicit `exit` (or a thrown error): a script
    // whose final statement is a failed native command would otherwise exit 0 and mask the
    // failure. Mirror bash semantics: when the final statement failed ($?), propagate
    // $LASTEXITCODE for native commands, else exit 1.
    const nativeExitGuard = "\r\nif (-not $?) { if ($LASTEXITCODE -is [int]) { exit $LASTEXITCODE } else { exit 1 } }\r\n";
    fs.writeFileSync(scriptPath, `${content}${nativeExitGuard}`, "utf8");
    return scriptPath;
  }
  const scriptPath = path.join(os.tmpdir(), `shuncode-run-${commandId}.sh`);
  fs.writeFileSync(scriptPath, `${command}\n`, { mode: 0o700 });
  return scriptPath;
}

/**
 * Char index just after the leading param(...) block (quote-aware depth scan), or -1 when
 * the command does not start with a scannable param block. PowerShell requires param() to
 * be the first statement, so an encoding prelude can only be inserted after it.
 */
function encodingPreludeInsertIndex(command: string): number {
  if (!/^\s*param\s*\(/.test(command)) return -1;
  const open = command.indexOf("(", command.indexOf("param"));
  if (open < 0) return -1;
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  for (let i = open; i < command.length; i++) {
    const ch = command[i];
    if (inSingle) {
      if (ch === "'") {
        if (command[i + 1] === "'") i++;
        else inSingle = false;
      }
      continue;
    }
    if (inDouble) {
      if (ch === '"') {
        if (command[i + 1] === '"') i++;
        else inDouble = false;
      }
      continue;
    }
    if (ch === "'") inSingle = true;
    else if (ch === '"') inDouble = true;
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Single-line invocation for a temp script. Windows runs a child PowerShell so `exit N`
 * inside the payload cannot kill the persistent managed shell; the child's exit code lands
 * in $LASTEXITCODE and is reported by the prompt marker. */
function tempScriptCommand(scriptPath: string): string {
  if (process.platform === "win32") {
    const windowsRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
    const powershell = path.join(windowsRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return `& "${powershell}" -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
  }
  const shell = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
  return `${shell} "${scriptPath}"`;
}

export class TerminalCommandManager implements TerminalCapabilityBackend {
  private readonly states = new Map<string, CommandState>();
  private readonly slots = new Map<string, TerminalSlot>();
  private nextCommandId = 1;
  private nextTerminalId = 1;
  private readonly disposables: vscode.Disposable[] = [];

  constructor() {
    // Older ShunCode builds created persistent terminals. After an Extension Host restart
    // those terminals can be restored by VS Code even though the in-memory terminal pool is
    // gone, which makes every subsequent run create another duplicate. They are no longer
    // manageable (their command ids/states were lost), so close them before creating the new
    // transient pool.
    for (const terminal of vscode.window.terminals) {
      if (MANAGED_TERMINAL_NAME.test(terminal.name)) terminal.dispose();
    }

    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        for (const [slotId, slot] of this.slots) {
          if (slot.terminal !== terminal) continue;
          slot.closed = true;
          slot.pty.terminateActiveProcess();
          slot.busyCommandId = undefined;
          this.slots.delete(slotId);
        }
        for (const state of this.states.values()) {
          if (state.terminal !== terminal || state.status !== "running") continue;
          state.status = "killed";
          state.exitCode = null;
          state.endedAt = Date.now();
          state.resolveDone();
        }
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    for (const state of this.states.values()) {
      if (state.kind !== "direct" || state.status !== "running") continue;
      try {
        state.child?.kill();
      } catch {
        // The child may already be gone.
      }
      state.status = "killed";
      state.exitCode = null;
      state.endedAt = Date.now();
      state.resolveDone();
    }
    for (const slot of this.slots.values()) {
      if (!slot.closed) slot.terminal.dispose();
    }
    this.slots.clear();
    this.states.clear();
  }

  private sameFileSystemPath(a: string, b: string): boolean {
    return this.fileSystemPathKey(a) === this.fileSystemPathKey(b);
  }

  private fileSystemPathKey(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  private currentSlotCwd(slot: TerminalSlot): string {
    return slot.pty.currentCwd || slot.initialCwd;
  }

  private disposeIdleSlot(slot: TerminalSlot): void {
    if (slot.closed || slot.busyCommandId) return;
    slot.closed = true;
    this.slots.delete(slot.id);
    slot.terminal.dispose();
  }

  /**
   * Concurrency may temporarily require several terminals for the same cwd. Once commands
   * finish, collapse the pool back to one idle terminal per cwd and keep only a small LRU set
   * overall. Running/background terminals are never pruned.
   */
  private pruneIdleTerminals(): void {
    const idle = [...this.slots.values()].filter((slot) => !slot.closed && !slot.busyCommandId);
    const byCwd = new Map<string, TerminalSlot[]>();
    for (const slot of idle) {
      const key = this.fileSystemPathKey(this.currentSlotCwd(slot));
      const group = byCwd.get(key) ?? [];
      group.push(slot);
      byCwd.set(key, group);
    }

    for (const group of byCwd.values()) {
      group.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
      for (const duplicate of group.slice(1)) this.disposeIdleSlot(duplicate);
    }

    const remaining = [...this.slots.values()]
      .filter((slot) => !slot.closed && !slot.busyCommandId)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    for (const excess of remaining.slice(MAX_IDLE_TERMINALS)) this.disposeIdleSlot(excess);
  }

  private async acquireTerminal(
    commandId: string,
    cwdInfo: { absolute: string; relative: string; uri: vscode.Uri } | undefined,
  ): Promise<{ slot: TerminalSlot; reused: boolean; effectiveCwd: string }> {
    const candidates = [...this.slots.values()]
      .filter((slot) => !slot.closed && !slot.busyCommandId)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    for (const slot of candidates) {
      if (slot.closed || slot.busyCommandId) continue;
      if (cwdInfo && !this.sameFileSystemPath(this.currentSlotCwd(slot), cwdInfo.absolute)) continue;
      slot.busyCommandId = commandId;
      slot.lastUsedAt = Date.now();
      slot.terminal.show(true);
      return { slot, reused: true, effectiveCwd: this.currentSlotCwd(slot) };
    }

    const initialCwd = cwdInfo?.absolute ?? resolveWorkspacePath(".").absolute;
    const terminalNumber = this.nextTerminalId++;
    const pty = new ManagedCommandPseudoterminal(initialCwd);
    const terminal = vscode.window.createTerminal({
      name: `ShunCode · ${terminalNumber}`,
      pty,
      iconPath: new vscode.ThemeIcon("shield"),
      color: new vscode.ThemeColor("terminal.ansiBlue"),
      // Agent terminals are implementation detail of the current Extension Host session.
      // Persisting/restoring them creates orphan duplicates because command state is in memory.
      isTransient: true,
    });
    const slot: TerminalSlot = {
      id: `terminal_${terminalNumber}`,
      terminal,
      pty,
      initialCwd,
      busyCommandId: commandId,
      closed: false,
      lastUsedAt: Date.now(),
    };
    this.slots.set(slot.id, slot);
    try {
      terminal.show(true);
      await pty.ensureStarted();
      return { slot, reused: false, effectiveCwd: this.currentSlotCwd(slot) };
    } catch (error) {
      slot.closed = true;
      slot.busyCommandId = undefined;
      this.slots.delete(slot.id);
      terminal.dispose();
      throw error;
    }
  }

  private displayCwd(absolute: string): string {
    const root = workspaceRoot();
    if (!isInside(root, absolute)) return absolute;
    return path.relative(root, absolute).replace(/\\/g, "/") || ".";
  }

  private appendOutput(state: CommandState, text: string): void {
    // stripAnsi() is per-chunk; hold back an escape fragment that is cut off at the chunk
    // boundary so split CSI/OSC sequences (e.g. "\x1b[?25" + "l") never leak stray bytes.
    const previousPending = state.ansiPending;
    let clean = stripAnsi(previousPending + text);
    const pending = clean.match(PARTIAL_ANSI_SUFFIX_RE);
    if (pending) {
      state.ansiPending = pending[0];
      clean = clean.slice(0, clean.length - pending[0].length);
    } else {
      state.ansiPending = "";
      if (previousPending && clean.startsWith(previousPending)) {
        // The held-back fragment never completed into a real escape; drop it.
        clean = clean.slice(previousPending.length);
      }
    }
    // Backspace redraw fragments that leak past the echo gate: erase the character before
    // each backspace, mirroring the terminal's delete semantics.
    clean = clean.replace(/.?\u0008/g, "");
    if (state.output.length === 0) {
      // Defense in depth: strip a stale prompt or leading blank lines that leaked past the
      // gate before the first real byte of captured output.
      clean = clean.replace(/^(?:\r?\n|[ \t])*/, "")
        .replace(/^PS [^\r\n]*> ?/, "")
        .replace(/^\$ /, "")
        .replace(/^(?:\r?\n|[ \t])*/, "");
    }
    if (!clean) return;
    const bytes = Buffer.from(clean, "utf8");
    state.totalOutputBytes += bytes.length;
    state.output = Buffer.concat([state.output, bytes]);
    if (state.output.length > MAX_CAPTURED_OUTPUT_BYTES) {
      state.output = state.output.subarray(state.output.length - MAX_CAPTURED_OUTPUT_BYTES);
    }
    state.outputStartOffset = state.totalOutputBytes - state.output.length;
  }

  private finishState(state: CommandState, exitCode: number | null, status?: CommandState["status"], meta?: { recovered?: boolean }): void {
    if (state.status !== "running") return;
    let finalStatus = status ?? (exitCode === 0 ? "completed" : "failed");
    // A "completed, exit 0" result whose captured output contains a ParserError category is
    // a false success: a parse error runs no pipeline, so $? keeps its previous value and
    // the prompt marker reports the stale 0. Report it as a failure without an exit code.
    const parserEvidence = /\+\s*CategoryInfo\s*:[^\r\n]*ParserError/i.test(state.output.toString("utf8"));
    state.suspectedParserError = finalStatus === "completed" && exitCode === 0 && parserEvidence;
    if (state.suspectedParserError) {
      finalStatus = "failed";
      exitCode = null;
    }
    state.recoveredByAbort = meta?.recovered === true;
    state.exitCode = exitCode;
    state.status = finalStatus;
    state.endedAt = Date.now();
    if (state.slot) {
      state.slot.lastUsedAt = state.endedAt;
      if (state.slot.busyCommandId === state.id) state.slot.busyCommandId = undefined;
    }
    const tempScript = state.tempScriptPath;
    if (tempScript) {
      state.tempScriptPath = undefined;
      fs.unlink(tempScript, () => {});
    }
    state.resolveDone();
    this.pruneIdleTerminals();
  }

  private readOutput(state: CommandState, requestedOffset = 0, maxBytes = DEFAULT_OUTPUT_BYTES): Record<string, unknown> {
    const limit = Math.min(MAX_OUTPUT_BYTES, Math.max(1, maxBytes));
    const outputLost = requestedOffset < state.outputStartOffset;
    const actualOffset = Math.max(state.outputStartOffset, Math.min(requestedOffset, state.totalOutputBytes));
    const localStart = actualOffset - state.outputStartOffset;
    const available = state.output.subarray(localStart);
    const slice = available.subarray(0, limit);
    const nextOffset = actualOffset + slice.length;
    return {
      command_id: state.id,
      terminal_id: state.terminalId,
      execution: state.kind,
      terminal_name: state.terminalName,
      terminal_reused: state.terminalReused,
      status: state.status,
      exit_code: state.exitCode,
      cwd: state.cwd,
      background: state.background,
      duration_ms: (state.endedAt ?? Date.now()) - state.startedAt,
      output: slice.toString("utf8"),
      output_start_offset: actualOffset,
      next_offset: nextOffset,
      total_output_bytes: state.totalOutputBytes,
      output_lost: outputLost,
      has_more: nextOffset < state.totalOutputBytes,
    };
  }

  async run(input: Record<string, unknown>): Promise<string> {
    const command = asString(input.command).trim();
    if (!command) throw new Error("command must be a non-empty string");
    const background = asBoolean(input.background, false);
    if (typeof input.background !== "boolean") throw new Error("background must be explicitly true or false");
    const timeoutMs = asInteger(input.timeout_ms, 120_000, 1_000, 120_000);
    const cwdInfo = typeof input.cwd === "string" && input.cwd.trim()
      ? resolveWorkspacePath(input.cwd)
      : undefined;
    const execution = asString(input.execution, "pty");
    if (execution !== "pty" && execution !== "direct") {
      throw new Error(`execution must be "pty" or "direct".`);
    }
    if (execution === "direct") {
      if (background) {
        throw new Error(`execution="direct" does not support background=true; use the default PTY mode for long-running or user-visible commands.`);
      }
      return this.runDirect(command, cwdInfo, timeoutMs);
    }
    const id = `cmd_${Date.now()}_${this.nextCommandId++}`;
    // Never type risky commands into the readline layer: multi-line input hits
    // continuation-mode buffering (dropped lines, later commands appended to an unfinished
    // statement), long single lines are provably lossy when PSReadLine consumes a fast
    // ConPTY paste (whole payloads silently vanish), and non-ASCII input (CJK, emoji) can
    // be mangled by the console code page. Bridge all of them through a temp script that a
    // single ASCII one-line command executes instead.
    let execCommand = command;
    let tempScriptPath: string | undefined;
    if (/\r|\n/.test(command) || /[^\x00-\x7F]/.test(command) || command.length > 1024) {
      tempScriptPath = writeTempScript(id, command);
      execCommand = tempScriptCommand(tempScriptPath);
    }
    const { slot, reused, effectiveCwd } = await this.acquireTerminal(id, cwdInfo);
    const displayCwd = cwdInfo?.relative ?? this.displayCwd(effectiveCwd);
    const terminal = slot.terminal;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const state: CommandState = {
      id,
      kind: "pty",
      terminal,
      terminalName: terminal.name,
      terminalId: slot.id,
      terminalReused: reused,
      slot,
      command,
      cwd: displayCwd,
      startedAt: Date.now(),
      background,
      status: "running",
      exitCode: null,
      output: Buffer.alloc(0),
      outputStartOffset: 0,
      totalOutputBytes: 0,
      ansiPending: "",
      tempScriptPath,
      done,
      resolveDone,
    };
    this.states.set(id, state);
    try {
      const captureColumns = asBoolean(input[CHAT_CAPTURE_INPUT_KEY], false) && !background
        ? CHAT_CAPTURE_COLUMNS
        : undefined;
      await slot.pty.run(execCommand, {
        onOutput: (text) => this.appendOutput(state, text),
        onExit: (code, meta) => this.finishState(state, meta?.recovered ? null : code, meta?.recovered ? "failed" : undefined, meta),
      }, captureColumns);
    } catch (error) {
      this.finishState(state, null, "failed");
      throw error;
    }

    if (!background) {
      const finishedInTime = await Promise.race([
        done.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
      ]);
      if (!finishedInTime && state.status === "running") {
        // The shell never emitted the completion prompt for this command. Abort only when
        // there is continuation-state evidence (a ">>" prompt was rendered or is visible in
        // the captured output); otherwise the command may still be legitimately running and
        // must not be interrupted.
        const stuckEvidence = slot.pty.hasContinuationHint || /(^|[\r\n])>> ?/.test(state.output.toString("utf8"));
        if (stuckEvidence) {
          for (let attempt = 0; attempt < 2 && state.status === "running"; attempt++) {
            slot.pty.abortCurrentInput();
            await Promise.race([
              done.then(() => true),
              new Promise<false>((resolve) => setTimeout(() => resolve(false), 2_500)),
            ]);
          }
          if (state.status === "running") {
            // Quarantine: the shell is beyond in-band recovery; destroy the slot so it can
            // never be reused in a poisoned state. The terminal close marks the state killed.
            slot.closed = true;
            this.slots.delete(slot.id);
            slot.terminal.dispose();
            await Promise.race([
              done.then(() => true),
              new Promise<false>((resolve) => setTimeout(() => resolve(false), 1_500)),
            ]);
          }
        }
      }
    } else {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const snapshot = this.readOutput(state, 0, 64 * 1024);
    return [
      "=== RUN_COMMAND BEGIN ===",
      `command_id: ${id}`,
      `terminal_id: ${state.terminalId}`,
      `terminal_name: ${JSON.stringify(state.terminalName)}`,
      `execution: ${state.kind}`,
      `terminal_reused: ${reused}`,
      `command: ${JSON.stringify(command)}`,
      `status: ${snapshot.status}`,
      `exit_code: ${snapshot.exit_code ?? "null"}`,
      `cwd: ${JSON.stringify(displayCwd)}`,
      `background: ${background}`,
      `script_bridge: ${tempScriptPath ? JSON.stringify(tempScriptPath) : "null"}`,
      `shell_prompt_seq: ${slot.pty.lastSeenPromptSequence}`,
      `recovered_by_abort: ${state.recoveredByAbort === true}`,
      `suspected_parser_error: ${state.suspectedParserError === true}`,
      `hint: ${snapshot.status === "running" ? "still running; poll with get_command_output using next_offset" : "none"}`,
      `duration_ms: ${snapshot.duration_ms}`,
      `next_offset: ${snapshot.next_offset}`,
      `total_output_bytes: ${snapshot.total_output_bytes}`,
      `output_lost: ${snapshot.output_lost}`,
      "--- OUTPUT BEGIN ---",
      String(snapshot.output ?? ""),
      "--- OUTPUT END ---",
      "=== RUN_COMMAND END ===",
    ].join("\n");
  }

  /**
   * Execution mode "direct": run the command through a one-shot child process with piped
   * stdio instead of the persistent PTY. The exit code comes straight from the child
   * process, so it is trustworthy by construction: no prompt protocol, no echo gate, no
   * continuation state, no terminal slot consumed, and nothing appears in a terminal view.
   * stdin is closed, so interactive programs cannot be served here. On timeout the child
   * keeps running and the command stays pollable via get_command_output, mirroring PTY
   * semantics.
   */
  private async runDirect(
    command: string,
    cwdInfo: { absolute: string; relative: string; uri: vscode.Uri } | undefined,
    timeoutMs: number,
  ): Promise<string> {
    const id = `cmd_${Date.now()}_${this.nextCommandId++}`;
    let file: string;
    let args: string[];
    let tempScriptPath: string | undefined;
    if (process.platform === "win32") {
      // Always bridge through a temp script: it carries a UTF-8 BOM (correct non-ASCII
      // decoding on PowerShell 5.1), sets UTF-8 output encoding, and removes every quoting
      // pitfall a -Command one-liner would have.
      tempScriptPath = writeTempScript(id, command);
      file = path.join(process.env.SystemRoot || process.env.WINDIR || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      args = ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", tempScriptPath];
    } else {
      file = fs.existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
      args = ["-c", command];
    }
    const cwd = cwdInfo?.absolute ?? resolveWorkspacePath(".").absolute;
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const state: CommandState = {
      id,
      kind: "direct",
      terminal: null,
      terminalId: "direct",
      terminalName: "direct",
      terminalReused: false,
      command,
      cwd: cwdInfo?.relative ?? this.displayCwd(cwd),
      startedAt: Date.now(),
      background: false,
      status: "running",
      exitCode: null,
      output: Buffer.alloc(0),
      outputStartOffset: 0,
      totalOutputBytes: 0,
      ansiPending: "",
      tempScriptPath,
      done,
      resolveDone,
    };
    this.states.set(id, state);
    try {
      const child = child_process.spawn(file, args, {
        cwd,
        env: managedProcessEnvironment(),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      state.child = child;
      const outDecoder = new StringDecoder("utf8");
      const errDecoder = new StringDecoder("utf8");
      child.stdout?.on("data", (chunk: Buffer) => this.appendOutput(state, outDecoder.write(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => this.appendOutput(state, errDecoder.write(chunk)));
      child.on("error", (error: Error) => {
        this.appendOutput(state, `[shuncode] failed to start the direct command: ${error.message}\n`);
      });
      child.on("close", (rawCode) => {
        // PowerShell reports negative exits (exit -1) as an unsigned 32-bit value through
        // the process handle; normalize back into signed range for callers.
        let code = typeof rawCode === "number" ? rawCode : null;
        if (code !== null && code > 0x7fffffff) code -= 0x100000000;
        const outRest = outDecoder.end();
        if (outRest) this.appendOutput(state, outRest);
        const errRest = errDecoder.end();
        if (errRest) this.appendOutput(state, errRest);
        this.finishState(state, typeof code === "number" ? code : null);
      });
    } catch (error) {
      this.finishState(state, null, "failed");
      throw error;
    }

    await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
    const snapshot = this.readOutput(state, 0, 64 * 1024);
    return [
      "=== RUN_COMMAND BEGIN ===",
      `command_id: ${id}`,
      `terminal_id: ${state.terminalId}`,
      `terminal_name: ${JSON.stringify(state.terminalName)}`,
      `terminal_reused: false`,
      `command: ${JSON.stringify(command)}`,
      `execution: direct`,
      `status: ${snapshot.status}`,
      `exit_code: ${snapshot.exit_code ?? "null"}`,
      `cwd: ${JSON.stringify(state.cwd)}`,
      `background: false`,
      `script_bridge: ${tempScriptPath ? JSON.stringify(tempScriptPath) : "null"}`,
      `shell_prompt_seq: null`,
      `recovered_by_abort: ${state.recoveredByAbort === true}`,
      `suspected_parser_error: ${state.suspectedParserError === true}`,
      `hint: ${snapshot.status === "running" ? "still running; poll with get_command_output using next_offset" : "none"}`,
      `duration_ms: ${snapshot.duration_ms}`,
      `next_offset: ${snapshot.next_offset}`,
      `total_output_bytes: ${snapshot.total_output_bytes}`,
      `output_lost: ${snapshot.output_lost}`,
      "--- OUTPUT BEGIN ---",
      String(snapshot.output ?? ""),
      "--- OUTPUT END ---",
      "=== RUN_COMMAND END ===",
    ].join("\n");
  }

  getOutput(input: Record<string, unknown>): string {
    const id = asString(input.command_id);
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown command_id: ${id}`);
    const offset = asInteger(input.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const maxBytes = asInteger(input.max_bytes, DEFAULT_OUTPUT_BYTES, 1, MAX_OUTPUT_BYTES);
    const snapshot = this.readOutput(state, offset, maxBytes);
    return [
      "=== COMMAND_OUTPUT BEGIN ===",
      `command_id: ${id}`,
      `execution: ${String(snapshot.execution)}`,
      `terminal_id: ${snapshot.terminal_id}`,
      `terminal_name: ${JSON.stringify(snapshot.terminal_name)}`,
      `status: ${snapshot.status}`,
      `exit_code: ${snapshot.exit_code ?? "null"}`,
      `recovered_by_abort: ${state.recoveredByAbort === true}`,
      `suspected_parser_error: ${state.suspectedParserError === true}`,
      `duration_ms: ${snapshot.duration_ms}`,
      `output_start_offset: ${snapshot.output_start_offset}`,
      `next_offset: ${snapshot.next_offset}`,
      `total_output_bytes: ${snapshot.total_output_bytes}`,
      `output_lost: ${snapshot.output_lost}`,
      `has_more: ${snapshot.has_more}`,
      "--- OUTPUT BEGIN ---",
      String(snapshot.output ?? ""),
      "--- OUTPUT END ---",
      "=== COMMAND_OUTPUT END ===",
    ].join("\n");
  }

  sendInput(input: Record<string, unknown>): string {
    const id = asString(input.command_id);
    const state = this.states.get(id);
    if (!state) throw new Error(`Unknown command_id: ${id}`);
    if (state.status !== "running") throw new Error(`Command ${id} is not running (status=${state.status}).`);
    if (state.kind === "direct") {
      throw new Error(`Command ${id} runs in direct mode without a terminal; interactive input requires the default PTY execution mode.`);
    }
    const text = asString(input.input);
    const appendNewline = asBoolean(input.append_newline, true);
    state.slot?.pty.sendInput(text, appendNewline);
    return [
      "=== SEND_COMMAND_INPUT BEGIN ===",
      `command_id: ${id}`,
      `terminal_id: ${state.terminalId}`,
      `status: ${state.status}`,
      `bytes_sent: ${Buffer.byteLength(text, "utf8")}`,
      `append_newline: ${appendNewline}`,
      "=== SEND_COMMAND_INPUT END ===",
    ].join("\n");
  }

  revealTerminal(terminalId: string): boolean {
    const slot = this.slots.get(terminalId);
    if (!slot || slot.closed) return false;
    slot.terminal.show(false);
    return true;
  }
}
