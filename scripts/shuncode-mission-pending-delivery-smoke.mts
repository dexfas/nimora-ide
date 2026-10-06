import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-pending-delivery-'));
const bundle = path.join(temp, 'pending-delivery.cjs');
const ui: any = { pick: true, confirm: true, onPick: undefined, onConfirm: undefined, picks: [], confirmations: [], messages: [] };
globalThis.__nimoraPendingDeliveryVscode = {
  EventEmitter: class { event = () => ({ dispose() {} }); fire() {} dispose() {} },
  workspace: { isTrusted: true },
  window: {
    async showQuickPick(items: any[], options: any) {
      ui.picks.push({ items, options });
      await ui.onPick?.();
      return ui.pick ? items[0] : undefined;
    },
    async showWarningMessage(message: string, options: any, action: string) {
      ui.confirmations.push({ message, options, action });
      await ui.onConfirm?.();
      return ui.confirm ? action : undefined;
    },
    async showInformationMessage(message: string) { ui.messages.push(message); if (ui.holdInformation) await new Promise(() => {}); },
  },
};

try {
  await esbuild.build({
    stdin: { contents: `
      export { ProjectStore } from './src/project-store.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
      export { MissionCollaborationStore } from './src/mission-collaboration-store.ts';
      export { WorkerSessionManager } from './src/worker-session-manager.ts';
      export { createMissionWorkProductionComposition } from './extensions/shuncode/src/mission-work-production-composition.ts';
      export { reconcileMissionPendingDelivery } from './extensions/shuncode/src/mission-pending-delivery-reconciliation.ts';
      export * from './src/mission-pending-delivery-reconciliation.ts';
    `, resolveDir: root, loader: 'ts', sourcefile: 'pending-delivery-smoke.ts' },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: ['es2022'], logLevel: 'silent',
    plugins: [{ name: 'vscode-test-surface', setup(build) {
      build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test-vscode' }));
      build.onLoad({ filter: /.*/, namespace: 'test-vscode' }, () => ({ loader: 'js', contents: 'module.exports = globalThis.__nimoraPendingDeliveryVscode;' }));
    } }],
  });
  const { ProjectStore, TaskRuntime, MissionCollaborationStore, WorkerSessionManager, createMissionWorkProductionComposition,
    reconcileMissionPendingDelivery, missionPendingDeliveryCandidates, requireCurrentMissionPendingDeliveryCandidate,
    MISSION_PENDING_DELIVERY_RECONCILIATION_REASON: reason } = require(bundle);
  let id = 0;
  let providerCalls = 0;
  const newId = () => `test-${++id}`;
  const tasksDirectory = path.join(temp, 'tasks');
  const projects = new ProjectStore({ storageDirectory: path.join(temp, 'projects'), newId });
  const tasks = new TaskRuntime({ storageDirectory: tasksDirectory, newId });
  const workers = new WorkerSessionManager({ taskBindings: tasks, executionProjection: tasks, newId });
  const collaboration = new MissionCollaborationStore({ storageDirectory: path.join(temp, 'collaboration'), projects, tasks, newId });
  const composition = createMissionWorkProductionComposition({ projects, tasks, collaboration, workers }, {
    async executeCommand() { providerCalls++; throw new Error('Reconciliation must not invoke a provider'); },
  });
  const project = await projects.createProject({ title: 'Pending delivery test' });
  const task = await tasks.ensureTask({ kind: 'mission', key: 'pending-delivery-test' }, 'Preserve execution facts');
  await tasks.configureMission(task.taskId, { projectId: project.projectId, rootMissionId: task.taskId, plane: 'practice', missionType: 'test-root', completionCriteria: ['Preserve execution facts'] });
  await tasks.attachWorkerSession(task.taskId, { managedSessionId: 'old-worker', workerId: 'nimora.chatgpt-browser-worker', adapterSessionId: 'old-provider' });
  const executionId = 'old-input:read-1';
  await tasks.beginExecution(task.taskId, {
    executionId, toolName: 'read_files', arguments: { files: [{ path: 'fixture.txt' }] },
    origin: { kind: 'worker', managedSessionId: 'old-worker', workerId: 'nimora.chatgpt-browser-worker', inputId: 'consumed-input', callId: 'read-1' },
  });
  await tasks.finishExecutionStrict(task.taskId, executionId, 'succeeded', { resultSummary: 'BEFORE; provider receipt may already have happened' });
  await tasks.markResultPreparedStrict(task.taskId, executionId, { kind: 'worker-capability', inputId: 'consumed-input', callId: 'read-1', name: 'read_files', text: 'BEFORE', isError: false });
  await tasks.recordArtifact(task.taskId, { kind: 'report', title: 'Execution evidence', executionId });
  const scope = { projectId: project.projectId, rootMissionId: task.taskId, missionId: task.taskId, executionId, reason };
  assert.equal(missionPendingDeliveryCandidates(tasks.getTask(task.taskId)).length, 0, 'current Worker retains delivery ownership');
  await assert.rejects(() => composition.application.reconcilePendingExecutionDelivery(scope), /still current/);
  await tasks.retireWorkerSessionStrict(task.taskId, 'old-worker', { reason: 'provider turn consumed' });
  // Seed a legacy status-only projection only in the disposable test journal.
  // Current interaction completion correctly returns ready; old journals may
  // still contain TaskStatusChanged without durable Mission finalization.
  await tasks.flush();
  await fs.appendFile(path.join(tasksDirectory, `${task.taskId}.jsonl`), `${JSON.stringify({
    version: 1, eventId: 'legacy-status-only', taskId: task.taskId, at: new Date().toISOString(),
    type: 'TaskStatusChanged', payload: { status: 'completed' },
  })}\n`);
  const before = await tasks.rereadTask(task.taskId);
  assert.equal(before.status, 'completed');
  assert.equal(before.missionFinalization, undefined);
  assert.equal(missionPendingDeliveryCandidates(before).length, 1, 'status-only completed Mission remains recoverable');
  for (const status of ['completed', 'failed', 'cancelled']) {
    assert.equal(missionPendingDeliveryCandidates({ ...before, status }).length, 1);
  }
  const candidate = missionPendingDeliveryCandidates(before)[0];
  const variants = [
    { ...before, mission: undefined },
    { ...before, missionFinalization: { state: 'completed' } },
    { ...before, executions: { ...before.executions, [executionId]: { ...before.executions[executionId], origin: undefined } } },
    { ...before, workerSessions: {} },
    { ...before, workerSessions: { 'old-worker': { ...before.workerSessions['old-worker'], retiredAt: undefined, detachedAt: undefined } } },
    ...['requested', 'executing', 'unknown'].map(status => ({ ...before, executions: { [executionId]: { ...before.executions[executionId], status } } })),
    ...['not-prepared', 'delivered', 'abandoned', 'unknown'].map(deliveryStatus => ({ ...before, executions: { [executionId]: { ...before.executions[executionId], deliveryStatus } } })),
  ];
  for (const snapshot of variants) assert.equal(missionPendingDeliveryCandidates(snapshot).length, 0);
  assert.equal(missionPendingDeliveryCandidates({ ...before, executions: { [executionId]: { ...before.executions[executionId], status: 'failed' } } }).length, 1);
  assert.equal(missionPendingDeliveryCandidates({ ...before, workerSessions: { 'old-worker': { ...before.workerSessions['old-worker'], retiredAt: undefined, detachedAt: 'detached' } } }).length, 1);
  assert.throws(() => requireCurrentMissionPendingDeliveryCandidate({ ...before, mission: { ...before.mission, projectId: 'other-project' } }, candidate), /changed/);
  assert.throws(() => requireCurrentMissionPendingDeliveryCandidate({ ...before, executions: { [executionId]: { ...before.executions[executionId], origin: { ...before.executions[executionId].origin, inputId: 'replacement-input' } } } }, candidate), /changed/);

  const applicationCalls: any[] = [];
  const uiComposition = { ...composition, application: { async reconcilePendingExecutionDelivery(input: any) {
    applicationCalls.push(input); return composition.application.reconcilePendingExecutionDelivery(input);
  } } };
  ui.pick = false;
  await reconcileMissionPendingDelivery(uiComposition, Promise.resolve());
  assert.equal(applicationCalls.length, 0);
  assert.equal(ui.confirmations.length, 0);
  ui.pick = true; ui.confirm = false;
  await reconcileMissionPendingDelivery(uiComposition, Promise.resolve());
  assert.equal(applicationCalls.length, 0, 'modal cancellation does not mutate canonical state');
  ui.confirm = true;
  for (const driftRead of [2, 3]) {
    let readCount = 0;
    const staleView = { initialize: () => tasks.initialize(), listTasks: () => tasks.listTasks(), async rereadTask(id: string) {
      const snapshot = await tasks.rereadTask(id);
      if (++readCount === driftRead) snapshot.executions[executionId].deliveryStatus = 'delivered';
      return snapshot;
    } };
    await assert.rejects(() => reconcileMissionPendingDelivery({ ...uiComposition, owners: { ...composition.owners, tasks: staleView } }, Promise.resolve()), /changed/);
    assert.equal(applicationCalls.length, 0, 'delivery drift before or after confirmation prevents mutation');
  }
  ui.onConfirm = async () => { await tasks.updateContext(task.taskId, { decisions: ['Unrelated context refresh'] }); };
  ui.holdInformation = true;
  const bounded = (promise: Promise<unknown>) => Promise.race([promise, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Informational notification blocked reconciliation')), 1000); timer.unref();
  })]);
  await bounded(reconcileMissionPendingDelivery(uiComposition, Promise.resolve()));
  assert.equal(ui.picks.at(-1).options.ignoreFocusOut, true);
  ui.onConfirm = undefined;
  assert.equal(applicationCalls.length, 1);
  assert.deepEqual(Object.keys(applicationCalls[0]).sort(), ['executionId', 'missionId', 'projectId', 'reason', 'rootMissionId']);
  assert.equal(applicationCalls[0].executionId, executionId);
  assert.match(ui.confirmations.at(-1).options.detail, /makes no claim about whether the provider previously received/);
  const after = await tasks.rereadTask(task.taskId);
  const afterExecution = { ...after.executions[executionId] };
  assert.equal(afterExecution.deliveryStatus, 'abandoned');
  assert.equal(afterExecution.deliveryAbandonmentReason, reason);
  delete afterExecution.deliveryAbandonedAt; delete afterExecution.deliveryAbandonmentReason;
  assert.deepEqual(afterExecution, { ...before.executions[executionId], deliveryStatus: 'abandoned' }, 'only future delivery disposition changes; execution facts are retained');
  assert.deepEqual(after.artifacts, before.artifacts);
  await bounded(reconcileMissionPendingDelivery(uiComposition, Promise.resolve()));
  assert.equal(applicationCalls.length, 1, 'abandoned execution is absent from the next picker');
  await composition.application.reconcilePendingExecutionDelivery(scope);
  const restored = new TaskRuntime({ storageDirectory: tasksDirectory, newId });
  await restored.initialize();
  assert.equal(restored.getTask(task.taskId).executions[executionId].deliveryStatus, 'abandoned', 'restart reconstructs abandonment from canonical journal');
  const journal = (await fs.readFile(path.join(tasksDirectory, `${task.taskId}.jsonl`), 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  assert.equal(journal.filter(event => event.type === 'TaskExecutionDeliveryAbandoned').length, 1, 'strict repeat is idempotent');
  assert.equal(journal.filter(event => event.type === 'TaskExecutionDelivered').length, 0, 'never invent a historical ACK');
  assert.equal(journal.filter(event => event.type === 'TaskExecutionRequested').length, 1, 'consumed execution was not replayed');
  assert.equal(providerCalls, 0);
  const finalized = await tasks.ensureTask({ kind: 'mission', key: 'finalized-reconciliation-test' }, 'Finalized test');
  await tasks.configureMission(finalized.taskId, { projectId: project.projectId, rootMissionId: finalized.taskId, plane: 'practice', missionType: 'test-root', completionCriteria: ['Done'] });
  await tasks.finalizeMissionStrict(finalized.taskId, { handoffRequired: false });
  await assert.rejects(() => composition.application.reconcilePendingExecutionDelivery({ ...scope, rootMissionId: finalized.taskId, missionId: finalized.taskId }), /terminal/);
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'extensions/shuncode/package.json'), 'utf8'));
  assert(manifest.activationEvents.includes('onCommand:shuncode.mission.reconcilePendingDelivery'));
  assert.equal(manifest.contributes.commands.filter((value: any) => value.command === 'shuncode.mission.reconcilePendingDelivery').length, 1);
  console.log('PASS public pending-delivery reconciliation: exact picker; current-origin/unknown/finalized refused; status-only Mission recoverable; cancellation/drift safe; durable abandonment=1; invented Delivered=0; replay=0; provider calls=0.');
} finally {
  delete globalThis.__nimoraPendingDeliveryVscode;
  await fs.rm(temp, { recursive: true, force: true });
}
