import { createHash } from "node:crypto";
import type { ProjectSnapshot } from "./project-contract.js";
import type { ProjectStore } from "./project-store.js";
import type { MissionCoordinatorService } from "./mission-coordinator-service.js";
import type { MissionPlane, TaskMissionMetadata, TaskSnapshot, TaskSource } from "./task-contract.js";
import type { TaskRuntime } from "./task-runtime.js";

const MAX_ID_CHARS = 240;
const MAX_GOAL_CHARS = 8_000;
const MAX_MISSION_TYPE_CHARS = 160;
const MAX_COMPLETION_CRITERIA = 32;
const MAX_COMPLETION_CRITERION_CHARS = 1_000;
const MAX_CONTEXT_SUMMARY_CHARS = 24_000;
const MAX_CONTEXT_ITEMS = 128;
const MAX_CONTEXT_ITEM_CHARS = 4_000;

export interface ProjectLaterRootOperation {
  rootOperationId: string;
  projectId: string;
  goal: string;
  plane: MissionPlane;
  missionType: string;
  completionCriteria: string[];
  contextSummary?: string;
  constraints?: string[];
}

export interface EnsuredProjectLaterRoot {
  project: ProjectSnapshot;
  rootMission: TaskSnapshot;
  coordinatorMission: TaskSnapshot;
}

function plainOwnRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain own-data record.`);
  return value as Record<string, unknown>;
}

function exactOwnDataKeys(row: Record<string, unknown>, allowed: readonly string[], required: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(row)) {
    if (typeof key !== "string") throw new Error(`${label} contains unsupported symbol field.`);
    if (!allowedSet.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label}.${key} must be an own data property.`);
  }
  for (const key of required) {
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label} is missing required field: ${key}`);
  }
}

function ownValue(row: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function boundedText(value: unknown, maxChars: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters.`);
  return normalized;
}

function denseStringList(value: unknown, label: string, maxItems: number, maxChars: number, allowEmpty = false): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${label} must use the standard Array prototype.`);
  if (!allowEmpty && value.length === 0) throw new Error(`${label} must contain at least one item.`);
  if (value.length > maxItems) throw new Error(`${label} must contain at most ${maxItems} items.`);
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${label} must be dense.`);
    result.push(boundedText(value[index], maxChars, `${label} ${index + 1}`));
  }
  return result;
}

function normalizePlane(value: unknown): MissionPlane {
  if (value !== "coordination" && value !== "cognition" && value !== "practice") {
    throw new Error(`Unsupported later-root Mission plane: ${String(value)}`);
  }
  return value;
}

function normalizeOperation(value: unknown): ProjectLaterRootOperation {
  const row = plainOwnRecord(value, "Later Project root operation");
  exactOwnDataKeys(
    row,
    ["rootOperationId", "projectId", "goal", "plane", "missionType", "completionCriteria", "contextSummary", "constraints"],
    ["rootOperationId", "projectId", "goal", "plane", "missionType", "completionCriteria"],
    "Later Project root operation",
  );
  return {
    rootOperationId: boundedText(ownValue(row, "rootOperationId"), MAX_ID_CHARS, "Later root operation id"),
    projectId: boundedText(ownValue(row, "projectId"), MAX_ID_CHARS, "Project id"),
    goal: boundedText(ownValue(row, "goal"), MAX_GOAL_CHARS, "Later root goal"),
    plane: normalizePlane(ownValue(row, "plane")),
    missionType: boundedText(ownValue(row, "missionType"), MAX_MISSION_TYPE_CHARS, "Later root Mission type"),
    completionCriteria: denseStringList(ownValue(row, "completionCriteria"), "Later root completion criteria", MAX_COMPLETION_CRITERIA, MAX_COMPLETION_CRITERION_CHARS),
    ...(Object.prototype.hasOwnProperty.call(row, "contextSummary")
      ? { contextSummary: boundedText(ownValue(row, "contextSummary"), MAX_CONTEXT_SUMMARY_CHARS, "Later root context summary") }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(row, "constraints")
      ? { constraints: denseStringList(ownValue(row, "constraints"), "Later root constraints", MAX_CONTEXT_ITEMS, MAX_CONTEXT_ITEM_CHARS, true) }
      : {}),
  };
}

