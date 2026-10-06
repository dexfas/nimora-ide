import { renderStructuredContextHandoff } from "./context-handoff.js";
import type { MissionExchange, MissionGraphRelation } from "./mission-collaboration-contract.js";
import type { MissionCollaborationStore } from "./mission-collaboration-store.js";
import type { ProjectDecisionChange, ProjectProposal, ProjectSnapshot } from "./project-contract.js";
import type { ProjectStore } from "./project-store.js";
import type {
  TaskArtifactRef,
  TaskExecution,
  TaskMissionMetadata,
  TaskSnapshot,
  TaskWorkerSessionRef,
} from "./task-contract.js";
import type { TaskRuntime } from "./task-runtime.js";
import type { WorkerCapabilities, WorkerDescriptor } from "./worker-contract.js";
import type { ManagedWorkerSession, WorkerSessionManager } from "./worker-session-manager.js";

export const MISSION_CONTEXT_SECTIONS = [
  "instructions",
  "decisions/current-truth",
  "evidence",
  "artifacts",
  "history/handoff",
  "skills",
  "tool-schemas",
] as const;

export type MissionContextSection = typeof MISSION_CONTEXT_SECTIONS[number];
export type MissionContextProfileName = "research-v1" | "practice-v1" | "coordination-v1";
export type MissionContextAuthority = "authoritative" | "durable-fact" | "historical" | "non-authoritative-research";
export type MissionContextOwner = "ProjectStore" | "TaskRuntime" | "MissionCollaborationStore";

export interface MissionContextBudgetRequest {
  maxChars: number;
  sectionChars?: Partial<Record<MissionContextSection, number>>;
  outputReserveChars?: number;
}

export interface MissionContextProfileConstraints {
  profile?: "auto" | "research" | "practice" | "coordination";
  includeDraftProposals?: boolean;
  includeRelatedResearch?: boolean;
  requiredItemIds?: string[];
}

export interface MissionContextMaterializationRequest {
  projectId: string;
  rootMissionId: string;
  missionId: string;
  managedSessionId: string;
  budget: MissionContextBudgetRequest;
  constraints?: MissionContextProfileConstraints;
  generatedAt?: string;
}

export interface MissionContextProvenance {
  owner: MissionContextOwner;
  type: string;
  id: string;
  reason: string;
}

export interface MissionContextItem {
  itemId: string;
  section: MissionContextSection;
  tier: 0 | 1 | 2 | 3 | 4;
  priority: number;
  required: boolean;
  authority: MissionContextAuthority;
  provenance: MissionContextProvenance;
  content: unknown;
}

export interface MissionContextExclusion {
  itemId: string;
  owner: MissionContextOwner;
  reason: string;
  authorityBasis: string;
}

export interface MissionContextOmission {
  itemId: string;
  section: MissionContextSection;
  reason: "profile-excluded" | "section-budget" | "total-budget";
  estimatedChars: number;
}

export interface MissionContextSectionInspection {
  requestedChars: number;
  usedChars: number;
  selectedCount: number;
  omittedCount: number;
  budgetSource: "profile" | "explicit" | "unimplemented";
  borrowedChars: number;
}

export interface MissionContextInspector {
  version: 1;
  scope: {
    projectId: string;
    rootMissionId: string;
    missionId: string;
    managedSessionId: string;
    workerId?: string;
  };
  profile?: {
    name: MissionContextProfileName;
    version: 1;
    inputs: {
      missionPlane: TaskMissionMetadata["plane"];
      missionType: string;
      workerKind: WorkerDescriptor["kind"];
      workerAvailability: WorkerDescriptor["availability"];
      workerCapabilities: WorkerCapabilities;
      explicitProfile: MissionContextProfileConstraints["profile"];
      includeDraftProposals: boolean;
      includeRelatedResearch: boolean;
    };
  };
  budget: {
    totalRequestedChars: number;
    outputReserveChars: number | "unspecified";
    sections: Record<MissionContextSection, MissionContextSectionInspection>;
  };
  selected: { count: number; itemIds: string[] };
  omitted: { count: number; items: MissionContextOmission[] };
  exclusions: { count: number; items: MissionContextExclusion[] };
  ambiguities: Array<{ kind: "committed-decision-peer-authority"; decisionIds: string[]; reason: string }>;
  compression: {
    strategy: "deterministic-item-selection";
    truncated: boolean;
    reason?: string;
  };
  incompatibility?: {
    code: MissionContextMaterializationErrorCode;
    itemId?: string;
    section?: MissionContextSection;
    reason: string;
  };
  finalRenderedLength: number;
  providerSpecificFieldsRejected: string[];
  durableRoutingJournalCreated: false;
}

export interface MissionContextMaterializationPackage {
  version: 1;
  generatedAt: string;
  projectId: string;
  rootMissionId: string;
  missionId: string;
  managedSessionId: string;
  workerId: string;
  profile: MissionContextProfileName;
  items: MissionContextItem[];
}

export interface MissionContextMaterializationResult {
  package: MissionContextMaterializationPackage;
  text: string;
  inspector: MissionContextInspector;
}

export type MissionContextMaterializationErrorCode =
  | "invalid-request"
  | "scope-mismatch"
  | "session-mismatch"
  | "worker-incompatibility"
  | "terminal-mission"
  | "finalizing-mission"
  | "budget-incompatibility";

export class MissionContextMaterializationError extends Error {
  constructor(
    readonly code: MissionContextMaterializationErrorCode,
    message: string,
    readonly inspector: MissionContextInspector,
  ) {
    super(message);
    this.name = "MissionContextMaterializationError";
  }
}

interface NormalizedBudget {
  maxChars: number;
  sectionChars: Partial<Record<MissionContextSection, number>>;
  outputReserveChars: number | "unspecified";
}

interface NormalizedMaterializationRequest {
  projectId: string;
  rootMissionId: string;
  missionId: string;
  managedSessionId: string;
  budget: NormalizedBudget;
  constraints?: MissionContextProfileConstraints;
  generatedAt?: string;
}

interface ResolvedProfile {
  name: MissionContextProfileName;
  includeDraftProposals: boolean;
  includeRelatedResearch: boolean;
  envelopeRatios: Record<Exclude<MissionContextSection, "skills" | "tool-schemas">, number>;
}

const MAX_INSPECTED_ITEM_IDS = 128;
const MAX_CONTEXT_BUDGET_CHARS = 1_000_000;
const MAX_REQUIRED_ITEM_IDS = 128;
const PROVIDER_SPECIFIC_FIELDS_REJECTED = Object.freeze([
  "raw-provider-transcript",
  "raw-reasoning",
  "adapterSessionId",
  "provider-native-conversation-id",
  "page-id",
  "page-session-token",
  "DOM-state",
  "hidden-provider-memory",
]);

