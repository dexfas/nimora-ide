import type { CapabilityMetadata } from "./capability-registry.js";
import type { HostCapabilityAuthorizer, HostCapabilityExecutionRequest } from "./host-capability-execution-coordinator.js";

export interface HostCapabilityGrantResolver {
  isGranted(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): Promise<boolean>;
}

/**
 * Metadata-driven fail-closed authorization for host-owned capability execution.
 * `approval=none` is allowed directly; stronger approval modes require an
 * explicit grant resolver owned by the caller/product surface.
 */
export class CapabilityMetadataHostAuthorizer implements HostCapabilityAuthorizer {
  constructor(private readonly grants?: HostCapabilityGrantResolver) {}

  async authorize(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): Promise<void> {
    if (capability.approval === "none") return;
    if (!this.grants) {
      throw new Error(`Capability ${request.name} requires ${capability.approval} approval; no host grant resolver is configured.`);
    }
    if (!await this.grants.isGranted(request, capability)) {
      throw new Error(`Capability ${request.name} was not granted for host execution (${capability.approval}).`);
    }
  }
}
