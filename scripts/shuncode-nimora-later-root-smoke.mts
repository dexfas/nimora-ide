import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-later-ingress-'));
await require('esbuild').build({ stdin: { contents: `
export { NimoraLaterRootEntry } from './extensions/shuncode/src/nimora-later-root-entry.ts';
export { requireActiveProjectRoot } from './src/project-active-root.ts';
export { ProjectStore } from './src/project-store.ts';
export { buildProjectFormationReceipt } from './src/project-contract.ts';
export { ProjectFormationService } from './src/project-formation-service.ts';
export { ProjectRootOperationService } from './src/project-root-operation-service.ts';
export { TaskRuntime } from './src/task-runtime.ts';
export { MissionCoordinatorService } from './src/mission-coordinator-service.ts';
export { MissionCollaborationStore } from './src/mission-collaboration-store.ts';
`, resolveDir: root, loader: 'ts' }, outfile: path.join(temp, 'entry.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const { NimoraLaterRootEntry, requireActiveProjectRoot, ProjectStore, buildProjectFormationReceipt, ProjectFormationService,
  ProjectRootOperationService, TaskRuntime, MissionCoordinatorService, MissionCollaborationStore } = require(path.join(temp, 'entry.cjs'));
try {
  const projects = new ProjectStore({ storageDirectory: path.join(temp, 'projects') });
  const tasks = new TaskRuntime({ storageDirectory: path.join(temp, 'tasks') });
  const collaboration = new MissionCollaborationStore({ storageDirectory: path.join(temp, 'collaboration'), projects, tasks });
  const coordinator = new MissionCoordinatorService(projects, tasks, collaboration);
  const receipt = buildProjectFormationReceipt({ formationId: 'round-a', project: { goal: 'First', workspace: temp },
    initialRoot: { goal: 'First', plane: 'cognition', missionType: 'project-goal', completionCriteria: ['Verified'] },
    authorization: { kind: 'clear-intent-cognition' } });
  const first = await new ProjectFormationService(projects, tasks).ensureFormation(receipt);
  const coord = await coordinator.ensureCoordinatorMission({ projectId: first.project.projectId, managedRootMissionId: first.rootMission.taskId });
  for (const task of [first.rootMission, coord]) {
    await tasks.finalizeMissionStrict(task.taskId, { handoffRequired: false });
    await tasks.archiveMissionStrict(task.taskId);
  }
  const id = first.project.projectId;
  const service = new ProjectRootOperationService(projects, tasks, coordinator);
  let pending: any, interpretations = 0, failAfterRoot = true, stale = false;
  const read = async () => ({ projectId: id, workspace: temp, project: projects.getProject(id),
    missions: await Promise.all(tasks.listTasks().filter(t => t.mission?.projectId === id).map(t => tasks.rereadTask(t.taskId))) });
  const ports = { read, pending: () => pending,
    interpret: async () => { interpretations++; if (stale) await projects.recordProposal(id, { proposalId: 'changed', content: { kind: 'decision', summary: 'changed', rationale: 'new fact', scope: { kind: 'project' } } }); return JSON.stringify({ goal: 'Second', completionCriteria: ['Verified again'], constraints: [] }); },
    save: async (value: any) => { pending = structuredClone(value); },
    consumed: async () => { pending = undefined; },
    ensure: async (operation: any) => { const result = await service.ensureLaterRoot(operation); if (failAfterRoot) { failAfterRoot = false; throw new Error('uncertain owner response'); } return result; } };
  await assert.rejects(new NimoraLaterRootEntry(ports).start(id, 'Second'), /uncertain/);
  const savedIdentity = pending.operation.rootOperationId;
  await assert.rejects(new NimoraLaterRootEntry(ports).start(id, 'Another'), /原新增目标/);
  const second = await new NimoraLaterRootEntry(ports).start(id, 'Second');
  assert.equal(interpretations, 1, 'restart recovery cannot reinterpret or mint a second operation');
  assert.equal(pending, undefined);
  assert.equal(projects.listProjects().length, 1);
  assert.equal(tasks.listTasks().filter(t => t.mission?.rootMissionId === t.taskId).length, 2);
  assert.equal(requireActiveProjectRoot(tasks.listTasks(), id).taskId, second.rootMission.taskId);
  assert.equal(tasks.getTask(first.rootMission.taskId).missionFinalization.state, 'archived');
  assert.notEqual(second.rootMission.taskId, first.rootMission.taskId);
  assert.equal(second.rootMission.context.summary, '本轮用户目标：Second');
  assert.ok(savedIdentity);
  await assert.rejects(new NimoraLaterRootEntry(ports).start(id, 'Third'), /全部 Mission/);
  for (const task of [second.rootMission, second.coordinatorMission]) {
    await tasks.finalizeMissionStrict(task.taskId, { handoffRequired: false }); await tasks.archiveMissionStrict(task.taskId);
  }
  stale = true;
  await assert.rejects(new NimoraLaterRootEntry(ports).start(id, 'Third'), /真值变化/);
  assert.equal(pending, undefined);
  assert.equal(tasks.listTasks().filter(t => t.mission?.rootMissionId === t.taskId).length, 2);
  console.log('Later-root product ingress PASS: canonical owners, one Project/two roots, archived history, uncertain outcome recovery, no reinterpret/reallocation, stale governance refusal.');
} finally { assert.equal(path.dirname(temp), os.tmpdir()); assert.ok(path.basename(temp).startsWith('nimora-later-ingress-')); await fs.rm(temp, { recursive: true, force: true }); }
