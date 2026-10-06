import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-collaboration-task-'));
const projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-collaboration-project-'));
const collaborationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-collaboration-store-'));
const blockedDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-collaboration-blocked-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-collaboration-bundle-'));
const bundlePath = path.join(bundleDirectory, 'mission-collaboration-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { ProjectStore } from './src/project-store.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
      export { MissionCollaborationStore, MISSION_COLLABORATION_JOURNAL } from './src/mission-collaboration-store.ts';
    `,
    resolveDir: root,
    sourcefile: 'mission-collaboration-smoke-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});

const { ProjectStore, TaskRuntime, MissionCollaborationStore, MISSION_COLLABORATION_JOURNAL } = require(bundlePath);

let id = 0;
const newId = () => `phase3-id-${++id}`;
let tick = 0;
const now = () => new Date(Date.UTC(2026, 8, 15, 5, 0, tick++));

const legacyEvent = {
  version: 1,
  eventId: 'legacy-task-created',
  taskId: 'legacy-task',
  at: '2026-09-12T00:00:00.000Z',
  type: 'TaskCreated',
  payload: { source: { kind: 'bridge', key: 'legacy-pre-mission' }, goal: 'Legacy Task' },
};
const legacyJournal = path.join(taskDirectory, 'legacy-task.jsonl');
const legacyJournalText = `${JSON.stringify(legacyEvent)}\n`;

async function configureRoot(tasks, projectId, key, plane, missionType) {
  const task = await tasks.ensureTask({ kind: 'bridge', key }, `${missionType} goal`);
  await tasks.configureMission(task.taskId, {
    projectId,
    rootMissionId: task.taskId,
    plane,
    missionType,
    completionCriteria: [`${missionType} complete`],
  });
  return tasks.getTask(task.taskId);
}

try {
  await fs.writeFile(legacyJournal, legacyJournalText, 'utf8');
  const projects = new ProjectStore({ storageDirectory: projectDirectory, newId, now });
  const tasks = new TaskRuntime({ storageDirectory: taskDirectory, newId, now });
  await Promise.all([projects.initialize(), tasks.initialize()]);
  assert.equal(tasks.getTask('legacy-task')?.mission, undefined);

  const projectP = await projects.createProject({ title: 'Phase 3 P' });
  const projectQ = await projects.createProject({ title: 'Phase 3 Q' });
  const practiceB = await configureRoot(tasks, projectP.projectId, 'practice-b', 'practice', 'phase3-practice');
  const practiceQ = await configureRoot(tasks, projectQ.projectId, 'practice-q', 'practice', 'other-project-practice');
  const cognitionQ = await configureRoot(tasks, projectQ.projectId, 'cognition-q', 'cognition', 'other-project-cognition');
  const ordinaryTask = await tasks.ensureTask({ kind: 'bridge', key: 'ordinary-task' }, 'Not a Mission');

  const child = await tasks.ensureTask({ kind: 'bridge', key: 'practice-child' }, 'Child Mission');
  await tasks.configureMission(child.taskId, {
    projectId: projectP.projectId,
    rootMissionId: practiceB.taskId,
    parentMissionId: practiceB.taskId,
    plane: 'practice',
    missionType: 'child-practice',
    completionCriteria: ['Derived parent relation visible'],
  });

  const artifact = await tasks.recordArtifact(practiceB.taskId, {
    artifactId: 'artifact-evidence-1',
    kind: 'report',
    title: 'Observed runtime evidence',
    uri: 'file:///phase3-evidence.txt',
  });
  const projectQArtifact = await tasks.recordArtifact(practiceQ.taskId, {
    artifactId: 'artifact-project-q',
    kind: 'report',
    title: 'Other Project evidence artifact',
    uri: 'file:///phase3-project-q-evidence.txt',
  });

  const store = new MissionCollaborationStore({
    storageDirectory: collaborationDirectory,
    projects,
    tasks,
    now,
  });
  await store.initialize();

  const e1Input = {
    exchangeId: 'evidence-e1',
    projectId: projectP.projectId,
    sourceMissionId: practiceB.taskId,
    kind: 'Evidence',
    payload: {
      summary: 'Practice observed a repository fact that invalidates the assumption.',
      references: [
        { type: 'artifact', missionId: practiceB.taskId, artifactId: artifact.artifactId },
        { type: 'file', path: 'src/task-runtime.ts', detail: 'Current Mission source of truth' },
        { type: 'url', url: 'https://example.com/evidence', detail: 'Bounded external reference' },
        { type: 'command', command: 'npm run test-shuncode-project-mission', observation: 'PASS' },
      ],
    },
  };
  const e1 = await store.recordExchange(e1Input);
  assert.equal(e1.kind, 'Evidence');
  const journalPath = path.join(collaborationDirectory, MISSION_COLLABORATION_JOURNAL);
  const linesAfterE1 = (await fs.readFile(journalPath, 'utf8')).trim().split(/\r?\n/).length;
  assert.deepEqual(await store.recordExchange(e1Input), e1, 'same exchange id + same canonical content must be idempotent');
  assert.equal((await fs.readFile(journalPath, 'utf8')).trim().split(/\r?\n/).length, linesAfterE1, 'idempotent exchange retry must not append');
  await assert.rejects(
    () => store.recordExchange({ ...e1Input, payload: { ...e1Input.payload, summary: 'different' } }),
    /Exchange identity collision/,
  );

  const problemInput = {
    exchangeId: 'problem-p1',
    projectId: projectP.projectId,
    sourceMissionId: practiceB.taskId,
    kind: 'Problem',
    payload: {
      currentGoal: 'Implement Phase 3 collaboration substrate.',
      previousAssumption: 'The previous architecture assumption is sufficient.',
      observedReality: 'Practice evidence shows a precise mismatch requiring cognition.',
      preciseQuestion: 'What bounded updated understanding should Practice use?',
      blocking: true,
      evidenceExchangeIds: [e1.exchangeId],
    },
  };
  const p1 = await store.recordExchange(problemInput);
  assert.equal(p1.targetMissionId, undefined, 'Problem may be durable before Cognition Mission exists or is targeted');

  const cognitionC = await configureRoot(tasks, projectP.projectId, 'cognition-c', 'cognition', 'phase3-cognition');
  const cognitionD = await configureRoot(tasks, projectP.projectId, 'cognition-d', 'cognition', 'phase3-cognition-secondary');

  const spawnedInput = {
    relationId: 'relation-spawned-c-b',
    projectId: projectP.projectId,
    sourceMissionId: cognitionC.taskId,
    targetMissionId: practiceB.taskId,
    type: 'spawned_by',
    basisExchangeId: p1.exchangeId,
  };
  const spawned = await store.recordRelation(spawnedInput);
  assert.equal(spawned.type, 'spawned_by');
  const linesAfterSpawn = (await fs.readFile(journalPath, 'utf8')).trim().split(/\r?\n/).length;
  assert.deepEqual(await store.recordRelation(spawnedInput), spawned, 'same relation id + same canonical content must be idempotent');
  assert.equal((await fs.readFile(journalPath, 'utf8')).trim().split(/\r?\n/).length, linesAfterSpawn, 'idempotent relation retry must not append');
  await assert.rejects(
    () => store.recordRelation({ ...spawnedInput, type: 'informs' }),
    /Relation identity collision/,
  );

  const answerInput = {
    exchangeId: 'answer-a1',
    projectId: projectP.projectId,
    sourceMissionId: cognitionC.taskId,
    targetMissionId: practiceB.taskId,
    kind: 'Answer',
    replyToExchangeId: p1.exchangeId,
    payload: {
      answer: 'Use the durable collaboration journal and keep Project→Mission membership in TaskSnapshot.mission only.',
      evidenceExchangeIds: [e1.exchangeId],
      limitations: 'Automatic feedback orchestration remains Phase 4.',
    },
  };
  const a1 = await store.recordExchange(answerInput);
  assert.equal(a1.targetMissionId, practiceB.taskId);
  assert.equal(a1.replyToExchangeId, p1.exchangeId);
  const answersRelation = await store.recordRelation({
    relationId: 'relation-answers-c-b',
    projectId: projectP.projectId,
    sourceMissionId: cognitionC.taskId,
    targetMissionId: practiceB.taskId,
    type: 'answers',
    basisExchangeId: a1.exchangeId,
  });
  assert.equal(answersRelation.type, 'answers');

  const finding = await store.recordExchange({
    exchangeId: 'finding-f1', projectId: projectP.projectId, sourceMissionId: cognitionC.taskId, targetMissionId: practiceB.taskId, kind: 'Finding',
    payload: { summary: 'Cognition distilled the bounded updated understanding.', evidenceExchangeIds: [e1.exchangeId] },
  });
  await store.recordRelation({
    relationId: 'relation-informs-c-b', projectId: projectP.projectId, sourceMissionId: cognitionC.taskId, targetMissionId: practiceB.taskId, type: 'informs', basisExchangeId: finding.exchangeId,
  });
  await store.recordRelation({
    relationId: 'relation-validates-b-c', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, targetMissionId: cognitionC.taskId, type: 'validates', basisExchangeId: e1.exchangeId,
  });
  await store.recordRelation({
    relationId: 'relation-blocks-b-c', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, targetMissionId: cognitionC.taskId, type: 'blocks',
  });

  await store.recordRelation({
    relationId: 'relation-depends-b-c', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, targetMissionId: cognitionC.taskId, type: 'depends_on',
  });
  await store.recordRelation({
    relationId: 'relation-depends-c-b', projectId: projectP.projectId, sourceMissionId: cognitionC.taskId, targetMissionId: practiceB.taskId, type: 'depends_on',
  });
  assert.equal(
    store.listRelations(projectP.projectId).filter(relation => relation.type === 'depends_on').length,
    2,
    'descriptive relation cycles are allowed',
  );

  const e2 = await store.recordExchange({
    exchangeId: 'evidence-e2', projectId: projectP.projectId, sourceMissionId: cognitionC.taskId, kind: 'Evidence',
    payload: { summary: 'Cognition evidence for cycle test.', references: [{ type: 'file', path: 'docs/architecture/MISSION_WORK_ARCHITECTURE.md' }] },
  });
  const p2 = await store.recordExchange({
    exchangeId: 'problem-p2', projectId: projectP.projectId, sourceMissionId: cognitionC.taskId, kind: 'Problem',
    payload: { currentGoal: 'Cycle test', previousAssumption: 'No cycle', observedReality: 'Need reverse provenance edge test', preciseQuestion: 'Would this create a cycle?', blocking: false, evidenceExchangeIds: [e2.exchangeId] },
  });
  await assert.rejects(
    () => store.recordRelation({
      relationId: 'relation-spawned-b-c-cycle', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, targetMissionId: cognitionC.taskId, type: 'spawned_by', basisExchangeId: p2.exchangeId,
    }),
    /spawned_by relation would create a cycle/,
  );

  await store.recordRelation({
    relationId: 'relation-supersedes-c-d', projectId: projectP.projectId, sourceMissionId: cognitionC.taskId, targetMissionId: cognitionD.taskId, type: 'supersedes',
  });
  await assert.rejects(
    () => store.recordRelation({
      relationId: 'relation-supersedes-d-c', projectId: projectP.projectId, sourceMissionId: cognitionD.taskId, targetMissionId: cognitionC.taskId, type: 'supersedes',
    }),
    /supersedes relation would create a cycle/,
  );
  assert.deepEqual(
    new Set(store.listRelations(projectP.projectId, { includeDerivedParent: false }).map(relation => relation.type)),
    new Set(['spawned_by', 'depends_on', 'informs', 'answers', 'blocks', 'validates', 'supersedes']),
    'all Phase 3 explicit relation kinds must have a valid durable representation',
  );

  await assert.rejects(
    () => store.recordRelation({
      relationId: 'relation-self', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, targetMissionId: practiceB.taskId, type: 'blocks',
    }),
    /self-edge/,
  );
  await assert.rejects(
    () => store.recordRelation({
      relationId: 'relation-cross-project', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, targetMissionId: practiceQ.taskId, type: 'informs',
    }),
    /does not belong to Project/,
  );
  await assert.rejects(
    () => store.recordRelation({
      relationId: 'relation-unknown-project', projectId: 'missing-project', sourceMissionId: practiceB.taskId, targetMissionId: cognitionC.taskId, type: 'informs',
    }),
    /Unknown Project/,
  );
  await assert.rejects(
    () => store.recordRelation({
      relationId: 'relation-non-mission', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, targetMissionId: ordinaryTask.taskId, type: 'informs',
    }),
    /not configured as a Mission/,
  );
  await assert.rejects(
    () => store.recordRelation({
      relationId: 'relation-parent-forbidden', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, targetMissionId: child.taskId, type: 'parent_of',
    }),
    /Unsupported explicit Mission relation type/,
  );
  await assert.rejects(
    () => store.recordRelation({
      relationId: 'relation-missing-basis', projectId: projectP.projectId, sourceMissionId: cognitionD.taskId, targetMissionId: practiceB.taskId, type: 'spawned_by', basisExchangeId: 'missing-problem',
    }),
    /basis exchange does not exist/,
  );
  await assert.rejects(
    () => store.recordRelation({
      relationId: 'relation-wrong-basis-kind', projectId: projectP.projectId, sourceMissionId: cognitionD.taskId, targetMissionId: practiceB.taskId, type: 'spawned_by', basisExchangeId: e1.exchangeId,
    }),
    /must reference a Problem/,
  );

  const qEvidence = await store.recordExchange({
    exchangeId: 'evidence-q1', projectId: projectQ.projectId, sourceMissionId: practiceQ.taskId, kind: 'Evidence',
    payload: { summary: 'Other Project evidence.', references: [{ type: 'file', path: 'other-project.txt' }] },
  });
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'evidence-unknown-project', projectId: 'missing-project', sourceMissionId: practiceB.taskId, kind: 'Evidence',
      payload: { summary: 'Unknown Project must fail closed.', references: [{ type: 'file', path: 'missing-project.txt' }] },
    }),
    /Unknown Project/,
  );
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'problem-wrong-evidence-project', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, kind: 'Problem',
      payload: { currentGoal: 'x', previousAssumption: 'x', observedReality: 'x', preciseQuestion: 'x?', blocking: true, evidenceExchangeIds: [qEvidence.exchangeId] },
    }),
    /cannot cross Projects/,
  );
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'problem-wrong-evidence-kind', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, kind: 'Problem',
      payload: { currentGoal: 'x', previousAssumption: 'x', observedReality: 'x', preciseQuestion: 'x?', blocking: true, evidenceExchangeIds: [p1.exchangeId] },
    }),
    /must reference Evidence exchanges/,
  );
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'problem-missing-evidence', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, kind: 'Problem',
      payload: { currentGoal: 'x', previousAssumption: 'x', observedReality: 'x', preciseQuestion: 'x?', blocking: true, evidenceExchangeIds: ['missing-evidence'] },
    }),
    /does not exist/,
  );
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'answer-non-problem', projectId: projectP.projectId, sourceMissionId: cognitionC.taskId, targetMissionId: practiceB.taskId, kind: 'Answer', replyToExchangeId: e1.exchangeId,
      payload: { answer: 'invalid', evidenceExchangeIds: [] },
    }),
    /must reference a Problem/,
  );
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'answer-cross-project-reply', projectId: projectQ.projectId, sourceMissionId: cognitionQ.taskId, targetMissionId: practiceQ.taskId, kind: 'Answer', replyToExchangeId: p1.exchangeId,
      payload: { answer: 'invalid cross-project reply', evidenceExchangeIds: [qEvidence.exchangeId] },
    }),
    /cannot reply across Projects/,
  );
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'exchange-cross-project-route', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, targetMissionId: practiceQ.taskId, kind: 'Finding',
      payload: { summary: 'invalid route', evidenceExchangeIds: [] },
    }),
    /does not belong to Project/,
  );
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'exchange-non-mission', projectId: projectP.projectId, sourceMissionId: ordinaryTask.taskId, kind: 'Evidence',
      payload: { summary: 'invalid endpoint', references: [{ type: 'file', path: 'x' }] },
    }),
    /not configured as a Mission/,
  );
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'exchange-unbounded', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, kind: 'Evidence',
      payload: { summary: 'x'.repeat(6_001), references: [{ type: 'file', path: 'x' }] },
    }),
    /at most 6000 characters/,
  );
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'evidence-missing-artifact', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, kind: 'Evidence',
      payload: { summary: 'Missing artifact must fail closed.', references: [{ type: 'artifact', missionId: practiceB.taskId, artifactId: 'missing-artifact' }] },
    }),
    /Evidence artifact does not exist uniquely/,
  );
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'evidence-cross-project-artifact', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, kind: 'Evidence',
      payload: { summary: 'Cross-Project artifact ownership must fail closed.', references: [{ type: 'artifact', missionId: practiceQ.taskId, artifactId: projectQArtifact.artifactId }] },
    }),
    /does not belong to Project/,
  );
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'evidence-too-many-references', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, kind: 'Evidence',
      payload: { summary: 'Reference collection bounds are hard.', references: Array.from({ length: 33 }, (_, index) => ({ type: 'file', path: `ref-${index}.txt` })) },
    }),
    /Evidence references must contain at most 32 items/,
  );
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'evidence-oversized-reference-path', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, kind: 'Evidence',
      payload: { summary: 'Nested Evidence reference bounds are hard.', references: [{ type: 'file', path: 'x'.repeat(2_001) }] },
    }),
    /Evidence reference 1 path must be at most 2000 characters/,
  );
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'problem-oversized-observed-reality', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, kind: 'Problem',
      payload: { currentGoal: 'Bound Problem fields', previousAssumption: 'Within bounds', observedReality: 'x'.repeat(8_001), preciseQuestion: 'Is the bound enforced?', blocking: true, evidenceExchangeIds: [e1.exchangeId] },
    }),
    /Problem observedReality must be at most 8000 characters/,
  );

  const handoffMission = await configureRoot(tasks, projectP.projectId, 'handoff-source', 'cognition', 'handoff-source');
  const handoffBody = 'FINAL-HANDOFF-BODY-MUST-NOT-BE-DUPLICATED-IN-COLLABORATION-JOURNAL';
  await tasks.finalizeMissionStrict(handoffMission.taskId, {
    handoffRequired: true,
    handoff: { kind: 'report', title: 'Mission final Handoff', metadata: { content: handoffBody } },
  });
  const handoffSnapshot = tasks.getTask(handoffMission.taskId);
  const handoffArtifact = handoffSnapshot.artifacts.find(candidate => candidate.artifactId === handoffSnapshot.missionFinalization.handoffArtifactId);
  const handoffPayload = {
    artifactId: handoffArtifact.artifactId,
    sourceTaskEventId: handoffSnapshot.missionFinalization.handoffSourceEventId,
    sourceTaskEventCount: handoffSnapshot.missionFinalization.handoffSourceEventCount,
    contentDigest: handoffSnapshot.missionFinalization.handoffContentDigest,
  };
  const handoffExchange = await store.recordExchange({
    exchangeId: 'handoff-h1', projectId: projectP.projectId, sourceMissionId: handoffMission.taskId, targetMissionId: practiceB.taskId, kind: 'Handoff', payload: handoffPayload,
  });
  assert.deepEqual(handoffExchange.payload, handoffPayload);
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'handoff-wrong-artifact', projectId: projectP.projectId, sourceMissionId: handoffMission.taskId, targetMissionId: practiceB.taskId, kind: 'Handoff', payload: { ...handoffPayload, artifactId: 'wrong' },
    }),
    /artifactId does not match/,
  );
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'handoff-wrong-mission', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, targetMissionId: cognitionC.taskId, kind: 'Handoff', payload: handoffPayload,
    }),
    /has no verified final Handoff/,
  );
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'handoff-wrong-project', projectId: projectP.projectId, sourceMissionId: handoffMission.taskId, targetMissionId: practiceQ.taskId, kind: 'Handoff', payload: handoffPayload,
    }),
    /does not belong to Project/,
  );
  await assert.rejects(
    () => store.recordExchange({
      exchangeId: 'handoff-body-forbidden', projectId: projectP.projectId, sourceMissionId: handoffMission.taskId, targetMissionId: practiceB.taskId, kind: 'Handoff', payload: { ...handoffPayload, body: handoffBody },
    }),
    /unsupported field: body/,
  );
  assert.doesNotMatch(await fs.readFile(journalPath, 'utf8'), new RegExp(handoffBody), 'collaboration journal must store only Handoff identity/reference, never the Handoff body');

  const derivedParent = store.listRelations(projectP.projectId).find(relation => relation.type === 'parent_of' && relation.targetMissionId === child.taskId);
  assert.ok(derivedParent);
  assert.equal(derivedParent.sourceMissionId, practiceB.taskId);
  assert.equal(derivedParent.derived, true);
  assert.doesNotMatch(await fs.readFile(journalPath, 'utf8'), /"type":"parent_of"/, 'parent_of must never be persisted as a duplicate graph truth');

  const projectJournalPath = path.join(projectDirectory, 'projects-v1.jsonl');
  const projectJournalBeforeRestart = await fs.readFile(projectJournalPath, 'utf8');
  const legacyBeforeRestart = await fs.readFile(legacyJournal, 'utf8');

  const forgedCrossProjectRelation = {
    version: 1,
    recordType: 'relation',
    record: {
      relationId: 'forged-cross-project-replay', projectId: projectP.projectId,
      sourceMissionId: practiceB.taskId, targetMissionId: practiceQ.taskId,
      type: 'informs', createdAt: '2026-09-15T06:00:00.000Z',
    },
  };
  const forgedAnswer = {
    version: 1,
    recordType: 'exchange',
    record: {
      exchangeId: 'forged-answer-replay', projectId: projectP.projectId,
      sourceMissionId: cognitionC.taskId, targetMissionId: practiceB.taskId,
      kind: 'Answer', createdAt: '2026-09-15T06:00:01.000Z', replyToExchangeId: e1.exchangeId,
      payload: { answer: 'forged', evidenceExchangeIds: [] },
    },
  };
  const forgedCollision = {
    version: 1,
    recordType: 'exchange',
    record: {
      ...e1,
      payload: { ...e1.payload, summary: 'forged collision content' },
    },
  };
  const outOfOrderAnswer = {
    version: 1,
    recordType: 'exchange',
    record: {
      exchangeId: 'out-of-order-answer', projectId: projectP.projectId,
      sourceMissionId: cognitionD.taskId, targetMissionId: practiceB.taskId,
      kind: 'Answer', createdAt: '2026-09-15T06:00:02.000Z', replyToExchangeId: 'out-of-order-problem',
      payload: { answer: 'This row is only legal after its Problem exists.', evidenceExchangeIds: [e1.exchangeId] },
    },
  };
  const outOfOrderProblem = {
    version: 1,
    recordType: 'exchange',
    record: {
      exchangeId: 'out-of-order-problem', projectId: projectP.projectId,
      sourceMissionId: practiceB.taskId, targetMissionId: cognitionD.taskId,
      kind: 'Problem', createdAt: '2026-09-15T06:00:03.000Z',
      payload: {
        currentGoal: 'Prove replay does not defer dependency validation.',
        previousAssumption: 'A later dependency might retroactively validate an earlier row.',
        observedReality: 'Replay must validate each row against state visible at that exact journal position.',
        preciseQuestion: 'Does the earlier Answer stay rejected after this Problem appears?',
        blocking: false,
        evidenceExchangeIds: [e1.exchangeId],
      },
    },
  };
  const forgedSelectiveCycle = {
    version: 1,
    recordType: 'relation',
    record: {
      relationId: 'forged-supersedes-cycle-replay', projectId: projectP.projectId,
      sourceMissionId: cognitionD.taskId, targetMissionId: cognitionC.taskId,
      type: 'supersedes', createdAt: '2026-09-15T06:00:04.000Z',
    },
  };
  const forgedHandoffMismatch = {
    version: 1,
    recordType: 'exchange',
    record: {
      exchangeId: 'forged-handoff-mismatch-replay', projectId: projectP.projectId,
      sourceMissionId: handoffMission.taskId, targetMissionId: practiceB.taskId,
      kind: 'Handoff', createdAt: '2026-09-15T06:00:05.000Z',
      payload: { ...handoffPayload, contentDigest: 'sha256:forged-handoff-digest' },
    },
  };
  await fs.appendFile(
    journalPath,
    `${JSON.stringify(forgedCrossProjectRelation)}\n${JSON.stringify(forgedAnswer)}\n${JSON.stringify(forgedCollision)}\n${JSON.stringify(outOfOrderAnswer)}\n${JSON.stringify(outOfOrderProblem)}\n${JSON.stringify(forgedSelectiveCycle)}\n${JSON.stringify(forgedHandoffMismatch)}\n`,
    'utf8',
  );
  await fs.appendFile(journalPath, '{"version":1,"recordType":"exchange"', 'utf8');

  const restartedProjects = new ProjectStore({ storageDirectory: projectDirectory });
  const restartedTasks = new TaskRuntime({ storageDirectory: taskDirectory });
  const replayLogs = [];
  const restartedStore = new MissionCollaborationStore({
    storageDirectory: collaborationDirectory,
    projects: restartedProjects,
    tasks: restartedTasks,
    log: message => replayLogs.push(message),
  });
  await restartedStore.initialize();

  assert.deepEqual(restartedStore.getExchange(e1.exchangeId), e1, 'exact Evidence identity must survive restart');
  assert.deepEqual(restartedStore.getExchange(p1.exchangeId), p1, 'exact Problem identity must survive restart');
  assert.deepEqual(restartedStore.getExchange(a1.exchangeId), a1, 'exact Answer identity must survive restart');
  assert.deepEqual(restartedStore.getExchange(handoffExchange.exchangeId), handoffExchange, 'exact Handoff exchange identity must survive restart');
  assert.equal(restartedStore.getExchange(handoffExchange.exchangeId).payload.artifactId, handoffPayload.artifactId);
  assert.equal(restartedStore.getExchange(handoffExchange.exchangeId).payload.sourceTaskEventId, handoffPayload.sourceTaskEventId);
  assert.equal(restartedStore.getExchange(handoffExchange.exchangeId).payload.sourceTaskEventCount, handoffPayload.sourceTaskEventCount);
  assert.equal(restartedStore.getExchange(handoffExchange.exchangeId).payload.contentDigest, handoffPayload.contentDigest);
  assert.deepEqual(restartedStore.getRelation(spawned.relationId), spawned, 'exact spawned_by relation identity must survive restart');
  assert.equal(restartedStore.getExchange(a1.exchangeId).targetMissionId, practiceB.taskId, 'Answer route back to Practice must survive restart');
  assert.equal(restartedStore.getExchange(a1.exchangeId).replyToExchangeId, p1.exchangeId, 'Problem/Answer provenance must survive restart');
  assert.equal(restartedStore.getRelation(spawned.relationId).basisExchangeId, p1.exchangeId, 'spawned_by Problem provenance must survive restart');
  assert.equal(restartedStore.getRelation('forged-cross-project-replay'), undefined, 'forged cross-Project replay row must fail closed');
  assert.equal(restartedStore.getExchange('forged-answer-replay'), undefined, 'forged invalid reply replay row must fail closed');
  assert.equal(restartedStore.getExchange(e1.exchangeId).payload.summary, e1.payload.summary, 'forged collision replay row must not replace the valid identity');
  assert.equal(restartedStore.getExchange(outOfOrderAnswer.record.exchangeId), undefined, 'out-of-order dependent Answer must fail closed when its Problem is not yet visible');
  assert.deepEqual(restartedStore.getExchange(outOfOrderProblem.record.exchangeId), outOfOrderProblem.record, 'later dependency may become visible without retroactively installing the rejected dependent row');
  assert.equal(restartedStore.getRelation(forgedSelectiveCycle.record.relationId), undefined, 'forged supersedes replay cycle must remain absent from visible graph state');
  assert.equal(restartedStore.getExchange(forgedHandoffMismatch.record.exchangeId), undefined, 'forged replay Handoff identity mismatch must fail closed');
  assert.ok(replayLogs.some(message => message.includes('ignored invalid collaboration record')), 'invalid/corrupt replay rows must be observable and ignored');
  assert.doesNotMatch(await fs.readFile(journalPath, 'utf8'), new RegExp(handoffBody), 'restart/replay must not introduce the final Handoff body into the collaboration journal');
  assert.deepEqual(await restartedStore.recordExchange(e1Input), e1, 'exchange idempotency must survive restart');
  assert.deepEqual(await restartedStore.recordRelation(spawnedInput), spawned, 'relation idempotency must survive restart');
  await assert.rejects(
    () => restartedStore.recordExchange({ ...e1Input, payload: { ...e1Input.payload, summary: 'restart collision' } }),
    /Exchange identity collision/,
    'identity collision must remain fail-closed after restart',
  );
  await assert.rejects(
    () => restartedStore.recordRelation({ ...spawnedInput, type: 'depends_on' }),
    /Relation identity collision/,
    'relation identity collision must remain fail-closed after restart',
  );
  assert.deepEqual(restartedStore.getRelation(spawned.relationId), spawned, 'failed restart relation collision must leave original durable relation unchanged');
  const explicitlyRetriedOutOfOrderAnswer = await restartedStore.recordExchange(outOfOrderAnswer.record);
  assert.deepEqual(explicitlyRetriedOutOfOrderAnswer, outOfOrderAnswer.record, 'an explicitly appended legal Answer may succeed after its dependency is visible');
  const postTorn = await restartedStore.recordExchange({
    exchangeId: 'post-torn-evidence', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, kind: 'Evidence',
    payload: { summary: 'A new legal record remains appendable after an ignored torn tail.', references: [{ type: 'file', path: 'post-torn.txt' }] },
  });
  const postTornReplay = new MissionCollaborationStore({
    storageDirectory: collaborationDirectory,
    projects: restartedProjects,
    tasks: restartedTasks,
  });
  await postTornReplay.initialize();
  assert.deepEqual(postTornReplay.getExchange(postTorn.exchangeId), postTorn, 'valid writes after a torn tail must remain replayable');
  assert.equal(await fs.readFile(projectJournalPath, 'utf8'), projectJournalBeforeRestart, 'collaboration replay must not migrate or rewrite Project journal');
  assert.equal(await fs.readFile(legacyJournal, 'utf8'), legacyBeforeRestart, 'collaboration replay must not migrate or rewrite legacy Task journal');
  assert.equal(restartedTasks.getTask('legacy-task')?.mission, undefined, 'legacy non-Mission Task replay remains intact');

  const blockedStore = new MissionCollaborationStore({ storageDirectory: blockedDirectory, projects, tasks, now });
  await blockedStore.initialize();
  await fs.rm(blockedDirectory, { recursive: true, force: true });
  await fs.writeFile(blockedDirectory, 'block collaboration persistence', 'utf8');
  await assert.rejects(
    () => blockedStore.recordExchange({
      exchangeId: 'blocked-evidence', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, kind: 'Evidence',
      payload: { summary: 'Must not become live', references: [{ type: 'file', path: 'blocked.txt' }] },
    }),
    /Mission collaboration persistence failed/,
  );
  assert.equal(blockedStore.getExchange('blocked-evidence'), undefined, 'persistence failure must not leave memory-only exchange state');
  await assert.rejects(
    () => blockedStore.recordRelation({
      relationId: 'blocked-relation', projectId: projectP.projectId, sourceMissionId: practiceB.taskId, targetMissionId: cognitionC.taskId, type: 'blocks',
    }),
    /Mission collaboration persistence failed/,
  );
  assert.equal(blockedStore.getRelation('blocked-relation'), undefined, 'persistence failure must not leave memory-only graph state');

  console.log('[smoke] Mission collaboration graph/exchanges/replay/adversarial contract ok');
} finally {
  await Promise.all([
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(projectDirectory, { recursive: true, force: true }),
    fs.rm(collaborationDirectory, { recursive: true, force: true }),
    fs.rm(blockedDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
