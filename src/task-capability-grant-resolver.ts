import type { CapabilityMetadata } from "./capability-registry.js";
import type { HostCapabilityExecutionRequest } from "./host-capability-execution-coordinator.js";
import type { HostCapabilityGrantResolver } from "./host-capability-policy-authorizer.js";
import type { TaskCapabilityGrant, TaskSnapshot } from "./task-contract.js";
import type { TaskRuntime } from "./task-runtime.js";

function matchingActiveGrant(
  task: TaskSnapshot,
  capability: CapabilityMetadata,
  predicate: (grant: TaskCapabilityGrant) => boolean,
): boolean {
  return Object.values(task.capabilityGrants).some(grant =>
    !grant.revokedAt
    && grant.capabilityId === capability.id
    && grant.capabilityVersion === capability.version
    && predicate(grant)
  );
}

/** TaskRuntime-backed task/session grants for host-owned capability execution. */
export class TaskCapabilityGrantResolver implements HostCapabilityGrantResolver {
  constructor(private readonly tasks: TaskRuntime) {}

  async isGranted(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): Promise<boolean> {
    if (!request.taskId) return false;
    await this.tasks.initialize();
    const task = this.tasks.getTask(request.taskId);
    if (!task) return false;

    if (capability.approval === "task-grant") {
      return matchingActiveGrant(task, capability, grant => grant.scope === "task");
    }
    if (capability.approval === "session") {
      const workerSession = task.workerSessions[request.managedSessionId];
      if (!workerSession || workerSession.detachedAt || workerSession.workerId !== request.workerId) return false;
      return matchingActiveGrant(task, capability, grant =>
        grant.scope === "worker-session"
        && grant.managedSessionId === request.managedSessionId
        && grant.workerSessionAttachedAt === workerSession.attachedAt
      );
    }

    // Global `always` approval needs a separate trusted store. Never widen a
    // task/session journal record into an account- or install-wide permission.
    return false;
  }
}
