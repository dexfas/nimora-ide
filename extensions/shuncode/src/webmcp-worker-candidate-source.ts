import type {
  WorkerAssignmentCandidate,
  WorkerAssignmentCandidateSource,
  WorkerAssignmentSelection,
} from "../../../src/worker-assignment.js";
import type { WorkerCapabilities, WorkerSessionOptions } from "../../../src/worker-contract.js";
import type { WorkerSessionManager } from "../../../src/worker-session-manager.js";
import type { WebMcpCommandExecutor } from "./webmcp-worker-transport.js";

const DEFAULT_WEB_WORKER_ID = "nimora.web-worker";
const MAX_WEB_RESOURCES = 32;
const RESOURCE_IDENTITY = /^[a-f0-9]{64}$/;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 25_000;
const DEFAULT_PROBE_TIMEOUT_MS = 18_000;

interface WebMcpWorkerResourceObservation {
  pageId: string;
  href: string;
  origin: string;
  site: string;
  nativeMcpBypass: boolean;
  composerFound: boolean;
  isDeepSeekAuthPage: boolean;
  runtimeVersion?: number;
  runtimeEnabled: boolean;
  workerTurnState?: string;
  pageSessionId?: string;
  sessionIdentityCompatible: boolean;
  ready: boolean;
  resourceIdentity: string;
}

