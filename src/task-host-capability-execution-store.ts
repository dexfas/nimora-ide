import type { CapabilityMetadata } from "./capability-registry.js";
import type {
  HostCapabilityDurableRecovery,
  HostCapabilityExecutionDurableStore,
  HostCapabilityExecutionRequest,
} from "./host-capability-execution-coordinator.js";
import type { TaskExecution, TaskExecutionResultPayload } from "./task-contract.js";
import { TaskRuntime, taskArgumentsDigest, type BeginExecutionInput } from "./task-runtime.js";
import type { WorkerCapabilityResultInput } from "./worker-contract.js";

function taskIdFor(request: HostCapabilityExecutionRequest): string {
  if (!request.taskId) throw new Error(`Durable host execution requires taskId: ${request.executionId}`);
  return request.taskId;
}

function beginInput(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): BeginExecutionInput {
  return {
    executionId: request.executionId,
    toolName: request.name,
    capabilityId: capability.id,
    risk: capability.risk,
    arguments: request.arguments,
    origin: {
      kind: "worker",
      managedSessionId: request.managedSessionId,
      workerId: request.workerId,
      inputId: request.inputId,
      callId: request.callId,
    },
  };
}

function identityMatches(execution: TaskExecution, request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): boolean {
  const origin = execution.origin;
  return execution.toolName === request.name
    && execution.capabilityId === capability.id
    && execution.risk === capability.risk
    && execution.argumentsDigest === (request.arguments === undefined ? undefined : taskArgumentsDigest(request.arguments))
    && origin?.kind === "worker"
    && origin.managedSessionId === request.managedSessionId
    && origin.workerId === request.workerId
    && origin.inputId === request.inputId
    && origin.callId === request.callId;
}

function workerResult(payload: TaskExecutionResultPayload, request: HostCapabilityExecutionRequest): WorkerCapabilityResultInput | undefined {
  if (payload.kind !== "worker-capability") return undefined;
  if (payload.inputId !== request.inputId || payload.callId !== request.callId || payload.name !== request.name) return undefined;
  return {
    inputId: payload.inputId,
    callId: payload.callId,
    name: payload.name,
    text: payload.text,
    isError: payload.isError,
    durationMs: payload.durationMs,
  };
}

function recoveryFromExecution(execution: TaskExecution, request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): HostCapabilityDurableRecovery {
  if (!identityMatches(execution, request, capability)) throw new Error(`Execution identity mismatch for ${request.executionId}.`);
  if (execution.status === "requested" || execution.status === "executing") {
    return { state: "ambiguous", reason: `persisted status is ${execution.status}` };
  }
  const result = execution.resultPayload ? workerResult(execution.resultPayload, request) : undefined;
  if (!result) {
    return { state: "ambiguous", reason: `execution status is ${execution.status} but no matching durable worker result exists` };
  }
  return execution.deliveryStatus === "delivered"
    ? { state: "delivered", result }
    : { state: "executed", result };
}

/** Durable TaskRuntime-backed state for future host-owned Worker capability execution. */
export class TaskHostCapabilityExecutionStore implements HostCapabilityExecutionDurableStore {
  constructor(private readonly tasks: TaskRuntime) {}

  async recover(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): Promise<HostCapabilityDurableRecovery> {
    await this.tasks.initialize();
    const taskId = taskIdFor(request);
    const task = this.tasks.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    const execution = task.executions[request.executionId];
    return execution ? recoveryFromExecution(execution, request, capability) : { state: "absent" };
  }

  async claim(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): Promise<HostCapabilityDurableRecovery> {
    const claimed = await this.tasks.claimExecution(taskIdFor(request), beginInput(request, capability));
    if (!claimed.duplicate) return { state: "claimed" };
    if (!claimed.execution) throw new Error(`Durable execution disappeared after duplicate claim: ${request.executionId}`);
    return recoveryFromExecution(claimed.execution, request, capability);
  }

  async recordResult(request: HostCapabilityExecutionRequest, _capability: CapabilityMetadata, result: WorkerCapabilityResultInput): Promise<void> {
    const taskId = taskIdFor(request);
    await this.tasks.finishExecutionStrict(taskId, request.executionId, result.isError ? "failed" : "succeeded", {
      durationMs: result.durationMs,
      error: result.isError ? result.text : undefined,
      resultSummary: result.text,
    });
    await this.tasks.markResultPreparedStrict(taskId, request.executionId, {
      kind: "worker-capability",
      inputId: request.inputId,
      callId: request.callId,
      name: request.name,
      text: result.text,
      isError: result.isError === true,
      durationMs: result.durationMs,
    });
  }

  async markDelivered(request: HostCapabilityExecutionRequest, _capability: CapabilityMetadata): Promise<void> {
    await this.tasks.markDeliveredStrict(taskIdFor(request), request.executionId);
  }
}
