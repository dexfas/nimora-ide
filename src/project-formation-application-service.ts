import { randomUUID } from "node:crypto";
import {
  buildProjectFormationReceipt,
  normalizeProjectFormationReceipt,
  type ProjectFormationInitialRootSeed,
  type ProjectFormationProjectSeed,
  type ProjectFormationReceipt,
  type ProjectSnapshot,
} from "./project-contract.js";
import type { EnsuredProjectFormation, ProjectFormationService } from "./project-formation-service.js";
import type {
  CoordinatorCommandTurnResult,
  ExecuteCoordinatorCommandTurnInput,
  MissionCoordinatorLiveDriver,
} from "./mission-coordinator-live-driver.js";
import type {
  CompleteManagedScopeInstruction,
  ManagedScopeCompletionResult,
  MissionCoordinatorCompletionService,
} from "./mission-coordinator-completion-service.js";
import { missionCoordinatorBootstrapSource, type MissionCoordinatorService } from "./mission-coordinator-service.js";
import type { MissionFinalizationResult, MissionFinalizationService } from "./mission-finalization-service.js";
import type { ProjectStore } from "./project-store.js";
import type { EnsuredProjectLaterRoot, ProjectRootOperationService } from "./project-root-operation-service.js";
import type { TaskSnapshot, TaskWorkerSessionRef } from "./task-contract.js";
import type { TaskRuntime } from "./task-runtime.js";
import {
  assertExistingWorkerAssignmentHardConstraints,
  MissionWorkerAssignmentService,
  WorkerAssignmentNoAdmissibleCandidateError,
  type WorkerAssignmentRequest,
  type WorkerAssignmentResult,
} from "./worker-assignment.js";
import type { RetiredWorkerSession, WorkerSessionManager } from "./worker-session-manager.js";

const MAX_ID_CHARS = 240;
const OWNER_PROCESS_START_REUSE_TOLERANCE_MS = 2_000;

export type ProjectFormationCognitionClassification = "clear-intent" | "requires-human-confirmation";

export interface ProjectFormationCognitionOutcome {
  formationId: string;
  classification: ProjectFormationCognitionClassification;
  project: ProjectFormationProjectSeed;
  initialRoot: ProjectFormationInitialRootSeed;
}

export interface ProjectFormationPendingConfirmation {
  state: "awaiting-human-confirmation";
  formationId: string;
  formationDigest: string;
  project: ProjectFormationProjectSeed;
  initialRoot: ProjectFormationInitialRootSeed;
}

export interface ProjectFormationOrchestratedResult extends EnsuredProjectFormation {
  state: "formed";
  formationId: string;
  formationDigest: string;
  coordinatorMission: TaskSnapshot;
}

export type ProjectFormationApplicationResult = ProjectFormationPendingConfirmation | ProjectFormationOrchestratedResult;

export type ProjectFormationAssignmentOutcome =
  | { state: "assigned"; assignment: WorkerAssignmentResult }
  | {
      state: "already-assigned";
      missionId: string;
      managedSessionId: string;
      workerId: string;
      provider?: string;
      model?: string;
    }
  | { state: "no-admissible-candidate"; missionId: string };

export interface ProjectFormationRetireAssignedWorkerResult {
  state: "retired";
  projectId: string;
  rootMissionId: string;
  missionId: string;
  managedSessionId: string;
  workerId: string;
  adapterSessionId: string;
  retired: RetiredWorkerSession;
}

export type WorkerOwnerProcessLiveness = "alive" | "dead" | "unknown";

export interface WorkerOwnerProcessObservation {
  liveness: WorkerOwnerProcessLiveness;
  startedAt?: Date;
}

export interface WorkerOrphanRecoveryHost {
  currentRuntimeIncarnationId: string;
  currentProcessId: number;
  currentSystemBootAt(): Date;
  observeProcess(processId: number): Promise<WorkerOwnerProcessObservation> | WorkerOwnerProcessObservation;
  /**
   * Migration proof for Worker refs retired by pre-classification builds.
   * This must observe the exact provider-native identity without creating a
   * new provider session.
   */
  isProviderAdapterSessionRediscoverable?(workerId: string, adapterSessionId: string): Promise<boolean> | boolean;
}

export interface ProjectFormationRecoverOrphanedAssignedWorkerResult {
  state: "orphan-retired";
  projectId: string;
  rootMissionId: string;
  missionId: string;
  managedSessionId: string;
  workerId: string;
  adapterSessionId: string;
  ownerDeathProof: "attachment-predates-current-boot" | "owner-process-conclusively-dead" | "owner-pid-reused";
  retired: TaskWorkerSessionRef;
  providerCleanup: { state: "unavailable"; reason: "no-live-worker-session" };
}

export interface ProjectFormationReconcilePendingDeliveryResult {
  state: "delivery-abandoned";
  projectId: string;
  rootMissionId: string;
  missionId: string;
  executionId: string;
  deliveryStatus: "abandoned";
  reason: string;
}

export interface ProjectFormationApplicationServiceOptions {
  newFormationId?: () => string;
  orphanRecoveryHost?: WorkerOrphanRecoveryHost;
}

interface AssignmentScope {
  projectId: string;
  rootMissionId: string;
  missionId: string;
}

interface RetireAssignedWorkerRequest extends AssignmentScope {
  managedSessionId: string;
  reason?: string;
}

type RecoverOrphanedAssignedWorkerRequest = RetireAssignedWorkerRequest;

