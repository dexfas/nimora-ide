import { createHash, randomUUID } from "node:crypto";
import type { MissionCollaborationStore } from "./mission-collaboration-store.js";
import type { MissionEvidenceReference } from "./mission-collaboration-contract.js";
import { normalizeCognitionMissionPlan, type MissionCognitionPlanService, type CognitionPlannedMission } from "./mission-cognition-plan.js";
import type { MissionCoordinatorLiveDriver, CoordinatorLiveTransportObservation } from "./mission-coordinator-live-driver.js";
import type { MissionCoordinatorService } from "./mission-coordinator-service.js";
import type { MissionFinalizationService } from "./mission-finalization-service.js";
import { missionEntryCapabilityMaterialization } from "./mission-user-entry-application.js";
import { capabilityRegistrySnapshot } from "./capability-registry.js";
import type { MissionParallelReadinessService } from "./mission-parallel-orchestration.js";
import type { TaskRuntime } from "./task-runtime.js";
import type { TaskSnapshot } from "./task-contract.js";
import type { WorkerSessionManager } from "./worker-session-manager.js";

const MAX_REPORT_TEXT = 64_000;
const MAX_REPORT_ITEMS = 16;
const MAX_DECISION_WORK_ORDERS = 8;
const MAX_AUTONOMY_ROUNDS = 8;
const MAX_COGNITION_DECISION_ATTEMPTS = 2;

function digest(prefix: string, parts: readonly string[]): string {
  return createHash("sha256").update(`${prefix}\0${parts.join("\0")}`).digest("hex");
}
function bounded(value: unknown, limit: number, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit) throw new Error(`Invalid ${name}.`);
  return value.trim();
}
function exactRecord(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !keys.includes(key))) throw new Error(`${name} has unsupported fields.`);
  return row;
}
function strictJson(text: string, name: string): unknown {
  const boundedText = bounded(text, MAX_REPORT_TEXT, name);
  // A single whole-reply code block preserves JSON escaping through providers
  // that render ordinary replies as Markdown. Never salvage a substring or
  // repair quotes; the same strict schema and authority checks apply below.
  const fence = /^```(?:json)?\r?\n([\s\S]*)\r?\n```$/.exec(boundedText);
  try { return JSON.parse(fence ? fence[1] : boundedText); }
  catch { throw new Error(`${name} must be exactly one valid JSON object, optionally inside one whole-reply json code block.`); }
}

const STRUCTURED_REPLY_ENCODING = "Return exactly one JSON object inside a single fenced json code block with no text outside it. Preserve literal JSON escaping for quotes, backslashes and newlines in strings. Use ordinary prose rather than embedding JSON arrays in descriptive strings. This wire encoding does not change the requested fields, scope or authority.";

export interface PracticeReportProblem {
  currentGoal: string;
  previousAssumption: string;
  observedReality: string;
  preciseQuestion: string;
  blocking: boolean;
}
export interface PracticeReport {
  version: 1;
  kind: "nimora-practice-report";
  summary: string;
  findings: string[];
  problems: PracticeReportProblem[];
  completionCandidate: boolean;
}
export interface CognitionWorkOrder {
  targetMissionId: string;
  instruction: string;
  requiredCapabilityIds: string[];
  allowedWorkspacePathPrefixes: string[];
}
export interface CognitionDecisionAnswer {
  problemExchangeId: string;
  answer: string;
  evidenceExchangeIds: string[];
  limitations?: string;
}
export interface CognitionDecision {
  version: 1;
  kind: "nimora-cognition-decision";
  summary: string;
  answers: CognitionDecisionAnswer[];
  workOrders: CognitionWorkOrder[];
  additionalMissions: CognitionPlannedMission[];
  finalizeMissionIds: string[];
  projectCompletionCandidate: boolean;
}

export interface MissionAutonomyScope {
  projectId: string;
  rootMissionId: string;
  coordinationMissionId: string;
}
export interface MissionAutonomyRound {
  round: number;
  cognitionInputId: string;
  decisionFindingExchangeId: string;
  decision: CognitionDecision;
  work: {
    missionId: string;
    targetInputId: string;
    transport: CoordinatorLiveTransportObservation;
    report?: PracticeReport;
    evidenceExchangeId?: string;
    findingExchangeIds: string[];
    problemExchangeIds: string[];
  }[];
}
export interface MissionAutonomyRunResult {
  version: 1;
  kind: "mission-autonomy-run";
  state: "quiescent" | "blocked" | "completion-candidate" | "round-limit";
  rounds: MissionAutonomyRound[];
  reason: string;
}

export function parsePracticeReport(raw: string): PracticeReport {
  const row = exactRecord(strictJson(raw, "Practice report"),
    ["version", "kind", "summary", "findings", "problems", "completionCandidate"], "Practice report");
  if (row.version !== 1 || row.kind !== "nimora-practice-report" || typeof row.completionCandidate !== "boolean") {
    throw new Error("Unsupported Practice report contract.");
  }
  if (!Array.isArray(row.findings) || row.findings.length > MAX_REPORT_ITEMS) throw new Error("Practice report findings are unbounded.");
  if (!Array.isArray(row.problems) || row.problems.length > MAX_REPORT_ITEMS) throw new Error("Practice report problems are unbounded.");
  return {
    version: 1,
    kind: "nimora-practice-report",
    summary: bounded(row.summary, 6_000, "Practice report summary"),
    findings: row.findings.map((value, index) => bounded(value, 6_000, `Practice finding ${index + 1}`)),
    problems: row.problems.map((value, index) => {
      const problem = exactRecord(value,
        ["currentGoal", "previousAssumption", "observedReality", "preciseQuestion", "blocking"],
        `Practice problem ${index + 1}`);
      if (typeof problem.blocking !== "boolean") throw new Error(`Practice problem ${index + 1} blocking must be boolean.`);
      return {
        currentGoal: bounded(problem.currentGoal, 6_000, "Practice problem currentGoal"),
        previousAssumption: bounded(problem.previousAssumption, 6_000, "Practice problem previousAssumption"),
        observedReality: bounded(problem.observedReality, 8_000, "Practice problem observedReality"),
        preciseQuestion: bounded(problem.preciseQuestion, 6_000, "Practice problem preciseQuestion"),
        blocking: problem.blocking,
      };
    }),
    completionCandidate: row.completionCandidate,
  };
}

