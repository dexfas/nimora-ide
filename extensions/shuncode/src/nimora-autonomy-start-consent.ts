import { createHash } from "node:crypto";
import type { TaskSnapshot } from "../../../src/task-contract.js";
import type { ProjectSnapshot } from "../../../src/project-contract.js";

export interface AutonomyStartClaims {
  workspace: string;
  projectId: string;
  rootMissionId: string;
  coordinationMissionId: string;
  scopeDigest: string;
}

export function autonomyStartClaims(workspace: string, project: ProjectSnapshot,
  rootMissionId: string, coordinationMissionId: string, missions: readonly TaskSnapshot[]): AutonomyStartClaims {
  const scoped = missions.filter(task => task.mission?.projectId === project.projectId
    && task.mission.rootMissionId === rootMissionId).sort((a, b) => a.taskId.localeCompare(b.taskId));
  const root = scoped.find(task => task.taskId === rootMissionId);
  const coordinator = scoped.find(task => task.taskId === coordinationMissionId);
  if (!root || root.mission?.parentMissionId || root.mission?.plane !== "cognition"
    || !coordinator || coordinator.mission?.parentMissionId !== rootMissionId || coordinator.mission?.plane !== "coordination"
    || root.missionFinalization || coordinator.missionFinalization) throw new Error("启动授权需要确切、活动的本轮 root 与 Coordinator。");
  return { workspace: workspace.toLowerCase(), projectId: project.projectId, rootMissionId, coordinationMissionId,
    scopeDigest: createHash("sha256").update(JSON.stringify({ project, missions: scoped })).digest("hex") };
}

/** Process-local, single-use transfer of the combined Human start decision.
 * Only the owning product closure can authorize it; no command argument grants
 * consent. This is not a capability grant, persisted policy or resume latch. */
export class NimoraAutonomyStartConsent {
  private readonly pending = new Map<string, AutonomyStartClaims>();
  private key(claims: AutonomyStartClaims): string { return JSON.stringify([claims.projectId, claims.rootMissionId]); }
  authorize(claims: AutonomyStartClaims): void {
    const key = this.key(claims);
    if (this.pending.has(key)) throw new Error("本轮已有待消费的启动授权。");
    this.pending.set(key, { ...claims });
  }
  consume(claims: AutonomyStartClaims, request?: { maxRounds?: number; lifecycleBudget?: unknown; resources?: unknown }): boolean {
    const key = this.key(claims), approved = this.pending.get(key);
    if (!approved) return false;
    this.pending.delete(key);
    if (JSON.stringify(approved) !== JSON.stringify(claims)
      || (request?.maxRounds !== undefined && request.maxRounds !== 8) || request?.lifecycleBudget !== undefined || request?.resources !== undefined) {
      throw new Error("本轮启动范围已变化，原一次性授权不再适用；没有分配或发送。");
    }
    return true;
  }
  discard(claims: AutonomyStartClaims): void { this.pending.delete(this.key(claims)); }
}
