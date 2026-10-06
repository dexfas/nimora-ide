import { createHash } from "node:crypto";
import type { MissionExchange, MissionGraphRelation } from "./mission-collaboration-contract.js";
import type { MissionCollaborationStore } from "./mission-collaboration-store.js";
import type { EnsuredFeedbackCognition, MissionFeedbackService } from "./mission-feedback-service.js";
import type { ProjectStore } from "./project-store.js";
import type { MissionPlane, TaskMissionMetadata, TaskSnapshot, TaskSource } from "./task-contract.js";
import type { TaskRuntime } from "./task-runtime.js";

const MAX_ID_CHARS = 240;
const MAX_GOAL_CHARS = 8_000;
const MAX_MISSION_TYPE_CHARS = 160;
const MAX_COMPLETION_CRITERIA = 32;
const MAX_COMPLETION_CRITERION_CHARS = 1_000;

const COORDINATOR_MISSION_TYPE = "explicit-command-coordinator";
const COORDINATOR_COMPLETION_CRITERIA = [
  "Explicit semantic instructions for the managed root are transported or executed only through their owning Nimora services.",
];

export interface MissionCoordinatorScope {
  projectId: string;
  managedRootMissionId: string;
}

export interface EnsureMissionInstruction extends MissionCoordinatorScope {
  operationKey: string;
  goal: string;
  parentMissionId: string;
  plane: MissionPlane;
  missionType: string;
  completionCriteria: string[];
}

export interface RoutePracticeProblemInstruction extends MissionCoordinatorScope {
  practiceMissionId: string;
  problemExchangeId: string;
}

export interface MissionCoordinatorMissionInspection {
  missionId: string;
  goal?: string;
  projectId: string;
  rootMissionId: string;
  parentMissionId?: string;
  plane: MissionPlane;
  missionType: string;
  completionCriteria: string[];
  terminal?: {
    state: "completed" | "archived";
    completedAt: string;
    archivedAt?: string;
  };
}

export interface MissionCoordinatorRelationInspection {
  relationId: string;
  type: MissionGraphRelation["type"];
  sourceMissionId: string;
  targetMissionId: string;
  basisExchangeId?: string;
  derived: boolean;
}

export interface MissionCoordinatorExchangeInspection {
  exchangeId: string;
  kind: MissionExchange["kind"];
  sourceMissionId: string;
  targetMissionId?: string;
  replyToExchangeId?: string;
  blocking?: boolean;
}

export interface MissionCoordinatorInspection {
  version: 1;
  projectId: string;
  managedRootMissionId: string;
  coordinationMissionId: string;
  missions: MissionCoordinatorMissionInspection[];
  relations: MissionCoordinatorRelationInspection[];
  exchanges: MissionCoordinatorExchangeInspection[];
}

interface NormalizedEnsureMissionInstruction extends MissionCoordinatorScope {
  operationKey: string;
  goal: string;
  parentMissionId: string;
  plane: MissionPlane;
  missionType: string;
  completionCriteria: string[];
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`;
}

function boundedText(value: unknown, maxChars: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters.`);
  return normalized;
}

function boundedIdentity(value: unknown, label: string): string {
  return boundedText(value, MAX_ID_CHARS, label);
}

function normalizeScope(input: MissionCoordinatorScope): MissionCoordinatorScope {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Coordinator scope is required.");
  return {
    projectId: boundedIdentity(input.projectId, "Project id"),
    managedRootMissionId: boundedIdentity(input.managedRootMissionId, "Managed root Mission id"),
  };
}

function normalizePlane(value: unknown): MissionPlane {
  if (value !== "coordination" && value !== "cognition" && value !== "practice") {
    throw new Error(`Unsupported Mission plane: ${String(value)}`);
  }
  return value;
}

function normalizeCompletionCriteria(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Mission completion criteria must contain at least one item.");
  if (value.length > MAX_COMPLETION_CRITERIA) {
    throw new Error(`Mission completion criteria must contain at most ${MAX_COMPLETION_CRITERIA} items.`);
  }
  return value.map((criterion, index) => boundedText(
    criterion,
    MAX_COMPLETION_CRITERION_CHARS,
    `Mission completion criterion ${index + 1}`,
  ));
}

function normalizeEnsureMissionInstruction(input: EnsureMissionInstruction): NormalizedEnsureMissionInstruction {
  const scope = normalizeScope(input);
  return {
    ...scope,
    operationKey: boundedIdentity(input.operationKey, "Mission operation key"),
    goal: boundedText(input.goal, MAX_GOAL_CHARS, "Mission goal"),
    parentMissionId: boundedIdentity(input.parentMissionId, "Parent Mission id"),
    plane: normalizePlane(input.plane),
    missionType: boundedText(input.missionType, MAX_MISSION_TYPE_CHARS, "Mission type"),
    completionCriteria: normalizeCompletionCriteria(input.completionCriteria),
  };
}

