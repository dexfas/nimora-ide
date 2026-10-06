import { createHash } from "node:crypto";
import type { RenderedContextHandoff } from "./context-handoff.js";
import type { MissionExchange } from "./mission-collaboration-contract.js";
import type { CompleteManagedScopeInstruction } from "./mission-coordinator-completion-service.js";
import type {
  EnsureMissionInstruction,
  MissionCoordinatorInspection,
  MissionCoordinatorScope,
  RoutePracticeProblemInstruction,
} from "./mission-coordinator-service.js";
import type { TaskSnapshot } from "./task-contract.js";
import type { WorkerInput } from "./worker-contract.js";
import type { ManagedWorkerSession } from "./worker-session-manager.js";
import {
  admitMissionWorkerInputMaterializationSpec,
  type MissionWorkerInputMaterializationSpec,
} from "./mission-worker-input-materialization-contract.js";

const DEFAULT_MAX_PROMPT_CHARS = 48_000;
const MAX_INPUT_ID_CHARS = 240;
const MAX_INSTRUCTION_CHARS = 24_000;
const MAX_INSTRUCTION_KIND_CHARS = 120;
const MAX_REFERENCE_IDS = 64;
const MAX_REFERENCE_ID_CHARS = 240;
const MAX_PARALLEL_DELIVERIES = 8;
const MAX_PARALLEL_INSTRUCTION_CHARS = 40_000;
const MAX_COORDINATOR_INSPECTION_REFERENCES = 64;

export type MissionCoordinatorSemanticCommand =
  | { kind: "inspectManagedScope"; arguments: MissionCoordinatorScope }
  | { kind: "ensureMission"; arguments: EnsureMissionInstruction }
  | { kind: "routePracticeProblem"; arguments: RoutePracticeProblemInstruction }
  | { kind: "deliverExplicitMissionInput"; arguments: DeliverExplicitMissionInputCommand }
  | { kind: "deliverParallelExplicitMissionInputs"; arguments: DeliverParallelExplicitMissionInputsCommand }
  | { kind: "deliverMissionExchange"; arguments: DeliverMissionExchangeCommand }
  | { kind: "deliverFeedbackContinuation"; arguments: DeliverFeedbackContinuationCommand }
  | { kind: "deliverCommittedDecision"; arguments: DeliverCommittedDecisionCommand }
  | { kind: "completeManagedScope"; arguments: CompleteManagedScopeInstruction };

export interface DeliverExplicitMissionInputCommand extends MissionCoordinatorScope {
  coordinationMissionId: string;
  targetMissionId: string;
  managedSessionId: string;
  inputId: string;
  instructionKind: string;
  instruction: string;
  referenceIds?: string[];
  contextHandoff?: RenderedContextHandoff;
  phase8Materialization?: MissionWorkerInputMaterializationSpec;
}

export interface DeliverParallelExplicitMissionInputsCommand extends MissionCoordinatorScope {
  coordinationMissionId: string;
  deliveries: DeliverExplicitMissionInputCommand[];
}

export interface DeliverMissionExchangeCommand extends MissionCoordinatorScope {
  coordinationMissionId: string;
  exchangeId: string;
  targetMissionId: string;
  managedSessionId: string;
  inputId: string;
  contextHandoff?: RenderedContextHandoff;
}

export interface DeliverFeedbackContinuationCommand extends MissionCoordinatorScope {
  coordinationMissionId: string;
  practiceMissionId: string;
  problemExchangeId: string;
  answerExchangeId: string;
  managedSessionId: string;
  inputId: string;
  contextHandoff?: RenderedContextHandoff;
  phase8Materialization?: MissionWorkerInputMaterializationSpec;
}

export interface DeliverCommittedDecisionCommand extends MissionCoordinatorScope {
  coordinationMissionId: string;
  decisionId: string;
  targetMissionId: string;
  managedSessionId: string;
  inputId: string;
  contextHandoff?: RenderedContextHandoff;
}

export interface ExplicitMissionInputInstruction extends MissionCoordinatorScope {
  coordinationMissionId: string;
  targetMissionId: string;
  instructionKind: string;
  instruction: string;
  referenceIds?: string[];
}

