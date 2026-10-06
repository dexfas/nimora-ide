import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..'), require = createRequire(path.join(root, 'build/package.json'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-multi-product-'));
const commands = new Map(), global = new Map(), local = new Map([['nimora.webProjectIds', ['p']]]), secrets = new Map();
const store = map => ({ get: (k, fallback) => map.get(k) ?? fallback, update: async (k, v) => map.set(k, structuredClone(v)) });
let approve = true, modalCount = 0, nativeCount = 0, inputValues: string[] = [], modalDetails: string[] = [];
const resources = [1, 2].map(n => ({ pageId: `${n}`.repeat(32), resourceIdentity: `${n}`.repeat(64), site: 'deepseek', origin: 'https://chat.deepseek.com', href: 'https://chat.deepseek.com/', ready: true, nativeMcpBypass: false, sessionIdentityCompatible: true, workerTurnState: 'idle' }));
const webCandidates = resources.map(r => ({ candidateId: 'webmcp:' + r.resourceIdentity, provider: 'deepseek', kind: 'web', availability: 'available', health: { status: 'healthy' } }));
const mock = { workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: temp } }] }, ProgressLocation: { Window: 1 },
  commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; }, getCommands: async () => [], executeCommand: async id => { nativeCount++; assert.equal(id, '_shuncode.webMcp.workerListResources'); return resources; } },
  window: { showInformationMessage: async (_text, options) => { if (options?.modal) { modalCount++; if (typeof options.detail === 'string') modalDetails.push(options.detail); } return approve ? '启动有界自主协作' : undefined; }, showQuickPick: async rows => rows[0], showInputBox: async () => inputValues.shift(), withProgress: async (_opts, fn) => fn({ report() {} }) } };
