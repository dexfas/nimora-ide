import type { RenderedContextHandoff } from "./context-handoff.js";
import type { PracticeFeedbackContinuationPackage } from "./mission-feedback-service.js";
import type { TaskSnapshot } from "./task-contract.js";
import type { WorkerInput } from "./worker-contract.js";
import type { ManagedWorkerSession } from "./worker-session-manager.js";

const DEFAULT_MAX_PROMPT_CHARS = 48_000;
const MAX_INPUT_ID_CHARS = 240;

export interface MissionFeedbackWorkerInputOptions {
  continuation: PracticeFeedbackContinuationPackage;
  practiceMission: TaskSnapshot;
  session: ManagedWorkerSession;
  inputId: string;
  contextHandoff?: RenderedContextHandoff;
  maxPromptChars?: number;
}

function boundedInputId(value: string): string {
  if (typeof value !== "string") throw new Error("Worker input id must be a string.");
  const normalized = value.trim();
  if (!normalized) throw new Error("Worker input id must not be empty.");
  if (normalized.length > MAX_INPUT_ID_CHARS) throw new Error(`Worker input id must be at most ${MAX_INPUT_ID_CHARS} characters.`);
  return normalized;
}

function validateContinuation(continuation: PracticeFeedbackContinuationPackage): void {
  if (continuation.kind !== "practice-feedback-continuation" || continuation.version !== 1) {
    throw new Error("Unsupported Practice feedback continuation package.");
  }
  if (continuation.route.targetMissionId !== continuation.practiceMissionId) {
    throw new Error("Practice feedback continuation route does not target its originating Practice Mission.");
  }
  if (continuation.problem.exchangeId !== continuation.problemExchangeId) {
    throw new Error("Practice feedback continuation Problem identity does not match problemExchangeId.");
  }
  if (continuation.answer.exchangeId !== continuation.answerExchangeId) {
    throw new Error("Practice feedback continuation Answer identity does not match answerExchangeId.");
  }
  if (continuation.answer.replyToExchangeId !== continuation.problemExchangeId) {
    throw new Error("Practice feedback continuation Answer replies to a different Problem.");
  }
  if (continuation.answer.sourceMissionId !== continuation.cognitionMissionId) {
    throw new Error("Practice feedback continuation Answer comes from a different Cognition Mission.");
  }
  const includedEvidence = new Set(continuation.evidence.map(evidence => evidence.exchangeId));
  for (const evidenceId of [...continuation.problem.evidenceExchangeIds, ...continuation.answer.evidenceExchangeIds]) {
    if (!includedEvidence.has(evidenceId)) throw new Error(`Practice feedback continuation is missing referenced Evidence: ${evidenceId}`);
  }
}

function validatePracticeMission(continuation: PracticeFeedbackContinuationPackage, practiceMission: TaskSnapshot): void {
  if (practiceMission.taskId !== continuation.practiceMissionId) {
    throw new Error(`Practice feedback continuation targets ${continuation.practiceMissionId}, not supplied Mission ${practiceMission.taskId}.`);
  }
  const mission = practiceMission.mission;
  if (!mission) throw new Error(`Task ${practiceMission.taskId} is not configured as a Mission.`);
  if (mission.projectId !== continuation.projectId) throw new Error(`Practice Mission ${practiceMission.taskId} belongs to a different Project.`);
  if (mission.plane !== "practice") throw new Error(`Feedback continuation target must be a Practice Mission: ${practiceMission.taskId}`);
  if (practiceMission.missionFinalization) {
    throw new Error(`Practice Mission ${practiceMission.taskId} is finalized and cannot receive feedback continuation work.`);
  }
}

function validateSession(continuation: PracticeFeedbackContinuationPackage, session: ManagedWorkerSession): void {
  if (!session.taskId) throw new Error(`WorkerSession ${session.managedSessionId} is not bound to a Task/Mission.`);
  if (session.taskId !== continuation.practiceMissionId) {
    throw new Error(`WorkerSession ${session.managedSessionId} is bound to ${session.taskId}, not Practice Mission ${continuation.practiceMissionId}.`);
  }
  if (session.state === "disposed") throw new Error(`WorkerSession ${session.managedSessionId} is disposed.`);
}

function validateContextHandoff(
  continuation: PracticeFeedbackContinuationPackage,
  practiceMission: TaskSnapshot,
  session: ManagedWorkerSession,
  contextHandoff: RenderedContextHandoff,
): void {
  const pkg = contextHandoff.package;
  if (pkg.taskId !== continuation.practiceMissionId || pkg.missionId !== continuation.practiceMissionId) {
    throw new Error("Context Handoff does not belong to the feedback continuation Practice Mission.");
  }
  if (pkg.projectId !== continuation.projectId) throw new Error("Context Handoff belongs to a different Project.");
  if (pkg.missionPlane !== "practice") throw new Error("Context Handoff is not for a Practice Mission.");
  if (pkg.missionType && pkg.missionType !== practiceMission.mission?.missionType) {
    throw new Error("Context Handoff Mission type does not match the current Practice Mission.");
  }
  if (pkg.targetWorkerId && pkg.targetWorkerId !== session.workerId) {
    throw new Error(`Context Handoff targets Worker ${pkg.targetWorkerId}, not ${session.workerId}.`);
  }
}

/**
 * Pure/manual-host Phase 4 admission + rendering seam. It does not select a
 * Worker, send anything, persist delivery state, or own Worker lifecycle. The
 * caller must still explicitly invoke WorkerSessionManager.send().
 */
export function buildMissionFeedbackWorkerInput(options: MissionFeedbackWorkerInputOptions): WorkerInput {
  validateContinuation(options.continuation);
  validatePracticeMission(options.continuation, options.practiceMission);
  validateSession(options.continuation, options.session);
  if (options.contextHandoff) validateContextHandoff(options.continuation, options.practiceMission, options.session, options.contextHandoff);

  const inputId = boundedInputId(options.inputId);
  const parts = [
    "# Nimora Practice Feedback Continuation\n",
    `Project: ${options.continuation.projectId}\n`,
    `Practice Mission: ${options.continuation.practiceMissionId}\n\n`,
  ];
  if (options.contextHandoff) {
    parts.push("## Same-Mission Context Handoff\n", options.contextHandoff.text.trimEnd(), "\n\n");
  }
  parts.push("## Cross-Mission Revised Cognition\n", `${JSON.stringify(options.continuation, null, 2)}\n`);
  const prompt = parts.join("");
  const maxPromptChars = Math.max(1, Math.floor(options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS));
  if (prompt.length > maxPromptChars) throw new Error(`Practice feedback Worker input exceeds maxPromptChars (${prompt.length} > ${maxPromptChars}).`);

  return { inputId, prompt };
}
