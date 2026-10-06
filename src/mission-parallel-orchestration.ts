import type { MissionCollaborationStore } from "./mission-collaboration-store.js";
import type { ProjectStore } from "./project-store.js";
import type { MissionPlane, TaskSnapshot } from "./task-contract.js";
import type { TaskRuntime } from "./task-runtime.js";
import {
  MissionWorkerAssignmentService,
  WorkerAssignmentNoAdmissibleCandidateError,
  type WorkerAssignmentRequest,
  type WorkerAssignmentResult,
} from "./worker-assignment.js";
import type { ManagedWorkerSession, WorkerSessionManager } from "./worker-session-manager.js";

const MAX_PARALLEL_MISSIONS = 64;
const MAX_ID_CHARS = 240;
const PARALLEL_PLANES = new Set<Exclude<MissionPlane, "coordination">>(["cognition", "practice"]);

export interface MissionParallelScope {
  projectId: string;
  rootMissionId: string;
  /** Optional bounded subset. Root and coordination Missions are never parallel work targets. */
  missionIds?: readonly string[];
  /** Defaults to cognition + practice. Coordination is deliberately excluded. */
  planes?: readonly Exclude<MissionPlane, "coordination">[];
}

export type MissionParallelBlockerCode =
  | "unfinished-dependency"
  | "dependency-cycle"
  | "unresolved-blocking-problem"
  | "task-waiting"
  | "task-terminal-status-without-finalization"
  | "worker-ownership-ambiguous";

export interface MissionParallelBlocker {
  code: MissionParallelBlockerCode;
  relationId?: string;
  exchangeId?: string;
  targetMissionId?: string;
  taskStatus?: TaskSnapshot["status"];
  durableManagedSessionIds?: string[];
  liveManagedSessionIds?: string[];
}

export type MissionParallelState =
  | "terminal"
  | "running"
  | "blocked"
  | "ready-assigned"
  | "ready-unassigned";

export interface MissionParallelMissionReadiness {
  missionId: string;
  plane: MissionPlane;
  missionType: string;
  state: MissionParallelState;
  taskStatus: TaskSnapshot["status"];
  dependencyMissionIds: string[];
  unfinishedDependencyMissionIds: string[];
  blockers: MissionParallelBlocker[];
  currentManagedSessionId?: string;
  currentWorkerId?: string;
  currentWorkerState?: ManagedWorkerSession["state"];
}

export interface MissionParallelInspection {
  version: 1;
  kind: "mission-parallel-inspection";
  projectId: string;
  rootMissionId: string;
  missions: MissionParallelMissionReadiness[];
  readyAssignedMissionIds: string[];
  readyUnassignedMissionIds: string[];
  runningMissionIds: string[];
  blockedMissionIds: string[];
  terminalMissionIds: string[];
  /** Deterministic dependency-only waves; they are derived advice, never durable workflow state. */
  dependencyWaves: string[][];
  dependencyCycleMissionIds: string[];
  unschedulableDependencyMissionIds: string[];
}

export type MissionParallelAssignmentOutcome =
  | { missionId: string; state: "assigned"; assignment: WorkerAssignmentResult }
  | { missionId: string; state: "not-ready"; observedState: MissionParallelState; blockerCodes: MissionParallelBlockerCode[] }
  | { missionId: string; state: "no-admissible-candidate" }
  | { missionId: string; state: "assignment-error"; errorName: string; error: string; retryAuthorized: false };

export interface MissionParallelAssignmentResult {
  version: 1;
  kind: "mission-parallel-assignment-result";
  projectId: string;
  rootMissionId: string;
  before: MissionParallelInspection;
  outcomes: MissionParallelAssignmentOutcome[];
  after: MissionParallelInspection;
}

function boundedId(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > MAX_ID_CHARS) throw new Error(`${label} must be at most ${MAX_ID_CHARS} characters.`);
  return normalized;
}

function taskHasRunningWork(task: TaskSnapshot): boolean {
  return Object.values(task.interactions).some(interaction => !interaction.finishedAt)
    || Object.values(task.executions).some(execution => execution.status === "requested" || execution.status === "executing");
}

function currentDurableWorkerIds(task: TaskSnapshot): string[] {
  return Object.values(task.workerSessions)
    .filter(worker => !worker.detachedAt && !worker.retiredAt)
    .map(worker => worker.managedSessionId)
    .sort();
}

