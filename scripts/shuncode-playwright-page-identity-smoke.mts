import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const esbuild = require('esbuild');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-page-identity-'));
try {
  const outfile = path.join(temp, 'identity.cjs');
  await esbuild.build({ stdin: { contents: `
    export { PlaywrightSession } from './src/vs/platform/browserView/node/playwrightService.ts';
    export { CDPBrowserProxy } from './src/vs/platform/browserView/common/cdp/proxy.ts';
    export { Event, Emitter } from './src/vs/base/common/event.ts';
    export { findBrowserViewPagePair } from './src/vs/platform/browserView/node/playwrightPageIdentity.ts';
  `, resolveDir: root, loader: 'ts' }, outfile, bundle: true, platform: 'node', format: 'cjs',
    packages: 'external', logLevel: 'silent', plugins: [{ name: 'test-session-export', setup(build: any) {
      build.onLoad({ filter: /[\\/]playwrightService\.ts$/ }, async (args: any) => {
        if (!args.path.includes(`${path.sep}node${path.sep}`)) return undefined;
        return { contents: await fs.readFile(args.path, 'utf8') + '\nexport { PlaywrightSession };', loader: 'ts' };
      });
    } }] });
  const { PlaywrightSession, CDPBrowserProxy, Event, Emitter, findBrowserViewPagePair } = require(outfile);
  assert.deepEqual(findBrowserViewPagePair([{ targetId: 'A' }, { targetId: 'B' }], [{ targetId: 'B' }, { targetId: 'A' }]), { viewIndex: 0, pageIndex: 1 });
  assert.equal(findBrowserViewPagePair([{ targetId: 'A' }], [{}]), undefined);
  assert.throws(() => findBrowserViewPagePair([{ targetId: '' }], []), /no CDP target/);
  assert.throws(() => findBrowserViewPagePair([{ targetId: 'A' }, { targetId: 'A' }], [{ targetId: 'A' }]), /ambiguous/);
  assert.throws(() => findBrowserViewPagePair([{ targetId: 'A' }], [{ targetId: 'A' }, { targetId: 'A' }]), /ambiguous/);
  const info = (targetId: string, type = 'page') => ({ targetId, type, title: 'same title', url: 'https://same.example/chat', attached: true, canAccessOpener: false });
  const browserTarget = { targetInfo: info('browser', 'browser'), dispose() {} };
  const proxy = new CDPBrowserProxy(browserTarget);
  for (const targetId of ['A', 'B']) {
    const connection = { targetId, sessionId: 'session-' + targetId, onEvent: Event.None, onClose: Event.None, dispose() {} };
    proxy.registerTarget({ targetInfo: info(targetId), sessions: new Map([[connection.sessionId, connection]]),
      onClose: Event.None, onTargetInfoChanged: Event.None, onSessionCreated: Event.None, dispose() {} });
  }
  assert.equal((await proxy.sendCommand('Target.getTargetInfo', {}, 'session-A')).targetInfo.targetId, 'A');
  assert.equal((await proxy.sendCommand('Target.getTargetInfo', {}, 'session-B')).targetInfo.targetId, 'B');
  assert.equal((await proxy.sendCommand('Target.getTargetInfo')).targetInfo.type, 'browser');
  assert.equal((await proxy.sendCommand('Target.getTargetInfo', { targetId: 'B' })).targetInfo.targetId, 'B');
  await assert.rejects(() => proxy.sendCommand('Target.getTargetInfo', {}, 'unknown'), /Session not found/);
  proxy.dispose();

  const routingEvents: any[] = [];
  const routingProxy = new CDPBrowserProxy(browserTarget);
  const routingSub = routingProxy.onMessage((event: any) => routingEvents.push(event));
  await routingProxy.sendCommand('Target.attachToBrowserTarget');
  routingEvents.length = 0;
  await routingProxy.sendCommand('Target.setDiscoverTargets', { discover: true });
  const dynamicSession = {
    targetId: 'dynamic', sessionId: 'dynamic-session', parentSessionId: undefined,
    onEvent: Event.None, onClose: Event.None, async sendCommand() { return {}; }, dispose() {},
  };
  routingProxy.registerTarget({
    targetInfo: info('dynamic'), sessions: new Map([[dynamicSession.sessionId, dynamicSession]]),
    onClose: Event.None, onTargetInfoChanged: Event.None, onSessionCreated: Event.None,
    notifySessionCreated() {}, async attach() { return dynamicSession; }, dispose() {},
  });
  const dynamicCreated = routingEvents.find(event => event.method === 'Target.targetCreated');
  const dynamicAttached = routingEvents.find(event => event.method === 'Target.attachedToTarget' && event.params?.sessionId === dynamicSession.sessionId);
  assert.equal(dynamicCreated?.sessionId, undefined, 'root targetCreated must stay on the root CDP session after attachToBrowserTarget');
  assert.equal(dynamicAttached?.sessionId, undefined, 'root attachedToTarget must stay on the root CDP session after attachToBrowserTarget');
  routingSub.dispose(); routingProxy.dispose();

  const explicitEvents: any[] = [];
  const explicitSessionCreated = new Emitter();
  const explicitSessionClosed = new Emitter();
  let explicitDisposed = false;
  let explicitConnection: any;
  const explicitTarget = {
    targetInfo: info('explicit'), sessions: new Map(), onClose: Event.None, onTargetInfoChanged: Event.None,
    onSessionCreated: explicitSessionCreated.event, notifySessionCreated() {}, dispose() {},
    async attach() {
      explicitConnection = {
        targetId: 'explicit', sessionId: 'explicit-session', parentSessionId: undefined,
        onEvent: Event.None, onClose: explicitSessionClosed.event, async sendCommand() { return {}; },
        dispose() {
          if (explicitDisposed) return;
          explicitDisposed = true;
          explicitSessionClosed.fire();
        },
      };
      explicitSessionCreated.fire({ session: explicitConnection, waitingForDebugger: false });
      return explicitConnection;
    },
  };
  const explicitProxy = new CDPBrowserProxy(browserTarget);
  const explicitSub = explicitProxy.onMessage((event: any) => explicitEvents.push(event));
  explicitProxy.registerTarget(explicitTarget);
  const browserAttach = await explicitProxy.sendCommand('Target.attachToBrowserTarget') as { sessionId: string };
  explicitEvents.length = 0;
  await explicitProxy.sendCommand('Target.attachToTarget', { targetId: 'explicit', flatten: true }, browserAttach.sessionId);
  const explicitAttached = explicitEvents.find(event => event.method === 'Target.attachedToTarget' && event.params?.sessionId === 'explicit-session');
  assert.equal(explicitAttached?.sessionId, browserAttach.sessionId, 'explicit attachToTarget must preserve its caller session as the lifecycle parent');
  explicitEvents.length = 0;
  await explicitProxy.sendCommand('Target.detachFromTarget', { sessionId: 'explicit-session' }, browserAttach.sessionId);
  const explicitDetached = explicitEvents.find(event => event.method === 'Target.detachedFromTarget' && event.params?.sessionId === 'explicit-session');
  assert.equal(explicitDetached?.sessionId, browserAttach.sessionId, 'explicit auxiliary detach must not masquerade as a root page detach');
  explicitSub.dispose(); explicitProxy.dispose(); explicitSessionCreated.dispose(); explicitSessionClosed.dispose();
  function fakePage(targetId: string, delayed = false) {
    let release!: () => void;
    const ready = delayed ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
    const handlers = new Map<string, Function[]>();
    let detached = 0;
    const context = { on() {}, pages: () => [], newCDPSession: async () => ({ send: async () => { await ready; return { targetInfo: info(targetId) }; }, detach: async () => { detached++; } }) };
    const page: any = { url: () => 'https://same.example/chat', setDefaultTimeout() {},
      on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); return page; },
      once(name: string, fn: Function) { return page.on(name, fn); },
      consoleMessages: async () => [], pageErrors: async () => [],
      context: () => context,
    };
    return { page, release: () => release(), close: () => handlers.get('close')?.forEach(fn => fn()), detached: () => detached };
  }
  const errors: Error[] = [];
  const add = new Emitter();
  const session = new PlaywrightSession('test', { contexts: () => [], close: async () => {} },
    { onDidAddView: add.event, onDidRemoveView: Event.None, dispose() {} }, { activeCalls: 0 },
    { info() {}, debug() {}, error(error: Error) { errors.push(error); } }, {}, {}, async () => {});
  const a = fakePage('A', true), b = fakePage('B');
  const viewA = session._onViewAdded('view-A', 'A'), viewB = session._onViewAdded('view-B', 'B');
  const pageB = session._onPageAdded(b.page), pageA = session._onPageAdded(a.page);
  assert.equal(await viewB, b.page, 'B arrives first but must not bind A');
  assert.equal(await pageB, 'view-B');
  assert.equal(session._viewIdToPage.has('view-A'), false, 'missing identity must never use FIFO');
  a.release();
  assert.equal(await viewA, a.page);
  assert.equal(await pageA, 'view-A');
  const c = fakePage('C');
  const pageC = session._onPageAdded(c.page);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(await session._onViewAdded('view-C', 'C'), c.page);
  assert.equal(await pageC, 'view-C');
  const late = fakePage('late', true);
  const expired = session._onPageAdded(late.page, 20);
  await assert.rejects(() => expired, /Timed out waiting for browser view/);
  late.release();
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(session._pageQueue.some((entry: any) => entry.page === late.page), false);
  assert.equal(session._pageToViewId.get(late.page), undefined, 'late identity must not resurrect expired page');
  const closed = fakePage('closed', true);
  const removed = session._onPageAdded(closed.page, 20);
  closed.close(); closed.release();
  await assert.rejects(() => removed, /Timed out waiting for browser view/);
  assert.equal(session._pageToViewId.get(closed.page), undefined);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(a.detached(), 1); assert.equal(b.detached(), 1);
  assert.equal(late.detached(), 1); assert.equal(closed.detached(), 1);
  session.dispose(); add.dispose();
  console.log(JSON.stringify({ result: 'PASS', exactTargetMatching: true, reversedArrival: true, sameUrlDistinctTabs: true,
    pageFirst: true, viewFirst: true, noFifoFallback: true, pageSessionTargetInfo: true, unknownSessionRejected: true,
    rootTargetLifecycleRoutingAfterBrowserAttach: true,
    explicitAttachParentRoutingPreserved: true,
    lateIdentityAfterTimeoutIgnored: true, closedPageNotResurrected: true, identitySessionsDetached: true }));
} finally { await fs.rm(temp, { recursive: true, force: true }); }
