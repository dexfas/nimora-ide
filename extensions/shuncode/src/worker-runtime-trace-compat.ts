import type { WorkerEvent } from "../../../src/worker-contract.js";
import type { RuntimeTraceItem } from "./runtime-client.js";

function eventStep(event: WorkerEvent): number {
  const value = "extensions" in event ? event.extensions?.step : undefined;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isRuntimeTraceItem(value: unknown): value is RuntimeTraceItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (row.type === "model" || row.type === "model_delta" || row.type === "model_thinking_delta" || row.type === "tool_call" || row.type === "tool_result")
    && typeof row.step === "number" && "data" in row;
}

/**
 * Temporary parity bridge for migrating Native Chat from RuntimeTraceItem to
 * WorkerEvent without rewriting tool cards/history/reference projection in the
 * same change. Delete once those consumers natively accept WorkerEvent.
 */
export function workerEventToRuntimeTrace(event: WorkerEvent): RuntimeTraceItem | undefined {
  switch (event.type) {
    case "text_delta":
      return { type: "model_delta", step: 0, data: { content: event.text } };
    case "reasoning_delta":
      return { type: "model_thinking_delta", step: 0, data: { content: event.text } };
    case "capability_call":
      return {
        type: "tool_call",
        step: eventStep(event),
        data: { id: event.callId, name: event.name, arguments: event.arguments },
      };
    case "capability_result":
      return {
        type: "tool_result",
        step: eventStep(event),
        data: {
          id: event.callId,
          name: event.name,
          text: event.text,
          isError: event.isError === true,
          duration_ms: event.durationMs,
        },
      };
    case "provider_event":
      return isRuntimeTraceItem(event.data) ? event.data : undefined;
    default:
      return undefined;
  }
}
