import { createHash } from "node:crypto";
import type {
  AnswerExchange,
  AnswerExchangePayload,
  EvidenceExchange,
  MissionEvidenceReference,
  ProblemExchange,
  ProblemExchangePayload,
} from "./mission-collaboration-contract.js";
import type { MissionCollaborationStore } from "./mission-collaboration-store.js";
import type { ProjectStore } from "./project-store.js";
import type { TaskSnapshot, TaskSource } from "./task-contract.js";
import type { TaskRuntime } from "./task-runtime.js";

const MAX_ID_CHARS = 240;
const FEEDBACK_COGNITION_MISSION_TYPE = "feedback-cognition";
const FEEDBACK_COGNITION_COMPLETION_CRITERIA = [
  "A bounded Answer to the originating Practice Problem is durable and routed back to that Practice Mission.",
];

export interface MissionFeedbackRouteIdentity {
  projectId: string;
  practiceMissionId: string;
  problemExchangeId: string;
}

export interface MissionFeedbackEvidenceFact {
  exchangeId: string;
  sourceMissionId: string;
  targetMissionId?: string;
  summary: string;
  references: MissionEvidenceReference[];
}

export interface MissionFeedbackProblemFact extends ProblemExchangePayload {
  exchangeId: string;
}

export interface MissionFeedbackAnswerFact extends AnswerExchangePayload {
  exchangeId: string;
  sourceMissionId: string;
  replyToExchangeId: string;
}

export interface CognitionFeedbackInputPackage {
  version: 1;
  kind: "cognition-feedback-input";
  projectId: string;
  cognitionMissionId: string;
  practiceMissionId: string;
  problemExchangeId: string;
  spawnedByRelationId: string;
  problem: MissionFeedbackProblemFact;
  evidence: MissionFeedbackEvidenceFact[];
}

export interface PracticeFeedbackContinuationPackage {
  version: 1;
  kind: "practice-feedback-continuation";
  projectId: string;
  practiceMissionId: string;
  cognitionMissionId: string;
  problemExchangeId: string;
  answerExchangeId: string;
  answersRelationId?: string;
  route: {
    targetMissionId: string;
  };
  problem: MissionFeedbackProblemFact;
  answer: MissionFeedbackAnswerFact;
  evidence: MissionFeedbackEvidenceFact[];
}

export interface EnsuredFeedbackCognition {
  cognitionMission: TaskSnapshot;
  input: CognitionFeedbackInputPackage;
}

export interface RecordFeedbackAnswerInput extends MissionFeedbackRouteIdentity {
  answerExchangeId: string;
  answer: string;
  evidenceExchangeIds?: string[];
  limitations?: string;
}

export interface RecordedFeedbackAnswer {
  answer: AnswerExchange;
  continuation: PracticeFeedbackContinuationPackage;
}

interface ResolvedFeedbackProblem {
  identity: MissionFeedbackRouteIdentity;
  practiceMission: TaskSnapshot;
  problem: ProblemExchange;
  cognitionSource: TaskSource;
  operationDigest: string;
}

function boundedIdentity(value: string, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > MAX_ID_CHARS) throw new Error(`${label} must be at most ${MAX_ID_CHARS} characters.`);
  return normalized;
}

function normalizedIdentity(input: MissionFeedbackRouteIdentity): MissionFeedbackRouteIdentity {
  return {
    projectId: boundedIdentity(input.projectId, "Project id"),
    practiceMissionId: boundedIdentity(input.practiceMissionId, "Practice Mission id"),
    problemExchangeId: boundedIdentity(input.problemExchangeId, "Problem exchange id"),
  };
}

function feedbackOperationDigest(input: MissionFeedbackRouteIdentity): string {
  const identity = normalizedIdentity(input);
  return createHash("sha256")
    .update(`mission-feedback-v1\0${identity.projectId}\0${identity.practiceMissionId}\0${identity.problemExchangeId}`)
    .digest("hex");
}

/** Stable Task source identity used to reconstruct/reuse the Cognition Mission after restart. */
export function missionFeedbackCognitionSource(input: MissionFeedbackRouteIdentity): TaskSource {
  return {
    kind: "mission",
    key: `feedback:cognition:v1:${feedbackOperationDigest(input)}`,
  };
}

export function missionFeedbackSpawnedByRelationId(input: MissionFeedbackRouteIdentity): string {
  return `feedback:spawned-by:v1:${feedbackOperationDigest(input)}`;
}

