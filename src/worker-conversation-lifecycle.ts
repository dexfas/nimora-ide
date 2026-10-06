export type WorkerConversationCapacityState =
  | "normal"
  | "approaching-limit"
  | "rotation-required"
  | "exhausted"
  | "unknown";

export type WorkerConversationCapacitySource =
  | "nimora-session-budget"
  | "provider-explicit-limit"
  | "combined"
  | "unknown";

export interface WorkerConversationBudget {
  /** Nimora operational budget. This is deliberately not represented as a provider token limit. */
  approachingChars: number;
  rotationChars: number;
  approachingTurns: number;
  rotationTurns: number;
}

export interface WorkerConversationUsageObservation {
  /**
   * Characters admitted/observed by Nimora since this Worker conversation was attached.
   * Provider transcripts are not persisted as Project memory; this is an operational counter.
   */
  sessionObservedChars?: number;
  /** Number of Nimora turns admitted to this Worker conversation since attachment. */
  sessionTurnCount?: number;
  /**
   * Optional read-only floor from the currently visible provider conversation.
   * Virtualized DOMs can under-report history, so this value can only raise the observed floor.
   */
  providerVisibleCharsFloor?: number;
  /** Provider error/status text from a terminal or explicit capacity failure surface. */
  providerErrorText?: string;
}

export interface WorkerConversationCapacityObservation {
  version: 1;
  state: WorkerConversationCapacityState;
  source: WorkerConversationCapacitySource;
  checkedAt: string;
  budget: WorkerConversationBudget;
  observedChars: number;
  observedTurns: number;
  providerExplicitLimit: boolean;
  /**
   * This truthfully describes what the counters cover. It must never be interpreted
   * as an exact provider token count.
   */
  coverage: "since-session-attach" | "provider-visible-floor" | "combined" | "unknown";
  evidence: readonly string[];
}

export type WorkerConversationLifecycleAction =
  | "continue"
  | "prepare-handoff"
  | "wait-for-settlement"
  | "retire-worker"
  | "replace-worker"
  | "cleanup-retired-conversation"
  | "complete";

export interface WorkerConversationLifecycleDecisionInput {
  capacity: WorkerConversationCapacityObservation;
  /** Previous turn/execution/delivery boundaries are known settled; UNKNOWN must be false here. */
  knownSettled: boolean;
  handoffReady: boolean;
  replacementAttached: boolean;
  retired: boolean;
  providerCleanupComplete: boolean;
}

export interface WorkerConversationLifecycleDecision {
  version: 1;
  action: WorkerConversationLifecycleAction;
  reason: string;
  retryAuthorized: false;
}

export const DEFAULT_WORKER_CONVERSATION_BUDGET: WorkerConversationBudget = Object.freeze({
  // Conservative lifecycle policy, not a claim about any provider's real context window.
  approachingChars: 240_000,
  rotationChars: 320_000,
  approachingTurns: 48,
  rotationTurns: 64,
});

const PROVIDER_LIMIT_PATTERNS: readonly RegExp[] = [
  /maximum context (?:length|window).*(?:exceed|reach|full)/i,
  /context (?:length|window).*(?:exceed|reach|full|too long)/i,
  /conversation (?:is )?too long/i,
  /too many tokens/i,
  /prompt is too long/i,
  /input is too long/i,
  /上下文.{0,20}(?:已满|满了|超出|超过|过长|达到.{0,6}上限)/i,
  /(?:对话|聊天).{0,12}(?:过长|已满|达到.{0,6}上限)/i,
  /コンテキスト.{0,20}(?:上限|長すぎ|超え)/i,
  /会話.{0,12}(?:長すぎ|上限)/i,
];

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeBudget(input: Partial<WorkerConversationBudget> | undefined): WorkerConversationBudget {
  const fallback = DEFAULT_WORKER_CONVERSATION_BUDGET;
  const approachingChars = nonNegativeInteger(input?.approachingChars) || fallback.approachingChars;
  const rotationChars = nonNegativeInteger(input?.rotationChars) || fallback.rotationChars;
  const approachingTurns = nonNegativeInteger(input?.approachingTurns) || fallback.approachingTurns;
  const rotationTurns = nonNegativeInteger(input?.rotationTurns) || fallback.rotationTurns;
  if (rotationChars <= approachingChars) throw new Error("Worker conversation rotationChars must exceed approachingChars.");
  if (rotationTurns <= approachingTurns) throw new Error("Worker conversation rotationTurns must exceed approachingTurns.");
  return { approachingChars, rotationChars, approachingTurns, rotationTurns };
}

export function isExplicitProviderContextLimit(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  const bounded = value.slice(0, 20_000);
  return PROVIDER_LIMIT_PATTERNS.some(pattern => pattern.test(bounded));
}

