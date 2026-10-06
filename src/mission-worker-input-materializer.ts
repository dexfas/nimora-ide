import { createHash } from "node:crypto";
import {
  MISSION_CONTEXT_SECTIONS,
  type MissionContextMaterializationRequest,
  type MissionContextMaterializationResult,
  type MissionContextProfileConstraints,
  type MissionContextSection,
  type MissionContextMaterializer,
} from "./mission-context-materializer.js";
import {
  type MissionCapabilityMaterializationRequest,
  type MissionCapabilityMaterializationResult,
  type MissionCapabilityMaterializer,
} from "./mission-capability-materializer.js";
import {
  buildExplicitMissionWorkerInput,
  type ExplicitMissionInputInstruction,
} from "./mission-coordinator-worker-input.js";
import {
  MISSION_WORKER_INPUT_MATERIALIZATION_SPEC_KEYS,
  normalizeMissionWorkspaceAccessPolicy,
  type MissionWorkerInputBudgetRequest,
  type MissionWorkerInputCapabilityConstraints,
  type MissionWorkerInputContextConstraints,
  type MissionWorkerInputMaterializationSpec,
  type MissionWorkerInputProfileRequest,
  type MissionWorkerInputSkillConstraints,
  type MissionWorkspaceAccessPolicy,
} from "./mission-worker-input-materialization-contract.js";
import {
  type MissionSkillMaterializationRequest,
  type MissionSkillMaterializationResult,
  type MissionSkillMaterializer,
} from "./mission-skill-materializer.js";
import type { TaskRuntime } from "./task-runtime.js";
import type { WorkerCapabilityExecutionRoute, WorkerInput } from "./worker-contract.js";
import type { WorkerSessionManager } from "./worker-session-manager.js";

export type MissionWorkerInputProfileName = "research-v1" | "practice-v1" | "coordination-v1";
export type {
  MissionWorkerInputBudgetRequest,
  MissionWorkerInputCapabilityConstraints,
  MissionWorkerInputContextConstraints,
  MissionWorkerInputMaterializationSpec,
  MissionWorkerInputProfileRequest,
  MissionWorkerInputSkillConstraints,
} from "./mission-worker-input-materialization-contract.js";

export interface MissionWorkerInputMaterializationRequest extends MissionWorkerInputMaterializationSpec {
  projectId: string;
  rootMissionId: string;
  missionId: string;
  managedSessionId: string;
  coordinationMissionId: string;
  inputId: string;
  instructionKind: string;
  instruction: string;
  referenceIds?: string[];
}

export type MissionWorkerInputMaterializationErrorCode =
  | "invalid-request"
  | "lower-materialization-incompatibility"
  | "composition-mismatch"
  | "combined-budget-incompatibility"
  | "freshness-incompatibility";

export interface MissionWorkerInputCompositionInspector {
  version: 1;
  scope: {
    projectId?: string;
    rootMissionId?: string;
    missionId?: string;
    managedSessionId?: string;
    workerId?: string;
  };
  profile?: {
    requested: MissionWorkerInputProfileRequest;
    resolved: MissionWorkerInputProfileName;
  };
  slices: {
    instruction: { requestedChars: number; usedChars: number };
    context: { requestedChars: number; usedChars: number };
    skills: { requestedChars: number; usedChars: number };
    capabilityProjection: { requestedSchemaChars: number; lowerUsedSchemaChars: number; serializedPayloadChars: number };
    combined: { requestedChars: number; promptChars: number; capabilityPayloadChars: number; compositionOverheadChars: number; usedChars: number };
  };
  capacity:
    | { state: "unspecified"; outputReserveChars: "unspecified" }
    | { state: "specified"; maxInputChars: number; outputReserveChars: number; usableInputChars: number };
  lower: {
    context?: { selectedCount: number; omittedCount: number; exclusionsCount: number };
    capability?: { selectedCount: number; omittedCount: number; executionRouteIds: string[] };
    skill?: { selectedCount: number; omittedCount: number };
  };
  capabilityProjectionDigest?: string;
  incompatibility?: { code: MissionWorkerInputMaterializationErrorCode; reason: string };
  sideEffects: {
    workerSends: 0;
    toolExecutions: 0;
    grantsCreated: 0;
    grantsRevoked: 0;
    approvalMutations: 0;
    workerAssignments: 0;
  };
  durableCompositionRoutingJournalCreated: false;
}

