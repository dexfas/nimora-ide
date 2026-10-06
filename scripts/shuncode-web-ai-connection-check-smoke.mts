import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-connection-check-'));
try {
  const bundle = path.join(temp, 'check.cjs');
  await require('esbuild').build({ entryPoints: [path.join(root, 'extensions/shuncode/src/nimora-web-ai-connection-check.ts')],
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { checkWebAiConnection, WEB_AI_CONNECTION_CHECK_PROMPT } = require(bundle);
  const candidate = { candidateId: 'exact', workerId: 'nimora.web-worker', provider: 'deepseek', kind: 'web', availability: 'available', health: { status: 'healthy' } };
  function environment() {
    const calls = [], receipts = [];
    let failure, storageFailure, denied = false;
    const source = { enumerateCandidates: async () => [candidate], refreshCandidate: async () => candidate,
      materializeSessionOptions: async () => ({ extensions: { webMcpTarget: { pageId: 'spare', pageSessionId: 'native' } } }) };
    const workers = { createSession: async (id, options, taskId) => { assert.equal(taskId, undefined); calls.push('create');
      return { managedSessionId: 'diagnostic', adapterSessionId: 'native' }; },
      send: async function* (id, input) { calls.push('send'); assert.equal(id, 'diagnostic');
        assert.equal(receipts.at(-1).status, 'sending', 'identity is saved before send');
        assert.equal(input.inputId, receipts.at(-1).inputId); assert.equal(input.prompt, WEB_AI_CONNECTION_CHECK_PROMPT);
        assert.deepEqual(input.allowedCapabilities, []); assert.deepEqual(input.externalCapabilities, []);
        assert.equal(input.extensions.hostManagedCapabilities, true); assert.equal(input.extensions.noProgressTimeoutMs, 30_000);
        if (failure === 'tool') yield { type: 'capability_call', name: 'apply_patch' };
        else if (failure === 'transport') throw new Error('provider unavailable');
        else { yield { type: 'text_delta', text: '连接正常' }; yield { type: 'terminal', status: 'completed', result: { text: '连接正常' } }; }
      }, retire: () => { throw Error('unexpected retirement'); }, submitCapabilityResult: () => { throw Error('unexpected delivery'); } };
    const run = () => checkWebAiConnection(source, workers, { candidateId: 'exact', pageId: 'spare' },
      async () => { calls.push('assert'); if (denied) throw Error('owned page'); },
      async receipt => { if (storageFailure) throw Error('storage failed'); receipts.push(structuredClone(receipt)); });
    return { source, workers, calls, receipts, run, setFailure: value => { failure = value; }, setStorageFailure: () => { storageFailure = true; }, setDenied: () => { denied = true; } };
  }
  const ok = environment(); const result = await ok.run(); assert.equal(result.text, '连接正常');
  assert.equal(result.status, 'completed'); assert.equal(result.state, 'consumed-no-replay');
  assert.equal(ok.calls.filter(row => row === 'send').length, 1);
  for (const mode of ['tool', 'transport']) { const env = environment(); env.setFailure(mode);
    await assert.rejects(env.run); assert.equal(env.calls.filter(row => row === 'send').length, 1);
    assert.equal(env.receipts.at(-1).status, 'failed'); assert.equal(env.receipts.at(-1).state, 'consumed-no-replay'); }
  const storage = environment(); storage.setStorageFailure(); await assert.rejects(storage.run, /storage failed/);
  assert.equal(storage.calls.includes('create'), false); assert.equal(storage.calls.includes('send'), false);
  const owned = environment(); owned.setDenied(); await assert.rejects(owned.run, /owned page/); assert.equal(owned.calls.includes('create'), false);
  const changed = environment(); changed.source.refreshCandidate = async () => ({ ...candidate, candidateId: 'other' });
  await assert.rejects(changed.run, /身份/); assert.equal(changed.calls.includes('create'), false);
  const pageChanged = environment(); pageChanged.source.materializeSessionOptions = async () => ({ extensions: { webMcpTarget: { pageId: 'mission' } } });
  await assert.rejects(pageChanged.run, /确切页面/); assert.equal(pageChanged.calls.includes('send'), false);
  // Exercise the actual product callback, including durable ownership and
  // permission/storage awaits, rather than only a synthetic helper caller.
  const extension = await fs.readFile(path.join(root, 'extensions/shuncode/src/extension.ts'), 'utf8');
  const callback = extension.slice(extension.indexOf('  let webConnectionCheckInFlight ='), extension.indexOf('  const showReviewedWorkerOperations ='));
  const compiled = await require('esbuild').transform(`(async()=>{${callback};return runWebAiConnectionCheck;})()`, { loader: 'ts', target: 'es2022' });
  for (const variant of ['ok', 'disabled', 'mission-page', 'durable-owner', 'consumed', 'storage-race']) {
    const env = environment(); let records = variant === 'consumed' ? { spare: { inputId: 'old-consumed' } } : {};
    let references = variant === 'durable-owner' ? [{ workerId: 'nimora.web-worker', adapterSessionId: 'native' }] : [];
    let owner;
    const originalCreate = env.workers.createSession;
    env.workers.createSession = async (...args) => { owner = await originalCreate(...args); return owner; };
    env.workers.getSessionByAdapterIdentity = () => owner;
    env.workers.isAdapterSessionRetired = async () => false;
    // Product callback checkpoints directly, so route the helper's mock send
    // expectation through the same saved receipt evidence.
    const run = await vm.runInNewContext(compiled.code, {
      oneTrustedWorkspace: () => '/test', productionWorkersReady: Promise.resolve(),
      resolveWebWorkerReleaseGate: () => ({ effective: variant !== 'disabled' }),
      WEB_AI_CONNECTION_CHECK_PROMPT, checkWebAiConnection,
      takeoverStates: () => variant === 'mission-page' ? { original: { pageIds: ['spare'] } } : {},
      taskRuntime: { initialize: async () => {}, listTasks: () => [{ workerSessions: Object.fromEntries(references.map((row, i) => [i, row])) }] },
      webWorkerSessions: env.workers, missionWorkProduction: { webCandidates: env.source },
      context: { workspaceState: { get: () => records, update: async (_key, next) => {
        records = next; env.receipts.push(structuredClone(next.spare));
        if (variant === 'storage-race' && next.spare.status === 'sending') references = [{ workerId: 'nimora.web-worker', adapterSessionId: 'native' }];
      } } },
      output: { appendLine() {} },
      vscode: { ProgressLocation: { Window: 10 }, workspace: { isTrusted: true, getConfiguration: () => ({ get: () => true }) },
        window: { showQuickPick: async choices => choices[0], showWarningMessage: async (_title, _opts, accept) => accept,
          withProgress: async (options, operation) => { assert.equal(options.location, 10); return operation(); }, setStatusBarMessage() {} } },
    });
    if (variant === 'ok') { await run(); assert.equal(records.spare.status, 'completed'); }
    else { await assert.rejects(run); assert.equal(env.calls.includes('send'), false, `${variant} cannot send`); }
  }
  console.log('PASS web AI connection check: exact spare page, canonical Worker owner, durable no-replay identity, zero tools/Tasks, single send and failure fences');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
