import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-bridge-coordination-'));
const blockedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-bridge-coordination-blocked-'));
const blockedCreationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-bridge-coordination-create-blocked-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-bridge-coordination-bundle-'));
const bundlePath = path.join(bundleDirectory, 'bridge-coordination-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { TaskRuntime } from './src/task-runtime.ts';
      export { normalizeBridgeTodos, normalizeBridgeProgress } from './extensions/shuncode/src/bridge-task-coordination.ts';
    `,
    resolveDir: root,
    sourcefile: 'bridge-task-coordination-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});

const { TaskRuntime, normalizeBridgeTodos, normalizeBridgeProgress } = require(bundlePath);

try {
  const todos = normalizeBridgeTodos({
    todos: [
      { id: 'inspect', title: ' Inspect architecture ', status: 'completed' },
      { id: 'build', title: 'Build Task ownership', status: 'in_progress' },
      { id: 'verify', title: 'Verify migration', status: 'pending' },
    ],
  });
  assert.deepEqual(todos, [
    { id: 'inspect', title: 'Inspect architecture', status: 'completed' },
    { id: 'build', title: 'Build Task ownership', status: 'in_progress' },
    { id: 'verify', title: 'Verify migration', status: 'pending' },
  ]);
  assert.throws(() => normalizeBridgeTodos({ todos: [{ id: 'a', title: 'A', status: 'in_progress' }, { id: 'b', title: 'B', status: 'in_progress' }] }), /at most one in_progress/);
  assert.throws(() => normalizeBridgeTodos({ todos: [{ id: 'same', title: 'A', status: 'pending' }, { id: 'same', title: 'B', status: 'pending' }] }), /duplicate id/);
  assert.throws(() => normalizeBridgeTodos({ todos: Array.from({ length: 25 }, (_, index) => ({ id: `t-${index}`, title: `T ${index}`, status: 'pending' })) }), /at most 24/);

  const implicit = normalizeBridgeProgress({ message: ' Wiring owner ', phase: ' Editing ', percent: 55 }, todos);
  assert.deepEqual(implicit.progress, { message: 'Wiring owner', phase: 'Editing', percent: 55, todoId: 'build' });
  assert.equal(implicit.linkedTodo?.title, 'Build Task ownership');
  const explicit = normalizeBridgeProgress({ message: 'Checking', todo_id: 'verify' }, todos);
  assert.equal(explicit.progress.todoId, 'verify');
  assert.equal(normalizeBridgeProgress({ message: 'Checking', phase: '   ' }, todos).progress.phase, '', 'blank phase normalization must preserve the legacy Bridge contract');
  assert.throws(() => normalizeBridgeProgress({ message: 'Checking', todo_id: 'missing' }, todos), /does not match a current todo/);
  assert.throws(() => normalizeBridgeProgress({ message: 'Checking', percent: 101 }, todos), /integer from 0 to 100/);
  assert.throws(() => normalizeBridgeProgress({ message: '   ' }, todos), /non-empty string/);

  const runtime = new TaskRuntime({ storageDirectory: directory });
  await runtime.initialize();
  const task = await runtime.ensureTask({ kind: 'bridge', key: 'bridge-session-a' }, 'Task-owned coordination');
  let snapshot = await runtime.setTodosStrict(task.taskId, todos);
  assert.deepEqual(snapshot.todos, todos);
  snapshot = await runtime.reportProgressStrict(task.taskId, implicit.progress);
  assert.equal(snapshot.progress?.message, 'Wiring owner');
  assert.equal(snapshot.progress?.todoId, 'build');
  await runtime.flush();

  const restarted = new TaskRuntime({ storageDirectory: directory });
  await restarted.initialize();
  const replayed = restarted.getTask(task.taskId);
  assert.deepEqual(replayed?.todos, todos, 'strict todo owner state must replay after restart');
  assert.equal(replayed?.progress?.message, 'Wiring owner', 'strict progress owner state must replay after restart');
  assert.equal(replayed?.progress?.todoId, 'build');

  const blockedCreationRuntime = new TaskRuntime({ storageDirectory: blockedCreationDirectory });
  await blockedCreationRuntime.initialize();
  await fs.rm(blockedCreationDirectory, { recursive: true, force: true });
  await fs.writeFile(blockedCreationDirectory, 'block durable task creation', 'utf8');
  await assert.rejects(
    () => blockedCreationRuntime.ensureTask({ kind: 'bridge', key: 'bridge-session-create-blocked' }, 'Must not become live'),
    /Strict task persistence failed for TaskCreated/,
  );
  assert.equal(blockedCreationRuntime.findTaskBySource({ kind: 'bridge', key: 'bridge-session-create-blocked' }), undefined, 'failed Task creation persistence must not create a live coordination owner');

  const blockedRuntime = new TaskRuntime({ storageDirectory: blockedDirectory });
  await blockedRuntime.initialize();
  const blockedTask = await blockedRuntime.ensureTask({ kind: 'bridge', key: 'bridge-session-blocked' }, 'Blocked coordination');
  const originalTodos = [{ id: 'original', title: 'Original durable todo', status: 'in_progress' }];
  await blockedRuntime.setTodosStrict(blockedTask.taskId, originalTodos);
  await blockedRuntime.reportProgressStrict(blockedTask.taskId, { message: 'Original progress', todoId: 'original' });
  const beforeFailure = blockedRuntime.getTask(blockedTask.taskId);
  await fs.rm(blockedDirectory, { recursive: true, force: true });
  await fs.writeFile(blockedDirectory, 'block strict coordination persistence', 'utf8');

  await assert.rejects(
    () => blockedRuntime.setTodosStrict(blockedTask.taskId, [{ id: 'new', title: 'Must not appear', status: 'pending' }]),
    /Strict task persistence failed/,
  );
  assert.deepEqual(blockedRuntime.getTask(blockedTask.taskId)?.todos, beforeFailure?.todos, 'failed strict todo persistence must not mutate live Task snapshot');
  await assert.rejects(
    () => blockedRuntime.reportProgressStrict(blockedTask.taskId, { message: 'Must not appear' }),
    /Strict task persistence failed/,
  );
  assert.deepEqual(blockedRuntime.getTask(blockedTask.taskId)?.progress, beforeFailure?.progress, 'failed strict progress persistence must not mutate live Task snapshot');

  const bridgeSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'bridge-server.ts'), 'utf8');
  assert.match(bridgeSource, /setTodosOwned\(extra\.taskId, todos\)[\s\S]{0,200}projectTodos\(snapshot\.todos\)/, 'Bridge must persist Task-owned todos before legacy UI projection');
  assert.match(bridgeSource, /reportProgressOwned\(extra\.taskId, normalized\.progress\)[\s\S]{0,200}projectProgress\(snapshot\.progress!, snapshot\.todos\)/, 'Bridge must persist Task-owned progress before legacy UI projection');

  console.log('[smoke] Bridge Task-owned todo/progress validation/strict/replay/projection-order contract ok');
} finally {
  await Promise.all([
    fs.rm(directory, { recursive: true, force: true }),
    fs.rm(blockedDirectory, { recursive: true, force: true }),
    fs.rm(blockedCreationDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
