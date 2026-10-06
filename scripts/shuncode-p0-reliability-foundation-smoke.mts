import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p0-reliability-'));
const bundlePath = path.join(bundleDirectory, 'p0-reliability-foundation.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export * from './src/mission-observation-event.ts';
      export * from './src/browser-worker-observation.ts';
    `,
    resolveDir: root,
    sourcefile: 'p0-reliability-foundation-smoke-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});

const p0 = require(bundlePath);

try {
  const scope = { projectId: 'project-p0', rootMissionId: 'mission-root', missionId: 'mission-practice' };
  const taskEvent = {
    version: 1,
    eventId: 'task-event-retired',
    taskId: scope.missionId,
    at: '2026-09-28T09:00:00.000Z',
    type: 'TaskWorkerRetired',
    payload: { managedSessionId: 'managed-a', retiredAt: '2026-09-28T09:00:00.000Z', reason: 'capacity rotation' },
  };
  const taskObservation = p0.observeTaskRuntimeEvent(scope, taskEvent, { observationId: 'obs-task-1', correlationId: 'corr-rotation' });
  assert.equal(taskObservation.name, 'worker.retired');
  assert.equal(taskObservation.source.owner, 'task-runtime');
  assert.equal(taskObservation.source.sourceRecordId, taskEvent.eventId);
  assert.deepEqual(taskObservation.facts, { ownerEventType: 'TaskWorkerRetired' });
  assert.equal('payload' in taskObservation, false, 'observation must not clone canonical TaskRuntime payload');

  const projectEvent = {
    version: 1,
    eventId: 'project-event-decision',
    projectId: scope.projectId,
    at: '2026-09-28T09:00:01.000Z',
    type: 'ProjectDecisionCommitted',
    payload: { decision: {} },
  };
  const projectObservation = p0.observeProjectEvent(scope, projectEvent, { observationId: 'obs-project-1' });
  assert.equal(projectObservation.name, 'project.decision-committed');
  assert.equal(projectObservation.source.owner, 'project-store');

  const problemExchange = {
    exchangeId: 'problem-1',
    projectId: scope.projectId,
    sourceMissionId: scope.missionId,
    targetMissionId: 'mission-cognition',
    kind: 'Problem',
    createdAt: '2026-09-28T09:00:02.000Z',
    payload: {
      currentGoal: 'continue safely',
      previousAssumption: 'connection healthy',
      observedReality: 'connection dropped',
      preciseQuestion: 'reconcile?',
      blocking: true,
      evidenceExchangeIds: [],
    },
  };
  const collaborationObservation = p0.observeMissionExchange(scope.rootMissionId, problemExchange, { observationId: 'obs-problem-1' });
  assert.equal(collaborationObservation.name, 'collaboration.problem-recorded');
  assert.equal(collaborationObservation.scope.missionId, scope.missionId);
  assert.equal(collaborationObservation.facts.targetMissionId, 'mission-cognition');

  assert.throws(
    () => p0.createMissionObservationEvent({
      observationId: 'bad-content',
      at: '2026-09-28T09:00:03.000Z',
      kind: 'operational',
      name: 'browser.observed',
      scope,
      source: { owner: 'browser-worker-runtime', component: 'BrowserWorkerRuntime' },
      facts: { providerTranscript: 'must never enter the observation bus' },
    }),
    /provider\/private content/,
    'observation facts must reject transcript/prompt-style payload keys',
  );
  assert.throws(
    () => p0.createMissionObservationEvent({
      observationId: 'bad-owner',
      at: '2026-09-28T09:00:04.000Z',
      kind: 'operational',
      name: 'browser.observed',
      scope,
      source: { owner: 'new-hidden-owner', component: 'BadOwner' },
    }),
    /Unsupported Mission observation source owner/,
    'unknown source owners must fail closed at runtime',
  );

  const base = {
    transport: 'connected',
    page: 'exact',
    conversation: 'exact',
    turn: 'idle',
    auth: 'ready',
    capability: 'exact',
    checkedAt: '2026-09-28T09:10:00.000Z',
  };
  const ready = p0.deriveBrowserWorkerOperationalObservation(base);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.turnSettlement, 'settled');

  const busy = p0.deriveBrowserWorkerOperationalObservation({ ...base, turn: 'tool-phase' });
  assert.equal(busy.state, 'busy');
  assert.equal(busy.turnSettlement, 'active');

  const lostDuringWork = p0.deriveBrowserWorkerOperationalObservation({ ...base, transport: 'lost', turn: 'running' });
  assert.equal(lostDuringWork.state, 'connection-lost');
  assert.equal(lostDuringWork.turnSettlement, 'active', 'connection loss must not imply the active turn is settled');

  assert.equal(p0.deriveBrowserWorkerOperationalObservation({ ...base, transport: 'reconnecting' }).state, 'recovering');
  assert.equal(p0.deriveBrowserWorkerOperationalObservation({ ...base, page: 'drifted' }).state, 'page-drift');
  assert.equal(p0.deriveBrowserWorkerOperationalObservation({ ...base, conversation: 'drifted' }).state, 'conversation-drift');
  assert.equal(p0.deriveBrowserWorkerOperationalObservation({ ...base, capability: 'stale' }).state, 'capability-drift');
  assert.equal(p0.deriveBrowserWorkerOperationalObservation({ ...base, turn: 'unknown' }).state, 'settlement-unknown');
  assert.equal(p0.deriveBrowserWorkerOperationalObservation({ ...base, auth: 'challenge' }).state, 'waiting-human');
  assert.equal(p0.deriveBrowserWorkerOperationalObservation({ ...base, capability: 'unknown' }).state, 'unavailable');
  assert.equal(
    p0.deriveBrowserWorkerOperationalObservation({ ...base, retired: true, transport: 'lost', turn: 'unknown' }).state,
    'retired',
    'durably retired Worker identity must dominate transient browser observations',
  );
  assert.throws(
    () => p0.deriveBrowserWorkerOperationalObservation({ ...base, transport: 'connected-ish' }),
    /transport state is invalid/,
    'unknown runtime enum values must not accidentally derive ready',
  );

  const browserObservationEvent = p0.createMissionObservationEvent({
    observationId: 'obs-browser-lost',
    at: lostDuringWork.checkedAt,
    kind: 'operational',
    name: 'browser.worker-state-observed',
    scope,
    source: { owner: 'browser-worker-runtime', component: 'BrowserWorkerRuntime', sourceRecordId: 'page-generation-17' },
    worker: { managedSessionId: 'managed-a', workerId: 'nimora.chatgpt-browser-worker', adapterSessionId: 'chatgpt-lifecycle-a' },
    correlationId: 'corr-rotation',
    facts: p0.browserWorkerObservationFacts(lostDuringWork),
  });
  assert.equal(browserObservationEvent.kind, 'operational');
  assert.equal(browserObservationEvent.facts.operationalState, 'connection-lost');
  assert.equal(browserObservationEvent.facts.turnSettlement, 'active');
  assert.equal(browserObservationEvent.correlationId, taskObservation.correlationId);

  console.log('PASS P0 reliability foundation smoke');
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
