import { randomUUID } from "node:crypto";
import type {
  WorkerAdapter,
  WorkerCapabilityResultInput,
  WorkerDescriptor,
  WorkerEvent,
  WorkerHealth,
  WorkerInput,
  WorkerSessionHandle,
  WorkerSessionOptions,
  WorkerSessionState,
} from "./worker-contract.js";

interface ErasedWorkerAdapter {
  describe(): Promise<WorkerDescriptor>;
  createSession(options: WorkerSessionOptions): Promise<WorkerSessionHandle>;
  send(session: WorkerSessionHandle, input: WorkerInput): AsyncIterable<WorkerEvent>;
  submitCapabilityResult?(session: WorkerSessionHandle, result: WorkerCapabilityResultInput): Promise<void>;
  interrupt(session: WorkerSessionHandle): Promise<void>;
  resume?(session: WorkerSessionHandle, checkpoint: unknown): Promise<void>;
  dispose(session: WorkerSessionHandle): Promise<void>;
  health(session?: WorkerSessionHandle): Promise<WorkerHealth>;
}

export interface WorkerTaskBindingStore {
  attachWorkerSession(taskId: string, input: {
    managedSessionId: string;
    workerId: string;
    adapterSessionId: string;
    model?: string;
  }): Promise<unknown>;
  detachWorkerSession(taskId: string, managedSessionId: string): Promise<void>;
}

export interface WorkerExecutionProjectionStore {
  beginWorkerExecution(taskId: string, input: {
    executionId: string;
    managedSessionId: string;
    workerId: string;
    inputId: string;
    callId?: string;
    toolName: string;
    arguments?: unknown;
  }): Promise<void>;
  completeWorkerExecution(taskId: string, executionId: string, input: {
    status: "succeeded" | "failed" | "unknown";
    durationMs?: number;
    error?: string;
    resultSummary?: string;
  }): Promise<void>;
  markWorkerExecutionDelivered(taskId: string, executionId: string): Promise<void>;
}

export interface WorkerSessionManagerOptions {
  newId?: () => string;
  taskBindings?: WorkerTaskBindingStore;
  executionProjection?: WorkerExecutionProjectionStore;
}

export interface ManagedWorkerSession {
  managedSessionId: string;
  workerId: string;
  adapterSessionId: string;
  taskId?: string;
  model?: string;
  contextHandle?: string;
  state: WorkerSessionState;
  createdAt: string;
  lastActiveAt: string;
}

interface RegisteredWorker {
  descriptor: WorkerDescriptor;
  adapter: ErasedWorkerAdapter;
}

interface ManagedWorkerSessionRecord {
  managedSessionId: string;
  workerId: string;
  taskId?: string;
  handle: WorkerSessionHandle;
  hostCapabilityRequests: Map<string, { inputId: string; callId: string; name: string }>;
}

function cloneDescriptor(descriptor: WorkerDescriptor): WorkerDescriptor {
  return {
    ...descriptor,
    models: descriptor.models ? [...descriptor.models] : undefined,
    capabilities: {
      ...descriptor.capabilities,
      extensions: descriptor.capabilities.extensions ? { ...descriptor.capabilities.extensions } : undefined,
    },
    extensions: descriptor.extensions ? { ...descriptor.extensions } : undefined,
  };
}

function publicSession(record: ManagedWorkerSessionRecord): ManagedWorkerSession {
  return {
    managedSessionId: record.managedSessionId,
    workerId: record.workerId,
    adapterSessionId: record.handle.sessionId,
    taskId: record.taskId,
    model: record.handle.model,
    contextHandle: record.handle.contextHandle,
    state: record.handle.state,
    createdAt: record.handle.createdAt,
    lastActiveAt: record.handle.lastActiveAt,
  };
}

export class WorkerSessionManager {
  private readonly options: WorkerSessionManagerOptions;
  private readonly workers = new Map<string, RegisteredWorker>();
  private readonly sessions = new Map<string, ManagedWorkerSessionRecord>();
  private readonly adapterSessionIds = new Map<string, string>();

  constructor(options: WorkerSessionManagerOptions = {}) {
    this.options = options;
  }

