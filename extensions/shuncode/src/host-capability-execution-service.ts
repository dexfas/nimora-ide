import type { HostCapabilityGrantResolver } from "../../../src/host-capability-policy-authorizer.js";
import { CapabilityMetadataHostAuthorizer } from "../../../src/host-capability-policy-authorizer.js";
import {
  HostCapabilityExecutionCoordinator,
  type HostCapabilityExecutionRequest,
  type HostCapabilityResultSink,
} from "../../../src/host-capability-execution-coordinator.js";
import { TaskHostCapabilityExecutionStore } from "../../../src/task-host-capability-execution-store.js";
import type { TaskRuntime } from "../../../src/task-runtime.js";
import type { IdeToolBroker } from "./ide-tool-broker.js";
import { IdeToolBrokerHostCapabilityExecutor } from "./ide-host-capability-executor.js";

/**
 * Dormant composition root for future host-managed Worker execution.
 * Construction alone never subscribes to Worker events or dispatches tools.
 */
export class HostCapabilityExecutionService {
  private readonly coordinator: HostCapabilityExecutionCoordinator;

  constructor(tasks: TaskRuntime, broker: IdeToolBroker, grants?: HostCapabilityGrantResolver) {
    this.coordinator = new HostCapabilityExecutionCoordinator({
      durableStore: new TaskHostCapabilityExecutionStore(tasks),
      authorizer: new CapabilityMetadataHostAuthorizer(grants),
      executor: new IdeToolBrokerHostCapabilityExecutor(broker),
    });
  }

  executeOnce(request: HostCapabilityExecutionRequest) {
    return this.coordinator.executeOnce(request);
  }

  executeAndDeliver(request: HostCapabilityExecutionRequest, sink: HostCapabilityResultSink) {
    return this.coordinator.executeAndDeliver(request, sink);
  }

  getState(executionId: string) {
    return this.coordinator.getState(executionId);
  }
}
