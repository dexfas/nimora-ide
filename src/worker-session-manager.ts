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
import type { WorkerConversationUsageObservation } from "./worker-conversation-lifecycle.js";
import type { WorkerTurnObservation } from "./worker-performance-observations.js";

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
  retireWorkerSessionStrict?(taskId: string, managedSessionId: string, input: {
    retiredAt: string;
    reason?: string;
  }): Promise<unknown>;
  isWorkerAdapterSessionRetired?(workerId: string, adapterSessionId: string): Promise<boolean>;
  assertWorkerSessionContinuationAllowed?(taskId: string, operation?: string): Promise<void>;
  assertWorkerSessionAdmittedTurnContinuationAllowed?(taskId: string, operation?: string): Promise<void>;
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
  now?: () => Date;
  taskBindings?: WorkerTaskBindingStore;
  executionProjection?: WorkerExecutionProjectionStore;
  /** Admission only; runs before the provider send lease or any adapter input. */
  beforeSend?: (session: ManagedWorkerSession, input: WorkerInput) => Promise<void>;
  observeTurn?: (observation: WorkerTurnObservation) => void;
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

export interface RetiredWorkerSession {
  managedSessionId: string;
  workerId: string;
  adapterSessionId: string;
  taskId?: string;
  model?: string;
  contextHandle?: string;
  retiredAt: string;
  retirementReason?: string;
  ownershipPersistenceError?: string;
  disposeError?: string;
}

export interface WorkerAdapterSessionIdentity {
  workerId: string;
  adapterSessionId: string;
}

/** Read-only, lock-consistent diagnostic; never authority to clear/retry. */
export interface WorkerAdapterSettlementFacts {
  sessionPresent: boolean;
  state?: WorkerSessionState;
  activeSendLeases: number;
  abandonedSendCleanups: number;
  hostCapabilityRequests: number;
  unsettledProviderSends: number;
}

export interface WorkerAdapterSessionRetirementScope {
  getSession(identity: WorkerAdapterSessionIdentity): ManagedWorkerSession | undefined;
  hasActiveSendLease(identity: WorkerAdapterSessionIdentity): boolean;
  isKnownSettled(identity: WorkerAdapterSessionIdentity): boolean;
  inspectSettlement?(identity: WorkerAdapterSessionIdentity): WorkerAdapterSettlementFacts;
  retire(identity: WorkerAdapterSessionIdentity, options?: { reason?: string }): Promise<RetiredWorkerSession | undefined>;
}

interface RegisteredWorker {
  descriptor: WorkerDescriptor;
  adapter: ErasedWorkerAdapter;
}

interface ManagedSendInterruptAttempt {
  state: "in-flight" | "succeeded" | "failed";
  promise: Promise<void>;
  error?: unknown;
}

interface ManagedSendInterruptOwnership {
  inputId: string;
  attempt?: ManagedSendInterruptAttempt;
}

interface AbandonedSendCleanup {
  inputId: string;
  adapterKey: string;
  providerIterator: AsyncIterator<WorkerEvent>;
  finalizePromise?: Promise<void>;
}

interface WorkerExecutionProjectionState {
  occurrence: number;
  executions: Array<{
    executionId: string;
    callId?: string;
    name: string;
    occurrenceId?: string;
    hostOwned: boolean;
    resultSeen: boolean;
    delivered: boolean;
  }>;
}

interface ManagedWorkerSessionRecord {
  managedSessionId: string;
  workerId: string;
  taskId?: string;
  handle: WorkerSessionHandle;
  activeSendLeases: number;
  unsettledReplacementSends?: Set<symbol>;
  activeSendLeaseTokens: Set<symbol>;
  sendInterruptOwnership: Map<symbol, ManagedSendInterruptOwnership>;
  hostCapabilityRequests: Map<string, { inputId: string; callId: string; name: string; occurrenceId?: string; sendLeaseToken: symbol }>;
  abandonedSendCleanups: Map<symbol, AbandonedSendCleanup>;
  conversationObservedChars: number;
  conversationTurnCount: number;
  conversationLastProviderError?: string;
}

interface RetiredWorkerSessionRecord {
  summary: RetiredWorkerSession;
  record: ManagedWorkerSessionRecord;
}

function cloneDescriptor(descriptor: WorkerDescriptor): WorkerDescriptor {
  return {
    ...descriptor,
    models: descriptor.models ? [...descriptor.models] : undefined,
    capabilityProjection: descriptor.capabilityProjection ? {
      ...descriptor.capabilityProjection,
      executionRoutes: descriptor.capabilityProjection.executionRoutes?.map(route => ({
        ...route,
        toolNames: [...route.toolNames],
      })),
    } : undefined,
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
    state: record.activeSendLeases > 0 ? "running" : record.handle.state,
    createdAt: record.handle.createdAt,
    lastActiveAt: record.handle.lastActiveAt,
  };
}

function publicRetiredSession(record: RetiredWorkerSessionRecord): RetiredWorkerSession {
  return { ...record.summary };
}

