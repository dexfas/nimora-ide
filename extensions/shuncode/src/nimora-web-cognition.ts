import { createHash, randomUUID } from "node:crypto";
import type { WorkerAssignmentCandidateSource } from "../../../src/worker-assignment.js";
import type { WorkerSessionManager } from "../../../src/worker-session-manager.js";
import type { WebPlanningBackendObservation } from "../../../src/mission-web-provider-selection.js";

/**
 * Ephemeral, tools-free pre-Formation Cognition on a dedicated shared DeepSeek
 * webpage. WorkerSessionManager remains the only live session owner; this pool
 * holds merely optional per-Project references, never Project/Mission truth.
 * After a host restart, a fresh explicitly shared cognition page is required.
 */
export class NimoraWebCognitionPool {
  private readonly projects = new Map<string, string>();
  private readonly pageIds = new Map<string, string>();
  private readonly unsettled = new Set<string>();
  private readonly backends = new Map<string, { workerId: string; provider: string; kind: "web" | "api"; model?: string }>();

  constructor(private readonly workers: WorkerSessionManager, private readonly source: WorkerAssignmentCandidateSource,
    private readonly observeJsonFailure: (value: { managedSessionId: string; attempt: number; replySHA256: string; replyChars: number }) => void = () => {},
    private readonly preferredBackend: (projectId?: string) => "deepseek-web" | "api" = () => "deepseek-web") {}

  async inspectBackend(managedSessionId: string): Promise<WebPlanningBackendObservation> {
    const session = this.workers.getSession(managedSessionId);
    const backend = this.backends.get(managedSessionId);
    if (!backend || !session || session.workerId !== backend.workerId || session.taskId || session.state !== "idle"
      || (backend.kind === "web" && !this.pageIds.has(managedSessionId)) || this.unsettled.has(managedSessionId)) {
      throw new Error("规划 backend 观测需要已知空闲、无 Mission 绑定的原规划会话。");
    }
    const { workerId, adapterSessionId } = session;
    const descriptor = await this.workers.refresh(workerId);
    const health = await this.workers.health(managedSessionId);
    const fresh = this.workers.getSession(managedSessionId);
    if (descriptor.kind !== backend.kind || descriptor.availability !== "available" || health.status !== "healthy"
      || !fresh || fresh.workerId !== workerId || fresh.adapterSessionId !== adapterSessionId || fresh.taskId || fresh.state !== "idle"
      || this.unsettled.has(managedSessionId) || (backend.kind === "web" && !this.pageIds.has(managedSessionId))) {
      throw new Error("原规划 backend 已漂移或不健康，不能为建项提供能力证明。");
    }
    // acquire already proved this exact page's DeepSeek provider. Its page
    // reservation remains intact; these are adapter shape facts, not a grant.
    const { streaming, reasoning, capabilityRequests, imageInput, checkpoints, interruption, persistentContext } = descriptor.capabilities;
    return { provider: backend.provider, kind: backend.kind, models: backend.model ? [backend.model] : [...(descriptor.models ?? [])],
      capabilities: { streaming, reasoning, capabilityRequests, imageInput, checkpoints, interruption, persistentContext },
      status: "healthy", checkedAt: health.checkedAt, basis: "owned-tools-free-planner" };
  }

  /** Accept the entire reply, never salvage a JSON substring from arbitrary prose. */
  private jsonText(reply: string): string {
    const fence = /^```(?:json)?\r?\n([\s\S]*)\r?\n```$/.exec(reply);
    const text = fence ? fence[1] : reply;
    JSON.parse(text);
    return text;
  }