export function parseCognitionDecision(raw: string): CognitionDecision {
  const row = exactRecord(strictJson(raw, "Cognition decision"),
    ["version", "kind", "summary", "answers", "workOrders", "additionalMissions", "finalizeMissionIds", "projectCompletionCandidate"],
    "Cognition decision");
  if (row.version !== 1 || row.kind !== "nimora-cognition-decision" || typeof row.projectCompletionCandidate !== "boolean") {
    throw new Error("Unsupported Cognition decision contract.");
  }
  if (!Array.isArray(row.answers) || row.answers.length > MAX_REPORT_ITEMS) throw new Error("Cognition answers are unbounded.");
  if (!Array.isArray(row.workOrders) || row.workOrders.length > MAX_DECISION_WORK_ORDERS) throw new Error("Cognition Work Orders are unbounded.");
  if (!Array.isArray(row.finalizeMissionIds) || row.finalizeMissionIds.length > MAX_REPORT_ITEMS) throw new Error("Cognition finalization list is unbounded.");
  const additionalMissions = normalizeCognitionMissionPlan(row.additionalMissions);
  const seenAnswers = new Set<string>();
  const seenTargets = new Set<string>();
  return {
    version: 1,
    kind: "nimora-cognition-decision",
    summary: bounded(row.summary, 6_000, "Cognition decision summary"),
    answers: row.answers.map((value, index) => {
      const answer = exactRecord(value, ["problemExchangeId", "answer", "evidenceExchangeIds", "limitations"], `Cognition answer ${index + 1}`);
      if (!Array.isArray(answer.evidenceExchangeIds) || answer.evidenceExchangeIds.length > 32) throw new Error("Cognition answer evidence ids are unbounded.");
      const problemExchangeId = bounded(answer.problemExchangeId, 240, "Problem exchange id");
      if (seenAnswers.has(problemExchangeId)) throw new Error("Cognition decision cannot answer the same Problem twice.");
      seenAnswers.add(problemExchangeId);
      return {
        problemExchangeId,
        answer: bounded(answer.answer, 8_000, "Cognition answer"),
        evidenceExchangeIds: answer.evidenceExchangeIds.map((id, i) => bounded(id, 240, `Answer evidence id ${i + 1}`)),
        ...(answer.limitations === undefined ? {} : { limitations: bounded(answer.limitations, 2_000, "Answer limitations") }),
      };
    }),
    workOrders: row.workOrders.map((value, index) => {
      const order = exactRecord(value, ["targetMissionId", "instruction", "requiredCapabilityIds", "allowedWorkspacePathPrefixes"], `Work Order ${index + 1}`);
      if (!Array.isArray(order.requiredCapabilityIds) || order.requiredCapabilityIds.length > 32) throw new Error("Work Order capability ids are unbounded.");
      if (!Array.isArray(order.allowedWorkspacePathPrefixes) || order.allowedWorkspacePathPrefixes.length === 0 || order.allowedWorkspacePathPrefixes.length > 64) {
        throw new Error("Work Order workspace path prefixes are missing or unbounded.");
      }
      const targetMissionId = bounded(order.targetMissionId, 240, "Work Order target");
      if (seenTargets.has(targetMissionId)) throw new Error("Cognition decision can issue at most one Work Order per Mission in a round.");
      seenTargets.add(targetMissionId);
      return {
        targetMissionId,
        instruction: bounded(order.instruction, 24_000, "Work Order instruction"),
        requiredCapabilityIds: order.requiredCapabilityIds.map((id, i) => bounded(id, 160, `Work Order capability id ${i + 1}`)),
        allowedWorkspacePathPrefixes: order.allowedWorkspacePathPrefixes.map((path, i) => bounded(path, 512, `Work Order workspace path ${i + 1}`)),
      };
    }),
    additionalMissions,
    finalizeMissionIds: (() => {
      const ids = row.finalizeMissionIds.map((id, index) => bounded(id, 240, `finalizeMissionIds[${index}]`));
      if (new Set(ids).size !== ids.length) throw new Error("Cognition finalization list contains duplicates.");
      return ids;
    })(),
    projectCompletionCandidate: row.projectCompletionCandidate,
  };
}

export class MissionAutonomyLoopService {
  constructor(
    private readonly tasks: TaskRuntime,
    private readonly collaboration: MissionCollaborationStore,
    private readonly workers: WorkerSessionManager,
    private readonly coordinator: MissionCoordinatorService,
    private readonly liveDriver: MissionCoordinatorLiveDriver,
    private readonly plannedWork: MissionCognitionPlanService,
    private readonly readiness: MissionParallelReadinessService,
    private readonly finalization: MissionFinalizationService,
  ) {}

