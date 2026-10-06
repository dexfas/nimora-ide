import type { WorkerAssignmentCandidate, WorkerAssignmentCandidateSource } from "../../../src/worker-assignment.js";

const RESOURCE_ID = /^[a-f0-9]{64}$/;
const PAGE_ID = /^[0-9a-f-]{16,80}$/i;

export interface FreshDeepSeekPageHost {
  /** Read-only native shared-page observation, including the exact browser page ID. */
  listResources(): Promise<unknown>;
  /** This must open a NEW page and return its native identity only after consent. */
  openAndShareNewPage(): Promise<{ shared: true; pageId: string } | undefined>;
  wait(ms: number): Promise<void>;
}

interface ObservedResource {
  pageId: string;
  resourceIdentity: string;
  site: string;
  origin: string;
  ready: boolean;
  nativeMcpBypass: boolean;
  sessionIdentityCompatible: boolean;
  href?: string;
  workerTurnState?: string;
}

function resources(value: unknown): ObservedResource[] {
  if (!Array.isArray(value) || value.length > 32) throw new Error("网页清单无法完整读取，拒绝创建新的接管页面。");
  return value.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("网页清单含无效资源。");
    const observed = row as Record<string, unknown>;
    if (typeof observed.pageId !== "string" || !PAGE_ID.test(observed.pageId)
      || typeof observed.resourceIdentity !== "string" || !RESOURCE_ID.test(observed.resourceIdentity)
      || typeof observed.site !== "string" || typeof observed.origin !== "string"
      || typeof observed.ready !== "boolean" || typeof observed.nativeMcpBypass !== "boolean"
      || typeof observed.sessionIdentityCompatible !== "boolean") throw new Error("网页清单身份或就绪证据不完整。");
    return observed as unknown as ObservedResource;
  });
}

/**
 * Preserve the old, potentially ambiguous Cognition page as an excluded baseline.
 * A candidate may be used only when its exact native pageId was minted by the
 * just-invoked, consent-verified native action AND matches fresh WebMCP truth.
 * No page content, credentials, old provider transcript or send operation is read.
 */
export async function prepareExactFreshDeepSeekWorkers(
  source: Pick<WorkerAssignmentCandidateSource, "enumerateCandidates">,
  host: FreshDeepSeekPageHost,
  onProgress: (message: string) => void = () => {},
  options: { attempts?: number; intervalMs?: number; count?: 1 | 2 | 3; onNativePageApproved?: (pageIds: readonly string[]) => Promise<void> } = {},
): Promise<readonly { pageId: string; candidateId: string }[]> {
  const initial = resources(await host.listResources());
  const initialPageIds = new Set(initial.map(row => row.pageId));
  const initialResourceIds = new Set(initial.map(row => row.resourceIdentity));
  if (initialPageIds.size !== initial.length || initialResourceIds.size !== initial.length) {
    throw new Error("原有网页清单的身份不唯一，拒绝启动接管。");
  }
  const approved: { pageId: string; candidateId: string }[] = [];
  const nativePageIds: string[] = [];
  const count = options.count ?? 2;
  for (let index = 0; index < count; index++) {
    onProgress(`请求全新 DeepSeek 网页 ${index + 1}/${count} 的原生共享授权`);
    const newlyOpened = await host.openAndShareNewPage();
    if (!newlyOpened || newlyOpened.shared !== true || typeof newlyOpened.pageId !== "string"
      || !PAGE_ID.test(newlyOpened.pageId) || initialPageIds.has(newlyOpened.pageId)
      || approved.some(row => row.pageId === newlyOpened.pageId)) {
      throw new Error("原生浏览器未能证明新网页的唯一身份及共享授权；没有分配 Worker 或发送消息。");
    }
    nativePageIds.push(newlyOpened.pageId);
    // Save consent provenance even when login/readiness outlasts this poll.
    await options.onNativePageApproved?.([...nativePageIds]);
    const attempts = Math.max(1, Math.min(12, options.attempts ?? 8));
    let accepted: { pageId: string; candidateId: string } | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt) await host.wait(Math.max(1, Math.min(5_000, options.intervalMs ?? 1_500)));
      onProgress(`检查新网页 ${index + 1}/${count} 的精确身份与就绪状态（${attempt + 1}/${attempts}）`);
      const inventory = resources(await host.listResources());
      const matches = inventory.filter(row => row.pageId === newlyOpened.pageId);
      if (matches.length > 1) throw new Error("新浏览器页面出现多个身份记录，停止接管。");
      if (!matches.length) continue;
      const resource = matches[0];
      if (initialResourceIds.has(resource.resourceIdentity)
        || approved.some(row => row.candidateId === `webmcp:${resource.resourceIdentity}`)) {
        throw new Error("新页面的资源身份与已有或已选页面冲突，停止接管。");
      }
      if (resource.origin !== "https://chat.deepseek.com" || resource.site !== "deepseek"
        || resource.nativeMcpBypass || !resource.sessionIdentityCompatible) {
        throw new Error("新页面不是身份一致的 DeepSeek WebMCP 资源，停止接管。");
      }
      if (!resource.ready) continue;
      const candidates = await source.enumerateCandidates();
      const exact = candidates.filter(candidate => candidate.candidateId === `webmcp:${resource.resourceIdentity}`
        && candidate.provider === "deepseek" && candidate.kind === "web"
        && candidate.availability === "available" && candidate.health?.status === "healthy");
      if (exact.length !== 1) continue;
      accepted = { pageId: newlyOpened.pageId, candidateId: exact[0].candidateId };
      break;
    }
    if (!accepted) throw new Error(`新网页 ${index + 1}/${count} 尚未形成可核实的健康 Worker；已保留页面供人工查看，不能盲目继续分配。`);
    approved.push(accepted);
  }
  if (approved.length !== count || new Set(approved.map(page => page.candidateId)).size !== count) throw new Error("接管未确认全部独立网页。");
  return approved;
}

/** Read-only choices for explicit recovery BEFORE any Worker assignment/send.
 * Re-observation is not replay: only shared, healthy, empty-chat URLs qualify.
 * The caller must ask the Human to choose each exact role and then recheck.
 */
export async function inspectUnboundDeepSeekPages(
  source: Pick<WorkerAssignmentCandidateSource, "enumerateCandidates">,
  host: Pick<FreshDeepSeekPageHost, "listResources">,
): Promise<readonly { pageId: string; candidateId: string }[]> {
  const inventory = resources(await host.listResources());
  if (new Set(inventory.map(row => row.pageId)).size !== inventory.length
    || new Set(inventory.map(row => row.resourceIdentity)).size !== inventory.length) {
    throw new Error("共享网页身份不唯一，不能继续绑定。");
  }
  const candidates = await source.enumerateCandidates();
  return inventory.filter(row => {
    if (row.site !== "deepseek" || row.origin !== "https://chat.deepseek.com"
      || !row.ready || row.nativeMcpBypass || !row.sessionIdentityCompatible
      || (row.workerTurnState !== undefined && row.workerTurnState !== "" && row.workerTurnState !== "idle")) return false;
    try {
      const url = new URL(row.href ?? "");
      return url.origin === row.origin && url.pathname === "/" && !url.search && !url.hash;
    } catch { return false; }
  }).flatMap(row => {
    const exact = candidates.filter(candidate => candidate.candidateId === `webmcp:${row.resourceIdentity}`
      && candidate.provider === "deepseek" && candidate.kind === "web"
      && candidate.availability === "available" && candidate.health?.status === "healthy");
    return exact.length === 1 ? [{ pageId: row.pageId, candidateId: exact[0].candidateId }] : [];
  });
}