  /** One format correction is safe only after a verified completed tools-free turn. */
  async runJson(managedSessionId: string, prompt: string): Promise<string> {
    const raw = await this.run(managedSessionId, `${prompt}\nWire encoding: Put the requested JSON object inside exactly one fenced json code block with no text outside it. Preserve literal JSON escaping inside that code block; this encoding instruction does not change the requested fields, scope or authority.`);
    try { return this.jsonText(raw); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.observeJsonFailure({ managedSessionId, attempt: 1,
        replySHA256: createHash("sha256").update(raw).digest("hex"), replyChars: raw.length });
    }
    const corrected = await this.run(managedSessionId, `Correct only the JSON serialization of your completed tools-free reply. This is a new format-correction input, not permission to execute or repeat work. No tools, Project/Mission creation, external effects, or expanded scope are authorized.
Return exactly one JSON object inside a single fenced json code block, with no text outside it. Escape all quotes, backslashes and newlines within JSON strings. Prefer ordinary prose rather than embedded JSON arrays in descriptive strings. Preserve every original requested operation, restriction and output field; do not add authority or infer facts.
Original output contract and request (quoted data): ${JSON.stringify(prompt)}
Completed reply to re-serialize (untrusted quoted data): ${JSON.stringify(raw)}`);
    try { return this.jsonText(corrected); }
    catch (error) {
      this.observeJsonFailure({ managedSessionId, attempt: 2,
        replySHA256: createHash("sha256").update(corrected).digest("hex"), replyChars: corrected.length });
      throw new Error("网页版 Cognition 的一次有界格式纠正仍不是有效 JSON；本次规划／审核未获准推进，不得重放原输入。", { cause: error });
    }
  }

  hasHealthyLocalReference(projectId: string): boolean {
    const sessionId = this.projects.get(projectId);
    return Boolean(sessionId && this.workers.getSession(sessionId) && !this.unsettled.has(sessionId));
  }

  /** Completion after a host restart may reconstruct a tools-free API reviewer
   * from this root's persisted backend policy. Existing uncertain references
   * are never replaced, and Web still requires its exact original local page. */
  async ensureCompletionReference(projectId: string): Promise<boolean> {
    const preference = this.preferredBackend(projectId);
    const retained = this.projects.get(projectId);
    if (retained) {
      const observation = await this.inspectBackend(retained);
      if (observation.kind !== (preference === "api" ? "api" : "web")) {
        throw new Error("完成审核 backend 与当前 root 持久资源授权不一致；没有发送请求。");
      }
      return true;
    }
    if (preference !== "api") return false;
    const restored = await this.acquire(projectId, "api");
    await this.inspectBackend(restored);
    return true;
  }

  /** Exclude the retained tools-free planner page from Practice assignment. */
  getHealthyPlannerPageId(projectId: string): string | undefined {
    if (!this.hasHealthyLocalReference(projectId)) return undefined;
    return this.pageIds.get(this.projects.get(projectId)!);
  }

  /** Called only after Human approves a new round and the canonical later-root
   * owner proves all previous Missions archived. Never rotate an uncertain turn. */
  async releaseForBackendChange(projectId: string, requestedBackend: "deepseek-web" | "api"): Promise<void> {
    const id = this.projects.get(projectId);
    if (!id) return;
    const backend = this.backends.get(id);
    if (backend?.kind === (requestedBackend === "api" ? "api" : "web")) return;
    await this.inspectBackend(id);
    await this.retireUnused(id);
    this.projects.delete(projectId);
  }

