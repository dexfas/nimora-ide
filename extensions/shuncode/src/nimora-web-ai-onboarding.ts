import * as vscode from "vscode";
import type { WorkerAssignmentCandidate, WorkerAssignmentCandidateSource } from "../../../src/worker-assignment.js";

export type NimoraWebAiProvider = "deepseek" | "chatgpt";

const PROVIDERS = {
  deepseek: { label: "DeepSeek", url: "https://chat.deepseek.com", candidateProvider: "deepseek" },
  chatgpt: { label: "ChatGPT", url: "https://chatgpt.com", candidateProvider: "openai-chatgpt" },
} as const;

export function isNimoraWebAiProvider(value: unknown): value is NimoraWebAiProvider {
  return value === "deepseek" || value === "chatgpt";
}

export interface WebAiOnboardingHost {
  activateBridge(): Promise<void>;
  openIntegratedPage(url: string): Promise<void>;
  /** Undefined means the host build predates the native consent action. */
  requestNativeShare(provider: NimoraWebAiProvider): Promise<boolean | undefined>;
  promptManualShare(provider: NimoraWebAiProvider): Promise<void>;
  wait(ms: number): Promise<void>;
}

export function vscodeWebAiOnboardingHost(): WebAiOnboardingHost {
  let nativeShareOutcome: boolean | undefined;
  return {
    async activateBridge() {
      const extension = vscode.extensions.getExtension("shuncode.shuncode-integrated-browser-bridge");
      if (!extension) throw new Error("内置浏览器 Bridge 不可用；无法连接网页 Worker。");
      await extension.activate();
    },
    async openIntegratedPage(url) {
      const provider = (Object.keys(PROVIDERS) as NimoraWebAiProvider[]).find(key => PROVIDERS[key].url === url);
      if (!provider) throw new Error("Nimora only opens allowlisted web AI origins.");
      nativeShareOutcome = undefined;
      // The workbench command creates and shares one EXACT browser page via
      // native consent. The old host only opens it; manual share is required.
      const command = "workbench.action.browser.nimoraOpenAndShareProviderPage";
      if ((await vscode.commands.getCommands()).includes(command)) {
        nativeShareOutcome = await vscode.commands.executeCommand<boolean | undefined>(command, provider);
      } else {
        await vscode.commands.executeCommand("workbench.action.browser.open", { url });
      }
    },
    async requestNativeShare(_provider) {
      return nativeShareOutcome;
    },
    async promptManualShare(provider) {
      // A toast hides the native BrowserView and can prevent the very login or
      // share interaction we are waiting for. Keep this legacy-host hint in the
      // status bar; native sharing consent remains unchanged.
      vscode.window.setStatusBarMessage(`Nimora：${PROVIDERS[provider].label} 页面已打开；请完成登录并「分享给 Agent」，正在等待连接。`, 120_000);
    },
    wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); },
  };
}

function readyCandidate(provider: NimoraWebAiProvider, candidates: readonly WorkerAssignmentCandidate[]): WorkerAssignmentCandidate | undefined {
  return candidates.find(candidate => candidate.provider === PROVIDERS[provider].candidateProvider
    && candidate.kind === "web" && candidate.availability === "available" && candidate.health?.status === "healthy");
}

export type WebAiOnboardingResult =
  | { state: "ready"; provider: NimoraWebAiProvider; reused: boolean; candidate: WorkerAssignmentCandidate }
  | { state: "awaiting-user-share"; provider: NimoraWebAiProvider; detail: string }
  | { state: "sharing-declined"; provider: NimoraWebAiProvider };

export interface WebAiPreparationObservation {
  phase: "discovering" | "opening" | "checking";
  provider: NimoraWebAiProvider;
  required: number;
  healthy: number;
  observed: number;
  attemptsRemaining: number;
}

/**
 * User-initiated product assembly over existing Phase-7 observation sources.
 * Opens a page, delegates sharing to native browser consent, then reobserves
 * fresh candidate truth. Never creates a Mission, claims ownership, or sends.
 */
