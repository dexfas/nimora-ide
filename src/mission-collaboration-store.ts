import { promises as fs } from "node:fs";
import path from "node:path";
import {
  EXPLICIT_MISSION_RELATION_TYPES,
  type ExplicitMissionRelation,
  type ExplicitMissionRelationInput,
  type ExplicitMissionRelationType,
  type MissionEvidenceReference,
  type MissionExchange,
  type MissionExchangeInput,
  type MissionGraphRelation,
} from "./mission-collaboration-contract.js";
import { getMissionFinalHandoff } from "./mission-finalization-service.js";
import type { ProjectStore } from "./project-store.js";
import type { TaskRuntime } from "./task-runtime.js";
import type { TaskSnapshot } from "./task-contract.js";

export const MISSION_COLLABORATION_JOURNAL = "mission-collaboration-v1.jsonl";

const MAX_ID_CHARS = 240;
const MAX_SUMMARY_CHARS = 6_000;
const MAX_DETAIL_CHARS = 2_000;
const MAX_PROBLEM_REALITY_CHARS = 8_000;
const MAX_REFERENCE_ITEMS = 32;
const MAX_FILE_PATH_CHARS = 2_000;
const MAX_URL_CHARS = 4_000;
const MAX_COMMAND_CHARS = 2_000;
const MAX_OBSERVATION_CHARS = 6_000;
const MAX_DIGEST_CHARS = 160;
const EXPLICIT_RELATION_TYPE_SET = new Set<string>(EXPLICIT_MISSION_RELATION_TYPES);

type CollaborationJournalRecord =
  | { version: 1; recordType: "relation"; record: ExplicitMissionRelation }
  | { version: 1; recordType: "exchange"; record: MissionExchange };

export interface MissionCollaborationStoreOptions {
  storageDirectory: string;
  projects: ProjectStore;
  tasks: TaskRuntime;
  log?: (message: string) => void;
  now?: () => Date;
  onDidRecordExchange?: (exchange: MissionExchange) => void;
}

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
  for (const key of Object.keys(row)) {
    if (!allowedSet.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
  }
}

function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > MAX_ID_CHARS) throw new Error(`${label} must be at most ${MAX_ID_CHARS} characters.`);
  return normalized;
}

function boundedText(value: unknown, maxChars: number, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters.`);
  return normalized;
}

function timestamp(value: unknown, fallback: string | undefined, label: string): string {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== "string" || !candidate.trim()) throw new Error(`${label} must be an ISO timestamp.`);
  const parsed = Date.parse(candidate);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp.`);
  return new Date(parsed).toISOString();
}

function boundedIdList(value: unknown, label: string, { requireOne = false }: { requireOne?: boolean } = {}): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (requireOne && value.length === 0) throw new Error(`${label} must contain at least one item.`);
  if (value.length > MAX_REFERENCE_ITEMS) throw new Error(`${label} must contain at most ${MAX_REFERENCE_ITEMS} items.`);
  const result = value.map((item, index) => boundedId(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicate ids.`);
  return result;
}

function normalizeEvidenceReference(value: unknown, index: number): MissionEvidenceReference {
  const row = objectValue(value, `Evidence reference ${index + 1}`);
  const type = row.type;
  if (type === "artifact") {
    exactKeys(row, ["type", "missionId", "artifactId"], `Evidence reference ${index + 1}`);
    return {
      type,
      missionId: boundedId(row.missionId, `Evidence reference ${index + 1} missionId`),
      artifactId: boundedId(row.artifactId, `Evidence reference ${index + 1} artifactId`),
    };
  }
  if (type === "file") {
    exactKeys(row, ["type", "path", "detail"], `Evidence reference ${index + 1}`);
    return {
      type,
      path: boundedText(row.path, MAX_FILE_PATH_CHARS, `Evidence reference ${index + 1} path`),
      ...(row.detail === undefined ? {} : { detail: boundedText(row.detail, MAX_DETAIL_CHARS, `Evidence reference ${index + 1} detail`) }),
    };
  }
  if (type === "url") {
    exactKeys(row, ["type", "url", "detail"], `Evidence reference ${index + 1}`);
    const url = boundedText(row.url, MAX_URL_CHARS, `Evidence reference ${index + 1} url`);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Evidence reference ${index + 1} url must be an absolute URL.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Evidence reference ${index + 1} url must use http or https.`);
    }
    return {
      type,
      url: parsed.toString(),
      ...(row.detail === undefined ? {} : { detail: boundedText(row.detail, MAX_DETAIL_CHARS, `Evidence reference ${index + 1} detail`) }),
    };
  }
  if (type === "command") {
    exactKeys(row, ["type", "command", "observation"], `Evidence reference ${index + 1}`);
    return {
      type,
      command: boundedText(row.command, MAX_COMMAND_CHARS, `Evidence reference ${index + 1} command`),
      observation: boundedText(row.observation, MAX_OBSERVATION_CHARS, `Evidence reference ${index + 1} observation`),
    };
  }
  throw new Error(`Unsupported Evidence reference type: ${String(type)}`);
}