export class WorkerSessionManager {
  private readonly options: WorkerSessionManagerOptions;
  private readonly workers = new Map<string, RegisteredWorker>();
  private readonly sessions = new Map<string, ManagedWorkerSessionRecord>();
  private readonly retiredSessions = new Map<string, RetiredWorkerSessionRecord>();
  private readonly retiredAdapterSessionIds = new Map<string, string>();
  private readonly adapterSessionIds = new Map<string, string>();
  private readonly adapterSessionOperationChains = new Map<string, Promise<void>>();
  private readonly adapterSessionSendLeaseWaiters = new Map<string, Set<() => void>>();

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
    if ([...this.retiredSessions.values()].some(session => session.summary.workerId === workerId && session.summary.disposeError)) {
      throw new Error(`Cannot unregister worker ${workerId} while retired session cleanup is pending.`);
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
    if (taskId) await this.options.taskBindings?.assertWorkerSessionContinuationAllowed?.(taskId, "create a WorkerSession");
    const handle = await worker.adapter.createSession(options);
    if (handle.workerId !== workerId) {
      await worker.adapter.dispose(handle).catch(() => undefined);
      throw new Error(`Worker ${workerId} created a session owned by ${handle.workerId}.`);
    }

    const adapterKey = this.adapterSessionKey(workerId, handle.sessionId);
    return this.exclusiveAdapterSession(adapterKey, async () => {
      if (this.adapterSessionIds.has(adapterKey)) {
        // Do not dispose here: two wrappers may refer to the same provider-native
        // conversation, and disposing the rejected handle could kill the wrapper
        // that is already managed.
        throw new Error(`Adapter session is already managed: ${workerId}/${handle.sessionId}`);
      }
      const durableRetired = await this.options.taskBindings?.isWorkerAdapterSessionRetired?.(workerId, handle.sessionId) ?? false;
      if (this.retiredAdapterSessionIds.has(adapterKey) || durableRetired) {
        await worker.adapter.dispose(handle).catch(() => undefined);
        throw new Error(`Adapter session is retired and cannot be reused: ${workerId}/${handle.sessionId}`);
      }

      const managedSessionId = this.newId();
      if (this.sessions.has(managedSessionId) || this.retiredSessions.has(managedSessionId)) {
        await worker.adapter.dispose(handle).catch(() => undefined);
        throw new Error(`Managed worker session id collision: ${managedSessionId}`);
      }
      const record: ManagedWorkerSessionRecord = {
        managedSessionId,
        workerId,
        handle,
        activeSendLeases: 0,
        activeSendLeaseTokens: new Set(),
        sendInterruptOwnership: new Map(),
        hostCapabilityRequests: new Map(),
        abandonedSendCleanups: new Map(),
        conversationObservedChars: 0,
        conversationTurnCount: 0,
      };
      this.sessions.set(managedSessionId, record);
      this.adapterSessionIds.set(adapterKey, managedSessionId);
      try {
        if (taskId) await this.bindTaskRecord(record, taskId);
        return publicSession(record);
      } catch (error) {
        this.sessions.delete(managedSessionId);
        this.adapterSessionIds.delete(adapterKey);
        await worker.adapter.dispose(handle).catch(() => undefined);
        throw error;
      }
    });
  }

  getSession(managedSessionId: string): ManagedWorkerSession | undefined {
    const record = this.sessions.get(managedSessionId);
    return record ? publicSession(record) : undefined;
  }

  inspectConversationUsage(managedSessionId: string): WorkerConversationUsageObservation {
    const record = this.requireSession(managedSessionId);
    return {
      sessionObservedChars: record.conversationObservedChars,
      sessionTurnCount: record.conversationTurnCount,
      ...(record.conversationLastProviderError ? { providerErrorText: record.conversationLastProviderError } : {}),
    };
  }

  getSessionByAdapterIdentity(workerId: string, adapterSessionId: string): ManagedWorkerSession | undefined {
    const adapterKey = this.adapterSessionKey(workerId, adapterSessionId);
    const managedSessionId = this.adapterSessionIds.get(adapterKey);
    if (!managedSessionId) return undefined;
    const record = this.sessions.get(managedSessionId);
    return record && record.workerId === workerId && record.handle.sessionId === adapterSessionId
      ? publicSession(record)
      : undefined;
  }

  getRetiredSession(managedSessionId: string): RetiredWorkerSession | undefined {
    const record = this.retiredSessions.get(managedSessionId);
    return record ? publicRetiredSession(record) : undefined;
  }

  async isAdapterSessionRetired(workerId: string, adapterSessionId: string): Promise<boolean> {
    const adapterKey = this.adapterSessionKey(workerId, adapterSessionId);
    if (this.retiredAdapterSessionIds.has(adapterKey)) return true;
    return await this.options.taskBindings?.isWorkerAdapterSessionRetired?.(workerId, adapterSessionId) ?? false;
  }

  listSessions(filter: { workerId?: string; taskId?: string; state?: WorkerSessionState } = {}): ManagedWorkerSession[] {
    return [...this.sessions.values()]
      .filter(record => !filter.workerId || record.workerId === filter.workerId)
      .filter(record => !filter.taskId || record.taskId === filter.taskId)
      .filter(record => !filter.state || record.handle.state === filter.state)
      .map(publicSession)
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
  }

  listRetiredSessions(filter: { workerId?: string; taskId?: string } = {}): RetiredWorkerSession[] {
    return [...this.retiredSessions.values()]
      .map(publicRetiredSession)
      .filter(session => !filter.workerId || session.workerId === filter.workerId)
      .filter(session => !filter.taskId || session.taskId === filter.taskId)
      .sort((a, b) => b.retiredAt.localeCompare(a.retiredAt));
  }

  async bindTask(managedSessionId: string, taskId: string): Promise<void> {
    const initial = this.requireSession(managedSessionId);
    const adapterKey = this.adapterSessionKey(initial.workerId, initial.handle.sessionId);
    await this.exclusiveAdapterSession(adapterKey, async () => {
      const record = this.requireSameSession(managedSessionId, initial.workerId, initial.handle.sessionId);
      await this.assertAdapterSessionAliveLocked(record, "rebind");
      await this.bindTaskRecord(record, taskId);
    });
  }