  async register<TSessionOptions extends WorkerSessionOptions, TInput extends WorkerInput>(adapter: WorkerAdapter<TSessionOptions, TInput>): Promise<WorkerDescriptor> {
    const descriptor = await adapter.describe();
    if (!descriptor.id.trim()) throw new Error("Worker descriptor id must not be empty.");
    if (this.workers.has(descriptor.id)) throw new Error(`Worker already registered: ${descriptor.id}`);
    this.workers.set(descriptor.id, { descriptor: cloneDescriptor(descriptor), adapter: adapter as unknown as ErasedWorkerAdapter });
    return cloneDescriptor(descriptor);
  }

  async refresh(workerId: string): Promise<WorkerDescriptor> {
    const worker = this.requireWorker(workerId);
    const descriptor = await worker.adapter.describe();
    if (descriptor.id !== workerId) throw new Error(`Worker ${workerId} changed descriptor id to ${descriptor.id}.`);
    worker.descriptor = cloneDescriptor(descriptor);
    return cloneDescriptor(worker.descriptor);
  }

  unregister(workerId: string): void {
    this.requireWorker(workerId);
    if ([...this.sessions.values()].some(session => session.workerId === workerId)) {
      throw new Error(`Cannot unregister worker ${workerId} while managed sessions still exist.`);
    }
    this.workers.delete(workerId);
  }

  listWorkers(): WorkerDescriptor[] {
    return [...this.workers.values()].map(worker => cloneDescriptor(worker.descriptor));
  }

  getWorker(workerId: string): WorkerDescriptor | undefined {
    const descriptor = this.workers.get(workerId)?.descriptor;
    return descriptor ? cloneDescriptor(descriptor) : undefined;
  }

  async createSession<TSessionOptions extends WorkerSessionOptions>(workerId: string, options: TSessionOptions, taskId?: string): Promise<ManagedWorkerSession> {
    const worker = this.requireWorker(workerId);
    const handle = await worker.adapter.createSession(options);
    if (handle.workerId !== workerId) {
      await worker.adapter.dispose(handle).catch(() => undefined);
      throw new Error(`Worker ${workerId} created a session owned by ${handle.workerId}.`);
    }

    const adapterKey = this.adapterSessionKey(workerId, handle.sessionId);
    if (this.adapterSessionIds.has(adapterKey)) {
      throw new Error(`Adapter session is already managed: ${workerId}/${handle.sessionId}`);
    }

    const managedSessionId = this.newId();
    if (this.sessions.has(managedSessionId)) {
      await worker.adapter.dispose(handle).catch(() => undefined);
      throw new Error(`Managed worker session id collision: ${managedSessionId}`);
    }
    const record: ManagedWorkerSessionRecord = { managedSessionId, workerId, handle, hostCapabilityRequests: new Map() };
    this.sessions.set(managedSessionId, record);
    this.adapterSessionIds.set(adapterKey, managedSessionId);
    try {
      if (taskId) await this.bindTask(managedSessionId, taskId);
      return publicSession(record);
    } catch (error) {
      this.sessions.delete(managedSessionId);
      this.adapterSessionIds.delete(adapterKey);
      await worker.adapter.dispose(handle).catch(() => undefined);
      throw error;
    }
  }

  getSession(managedSessionId: string): ManagedWorkerSession | undefined {
    const record = this.sessions.get(managedSessionId);
    return record ? publicSession(record) : undefined;
  }

