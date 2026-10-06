import type { MissionCollaborationStore } from "./mission-collaboration-store.js";
import { getMissionFinalHandoff, type MissionFinalizationResult, type MissionFinalizationService } from "./mission-finalization-service.js";
import type { MissionCoordinatorScope, MissionCoordinatorService } from "./mission-coordinator-service.js";
import type { TaskSnapshot } from "./task-contract.js";
import { taskHasUnsettledWork, type TaskRuntime } from "./task-runtime.js";
import type { WorkerSessionManager } from "./worker-session-manager.js";

const MAX_COMPLETION_KEY_CHARS = 240;

export interface CompleteManagedScopeInstruction extends MissionCoordinatorScope {
  coordinationMissionId: string;
  completionKey: string;
}

export type ManagedScopeCompletionBlockerCode =
  | "active-descendant"
  | "descendant-not-archived"
  | "unfinished-dependency"
  | "unresolved-blocking-problem"
  | "running-task-work"
  | "running-worker-session"
  | "invalid-final-handoff"
  | "invalid-archived-state"
  | "inconsistent-lifecycle-order";

export interface ManagedScopeCompletionBlocker {
  code: ManagedScopeCompletionBlockerCode;
  missionId?: string;
  relationId?: string;
  exchangeId?: string;
  managedSessionId?: string;
  targetMissionId?: string;
}

export interface ManagedScopeCompletionReadiness {
  version: 1;
  kind: "managed-scope-completion-readiness";
  projectId: string;
  managedRootMissionId: string;
  coordinationMissionId: string;
  completionKey: string;
  ready: boolean;
  blockers: ManagedScopeCompletionBlocker[];
}

export interface ManagedScopeCompletionFinalizationSummary {
  missionId: string;
  state: "completed" | "archived";
  handoffArtifactId?: string;
  retiredManagedSessionIds: string[];
  logicallyRetiredOrphans: string[];
  cleanupWarnings: string[];
}

export interface ManagedScopeCompletionResult {
  version: 1;
  kind: "managed-scope-completion-result";
  projectId: string;
  managedRootMissionId: string;
  coordinationMissionId: string;
  completionKey: string;
  coordinator: ManagedScopeCompletionFinalizationSummary;
  root: ManagedScopeCompletionFinalizationSummary;
}

function boundedCompletionKey(value: unknown): string {
  if (typeof value !== "string") throw new Error("Coordinator completion key must be a string.");
  const normalized = value.trim();
  if (!normalized) throw new Error("Coordinator completion key must not be empty.");
  if (normalized.length > MAX_COMPLETION_KEY_CHARS) {
    throw new Error(`Coordinator completion key must be at most ${MAX_COMPLETION_KEY_CHARS} characters.`);
  }
  return normalized;
}

function finalizationSummary(result: MissionFinalizationResult): ManagedScopeCompletionFinalizationSummary {
  const finalization = result.mission.missionFinalization;
  if (!finalization) throw new Error(`Finalization result for Mission ${result.mission.taskId} is missing terminal state.`);
  return {
    missionId: result.mission.taskId,
    state: finalization.state,
    ...(result.handoff ? { handoffArtifactId: result.handoff.artifactId } : {}),
    retiredManagedSessionIds: result.retiredWorkers.map(worker => worker.managedSessionId).sort(),
    logicallyRetiredOrphans: [...result.logicallyRetiredOrphans].sort(),
    cleanupWarnings: [...result.cleanupWarnings],
  };
}

/**
 * Mechanical Phase 6 completion owner. Cognition supplies the exact completion
 * instruction. This service never infers semantic completion from prose and does
 * not persist a pending action/queue. Its only durable mutations are delegated
 * to the existing MissionFinalizationService after the Coordinator turn ends.
 */
export class MissionCoordinatorCompletionService {
  constructor(
    private readonly tasks: TaskRuntime,
    private readonly collaboration: MissionCollaborationStore,
    private readonly coordinator: MissionCoordinatorService,
    private readonly workers: WorkerSessionManager,
    private readonly finalizer: MissionFinalizationService,
  ) {}