function normalizeExchange(input: unknown, fallbackCreatedAt?: string): MissionExchange {
  const row = objectValue(input, "Mission exchange");
  exactKeys(row, ["exchangeId", "projectId", "sourceMissionId", "targetMissionId", "kind", "createdAt", "replyToExchangeId", "payload"], "Mission exchange");
  const base = {
    exchangeId: boundedId(row.exchangeId, "Exchange id"),
    projectId: boundedId(row.projectId, "Project id"),
    sourceMissionId: boundedId(row.sourceMissionId, "Source Mission id"),
    ...(row.targetMissionId === undefined ? {} : { targetMissionId: boundedId(row.targetMissionId, "Target Mission id") }),
    createdAt: timestamp(row.createdAt, fallbackCreatedAt, "Exchange createdAt"),
  };
  const payload = objectValue(row.payload, `${String(row.kind)} exchange payload`);
  if (row.kind === "Finding") {
    if (row.replyToExchangeId !== undefined) throw new Error("Finding exchange must not declare replyToExchangeId.");
    exactKeys(payload, ["summary", "evidenceExchangeIds"], "Finding exchange payload");
    return {
      ...base,
      kind: "Finding",
      payload: {
        summary: boundedText(payload.summary, MAX_SUMMARY_CHARS, "Finding summary"),
        evidenceExchangeIds: boundedIdList(payload.evidenceExchangeIds, "Finding evidenceExchangeIds"),
      },
    };
  }
  if (row.kind === "Problem") {
    if (row.replyToExchangeId !== undefined) throw new Error("Problem exchange must not declare replyToExchangeId.");
    exactKeys(payload, ["currentGoal", "previousAssumption", "observedReality", "preciseQuestion", "blocking", "evidenceExchangeIds"], "Problem exchange payload");
    if (typeof payload.blocking !== "boolean") throw new Error("Problem blocking must be a boolean.");
    return {
      ...base,
      kind: "Problem",
      payload: {
        currentGoal: boundedText(payload.currentGoal, MAX_SUMMARY_CHARS, "Problem currentGoal"),
        previousAssumption: boundedText(payload.previousAssumption, MAX_SUMMARY_CHARS, "Problem previousAssumption"),
        observedReality: boundedText(payload.observedReality, MAX_PROBLEM_REALITY_CHARS, "Problem observedReality"),
        preciseQuestion: boundedText(payload.preciseQuestion, MAX_SUMMARY_CHARS, "Problem preciseQuestion"),
        blocking: payload.blocking,
        evidenceExchangeIds: boundedIdList(payload.evidenceExchangeIds, "Problem evidenceExchangeIds", { requireOne: true }),
      },
    };
  }
  if (row.kind === "Evidence") {
    if (row.replyToExchangeId !== undefined) throw new Error("Evidence exchange must not declare replyToExchangeId.");
    exactKeys(payload, ["summary", "references"], "Evidence exchange payload");
    if (!Array.isArray(payload.references)) throw new Error("Evidence references must be an array.");
    if (payload.references.length === 0) throw new Error("Evidence references must contain at least one item.");
    if (payload.references.length > MAX_REFERENCE_ITEMS) throw new Error(`Evidence references must contain at most ${MAX_REFERENCE_ITEMS} items.`);
    return {
      ...base,
      kind: "Evidence",
      payload: {
        summary: boundedText(payload.summary, MAX_SUMMARY_CHARS, "Evidence summary"),
        references: payload.references.map((reference, index) => normalizeEvidenceReference(reference, index)),
      },
    };
  }
  if (row.kind === "Answer") {
    exactKeys(payload, ["answer", "evidenceExchangeIds", "limitations"], "Answer exchange payload");
    return {
      ...base,
      kind: "Answer",
      replyToExchangeId: boundedId(row.replyToExchangeId, "Answer replyToExchangeId"),
      payload: {
        answer: boundedText(payload.answer, MAX_PROBLEM_REALITY_CHARS, "Answer text"),
        evidenceExchangeIds: boundedIdList(payload.evidenceExchangeIds, "Answer evidenceExchangeIds"),
        ...(payload.limitations === undefined ? {} : { limitations: boundedText(payload.limitations, MAX_DETAIL_CHARS, "Answer limitations") }),
      },
    };
  }
  if (row.kind === "Handoff") {
    if (row.replyToExchangeId !== undefined) throw new Error("Handoff exchange must not declare replyToExchangeId.");
    exactKeys(payload, ["artifactId", "sourceTaskEventId", "sourceTaskEventCount", "contentDigest"], "Handoff exchange payload");
    if (!Number.isInteger(payload.sourceTaskEventCount) || (payload.sourceTaskEventCount as number) < 1) {
      throw new Error("Handoff sourceTaskEventCount must be a positive integer.");
    }
    return {
      ...base,
      kind: "Handoff",
      payload: {
        artifactId: boundedId(payload.artifactId, "Handoff artifactId"),
        sourceTaskEventId: boundedId(payload.sourceTaskEventId, "Handoff sourceTaskEventId"),
        sourceTaskEventCount: payload.sourceTaskEventCount as number,
        contentDigest: boundedText(payload.contentDigest, MAX_DIGEST_CHARS, "Handoff contentDigest"),
      },
    };
  }
  throw new Error(`Unsupported exchange kind: ${String(row.kind)}`);
}

