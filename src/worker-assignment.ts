import type { TaskSnapshot } from "./task-contract.js";
import type { TaskRuntime } from "./task-runtime.js";
import type {
  WorkerCapabilities,
  WorkerDescriptor,
  WorkerKind,
  WorkerSessionOptions,
} from "./worker-contract.js";
import type { ManagedWorkerSession, WorkerSessionManager } from "./worker-session-manager.js";

const MAX_ID_CHARS = 240;
const MAX_PROVIDER_CHARS = 240;
const MAX_MODEL_CHARS = 240;
const MAX_LIST_ITEMS = 64;

const WORKER_KINDS = new Set<WorkerKind>(["web", "api", "local", "agent-host", "remote"]);
const missionAssignmentLanes = new Map<string, Promise<void>>();
const CAPABILITY_KEYS = [
  "streaming",
  "reasoning",
  "capabilityRequests",
  "imageInput",
  "checkpoints",
  "interruption",
  "persistentContext",
] as const;

export type WorkerAssignmentCapabilityKey = typeof CAPABILITY_KEYS[number];
export type WorkerAssignmentAvailability = "available" | "degraded" | "unavailable" | "offline";

export interface WorkerAssignmentCapabilities extends Pick<WorkerCapabilities, WorkerAssignmentCapabilityKey> {}

export interface WorkerAssignmentHealthObservation {
  status: "healthy" | "degraded" | "offline";
  checkedAt: string;
  message?: string;
}

export interface WorkerAssignmentCandidate {
  candidateId: string;
  workerId: string;
  provider: string;
  kind: WorkerKind;
  availability: WorkerAssignmentAvailability;
  models: readonly string[];
  capabilities: WorkerAssignmentCapabilities;
  observationId: string;
  observedAt: string;
  health?: WorkerAssignmentHealthObservation;
}

export interface WorkerAssignmentConstraints {
  allowedKinds?: readonly WorkerKind[];
  allowedProviders?: readonly string[];
  forbiddenProviders?: readonly string[];
  requiredModel?: string;
  requiredCapabilities?: Partial<Record<WorkerAssignmentCapabilityKey, boolean>>;
}

export interface WorkerAssignmentPreferences {
  providerOrder?: readonly string[];
  modelOrder?: readonly string[];
}

export interface WorkerAssignmentRequest {
  projectId: string;
  rootMissionId: string;
  missionId: string;
  constraints?: WorkerAssignmentConstraints;
  preferences?: WorkerAssignmentPreferences;
}

export interface WorkerAssignmentSelection {
  model?: string;
}

/**
 * Candidate sources own provider/resource observation and opaque adapter options.
 * They do not own WorkerSession lifecycle after materialization.
 */
export interface WorkerAssignmentCandidateSource {
  enumerateCandidates(): Promise<readonly WorkerAssignmentCandidate[]>;
  refreshCandidate(candidate: WorkerAssignmentCandidate): Promise<WorkerAssignmentCandidate | undefined>;
  materializeSessionOptions(candidate: WorkerAssignmentCandidate, selection: WorkerAssignmentSelection): Promise<WorkerSessionOptions>;
}

export interface WorkerAssignmentResult {
  missionId: string;
  candidateId: string;
  workerId: string;
  provider: string;
  model?: string;
  managedSessionId: string;
}

export class WorkerAssignmentCandidateUnavailableError extends Error {
  constructor(message = "Worker assignment candidate is unavailable before session creation.") {
    super(message);
    this.name = "WorkerAssignmentCandidateUnavailableError";
  }
}

export class WorkerAssignmentNoAdmissibleCandidateError extends Error {
  constructor(message = "No admissible Worker assignment candidate is currently available.") {
    super(message);
    this.name = "WorkerAssignmentNoAdmissibleCandidateError";
  }
}

export class WorkerAssignmentConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerAssignmentConflictError";
  }
}

export class WorkerAssignmentCreateFailedError extends Error {
  readonly originalError: unknown;

  constructor(candidateId: string, error: unknown) {
    super(`WorkerSession creation/binding failed for candidate ${candidateId}; automatic fallback is not authorized: ${error instanceof Error ? error.message : String(error)}`);
    this.name = "WorkerAssignmentCreateFailedError";
    this.originalError = error;
  }
}

export class WorkerAssignmentBoundSessionInvalidError extends Error {
  readonly managedSessionId: string;
  readonly cleanupError: unknown;