function currentLiveWorkers(workers: WorkerSessionManager, missionId: string): ManagedWorkerSession[] {
  return workers.listSessions({ taskId: missionId })
    .filter(session => session.state !== "disposed")
    .sort((a, b) => a.managedSessionId.localeCompare(b.managedSessionId));
}

function sameWorkerBinding(task: TaskSnapshot, live: ManagedWorkerSession): boolean {
  const durable = task.workerSessions[live.managedSessionId];
  return !!durable
    && !durable.detachedAt
    && !durable.retiredAt
    && durable.workerId === live.workerId
    && durable.adapterSessionId === live.adapterSessionId;
}

function findDependencyCycleMissionIds(nodes: readonly string[], dependencies: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cycles = new Set<string>();

  const visit = (node: string): void => {
    indices.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    for (const dependency of dependencies.get(node) ?? []) {
      if (!indices.has(dependency)) {
        visit(dependency);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(dependency)!));
      } else if (onStack.has(dependency)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indices.get(dependency)!));
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return;
    const component: string[] = [];
    while (stack.length) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    if (component.length > 1) component.forEach(member => cycles.add(member));
  };

  for (const node of [...nodes].sort()) if (!indices.has(node)) visit(node);
  return [...cycles].sort();
}

function dependencyWaves(
  nodes: readonly string[],
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  externallyBlocked: ReadonlySet<string>,
): { waves: string[][]; unschedulable: string[] } {
  const nodeSet = new Set(nodes);
  const remaining = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    let count = 0;
    for (const dependency of dependencies.get(node) ?? []) {
      if (!nodeSet.has(dependency)) continue;
      count += 1;
      const current = dependents.get(dependency) ?? [];
      current.push(node);
      dependents.set(dependency, current);
    }
    remaining.set(node, count);
  }

  const waves: string[][] = [];
  const completed = new Set<string>();
  while (true) {
    const wave = [...nodes]
      .filter(node => !completed.has(node) && !externallyBlocked.has(node) && remaining.get(node) === 0)
      .sort();
    if (!wave.length) break;
    waves.push(wave);
    for (const node of wave) {
      completed.add(node);
      for (const dependent of dependents.get(node) ?? []) {
        remaining.set(dependent, Math.max(0, (remaining.get(dependent) ?? 0) - 1));
      }
    }
  }
  return {
    waves,
    unschedulable: [...nodes].filter(node => !completed.has(node)).sort(),
  };
}

/**
 * Read-only, reconstructible parallel-work derivation. It owns no queue, DAG,
 * Mission membership, Worker lifecycle, planning authority or durable state.
 * `depends_on` remains a Collaboration fact; this service merely derives the
 * current safe parallel frontier for already-created Cognition/Practice Missions.
 */
export class MissionParallelReadinessService {
  constructor(
    private readonly projects: ProjectStore,
    private readonly tasks: TaskRuntime,
    private readonly collaboration: MissionCollaborationStore,
    private readonly workers: WorkerSessionManager,
  ) {}

