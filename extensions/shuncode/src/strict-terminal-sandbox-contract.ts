export const STRICT_TERMINAL_SANDBOX_INPUT: unique symbol = Symbol("shuncode.strictTerminalSandbox");

export interface StrictTerminalSandboxInput {
  writeRoots: readonly string[];
}
