import { randomUUID } from "node:crypto";
import type { MissionExchange } from "./mission-collaboration-contract.js";
import type { ProjectEvent } from "./project-contract.js";
import type { TaskEvent } from "./task-contract.js";

export type MissionObservationKind = "domain" | "operational" | "telemetry";

export type MissionObservationSourceOwner =
  | "project-store"
  | "task-runtime"
  | "mission-collaboration-store"
  | "worker-session-manager"
  | "browser-worker-runtime"
  | "conversation-lifecycle"
  | "capability-runtime"
  | "mission-coordinator"
  | "mission-finalization"
  | "parallel-orchestration"
  | "external";

const MISSION_OBSERVATION_SOURCE_OWNERS = new Set<MissionObservationSourceOwner>([
  "project-store",
  "task-runtime",
  "mission-collaboration-store",
  "worker-session-manager",
  "browser-worker-runtime",
  "conversation-lifecycle",
  "capability-runtime",
  "mission-coordinator",
  "mission-finalization",
  "parallel-orchestration",
  "external",
]);

export type MissionObservationScalar = string | number | boolean | null;
export type MissionObservationFact = MissionObservationScalar | readonly MissionObservationScalar[];

export interface MissionObservationScope {
  projectId: string;
  rootMissionId: string;
  missionId: string;
}

export interface MissionObservationSource {
  owner: MissionObservationSourceOwner;
  component: string;
  /** Canonical owner record/event/exchange identity. The observation never replaces this source record. */
  sourceRecordId?: string;
  sourceRecordType?: string;
}

export interface MissionObservationWorkerRef {
  managedSessionId?: string;
  workerId?: string;
  adapterSessionId?: string;
}

export interface MissionObservationEvent {
  version: 1;
  observationId: string;
  at: string;
  kind: MissionObservationKind;
  name: string;
  scope: MissionObservationScope;
  source: MissionObservationSource;
  causationId?: string;
  correlationId?: string;
  occurrenceId?: string;
  worker?: MissionObservationWorkerRef;
  /**
   * Bounded diagnostic facts only. Canonical owner payloads, provider prompts,
   * transcripts, reasoning and DOM/HTML snapshots must stay in their existing owners.
   */
  facts?: Readonly<Record<string, MissionObservationFact>>;
}

export interface CreateMissionObservationEventInput {
  observationId?: string;
  at?: string;
  kind: MissionObservationKind;
  name: string;
  scope: MissionObservationScope;
  source: MissionObservationSource;
  causationId?: string;
  correlationId?: string;
  occurrenceId?: string;
  worker?: MissionObservationWorkerRef;
  facts?: Readonly<Record<string, MissionObservationFact>>;
}

const EVENT_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;
const FACT_KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;
const FORBIDDEN_FACT_KEY = /(?:^|[._-])(prompt|transcript|reasoning|messages?|raw|html|dom)(?:$|[._-])/i;

function factKeyMayExposePrivateContent(key: string): boolean {
  const tokenized = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2");
  return FORBIDDEN_FACT_KEY.test(tokenized);
}

function boundedId(value: unknown, label: string, max = 240): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > max) throw new Error(`${label} exceeds ${max} characters.`);
  return normalized;
}

function optionalId(value: unknown, label: string, max = 240): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedId(value, label, max);
}

function timestamp(value: unknown, label: string): string {
  const raw = boundedId(value, label, 64);
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label} must be an ISO-compatible timestamp.`);
  return parsed.toISOString();
}

function normalizeScope(scope: MissionObservationScope): MissionObservationScope {
  return {
    projectId: boundedId(scope.projectId, "Mission observation projectId"),
    rootMissionId: boundedId(scope.rootMissionId, "Mission observation rootMissionId"),
    missionId: boundedId(scope.missionId, "Mission observation missionId"),
  };
}

function normalizeSource(source: MissionObservationSource): MissionObservationSource {
  if (!MISSION_OBSERVATION_SOURCE_OWNERS.has(source.owner)) {
    throw new Error(`Unsupported Mission observation source owner: ${String(source.owner)}`);
  }
  return {
    owner: source.owner,
    component: boundedId(source.component, "Mission observation source component", 160),
    sourceRecordId: optionalId(source.sourceRecordId, "Mission observation source record id"),
    sourceRecordType: optionalId(source.sourceRecordType, "Mission observation source record type", 160),
  };
}

function normalizeWorker(worker: MissionObservationWorkerRef | undefined): MissionObservationWorkerRef | undefined {
  if (!worker) return undefined;
  const normalized = {
    managedSessionId: optionalId(worker.managedSessionId, "Mission observation managedSessionId"),
    workerId: optionalId(worker.workerId, "Mission observation workerId"),
    adapterSessionId: optionalId(worker.adapterSessionId, "Mission observation adapterSessionId"),
  };
  if (!normalized.managedSessionId && !normalized.workerId && !normalized.adapterSessionId) return undefined;
  return normalized;
}

function normalizeScalar(value: MissionObservationScalar, label: string): MissionObservationScalar {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} number must be finite.`);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 2048) throw new Error(`${label} string exceeds 2048 characters.`);
    return value;
  }
  throw new Error(`${label} must be a primitive diagnostic scalar.`);
}

