import { createHash } from "node:crypto";
import type { MissionPlane } from "./task-contract.js";

const MAX_ID_CHARS = 240;
const MAX_PROJECT_TITLE_CHARS = 500;
const MAX_PROJECT_GOAL_CHARS = 8_000;
const MAX_PROJECT_WORKSPACE_CHARS = 2_000;
const MAX_SUMMARY_CHARS = 8_000;
const MAX_RATIONALE_CHARS = 8_000;
const MAX_SCOPE_MISSIONS = 32;
const MAX_FORMATION_MISSION_TYPE_CHARS = 160;
const MAX_FORMATION_COMPLETION_CRITERIA = 32;
const MAX_FORMATION_COMPLETION_CRITERION_CHARS = 1_000;
const MAX_FORMATION_CONTEXT_SUMMARY_CHARS = 12_000;
const MAX_FORMATION_CONSTRAINTS = 64;
const MAX_FORMATION_CONSTRAINT_CHARS = 1_500;

export type ProjectDecisionKind = "decision" | "change";
export type ProjectDecisionScope = { kind: "project" } | { kind: "missions"; missionIds: string[] };

export type ProjectFormationAuthorizationKind = "clear-intent-cognition" | "human-confirmed";

export interface ProjectFormationProjectSeed {
  title?: string;
  goal: string;
  workspace?: string;
}

export interface ProjectFormationInitialRootSeed {
  goal: string;
  plane: MissionPlane;
  missionType: string;
  completionCriteria: string[];
  contextSummary?: string;
  constraints?: string[];
}

export interface ProjectFormationAuthorization {
  kind: ProjectFormationAuthorizationKind;
}

export interface ProjectFormationSemanticResult {
  project: ProjectFormationProjectSeed;
  initialRoot: ProjectFormationInitialRootSeed;
  authorization: ProjectFormationAuthorization;
}

/** Exact authorized pre-Project semantic result; never transcript/runtime identity. */
export interface ProjectFormationReceipt extends ProjectFormationSemanticResult {
  formationId: string;
  formationDigest: string;
}

export interface ProjectProposalContent {
  kind: ProjectDecisionKind;
  summary: string;
  rationale?: string;
  scope: ProjectDecisionScope;
}

export interface ProjectProposal {
  proposalId: string;
  contentDigest: string;
  content: ProjectProposalContent;
  proposedAt: string;
  supersededByProposalId?: string;
}

export interface ProjectHumanConfirmation {
  confirmationId: string;
  proposalId: string;
  contentDigest: string;
  confirmedAt: string;
}

export interface ProjectDecisionChange {
  decisionId: string;
  projectId: string;
  proposalId: string;
  contentDigest: string;
  confirmationId: string;
  content: ProjectProposalContent;
  committedAt: string;
}

export interface ProjectSnapshot {
  version: 1;
  projectId: string;
  title?: string;
  goal?: string;
  workspace?: string;
  formationReceipt?: ProjectFormationReceipt;
  proposals: Record<string, ProjectProposal>;
  humanConfirmations: Record<string, ProjectHumanConfirmation>;
  committedDecisions: Record<string, ProjectDecisionChange>;
  createdAt: string;
  updatedAt: string;
}

interface ProjectEventBase<T extends string, P> {
  version: 1;
  eventId: string;
  projectId: string;
  at: string;
  type: T;
  payload: P;
}

export type ProjectEvent =
  | ProjectEventBase<"ProjectCreated", { title?: string; goal?: string; workspace?: string; formationReceipt?: ProjectFormationReceipt }>
  | ProjectEventBase<"ProjectProposalRecorded", { proposal: ProjectProposal }>
  | ProjectEventBase<"ProjectProposalReplaced", { supersededProposalId: string; replacement: ProjectProposal }>
  | ProjectEventBase<"ProjectProposalHumanConfirmed", { confirmation: ProjectHumanConfirmation }>
  | ProjectEventBase<"ProjectDecisionCommitted", { decision: ProjectDecisionChange }>;

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(row)) if (!allowedSet.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
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

function ownDataValue(row: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function denseOwnDataArray(value: unknown, label: string, maxItems: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${label} must use the standard Array prototype.`);
  if (value.length > maxItems) throw new Error(`${label} must contain at most ${maxItems} items.`);
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label}[${index}] must be a dense own data property.`);
    result.push(descriptor.value);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length" || (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key) && Number(key) < value.length)) continue;
    throw new Error(`${label} has unsupported array field: ${String(key)}`);
  }
  return result;
}

