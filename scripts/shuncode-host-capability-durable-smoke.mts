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
  logLevel: 'silent',
});

const { HostCapabilityExecutionCoordinator, TaskHostCapabilityExecutionStore, TaskRuntime } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

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

  console.log('[smoke] durable host claim/result/delivery restart recovery + ambiguous crash guard ok');
} finally {
  await Promise.all([
    fs.rm(directory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