export function missionFeedbackAnswersRelationId(input: MissionFeedbackRouteIdentity, answerExchangeId: string): string {
  const answerId = boundedIdentity(answerExchangeId, "Answer exchange id");
  const digest = createHash("sha256")
    .update(`mission-feedback-answer-v1\0${feedbackOperationDigest(input)}\0${answerId}`)
    .digest("hex");
  return `feedback:answers:v1:${digest}`;
}

/**
 * Deterministic Phase 4 control seam. It composes the existing durable owners
 * and intentionally owns no journal, scheduler state, Worker lifecycle, or
 * provider/model choice. Every recoverable step is derived from ProjectStore,
 * TaskRuntime and MissionCollaborationStore facts.
 */
export class MissionFeedbackService {
  constructor(
    private readonly projects: ProjectStore,
    private readonly tasks: TaskRuntime,
    private readonly collaboration: MissionCollaborationStore,
  ) {}

  async ensureCognitionForProblem(input: MissionFeedbackRouteIdentity): Promise<EnsuredFeedbackCognition> {
    await this.initialize();
    const resolved = this.resolveProblem(input);
    const existing = this.tasks.findTaskBySource(resolved.cognitionSource);
    if (resolved.problem.targetMissionId && resolved.problem.targetMissionId !== existing?.taskId) {
      throw new Error(
        `Problem ${resolved.problem.exchangeId} is already targeted to a different Cognition Mission: ${resolved.problem.targetMissionId}.`,
      );
    }

    const task = await this.tasks.ensureTask(
      resolved.cognitionSource,
      `Resolve Practice Problem ${resolved.problem.exchangeId}.`,
    );
    if (resolved.problem.targetMissionId && resolved.problem.targetMissionId !== task.taskId) {
      throw new Error(`Problem ${resolved.problem.exchangeId} target does not match its deterministic feedback Cognition Mission.`);
    }

    const cognitionMission = await this.tasks.configureMission(task.taskId, {
      projectId: resolved.identity.projectId,
      rootMissionId: task.taskId,
      plane: "cognition",
      missionType: FEEDBACK_COGNITION_MISSION_TYPE,
      completionCriteria: [...FEEDBACK_COGNITION_COMPLETION_CRITERIA],
    });
    await this.collaboration.recordRelation({
      relationId: missionFeedbackSpawnedByRelationId(resolved.identity),
      projectId: resolved.identity.projectId,
      sourceMissionId: cognitionMission.taskId,
      targetMissionId: resolved.identity.practiceMissionId,
      type: "spawned_by",
      basisExchangeId: resolved.identity.problemExchangeId,
    });

    return {
      cognitionMission,
      input: this.buildCognitionInputFromResolved(resolved, cognitionMission),
    };
  }

  async buildCognitionInput(input: MissionFeedbackRouteIdentity): Promise<CognitionFeedbackInputPackage> {
    await this.initialize();
    const resolved = this.resolveProblem(input);
    const cognitionMission = this.requireFeedbackCognition(resolved);
    this.requireSpawnedByRelation(resolved, cognitionMission.taskId);
    return this.buildCognitionInputFromResolved(resolved, cognitionMission);
  }

  async recordAnswer(input: RecordFeedbackAnswerInput): Promise<RecordedFeedbackAnswer> {
    const identity = normalizedIdentity(input);
    const ensured = await this.ensureCognitionForProblem(identity);
    const answer = await this.collaboration.recordExchange({
      exchangeId: boundedIdentity(input.answerExchangeId, "Answer exchange id"),
      projectId: identity.projectId,
      sourceMissionId: ensured.cognitionMission.taskId,
      targetMissionId: identity.practiceMissionId,
      kind: "Answer",
      replyToExchangeId: identity.problemExchangeId,
      payload: {
        answer: input.answer,
        evidenceExchangeIds: input.evidenceExchangeIds ?? [],
        ...(input.limitations === undefined ? {} : { limitations: input.limitations }),
      },
    });
    if (answer.kind !== "Answer") throw new Error(`Recorded feedback exchange ${answer.exchangeId} is not an Answer.`);

    await this.collaboration.recordRelation({
      relationId: missionFeedbackAnswersRelationId(identity, answer.exchangeId),
      projectId: identity.projectId,
      sourceMissionId: ensured.cognitionMission.taskId,
      targetMissionId: identity.practiceMissionId,
      type: "answers",
      basisExchangeId: answer.exchangeId,
    });

    return {
      answer,
      continuation: await this.buildPracticeContinuation({ ...identity, answerExchangeId: answer.exchangeId }),
    };
  }