  /** Read-only product review. The live command must still take its own lease
   * and repeat readiness before finalization; this observation is no authority. */
  async inspectReadiness(input: CompleteManagedScopeInstruction): Promise<ManagedScopeCompletionReadiness> {
    return this.readiness(await this.requireExactInstruction(input));
  }

  async preflight(
    input: CompleteManagedScopeInstruction,
    currentCoordinatorManagedSessionId: string,
  ): Promise<ManagedScopeCompletionReadiness> {
    const instruction = await this.requireExactInstruction(input);
    const currentSession = this.workers.getSession(currentCoordinatorManagedSessionId);
    if (!currentSession) throw new Error(`Coordinator WorkerSession does not exist: ${currentCoordinatorManagedSessionId}`);
    if (currentSession.taskId !== instruction.coordinationMissionId) {
      throw new Error(`Coordinator WorkerSession ${currentCoordinatorManagedSessionId} is bound to ${currentSession.taskId ?? "no Task"}, not Coordination Mission ${instruction.coordinationMissionId}.`);
    }
    if (currentSession.state !== "running") {
      throw new Error(`Coordinator completion preflight requires the exact current active send lease: ${currentCoordinatorManagedSessionId}.`);
    }
    const root = this.requireMission(instruction.managedRootMissionId, "Managed root Mission");
    const coordination = this.requireMission(instruction.coordinationMissionId, "Coordinator Mission");
    if (root.missionFinalization || coordination.missionFinalization) {
      return this.readiness(instruction, currentCoordinatorManagedSessionId, [{
        code: "inconsistent-lifecycle-order",
        missionId: coordination.missionFinalization ? coordination.taskId : root.taskId,
      }]);
    }
    return this.readiness(instruction, currentCoordinatorManagedSessionId);
  }

  /**
   * Called only after the Coordinator send has reached trustworthy completed
   * terminal and released its active send lease. Root + Coordinator admission
   * fences are installed before fresh readiness is evaluated, so a child that
   * wins before the fence is visible to readiness and a later child is rejected.
   */
  async finalizeAfterCompletedTurn(input: CompleteManagedScopeInstruction): Promise<ManagedScopeCompletionResult> {
    const instruction = await this.requireExactInstruction(input);
    const root = this.requireMission(instruction.managedRootMissionId, "Managed root Mission");
    const coordination = this.requireMission(instruction.coordinationMissionId, "Coordinator Mission");
    if (root.missionFinalization || coordination.missionFinalization) {
      throw new Error("Initial post-turn completion requires active root and Coordinator Missions; use partial-finalization recovery for durable partial state.");
    }
    return this.withCompletionFences(instruction, false);
  }

  /**
   * Explicit trusted-host recovery for a sequence that already crossed the
   * durable Coordinator-finalization boundary before interruption. It cannot
   * initiate completion from an entirely active pair, so it is not a bypass for
   * the required Coordinator Worker completion turn.
   */
  async recoverPartialFinalization(input: CompleteManagedScopeInstruction): Promise<ManagedScopeCompletionResult> {
    const instruction = await this.requireExactInstruction(input);
    const root = this.requireMission(instruction.managedRootMissionId, "Managed root Mission");
    const coordination = this.requireMission(instruction.coordinationMissionId, "Coordinator Mission");
    if (!root.missionFinalization && !coordination.missionFinalization) {
      throw new Error("Managed-scope completion recovery requires existing durable partial finalization state.");
    }
    if (root.missionFinalization && !coordination.missionFinalization) {
      throw new Error("Managed-scope completion has an inconsistent lifecycle order: root is terminal while Coordinator is still active.");
    }
    return this.withCompletionFences(instruction, true);
  }