export interface MissionCoordinatorWorkerInputOptions extends MissionCoordinatorScope {
  coordinationMission: TaskSnapshot;
  session: ManagedWorkerSession;
  inspection: MissionCoordinatorInspection;
  command: MissionCoordinatorSemanticCommand;
  inputId: string;
  contextHandoff?: RenderedContextHandoff;
  maxPromptChars?: number;
}

export interface ExplicitMissionWorkerInputOptions {
  instruction: ExplicitMissionInputInstruction;
  targetMission: TaskSnapshot;
  session: ManagedWorkerSession;
  inputId: string;
  contextHandoff?: RenderedContextHandoff;
  maxPromptChars?: number;
}

export interface MissionExchangeWorkerInputOptions extends MissionCoordinatorScope {
  coordinationMissionId: string;
  exchange: MissionExchange;
  targetMission: TaskSnapshot;
  session: ManagedWorkerSession;
  inputId: string;
  contextHandoff?: RenderedContextHandoff;
  maxPromptChars?: number;
}

function boundedText(value: unknown, maxChars: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters.`);
  return normalized;
}

function boundedInputId(value: unknown): string {
  return boundedText(value, MAX_INPUT_ID_CHARS, "Worker input id");
}

function validateScope(scope: MissionCoordinatorScope, projectId: string, rootMissionId: string, label: string): void {
  if (scope.projectId !== projectId || scope.managedRootMissionId !== rootMissionId) {
    throw new Error(`${label} does not match the exact Project/managed-root scope.`);
  }
}

function commandRow(command: unknown): Record<string, unknown> {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    throw new Error("Coordinator semantic command must be an object.");
  }
  const prototype = Object.getPrototypeOf(command);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Coordinator semantic command must be a plain own-data record.");
  }
  return command as Record<string, unknown>;
}

function ownDataValue(row: Record<string, unknown>, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor)) throw new Error(`${label} must be an own data property.`);
  return descriptor.value;
}

function commandArgumentsRow(command: unknown): Record<string, unknown> {
  const row = commandRow(command);
  const args = ownDataValue(row, "arguments", "Coordinator semantic command arguments");
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Coordinator semantic command arguments must be an object.");
  }
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Coordinator semantic command arguments must be a plain own-data record.");
  }
  return args as Record<string, unknown>;
}

function exactKeys(row: Record<string, unknown>, required: readonly string[], optional: readonly string[], label: string): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Reflect.ownKeys(row)) {
    if (typeof key !== "string") throw new Error(`${label} has unsupported symbol field.`);
    if (!allowed.has(key)) throw new Error(`${label} has unsupported field: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label}.${key} must be an own data property.`);
  }
  for (const key of required) {
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor) throw new Error(`${label} is missing required field: ${key}`);
    if (!("value" in descriptor)) throw new Error(`${label}.${key} must be an own data property.`);
  }
}

type MissionCoordinatorSemanticCommandKind = MissionCoordinatorSemanticCommand["kind"];

function runtimeCommandKind(command: unknown): MissionCoordinatorSemanticCommandKind {
  const row = commandRow(command);
  const kind = ownDataValue(row, "kind", "Coordinator semantic command kind");
  switch (kind) {
    case "inspectManagedScope":
    case "ensureMission":
    case "routePracticeProblem":
    case "deliverExplicitMissionInput":
    case "deliverParallelExplicitMissionInputs":
    case "deliverMissionExchange":
    case "deliverFeedbackContinuation":
    case "deliverCommittedDecision":
    case "completeManagedScope":
      return kind;
    default:
      throw new Error(`Unsupported Coordinator semantic command kind: ${String(kind)}`);
  }
}

function validateActiveMission(task: TaskSnapshot, label: string): void {
  if (!task.mission) throw new Error(`${label} ${task.taskId} is not configured as a Mission.`);
  if (task.missionFinalization) throw new Error(`${label} ${task.taskId} is terminal and cannot receive live bridge work.`);
}

function validateSession(session: ManagedWorkerSession, taskId: string, label: string): void {
  if (session.taskId !== taskId) {
    throw new Error(`${label} WorkerSession ${session.managedSessionId} is bound to ${session.taskId ?? "no Task"}, not Mission ${taskId}.`);
  }
  if (session.state === "disposed") throw new Error(`${label} WorkerSession ${session.managedSessionId} is disposed.`);
}

function validateContextHandoff(
  handoff: RenderedContextHandoff,
  projectId: string,
  mission: TaskSnapshot,
  session: ManagedWorkerSession,
  label: string,
): void {
  const pkg = handoff.package;
  if (pkg.taskId !== mission.taskId || pkg.missionId !== mission.taskId) {
    throw new Error(`${label} Context Handoff belongs to a different Mission.`);
  }
  if (pkg.projectId !== projectId) throw new Error(`${label} Context Handoff belongs to a different Project.`);
  if (pkg.missionPlane && pkg.missionPlane !== mission.mission?.plane) throw new Error(`${label} Context Handoff Mission plane mismatch.`);
  if (pkg.missionType && pkg.missionType !== mission.mission?.missionType) throw new Error(`${label} Context Handoff Mission type mismatch.`);
  if (pkg.targetWorkerId && pkg.targetWorkerId !== session.workerId) {
    throw new Error(`${label} Context Handoff targets Worker ${pkg.targetWorkerId}, not ${session.workerId}.`);
  }
}

function commandCapabilityName(command: unknown): string {
  switch (runtimeCommandKind(command)) {
    case "inspectManagedScope": return "nimora.coordinator.inspectManagedScope";
    case "ensureMission": return "nimora.coordinator.ensureMission";
    case "routePracticeProblem": return "nimora.coordinator.routePracticeProblem";
    case "deliverExplicitMissionInput": return "nimora.coordinator.deliverExplicitMissionInput";
    case "deliverParallelExplicitMissionInputs": return "nimora.coordinator.deliverParallelExplicitMissionInputs";
    case "deliverMissionExchange": return "nimora.coordinator.deliverMissionExchange";
    case "deliverFeedbackContinuation": return "nimora.coordinator.deliverFeedbackContinuation";
    case "deliverCommittedDecision": return "nimora.coordinator.deliverCommittedDecision";
    case "completeManagedScope": return "nimora.coordinator.completeManagedScope";
  }
}

export function missionCoordinatorCommandCapabilityName(command: unknown): string {
  return commandCapabilityName(command);
}

function validateCommandScope(scope: MissionCoordinatorScope, coordinationMissionId: string, command: MissionCoordinatorSemanticCommand): void {
  const kind = runtimeCommandKind(command);
  const args = commandArgumentsRow(command);
  validateScope(args as unknown as MissionCoordinatorScope, scope.projectId, scope.managedRootMissionId, "Coordinator command");
  switch (kind) {
    case "deliverExplicitMissionInput":
      exactKeys(args, ["projectId", "managedRootMissionId", "coordinationMissionId", "targetMissionId", "managedSessionId", "inputId", "instructionKind", "instruction"], ["referenceIds", "contextHandoff", "phase8Materialization"], "deliverExplicitMissionInput command arguments");
      if (ownDataValue(args, "phase8Materialization", "deliverExplicitMissionInput phase8Materialization") !== undefined) {
        admitMissionWorkerInputMaterializationSpec(
          ownDataValue(args, "phase8Materialization", "deliverExplicitMissionInput phase8Materialization"),
          "deliverExplicitMissionInput phase8Materialization",
        );
      }
      break;
    case "deliverParallelExplicitMissionInputs": {
      exactKeys(args, ["projectId", "managedRootMissionId", "coordinationMissionId", "deliveries"], [], "deliverParallelExplicitMissionInputs command arguments");
      const rawDeliveries = ownDataValue(args, "deliveries", "deliverParallelExplicitMissionInputs deliveries");
      if (!Array.isArray(rawDeliveries) || rawDeliveries.length < 1 || rawDeliveries.length > MAX_PARALLEL_DELIVERIES) {
        throw new Error(`deliverParallelExplicitMissionInputs requires 1-${MAX_PARALLEL_DELIVERIES} deliveries.`);
      }
      const targetIds = new Set<string>();
      const sessionIds = new Set<string>();
      const inputIds = new Set<string>();
      let instructionChars = 0;
      for (const [index, delivery] of rawDeliveries.entries()) {
        const row = commandRow(delivery);
        validateCommandScope(scope, coordinationMissionId, {
          kind: "deliverExplicitMissionInput",
          arguments: row as unknown as DeliverExplicitMissionInputCommand,
        });
        const targetId = ownDataValue(row, "targetMissionId", `parallel delivery[${index}] targetMissionId`);
        const sessionId = ownDataValue(row, "managedSessionId", `parallel delivery[${index}] managedSessionId`);
        const inputId = ownDataValue(row, "inputId", `parallel delivery[${index}] inputId`);
        const instruction = ownDataValue(row, "instruction", `parallel delivery[${index}] instruction`);
        if (typeof targetId !== "string" || typeof sessionId !== "string" || typeof inputId !== "string" || typeof instruction !== "string") {
          throw new Error(`Parallel delivery ${index} has invalid identity/instruction fields.`);
        }
        if (targetIds.has(targetId) || sessionIds.has(sessionId) || inputIds.has(inputId)) {
          throw new Error("Parallel explicit deliveries require unique Mission, WorkerSession and input identities.");
        }
        targetIds.add(targetId);
        sessionIds.add(sessionId);
        inputIds.add(inputId);
        instructionChars += instruction.length;
      }
      if (instructionChars > MAX_PARALLEL_INSTRUCTION_CHARS) throw new Error("Parallel explicit deliveries exceed the bounded combined instruction budget.");
      break;
    }
    case "deliverMissionExchange":
      exactKeys(args, ["projectId", "managedRootMissionId", "coordinationMissionId", "exchangeId", "targetMissionId", "managedSessionId", "inputId"], ["contextHandoff"], "deliverMissionExchange command arguments");
      break;
    case "deliverFeedbackContinuation":
      exactKeys(args, ["projectId", "managedRootMissionId", "coordinationMissionId", "practiceMissionId", "problemExchangeId", "answerExchangeId", "managedSessionId", "inputId"], ["contextHandoff", "phase8Materialization"], "deliverFeedbackContinuation command arguments");
      if (ownDataValue(args, "phase8Materialization", "deliverFeedbackContinuation phase8Materialization") !== undefined) {
        admitMissionWorkerInputMaterializationSpec(
          ownDataValue(args, "phase8Materialization", "deliverFeedbackContinuation phase8Materialization"),
          "deliverFeedbackContinuation phase8Materialization",
        );
      }
      break;
    case "deliverCommittedDecision":
      exactKeys(args, ["projectId", "managedRootMissionId", "coordinationMissionId", "decisionId", "targetMissionId", "managedSessionId", "inputId"], ["contextHandoff"], "deliverCommittedDecision command arguments");
      break;
    case "completeManagedScope":
      exactKeys(args, ["projectId", "managedRootMissionId", "coordinationMissionId", "completionKey"], [], "completeManagedScope command arguments");
      break;
    default:
      return;
  }
  if (args.coordinationMissionId !== coordinationMissionId) {
    const commandLabel = kind === "completeManagedScope" ? "completion command" : "transport command";
    throw new Error(`Coordinator ${commandLabel} targets Coordination Mission ${String(args.coordinationMissionId)}, not ${coordinationMissionId}.`);
  }
}

function coordinatorInspectionProjection(inspection: MissionCoordinatorInspection, command: MissionCoordinatorSemanticCommand): unknown {
  const missionIds = new Set<string>([inspection.managedRootMissionId, inspection.coordinationMissionId]);
  const exchangeIds = new Set<string>();
  const args = commandArgumentsRow(command);
  const addMission = (value: unknown) => { if (typeof value === "string" && value) missionIds.add(value); };
  const addExchange = (value: unknown) => { if (typeof value === "string" && value) exchangeIds.add(value); };
  const addReferences = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const reference of value.slice(0, MAX_COORDINATOR_INSPECTION_REFERENCES)) addExchange(reference);
  };

  switch (runtimeCommandKind(command)) {
    case "ensureMission":
      addMission(ownDataValue(args, "parentMissionId", "ensureMission parentMissionId"));
      break;
    case "routePracticeProblem":
      addMission(ownDataValue(args, "practiceMissionId", "routePracticeProblem practiceMissionId"));
      addExchange(ownDataValue(args, "problemExchangeId", "routePracticeProblem problemExchangeId"));
      break;
    case "deliverExplicitMissionInput":
      addMission(ownDataValue(args, "targetMissionId", "deliverExplicitMissionInput targetMissionId"));
      addReferences(ownDataValue(args, "referenceIds", "deliverExplicitMissionInput referenceIds"));
      break;
    case "deliverParallelExplicitMissionInputs": {
      const deliveries = ownDataValue(args, "deliveries", "deliverParallelExplicitMissionInputs deliveries");
      if (Array.isArray(deliveries)) for (const delivery of deliveries) {
        const row = commandRow(delivery);
        addMission(ownDataValue(row, "targetMissionId", "parallel delivery targetMissionId"));
        addReferences(ownDataValue(row, "referenceIds", "parallel delivery referenceIds"));
      }
      break;
    }
    case "deliverMissionExchange":
      addMission(ownDataValue(args, "targetMissionId", "deliverMissionExchange targetMissionId"));
      addExchange(ownDataValue(args, "exchangeId", "deliverMissionExchange exchangeId"));
      break;
    case "deliverFeedbackContinuation":
      addMission(ownDataValue(args, "practiceMissionId", "deliverFeedbackContinuation practiceMissionId"));
      addExchange(ownDataValue(args, "problemExchangeId", "deliverFeedbackContinuation problemExchangeId"));
      addExchange(ownDataValue(args, "answerExchangeId", "deliverFeedbackContinuation answerExchangeId"));
      break;
    case "deliverCommittedDecision":
      addMission(ownDataValue(args, "targetMissionId", "deliverCommittedDecision targetMissionId"));
      break;
    case "inspectManagedScope":
    case "completeManagedScope":
      break;
  }

  const exchanges = inspection.exchanges.filter(exchange => exchangeIds.has(exchange.exchangeId));
  const retainedExchangeIds = new Set(exchanges.map(exchange => exchange.exchangeId));
  const relations = inspection.relations.filter(relation => !!relation.basisExchangeId && retainedExchangeIds.has(relation.basisExchangeId));
  for (const relation of relations) {
    missionIds.add(relation.sourceMissionId);
    missionIds.add(relation.targetMissionId);
  }
  return {
    version: inspection.version,
    projectId: inspection.projectId,
    managedRootMissionId: inspection.managedRootMissionId,
    coordinationMissionId: inspection.coordinationMissionId,
    counts: { missions: inspection.missions.length, relations: inspection.relations.length, exchanges: inspection.exchanges.length },
    missions: inspection.missions.filter(mission => missionIds.has(mission.missionId)),
    relations,
    exchanges,
  };
}

/**
 * Pure Phase 6 live-Worker renderer. Exactly one host-requested semantic
 * capability is exposed for the turn. Its provider-visible argument surface is
 * deliberately an exact empty invocation envelope: the Cognition-authored
 * semantic command stays in trusted host memory and is never reconstructed from
 * provider text. The live driver validates that envelope before invoking any
 * mutating owner with the original host command.
 */
export function buildMissionCoordinatorWorkerInput(options: MissionCoordinatorWorkerInputOptions): WorkerInput {
  const scope = { projectId: options.projectId, managedRootMissionId: options.managedRootMissionId };
  validateActiveMission(options.coordinationMission, "Coordinator Mission");
  const mission = options.coordinationMission.mission!;
  if (mission.projectId !== scope.projectId
    || mission.rootMissionId !== scope.managedRootMissionId
    || mission.plane !== "coordination"
    || options.inspection.projectId !== scope.projectId
    || options.inspection.managedRootMissionId !== scope.managedRootMissionId
    || options.inspection.coordinationMissionId !== options.coordinationMission.taskId) {
    throw new Error("Coordinator Worker input does not bind the exact Project/root/Coordination Mission.");
  }
  validateSession(options.session, options.coordinationMission.taskId, "Coordinator");
  validateCommandScope(scope, options.coordinationMission.taskId, options.command);
  if (options.contextHandoff) {
    validateContextHandoff(options.contextHandoff, scope.projectId, options.coordinationMission, options.session, "Coordinator");
  }

  const inputId = boundedInputId(options.inputId);
  const capabilityName = commandCapabilityName(options.command);
  const parts = [
    "# Nimora Explicit Coordinator Command\n",
    `Project: ${scope.projectId}\nManaged root Mission: ${scope.managedRootMissionId}\nCoordinator Mission: ${options.coordinationMission.taskId}\n\n`,
  ];
  if (options.contextHandoff) {
    parts.push("## Same-Mission Context Handoff\n", options.contextHandoff.text.trimEnd(), "\n\n");
  }
  parts.push(
    "## Fresh bounded managed-scope inspection\n",
    `${JSON.stringify(coordinatorInspectionProjection(options.inspection, options.command), null, 2)}\n\n`,
    "## Host-bound Cognition command\n",
    `Kind: ${options.command.kind}\nPayload SHA256: ${createHash("sha256").update(JSON.stringify(options.command)).digest("hex")}\n`,
    "The semantic payload is held by the trusted host. You must not reconstruct it.\n",
    `Call ${capabilityName} exactly once with the argument object {}. No project, mission, input, instruction or deliveries fields belong in this invocation.\n`,
  );
  const prompt = parts.join("");
  const maxPromptChars = Math.max(1, Math.floor(options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS));
  if (prompt.length > maxPromptChars) throw new Error(`Coordinator Worker input exceeds maxPromptChars (${prompt.length} > ${maxPromptChars}).`);

  return {
    inputId,
    prompt,
    allowedCapabilities: [capabilityName],
    externalCapabilities: [{
      name: capabilityName,
      description: "Invoke only the exact host-bound Coordinator semantic command for this turn. Arguments must be exactly the empty object; the trusted host retains all semantic command arguments.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false, const: {} },
    }],
    modeInstructions: "Authorize only the single explicit Coordinator command shown above. Call only the exposed capability, exactly once, with the exact empty object {}. Do not copy, reconstruct, summarize, normalize, or add semantic command arguments; the trusted host executes its pre-bound Cognition-authored command.",
    // Coordinator is a transport/execution bridge. Once its one exact
    // host-bound capability result is confirmed delivered, provider follow-up
    // prose has no semantic authority and must not keep the turn open.
    extensions: { terminalAfterHostCapabilityResult: true },
  };
}

function normalizeExplicitInstruction(input: ExplicitMissionInputInstruction): ExplicitMissionInputInstruction {
  const referenceIds = input.referenceIds ?? [];
  if (!Array.isArray(referenceIds) || referenceIds.length > MAX_REFERENCE_IDS) {
    throw new Error(`Explicit Mission input referenceIds must contain at most ${MAX_REFERENCE_IDS} items.`);
  }
  return {
    projectId: boundedText(input.projectId, MAX_REFERENCE_ID_CHARS, "Project id"),
    managedRootMissionId: boundedText(input.managedRootMissionId, MAX_REFERENCE_ID_CHARS, "Managed root Mission id"),
    coordinationMissionId: boundedText(input.coordinationMissionId, MAX_REFERENCE_ID_CHARS, "Coordination Mission id"),
    targetMissionId: boundedText(input.targetMissionId, MAX_REFERENCE_ID_CHARS, "Target Mission id"),
    instructionKind: boundedText(input.instructionKind, MAX_INSTRUCTION_KIND_CHARS, "Instruction kind"),
    instruction: boundedText(input.instruction, MAX_INSTRUCTION_CHARS, "Instruction"),
    referenceIds: referenceIds.map((value, index) => boundedText(value, MAX_REFERENCE_ID_CHARS, `Reference id ${index + 1}`)),
  };
}

/** Pure renderer for an already-authored Work Order/Mission input. */
export function buildExplicitMissionWorkerInput(options: ExplicitMissionWorkerInputOptions): WorkerInput {
  const instruction = normalizeExplicitInstruction(options.instruction);
  validateActiveMission(options.targetMission, "Target Mission");
  const mission = options.targetMission.mission!;
  if (options.targetMission.taskId !== instruction.targetMissionId
    || mission.projectId !== instruction.projectId
    || mission.rootMissionId !== instruction.managedRootMissionId) {
    throw new Error("Explicit Mission input target does not match the exact Project/root/Mission scope.");
  }
  validateSession(options.session, options.targetMission.taskId, "Target");
  if (options.contextHandoff) {
    validateContextHandoff(options.contextHandoff, instruction.projectId, options.targetMission, options.session, "Target");
  }
  const pkg = {
    version: 1,
    kind: "explicit-mission-input",
    ...instruction,
  };
  const parts = [
    "# Nimora Explicit Mission Input\n",
    `Project: ${instruction.projectId}\nManaged root Mission: ${instruction.managedRootMissionId}\nCoordinator Mission: ${instruction.coordinationMissionId}\nTarget Mission: ${instruction.targetMissionId}\n\n`,
  ];
  if (options.contextHandoff) parts.push("## Same-Mission Context Handoff\n", options.contextHandoff.text.trimEnd(), "\n\n");
  parts.push("## Cognition-authored bounded instruction\n", `${JSON.stringify(pkg, null, 2)}\n`);
  const prompt = parts.join("");
  const maxPromptChars = Math.max(1, Math.floor(options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS));
  if (prompt.length > maxPromptChars) throw new Error(`Explicit Mission Worker input exceeds maxPromptChars (${prompt.length} > ${maxPromptChars}).`);
  return { inputId: boundedInputId(options.inputId), prompt };
}

/** Pure renderer for one already-durable bounded collaboration fact. */
export function buildMissionExchangeWorkerInput(options: MissionExchangeWorkerInputOptions): WorkerInput {
  validateActiveMission(options.targetMission, "Exchange target Mission");
  const mission = options.targetMission.mission!;
  if (mission.projectId !== options.projectId || mission.rootMissionId !== options.managedRootMissionId) {
    throw new Error("Exchange delivery target is outside the exact Coordinator Project/root scope.");
  }
  if (options.exchange.projectId !== options.projectId) throw new Error("Mission exchange belongs to a different Project.");
  if (options.exchange.targetMissionId && options.exchange.targetMissionId !== options.targetMission.taskId) {
    throw new Error(`Mission exchange targets ${options.exchange.targetMissionId}, not supplied Mission ${options.targetMission.taskId}.`);
  }
  validateSession(options.session, options.targetMission.taskId, "Exchange target");
  if (options.contextHandoff) {
    validateContextHandoff(options.contextHandoff, options.projectId, options.targetMission, options.session, "Exchange target");
  }
  const pkg = {
    version: 1,
    kind: "mission-collaboration-fact",
    projectId: options.projectId,
    managedRootMissionId: options.managedRootMissionId,
    coordinationMissionId: options.coordinationMissionId,
    route: { targetMissionId: options.targetMission.taskId },
    exchange: structuredClone(options.exchange),
  };
  const parts = [
    "# Nimora Durable Mission Collaboration Fact\n",
    `Project: ${options.projectId}\nManaged root Mission: ${options.managedRootMissionId}\nTarget Mission: ${options.targetMission.taskId}\n\n`,
  ];
  if (options.contextHandoff) parts.push("## Same-Mission Context Handoff\n", options.contextHandoff.text.trimEnd(), "\n\n");
  parts.push("## Bounded durable fact\n", `${JSON.stringify(pkg, null, 2)}\n`);
  const prompt = parts.join("");
  const maxPromptChars = Math.max(1, Math.floor(options.maxPromptChars ?? DEFAULT_MAX_PROMPT_CHARS));
  if (prompt.length > maxPromptChars) throw new Error(`Mission exchange Worker input exceeds maxPromptChars (${prompt.length} > ${maxPromptChars}).`);
  return { inputId: boundedInputId(options.inputId), prompt };
}
