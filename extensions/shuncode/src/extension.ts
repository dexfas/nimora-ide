import * as vscode from "vscode";
import { BridgeAccessController } from "./bridge-access-controller.js";
import { BridgeLicenseService } from "./bridge-license-service.js";
import { BridgeManager } from "./bridge-server.js";
import { configureShunCodeModel, setShunCodeApiKey } from "./config.js";
import { codexAuthManager, onCodexAuthChange } from "./codex-auth.js";
import { BranchStateStore } from "./branch-state.js";
import { registerShunCodeCustomAgents } from "./custom-agents.js";
import { IdeToolBroker } from "./ide-tool-broker.js";
import { ShunCodeLanguageModelProvider } from "./model-provider.js";
import { registerShunCodeNativeChat } from "./native-chat.js";
import { RuntimeClient } from "./runtime-client.js";
import { TaskShadowRecorder } from "./task-shadow.js";
import { WebMcpCommandTransport } from "./webmcp-worker-transport.js";
import { WebWorkerAdapter, type WebWorkerSessionOptions } from "../../../src/web-worker-adapter.js";
import { WorkerSessionManager } from "../../../src/worker-session-manager.js";
import type { WorkerInput } from "../../../src/worker-contract.js";

let activeBridge: BridgeManager | undefined;

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
  const taskShadow = new TaskShadowRecorder(context, output);
  const webWorkerSessions = new WorkerSessionManager({ taskBindings: taskShadow });
  const webWorkerTransport = new WebMcpCommandTransport({
    executeCommand: <T>(command: string, ...args: unknown[]) => vscode.commands.executeCommand<T>(command, ...args),
  });
  const webWorkerAdapter = new WebWorkerAdapter(webWorkerTransport);
  const webWorkerReady = webWorkerSessions.register(webWorkerAdapter).then(descriptor => {
    output.appendLine(`[extension] Web worker registered: ${descriptor.id} via ${descriptor.provider}`);
    return descriptor;
  }, error => {
    output.appendLine(`[extension] Web worker registration failed: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  });
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
  const bridge = new BridgeManager(context, output, ideToolBroker, taskShadow, authorizeBridgeStart);
  const bridgeAccess = new BridgeAccessController(bridgeLicense, bridge, output);
  activeBridge = bridge;
  const bridgeReady = bridge.initialize();
  const bridgeLicenseReady = bridgeLicense.initialize();
  const runtime = new RuntimeClient(context, output, ideToolBroker);
  const apiModelProvider = new ShunCodeLanguageModelProvider(context, "api");
  const codexModelProvider = new ShunCodeLanguageModelProvider(context, "codex");
  const branchStore = new BranchStateStore(context, output);
  const participant = registerShunCodeNativeChat(context, runtime, output, {
    shuncode: apiModelProvider,
    "shuncode-codex": codexModelProvider,
  }, branchStore, taskShadow);
  const customAgents = registerShunCodeCustomAgents(context);
  const customAgentDiscoveryCts = new vscode.CancellationTokenSource();

  context.subscriptions.push(
    output,
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
      await vscode.commands.executeCommand("_shuncode.bridge.showChat");
    }),
    vscode.commands.registerCommand("shuncode.bridge.openSession", async () => {
      await vscode.commands.executeCommand("workbench.action.chat.open");
      await vscode.commands.executeCommand("_shuncode.bridge.showSession");
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
    vscode.commands.registerCommand("shuncode.bridge.openTerminal", async (terminalId: unknown) => {
      if (typeof terminalId !== "string" || !terminalId) throw new Error("Bridge terminal id is required.");
      if (!ideToolBroker.revealTerminal(terminalId)) {
        await vscode.window.showInformationMessage("That ShunCode terminal is no longer available.");
      }
    }),
    vscode.commands.registerCommand("shuncode.bridge.configure", async (domain: unknown) => {
      await bridgeReady;
      if (typeof domain !== "string") throw new Error("Bridge ngrok domain must be a string.");
      return bridge.configure(domain);
    }),
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
      const status = await bridgeAccess.start(domain as string | undefined);
      await vscode.commands.executeCommand("workbench.action.chat.open");
      await vscode.commands.executeCommand("_shuncode.bridge.showSession");
      return status;
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
      const events = [];
      for await (const event of webWorkerSessions.send(input.managedSessionId, workerInput as WorkerInput)) events.push(event);
      return { events, session: webWorkerSessions.getSession(input.managedSessionId) };
    }),
    vscode.commands.registerCommand("_shuncode.worker.web.interrupt", async (managedSessionId: unknown) => {
      await webWorkerReady;
      if (typeof managedSessionId !== "string" || !managedSessionId) throw new Error("Web worker managedSessionId is required.");
      await webWorkerSessions.interrupt(managedSessionId);
      return webWorkerSessions.getSession(managedSessionId);
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
  if (vscode.workspace.getConfiguration("shuncode.bridge").get<boolean>("persistentMode", false)) {
    output.appendLine("[extension] persistent Bridge mode enabled; opening Chat and waiting for the rendered view to start Bridge");
    setTimeout(() => {
      void vscode.commands.executeCommand("workbench.action.chat.open").then(undefined, (error) => {
        output.appendLine(`[extension] failed to open Chat for persistent Bridge mode: ${error instanceof Error ? error.message : String(error)}`);
      });
    }, 100);
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