function normalizeFacts(facts: Readonly<Record<string, MissionObservationFact>> | undefined): Readonly<Record<string, MissionObservationFact>> | undefined {
  if (!facts) return undefined;
  const entries = Object.entries(facts);
  if (entries.length > 32) throw new Error("Mission observation facts exceed 32 keys.");
  const normalized: Record<string, MissionObservationFact> = {};
  for (const [key, value] of entries) {
    if (!FACT_KEY.test(key)) throw new Error(`Mission observation fact key is invalid: ${key}`);
    if (factKeyMayExposePrivateContent(key)) {
      throw new Error(`Mission observation fact key may expose provider/private content: ${key}`);
    }
    if (Array.isArray(value)) {
      if (value.length > 32) throw new Error(`Mission observation fact array exceeds 32 values: ${key}`);
      normalized[key] = value.map((entry, index) => normalizeScalar(entry, `Mission observation fact ${key}[${index}]`));
    } else {
      normalized[key] = normalizeScalar(value as MissionObservationScalar, `Mission observation fact ${key}`);
    }
  }
  return Object.freeze(normalized);
}

export function createMissionObservationEvent(
  input: CreateMissionObservationEventInput,
  options: { newId?: () => string } = {},
): MissionObservationEvent {
  if (input.kind !== "domain" && input.kind !== "operational" && input.kind !== "telemetry") {
    throw new Error(`Unsupported Mission observation kind: ${String(input.kind)}`);
  }
  const name = boundedId(input.name, "Mission observation name", 160);
  if (!EVENT_NAME.test(name)) throw new Error(`Mission observation name must be namespaced kebab-case: ${name}`);
  return {
    version: 1,
    observationId: boundedId(input.observationId ?? (options.newId ?? randomUUID)(), "Mission observation id"),
    at: timestamp(input.at ?? new Date().toISOString(), "Mission observation timestamp"),
    kind: input.kind,
    name,
    scope: normalizeScope(input.scope),
    source: normalizeSource(input.source),
    causationId: optionalId(input.causationId, "Mission observation causationId"),
    correlationId: optionalId(input.correlationId, "Mission observation correlationId"),
    occurrenceId: optionalId(input.occurrenceId, "Mission observation occurrenceId"),
    worker: normalizeWorker(input.worker),
    facts: normalizeFacts(input.facts),
  };
}

function taskEventName(type: TaskEvent["type"]): string {
  switch (type) {
    case "TaskCreated": return "mission.created";
    case "TaskMissionConfigured": return "mission.configured";
    case "TaskMissionFinalized": return "mission.finalized";
    case "TaskMissionArchived": return "mission.archived";
    case "TaskGoalUpdated": return "mission.goal-updated";
    case "TaskContextUpdated": return "mission.context-updated";
    case "TaskStatusChanged": return "mission.status-changed";
    case "TaskTodosUpdated": return "mission.todos-updated";
    case "TaskProgressUpdated": return "mission.progress-updated";
    case "TaskInteractionStarted": return "mission.interaction-started";
    case "TaskInteractionFinished": return "mission.interaction-finished";
    case "TaskWorkerAttached": return "worker.attached";
    case "TaskWorkerDetached": return "worker.detached";
    case "TaskWorkerRetired": return "worker.retired";
    case "TaskWorkerOrphanRetirementClassified": return "worker.orphan-retirement-classified";
    case "TaskCapabilityGranted": return "capability.granted";
    case "TaskCapabilityRevoked": return "capability.revoked";
    case "TaskInputAccessPolicyRecorded": return "capability.input-access-policy-recorded";
    case "TaskExecutionRequested": return "capability.execution-requested";
    case "TaskExecutionStarted": return "capability.execution-started";
    case "TaskExecutionDuplicateObserved": return "capability.execution-duplicate-observed";
    case "TaskExecutionFinished": return "capability.execution-finished";
    case "TaskExecutionResultPrepared": return "capability.result-prepared";
    case "TaskExecutionDelivered": return "capability.result-delivered";
    case "TaskExecutionDeliveryAbandoned": return "capability.result-delivery-abandoned";
    case "TaskArtifactProduced": return "artifact.produced";
  }
}

