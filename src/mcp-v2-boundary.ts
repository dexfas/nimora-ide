import { specTypeSchemas } from "@modelcontextprotocol/server";

/** Preserve canonical definitions while validating the neutral v2 boundary. */
export function modernMcpTool(value: unknown) {
  const result = specTypeSchemas.Tool['~standard'].validate(value);
  if (result.issues) throw new Error("Canonical tool definition does not satisfy the modern MCP Tool contract.");
  return result.value;
}
export function modernMcpToolResult(value: unknown) {
  const result = specTypeSchemas.CallToolResult['~standard'].validate(value);
  if (result.issues) throw new Error("Canonical tool result does not satisfy the modern MCP CallToolResult contract.");
  return result.value;
}