  async run(scope: MissionAutonomyScope, options: {
    maxRounds?: number;
    maxParallel?: 1 | 2;
    ensureAssigned?: (missionIds: readonly string[]) => Promise<void>;
    ensureConversation?: (missionId: string) => Promise<void>;
  } = {}): Promise<MissionAutonomyRunResult> {
    const parallel = options.maxParallel ?? 2;
    if (parallel !== 1 && parallel !== 2) throw new Error("Autonomy parallel bound must be one or two.");
    await Promise.all([this.tasks.initialize(), this.collaboration.initialize()]);
    const maxRounds = Math.min(MAX_AUTONOMY_ROUNDS, Math.max(1, Math.floor(options.maxRounds ?? MAX_AUTONOMY_ROUNDS)));
    const rounds: MissionAutonomyRound[] = [];
    for (let round = 1; round <= maxRounds; round += 1) {
      const inspection = await this.coordinator.inspectManagedScope({
        projectId: scope.projectId, managedRootMissionId: scope.rootMissionId,
      });
      if (inspection.coordinationMissionId !== scope.coordinationMissionId) {
        throw new Error("Autonomy scope does not match the canonical Coordinator Mission.");
      }
      const root = this.requireMission(scope.rootMissionId, scope);
      if (root.mission!.plane !== "cognition") throw new Error("Autonomy loop requires a continuing Cognition root.");
      let cognitionInputId = "";
      let decision: CognitionDecision | undefined;
      let validationError = "";
      for (let attempt = 0; attempt < MAX_COGNITION_DECISION_ATTEMPTS; attempt += 1) {
        await options.ensureConversation?.(scope.coordinationMissionId);
        await options.ensureConversation?.(scope.rootMissionId);
        const rootSessionId = await this.requireSettledUniqueSession(root.taskId);
        const coordinatorSessionId = await this.requireSettledUniqueSession(scope.coordinationMissionId);
        cognitionInputId = randomUUID();
        let cognitionText = "";
        const correction = attempt > 0;
        const decisionTurn = await this.liveDriver.executeCoordinatorCommandTurn({
          projectId: scope.projectId,
          managedRootMissionId: scope.rootMissionId,
          coordinationMissionId: scope.coordinationMissionId,
          managedSessionId: coordinatorSessionId,
          inputId: randomUUID(),
          command: {
            kind: "deliverExplicitMissionInput",
            arguments: {
              projectId: scope.projectId,
              managedRootMissionId: scope.rootMissionId,
              coordinationMissionId: scope.coordinationMissionId,
              targetMissionId: scope.rootMissionId,
              managedSessionId: rootSessionId,
              inputId: cognitionInputId,
              instructionKind: correction ? "autonomy-cognition-correction" : "autonomy-cognition-review",
              instruction: correction
                ? this.cognitionCorrectionPrompt(scope, validationError)
                : this.cognitionReviewPrompt(scope),
            },
          },
        }, undefined, undefined, (text, targetMissionId) => {
          if (targetMissionId === scope.rootMissionId) cognitionText = text;
        });
        const decisionTransport = decisionTurn.commandResult as CoordinatorLiveTransportObservation;
        if (decisionTransport.terminalStatus !== "completed") {
          return { version: 1, kind: "mission-autonomy-run", state: "blocked", rounds,
            reason: `Cognition ${correction ? "correction" : "review"} did not complete: ${decisionTransport.terminalError ?? decisionTransport.terminalStatus}` };
        }
        try {
          const candidate = parseCognitionDecision(cognitionText);
          this.preflightDecision(scope, candidate);
          decision = candidate;
          validationError = "";
          break;
        } catch (error) {
          validationError = error instanceof Error ? error.message : String(error);
          if (attempt + 1 >= MAX_COGNITION_DECISION_ATTEMPTS) {
            return { version: 1, kind: "mission-autonomy-run", state: "blocked", rounds,
              reason: `Cognition decision remained invalid after one bounded correction: ${validationError}` };
          }
        }
      }
      if (!decision) {
        return { version: 1, kind: "mission-autonomy-run", state: "blocked", rounds,
          reason: `Cognition decision validation did not converge: ${validationError || "unknown validation failure"}` };
      }
      const decisionFindingExchangeId = await this.persistCognitionDecision(scope, cognitionInputId, decision);
      if (decision.additionalMissions.length) {
        await this.plannedWork.establish({
          projectId: scope.projectId,
          rootMissionId: scope.rootMissionId,
          planKey: `autonomy:${cognitionInputId}`,
          additionalMissions: decision.additionalMissions,
        });
      }
      for (const missionId of decision.finalizeMissionIds) await this.finalizeCognitionAuthorizedMission(scope, missionId);
      if (!decision.workOrders.length) {
        rounds.push({ round, cognitionInputId, decisionFindingExchangeId, decision, work: [] });
        // A later root can start with no Practice children. Their canonical ids
        // exist only after establishment; ask Cognition for a new decision with
        // those ids in the next bounded round, without replaying this decision.
        if (decision.additionalMissions.length && !decision.projectCompletionCandidate) continue;
        return {
          version: 1, kind: "mission-autonomy-run",
          state: decision.projectCompletionCandidate ? "completion-candidate" : "quiescent",
          rounds,
          reason: decision.projectCompletionCandidate
            ? "Owning Cognition proposes Project completion; use the canonical completion preflight/finalization path."
            : "Owning Cognition emitted no further Work Orders.",
        };
      }

      await options.ensureConversation?.(scope.coordinationMissionId);
      const workCoordinatorSessionId = await this.requireSettledUniqueSession(scope.coordinationMissionId);
      const work: MissionAutonomyRound["work"] = [];
      for (let offset = 0; offset < decision.workOrders.length; offset += parallel) {
        if (offset) await options.ensureConversation?.(scope.coordinationMissionId);
        const batchCoordinatorSessionId = offset ? await this.requireSettledUniqueSession(scope.coordinationMissionId) : workCoordinatorSessionId;
        const batch = await this.executeWorkOrders(scope, decisionFindingExchangeId,
          decision.workOrders.slice(offset, offset + parallel), batchCoordinatorSessionId,
          options.ensureAssigned, options.ensureConversation);
        work.push(...batch);
        if (batch.some(item => item.transport.terminalStatus !== "completed" || !item.report)) break;
      }
      rounds.push({ round, cognitionInputId, decisionFindingExchangeId, decision, work });
      const incomplete = work.filter(item => item.transport.terminalStatus !== "completed" || !item.report);
      if (incomplete.length && incomplete.every(item => item.transport.hostStopReason === "capability-error"
        && !!item.evidenceExchangeId && item.problemExchangeIds.length > 0)) {
        // A delivered host capability error is settled Reality, not UNKNOWN. The
        // failed input is never replayed; the next iteration gives owning
        // Cognition the durable Evidence/Problem and asks for a NEW decision.
        continue;
      }
      if (incomplete.length) {
        return { version: 1, kind: "mission-autonomy-run", state: "blocked", rounds,
          reason: "At least one Work Order did not reach a trustworthy completed structured Practice report." };
      }
    }
    return { version: 1, kind: "mission-autonomy-run", state: "round-limit", rounds,
      reason: `Autonomy stopped at the bounded ${maxRounds}-round limit; no hidden background continuation was scheduled.` };
  }