  constructor(candidateId: string, managedSessionId: string, problem: string, cleanupError?: unknown) {
    super(cleanupError === undefined
      ? `Bound WorkerSession ${managedSessionId} for candidate ${candidateId} violates assignment constraints and was rejected: ${problem}`
      : `Bound WorkerSession ${managedSessionId} for candidate ${candidateId} violates assignment constraints and lifecycle cleanup is uncertain: ${problem}; ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    this.name = "WorkerAssignmentBoundSessionInvalidError";
    this.managedSessionId = managedSessionId;
    this.cleanupError = cleanupError;
  }
}

interface NormalizedWorkerAssignmentRequest {
  projectId: string;
  rootMissionId: string;
  missionId: string;
  constraints: {
    allowedKinds?: WorkerKind[];
    allowedProviders?: string[];
    forbiddenProviders?: string[];
    requiredModel?: string;
    requiredCapabilities: Partial<Record<WorkerAssignmentCapabilityKey, boolean>>;
  };
  preferences: {
    providerOrder: string[];
    modelOrder: string[];
  };
}

interface CandidateRecord {
  source: WorkerAssignmentCandidateSource;
  candidate: WorkerAssignmentCandidate;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error(`${label} must be a plain record.`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !("value" in Object.getOwnPropertyDescriptor(value, key)!)) throw new Error(`${label} must contain own data fields only.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unsupported = Object.getOwnPropertyNames(row).filter(key => !allowedSet.has(key));
  if (unsupported.length) throw new Error(`${label} contains unsupported key(s): ${unsupported.sort().join(", ")}.`);
}

function boundedString(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters.`);
  return normalized;
}

function boundedStringList(value: unknown, label: string, maxChars: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (value.length > MAX_LIST_ITEMS) throw new Error(`${label} must contain at most ${MAX_LIST_ITEMS} items.`);
  for (const key of Reflect.ownKeys(value)) {
    if (key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key))) throw new Error(`${label} contains an unsupported array field.`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label}[${index}] must be an own data item.`);
    const normalized = boundedString(descriptor.value, `${label}[${index}]`, maxChars);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeKindList(value: unknown, label: string): WorkerKind[] | undefined {
  const values = boundedStringList(value, label, 32);
  if (!values) return undefined;
  return values.map(value => {
    if (!WORKER_KINDS.has(value as WorkerKind)) throw new Error(`${label} contains unsupported Worker kind: ${value}.`);
    return value as WorkerKind;
  });
}

function normalizeCapabilities(value: unknown, label: string): WorkerAssignmentCapabilities {
  const row = plainRecord(value, label);
  exactKeys(row, CAPABILITY_KEYS, label);
  const result = {} as WorkerAssignmentCapabilities;
  for (const key of CAPABILITY_KEYS) {
    if (typeof row[key] !== "boolean") throw new Error(`${label}.${key} must be boolean.`);
    result[key] = row[key] as boolean;
  }
  return result;
}

function normalizeCapabilityRequirements(value: unknown): Partial<Record<WorkerAssignmentCapabilityKey, boolean>> {
  if (value === undefined) return {};
  const row = plainRecord(value, "Assignment requiredCapabilities");
  exactKeys(row, CAPABILITY_KEYS, "Assignment requiredCapabilities");
  const result: Partial<Record<WorkerAssignmentCapabilityKey, boolean>> = {};
  for (const [key, expected] of Object.entries(row)) {
    if (typeof expected !== "boolean") throw new Error(`Assignment requiredCapabilities.${key} must be boolean.`);
    result[key as WorkerAssignmentCapabilityKey] = expected;
  }
  return result;
}

function normalizeRequest(input: WorkerAssignmentRequest): NormalizedWorkerAssignmentRequest {
  const row = plainRecord(input, "Worker assignment request");
  exactKeys(row, ["projectId", "rootMissionId", "missionId", "constraints", "preferences"], "Worker assignment request");

  const constraintRow = input.constraints === undefined ? {} : plainRecord(input.constraints, "Worker assignment constraints");
  exactKeys(constraintRow, ["allowedKinds", "allowedProviders", "forbiddenProviders", "requiredModel", "requiredCapabilities"], "Worker assignment constraints");
  const preferenceRow = input.preferences === undefined ? {} : plainRecord(input.preferences, "Worker assignment preferences");
  exactKeys(preferenceRow, ["providerOrder", "modelOrder"], "Worker assignment preferences");

  const allowedKinds = normalizeKindList(constraintRow.allowedKinds, "Assignment allowedKinds");
  const allowedProviders = boundedStringList(constraintRow.allowedProviders, "Assignment allowedProviders", MAX_PROVIDER_CHARS);
  if (allowedKinds?.length === 0) throw new Error("Assignment allowedKinds must not be empty when provided.");
  if (allowedProviders?.length === 0) throw new Error("Assignment allowedProviders must not be empty when provided.");

  return {
    projectId: boundedString(input.projectId, "Project id", MAX_ID_CHARS),
    rootMissionId: boundedString(input.rootMissionId, "Root Mission id", MAX_ID_CHARS),
    missionId: boundedString(input.missionId, "Mission id", MAX_ID_CHARS),
    constraints: {
      allowedKinds,
      allowedProviders,
      forbiddenProviders: boundedStringList(constraintRow.forbiddenProviders, "Assignment forbiddenProviders", MAX_PROVIDER_CHARS),
      requiredModel: constraintRow.requiredModel === undefined ? undefined : boundedString(constraintRow.requiredModel, "Assignment requiredModel", MAX_MODEL_CHARS),
      requiredCapabilities: normalizeCapabilityRequirements(constraintRow.requiredCapabilities),
    },
    preferences: {
      providerOrder: boundedStringList(preferenceRow.providerOrder, "Assignment providerOrder", MAX_PROVIDER_CHARS) ?? [],
      modelOrder: boundedStringList(preferenceRow.modelOrder, "Assignment modelOrder", MAX_MODEL_CHARS) ?? [],
    },
  };
}

/** Policy construction seam shared by user and Cognition applications. */
export function normalizeWorkerAssignmentRequest(input: WorkerAssignmentRequest): WorkerAssignmentRequest {
  return normalizeRequest(input);
}

function normalizeDate(value: unknown, label: string): string {
  const normalized = boundedString(value, label, 64);
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(`${label} must be an ISO-compatible timestamp.`);
  return normalized;
}

function normalizeCandidate(input: WorkerAssignmentCandidate): WorkerAssignmentCandidate {
  const row = plainRecord(input, "Worker assignment candidate");
  exactKeys(row, ["candidateId", "workerId", "provider", "kind", "availability", "models", "capabilities", "observationId", "observedAt", "health"], "Worker assignment candidate");
  const kind = boundedString(input.kind, "Candidate kind", 32);
  if (!WORKER_KINDS.has(kind as WorkerKind)) throw new Error(`Candidate kind is unsupported: ${kind}.`);
  const availability = boundedString(input.availability, "Candidate availability", 32);
  if (availability !== "available" && availability !== "degraded" && availability !== "unavailable" && availability !== "offline") {
    throw new Error(`Candidate availability is unsupported: ${availability}.`);
  }
  const models = boundedStringList(input.models, "Candidate models", MAX_MODEL_CHARS);
  if (!models) throw new Error("Candidate models are required.");

  let health: WorkerAssignmentHealthObservation | undefined;
  if (input.health !== undefined) {
    const healthRow = plainRecord(input.health, "Candidate health");
    exactKeys(healthRow, ["status", "checkedAt", "message"], "Candidate health");
    const status = boundedString(input.health.status, "Candidate health status", 32);
    if (status !== "healthy" && status !== "degraded" && status !== "offline") throw new Error(`Candidate health status is unsupported: ${status}.`);
    health = {
      status,
      checkedAt: normalizeDate(input.health.checkedAt, "Candidate health checkedAt"),
      ...(input.health.message === undefined ? {} : { message: boundedString(input.health.message, "Candidate health message", 1_000) }),
    };
  }

  return {
    candidateId: boundedString(input.candidateId, "Candidate id", MAX_ID_CHARS),
    workerId: boundedString(input.workerId, "Candidate worker id", MAX_ID_CHARS),
    provider: boundedString(input.provider, "Candidate provider", MAX_PROVIDER_CHARS),
    kind: kind as WorkerKind,
    availability: availability as WorkerAssignmentAvailability,
    models,
    capabilities: normalizeCapabilities(input.capabilities, "Candidate capabilities"),
    observationId: boundedString(input.observationId, "Candidate observation id", MAX_ID_CHARS),
    observedAt: normalizeDate(input.observedAt, "Candidate observedAt"),
    health,
  };
}

function rankOf(order: readonly string[], value: string): number {
  const index = order.indexOf(value);
  return index < 0 ? Number.MAX_SAFE_INTEGER : index;
}

function preferredModelRank(order: readonly string[], candidate: WorkerAssignmentCandidate): number {
  let rank = Number.MAX_SAFE_INTEGER;
  for (const model of candidate.models) rank = Math.min(rank, rankOf(order, model));
  return rank;
}

function selectedModel(request: NormalizedWorkerAssignmentRequest, candidate: WorkerAssignmentCandidate): string | undefined {
  if (request.constraints.requiredModel) return request.constraints.requiredModel;
  return request.preferences.modelOrder.find(model => candidate.models.includes(model));
}

function hardConstraintsMatch(request: NormalizedWorkerAssignmentRequest, candidate: WorkerAssignmentCandidate): boolean {
  const { constraints } = request;
  if (constraints.allowedKinds !== undefined && !constraints.allowedKinds.includes(candidate.kind)) return false;
  if (constraints.allowedProviders !== undefined && !constraints.allowedProviders.includes(candidate.provider)) return false;
  if (constraints.forbiddenProviders?.includes(candidate.provider)) return false;
  if (constraints.requiredModel && !candidate.models.includes(constraints.requiredModel)) return false;
  for (const [key, expected] of Object.entries(constraints.requiredCapabilities)) {
    if (candidate.capabilities[key as WorkerAssignmentCapabilityKey] !== expected) return false;
  }
  return true;
}

/**
 * Re-evaluate an already-bound exact WorkerSession against the same normalized
 * hard request semantics without rediscovering candidates or inventing
 * candidate-level facts that are no longer reconstructible from current
 * canonical/live truth.
 */
export function assertExistingWorkerAssignmentHardConstraints(
  input: WorkerAssignmentRequest,
  descriptor: WorkerDescriptor,
  session: ManagedWorkerSession,
): void {
  const request = normalizeRequest(input);
  if (session.taskId !== request.missionId) {
    throw new WorkerAssignmentConflictError(`Existing WorkerSession ${session.managedSessionId} is bound to ${session.taskId ?? "no Task"}, not Mission ${request.missionId}.`);
  }
  if (descriptor.id !== session.workerId) {
    throw new WorkerAssignmentConflictError(`Existing WorkerSession ${session.managedSessionId} belongs to Worker ${session.workerId}, not refreshed Worker definition ${descriptor.id}.`);
  }
  if (request.constraints.allowedKinds !== undefined && !request.constraints.allowedKinds.includes(descriptor.kind)) {
    throw new WorkerAssignmentConflictError(`Existing Worker kind ${descriptor.kind} violates the current allowedKinds hard constraint.`);
  }
  if (request.constraints.requiredModel !== undefined) {
    if (session.model !== request.constraints.requiredModel) {
      throw new WorkerAssignmentConflictError(`Existing WorkerSession model ${String(session.model)} violates requiredModel ${request.constraints.requiredModel}.`);
    }
    if (descriptor.models !== undefined && !descriptor.models.includes(request.constraints.requiredModel)) {
      throw new WorkerAssignmentConflictError(`Refreshed Worker definition no longer admits requiredModel ${request.constraints.requiredModel}.`);
    }
  }
  for (const [key, expected] of Object.entries(request.constraints.requiredCapabilities)) {
    const actual = descriptor.capabilities[key as WorkerAssignmentCapabilityKey];
    if (actual !== expected) {
      throw new WorkerAssignmentConflictError(`Existing Worker capability ${key}=${String(actual)} violates required hard value ${String(expected)}.`);
    }
  }
  if (request.constraints.allowedProviders !== undefined || (request.constraints.forbiddenProviders?.length ?? 0) > 0) {
    throw new WorkerAssignmentConflictError(
      "Existing assignment candidate provider is not reconstructible from current canonical/live Worker truth; provider hard constraints cannot be proven without rediscovery or a forbidden provider-history owner.",
    );
  }
}

function definitionAdmitsCandidate(
  descriptor: WorkerDescriptor,
  request: NormalizedWorkerAssignmentRequest,
  candidate: WorkerAssignmentCandidate,
  model: string | undefined,
): boolean {
  if (descriptor.availability !== "available" || descriptor.kind !== candidate.kind) return false;
  for (const [key, expected] of Object.entries(request.constraints.requiredCapabilities)) {
    if (descriptor.capabilities[key as WorkerAssignmentCapabilityKey] !== expected) return false;
  }
  for (const key of CAPABILITY_KEYS) {
    if (candidate.capabilities[key] && !descriptor.capabilities[key]) return false;
  }
  if (descriptor.models !== undefined) {
    if (candidate.models.some(candidateModel => !descriptor.models!.includes(candidateModel))) return false;
    if (request.constraints.requiredModel && !descriptor.models.includes(request.constraints.requiredModel)) return false;
    if (model && !descriptor.models.includes(model)) return false;
  }
  return true;
}

function isFreshHealthy(observed: WorkerAssignmentCandidate, candidate: WorkerAssignmentCandidate): boolean {
  if (candidate.observationId === observed.observationId) return false;
  if (Date.parse(candidate.observedAt) < Date.parse(observed.observedAt)) return false;
  if (!candidate.health || Date.parse(candidate.health.checkedAt) < Date.parse(candidate.observedAt)) return false;
  return candidate.availability === "available" && candidate.health.status === "healthy";
}

function activeWorkerRefs(task: TaskSnapshot): string[] {
  return Object.values(task.workerSessions)
    .filter(worker => !worker.detachedAt && !worker.retiredAt)
    .map(worker => worker.managedSessionId)
    .sort();
}

/**
 * Provider-neutral initial Worker assignment. This service owns no durable state:
 * TaskRuntime remains Mission/lifecycle truth and WorkerSessionManager remains the
 * only live WorkerSession owner. The reconstructible in-memory lane serializes
 * concurrent initial assignment calls for one Mission within this process.
 */
export class MissionWorkerAssignmentService {
  constructor(
    private readonly tasks: TaskRuntime,
    private readonly workers: WorkerSessionManager,
    private readonly candidateSources: readonly WorkerAssignmentCandidateSource[],
    private readonly softLatency?: (candidate: WorkerAssignmentCandidate) => number | undefined,
  ) {}

  async assignInitial(input: WorkerAssignmentRequest): Promise<WorkerAssignmentResult> {
    const request = normalizeRequest(input);
    return this.withMissionLane(request, () => this.assignInitialLocked(request));
  }

  /**
   * Human-approved recovery of a formed-only Project from one exact, freshly
   * opened and native-shared page. All other healthy candidates are excluded,
   * including any formerly ambiguous Cognition conversation. Shares the same
   * per-Mission assignment lane and fail-closed create/bind semantics.
   */
  async assignInitialRestricted(input: WorkerAssignmentRequest, exactCandidateId: string): Promise<WorkerAssignmentResult> {
    const request = normalizeRequest(input);
    const exact = boundedString(exactCandidateId, "Exact approved Worker candidate id", MAX_ID_CHARS);
    if (!/^webmcp:[a-f0-9]{64}$/.test(exact)) throw new Error("Exact recovery candidate must be a WebMCP page identity.");
    return this.withMissionLane(request, () => this.assignInitialLocked(request, exact));
  }

  /** Explicit replacement, serialized with initial assignment; never an automatic fallback. */
  async replaceSettled(input: WorkerAssignmentRequest, expectedManagedSessionId: string): Promise<WorkerAssignmentResult> {
    const request = normalizeRequest(input);
    const expected = boundedString(expectedManagedSessionId, "Expected managed session id", MAX_ID_CHARS);
    return this.withMissionLane(request, async () => {
      await this.assertMissionAssignable(request);
      const old = this.workers.getSession(expected);
      if (!old || old.taskId !== request.missionId) throw new WorkerAssignmentConflictError("Replacement requires the exact live assigned Worker; missing runtime ownership is UNKNOWN.");
      const identity = { workerId: old.workerId, adapterSessionId: old.adapterSessionId };
      await this.workers.withAdapterSessionRetirementScope([identity], async scope => {
        await this.assertMissionAssignable(request);
        const task = this.tasks.getTask(request.missionId)!;
        const current = scope.getSession(identity);
        const durable = activeWorkerRefs(task);
        const live = this.workers.listSessions({ taskId: request.missionId });
        if (!current || current.managedSessionId !== expected || current.taskId !== request.missionId
          || durable.length !== 1 || durable[0] !== expected || live.length !== 1 || live[0].managedSessionId !== expected
          || task.workerSessions[expected].workerId !== old.workerId || task.workerSessions[expected].adapterSessionId !== old.adapterSessionId) {
          throw new WorkerAssignmentConflictError("Replacement assignment identity changed or is incoherent.");
        }
        if (!scope.isKnownSettled(identity) || scope.hasActiveSendLease(identity)
          || Object.values(task.executions).some(execution => !["succeeded", "failed"].includes(execution.status)
            || execution.deliveryStatus === "unknown" || execution.deliveryStatus === "pending")
          || Object.values(task.interactions).some(interaction => !interaction.finishedAt)) {
          throw new WorkerAssignmentConflictError("Replacement requires known-settled work; running, pending, or UNKNOWN work cannot authorize replacement.");
        }
        const retired = await scope.retire(identity, { reason: "explicit-same-mission-worker-replacement" });
        if (!retired || retired.managedSessionId !== expected || retired.ownershipPersistenceError || retired.disposeError) {
          throw new WorkerAssignmentConflictError("Replacement stopped after retirement: cleanup or ownership outcome is unresolved; no new Worker was created.");
        }
      });
      return this.assignInitialLocked(request);
    });
  }

  /** Same replacement proof as replaceSettled, but the successor must be one exact freshly observed candidate. */
  async replaceSettledRestricted(input: WorkerAssignmentRequest, expectedManagedSessionId: string, exactCandidateId: string): Promise<WorkerAssignmentResult> {
    const request = normalizeRequest(input);
    const expected = boundedString(expectedManagedSessionId, "Expected managed session id", MAX_ID_CHARS);
    const exact = boundedString(exactCandidateId, "Exact replacement candidate id", MAX_ID_CHARS);
    return this.withMissionLane(request, async () => {
      await this.assertMissionAssignable(request);
      const old = this.workers.getSession(expected);
      if (!old || old.taskId !== request.missionId) throw new WorkerAssignmentConflictError("Replacement requires the exact live assigned Worker; missing runtime ownership is UNKNOWN.");
      const identity = { workerId: old.workerId, adapterSessionId: old.adapterSessionId };
      await this.workers.withAdapterSessionRetirementScope([identity], async scope => {
        await this.assertMissionAssignable(request);
        const task = this.tasks.getTask(request.missionId)!;
        const current = scope.getSession(identity);
        const durable = activeWorkerRefs(task);
        const live = this.workers.listSessions({ taskId: request.missionId });
        if (!current || current.managedSessionId !== expected || current.taskId !== request.missionId
          || durable.length !== 1 || durable[0] !== expected || live.length !== 1 || live[0].managedSessionId !== expected
          || task.workerSessions[expected].workerId !== old.workerId || task.workerSessions[expected].adapterSessionId !== old.adapterSessionId) {
          throw new WorkerAssignmentConflictError("Replacement assignment identity changed or is incoherent.");
        }
        if (!scope.isKnownSettled(identity) || scope.hasActiveSendLease(identity)
          || Object.values(task.executions).some(execution => !["succeeded", "failed"].includes(execution.status)
            || execution.deliveryStatus === "unknown" || execution.deliveryStatus === "pending")
          || Object.values(task.interactions).some(interaction => !interaction.finishedAt)) {
          throw new WorkerAssignmentConflictError("Replacement requires known-settled work; running, pending, or UNKNOWN work cannot authorize replacement.");
        }
        const retired = await scope.retire(identity, { reason: "explicit-same-mission-worker-replacement" });
        if (!retired || retired.managedSessionId !== expected || retired.ownershipPersistenceError || retired.disposeError) {
          throw new WorkerAssignmentConflictError("Replacement stopped after retirement: cleanup or ownership outcome is unresolved; no new Worker was created.");
        }
      });
      return this.assignInitialLocked(request, exact);
    });
  }

  private async assignInitialLocked(request: NormalizedWorkerAssignmentRequest, exactCandidateId?: string): Promise<WorkerAssignmentResult> {
    await this.assertMissionAssignable(request);
    this.assertNoCurrentAssignment(request.missionId);

    const observed = await this.enumerateCandidates();
    const admissible = observed.filter(record => (exactCandidateId === undefined || record.candidate.candidateId === exactCandidateId)
      && this.initiallyAdmissible(request, record.candidate));
    const latencies = new Map<string, number>();
    if (this.softLatency) for (const record of admissible) {
      try { const value = this.softLatency(record.candidate); if (value !== undefined && Number.isFinite(value) && value >= 0) latencies.set(record.candidate.candidateId, value); }
      catch { /* advisory observation cannot suppress an admitted candidate */ }
    }
    const allLatenciesKnown = admissible.length > 1 && latencies.size === admissible.length;
    const ranked = admissible.sort((a, b) => {
        const providerDelta = rankOf(request.preferences.providerOrder, a.candidate.provider) - rankOf(request.preferences.providerOrder, b.candidate.provider);
        if (providerDelta !== 0) return providerDelta;
        const modelDelta = preferredModelRank(request.preferences.modelOrder, a.candidate) - preferredModelRank(request.preferences.modelOrder, b.candidate);
        if (modelDelta !== 0) return modelDelta;
        const latencyA = latencies.get(a.candidate.candidateId), latencyB = latencies.get(b.candidate.candidateId);
        // Only comparable, known successful-turn samples may break a policy
        // tie. Unknown never becomes zero or defeats a hard preference.
        if (allLatenciesKnown && latencyA !== undefined && latencyB !== undefined && latencyA !== latencyB) return latencyA - latencyB;
        return a.candidate.candidateId < b.candidate.candidateId ? -1 : a.candidate.candidateId > b.candidate.candidateId ? 1 : 0;
      });

    for (const record of ranked) {
      let refreshed: WorkerAssignmentCandidate | undefined;
      try {
        const value = await record.source.refreshCandidate(structuredClone(record.candidate));
        refreshed = value ? normalizeCandidate(value) : undefined;
      } catch (error) {
        if (error instanceof WorkerAssignmentCandidateUnavailableError) continue;
        throw error;
      }
      if (!refreshed) continue;
      this.assertStableCandidateIdentity(record.candidate, refreshed);
      this.assertRegisteredCandidate(refreshed);
      if (!hardConstraintsMatch(request, refreshed) || !isFreshHealthy(record.candidate, refreshed)) continue;

      const model = selectedModel(request, refreshed);
      let options: WorkerSessionOptions;
      try {
        options = await record.source.materializeSessionOptions(structuredClone(refreshed), { model });
      } catch (error) {
        if (error instanceof WorkerAssignmentCandidateUnavailableError) continue;
        throw error;
      }
      if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error(`Candidate ${refreshed.candidateId} returned invalid WorkerSessionOptions.`);
      if (model && options.model !== model) {
        throw new Error(`Candidate ${refreshed.candidateId} materialized model ${String(options.model)} instead of selected model ${model}.`);
      }
      if (options.model !== undefined && !refreshed.models.includes(options.model)) {
        throw new Error(`Candidate ${refreshed.candidateId} materialized unadvertised model ${options.model}.`);
      }

      // Recheck after observation/materialization. A concurrent finalizer can still
      // win after this point; WorkerSessionManager -> TaskRuntime is the final
      // linearization authority and must reject that race.
      await this.assertMissionAssignable(request);
      this.assertNoCurrentAssignment(request.missionId);

      // WorkerDescriptor fields are observations. Refresh the exact definition
      // immediately before Manager creation. A clear current incompatibility is
      // safe pre-create rejection; refresh errors remain fail-closed and are not
      // fallback authority.
      const freshDefinition = await this.workers.refresh(refreshed.workerId);
      if (!definitionAdmitsCandidate(freshDefinition, request, refreshed, model)) continue;

      let session: ManagedWorkerSession;
      try {
        session = await this.workers.createSession(refreshed.workerId, options, request.missionId);
      } catch (error) {
        // Manager create/bind failures are not candidate fallback authority. The
        // provider or persistence outcome can be ambiguous to this higher layer.
        throw new WorkerAssignmentCreateFailedError(refreshed.candidateId, error);
      }

      this.assertPublishedBinding(request.missionId, session);
      await this.assertAuthoritativeSessionModel(refreshed, model, session);
      return {
        missionId: request.missionId,
        candidateId: refreshed.candidateId,
        workerId: refreshed.workerId,
        provider: refreshed.provider,
        ...(session.model === undefined ? {} : { model: session.model }),
        managedSessionId: session.managedSessionId,
      };
    }

    throw new WorkerAssignmentNoAdmissibleCandidateError();
  }

  private async enumerateCandidates(): Promise<CandidateRecord[]> {
    if (this.candidateSources.length > MAX_LIST_ITEMS) throw new Error(`Worker assignment supports at most ${MAX_LIST_ITEMS} candidate sources.`);
    const result: CandidateRecord[] = [];
    const candidateIds = new Set<string>();
    for (const source of this.candidateSources) {
      const candidates = await source.enumerateCandidates();
      if (!Array.isArray(candidates)) throw new Error("Worker assignment candidate source must return an array.");
      if (candidates.length > MAX_LIST_ITEMS) throw new Error(`Worker assignment candidate source returned more than ${MAX_LIST_ITEMS} candidates.`);
      for (const candidateInput of candidates) {
        if (result.length >= MAX_LIST_ITEMS) throw new Error(`Worker assignment supports at most ${MAX_LIST_ITEMS} total candidates.`);
        const candidate = normalizeCandidate(candidateInput);
        if (candidateIds.has(candidate.candidateId)) throw new Error(`Duplicate Worker assignment candidate id: ${candidate.candidateId}.`);
        candidateIds.add(candidate.candidateId);
        this.assertRegisteredCandidate(candidate);
        result.push({ source, candidate });
      }
    }
    return result;
  }

  private initiallyAdmissible(request: NormalizedWorkerAssignmentRequest, candidate: WorkerAssignmentCandidate): boolean {
    if (candidate.availability !== "available") return false;
    if (candidate.health && candidate.health.status !== "healthy") return false;
    return hardConstraintsMatch(request, candidate);
  }

  private assertRegisteredCandidate(candidate: WorkerAssignmentCandidate): void {
    const descriptor = this.workers.getWorker(candidate.workerId);
    if (!descriptor) throw new Error(`Candidate ${candidate.candidateId} references unregistered worker ${candidate.workerId}.`);
  }

  private async assertAuthoritativeSessionModel(
    candidate: WorkerAssignmentCandidate,
    selected: string | undefined,
    session: ManagedWorkerSession,
  ): Promise<void> {
    const problem = selected !== undefined && session.model !== selected
      ? `authoritative model ${String(session.model)} does not equal selected model ${selected}`
      : session.model !== undefined && !candidate.models.includes(session.model)
        ? `authoritative model ${session.model} was not advertised by refreshed candidate ${candidate.candidateId}`
        : undefined;
    if (!problem) return;

    let retired;
    try {
      retired = await this.workers.retire(session.managedSessionId, { reason: "assignment-model-mismatch" });
    } catch (error) {
      throw new WorkerAssignmentBoundSessionInvalidError(candidate.candidateId, session.managedSessionId, problem, error);
    }
    const cleanupProblem = retired.ownershipPersistenceError ?? retired.disposeError;
    if (cleanupProblem) {
      throw new WorkerAssignmentBoundSessionInvalidError(candidate.candidateId, session.managedSessionId, problem, cleanupProblem);
    }
    throw new WorkerAssignmentBoundSessionInvalidError(candidate.candidateId, session.managedSessionId, problem);
  }

  private assertStableCandidateIdentity(observed: WorkerAssignmentCandidate, refreshed: WorkerAssignmentCandidate): void {
    if (refreshed.candidateId !== observed.candidateId
      || refreshed.workerId !== observed.workerId
      || refreshed.provider !== observed.provider
      || refreshed.kind !== observed.kind) {
      throw new Error(`Candidate ${observed.candidateId} changed stable identity during refresh.`);
    }
  }

  private async assertMissionAssignable(request: NormalizedWorkerAssignmentRequest): Promise<TaskSnapshot> {
    await this.tasks.initialize();
    await this.tasks.assertWorkerSessionContinuationAllowed(request.missionId, "accept an initial Worker assignment");
    const task = this.tasks.getTask(request.missionId);
    if (!task) throw new Error(`Unknown Mission task: ${request.missionId}.`);
    if (!task.mission) throw new Error(`Task ${request.missionId} is not configured as a Mission.`);
    if (task.mission.projectId !== request.projectId) throw new Error(`Mission ${request.missionId} does not belong to Project ${request.projectId}.`);
    if (task.mission.rootMissionId !== request.rootMissionId) throw new Error(`Mission ${request.missionId} does not belong to root Mission ${request.rootMissionId}.`);
    if (task.missionFinalization) throw new Error(`Mission ${request.missionId} is terminal (${task.missionFinalization.state}).`);
    // Task work outcome does not end a Mission; canonical finalization above owns death.
    return task;
  }

  private assertNoCurrentAssignment(missionId: string): void {
    const task = this.tasks.getTask(missionId);
    if (!task?.mission) throw new Error(`Task ${missionId} is not configured as a Mission.`);
    const durable = activeWorkerRefs(task);
    const live = this.workers.listSessions({ taskId: missionId }).map(session => session.managedSessionId).sort();
    if (durable.length || live.length) {
      throw new WorkerAssignmentConflictError(`Mission ${missionId} already has Worker assignment state (durable=${durable.join(",") || "none"}; live=${live.join(",") || "none"}).`);
    }
  }

  private assertPublishedBinding(missionId: string, session: ManagedWorkerSession): void {
    if (session.taskId !== missionId) throw new WorkerAssignmentConflictError(`Created WorkerSession ${session.managedSessionId} is not bound to Mission ${missionId}.`);
    const task = this.tasks.getTask(missionId);
    const worker = task?.workerSessions[session.managedSessionId];
    if (!worker || worker.detachedAt || worker.retiredAt
      || worker.workerId !== session.workerId || worker.adapterSessionId !== session.adapterSessionId) {
      throw new WorkerAssignmentConflictError(`WorkerSession ${session.managedSessionId} binding outcome is not authoritative for Mission ${missionId}.`);
    }
  }

  private async withMissionLane<T>(request: NormalizedWorkerAssignmentRequest, operation: () => Promise<T>): Promise<T> {
    const laneId = `${request.projectId}\u0000${request.rootMissionId}\u0000${request.missionId}`;
    const previous = missionAssignmentLanes.get(laneId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const current = previous.then(() => gate);
    missionAssignmentLanes.set(laneId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (missionAssignmentLanes.get(laneId) === current) missionAssignmentLanes.delete(laneId);
    }
  }
}