export interface MissionWorkerInputMaterializationResult {
  workerInput: WorkerInput;
  inspector: MissionWorkerInputCompositionInspector;
  context: MissionContextMaterializationResult;
  capability: MissionCapabilityMaterializationResult;
  skill: MissionSkillMaterializationResult;
}

export class MissionWorkerInputMaterializationError extends Error {
  constructor(
    readonly code: MissionWorkerInputMaterializationErrorCode,
    message: string,
    readonly inspector: MissionWorkerInputCompositionInspector,
  ) {
    super(message);
    this.name = "MissionWorkerInputMaterializationError";
  }
}

interface NormalizedRequest {
  projectId: string;
  rootMissionId: string;
  missionId: string;
  managedSessionId: string;
  coordinationMissionId: string;
  inputId: string;
  instructionKind: string;
  instruction: string;
  referenceIds: string[];
  profile: MissionWorkerInputProfileRequest;
  budget: MissionWorkerInputBudgetRequest;
  context: MissionWorkerInputContextConstraints;
  capability: MissionWorkerInputCapabilityConstraints;
  skill: MissionWorkerInputSkillConstraints;
  workspaceAccess?: MissionWorkspaceAccessPolicy;
  generatedAt?: string;
}

const MAX_ID_CHARS = 240;
const MAX_INSTRUCTION_KIND_CHARS = 120;
const MAX_INSTRUCTION_CHARS = 1_000_000;
const MAX_BUDGET_CHARS = 2_000_000;
const MAX_IDS = 128;

function ownRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactOwnDataKeys(row: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(row)) {
    if (typeof key !== "string") throw new Error(`${label} contains unsupported symbol field.`);
    if (!allowedSet.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label}.${key} must be an own data property.`);
  }
}

function ownValue(row: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(`${label} must be at most ${maximum} characters.`);
  return normalized;
}

function boundedInteger(value: unknown, label: string, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > MAX_BUDGET_CHARS) {
    throw new Error(`${label} must be a safe integer between ${minimum} and ${MAX_BUDGET_CHARS}.`);
  }
  return value;
}

function denseIds(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IDS) throw new Error(`${label} must be an array with at most ${MAX_IDS} values.`);
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${label}[${index}] must be explicitly present.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label}[${index}] must be an own data property.`);
    result.push(boundedString(descriptor.value, `${label}[${index}]`, MAX_ID_CHARS));
  }
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates.`);
  return result;
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function normalizeProfile(value: unknown): MissionWorkerInputProfileRequest {
  if (value === undefined || value === "auto") return "auto";
  if (value === "research" || value === "practice" || value === "coordination") return value;
  throw new Error(`Mission Worker-input profile is unsupported: ${String(value)}`);
}

function normalizeGeneratedAt(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const text = boundedString(value, "generatedAt", 80);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(text) || !Number.isFinite(Date.parse(text))) {
    throw new Error("generatedAt must be an ISO-8601 timestamp with timezone.");
  }
  return text;
}

function normalizeBudget(value: unknown): MissionWorkerInputBudgetRequest {
  const row = ownRecord(value, "Mission Worker-input budget");
  exactOwnDataKeys(row, ["maxInstructionChars", "maxContextChars", "maxSkillChars", "maxSchemaChars", "maxCombinedChars", "capacity"], "Mission Worker-input budget");
  const budget: MissionWorkerInputBudgetRequest = {
    maxInstructionChars: boundedInteger(ownValue(row, "maxInstructionChars"), "maxInstructionChars"),
    maxContextChars: boundedInteger(ownValue(row, "maxContextChars"), "maxContextChars"),
    maxSkillChars: boundedInteger(ownValue(row, "maxSkillChars"), "maxSkillChars"),
    maxSchemaChars: boundedInteger(ownValue(row, "maxSchemaChars"), "maxSchemaChars"),
    maxCombinedChars: boundedInteger(ownValue(row, "maxCombinedChars"), "maxCombinedChars"),
  };
  const rawCapacity = ownValue(row, "capacity");
  if (rawCapacity !== undefined) {
    const capacityRow = ownRecord(rawCapacity, "Mission Worker-input capacity");
    exactOwnDataKeys(capacityRow, ["maxInputChars", "outputReserveChars"], "Mission Worker-input capacity");
    const maxInputChars = boundedInteger(ownValue(capacityRow, "maxInputChars"), "capacity.maxInputChars");
    const outputReserveChars = boundedInteger(ownValue(capacityRow, "outputReserveChars"), "capacity.outputReserveChars", 0);
    if (outputReserveChars > maxInputChars) throw new Error("capacity.outputReserveChars must not exceed capacity.maxInputChars.");
    budget.capacity = { maxInputChars, outputReserveChars };
  }
  return budget;
}

function normalizeSectionChars(value: unknown): Partial<Record<MissionContextSection, number>> | undefined {
  if (value === undefined) return undefined;
  const row = ownRecord(value, "Mission Worker-input context.sectionChars");
  exactOwnDataKeys(row, MISSION_CONTEXT_SECTIONS, "Mission Worker-input context.sectionChars");
  const result: Partial<Record<MissionContextSection, number>> = {};
  for (const section of MISSION_CONTEXT_SECTIONS) {
    const raw = ownValue(row, section);
    if (raw !== undefined) result[section] = boundedInteger(raw, `context.sectionChars.${section}`, 0);
  }
  return result;
}

function normalizeContext(value: unknown): MissionWorkerInputContextConstraints {
  if (value === undefined) return {};
  const row = ownRecord(value, "Mission Worker-input context constraints");
  exactOwnDataKeys(row, ["includeDraftProposals", "includeRelatedResearch", "requiredItemIds", "sectionChars"], "Mission Worker-input context constraints");
  const sectionChars = normalizeSectionChars(ownValue(row, "sectionChars"));
  const includeDraftProposals = optionalBoolean(ownValue(row, "includeDraftProposals"), "context.includeDraftProposals");
  const includeRelatedResearch = optionalBoolean(ownValue(row, "includeRelatedResearch"), "context.includeRelatedResearch");
  const requiredItemIds = denseIds(ownValue(row, "requiredItemIds"), "context.requiredItemIds");
  return {
    ...(includeDraftProposals === undefined ? {} : { includeDraftProposals }),
    ...(includeRelatedResearch === undefined ? {} : { includeRelatedResearch }),
    ...(requiredItemIds.length ? { requiredItemIds } : {}),
    ...(sectionChars === undefined ? {} : { sectionChars }),
  };
}

function normalizeCapability(value: unknown): MissionWorkerInputCapabilityConstraints {
  if (value === undefined) return {};
  const row = ownRecord(value, "Mission Worker-input capability constraints");
  exactOwnDataKeys(row, ["requiredCapabilityIds", "optionalCapabilityIds", "allowedCapabilityIds"], "Mission Worker-input capability constraints");
  const requiredCapabilityIds = denseIds(ownValue(row, "requiredCapabilityIds"), "capability.requiredCapabilityIds");
  const optionalCapabilityIds = denseIds(ownValue(row, "optionalCapabilityIds"), "capability.optionalCapabilityIds");
  const rawAllowed = ownValue(row, "allowedCapabilityIds");
  const allowedCapabilityIds = denseIds(rawAllowed, "capability.allowedCapabilityIds");
  return {
    ...(requiredCapabilityIds.length ? { requiredCapabilityIds } : {}),
    ...(optionalCapabilityIds.length ? { optionalCapabilityIds } : {}),
    ...(rawAllowed === undefined ? {} : { allowedCapabilityIds }),
  };
}

function normalizeSkill(value: unknown): MissionWorkerInputSkillConstraints {
  if (value === undefined) return {};
  const row = ownRecord(value, "Mission Worker-input Skill constraints");
  exactOwnDataKeys(row, ["requiredSkillIds", "optionalSkillIds", "trustedSourceIds", "trustedSkillIds", "relevanceTags", "sessionType"], "Mission Worker-input Skill constraints");
  const requiredSkillIds = denseIds(ownValue(row, "requiredSkillIds"), "skill.requiredSkillIds");
  const optionalSkillIds = denseIds(ownValue(row, "optionalSkillIds"), "skill.optionalSkillIds");
  const trustedSourceIds = denseIds(ownValue(row, "trustedSourceIds"), "skill.trustedSourceIds");
  const trustedSkillIds = denseIds(ownValue(row, "trustedSkillIds"), "skill.trustedSkillIds");
  const relevanceTags = denseIds(ownValue(row, "relevanceTags"), "skill.relevanceTags");
  const rawSessionType = ownValue(row, "sessionType");
  const sessionType = rawSessionType === undefined ? undefined : boundedString(rawSessionType, "skill.sessionType", MAX_ID_CHARS);
  return {
    ...(requiredSkillIds.length ? { requiredSkillIds } : {}),
    ...(optionalSkillIds.length ? { optionalSkillIds } : {}),
    ...(trustedSourceIds.length ? { trustedSourceIds } : {}),
    ...(trustedSkillIds.length ? { trustedSkillIds } : {}),
    ...(relevanceTags.length ? { relevanceTags } : {}),
    ...(sessionType === undefined ? {} : { sessionType }),
  };
}

function normalizeRequest(input: unknown): NormalizedRequest {
  const row = ownRecord(input, "Mission Worker-input materialization request");
  exactOwnDataKeys(row, [
    "projectId", "rootMissionId", "missionId", "managedSessionId", "coordinationMissionId", "inputId",
    "instructionKind", "instruction", "referenceIds", ...MISSION_WORKER_INPUT_MATERIALIZATION_SPEC_KEYS,
  ], "Mission Worker-input materialization request");
  return {
    projectId: boundedString(ownValue(row, "projectId"), "projectId", MAX_ID_CHARS),
    rootMissionId: boundedString(ownValue(row, "rootMissionId"), "rootMissionId", MAX_ID_CHARS),
    missionId: boundedString(ownValue(row, "missionId"), "missionId", MAX_ID_CHARS),
    managedSessionId: boundedString(ownValue(row, "managedSessionId"), "managedSessionId", MAX_ID_CHARS),
    coordinationMissionId: boundedString(ownValue(row, "coordinationMissionId"), "coordinationMissionId", MAX_ID_CHARS),
    inputId: boundedString(ownValue(row, "inputId"), "inputId", MAX_ID_CHARS),
    instructionKind: boundedString(ownValue(row, "instructionKind"), "instructionKind", MAX_INSTRUCTION_KIND_CHARS),
    instruction: boundedString(ownValue(row, "instruction"), "instruction", MAX_INSTRUCTION_CHARS),
    referenceIds: denseIds(ownValue(row, "referenceIds"), "referenceIds"),
    profile: normalizeProfile(ownValue(row, "profile")),
    budget: normalizeBudget(ownValue(row, "budget")),
    context: normalizeContext(ownValue(row, "context")),
    capability: normalizeCapability(ownValue(row, "capability")),
    skill: normalizeSkill(ownValue(row, "skill")),
    workspaceAccess: ownValue(row, "workspaceAccess") === undefined
      ? undefined
      : normalizeMissionWorkspaceAccessPolicy(ownValue(row, "workspaceAccess"), "workspaceAccess"),
    generatedAt: normalizeGeneratedAt(ownValue(row, "generatedAt")),
  };
}

/** Validate policy/shape before an application performs irreversible ownership changes. */
export function validateMissionWorkerInputMaterializationRequest(input: MissionWorkerInputMaterializationRequest): void {
  normalizeRequest(input);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`;
}

