import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-exact-recovery-workers-'));
try {
  const compiled = path.join(temp, 'exact-page.cjs');
  await esbuild.build({ entryPoints: [path.join(root, 'extensions/shuncode/src/nimora-reviewed-worker-takeover.ts')],
    outfile: compiled, bundle: true, platform: 'node', format: 'cjs', target: 'es2022', logLevel: 'silent' });
  const { prepareExactFreshDeepSeekWorkers, inspectUnboundDeepSeekPages } = require(compiled);
  const pageId = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
  const resource = (number, digest, ready = true) => ({ pageId: pageId(number), resourceIdentity: digest.repeat(64),
    origin: 'https://chat.deepseek.com', site: 'deepseek', nativeMcpBypass: false, sessionIdentityCompatible: true, ready });
  const make = observation => ({ candidateId: `webmcp:${observation.resourceIdentity}`, provider: 'deepseek', kind: 'web',
    availability: observation.ready ? 'available' : 'unavailable', health: { status: observation.ready ? 'healthy' : 'degraded' } });
  let listed = [resource(1, 'a')]; // Old, already-answered ambiguous Cognition page.
  let opened = 0;
  let sent = 0;
  const source = { enumerateCandidates: async () => listed.map(make) };
  const host = {
    listResources: async () => listed,
    openAndShareNewPage: async () => { opened++; listed.push(resource(opened + 1, opened === 1 ? 'b' : 'c')); return { shared: true, pageId: pageId(opened + 1) }; },
    wait: async () => {},
    send: async () => { sent++; throw new Error('PROVIDER_SEND_MUST_NOT_BE_CALLED'); },
  };
  const allowed = await prepareExactFreshDeepSeekWorkers(source, host, () => {}, { attempts: 1 });
  assert.deepEqual(allowed, [
    { pageId: pageId(2), candidateId: `webmcp:${'b'.repeat(64)}` },
    { pageId: pageId(3), candidateId: `webmcp:${'c'.repeat(64)}` },
  ]);
  assert.equal(opened, 2, 'only two newly created, native-approved pages');
  assert.equal(sent, 0, 'snapshot and binding preparation must never contact the provider');
  assert.ok(allowed.every(entry => entry.pageId !== pageId(1)), 'the ambiguous old planning page is excluded regardless of readiness');
  let freshThree = [], openedThree = 0;
  const threeSource = { enumerateCandidates: async () => freshThree.map(make) };
  const threeHost = { listResources: async () => freshThree,
    openAndShareNewPage: async () => {
      openedThree++;
      const row = resource(openedThree + 20, ['d','e','f'][openedThree - 1]);
      freshThree.push(row);
      return { shared: true, pageId: row.pageId };
    }, wait: async () => {} };
  const three = await prepareExactFreshDeepSeekWorkers(threeSource, threeHost, () => {}, { count: 3, attempts: 1 });
  assert.equal(openedThree, 3); assert.equal(new Set(three.map(row => row.candidateId)).size, 3);
  assert.deepEqual(three.map(row => row.pageId), freshThree.map(row => row.pageId));

  let openedBeforeReadFailure = 0;
  await assert.rejects(() => prepareExactFreshDeepSeekWorkers(source, {
    listResources: async () => { throw new Error('read-only native discovery failed'); },
    openAndShareNewPage: async () => { openedBeforeReadFailure++; return { shared: true, pageId: pageId(9) }; }, wait: async () => {},
  }), /read-only native discovery failed/);
  assert.equal(openedBeforeReadFailure, 0, 'unreadable baseline never authorizes opening a page');

  await assert.rejects(() => prepareExactFreshDeepSeekWorkers(source, {
    listResources: async () => [resource(1, 'a')],
    openAndShareNewPage: async () => ({ shared: true, pageId: pageId(1) }), wait: async () => {},
  }), /原生浏览器未能证明/, 'an old page cannot be relabeled as a fresh page');

  await assert.rejects(() => prepareExactFreshDeepSeekWorkers(source, {
    listResources: async () => [resource(1, 'a')],
    openAndShareNewPage: async () => undefined, wait: async () => {},
  }), /原生浏览器未能证明/, 'a legacy native browser without exact page identity fails closed');

  let firstOpen = 0;
  let onlyOldAndNew = [resource(1, 'a')];
  const savedApprovals = [];
  await assert.rejects(() => prepareExactFreshDeepSeekWorkers({ enumerateCandidates: async () => onlyOldAndNew.map(make) }, {
    listResources: async () => onlyOldAndNew,
    openAndShareNewPage: async () => {
      firstOpen++;
      onlyOldAndNew.push(resource(firstOpen + 1, firstOpen === 1 ? 'b' : 'c', firstOpen !== 2));
      return { shared: true, pageId: pageId(firstOpen + 1) };
    },
    wait: async () => {},
  }, () => {}, { attempts: 2, intervalMs: 1, onNativePageApproved: async ids => { savedApprovals.push([...ids]); } }), /尚未形成可核实的健康 Worker/);
  assert.equal(firstOpen, 2, 'an unready second page cannot authorize a third implicit fallback');
  assert.deepEqual(savedApprovals, [[pageId(2)], [pageId(2), pageId(3)]],
    'exact native approval IDs survive readiness timeout, before any assignment');
  onlyOldAndNew = onlyOldAndNew.map(row => ({ ...row, ready: true,
    href: row.pageId === pageId(1) ? 'https://chat.deepseek.com/a/chat/s/old' : 'https://chat.deepseek.com/', workerTurnState: 'idle' }));
  const resumed = await inspectUnboundDeepSeekPages({ enumerateCandidates: async () => onlyOldAndNew.map(make) }, {
    listResources: async () => onlyOldAndNew,
  });
  assert.deepEqual(resumed, allowed, 'late-ready shared pages can be selected without opening replacements or reading old chats');
  assert.equal(firstOpen, 2);
  assert.equal(sent, 0);
  for (const alteration of [{ workerTurnState: 'running' }, { ready: false }, { nativeMcpBypass: true },
    { sessionIdentityCompatible: false }, { href: 'https://chat.deepseek.com/?new=1' }]) {
    const unsafe = [{ ...onlyOldAndNew[1], ...alteration }];
    assert.deepEqual(await inspectUnboundDeepSeekPages({ enumerateCandidates: async () => unsafe.map(make) }, {
      listResources: async () => unsafe,
    }), [], 'busy, unready, incompatible and conversation-ambiguous pages are never recovery choices');
  }

  const native = await fs.readFile(path.join(root, 'src/vs/workbench/contrib/browserView/electron-browser/features/browserTabManagementFeatures.ts'), 'utf8');
  const action = native.slice(native.indexOf('class NimoraOpenAndShareProviderPageAction'), native.indexOf('class OpenFileInIntegratedBrowserAction'));
  assert.match(action, /exactIdentity === true && shared === true/, 'native pageId only after real explicit share consent');
  assert.match(action, /pageId !== editor\.id/, 'native identity must agree with the exact opened editor');
  assert.doesNotMatch(action, /activeEditor/, 'tab switching cannot redirect native page consent');
  const extension = await fs.readFile(path.join(root, 'extensions/shuncode/src/extension.ts'), 'utf8');
  assert.match(extension, /assignInitialWorker\([\s\S]*?exactCandidateId: approved\[0\]\.candidateId/, 'Coordinator must bind the first exact fresh candidate');
  assert.match(extension, /exactCandidateId: approved\[1\]\.candidateId/, 'Target must bind a different newly approved candidate');
  assert.match(extension, /phase: "mission-unknown"/, 'unknown first Mission result must durably forbid resubmission');
  assert.match(extension, /liveReviewedTakeovers\.get\(projectId\)/, 'a reboot must not manufacture live Worker ownership from saved strings');
  console.log('PASS reviewed Worker takeover: two exact new native-shared pages, old page excluded, no send, no automatic fallback, strict existing-Project scope');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
