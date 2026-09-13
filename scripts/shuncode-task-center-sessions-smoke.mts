import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-task-center-sessions-'));
const bundlePath = path.join(bundleDirectory, 'task-center-session-presentation.cjs');

await esbuild.build({
  stdin: {
    contents: `export { presentTaskSession, presentTaskSessionArtifacts, buildTaskSessionFileTree, formatTaskSessionMarkdown } from './extensions/shuncode/src/task-center-session-presentation.ts';`,
    resolveDir: root,
    sourcefile: 'task-center-session-presentation-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});

const { presentTaskSession, presentTaskSessionArtifacts, buildTaskSessionFileTree, formatTaskSessionMarkdown } = require(bundlePath);

const summary = {
  version: 1,
  taskId: 'task-a',
  status: 'running',
  sourceKind: 'bridge',
  goal: 'Ship\nTask-owned Work Sessions',
  createdAt: '2026-09-13T08:00:00.000Z',
  updatedAt: '2026-09-13T08:06:00.000Z',
  todoCounts: { total: 3, pending: 1, inProgress: 1, completed: 1 },
  progress: { message: 'Projecting Task state', phase: 'Work Sessions', percent: 60, todoId: 'project', at: '2026-09-13T08:05:00.000Z' },
  workerCount: 2,
  activeWorkerCount: 1,
  executionCounts: { total: 4, running: 0, succeeded: 3, failed: 1, unknown: 0, pendingDelivery: 1 },
  artifactCount: 3,
};

const detail = {
  summary,
  todos: [
    { id: 'inspect', title: 'Inspect native Sessions', status: 'completed' },
    { id: 'project', title: 'Project Task state', status: 'in_progress' },
    { id: 'verify', title: 'Verify', status: 'pending' },
  ],
  progress: summary.progress,
  workers: [
    { managedSessionId: 'worker-a', workerId: 'nimora.web-worker', model: 'deepseek', attachedAt: '2026-09-13T08:01:00.000Z' },
    { managedSessionId: 'worker-b', workerId: 'nimora.api-worker', attachedAt: '2026-09-13T08:02:00.000Z', detachedAt: '2026-09-13T08:04:00.000Z' },
  ],
  timeline: [
    { id: 'execution:read', kind: 'execution', at: '2026-09-13T08:03:00.000Z', title: 'read_files', status: 'succeeded', deliveryStatus: 'pending', resultSummary: 'Read workspace files' },
    { id: 'artifact:a', kind: 'artifact', at: '2026-09-13T08:04:00.000Z', title: 'Changed one file', artifactKind: 'changeset' },
    { id: 'progress:p', kind: 'progress', at: '2026-09-13T08:05:00.000Z', title: 'Work Sessions', message: 'Projecting Task state', percent: 60, todoId: 'project' },
  ],
  artifacts: [
    { artifactId: 'changes', kind: 'changeset', title: 'Workspace patch', createdAt: '2026-09-13T08:04:00.000Z', metadata: { files: ['src/b.ts', 'src/a.ts', '../escape.txt', '/absolute.txt'], additions: 10, deletions: 2, diffTruncated: true } },
    { artifactId: 'report', kind: 'report', title: 'Review report', uri: 'https://example.com/report', createdAt: '2026-09-13T08:04:30.000Z' },
    { artifactId: 'unsafe', kind: 'other', title: 'Unsafe command URI', uri: 'command:do-not-run', createdAt: '2026-09-13T08:04:40.000Z' },
  ],
};

try {
  const presentation = presentTaskSession(summary);
  assert.equal(presentation.label, 'Ship Task-owned Work Sessions', 'session labels must stay single-line');
  assert.equal(presentation.description, '1/3 todos · 1 active AI · 4 actions · 3 artifacts');
  assert.equal(presentation.badge, '60%');
  assert.equal(presentation.status, 'in_progress');
  assert.equal(presentation.terminal, false);

  assert.deepEqual(
    { status: presentTaskSession({ ...summary, status: 'waiting_user' }).status, badge: presentTaskSession({ ...summary, status: 'waiting_user' }).badge },
    { status: 'needs_input', badge: 'Needs input' },
  );
  assert.equal(presentTaskSession({ ...summary, status: 'completed' }).terminal, true);

  const artifacts = presentTaskSessionArtifacts(detail);
  assert.deepEqual(artifacts[0].files, ['src/b.ts', 'src/a.ts'], 'artifact presentation must drop absolute/traversal paths');
  assert.deepEqual(buildTaskSessionFileTree(artifacts[0].files), [{ name: 'src', children: [{ name: 'a.ts' }, { name: 'b.ts' }] }]);

  const markdown = formatTaskSessionMarkdown(detail);
  assert.match(markdown, /### Todos/);
  assert.match(markdown, /### AI Workers/);
  assert.match(markdown, /### Timeline/);
  assert.match(markdown, /### Artifacts/);
  assert.match(markdown, /Workspace patch\*\* · changeset · 2 files · \+10 · -2 · diff summary truncated/);
  assert.match(markdown, /`src\/a\.ts`/);
  assert.doesNotMatch(markdown, /escape\.txt|absolute\.txt/, 'unsafe artifact paths must not reach Work Sessions markdown');
  assert.match(markdown, /read_files:\*\* succeeded · result pending delivery/, 'execution and result delivery state must remain separate in presentation');
  assert.doesNotMatch(markdown, /opaque-session-key/, 'Work Sessions presentation must not expose source session keys');

  const sessionsSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'task-center-sessions.ts'), 'utf8');
  assert.match(sessionsSource, /createChatSessionItemController\(NIMORA_TASK_SESSION_TYPE/);
  assert.match(sessionsSource, /registerChatSessionContentProvider\(/);
  assert.match(sessionsSource, /new vscode\.ChatResponseFileTreePart\(/, 'changeset artifacts must use the native file-tree presentation');
  assert.match(sessionsSource, /new vscode\.ChatResponseAnchorPart\(/, 'URI artifacts must use native anchors');
  assert.match(sessionsSource, /uri\.scheme === "http" \|\| uri\.scheme === "https"/);
  assert.match(sessionsSource, /uri\.scheme !== "file" \|\| !workspace/, 'file anchors require a workspace containment check');
  assert.match(sessionsSource, /requestHandler:\s*undefined/, 'Task content must be read-only; Chat is a projection, not the Task owner');
  assert.match(sessionsSource, /taskShadow\.onDidChangeTask/, 'native Work Sessions must refresh from Task owner changes');

  const extensionSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'extension.ts'), 'utf8');
  assert.match(extensionSource, /registerTaskCenterSessions\(context, taskShadow, participant, SHUNCODE_PARTICIPANT_ID, output\)/);
  assert.match(extensionSource, /registerCommand\("shuncode\.taskCenter\.open"[\s\S]{0,200}workbench\.action\.chat\.history/);

  const extensionPackage = JSON.parse(await fs.readFile(path.join(root, 'extensions', 'shuncode', 'package.json'), 'utf8'));
  assert.ok(extensionPackage.enabledApiProposals.includes('chatSessionsProvider'));
  assert.ok(extensionPackage.activationEvents.includes('onCommand:shuncode.taskCenter.open'));
  const contribution = extensionPackage.contributes.chatSessions.find((item: { type: string }) => item.type === 'nimora-task');
  assert.ok(contribution);
  assert.equal(contribution.displayName, 'Nimora Work Sessions');
  assert.equal(contribution.canDelegate, false, 'Task projection must not masquerade as an AI provider');
  assert.ok(extensionPackage.contributes.commands.some((item: { command: string; title: string }) => item.command === 'shuncode.taskCenter.open' && item.title === 'Nimora: Open Work Sessions'));

  const tsconfig = JSON.parse(await fs.readFile(path.join(root, 'extensions', 'shuncode', 'tsconfig.json'), 'utf8'));
  assert.ok(tsconfig.files.includes('../../src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts'));
  assert.ok(tsconfig.files.includes('src/task-center-sessions.ts'));
  assert.ok(tsconfig.files.includes('src/task-center-session-presentation.ts'));

  console.log('[smoke] Task-owned native Work Sessions projection contract ok');
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
