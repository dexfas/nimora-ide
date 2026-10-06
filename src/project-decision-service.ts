import type { ProjectDecisionChange, ProjectDecisionScope } from "./project-contract.js";
import type { ProjectStore } from "./project-store.js";
import type { TaskRuntime } from "./task-runtime.js";

export type ProjectDecisionImpactExclusionReason = "nonexistent" | "not-mission" | "cross-project" | "finalized";

export interface ProjectDecisionImpactExclusion {
  missionId: string;
  reason: ProjectDecisionImpactExclusionReason;
}

export interface ProjectDecisionImpact {
  version: 1;
  projectId: string;
  decisionId: string;
  proposalId: string;
  contentDigest: string;
  scope: ProjectDecisionScope;
  routeableMissionIds: string[];
  excluded: ProjectDecisionImpactExclusion[];
}

export interface CommitProjectDecisionResult {
  decision: ProjectDecisionChange;
  impact: ProjectDecisionImpact;
}

/** Stateless impact/composition only; no journal, scheduler, Worker choice, or delivery state. */
export class ProjectDecisionService {
  constructor(private readonly projects: ProjectStore, private readonly tasks: TaskRuntime) {}

  async commitProposal(projectId: string, input: { proposalId: string }): Promise<CommitProjectDecisionResult> {
    await this.initialize();
    const decision = await this.projects.commitProposal(projectId, input);
    return { decision, impact: this.analyzeDecision(decision) };
  }

  async analyzeImpact(projectId: string, decisionId: string): Promise<ProjectDecisionImpact> {
    await this.initialize();
    const project = this.projects.getProject(projectId);
    if (!project) throw new Error(`Unknown Project: ${projectId}`);
    const decision = project.committedDecisions[decisionId];
    if (!decision) throw new Error(`Committed Project Decision does not exist in Project ${projectId}: ${decisionId}`);
    return this.analyzeDecision(decision);
  }

  private async initialize(): Promise<void> {
    await Promise.all([this.projects.initialize(), this.tasks.initialize()]);
  }

  private analyzeDecision(decision: ProjectDecisionChange): ProjectDecisionImpact {
    const routeableMissionIds: string[] = [];
    const excluded: ProjectDecisionImpactExclusion[] = [];
    const consider = (missionId: string): void => {
      const task = this.tasks.getTask(missionId);
      if (!task) return void excluded.push({ missionId, reason: "nonexistent" });
      if (!task.mission) return void excluded.push({ missionId, reason: "not-mission" });
      if (task.mission.projectId !== decision.projectId) return void excluded.push({ missionId, reason: "cross-project" });
      if (task.missionFinalization) return void excluded.push({ missionId, reason: "finalized" });
      routeableMissionIds.push(missionId);
    };

    if (decision.content.scope.kind === "project") {
      for (const task of this.tasks.listTasks()) {
        if (task.mission?.projectId !== decision.projectId) continue;
        if (task.missionFinalization) excluded.push({ missionId: task.taskId, reason: "finalized" });
        else routeableMissionIds.push(task.taskId);
      }
    } else {
      for (const missionId of decision.content.scope.missionIds) consider(missionId);
    }

    routeableMissionIds.sort();
    excluded.sort((a, b) => a.missionId.localeCompare(b.missionId) || a.reason.localeCompare(b.reason));
    return {
      version: 1,
      projectId: decision.projectId,
      decisionId: decision.decisionId,
      proposalId: decision.proposalId,
      contentDigest: decision.contentDigest,
      scope: structuredClone(decision.content.scope),
      routeableMissionIds,
      excluded,
    };
  }
}