  private async executeWorkOrders(scope: MissionAutonomyScope, decisionFindingExchangeId: string, orders: CognitionWorkOrder[],
    coordinatorSessionId: string, ensureAssigned?: (missionIds: readonly string[]) => Promise<void>,
    ensureConversation?: (missionId: string) => Promise<void>): Promise<MissionAutonomyRound["work"]> {
    let frontier = await this.readiness.inspect({ projectId: scope.projectId, rootMissionId: scope.rootMissionId,
      missionIds: orders.map(order => order.targetMissionId) });
    const unassigned = frontier.missions.filter(mission => mission.state === "ready-unassigned").map(mission => mission.missionId);
    if (unassigned.length && ensureAssigned) {
      await ensureAssigned(unassigned);
    }
    for (const order of orders) await ensureConversation?.(order.targetMissionId);
    frontier = await this.readiness.inspect({ projectId: scope.projectId, rootMissionId: scope.rootMissionId,
      missionIds: orders.map(order => order.targetMissionId) });
    const byId = new Map(frontier.missions.map(mission => [mission.missionId, mission]));
    const deliveries = [];
    const captures = new Map<string, string>();
    for (const order of orders) {
      const mission = this.requireMission(order.targetMissionId, scope);
      if (mission.mission!.plane !== "practice") throw new Error(`Autonomy Work Order target must be Practice: ${mission.taskId}`);
      const ready = byId.get(mission.taskId);
      if (!ready || ready.state !== "ready-assigned" || !ready.currentManagedSessionId) {
        throw new Error(`Practice Mission ${mission.taskId} is not ready with one coherent assigned Worker (${ready?.state ?? "missing"}).`);
      }
      await this.assertSettledSession(ready.currentManagedSessionId);
      const inputId = randomUUID();
      captures.set(mission.taskId, "");
      deliveries.push({
        projectId: scope.projectId,
        managedRootMissionId: scope.rootMissionId,
        coordinationMissionId: scope.coordinationMissionId,
        targetMissionId: mission.taskId,
        managedSessionId: ready.currentManagedSessionId,
        inputId,
        instructionKind: "cognition-authorized-autonomy-work-order",
        instruction: `${order.instruction}\n\nAfter the bounded work, ${STRUCTURED_REPLY_ENCODING} Use this shape: {"version":1,"kind":"nimora-practice-report","summary":"what reality now shows","findings":["bounded verified finding"],"problems":[{"currentGoal":"...","previousAssumption":"...","observedReality":"...","preciseQuestion":"...","blocking":true}],"completionCandidate":false}. Do not claim tool/file facts you did not actually observe. When using run_command, its capability callId is NOT a terminal command_id. A completed foreground run_command already includes its output, so do not call get_command_output for it. If a running/background command genuinely needs more output, copy the exact command_id returned by run_command; never invent, alias, or derive command_id from callId.`,
        referenceIds: [decisionFindingExchangeId],
        phase8Materialization: missionEntryCapabilityMaterialization(order.requiredCapabilityIds, order.allowedWorkspacePathPrefixes),
      });
    }
    const turn = await this.liveDriver.executeCoordinatorCommandTurn({
      projectId: scope.projectId,
      managedRootMissionId: scope.rootMissionId,
      coordinationMissionId: scope.coordinationMissionId,
      managedSessionId: coordinatorSessionId,
      inputId: randomUUID(),
      command: {
        kind: "deliverParallelExplicitMissionInputs",
        arguments: {
          projectId: scope.projectId,
          managedRootMissionId: scope.rootMissionId,
          coordinationMissionId: scope.coordinationMissionId,
          deliveries,
        },
      },
    }, undefined, undefined, (text, targetMissionId) => {
      if (!targetMissionId || !captures.has(targetMissionId)) return;
      captures.set(targetMissionId, text);
    });
    const observations = turn.commandResult as CoordinatorLiveTransportObservation[];
    if (!Array.isArray(observations) || observations.length !== deliveries.length) throw new Error("Parallel Coordinator result count mismatch.");
    const result: MissionAutonomyRound["work"] = [];
    for (const delivery of deliveries) {
      const transport = observations.find(observation => observation.targetMissionId === delivery.targetMissionId
        && observation.inputId === delivery.inputId);
      if (!transport) throw new Error(`Missing exact Target transport observation for ${delivery.targetMissionId}.`);
      if (transport.terminalStatus !== "completed") {
        if (transport.hostStopReason === "capability-error") {
          const order = orders.find(candidate => candidate.targetMissionId === delivery.targetMissionId);
          if (!order) throw new Error(`Missing Cognition Work Order for failed Practice ${delivery.targetMissionId}.`);
          const persisted = await this.persistPracticeCapabilityFailure(
            scope, delivery.targetMissionId, delivery.inputId, transport, order.instruction,
          );
          result.push({ missionId: delivery.targetMissionId, targetInputId: delivery.inputId, transport, ...persisted });
        } else {
          result.push({ missionId: delivery.targetMissionId, targetInputId: delivery.inputId, transport,
            findingExchangeIds: [], problemExchangeIds: [] });
        }
        continue;
      }
      let report: PracticeReport;
      try {
        report = parsePracticeReport(captures.get(delivery.targetMissionId) ?? "");
      } catch (error) {
        const order = orders.find(candidate => candidate.targetMissionId === delivery.targetMissionId);
        if (!order) throw new Error(`Missing Cognition Work Order for Practice report normalization: ${delivery.targetMissionId}.`);
        report = await this.normalizePracticeReportOnce(
          scope,
          coordinatorSessionId,
          delivery.targetMissionId,
          delivery.managedSessionId,
          delivery.inputId,
          decisionFindingExchangeId,
          order.allowedWorkspacePathPrefixes,
          error,
        );
      }
      const persisted = await this.persistPracticeReport(scope, delivery.targetMissionId, delivery.inputId, transport, report);
      result.push({ missionId: delivery.targetMissionId, targetInputId: delivery.inputId, transport, report, ...persisted });
    }
    return result;
  }

