import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p11-native-mcp-bundle-'));
const projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p11-native-mcp-project-'));
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p11-native-mcp-task-'));
const workspaceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p11-native-mcp-workspace-'));
const bundlePath = path.join(bundleDirectory, 'phase11-native-mcp.cjs');

await fs.writeFile(path.join(workspaceDirectory, 'README.md'), 'PHASE11_NATIVE_MCP_READ_SENTINEL\n', 'utf8');

await esbuild.build({
  stdin: {
    contents: `
      export { ProjectStore } from './src/project-store.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
      export { WorkerSessionManager } from './src/worker-session-manager.ts';
      export { MissionCapabilityMaterializer } from './src/mission-capability-materializer.ts';
      export { HostCapabilityExecutionCoordinator } from './src/host-capability-execution-coordinator.ts';
      export { TaskHostCapabilityExecutionStore } from './src/task-host-capability-execution-store.ts';
      export { CapabilityMetadataHostAuthorizer } from './src/host-capability-policy-authorizer.ts';
      export { TaskCapabilityGrantResolver } from './src/task-capability-grant-resolver.ts';
      export { FileToolHostCapabilityExecutor } from './src/file-host-capability-executor.ts';
      export {
        SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES,
        shunCodeMissionCapabilityExecutionRoutes,
      } from './extensions/shuncode/src/bridge-task-tool-definitions.ts';
      export { MissionNativeMcpBindingService } from './extensions/shuncode/src/mission-native-mcp-binding.ts';
    `,
    resolveDir: root,
    sourcefile: 'phase11-native-mcp-entry.ts',
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
  HostCapabilityExecutionCoordinator,
  TaskHostCapabilityExecutionStore,
  CapabilityMetadataHostAuthorizer,
  TaskCapabilityGrantResolver,
  FileToolHostCapabilityExecutor,
  SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES,
  shunCodeMissionCapabilityExecutionRoutes,
  MissionNativeMcpBindingService,
} = require(bundlePath);

const FIXED_AT = '2026-09-18T12:00:00.000Z';
const PROVIDER_TRANSCRIPT_SENTINEL = 'PHASE11_PROVIDER_TRANSCRIPT_MUST_NOT_PERSIST';
let nativeSessionSequence = 0;

class ChatGptNativeFakeAdapter {
  async describe() {
    return {
      id: 'nimora.chatgpt-browser-worker',
      provider: 'openai-chatgpt',
      kind: 'web',
      label: 'ChatGPT deterministic native MCP fixture',
      availability: 'available',
      models: ['chatgpt-web'],
      capabilities: {
        streaming: true,
        reasoning: false,
        capabilityRequests: false,
        imageInput: false,
        checkpoints: false,
        interruption: true,
        persistentContext: true,
      },
      capabilityProjection: {
        nativeByName: true,
        externalDefinitions: false,
        executionRoutes: shunCodeMissionCapabilityExecutionRoutes(
          'native-by-name',
          'phase11-native-mcp',
          'Fresh deterministic Phase 11 Mission-native MCP proof.',
        ),
      },
    };
  }

  async createSession(options) {
    return {
      sessionId: `chatgpt-provider-session-${++nativeSessionSequence}`,
      workerId: 'nimora.chatgpt-browser-worker',
      state: 'idle',
      model: options.model,
      contextHandle: options.contextHandle,
      createdAt: FIXED_AT,
      lastActiveAt: FIXED_AT,
    };
  }

  async *send(_session, input) {
    yield { type: 'terminal', inputId: input.inputId, status: 'completed' };
  }

  async interrupt(session) { session.state = 'interrupted'; }
  async dispose(session) { session.state = 'disposed'; }
  async health() { return { status: 'healthy', checkedAt: FIXED_AT }; }
}

try {
  const projects = new ProjectStore({
    storageDirectory: projectDirectory,
    newId: () => 'p11-project-1',
    now: () => new Date(FIXED_AT),
  });
  const tasks = new TaskRuntime({
    storageDirectory: taskDirectory,
    newId: (() => {
      let sequence = 0;
      return () => `p11-task-${++sequence}`;
    })(),
    now: () => new Date(FIXED_AT),
  });
  await Promise.all([projects.initialize(), tasks.initialize()]);

  const project = await projects.createProject({ title: 'Phase 11 native MCP proof' });
  const rootTask = await tasks.ensureTask({ kind: 'mission', key: 'p11-native-root' }, 'Native MCP exact Mission root.');
  const mission = await tasks.configureMission(rootTask.taskId, {
    projectId: project.projectId,
    rootMissionId: rootTask.taskId,
    plane: 'cognition',
    missionType: 'phase11-native-mcp',
    completionCriteria: ['Bound native MCP to exact current WorkerSession.'],
  });

  let managedSequence = 0;
  const workers = new WorkerSessionManager({
    taskBindings: tasks,
    executionProjection: tasks,
    newId: () => `p11-managed-${++managedSequence}`,
    now: () => new Date(FIXED_AT),
  });
  await workers.register(new ChatGptNativeFakeAdapter());
  const session = await workers.createSession('nimora.chatgpt-browser-worker', {
    model: 'chatgpt-web',
    contextHandle: PROVIDER_TRANSCRIPT_SENTINEL,
  }, mission.taskId);

  const materializer = new MissionCapabilityMaterializer(
    projects,
    tasks,
    workers,
    SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES,
  );
  const capability = await materializer.materialize({
    projectId: project.projectId,
    rootMissionId: mission.taskId,
    missionId: mission.taskId,
    managedSessionId: session.managedSessionId,
    budget: { maxSchemaChars: 100_000 },
    constraints: {
      profile: 'research',
      requiredCapabilityIds: ['workspace.read-files'],
    },
    generatedAt: FIXED_AT,
  });
  assert.ok(capability.allowedCapabilities.includes('read_files'));
  assert.equal(capability.allowedCapabilities.includes('apply_patch'), false);
  assert.ok(capability.inspector.mappings.every(mapping => mapping.projectionMode === 'native-by-name'));

  const execution = new HostCapabilityExecutionCoordinator({
    durableStore: new TaskHostCapabilityExecutionStore(tasks),
    authorizer: new CapabilityMetadataHostAuthorizer(new TaskCapabilityGrantResolver(tasks)),
    executor: new FileToolHostCapabilityExecutor({ workspaceRoots: () => [workspaceDirectory] }),
    now: () => Date.parse(FIXED_AT),
  });
  let bindingSequence = 0;
  const nativeMcp = new MissionNativeMcpBindingService(
    tasks,
    workers,
    execution,
    SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES,
    'nimora.chatgpt-browser-worker',
    () => `p11-native-binding-token-${++bindingSequence}`,
  );

  const advertised = await nativeMcp.prepareAdvertisement({
    projectId: project.projectId,
    rootMissionId: mission.taskId,
    missionId: mission.taskId,
    managedSessionId: session.managedSessionId,
    capability,
  });
  assert.equal(advertised.token, 'p11-native-binding-token-1');
  assert.equal(
    nativeMcp.getBindingForMission(mission.taskId)?.token,
    advertised.token,
    'stable Mission lookup must resolve the current exact ephemeral binding',
  );
  const advertisedTools = await nativeMcp.listTools(advertised.token);
  assert.deepEqual(
    advertisedTools.map(tool => tool.name).sort(),
    [...capability.allowedCapabilities].sort(),
    'native MCP advertisement must be the exact Phase-8 materialized set',
  );
  assert.equal(advertisedTools.some(tool => tool.name === 'apply_patch'), false, 'global Bridge write tools must not leak into research scope');

  // R16 Mission-native MCP anomaly probe: an unrelated Coordinator admission
  // failure that never activates a Target turn must not erase the prepared
  // advertisement for the same managed Worker generation/binding token.
  nativeMcp.clearTurn(session.managedSessionId, 'p11-unrelated-coordinator-admission-failure');
  const advertisedAfterUnrelatedFailure = await nativeMcp.listTools(advertised.token);
  assert.deepEqual(
    advertisedAfterUnrelatedFailure.map(tool => tool.name).sort(),
    [...capability.allowedCapabilities].sort(),
    'prepared native MCP advertisement must survive an unrelated failed Coordinator admission with no Target activation',
  );

  await nativeMcp.activateTurn({
    projectId: project.projectId,
    rootMissionId: mission.taskId,
    missionId: mission.taskId,
    managedSessionId: session.managedSessionId,
    inputId: 'p11-native-turn-1',
    capability,
  });

  const first = await nativeMcp.callTool(
    advertised.token,
    'protocol-session-A',
    '1',
    'read_files',
    { files: [{ path: 'README.md' }] },
  );
  assert.match(first.content[0].text, /PHASE11_NATIVE_MCP_READ_SENTINEL/);

  const second = await nativeMcp.callTool(
    advertised.token,
    'protocol-session-B',
    '1',
    'read_files',
    { files: [{ path: 'README.md' }] },
  );
  assert.match(second.content[0].text, /PHASE11_NATIVE_MCP_READ_SENTINEL/);

  const durableAfterReads = tasks.getTask(mission.taskId);
  const nativeExecutions = Object.values(durableAfterReads.executions)
    .filter(item => item.executionId.startsWith('native-mcp:'));
  assert.equal(nativeExecutions.length, 2, 'two MCP protocol sessions reusing request id 1 must have distinct durable execution identities');
  assert.equal(new Set(nativeExecutions.map(item => item.executionId)).size, 2);
  assert.ok(nativeExecutions.every(item => item.origin?.managedSessionId === session.managedSessionId));
  assert.ok(nativeExecutions.every(item => item.origin?.workerId === 'nimora.chatgpt-browser-worker'));
  assert.ok(nativeExecutions.every(item => item.origin?.inputId === 'p11-native-turn-1'));
  assert.ok(nativeExecutions.every(item => item.status === 'succeeded'));
  assert.ok(nativeExecutions.every(item => item.deliveryStatus === 'pending'), 'native MCP HTTP response preparation is not falsely credited as transport delivery acknowledgement');

  await assert.rejects(
    () => nativeMcp.callTool(
      advertised.token,
      'protocol-session-A',
      '2',
      'apply_patch',
      { patch: '*** Begin Patch\n*** End Patch' },
    ),
    /outside the exact active Mission-native MCP scope/,
  );
  assert.equal(
    Object.values(tasks.getTask(mission.taskId).executions).some(item => item.toolName === 'apply_patch'),
    false,
    'out-of-scope native MCP call must be rejected before durable execution claim',
  );

  await tasks.grantCapabilityStrict(mission.taskId, {
    capabilityId: 'workspace.apply-patch',
    capabilityVersion: 1,
    scope: 'worker-session',
    managedSessionId: session.managedSessionId,
  });
  const writeCapability = await materializer.materialize({
    projectId: project.projectId,
    rootMissionId: mission.taskId,
    missionId: mission.taskId,
    managedSessionId: session.managedSessionId,
    budget: { maxSchemaChars: 100_000 },
    constraints: {
      profile: 'research',
      requiredCapabilityIds: ['workspace.apply-patch'],
    },
    generatedAt: FIXED_AT,
  });
  assert.ok(writeCapability.allowedCapabilities.includes('apply_patch'));
  await nativeMcp.activateTurn({
    projectId: project.projectId,
    rootMissionId: mission.taskId,
    missionId: mission.taskId,
    managedSessionId: session.managedSessionId,
    inputId: 'p11-native-write-turn',
    capability: writeCapability,
  });
  const writePatch = '*** Begin Patch\n*** Update File: README.md\n@@\n-PHASE11_NATIVE_MCP_READ_SENTINEL\n+PHASE11_NATIVE_MCP_WRITE_ONCE\n*** End Patch';
  const firstWrite = await nativeMcp.callTool(
    advertised.token,
    'protocol-write-session-A',
    '1',
    'apply_patch',
    { patch: writePatch },
  );
  assert.equal(firstWrite.isError, undefined);
  assert.match(firstWrite.content[0].text, /status: success/);
  const exactWriteResultRetry = await nativeMcp.callTool(
    advertised.token,
    'protocol-write-session-A',
    '1',
    'apply_patch',
    { patch: writePatch },
  );
  assert.deepEqual(exactWriteResultRetry, firstWrite, 'the exact protocol occurrence may only recover its existing result');
  await assert.rejects(() => nativeMcp.callTool(
    advertised.token,
    'protocol-write-session-B',
    '1',
    'apply_patch',
    { patch: writePatch },
  ), /distinct occurrence.*ambiguous/);
  await assert.rejects(() => nativeMcp.callTool(
    advertised.token, 'protocol-write-session-B', '2', 'apply_patch', { patch: writePatch },
  ), /distinct occurrence.*ambiguous/, 'a changed request id cannot authorize the same uncertain side effect either');
  assert.equal(await fs.readFile(path.join(workspaceDirectory, 'README.md'), 'utf8'), 'PHASE11_NATIVE_MCP_WRITE_ONCE\n');
  const writeExecutions = Object.values(tasks.getTask(mission.taskId).executions).filter(item => item.toolName === 'apply_patch');
  assert.equal(writeExecutions.length, 1, 'ambiguous reconnect occurrences must not claim execution or fabricate a cached success');

  // Reproduce the real approval race with canonical durable storage and actual
  // temporary workspace files. Ending authority while authorize/claim awaits
  // must prevent executor entry; cancelled occurrences cannot later revive.
  for (const boundary of ['turn-ended', 'http-cancelled', 'binding-retired', 'claim-await']) {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let executorEntries = 0;
    let claims = 0;
    const durableStore = new TaskHostCapabilityExecutionStore(tasks);
    const fileExecutor = new FileToolHostCapabilityExecutor({ workspaceRoots: () => [workspaceDirectory] });
    const guardedExecution = new HostCapabilityExecutionCoordinator({
      authorizer: { authorize: async () => {
        if (boundary !== 'claim-await') { enter(); await held; }
      } },
      durableStore: {
        recover: (request, metadata) => durableStore.recover(request, metadata),
        claim: async (request, metadata) => {
          claims++;
          const claimed = await durableStore.claim(request, metadata);
          if (boundary === 'claim-await') { enter(); await held; }
          return claimed;
        },
        recordResult: (request, metadata, result) => durableStore.recordResult(request, metadata, result),
        markDelivered: (request, metadata) => durableStore.markDelivered(request, metadata),
      },
      executor: { execute: (request, metadata, admission) => {
        executorEntries++;
        return fileExecutor.execute(request, metadata, admission);
      } },
    });
    const guardedMcp = new MissionNativeMcpBindingService(tasks, workers, guardedExecution, SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES);
    const inputId = `p11-approval-${boundary}`;
    const guardBinding = await guardedMcp.activateTurn({
      projectId: project.projectId, rootMissionId: mission.taskId, missionId: mission.taskId,
      managedSessionId: session.managedSessionId, inputId, capability: writeCapability,
    });
    const cancel = new AbortController();
    const args = { patch: '*** Begin Patch\n*** Update File: README.md\n@@\n-PHASE11_NATIVE_MCP_WRITE_ONCE\n+FALSIFIER_WRITE_AFTER_AUTHORITY_ENDED\n*** End Patch' };
    const outcome = guardedMcp.callTool(guardBinding.token, `protocol-${boundary}`, 7, 'apply_patch', args, cancel.signal)
      .then(value => ({ value }), error => ({ error }));
    await entered;
    if (boundary === 'binding-retired') guardedMcp.retireBinding(session.managedSessionId);
    else if (boundary === 'http-cancelled') cancel.abort();
    else guardedMcp.clearTurn(session.managedSessionId, inputId);
    release();
    const settled = await outcome;
    assert.equal(executorEntries, 0, `${boundary} must prevent actual executor entry after late approval/claim`);
    assert.equal(await fs.readFile(path.join(workspaceDirectory, 'README.md'), 'utf8'), 'PHASE11_NATIVE_MCP_WRITE_ONCE\n');
    const rows = Object.values(tasks.getTask(mission.taskId).executions).filter(row => row.origin?.inputId === inputId);
    if (boundary === 'claim-await') {
      assert.equal(claims, 1);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'failed', 'a claimed but revoked call must persist failure without pretending execution succeeded');
      assert.equal(rows[0].deliveryStatus, 'pending');
      assert.equal((settled as any).value?.isError, true);
    } else {
      assert.equal(claims, 0, 'revoked approval must not create a durable execution claim');
      assert.equal(rows.length, 0);
      assert.match(String((settled as any).error), /admission revoked/);
    }
    if (boundary === 'http-cancelled') {
      await assert.rejects(() => guardedMcp.callTool(guardBinding.token, `protocol-${boundary}`, 7, 'apply_patch', args), /rejected.*replay is forbidden/);
      assert.equal(executorEntries, 0, 'a fresh HTTP connection cannot revive the consumed rejected occurrence');
    }
  }

  // Reconstruct the ephemeral binding while retaining the canonical ledger.
  // An old same-input side effect with another occurrence must remain fenced.
  const reconstructed = new MissionNativeMcpBindingService(tasks, workers, execution, SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES);
  const reconstructedBinding = await reconstructed.activateTurn({
    projectId: project.projectId, rootMissionId: mission.taskId, missionId: mission.taskId,
    managedSessionId: session.managedSessionId, inputId: 'p11-native-write-turn', capability: writeCapability,
  });
  await assert.rejects(() => reconstructed.callTool(reconstructedBinding.token, 'fresh-protocol', 1, 'apply_patch', { patch: writePatch }), /distinct occurrence.*ambiguous/);
  assert.equal(Object.values(tasks.getTask(mission.taskId).executions).filter(row => row.origin?.inputId === 'p11-native-write-turn').length, 1);

  nativeMcp.clearTurn(session.managedSessionId, 'p11-native-write-turn');
  const advertisedAfterClearTurn = await nativeMcp.listTools(advertised.token);
  assert.deepEqual(
    advertisedAfterClearTurn.map(tool => tool.name).sort(),
    [...writeCapability.allowedCapabilities].sort(),
    'clearTurn must clear active execution authority without clearing the prepared advertisement',
  );
  await assert.rejects(
    () => nativeMcp.callTool(
      advertised.token,
      'protocol-session-A',
      '3',
      'read_files',
      { files: [{ path: 'README.md' }] },
    ),
    /no active Phase-8 capability turn/,
  );

  const durableText = JSON.stringify(tasks.getTask(mission.taskId));
  assert.equal(durableText.includes(PROVIDER_TRANSCRIPT_SENTINEL), false, 'provider-private transcript/context handle must not persist into Mission durable truth');

  const retired = await workers.retire(session.managedSessionId, { reason: 'Phase 11 deterministic replacement precondition.' });
  assert.equal(retired.managedSessionId, session.managedSessionId);
  assert.equal(nativeMcp.hasBindingToken(advertised.token), false, 'retired WorkerSession must invalidate Mission-native MCP token');
  assert.equal(nativeMcp.getBindingForMission(mission.taskId), undefined, 'stable Mission lookup must fail closed while no current binding exists');
  await assert.rejects(() => nativeMcp.listTools(advertised.token), /Unknown or retired Mission-native MCP binding/);

  const replacementSession = await workers.createSession('nimora.chatgpt-browser-worker', {
    model: 'chatgpt-web',
    contextHandle: 'replacement-provider-context',
  }, mission.taskId);
  const replacementCapability = await materializer.materialize({
    projectId: project.projectId,
    rootMissionId: mission.taskId,
    missionId: mission.taskId,
    managedSessionId: replacementSession.managedSessionId,
    budget: { maxSchemaChars: 100_000 },
    constraints: {
      profile: 'research',
      requiredCapabilityIds: ['workspace.read-files'],
    },
    generatedAt: FIXED_AT,
  });
  const replacementBinding = await nativeMcp.prepareAdvertisement({
    projectId: project.projectId,
    rootMissionId: mission.taskId,
    missionId: mission.taskId,
    managedSessionId: replacementSession.managedSessionId,
    capability: replacementCapability,
  });
  assert.equal(replacementBinding.token, 'p11-native-binding-token-2');
  assert.notEqual(replacementBinding.token, advertised.token, 'replacement Worker generation must get a new ephemeral binding token');
  assert.equal(
    nativeMcp.getBindingForMission(mission.taskId)?.token,
    replacementBinding.token,
    'stable Mission lookup must move to the replacement exact Worker generation',
  );
  assert.equal(nativeMcp.hasBindingToken(advertised.token), false, 'old generation token must stay retired after replacement');

  const restartedTasks = new TaskRuntime({ storageDirectory: taskDirectory });
  await restartedTasks.initialize();
  const restartedMission = restartedTasks.getTask(mission.taskId);
  assert.ok(restartedMission);
  assert.equal(JSON.stringify(restartedMission).includes(PROVIDER_TRANSCRIPT_SENTINEL), false);
  assert.ok(restartedMission.workerSessions[session.managedSessionId].retiredAt, 'retired provider-native generation must survive TaskRuntime restart');

  console.log(JSON.stringify({
    result: 'PASS',
    advertisedSetEqualsPhase8: true,
    globalToolLeak: false,
    exactMissionExecutionLedger: true,
    protocolRequestIdCollision: false,
    outsideScopeExecuted: false,
    advertisementSurvivesUnrelatedAdmissionFailure: true,
    advertisementSurvivesClearTurn: true,
    clearTurnAuthority: false,
    exactOccurrenceResultRecoveryOnly: true,
    retryNeverReconnectAmbiguityRejected: true,
    lateApprovalExecutorEntries: 0,
    cancelledOccurrenceRevival: false,
    postClaimRevocationPersistsFailure: true,
    retiredBindingUsable: false,
    stableMissionAliasTracksCurrentGeneration: true,
    stableMissionAliasRevivesOnlyAfterFreshBinding: true,
    providerTranscriptPersisted: false,
    restartRetirementPreserved: true,
  }, null, 2));
} finally {
  await Promise.all([
    fs.rm(bundleDirectory, { recursive: true, force: true }),
    fs.rm(projectDirectory, { recursive: true, force: true }),
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(workspaceDirectory, { recursive: true, force: true }),
  ]);
}
