import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  applyProjectEvent,
  normalizeProjectFormationId,
  normalizeProjectFormationReceipt,
  normalizeProjectEvent,
  normalizeProjectGovernanceId,
  normalizeProjectProposalContent,
  projectCommittedDecisionId,
  projectProposalContentDigest,
  type ProjectDecisionChange,
  type ProjectEvent,
  type ProjectFormationReceipt,
  type ProjectHumanConfirmation,
  type ProjectProposal,
  type ProjectProposalContent,
  type ProjectSnapshot,
} from "./project-contract.js";

export const PROJECT_JOURNAL = "projects-v1.jsonl";
const MAX_PROJECT_ID_CHARS = 240;
const MAX_PROJECT_TITLE_CHARS = 500;
const MAX_PROJECT_GOAL_CHARS = 8_000;
const MAX_PROJECT_WORKSPACE_CHARS = 2_000;

export interface CreateProjectInput { title?: string; goal?: string; workspace?: string; }
export interface RecordProjectProposalInput { proposalId: string; content: ProjectProposalContent; }
export interface ReplaceProjectProposalInput extends RecordProjectProposalInput { supersededProposalId: string; }
export interface HumanConfirmProjectProposalInput { proposalId: string; contentDigest: string; }
export interface CommitProjectProposalInput { proposalId: string; }

export interface ProjectStoreOptions {
  storageDirectory: string;
  log?: (message: string) => void;
  now?: () => Date;
  newId?: () => string;
  onDidChange?: (event: ProjectEvent) => void;
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
  for (const key of Object.keys(row)) if (!allowedSet.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
}

function boundedOptionalText(value: string | undefined, maxChars: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxChars) throw new Error(`${label} must be at most ${maxChars} characters.`);
  return normalized;
}

export class ProjectStore {
  private readonly projects = new Map<string, ProjectSnapshot>();
  private readonly formationProjects = new Map<string, { projectId: string; formationDigest: string }>();
  private initializePromise: Promise<void> | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private operationChain: Promise<void> = Promise.resolve();
  private journalNeedsSeparator = false;

  constructor(private readonly options: ProjectStoreOptions) {}

  async initialize(): Promise<void> {
    if (!this.initializePromise) this.initializePromise = this.load();
    return this.initializePromise;
  }

  async createProject(input: CreateProjectInput = {}): Promise<ProjectSnapshot> {
    return this.exclusive(async () => {
      await this.initialize();
      const projectId = this.newProjectId();
      if (this.projects.has(projectId)) throw new Error(`Project id collision: ${projectId}`);
      const event: ProjectEvent = {
        version: 1,
        eventId: this.newEventId(),
        projectId,
        at: this.now(),
        type: "ProjectCreated",
        payload: {
          title: boundedOptionalText(input.title, MAX_PROJECT_TITLE_CHARS, "Project title"),
          goal: boundedOptionalText(input.goal, MAX_PROJECT_GOAL_CHARS, "Project goal"),
          workspace: boundedOptionalText(input.workspace, MAX_PROJECT_WORKSPACE_CHARS, "Project workspace"),
        },
      };
      await this.commit(event);
      return structuredClone(this.projects.get(projectId)!);
    });
  }

