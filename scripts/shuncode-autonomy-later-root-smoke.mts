import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..'), require = createRequire(path.join(root, 'build/package.json'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-autonomy-later-'));
let command: Function;
const states = new Map([['nimora.webProjectIds', ['project']]]);
const tasks = new Map();
const mission = (id, rootId, parent, plane, archived = false) => ({ taskId: id, mission: { projectId: 'project', rootMissionId: rootId, parentMissionId: parent, plane },
  context: { constraints: [] }, interactions: {}, executions: {}, workerSessions: {}, ...(archived ? { missionFinalization: { state: 'archived' } } : {}) });
tasks.set('old', mission('old', 'old', undefined, 'cognition', true));
tasks.set('later', mission('later', 'later', undefined, 'cognition'));
tasks.set('coord', mission('coord', 'later', 'later', 'coordination'));
const resources = [1, 2].map(n => ({ pageId: `${n}`.repeat(32), resourceIdentity: `${n}`.repeat(64), site: 'deepseek', origin: 'https://chat.deepseek.com', href: 'https://chat.deepseek.com/', ready: true, nativeMcpBypass: false, sessionIdentityCompatible: true, workerTurnState: 'idle' }));
const candidates = resources.map(row => ({ candidateId: 'webmcp:' + row.resourceIdentity, provider: 'deepseek', kind: 'web', availability: 'available', health: { status: 'healthy' } }));
const sessions = new Map(), assignments = [];
let runs = 0, notices = 0, startPrompts = 0;
let approveStart = true;
const mock = { workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: temp } }] }, ProgressLocation: { Window: 1 },
  commands: { getCommands: async () => ['workbench.action.browser.nimoraOpenAndShareProviderPage'], registerCommand: (_id, callback) => { command = callback; return { dispose() {} }; },
    executeCommand: async id => { assert.equal(id, '_shuncode.webMcp.workerListResources', 'already shared exact fresh pages need no new native UI action'); return resources; } },
  window: { showInformationMessage: text => {
    if (text.startsWith('启动')) { startPrompts++; return Promise.resolve(approveStart ? '启动有界自主协作' : undefined); }
    notices++;
    return new Promise(() => {}); // An undismissed terminal notification.
  }, withProgress: async (_options, fn) => fn({ report() {} }) } };
