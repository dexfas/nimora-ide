import { randomUUID } from "node:crypto";
import type {
  WorkerAdapter,
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

export interface WorkerSessionManagerOptions {
  newId?: () => string;
  taskBindings?: WorkerTaskBindingStore;
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
    const record: ManagedWorkerSessionRecord = { managedSessionId, workerId, handle };
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
    return this.requireWorker(record.workerId).adapter.send(record.handle, input);
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

  private newId(): string {
    return (this.options.newId ?? randomUUID)();
  }
}