export function classifyWorkerConversationCapacity(
  usage: WorkerConversationUsageObservation,
  options: {
    budget?: Partial<WorkerConversationBudget>;
    checkedAt?: string;
  } = {},
): WorkerConversationCapacityObservation {
  const budget = normalizeBudget(options.budget);
  const sessionChars = nonNegativeInteger(usage.sessionObservedChars);
  const visibleChars = nonNegativeInteger(usage.providerVisibleCharsFloor);
  const observedChars = Math.max(sessionChars, visibleChars);
  const observedTurns = nonNegativeInteger(usage.sessionTurnCount);
  const providerExplicitLimit = isExplicitProviderContextLimit(usage.providerErrorText);

  const hasSessionObservation = sessionChars > 0 || observedTurns > 0;
  const hasProviderFloor = visibleChars > 0;
  const coverage = hasSessionObservation && hasProviderFloor
    ? "combined"
    : hasSessionObservation
      ? "since-session-attach"
      : hasProviderFloor
        ? "provider-visible-floor"
        : "unknown";

  const evidence: string[] = [];
  let state: WorkerConversationCapacityState;
  let source: WorkerConversationCapacitySource;

  if (providerExplicitLimit) {
    state = "exhausted";
    source = hasSessionObservation || hasProviderFloor ? "combined" : "provider-explicit-limit";
    evidence.push("provider-explicit-context-limit");
  } else if (observedChars >= budget.rotationChars || observedTurns >= budget.rotationTurns) {
    state = "rotation-required";
    source = "nimora-session-budget";
    if (observedChars >= budget.rotationChars) evidence.push("nimora-rotation-char-budget");
    if (observedTurns >= budget.rotationTurns) evidence.push("nimora-rotation-turn-budget");
  } else if (observedChars >= budget.approachingChars || observedTurns >= budget.approachingTurns) {
    state = "approaching-limit";
    source = "nimora-session-budget";
    if (observedChars >= budget.approachingChars) evidence.push("nimora-approaching-char-budget");
    if (observedTurns >= budget.approachingTurns) evidence.push("nimora-approaching-turn-budget");
  } else if (coverage === "unknown") {
    state = "unknown";
    source = "unknown";
    evidence.push("no-capacity-observation");
  } else {
    state = "normal";
    source = "nimora-session-budget";
    evidence.push("below-nimora-lifecycle-budget");
  }

  return {
    version: 1,
    state,
    source,
    checkedAt: options.checkedAt ?? new Date().toISOString(),
    budget,
    observedChars,
    observedTurns,
    providerExplicitLimit,
    coverage,
    evidence,
  };
}

/**
 * Deterministic lifecycle gate. It deliberately does not decide Mission semantics.
 * Cognition still owns the Handoff/Plan; Coordinator/runtime may only execute the
 * already-authorized succession once the previous side-effect boundary is settled.
 */
export function decideWorkerConversationLifecycle(
  input: WorkerConversationLifecycleDecisionInput,
): WorkerConversationLifecycleDecision {
  const rotate = input.capacity.state === "rotation-required" || input.capacity.state === "exhausted";
  if (!rotate) {
    return {
      version: 1,
      action: input.capacity.state === "approaching-limit" ? "prepare-handoff" : "continue",
      reason: input.capacity.state === "approaching-limit"
        ? "Conversation is approaching the Nimora lifecycle budget; prepare a bounded Handoff while continuing current authorized work."
        : "Conversation capacity does not require succession.",
      retryAuthorized: false,
    };
  }

  if (!input.knownSettled) {
    return {
      version: 1,
      action: "wait-for-settlement",
      reason: "Conversation succession is required, but unresolved UNKNOWN/side-effect/delivery state must be reconciled before replacement.",
      retryAuthorized: false,
    };
  }
  if (!input.handoffReady) {
    return {
      version: 1,
      action: "prepare-handoff",
      reason: "Conversation succession is required and the previous boundary is settled; produce the bounded same-Mission Handoff before replacement.",
      retryAuthorized: false,
    };
  }
  if (!input.retired) {
    return {
      version: 1,
      action: "retire-worker",
      reason: "Capacity boundary is settled and Handoff is ready; retire the exhausted Worker through the canonical Worker lifecycle owner before replacement.",
      retryAuthorized: false,
    };
  }
  if (!input.replacementAttached) {
    return {
      version: 1,
      action: "replace-worker",
      reason: "The exhausted Worker is durably retired; attach a replacement Worker to the same Mission/responsibility and rematerialize fresh bounded context.",
      retryAuthorized: false,
    };
  }
  if (!input.providerCleanupComplete) {
    return {
      version: 1,
      action: "cleanup-retired-conversation",
      reason: "Nimora retirement is durable; provider-side archive/delete may now clean the redundant conversation without changing Mission truth.",
      retryAuthorized: false,
    };
  }
  return {
    version: 1,
    action: "complete",
    reason: "Same-Mission succession and provider conversation cleanup are complete.",
    retryAuthorized: false,
  };
}
