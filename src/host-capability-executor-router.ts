import type { CapabilityMetadata } from "./capability-registry.js";
import type {
  HostCapabilityExecutionRequest,
  HostCapabilityExecutor,
  HostCapabilityExecutorResult,
} from "./host-capability-execution-coordinator.js";

export interface RoutableHostCapabilityExecutor extends HostCapabilityExecutor {
  supports(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): boolean;
}

/** Select exactly one provider executor for a host-owned capability. */
export class HostCapabilityExecutorRouter implements HostCapabilityExecutor {
  constructor(private readonly executors: readonly RoutableHostCapabilityExecutor[]) {}

  async execute(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): Promise<HostCapabilityExecutorResult> {
    const matches = this.executors.filter(executor => executor.supports(request, capability));
    if (matches.length === 0) {
      throw new Error(`No host capability executor owns ${request.name} (${capability.id}, environment=${capability.environment}).`);
    }
    if (matches.length > 1) {
      throw new Error(`Multiple host capability executors claim ${request.name}; routing must be unambiguous.`);
    }
    return matches[0].execute(request, capability);
  }
}
