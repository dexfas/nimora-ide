import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-conversation-lifecycle-'));
const bundlePath = path.join(bundleDirectory, 'worker-conversation-lifecycle.mjs');

await esbuild.build({
  entryPoints: [path.join(root, 'src', 'worker-conversation-lifecycle.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['es2022'],
  logLevel: 'silent',
});

const lifecycle = await import(pathToFileURL(bundlePath).href + '?v=' + Date.now());
const providerLifecycle = createRequire(import.meta.url)(path.join(root, 'extensions', 'shuncode-webmcp', 'conversation-lifecycle.js'));

try {
  const budget = { approachingChars: 100, rotationChars: 160, approachingTurns: 4, rotationTurns: 6 };
  const normal = lifecycle.classifyWorkerConversationCapacity(
    { sessionObservedChars: 50, sessionTurnCount: 2 },
    { budget, checkedAt: '2026-09-28T00:00:00.000Z' },
  );
  assert.equal(normal.state, 'normal');
  assert.equal(normal.coverage, 'since-session-attach');

  const approaching = lifecycle.classifyWorkerConversationCapacity(
    { sessionObservedChars: 120, sessionTurnCount: 3 },
    { budget },
  );
  assert.equal(approaching.state, 'approaching-limit');
  assert.ok(approaching.evidence.includes('nimora-approaching-char-budget'));

  const rotate = lifecycle.classifyWorkerConversationCapacity(
    { sessionObservedChars: 80, sessionTurnCount: 6 },
    { budget },
  );
  assert.equal(rotate.state, 'rotation-required');
  assert.ok(rotate.evidence.includes('nimora-rotation-turn-budget'));

  const visibleFloor = lifecycle.classifyWorkerConversationCapacity(
    { sessionObservedChars: 20, providerVisibleCharsFloor: 170, sessionTurnCount: 1 },
    { budget },
  );
  assert.equal(visibleFloor.state, 'rotation-required');
  assert.equal(visibleFloor.observedChars, 170);
  assert.equal(visibleFloor.coverage, 'combined');

  const providerExhausted = lifecycle.classifyWorkerConversationCapacity(
    { providerErrorText: 'This conversation is too long. Please start a new chat.' },
    { budget },
  );
  assert.equal(providerExhausted.state, 'exhausted');
  assert.equal(providerExhausted.providerExplicitLimit, true);

  const unknown = lifecycle.classifyWorkerConversationCapacity({}, { budget });
  assert.equal(unknown.state, 'unknown');

  assert.equal(
    lifecycle.decideWorkerConversationLifecycle({
      capacity: approaching,
      knownSettled: true,
      handoffReady: false,
      replacementAttached: false,
      retired: false,
      providerCleanupComplete: false,
    }).action,
    'prepare-handoff',
  );
  assert.equal(
    lifecycle.decideWorkerConversationLifecycle({
      capacity: rotate,
      knownSettled: false,
      handoffReady: true,
      replacementAttached: false,
      retired: false,
      providerCleanupComplete: false,
    }).action,
    'wait-for-settlement',
    'capacity replacement must never turn UNKNOWN into retry authority',
  );
  const replaceDecision = lifecycle.decideWorkerConversationLifecycle({
    capacity: rotate,
    knownSettled: true,
    handoffReady: true,
    replacementAttached: false,
    retired: false,
    providerCleanupComplete: false,
  });
  assert.equal(replaceDecision.action, 'retire-worker');
  assert.equal(replaceDecision.retryAuthorized, false);
  const replacementDecision = lifecycle.decideWorkerConversationLifecycle({
    capacity: rotate,
    knownSettled: true,
    handoffReady: true,
    replacementAttached: false,
    retired: true,
    providerCleanupComplete: false,
  });
  assert.equal(replacementDecision.action, 'replace-worker');
  assert.equal(replacementDecision.retryAuthorized, false);

  const chatGptSnapshot = [
    'Page Title: ChatGPT',
    'URL: https://chatgpt.com/c/conversation-123',
    'Snapshot:',
    '- heading "You said:" [level=4] [ref=user-1]',
    '  - paragraph: hello',
    '- heading "ChatGPT said:" [level=4] [ref=assistant-1]',
    '  - paragraph: world',
  ].join('\n');
  const chatGptInspection = providerLifecycle.inspectProviderSnapshot({ readPageText: chatGptSnapshot });
  assert.equal(chatGptInspection.provider, 'chatgpt');
  assert.equal(chatGptInspection.conversationId, 'conversation-123');
  assert.equal(chatGptInspection.providerVisibleTurnMarkers, 2);

  const deepSeekLimitSnapshot = [
    'Page Title: DeepSeek',
    'URL: https://chat.deepseek.com/a/chat/s/deepseek-456',
    'Snapshot:',
    '- generic: 上下文已达到上限，请新建对话',
  ].join('\n');
  const deepSeekInspection = providerLifecycle.inspectProviderSnapshot({ readPageText: deepSeekLimitSnapshot });
  assert.equal(deepSeekInspection.provider, 'deepseek');
  assert.equal(deepSeekInspection.conversationId, 'deepseek-456');
  assert.equal(deepSeekInspection.providerExplicitLimit, true);

  function createFakeBrowser(sequence) {
    const reads = [...sequence];
    const clicks = [];
    return {
      clicks,
      async readPage() {
        assert.ok(reads.length, 'unexpected extra read');
        return reads.shift();
      },
      async clickElement(pageId, ref, element) {
        clicks.push({ pageId, ref, element });
      },
    };
  }

  const chatGptArchiveBrowser = createFakeBrowser([
    [
      'Page Title: ChatGPT',
      'URL: https://chatgpt.com/c/archive-me',
      'Snapshot:',
      '- button "Conversation options" [ref=menu]',
    ].join('\n'),
    [
      'Page Title: ChatGPT',
      'URL: https://chatgpt.com/c/archive-me',
      'Snapshot:',
      '- menuitem "Archive" [ref=archive]',
      '- menuitem "Delete" [ref=delete]',
    ].join('\n'),
    'Page Title: ChatGPT\nURL: https://chatgpt.com/\nSnapshot:\n- textbox "Message ChatGPT" [ref=composer]',
  ]);
  const archived = await providerLifecycle.runProviderConversationCleanup(chatGptArchiveBrowser, {
    provider: 'chatgpt',
    pageId: 'page-chatgpt',
    conversationId: 'archive-me',
    mode: 'archive-preferred',
  });
  assert.deepEqual(chatGptArchiveBrowser.clicks.map(call => call.ref), ['menu', 'archive']);
  assert.equal(archived.state, 'archived');
  assert.equal(archived.verified, true);

  const deepSeekDeleteBrowser = createFakeBrowser([
    [
      'Page Title: DeepSeek',
      'URL: https://chat.deepseek.com/a/chat/s/delete-me',
      'Snapshot:',
      '- button "更多" [ref=more]',
    ].join('\n'),
    [
      'Page Title: DeepSeek',
      'URL: https://chat.deepseek.com/a/chat/s/delete-me',
      'Snapshot:',
      '- menuitem "删除对话" [ref=delete-action]',
    ].join('\n'),
    [
      'Page Title: DeepSeek',
      'URL: https://chat.deepseek.com/a/chat/s/delete-me',
      'Snapshot:',
      '- dialog "确认删除"',
      '  - button "删除" [ref=confirm-delete]',
    ].join('\n'),
    'Page Title: DeepSeek\nURL: https://chat.deepseek.com/\nSnapshot:\n- textbox [ref=composer]',
  ]);
  const deleted = await providerLifecycle.runProviderConversationCleanup(deepSeekDeleteBrowser, {
    provider: 'deepseek',
    pageId: 'page-deepseek',
    conversationId: 'delete-me',
    mode: 'archive-preferred',
  });
  assert.deepEqual(deepSeekDeleteBrowser.clicks.map(call => call.ref), ['more', 'delete-action', 'confirm-delete']);
  assert.equal(deleted.state, 'deleted');

  const ambiguous = [
    'Page Title: ChatGPT',
    'URL: https://chatgpt.com/c/ambiguous',
    'Snapshot:',
    '- button "More" [ref=more-1]',
    '- button "More" [ref=more-2]',
  ].join('\n');
  assert.throws(
    () => providerLifecycle.cleanupPlanStep(ambiguous, 'archive-preferred', 'initial'),
    /ambiguous/,
  );

  const wrongConversationBrowser = createFakeBrowser([
    'Page Title: ChatGPT\nURL: https://chatgpt.com/c/other\nSnapshot:\n- button "Conversation options" [ref=menu]',
  ]);
  await assert.rejects(
    () => providerLifecycle.runProviderConversationCleanup(wrongConversationBrowser, {
      provider: 'chatgpt',
      pageId: 'page-chatgpt',
      conversationId: 'expected',
      mode: 'archive-preferred',
    }),
    /different provider conversation identity/,
  );

  console.log('ShunCode Worker conversation lifecycle smoke: PASS');
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
