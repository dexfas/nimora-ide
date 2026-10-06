import {
  normalizeProjectFormationReceipt,
  type ProjectFormationReceipt,
  type ProjectSnapshot,
} from "./project-contract.js";
import type { ProjectStore } from "./project-store.js";
import type { TaskMissionMetadata, TaskSnapshot, TaskSource } from "./task-contract.js";
import type { TaskRuntime } from "./task-runtime.js";

export interface EnsuredProjectFormation {
  project: ProjectSnapshot;
  rootMission: TaskSnapshot;
}

function requireFormationReceipt(project: ProjectSnapshot): ProjectFormationReceipt {
  if (!project.formationReceipt) throw new Error(`Project ${project.projectId} has no Project Formation receipt.`);
  return normalizeProjectFormationReceipt(project.formationReceipt);
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sourceMatches(actual: TaskSource, expected: TaskSource): boolean {
  return actual.kind === expected.kind && actual.key === expected.key && actual.workspace === expected.workspace;
}

function missionMatches(actual: TaskMissionMetadata | undefined, expected: TaskMissionMetadata): boolean {
  return !!actual
    && actual.projectId === expected.projectId
    && actual.rootMissionId === expected.rootMissionId
    && actual.parentMissionId === expected.parentMissionId
    && actual.plane === expected.plane
    && actual.missionType === expected.missionType
    && sameStrings(actual.completionCriteria, expected.completionCriteria);
}

/** Deterministic root identity is Project-derived, never chat/provider/session-derived. */
export function projectFormationRootSource(project: ProjectSnapshot): TaskSource {
  const receipt = requireFormationReceipt(project);
  return {
    kind: "mission",
    key: `project-root:v1:${project.projectId}`,
    ...(receipt.project.workspace === undefined ? {} : { workspace: receipt.project.workspace }),
  };
}

export function projectFormationRootMetadata(project: ProjectSnapshot, rootTaskId: string): TaskMissionMetadata {
  const receipt = requireFormationReceipt(project);
  return {
    projectId: project.projectId,
    rootMissionId: rootTaskId,
    plane: receipt.initialRoot.plane,
    missionType: receipt.initialRoot.missionType,
    completionCriteria: [...receipt.initialRoot.completionCriteria],
  };
}

/**
 * Stateless Phase 10 WO#1 composition seam. It owns no journal, queue, scheduler,
 * Coordinator, WorkerSession, assignment, send, transcript or UI state. Every
 * retry/restart derives its next step from ProjectStore + TaskRuntime owner truth.
 */
export class ProjectFormationService {
  constructor(
    private readonly projects: ProjectStore,
    private readonly tasks: TaskRuntime,
  ) {}

  /** Consume one already-authorized exact Formation receipt and converge Project -> root. */
  async ensureFormation(input: unknown): Promise<EnsuredProjectFormation> {
    const receipt = normalizeProjectFormationReceipt(input);
    const created = await this.projects.ensureProjectFormation(receipt);
    const project = await this.projects.rereadProjectByFormationId(receipt.formationId);
    if (!project || project.projectId !== created.projectId) {
      throw new Error(`Project Formation ${receipt.formationId} could not re-read its exact Project owner truth.`);
    }
    const rootMission = await this.ensureRoot(project);
    return this.rereadExact(receipt.formationId, rootMission.taskId);
  }

  /** Recover only already-born formed Projects; no pre-Project/raw-text retry inference exists here. */
  async recoverFormedProjectRoots(): Promise<EnsuredProjectFormation[]> {
    const formedProjects = await this.projects.rereadFormedProjects();
    const result: EnsuredProjectFormation[] = [];
    for (const project of formedProjects) {
      const rootMission = await this.ensureRoot(project);
      result.push(await this.rereadExact(requireFormationReceipt(project).formationId, rootMission.taskId));
    }
    return result;
  }

  private async ensureRoot(project: ProjectSnapshot): Promise<TaskSnapshot> {
    const receipt = requireFormationReceipt(project);
    const source = projectFormationRootSource(project);
    // Durable owner truth is consulted before any new Task id can be allocated.
    // This also recovers a prior append-UNKNOWN whose bytes exist but whose live
    // TaskRuntime projection was never installed.
    let root = await this.tasks.rereadTaskBySource(source);
    if (!root) {
      try {
        root = await this.tasks.ensureTask(source, receipt.initialRoot.goal);
      } catch (error) {
        // A strict TaskCreated append may have become durable before its error
        // reached TaskRuntime's in-memory apply step. Classify from owner bytes.
        const observed = await this.tasks.rereadTaskBySource(source);
        if (!observed) throw error;
        root = observed;
      }
    }
    this.assertRootTaskIdentity(project, root, source);

    const expectedMission = projectFormationRootMetadata(project, root.taskId);
    try {
      root = await this.tasks.configureMission(root.taskId, expectedMission);
    } catch (error) {
      // Re-read the exact durable Task owner after append-UNKNOWN; current memory
      // may still predate the durable TaskMissionConfigured row.
      const observed = await this.tasks.rereadTask(root.taskId);
      if (!observed || !missionMatches(observed.mission, expectedMission)) throw error;
      root = observed;
    }
    if (!missionMatches(root.mission, expectedMission)) {
      throw new Error(`Project ${project.projectId} deterministic root Mission metadata collision.`);
    }

    const expectedContext = {
      ...(receipt.initialRoot.contextSummary === undefined ? {} : { summary: receipt.initialRoot.contextSummary }),
      constraints: [...(receipt.initialRoot.constraints ?? [])],
    };
    try {
      root = await this.tasks.ensureMissionInitialContextStrict(root.taskId, expectedContext);
    } catch (error) {
      const observed = await this.tasks.rereadTask(root.taskId);
      if (!observed
        || observed.context.summary !== expectedContext.summary
        || !sameStrings(observed.context.constraints, expectedContext.constraints)) {
        throw error;
      }
      root = observed;
    }

    this.assertRootTaskIdentity(project, root, source);
    if (!missionMatches(root.mission, expectedMission)) {
      throw new Error(`Project ${project.projectId} deterministic root Mission drifted after configuration.`);
    }
    if (root.context.summary !== expectedContext.summary || !sameStrings(root.context.constraints, expectedContext.constraints)) {
      throw new Error(`Project ${project.projectId} deterministic root context does not match its Formation receipt.`);
    }
    return root;
  }

  private async rereadExact(formationId: string, expectedRootTaskId: string): Promise<EnsuredProjectFormation> {
    const project = await this.projects.rereadProjectByFormationId(formationId);
    if (!project) throw new Error(`Project Formation ${formationId} disappeared during owner re-read.`);
    const source = projectFormationRootSource(project);
    const rootMission = await this.tasks.rereadTaskBySource(source);
    if (!rootMission || rootMission.taskId !== expectedRootTaskId) {
      throw new Error(`Project Formation ${formationId} cannot re-read its deterministic root Task.`);
    }
    this.assertRootTaskIdentity(project, rootMission, source);
    const expectedMission = projectFormationRootMetadata(project, rootMission.taskId);
    if (!missionMatches(rootMission.mission, expectedMission)) {
      throw new Error(`Project Formation ${formationId} root Mission metadata is incomplete or conflicting.`);
    }
    const receipt = requireFormationReceipt(project);
    if (rootMission.context.summary !== receipt.initialRoot.contextSummary
      || !sameStrings(rootMission.context.constraints, receipt.initialRoot.constraints ?? [])) {
      throw new Error(`Project Formation ${formationId} root context is incomplete or conflicting.`);
    }
    return { project, rootMission };
  }

  private assertRootTaskIdentity(project: ProjectSnapshot, root: TaskSnapshot, source: TaskSource): void {
    const receipt = requireFormationReceipt(project);
    if (!sourceMatches(root.source, source)) throw new Error(`Project ${project.projectId} deterministic root source collision.`);
    if (root.goal !== receipt.initialRoot.goal) throw new Error(`Project ${project.projectId} deterministic root goal collision.`);
    if (root.mission && root.mission.projectId !== project.projectId) {
      throw new Error(`Project ${project.projectId} deterministic root points at a different Project.`);
    }
  }
}
