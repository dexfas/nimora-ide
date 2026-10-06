import { createHash, randomUUID } from "node:crypto";
import type { WorkerAssignmentCandidate, WorkerAssignmentCandidateSource, WorkerAssignmentSelection } from "../../../src/worker-assignment.js";
import type { WorkerSessionManager } from "../../../src/worker-session-manager.js";
import type { ApiWorkerSessionOptions } from "./api-worker-adapter.js";

export interface ApiWorkerConfiguration extends Omit<ApiWorkerSessionOptions, "extensions"> {
  provider: string;
  profileId?: string;
  configurationRevision?: string;
}

/** Configured credentials remain ephemeral adapter options. Discovery never
 * synthesizes an API Worker from a model label or bypasses workspace trust. */
export class ApiWorkerCandidateSource implements WorkerAssignmentCandidateSource {
  private readonly revisions = new Map<string, { credential?: string; revision: string }>();
  constructor(private readonly workers: WorkerSessionManager,
    private readonly resolve: () => Promise<ApiWorkerConfiguration | readonly ApiWorkerConfiguration[] | undefined>,
    private readonly workerId = "nimora.api-runtime") {}

  private identity(config: ApiWorkerConfiguration): string {
    const { apiKey: _secret, ...publicRuntime } = config.runtime;
    const publicIdentity = JSON.stringify({ provider: config.provider,
      profileId: config.profileId, revision: config.configurationRevision,
      model: config.model, workspaceRoot: config.workspaceRoot, runtime: publicRuntime });
    let revision = this.revisions.get(publicIdentity);
    if (!revision || revision.credential !== _secret) {
      revision = { credential: _secret, revision: randomUUID() };
      this.revisions.set(publicIdentity, revision);
      if (this.revisions.size > 64) this.revisions.delete(this.revisions.keys().next().value!);
    }
    // Opaque random generations detect credential rotation without publishing
    // any hash/fingerprint derived from credential bytes.
    return "api:" + createHash("sha256").update(publicIdentity + revision.revision).digest("hex");
  }
  private async configurations(): Promise<readonly ApiWorkerConfiguration[]> {
    const value = await this.resolve();
    const configs = value === undefined ? [] : Array.isArray(value) ? value : [value as ApiWorkerConfiguration];
    if (configs.length > 9 || new Set(configs.map(config => this.identity(config))).size !== configs.length) throw new Error("Duplicate or excessive API Profile identities.");
    return configs;
  }
  async enumerateCandidates(): Promise<readonly WorkerAssignmentCandidate[]> {
    // An optional, unavailable API configuration must not hide Web candidates.
    let configs: readonly ApiWorkerConfiguration[];
    try { configs = await this.configurations(); } catch { return []; }
    const descriptor = this.workers.getWorker(this.workerId) ? await this.workers.refresh(this.workerId) : undefined;
    if (!descriptor || descriptor.kind !== "api") return [];
    const health = await this.workers.healthWorker(this.workerId);
    return configs.filter(config => config.model.trim() && config.workspaceRoot.trim()).map(config => ({ candidateId: this.identity(config), workerId: this.workerId, provider: config.provider, kind: "api" as const,
      availability: health.status === "healthy" && descriptor.availability === "available" && descriptor.capabilities.capabilityRequests ? "available" : "unavailable",
      models: [config.model], capabilities: {
        streaming: descriptor.capabilities.streaming, reasoning: descriptor.capabilities.reasoning,
        capabilityRequests: descriptor.capabilities.capabilityRequests, imageInput: descriptor.capabilities.imageInput,
        checkpoints: descriptor.capabilities.checkpoints, interruption: descriptor.capabilities.interruption, persistentContext: descriptor.capabilities.persistentContext,
      }, observationId: randomUUID(), observedAt: health.checkedAt,
      health: { status: health.status, checkedAt: health.checkedAt, ...(health.message ? { message: health.message } : {}) } }));
  }
  async refreshCandidate(candidate: WorkerAssignmentCandidate): Promise<WorkerAssignmentCandidate | undefined> {
    return (await this.enumerateCandidates()).find(row => row.candidateId === candidate.candidateId
      && row.workerId === candidate.workerId && row.provider === candidate.provider);
  }
  async materializeSessionOptions(candidate: WorkerAssignmentCandidate, selection: WorkerAssignmentSelection): Promise<ApiWorkerSessionOptions> {
    const config = (await this.configurations()).find(row => this.identity(row) === candidate.candidateId);
    if (!config || this.identity(config) !== candidate.candidateId || candidate.workerId !== this.workerId
      || candidate.provider !== config.provider || (selection.model && selection.model !== config.model)) {
      throw new Error("API Worker configuration changed before assignment; no fallback or credential substitution.");
    }
    const { provider: _provider, profileId, configurationRevision, ...options } = config;
    return structuredClone({ ...options, extensions: { apiProfile: { profileId: profileId ?? "legacy", configurationRevision: configurationRevision ?? "legacy", candidateId: candidate.candidateId } } });
  }
}
