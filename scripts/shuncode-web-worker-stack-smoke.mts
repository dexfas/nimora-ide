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
      export { HostCapabilityExecutionService } from ${JSON.stringify(path.join(root, 'extensions', 'shuncode', 'src', 'host-capability-execution-service.ts'))};
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

const { WebMcpCommandTransport, WebWorkerAdapter, WorkerSessionManager, TaskRuntime, HostCapabilityExecutionService } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);

class FakeCommands {
  mode = 'delivered';
  hostResolved = false;
  hostResultText = '';

  async executeCommand(command, arg) {
    if (command === '_shuncode.webMcp.workerConnect') {
      return {
        pageId: 'page-stack', sessionId: 'page-session-stack', site: 'deepseek',
        origin: 'https://chat.deepseek.com', href: 'https://chat.deepseek.com/chat', transport: 'http',
        status: { enabled: true, composerFound: true, isDeepSeekAuthPage: false },
      };
    }
    if (command === '_shuncode.webMcp.workerSend') {
      this.hostResolved = false;
      return { inputId: arg.input.inputId, state: 'running', text: '', events: [{ seq: 1, type: 'status', name: 'sent' }] };
    }
    if (command === '_shuncode.webMcp.workerPoll') {
      if (this.mode === 'host-requested') {
        return this.hostResolved
          ? {
              inputId: arg.inputId,
              state: 'completed',
              text: 'HOST_STACK_DONE',
              events: [
                { seq: 1, type: 'status', name: 'sent' },
                { seq: 2, type: 'capability_call', callId: 'host-stack-call', name: 'list_directory', arguments: { path: '.' }, dispatch: 'host-requested' },
                { seq: 3, type: 'capability_result', callId: 'host-stack-call', name: 'list_directory', text: this.hostResultText, isError: false },
                { seq: 4, type: 'status', name: 'capability_result_delivered', callId: 'host-stack-call', capability: 'list_directory' },
                { seq: 5, type: 'assistant_text', text: 'HOST_STACK_DONE' },
                { seq: 6, type: 'completed', text: 'HOST_STACK_DONE' },
              ],
            }
          : {
              inputId: arg.inputId,
              state: 'running',
              text: '',
              events: [
                { seq: 1, type: 'status', name: 'sent' },
                { seq: 2, type: 'capability_call', callId: 'host-stack-call', name: 'list_directory', arguments: { path: '.' }, dispatch: 'host-requested' },
              ],
            };
      }
      if (this.mode === 'missing-result') {
        return {
          inputId: arg.inputId,
          state: 'completed',
          text: 'MISSING_RESULT_DONE',
          events: [
            { seq: 1, type: 'status', name: 'sent' },
            { seq: 2, type: 'capability_call', callId: 'missing-call', name: 'read_files', arguments: { files: [{ path: 'README.md' }] } },
            { seq: 3, type: 'completed', text: 'MISSING_RESULT_DONE' },
          ],
        };
      }
      const deliveryEvent = this.mode === 'delivered'
        ? [{ seq: 4, type: 'status', name: 'capability_result_delivered', callId: 'stack-call', capability: 'read_files' }]
        : [];
      return {
        inputId: arg.inputId,
        state: 'completed',
        text: 'STACK_DONE',
        events: [
          { seq: 1, type: 'status', name: 'sent' },
          { seq: 2, type: 'capability_call', callId: 'stack-call', name: 'read_files', arguments: { files: [{ path: 'README.md' }] } },
          { seq: 3, type: 'capability_result', callId: 'stack-call', name: 'read_files', text: 'ok', isError: false },
          ...deliveryEvent,
          { seq: this.mode === 'delivered' ? 5 : 4, type: 'assistant_text', text: 'STACK_DONE' },
          { seq: this.mode === 'delivered' ? 6 : 5, type: 'completed', text: 'STACK_DONE' },
        ],
      };
    }
    if (command === '_shuncode.webMcp.workerHealth') return { status: { enabled: true, composerFound: true, isDeepSeekAuthPage: false } };
    if (command === '_shuncode.webMcp.workerResolve') {
      this.hostResolved = true;
      this.hostResultText = arg.result.text;
      return { inputId: arg.result.inputId, state: 'running', events: [] };
    }
    if (command === '_shuncode.webMcp.workerDisconnect') return { disconnected: true };
    if (command === '_shuncode.webMcp.workerInterrupt') return { interrupted: true };
    throw new Error(`Unexpected command: ${command}`);
  }
}

