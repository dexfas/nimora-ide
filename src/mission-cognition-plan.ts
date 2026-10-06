import { createHash } from "node:crypto";
import type { MissionCollaborationStore } from "./mission-collaboration-store.js";
import type { MissionCoordinatorService } from "./mission-coordinator-service.js";
import { MissionParallelAssignmentService, MissionParallelReadinessService, type MissionParallelAssignmentResult, type MissionParallelInspection, type MissionParallelScope } from "./mission-parallel-orchestration.js";
import type { WorkerAssignmentRequest } from "./worker-assignment.js";

export interface CognitionPlannedMission {
  key: string; goal: string; plane: "cognition" | "practice"; missionType: string;
  completionCriteria: string[]; dependsOn: string[];
}
const bounded = (value: unknown, limit: number, name: string): string => {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`Invalid ${name}.`);
  return value.trim();
};
/** Strict whole-graph validation before the first durable write. */
export function normalizeCognitionMissionPlan(input: unknown): CognitionPlannedMission[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 8) throw new Error("Cognition plan must be a bounded Mission array.");
  const result = input.map((value, index): CognitionPlannedMission => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid planned Mission ${index}.`);
    const row = value as Record<string, unknown>;
    if (Object.keys(row).some(key => !["key", "goal", "plane", "missionType", "completionCriteria", "dependsOn"].includes(key))) throw new Error("Unknown planned Mission field.");
    const key = bounded(row.key, 40, "Mission key");
    if (!/^[a-z][a-z0-9-]*$/.test(key)) throw new Error("Mission key requires stable lowercase identity.");
    if (row.plane !== "practice" && row.plane !== "cognition") throw new Error("Cognition cannot create Coordinator work.");
    if (!Array.isArray(row.completionCriteria) || row.completionCriteria.length < 1 || row.completionCriteria.length > 32) throw new Error("Invalid Mission completion criteria.");
    if (!Array.isArray(row.dependsOn) || row.dependsOn.length > 8) throw new Error("Invalid Mission dependency set.");
    const dependsOn = row.dependsOn.map(v => bounded(v, 40, "Mission dependency"));
    if (dependsOn.includes(key) || new Set(dependsOn).size !== dependsOn.length) throw new Error("Duplicate/self dependency.");
    return { key, goal: bounded(row.goal, 8_000, "Mission goal"), plane: row.plane, missionType: bounded(row.missionType, 160, "Mission type"),
      completionCriteria: row.completionCriteria.map(v => bounded(v, 1_000, "completion criterion")), dependsOn };
  });
  const index = new Map(result.map(m => [m.key, m]));
  if (index.size !== result.length) throw new Error("Duplicate Mission key.");
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error("Mission dependency cycle.");
    if (visited.has(key)) return;
    const mission = index.get(key);
    if (!mission) throw new Error("Unknown Mission dependency.");
    visiting.add(key); mission.dependsOn.forEach(visit); visiting.delete(key); visited.add(key);
  };
  result.forEach(m => visit(m.key));
  return result;
}

/** Reuses canonical Coordinator/Collaboration/Parallel owners without a new scheduler journal. */
export class MissionCognitionPlanService {
  constructor(private readonly coordinator: MissionCoordinatorService,
    private readonly collaboration: MissionCollaborationStore,
    private readonly readiness: MissionParallelReadinessService,
    private readonly parallel: MissionParallelAssignmentService) {}
  async establish(input: { projectId: string; rootMissionId: string; planKey: string; additionalMissions: unknown }): Promise<{
    missions: { key: string; missionId: string; plane: "cognition" | "practice" }[]; readiness?: MissionParallelInspection;
  }> {
    const plan = normalizeCognitionMissionPlan(input.additionalMissions);
    const planKey = bounded(input.planKey, 240, "Cognition plan key");
    const scope = await this.coordinator.inspectManagedScope({ projectId: input.projectId, managedRootMissionId: input.rootMissionId });
    if (!plan.length) return { missions: [] };
    if (scope.missions.find(m => m.missionId === input.rootMissionId)?.plane !== "cognition") throw new Error("Multi-Mission plan requires a continuing Cognition root.");
    const missions: { key: string; missionId: string; plane: "cognition" | "practice" }[] = [];
    for (const m of plan) {
      const operationKey = createHash("sha256").update(JSON.stringify(["plan-mission-v1", input.projectId, input.rootMissionId, planKey, m.key])).digest("hex");
      const task = await this.coordinator.ensureMission({ projectId: input.projectId, managedRootMissionId: input.rootMissionId,
        operationKey, parentMissionId: input.rootMissionId, goal: m.goal, plane: m.plane, missionType: m.missionType, completionCriteria: m.completionCriteria });
      missions.push({ key: m.key, missionId: task.taskId, plane: m.plane });
    }
    const ids = new Map(missions.map(m => [m.key, m.missionId]));
    for (const m of plan) for (const dependency of m.dependsOn) {
      const relationId = createHash("sha256").update(JSON.stringify(["plan-dependency-v1", input.projectId, input.rootMissionId, planKey, m.key, dependency])).digest("hex");
      await this.collaboration.recordRelation({ relationId, projectId: input.projectId, sourceMissionId: ids.get(m.key)!, targetMissionId: ids.get(dependency)!, type: "depends_on" });
    }
    return { missions, readiness: await this.readiness.inspect({ projectId: input.projectId,
      rootMissionId: input.rootMissionId, missionIds: missions.map(m => m.missionId) }) };
  }
  /** Explicitly authorized assignment only: no Work Order send or ambiguous retry. */
  assignReady(input: MissionParallelScope & { requests: readonly WorkerAssignmentRequest[]; exactCandidateIds?: Readonly<Record<string, string>> }): Promise<MissionParallelAssignmentResult> {
    return this.parallel.assignReady(input);
  }
}