function coordinatorOperationDigest(prefix: string, parts: readonly string[]): string {
  return createHash("sha256").update(`${prefix}\0${parts.join("\0")}`).digest("hex");
}

export function missionCoordinatorBootstrapSource(input: MissionCoordinatorScope): TaskSource {
  const scope = normalizeScope(input);
  return {
    kind: "mission",
    key: `coordinator:bootstrap:v1:${coordinatorOperationDigest("mission-coordinator-bootstrap-v1", [scope.projectId, scope.managedRootMissionId])}`,
  };
}

export function missionCoordinatorEnsureMissionSource(input: MissionCoordinatorScope & { operationKey: string }): TaskSource {
  const scope = normalizeScope(input);
  const operationKey = boundedIdentity(input.operationKey, "Mission operation key");
  return {
    kind: "mission",
    key: `coordinator:ensure:v1:${coordinatorOperationDigest("mission-coordinator-ensure-v1", [scope.projectId, scope.managedRootMissionId, operationKey])}`,
  };
}

function coordinatorGoal(scope: MissionCoordinatorScope): string {
  return `Execute explicit semantic instructions for managed root Mission ${scope.managedRootMissionId}.`;
}

function coordinatorMetadata(scope: MissionCoordinatorScope): TaskMissionMetadata {
  return {
    projectId: scope.projectId,
    rootMissionId: scope.managedRootMissionId,
    parentMissionId: scope.managedRootMissionId,
    plane: "coordination",
    missionType: COORDINATOR_MISSION_TYPE,
    completionCriteria: [...COORDINATOR_COMPLETION_CRITERIA],
  };
}

function missionMeaningMatches(task: TaskSnapshot, goal: string, mission: TaskMissionMetadata): boolean {
  return task.goal === goal && !!task.mission && stableJson(task.mission) === stableJson(mission);
}

/**
 * Stateless/reconstructible Phase 6 bridge facade. It only executes explicit
 * semantic instructions against existing durable owners. It deliberately owns
 * no journal, queue, scheduler, Project memory, Worker/provider choice, send
 * path, delivery acknowledgement, or semantic completion authority.
 */
export class MissionCoordinatorService {
  constructor(
    private readonly projects: ProjectStore,
    private readonly tasks: TaskRuntime,
    private readonly collaboration: MissionCollaborationStore,
    private readonly feedback: MissionFeedbackService,
  ) {}

  async ensureCoordinatorMission(input: MissionCoordinatorScope): Promise<TaskSnapshot> {
    await this.initialize();
    const scope = normalizeScope(input);
    const root = this.requireManagedRoot(scope);
    const source = missionCoordinatorBootstrapSource(scope);
    const goal = coordinatorGoal(scope);
    const mission = coordinatorMetadata(scope);
    const existing = this.tasks.findTaskBySource(source);

    if (existing?.mission) {
      if (!missionMeaningMatches(existing, goal, mission)) {
        throw new Error(`Coordinator bootstrap identity/content collision for managed root ${scope.managedRootMissionId}.`);
      }
      return existing;
    }
    if (existing && existing.goal !== goal) {
      throw new Error(`Coordinator bootstrap identity/content collision for managed root ${scope.managedRootMissionId}.`);
    }
    this.requireActiveMission(root, "Managed root Mission");

    const task = existing ?? await this.tasks.ensureTask(source, goal);
    if (task.goal !== goal) {
      throw new Error(`Coordinator bootstrap identity/content collision for managed root ${scope.managedRootMissionId}.`);
    }
    if (task.taskId === scope.managedRootMissionId) {
      throw new Error("Coordinator Mission cannot be the managed root Mission itself.");
    }
    const configured = await this.tasks.configureMission(task.taskId, mission);
    if (!missionMeaningMatches(configured, goal, mission)) {
      throw new Error(`Coordinator bootstrap identity/content collision for managed root ${scope.managedRootMissionId}.`);
    }
    return configured;
  }

