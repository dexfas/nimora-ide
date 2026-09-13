import type { CapabilityMetadata } from "./capability-registry.js";
import type { HostCapabilityExecutionRequest } from "./host-capability-execution-coordinator.js";
import type { HostCapabilityGrantResolver } from "./host-capability-policy-authorizer.js";
import { TaskCapabilityGrantResolver } from "./task-capability-grant-resolver.js";
import type { TaskCapabilityGrantScope } from "./task-contract.js";
import type { TaskRuntime } from "./task-runtime.js";

export interface CapabilityGrantPromptRequest {
  request: HostCapabilityExecutionRequest;
  capability: CapabilityMetadata;
  scope: TaskCapabilityGrantScope;
}

export interface CapabilityGrantPrompt {
  requestGrant(input: CapabilityGrantPromptRequest): Promise<boolean>;
}

/**
 * Interactive wrapper around the durable resolver. The prompt is only reached
 * when no matching durable grant exists; approval is not effective until the
 * strict TaskRuntime grant append succeeds.
 */
export class PromptingTaskCapabilityGrantResolver implements HostCapabilityGrantResolver {
  private readonly durable: TaskCapabilityGrantResolver;
  private readonly pending = new Map<string, Promise<boolean>>();

  constructor(
    private readonly tasks: TaskRuntime,
    private readonly prompt: CapabilityGrantPrompt,
  ) {
    this.durable = new TaskCapabilityGrantResolver(tasks);
  }

  async isGranted(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): Promise<boolean> {
    if (await this.durable.isGranted(request, capability)) return true;
    if (!request.taskId) return false;

    const scope = this.scopeFor(capability);
    if (!scope) return false;
    const key = [request.taskId, scope, scope === "worker-session" ? request.managedSessionId : "", capability.id, capability.version].join("\u0000");
    const existing = this.pending.get(key);
    if (existing) return existing;

    const pending = (async () => {
      if (await this.durable.isGranted(request, capability)) return true;
      const approved = await this.prompt.requestGrant({ request, capability, scope });
      if (!approved) return false;
      await this.tasks.grantCapabilityStrict(request.taskId!, {
        capabilityId: capability.id,
        capabilityVersion: capability.version,
        scope,
        managedSessionId: scope === "worker-session" ? request.managedSessionId : undefined,
      });
      return await this.durable.isGranted(request, capability);
    })();
    this.pending.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    }
  }

  private scopeFor(capability: CapabilityMetadata): TaskCapabilityGrantScope | undefined {
    if (capability.approval === "session") return "worker-session";
    if (capability.approval === "task-grant") return "task";
    return undefined;
  }
}