  private async withCompletionFences(
    instruction: CompleteManagedScopeInstruction,
    allowPartial: boolean,
  ): Promise<ManagedScopeCompletionResult> {
    return this.tasks.withMissionFinalizationStabilization(instruction.managedRootMissionId, async () =>
      this.tasks.withMissionFinalizationStabilization(instruction.coordinationMissionId, async () => {
        // WO#4A: make collaboration blocker admission and the final readiness ->
        // lifecycle mutation interval one linearizable ordering. This gate is the
        // exact MissionCollaborationStore operation lane used by every durable
        // exchange/relation write. An earlier write drains before readiness; a
        // later write waits until the Coordinator/root death sequence finishes.
        //
        // TaskRuntime stabilization above holds only in-memory admission fences;
        // it released each task-exclusive lane before we enter this gate. The
        // finalizer may therefore keep its established provider barrier -> task
        // lane ordering while this independent collaboration lane is held.
        return this.collaboration.withMutationStabilization(async () => {
          const before = await this.readiness(instruction);
          this.assertReady(before, allowPartial ? "partial-finalization recovery" : "post-turn completion");

          const coordinatorResult = await this.finalizer.finalizeMission(instruction.coordinationMissionId, { requireHandoff: true });

          // Task/Worker reality may still have changed while Coordinator resources
          // were retired. Collaboration reality cannot change inside this gate,
          // but re-read the full predicate before crossing the root death boundary.
          const beforeRoot = await this.readiness(instruction);
          this.assertReady(beforeRoot, "managed-root finalization");
          const rootResult = await this.finalizer.finalizeMission(instruction.managedRootMissionId, { requireHandoff: true });

          return {
            version: 1,
            kind: "managed-scope-completion-result",
            projectId: instruction.projectId,
            managedRootMissionId: instruction.managedRootMissionId,
            coordinationMissionId: instruction.coordinationMissionId,
            completionKey: instruction.completionKey,
            coordinator: finalizationSummary(coordinatorResult),
            root: finalizationSummary(rootResult),
          };
        });
      }));
  }

  private async readiness(
    instruction: CompleteManagedScopeInstruction,
    currentCoordinatorManagedSessionId?: string,
    initialBlockers: ManagedScopeCompletionBlocker[] = [],
  ): Promise<ManagedScopeCompletionReadiness> {
    const blockers = [...initialBlockers];
    const managed = this.tasks.listTasks()
      .filter(task => task.mission?.projectId === instruction.projectId
        && task.mission.rootMissionId === instruction.managedRootMissionId);
    const managedIds = new Set(managed.map(task => task.taskId));

    for (const task of managed) {
      if (task.taskId !== instruction.managedRootMissionId && task.taskId !== instruction.coordinationMissionId) {
        if (!task.missionFinalization) blockers.push({ code: "active-descendant", missionId: task.taskId });
        else if (task.missionFinalization.state !== "archived") blockers.push({ code: "descendant-not-archived", missionId: task.taskId });
      }
      if (taskHasUnsettledWork(task)) blockers.push({ code: "running-task-work", missionId: task.taskId });
      if (task.missionFinalization?.handoffRequired && !getMissionFinalHandoff(task)) {
        blockers.push({ code: "invalid-final-handoff", missionId: task.taskId });
      }
      if (task.missionFinalization?.state === "archived" && !task.missionFinalization.archivedAt) {
        blockers.push({ code: "invalid-archived-state", missionId: task.taskId });
      }
    }

    const root = this.requireMission(instruction.managedRootMissionId, "Managed root Mission");
    const coordination = this.requireMission(instruction.coordinationMissionId, "Coordinator Mission");
    if (root.missionFinalization && !coordination.missionFinalization) {
      blockers.push({ code: "inconsistent-lifecycle-order", missionId: root.taskId });
    }

    for (const relation of this.collaboration.listRelations(instruction.projectId, { includeDerivedParent: false })) {
      if (relation.type !== "depends_on" || !managedIds.has(relation.sourceMissionId)) continue;
      const target = this.tasks.getTask(relation.targetMissionId);
      if (!target?.missionFinalization) {
        blockers.push({
          code: "unfinished-dependency",
          relationId: relation.relationId,
          missionId: relation.sourceMissionId,
          targetMissionId: relation.targetMissionId,
        });
      }
    }

    const exchanges = this.collaboration.listExchanges(instruction.projectId);
    const relations = this.collaboration.listRelations(instruction.projectId, { includeDerivedParent: false });
    for (const problem of exchanges) {
      if (problem.kind !== "Problem" || !problem.payload.blocking) continue;
      if (!managedIds.has(problem.sourceMissionId)
        && !(problem.targetMissionId && managedIds.has(problem.targetMissionId))) continue;
      const resolved = exchanges.some(answer => {
        if (answer.kind !== "Answer"
          || answer.replyToExchangeId !== problem.exchangeId
          || answer.targetMissionId !== problem.sourceMissionId) return false;
        return relations.some(relation => relation.type === "answers"
          && relation.basisExchangeId === answer.exchangeId
          && relation.sourceMissionId === answer.sourceMissionId
          && relation.targetMissionId === answer.targetMissionId);
      });
      if (!resolved) blockers.push({ code: "unresolved-blocking-problem", exchangeId: problem.exchangeId, missionId: problem.sourceMissionId });
    }

    for (const session of this.workers.listSessions()) {
      if (!session.taskId || !managedIds.has(session.taskId) || session.state !== "running") continue;
      if (currentCoordinatorManagedSessionId
        && session.managedSessionId === currentCoordinatorManagedSessionId
        && session.taskId === instruction.coordinationMissionId) continue;
      blockers.push({ code: "running-worker-session", missionId: session.taskId, managedSessionId: session.managedSessionId });
    }

    blockers.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return {
      version: 1,
      kind: "managed-scope-completion-readiness",
      projectId: instruction.projectId,
      managedRootMissionId: instruction.managedRootMissionId,
      coordinationMissionId: instruction.coordinationMissionId,
      completionKey: instruction.completionKey,
      ready: blockers.length === 0,
      blockers,
    };
  }