  async ensureMission(input: EnsureMissionInstruction): Promise<TaskSnapshot> {
    await this.initialize();
    const instruction = normalizeEnsureMissionInstruction(input);
    const scope = { projectId: instruction.projectId, managedRootMissionId: instruction.managedRootMissionId };
    const root = this.requireManagedRoot(scope);
    const coordinator = this.requireCoordinatorMission(scope);
    const source = missionCoordinatorEnsureMissionSource(instruction);
    const mission: TaskMissionMetadata = {
      projectId: instruction.projectId,
      rootMissionId: instruction.managedRootMissionId,
      parentMissionId: instruction.parentMissionId,
      plane: instruction.plane,
      missionType: instruction.missionType,
      completionCriteria: [...instruction.completionCriteria],
    };
    const existing = this.tasks.findTaskBySource(source);

    if (existing?.taskId === instruction.parentMissionId) {
      throw new Error("Explicit ensure-Mission instruction cannot make a Mission its own parent.");
    }
    if (existing?.mission) {
      if (!missionMeaningMatches(existing, instruction.goal, mission)) {
        throw new Error(`Ensure-Mission operation identity/content collision: ${instruction.operationKey}`);
      }
      this.requireInManagedScopeParent(instruction.parentMissionId, scope, false);
      return existing;
    }
    if (existing && existing.goal !== instruction.goal) {
      throw new Error(`Ensure-Mission operation identity/content collision: ${instruction.operationKey}`);
    }

    this.requireActiveMission(root, "Managed root Mission");
    this.requireActiveMission(coordinator, "Coordinator Mission");
    this.requireInManagedScopeParent(instruction.parentMissionId, scope, true);
    const task = existing ?? await this.tasks.ensureTask(source, instruction.goal);
    if (task.goal !== instruction.goal) {
      throw new Error(`Ensure-Mission operation identity/content collision: ${instruction.operationKey}`);
    }
    if (task.taskId === instruction.parentMissionId) {
      throw new Error("Explicit ensure-Mission instruction cannot make a Mission its own parent.");
    }
    const configured = await this.tasks.configureMission(task.taskId, mission);
    if (!missionMeaningMatches(configured, instruction.goal, mission)) {
      throw new Error(`Ensure-Mission operation identity/content collision: ${instruction.operationKey}`);
    }
    return configured;
  }

  async inspectManagedScope(input: MissionCoordinatorScope): Promise<MissionCoordinatorInspection> {
    await this.initialize();
    const scope = normalizeScope(input);
    this.requireManagedRoot(scope);
    const coordinationMission = this.requireCoordinatorMission(scope);
    const missions = this.tasks.listTasks()
      .filter(task => task.mission?.projectId === scope.projectId && task.mission.rootMissionId === scope.managedRootMissionId)
      .map(task => this.missionInspection(task))
      .sort((a, b) => a.missionId.localeCompare(b.missionId));
    const managedIds = new Set(missions.map(mission => mission.missionId));
    const relations = this.collaboration.listRelations(scope.projectId)
      .filter(relation => managedIds.has(relation.sourceMissionId) || managedIds.has(relation.targetMissionId))
      .map(relation => this.relationInspection(relation));
    const exchanges = this.collaboration.listExchanges(scope.projectId)
      .filter(exchange => managedIds.has(exchange.sourceMissionId) || (!!exchange.targetMissionId && managedIds.has(exchange.targetMissionId)))
      .map(exchange => this.exchangeInspection(exchange));
    return {
      version: 1,
      projectId: scope.projectId,
      managedRootMissionId: scope.managedRootMissionId,
      coordinationMissionId: coordinationMission.taskId,
      missions,
      relations,
      exchanges,
    };
  }

  async routePracticeProblem(input: RoutePracticeProblemInstruction): Promise<EnsuredFeedbackCognition> {
    await this.initialize();
    const scope = normalizeScope(input);
    const root = this.requireManagedRoot(scope);
    const coordinator = this.requireCoordinatorMission(scope);
    this.requireActiveMission(root, "Managed root Mission");
    this.requireActiveMission(coordinator, "Coordinator Mission");
    const practiceMissionId = boundedIdentity(input.practiceMissionId, "Practice Mission id");
    const problemExchangeId = boundedIdentity(input.problemExchangeId, "Problem exchange id");
    const practice = this.tasks.getTask(practiceMissionId);
    if (!practice?.mission) throw new Error(`Practice Mission does not exist or is not configured: ${practiceMissionId}`);
    if (practice.mission.projectId !== scope.projectId || practice.mission.rootMissionId !== scope.managedRootMissionId) {
      throw new Error(`Practice Mission ${practiceMissionId} is outside the managed Coordinator scope.`);
    }
    if (practice.mission.plane !== "practice") throw new Error(`Problem route source must be a Practice Mission: ${practiceMissionId}`);
    this.requireActiveMission(practice, "Practice Mission");
    const problem = this.collaboration.getExchange(problemExchangeId);
    if (!problem) throw new Error(`Unknown Problem exchange: ${problemExchangeId}`);
    if (problem.kind !== "Problem") throw new Error(`Explicit Problem route requires a Problem exchange: ${problemExchangeId}`);
    if (problem.projectId !== scope.projectId || problem.sourceMissionId !== practiceMissionId) {
      throw new Error(`Problem ${problemExchangeId} does not belong to the exact in-scope Practice Mission.`);
    }
    return this.feedback.ensureCognitionForProblem({
      projectId: scope.projectId,
      practiceMissionId,
      problemExchangeId,
    });
  }