  async unbindTask(managedSessionId: string): Promise<void> {
    const initial = this.requireSession(managedSessionId);
    const adapterKey = this.adapterSessionKey(initial.workerId, initial.handle.sessionId);
    await this.exclusiveAdapterSession(adapterKey, async () => {
      const record = this.requireSameSession(managedSessionId, initial.workerId, initial.handle.sessionId);
      await this.assertAdapterSessionAliveLocked(record, "unbind");
      if (!record.taskId) return;
      if (this.isRecordRunning(record)) throw new Error(`Cannot unbind running worker session ${managedSessionId}.`);
      const taskId = record.taskId;
      await this.options.taskBindings?.detachWorkerSession(taskId, managedSessionId);
      record.taskId = undefined;
    });
  }

  send<TInput extends WorkerInput>(managedSessionId: string, input: TInput): AsyncIterable<WorkerEvent> {
    const record = this.requireSession(managedSessionId);
    return this.sendWithLifecycle(record.managedSessionId, record.workerId, record.handle.sessionId, input);
  }

  async submitCapabilityResult(managedSessionId: string, result: WorkerCapabilityResultInput): Promise<void> {
    const initial = this.requireSession(managedSessionId);
    const adapterKey = this.adapterSessionKey(initial.workerId, initial.handle.sessionId);
    await this.exclusiveAdapterSession(adapterKey, async () => {
      const record = this.requireSameSession(managedSessionId, initial.workerId, initial.handle.sessionId);
      if (!result.callId) throw new Error("Host-managed capability result requires callId.");
      const resultOccurrenceId = this.workerOccurrenceId(result.extensions);
      let key = resultOccurrenceId
        ? this.hostCapabilityRequestKey(result.inputId, result.callId, resultOccurrenceId)
        : "";
      let pending = key ? record.hostCapabilityRequests.get(key) : undefined;
      if (!pending && !resultOccurrenceId) {
        const routeMatches = [...record.hostCapabilityRequests.entries()]
          .filter(([, candidate]) => candidate.inputId === result.inputId && candidate.callId === result.callId);
        if (routeMatches.some(([, candidate]) => !!candidate.occurrenceId)) {
          throw new Error(`Host-managed capability result for ${result.callId} / input ${result.inputId} requires exact logical-occurrence authority.`);
        }
        if (routeMatches.length > 1) {
          throw new Error(`Host-managed capability result for ${result.callId} / input ${result.inputId} is ambiguous across logical occurrences; exact occurrence authority is required.`);
        }
        if (routeMatches.length === 1) {
          [key, pending] = routeMatches[0];
        }
      }
      if (!pending) throw new Error(`No outstanding host-requested capability call ${result.callId} for input ${result.inputId}.`);
      if (pending.name !== result.name) throw new Error(`Host-managed capability result name mismatch for ${result.callId}: expected ${pending.name}, received ${result.name}.`);
      if (resultOccurrenceId && pending.occurrenceId && resultOccurrenceId !== pending.occurrenceId) {
        throw new Error(`Host-managed capability result occurrence mismatch for ${result.callId}: expected ${pending.occurrenceId}, received ${resultOccurrenceId}.`);
      }
      if (!record.activeSendLeaseTokens.has(pending.sendLeaseToken)) {
        throw new Error(`Host-requested capability call ${result.callId} for input ${result.inputId} is no longer owned by an active send.`);
      }

      // This is delivery back into the exact provider turn that already won
      // send admission. Mission finalization may close admission for new work
      // while waiting for this lease, but must not revoke the turn's ability to
      // finish itself. The pending-call + lease token is that narrow authority.
      await this.assertAdapterSessionDurablyAliveLocked(record, "accept a host capability result");
      if (record.taskId) {
        const bindings = this.options.taskBindings;
        if (bindings?.assertWorkerSessionAdmittedTurnContinuationAllowed) {
          await bindings.assertWorkerSessionAdmittedTurnContinuationAllowed(record.taskId, "accept a host capability result");
        } else {
          await bindings?.assertWorkerSessionContinuationAllowed?.(record.taskId, "accept a host capability result");
        }
      }
      const adapter = this.requireWorker(record.workerId).adapter;
      if (!adapter.submitCapabilityResult) throw new Error(`Worker ${record.workerId} does not accept host-managed capability results.`);
      const exactResult = pending.occurrenceId
        ? {
            ...result,
            extensions: { ...(result.extensions ?? {}), occurrenceId: pending.occurrenceId },
          }
        : result;
      await adapter.submitCapabilityResult(record.handle, exactResult);
      record.hostCapabilityRequests.delete(key);
    });
  }

  async interrupt(managedSessionId: string): Promise<void> {
    const initial = this.requireSession(managedSessionId);
    const adapterKey = this.adapterSessionKey(initial.workerId, initial.handle.sessionId);
    const record = this.requireSameSession(managedSessionId, initial.workerId, initial.handle.sessionId);
    const pending = [...record.abandonedSendCleanups.entries()];
    if (pending.length > 1) {
      throw new Error(`Worker session ${managedSessionId} has ambiguous abandoned send ownership.`);
    }

    const active = [...record.activeSendLeaseTokens]
      .map(sendLeaseToken => ({
        sendLeaseToken,
        ownership: record.sendInterruptOwnership.get(sendLeaseToken),
      }))
      .filter((value): value is { sendLeaseToken: symbol; ownership: ManagedSendInterruptOwnership } => !!value.ownership);

    const exact = pending.length === 1
      ? {
          sendLeaseToken: pending[0][0],
          ownership: record.sendInterruptOwnership.get(pending[0][0]),
          cleanup: pending[0][1],
        }
      : active.length === 1
        ? { sendLeaseToken: active[0].sendLeaseToken, ownership: active[0].ownership, cleanup: undefined }
        : undefined;

    if (exact?.ownership) {
      await this.interruptManagedSend(record, exact.sendLeaseToken, exact.ownership);
      const cleanup = exact.cleanup ?? record.abandonedSendCleanups.get(exact.sendLeaseToken);
      if (cleanup) await this.finalizeAbandonedSend(record, exact.sendLeaseToken, cleanup);
      return;
    }

    if (active.length > 1) {
      throw new Error(`Worker session ${managedSessionId} has ambiguous active send ownership for interruption.`);
    }

    await this.exclusiveAdapterSession(adapterKey, async () => {
      const current = this.requireSameSession(managedSessionId, initial.workerId, initial.handle.sessionId);
      await this.requireWorker(current.workerId).adapter.interrupt(current.handle);
    });
  }

