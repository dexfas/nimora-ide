import type { CapabilityMetadata } from "./capability-registry.js";
import { invokeFileTool, isFileToolName } from "./file-tool-registry.js";
import {
  assertHostCapabilityExecutionAdmission,
  type HostCapabilityExecutionAdmission,
  type HostCapabilityExecutionRequest,
  type HostCapabilityExecutorResult,
} from "./host-capability-execution-coordinator.js";
import type { RoutableHostCapabilityExecutor } from "./host-capability-executor-router.js";
import { isTaskInputAbsolutePathAllowed } from "./task-input-access-policy.js";
import type { TaskRuntime } from "./task-runtime.js";

export interface FileHostCapabilityExecutorOptions {
  workspaceRoots: () => readonly string[];
  tasks?: TaskRuntime;
}

/** Reuses the canonical Runtime/file provider implementation for host-owned calls. */
export class FileToolHostCapabilityExecutor implements RoutableHostCapabilityExecutor {
  constructor(private readonly options: FileHostCapabilityExecutorOptions) {}

  supports(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): boolean {
    return capability.environment === "runtime" && isFileToolName(request.name);
  }

  async execute(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata, admission?: HostCapabilityExecutionAdmission): Promise<HostCapabilityExecutorResult> {
    if (!this.supports(request, capability)) {
      throw new Error(`Capability ${request.name} is not owned by the Runtime/file provider.`);
    }
    const workspaceRoots = [...this.options.workspaceRoots()].filter(Boolean);
    if (workspaceRoots.length === 0) throw new Error(`Capability ${request.name} requires an open workspace root.`);
    assertHostCapabilityExecutionAdmission(admission);
    const checkPermission = this.options.tasks
      ? (absolutePath: string) => isTaskInputAbsolutePathAllowed(this.options.tasks!, request, absolutePath, workspaceRoots)
      : undefined;
    const result = await invokeFileTool(request.name, request.arguments, {
      workspaceRoots,
      signal: admission?.signal,
      checkPermission,
    });
    // read_files supports partial results; a failed item is still a tool failure.
    // Keep every successful/failed item, but do not let a web turn continue blindly.
    const readResult = request.name === "read_files" ? result.structuredContent as { summary: { failed: number; skipped: number } } : undefined;
    return { text: result.text, isError: !!readResult && (readResult.summary.failed > 0 || readResult.summary.skipped > 0), data: result.structuredContent };
  }
}