const SECTION_ORDER = new Map<MissionContextSection, number>(MISSION_CONTEXT_SECTIONS.map((section, index) => [section, index]));

function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`;
}

function boundedIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  const normalized = value.trim();
  if (normalized.length > 240) throw new Error(`${label} must be at most 240 characters.`);
  return normalized;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, allowed: readonly string[], label: string): void {
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

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function boundedBudgetInteger(value: unknown, label: string): number {
  const normalized = nonNegativeInteger(value, label);
  if (normalized > MAX_CONTEXT_BUDGET_CHARS) throw new Error(`${label} must be at most ${MAX_CONTEXT_BUDGET_CHARS}.`);
  return normalized;
}

function normalizeBudget(input: unknown): NormalizedBudget {
  const row = objectValue(input, "Mission context budget");
  exactKeys(row, ["maxChars", "sectionChars", "outputReserveChars"], "Mission context budget");
  const maxChars = boundedBudgetInteger(ownValue(row, "maxChars"), "Mission context maxChars");
  if (maxChars < 1) throw new Error("Mission context maxChars must be at least 1.");
  const sectionChars: Partial<Record<MissionContextSection, number>> = {};
  const rawSectionChars = ownValue(row, "sectionChars");
  if (rawSectionChars !== undefined) {
    const sectionRow = objectValue(rawSectionChars, "Mission context sectionChars");
    exactKeys(sectionRow, MISSION_CONTEXT_SECTIONS, "Mission context sectionChars");
    for (const section of MISSION_CONTEXT_SECTIONS) {
      const value = ownValue(sectionRow, section);
      if (value === undefined) continue;
      const normalized = boundedBudgetInteger(value, `Mission context ${section} section budget`);
      if (normalized > maxChars) throw new Error(`Mission context ${section} section budget must not exceed maxChars.`);
      sectionChars[section] = normalized;
    }
  }
  const rawOutputReserveChars = ownValue(row, "outputReserveChars");
  const outputReserveChars = rawOutputReserveChars === undefined
    ? "unspecified"
    : boundedBudgetInteger(rawOutputReserveChars, "Mission context output reserve");
  if (typeof outputReserveChars === "number" && outputReserveChars > maxChars) throw new Error("Mission context output reserve must not exceed maxChars.");
  return {
    maxChars,
    sectionChars,
    outputReserveChars,
  };
}

function normalizeConstraints(value: unknown): MissionContextProfileConstraints | undefined {
  if (value === undefined) return undefined;
  const row = objectValue(value, "Mission context constraints");
  exactKeys(row, ["profile", "includeDraftProposals", "includeRelatedResearch", "requiredItemIds"], "Mission context constraints");
  const rawProfile = ownValue(row, "profile");
  const rawIncludeDraftProposals = ownValue(row, "includeDraftProposals");
  const rawIncludeRelatedResearch = ownValue(row, "includeRelatedResearch");
  const rawRequiredItemIds = ownValue(row, "requiredItemIds");
  let profile: MissionContextProfileConstraints["profile"];
  if (rawProfile !== undefined) {
    if (rawProfile !== "auto" && rawProfile !== "research" && rawProfile !== "practice" && rawProfile !== "coordination") {
      throw new Error(`Unsupported Mission context profile: ${String(rawProfile)}`);
    }
    profile = rawProfile;
  }
  if (rawIncludeDraftProposals !== undefined && typeof rawIncludeDraftProposals !== "boolean") throw new Error("Mission context includeDraftProposals must be a boolean.");
  if (rawIncludeRelatedResearch !== undefined && typeof rawIncludeRelatedResearch !== "boolean") throw new Error("Mission context includeRelatedResearch must be a boolean.");
  let requiredItemIds: string[] | undefined;
  if (rawRequiredItemIds !== undefined) {
    if (!Array.isArray(rawRequiredItemIds)) throw new Error("Mission context requiredItemIds must be an array.");
    if (rawRequiredItemIds.length > MAX_REQUIRED_ITEM_IDS) throw new Error(`Mission context requiredItemIds must contain at most ${MAX_REQUIRED_ITEM_IDS} ids.`);
    requiredItemIds = [];
    for (let index = 0; index < rawRequiredItemIds.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(rawRequiredItemIds, index)) {
        throw new Error(`Required context item id ${index + 1} must be explicitly present in a dense array.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(rawRequiredItemIds, String(index));
      if (!descriptor || !("value" in descriptor)) throw new Error(`Required context item id ${index + 1} must be an own data property.`);
      requiredItemIds.push(boundedIdentity(descriptor.value, `Required context item id ${index + 1}`));
    }
    if (new Set(requiredItemIds).size !== requiredItemIds.length) throw new Error("Mission context requiredItemIds must not contain duplicates.");
  }
  return {
    ...(profile === undefined ? {} : { profile }),
    ...(rawIncludeDraftProposals === undefined ? {} : { includeDraftProposals: rawIncludeDraftProposals }),
    ...(rawIncludeRelatedResearch === undefined ? {} : { includeRelatedResearch: rawIncludeRelatedResearch }),
    ...(requiredItemIds === undefined ? {} : { requiredItemIds }),
  };
}

function normalizeGeneratedAt(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error("Mission context generatedAt must be an ISO timestamp.");
  }
  return new Date(value).toISOString();
}

function normalizeMaterializationRequest(value: unknown): NormalizedMaterializationRequest {
  const row = objectValue(value, "Mission context materialization request");
  exactKeys(row, ["projectId", "rootMissionId", "missionId", "managedSessionId", "budget", "constraints", "generatedAt"], "Mission context materialization request");
  return {
    projectId: boundedIdentity(ownValue(row, "projectId"), "Project id"),
    rootMissionId: boundedIdentity(ownValue(row, "rootMissionId"), "Root Mission id"),
    missionId: boundedIdentity(ownValue(row, "missionId"), "Mission id"),
    managedSessionId: boundedIdentity(ownValue(row, "managedSessionId"), "Managed WorkerSession id"),
    budget: normalizeBudget(ownValue(row, "budget")),
    constraints: normalizeConstraints(ownValue(row, "constraints")),
    generatedAt: normalizeGeneratedAt(ownValue(row, "generatedAt")),
  };
}

function previewIdentity(value: unknown): string {
  if (typeof value !== "string") return "<invalid>";
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 240) : "<invalid>";
}