  private async normalizePracticeReportOnce(
    scope: MissionAutonomyScope,
    coordinatorSessionId: string,
    practiceMissionId: string,
    managedSessionId: string,
    originalInputId: string,
    decisionFindingExchangeId: string,
    allowedWorkspacePathPrefixes: string[],
    validationError: unknown,
  ): Promise<PracticeReport> {
    const task = this.requireMission(practiceMissionId, scope);
    const originalExecutions = Object.values(task.executions)
      .filter(execution => execution.origin?.inputId === originalInputId);
    if (originalExecutions.some(execution => {
      const origin = execution.origin;
      const payload = execution.resultPayload;
      return !["succeeded", "failed"].includes(execution.status)
        || execution.deliveryStatus !== "delivered"
        || execution.duplicateObservations !== 0
        || origin?.kind !== "worker"
        || origin.managedSessionId !== managedSessionId
        || origin.workerId !== "nimora.web-worker"
        || !execution.finishedAt
        || !payload
        || payload.inputId !== origin.inputId
        || payload.callId !== origin.callId
        || payload.name !== execution.toolName
        || payload.isError !== (execution.status === "failed");
    })) {
      throw new Error(`Practice ${practiceMissionId} has unsettled original executions; report normalization is not allowed.`);
    }
    await this.assertSettledSession(managedSessionId);
    const normalizationInputId = randomUUID();
    let normalizedText = "";
    const validation = validationError instanceof Error ? validationError.message : String(validationError);
    const turn = await this.liveDriver.executeCoordinatorCommandTurn({
      projectId: scope.projectId,
      managedRootMissionId: scope.rootMissionId,
      coordinationMissionId: scope.coordinationMissionId,
      managedSessionId: coordinatorSessionId,
      inputId: randomUUID(),
      command: {
        kind: "deliverExplicitMissionInput",
        arguments: {
          projectId: scope.projectId,
          managedRootMissionId: scope.rootMissionId,
          coordinationMissionId: scope.coordinationMissionId,
          targetMissionId: practiceMissionId,
          managedSessionId,
          inputId: normalizationInputId,
          instructionKind: "practice-report-normalization",
          instruction: `Your immediately previous Work Order is already fully settled. Do NOT repeat any work, do NOT call tools, and do NOT create or modify files. Nimora rejected only the final report contract: ${validation.slice(0, 2_000)}

Using only facts already observed in this conversation, preserve the semantic meaning of your previous report. ${STRUCTURED_REPLY_ENCODING} Use this shape:
{"version":1,"kind":"nimora-practice-report","summary":"what reality now shows","findings":["bounded verified finding"],"problems":[{"currentGoal":"...","previousAssumption":"...","observedReality":"...","preciseQuestion":"...","blocking":true}],"completionCandidate":false}
Do not invent new evidence. This is report normalization only, not a new Work Order.`,
          referenceIds: [decisionFindingExchangeId],
          phase8Materialization: missionEntryCapabilityMaterialization([], allowedWorkspacePathPrefixes),
        },
      },
    }, undefined, undefined, (text, targetMissionId) => {
      if (targetMissionId === practiceMissionId) normalizedText = text;
    });
    const transport = turn.commandResult as CoordinatorLiveTransportObservation;
    if (!transport || Array.isArray(transport) || transport.targetMissionId !== practiceMissionId
      || transport.inputId !== normalizationInputId || transport.terminalStatus !== "completed") {
      throw new Error(`Practice report normalization did not settle cleanly for ${practiceMissionId}.`);
    }
    const freshTask = this.requireMission(practiceMissionId, scope);
    const normalizationExecutions = Object.values(freshTask.executions)
      .filter(execution => execution.origin?.inputId === normalizationInputId);
    if (normalizationExecutions.length) {
      throw new Error(`Practice report normalization attempted capability execution for ${practiceMissionId}; no retry is allowed.`);
    }
    return parsePracticeReport(normalizedText);
  }

  private async persistPracticeCapabilityFailure(
    scope: MissionAutonomyScope,
    practiceMissionId: string,
    targetInputId: string,
    transport: CoordinatorLiveTransportObservation,
    instruction: string,
  ): Promise<{ evidenceExchangeId: string; findingExchangeIds: string[]; problemExchangeIds: string[] }> {
    if (transport.terminalStatus !== "error" || transport.hostStopReason !== "capability-error") {
      throw new Error("Practice capability failure persistence requires an explicit host capability-error stop.");
    }
    const task = this.requireMission(practiceMissionId, scope);
    const executions = Object.values(task.executions)
      .filter(execution => execution.origin?.inputId === targetInputId)
      .sort((a, b) => a.executionId.localeCompare(b.executionId));
    if (!executions.length || executions.some(execution => {
      const origin = execution.origin;
      const payload = execution.resultPayload;
      return !["succeeded", "failed"].includes(execution.status)
        || execution.deliveryStatus !== "delivered"
        || execution.duplicateObservations !== 0
        || origin?.kind !== "worker" || origin.workerId !== "nimora.web-worker"
        || !origin.managedSessionId || !task.workerSessions[origin.managedSessionId]
        || !execution.finishedAt || !payload
        || payload.inputId !== origin.inputId || payload.callId !== origin.callId
        || payload.name !== execution.toolName || payload.isError !== (execution.status === "failed");
    })) {
      throw new Error(`Practice ${practiceMissionId} capability-error turn is not fully settled/delivered; no feedback continuation is allowed.`);
    }
    const executionIds = new Set(executions.map(execution => execution.executionId));
    const artifacts = task.artifacts.filter(artifact => artifact.executionId && executionIds.has(artifact.executionId));
    const references: MissionEvidenceReference[] = [{
      type: "command",
      command: `nimora-worker-turn:${targetInputId}`,
      observation: `terminal=${transport.terminalStatus}; hostStopReason=${transport.hostStopReason}; events=${transport.eventCount}; hostExecutions=${executions.length}; artifacts=${artifacts.length}`,
    }];
    for (const execution of executions.slice(0, 20)) {
      references.push({
        type: "command",
        command: execution.toolName,
        observation: `${execution.status}/${execution.deliveryStatus}${execution.resultSummary ? `: ${execution.resultSummary}` : execution.error ? `: ${execution.error}` : ""}`.slice(0, 6_000),
      });
    }
    for (const artifact of artifacts.slice(0, Math.max(0, 32 - references.length))) {
      references.push({ type: "artifact", missionId: practiceMissionId, artifactId: artifact.artifactId });
    }
    const base = digest("mission-autonomy-practice-capability-failure-v1", [scope.projectId, practiceMissionId, targetInputId]);
    const evidenceExchangeId = `autonomy:transport-evidence:v1:${base}`;
    const failedExecutions = executions.filter(execution => execution.status === "failed");
    const failureSummary = `Practice Work Order stopped at a delivered host capability error after ${executions.length} settled execution(s); failed tools: ${failedExecutions.map(execution => execution.toolName).join(", ") || "unknown"}. ${transport.terminalError ?? "No provider terminal error text was supplied."}`.slice(0, 6_000);
    await this.collaboration.recordExchange({
      exchangeId: evidenceExchangeId, projectId: scope.projectId, sourceMissionId: practiceMissionId,
      targetMissionId: scope.rootMissionId, kind: "Evidence", payload: { summary: failureSummary, references },
    });
    const problemExchangeId = `autonomy:transport-problem:v1:${digest("problem", [base])}`;
    await this.collaboration.recordExchange({
      exchangeId: problemExchangeId, projectId: scope.projectId, sourceMissionId: practiceMissionId,
      targetMissionId: scope.rootMissionId, kind: "Problem", payload: {
        currentGoal: instruction.slice(0, 6_000),
        previousAssumption: "The bounded Practice Work Order could complete and return a structured report using its authorized capabilities.",
        observedReality: failureSummary,
        preciseQuestion: "Given this settled capability failure, should Cognition revise the Work Order, choose a different bounded method/capability set, or stop this line of work? Do not replay the failed input.",
        blocking: true,
        evidenceExchangeIds: [evidenceExchangeId],
      },
    });
    await this.collaboration.recordRelation({
      relationId: `autonomy:blocks:v1:${digest("blocks", [problemExchangeId])}`, projectId: scope.projectId,
      sourceMissionId: practiceMissionId, targetMissionId: scope.rootMissionId, type: "blocks", basisExchangeId: problemExchangeId,
    });
    return { evidenceExchangeId, findingExchangeIds: [], problemExchangeIds: [problemExchangeId] };
  }