  async resume(managedSessionId: string, checkpoint: unknown): Promise<void> {
    const initial = this.requireSession(managedSessionId);
    const adapterKey = this.adapterSessionKey(initial.workerId, initial.handle.sessionId);
    await this.exclusiveAdapterSession(adapterKey, async () => {
      const record = this.requireSameSession(managedSessionId, initial.workerId, initial.handle.sessionId);
      await this.assertAdapterSessionAliveLocked(record, "resume");
      const adapter = this.requireWorker(record.workerId).adapter;
      if (!adapter.resume) throw new Error(`Worker ${record.workerId} does not support resume.`);
      await adapter.resume(record.handle, checkpoint);
    });
  }

  async health(managedSessionId: string): Promise<WorkerHealth> {
    const record = this.requireSession(managedSessionId);
    return this.requireWorker(record.workerId).adapter.health(record.handle);
  }

  async healthWorker(workerId: string): Promise<WorkerHealth> {
    return this.requireWorker(workerId).adapter.health();
  }

  async retire(managedSessionId: string, options: { reason?: string } = {}): Promise<RetiredWorkerSession> {
    const existingRetired = this.retiredSessions.get(managedSessionId);
    if (existingRetired) {
      if (existingRetired.summary.disposeError) await this.retryRetiredDispose(existingRetired);
      return publicRetiredSession(existingRetired);
    }

    const initial = this.requireSession(managedSessionId);
    const adapterKey = this.adapterSessionKey(initial.workerId, initial.handle.sessionId);
    return this.exclusiveAdapterSession(adapterKey, async () => {
      const racedRetired = this.retiredSessions.get(managedSessionId);
      if (racedRetired) {
        if (racedRetired.summary.disposeError) await this.retryRetiredDispose(racedRetired);
        return publicRetiredSession(racedRetired);
      }
      const record = this.requireSameSession(managedSessionId, initial.workerId, initial.handle.sessionId);
      return this.retireRecord(record, options);
    });
  }

  async retireAdapterSession(workerId: string, adapterSessionId: string, options: { reason?: string } = {}): Promise<RetiredWorkerSession | undefined> {
    const adapterKey = this.adapterSessionKey(workerId, adapterSessionId);
    return this.exclusiveAdapterSession(adapterKey, () => this.retireAdapterSessionLocked(workerId, adapterSessionId, options));
  }

  async withAdapterSessionRetirementScope<T>(
    identities: readonly WorkerAdapterSessionIdentity[],
    operation: (scope: WorkerAdapterSessionRetirementScope) => Promise<T>,
  ): Promise<T> {
    const unique = new Map<string, WorkerAdapterSessionIdentity>();
    for (const identity of identities) unique.set(this.adapterSessionKey(identity.workerId, identity.adapterSessionId), { ...identity });
    const keys = [...unique.keys()].sort();
    return this.exclusiveAdapterSessions(keys, async () => operation({
      getSession: identity => this.getSessionByAdapterIdentity(identity.workerId, identity.adapterSessionId),
      hasActiveSendLease: identity => this.hasActiveSendLease(identity.workerId, identity.adapterSessionId),
      isKnownSettled: identity => {
        const session = this.getSessionByAdapterIdentity(identity.workerId, identity.adapterSessionId);
        const record = session && this.sessions.get(session.managedSessionId);
        return !!record && record.handle.state === "idle" && record.activeSendLeases === 0
          && record.abandonedSendCleanups.size === 0 && record.hostCapabilityRequests.size === 0
          && !record.unsettledReplacementSends?.size;
      },
      inspectSettlement: identity => {
        const session = this.getSessionByAdapterIdentity(identity.workerId, identity.adapterSessionId);
        const record = session && this.sessions.get(session.managedSessionId);
        return {
          sessionPresent: !!record,
          state: record?.handle.state,
          activeSendLeases: record?.activeSendLeases ?? 0,
          abandonedSendCleanups: record?.abandonedSendCleanups.size ?? 0,
          hostCapabilityRequests: record?.hostCapabilityRequests.size ?? 0,
          unsettledProviderSends: record?.unsettledReplacementSends?.size ?? 0,
        };
      },
      retire: (identity, options = {}) => this.retireAdapterSessionLocked(identity.workerId, identity.adapterSessionId, options),
    }));
  }

  async waitForAdapterSessionSendLeases(identities: readonly WorkerAdapterSessionIdentity[]): Promise<void> {
    const keys = [...new Set(identities.map(identity => this.adapterSessionKey(identity.workerId, identity.adapterSessionId)))];
    await Promise.all(keys.map(key => this.waitForAdapterSessionSendLease(key)));
  }

