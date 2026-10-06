import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const {
  collectObservedResources,
  deferredResultIdFromText,
  invokeWithDeadline,
  runDeferredPlaywrightObservation,
} = require(path.join(root, 'extensions', 'shuncode-webmcp', 'bounded-browser-tool.js'));

const textOf = result => Array.isArray(result?.content) ? result.content.map(part => part?.value ?? '').join('\n') : String(result ?? '');
const toolResult = text => ({ content: [{ value: text }] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let cancelled = false;
const invokeStartedAt = Date.now();
await assert.rejects(
  () => invokeWithDeadline(() => new Promise(() => {}), 25, () => { cancelled = true; }, 'never-settling browser tool'),
  /never-settling browser tool exceeded deadline \(25ms\)/,
);
assert.equal(cancelled, true, 'deadline owner must actually cancel/stop waiting');
assert.ok(Date.now() - invokeStartedAt < 1000);

const deferredCalls = [];
const deferredObservation = await runDeferredPlaywrightObservation({
  pageId: 'page-deferred-A',
  code: 'return { href: location.href };',
  totalMs: 200,
  perAttemptMs: 50,
  resultText: textOf,
  invoke: async (name, input) => {
    deferredCalls.push({ name, input: structuredClone(input) });
    if (input.code) return toolResult('[deferredResultId=deferred-A] still running');
    assert.equal(input.deferredResultId, 'deferred-A');
    return toolResult('Result: {"href":"https://chat.deepseek.com/"}');
  },
});
assert.equal(deferredObservation.executionCount, 1, 'deferred continuation must never execute observation code twice');
assert.equal(deferredObservation.deferredResultId, 'deferred-A');
assert.equal(deferredCalls.length, 2);
assert.equal(typeof deferredCalls[0].input.code, 'string');
assert.equal(deferredCalls[1].input.code, undefined);
assert.equal(deferredCalls[1].input.deferredResultId, 'deferred-A');

const stuckCalls = [];
const stuckStartedAt = Date.now();
await assert.rejects(
  () => runDeferredPlaywrightObservation({
    pageId: 'page-stuck',
    code: 'return 1;',
    totalMs: 35,
    perAttemptMs: 8,
    toolOverheadMs: 2,
    resultText: textOf,
    invoke: async (_name, input) => {
      stuckCalls.push(structuredClone(input));
      await sleep(3);
      return toolResult('[deferredResultId=stuck-A] pending');
    },
  }),
  /page observation exceeded total deadline \(35ms\).*deferredResultId=stuck-A/,
);
assert.ok(Date.now() - stuckStartedAt < 1000);
assert.equal(stuckCalls.filter(call => typeof call.code === 'string').length, 1, 'UNKNOWN/deferred observation must never rerun code');
assert.ok(stuckCalls.slice(1).every(call => call.deferredResultId === 'stuck-A'));

let changedCall = 0;
await assert.rejects(
  () => runDeferredPlaywrightObservation({
    pageId: 'page-changed-deferred',
    code: 'return 1;',
    totalMs: 100,
    perAttemptMs: 20,
    resultText: textOf,
    invoke: async () => toolResult(`[deferredResultId=${++changedCall === 1 ? 'A' : 'B'}] pending`),
  }),
  /deferred Playwright identity changed from A to B/,
);

const failurePages = [];
const inventoryStartedAt = Date.now();
await assert.rejects(
  () => collectObservedResources({
    pages: [{ pageId: 'healthy' }, { pageId: 'stalled' }, { pageId: 'never-reached' }],
    totalMs: 80,
    perPageMs: 25,
    observe: async page => page.pageId === 'healthy' ? { pageId: page.pageId } : new Promise(() => {}),
    onFailure: page => failurePages.push(page.pageId),
  }),
  /resource discovery failed for shared page stalled.*exceeded deadline/,
);
assert.ok(Date.now() - inventoryStartedAt < 1000, 'one stalled shared page must not hang inventory forever');
assert.deepEqual(failurePages, ['stalled']);

const stalePages = [];
const staleTolerantInventory = await collectObservedResources({
  pages: [{ pageId: 'stale' }, { pageId: 'healthy' }],
  totalMs: 100,
  perPageMs: 40,
  observe: async page => {
    if (page.pageId === 'stale') throw new Error('Page "stale" not found');
    return { pageId: page.pageId };
  },
  shouldSkipFailure: (_page, error) => /Page \"[^\"]+\" not found/.test(error instanceof Error ? error.message : String(error)),
  onSkipped: page => stalePages.push(page.pageId),
});
assert.deepEqual(staleTolerantInventory, [{ pageId: 'healthy' }], 'definitively stale pages must not poison healthy resource discovery');
assert.deepEqual(stalePages, ['stale']);

await assert.rejects(
  () => collectObservedResources({
    pages: [{ pageId: 'stalled-only' }],
    totalMs: 40,
    perPageMs: 20,
    observe: async () => new Promise(() => {}),
    shouldSkipFailure: () => false,
  }),
  /resource discovery failed for shared page stalled-only.*exceeded deadline/,
  'ambiguous observation failures must remain fail-closed',
);

const successfulInventory = await collectObservedResources({
  pages: [{ pageId: 'one' }, { pageId: 'two' }],
  totalMs: 100,
  perPageMs: 40,
  observe: async page => ({ pageId: page.pageId }),
});
assert.deepEqual(successfulInventory, [{ pageId: 'one' }, { pageId: 'two' }]);

// Three independent read-only browser observations must fit one wall-clock
// budget; sequential 35ms * 3 would exceed this 85ms budget.
const parallelStartedAt = Date.now();
const parallelInventory = await collectObservedResources({
  pages: [{ pageId: 'first' }, { pageId: 'second' }, { pageId: 'third' }],
  totalMs: 85,
  perPageMs: 70,
  concurrency: 3,
  observe: async page => { await sleep(35); return { pageId: page.pageId }; },
});
assert.deepEqual(parallelInventory, [{ pageId: 'first' }, { pageId: 'second' }, { pageId: 'third' }],
  'parallel observations still materialize in stable source page order');
assert.ok(Date.now() - parallelStartedAt < 85, 'read-only observations must share one wall-clock budget');

let parallelActive = 0;
let peakParallel = 0;
await assert.rejects(() => collectObservedResources({
  pages: [{ pageId: 'a' }, { pageId: 'ambiguous' }, { pageId: 'c' }, { pageId: 'd' }],
  totalMs: 140,
  perPageMs: 90,
  concurrency: 3,
  observe: async page => {
    parallelActive += 1;
    peakParallel = Math.max(peakParallel, parallelActive);
    await sleep(7);
    parallelActive -= 1;
    if (page.pageId === 'ambiguous') throw new Error('probe failed ambiguously');
    return { pageId: page.pageId };
  },
}), /failed for shared page ambiguous.*probe failed ambiguously/);
assert.equal(peakParallel, 3, 'concurrency is explicitly bounded even under failure');

const concurrentStale = await collectObservedResources({
  pages: [{ pageId: 'slow' }, { pageId: 'missing' }, { pageId: 'fast' }],
  totalMs: 120,
  perPageMs: 90,
  concurrency: 3,
  observe: async page => {
    if (page.pageId === 'missing') throw new Error('Page "missing" not found');
    if (page.pageId === 'slow') await sleep(15);
    return { pageId: page.pageId };
  },
  shouldSkipFailure: (_page, error) => /not found/.test(String(error)),
});
assert.deepEqual(concurrentStale, [{ pageId: 'slow' }, { pageId: 'fast' }],
  'only definitively stale pages may be skipped, without reordering observed survivors');
assert.equal(deferredResultIdFromText('[deferredResultId=A]'), 'A');

const extensionSource = await fs.readFile(path.join(root, 'extensions', 'shuncode-webmcp', 'extension.js'), 'utf8');
const candidateSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'webmcp-worker-candidate-source.ts'), 'utf8');
assert.match(extensionSource, /if \(shouldBypassWebMcp\(page\?\.url\)\) return workerPageResources\.normalizeBypassResource\(page\)/, 'ChatGPT/native MCP pages must bypass Playwright WebMCP observation');
assert.match(extensionSource, /runDeferredInternalBrowserOperation/);
assert.match(extensionSource, /deferred identity changed from/);
assert.equal(extensionSource.includes('runDeferredPlaywrightObservation'), false, 'production discovery must use the fixed internal browser seam, not arbitrary-code LM execution');
assert.match(extensionSource, /collectObservedResources/);
assert.match(extensionSource, /concurrency: 3/, 'live multi-page discovery must opt into bounded concurrent read-only observations');
assert.match(extensionSource, /\(\) => cts\.cancel\(\)/, 'built-in browser deadline must own a real cancellation action');
assert.match(extensionSource, /\[web-mcp:worker-discovery\] skipped stale page=/, 'definitively missing shared pages must be logged when omitted from discovery');
assert.match(candidateSource, /awaitCommandWithin/);
assert.match(candidateSource, /"WebMCP worker resource discovery"/);
assert.match(candidateSource, /\$\{label\} exceeded deadline/);

console.log(JSON.stringify({
  result: 'PASS',
  neverSettlingBuiltinBoundedAndCancelled: true,
  sameDeferredIdReused: true,
  observationExecutionCount: 1,
  deferredNeverCompletesBounded: true,
  changedDeferredIdentityRejected: true,
  oneStalledPageFailsInventoryExplicitly: true,
  staleMissingPageSkippedWithoutPoisoningHealthyInventory: true,
  ambiguousFailureStillFailsClosed: true,
  successfulInventoryCompatible: true,
  threeConcurrentReadOnlyPagesShareWallClockBudget: true,
  parallelAmbiguityStillFailsClosed: true,
  chatGptNativeBypassPreserved: true,
}, null, 2));
