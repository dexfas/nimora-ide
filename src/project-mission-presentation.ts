import type { MissionExchange, MissionGraphRelation } from "./mission-collaboration-contract.js";
import type { MissionCollaborationStore } from "./mission-collaboration-store.js";
import { getMissionFinalHandoff } from "./mission-finalization-service.js";
import type { ProjectDecisionChange, ProjectProposalContent, ProjectSnapshot } from "./project-contract.js";
import type { ProjectStore } from "./project-store.js";
import type {
  MissionPlane,
  TaskArtifactRef,
  TaskExecution,
  TaskMissionFinalization,
  TaskSnapshot,
  TaskTodo,
  TaskProgress,
  TaskStatus,
  TaskWorkerSessionRef,
} from "./task-contract.js";
import type { TaskRuntime } from "./task-runtime.js";

export type ProjectMissionOwnerAvailability =
  | { status: "available" }
  | { status: "unavailable"; detail: string };

export interface ProjectMissionPresentationAvailability {
  projects: ProjectMissionOwnerAvailability;
  tasks: ProjectMissionOwnerAvailability;
  collaboration: ProjectMissionOwnerAvailability;
}

export type ProjectMissionIntegrityCode =
  | "missing-project"
  | "missing-root"
  | "root-project-mismatch"
  | "root-has-parent"
  | "child-missing-parent"
  | "self-parent"
  | "missing-parent"
  | "parent-project-mismatch"
  | "parent-root-mismatch"
  | "parent-cycle"
  | "derived-parent-mismatch"
  | "cross-project-relation"
  | "cross-project-exchange";

export interface ProjectMissionIntegrityIssue {
  code: ProjectMissionIntegrityCode;
  projectId: string;
  missionId?: string;
  relatedId?: string;
  detail: string;
}

export interface ProjectMissionProblemPresentation {
  exchangeId: string;
  sourceMissionId: string;
  targetMissionId?: string;
  answerState: "Open" | "Answered";
  blocking: boolean;
  answerExchangeIds: string[];
  answers: ProjectMissionAnswerPresentation[];
  evidence: MissionExchange[];
  missingEvidenceExchangeIds: string[];
}

export interface ProjectMissionAnswerPresentation {
  exchangeId: string;
  sourceMissionId: string;
  targetMissionId?: string;
  answer: string;
  limitations?: string;
  evidence: MissionExchange[];
  missingEvidenceExchangeIds: string[];
}

export interface ProjectMissionPresentationProject {
  projectId: string;
  metadataState: "available" | "missing" | "unavailable";
  title?: string;
  goal?: string;
  workspace?: string;
  decisionsState: "available" | "missing-project" | "unavailable";
  committedDecisions: ProjectDecisionChange[];
  /** Non-authoritative governance work still awaiting Human Confirmation or Commit. */
  pendingProposals?: Array<{
    proposalId: string;
    contentDigest: string;
    content: ProjectProposalContent;
    proposedAt: string;
    state: "awaiting-human" | "confirmed-awaiting-commit";
    confirmedAt?: string;
  }>;
  missionIds: string[];
  collaborationState: "available" | "unavailable";
  hierarchyRelations: MissionGraphRelation[];
  relations: MissionGraphRelation[];
  exchanges: MissionExchange[];
  problems: ProjectMissionProblemPresentation[];
}

export interface ProjectMissionPresentationMission {
  missionId: string;
  taskId: string;
  projectId: string;
  rootMissionId: string;
  parentMissionId?: string;
  plane: MissionPlane;
  semanticRole: "文" | "理" | "总协调";
  missionType: string;
  goal?: string;
  taskStatus: TaskStatus;
  finalization?: TaskMissionFinalization;
  finalized: boolean;
  presentationState: TaskStatus | "archived";
  terminal: boolean;
  hierarchyDepth?: number;
  executions: TaskExecution[];
  todos?: TaskTodo[];
  progress?: TaskProgress;
  artifacts: TaskArtifactRef[];
  finalHandoff?: TaskArtifactRef;
  workers: TaskWorkerSessionRef[];
}

export interface ProjectMissionPresentation {
  version: 1;
  availability: ProjectMissionPresentationAvailability;
  projects: ProjectMissionPresentationProject[];
  missions: ProjectMissionPresentationMission[];
  legacyTaskIds: string[];
  integrityIssues: ProjectMissionIntegrityIssue[];
}