function emptySectionInspection(): Record<MissionContextSection, MissionContextSectionInspection> {
  return Object.fromEntries(MISSION_CONTEXT_SECTIONS.map(section => [section, {
    requestedChars: 0,
    usedChars: 0,
    selectedCount: 0,
    omittedCount: 0,
    budgetSource: section === "skills" || section === "tool-schemas" ? "unimplemented" : "profile",
    borrowedChars: 0,
  }])) as Record<MissionContextSection, MissionContextSectionInspection>;
}

function baseInspector(
  projectId: string,
  rootMissionId: string,
  missionId: string,
  managedSessionId: string,
  budget: NormalizedBudget,
): MissionContextInspector {
  return {
    version: 1,
    scope: { projectId, rootMissionId, missionId, managedSessionId },
    budget: {
      totalRequestedChars: budget.maxChars,
      outputReserveChars: budget.outputReserveChars,
      sections: emptySectionInspection(),
    },
    selected: { count: 0, itemIds: [] },
    omitted: { count: 0, items: [] },
    exclusions: { count: 0, items: [] },
    ambiguities: [],
    compression: { strategy: "deterministic-item-selection", truncated: false },
    finalRenderedLength: 0,
    providerSpecificFieldsRejected: [...PROVIDER_SPECIFIC_FIELDS_REJECTED],
    durableRoutingJournalCreated: false,
  };
}

function invalidRequestInspector(value: unknown): MissionContextInspector {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const rawBudget = ownValue(row, "budget");
  const budgetRow = rawBudget && typeof rawBudget === "object" && !Array.isArray(rawBudget) ? rawBudget as Record<string, unknown> : {};
  const rawMaxChars = ownValue(budgetRow, "maxChars");
  const maxChars = typeof rawMaxChars === "number"
    && Number.isInteger(rawMaxChars)
    && rawMaxChars >= 1
    && rawMaxChars <= MAX_CONTEXT_BUDGET_CHARS
    ? rawMaxChars
    : 1;
  return baseInspector(
    previewIdentity(ownValue(row, "projectId")),
    previewIdentity(ownValue(row, "rootMissionId")),
    previewIdentity(ownValue(row, "missionId")),
    previewIdentity(ownValue(row, "managedSessionId")),
    { maxChars, sectionChars: {}, outputReserveChars: "unspecified" },
  );
}

function resolveProfile(
  mission: TaskMissionMetadata,
  worker: WorkerDescriptor,
  constraints: MissionContextProfileConstraints | undefined,
): ResolvedProfile {
  const explicit = constraints?.profile ?? "auto";
  let name: MissionContextProfileName;
  if (explicit === "research") name = "research-v1";
  else if (explicit === "practice") name = "practice-v1";
  else if (explicit === "coordination") name = "coordination-v1";
  else name = mission.plane === "cognition" ? "research-v1" : mission.plane === "practice" ? "practice-v1" : "coordination-v1";

  const envelopeRatios = name === "research-v1"
    ? { instructions: 0.18, "decisions/current-truth": 0.24, evidence: 0.30, artifacts: 0.08, "history/handoff": 0.20 }
    : name === "practice-v1"
      ? { instructions: 0.27, "decisions/current-truth": 0.38, evidence: 0.15, artifacts: 0.08, "history/handoff": 0.12 }
      : { instructions: 0.42, "decisions/current-truth": 0.33, evidence: 0.08, artifacts: 0.05, "history/handoff": 0.12 };
  return {
    name,
    includeDraftProposals: constraints?.includeDraftProposals === true,
    includeRelatedResearch: constraints?.includeRelatedResearch ?? name === "research-v1",
    envelopeRatios,
  };
}

function decisionApplies(decision: ProjectDecisionChange, missionId: string): boolean {
  return decision.content.scope.kind === "project" || decision.content.scope.missionIds.includes(missionId);
}

function item(
  itemId: string,
  section: MissionContextSection,
  tier: MissionContextItem["tier"],
  priority: number,
  required: boolean,
  authority: MissionContextAuthority,
  owner: MissionContextOwner,
  type: string,
  id: string,
  reason: string,
  content: unknown,
): MissionContextItem {
  return { itemId, section, tier, priority, required, authority, provenance: { owner, type, id, reason }, content };
}

function executionContent(execution: TaskExecution): unknown {
  return {
    executionId: execution.executionId,
    toolName: execution.toolName,
    ...(execution.capabilityId ? { capabilityId: execution.capabilityId } : {}),
    status: execution.status,
    deliveryStatus: execution.deliveryStatus,
    ...(execution.resultSummary ? { resultSummary: execution.resultSummary } : {}),
    ...(execution.error ? { error: execution.error } : {}),
  };
}

function artifactContent(artifact: TaskArtifactRef): unknown {
  const succession = artifact.metadata?.schema === "nimora-worker-succession-handoff-v1"
    && typeof artifact.metadata.text === "string" && artifact.metadata.text.length <= 48_000
    && typeof artifact.metadata.sourceManagedSessionId === "string"
    && typeof artifact.metadata.contentDigest === "string"
    ? {
        sourceManagedSessionId: artifact.metadata.sourceManagedSessionId,
        contentDigest: artifact.metadata.contentDigest,
        text: artifact.metadata.text,
      }
    : undefined;
  return {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    title: artifact.title,
    ...(artifact.uri ? { uri: artifact.uri } : {}),
    ...(artifact.executionId ? { executionId: artifact.executionId } : {}),
    ...(succession ? { successionHandoff: succession } : {}),
  };
}

function workerHistoryContent(worker: TaskWorkerSessionRef, currentManagedSessionId: string): unknown {
  const current = worker.managedSessionId === currentManagedSessionId && !worker.detachedAt && !worker.retiredAt;
  return {
    managedSessionId: worker.managedSessionId,
    workerId: worker.workerId,
    ...(worker.model ? { model: worker.model } : {}),
    lifecycle: current ? "current" : worker.retiredAt ? "retired" : worker.detachedAt ? "detached" : "historical-attached",
    attachedAt: worker.attachedAt,
    ...(worker.detachedAt ? { detachedAt: worker.detachedAt } : {}),
    ...(worker.retiredAt ? { retiredAt: worker.retiredAt } : {}),
    ...(worker.retirementReason ? { retirementReason: worker.retirementReason } : {}),
  };
}

function referencedEvidenceIds(exchange: MissionExchange): string[] {
  if (exchange.kind === "Finding" || exchange.kind === "Problem" || exchange.kind === "Answer") {
    return [...exchange.payload.evidenceExchangeIds];
  }
  return [];
}

function exchangeSection(exchange: MissionExchange): MissionContextSection {
  return exchange.kind === "Handoff" ? "history/handoff" : "evidence";
}