  async inspect(input: MissionParallelScope): Promise<MissionParallelInspection> {
    const projectId = boundedId(input.projectId, "Parallel Project id");
    const rootMissionId = boundedId(input.rootMissionId, "Parallel root Mission id");
    await Promise.all([this.projects.initialize(), this.tasks.initialize(), this.collaboration.initialize()]);
    if (!this.projects.getProject(projectId)) throw new Error(`Unknown parallel Project: ${projectId}.`);

    const root = this.tasks.getTask(rootMissionId);
    if (!root?.mission
      || root.mission.projectId !== projectId
      || root.mission.rootMissionId !== rootMissionId
      || root.mission.parentMissionId !== undefined) {
      throw new Error(`Parallel root Mission ${rootMissionId} does not identify the exact Project root ${projectId}.`);
    }

    const requestedPlanes = input.planes?.length ? [...input.planes] : ["cognition", "practice"] as const;
    for (const plane of requestedPlanes) {
      if (!PARALLEL_PLANES.has(plane as Exclude<MissionPlane, "coordination">)) {
        throw new Error(`Parallel work plane must be cognition or practice: ${String(plane)}.`);
      }
    }
    const planes = new Set<Exclude<MissionPlane, "coordination">>(requestedPlanes as readonly Exclude<MissionPlane, "coordination">[]);
    const requestedIds = input.missionIds?.map((missionId, index) => boundedId(missionId, `Parallel Mission id[${index}]`));
    if (requestedIds && requestedIds.length > MAX_PARALLEL_MISSIONS) {
      throw new Error(`Parallel inspection supports at most ${MAX_PARALLEL_MISSIONS} Missions.`);
    }
    if (requestedIds && new Set(requestedIds).size !== requestedIds.length) throw new Error("Parallel Mission ids must be unique.");
    if (requestedIds?.includes(rootMissionId)) throw new Error("Managed root Mission cannot be a parallel work target.");

    const allManaged = this.tasks.listTasks()
      .filter(task => task.mission?.projectId === projectId && task.mission.rootMissionId === rootMissionId);
    const allManagedById = new Map(allManaged.map(task => [task.taskId, task]));
    let selected = allManaged.filter(task => task.taskId !== rootMissionId && task.mission?.plane !== "coordination" && planes.has(task.mission!.plane as Exclude<MissionPlane, "coordination">));
    if (requestedIds) {
      selected = requestedIds.map(missionId => {
        const task = allManagedById.get(missionId);
        if (!task?.mission) throw new Error(`Parallel Mission ${missionId} is outside managed root ${rootMissionId}.`);
        if (task.mission.plane === "coordination") throw new Error(`Coordination Mission ${missionId} cannot be a parallel work target.`);
        if (!planes.has(task.mission.plane)) throw new Error(`Parallel Mission ${missionId} plane ${task.mission.plane} is outside the requested plane set.`);
        return task;
      });
    }
    if (selected.length > MAX_PARALLEL_MISSIONS) throw new Error(`Parallel inspection supports at most ${MAX_PARALLEL_MISSIONS} Missions.`);
    selected.sort((a, b) => a.taskId.localeCompare(b.taskId));
    const selectedIds = new Set(selected.map(task => task.taskId));

    const relations = this.collaboration.listRelations(projectId, { includeDerivedParent: false });
    const dependencies = new Map<string, Set<string>>();
    const dependencyRelationIds = new Map<string, Map<string, string>>();
    for (const relation of relations) {
      if (relation.type !== "depends_on" || !selectedIds.has(relation.sourceMissionId)) continue;
      const set = dependencies.get(relation.sourceMissionId) ?? new Set<string>();
      set.add(relation.targetMissionId);
      dependencies.set(relation.sourceMissionId, set);
      const ids = dependencyRelationIds.get(relation.sourceMissionId) ?? new Map<string, string>();
      ids.set(relation.targetMissionId, relation.relationId);
      dependencyRelationIds.set(relation.sourceMissionId, ids);
    }

    const activeSelectedIds = selected.filter(task => !task.missionFinalization).map(task => task.taskId);
    const activeSelectedSet = new Set(activeSelectedIds);
    const activeInternalDependencies = new Map<string, Set<string>>();
    const externallyBlocked = new Set<string>();
    for (const missionId of activeSelectedIds) {
      const internal = new Set<string>();
      for (const dependencyId of dependencies.get(missionId) ?? []) {
        const target = allManagedById.get(dependencyId);
        if (target?.missionFinalization) continue;
        if (activeSelectedSet.has(dependencyId)) internal.add(dependencyId);
        else externallyBlocked.add(missionId);
      }
      activeInternalDependencies.set(missionId, internal);
    }
    const dependencyCycleMissionIds = findDependencyCycleMissionIds(activeSelectedIds, activeInternalDependencies);
    const cycleSet = new Set(dependencyCycleMissionIds);
    const waveResult = dependencyWaves(activeSelectedIds, activeInternalDependencies, externallyBlocked);

    const exchanges = this.collaboration.listExchanges(projectId);
    const unresolvedBlockingProblems = exchanges.filter(problem => {
      if (problem.kind !== "Problem" || !problem.payload.blocking) return false;
      return !exchanges.some(answer => answer.kind === "Answer"
        && answer.replyToExchangeId === problem.exchangeId
        && answer.targetMissionId === problem.sourceMissionId
        && relations.some(relation => relation.type === "answers"
          && relation.basisExchangeId === answer.exchangeId
          && relation.sourceMissionId === answer.sourceMissionId
          && relation.targetMissionId === answer.targetMissionId));
    });

    const missions: MissionParallelMissionReadiness[] = selected.map(task => {
      const blockers: MissionParallelBlocker[] = [];
      const dependencyMissionIds = [...(dependencies.get(task.taskId) ?? [])].sort();
      if (task.missionFinalization) {
        return {
          missionId: task.taskId,
          plane: task.mission!.plane,
          missionType: task.mission!.missionType,
          state: "terminal",
          taskStatus: task.status,
          dependencyMissionIds,
          unfinishedDependencyMissionIds: [],
          blockers: [],
        };
      }
      const unfinishedDependencyMissionIds: string[] = [];
      for (const dependencyId of dependencyMissionIds) {
        const target = allManagedById.get(dependencyId);
        if (target?.missionFinalization) continue;
        unfinishedDependencyMissionIds.push(dependencyId);
        blockers.push({
          code: "unfinished-dependency",
          relationId: dependencyRelationIds.get(task.taskId)?.get(dependencyId),
          targetMissionId: dependencyId,
        });
      }
      if (cycleSet.has(task.taskId)) blockers.push({ code: "dependency-cycle" });
      for (const problem of unresolvedBlockingProblems) {
        if (problem.sourceMissionId === task.taskId) blockers.push({ code: "unresolved-blocking-problem", exchangeId: problem.exchangeId });
      }
      if (task.status === "waiting_user" || task.status === "waiting_external") {
        blockers.push({ code: "task-waiting", taskStatus: task.status });
      } else if (!task.missionFinalization && (task.status === "completed" || task.status === "failed" || task.status === "cancelled")) {
        blockers.push({ code: "task-terminal-status-without-finalization", taskStatus: task.status });
      }

      const durableManagedSessionIds = currentDurableWorkerIds(task);
      const liveWorkers = currentLiveWorkers(this.workers, task.taskId);
      const liveManagedSessionIds = liveWorkers.map(session => session.managedSessionId);
      const coherentWorker = durableManagedSessionIds.length === 1
        && liveWorkers.length === 1
        && durableManagedSessionIds[0] === liveWorkers[0].managedSessionId
        && sameWorkerBinding(task, liveWorkers[0])
        ? liveWorkers[0]
        : undefined;
      if ((durableManagedSessionIds.length !== 0 || liveWorkers.length !== 0) && !coherentWorker) {
        blockers.push({ code: "worker-ownership-ambiguous", durableManagedSessionIds, liveManagedSessionIds });
      }

      blockers.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const running = task.status === "running" || taskHasRunningWork(task) || coherentWorker?.state === "running";
      const state: MissionParallelState = running
          ? "running"
          : blockers.length
            ? "blocked"
            : coherentWorker
              ? "ready-assigned"
              : "ready-unassigned";

      return {
        missionId: task.taskId,
        plane: task.mission!.plane,
        missionType: task.mission!.missionType,
        state,
        taskStatus: task.status,
        dependencyMissionIds,
        unfinishedDependencyMissionIds: unfinishedDependencyMissionIds.sort(),
        blockers,
        ...(coherentWorker ? {
          currentManagedSessionId: coherentWorker.managedSessionId,
          currentWorkerId: coherentWorker.workerId,
          currentWorkerState: coherentWorker.state,
        } : {}),
      };
    });

    return {
      version: 1,
      kind: "mission-parallel-inspection",
      projectId,
      rootMissionId,
      missions,
      readyAssignedMissionIds: missions.filter(mission => mission.state === "ready-assigned").map(mission => mission.missionId),
      readyUnassignedMissionIds: missions.filter(mission => mission.state === "ready-unassigned").map(mission => mission.missionId),
      runningMissionIds: missions.filter(mission => mission.state === "running").map(mission => mission.missionId),
      blockedMissionIds: missions.filter(mission => mission.blockers.length > 0).map(mission => mission.missionId),
      terminalMissionIds: missions.filter(mission => mission.state === "terminal").map(mission => mission.missionId),
      dependencyWaves: waveResult.waves,
      dependencyCycleMissionIds,
      unschedulableDependencyMissionIds: waveResult.unschedulable,
    };
  }
}