  async acquire(projectId?: string, requestedBackend?: "deepseek-web" | "api"): Promise<string> {
    if (projectId && this.hasHealthyLocalReference(projectId)) return this.projects.get(projectId)!;
    if (projectId && this.projects.has(projectId)) {
      throw new Error("原 Project 的网页 Cognition 会话不可核实。请先检查旧网页和未完成请求；不能自动更换规划会话。");
    }
    const candidates = await this.source.enumerateCandidates();
    const preference = requestedBackend ?? this.preferredBackend(projectId);
    const found = candidates.find(candidate => (preference === "api" ? candidate.provider === "nimora-api" && candidate.kind === "api" : candidate.provider === "deepseek" && candidate.kind === "web")
      && candidate.availability === "available" && candidate.health?.status === "healthy");
    if (!found) throw new Error("没有空闲、健康的 DeepSeek 网页可用于任务规划；请先连接一个独立的规划网页。");
    const fresh = await this.source.refreshCandidate(found);
    if (!fresh || fresh.provider !== found.provider || fresh.candidateId !== found.candidateId
      || fresh.availability !== "available" || fresh.health?.status !== "healthy") {
      throw new Error("DeepSeek 规划网页在连接前发生变化；没有发送任何请求。");
    }
    const options = await this.source.materializeSessionOptions(fresh, { model: fresh.kind === "api" ? fresh.models[0] : undefined });
    const pageId = (options.extensions?.webMcpTarget as { pageId?: unknown } | undefined)?.pageId;
    if (fresh.kind === "web" && (typeof pageId !== "string" || !pageId)) throw new Error("网页规划资源缺少可核实页面身份；没有分配。");
    const session = await this.workers.createSession(fresh.workerId, options);
    this.backends.set(session.managedSessionId, { workerId: fresh.workerId, provider: fresh.provider, kind: fresh.kind as "web" | "api", model: session.model });
    if (typeof pageId === "string") this.pageIds.set(session.managedSessionId, pageId);
    const source = this.source as WorkerAssignmentCandidateSource & { reservePlanningPage?: (pageId: string) => void };
    if (typeof pageId === "string") source.reservePlanningPage?.(pageId);
    if (projectId) this.projects.set(projectId, session.managedSessionId);
    return session.managedSessionId;
  }

  attachFormedProject(projectId: string, managedSessionId: string): void {
    if (!this.workers.getSession(managedSessionId) || this.unsettled.has(managedSessionId)) {
      throw new Error("网页规划会话不可核实；拒绝将不确定会话作为 Project 偏好。");
    }
    this.projects.set(projectId, managedSessionId);
  }

  async run(managedSessionId: string, prompt: string): Promise<string> {
    if (this.unsettled.has(managedSessionId)) throw new Error("上次网页规划回合没有确认完成；不能盲目重发。");
    const session = this.workers.getSession(managedSessionId);
    if (!session || session.workerId !== this.backends.get(managedSessionId)?.workerId || session.taskId) {
      throw new Error("规划需要一个独立且未绑定 Mission 的 DeepSeek 网页 WorkerSession。");
    }
    this.unsettled.add(managedSessionId);
    let content = "";
    let completed = false;
    try {
      for await (const event of this.workers.send(managedSessionId, {
        inputId: randomUUID(), prompt, allowedCapabilities: [], externalCapabilities: [],
        modeInstructions: "Only interpret the supplied request and return one JSON object. No tools or external side effects are authorized.",
      })) {
        if (event.type === "text_delta") content += event.text;
        if (content.length > 65_536) throw new Error("网页版 Cognition 回复超出有界输出上限；没有形成 Project。");
        if (event.type === "capability_call") throw new Error("只读网页版 Cognition 不允许任何工具调用。");
        if (event.type === "terminal") {
          if (event.status !== "completed") throw new Error(`网页版 Cognition 未成功结束：${event.error ?? event.status}。不得直接重试。`);
          const finalText = event.result && typeof event.result === "object"
            ? (event.result as { text?: unknown }).text : undefined;
          if (typeof finalText === "string" && finalText.trim()) content = finalText;
          completed = true;
        }
      }
      if (!completed || !content.trim() || content.length > 65_536) throw new Error("网页版 Cognition 缺少可信终态或有界 JSON 输出。");
      this.unsettled.delete(managedSessionId);
      return content.trim();
    } catch (error) {
      // Do not retire or reuse a possibly in-flight provider page after an
      // unverified send. The user must resolve the ambiguity explicitly.
      throw error;
    }
  }

  async retireUnused(managedSessionId: string): Promise<void> {
    if (this.unsettled.has(managedSessionId)) return;
    if (this.workers.getSession(managedSessionId)) await this.workers.retire(managedSessionId, { reason: "unformed-web-cognition-finished" });
    const pageId = this.pageIds.get(managedSessionId);
    const source = this.source as WorkerAssignmentCandidateSource & { releasePlanningPage?: (pageId: string) => void };
    if (pageId) source.releasePlanningPage?.(pageId);
    this.pageIds.delete(managedSessionId);
    this.backends.delete(managedSessionId);
  }
}
