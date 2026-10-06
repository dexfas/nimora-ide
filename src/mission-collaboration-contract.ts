export const EXPLICIT_MISSION_RELATION_TYPES = [
  "spawned_by",
  "depends_on",
  "informs",
  "answers",
  "blocks",
  "validates",
  "supersedes",
] as const;

export type ExplicitMissionRelationType = typeof EXPLICIT_MISSION_RELATION_TYPES[number];

export interface ExplicitMissionRelation {
  relationId: string;
  projectId: string;
  sourceMissionId: string;
  targetMissionId: string;
  type: ExplicitMissionRelationType;
  createdAt: string;
  basisExchangeId?: string;
}

export interface DerivedParentMissionRelation {
  relationId: string;
  projectId: string;
  sourceMissionId: string;
  targetMissionId: string;
  type: "parent_of";
  createdAt: string;
  derived: true;
}

export type MissionGraphRelation = ExplicitMissionRelation | DerivedParentMissionRelation;

export interface ArtifactEvidenceReference {
  type: "artifact";
  missionId: string;
  artifactId: string;
}

export interface FileEvidenceReference {
  type: "file";
  path: string;
  detail?: string;
}

export interface UrlEvidenceReference {
  type: "url";
  url: string;
  detail?: string;
}

export interface CommandEvidenceReference {
  type: "command";
  command: string;
  observation: string;
}

export type MissionEvidenceReference =
  | ArtifactEvidenceReference
  | FileEvidenceReference
  | UrlEvidenceReference
  | CommandEvidenceReference;

export interface FindingExchangePayload {
  summary: string;
  evidenceExchangeIds: string[];
}

export interface ProblemExchangePayload {
  currentGoal: string;
  previousAssumption: string;
  observedReality: string;
  preciseQuestion: string;
  blocking: boolean;
  evidenceExchangeIds: string[];
}

export interface EvidenceExchangePayload {
  summary: string;
  references: MissionEvidenceReference[];
}

export interface AnswerExchangePayload {
  answer: string;
  evidenceExchangeIds: string[];
  limitations?: string;
}

export interface HandoffExchangePayload {
  artifactId: string;
  sourceTaskEventId: string;
  sourceTaskEventCount: number;
  contentDigest: string;
}

interface MissionExchangeBase<K extends string, P> {
  exchangeId: string;
  projectId: string;
  sourceMissionId: string;
  targetMissionId?: string;
  kind: K;
  createdAt: string;
  payload: P;
}

export type FindingExchange = MissionExchangeBase<"Finding", FindingExchangePayload>;
export type ProblemExchange = MissionExchangeBase<"Problem", ProblemExchangePayload>;
export type EvidenceExchange = MissionExchangeBase<"Evidence", EvidenceExchangePayload>;
export type AnswerExchange = MissionExchangeBase<"Answer", AnswerExchangePayload> & { replyToExchangeId: string };
export type HandoffExchange = MissionExchangeBase<"Handoff", HandoffExchangePayload>;

export type MissionExchange =
  | FindingExchange
  | ProblemExchange
  | EvidenceExchange
  | AnswerExchange
  | HandoffExchange;

type OptionalCreatedAt<T> = T extends unknown
  ? Omit<T, "createdAt"> & { createdAt?: string }
  : never;

export type ExplicitMissionRelationInput = OptionalCreatedAt<ExplicitMissionRelation>;
export type MissionExchangeInput = OptionalCreatedAt<MissionExchange>;
