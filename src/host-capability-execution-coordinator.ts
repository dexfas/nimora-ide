import { getCapabilityMetadata, type CapabilityMetadata } from "./capability-registry.js";
import { taskArgumentsDigest } from "./task-runtime.js";
import type { WorkerCapabilityResultInput } from "./worker-contract.js";

export interface HostCapabilityExecutionRequest {
  executionId: string;
  managedSessionId: string;
  workerId: string;
  taskId?: string;
  inputId: string;
  callId: string;
  name: string;
  arguments?: unknown;
}

export interface HostCapabilityExecutorResult {
  text?: string;
  isError?: boolean;
  data?: unknown;
}

export interface HostCapabilityExecutor {
  execute(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): Promise<HostCapabilityExecutorResult>;
}

export interface HostCapabilityAuthorizer {
  authorize(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): Promise<void>;
}

export interface HostCapabilityResultSink {
  submitCapabilityResult(managedSessionId: string, result: WorkerCapabilityResultInput): Promise<void>;
}

export interface HostCapabilityExecutionCoordinatorOptions {
  executor: HostCapabilityExecutor;
  authorizer: HostCapabilityAuthorizer;
  now?: () => number;
}

export interface HostCapabilityExecutionState {
  executionId: string;
  phase: "authorizing" | "executing" | "executed" | "delivered";
  deliveryAttempts: number;
  result?: WorkerCapabilityResultInput;
}

interface ExecutionRecord {
  identityDigest: string;
  phase: HostCapabilityExecutionState["phase"];
  executionPromise?: Promise<WorkerCapabilityResultInput>;
  deliveryPromise?: Promise<void>;
  deliveryAttempts: number;
  result?: WorkerCapabilityResultInput;
}

/**
 * Opt-in coordination primitive for future host-managed Worker capability calls.
 *
 * This class deliberately does not subscribe to Worker events and is not wired
 * into production dispatch by default. It separates execute-once state from
 * result-delivery state so callers may retry result delivery without repeating
 * a side effect. Durable crash recovery remains the responsibility of the Task
 * Execution Service before this can become the production execution owner.
 */
export class HostCapabilityExecutionCoordinator {
  private readonly records = new Map<string, ExecutionRecord>();
  private readonly now: () => number;

  constructor(private readonly options: HostCapabilityExecutionCoordinatorOptions) {
    this.now = options.now ?? Date.now;
  }

  async executeOnce(request: HostCapabilityExecutionRequest): Promise<WorkerCapabilityResultInput> {
    this.validateRequest(request);
    const capability = getCapabilityMetadata(request.name);
    if (!capability) throw new Error(`Host-managed execution requires registered capability metadata: ${request.name}`);
    const identityDigest = this.identityDigest(request);
    const existing = this.records.get(request.executionId);
    if (existing) {
      if (existing.identityDigest !== identityDigest) throw new Error(`Execution identity mismatch for ${request.executionId}.`);
      if (existing.result) return structuredClone(existing.result);
      if (existing.executionPromise) return structuredClone(await existing.executionPromise);
      throw new Error(`Execution ${request.executionId} is in an invalid coordinator state.`);
    }

    const record: ExecutionRecord = {
      identityDigest,
      phase: "authorizing",
      deliveryAttempts: 0,
    };
    this.records.set(request.executionId, record);
    record.executionPromise = this.authorizeAndExecute(request, capability, record);
    try {
      const result = await record.executionPromise;
      record.result = result;
      record.executionPromise = undefined;
      record.phase = "executed";
      return structuredClone(result);
    } catch (error) {
      if (this.records.get(request.executionId) === record && record.phase === "authorizing") {
        this.records.delete(request.executionId);
      }
      throw error;
    }
  }

  async deliverResult(request: HostCapabilityExecutionRequest, sink: HostCapabilityResultSink): Promise<WorkerCapabilityResultInput> {
    const result = await this.executeOnce(request);
    const record = this.requireRecord(request.executionId);
    if (record.phase === "delivered") return result;
    if (record.deliveryPromise) {
      await record.deliveryPromise;
      return structuredClone(this.requireRecord(request.executionId).result!);
    }

    record.deliveryAttempts += 1;
    record.deliveryPromise = sink.submitCapabilityResult(request.managedSessionId, result);
    try {
      await record.deliveryPromise;
      record.phase = "delivered";
      return structuredClone(result);
    } finally {
      record.deliveryPromise = undefined;
    }
  }

  async executeAndDeliver(request: HostCapabilityExecutionRequest, sink: HostCapabilityResultSink): Promise<WorkerCapabilityResultInput> {
    return this.deliverResult(request, sink);
  }

  getState(executionId: string): HostCapabilityExecutionState | undefined {
    const record = this.records.get(executionId);
    if (!record) return undefined;
    return {
      executionId,
      phase: record.phase,
      deliveryAttempts: record.deliveryAttempts,
      result: record.result ? structuredClone(record.result) : undefined,
    };
  }

  private async authorizeAndExecute(
    request: HostCapabilityExecutionRequest,
    capability: CapabilityMetadata,
    record: ExecutionRecord,
  ): Promise<WorkerCapabilityResultInput> {
    await this.options.authorizer.authorize(request, capability);
    record.phase = "executing";
    const startedAt = this.now();
    try {
      const executed = await this.options.executor.execute(request, capability);
      return {
        inputId: request.inputId,
        callId: request.callId,
        name: request.name,
        text: executed.text,
        isError: executed.isError === true,
        durationMs: Math.max(0, this.now() - startedAt),
        data: executed.data,
      };
    } catch (error) {
      return {
        inputId: request.inputId,
        callId: request.callId,
        name: request.name,
        text: `Host capability executor failed: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
        durationMs: Math.max(0, this.now() - startedAt),
      };
    }
  }

  private validateRequest(request: HostCapabilityExecutionRequest): void {
    if (!request.executionId) throw new Error("Host-managed capability execution requires executionId.");
    if (!request.managedSessionId) throw new Error("Host-managed capability execution requires managedSessionId.");
    if (!request.workerId) throw new Error("Host-managed capability execution requires workerId.");
    if (!request.inputId) throw new Error("Host-managed capability execution requires inputId.");
    if (!request.callId) throw new Error("Host-managed capability execution requires callId.");
    if (!request.name) throw new Error("Host-managed capability execution requires capability name.");
  }

  private identityDigest(request: HostCapabilityExecutionRequest): string {
    return taskArgumentsDigest({
      managedSessionId: request.managedSessionId,
      workerId: request.workerId,
      taskId: request.taskId,
      inputId: request.inputId,
      callId: request.callId,
      name: request.name,
      arguments: request.arguments,
    });
  }

  private requireRecord(executionId: string): ExecutionRecord {
    const record = this.records.get(executionId);
    if (!record) throw new Error(`Unknown host capability execution: ${executionId}`);
    return record;
  }
}