  /**
   * Canonical Phase 10 Project-birth operation. The supplied formationId is a
   * stable operation identity; semantic equality is owned by the normalized
   * formation receipt, never by raw text or random Project-id allocation.
   */
  async ensureProjectFormation(input: unknown): Promise<ProjectSnapshot> {
    const receipt = normalizeProjectFormationReceipt(input);
    return this.exclusive(async () => {
      await this.initialize();
      // Classify a prior/uncertain write from owner truth before allocating.
      await this.refreshFromDurableJournal();
      const existing = this.resolveFormation(receipt);
      if (existing) return structuredClone(existing);

      const projectId = this.newProjectId();
      if (this.projects.has(projectId)) throw new Error(`Project id collision: ${projectId}`);
      const event: ProjectEvent = {
        version: 1,
        eventId: this.newEventId(),
        projectId,
        at: this.now(),
        type: "ProjectCreated",
        payload: {
          ...(receipt.project.title === undefined ? {} : { title: receipt.project.title }),
          goal: receipt.project.goal,
          ...(receipt.project.workspace === undefined ? {} : { workspace: receipt.project.workspace }),
          formationReceipt: receipt,
        },
      };

      try {
        await this.commit(event);
      } catch (error) {
        // A rejected call may follow a durable append. Re-read by formationId
        // before any caller retry can allocate a replacement Project.
        await this.refreshFromDurableJournal();
        const recovered = this.resolveFormation(receipt);
        if (recovered) return structuredClone(recovered);
        throw error;
      }

      // Root provisioning is allowed to consume only re-read Project truth.
      await this.refreshFromDurableJournal();
      const durable = this.resolveFormation(receipt);
      if (!durable) throw new Error(`Project Formation ${receipt.formationId} was not recoverable after ProjectCreated.`);
      return structuredClone(durable);
    });
  }

  async recordProposal(projectId: string, input: RecordProjectProposalInput): Promise<ProjectProposal> {
    return this.exclusive(async () => {
      await this.initialize();
      const project = this.requireProject(projectId);
      const row = objectValue(input, "Project Proposal input");
      exactKeys(row, ["proposalId", "content"], "Project Proposal input");
      const proposalId = normalizeProjectGovernanceId(row.proposalId, "Project Proposal id");
      const content = normalizeProjectProposalContent(row.content);
      const contentDigest = projectProposalContentDigest(content);
      const current = project.proposals[proposalId];
      if (current) {
        if (current.contentDigest === contentDigest && stableJson(current.content) === stableJson(content)) return structuredClone(current);
        throw new Error(`Project Proposal identity collision: ${proposalId}`);
      }
      const proposal: ProjectProposal = { proposalId, contentDigest, content, proposedAt: this.now() };
      await this.commit({ version: 1, eventId: this.newEventId(), projectId: project.projectId, at: proposal.proposedAt, type: "ProjectProposalRecorded", payload: { proposal } });
      return structuredClone(this.projects.get(project.projectId)!.proposals[proposalId]!);
    });
  }

  async replaceProposal(projectId: string, input: ReplaceProjectProposalInput): Promise<ProjectProposal> {
    return this.exclusive(async () => {
      await this.initialize();
      const project = this.requireProject(projectId);
      const row = objectValue(input, "Project Proposal replacement input");
      exactKeys(row, ["supersededProposalId", "proposalId", "content"], "Project Proposal replacement input");
      const supersededProposalId = normalizeProjectGovernanceId(row.supersededProposalId, "Superseded Project Proposal id");
      const proposalId = normalizeProjectGovernanceId(row.proposalId, "Replacement Project Proposal id");
      const content = normalizeProjectProposalContent(row.content);
      const contentDigest = projectProposalContentDigest(content);
      const current = project.proposals[supersededProposalId];
      if (!current) throw new Error(`Project Proposal does not exist: ${supersededProposalId}`);
      if (current.supersededByProposalId) {
        const installed = project.proposals[current.supersededByProposalId];
        if (current.supersededByProposalId === proposalId && installed?.contentDigest === contentDigest && stableJson(installed.content) === stableJson(content)) return structuredClone(installed);
        throw new Error(`Project Proposal ${supersededProposalId} was already superseded by ${current.supersededByProposalId}.`);
      }
      if (Object.values(project.committedDecisions).some(decision => decision.proposalId === supersededProposalId)) throw new Error(`Committed Project Proposal cannot be replaced: ${supersededProposalId}`);
      if (project.proposals[proposalId]) throw new Error(`Project Proposal identity collision: ${proposalId}`);
      const replacement: ProjectProposal = { proposalId, contentDigest, content, proposedAt: this.now() };
      await this.commit({ version: 1, eventId: this.newEventId(), projectId: project.projectId, at: replacement.proposedAt, type: "ProjectProposalReplaced", payload: { supersededProposalId, replacement } });
      return structuredClone(this.projects.get(project.projectId)!.proposals[proposalId]!);
    });
  }