/**
 * Explicit fan-out assignment seam. The caller/Cognition supplies exact Mission
 * assignment requests; this service merely proves readiness and launches those
 * independent assignments concurrently. It never retries, replaces, sends work,
 * creates Missions, or persists scheduling state.
 */
export class MissionParallelAssignmentService {
  constructor(
    private readonly readiness: MissionParallelReadinessService,
    private readonly assignments: MissionWorkerAssignmentService,
  ) {}

  async assignReady(input: MissionParallelScope & {
    requests: readonly WorkerAssignmentRequest[];
    /** Exact native-shared WebMCP candidates, one different page per Mission. */
    exactCandidateIds?: Readonly<Record<string, string>>;
  }): Promise<MissionParallelAssignmentResult> {
    const projectId = boundedId(input.projectId, "Parallel assignment Project id");
    const rootMissionId = boundedId(input.rootMissionId, "Parallel assignment root Mission id");
    if (!Array.isArray(input.requests) || input.requests.length === 0) throw new Error("Parallel assignment requires at least one explicit Mission request.");
    if (input.requests.length > MAX_PARALLEL_MISSIONS) throw new Error(`Parallel assignment supports at most ${MAX_PARALLEL_MISSIONS} Missions.`);
    const normalizedRequests = input.requests.map((request, index): WorkerAssignmentRequest => {
      const requestProjectId = boundedId(request.projectId, `Parallel assignment request[${index}] Project id`);
      const requestRootMissionId = boundedId(request.rootMissionId, `Parallel assignment request[${index}] root Mission id`);
      const missionId = boundedId(request.missionId, `Parallel assignment request[${index}] Mission id`);
      if (requestProjectId !== projectId || requestRootMissionId !== rootMissionId) {
        throw new Error(`Parallel assignment request for Mission ${missionId} does not match the exact Project/root scope.`);
      }
      return {
        ...request,
        projectId: requestProjectId,
        rootMissionId: requestRootMissionId,
        missionId,
      };
    });
    const missionIds = normalizedRequests.map(request => request.missionId);
    if (new Set(missionIds).size !== missionIds.length) throw new Error("Parallel assignment cannot contain duplicate Mission requests.");
    const exact = input.exactCandidateIds;
    if (exact !== undefined) {
      if (!exact || typeof exact !== "object" || Array.isArray(exact)
        || Object.keys(exact).length !== missionIds.length
        || Object.keys(exact).some(id => !missionIds.includes(id))
        || missionIds.some(id => typeof exact[id] !== "string" || !/^webmcp:[a-f0-9]{64}$/.test(exact[id]))
        || new Set(Object.values(exact)).size !== missionIds.length) {
        throw new Error("Parallel exact WebMCP assignment requires one unique admissible page per requested Mission.");
      }
    }

    const before = await this.readiness.inspect({
      projectId,
      rootMissionId,
      missionIds,
      planes: input.planes,
    });
    const byMission = new Map(before.missions.map(mission => [mission.missionId, mission]));
    const outcomes = await Promise.all(normalizedRequests.map(async (request): Promise<MissionParallelAssignmentOutcome> => {
      const observed = byMission.get(request.missionId)!;
      if (observed.state !== "ready-unassigned") {
        return {
          missionId: request.missionId,
          state: "not-ready",
          observedState: observed.state,
          blockerCodes: [...new Set(observed.blockers.map(blocker => blocker.code))].sort(),
        };
      }
      try {
        const assignment = exact
          ? await this.assignments.assignInitialRestricted(request, exact[request.missionId])
          : await this.assignments.assignInitial(request);
        return { missionId: request.missionId, state: "assigned", assignment };
      } catch (error) {
        if (error instanceof WorkerAssignmentNoAdmissibleCandidateError) {
          return { missionId: request.missionId, state: "no-admissible-candidate" };
        }
        return {
          missionId: request.missionId,
          state: "assignment-error",
          errorName: error instanceof Error ? error.name : "UnknownError",
          error: error instanceof Error ? error.message : String(error),
          retryAuthorized: false,
        };
      }
    }));
    outcomes.sort((a, b) => a.missionId.localeCompare(b.missionId));
    const after = await this.readiness.inspect({ projectId, rootMissionId, missionIds, planes: input.planes });
    return { version: 1, kind: "mission-parallel-assignment-result", projectId, rootMissionId, before, outcomes, after };
  }
}