  async dispose(managedSessionId: string): Promise<void> {
    const initial = this.requireSession(managedSessionId);
    const adapterKey = this.adapterSessionKey(initial.workerId, initial.handle.sessionId);
    await this.exclusiveAdapterSession(adapterKey, async () => {
      const record = this.requireSameSession(managedSessionId, initial.workerId, initial.handle.sessionId);
      if (this.isRecordRunning(record)) throw new Error(`Cannot dispose running worker session ${managedSessionId}.`);
      const worker = this.requireWorker(record.workerId);
      await worker.adapter.dispose(record.handle);
      const taskId = record.taskId;
      this.sessions.delete(managedSessionId);
      this.adapterSessionIds.delete(adapterKey);
      if (taskId) await this.options.taskBindings?.detachWorkerSession(taskId, managedSessionId);
    });
  }

  private requireWorker(workerId: string): RegisteredWorker {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error(`Unknown worker: ${workerId}`);
    return worker;
  }

  private requireSession(managedSessionId: string): ManagedWorkerSessionRecord {
    const session = this.sessions.get(managedSessionId);
    if (!session) {
      if (this.retiredSessions.has(managedSessionId)) throw new Error(`Managed worker session is retired: ${managedSessionId}`);
      throw new Error(`Unknown managed worker session: ${managedSessionId}`);
    }
    return session;
  }

  private requireSameSession(managedSessionId: string, workerId: string, adapterSessionId: string): ManagedWorkerSessionRecord {
    const record = this.requireSession(managedSessionId);
    if (record.workerId !== workerId || record.handle.sessionId !== adapterSessionId) {
      throw new Error(`Managed worker session identity changed while waiting for lifecycle ownership: ${managedSessionId}.`);
    }
    return record;
  }