  listSessions(filter: { workerId?: string; taskId?: string; state?: WorkerSessionState } = {}): ManagedWorkerSession[] {
    return [...this.sessions.values()]
      .filter(record => !filter.workerId || record.workerId === filter.workerId)
      .filter(record => !filter.taskId || record.taskId === filter.taskId)
      .filter(record => !filter.state || record.handle.state === filter.state)
      .map(publicSession)
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  async bindTask(managedSessionId: string, taskId: string): Promise<void> {
    const record = this.requireSession(managedSessionId);
    if (record.taskId === taskId) return;
    if (record.handle.state === "running") throw new Error(`Cannot rebind running worker session ${managedSessionId}.`);
    const previousTaskId = record.taskId;
    if (previousTaskId) await this.options.taskBindings?.detachWorkerSession(previousTaskId, managedSessionId);
    try {
      await this.options.taskBindings?.attachWorkerSession(taskId, {
        managedSessionId,
        workerId: record.workerId,
        adapterSessionId: record.handle.sessionId,
        model: record.handle.model,
      });
      record.taskId = taskId;
    } catch (error) {
      if (previousTaskId) {
        await this.options.taskBindings?.attachWorkerSession(previousTaskId, {
          managedSessionId,
          workerId: record.workerId,
          adapterSessionId: record.handle.sessionId,
          model: record.handle.model,
        }).catch(() => undefined);
        record.taskId = previousTaskId;
      }
      throw error;
    }
  }

  async unbindTask(managedSessionId: string): Promise<void> {
    const record = this.requireSession(managedSessionId);
    if (!record.taskId) return;
    if (record.handle.state === "running") throw new Error(`Cannot unbind running worker session ${managedSessionId}.`);
    const taskId = record.taskId;
    await this.options.taskBindings?.detachWorkerSession(taskId, managedSessionId);
    record.taskId = undefined;
  }

  send<TInput extends WorkerInput>(managedSessionId: string, input: TInput): AsyncIterable<WorkerEvent> {
    const record = this.requireSession(managedSessionId);
    const events = this.trackCapabilityDispatch(record, input, this.requireWorker(record.workerId).adapter.send(record.handle, input));
    if (!record.taskId || !this.options.executionProjection) return events;
    return this.projectExecutionEvents(record, input, events);
  }

  async submitCapabilityResult(managedSessionId: string, result: WorkerCapabilityResultInput): Promise<void> {
    const record = this.requireSession(managedSessionId);
    if (!result.callId) throw new Error("Host-managed capability result requires callId.");
    const key = this.hostCapabilityRequestKey(result.inputId, result.callId);
    const pending = record.hostCapabilityRequests.get(key);
    if (!pending) throw new Error(`No outstanding host-requested capability call ${result.callId} for input ${result.inputId}.`);
    if (pending.name !== result.name) throw new Error(`Host-managed capability result name mismatch for ${result.callId}: expected ${pending.name}, received ${result.name}.`);
    const adapter = this.requireWorker(record.workerId).adapter;
    if (!adapter.submitCapabilityResult) throw new Error(`Worker ${record.workerId} does not accept host-managed capability results.`);
    await adapter.submitCapabilityResult(record.handle, result);
    record.hostCapabilityRequests.delete(key);
  }

  async interrupt(managedSessionId: string): Promise<void> {
    const record = this.requireSession(managedSessionId);
    await this.requireWorker(record.workerId).adapter.interrupt(record.handle);
  }

  async resume(managedSessionId: string, checkpoint: unknown): Promise<void> {
    const record = this.requireSession(managedSessionId);
    const adapter = this.requireWorker(record.workerId).adapter;
    if (!adapter.resume) throw new Error(`Worker ${record.workerId} does not support resume.`);
    await adapter.resume(record.handle, checkpoint);
  }

  async health(managedSessionId: string): Promise<WorkerHealth> {
    const record = this.requireSession(managedSessionId);
    return this.requireWorker(record.workerId).adapter.health(record.handle);
  }

  async healthWorker(workerId: string): Promise<WorkerHealth> {
    return this.requireWorker(workerId).adapter.health();
  }

  async dispose(managedSessionId: string): Promise<void> {
    const record = this.requireSession(managedSessionId);
    const worker = this.requireWorker(record.workerId);
    await worker.adapter.dispose(record.handle);
    const taskId = record.taskId;
    this.sessions.delete(managedSessionId);
    this.adapterSessionIds.delete(this.adapterSessionKey(record.workerId, record.handle.sessionId));
    if (taskId) await this.options.taskBindings?.detachWorkerSession(taskId, managedSessionId);
  }

  private requireWorker(workerId: string): RegisteredWorker {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`Unknown worker: ${workerId}`);
    return worker;
  }

  private requireSession(managedSessionId: string): ManagedWorkerSessionRecord {
    const session = this.sessions.get(managedSessionId);
    if (!session) throw new Error(`Unknown managed worker session: ${managedSessionId}`);
    return session;
  }

  private adapterSessionKey(workerId: string, adapterSessionId: string): string {
    return `${workerId}\u0000${adapterSessionId}`;
  }

