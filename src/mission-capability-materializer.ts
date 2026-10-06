import { createHash } from "node:crypto";
import {
  CAPABILITY_METADATA_BY_TOOL,
  type CapabilityMetadata,
} from "./capability-registry.js";
import {
  type MissionCapabilitySchemaSource,
} from "./mission-capability-schema-source.js";
import type { ProjectStore } from "./project-store.js";
import type { TaskCapabilityGrant, TaskMissionMetadata, TaskSnapshot, TaskWorkerSessionRef } from "./task-contract.js";
import type { TaskRuntime } from "./task-runtime.js";
import type {
  WorkerCapabilityDefinition,
  WorkerCapabilityProjectionMode,
  WorkerDescriptor,
} from "./worker-contract.js";
import type { ManagedWorkerSession, WorkerSessionManager } from "./worker-session-manager.js";

export type MissionCapabilityProfileRequest = "auto" | "research" | "practice" | "coordination";
export type MissionCapabilityProfileName = "research-v1" | "practice-v1" | "coordination-v1";
export type MissionCapabilityProjectionMode = WorkerCapabilityProjectionMode;

export interface MissionCapabilityMaterializationBudget {
  maxSchemaChars: number;
}

export interface MissionCapabilityMaterializationConstraints {
  profile?: MissionCapabilityProfileRequest;
  requiredCapabilityIds?: string[];
  optionalCapabilityIds?: string[];
  /** Hard ceiling; an empty list intentionally exposes no capabilities. */
  allowedCapabilityIds?: string[];
}

export interface MissionCapabilityMaterializationRequest {
  projectId: string;
  rootMissionId: string;
  missionId: string;
  managedSessionId: string;
  budget: MissionCapabilityMaterializationBudget;
  constraints?: MissionCapabilityMaterializationConstraints;
  generatedAt?: string;
}

export interface MissionCapabilityCatalogEntry {
  capabilityId: string;
  version: 1;
  title: string;
  category: string;
  tags: string[];
  environment: string;
  risk: CapabilityMetadata["risk"];
  idempotency: CapabilityMetadata["idempotency"];
  retry: CapabilityMetadata["retry"];
  approval: CapabilityMetadata["approval"];
  destructive: boolean;
  openWorld: boolean;
  toolName: string;
}

export interface MissionCapabilityGrantInspection {
  approval: CapabilityMetadata["approval"];
  state: "not-required" | "active" | "absent" | "external-authority-required";
  matchingTaskRuntimeGrantIds: string[];
  authorityGrantIds: string[];
  ignored: Array<{
    grantId: string;
    reason: "revoked" | "wrong-scope" | "wrong-session" | "wrong-session-generation" | "task-runtime-cannot-satisfy-always" | "approval-not-required";
  }>;
}

export interface MissionCapabilityMappingInspection {
  capabilityId: string;
  version: 1;
  toolName: string;
  required: boolean;
  selection: "profile" | "explicit-required" | "explicit-optional";
  schemaSourceId: string;
  schemaIdentity: string;
  projectionMode: MissionCapabilityProjectionMode;
  executionRouteId: string;
  routeBasis: string;
  schemaPayloadChars: number;
  approval: CapabilityMetadata["approval"];
  grant: MissionCapabilityGrantInspection;
}

export interface MissionCapabilityOmission {
  capabilityId: string;
  toolName?: string;
  schemaSourceId?: string;
  schemaIdentity?: string;
  reason:
    | "unknown-capability-id"
    | "schema-source-unavailable"
    | "schema-not-found"
    | "schema-ambiguous"
    | "schema-drift"
    | "schema-invalid"
    | "worker-projection-unsupported"
    | "schema-budget";
  estimatedChars: number;
  detail: string;
}

export type MissionCapabilityMaterializationErrorCode =
  | "invalid-request"
  | "scope-mismatch"
  | "session-mismatch"
  | "terminal-mission"
  | "finalizing-mission"
  | "capability-incompatibility"
  | "schema-incompatibility"
  | "worker-incompatibility"
  | "budget-incompatibility";

export interface MissionCapabilityInspector {
  version: 1;
  scope: {
    projectId: string;
    rootMissionId: string;
    missionId: string;
    managedSessionId: string;
    workerId?: string;
  };
  profile?: {
    name: MissionCapabilityProfileName;
    explicitProfile: MissionCapabilityProfileRequest;
    missionPlane: TaskMissionMetadata["plane"];
    missionType: string;
  };
  worker?: {
    workerId: string;
    kind: WorkerDescriptor["kind"];
    capabilityRequests: boolean;
    capabilityProjection: {
      nativeByName: boolean;
      externalDefinitions: boolean;
      executionRouteIds: string[];
      routeValidationError?: string;
    };
  };
  budget: {
    requestedSchemaChars: number;
    usedSchemaChars: number;
    selectedCount: number;
    omittedCount: number;
  };
  selected: {
    capabilityIds: string[];
    toolNames: string[];
  };
  mappings: MissionCapabilityMappingInspection[];
  omissions: MissionCapabilityOmission[];
  incompatibility?: {
    code: MissionCapabilityMaterializationErrorCode;
    capabilityId?: string;
    toolName?: string;
    schemaSourceId?: string;
    schemaIdentity?: string;
    reason: string;
  };
  sideEffects: {
    workerSends: 0;
    toolExecutions: 0;
    grantsCreated: 0;
    grantsRevoked: 0;
    workerAssignments: 0;
  };
  durableCapabilityRoutingJournalCreated: false;
}