export interface ProjectMissionPresentationInput {
  availability: ProjectMissionPresentationAvailability;
  projects: readonly ProjectSnapshot[];
  tasks: readonly TaskSnapshot[];
  committedDecisionsByProject: ReadonlyMap<string, readonly ProjectDecisionChange[]>;
  relations: readonly MissionGraphRelation[];
  exchanges: readonly MissionExchange[];
}

export interface ProjectMissionPresentationOwners {
  projects: Pick<ProjectStore, "initialize" | "listProjects" | "listDecisions">;
  tasks: Pick<TaskRuntime, "initialize" | "listTasks">;
  collaboration: Pick<MissionCollaborationStore, "initialize" | "listRelations" | "listExchanges">;
}

const ROLE_BY_PLANE: Record<MissionPlane, ProjectMissionPresentationMission["semanticRole"]> = {
  cognition: "文",
  practice: "理",
  coordination: "总协调",
};

function errorDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= 500 ? text : `${text.slice(0, 499)}…`;
}

function byId<T extends { projectId: string }>(values: readonly T[]): Map<string, T> {
  return new Map(values.map(value => [value.projectId, value]));
}

function sortedMissionTasks(tasks: readonly TaskSnapshot[]): TaskSnapshot[] {
  return tasks
    .filter((task): task is TaskSnapshot & { mission: NonNullable<TaskSnapshot["mission"]> } => !!task.mission)
    .map(task => structuredClone(task))
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
}

function endpointBelongsToProject(missionsById: ReadonlyMap<string, TaskSnapshot>, missionId: string, projectId: string): boolean {
  return missionsById.get(missionId)?.mission?.projectId === projectId;
}

function acceptedProjectExchange(
  exchange: MissionExchange,
  missionsById: ReadonlyMap<string, TaskSnapshot>,
): boolean {
  return endpointBelongsToProject(missionsById, exchange.sourceMissionId, exchange.projectId)
    && (!exchange.targetMissionId || endpointBelongsToProject(missionsById, exchange.targetMissionId, exchange.projectId));
}

function acceptedProjectRelation(
  relation: MissionGraphRelation,
  missionsById: ReadonlyMap<string, TaskSnapshot>,
): boolean {
  return endpointBelongsToProject(missionsById, relation.sourceMissionId, relation.projectId)
    && endpointBelongsToProject(missionsById, relation.targetMissionId, relation.projectId);
}

function cloneExchange(exchange: MissionExchange): MissionExchange {
  return structuredClone(exchange);
}

function cloneRelation(relation: MissionGraphRelation): MissionGraphRelation {
  return structuredClone(relation);
}

function hierarchyIssues(missions: readonly TaskSnapshot[]): ProjectMissionIntegrityIssue[] {
  const issues: ProjectMissionIntegrityIssue[] = [];
  const missionsById = new Map(missions.map(task => [task.taskId, task]));
  const issue = (code: ProjectMissionIntegrityCode, task: TaskSnapshot, detail: string, relatedId?: string): void => {
    issues.push({ code, projectId: task.mission!.projectId, missionId: task.taskId, relatedId, detail });
  };

  for (const task of missions) {
    const mission = task.mission!;
    const root = missionsById.get(mission.rootMissionId);
    if (!root?.mission) {
      issue("missing-root", task, `Mission ${task.taskId} names missing root ${mission.rootMissionId}.`, mission.rootMissionId);
    } else if (root.mission.projectId !== mission.projectId) {
      issue("root-project-mismatch", task, `Mission ${task.taskId} root ${mission.rootMissionId} belongs to another Project.`, mission.rootMissionId);
    }

    if (task.taskId === mission.rootMissionId) {
      if (mission.parentMissionId) issue("root-has-parent", task, `Root Mission ${task.taskId} unexpectedly names parent ${mission.parentMissionId}.`, mission.parentMissionId);
      continue;
    }
    if (!mission.parentMissionId) {
      issue("child-missing-parent", task, `Child Mission ${task.taskId} has no parentMissionId.`);
      continue;
    }
    if (mission.parentMissionId === task.taskId) {
      issue("self-parent", task, `Mission ${task.taskId} names itself as parent.`, task.taskId);
      continue;
    }
    const parent = missionsById.get(mission.parentMissionId);
    if (!parent?.mission) {
      issue("missing-parent", task, `Mission ${task.taskId} names missing parent ${mission.parentMissionId}.`, mission.parentMissionId);
      continue;
    }
    if (parent.mission.projectId !== mission.projectId) {
      issue("parent-project-mismatch", task, `Mission ${task.taskId} parent ${mission.parentMissionId} belongs to another Project.`, mission.parentMissionId);
    }
    if (parent.mission.rootMissionId !== mission.rootMissionId) {
      issue("parent-root-mismatch", task, `Mission ${task.taskId} parent ${mission.parentMissionId} names a different root.`, mission.parentMissionId);
    }
  }

  for (const task of missions) {
    const projectId = task.mission!.projectId;
    const seen = new Set<string>();
    let current: TaskSnapshot | undefined = task;
    while (current?.mission?.parentMissionId) {
      if (seen.has(current.taskId)) {
        issue("parent-cycle", task, `Mission ${task.taskId} hierarchy contains a parent cycle at ${current.taskId}.`, current.taskId);
        break;
      }
      seen.add(current.taskId);
      const parent = missionsById.get(current.mission.parentMissionId);
      if (!parent?.mission || parent.mission.projectId !== projectId) break;
      current = parent;
    }
  }
  return issues;
}

