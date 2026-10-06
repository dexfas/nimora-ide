import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-api-review-recovery-'));
try {
  await require('esbuild').build({ entryPoints: [path.join(root, 'extensions/shuncode/src/nimora-web-cognition.ts')], outfile: path.join(temp, 'pool.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { NimoraWebCognitionPool } = require(path.join(temp, 'pool.cjs'));
  const fixture = (preferred: string, healthy = true, terminalStatus = 'completed') => {
    let current: any, creates = 0, sends = 0, enumerations = 0;
    const workers = { createSession: async (workerId, options) => { creates++; return current = { managedSessionId: 'reviewer', adapterSessionId: 'api', workerId, state: 'idle', model: options.model }; },
      getSession: () => current, refresh: async () => ({ kind: 'api', availability: 'available', capabilities: {} }), health: async () => ({ status: healthy ? 'healthy' : 'unhealthy' }),
      send: async function* (_id, input) { sends++; assert.deepEqual(input.allowedCapabilities, []); assert.deepEqual(input.externalCapabilities, []); yield { type: 'terminal', status: terminalStatus, result: { text: '{"verdict":"blocked","summary":"missing"}' } }; } };
    const source = { enumerateCandidates: async () => { enumerations++; return [{ candidateId: 'api', workerId: 'nimora.api-runtime', provider: 'nimora-api', kind: 'api', models: ['model'], availability: 'available', health: { status: 'healthy' } }]; }, refreshCandidate: async c => c, materializeSessionOptions: async () => ({ model: 'model' }) };
    const pool = new NimoraWebCognitionPool(workers, source, () => {}, projectId => { assert.equal(projectId, 'exact-project'); return preferred; });
    return { pool, counts: () => ({ creates, sends, enumerations }), drop: () => { current = undefined; }, run: () => { current.state = 'running'; }, bind: () => { current.taskId = 'mission'; }, changePreference: () => { preferred = 'deepseek-web'; } };
  };
  const restored = fixture('api');
  assert.equal(await restored.pool.ensureCompletionReference('exact-project'), true);
  assert.deepEqual(restored.counts(), { creates: 1, sends: 0, enumerations: 1 }, 'recovery creates only a tools-free connection; no model request or file tool');
  assert.equal(await restored.pool.ensureCompletionReference('exact-project'), true);
  assert.equal(restored.counts().creates, 1, 'retained reference is checked, not replaced');
  const id = await restored.pool.acquire('exact-project');
  assert.equal(await restored.pool.runJson(id, 'fresh independent review'), '{"verdict":"blocked","summary":"missing"}');
  assert.equal(restored.counts().sends, 1);
  const web = fixture('deepseek-web'); assert.equal(await web.pool.ensureCompletionReference('exact-project'), false); assert.deepEqual(web.counts(), { creates: 0, sends: 0, enumerations: 0 }, 'Web restart cannot borrow an API connection or silently open a page');
  for (const fault of ['drop', 'run', 'bind', 'changePreference'] as const) {
    const f = fixture('api'); await f.pool.ensureCompletionReference('exact-project'); f[fault]();
    await assert.rejects(f.pool.ensureCompletionReference('exact-project'));
    assert.equal(f.counts().creates, 1); assert.equal(f.counts().sends, 0, `${fault} must not replace or send an uncertain/foreign reviewer`);
  }
  const unhealthy = fixture('api', false); await assert.rejects(unhealthy.pool.ensureCompletionReference('exact-project')); await assert.rejects(unhealthy.pool.ensureCompletionReference('exact-project')); assert.equal(unhealthy.counts().creates, 1); assert.equal(unhealthy.counts().sends, 0);
  const uncertain = fixture('api', true, 'failed'); await uncertain.pool.ensureCompletionReference('exact-project'); const uncertainId = await uncertain.pool.acquire('exact-project'); await assert.rejects(uncertain.pool.runJson(uncertainId, 'one consumed review')); await assert.rejects(uncertain.pool.ensureCompletionReference('exact-project')); assert.equal(uncertain.counts().creates, 1); assert.equal(uncertain.counts().sends, 1, 'unverified terminal cannot replace or replay the reviewer');
  console.log('API completion reviewer recovery PASS: persisted Project policy, tools-free/no-send preparation, exact retained checks, missing/running/bound/unhealthy/backend-drift fail closed, Web restart unchanged. Fixture, not account live.');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
