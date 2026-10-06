import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-task-center-sessions-'));
const bundlePath = path.join(bundleDirectory, 'task-center-session-presentation.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { presentProjectMissionSession, formatProjectMissionSessionMarkdown, presentTaskSession, presentTaskSessionArtifacts, buildTaskSessionEntryTree, buildTaskSessionFileTree, formatTaskSessionMarkdown } from './extensions/shuncode/src/task-center-session-presentation.ts';
      export { taskDiagnosticsArtifact, taskDirectoryArtifact, taskFileNavigationArtifact, taskLspArtifact, taskLspHoverArtifact, taskLspLocationArtifact } from './extensions/shuncode/src/task-file-artifacts.ts';
      export { taskTerminalArtifact } from './extensions/shuncode/src/task-terminal-artifacts.ts';
    `,
    resolveDir: root,
    sourcefile: 'task-center-session-presentation-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});

const { presentProjectMissionSession, formatProjectMissionSessionMarkdown, presentTaskSession, presentTaskSessionArtifacts, buildTaskSessionEntryTree, buildTaskSessionFileTree, formatTaskSessionMarkdown, taskDiagnosticsArtifact, taskDirectoryArtifact, taskFileNavigationArtifact, taskLspArtifact, taskLspHoverArtifact, taskLspLocationArtifact, taskTerminalArtifact } = require(bundlePath);

const summary = {
  version: 1,
  taskId: 'task-a',
  projectId: 'project-a',
  missionId: 'task-a',
  rootMissionId: 'task-a',
  plane: 'practice',
  missionType: 'implementation',
  status: 'running',
  sourceKind: 'bridge',
  goal: 'Ship\nTask-owned Work Sessions',
  createdAt: '2026-09-13T08:00:00.000Z',
  updatedAt: '2026-09-13T08:06:00.000Z',
  todoCounts: { total: 3, pending: 1, inProgress: 1, completed: 1 },
  progress: { message: 'Projecting Task state', phase: 'Work Sessions', percent: 60, todoId: 'project', at: '2026-09-13T08:05:00.000Z' },
  workerCount: 2,
  activeWorkerCount: 1,
  executionCounts: { total: 4, running: 0, succeeded: 3, failed: 1, unknown: 0, pendingDelivery: 1 },
  artifactCount: 5,
};

const detail = {
  summary,
  todos: [
    { id: 'inspect', title: 'Inspect native Sessions', status: 'completed' },
    { id: 'project', title: 'Project Task state', status: 'in_progress' },
    { id: 'verify', title: 'Verify', status: 'pending' },
  ],
  progress: summary.progress,
  workers: [
    { managedSessionId: 'worker-a', workerId: 'nimora.web-worker', model: 'deepseek', attachedAt: '2026-09-13T08:01:00.000Z' },
    { managedSessionId: 'worker-b', workerId: 'nimora.api-worker', attachedAt: '2026-09-13T08:02:00.000Z', detachedAt: '2026-09-13T08:04:00.000Z' },
  ],
  timeline: [
    { id: 'execution:read', kind: 'execution', at: '2026-09-13T08:03:00.000Z', title: 'read_files', status: 'succeeded', deliveryStatus: 'pending', resultSummary: 'Read workspace files' },
    { id: 'artifact:a', kind: 'artifact', at: '2026-09-13T08:04:00.000Z', title: 'Changed one file', artifactKind: 'changeset' },
    { id: 'progress:p', kind: 'progress', at: '2026-09-13T08:05:00.000Z', title: 'Work Sessions', message: 'Projecting Task state', percent: 60, todoId: 'project' },
  ],
  artifacts: [
    { artifactId: 'changes', kind: 'changeset', title: 'Workspace patch', createdAt: '2026-09-13T08:04:00.000Z', metadata: { files: ['src/b.ts', 'src/a.ts', '../escape.txt', '/absolute.txt'], additions: 10, deletions: 2, diffTruncated: true, content: '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new', contentLanguage: 'diff', contentTruncated: true } },
    { artifactId: 'read', kind: 'file', title: 'Read source files', createdAt: '2026-09-13T08:04:10.000Z', metadata: { files: ['src/c.ts', '../outside.ts'], sourceTool: 'read_files', resultTruncated: true } },
    { artifactId: 'search', kind: 'file', title: 'Search needle', createdAt: '2026-09-13T08:04:20.000Z', metadata: { files: ['src/search.ts', '../outside.ts'], locations: [{ path: 'src/search.ts', line: 12, column: 7, label: ' needle here ' }, { path: '../outside.ts', line: 1, column: 1, label: 'unsafe' }, { path: 'src/invalid.ts', line: 0, column: 1, label: 'invalid' }], locationCount: 3, locationsTruncated: false } },
    { artifactId: 'report', kind: 'report', title: 'Review report', uri: 'https://example.com/report', createdAt: '2026-09-13T08:04:30.000Z' },
    { artifactId: 'unsafe', kind: 'other', title: 'Unsafe command URI', uri: 'command:do-not-run', createdAt: '2026-09-13T08:04:40.000Z' },
  ],
};

const missionBase = {
  taskId: 'mission-practice',
  projectId: 'project-p',
  rootMissionId: 'mission-root',
  parentMissionId: 'mission-root',
  plane: 'practice',
  semanticRole: '理',
  missionType: 'implementation',
  goal: 'Implement native Project/Mission semantics',
  taskStatus: 'running',
  finalization: undefined,
  finalized: false,
  presentationState: 'running',
  terminal: false,
  hierarchyDepth: 1,
  executions: [
    { executionId: 'unknown-execution', toolName: 'read_files', status: 'unknown', deliveryStatus: 'unknown', requestedAt: '2026-09-17T10:00:00.000Z', resultSummary: 'Outcome remains indeterminate', duplicateObservations: 0 },
  ],
  artifacts: [
    { artifactId: 'ordinary-artifact', kind: 'report', title: 'Ordinary report', createdAt: '2026-09-17T10:01:00.000Z' },
  ],
  finalHandoff: undefined,
  workers: [
    { managedSessionId: 'worker-old', workerId: 'nimora.web-worker', adapterSessionId: 'provider-old', model: 'model-old', attachedAt: '2026-09-17T09:00:00.000Z', detachedAt: '2026-09-17T09:10:00.000Z', retiredAt: '2026-09-17T09:11:00.000Z', retirementReason: 'replacement' },
    { managedSessionId: 'worker-new', workerId: 'nimora.api-worker', adapterSessionId: 'provider-new', model: 'model-new', attachedAt: '2026-09-17T09:12:00.000Z' },
  ],
};

const missionRoot = {
  ...missionBase,
  missionId: 'mission-root',
  taskId: 'mission-root',
  rootMissionId: 'mission-root',
  parentMissionId: undefined,
  plane: 'coordination',
  semanticRole: '总协调',
  missionType: 'root-coordination',
  goal: 'Coordinate Phase 9',
  hierarchyDepth: 0,
  executions: [],
  artifacts: [],
  workers: [],
};
const missionCognition = {
  ...missionBase,
  missionId: 'mission-cognition',
  taskId: 'mission-cognition',
  plane: 'cognition',
  semanticRole: '文',
  missionType: 'architecture',
  goal: 'Understand Project/Mission UI semantics',
  executions: [],
  artifacts: [],
  workers: [],
};
const missionPractice = { ...missionBase, missionId: 'mission-practice' };
const statusOnlyCompletedMission = { ...missionBase, missionId: 'mission-status-completed', taskId: 'mission-status-completed', taskStatus: 'completed', presentationState: 'completed', goal: 'Status-only completed Mission', executions: [], artifacts: [], workers: [] };
const statusOnlyFailedMission = { ...missionBase, missionId: 'mission-status-failed', taskId: 'mission-status-failed', taskStatus: 'failed', presentationState: 'failed', goal: 'Status-only failed Mission', executions: [], artifacts: [], workers: [] };
const statusOnlyCancelledMission = { ...missionBase, missionId: 'mission-status-cancelled', taskId: 'mission-status-cancelled', taskStatus: 'cancelled', presentationState: 'cancelled', goal: 'Status-only cancelled Mission', executions: [], artifacts: [], workers: [] };
const finalizedMission = {
  ...missionBase,
  missionId: 'mission-finalized',
  taskId: 'mission-finalized',
  taskStatus: 'completed',
  presentationState: 'completed',
  finalized: true,
  terminal: true,
  finalization: { state: 'completed', handoffRequired: true, handoffArtifactId: 'validated-final-handoff', completedAt: '2026-09-17T10:10:00.000Z' },
  artifacts: [
    { artifactId: 'ordinary-artifact', kind: 'report', title: 'Ordinary report', createdAt: '2026-09-17T10:01:00.000Z' },
    { artifactId: 'validated-final-handoff', kind: 'report', title: 'Validated Handoff', createdAt: '2026-09-17T10:10:00.000Z' },
  ],
  finalHandoff: { artifactId: 'validated-final-handoff', kind: 'report', title: 'Validated Handoff', createdAt: '2026-09-17T10:10:00.000Z' },
  executions: [],
  workers: [],
};
const archivedMission = {
  ...finalizedMission,
  missionId: 'mission-archived',
  taskId: 'mission-archived',
  goal: 'Archived Mission',
  presentationState: 'archived',
  finalization: { ...finalizedMission.finalization, state: 'archived', archivedAt: '2026-09-17T10:20:00.000Z' },
};
const projectQMission = {
  ...missionBase,
  missionId: 'mission-q',
  taskId: 'mission-q',
  projectId: 'project-q',
  rootMissionId: 'mission-q',
  parentMissionId: undefined,
  goal: 'Project Q Mission',
  hierarchyDepth: 0,
  executions: [],
  artifacts: [],
  workers: [],
};
const missingProjectMission = {
  ...missionBase,
  missionId: 'mission-missing-project',
  taskId: 'mission-missing-project',
  projectId: 'missing-project',
  rootMissionId: 'mission-missing-project',
  parentMissionId: undefined,
  goal: 'Missing Project Mission',
  hierarchyDepth: 0,
  executions: [],
  artifacts: [],
  workers: [],
};

const semanticProjection = {
  version: 1,
  availability: {
    projects: { status: 'available' },
    tasks: { status: 'available' },
    collaboration: { status: 'available' },
  },
  projects: [
    {
      projectId: 'project-p',
      metadataState: 'available',
      title: 'Project P',
      goal: 'Truthful native Work Sessions',
      workspace: '/workspace/p',
      decisionsState: 'available',
      committedDecisions: [{
        decisionId: 'decision-committed', projectId: 'project-p', proposalId: 'proposal-committed', contentDigest: 'sha256:committed', confirmationId: 'confirmation-committed', committedAt: '2026-09-17T09:00:00.000Z',
        content: { kind: 'decision', summary: 'COMMITTED DECISION MARKER', scope: { kind: 'project' } },
      }],
      missionIds: ['mission-root', 'mission-cognition', 'mission-practice', 'mission-status-completed', 'mission-status-failed', 'mission-status-cancelled', 'mission-finalized', 'mission-archived'],
      collaborationState: 'available',
      hierarchyRelations: [
        { relationId: 'parent_of:mission-cognition', projectId: 'project-p', sourceMissionId: 'mission-root', targetMissionId: 'mission-cognition', type: 'parent_of', createdAt: '2026-09-17T09:00:00.000Z', derived: true },
        { relationId: 'parent_of:mission-practice', projectId: 'project-p', sourceMissionId: 'mission-root', targetMissionId: 'mission-practice', type: 'parent_of', createdAt: '2026-09-17T09:00:00.000Z', derived: true },
      ],
      relations: [
        { relationId: 'relation-depends', projectId: 'project-p', sourceMissionId: 'mission-practice', targetMissionId: 'mission-cognition', type: 'depends_on', createdAt: '2026-09-17T09:30:00.000Z' },
      ],
      exchanges: [
        { exchangeId: 'evidence-good', projectId: 'project-p', sourceMissionId: 'mission-practice', kind: 'Evidence', createdAt: '2026-09-17T09:31:00.000Z', payload: { summary: 'EXACT EVIDENCE MARKER', references: [] } },
        { exchangeId: 'evidence-answer', projectId: 'project-p', sourceMissionId: 'mission-cognition', kind: 'Evidence', createdAt: '2026-09-17T09:31:00.500Z', payload: { summary: 'ANSWER EVIDENCE MARKER', references: [] } },
        { exchangeId: 'evidence-unrelated', projectId: 'project-p', sourceMissionId: 'mission-practice', kind: 'Evidence', createdAt: '2026-09-17T09:31:01.000Z', payload: { summary: 'WRONG EVIDENCE MUST NOT RENDER', references: [] } },
        { exchangeId: 'answer-exact', projectId: 'project-p', sourceMissionId: 'mission-cognition', targetMissionId: 'mission-practice', kind: 'Answer', replyToExchangeId: 'problem-answered', createdAt: '2026-09-17T09:32:00.000Z', payload: { answer: 'EXACT ANSWER MARKER', evidenceExchangeIds: ['evidence-answer'], limitations: 'KNOWN LIMITATION MARKER' } },
        { exchangeId: 'answer-wrong-problem', projectId: 'project-p', sourceMissionId: 'mission-cognition', targetMissionId: 'mission-practice', kind: 'Answer', replyToExchangeId: 'different-problem', createdAt: '2026-09-17T09:32:01.000Z', payload: { answer: 'WRONG ANSWER MUST NOT CLOSE OPEN PROBLEM', evidenceExchangeIds: [] } },
        { exchangeId: 'ordinary-handoff-exchange', projectId: 'project-p', sourceMissionId: 'mission-practice', targetMissionId: 'mission-root', kind: 'Handoff', createdAt: '2026-09-17T09:33:00.000Z', payload: { artifactId: 'ordinary-artifact', sourceTaskEventId: 'ordinary-event', sourceTaskEventCount: 1, contentDigest: 'sha256:ordinary' } },
      ],
      problems: [
        { exchangeId: 'problem-answered', sourceMissionId: 'mission-practice', targetMissionId: 'mission-cognition', answerState: 'Answered', blocking: true, answerExchangeIds: ['answer-exact'], answers: [{ exchangeId: 'answer-exact', sourceMissionId: 'mission-cognition', targetMissionId: 'mission-practice', answer: 'EXACT ANSWER MARKER', limitations: 'KNOWN LIMITATION MARKER', evidence: [{ exchangeId: 'evidence-answer', projectId: 'project-p', sourceMissionId: 'mission-cognition', kind: 'Evidence', createdAt: '2026-09-17T09:31:00.500Z', payload: { summary: 'ANSWER EVIDENCE MARKER', references: [] } }], missingEvidenceExchangeIds: [] }], evidence: [{ exchangeId: 'evidence-good', projectId: 'project-p', sourceMissionId: 'mission-practice', kind: 'Evidence', createdAt: '2026-09-17T09:31:00.000Z', payload: { summary: 'EXACT EVIDENCE MARKER', references: [] } }], missingEvidenceExchangeIds: [] },
        { exchangeId: 'problem-open', sourceMissionId: 'mission-practice', targetMissionId: 'mission-cognition', answerState: 'Open', blocking: false, answerExchangeIds: [], answers: [], evidence: [], missingEvidenceExchangeIds: ['missing-evidence'] },
      ],
    },
    {
      projectId: 'project-q', metadataState: 'available', title: 'Project Q', goal: 'Isolation', workspace: '/workspace/q', decisionsState: 'available', committedDecisions: [], missionIds: ['mission-q'], collaborationState: 'available', hierarchyRelations: [], relations: [], exchanges: [], problems: [],
    },
    {
      projectId: 'missing-project', metadataState: 'missing', decisionsState: 'missing-project', committedDecisions: [], missionIds: ['mission-missing-project'], collaborationState: 'available', hierarchyRelations: [], relations: [], exchanges: [], problems: [],
    },
  ],
  missions: [missionRoot, missionCognition, missionPractice, statusOnlyCompletedMission, statusOnlyFailedMission, statusOnlyCancelledMission, finalizedMission, archivedMission, projectQMission, missingProjectMission],
  legacyTaskIds: ['legacy-task'],
  integrityIssues: [{ code: 'missing-project', projectId: 'missing-project', missionId: 'mission-missing-project', detail: 'Mission references a Project that is absent from ProjectStore.' }],
};

function missionSummary(mission) {
  return {
    ...summary,
    taskId: mission.taskId,
    projectId: mission.projectId,
    missionId: mission.missionId,
    rootMissionId: mission.rootMissionId,
    parentMissionId: mission.parentMissionId,
    plane: mission.plane,
    missionType: mission.missionType,
    status: mission.taskStatus,
    goal: mission.goal,
  };
}

try {
  const presentation = presentTaskSession(summary);
  assert.equal(presentation.label, 'Ship Task-owned Work Sessions', 'session labels must stay single-line');
  assert.equal(presentation.description, '1/3 todos · 1 active AI · 4 actions · 5 artifacts');
  assert.equal(presentation.badge, '60%');
  assert.equal(presentation.status, 'in_progress');
  assert.equal(presentation.terminal, false);
  const legacySummary = {
    ...summary,
    projectId: undefined,
    missionId: undefined,
    rootMissionId: undefined,
    parentMissionId: undefined,
    plane: undefined,
    missionType: undefined,
  };
  assert.equal(presentTaskSession(legacySummary).label, presentation.label, 'legacy Task summaries must still render');

  assert.deepEqual(
    { status: presentTaskSession({ ...summary, status: 'waiting_user' }).status, badge: presentTaskSession({ ...summary, status: 'waiting_user' }).badge },
    { status: 'needs_input', badge: 'Needs input' },
  );
  assert.equal(presentTaskSession({ ...summary, status: 'completed' }).terminal, true);

  const practiceItem = presentProjectMissionSession(missionSummary(missionPractice), semanticProjection, missionPractice);
  assert.match(practiceItem.label, /^理 · Implement native Project\/Mission semantics$/, 'Mission item identity must lead with durable semantic role + Mission goal');
  assert.match(practiceItem.description, /Project · Project P · 理 · implementation · Task running · Mission not finalized/);
  assert.doesNotMatch(`${practiceItem.label} ${practiceItem.description}`, /worker-old|worker-new|model-old|model-new|AI Workers/, 'Worker/provider/model identity must not become the Mission item identity');
  assert.equal(practiceItem.status, 'in_progress');
  assert.equal(practiceItem.terminal, false);

  for (const [mission, taskStatus] of [
    [statusOnlyCompletedMission, 'completed'],
    [statusOnlyFailedMission, 'failed'],
    [statusOnlyCancelledMission, 'cancelled'],
  ]) {
    const item = presentProjectMissionSession(missionSummary(mission), semanticProjection, mission);
    assert.equal(item.status, 'in_progress', `status-only ${taskStatus} Mission must stay non-terminal in native status`);
    assert.equal(item.terminal, false, `status-only ${taskStatus} Task state must not become Mission death`);
    assert.equal(item.badge, `Task ${taskStatus}`, 'exact Task work status must remain visible textually');
    assert.match(item.description, new RegExp(`Task ${taskStatus} · Mission not finalized`));
  }
  const waitingMission = { ...missionPractice, taskStatus: 'waiting_user', presentationState: 'waiting_user' };
  assert.deepEqual(
    { status: presentProjectMissionSession(missionSummary(waitingMission), semanticProjection, waitingMission).status, terminal: presentProjectMissionSession(missionSummary(waitingMission), semanticProjection, waitingMission).terminal },
    { status: 'needs_input', terminal: false },
    'non-finalized waiting_user Mission may use NeedsInput without becoming terminal',
  );
  const finalizedItem = presentProjectMissionSession(missionSummary(finalizedMission), semanticProjection, finalizedMission);
  assert.equal(finalizedItem.status, 'completed');
  assert.equal(finalizedItem.badge, 'Mission completed');
  assert.equal(finalizedItem.terminal, true, 'explicit Mission finalization must establish terminal native semantics');
  const archivedItem = presentProjectMissionSession(missionSummary(archivedMission), semanticProjection, archivedMission);
  assert.equal(archivedItem.badge, 'Mission archived');
  assert.equal(archivedItem.terminal, true, 'canonical archived finalization must remain terminal');

  const missionDetail = {
    ...detail,
    summary: missionSummary(missionPractice),
    artifacts: [
      { artifactId: 'ordinary-artifact', kind: 'report', title: 'Ordinary report', createdAt: '2026-09-17T10:01:00.000Z' },
    ],
  };
  const missionMarkdown = formatProjectMissionSessionMarkdown(missionDetail, semanticProjection, missionPractice);
  assert.match(missionMarkdown, /### Project/);
  assert.match(missionMarkdown, /\*\*Project id:\*\* project-p/);
  assert.match(missionMarkdown, /\*\*Title:\*\* Project P/);
  assert.match(missionMarkdown, /\*\*Goal:\*\* Truthful native Work Sessions/);
  assert.match(missionMarkdown, /\*\*Workspace:\*\* \/workspace\/p/);
  assert.match(missionMarkdown, /COMMITTED DECISION MARKER/, 'current committed Project Decision must render');
  assert.doesNotMatch(missionMarkdown, /DRAFT DECISION MARKER|PROPOSED DECISION MARKER|HUMAN CONFIRMED MARKER|Worker prose that looks like a Project Decision/, 'non-committed governance and Task prose must not become Project Decision presentation');
  assert.match(missionMarkdown, /\*\*Role:\*\* 理/);
  assert.match(missionMarkdown, /\*\*Task work status:\*\* running/);
  assert.match(missionMarkdown, /\*\*Mission finalized:\*\* no/);
  assert.match(missionMarkdown, /总协调 · Coordinate Phase 9 · mission-root · root · depth 0/);
  assert.match(missionMarkdown, /文 · Understand Project\/Mission UI semantics · mission-cognition · parent mission-root · depth 1/);
  assert.match(missionMarkdown, /depends_on: mission-practice → mission-cognition · id relation-depends/);
  assert.match(missionMarkdown, /\*\*Answered\*\* · Blocking: yes · Problem problem-answered/);
  assert.match(missionMarkdown, /Answer answer-exact: EXACT ANSWER MARKER/);
  assert.match(missionMarkdown, /Limitations: KNOWN LIMITATION MARKER/);
  assert.match(missionMarkdown, /Answer Evidence evidence-answer: ANSWER EVIDENCE MARKER/);
  assert.match(missionMarkdown, /Problem Evidence evidence-good: EXACT EVIDENCE MARKER/);
  assert.match(missionMarkdown, /\*\*Open\*\* · Blocking: no · Problem problem-open/);
  assert.match(missionMarkdown, /Problem Evidence missing-evidence: unavailable \/ not accepted for this Project/);
  assert.doesNotMatch(missionMarkdown, /WRONG ANSWER MUST NOT CLOSE OPEN PROBLEM|WRONG EVIDENCE MUST NOT RENDER/, 'formatter must consume accepted Problem/Answer/Evidence associations instead of re-inferring from nearby exchanges');
  const noLimitationProjection = structuredClone(semanticProjection);
  delete noLimitationProjection.projects[0].problems[0].answers[0].limitations;
  const noLimitationMarkdown = formatProjectMissionSessionMarkdown(missionDetail, noLimitationProjection, missionPractice);
  assert.doesNotMatch(noLimitationMarkdown, /Limitations:/, 'formatter must not fabricate Answer limitations when the accepted Answer has none');
  assert.match(missionMarkdown, /### Progress/);
  assert.match(missionMarkdown, /### Todos/);
  assert.match(missionMarkdown, /\*\*Artifact\*\*:\*\*? Ordinary report|\*\*Artifact:\*\* Ordinary report/);
  assert.doesNotMatch(missionMarkdown, /ordinary-handoff-exchange|Validated final Mission Handoff[^\n]*ordinary-artifact/, 'ordinary artifact or collaboration Handoff exchange must not impersonate final Mission Handoff');
  assert.match(missionMarkdown, /read_files · execution unknown · delivery unknown · Outcome remains indeterminate/, 'UNKNOWN execution and delivery must remain textual UNKNOWN');
  assert.match(missionMarkdown, /Workers \(secondary diagnostics\)/);
  assert.ok(missionMarkdown.indexOf('### Execution diagnostics') < missionMarkdown.indexOf('worker-old'), 'Worker details must remain after semantic Mission sections');

  const finalizedDetail = {
    ...missionDetail,
    summary: missionSummary(finalizedMission),
    artifacts: [
      { artifactId: 'ordinary-artifact', kind: 'report', title: 'Ordinary report', createdAt: '2026-09-17T10:01:00.000Z' },
      { artifactId: 'validated-final-handoff', kind: 'report', title: 'Validated Handoff', createdAt: '2026-09-17T10:10:00.000Z' },
    ],
  };
  const finalizedMarkdown = formatProjectMissionSessionMarkdown(finalizedDetail, semanticProjection, finalizedMission);
  assert.match(finalizedMarkdown, /\*\*Mission finalized:\*\* yes/);
  assert.match(finalizedMarkdown, /\*\*Mission lifecycle:\*\* completed/);
  assert.match(finalizedMarkdown, /\*\*Validated final Mission Handoff:\*\* Validated Handoff · report · id validated-final-handoff/);
  assert.match(finalizedMarkdown, /\*\*Artifact:\*\* Ordinary report · report · id ordinary-artifact/);

  const archivedMarkdown = formatProjectMissionSessionMarkdown({ ...missionDetail, summary: missionSummary(archivedMission) }, semanticProjection, archivedMission);
  assert.match(archivedMarkdown, /\*\*Mission lifecycle:\*\* archived/);

  const missingProjectMarkdown = formatProjectMissionSessionMarkdown({ ...missionDetail, summary: missionSummary(missingProjectMission) }, semanticProjection, missingProjectMission);
  assert.match(missingProjectMarkdown, /\*\*Project id:\*\* missing-project/);
  assert.match(missingProjectMarkdown, /\*\*Project metadata:\*\* missing/);
  assert.match(missingProjectMarkdown, /Committed Decision state unavailable because the referenced Project is missing/);
  assert.doesNotMatch(missingProjectMarkdown, /Project P|Truthful native Work Sessions/, 'missing Project metadata must never be fabricated from another Project');
  assert.match(missingProjectMarkdown, /### Integrity diagnostics/);
  assert.match(missingProjectMarkdown, /missing-project/);

  const unavailableProjection = structuredClone(semanticProjection);
  unavailableProjection.availability.projects = { status: 'unavailable', detail: 'Project owner unavailable marker' };
  unavailableProjection.availability.collaboration = { status: 'unavailable', detail: 'Collaboration owner unavailable marker' };
  unavailableProjection.projects[0] = { ...unavailableProjection.projects[0], metadataState: 'unavailable', decisionsState: 'unavailable', committedDecisions: [], collaborationState: 'unavailable', relations: [], exchanges: [], problems: [] };
  const unavailableMarkdown = formatProjectMissionSessionMarkdown(missionDetail, unavailableProjection, missionPractice);
  assert.match(unavailableMarkdown, /\*\*Project metadata:\*\* unavailable/);
  assert.match(unavailableMarkdown, /Project owner unavailable marker/);
  assert.match(unavailableMarkdown, /Committed Decision state unavailable because ProjectStore is unavailable/);
  assert.match(unavailableMarkdown, /Collaboration unavailable; absence of Problems is not asserted/);
  assert.match(unavailableMarkdown, /Collaboration owner unavailable marker/);
  assert.doesNotMatch(unavailableMarkdown, /No committed Project Decisions|No Problems|No explicit collaboration relations/, 'owner failure must not normalize to authoritative emptiness');

  const artifacts = presentTaskSessionArtifacts(detail);
  assert.deepEqual(artifacts[0].files, ['src/b.ts', 'src/a.ts'], 'artifact presentation must drop absolute/traversal paths');
  assert.deepEqual(buildTaskSessionFileTree(artifacts[0].files), [{ name: 'src', children: [{ name: 'a.ts' }, { name: 'b.ts' }] }]);
  assert.match(artifacts[0].content ?? '', /^--- a\/src\/a\.ts/);
  assert.equal(artifacts[0].contentLanguage, 'diff');
  assert.equal(artifacts[0].contentTruncated, true);
  assert.deepEqual(artifacts[1].files, ['src/c.ts'], 'file-navigation artifacts use the same workspace-relative path safety boundary');
  assert.equal(artifacts[1].resultTruncated, true);
  assert.deepEqual(artifacts[2].files, ['src/search.ts'], 'search artifact files must drop traversal paths before native presentation');
  assert.deepEqual(artifacts[2].locations, [{ path: 'src/search.ts', line: 12, column: 7, label: 'needle here' }], 'search locations must preserve safe 1-based locations and reject traversal/invalid entries');
  assert.equal(artifacts[2].locationCount, 3);

  const readArtifact = taskFileNavigationArtifact('read_files', {
    files: [
      { path: 'src/read-a.ts', status: 'success' },
      { path: 'src/missing.ts', status: 'error' },
      { path: 'src/read-b.ts', status: 'success' },
    ],
    summary: { truncated: 1 },
  });
  assert.deepEqual(readArtifact?.metadata?.files, ['src/read-a.ts', 'src/read-b.ts'], 'read artifacts must only persist successfully navigable files');
  assert.equal(readArtifact?.metadata?.resultTruncated, true);
  const findArtifact = taskFileNavigationArtifact('find_files', {
    files: [{ path: 'src/found.ts' }, { path: 'src/found.ts' }, { path: 'test/found.test.ts' }],
    summary: { truncated: true },
  });
  assert.deepEqual(findArtifact?.metadata?.files, ['src/found.ts', 'test/found.test.ts']);
  const searchArtifact = taskFileNavigationArtifact('search_files', {
    pattern: 'needle',
    matches: [
      { path: 'src/search.ts', line: 12, column: 7, text: ' const needle = true; ' },
      { path: 'src/search.ts', line: 18, column: 3, text: 'needle();' },
      { path: '../outside.ts', line: 1, column: 1, text: 'unsafe path is filtered by presentation' },
    ],
    summary: { returned_matches: 3, truncated: true },
  });
  assert.deepEqual(searchArtifact?.metadata?.files, ['src/search.ts', '../outside.ts']);
  assert.deepEqual((searchArtifact?.metadata?.locations as Array<{ path: string; line: number; column?: number; label?: string }>).slice(0, 2), [
    { path: 'src/search.ts', line: 12, column: 7, label: 'const needle = true;' },
    { path: 'src/search.ts', line: 18, column: 3, label: 'needle();' },
  ]);
  assert.equal(searchArtifact?.metadata?.resultTruncated, true);
  const manySearchLocations = taskFileNavigationArtifact('search_files', {
    pattern: 'many',
    matches: Array.from({ length: 41 }, (_, index) => ({ path: 'src/many.ts', line: index + 1, column: 1, text: `match ${index}` })),
    summary: { returned_matches: 41, truncated: false },
  });
  assert.equal((manySearchLocations?.metadata?.locations as unknown[]).length, 40, 'search location anchors must stay bounded');
  assert.equal(manySearchLocations?.metadata?.locationsTruncated, true);

  const diagnosticsArtifact = taskDiagnosticsArtifact({ path: 'src' }, [
    '=== GET_DIAGNOSTICS BEGIN ===',
    'scope: "src"',
    'returned: 2',
    'total_matching: 3',
    'truncated: true',
    '--- DIAGNOSTICS ---',
    '--- DIAGNOSTIC 1 ---',
    'src/a.ts:4:2',
    'severity: error',
    'source: "ts"',
    'code: "1001"',
    ' First diagnostic ',
    '--- DIAGNOSTIC 2 ---',
    'src/b.ts:8:1',
    'severity: warning',
    'source: "ts"',
    'code: null',
    'Second diagnostic',
    '=== GET_DIAGNOSTICS END ===',
  ].join('\n'));
  assert.equal(diagnosticsArtifact?.kind, 'file');
  assert.equal(diagnosticsArtifact?.title, 'Diagnostics · src · 3 issues');
  assert.deepEqual(diagnosticsArtifact?.metadata?.files, ['src/a.ts', 'src/b.ts']);
  assert.deepEqual((diagnosticsArtifact?.metadata?.locations as Array<{ path: string; line: number; column?: number; label?: string }>)[0], { path: 'src/a.ts', line: 4, column: 2, label: '[error] First diagnostic' });
  assert.equal(diagnosticsArtifact?.metadata?.locationCount, 3);
  assert.equal(diagnosticsArtifact?.metadata?.resultTruncated, true);
  const cleanDiagnosticsArtifact = taskDiagnosticsArtifact({}, [
    '=== GET_DIAGNOSTICS BEGIN ===',
    'returned: 0',
    'total_matching: 0',
    'truncated: false',
    '--- DIAGNOSTICS ---',
    '=== GET_DIAGNOSTICS END ===',
  ].join('\n'));
  assert.equal(cleanDiagnosticsArtifact?.kind, 'report', 'a successful no-diagnostics result should remain durable instead of disappearing');
  assert.equal(cleanDiagnosticsArtifact?.title, 'No diagnostics · workspace');

  const lspArtifact = taskLspLocationArtifact({ operation: 'workspace_symbols' }, [
    '=== LSP BEGIN ===',
    'operation: workspace_symbols',
    'provider_state: ready',
    'semantic_result_inconclusive: false',
    'total_results: 2',
    'max_results: 20',
    'returned_results: 2',
    'truncated: false',
    '--- RESULTS ---',
    '--- RESULT 1 ---',
    'name: "TaskRuntime"',
    'kind: class',
    'container: "runtime"',
    'path: "src/task-runtime.ts"',
    'workspace: true',
    'range: 20:3-120:4',
    '--- RESULT 2 ---',
    'name: "External"',
    'kind: class',
    'container: null',
    'path: "https://example.com/external.ts"',
    'workspace: false',
    'range: 1:1-1:8',
    '=== LSP END ===',
  ].join('\n'));
  assert.equal(lspArtifact?.kind, 'file');
  assert.equal(lspArtifact?.title, 'LSP · workspace symbols · 2 results');
  assert.deepEqual(lspArtifact?.metadata?.files, ['src/task-runtime.ts'], 'LSP artifact must only persist workspace-style paths');
  assert.deepEqual(lspArtifact?.metadata?.locations, [{ path: 'src/task-runtime.ts', line: 20, column: 3, label: 'TaskRuntime · class · runtime' }]);
  assert.equal(lspArtifact?.metadata?.locationCount, 2, 'LSP total result count remains distinct from safe native links');
  assert.equal(lspArtifact?.metadata?.providerState, 'ready');
  assert.equal(lspArtifact?.metadata?.semanticResultInconclusive, false);
  const emptyLspArtifact = taskLspLocationArtifact({ operation: 'references' }, [
    '=== LSP BEGIN ===',
    'operation: references',
    'provider_state: unknown',
    'semantic_result_inconclusive: true',
    'total_results: 0',
    'max_results: 100',
    'returned_results: 0',
    'truncated: false',
    '--- RESULTS ---',
    '=== LSP END ===',
  ].join('\n'));
  assert.equal(emptyLspArtifact?.kind, 'report', 'empty semantic results must remain durable because provider state can be inconclusive');
  assert.equal(emptyLspArtifact?.metadata?.semanticResultInconclusive, true);
  assert.equal(taskLspLocationArtifact({ operation: 'hover' }, '=== LSP BEGIN ===\noperation: hover\n=== LSP END ==='), undefined, 'hover remains distinct from location-result parsing');
  const hoverArtifact = taskLspHoverArtifact({ operation: 'hover' }, [
    '=== LSP BEGIN ===',
    'operation: hover',
    'source: "src/hover.ts"',
    'position: 7:5',
    'provider_state: ready',
    'semantic_result_inconclusive: false',
    'content_truncated: false',
    'total_results: 2',
    'max_results: 10',
    'returned_results: 2',
    'truncated: false',
    '--- RESULTS ---',
    '--- RESULT 1 ---',
    'range: 7:1-7:12',
    '--- CONTENT BEGIN ---',
    'const hoverValue: string',
    '--- CONTENT END ---',
    '--- RESULT 2 ---',
    '--- CONTENT BEGIN ---',
    'Documentation for hoverValue.',
    '--- CONTENT END ---',
    '=== LSP END ===',
  ].join('\n'));
  assert.equal(hoverArtifact?.kind, 'report');
  assert.equal(hoverArtifact?.title, 'LSP · hover · src/hover.ts:7:5');
  assert.deepEqual(hoverArtifact?.metadata?.files, ['src/hover.ts']);
  assert.deepEqual(hoverArtifact?.metadata?.locations, [{ path: 'src/hover.ts', line: 7, column: 5, label: 'Hover source' }]);
  assert.equal(hoverArtifact?.metadata?.content, 'const hoverValue: string\n\nDocumentation for hoverValue.');
  assert.equal(hoverArtifact?.metadata?.contentTruncated, false);
  assert.equal(taskLspArtifact({ operation: 'hover' }, [
    '=== LSP BEGIN ===',
    'operation: hover',
    'source: "src/hover.ts"',
    'position: 7:5',
    'total_results: 0',
    'returned_results: 0',
    'truncated: false',
    'content_truncated: false',
    '--- RESULTS ---',
    '=== LSP END ===',
  ].join('\n'))?.kind, 'report', 'generic LSP artifact routing must include hover reports');

  const hoverPresentation = presentTaskSessionArtifacts({
    ...detail,
    artifacts: [{
      artifactId: 'hover',
      kind: 'report',
      title: 'Hover content',
      createdAt: '2026-09-13T08:04:25.000Z',
      metadata: { files: ['src/hover.ts'], locations: [{ path: 'src/hover.ts', line: 7, column: 5, label: 'Hover source' }], content: 'type Hover = string;', contentTruncated: true },
    }],
  })[0];
  assert.equal(hoverPresentation.content, 'type Hover = string;');
  assert.equal(hoverPresentation.contentTruncated, true);
  assert.deepEqual(hoverPresentation.locations, [{ path: 'src/hover.ts', line: 7, column: 5, label: 'Hover source' }]);

  const directoryArtifact = taskDirectoryArtifact({ path: 'src', depth: 2 }, [
    '=== LIST_DIRECTORY BEGIN ===',
    'path: "src"',
    'depth: 2',
    'include_hidden: false',
    'no_ignore: false',
    'returned_entries: 4',
    'truncated: true',
    '--- ENTRIES ---',
    '[DIR] src/empty',
    '[DIR] src/lib',
    '[FILE] src/lib/index.ts',
    '[LINK] src/current.ts',
    '=== LIST_DIRECTORY END ===',
  ].join('\n'));
  assert.equal(directoryArtifact?.kind, 'report');
  assert.equal(directoryArtifact?.title, 'Explored src');
  assert.deepEqual(directoryArtifact?.metadata?.entries, [
    { path: 'src/empty', kind: 'folder' },
    { path: 'src/lib', kind: 'folder' },
    { path: 'src/lib/index.ts', kind: 'file' },
    { path: 'src/current.ts', kind: 'link' },
  ]);
  assert.equal(directoryArtifact?.metadata?.entryCount, 4);
  assert.equal(directoryArtifact?.metadata?.resultTruncated, true);
  assert.deepEqual(buildTaskSessionEntryTree(directoryArtifact?.metadata?.entries ?? []), [
    { name: 'src', children: [
      { name: 'current.ts' },
      { name: 'empty', children: [] },
      { name: 'lib', children: [{ name: 'index.ts' }] },
    ] },
  ], 'directory entry trees must preserve empty-folder semantics with children: []');

  const terminalArtifact = taskTerminalArtifact('run_command', { command: 'npm test', cwd: '.', background: false }, [
    '=== RUN_COMMAND BEGIN ===',
    'command_id: cmd_test_1',
    'terminal_id: terminal-1',
    'terminal_name: "ShunCode · 1"',
    'execution: pty',
    'status: completed',
    'exit_code: 0',
    'cwd: "."',
    'background: false',
    'next_offset: 8',
    'total_output_bytes: 8',
    'output_lost: false',
    '--- OUTPUT BEGIN ---',
    'tests ok',
    '--- OUTPUT END ---',
    '=== RUN_COMMAND END ===',
  ].join('\n'));
  assert.equal(terminalArtifact?.kind, 'terminal');
  assert.equal(terminalArtifact?.metadata?.command, 'npm test');
  assert.equal(terminalArtifact?.metadata?.terminalOpenable, true);
  assert.equal(terminalArtifact?.metadata?.content, 'tests ok');
  assert.equal(terminalArtifact?.metadata?.contentLanguage, 'text');
  const directTerminalArtifact = taskTerminalArtifact('run_command', { command: 'npm test', background: false }, [
    '=== RUN_COMMAND BEGIN ===',
    'command_id: cmd_direct_1',
    'terminal_id: direct',
    'terminal_name: "direct"',
    'execution: direct',
    'status: completed',
    'exit_code: 0',
    '--- OUTPUT BEGIN ---',
    'done',
    '--- OUTPUT END ---',
    '=== RUN_COMMAND END ===',
  ].join('\n'));
  assert.equal(directTerminalArtifact?.metadata?.terminalOpenable, false, 'direct execution must not expose a fake terminal action');
  const sentInputArtifact = taskTerminalArtifact('send_command_input', { command_id: 'cmd_test_1', input: 'SUPER_SECRET_INPUT' }, [
    '=== SEND_COMMAND_INPUT BEGIN ===',
    'command_id: cmd_test_1',
    'terminal_id: terminal-1',
    'status: running',
    'bytes_sent: 18',
    'append_newline: true',
    '=== SEND_COMMAND_INPUT END ===',
  ].join('\n'));
  assert.equal(sentInputArtifact?.metadata?.bytesSent, 18);
  assert.doesNotMatch(JSON.stringify(sentInputArtifact), /SUPER_SECRET_INPUT/, 'interactive input text must never be copied into durable Task artifacts');

  const terminalPresentation = presentTaskSessionArtifacts({
    ...detail,
    artifacts: [{ artifactId: 'terminal', kind: 'terminal', title: terminalArtifact?.title ?? 'Terminal', createdAt: '2026-09-13T08:05:00.000Z', metadata: terminalArtifact?.metadata }],
  })[0];
  assert.equal(terminalPresentation.terminal?.terminalId, 'terminal-1');
  assert.equal(terminalPresentation.terminal?.openable, true);
  assert.equal(terminalPresentation.terminal?.command, 'npm test');

  const markdown = formatTaskSessionMarkdown(detail);
  assert.match(markdown, /\*\*Project:\*\* project-a/);
  assert.match(markdown, /\*\*Mission:\*\* task-a · practice · implementation/);
  assert.match(markdown, /\*\*Mission role:\*\* root/);
  assert.match(markdown, /### Todos/);
  assert.match(markdown, /### AI Workers/);
  assert.match(markdown, /### Timeline/);
  assert.match(markdown, /### Artifacts/);
  assert.match(markdown, /Workspace patch\*\* · changeset · 2 files · \+10 · -2 · diff summary truncated/);
  assert.match(markdown, /Read source files\*\* · file · 1 file · results truncated/);
  assert.match(markdown, /Search needle\*\* · file · 1 file · 3 locations/);
  assert.match(markdown, /`src\/a\.ts`/);
  assert.doesNotMatch(markdown, /escape\.txt|absolute\.txt/, 'unsafe artifact paths must not reach Work Sessions markdown');
  assert.match(markdown, /read_files:\*\* succeeded · result pending delivery/, 'execution and result delivery state must remain separate in presentation');
  assert.doesNotMatch(markdown, /opaque-session-key/, 'Work Sessions presentation must not expose source session keys');
  const legacyMarkdown = formatTaskSessionMarkdown({ ...detail, summary: legacySummary });
  assert.doesNotMatch(legacyMarkdown, /\*\*Project:\*\*|\*\*Mission:\*\*/, 'legacy Tasks must not require Mission presentation fields');

  const sessionsSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'task-center-sessions.ts'), 'utf8');
  const sessionPresentationSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'task-center-session-presentation.ts'), 'utf8');
  assert.match(sessionsSource, /createChatSessionItemController\(NIMORA_TASK_SESSION_TYPE/);
  assert.match(sessionsSource, /scheme:\s*NIMORA_TASK_SESSION_TYPE,\s*path:\s*`\/\$\{encodeURIComponent\(taskId\)\}`/, 'Work Sessions resource identity must remain nimora-task:/<taskId>');
  assert.ok((sessionsSource.match(/readProjectMissionPresentation\(projectMissionPresentationOwners\)/g) ?? []).length >= 2, 'both native item refresh and opened content must reconstruct from canonical Project/Mission owners');
  assert.match(sessionsSource, /presentProjectMissionSession\(summary, semanticProjection, mission\)/, 'Mission item semantics must consume accepted WO#1 projection');
  assert.match(sessionsSource, /formatProjectMissionSessionMarkdown\(detail, semanticProjection, mission\)/, 'opened Mission content must consume accepted WO#1 projection');
  assert.match(sessionsSource, /nimoraProjectId:\s*mission\.projectId/);
  assert.match(sessionsSource, /nimoraMissionId:\s*mission\.missionId/);
  assert.match(sessionsSource, /missionPlane:\s*mission\.plane/);
  assert.match(sessionsSource, /missionType:\s*mission\.missionType/);
  assert.doesNotMatch(sessionsSource, /transcript/i, 'Work Sessions Mission identity must not depend on transcript persistence');
  assert.doesNotMatch(sessionsSource, /item\.parent|parentSession|childSessions|groupByRepository|repositoryGrouping/, 'native flat Work Sessions must not invent provider Project hierarchy/grouping metadata');
  assert.doesNotMatch(sessionsSource, /item\.archived\s*=/, 'host archived preference must remain distinct from Mission archived lifecycle truth');
  assert.doesNotMatch(sessionsSource, /new ProjectStore\(|new MissionCollaborationStore\(|new TaskRuntime\(/, 'Work Sessions must not create duplicate canonical owners');
  assert.doesNotMatch(sessionsSource, /Webview/i, 'WO#2 must stay on native Sessions primitives');
  assert.match(sessionPresentationSource, /for \(const answer of problem\.answers\.slice/, 'native formatter must consume accepted structured Answer presentation');
  assert.doesNotMatch(sessionPresentationSource, /new Map\(project\.exchanges/, 'native formatter must not reconstruct Answer Evidence ownership from raw exchanges');
  assert.match(sessionsSource, /registerChatSessionContentProvider\(/);
  assert.match(sessionsSource, /artifact\.kind === "changeset" \|\| artifact\.kind === "file"/, 'changeset and durable file-navigation artifacts must share native file-tree presentation');
  assert.match(sessionsSource, /new vscode\.ChatResponseFileTreePart\(/, 'workspace file artifacts must use the native file-tree presentation');
  assert.match(sessionsSource, /buildTaskSessionEntryTree\(artifact\.entries\)/, 'directory artifacts must use the native file tree while preserving folder nodes');
  assert.match(sessionsSource, /new vscode\.Location\(fileUri, position\)/, 'search artifacts must preserve line-level locations with native Location anchors');
  assert.match(sessionsSource, /new vscode\.ChatResponseAnchorPart\(target,/, 'search locations must render as native anchors');
  assert.match(sessionsSource, /markdown\.appendCodeblock\(artifact\.content, artifact\.contentLanguage\)/, 'durable report/changeset content must render as a bounded native markdown code block');
  assert.match(sessionsSource, /MANAGED_TERMINAL_OPEN_COMMAND/);
  assert.match(sessionsSource, /markdown\.isTrusted = \{ enabledCommands: \[MANAGED_TERMINAL_OPEN_COMMAND\] \}/, 'managed terminal links must trust only the exact first-party command');
  assert.match(sessionsSource, /terminal\.openable && terminal\.terminalId/, 'only real managed PTYs may expose an open-terminal action');
  assert.match(sessionsSource, /new vscode\.ChatResponseAnchorPart\(/, 'URI artifacts must use native anchors');
  assert.match(sessionsSource, /uri\.scheme === "http" \|\| uri\.scheme === "https"/);
  assert.match(sessionsSource, /uri\.scheme !== "file" \|\| !workspace/, 'file anchors require a workspace containment check');
  assert.match(sessionsSource, /requestHandler:\s*mission && !mission\.finalized/, 'only active canonical Missions may expose native continuation input');
  assert.match(sessionsSource, /missionEntry\(\{ \.\.\.request, sessionResource: resource \}, chatContext, stream, requestToken\)/, 'Mission continuation must be pinned to the exact opened nimora-task resource');
  assert.match(sessionsSource, /:\s*undefined,\s*\n\s*\};/, 'legacy Tasks and finalized Missions must remain read-only projections');
  assert.doesNotMatch(sessionsSource, /composition\.userEntry|new ProjectStore\(|new MissionCollaborationStore\(|new TaskRuntime\(/, 'Work Sessions must delegate through Mission ingress instead of becoming a Task/Mission owner');
  assert.match(sessionsSource, /taskShadow\.onDidChangeTask/, 'native Work Sessions must refresh from Task owner changes');

  const extensionSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'extension.ts'), 'utf8');
  assert.match(extensionSource, /const missionEntry = createMissionNativeChatEntry\(/, 'ordinary Chat and Work Sessions must share one Mission ingress closure');
  assert.match(extensionSource, /registerTaskCenterSessions\(context, taskShadow, projectMissionPresentationOwners, participant, missionEntry, SHUNCODE_PARTICIPANT_ID, output\)/, 'Work Sessions must receive the canonical Project/Mission projection plus shared Mission ingress seam');
  assert.match(extensionSource, /registerCommand\("shuncode\.taskCenter\.open"[\s\S]{0,200}workbench\.action\.chat\.history/);
  assert.match(extensionSource, /registerCommand\(MANAGED_TERMINAL_OPEN_COMMAND/);
  assert.doesNotMatch(extensionSource, /registerCommand\("shuncode\.bridge\.openTerminal"/, 'managed terminal reveal must no longer be owned by Bridge UI');

  const taskShadowSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'task-shadow.ts'), 'utf8');
  assert.match(taskShadowSource, /recordChangeset[\s\S]{0,500}taskChangesetArtifact\(structuredContent\)[\s\S]{0,500}recordArtifact/, 'changesets must be recorded through their exact extracted artifact projection');
  const changesetSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'task-changeset-artifacts.ts'), 'utf8');
  assert.match(changesetSource, /MAX_CHANGESET_CONTENT_CHARS\s*=\s*24_000/, 'changeset preview must remain bounded');
  assert.match(changesetSource, /contentLanguage:\s*content \? "diff"/, 'durable changeset must preserve diff-language presentation');
  assert.match(changesetSource, /contentTruncated:\s*row\.diff_truncated === true \|\| rawDiff\.length > MAX_CHANGESET_CONTENT_CHARS/, 'truncation metadata must remain truthful');
  assert.match(taskShadowSource, /recordFileNavigationArtifact[\s\S]{0,500}taskFileNavigationArtifact\(toolName, structuredContent\)[\s\S]{0,500}recordArtifact/);
  assert.match(taskShadowSource, /recordDiagnosticsArtifact[\s\S]{0,500}taskDiagnosticsArtifact\(args, resultText\)[\s\S]{0,500}recordArtifact/);
  assert.match(taskShadowSource, /recordDirectoryArtifact[\s\S]{0,500}taskDirectoryArtifact\(args, resultText\)[\s\S]{0,500}recordArtifact/);
  assert.match(taskShadowSource, /recordLspArtifact[\s\S]{0,500}taskLspArtifact\(args, resultText\)[\s\S]{0,500}recordArtifact/);
  assert.match(taskShadowSource, /recordTerminalArtifact[\s\S]{0,500}taskTerminalArtifact\(toolName, args, resultText\)[\s\S]{0,500}recordArtifact/);
  const bridgeSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'bridge-server.ts'), 'utf8');
  assert.match(bridgeSource, /recordFileNavigationArtifact\(execution, toolName, result\.structuredContent\)/, 'successful Bridge file navigation must be durably projected into Task artifacts');
  assert.doesNotMatch(bridgeSource, /if \(toolName === "read_files"\)/, 'read_files must no longer have a Bridge-only rich presentation branch');
  assert.doesNotMatch(bridgeSource, /if \(toolName === "find_files"\)/, 'find_files must no longer have a Bridge-only rich presentation branch');
  assert.doesNotMatch(bridgeSource, /if \(toolName === "search_files"\)/, 'search_files must no longer have a Bridge-only rich presentation branch after native Location anchors exist');
  assert.match(bridgeSource, /toolName === "list_directory"[\s\S]{0,200}recordDirectoryArtifact\(execution, args, resultText\)/, 'successful directory exploration must be durably projected into Task artifacts');
  assert.doesNotMatch(bridgeSource, /parseListDirectoryItems\(|kind:\s*"files"/, 'list_directory must no longer have a Bridge-only rich presentation branch');
  assert.match(bridgeSource, /toolName === "get_diagnostics"[\s\S]{0,200}recordDiagnosticsArtifact\(execution, args, resultText\)/, 'successful Bridge diagnostics must be durably projected into Task artifacts');
  assert.doesNotMatch(bridgeSource, /kind:\s*"diagnostics"|parseDiagnosticsItems\(/, 'get_diagnostics must no longer have a Bridge-only rich presentation branch');
  assert.match(bridgeSource, /toolName === "lsp"[\s\S]{0,200}recordLspArtifact\(execution, args, resultText\)/, 'successful Bridge LSP calls must be durably projected into Task artifacts');
  assert.doesNotMatch(bridgeSource, /parseLspItems\(|kind:\s*"symbol"/, 'LSP location operations must no longer depend on Bridge-only symbol item parsing');
  assert.doesNotMatch(bridgeSource, /kind:\s*"lsp"|toolName === "lsp" && args\.operation === "hover"/, 'hover content must no longer require a Bridge-only rich presentation kind');
  assert.doesNotMatch(bridgeSource, /parseUnifiedDiffPreview|diffPreview|kind:\s*"edit"/, 'apply_patch must no longer depend on Bridge-only mini-diff parsing or presentation');
  assert.match(bridgeSource, /toolName === "run_command" \|\| toolName === "get_command_output" \|\| toolName === "send_command_input"[\s\S]{0,160}recordTerminalArtifact\(execution, toolName, args, resultText\)/, 'successful terminal tools must be durably projected into Task artifacts');
  assert.doesNotMatch(bridgeSource, /kind:\s*"terminal"|terminalId|parseUnifiedDiffPreview/, 'Bridge presentation must no longer own terminal or diff-specific rich state');
  const bridgeSessionPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'chat', 'browser', 'widgetHosts', 'viewPane', 'shunCodeBridgeSessionView.ts');
  const bridgeSessionCssPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'chat', 'browser', 'widgetHosts', 'viewPane', 'media', 'shunCodeBridgeSessionView.css');
  await assert.rejects(fs.access(bridgeSessionPath), { code: 'ENOENT' }, 'legacy Bridge Session source must be deleted after terminal migration');
  await assert.rejects(fs.access(bridgeSessionCssPath), { code: 'ENOENT' }, 'legacy Bridge Session CSS must be deleted after terminal migration');
  const chatViewSource = await fs.readFile(path.join(root, 'src', 'vs', 'workbench', 'contrib', 'chat', 'browser', 'widgetHosts', 'viewPane', 'chatViewPane.ts'), 'utf8');
  assert.doesNotMatch(chatViewSource, /ShunCodeBridgeSessionView|bridgeMode|shuncode-bridge-mode|_shuncode\.bridge\.showSession|_shuncode\.bridge\.showChat/, 'ChatViewPane must return to a single native Chat surface');

  const extensionPackage = JSON.parse(await fs.readFile(path.join(root, 'extensions', 'shuncode', 'package.json'), 'utf8'));
  assert.ok(extensionPackage.enabledApiProposals.includes('chatSessionsProvider'));
  assert.ok(extensionPackage.activationEvents.includes('onCommand:shuncode.taskCenter.open'));
  const contribution = extensionPackage.contributes.chatSessions.find((item: { type: string }) => item.type === 'nimora-task');
  assert.ok(contribution);
  assert.equal(contribution.displayName, 'Nimora Work Sessions');
  assert.equal(contribution.canDelegate, false, 'Task projection must not masquerade as an AI provider');
  assert.ok(extensionPackage.contributes.commands.some((item: { command: string; title: string }) => item.command === 'shuncode.taskCenter.open' && item.title === 'Nimora: Open Work Sessions'));

  const tsconfig = JSON.parse(await fs.readFile(path.join(root, 'extensions', 'shuncode', 'tsconfig.json'), 'utf8'));
  assert.ok(tsconfig.files.includes('../../src/vscode-dts/vscode.proposed.chatSessionsProvider.d.ts'));
  assert.ok(tsconfig.files.includes('src/task-center-sessions.ts'));
  assert.ok(tsconfig.files.includes('src/task-center-session-presentation.ts'));

  console.log('[smoke] Task-owned native Work Sessions projection contract ok');
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