  /** Explicit trusted-human operation. Commit itself cannot manufacture this evidence. */
  async confirmProposalHuman(projectId: string, input: HumanConfirmProjectProposalInput): Promise<ProjectHumanConfirmation> {
    return this.exclusive(async () => {
      await this.initialize();
      const project = this.requireProject(projectId);
      const row = objectValue(input, "Human Confirmation input");
      exactKeys(row, ["proposalId", "contentDigest"], "Human Confirmation input");
      const proposalId = normalizeProjectGovernanceId(row.proposalId, "Confirmed Project Proposal id");
      const proposal = project.proposals[proposalId];
      if (!proposal) throw new Error(`Project Proposal does not exist: ${proposalId}`);
      if (proposal.supersededByProposalId) throw new Error(`Project Proposal ${proposalId} is superseded and cannot be Human Confirmed.`);
      if (row.contentDigest !== proposal.contentDigest) throw new Error(`Human Confirmation digest does not match Project Proposal ${proposalId}.`);
      const current = project.humanConfirmations[proposalId];
      if (current) return structuredClone(current);
      const confirmation: ProjectHumanConfirmation = { confirmationId: this.newEventId(), proposalId, contentDigest: proposal.contentDigest, confirmedAt: this.now() };
      await this.commit({ version: 1, eventId: this.newEventId(), projectId: project.projectId, at: confirmation.confirmedAt, type: "ProjectProposalHumanConfirmed", payload: { confirmation } });
      return structuredClone(this.projects.get(project.projectId)!.humanConfirmations[proposalId]!);
    });
  }

  /** Replay durable Project state before Commit so persistence-uncertainty retries converge. */
  async commitProposal(projectId: string, input: CommitProjectProposalInput): Promise<ProjectDecisionChange> {
    return this.exclusive(async () => {
      await this.initialize();
      const row = objectValue(input, "Project Commit input");
      exactKeys(row, ["proposalId"], "Project Commit input");
      const proposalId = normalizeProjectGovernanceId(row.proposalId, "Committed Project Proposal id");
      await this.refreshFromDurableJournal();
      const project = this.requireProject(projectId);
      const proposal = project.proposals[proposalId];
      if (!proposal) throw new Error(`Project Proposal does not exist: ${proposalId}`);
      if (proposal.supersededByProposalId) throw new Error(`Superseded Project Proposal cannot Commit: ${proposalId}`);
      const confirmation = project.humanConfirmations[proposalId];
      if (!confirmation || confirmation.contentDigest !== proposal.contentDigest) throw new Error(`Project Proposal ${proposalId} lacks matching durable Human Confirmation.`);
      const decisionId = projectCommittedDecisionId(project.projectId, proposalId, proposal.contentDigest);
      const existing = project.committedDecisions[decisionId];
      if (existing) return structuredClone(existing);
      if (Object.values(project.committedDecisions).some(decision => decision.proposalId === proposalId)) throw new Error(`Project Proposal ${proposalId} already has a different committed Decision.`);
      const decision: ProjectDecisionChange = {
        decisionId,
        projectId: project.projectId,
        proposalId,
        contentDigest: proposal.contentDigest,
        confirmationId: confirmation.confirmationId,
        content: structuredClone(proposal.content),
        committedAt: this.now(),
      };
      await this.commit({ version: 1, eventId: this.newEventId(), projectId: project.projectId, at: decision.committedAt, type: "ProjectDecisionCommitted", payload: { decision } });
      return structuredClone(this.projects.get(project.projectId)!.committedDecisions[decisionId]!);
    });
  }

  getProject(projectId: string): ProjectSnapshot | undefined {
    const project = this.projects.get(projectId);
    return project ? structuredClone(project) : undefined;
  }