function hierarchyDepth(task: TaskSnapshot, missionsById: ReadonlyMap<string, TaskSnapshot>): number | undefined {
  const mission = task.mission;
  if (!mission) return undefined;
  if (task.taskId === mission.rootMissionId && !mission.parentMissionId) return 0;
  const seen = new Set<string>([task.taskId]);
  let depth = 0;
  let current = task;
  while (current.mission?.parentMissionId) {
    const parent = missionsById.get(current.mission.parentMissionId);
    if (!parent?.mission || parent.mission.projectId !== mission.projectId || parent.mission.rootMissionId !== mission.rootMissionId || seen.has(parent.taskId)) return undefined;
    seen.add(parent.taskId);
    depth += 1;
    if (parent.taskId === mission.rootMissionId) return parent.mission.parentMissionId ? undefined : depth;
    current = parent;
  }
  return undefined;
}

function projectProblems(exchanges: readonly MissionExchange[]): ProjectMissionProblemPresentation[] {
  const evidenceById = new Map(exchanges.filter(exchange => exchange.kind === "Evidence").map(exchange => [exchange.exchangeId, exchange]));
  const answers = exchanges.filter(exchange => exchange.kind === "Answer");
  const resolveEvidence = (evidenceExchangeIds: readonly string[]): { evidence: MissionExchange[]; missingEvidenceExchangeIds: string[] } => {
    const evidence: MissionExchange[] = [];
    const missingEvidenceExchangeIds: string[] = [];
    for (const evidenceId of evidenceExchangeIds) {
      const candidate = evidenceById.get(evidenceId);
      if (candidate) evidence.push(cloneExchange(candidate));
      else missingEvidenceExchangeIds.push(evidenceId);
    }
    return { evidence, missingEvidenceExchangeIds };
  };
  return exchanges
    .filter(exchange => exchange.kind === "Problem")
    .map(problem => {
      const matchingAnswers = answers.filter(answer => answer.replyToExchangeId === problem.exchangeId);
      const problemEvidence = resolveEvidence(problem.payload.evidenceExchangeIds);
      return {
        exchangeId: problem.exchangeId,
        sourceMissionId: problem.sourceMissionId,
        targetMissionId: problem.targetMissionId,
        answerState: matchingAnswers.length ? "Answered" as const : "Open" as const,
        blocking: problem.payload.blocking,
        answerExchangeIds: matchingAnswers.map(answer => answer.exchangeId).sort(),
        answers: matchingAnswers
          .map(answer => {
            const answerEvidence = resolveEvidence(answer.payload.evidenceExchangeIds);
            return {
              exchangeId: answer.exchangeId,
              sourceMissionId: answer.sourceMissionId,
              targetMissionId: answer.targetMissionId,
              answer: answer.payload.answer,
              ...(answer.payload.limitations === undefined ? {} : { limitations: answer.payload.limitations }),
              evidence: answerEvidence.evidence,
              missingEvidenceExchangeIds: answerEvidence.missingEvidenceExchangeIds,
            };
          })
          .sort((a, b) => a.exchangeId.localeCompare(b.exchangeId)),
        evidence: problemEvidence.evidence,
        missingEvidenceExchangeIds: problemEvidence.missingEvidenceExchangeIds,
      };
    })
    .sort((a, b) => a.exchangeId.localeCompare(b.exchangeId));
}

