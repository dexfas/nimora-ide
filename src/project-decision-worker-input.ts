import type { RenderedContextHandoff } from "./context-handoff.js";
import type { ProjectDecisionChange, ProjectSnapshot } from "./project-contract.js";
import type { ProjectDecisionImpact } from "./project-decision-service.js";
import type { TaskSnapshot } from "./task-contract.js";
import type { WorkerInput } from "./worker-contract.js";
import type { ManagedWorkerSession } from "./worker-session-manager.js";

const DEFAULT_MAX_PROMPT_CHARS = 48_000;
const MAX_INPUT_ID_CHARS = 240;

export interface ProjectDecisionWorkerInputOptions {
  project: ProjectSnapshot;
  decision: ProjectDecisionChange;
  impact: ProjectDecisionImpact;
  mission: TaskSnapshot | undefined;
  session: ManagedWorkerSession | undefined;
  inputId: string;
  contextHandoff?: RenderedContextHandoff;
  maxPromptChars?: number;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`;
}

function boundedInputId(value: string): string {
  if (typeof value !== "string") throw new Error("Worker input id must be a string.");
  const normalized = value.trim();
  if (!normalized) throw new Error("Worker input id must not be empty.");
  if (normalized.length > MAX_INPUT_ID_CHARS) throw new Error(`Worker input id must be at most ${MAX_INPUT_ID_CHARS} characters.`);
  return normalized;
}

function validateCommitted(project: ProjectSnapshot, decision: ProjectDecisionChange): void {
  if (project.projectId !== decision.projectId) throw new Error("Committed Project Decision belongs to a different Project snapshot.");
  const durable = project.committedDecisions[decision.decisionId];
  if (!durable) throw new Error(`Project Decision is not Committed: ${decision.decisionId}`);
  if (stableJson(durable) !== stableJson(decision)) throw new Error(`Committed Project Decision content mismatch: ${decision.decisionId}`);
}

function validateMission(decision: ProjectDecisionChange, mission: TaskSnapshot | undefined): asserts mission is TaskSnapshot {
  if (!mission) throw new Error("Decision update target Mission does not exist.");
  if (!mission.mission) throw new Error(`Task ${mission.taskId} is not configured as a Mission.`);
  if (mission.mission.projectId !== decision.projectId) throw new Error(`Mission ${mission.taskId} belongs to a different Project.`);
  if (mission.missionFinalization) throw new Error(`Mission ${mission.taskId} is finalized and cannot receive a Project Decision update.`);
}

function validateImpact(decision: ProjectDecisionChange, impact: ProjectDecisionImpact, mission: TaskSnapshot): void {
  if (impact.version !== 1 || impact.projectId !== decision.projectId || impact.decisionId !== decision.decisionId
    || impact.proposalId !== decision.proposalId || impact.contentDigest !== decision.contentDigest
    || stableJson(impact.scope) !== stableJson(decision.content.scope)) throw new Error("Project Decision impact does not match the Committed Decision.");
  if (!impact.routeableMissionIds.includes(mission.taskId)) throw new Error(`Mission ${mission.taskId} is not an affected routeable Mission for Decision ${decision.decisionId}.`);
  if (decision.content.scope.kind === "missions" && !decision.content.scope.missionIds.includes(mission.taskId)) throw new Error(`Mission ${mission.taskId} is outside the explicit Decision scope.`);
}

function validateSession(mission: TaskSnapshot, session: ManagedWorkerSession | undefined): asserts session is ManagedWorkerSession {
  if (!session) throw new Error("Selected WorkerSession does not exist.");
  if (!session.taskId) throw new Error(`WorkerSession ${session.managedSessionId} is not bound to a Task/Mission.`);
  if (session.taskId !== mission.taskId) throw new Error(`WorkerSession ${session.managedSessionId} is bound to ${session.taskId}, not affected Mission ${mission.taskId}.`);
  if (session.state === "disposed") throw new Error(`WorkerSession ${session.managedSessionId} is disposed.`);
}

function validateHandoff(decision: ProjectDecisionChange, mission: TaskSnapshot, session: ManagedWorkerSession, handoff: RenderedContextHandoff): void {
  if (handoff.package.taskId !== mission.taskId || handoff.package.missionId !== mission.taskId) throw new Error("Context Handoff does not belong to the affected Mission.");
  if (handoff.package.projectId !== decision.projectId) throw new Error("Context Handoff belongs to a different Project.");
  if (handoff.package.targetWorkerId && handoff.package.targetWorkerId !== session.workerId) throw new Error(`Context Handoff targets Worker ${handoff.package.targetWorkerId}, not ${session.workerId}.`);
}

/** Pure/manual-host admission + renderer. Delivery remains an explicit WorkerSessionManager.send() action. */
export function buildProjectDecisionWorkerInput(options: ProjectDecisionWorkerInputOptions): WorkerInput {
  validateCommitted(options.project, options.decision);
  validateMission(options.decision, options.mission);
  validateImpact(options.decision, options.impact, options.mission);
  validateSession(options.mission, options.session);
  if (options.contextHandoff) validateHandoff(options.decision, options.mission, options.session, options.contextHandoff);

  const update = {
    version: 1,
    kind: "project-decision-update",
    projectId: options.decision.projectId,
    missionId: options.mission.taskId,
    decisionId: options.decision.decisionId,
    proposalId: options.decision.proposalId,
    contentDigest: options.decision.contentDigest,
    confirmationId: options.decision.confirmationId,
    committedAt: options.decision.committedAt,
    decision: structuredClone(options.decision.content),
  };
  const parts = ["# Nimora Committed Project Decision Update\n", `Project: ${options.decision.projectId}\n`, `Mission: ${options.mission.taskId}\n\n`];
  if (options.contextHandoff) parts.push("## Same-Mission Context Handoff\n", options.contextHandoff.text.trimEnd(), "\n\n");
  parts.push("## Committed Project Decision\n", `${JSON.stringify(update, null, 2)}\n`);
  const prompt = parts.join("");
  const maxPromptChars = Math.max(1, Math.floor(options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS));
  if (prompt.length > maxPromptChars) throw new Error(`Project Decision Worker input exceeds maxPromptChars (${prompt.length} > ${maxPromptChars}).`);
  return { inputId: boundedInputId(options.inputId), prompt };
}
