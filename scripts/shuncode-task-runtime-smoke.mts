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
  await runtime.updateContext(task.taskId, {
    summary: 'Gateway refactor is in progress.',
    constraints: ['No duplicate side effects', 'No duplicate side effects', 'Keep VS Code as foundation'],
    decisions: ['Task owns durable state'],
    relevantFiles: ['src/task-runtime.ts'],
  });

  await runtime.setTodos(task.taskId, [
    { id: 'audit', title: 'Audit', status: 'completed' },
    { id: 'code', title: 'Implement', status: 'in_progress' },
  ]);
  await runtime.reportProgress(task.taskId, { message: 'Provider split started', phase: 'Coding', percent: 35, todoId: 'code' });
  await runtime.attachWorkerSession(task.taskId, {
    managedSessionId: 'worker-session-1',
    workerId: 'nimora.api-runtime',
    adapterSessionId: 'api-session-1',
    model: 'fake-model',
  });
  await assert.rejects(async () => runtime.attachWorkerSession(task.taskId, {
    managedSessionId: 'worker-session-1',
    workerId: 'nimora.agent-host',
    adapterSessionId: 'other-session',
  }), /identity mismatch/);

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

  await runtime.beginExecution(task.taskId, {
    executionId: 'worker:managed-1:turn-1:1',
    toolName: 'read_files',
    arguments: { files: [{ path: 'README.md' }] },
    origin: { kind: 'worker', managedSessionId: 'managed-1', workerId: 'nimora.web-worker', inputId: 'turn-1', callId: 'call-1' },
  });
  await runtime.finishExecution(task.taskId, 'worker:managed-1:turn-1:1', 'succeeded', { durationMs: 9, resultSummary: 'README contents' });
  await runtime.markResultPrepared(task.taskId, 'worker:managed-1:turn-1:1', {
    kind: 'worker-capability',
    inputId: 'turn-1',
    callId: 'call-1',
    name: 'read_files',
    text: 'README contents',
    isError: false,
    durationMs: 9,
  });

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
  assert.deepEqual(beforeRestart.context.constraints, ['No duplicate side effects', 'Keep VS Code as foundation']);
  assert.equal(beforeRestart.context.summary, 'Gateway refactor is in progress.');
  assert.equal(beforeRestart.workerSessions['worker-session-1']?.workerId, 'nimora.api-runtime');
  assert.equal(beforeRestart.executions['mcp:session-a:7']?.status, 'succeeded');
  assert.equal(beforeRestart.executions['mcp:session-a:7']?.deliveryStatus, 'pending');
  assert.equal(beforeRestart.executions['mcp:session-a:7']?.duplicateObservations, 1);
  assert.deepEqual(beforeRestart.executions['worker:managed-1:turn-1:1']?.resultPayload, {
    kind: 'worker-capability', inputId: 'turn-1', callId: 'call-1', name: 'read_files', text: 'README contents', isError: false, durationMs: 9,
  });
  assert.equal(beforeRestart.artifacts.length, 1);

  const strictClaim = await runtime.claimExecution(task.taskId, {
    executionId: 'strict:claim:1',
    toolName: 'read_files',
    capabilityId: 'workspace.read-files',
    risk: 'read',
    arguments: { files: [{ path: 'README.md' }] },
    origin: { kind: 'worker', managedSessionId: 'managed-strict', workerId: 'nimora.web-worker', inputId: 'strict-turn', callId: 'strict-call' },
  });
  assert.equal(strictClaim.duplicate, false);
  const strictDuplicate = await runtime.claimExecution(task.taskId, {
    executionId: 'strict:claim:1',
    toolName: 'read_files',
    capabilityId: 'workspace.read-files',
    risk: 'read',
    arguments: { files: [{ path: 'README.md' }] },
    origin: { kind: 'worker', managedSessionId: 'managed-strict', workerId: 'nimora.web-worker', inputId: 'strict-turn', callId: 'strict-call' },
  });
  assert.equal(strictDuplicate.duplicate, true);
  await assert.rejects(() => runtime.claimExecution(task.taskId, {
    executionId: 'strict:claim:1',
    toolName: 'read_files',
    capabilityId: 'workspace.read-files',
    risk: 'read',
    arguments: { files: [{ path: 'OTHER.md' }] },
    origin: { kind: 'worker', managedSessionId: 'managed-strict', workerId: 'nimora.web-worker', inputId: 'strict-turn', callId: 'strict-call' },
  }), /Execution identity mismatch/);
  const beforeRestartFinal = runtime.getTask(task.taskId)!;

  const blockedPath = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-task-runtime-blocked-'));
  const failClosed = new TaskRuntime({ storageDirectory: blockedPath });
  await failClosed.initialize();
  const shadowTask = await failClosed.ensureTask({ kind: 'bridge', key: 'fail-open-shadow' }, 'Shadow still loads');
  await fs.rm(blockedPath, { recursive: true, force: true });
  await fs.writeFile(blockedPath, 'file blocks mkdir', 'utf8');
  await assert.rejects(() => failClosed.claimExecution(shadowTask.taskId, {
    executionId: 'strict:blocked:1',
    toolName: 'run_command',
    arguments: { command: 'echo must-not-run' },
  }), /Strict task persistence failed/);
  assert.equal(failClosed.getTask(shadowTask.taskId)?.executions['strict:blocked:1'], undefined, 'failed strict claim must not enter the in-memory projection');
  await fs.rm(blockedPath, { force: true });

  // Simulate a torn final write. Replay must preserve every complete event and
  // ignore only the corrupt suffix.
  const journal = path.join(directory, `${task.taskId}.jsonl`);
  await fs.appendFile(journal, '{"version":1,"eventId":"torn"', 'utf8');

  const restarted = new TaskRuntime({ storageDirectory: directory });
  await restarted.initialize();
  const afterRestart = restarted.findTaskBySource({ kind: 'bridge', key: 'session-a', workspace: '/workspace' });
  assert.ok(afterRestart, 'task must replay after process restart');
  assert.equal(afterRestart.taskId, beforeRestartFinal.taskId);
  assert.deepEqual(afterRestart.todos, beforeRestartFinal.todos);
  assert.deepEqual(afterRestart.progress, beforeRestartFinal.progress);
  assert.deepEqual(afterRestart.context, beforeRestartFinal.context);
  assert.deepEqual(afterRestart.workerSessions, beforeRestartFinal.workerSessions);
  assert.deepEqual(afterRestart.executions, beforeRestartFinal.executions);
  assert.deepEqual(afterRestart.artifacts, beforeRestartFinal.artifacts);

  console.log(`[smoke] task runtime replay + execution ledger ok (events=${afterRestart.eventCount})`);
} finally {
  await Promise.all([
    fs.rm(directory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