  private cognitionReviewPrompt(scope: MissionAutonomyScope): string {
    const compact = (value: string | undefined, limit: number): string | undefined => {
      const normalized = value?.trim();
      if (!normalized) return undefined;
      return normalized.length <= limit ? normalized : `${normalized.slice(0, Math.max(0, limit - 18))}…[bounded]`;
    };
    const inspection = this.tasks.listTasks()
      .filter(task => task.mission?.projectId === scope.projectId && task.mission.rootMissionId === scope.rootMissionId)
      .map(task => ({
        missionId: task.taskId, plane: task.mission!.plane, goal: compact(task.goal, 700),
        completionCriteria: task.mission!.completionCriteria.slice(0, 8).map(item => compact(item, 320)),
        terminal: !!task.missionFinalization, status: task.status,
      }));
    const missionIds = new Set(inspection.map(mission => mission.missionId));
    const allExchanges = this.collaboration.listExchanges(scope.projectId)
      .filter(exchange => missionIds.has(exchange.sourceMissionId) || (!!exchange.targetMissionId && missionIds.has(exchange.targetMissionId)));
    const byExchangeId = new Map(allExchanges.map(exchange => [exchange.exchangeId, exchange]));
    const answeredProblems = new Set(allExchanges.filter(exchange => exchange.kind === "Answer").map(exchange => exchange.replyToExchangeId));
    const unresolvedProblems = allExchanges.filter(exchange => exchange.kind === "Problem" && !answeredProblems.has(exchange.exchangeId));
    if (unresolvedProblems.length > 16) {
      throw new Error(`Autonomy Cognition has ${unresolvedProblems.length} unresolved Problems; bounded review requires higher-level reconciliation before more autonomous work.`);
    }
    const selected = new Map<string, (typeof allExchanges)[number]>();
    const addExchange = (exchangeId: string | undefined) => {
      if (!exchangeId) return;
      const exchange = byExchangeId.get(exchangeId);
      if (exchange) selected.set(exchange.exchangeId, exchange);
    };
    const addEvidenceIds = (ids: readonly string[]) => ids.slice(0, 8).forEach(addExchange);
    for (const problem of unresolvedProblems) {
      if (problem.kind !== "Problem") continue;
      selected.set(problem.exchangeId, problem);
      addEvidenceIds(problem.payload.evidenceExchangeIds);
    }
    for (const exchange of allExchanges.slice(-12)) {
      selected.set(exchange.exchangeId, exchange);
      if (exchange.kind === "Finding" || exchange.kind === "Problem" || exchange.kind === "Answer") addEvidenceIds(exchange.payload.evidenceExchangeIds);
      if (exchange.kind === "Answer") addExchange(exchange.replyToExchangeId);
    }
    const exchanges = [...selected.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.exchangeId.localeCompare(b.exchangeId))
      .map(exchange => {
        const base = {
          exchangeId: exchange.exchangeId,
          kind: exchange.kind,
          sourceMissionId: exchange.sourceMissionId,
          ...(exchange.targetMissionId ? { targetMissionId: exchange.targetMissionId } : {}),
        };
        switch (exchange.kind) {
          case "Finding": return { ...base, summary: compact(exchange.payload.summary, 520), evidenceExchangeIds: exchange.payload.evidenceExchangeIds.slice(0, 8) };
          case "Problem": return { ...base,
            currentGoal: compact(exchange.payload.currentGoal, 280), previousAssumption: compact(exchange.payload.previousAssumption, 280),
            observedReality: compact(exchange.payload.observedReality, 420), preciseQuestion: compact(exchange.payload.preciseQuestion, 280),
            blocking: exchange.payload.blocking, evidenceExchangeIds: exchange.payload.evidenceExchangeIds.slice(0, 8) };
          case "Evidence": return { ...base, summary: compact(exchange.payload.summary, 620) };
          case "Answer": return { ...base, replyToExchangeId: exchange.replyToExchangeId, answer: compact(exchange.payload.answer, 520),
            evidenceExchangeIds: exchange.payload.evidenceExchangeIds.slice(0, 8), limitations: compact(exchange.payload.limitations, 300) };
          case "Handoff": return { ...base, payload: exchange.payload };
        }
      });
    const capabilityCatalog = capabilityRegistrySnapshot().map(capability => ({
      id: capability.id,
      title: capability.title,
      risk: capability.risk,
      approval: capability.approval,
      openWorld: capability.openWorld,
    }));
    const finalizableMissionIds = inspection
      .filter(mission => mission.missionId !== scope.rootMissionId
        && mission.missionId !== scope.coordinationMissionId
        && !mission.terminal)
      .map(mission => mission.missionId);
    return `You are the owning Nimora Cognition for this managed root. Reconcile only the canonical bounded facts below. Durable history remains in Nimora storage; this turn receives unresolved Problems plus a bounded recent working set, not the full transcript. Decide the next work; Coordinator merely executes your decision. ${STRUCTURED_REPLY_ENCODING} Use this shape:
{"version":1,"kind":"nimora-cognition-decision","summary":"bounded reasoning conclusion","answers":[{"problemExchangeId":"existing Problem id","answer":"bounded answer","evidenceExchangeIds":["existing Evidence id"],"limitations":"optional"}],"workOrders":[{"targetMissionId":"existing active Practice Mission id","instruction":"bounded exact Work Order","requiredCapabilityIds":["workspace.read-files"],"allowedWorkspacePathPrefixes":["src/exact-area"]}],"additionalMissions":[{"key":"lowercase-key","goal":"bounded goal","plane":"practice","missionType":"short type","completionCriteria":["verifiable"],"dependsOn":[]}],"finalizeMissionIds":[],"projectCompletionCandidate":false}
For every Work Order, requiredCapabilityIds must use exact ids from capabilityCatalog below; never abbreviate, alias, or invent an id. These ids are also the exact capability ceiling for the Work Order: profile defaults will not add other tools. The catalog describes identifiers and policy metadata only, not permission to use them. Request only capabilities actually necessary for the bounded Work Order and respect the owning Mission's constraints. allowedWorkspacePathPrefixes must contain the smallest workspace-relative literal file or directory prefixes that this Work Order may inspect or modify; use "." only when the bounded Work Order genuinely requires the whole workspace. Never use absolute paths or "..".
finalizeMissionIds must be a subset of finalizableMissionIds below. Never put the managed root Mission or Coordinator Mission in finalizeMissionIds. If finalizableMissionIds is empty, return finalizeMissionIds:[]. Membership only means the Mission is an eligible child; finalize it only when its own completion criteria are actually supported by durable Reality evidence.
Work Orders may target only existing active Practice Missions from missions below, never the root Cognition or Coordinator. If no suitable Practice exists, create the necessary bounded Practice in additionalMissions, leave workOrders empty and projectCompletionCandidate=false. Nimora will establish its canonical Mission id and ask for a new decision in the next bounded round; do not invent an id or target a plan key. Do not invent permission, evidence IDs, Mission IDs or capabilities. If a Problem is blocking, answer it before resuming that Practice. New Mission decomposition must be necessary and acyclic. If all work is semantically complete, issue no workOrders and set projectCompletionCandidate=true; Project finalization is still mechanically checked by Nimora and must never be expressed by putting the root or Coordinator into finalizeMissionIds.
Managed scope data: ${JSON.stringify({ missions: inspection, exchangeContext: { total: allExchanges.length, selected: exchanges.length, unresolvedProblems: unresolvedProblems.length }, exchanges, capabilityCatalog, finalizableMissionIds })}`;
  }