(globalThis as any).multiProductVscode = mock;
try {
  await require('esbuild').build({ stdin: { contents: `
export { registerNimoraAutonomyEntry } from './extensions/shuncode/src/nimora-autonomy-entry.ts';
export { NimoraApiProfiles } from './extensions/shuncode/src/nimora-api-profiles.ts';
export { NimoraWebCognitionPool } from './extensions/shuncode/src/nimora-web-cognition.ts';
export { defaultResourcePolicy, readResourcePolicy, normalizeResourcePolicy, resourceAssignment, RESOURCE_POLICY_PREFIX } from './src/mission-resource-policy.ts';
export { TaskRuntime } from './src/task-runtime.ts';
export { WorkerSessionManager } from './src/worker-session-manager.ts';
`, resolveDir: root, loader: 'ts' }, outfile: path.join(temp, 'test.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'vscode-fixture', setup(build) { build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fixture' })); build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ loader: 'js', contents: 'export const {workspace,ProgressLocation,commands,window} = globalThis.multiProductVscode;' })); } }] });
  const lib = require(path.join(temp, 'test.cjs'));
  const context = { globalState: store(global), workspaceState: store(local), secrets: { get: async k => secrets.get(k), store: async (k, value) => secrets.set(k, value) } };
  for (const mode of ['api', 'mixed']) {
    const policy = lib.normalizeResourcePolicy({ ...lib.defaultResourcePolicy(), mode, planner: mode === 'api' ? 'api' : 'deepseek-web', revision: 'selected-' + mode, maxParallel: 2 });
    global.set('nimora.resourcePreferences.v1', policy);
    const tasks = new Map(['r', 'c', 'a', 'b'].map((id, i) => [id, { taskId: id, mission: { projectId: 'p', rootMissionId: 'r', plane: ['cognition', 'coordination', 'practice', 'practice'][i], ...(i ? { parentMissionId: 'r' } : {}) },
      context: { constraints: id === 'r' ? [lib.RESOURCE_POLICY_PREFIX + JSON.stringify(policy)] : [] }, executions: {}, interactions: {}, workerSessions: {} }]));
    const sessions = new Map(), assignments = [], workRequests = [];
    let runs = 0;
    const composition = { owners: { projects: { initialize: async () => {}, listProjects: () => [{ projectId: 'p', workspace: temp }], getProject: () => ({ projectId: 'p', workspace: temp }) },
      tasks: { initialize: async () => {}, listTasks: () => [...tasks.values()], rereadTask: async id => structuredClone(tasks.get(id)) }, workers: { listSessions: ({ taskId }) => sessions.has(taskId) ? [sessions.get(taskId)] : [] } },
      webCandidates: { enumerateCandidates: async () => webCandidates }, coordinator: { inspectManagedScope: async () => ({ coordinationMissionId: 'c' }) },
      application: { assignInitialWorker: async (request, exact) => { assignments.push(request); const row = { managedSessionId: request.missionId + '-managed', adapterSessionId: exact?.exactCandidateId ?? 'api-' + request.missionId, workerId: mode === 'api' ? 'nimora.api-runtime' : 'nimora.web-worker' }; sessions.set(request.missionId, row); tasks.get(request.missionId).workerSessions[row.managedSessionId] = row; return { state: 'assigned' }; } },
      parallelReadiness: { inspect: async ({ missionIds }) => ({ missions: missionIds.map(missionId => ({ missionId, state: 'ready-unassigned' })) }) },
      plannedWork: { assignReady: async ({ requests }) => { workRequests.push(...requests); return { outcomes: requests.map(r => ({ missionId: r.missionId, state: 'assigned' })) }; } },
      succession: { inspect: async () => ({ capacity: { state: 'normal' } }) },
      autonomy: { run: async (_scope, options) => { runs++; assert.equal(options.maxParallel, 2); await options.ensureAssigned(['a', 'b']); await options.ensureConversation('r'); return { state: 'completion-candidate' }; } } };
    lib.registerNimoraAutonomyEntry(context, composition, Promise.resolve());
    const start = commands.get('shuncode.nimora.runWebAutonomy');
    approve = false; await start({ projectId: 'p', approved: true }); assert.equal(runs, 0); assert.equal(assignments.length, 0);
    approve = true; const countBefore = nativeCount; await start({ projectId: 'p' });
    assert.equal(assignments.length, 2); assert.equal(workRequests.length, 2);
    if (mode === 'api') {
      assert.match(modalDetails.at(-1), /本轮只使用已授权的 API 资源/, 'API-only autonomy consent must describe API resources');
      assert.doesNotMatch(modalDetails.at(-1), /需要新网页|逐页请求原生共享授权/, 'API-only autonomy consent must not pretend Web sharing is required');
    } else {
      assert.match(modalDetails.at(-1), /需要网页 AI 时会逐页请求原生共享授权/, 'mixed consent must explain Web sharing only conditionally');
    }
    assert.deepEqual(assignments[0].constraints.allowedKinds, mode === 'api' ? ['api'] : ['web']);
    assert.deepEqual(workRequests[0].constraints.allowedKinds, mode === 'api' ? ['api'] : ['web', 'api']);
    if (mode === 'api') assert.equal(nativeCount, countBefore, 'API-only ordinary autonomy requires no native browser command or page share');
    global.set('nimora.resourcePreferences.v1', lib.defaultResourcePolicy());
    await start({ projectId: 'p' }); assert.deepEqual(workRequests.at(-1).constraints.allowedKinds, mode === 'api' ? ['api'] : ['web', 'api'], 'global preferences cannot widen or replace this root authority');
    const existingRun = composition.autonomy.run;
    composition.autonomy.run = async (_scope, options) => { tasks.get('r').context.constraints = []; await options.ensureConversation('r'); throw new Error('unreachable'); };
    await assert.rejects(start({ projectId: 'p' }), /资源授权已变化/);
    composition.autonomy.run = existingRun;
  }
  assert(modalCount >= 6);
  const hard = lib.normalizeResourcePolicy({ ...lib.defaultResourcePolicy(), mode: 'api', planner: 'api', roleRequirements: { coordination: { requiredModel: 'exact-model', requiredCapabilities: { imageInput: true } } } });
  assert.equal(lib.resourceAssignment(hard, { projectId: 'p', rootMissionId: 'r' }, 'c', 'coordination').constraints.requiredModel, 'exact-model');
  assert.throws(() => lib.normalizeResourcePolicy({ ...hard, roleRequirements: { cognition: { allowedKinds: ['web'] } } }), /cannot change/);
  const runtime = new lib.TaskRuntime({ storageDirectory: path.join(temp, 'tasks') });
  const t = await runtime.ensureTask({ kind: 'mission', key: 'strict-resource' }, 'root');
  await runtime.configureMission(t.taskId, { projectId: 'p', rootMissionId: t.taskId, plane: 'cognition', missionType: 'test', completionCriteria: ['test'] });
  const constraints = [lib.RESOURCE_POLICY_PREFIX + JSON.stringify(hard)];
  await runtime.replaceMissionConstraintsStrict(t.taskId, [], constraints);
  await assert.rejects(runtime.replaceMissionConstraintsStrict(t.taskId, [], []), /changed before approval/);
  const restored = new lib.TaskRuntime({ storageDirectory: path.join(temp, 'tasks') }); await restored.initialize(); assert.deepEqual(lib.readResourcePolicy(restored.getTask(t.taskId)), hard);
  assert.throws(() => lib.readResourcePolicy({ context: { constraints: [...constraints, ...constraints] } }), /Conflicting/);
  const profiles = new lib.NimoraApiProfiles(context);
  for (const n of [1, 2]) { inputValues = ['profile-' + n, 'https://example.com/v1', 'model-' + n, 'LOCAL_SECRET_' + n]; await profiles.configure(); }
  const configs = await profiles.configurations(temp); assert.equal(configs.length, 2); assert.notEqual(configs[0].profileId, configs[1].profileId);
  assert.doesNotMatch(JSON.stringify(profiles.list()) + JSON.stringify([...global]), /LOCAL_SECRET/); assert.equal(secrets.size, 2);
  let apiInputs = 0, current, preferredProject;
  const pool = new lib.NimoraWebCognitionPool({ createSession: async (workerId, options) => (current = { managedSessionId: 'api-planner', adapterSessionId: 'native-api', workerId, state: 'idle', model: options.model }),
    getSession: () => current, refresh: async () => ({ kind: 'api', availability: 'available', capabilities: { capabilityRequests: true } }), health: async () => ({ status: 'healthy' }),
    send: async function* (_id, input) { apiInputs++; assert.deepEqual(input.allowedCapabilities, []); assert.deepEqual(input.externalCapabilities, []); yield { type: 'terminal', status: 'completed', result: { text: '{"bounded":true}' } }; } },
    { enumerateCandidates: async () => [{ candidateId: 'api-only', workerId: 'nimora.api-runtime', provider: 'nimora-api', kind: 'api', models: ['model-1'], availability: 'available', health: { status: 'healthy' } }], refreshCandidate: async c => c, materializeSessionOptions: async () => ({ model: 'model-1' }) }, () => {}, projectId => { preferredProject = projectId; return projectId === 'new-project' ? 'api' : 'deepseek-web'; });
  const planner = await pool.acquire('new-project'); assert.equal(preferredProject, 'new-project', 'reviewer restoration chooses the persisted Project policy rather than unrelated global preferences'); assert.equal((await pool.inspectBackend(planner)).kind, 'api'); assert.equal(await pool.runJson(planner, 'bounded'), '{"bounded":true}'); assert.equal(apiInputs, 1);
  console.log('Multi-provider product contract PASS: ordinary API roles/no browser, mixed Practice pool, explicit Human cancel, durable root resource policy/CAS/restart/drift, two private API Profiles, tools-free API Formation/reviewer. Fixture, not account live.');
} finally { delete (globalThis as any).multiProductVscode; assert.equal(path.dirname(temp), os.tmpdir()); assert.ok(path.basename(temp).startsWith('nimora-multi-product-')); await fs.rm(temp, { recursive: true, force: true }); }