function exchangePriority(exchange: MissionExchange, direct: boolean, answeredProblemIds: ReadonlySet<string>): { tier: MissionContextItem["tier"]; priority: number; required: boolean } {
  const relatedPenalty = direct ? 0 : 35;
  if (exchange.kind === "Problem") {
    const unresolvedBlocking = exchange.payload.blocking && !answeredProblemIds.has(exchange.exchangeId);
    return { tier: 1, priority: relatedPenalty + (unresolvedBlocking ? 2 : 10), required: unresolvedBlocking };
  }
  if (exchange.kind === "Answer") return { tier: 1, priority: relatedPenalty + 8, required: false };
  if (exchange.kind === "Handoff") return { tier: 2, priority: relatedPenalty + 18, required: false };
  if (exchange.kind === "Evidence") return { tier: 2, priority: relatedPenalty + 22, required: false };
  if (exchange.kind === "Finding") return { tier: 3, priority: relatedPenalty + 45, required: false };
  return { tier: 3, priority: relatedPenalty + 50, required: false };
}

function relationContent(relation: MissionGraphRelation): unknown {
  return {
    relationId: relation.relationId,
    type: relation.type,
    sourceMissionId: relation.sourceMissionId,
    targetMissionId: relation.targetMissionId,
    ...("basisExchangeId" in relation && relation.basisExchangeId ? { basisExchangeId: relation.basisExchangeId } : {}),
    ...("derived" in relation && relation.derived === true ? { derived: true } : {}),
  };
}

function proposalExclusion(proposal: ProjectProposal): MissionContextExclusion | undefined {
  if (!proposal.supersededByProposalId) return undefined;
  return {
    itemId: `project-proposal:${proposal.proposalId}`,
    owner: "ProjectStore",
    reason: "superseded-project-proposal",
    authorityBasis: `ProjectStore proposal ${proposal.proposalId} is durably superseded by ${proposal.supersededByProposalId}.`,
  };
}

function addTaskCandidates(
  candidates: MissionContextItem[],
  exclusions: MissionContextExclusion[],
  task: TaskSnapshot,
  project: ProjectSnapshot,
  currentSession: TaskWorkerSessionRef,
): void {
  const mission = task.mission!;
  candidates.push(item(
    "mission:scope",
    "instructions",
    0,
    0,
    true,
    "authoritative",
    "TaskRuntime",
    "mission-identity",
    task.taskId,
    "Exact current TaskSnapshot Mission identity and already-bound Worker identity.",
    {
      projectId: mission.projectId,
      rootMissionId: mission.rootMissionId,
      missionId: task.taskId,
      managedSessionId: currentSession.managedSessionId,
      workerId: currentSession.workerId,
      plane: mission.plane,
      missionType: mission.missionType,
      status: task.status,
    },
  ));
  if (task.goal) candidates.push(item("mission:goal", "instructions", 0, 1, true, "authoritative", "TaskRuntime", "mission-goal", task.taskId, "Current Mission goal.", { goal: task.goal }));
  candidates.push(item("mission:completion-criteria", "instructions", 0, 2, true, "authoritative", "TaskRuntime", "mission-completion-criteria", task.taskId, "Current Mission completion criteria.", { completionCriteria: [...mission.completionCriteria] }));
  if (project.goal) candidates.push(item("project:goal", "instructions", 2, 30, false, "authoritative", "ProjectStore", "project-goal", project.projectId, "Current Project goal.", { goal: project.goal }));
  if (task.context.summary) candidates.push(item("task:context-summary", "instructions", 1, 5, true, "authoritative", "TaskRuntime", "task-context-summary", task.taskId, "Current TaskRuntime context projection.", { summary: task.context.summary }));
  task.context.constraints.forEach((constraint, index) => candidates.push(item(
    `task:constraint:${index}`,
    "instructions",
    0,
    3 + index,
    true,
    "authoritative",
    "TaskRuntime",
    "task-constraint",
    `${task.taskId}:${index}`,
    "Current TaskRuntime constraint; safety/current-working truth is non-omittable.",
    { constraint },
  )));
  task.context.decisions.forEach((decision, index) => candidates.push(item(
    `task:decision:${index}`,
    "decisions/current-truth",
    1,
    10 + index,
    true,
    "authoritative",
    "TaskRuntime",
    "task-context-decision",
    `${task.taskId}:${index}`,
    "Current TaskRuntime Mission-local decision/context fact.",
    { decision },
  )));
  task.context.relevantFiles.forEach((path, index) => candidates.push(item(
    `task:relevant-file:${index}`,
    "instructions",
    2,
    60 + index,
    false,
    "durable-fact",
    "TaskRuntime",
    "relevant-file",
    `${task.taskId}:${index}`,
    "Current TaskRuntime relevant-file reference.",
    { path },
  )));
  if (task.progress) candidates.push(item("task:progress", "instructions", 1, 20, false, "durable-fact", "TaskRuntime", "progress", task.taskId, "Current TaskRuntime progress projection.", structuredClone(task.progress)));
  task.todos.forEach(todo => candidates.push(item(`task:todo:${todo.id}`, "instructions", 1, 25, false, "durable-fact", "TaskRuntime", "todo", todo.id, "Current TaskRuntime todo projection.", structuredClone(todo))));

  Object.values(task.executions).forEach(execution => {
    const uncertain = execution.status === "unknown" || execution.deliveryStatus === "unknown";
    const inFlight = execution.status === "requested" || execution.status === "executing" || execution.deliveryStatus === "pending";
    candidates.push(item(
      `execution:${execution.executionId}`,
      "decisions/current-truth",
      uncertain || inFlight ? 0 : 3,
      uncertain ? 4 : inFlight ? 6 : 70,
      uncertain || inFlight,
      "durable-fact",
      "TaskRuntime",
      "execution-state",
      execution.executionId,
      uncertain ? "Exact uncertain execution/delivery state; UNKNOWN must remain UNKNOWN." : inFlight ? "Current in-flight/pending execution state." : "Historical exact execution/delivery state.",
      executionContent(execution),
    ));
  });
  task.artifacts.forEach(artifact => candidates.push(item(
    `artifact:${task.taskId}:${artifact.artifactId}`,
    "artifacts",
    2,
    30,
    false,
    "durable-fact",
    "TaskRuntime",
    "artifact-reference",
    artifact.artifactId,
    "Durable artifact reference; arbitrary artifact metadata/body is not copied.",
    artifactContent(artifact),
  )));
  Object.values(task.workerSessions).forEach(worker => candidates.push(item(
    `worker-history:${worker.managedSessionId}`,
    "history/handoff",
    worker.managedSessionId === currentSession.managedSessionId ? 1 : 4,
    worker.managedSessionId === currentSession.managedSessionId ? 12 : 80,
    false,
    worker.managedSessionId === currentSession.managedSessionId ? "durable-fact" : "historical",
    "TaskRuntime",
    "worker-history",
    worker.managedSessionId,
    worker.managedSessionId === currentSession.managedSessionId
      ? "Current Worker history reference; provider-native adapterSessionId is intentionally excluded."
      : "Historical detached/retired Worker continuity only; it is not portrayed as current Worker authority.",
    workerHistoryContent(worker, currentSession.managedSessionId),
  )));

  exclusions.push({
    itemId: `task-prior-revisions:${task.taskId}`,
    owner: "TaskRuntime",
    reason: "current-snapshot-replaces-prior-current-state-revisions",
    authorityBasis: "TaskRuntime.getTask() is the authoritative current projection; older revisions of the same current-state fields are not materialized as current truth.",
  });
  Object.values(task.capabilityGrants).forEach(grant => exclusions.push({
    itemId: `capability-grant:${grant.grantId}`,
    owner: "TaskRuntime",
    reason: grant.revokedAt ? "revoked-grant-not-current-approval" : "capability-routing-deferred-in-wo1",
    authorityBasis: grant.revokedAt
      ? `TaskRuntime marks grant ${grant.grantId} revoked at ${grant.revokedAt}; it cannot be portrayed as current approval.`
      : "WO#1 does not materialize capability visibility/schema/grant projection; existing capability owners remain authoritative.",
  }));
}

