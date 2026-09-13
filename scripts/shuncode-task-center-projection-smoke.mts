import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-task-center-projection-'));
const bundlePath = path.join(bundleDirectory, 'task-center-projection-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `export { projectTaskCenterState } from './src/task-center-projection.ts';`,
    resolveDir: root,
    sourcefile: 'task-center-projection-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});

const { projectTaskCenterState } = require(bundlePath);

const task = {
  version: 1,
  taskId: 'task-a',
  source: { kind: 'bridge', key: 'opaque-session-key', workspace: '/workspace' },
  status: 'ready',
  goal: 'Move Bridge presentation to Task',
  context: { constraints: [], decisions: [], relevantFiles: [] },
  createdAt: '2026-09-13T08:00:00.000Z',
  updatedAt: '2026-09-13T08:06:00.000Z',
  todos: [
    { id: 'one', title: 'Inspect', status: 'completed' },
    { id: 'two', title: 'Project', status: 'in_progress' },
  ],
  progress: { message: 'Projecting', phase: 'Task Center', percent: 60, todoId: 'two', at: '2026-09-13T08:05:00.000Z' },
  interactions: {
    chat: { interactionId: 'chat', surface: 'native-chat', startedAt: '2026-09-13T08:01:00.000Z', finishedAt: '2026-09-13T08:02:00.000Z', outcome: 'completed', durationMs: 60_000 },
  },
  workerSessions: {
    workerA: { managedSessionId: 'workerA', workerId: 'nimora.web-worker', adapterSessionId: 'page-a', model: 'deepseek', attachedAt: '2026-09-13T08:00:30.000Z' },
    workerB: { managedSessionId: 'workerB', workerId: 'nimora.api-worker', adapterSessionId: 'api-b', attachedAt: '2026-09-13T08:03:00.000Z', detachedAt: '2026-09-13T08:04:00.000Z' },
  },
  capabilityGrants: {},
  executions: {
    read: { executionId: 'read', toolName: 'read_files', status: 'succeeded', deliveryStatus: 'pending', requestedAt: '2026-09-13T08:02:30.000Z', finishedAt: '2026-09-13T08:02:31.000Z', durationMs: 1000, duplicateObservations: 0 },
    patch: { executionId: 'patch', toolName: 'apply_patch', status: 'failed', deliveryStatus: 'not-prepared', requestedAt: '2026-09-13T08:03:30.000Z', finishedAt: '2026-09-13T08:03:31.000Z', error: 'patch failed', duplicateObservations: 0 },
  },
  artifacts: [
    { artifactId: 'artifact-a', kind: 'changeset', title: 'Changed one file', executionId: 'read', createdAt: '2026-09-13T08:04:30.000Z', metadata: { files: ['src/a.ts'] } },
  ],
  eventCount: 12,
  lastEventId: 'event-12',
};

const older = {
  ...task,
  taskId: 'task-older',
  source: { kind: 'native-chat', key: 'opaque-chat-key' },
  goal: 'Older task',
  updatedAt: '2026-09-13T07:00:00.000Z',
  todos: [],
  progress: undefined,
  interactions: {},
  workerSessions: {},
  executions: {},
  artifacts: [],
};

try {
  const state = projectTaskCenterState([older, task]);
  assert.equal(state.version, 1);
  assert.deepEqual(state.tasks.map((item: { taskId: string }) => item.taskId), ['task-a', 'task-older'], 'tasks must be newest first');
  assert.equal(state.selectedTaskId, 'task-a', 'newest Task must be the default selection');
  assert.equal(state.tasks[0].sourceKind, 'bridge');
  assert.equal('key' in state.tasks[0], false, 'Task Center summaries must not expose raw source/session keys');
  assert.deepEqual(state.tasks[0].todoCounts, { total: 2, pending: 0, inProgress: 1, completed: 1 });
  assert.equal(state.tasks[0].workerCount, 2);
  assert.equal(state.tasks[0].activeWorkerCount, 1);
  assert.deepEqual(state.tasks[0].executionCounts, { total: 2, running: 0, succeeded: 1, failed: 1, unknown: 0, pendingDelivery: 1 });
  assert.equal(state.tasks[0].artifactCount, 1);

  const selected = state.selected;
  assert.ok(selected);
  assert.deepEqual(selected.workers.map((worker: { managedSessionId: string }) => worker.managedSessionId), ['workerA', 'workerB']);
  assert.deepEqual(selected.timeline.map((entry: { kind: string }) => entry.kind), ['interaction', 'execution', 'execution', 'artifact', 'progress']);
  const readExecution = selected.timeline.find((entry: { id: string }) => entry.id === 'execution:read');
  assert.equal(readExecution.deliveryStatus, 'pending', 'Task Center must preserve execution/result-delivery separation');
  assert.equal(JSON.stringify(state).includes('opaque-session-key'), false, 'projection must not leak Bridge session source keys');

  const olderSelection = projectTaskCenterState([task, older], 'task-older');
  assert.equal(olderSelection.selectedTaskId, 'task-older');
  assert.equal(olderSelection.selected?.summary.sourceKind, 'native-chat');
  assert.equal(projectTaskCenterState([task], 'missing').selected, undefined, 'stale explicit selection must fail closed instead of silently selecting another Task');

  selected.todos[0].title = 'mutated';
  assert.equal(task.todos[0].title, 'Inspect', 'Task Center projection must not mutate the Task snapshot');

  const extensionSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'extension.ts'), 'utf8');
  assert.match(
    extensionSource,
    /registerCommand\("shuncode\.taskCenter\.getState"[\s\S]{0,500}projectTaskCenterState\(taskRuntime\.listTasks\(\), selectedTaskId\)/,
    'Extension must expose the Task-owned projection instead of rebuilding Task Center state from Bridge status',
  );
  console.log('[smoke] Task Center list/detail/worker/timeline projection contract ok');
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
