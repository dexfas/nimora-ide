import type { CapabilityMetadata } from '../../../src/capability-registry.js';
import { assertHostCapabilityExecutionAdmission, type HostCapabilityExecutionAdmission,
  type HostCapabilityExecutionRequest, type HostCapabilityExecutorResult } from '../../../src/host-capability-execution-coordinator.js';
import type { RoutableHostCapabilityExecutor } from '../../../src/host-capability-executor-router.js';
import type { TaskRuntime } from '../../../src/task-runtime.js';
import { normalizeBridgeProgress, normalizeBridgeTodos } from './bridge-task-coordination.js';

/** Task tools advertised to Mission Workers use the same strict owner as Bridge.
 * Execution identity, permission and result delivery remain owned by the host coordinator.
 */
export class TaskHostCapabilityExecutor implements RoutableHostCapabilityExecutor {
  constructor(private readonly tasks: TaskRuntime) {}

  supports(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): boolean {
    return capability.environment === 'extension-host'
      && ((request.name === 'set_todos' && capability.id === 'task.set-todos')
        || (request.name === 'report_progress' && capability.id === 'task.report-progress'));
  }

  async execute(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata,
    admission?: HostCapabilityExecutionAdmission): Promise<HostCapabilityExecutorResult> {
    if (!this.supports(request, capability)) throw new Error(`Task Runtime does not own ${request.name}.`);
    await this.tasks.initialize();
    assertHostCapabilityExecutionAdmission(admission);
    const task = request.taskId ? this.tasks.getTask(request.taskId) : undefined;
    const ref = task?.workerSessions[request.managedSessionId];
    if (!task || !ref || ref.detachedAt || ref.retiredAt || ref.workerId !== request.workerId) {
      throw new Error('Task capability requires the exact current Mission Worker binding.');
    }
    if (request.name === 'set_todos') {
      const todos = normalizeBridgeTodos(request.arguments);
      const snapshot = await this.tasks.setTodosStrict(task.taskId, todos);
      return { text: JSON.stringify({ taskId: snapshot.taskId, todos: snapshot.todos }), isError: false };
    }
    const normalized = normalizeBridgeProgress(request.arguments, task.todos);
    const snapshot = await this.tasks.reportProgressStrict(task.taskId, normalized.progress);
    return { text: JSON.stringify({ taskId: snapshot.taskId, progress: snapshot.progress }), isError: false };
  }
}
