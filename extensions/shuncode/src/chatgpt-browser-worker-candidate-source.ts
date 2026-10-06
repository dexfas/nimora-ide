import type {
  WorkerAssignmentCandidate,
  WorkerAssignmentCandidateSource,
  WorkerAssignmentSelection,
} from "../../../src/worker-assignment.js";
import type { WorkerCapabilities, WorkerSessionOptions } from "../../../src/worker-contract.js";
import type { WorkerSessionManager } from "../../../src/worker-session-manager.js";
import type { WebMcpCommandExecutor } from "./webmcp-worker-transport.js";

const DEFAULT_CHATGPT_WORKER_ID = "nimora.chatgpt-browser-worker";
const MAX_RESOURCES = 32;
const RESOURCE_IDENTITY = /^[a-f0-9]{64}$/;

interface ChatGptResourceObservation {
  pageId: string;
  href: string;
  origin: string;
  conversationId?: string;
  composerFound: boolean;
  ready: boolean;
  resourceIdentity: string;
  lifecycleIdentity: string;
}

function boundedString(value: unknown, label: string, max = 2048): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > max) throw new Error(`${label} is too long.`);
  return normalized;
}

function optionalString(value: unknown, label: string, max = 240): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedString(value, label, max);
}

function normalizeResource(input: unknown): ChatGptResourceObservation {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("ChatGPT resource observation must be an object.");
  const row = input as Record<string, unknown>;
  const pageId = boundedString(row.pageId, "ChatGPT resource pageId", 240);
  const href = boundedString(row.href, "ChatGPT resource href", 2048);
  const origin = boundedString(row.origin, "ChatGPT resource origin", 512);
  const url = new URL(href);
  if ((url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") || url.origin !== origin) {
    throw new Error("ChatGPT resource origin/host is invalid.");
  }
  const resourceIdentity = boundedString(row.resourceIdentity, "ChatGPT resource identity", 64).toLowerCase();
  if (!RESOURCE_IDENTITY.test(resourceIdentity)) throw new Error("ChatGPT resource identity must be a SHA-256 hex digest.");
  const lifecycleIdentity = boundedString(row.lifecycleIdentity, "ChatGPT lifecycle identity", 64).toLowerCase();
  if (!RESOURCE_IDENTITY.test(lifecycleIdentity)) throw new Error("ChatGPT lifecycle identity must be a SHA-256 hex digest.");
  if (typeof row.composerFound !== "boolean" || typeof row.ready !== "boolean") throw new Error("ChatGPT resource readiness fields must be boolean.");
  return {
    pageId,
    href,
    origin,
    conversationId: optionalString(row.conversationId, "ChatGPT conversationId"),
    composerFound: row.composerFound,
    ready: row.ready,
    resourceIdentity,
    lifecycleIdentity,
  };
}

function assignmentCapabilities(capabilities: WorkerCapabilities): WorkerAssignmentCandidate["capabilities"] {
  return {
    streaming: capabilities.streaming,
    reasoning: capabilities.reasoning,
    capabilityRequests: capabilities.capabilityRequests,
    imageInput: capabilities.imageInput,
    checkpoints: capabilities.checkpoints,
    interruption: capabilities.interruption,
    persistentContext: capabilities.persistentContext,
  };
}

export interface ChatGptBrowserWorkerCandidateSourceOptions {
  workerId?: string;
  now?: () => Date;
}

/** Exact shared ChatGPT-page discovery; no WebMCP bypass is removed or injected. */
export class ChatGptBrowserWorkerCandidateSource implements WorkerAssignmentCandidateSource {
  private readonly workerId: string;
  private readonly now: () => Date;
  private readonly resources = new Map<string, ChatGptResourceObservation>();
  private observationSequence = 0;

  constructor(
    private readonly workers: WorkerSessionManager,
    private readonly commands: WebMcpCommandExecutor,
    options: ChatGptBrowserWorkerCandidateSourceOptions = {},
  ) {
    this.workerId = options.workerId?.trim() || DEFAULT_CHATGPT_WORKER_ID;
    this.now = options.now ?? (() => new Date());
  }

  async enumerateCandidates(): Promise<readonly WorkerAssignmentCandidate[]> {
    const descriptor = await this.workers.refresh(this.workerId);
    if (descriptor.kind !== "web") throw new Error(`ChatGPT assignment Worker must be kind web: ${this.workerId}.`);
    const result = await this.commands.executeCommand<unknown>("_shuncode.chatgptWorker.listResources");
    if (!Array.isArray(result)) throw new Error("ChatGPT worker resource discovery returned a non-array result.");
    if (result.length > MAX_RESOURCES) throw new Error(`ChatGPT worker resource discovery exceeded ${MAX_RESOURCES} resources.`);
    this.resources.clear();
    const candidates: WorkerAssignmentCandidate[] = [];
    for (const raw of result) {
      const resource = normalizeResource(raw);
      const candidate = await this.admit(descriptor.capabilities, descriptor.models, resource);
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }

  async refreshCandidate(candidate: WorkerAssignmentCandidate): Promise<WorkerAssignmentCandidate | undefined> {
    const resource = this.resources.get(candidate.candidateId);
    if (!resource || candidate.workerId !== this.workerId) return undefined;
    const raw = await this.commands.executeCommand<unknown>("_shuncode.chatgptWorker.probeResource", { pageId: resource.pageId });
    if (raw === undefined || raw === null) {
      this.resources.delete(candidate.candidateId);
      return undefined;
    }
    const refreshed = normalizeResource(raw);
    if (this.candidateId(refreshed) !== candidate.candidateId) {
      this.resources.delete(candidate.candidateId);
      return undefined;
    }
    const descriptor = await this.workers.refresh(this.workerId).catch(() => undefined);
    if (!descriptor || descriptor.kind !== "web") return undefined;
    return this.admit(descriptor.capabilities, descriptor.models, refreshed, candidate.candidateId);
  }

  async materializeSessionOptions(candidate: WorkerAssignmentCandidate, selection: WorkerAssignmentSelection): Promise<WorkerSessionOptions> {
    const resource = this.resources.get(candidate.candidateId);
    if (!resource || candidate.workerId !== this.workerId) throw new Error(`ChatGPT assignment candidate is no longer materializable: ${candidate.candidateId}.`);
    return {
      model: selection.model,
      extensions: {
        chatGptTarget: {
          pageId: resource.pageId,
          resourceIdentity: resource.resourceIdentity,
          lifecycleIdentity: resource.lifecycleIdentity,
          origin: resource.origin,
          href: resource.href,
          ...(resource.conversationId ? { conversationId: resource.conversationId } : {}),
        },
      },
    };
  }

  private async admit(
    capabilities: WorkerCapabilities,
    models: readonly string[] | undefined,
    resource: ChatGptResourceObservation,
    expectedCandidateId?: string,
  ): Promise<WorkerAssignmentCandidate | undefined> {
    if (await this.sessionIdentityIsAlreadyOwned(resource.lifecycleIdentity)) return undefined;
    const candidateId = this.candidateId(resource);
    if (expectedCandidateId && expectedCandidateId !== candidateId) return undefined;
    this.resources.set(candidateId, resource);
    const observedAt = this.now().toISOString();
    return {
      candidateId,
      workerId: this.workerId,
      provider: "openai-chatgpt",
      kind: "web",
      availability: resource.ready ? "available" : "unavailable",
      models: models ? [...models] : [],
      capabilities: assignmentCapabilities(capabilities),
      observationId: `${candidateId}:observation:${++this.observationSequence}`,
      observedAt,
      health: {
        status: resource.ready ? "healthy" : "degraded",
        checkedAt: observedAt,
        message: resource.ready ? undefined : "Shared ChatGPT page is not currently ready for automatic assignment.",
      },
    };
  }

  private candidateId(resource: ChatGptResourceObservation): string {
    return `chatgpt:${resource.resourceIdentity}`;
  }

  private async sessionIdentityIsAlreadyOwned(adapterSessionId: string): Promise<boolean> {
    if (this.workers.getSessionByAdapterIdentity(this.workerId, adapterSessionId)) return true;
    return this.workers.isAdapterSessionRetired(this.workerId, adapterSessionId);
  }
}