function normalizeRelation(input: unknown, fallbackCreatedAt?: string): ExplicitMissionRelation {
  const row = objectValue(input, "Mission relation");
  exactKeys(row, ["relationId", "projectId", "sourceMissionId", "targetMissionId", "type", "createdAt", "basisExchangeId"], "Mission relation");
  if (typeof row.type !== "string" || !EXPLICIT_RELATION_TYPE_SET.has(row.type)) {
    throw new Error(`Unsupported explicit Mission relation type: ${String(row.type)}`);
  }
  return {
    relationId: boundedId(row.relationId, "Relation id"),
    projectId: boundedId(row.projectId, "Project id"),
    sourceMissionId: boundedId(row.sourceMissionId, "Source Mission id"),
    targetMissionId: boundedId(row.targetMissionId, "Target Mission id"),
    type: row.type as ExplicitMissionRelationType,
    createdAt: timestamp(row.createdAt, fallbackCreatedAt, "Relation createdAt"),
    ...(row.basisExchangeId === undefined ? {} : { basisExchangeId: boundedId(row.basisExchangeId, "Relation basisExchangeId") }),
  };
}

function normalizeJournalRecord(value: unknown): CollaborationJournalRecord {
  const row = objectValue(value, "Collaboration journal record");
  exactKeys(row, ["version", "recordType", "record"], "Collaboration journal record");
  if (row.version !== 1) throw new Error(`Unsupported collaboration journal version: ${String(row.version)}`);
  if (row.recordType === "exchange") return { version: 1, recordType: "exchange", record: normalizeExchange(row.record) };
  if (row.recordType === "relation") return { version: 1, recordType: "relation", record: normalizeRelation(row.record) };
  throw new Error(`Unsupported collaboration record type: ${String(row.recordType)}`);
}