  private async *projectExecutionEvents(
    record: ManagedWorkerSessionRecord,
    input: WorkerInput,
    events: AsyncIterable<WorkerEvent>,
  ): AsyncIterable<WorkerEvent> {
    const taskId = record.taskId;
    const projection = this.options.executionProjection;
    if (!taskId || !projection) {
      yield* events;
      return;
    }

    let occurrence = 0;
    const executions: Array<{
      executionId: string;
      callId?: string;
      name: string;
      hostOwned: boolean;
      resultSeen: boolean;
      delivered: boolean;
    }> = [];

    const findResultTarget = (event: Extract<WorkerEvent, { type: "capability_result" }>) =>
      executions.find(item => !item.resultSeen && (event.callId ? item.callId === event.callId : item.name === event.name));
    const findDeliveryTarget = (callId: string | undefined, name: string | undefined) =>
      executions.find(item => item.resultSeen && !item.delivered && (callId ? item.callId === callId : !!name && item.name === name));

    for await (const event of events) {
      if (event.type === "capability_call") {
        occurrence += 1;
        const executionId = `worker:${record.managedSessionId}:${input.inputId}:${occurrence}`;
        const hostOwned = event.dispatch === "host-requested";
        executions.push({ executionId, callId: event.callId, name: event.name, hostOwned, resultSeen: false, delivered: false });
        if (!hostOwned) {
          await projection.beginWorkerExecution(taskId, {
            executionId,
            managedSessionId: record.managedSessionId,
            workerId: record.workerId,
            inputId: input.inputId,
            callId: event.callId,
            toolName: event.name,
            arguments: event.arguments,
          });
        }
        yield {
          ...event,
          extensions: { ...event.extensions, executionId },
        };
        continue;
      } else if (event.type === "capability_result") {
        let target = findResultTarget(event);
        if (!target) {
          occurrence += 1;
          target = {
            executionId: `worker:${record.managedSessionId}:${input.inputId}:${occurrence}`,
            callId: event.callId,
            name: event.name,
            hostOwned: false,
            resultSeen: false,
            delivered: false,
          };
          executions.push(target);
          await projection.beginWorkerExecution(taskId, {
            executionId: target.executionId,
            managedSessionId: record.managedSessionId,
            workerId: record.workerId,
            inputId: input.inputId,
            callId: event.callId,
            toolName: event.name,
          });
        }
        target.resultSeen = true;
        if (!target.hostOwned) {
          await projection.completeWorkerExecution(taskId, target.executionId, {
            status: event.isError ? "failed" : "succeeded",
            durationMs: event.durationMs,
            error: event.isError ? event.text : undefined,
            resultSummary: event.text,
          });
        }
      } else if (event.type === "provider_event" && event.name === "capability_result_delivered") {
        const data = event.data && typeof event.data === "object" && !Array.isArray(event.data)
          ? event.data as Record<string, unknown>
          : {};
        const callId = typeof data.callId === "string" && data.callId ? data.callId : undefined;
        const name = typeof data.capability === "string" && data.capability ? data.capability : undefined;
        const target = findDeliveryTarget(callId, name);
        if (target) {
          target.delivered = true;
          if (!target.hostOwned) await projection.markWorkerExecutionDelivered(taskId, target.executionId);
        }
      } else if (event.type === "terminal") {
        for (const target of executions) {
          if (target.resultSeen) continue;
          target.resultSeen = true;
          if (!target.hostOwned) {
            await projection.completeWorkerExecution(taskId, target.executionId, {
              status: "unknown",
              error: `Worker turn ended with ${event.status} before a capability result was observed.`,
            });
          }
        }
      }
      yield event;
    }
  }

  private async *trackCapabilityDispatch(
    record: ManagedWorkerSessionRecord,
    input: WorkerInput,
    events: AsyncIterable<WorkerEvent>,
  ): AsyncIterable<WorkerEvent> {
    try {
      for await (const event of events) {
        if (event.type === "capability_call" && event.dispatch === "host-requested") {
          if (!event.callId) throw new Error(`Worker ${record.workerId} emitted host-requested capability ${event.name} without callId.`);
          const key = this.hostCapabilityRequestKey(input.inputId, event.callId);
          const existing = record.hostCapabilityRequests.get(key);
          if (existing && existing.name !== event.name) {
            throw new Error(`Worker ${record.workerId} reused host-requested callId ${event.callId} for a different capability.`);
          }
          if (!existing) record.hostCapabilityRequests.set(key, { inputId: input.inputId, callId: event.callId, name: event.name });
        }
        yield event;
      }
    } finally {
      for (const [key, pending] of record.hostCapabilityRequests) {
        if (pending.inputId === input.inputId) record.hostCapabilityRequests.delete(key);
      }
    }
  }

  private hostCapabilityRequestKey(inputId: string, callId: string): string {
    return `${inputId}\u0000${callId}`;
  }

  private newId(): string {
    return (this.options.newId ?? randomUUID)();
  }
}
