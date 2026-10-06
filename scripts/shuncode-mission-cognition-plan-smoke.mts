import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const esbuild = require('esbuild');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-planned-missions-'));
try {
  const outfile = path.join(dir, 'plan.cjs');
  await esbuild.build({
    stdin: { contents: [
      "export { ProjectStore } from './src/project-store.ts';",
      "export { TaskRuntime } from './src/task-runtime.ts';",
      "export { MissionCollaborationStore } from './src/mission-collaboration-store.ts';",
      "export { MissionFeedbackService } from './src/mission-feedback-service.ts';",
      "export { MissionCoordinatorService } from './src/mission-coordinator-service.ts';",
      "export { MissionParallelReadinessService, MissionParallelAssignmentService } from './src/mission-parallel-orchestration.ts';",
      "export { MissionWorkerAssignmentService } from './src/worker-assignment.ts';",
      "export { WorkerSessionManager } from './src/worker-session-manager.ts';",
      "export { normalizeCognitionMissionPlan, MissionCognitionPlanService } from './src/mission-cognition-plan.ts';",
    ].join('\n'), resolveDir: root, sourcefile: 'plan-smoke-entry.ts', loader: 'ts' },
    outfile, bundle: true, platform: 'node', format: 'cjs', target: 'es2022', logLevel: 'silent',
  });
  const {
    ProjectStore, TaskRuntime, MissionCollaborationStore, MissionFeedbackService, MissionCoordinatorService,
    MissionParallelReadinessService, MissionParallelAssignmentService, MissionWorkerAssignmentService,
    WorkerSessionManager, normalizeCognitionMissionPlan, MissionCognitionPlanService,
  } = require(outfile);
  let taskCounter = 0;
  const now = () => new Date('2026-10-04T00:00:00.000Z');
  const projects = new ProjectStore({ storageDirectory: path.join(dir, 'projects'), newId: () => 'planned-project', now });
  const tasks = new TaskRuntime({ storageDirectory: path.join(dir, 'tasks'), newId: () => `planned-task-${++taskCounter}`, now });
  await Promise.all([projects.initialize(), tasks.initialize()]);
  const project = await projects.createProject({ title: 'Planned work smoke' });
  const rootTask = await tasks.ensureTask({ kind: 'mission', key: 'smoke-root' }, 'Coordinate independently planned features');
  const rootMission = await tasks.configureMission(rootTask.taskId, {
    projectId: project.projectId, rootMissionId: rootTask.taskId, plane: 'cognition',
    missionType: 'long-lived-planner', completionCriteria: ['Review all Practice reports'],
  });
  const collaboration = new MissionCollaborationStore({ storageDirectory: path.join(dir, 'collaboration'), projects, tasks, now });
  await collaboration.initialize();
  const feedback = new MissionFeedbackService(projects, tasks, collaboration);
  const coordinator = new MissionCoordinatorService(projects, tasks, collaboration, feedback);
  await coordinator.ensureCoordinatorMission({ projectId: project.projectId, managedRootMissionId: rootMission.taskId });
  const workers = new WorkerSessionManager({ taskBindings: tasks, newId: () => 'no-real-worker' });
  const assignments = new MissionWorkerAssignmentService(tasks, workers, []);
  const readiness = new MissionParallelReadinessService(projects, tasks, collaboration, workers);
  const parallel = new MissionParallelAssignmentService(readiness, assignments);
  const planned = new MissionCognitionPlanService(coordinator, collaboration, readiness, parallel);
  const a = { key: 'player', goal: 'Build isolated player', plane: 'practice', missionType: 'implementation',
    completionCriteria: ['player tests pass'], dependsOn: [] };
  const b = { key: 'articles', goal: 'Build isolated articles', plane: 'practice', missionType: 'implementation',
    completionCriteria: ['article tests pass'], dependsOn: [] };
  const c = { key: 'integration', goal: 'Integrate reviewed features', plane: 'practice', missionType: 'verification',
    completionCriteria: ['integration tests pass'], dependsOn: ['player', 'articles'] };
  for (const invalid of [
    [a, { ...b, key: 'player' }],
    [{ ...a, dependsOn: ['unknown'] }],
    [{ ...a, dependsOn: ['articles'] }, { ...b, dependsOn: ['player'] }],
    [{ ...a, plane: 'coordination' }],
    [{ ...a, extraAuthority: true }],
  ]) assert.throws(() => normalizeCognitionMissionPlan(invalid), /Mission|dependency|field|work/i);
  const input = { projectId: project.projectId, rootMissionId: rootMission.taskId,
    planKey: 'human-reviewed-cognition-plan-1', additionalMissions: [a, b, c] };
  const first = await planned.establish(input);
  assert.equal(first.missions.length, 3);
  assert.equal(new Set(first.missions.map(m => m.missionId)).size, 3);
  assert.deepEqual(first.readiness.readyUnassignedMissionIds.slice().sort(), first.missions.slice(0, 2).map(m => m.missionId).sort());
  assert.equal(first.readiness.blockedMissionIds.length, 1, 'dependent Mission waits for completed prerequisites');
  assert.equal(collaboration.listRelations(project.projectId).filter(row => row.type === 'depends_on').length, 2);
  const repeated = await planned.establish(input);
  assert.deepEqual(repeated.missions, first.missions, 'same exact Cognition plan must not create duplicate Missions');
  assert.equal(tasks.listTasks().length, 5, 'one root + Coordinator + three planned Missions');
  assert.equal(collaboration.listRelations(project.projectId).filter(row => row.type === 'depends_on').length, 2);
  await assert.rejects(planned.establish({ ...input, additionalMissions: [{ ...a, goal: 'changed meaning' }] }), /collision/i);
  assert.equal(tasks.listTasks().length, 5, 'colliding plan identity cannot create replacement Missions');
  const assignment = await planned.assignReady({ projectId: project.projectId, rootMissionId: rootMission.taskId,
    requests: first.missions.map(m => ({ projectId: project.projectId, rootMissionId: rootMission.taskId, missionId: m.missionId })) });
  assert.equal(assignment.outcomes.filter(outcome => outcome.state === 'not-ready').length, 1);
  assert.equal(assignment.outcomes.filter(outcome => outcome.state === 'no-admissible-candidate').length, 2);
  assert.equal(workers.listSessions().length, 0, 'missing providers never turn into fabricated live Workers');
  await assert.rejects(planned.assignReady({ projectId: project.projectId, rootMissionId: rootMission.taskId,
    requests: first.missions.slice(0, 2).map(m => ({ projectId: project.projectId, rootMissionId: rootMission.taskId, missionId: m.missionId })),
    exactCandidateIds: Object.fromEntries(first.missions.slice(0, 2).map(m => [m.missionId, `webmcp:${'a'.repeat(64)}`])) }),
    /unique admissible page/, 'two Missions must never race to bind the same exact webpage');
  console.log('PASS Cognition planned Mission graph: strict bounded semantics, durable idempotent Coordinator creation, exact dependencies, ready parallel frontier and no-provider fail-closed.');
} finally { await fs.rm(dir, { recursive: true, force: true }); }