export interface MissionCapabilityMaterializationResult {
  version: 1;
  generatedAt: string;
  projectId: string;
  rootMissionId: string;
  missionId: string;
  managedSessionId: string;
  workerId: string;
  profile: MissionCapabilityProfileName;
  catalog: MissionCapabilityCatalogEntry[];
  allowedCapabilities: string[];
  externalCapabilities: WorkerCapabilityDefinition[];
  inspector: MissionCapabilityInspector;
}

export class MissionCapabilityMaterializationError extends Error {
  constructor(
    readonly code: MissionCapabilityMaterializationErrorCode,
    message: string,
    readonly inspector: MissionCapabilityInspector,
  ) {
    super(message);
    this.name = "MissionCapabilityMaterializationError";
  }
}

interface NormalizedRequest {
  projectId: string;
  rootMissionId: string;
  missionId: string;
  managedSessionId: string;
  budget: { maxSchemaChars: number };
  constraints?: {
    profile?: MissionCapabilityProfileRequest;
    requiredCapabilityIds?: string[];
    optionalCapabilityIds?: string[];
    allowedCapabilityIds?: string[];
  };
  generatedAt?: string;
}

interface SemanticEntry {
  toolName: string;
  metadata: CapabilityMetadata;
}

interface NormalizedSchema {
  sourceId: string;
  toolName: string;
  definition: WorkerCapabilityDefinition;
  schemaIdentity: string;
}

interface SchemaSourceSnapshot {
  sourceId: string;
  definitions: NormalizedSchema[];
  error?: string;
}

interface SelectedCandidate {
  semantic: SemanticEntry;
  required: boolean;
  selection: MissionCapabilityMappingInspection["selection"];
}

interface NormalizedExecutionRoute {
  routeId: string;
  projectionMode: MissionCapabilityProjectionMode;
  schemaSourceId: string;
  toolNames: string[];
  basis: string;
}

const MAX_ID_CHARS = 240;
const MAX_CAPABILITY_IDS = 128;
const MAX_SCHEMA_BUDGET_CHARS = 1_000_000;
const MAX_SCHEMA_DEFINITION_CHARS = 250_000;
const MAX_SCHEMA_DEPTH = 32;
const MAX_INSPECTED_ITEMS = 128;
const MAX_EXECUTION_ROUTES = 64;
const MAX_ROUTE_TOOL_NAMES = 256;
const MAX_ROUTE_BASIS_CHARS = 1_000;

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

function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  const normalized = value.trim();
  if (normalized.length > MAX_ID_CHARS) throw new Error(`${label} must be at most ${MAX_ID_CHARS} characters.`);
  return normalized;
}

