import type { RenderedContextHandoff } from "./context-handoff.js";
import type { MissionCapabilityMaterializationResult } from "./mission-capability-materializer.js";
import {
  dispatchHostCapabilityRequest,
  type HostCapabilityExecutionDelivery,
} from "./host-capability-request-dispatcher.js";
import type { MissionCollaborationStore } from "./mission-collaboration-store.js";
import type {
  ManagedScopeCompletionReadiness,
  ManagedScopeCompletionResult,
  MissionCoordinatorCompletionService,
} from "./mission-coordinator-completion-service.js";
import type { MissionFeedbackService } from "./mission-feedback-service.js";
import { buildMissionFeedbackWorkerInput } from "./mission-feedback-worker-input.js";
import type {
  MissionCoordinatorInspection,
  MissionCoordinatorScope,
  MissionCoordinatorService,
} from "./mission-coordinator-service.js";
import {
  buildExplicitMissionWorkerInput,
  buildMissionCoordinatorWorkerInput,
  buildMissionExchangeWorkerInput,
  missionCoordinatorCommandCapabilityName,
  type DeliverCommittedDecisionCommand,
  type DeliverExplicitMissionInputCommand,
  type DeliverParallelExplicitMissionInputsCommand,
  type DeliverFeedbackContinuationCommand,
  type DeliverMissionExchangeCommand,
  type ExplicitMissionInputInstruction,
  type MissionCoordinatorSemanticCommand,
} from "./mission-coordinator-worker-input.js";
import type { ProjectDecisionService } from "./project-decision-service.js";
import { buildProjectDecisionWorkerInput } from "./project-decision-worker-input.js";
import type { ProjectStore } from "./project-store.js";
import type { TaskSnapshot } from "./task-contract.js";
import type { TaskRuntime } from "./task-runtime.js";
import type { WorkerEvent, WorkerInput, WorkerTerminalStatus } from "./worker-contract.js";
import type { ManagedWorkerSession, WorkerSessionManager } from "./worker-session-manager.js";
import {
  type MissionWorkerInputCompositionInspector,
  type MissionWorkerInputMaterializationRequest,
  type MissionWorkerInputMaterializer,
} from "./mission-worker-input-materializer.js";
import { admitMissionWorkerInputMaterializationSpec, normalizeMissionWorkspaceAccessPolicy } from "./mission-worker-input-materialization-contract.js";

export interface ExecuteCoordinatorCommandTurnInput extends MissionCoordinatorScope {
  coordinationMissionId: string;
  managedSessionId: string;
  inputId: string;
  command: MissionCoordinatorSemanticCommand;
  contextHandoff?: RenderedContextHandoff;
}

export interface CoordinatorCommandTurnResult {
  inspection: MissionCoordinatorInspection;
  events: WorkerEvent[];
  commandExecuted: boolean;
  commandResult?: unknown;
  postTurnCompletion?: ManagedScopeCompletionResult;
}

export interface CoordinatorLiveTransportObservation {
  version: 1;
  kind: "coordinator-live-transport-observation";
  targetMissionId: string;
  inputId: string;
  terminalStatus: WorkerTerminalStatus;
  terminalError?: string;
  hostStopReason?: "authorization-denied" | "capability-error";
  observedEventKinds: WorkerEvent["type"][];
  eventCount: number;
  compositionInspector?: MissionWorkerInputCompositionInspector;
}

export interface MissionNativeCapabilityTurnBinding {
  activateTurn(input: {
    projectId: string;
    rootMissionId: string;
    missionId: string;
    managedSessionId: string;
    inputId: string;
    capability: MissionCapabilityMaterializationResult;
  }): Promise<unknown>;
  clearTurn(managedSessionId: string, inputId: string): void | Promise<void>;
}

function isExactEmptyInvocationEnvelope(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  if (Reflect.ownKeys(value).length !== 0) return false;
  // Production WebMCP capability events cross page.evaluate's by-value
  // serialization boundary before they reach the host driver. Playwright
  // reconstructs serialized objects as host-realm plain objects, so accepting
  // foreign/custom prototype identities is unnecessary and would turn
  // prototype-shape similarity into invocation authority.
  return Object.getPrototypeOf(value) === Object.prototype;
}