function addProjectCandidates(
  candidates: MissionContextItem[],
  exclusions: MissionContextExclusion[],
  ambiguities: MissionContextInspector["ambiguities"],
  project: ProjectSnapshot,
  missionId: string,
  includeDraftProposals: boolean,
): void {
  const applicable = Object.values(project.committedDecisions)
    .filter(decision => decisionApplies(decision, missionId))
    .sort((a, b) => a.decisionId.localeCompare(b.decisionId));
  for (const decision of applicable) {
    candidates.push(item(
      `project-decision:${decision.decisionId}`,
      "decisions/current-truth",
      1,
      0,
      true,
      "authoritative",
      "ProjectStore",
      "committed-project-decision",
      decision.decisionId,
      decision.content.scope.kind === "project" ? "Committed Project Decision applies project-wide." : "Committed Project Decision explicitly includes this Mission.",
      {
        decisionId: decision.decisionId,
        kind: decision.content.kind,
        summary: decision.content.summary,
        ...(decision.content.rationale ? { rationale: decision.content.rationale } : {}),
        scope: structuredClone(decision.content.scope),
        committedAt: decision.committedAt,
      },
    ));
  }
  if (applicable.length > 1) {
    ambiguities.push({
      kind: "committed-decision-peer-authority",
      decisionIds: applicable.map(decision => decision.decisionId).slice(0, MAX_INSPECTED_ITEM_IDS),
      reason: "Multiple applicable Committed Decisions have peer durable authority. Project governance exposes no generic Decision-supersedes-Decision contract, so no recency winner was inferred; any semantic conflict remains explicit for Cognition.",
    });
  }

  const committedProposalIds = new Set(Object.values(project.committedDecisions).map(decision => decision.proposalId));
  for (const proposal of Object.values(project.proposals).sort((a, b) => a.proposalId.localeCompare(b.proposalId))) {
    const superseded = proposalExclusion(proposal);
    if (superseded) {
      exclusions.push(superseded);
      continue;
    }
    if (committedProposalIds.has(proposal.proposalId)) {
      exclusions.push({
        itemId: `project-proposal:${proposal.proposalId}`,
        owner: "ProjectStore",
        reason: "proposal-represented-by-committed-decision",
        authorityBasis: "Committed Decision is the authoritative governance fact; its source Proposal is not duplicated as current authority.",
      });
      continue;
    }
    if (!includeDraftProposals) {
      exclusions.push({
        itemId: `project-proposal:${proposal.proposalId}`,
        owner: "ProjectStore",
        reason: "profile-excluded-non-authoritative-proposal",
        authorityBasis: "Draft/unconfirmed Proposal is non-authoritative and this materialization profile did not request proposal research.",
      });
      continue;
    }
    candidates.push(item(
      `project-proposal:${proposal.proposalId}`,
      "evidence",
      4,
      95,
      false,
      "non-authoritative-research",
      "ProjectStore",
      "draft-project-proposal",
      proposal.proposalId,
      "Explicitly requested draft Proposal research; this item is labeled non-authoritative.",
      { proposalId: proposal.proposalId, content: structuredClone(proposal.content), proposedAt: proposal.proposedAt },
    ));
  }
}