  async buildPracticeContinuation(
    input: MissionFeedbackRouteIdentity & { answerExchangeId: string },
  ): Promise<PracticeFeedbackContinuationPackage> {
    await this.initialize();
    const resolved = this.resolveProblem(input);
    const cognitionMission = this.requireFeedbackCognition(resolved);
    this.requireSpawnedByRelation(resolved, cognitionMission.taskId);
    const answerId = boundedIdentity(input.answerExchangeId, "Answer exchange id");
    const candidate = this.collaboration.getExchange(answerId);
    if (!candidate) throw new Error(`Unknown Answer exchange: ${answerId}`);
    if (candidate.kind !== "Answer") throw new Error(`Feedback continuation requires an Answer exchange: ${answerId}`);
    if (candidate.projectId !== resolved.identity.projectId) throw new Error("Feedback Answer belongs to a different Project.");
    if (candidate.replyToExchangeId !== resolved.identity.problemExchangeId) {
      throw new Error(`Feedback Answer ${answerId} replies to a different Problem.`);
    }
    if (candidate.targetMissionId !== resolved.identity.practiceMissionId) {
      throw new Error(`Feedback Answer ${answerId} targets a different Practice Mission.`);
    }
    if (candidate.sourceMissionId !== cognitionMission.taskId) {
      throw new Error(`Feedback Answer ${answerId} comes from a different Cognition Mission.`);
    }

    const answersRelationId = missionFeedbackAnswersRelationId(resolved.identity, candidate.exchangeId);
    const answersRelation = this.collaboration.getRelation(answersRelationId);
    if (answersRelation && (
      answersRelation.type !== "answers"
      || answersRelation.projectId !== resolved.identity.projectId
      || answersRelation.sourceMissionId !== cognitionMission.taskId
      || answersRelation.targetMissionId !== resolved.identity.practiceMissionId
      || answersRelation.basisExchangeId !== candidate.exchangeId
    )) {
      throw new Error(`Feedback answers relation identity collision: ${answersRelationId}`);
    }

    const evidenceIds = [...new Set([
      ...resolved.problem.payload.evidenceExchangeIds,
      ...candidate.payload.evidenceExchangeIds,
    ])];
    return {
      version: 1,
      kind: "practice-feedback-continuation",
      projectId: resolved.identity.projectId,
      practiceMissionId: resolved.identity.practiceMissionId,
      cognitionMissionId: cognitionMission.taskId,
      problemExchangeId: resolved.identity.problemExchangeId,
      answerExchangeId: candidate.exchangeId,
      ...(answersRelation ? { answersRelationId } : {}),
      route: { targetMissionId: resolved.identity.practiceMissionId },
      problem: this.problemFact(resolved.problem),
      answer: this.answerFact(candidate),
      evidence: this.evidenceFacts(resolved.identity.projectId, evidenceIds),
    };
  }

  private async initialize(): Promise<void> {
    await Promise.all([
      this.projects.initialize(),
      this.tasks.initialize(),
      this.collaboration.initialize(),
    ]);
  }

  private resolveProblem(input: MissionFeedbackRouteIdentity): ResolvedFeedbackProblem {
    const identity = normalizedIdentity(input);
    if (!this.projects.getProject(identity.projectId)) throw new Error(`Unknown Project: ${identity.projectId}`);
    const practiceMission = this.tasks.getTask(identity.practiceMissionId);
    if (!practiceMission) throw new Error(`Practice Mission does not exist: ${identity.practiceMissionId}`);
    if (!practiceMission.mission) throw new Error(`Practice endpoint is not configured as a Mission: ${identity.practiceMissionId}`);
    if (practiceMission.mission.projectId !== identity.projectId) {
      throw new Error(`Practice Mission ${identity.practiceMissionId} does not belong to Project ${identity.projectId}.`);
    }
    if (practiceMission.mission.plane !== "practice") {
      throw new Error(`Feedback Problem source must be a Practice Mission: ${identity.practiceMissionId}`);
    }

    const candidate = this.collaboration.getExchange(identity.problemExchangeId);
    if (!candidate) throw new Error(`Unknown Problem exchange: ${identity.problemExchangeId}`);
    if (candidate.kind !== "Problem") throw new Error(`Feedback routing requires a Problem exchange: ${identity.problemExchangeId}`);
    if (candidate.projectId !== identity.projectId) throw new Error("Feedback Problem belongs to a different Project.");
    if (candidate.sourceMissionId !== identity.practiceMissionId) {
      throw new Error(`Feedback Problem ${identity.problemExchangeId} comes from a different Practice Mission.`);
    }

    return {
      identity,
      practiceMission,
      problem: candidate,
      cognitionSource: missionFeedbackCognitionSource(identity),
      operationDigest: feedbackOperationDigest(identity),
    };
  }

