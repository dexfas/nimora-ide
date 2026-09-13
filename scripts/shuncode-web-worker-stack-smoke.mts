import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-web-worker-stack-task-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-web-worker-stack-bundle-'));
const bundlePath = path.join(bundleDirectory, 'stack.mjs');
const root = path.resolve(import.meta.dirname, '..');

await esbuild.build({
  stdin: {
    contents: `
      export { WebMcpCommandTransport } from ${JSON.stringify(path.join(root, 'extensions', 'shuncode', 'src', 'webmcp-worker-transport.ts'))};
      export { WebWorkerAdapter } from ${JSON.stringify(path.join(root, 'src', 'web-worker-adapter.ts'))};
      export { WorkerSessionManager } from ${JSON.stringify(path.join(root, 'src', 'worker-session-manager.ts'))};
      export { TaskRuntime } from ${JSON.stringify(path.join(root, 'src', 'task-runtime.ts'))};
    `,
    resolveDir: root,
    sourcefile: 'web-worker-stack-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['es2022'],
  logLevel: 'silent',
});

const { WebMcpCommandTransport, WebWorkerAdapter, WorkerSessionManager, TaskRuntime } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

class FakeCommands {
  async executeCommand(command, arg) {
    if (command === '_shuncode.webMcp.workerConnect') {
      return {
        pageId: 'page-stack', sessionId: 'page-session-stack', site: 'deepseek',
        origin: 'https://chat.deepseek.com', href: 'https://chat.deepseek.com/chat', transport: 'http',
        status: { enabled: true, composerFound: true, isDeepSeekAuthPage: false },
      };
    }
    if (command === '_shuncode.webMcp.workerSend') {
      return { inputId: arg.input.inputId, state: 'running', text: '', events: [{ seq: 1, type: 'status', name: 'sent' }] };
    }
    if (command === '_shuncode.webMcp.workerPoll') {
      return {
        inputId: arg.inputId,
        state: 'completed',
        text: 'STACK_DONE',
        events: [
          { seq: 1, type: 'status', name: 'sent' },
          { seq: 2, type: 'capability_call', callId: 'stack-call', name: 'read_files', arguments: { files: [{ path: 'README.md' }] } },
          { seq: 3, type: 'capability_result', callId: 'stack-call', name: 'read_files', text: 'ok', isError: false },
          { seq: 4, type: 'assistant_text', text: 'STACK_DONE' },
          { seq: 5, type: 'completed', text: 'STACK_DONE' },
        ],
      };
    }
    if (command === '_shuncode.webMcp.workerHealth') return { status: { enabled: true, composerFound: true, isDeepSeekAuthPage: false } };
    if (command === '_shuncode.webMcp.workerDisconnect') return { disconnected: true };
    if (command === '_shuncode.webMcp.workerInterrupt') return { interrupted: true };
    throw new Error(`Unexpected command: ${command}`);
  }
}

try {
  const tasks = new TaskRuntime({ storageDirectory: taskDirectory });
  await tasks.initialize();
  const task = await tasks.ensureTask({ kind: 'bridge', key: 'web-worker-stack' }, 'Web worker stack');

  const transport = new WebMcpCommandTransport(new FakeCommands(), { pollIntervalMs: 1 });
  const adapter = new WebWorkerAdapter(transport);
  let managedId = 0;
  const manager = new WorkerSessionManager({ taskBindings: tasks, newId: () => `web-managed-${++managedId}` });
  const descriptor = await manager.register(adapter);
  assert.equal(descriptor.id, 'nimora.web-worker');
  assert.equal(descriptor.kind, 'web');

  const session = await manager.createSession('nimora.web-worker', { contextHandle: 'handoff-1' }, task.taskId);
  assert.equal(session.adapterSessionId, 'page-session-stack');
  assert.equal(session.taskId, task.taskId);
  assert.equal(tasks.getTask(task.taskId).workerSessions[session.managedSessionId].adapterSessionId, 'page-session-stack');

  const events = [];
  for await (const event of manager.send(session.managedSessionId, { inputId: 'stack-turn-1', prompt: 'continue durable task' })) events.push(event);
  assert.deepEqual(events.map(event => event.type), ['provider_event', 'capability_call', 'capability_result', 'text_delta', 'terminal']);
  assert.equal(events.find(event => event.type === 'capability_call').name, 'read_files');
  assert.equal(events.at(-1).status, 'completed');
  assert.equal(events.at(-1).result.text, 'STACK_DONE');
  assert.equal(manager.getSession(session.managedSessionId).state, 'idle');
  assert.equal((await manager.health(session.managedSessionId)).status, 'healthy');

  await manager.dispose(session.managedSessionId);
  assert.ok(tasks.getTask(task.taskId).workerSessions[session.managedSessionId].detachedAt);
  await tasks.flush();

  const restarted = new TaskRuntime({ storageDirectory: taskDirectory });
  await restarted.initialize();
  assert.equal(restarted.getTask(task.taskId).workerSessions[session.managedSessionId].adapterSessionId, 'page-session-stack');
  assert.ok(restarted.getTask(task.taskId).workerSessions[session.managedSessionId].detachedAt);

  console.log('[smoke] WebMCP command transport → WebWorkerAdapter → WorkerSessionManager → TaskRuntime replay ok');
} finally {
  await Promise.all([
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
