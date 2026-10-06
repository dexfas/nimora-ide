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
      export { preapproveWorkerSessionCapabilities, isAutomationApprovedSession } from './src/worker-session-capability-preapproval.ts';
      export { dispatchHostCapabilityRequest } from './src/host-capability-request-dispatcher.ts';
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
  preapproveWorkerSessionCapabilities,
  isAutomationApprovedSession,
  dispatchHostCapabilityRequest,
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

  const automation = await preapproveWorkerSessionCapabilities(restarted, {
    taskId: task.taskId, managedSessionId: 'managed-approved', workerId: 'nimora.web-worker',
    capabilityIds: ['workspace.apply-patch', 'terminal.run-command'],
  });
  let automationPrompts = 0;
  const automationResolver = new PromptingTaskCapabilityGrantResolver(restarted, {
    async requestGrant() { automationPrompts++; throw Error('Mid-run approval must not open'); },
  }, request => !isAutomationApprovedSession(restarted, request, [automation]));
  for (let index = 0; index < 3; index++) {
    assert.equal(await automationResolver.isGranted(approvedRequest, runCommand), true);
    assert.equal(await automationResolver.isGranted({ ...approvedRequest, name: 'apply_patch' }, getCapabilityMetadata('apply_patch')), true);
  }
  assert.equal(automationPrompts, 0, 'both preapproved capabilities execute repeatedly without prompts');
  const afterRestart = new TaskRuntime({ storageDirectory: directory });
  await afterRestart.initialize();
  assert.equal(isAutomationApprovedSession(afterRestart, approvedRequest, [automation]), true);
  const replayedAutomation = new PromptingTaskCapabilityGrantResolver(afterRestart, {
    async requestGrant() { throw Error('Unexpected restart prompt'); },
  }, request => !isAutomationApprovedSession(afterRestart, request, [automation]));
  assert.equal(await replayedAutomation.isGranted(approvedRequest, runCommand), true);
  const outside = getCapabilityMetadata('send_command_input');
  const results = [];
  const dispatch = request => dispatchHostCapabilityRequest({ executeAndDeliver: async req => {
    await new CapabilityMetadataHostAuthorizer(replayedAutomation).authorize(req, outside);
    throw Error('Unauthorized executor must not run');
  } }, request, { submitCapabilityResult: async (_session, result) => { results.push(result); } });
  const denied = await dispatch({ ...approvedRequest, name: 'send_command_input' });
  assert.equal(denied.status, 'denied');
  assert.equal(results[0].extensions.hostAuthorizationStoppedTurn, true);
  assert.equal(automationPrompts, 0);
  const grant = Object.values(afterRestart.getTask(task.taskId).capabilityGrants).find(row => row.capabilityId === runCommand.id && !row.revokedAt);
  await afterRestart.revokeCapabilityGrantStrict(task.taskId, grant.grantId);
  await assert.rejects(() => replayedAutomation.isGranted(approvedRequest, runCommand), error => error.stopTurn === true);
  await assert.rejects(() => preapproveWorkerSessionCapabilities(afterRestart, {
    taskId: task.taskId, managedSessionId: 'managed-approved', workerId: 'wrong-worker', capabilityIds: [runCommand.id],
  }), /归属/);
  const countBeforeUnknown = Object.keys(afterRestart.getTask(task.taskId).capabilityGrants).length;
  await assert.rejects(() => preapproveWorkerSessionCapabilities(afterRestart, {
    taskId: task.taskId, managedSessionId: 'managed-approved', workerId: 'nimora.web-worker', capabilityIds: [runCommand.id, 'unknown'],
  }), /不能批量授权/);
  assert.equal(Object.keys(afterRestart.getTask(task.taskId).capabilityGrants).length, countBeforeUnknown);
  await afterRestart.detachWorkerSession(task.taskId, 'managed-approved');
  assert.equal(isAutomationApprovedSession(afterRestart, approvedRequest, [automation]), false, 'automation approval never follows a replacement Worker');

  console.log('[smoke] capability approval + upfront bundle/no mid-run prompt/revocation/denial stop/replay/owner fences ok');
} finally {
  await Promise.all([
    fs.rm(directory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