function operationDigest(projectId: string, rootOperationId: string): string {
  return createHash("sha256").update(`project-later-root-v1\0${projectId}\0${rootOperationId}`).digest("hex");
}

export function projectLaterRootSource(input: Pick<ProjectLaterRootOperation, "projectId" | "rootOperationId">, workspace?: string): TaskSource {
  return {
    kind: "mission",
    key: `project-later-root:v1:${operationDigest(input.projectId, input.rootOperationId)}`,
    ...(workspace === undefined ? {} : { workspace }),
  };
}

function missionMatches(actual: TaskMissionMetadata | undefined, expected: TaskMissionMetadata): boolean {
  return !!actual
    && actual.projectId === expected.projectId
    && actual.rootMissionId === expected.rootMissionId
    && actual.parentMissionId === expected.parentMissionId
    && actual.plane === expected.plane
    && actual.missionType === expected.missionType
    && actual.completionCriteria.length === expected.completionCriteria.length
    && actual.completionCriteria.every((value, index) => value === expected.completionCriteria[index]);
}

function contextMatches(task: TaskSnapshot, input: ProjectLaterRootOperation): boolean {
  const constraints = input.constraints ?? [];
  return task.context.summary === input.contextSummary
    && task.context.constraints.length === constraints.length
    && task.context.constraints.every((value, index) => value === constraints[index]);
}

/** Stateless/reconstructible later same-Project root operation. */
export class ProjectRootOperationService {
  constructor(
    private readonly projects: ProjectStore,
    private readonly tasks: TaskRuntime,
    private readonly coordinator: MissionCoordinatorService,
  ) {}

  async ensureLaterRoot(value: unknown): Promise<EnsuredProjectLaterRoot> {
    const input = normalizeOperation(value);
    await Promise.all([this.projects.initialize(), this.tasks.initialize()]);
    const project = this.projects.getProject(input.projectId);
    if (!project) throw new Error(`Unknown Project: ${input.projectId}`);
    if (!project.formationReceipt) throw new Error(`Project ${input.projectId} has no accepted Project Formation receipt.`);

    const source = projectLaterRootSource(input, project.workspace);
    let root = await this.tasks.rereadTaskBySource(source);
    if (!root) root = await this.tasks.ensureTask(source, input.goal);
    if (root.goal !== input.goal) throw new Error(`Later root operation ${input.rootOperationId} identity/content collision at goal.`);

    const mission: TaskMissionMetadata = {
      projectId: project.projectId,
      rootMissionId: root.taskId,
      plane: input.plane,
      missionType: input.missionType,
      completionCriteria: [...input.completionCriteria],
    };
    if (root.mission && !missionMatches(root.mission, mission)) {
      throw new Error(`Later root operation ${input.rootOperationId} identity/content collision at Mission metadata.`);
    }
    if (!root.mission) root = await this.tasks.configureMission(root.taskId, mission);
    if (!missionMatches(root.mission, mission)) throw new Error(`Later root operation ${input.rootOperationId} identity/content collision at Mission metadata.`);

    if (!contextMatches(root, input)) {
      if (root.missionFinalization) {
        throw new Error(`Later root operation ${input.rootOperationId} terminal root has conflicting initial context.`);
      }
      root = await this.tasks.ensureMissionInitialContextStrict(root.taskId, {
        ...(input.contextSummary === undefined ? {} : { summary: input.contextSummary }),
        constraints: [...(input.constraints ?? [])],
      });
    }
    if (!contextMatches(root, input)) throw new Error(`Later root operation ${input.rootOperationId} identity/content collision at initial context.`);

    const reread = await this.tasks.rereadTaskBySource(source);
    if (!reread || reread.taskId !== root.taskId || reread.goal !== input.goal || !missionMatches(reread.mission, mission) || !contextMatches(reread, input)) {
      throw new Error(`Later root operation ${input.rootOperationId} cannot reconstruct its exact canonical root.`);
    }
    const coordinatorMission = await this.coordinator.ensureCoordinatorMission({ projectId: project.projectId, managedRootMissionId: reread.taskId });
    return { project, rootMission: reread, coordinatorMission };
  }
}