function addCollaborationCandidates(
  candidates: MissionContextItem[],
  profileOmissions: MissionContextOmission[],
  collaboration: MissionCollaborationStore,
  tasks: TaskRuntime,
  projectId: string,
  rootMissionId: string,
  missionId: string,
  includeRelatedResearch: boolean,
  requiredIds: ReadonlySet<string>,
): void {
  const relations = collaboration.listRelations(projectId);
  const directRelations = relations.filter(relation => relation.sourceMissionId === missionId || relation.targetMissionId === missionId);
  const explicitResearchRelations = collaboration.listRelations(projectId, { includeDerivedParent: false })
    .filter(relation => relation.sourceMissionId === missionId || relation.targetMissionId === missionId);
  const relatedMissionIds = new Set<string>([missionId]);
  for (const relation of explicitResearchRelations) {
    relatedMissionIds.add(relation.sourceMissionId);
    relatedMissionIds.add(relation.targetMissionId);
  }
  const inRoot = new Set(tasks.listTasks()
    .filter(task => task.mission?.projectId === projectId && task.mission.rootMissionId === rootMissionId)
    .map(task => task.taskId));
  const allExchanges = collaboration.listExchanges(projectId);
  const answersByProblem = new Set(allExchanges
    .filter((exchange): exchange is Extract<MissionExchange, { kind: "Answer" }> => exchange.kind === "Answer")
    .map(exchange => exchange.replyToExchangeId));
  const primaryUniverse = allExchanges.filter(exchange => {
    const direct = exchange.sourceMissionId === missionId || exchange.targetMissionId === missionId;
    if (direct) return true;
    return inRoot.has(exchange.sourceMissionId)
      && relatedMissionIds.has(exchange.sourceMissionId)
      && (!exchange.targetMissionId || inRoot.has(exchange.targetMissionId));
  });
  const directPrimary = primaryUniverse.filter(exchange => exchange.sourceMissionId === missionId || exchange.targetMissionId === missionId);
  const directlyReferencedEvidence = new Set(directPrimary.flatMap(referencedEvidenceIds));
  const referencedEvidence = new Set(primaryUniverse.flatMap(referencedEvidenceIds));
  const relevantIds = new Set([...primaryUniverse.map(exchange => exchange.exchangeId), ...referencedEvidence]);
  const profileAdmittedIds = new Set([...directPrimary.map(exchange => exchange.exchangeId), ...directlyReferencedEvidence]);
  const relevant = allExchanges.filter(exchange => relevantIds.has(exchange.exchangeId));
  const profileOmittedIds = new Set(profileOmissions.map(candidate => candidate.itemId));

  const admitCandidate = (candidate: MissionContextItem, profileAllowed: boolean): void => {
    if (profileAllowed || requiredIds.has(candidate.itemId)) {
      candidates.push(candidate);
      return;
    }
    if (profileOmittedIds.has(candidate.itemId)) return;
    profileOmittedIds.add(candidate.itemId);
    profileOmissions.push({
      itemId: candidate.itemId,
      section: candidate.section,
      reason: "profile-excluded",
      estimatedChars: candidateEstimatedChars(candidate),
    });
  };

  for (const exchange of relevant) {
    const direct = exchange.sourceMissionId === missionId || exchange.targetMissionId === missionId;
    const inheritedEvidence = referencedEvidence.has(exchange.exchangeId) && exchange.kind === "Evidence";
    const profileAllowed = includeRelatedResearch || profileAdmittedIds.has(exchange.exchangeId);
    const exchangeItemId = `exchange:${exchange.exchangeId}`;
    const ranking = exchangePriority(exchange, direct || inheritedEvidence, answersByProblem);
    const exchangeCandidate = item(
      exchangeItemId,
      exchangeSection(exchange),
      inheritedEvidence ? Math.min(ranking.tier, 2) as MissionContextItem["tier"] : ranking.tier,
      inheritedEvidence ? Math.min(ranking.priority, 16) : ranking.priority,
      ranking.required,
      "durable-fact",
      "MissionCollaborationStore",
      `mission-exchange:${exchange.kind}`,
      exchange.exchangeId,
      direct
        ? "Typed collaboration fact directly involves the target Mission."
        : inheritedEvidence
          ? "Evidence is explicitly referenced inside the target Mission's bounded collaboration relevance universe."
          : requiredIds.has(exchangeItemId) && !profileAllowed
            ? "Explicit requiredItemIds promoted a known related fact across the resolved profile boundary without changing its authority."
            : "Research profile admitted a fact from an explicitly related in-root Mission.",
      structuredClone(exchange),
    );
    admitCandidate(exchangeCandidate, profileAllowed);
    if (exchange.kind === "Evidence") {
      for (const reference of exchange.payload.references) {
        if (reference.type !== "artifact") continue;
        const ownerTask = tasks.getTask(reference.missionId);
        const artifact = ownerTask?.artifacts.find(candidate => candidate.artifactId === reference.artifactId);
        if (!artifact) continue;
        const artifactCandidate = item(
          `artifact:${reference.missionId}:${artifact.artifactId}`,
          "artifacts",
          2,
          inheritedEvidence ? 12 : 28,
          false,
          "durable-fact",
          "TaskRuntime",
          "referenced-artifact",
          artifact.artifactId,
          "Artifact reference is required to understand relevant Evidence; body/metadata is not copied.",
          { missionId: reference.missionId, ...artifactContent(artifact) as Record<string, unknown> },
        );
        admitCandidate(artifactCandidate, profileAllowed);
      }
    }
  }

  for (const relation of directRelations) {
    candidates.push(item(
      `relation:${relation.relationId}`,
      "history/handoff",
      2,
      35,
      false,
      "durable-fact",
      "MissionCollaborationStore",
      `mission-relation:${relation.type}`,
      relation.relationId,
      "Typed Mission relation directly touches the target Mission; supersedes does not blanket-invalidate source facts.",
      relationContent(relation),
    ));
  }
}

function itemLine(value: MissionContextItem): string {
  return `- ${stableJson({
    id: value.itemId,
    authority: value.authority,
    provenance: value.provenance,
    content: value.content,
  })}`;
}

function renderItems(items: readonly MissionContextItem[], maxChars: number): { text: string; truncatedSections: string[] } {
  return renderStructuredContextHandoff({
    title: "Nimora Mission Context",
    sections: MISSION_CONTEXT_SECTIONS
      .filter(section => section !== "skills" && section !== "tool-schemas")
      .map(section => ({
        name: section,
        lines: items.filter(candidate => candidate.section === section).map(itemLine),
      })),
  }, maxChars);
}

function unboundedRenderedLength(items: readonly MissionContextItem[]): number {
  return renderItems(items, Number.MAX_SAFE_INTEGER).text.length;
}

function sectionCost(items: readonly MissionContextItem[], section: MissionContextSection): number {
  const lines = items.filter(item => item.section === section).map(itemLine);
  if (!lines.length) return 0;
  return `## ${section}\n${lines.join("\n")}\n\n`.length;
}

function sortedCandidates(items: readonly MissionContextItem[], requiredIds: ReadonlySet<string>): MissionContextItem[] {
  const promoted = items.map(candidate => requiredIds.has(candidate.itemId) ? { ...candidate, required: true, tier: 0 as const, priority: Math.min(candidate.priority, 5) } : candidate);
  const sorted = promoted.sort((a, b) => Number(b.required) - Number(a.required)
    || a.tier - b.tier
    || a.priority - b.priority
    || (SECTION_ORDER.get(a.section) ?? 999) - (SECTION_ORDER.get(b.section) ?? 999)
    || a.itemId.localeCompare(b.itemId));
  const seen = new Set<string>();
  return sorted.filter(candidate => {
    if (seen.has(candidate.itemId)) return false;
    seen.add(candidate.itemId);
    return true;
  });
}

function candidateEstimatedChars(candidate: MissionContextItem): number {
  return itemLine(candidate).length + 1;
}

function configureInspectorBudget(
  inspector: MissionContextInspector,
  budget: NormalizedBudget,
  profile: ResolvedProfile,
): void {
  for (const section of MISSION_CONTEXT_SECTIONS) {
    const explicit = budget.sectionChars[section];
    if (section === "skills" || section === "tool-schemas") {
      inspector.budget.sections[section] = {
        requestedChars: explicit ?? 0,
        usedChars: 0,
        selectedCount: 0,
        omittedCount: 0,
        budgetSource: "unimplemented",
        borrowedChars: 0,
      };
      continue;
    }
    const requestedChars = explicit ?? Math.floor(budget.maxChars * profile.envelopeRatios[section]);
    inspector.budget.sections[section] = {
      requestedChars,
      usedChars: 0,
      selectedCount: 0,
      omittedCount: 0,
      budgetSource: explicit === undefined ? "profile" : "explicit",
      borrowedChars: 0,
    };
  }
}

