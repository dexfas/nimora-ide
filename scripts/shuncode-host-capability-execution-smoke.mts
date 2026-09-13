import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-host-capability-execution-'));
const bundlePath = path.join(bundleDirectory, 'host-capability-execution.mjs');

await esbuild.build({
  entryPoints: [path.resolve(import.meta.dirname, '..', 'src', 'host-capability-execution-coordinator.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['es2022'],
  logLevel: 'silent',
});

const { HostCapabilityExecutionCoordinator } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

let now = 1000;
let authorizations = 0;
let executions = 0;
let shouldThrow = false;
const coordinator = new HostCapabilityExecutionCoordinator({
  now: () => now,
  authorizer: {
    async authorize(request, capability) {
      authorizations += 1;
      assert.equal(request.name, 'read_files');
      assert.equal(capability.id, 'workspace.read-files');
    },
  },
  executor: {
    async execute(request) {
      executions += 1;
      now += 17;
      if (shouldThrow) throw new Error('ambiguous executor failure');
      return { text: `READ:${request.arguments.files[0].path}`, isError: false };
    },
  },
});

const request = {
  executionId: 'exec-1',
  managedSessionId: 'managed-1',
  workerId: 'nimora.web-worker',
  taskId: 'task-1',
  inputId: 'turn-1',
  callId: 'call-1',
  name: 'read_files',
  arguments: { files: [{ path: 'README.md' }] },
};

try {
  const [first, concurrent] = await Promise.all([
    coordinator.executeOnce(request),
    coordinator.executeOnce({ ...request }),
  ]);
  assert.deepEqual(first, concurrent);
  assert.equal(first.text, 'READ:README.md');
  assert.equal(first.durationMs, 17);
  assert.equal(authorizations, 1);
  assert.equal(executions, 1, 'concurrent duplicate execution ids must execute only once');

  let deliveryAttempts = 0;
  const sink = {
    async submitCapabilityResult(managedSessionId, result) {
      deliveryAttempts += 1;
      assert.equal(managedSessionId, 'managed-1');
      assert.equal(result.callId, 'call-1');
      if (deliveryAttempts === 1) throw new Error('synthetic delivery failure');
    },
  };
  await assert.rejects(() => coordinator.deliverResult(request, sink), /synthetic delivery failure/);
  assert.equal(coordinator.getState('exec-1').phase, 'executed');
  assert.equal(executions, 1, 'delivery failure must never cause capability re-execution');
  await coordinator.deliverResult(request, sink);
  assert.equal(coordinator.getState('exec-1').phase, 'delivered');
  assert.equal(coordinator.getState('exec-1').deliveryAttempts, 2);
  assert.equal(executions, 1);
  await coordinator.deliverResult(request, sink);
  assert.equal(deliveryAttempts, 2, 'confirmed delivery must be idempotent');

  await assert.rejects(
    () => coordinator.executeOnce({ ...request, arguments: { files: [{ path: 'OTHER.md' }] } }),
    /Execution identity mismatch/,
  );
  await assert.rejects(
    () => coordinator.executeOnce({ ...request, executionId: 'unknown-cap', callId: 'call-unknown', name: 'not_registered' }),
    /requires registered capability metadata/,
  );

  let deniedExecutions = 0;
  const denied = new HostCapabilityExecutionCoordinator({
    authorizer: { async authorize() { throw new Error('approval required'); } },
    executor: { async execute() { deniedExecutions += 1; return { text: 'bad' }; } },
  });
  await assert.rejects(() => denied.executeOnce({ ...request, executionId: 'denied' }), /approval required/);
  assert.equal(deniedExecutions, 0);
  assert.equal(denied.getState('denied'), undefined, 'authorization failure must not leave an executed claim');

  shouldThrow = true;
  const failedRequest = { ...request, executionId: 'exec-failure', callId: 'call-failure' };
  const failed = await coordinator.executeOnce(failedRequest);
  assert.equal(failed.isError, true);
  assert.match(failed.text, /ambiguous executor failure/);
  const executionsAfterFailure = executions;
  const failedReplay = await coordinator.executeOnce(failedRequest);
  assert.deepEqual(failedReplay, failed);
  assert.equal(executions, executionsAfterFailure, 'executor throw is cached as ambiguous/error and must not be blindly retried');

  console.log('[smoke] Host capability execute-once / authorization / delivery retry / ambiguity guard ok');
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