  getProjectByFormationId(formationId: string): ProjectSnapshot | undefined {
    const normalized = normalizeProjectFormationId(formationId);
    const indexed = this.formationProjects.get(normalized);
    const project = indexed ? this.projects.get(indexed.projectId) : undefined;
    return project ? structuredClone(project) : undefined;
  }

  async rereadProjectByFormationId(formationId: string): Promise<ProjectSnapshot | undefined> {
    const normalized = normalizeProjectFormationId(formationId);
    return this.exclusive(async () => {
      await this.initialize();
      await this.refreshFromDurableJournal();
      const indexed = this.formationProjects.get(normalized);
      const project = indexed ? this.projects.get(indexed.projectId) : undefined;
      return project ? structuredClone(project) : undefined;
    });
  }

  getProposal(projectId: string, proposalId: string): ProjectProposal | undefined {
    const proposal = this.projects.get(projectId)?.proposals[proposalId];
    return proposal ? structuredClone(proposal) : undefined;
  }

  getHumanConfirmation(projectId: string, proposalId: string): ProjectHumanConfirmation | undefined {
    const confirmation = this.projects.get(projectId)?.humanConfirmations[proposalId];
    return confirmation ? structuredClone(confirmation) : undefined;
  }

  getDecision(projectId: string, decisionId: string): ProjectDecisionChange | undefined {
    const decision = this.projects.get(projectId)?.committedDecisions[decisionId];
    return decision ? structuredClone(decision) : undefined;
  }

  listDecisions(projectId: string): ProjectDecisionChange[] {
    return Object.values(this.projects.get(projectId)?.committedDecisions ?? {})
      .map(decision => structuredClone(decision))
      .sort((a, b) => a.committedAt.localeCompare(b.committedAt) || a.decisionId.localeCompare(b.decisionId));
  }

