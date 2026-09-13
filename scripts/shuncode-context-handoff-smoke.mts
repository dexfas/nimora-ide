import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-context-handoff-task-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-context-handoff-bundle-'));
const bundlePath = path.join(bundleDirectory, 'context-handoff-smoke.mjs');

await esbuild.build({
  stdin: {
    contents: `
      export { TaskRuntime } from ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'src', 'task-runtime.ts'))};
      export { buildRenderedContextHandoff } from ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'src', 'context-handoff.ts'))};
    `,
    resolveDir: path.resolve(import.meta.dirname, '..'),
    sourcefile: 'context-handoff-smoke-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['es2022'],
  logLevel: 'silent',
});

const { TaskRuntime, buildRenderedContextHandoff } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

try {
  const tasks = new TaskRuntime({ storageDirectory: taskDirectory });
  await tasks.initialize();
  const task = await tasks.ensureTask({ kind: 'bridge', key: 'handoff' }, 'Refactor the Gateway without duplicating side effects');
  await tasks.updateContext(task.taskId, {
    summary: 'Capability and Worker layers are separated. Continue from the current migration phase.',
    constraints: [
      'Do not modify the installed ShunCode reference.',
      'Never retry side-effecting tools after uncertain result delivery.',
    ],
    decisions: [
      'Task owns durable state; WorkerSession is replaceable.',
      'Gateway is transport, not orchestration brain.',
    ],
    relevantFiles: ['src/worker-session-manager.ts', 'docs/architecture/MIGRATION_PLAN.md'],
  });
  await tasks.setTodos(task.taskId, [
    { id: 'a', title: 'Finish context handoff', status: 'in_progress' },
    { id: 'b', title: 'Add Web Worker adapter', status: 'pending' },
  ]);
  await tasks.reportProgress(task.taskId, { message: 'Context handoff package implementation', phase: 'Phase 4.4', percent: 70 });
  await tasks.attachWorkerSession(task.taskId, {
    managedSessionId: 'managed-api',
    workerId: 'worker.api',
    adapterSessionId: 'api-native',
    model: 'fake-model',
  });
  await tasks.beginExecution(task.taskId, { executionId: 'exec-1', toolName: 'read_files', capabilityId: 'workspace.read' });
  await tasks.finishExecution(task.taskId, 'exec-1', 'succeeded', { resultSummary: 'Architecture docs inspected' });
  await tasks.markResultPrepared(task.taskId, 'exec-1');
  await tasks.recordArtifact(task.taskId, { kind: 'report', title: 'Architecture handoff notes', uri: 'file:///handoff.md' });
  await tasks.flush();

  const before = tasks.getTask(task.taskId);
  assert.ok(before);
  const rendered = buildRenderedContextHandoff(before, {
    targetWorkerId: 'worker.agent',
    sourceManagedSessionId: 'managed-api',
    generatedAt: '2026-09-13T00:00:00.000Z',
    maxChars: 2400,
  });
  assert.ok(rendered.text.includes('Refactor the Gateway'));
  assert.ok(rendered.text.includes('Task owns durable state'));
  assert.ok(rendered.text.includes('Never retry side-effecting tools'));
  assert.ok(rendered.text.includes('Architecture docs inspected'));
  assert.ok(rendered.text.includes('worker.api'));
  assert.ok(rendered.text.length <= 2400);
  assert.equal(rendered.package.targetWorkerId, 'worker.agent');
  assert.equal(rendered.package.recentExecutions[0].deliveryStatus, 'pending');
  assert.equal('adapterSessionId' in rendered.package.workerSessions[0], false, 'provider-native session ids must not leak into handoff packages');

  const restarted = new TaskRuntime({ storageDirectory: taskDirectory });
  await restarted.initialize();
  const after = restarted.getTask(task.taskId);
  assert.ok(after);
  assert.deepEqual(after.context, before.context);
  const replayed = buildRenderedContextHandoff(after, {
    targetWorkerId: 'worker.agent',
    sourceManagedSessionId: 'managed-api',
    generatedAt: '2026-09-13T00:00:00.000Z',
    maxChars: 2400,
  });
  assert.deepEqual(replayed.package, rendered.package);
  assert.equal(replayed.text, rendered.text);

  const tight = buildRenderedContextHandoff({
    ...after,
    context: { ...after.context, summary: `Long handoff evidence ${'x'.repeat(1800)}` },
  }, { generatedAt: '2026-09-13T00:00:00.000Z', maxChars: 1000 });
  assert.ok(tight.text.length <= 1000);
  assert.ok(tight.truncatedSections.length > 0, 'tight budget must report truncated sections instead of silently dropping context');
  const tiny = buildRenderedContextHandoff(after, { generatedAt: '2026-09-13T00:00:00.000Z', maxChars: 128 });
  assert.ok(tiny.text.length <= 128, 'maxChars must be a hard caller budget');

  console.log('[smoke] Context handoff budget/replay/provider-neutral package ok');
} finally {
  await Promise.all([
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