  private cognitionCorrectionPrompt(scope: MissionAutonomyScope, validationError: string): string {
    const error = bounded(validationError, 2_000, "Cognition validation error");
    return `Your previous completed Cognition decision was rejected by deterministic Nimora validation. This is a NEW bounded decision turn, not a replay of the previous provider input or response.
Validation error: ${error}
Return exactly one corrected nimora-cognition-decision JSON object using the wire encoding below. Re-evaluate the current durable scope below; preserve verified facts, but correct every structurally invalid action. The root Cognition Mission (${scope.rootMissionId}) and Coordinator Mission (${scope.coordinationMissionId}) can NEVER appear in finalizeMissionIds. finalizeMissionIds is only for active child Missions whose completion is already supported by durable Reality, and a Mission receiving a Work Order in this decision must not also be finalized in the same decision.

${this.cognitionReviewPrompt(scope)}`;
  }

  private async persistPracticeReport(scope: MissionAutonomyScope, practiceMissionId: string, targetInputId: string,
    transport: CoordinatorLiveTransportObservation, report: PracticeReport): Promise<{
      evidenceExchangeId: string; findingExchangeIds: string[]; problemExchangeIds: string[];
    }> {
    const task = this.requireMission(practiceMissionId, scope);
    const executions = Object.values(task.executions)
      .filter(execution => execution.origin?.inputId === targetInputId)
      .sort((a, b) => a.executionId.localeCompare(b.executionId));
    const executionIds = new Set(executions.map(execution => execution.executionId));
    const artifacts = task.artifacts.filter(artifact => artifact.executionId && executionIds.has(artifact.executionId));
    const references: MissionEvidenceReference[] = [{
      type: "command",
      command: `nimora-worker-turn:${targetInputId}`,
      observation: `terminal=${transport.terminalStatus}; events=${transport.eventCount}; hostExecutions=${executions.length}; artifacts=${artifacts.length}`,
    }];
    for (const execution of executions.slice(0, 20)) {
      references.push({
        type: "command",
        command: execution.toolName,
        observation: `${execution.status}/${execution.deliveryStatus}${execution.resultSummary ? `: ${execution.resultSummary}` : execution.error ? `: ${execution.error}` : ""}`.slice(0, 6_000),
      });
    }
    for (const artifact of artifacts.slice(0, Math.max(0, 32 - references.length))) {
      references.push({ type: "artifact", missionId: practiceMissionId, artifactId: artifact.artifactId });
    }
    const base = digest("mission-autonomy-practice-report-v1", [scope.projectId, practiceMissionId, targetInputId]);
    const evidenceExchangeId = `autonomy:evidence:v1:${base}`;
    await this.collaboration.recordExchange({
      exchangeId: evidenceExchangeId, projectId: scope.projectId, sourceMissionId: practiceMissionId,
      targetMissionId: scope.rootMissionId, kind: "Evidence",
      payload: { summary: report.summary, references },
    });
    const findingExchangeIds: string[] = [];
    for (const [index, summary] of report.findings.entries()) {
      const exchangeId = `autonomy:finding:v1:${digest("finding", [base, String(index)])}`;
      await this.collaboration.recordExchange({
        exchangeId, projectId: scope.projectId, sourceMissionId: practiceMissionId, targetMissionId: scope.rootMissionId,
        kind: "Finding", payload: { summary, evidenceExchangeIds: [evidenceExchangeId] },
      });
      await this.collaboration.recordRelation({
        relationId: `autonomy:informs:v1:${digest("informs", [exchangeId])}`, projectId: scope.projectId,
        sourceMissionId: practiceMissionId, targetMissionId: scope.rootMissionId, type: "informs", basisExchangeId: exchangeId,
      });
      findingExchangeIds.push(exchangeId);
    }
    const problemExchangeIds: string[] = [];
    for (const [index, problem] of report.problems.entries()) {
      const exchangeId = `autonomy:problem:v1:${digest("problem", [base, String(index)])}`;
      await this.collaboration.recordExchange({
        exchangeId, projectId: scope.projectId, sourceMissionId: practiceMissionId, targetMissionId: scope.rootMissionId,
        kind: "Problem", payload: { ...problem, evidenceExchangeIds: [evidenceExchangeId] },
      });
      if (problem.blocking) {
        await this.collaboration.recordRelation({
          relationId: `autonomy:blocks:v1:${digest("blocks", [exchangeId])}`, projectId: scope.projectId,
          sourceMissionId: practiceMissionId, targetMissionId: scope.rootMissionId,
          type: "blocks", basisExchangeId: exchangeId,
        });
      }
      problemExchangeIds.push(exchangeId);
    }
    return { evidenceExchangeId, findingExchangeIds, problemExchangeIds };
  }

