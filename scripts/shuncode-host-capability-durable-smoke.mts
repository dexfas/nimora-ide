import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-host-capability-durable-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-host-capability-durable-bundle-'));
const bundlePath = path.join(bundleDirectory, 'durable-host-execution.mjs');

await esbuild.build({
  stdin: {
    contents: `
      export { HostCapabilityExecutionCoordinator } from './src/host-capability-execution-coordinator.ts';
      export { TaskHostCapabilityExecutionStore } from './src/task-host-capability-execution-store.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
      export { FileToolHostCapabilityExecutor } from './src/file-host-capability-executor.ts';
      export { projectHostCapabilityArtifacts } from './extensions/shuncode/src/task-host-capability-artifacts.ts';
    `,
    resolveDir: root,
    sourcefile: 'durable-host-execution-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['es2022'],
  plugins: [{ name: 'actual-ripgrep-path', setup(build) {
    build.onResolve({ filter: /^@vscode\/ripgrep$/ }, () => ({ path: 'actual-ripgrep-path', namespace: 'actual-ripgrep-path' }));
    build.onLoad({ filter: /.*/, namespace: 'actual-ripgrep-path' }, () => ({
      contents: `export const rgPath = ${JSON.stringify(require('@vscode/ripgrep').rgPath)};`, loader: 'js',
    }));
  } }],
  logLevel: 'silent',
});

const { HostCapabilityExecutionCoordinator, TaskHostCapabilityExecutionStore, TaskRuntime, FileToolHostCapabilityExecutor, projectHostCapabilityArtifacts } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

const requestFor = (taskId, executionId = 'durable-exec-1', callId = 'durable-call-1') => ({
  executionId,
  managedSessionId: 'managed-1',
  workerId: 'nimora.web-worker',
  taskId,
  inputId: 'turn-1',
  callId,
  name: 'read_files',
  arguments: { files: [{ path: 'README.md' }] },
});

try {
  const runtime1 = new TaskRuntime({ storageDirectory: directory });
  await runtime1.initialize();
  const task = await runtime1.ensureTask({ kind: 'bridge', key: 'durable-host-smoke' }, 'Durable host execution');
  const request = requestFor(task.taskId);
  let executions1 = 0;
  let authorizations1 = 0;
  const coordinator1 = new HostCapabilityExecutionCoordinator({
    durableStore: new TaskHostCapabilityExecutionStore(runtime1),
    authorizer: { async authorize() { authorizations1 += 1; } },
    executor: { async execute() { executions1 += 1; return { text: 'DURABLE_RESULT_OK' }; } },
  });

  const first = await coordinator1.executeOnce(request);
  assert.equal(first.text, 'DURABLE_RESULT_OK');
  assert.equal(authorizations1, 1);
  assert.equal(executions1, 1);
  const durableExecution = runtime1.getTask(task.taskId).executions[request.executionId];
  assert.equal(durableExecution.status, 'succeeded');
  assert.equal(durableExecution.deliveryStatus, 'pending');
  assert.equal(durableExecution.resultPayload.text, 'DURABLE_RESULT_OK');

  const runtime2 = new TaskRuntime({ storageDirectory: directory });
  await runtime2.initialize();
  let executions2 = 0;
  let authorizations2 = 0;
  let deliveries2 = 0;
  const coordinator2 = new HostCapabilityExecutionCoordinator({
    durableStore: new TaskHostCapabilityExecutionStore(runtime2),
    authorizer: { async authorize() { authorizations2 += 1; } },
    executor: { async execute() { executions2 += 1; throw new Error('must not re-execute recovered result'); } },
  });
  const recovered = await coordinator2.executeOnce(request);
  assert.equal(recovered.text, 'DURABLE_RESULT_OK');
  assert.equal(authorizations2, 0, 'durable completed execution should recover before authorization');
  assert.equal(executions2, 0, 'restart recovery must not execute the capability again');
  await coordinator2.deliverResult(request, {
    async submitCapabilityResult(_managedSessionId, result) {
      deliveries2 += 1;
      assert.equal(result.text, 'DURABLE_RESULT_OK');
    },
  });
  assert.equal(deliveries2, 1);
  assert.equal(runtime2.getTask(task.taskId).executions[request.executionId].deliveryStatus, 'delivered');

  const runtime3 = new TaskRuntime({ storageDirectory: directory });
  await runtime3.initialize();
  let executions3 = 0;
  let deliveries3 = 0;
  const coordinator3 = new HostCapabilityExecutionCoordinator({
    durableStore: new TaskHostCapabilityExecutionStore(runtime3),
    authorizer: { async authorize() { throw new Error('delivered execution must not authorize again'); } },
    executor: { async execute() { executions3 += 1; return { text: 'bad' }; } },
  });
  await coordinator3.deliverResult(request, { async submitCapabilityResult() { deliveries3 += 1; } });
  assert.equal(executions3, 0);
  assert.equal(deliveries3, 0, 'durably delivered result must not be delivered twice after restart');

  const ambiguousRequest = requestFor(task.taskId, 'durable-ambiguous-1', 'durable-ambiguous-call');
  await runtime3.claimExecution(task.taskId, {
    executionId: ambiguousRequest.executionId,
    toolName: ambiguousRequest.name,
    capabilityId: 'workspace.read-files',
    risk: 'read',
    arguments: ambiguousRequest.arguments,
    origin: {
      kind: 'worker', managedSessionId: ambiguousRequest.managedSessionId, workerId: ambiguousRequest.workerId,
      inputId: ambiguousRequest.inputId, callId: ambiguousRequest.callId,
    },
  });
  const runtime4 = new TaskRuntime({ storageDirectory: directory });
  await runtime4.initialize();
  let ambiguousExecutions = 0;
  const coordinator4 = new HostCapabilityExecutionCoordinator({
    durableStore: new TaskHostCapabilityExecutionStore(runtime4),
    authorizer: { async authorize() { throw new Error('ambiguous recovery must stop before authorization'); } },
    executor: { async execute() { ambiguousExecutions += 1; return { text: 'bad' }; } },
  });
  await assert.rejects(() => coordinator4.executeOnce(ambiguousRequest), /ambiguous and will not be automatically re-executed/);
  assert.equal(ambiguousExecutions, 0);

  const resultFailureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-host-result-failure-'));
  const failureRuntime = new TaskRuntime({ storageDirectory: resultFailureDirectory });
  await failureRuntime.initialize();
  const failureTask = await failureRuntime.ensureTask({ kind: 'bridge', key: 'durable-result-failure' }, 'Durable result failure');
  const failureRequest = requestFor(failureTask.taskId, 'durable-result-failure-1', 'durable-result-failure-call');
  let failureExecutions = 0;
  const failureCoordinator = new HostCapabilityExecutionCoordinator({
    durableStore: new TaskHostCapabilityExecutionStore(failureRuntime),
    authorizer: { async authorize() {} },
    executor: {
      async execute() {
        failureExecutions += 1;
        await fs.rm(resultFailureDirectory, { recursive: true, force: true });
        await fs.writeFile(resultFailureDirectory, 'block durable result write', 'utf8');
        return { text: 'EXECUTED_BUT_UNPERSISTED' };
      },
    },
  });
  await assert.rejects(() => failureCoordinator.executeOnce(failureRequest), /automatic re-execution is forbidden/);
  assert.equal(failureExecutions, 1);
  await assert.rejects(() => failureCoordinator.executeOnce(failureRequest), /ambiguous and automatic continuation is forbidden/);
  assert.equal(failureExecutions, 1, 'volatile result must never permit a second side-effect execution');
  await fs.rm(resultFailureDirectory, { force: true });

  // Actual file executor -> canonical Task artifacts -> replay. The executor
  // performs a real bounded patch in a temporary workspace, exactly once.
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, 'artifact.txt'), 'BEFORE\n');
  const artifactTask = await runtime4.ensureTask({ kind: 'bridge', key: 'durable-artifacts' }, 'Artifact ownership');
  const artifactStore = new TaskHostCapabilityExecutionStore(runtime4, projectHostCapabilityArtifacts);
  const fileExecutor = new FileToolHostCapabilityExecutor({ workspaceRoots: () => [workspace] });
  let artifactExecutions = 0;
  let artifactResult;
  const artifactCoordinator = new HostCapabilityExecutionCoordinator({
    durableStore: artifactStore,
    authorizer: { async authorize() {} },
    executor: { async execute(input, capability) {
      artifactExecutions += 1;
      const result = await fileExecutor.execute(input, capability);
      artifactResult = { ...result, inputId: input.inputId, callId: input.callId, name: input.name };
      return result;
    } },
  });
  const patchRequest = {
    ...requestFor(artifactTask.taskId, 'artifact-patch', 'artifact-patch-call'),
    name: 'apply_patch',
    arguments: { patch: '*** Begin Patch\n*** Update File: artifact.txt\n@@\n-BEFORE\n+AFTER\n*** End Patch' },
  };
  await artifactCoordinator.executeOnce(patchRequest);
  assert.equal(await fs.readFile(path.join(workspace, 'artifact.txt'), 'utf8'), 'AFTER\n');
  const changeset = runtime4.getTask(artifactTask.taskId).artifacts[0];
  assert.equal(changeset.kind, 'changeset');
  assert.equal(changeset.executionId, patchRequest.executionId);
  assert.ok(changeset.metadata.content.includes('+AFTER'));
  assert.ok(changeset.metadata.files.some(file => file.endsWith('artifact.txt')));
  // Optional undefined builder fields and property ordering must not make an
  // identical persisted artifact collide during result admission recovery.
  await artifactStore.recordResult(patchRequest, {}, artifactResult);
  assert.equal(runtime4.getTask(artifactTask.taskId).artifacts.length, 1);
  const readRequest = requestFor(artifactTask.taskId, 'artifact-read', 'artifact-read-call');
  readRequest.arguments = { files: [{ path: 'artifact.txt' }] };
  await artifactCoordinator.executeOnce(readRequest);
  assert.equal(runtime4.getTask(artifactTask.taskId).artifacts[1].kind, 'file');
  assert.equal(artifactExecutions, 2);
  const artifactReplay = new TaskRuntime({ storageDirectory: directory });
  await artifactReplay.initialize();
  assert.deepEqual(artifactReplay.getTask(artifactTask.taskId).artifacts, runtime4.getTask(artifactTask.taskId).artifacts);
  const replayCoordinator = new HostCapabilityExecutionCoordinator({
    durableStore: new TaskHostCapabilityExecutionStore(artifactReplay, projectHostCapabilityArtifacts),
    authorizer: { async authorize() { throw new Error('must recover before authorization'); } },
    executor: { async execute() { throw new Error('must not reapply patch'); } },
  });
  await replayCoordinator.executeOnce(patchRequest);
  assert.equal(artifactReplay.getTask(artifactTask.taskId).artifacts.length, 2);

  // Fail at the artifact journal write, after the real executor and durable
  // execution finish. This must prevent result admission and automatic replay.
  const artifactFailureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-artifact-failure-'));
  try {
    const artifactFailureRuntime = new TaskRuntime({
      storageDirectory: artifactFailureDirectory,
      onDidChange(_task, event) {
        if (event.type === 'TaskExecutionFinished') {
          artifactFailureRuntime.recordArtifactStrict = async () => { throw new Error('artifact persistence unavailable'); };
        }
      },
    });
    await artifactFailureRuntime.initialize();
    const failedTask = await artifactFailureRuntime.ensureTask({ kind: 'bridge', key: 'artifact-failure' });
    const failedRequest = requestFor(failedTask.taskId, 'artifact-failure', 'artifact-failure-call');
    let writes = 0;
    const failure = new HostCapabilityExecutionCoordinator({
      durableStore: new TaskHostCapabilityExecutionStore(artifactFailureRuntime, projectHostCapabilityArtifacts),
      authorizer: { async authorize() {} },
      executor: { async execute() { writes += 1; return { text: 'actual result', data: { files: [{ path: 'artifact.txt', status: 'success' }] } }; } },
    });
    await assert.rejects(() => failure.executeOnce(failedRequest), /automatic re-execution is forbidden/);
    assert.equal(artifactFailureRuntime.getTask(failedTask.taskId).artifacts.length, 0);
    assert.equal(artifactFailureRuntime.getTask(failedTask.taskId).executions[failedRequest.executionId].resultPayload, undefined);
    await assert.rejects(() => failure.executeOnce(failedRequest), /ambiguous/);
    const failedReplay = new TaskRuntime({ storageDirectory: artifactFailureDirectory });
    await failedReplay.initialize();
    assert.equal((await new TaskHostCapabilityExecutionStore(failedReplay).recover(failedRequest, { id: 'workspace.read-files', risk: 'read' })).state, 'ambiguous');
    assert.equal(writes, 1);
  } finally {
    await fs.rm(artifactFailureDirectory, { recursive: true, force: true });
  }
  console.log('[smoke] durable results/artifacts survive restart; exact-once patch and artifact failure guard ok');
} finally {
  await Promise.all([
    fs.rm(directory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
