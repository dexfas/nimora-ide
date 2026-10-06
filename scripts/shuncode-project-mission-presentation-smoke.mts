import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const baseDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-project-mission-presentation-'));
const projectDirectory = path.join(baseDirectory, 'projects');
const taskDirectory = path.join(baseDirectory, 'tasks');
const collaborationDirectory = path.join(baseDirectory, 'collaboration');
const statusOnlyTaskDirectory = path.join(baseDirectory, 'status-only-tasks');
const bundlePath = path.join(baseDirectory, 'project-mission-presentation-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { ProjectStore } from './src/project-store.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
      export { MissionCollaborationStore } from './src/mission-collaboration-store.ts';
      export { deriveProjectMissionPresentation, readProjectMissionPresentation } from './src/project-mission-presentation.ts';
      export { getMissionFinalHandoff } from './src/mission-finalization-service.ts';
      export { projectTaskCenterState } from './src/task-center-projection.ts';
      export { formatProjectMissionSessionMarkdown, presentProjectMissionSession, presentTaskSession } from './extensions/shuncode/src/task-center-session-presentation.ts';
    `,
    resolveDir: root,
    sourcefile: 'project-mission-presentation-entry.ts',
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
  deriveProjectMissionPresentation,
  readProjectMissionPresentation,
  getMissionFinalHandoff,
  projectTaskCenterState,
  formatProjectMissionSessionMarkdown,
  presentProjectMissionSession,
  presentTaskSession,
} = require(bundlePath);

let projectId = 0;
let taskId = 0;
let tick = 0;
const projectNewId = () => `presentation-project-id-${++projectId}`;
const taskNewId = () => `presentation-task-id-${++taskId}`;
const now = () => new Date(Date.UTC(2026, 8, 17, 9, 0, tick++));

async function createMission(tasks, projectIdValue, key, plane, missionType, rootMissionId, parentMissionId) {
  const task = await tasks.ensureTask({ kind: 'mission', key }, `${missionType} goal`);
  await tasks.configureMission(task.taskId, {
    projectId: projectIdValue,
    rootMissionId: rootMissionId ?? task.taskId,
    ...(parentMissionId ? { parentMissionId } : {}),
    plane,
    missionType,
    completionCriteria: [`${missionType} presentation is truthful`],
  });
  return tasks.getTask(task.taskId);
}

function semanticProjection(value) {
  return JSON.parse(JSON.stringify(value));
}

function renderNativeMission(tasks, projection, missionId) {
  const detail = projectTaskCenterState(tasks.listTasks(), missionId).selected;
  assert.ok(detail, `native Mission detail must exist: ${missionId}`);
  const mission = projection.missions.find(candidate => candidate.missionId === missionId);
  assert.ok(mission, `semantic Mission projection must exist: ${missionId}`);
  return {
    item: presentProjectMissionSession(detail.summary, projection, mission),
    markdown: formatProjectMissionSessionMarkdown(detail, projection, mission),
  };
}

async function appendTaskStatusEvent(storageDirectory, task, status, eventId, at) {
  await fs.appendFile(path.join(storageDirectory, `${task.taskId}.jsonl`), `${JSON.stringify({
    version: 1,
    eventId,
    taskId: task.taskId,
    at,
    type: 'TaskStatusChanged',
    payload: { status },
  })}\n`, 'utf8');
}

try {
  const projects = new ProjectStore({ storageDirectory: projectDirectory, newId: projectNewId, now });
  const tasks = new TaskRuntime({ storageDirectory: taskDirectory, newId: taskNewId, now });
  await Promise.all([projects.initialize(), tasks.initialize()]);

  const projectP = await projects.createProject({ title: 'Project P', goal: 'Build truthful Project/Mission UI', workspace: '/workspace/p' });
  const projectQ = await projects.createProject({ title: 'Project Q', goal: 'Stay isolated', workspace: '/workspace/q' });

  const committedProposal = await projects.recordProposal(projectP.projectId, {
    proposalId: 'proposal-committed',
    content: { kind: 'decision', summary: 'Committed P decision', scope: { kind: 'project' } },
  });
  await projects.confirmProposalHuman(projectP.projectId, { proposalId: committedProposal.proposalId, contentDigest: committedProposal.contentDigest });
  const committedDecision = await projects.commitProposal(projectP.projectId, { proposalId: committedProposal.proposalId });
  await projects.recordProposal(projectP.projectId, {
    proposalId: 'proposal-draft-only',
    content: { kind: 'decision', summary: 'Must never be projected as committed', scope: { kind: 'project' } },
  });
  const confirmedOnly = await projects.recordProposal(projectP.projectId, {
    proposalId: 'proposal-confirmed-only',
    content: { kind: 'change', summary: 'Human confirmed but not committed', scope: { kind: 'project' } },
  });
  await projects.confirmProposalHuman(projectP.projectId, { proposalId: confirmedOnly.proposalId, contentDigest: confirmedOnly.contentDigest });

  const rootP = await createMission(tasks, projectP.projectId, 'p-root', 'coordination', 'root-coordination');
  const cognitionP = await createMission(tasks, projectP.projectId, 'p-cognition', 'cognition', 'phase9-cognition', rootP.taskId, rootP.taskId);
  const practiceP = await createMission(tasks, projectP.projectId, 'p-practice', 'practice', 'phase9-practice', rootP.taskId, rootP.taskId);
  const rootQ = await createMission(tasks, projectQ.projectId, 'q-root', 'practice', 'q-practice-root');
  const missingProjectMission = await createMission(tasks, 'missing-project', 'missing-project-root', 'cognition', 'orphan-diagnostic');
  const legacyTask = await tasks.ensureTask({ kind: 'bridge', key: 'legacy-task' }, 'Legacy non-Mission Task');

  await tasks.setTodosStrict(practiceP.taskId, [
    { id: 'inspect', title: 'Inspect accepted semantic projection', status: 'completed' },
    { id: 'present', title: 'Present native Mission truth', status: 'in_progress' },
    { id: 'verify', title: 'Verify replay and accessibility', status: 'pending' },
  ]);
  await tasks.reportProgressStrict(practiceP.taskId, { message: 'Canonical native presentation in progress', phase: 'Phase 9 UI', percent: 67, todoId: 'present' });
  await tasks.updateContext(practiceP.taskId, { decisions: ['Worker prose that looks like a Project Decision'] });
  await tasks.attachWorkerSession(practiceP.taskId, {
    managedSessionId: 'worker-old', workerId: 'worker.practice', adapterSessionId: 'provider-old', model: 'model-old',
  });
  await tasks.detachWorkerSession(practiceP.taskId, 'worker-old');
  await tasks.retireWorkerSessionStrict(practiceP.taskId, 'worker-old', { reason: 'replacement' });
  await tasks.attachWorkerSession(practiceP.taskId, {
    managedSessionId: 'worker-new', workerId: 'worker.practice', adapterSessionId: 'provider-new', model: 'model-new',
  });
  // Phase 11 correctly forbids finalizing a Mission with unresolved work.
  // Keep the canonical UNKNOWN on the still-open Cognition Mission instead;
  // a later adversarial presentation clone checks archived+UNKNOWN legacy data.
  await tasks.claimExecution(cognitionP.taskId, { executionId: 'execution-unknown', toolName: 'read_files' });
  await tasks.finishExecutionStrict(cognitionP.taskId, 'execution-unknown', 'unknown', { resultSummary: 'Outcome indeterminate' });
  const arbitraryArtifact = await tasks.recordArtifact(practiceP.taskId, {
    artifactId: 'ordinary-report', kind: 'report', title: 'Ordinary report', metadata: { content: 'Not a final Handoff.' },
  });

  const collaboration = new MissionCollaborationStore({ storageDirectory: collaborationDirectory, projects, tasks, now });
  await collaboration.initialize();
  const evidenceP = await collaboration.recordExchange({
    exchangeId: 'evidence-p', projectId: projectP.projectId, sourceMissionId: practiceP.taskId, kind: 'Evidence',
    payload: { summary: 'PROBLEM EVIDENCE A', references: [{ type: 'file', path: 'src/project-mission-presentation.ts' }] },
  });
  const answerEvidenceP = await collaboration.recordExchange({
    exchangeId: 'answer-evidence-p', projectId: projectP.projectId, sourceMissionId: cognitionP.taskId, kind: 'Evidence',
    payload: { summary: 'ANSWER EVIDENCE B', references: [{ type: 'file', path: 'extensions/shuncode/src/task-center-session-presentation.ts' }] },
  });
  const unrelatedEvidenceP = await collaboration.recordExchange({
    exchangeId: 'unrelated-evidence-p', projectId: projectP.projectId, sourceMissionId: cognitionP.taskId, kind: 'Evidence',
    payload: { summary: 'UNRELATED SAME PROJECT EVIDENCE C', references: [{ type: 'file', path: 'src/mission-collaboration-store.ts' }] },
  });
  const answeredProblem = await collaboration.recordExchange({
    exchangeId: 'problem-answered', projectId: projectP.projectId, sourceMissionId: practiceP.taskId, targetMissionId: cognitionP.taskId, kind: 'Problem',
    payload: { currentGoal: 'Project P', previousAssumption: 'Need answer', observedReality: 'A precise question exists', preciseQuestion: 'What is the answer?', blocking: true, evidenceExchangeIds: [evidenceP.exchangeId] },
  });
  const openProblem = await collaboration.recordExchange({
    exchangeId: 'problem-open', projectId: projectP.projectId, sourceMissionId: practiceP.taskId, targetMissionId: cognitionP.taskId, kind: 'Problem',
    payload: { currentGoal: 'Project P', previousAssumption: 'Maybe answered by proximity', observedReality: 'No exact reply exists', preciseQuestion: 'Must this stay open?', blocking: false, evidenceExchangeIds: [evidenceP.exchangeId] },
  });
  await collaboration.recordExchange({
    exchangeId: 'answer-exact', projectId: projectP.projectId, sourceMissionId: cognitionP.taskId, targetMissionId: practiceP.taskId, kind: 'Answer',
    replyToExchangeId: answeredProblem.exchangeId,
    payload: { answer: 'ANSWER TEXT MARKER', evidenceExchangeIds: [answerEvidenceP.exchangeId], limitations: 'ANSWER LIMITATIONS MARKER' },
  });
  await collaboration.recordRelation({
    relationId: 'relation-p-depends', projectId: projectP.projectId, sourceMissionId: practiceP.taskId, targetMissionId: cognitionP.taskId, type: 'depends_on',
  });
  const evidenceQ = await collaboration.recordExchange({
    exchangeId: 'evidence-q', projectId: projectQ.projectId, sourceMissionId: rootQ.taskId, kind: 'Evidence',
    payload: { summary: 'Q-only evidence', references: [{ type: 'file', path: 'src/task-runtime.ts' }] },
  });

  const finalizedPractice = await tasks.finalizeMissionStrict(practiceP.taskId, {
    handoffRequired: true,
    handoff: { artifactId: 'final-handoff-p', kind: 'report', title: 'Final Mission Handoff', metadata: { content: 'Verified final handoff content.' } },
  });
  const finalHandoff = getMissionFinalHandoff(finalizedPractice);
  assert.ok(finalHandoff, 'TaskRuntime must produce a validator-compatible final Handoff');
  await collaboration.recordExchange({
    exchangeId: 'handoff-exchange-p', projectId: projectP.projectId, sourceMissionId: practiceP.taskId, targetMissionId: rootP.taskId, kind: 'Handoff',
    payload: {
      artifactId: finalHandoff.artifactId,
      sourceTaskEventId: finalizedPractice.missionFinalization.handoffSourceEventId,
      sourceTaskEventCount: finalizedPractice.missionFinalization.handoffSourceEventCount,
      contentDigest: finalizedPractice.missionFinalization.handoffContentDigest,
    },
  });
  await tasks.retireWorkerSessionStrict(practiceP.taskId, 'worker-new', { reason: 'mission-complete' });
  await tasks.archiveMissionStrict(practiceP.taskId);
  await Promise.all([projects.flush(), tasks.flush(), collaboration.flush()]);

  const owners = { projects, tasks, collaboration };
  const projection = await readProjectMissionPresentation(owners);
  assert.deepEqual(projection.availability, { projects: { status: 'available' }, tasks: { status: 'available' }, collaboration: { status: 'available' } });
  assert.deepEqual(projection.legacyTaskIds, [legacyTask.taskId], 'non-Mission Tasks must remain legacy facts');
  assert.equal(projection.missions.length, 5, 'each Task-owned Mission must project exactly once');
  assert.equal(new Set(projection.missions.map(mission => mission.missionId)).size, projection.missions.length, 'Worker replacement must not duplicate Mission identity');
  assert.equal(projection.missions.find(mission => mission.missionId === rootP.taskId).semanticRole, '总协调');
  assert.equal(projection.missions.find(mission => mission.missionId === cognitionP.taskId).semanticRole, '文');
  assert.equal(projection.missions.find(mission => mission.missionId === practiceP.taskId).semanticRole, '理');

  const projectedP = projection.projects.find(project => project.projectId === projectP.projectId);
  assert.ok(projectedP);
  assert.deepEqual(new Set(projectedP.missionIds), new Set([rootP.taskId, cognitionP.taskId, practiceP.taskId]), 'Project membership must come from Task mission.projectId only');
  assert.deepEqual(
    new Set(projectedP.hierarchyRelations.map(relation => `${relation.sourceMissionId}->${relation.targetMissionId}`)),
    new Set([`${rootP.taskId}->${cognitionP.taskId}`, `${rootP.taskId}->${practiceP.taskId}`]),
    'parent_of hierarchy must be derived from TaskRuntime parentMissionId rather than collaboration ownership',
  );
  assert.deepEqual(projectedP.committedDecisions.map(decision => decision.decisionId), [committedDecision.decisionId], 'only committed Project Decisions are authoritative');
  assert.deepEqual(
    projectedP.pendingProposals?.map(proposal => [proposal.proposalId, proposal.state]),
    [
      ['proposal-draft-only', 'awaiting-human'],
      ['proposal-confirmed-only', 'confirmed-awaiting-commit'],
    ],
    'pending governance must remain visibly distinct from committed Project truth',
  );
  assert.equal(JSON.stringify(projectedP.committedDecisions).includes('draft-only'), false);
  assert.equal(JSON.stringify(projectedP.committedDecisions).includes('confirmed-only'), false);
  assert.equal(JSON.stringify(projectedP.committedDecisions).includes('Worker prose'), false, 'Task context.decisions must not become Project truth');
  assert.equal(projectedP.problems.find(problem => problem.exchangeId === answeredProblem.exchangeId).answerState, 'Answered');
  assert.equal(projectedP.problems.find(problem => problem.exchangeId === openProblem.exchangeId).answerState, 'Open', 'Answer to another Problem must not resolve this Problem');
  assert.equal(projectedP.problems.find(problem => problem.exchangeId === answeredProblem.exchangeId).blocking, true, 'blocking remains a separate immutable fact');
  const projectedAnsweredProblem = projectedP.problems.find(problem => problem.exchangeId === answeredProblem.exchangeId);
  assert.deepEqual(projectedAnsweredProblem.evidence.map(evidence => evidence.exchangeId), [evidenceP.exchangeId], 'Problem must own only its exact Evidence A');
  assert.deepEqual(projectedAnsweredProblem.answerExchangeIds, ['answer-exact']);
  assert.equal(projectedAnsweredProblem.answers.length, 1);
  assert.equal(projectedAnsweredProblem.answers[0].exchangeId, 'answer-exact');
  assert.equal(projectedAnsweredProblem.answers[0].answer, 'ANSWER TEXT MARKER');
  assert.equal(projectedAnsweredProblem.answers[0].limitations, 'ANSWER LIMITATIONS MARKER');
  assert.deepEqual(projectedAnsweredProblem.answers[0].evidence.map(evidence => evidence.exchangeId), [answerEvidenceP.exchangeId], 'Answer must own only its exact Evidence B');
  assert.deepEqual(projectedAnsweredProblem.answers[0].missingEvidenceExchangeIds, []);
  assert.equal(projectedAnsweredProblem.answers[0].evidence.some(evidence => evidence.exchangeId === unrelatedEvidenceP.exchangeId), false, 'unrelated same-Project Evidence C must not attach by proximity');

  const realTaskDetail = projectTaskCenterState(tasks.listTasks(), practiceP.taskId).selected;
  assert.ok(realTaskDetail, 'real TaskRuntime Mission must remain renderable through native detail projection');
  const realMissionMarkdown = formatProjectMissionSessionMarkdown(
    realTaskDetail,
    projection,
    projection.missions.find(mission => mission.missionId === practiceP.taskId),
  );
  assert.match(realMissionMarkdown, /Problem Evidence evidence-p: PROBLEM EVIDENCE A/, 'real-owner Problem Evidence A must render under the Problem');
  assert.match(realMissionMarkdown, /Answer answer-exact: ANSWER TEXT MARKER/, 'real-owner accepted Answer id/text must render');
  assert.match(realMissionMarkdown, /Limitations: ANSWER LIMITATIONS MARKER/, 'real-owner Answer limitations must render');
  assert.match(realMissionMarkdown, /Answer Evidence answer-evidence-p: ANSWER EVIDENCE B/, 'real-owner Answer Evidence B must render under the Answer');
  assert.doesNotMatch(realMissionMarkdown, /UNRELATED SAME PROJECT EVIDENCE C/, 'unrelated same-Project Evidence C must not render as Problem or Answer provenance');
  assert.match(realMissionMarkdown, /\*\*Role:\*\* 理/);
  assert.match(realMissionMarkdown, /\*\*Task work status:\*\*/);
  assert.match(realMissionMarkdown, /\*\*Mission finalized:\*\* yes/);
  assert.match(realMissionMarkdown, /\*\*Mission lifecycle:\*\* archived/);
  assert.match(realMissionMarkdown, /\*\*Answered\*\* · Blocking: yes/);
  assert.match(realMissionMarkdown, /\*\*Open\*\* · Blocking: no/);
  assert.match(realMissionMarkdown, /\*\*Validated final Mission Handoff:\*\* Final Mission Handoff/);
  assert.match(realMissionMarkdown, /### Progress/);
  assert.match(realMissionMarkdown, /### Todos/);

  const initialRootNative = renderNativeMission(tasks, projection, rootP.taskId);
  const initialCognitionNative = renderNativeMission(tasks, projection, cognitionP.taskId);
  const initialPracticeNative = renderNativeMission(tasks, projection, practiceP.taskId);
  assert.match(initialCognitionNative.markdown, /execution unknown/, 'execution UNKNOWN must be textual rather than icon/color-only');
  assert.match(initialRootNative.item.label, /^总协调 · /, 'root Coordination Mission must have textual 总协调 identity');
  assert.match(initialCognitionNative.item.label, /^文 · /, 'Cognition Mission must have textual 文 identity');
  assert.match(initialPracticeNative.item.label, /^理 · /, 'Practice Mission must have textual 理 identity');
  for (const item of [initialRootNative.item, initialCognitionNative.item, initialPracticeNative.item]) {
    assert.equal(item.label.includes('\n'), false, 'native Mission item labels must stay single-line');
    assert.ok(item.label.length <= 120, 'native Mission item labels must stay bounded');
    assert.match(item.description, /Project · /, 'Project semantics must be textual on the flat native item');
  }
  assert.equal(initialPracticeNative.item.terminal, true, 'explicit archived Mission must stay terminal despite historical Worker diagnostics');
  assert.match(initialPracticeNative.item.badge, /Mission archived/);
  const legacyDetail = projectTaskCenterState(tasks.listTasks(), legacyTask.taskId).selected;
  assert.ok(legacyDetail);
  const legacyNative = presentTaskSession(legacyDetail.summary);
  assert.equal(legacyNative.taskId, legacyTask.taskId, 'legacy non-Mission Task must still use Task-only native presentation');

  // WO#3 canonical refresh: mutate each canonical owner after an initial render,
  // then perform the same fresh reconstruction used by manual/native refresh.
  const refreshProposal = await projects.recordProposal(projectP.projectId, {
    proposalId: 'proposal-refresh-visible',
    content: { kind: 'change', summary: 'REFRESH DECISION MARKER', scope: { kind: 'project' } },
  });
  await projects.confirmProposalHuman(projectP.projectId, { proposalId: refreshProposal.proposalId, contentDigest: refreshProposal.contentDigest });
  const refreshDecision = await projects.commitProposal(projectP.projectId, { proposalId: refreshProposal.proposalId });
  const refreshEvidence = await collaboration.recordExchange({
    exchangeId: 'refresh-evidence', projectId: projectP.projectId, sourceMissionId: cognitionP.taskId, kind: 'Evidence',
    payload: { summary: 'REFRESH COLLABORATION EVIDENCE', references: [{ type: 'file', path: 'src/project-mission-presentation.ts' }] },
  });
  await collaboration.recordExchange({
    exchangeId: 'refresh-problem', projectId: projectP.projectId, sourceMissionId: cognitionP.taskId, targetMissionId: rootP.taskId, kind: 'Problem',
    payload: { currentGoal: 'Fresh refresh', previousAssumption: 'Old render is current', observedReality: 'Canonical owners changed', preciseQuestion: 'Can manual refresh see this?', blocking: true, evidenceExchangeIds: [refreshEvidence.exchangeId] },
  });
  await collaboration.recordRelation({
    relationId: 'refresh-informs', projectId: projectP.projectId, sourceMissionId: cognitionP.taskId, targetMissionId: rootP.taskId, type: 'informs',
  });
  await tasks.setTodosStrict(cognitionP.taskId, [
    { id: 'refresh', title: 'REFRESH TODO MARKER', status: 'in_progress' },
  ]);
  await tasks.reportProgressStrict(cognitionP.taskId, { message: 'REFRESH PROGRESS MARKER', phase: 'manual refresh', percent: 73, todoId: 'refresh' });
  await Promise.all([projects.flush(), tasks.flush(), collaboration.flush()]);

  const refreshedProjection = await readProjectMissionPresentation(owners);
  const refreshedCognitionNative = renderNativeMission(tasks, refreshedProjection, cognitionP.taskId);
  assert.equal(projection.projects.find(project => project.projectId === projectP.projectId).committedDecisions.some(decision => decision.decisionId === refreshDecision.decisionId), false, 'stale pre-mutation projection must remain stale rather than mutating behind the caller');
  assert.doesNotMatch(initialCognitionNative.markdown, /REFRESH DECISION MARKER|REFRESH COLLABORATION EVIDENCE|REFRESH PROGRESS MARKER|REFRESH TODO MARKER/);
  assert.match(refreshedCognitionNative.markdown, /REFRESH DECISION MARKER/, 'fresh reconstruction must reread ProjectStore');
  assert.match(refreshedCognitionNative.markdown, /refresh-informs/, 'fresh reconstruction must reread explicit collaboration relations');
  assert.match(refreshedCognitionNative.markdown, /REFRESH COLLABORATION EVIDENCE/, 'fresh reconstruction must reread accepted collaboration facts');
  assert.match(refreshedCognitionNative.markdown, /REFRESH PROGRESS MARKER/, 'fresh reconstruction must reread Task progress');
  assert.match(refreshedCognitionNative.markdown, /REFRESH TODO MARKER/, 'fresh reconstruction must reread Task todos');

  // Owner-valid bounded-content pressure. Keep the data canonical, then prove
  // per-section omission remains inspectable while critical Mission truth survives.
  const stressMissions = [];
  for (let index = 0; index < 24; index += 1) {
    stressMissions.push(await createMission(tasks, projectP.projectId, `stress-mission-${index}`, index % 2 ? 'practice' : 'cognition', `stress-type-${index}`, rootP.taskId, rootP.taskId));
  }
  for (let index = 0; index < 22; index += 1) {
    const proposal = await projects.recordProposal(projectP.projectId, {
      proposalId: `stress-proposal-${index}`,
      content: { kind: 'decision', summary: `Stress committed Decision ${index} ${'D'.repeat(180)}`, scope: { kind: 'project' } },
    });
    await projects.confirmProposalHuman(projectP.projectId, { proposalId: proposal.proposalId, contentDigest: proposal.contentDigest });
    await projects.commitProposal(projectP.projectId, { proposalId: proposal.proposalId });
  }
  for (let index = 0; index < stressMissions.length; index += 1) {
    await collaboration.recordRelation({
      relationId: `stress-relation-${index}`, projectId: projectP.projectId, sourceMissionId: stressMissions[index].taskId, targetMissionId: cognitionP.taskId, type: 'informs',
    });
  }
  for (let index = 0; index < 24; index += 1) {
    const evidence = await collaboration.recordExchange({
      exchangeId: `stress-problem-evidence-${index}`, projectId: projectP.projectId, sourceMissionId: cognitionP.taskId, kind: 'Evidence',
      payload: { summary: `Stress Problem Evidence ${index} ${'E'.repeat(140)}`, references: [{ type: 'file', path: 'src/project-mission-presentation.ts' }] },
    });
    const problem = await collaboration.recordExchange({
      exchangeId: `stress-problem-${index}`, projectId: projectP.projectId, sourceMissionId: cognitionP.taskId, targetMissionId: rootP.taskId, kind: 'Problem',
      payload: { currentGoal: `Stress goal ${index}`, previousAssumption: 'bounded', observedReality: `Stress observed ${index}`, preciseQuestion: `Stress question ${index}?`, blocking: index % 3 === 0, evidenceExchangeIds: [evidence.exchangeId] },
    });
    if (index % 2 === 0) {
      const answerEvidence = await collaboration.recordExchange({
        exchangeId: `stress-answer-evidence-${index}`, projectId: projectP.projectId, sourceMissionId: rootP.taskId, kind: 'Evidence',
        payload: { summary: `Stress Answer Evidence ${index} ${'A'.repeat(140)}`, references: [{ type: 'file', path: 'extensions/shuncode/src/task-center-session-presentation.ts' }] },
      });
      await collaboration.recordExchange({
        exchangeId: `stress-answer-${index}`, projectId: projectP.projectId, sourceMissionId: rootP.taskId, targetMissionId: cognitionP.taskId, kind: 'Answer', replyToExchangeId: problem.exchangeId,
        payload: { answer: `Stress answer ${index} ${'R'.repeat(180)}`, evidenceExchangeIds: [answerEvidence.exchangeId], limitations: `Stress limitation ${index}` },
      });
    }
  }
  await tasks.setTodosStrict(cognitionP.taskId, Array.from({ length: 40 }, (_, index) => ({ id: `stress-todo-${index}`, title: `Stress todo ${index} ${'T'.repeat(120)}`, status: index % 3 === 0 ? 'completed' : index % 3 === 1 ? 'in_progress' : 'pending' })));
  await tasks.reportProgressStrict(cognitionP.taskId, { message: 'Stress presentation remains truthful', phase: 'bounded content', percent: 88, todoId: 'stress-todo-1' });
  for (let index = 0; index < 32; index += 1) {
    await tasks.claimExecution(cognitionP.taskId, { executionId: `stress-execution-${index}`, toolName: `stress_tool_${index}` });
    await tasks.finishExecutionStrict(cognitionP.taskId, `stress-execution-${index}`, index === 0 ? 'unknown' : 'succeeded', { resultSummary: `Stress execution result ${index} ${'X'.repeat(100)}` });
    await tasks.recordArtifact(cognitionP.taskId, { artifactId: `stress-artifact-${index}`, kind: 'report', title: `Stress artifact ${index} ${'Z'.repeat(100)}` });
  }
  await Promise.all([projects.flush(), tasks.flush(), collaboration.flush()]);
  const stressProjection = await readProjectMissionPresentation(owners);
  const stressPracticeNative = renderNativeMission(tasks, stressProjection, practiceP.taskId);
  const stressCognitionNative = renderNativeMission(tasks, stressProjection, cognitionP.taskId);
  assert.ok(stressPracticeNative.markdown.length < 32_000, 'section-aware Mission detail must remain globally bounded by fixed section budgets');
  assert.ok(stressCognitionNative.markdown.length < 32_000, 'stress detail must remain bounded under owner-valid content pressure');
  assert.match(stressCognitionNative.markdown, /omitted by bounded native presentation/, 'intentional omissions must be inspectable');
  assert.match(stressPracticeNative.markdown, /\*\*Mission lifecycle:\*\* archived/, 'bounded content must not lose selected Mission archive truth');
  assert.match(stressPracticeNative.markdown, /\*\*Validated final Mission Handoff:\*\* Final Mission Handoff/, 'bounded content must not lose validator-owned final Handoff');
  assert.match(stressCognitionNative.markdown, /\*\*UNKNOWN executions:\*\* 2/, 'bounded content must not normalize execution UNKNOWN away');
  assert.match(stressCognitionNative.markdown, /execution unknown/, 'specific UNKNOWN execution must remain inspectable');
  assert.match(stressCognitionNative.markdown, /\*\*Task work status:\*\*/);
  assert.match(stressCognitionNative.markdown, /\*\*Mission finalized:\*\* no/);
  assert.match(stressCognitionNative.markdown, /\*\*Problem summary:\*\*/);

  const projectedPractice = projection.missions.find(mission => mission.missionId === practiceP.taskId);
  assert.equal(projectedPractice.presentationState, 'archived', 'archived lifecycle must stay terminal');
  assert.equal(projectedPractice.finalized, true, 'explicit Mission finalization must be projected separately from Task work status');
  assert.equal(projectedPractice.terminal, true);
  const projectedCognition = projection.missions.find(mission => mission.missionId === cognitionP.taskId);
  assert.equal(projectedCognition.executions.find(execution => execution.executionId === 'execution-unknown').status, 'unknown', 'UNKNOWN execution must stay UNKNOWN');
  assert.equal(projectedPractice.finalHandoff.artifactId, 'final-handoff-p');
  assert.notEqual(projectedPractice.finalHandoff.artifactId, arbitraryArtifact.artifactId, 'ordinary artifact must not masquerade as final Handoff');
  assert.equal(projectedPractice.workers.length, 2, 'replacement Worker history is secondary diagnostics under one Mission');

  const orphanProject = projection.projects.find(project => project.projectId === 'missing-project');
  assert.equal(orphanProject.metadataState, 'missing', 'missing Project metadata must be explicit rather than fabricated');
  assert.equal(orphanProject.title, undefined);
  assert.equal(orphanProject.decisionsState, 'missing-project');
  assert.ok(projection.integrityIssues.some(issue => issue.code === 'missing-project' && issue.missionId === missingProjectMission.taskId));

  // Pure adversarial derivation can receive forged presentation inputs that canonical owners would reject.
  // These facts must fail closed without mutating or repairing canonical Mission metadata.
  const canonicalTasks = tasks.listTasks();
  const practiceSnapshot = canonicalTasks.find(task => task.taskId === practiceP.taskId);
  const cognitionSnapshot = canonicalTasks.find(task => task.taskId === cognitionP.taskId);
  const rootPSnapshot = canonicalTasks.find(task => task.taskId === rootP.taskId);
  const qSnapshot = canonicalTasks.find(task => task.taskId === rootQ.taskId);
  const cyclicA = structuredClone(rootPSnapshot);
  cyclicA.taskId = 'forged-cycle-a';
  cyclicA.mission = { ...cyclicA.mission, rootMissionId: rootP.taskId, parentMissionId: 'forged-cycle-b', plane: 'practice', missionType: 'forged-cycle-a' };
  const cyclicB = structuredClone(rootPSnapshot);
  cyclicB.taskId = 'forged-cycle-b';
  cyclicB.mission = { ...cyclicB.mission, rootMissionId: rootP.taskId, parentMissionId: 'forged-cycle-a', plane: 'cognition', missionType: 'forged-cycle-b' };
  const selfParent = structuredClone(rootPSnapshot);
  selfParent.taskId = 'forged-self-parent';
  selfParent.mission = { ...selfParent.mission, rootMissionId: rootP.taskId, parentMissionId: 'forged-self-parent', plane: 'practice', missionType: 'forged-self-parent' };
  const missingParent = structuredClone(rootPSnapshot);
  missingParent.taskId = 'forged-missing-parent';
  missingParent.mission = { ...missingParent.mission, rootMissionId: rootP.taskId, parentMissionId: 'does-not-exist', plane: 'practice', missionType: 'forged-missing-parent' };
  const unknownDelivery = structuredClone(practiceSnapshot);
  // Synthetic legacy/adversarial input, not a state admitted by current
  // TaskRuntime finalization: archived Mission with unresolved execution.
  unknownDelivery.executions['execution-unknown'] = {
    ...structuredClone(cognitionSnapshot.executions['execution-unknown']),
    deliveryStatus: 'unknown',
  };
  unknownDelivery.workerSessions['worker-new'].retiredAt = undefined;

  const forgedProblem = {
    exchangeId: 'forged-problem-wrong-evidence', projectId: projectP.projectId, sourceMissionId: practiceP.taskId, targetMissionId: cognitionP.taskId, kind: 'Problem', createdAt: '2026-09-17T10:00:00.000Z',
    payload: { currentGoal: 'P', previousAssumption: 'Answer evidence can be inferred', observedReality: 'It cannot', preciseQuestion: 'Attach?', blocking: false, evidenceExchangeIds: [evidenceP.exchangeId] },
  };
  const forgedAnswer = {
    exchangeId: 'forged-answer-missing-cross-project-evidence', projectId: projectP.projectId, sourceMissionId: cognitionP.taskId, targetMissionId: practiceP.taskId, kind: 'Answer', replyToExchangeId: forgedProblem.exchangeId, createdAt: '2026-09-17T10:00:00.500Z',
    payload: { answer: 'Forged answer with unavailable evidence', evidenceExchangeIds: [evidenceQ.exchangeId, 'missing-answer-evidence'], limitations: 'Adversarial limitation' },
  };
  const crossProjectExchange = {
    exchangeId: 'forged-cross-project', projectId: projectP.projectId, sourceMissionId: practiceP.taskId, targetMissionId: rootQ.taskId, kind: 'Finding', createdAt: '2026-09-17T10:00:01.000Z',
    payload: { summary: 'Must be rejected', evidenceExchangeIds: [] },
  };
  const crossProjectRelation = {
    relationId: 'forged-cross-project-relation', projectId: projectP.projectId, sourceMissionId: practiceP.taskId, targetMissionId: rootQ.taskId, type: 'depends_on', createdAt: '2026-09-17T10:00:02.000Z',
  };
  const contradictoryParent = {
    relationId: 'parent_of:forged-contradiction', projectId: projectP.projectId, sourceMissionId: cognitionP.taskId, targetMissionId: practiceP.taskId, type: 'parent_of', createdAt: '2026-09-17T10:00:03.000Z', derived: true,
  };
  const forgedOrdinaryHandoff = {
    exchangeId: 'forged-ordinary-handoff', projectId: projectP.projectId, sourceMissionId: practiceP.taskId, targetMissionId: rootP.taskId, kind: 'Handoff', createdAt: '2026-09-17T10:00:04.000Z',
    payload: { artifactId: arbitraryArtifact.artifactId, sourceTaskEventId: 'not-final', sourceTaskEventCount: 1, contentDigest: 'sha256:not-final' },
  };
  const adversarial = deriveProjectMissionPresentation({
    availability: projection.availability,
    projects: projects.listProjects(),
    tasks: canonicalTasks.filter(task => task.taskId !== practiceP.taskId).concat([unknownDelivery, cyclicA, cyclicB, selfParent, missingParent]),
    committedDecisionsByProject: new Map(projects.listProjects().map(project => [project.projectId, projects.listDecisions(project.projectId)])),
    relations: collaboration.listRelations(projectP.projectId).concat(collaboration.listRelations(projectQ.projectId), [crossProjectRelation, contradictoryParent]),
    exchanges: collaboration.listExchanges(projectP.projectId).concat(collaboration.listExchanges(projectQ.projectId), [forgedProblem, forgedAnswer, crossProjectExchange, forgedOrdinaryHandoff]),
  });
  const adversarialP = adversarial.projects.find(project => project.projectId === projectP.projectId);
  const forgedProjectedProblem = adversarialP.problems.find(problem => problem.exchangeId === forgedProblem.exchangeId);
  assert.deepEqual(forgedProjectedProblem.evidence.map(evidence => evidence.exchangeId), [evidenceP.exchangeId], 'Problem Evidence remains independent from Answer Evidence');
  assert.deepEqual(forgedProjectedProblem.missingEvidenceExchangeIds, []);
  assert.equal(forgedProjectedProblem.answerState, 'Answered', 'exact replyToExchangeId still exclusively owns Answered state');
  assert.equal(forgedProjectedProblem.answers.length, 1);
  assert.equal(forgedProjectedProblem.answers[0].limitations, 'Adversarial limitation');
  assert.deepEqual(forgedProjectedProblem.answers[0].evidence, [], 'cross-Project Evidence must not leak into Answer presentation');
  assert.deepEqual(forgedProjectedProblem.answers[0].missingEvidenceExchangeIds, [evidenceQ.exchangeId, 'missing-answer-evidence'], 'missing/unaccepted Answer Evidence must remain explicit');
  assert.equal(forgedProjectedProblem.answers[0].evidence.some(evidence => evidence.exchangeId === evidenceP.exchangeId), false, 'Problem Evidence must not automatically become Answer Evidence');
  assert.equal(adversarialP.exchanges.some(exchange => exchange.exchangeId === crossProjectExchange.exchangeId), false, 'cross-Project exchange must not leak');
  assert.equal(adversarialP.relations.some(relation => relation.relationId === crossProjectRelation.relationId), false, 'cross-Project relation must not leak');
  assert.equal(adversarial.missions.find(mission => mission.missionId === practiceP.taskId).parentMissionId, rootP.taskId, 'contradictory parent relation must not replace Task metadata');
  assert.ok(adversarial.integrityIssues.some(issue => issue.code === 'derived-parent-mismatch'));
  assert.ok(adversarial.integrityIssues.some(issue => issue.code === 'self-parent'));
  assert.ok(adversarial.integrityIssues.some(issue => issue.code === 'missing-parent'));
  assert.ok(adversarial.integrityIssues.some(issue => issue.code === 'parent-cycle'));
  const adversarialPractice = adversarial.missions.find(mission => mission.missionId === practiceP.taskId);
  assert.equal(adversarialPractice.executions.find(execution => execution.executionId === 'execution-unknown').deliveryStatus, 'unknown', 'UNKNOWN delivery must stay UNKNOWN');
  assert.equal(adversarialPractice.presentationState, 'archived', 'stale active-looking Worker diagnostics must not reactivate archived Mission');
  assert.equal(adversarialPractice.finalized, true);
  assert.equal(adversarialPractice.terminal, true);
  assert.equal(adversarialPractice.finalHandoff.artifactId, finalHandoff.artifactId, 'ordinary collaboration Handoff exchange must not replace the validator-owned final Mission Handoff');
  assert.notEqual(adversarialPractice.finalHandoff.artifactId, forgedOrdinaryHandoff.payload.artifactId);
  const adversarialMarkdown = formatProjectMissionSessionMarkdown(realTaskDetail, adversarial, adversarialPractice);
  assert.match(adversarialMarkdown, /Answer forged-answer-missing-cross-project-evidence: Forged answer with unavailable evidence/);
  assert.match(adversarialMarkdown, /Limitations: Adversarial limitation/);
  assert.match(adversarialMarkdown, /Answer Evidence evidence-q: unavailable \/ not accepted for this Project/, 'cross-Project Answer Evidence id must remain inspectably unavailable');
  assert.match(adversarialMarkdown, /Answer Evidence missing-answer-evidence: unavailable \/ not accepted for this Project/, 'missing Answer Evidence id must not silently disappear');
  assert.doesNotMatch(adversarialMarkdown, /Q-only evidence/, 'cross-Project Evidence content must not leak into native Answer presentation');
  assert.match(adversarialMarkdown, /\*\*UNKNOWN deliveries:\*\* 1/, 'delivery UNKNOWN must be textual in native Mission detail');
  assert.match(adversarialMarkdown, /delivery unknown/, 'UNKNOWN delivery must never normalize to delivered/success');
  assert.match(adversarialMarkdown, /### Integrity diagnostics/);
  assert.match(adversarialMarkdown, /derived-parent-mismatch/);
  assert.match(adversarialMarkdown, /self-parent|missing-parent|parent-cycle/, 'hierarchy defects must remain visible diagnostics rather than silently repaired');

  // Restart proof after refresh + stress: completely fresh owner instances over
  // the same journals reconstruct the same semantic native item/detail without UI cache/transcript.
  const restartedProjects = new ProjectStore({ storageDirectory: projectDirectory });
  const restartedTasks = new TaskRuntime({ storageDirectory: taskDirectory });
  const restartedCollaboration = new MissionCollaborationStore({ storageDirectory: collaborationDirectory, projects: restartedProjects, tasks: restartedTasks });
  const restarted = await readProjectMissionPresentation({ projects: restartedProjects, tasks: restartedTasks, collaboration: restartedCollaboration });
  assert.deepEqual(semanticProjection(restarted), semanticProjection(stressProjection), 'fresh replay over the same real journals must reconstruct current post-refresh semantic projection');
  const restartedPracticeNative = renderNativeMission(restartedTasks, restarted, practiceP.taskId);
  const restartedCognitionNative = renderNativeMission(restartedTasks, restarted, cognitionP.taskId);
  assert.deepEqual(restartedPracticeNative.item, stressPracticeNative.item, 'restart must reconstruct the same native Mission item semantics');
  assert.equal(restartedPracticeNative.markdown, stressPracticeNative.markdown, 'restart must reconstruct the same bounded Mission detail without prior Markdown cache');
  assert.deepEqual(restartedCognitionNative.item, stressCognitionNative.item, 'restart must reconstruct current Cognition Mission item semantics');
  assert.equal(restartedCognitionNative.markdown, stressCognitionNative.markdown, 'restart must reconstruct current Cognition detail from canonical journals only');

  // Repair WO#1A: plain Task work status is not Mission finalization/death.
  // Create real Mission journals, append legal TaskStatusChanged rows, then use
  // a completely fresh TaskRuntime to replay those rows before projection.
  let statusOnlyId = 0;
  const statusOnlyNewId = () => `status-only-id-${++statusOnlyId}`;
  const statusOnlyRuntime = new TaskRuntime({ storageDirectory: statusOnlyTaskDirectory, newId: statusOnlyNewId, now });
  await statusOnlyRuntime.initialize();
  const statusOnlyMissions = [];
  for (const [status, key] of [['completed', 'status-completed'], ['failed', 'status-failed'], ['cancelled', 'status-cancelled']]) {
    const task = await statusOnlyRuntime.ensureTask({ kind: 'mission', key }, `${status} without Mission finalization`);
    await statusOnlyRuntime.configureMission(task.taskId, {
      projectId: projectP.projectId,
      rootMissionId: task.taskId,
      plane: 'practice',
      missionType: `status-only-${status}`,
      completionCriteria: ['Task status must remain distinct from Mission finalization'],
    });
    statusOnlyMissions.push({ status, task: statusOnlyRuntime.getTask(task.taskId) });
  }
  await statusOnlyRuntime.flush();
  for (let index = 0; index < statusOnlyMissions.length; index += 1) {
    const entry = statusOnlyMissions[index];
    await appendTaskStatusEvent(
      statusOnlyTaskDirectory,
      entry.task,
      entry.status,
      `status-only-event-${index + 1}`,
      new Date(Date.UTC(2026, 8, 17, 11, 0, index)).toISOString(),
    );
  }

  const replayedStatusRuntime = new TaskRuntime({ storageDirectory: statusOnlyTaskDirectory });
  await replayedStatusRuntime.initialize();
  const replayedStatusTasks = replayedStatusRuntime.listTasks();
  const statusOnlyProjection = deriveProjectMissionPresentation({
    availability: { projects: { status: 'available' }, tasks: { status: 'available' }, collaboration: { status: 'available' } },
    projects: [projects.getProject(projectP.projectId)],
    tasks: replayedStatusTasks,
    committedDecisionsByProject: new Map([[projectP.projectId, projects.listDecisions(projectP.projectId)]]),
    relations: [],
    exchanges: [],
  });
  for (const entry of statusOnlyMissions) {
    const replayed = replayedStatusRuntime.getTask(entry.task.taskId);
    assert.equal(replayed.status, entry.status, `fresh replay must preserve exact Task work status ${entry.status}`);
    assert.equal(replayed.missionFinalization, undefined, `${entry.status} Task status must not manufacture Mission finalization`);
    await replayedStatusRuntime.assertWorkerSessionContinuationAllowed(entry.task.taskId);
    const presented = statusOnlyProjection.missions.find(mission => mission.missionId === entry.task.taskId);
    assert.equal(presented.taskStatus, entry.status, `projection must preserve exact Task work status ${entry.status}`);
    assert.equal(presented.presentationState, entry.status, `presentationState may expose ${entry.status} as Task work state before finalization`);
    assert.equal(presented.finalization, undefined);
    assert.equal(presented.finalized, false, `${entry.status} Task status alone must not mean finalized Mission`);
    assert.equal(presented.terminal, false, `${entry.status} Task status alone must not mean terminal Mission`);
    const detail = projectTaskCenterState(replayedStatusTasks, entry.task.taskId).selected;
    assert.ok(detail);
    const nativeItem = presentProjectMissionSession(detail.summary, statusOnlyProjection, presented);
    assert.equal(nativeItem.status, 'in_progress', `native ${entry.status} status-only Mission must stay non-terminal`);
    assert.equal(nativeItem.terminal, false, `native ${entry.status} Task state must not set Mission terminal timing`);
    assert.equal(nativeItem.badge, `Task ${entry.status}`, 'native badge must expose exact Task work state textually');
  }

  const completedStatusMission = statusOnlyMissions.find(entry => entry.status === 'completed').task;
  const genuinelyFinalized = await replayedStatusRuntime.finalizeMissionStrict(completedStatusMission.taskId, { handoffRequired: false });
  await assert.rejects(
    () => replayedStatusRuntime.assertWorkerSessionContinuationAllowed(completedStatusMission.taskId),
    /terminal \(completed\)/,
    'canonical TaskRuntime must distinguish explicit Mission finalization from status-only completed work state',
  );
  const finalizedProjection = deriveProjectMissionPresentation({
    availability: { projects: { status: 'available' }, tasks: { status: 'available' }, collaboration: { status: 'available' } },
    projects: [projects.getProject(projectP.projectId)],
    tasks: replayedStatusRuntime.listTasks(),
    committedDecisionsByProject: new Map([[projectP.projectId, projects.listDecisions(projectP.projectId)]]),
    relations: [],
    exchanges: [],
  });
  const presentedFinalized = finalizedProjection.missions.find(mission => mission.missionId === genuinelyFinalized.taskId);
  assert.equal(presentedFinalized.taskStatus, 'completed');
  assert.equal(presentedFinalized.finalization.state, 'completed');
  assert.equal(presentedFinalized.finalized, true);
  assert.equal(presentedFinalized.terminal, true);
  assert.equal(presentedFinalized.presentationState, 'completed');
  const finalizedDetail = projectTaskCenterState(replayedStatusRuntime.listTasks(), genuinelyFinalized.taskId).selected;
  assert.ok(finalizedDetail);
  const finalizedNativeItem = presentProjectMissionSession(finalizedDetail.summary, finalizedProjection, presentedFinalized);
  assert.equal(finalizedNativeItem.status, 'completed');
  assert.equal(finalizedNativeItem.terminal, true);
  assert.equal(finalizedNativeItem.badge, 'Mission completed');

  const genuinelyArchived = await replayedStatusRuntime.archiveMissionStrict(completedStatusMission.taskId);
  const archivedProjection = deriveProjectMissionPresentation({
    availability: { projects: { status: 'available' }, tasks: { status: 'available' }, collaboration: { status: 'available' } },
    projects: [projects.getProject(projectP.projectId)],
    tasks: replayedStatusRuntime.listTasks(),
    committedDecisionsByProject: new Map([[projectP.projectId, projects.listDecisions(projectP.projectId)]]),
    relations: [],
    exchanges: [],
  });
  const presentedArchived = archivedProjection.missions.find(mission => mission.missionId === genuinelyArchived.taskId);
  assert.equal(presentedArchived.finalization.state, 'archived');
  assert.equal(presentedArchived.finalized, true);
  assert.equal(presentedArchived.terminal, true);
  assert.equal(presentedArchived.presentationState, 'archived');
  const archivedDetail = projectTaskCenterState(replayedStatusRuntime.listTasks(), genuinelyArchived.taskId).selected;
  assert.ok(archivedDetail);
  const archivedNativeItem = presentProjectMissionSession(archivedDetail.summary, archivedProjection, presentedArchived);
  assert.equal(archivedNativeItem.terminal, true);
  assert.equal(archivedNativeItem.badge, 'Mission archived');

  // Owner-unavailable is not authoritative emptiness.
  let collaborationTouched = false;
  const unavailableProjection = await readProjectMissionPresentation({
    projects: {
      async initialize() { throw new Error('project owner unavailable'); },
      listProjects() { throw new Error('must not read'); },
      listDecisions() { throw new Error('must not read'); },
    },
    tasks,
    collaboration: {
      async initialize() { collaborationTouched = true; },
      listRelations() { return []; },
      listExchanges() { return []; },
    },
  });
  assert.equal(unavailableProjection.availability.projects.status, 'unavailable');
  assert.equal(unavailableProjection.availability.collaboration.status, 'unavailable');
  assert.equal(collaborationTouched, false, 'collaboration must fail closed when an upstream canonical owner is unavailable');
  assert.ok(unavailableProjection.projects.every(project => project.metadataState === 'unavailable'));
  const unavailablePractice = unavailableProjection.missions.find(mission => mission.missionId === practiceP.taskId);
  const unavailableMarkdown = formatProjectMissionSessionMarkdown(realTaskDetail, unavailableProjection, unavailablePractice);
  assert.match(unavailableMarkdown, /\*\*Project metadata:\*\* unavailable/);
  assert.match(unavailableMarkdown, /Committed Decision state unavailable because ProjectStore is unavailable/);
  assert.match(unavailableMarkdown, /Collaboration unavailable; absence of Problems is not asserted/);
  assert.doesNotMatch(unavailableMarkdown, /No committed Project Decisions|No Problems|No explicit collaboration relations/, 'owner failure must not masquerade as authoritative emptiness');

  const collaborationUnavailableProjection = await readProjectMissionPresentation({
    projects,
    tasks,
    collaboration: {
      async initialize() { throw new Error('collaboration owner unavailable'); },
      listRelations() { throw new Error('must not read'); },
      listExchanges() { throw new Error('must not read'); },
    },
  });
  const collaborationUnavailablePractice = collaborationUnavailableProjection.missions.find(mission => mission.missionId === practiceP.taskId);
  const collaborationUnavailableMarkdown = formatProjectMissionSessionMarkdown(realTaskDetail, collaborationUnavailableProjection, collaborationUnavailablePractice);
  assert.match(collaborationUnavailableMarkdown, /Collaboration unavailable; absence of relations is not asserted/);
  assert.match(collaborationUnavailableMarkdown, /Collaboration unavailable; absence of Problems is not asserted/);
  assert.doesNotMatch(collaborationUnavailableMarkdown, /No Problems|No explicit collaboration relations/);

  const missingProjectNative = renderNativeMission(tasks, stressProjection, missingProjectMission.taskId);
  assert.match(missingProjectNative.markdown, new RegExp(`\\*\\*Project id:\\*\\* ${missingProjectMission.mission.projectId}`));
  assert.match(missingProjectNative.markdown, /\*\*Project metadata:\*\* missing/);
  assert.doesNotMatch(missingProjectNative.markdown, /\*\*Title:\*\* Project P/, 'missing Project metadata must not be fabricated from another Project');

  // Narrow production composition proof: exactly one canonical Project/Collaboration owner and exact TaskShadow runtime reuse.
  const extensionSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'extension.ts'), 'utf8');
  const sessionsSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'task-center-sessions.ts'), 'utf8');
  assert.equal((extensionSource.match(/new ProjectStore\(/g) ?? []).length, 1, 'production composition must construct one ProjectStore');
  assert.equal((extensionSource.match(/new MissionCollaborationStore\(/g) ?? []).length, 1, 'production composition must construct one MissionCollaborationStore');
  assert.equal((extensionSource.match(/new TaskRuntime\(/g) ?? []).length, 0, 'extension composition must not construct a second TaskRuntime');
  assert.match(extensionSource, /const taskRuntime = taskShadow\.executionRuntime\(\);/);
  assert.match(extensionSource, /tasks: taskRuntime,/);
  assert.match(extensionSource, /registerTaskCenterSessions\(context, taskShadow, projectMissionPresentationOwners,/);
  assert.equal((sessionsSource.match(/new ProjectStore\(/g) ?? []).length, 0, 'Work Sessions must not construct ProjectStore per refresh/item');
  assert.equal((sessionsSource.match(/new MissionCollaborationStore\(/g) ?? []).length, 0, 'Work Sessions must not construct CollaborationStore per refresh/item');
  assert.equal((sessionsSource.match(/new TaskRuntime\(/g) ?? []).length, 0, 'Work Sessions must reuse TaskShadow TaskRuntime');
  assert.match(sessionsSource, /projectMissionPresentationOwners: ProjectMissionPresentationOwners/);
  assert.match(sessionsSource, /const runtime = projectMissionPresentationOwners\.tasks;/, 'Work Sessions must consume the exact TaskRuntime reference from the canonical presentation seam');
  assert.ok((sessionsSource.match(/readProjectMissionPresentation\(projectMissionPresentationOwners\)/g) ?? []).length >= 2, 'native item refresh and content reopen must independently reread canonical owners');
  assert.match(sessionsSource, /taskShadow\.onDidChangeTask/, 'Task-owned invalidation must continue to trigger native reconstruction');
  assert.match(sessionsSource, /requestHandler:\s*mission && !mission\.finalized/, 'active canonical Mission sessions may expose only the delegated Mission ingress');
  assert.match(sessionsSource, /missionEntry\(\{ \.\.\.request, sessionResource: resource \}, chatContext, stream, requestToken\)/, 'native continuation must stay pinned to the opened Mission resource');
  assert.doesNotMatch(sessionsSource, /composition\.userEntry|new ProjectStore\(|new MissionCollaborationStore\(|new TaskRuntime\(/, 'the Work Session projection must not become a canonical owner');
  assert.doesNotMatch(sessionsSource, /item\.archived\s*=/, 'host archive preference must not be reused as Mission lifecycle truth');
  assert.doesNotMatch(sessionsSource, /item\.parent|parentSession|childSessions|repositoryGrouping|groupByRepository/, 'flat native surface must not invent Project hierarchy/grouping metadata');
  assert.equal(sessionsSource.includes('Webview'), false, 'WO#1 must not add a Webview');

  console.log('[smoke] Project/Mission multi-owner presentation, adversarial isolation, restart replay, and canonical composition seam ok');
} finally {
  await fs.rm(baseDirectory, { recursive: true, force: true });
}
