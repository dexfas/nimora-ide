import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const esbuild = require('esbuild');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-succession-'));
try {
  const outfile = path.join(tmp, 'succession.cjs');
  await esbuild.build({
    stdin: { contents: [
      "export { ProjectStore } from './src/project-store.ts';",
      "export { TaskRuntime } from './src/task-runtime.ts';",
      "export { MissionCollaborationStore } from './src/mission-collaboration-store.ts';",
      "export { WorkerSessionManager } from './src/worker-session-manager.ts';",
      "export { MissionWorkerAssignmentService } from './src/worker-assignment.ts';",
      "export { MissionWorkerSuccessionService } from './src/mission-worker-succession-service.ts';",
      "export { MissionContextMaterializer } from './src/mission-context-materializer.ts';",
    ].join('\n'), resolveDir: root, sourcefile: 'succession-entry.ts', loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'cjs', target: 'es2022', logLevel: 'silent',
  });
  const lib = require(outfile);
  class Adapter {
    constructor(id, provider) { this.id = id; this.provider = provider; this.created = 0; this.sends = 0; }
    async describe() { return { id: this.id, provider: this.provider, kind: 'api', label: this.id, availability: 'available', models: ['m'],
      capabilities: { streaming: true, reasoning: true, capabilityRequests: true, imageInput: false, checkpoints: false, interruption: true, persistentContext: true } }; }
    async createSession(options) { const now = new Date().toISOString(); return { sessionId: this.id + '-native-' + (++this.created), workerId: this.id, state: 'idle', model: options.model, createdAt: now, lastActiveAt: now }; }
    async *send(session, input) { this.sends += 1; session.state = 'running'; yield { type: 'text_delta', inputId: input.inputId, text: 'observed-turn-' + this.sends }; session.state = 'idle'; yield { type: 'terminal', inputId: input.inputId, status: 'completed' }; }
    async interrupt(session) { session.state = 'interrupted'; }
    async dispose(session) { session.state = 'disposed'; }
    async health() { return { status: 'healthy', checkedAt: new Date().toISOString() }; }
  }
  class LimitAdapter extends Adapter {
    constructor(id, provider) {
      super(id, provider);
      this.started = new Promise(resolve => { this.startedResolve = resolve; });
      this.blocked = new Promise(resolve => { this.releaseBlocked = resolve; });
    }
    async *send(session, input) {
      this.sends += 1;
      session.state = 'running';
      if (this.sends === 1) {
        session.state = 'idle';
        yield { type: 'terminal', inputId: input.inputId, status: 'error', error: 'maximum context length exceeded' };
        return;
      }
      this.startedResolve();
      await this.blocked;
      session.state = 'idle';
      yield { type: 'terminal', inputId: input.inputId, status: 'completed' };
    }
  }
  class CancelAdapter extends Adapter {
    async *send(session, input) {
      this.sends += 1;
      session.state = 'running';
      session.state = 'idle';
      yield { type: 'terminal', inputId: input.inputId, status: 'cancelled', result: { reason: 'provider-confirmed-cancel' } };
    }
  }
  class CandidateSource {
    constructor(candidate) { this.candidate = candidate; }
    async enumerateCandidates() { return [structuredClone(this.candidate)]; }
    async refreshCandidate(candidate) { return { ...structuredClone(candidate), observationId: candidate.observationId + ':fresh', observedAt: new Date().toISOString(), health: { status: 'healthy', checkedAt: new Date().toISOString() } }; }
    async materializeSessionOptions(_candidate, selection) { return { model: selection.model }; }
  }

  const projects = new lib.ProjectStore({ storageDirectory: path.join(tmp, 'projects'), newId: () => 'succession-project' });
  let taskSequence = 0;
  const tasks = new lib.TaskRuntime({ storageDirectory: path.join(tmp, 'tasks'), newId: () => 'succession-mission-' + (++taskSequence) });
  await Promise.all([projects.initialize(), tasks.initialize()]);
  const project = await projects.createProject({ title: 'Succession smoke' });
  const task = await tasks.ensureTask({ kind: 'mission', key: 'succession-root' }, 'Long-lived Practice Mission');
  const mission = await tasks.configureMission(task.taskId, { projectId: project.projectId, rootMissionId: task.taskId,
    plane: 'practice', missionType: 'long-practice', completionCriteria: ['continue across Worker replacement'] });
  const collaboration = new lib.MissionCollaborationStore({ storageDirectory: path.join(tmp, 'collaboration'), projects, tasks });
  await collaboration.initialize();
  const manager = new lib.WorkerSessionManager({ taskBindings: tasks, newId: (() => { let n = 0; return () => 'succession-managed-' + (++n); })() });
  const first = new Adapter('worker-a', 'provider-a');
  const second = new Adapter('worker-b', 'provider-b');
  await manager.register(first); await manager.register(second);
  const original = await manager.createSession(first.id, { model: 'm' }, mission.taskId);
  const candidate = { candidateId: 'candidate-b', workerId: second.id, provider: second.provider, kind: 'api', availability: 'available', models: ['m'],
    capabilities: { streaming: true, reasoning: true, capabilityRequests: true, imageInput: false, checkpoints: false, interruption: true, persistentContext: true },
    observationId: 'candidate-b:1', observedAt: new Date().toISOString(), health: { status: 'healthy', checkedAt: new Date().toISOString() } };
  const assignments = new lib.MissionWorkerAssignmentService(tasks, manager, [new CandidateSource(candidate)]);
  const succession = new lib.MissionWorkerSuccessionService(tasks, manager, assignments);
  const input = n => ({ inputId: 'turn-' + n, prompt: 'bounded prompt ' + n, mode: 'practice', allowedCapabilities: [], externalCapabilities: [] });
  for (const n of [1, 2]) for await (const _event of manager.send(original.managedSessionId, input(n))) { /* consume */ }
  const usage2 = manager.inspectConversationUsage(original.managedSessionId);
  assert.equal(usage2.sessionTurnCount, 2);
  assert(usage2.sessionObservedChars > 0);
  const budget = { approachingChars: 1000000, rotationChars: 2000000, approachingTurns: 2, rotationTurns: 3 };
  const approaching = await succession.reconcile({ projectId: project.projectId, rootMissionId: mission.taskId, missionId: mission.taskId, budget });
  assert.equal(approaching.state, 'handoff-prepared');
  assert(approaching.handoffArtifactId);
  const handoff = tasks.getTask(mission.taskId).artifacts.find(a => a.artifactId === approaching.handoffArtifactId);
  assert.equal(handoff.metadata.schema, 'nimora-worker-succession-handoff-v1');
  assert.match(handoff.metadata.text, /Nimora Task Handoff/);

  for await (const _event of manager.send(original.managedSessionId, input(3))) { /* consume */ }
  const preRotation = await succession.inspect({ projectId: project.projectId, rootMissionId: mission.taskId, missionId: mission.taskId }, budget);
  assert.equal(preRotation.capacity.state, 'rotation-required');
  assert.equal(preRotation.knownSettled, true);
  const rotated = await succession.reconcile({
    projectId: project.projectId, rootMissionId: mission.taskId, missionId: mission.taskId, budget,
    assignment: { projectId: project.projectId, rootMissionId: mission.taskId, missionId: mission.taskId,
      constraints: { allowedKinds: ['api'], allowedProviders: ['provider-b'] } },
    exactCandidateId: candidate.candidateId,
  });
  assert.equal(rotated.state, 'replaced');
  assert.notEqual(rotated.replacement.managedSessionId, original.managedSessionId);
  assert.equal(manager.getSession(original.managedSessionId), undefined);
  assert(manager.getRetiredSession(original.managedSessionId));
  const replacement = manager.getSession(rotated.replacement.managedSessionId);
  assert(replacement && replacement.taskId === mission.taskId);
  assert.equal(second.sends, 0, 'succession must never replay the old Work Order into the replacement');

  const context = new lib.MissionContextMaterializer(projects, tasks, collaboration, manager);
  const materialized = await context.materialize({ projectId: project.projectId, rootMissionId: mission.taskId,
    missionId: mission.taskId, managedSessionId: replacement.managedSessionId, budget: { maxChars: 50000 } });
  assert.match(materialized.text, /Same-Mission Worker succession Handoff/);
  assert.match(materialized.text, /successionHandoff/);
  assert.match(materialized.text, /sourceManagedSessionId/);
  assert.equal(rotated.providerCleanup, 'deferred-not-authoritative');

  // Provider-native cancellation is an explicit terminal settlement. It may
  // authorize a NEW turn, but never replay the cancelled input. Provider error
  // remains conservative and is covered by the context-limit guard below.
  const cancelTask = await tasks.ensureTask({ kind: 'mission', key: 'succession-cancelled-child' }, 'Cancelled terminal settlement guard');
  const cancelledMission = await tasks.configureMission(cancelTask.taskId, {
    projectId: project.projectId, rootMissionId: mission.taskId, parentMissionId: mission.taskId,
    plane: 'practice', missionType: 'cancelled-guard', completionCriteria: ['new turn only after explicit cancelled settlement'],
  });
  const cancelAdapter = new CancelAdapter('worker-cancel', 'provider-cancel');
  await manager.register(cancelAdapter);
  const cancelSession = await manager.createSession(cancelAdapter.id, { model: 'm' }, cancelledMission.taskId);
  for await (const event of manager.send(cancelSession.managedSessionId, {
    inputId: 'cancelled-turn', prompt: 'provider confirms cancellation', mode: 'practice', allowedCapabilities: [], externalCapabilities: [],
  })) {
    if (event.type === 'terminal') assert.equal(event.status, 'cancelled');
  }
  const cancelledInspection = await succession.inspect({ projectId: project.projectId, rootMissionId: mission.taskId, missionId: cancelledMission.taskId });
  assert.equal(cancelledInspection.knownSettled, true, 'explicit provider cancelled terminal releases the settlement fence');
  assert.equal(cancelAdapter.sends, 1, 'settlement inspection never replays the cancelled input');

  // Explicit provider context-limit evidence does NOT authorize replacement
  // while a later send is still live/UNKNOWN. Capacity urgency cannot bypass
  // the canonical settlement boundary.
  const childTask = await tasks.ensureTask({ kind: 'mission', key: 'succession-unknown-child' }, 'Context-limit UNKNOWN guard');
  const child = await tasks.configureMission(childTask.taskId, {
    projectId: project.projectId, rootMissionId: mission.taskId, parentMissionId: mission.taskId,
    plane: 'practice', missionType: 'limit-guard', completionCriteria: ['never replace unsettled work'],
  });
  const limitAdapter = new LimitAdapter('worker-limit', 'provider-limit');
  await manager.register(limitAdapter);
  const limitSession = await manager.createSession(limitAdapter.id, { model: 'm' }, child.taskId);
  for await (const _event of manager.send(limitSession.managedSessionId, {
    inputId: 'limit-error', prompt: 'hit provider limit', mode: 'practice', allowedCapabilities: [], externalCapabilities: [],
  })) { /* consume explicit limit terminal */ }
  const exhausted = await succession.inspect({ projectId: project.projectId, rootMissionId: mission.taskId, missionId: child.taskId });
  assert.equal(exhausted.capacity.state, 'exhausted');
  assert.equal(exhausted.knownSettled, false, 'error terminal is not silently upgraded into replacement authority');
  const refused = await succession.reconcile({
    projectId: project.projectId, rootMissionId: mission.taskId, missionId: child.taskId,
  });
  assert.equal(refused.capacity.state, 'exhausted');
  assert.equal(refused.knownSettled, false);
  assert.equal(refused.state, 'waiting-for-settlement');
  assert(manager.getSession(limitSession.managedSessionId), 'unsettled Worker must remain current');
  assert.equal(tasks.getTask(child.taskId).artifacts.some(a => a.metadata?.schema === 'nimora-worker-succession-handoff-v1'), false,
    'no succession Handoff/replacement mutation is admitted before settlement');

  console.log('PASS mission worker succession: same-Mission replacement/no replay, explicit provider cancellation settles, provider error/UNKNOWN remains blocked');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