interface CandidateResourceRecord {
  observation: WebMcpWorkerResourceObservation;
  provider: string;
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

function normalizeOrigin(value: unknown): string {
  const text = boundedString(value, "WebMCP resource origin", 512);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`WebMCP resource origin is invalid: ${text}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`WebMCP resource origin is not HTTP(S): ${text}`);
  return url.origin.toLowerCase();
}

function normalizeResource(input: unknown): WebMcpWorkerResourceObservation {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("WebMCP resource observation must be an object.");
  const row = input as Record<string, unknown>;
  const pageId = boundedString(row.pageId, "WebMCP resource pageId", 240);
  const href = boundedString(row.href, "WebMCP resource href", 2048);
  const origin = normalizeOrigin(row.origin);
  const site = optionalString(row.site, "WebMCP resource site") ?? "";
  const resourceIdentity = boundedString(row.resourceIdentity, "WebMCP resource identity", 64).toLowerCase();
  if (!RESOURCE_IDENTITY.test(resourceIdentity)) throw new Error("WebMCP resource identity must be a SHA-256 hex digest.");
  const runtimeVersion = row.runtimeVersion === undefined || row.runtimeVersion === null
    ? undefined
    : Number(row.runtimeVersion);
  if (runtimeVersion !== undefined && !Number.isInteger(runtimeVersion)) throw new Error("WebMCP runtimeVersion must be an integer when present.");
  const boolean = (key: string): boolean => {
    if (typeof row[key] !== "boolean") throw new Error(`WebMCP resource ${key} must be boolean.`);
    return row[key] as boolean;
  };
  return {
    pageId,
    href,
    origin,
    site,
    nativeMcpBypass: boolean("nativeMcpBypass"),
    composerFound: boolean("composerFound"),
    isDeepSeekAuthPage: boolean("isDeepSeekAuthPage"),
    runtimeVersion,
    runtimeEnabled: boolean("runtimeEnabled"),
    workerTurnState: optionalString(row.workerTurnState, "WebMCP workerTurnState", 40),
    pageSessionId: optionalString(row.pageSessionId, "WebMCP pageSessionId", 240),
    sessionIdentityCompatible: boolean("sessionIdentityCompatible"),
    ready: boolean("ready"),
    resourceIdentity,
  };
}

function providerIdentity(resource: WebMcpWorkerResourceObservation): string | undefined {
  let hostname = "";
  try {
    hostname = new URL(resource.origin).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (resource.site === "deepseek" && (hostname === "deepseek.com" || hostname.endsWith(".deepseek.com"))) return "deepseek";
  // `generic` is an adapter classification, not a provider. For generic/future
  // unrecognized adapters, the observed normalized origin is the provider fact.
  return resource.origin || undefined;
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

export interface WebMcpWorkerCandidateSourceOptions {
  workerId?: string;
  now?: () => Date;
  discoveryTimeoutMs?: number;
  probeTimeoutMs?: number;
}

async function awaitCommandWithin<T>(promiseLike: PromiseLike<T>, timeoutMs: number, label: string): Promise<T> {
  const promise = Promise.resolve(promiseLike);
  promise.catch(() => { /* the read-only command may settle after this caller stops waiting */ });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded deadline (${timeoutMs}ms).`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * WebMCP-specific resource observation boundary. Raw page locators stay inside
 * this source and the opaque WorkerSessionOptions passed to WebWorkerAdapter;
 * generic assignment only receives provider-neutral candidate facts.
 */
export class WebMcpWorkerAssignmentCandidateSource implements WorkerAssignmentCandidateSource {
  private readonly workerId: string;
  private readonly now: () => Date;
  private readonly discoveryTimeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly resources = new Map<string, CandidateResourceRecord>();
  /** Tools-free planning pages may have no pageSessionId before first send.
   * Exclude them by the native exact pageId, not by guessing a session ID. */
  private readonly reservedPlanningPageIds = new Set<string>();
  private observationSequence = 0;

  constructor(
    private readonly workers: WorkerSessionManager,
    private readonly commands: WebMcpCommandExecutor,
    options: WebMcpWorkerCandidateSourceOptions = {},
  ) {
    this.workerId = options.workerId?.trim() || DEFAULT_WEB_WORKER_ID;
    this.now = options.now ?? (() => new Date());
    this.discoveryTimeoutMs = Math.max(1, options.discoveryTimeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
    this.probeTimeoutMs = Math.max(1, options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  }

  reservePlanningPage(pageId: string): void {
    this.reservedPlanningPageIds.add(boundedString(pageId, "Planner page id", 240));
    for (const [id, row] of this.resources) {
      if (row.observation.pageId === pageId) this.resources.delete(id);
    }
  }

  releasePlanningPage(pageId: string): void {
    this.reservedPlanningPageIds.delete(pageId);
  }

  async enumerateCandidates(): Promise<readonly WorkerAssignmentCandidate[]> {
    const descriptor = await this.workers.refresh(this.workerId).catch(error => {
      if (!this.workers.getWorker(this.workerId)) throw new Error(`WebMCP assignment Worker is not registered: ${this.workerId}.`);
      throw error;
    });
    if (descriptor.kind !== "web") throw new Error(`WebMCP assignment Worker must be kind web: ${this.workerId}.`);
    const result = await awaitCommandWithin(
      this.commands.executeCommand<unknown>("_shuncode.webMcp.workerListResources"),
      this.discoveryTimeoutMs,
      "WebMCP worker resource discovery",
    );
    if (!Array.isArray(result)) throw new Error("WebMCP worker resource discovery returned a non-array result.");
    if (result.length > MAX_WEB_RESOURCES) throw new Error(`WebMCP worker resource discovery exceeded ${MAX_WEB_RESOURCES} resources.`);
    this.resources.clear();
    const candidates: WorkerAssignmentCandidate[] = [];
    for (const raw of result) {
      const resource = normalizeResource(raw);
      const candidate = this.admitResource(descriptor.capabilities, descriptor.models, resource);
      if (!candidate) continue;
      candidates.push(candidate);
    }
    return candidates;
  }

  async refreshCandidate(candidate: WorkerAssignmentCandidate): Promise<WorkerAssignmentCandidate | undefined> {
    const record = this.resources.get(candidate.candidateId);
    if (!record || candidate.workerId !== this.workerId) return undefined;
    const raw = await awaitCommandWithin(
      this.commands.executeCommand<unknown>("_shuncode.webMcp.workerProbeResource", {
        pageId: record.observation.pageId,
      }),
      this.probeTimeoutMs,
      `WebMCP worker resource probe ${record.observation.pageId}`,
    );
    if (raw === undefined || raw === null) {
      this.resources.delete(candidate.candidateId);
      return undefined;
    }
    const resource = normalizeResource(raw);
    if (this.candidateId(resource) !== candidate.candidateId) {
      this.resources.delete(candidate.candidateId);
      return undefined;
    }
    const descriptor = await this.workers.refresh(this.workerId).catch(() => undefined);
    if (!descriptor || descriptor.kind !== "web") return undefined;
    return this.admitResource(descriptor.capabilities, descriptor.models, resource, candidate.candidateId);
  }

  async materializeSessionOptions(candidate: WorkerAssignmentCandidate, selection: WorkerAssignmentSelection): Promise<WorkerSessionOptions> {
    const record = this.resources.get(candidate.candidateId);
    if (!record || candidate.workerId !== this.workerId) throw new Error(`WebMCP assignment candidate is no longer materializable: ${candidate.candidateId}.`);
    const resource = record.observation;
    return {
      model: selection.model,
      extensions: {
        webMcpTarget: {
          pageId: resource.pageId,
          resourceIdentity: resource.resourceIdentity,
          origin: resource.origin,
          href: resource.href,
          site: resource.site,
          ...(resource.pageSessionId ? { pageSessionId: resource.pageSessionId } : {}),
        },
      },
    };
  }

  private admitResource(
    capabilities: WorkerCapabilities,
    models: readonly string[] | undefined,
    resource: WebMcpWorkerResourceObservation,
    expectedCandidateId?: string,
  ): WorkerAssignmentCandidate | undefined {
    if (resource.nativeMcpBypass || !resource.sessionIdentityCompatible
      || this.reservedPlanningPageIds.has(resource.pageId)) return undefined;
    const provider = providerIdentity(resource);
    if (!provider || provider === "generic") return undefined;
    if (this.pageSessionIsAlreadyOwned(resource.pageSessionId)) return undefined;
    const candidateId = this.candidateId(resource);
    if (expectedCandidateId && candidateId !== expectedCandidateId) return undefined;
    this.resources.set(candidateId, { observation: resource, provider });
    const observedAt = this.now().toISOString();
    return {
      candidateId,
      workerId: this.workerId,
      provider,
      kind: "web",
      availability: resource.ready ? "available" : "unavailable",
      models: models ? [...models] : [],
      capabilities: assignmentCapabilities(capabilities),
      observationId: `${candidateId}:observation:${++this.observationSequence}`,
      observedAt,
      health: {
        status: resource.ready ? "healthy" : "degraded",
        checkedAt: observedAt,
        message: resource.ready ? undefined : "Shared WebMCP page is not currently ready for automatic assignment.",
      },
    };
  }

  private candidateId(resource: WebMcpWorkerResourceObservation): string {
    return `webmcp:${resource.resourceIdentity}`;
  }

  private pageSessionIsAlreadyOwned(pageSessionId: string | undefined): boolean {
    if (!pageSessionId) return false;
    if (this.workers.getSessionByAdapterIdentity(this.workerId, pageSessionId)) return true;
    return this.workers.listRetiredSessions({ workerId: this.workerId })
      .some(session => session.adapterSessionId === pageSessionId);
  }
}