export async function prepareNimoraWebAi(
  provider: NimoraWebAiProvider,
  source: WorkerAssignmentCandidateSource,
  host: WebAiOnboardingHost = vscodeWebAiOnboardingHost(),
  options: {
    attempts?: number;
    intervalMs?: number;
    minReady?: number;
    /** Overall bound, in addition to the independent discovery command timeout. */
    maxWaitMs?: number;
    onProgress?: (progress: WebAiPreparationObservation) => void;
  } = {},
): Promise<WebAiOnboardingResult> {
  await host.activateBridge();
  const minReady = Math.max(1, Math.min(3, options.minReady ?? 1));
  // Bound automated discovery time, not the Human's deliberate login/share
  // consent interval (the native browser remains the authority for consent).
  let deadline = Date.now() + Math.max(1, Math.min(300_000, options.maxWaitMs ?? 120_000));
  const attempts = Math.max(1, Math.min(20, options.attempts ?? 12));
  const intervalMs = Math.max(1, Math.min(10_000, options.intervalMs ?? 2_000));
  let lastError: unknown;
  let opened = false;
  const relevant = (candidates: readonly WorkerAssignmentCandidate[]) => candidates.filter(candidate => candidate.provider === PROVIDERS[provider].candidateProvider && candidate.kind === "web");
  const healthy = (candidates: readonly WorkerAssignmentCandidate[]) => candidates.filter(candidate => candidate.availability === "available" && candidate.health?.status === "healthy");
  const notify = (phase: WebAiPreparationObservation["phase"], candidates: readonly WorkerAssignmentCandidate[], attemptsRemaining: number) =>
    options.onProgress?.({ phase, provider, required: minReady, healthy: healthy(candidates).length, observed: candidates.length, attemptsRemaining });
  // Discovery errors are not proof that the user has no existing shared pages.
  // Fail closed rather than opening duplicates when the existing inventory is unreadable.
  notify("discovering", [], attempts);
  let observed: WorkerAssignmentCandidate[];
  try { observed = relevant(await source.enumerateCandidates()); }
  catch (error) {
    return { state: "awaiting-user-share", provider, detail: `无法读取已共享网页资源，未新增网页：${error instanceof Error ? error.message : String(error)}` };
  }
  notify("checking", observed, attempts);
  if (healthy(observed).length >= minReady) return { state: "ready", provider, reused: true, candidate: healthy(observed)[0] };
  // Count existing but temporarily degraded pages too. Three already-open shared
  // pages must never trigger a fourth page just because a composer was unready.
  for (let required = Math.max(1, healthy(observed).length + 1); required <= minReady; required += 1) {
    if (Date.now() >= deadline) break;
    if (observed.length < required) {
      notify("opening", observed, attempts);
      const consentStartedAt = Date.now();
      try {
        await host.openIntegratedPage(PROVIDERS[provider].url);
        opened = true;
        const sharing = await host.requestNativeShare(provider);
        if (sharing === false) return { state: "sharing-declined", provider };
        if (sharing === undefined) await host.promptManualShare(provider);
      } finally {
        deadline += Date.now() - consentStartedAt;
      }
    }
    let reached = false;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (Date.now() >= deadline) break;
      if (attempt > 0) await host.wait(Math.min(intervalMs, Math.max(1, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      try {
        observed = relevant(await source.enumerateCandidates());
        notify("checking", observed, attempts - attempt - 1);
        if (healthy(observed).length >= required) {
          if (healthy(observed).length >= minReady) return { state: "ready", provider, reused: !opened, candidate: healthy(observed)[0] };
          reached = true;
          break;
        }
      } catch (error) {
        lastError = error;
        notify("checking", observed, attempts - attempt - 1);
      }
    }
    if (!reached) break;
  }
  const expired = Date.now() >= deadline;
  const detail = `只发现 ${healthy(observed).length}/${minReady} 个健康网页 Worker，已观测到 ${observed.length} 个共享候选。${expired ? "已到达整体等待时限并停止检测。" : ""}${lastError instanceof Error ? `最近的发现错误：${lastError.message}。` : "部分页面可能未完成共享或就绪检查。"}未发送规划请求或创建 Project；请检查 Connections 中的错误与网页授权。`;
  return { state: "awaiting-user-share", provider, detail };
}
