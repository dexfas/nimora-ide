import { randomUUID } from "node:crypto";
import type { ProjectFormationApplicationService, ProjectFormationOrchestratedResult, ProjectFormationPendingConfirmation } from "./project-formation-application-service.js";
import type { TaskRuntime } from "./task-runtime.js";
import type { WorkerSessionManager } from "./worker-session-manager.js";
import { normalizeWorkerAssignmentRequest, type WorkerAssignmentRequest } from "./worker-assignment.js";
import { DEFAULT_MISSION_ENTRY_MATERIALIZATION } from "./mission-worker-selection-application.js";
import type { MissionCoordinatorLiveDriver, CoordinatorLiveTransportObservation } from "./mission-coordinator-live-driver.js";
import { buildProjectFormationReceipt } from "./project-contract.js";
import { normalizeCognitionMissionPlan, type CognitionPlannedMission } from "./mission-cognition-plan.js";
import { capabilityRegistrySnapshot } from "./capability-registry.js";
import { admitMissionWorkerInputMaterializationSpec, normalizeMissionWorkspaceAccessPolicy, type MissionWorkerInputMaterializationSpec } from "./mission-worker-input-materialization-contract.js";

export interface MissionEntryScope {
  projectId: string;
  rootMissionId: string;
  coordinationMissionId: string;
  missionId?: string;
}
export interface MissionEntryDispatchIdentity {
  coordinatorInputId: string;
  targetInputId: string;
  coordinatorSessionId: string;
  targetSessionId: string;
}
export class MissionFormationOutcomeUnknownError extends Error {
  constructor(readonly formationId: string, cause: unknown) {
    super("Formation ownership did not converge. Reconcile this Formation before submitting new work; do not create a replacement Project.", { cause });
    this.name = "MissionFormationOutcomeUnknownError";
  }
}
export interface FormationCognitionInput {
  formationId: string;
  request: string;
  workspace?: string;
  existingScope?: MissionEntryScope;
}
export type FormationCognition = (input: FormationCognitionInput) => Promise<string>;
export type AssignmentPolicy = Pick<WorkerAssignmentRequest, "constraints" | "preferences">;
interface EntryPlan {
  coordinatorPolicy: AssignmentPolicy;
  workerPolicy: AssignmentPolicy;
  instruction: string;
  materialization: MissionWorkerInputMaterializationSpec;
  additionalMissions: CognitionPlannedMission[];
}
export type MissionEntryResult =
  | { state: "awaiting-human-confirmation"; pending: ProjectFormationPendingConfirmation; plan: EntryPlan }
  | { state: "formed-only"; scope: MissionEntryScope; reason: string }
  | { state: "ready-for-autonomy"; scope: MissionEntryScope; reason: string }
  | { state: "executed"; scope: MissionEntryScope; observation: unknown }
  | { state: "blocked"; scope: MissionEntryScope; reason: string };

