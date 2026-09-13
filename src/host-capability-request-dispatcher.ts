import type {
  HostCapabilityExecutionRequest,
  HostCapabilityResultSink,
} from "./host-capability-execution-coordinator.js";
import { HostCapabilityAuthorizationError } from "./host-capability-policy-authorizer.js";
import type { WorkerCapabilityResultInput } from "./worker-contract.js";

export interface HostCapabilityExecutionDelivery {
  executeAndDeliver(
    request: HostCapabilityExecutionRequest,
    sink: HostCapabilityResultSink,
  ): Promise<WorkerCapabilityResultInput>;
}

export type HostCapabilityDispatchResult =
  | { status: "executed"; result: WorkerCapabilityResultInput }
  | { status: "denied"; result: WorkerCapabilityResultInput };

/**
 * Convert an authorization denial into a normal Worker capability result so a
 * host-managed page turn can continue without claiming/executing the tool.
 * Non-authorization failures remain exceptional and are never disguised as a
 * permission decision.
 */
export async function dispatchHostCapabilityRequest(
  execution: HostCapabilityExecutionDelivery,
  request: HostCapabilityExecutionRequest,
  sink: HostCapabilityResultSink,
): Promise<HostCapabilityDispatchResult> {
  try {
    return { status: "executed", result: await execution.executeAndDeliver(request, sink) };
  } catch (error) {
    if (!(error instanceof HostCapabilityAuthorizationError)) throw error;
    const result: WorkerCapabilityResultInput = {
      inputId: request.inputId,
      callId: request.callId,
      name: request.name,
      text: `Permission was not granted for ${request.name}.`,
      isError: true,
    };
    await sink.submitCapabilityResult(request.managedSessionId, result);
    return { status: "denied", result };
  }
}