  listProjects(): ProjectSnapshot[] {
    return [...this.projects.values()].map(project => structuredClone(project))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.projectId.localeCompare(b.projectId));
  }

  listFormedProjects(): ProjectSnapshot[] {
    return [...this.formationProjects.values()]
      .map(indexed => this.projects.get(indexed.projectId))
      .filter((project): project is ProjectSnapshot => !!project)
      .map(project => structuredClone(project))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.projectId.localeCompare(b.projectId));
  }

  async rereadFormedProjects(): Promise<ProjectSnapshot[]> {
    return this.exclusive(async () => {
      await this.initialize();
      await this.refreshFromDurableJournal();
      return this.listFormedProjects();
    });
  }

  async flush(): Promise<void> { await this.writeChain; }

  private async load(): Promise<void> {
    await fs.mkdir(this.options.storageDirectory, { recursive: true });
    await this.refreshFromDurableJournal();
    this.log(`loaded ${this.projects.size} Project(s)`);
  }

  private async refreshFromDurableJournal(): Promise<void> {
    const journalPath = path.join(this.options.storageDirectory, PROJECT_JOURNAL);
    let raw: string;
    try {
      raw = await fs.readFile(journalPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.projects.clear();
        this.formationProjects.clear();
        this.journalNeedsSeparator = false;
        return;
      }
      this.log(`failed to read Project journal: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    const replayed = new Map<string, ProjectSnapshot>();
    const replayedFormations = new Map<string, { projectId: string; formationDigest: string }>();
    this.journalNeedsSeparator = raw.length > 0 && !raw.endsWith("\n");
    for (const [index, line] of raw.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        const event = normalizeProjectEvent(parsed);
        const receipt = event.type === "ProjectCreated" ? event.payload.formationReceipt : undefined;
        if (receipt) {
          const existing = replayedFormations.get(receipt.formationId);
          if (existing) {
            throw new Error(`Project Formation identity collision during replay: ${receipt.formationId} already belongs to ${existing.projectId}.`);
          }
        }
        replayed.set(event.projectId, applyProjectEvent(replayed.get(event.projectId), event));
        if (receipt) replayedFormations.set(receipt.formationId, { projectId: event.projectId, formationDigest: receipt.formationDigest });
      } catch (error) {
        this.log(`ignored invalid Project event ${PROJECT_JOURNAL}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.projects.clear();
    for (const [projectId, project] of replayed) this.projects.set(projectId, project);
    this.formationProjects.clear();
    for (const [formationId, indexed] of replayedFormations) this.formationProjects.set(formationId, indexed);
  }

  private resolveFormation(receipt: ProjectFormationReceipt): ProjectSnapshot | undefined {
    const indexed = this.formationProjects.get(receipt.formationId);
    if (!indexed) return undefined;
    if (indexed.formationDigest !== receipt.formationDigest) {
      throw new Error(`Project Formation identity/content collision: ${receipt.formationId}`);
    }
    const project = this.projects.get(indexed.projectId);
    if (!project?.formationReceipt) throw new Error(`Project Formation index is missing its durable receipt: ${receipt.formationId}`);
    if (stableJson(project.formationReceipt) !== stableJson(receipt)) {
      throw new Error(`Project Formation identity/content collision: ${receipt.formationId}`);
    }
    return project;
  }

  private requireProject(projectId: string): ProjectSnapshot {
    const normalized = normalizeProjectGovernanceId(projectId, "Project id");
    const project = this.projects.get(normalized);
    if (!project) throw new Error(`Unknown Project: ${normalized}`);
    return project;
  }

  private async commit(event: ProjectEvent): Promise<void> {
    const canonicalEvent = normalizeProjectEvent(JSON.parse(JSON.stringify(event)));
    const previous = this.writeChain;
    const next = previous.then(async () => {
      const formationReceipt = canonicalEvent.type === "ProjectCreated" ? canonicalEvent.payload.formationReceipt : undefined;
      if (formationReceipt) {
        const existing = this.formationProjects.get(formationReceipt.formationId);
        if (existing && existing.projectId !== canonicalEvent.projectId) {
          throw new Error(`Project Formation identity collision: ${formationReceipt.formationId}`);
        }
      }
      try {
        await fs.mkdir(this.options.storageDirectory, { recursive: true });
        const separator = this.journalNeedsSeparator ? "\n" : "";
        await fs.appendFile(path.join(this.options.storageDirectory, PROJECT_JOURNAL), `${separator}${JSON.stringify(canonicalEvent)}\n`, "utf8");
        this.journalNeedsSeparator = false;
      } catch (error) {
        this.log(`failed to persist ${canonicalEvent.type} project=${canonicalEvent.projectId}: ${error instanceof Error ? error.message : String(error)}`);
        throw new Error(`Project persistence failed for ${canonicalEvent.type}: ${error instanceof Error ? error.message : String(error)}`);
      }
      this.projects.set(canonicalEvent.projectId, applyProjectEvent(this.projects.get(canonicalEvent.projectId), canonicalEvent));
      if (formationReceipt) {
        this.formationProjects.set(formationReceipt.formationId, {
          projectId: canonicalEvent.projectId,
          formationDigest: formationReceipt.formationDigest,
        });
      }
      try { this.options.onDidChange?.(structuredClone(canonicalEvent)); }
      catch { this.log("Project diagnostic observer failed; canonical commit retained."); }
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
    try { return await operation(); } finally { release(); }
  }

  private now(): string { return (this.options.now ?? (() => new Date()))().toISOString(); }

  private newProjectId(): string {
    const value = (this.options.newId ?? randomUUID)().trim();
    if (!value) throw new Error("Project id must not be empty.");
    if (value.length > MAX_PROJECT_ID_CHARS) throw new Error(`Project id must be at most ${MAX_PROJECT_ID_CHARS} characters.`);
    return value;
  }

  private newEventId(): string {
    const value = (this.options.newId ?? randomUUID)().trim();
    if (!value) throw new Error("Project event id must not be empty.");
    return value;
  }

  private log(message: string): void { this.options.log?.(`[project-store] ${message}`); }
}
