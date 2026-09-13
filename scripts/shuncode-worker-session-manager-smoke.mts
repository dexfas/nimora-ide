import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.resolve(import.meta.dirname, '..', 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-worker-manager-task-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-worker-manager-bundle-'));
const bundlePath = path.join(bundleDirectory, 'worker-session-manager-smoke.mjs');

await esbuild.build({
  stdin: {
    contents: `
      export { WorkerSessionManager } from ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'src', 'worker-session-manager.ts'))};
      export { TaskRuntime } from ${JSON.stringify(path.resolve(import.meta.dirname, '..', 'src', 'task-runtime.ts'))};
    `,
    resolveDir: path.resolve(import.meta.dirname, '..'),
    sourcefile: 'worker-session-manager-smoke-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['es2022'],
  logLevel: 'silent',
});

const { WorkerSessionManager, TaskRuntime } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

class FakeAdapter {
  disposed = [];
  interrupted = [];
  checkpoints = [];

  constructor(id, label) {
    this.id = id;
    this.label = label;
  }

  async describe() {
    return {
      id: this.id,
      provider: this.id,
      kind: 'api',
      label: this.label,
      availability: 'available',
      models: ['fake-model'],
      capabilities: {
        streaming: true,
        reasoning: true,
        capabilityRequests: true,
        imageInput: false,
        checkpoints: true,
        interruption: true,
        persistentContext: true,
      },
    };
  }

  async createSession(options) {
    const now = new Date().toISOString();
    return {
      sessionId: 'provider-session',
      workerId: this.id,
      state: 'idle',
      model: options.model,
      contextHandle: options.contextHandle,
      createdAt: now,
      lastActiveAt: now,
    };
  }

  async *send(session, input) {
    session.state = 'running';
    session.lastActiveAt = new Date().toISOString();
    yield { type: 'text_delta', inputId: input.inputId, text: `${this.id}:hello` };
    session.state = 'idle';
    session.lastActiveAt = new Date().toISOString();
    yield { type: 'terminal', inputId: input.inputId, status: 'completed' };
  }

  async interrupt(session) {
    this.interrupted.push(session.sessionId);
    session.state = 'interrupted';
  }

  async resume(session, checkpoint) {
    this.checkpoints.push(checkpoint);
    session.state = 'idle';
  }

  async dispose(session) {
    this.disposed.push(session.sessionId);
    session.state = 'disposed';
  }

  async health() {
    return { status: 'healthy', checkedAt: new Date().toISOString() };
  }
}

let managerId = 0;
const newManagedId = () => `managed-${++managerId}`;

try {
  const tasks = new TaskRuntime({ storageDirectory: taskDirectory });
  await tasks.initialize();
  const taskA = await tasks.ensureTask({ kind: 'bridge', key: 'worker-manager-a' }, 'Task A');
  const taskB = await tasks.ensureTask({ kind: 'bridge', key: 'worker-manager-b' }, 'Task B');

  const api = new FakeAdapter('worker.api', 'API Worker');
  const agent = new FakeAdapter('worker.agent', 'Agent Worker');
  const manager = new WorkerSessionManager({ newId: newManagedId, taskBindings: tasks });
  await manager.register(api);
  await manager.register(agent);
  await assert.rejects(async () => manager.register(api), /already registered/);
  assert.deepEqual(manager.listWorkers().map(worker => worker.id).sort(), ['worker.agent', 'worker.api']);

  const apiSession = await manager.createSession('worker.api', { model: 'fake-model', contextHandle: 'ctx-a' }, taskA.taskId);
  const agentSession = await manager.createSession('worker.agent', { model: 'fake-model' }, taskA.taskId);
  assert.notEqual(apiSession.managedSessionId, agentSession.managedSessionId, 'manager ids must remain unique even when provider-native session ids collide');
  assert.equal(apiSession.adapterSessionId, agentSession.adapterSessionId, 'smoke intentionally uses colliding provider-native ids');
  assert.equal(manager.listSessions({ taskId: taskA.taskId }).length, 2);
  assert.equal(tasks.getTask(taskA.taskId).workerSessions[apiSession.managedSessionId].adapterSessionId, 'provider-session');

  const stream = manager.send(apiSession.managedSessionId, { inputId: 'turn-1', prompt: 'hello' })[Symbol.asyncIterator]();
  const first = await stream.next();
  assert.equal(first.value.type, 'text_delta');
  assert.equal(manager.getSession(apiSession.managedSessionId).state, 'running');
  await assert.rejects(async () => manager.bindTask(apiSession.managedSessionId, taskB.taskId), /Cannot rebind running/);
  const terminal = await stream.next();
  assert.equal(terminal.value.status, 'completed');
  assert.equal(manager.getSession(apiSession.managedSessionId).state, 'idle');

  await manager.resume(apiSession.managedSessionId, { checkpoint: 1 });
  assert.deepEqual(api.checkpoints, [{ checkpoint: 1 }]);
  assert.equal((await manager.health(apiSession.managedSessionId)).status, 'healthy');
  assert.equal((await manager.healthWorker('worker.api')).status, 'healthy');

  await manager.bindTask(apiSession.managedSessionId, taskB.taskId);
  assert.ok(tasks.getTask(taskA.taskId).workerSessions[apiSession.managedSessionId].detachedAt);
  assert.equal(tasks.getTask(taskB.taskId).workerSessions[apiSession.managedSessionId].workerId, 'worker.api');

  await manager.interrupt(agentSession.managedSessionId);
  assert.equal(manager.getSession(agentSession.managedSessionId).state, 'interrupted');
  assert.deepEqual(agent.interrupted, ['provider-session']);

  await manager.dispose(apiSession.managedSessionId);
  await manager.dispose(agentSession.managedSessionId);
  assert.ok(tasks.getTask(taskB.taskId).workerSessions[apiSession.managedSessionId].detachedAt);
  assert.ok(tasks.getTask(taskA.taskId).workerSessions[agentSession.managedSessionId].detachedAt);
  assert.equal(manager.listSessions().length, 0);
  manager.unregister('worker.api');
  manager.unregister('worker.agent');

  await tasks.flush();
  const restarted = new TaskRuntime({ storageDirectory: taskDirectory });
  await restarted.initialize();
  assert.deepEqual(restarted.getTask(taskA.taskId).workerSessions, tasks.getTask(taskA.taskId).workerSessions);
  assert.deepEqual(restarted.getTask(taskB.taskId).workerSessions, tasks.getTask(taskB.taskId).workerSessions);

  console.log('[smoke] WorkerSessionManager registry/routing/task binding/replay ok');
} finally {
  await Promise.all([
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