  private requireFeedbackCognition(resolved: ResolvedFeedbackProblem): TaskSnapshot {
    const cognitionMission = this.tasks.findTaskBySource(resolved.cognitionSource);
    if (!cognitionMission) throw new Error(`Feedback Cognition Mission does not exist for Problem ${resolved.problem.exchangeId}.`);
    if (!cognitionMission.mission) throw new Error(`Feedback Cognition Task ${cognitionMission.taskId} is not configured as a Mission.`);
    const mission = cognitionMission.mission;
    if (mission.projectId !== resolved.identity.projectId
      || mission.rootMissionId !== cognitionMission.taskId
      || mission.parentMissionId !== undefined
      || mission.plane !== "cognition"
      || mission.missionType !== FEEDBACK_COGNITION_MISSION_TYPE) {
      throw new Error(`Feedback Cognition Mission identity collision for operation ${resolved.operationDigest}.`);
    }
    if (resolved.problem.targetMissionId && resolved.problem.targetMissionId !== cognitionMission.taskId) {
      throw new Error(`Problem ${resolved.problem.exchangeId} targets a different Cognition Mission.`);
    }
    return cognitionMission;
  }

  private requireSpawnedByRelation(resolved: ResolvedFeedbackProblem, cognitionMissionId: string): void {
    const relationId = missionFeedbackSpawnedByRelationId(resolved.identity);
    const relation = this.collaboration.getRelation(relationId);
    if (!relation) throw new Error(`Feedback spawned_by relation does not exist: ${relationId}`);
    if (relation.type !== "spawned_by"
      || relation.projectId !== resolved.identity.projectId
      || relation.sourceMissionId !== cognitionMissionId
      || relation.targetMissionId !== resolved.identity.practiceMissionId
      || relation.basisExchangeId !== resolved.identity.problemExchangeId) {
      throw new Error(`Feedback spawned_by relation identity collision: ${relationId}`);
    }
  }

  private buildCognitionInputFromResolved(
    resolved: ResolvedFeedbackProblem,
    cognitionMission: TaskSnapshot,
  ): CognitionFeedbackInputPackage {
    return {
      version: 1,
      kind: "cognition-feedback-input",
      projectId: resolved.identity.projectId,
      cognitionMissionId: cognitionMission.taskId,
      practiceMissionId: resolved.identity.practiceMissionId,
      problemExchangeId: resolved.identity.problemExchangeId,
      spawnedByRelationId: missionFeedbackSpawnedByRelationId(resolved.identity),
      problem: this.problemFact(resolved.problem),
      evidence: this.evidenceFacts(resolved.identity.projectId, resolved.problem.payload.evidenceExchangeIds),
    };
  }

  private problemFact(problem: ProblemExchange): MissionFeedbackProblemFact {
    return {
      exchangeId: problem.exchangeId,
      currentGoal: problem.payload.currentGoal,
      previousAssumption: problem.payload.previousAssumption,
      observedReality: problem.payload.observedReality,
      preciseQuestion: problem.payload.preciseQuestion,
      blocking: problem.payload.blocking,
      evidenceExchangeIds: [...problem.payload.evidenceExchangeIds],
    };
  }

  private answerFact(answer: AnswerExchange): MissionFeedbackAnswerFact {
    return {
      exchangeId: answer.exchangeId,
      sourceMissionId: answer.sourceMissionId,
      replyToExchangeId: answer.replyToExchangeId,
      answer: answer.payload.answer,
      evidenceExchangeIds: [...answer.payload.evidenceExchangeIds],
      ...(answer.payload.limitations === undefined ? {} : { limitations: answer.payload.limitations }),
    };
  }

  private evidenceFacts(projectId: string, exchangeIds: readonly string[]): MissionFeedbackEvidenceFact[] {
    return exchangeIds.map(exchangeId => {
      const candidate = this.collaboration.getExchange(exchangeId);
      if (!candidate) throw new Error(`Feedback Evidence exchange does not exist: ${exchangeId}`);
      if (candidate.kind !== "Evidence") throw new Error(`Feedback Evidence id does not reference Evidence: ${exchangeId}`);
      if (candidate.projectId !== projectId) throw new Error(`Feedback Evidence ${exchangeId} belongs to a different Project.`);
      return this.evidenceFact(candidate);
    });
  }

  private evidenceFact(evidence: EvidenceExchange): MissionFeedbackEvidenceFact {
    return {
      exchangeId: evidence.exchangeId,
      sourceMissionId: evidence.sourceMissionId,
      ...(evidence.targetMissionId === undefined ? {} : { targetMissionId: evidence.targetMissionId }),
      summary: evidence.payload.summary,
      references: structuredClone(evidence.payload.references),
    };
  }
}
