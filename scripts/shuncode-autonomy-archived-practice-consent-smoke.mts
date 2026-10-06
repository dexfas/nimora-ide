import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..'), require = createRequire(path.join(root, 'build/package.json'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-archived-practice-consent-'));
try {
  await require('esbuild').build({ entryPoints: [path.join(root, 'extensions/shuncode/src/nimora-autonomy-start-consent.ts')], outfile: path.join(temp, 'consent.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const { autonomyStartClaims, NimoraAutonomyStartConsent } = require(path.join(temp, 'consent.cjs'));
  const project = { projectId: 'p', workspace: temp };
  const tasks = [{ taskId: 'root', mission: { projectId: 'p', rootMissionId: 'root', plane: 'cognition' }, status: 'ready' },
    { taskId: 'coord', mission: { projectId: 'p', rootMissionId: 'root', parentMissionId: 'root', plane: 'coordination' }, status: 'ready' },
    { taskId: 'practice', mission: { projectId: 'p', rootMissionId: 'root', parentMissionId: 'root', plane: 'practice' }, status: 'completed', missionFinalization: { state: 'archived', handoffContentDigest: 'exact-proof' } }];
  const claims = () => autonomyStartClaims(temp, project, 'root', 'coord', tasks);
  const consent = new NimoraAutonomyStartConsent(); const before = structuredClone(tasks);
  assert.equal(consent.consume(claims()), false, 'completed Practice permits the ordinary native modal path; it cannot fabricate approval');
  consent.authorize(claims()); assert.equal(consent.consume(claims()), true); assert.equal(consent.consume(claims()), false); assert.deepEqual(tasks, before, 'claims cannot reopen or edit the archived Practice');
  for (const owner of [0, 1]) { const changed = structuredClone(tasks); changed[owner].missionFinalization = { state: 'archived', handoffContentDigest: 'owner-proof' }; assert.throws(() => autonomyStartClaims(temp, project, 'root', 'coord', changed), /活动/); }
  consent.authorize(claims()); const changed = structuredClone(tasks); changed[2].missionFinalization.handoffContentDigest = 'tampered'; assert.throws(() => consent.consume(autonomyStartClaims(temp, project, 'root', 'coord', changed)), /范围已变化/); assert.equal(consent.consume(claims()), false, 'drift consumes the old approval; no replay');
  consent.authorize(claims()); assert.throws(() => consent.consume(claims(), { resources: { mode: 'api' } }), /范围已变化/); assert.equal(consent.consume(claims()), false);
  console.log('Archived Practice start consent PASS: live root/Coordinator with archived support may reach native confirmation; no implicit approval/reopening; finalized owner refused; whole-scope evidence digest/drift and single-use/no-replay preserved.');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
