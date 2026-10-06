import { createHash, randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { uptime } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { BridgeAccessController } from "./bridge-access-controller.js";
import { BridgeLicenseService } from "./bridge-license-service.js";
import { BridgeManager } from "./bridge-server.js";
import { configureShunCodeModel, setShunCodeApiKey } from "./config.js";
import { codexAuthManager, onCodexAuthChange } from "./codex-auth.js";
import { BranchStateStore } from "./branch-state.js";
import { registerShunCodeCustomAgents } from "./custom-agents.js";
import { createInteractiveCapabilityGrantResolver, registerCapabilityGrantManagement } from "./host-capability-approval.js";
import { preapproveWorkerSessionCapabilities, isAutomationApprovedSession, type WorkerSessionAutomationApproval } from "../../../src/worker-session-capability-preapproval.js";
import { HostCapabilityExecutionService } from "./host-capability-execution-service.js";
import { IdeToolBroker } from "./ide-tool-broker.js";
import { ShunCodeLanguageModelProvider } from "./model-provider.js";
import { registerShunCodeNativeChat, SHUNCODE_PARTICIPANT_ID } from "./native-chat.js";
import { createMissionNativeChatEntry, selectMissionWorker } from "./mission-user-entry.js";
import { connectMissionNativeMcp } from "./mission-native-mcp-connection.js";
import { reconcileMissionPendingDelivery } from "./mission-pending-delivery-reconciliation.js";
import { RuntimeClient } from "./runtime-client.js";
import { ApiWorkerAdapter } from "./api-worker-adapter.js";
import { ApiWorkerCandidateSource } from "./api-worker-candidate-source.js";
import { NimoraApiProfiles } from "./nimora-api-profiles.js";
import { resourcePreferences, resourceConsentText, registerResourceSettings } from "./nimora-resource-settings.js";
import { normalizeResourcePolicy, readResourcePolicy, resourceAssignment, RESOURCE_POLICY_PREFIX } from "../../../src/mission-resource-policy.js";
import { createPlatformSkillSource } from "./platform-skill-source.js";
import { registerNimoraProviderCleanup } from "./nimora-provider-cleanup.js";
import { AgentHostWorkerCandidateSource, PlatformAgentHostWorkerAdapter } from "./agent-host-worker-candidate-source.js";
import { TaskShadowRecorder } from "./task-shadow.js";
import { ChatGptBrowserCommandTransport } from "./chatgpt-browser-worker-transport.js";
import { WebMcpCommandTransport } from "./webmcp-worker-transport.js";
import { MissionNativeMcpBindingService } from "./mission-native-mcp-binding.js";
import { observeTrustedHostProcess } from "./trusted-process-observation.js";
import { CurrentRouteRelayClient, currentMissionRelayTargetUrl, publishPreparedMissionRelayRoute, type CurrentRouteRelaySyncResult } from "./current-route-relay.js";
import { fetchWithExtensionHostFallbacks, resolveExtensionHostProxy } from "./extension-host-proxy.mjs";
import { WebWorkerAdapter, type WebWorkerSessionOptions } from "../../../src/web-worker-adapter.js";
import { WorkerSessionManager } from "../../../src/worker-session-manager.js";
import { MissionObservationBuffer } from "../../../src/mission-observation-buffer.js";
import { WorkerPerformanceObservations } from "../../../src/worker-performance-observations.js";
import { dispatchHostCapabilityRequest } from "../../../src/host-capability-request-dispatcher.js";
import type { MissionCapabilityMaterializationRequest } from "../../../src/mission-capability-materializer.js";
import { applyWebWorkerReleaseGate, resolveWebWorkerReleaseGate } from "../../../src/web-worker-release-gate.js";
import type { WorkerCapabilityResultInput, WorkerInput } from "../../../src/worker-contract.js";
import { projectTaskCenterState } from "../../../src/task-center-projection.js";
import { ProjectStore } from "../../../src/project-store.js";
import { MissionCollaborationStore } from "../../../src/mission-collaboration-store.js";
import { MANAGED_TERMINAL_OPEN_COMMAND, registerTaskCenterSessions } from "./task-center-sessions.js";
import { createMissionWorkProductionComposition } from "./mission-work-production-composition.js";
import { registerNimoraProductLayer } from "./nimora-product-layer.js";
import { isNimoraWebAiProvider, prepareNimoraWebAi, type WebAiPreparationObservation } from "./nimora-web-ai-onboarding.js";
import { NimoraWebCognitionPool } from "./nimora-web-cognition.js";
import { registerNimoraPlannedWorkerAssignment } from "./nimora-planned-worker-assignment.js";
import { registerNimoraAutonomyEntry } from "./nimora-autonomy-entry.js";
import { autonomyStartClaims, NimoraAutonomyStartConsent } from "./nimora-autonomy-start-consent.js";
import { assertAutonomousWebFormationOwnership } from "../../../src/mission-web-autonomy-formation.js";
import { bindHumanSelectedWebProvider } from "../../../src/mission-web-provider-selection.js";
import { NimoraProjectCompletionEntry, projectCompletionMissionFacts, type ProjectCompletionAttempt } from "./nimora-project-completion.js";
import { NimoraLaterRootEntry } from "./nimora-later-root-entry.js";
import { requireActiveProjectRoot } from "../../../src/project-active-root.js";
import { validateReviewedWebCognition } from "./nimora-reviewed-web-cognition.js";
import { prepareExactFreshDeepSeekWorkers, inspectUnboundDeepSeekPages } from "./nimora-reviewed-worker-takeover.js";
import { recoverReviewedFirstReadWorkers, recoverReviewedSettledMissionWorkers, assertReviewedFreshReadWorkers, reviewedReadRecoveryKind, reviewedReadAction } from "./nimora-reviewed-mission-recovery.js";
import { assertReviewedReadContinuation, recoverReviewedSettledReadWorkers, reviewedReadContinuationAction, type ReviewedReadContinuationState } from "./nimora-reviewed-read-continuation.js";
import { inspectPracticePage, prepareReviewedPractice, assertReviewedPracticeReady, practiceFailureDigest, practiceOutcomeDigest, practiceNeedsFailureReview, type ReviewedPracticeState } from "./nimora-reviewed-practice-entry.js";
import { assertReviewedFreshReplacementEligible, replaceReviewedClosedPages } from "./nimora-reviewed-fresh-worker-replacement.js";
import { checkWebAiConnection, WEB_AI_CONNECTION_CHECK_PROMPT, type WebAiConnectionCheckReceipt } from "./nimora-web-ai-connection-check.js";
import { readProjectMissionPresentation } from "../../../src/project-mission-presentation.js";
import { formationCognitionPrompt } from "./mission-user-entry.js";
import { MissionFormationOutcomeUnknownError, missionEntryCapabilityMaterialization } from "../../../src/mission-user-entry-application.js";
import {
  SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES,
  shunCodeMissionCapabilityExecutionRoutes,
} from "./bridge-task-tool-definitions.js";

let activeBridge: BridgeManager | undefined;
const CURRENT_ROUTE_RELAY_URL_SETTING = "bridge.currentRouteRelayUrl";
const CURRENT_ROUTE_RELAY_SECRET_KEY = "shuncode.bridge.currentRouteRelaySecret";
const CURRENT_ROUTE_RELAY_MISSION_KEY = "shuncode.bridge.currentRouteRelayMissionId";

function bridgeWorkspaceUri(relativePath: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("No workspace folder is open.");
  const normalized = relativePath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || normalized.startsWith("/")) {
    throw new Error(`Invalid Bridge workspace path: ${relativePath}`);
  }
  return vscode.Uri.joinPath(folder.uri, ...normalized.split("/").filter(Boolean));
}