function projectEventName(type: ProjectEvent["type"]): string {
  switch (type) {
    case "ProjectCreated": return "project.created";
    case "ProjectProposalRecorded": return "project.proposal-recorded";
    case "ProjectProposalReplaced": return "project.proposal-replaced";
    case "ProjectProposalHumanConfirmed": return "project.proposal-human-confirmed";
    case "ProjectDecisionCommitted": return "project.decision-committed";
  }
}

function collaborationEventName(kind: MissionExchange["kind"]): string {
  switch (kind) {
    case "Finding": return "collaboration.finding-recorded";
    case "Problem": return "collaboration.problem-recorded";
    case "Evidence": return "collaboration.evidence-recorded";
    case "Answer": return "collaboration.answer-recorded";
    case "Handoff": return "collaboration.handoff-recorded";
  }
}

/** Project a canonical TaskRuntime event without copying its canonical payload. */
export function observeTaskRuntimeEvent(
  scope: MissionObservationScope,
  event: TaskEvent,
  options: { observationId?: string; newId?: () => string; correlationId?: string; causationId?: string } = {},
): MissionObservationEvent {
  if (event.taskId !== scope.missionId) throw new Error(`Task event ${event.eventId} does not belong to Mission ${scope.missionId}.`);
  return createMissionObservationEvent({
    observationId: options.observationId,
    at: event.at,
    kind: "domain",
    name: taskEventName(event.type),
    scope,
    source: { owner: "task-runtime", component: "TaskRuntime", sourceRecordId: event.eventId, sourceRecordType: event.type },
    correlationId: options.correlationId,
    causationId: options.causationId,
    facts: { ownerEventType: event.type },
  }, { newId: options.newId });
}

/** Project ProjectStore truth into a Mission-correlated observation without becoming Project truth. */
export function observeProjectEvent(
  scope: MissionObservationScope,
  event: ProjectEvent,
  options: { observationId?: string; newId?: () => string; correlationId?: string; causationId?: string } = {},
): MissionObservationEvent {
  if (event.projectId !== scope.projectId) throw new Error(`Project event ${event.eventId} does not belong to Project ${scope.projectId}.`);
  return createMissionObservationEvent({
    observationId: options.observationId,
    at: event.at,
    kind: "domain",
    name: projectEventName(event.type),
    scope,
    source: { owner: "project-store", component: "ProjectStore", sourceRecordId: event.eventId, sourceRecordType: event.type },
    correlationId: options.correlationId,
    causationId: options.causationId,
    facts: { ownerEventType: event.type },
  }, { newId: options.newId });
}

/** Project a durable Collaboration exchange from its source Mission; the exchange remains canonical in MissionCollaborationStore. */
export function observeMissionExchange(
  rootMissionId: string,
  exchange: MissionExchange,
  options: { observationId?: string; newId?: () => string; correlationId?: string; causationId?: string } = {},
): MissionObservationEvent {
  return createMissionObservationEvent({
    observationId: options.observationId,
    at: exchange.createdAt,
    kind: "domain",
    name: collaborationEventName(exchange.kind),
    scope: { projectId: exchange.projectId, rootMissionId, missionId: exchange.sourceMissionId },
    source: {
      owner: "mission-collaboration-store",
      component: "MissionCollaborationStore",
      sourceRecordId: exchange.exchangeId,
      sourceRecordType: exchange.kind,
    },
    correlationId: options.correlationId,
    causationId: options.causationId,
    facts: {
      exchangeKind: exchange.kind,
      ...(exchange.targetMissionId ? { targetMissionId: exchange.targetMissionId } : {}),
    },
  }, { newId: options.newId });
}