function record(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}.`);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key))) throw new Error(`Unexpected ${label} field.`);
  return row;
}
function text(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`Invalid ${label}.`);
  return value.trim();
}
function policy(value: unknown): AssignmentPolicy {
  const row = record(value, ["constraints", "preferences"], "assignment policy");
  const normalized = normalizeWorkerAssignmentRequest({ projectId: "policy", rootMissionId: "policy", missionId: "policy", ...row });
  return { constraints: normalized.constraints, preferences: normalized.preferences };
}

export function missionEntryCapabilityMaterialization(value: unknown, allowedWorkspacePathPrefixes: unknown = ["."]): MissionWorkerInputMaterializationSpec {
  if (!Array.isArray(value) || value.length > 32 || value.some(id => typeof id !== "string" || !id || id.length > 160)) throw new Error("Invalid required capability IDs.");
  const known = new Set(capabilityRegistrySnapshot().map(item => item.id));
  if (value.some(id => !known.has(id))) throw new Error("Unknown required capability ID.");
  const workspaceAccess = normalizeMissionWorkspaceAccessPolicy({ allowedPathPrefixes: allowedWorkspacePathPrefixes });
  return {
    ...structuredClone(DEFAULT_MISSION_ENTRY_MATERIALIZATION),
    // Cognition declares the complete tool scope for this exact input. The
    // profile must not silently append unrelated tools to a bounded Work Order.
    capability: { requiredCapabilityIds: [...new Set<string>(value)], allowedCapabilityIds: [...new Set<string>(value)] },
    workspaceAccess,
  };
}

/** Session-local Formation, then mechanical transport through existing owners. No durable inbox/outbox. */
export class MissionUserEntryApplication {
  private readonly pending = new Map<string, EntryPlan>();
  constructor(
    private readonly application: ProjectFormationApplicationService,
    private readonly tasks: TaskRuntime,
    private readonly workers: WorkerSessionManager,
    private readonly liveDriver: MissionCoordinatorLiveDriver,
  ) {}

  async start(request: string, workspace: string | undefined, cognition: FormationCognition,
    confirm: (pending: ProjectFormationPendingConfirmation, plan: EntryPlan) => Promise<boolean>,
    cancelled: () => boolean = () => false, onTargetText?: (text: string) => void,
    options: {
      stopAfterFormation?: boolean;
      deferInitialExecution?: boolean;
      onFormedPlan?: (formed: ProjectFormationOrchestratedResult, missions: CognitionPlannedMission[]) => Promise<void>;
    } = {}): Promise<MissionEntryResult | { state: "cancelled" }> {
    request = text(request, "user request", 30_000);
    if (cancelled()) return { state: "cancelled" };
    const formationId = this.application.mintFormationId();
    const raw = await cognition({ formationId, request, workspace });
    if (cancelled()) return { state: "cancelled" };
    const row = record(JSON.parse(text(raw, "Formation Cognition output", 65_536)),
      ["classification", "project", "initialRoot", "coordinatorPolicy", "workerPolicy", "instruction", "requiredCapabilityIds", "allowedWorkspacePathPrefixes", "additionalMissions"], "Formation Cognition output");
    const plan: EntryPlan = { coordinatorPolicy: policy(row.coordinatorPolicy), workerPolicy: policy(row.workerPolicy), instruction: text(row.instruction, "initial instruction", 30_000),
      materialization: missionEntryCapabilityMaterialization(row.requiredCapabilityIds, row.allowedWorkspacePathPrefixes ?? ["."]),
      additionalMissions: normalizeCognitionMissionPlan(row.additionalMissions) };
    if (plan.additionalMissions.length && !options.onFormedPlan) throw new Error("Additional Missions require an explicitly connected Cognition plan admission path.");
    if (plan.additionalMissions.length && (row.initialRoot as { plane?: unknown } | null)?.plane !== "cognition") {
      throw new Error("Additional Missions require a continuing Cognition root.");
    }
    if (plan.coordinatorPolicy.constraints?.requiredCapabilities?.capabilityRequests === false) throw new Error("Coordinator policy cannot forbid its command capability transport.");
    plan.coordinatorPolicy.constraints = { ...plan.coordinatorPolicy.constraints,
      requiredCapabilities: { ...plan.coordinatorPolicy.constraints?.requiredCapabilities, capabilityRequests: true } };
    const project = record(row.project, ["title", "goal", "workspace"], "Project seed");
    if (project.workspace !== undefined && project.workspace !== workspace) throw new Error("Formation cannot change the host workspace.");
    if (row.classification !== "clear-intent" && row.classification !== "requires-human-confirmation") throw new Error("Invalid Formation classification.");
    const projectSeed = { ...project, ...(workspace === undefined ? {} : { workspace }) };
    // Pure admission failures are not persistence uncertainty and may be corrected safely.
    buildProjectFormationReceipt({ formationId, project: projectSeed, initialRoot: row.initialRoot,
      authorization: { kind: row.classification === "clear-intent" ? "clear-intent-cognition" : "human-confirmed" } });
    // Only the host supplies identity. Phase 10 performs the full strict receipt admission.
    let formed;
    try {
      formed = await this.application.submitCognitionOutcome({ formationId, classification: row.classification,
        project: projectSeed, initialRoot: row.initialRoot });
    } catch (error) { throw new MissionFormationOutcomeUnknownError(formationId, error); }
    if (formed.state === "awaiting-human-confirmation") {
      if (this.pending.size >= 32) { this.application.cancelPendingFormation(formationId); throw new Error("Too many pending formations."); }
      this.pending.set(formationId, structuredClone(plan));
      try {
        const accepted = !cancelled() && await confirm(structuredClone(formed), structuredClone(plan));
        if (!accepted || cancelled()) {
          this.application.cancelPendingFormation(formationId);
          return { state: "cancelled" };
        }
        try {
          formed = await this.application.confirmHumanFormation({ formationId, formationDigest: formed.formationDigest });
        } catch (error) { throw new MissionFormationOutcomeUnknownError(formationId, error); }
      } finally {
        this.pending.delete(formationId);
        this.application.cancelPendingFormation(formationId);
      }
    }
    if (formed.state !== "formed") throw new Error("Formation did not converge.");
    if (options.stopAfterFormation === true) {
      // Explicitly reviewed, previously answered Cognition can be imported
      // without implicitly granting another provider send. Canonical owners
      // keep the formed scope; fresh Worker assignment is a later operation.
      return { state: "formed-only", scope: {
        projectId: formed.project.projectId,
        rootMissionId: formed.rootMission.taskId,
        coordinationMissionId: formed.coordinatorMission.taskId,
      }, reason: "Reviewed Cognition formed the canonical Project without Worker assignment or provider send." };
    }
    if (plan.additionalMissions.length) {
      const scope = { projectId: formed.project.projectId, rootMissionId: formed.rootMission.taskId, coordinationMissionId: formed.coordinatorMission.taskId };
      try { await options.onFormedPlan!(formed, plan.additionalMissions); }
      catch (error) { return { state: "blocked", scope,
        reason: `Cognition plan admission stopped: ${error instanceof Error ? error.message : String(error)}. Inspect canonical Missions before any retry.` }; }
    }
    if (options.deferInitialExecution === true) {
      return this.assignInitialWorkersOnly(formed, plan, cancelled);
    }
    return this.assignAndExecute(formed, plan, cancelled, onTargetText);
  }

  private async assignInitialWorkersOnly(
    formed: ProjectFormationOrchestratedResult,
    plan: EntryPlan,
    cancelled: () => boolean,
  ): Promise<MissionEntryResult> {
    const scope = {
      projectId: formed.project.projectId,
      rootMissionId: formed.rootMission.taskId,
      coordinationMissionId: formed.coordinatorMission.taskId,
    };
    try {
      if (cancelled()) return { state: "blocked", scope, reason: "Request cancelled after Formation; no automatic execution." };
      for (const [missionId, selection] of [[scope.coordinationMissionId, plan.coordinatorPolicy], [scope.rootMissionId, plan.workerPolicy]] as const) {
        if (cancelled()) return { state: "blocked", scope, reason: "Request cancelled before assignment." };
        const result = await this.application.assignInitialWorker({
          projectId: scope.projectId,
          rootMissionId: scope.rootMissionId,
          missionId,
          ...selection,
        });
        if (result.state === "no-admissible-candidate") {
          return { state: "blocked", scope, reason: `No admissible Worker for Mission ${missionId}. Select an available provider/model explicitly.` };
        }
      }
      return {
        state: "ready-for-autonomy",
        scope,
        reason: "Canonical Project graph is formed and Root/Coordinator Workers are bound; no initial Work Order was sent before owning Cognition.",
      };
    } catch (error) {
      return { state: "blocked", scope, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  private async assignAndExecute(formed: ProjectFormationOrchestratedResult, plan: EntryPlan, cancelled: () => boolean, onTargetText?: (text: string) => void): Promise<MissionEntryResult> {
    const scope = { projectId: formed.project.projectId, rootMissionId: formed.rootMission.taskId, coordinationMissionId: formed.coordinatorMission.taskId };
    try {
      if (cancelled()) return { state: "blocked", scope, reason: "Request cancelled after Formation; no automatic execution." };
      for (const [missionId, selection] of [[scope.coordinationMissionId, plan.coordinatorPolicy], [scope.rootMissionId, plan.workerPolicy]] as const) {
        if (cancelled()) return { state: "blocked", scope, reason: "Request cancelled before assignment." };
        const result = await this.application.assignInitialWorker({ projectId: scope.projectId, rootMissionId: scope.rootMissionId, missionId, ...selection });
        if (result.state === "no-admissible-candidate") return { state: "blocked", scope, reason: `No admissible Worker for Mission ${missionId}. Select an available provider/model explicitly.` };
      }
      return await this.continue(scope, plan.instruction, cancelled, onTargetText, plan.materialization);
    } catch (error) {
      // Keep durable scope visible even when create/bind/dispatch has uncertain results.
      return { state: "blocked", scope, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Reinterpret each new request without creating a Formation or replaying previous work. */
  async continueWithCognition(scope: MissionEntryScope, request: string, workspace: string | undefined, cognition: FormationCognition,
    cancelled: () => boolean = () => false, onTargetText?: (text: string) => void): Promise<MissionEntryResult> {
    request = text(request, "user request", 30_000);
    if (cancelled()) return { state: "blocked", scope, reason: "Request cancelled before Cognition." };
    const raw = await cognition({ formationId: randomUUID(), request, workspace, existingScope: structuredClone(scope) });
    const row = record(JSON.parse(text(raw, "request Cognition output", 65_536)), ["instruction", "requiredCapabilityIds", "allowedWorkspacePathPrefixes"], "request Cognition output");
    const instruction = text(row.instruction, "explicit user instruction", 30_000);
    const materialization = missionEntryCapabilityMaterialization(row.requiredCapabilityIds, row.allowedWorkspacePathPrefixes ?? ["."]);
    return this.continue(scope, instruction, cancelled, onTargetText, materialization);
  }

  async continue(scope: MissionEntryScope, instruction: string, cancelled: () => boolean = () => false, onTargetText?: (text: string) => void,
    materialization?: MissionWorkerInputMaterializationSpec,
    beforeDispatch?: (identity: MissionEntryDispatchIdentity) => Promise<void>,
    checkpointTargetObservation?: (observation: CoordinatorLiveTransportObservation) => Promise<void>): Promise<MissionEntryResult> {
    instruction = text(instruction, "explicit user instruction", 30_000);
    if (!materialization) throw new Error("A fresh explicit capability policy is required for every Mission request.");
    materialization = admitMissionWorkerInputMaterializationSpec(materialization);
    await this.tasks.initialize();
    const sessionFor = (missionId: string) => {
      const task = this.tasks.getTask(missionId);
      if (task?.mission?.projectId !== scope.projectId || task.mission.rootMissionId !== scope.rootMissionId) throw new Error("Mission entry scope does not match durable ownership.");
      const refs = Object.values(task.workerSessions).filter(ref => !ref.detachedAt && !ref.retiredAt);
      const live = this.workers.listSessions({ taskId: missionId });
      if (refs.length !== 1 || live.length !== 1 || refs[0].managedSessionId !== live[0].managedSessionId
        || refs[0].workerId !== live[0].workerId || refs[0].adapterSessionId !== live[0].adapterSessionId) throw new Error("Worker ownership is unavailable or UNKNOWN; explicit reconciliation is required.");
      if (Object.values(task.executions).some(execution => execution.status === "unknown" || execution.status === "executing" || execution.status === "requested"
        || execution.deliveryStatus === "unknown" || execution.deliveryStatus === "pending")) throw new Error("Unresolved execution/delivery blocks a new command; no blind replay.");
      return live[0].managedSessionId;
    };
    const targetMissionId = scope.missionId ?? scope.rootMissionId;
    const targetSession = sessionFor(targetMissionId);
    const coordinatorSession = sessionFor(scope.coordinationMissionId);
    const identities = [targetSession, coordinatorSession].map(id => {
      const session = this.workers.getSession(id)!;
      return { workerId: session.workerId, adapterSessionId: session.adapterSessionId };
    });
    await this.workers.withAdapterSessionRetirementScope(identities, async owner => {
      if (identities.some(identity => !owner.isKnownSettled(identity))) throw new Error("Provider settlement is UNKNOWN or active; no new command was sent.");
    });
    if (cancelled()) return { state: "blocked", scope, reason: "Request cancelled before dispatch." };
    const identity: MissionEntryDispatchIdentity = { coordinatorInputId: randomUUID(), targetInputId: randomUUID(),
      coordinatorSessionId: coordinatorSession, targetSessionId: targetSession };
    // Persist caller-owned ingress provenance before crossing the send boundary.
    // IDs are never a receipt or replay authorization; storage failure sends nothing.
    await beforeDispatch?.(structuredClone(identity));
    if (cancelled()) return { state: "blocked", scope, reason: "Request cancelled before dispatch." };
    const observation = await this.liveDriver.executeCoordinatorCommandTurn({
      projectId: scope.projectId, managedRootMissionId: scope.rootMissionId, coordinationMissionId: scope.coordinationMissionId,
      managedSessionId: coordinatorSession, inputId: identity.coordinatorInputId, command: {
        kind: "deliverExplicitMissionInput", arguments: {
          projectId: scope.projectId, managedRootMissionId: scope.rootMissionId, coordinationMissionId: scope.coordinationMissionId,
          targetMissionId, managedSessionId: targetSession, inputId: identity.targetInputId,
          instructionKind: "cognition-authorized-user-request", instruction,
          phase8Materialization: materialization,
        },
      },
    }, onTargetText, checkpointTargetObservation);
    // Raw provider events are temporary; only bounded transport facts return to the UI.
    return { state: "executed", scope, observation: observation.commandResult };
  }
}
