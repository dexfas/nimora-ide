import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-capability-approval-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-capability-approval-bundle-'));
const bundlePath = path.join(bundleDirectory, 'approval-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { TaskRuntime } from './src/task-runtime.ts';
      export { PromptingTaskCapabilityGrantResolver } from './src/prompting-task-capability-grant-resolver.ts';
      export { CapabilityMetadataHostAuthorizer, HostCapabilityAuthorizationError } from './src/host-capability-policy-authorizer.ts';
      export { getCapabilityMetadata } from './src/capability-registry.ts';
    `,
    resolveDir: root,
    sourcefile: 'capability-approval-entry.ts',
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
  TaskRuntime,
  PromptingTaskCapabilityGrantResolver,
  CapabilityMetadataHostAuthorizer,
  HostCapabilityAuthorizationError,
  getCapabilityMetadata,
} = require(bundlePath);

const requestFor = (taskId, managedSessionId, executionId) => ({
  executionId,
  managedSessionId,
  workerId: 'nimora.web-worker',
  taskId,
  inputId: 'turn-approval',
  callId: `call-${executionId}`,
  name: 'run_command',
  arguments: { command: 'echo approval-smoke', background: false },
});

try {
  const runtime = new TaskRuntime({ storageDirectory: directory });
  await runtime.initialize();
  const task = await runtime.ensureTask({ kind: 'bridge', key: 'approval-task' }, 'Approval task');
  await runtime.attachWorkerSession(task.taskId, {
    managedSessionId: 'managed-approved', workerId: 'nimora.web-worker', adapterSessionId: 'page-approved',
  });
  await runtime.attachWorkerSession(task.taskId, {
    managedSessionId: 'managed-denied', workerId: 'nimora.web-worker', adapterSessionId: 'page-denied',
  });

  let approvePrompts = 0;
  let releasePrompt;
  const approvalGate = new Promise(resolve => { releasePrompt = resolve; });
  const approvingResolver = new PromptingTaskCapabilityGrantResolver(runtime, {
    async requestGrant(input) {
      approvePrompts += 1;
      assert.equal(input.capability.id, 'terminal.run-command');
      assert.equal(input.scope, 'worker-session');
      await approvalGate;
      return true;
    },
  });
  const runCommand = getCapabilityMetadata('run_command');
  const approvedRequest = requestFor(task.taskId, 'managed-approved', 'exec-approved');
  const concurrentA = approvingResolver.isGranted(approvedRequest, runCommand);
  const concurrentB = approvingResolver.isGranted({ ...approvedRequest, executionId: 'exec-approved-2' }, runCommand);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(approvePrompts, 1, 'same task/session/capability must share one pending approval prompt');
  releasePrompt();
  assert.deepEqual(await Promise.all([concurrentA, concurrentB]), [true, true]);
  assert.equal(Object.values(runtime.getTask(task.taskId).capabilityGrants).filter(grant => !grant.revokedAt).length, 1);
  assert.equal(await approvingResolver.isGranted({ ...approvedRequest, executionId: 'exec-approved-3' }, runCommand), true);
  assert.equal(approvePrompts, 1, 'durable grant must suppress future prompts in the same session generation');

  let denyPrompts = 0;
  const denyingResolver = new PromptingTaskCapabilityGrantResolver(runtime, {
    async requestGrant(input) {
      denyPrompts += 1;
      assert.equal(input.scope, 'worker-session');
      return false;
    },
  });
  const deniedRequest = requestFor(task.taskId, 'managed-denied', 'exec-denied');
  assert.equal(await denyingResolver.isGranted(deniedRequest, runCommand), false);
  assert.equal(denyPrompts, 1);
  const deniedSessionGrants = Object.values(runtime.getTask(task.taskId).capabilityGrants)
    .filter(grant => !grant.revokedAt && grant.managedSessionId === 'managed-denied');
  assert.equal(deniedSessionGrants.length, 0, 'denial must never write a grant');

  const authorizer = new CapabilityMetadataHostAuthorizer(denyingResolver);
  await assert.rejects(
    () => authorizer.authorize({ ...deniedRequest, executionId: 'exec-denied-authorizer' }, runCommand),
    error => error instanceof HostCapabilityAuthorizationError
      && error.capabilityId === runCommand.id
      && error.approval === 'session',
  );

  const alwaysCapability = Object.freeze({ ...runCommand, id: 'test.always', title: 'Always', approval: 'always' });
  const promptsBeforeAlways = denyPrompts;
  assert.equal(await denyingResolver.isGranted({ ...deniedRequest, executionId: 'exec-always' }, alwaysCapability), false);
  assert.equal(denyPrompts, promptsBeforeAlways, '`always` approval must not be delegated to the task/session prompt');

  await runtime.flush();
  const restarted = new TaskRuntime({ storageDirectory: directory });
  await restarted.initialize();
  let restartPrompts = 0;
  const restartedResolver = new PromptingTaskCapabilityGrantResolver(restarted, {
    async requestGrant() {
      restartPrompts += 1;
      return false;
    },
  });
  assert.equal(await restartedResolver.isGranted({ ...approvedRequest, executionId: 'exec-restarted' }, runCommand), true);
  assert.equal(restartPrompts, 0, 'replayed durable grant must authorize without prompting after restart');

  console.log('[smoke] prompting capability approval dedupe/approve/deny/restart/always-fail-closed ok');
} finally {
  await Promise.all([
    fs.rm(directory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