function selectUnderBudget(
  candidates: MissionContextItem[],
  budget: NormalizedBudget,
  inspector: MissionContextInspector,
): { selected: MissionContextItem[]; omitted: MissionContextOmission[] } {
  const selected: MissionContextItem[] = [];
  const omitted: MissionContextOmission[] = [];
  const deferredForBorrow: MissionContextItem[] = [];

  const canFitTotal = (candidate: MissionContextItem) => unboundedRenderedLength([...selected, candidate]) <= budget.maxChars;
  const canFitSection = (candidate: MissionContextItem, useSoftEnvelope: boolean): boolean => {
    const inspection = inspector.budget.sections[candidate.section];
    if (inspection.budgetSource === "unimplemented") return false;
    if (!useSoftEnvelope && inspection.budgetSource === "profile") return true;
    return sectionCost([...selected, candidate], candidate.section) <= inspection.requestedChars;
  };

  for (const candidate of candidates.filter(candidate => candidate.required)) {
    if (!canFitSection(candidate, true) && inspector.budget.sections[candidate.section].budgetSource === "explicit") {
      inspector.incompatibility = {
        code: "budget-incompatibility",
        itemId: candidate.itemId,
        section: candidate.section,
        reason: "Mandatory item exceeds the caller's explicit section budget.",
      };
      throw new MissionContextMaterializationError("budget-incompatibility", inspector.incompatibility.reason, inspector);
    }
    if (!canFitTotal(candidate)) {
      inspector.incompatibility = {
        code: "budget-incompatibility",
        itemId: candidate.itemId,
        section: candidate.section,
        reason: "Mandatory identity/safety/current-authority item cannot fit the hard context budget.",
      };
      throw new MissionContextMaterializationError("budget-incompatibility", inspector.incompatibility.reason, inspector);
    }
    selected.push(candidate);
  }

  for (const candidate of candidates.filter(candidate => !candidate.required)) {
    const sectionInspection = inspector.budget.sections[candidate.section];
    if (!canFitSection(candidate, true)) {
      if (sectionInspection.budgetSource === "profile") deferredForBorrow.push(candidate);
      else omitted.push({ itemId: candidate.itemId, section: candidate.section, reason: "section-budget", estimatedChars: candidateEstimatedChars(candidate) });
      continue;
    }
    if (!canFitTotal(candidate)) {
      omitted.push({ itemId: candidate.itemId, section: candidate.section, reason: "total-budget", estimatedChars: candidateEstimatedChars(candidate) });
      continue;
    }
    selected.push(candidate);
  }

  for (const candidate of deferredForBorrow) {
    if (!canFitTotal(candidate)) {
      omitted.push({ itemId: candidate.itemId, section: candidate.section, reason: "total-budget", estimatedChars: candidateEstimatedChars(candidate) });
      continue;
    }
    selected.push(candidate);
  }
  return { selected, omitted };
}

function finalizeInspector(
  inspector: MissionContextInspector,
  selected: readonly MissionContextItem[],
  omitted: readonly MissionContextOmission[],
  exclusions: readonly MissionContextExclusion[],
  textLength: number,
): void {
  inspector.selected = { count: selected.length, itemIds: selected.map(item => item.itemId).slice(0, MAX_INSPECTED_ITEM_IDS) };
  inspector.omitted = { count: omitted.length, items: omitted.slice(0, MAX_INSPECTED_ITEM_IDS) };
  inspector.exclusions = { count: exclusions.length, items: exclusions.slice(0, MAX_INSPECTED_ITEM_IDS) };
  inspector.finalRenderedLength = textLength;
  for (const section of MISSION_CONTEXT_SECTIONS) {
    const state = inspector.budget.sections[section];
    const usedChars = sectionCost(selected, section);
    const omittedCount = omitted.filter(item => item.section === section).length;
    state.usedChars = usedChars;
    state.selectedCount = selected.filter(item => item.section === section).length;
    state.omittedCount = omittedCount;
    state.borrowedChars = state.budgetSource === "profile" ? Math.max(0, usedChars - state.requestedChars) : 0;
  }
  if (omitted.length) {
    const profileExcluded = omitted.some(item => item.reason === "profile-excluded");
    const budgetExcluded = omitted.some(item => item.reason === "section-budget" || item.reason === "total-budget");
    inspector.compression.reason = profileExcluded && budgetExcluded
      ? "Known relevant items were withheld by resolved profile policy and lower-priority whole items were omitted deterministically under section/total character budgets."
      : profileExcluded
        ? "Known relevant items were withheld by the resolved materialization profile."
        : "Lower-priority whole items were omitted deterministically under section/total character budgets.";
  }
}

function classifyContinuationError(error: unknown): MissionContextMaterializationErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/finalizing/i.test(message)) return "finalizing-mission";
  if (/terminal|finalized|archived|completed/i.test(message)) return "terminal-mission";
  return "scope-mismatch";
}

/**
 * Phase 8 WO#1 read/derive owner. It owns no journal, Worker selection, send
 * path, capability exposure, Skill registry, approval, execution, or retry.
 */
export class MissionContextMaterializer {
  constructor(
    private readonly projects: ProjectStore,
    private readonly tasks: TaskRuntime,
    private readonly collaboration: MissionCollaborationStore,
    private readonly workers: WorkerSessionManager,
  ) {}

