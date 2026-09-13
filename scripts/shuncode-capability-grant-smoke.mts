import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-capability-grant-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-capability-grant-bundle-'));
const bundlePath = path.join(bundleDirectory, 'grant-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { TaskRuntime } from './src/task-runtime.ts';
      export { TaskCapabilityGrantResolver } from './src/task-capability-grant-resolver.ts';
      export { CapabilityMetadataHostAuthorizer } from './src/host-capability-policy-authorizer.ts';
      export { getCapabilityMetadata } from './src/capability-registry.ts';
    `,
    resolveDir: root,
    sourcefile: 'capability-grant-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});

const { TaskRuntime, TaskCapabilityGrantResolver, CapabilityMetadataHostAuthorizer, getCapabilityMetadata } = require(bundlePath);
const taskGrantCapability = Object.freeze({
  id: 'test.task-write', version: 1, title: 'Task write', category: 'task', tags: [], environment: 'runtime',
  risk: 'write', idempotency: 'idempotent', retry: 'verify-before-retry', approval: 'task-grant', destructive: false, openWorld: false,
});
const alwaysCapability = Object.freeze({ ...taskGrantCapability, id: 'test.always', title: 'Always', approval: 'always' });

const requestFor = (taskId, managedSessionId = 'managed-a', workerId = 'nimora.web-worker') => ({
  executionId: `grant-exec-${managedSessionId}`,
  managedSessionId,
  workerId,
  taskId,
  inputId: 'turn-1',
  callId: `call-${managedSessionId}`,
  name: 'run_command',
  arguments: { command: 'echo test', background: false },
});

try {
  const runtime = new TaskRuntime({ storageDirectory: directory });
  await runtime.initialize();
  const task = await runtime.ensureTask({ kind: 'bridge', key: 'grant-task' }, 'Capability grants');
  const otherTask = await runtime.ensureTask({ kind: 'bridge', key: 'grant-task-other' }, 'Other task');
  await runtime.attachWorkerSession(task.taskId, {
    managedSessionId: 'managed-a', workerId: 'nimora.web-worker', adapterSessionId: 'page-a',
  });
  await runtime.attachWorkerSession(task.taskId, {
    managedSessionId: 'managed-b', workerId: 'nimora.web-worker', adapterSessionId: 'page-b',
  });

  const resolver = new TaskCapabilityGrantResolver(runtime);
  const authorizer = new CapabilityMetadataHostAuthorizer(resolver);
  const runCommand = getCapabilityMetadata('run_command');
  await assert.rejects(() => authorizer.authorize(requestFor(task.taskId), runCommand), /was not granted/);

  const sessionGrant = await runtime.grantCapabilityStrict(task.taskId, {
    capabilityId: runCommand.id,
    capabilityVersion: runCommand.version,
    scope: 'worker-session',
    managedSessionId: 'managed-a',
  });
  assert.equal(sessionGrant.scope, 'worker-session');
  assert.equal(sessionGrant.managedSessionId, 'managed-a');
  assert.ok(sessionGrant.workerSessionAttachedAt);
  const duplicateSessionGrant = await runtime.grantCapabilityStrict(task.taskId, {
    capabilityId: runCommand.id,
    capabilityVersion: runCommand.version,
    scope: 'worker-session',
    managedSessionId: 'managed-a',
  });
  assert.equal(duplicateSessionGrant.grantId, sessionGrant.grantId, 'duplicate active grant should be reused');
  await authorizer.authorize(requestFor(task.taskId), runCommand);
  await assert.rejects(() => authorizer.authorize(requestFor(task.taskId, 'managed-b'), runCommand), /was not granted/);

  const taskGrant = await runtime.grantCapabilityStrict(task.taskId, {
    capabilityId: taskGrantCapability.id,
    capabilityVersion: 1,
    scope: 'task',
  });
  assert.equal(await resolver.isGranted(requestFor(task.taskId), taskGrantCapability), true);
  assert.equal(await resolver.isGranted(requestFor(otherTask.taskId), taskGrantCapability), false, 'task grant must not cross task boundary');
  assert.equal(await resolver.isGranted(requestFor(task.taskId), alwaysCapability), false, 'task journal must never satisfy global always approval');

  await runtime.flush();
  const restarted = new TaskRuntime({ storageDirectory: directory });
  await restarted.initialize();
  const restartedResolver = new TaskCapabilityGrantResolver(restarted);
  assert.equal(await restartedResolver.isGranted(requestFor(task.taskId), runCommand), true, 'session grant must replay after restart');
  assert.equal(restarted.getTask(task.taskId).capabilityGrants[sessionGrant.grantId].grantId, sessionGrant.grantId);

  await restarted.revokeCapabilityGrantStrict(task.taskId, sessionGrant.grantId);
  assert.equal(await restartedResolver.isGranted(requestFor(task.taskId), runCommand), false, 'revoked grant must fail closed');
  assert.ok(restarted.getTask(task.taskId).capabilityGrants[sessionGrant.grantId].revokedAt);

  const replacementGrant = await restarted.grantCapabilityStrict(task.taskId, {
    capabilityId: runCommand.id,
    capabilityVersion: 1,
    scope: 'worker-session',
    managedSessionId: 'managed-a',
  });
  assert.notEqual(replacementGrant.grantId, sessionGrant.grantId);
  assert.equal(await restartedResolver.isGranted(requestFor(task.taskId), runCommand), true);
  await restarted.detachWorkerSession(task.taskId, 'managed-a');
  assert.equal(await restartedResolver.isGranted(requestFor(task.taskId), runCommand), false, 'detached session must invalidate its grant');
  await restarted.attachWorkerSession(task.taskId, {
    managedSessionId: 'managed-a', workerId: 'nimora.web-worker', adapterSessionId: 'page-a',
  });
  assert.equal(await restartedResolver.isGranted(requestFor(task.taskId), runCommand), false, 'reattaching the same managed id must not revive an old session grant');
  const reattachedGrant = await restarted.grantCapabilityStrict(task.taskId, {
    capabilityId: runCommand.id,
    capabilityVersion: 1,
    scope: 'worker-session',
    managedSessionId: 'managed-a',
  });
  assert.notEqual(reattachedGrant.workerSessionAttachedAt, replacementGrant.workerSessionAttachedAt);
  assert.equal(await restartedResolver.isGranted(requestFor(task.taskId), runCommand), true);

  const blockedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-capability-grant-blocked-'));
  const blockedRuntime = new TaskRuntime({ storageDirectory: blockedDirectory });
  await blockedRuntime.initialize();
  const blockedTask = await blockedRuntime.ensureTask({ kind: 'bridge', key: 'grant-blocked' }, 'Blocked grant');
  await blockedRuntime.attachWorkerSession(blockedTask.taskId, {
    managedSessionId: 'blocked-session', workerId: 'nimora.web-worker', adapterSessionId: 'page-blocked',
  });
  await fs.rm(blockedDirectory, { recursive: true, force: true });
  await fs.writeFile(blockedDirectory, 'block strict grant persistence', 'utf8');
  await assert.rejects(() => blockedRuntime.grantCapabilityStrict(blockedTask.taskId, {
    capabilityId: runCommand.id, capabilityVersion: 1, scope: 'worker-session', managedSessionId: 'blocked-session',
  }), /Strict task persistence failed/);
  assert.equal(Object.keys(blockedRuntime.getTask(blockedTask.taskId).capabilityGrants).length, 0, 'failed strict persistence must not create an in-memory grant');
  await fs.rm(blockedDirectory, { force: true });

  await restarted.revokeCapabilityGrantStrict(task.taskId, taskGrant.grantId);
  assert.equal(await restartedResolver.isGranted(requestFor(task.taskId), taskGrantCapability), false);

  console.log('[smoke] durable task/session capability grants + revoke/restart/session-generation/fail-closed ok');
} finally {
  await Promise.all([
    fs.rm(directory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
