import type { CapabilityMetadata } from "../../../src/capability-registry.js";
import type {
  HostCapabilityExecutionRequest,
  HostCapabilityExecutorResult,
} from "../../../src/host-capability-execution-coordinator.js";
import type { RoutableHostCapabilityExecutor } from "../../../src/host-capability-executor-router.js";
import { getIdeToolDefinition } from "../../../src/ide-tool-definitions.js";

export interface DirectIdeToolBroker {
  invokeDirect(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Host executor backed by the same IdeToolBroker providers used by Chat/Bridge. */
export class IdeToolBrokerHostCapabilityExecutor implements RoutableHostCapabilityExecutor {
  constructor(private readonly broker: DirectIdeToolBroker) {}

  supports(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): boolean {
    return capability.environment === "extension-host" && !!getIdeToolDefinition(request.name);
  }

  async execute(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): Promise<HostCapabilityExecutorResult> {
    if (!this.supports(request, capability)) throw new Error(`Capability ${request.name} is not owned by IdeToolBroker.`);
    return await this.broker.invokeDirect(request.name, asRecord(request.arguments));
  }
}
