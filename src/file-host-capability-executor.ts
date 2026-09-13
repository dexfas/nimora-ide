import type { CapabilityMetadata } from "./capability-registry.js";
import { invokeFileTool, isFileToolName } from "./file-tool-registry.js";
import type {
  HostCapabilityExecutionRequest,
  HostCapabilityExecutorResult,
} from "./host-capability-execution-coordinator.js";
import type { RoutableHostCapabilityExecutor } from "./host-capability-executor-router.js";

export interface FileHostCapabilityExecutorOptions {
  workspaceRoots: () => readonly string[];
}

/** Reuses the canonical Runtime/file provider implementation for host-owned calls. */
export class FileToolHostCapabilityExecutor implements RoutableHostCapabilityExecutor {
  constructor(private readonly options: FileHostCapabilityExecutorOptions) {}

  supports(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): boolean {
    return capability.environment === "runtime" && isFileToolName(request.name);
  }

  async execute(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): Promise<HostCapabilityExecutorResult> {
    if (!this.supports(request, capability)) {
      throw new Error(`Capability ${request.name} is not owned by the Runtime/file provider.`);
    }
    const workspaceRoots = [...this.options.workspaceRoots()].filter(Boolean);
    if (workspaceRoots.length === 0) throw new Error(`Capability ${request.name} requires an open workspace root.`);
    const result = await invokeFileTool(request.name, request.arguments, { workspaceRoots });
    return { text: result.text, isError: false, data: result.structuredContent };
  }
}
