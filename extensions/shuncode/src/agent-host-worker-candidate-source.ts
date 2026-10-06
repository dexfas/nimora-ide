import * as vscode from "vscode";
import { createHash, randomUUID } from "node:crypto";
import type { WorkerAdapter, WorkerCapabilityResultInput, WorkerDescriptor, WorkerEvent, WorkerHealth, WorkerInput, WorkerSessionHandle, WorkerSessionOptions } from "../../../src/worker-contract.js";
import type { WorkerAssignmentCandidate, WorkerAssignmentCandidateSource, WorkerAssignmentSelection } from "../../../src/worker-assignment.js";
import type { WorkerSessionManager } from "../../../src/worker-session-manager.js";
import { agentHostWorkerDiscovery } from "../../../src/agent-host-worker-discovery.js";
import { shunCodeMissionCapabilityExecutionRoutes } from "./bridge-task-tool-definitions.js";
type Discovery = ReturnType<typeof agentHostWorkerDiscovery> & { clientToolWorkerVersion?: number };

/** Only exact supported client-tool bridge versions enter the Mission pool.
 * Ordinary observed native calls never enter the host executor. */
export class PlatformAgentHostWorkerAdapter implements WorkerAdapter {
  private readonly sessions = new Map<string, WorkerSessionHandle>();
  constructor(private readonly read = async (): Promise<Discovery> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([vscode.commands.executeCommand<Discovery>("_agentHost.workerSnapshot"), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("AgentHost discovery timed out.")), 5000); timer.unref();
    })]); } finally { if (timer) clearTimeout(timer); }
  }, private readonly id = "nimora.agent-host", private readonly invoke = <T>(request: Record<string, unknown>): Thenable<T> => vscode.commands.executeCommand<T>("_agentHost.clientToolWorker", request)) {}
  async describe(): Promise<WorkerDescriptor> {
    let snapshot: Discovery = { state: "offline", providers: [], missionToolPolicy: false };
    try {
      const raw = await this.read();
      if (raw?.state === "connected" && Array.isArray(raw.providers)) {
        snapshot = agentHostWorkerDiscovery({ agents: raw.providers.map(provider => ({ provider: provider?.id,
          displayName: provider?.label, models: Array.isArray(provider?.models) ? provider.models.map(id => ({ id })) : undefined })) });
        if (raw.clientToolWorkerVersion === 1) snapshot.clientToolWorkerVersion = 1;
      } else if (raw?.state === "starting") snapshot.state = "starting";
    } catch { /* Older hosts or malformed discovery stay unavailable. */ }
    const available = snapshot.clientToolWorkerVersion === 1 && snapshot.providers.some(provider => provider.id === "copilotcli" && provider.models.length > 0);
    return { id: this.id, provider: "agent-host", kind: "agent-host", label: available ? "AgentHost · Copilot Mission Worker" : "AgentHost · Mission 工具策略待接通", availability: available ? "available" : "unavailable",
      models: snapshot.providers.flatMap(provider => provider.models), capabilityProjection: { nativeByName: false, externalDefinitions: available,
        executionRoutes: available ? shunCodeMissionCapabilityExecutionRoutes("external-schema", "ahp.client-tools", "Frozen SDK client tools execute through the canonical Mission executor and require a server SDK receipt.") : [] },
      capabilities: { streaming: true, reasoning: true, capabilityRequests: available, imageInput: false, checkpoints: false, interruption: true, persistentContext: true,
        extensions: { capabilityPolicyInput: available, providers: snapshot.providers, scopedProviders: available ? ["copilotcli"] : [] } },
      extensions: { nativeConnectionState: snapshot.state, ...(available ? {} : { blockedReason: "Native AHP has no enforced Mission tool allowlist/host-requested result contract." }) } };
  }
  async health(): Promise<WorkerHealth> {
    const descriptor = await this.describe(); const connected = descriptor.extensions?.nativeConnectionState === "connected";
    return { checkedAt: new Date().toISOString(), status: descriptor.availability === "available" ? "healthy" : connected ? "degraded" : "offline",
      ...(descriptor.extensions?.blockedReason ? { message: String(descriptor.extensions.blockedReason) } : {}) };
  }
  async createSession(options: WorkerSessionOptions): Promise<WorkerSessionHandle> {
    const descriptor = await this.describe();
    const providers = descriptor.capabilities.extensions?.providers as Discovery["providers"];
    if (descriptor.availability !== "available" || options.contextHandle || options.extensions?.provider !== "copilotcli"
      || !options.model || !providers.find(row => row.id === "copilotcli")?.models.includes(options.model)) {
      throw new Error("AgentHost Mission tool policy or selected model is unsupported; no native session was created.");
    }
    const handle = await this.invoke<WorkerSessionHandle>({ operation: "create", options: { provider: "copilotcli", model: options.model, workspaceRoot: options.workspaceRoot } });
    if (!handle?.sessionId || handle.workerId !== this.id) throw new Error("Malformed native worker handle; creation is unknown, do not retry.");
    this.sessions.set(handle.sessionId, handle); return handle;
  }
  async *send(session: WorkerSessionHandle, input: WorkerInput): AsyncIterable<WorkerEvent> {
    this.require(session); await this.invoke({ operation: "start", handle: session, input });
    session.state = "running";
    try {
      for (;;) {
        const batch = await this.invoke<{ events: WorkerEvent[]; active: boolean }>({ operation: "poll", handle: session });
        if (!batch || !Array.isArray(batch.events) || typeof batch.active !== "boolean") throw new Error("Malformed native worker poll; do not replay.");
        for (const event of batch.events) { if (event.inputId !== input.inputId) throw new Error("Native event belongs to another input"); yield event; }
        if (!batch.active) break;
      }
    } finally { session.state = "idle"; }
  }
  async submitCapabilityResult(session: WorkerSessionHandle, result: WorkerCapabilityResultInput): Promise<void> {
    this.require(session); await this.invoke({ operation: "complete", handle: session, result });
  }
  async interrupt(session: WorkerSessionHandle): Promise<void> { this.require(session); await this.invoke({ operation: "interrupt", handle: session }); session.state = "interrupted"; }
  async dispose(session: WorkerSessionHandle): Promise<void> { this.require(session); await this.invoke({ operation: "dispose", handle: session }); this.sessions.delete(session.sessionId); session.state = "disposed"; }
  private require(session: WorkerSessionHandle): void { if (session.workerId !== this.id || !this.sessions.has(session.sessionId)) throw new Error("No AgentHost Mission session is owned by this adapter."); }
}