interface ReconcilePendingDeliveryRequest extends AssignmentScope {
  executionId: string;
  reason: string;
}

const LEGACY_BOOT_PROOF_TOLERANCE_MS = 60_000;

function plainOwnRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain own-data record.`);
  return value as Record<string, unknown>;
}

function exactOwnDataKeys(row: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(row)) {
    if (typeof key !== "string") throw new Error(`${label} contains unsupported symbol field.`);
    if (!allowedSet.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label}.${key} must be an own data property.`);
  }
  for (const key of required) {
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label} is missing required field: ${key}`);
  }
}

function ownValue(row: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > MAX_ID_CHARS) throw new Error(`${label} must be at most ${MAX_ID_CHARS} characters.`);
  return normalized;
}

function normalizeCognitionOutcome(value: unknown): { classification: ProjectFormationCognitionClassification; receipt: ProjectFormationReceipt } {
  const row = plainOwnRecord(value, "Project Formation Cognition outcome");
  exactOwnDataKeys(
    row,
    ["formationId", "classification", "project", "initialRoot"],
    ["formationId", "classification", "project", "initialRoot"],
    "Project Formation Cognition outcome",
  );
  const classification = ownValue(row, "classification");
  if (classification !== "clear-intent" && classification !== "requires-human-confirmation") {
    throw new Error(`Unsupported Project Formation Cognition classification: ${String(classification)}`);
  }
  const receipt = buildProjectFormationReceipt({
    formationId: ownValue(row, "formationId"),
    project: ownValue(row, "project"),
    initialRoot: ownValue(row, "initialRoot"),
    authorization: { kind: classification === "clear-intent" ? "clear-intent-cognition" : "human-confirmed" },
  });
  return { classification, receipt };
}

function normalizeConfirmation(value: unknown): { formationId: string; formationDigest: string } {
  const row = plainOwnRecord(value, "Project Formation Human confirmation");
  exactOwnDataKeys(row, ["formationId", "formationDigest"], ["formationId", "formationDigest"], "Project Formation Human confirmation");
  const formationId = boundedId(ownValue(row, "formationId"), "Project Formation confirmation formationId");
  const formationDigest = boundedId(ownValue(row, "formationDigest"), "Project Formation confirmation digest");
  if (!/^sha256:[0-9a-f]{64}$/.test(formationDigest)) throw new Error("Project Formation confirmation digest must be a sha256 digest.");
  return { formationId, formationDigest };
}

function normalizeAssignmentScope(value: unknown): { request: WorkerAssignmentRequest; scope: AssignmentScope } {
  const row = plainOwnRecord(value, "Project Formation assignment request");
  exactOwnDataKeys(row, ["projectId", "rootMissionId", "missionId", "constraints", "preferences"], ["projectId", "rootMissionId", "missionId"], "Project Formation assignment request");
  const scope = {
    projectId: boundedId(ownValue(row, "projectId"), "Assignment Project id"),
    rootMissionId: boundedId(ownValue(row, "rootMissionId"), "Assignment root Mission id"),
    missionId: boundedId(ownValue(row, "missionId"), "Assignment Mission id"),
  };
  return { request: row as unknown as WorkerAssignmentRequest, scope };
}

function normalizeRetireAssignedWorkerRequest(value: unknown): RetireAssignedWorkerRequest {
  const row = plainOwnRecord(value, "Project Formation retire-assigned-Worker request");
  exactOwnDataKeys(
    row,
    ["projectId", "rootMissionId", "missionId", "managedSessionId", "reason"],
    ["projectId", "rootMissionId", "missionId", "managedSessionId"],
    "Project Formation retire-assigned-Worker request",
  );
  const reasonValue = ownValue(row, "reason");
  let reason: string | undefined;
  if (reasonValue !== undefined) {
    if (typeof reasonValue !== "string" || !reasonValue.trim()) throw new Error("Worker retirement reason must be a non-empty string when provided.");
    reason = reasonValue.trim();
    if (reason.length > 2_000) throw new Error("Worker retirement reason exceeds 2000 characters.");
  }
  return {
    projectId: boundedId(ownValue(row, "projectId"), "Worker retirement Project id"),
    rootMissionId: boundedId(ownValue(row, "rootMissionId"), "Worker retirement root Mission id"),
    missionId: boundedId(ownValue(row, "missionId"), "Worker retirement Mission id"),
    managedSessionId: boundedId(ownValue(row, "managedSessionId"), "Worker retirement managedSessionId"),
    ...(reason === undefined ? {} : { reason }),
  };
}

function normalizeRecoverOrphanedAssignedWorkerRequest(value: unknown): RecoverOrphanedAssignedWorkerRequest {
  const row = plainOwnRecord(value, "Project Formation recover-orphaned-assigned-Worker request");
  exactOwnDataKeys(
    row,
    ["projectId", "rootMissionId", "missionId", "managedSessionId", "reason"],
    ["projectId", "rootMissionId", "missionId", "managedSessionId"],
    "Project Formation recover-orphaned-assigned-Worker request",
  );
  const reasonValue = ownValue(row, "reason");
  let reason: string | undefined;
  if (reasonValue !== undefined) {
    if (typeof reasonValue !== "string" || !reasonValue.trim()) throw new Error("Worker orphan-recovery reason must be a non-empty string when provided.");
    reason = reasonValue.trim();
    if (reason.length > 2_000) throw new Error("Worker orphan-recovery reason exceeds 2000 characters.");
  }
  return {
    projectId: boundedId(ownValue(row, "projectId"), "Worker orphan recovery Project id"),
    rootMissionId: boundedId(ownValue(row, "rootMissionId"), "Worker orphan recovery root Mission id"),
    missionId: boundedId(ownValue(row, "missionId"), "Worker orphan recovery Mission id"),
    managedSessionId: boundedId(ownValue(row, "managedSessionId"), "Worker orphan recovery managedSessionId"),
    ...(reason === undefined ? {} : { reason }),
  };
}

function normalizeReconcilePendingDeliveryRequest(value: unknown): ReconcilePendingDeliveryRequest {
  const row = plainOwnRecord(value, "Project Formation pending-delivery reconciliation request");
  exactOwnDataKeys(
    row,
    ["projectId", "rootMissionId", "missionId", "executionId", "reason"],
    ["projectId", "rootMissionId", "missionId", "executionId", "reason"],
    "Project Formation pending-delivery reconciliation request",
  );
  const reasonValue = ownValue(row, "reason");
  if (typeof reasonValue !== "string" || !reasonValue.trim()) throw new Error("Pending-delivery reconciliation reason must be a non-empty string.");
  const reason = reasonValue.trim();
  if (reason.length > 2_000) throw new Error("Pending-delivery reconciliation reason exceeds 2000 characters.");
  return {
    projectId: boundedId(ownValue(row, "projectId"), "Pending-delivery reconciliation Project id"),
    rootMissionId: boundedId(ownValue(row, "rootMissionId"), "Pending-delivery reconciliation root Mission id"),
    missionId: boundedId(ownValue(row, "missionId"), "Pending-delivery reconciliation Mission id"),
    executionId: boundedId(ownValue(row, "executionId"), "Pending-delivery reconciliation execution id"),
    reason,
  };
}

function normalizeCoordinatorTurn(value: unknown): ExecuteCoordinatorCommandTurnInput {
  const row = plainOwnRecord(value, "Project Formation Coordinator turn");
  exactOwnDataKeys(
    row,
    ["projectId", "managedRootMissionId", "coordinationMissionId", "managedSessionId", "inputId", "command", "contextHandoff"],
    ["projectId", "managedRootMissionId", "coordinationMissionId", "managedSessionId", "inputId", "command"],
    "Project Formation Coordinator turn",
  );
  return {
    projectId: boundedId(ownValue(row, "projectId"), "Coordinator turn Project id"),
    managedRootMissionId: boundedId(ownValue(row, "managedRootMissionId"), "Coordinator turn root Mission id"),
    coordinationMissionId: boundedId(ownValue(row, "coordinationMissionId"), "Coordinator turn Mission id"),
    managedSessionId: boundedId(ownValue(row, "managedSessionId"), "Coordinator turn WorkerSession id"),
    inputId: boundedId(ownValue(row, "inputId"), "Coordinator turn input id"),
    command: ownValue(row, "command") as ExecuteCoordinatorCommandTurnInput["command"],
    ...(Object.prototype.hasOwnProperty.call(row, "contextHandoff")
      ? { contextHandoff: ownValue(row, "contextHandoff") as ExecuteCoordinatorCommandTurnInput["contextHandoff"] }
      : {}),
  };
}

function sameReceipt(a: ProjectFormationReceipt, b: ProjectFormationReceipt): boolean {
  const left = normalizeProjectFormationReceipt(a);
  const right = normalizeProjectFormationReceipt(b);
  return left.formationId === right.formationId
    && left.formationDigest === right.formationDigest
    && JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Phase 10 WO#2 application boundary. It owns only pre-Project, process-local
 * pending Human confirmations. Durable Project/Mission/Worker truth stays with
 * the canonical ProjectStore/TaskRuntime/WorkerSessionManager owners, and all
 * semantic Coordinator commands remain caller/Cognition-authored.
 */
export class ProjectFormationApplicationService {
  private readonly pendingHuman = new Map<string, ProjectFormationReceipt>();
  private readonly newFormationId: () => string;
  private readonly orphanRecoveryHost: WorkerOrphanRecoveryHost | undefined;

  constructor(
    private readonly projects: ProjectStore,
    private readonly tasks: TaskRuntime,
    private readonly workers: WorkerSessionManager,
    private readonly formation: ProjectFormationService,
    private readonly coordinator: MissionCoordinatorService,
    private readonly assignments: MissionWorkerAssignmentService,
    private readonly liveDriver: MissionCoordinatorLiveDriver,
    private readonly laterRoots: ProjectRootOperationService,
    private readonly finalization: MissionFinalizationService,
    private readonly completion: MissionCoordinatorCompletionService,
    options: ProjectFormationApplicationServiceOptions = {},
  ) {
    this.newFormationId = options.newFormationId ?? randomUUID;
    this.orphanRecoveryHost = options.orphanRecoveryHost;
  }

  /** Trusted host operation identity; never derived from chat/provider/session text. */
  mintFormationId(): string {
    return boundedId(this.newFormationId(), "Minted Project Formation id");
  }

  async submitCognitionOutcome(input: unknown): Promise<ProjectFormationApplicationResult> {
    const { classification, receipt } = normalizeCognitionOutcome(input);
    await this.projects.initialize();
    const existing = this.projects.getProjectByFormationId(receipt.formationId);
    if (existing) return this.convergeExisting(existing, receipt);

    if (classification === "requires-human-confirmation") {
      this.pendingHuman.set(receipt.formationId, receipt);
      return this.pendingResult(receipt);
    }

    // A newer trusted clear-intent classification invalidates any older pending
    // candidate for the same still-unborn operation identity.
    this.pendingHuman.delete(receipt.formationId);
    return this.formAndCoordinate(receipt);
  }

  async confirmHumanFormation(input: unknown): Promise<ProjectFormationOrchestratedResult> {
    const confirmation = normalizeConfirmation(input);
    await this.projects.initialize();
    const existing = this.projects.getProjectByFormationId(confirmation.formationId);
    if (existing) {
      const receipt = existing.formationReceipt ? normalizeProjectFormationReceipt(existing.formationReceipt) : undefined;
      if (!receipt || receipt.authorization.kind !== "human-confirmed" || receipt.formationDigest !== confirmation.formationDigest) {
        throw new Error(`Project Formation ${confirmation.formationId} Human confirmation does not match durable Project authority.`);
      }
      return this.formAndCoordinate(receipt);
    }

    const pending = this.pendingHuman.get(confirmation.formationId);
    if (!pending) throw new Error(`Project Formation ${confirmation.formationId} has no session-local pending Human confirmation.`);
    if (pending.formationDigest !== confirmation.formationDigest) {
      throw new Error(`Project Formation ${confirmation.formationId} Human confirmation digest is stale or incorrect.`);
    }
    const result = await this.formAndCoordinate(pending);
    this.pendingHuman.delete(confirmation.formationId);
    return result;
  }

  cancelPendingFormation(formationId: unknown): boolean {
    return this.pendingHuman.delete(boundedId(formationId, "Project Formation id"));
  }

  getPendingFormation(formationId: unknown): ProjectFormationPendingConfirmation | undefined {
    const receipt = this.pendingHuman.get(boundedId(formationId, "Project Formation id"));
    return receipt ? this.pendingResult(receipt) : undefined;
  }

  /**
   * Initial assignment is explicitly requested by the trusted host. Before any
   * new create attempt, exact durable+live ownership is inspected. A coherent
   * existing binding converges; partial/ambiguous ownership fails closed.
   */
  async assignInitialWorker(input: unknown, options: { exactCandidateId?: string } = {}): Promise<ProjectFormationAssignmentOutcome> {
    const { request, scope } = normalizeAssignmentScope(input);
    if (options.exactCandidateId !== undefined && (typeof options.exactCandidateId !== "string" || !/^webmcp:[a-f0-9]{64}$/.test(options.exactCandidateId))) {
      throw new Error("Formation recovery requires one exact WebMCP candidate identity.");
    }
    const current = await this.observeExistingAssignment(scope, request);
    if (current) {
      if (options.exactCandidateId !== undefined) throw new Error("Exact recovery cannot adopt an already-bound Worker or infer provider provenance from current live state.");
      return current;
    }
    try {
      const assignment = options.exactCandidateId === undefined
        ? await this.assignments.assignInitial(request)
        : await this.assignments.assignInitialRestricted(request, options.exactCandidateId);
      return { state: "assigned", assignment };
    } catch (error) {
      if (error instanceof WorkerAssignmentNoAdmissibleCandidateError) {
        return { state: "no-admissible-candidate", missionId: scope.missionId };
      }
      throw error;
    }
  }

  /**
   * Mission-scoped provider-death retirement. Only the exact current assignment
   * may be retired, and durable/live ownership must converge before the canonical
   * WorkerSessionManager retirement primitive is invoked.
   */
  async retireAssignedWorker(input: unknown): Promise<ProjectFormationRetireAssignedWorkerResult> {
    const request = normalizeRetireAssignedWorkerRequest(input);
    await this.projects.initialize();
    if (!this.projects.getProject(request.projectId)) throw new Error(`Unknown Project: ${request.projectId}`);

    const rootMission = await this.tasks.rereadTask(request.rootMissionId);
    if (!rootMission?.mission
      || rootMission.mission.projectId !== request.projectId
      || rootMission.mission.rootMissionId !== request.rootMissionId) {
      throw new Error(`Root Mission ${request.rootMissionId} does not match Project ${request.projectId}.`);
    }

    const mission = request.missionId === request.rootMissionId
      ? rootMission
      : await this.tasks.rereadTask(request.missionId);
    if (!mission?.mission) throw new Error(`Unknown Mission: ${request.missionId}`);
    if (mission.mission.projectId !== request.projectId || mission.mission.rootMissionId !== request.rootMissionId) {
      throw new Error(`Mission ${request.missionId} does not match the requested Project/root retirement scope.`);
    }
    await this.tasks.assertWorkerSessionContinuationAllowed(request.missionId, "retire its current assigned Worker");

    const durable = Object.values(mission.workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt);
    const live = this.workers.listSessions({ taskId: request.missionId }).filter(session => session.state !== "disposed");
    if (durable.length !== 1 || live.length !== 1) {
      throw new Error(`Mission ${request.missionId} Worker retirement owner truth is partial or ambiguous (durable=${durable.length}, live=${live.length}).`);
    }

    const durableSession = durable[0];
    const liveSession = live[0];
    if (durableSession.managedSessionId !== request.managedSessionId || liveSession.managedSessionId !== request.managedSessionId) {
      throw new Error(`Mission ${request.missionId} current WorkerSession does not match requested retirement session ${request.managedSessionId}.`);
    }
    if (durableSession.managedSessionId !== liveSession.managedSessionId
      || durableSession.workerId !== liveSession.workerId
      || durableSession.adapterSessionId !== liveSession.adapterSessionId) {
      throw new Error(`Mission ${request.missionId} Worker retirement owner truth conflicts between TaskRuntime and WorkerSessionManager.`);
    }

    const retired = await this.workers.retire(request.managedSessionId, { reason: request.reason });
    if (retired.managedSessionId !== request.managedSessionId
      || retired.workerId !== liveSession.workerId
      || retired.adapterSessionId !== liveSession.adapterSessionId
      || retired.taskId !== request.missionId) {
      throw new Error(`Mission ${request.missionId} Worker retirement result identity mismatch.`);
    }
    return {
      state: "retired",
      projectId: request.projectId,
      rootMissionId: request.rootMissionId,
      missionId: request.missionId,
      managedSessionId: request.managedSessionId,
      workerId: liveSession.workerId,
      adapterSessionId: liveSession.adapterSessionId,
      retired,
    };
  }

  /**
   * Explicit recovery for a durable-only Worker attachment whose original host
   * runtime is machine-proven dead. This is intentionally distinct from the
   * normal live retirement path and never reconstructs a provider handle.
   */
  async recoverOrphanedAssignedWorker(input: unknown): Promise<ProjectFormationRecoverOrphanedAssignedWorkerResult> {
    const request = normalizeRecoverOrphanedAssignedWorkerRequest(input);
    const host = this.orphanRecoveryHost;
    if (!host) throw new Error("Worker orphan recovery is unavailable without trusted host machine evidence.");
    await this.projects.initialize();
    if (!this.projects.getProject(request.projectId)) throw new Error(`Unknown Project: ${request.projectId}`);

    const rootMission = await this.tasks.rereadTask(request.rootMissionId);
    if (!rootMission?.mission
      || rootMission.mission.projectId !== request.projectId
      || rootMission.mission.rootMissionId !== request.rootMissionId) {
      throw new Error(`Root Mission ${request.rootMissionId} does not match Project ${request.projectId}.`);
    }
    const mission = request.missionId === request.rootMissionId
      ? rootMission
      : await this.tasks.rereadTask(request.missionId);
    if (!mission?.mission) throw new Error(`Unknown Mission: ${request.missionId}`);
    if (mission.mission.projectId !== request.projectId || mission.mission.rootMissionId !== request.rootMissionId) {
      throw new Error(`Mission ${request.missionId} does not match the requested Project/root orphan-recovery scope.`);
    }
    await this.tasks.assertWorkerSessionContinuationAllowed(request.missionId, "recover its orphaned assigned Worker");

    const allDurable = Object.values(mission.workerSessions);
    const durable = allDurable.filter(worker => !worker.detachedAt && !worker.retiredAt);
    const requestedHistorical = allDurable.find(worker => worker.managedSessionId === request.managedSessionId);
    const expectedDurableCurrent = durable.map(worker => structuredClone(worker));
    const durableSession = durable.find(worker => worker.managedSessionId === request.managedSessionId);
    if (durable.length === 0) {
      if (!requestedHistorical?.retiredAt) {
        throw new Error(`Mission ${request.missionId} orphan recovery requires one current Worker or the exact already-retired Worker requested for trusted migration classification.`);
      }
    } else if (!durableSession) {
      if (durable.length === 1) {
        throw new Error(`Mission ${request.missionId} current durable WorkerSession does not match requested orphan recovery session ${request.managedSessionId}.`);
      }
      throw new Error(`Mission ${request.missionId} current durable WorkerSession set does not contain requested orphan recovery session ${request.managedSessionId}.`);
    }
    const live = this.workers.listSessions({ taskId: request.missionId }).filter(session => session.state !== "disposed");
    if (live.length !== 0) {
      throw new Error(`Mission ${request.missionId} orphan recovery requires zero local live WorkerSessions (live=${live.length}).`);
    }

    if (durable.length > 1) {
      const requestedCurrent = durableSession!;
      for (const alias of durable) {
        if (alias.workerId !== requestedCurrent.workerId) {
          throw new Error(`Mission ${request.missionId} orphan alias recovery requires one exact worker lineage; durable Worker ${alias.managedSessionId} has a different workerId.`);
        }
        if (alias.adapterSessionId !== requestedCurrent.adapterSessionId) {
          throw new Error(`Mission ${request.missionId} orphan alias recovery requires one exact provider-native lineage; durable Worker ${alias.managedSessionId} has a different adapterSessionId.`);
        }
      }
    }

    const currentRuntimeIncarnationId = boundedId(host.currentRuntimeIncarnationId, "Current runtime incarnation id");
    if (!Number.isSafeInteger(host.currentProcessId) || host.currentProcessId <= 0) {
      throw new Error("Current trusted host process id must be a positive safe integer.");
    }
    const bootAt = host.currentSystemBootAt();
    if (!(bootAt instanceof Date) || !Number.isFinite(bootAt.getTime())) {
      throw new Error("Current system boot time is unavailable or invalid; orphan recovery is ambiguous.");
    }
    const proveOwnerDeath = async (
      candidate: TaskWorkerSessionRef,
      requireCompleteProvenance: boolean,
    ): Promise<ProjectFormationRecoverOrphanedAssignedWorkerResult["ownerDeathProof"]> => {
      const attachedAtMs = Date.parse(candidate.attachedAt);
      if (!Number.isFinite(attachedAtMs)) throw new Error("Durable Worker attachedAt is invalid; orphan recovery is ambiguous.");
      const definitelyPredatesBoot = attachedAtMs < bootAt.getTime() - LEGACY_BOOT_PROOF_TOLERANCE_MS;
      const hasRuntime = candidate.ownerRuntimeIncarnationId !== undefined;
      const hasPid = candidate.ownerProcessId !== undefined;
      if (hasRuntime !== hasPid) {
        throw new Error("Durable Worker owner provenance is partial; orphan recovery is ambiguous.");
      }
      if (!hasRuntime && !hasPid) {
        if (requireCompleteProvenance) {
          throw new Error("Durable Worker alias owner provenance must be complete; orphan recovery is ambiguous.");
        }
        if (!definitelyPredatesBoot) {
          throw new Error("Legacy durable Worker attachment is not conclusively older than the current system boot; orphan recovery refused.");
        }
        return "attachment-predates-current-boot";
      }

      const ownerRuntimeIncarnationId = candidate.ownerRuntimeIncarnationId!;
      const ownerProcessId = candidate.ownerProcessId!;
      if (typeof ownerRuntimeIncarnationId !== "string" || !ownerRuntimeIncarnationId.trim()
        || !Number.isSafeInteger(ownerProcessId) || ownerProcessId <= 0) {
        throw new Error("Durable Worker owner provenance is invalid; orphan recovery is ambiguous.");
      }
      if (ownerRuntimeIncarnationId === currentRuntimeIncarnationId) {
        throw new Error("Durable Worker claims the current runtime incarnation but has no local live session; orphan recovery refused.");
      }
      if (ownerProcessId === host.currentProcessId) {
        throw new Error("Durable Worker claims the current host process under a different runtime incarnation; orphan recovery refused.");
      }
      if (definitelyPredatesBoot) {
        return "attachment-predates-current-boot";
      }
      let observation: WorkerOwnerProcessObservation;
      try {
        observation = await host.observeProcess(ownerProcessId);
      } catch (error) {
        throw new Error(`Durable Worker owner process ${ownerProcessId} machine observation failed; orphan recovery refused.`, { cause: error });
      }
      if (!observation || typeof observation !== "object"
        || (observation.liveness !== "alive" && observation.liveness !== "dead" && observation.liveness !== "unknown")) {
        throw new Error(`Durable Worker owner process ${ownerProcessId} machine observation is invalid; orphan recovery refused.`);
      }
      if (observation.liveness === "dead") return "owner-process-conclusively-dead";
      if (observation.liveness === "unknown") {
        throw new Error(`Durable Worker owner process ${ownerProcessId} liveness is unknown; orphan recovery refused.`);
      }
      if (observation.startedAt === undefined) {
        throw new Error(`Durable Worker owner process ${ownerProcessId} is alive but trusted process-start evidence is unavailable; orphan recovery refused.`);
      }
      if (!(observation.startedAt instanceof Date) || !Number.isFinite(observation.startedAt.getTime())) {
        throw new Error(`Durable Worker owner process ${ownerProcessId} trusted process-start evidence is invalid; orphan recovery refused.`);
      }
      if (observation.startedAt.getTime() <= attachedAtMs + OWNER_PROCESS_START_REUSE_TOLERANCE_MS) {
        throw new Error(`Durable Worker owner process ${ownerProcessId} is alive and its trusted start time is not conclusively later than the durable attachment; orphan recovery refused.`);
      }
      return "owner-pid-reused";
    };

    let ownerDeathProof: ProjectFormationRecoverOrphanedAssignedWorkerResult["ownerDeathProof"];
    let retired: TaskWorkerSessionRef;
    const recoverySession = durableSession ?? requestedHistorical!;
    if (durable.length === 0) {
      ownerDeathProof = await proveOwnerDeath(recoverySession, false);
      if (recoverySession.retirementKind !== "orphan-owner-death") {
        const rediscover = host.isProviderAdapterSessionRediscoverable;
        if (!rediscover) {
          throw new Error(`Mission ${request.missionId} legacy orphan retirement cannot be classified without trusted provider-identity rediscovery.`);
        }
        let rediscoverable = false;
        try {
          rediscoverable = await rediscover(recoverySession.workerId, recoverySession.adapterSessionId);
        } catch (error) {
          throw new Error(`Mission ${request.missionId} provider-identity rediscovery failed; orphan retirement classification refused.`, { cause: error });
        }
        if (!rediscoverable) {
          throw new Error(`Mission ${request.missionId} retired provider-native identity is not currently rediscoverable; orphan retirement classification refused.`);
        }
      }
      retired = await this.tasks.classifyWorkerOrphanRetirementStrict(request.missionId, request.managedSessionId);
    } else if (durable.length === 1) {
      ownerDeathProof = await proveOwnerDeath(durableSession!, false);
      retired = await this.tasks.retireWorkerSessionIfCurrentSetMatchesStrict(request.missionId, request.managedSessionId, expectedDurableCurrent, {
        reason: request.reason ?? "proven-restart-orphan",
        retirementKind: "orphan-owner-death",
      });
    } else {
      let requestedProof: ProjectFormationRecoverOrphanedAssignedWorkerResult["ownerDeathProof"] | undefined;
      for (const alias of durable) {
        const proof = await proveOwnerDeath(alias, true);
        if (alias.managedSessionId === durableSession!.managedSessionId) requestedProof = proof;
      }
      if (!requestedProof) throw new Error(`Mission ${request.missionId} requested orphan alias proof was not established.`);
      ownerDeathProof = requestedProof;
      retired = await this.tasks.retireWorkerSessionIfCurrentSetMatchesStrict(request.missionId, request.managedSessionId, expectedDurableCurrent, {
        reason: request.reason ?? "proven-restart-orphan",
        retirementKind: "orphan-owner-death",
      });
    }

    if (retired.managedSessionId !== recoverySession.managedSessionId
      || retired.workerId !== recoverySession.workerId
      || retired.adapterSessionId !== recoverySession.adapterSessionId
      || !retired.retiredAt) {
      throw new Error(`Mission ${request.missionId} orphan retirement result identity mismatch.`);
    }
    return {
      state: "orphan-retired",
      projectId: request.projectId,
      rootMissionId: request.rootMissionId,
      missionId: request.missionId,
      managedSessionId: retired.managedSessionId,
      workerId: retired.workerId,
      adapterSessionId: retired.adapterSessionId,
      ownerDeathProof,
      retired,
      providerCleanup: { state: "unavailable", reason: "no-live-worker-session" },
    };
  }

  /**
   * Explicitly close a historical pending delivery without claiming that it
   * reached the provider. TaskRuntime enforces terminal execution + retired
   * origin WorkerSession, so current/live delivery ownership cannot be erased.
   */
  async reconcilePendingExecutionDelivery(input: unknown): Promise<ProjectFormationReconcilePendingDeliveryResult> {
    const request = normalizeReconcilePendingDeliveryRequest(input);
    await this.projects.initialize();
    if (!this.projects.getProject(request.projectId)) throw new Error(`Unknown Project: ${request.projectId}`);
    const rootMission = await this.tasks.rereadTask(request.rootMissionId);
    if (!rootMission?.mission || rootMission.mission.projectId !== request.projectId || rootMission.mission.rootMissionId !== request.rootMissionId) {
      throw new Error(`Root Mission ${request.rootMissionId} does not match Project ${request.projectId}.`);
    }
    const mission = request.missionId === request.rootMissionId ? rootMission : await this.tasks.rereadTask(request.missionId);
    if (!mission?.mission || mission.mission.projectId !== request.projectId || mission.mission.rootMissionId !== request.rootMissionId) {
      throw new Error(`Mission ${request.missionId} does not match the requested Project/root reconciliation scope.`);
    }
    await this.tasks.assertWorkerSessionContinuationAllowed(request.missionId, "reconcile pending execution delivery");
    const reconciled = await this.tasks.abandonPendingDeliveryStrict(request.missionId, request.executionId, request.reason);
    return {
      state: "delivery-abandoned",
      projectId: request.projectId,
      rootMissionId: request.rootMissionId,
      missionId: request.missionId,
      executionId: request.executionId,
      deliveryStatus: "abandoned",
      reason: reconciled.deliveryAbandonmentReason ?? request.reason,
    };
  }

  /** Exact pass-through only: this layer never synthesizes a Coordinator command. */
  executeCoordinatorCommandTurn(input: unknown): Promise<CoordinatorCommandTurnResult> {
    return this.liveDriver.executeCoordinatorCommandTurn(normalizeCoordinatorTurn(input));
  }

  /** Trusted host supplies an exact already-Cognition-authored later-root operation. */
  ensureLaterProjectRoot(input: unknown): Promise<EnsuredProjectLaterRoot> {
    return this.laterRoots.ensureLaterRoot(input);
  }

  /**
   * Explicit mechanical finalization for support Missions only. A managed root
   * or its deterministic Coordinator must still die through completeManagedScope.
   */
  async finalizeSupportMission(input: unknown): Promise<MissionFinalizationResult> {
    const row = plainOwnRecord(input, "Support Mission finalization request");
    exactOwnDataKeys(
      row,
      ["projectId", "missionId", "requireHandoff", "maxHandoffChars"],
      ["projectId", "missionId"],
      "Support Mission finalization request",
    );
    const projectId = boundedId(ownValue(row, "projectId"), "Support Mission Project id");
    const missionId = boundedId(ownValue(row, "missionId"), "Support Mission id");
    const mission = await this.tasks.rereadTask(missionId);
    if (!mission?.mission || mission.mission.projectId !== projectId) {
      throw new Error(`Support Mission ${missionId} does not belong to Project ${projectId}.`);
    }
    const managedCoordinator = this.tasks.findTaskBySource(missionCoordinatorBootstrapSource({
      projectId,
      managedRootMissionId: mission.mission.rootMissionId,
    }));
    const isManagedProjectRoot = mission.source.kind === "mission"
      && (mission.source.key.startsWith("project-root:v1:") || mission.source.key.startsWith("project-later-root:v1:"));
    if (mission.taskId === mission.mission.rootMissionId && (managedCoordinator || isManagedProjectRoot)) {
      throw new Error(`Managed root Mission ${missionId} must be finalized through completeManagedScope.`);
    }
    if (managedCoordinator?.taskId === missionId) {
      throw new Error(`Coordinator Mission ${missionId} must be finalized through completeManagedScope.`);
    }
    const requireHandoffValue = Object.prototype.hasOwnProperty.call(row, "requireHandoff")
      ? ownValue(row, "requireHandoff")
      : true;
    if (typeof requireHandoffValue !== "boolean") throw new Error("Support Mission requireHandoff must be boolean.");
    const maxHandoffCharsValue = ownValue(row, "maxHandoffChars");
    let maxHandoffChars: number | undefined;
    if (maxHandoffCharsValue !== undefined) {
      if (typeof maxHandoffCharsValue !== "number"
        || !Number.isInteger(maxHandoffCharsValue)
        || maxHandoffCharsValue < 256
        || maxHandoffCharsValue > 100_000) {
        throw new Error("Support Mission maxHandoffChars must be an integer between 256 and 100000.");
      }
      maxHandoffChars = maxHandoffCharsValue;
    }
    return this.finalization.finalizeMission(missionId, {
      requireHandoff: requireHandoffValue,
      ...(maxHandoffChars === undefined ? {} : { maxHandoffChars }),
    });
  }

  /** Existing Phase 6 recovery; cannot initiate death from an entirely active pair. */
  recoverManagedScopeCompletion(input: unknown): Promise<ManagedScopeCompletionResult> {
    const row = plainOwnRecord(input, "Managed-scope completion recovery request");
    exactOwnDataKeys(
      row,
      ["projectId", "managedRootMissionId", "coordinationMissionId", "completionKey"],
      ["projectId", "managedRootMissionId", "coordinationMissionId", "completionKey"],
      "Managed-scope completion recovery request",
    );
    const instruction: CompleteManagedScopeInstruction = {
      projectId: boundedId(ownValue(row, "projectId"), "Completion Project id"),
      managedRootMissionId: boundedId(ownValue(row, "managedRootMissionId"), "Completion managed root Mission id"),
      coordinationMissionId: boundedId(ownValue(row, "coordinationMissionId"), "Completion Coordinator Mission id"),
      completionKey: boundedId(ownValue(row, "completionKey"), "Completion key"),
    };
    return this.completion.recoverPartialFinalization(instruction);
  }

  private async formAndCoordinate(receipt: ProjectFormationReceipt): Promise<ProjectFormationOrchestratedResult> {
    const formed = await this.formation.ensureFormation(receipt);
    const coordinatorMission = await this.coordinator.ensureCoordinatorMission({
      projectId: formed.project.projectId,
      managedRootMissionId: formed.rootMission.taskId,
    });
    return {
      state: "formed",
      formationId: receipt.formationId,
      formationDigest: receipt.formationDigest,
      ...formed,
      coordinatorMission,
    };
  }

  private async convergeExisting(existing: ProjectSnapshot, expected: ProjectFormationReceipt): Promise<ProjectFormationOrchestratedResult> {
    const durable = existing.formationReceipt ? normalizeProjectFormationReceipt(existing.formationReceipt) : undefined;
    if (!durable || !sameReceipt(durable, expected)) {
      throw new Error(`Project Formation ${expected.formationId} identity/content collision at production entry.`);
    }
    return this.formAndCoordinate(durable);
  }

  private pendingResult(receipt: ProjectFormationReceipt): ProjectFormationPendingConfirmation {
    return {
      state: "awaiting-human-confirmation",
      formationId: receipt.formationId,
      formationDigest: receipt.formationDigest,
      project: structuredClone(receipt.project),
      initialRoot: structuredClone(receipt.initialRoot),
    };
  }

  private async observeExistingAssignment(
    scope: AssignmentScope,
    request: WorkerAssignmentRequest,
  ): Promise<ProjectFormationAssignmentOutcome | undefined> {
    // Canonical durable Task truth is refreshed before any new WorkerSession
    // create attempt. This closes the retry window where a binding append may
    // have reached disk even if current in-memory acknowledgement was uncertain.
    const task = await this.tasks.rereadTask(scope.missionId);
    if (!task?.mission) return undefined;
    if (task.mission.projectId !== scope.projectId || task.mission.rootMissionId !== scope.rootMissionId) {
      throw new Error(`Mission ${scope.missionId} does not match the requested Project/root assignment scope.`);
    }
    const durable = Object.values(task.workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt);
    const live = this.workers.listSessions({ taskId: scope.missionId }).filter(session => session.state !== "disposed");
    if (durable.length === 0 && live.length === 0) return undefined;
    if (durable.length !== 1 || live.length !== 1) {
      throw new Error(`Mission ${scope.missionId} Worker assignment owner truth is partial or ambiguous (durable=${durable.length}, live=${live.length}).`);
    }
    const durableSession = durable[0];
    const liveSession = live[0];
    if (durableSession.managedSessionId !== liveSession.managedSessionId
      || durableSession.workerId !== liveSession.workerId
      || durableSession.adapterSessionId !== liveSession.adapterSessionId) {
      throw new Error(`Mission ${scope.missionId} Worker assignment owner truth conflicts between TaskRuntime and WorkerSessionManager.`);
    }
    const registered = this.workers.getWorker(liveSession.workerId);
    if (!registered) throw new Error(`Mission ${scope.missionId} existing Worker ${liveSession.workerId} is no longer registered.`);
    let descriptor;
    try {
      descriptor = await this.workers.refresh(liveSession.workerId);
    } catch (error) {
      throw new Error(`Mission ${scope.missionId} existing Worker definition refresh failed before convergence: ${error instanceof Error ? error.message : String(error)}`);
    }
    assertExistingWorkerAssignmentHardConstraints(request, descriptor, liveSession);
    return {
      state: "already-assigned",
      missionId: scope.missionId,
      managedSessionId: liveSession.managedSessionId,
      workerId: liveSession.workerId,
      ...(liveSession.model === undefined ? {} : { model: liveSession.model }),
    };
  }
}