  private async bindTaskRecord(record: ManagedWorkerSessionRecord, taskId: string): Promise<void> {
    const managedSessionId = record.managedSessionId;
    if (record.taskId === taskId) return;
    if (this.isRecordRunning(record)) throw new Error(`Cannot rebind running worker session ${managedSessionId}.`);
    await this.options.taskBindings?.assertWorkerSessionContinuationAllowed?.(taskId, "attach a WorkerSession");
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

  private async assertAdapterSessionAliveLocked(record: ManagedWorkerSessionRecord, operation: string): Promise<void> {
    await this.assertAdapterSessionDurablyAliveLocked(record, operation);
    if (record.taskId) await this.options.taskBindings?.assertWorkerSessionContinuationAllowed?.(record.taskId, operation);
  }

  private async assertAdapterSessionDurablyAliveLocked(record: ManagedWorkerSessionRecord, operation: string): Promise<void> {
    const adapterKey = this.adapterSessionKey(record.workerId, record.handle.sessionId);
    const durableRetired = await this.options.taskBindings?.isWorkerAdapterSessionRetired?.(record.workerId, record.handle.sessionId) ?? false;
    if (this.retiredAdapterSessionIds.has(adapterKey) || durableRetired) {
      if (!this.isRecordRunning(record)) {
        await this.retireRecord(record, { reason: "durable-provider-retirement" }, durableRetired);
      } else if (!this.retiredAdapterSessionIds.has(adapterKey)) {
        this.retiredAdapterSessionIds.set(adapterKey, record.managedSessionId);
      }
      throw new Error(`Adapter session is retired and cannot ${operation}: ${record.workerId}/${record.handle.sessionId}`);
    }
  }

  private async retireAdapterSessionLocked(workerId: string, adapterSessionId: string, options: { reason?: string }): Promise<RetiredWorkerSession | undefined> {
    const adapterKey = this.adapterSessionKey(workerId, adapterSessionId);
    const durableRetired = await this.options.taskBindings?.isWorkerAdapterSessionRetired?.(workerId, adapterSessionId) ?? false;
    const managedSessionId = this.adapterSessionIds.get(adapterKey);
    if (managedSessionId) {
      const record = this.sessions.get(managedSessionId);
      if (record && record.workerId === workerId && record.handle.sessionId === adapterSessionId) {
        return this.retireRecord(record, options, durableRetired);
      }
    }
    if (!this.retiredAdapterSessionIds.has(adapterKey)) this.retiredAdapterSessionIds.set(adapterKey, "");
    return undefined;
  }

  private async retireRecord(record: ManagedWorkerSessionRecord, options: { reason?: string }, providerDeathAuthoritative = false): Promise<RetiredWorkerSession> {
    const managedSessionId = record.managedSessionId;
    if (this.isRecordRunning(record)) throw new Error(`Cannot retire running worker session ${managedSessionId}.`);
    const retiredAt = this.now();
    const reason = options.reason?.trim() || undefined;
    const taskId = record.taskId;
    let ownershipPersistenceError: string | undefined;
    if (taskId) {
      if (this.options.taskBindings?.retireWorkerSessionStrict) {
        try {
          await this.options.taskBindings.retireWorkerSessionStrict(taskId, managedSessionId, { retiredAt, reason });
        } catch (error) {
          if (!providerDeathAuthoritative) throw error;
          ownershipPersistenceError = error instanceof Error ? error.message : String(error);
        }
      } else {
        try {
          await this.options.taskBindings?.detachWorkerSession(taskId, managedSessionId);
        } catch (error) {
          if (!providerDeathAuthoritative) throw error;
          ownershipPersistenceError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    this.sessions.delete(managedSessionId);
    const adapterKey = this.adapterSessionKey(record.workerId, record.handle.sessionId);
    this.adapterSessionIds.delete(adapterKey);
    this.retiredAdapterSessionIds.set(adapterKey, managedSessionId);
    record.hostCapabilityRequests.clear();
    const retired: RetiredWorkerSessionRecord = {
      summary: {
        managedSessionId,
        workerId: record.workerId,
        adapterSessionId: record.handle.sessionId,
        taskId,
        model: record.handle.model,
        contextHandle: record.handle.contextHandle,
        retiredAt,
        retirementReason: reason,
        ownershipPersistenceError,
      },
      record,
    };
    this.retiredSessions.set(managedSessionId, retired);
    await this.retryRetiredDispose(retired);
    return publicRetiredSession(retired);
  }

  private async retryRetiredDispose(retired: RetiredWorkerSessionRecord): Promise<void> {
    try {
      await this.requireWorker(retired.summary.workerId).adapter.dispose(retired.record.handle);
      retired.summary.disposeError = undefined;
    } catch (error) {
      retired.summary.disposeError = error instanceof Error ? error.message : String(error);
    }
  }

  private adapterSessionKey(workerId: string, adapterSessionId: string): string {
    return `${workerId}\u0000${adapterSessionId}`;
  }

  private async exclusiveAdapterSession<T>(adapterKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.adapterSessionOperationChains.get(adapterKey) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const current = previous.then(() => gate);
    this.adapterSessionOperationChains.set(adapterKey, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.adapterSessionOperationChains.get(adapterKey) === current) this.adapterSessionOperationChains.delete(adapterKey);
    }
  }

  private async exclusiveAdapterSessions<T>(adapterKeys: readonly string[], operation: () => Promise<T>, index = 0): Promise<T> {
    if (index >= adapterKeys.length) return operation();
    return this.exclusiveAdapterSession(adapterKeys[index], () => this.exclusiveAdapterSessions(adapterKeys, operation, index + 1));
  }

  private isRecordRunning(record: ManagedWorkerSessionRecord): boolean {
    return record.activeSendLeases > 0 || record.handle.state === "running";
  }

  private hasActiveSendLease(workerId: string, adapterSessionId: string): boolean {
    const managedSessionId = this.adapterSessionIds.get(this.adapterSessionKey(workerId, adapterSessionId));
    const record = managedSessionId ? this.sessions.get(managedSessionId) : undefined;
    return !!record && record.workerId === workerId && record.handle.sessionId === adapterSessionId && record.activeSendLeases > 0;
  }

  private waitForAdapterSessionSendLease(adapterKey: string): Promise<void> {
    const managedSessionId = this.adapterSessionIds.get(adapterKey);
    const record = managedSessionId ? this.sessions.get(managedSessionId) : undefined;
    if (!record || record.activeSendLeases <= 0) return Promise.resolve();
    return new Promise<void>(resolve => {
      const waiters = this.adapterSessionSendLeaseWaiters.get(adapterKey) ?? new Set<() => void>();
      const done = () => {
        waiters.delete(done);
        if (waiters.size === 0) this.adapterSessionSendLeaseWaiters.delete(adapterKey);
        resolve();
      };
      waiters.add(done);
      this.adapterSessionSendLeaseWaiters.set(adapterKey, waiters);
      const currentManagedSessionId = this.adapterSessionIds.get(adapterKey);
      const current = currentManagedSessionId ? this.sessions.get(currentManagedSessionId) : undefined;
      if (!current || current.activeSendLeases <= 0) done();
    });
  }

  private notifyAdapterSessionSendLeaseIdle(adapterKey: string): void {
    const waiters = this.adapterSessionSendLeaseWaiters.get(adapterKey);
    if (!waiters) return;
    for (const resolve of [...waiters]) resolve();
  }

  private async *sendWithLifecycle(
    managedSessionId: string,
    workerId: string,
    adapterSessionId: string,
    input: WorkerInput,
  ): AsyncIterable<WorkerEvent> {
    const adapterKey = this.adapterSessionKey(workerId, adapterSessionId);
    let record: ManagedWorkerSessionRecord | undefined;
    let adapterEvents: AsyncIterable<WorkerEvent> | undefined;
    let leaseAcquired = false;
    const sendLeaseToken = Symbol(`send:${managedSessionId}:${input.inputId}`);
    const interruptOwnership: ManagedSendInterruptOwnership = { inputId: input.inputId };
    let providerIterator: AsyncIterator<WorkerEvent> | undefined;
    let terminalObserved = false;
    let providerTerminalObserved = false;
    let providerIteratorEnded = false;
    const projectionState: WorkerExecutionProjectionState = { occurrence: 0, executions: [] };
    const startedAt = Date.now();

    try {
      await this.exclusiveAdapterSession(adapterKey, async () => {
        const current = this.requireSameSession(managedSessionId, workerId, adapterSessionId);
        await this.assertAdapterSessionAliveLocked(current, "start a send");
        if (current.abandonedSendCleanups.size > 0) {
          throw new Error(`Worker session ${managedSessionId} has unresolved abandoned provider input; canonical interruption is required before a new send.`);
        }

        await this.options.beforeSend?.(this.getSession(managedSessionId)!, input);
        this.requireSameSession(managedSessionId, workerId, adapterSessionId);

        current.activeSendLeases += 1;
        // Idle alone cannot turn an ambiguous provider send into replacement authority.
        (current.unsettledReplacementSends ??= new Set()).add(sendLeaseToken);
        current.activeSendLeaseTokens.add(sendLeaseToken);
        current.sendInterruptOwnership.set(sendLeaseToken, interruptOwnership);
        current.conversationTurnCount += 1;
        current.conversationObservedChars += input.prompt.length;
        record = current;
        leaseAcquired = true;
        try {
          // Adapter send is intentionally invoked only after the first actual
          // consumption has revalidated lifecycle ownership and acquired the
          // provider-native send lease. This revokes pre-retirement lazy send
          // capabilities before they can even create/start provider work.
          adapterEvents = this.requireWorker(workerId).adapter.send(current.handle, input);
        } catch (error) {
          current.activeSendLeases -= 1;
          current.activeSendLeaseTokens.delete(sendLeaseToken);
          current.sendInterruptOwnership.delete(sendLeaseToken);
          if (current.activeSendLeases <= 0) this.notifyAdapterSessionSendLeaseIdle(adapterKey);
          leaseAcquired = false;
          throw error;
        }
      });

      providerIterator = adapterEvents![Symbol.asyncIterator]();

      while (true) {
        let next: IteratorResult<WorkerEvent>;
        try {
          next = await providerIterator.next();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          record!.conversationLastProviderError = message.slice(0, 20_000);
          record!.conversationObservedChars += Math.min(20_000, message.length);
          // This catch is now exclusively around the raw adapter iterator.
          // A non-running adapter handle is therefore lower-layer evidence that
          // provider work already converged; Manager routing/projection errors
          // occur after this block and must take the abandonment cleanup path.
          if (record!.handle.state !== "running") providerIteratorEnded = true;
          throw error;
        }
        if (next.done) {
          providerIteratorEnded = true;
          break;
        }
        const providerEvent = next.value;
        if (providerEvent.type === "text_delta" || providerEvent.type === "reasoning_delta") {
          record!.conversationObservedChars += providerEvent.text.length;
        } else if (providerEvent.type === "terminal" && providerEvent.error) {
          record!.conversationLastProviderError = providerEvent.error.slice(0, 20_000);
          record!.conversationObservedChars += Math.min(20_000, providerEvent.error.length);
        }
        if (providerEvent.type === "terminal") providerTerminalObserved = true;
        const event = await this.routeWorkerEvent(
          record!,
          input,
          providerEvent,
          sendLeaseToken,
          projectionState,
        );
        if (event.type === "terminal") {
          terminalObserved = true;
          try { this.options.observeTurn?.({ workerId, model: record!.handle.model, durationMs: Date.now() - startedAt,
            status: event.status, observedAt: this.now(), basis: "managed-provider-turn" }); }
          catch { /* Observation cannot alter owning delivery or terminal facts. */ }
          try {
            await providerIterator.return?.();
            if (event.status === "completed" || event.status === "cancelled") {
              record!.unsettledReplacementSends?.delete(sendLeaseToken);
            }
          } finally {
            providerIterator = undefined;
            await this.releaseSendLease(adapterKey, record!, sendLeaseToken);
            leaseAcquired = false;
          }
          yield event;
          return;
        }
        yield event;
      }
    } finally {
      if (leaseAcquired && record && providerIterator && !terminalObserved && !providerTerminalObserved && !providerIteratorEnded) {
        const cleanup: AbandonedSendCleanup = {
          inputId: input.inputId,
          adapterKey,
          providerIterator,
        };
        record.abandonedSendCleanups.set(sendLeaseToken, cleanup);
        try {
          await this.interruptManagedSend(record, sendLeaseToken, interruptOwnership);
        } catch (error) {
          // Fail closed: retain the exact provider input identity, pending host
          // capability ownership, routed iterator, interrupt-attempt ownership
          // and Manager send lease. Concurrent callers join this exact attempt;
          // a later canonical interrupt(managedSessionId) may start one retry
          // only after the failed attempt has settled.
          throw error;
        }
        await this.finalizeAbandonedSend(record, sendLeaseToken, cleanup);
        providerIterator = undefined;
        leaseAcquired = false;
      }
      try {
        await providerIterator?.return?.();
      } finally {
        if (leaseAcquired && record) await this.releaseSendLease(adapterKey, record, sendLeaseToken);
      }
    }
  }

  private async releaseSendLease(adapterKey: string, record: ManagedWorkerSessionRecord, sendLeaseToken: symbol): Promise<void> {
    await this.exclusiveAdapterSession(adapterKey, async () => {
      if (record.activeSendLeaseTokens.delete(sendLeaseToken)) {
        record.activeSendLeases = Math.max(0, record.activeSendLeases - 1);
      }
      record.sendInterruptOwnership.delete(sendLeaseToken);
      for (const [key, pending] of record.hostCapabilityRequests) {
        if (pending.sendLeaseToken === sendLeaseToken) record.hostCapabilityRequests.delete(key);
      }
      if (record.activeSendLeases === 0) this.notifyAdapterSessionSendLeaseIdle(adapterKey);
    });
  }

  private interruptManagedSend(
    record: ManagedWorkerSessionRecord,
    sendLeaseToken: symbol,
    ownership: ManagedSendInterruptOwnership,
  ): Promise<void> {
    const existing = ownership.attempt;
    if (existing?.state === "in-flight" || existing?.state === "succeeded") {
      return existing.promise;
    }

    const attempt = {} as ManagedSendInterruptAttempt;
    attempt.state = "in-flight";
    attempt.promise = this.exclusiveAdapterSession(
      this.adapterSessionKey(record.workerId, record.handle.sessionId),
      async () => {
        const current = this.requireSameSession(record.managedSessionId, record.workerId, record.handle.sessionId);
        if (!current.activeSendLeaseTokens.has(sendLeaseToken)) return;
        if (current.sendInterruptOwnership.get(sendLeaseToken) !== ownership) {
          throw new Error(`Worker session ${record.managedSessionId} lost exact interrupt ownership for input ${ownership.inputId}.`);
        }
        await this.requireWorker(current.workerId).adapter.interrupt(current.handle);
      },
    ).then(
      () => {
        attempt.state = "succeeded";
        attempt.error = undefined;
      },
      error => {
        attempt.state = "failed";
        attempt.error = error;
        throw error;
      },
    );
    ownership.attempt = attempt;
    return attempt.promise;
  }

  private finalizeAbandonedSend(
    record: ManagedWorkerSessionRecord,
    sendLeaseToken: symbol,
    cleanup: AbandonedSendCleanup,
  ): Promise<void> {
    if (cleanup.finalizePromise) return cleanup.finalizePromise;
    cleanup.finalizePromise = (async () => {
      let iteratorError: unknown;
      try {
        await cleanup.providerIterator.return?.();
        record.unsettledReplacementSends?.delete(sendLeaseToken);
      } catch (error) {
        iteratorError = error;
      } finally {
        if (record.abandonedSendCleanups.get(sendLeaseToken) === cleanup) {
          record.abandonedSendCleanups.delete(sendLeaseToken);
        }
        await this.releaseSendLease(cleanup.adapterKey, record, sendLeaseToken);
      }
      if (iteratorError) throw iteratorError;
    })();
    return cleanup.finalizePromise;
  }

  private async routeWorkerEvent(
    record: ManagedWorkerSessionRecord,
    input: WorkerInput,
    event: WorkerEvent,
    sendLeaseToken: symbol,
    state: WorkerExecutionProjectionState,
  ): Promise<WorkerEvent> {
    if (event.type === "capability_call" && event.dispatch === "host-requested") {
      if (!event.callId) throw new Error(`Worker ${record.workerId} emitted host-requested capability ${event.name} without callId.`);
      const occurrenceId = this.workerOccurrenceId(event.extensions);
      const routeMatches = [...record.hostCapabilityRequests.values()]
        .filter(candidate => candidate.inputId === input.inputId && candidate.callId === event.callId);
      const crossLease = routeMatches.find(candidate => candidate.sendLeaseToken !== sendLeaseToken);
      if (crossLease) {
        throw new Error(`Worker ${record.workerId} reused host-requested call identity ${event.callId} for input ${input.inputId} across active sends.`);
      }
      const routeNameMismatch = routeMatches.find(candidate => candidate.name !== event.name);
      if (routeNameMismatch) {
        throw new Error(`Worker ${record.workerId} reused host-requested callId ${event.callId} for a different capability.`);
      }
      if (!occurrenceId && routeMatches.some(candidate => !!candidate.occurrenceId)) {
        throw new Error(`Worker ${record.workerId} emitted reused host-requested call identity ${event.callId} without exact logical-occurrence authority.`);
      }
      const key = this.hostCapabilityRequestKey(input.inputId, event.callId, occurrenceId);
      const existing = record.hostCapabilityRequests.get(key);
      if (existing && existing.sendLeaseToken !== sendLeaseToken) {
        throw new Error(`Worker ${record.workerId} reused host-requested call identity ${event.callId} for input ${input.inputId} across active sends.`);
      }
      if (existing && existing.name !== event.name) {
        throw new Error(`Worker ${record.workerId} reused host-requested callId ${event.callId} for a different capability.`);
      }
      if (!existing) record.hostCapabilityRequests.set(key, {
        inputId: input.inputId,
        callId: event.callId,
        name: event.name,
        occurrenceId,
        sendLeaseToken,
      });
    }

    const taskId = record.taskId;
    const projection = this.options.executionProjection;
    if (!taskId || !projection) return event;

    const findResultTarget = (event: Extract<WorkerEvent, { type: "capability_result" }>) => {
      const occurrenceId = this.workerOccurrenceId(event.extensions);
      return state.executions.find(item => !item.resultSeen
        && (occurrenceId ? item.occurrenceId === occurrenceId : event.callId ? item.callId === event.callId : item.name === event.name));
    };
    const findDeliveryTarget = (callId: string | undefined, name: string | undefined, occurrenceId: string | undefined) =>
      state.executions.find(item => item.resultSeen && !item.delivered
        && (occurrenceId ? item.occurrenceId === occurrenceId : callId ? item.callId === callId : !!name && item.name === name));

    if (event.type === "capability_call") {
      state.occurrence += 1;
      const executionId = `worker:${record.managedSessionId}:${input.inputId}:${state.occurrence}`;
      const hostOwned = event.dispatch === "host-requested";
      const occurrenceId = this.workerOccurrenceId(event.extensions);
      state.executions.push({ executionId, callId: event.callId, name: event.name, occurrenceId, hostOwned, resultSeen: false, delivered: false });
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
      return {
        ...event,
        extensions: { ...event.extensions, executionId },
      };
    } else if (event.type === "capability_result") {
      let target = findResultTarget(event);
      if (!target) {
        state.occurrence += 1;
        target = {
          executionId: `worker:${record.managedSessionId}:${input.inputId}:${state.occurrence}`,
          callId: event.callId,
          name: event.name,
          occurrenceId: this.workerOccurrenceId(event.extensions),
          hostOwned: false,
          resultSeen: false,
          delivered: false,
        };
        state.executions.push(target);
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
      const occurrenceId = typeof data.occurrenceId === "string" && data.occurrenceId.trim() ? data.occurrenceId : undefined;
      const target = findDeliveryTarget(callId, name, occurrenceId);
      if (target) {
        target.delivered = true;
        if (!target.hostOwned) await projection.markWorkerExecutionDelivered(taskId, target.executionId);
      }
    } else if (event.type === "terminal") {
      for (const target of state.executions) {
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
    return event;
  }

  private hostCapabilityRequestKey(inputId: string, callId: string, occurrenceId?: string): string {
    return occurrenceId
      ? `${inputId}\u0000${callId}\u0000occurrence:${occurrenceId}`
      : `${inputId}\u0000${callId}`;
  }

  private workerOccurrenceId(extensions: Record<string, unknown> | undefined): string | undefined {
    const value = typeof extensions?.occurrenceId === "string" ? extensions.occurrenceId.trim() : "";
    if (!value) return undefined;
    if (value.length > 4096) throw new Error("Worker logical occurrence authority exceeds the bounded limit.");
    return value;
  }

  private newId(): string {
    return (this.options.newId ?? randomUUID)();
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }
}