function projectionDigest(capability: MissionCapabilityMaterializationResult): string {
  const serialized = stableJson({
    workerId: capability.workerId,
    profile: capability.profile,
    allowedCapabilities: capability.allowedCapabilities,
    externalCapabilities: capability.externalCapabilities,
    mappings: capability.inspector.mappings.map(mapping => ({
      capabilityId: mapping.capabilityId,
      toolName: mapping.toolName,
      schemaSourceId: mapping.schemaSourceId,
      schemaIdentity: mapping.schemaIdentity,
      projectionMode: mapping.projectionMode,
      executionRouteId: mapping.executionRouteId,
    })),
  });
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

function baseInspector(input?: unknown): MissionWorkerInputCompositionInspector {
  let row: Record<string, unknown> = {};
  try { row = ownRecord(input, "Mission Worker-input materialization request"); } catch { /* bounded preview only */ }
  const preview = (key: string) => {
    const value = ownValue(row, key);
    return typeof value === "string" && value.length <= MAX_ID_CHARS ? value : undefined;
  };
  return {
    version: 1,
    scope: {
      ...(preview("projectId") ? { projectId: preview("projectId") } : {}),
      ...(preview("rootMissionId") ? { rootMissionId: preview("rootMissionId") } : {}),
      ...(preview("missionId") ? { missionId: preview("missionId") } : {}),
      ...(preview("managedSessionId") ? { managedSessionId: preview("managedSessionId") } : {}),
    },
    slices: {
      instruction: { requestedChars: 0, usedChars: 0 },
      context: { requestedChars: 0, usedChars: 0 },
      skills: { requestedChars: 0, usedChars: 0 },
      capabilityProjection: { requestedSchemaChars: 0, lowerUsedSchemaChars: 0, serializedPayloadChars: 0 },
      combined: { requestedChars: 0, promptChars: 0, capabilityPayloadChars: 0, compositionOverheadChars: 0, usedChars: 0 },
    },
    capacity: { state: "unspecified", outputReserveChars: "unspecified" },
    lower: {},
    sideEffects: { workerSends: 0, toolExecutions: 0, grantsCreated: 0, grantsRevoked: 0, approvalMutations: 0, workerAssignments: 0 },
    durableCompositionRoutingJournalCreated: false,
  };
}

function lowerProfile(profile: MissionWorkerInputProfileRequest): "auto" | "research" | "practice" | "coordination" {
  return profile;
}

function exactRouteMatches(route: WorkerCapabilityExecutionRoute, mapping: MissionCapabilityMaterializationResult["inspector"]["mappings"][number]): boolean {
  return route.routeId === mapping.executionRouteId
    && route.projectionMode === mapping.projectionMode
    && route.schemaSourceId === mapping.schemaSourceId
    && route.toolNames.includes(mapping.toolName);
}

/**
 * Phase 8 WO#4 read/derive composer. It selects no Worker and performs no send,
 * execution, grant/approval mutation, retry, transcript persistence or routing
 * journaling. The exact WorkerSession must already exist.
 */
export class MissionWorkerInputMaterializer {
  constructor(
    private readonly contextMaterializer: MissionContextMaterializer,
    private readonly capabilityMaterializer: MissionCapabilityMaterializer,
    private readonly skillMaterializer: MissionSkillMaterializer,
    private readonly tasks: TaskRuntime,
    private readonly workers: WorkerSessionManager,
  ) {}

  async materialize(input: MissionWorkerInputMaterializationRequest): Promise<MissionWorkerInputMaterializationResult> {
    let request: NormalizedRequest;
    try {
      request = normalizeRequest(input);
    } catch (error) {
      this.fail("invalid-request", error instanceof Error ? error.message : String(error), baseInspector(input));
    }
    const inspector = baseInspector(request);
    inspector.scope = {
      projectId: request.projectId,
      rootMissionId: request.rootMissionId,
      missionId: request.missionId,
      managedSessionId: request.managedSessionId,
    };
    inspector.slices.instruction.requestedChars = request.budget.maxInstructionChars;
    inspector.slices.context.requestedChars = request.budget.maxContextChars;
    inspector.slices.skills.requestedChars = request.budget.maxSkillChars;
    inspector.slices.capabilityProjection.requestedSchemaChars = request.budget.maxSchemaChars;
    inspector.slices.combined.requestedChars = request.budget.maxCombinedChars;
    inspector.capacity = request.budget.capacity
      ? {
        state: "specified",
        maxInputChars: request.budget.capacity.maxInputChars,
        outputReserveChars: request.budget.capacity.outputReserveChars,
        usableInputChars: request.budget.capacity.maxInputChars - request.budget.capacity.outputReserveChars,
      }
      : { state: "unspecified", outputReserveChars: "unspecified" };

    const profile = lowerProfile(request.profile);
    const common = {
      projectId: request.projectId,
      rootMissionId: request.rootMissionId,
      missionId: request.missionId,
      managedSessionId: request.managedSessionId,
      ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
    };
    const contextConstraints: MissionContextProfileConstraints = {
      profile,
      ...request.context,
    };
    const contextRequest: MissionContextMaterializationRequest = {
      ...common,
      budget: {
        maxChars: request.budget.maxContextChars,
        ...(request.context.sectionChars === undefined ? {} : { sectionChars: request.context.sectionChars }),
      },
      constraints: contextConstraints,
    };
    const capabilityRequest: MissionCapabilityMaterializationRequest = {
      ...common,
      budget: { maxSchemaChars: request.budget.maxSchemaChars },
      constraints: { profile, ...request.capability },
    };
    const skillRequest: MissionSkillMaterializationRequest = {
      ...common,
      budget: { maxSkillChars: request.budget.maxSkillChars },
      constraints: { profile, ...request.skill },
    };

    let context: MissionContextMaterializationResult;
    let capability: MissionCapabilityMaterializationResult;
    let skill: MissionSkillMaterializationResult;
    try {
      context = await this.contextMaterializer.materialize(contextRequest);
      capability = await this.capabilityMaterializer.materialize(capabilityRequest);
      skill = await this.skillMaterializer.materialize(skillRequest, capability);
    } catch (error) {
      this.fail("lower-materialization-incompatibility", error instanceof Error ? error.message : String(error), inspector);
    }

    const contextScope = context.inspector.scope;
    const expected = [request.projectId, request.rootMissionId, request.missionId, request.managedSessionId];
    const lowerScopes = [
      [contextScope.projectId, contextScope.rootMissionId, contextScope.missionId, contextScope.managedSessionId],
      [capability.projectId, capability.rootMissionId, capability.missionId, capability.managedSessionId],
      [skill.projectId, skill.rootMissionId, skill.missionId, skill.managedSessionId],
    ];
    if (lowerScopes.some(scope => scope.some((value, index) => value !== expected[index]))) {
      this.fail("composition-mismatch", "Context/Capability/Skill materialization scopes do not agree with the exact composition scope.", inspector);
    }
    const workerIds = [context.package.workerId, capability.workerId, skill.workerId];
    if (new Set(workerIds).size !== 1) this.fail("composition-mismatch", "Context/Capability/Skill materialization Worker identities disagree.", inspector);
    const profiles = [context.package.profile, capability.profile, skill.profile];
    if (new Set(profiles).size !== 1) this.fail("composition-mismatch", "Context/Capability/Skill resolved profiles disagree.", inspector);
    inspector.scope.workerId = workerIds[0];
    inspector.profile = { requested: request.profile, resolved: profiles[0] as MissionWorkerInputProfileName };

    const targetMission = this.tasks.getTask(request.missionId);
    const session = this.workers.getSession(request.managedSessionId);
    if (!targetMission?.mission || !session) this.fail("composition-mismatch", "Exact target Mission/WorkerSession disappeared after lower materialization.", inspector);
    const instruction: ExplicitMissionInputInstruction = {
      projectId: request.projectId,
      managedRootMissionId: request.rootMissionId,
      coordinationMissionId: request.coordinationMissionId,
      targetMissionId: request.missionId,
      instructionKind: request.instructionKind,
      instruction: request.instruction,
      referenceIds: request.referenceIds,
    };
    let instructionInput: WorkerInput;
    try {
      instructionInput = buildExplicitMissionWorkerInput({
        instruction,
        targetMission,
        session,
        inputId: request.inputId,
        maxPromptChars: request.budget.maxInstructionChars,
      });
    } catch (error) {
      this.fail("combined-budget-incompatibility", error instanceof Error ? error.message : String(error), inspector);
    }

    const contextText = context.text.trimEnd();
    const skillText = skill.text.trimEnd();
    const promptParts = [instructionInput.prompt.trimEnd()];
    if (contextText) promptParts.push("\n\n## Owner-backed Mission Context\n", contextText);
    if (skillText) promptParts.push("\n\n## Selected Skill Guidance — Subordinate Workflow Knowledge\n", skillText);
    if (request.workspaceAccess) {
      promptParts.push("\n\n## Enforced Workspace Access Boundary\n",
        `This Worker input may access only these workspace-relative literal path prefixes: ${JSON.stringify(request.workspaceAccess.allowedPathPrefixes)}. The host enforces this boundary independently of your response.\n`);
    }
    promptParts.push("\n");
    const prompt = promptParts.join("");
    const capabilityPayload = stableJson({
      allowedCapabilities: capability.allowedCapabilities,
      externalCapabilities: capability.externalCapabilities,
    });
    const usedChars = prompt.length + capabilityPayload.length;
    const componentChars = instructionInput.prompt.length + context.text.length + skill.text.length;

    inspector.slices.instruction.usedChars = instructionInput.prompt.length;
    inspector.slices.context.usedChars = context.text.length;
    inspector.slices.skills.usedChars = skill.text.length;
    inspector.slices.capabilityProjection.lowerUsedSchemaChars = capability.inspector.budget.usedSchemaChars;
    inspector.slices.capabilityProjection.serializedPayloadChars = capabilityPayload.length;
    inspector.slices.combined.promptChars = prompt.length;
    inspector.slices.combined.capabilityPayloadChars = capabilityPayload.length;
    inspector.slices.combined.compositionOverheadChars = Math.max(0, prompt.length - componentChars);
    inspector.slices.combined.usedChars = usedChars;
    inspector.lower = {
      context: { selectedCount: context.inspector.selected.count, omittedCount: context.inspector.omitted.count, exclusionsCount: context.inspector.exclusions.count },
      capability: {
        selectedCount: capability.inspector.budget.selectedCount,
        omittedCount: capability.inspector.budget.omittedCount,
        executionRouteIds: [...new Set(capability.inspector.mappings.map(mapping => mapping.executionRouteId))].sort(),
      },
      skill: { selectedCount: skill.inspector.budget.selectedCount, omittedCount: skill.inspector.budget.omittedCount },
    };
    inspector.capabilityProjectionDigest = projectionDigest(capability);

    if (usedChars > request.budget.maxCombinedChars) {
      this.fail("combined-budget-incompatibility", `Combined Worker input exceeds maxCombinedChars (${usedChars} > ${request.budget.maxCombinedChars}).`, inspector);
    }
    if (request.budget.capacity) {
      const usable = request.budget.capacity.maxInputChars - request.budget.capacity.outputReserveChars;
      if (usedChars > usable) {
        this.fail("combined-budget-incompatibility", `Combined Worker input exceeds explicit neutral capacity after output reserve (${usedChars} > ${usable}).`, inspector);
      }
    }

    return {
      workerInput: {
        inputId: instructionInput.inputId,
        prompt,
        allowedCapabilities: structuredClone(capability.allowedCapabilities),
        externalCapabilities: structuredClone(capability.externalCapabilities),
      },
      inspector,
      context,
      capability,
      skill,
    };
  }

  /** Fresh exact-session/Worker-route check to run immediately before target send. */
  async assertFreshForSend(result: MissionWorkerInputMaterializationResult, input: MissionWorkerInputMaterializationRequest): Promise<void> {
    let request: NormalizedRequest;
    try {
      request = normalizeRequest(input);
    } catch (error) {
      this.fail("freshness-incompatibility", error instanceof Error ? error.message : String(error), result.inspector);
    }
    const expectedWorkerId = result.inspector.scope.workerId;
    if (!expectedWorkerId
      || result.inspector.scope.projectId !== request.projectId
      || result.inspector.scope.rootMissionId !== request.rootMissionId
      || result.inspector.scope.missionId !== request.missionId
      || result.inspector.scope.managedSessionId !== request.managedSessionId) {
      this.fail("freshness-incompatibility", "Materialized Worker input does not match the exact current composition request scope.", result.inspector);
    }
    await this.tasks.initialize();
    this.assertExactBinding(request, expectedWorkerId, result.inspector);
    let descriptor;
    try {
      descriptor = await this.workers.refresh(expectedWorkerId);
    } catch (error) {
      this.fail("freshness-incompatibility", `Exact Worker definition refresh failed: ${error instanceof Error ? error.message : String(error)}`, result.inspector);
    }
    for (const mapping of result.capability.inspector.mappings) {
      const projection = descriptor.capabilityProjection;
      if (!projection
        || (mapping.projectionMode === "native-by-name" && !projection.nativeByName)
        || (mapping.projectionMode === "external-schema" && !projection.externalDefinitions)
        || !(projection.executionRoutes ?? []).some(route => exactRouteMatches(route, mapping))) {
        this.fail("freshness-incompatibility", `Exact Worker capability route drifted before send for ${mapping.capabilityId}/${mapping.toolName}.`, result.inspector);
      }
    }
    const capabilityRequest: MissionCapabilityMaterializationRequest = {
      projectId: request.projectId,
      rootMissionId: request.rootMissionId,
      missionId: request.missionId,
      managedSessionId: request.managedSessionId,
      budget: { maxSchemaChars: request.budget.maxSchemaChars },
      constraints: { profile: request.profile, ...request.capability },
      ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }),
    };
    let freshCapability: MissionCapabilityMaterializationResult;
    try {
      freshCapability = await this.capabilityMaterializer.materialize(capabilityRequest);
    } catch (error) {
      this.fail("freshness-incompatibility", `Fresh capability rematerialization failed before send: ${error instanceof Error ? error.message : String(error)}`, result.inspector);
    }
    if (projectionDigest(freshCapability) !== result.inspector.capabilityProjectionDigest) {
      this.fail("freshness-incompatibility", "Capability/schema projection changed between materialization and send.", result.inspector);
    }
    const freshSkill = await this.skillMaterializer.materialize({ projectId: request.projectId, rootMissionId: request.rootMissionId,
      missionId: request.missionId, managedSessionId: request.managedSessionId, budget: { maxSkillChars: request.budget.maxSkillChars },
      constraints: { profile: lowerProfile(request.profile), ...request.skill },
      ...(request.generatedAt === undefined ? {} : { generatedAt: request.generatedAt }) }, freshCapability);
    if (freshSkill.text !== result.skill.text) this.fail("freshness-incompatibility", "Skill content, provenance or host trust changed before send.", result.inspector);
    this.assertExactBinding(request, expectedWorkerId, result.inspector);
  }

  private assertExactBinding(request: NormalizedRequest, workerId: string, inspector: MissionWorkerInputCompositionInspector): void {
    const task = this.tasks.getTask(request.missionId);
    if (!task?.mission
      || task.mission.projectId !== request.projectId
      || task.mission.rootMissionId !== request.rootMissionId
      || task.missionFinalization) {
      this.fail("freshness-incompatibility", "Exact Mission scope is no longer active before send.", inspector);
    }
    const session = this.workers.getSession(request.managedSessionId);
    if (!session || session.taskId !== request.missionId || session.workerId !== workerId || session.state === "disposed") {
      this.fail("freshness-incompatibility", "Exact managed WorkerSession is no longer active/bound to the materialized Worker before send.", inspector);
    }
    const durable = task.workerSessions[request.managedSessionId];
    if (!durable
      || durable.workerId !== session.workerId
      || durable.adapterSessionId !== session.adapterSessionId
      || durable.detachedAt
      || durable.retiredAt) {
      this.fail("freshness-incompatibility", "TaskRuntime no longer records the materialized managed WorkerSession as the exact authoritative active binding.", inspector);
    }
  }

  private fail(code: MissionWorkerInputMaterializationErrorCode, message: string, inspector: MissionWorkerInputCompositionInspector): never {
    inspector.incompatibility = { code, reason: message.slice(0, 1_000) };
    throw new MissionWorkerInputMaterializationError(code, inspector.incompatibility.reason, inspector);
  }
}
