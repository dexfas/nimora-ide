import { randomUUID } from 'node:crypto';
import type { WorkerAssignmentCandidateSource } from '../../../src/worker-assignment.js';
import type { WorkerSessionManager } from '../../../src/worker-session-manager.js';

export const WEB_AI_CONNECTION_CHECK_PROMPT = '网页连通性诊断：请只回复“连接正常”。不要调用工具，不执行任务，不读写文件。';
export interface WebAiConnectionCheckReceipt {
  pageId: string;
  inputId: string;
  state: 'consumed-no-replay';
  status: 'reserved' | 'sending' | 'completed' | 'failed';
  observedAt: string;
  managedSessionId?: string;
  text?: string;
  error?: string;
}

/** Product diagnostics use the existing candidate/Worker owners, never a
 * Mission, a global tool list or a direct browser control backdoor. Keep the
 * dedicated session owned even on failure: idle is not settlement authority.
 */
export async function checkWebAiConnection(
  source: WorkerAssignmentCandidateSource, workers: WorkerSessionManager,
  selection: { candidateId: string; pageId: string },
  assertAllowed: (pageId: string, adapterSessionId?: string) => Promise<void>,
  checkpoint: (receipt: WebAiConnectionCheckReceipt) => Promise<void>,
): Promise<WebAiConnectionCheckReceipt> {
  const candidate = (await source.enumerateCandidates()).find(row => row.candidateId === selection.candidateId);
  if (!candidate || candidate.workerId !== 'nimora.web-worker' || candidate.provider !== 'deepseek'
    || candidate.kind !== 'web' || candidate.availability !== 'available' || candidate.health?.status !== 'healthy') {
    throw new Error('所选诊断网页不可用，没有发送。');
  }
  const fresh = await source.refreshCandidate(candidate);
  if (!fresh || fresh.candidateId !== candidate.candidateId || fresh.availability !== 'available' || fresh.health?.status !== 'healthy') {
    throw new Error('诊断网页身份或状态已改变，没有发送。');
  }
  const options = await source.materializeSessionOptions(fresh, {});
  const target = options.extensions?.webMcpTarget as { pageId?: string; pageSessionId?: string } | undefined;
  if (target?.pageId !== selection.pageId) throw new Error('诊断页不是审核的确切页面，没有发送。');
  await assertAllowed(selection.pageId, target.pageSessionId);
  let receipt: WebAiConnectionCheckReceipt = { pageId: selection.pageId, inputId: randomUUID(),
    state: 'consumed-no-replay', status: 'reserved', observedAt: new Date().toISOString() };
  // Durable reservation is conservative: an interrupted check is never replayed.
  await checkpoint(receipt);
  try {
    const session = await workers.createSession(candidate.workerId, options);
    receipt = { ...receipt, managedSessionId: session.managedSessionId };
    await checkpoint(receipt);
    if (session.taskId) throw new Error('诊断 Worker 已绑定任务，没有发送。');
    await assertAllowed(selection.pageId, session.adapterSessionId);
    receipt = { ...receipt, status: 'sending', observedAt: new Date().toISOString() };
    await checkpoint(receipt);
    // Recheck after storage awaits; never use a stale workflow review as authority.
    await assertAllowed(selection.pageId, session.adapterSessionId);
    let text = '';
    let completed = false;
    for await (const event of workers.send(session.managedSessionId, {
      inputId: receipt.inputId, prompt: WEB_AI_CONNECTION_CHECK_PROMPT,
      allowedCapabilities: [], externalCapabilities: [],
      extensions: { hostManagedCapabilities: true, noProgressTimeoutMs: 30_000 },
    })) {
      if (event.type === 'text_delta') text += event.text;
      if (text.length > 1_200) throw new Error('诊断回复超过范围，已停止，不会重发。');
      if (event.type === 'capability_call' || event.type === 'capability_result') throw new Error('诊断不允许任何工具调用，已停止。');
      if (event.type === 'terminal') {
        if (event.status !== 'completed') throw new Error(event.error || `诊断未完成：${event.status}`);
        const final = (event.result as { text?: unknown } | undefined)?.text;
        if (typeof final === 'string') text = final;
        completed = true;
      }
    }
    if (!completed || !text.trim() || text.length > 1_200) throw new Error('诊断没有获得完整且有界的网页回复。');
    receipt = { ...receipt, status: 'completed', text: text.trim(), observedAt: new Date().toISOString() };
    await checkpoint(receipt);
    return receipt;
  } catch (error) {
    receipt = { ...receipt, status: 'failed', error: String(error instanceof Error ? error.message : error).slice(0, 1_200), observedAt: new Date().toISOString() };
    // A failed presentation write must not replace the original execution error.
    await checkpoint(receipt).catch(() => undefined);
    throw error;
  }
}