  private async initialize(): Promise<void> {
    await Promise.all([
      this.projects.initialize(),
      this.tasks.initialize(),
      this.collaboration.initialize(),
    ]);
  }

  private requireManagedRoot(scope: MissionCoordinatorScope): TaskSnapshot {
    if (!this.projects.getProject(scope.projectId)) throw new Error(`Unknown Project: ${scope.projectId}`);
    const root = this.tasks.getTask(scope.managedRootMissionId);
    if (!root?.mission) throw new Error(`Managed root Mission does not exist or is not configured: ${scope.managedRootMissionId}`);
    if (root.taskId !== scope.managedRootMissionId
      || root.mission.projectId !== scope.projectId
      || root.mission.rootMissionId !== root.taskId
      || root.mission.parentMissionId !== undefined) {
      throw new Error(`Managed root Mission ${scope.managedRootMissionId} does not identify the exact Project root.`);
    }
    return root;
  }

  private requireInManagedScopeParent(parentMissionId: string, scope: MissionCoordinatorScope, requireActive: boolean): TaskSnapshot {
    const parent = this.tasks.getTask(parentMissionId);
    if (!parent?.mission) throw new Error(`Parent Mission does not exist or is not configured: ${parentMissionId}`);
    if (parent.mission.projectId !== scope.projectId || parent.mission.rootMissionId !== scope.managedRootMissionId) {
      throw new Error(`Parent Mission ${parentMissionId} is outside the managed Coordinator scope.`);
    }
    if (requireActive) this.requireActiveMission(parent, "Parent Mission");
    return parent;
  }

  private requireCoordinatorMission(scope: MissionCoordinatorScope): TaskSnapshot {
    const candidate = this.tasks.findTaskBySource(missionCoordinatorBootstrapSource(scope));
    if (!candidate?.mission) throw new Error(`Coordinator Mission is not configured for managed root ${scope.managedRootMissionId}.`);
    if (!missionMeaningMatches(candidate, coordinatorGoal(scope), coordinatorMetadata(scope))) {
      throw new Error(`Coordinator bootstrap identity/content collision for managed root ${scope.managedRootMissionId}.`);
    }
    return candidate;
  }

  private requireActiveMission(task: TaskSnapshot, label: string): void {
    if (task.missionFinalization) {
      throw new Error(`${label} ${task.taskId} is terminal (${task.missionFinalization.state}) and cannot accept new routed work.`);
    }
  }

  private missionInspection(task: TaskSnapshot): MissionCoordinatorMissionInspection {
    const mission = task.mission!;
    return {
      missionId: task.taskId,
      ...(task.goal === undefined ? {} : { goal: task.goal }),
      projectId: mission.projectId,
      rootMissionId: mission.rootMissionId,
      ...(mission.parentMissionId === undefined ? {} : { parentMissionId: mission.parentMissionId }),
      plane: mission.plane,
      missionType: mission.missionType,
      completionCriteria: [...mission.completionCriteria],
      ...(task.missionFinalization ? {
        terminal: {
          state: task.missionFinalization.state,
          completedAt: task.missionFinalization.completedAt,
          ...(task.missionFinalization.archivedAt === undefined ? {} : { archivedAt: task.missionFinalization.archivedAt }),
        },
      } : {}),
    };
  }

  private relationInspection(relation: MissionGraphRelation): MissionCoordinatorRelationInspection {
    return {
      relationId: relation.relationId,
      type: relation.type,
      sourceMissionId: relation.sourceMissionId,
      targetMissionId: relation.targetMissionId,
      ...("basisExchangeId" in relation && relation.basisExchangeId !== undefined ? { basisExchangeId: relation.basisExchangeId } : {}),
      derived: "derived" in relation && relation.derived === true,
    };
  }

  private exchangeInspection(exchange: MissionExchange): MissionCoordinatorExchangeInspection {
    return {
      exchangeId: exchange.exchangeId,
      kind: exchange.kind,
      sourceMissionId: exchange.sourceMissionId,
      ...(exchange.targetMissionId === undefined ? {} : { targetMissionId: exchange.targetMissionId }),
      ...("replyToExchangeId" in exchange ? { replyToExchangeId: exchange.replyToExchangeId } : {}),
      ...(exchange.kind === "Problem" ? { blocking: exchange.payload.blocking } : {}),
    };
  }
}
