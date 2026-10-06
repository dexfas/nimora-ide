import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-task-runtime-'));
const provenanceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-task-runtime-provenance-'));
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
  const changeEvents: string[] = [];
  const runtime = new TaskRuntime({
    storageDirectory: directory,
    newId,
    now,
    onDidChange: (snapshot: any, event: any) => {
      changeEvents.push(event.type);
      if (event.type === 'TaskCreated') snapshot.goal = 'listener must not mutate owner state';
      if (event.type === 'TaskTodosUpdated') throw new Error('listener failure must not break Task writes');
    },
  });
  await runtime.initialize();
  const task = await runtime.ensureTask({ kind: 'bridge', key: 'session-a', workspace: '/workspace' }, 'Refactor Gateway');
  assert.equal(task.goal, 'Refactor Gateway');
  assert.equal(runtime.getTask(task.taskId)?.goal, 'Refactor Gateway', 'Task change listeners must receive cloned snapshots');
  assert.deepEqual(changeEvents, ['TaskCreated'], 'Task creation must notify after the live owner state changes');
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
  assert.equal(runtime.getTask(task.taskId)?.todos.length, 2, 'listener exceptions must not break committed Task writes');
  assert.ok(changeEvents.includes('TaskTodosUpdated'));
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

  await runtime.attachWorkerSession(task.taskId, {
    managedSessionId: 'managed-abandon',
    workerId: 'nimora.web-worker',
    adapterSessionId: 'provider-abandon',
  });
  await runtime.beginExecution(task.taskId, {
    executionId: 'worker:managed-abandon:turn-1:1',
    toolName: 'read_files',
    origin: { kind: 'worker', managedSessionId: 'managed-abandon', workerId: 'nimora.web-worker', inputId: 'abandon-turn', callId: 'abandon-call' },
  });
  await runtime.finishExecution(task.taskId, 'worker:managed-abandon:turn-1:1', 'succeeded', { resultSummary: 'prepared but provider turn was consumed' });
  await runtime.markResultPrepared(task.taskId, 'worker:managed-abandon:turn-1:1', {
    kind: 'worker-capability', inputId: 'abandon-turn', callId: 'abandon-call', name: 'read_files', text: 'prepared result', isError: false,
  });
  await assert.rejects(
    () => runtime.abandonPendingDeliveryStrict(task.taskId, 'worker:managed-abandon:turn-1:1', 'consumed provider turn; do not replay'),
    /still current/,
    'a current WorkerSession must retain delivery ownership and cannot be reconciled away',
  );
  await runtime.retireWorkerSessionStrict(task.taskId, 'managed-abandon', { reason: 'consumed-provider-turn' });
  const abandonedDelivery = await runtime.abandonPendingDeliveryStrict(task.taskId, 'worker:managed-abandon:turn-1:1', 'consumed provider turn; do not replay');
  assert.equal(abandonedDelivery.deliveryStatus, 'abandoned');
  assert.equal(abandonedDelivery.deliveryAbandonmentReason, 'consumed provider turn; do not replay');
  assert.ok(abandonedDelivery.deliveryAbandonedAt);
  const idempotentAbandonment = await runtime.abandonPendingDeliveryStrict(task.taskId, 'worker:managed-abandon:turn-1:1', 'consumed provider turn; do not replay');
  assert.equal(idempotentAbandonment.deliveryAbandonedAt, abandonedDelivery.deliveryAbandonedAt, 'same explicit reconciliation must be idempotent');
  await assert.rejects(
    () => runtime.abandonPendingDeliveryStrict(task.taskId, 'worker:managed-abandon:turn-1:1', 'different reason'),
    /different reason/,
    'reconciliation reason is durable truth and cannot be rewritten',
  );

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
  assert.equal(beforeRestart.workerSessions['worker-session-1']?.ownerRuntimeIncarnationId, undefined, 'legacy attachment without provenance must remain valid');
  assert.equal(beforeRestart.workerSessions['worker-session-1']?.ownerProcessId, undefined, 'legacy attachment without provenance must remain valid');
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
  const failClosedChanges: string[] = [];
  const failClosed = new TaskRuntime({ storageDirectory: blockedPath, onDidChange: (_snapshot: any, event: any) => failClosedChanges.push(event.type) });
  await failClosed.initialize();
  const shadowTask = await failClosed.ensureTask({ kind: 'bridge', key: 'fail-open-shadow' }, 'Shadow still loads');
  assert.deepEqual(failClosedChanges, ['TaskCreated']);
  await fs.rm(blockedPath, { recursive: true, force: true });
  await fs.writeFile(blockedPath, 'file blocks mkdir', 'utf8');
  await assert.rejects(() => failClosed.claimExecution(shadowTask.taskId, {
    executionId: 'strict:blocked:1',
    toolName: 'run_command',
    arguments: { command: 'echo must-not-run' },
  }), /Strict task persistence failed/);
  assert.equal(failClosed.getTask(shadowTask.taskId)?.executions['strict:blocked:1'], undefined, 'failed strict claim must not enter the in-memory projection');
  assert.deepEqual(failClosedChanges, ['TaskCreated'], 'failed strict persistence must not emit a Task change notification');
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

  let provenanceId = 0;
  const provenanceRuntime = new TaskRuntime({
    storageDirectory: provenanceDirectory,
    newId: () => `provenance-id-${++provenanceId}`,
    now,
    workerOwnerProvenance: () => ({ ownerRuntimeIncarnationId: 'runtime-incarnation-a', ownerProcessId: 4242 }),
  });
  await provenanceRuntime.initialize();
  const provenanceTask = await provenanceRuntime.ensureTask({ kind: 'bridge', key: 'provenance-session' }, 'Persist owner provenance');
  await assert.rejects(
    () => provenanceRuntime.attachWorkerSession(provenanceTask.taskId, {
      managedSessionId: 'forged-provenance-managed',
      workerId: 'nimora.web-worker',
      adapterSessionId: 'forged-provider-session',
      ownerRuntimeIncarnationId: 'caller-forged-runtime',
      ownerProcessId: 9999,
    }),
    /trusted-host metadata and cannot be supplied by the attachment caller/,
    'caller/provider input must not be able to declare durable owner provenance',
  );
  const provenanceAttach = await provenanceRuntime.attachWorkerSession(provenanceTask.taskId, {
    managedSessionId: 'provenance-managed-1',
    workerId: 'nimora.web-worker',
    adapterSessionId: 'provider-session-a',
  });
  assert.equal(provenanceAttach.workerSession.ownerRuntimeIncarnationId, 'runtime-incarnation-a');
  assert.equal(provenanceAttach.workerSession.ownerProcessId, 4242);
  await provenanceRuntime.flush();
  const provenanceRestarted = new TaskRuntime({ storageDirectory: provenanceDirectory });
  await provenanceRestarted.initialize();
  const replayedProvenance = provenanceRestarted.findTaskBySource({ kind: 'bridge', key: 'provenance-session' });
  assert.equal(replayedProvenance.workerSessions['provenance-managed-1'].ownerRuntimeIncarnationId, 'runtime-incarnation-a', 'new-format runtime incarnation provenance must survive replay');
  assert.equal(replayedProvenance.workerSessions['provenance-managed-1'].ownerProcessId, 4242, 'new-format owner PID provenance must survive replay');

  console.log(`[smoke] task runtime replay + execution ledger ok (events=${afterRestart.eventCount})`);
} finally {
  await Promise.all([
    fs.rm(directory, { recursive: true, force: true }),
    fs.rm(provenanceDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