function bridgeDiffSnippet(diff: string, filePath?: string): { before: string; after: string } {
  const lines = diff.split(/\r?\n/);
  let active = !filePath;
  const before: string[] = [];
  const after: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith("--- ")) {
      const oldPath = line.slice(4).replace(/^a\//, "");
      const next = lines[index + 1]?.startsWith("+++ ") ? lines[index + 1].slice(4).replace(/^b\//, "") : "";
      active = !filePath || oldPath === filePath || next === filePath;
      continue;
    }
    if (!active || line.startsWith("+++ ") || line.startsWith("@@") || line === "\\ No newline at end of file") continue;
    if (line.startsWith("-")) before.push(line.slice(1));
    else if (line.startsWith("+")) after.push(line.slice(1));
    else if (line.startsWith(" ")) {
      before.push(line.slice(1));
      after.push(line.slice(1));
    }
  }
  return { before: before.join("\n"), after: after.join("\n") };
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("ShunCode");
  const ideToolBroker = new IdeToolBroker();
  const runtimeIncarnationId = randomUUID();
  const taskShadow = new TaskShadowRecorder(context, output, runtimeIncarnationId);
  const taskRuntime = taskShadow.executionRuntime();
  const observations = new MissionObservationBuffer();
  context.subscriptions.push(taskShadow.onDidRecordTask(({ task, event }) => observations.recordTask(task, event)));
  const projectStore = new ProjectStore({
    storageDirectory: vscode.Uri.joinPath(context.globalStorageUri, "project-store-v1").fsPath,
    log: message => output.appendLine(message),
    onDidChange: event => observations.recordProject(event, taskRuntime.listTasks()),
  });
  const missionCollaborationStore = new MissionCollaborationStore({
    storageDirectory: vscode.Uri.joinPath(context.globalStorageUri, "mission-collaboration-v1").fsPath,
    projects: projectStore,
    tasks: taskRuntime,
    log: message => output.appendLine(message),
    onDidRecordExchange: exchange => observations.recordExchange(exchange, taskRuntime.listTasks()),
  });
  void missionCollaborationStore.initialize().catch(error => {
    output.appendLine(`[project-mission-presentation] canonical owner initialization failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const automationApprovalsKey = "nimora.workerSessionAutomationApprovals";
  const automationApprovals = () => context.workspaceState.get<WorkerSessionAutomationApproval[]>(automationApprovalsKey, []);
  const capabilityGrants = createInteractiveCapabilityGrantResolver(taskRuntime, output,
    request => !isAutomationApprovedSession(taskRuntime, request, automationApprovals()));
  registerCapabilityGrantManagement(context, taskRuntime);
  const hostCapabilityExecution = new HostCapabilityExecutionService(
    taskRuntime,
    ideToolBroker,
    capabilityGrants,
    () => vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [],
  );
  output.appendLine("[extension] host capability execution service staged; automatic dispatch is opt-in only via hostManagedCapabilities");
  void hostCapabilityExecution;
  const performanceObservations = new WorkerPerformanceObservations();
  const webWorkerSessions = new WorkerSessionManager({ taskBindings: taskShadow, executionProjection: taskShadow,
    observeTurn: observation => performanceObservations.record(observation),
    beforeSend: async session => {
      if (!vscode.workspace.isTrusted) throw new Error("工作区信任已撤销；没有发送 Provider 请求。");
      if (!session.taskId) return;
      const task = await taskRuntime.rereadTask(session.taskId);
      if (!task?.mission) return;
      const root = await taskRuntime.rereadTask(task.mission.rootMissionId);
      if (!root) throw new Error("发送前本轮 root 不可读取。");
      const policy = readResourcePolicy(root);
      if (!policy) return; // historical inputs retain their original contract
      const workspace = vscode.workspace.workspaceFolders;
      const project = projectStore.getProject(task.mission.projectId);
      if (workspace?.length !== 1 || workspace[0].uri.scheme !== "file" || project?.workspace !== workspace[0].uri.fsPath) throw new Error("资源授权工作区已变化。");
      const descriptor = webWorkerSessions.getWorker(session.workerId);
      const assignment = resourceAssignment(policy, { projectId: task.mission.projectId, rootMissionId: root.taskId }, task.taskId, task.mission.plane);
      if (!descriptor || !assignment.constraints?.allowedKinds?.includes(descriptor.kind)
        || (descriptor.kind === "web" && session.workerId !== "nimora.web-worker")
        || (descriptor.kind === "api" && session.workerId !== "nimora.api-runtime")) throw new Error("当前 Worker 超出本轮资源授权；发送已拒绝。");
      if ((assignment.constraints.requiredModel && session.model !== assignment.constraints.requiredModel)
        || !Object.entries(assignment.constraints.requiredCapabilities ?? {}).every(([key, value]) => descriptor.capabilities[key as keyof typeof descriptor.capabilities] === value)) throw new Error("发送前模型/能力硬要求已变化。");
    },
  });
  const webMcpCommands = {
    executeCommand: <T>(command: string, ...args: unknown[]) => vscode.commands.executeCommand<T>(command, ...args),
  };
  const webWorkerTransport = new WebMcpCommandTransport(webMcpCommands, {
    capabilityProjection: () => {
      const gate = resolveWebWorkerReleaseGate(
        vscode.workspace.getConfiguration("shuncode.webWorker").get<boolean>("hostManagedCapabilities", false),
        vscode.workspace.isTrusted,
      );
      return gate.effective
        ? {
            nativeByName: false,
            externalDefinitions: true,
            executionRoutes: shunCodeMissionCapabilityExecutionRoutes(
              "external-schema",
              "webmcp-host-requested",
              "Trusted host-managed WebMCP turns enforce exact external schemas/allowed names and dispatch through Nimora host execution.",
            ),
          }
        : { nativeByName: false, externalDefinitions: false, executionRoutes: [] };
    },
    prepareInput: input => applyWebWorkerReleaseGate(input, resolveWebWorkerReleaseGate(
      vscode.workspace.getConfiguration("shuncode.webWorker").get<boolean>("hostManagedCapabilities", false),
      vscode.workspace.isTrusted,
    )),
  });
  const webWorkerAdapter = new WebWorkerAdapter(webWorkerTransport);
  const webWorkerReady = webWorkerSessions.register(webWorkerAdapter).then(descriptor => {
    output.appendLine(`[extension] Web worker registered: ${descriptor.id} via ${descriptor.provider}`);
    return descriptor;
  }, error => {
    output.appendLine(`[extension] Web worker registration failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  });
  const chatGptWorkerTransport = new ChatGptBrowserCommandTransport(webMcpCommands, {
    capabilityProjection: () => {
      const nativeMcpEnabled = vscode.workspace.getConfiguration("shuncode.chatgpt").get<boolean>("nativeMcpCapabilities", false);
      const effective = nativeMcpEnabled && vscode.workspace.isTrusted;
      return effective
        ? {
            nativeByName: true,
            externalDefinitions: false,
            executionRoutes: shunCodeMissionCapabilityExecutionRoutes(
              "native-by-name",
              "chatgpt-native-mcp",
              "Explicitly enabled ChatGPT native MCP is bound to the exact managed Mission WorkerSession and reuses canonical Nimora capability execution owners.",
            ),
          }
        : { nativeByName: false, externalDefinitions: false, executionRoutes: [] };
    },
  });
  const chatGptWorkerAdapter = new WebWorkerAdapter(chatGptWorkerTransport, "nimora.chatgpt-browser-worker");
  const chatGptWorkerReady = webWorkerSessions.register(chatGptWorkerAdapter).then(descriptor => {
    output.appendLine(`[extension] ChatGPT browser worker registered: ${descriptor.id} via ${descriptor.provider}`);
    return descriptor;
  }, error => {
    output.appendLine(`[extension] ChatGPT browser worker registration failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  });
  const runtime = new RuntimeClient(context, output, ideToolBroker);
  const apiModelProvider = new ShunCodeLanguageModelProvider(context, "api");
  const codexModelProvider = new ShunCodeLanguageModelProvider(context, "codex");
  const apiProfiles = new NimoraApiProfiles(context);
  const apiWorkerReady = webWorkerSessions.register(new ApiWorkerAdapter(runtime, "nimora.api-runtime", "nimora-api", true));
  const agentHostWorkerReady = webWorkerSessions.register(new PlatformAgentHostWorkerAdapter());
  const apiCandidates = new ApiWorkerCandidateSource(webWorkerSessions, async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!vscode.workspace.isTrusted || folders?.length !== 1 || folders[0].uri.scheme !== "file") return undefined;
    const profiles = await apiProfiles.configurations(folders[0].uri.fsPath);
    const config = await apiModelProvider.resolveRuntimeModel().catch(() => undefined);
    if (!config || (config.legacy && !config.apiKey?.trim())) return profiles;
    return [...profiles, { provider: "nimora-api", profileId: "legacy", model: config.model, workspaceRoot: folders[0].uri.fsPath,
      runtime: { protocol: config.protocol === "anthropic-messages" ? "anthropic-messages" : config.protocol === "openai-responses" ? "openai-responses" : "chat-completions",
        baseUrl: config.baseUrl, apiKey: config.apiKey, deepSeek: config.deepSeek, thinking: config.thinking,
        reasoningEffort: config.reasoningEffort as any, serviceTier: config.serviceTier as any,
        maxOutputTokens: config.maxOutputTokens, retries: 0 } }];
  });
  const productionWorkersReady = Promise.all([chatGptWorkerReady, webWorkerReady, apiWorkerReady, agentHostWorkerReady]);
  const missionNativeMcp = new MissionNativeMcpBindingService(
    taskRuntime,
    webWorkerSessions,
    hostCapabilityExecution,
    SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES,
  );
  const missionWorkCanonicalOwners = {
    projects: projectStore,
    tasks: taskRuntime,
    collaboration: missionCollaborationStore,
    workers: webWorkerSessions,
  };
  const missionWorkProduction = createMissionWorkProductionComposition(
    missionWorkCanonicalOwners,
    webMcpCommands,
    hostCapabilityExecution,
    missionNativeMcp,
    {
      orphanRecoveryHost: {
        currentRuntimeIncarnationId: runtimeIncarnationId,
        currentProcessId: process.pid,
        currentSystemBootAt: () => new Date(Date.now() - uptime() * 1000),
        observeProcess: observeTrustedHostProcess,
        isProviderAdapterSessionRediscoverable: async (workerId, adapterSessionId) => {
          if (workerId === "nimora.web-worker") {
            const raw = await webMcpCommands.executeCommand<unknown>("_shuncode.webMcp.workerListResources");
            return Array.isArray(raw) && raw.some(value => {
              if (!value || typeof value !== "object" || Array.isArray(value)) return false;
              const row = value as Record<string, unknown>;
              return row.pageSessionId === adapterSessionId
                && row.ready === true
                && row.sessionIdentityCompatible === true;
            });
          }
          if (workerId === "nimora.chatgpt-browser-worker") {
            const raw = await webMcpCommands.executeCommand<unknown>("_shuncode.chatgptWorker.listResources");
            return Array.isArray(raw) && raw.some(value => {
              if (!value || typeof value !== "object" || Array.isArray(value)) return false;
              const row = value as Record<string, unknown>;
              return row.lifecycleIdentity === adapterSessionId
                && row.ready === true
                && row.composerFound === true;
            });
          }
          return false;
        },
      },
    },
    { candidateSources: [apiCandidates, new AgentHostWorkerCandidateSource(webWorkerSessions, () => vscode.workspace.isTrusted)], softLatency: candidate => performanceObservations.latency(candidate), skillSources: [createPlatformSkillSource()], approvedSkills: async scope => {
      const key = JSON.stringify([scope.projectId, scope.rootMissionId]);
      const approved = context.workspaceState.get<Record<string, { skillId: string; sourceId: string; canonicalLocator: string; contentDigest: string }[]>>("nimora.rootSkillTrust.v1", {})[key] ?? [];
      if (!approved.length) return [];
      if (!vscode.workspace.isTrusted) throw new Error("当前工作区未信任，不能载入外部 Skill。");
      const index = await missionWorkProduction.skills.discover();
      for (const row of approved) {
        const fresh = index.skills.find(skill => skill.skillId === row.skillId && skill.enabled);
        if (!fresh || fresh.sourceId !== row.sourceId || fresh.canonicalLocator !== row.canonicalLocator
          || (await index.loadContent(row.skillId)).contentDigest !== row.contentDigest) throw new Error("本轮已选择的 Skill 内容／来源变化，请重新选择 Skills。");
      }
      return approved.map(row => row.skillId);
    } },
  );
  const cognitionSources = [missionWorkProduction.webCandidates, apiCandidates];
  const cognitionCandidates: import("../../../src/worker-assignment.js").WorkerAssignmentCandidateSource & { reservePlanningPage(pageId: string): void; releasePlanningPage(pageId: string): void } = {
    enumerateCandidates: async () => (await Promise.all(cognitionSources.map(source => source.enumerateCandidates()))).flat(),
    refreshCandidate: async candidate => {
      const rows = (await Promise.all(cognitionSources.map(source => source.refreshCandidate(candidate)))).filter(row => !!row);
      if (rows.length > 1) throw new Error("规划候选资源身份冲突。");
      return rows[0];
    },
    materializeSessionOptions: async (candidate, selection) => {
      for (const source of cognitionSources) if (await source.refreshCandidate(candidate)) return source.materializeSessionOptions(candidate, selection);
      throw new Error("规划候选配置已变化；没有创建会话。");
    },
    reservePlanningPage: pageId => missionWorkProduction.webCandidates.reservePlanningPage(pageId),
    releasePlanningPage: pageId => missionWorkProduction.webCandidates.releasePlanningPage(pageId),
  };
  const webCognitionPool = new NimoraWebCognitionPool(webWorkerSessions, cognitionCandidates,
    event => output.appendLine(`[Nimora Cognition JSON] ${JSON.stringify(event)}`), projectId => {
      if (!projectId) return resourcePreferences(context).planner;
      const root = requireActiveProjectRoot(taskRuntime.listTasks(), projectId);
      return readResourcePolicy(root)?.planner ?? resourcePreferences(context).planner;
    });
  context.subscriptions.push(registerResourceSettings(context),
    vscode.commands.registerCommand("shuncode.nimora.configureApiProfiles", () => apiProfiles.configure()),
    vscode.commands.registerCommand("shuncode.nimora.resourceStatus", () => ({ preferences: resourcePreferences(context), profiles: apiProfiles.list(), performance: performanceObservations.snapshot() })));
  // Ephemeral single-flight connection preparation; canonical WorkerSession
  // ownership and page observation still belong to their existing owners.
  const webPreparations = new Map<"deepseek" | "chatgpt", Promise<Awaited<ReturnType<typeof prepareNimoraWebAi>>>>();
  const prepareWebProvider = async (provider: "deepseek" | "chatgpt", minReady = 1, onProgress?: (progress: WebAiPreparationObservation) => void) => {
    // Re-check after every wait: three callers may all have observed the same
    // earlier preparation, and must not race to open a second/third page.
    while (webPreparations.has(provider)) await webPreparations.get(provider)!;
    const source = provider === "deepseek" ? missionWorkProduction.webCandidates : missionWorkProduction.chatGptCandidates;
    const work = prepareNimoraWebAi(provider, source, undefined, { minReady, onProgress });
    webPreparations.set(provider, work);
    try { return await work; }
    finally { if (webPreparations.get(provider) === work) webPreparations.delete(provider); }
  };
  let webProjectStartInFlight = false;
  const webAutonomyStartConsent = new NimoraAutonomyStartConsent();
  const webConnectionsInFlight = new Set<"deepseek" | "chatgpt">();
  const projectMissionPresentationOwners = {
    projects: missionWorkProduction.owners.projects,
    tasks: missionWorkProduction.owners.tasks,
    collaboration: missionWorkProduction.owners.collaboration,
  };
  output.appendLine("[extension] Mission Work production composition staged on canonical Project/Task/Collaboration/Worker owners");
  const bridgeLicense = new BridgeLicenseService(context, output);
  const authorizeBridgeStart = async () => {
    output.appendLine("[bridge] free access enabled");
    return;
    const developmentSmokeBypass = context.extensionMode === vscode.ExtensionMode.Development
      && process.env.SHUNCODE_BRIDGE_LICENSE_SMOKE_BYPASS === "1";
    if (developmentSmokeBypass) {
      output.appendLine("[bridge-license] development smoke authorization bypass enabled");
      return;
    }
    await bridgeLicense.requireFeature("bridge");
  };
  const bridge = new BridgeManager(context, output, ideToolBroker, taskShadow, authorizeBridgeStart, missionNativeMcp);
  const bridgeAccess = new BridgeAccessController(bridgeLicense, bridge, output);
  let currentNativeMcpBindingToken: string | undefined;
  // Transport selection only. Never persist an ephemeral Worker/binding generation.
  let currentNativeMcpMissionId = context.workspaceState.get<string>(CURRENT_ROUTE_RELAY_MISSION_KEY);
  let currentRouteRelayClient: CurrentRouteRelayClient | undefined;
  let currentRouteRelayClientKey = "";
  let lastCurrentRouteRelaySync: CurrentRouteRelaySyncResult | undefined;
  let currentRouteRelaySyncTail: Promise<void> = Promise.resolve();

  const configuredCurrentRouteRelayUrl = () =>
    vscode.workspace.getConfiguration("shuncode").get<string>(CURRENT_ROUTE_RELAY_URL_SETTING, "").trim();

  const relayClient = async (): Promise<CurrentRouteRelayClient | undefined> => {
    const relayUrl = configuredCurrentRouteRelayUrl();
    if (!relayUrl) return undefined;
    const secret = await context.secrets.get(CURRENT_ROUTE_RELAY_SECRET_KEY) ?? "";
    if (!secret) throw new Error("Current Route relay is configured but its update secret is missing.");
    const key = `${relayUrl}\n${secret}`;
    if (currentRouteRelayClient && currentRouteRelayClientKey === key) return currentRouteRelayClient;
    currentRouteRelayClient = new CurrentRouteRelayClient(relayUrl, secret, async request => {
      const target = new URL(request.url);
      const response = await fetchWithExtensionHostFallbacks(target, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        proxyUrl: resolveExtensionHostProxy(target),
        attemptTimeoutMs: 10_000,
        log: message => output.appendLine(`[current-route-relay] ${message}`),
      });
      return { status: response.status, body: await response.text() };
    });
    currentRouteRelayClientKey = key;
    return currentRouteRelayClient;
  };

  const syncCurrentRouteRelay = async (reason: string): Promise<CurrentRouteRelaySyncResult | undefined> => {
    const missionId = currentNativeMcpMissionId;
    if (!missionId) return undefined;
    await productionWorkersReady;
    await taskRuntime.initialize();
    const task = taskRuntime.getTask(missionId);
    if (!task?.mission || task.missionFinalization || ["completed", "failed", "cancelled"].includes(task.status)) return undefined;
    const status = bridge.getStatus();
    if (!status.publicUrl) return undefined;
    // Publish the durable alias even before a replacement binding is prepared.
    // Requests remain 404 until the canonical current Worker has a fresh binding.
    const targetUrl = currentMissionRelayTargetUrl(status.publicUrl, missionId);
    const bindingToken = missionNativeMcp.getBindingForMission(missionId)?.token;
    const client = await relayClient();
    if (!client) return undefined;
    const result = await client.sync({
      targetUrl,
      bindingToken,
      bridgeRevision: status.revision,
      reason,
    });
    lastCurrentRouteRelaySync = result;
    output.appendLine(`[current-route-relay] ${result.changed ? "published" : "verified"} stable=${result.stableMcpUrl} target=${result.targetUrl} generation=${result.generation ?? "unchanged"}`);
    return result;
  };

  const enqueueCurrentRouteRelaySync = (reason: string, strict = false): Promise<CurrentRouteRelaySyncResult | undefined> => {
    let resolveResult!: (value: CurrentRouteRelaySyncResult | undefined) => void;
    let rejectResult!: (error: unknown) => void;
    const resultPromise = new Promise<CurrentRouteRelaySyncResult | undefined>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    currentRouteRelaySyncTail = currentRouteRelaySyncTail.then(async () => {
      try {
        resolveResult(await syncCurrentRouteRelay(reason));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[current-route-relay] sync failed (${reason}): ${message}`);
        rejectResult(error);
      }
    }).catch(error => {
      output.appendLine(`[current-route-relay] sync queue recovered: ${error instanceof Error ? error.message : String(error)}`);
    });
    if (!strict) return resultPromise.catch(() => undefined);
    return resultPromise;
  };

  context.subscriptions.push(bridge.onDidChangePublicUrl(publicUrl => {
    if (!publicUrl || !currentNativeMcpMissionId) return;
    void enqueueCurrentRouteRelaySync("bridge-public-url-changed");
  }));
  activeBridge = bridge;
  const bridgeReady = bridge.initialize();
  void bridgeReady.then(() => enqueueCurrentRouteRelaySync("runtime-ready"), error => {
    output.appendLine(`[current-route-relay] startup unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });
  const bridgeLicenseReady = bridgeLicense.initialize();
  const publishMissionMcpConnection = (binding: { missionId: string; token: string }, startBridge: boolean) =>
    publishPreparedMissionRelayRoute(binding, {
      selectBinding: async selected => {
        currentNativeMcpBindingToken = selected.token;
        currentNativeMcpMissionId = selected.missionId;
        await context.workspaceState.update(CURRENT_ROUTE_RELAY_MISSION_KEY, selected.missionId);
      },
      prepareUrls: async () => {
        await bridgeReady;
        if (startBridge && bridge.getStatus().state !== "running") {
          await bridgeLicenseReady;
          await bridgeAccess.start();
        }
        return bridge.getCurrentMissionNativeMcpUrls(binding.missionId);
      },
      syncRelay: () => enqueueCurrentRouteRelaySync("mission-native-mcp-prepared"),
    });
  const branchStore = new BranchStateStore(context, output);
  const missionEntry = createMissionNativeChatEntry(missionWorkProduction, productionWorkersReady, runtime, {
    shuncode: apiModelProvider, "shuncode-codex": codexModelProvider,
  }, context.extensionPath);
  // Web-native Cognition is tools-free and uses an unbound, dedicated DeepSeek
  // page. The existing Mission entry still exclusively owns Formation and the
  // Coordinator -> Target execution path.
  const interpretThroughWeb = async (input: import("../../../src/mission-user-entry-application.js").FormationCognitionInput, planningSessionId: string,
    resources = resourcePreferences(context)): Promise<string> => {
    const selectedWebBackend = await webCognitionPool.inspectBackend(planningSessionId);
    const observed = await Promise.allSettled(missionWorkProduction.assignmentCandidateSources.map(source => source.enumerateCandidates()));
    const candidates = observed.flatMap(result => result.status === "fulfilled" ? result.value.map(candidate => ({
      provider: candidate.provider, kind: candidate.kind, models: candidate.models,
      availability: candidate.availability, capabilities: candidate.capabilities,
    })) : []);
    const raw = await webCognitionPool.runJson(planningSessionId, formationCognitionPrompt(input, candidates, {
      autonomousWebProject: !input.existingScope,
      preserveWebJson: true,
      selectedWebBackend,
      resourcePolicy: resources,
    }));
    if (input.existingScope) return raw;
    // A product-button provider selection is Human authority, not a preference
    // the provider may silently reinterpret. Preserve model/capability hard
    // requirements and preflight them against current candidates before birth.
    const row = JSON.parse(raw) as Record<string, any>;
    assertAutonomousWebFormationOwnership(row);
    if (resources.mode === "web") bindHumanSelectedWebProvider(row, candidates as import("../../../src/worker-assignment.js").WorkerAssignmentCandidate[], "deepseek",
      await webCognitionPool.inspectBackend(planningSessionId));
    else for (const [key, plane] of [["coordinatorPolicy", "coordination"], ["workerPolicy", "cognition"]] as const) {
      const selected = resourceAssignment(resources, { projectId: "formation", rootMissionId: "formation" }, "formation", plane);
      const prior = row[key];
      if (!prior || typeof prior !== "object" || Array.isArray(prior)) throw new Error("建项资源策略无效。");
      const hard = prior.constraints?.requiredCapabilities ?? {};
      const model = prior.constraints?.requiredModel;
      if (!Object.entries(hard).every(([name, expected]) => selectedWebBackend.capabilities[name as keyof typeof selectedWebBackend.capabilities] === expected)
        || (model && !selectedWebBackend.models.includes(model))) throw new Error("所选总文不能证明建项的模型/传输硬要求。");
      row[key] = { constraints: { ...selected.constraints, requiredCapabilities: { ...hard, capabilityRequests: true }, ...(model ? { requiredModel: model } : {}) }, preferences: selected.preferences };
    }
    if (!row.initialRoot || !Array.isArray(row.initialRoot.constraints ?? []) || (row.initialRoot.constraints ?? []).some((c: unknown) => typeof c !== "string")) throw new Error("Root 约束无效。");
    const roleRequirements = Object.fromEntries([["cognition", row.workerPolicy], ["coordination", row.coordinatorPolicy]].map(([plane, p]) => {
      const constraints = (p as any).constraints ?? {};
      return [plane, { ...(constraints.requiredModel ? { requiredModel: constraints.requiredModel } : {}), ...(constraints.requiredCapabilities ? { requiredCapabilities: constraints.requiredCapabilities } : {}) }];
    }));
    const rootResources = normalizeResourcePolicy({ ...resources, roleRequirements });
    row.initialRoot.constraints = [...(row.initialRoot.constraints ?? []).filter((c: unknown) => typeof c === "string" && !c.startsWith(RESOURCE_POLICY_PREFIX)), RESOURCE_POLICY_PREFIX + JSON.stringify(rootResources)];
    return JSON.stringify(row);
  };
  const webTaskOutput = vscode.window.createOutputChannel("Nimora · Web AI 工作结果");
  let webTaskChars = 0;
  const webTargetText = (value: string): void => {
    if (webTaskChars < 32_000) {
      webTaskOutput.append(value.slice(0, 32_000 - webTaskChars));
      webTaskChars += value.length;
    }
  };
  const participant = registerShunCodeNativeChat(context, runtime, output, {
    shuncode: apiModelProvider,
    "shuncode-codex": codexModelProvider,
  }, branchStore, taskShadow, missionEntry);
  registerTaskCenterSessions(context, taskShadow, projectMissionPresentationOwners, participant, missionEntry, SHUNCODE_PARTICIPANT_ID, output);
  const oneTrustedWorkspace = (): string => {
    const folders = vscode.workspace.workspaceFolders;
    if (!vscode.workspace.isTrusted || folders?.length !== 1 || folders[0].uri.scheme !== "file") {
      throw new Error("网页版 Project Beta 需要一个已信任的独立本地工作文件夹；不要在 Nimora 源码多文件夹工作区中测试。");
    }
    return folders[0].uri.fsPath;
  };
  const enableExplicitWebCapabilities = async (): Promise<boolean> => {
    const setting = vscode.workspace.getConfiguration("shuncode.webWorker");
    if (setting.get<boolean>("hostManagedCapabilities", false)) return true;
    const consent = await vscode.window.showWarningMessage(
      "DeepSeek 网页 Mission 需要启用 ShunCode 全局 Host-managed WebMCP 开关。此开关不会跳过网页共享或具体文件、终端工具的授权，但会允许已授权网页 Worker 提出此类工具请求。是否启用？",
      { modal: true }, "允许并启用", "取消",
    );
    if (consent !== "允许并启用") return false;
    await setting.update("hostManagedCapabilities", true, vscode.ConfigurationTarget.Global);
    return true;
  };
  const reportWebPreparation = (progress: WebAiPreparationObservation, reporter?: vscode.Progress<{ message?: string }>) => {
    const phase = progress.phase === "opening" ? "打开并申请共享" : progress.phase === "discovering" ? "检查现有资源" : "探测网页就绪状态";
    const message = `${phase}：${progress.healthy}/${progress.required} 就绪、${progress.observed} 个候选；本轮剩余 ${progress.attemptsRemaining} 次检测`;
    reporter?.report({ message });
    output.appendLine(`[nimora:web-preparation] ${progress.provider} ${message}`);
  };
  const openDeepSeekPages = async (minReady: number, reporter?: vscode.Progress<{ message?: string }>): Promise<boolean> => {
    const state = await prepareWebProvider("deepseek", minReady, event => reportWebPreparation(event, reporter));
    if (state.state === "ready") return true;
    await vscode.window.showWarningMessage(state.state === "sharing-declined"
      ? "网页共享未获得授权；Nimora 未发送规划请求，也没有创建 Project。"
      : `DeepSeek 网页尚未就绪：${state.detail}。请完成网页登录及网页共享，再重新操作。`);
    return false;
  };
  const webFormationConfirm = async (pending: import("../../../src/project-formation-application-service.js").ProjectFormationPendingConfirmation, plan: {
    instruction: string; additionalMissions?: import("../../../src/mission-cognition-plan.js").CognitionPlannedMission[];
  }) =>
    await vscode.window.showInformationMessage("确认网页版 AI 提出的 Project 范围", {
      modal: true, detail: `${pending.project.goal}\n\n首个目标：${pending.initialRoot.goal}\n完成条件：${pending.initialRoot.completionCriteria.join("；")}\n执行指令：${plan.instruction}\n\n规划中的额外 Mission（仅建图，不预授权执行）：${(plan.additionalMissions ?? []).map(m =>
        `\n${m.key}：${m.goal} [${m.plane}]；依赖：${m.dependsOn.join("、") || "无"}`).join("") || "无"}`,
    }, "确认并开始") === "确认并开始";
  const reviewedRecoveryFile = join(context.globalStorageUri.fsPath, "recovery", "reviewed-formation-cognition.json");
  const reviewedRecoveryPendingKey = "nimora.reviewedWebCognitionOutcomeUnknown";
  const adoptedWebProjectIdsKey = "nimora.reviewedWebFormedOnlyProjectIds";
  const reviewedTakeoverKey = "nimora.reviewedWebWorkerTakeover";
  type ReviewedTakeoverPhase = "preparing" | "ready" | "needs-reconciliation" | "mission-unknown" | "mission-sent" | "recovering" | "mission-reconciled" | "recovering-settled-read" | "recovering-settled-workers" | "replacing-new-workers";
  type ReviewedTakeoverState = {
    phase: ReviewedTakeoverPhase;
    rootMissionId?: string;
    coordinationMissionId?: string;
    /** Manual reconciliation evidence; never interpreted as live provider authority after restart. */
    pageIds?: string[];
    candidateIds?: string[];
    coordinatorSessionId?: string;
    rootSessionId?: string;
    previousAttempt?: { state: "consumed-no-replay"; rootSessionId: string; coordinatorSessionId: string; reconciledAt: string;
      dispatchIdentity?: import("../../../src/mission-user-entry-application.js").MissionEntryDispatchIdentity };
    recoveryAttachments?: Partial<Record<"coordinator" | "target" | "practice", string>>;
    dispatchIdentity?: import("../../../src/mission-user-entry-application.js").MissionEntryDispatchIdentity;
    /** Bounded transport feedback, not proof that a file tool or Mission completed. */
    lastFeedback?: { terminalStatus: string; observedAt: string; targetInputId?: string };
    consumedDispatches?: Array<{ identity: Readonly<Record<string, string>>; state: "consumed-no-replay"; reviewedAt: string }>;
    consumedReadRequests?: string[];
    practice?: ReviewedPracticeState & { consumedGoals?: string[] };
    replacement?: { attemptId: string; startedAt: string; nativeApprovedPageIds: string[];
      approvedPages?: { pageId: string; candidateId: string }[];
      mutationStarted?: boolean; assigned: Partial<Record<"coordinator" | "target" | "practice", string>>;
      previous?: { pageIds: string[]; practicePageId: string;
        sessions: { coordinator: string; target: string; practice: string };
        coordinationFailure?: ReviewedPracticeState["coordinationFailure"] } };
  };
  const liveReviewedTakeovers = new Map<string, { rootMissionId: string; coordinationMissionId: string; rootSessionId: string; coordinatorSessionId: string }>();
  let reviewedTakeoverInFlight = false;
  const reviewedFirstMissionInFlight = new Set<string>();
  const takeoverStates = () => context.workspaceState.get<Record<string, ReviewedTakeoverState>>(reviewedTakeoverKey, {});
  const recordTakeover = async (projectId: string, state: ReviewedTakeoverState) =>
    context.workspaceState.update(reviewedTakeoverKey, { ...takeoverStates(), [projectId]: state });
  // A process restart loses provider handles; never mistake a persisted ready
  // badge for authoritative live WorkerSession ownership.
  for (const [projectId, state] of Object.entries(takeoverStates())) {
    if (state.phase === "ready") {
      void recordTakeover(projectId, { ...state, phase: "needs-reconciliation" });
    }
  }
  const reviewedScope = async (projectId: string) => {
    const workspace = oneTrustedWorkspace();
    if (typeof projectId !== "string" || !context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).includes(projectId)) {
      throw new Error("必须选择本工作区内已审核旧 Cognition 形成的确切 Project。");
    }
    if (context.workspaceState.get(reviewedRecoveryPendingKey) || context.workspaceState.get("nimora.webFormationUnknown")) {
      throw new Error("旧 Formation 仍有未核实结果，不得接管 Worker 或发送新指令。");
    }
    await Promise.all([missionWorkProduction.owners.projects.initialize(), missionWorkProduction.owners.tasks.initialize()]);
    const project = missionWorkProduction.owners.projects.getProject(projectId);
    if (!project?.formationReceipt || project.formationReceipt.project.workspace !== workspace
      || project.formationReceipt.authorization.kind !== "human-confirmed") throw new Error("Project 的人工审核 Formation/工作区身份不一致。");
    const rootCandidates = missionWorkProduction.owners.tasks.listTasks().filter(task => task.mission?.projectId === projectId
      && task.mission.rootMissionId === task.taskId);
    if (rootCandidates.length !== 1) throw new Error("Project 没有唯一的持久化首个 root Mission；拒绝推测接管目标。");
    const scope = await missionWorkProduction.coordinator.inspectManagedScope({ projectId, managedRootMissionId: rootCandidates[0].taskId });
    const root = missionWorkProduction.owners.tasks.getTask(scope.managedRootMissionId);
    const coordinator = missionWorkProduction.owners.tasks.getTask(scope.coordinationMissionId);
    if (!root?.mission || !coordinator?.mission || root.missionFinalization || coordinator.missionFinalization
      || [root, coordinator].some(task => Object.values(task.workerSessions).length || Object.values(task.executions).length || Object.values(task.interactions).length)
      || scope.missions.length !== 2) {
      throw new Error("审核恢复的 Project 存在旧 Worker、执行或非预期 Mission；先核实 canonical 真值，不允许自动接管。");
    }
    return { workspace, project, scope };
  };
  const takeoverReviewedWebWorkers = async (projectId: string, resume = false): Promise<{ state: string }> => {
    if (reviewedTakeoverInFlight || webProjectStartInFlight) throw new Error("已有接管或建项流程正在进行。");
    const previous = takeoverStates()[projectId];
    if (resume ? previous?.phase !== "preparing" || !!previous.coordinatorSessionId || !!previous.rootSessionId : !!previous) {
      throw new Error("此 Project 不能重新打开或绑定网页；已有 Worker 或任务须先核实原执行。");
    }
    // reviewedScope additionally proves ZERO prior canonical Worker/execution/
    // interaction history. A partial assignment is never recoverable here.
    const { project, scope } = await reviewedScope(projectId);
    const consent = await vscode.window.showWarningMessage(
      resume
        ? "继续检查已共享的空白 DeepSeek 页面并绑定 Worker？仅适用于尚未分配任何 Worker、未发送任务的接管。你需要分别选择两张网页；不会新开页面或发送消息。"
        : "为已经形成的 Project 接管全新的 DeepSeek 网页 Worker？将新开两张页面，分别为 Coordinator 和 Target 请求原生共享授权；绝不复用旧规划页，本阶段也不会发送任何网页消息或创建新 Project。",
      { modal: true, detail: `项目：${project.title}\n首个 Mission：${scope.managedRootMissionId}\n必须为新开的两张页面分别授权；任一步身份不明即停止并留待人工核实。` },
      resume ? "选择已共享页面并继续绑定" : "打开全新页面并安全绑定", "取消",
    );
    if (consent !== (resume ? "选择已共享页面并继续绑定" : "打开全新页面并安全绑定")) return { state: "cancelled" };
    if (reviewedTakeoverInFlight || takeoverStates()[projectId] !== previous) throw new Error("接管状态发生变化；拒绝第二次提交。");
    const command = "workbench.action.browser.nimoraOpenAndShareProviderPage";
    if (!(await vscode.commands.getCommands()).includes(command)) throw new Error("当前原生浏览器缺少精确网页身份的授权接口，不能安全接管旧 Project。");
    await productionWorkersReady;
    reviewedTakeoverInFlight = true;
    try {
      const baseState: ReviewedTakeoverState = { ...previous, phase: "preparing", rootMissionId: scope.managedRootMissionId, coordinationMissionId: scope.coordinationMissionId };
      const pageHost = { listResources: () => Promise.resolve(vscode.commands.executeCommand("_shuncode.webMcp.workerListResources")) };
      let approved: readonly { pageId: string; candidateId: string }[];
      if (resume) {
        const choices = await inspectUnboundDeepSeekPages(missionWorkProduction.webCandidates, pageHost);
        if (choices.length < 2) throw new Error("还没有两张已共享且就绪的空白 DeepSeek 页面；完成登录后可继续检查，不会重新开页。");
        const selected: { pageId: string; candidateId: string }[] = [];
        for (const role of ["Coordinator", "Target"]) {
          const choice = await vscode.window.showQuickPick(choices.filter(row => !selected.some(item => item.pageId === row.pageId))
            .map(row => ({ label: `${role} · DeepSeek · ${row.pageId}`, description: "已共享、健康、空白聊天页", row })),
          { title: `为原 Project 选择 ${role} 网页`, ignoreFocusOut: true });
          if (!choice) return { state: "cancelled" };
          selected.push(choice.row);
        }
        if (previous?.pageIds?.some(id => !selected.some(row => row.pageId === id))) {
          throw new Error("选择的页面不包含此前原生授权的精确页面；不能换成旧聊天页。");
        }
        const fresh = await inspectUnboundDeepSeekPages(missionWorkProduction.webCandidates, pageHost);
        if (selected.some(row => !fresh.some(item => item.pageId === row.pageId && item.candidateId === row.candidateId))) {
          throw new Error("选择期间页面身份或就绪状态改变；没有绑定 Worker。");
        }
        await reviewedScope(projectId);
        approved = selected;
      } else {
        await recordTakeover(projectId, baseState);
        approved = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Nimora · 安全接管两张全新 DeepSeek 网页", cancellable: false }, progress =>
        prepareExactFreshDeepSeekWorkers(missionWorkProduction.webCandidates, {
          ...pageHost,
          openAndShareNewPage: async () => {
            const result = await vscode.commands.executeCommand<unknown>(command, "deepseek", true);
            return result && typeof result === "object" && "shared" in result && "pageId" in result
              ? result as { shared: true; pageId: string } : undefined;
          },
          wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
        }, message => progress.report({ message }), {
          onNativePageApproved: pageIds => recordTakeover(projectId, { ...baseState, pageIds: [...pageIds] }),
        }));
      }
      const provenance = { rootMissionId: scope.managedRootMissionId, coordinationMissionId: scope.coordinationMissionId,
        pageIds: approved.map(row => row.pageId), candidateIds: approved.map(row => row.candidateId) };
      // Persist exact native page origins BEFORE the first potentially
      // ambiguous WorkerSession creation; post-crash audit never has to guess
      // whether the old Cognition page was accidentally selected.
      await recordTakeover(projectId, { phase: "preparing", ...provenance });
      // Existing canonical assignment service owns lifecycle and serialization.
      // The one-page allowlist prevents fallback to an older Cognition tab.
      const policy = { constraints: { allowedKinds: ["web"] as const, allowedProviders: ["deepseek"], requiredCapabilities: { capabilityRequests: true } },
        preferences: { providerOrder: ["deepseek"] } };
      const coordinator = await missionWorkProduction.application.assignInitialWorker({
        projectId, rootMissionId: scope.managedRootMissionId, missionId: scope.coordinationMissionId, ...policy,
      }, { exactCandidateId: approved[0].candidateId });
      if (coordinator.state !== "assigned") throw new Error("Coordinator 未绑定到新批准网页；停止并保留实际状态供对账。");
      await recordTakeover(projectId, { phase: "preparing", ...provenance,
        coordinatorSessionId: coordinator.assignment.managedSessionId });
      const target = await missionWorkProduction.application.assignInitialWorker({
        projectId, rootMissionId: scope.managedRootMissionId, missionId: scope.managedRootMissionId,
        constraints: { allowedKinds: ["web"], allowedProviders: ["deepseek"] }, preferences: { providerOrder: ["deepseek"] },
      }, { exactCandidateId: approved[1].candidateId });
      if (target.state !== "assigned" || target.assignment.managedSessionId === coordinator.assignment.managedSessionId) {
        throw new Error("Target 未形成独立可核实绑定；禁止发起首个 Mission。");
      }
      liveReviewedTakeovers.set(projectId, { rootMissionId: scope.managedRootMissionId,
        coordinationMissionId: scope.coordinationMissionId,
        rootSessionId: target.assignment.managedSessionId, coordinatorSessionId: coordinator.assignment.managedSessionId });
      await recordTakeover(projectId, { phase: "ready", ...provenance,
        coordinatorSessionId: coordinator.assignment.managedSessionId, rootSessionId: target.assignment.managedSessionId });
      vscode.window.setStatusBarMessage("Nimora：两个独立 DeepSeek Worker 已绑定；尚未发送任务。", 10_000);
      return { state: "ready" };
    } catch (error) {
      output.appendLine(`[nimora:reviewed-worker-takeover] blocked: ${error instanceof Error ? error.message : String(error)}`);
      // Keep the durable preparing marker. A possible partial assignment, an
      // extra tab, or uncertain page consent is never retry authority.
      throw error;
    } finally { reviewedTakeoverInFlight = false; }
  };
  const startReviewedFirstMission = async (projectId: string): Promise<{ state: string }> => {
    const live = liveReviewedTakeovers.get(projectId);
    const stage = takeoverStates()[projectId];
    if (!live || stage?.phase !== "ready" || reviewedTakeoverInFlight || webProjectStartInFlight) {
      throw new Error("此 Project 没有本进程内核实的两张独立 Worker，或旧任务结果尚未对账；拒绝发送。");
    }
    const workspace = oneTrustedWorkspace();
    const project = missionWorkProduction.owners.projects.getProject(projectId);
    if (!project?.formationReceipt || project.formationReceipt.project.workspace !== workspace
      || !context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).includes(projectId)) throw new Error("Project 的持久工作区/人工恢复身份失效。");
    const [root, coordinator] = [live.rootMissionId, live.coordinationMissionId].map(id => missionWorkProduction.owners.tasks.getTask(id));
    const sessions = [live.rootSessionId, live.coordinatorSessionId];
    if ([root, coordinator].some((task, index) => !task?.mission || task.mission.projectId !== projectId || task.missionFinalization
      || Object.values(task.workerSessions).filter(ref => !ref.detachedAt && !ref.retiredAt).length !== 1
      || !task.workerSessions[sessions[index]] || Object.values(task.executions).length || Object.values(task.interactions).length)
      || sessions.some((id, index) => !missionWorkProduction.owners.workers.getSession(id)
        || missionWorkProduction.owners.workers.getSession(id)!.taskId !== [live.rootMissionId, live.coordinationMissionId][index])) {
      throw new Error("本地与持久化 Worker 或执行身份不一致，拒绝发送首个 Mission。");
    }
    const raw = await vscode.workspace.fs.readFile(vscode.Uri.file(reviewedRecoveryFile));
    const reviewed = validateReviewedWebCognition(new TextDecoder().decode(raw), workspace);
    if (!context.workspaceState.get<string[]>("nimora.reviewedWebCognitionApplied", []).includes(reviewed.digest)) {
      throw new Error("审核过的 Cognition 摘要不匹配；不能授权新的 Mission 输入。");
    }
    const parsed = JSON.parse(reviewed.json) as { requiredCapabilityIds: string[] };
    if (reviewedFirstMissionInFlight.has(projectId)) throw new Error("此 Project 的首个只读 Mission 已进入人工确认，禁止重复点击。");
    reviewedFirstMissionInFlight.add(projectId);
    const confirm = await vscode.window.showWarningMessage(
      "启动现有 Project 的第一个只读 Mission？本次将首次向新 Coordinator/Target 发送你已经审核的指令，允许请求列目录、读取文件的能力；实际工具调用仍须遵守 ShunCode 的逐项权限管理。旧规划网页不会接收新消息。",
      { modal: true, detail: `首个目标：${live.rootMissionId}\n实际指令：${reviewed.instruction}\n请求的能力：${parsed.requiredCapabilityIds.join("、")}。\n如果返回 UNKNOWN，禁止重发直到人工核实。` },
      "批准本次只读 Mission", "取消",
    );
    if (confirm !== "批准本次只读 Mission") { reviewedFirstMissionInFlight.delete(projectId); return { state: "cancelled" }; }
    if (takeoverStates()[projectId]?.phase !== "ready") throw new Error("首个 Mission 已在另一流程中启动，拒绝重复发送。");
    if (!(await enableExplicitWebCapabilities())) { reviewedFirstMissionInFlight.delete(projectId); return { state: "cancelled" }; }
    await recordTakeover(projectId, { ...takeoverStates()[projectId], phase: "mission-unknown" });
    webTaskChars = 0;
    webTaskOutput.clear();
    const outcome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Nimora · 执行已审核的首个只读 Mission", cancellable: false },
      () => missionWorkProduction.userEntry.continue({ projectId, rootMissionId: live.rootMissionId, coordinationMissionId: live.coordinationMissionId },
        reviewed.instruction, () => false, webTargetText, missionEntryCapabilityMaterialization(parsed.requiredCapabilityIds),
        identity => recordTakeover(projectId, { ...takeoverStates()[projectId], phase: "mission-unknown", dispatchIdentity: identity })));
    if (outcome.state !== "executed") throw new Error(`首个 Mission 执行未完成确认：${outcome.state === "blocked" ? outcome.reason : "未知状态"}。标记保持 UNKNOWN，禁止重发。`);
    const firstStatus = (outcome.observation as { terminalStatus?: string } | undefined)?.terminalStatus ?? "unknown";
    await recordTakeover(projectId, { ...takeoverStates()[projectId], phase: "mission-sent",
      lastFeedback: { terminalStatus: firstStatus, observedAt: new Date().toISOString(), targetInputId: takeoverStates()[projectId].dispatchIdentity?.targetInputId } });
    if (webTaskChars) webTaskOutput.show(true);
    vscode.window.setStatusBarMessage(firstStatus === "completed" ? "Nimora：首轮反馈已返回，真实读取记录待核实。" : "Nimora：首轮未正常结束，已停止，不会重发。", 15_000);
    return { state: "mission-sent" };
  };
  const chooseReviewedProjectId = async (input?: { projectId?: string }): Promise<string | undefined> => {
    if (input?.projectId) return input.projectId;
    const workspace = oneTrustedWorkspace();
    await missionWorkProduction.owners.projects.initialize();
    const choices = context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).flatMap(projectId => {
      const project = missionWorkProduction.owners.projects.getProject(projectId);
      return project?.formationReceipt?.project.workspace === workspace && project.formationReceipt.authorization.kind === "human-confirmed"
        ? [{ label: project.title || projectId, description: projectId, projectId }] : [];
    });
    if (!choices.length) throw new Error("当前可信工作区没有可选择的已审核 Project，没有恢复或发送。");
    return (await vscode.window.showQuickPick(choices, { title: "选择当前工作区的原 Project", ignoreFocusOut: true,
      placeHolder: "选择确切 Project；后续仍核对原 Mission、Worker 和本次请求" }))?.projectId;
  };
  const reconcileReviewedFirstRead = async (projectId: string): Promise<{ state: string }> => {
    if (reviewedTakeoverInFlight || reviewedFirstMissionInFlight.has(projectId) || webProjectStartInFlight) throw new Error("另一个接管或发送仍在进行。");
    const stage = takeoverStates()[projectId];
    const recoveryKind = reviewedReadRecoveryKind(stage);
    if (!recoveryKind || !stage
      || !stage.rootMissionId || !stage.coordinationMissionId || !stage.rootSessionId || !stage.coordinatorSessionId || !stage.pageIds
      || !context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).includes(projectId)
      || context.workspaceState.get(reviewedRecoveryPendingKey) || context.workspaceState.get("nimora.webFormationUnknown")) {
      throw new Error("此入口只核实未执行工具的只读失败或恢复已核实连接；不能清除未知执行或重放请求。");
    }
    await productionWorkersReady;
    if ((recoveryKind === "review-dispatched-read" || recoveryKind === "review-unknown-read")
      && missionWorkProduction.owners.tasks.getTask(stage.rootMissionId)?.mission?.plane !== "cognition") {
      throw new Error("本轮不是原 Cognition 只读范围，不能采用零执行恢复入口。");
    }
    reviewedTakeoverInFlight = true;
    try {
      const restored = await recoverReviewedFirstReadWorkers(missionWorkProduction, projectId, oneTrustedWorkspace(), {
        rootMissionId: stage.rootMissionId, coordinationMissionId: stage.coordinationMissionId,
        rootSessionId: stage.rootSessionId, coordinatorSessionId: stage.coordinatorSessionId, pageIds: stage.pageIds,
      }, () => Promise.resolve(vscode.commands.executeCommand("_shuncode.webMcp.workerListResources")), async () => {
        const confirmation = await vscode.window.showWarningMessage(recoveryKind === "unstarted-reconciled" ? "恢复本次网页连接？" : "核实本轮失败并仅恢复原 Worker？", { modal: true,
          detail: `${recoveryKind === "review-unknown-read" ? "本轮未获得完整反馈；这个界面状态不能证明执行已收敛。\n" : ""}请先查看原协调聊天及失败证据，确认本轮已停止、Target 没有执行。${stage.dispatchIdentity ? `\n本轮 Target inputId：${stage.dispatchIdentity.targetInputId}\nCoordinator inputId：${stage.dispatchIdentity.coordinatorInputId}\n` : ""}仅允许实际 Task journal 没有任何执行或交互的原 Cognition 只读范围；旧宿主必须已退出并通过 canonical 进程死亡证明。旧请求和返回的工具块永久保留为已消费；本操作不会重发、补投递或重置为首次启动。只恢复已授权的原两张页面。任何部分失败立即停止。` }, "已核实旧请求，仅恢复 Worker", "取消");
        if (confirmation !== "已核实旧请求，仅恢复 Worker") throw new Error("已取消核实，没有恢复 Worker。");
        if (takeoverStates()[projectId] !== stage || reviewedReadRecoveryKind(takeoverStates()[projectId]) !== recoveryKind) throw new Error("确认期间状态已改变。");
        await recordTakeover(projectId, { ...stage, phase: "recovering",
          // Later consumed input identities remain visible even after recovery.
          // A fresh dispatch may replace the current pointer only after this
          // immutable reviewed history entry has been durably saved.
          dispatchIdentity: recoveryKind === "failed-first-read" ? undefined : stage.dispatchIdentity,
          consumedDispatches: recoveryKind === "review-dispatched-read" || recoveryKind === "review-unknown-read" ? [...(stage.consumedDispatches ?? []), {
            identity: { ...stage.dispatchIdentity! }, state: "consumed-no-replay", reviewedAt: new Date().toISOString(),
          }] : stage.consumedDispatches,
          previousAttempt: stage.previousAttempt ?? { state: "consumed-no-replay", dispatchIdentity: stage.dispatchIdentity,
          rootSessionId: stage.rootSessionId!, coordinatorSessionId: stage.coordinatorSessionId!, reconciledAt: new Date().toISOString() } });
      }, async (role, id) => recordTakeover(projectId, { ...takeoverStates()[projectId], phase: "recovering",
        recoveryAttachments: { ...takeoverStates()[projectId].recoveryAttachments, [role]: id } }));
      liveReviewedTakeovers.set(projectId, restored);
      await recordTakeover(projectId, { ...takeoverStates()[projectId], ...restored, phase: "mission-reconciled" });
      vscode.window.setStatusBarMessage("Nimora：原 Worker 已恢复；旧请求已消费，新请求尚未发送。", 10_000);
      return { state: "mission-reconciled" };
    } finally { reviewedTakeoverInFlight = false; }
  };
  const sendReviewedFreshRead = async (projectId: string): Promise<void> => {
    const stage = takeoverStates()[projectId];
    output.appendLine(`[nimora:reviewed-fresh-read] admission phase=${stage?.phase ?? "missing"} cache=${liveReviewedTakeovers.has(projectId)} sending=${reviewedFirstMissionInFlight.has(projectId)} takeover=${reviewedTakeoverInFlight} formation=${webProjectStartInFlight} dispatch=${!!stage?.dispatchIdentity}`);
    if (reviewedReadRecoveryKind(stage) !== "unstarted-reconciled") throw new Error(`本轮状态 ${stage?.phase ?? "缺失"} 尚不允许全新只读请求，或已有发送身份；没有发送。`);
    if (reviewedFirstMissionInFlight.has(projectId)) throw new Error("此 Project 已有新请求正在审核或发送，请勿重复点击；没有第二次发送。");
    if (reviewedTakeoverInFlight || webProjectStartInFlight) throw new Error("接管或建项操作尚未结束；没有发送。请保留当前状态并查看 ShunCode 输出。");
    if (!stage!.rootMissionId || !stage!.coordinationMissionId || !stage!.rootSessionId || !stage!.coordinatorSessionId || !stage!.pageIds) throw new Error("缺少原 Mission/Worker 的确切记录，没有发送。");
    const live = { rootMissionId: stage!.rootMissionId, coordinationMissionId: stage!.coordinationMissionId,
      rootSessionId: stage!.rootSessionId, coordinatorSessionId: stage!.coordinatorSessionId, pageIds: stage!.pageIds };
    reviewedFirstMissionInFlight.add(projectId);
    try {
      const workspace = oneTrustedWorkspace();
      await productionWorkersReady;
      await assertReviewedFreshReadWorkers(missionWorkProduction, projectId, workspace, live);
      const reviewed = validateReviewedWebCognition(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(reviewedRecoveryFile))), workspace);
      if (!context.workspaceState.get<string[]>("nimora.reviewedWebCognitionApplied", []).includes(reviewed.digest)
        || !context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).includes(projectId)
        || missionWorkProduction.owners.projects.getProject(projectId)?.formationReceipt?.project.workspace !== workspace) {
        throw new Error("原 Project、工作区或人工审核摘要不匹配，没有发送。");
      }
      const request = await vscode.window.showInputBox({ title: "原 Mission · 全新的只读请求", ignoreFocusOut: true,
        prompt: "请输入本轮新目标。只开放读取工作区文件，不重发首次请求；不要粘贴旧工具块。",
        validateInput: value => !value.trim() || value.length > 30_000 ? "请输入不超过 30000 字的只读目标。"
          : value.trim() === reviewed.instruction.trim() || /\[SHUNCODE_TOOL\]/.test(value) ? "不能重放原指令或旧工具块，请明确新的核验目标。" : undefined });
      if (!request?.trim()) return;
      if (request.length > 30_000 || request.trim() === reviewed.instruction.trim() || /\[SHUNCODE_TOOL\]/.test(request)) {
        throw new Error("请求不符合全新只读入口要求，没有发送。");
      }
      const approval = await vscode.window.showWarningMessage("审核这一条新的只读请求", { modal: true,
        detail: `${request.trim()}\n\n本轮要求 workspace.read-files，使用原 Cognition Mission 的只读能力配置；不会开放写入工具。本轮会生成全新 inputId。任何失败保留 UNKNOWN 并停止，不重试。` }, "发送本次新请求", "取消");
      if (approval !== "发送本次新请求") return;
      if (takeoverStates()[projectId] !== stage || reviewedReadRecoveryKind(takeoverStates()[projectId]) !== "unstarted-reconciled") throw new Error("本轮状态发生变化，没有发送。");
      if (!(await enableExplicitWebCapabilities())) return;
      if (takeoverStates()[projectId] !== stage || oneTrustedWorkspace() !== workspace) throw new Error("授权期间工作区或本轮状态发生变化，没有发送。");
      await assertReviewedFreshReadWorkers(missionWorkProduction, projectId, workspace, live);
      // Do not return the original first-read button to ready. The old outcome
      // and exact old owners remain preserved in previousAttempt.
      await recordTakeover(projectId, { ...takeoverStates()[projectId], phase: "mission-unknown" });
      webTaskChars = 0; webTaskOutput.clear();
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Nimora · 新的只读请求", cancellable: false },
        () => missionWorkProduction.userEntry.continue({ projectId, rootMissionId: live.rootMissionId, coordinationMissionId: live.coordinationMissionId },
          request.trim(), () => false, webTargetText, missionEntryCapabilityMaterialization(["workspace.read-files"]),
          async identity => {
            if (oneTrustedWorkspace() !== workspace || identity.targetSessionId !== live.rootSessionId || identity.coordinatorSessionId !== live.coordinatorSessionId) {
              throw new Error("发送前工作区或 Worker 身份改变，没有发送。");
            }
            await recordTakeover(projectId, { ...takeoverStates()[projectId], phase: "mission-unknown", dispatchIdentity: identity });
          }));
      if (result.state !== "executed") throw new Error("新请求没有获得执行反馈，保持 UNKNOWN，不重发。");
      const status = (result.observation as { terminalStatus?: string } | undefined)?.terminalStatus ?? "unknown";
      await recordTakeover(projectId, { ...takeoverStates()[projectId], phase: "mission-sent",
        lastFeedback: { terminalStatus: status, observedAt: new Date().toISOString(), targetInputId: takeoverStates()[projectId].dispatchIdentity?.targetInputId } });
      if (webTaskChars) webTaskOutput.show(true);
      vscode.window.setStatusBarMessage(status === "completed" ? "Nimora：本轮反馈已返回，真实读取记录待核实。" : "Nimora：本轮未正常结束，已停止，不会重发。", 15_000);
    } catch (error) {
      // A rejected driver Promise is not proof that execution never started.
      // Retain UNKNOWN and the exact consumed identity; record presentation
      // feedback only, without granting connection recovery or resend authority.
      const failed = takeoverStates()[projectId];
      if (failed?.phase === "mission-unknown"
        && failed.dispatchIdentity?.targetSessionId === live.rootSessionId
        && failed.dispatchIdentity?.coordinatorSessionId === live.coordinatorSessionId) {
        try {
          await recordTakeover(projectId, { ...failed,
            lastFeedback: { terminalStatus: "unknown", observedAt: new Date().toISOString(), targetInputId: failed.dispatchIdentity.targetInputId } });
        } catch (checkpointError) {
          output.appendLine(`[nimora:reviewed-fresh-read] failure feedback checkpoint failed: ${String(checkpointError).slice(0, 1000)}`);
        }
      }
      throw error;
    } finally { reviewedFirstMissionInFlight.delete(projectId); }
  };
  let webConnectionCheckInFlight = false;
  const runWebAiConnectionCheck = async (): Promise<void> => {
    if (webConnectionCheckInFlight) throw new Error("已有网页连接检查正在进行，没有第二次发送。");
    const diagnosticWorkspace = oneTrustedWorkspace();
    await productionWorkersReady;
    if (webConnectionCheckInFlight) throw new Error("已有网页连接检查正在进行，没有第二次发送。");
    if (!resolveWebWorkerReleaseGate(vscode.workspace.getConfiguration("shuncode.webWorker").get<boolean>("hostManagedCapabilities", false), vscode.workspace.isTrusted).effective) {
      throw new Error("诊断需要已授权的 host-managed 模式以确保零工具范围；本入口不会更改授权设置。");
    }
    webConnectionCheckInFlight = true;
    const key = "nimora.webAiConnectionChecks";
    let currentReceipt: WebAiConnectionCheckReceipt | undefined;
    const receipts = () => context.workspaceState.get<Record<string, WebAiConnectionCheckReceipt>>(key, {});
    const assertAllowed = async (pageId: string, adapterSessionId?: string) => {
      if (oneTrustedWorkspace() !== diagnosticWorkspace) throw new Error("诊断期间工作区发生变化，没有发送。");
      if (!resolveWebWorkerReleaseGate(vscode.workspace.getConfiguration("shuncode.webWorker").get<boolean>("hostManagedCapabilities", false), vscode.workspace.isTrusted).effective) throw new Error("诊断授权状态已改变，没有发送。");
      await taskRuntime.initialize();
      if (Object.values(takeoverStates()).some(stage => stage.pageIds?.includes(pageId))) throw new Error("该网页属于原 Mission，不能用作独立诊断。");
      const old = receipts()[pageId];
      if (old && old.inputId !== currentReceipt?.inputId) throw new Error("此页已有已消费的诊断记录，不能重放。请使用另一张空闲备用页。");
      if (adapterSessionId) {
        if (taskRuntime.listTasks().some(task => Object.values(task.workerSessions).some(ref => ref.workerId === "nimora.web-worker" && ref.adapterSessionId === adapterSessionId))) throw new Error("此页已有持久 Mission 绑定，不能用于诊断。");
        const owner = webWorkerSessions.getSessionByAdapterIdentity("nimora.web-worker", adapterSessionId);
        if (owner && (owner.managedSessionId !== currentReceipt?.managedSessionId || owner.taskId)) throw new Error("此页已有其它 Worker 所有者，不能用于诊断。");
        if (await webWorkerSessions.isAdapterSessionRetired("nimora.web-worker", adapterSessionId)) throw new Error("此页 Worker 身份已退役，不能重新使用。");
      }
    };
    try {
      if (Object.keys(receipts()).length >= 32) throw new Error("诊断记录已达上限，请先人工核实；不会清除消费身份。");
      const choices = [];
      for (const candidate of await missionWorkProduction.webCandidates.enumerateCandidates()) {
        if (candidate.provider !== "deepseek" || candidate.availability !== "available" || candidate.health?.status !== "healthy") continue;
        const options = await missionWorkProduction.webCandidates.materializeSessionOptions(candidate, {});
        const target = options.extensions?.webMcpTarget as { pageId?: string; pageSessionId?: string } | undefined;
        if (!target?.pageId) continue;
        try { await assertAllowed(target.pageId, target.pageSessionId); } catch { continue; }
        choices.push({ label: "DeepSeek · 空闲共享网页", description: target.pageId, pageId: target.pageId, candidateId: candidate.candidateId });
      }
      if (!choices.length) throw new Error("没有可诊断的独立共享备用页；原 Mission 网页不会被占用。请打开并共享一张备用聊天页。");
      const selected = await vscode.window.showQuickPick(choices, { title: "Nimora · 检查网页 AI 连接", ignoreFocusOut: true });
      if (!selected) return;
      const review = await vscode.window.showWarningMessage("在这张独立网页发送一次连接检查？", { modal: true,
        detail: `页面：${selected.pageId}\n固定消息：${WEB_AI_CONNECTION_CHECK_PROMPT}\n\n不传工作区内容，不开放工具，不新建 Project 或 Mission。空闲等待上限 30 秒。检查身份先保存，失败不重试；诊断 Worker 保持独立归属，不自动用于任务。` }, "发送一次连接检查", "取消");
      if (review !== "发送一次连接检查") return;
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Nimora · 检查网页 AI 连接", cancellable: false },
        () => checkWebAiConnection(missionWorkProduction.webCandidates, webWorkerSessions, selected, assertAllowed, async receipt => {
          await context.workspaceState.update(key, { ...receipts(), [receipt.pageId]: receipt });
          currentReceipt = receipt;
          output.appendLine(`[nimora:web-ai-connection-check] input=${receipt.inputId} page=${receipt.pageId} status=${receipt.status}${receipt.error ? ` error=${receipt.error}` : ""}`);
        }));
      output.appendLine(`[nimora:web-ai-connection-check] reply=${result.text}`);
      vscode.window.setStatusBarMessage(`Nimora：网页已回复 · ${result.text}`, 15_000);
    } finally { webConnectionCheckInFlight = false; }
  };
  const settledReadState = (projectId: string): ReviewedReadContinuationState => {
    if (!context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).includes(projectId)
      || context.workspaceState.get(reviewedRecoveryPendingKey) || context.workspaceState.get("nimora.webFormationUnknown")) throw new Error("Project 尚有未核实的 Formation，不能继续。");
    const state = takeoverStates()[projectId];
    if (!state?.rootMissionId || !state.coordinationMissionId || !state.rootSessionId || !state.coordinatorSessionId || !state.pageIds) throw new Error("缺少原 Mission 的精确连接记录。");
    return state as ReviewedReadContinuationState;
  };
  const restoreReviewedSettledRead = async (projectId: string): Promise<void> => {
    if (reviewedTakeoverInFlight || webProjectStartInFlight || reviewedFirstMissionInFlight.has(projectId)) throw new Error("已有操作进行中，没有第二次恢复。");
    if (takeoverStates()[projectId]?.practice?.coordinationFailure) {
      throw new Error("原 Coordinator 对话有未确认的 Provider 工具回执。禁止复用这张旧网页；请审核历史工具事实，隔离原网页，并在原宿主退出后通过显式新三页 Worker 接班。");
    }
    const stage = settledReadState(projectId);
    const practice = takeoverStates()[projectId].practice;
    const workspace = oneTrustedWorkspace();
    reviewedTakeoverInFlight = true;
    try {
      await productionWorkersReady;
      const recoveryPhase = practice ? "recovering-settled-workers" : "recovering-settled-read";
      const listResources = () => Promise.resolve(vscode.commands.executeCommand("_shuncode.webMcp.workerListResources"));
      const beforeMutation = async () => {
          const approval = await vscode.window.showWarningMessage(practice ? "恢复当前三条原 Mission Worker 连接？" : "恢复已成功读取的原 Mission 连接？", { modal: true,
            detail: practice
              ? `Project：${projectId}\n只恢复原 Coordinator / Cognition / Practice 三张已共享 DeepSeek 页的 canonical owner。所有历史 execution/result 必须已明确收敛，Provider 页面必须仍是同一原生会话，旧宿主必须由机器证明已退出。不会重发任何旧 input、工具调用或 Work Order，也不会改变 Mission 语义。`
              : `Project：${projectId}\n原 Target inputId：${stage.dispatchIdentity?.targetInputId}\n原 Coordinator inputId：${stage.dispatchIdentity?.coordinatorInputId}\n核对实际执行和投递已收敛，仅恢复原两张已共享页面；历史失败仍保留。canonical owner 必须证明旧宿主已退出。不会重发消息、重执行工具或新增 Project/Mission。` }, "仅恢复原连接", "取消");
          if (approval !== "仅恢复原连接") throw new Error("已取消，没有恢复连接。");
          if (takeoverStates()[projectId] !== stage || oneTrustedWorkspace() !== workspace) throw new Error("审核期间状态改变。");
          await recordTakeover(projectId, { ...takeoverStates()[projectId], phase: recoveryPhase });
        };
      const checkpoint = async (role: 'coordinator' | 'target' | 'practice', id: string) => recordTakeover(projectId, {
        ...takeoverStates()[projectId], phase: recoveryPhase,
        recoveryAttachments: { ...takeoverStates()[projectId].recoveryAttachments, [role]: id },
      });
      const restored = practice
        ? await recoverReviewedSettledMissionWorkers(missionWorkProduction, projectId, workspace, {
            rootMissionId: stage.rootMissionId,
            coordinationMissionId: stage.coordinationMissionId,
            rootSessionId: stage.rootSessionId,
            coordinatorSessionId: stage.coordinatorSessionId,
            pageIds: [...stage.pageIds],
            practiceMissionId: practice.missionId!,
            practiceSessionId: practice.managedSessionId!,
            practicePageId: practice.pageId,
          }, listResources, beforeMutation, checkpoint)
        : await recoverReviewedSettledReadWorkers(missionWorkProduction, projectId, workspace, stage,
            listResources, beforeMutation, checkpoint);
      const { practiceSessionId, ...readWorkers } = restored;
      await recordTakeover(projectId, { ...takeoverStates()[projectId], ...readWorkers, phase: "mission-sent",
        ...(practice ? { practice: { ...practice, managedSessionId: practiceSessionId! } } : {}) });
      liveReviewedTakeovers.set(projectId, restored);
      vscode.window.setStatusBarMessage(practice
        ? "Nimora：三条原 Mission Worker 连接已恢复；没有重放旧输入。"
        : "Nimora：原读取事实已保留，网页连接已恢复；没有发送新请求。", 15_000);
    } finally { reviewedTakeoverInFlight = false; }
  };
  const replaceReviewedClosedPageWorkers = async (projectId: string, resume = false): Promise<void> => {
    if (reviewedTakeoverInFlight || webProjectStartInFlight || reviewedFirstMissionInFlight.has(projectId)) {
      throw new Error("已有接管或执行正在进行，不能启动网页替换。");
    }
    // Reserve the entire reviewed replacement lifecycle, including both human
    // consent windows. Acquiring this only after the first modal allows two
    // rapid invocations to wait for consent concurrently and later misread the
    // first invocation's durable mutation as unrelated state drift.
    reviewedTakeoverInFlight = true;
    try {
    const stage = settledReadState(projectId) as ReviewedReadContinuationState & ReviewedTakeoverState;
    const practice = takeoverStates()[projectId].practice;
    if (!practice || practice.phase !== "sent" || (resume
      ? stage.phase !== "replacing-new-workers" || !stage.replacement
        || stage.replacement.mutationStarted || Object.keys(stage.replacement.assigned).length !== 0
        || stage.replacement.nativeApprovedPageIds.length > 3
        || new Set(stage.replacement.nativeApprovedPageIds).size !== stage.replacement.nativeApprovedPageIds.length
      : stage.phase !== "mission-sent")) {
      throw new Error("接班已发生不确定或部分 canonical 变更，须人工核实；不能自动重试。");
    }
    const base: ReviewedReadContinuationState = resume ? { ...stage, phase: "mission-sent" } : stage;
    const workspace = oneTrustedWorkspace();
    const listResources = () => Promise.resolve(vscode.commands.executeCommand("_shuncode.webMcp.workerListResources"));
    await productionWorkersReady;
    await assertReviewedFreshReplacementEligible(missionWorkProduction, projectId, workspace, base, practice, listResources);
    const command = "workbench.action.browser.nimoraOpenAndShareProviderPage";
    if (!(await vscode.commands.getCommands()).includes(command)) {
      throw new Error("缺少原生浏览器逐页共享授权接口，不能安全替换旧 Worker。");
    }
    const action = resume ? "核实已批准页面并补齐未打开的新页面" : "审核并打开三个新页面";
    const consent = await vscode.window.showWarningMessage(resume ? "继续尚未修改 Mission 的网页准备？" : "为原三个 Mission 创建全新的网页 Worker？", { modal: true,
      detail: `Project：${projectId}\n${resume ? "之前保存的原生共享授权会逐页重新核实，只补充尚未打开的页面，不重复原生共享请求。" : "原三个 DeepSeek 页面已关闭，需要分别为 Coordinator、Cognition、Practice 打开全新页面并授权共享。"}\n不会新建 Project/Mission 或发送历史请求。仅在持久执行收敛、机器证明旧宿主死亡和三张新空白页面通过双重核实时才接班。任何部分失败保留事实，不自动重试，也不授予文件或终端权限。`,
    }, action, "取消");
    if (consent !== action) return;
    if (takeoverStates()[projectId] !== stage || oneTrustedWorkspace() !== workspace) {
      throw new Error("授权期间 Project 或工作区已改变，未打开网页。");
    }
    const attemptId = resume ? stage.replacement!.attemptId : randomUUID();
      await assertReviewedFreshReplacementEligible(missionWorkProduction, projectId, workspace, base, practice, listResources);
      if (!resume) await recordTakeover(projectId, { ...stage, phase: "replacing-new-workers",
        replacement: { attemptId, startedAt: new Date().toISOString(), nativeApprovedPageIds: [], assigned: {},
          previous: { pageIds: [...base.pageIds], practicePageId: practice.pageId,
            sessions: { coordinator: base.coordinatorSessionId, target: base.rootSessionId, practice: practice.managedSessionId! },
            ...(practice.coordinationFailure ? { coordinationFailure: { ...practice.coordinationFailure } } : {}) } } });
      const pageHost = { listResources };
      const previouslyApproved = [...(takeoverStates()[projectId].replacement?.nativeApprovedPageIds ?? [])];
      if (previouslyApproved.length) {
        const existing = await inspectUnboundDeepSeekPages(missionWorkProduction.webCandidates, pageHost);
        if (previouslyApproved.some(id => !existing.some(page => page.pageId === id))) {
          throw new Error("之前原生批准的新页面尚未全部恢复为健康空白共享页面；没有打开更多网页或改变 Worker 归属。");
        }
      }
      const stillNeeded = 3 - previouslyApproved.length;
      if (stillNeeded > 0) await vscode.window.withProgress({ location: vscode.ProgressLocation.Window,
        title: "Nimora · 三条原 Mission 的全新 Worker 接班", cancellable: false }, progress =>
        prepareExactFreshDeepSeekWorkers(missionWorkProduction.webCandidates, {
          ...pageHost,
          openAndShareNewPage: async () => {
            const result = await vscode.commands.executeCommand<unknown>(command, "deepseek", true);
            return result && typeof result === "object" && "shared" in result && "pageId" in result
              ? result as { shared: true; pageId: string } : undefined;
          },
          wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
        }, message => progress.report({ message }), { count: stillNeeded as 1 | 2 | 3,
          onNativePageApproved: async pageIds => {
            const current = takeoverStates()[projectId];
            if (current?.phase !== "replacing-new-workers" || !current.replacement
              || current.replacement.attemptId !== attemptId || current.replacement.mutationStarted
              || Object.keys(current.replacement.assigned).length
              || oneTrustedWorkspace() !== workspace) throw new Error("创建新网页期间接班状态改变；禁止继续。");
            await recordTakeover(projectId, { ...current, replacement: { ...current.replacement,
              nativeApprovedPageIds: [...previouslyApproved, ...pageIds] } });
          },
        }));
      const current = takeoverStates()[projectId];
      const fresh = await inspectUnboundDeepSeekPages(missionWorkProduction.webCandidates, pageHost);
      if (current?.phase !== "replacing-new-workers" || !current.replacement || current.replacement.attemptId !== attemptId) {
        throw new Error("新网页授权证据缺失，不能接管旧 Mission。");
      }
      const pages = current.replacement.nativeApprovedPageIds.map(id => fresh.find(page => page.pageId === id));
      if (pages.length !== 3 || pages.some(page => !page)
        || current.replacement.approvedPages?.some(old => !pages.some(page =>
          page?.pageId === old.pageId && page.candidateId === old.candidateId))) {
        throw new Error("三张全新授权页面未全部通过当前健康空白状态或身份核实，保留已批准页面供下次显式检查。");
      }
      const verifiedPages = pages as { pageId: string; candidateId: string }[];
      await recordTakeover(projectId, { ...current, replacement: { ...current.replacement, approvedPages: verifiedPages } });
      const result = await replaceReviewedClosedPages(missionWorkProduction, projectId, workspace, base, practice, verifiedPages,
        listResources,
        () => inspectUnboundDeepSeekPages(missionWorkProduction.webCandidates, pageHost),
        async () => {
          const approval = await vscode.window.showWarningMessage("确认用三张新页面替换原 Worker？", { modal: true,
            detail: "三个页面均已获得原生共享授权且当前健康、空白。\n将按 Coordinator → Cognition → Practice 逐条执行原宿主死亡证明及 canonical 接班，并逐条持久记录。不会发送旧任务或授予文件/终端权限。任何中断都保留部分状态，不能重复点击。",
          }, "仅替换 Worker，不发送任务", "取消");
          if (approval !== "仅替换 Worker，不发送任务") throw new Error("未授权改变 Worker 归属；已开启的新网页保留待人工核实。");
          const before = takeoverStates()[projectId];
          if (before?.phase !== "replacing-new-workers" || !before.replacement || before.replacement.attemptId !== attemptId
            || oneTrustedWorkspace() !== workspace) throw new Error("二次确认前状态已改变。");
          await recordTakeover(projectId, { ...before, replacement: { ...before.replacement, mutationStarted: true } });
        },
        async (role, managedSessionId) => {
          const before = takeoverStates()[projectId];
          if (before?.phase !== "replacing-new-workers" || !before.replacement || before.replacement.attemptId !== attemptId) {
            throw new Error("原 Mission 接班进度已改变，必须保留真实部分状态并人工对账。");
          }
          await recordTakeover(projectId, { ...before,
            replacement: { ...before.replacement, assigned: { ...before.replacement.assigned, [role]: managedSessionId } } });
        });
      const before = takeoverStates()[projectId];
      if (before?.phase !== "replacing-new-workers" || !before.replacement || before.replacement.attemptId !== attemptId
        || Object.keys(before.replacement.assigned).length !== 3) {
        throw new Error("三条新 Worker 的持久接班检查点缺失，保留部分状态。");
      }
      await recordTakeover(projectId, { ...before, phase: "mission-sent",
        rootSessionId: result.rootSessionId, coordinatorSessionId: result.coordinatorSessionId,
        pageIds: result.pageIds, candidateIds: result.candidateIds,
        practice: { ...practice, managedSessionId: result.practiceSessionId, pageId: result.practicePageId,
          candidateId: result.practiceCandidateId,
          // The old failure remains in replacement.previous; it cannot poison
          // a FRESH, fully verified Worker generation after all three attach.
          coordinationFailure: undefined } });
      liveReviewedTakeovers.set(projectId, { rootMissionId: base.rootMissionId,
        coordinationMissionId: base.coordinationMissionId, rootSessionId: result.rootSessionId,
        coordinatorSessionId: result.coordinatorSessionId });
      vscode.window.setStatusBarMessage("Nimora：原三个 Mission 已换用全新网页 Worker；旧输入未重放。新目标须另行授权。", 20_000);
    } finally { reviewedTakeoverInFlight = false; }
  };
  const continueReviewedRead = async (projectId: string, request?: string, missionId?: string): Promise<void> => {
    if (reviewedTakeoverInFlight || webProjectStartInFlight || reviewedFirstMissionInFlight.has(projectId)) throw new Error("已有请求正在审核或执行，没有第二次发送。");
    if (takeoverStates()[projectId]?.practice?.coordinationFailure) {
      throw new Error("原 Coordinator Provider 回执仍不确定；必须先完成历史审核和显式新 Worker 接班，不能直接向原网页发新只读请求。");
    }
    const stage = settledReadState(projectId);
    const workspace = oneTrustedWorkspace();
    if (missionId && missionId !== stage.rootMissionId) throw new Error("此入口只能继续原 Cognition Mission。");
    reviewedFirstMissionInFlight.add(projectId);
    let reserved = false;
    try {
      await productionWorkersReady;
      await assertReviewedReadContinuation(missionWorkProduction, projectId, workspace, stage);
      request ??= await vscode.window.showInputBox({ title: "原 Mission · 后续只读目标", ignoreFocusOut: true,
        prompt: "继续需求分析，仅允许读文件；不能实现文件写入或重放旧工具。", validateInput: value => !value.trim() || value.length > 30_000 ? "请输入不超过 30000 字的新目标。" : undefined });
      if (!request?.trim()) return;
      request = request.trim();
      const digest = createHash("sha256").update(request).digest("hex");
      const old = takeoverStates()[projectId].consumedReadRequests ?? [];
      if (request.length > 30_000 || /\[SHUNCODE_TOOL\]/.test(request) || old.includes(digest) || old.length >= 32
        || ((stage as ReviewedTakeoverState).consumedDispatches?.length ?? 0) >= 32) throw new Error("目标已消费、包含旧工具块或记录已达上限，不会发送。");
      const approval = await vscode.window.showWarningMessage("继续原 Mission 的新只读目标", { modal: true,
        detail: `${request}\n\n只使用原 Cognition Mission 的只读工具。本轮要求 workspace.read-files；不会开放写入，不新建 Project/Mission。为本次新目标保存全新 inputId；失败立即停止，不重放旧请求。` }, "发送这个新目标", "取消");
      if (approval !== "发送这个新目标") return;
      if (takeoverStates()[projectId] !== stage || oneTrustedWorkspace() !== workspace) throw new Error("审核期间状态改变，没有发送。");
      if (!(await enableExplicitWebCapabilities())) return;
      if (takeoverStates()[projectId] !== stage || oneTrustedWorkspace() !== workspace) throw new Error("授权期间状态改变，没有发送。");
      await assertReviewedReadContinuation(missionWorkProduction, projectId, workspace, stage);
      webTaskChars = 0; webTaskOutput.clear();
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Nimora · 继续原只读 Mission", cancellable: false },
        () => missionWorkProduction.userEntry.continue({ projectId, rootMissionId: stage.rootMissionId, coordinationMissionId: stage.coordinationMissionId },
          request!, () => false, webTargetText, missionEntryCapabilityMaterialization(["workspace.read-files"]), async identity => {
            if (takeoverStates()[projectId] !== stage || oneTrustedWorkspace() !== workspace
              || identity.targetSessionId !== stage.rootSessionId || identity.coordinatorSessionId !== stage.coordinatorSessionId) throw new Error("发送前原 Worker 身份改变。");
            await assertReviewedReadContinuation(missionWorkProduction, projectId, workspace, stage);
            await recordTakeover(projectId, { ...takeoverStates()[projectId], phase: "mission-unknown", dispatchIdentity: identity,
              lastFeedback: undefined, consumedReadRequests: [...old, digest], consumedDispatches: [...(takeoverStates()[projectId].consumedDispatches ?? []),
                { identity: { ...stage.dispatchIdentity! }, state: "consumed-no-replay", reviewedAt: new Date().toISOString() }] });
            reserved = true;
          }));
      if (result.state !== "executed") throw new Error("未获得完整执行反馈，保留 UNKNOWN，不重发。");
      const status = (result.observation as { terminalStatus?: string } | undefined)?.terminalStatus ?? "unknown";
      await recordTakeover(projectId, { ...takeoverStates()[projectId], phase: "mission-sent",
        lastFeedback: { terminalStatus: status, observedAt: new Date().toISOString(), targetInputId: takeoverStates()[projectId].dispatchIdentity?.targetInputId } });
      if (webTaskChars) webTaskOutput.show(true);
      vscode.window.setStatusBarMessage(status === "completed" ? "Nimora：新目标反馈已返回，请查看实际执行记录。" : "Nimora：本轮未正常结束，已停止，不会重发。", 15_000);
    } catch (error) {
      if (reserved && takeoverStates()[projectId]?.phase === "mission-unknown") {
        try { await recordTakeover(projectId, { ...takeoverStates()[projectId], lastFeedback: { terminalStatus: "unknown",
          observedAt: new Date().toISOString(), targetInputId: takeoverStates()[projectId].dispatchIdentity?.targetInputId } }); }
        catch (checkpointError) { output.appendLine(`[nimora:read-continuation] feedback checkpoint failed: ${String(checkpointError).slice(0, 1000)}`); }
      }
      throw error;
    } finally { reviewedFirstMissionInFlight.delete(projectId); }
  };
  const prepareReviewedPracticeEntry = async (projectId: string): Promise<void> => {
    if (reviewedTakeoverInFlight || webProjectStartInFlight || reviewedFirstMissionInFlight.has(projectId)) throw new Error("已有任务操作，没有第二次创建。");
    const base = settledReadState(projectId);
    if (takeoverStates()[projectId].practice) throw new Error("已存在执行阶段记录，请查看原执行 Mission，不会重复创建。");
    const workspace = oneTrustedWorkspace();
    reviewedTakeoverInFlight = true;
    try {
      await productionWorkersReady;
      await assertReviewedReadContinuation(missionWorkProduction, projectId, workspace, base);
      const resources = await vscode.commands.executeCommand<unknown>("_shuncode.webMcp.workerListResources");
      if (!Array.isArray(resources) || resources.length > 32) throw new Error("无法读取完整的共享网页清单。");
      const choices = [];
      for (const candidate of await missionWorkProduction.webCandidates.enumerateCandidates()) {
        const matches = resources.filter(row => row?.resourceIdentity && candidate.candidateId === `webmcp:${row.resourceIdentity}`);
        const page = matches.length === 1 ? matches[0] : undefined;
        if (!page?.pageId || base.pageIds.includes(page.pageId) || page.workerTurnState === "running") continue;
        const diagnostic = context.workspaceState.get<Record<string, WebAiConnectionCheckReceipt>>("nimora.webAiConnectionChecks", {})[page.pageId];
        if (diagnostic && diagnostic.status !== "completed") continue;
        const selection = { pageId: page.pageId as string, candidateId: candidate.candidateId };
        try { await inspectPracticePage(missionWorkProduction, base, selection); }
        catch { continue; }
        choices.push({ label: `DeepSeek · 独立执行网页 · ${page.pageId}`, description: "当前已共享且未绑定 Mission", selection });
      }
      const selected = await vscode.window.showQuickPick(choices, { title: "为原 Project 选择实现与测试 Worker", ignoreFocusOut: true });
      if (!selected) return;
      const instruction = await vscode.window.showInputBox({ title: "实现与测试 · 本轮目标", ignoreFocusOut: true,
        value: "读取需求.txt一次，以实际内容为依据制作本地中文待办网页。只新增PROJECT_PLAN.md、index.html、README.md、TEST_REPORT.md，不覆盖已有文件。实现添加非空任务、完成和取消完成、删除、全部/未完成/已完成筛选以及localStorage持久化。不使用后端、外部网络或安装依赖。通过本地测试检查实际可验证的功能，TEST_REPORT.md明确记录真实运行结果，未实际运行的检查标为未验证。仅操作当前测试工作区，不删除其它文件。每个写入或执行工具只调用一次，遇到失败或不确定立即停止，不重试、不重放历史工具或请求。",
        prompt: "这将创建原需求分析 Mission 的 Practice 执行子 Mission，允许按目标申请文件写入和本地测试能力。",
        validateInput: value => !value.trim() || value.length > 24_000 || /\[SHUNCODE_TOOL\]/.test(value) ? "请输入不超过24000字的新目标，不粘贴旧工具块。" : undefined });
      if (!instruction?.trim()) return;
      if (instruction.length > 24_000 || /\[SHUNCODE_TOOL\]/.test(instruction)) throw new Error("实现目标超出范围或包含旧工具块。");
      const approval = await vscode.window.showWarningMessage("准备原 Project 的实现与测试阶段", { modal: true,
        detail: `Project：${projectId}\n工作区：${workspace}\n${instruction.trim()}\n\n新增一个 Practice 子 Mission，保留原 Cognition/Coordinator。绑定所选独立网页。本步骤只准备执行，不发送工作请求。文件写入和命令执行仍使用原逐项权限管理。`, }, "创建执行子 Mission 并绑定", "取消");
      if (approval !== "创建执行子 Mission 并绑定") return;
      if (takeoverStates()[projectId] !== base || oneTrustedWorkspace() !== workspace) throw new Error("审核期间 Project 状态改变。");
      const plan: ReviewedPracticeState = { phase: "creating", ...selected.selection, instruction: instruction.trim(), operation: {
        projectId, managedRootMissionId: base.rootMissionId, parentMissionId: base.rootMissionId, operationKey: randomUUID(), plane: "practice",
        missionType: "implementation-and-testing", goal: "依据已核实需求实现并验证当前工作区的交付物",
        completionCriteria: ["生成需求指定的交付文件，需求与其它原文件保持不变", "对实际实现运行本地检查，报告中区分已验证与未验证", "真实执行与结果投递有持久记录，失败或不确定不重放"],
      } };
      await prepareReviewedPractice(missionWorkProduction, projectId, workspace, base, plan,
        async practice => { if (oneTrustedWorkspace() !== workspace) throw new Error("准备期间工作区改变。");
          await recordTakeover(projectId, { ...takeoverStates()[projectId], practice }); });
      vscode.window.setStatusBarMessage("Nimora：执行子 Mission 已准备；选择“运行实现与测试”开始生成文件。", 20_000);
    } finally { reviewedTakeoverInFlight = false; }
  };
  const reconcileReviewedPractice = async (projectId: string): Promise<void> => {
    if (reviewedTakeoverInFlight || webProjectStartInFlight || reviewedFirstMissionInFlight.has(projectId)) throw new Error("当前仍有操作运行，不能核实结果。");
    const base = settledReadState(projectId), workspace = oneTrustedWorkspace(), practice = takeoverStates()[projectId].practice;
    if (!practice || !["sent", "unknown"].includes(practice.phase)) throw new Error("没有待核实的执行轮次。");
    reviewedFirstMissionInFlight.add(projectId);
    try {
      await productionWorkersReady;
      if (practice.phase === "unknown") {
        const inspect = async () => {
          await assertReviewedPracticeReady(missionWorkProduction, projectId, workspace, base, practice,
            { ownership: "orphan", inspectUnknownOutcome: true, allowUnreviewedFailures: true });
          const resources = await vscode.commands.executeCommand<unknown>("_shuncode.webMcp.workerListResources");
          const pageIds = [...base.pageIds, practice.pageId];
          if (!Array.isArray(resources) || resources.length > 32 || new Set(pageIds).size !== 3
            || pageIds.some(pageId => {
              const matches = resources.filter(row => row?.pageId === pageId);
              return matches.length !== 1 || matches[0].site !== "deepseek" || matches[0].origin !== "https://chat.deepseek.com"
                || matches[0].ready !== true || matches[0].nativeMcpBypass !== false || matches[0].sessionIdentityCompatible !== true
                || !/^[a-f0-9]{64}$/.test(matches[0].resourceIdentity) || matches[0].workerTurnState === "running";
            })) throw new Error("原三个已共享页面尚未核实或仍运行；保留 UNKNOWN，不恢复、不重发。");
          return taskRuntime.getTask(practice.missionId!)!;
        };
        const task = await inspect(), digest = practiceOutcomeDigest(task);
        const current = Object.values(task.executions).filter(row => row.origin?.inputId === practice.dispatchIdentity!.targetInputId
          && row.origin.managedSessionId === practice.dispatchIdentity!.targetSessionId);
        const approval = await vscode.window.showWarningMessage("核实已完成工具，保留未知的最终反馈", { modal: true,
          detail: `原 Target input：${practice.dispatchIdentity!.targetInputId}\n本轮 ${current.length} 条工具执行及结果全部已收敛；保留 ${Object.values(task.executions).filter(row => row.status === "failed").length} 条历史失败。\n\n${current.map(row => `${row.toolName} · ${row.origin?.callId} · ${row.status}`).join("\n")}\n\n只保存“已消费、禁止重放”的核实记录，不把原 UNKNOWN 改成 completed，不补投旧反馈、不终结 Mission。原 Worker 恢复仍须 canonical 宿主死亡证明和三页身份核验；随后只能单独审核全新目标。` },
          "保留 UNKNOWN，禁止重放", "取消");
        if (approval !== "保留 UNKNOWN，禁止重放") return;
        if (takeoverStates()[projectId] !== base || oneTrustedWorkspace() !== workspace) throw new Error("核实期间状态改变。");
        const fresh = await inspect();
        if (practiceOutcomeDigest(fresh) !== digest) throw new Error("核实期间执行记录改变，没有恢复。");
        await recordTakeover(projectId, { ...takeoverStates()[projectId], practice: { ...practice, phase: "reviewed-unknown",
          outcomeReview: { disposition: "consumed-no-replay", identity: { ...practice.dispatchIdentity! }, executionDigest: digest,
            terminalStatus: "unknown", originalObservedAt: practice.lastFeedback!.observedAt,
            executionCount: Object.keys(fresh.executions).length, reviewedAt: new Date().toISOString() },
          failureReview: { digest: practiceFailureDigest(fresh), failureCount: Object.values(fresh.executions).filter(row => row.status === "failed").length,
            reviewedAt: new Date().toISOString() } } });
        vscode.window.setStatusBarMessage("Nimora：旧请求 UNKNOWN 已保留、执行事实已核实；仅可恢复原连接，不重发。", 20_000);
        return;
      }
      // A NEW Extension Host is allowed to inspect the old immutable local
      // execution journal without resurrecting an ambiguous provider receipt.
      // All three OLD role sessions must be absent from this process together;
      // a partial loss stays blocked. This selection is REVIEW-ONLY and never
      // authorizes orphan retirement, provider send or Worker replacement.
      const reviewedOldSessions = [base.rootSessionId, base.coordinatorSessionId, practice.managedSessionId!];
      const allOldSessionsAbsent = reviewedOldSessions.every(id => !missionWorkProduction.owners.workers.getSession(id))
        && [base.rootMissionId, base.coordinationMissionId, practice.missionId!]
          .every(id => missionWorkProduction.owners.workers.listSessions({ taskId: id }).length === 0);
      const reviewOwnership = allOldSessionsAbsent ? "orphan" : "live";
      const practiceTaskForReview = taskRuntime.getTask(practice.missionId!);
      const orphanFailureReviewOnly = allOldSessionsAbsent && !practice.coordinationFailure
        && !!practiceTaskForReview && practiceNeedsFailureReview(practiceTaskForReview, practice.failureReview);
      await assertReviewedPracticeReady(missionWorkProduction, projectId, workspace, base, practice,
        { ownership: reviewOwnership, allowUnreviewedFailures: true,
          historicalOutcomeReviewOnly: !!practice.coordinationFailure,
          historicalFailureReviewOnly: orphanFailureReviewOnly });
      const task = taskRuntime.getTask(practice.missionId!)!;
      const digest = practiceFailureDigest(task), failures = Object.values(task.executions).filter(row => row.status === "failed");
      const decision = await vscode.window.showWarningMessage("核实本轮实际执行结果", { modal: true,
        detail: `已记录 ${Object.keys(task.executions).length} 条本地执行，结果已投递至任务记录，其中 ${failures.length} 条工具失败。命令进程退出非零等业务失败须另外查看输出。\n\n${failures.map(row => `${row.toolName} · ${row.origin?.callId}\n${(row.resultPayload?.text ?? row.error ?? "").slice(0, 900)}`).join("\n\n")}\n\n${practice.coordinationFailure ? "注意：Coordinator 的旧 Provider 工具回执未确认。本审核仅保留本地工具事实，不认定 DeepSeek 已收到最终结果；完成审核后仍须安全恢复或替换未结案 Worker，不能直接启动下一轮。" : "确认只记录已核实的事实，不重放请求，不标记 Mission 完成。之后可另行审核全新目标。"}` }, "仅保留历史执行事实", "取消");
      if (decision !== "仅保留历史执行事实") return;
      if (takeoverStates()[projectId] !== base || oneTrustedWorkspace() !== workspace) throw new Error("核实期间状态改变。");
      await assertReviewedPracticeReady(missionWorkProduction, projectId, workspace, base, practice,
        { ownership: reviewOwnership, allowUnreviewedFailures: true,
          historicalOutcomeReviewOnly: !!practice.coordinationFailure,
          historicalFailureReviewOnly: orphanFailureReviewOnly });
      if (practiceFailureDigest(taskRuntime.getTask(practice.missionId!)!) !== digest) throw new Error("核实期间执行记录改变。");
      await recordTakeover(projectId, { ...takeoverStates()[projectId], practice: { ...practice, failureReview: { digest, failureCount: failures.length, reviewedAt: new Date().toISOString() } } });
      vscode.window.setStatusBarMessage(practice.coordinationFailure
        ? "Nimora：已保留本地历史事实；协调端回执仍不确定，须先安全恢复 Worker，禁止新请求。"
        : "Nimora：旧执行事实已核实并保留，没有发送；可审核全新目标。", 20_000);
    } finally { reviewedFirstMissionInFlight.delete(projectId); }
  };
  const runReviewedPracticeEntry = async (projectId: string, request?: string): Promise<void> => {
    if (reviewedTakeoverInFlight || webProjectStartInFlight || reviewedFirstMissionInFlight.has(projectId)) throw new Error("已有请求运行，没有第二次发送。");
    const base = settledReadState(projectId);
    const practice = takeoverStates()[projectId].practice;
    if (!practice) throw new Error("先准备实现与测试 Mission。");
    const workspace = oneTrustedWorkspace();
    reviewedFirstMissionInFlight.add(projectId);
    let reserved = false;
    try {
      await productionWorkersReady;
      await assertReviewedPracticeReady(missionWorkProduction, projectId, workspace, base, practice);
      if (practice.phase === "ready") request = practice.instruction;
      else request ??= await vscode.window.showInputBox({ title: "执行 Mission · 全新后续目标", ignoreFocusOut: true, prompt: "请输入新目标，不重放上一轮写入或工具。" });
      if (!request?.trim()) return;
      request = request.trim();
      const digest = createHash("sha256").update(request).digest("hex");
      if (request.length > 24_000 || /\[SHUNCODE_TOOL\]/.test(request) || practice.consumedGoals?.includes(digest)
        || (practice.consumedInputs?.length ?? 0) >= 32) throw new Error("该目标已消费或超出范围，没有发送。");
      const approval = await vscode.window.showWarningMessage("启动并授权连续执行", { modal: true,
        detail: `${request}\n\n执行 Mission：${practice.missionId}\n授权当前 Worker 会话修改工作区文件并运行本地命令。补丁可覆盖或删除文件；命令使用你的系统权限，可能访问工作区外资源，这不是沙箱。授权后这两项能力不再逐项弹窗；其它需授权能力或已撤销的权限会停止本轮。可通过“Nimora: Manage AI Permissions”撤销。保存全新输入后发送一次；不自动重放。` }, "授权并启动", "取消");
      if (approval !== "授权并启动") return;
      if (takeoverStates()[projectId] !== base || oneTrustedWorkspace() !== workspace) throw new Error("审核期间 Project 状态改变。");
      if (!(await enableExplicitWebCapabilities())) return;
      if (takeoverStates()[projectId] !== base || oneTrustedWorkspace() !== workspace) throw new Error("授权期间状态改变。");
      await assertReviewedPracticeReady(missionWorkProduction, projectId, workspace, base, practice);
      const sessionApproval = await preapproveWorkerSessionCapabilities(taskRuntime, {
        taskId: practice.missionId!, managedSessionId: practice.managedSessionId!, workerId: "nimora.web-worker",
        capabilityIds: ["workspace.apply-patch", "terminal.run-command"],
      });
      await context.workspaceState.update(automationApprovalsKey, [...automationApprovals().filter(row =>
        row.managedSessionId !== sessionApproval.managedSessionId), sessionApproval].slice(-256));
      if (takeoverStates()[projectId] !== base || oneTrustedWorkspace() !== workspace) throw new Error("预授权期间状态改变，没有发送。");
      await assertReviewedPracticeReady(missionWorkProduction, projectId, workspace, base, practice);
      webTaskChars = 0; webTaskOutput.clear();
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Nimora · 实现与测试", cancellable: false },
        () => missionWorkProduction.userEntry.continue({ projectId, rootMissionId: base.rootMissionId, coordinationMissionId: base.coordinationMissionId, missionId: practice.missionId },
          request!, () => false, webTargetText, missionEntryCapabilityMaterialization(["workspace.read-files", "workspace.apply-patch", "terminal.run-command", "terminal.get-command-output", "terminal.wait"]),
          async identity => {
            if (takeoverStates()[projectId] !== base || oneTrustedWorkspace() !== workspace
              || identity.targetSessionId !== practice.managedSessionId || identity.coordinatorSessionId !== base.coordinatorSessionId) throw new Error("执行前 Worker 归属改变。");
            await assertReviewedPracticeReady(missionWorkProduction, projectId, workspace, base, practice);
            await recordTakeover(projectId, { ...takeoverStates()[projectId], practice: { ...practice, phase: "unknown", dispatchIdentity: identity,
              lastFeedback: undefined, coordinationFailure: undefined, consumedGoals: [...(practice.consumedGoals ?? []), digest],
              consumedInputs: [...(practice.consumedInputs ?? []), ...(practice.dispatchIdentity ? [{ ...practice.dispatchIdentity }] : [])] } });
            reserved = true;
          }, async observation => {
            const current = takeoverStates()[projectId].practice;
            if (!reserved || !current?.dispatchIdentity || current.phase !== "unknown"
              || observation.kind !== "coordinator-live-transport-observation" || observation.targetMissionId !== current.missionId
              || observation.inputId !== current.dispatchIdentity.targetInputId || !["completed", "error", "cancelled", "interrupted"].includes(observation.terminalStatus)) {
              throw new Error("Target 反馈与已消费输入不匹配，不能记录为已知结果。");
            }
            await recordTakeover(projectId, { ...takeoverStates()[projectId], practice: { ...current, phase: "sent",
              lastFeedback: { terminalStatus: observation.terminalStatus, targetInputId: observation.inputId, observedAt: new Date().toISOString() } } });
          }));
      if (result.state !== "executed") throw new Error("实现目标没有获得完整反馈，保留 UNKNOWN，不重发。");
      const status = (result.observation as { terminalStatus?: string } | undefined)?.terminalStatus ?? "unknown";
      await recordTakeover(projectId, { ...takeoverStates()[projectId], practice: { ...takeoverStates()[projectId].practice!, phase: "sent",
        lastFeedback: { terminalStatus: status, targetInputId: takeoverStates()[projectId].practice!.dispatchIdentity!.targetInputId, observedAt: new Date().toISOString() } } });
      if (webTaskChars) webTaskOutput.show(true);
      vscode.window.setStatusBarMessage(status === "completed" ? "Nimora：实现反馈已返回，请检查文件和真实测试结果。" : "Nimora：实现未正常结束，已停止，不会重发。", 20_000);
    } catch (error) {
      if (reserved) output.appendLine(`[nimora:practice] request stopped: ${String(error).slice(0, 4000)}`);
      if (reserved && takeoverStates()[projectId].practice?.phase === "sent") {
        const current = takeoverStates()[projectId].practice!;
        try { await recordTakeover(projectId, { ...takeoverStates()[projectId], practice: { ...current,
          coordinationFailure: { coordinatorInputId: current.dispatchIdentity!.coordinatorInputId,
            targetInputId: current.dispatchIdentity!.targetInputId, error: String(error).slice(0, 4000), observedAt: new Date().toISOString() } } }); }
        catch (checkpointError) { output.appendLine(`[nimora:practice] coordination failure checkpoint failed: ${String(checkpointError).slice(0, 1000)}`); }
      }
      if (reserved && takeoverStates()[projectId].practice?.phase === "unknown") {
        try { await recordTakeover(projectId, { ...takeoverStates()[projectId], practice: { ...takeoverStates()[projectId].practice!,
          lastFeedback: { terminalStatus: "unknown", targetInputId: takeoverStates()[projectId].practice!.dispatchIdentity!.targetInputId, observedAt: new Date().toISOString() } } }); }
        catch (checkpointError) { output.appendLine(`[nimora:practice] feedback checkpoint failed: ${String(checkpointError).slice(0, 1000)}`); }
      }
      const retained = takeoverStates()[projectId].practice;
      if (reserved && retained?.phase === "sent" && retained.coordinationFailure) {
        throw new Error(`Target 结束状态 ${retained.lastFeedback?.terminalStatus ?? "unknown"} 已记录；协调端结果投递或收尾失败，不会重放本轮。${retained.coordinationFailure.error}`, { cause: error });
      }
      throw error;
    } finally { reviewedFirstMissionInFlight.delete(projectId); }
  };
  const diagnoseReviewedSettlement = async (projectId: string): Promise<void> => {
    const stage = takeoverStates()[projectId];
    if (!stage || !stage.coordinatorSessionId || !stage.rootSessionId || !stage.practice?.managedSessionId) {
      throw new Error("缺少确切的三角色接班身份，不能作出 Provider 结案诊断。");
    }
    await productionWorkersReady;
    const roles = [
      { role: "Coordinator", managedSessionId: stage.coordinatorSessionId },
      { role: "Cognition", managedSessionId: stage.rootSessionId },
      { role: "Practice", managedSessionId: stage.practice.managedSessionId },
    ];
    const identities = roles.map(({ role, managedSessionId }) => {
      const session = missionWorkProduction.owners.workers.getSession(managedSessionId);
      return { role, session, identity: session ? { workerId: session.workerId, adapterSessionId: session.adapterSessionId } : undefined };
    });
    const live = identities.filter((row): row is typeof row & { identity: { workerId: string; adapterSessionId: string } } => !!row.identity);
    const facts = await missionWorkProduction.owners.workers.withAdapterSessionRetirementScope(
      live.map(row => row.identity), async owner => live.map(row => ({
        role: row.role, session: row.session, knownSettled: owner.isKnownSettled(row.identity),
        detail: owner.inspectSettlement?.(row.identity),
      })));
    // Health is read-only and can show that a page has visibly stopped while
    // its canonical host capability receipt remains UNKNOWN. Never derive
    // settlement authority from a provider page's visible completion state.
    const provider = await Promise.all(roles.map(async role => {
      if (!missionWorkProduction.owners.workers.getSession(role.managedSessionId)) {
        return { role: role.role, status: "missing", turn: "unknown", receipt: "unknown" };
      }
      try {
        const health = await missionWorkProduction.owners.workers.health(role.managedSessionId);
        const info = (health.extensions as { pageStatus?: {
          workerTurn?: { state?: string }; pendingHostCapabilities?: number;
          lastDeliveryError?: string; resultDeliveryUncertain?: { callId?: string };
        } } | undefined)?.pageStatus;
        const receipt = info?.resultDeliveryUncertain?.callId
          ? "已明确标记 Provider 工具结果回执不确定"
          : info?.lastDeliveryError ? "存在工具结果回传错误"
            : info?.pendingHostCapabilities ? "有待回传的 Provider 工具结果"
              : "未报告待回传错误（不代表历史回执已确认）";
        return { role: role.role, status: health.status, turn: info?.workerTurn?.state ?? "unknown", receipt };
      } catch {
        return { role: role.role, status: "unavailable", turn: "unknown", receipt: "Provider 页面状态读取失败" };
      }
    }));
    const lines = roles.map(role => {
      const state = facts.find(row => row.role === role.role);
      if (!state) return `${role.role}：当前扩展没有此确切 Worker 会话，必须先对账，不能继续。`;
      const f = state.detail;
      const page = provider.find(item => item.role === role.role);
      return `${role.role}：${state.knownSettled ? "本地生命周期已收敛" : "本地生命周期未收敛"}；状态 ${f?.state ?? state.session?.state ?? "unknown"}；发送租约 ${f?.activeSendLeases ?? "?"}；待回传工具 ${f?.hostCapabilityRequests ?? "?"}；中断清理 ${f?.abandonedSendCleanups ?? "?"}；旧 Provider 回执未知 ${f?.unsettledProviderSends ?? "?"}；Provider 页面 ${page?.status ?? "unknown"}/${page?.turn ?? "unknown"}；${page?.receipt ?? "回执未检查"}`;
    });
    await vscode.window.showWarningMessage("Nimora · 三角色只读结案诊断", {
      modal: true,
      detail: `${lines.join("\n")}\n\n本次历史：Practice ${stage.practice.lastFeedback?.terminalStatus ?? "未核实"}；Coordinator 工具结果回传${stage.practice.coordinationFailure ? "存在未确认的最终 Provider 回执" : "没有额外的协调失败记录"}。\n这是只读诊断，不标记成功、不清理旧会话、不重发旧输入，也不授权新目标。需要先单独审核历史执行事实，再以已核实的 Worker 结案或显式替换路径恢复。`,
    }, "了解");
  };
  const showReviewedWorkerOperations = async (): Promise<boolean> => {
    if (!vscode.workspace.isTrusted || vscode.workspace.workspaceFolders?.length !== 1) return false;
    const workspace = oneTrustedWorkspace();
    await missionWorkProduction.owners.projects.initialize();
    const choices = context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).flatMap(projectId => {
      const project = missionWorkProduction.owners.projects.getProject(projectId);
      if (project?.formationReceipt?.project.workspace !== workspace || project.formationReceipt.authorization.kind !== "human-confirmed") return [];
      const stage = takeoverStates()[projectId];
      if (stage?.practice) {
        const practice = stage.practice;
        if (stage.phase === "replacing-new-workers") {
          return !stage.replacement?.mutationStarted && Object.keys(stage.replacement?.assigned ?? {}).length === 0
            ? [{ label: `核实已共享的新页面并补齐 · ${project.title || projectId}`, description: projectId, projectId, action: "resume-new-pages" }] : [];
        }
        const practiceTask = taskRuntime.getTask(practice.missionId ?? "");
        if (!practiceTask) return [];
        if (practice.phase === "unknown") return [{ label: `核实 UNKNOWN 的已完成工具 · ${project.title || projectId}`,
          description: "只核实、不重放；原宿主退出后才能恢复", projectId, action: "reconcile-practice" }];
        if (practice.phase === "sent" && ["completed", "error"].includes(practice.lastFeedback?.terminalStatus ?? "")
          && practiceNeedsFailureReview(practiceTask, practice.failureReview))
          return [{ label: `核实本地执行事实 · ${project.title || projectId}`, description: projectId, projectId, action: "reconcile-practice" },
            ...(practice.coordinationFailure ? [{ label: `只读诊断 Coordinator 未确认回执 · ${project.title || projectId}`, description: projectId, projectId, action: "diagnose-settlement" }] : [])];
        if (practice.coordinationFailure) {
          const allAbsent = [stage.rootSessionId, stage.coordinatorSessionId, practice.managedSessionId]
            .every(id => !!id && !missionWorkProduction.owners.workers.getSession(id));
          return [{
            label: `只读诊断未结案的 Coordinator 回执 · ${project.title || projectId}`,
            description: "只读检查；不重发 Provider 消息", projectId, action: "diagnose-settlement",
          }, ...(allAbsent ? [{
            label: `原宿主退出后审核全新三页 Worker 接班 · ${project.title || projectId}`,
            description: "须先隔离原三个网页，再经机器死亡证明和两次人工确认",
            projectId, action: "replace-new-pages",
          }] : [])];
        }
        if ((practice.phase === "ready" || practice.phase === "reviewed-unknown" || practice.phase === "sent" && ["completed", "error"].includes(practice.lastFeedback?.terminalStatus ?? ""))
          && (reviewedReadContinuationAction(stage, missionWorkProduction.owners.workers.listSessions()) === "restore-read"
          || !missionWorkProduction.owners.workers.getSession(practice.managedSessionId ?? ""))) {
          return [{ label: `恢复仍然存在的原网页 · ${project.title || projectId}`, description: projectId, projectId, action: "restore-read" },
            ...(practice.phase === "sent"
              ? [{ label: `原网页已关闭 · 审核全新三页 Worker 接班 · ${project.title || projectId}`,
                description: projectId, projectId, action: "replace-new-pages" }] : [])];
        }
        return practice.phase === "ready" || practice.phase === "reviewed-unknown" || practice.phase === "sent" && ["completed", "error"].includes(practice.lastFeedback?.terminalStatus ?? "")
          ? [{ label: `运行实现与测试 Mission · ${project.title || projectId}`, description: projectId, projectId, action: "run-practice" }] : [];
      }
      const action = reviewedReadAction(takeoverStates()[projectId], missionWorkProduction.owners.workers.listSessions())
        ?? reviewedReadContinuationAction(takeoverStates()[projectId], missionWorkProduction.owners.workers.listSessions());
      const rows: Array<{ label: string; description: string; projectId: string; action: string }> = action ? [{ label: `${action === "reconcile" || action === "restore-read" ? "恢复原 Mission 的网页连接" : "继续原 Mission 的新只读目标"} · ${project.title || projectId}`,
        description: projectId, projectId, action }] : [];
      if (action === "continue-read") rows.unshift({ label: `准备实现与测试 Mission · ${project.title || projectId}`, description: projectId, projectId, action: "prepare-practice" });
      return rows;
    });
    const selected = await vscode.window.showQuickPick([...choices,
      { label: "检查网页 AI 连接（独立备用页）", description: "发送一次固定诊断消息，无任务、无工具", projectId: "", action: "connection-check" },
      { label: "仅查看工具归属与授权设置", description: "不恢复连接、不发送请求", projectId: "", action: "status" }],
      { title: "Nimora · 原 Worker 状态与操作", ignoreFocusOut: true });
    if (!selected) return true;
    if (selected.action === "status") return false;
    if (selected.action === "connection-check") { await runWebAiConnectionCheck(); return true; }
    if (selected.action === "prepare-practice") { await prepareReviewedPracticeEntry(selected.projectId); return true; }
    if (selected.action === "run-practice") { await runReviewedPracticeEntry(selected.projectId); return true; }
    if (selected.action === "reconcile-practice") { await reconcileReviewedPractice(selected.projectId); return true; }
    if (selected.action === "diagnose-settlement") { await diagnoseReviewedSettlement(selected.projectId); return true; }
    if (selected.action === "replace-new-pages") { await replaceReviewedClosedPageWorkers(selected.projectId); return true; }
    if (selected.action === "resume-new-pages") { await replaceReviewedClosedPageWorkers(selected.projectId, true); return true; }
    if (selected.action === "restore-read") { await restoreReviewedSettledRead(selected.projectId); return true; }
    if (selected.action === "continue-read") { await continueReviewedRead(selected.projectId); return true; }
    if (selected.action === "reconcile") await reconcileReviewedFirstRead(selected.projectId);
    else await sendReviewedFreshRead(selected.projectId);
    return true;
  };
  const adoptReviewedWebCognition = async (): Promise<{ state: string; projectId?: string }> => {
    const workspace = oneTrustedWorkspace();
    if (webProjectStartInFlight) throw new Error("另一次网页建项仍在运行，不得并行形成 Project。");
    if (context.workspaceState.get("nimora.webFormationUnknown") || context.workspaceState.get(reviewedRecoveryPendingKey)) {
      throw new Error("存在未核实的 Formation 结果；必须先对账，不得再次提交。");
    }
    if (!existsSync(reviewedRecoveryFile)) throw new Error("尚未保存经人工审核的旧 Cognition JSON。没有启动新网页请求。");
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(reviewedRecoveryFile));
    if (bytes.byteLength > 65_536) throw new Error("旧 Cognition 文件超过最大长度。");
    const reviewed = validateReviewedWebCognition(new TextDecoder().decode(bytes), workspace);
    const applied = context.workspaceState.get<string[]>("nimora.reviewedWebCognitionApplied", []);
    if (applied.includes(reviewed.digest)) throw new Error("该审核结果已经用于建项；禁止再次使用同一份结果。");
    // Fail closed when canonical owners are unreadable or this workspace
    // already has a Project, even if the UI currently looks empty.
    const existing = await readProjectMissionPresentation(projectMissionPresentationOwners);
    if (existing.availability.projects.status !== "available" || existing.availability.tasks.status !== "available"
      || existing.projects.some(project => project.workspace === workspace)) {
      throw new Error("Project/Mission 真值不可用或当前工作区已有 Project；先对账，禁止重复使用旧结果。");
    }
    const consent = await vscode.window.showWarningMessage(
      "接入已完成的 DeepSeek 分析？此操作不会重新发送旧 Cognition、访问原规划网页或自动指派 Worker；仅在二次确认后通过 canonical owners 形成 Project。",
      { modal: true, detail: `项目：${reviewed.projectTitle}\n目标：${reviewed.projectGoal}\n首个 Mission：${reviewed.firstMissionGoal}\n\n恢复证据 SHA-256：${reviewed.digest}` },
      "审核并接入现有结果", "取消",
    );
    if (consent !== "审核并接入现有结果") return { state: "cancelled" };
    if (webProjectStartInFlight || context.workspaceState.get(reviewedRecoveryPendingKey)) {
      throw new Error("另一次人工接入已经开始；不能重复形成 Project。");
    }
    webProjectStartInFlight = true;
    // Persist a recovery marker before the first canonical write; a crash may
    // not silently authorize repeating this reviewed Formation.
    await context.workspaceState.update(reviewedRecoveryPendingKey, { digest: reviewed.digest, workspace });
    try {
      const outcome = await missionWorkProduction.userEntry.start(reviewed.projectGoal, workspace,
        async () => reviewed.json,
        async (pending, plan) => await vscode.window.showInformationMessage("再次确认：仅形成这个 Project，不自动向网页发送新的消息", {
          modal: true, detail: `${pending.project.goal}\n\n首个 Mission：${pending.initialRoot.goal}\n完成条件：${pending.initialRoot.completionCriteria.join("；")}\n原回复指令：${plan.instruction}`,
        }, "确认创建 Project") === "确认创建 Project",
        () => false, undefined, { stopAfterFormation: true });
      if (!("scope" in outcome)) {
        if (outcome.state === "cancelled") await context.workspaceState.update(reviewedRecoveryPendingKey, undefined);
        return { state: outcome.state };
      }
      if (outcome.state !== "formed-only") throw new Error("审核恢复意外触发了自动执行；保留 UNKNOWN 等待人工核实。");
      const projectId = outcome.scope.projectId;
      const allWeb = context.workspaceState.get<string[]>("nimora.webProjectIds", []);
      await context.workspaceState.update("nimora.webProjectIds", [...new Set([...allWeb, projectId])]);
      const only = context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []);
      await context.workspaceState.update(adoptedWebProjectIdsKey, [...new Set([...only, projectId])]);
      await context.workspaceState.update("nimora.reviewedWebCognitionApplied", [...new Set([...applied, reviewed.digest])]);
      await context.workspaceState.update(reviewedRecoveryPendingKey, undefined);
      await vscode.window.showInformationMessage("已使用审核过的旧 DeepSeek 结果形成 Project。尚未启动 Worker、读取文件或复用旧规划网页；请先核实 Project 真值。");
      return { state: "formed-only", projectId };
    } catch (error) {
      if (error instanceof MissionFormationOutcomeUnknownError) {
        await context.workspaceState.update("nimora.webFormationUnknown", { formationId: error.formationId, workspace });
      }
      // Do not clear the recovery marker after an ambiguous exception.
      throw error;
    } finally { webProjectStartInFlight = false; }
  };
  // A provider response that completed before the additional pages became ready
  // is consumed cognition. Persist its bounded result, never send that prompt
  // again simply because a later page needs login/share.
  const webFormationPlanKey = "nimora.webFormationPreparedPlan.v1";
  const createWebProject = async (request: string, resourceChoice?: unknown): Promise<{ state: string; projectId?: string }> => {
    const workspace = oneTrustedWorkspace();
    // A caller supplies a draft only. It cannot skip the native paid/start
    // confirmation; the host creates the revision and commits it after approval.
    const preferenceRevision = resourcePreferences(context).revision;
    const resources = resourceChoice === undefined ? resourcePreferences(context)
      : normalizeResourcePolicy({ ...(resourceChoice as Record<string, unknown>), revision: randomUUID() });
    if (typeof request !== "string" || !request.trim() || request.length > 30_000) throw new Error("请输入有界的项目目标。");
    const existingProjects = await readProjectMissionPresentation(projectMissionPresentationOwners);
    if (existingProjects.availability.projects.status !== "available"
      || existingProjects.projects.some(project => project.workspace === workspace)) {
      throw new Error("此测试工作区已有 Project 或其真值不可读取。请继续已有 Project，不得意外重复建项。");
    }
    if (context.workspaceState.get(reviewedRecoveryPendingKey)) throw new Error("已有旧 Cognition 人工接入结果未核实；不能新建另一个 Project。");
    if (existsSync(reviewedRecoveryFile)
      && context.workspaceState.get<string[]>("nimora.reviewedWebCognitionApplied", []).length === 0) {
      throw new Error("当前保存了尚未接入的旧 DeepSeek Cognition。请先核实原结果，不得重新向网页发送相同建项请求。");
    }
    if (webProjectStartInFlight) {
      await vscode.window.showInformationMessage("已有网页建项流程正在进行。请等待当前流程结束，避免重复创建 Project。");
      return { state: "in-progress" };
    }
    const unknownFormation = context.workspaceState.get<{ formationId: string; workspace: string }>("nimora.webFormationUnknown");
    if (unknownFormation) {
      throw new Error(`曾有 Project Formation 结果不确定（${unknownFormation.formationId}）。请先从 canonical Project/Task 记录核实这次建项；Nimora 禁止自动再建一个项目。`);
    }
    const requestDigest = createHash("sha256").update(request).digest("hex");
    const cachedPlan = context.workspaceState.get<{ workspace: string; requestDigest: string; json: string; jsonDigest: string }>(webFormationPlanKey);
    if (cachedPlan && (cachedPlan.workspace !== workspace || cachedPlan.requestDigest !== requestDigest
      || typeof cachedPlan.json !== "string" || cachedPlan.json.length > 65_536
      || createHash("sha256").update(cachedPlan.json).digest("hex") !== cachedPlan.jsonDigest)) {
      throw new Error("已有不同请求或不可核实的规划结果。请先审核原规划；Nimora 不会覆盖或自动重发。");
    }
    webProjectStartInFlight = true;
    try {
    const agreed = await vscode.window.showInformationMessage(
      "建项并启动本次有界自治？" + resourceConsentText(resources) + " Nimora 先分析目标，最多运行 8 轮。新网页仍需逐页共享，工具权限仍独立审核；正式完成和网站会话归档仍需确认。UNKNOWN、回执不明或轮次上限会停止，不会重放旧输入或创建后台任务。",
      { modal: true }, "建项并启动", "取消",
    );
    if (agreed !== "建项并启动" || (resources.mode !== "api" && !(await enableExplicitWebCapabilities()))) return { state: "cancelled" };
    await productionWorkersReady;
    // A notification toast overlaps the native BrowserView and hides its page.
    // Preparation must remain silent so the Human can log in/share that page.
    if (resources.planner !== "api" && !(await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Nimora · 先准备一张需求规划网页", cancellable: false },
      progress => openDeepSeekPages(1, progress)))) return { state: "awaiting-share" };
    if (resourcePreferences(context).revision !== preferenceRevision) throw new Error("启动期间资源偏好变化；未发送规划。");
    const cognitionSessionId = await webCognitionPool.acquire(undefined, resources.planner);
    try {
      webTaskChars = 0;
      webTaskOutput.clear();
      const formationProgressTitle = resources.planner === "api"
        ? resources.mode === "api" ? "Nimora · API 规划与建项" : "Nimora · API 规划与混合执行建项"
        : resources.mode === "web" ? "Nimora · 网页 AI 规划与建项" : "Nimora · 网页 AI 规划与混合执行建项";
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: formationProgressTitle, cancellable: false },
        () => missionWorkProduction.userEntry.start(request, workspace,
          async input => {
            let json = cachedPlan?.json;
            if (json) {
              const cached = JSON.parse(json);
              const policies = (cached.initialRoot?.constraints ?? []).filter((c: unknown) => typeof c === "string" && c.startsWith(RESOURCE_POLICY_PREFIX));
              if (policies.length !== 1 || JSON.parse(policies[0].slice(RESOURCE_POLICY_PREFIX.length)).revision !== resources.revision) throw new Error("已保存的规划资源授权与本次启动偏好不一致；保留原结果，不重发、不更换资源。");
            }
            if (!json) {
              json = await interpretThroughWeb(input, cognitionSessionId, resources);
              // Persist before waiting for any additional provider resource.
              await context.workspaceState.update(webFormationPlanKey, { workspace, requestDigest, json,
                jsonDigest: createHash("sha256").update(json).digest("hex") });
            }
            // The current Formation contract has exactly one root and one
            // Coordinator, not three AI-authored Missions. These two live
            // roles need two NEW distinct pages. The planner source now excludes
            // its exact native pageId even if pageSessionId was absent on first use.
            if (resources.planner !== "api" && !(await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Nimora · 准备执行网页", cancellable: false },
              progress => openDeepSeekPages(2, progress)))) {
              throw new Error("规划已保存，但所需执行网页尚未全部就绪。请完成共享后用相同需求继续；不会重发原规划请求。");
            }
            if (resourcePreferences(context).revision !== preferenceRevision) throw new Error("已保存规划，但资源偏好变化；未形成 Project，不重发规划。");
            return json;
          }, webFormationConfirm, () => false, webTargetText, {
            deferInitialExecution: true,
            onFormedPlan: async (formed, missions) => {
              await missionWorkProduction.plannedWork.establish({
                projectId: formed.project.projectId, rootMissionId: formed.rootMission.taskId,
                planKey: formed.formationDigest, additionalMissions: missions,
              });
            },
          }));
      if ("scope" in result) {
        await context.workspaceState.update(webFormationPlanKey, undefined);
        webCognitionPool.attachFormedProject(result.scope.projectId, cognitionSessionId);
        const known = context.workspaceState.get<string[]>("nimora.webProjectIds", []);
        await context.workspaceState.update("nimora.webProjectIds", [...new Set([...known, result.scope.projectId])]);
        if (result.state === "ready-for-autonomy") {
          const inspection = await missionWorkProduction.coordinator.inspectManagedScope({
            projectId: result.scope.projectId, managedRootMissionId: result.scope.rootMissionId,
          });
          const currentProject = projectStore.getProject(result.scope.projectId);
          const fresh = await Promise.all(taskRuntime.listTasks().filter(task => task.mission?.projectId === result.scope.projectId
            && task.mission.rootMissionId === result.scope.rootMissionId).map(task => taskRuntime.rereadTask(task.taskId)));
          if (!currentProject || fresh.some(task => !task)) throw new Error("本次建项启动真值无法完整读取。");
          const claims = autonomyStartClaims(workspace, currentProject, result.scope.rootMissionId,
            inspection.coordinationMissionId, fresh as import("../../../src/task-contract.js").TaskSnapshot[]);
          webAutonomyStartConsent.authorize(claims);
          try {
            const autonomy = await vscode.commands.executeCommand<{ state?: string }>("shuncode.nimora.runWebAutonomy", {
              projectId: result.scope.projectId,
            });
            if (webTaskChars) webTaskOutput.show(true);
            return { state: autonomy?.state ?? result.state, projectId: result.scope.projectId };
          } finally { webAutonomyStartConsent.discard(claims); }
        }
        await vscode.window.showInformationMessage(result.state === "executed"
          ? "网页 AI 项目已启动。请查看 Nimora → Projects 和 Web AI 工作结果输出。"
          : `Project 已形成，但执行停止：${result.state === "blocked" ? result.reason : "需要进一步确认"}。不会自动重放；请从当前 Project 检查 Worker 状态。`);
        if (webTaskChars) webTaskOutput.show(true);
        return { state: result.state, projectId: result.scope.projectId };
      }
      if (result.state === "cancelled") await context.workspaceState.update(webFormationPlanKey, undefined);
      await webCognitionPool.retireUnused(cognitionSessionId);
      return { state: result.state };
    } catch (error) {
      if (error instanceof MissionFormationOutcomeUnknownError) {
        // A UI-only safety latch: never assert this marker is canonical Project
        // truth, and do not automatically clear it on restart or a second click.
        await context.workspaceState.update("nimora.webFormationUnknown", { formationId: error.formationId, workspace });
        await vscode.window.showErrorMessage("Project Formation 的持久化结果不确定。请先核实已有 Project；禁止重复点击新建。");
      }
      await webCognitionPool.retireUnused(cognitionSessionId).catch(() => undefined);
      throw error;
    }
    } finally { webProjectStartInFlight = false; }
  };
  const continueWebMission = async (input?: { projectId?: string; missionId?: string; request?: string }): Promise<void> => {
    const workspace = oneTrustedWorkspace();
    if (!input || typeof input.projectId !== "string" || typeof input.missionId !== "string"
      || typeof input.request !== "string" || !input.request.trim() || input.request.length > 30_000) throw new Error("请选择确切的 Project/Mission 并输入本轮目标。");
    if (!context.workspaceState.get<string[]>("nimora.webProjectIds", []).includes(input.projectId)) {
      throw new Error("此 Project 尚未登记为网页建项；没有自动改动旧任务或复用未知执行来源。");
    }
    if (context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).includes(input.projectId)) {
      if (takeoverStates()[input.projectId]?.practice?.missionId === input.missionId) return runReviewedPracticeEntry(input.projectId, input.request);
      return continueReviewedRead(input.projectId, input.request, input.missionId);
    }
    await Promise.all([missionWorkProduction.owners.projects.initialize(), missionWorkProduction.owners.tasks.initialize()]);
    const project = missionWorkProduction.owners.projects.getProject(input.projectId);
    const task = missionWorkProduction.owners.tasks.getTask(input.missionId);
    if (!project || project.formationReceipt?.project.workspace !== workspace
      || !task?.mission || task.mission.projectId !== input.projectId || task.missionFinalization) {
      throw new Error("当前本地工作区与 Project/Mission 的持久身份不一致，或 Mission 已结束。没有发送请求。");
    }
    await productionWorkersReady;
    if (!webCognitionPool.hasHealthyLocalReference(input.projectId)) {
      // A fresh Extension Host cannot prove whether a previous browser-side
      // planning turn or the durable Coordinator/Target ownership settled.
      // Do not treat a superficially idle page as permission to replay work.
      throw new Error("本次 ShunCode 会话已失去原网页规划连接。请先核实旧 Worker/执行记录并完成显式恢复；Nimora 不会在重启后盲目续接。");
    }
    const inspection = await missionWorkProduction.coordinator.inspectManagedScope({ projectId: input.projectId, managedRootMissionId: task.mission.rootMissionId });
    const scope = { projectId: input.projectId, rootMissionId: task.mission.rootMissionId,
      coordinationMissionId: inspection.coordinationMissionId, missionId: task.taskId };
    const planningSessionId = await webCognitionPool.acquire(input.projectId);
    webTaskChars = 0;
    webTaskOutput.clear();
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Nimora · DeepSeek 网页继续原 Mission", cancellable: false },
      () => missionWorkProduction.userEntry.continueWithCognition(scope, input.request!, workspace,
        plan => interpretThroughWeb(plan, planningSessionId), () => false, webTargetText));
    await vscode.window.showInformationMessage(result.state === "executed"
      ? "原 Mission 的网页版执行已返回，请检查产物及执行记录。"
      : `本轮未继续：${result.state === "blocked" ? result.reason : "需要进一步确认"}。没有自动重放。`);
    if (webTaskChars) webTaskOutput.show(true);
  };
  const completionAttemptsKey = "nimora.projectCompletionAttempts";
  const completionScopesKey = "nimora.projectCompletionScopes.v2";
  const projectCompletion = new NimoraProjectCompletionEntry({
    previous: (projectId, rootMissionId) => context.workspaceState.get<Record<string, ProjectCompletionAttempt>>(completionScopesKey, {})[JSON.stringify([projectId, rootMissionId])]
      ?? context.workspaceState.get<Record<string, ProjectCompletionAttempt>>(completionAttemptsKey, {})[projectId],
    save: async (projectId, attempt) => context.workspaceState.update(completionScopesKey, {
      ...context.workspaceState.get<Record<string, ProjectCompletionAttempt>>(completionScopesKey, {}),
      [JSON.stringify([projectId, attempt.instruction.managedRootMissionId])]: attempt,
    }),
    read: async (projectId, completionKey) => {
      const workspace = oneTrustedWorkspace();
      const isAdopted = context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).includes(projectId);
      if (!context.workspaceState.get<string[]>("nimora.webProjectIds", []).includes(projectId)) {
        throw new Error("仅审核当前明确接入 Web Worker 的确切 Project。");
      }
      await productionWorkersReady;
      await Promise.all([missionWorkProduction.owners.projects.initialize(), taskRuntime.initialize()]);
      const project = missionWorkProduction.owners.projects.getProject(projectId);
      const roots = [requireActiveProjectRoot(taskRuntime.listTasks(), projectId)];
      if (!project?.formationReceipt || project.workspace !== workspace) {
        throw new Error("完成审核需要当前可信工作区中的唯一活动 root。");
      }
      if (!isAdopted && !(await webCognitionPool.ensureCompletionReference(projectId))) {
        throw new Error("正常网页 Formation Project 的完成审核需要原 tools-free Cognition 规划连接。");
      }
      if (isAdopted) {
        const takeover = takeoverStates()[projectId];
        if (!takeover?.replacement?.mutationStarted || Object.keys(takeover.replacement.assigned).length !== 3
          || !takeover.rootSessionId || !takeover.coordinatorSessionId || !takeover.practice?.managedSessionId) {
          throw new Error("人工接入 Project 尚未证明三条原 Mission 已由全新 Worker 完整接班；不能进入正式完成审核。");
        }
      }
      const inspection = await missionWorkProduction.coordinator.inspectManagedScope({ projectId, managedRootMissionId: roots[0].taskId });
      const instruction = { projectId, managedRootMissionId: roots[0].taskId, coordinationMissionId: inspection.coordinationMissionId, completionKey };
      const missions = await Promise.all(inspection.missions.map(row => taskRuntime.rereadTask(row.missionId)));
      const readiness = await missionWorkProduction.completion.inspectReadiness(instruction);
      if (!readiness.ready || missions.some(task => !task)) {
        throw new Error(`正式完成仍有未收敛工作：${readiness.blockers.map(row => `${row.code}:${row.missionId ?? row.targetMissionId ?? ""}`).join(", ") || "Mission UNKNOWN"}。`);
      }
      const workerFacts = missions.flatMap(task => Object.values(task!.workerSessions).filter(ref => !ref.retiredAt).map(ref => {
        const live = webWorkerSessions.getSession(ref.managedSessionId);
        if (!live || live.taskId !== task!.taskId || live.adapterSessionId !== ref.adapterSessionId || live.state !== "idle") {
          throw new Error("完成审核的原 Worker 不在当前宿主就绪；没有发送完成命令。");
        }
        return { missionId: task!.taskId, managedSessionId: live.managedSessionId, adapterSessionId: live.adapterSessionId, state: live.state };
      }));
      if (workerFacts.filter(row => row.missionId === instruction.managedRootMissionId).length !== 1
        || workerFacts.filter(row => row.missionId === instruction.coordinationMissionId).length !== 1) throw new Error("缺少唯一原 root/Coordinator Worker。");
      return {
        instruction,
        facts: {
          project: { title: project.title, goal: project.goal, workspace: project.workspace, formationDigest: project.formationReceipt.formationDigest, decisions: project.committedDecisions },
          inspection, readiness, workers: workerFacts,
          missions: missions.map(task => projectCompletionMissionFacts(task!)),
        },
      };
    },
    interpret: async (projectId, prompt) => {
      const isAdopted = context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).includes(projectId);
      if (!isAdopted) return webCognitionPool.runJson(await webCognitionPool.acquire(projectId), prompt);
      const roots = [requireActiveProjectRoot(taskRuntime.listTasks(), projectId)];
      const inspection = await missionWorkProduction.coordinator.inspectManagedScope({
        projectId, managedRootMissionId: roots[0].taskId,
      });
      const rootRefs = Object.values(roots[0].workerSessions).filter(ref => !ref.detachedAt && !ref.retiredAt);
      const coordination = await taskRuntime.rereadTask(inspection.coordinationMissionId);
      const coordinatorRefs = Object.values(coordination?.workerSessions ?? {}).filter(ref => !ref.detachedAt && !ref.retiredAt);
      if (rootRefs.length !== 1 || coordinatorRefs.length !== 1) {
        throw new Error("完成审核需要唯一当前 Cognition/Coordinator Worker。");
      }
      const rootSession = webWorkerSessions.getSession(rootRefs[0].managedSessionId);
      const coordinatorSession = webWorkerSessions.getSession(coordinatorRefs[0].managedSessionId);
      if (!rootSession || !coordinatorSession || rootSession.taskId !== roots[0].taskId
        || coordinatorSession.taskId !== inspection.coordinationMissionId
        || rootSession.adapterSessionId !== rootRefs[0].adapterSessionId
        || coordinatorSession.adapterSessionId !== coordinatorRefs[0].adapterSessionId) {
        throw new Error("完成审核的 Cognition/Coordinator Worker 身份与当前宿主不一致。");
      }
      for (const session of [rootSession, coordinatorSession]) {
        let settled = false;
        await webWorkerSessions.withAdapterSessionRetirementScope(
          [{ workerId: session.workerId, adapterSessionId: session.adapterSessionId }],
          async owner => { settled = owner.isKnownSettled({ workerId: session.workerId, adapterSessionId: session.adapterSessionId }); },
        );
        if (!settled) throw new Error("完成审核前仍有 Provider/UNKNOWN 边界未收敛；没有发送审核请求。");
      }
      let text = "";
      const targetInputId = randomUUID();
      const turn = await missionWorkProduction.liveDriver.executeCoordinatorCommandTurn({
        projectId,
        managedRootMissionId: roots[0].taskId,
        coordinationMissionId: inspection.coordinationMissionId,
        managedSessionId: coordinatorSession.managedSessionId,
        inputId: randomUUID(),
        command: {
          kind: "deliverExplicitMissionInput",
          arguments: {
            projectId,
            managedRootMissionId: roots[0].taskId,
            coordinationMissionId: inspection.coordinationMissionId,
            targetMissionId: roots[0].taskId,
            managedSessionId: rootSession.managedSessionId,
            inputId: targetInputId,
            instructionKind: "project-completion-review",
            instruction: prompt,
          },
        },
      }, (delta, targetMissionId) => {
        if (targetMissionId === roots[0].taskId && text.length < 16_000) text += delta.slice(0, 16_000 - text.length);
      });
      const observed = turn.commandResult as import("../../../src/mission-coordinator-live-driver.js").CoordinatorLiveTransportObservation;
      if (observed.terminalStatus !== "completed") {
        throw new Error(`Owning Cognition 完成审核没有可信 completed terminal：${observed.terminalError ?? observed.terminalStatus}`);
      }
      if (!text.trim()) throw new Error("Owning Cognition 完成审核没有返回有界结果。");
      return text;
    },
    confirm: async summary => (await vscode.window.showInformationMessage(
      "网页 Cognition 验收：\n" + summary + "\n\n确认后正式结束此 Project 的 root、Coordinator 和所属 Worker；文件与历史保留。", { modal: true }, "确认完成 Project", "取消",
    )) === "确认完成 Project",
    execute: async ({ instruction, inputId, evidenceDigest, reviewSummary }) => {
      const coordination = await taskRuntime.rereadTask(instruction.coordinationMissionId);
      const refs = Object.values(coordination?.workerSessions ?? {}).filter(row => !row.retiredAt);
      if (refs.length !== 1) throw new Error("完成命令需要唯一原 Coordinator；本次身份已消费，须核实结果。");
      await taskRuntime.recordArtifactStrict(instruction.managedRootMissionId, {
        kind: "report", title: "网页 Cognition 正式完成审核",
        metadata: { content: reviewSummary, evidenceDigest, completionKey: instruction.completionKey, inputId, reviewer: "web-cognition" },
      });
      return missionWorkProduction.application.executeCoordinatorCommandTurn({
        projectId: instruction.projectId, managedRootMissionId: instruction.managedRootMissionId,
        coordinationMissionId: instruction.coordinationMissionId, managedSessionId: refs[0].managedSessionId, inputId,
        command: { kind: "completeManagedScope", arguments: instruction },
      });
    },
  });
  const laterRootResourceChoices = new Map<string, import("../../../src/mission-resource-policy.js").MissionResourcePolicy>();
  const laterRootEntry = new NimoraLaterRootEntry({
    read: async projectId => {
      const workspace = oneTrustedWorkspace();
      await Promise.all([projectStore.initialize(), taskRuntime.initialize()]);
      const project = projectStore.getProject(projectId);
      if (!project?.formationReceipt || project.workspace !== workspace
        || !context.workspaceState.get<string[]>("nimora.webProjectIds", []).includes(projectId)
        || context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).includes(projectId)) {
        throw new Error("新增目标需要当前工作区中正式网页 Formation 的确切 Project；旧接管合同保持独立。");
      }
      const missions = await Promise.all(taskRuntime.listTasks().filter(task => task.mission?.projectId === projectId)
        .map(task => taskRuntime.rereadTask(task.taskId)));
      if (missions.some(task => !task)) throw new Error("原 Mission 真值不可完整读取。");
      return { projectId, workspace, project, missions: missions as import("../../../src/task-contract.js").TaskSnapshot[] };
    },
    interpret: async (projectId, prompt) => {
      await productionWorkersReady;
      const resources = laterRootResourceChoices.get(projectId) ?? resourcePreferences(context);
      await webCognitionPool.releaseForBackendChange(projectId, resources.planner);
      if (!webCognitionPool.hasHealthyLocalReference(projectId) && resources.planner !== "api") {
        if (!(await vscode.window.withProgress({ location: vscode.ProgressLocation.Window,
          title: "Nimora · 为下一轮目标准备规划网页", cancellable: false }, progress => openDeepSeekPages(1, progress)))) {
          throw new Error("下一轮目标等待原生网页共享；尚未发送规划或创建 root。");
        }
      }
      return webCognitionPool.runJson(await webCognitionPool.acquire(projectId, resources.planner), prompt);
    },
    pending: projectId => context.workspaceState.get<Record<string, import("./nimora-later-root-entry.js").PendingLaterRoot>>("nimora.pendingLaterRoot.v1", {})[projectId],
    save: async pending => {
      const key = "nimora.pendingLaterRoot.v1";
      const previous = context.workspaceState.get<Record<string, import("./nimora-later-root-entry.js").PendingLaterRoot>>(key, {});
      if (previous[pending.operation.projectId]) throw new Error("原新增目标操作仍未收敛，不能覆盖其恢复身份。");
      await context.workspaceState.update(key, { ...previous, [pending.operation.projectId]: pending });
    },
    consumed: async (projectId, operationId) => {
      // Clear the old round's UI outcome before releasing the recovery latch.
      const outcomes = context.workspaceState.get<Record<string, unknown>>("nimora.autonomyOutcome.v1", {});
      delete outcomes[projectId];
      await context.workspaceState.update("nimora.autonomyOutcome.v1", outcomes);
      const key = "nimora.pendingLaterRoot.v1";
      const pending = context.workspaceState.get<Record<string, import("./nimora-later-root-entry.js").PendingLaterRoot>>(key, {});
      if (pending[projectId]?.operation.rootOperationId !== operationId) throw new Error("新增目标恢复身份发生变化。");
      delete pending[projectId];
      await context.workspaceState.update(key, pending);
    },
    ensure: operation => missionWorkProduction.application.ensureLaterProjectRoot(operation),
  });
  // Product UI is reconstructible from existing canonical owners. Its only
  // write paths go through the already-owned human governance / Mission ingress.
  registerNimoraProductLayer(
    context,
    missionWorkProduction,
    productionWorkersReady,
    listener => taskShadow.onDidChangeTask(() => listener()),
  );
  context.subscriptions.push(registerNimoraPlannedWorkerAssignment(context, missionWorkProduction, webCognitionPool, productionWorkersReady));
  context.subscriptions.push(registerNimoraAutonomyEntry(context, missionWorkProduction, productionWorkersReady, webAutonomyStartConsent));
  context.subscriptions.push(registerNimoraProviderCleanup(context, missionWorkProduction));
  const customAgents = registerShunCodeCustomAgents(context);
  const customAgentDiscoveryCts = new vscode.CancellationTokenSource();

  context.subscriptions.push(
    vscode.commands.registerCommand("_shuncode.nimora.observations", async () => {
      for (const session of webWorkerSessions.listSessions().filter(row => row.taskId && webWorkerSessions.getWorker(row.workerId)?.kind === "web").slice(0, 32)) {
        const task = taskRuntime.getTask(session.taskId!);
        if (!task) continue;
        const health = await webWorkerSessions.health(session.managedSessionId);
        const page = health.extensions?.pageStatus as Record<string, unknown> | undefined;
        const chat = health.extensions?.observation as Record<string, unknown> | undefined;
        observations.recordBrowser(task, session, {
          checkedAt: health.checkedAt, transport: health.status === "offline" ? "lost" : "connected",
          page: health.status === "healthy" ? "exact" : "unknown", conversation: "unknown",
          turn: session.state === "running" ? "running" : session.state === "idle" ? "idle" : "unknown",
          auth: page?.isDeepSeekAuthPage === true ? "challenge" : page?.isDeepSeekAuthPage === false || chat?.ready === true ? "ready" : "unknown",
          capability: "unknown",
        });
      }
      return observations.snapshot();
    }),
    output,
    webTaskOutput,
    ideToolBroker,
    taskShadow,
    bridgeLicense,
    bridgeAccess,
    bridge,
    runtime,
    apiModelProvider,
    codexModelProvider,
    branchStore,
    participant,
    customAgents,
    customAgentDiscoveryCts,
    vscode.lm.registerLanguageModelChatProvider("shuncode", apiModelProvider),
    vscode.lm.registerLanguageModelChatProvider("shuncode-codex", codexModelProvider),
    vscode.commands.registerCommand("_shuncode.projectFormation.mintId", () => missionWorkProduction.application.mintFormationId()),
    vscode.commands.registerCommand("shuncode.nimora.selectProjectSkills", async (input?: { projectId?: string }) => {
      const workspace = oneTrustedWorkspace();
      await Promise.all([projectStore.initialize(), taskRuntime.initialize()]);
      let projectId = input?.projectId;
      if (!projectId) {
        const picked = await vscode.window.showQuickPick(projectStore.listProjects().filter(project => project.workspace === workspace).map(project => ({
          label: project.title ?? project.goal ?? project.projectId, projectId: project.projectId,
        })), { title: "选择本轮使用 Skills 的 Project" });
        if (!picked) return { state: "cancelled" }; projectId = picked.projectId;
      }
      if (projectStore.getProject(projectId)?.workspace !== workspace) throw new Error("Skill 选择需要当前工作区的确切 Project。");
      const root = requireActiveProjectRoot(taskRuntime.listTasks(), projectId);
      const index = await missionWorkProduction.skills.discover();
      const key = JSON.stringify([projectId, root.taskId]);
      const saved = context.workspaceState.get<Record<string, { skillId: string; sourceId: string; canonicalLocator: string; contentDigest: string }[]>>("nimora.rootSkillTrust.v1", {});
      const previous = new Set((saved[key] ?? []).map(row => row.skillId));
      const selected = await vscode.window.showQuickPick(index.skills.filter(skill => skill.enabled && !skill.firstPartyBuiltIn).map(skill => ({
        label: skill.name, description: skill.sourceId, detail: skill.canonicalLocator, picked: previous.has(skill.skillId), skill,
      })), { title: "为本轮选择并信任外部 Skills", placeHolder: "只提供工作指导，不授予工具权限；清空可撤销本轮选择。", canPickMany: true });
      if (!selected) return { state: "cancelled" };
      if (selected.length > 32) throw new Error("本轮最多选择 32 个 Skills。");
      const approved = await Promise.all(selected.map(async ({ skill }) => ({ skillId: skill.skillId, sourceId: skill.sourceId,
        canonicalLocator: skill.canonicalLocator, contentDigest: (await index.loadContent(skill.skillId)).contentDigest })));
      if (oneTrustedWorkspace() !== workspace || requireActiveProjectRoot(taskRuntime.listTasks(), projectId).taskId !== root.taskId) throw new Error("选择期间本轮 root 已变化。");
      await context.workspaceState.update("nimora.rootSkillTrust.v1", { ...saved, [key]: approved });
      return { state: "selected", count: approved.length, projectId, rootMissionId: root.taskId };
    }),
    vscode.commands.registerCommand("shuncode.mission.selectWorker", async () => {
      if (context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).length) {
        await vscode.window.showWarningMessage("本工作区有人工接入的旧 Cognition Project。请从 Nimora Project 页面使用精确新网页接管，不能用通用 Worker 选择器误选旧规划页。");
        return;
      }
      return selectMissionWorker(missionWorkProduction, productionWorkersReady);
    }),
    vscode.commands.registerCommand("shuncode.nimora.startWebProject", (input?: { request?: unknown; resources?: unknown }) => createWebProject(input?.request as string, input?.resources)),
    vscode.commands.registerCommand("shuncode.nimora.startNextProjectGoal", async (input?: { projectId?: string; request?: string; resources?: unknown }) => {
      const workspace = oneTrustedWorkspace();
      await Promise.all([projectStore.initialize(), taskRuntime.initialize()]);
      let projectId = input?.projectId;
      if (!projectId) {
        const webIds = new Set(context.workspaceState.get<string[]>("nimora.webProjectIds", []));
        const adopted = new Set(context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []));
        const picked = await vscode.window.showQuickPick(projectStore.listProjects().filter(project =>
          project.workspace === workspace && webIds.has(project.projectId) && !adopted.has(project.projectId)).map(project => ({
          label: project.title ?? project.goal ?? project.projectId, projectId: project.projectId,
        })), { title: "在现有 Project 中开始下一项工作" });
        if (!picked) return { state: "cancelled" }; projectId = picked.projectId;
      }
      const request = input?.request ?? await vscode.window.showInputBox({ title: "本 Project 的下一轮目标", prompt: "原轮次须已完成归档；待恢复操作请使用原目标。" });
      if (request === undefined) return { state: "cancelled" };
      const latestRoot = taskRuntime.listTasks().filter(t => t.mission?.projectId === projectId && t.mission.rootMissionId === t.taskId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      const preferred = input?.resources ?? (latestRoot && readResourcePolicy(latestRoot)) ?? resourcePreferences(context);
      const resources = normalizeResourcePolicy({ ...(preferred as Record<string, unknown>), revision: randomUUID(), roleRequirements: undefined });
      const confirmed = await vscode.window.showInformationMessage("在当前 Project 中开始下一轮并启动有界自治？", { modal: true,
        detail: resourceConsentText(resources) + " 新目标解释和执行使用新输入；原轮次历史保持。新页共享、工具权限和正式完成仍独立确认，UNKNOWN 立即停止。" }, "开始并启动", "取消");
      if (confirmed !== "开始并启动") return { state: "cancelled" };
      if (resources.mode !== "api" && !(await enableExplicitWebCapabilities())) return { state: "cancelled" };
      if (laterRootResourceChoices.has(projectId)) throw new Error("该 Project 已有下一轮启动流程。");
      laterRootResourceChoices.set(projectId, resources);
      try {
      const result = await laterRootEntry.start(projectId, request);
      const root = requireActiveProjectRoot(taskRuntime.listTasks(), projectId);
      if (!readResourcePolicy(root)) await taskRuntime.replaceMissionConstraintsStrict(root.taskId, root.context.constraints,
        [...root.context.constraints, RESOURCE_POLICY_PREFIX + JSON.stringify(resources)]);
      const currentProject = projectStore.getProject(projectId)!;
      const inspection = await missionWorkProduction.coordinator.inspectManagedScope({ projectId, managedRootMissionId: root.taskId });
      const missions = await Promise.all(taskRuntime.listTasks().filter(t => t.mission?.projectId === projectId && t.mission.rootMissionId === root.taskId).map(t => taskRuntime.rereadTask(t.taskId)));
      if (missions.some(t => !t)) throw new Error("下一轮启动范围不可完整读取。");
      const claims = autonomyStartClaims(workspace, currentProject, root.taskId, inspection.coordinationMissionId, missions as import("../../../src/task-contract.js").TaskSnapshot[]);
      webAutonomyStartConsent.authorize(claims);
      try {
        const autonomy = await vscode.commands.executeCommand<{ state?: string }>("shuncode.nimora.runWebAutonomy", { projectId });
        return { state: autonomy?.state ?? "ready-for-autonomy", projectId, result };
      } finally { webAutonomyStartConsent.discard(claims); }
      } finally { laterRootResourceChoices.delete(projectId); }
    }),
    vscode.commands.registerCommand("shuncode.nimora.adoptReviewedWebCognition", () => adoptReviewedWebCognition()),
    vscode.commands.registerCommand("shuncode.nimora.takeoverReviewedWebWorkers", (input?: { projectId?: string }) => {
      if (!input?.projectId) throw new Error("请选择现有 Project，再批准新 Worker 安全接管。");
      return takeoverReviewedWebWorkers(input.projectId);
    }),
    vscode.commands.registerCommand("shuncode.nimora.startReviewedFirstMission", (input?: { projectId?: string }) => {
      if (!input?.projectId) throw new Error("请选择已经完成安全接管的确切 Project。");
      return startReviewedFirstMission(input.projectId);
    }),
    vscode.commands.registerCommand("shuncode.nimora.resumeReviewedWebWorkers", (input?: { projectId?: string }) => {
      if (!input?.projectId) throw new Error("请选择待绑定的确切 Project。");
      return takeoverReviewedWebWorkers(input.projectId, true);
    }),
    vscode.commands.registerCommand("shuncode.nimora.reconcileReviewedFirstRead", async (input?: { projectId?: string }) => {
      const projectId = await chooseReviewedProjectId(input);
      if (projectId) return reconcileReviewedFirstRead(projectId);
    }),
    vscode.commands.registerCommand("shuncode.nimora.sendReviewedFreshRead", async (input?: { projectId?: string }) => {
      const projectId = await chooseReviewedProjectId(input);
      if (projectId) return sendReviewedFreshRead(projectId);
    }),
    vscode.commands.registerCommand("shuncode.nimora.continueWebMission", (input?: { projectId?: string; missionId?: string; request?: string }) => continueWebMission(input)),
    vscode.commands.registerCommand("shuncode.nimora.reviewProjectCompletion", async (input?: { projectId?: string }) => {
      if (typeof input?.projectId !== "string" || !input.projectId.trim()) throw new Error("请选择确切 Project 进行完成审核。");
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "Nimora · 网页 AI 审核正式完成", cancellable: false },
        () => projectCompletion.review(input.projectId!));
      void vscode.window.showInformationMessage(result.state === "completed" ? "Project 已正式完成，Handoff 与执行历史已保留。" : result.summary);
      return result;
    }),
    vscode.commands.registerCommand("shuncode.nimora.restoreReviewedSettledRead", async (input?: { projectId?: string }) => {
      const projectId = await chooseReviewedProjectId(input);
      if (projectId) return restoreReviewedSettledRead(projectId);
    }),
    vscode.commands.registerCommand("shuncode.nimora.replaceReviewedClosedPages", async (input?: { projectId?: string }) => {
      const projectId = await chooseReviewedProjectId(input);
      if (projectId) return replaceReviewedClosedPageWorkers(projectId);
    }),
    vscode.commands.registerCommand("shuncode.nimora.resumeReviewedFreshReplacement", async (input?: { projectId?: string }) => {
      const projectId = await chooseReviewedProjectId(input);
      if (projectId) return replaceReviewedClosedPageWorkers(projectId, true);
    }),
    vscode.commands.registerCommand("shuncode.nimora.prepareReviewedPractice", async (input?: { projectId?: string }) => {
      const projectId = await chooseReviewedProjectId(input);
      if (projectId) return prepareReviewedPracticeEntry(projectId);
    }),
    vscode.commands.registerCommand("shuncode.nimora.runReviewedPractice", async (input?: { projectId?: string }) => {
      const projectId = await chooseReviewedProjectId(input);
      if (projectId) return runReviewedPracticeEntry(projectId);
    }),
    vscode.commands.registerCommand("shuncode.nimora.reconcileReviewedPractice", async (input?: { projectId?: string }) => {
      const projectId = await chooseReviewedProjectId(input);
      if (projectId) return reconcileReviewedPractice(projectId);
    }),
    vscode.commands.registerCommand("shuncode.nimora.diagnoseReviewedSettlement", async (input?: { projectId?: string }) => {
      const projectId = await chooseReviewedProjectId(input);
      if (projectId) return diagnoseReviewedSettlement(projectId);
    }),
    vscode.commands.registerCommand("shuncode.nimora.selectProjectWorker", async (input?: { projectId?: string; missionId?: string; provider?: string }) => {
      if (typeof input?.projectId !== "string" || !input.projectId.trim()) {
        await vscode.window.showWarningMessage("请先在 Nimora Projects 中选择确切 Project，避免误选历史测试 Mission。");
        return;
      }
      if (context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).includes(input.projectId)) {
        await vscode.window.showWarningMessage("这个 Project 只接入了旧 Cognition，独立 Worker 尚未完成对账；禁止直接分配。");
        return;
      }
      await selectMissionWorker(missionWorkProduction, productionWorkersReady, {
        projectId: input.projectId,
        ...(typeof input?.missionId === "string" ? { missionId: input.missionId } : {}),
        ...(typeof input?.provider === "string" ? { provider: input.provider } : {}),
      });
    }),
    vscode.commands.registerCommand("shuncode.nimora.connectWebAi", async (input?: { provider?: unknown; projectId?: string; missionId?: string }) => {
      if (!vscode.workspace.isTrusted) {
        await vscode.window.showWarningMessage("请先信任工作区，再连接具有网页访问权限的 Nimora Worker。");
        return;
      }
      const provider = isNimoraWebAiProvider(input?.provider) ? input.provider
        : (await vscode.window.showQuickPick([
          { label: "DeepSeek · 网页 AI", provider: "deepseek" as const },
          { label: "ChatGPT · 网页 AI", provider: "chatgpt" as const },
        ], { title: "连接 Nimora 网页 AI", placeHolder: "Nimora 将打开内置浏览器，并请求网页共享授权。" }))?.provider;
      if (!provider) return;
      if (webConnectionsInFlight.has(provider)) {
        await vscode.window.showInformationMessage(`${provider === "deepseek" ? "DeepSeek" : "ChatGPT"} 的网页连接正在准备；不再重复打开网页。`);
        return;
      }
      webConnectionsInFlight.add(provider);
      try {
      await productionWorkersReady;
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Nimora · 连接 ${provider === "deepseek" ? "DeepSeek" : "ChatGPT"} 网页 Worker`, cancellable: false },
        progress => prepareWebProvider(provider, 1, event => reportWebPreparation(event, progress)));
      if (result.state === "sharing-declined") {
        await vscode.window.showInformationMessage("网页共享未获授权，Nimora 没有连接或分配 Worker。");
        return;
      }
      if (result.state !== "ready") {
        await vscode.window.showWarningMessage(`网页已打开，但 Worker 尚未就绪：${result.detail}。登录后点击「分享给 Agent」，再从 Connections 重试连接。`);
        return;
      }
      const name = provider === "deepseek" ? "DeepSeek" : "ChatGPT";
      if (typeof input?.projectId === "string") {
        if (context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).includes(input.projectId)) {
          await vscode.window.showInformationMessage(`${name} 已连接；已接入旧 Cognition 的 Project 尚未核实独立 Worker，不自动分配或重新发送任务。`);
          return;
        }
        const choice = await vscode.window.showInformationMessage(`${name} 网页 Worker 已就绪。是否为当前 Project 的 Mission 分配或更换此 Worker？`, "选择 Mission", "暂不分配");
        if (choice === "选择 Mission") {
          await selectMissionWorker(missionWorkProduction, productionWorkersReady, {
            projectId: input.projectId,
            ...(typeof input.missionId === "string" ? { missionId: input.missionId } : {}),
            provider: result.candidate.provider,
          });
        }
      } else {
        await vscode.window.showInformationMessage(`${name} 网页 Worker 已就绪；尚未触发 Mission 或执行任何任务。`);
      }
      } finally { webConnectionsInFlight.delete(provider); }
    }),
    vscode.commands.registerCommand("shuncode.mission.reconcilePendingDelivery", async () => {
      output.appendLine("[mission-delivery] Opening canonical pending-result reconciliation.");
      try {
        // Reconciliation is canonical local state work. An unavailable provider
        // must not prevent disposing of that provider's old delivery ownership.
        await reconcileMissionPendingDelivery(missionWorkProduction, taskRuntime.initialize());
        output.appendLine("[mission-delivery] Reconciliation command settled.");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[mission-delivery] Reconciliation failed: ${message}`);
        void vscode.window.showErrorMessage(`Pending result reconciliation failed: ${message}`);
      }
    }),
    vscode.commands.registerCommand("shuncode.mission.connectNativeMcp", () => connectMissionNativeMcp(missionWorkProduction, productionWorkersReady, async request => {
      const capability = await missionWorkProduction.capability.materialize(request);
      const binding = await missionNativeMcp.prepareAdvertisement({
        projectId: capability.projectId, rootMissionId: capability.rootMissionId, missionId: capability.missionId,
        managedSessionId: capability.managedSessionId, capability,
      });
      // This user setup supplies a stable Mission alias. Each request resolves
      // through canonical current WorkerSession truth to an ephemeral binding;
      // replacement generations therefore invalidate old protocol sessions.
      return publishMissionMcpConnection(binding, true);
    })),
    vscode.commands.registerCommand("_shuncode.mission.replaceWorker", async (input: Parameters<typeof missionWorkProduction.workerSelection.replace>[0]) => {
      if (context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).includes(input?.assignment?.projectId)) {
        throw new Error("人工接入的旧 Project 禁止从通用 Worker 替换命令绕过精确页面接管。");
      }
      await productionWorkersReady;
      return missionWorkProduction.workerSelection.replace(input);
    }),
    vscode.commands.registerCommand("_shuncode.projectFormation.submitCognitionOutcome", (input: unknown) =>
      missionWorkProduction.application.submitCognitionOutcome(input)),
    vscode.commands.registerCommand("_shuncode.projectFormation.confirmHuman", (input: unknown) =>
      missionWorkProduction.application.confirmHumanFormation(input)),
    vscode.commands.registerCommand("_shuncode.projectFormation.cancelPending", (formationId: unknown) =>
      missionWorkProduction.application.cancelPendingFormation(formationId)),
    vscode.commands.registerCommand("_shuncode.projectFormation.ensureLaterRoot", (input: unknown) =>
      missionWorkProduction.application.ensureLaterProjectRoot(input)),
    vscode.commands.registerCommand("_shuncode.projectFormation.finalizeSupportMission", (input: unknown) =>
      missionWorkProduction.application.finalizeSupportMission(input)),
    vscode.commands.registerCommand("_shuncode.projectFormation.recoverManagedScopeCompletion", (input: unknown) =>
      missionWorkProduction.application.recoverManagedScopeCompletion(input)),
    vscode.commands.registerCommand("_shuncode.projectFormation.assignInitialWorker", async (input: unknown) => {
      const projectId = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).projectId : undefined;
      if (typeof projectId === "string" && context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).includes(projectId)) {
        throw new Error("旧 Cognition Project 不允许通用初始分配。请使用原生页面身份核实后的安全接管命令。");
      }
      await productionWorkersReady;
      return missionWorkProduction.application.assignInitialWorker(input);
    }),
    vscode.commands.registerCommand("_shuncode.projectFormation.retireAssignedWorker", async (input: unknown) => {
      await productionWorkersReady;
      return missionWorkProduction.application.retireAssignedWorker(input);
    }),
    vscode.commands.registerCommand("_shuncode.projectFormation.recoverOrphanedAssignedWorker", async (input: unknown) => {
      await productionWorkersReady;
      return missionWorkProduction.application.recoverOrphanedAssignedWorker(input);
    }),
    vscode.commands.registerCommand("_shuncode.projectFormation.reconcilePendingDelivery", async (input: unknown) => {
      await productionWorkersReady;
      return missionWorkProduction.application.reconcilePendingExecutionDelivery(input);
    }),
    vscode.commands.registerCommand("_shuncode.projectFormation.executeCoordinatorCommandTurn", async (input: unknown) => {
      const projectId = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>).projectId : undefined;
      if (typeof projectId === "string" && context.workspaceState.get<string[]>(adoptedWebProjectIdsKey, []).includes(projectId)) {
        throw new Error("已恢复 Project 的第一个新网页消息只允许经独立的人工审核入口发送。");
      }
      await productionWorkersReady;
      return missionWorkProduction.application.executeCoordinatorCommandTurn(input);
    }),
    vscode.commands.registerCommand("_shuncode.projectFormation.prepareNativeMcp", async (value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Mission-native MCP preparation requires an object request.");
      }
      const { startBridge, ...rawMaterialization } = value as Record<string, unknown>;
      if (startBridge !== undefined && typeof startBridge !== "boolean") {
        throw new Error("Mission-native MCP startBridge must be boolean when provided.");
      }
      await productionWorkersReady;
      const capability = await missionWorkProduction.capability.materialize(
        rawMaterialization as unknown as MissionCapabilityMaterializationRequest,
      );
      const binding = await missionNativeMcp.prepareAdvertisement({
        projectId: capability.projectId,
        rootMissionId: capability.rootMissionId,
        missionId: capability.missionId,
        managedSessionId: capability.managedSessionId,
        capability,
      });
      const connection = await publishMissionMcpConnection(binding, startBridge === true);
      const urls = bridge.getMissionNativeMcpUrls(binding.token);
      const currentMissionUrls = bridge.getCurrentMissionNativeMcpUrls(binding.missionId);
      const currentRouteRelay = connection.currentRouteRelay;
      const advertisedPublicUrl = connection.publicUrl;
      return {
        binding,
        localUrl: currentMissionUrls.localUrl,
        publicUrl: advertisedPublicUrl,
        directPublicUrl: urls.publicUrl,
        currentMissionPublicUrl: currentMissionUrls.publicUrl,
        currentRouteRelay: currentRouteRelay
          ? {
              configured: true,
              stableMcpUrl: currentRouteRelay.stableMcpUrl,
              targetUrl: currentRouteRelay.targetUrl,
              generation: currentRouteRelay.generation,
            }
          : { configured: false },
        bridgeState: bridge.getStatus().state,
      };
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("shuncode.model")) apiModelProvider.refresh();
    }),
    onCodexAuthChange(() => codexModelProvider.refresh()),
    vscode.commands.registerCommand("shuncode.codex.openView", async () => {
      await vscode.commands.executeCommand("aiCustomization.openManagementEditor", "codex");
    }),
    vscode.commands.registerCommand("shuncode.configureModel", async () => {
      const changed = await configureShunCodeModel(context);
      if (changed) {
        apiModelProvider.refresh();
        await vscode.window.showInformationMessage("ShunCode model configuration saved.");
      }
    }),
    vscode.commands.registerCommand("shuncode.setApiKey", () => setShunCodeApiKey(context)),
    vscode.commands.registerCommand("shuncode.branch.getGroupState", async (groupId: unknown) => {
      if (typeof groupId !== "string" || !groupId) return undefined;
      await branchStore.ensureLoaded();
      return branchStore.getState(groupId);
    }),
    vscode.commands.registerCommand("shuncode.branch.adoptVariant", async (groupId: unknown, variantId: unknown) => {
      if (typeof groupId !== "string" || typeof variantId !== "string" || !groupId || !variantId) return;
      await branchStore.ensureLoaded();
      branchStore.adopt(groupId, variantId);
    }),
    vscode.commands.registerCommand("shuncode.branch.setActiveVariant", async (groupId: unknown, variantId: unknown) => {
      if (typeof groupId !== "string" || typeof variantId !== "string" || !groupId || !variantId) return;
      await branchStore.ensureLoaded();
      branchStore.setActiveVariant(groupId, variantId);
    }),
    vscode.commands.registerCommand("shuncode.pickMergeModel", async () => {
      const models = await vscode.lm.selectChatModels({ vendor: "shuncode" });
      const codexModels = await vscode.lm.selectChatModels({ vendor: "shuncode-codex" });
      const all = [...models, ...codexModels];
      if (all.length === 0) {
        await vscode.window.showWarningMessage("No ShunCode models available to pick as the merge model.");
        return;
      }
      const current = vscode.workspace.getConfiguration("shuncode").get<string>("multiModel.mergeModel", "");
      const picked = await vscode.window.showQuickPick(
        all.map((model) => ({
          label: model.name,
          description: `${model.vendor}/${model.id}`,
          detail: current === `${model.vendor}/${model.id}` ? "Current merge model" : undefined,
          vendor: model.vendor,
          id: model.id,
        })),
        { title: "Multi-Model Rounds · Select Merge Model", placeHolder: "Select the model that verifies and summarizes the branch plans" },
      );
      if (!picked) return;
      await vscode.workspace.getConfiguration("shuncode").update(
        "multiModel.mergeModel", `${picked.vendor}/${picked.id}`, vscode.ConfigurationTarget.Global,
      );
      await vscode.window.showInformationMessage(`Merge model set to ${picked.label} (${picked.vendor}/${picked.id})`);
    }),
    vscode.commands.registerCommand("shuncode.testApiEndpoint", async (input: { baseUrl?: unknown; apiKey?: unknown } = {}) => {
      const baseUrl = typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "";
      const apiKey = typeof input?.apiKey === "string" ? input.apiKey.trim() : "";
      if (!baseUrl) return { ok: false, error: "Missing API endpoint URL." };
      const base = baseUrl.replace(/\/+$/, "");
      const modelsUrl = base.endsWith("/models") ? base : `${base}/models`;
      try {
        const headers: Record<string, string> = { accept: "application/json" };
        if (apiKey) headers.authorization = `Bearer ${apiKey}`;
        const response = await fetch(modelsUrl, { headers, signal: AbortSignal.timeout(10_000) });
        if (!response.ok) return { ok: false, error: `HTTP ${response.status} ${response.statusText}` };
        const payload: unknown = await response.json();
        const data = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>).data : undefined;
        const models = Array.isArray(data) ? data : Array.isArray(payload) ? payload : [];
        return { ok: true, count: models.length };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
    vscode.commands.registerCommand("shuncode.codex.login", async () => {
      const status = await codexAuthManager.getStatus();
      if (status.signedIn) {
        await vscode.window.showWarningMessage(
          `Already signed in to Codex as ${status.account?.email ?? status.account?.accountId}. Sign out first to switch accounts.`,
          "OK",
        );
        return;
      }
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Codex sign-in: complete the authorization in your browser…",
            cancellable: true,
          },
          async (_progress, progressToken) => {
            const account = await codexAuthManager.startLogin(progressToken);
            codexModelProvider.refresh();
            await vscode.window.showInformationMessage(
              `Signed in to Codex as ${account.email ?? account.accountId}${account.planType ? ` (${account.planType})` : ""}. Codex models are now available in the Chat model picker.`,
            );
          },
        );
      } catch (error) {
        if (error instanceof vscode.CancellationError) return;
        await vscode.window.showErrorMessage(`Codex sign-in failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand("shuncode.codex.logout", async () => {
      const status = await codexAuthManager.getStatus();
      if (!status.signedIn) {
        await vscode.window.showInformationMessage("Not signed in to Codex.");
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Sign out of Codex as ${status.account?.email ?? status.account?.accountId}? This also signs out the official Codex CLI.`,
        { modal: true },
        "Sign Out",
      );
      if (choice !== "Sign Out") return;
      try {
        await codexAuthManager.signOut();
        codexModelProvider.refresh();
        await vscode.window.showInformationMessage("Signed out of Codex.");
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to sign out of Codex: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand("shuncode.codex.relogin", async () => {
      const status = await codexAuthManager.getStatus();
      if (status.signedIn) {
        const choice = await vscode.window.showWarningMessage(
          `Sign in to Codex again as a different account? This signs out ${status.account?.email ?? status.account?.accountId} and the official Codex CLI first.`,
          { modal: true },
          "Sign In Again",
        );
        if (choice !== "Sign In Again") return;
        try {
          await codexAuthManager.signOut();
        } catch (error) {
          await vscode.window.showErrorMessage(`Failed to prepare Codex sign-in: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
      }
      await vscode.commands.executeCommand("shuncode.codex.login");
    }),
    vscode.commands.registerCommand("shuncode.codex.getStatus", () => codexAuthManager.getStatus()),
    vscode.commands.registerCommand("shuncode.codex.status", async () => {
      const status = await codexAuthManager.getStatus();
      if (!status.signedIn) {
        await vscode.window.showInformationMessage("Not signed in to Codex. Run 'ShunCode: Sign in with Codex' to use ChatGPT subscription models.");
        return;
      }
      const account = status.account;
      const expiry = status.expiresAt ? new Date(status.expiresAt * 1000).toLocaleString() : undefined;
      await vscode.window.showInformationMessage(
        `Signed in to Codex as ${account?.email ?? account?.accountId}${account?.planType ? ` · ${account.planType}` : ""}${expiry ? ` · access token expires ${expiry}` : ""}.`,
      );
    }),
    vscode.commands.registerCommand("shuncode.restartRuntime", async () => {
      try {
        const hello = await runtime.restart();
        await vscode.window.showInformationMessage(
          `ShunCode Runtime restarted · pid ${hello.pid} · protocol ${hello.protocolVersion} · ${hello.tools.length} tools`,
        );
      } catch (error) {
        await vscode.window.showErrorMessage(`Failed to restart ShunCode Runtime: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand("shuncode.showRuntimeStatus", async () => {
      try {
        const hello = await runtime.hello();
        await vscode.window.showInformationMessage(
          `ShunCode Runtime connected · pid ${hello.pid} · protocol ${hello.protocolVersion} · ${hello.tools.length} tools`,
        );
      } catch (error) {
        await vscode.window.showErrorMessage(`ShunCode Runtime unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand("shuncode.openChat", async () => {
      await vscode.commands.executeCommand("workbench.action.chat.open");
    }),
    vscode.commands.registerCommand("shuncode.taskCenter.getState", async (taskId?: unknown) => {
      const taskRuntime = taskShadow.executionRuntime();
      await taskRuntime.initialize();
      const selectedTaskId = typeof taskId === "string" && taskId.trim() ? taskId.trim() : undefined;
      return projectTaskCenterState(taskRuntime.listTasks(), selectedTaskId);
    }),
    vscode.commands.registerCommand("shuncode.taskCenter.open", async () => {
      await vscode.commands.executeCommand("workbench.action.chat.history");
    }),
    vscode.commands.registerCommand("shuncode.bridge.openView", async () => {
      await vscode.commands.executeCommand("aiCustomization.openManagementEditor", "bridge");
    }),
    vscode.commands.registerCommand("shuncode.bridge.getStatus", async () => {
      await bridgeReady;
      return bridge.getStatus();
    }),
    vscode.commands.registerCommand("shuncode.bridge.access.getStatus", async () => {
      await bridgeLicenseReady;
      return bridgeAccess.getAccessStatus();
    }),
    vscode.commands.registerCommand("shuncode.bridge.license.signIn", async () => {
      await bridgeLicenseReady;
      return bridgeAccess.signIn();
    }),
    vscode.commands.registerCommand("shuncode.bridge.license.signInWithGitee", async () => {
      await bridgeLicenseReady;
      return bridgeAccess.signInWithGitee();
    }),
    vscode.commands.registerCommand("shuncode.bridge.license.refresh", async () => {
      await bridgeLicenseReady;
      return bridgeAccess.refresh();
    }),
    vscode.commands.registerCommand("shuncode.bridge.license.refreshSession", async () => {
      await bridgeLicenseReady;
      return bridgeAccess.refreshSession();
    }),
    vscode.commands.registerCommand("shuncode.bridge.license.signOut", async () => {
      await bridgeLicenseReady;
      await vscode.workspace.getConfiguration("shuncode.bridge").update("persistentMode", false, vscode.ConfigurationTarget.Global);
      return bridgeAccess.signOut();
    }),
    vscode.commands.registerCommand("shuncode.bridge.license.redeem", async (value: unknown) => {
      await bridgeLicenseReady;
      if (typeof value !== "string") throw new Error("Bridge activation code must be a string.");
      return bridgeAccess.redeem(value);
    }),
    vscode.commands.registerCommand("shuncode.bridge.payment.getPlans", async (force?: unknown) => {
      await bridgeLicenseReady;
      return bridgeAccess.loadPlans(force === true);
    }),
    vscode.commands.registerCommand("shuncode.bridge.payment.createOrder", async (planId: unknown, paymentType: unknown) => {
      await bridgeLicenseReady;
      if (typeof planId !== "string") throw new Error("Bridge payment plan is required.");
      if (paymentType !== undefined && typeof paymentType !== "string") throw new Error("Bridge payment type must be a string.");
      return bridgeAccess.createPayment(planId, paymentType ?? "alipay");
    }),
    vscode.commands.registerCommand("shuncode.bridge.payment.getOrder", async (orderId?: unknown) => {
      await bridgeLicenseReady;
      if (orderId !== undefined && typeof orderId !== "string") throw new Error("Bridge payment order ID must be a string.");
      return bridgeAccess.getPaymentOrder(orderId ?? "");
    }),
    vscode.commands.registerCommand("shuncode.bridge.openResource", async (value: unknown) => {
      const input = value && typeof value === "object" ? value as { path?: unknown; line?: unknown; column?: unknown; folder?: unknown } : {};
      if (typeof input.path !== "string") throw new Error("Bridge resource path is required.");
      const uri = bridgeWorkspaceUri(input.path);
      if (input.folder === true) {
        await vscode.commands.executeCommand("revealInExplorer", uri);
        return;
      }
      const line = typeof input.line === "number" && input.line > 0 ? input.line : 1;
      const column = typeof input.column === "number" && input.column > 0 ? input.column : 1;
      const position = new vscode.Position(line - 1, column - 1);
      await vscode.window.showTextDocument(uri, { preview: true, selection: new vscode.Range(position, position) });
    }),
    vscode.commands.registerCommand("shuncode.bridge.openDiff", async (value: unknown) => {
      const input = value && typeof value === "object" ? value as { diff?: unknown; path?: unknown } : {};
      if (typeof input.diff !== "string" || !input.diff.trim()) throw new Error("Bridge diff content is required.");
      const filePath = typeof input.path === "string" ? input.path : undefined;
      const snippet = bridgeDiffSnippet(input.diff, filePath);
      const before = await vscode.workspace.openTextDocument({ content: snippet.before });
      const after = await vscode.workspace.openTextDocument({ content: snippet.after });
      await vscode.commands.executeCommand("vscode.diff", before.uri, after.uri, `${filePath ?? "Bridge edit"} · Before ↔ After`, { preview: true });
    }),
    vscode.commands.registerCommand(MANAGED_TERMINAL_OPEN_COMMAND, async (terminalId: unknown) => {
      if (typeof terminalId !== "string" || !terminalId) throw new Error("Managed terminal id is required.");
      if (!ideToolBroker.revealTerminal(terminalId)) {
        await vscode.window.showInformationMessage("That ShunCode terminal is no longer available.");
      }
    }),
    vscode.commands.registerCommand("shuncode.bridge.configure", async (domain: unknown) => {
      await bridgeReady;
      if (typeof domain !== "string") throw new Error("Bridge ngrok domain must be a string.");
      return bridge.configure(domain);
    }),
    vscode.commands.registerCommand("shuncode.bridge.configureCurrentRouteRelay", async (value?: unknown) => {
      const input = value && typeof value === "object" && !Array.isArray(value)
        ? value as { relayUrl?: unknown; secret?: unknown }
        : {};
      const currentRelayUrl = configuredCurrentRouteRelayUrl();
      const relayUrl = typeof input.relayUrl === "string"
        ? input.relayUrl.trim()
        : (await vscode.window.showInputBox({
            title: "Nimora Current Route Relay",
            prompt: "Stable Relay base URL including /r/<stable-path-token>, for example https://nimora-current-route.<account>.workers.dev/r/<stable-path-token>",
            value: currentRelayUrl,
            ignoreFocusOut: true,
          }))?.trim();
      if (!relayUrl) throw new Error("Current Route relay URL is required.");
      const secret = typeof input.secret === "string"
        ? input.secret
        : await vscode.window.showInputBox({
            title: "Nimora Current Route Relay",
            prompt: "Relay update secret (stored only in VS Code SecretStorage)",
            password: true,
            ignoreFocusOut: true,
          });
      if (!secret) throw new Error("Current Route relay update secret is required.");
      await vscode.workspace.getConfiguration("shuncode").update(
        CURRENT_ROUTE_RELAY_URL_SETTING,
        relayUrl,
        vscode.ConfigurationTarget.Global,
      );
      await context.secrets.store(CURRENT_ROUTE_RELAY_SECRET_KEY, secret);
      currentRouteRelayClient = undefined;
      currentRouteRelayClientKey = "";
      const client = await relayClient();
      const sync = await enqueueCurrentRouteRelaySync("relay-configured", true);
      const status = {
        configured: true,
        relayUrl,
        stableMcpUrl: sync?.stableMcpUrl ?? client?.getStableMcpUrl(),
        targetUrl: sync?.targetUrl,
        generation: sync?.generation,
      };
      void vscode.window.showInformationMessage(`Nimora Current Route relay configured: ${status.stableMcpUrl}`);
      return status;
    }),
    vscode.commands.registerCommand("shuncode.bridge.clearCurrentRouteRelay", async () => {
      await context.secrets.delete(CURRENT_ROUTE_RELAY_SECRET_KEY);
      await vscode.workspace.getConfiguration("shuncode").update(
        CURRENT_ROUTE_RELAY_URL_SETTING,
        undefined,
        vscode.ConfigurationTarget.Global,
      );
      currentRouteRelayClient = undefined;
      currentRouteRelayClientKey = "";
      lastCurrentRouteRelaySync = undefined;
      return { configured: false };
    }),
    vscode.commands.registerCommand("shuncode.bridge.getCurrentRouteRelayStatus", async () => ({
      configured: Boolean(configuredCurrentRouteRelayUrl()),
      relayUrl: configuredCurrentRouteRelayUrl() || undefined,
      stableMcpUrl: (await relayClient())?.getStableMcpUrl(),
      bindingToken: currentNativeMcpBindingToken,
      lastSync: lastCurrentRouteRelaySync,
    })),
    vscode.commands.registerCommand("shuncode.bridge.configureNamedTunnel", async (value: unknown) => {
      await bridgeReady;
      const input = value && typeof value === "object"
        ? value as { domain?: unknown; token?: unknown; localPort?: unknown }
        : {};
      if (typeof input.domain !== "string") throw new Error("Cloudflare Named Tunnel hostname must be a string.");
      if (input.token !== undefined && typeof input.token !== "string") throw new Error("Cloudflare Tunnel Token must be a string.");
      if (typeof input.localPort !== "number") throw new Error("Cloudflare Named Tunnel local port must be a number.");
      return bridge.configureNamedTunnel({
        domain: input.domain,
        token: input.token,
        localPort: input.localPort,
      });
    }),
    vscode.commands.registerCommand("shuncode.bridge.clearNamedTunnelToken", async () => {
      await bridgeReady;
      return bridge.clearNamedTunnelToken();
    }),
    vscode.commands.registerCommand("shuncode.bridge.setTunnelProvider", async (provider: unknown) => {
      await bridgeReady;
      if (typeof provider !== "string") throw new Error("Bridge tunnel provider must be a string.");
      return bridge.setTunnelProvider(provider);
    }),
    vscode.commands.registerCommand("shuncode.bridge.start", async (domain?: unknown) => {
      await Promise.all([bridgeReady, bridgeLicenseReady]);
      if (domain !== undefined && typeof domain !== "string") throw new Error("Bridge domain must be a string.");
      return bridgeAccess.start(domain as string | undefined);
    }),
    vscode.commands.registerCommand("shuncode.bridge.stop", async () => {
      await bridgeReady;
      return bridgeAccess.stop();
    }),
    vscode.commands.registerCommand("shuncode.bridge.checkNgrok", async () => {
      await bridgeReady;
      return bridge.checkNgrok();
    }),
    vscode.commands.registerCommand("shuncode.bridge.checkTunnel", async () => {
      await bridgeReady;
      return bridge.checkTunnel();
    }),
    vscode.commands.registerCommand("shuncode.bridge.checkHealth", async () => {
      await bridgeReady;
      return bridge.checkHealth();
    }),
    vscode.commands.registerCommand("shuncode.bridge.clearActivityLog", async () => {
      await bridgeReady;
      return bridge.clearActivityLog();
    }),
    vscode.commands.registerCommand("shuncode.bridge.installCloudflared", async () => {
      await bridgeReady;
      const status = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Installing cloudflared for ShunCode Bridge…",
        cancellable: false,
      }, () => bridge.installCloudflared());
      void vscode.window.showInformationMessage(`cloudflared is ready: ${status.tunnelVersion ?? "installed"}`);
      return status;
    }),
    vscode.commands.registerCommand("shuncode.bridge.rotateEndpoint", async () => {
      await bridgeReady;
      return bridge.rotateEndpoint();
    }),
    vscode.commands.registerCommand("_shuncode.worker.web.createSession", async (value: unknown) => {
      await webWorkerReady;
      const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const taskId = typeof input.taskId === "string" && input.taskId.trim() ? input.taskId : undefined;
      const options: WebWorkerSessionOptions = {
        model: typeof input.model === "string" ? input.model : undefined,
        workspaceRoot: typeof input.workspaceRoot === "string" ? input.workspaceRoot : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        contextHandle: typeof input.contextHandle === "string" ? input.contextHandle : undefined,
        transport: input.transport && typeof input.transport === "object" && !Array.isArray(input.transport) ? input.transport as Record<string, unknown> : undefined,
      };
      return webWorkerSessions.createSession("nimora.web-worker", options, taskId);
    }),
    vscode.commands.registerCommand("_shuncode.worker.web.run", async (value: unknown) => {
      await webWorkerReady;
      const input = value && typeof value === "object" ? value as { managedSessionId?: unknown; input?: unknown } : {};
      if (typeof input.managedSessionId !== "string" || !input.managedSessionId) throw new Error("Web worker managedSessionId is required.");
      if (!input.input || typeof input.input !== "object" || Array.isArray(input.input)) throw new Error("Web worker input is required.");
      const workerInput = input.input as Partial<WorkerInput>;
      if (typeof workerInput.inputId !== "string" || !workerInput.inputId) throw new Error("Web worker inputId is required.");
      if (typeof workerInput.prompt !== "string" || !workerInput.prompt.trim()) throw new Error("Web worker prompt is required.");
      const releaseGate = resolveWebWorkerReleaseGate(
        vscode.workspace.getConfiguration("shuncode.webWorker").get<boolean>("hostManagedCapabilities", false),
        vscode.workspace.isTrusted,
      );
      const effectiveWorkerInput = applyWebWorkerReleaseGate(workerInput as WorkerInput, releaseGate);
      const hostManagedCapabilities = releaseGate.effective;
      const events = [];
      for await (const event of webWorkerSessions.send(input.managedSessionId, effectiveWorkerInput)) {
        events.push(event);
        if (!hostManagedCapabilities || event.type !== "capability_call" || event.dispatch !== "host-requested") continue;
        const executionId = typeof event.extensions?.executionId === "string" ? event.extensions.executionId : "";
        if (!executionId) throw new Error("Host-requested Web worker capability is missing Nimora executionId.");
        const occurrenceId = typeof event.extensions?.occurrenceId === "string" && event.extensions.occurrenceId.trim()
          ? event.extensions.occurrenceId
          : undefined;
        if (!event.callId) throw new Error("Host-requested Web worker capability is missing callId.");
        const session = webWorkerSessions.getSession(input.managedSessionId);
        if (!session) throw new Error("Host-managed Web worker session disappeared during execution.");
        if (!session.taskId) throw new Error("Host-managed Web worker execution requires a bound Task.");
        await dispatchHostCapabilityRequest(hostCapabilityExecution, {
          executionId,
          managedSessionId: session.managedSessionId,
          workerId: session.workerId,
          taskId: session.taskId,
          inputId: event.inputId,
          callId: event.callId,
          name: event.name,
          arguments: event.arguments,
          occurrenceId,
        }, webWorkerSessions);
      }
      return { events, session: webWorkerSessions.getSession(input.managedSessionId) };
    }),
    vscode.commands.registerCommand("_shuncode.worker.web.interrupt", async (managedSessionId: unknown) => {
      await webWorkerReady;
      if (typeof managedSessionId !== "string" || !managedSessionId) throw new Error("Web worker managedSessionId is required.");
      await webWorkerSessions.interrupt(managedSessionId);
      return webWorkerSessions.getSession(managedSessionId);
    }),
    vscode.commands.registerCommand("_shuncode.worker.web.submitCapabilityResult", async (value: unknown) => {
      await webWorkerReady;
      const input = value && typeof value === "object" ? value as { managedSessionId?: unknown; result?: unknown } : {};
      if (typeof input.managedSessionId !== "string" || !input.managedSessionId) throw new Error("Web worker managedSessionId is required.");
      if (!input.result || typeof input.result !== "object" || Array.isArray(input.result)) throw new Error("Web worker capability result is required.");
      const result = input.result as Partial<WorkerCapabilityResultInput>;
      if (typeof result.inputId !== "string" || !result.inputId) throw new Error("Web worker capability result inputId is required.");
      if (typeof result.name !== "string" || !result.name) throw new Error("Web worker capability result name is required.");
      await webWorkerSessions.submitCapabilityResult(input.managedSessionId, result as WorkerCapabilityResultInput);
      return { submitted: true };
    }),
    vscode.commands.registerCommand("_shuncode.worker.web.health", async (managedSessionId: unknown) => {
      await webWorkerReady;
      if (managedSessionId === undefined) return webWorkerSessions.healthWorker("nimora.web-worker");
      if (typeof managedSessionId !== "string" || !managedSessionId) throw new Error("Web worker managedSessionId must be a string.");
      return webWorkerSessions.health(managedSessionId);
    }),
    vscode.commands.registerCommand("_shuncode.worker.web.listSessions", async () => {
      await webWorkerReady;
      return webWorkerSessions.listSessions({ workerId: "nimora.web-worker" });
    }),
    vscode.commands.registerCommand("shuncode.webWorker.releaseStatus", async () => {
      await webWorkerReady;
      // Native keyboard access to the same reviewed Project actions. This
      // does not change the existing tool-ownership settings or their consent.
      if (await showReviewedWorkerOperations()) return;
      const configuration = vscode.workspace.getConfiguration("shuncode.webWorker");
      const gate = resolveWebWorkerReleaseGate(
        configuration.get<boolean>("hostManagedCapabilities", false),
        vscode.workspace.isTrusted,
      );
      const sessions = webWorkerSessions.listSessions({ workerId: "nimora.web-worker" });
      const healthRows = await Promise.all(sessions.map(async session => ({
        session,
        health: await webWorkerSessions.health(session.managedSessionId),
      })));
      const healthy = healthRows.filter(row => row.health.status === "healthy").length;
      const detail = [
        `Tool ownership: ${gate.ownership}`,
        `Experimental gate: ${gate.configured ? "enabled" : "disabled"}`,
        `Workspace trust: ${gate.workspaceTrusted ? "trusted" : "untrusted"}`,
        `Web Worker sessions: ${sessions.length} (${healthy} healthy)`,
      ].join("\n");
      const action = gate.configured ? "Use Page-Local Tools" : "Enable Host-Managed Tools";
      const selected = await vscode.window.showInformationMessage("Nimora Web AI Worker", { modal: true, detail }, action);
      if (selected !== action) return { gate, sessions: healthRows };
      if (!gate.configured) {
        const confirm = await vscode.window.showWarningMessage(
          "Enable experimental host-managed Web AI tools?",
          {
            modal: true,
            detail: "Web AI tool calls will be executed by Nimora's durable Task execution service. Risky capabilities still require separate user approval. You can switch back to page-local tools at any time.",
          },
          "Enable Experimental Mode",
        );
        if (confirm !== "Enable Experimental Mode") return { gate, sessions: healthRows };
        await configuration.update("hostManagedCapabilities", true, vscode.ConfigurationTarget.Global);
      } else {
        await configuration.update("hostManagedCapabilities", false, vscode.ConfigurationTarget.Global);
      }
      const updated = resolveWebWorkerReleaseGate(
        vscode.workspace.getConfiguration("shuncode.webWorker").get<boolean>("hostManagedCapabilities", false),
        vscode.workspace.isTrusted,
      );
      void vscode.window.showInformationMessage(`Nimora Web AI tool ownership: ${updated.ownership}.`);
      return { gate: updated, sessions: healthRows };
    }),
    vscode.commands.registerCommand("_shuncode.worker.web.dispose", async (managedSessionId: unknown) => {
      await webWorkerReady;
      if (typeof managedSessionId !== "string" || !managedSessionId) throw new Error("Web worker managedSessionId is required.");
      await webWorkerSessions.dispose(managedSessionId);
      return { disposed: true };
    }),
  );

  context.subscriptions.push({
    dispose: () => {
      void webWorkerReady.then(async () => {
        for (const session of webWorkerSessions.listSessions({ workerId: "nimora.web-worker" })) {
          await webWorkerSessions.dispose(session.managedSessionId).catch(error => {
            output.appendLine(`[extension] Web worker dispose failed: ${error instanceof Error ? error.message : String(error)}`);
          });
        }
      }).catch(() => undefined);
    },
  });

  output.appendLine("[extension] native Chat participant registered: shuncode.agent");
  output.appendLine("[extension] native Language Model provider registered: shuncode");
  output.appendLine("[extension] first-party modes registered: ShunCode Ask, ShunCode Plan, ShunCode Code");
  output.appendLine("[extension] IDE tool broker registered: list_directory, run_command, get_command_output, send_command_input, get_diagnostics, lsp");
  output.appendLine("[extension] Bridge registered: Streamable HTTP MCP + Cloudflare Quick/Named Tunnel + ngrok + report_progress");
  output.appendLine("[extension] Web WorkerSessionManager wiring enabled: WebMCP command transport → WebWorkerAdapter → Task bindings");
  const persistentBridgeStartupEnabled = vscode.workspace.getConfiguration("shuncode.bridge").get<boolean>("persistentMode", false);
  if (persistentBridgeStartupEnabled && vscode.workspace.workspaceFolders?.length) {
    output.appendLine("[extension] persistent Bridge startup enabled; starting Bridge without opening Chat");
    void Promise.all([bridgeReady, bridgeLicenseReady]).then(() => bridgeAccess.start()).then(
      (status) => output.appendLine(`[bridge] persistent startup ready state=${status.state}`),
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[bridge] persistent startup failed: ${message}`);
        void vscode.window.showErrorMessage(`Bridge automatic startup failed: ${message}`);
      },
    );
  } else if (persistentBridgeStartupEnabled) {
    output.appendLine("[extension] persistent Bridge startup skipped: no workspace folder is open");
  }
  if (process.env.SHUNCODE_TERMINAL_SMOKE === "1") {
    void ideToolBroker.runTerminalSmokeTest().then(
      (result) => output.appendLine(`[terminal-smoke] PASS\n${result}`),
      (error) => output.appendLine(`[terminal-smoke] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`),
    );
  }
  if (process.env.SHUNCODE_LSP_SMOKE === "1") {
    void ideToolBroker.runLspSmokeTest().then(
      (result) => output.appendLine(`[lsp-smoke] PASS\n${result}`),
      (error) => output.appendLine(`[lsp-smoke] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`),
    );
  }
  const phase11RecoverySentinel = vscode.workspace.workspaceFolders
    ?.map(folder => vscode.Uri.joinPath(folder.uri, ".build", "phase11-auto-recovery.once").fsPath)
    .find(candidate => existsSync(candidate)) ?? "";
  const phase11RecoveryFromSentinel = context.extensionMode === vscode.ExtensionMode.Development
    && !!phase11RecoverySentinel
    && existsSync(phase11RecoverySentinel);
  if (context.extensionMode === vscode.ExtensionMode.Development
    && (process.env.SHUNCODE_PHASE11_RECOVERY_SMOKE === "1" || phase11RecoveryFromSentinel)) {
    const phase11ProjectId = "e99a2c78-5c0c-4960-902e-1db309f10068";
    const phase11RootMissionId = "ba166044-c0b9-4017-8c02-508769d41396";
    const phase11CoordinatorMissionId = "41d5107e-b03c-406e-9cfa-50e2bd9f5175";
    const retiredCoordinatorPageSessionId = "107cf91e-6b62-4248-b479-88753a4e9e30";
    const retiredTargetLifecycleIdentity = "8edc7426f36e6efc0633bebb1eb768ef7ef0b2013e0416b4e18bd060c691ac4f";
    const assignedSessionId = (outcome: Awaited<ReturnType<typeof missionWorkProduction.application.assignInitialWorker>>): string => {
      if (outcome.state === "assigned") return outcome.assignment.managedSessionId;
      if (outcome.state === "already-assigned") return outcome.managedSessionId;
      throw new Error(`Phase 11 recovery assignment has no admissible candidate for ${outcome.missionId}.`);
    };
    const assignWithRetry = async (input: unknown) => {
      let last: Awaited<ReturnType<typeof missionWorkProduction.application.assignInitialWorker>> | undefined;
      for (let attempt = 1; attempt <= 45; attempt += 1) {
        try {
          last = await missionWorkProduction.application.assignInitialWorker(input);
          if (last.state !== "no-admissible-candidate") return last;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("command '_shuncode.") || !message.includes("not found")) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      throw new Error(`Phase 11 recovery assignment exhausted candidate wait: ${JSON.stringify(last)}`);
    };
    void (async () => {
      await productionWorkersReady;
      await missionWorkProduction.owners.tasks.initialize();
      const durableCurrentSessionId = (missionId: string): string => {
        const task = missionWorkProduction.owners.tasks.getTask(missionId);
        if (!task?.mission) throw new Error(`Phase 11 recovery Mission not found: ${missionId}`);
        const current = Object.values(task.workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt);
        if (current.length !== 1) {
          throw new Error(`Phase 11 recovery requires exactly one durable current Worker for ${missionId} (durable=${current.length}).`);
        }
        return current[0].managedSessionId;
      };
      const staleCoordinatorSessionId = durableCurrentSessionId(phase11CoordinatorMissionId);
      const staleTargetSessionId = durableCurrentSessionId(phase11RootMissionId);
      const browserBridgeExtension = vscode.extensions.getExtension("shuncode.shuncode-integrated-browser-bridge");
      if (!browserBridgeExtension) throw new Error("Phase 11 recovery requires shuncode.shuncode-integrated-browser-bridge.");
      await browserBridgeExtension.activate();
      let browserToolsReady = false;
      for (let attempt = 1; attempt <= 60; attempt += 1) {
        if (vscode.lm.tools.some(tool => tool.name === "list_browser_pages")) {
          browserToolsReady = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
      if (!browserToolsReady) throw new Error("Phase 11 recovery timed out waiting for list_browser_pages registration.");
      const readResources = async () => {
        const [webResources, chatGptResources] = await Promise.all([
          vscode.commands.executeCommand<Array<{ site?: string; ready?: boolean; nativeMcpBypass?: boolean; pageSessionId?: string }>>("_shuncode.webMcp.workerListResources"),
          vscode.commands.executeCommand<Array<{ lifecycleIdentity?: string; ready?: boolean }>>("_shuncode.chatgptWorker.listResources"),
        ]);
        return { webResources: webResources ?? [], chatGptResources: chatGptResources ?? [] };
      };
      const readResourcesEventually = async () => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= 60; attempt += 1) {
          try {
            return await readResources();
          } catch (error) {
            lastError = error;
            const message = error instanceof Error ? error.message : String(error);
            const transient = message.includes("shared-page list exceeded deadline")
              || (message.includes("command '_shuncode.") && message.includes("not found"));
            if (!transient) throw error;
            await new Promise(resolve => setTimeout(resolve, 1_000));
          }
        }
        throw lastError instanceof Error ? lastError : new Error(String(lastError));
      };
      const hasReadyDeepSeek = (resources: Awaited<ReturnType<typeof readResources>>): boolean =>
        resources.webResources.some(resource =>
          resource?.site === "deepseek"
          && resource?.ready === true
          && resource?.nativeMcpBypass !== true
          && resource?.pageSessionId !== retiredCoordinatorPageSessionId
        );
      const hasFreshReadyChatGpt = (resources: Awaited<ReturnType<typeof readResources>>): boolean =>
        resources.chatGptResources.some(resource =>
          typeof resource?.lifecycleIdentity === "string"
          && resource.lifecycleIdentity !== retiredTargetLifecycleIdentity
          && resource.ready === true
        );
      let resources = await readResourcesEventually();
      output.appendLine(`[phase11-recovery-smoke] resources-before-open ${JSON.stringify(resources)}`);
      if (!hasReadyDeepSeek(resources)) {
        await vscode.commands.executeCommand("workbench.action.browser.open", {
          url: "https://chat.deepseek.com/?nimora_phase11_r20_fresh_coordinator=20260928T2020",
        });
        output.appendLine("[phase11-recovery-smoke] opened genuinely fresh DeepSeek Integrated Browser tab; waiting for native Share with Agent consent");
      }
      if (!hasFreshReadyChatGpt(resources)) {
        await vscode.commands.executeCommand("workbench.action.browser.open", {
          url: "https://chatgpt.com/?nimora_phase11_r20_fresh_target=20260928T2020",
        });
        output.appendLine("[phase11-recovery-smoke] opened genuinely fresh ChatGPT Integrated Browser tab; waiting for native Share with Agent consent");
      }
      if (!hasReadyDeepSeek(resources) || !hasFreshReadyChatGpt(resources)) {
        void vscode.window.showInformationMessage("Phase 11 recovery: DeepSeek / ChatGPT 已打开。请分别点击地址栏旁的 Share with Agent；若弹出确认，请点 Allow。共享后会自动继续。");
      }
      while (!hasReadyDeepSeek(resources) || !hasFreshReadyChatGpt(resources)) {
        await new Promise(resolve => setTimeout(resolve, 1_000));
        resources = await readResourcesEventually();
      }
      output.appendLine(`[phase11-recovery-smoke] resources-after-open ${JSON.stringify(resources)}`);
      for (const recovery of [
        { missionId: phase11CoordinatorMissionId, managedSessionId: staleCoordinatorSessionId },
        { missionId: phase11RootMissionId, managedSessionId: staleTargetSessionId },
      ]) {
        try {
          await missionWorkProduction.application.recoverOrphanedAssignedWorker({
            projectId: phase11ProjectId,
            rootMissionId: phase11RootMissionId,
            missionId: recovery.missionId,
            managedSessionId: recovery.managedSessionId,
            reason: "phase11-r18-recovery-smoke-owner-death",
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("orphan recovery requires exactly one durable current Worker (durable=0)")) throw error;
          output.appendLine(`[phase11-recovery-smoke] stale session already retired: ${recovery.managedSessionId}`);
        }
      }
      const coordinator = await assignWithRetry({
        projectId: phase11ProjectId,
        rootMissionId: phase11RootMissionId,
        missionId: phase11CoordinatorMissionId,
        constraints: {
          allowedProviders: ["deepseek"],
          requiredCapabilities: { capabilityRequests: true },
        },
      });
      const target = await assignWithRetry({
        projectId: phase11ProjectId,
        rootMissionId: phase11RootMissionId,
        missionId: phase11RootMissionId,
        constraints: { allowedProviders: ["openai-chatgpt"] },
      });
      const targetManagedSessionId = assignedSessionId(target);
      const capability = await missionWorkProduction.capability.materialize({
        projectId: phase11ProjectId,
        rootMissionId: phase11RootMissionId,
        missionId: phase11RootMissionId,
        managedSessionId: targetManagedSessionId,
        budget: { maxSchemaChars: 100_000 },
        constraints: { requiredCapabilityIds: ["workspace.read-files", "workspace.apply-patch"] },
      });
      const binding = await missionNativeMcp.prepareAdvertisement({
        projectId: capability.projectId,
        rootMissionId: capability.rootMissionId,
        missionId: capability.missionId,
        managedSessionId: capability.managedSessionId,
        capability,
      });
      await bridgeReady;
      if (bridge.getStatus().state !== "running") {
        await bridgeLicenseReady;
        await bridgeAccess.start();
      }
      const urls = bridge.getMissionNativeMcpUrls(binding.token);
      output.appendLine(`[phase11-recovery-smoke] READY ${JSON.stringify({
        pid: process.pid,
        runtimeIncarnationId: vscode.env.sessionId,
        coordinator,
        target,
        binding,
        urls,
      })}`);
    })().catch(error => {
      output.appendLine(`[phase11-recovery-smoke] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    }).finally(() => {
      if (phase11RecoveryFromSentinel && phase11RecoverySentinel) {
        try {
          unlinkSync(phase11RecoverySentinel);
          output.appendLine("[phase11-recovery-smoke] one-shot sentinel consumed");
        } catch (error) {
          output.appendLine(`[phase11-recovery-smoke] could not remove one-shot sentinel: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    });
  }
  const bridgeSmokeDomain = process.env.SHUNCODE_BRIDGE_SMOKE_DOMAIN?.trim();
  const bridgeLocalSmoke = process.env.SHUNCODE_BRIDGE_SMOKE_LOCAL === "1";
  if (bridgeSmokeDomain || bridgeLocalSmoke) {
    void Promise.all([bridgeReady, bridgeLicenseReady]).then(() => bridgeLocalSmoke ? bridge.startLocalSmoke() : bridgeAccess.start(bridgeSmokeDomain)).then(
      (status) => output.appendLine(`[bridge-smoke] READY local=${status.localUrl ?? "missing"} public=${status.publicUrl ?? "missing"}`),
      (error) => output.appendLine(`[bridge-smoke] FAIL ${error instanceof Error ? error.stack ?? error.message : String(error)}`),
    );
  }
  void vscode.chat.getCustomAgents(customAgentDiscoveryCts.token).then(
    (agents) => output.appendLine(`[extension] custom agents discovered: ${agents.map((agent) => agent.name).join(", ") || "none"}`),
    (error) => output.appendLine(`[extension] custom agent discovery failed: ${error instanceof Error ? error.message : String(error)}`),
  );
}

export async function deactivate(): Promise<void> {
  const bridge = activeBridge;
  activeBridge = undefined;
  if (bridge) await bridge.disposeAsync();
}