function boundedText(value: unknown, maxChars: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters.`);
  return normalized;
}

function boundedExactContentText(value: unknown, maxChars: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  if (!value.trim()) throw new Error(`${label} must not be empty.`);
  if (value.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters.`);
  return value;
}

function boundedOptionalText(value: unknown, maxChars: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters.`);
  return normalized;
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(value).toISOString();
}

export function normalizeProjectGovernanceId(value: unknown, label: string): string {
  return boundedText(value, MAX_ID_CHARS, label);
}

export function normalizeProjectFormationId(value: unknown): string {
  return boundedText(value, MAX_ID_CHARS, "Project formation id");
}

function hasOwnDataKey(row: Record<string, unknown>, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  return !!descriptor && "value" in descriptor;
}

function normalizeFormationProject(value: unknown): ProjectFormationProjectSeed {
  const row = plainOwnRecord(value, "Project Formation project seed");
  exactOwnDataKeys(row, ["title", "goal", "workspace"], ["goal"], "Project Formation project seed");
  return {
    ...(hasOwnDataKey(row, "title") ? { title: boundedText(ownDataValue(row, "title"), MAX_PROJECT_TITLE_CHARS, "Project Formation title") } : {}),
    goal: boundedText(ownDataValue(row, "goal"), MAX_PROJECT_GOAL_CHARS, "Project Formation goal"),
    ...(hasOwnDataKey(row, "workspace") ? { workspace: boundedText(ownDataValue(row, "workspace"), MAX_PROJECT_WORKSPACE_CHARS, "Project Formation workspace") } : {}),
  };
}

function normalizeFormationRoot(value: unknown): ProjectFormationInitialRootSeed {
  const row = plainOwnRecord(value, "Project Formation initial root");
  exactOwnDataKeys(
    row,
    ["goal", "plane", "missionType", "completionCriteria", "contextSummary", "constraints"],
    ["goal", "plane", "missionType", "completionCriteria"],
    "Project Formation initial root",
  );
  const plane = ownDataValue(row, "plane");
  if (plane !== "coordination" && plane !== "cognition" && plane !== "practice") {
    throw new Error(`Unsupported Project Formation Mission plane: ${String(plane)}`);
  }
  const completionCriteria = denseOwnDataArray(
    ownDataValue(row, "completionCriteria"),
    "Project Formation completion criteria",
    MAX_FORMATION_COMPLETION_CRITERIA,
  );
  if (completionCriteria.length === 0) throw new Error("Project Formation completion criteria must contain at least one item.");
  const constraints = hasOwnDataKey(row, "constraints")
    ? denseOwnDataArray(ownDataValue(row, "constraints"), "Project Formation constraints", MAX_FORMATION_CONSTRAINTS)
      .map((constraint, index) => boundedText(constraint, MAX_FORMATION_CONSTRAINT_CHARS, `Project Formation constraint ${index + 1}`))
    : undefined;
  return {
    goal: boundedText(ownDataValue(row, "goal"), MAX_PROJECT_GOAL_CHARS, "Project Formation root goal"),
    plane,
    missionType: boundedText(ownDataValue(row, "missionType"), MAX_FORMATION_MISSION_TYPE_CHARS, "Project Formation Mission type"),
    completionCriteria: completionCriteria.map((criterion, index) => boundedText(
      criterion,
      MAX_FORMATION_COMPLETION_CRITERION_CHARS,
      `Project Formation completion criterion ${index + 1}`,
    )),
    ...(hasOwnDataKey(row, "contextSummary")
      ? { contextSummary: boundedText(ownDataValue(row, "contextSummary"), MAX_FORMATION_CONTEXT_SUMMARY_CHARS, "Project Formation context summary") }
      : {}),
    ...(constraints === undefined ? {} : { constraints }),
  };
}

function normalizeFormationAuthorization(value: unknown): ProjectFormationAuthorization {
  const row = plainOwnRecord(value, "Project Formation authorization");
  exactOwnDataKeys(row, ["kind"], ["kind"], "Project Formation authorization");
  const kind = ownDataValue(row, "kind");
  if (kind !== "clear-intent-cognition" && kind !== "human-confirmed") {
    throw new Error(`Unsupported Project Formation authorization kind: ${String(kind)}`);
  }
  return { kind };
}

function normalizeFormationSemanticParts(project: unknown, initialRoot: unknown, authorization: unknown): ProjectFormationSemanticResult {
  return {
    project: normalizeFormationProject(project),
    initialRoot: normalizeFormationRoot(initialRoot),
    authorization: normalizeFormationAuthorization(authorization),
  };
}

export function normalizeProjectFormationSemanticResult(value: unknown): ProjectFormationSemanticResult {
  const row = plainOwnRecord(value, "Project Formation semantic result");
  exactOwnDataKeys(row, ["project", "initialRoot", "authorization"], ["project", "initialRoot", "authorization"], "Project Formation semantic result");
  return normalizeFormationSemanticParts(
    ownDataValue(row, "project"),
    ownDataValue(row, "initialRoot"),
    ownDataValue(row, "authorization"),
  );
}

function digestNormalizedFormationSemanticResult(result: ProjectFormationSemanticResult): string {
  return `sha256:${createHash("sha256").update(stableJson(result)).digest("hex")}`;
}

/** formationId is deliberately excluded: it is operation identity, not content identity. */
export function projectFormationDigest(value: unknown): string {
  return digestNormalizedFormationSemanticResult(normalizeProjectFormationSemanticResult(value));
}

/** Build the exact receipt after authority has already been decided outside this core. */
export function buildProjectFormationReceipt(value: unknown): ProjectFormationReceipt {
  const row = plainOwnRecord(value, "Project Formation result");
  exactOwnDataKeys(
    row,
    ["formationId", "project", "initialRoot", "authorization"],
    ["formationId", "project", "initialRoot", "authorization"],
    "Project Formation result",
  );
  const semantics = normalizeFormationSemanticParts(
    ownDataValue(row, "project"),
    ownDataValue(row, "initialRoot"),
    ownDataValue(row, "authorization"),
  );
  return {
    formationId: normalizeProjectFormationId(ownDataValue(row, "formationId")),
    ...semantics,
    formationDigest: digestNormalizedFormationSemanticResult(semantics),
  };
}

export function normalizeProjectFormationReceipt(value: unknown): ProjectFormationReceipt {
  const row = plainOwnRecord(value, "Project Formation receipt");
  exactOwnDataKeys(
    row,
    ["formationId", "project", "initialRoot", "authorization", "formationDigest"],
    ["formationId", "project", "initialRoot", "authorization", "formationDigest"],
    "Project Formation receipt",
  );
  const semantics = normalizeFormationSemanticParts(
    ownDataValue(row, "project"),
    ownDataValue(row, "initialRoot"),
    ownDataValue(row, "authorization"),
  );
  const formationId = normalizeProjectFormationId(ownDataValue(row, "formationId"));
  const formationDigest = boundedText(ownDataValue(row, "formationDigest"), 80, "Project Formation digest");
  const expectedDigest = digestNormalizedFormationSemanticResult(semantics);
  if (!/^sha256:[0-9a-f]{64}$/.test(formationDigest) || formationDigest !== expectedDigest) {
    throw new Error(`Project Formation ${formationId} digest mismatch.`);
  }
  return { formationId, ...semantics, formationDigest };
}

export function normalizeProjectProposalContent(value: unknown): ProjectProposalContent {
  const row = objectValue(value, "Project Proposal content");
  exactKeys(row, ["kind", "summary", "rationale", "scope"], "Project Proposal content");
  if (row.kind !== "decision" && row.kind !== "change") throw new Error(`Unsupported Project Proposal kind: ${String(row.kind)}`);
  const scopeRow = objectValue(row.scope, "Project Proposal scope");
  let scope: ProjectDecisionScope;
  if (scopeRow.kind === "project") {
    exactKeys(scopeRow, ["kind"], "Project Proposal project scope");
    scope = { kind: "project" };
  } else if (scopeRow.kind === "missions") {
    exactKeys(scopeRow, ["kind", "missionIds"], "Project Proposal Mission scope");
    if (!Array.isArray(scopeRow.missionIds) || scopeRow.missionIds.length === 0) throw new Error("Project Proposal Mission scope must contain at least one Mission id.");
    if (scopeRow.missionIds.length > MAX_SCOPE_MISSIONS) throw new Error(`Project Proposal Mission scope must contain at most ${MAX_SCOPE_MISSIONS} Mission ids.`);
    const missionIds = scopeRow.missionIds.map((missionId, index) => normalizeProjectGovernanceId(missionId, `Project Proposal scope Mission id ${index + 1}`));
    if (new Set(missionIds).size !== missionIds.length) throw new Error("Project Proposal Mission scope must not contain duplicate Mission ids.");
    scope = { kind: "missions", missionIds };
  } else {
    throw new Error(`Unsupported Project Proposal scope kind: ${String(scopeRow.kind)}`);
  }
  return {
    kind: row.kind,
    summary: boundedExactContentText(row.summary, MAX_SUMMARY_CHARS, "Project Proposal summary"),
    ...(row.rationale === undefined ? {} : { rationale: boundedExactContentText(row.rationale, MAX_RATIONALE_CHARS, "Project Proposal rationale") }),
    scope,
  };
}

export function projectProposalContentDigest(content: ProjectProposalContent): string {
  return `sha256:${createHash("sha256").update(stableJson(normalizeProjectProposalContent(content))).digest("hex")}`;
}

export function projectCommittedDecisionId(projectId: string, proposalId: string, contentDigest: string): string {
  const digest = createHash("sha256")
    .update(`project-decision-v1\0${normalizeProjectGovernanceId(projectId, "Project id")}\0${normalizeProjectGovernanceId(proposalId, "Project Proposal id")}\0${boundedText(contentDigest, 160, "Project Proposal content digest")}`)
    .digest("hex");
  return `project-decision-v1:${digest}`;
}

function normalizedProposal(value: unknown): ProjectProposal {
  const proposal = objectValue(value, "Project Proposal");
  exactKeys(proposal, ["proposalId", "contentDigest", "content", "proposedAt", "supersededByProposalId"], "Project Proposal");
  const proposalId = normalizeProjectGovernanceId(proposal.proposalId, "Project Proposal id");
  const content = normalizeProjectProposalContent(proposal.content);
  const contentDigest = projectProposalContentDigest(content);
  if (proposal.contentDigest !== contentDigest) throw new Error(`Project Proposal ${proposalId} content digest mismatch.`);
  return {
    proposalId,
    contentDigest,
    content,
    proposedAt: isoTimestamp(proposal.proposedAt, "Project Proposal proposedAt"),
    ...(proposal.supersededByProposalId === undefined ? {} : { supersededByProposalId: normalizeProjectGovernanceId(proposal.supersededByProposalId, "Superseding Project Proposal id") }),
  };
}

function normalizedConfirmation(value: unknown): ProjectHumanConfirmation {
  const confirmation = objectValue(value, "Project Human Confirmation");
  exactKeys(confirmation, ["confirmationId", "proposalId", "contentDigest", "confirmedAt"], "Project Human Confirmation");
  return {
    confirmationId: normalizeProjectGovernanceId(confirmation.confirmationId, "Project Human Confirmation id"),
    proposalId: normalizeProjectGovernanceId(confirmation.proposalId, "Confirmed Project Proposal id"),
    contentDigest: boundedText(confirmation.contentDigest, 160, "Confirmed Project Proposal content digest"),
    confirmedAt: isoTimestamp(confirmation.confirmedAt, "Project Human Confirmation confirmedAt"),
  };
}

function normalizedDecision(value: unknown): ProjectDecisionChange {
  const decision = objectValue(value, "Committed Project Decision");
  exactKeys(decision, ["decisionId", "projectId", "proposalId", "contentDigest", "confirmationId", "content", "committedAt"], "Committed Project Decision");
  const projectId = normalizeProjectGovernanceId(decision.projectId, "Committed Project id");
  const proposalId = normalizeProjectGovernanceId(decision.proposalId, "Committed Project Proposal id");
  const content = normalizeProjectProposalContent(decision.content);
  const contentDigest = projectProposalContentDigest(content);
  if (decision.contentDigest !== contentDigest) throw new Error(`Committed Project Decision ${decision.decisionId} content digest mismatch.`);
  const decisionId = projectCommittedDecisionId(projectId, proposalId, contentDigest);
  if (decision.decisionId !== decisionId) throw new Error(`Committed Project Decision id mismatch: ${decision.decisionId}`);
  return {
    decisionId,
    projectId,
    proposalId,
    contentDigest,
    confirmationId: normalizeProjectGovernanceId(decision.confirmationId, "Committed Project Human Confirmation id"),
    content,
    committedAt: isoTimestamp(decision.committedAt, "Committed Project Decision committedAt"),
  };
}

/** Strict durable-journal boundary for authoritative Project governance rows. */
export function normalizeProjectEvent(value: unknown): ProjectEvent {
  const event = objectValue(value, "Project event");
  exactKeys(event, ["version", "eventId", "projectId", "at", "type", "payload"], "Project event");
  if (event.version !== 1) throw new Error(`Unsupported Project event version: ${String(event.version)}`);

  const eventId = normalizeProjectGovernanceId(event.eventId, "Project event id");
  const projectId = normalizeProjectGovernanceId(event.projectId, "Project id");
  const at = isoTimestamp(event.at, "Project event at");
  const payload = objectValue(event.payload, "Project event payload");

  if (event.type === "ProjectCreated") {
    exactKeys(payload, ["title", "goal", "workspace", "formationReceipt"], "ProjectCreated payload");
    const formationReceipt = payload.formationReceipt === undefined ? undefined : normalizeProjectFormationReceipt(payload.formationReceipt);
    const title = formationReceipt
      ? (payload.title === undefined ? undefined : boundedText(payload.title, MAX_PROJECT_TITLE_CHARS, "Project title"))
      : boundedOptionalText(payload.title, MAX_PROJECT_TITLE_CHARS, "Project title");
    const goal = formationReceipt
      ? boundedText(payload.goal, MAX_PROJECT_GOAL_CHARS, "Project goal")
      : boundedOptionalText(payload.goal, MAX_PROJECT_GOAL_CHARS, "Project goal");
    const workspace = formationReceipt
      ? (payload.workspace === undefined ? undefined : boundedText(payload.workspace, MAX_PROJECT_WORKSPACE_CHARS, "Project workspace"))
      : boundedOptionalText(payload.workspace, MAX_PROJECT_WORKSPACE_CHARS, "Project workspace");
    if (formationReceipt && (
      title !== formationReceipt.project.title
      || goal !== formationReceipt.project.goal
      || workspace !== formationReceipt.project.workspace
    )) {
      throw new Error(`ProjectCreated metadata does not match Formation receipt ${formationReceipt.formationId}.`);
    }
    return {
      version: 1,
      eventId,
      projectId,
      at,
      type: "ProjectCreated",
      payload: {
        ...(title === undefined ? {} : { title }),
        ...(goal === undefined ? {} : { goal }),
        ...(workspace === undefined ? {} : { workspace }),
        ...(formationReceipt === undefined ? {} : { formationReceipt }),
      },
    };
  }

  if (event.type === "ProjectProposalRecorded") {
    exactKeys(payload, ["proposal"], "ProjectProposalRecorded payload");
    return { version: 1, eventId, projectId, at, type: "ProjectProposalRecorded", payload: { proposal: normalizedProposal(payload.proposal) } };
  }

  if (event.type === "ProjectProposalReplaced") {
    exactKeys(payload, ["supersededProposalId", "replacement"], "ProjectProposalReplaced payload");
    return {
      version: 1,
      eventId,
      projectId,
      at,
      type: "ProjectProposalReplaced",
      payload: {
        supersededProposalId: normalizeProjectGovernanceId(payload.supersededProposalId, "Superseded Project Proposal id"),
        replacement: normalizedProposal(payload.replacement),
      },
    };
  }

  if (event.type === "ProjectProposalHumanConfirmed") {
    exactKeys(payload, ["confirmation"], "ProjectProposalHumanConfirmed payload");
    return { version: 1, eventId, projectId, at, type: "ProjectProposalHumanConfirmed", payload: { confirmation: normalizedConfirmation(payload.confirmation) } };
  }

  if (event.type === "ProjectDecisionCommitted") {
    exactKeys(payload, ["decision"], "ProjectDecisionCommitted payload");
    return { version: 1, eventId, projectId, at, type: "ProjectDecisionCommitted", payload: { decision: normalizedDecision(payload.decision) } };
  }

  throw new Error(`Unsupported Project event type: ${String(event.type)}`);
}

export function applyProjectEvent(snapshot: ProjectSnapshot | undefined, event: ProjectEvent): ProjectSnapshot {
  if (event.type === "ProjectCreated") {
    if (snapshot) throw new Error(`Project ${event.projectId} was created more than once.`);
    return {
      version: 1,
      projectId: event.projectId,
      title: event.payload.title,
      goal: event.payload.goal,
      workspace: event.payload.workspace,
      ...(event.payload.formationReceipt === undefined ? {} : { formationReceipt: normalizeProjectFormationReceipt(event.payload.formationReceipt) }),
      proposals: {},
      humanConfirmations: {},
      committedDecisions: {},
      createdAt: event.at,
      updatedAt: event.at,
    };
  }
  if (!snapshot) throw new Error(`Project governance event precedes ProjectCreated: ${event.projectId}`);
  if (snapshot.projectId !== event.projectId) throw new Error(`Project event ${event.eventId} targets the wrong Project.`);

  if (event.type === "ProjectProposalRecorded") {
    const proposal = normalizedProposal(event.payload.proposal);
    if (proposal.supersededByProposalId) throw new Error("New Project Proposal cannot already be superseded.");
    const current = snapshot.proposals[proposal.proposalId];
    if (current) {
      if (stableJson(current) === stableJson(proposal)) return snapshot;
      throw new Error(`Project Proposal identity collision: ${proposal.proposalId}`);
    }
    return { ...snapshot, proposals: { ...snapshot.proposals, [proposal.proposalId]: proposal }, updatedAt: event.at };
  }

  if (event.type === "ProjectProposalReplaced") {
    const oldId = normalizeProjectGovernanceId(event.payload.supersededProposalId, "Superseded Project Proposal id");
    const current = snapshot.proposals[oldId];
    if (!current) throw new Error(`Project Proposal does not exist: ${oldId}`);
    const replacement = normalizedProposal(event.payload.replacement);
    if (replacement.supersededByProposalId) throw new Error("Replacement Project Proposal cannot already be superseded.");
    if (replacement.proposalId === oldId) throw new Error("Replacement Project Proposal must use a new Proposal id.");
    if (Object.values(snapshot.committedDecisions).some(decision => decision.proposalId === oldId)) throw new Error(`Committed Project Proposal cannot be replaced: ${oldId}`);
    if (current.supersededByProposalId) {
      const installed = snapshot.proposals[current.supersededByProposalId];
      if (current.supersededByProposalId === replacement.proposalId && installed && stableJson(installed) === stableJson(replacement)) return snapshot;
      throw new Error(`Project Proposal ${oldId} was already superseded by ${current.supersededByProposalId}.`);
    }
    if (snapshot.proposals[replacement.proposalId]) throw new Error(`Project Proposal identity collision: ${replacement.proposalId}`);
    return { ...snapshot, proposals: { ...snapshot.proposals, [oldId]: { ...current, supersededByProposalId: replacement.proposalId }, [replacement.proposalId]: replacement }, updatedAt: event.at };
  }

  if (event.type === "ProjectProposalHumanConfirmed") {
    const confirmation = normalizedConfirmation(event.payload.confirmation);
    const proposal = snapshot.proposals[confirmation.proposalId];
    if (!proposal) throw new Error(`Project Proposal does not exist: ${confirmation.proposalId}`);
    if (proposal.supersededByProposalId) throw new Error(`Project Proposal ${confirmation.proposalId} is superseded and cannot be Human Confirmed.`);
    if (confirmation.contentDigest !== proposal.contentDigest) throw new Error(`Human Confirmation digest does not match Project Proposal ${confirmation.proposalId}.`);
    const current = snapshot.humanConfirmations[confirmation.proposalId];
    if (current) {
      if (stableJson(current) === stableJson(confirmation)) return snapshot;
      throw new Error(`Project Proposal ${confirmation.proposalId} already has different Human Confirmation evidence.`);
    }
    return { ...snapshot, humanConfirmations: { ...snapshot.humanConfirmations, [confirmation.proposalId]: confirmation }, updatedAt: event.at };
  }

  const decision = normalizedDecision(event.payload.decision);
  if (decision.projectId !== snapshot.projectId) throw new Error(`Committed Project Decision ${decision.decisionId} belongs to a different Project.`);
  const proposal = snapshot.proposals[decision.proposalId];
  if (!proposal) throw new Error(`Committed Project Proposal does not exist: ${decision.proposalId}`);
  if (proposal.supersededByProposalId) throw new Error(`Superseded Project Proposal cannot Commit: ${decision.proposalId}`);
  if (proposal.contentDigest !== decision.contentDigest || stableJson(proposal.content) !== stableJson(decision.content)) throw new Error(`Committed Project Decision does not match Proposal ${decision.proposalId}.`);
  const confirmation = snapshot.humanConfirmations[decision.proposalId];
  if (!confirmation || confirmation.confirmationId !== decision.confirmationId || confirmation.contentDigest !== decision.contentDigest) throw new Error(`Committed Project Decision lacks matching durable Human Confirmation for Proposal ${decision.proposalId}.`);
  const existingForProposal = Object.values(snapshot.committedDecisions).find(existing => existing.proposalId === decision.proposalId);
  if (existingForProposal) {
    if (stableJson(existingForProposal) === stableJson(decision)) return snapshot;
    throw new Error(`Project Proposal ${decision.proposalId} already has a different committed Decision.`);
  }
  const existing = snapshot.committedDecisions[decision.decisionId];
  if (existing) {
    if (stableJson(existing) === stableJson(decision)) return snapshot;
    throw new Error(`Project Decision identity collision: ${decision.decisionId}`);
  }
  return { ...snapshot, committedDecisions: { ...snapshot.committedDecisions, [decision.decisionId]: decision }, updatedAt: event.at };
}

export function replayProjectEvents(events: readonly ProjectEvent[]): ProjectSnapshot[] {
  const projects = new Map<string, ProjectSnapshot>();
  for (const event of events) projects.set(event.projectId, applyProjectEvent(projects.get(event.projectId), event));
  return [...projects.values()];
}
