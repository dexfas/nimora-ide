import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild');
const projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p8-cap-project-'));
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p8-cap-task-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p8-cap-bundle-'));
const bundlePath = path.join(bundleDirectory, 'mission-capability-materialization-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { ProjectStore } from './src/project-store.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
      export { WorkerSessionManager } from './src/worker-session-manager.ts';
      export {
        MissionCapabilityMaterializer,
        MissionCapabilityMaterializationError,
        inspectCapabilityGrantVisibility,
      } from './src/mission-capability-materializer.ts';
      export {
        CAPABILITY_METADATA_BY_TOOL,
        getCapabilityMetadata,
      } from './src/capability-registry.ts';
      export {
        CORE_MISSION_CAPABILITY_SCHEMA_SOURCES,
        FILE_MISSION_CAPABILITY_SCHEMA_SOURCE,
        IDE_MISSION_CAPABILITY_SCHEMA_SOURCE,
        missionCapabilitySchemaSourceFromDefinitions,
      } from './src/mission-capability-schema-source.ts';
      export { APPLY_PATCH_TOOL } from './src/file-tool-registry.ts';
      export {
        BRIDGE_TASK_MISSION_CAPABILITY_SCHEMA_SOURCE,
        SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES,
        SET_TODOS_TOOL,
        REPORT_PROGRESS_TOOL,
      } from './extensions/shuncode/src/bridge-task-tool-definitions.ts';
      export { ApiWorkerAdapter } from './extensions/shuncode/src/api-worker-adapter.ts';
      export { WebMcpCommandTransport } from './extensions/shuncode/src/webmcp-worker-transport.ts';
      export { WebWorkerAdapter } from './src/web-worker-adapter.ts';
    `,
    resolveDir: root,
    sourcefile: 'mission-capability-materialization-smoke-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});

const {
  ProjectStore,
  TaskRuntime,
  WorkerSessionManager,
  MissionCapabilityMaterializer,
  MissionCapabilityMaterializationError,
  inspectCapabilityGrantVisibility,
  CAPABILITY_METADATA_BY_TOOL,
  getCapabilityMetadata,
  CORE_MISSION_CAPABILITY_SCHEMA_SOURCES,
  FILE_MISSION_CAPABILITY_SCHEMA_SOURCE,
  IDE_MISSION_CAPABILITY_SCHEMA_SOURCE,
  missionCapabilitySchemaSourceFromDefinitions,
  APPLY_PATCH_TOOL,
  BRIDGE_TASK_MISSION_CAPABILITY_SCHEMA_SOURCE,
  SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES,
  SET_TODOS_TOOL,
  REPORT_PROGRESS_TOOL,
  ApiWorkerAdapter,
  WebMcpCommandTransport,
  WebWorkerAdapter,
} = require(bundlePath);

const FIXED_GENERATED_AT = '2026-09-16T15:00:00.000Z';
const PROVIDER_TRANSCRIPT_SENTINEL = 'P8_WO2_PROVIDER_TRANSCRIPT_MUST_NOT_LEAK';
let tick = 0;
const now = () => new Date(Date.UTC(2026, 8, 16, 14, 0, tick++));
let id = 0;
const newId = () => `p8-cap-id-${++id}`;

const ids = values => {
  const queue = [...values];
  return () => {
    const value = queue.shift();
    if (!value) throw new Error('Managed WorkerSession id fixture exhausted.');
    return value;
  };
};

class FakeAdapter {
  sends = 0;
  creates = 0;
  disposes = 0;
  nextNative = 0;
  providerTranscript = PROVIDER_TRANSCRIPT_SENTINEL;

  constructor({ id, kind = 'api', capabilityRequests = true, projection }) {
    this.id = id;
    this.kind = kind;
    this.capabilityRequests = capabilityRequests;
    this.projection = projection;
  }

  async describe() {
    return {
      id: this.id,
      provider: `provider-${this.id}`,
      kind: this.kind,
      label: `Phase 8 capability ${this.id}`,
      availability: 'available',
      ...(this.projection === undefined ? {} : { capabilityProjection: { ...this.projection } }),
      capabilities: {
        streaming: true,
        reasoning: true,
        capabilityRequests: this.capabilityRequests,
        imageInput: false,
        checkpoints: false,
        interruption: true,
        persistentContext: true,
      },
    };
  }

  async createSession(options) {
    this.creates += 1;
    return {
      sessionId: `${this.id}-native-${++this.nextNative}`,
      workerId: this.id,
      state: 'idle',
      model: options.model,
      contextHandle: options.contextHandle,
      createdAt: FIXED_GENERATED_AT,
      lastActiveAt: FIXED_GENERATED_AT,
    };
  }

  async *send(_session, input) {
    this.sends += 1;
    yield { type: 'terminal', inputId: input.inputId, status: 'completed' };
  }

  async interrupt(session) { session.state = 'interrupted'; }
  async dispose(session) { this.disposes += 1; session.state = 'disposed'; }
  async health() { return { status: 'healthy', checkedAt: FIXED_GENERATED_AT }; }
}

class FakeWebMcpCommands {
  calls = [];

  async executeCommand(command, arg) {
    this.calls.push({ command, arg });
    if (command === '_shuncode.webMcp.workerConnect') {
      return {
        pageId: 'p8-web-page',
        sessionId: 'p8-web-page-session',
        site: 'deepseek',
        origin: 'https://chat.deepseek.com',
        href: 'https://chat.deepseek.com/chat',
        transport: 'http',
        status: { enabled: true, composerFound: true },
      };
    }
    throw new Error(`Unexpected WebMCP command during materialization proof: ${command}`);
  }
}

async function configureMission(tasks, projectId, key, plane, missionType, rootMissionId, parentMissionId) {
  const task = await tasks.ensureTask({ kind: 'mission', key }, `${missionType} goal`);
  const rootMission = rootMissionId ?? task.taskId;
  await tasks.configureMission(task.taskId, {
    projectId,
    rootMissionId: rootMission,
    ...(parentMissionId ? { parentMissionId } : {}),
    plane,
    missionType,
    completionCriteria: [`${missionType} capability visibility remains bounded`],
  });
  return tasks.getTask(task.taskId);
}

function catalogById(result, capabilityId) {
  return result.catalog.find(entry => entry.capabilityId === capabilityId);
}

function mappingById(result, capabilityId) {
  return result.inspector.mappings.find(entry => entry.capabilityId === capabilityId);
}

async function expectCapabilityError(promise, code) {
  try {
    await promise;
    assert.fail(`Expected MissionCapabilityMaterializationError(${code})`);
  } catch (error) {
    assert.ok(error instanceof MissionCapabilityMaterializationError, `expected structured capability materialization error, got ${error}`);
    assert.equal(error.code, code);
    assert.equal(error.inspector.incompatibility?.code, code);
    return error;
  }
}

async function expectInvalidBeforeOwners(promise) {
  const error = await expectCapabilityError(promise, 'invalid-request');
  assert.equal(error.inspector.profile, undefined);
  assert.deepEqual(error.inspector.selected.capabilityIds, []);
  assert.deepEqual(error.inspector.selected.toolNames, []);
  return error;
}

function poisonOwner(label) {
  return new Proxy({}, {
    get(_target, property) {
      throw new Error(`${label} semantic owner accessed during request normalization: ${String(property)}`);
    },
  });
}

const ALL_SCHEMA_SOURCES = SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES;
const FAKE_EXTERNAL_ROUTES = ALL_SCHEMA_SOURCES.map(source => ({
  routeId: `fake.external.${source.sourceId}`,
  projectionMode: 'external-schema',
  schemaSourceId: source.sourceId,
  toolNames: source.listDefinitions().map(definition => definition.toolName),
  basis: `Focused fake Worker explicitly accepts and executes ${source.sourceId} definitions supplied by this test contract.`,
}));

try {
  const projects = new ProjectStore({ storageDirectory: projectDirectory, now, newId });
  const tasks = new TaskRuntime({ storageDirectory: taskDirectory, now, newId });
  await Promise.all([projects.initialize(), tasks.initialize()]);

  const project = await projects.createProject({ title: 'Phase 8 capability materialization project', goal: 'Expose exact schemas without granting or executing them.' });
  const practice = await configureMission(tasks, project.projectId, 'cap-practice-root', 'practice', 'phase8-capability-practice');
  const cognition = await configureMission(tasks, project.projectId, 'cap-cognition', 'cognition', 'phase8-capability-cognition', practice.taskId, practice.taskId);
  const realApiMission = await configureMission(tasks, project.projectId, 'cap-real-api', 'practice', 'phase8-capability-real-api', practice.taskId, practice.taskId);
  const realWebMission = await configureMission(tasks, project.projectId, 'cap-real-web', 'practice', 'phase8-capability-real-web', practice.taskId, practice.taskId);
  const terminal = await configureMission(tasks, project.projectId, 'cap-terminal', 'practice', 'phase8-capability-terminal', practice.taskId, practice.taskId);

  const apiAdapter = new FakeAdapter({
    id: 'worker.api-schema',
    kind: 'api',
    projection: { nativeByName: true, externalDefinitions: true, executionRoutes: FAKE_EXTERNAL_ROUTES },
  });
  const realApiRuntime = {
    runAgentCalls: 0,
    async hello() {
      return {
        name: 'fake-real-api-runtime',
        protocolVersion: 8,
        pid: 1,
        node: process.version,
        platform: process.platform,
        tools: ['read_files', 'get_diagnostics'],
        capabilities: { streamingModelResponses: true, ideToolBroker: true, cancellation: true },
      };
    },
    async runAgent() {
      this.runAgentCalls += 1;
      throw new Error('Mission capability materialization must never send to the real API adapter.');
    },
  };
  const realApiAdapter = new ApiWorkerAdapter(realApiRuntime, 'worker.api-real', 'nimora-api-real');
  const webCommands = new FakeWebMcpCommands();
  const realWebAdapter = new WebWorkerAdapter(
    new WebMcpCommandTransport(webCommands, { pollIntervalMs: 1, now: () => new Date(FIXED_GENERATED_AT) }),
    'worker.web-real',
  );
  const workers = new WorkerSessionManager({
    taskBindings: tasks,
    newId: ids([
      'managed-practice-api',
      'managed-cognition-api',
      'managed-real-api',
      'managed-real-web',
      'managed-practice-native',
      'managed-practice-unsupported',
    ]),
    now,
  });
  await workers.register(apiAdapter);
  await workers.register(realApiAdapter);
  await workers.register(realWebAdapter);
  const practiceApi = await workers.createSession('worker.api-schema', { model: 'fake-model', contextHandle: PROVIDER_TRANSCRIPT_SENTINEL }, practice.taskId);
  const cognitionApi = await workers.createSession('worker.api-schema', { model: 'fake-model', contextHandle: PROVIDER_TRANSCRIPT_SENTINEL }, cognition.taskId);
  const realApiSession = await workers.createSession('worker.api-real', {
    model: 'real-api-model', workspaceRoot: root, runtime: {}, contextHandle: PROVIDER_TRANSCRIPT_SENTINEL,
  }, realApiMission.taskId);
  const realWebSession = await workers.createSession('worker.web-real', {
    model: 'real-web-model', contextHandle: PROVIDER_TRANSCRIPT_SENTINEL,
  }, realWebMission.taskId);

  const materializer = new MissionCapabilityMaterializer(projects, tasks, workers, ALL_SCHEMA_SOURCES);
  const practiceRequest = {
    projectId: project.projectId,
    rootMissionId: practice.taskId,
    missionId: practice.taskId,
    managedSessionId: practiceApi.managedSessionId,
    generatedAt: FIXED_GENERATED_AT,
    budget: { maxSchemaChars: 100_000 },
  };
  const cognitionRequest = {
    ...practiceRequest,
    missionId: cognition.taskId,
    managedSessionId: cognitionApi.managedSessionId,
  };

  const beforeFiles = {
    project: await fs.readdir(projectDirectory),
    task: await fs.readdir(taskDirectory),
  };
  const beforePractice = structuredClone(tasks.getTask(practice.taskId));
  const sessionsBeforeBaseline = workers.listSessions().map(session => session.managedSessionId).sort();
  const baseline = await materializer.materialize(practiceRequest);
  const bounded = await materializer.materialize({ ...practiceRequest, constraints: {
    requiredCapabilityIds: ['workspace.read-files', 'workspace.apply-patch'],
    allowedCapabilityIds: ['workspace.read-files', 'workspace.apply-patch'],
  } });
  assert.deepEqual(bounded.catalog.map(entry => entry.capabilityId).sort(), ['workspace.apply-patch', 'workspace.read-files']);
  assert.deepEqual(bounded.allowedCapabilities.sort(), ['apply_patch', 'read_files']);
  const noTools = await materializer.materialize({ ...practiceRequest, constraints: { allowedCapabilityIds: [] } });
  assert.deepEqual(noTools.allowedCapabilities, [], 'An explicit empty ceiling must not fall back to profile tools');
  await expectInvalidBeforeOwners(materializer.materialize({ ...practiceRequest, constraints: {
    requiredCapabilityIds: ['workspace.list-directory'], allowedCapabilityIds: ['workspace.read-files'],
  } }));
  await expectInvalidBeforeOwners(materializer.materialize({ ...practiceRequest, constraints: {
    optionalCapabilityIds: ['terminal.run-command'], allowedCapabilityIds: [],
  } }));
  await expectInvalidBeforeOwners(materializer.materialize({ ...practiceRequest, constraints: { allowedCapabilityIds: Array(1) } }));
  await expectInvalidBeforeOwners(materializer.materialize({ ...practiceRequest, constraints: { allowedCapabilityIds: ['workspace.read-files', 'workspace.read-files'] } }));
  const afterPractice = tasks.getTask(practice.taskId);

  assert.equal(baseline.profile, 'practice-v1');
  assert.equal(baseline.workerId, 'worker.api-schema');
  assert.equal(baseline.inspector.worker.capabilityProjection.nativeByName, true);
  assert.equal(baseline.inspector.worker.capabilityProjection.externalDefinitions, true);
  assert.deepEqual(baseline.inspector.worker.capabilityProjection.executionRouteIds, FAKE_EXTERNAL_ROUTES.map(route => route.routeId));
  assert.equal(baseline.inspector.worker.capabilityRequests, true);
  assert.ok(baseline.catalog.length > 0 && baseline.catalog.length < Object.keys(CAPABILITY_METADATA_BY_TOOL).length, 'Practice must not receive the whole registry by default');
  for (const strongId of ['workspace.apply-patch', 'terminal.run-command', 'terminal.send-command-input']) {
    assert.equal(catalogById(baseline, strongId), undefined, `Practice default must not expose strong capability ${strongId}`);
  }
  assert.ok(catalogById(baseline, 'task.set-todos'), 'Practice task-state capability has an explicit non-destructive approval-none profile rule');
  assert.ok(catalogById(baseline, 'task.report-progress'));
  assert.equal(baseline.allowedCapabilities.length, baseline.catalog.length);
  assert.equal(baseline.externalCapabilities.length, baseline.catalog.length, 'API-style projection must carry concrete external schemas');
  assert.ok(baseline.inspector.mappings.every(mapping => mapping.projectionMode === 'external-schema'));
  assert.ok(mappingById(baseline, 'workspace.read-files').schemaSourceId === 'file-tool-registry');
  assert.ok(mappingById(baseline, 'diagnostics.read').schemaSourceId === 'ide-tool-definitions');
  assert.ok(mappingById(baseline, 'task.set-todos').schemaSourceId === 'bridge-task-tool-definitions');
  assert.deepEqual(baseline.externalCapabilities.find(definition => definition.name === 'set_todos')?.inputSchema, SET_TODOS_TOOL.inputSchema);
  assert.deepEqual(baseline.externalCapabilities.find(definition => definition.name === 'report_progress')?.inputSchema, REPORT_PROGRESS_TOOL.inputSchema);

  const registryById = new Map(Object.entries(CAPABILITY_METADATA_BY_TOOL).map(([toolName, metadata]) => [metadata.id, { toolName, metadata }]));
  assert.equal(registryById.size, Object.keys(CAPABILITY_METADATA_BY_TOOL).length, 'semantic capability ids must be unique');
  for (const entry of baseline.catalog) {
    const registered = registryById.get(entry.capabilityId);
    assert.ok(registered, `catalog id must round-trip through sole semantic registry: ${entry.capabilityId}`);
    assert.equal(entry.toolName, registered.toolName);
    assert.equal(mappingById(baseline, entry.capabilityId).toolName, registered.toolName);
    assert.match(mappingById(baseline, entry.capabilityId).schemaIdentity, /^sha256:[0-9a-f]{64}$/);
    assert.match(mappingById(baseline, entry.capabilityId).executionRouteId, /^fake\.external\./);
    assert.match(mappingById(baseline, entry.capabilityId).routeBasis, /explicitly accepts and executes/);
  }

  assert.equal(apiAdapter.sends, 0, 'materialization must perform zero Worker sends');
  assert.deepEqual(workers.listSessions().map(session => session.managedSessionId).sort(), sessionsBeforeBaseline, 'materialization must not assign/create a WorkerSession');
  assert.deepEqual(afterPractice.capabilityGrants, beforePractice.capabilityGrants, 'visibility must not manufacture grants');
  assert.deepEqual(afterPractice.executions, beforePractice.executions, 'schema selection must not execute tools');
  assert.deepEqual(baseline.inspector.sideEffects, { workerSends: 0, toolExecutions: 0, grantsCreated: 0, grantsRevoked: 0, workerAssignments: 0 });
  assert.equal(baseline.inspector.durableCapabilityRoutingJournalCreated, false);

  const research = await materializer.materialize(cognitionRequest);
  assert.equal(research.profile, 'research-v1');
  for (const destructiveOrWrite of ['workspace.apply-patch', 'terminal.run-command', 'terminal.send-command-input', 'task.set-todos', 'task.report-progress']) {
    assert.equal(catalogById(research, destructiveOrWrite), undefined, `research profile must not automatically receive ${destructiveOrWrite}`);
  }
  assert.ok(catalogById(research, 'workspace.read-files'));
  assert.ok(catalogById(research, 'diagnostics.read'));

  // Real production API descriptor: file tools and IDE tools have concrete
  // current execution routes; Bridge-only task/progress schemas do not.
  const realApiRequest = {
    ...practiceRequest,
    missionId: realApiMission.taskId,
    managedSessionId: realApiSession.managedSessionId,
  };
  const realApiResult = await materializer.materialize({
    ...realApiRequest,
    constraints: { requiredCapabilityIds: ['workspace.read-files', 'diagnostics.read'] },
  });
  assert.equal(mappingById(realApiResult, 'workspace.read-files').executionRouteId, 'api.workspace-mcp.file-tools');
  assert.equal(mappingById(realApiResult, 'workspace.read-files').projectionMode, 'native-by-name');
  assert.equal(mappingById(realApiResult, 'diagnostics.read').executionRouteId, 'api.runtime.ide-tool-broker');
  assert.equal(mappingById(realApiResult, 'diagnostics.read').projectionMode, 'native-by-name');
  assert.equal(realApiResult.externalCapabilities.length, 0, 'proven current API routes are pre-existing routes, not arbitrary dynamic-schema execution');
  for (const bridgeCapabilityId of ['task.set-todos', 'task.report-progress']) {
    const omission = realApiResult.inspector.omissions.find(entry => entry.capabilityId === bridgeCapabilityId);
    assert.equal(omission?.reason, 'worker-projection-unsupported');
    assert.equal(omission?.schemaSourceId, 'bridge-task-tool-definitions');
    assert.ok(omission?.estimatedChars > 0);
    assert.equal(catalogById(realApiResult, bridgeCapabilityId), undefined);
  }
  const requiredBridge = await expectCapabilityError(materializer.materialize({
    ...realApiRequest,
    constraints: { requiredCapabilityIds: ['task.set-todos'] },
  }), 'worker-incompatibility');
  assert.equal(requiredBridge.inspector.incompatibility.schemaSourceId, 'bridge-task-tool-definitions');
  assert.match(requiredBridge.message, /no proven execution route/);
  assert.equal(realApiRuntime.runAgentCalls, 0);

  // Phase 11 page runtime now consumes exact per-turn capability names/schemas
  // and rejects out-of-scope host-managed calls. This particular transport
  // fixture intentionally does not declare the release-gated execution routes,
  // so materialization below must still fail closed.
  const pageRuntimeSource = await fs.readFile(path.join(root, 'extensions', 'shuncode-webmcp', 'arena-agent-bridge.js'), 'utf8');
  assert.match(pageRuntimeSource, /async function workerSend\(input\)/);
  assert.equal(pageRuntimeSource.includes('allowedCapabilities'), true, 'page runtime must consume the exact per-turn allowlist');
  assert.equal(pageRuntimeSource.includes('externalCapabilities'), true, 'page runtime must consume exact external schemas');
  assert.equal(pageRuntimeSource.includes('capability_rejected'), true, 'page runtime must reject an out-of-scope host-managed capability');
  const realWebRequest = {
    ...practiceRequest,
    missionId: realWebMission.taskId,
    managedSessionId: realWebSession.managedSessionId,
  };
  const webCommandsBeforeMaterialize = webCommands.calls.length;
  const realWebRequired = await expectCapabilityError(materializer.materialize({
    ...realWebRequest,
    constraints: { requiredCapabilityIds: ['workspace.apply-patch'] },
  }), 'worker-incompatibility');
  assert.equal(realWebRequired.inspector.worker.capabilityRequests, true, 'capabilityRequests=true remains irrelevant to projection support');
  assert.deepEqual(realWebRequired.inspector.worker.capabilityProjection, {
    nativeByName: false,
    externalDefinitions: false,
    executionRouteIds: [],
  });
  assert.match(realWebRequired.message, /no proven execution route/);
  assert.equal(webCommands.calls.length, webCommandsBeforeMaterialize, 'materialization must not call WebMCP workerSend/poll/execute');

  const explicitStrong = await materializer.materialize({
    ...practiceRequest,
    constraints: { requiredCapabilityIds: ['workspace.apply-patch', 'terminal.run-command'] },
  });
  assert.ok(catalogById(explicitStrong, 'workspace.apply-patch'));
  assert.ok(catalogById(explicitStrong, 'terminal.run-command'));
  assert.equal(mappingById(explicitStrong, 'workspace.apply-patch').approval, 'session');
  assert.equal(mappingById(explicitStrong, 'workspace.apply-patch').grant.state, 'absent');
  assert.equal(mappingById(explicitStrong, 'terminal.run-command').grant.state, 'absent');
  assert.ok(explicitStrong.externalCapabilities.some(definition => definition.name === 'apply_patch'));
  assert.ok(explicitStrong.externalCapabilities.some(definition => definition.name === 'run_command'));

  const unknownRequired = await expectCapabilityError(materializer.materialize({
    ...practiceRequest,
    constraints: { requiredCapabilityIds: ['capability.does-not-exist'] },
  }), 'capability-incompatibility');
  assert.equal(unknownRequired.inspector.incompatibility.capabilityId, 'capability.does-not-exist');
  const unknownOptional = await materializer.materialize({
    ...practiceRequest,
    constraints: { optionalCapabilityIds: ['capability.does-not-exist'] },
  });
  assert.ok(unknownOptional.inspector.omissions.some(entry => entry.capabilityId === 'capability.does-not-exist' && entry.reason === 'unknown-capability-id' && entry.estimatedChars === 0));
  assert.ok(unknownOptional.inspector.omissions.every(entry => Number.isInteger(entry.estimatedChars) && entry.estimatedChars >= 0), 'every optional omission must carry a deterministic non-negative cost');

  const duplicateSource = missionCapabilitySchemaSourceFromDefinitions('duplicate-apply-patch-owner', [APPLY_PATCH_TOOL]);
  const duplicateMaterializer = new MissionCapabilityMaterializer(projects, tasks, workers, [...ALL_SCHEMA_SOURCES, duplicateSource]);
  const duplicateError = await expectCapabilityError(duplicateMaterializer.materialize({
    ...practiceRequest,
    constraints: { requiredCapabilityIds: ['workspace.apply-patch'] },
  }), 'schema-incompatibility');
  assert.match(duplicateError.message, /Multiple concrete schemas/);

  const zeroMatchMaterializer = new MissionCapabilityMaterializer(projects, tasks, workers, [
    IDE_MISSION_CAPABILITY_SCHEMA_SOURCE,
    BRIDGE_TASK_MISSION_CAPABILITY_SCHEMA_SOURCE,
  ]);
  const zeroMatch = await expectCapabilityError(zeroMatchMaterializer.materialize({
    ...practiceRequest,
    constraints: { requiredCapabilityIds: ['workspace.apply-patch'] },
  }), 'schema-incompatibility');
  assert.match(zeroMatch.message, /No concrete schema matches/);

  const driftSource = {
    sourceId: 'drift-source',
    listDefinitions: () => [{
      toolName: 'apply_patch',
      definition: { name: 'read_files', inputSchema: { type: 'object', additionalProperties: false } },
    }],
  };
  const driftMaterializer = new MissionCapabilityMaterializer(projects, tasks, workers, [driftSource]);
  const driftError = await expectCapabilityError(driftMaterializer.materialize({
    ...practiceRequest,
    constraints: { requiredCapabilityIds: ['workspace.apply-patch'] },
  }), 'schema-incompatibility');
  assert.match(driftError.message, /tool-name drift/);

  const malformedSchemaSource = {
    sourceId: 'malformed-schema-source',
    listDefinitions: () => [{
      toolName: 'apply_patch',
      definition: { name: 'apply_patch', inputSchema: { type: 'string' } },
    }],
  };
  const malformedSchemaMaterializer = new MissionCapabilityMaterializer(projects, tasks, workers, [malformedSchemaSource]);
  const malformedSchema = await expectCapabilityError(malformedSchemaMaterializer.materialize({
    ...practiceRequest,
    constraints: { requiredCapabilityIds: ['workspace.apply-patch'] },
  }), 'schema-incompatibility');
  assert.match(malformedSchema.message, /object input schema/);

  const sparseDefinitions = Array(1);
  const sparseSchemaSource = { sourceId: 'sparse-schema-source', listDefinitions: () => sparseDefinitions };
  const sparseSchemaMaterializer = new MissionCapabilityMaterializer(projects, tasks, workers, [sparseSchemaSource]);
  const sparseSchema = await expectCapabilityError(sparseSchemaMaterializer.materialize({
    ...practiceRequest,
    constraints: { requiredCapabilityIds: ['workspace.apply-patch'] },
  }), 'schema-incompatibility');
  assert.match(sparseSchema.message, /dense definition array/);

  const sparseSourceList = Array(1);
  const sparseSourceMaterializer = new MissionCapabilityMaterializer(projects, tasks, workers, sparseSourceList);
  const sparseSource = await expectCapabilityError(sparseSourceMaterializer.materialize({
    ...practiceRequest,
    constraints: { requiredCapabilityIds: ['workspace.apply-patch'] },
  }), 'schema-incompatibility');
  assert.match(sparseSource.message, /schema sources must be a dense array/);

  const requiredOverflow = await expectCapabilityError(materializer.materialize({
    ...practiceRequest,
    budget: { maxSchemaChars: 1 },
    constraints: { requiredCapabilityIds: ['workspace.apply-patch'] },
  }), 'budget-incompatibility');
  assert.equal(requiredOverflow.inspector.incompatibility.capabilityId, 'workspace.apply-patch');
  const optionalOverflow = await materializer.materialize({
    ...practiceRequest,
    budget: { maxSchemaChars: 1 },
    constraints: { optionalCapabilityIds: ['workspace.apply-patch'] },
  });
  const optionalBudgetOmission = optionalOverflow.inspector.omissions.find(entry => entry.capabilityId === 'workspace.apply-patch');
  assert.equal(optionalBudgetOmission?.reason, 'schema-budget');
  assert.ok(optionalBudgetOmission?.estimatedChars > 1);

  const applyPatchMetadata = getCapabilityMetadata('apply_patch');
  const activeGrant = await tasks.grantCapabilityStrict(practice.taskId, {
    capabilityId: applyPatchMetadata.id,
    capabilityVersion: applyPatchMetadata.version,
    scope: 'worker-session',
    managedSessionId: practiceApi.managedSessionId,
  });
  const grantsAfterSetup = Object.keys(tasks.getTask(practice.taskId).capabilityGrants).length;
  const withActiveGrant = await materializer.materialize({
    ...practiceRequest,
    constraints: { requiredCapabilityIds: [applyPatchMetadata.id] },
  });
  assert.equal(mappingById(withActiveGrant, applyPatchMetadata.id).grant.state, 'active');
  assert.deepEqual(mappingById(withActiveGrant, applyPatchMetadata.id).grant.authorityGrantIds, [activeGrant.grantId]);
  assert.equal(Object.keys(tasks.getTask(practice.taskId).capabilityGrants).length, grantsAfterSetup, 'inspection must not create a grant');

  await tasks.revokeCapabilityGrantStrict(practice.taskId, activeGrant.grantId);
  const afterRevoked = await materializer.materialize({
    ...practiceRequest,
    constraints: { requiredCapabilityIds: [applyPatchMetadata.id] },
  });
  assert.equal(mappingById(afterRevoked, applyPatchMetadata.id).grant.state, 'absent');
  assert.ok(mappingById(afterRevoked, applyPatchMetadata.id).grant.ignored.some(entry => entry.grantId === activeGrant.grantId && entry.reason === 'revoked'));

  const generationGrant = await tasks.grantCapabilityStrict(practice.taskId, {
    capabilityId: applyPatchMetadata.id,
    capabilityVersion: applyPatchMetadata.version,
    scope: 'worker-session',
    managedSessionId: practiceApi.managedSessionId,
  });
  const oldAttachedAt = generationGrant.workerSessionAttachedAt;
  await tasks.detachWorkerSession(practice.taskId, practiceApi.managedSessionId);
  await tasks.attachWorkerSession(practice.taskId, {
    managedSessionId: practiceApi.managedSessionId,
    workerId: practiceApi.workerId,
    adapterSessionId: practiceApi.adapterSessionId,
    model: practiceApi.model,
  });
  const currentDurableSession = tasks.getTask(practice.taskId).workerSessions[practiceApi.managedSessionId];
  assert.notEqual(currentDurableSession.attachedAt, oldAttachedAt, 'fixture must create a new WorkerSession generation');
  const wrongGeneration = await materializer.materialize({
    ...practiceRequest,
    constraints: { requiredCapabilityIds: [applyPatchMetadata.id] },
  });
  assert.equal(mappingById(wrongGeneration, applyPatchMetadata.id).grant.state, 'absent');
  assert.ok(mappingById(wrongGeneration, applyPatchMetadata.id).grant.ignored.some(entry => entry.grantId === generationGrant.grantId && entry.reason === 'wrong-session-generation'));

  const taskScopedGrant = await tasks.grantCapabilityStrict(practice.taskId, {
    capabilityId: applyPatchMetadata.id,
    capabilityVersion: applyPatchMetadata.version,
    scope: 'task',
  });
  const sessionSemanticsWithTaskGrant = await materializer.materialize({
    ...practiceRequest,
    constraints: { requiredCapabilityIds: [applyPatchMetadata.id] },
  });
  assert.equal(mappingById(sessionSemanticsWithTaskGrant, applyPatchMetadata.id).grant.state, 'absent', 'task grant must not satisfy session approval');
  assert.ok(mappingById(sessionSemanticsWithTaskGrant, applyPatchMetadata.id).grant.ignored.some(entry => entry.grantId === taskScopedGrant.grantId && entry.reason === 'wrong-scope'));

  const syntheticTaskGrant = Object.freeze({ ...applyPatchMetadata, approval: 'task-grant' });
  const taskGrantInspection = inspectCapabilityGrantVisibility(tasks.getTask(practice.taskId), currentDurableSession, syntheticTaskGrant);
  assert.equal(taskGrantInspection.state, 'active');
  assert.deepEqual(taskGrantInspection.authorityGrantIds, [taskScopedGrant.grantId]);

  const syntheticAlways = Object.freeze({ ...applyPatchMetadata, approval: 'always' });
  const alwaysInspection = inspectCapabilityGrantVisibility(tasks.getTask(practice.taskId), currentDurableSession, syntheticAlways);
  assert.equal(alwaysInspection.state, 'external-authority-required');
  assert.deepEqual(alwaysInspection.authorityGrantIds, []);
  assert.ok(alwaysInspection.ignored.some(entry => entry.grantId === generationGrant.grantId && entry.reason === 'task-runtime-cannot-satisfy-always'));
  assert.ok(alwaysInspection.ignored.some(entry => entry.grantId === taskScopedGrant.grantId && entry.reason === 'task-runtime-cannot-satisfy-always'));

  await tasks.finalizeMissionStrict(terminal.taskId, { handoffRequired: false });
  await expectCapabilityError(materializer.materialize({
    ...practiceRequest,
    missionId: terminal.taskId,
    managedSessionId: 'irrelevant-terminal-session',
  }), 'terminal-mission');
  await tasks.withMissionFinalizationStabilization(practice.taskId, async () => {
    await expectCapabilityError(materializer.materialize(practiceRequest), 'finalizing-mission');
  });
  await expectCapabilityError(materializer.materialize({ ...practiceRequest, projectId: 'wrong-project' }), 'scope-mismatch');
  await expectCapabilityError(materializer.materialize({ ...practiceRequest, managedSessionId: cognitionApi.managedSessionId }), 'session-mismatch');

  const poisonedMaterializer = new MissionCapabilityMaterializer(
    poisonOwner('ProjectStore'),
    poisonOwner('TaskRuntime'),
    poisonOwner('WorkerSessionManager'),
    ALL_SCHEMA_SOURCES,
  );
  await expectInvalidBeforeOwners(poisonedMaterializer.materialize({ ...practiceRequest, unsupportedTopLevel: true }));
  await expectInvalidBeforeOwners(poisonedMaterializer.materialize(Object.create(practiceRequest)));
  await expectInvalidBeforeOwners(poisonedMaterializer.materialize({ ...practiceRequest, budget: Object.create({ maxSchemaChars: 100_000 }) }));
  await expectInvalidBeforeOwners(poisonedMaterializer.materialize({ ...practiceRequest, constraints: { requiredCapabilityIds: Array(1) } }));
  const inheritedIndexPrototype = Object.create(Array.prototype);
  Object.defineProperty(inheritedIndexPrototype, '0', { value: 'workspace.apply-patch', enumerable: true });
  const inheritedIndexIds = Array(1);
  Object.setPrototypeOf(inheritedIndexIds, inheritedIndexPrototype);
  await expectInvalidBeforeOwners(poisonedMaterializer.materialize({ ...practiceRequest, constraints: { requiredCapabilityIds: inheritedIndexIds } }));
  let getterRuns = 0;
  const accessorConstraints = {};
  Object.defineProperty(accessorConstraints, 'requiredCapabilityIds', {
    enumerable: true,
    get() { getterRuns += 1; return ['workspace.apply-patch']; },
  });
  await expectInvalidBeforeOwners(poisonedMaterializer.materialize({ ...practiceRequest, constraints: accessorConstraints }));
  assert.equal(getterRuns, 0, 'request normalization must reject accessors without invoking getters');
  const symbolConstraints = {};
  symbolConstraints[Symbol('hidden-capability')] = ['workspace.apply-patch'];
  await expectInvalidBeforeOwners(poisonedMaterializer.materialize({ ...practiceRequest, constraints: symbolConstraints }));

  const inheritedRequiredConstraints = Object.create({ requiredCapabilityIds: ['workspace.apply-patch'] });
  const inheritedRequired = await materializer.materialize({ ...practiceRequest, constraints: inheritedRequiredConstraints });
  assert.equal(catalogById(inheritedRequired, 'workspace.apply-patch'), undefined, 'inherited required capability must be semantically inert');
  const inheritedProfile = await materializer.materialize({ ...practiceRequest, constraints: Object.create({ profile: 'research' }) });
  assert.equal(inheritedProfile.profile, 'practice-v1', 'inherited profile must not change visibility');

  // Restart from durable owners and reconstruct the same projection before any
  // Worker replacement. The fixed request timestamp makes the result exact.
  await tasks.flush();
  const restartedProjects = new ProjectStore({ storageDirectory: projectDirectory });
  const restartedTasks = new TaskRuntime({ storageDirectory: taskDirectory });
  await Promise.all([restartedProjects.initialize(), restartedTasks.initialize()]);
  const restartedApiAdapter = new FakeAdapter({
    id: 'worker.api-schema',
    kind: 'api',
    projection: { nativeByName: true, externalDefinitions: true, executionRoutes: FAKE_EXTERNAL_ROUTES },
  });
  const restartedWorkers = new WorkerSessionManager({
    taskBindings: restartedTasks,
    newId: ids(['managed-practice-api', 'managed-cognition-api']),
  });
  await restartedWorkers.register(restartedApiAdapter);
  const restartedPracticeSession = await restartedWorkers.createSession('worker.api-schema', { model: 'fake-model', contextHandle: PROVIDER_TRANSCRIPT_SENTINEL }, practice.taskId);
  await restartedWorkers.createSession('worker.api-schema', { model: 'fake-model', contextHandle: PROVIDER_TRANSCRIPT_SENTINEL }, cognition.taskId);
  assert.equal(restartedPracticeSession.managedSessionId, practiceApi.managedSessionId);
  const restartedMaterializer = new MissionCapabilityMaterializer(restartedProjects, restartedTasks, restartedWorkers, ALL_SCHEMA_SOURCES);
  const restartedResult = await restartedMaterializer.materialize(practiceRequest);
  const currentResult = await materializer.materialize(practiceRequest);
  assert.deepEqual(restartedResult, currentResult, 'restart must reconstruct exact semantic/schema/grant projection from durable owners');
  assert.equal(restartedApiAdapter.sends, 0);

  // Replacement must happen through the existing Worker lifecycle before fresh
  // materialization; WO#2 only observes the exact replacement.
  await workers.retire(practiceApi.managedSessionId, { reason: 'phase8-capability-native-replacement' });
  const nativeAdapter = new FakeAdapter({
    id: 'worker.native-name',
    kind: 'web',
    projection: {
      nativeByName: true,
      externalDefinitions: false,
      executionRoutes: [{
        routeId: 'fake.native.file-tools',
        projectionMode: 'native-by-name',
        schemaSourceId: 'file-tool-registry',
        toolNames: ['apply_patch'],
        basis: 'Focused fake Worker contract explicitly consumes this exact allowedCapabilities name.',
      }],
    },
  });
  await workers.register(nativeAdapter);
  const nativeSession = await workers.createSession('worker.native-name', { model: 'native-model', contextHandle: PROVIDER_TRANSCRIPT_SENTINEL }, practice.taskId);
  const nativeRequest = { ...practiceRequest, managedSessionId: nativeSession.managedSessionId };
  const nativeResult = await materializer.materialize({
    ...nativeRequest,
    constraints: { requiredCapabilityIds: ['workspace.apply-patch'] },
  });
  assert.equal(mappingById(nativeResult, 'workspace.apply-patch').projectionMode, 'native-by-name');
  assert.equal(mappingById(nativeResult, 'workspace.apply-patch').executionRouteId, 'fake.native.file-tools');
  assert.ok(nativeResult.allowedCapabilities.includes('apply_patch'));
  assert.equal(nativeResult.externalCapabilities.length, 0, 'native-name-only Worker must not be misreported as external-schema-capable');
  assert.equal(nativeAdapter.sends, 0);
  assert.equal(JSON.stringify(nativeResult).includes(PROVIDER_TRANSCRIPT_SENTINEL), false);

  await workers.retire(nativeSession.managedSessionId, { reason: 'phase8-capability-unsupported-replacement' });
  const unsupportedAdapter = new FakeAdapter({
    id: 'worker.capability-requests-only', kind: 'agent-host', capabilityRequests: true, projection: undefined,
  });
  await workers.register(unsupportedAdapter);
  const unsupportedSession = await workers.createSession('worker.capability-requests-only', { model: 'unsupported-model', contextHandle: PROVIDER_TRANSCRIPT_SENTINEL }, practice.taskId);
  const unsupportedRequest = { ...practiceRequest, managedSessionId: unsupportedSession.managedSessionId };
  const sessionsBeforeUnsupported = workers.listSessions().map(session => session.managedSessionId).sort();
  const unsupported = await expectCapabilityError(materializer.materialize({
    ...unsupportedRequest,
    constraints: { requiredCapabilityIds: ['workspace.apply-patch'] },
  }), 'worker-incompatibility');
  assert.match(unsupported.message, /capabilityRequests=true is not execution-route authority/);
  assert.equal(unsupported.inspector.worker.capabilityRequests, true);
  assert.deepEqual(unsupported.inspector.worker.capabilityProjection, { nativeByName: false, externalDefinitions: false, executionRouteIds: [] });
  assert.deepEqual(workers.listSessions().map(session => session.managedSessionId).sort(), sessionsBeforeUnsupported, 'incompatibility must not reassign the Mission');
  assert.equal(unsupportedAdapter.sends, 0);

  const afterFiles = {
    project: await fs.readdir(projectDirectory),
    task: await fs.readdir(taskDirectory),
  };
  assert.deepEqual(afterFiles, beforeFiles, 'WO#2 materialization must not create a capability-routing journal');
  assert.equal(apiAdapter.sends + nativeAdapter.sends + unsupportedAdapter.sends + restartedApiAdapter.sends, 0, 'all fake focused materialization paths must perform zero sends');
  assert.equal(realApiRuntime.runAgentCalls, 0, 'real API adapter must receive zero sends');
  assert.equal(webCommands.calls.filter(call => call.command === '_shuncode.webMcp.workerSend').length, 0, 'real Web path must receive zero sends');

  console.log('[smoke] Phase 8 Mission Capability Catalog/schema mapping/transport/grant/budget/restart/no-side-effect proofs ok');
} finally {
  await Promise.all([
    fs.rm(projectDirectory, { recursive: true, force: true }),
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