function missionResult(task: TaskSnapshot): unknown {
  const mission = task.mission;
  if (!mission) return { missionId: task.taskId };
  return {
    missionId: task.taskId,
    projectId: mission.projectId,
    rootMissionId: mission.rootMissionId,
    ...(mission.parentMissionId === undefined ? {} : { parentMissionId: mission.parentMissionId }),
    plane: mission.plane,
    missionType: mission.missionType,
    completionCriteria: [...mission.completionCriteria],
    ...(task.missionFinalization ? { terminal: { ...task.missionFinalization } } : {}),
  };
}

/**
 * Stateless Phase 6 live transport seam. The trusted host supplies every
 * WorkerSession identity explicitly. This driver never registers/creates/selects
 * workers, never persists a command queue or delivery acknowledgement, and never
 * owns Human Confirmation, Commit, planning, scheduling, or completion policy.
 */
export class MissionCoordinatorLiveDriver {
  constructor(
    private readonly projects: ProjectStore,
    private readonly tasks: TaskRuntime,
    private readonly collaboration: MissionCollaborationStore,
    private readonly coordinator: MissionCoordinatorService,
    private readonly feedback: MissionFeedbackService,
    private readonly decisions: ProjectDecisionService,
    private readonly workers: WorkerSessionManager,
    private readonly completion?: MissionCoordinatorCompletionService,
    private readonly phase8Materializer?: MissionWorkerInputMaterializer,
    private readonly hostCapabilityExecution?: HostCapabilityExecutionDelivery,
    private readonly nativeCapabilityTurnBinding?: MissionNativeCapabilityTurnBinding,
  ) {}