function boundedInteger(value: unknown, label: string, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be a non-negative integer at most ${maximum}.`);
  }
  return value;
}

function normalizeDenseIds(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (value.length > MAX_CAPABILITY_IDS) throw new Error(`${label} must contain at most ${MAX_CAPABILITY_IDS} ids.`);
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${label}[${index}] must be explicitly present in a dense array.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label}[${index}] must be an own data property.`);
    result.push(boundedId(descriptor.value, `${label}[${index}]`));
  }
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates.`);
  return result;
}

function normalizeTimestamp(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) {
    throw new Error("Mission capability generatedAt must be an ISO timestamp.");
  }
  return new Date(value).toISOString();
}

function normalizeRequest(value: unknown): NormalizedRequest {
  const row = ownRecord(value, "Mission capability materialization request");
  exactOwnDataKeys(row, ["projectId", "rootMissionId", "missionId", "managedSessionId", "budget", "constraints", "generatedAt"], "Mission capability materialization request");
  const budgetRow = ownRecord(ownValue(row, "budget"), "Mission capability budget");
  exactOwnDataKeys(budgetRow, ["maxSchemaChars"], "Mission capability budget");
  const maxSchemaChars = boundedInteger(ownValue(budgetRow, "maxSchemaChars"), "Mission capability maxSchemaChars", MAX_SCHEMA_BUDGET_CHARS);
  if (maxSchemaChars < 1) throw new Error("Mission capability maxSchemaChars must be at least 1.");

  const constraintsValue = ownValue(row, "constraints");
  let constraints: NormalizedRequest["constraints"];
  if (constraintsValue !== undefined) {
    const constraintsRow = ownRecord(constraintsValue, "Mission capability constraints");
    exactOwnDataKeys(constraintsRow, ["profile", "requiredCapabilityIds", "optionalCapabilityIds", "allowedCapabilityIds"], "Mission capability constraints");
    const rawProfile = ownValue(constraintsRow, "profile");
    let profile: MissionCapabilityProfileRequest | undefined;
    if (rawProfile !== undefined) {
      if (rawProfile !== "auto" && rawProfile !== "research" && rawProfile !== "practice" && rawProfile !== "coordination") {
        throw new Error(`Unsupported Mission capability profile: ${String(rawProfile)}`);
      }
      profile = rawProfile;
    }
    const requiredCapabilityIds = normalizeDenseIds(ownValue(constraintsRow, "requiredCapabilityIds"), "requiredCapabilityIds");
    const optionalCapabilityIds = normalizeDenseIds(ownValue(constraintsRow, "optionalCapabilityIds"), "optionalCapabilityIds");
    const allowedCapabilityIds = normalizeDenseIds(ownValue(constraintsRow, "allowedCapabilityIds"), "allowedCapabilityIds");
    if (allowedCapabilityIds !== undefined) {
      const allowed = new Set(allowedCapabilityIds);
      const outside = [...(requiredCapabilityIds ?? []), ...(optionalCapabilityIds ?? [])].find(id => !allowed.has(id));
      if (outside) throw new Error(`Capability id is outside the explicit allowed ceiling: ${outside}`);
    }
    if (requiredCapabilityIds && optionalCapabilityIds) {
      const requiredSet = new Set(requiredCapabilityIds);
      const overlap = optionalCapabilityIds.find(id => requiredSet.has(id));
      if (overlap) throw new Error(`Capability id may not be both required and optional: ${overlap}`);
    }
    constraints = {
      ...(profile === undefined ? {} : { profile }),
      ...(requiredCapabilityIds === undefined ? {} : { requiredCapabilityIds }),
      ...(optionalCapabilityIds === undefined ? {} : { optionalCapabilityIds }),
      ...(allowedCapabilityIds === undefined ? {} : { allowedCapabilityIds }),
    };
  }

  return {
    projectId: boundedId(ownValue(row, "projectId"), "Project id"),
    rootMissionId: boundedId(ownValue(row, "rootMissionId"), "Root Mission id"),
    missionId: boundedId(ownValue(row, "missionId"), "Mission id"),
    managedSessionId: boundedId(ownValue(row, "managedSessionId"), "Managed WorkerSession id"),
    budget: { maxSchemaChars },
    constraints,
    generatedAt: normalizeTimestamp(ownValue(row, "generatedAt")),
  };
}

function previewId(value: unknown): string {
  if (typeof value !== "string") return "<invalid>";
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, MAX_ID_CHARS) : "<invalid>";
}

function baseInspector(value: unknown, maxSchemaChars = 1): MissionCapabilityInspector {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    version: 1,
    scope: {
      projectId: previewId(ownValue(row, "projectId")),
      rootMissionId: previewId(ownValue(row, "rootMissionId")),
      missionId: previewId(ownValue(row, "missionId")),
      managedSessionId: previewId(ownValue(row, "managedSessionId")),
    },
    budget: { requestedSchemaChars: maxSchemaChars, usedSchemaChars: 0, selectedCount: 0, omittedCount: 0 },
    selected: { capabilityIds: [], toolNames: [] },
    mappings: [],
    omissions: [],
    sideEffects: { workerSends: 0, toolExecutions: 0, grantsCreated: 0, grantsRevoked: 0, workerAssignments: 0 },
    durableCapabilityRoutingJournalCreated: false,
  };
}

function inspectorForRequest(request: NormalizedRequest): MissionCapabilityInspector {
  return {
    ...baseInspector({}, request.budget.maxSchemaChars),
    scope: {
      projectId: request.projectId,
      rootMissionId: request.rootMissionId,
      missionId: request.missionId,
      managedSessionId: request.managedSessionId,
    },
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`;
}

function canonicalJson(value: unknown, label: string, depth = 0, seen = new Set<object>()): unknown {
  if (depth > MAX_SCHEMA_DEPTH) throw new Error(`${label} exceeds maximum nesting depth.`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`);
    return value;
  }
  if (!value || typeof value !== "object") throw new Error(`${label} contains a non-JSON value.`);
  if (seen.has(value)) throw new Error(`${label} contains a cycle.`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${label} contains a sparse array.`);
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) throw new Error(`${label}[${index}] must be an own data property.`);
        result.push(canonicalJson(descriptor.value, `${label}[${index}]`, depth + 1, seen));
      }
      return result;
    }
    const row = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(row)) {
      if (typeof key !== "string") throw new Error(`${label} contains a symbol key.`);
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      if (!descriptor || !("value" in descriptor)) throw new Error(`${label}.${key} must be an own data property.`);
      result[key] = canonicalJson(descriptor.value, `${label}.${key}`, depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export interface CanonicalWorkerCapabilityDefinition {
  definition: WorkerCapabilityDefinition;
  schemaIdentity: string;
}

/** Canonical concrete-schema validation shared by downstream read-only materializers. */
export function canonicalizeWorkerCapabilityDefinition(
  candidate: unknown,
  label = "Worker capability definition",
): CanonicalWorkerCapabilityDefinition {
  const definitionRow = ownRecord(candidate, label);
  exactOwnDataKeys(definitionRow, ["name", "description", "inputSchema"], label);
  const name = boundedId(ownValue(definitionRow, "name"), `${label} name`);
  const descriptionValue = ownValue(definitionRow, "description");
  if (descriptionValue !== undefined && typeof descriptionValue !== "string") throw new Error(`${label} ${name} description must be a string.`);
  const inputSchema = canonicalJson(ownValue(definitionRow, "inputSchema"), `${label} ${name} inputSchema`);
  if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema) || (inputSchema as Record<string, unknown>).type !== "object") {
    throw new Error(`${label} ${name} must have an object input schema.`);
  }
  const definition: WorkerCapabilityDefinition = {
    name,
    ...(descriptionValue === undefined ? {} : { description: descriptionValue }),
    inputSchema: inputSchema as Record<string, unknown>,
  };
  const serialized = stableJson(definition);
  if (serialized.length > MAX_SCHEMA_DEFINITION_CHARS) throw new Error(`${label} ${name} exceeds the schema size bound.`);
  return {
    definition,
    schemaIdentity: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
  };
}

