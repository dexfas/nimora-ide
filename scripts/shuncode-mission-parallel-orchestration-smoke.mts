import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-parallel-task-'));
const projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-parallel-project-'));
const collaborationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-parallel-collab-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-parallel-bundle-'));
const bundlePath = path.join(bundleDirectory, 'mission-parallel-orchestration-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { ProjectStore } from './src/project-store.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
      export { MissionCollaborationStore } from './src/mission-collaboration-store.ts';
      export { WorkerSessionManager } from './src/worker-session-manager.ts';
      export { MissionWorkerAssignmentService } from './src/worker-assignment.ts';
      export { MissionParallelReadinessService, MissionParallelAssignmentService } from './src/mission-parallel-orchestration.ts';
    `,
    resolveDir: root,
    sourcefile: 'mission-parallel-orchestration-smoke-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});

const {
  ProjectStore,
  TaskRuntime,
  MissionCollaborationStore,
  WorkerSessionManager,
  MissionWorkerAssignmentService,
  MissionParallelReadinessService,
  MissionParallelAssignmentService,
} = require(bundlePath);

const healthyCapabilities = Object.freeze({
  streaming: true,
  reasoning: true,
  capabilityRequests: true,
  imageInput: false,
  checkpoints: false,
  interruption: true,
  persistentContext: true,
});

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class FakeAdapter {
  createCount = 0;
  createGate = undefined;
  constructor(id, provider) { this.id = id; this.provider = provider; }
  async describe() {
    return { id: this.id, provider: this.provider, kind: 'api', label: this.id, availability: 'available', models: ['m'], capabilities: { ...healthyCapabilities } };
  }
  async createSession(options) {
    this.createCount += 1;
    const gate = this.createGate;
    const sessionId = `${this.id}-native-${this.createCount}`;
    if (gate) {
      gate.started.resolve(sessionId);
      await gate.release.promise;
      if (this.createGate === gate) this.createGate = undefined;
    }
    const now = new Date().toISOString();
    return { sessionId, workerId: this.id, state: 'idle', model: options.model, createdAt: now, lastActiveAt: now };
  }
  async *send(_session, input) { yield { type: 'terminal', inputId: input.inputId, status: 'completed' }; }
  async interrupt() {}
  async dispose(session) { session.state = 'disposed'; }
  async health() { return { status: 'healthy', checkedAt: new Date().toISOString() }; }
}

class FakeCandidateSource {
  constructor(candidates) { this.candidates = candidates; }
  async enumerateCandidates() { return structuredClone(this.candidates); }
  async refreshCandidate(candidate) {
    return { ...structuredClone(candidate), observationId: `${candidate.observationId}:fresh`, observedAt: '2026-09-28T08:00:01.000Z', health: { status: 'healthy', checkedAt: '2026-09-28T08:00:01.000Z' } };
  }
  async materializeSessionOptions(_candidate, selection) { return { model: selection.model }; }
}

function candidate(id, workerId, provider) {
  return {
    candidateId: id,
    workerId,
    provider,
    kind: 'api',
    availability: 'available',
    models: ['m'],
    capabilities: { ...healthyCapabilities },
    observationId: `obs:${id}:1`,
    observedAt: '2026-09-28T08:00:00.000Z',
    health: { status: 'healthy', checkedAt: '2026-09-28T08:00:00.000Z' },
  };
}

let taskId = 0;
let managedId = 0;
const now = () => new Date(Date.UTC(2026, 8, 28, 8, 0, taskId));

async function createMission(tasks, projectId, rootMissionId, key, plane = 'practice') {
  const task = await tasks.ensureTask({ kind: 'mission', key }, `${key} goal`);
  return tasks.configureMission(task.taskId, {
    projectId,
    rootMissionId: rootMissionId ?? task.taskId,
    ...(rootMissionId ? { parentMissionId: rootMissionId } : {}),
    plane,
    missionType: key,
    completionCriteria: [`${key} complete`],
  });
}

try {
  const projects = new ProjectStore({ storageDirectory: projectDirectory, newId: () => 'parallel-project', now });
  const tasks = new TaskRuntime({ storageDirectory: taskDirectory, newId: () => `parallel-task-${++taskId}`, now });
  await Promise.all([projects.initialize(), tasks.initialize()]);
  const project = await projects.createProject({ title: 'Mission parallel orchestration' });
  const rootMission = await createMission(tasks, project.projectId, undefined, 'root', 'cognition');
  const missionA = await createMission(tasks, project.projectId, rootMission.taskId, 'a');
  const missionB = await createMission(tasks, project.projectId, rootMission.taskId, 'b');
  const missionC = await createMission(tasks, project.projectId, rootMission.taskId, 'c');
  const missionD = await createMission(tasks, project.projectId, rootMission.taskId, 'd');
  const missionE = await createMission(tasks, project.projectId, rootMission.taskId, 'e');
  const coordinator = await createMission(tasks, project.projectId, rootMission.taskId, 'coordinator', 'coordination');

  const collaboration = new MissionCollaborationStore({ storageDirectory: collaborationDirectory, projects, tasks, now });
  await collaboration.initialize();
  await collaboration.recordRelation({ relationId: 'c-dep-a', projectId: project.projectId, sourceMissionId: missionC.taskId, targetMissionId: missionA.taskId, type: 'depends_on' });
  await collaboration.recordRelation({ relationId: 'd-dep-a', projectId: project.projectId, sourceMissionId: missionD.taskId, targetMissionId: missionA.taskId, type: 'depends_on' });
  await collaboration.recordRelation({ relationId: 'd-dep-b', projectId: project.projectId, sourceMissionId: missionD.taskId, targetMissionId: missionB.taskId, type: 'depends_on' });
  await collaboration.recordExchange({
    exchangeId: 'evidence-b', projectId: project.projectId, sourceMissionId: missionB.taskId, kind: 'Evidence',
    payload: { summary: 'B observed a blocking reality.', references: [{ type: 'file', path: 'fixture/b.txt', detail: 'blocking fixture' }] },
  });
  await collaboration.recordExchange({
    exchangeId: 'problem-b', projectId: project.projectId, sourceMissionId: missionB.taskId, kind: 'Problem',
    payload: { currentGoal: 'b', previousAssumption: 'x', observedReality: 'y', preciseQuestion: 'resolve b?', blocking: true, evidenceExchangeIds: ['evidence-b'] },
  });

  const manager = new WorkerSessionManager({ taskBindings: tasks, newId: () => `parallel-managed-${++managedId}` });
  const adapterA = new FakeAdapter('worker-a', 'provider-a');
  const adapterE = new FakeAdapter('worker-e', 'provider-e');
  await manager.register(adapterA);
  await manager.register(adapterE);
  const source = new FakeCandidateSource([
    candidate('candidate-a', adapterA.id, adapterA.provider),
    candidate('candidate-e', adapterE.id, adapterE.provider),
  ]);
  const assignment = new MissionWorkerAssignmentService(tasks, manager, [source]);
  const readiness = new MissionParallelReadinessService(projects, tasks, collaboration, manager);
  const fanout = new MissionParallelAssignmentService(readiness, assignment);

  await assert.rejects(
    readiness.inspect({ projectId: 'missing-project', rootMissionId: rootMission.taskId }),
    /Unknown parallel Project/,
  );
  await assert.rejects(
    readiness.inspect({ projectId: project.projectId, rootMissionId: rootMission.taskId, planes: ['coordination'] }),
    /must be cognition or practice/,
  );

  const first = await readiness.inspect({ projectId: project.projectId, rootMissionId: rootMission.taskId });
  assert.deepEqual(first.readyUnassignedMissionIds, [missionA.taskId, missionE.taskId].sort());
  assert.deepEqual(first.blockedMissionIds, [missionB.taskId, missionC.taskId, missionD.taskId].sort());
  assert.deepEqual(first.dependencyWaves, [[missionA.taskId, missionB.taskId, missionE.taskId].sort(), [missionC.taskId, missionD.taskId].sort()]);
  assert.equal(first.missions.some(mission => mission.missionId === coordinator.taskId), false, 'coordination Mission must not enter ordinary parallel work frontier');
  assert.equal(first.missions.find(mission => mission.missionId === missionB.taskId).blockers.some(blocker => blocker.code === 'unresolved-blocking-problem'), true);

  // Explicit fan-out must truly overlap independent Worker creation rather than
  // serializing the whole Project/root. Each request is constrained to a distinct
  // provider so resource selection itself is deterministic.
  const gateA = { started: deferred(), release: deferred() };
  const gateE = { started: deferred(), release: deferred() };
  adapterA.createGate = gateA;
  adapterE.createGate = gateE;
  const fanoutPromise = fanout.assignReady({
    projectId: project.projectId,
    rootMissionId: rootMission.taskId,
    requests: [
      { projectId: project.projectId, rootMissionId: rootMission.taskId, missionId: missionA.taskId, constraints: { allowedProviders: ['provider-a'] } },
      { projectId: project.projectId, rootMissionId: rootMission.taskId, missionId: missionE.taskId, constraints: { allowedProviders: ['provider-e'] } },
      { projectId: project.projectId, rootMissionId: rootMission.taskId, missionId: missionC.taskId, constraints: { allowedProviders: ['provider-a'] } },
    ],
  });
  const [startedA, startedE] = await Promise.all([gateA.started.promise, gateE.started.promise]);
  assert.match(startedA, /worker-a-native/);
  assert.match(startedE, /worker-e-native/);
  gateA.release.resolve();
  gateE.release.resolve();
  const fanoutResult = await fanoutPromise;
  assert.equal(fanoutResult.outcomes.find(outcome => outcome.missionId === missionA.taskId).state, 'assigned');
  assert.equal(fanoutResult.outcomes.find(outcome => outcome.missionId === missionE.taskId).state, 'assigned');
  assert.equal(fanoutResult.outcomes.find(outcome => outcome.missionId === missionC.taskId).state, 'not-ready');
  assert.deepEqual(fanoutResult.after.readyAssignedMissionIds, [missionA.taskId, missionE.taskId].sort());
  assert.equal(Object.values(tasks.getTask(missionA.taskId).workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt).length, 1);
  assert.equal(Object.values(tasks.getTask(missionE.taskId).workerSessions).filter(worker => !worker.detachedAt && !worker.retiredAt).length, 1);

  // Completing A unlocks C but D remains blocked by B. Answering B removes the
  // Problem blocker but does not bypass D's explicit dependency.
  await tasks.finalizeMissionStrict(missionA.taskId, { handoffRequired: false });
  let second = await readiness.inspect({ projectId: project.projectId, rootMissionId: rootMission.taskId });
  assert.equal(second.missions.find(mission => mission.missionId === missionA.taskId).state, 'terminal');
  assert.equal(second.blockedMissionIds.includes(missionA.taskId), false, 'terminal Mission must not be reclassified as blocked by retired/live Worker diagnostics');
  assert.equal(second.missions.find(mission => mission.missionId === missionC.taskId).state, 'ready-unassigned');
  assert.equal(second.missions.find(mission => mission.missionId === missionD.taskId).state, 'blocked');
  await collaboration.recordExchange({
    exchangeId: 'answer-b', projectId: project.projectId, sourceMissionId: missionC.taskId, targetMissionId: missionB.taskId, kind: 'Answer', replyToExchangeId: 'problem-b',
    payload: { answer: 'resolved', evidenceExchangeIds: ['evidence-b'] },
  });
  await collaboration.recordRelation({ relationId: 'answer-relation-b', projectId: project.projectId, sourceMissionId: missionC.taskId, targetMissionId: missionB.taskId, type: 'answers', basisExchangeId: 'answer-b' });
  second = await readiness.inspect({ projectId: project.projectId, rootMissionId: rootMission.taskId });
  assert.equal(second.missions.find(mission => mission.missionId === missionB.taskId).state, 'ready-unassigned');
  assert.equal(second.missions.find(mission => mission.missionId === missionD.taskId).state, 'blocked');

  // Descriptive depends_on facts are not rewritten into a global DAG. If an
  // explicit parallelization scope contains a cycle, the derivation detects and
  // fails that frontier closed without mutating CollaborationStore semantics.
  await collaboration.recordRelation({ relationId: 'b-dep-c', projectId: project.projectId, sourceMissionId: missionB.taskId, targetMissionId: missionC.taskId, type: 'depends_on' });
  await collaboration.recordRelation({ relationId: 'c-dep-b', projectId: project.projectId, sourceMissionId: missionC.taskId, targetMissionId: missionB.taskId, type: 'depends_on' });
  const cyclic = await readiness.inspect({ projectId: project.projectId, rootMissionId: rootMission.taskId, missionIds: [missionB.taskId, missionC.taskId] });
  assert.deepEqual(cyclic.dependencyCycleMissionIds, [missionB.taskId, missionC.taskId].sort());
  assert.deepEqual(cyclic.unschedulableDependencyMissionIds, [missionB.taskId, missionC.taskId].sort());
  assert.equal(cyclic.missions.every(mission => mission.blockers.some(blocker => blocker.code === 'dependency-cycle')), true);

  // Durable/live ownership ambiguity blocks fan-out rather than guessing which
  // Worker is current. Injecting a live-only session through Manager is enough to
  // prove the read model fails closed.
  const rogue = await manager.createSession('worker-a', { model: 'm' });
  await manager.bindTask(rogue.managedSessionId, missionD.taskId);
  // TaskRuntime binding above is canonical too, so detach only durable ownership
  // to create a deliberate mismatch while leaving the live Manager binding.
  await tasks.detachWorkerSession(missionD.taskId, rogue.managedSessionId);
  const ambiguous = await readiness.inspect({ projectId: project.projectId, rootMissionId: rootMission.taskId, missionIds: [missionD.taskId] });
  assert.equal(ambiguous.missions[0].blockers.some(blocker => blocker.code === 'worker-ownership-ambiguous'), true);

  console.log('PASS mission parallel orchestration smoke');
} finally {
  await Promise.all([
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(projectDirectory, { recursive: true, force: true }),
    fs.rm(collaborationDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