  async executeCoordinatorCommandTurn(input: ExecuteCoordinatorCommandTurnInput, onTargetText?: (text: string, targetMissionId?: string) => void,
    checkpointTargetObservation?: (observation: CoordinatorLiveTransportObservation) => Promise<void>,
    onTargetTerminalText?: (text: string, targetMissionId?: string) => void): Promise<CoordinatorCommandTurnResult> {
    const inspection = await this.coordinator.inspectManagedScope(input);
    if (inspection.coordinationMissionId !== input.coordinationMissionId) {
      throw new Error(`Supplied Coordinator Mission ${input.coordinationMissionId} is not the exact managed Coordinator Mission ${inspection.coordinationMissionId}.`);
    }
    const coordinationMission = this.requireActiveInScopeMission(input, input.coordinationMissionId, "Coordinator Mission");
    const session = this.requireSession(input.managedSessionId, coordinationMission.taskId, "Coordinator");
    const workerInput = buildMissionCoordinatorWorkerInput({
      projectId: input.projectId,
      managedRootMissionId: input.managedRootMissionId,
      coordinationMission,
      session,
      inspection,
      // The renderer performs exact own-data command validation before any
      // serialization. Avoid cloning first because host accessors must never run.
      command: input.command,
      inputId: input.inputId,
      contextHandoff: input.contextHandoff,
    });

    const expectedCapability = missionCoordinatorCommandCapabilityName(input.command);
    const events: WorkerEvent[] = [];
    let commandExecuted = false;
    let commandResult: unknown;
    let executedCallId: string | undefined;
    let terminalStatus: WorkerTerminalStatus | undefined;
    let terminalError: string | undefined;
    for await (const event of this.workers.send(session.managedSessionId, workerInput)) {
      if (event.type === "terminal") {
        terminalStatus = event.status;
        terminalError = typeof event.error === "string" && event.error.trim()
          ? event.error.trim().slice(0, 4_000) : undefined;
      }
      if (event.type !== "capability_call") {
        events.push(structuredClone(event));
        continue;
      }
      if (event.inputId !== workerInput.inputId) throw new Error("Coordinator Worker capability call belongs to a different input turn.");
      if (event.dispatch !== "host-requested") throw new Error("Coordinator semantic operation must be host-requested.");
      if (!event.callId) throw new Error("Coordinator semantic operation requires callId.");
      if (event.name !== expectedCapability) {
        throw new Error(`Coordinator Worker attempted unauthorized command kind ${event.name}; expected ${expectedCapability}.`);
      }
      if (!isExactEmptyInvocationEnvelope(event.arguments)) {
        throw new Error("Coordinator Worker attempted to mutate the host-bound invocation envelope.");
      }
      // Clone only after exact envelope admission. Invalid provider argument
      // objects may contain accessors; rejection must not execute them merely to
      // decide whether the invocation is semantically empty.
      events.push(structuredClone(event));
      const occurrenceId = typeof event.extensions?.occurrenceId === "string"
        && event.extensions.occurrenceId.trim()
        ? event.extensions.occurrenceId
        : undefined;
      if (commandExecuted) {
        // WebMCP already deduplicates one logical provider occurrence. A new
        // capability_call after the first confirmed result is therefore a new
        // provider request, not a transport retry. Never send the semantic result
        // again: repeated result messages can trigger provider rate limits and
        // cannot grant a second command authority. Fail closed and let the
        // WorkerSession lifecycle/reconciliation path own recovery.
        throw new Error(`Coordinator Worker repeated explicit semantic command after confirmed result (${executedCallId ?? "unknown"} -> ${event.callId}); refusing another provider result send.`);
      }
      // Provider authority ends at this exact empty invocation envelope. The
      // semantic payload remains the original Cognition-authored host command.
      commandResult = await this.executeExactCommand(input.command, session.managedSessionId, onTargetText, onTargetTerminalText);
      commandExecuted = true;
      executedCallId = event.callId;
      if (input.command.kind === "deliverExplicitMissionInput" && checkpointTargetObservation) {
        // The Target terminal and the Coordinator result delivery are separate
        // boundaries. Persist the owning Target observation before another
        // provider send can fail. This callback grants no replay authority and
        // is invoked once, never for a duplicate Coordinator invocation.
        await checkpointTargetObservation(structuredClone(commandResult as CoordinatorLiveTransportObservation));
      }
      await this.workers.submitCapabilityResult(session.managedSessionId, {
        inputId: workerInput.inputId,
        callId: event.callId,
        name: event.name,
        text: JSON.stringify(commandResult),
        data: structuredClone(commandResult),
        ...(occurrenceId === undefined ? {} : { extensions: { occurrenceId } }),
      });
    }
    if (!commandExecuted) throw new Error(
      `Coordinator Worker turn ended without executing the explicit semantic command (terminal=${terminalStatus ?? "missing"}).`
      + (terminalError ? ` Provider error: ${terminalError}` : ""),
    );
    let postTurnCompletion: ManagedScopeCompletionResult | undefined;
    if (input.command.kind === "completeManagedScope") {
      const readiness = commandResult as ManagedScopeCompletionReadiness;
      if (readiness.ready) {
        if (terminalStatus !== "completed") {
          throw new Error(`Coordinator completion turn did not reach a trustworthy completed terminal boundary (${terminalStatus ?? "missing"}).`);
        }
        if (!this.completion) throw new Error("Coordinator completion service is not configured.");
        // WorkerSessionManager releases the active send lease before yielding the
        // terminal event, so this mutation is necessarily post-turn.
        postTurnCompletion = await this.completion.finalizeAfterCompletedTurn(input.command.arguments);
      }
    }
    return {
      inspection,
      events,
      commandExecuted,
      commandResult,
      ...(postTurnCompletion ? { postTurnCompletion } : {}),
    };
  }