export class MissionCollaborationStore {
  private readonly relations = new Map<string, ExplicitMissionRelation>();
  private readonly exchanges = new Map<string, MissionExchange>();
  private initializePromise: Promise<void> | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private operationChain: Promise<void> = Promise.resolve();
  private journalNeedsSeparator = false;

  constructor(private readonly options: MissionCollaborationStoreOptions) {}

  async initialize(): Promise<void> {
    if (!this.initializePromise) this.initializePromise = this.load();
    return this.initializePromise;
  }

  getExchange(exchangeId: string): MissionExchange | undefined {
    const exchange = this.exchanges.get(exchangeId);
    return exchange ? structuredClone(exchange) : undefined;
  }

  getRelation(relationId: string): ExplicitMissionRelation | undefined {
    const relation = this.relations.get(relationId);
    return relation ? structuredClone(relation) : undefined;
  }

  listExchanges(projectId: string): MissionExchange[] {
    return [...this.exchanges.values()]
      .filter(exchange => exchange.projectId === projectId)
      .map(exchange => structuredClone(exchange))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.exchangeId.localeCompare(b.exchangeId));
  }

  listRelations(projectId: string, options: { includeDerivedParent?: boolean } = {}): MissionGraphRelation[] {
    const explicit: MissionGraphRelation[] = [...this.relations.values()]
      .filter(relation => relation.projectId === projectId)
      .map(relation => structuredClone(relation));
    if (options.includeDerivedParent ?? true) {
      for (const task of this.options.tasks.listTasks()) {
        if (task.mission?.projectId !== projectId || !task.mission.parentMissionId) continue;
        explicit.push({
          relationId: `parent_of:${task.taskId}`,
          projectId,
          sourceMissionId: task.mission.parentMissionId,
          targetMissionId: task.taskId,
          type: "parent_of",
          createdAt: task.createdAt,
          derived: true,
        });
      }
    }
    return explicit.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.relationId.localeCompare(b.relationId));
  }

  async recordExchange(input: MissionExchangeInput): Promise<MissionExchange> {
    return this.exclusive(async () => {
      await this.initialize();
      const rawId = objectValue(input, "Mission exchange").exchangeId;
      const exchangeId = boundedId(rawId, "Exchange id");
      const current = this.exchanges.get(exchangeId);
      const exchange = normalizeExchange(input, current?.createdAt ?? this.now());
      if (current) {
        if (stableJson(current) === stableJson(exchange)) return structuredClone(current);
        throw new Error(`Exchange identity collision: ${exchange.exchangeId}`);
      }
      this.validateExchange(exchange);
      await this.commit({ version: 1, recordType: "exchange", record: exchange });
      return structuredClone(this.exchanges.get(exchange.exchangeId)!);
    });
  }

  async recordRelation(input: ExplicitMissionRelationInput): Promise<ExplicitMissionRelation> {
    return this.exclusive(async () => {
      await this.initialize();
      const rawId = objectValue(input, "Mission relation").relationId;
      const relationId = boundedId(rawId, "Relation id");
      const current = this.relations.get(relationId);
      const relation = normalizeRelation(input, current?.createdAt ?? this.now());
      if (current) {
        if (stableJson(current) === stableJson(relation)) return structuredClone(current);
        throw new Error(`Relation identity collision: ${relation.relationId}`);
      }
      this.validateRelation(relation);
      await this.commit({ version: 1, recordType: "relation", record: relation });
      return structuredClone(this.relations.get(relation.relationId)!);
    });
  }

  /**
   * Narrow cross-owner stabilization point for readers that must make one
   * lifecycle decision against a collaboration snapshot and then mutate a
   * different owner. This reuses the exact operation lane that admits every
   * recordExchange()/recordRelation() write, so an earlier write is drained
   * before the callback starts and a later write cannot commit until it ends.
   *
   * The callback must not call recordExchange()/recordRelation() on this same
   * store because the operation lane is intentionally non-reentrant. It may
   * read collaboration state and call external lifecycle owners. No TaskRuntime
   * lane is held by this store while waiting for those owners.
   */
  async withMutationStabilization<T>(operation: () => Promise<T>): Promise<T> {
    return this.exclusive(async () => {
      await this.initialize();
      return operation();
    });
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private async load(): Promise<void> {
    await Promise.all([this.options.projects.initialize(), this.options.tasks.initialize()]);
    await fs.mkdir(this.options.storageDirectory, { recursive: true });
    const journalPath = path.join(this.options.storageDirectory, MISSION_COLLABORATION_JOURNAL);
    let raw: string;
    try {
      raw = await fs.readFile(journalPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.log(`failed to read collaboration journal: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    this.journalNeedsSeparator = raw.length > 0 && !raw.endsWith("\n");
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        const record = normalizeJournalRecord(JSON.parse(line));
        this.installValidatedRecord(record);
      } catch (error) {
        this.log(`ignored invalid collaboration record ${MISSION_COLLABORATION_JOURNAL}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.log(`loaded ${this.exchanges.size} exchange(s) and ${this.relations.size} explicit relation(s)`);
  }

  private installValidatedRecord(record: CollaborationJournalRecord): void {
    if (record.recordType === "exchange") {
      const current = this.exchanges.get(record.record.exchangeId);
      if (current) {
        if (stableJson(current) !== stableJson(record.record)) throw new Error(`Exchange identity collision: ${record.record.exchangeId}`);
        return;
      }
      this.validateExchange(record.record);
      this.exchanges.set(record.record.exchangeId, record.record);
      return;
    }
    const current = this.relations.get(record.record.relationId);
    if (current) {
      if (stableJson(current) !== stableJson(record.record)) throw new Error(`Relation identity collision: ${record.record.relationId}`);
      return;
    }
    this.validateRelation(record.record);
    this.relations.set(record.record.relationId, record.record);
  }

  private validateExchange(exchange: MissionExchange): void {
    this.requireProject(exchange.projectId);
    const source = this.requireMission(exchange.sourceMissionId, exchange.projectId, "Source");
    if (exchange.targetMissionId) this.requireMission(exchange.targetMissionId, exchange.projectId, "Target");

    if (exchange.kind === "Evidence") {
      for (const reference of exchange.payload.references) this.validateEvidenceReference(reference, exchange.projectId);
      return;
    }

    if (exchange.kind === "Finding") {
      this.requireEvidenceExchanges(exchange.payload.evidenceExchangeIds, exchange.projectId, "Finding");
      return;
    }

    if (exchange.kind === "Problem") {
      this.requireEvidenceExchanges(exchange.payload.evidenceExchangeIds, exchange.projectId, "Problem");
      return;
    }

    if (exchange.kind === "Answer") {
      const replyToExchangeId = exchange.replyToExchangeId;
      const problem = this.exchanges.get(replyToExchangeId);
      if (!problem) throw new Error(`Answer reply target does not exist: ${replyToExchangeId}`);
      if (problem.kind !== "Problem") throw new Error(`Answer replyToExchangeId must reference a Problem: ${replyToExchangeId}`);
      if (problem.projectId !== exchange.projectId) throw new Error("Answer cannot reply across Projects.");
      if (!exchange.targetMissionId) throw new Error("Answer requires targetMissionId.");
      if (exchange.targetMissionId !== problem.sourceMissionId) throw new Error("Answer targetMissionId must route back to the originating Problem Mission.");
      if (problem.targetMissionId && problem.targetMissionId !== exchange.sourceMissionId) {
        throw new Error("Answer sourceMissionId must match the Problem targetMissionId when the Problem had an explicit target.");
      }
      this.requireEvidenceExchanges(exchange.payload.evidenceExchangeIds, exchange.projectId, "Answer");
      return;
    }

    const handoff = getMissionFinalHandoff(source);
    if (!handoff || !source.missionFinalization) throw new Error(`Handoff source Mission ${exchange.sourceMissionId} has no verified final Handoff.`);
    if (handoff.artifactId !== exchange.payload.artifactId) throw new Error("Handoff artifactId does not match the verified final Handoff.");
    if (source.missionFinalization.handoffSourceEventId !== exchange.payload.sourceTaskEventId) throw new Error("Handoff sourceTaskEventId does not match the verified final Handoff.");
    if (source.missionFinalization.handoffSourceEventCount !== exchange.payload.sourceTaskEventCount) throw new Error("Handoff sourceTaskEventCount does not match the verified final Handoff.");
    if (source.missionFinalization.handoffContentDigest !== exchange.payload.contentDigest) throw new Error("Handoff contentDigest does not match the verified final Handoff.");
  }

  private validateEvidenceReference(reference: MissionEvidenceReference, projectId: string): void {
    if (reference.type !== "artifact") return;
    const mission = this.requireMission(reference.missionId, projectId, "Evidence artifact");
    const matches = mission.artifacts.filter(artifact => artifact.artifactId === reference.artifactId);
    if (matches.length !== 1) throw new Error(`Evidence artifact does not exist uniquely in Mission ${reference.missionId}: ${reference.artifactId}`);
  }

  private requireEvidenceExchanges(exchangeIds: readonly string[], projectId: string, ownerKind: string): void {
    for (const exchangeId of exchangeIds) {
      const evidence = this.exchanges.get(exchangeId);
      if (!evidence) throw new Error(`${ownerKind} Evidence exchange does not exist: ${exchangeId}`);
      if (evidence.kind !== "Evidence") throw new Error(`${ownerKind} evidenceExchangeIds must reference Evidence exchanges: ${exchangeId}`);
      if (evidence.projectId !== projectId) throw new Error(`${ownerKind} Evidence exchange cannot cross Projects: ${exchangeId}`);
    }
  }

  private validateRelation(relation: ExplicitMissionRelation): void {
    this.requireProject(relation.projectId);
    this.requireMission(relation.sourceMissionId, relation.projectId, "Source");
    this.requireMission(relation.targetMissionId, relation.projectId, "Target");
    if (relation.sourceMissionId === relation.targetMissionId) throw new Error("Explicit Mission relation cannot be a self-edge.");
    if (relation.basisExchangeId) this.validateRelationBasis(relation);
    if ((relation.type === "spawned_by" || relation.type === "supersedes")
      && this.relationPathExists(relation.type, relation.targetMissionId, relation.sourceMissionId)) {
      throw new Error(`${relation.type} relation would create a cycle.`);
    }
  }

  private validateRelationBasis(relation: ExplicitMissionRelation): void {
    const exchange = this.exchanges.get(relation.basisExchangeId!);
    if (!exchange) throw new Error(`Relation basis exchange does not exist: ${relation.basisExchangeId}`);
    if (exchange.projectId !== relation.projectId) throw new Error("Relation basis exchange cannot cross Projects.");
    if (relation.type === "spawned_by") {
      if (exchange.kind !== "Problem") throw new Error("spawned_by basisExchangeId must reference a Problem exchange.");
      if (exchange.sourceMissionId !== relation.targetMissionId) throw new Error("spawned_by Problem source must be the relation target Mission.");
      if (exchange.targetMissionId && exchange.targetMissionId !== relation.sourceMissionId) {
        throw new Error("spawned_by Problem target must match the spawned source Mission when present.");
      }
      return;
    }
    if (relation.type === "answers") {
      if (exchange.kind !== "Answer") throw new Error("answers basisExchangeId must reference an Answer exchange.");
      if (exchange.sourceMissionId !== relation.sourceMissionId || exchange.targetMissionId !== relation.targetMissionId) {
        throw new Error("answers basis exchange endpoints must match the relation endpoints.");
      }
      return;
    }
    if (relation.type === "informs") {
      if (exchange.kind !== "Finding") throw new Error("informs basisExchangeId must reference a Finding exchange.");
      if (exchange.sourceMissionId !== relation.sourceMissionId || (exchange.targetMissionId && exchange.targetMissionId !== relation.targetMissionId)) {
        throw new Error("informs basis exchange is incompatible with the relation endpoints.");
      }
      return;
    }
    if (relation.type === "validates") {
      if (exchange.kind !== "Evidence") throw new Error("validates basisExchangeId must reference an Evidence exchange.");
      if (exchange.sourceMissionId !== relation.sourceMissionId) throw new Error("validates Evidence source must match the relation source Mission.");
      return;
    }
    const touchesEndpoint = exchange.sourceMissionId === relation.sourceMissionId
      || exchange.sourceMissionId === relation.targetMissionId
      || exchange.targetMissionId === relation.sourceMissionId
      || exchange.targetMissionId === relation.targetMissionId;
    if (!touchesEndpoint) throw new Error("Relation basis exchange must involve at least one relation endpoint.");
  }

  private relationPathExists(type: "spawned_by" | "supersedes", fromMissionId: string, toMissionId: string): boolean {
    const edges = new Map<string, string[]>();
    for (const relation of this.relations.values()) {
      if (relation.type !== type) continue;
      const targets = edges.get(relation.sourceMissionId) ?? [];
      targets.push(relation.targetMissionId);
      edges.set(relation.sourceMissionId, targets);
    }
    const pending = [fromMissionId];
    const seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === toMissionId) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...(edges.get(current) ?? []));
    }
    return false;
  }

  private requireProject(projectId: string): void {
    if (!this.options.projects.getProject(projectId)) throw new Error(`Unknown Project: ${projectId}`);
  }

  private requireMission(missionId: string, projectId: string, role: string): TaskSnapshot {
    const task = this.options.tasks.getTask(missionId);
    if (!task) throw new Error(`${role} Mission does not exist: ${missionId}`);
    if (!task.mission) throw new Error(`${role} endpoint is not configured as a Mission: ${missionId}`);
    if (task.mission.projectId !== projectId) throw new Error(`${role} Mission ${missionId} does not belong to Project ${projectId}.`);
    return task;
  }

  private async commit(record: CollaborationJournalRecord): Promise<void> {
    const canonicalRecord = JSON.parse(JSON.stringify(record)) as CollaborationJournalRecord;
    const previous = this.writeChain;
    const next = previous.then(async () => {
      try {
        await fs.mkdir(this.options.storageDirectory, { recursive: true });
        const separator = this.journalNeedsSeparator ? "\n" : "";
        await fs.appendFile(path.join(this.options.storageDirectory, MISSION_COLLABORATION_JOURNAL), `${separator}${JSON.stringify(canonicalRecord)}\n`, "utf8");
        this.journalNeedsSeparator = false;
      } catch (error) {
        this.log(`failed to persist ${canonicalRecord.recordType}: ${error instanceof Error ? error.message : String(error)}`);
        throw new Error(`Mission collaboration persistence failed for ${canonicalRecord.recordType}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (canonicalRecord.recordType === "exchange") this.exchanges.set(canonicalRecord.record.exchangeId, canonicalRecord.record);
      else this.relations.set(canonicalRecord.record.relationId, canonicalRecord.record);
      if (canonicalRecord.recordType === "exchange") {
        try { this.options.onDidRecordExchange?.(structuredClone(canonicalRecord.record)); }
        catch { this.log("Collaboration diagnostic observer failed; canonical exchange retained."); }
      }
    });
    this.writeChain = next.catch(() => undefined);
    await next;
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationChain;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.operationChain = previous.then(() => gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  private log(message: string): void {
    this.options.log?.(`[mission-collaboration-store] ${message}`);
  }
}