function normalizeSchemaDefinition(sourceId: string, candidate: unknown, index: number): NormalizedSchema {
  const candidateRow = ownRecord(candidate, `Schema source ${sourceId} entry ${index}`);
  exactOwnDataKeys(candidateRow, ["toolName", "definition"], `Schema source ${sourceId} entry ${index}`);
  const toolName = boundedId(ownValue(candidateRow, "toolName"), `Schema source ${sourceId} entry ${index} toolName`);
  const { definition, schemaIdentity } = canonicalizeWorkerCapabilityDefinition(
    ownValue(candidateRow, "definition"),
    `Schema source ${sourceId} entry ${index} definition`,
  );
  if (definition.name !== toolName) throw new Error(`Schema source ${sourceId} tool-name drift: locator ${toolName} != definition ${definition.name}.`);
  return {
    sourceId,
    toolName,
    definition,
    schemaIdentity,
  };
}

function snapshotSchemaSources(sources: readonly MissionCapabilitySchemaSource[]): SchemaSourceSnapshot[] {
  const ids = new Set<string>();
  const snapshots: SchemaSourceSnapshot[] = [];
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    if (!Object.prototype.hasOwnProperty.call(sources, sourceIndex)) {
      snapshots.push({ sourceId: `<missing:${sourceIndex}>`, definitions: [], error: `Mission capability schema sources must be a dense array; index ${sourceIndex} is missing.` });
      continue;
    }
    const source = sources[sourceIndex];
    let sourceId: string;
    try {
      sourceId = boundedId(source.sourceId, "Mission capability schema source id");
    } catch (error) {
      snapshots.push({ sourceId: "<invalid>", definitions: [], error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (ids.has(sourceId)) {
      snapshots.push({ sourceId, definitions: [], error: `Duplicate Mission capability schema source id: ${sourceId}` });
      continue;
    }
    ids.add(sourceId);
    try {
      const raw = source.listDefinitions();
      if (!Array.isArray(raw)) throw new Error(`Schema source ${sourceId} must return an array.`);
      const definitions: NormalizedSchema[] = [];
      for (let index = 0; index < raw.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(raw, index)) throw new Error(`Schema source ${sourceId} must return a dense definition array; index ${index} is missing.`);
        const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
        if (!descriptor || !("value" in descriptor)) throw new Error(`Schema source ${sourceId} definition ${index} must be an own data property.`);
        definitions.push(normalizeSchemaDefinition(sourceId, descriptor.value, index));
      }
      snapshots.push({ sourceId, definitions });
    } catch (error) {
      snapshots.push({ sourceId, definitions: [], error: error instanceof Error ? error.message : String(error) });
    }
  }
  return snapshots;
}

function semanticRegistry(): { byId: Map<string, SemanticEntry>; ordered: SemanticEntry[] } {
  const byId = new Map<string, SemanticEntry>();
  const toolNames = new Set<string>();
  for (const [toolName, metadata] of Object.entries(CAPABILITY_METADATA_BY_TOOL)) {
    if (!toolName.trim()) throw new Error("Capability registry contains an empty tool name.");
    if (toolNames.has(toolName)) throw new Error(`Capability registry contains duplicate tool name: ${toolName}`);
    toolNames.add(toolName);
    if (byId.has(metadata.id)) throw new Error(`Capability registry contains duplicate semantic id: ${metadata.id}`);
    byId.set(metadata.id, { toolName, metadata });
  }
  const ordered = [...byId.values()].sort((a, b) => a.metadata.id.localeCompare(b.metadata.id));
  for (const entry of ordered) {
    if (byId.get(entry.metadata.id)?.toolName !== entry.toolName) throw new Error(`Capability semantic/tool round-trip drift for ${entry.metadata.id}.`);
  }
  return { byId, ordered };
}

function resolveProfile(mission: TaskMissionMetadata, explicit: MissionCapabilityProfileRequest | undefined): MissionCapabilityProfileName {
  if (explicit === "research") return "research-v1";
  if (explicit === "practice") return "practice-v1";
  if (explicit === "coordination") return "coordination-v1";
  return mission.plane === "cognition" ? "research-v1" : mission.plane === "practice" ? "practice-v1" : "coordination-v1";
}

function profileIncludes(metadata: CapabilityMetadata, profile: MissionCapabilityProfileName): boolean {
  const safeRead = metadata.risk === "read" && !metadata.destructive && !metadata.openWorld;
  if (safeRead) return true;
  if (profile !== "research-v1"
    && metadata.category === "task"
    && metadata.approval === "none"
    && !metadata.destructive
    && !metadata.openWorld) return true;
  return false;
}

function catalogEntry(entry: SemanticEntry): MissionCapabilityCatalogEntry {
  const metadata = entry.metadata;
  return {
    capabilityId: metadata.id,
    version: metadata.version,
    title: metadata.title,
    category: metadata.category,
    tags: [...metadata.tags],
    environment: metadata.environment,
    risk: metadata.risk,
    idempotency: metadata.idempotency,
    retry: metadata.retry,
    approval: metadata.approval,
    destructive: metadata.destructive,
    openWorld: metadata.openWorld,
    toolName: entry.toolName,
  };
}

function matchingGrantBase(grant: TaskCapabilityGrant, metadata: CapabilityMetadata): boolean {
  return grant.capabilityId === metadata.id && grant.capabilityVersion === metadata.version;
}

export function inspectCapabilityGrantVisibility(
  task: TaskSnapshot,
  workerSession: TaskWorkerSessionRef,
  metadata: CapabilityMetadata,
): MissionCapabilityGrantInspection {
  const matching = Object.values(task.capabilityGrants).filter(grant => matchingGrantBase(grant, metadata));
  const matchingTaskRuntimeGrantIds = matching.map(grant => grant.grantId).sort();
  const authorityGrantIds: string[] = [];
  const ignored: MissionCapabilityGrantInspection["ignored"] = [];

  for (const grant of matching) {
    if (grant.revokedAt) {
      ignored.push({ grantId: grant.grantId, reason: "revoked" });
      continue;
    }
    if (metadata.approval === "always") {
      ignored.push({ grantId: grant.grantId, reason: "task-runtime-cannot-satisfy-always" });
      continue;
    }
    if (metadata.approval === "none") {
      ignored.push({ grantId: grant.grantId, reason: "approval-not-required" });
      continue;
    }
    if (metadata.approval === "task-grant") {
      if (grant.scope === "task") authorityGrantIds.push(grant.grantId);
      else ignored.push({ grantId: grant.grantId, reason: "wrong-scope" });
      continue;
    }
    if (grant.scope !== "worker-session") {
      ignored.push({ grantId: grant.grantId, reason: "wrong-scope" });
      continue;
    }
    if (grant.managedSessionId !== workerSession.managedSessionId) {
      ignored.push({ grantId: grant.grantId, reason: "wrong-session" });
      continue;
    }
    if (grant.workerSessionAttachedAt !== workerSession.attachedAt) {
      ignored.push({ grantId: grant.grantId, reason: "wrong-session-generation" });
      continue;
    }
    authorityGrantIds.push(grant.grantId);
  }

  authorityGrantIds.sort();
  ignored.sort((a, b) => a.grantId.localeCompare(b.grantId) || a.reason.localeCompare(b.reason));
  const state = metadata.approval === "none"
    ? "not-required"
    : metadata.approval === "always"
      ? "external-authority-required"
      : authorityGrantIds.length
        ? "active"
        : "absent";
  return { approval: metadata.approval, state, matchingTaskRuntimeGrantIds, authorityGrantIds, ignored };
}

function normalizeExecutionRoutes(worker: WorkerDescriptor): NormalizedExecutionRoute[] {
  const projection = worker.capabilityProjection;
  const rawRoutes = projection?.executionRoutes ?? [];
  if (!Array.isArray(rawRoutes)) throw new Error(`Worker ${worker.id} capability executionRoutes must be an array.`);
  if (rawRoutes.length > MAX_EXECUTION_ROUTES) throw new Error(`Worker ${worker.id} exposes too many capability execution routes.`);
  const routeIds = new Set<string>();
  const routes: NormalizedExecutionRoute[] = [];
  for (let index = 0; index < rawRoutes.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(rawRoutes, index)) throw new Error(`Worker ${worker.id} capability executionRoutes must be dense; index ${index} is missing.`);
    const descriptor = Object.getOwnPropertyDescriptor(rawRoutes, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error(`Worker ${worker.id} capability execution route ${index} must be an own data property.`);
    const row = ownRecord(descriptor.value, `Worker ${worker.id} capability execution route ${index}`);
    exactOwnDataKeys(row, ["routeId", "projectionMode", "schemaSourceId", "toolNames", "basis"], `Worker ${worker.id} capability execution route ${index}`);
    const routeId = boundedId(ownValue(row, "routeId"), `Worker ${worker.id} execution route id`);
    if (routeIds.has(routeId)) throw new Error(`Worker ${worker.id} capability execution route id is duplicated: ${routeId}`);
    routeIds.add(routeId);
    const projectionMode = ownValue(row, "projectionMode");
    if (projectionMode !== "native-by-name" && projectionMode !== "external-schema") {
      throw new Error(`Worker ${worker.id} execution route ${routeId} has unsupported projection mode.`);
    }
    if (projectionMode === "native-by-name" && projection?.nativeByName !== true) {
      throw new Error(`Worker ${worker.id} execution route ${routeId} claims native-by-name while transport support is false.`);
    }
    if (projectionMode === "external-schema" && projection?.externalDefinitions !== true) {
      throw new Error(`Worker ${worker.id} execution route ${routeId} claims external-schema while transport support is false.`);
    }
    const schemaSourceId = boundedId(ownValue(row, "schemaSourceId"), `Worker ${worker.id} execution route ${routeId} schemaSourceId`);
    const rawToolNames = ownValue(row, "toolNames");
    if (!Array.isArray(rawToolNames) || rawToolNames.length === 0 || rawToolNames.length > MAX_ROUTE_TOOL_NAMES) {
      throw new Error(`Worker ${worker.id} execution route ${routeId} toolNames must be a non-empty bounded array.`);
    }
    const toolNames: string[] = [];
    for (let toolIndex = 0; toolIndex < rawToolNames.length; toolIndex += 1) {
      if (!Object.prototype.hasOwnProperty.call(rawToolNames, toolIndex)) throw new Error(`Worker ${worker.id} execution route ${routeId} toolNames must be dense.`);
      const toolDescriptor = Object.getOwnPropertyDescriptor(rawToolNames, String(toolIndex));
      if (!toolDescriptor || !("value" in toolDescriptor)) throw new Error(`Worker ${worker.id} execution route ${routeId} toolNames[${toolIndex}] must be an own data property.`);
      toolNames.push(boundedId(toolDescriptor.value, `Worker ${worker.id} execution route ${routeId} toolNames[${toolIndex}]`));
    }
    if (new Set(toolNames).size !== toolNames.length) throw new Error(`Worker ${worker.id} execution route ${routeId} contains duplicate tool names.`);
    const basisValue = ownValue(row, "basis");
    if (typeof basisValue !== "string" || !basisValue.trim() || basisValue.trim().length > MAX_ROUTE_BASIS_CHARS) {
      throw new Error(`Worker ${worker.id} execution route ${routeId} basis must be a non-empty bounded string.`);
    }
    routes.push({ routeId, projectionMode, schemaSourceId, toolNames, basis: basisValue.trim() });
  }
  return routes;
}

function routeForSchema(routes: readonly NormalizedExecutionRoute[], schema: NormalizedSchema): NormalizedExecutionRoute[] {
  return routes.filter(route => route.schemaSourceId === schema.sourceId && route.toolNames.includes(schema.toolName));
}

function schemaPayloadChars(schema: NormalizedSchema, mode: MissionCapabilityProjectionMode): number {
  return mode === "external-schema" ? stableJson(schema.definition).length : JSON.stringify(schema.toolName).length;
}

function classifyContinuationError(error: unknown): MissionCapabilityMaterializationErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  if (/finalizing/i.test(message)) return "finalizing-mission";
  if (/terminal|finalized|archived|completed/i.test(message)) return "terminal-mission";
  return "scope-mismatch";
}