  async #deliverExplicitMissionInput(
    input: DeliverExplicitMissionInputCommand,
    onTargetText?: (text: string, targetMissionId?: string) => void,
    onTargetTerminalText?: (text: string, targetMissionId?: string) => void,
  ): Promise<CoordinatorLiveTransportObservation> {
    await this.requireExactCoordinator(input, input.coordinationMissionId);
    const targetMission = this.requireActiveInScopeMission(input, input.targetMissionId, "Target Mission");
    const session = this.requireSession(input.managedSessionId, targetMission.taskId, "Target");
    const referenceIds = Object.prototype.hasOwnProperty.call(input, "referenceIds") ? input.referenceIds : undefined;
    const contextHandoff = Object.prototype.hasOwnProperty.call(input, "contextHandoff") ? input.contextHandoff : undefined;
    const rawPhase8Materialization = Object.prototype.hasOwnProperty.call(input, "phase8Materialization") ? input.phase8Materialization : undefined;
    const phase8Materialization = rawPhase8Materialization === undefined
      ? undefined
      : admitMissionWorkerInputMaterializationSpec(rawPhase8Materialization, "deliverExplicitMissionInput phase8Materialization");
    const instruction: ExplicitMissionInputInstruction = {
      projectId: input.projectId,
      managedRootMissionId: input.managedRootMissionId,
      coordinationMissionId: input.coordinationMissionId,
      targetMissionId: input.targetMissionId,
      instructionKind: input.instructionKind,
      instruction: input.instruction,
      referenceIds,
    };
    if (phase8Materialization) {
      if (contextHandoff) throw new Error("Phase 8 explicit composition cannot also carry a legacy Context Handoff; owner-backed Mission Context is materialized fresh.");
      if (!this.phase8Materializer) throw new Error("Phase 8 Worker-input materializer is not configured for this explicit-delivery command.");
      const materializationRequest: MissionWorkerInputMaterializationRequest = {
        projectId: input.projectId,
        rootMissionId: input.managedRootMissionId,
        missionId: input.targetMissionId,
        managedSessionId: input.managedSessionId,
        coordinationMissionId: input.coordinationMissionId,
        inputId: input.inputId,
        instructionKind: input.instructionKind,
        instruction: input.instruction,
        ...(referenceIds === undefined ? {} : { referenceIds }),
        ...phase8Materialization,
      };
      const composed = await this.phase8Materializer.materialize(materializationRequest);
      await this.phase8Materializer.assertFreshForSend(composed, materializationRequest);
      const freshTargetMission = this.requireActiveInScopeMission(input, input.targetMissionId, "Target Mission");
      const freshSession = this.requireSession(input.managedSessionId, freshTargetMission.taskId, "Target");
      if (freshSession.workerId !== composed.inspector.scope.workerId) {
        throw new Error(`Phase 8 materialized Worker ${String(composed.inspector.scope.workerId)} no longer matches exact target Worker ${freshSession.workerId}.`);
      }
      const workspaceAccess = phase8Materialization.workspaceAccess
        ? normalizeMissionWorkspaceAccessPolicy(phase8Materialization.workspaceAccess)
        : { allowedPathPrefixes: ["."] };
      await this.tasks.recordInputAccessPolicyStrict(freshTargetMission.taskId, {
        inputId: input.inputId,
        managedSessionId: input.managedSessionId,
        allowedWorkspacePathPrefixes: workspaceAccess.allowedPathPrefixes,
      });
      const needsNativeBinding = composed.capability.inspector.mappings.some(mapping => mapping.projectionMode === "native-by-name");
      if (needsNativeBinding) {
        if (!this.nativeCapabilityTurnBinding) {
          throw new Error("Phase 8 native-by-name capability projection requires a Mission-native capability turn binding.");
        }
        await this.nativeCapabilityTurnBinding.activateTurn({
          projectId: input.projectId,
          rootMissionId: input.managedRootMissionId,
          missionId: input.targetMissionId,
          managedSessionId: input.managedSessionId,
          inputId: input.inputId,
          capability: composed.capability,
        });
      }
      try {
        const transport = await this.#observeTargetTransport(
          freshSession,
          freshTargetMission.taskId,
          composed.workerInput,
          onTargetText ? text => onTargetText(text, freshTargetMission.taskId) : undefined,
          onTargetTerminalText ? text => onTargetTerminalText(text, freshTargetMission.taskId) : undefined,
        );
        return { ...transport, compositionInspector: structuredClone(composed.inspector) };
      } finally {
        if (needsNativeBinding) {
          await this.nativeCapabilityTurnBinding!.clearTurn(input.managedSessionId, input.inputId);
        }
      }
    }
    const workerInput = buildExplicitMissionWorkerInput({
      instruction,
      targetMission,
      session,
      inputId: input.inputId,
      contextHandoff,
    });
    return this.#observeTargetTransport(
      session,
      targetMission.taskId,
      workerInput,
      onTargetText ? text => onTargetText(text, targetMission.taskId) : undefined,
      onTargetTerminalText ? text => onTargetTerminalText(text, targetMission.taskId) : undefined,
    );
  }

  async #deliverParallelExplicitMissionInputs(
    input: DeliverParallelExplicitMissionInputsCommand,
    onTargetText?: (text: string, targetMissionId?: string) => void,
    onTargetTerminalText?: (text: string, targetMissionId?: string) => void,
  ): Promise<CoordinatorLiveTransportObservation[]> {
    await this.requireExactCoordinator(input, input.coordinationMissionId);
    return Promise.all(input.deliveries.map(delivery => this.#deliverExplicitMissionInput(delivery, onTargetText, onTargetTerminalText)));
  }

  async #deliverMissionExchange(input: DeliverMissionExchangeCommand): Promise<CoordinatorLiveTransportObservation> {
    await this.requireExactCoordinator(input, input.coordinationMissionId);
    const exchange = this.collaboration.getExchange(input.exchangeId);
    if (!exchange) throw new Error(`Unknown Mission exchange: ${input.exchangeId}`);
    if (exchange.projectId !== input.projectId) throw new Error(`Mission exchange ${input.exchangeId} belongs to a different Project.`);
    const source = this.tasks.getTask(exchange.sourceMissionId);
    if (!source?.mission
      || source.mission.projectId !== input.projectId
      || source.mission.rootMissionId !== input.managedRootMissionId) {
      throw new Error(`Mission exchange ${input.exchangeId} source is outside the managed Coordinator scope.`);
    }
    const targetMission = this.requireActiveInScopeMission(input, input.targetMissionId, "Exchange target Mission");
    if (exchange.kind === "Problem" && targetMission.mission?.plane !== "cognition") {
      throw new Error(`Problem exchange ${input.exchangeId} must be transported back to an in-scope Cognition Mission.`);
    }
    const session = this.requireSession(input.managedSessionId, targetMission.taskId, "Exchange target");
    const workerInput = buildMissionExchangeWorkerInput({
      projectId: input.projectId,
      managedRootMissionId: input.managedRootMissionId,
      coordinationMissionId: input.coordinationMissionId,
      exchange,
      targetMission,
      session,
      inputId: input.inputId,
      contextHandoff: input.contextHandoff,
    });
    return this.#observeTargetTransport(session, targetMission.taskId, workerInput);
  }

  async #deliverFeedbackContinuation(input: DeliverFeedbackContinuationCommand): Promise<CoordinatorLiveTransportObservation> {
    await this.requireExactCoordinator(input, input.coordinationMissionId);
    const practiceMission = this.requireActiveInScopeMission(input, input.practiceMissionId, "Practice Mission");
    if (practiceMission.mission?.plane !== "practice") throw new Error(`Feedback continuation target must be a Practice Mission: ${input.practiceMissionId}`);
    const session = this.requireSession(input.managedSessionId, practiceMission.taskId, "Practice");
    const continuation = await this.feedback.buildPracticeContinuation({
      projectId: input.projectId,
      practiceMissionId: input.practiceMissionId,
      problemExchangeId: input.problemExchangeId,
      answerExchangeId: input.answerExchangeId,
    });
    if (input.phase8Materialization !== undefined) {
      if (input.contextHandoff) throw new Error("Phase 8 feedback continuation cannot also carry a legacy Context Handoff.");
      if (!this.phase8Materializer) throw new Error("Phase 8 Worker-input materializer is not configured for feedback continuation.");
      const phase8Materialization = admitMissionWorkerInputMaterializationSpec(
        input.phase8Materialization,
        "deliverFeedbackContinuation phase8Materialization",
      );
      const request: MissionWorkerInputMaterializationRequest = {
        projectId: input.projectId,
        rootMissionId: input.managedRootMissionId,
        missionId: input.practiceMissionId,
        managedSessionId: input.managedSessionId,
        coordinationMissionId: input.coordinationMissionId,
        inputId: input.inputId,
        instructionKind: "cognition-feedback-continuation",
        instruction: JSON.stringify(continuation),
        referenceIds: [input.problemExchangeId, input.answerExchangeId],
        ...phase8Materialization,
      };
      const composed = await this.phase8Materializer.materialize(request);
      await this.phase8Materializer.assertFreshForSend(composed, request);
      const freshPracticeMission = this.requireActiveInScopeMission(input, input.practiceMissionId, "Practice Mission");
      const freshSession = this.requireSession(input.managedSessionId, freshPracticeMission.taskId, "Practice");
      const workspaceAccess = phase8Materialization.workspaceAccess
        ? normalizeMissionWorkspaceAccessPolicy(phase8Materialization.workspaceAccess)
        : { allowedPathPrefixes: ["."] };
      await this.tasks.recordInputAccessPolicyStrict(freshPracticeMission.taskId, {
        inputId: input.inputId,
        managedSessionId: input.managedSessionId,
        allowedWorkspacePathPrefixes: workspaceAccess.allowedPathPrefixes,
      });
      const needsNativeBinding = composed.capability.inspector.mappings.some(mapping => mapping.projectionMode === "native-by-name");
      if (needsNativeBinding) {
        if (!this.nativeCapabilityTurnBinding) throw new Error("Phase 8 feedback continuation requires a Mission-native capability turn binding.");
        await this.nativeCapabilityTurnBinding.activateTurn({
          projectId: input.projectId,
          rootMissionId: input.managedRootMissionId,
          missionId: input.practiceMissionId,
          managedSessionId: input.managedSessionId,
          inputId: input.inputId,
          capability: composed.capability,
        });
      }
      try {
        const transport = await this.#observeTargetTransport(freshSession, freshPracticeMission.taskId, composed.workerInput);
        return { ...transport, compositionInspector: structuredClone(composed.inspector) };
      } finally {
        if (needsNativeBinding) await this.nativeCapabilityTurnBinding!.clearTurn(input.managedSessionId, input.inputId);
      }
    }
    const workerInput = buildMissionFeedbackWorkerInput({
      continuation,
      practiceMission,
      session,
      inputId: input.inputId,
      contextHandoff: input.contextHandoff,
    });
    return this.#observeTargetTransport(session, practiceMission.taskId, workerInput);
  }

  async #deliverCommittedDecision(input: DeliverCommittedDecisionCommand): Promise<CoordinatorLiveTransportObservation> {
    await this.requireExactCoordinator(input, input.coordinationMissionId);
    const project = this.projects.getProject(input.projectId);
    if (!project) throw new Error(`Unknown Project: ${input.projectId}`);
    const decision = project.committedDecisions[input.decisionId];
    if (!decision) throw new Error(`Committed Project Decision does not exist in Project ${input.projectId}: ${input.decisionId}`);
    const targetMission = this.requireActiveInScopeMission(input, input.targetMissionId, "Decision target Mission");
    const session = this.requireSession(input.managedSessionId, targetMission.taskId, "Decision target");
    const impact = await this.decisions.analyzeImpact(input.projectId, input.decisionId);
    const workerInput = buildProjectDecisionWorkerInput({
      project,
      decision,
      impact,
      mission: targetMission,
      session,
      inputId: input.inputId,
      contextHandoff: input.contextHandoff,
    });
    return this.#observeTargetTransport(session, targetMission.taskId, workerInput);
  }

  private async executeExactCommand(command: MissionCoordinatorSemanticCommand, coordinatorManagedSessionId: string,
    onTargetText?: (text: string, targetMissionId?: string) => void,
    onTargetTerminalText?: (text: string, targetMissionId?: string) => void): Promise<unknown> {
    switch (command.kind) {
      case "inspectManagedScope":
        return this.coordinator.inspectManagedScope(command.arguments);
      case "ensureMission":
        return missionResult(await this.coordinator.ensureMission(command.arguments));
      case "routePracticeProblem": {
        const routed = await this.coordinator.routePracticeProblem(command.arguments);
        return {
          cognitionMission: missionResult(routed.cognitionMission),
          input: structuredClone(routed.input),
        };
      }
      case "deliverExplicitMissionInput":
        return this.#deliverExplicitMissionInput(command.arguments, onTargetText, onTargetTerminalText);
      case "deliverParallelExplicitMissionInputs":
        return this.#deliverParallelExplicitMissionInputs(command.arguments, onTargetText, onTargetTerminalText);
      case "deliverMissionExchange":
        return this.#deliverMissionExchange(command.arguments);
      case "deliverFeedbackContinuation":
        return this.#deliverFeedbackContinuation(command.arguments);
      case "deliverCommittedDecision":
        return this.#deliverCommittedDecision(command.arguments);
      case "completeManagedScope":
        if (!this.completion) throw new Error("Coordinator completion service is not configured.");
        return this.completion.preflight(command.arguments, coordinatorManagedSessionId);
      default:
        throw new Error(`Unsupported Coordinator semantic command kind: ${String((command as { kind?: unknown }).kind)}`);
    }
  }

  private async requireExactCoordinator(scope: MissionCoordinatorScope, coordinationMissionId: string): Promise<MissionCoordinatorInspection> {
    const inspection = await this.coordinator.inspectManagedScope(scope);
    if (inspection.coordinationMissionId !== coordinationMissionId) {
      throw new Error(`Supplied Coordinator Mission ${coordinationMissionId} is not the exact managed Coordinator Mission ${inspection.coordinationMissionId}.`);
    }
    this.requireActiveInScopeMission(scope, coordinationMissionId, "Coordinator Mission");
    return inspection;
  }

  private requireActiveInScopeMission(scope: MissionCoordinatorScope, taskId: string, label: string): TaskSnapshot {
    const task = this.tasks.getTask(taskId);
    if (!task?.mission) throw new Error(`${label} does not exist or is not configured: ${taskId}`);
    if (task.mission.projectId !== scope.projectId || task.mission.rootMissionId !== scope.managedRootMissionId) {
      throw new Error(`${label} ${taskId} is outside the exact Coordinator Project/root scope.`);
    }
    if (task.missionFinalization) throw new Error(`${label} ${taskId} is terminal (${task.missionFinalization.state}) and cannot receive live bridge work.`);
    return task;
  }

  private requireSession(managedSessionId: string, taskId: string, label: string): ManagedWorkerSession {
    const session = this.workers.getSession(managedSessionId);
    if (!session) throw new Error(`${label} WorkerSession does not exist: ${managedSessionId}`);
    if (session.taskId !== taskId) {
      throw new Error(`${label} WorkerSession ${managedSessionId} is bound to ${session.taskId ?? "no Task"}, not Mission ${taskId}.`);
    }
    if (session.state === "disposed") throw new Error(`${label} WorkerSession ${managedSessionId} is disposed.`);
    return session;
  }

  async #observeTargetTransport(
    session: ManagedWorkerSession,
    targetMissionId: string,
    input: WorkerInput,
    onTargetText?: (text: string) => void,
    onTargetTerminalText?: (text: string) => void,
  ): Promise<CoordinatorLiveTransportObservation> {
    let displayedChars = 0;
    const observedEventKinds = new Set<WorkerEvent["type"]>();
    let eventCount = 0;
    let terminalStatus: WorkerTerminalStatus | undefined;
    let terminalError: string | undefined;
    let hostStopReason: CoordinatorLiveTransportObservation["hostStopReason"];
    for await (const event of this.workers.send(session.managedSessionId, input)) {
      const finalText = event.type === "terminal" && displayedChars === 0 && event.result && typeof event.result === "object"
        ? Object.getOwnPropertyDescriptor(event.result, "text")?.value : undefined;
      const displayText = event.type === "text_delta" ? event.text : typeof finalText === "string" ? finalText : undefined;
      if (displayText && onTargetText && displayedChars < 64_000) {
        const text = displayText.slice(0, 64_000 - displayedChars);
        displayedChars += text.length;
        // Display is an ephemeral observer, never command authority or durable memory.
        // A closed UI cannot change execution settlement or cause a resend.
        try { onTargetText(text); } catch { /* presentation failure has no semantic effect */ }
      }
      eventCount += 1;
      observedEventKinds.add(event.type);
      if (hostStopReason && event.type === "capability_call") continue;
      if (event.type === "capability_call" && event.dispatch === "host-requested") {
        if (!this.hostCapabilityExecution) {
          throw new Error(`Target Worker emitted host-requested capability ${event.name}, but production host capability execution is not configured.`);
        }
        if (!event.callId) throw new Error(`Target Worker host-requested capability ${event.name} is missing callId.`);
        const executionId = typeof event.extensions?.executionId === "string" ? event.extensions.executionId : "";
        if (!executionId) throw new Error(`Target Worker host-requested capability ${event.name} is missing Nimora executionId.`);
        const occurrenceId = typeof event.extensions?.occurrenceId === "string" && event.extensions.occurrenceId.trim()
          ? event.extensions.occurrenceId
          : undefined;
        if (!session.taskId) throw new Error(`Target Worker host-requested capability ${event.name} requires a Task-bound WorkerSession.`);
        const dispatched = await dispatchHostCapabilityRequest(this.hostCapabilityExecution, {
          executionId,
          managedSessionId: session.managedSessionId,
          workerId: session.workerId,
          taskId: session.taskId,
          inputId: event.inputId,
          callId: event.callId,
          name: event.name,
          arguments: event.arguments,
          occurrenceId,
        }, this.workers);
        if (dispatched.status === "denied" && dispatched.result.extensions?.hostAuthorizationStoppedTurn === true) {
          terminalStatus = "error";
          terminalError = "自动执行已停止：工具未获预授权或权限已撤销。请审核新的权限后再提交新请求；不会重放本轮。";
          hostStopReason = "authorization-denied";
          await this.workers.interrupt(session.managedSessionId);
          continue;
        }
        if (dispatched.result.isError) {
          terminalStatus = "error";
          terminalError = `自动执行已停止：${event.name} 返回工具错误。执行和结果投递记录已保留；不会继续调用、重试或重放本轮。`;
          hostStopReason = "capability-error";
          await this.workers.interrupt(session.managedSessionId);
          continue;
        }
      }
      if (event.type === "terminal") {
        if (!hostStopReason) {
          terminalStatus = event.status;
          terminalError = typeof event.error === "string" && event.error.trim()
            ? event.error.trim().slice(0, 4_000)
            : undefined;
        }
        if (!hostStopReason && event.status === "completed" && onTargetTerminalText
          && event.result && typeof event.result === "object") {
          const semanticText = Object.getOwnPropertyDescriptor(event.result, "text")?.value;
          if (typeof semanticText === "string") {
            if (semanticText.length > 64_000) {
              throw new Error("Target Worker terminal semantic text exceeds the bounded 64000 character limit: " + input.inputId);
            }
            // Host-only semantic boundary. Never copy this into commandResult:
            // the Coordinator Provider transports the command but must not see
            // the Target Mission's semantic output.
            try { onTargetTerminalText(semanticText); } catch { /* observer failure grants no replay/send authority */ }
          }
        }
      }
    }
    if (!terminalStatus) {
      throw new Error(`Target Worker transport ${input.inputId} ended without a trustworthy terminal observation.`);
    }
    return {
      version: 1,
      kind: "coordinator-live-transport-observation",
      targetMissionId,
      inputId: input.inputId,
      terminalStatus,
      ...(terminalError === undefined ? {} : { terminalError }),
      ...(hostStopReason === undefined ? {} : { hostStopReason }),
      observedEventKinds: [...observedEventKinds].sort(),
      eventCount,
    };
  }
}
