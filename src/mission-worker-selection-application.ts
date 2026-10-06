import { admitMissionWorkerInputMaterializationSpec, type MissionWorkerInputMaterializationSpec } from "./mission-worker-input-materialization-contract.js";
import { validateMissionWorkerInputMaterializationRequest, type MissionWorkerInputMaterializer } from "./mission-worker-input-materializer.js";
import { normalizeWorkerAssignmentRequest, type MissionWorkerAssignmentService, type WorkerAssignmentRequest } from "./worker-assignment.js";
import type { ProjectFormationApplicationService } from "./project-formation-application-service.js";

export interface MissionWorkerSelectionRequest {
  assignment: WorkerAssignmentRequest;
  expectedManagedSessionId: string;
  coordinationMissionId: string;
  inputId: string;
  instruction: string;
  materialization?: MissionWorkerInputMaterializationSpec;
}

export const DEFAULT_MISSION_ENTRY_MATERIALIZATION: MissionWorkerInputMaterializationSpec = Object.freeze({
  profile: "auto",
  budget: Object.freeze({ maxInstructionChars: 30_000, maxContextChars: 50_000, maxSkillChars: 10_000, maxSchemaChars: 50_000, maxCombinedChars: 150_000 }),
});

/** No state/journal: policy goes to Phase 7; current durable truth goes to Phase 8. */
export class MissionWorkerSelectionApplication {
  constructor(private readonly assignments: MissionWorkerAssignmentService, private readonly input: MissionWorkerInputMaterializer,
    private readonly recovery?: Pick<ProjectFormationApplicationService, "recoverOrphanedAssignedWorker">) {}

  private prepare(input: MissionWorkerSelectionRequest) {
    if (!input || typeof input !== "object" || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) throw new Error("Worker replacement requires a plain request.");
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string" || !["assignment", "expectedManagedSessionId", "coordinationMissionId", "inputId", "instruction", "materialization"].includes(key)
        || !("value" in Object.getOwnPropertyDescriptor(input, key)!)) throw new Error("Worker replacement contains an unsupported field/accessor.");
    }
    const request = normalizeWorkerAssignmentRequest(input.assignment);
    // Validate the non-policy surface before retiring the old owner.
    for (const key of ["coordinationMissionId", "inputId", "instruction"] as const) {
      if (typeof input[key] !== "string" || !input[key].trim() || input[key].length > (key === "instruction" ? 30_000 : 240)) throw new Error(`Invalid replacement ${key}.`);
    }
    const materializationRequest = {
      ...admitMissionWorkerInputMaterializationSpec(input.materialization ?? DEFAULT_MISSION_ENTRY_MATERIALIZATION),
      projectId: request.projectId, rootMissionId: request.rootMissionId, missionId: request.missionId,
      managedSessionId: input.expectedManagedSessionId, coordinationMissionId: input.coordinationMissionId,
      inputId: input.inputId, instructionKind: "explicit-worker-replacement", instruction: input.instruction,
    };
    validateMissionWorkerInputMaterializationRequest(materializationRequest);
    return { request, materializationRequest };
  }

  async replace(input: MissionWorkerSelectionRequest) {
    const { request, materializationRequest } = this.prepare(input);
    const assignment = await this.assignments.replaceSettled(request, input.expectedManagedSessionId);
    // Never reuse a provider transcript/checkpoint or a previous materialization.
    // If this fails the published assignment remains authoritative; do not retry replacement.
    const materialization = await this.input.materialize({
      ...materializationRequest, managedSessionId: assignment.managedSessionId,
    });
    return { state: "replaced" as const, assignment, materialization };
  }

  /** Explicit restart recovery. Host machine proof, not missing/idle state, owns retirement. */
  async recoverAfterRestart(input: MissionWorkerSelectionRequest) {
    const { request, materializationRequest } = this.prepare(input);
    if (!this.recovery) throw new Error("Trusted host Worker recovery is unavailable.");
    const retired = await this.recovery.recoverOrphanedAssignedWorker({
      projectId: request.projectId, rootMissionId: request.rootMissionId, missionId: request.missionId,
      managedSessionId: input.expectedManagedSessionId, reason: "explicit-user-worker-selection-after-restart",
    });
    const assignment = await this.assignments.assignInitial(request);
    const materialization = await this.input.materialize({ ...materializationRequest, managedSessionId: assignment.managedSessionId });
    // Provider cleanup may be unavailable. This prepares fresh context only;
    // it does not claim an old send settled and never replays an old instruction.
    return { state: "recovered" as const, retired, assignment, materialization };
  }
}
