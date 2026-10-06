import type { TaskSnapshot } from "./task-contract.js";
import { normalizeWorkerAssignmentRequest, type WorkerAssignmentRequest, type WorkerAssignmentConstraints } from "./worker-assignment.js";

export const RESOURCE_POLICY_PREFIX = "NIMORA_RESOURCE_POLICY_V1:";
export interface MissionResourcePolicy {
  version: 1;
  revision: string;
  mode: "web" | "api" | "mixed";
  planner: "deepseek-web" | "api";
  providerOrder: string[];
  modelOrder: string[];
  maxParallel: 1 | 2;
  roleRequirements?: Partial<Record<"cognition" | "coordination" | "practice", Pick<WorkerAssignmentConstraints, "requiredModel" | "requiredCapabilities">>>;
}
export function normalizeResourcePolicy(value: unknown): MissionResourcePolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid resource policy.");
  const row = value as Record<string, unknown>;
  if (Object.getPrototypeOf(row) !== Object.prototype || Object.keys(row).some(k => !["version", "revision", "mode", "planner", "providerOrder", "modelOrder", "maxParallel", "roleRequirements"].includes(k))) throw new Error("Invalid resource policy fields.");
  const ids = (v: unknown): string[] => {
    if (!Array.isArray(v) || v.length > 8 || v.some(s => typeof s !== "string" || !s.trim() || s.length > 160)) throw new Error("Invalid resource policy preferences.");
    return [...new Set(v as string[])];
  };
  if (row.version !== 1 || typeof row.revision !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(row.revision)
    || !["web", "api", "mixed"].includes(row.mode as string) || !["deepseek-web", "api"].includes(row.planner as string)
    || (row.maxParallel !== 1 && row.maxParallel !== 2) || (row.mode === "web" && row.planner === "api")) throw new Error("Invalid resource policy values.");
  const policy = { version: 1 as const, revision: row.revision, mode: row.mode as MissionResourcePolicy["mode"], planner: row.planner as MissionResourcePolicy["planner"],
    providerOrder: ids(row.providerOrder), modelOrder: ids(row.modelOrder), maxParallel: row.maxParallel as 1 | 2 };
  if (row.roleRequirements !== undefined) {
    const requirements = row.roleRequirements as NonNullable<MissionResourcePolicy["roleRequirements"]>;
    if (!requirements || Object.getPrototypeOf(requirements) !== Object.prototype || Object.keys(requirements).some(k => !["cognition", "coordination", "practice"].includes(k))) throw new Error("Invalid role hard requirements.");
    const normalized: NonNullable<MissionResourcePolicy["roleRequirements"]> = {};
    for (const [plane, hard] of Object.entries(requirements)) {
      if (!hard || Object.keys(hard).some(k => !["requiredModel", "requiredCapabilities"].includes(k))) throw new Error("Role requirements cannot change authorized resources.");
      const request = normalizeWorkerAssignmentRequest({ projectId: "policy", rootMissionId: "policy", missionId: "policy", constraints: hard });
      if (request.constraints?.requiredCapabilities?.capabilityRequests === false) throw new Error("Mission role cannot prohibit its capability transport.");
      normalized[plane as keyof typeof normalized] = { ...(request.constraints?.requiredModel ? { requiredModel: request.constraints.requiredModel } : {}), ...(request.constraints?.requiredCapabilities ? { requiredCapabilities: request.constraints.requiredCapabilities } : {}) };
    }
    (policy as MissionResourcePolicy).roleRequirements = normalized;
  }
  if ((RESOURCE_POLICY_PREFIX + JSON.stringify(policy)).length > 1500) throw new Error("Resource policy exceeds durable constraint bound.");
  return policy;
}
export function defaultResourcePolicy(): MissionResourcePolicy {
  return { version: 1, revision: "default-web-v1", mode: "web", planner: "deepseek-web", providerOrder: ["deepseek"], modelOrder: [], maxParallel: 1 };
}
/** Only the owning Human product path writes this constraint. Provider text is
 * stripped before host insertion. It authorizes resource classes, never tools. */
export function readResourcePolicy(root: TaskSnapshot): MissionResourcePolicy | undefined {
  const rows = (root.context?.constraints ?? []).filter(c => c.startsWith(RESOURCE_POLICY_PREFIX));
  if (rows.length > 1) throw new Error("Conflicting durable root resource policies.");
  return rows.length ? normalizeResourcePolicy(JSON.parse(rows[0].slice(RESOURCE_POLICY_PREFIX.length))) : undefined;
}
export function resourceAssignment(policy: MissionResourcePolicy, scope: { projectId: string; rootMissionId: string }, missionId: string,
  plane: string): WorkerAssignmentRequest {
  const role = plane === "cognition" || plane === "coordination";
  const hard = policy.roleRequirements?.[plane as "cognition" | "coordination" | "practice"];
  const mode = role ? (policy.planner === "api" ? "api" : "web") : policy.mode;
  return { ...scope, missionId, constraints: { allowedKinds: mode === "mixed" ? ["web", "api"] : [mode],
    ...(mode === "web" ? { allowedProviders: ["deepseek"] } : mode === "api" ? { allowedProviders: ["nimora-api"] } : { allowedProviders: ["deepseek", "nimora-api"] }),
    ...(hard?.requiredModel ? { requiredModel: hard.requiredModel } : {}),
    requiredCapabilities: { ...hard?.requiredCapabilities, capabilityRequests: true } }, preferences: { providerOrder: policy.providerOrder, modelOrder: policy.modelOrder } };
}