export class AgentHostWorkerCandidateSource implements WorkerAssignmentCandidateSource {
  constructor(private readonly workers: WorkerSessionManager, private readonly trusted: () => boolean, private readonly id = "nimora.agent-host") {}
  async enumerateCandidates(): Promise<readonly WorkerAssignmentCandidate[]> {
    if (!this.trusted() || !this.workers.getWorker(this.id)) return [];
    const descriptor = await this.workers.refresh(this.id), health = await this.workers.healthWorker(this.id);
    const providers = descriptor.capabilities.extensions?.providers as Discovery["providers"] | undefined;
    return (providers ?? []).map(provider => ({ candidateId: "ahp:" + createHash("sha256").update(JSON.stringify([this.id, provider.id, provider.models])).digest("hex"),
      workerId: this.id, provider: provider.id, kind: "agent-host", availability: descriptor.availability === "available" && provider.id === "copilotcli" && provider.models.length ? "available" : "unavailable", models: provider.models.slice(0, 64),
      capabilities: { streaming: descriptor.capabilities.streaming, reasoning: descriptor.capabilities.reasoning,
        capabilityRequests: descriptor.capabilities.capabilityRequests && provider.id === "copilotcli", imageInput: descriptor.capabilities.imageInput,
        checkpoints: descriptor.capabilities.checkpoints, interruption: descriptor.capabilities.interruption, persistentContext: descriptor.capabilities.persistentContext },
      health: { status: health.status, checkedAt: health.checkedAt, ...(health.message ? { message: health.message } : {}) },
      observedAt: health.checkedAt, observationId: randomUUID() }));
  }
  async refreshCandidate(candidate: WorkerAssignmentCandidate): Promise<WorkerAssignmentCandidate | undefined> {
    return (await this.enumerateCandidates()).find(row => row.candidateId === candidate.candidateId && row.provider === candidate.provider);
  }
  async materializeSessionOptions(candidate: WorkerAssignmentCandidate, selection: WorkerAssignmentSelection): Promise<WorkerSessionOptions> {
    const current = await this.refreshCandidate(candidate);
    if (!current || current.availability !== "available" || current.provider !== "copilotcli" || !selection.model || !current.models.includes(selection.model)) {
      throw new Error("Native AgentHost cannot enforce this Mission's capability policy. Assignment remains unavailable; no fallback.");
    }
    return { model: selection.model, workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath, extensions: { provider: current.provider } };
  }
}