try {
  const tasks = new TaskRuntime({ storageDirectory: taskDirectory });
  await tasks.initialize();
  const task = await tasks.ensureTask({ kind: 'bridge', key: 'web-worker-stack' }, 'Web worker stack');

  const commands = new FakeCommands();
  const transport = new WebMcpCommandTransport(commands, { pollIntervalMs: 1 });
  const adapter = new WebWorkerAdapter(transport);
  let managedId = 0;
  const projection = {
    async beginWorkerExecution(taskId, input) {
      await tasks.beginExecution(taskId, {
        executionId: input.executionId,
        toolName: input.toolName,
        arguments: input.arguments,
        origin: {
          kind: 'worker',
          managedSessionId: input.managedSessionId,
          workerId: input.workerId,
          inputId: input.inputId,
          callId: input.callId,
        },
      });
    },
    async completeWorkerExecution(taskId, executionId, input) {
      await tasks.finishExecution(taskId, executionId, input.status, input);
      await tasks.markResultPrepared(taskId, executionId);
    },
    async markWorkerExecutionDelivered(taskId, executionId) {
      await tasks.markDelivered(taskId, executionId);
    },
  };
  const manager = new WorkerSessionManager({
    taskBindings: tasks,
    executionProjection: projection,
    newId: () => `web-managed-${++managedId}`,
  });
  const brokerCalls = [];
  const hostExecution = new HostCapabilityExecutionService(tasks, {
    async invokeDirect(name, args) {
      brokerCalls.push({ name, args });
      return { text: 'HOST_BROKER_LIST_OK', isError: false };
    },
  });
  const descriptor = await manager.register(adapter);
  assert.equal(descriptor.id, 'nimora.web-worker');
  assert.equal(descriptor.kind, 'web');

  const session = await manager.createSession('nimora.web-worker', { contextHandle: 'handoff-1' }, task.taskId);
  assert.equal(session.adapterSessionId, 'page-session-stack');
  assert.equal(session.taskId, task.taskId);
  assert.equal(tasks.getTask(task.taskId).workerSessions[session.managedSessionId].adapterSessionId, 'page-session-stack');

  const events = [];
  for await (const event of manager.send(session.managedSessionId, { inputId: 'stack-turn-1', prompt: 'continue durable task' })) events.push(event);
  assert.deepEqual(events.map(event => event.type), ['provider_event', 'capability_call', 'capability_result', 'provider_event', 'text_delta', 'terminal']);
  assert.equal(events.find(event => event.type === 'capability_call').name, 'read_files');
  assert.equal(events.at(-1).status, 'completed');
  assert.equal(events.at(-1).result.text, 'STACK_DONE');
  assert.equal(manager.getSession(session.managedSessionId).state, 'idle');
  assert.equal((await manager.health(session.managedSessionId)).status, 'healthy');

  const deliveredExecution = Object.values(tasks.getTask(task.taskId).executions)[0];
  assert.equal(deliveredExecution.status, 'succeeded');
  assert.equal(deliveredExecution.deliveryStatus, 'delivered');
  assert.equal(deliveredExecution.toolName, 'read_files');
  assert.equal(deliveredExecution.origin.managedSessionId, session.managedSessionId);
  assert.equal(deliveredExecution.origin.workerId, 'nimora.web-worker');
  assert.equal(deliveredExecution.origin.inputId, 'stack-turn-1');
  assert.equal(deliveredExecution.origin.callId, 'stack-call');

  await manager.dispose(session.managedSessionId);

  commands.mode = 'pending';
  const pendingSession = await manager.createSession('nimora.web-worker', {}, task.taskId);
  for await (const _event of manager.send(pendingSession.managedSessionId, { inputId: 'stack-turn-pending', prompt: 'pending delivery' })) {}
  const pendingExecution = Object.values(tasks.getTask(task.taskId).executions)
    .find(execution => execution.executionId.includes(pendingSession.managedSessionId));
  assert.equal(pendingExecution.status, 'succeeded');
  assert.equal(pendingExecution.deliveryStatus, 'pending');
  await manager.dispose(pendingSession.managedSessionId);

  commands.mode = 'missing-result';
  const unknownSession = await manager.createSession('nimora.web-worker', {}, task.taskId);
  for await (const _event of manager.send(unknownSession.managedSessionId, { inputId: 'stack-turn-unknown', prompt: 'missing result' })) {}
  const unknownExecution = Object.values(tasks.getTask(task.taskId).executions)
    .find(execution => execution.executionId.includes(unknownSession.managedSessionId));
  assert.equal(unknownExecution.status, 'unknown');
  assert.equal(unknownExecution.deliveryStatus, 'pending');
  assert.match(unknownExecution.error, /before a capability result was observed/);

  await manager.dispose(unknownSession.managedSessionId);

  commands.mode = 'host-requested';
  const hostSession = await manager.createSession('nimora.web-worker', {}, task.taskId);
  const hostIterator = manager.send(hostSession.managedSessionId, { inputId: 'stack-turn-host', prompt: 'host managed capability' })[Symbol.asyncIterator]();
  let hostCall;
  for (;;) {
    const next = await hostIterator.next();
    assert.equal(next.done, false);
    if (next.value.type === 'capability_call') {
      hostCall = next.value;
      break;
    }
  }
  assert.equal(hostCall.dispatch, 'host-requested');
  assert.equal(hostCall.name, 'list_directory');
  assert.match(hostCall.extensions.executionId, new RegExp(`^worker:${hostSession.managedSessionId}:stack-turn-host:1$`));
  assert.equal(tasks.getTask(task.taskId).executions[hostCall.extensions.executionId], undefined, 'host-requested call must not be shadow-started before strict owner claim');
  await hostExecution.executeAndDeliver({
    executionId: hostCall.extensions.executionId,
    managedSessionId: hostSession.managedSessionId,
    workerId: hostSession.workerId,
    taskId: hostSession.taskId,
    inputId: hostCall.inputId,
    callId: hostCall.callId,
    name: hostCall.name,
    arguments: hostCall.arguments,
  }, manager);
  assert.deepEqual(brokerCalls, [{ name: 'list_directory', args: { path: '.' } }]);
  const hostOwnedExecution = tasks.getTask(task.taskId).executions[hostCall.extensions.executionId];
  assert.equal(hostOwnedExecution.status, 'succeeded');
  assert.equal(hostOwnedExecution.deliveryStatus, 'delivered');
  assert.equal(hostOwnedExecution.resultPayload.text, 'HOST_BROKER_LIST_OK');
  const hostRemaining = [];
  for (;;) {
    const next = await hostIterator.next();
    if (next.done) break;
    hostRemaining.push(next.value);
  }
  assert.equal(hostRemaining.at(-1).status, 'completed');
  assert.equal(hostRemaining.find(event => event.type === 'capability_result')?.text, 'HOST_BROKER_LIST_OK');
  assert.equal(tasks.getTask(task.taskId).executions[hostCall.extensions.executionId].duplicateObservations, 0, 'Manager must not shadow-project host-owned execution after strict owner claim');
  await manager.dispose(hostSession.managedSessionId);

  assert.ok(tasks.getTask(task.taskId).workerSessions[session.managedSessionId].detachedAt);
  assert.ok(tasks.getTask(task.taskId).workerSessions[pendingSession.managedSessionId].detachedAt);
  assert.ok(tasks.getTask(task.taskId).workerSessions[unknownSession.managedSessionId].detachedAt);
  assert.ok(tasks.getTask(task.taskId).workerSessions[hostSession.managedSessionId].detachedAt);
  await tasks.flush();

  const restarted = new TaskRuntime({ storageDirectory: taskDirectory });
  await restarted.initialize();
  assert.equal(restarted.getTask(task.taskId).workerSessions[session.managedSessionId].adapterSessionId, 'page-session-stack');
  assert.ok(restarted.getTask(task.taskId).workerSessions[session.managedSessionId].detachedAt);
  assert.deepEqual(restarted.getTask(task.taskId).executions, tasks.getTask(task.taskId).executions);

  console.log('[smoke] Web Worker stack task binding + execution projection delivered/pending/unknown + replay ok');
} finally {
  await Promise.all([
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