  private async requireExactInstruction(input: CompleteManagedScopeInstruction): Promise<CompleteManagedScopeInstruction> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Managed-scope completion instruction is required.");
    const completionKey = boundedCompletionKey(input.completionKey);
    const inspection = await this.coordinator.inspectManagedScope(input);
    if (inspection.coordinationMissionId !== input.coordinationMissionId) {
      throw new Error(`Supplied Coordinator Mission ${input.coordinationMissionId} is not the exact managed Coordinator Mission ${inspection.coordinationMissionId}.`);
    }
    const root = this.requireMission(input.managedRootMissionId, "Managed root Mission");
    if (root.taskId !== input.managedRootMissionId
      || root.mission?.projectId !== input.projectId
      || root.mission.rootMissionId !== root.taskId
      || root.mission.parentMissionId !== undefined) {
      throw new Error(`Managed root Mission ${input.managedRootMissionId} does not identify the exact Project root.`);
    }
    const coordination = this.requireMission(input.coordinationMissionId, "Coordinator Mission");
    if (coordination.mission?.projectId !== input.projectId
      || coordination.mission.rootMissionId !== input.managedRootMissionId
      || coordination.mission.parentMissionId !== input.managedRootMissionId
      || coordination.mission.plane !== "coordination") {
      throw new Error(`Coordinator Mission ${input.coordinationMissionId} does not identify the exact managed Coordination Mission.`);
    }
    return {
      projectId: input.projectId,
      managedRootMissionId: input.managedRootMissionId,
      coordinationMissionId: input.coordinationMissionId,
      completionKey,
    };
  }

  private assertReady(readiness: ManagedScopeCompletionReadiness, phase: string): void {
    if (readiness.ready) return;
    const summary = readiness.blockers.map(blocker => `${blocker.code}:${blocker.missionId ?? blocker.relationId ?? blocker.exchangeId ?? "scope"}`).join(", ");
    throw new Error(`Managed scope is not mechanically ready for ${phase}: ${summary}`);
  }

  private requireMission(taskId: string, label: string): TaskSnapshot {
    const task = this.tasks.getTask(taskId);
    if (!task?.mission) throw new Error(`${label} does not exist or is not configured: ${taskId}`);
    return task;
  }
}
