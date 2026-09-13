import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-task-runtime-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-task-runtime-bundle-'));
const bundlePath = path.join(bundleDirectory, 'task-runtime.mjs');
await esbuild.build({
  entryPoints: [path.resolve(import.meta.dirname, '..', 'src', 'task-runtime.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['es2022'],
  logLevel: 'silent',
});
const { TaskRuntime } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
let id = 0;
const newId = () => `id-${++id}`;
let tick = 0;
const now = () => new Date(Date.UTC(2026, 8, 13, 0, 0, tick++));

try {
  const runtime = new TaskRuntime({ storageDirectory: directory, newId, now });
  await runtime.initialize();
  const task = await runtime.ensureTask({ kind: 'bridge', key: 'session-a', workspace: '/workspace' }, 'Refactor Gateway');
  assert.equal(task.goal, 'Refactor Gateway');

  await runtime.setTodos(task.taskId, [
    { id: 'audit', title: 'Audit', status: 'completed' },
    { id: 'code', title: 'Implement', status: 'in_progress' },
  ]);
  await runtime.reportProgress(task.taskId, { message: 'Provider split started', phase: 'Coding', percent: 35, todoId: 'code' });

  const first = await runtime.beginExecution(task.taskId, {
    executionId: 'mcp:session-a:7',
    toolName: 'apply_patch',
    capabilityId: 'workspace.apply-patch',
    risk: 'write',
    arguments: { patch: '*** Begin Patch\n*** End Patch' },
  });
  assert.equal(first.duplicate, false);
  const duplicate = await runtime.beginExecution(task.taskId, {
    executionId: 'mcp:session-a:7',
    toolName: 'apply_patch',
  });
  assert.equal(duplicate.duplicate, true, 'ledger must detect an already-observed execution id');
  await runtime.finishExecution(task.taskId, 'mcp:session-a:7', 'succeeded', { durationMs: 42, resultSummary: '1 file changed' });
  await runtime.markResultPrepared(task.taskId, 'mcp:session-a:7');

  const concurrent = await Promise.all([
    runtime.beginExecution(task.taskId, { executionId: 'mcp:session-a:8', toolName: 'run_command', arguments: { command: 'echo ok' } }),
    runtime.beginExecution(task.taskId, { executionId: 'mcp:session-a:8', toolName: 'run_command', arguments: { command: 'echo ok' } }),
  ]);
  assert.deepEqual(concurrent.map(result => result.duplicate).sort(), [false, true], 'concurrent duplicate observations must serialize atomically');
  await runtime.finishExecution(task.taskId, 'mcp:session-a:8', 'succeeded', { durationMs: 5, resultSummary: 'ok' });
  await runtime.markResultPrepared(task.taskId, 'mcp:session-a:8');

  await runtime.recordArtifact(task.taskId, {
    kind: 'changeset',
    title: 'Workspace patch',
    executionId: 'mcp:session-a:7',
    metadata: { files: ['README.md'] },
  });
  await runtime.flush();

  const beforeRestart = runtime.getTask(task.taskId)!;
  assert.equal(beforeRestart.todos[1]?.status, 'in_progress');
  assert.equal(beforeRestart.progress?.percent, 35);
  assert.equal(beforeRestart.executions['mcp:session-a:7']?.status, 'succeeded');
  assert.equal(beforeRestart.executions['mcp:session-a:7']?.deliveryStatus, 'pending');
  assert.equal(beforeRestart.executions['mcp:session-a:7']?.duplicateObservations, 1);
  assert.equal(beforeRestart.artifacts.length, 1);

  // Simulate a torn final write. Replay must preserve every complete event and
  // ignore only the corrupt suffix.
  const journal = path.join(directory, `${task.taskId}.jsonl`);
  await fs.appendFile(journal, '{"version":1,"eventId":"torn"', 'utf8');

  const restarted = new TaskRuntime({ storageDirectory: directory });
  await restarted.initialize();
  const afterRestart = restarted.findTaskBySource({ kind: 'bridge', key: 'session-a', workspace: '/workspace' });
  assert.ok(afterRestart, 'task must replay after process restart');
  assert.equal(afterRestart.taskId, beforeRestart.taskId);
  assert.deepEqual(afterRestart.todos, beforeRestart.todos);
  assert.deepEqual(afterRestart.progress, beforeRestart.progress);
  assert.deepEqual(afterRestart.executions, beforeRestart.executions);
  assert.deepEqual(afterRestart.artifacts, beforeRestart.artifacts);

  console.log(`[smoke] task runtime replay + execution ledger ok (events=${afterRestart.eventCount})`);
} finally {
  await Promise.all([
    fs.rm(directory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