(globalThis as any).laterAutonomyVscode = mock;
try {
  await require('esbuild').build({ stdin: { contents: `export { registerNimoraAutonomyEntry } from './extensions/shuncode/src/nimora-autonomy-entry.ts'; export { autonomyStartClaims, NimoraAutonomyStartConsent } from './extensions/shuncode/src/nimora-autonomy-start-consent.ts';`, resolveDir: root, loader: 'ts' }, outfile: path.join(temp, 'entry.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'fixture', setup(build) { build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fixture' })); build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: 'export const { workspace, ProgressLocation, commands, window } = globalThis.laterAutonomyVscode;' })); } }] });
  const composition = { owners: { projects: { initialize: async () => {}, listProjects: () => [{ projectId: 'project', workspace: temp }], getProject: () => ({ projectId: 'project', workspace: temp }) },
    tasks: { initialize: async () => {}, listTasks: () => [...tasks.values()], rereadTask: async id => structuredClone(tasks.get(id)),
      replaceMissionConstraintsStrict: async (id, expected, constraints) => { assert.deepEqual(tasks.get(id).context.constraints, expected); tasks.get(id).context.constraints = constraints; } }, workers: { listSessions: ({ taskId }) => sessions.has(taskId) ? [sessions.get(taskId)] : [] } },
    coordinator: { inspectManagedScope: async input => { assert.equal(input.managedRootMissionId, 'later'); return { coordinationMissionId: 'coord' }; } },
    webCandidates: { enumerateCandidates: async () => candidates },
    application: { assignInitialWorker: async (request, exact) => { assignments.push({ request, exact }); const row = { managedSessionId: 'managed-' + request.missionId, adapterSessionId: exact.exactCandidateId, workerId: 'web' };
      tasks.get(request.missionId).workerSessions[row.managedSessionId] = row; sessions.set(request.missionId, row); return { state: 'assigned' }; } },
    autonomy: { run: async scope => { runs++; assert.equal(scope.rootMissionId, 'later'); assert.equal(sessions.size, 2); return { state: 'completion-candidate' }; } } };
  const entry = require(path.join(temp, 'entry.cjs'));
  const consent = new entry.NimoraAutonomyStartConsent();
  entry.registerNimoraAutonomyEntry({ globalState: { get: (_key, fallback) => fallback }, workspaceState: { get: (key, fallback) => states.get(key) ?? fallback, update: async (key, value) => states.set(key, value) } }, composition, Promise.resolve(), consent);
  approveStart = false;
  await command({ projectId: 'project', maxRounds: 1 });
  assert.equal(assignments.length, 0); assert.equal(runs, 0); assert.equal(notices, 0);
  approveStart = true;
  let timeout;
  try {
    const result = await Promise.race([
      command({ projectId: 'project', maxRounds: 1 }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Undismissed terminal notice blocked the public command')), 1000); }),
    ]);
    assert.equal(result.state, 'completion-candidate');
  } finally { clearTimeout(timeout); }
  assert.equal(states.get('nimora.autonomyOutcome.v1').project.state, 'completion-candidate');
  assert.equal(notices, 1, 'terminal notice is shown while its unresolved promise does not block command settlement');
  assert.equal(assignments.length, 2); assert.deepEqual(assignments.map(row => row.request.missionId), ['later', 'coord']);
  assert.equal(new Set(assignments.map(row => row.exact.exactCandidateId)).size, 2); assert.equal(tasks.get('old').missionFinalization.state, 'archived');
  await command({ projectId: 'project' }); assert.equal(assignments.length, 2, 'existing exact roles must not be rebound');

  // The owning new-project flow transfers one combined Human decision. Public
  // arguments cannot manufacture it, and it never survives changed scope.
  const claims = () => entry.autonomyStartClaims(temp, composition.owners.projects.getProject(), 'later', 'coord', [...tasks.values()]);
  approveStart = false;
  const promptCount = startPrompts;
  const approved = claims();
  consent.authorize(approved);
  await command({ projectId: 'project' });
  assert.equal(startPrompts, promptCount, 'exact combined approval avoids a duplicate start modal');
  assert.equal(runs, 3);
  await command({ projectId: 'project', approved: true });
  assert.equal(startPrompts, promptCount + 1, 'consumed consent and a caller boolean cannot skip Human approval');
  assert.equal(runs, 3);
  consent.authorize(claims());
  tasks.get('later').context.summary = 'Changed goal after approval';
  await assert.rejects(command({ projectId: 'project' }), /范围已变化/);
  assert.equal(runs, 3); assert.equal(assignments.length, 2);
  delete tasks.get('later').context.summary;
  await command({ projectId: 'project' });
  assert.equal(runs, 3, 'scope rejection consumes the old approval instead of reviving it');
  consent.authorize(claims());
  await assert.rejects(command({ projectId: 'project', lifecycleBudget: {} }), /范围已变化/);
  assert.equal(runs, 3);
  const otherWorkspace = { ...claims(), workspace: temp + '-other' };
  consent.authorize(claims());
  assert.throws(() => consent.consume(otherWorkspace), /范围已变化/);
  assert.equal(consent.consume(claims()), false);
  assert.equal(new entry.NimoraAutonomyStartConsent().consume(approved), false, 'restart never restores ephemeral start consent');
  approveStart = true;
  sessions.set('later', { ...sessions.get('later'), workerId: 'wrong-worker' });
  await assert.rejects(command({ projectId: 'project' }), /绑定不完整/); assert.equal(runs, 3);
  tasks.get('later').executions = { unknown: { status: 'unknown' } };
  const assignmentsBeforeUnknown = assignments.length;
  await assert.rejects(command({ projectId: 'project' }), /待核实.*不会自动重播/); assert.equal(runs, 3);
  assert.equal(assignments.length, assignmentsBeforeUnknown, 'UNKNOWN must stop before assignment or Provider send');
  console.log('Autonomy product command PASS: combined exact single-use consent skips only duplicate start modal; forged flags, replay, scope/workspace changes, lifecycle overrides and restart cannot authorize; cancelled Human start has zero assignment/send; undismissed terminal notice returns persisted result; archived roots, binding drift and UNKNOWN guards retained.');
} finally { delete (globalThis as any).laterAutonomyVscode; assert.equal(path.dirname(temp), os.tmpdir()); assert.ok(path.basename(temp).startsWith('nimora-autonomy-later-')); await fs.rm(temp, { recursive: true, force: true }); }