/** Pure, disposable projection. Every returned grouping/status is derived from canonical-owner facts supplied for this reconstruction. */
export function deriveProjectMissionPresentation(input: ProjectMissionPresentationInput): ProjectMissionPresentation {
  const missionTasks = sortedMissionTasks(input.tasks);
  const missionsById = new Map(missionTasks.map(task => [task.taskId, task]));
  const projectsById = byId(input.projects);
  const issues = hierarchyIssues(missionTasks);

  for (const task of missionTasks) {
    if (input.availability.projects.status === "available" && !projectsById.has(task.mission!.projectId)) {
      issues.push({
        code: "missing-project",
        projectId: task.mission!.projectId,
        missionId: task.taskId,
        detail: `Mission ${task.taskId} references Project ${task.mission!.projectId}, which is absent from ProjectStore.`,
      });
    }
  }

  const acceptedRelations: MissionGraphRelation[] = [];
  for (const relation of input.relations) {
    if (!acceptedProjectRelation(relation, missionsById)) {
      issues.push({
        code: "cross-project-relation",
        projectId: relation.projectId,
        missionId: relation.sourceMissionId,
        relatedId: relation.relationId,
        detail: `Relation ${relation.relationId} has an endpoint outside Project ${relation.projectId}.`,
      });
      continue;
    }
    if (relation.type === "parent_of") {
      const child = missionsById.get(relation.targetMissionId);
      if (child?.mission?.parentMissionId !== relation.sourceMissionId) {
        issues.push({
          code: "derived-parent-mismatch",
          projectId: relation.projectId,
          missionId: relation.targetMissionId,
          relatedId: relation.relationId,
          detail: `Derived parent relation ${relation.relationId} contradicts TaskRuntime parent metadata.`,
        });
      }
      continue;
    }
    acceptedRelations.push(cloneRelation(relation));
  }

  const acceptedExchanges: MissionExchange[] = [];
  for (const exchange of input.exchanges) {
    if (!acceptedProjectExchange(exchange, missionsById)) {
      issues.push({
        code: "cross-project-exchange",
        projectId: exchange.projectId,
        missionId: exchange.sourceMissionId,
        relatedId: exchange.exchangeId,
        detail: `Exchange ${exchange.exchangeId} has an endpoint outside Project ${exchange.projectId}.`,
      });
      continue;
    }
    acceptedExchanges.push(cloneExchange(exchange));
  }

  const projectIds = new Set<string>(input.projects.map(project => project.projectId));
  for (const task of missionTasks) projectIds.add(task.mission!.projectId);
  const projects: ProjectMissionPresentationProject[] = [...projectIds].sort().map(projectId => {
    const canonical = projectsById.get(projectId);
    const metadataState = input.availability.projects.status === "unavailable"
      ? "unavailable" as const
      : canonical ? "available" as const : "missing" as const;
    const projectExchanges = acceptedExchanges.filter(exchange => exchange.projectId === projectId);
    return {
      projectId,
      metadataState,
      ...(canonical?.title ? { title: canonical.title } : {}),
      ...(canonical?.goal ? { goal: canonical.goal } : {}),
      ...(canonical?.workspace ? { workspace: canonical.workspace } : {}),
      decisionsState: input.availability.projects.status === "unavailable"
        ? "unavailable"
        : canonical ? "available" : "missing-project",
      committedDecisions: canonical
        ? (input.committedDecisionsByProject.get(projectId) ?? []).map(decision => structuredClone(decision))
        : [],
      pendingProposals: canonical
        ? Object.values(canonical.proposals)
          .filter(proposal => !proposal.supersededByProposalId)
          .filter(proposal => !Object.values(canonical.committedDecisions).some(decision => decision.proposalId === proposal.proposalId))
          .map(proposal => {
            const confirmation = canonical.humanConfirmations[proposal.proposalId];
            return {
              proposalId: proposal.proposalId,
              contentDigest: proposal.contentDigest,
              content: structuredClone(proposal.content),
              proposedAt: proposal.proposedAt,
              state: confirmation ? "confirmed-awaiting-commit" as const : "awaiting-human" as const,
              ...(confirmation ? { confirmedAt: confirmation.confirmedAt } : {}),
            };
          })
          .sort((a, b) => a.proposedAt.localeCompare(b.proposedAt) || a.proposalId.localeCompare(b.proposalId))
        : [],
      missionIds: missionTasks.filter(task => task.mission!.projectId === projectId).map(task => task.taskId),
      collaborationState: input.availability.collaboration.status === "available" ? "available" : "unavailable",
      hierarchyRelations: missionTasks
        .filter(task => task.mission!.projectId === projectId && !!task.mission!.parentMissionId)
        .map(task => ({
          relationId: `parent_of:${task.taskId}`,
          projectId,
          sourceMissionId: task.mission!.parentMissionId!,
          targetMissionId: task.taskId,
          type: "parent_of" as const,
          createdAt: task.createdAt,
          derived: true as const,
        })),
      relations: acceptedRelations.filter(relation => relation.projectId === projectId),
      exchanges: projectExchanges,
      problems: projectProblems(projectExchanges),
    };
  });

  const missions: ProjectMissionPresentationMission[] = missionTasks.map(task => {
    const finalization = task.missionFinalization ? structuredClone(task.missionFinalization) : undefined;
    const presentationState = finalization?.state === "archived" ? "archived" : finalization?.state === "completed" ? "completed" : task.status;
    return {
      missionId: task.taskId,
      taskId: task.taskId,
      projectId: task.mission!.projectId,
      rootMissionId: task.mission!.rootMissionId,
      parentMissionId: task.mission!.parentMissionId,
      plane: task.mission!.plane,
      semanticRole: ROLE_BY_PLANE[task.mission!.plane],
      missionType: task.mission!.missionType,
      goal: task.goal,
      taskStatus: task.status,
      finalization,
      finalized: !!finalization,
      presentationState,
      terminal: !!finalization,
      hierarchyDepth: hierarchyDepth(task, missionsById),
      executions: Object.values(task.executions).map(execution => structuredClone(execution)).sort((a, b) => a.executionId.localeCompare(b.executionId)),
      todos: task.todos.map(todo => ({ ...todo })),
      progress: task.progress ? { ...task.progress } : undefined,
      artifacts: task.artifacts.map(artifact => structuredClone(artifact)),
      finalHandoff: getMissionFinalHandoff(task),
      workers: Object.values(task.workerSessions).map(worker => structuredClone(worker)).sort((a, b) => a.attachedAt.localeCompare(b.attachedAt) || a.managedSessionId.localeCompare(b.managedSessionId)),
    };
  });

  return {
    version: 1,
    availability: structuredClone(input.availability),
    projects,
    missions,
    legacyTaskIds: input.tasks.filter(task => !task.mission).map(task => task.taskId).sort(),
    integrityIssues: issues.sort((a, b) => a.projectId.localeCompare(b.projectId) || (a.missionId ?? "").localeCompare(b.missionId ?? "") || a.code.localeCompare(b.code)),
  };
}

