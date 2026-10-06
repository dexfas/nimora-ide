import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once, EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const esbuild = require('esbuild');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p11-delivery-'));
const bounded = <T>(promise: Promise<T>) => Promise.race([promise, new Promise<never>((_, reject) => {
  const timer = setTimeout(() => reject(new Error('delivery test timeout')), 5000); timer.unref();
})]);
try {
  const bundle = path.join(temp, 'test.cjs');
  await esbuild.build({ stdin: { contents: [
    "export { ProjectStore } from './src/project-store.ts';",
    "export { TaskRuntime } from './src/task-runtime.ts';",
    "export { WorkerSessionManager } from './src/worker-session-manager.ts';",
    "export { MissionCapabilityMaterializer } from './src/mission-capability-materializer.ts';",
    "export { HostCapabilityExecutionCoordinator } from './src/host-capability-execution-coordinator.ts';",
    "export { TaskHostCapabilityExecutionStore } from './src/task-host-capability-execution-store.ts';",
    "export { CapabilityMetadataHostAuthorizer } from './src/host-capability-policy-authorizer.ts';",
    "export { TaskCapabilityGrantResolver } from './src/task-capability-grant-resolver.ts';",
    "export { FileToolHostCapabilityExecutor } from './src/file-host-capability-executor.ts';",
    "export { SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES, shunCodeMissionCapabilityExecutionRoutes } from './extensions/shuncode/src/bridge-task-tool-definitions.ts';",
    "export { MissionNativeMcpBindingService } from './extensions/shuncode/src/mission-native-mcp-binding.ts';",
    "export { MissionNativeMcpRequestContext } from './extensions/shuncode/src/mission-native-mcp-request-context.ts';",
    "export { BridgeManager } from './extensions/shuncode/src/bridge-server.ts';",
  ].join('\n'), resolveDir: root, loader: 'ts' }, outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
    plugins: [{ name: 'vscode-fixture', setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export class EventEmitter { event = () => ({ dispose() {} }); fire() {} dispose() {} }', loader: 'js' }));
    } }],
  });
  const api = require(bundle);
  const modes: string[] = [];
  for (const mode of ['cloudflare', 'ngrok', 'modern']) {
    const directory = path.join(temp, mode);
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'fixture.txt'), 'BEFORE\n');
    let sequence = 0, writes = 0;
    const newId = () => `${mode}-${++sequence}`;
    const taskDirectory = path.join(directory, 'tasks');
    const projects = new api.ProjectStore({ storageDirectory: path.join(directory, 'projects'), newId });
    const tasks = new api.TaskRuntime({ storageDirectory: taskDirectory, newId });
    const project = await projects.createProject({ title: 'Disposable HTTP delivery fixture' });
    const mission = await tasks.ensureTask({ kind: 'mission', key: 'http-delivery' }, 'READ WRITE VALIDATE');
    await tasks.configureMission(mission.taskId, { projectId: project.projectId, rootMissionId: mission.taskId, plane: 'practice', missionType: 'test', completionCriteria: ['HTTP submission preserves execution identity'] });
    const workers = new api.WorkerSessionManager({ taskBindings: tasks, executionProjection: tasks, newId });
    const workerId = 'nimora.chatgpt-browser-worker';
    await workers.register({
      async describe() { return { id: workerId, provider: 'openai-chatgpt', kind: 'web', label: 'Test only', availability: 'available', models: ['test'],
        capabilities: { streaming: true, reasoning: false, capabilityRequests: false, imageInput: false, checkpoints: false, interruption: true, persistentContext: true },
        capabilityProjection: { nativeByName: true, externalDefinitions: false, executionRoutes: api.shunCodeMissionCapabilityExecutionRoutes('native-by-name', 'test', 'Test') } }; },
      async createSession() { return { sessionId: newId(), workerId, state: 'idle', createdAt: new Date().toISOString(), lastActiveAt: new Date().toISOString() }; },
      async *send(_session, input) { yield { type: 'terminal', inputId: input.inputId, status: 'completed' }; },
      async interrupt(session) { session.state = 'interrupted'; }, async dispose(session) { session.state = 'disposed'; },
    });
    const session = await workers.createSession(workerId, { model: 'test' }, mission.taskId);
    await tasks.grantCapabilityStrict(mission.taskId, { capabilityId: 'workspace.apply-patch', capabilityVersion: 1, scope: 'worker-session', managedSessionId: session.managedSessionId });
    const materializer = new api.MissionCapabilityMaterializer(projects, tasks, workers, api.SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES);
    const capability = await materializer.materialize({ projectId: project.projectId, rootMissionId: mission.taskId, missionId: mission.taskId, managedSessionId: session.managedSessionId,
      budget: { maxSchemaChars: 100000 }, constraints: { profile: 'research', requiredCapabilityIds: ['workspace.read-files', 'workspace.apply-patch'] } });
    const store = new api.TaskHostCapabilityExecutionStore(tasks);
    const files = new api.FileToolHostCapabilityExecutor({ workspaceRoots: () => [directory] });
    let failAck = false;
    let failedAckResolve!: () => void;
    const failedAck = new Promise<void>(resolve => { failedAckResolve = resolve; });
    const failures: string[] = [];
    const execution = new api.HostCapabilityExecutionCoordinator({
      durableStore: { recover: (...args) => store.recover(...args), claim: (...args) => store.claim(...args), recordResult: (...args) => store.recordResult(...args),
        async markDelivered(...args) { if (failAck) throw new Error('test durable ACK failure'); await store.markDelivered(...args); } },
      authorizer: new api.CapabilityMetadataHostAuthorizer(new api.TaskCapabilityGrantResolver(tasks)),
      executor: { execute(request, metadata, admission) { if (request.name === 'apply_patch') writes++; return files.execute(request, metadata, admission); } },
    });
    const native = new api.MissionNativeMcpBindingService(tasks, workers, execution, api.SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES, workerId, newId);
    const advertisement = await native.prepareAdvertisement({ projectId: project.projectId, rootMissionId: mission.taskId, missionId: mission.taskId, managedSessionId: session.managedSessionId, capability });
    await native.activateTurn({ ...advertisement, projectId: project.projectId, rootMissionId: mission.taskId, missionId: mission.taskId, managedSessionId: session.managedSessionId, inputId: 'one-test-input', capability });
    const bridge = new api.BridgeManager({ extension: { packageJSON: { version: 'test' } } }, { appendLine(message) { if (message.includes('submission confirmation failed')) { failures.push(message); failedAckResolve(); } } }, {}, {}, async () => {}, native);
    bridge.tunnelProvider = mode;
    const http = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (mode === 'modern') await bridge.handleModernPost(request, response, body, advertisement.token);
        else await bridge.handlePost(request, response, body, request.headers['mcp-session-id'], advertisement.token);
      } catch (error) { if (!response.destroyed && !response.writableEnded) { response.statusCode = 500; response.end(String(error)); } }
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    let headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const url = `http://127.0.0.1:${(http.address() as any).port}/mcp`;
    const post = async body => {
      const modernHeaders = mode === 'modern' ? { 'MCP-Protocol-Version': '2026-07-28', 'MCP-Method': body.method,
        ...(body.params?.name ? { 'MCP-Name': body.params.name } : {}) } : {};
      if (mode === 'modern') body = { ...body, params: { ...body.params, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'disposable-modern-fixture', version: '1' },
        'io.modelcontextprotocol/clientCapabilities': {},
      } } };
      const response = await fetch(url, { method: 'POST', headers: { ...headers, ...modernHeaders }, signal: AbortSignal.timeout(5000), body: JSON.stringify(body) });
      const text = await response.text();
      return { response, text };
    };
    try {
      if (mode !== 'modern') {
      const initialized = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
      assert.equal(initialized.response.status, 200);
      headers = { ...headers, 'mcp-session-id': initialized.response.headers.get('mcp-session-id')! };
      assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).response.status, 202);
      } else {
        assert.match((await post({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).text, /read_files/);
        assert.equal(bridge.sessions.size, 0, 'modern route needs no initialize/session registry');
      }
      for (const [id, name, args, expected] of [
        [2, 'read_files', { files: [{ path: 'fixture.txt' }] }, /BEFORE/],
        [3, 'apply_patch', { patch: '*** Begin Patch\n*** Update File: fixture.txt\n@@\n-BEFORE\n+AFTER\n*** End Patch' }, /status: success/],
        [4, 'read_files', { files: [{ path: 'fixture.txt' }] }, /AFTER/],
      ] as const) {
        const result = await post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
        assert.equal(result.response.status, 200);
        assert.match(result.text, expected);
        // SDK send may resolve after the client finishes consuming the response.
        await bounded((async () => {
          while (Object.values(tasks.getTask(mission.taskId).executions).some((item: any) => item.deliveryStatus === 'pending')) await new Promise(resolve => setTimeout(resolve, 10));
        })()).catch(error => { console.error({ mode, id, text: result.text, executions: tasks.getTask(mission.taskId).executions, failures }); throw error; });
      }
      const beforeFailure = tasks.getTask(mission.taskId);
      const executions: any[] = Object.values(beforeFailure.executions);
      assert.equal(executions.length, 3);
      assert(executions.every(item => item.status === 'succeeded' && item.deliveryStatus === 'delivered'));
      assert.equal(writes, 1);
      assert.equal(await fs.readFile(path.join(directory, 'fixture.txt'), 'utf8'), 'AFTER\n');
      assert.equal(failures.length, 0);
      await tasks.flush();
      const restored = new api.TaskRuntime({ storageDirectory: taskDirectory, newId });
      await restored.initialize();
      assert.deepEqual(restored.getTask(mission.taskId).executions, executions.reduce((result, item) => ({ ...result, [item.executionId]: item }), {}));
      failAck = true;
      assert.match((await post({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read_files', arguments: { files: [{ path: 'fixture.txt' }] } } })).text, /AFTER/);
      await bounded(failedAck);
      assert.match(failures.join('\n'), /durable delivery confirmation failed/);
      const pending: any = Object.values(tasks.getTask(mission.taskId).executions).find((item: any) => item.deliveryStatus === 'pending');
      assert(pending);
      assert.equal(execution.getState(pending.executionId).phase, 'ambiguous');
      assert.equal(writes, 1);
      modes.push(mode === 'modern' ? 'modern-json' : mode === 'cloudflare' ? 'json' : 'sse');
    } finally {
      for (const session of bridge.sessions.values()) { await session.server.close(); await session.transport.close(); }
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  }

  // Isolate the submission gate: both orders, typed IDs, payload, errors,
  // cancellation and HTTP status must be checked independently of execution.
  const payload = { content: [{ type: 'text', text: 'exact' }] };
  for (const variant of ['finish-first', 'send-first', 'wrong-id-type', 'wrong-payload', 'rpc-error', '204', '500', 'cancel', 'no-send', 'no-finish']) {
    const context = new api.MissionNativeMcpRequestContext();
    const request: any = new EventEmitter();
    request.aborted = false;
    const response: any = new EventEmitter();
    response.destroyed = false; response.writableFinished = false;
    response.statusCode = variant === '204' ? 204 : variant === '500' ? 500 : 200;
    response.getHeader = () => 'application/json';
    let confirmations = 0;
    await context.run(request, response, async () => {
      context.prepareSubmission(7, payload, async () => { confirmations++; });
      const finish = () => { response.writableFinished = true; response.emit('finish'); };
      if (variant === 'cancel') response.emit('close');
      if (variant === 'finish-first') finish();
      const message = { jsonrpc: '2.0', id: variant === 'wrong-id-type' ? '7' : 7,
        ...(variant === 'rpc-error' ? { error: { code: -32603, message: 'error' } } : { result: variant === 'wrong-payload' ? { content: [] } : payload }) };
      if (variant !== 'no-send') await context.observeSentResponse(message);
      if (variant !== 'finish-first' && variant !== 'no-finish') finish();
      if (variant !== 'no-send') await context.observeSentResponse(message); // duplicate SDK notification is not a second ACK
    });
    assert.equal(confirmations, ['finish-first', 'send-first'].includes(variant) ? 1 : 0, variant);
  }
  console.log(JSON.stringify({ result: 'PASS', actualNativeBindingAndBridgeHttpModes: modes, readWriteValidateDelivered: true, writesPerMode: 1, durableRestartParity: true, durableAckFailureRemainsBlocked: true, submissionGateNegativeCases: true, providerReceiptClaimed: false }, null, 2));
} finally { await fs.rm(temp, { recursive: true, force: true }); }