/**
 * Phase 8 WO#2 read/derive owner. Visibility is not approval or execution.
 * This materializer owns no journal, grant, authorizer, executor, retry policy,
 * Worker selection, send path, or provider lifecycle.
 */
export class MissionCapabilityMaterializer {
  constructor(
    private readonly projects: ProjectStore,
    private readonly tasks: TaskRuntime,
    private readonly workers: WorkerSessionManager,
    private readonly schemaSources: readonly MissionCapabilitySchemaSource[],
  ) {}

  async materialize(input: MissionCapabilityMaterializationRequest): Promise<MissionCapabilityMaterializationResult> {
    let request: NormalizedRequest;
    try {
      request = normalizeRequest(input);
    } catch (error) {
      const inspector = baseInspector(input);
      this.fail("invalid-request", (error instanceof Error ? error.message : String(error)).slice(0, 1_000), inspector);
    }
    const inspector = inspectorForRequest(request);
    const { projectId, rootMissionId, missionId, managedSessionId } = request;

    await Promise.all([this.projects.initialize(), this.tasks.initialize()]);
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
    if (task.missionFinalization) this.fail("terminal-mission", `Mission ${missionId} is terminal and cannot receive capability context.`, inspector);
    try {
      await this.tasks.assertWorkerSessionContinuationAllowed(missionId, "materialize Mission capabilities");
    } catch (error) {
      this.fail(classifyContinuationError(error), error instanceof Error ? error.message : String(error), inspector);
    }

    const session = this.workers.getSession(managedSessionId);
    if (!session) {
      const retired = this.workers.getRetiredSession(managedSessionId);
      this.fail("session-mismatch", retired
        ? `Managed WorkerSession ${managedSessionId} is retired and cannot receive capability context.`
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

    const profile = resolveProfile(task.mission, request.constraints?.profile);
    inspector.profile = {
      name: profile,
      explicitProfile: request.constraints?.profile ?? "auto",
      missionPlane: task.mission.plane,
      missionType: task.mission.missionType,
    };
    let executionRoutes: NormalizedExecutionRoute[] = [];
    let routeValidationError: string | undefined;
    try {
      executionRoutes = normalizeExecutionRoutes(worker);
    } catch (error) {
      routeValidationError = (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
    }
    inspector.worker = {
      workerId: worker.id,
      kind: worker.kind,
      capabilityRequests: worker.capabilities.capabilityRequests,
      capabilityProjection: {
        nativeByName: worker.capabilityProjection?.nativeByName === true,
        externalDefinitions: worker.capabilityProjection?.externalDefinitions === true,
        executionRouteIds: executionRoutes.map(route => route.routeId),
        ...(routeValidationError === undefined ? {} : { routeValidationError }),
      },
    };

    let registry: ReturnType<typeof semanticRegistry>;
    try {
      registry = semanticRegistry();
    } catch (error) {
      this.fail("capability-incompatibility", error instanceof Error ? error.message : String(error), inspector, session.workerId);
    }
    const requiredIds = new Set(request.constraints?.requiredCapabilityIds ?? []);
    const optionalIds = new Set(request.constraints?.optionalCapabilityIds ?? []);
    const allowedIds = request.constraints?.allowedCapabilityIds === undefined
      ? undefined : new Set(request.constraints.allowedCapabilityIds);
    const candidatesById = new Map<string, SelectedCandidate>();

    for (const semantic of registry.ordered) {
      if (profileIncludes(semantic.metadata, profile) && (allowedIds === undefined || allowedIds.has(semantic.metadata.id))) {
        candidatesById.set(semantic.metadata.id, { semantic, required: false, selection: "profile" });
      }
    }
    for (const capabilityId of optionalIds) {
      const semantic = registry.byId.get(capabilityId);
      if (!semantic) {
        inspector.omissions.push({ capabilityId, reason: "unknown-capability-id", estimatedChars: 0, detail: "Optional semantic capability id is not registered; no concrete projection cost exists." });
        continue;
      }
      candidatesById.set(capabilityId, { semantic, required: false, selection: "explicit-optional" });
    }
    for (const capabilityId of requiredIds) {
      const semantic = registry.byId.get(capabilityId);
      if (!semantic) this.fail("capability-incompatibility", `Unknown required semantic capability id: ${capabilityId}`, inspector, session.workerId, capabilityId);
      candidatesById.set(capabilityId, { semantic, required: true, selection: "explicit-required" });
    }

    const snapshots = snapshotSchemaSources(this.schemaSources);
    const sourceErrors = snapshots.filter(source => source.error);
    const selected: Array<{ candidate: SelectedCandidate; schema: NormalizedSchema; route: NormalizedExecutionRoute; cost: number }> = [];
    const orderedCandidates = [...candidatesById.values()].sort((a, b) => Number(b.required) - Number(a.required)
      || (a.selection === "explicit-optional" ? 0 : 1) - (b.selection === "explicit-optional" ? 0 : 1)
      || a.semantic.metadata.id.localeCompare(b.semantic.metadata.id));

    for (const candidate of orderedCandidates) {
      const capabilityId = candidate.semantic.metadata.id;
      const toolName = candidate.semantic.toolName;
      const omitOrFail = (
        reason: MissionCapabilityOmission["reason"],
        detail: string,
        code: MissionCapabilityMaterializationErrorCode,
        estimatedChars = 0,
        schema?: NormalizedSchema,
      ): void => {
        if (candidate.required) this.fail(code, detail, inspector, session.workerId, capabilityId, toolName, schema);
        inspector.omissions.push({
          capabilityId,
          toolName,
          ...(schema === undefined ? {} : { schemaSourceId: schema.sourceId, schemaIdentity: schema.schemaIdentity }),
          reason,
          estimatedChars,
          detail,
        });
      };

      if (sourceErrors.length) {
        omitOrFail(
          "schema-source-unavailable",
          `Exact schema matching is unavailable because schema source ${sourceErrors[0].sourceId} is invalid: ${sourceErrors[0].error}`,
          "schema-incompatibility",
        );
        continue;
      }
      const matches = snapshots.flatMap(source => source.definitions).filter(schema => schema.toolName === toolName);
      if (!matches.length) {
        omitOrFail("schema-not-found", `No concrete schema matches registered tool ${toolName} for capability ${capabilityId}.`, "schema-incompatibility");
        continue;
      }
      if (matches.length !== 1) {
        omitOrFail("schema-ambiguous", `Multiple concrete schemas match registered tool ${toolName}: ${matches.map(match => match.sourceId).sort().join(", ")}.`, "schema-incompatibility");
        continue;
      }
      const schema = matches[0];
      if (schema.definition.name !== toolName) {
        omitOrFail("schema-drift", `Concrete schema name ${schema.definition.name} does not match registered tool ${toolName}.`, "schema-incompatibility");
        continue;
      }
      const matchingRoutes = routeValidationError === undefined ? routeForSchema(executionRoutes, schema) : [];
      if (matchingRoutes.length !== 1) {
        const detail = routeValidationError !== undefined
          ? `Exact Worker ${worker.id} capability route contract is invalid: ${routeValidationError}`
          : matchingRoutes.length === 0
            ? `Exact Worker ${worker.id} has no proven execution route for ${capabilityId}/${toolName} from schema source ${schema.sourceId}. Transport shape nativeByName=${worker.capabilityProjection?.nativeByName === true} externalDefinitions=${worker.capabilityProjection?.externalDefinitions === true}; capabilityRequests=${worker.capabilities.capabilityRequests} is not execution-route authority.`
            : `Exact Worker ${worker.id} has multiple execution routes for ${capabilityId}/${toolName} from schema source ${schema.sourceId}: ${matchingRoutes.map(route => route.routeId).sort().join(", ")}.`;
        omitOrFail(
          "worker-projection-unsupported",
          detail,
          "worker-incompatibility",
          stableJson(schema.definition).length,
          schema,
        );
        continue;
      }
      const route = matchingRoutes[0];
      const cost = schemaPayloadChars(schema, route.projectionMode);
      if (candidate.required && inspector.budget.usedSchemaChars + cost > request.budget.maxSchemaChars) {
        this.fail("budget-incompatibility", `Required capability schema ${capabilityId}/${toolName} cannot fit the hard schema budget.`, inspector, session.workerId, capabilityId, toolName);
      }
      if (!candidate.required && inspector.budget.usedSchemaChars + cost > request.budget.maxSchemaChars) {
        inspector.omissions.push({ capabilityId, toolName, reason: "schema-budget", estimatedChars: cost, detail: "Optional capability projection omitted by deterministic schema budget." });
        continue;
      }
      selected.push({ candidate, schema, route, cost });
      inspector.budget.usedSchemaChars += cost;
    }

    const catalog: MissionCapabilityCatalogEntry[] = [];
    const allowedCapabilities: string[] = [];
    const externalCapabilities: WorkerCapabilityDefinition[] = [];
    for (const selection of selected) {
      const { candidate, schema, route, cost } = selection;
      const selectionMode = route.projectionMode;
      catalog.push(catalogEntry(candidate.semantic));
      allowedCapabilities.push(candidate.semantic.toolName);
      if (selectionMode === "external-schema") externalCapabilities.push(structuredClone(schema.definition));
      inspector.mappings.push({
        capabilityId: candidate.semantic.metadata.id,
        version: candidate.semantic.metadata.version,
        toolName: candidate.semantic.toolName,
        required: candidate.required,
        selection: candidate.selection,
        schemaSourceId: schema.sourceId,
        schemaIdentity: schema.schemaIdentity,
        projectionMode: selectionMode,
        executionRouteId: route.routeId,
        routeBasis: route.basis,
        schemaPayloadChars: cost,
        approval: candidate.semantic.metadata.approval,
        grant: inspectCapabilityGrantVisibility(task, durableSession, candidate.semantic.metadata),
      });
    }
    inspector.selected = {
      capabilityIds: catalog.map(entry => entry.capabilityId).slice(0, MAX_INSPECTED_ITEMS),
      toolNames: allowedCapabilities.slice(0, MAX_INSPECTED_ITEMS),
    };
    inspector.omissions = inspector.omissions
      .sort((a, b) => a.capabilityId.localeCompare(b.capabilityId) || a.reason.localeCompare(b.reason))
      .slice(0, MAX_INSPECTED_ITEMS);
    inspector.mappings = inspector.mappings.slice(0, MAX_INSPECTED_ITEMS);
    inspector.budget.selectedCount = catalog.length;
    inspector.budget.omittedCount = inspector.omissions.length;

    try {
      await this.tasks.assertWorkerSessionContinuationAllowed(missionId, "finish Mission capability materialization");
    } catch (error) {
      this.fail(classifyContinuationError(error), error instanceof Error ? error.message : String(error), inspector, session.workerId);
    }

    return {
      version: 1,
      generatedAt: request.generatedAt ?? new Date().toISOString(),
      projectId,
      rootMissionId,
      missionId,
      managedSessionId,
      workerId: session.workerId,
      profile,
      catalog,
      allowedCapabilities,
      externalCapabilities,
      inspector,
    };
  }

  private validateLiveSession(session: ManagedWorkerSession, task: TaskSnapshot, inspector: MissionCapabilityInspector): void {
    if (session.taskId !== task.taskId) {
      this.fail("session-mismatch", `Managed WorkerSession ${session.managedSessionId} is bound to ${session.taskId ?? "no Task"}, not Mission ${task.taskId}.`, inspector, session.workerId);
    }
    if (session.state === "disposed") this.fail("session-mismatch", `Managed WorkerSession ${session.managedSessionId} is disposed.`, inspector, session.workerId);
  }

  private fail(
    code: MissionCapabilityMaterializationErrorCode,
    message: string,
    inspector: MissionCapabilityInspector,
    workerId?: string,
    capabilityId?: string,
    toolName?: string,
    schema?: NormalizedSchema,
  ): never {
    if (workerId) inspector.scope.workerId = workerId;
    inspector.incompatibility = {
      code,
      ...(capabilityId === undefined ? {} : { capabilityId }),
      ...(toolName === undefined ? {} : { toolName }),
      ...(schema === undefined ? {} : { schemaSourceId: schema.sourceId, schemaIdentity: schema.schemaIdentity }),
      reason: message.slice(0, 1_000),
    };
    throw new MissionCapabilityMaterializationError(code, inspector.incompatibility.reason, inspector);
  }
}
