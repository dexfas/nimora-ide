import type { MissionContextSection } from "./mission-context-materializer.js";

export type MissionWorkerInputProfileRequest = "auto" | "research" | "practice" | "coordination";

export interface MissionWorkerInputBudgetRequest {
  maxInstructionChars: number;
  maxContextChars: number;
  maxSkillChars: number;
  maxSchemaChars: number;
  maxCombinedChars: number;
  capacity?: {
    maxInputChars: number;
    outputReserveChars: number;
  };
}

export interface MissionWorkerInputContextConstraints {
  includeDraftProposals?: boolean;
  includeRelatedResearch?: boolean;
  requiredItemIds?: string[];
  sectionChars?: Partial<Record<MissionContextSection, number>>;
}

export interface MissionWorkerInputCapabilityConstraints {
  requiredCapabilityIds?: string[];
  optionalCapabilityIds?: string[];
  /** Hard ceiling independent of the profile's default tools. */
  allowedCapabilityIds?: string[];
}

export interface MissionWorkerInputSkillConstraints {
  requiredSkillIds?: string[];
  optionalSkillIds?: string[];
  trustedSourceIds?: string[];
  trustedSkillIds?: string[];
  relevanceTags?: string[];
  sessionType?: string;
}

export interface MissionWorkspaceAccessPolicy {
  allowedPathPrefixes: string[];
}

/** Exact policy-only authority surface carried inside deliverExplicitMissionInput. */
export interface MissionWorkerInputMaterializationSpec {
  profile?: MissionWorkerInputProfileRequest;
  budget: MissionWorkerInputBudgetRequest;
  context?: MissionWorkerInputContextConstraints;
  capability?: MissionWorkerInputCapabilityConstraints;
  skill?: MissionWorkerInputSkillConstraints;
  workspaceAccess?: MissionWorkspaceAccessPolicy;
  generatedAt?: string;
}

export const MISSION_WORKER_INPUT_MATERIALIZATION_SPEC_KEYS = Object.freeze([
  "profile",
  "budget",
  "context",
  "capability",
  "skill",
  "workspaceAccess",
  "generatedAt",
] as const);

const MAX_SPEC_TREE_DEPTH = 16;
const MAX_SPEC_TREE_NODES = 4_096;

function plainOwnRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain own-data record.`);
  return value as Record<string, unknown>;
}

export function normalizeMissionWorkspaceAccessPolicy(value: unknown, label = "workspaceAccess"): MissionWorkspaceAccessPolicy {
  const row = plainOwnRecord(value, label);
  const keys = Reflect.ownKeys(row);
  if (keys.length !== 1 || keys[0] !== "allowedPathPrefixes") {
    throw new Error(`${label} must contain exactly allowedPathPrefixes.`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(row, "allowedPathPrefixes");
  if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value)
    || descriptor.value.length === 0 || descriptor.value.length > 64) {
    throw new Error(`${label}.allowedPathPrefixes must contain 1-64 paths.`);
  }
  const paths = descriptor.value.map((entry, index) => {
    if (typeof entry !== "string") throw new Error(`${label}.allowedPathPrefixes[${index}] must be a string.`);
    let normalized = entry.trim().replace(/\\/g, "/");
    if (!normalized || normalized.length > 512) throw new Error(`${label}.allowedPathPrefixes[${index}] is invalid.`);
    normalized = normalized.replace(/^\.\//, "").replace(/\/+$/g, "");
    if (!normalized) normalized = ".";
    if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").some(part => part === "..")) {
      throw new Error(`${label}.allowedPathPrefixes[${index}] must stay relative to the workspace.`);
    }
    return normalized;
  });
  return { allowedPathPrefixes: [...new Set(paths)].sort() };
}

function assertOwnDataTree(value: unknown, label: string, depth = 0, state = { nodes: 0 }): void {
  if (value === null || typeof value !== "object") return;
  state.nodes += 1;
  if (depth > MAX_SPEC_TREE_DEPTH || state.nodes > MAX_SPEC_TREE_NODES) {
    throw new Error(`${label} exceeds the bounded own-data tree limit.`);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !("value" in descriptor)) throw new Error(`${label}[${index}] must be a dense own data property.`);
      assertOwnDataTree(descriptor.value, `${label}[${index}]`, depth + 1, state);
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key === "length" || (typeof key === "string" && /^\d+$/.test(key))) continue;
      throw new Error(`${label} has unsupported array field: ${String(key)}`);
    }
    return;
  }
  const row = plainOwnRecord(value, label);
  for (const key of Reflect.ownKeys(row)) {
    if (typeof key !== "string") throw new Error(`${label} contains unsupported symbol field.`);
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label}.${key} must be an own data property.`);
    assertOwnDataTree(descriptor.value, `${label}.${key}`, depth + 1, state);
  }
}

/**
 * Structural admission only. Full profile/budget/context/capability/Skill semantics
 * remain owned by MissionWorkerInputMaterializer.
 */
export function admitMissionWorkerInputMaterializationSpec(
  value: unknown,
  label = "Phase 8 materialization spec",
): MissionWorkerInputMaterializationSpec {
  const row = plainOwnRecord(value, label);
  const allowed = new Set<string>(MISSION_WORKER_INPUT_MATERIALIZATION_SPEC_KEYS);
  for (const key of Reflect.ownKeys(row)) {
    if (typeof key !== "string") throw new Error(`${label} contains unsupported symbol field.`);
    if (!allowed.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label}.${key} must be an own data property.`);
  }
  const budget = Object.getOwnPropertyDescriptor(row, "budget");
  if (!budget) throw new Error(`${label} is missing required field: budget`);
  if (!("value" in budget)) throw new Error(`${label}.budget must be an own data property.`);
  const workspaceAccess = Object.getOwnPropertyDescriptor(row, "workspaceAccess");
  if (workspaceAccess) {
    if (!("value" in workspaceAccess)) throw new Error(`${label}.workspaceAccess must be an own data property.`);
    normalizeMissionWorkspaceAccessPolicy(workspaceAccess.value, `${label}.workspaceAccess`);
  }
  assertOwnDataTree(row, label);
  return row as unknown as MissionWorkerInputMaterializationSpec;
}
