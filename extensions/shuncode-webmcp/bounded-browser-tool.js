'use strict';

function deferredResultIdFromText(text) {
  const match = String(text || '').match(/\[deferredResultId=([^\]]+)\]/);
  return match ? match[1].trim() : '';
}

async function invokeWithDeadline(factory, timeoutMs, onTimeout, label = 'Browser tool invocation') {
  const invocation = Promise.resolve().then(factory);
  invocation.catch(() => { /* timed-out work may settle after the caller stops waiting */ });
  let timer = null;
  try {
    return await Promise.race([
      invocation,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { onTimeout?.(); } catch { /* cancellation is best-effort */ }
          reject(new Error(`${label} exceeded deadline (${timeoutMs}ms).`));
        }, Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function collectObservedResources(options) {
  const pages = Array.isArray(options?.pages) ? options.pages : [];
  const observe = options?.observe;
  if (typeof observe !== 'function') throw new Error('Bounded resource discovery requires observe().');
  const now = typeof options?.now === 'function' ? options.now : Date.now;
  const totalMs = Math.max(1, Number(options?.totalMs) || 20000);
  const perPageMs = Math.max(1, Number(options?.perPageMs) || 12000);
  const deadline = now() + totalMs;
  // Opt-in only for read-only multi-page observation. Existing sequential
  // production consumers retain their established ordering by default.
  const concurrency = Math.max(1, Math.min(3, Math.floor(Number(options?.concurrency) || 1)));
  if (concurrency > 1) {
    // Admit in stable page order, even if slow page observations finish later.
    // A single ambiguous failure still fails the entire inventory closed;
    // successful partial results never masquerade as complete provider truth.
    const ordered = new Array(pages.length);
    let index = 0;
    let failure;
    await Promise.all(Array.from({ length: Math.min(concurrency, pages.length) }, async () => {
      while (index < pages.length) {
        const slot = index++;
        const page = pages[slot];
        const remaining = deadline - now();
        if (remaining <= 0) {
          if (!failure) failure = new Error(`WebMCP worker resource discovery exceeded total deadline (${totalMs}ms).`);
          return;
        }
        const budget = Math.max(1, Math.min(perPageMs, remaining));
        try {
          ordered[slot] = await invokeWithDeadline(() => observe(page, budget), budget, undefined,
            `WebMCP shared page observation ${page?.pageId || '<unknown>'}`);
        } catch (error) {
          options?.onFailure?.(page, error);
          if (typeof options?.shouldSkipFailure === 'function' && options.shouldSkipFailure(page, error) === true) {
            options?.onSkipped?.(page, error);
          } else if (!failure) {
            failure = new Error(`WebMCP worker resource discovery failed for shared page ${page?.pageId || '<unknown>'}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }));
    if (failure) throw failure;
    return ordered.filter(resource => resource !== undefined);
  }
  const resources = [];
  for (const page of pages) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`WebMCP worker resource discovery exceeded total deadline (${totalMs}ms).`);
    const pageBudget = Math.max(1, Math.min(perPageMs, remaining));
    try {
      const resource = await invokeWithDeadline(
        () => observe(page, pageBudget),
        pageBudget,
        undefined,
        `WebMCP shared page observation ${page?.pageId || '<unknown>'}`,
      );
      resources.push(resource);
    } catch (error) {
      options?.onFailure?.(page, error);
      if (typeof options?.shouldSkipFailure === 'function' && options.shouldSkipFailure(page, error) === true) {
        options?.onSkipped?.(page, error);
        continue;
      }
      throw new Error(`WebMCP worker resource discovery failed for shared page ${page?.pageId || '<unknown>'}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return resources;
}

async function runDeferredPlaywrightObservation(options) {
  const invoke = options?.invoke;
  if (typeof invoke !== 'function') throw new Error('Bounded Playwright observation requires invoke().');
  const pageId = String(options?.pageId || '').trim();
  const code = String(options?.code || '');
  if (!pageId) throw new Error('Bounded Playwright observation requires pageId.');
  if (!code) throw new Error('Bounded Playwright observation requires code.');
  const now = typeof options?.now === 'function' ? options.now : Date.now;
  const totalMs = Math.max(1, Number(options?.totalMs) || 12000);
  const perAttemptMs = Math.max(1, Number(options?.perAttemptMs) || 4000);
  const toolOverheadMs = Math.max(1, Number(options?.toolOverheadMs) || 1500);
  const deadline = now() + totalMs;
  let executionCount = 0;
  let expectedDeferredId = '';

  async function invokeWithinBudget(input) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(`WebMCP page observation exceeded total deadline (${totalMs}ms).${expectedDeferredId ? ` deferredResultId=${expectedDeferredId}` : ''}`);
    const waitMs = Math.max(1, Math.min(perAttemptMs, remaining));
    return invoke('run_playwright_code', { pageId, ...input, timeoutMs: waitMs }, Math.min(remaining, waitMs + toolOverheadMs));
  }

  let result = await invokeWithinBudget({ code });
  executionCount += 1;
  while (true) {
    const text = options.resultText(result);
    const deferredResultId = deferredResultIdFromText(text);
    if (!deferredResultId) return { result, executionCount, deferredResultId: expectedDeferredId || undefined };
    if (expectedDeferredId && deferredResultId !== expectedDeferredId) {
      throw new Error(`WebMCP deferred Playwright identity changed from ${expectedDeferredId} to ${deferredResultId}.`);
    }
    expectedDeferredId = deferredResultId;
    result = await invokeWithinBudget({ deferredResultId });
  }
}

module.exports = {
  collectObservedResources,
  deferredResultIdFromText,
  invokeWithDeadline,
  runDeferredPlaywrightObservation,
};
