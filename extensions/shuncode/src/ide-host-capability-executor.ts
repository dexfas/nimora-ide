import type { CapabilityMetadata } from "../../../src/capability-registry.js";
import type {
  HostCapabilityExecutionRequest,
  HostCapabilityExecutor,
  HostCapabilityExecutorResult,
} from "../../../src/host-capability-execution-coordinator.js";
import { getIdeToolDefinition } from "../../../src/ide-tool-definitions.js";

export interface DirectIdeToolBroker {
  invokeDirect(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Host executor backed by the same IdeToolBroker providers used by Chat/Bridge. */
export class IdeToolBrokerHostCapabilityExecutor implements HostCapabilityExecutor {
  constructor(private readonly broker: DirectIdeToolBroker) {}

  async execute(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): Promise<HostCapabilityExecutorResult> {
    if (!getIdeToolDefinition(request.name)) throw new Error(`Capability ${request.name} is not owned by IdeToolBroker.`);
    if (capability.environment !== "extension-host") {
      throw new Error(`Capability ${request.name} is registered for ${capability.environment}, not extension-host execution.`);
    }
    return await this.broker.invokeDirect(request.name, asRecord(request.arguments));
  }
}