/** Reads each canonical owner and then delegates to the pure projection. Owner failure is represented explicitly, never normalized to authoritative emptiness. */
export async function readProjectMissionPresentation(owners: ProjectMissionPresentationOwners): Promise<ProjectMissionPresentation> {
  let projectAvailability: ProjectMissionOwnerAvailability = { status: "available" };
  let taskAvailability: ProjectMissionOwnerAvailability = { status: "available" };
  let collaborationAvailability: ProjectMissionOwnerAvailability = { status: "available" };
  let projects: ProjectSnapshot[] = [];
  let tasks: TaskSnapshot[] = [];
  const committedDecisionsByProject = new Map<string, ProjectDecisionChange[]>();
  let relations: MissionGraphRelation[] = [];
  let exchanges: MissionExchange[] = [];

  try {
    await owners.projects.initialize();
    projects = owners.projects.listProjects();
    for (const project of projects) committedDecisionsByProject.set(project.projectId, owners.projects.listDecisions(project.projectId));
  } catch (error) {
    projectAvailability = { status: "unavailable", detail: errorDetail(error) };
    projects = [];
    committedDecisionsByProject.clear();
  }

  try {
    await owners.tasks.initialize();
    tasks = owners.tasks.listTasks();
  } catch (error) {
    taskAvailability = { status: "unavailable", detail: errorDetail(error) };
    tasks = [];
  }

  if (projectAvailability.status === "unavailable" || taskAvailability.status === "unavailable") {
    collaborationAvailability = {
      status: "unavailable",
      detail: "Mission collaboration depends on available canonical ProjectStore and TaskRuntime owners.",
    };
  } else {
    try {
      await owners.collaboration.initialize();
      const projectIds = new Set(projects.map(project => project.projectId));
      for (const task of tasks) if (task.mission) projectIds.add(task.mission.projectId);
      for (const projectId of [...projectIds].sort()) {
        relations.push(...owners.collaboration.listRelations(projectId));
        exchanges.push(...owners.collaboration.listExchanges(projectId));
      }
    } catch (error) {
      collaborationAvailability = { status: "unavailable", detail: errorDetail(error) };
      relations = [];
      exchanges = [];
    }
  }

  return deriveProjectMissionPresentation({
    availability: {
      projects: projectAvailability,
      tasks: taskAvailability,
      collaboration: collaborationAvailability,
    },
    projects,
    tasks,
    committedDecisionsByProject,
    relations,
    exchanges,
  });
}