  async materialize(input: MissionContextMaterializationRequest): Promise<MissionContextMaterializationResult> {
    let request: NormalizedMaterializationRequest;
    try {
      request = normalizeMaterializationRequest(input);
    } catch (error) {
      const inspector = invalidRequestInspector(input);
      const message = error instanceof Error ? error.message : "Invalid Mission context materialization request.";
      this.fail("invalid-request", message.slice(0, 1_000), inspector);
    }
    const { projectId, rootMissionId, missionId, managedSessionId, budget } = request;
    const inspector = baseInspector(projectId, rootMissionId, missionId, managedSessionId, budget);
    await Promise.all([this.projects.initialize(), this.tasks.initialize(), this.collaboration.initialize()]);

    const project = this.projects.getProject(projectId);
    if (!project) this.fail("scope-mismatch", `Unknown Project: ${projectId}`, inspector);
    const task = this.tasks.getTask(missionId);
    if (!task?.mission) this.fail("scope-mismatch", `Mission does not exist or is not configured: ${missionId}`, inspector);
    if (task.mission.projectId !== projectId || task.mission.rootMissionId !== rootMissionId) {
      this.fail("scope-mismatch", "Mission does not match the exact Project/root scope.", inspector);
    }
    const root = this.tasks.getTask(rootMissionId);
    if (!root?.mission || root.mission.projectId !== projectId || root.mission.rootMissionId !== rootMissionId || root.mission.parentMissionId !== undefined) {
      this.fail("scope-mismatch", "Requested rootMissionId is not the exact Project root Mission.", inspector);
    }
    if (task.missionFinalization) this.fail("terminal-mission", `Mission ${missionId} is terminal and cannot receive new working context.`, inspector);
    try {
      await this.tasks.assertWorkerSessionContinuationAllowed(missionId, "materialize Mission context");
    } catch (error) {
      this.fail(classifyContinuationError(error), error instanceof Error ? error.message : String(error), inspector);
    }

    const session = this.workers.getSession(managedSessionId);
    if (!session) {
      const retired = this.workers.getRetiredSession(managedSessionId);
      this.fail("session-mismatch", retired
        ? `Managed WorkerSession ${managedSessionId} is retired and cannot receive new working context.`
        : `Managed WorkerSession does not exist: ${managedSessionId}`, inspector, retired?.workerId);
    }
    this.validateLiveSession(session, task, inspector);
    const worker = this.workers.getWorker(session.workerId);
    if (!worker) this.fail("worker-incompatibility", `Exact Worker is no longer registered: ${session.workerId}`, inspector, session.workerId);
    inspector.scope.workerId = worker.id;
    const durableSession = task.workerSessions[managedSessionId];
    if (!durableSession || durableSession.workerId !== session.workerId || durableSession.adapterSessionId !== session.adapterSessionId || durableSession.detachedAt || durableSession.retiredAt) {
      this.fail("session-mismatch", `Managed WorkerSession ${managedSessionId} is not the exact active TaskRuntime binding for Mission ${missionId}.`, inspector, session.workerId);
    }

    const profile = resolveProfile(task.mission, worker, request.constraints);
    inspector.profile = {
      name: profile.name,
      version: 1,
      inputs: {
        missionPlane: task.mission.plane,
        missionType: task.mission.missionType,
        workerKind: worker.kind,
        workerAvailability: worker.availability,
        workerCapabilities: structuredClone(worker.capabilities),
        explicitProfile: request.constraints?.profile ?? "auto",
        includeDraftProposals: profile.includeDraftProposals,
        includeRelatedResearch: profile.includeRelatedResearch,
      },
    };
    configureInspectorBudget(inspector, budget, profile);

    const requiredIds = new Set(request.constraints?.requiredItemIds ?? []);
    const candidates: MissionContextItem[] = [];
    const profileOmissions: MissionContextOmission[] = [];
    const exclusions: MissionContextExclusion[] = [];
    const ambiguities: MissionContextInspector["ambiguities"] = [];
    addTaskCandidates(candidates, exclusions, task, project, durableSession);
    addProjectCandidates(candidates, exclusions, ambiguities, project, missionId, profile.includeDraftProposals);
    addCollaborationCandidates(candidates, profileOmissions, this.collaboration, this.tasks, projectId, rootMissionId, missionId, profile.includeRelatedResearch, requiredIds);
    inspector.ambiguities = ambiguities;

    const candidateIds = new Set(candidates.map(candidate => candidate.itemId));
    for (const requiredId of requiredIds) {
      if (candidateIds.has(requiredId)) continue;
      const exclusion = exclusions.find(candidate => candidate.itemId === requiredId);
      if (exclusion) {
        this.fail("invalid-request", `Required context item is excluded by current authority/policy: ${requiredId} (${exclusion.reason}).`, inspector, session.workerId);
      }
      const profileOmission = profileOmissions.find(candidate => candidate.itemId === requiredId);
      if (profileOmission) {
        this.fail("invalid-request", `Required context item is incompatible with the resolved profile: ${requiredId}.`, inspector, session.workerId);
      }
      this.fail("invalid-request", `Required context item does not exist or is non-applicable: ${requiredId}`, inspector, session.workerId);
    }
    inspector.omitted = { count: profileOmissions.length, items: profileOmissions.slice(0, MAX_INSPECTED_ITEM_IDS) };
    const sorted = sortedCandidates(candidates, requiredIds);
    let selected: MissionContextItem[];
    let budgetOmissions: MissionContextOmission[];
    try {
      ({ selected, omitted: budgetOmissions } = selectUnderBudget(sorted, budget, inspector));
    } catch (error) {
      if (error instanceof MissionContextMaterializationError) {
        inspector.exclusions = { count: exclusions.length, items: exclusions.slice(0, MAX_INSPECTED_ITEM_IDS) };
        throw error;
      }
      throw error;
    }
    const rendered = renderItems(selected, budget.maxChars);
    if (rendered.truncatedSections.length) {
      const reason = `Final Context Handoff containment guard unexpectedly truncated sections: ${rendered.truncatedSections.join(", ")}`;
      inspector.compression = {
        strategy: "deterministic-item-selection",
        truncated: true,
        reason,
      };
      inspector.incompatibility = { code: "budget-incompatibility", reason };
      throw new MissionContextMaterializationError("budget-incompatibility", reason, inspector);
    }
    finalizeInspector(inspector, selected, [...profileOmissions, ...budgetOmissions], exclusions, rendered.text.length);

    // Re-check the existing TaskRuntime finalizing/terminal admission fence after
    // gathering so an overlapping finalization attempt cannot return a success.
    try {
      await this.tasks.assertWorkerSessionContinuationAllowed(missionId, "finish Mission context materialization");
    } catch (error) {
      this.fail(classifyContinuationError(error), error instanceof Error ? error.message : String(error), inspector, session.workerId);
    }

    return {
      package: {
        version: 1,
        generatedAt: request.generatedAt ?? new Date().toISOString(),
        projectId,
        rootMissionId,
        missionId,
        managedSessionId,
        workerId: session.workerId,
        profile: profile.name,
        items: selected.map(candidate => structuredClone(candidate)),
      },
      text: rendered.text,
      inspector,
    };
  }

  private validateLiveSession(session: ManagedWorkerSession, task: TaskSnapshot, inspector: MissionContextInspector): void {
    if (session.taskId !== task.taskId) {
      this.fail("session-mismatch", `Managed WorkerSession ${session.managedSessionId} is bound to ${session.taskId ?? "no Task"}, not Mission ${task.taskId}.`, inspector, session.workerId);
    }
    if (session.state === "disposed") this.fail("session-mismatch", `Managed WorkerSession ${session.managedSessionId} is disposed.`, inspector, session.workerId);
  }

  private fail(
    code: MissionContextMaterializationErrorCode,
    message: string,
    inspector: MissionContextInspector,
    workerId?: string,
  ): never {
    if (workerId) inspector.scope.workerId = workerId;
    inspector.incompatibility = { code, reason: message };
    throw new MissionContextMaterializationError(code, message, inspector);
  }
}
