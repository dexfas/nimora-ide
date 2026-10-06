import type { MissionObservationFact } from "./mission-observation-event.js";

export type BrowserWorkerTransportState = "connected" | "reconnecting" | "lost" | "unknown";
export type BrowserWorkerPageState = "exact" | "drifted" | "missing" | "unknown";
export type BrowserWorkerConversationState = "exact" | "drifted" | "missing" | "unknown";
export type BrowserWorkerTurnState = "idle" | "admitted" | "running" | "tool-phase" | "terminal" | "unknown";
export type BrowserWorkerAuthState = "ready" | "challenge" | "expired" | "unknown";
export type BrowserWorkerCapabilityState = "exact" | "stale" | "unavailable" | "not-required" | "unknown";

export type BrowserWorkerOperationalState =
  | "ready"
  | "busy"
  | "waiting-human"
  | "recovering"
  | "connection-lost"
  | "page-drift"
  | "conversation-drift"
  | "capability-drift"
  | "settlement-unknown"
  | "unavailable"
  | "retired";

export type BrowserWorkerTurnSettlement = "settled" | "active" | "unknown";

export interface BrowserWorkerObservationInput {
  transport: BrowserWorkerTransportState;
  page: BrowserWorkerPageState;
  conversation: BrowserWorkerConversationState;
  turn: BrowserWorkerTurnState;
  auth: BrowserWorkerAuthState;
  capability: BrowserWorkerCapabilityState;
  retired?: boolean;
  checkedAt?: string;
}

export interface BrowserWorkerOperationalObservation {
  version: 1;
  checkedAt: string;
  state: BrowserWorkerOperationalState;
  transport: BrowserWorkerTransportState;
  page: BrowserWorkerPageState;
  conversation: BrowserWorkerConversationState;
  turn: BrowserWorkerTurnState;
  /** Browser/provider-turn settlement only. It is never capability/side-effect retry authority. */
  turnSettlement: BrowserWorkerTurnSettlement;
  auth: BrowserWorkerAuthState;
  capability: BrowserWorkerCapabilityState;
  evidence: readonly string[];
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${label} is invalid: ${String(value)}`);
  }
  return value as T;
}

function isoTimestamp(value: string | undefined): string {
  const raw = value ?? new Date().toISOString();
  const parsed = new Date(raw);
  if (!Number.isFinite(parsed.getTime())) throw new Error("Browser Worker observation checkedAt must be an ISO-compatible timestamp.");
  return parsed.toISOString();
}

function turnSettlement(turn: BrowserWorkerTurnState): BrowserWorkerTurnSettlement {
  if (turn === "idle" || turn === "terminal") return "settled";
  if (turn === "admitted" || turn === "running" || turn === "tool-phase") return "active";
  return "unknown";
}

/**
 * Provider-neutral operational derivation. This function observes runtime reality
 * only; it does not decide Mission semantics, replacement, retry or authority.
 */
export function deriveBrowserWorkerOperationalObservation(input: BrowserWorkerObservationInput): BrowserWorkerOperationalObservation {
  const transport = enumValue(input.transport, ["connected", "reconnecting", "lost", "unknown"] as const, "Browser Worker transport state");
  const page = enumValue(input.page, ["exact", "drifted", "missing", "unknown"] as const, "Browser Worker page state");
  const conversation = enumValue(input.conversation, ["exact", "drifted", "missing", "unknown"] as const, "Browser Worker conversation state");
  const turn = enumValue(input.turn, ["idle", "admitted", "running", "tool-phase", "terminal", "unknown"] as const, "Browser Worker turn state");
  const auth = enumValue(input.auth, ["ready", "challenge", "expired", "unknown"] as const, "Browser Worker auth state");
  const capability = enumValue(input.capability, ["exact", "stale", "unavailable", "not-required", "unknown"] as const, "Browser Worker capability state");
  const evidence: string[] = [];
  const settlement = turnSettlement(turn);
  let state: BrowserWorkerOperationalState;

  if (input.retired === true) {
    state = "retired";
    evidence.push("worker-retired");
  } else if (auth === "challenge" || auth === "expired") {
    state = "waiting-human";
    evidence.push(`auth-${auth}`);
  } else if (transport === "lost") {
    state = "connection-lost";
    evidence.push("transport-lost");
  } else if (transport === "reconnecting") {
    state = "recovering";
    evidence.push("transport-reconnecting");
  } else if (page === "drifted" || page === "missing") {
    state = "page-drift";
    evidence.push(`page-${page}`);
  } else if (conversation === "drifted" || conversation === "missing") {
    state = "conversation-drift";
    evidence.push(`conversation-${conversation}`);
  } else if (capability === "stale" || capability === "unavailable") {
    state = "capability-drift";
    evidence.push(`capability-${capability}`);
  } else if (turn === "unknown") {
    state = "settlement-unknown";
    evidence.push("turn-settlement-unknown");
  } else if (
    transport === "unknown"
    || page === "unknown"
    || conversation === "unknown"
    || auth === "unknown"
    || capability === "unknown"
  ) {
    state = "unavailable";
    evidence.push("observation-incomplete");
  } else if (turn === "admitted" || turn === "running" || turn === "tool-phase") {
    state = "busy";
    evidence.push(`turn-${turn}`);
  } else {
    state = "ready";
    evidence.push(`turn-${turn}`);
  }

  return {
    version: 1,
    checkedAt: isoTimestamp(input.checkedAt),
    state,
    transport,
    page,
    conversation,
    turn,
    turnSettlement: settlement,
    auth,
    capability,
    evidence,
  };
}

/** Safe bounded facts for the Mission observation protocol; no DOM, prompt or transcript is included. */
export function browserWorkerObservationFacts(observation: BrowserWorkerOperationalObservation): Readonly<Record<string, MissionObservationFact>> {
  return Object.freeze({
    operationalState: observation.state,
    transportState: observation.transport,
    pageState: observation.page,
    conversationState: observation.conversation,
    turnState: observation.turn,
    turnSettlement: observation.turnSettlement,
    authState: observation.auth,
    capabilityState: observation.capability,
    evidence: [...observation.evidence],
  });
}