  private async persistCognitionDecision(scope: MissionAutonomyScope, cognitionInputId: string, decision: CognitionDecision): Promise<string> {
    const findingId = `autonomy:cognition-decision:v1:${digest("decision", [scope.projectId, scope.rootMissionId, cognitionInputId])}`;
    await this.collaboration.recordExchange({
      exchangeId: findingId, projectId: scope.projectId, sourceMissionId: scope.rootMissionId,
      kind: "Finding", payload: { summary: decision.summary, evidenceExchangeIds: [] },
    });
    for (const [index, answer] of decision.answers.entries()) {
      const problem = this.collaboration.getExchange(answer.problemExchangeId);
      if (!problem || problem.kind !== "Problem" || problem.projectId !== scope.projectId
        || problem.targetMissionId !== scope.rootMissionId) {
        throw new Error(`Cognition answer references a Problem not owned by this root: ${answer.problemExchangeId}`);
      }
      const answerId = `autonomy:answer:v1:${digest("answer", [findingId, answer.problemExchangeId, String(index)])}`;
      await this.collaboration.recordExchange({
        exchangeId: answerId, projectId: scope.projectId, sourceMissionId: scope.rootMissionId,
        targetMissionId: problem.sourceMissionId, kind: "Answer", replyToExchangeId: problem.exchangeId,
        payload: { answer: answer.answer, evidenceExchangeIds: answer.evidenceExchangeIds,
          ...(answer.limitations ? { limitations: answer.limitations } : {}) },
      });
      await this.collaboration.recordRelation({
        relationId: `autonomy:answers:v1:${digest("answers", [answerId])}`, projectId: scope.projectId,
        sourceMissionId: scope.rootMissionId, targetMissionId: problem.sourceMissionId, type: "answers", basisExchangeId: answerId,
      });
    }
    return findingId;
  }

  private preflightDecision(scope: MissionAutonomyScope, decision: CognitionDecision): void {
    for (const answer of decision.answers) {
      const problem = this.collaboration.getExchange(answer.problemExchangeId);
      if (!problem || problem.kind !== "Problem" || problem.projectId !== scope.projectId
        || problem.targetMissionId !== scope.rootMissionId) {
        throw new Error(`Cognition answer references a Problem not owned by this root: ${answer.problemExchangeId}`);
      }
      for (const evidenceId of answer.evidenceExchangeIds) {
        const evidence = this.collaboration.getExchange(evidenceId);
        if (!evidence || evidence.kind !== "Evidence" || evidence.projectId !== scope.projectId) {
          throw new Error(`Cognition answer references invalid Evidence: ${evidenceId}`);
        }
      }
    }
    for (const order of decision.workOrders) {
      const mission = this.requireMission(order.targetMissionId, scope);
      if (mission.mission!.plane !== "practice" || mission.missionFinalization) {
        throw new Error(`Cognition Work Order target must be an active Practice Mission: ${order.targetMissionId}`);
      }
      missionEntryCapabilityMaterialization(order.requiredCapabilityIds, order.allowedWorkspacePathPrefixes);
    }
    for (const missionId of decision.finalizeMissionIds) {
      if (missionId === scope.rootMissionId || missionId === scope.coordinationMissionId) {
        throw new Error("Cognition child finalization cannot target root or Coordinator.");
      }
      if (decision.workOrders.some(order => order.targetMissionId === missionId)) {
        throw new Error(`Cognition cannot finalize and issue a Work Order to the same Mission in one decision: ${missionId}`);
      }
      this.requireMission(missionId, scope);
    }
  }

  private async finalizeCognitionAuthorizedMission(scope: MissionAutonomyScope, missionId: string): Promise<void> {
    if (missionId === scope.rootMissionId || missionId === scope.coordinationMissionId) {
      throw new Error("Child Mission finalization list cannot directly finalize root or Coordinator.");
    }
    const mission = this.requireMission(missionId, scope);
    const state = await this.readiness.inspect({ projectId: scope.projectId, rootMissionId: scope.rootMissionId, missionIds: [missionId] });
    const observed = state.missions[0];
    if (!observed || observed.blockers.length || observed.state === "running") {
      throw new Error(`Cognition-authorized Mission ${missionId} is not mechanically safe to finalize.`);
    }
    if (!mission.missionFinalization) await this.finalization.finalizeMission(missionId);
  }

  private requireMission(missionId: string, scope: MissionAutonomyScope): TaskSnapshot {
    const task = this.tasks.getTask(missionId);
    if (!task?.mission || task.mission.projectId !== scope.projectId || task.mission.rootMissionId !== scope.rootMissionId) {
      throw new Error(`Mission is outside autonomy scope: ${missionId}`);
    }
    return task;
  }

  private async requireSettledUniqueSession(missionId: string): Promise<string> {
    const task = this.tasks.getTask(missionId);
    if (!task?.mission || task.missionFinalization) throw new Error(`Mission is unavailable for a new turn: ${missionId}`);
    const refs = Object.values(task.workerSessions).filter(ref => !ref.detachedAt && !ref.retiredAt);
    const live = this.workers.listSessions({ taskId: missionId }).filter(session => session.state !== "disposed");
    if (refs.length !== 1 || live.length !== 1 || refs[0].managedSessionId !== live[0].managedSessionId
      || refs[0].workerId !== live[0].workerId || refs[0].adapterSessionId !== live[0].adapterSessionId) {
      throw new Error(`Mission ${missionId} does not have one coherent current Worker.`);
    }
    await this.assertSettledSession(live[0].managedSessionId);
    return live[0].managedSessionId;
  }

  private async assertSettledSession(managedSessionId: string): Promise<void> {
    const session = this.workers.getSession(managedSessionId);
    if (!session) throw new Error(`Unknown WorkerSession: ${managedSessionId}`);
    await this.workers.withAdapterSessionRetirementScope(
      [{ workerId: session.workerId, adapterSessionId: session.adapterSessionId }],
      async owner => {
        if (!owner.isKnownSettled({ workerId: session.workerId, adapterSessionId: session.adapterSessionId })) {
          throw new Error(`WorkerSession ${managedSessionId} has unresolved provider/UNKNOWN state; no autonomous send is allowed.`);
        }
      },
    );
  }
}
