import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-phase5-project-'));
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-phase5-task-'));
const legacyProjectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-phase5-legacy-project-'));
const strictReplayProjectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-phase5-strict-replay-project-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-phase5-bundle-'));
const bundlePath = path.join(bundleDirectory, 'project-decision-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { ProjectStore, PROJECT_JOURNAL } from './src/project-store.ts';
      export { projectCommittedDecisionId } from './src/project-contract.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
      export { ProjectDecisionService } from './src/project-decision-service.ts';
      export { buildProjectDecisionWorkerInput } from './src/project-decision-worker-input.ts';
      export { WorkerSessionManager } from './src/worker-session-manager.ts';
      export { buildRenderedContextHandoff } from './src/context-handoff.ts';
    `,
    resolveDir: root,
    sourcefile: 'project-decision-smoke-entry.ts',
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
  PROJECT_JOURNAL,
  projectCommittedDecisionId,
  TaskRuntime,
  ProjectDecisionService,
  buildProjectDecisionWorkerInput,
  WorkerSessionManager,
  buildRenderedContextHandoff,
} = require(bundlePath);

const TRANSCRIPT_SENTINEL = 'PHASE5_FULL_DELIBERATION_TRANSCRIPT_SENTINEL_DO_NOT_PERSIST';
let projectToken = 0;
let taskToken = 0;
let tick = 0;
const newProjectToken = () => `phase5-project-token-${++projectToken}`;
const newTaskToken = () => `phase5-task-token-${++taskToken}`;
const now = () => new Date(Date.UTC(2026, 8, 15, 8, 0, tick++));

async function configureRootMission(tasks, projectId, key, missionType = key) {
  const task = await tasks.ensureTask({ kind: 'bridge', key }, `${missionType} goal`);
  await tasks.configureMission(task.taskId, {
    projectId,
    rootMissionId: task.taskId,
    plane: 'practice',
    missionType,
    completionCriteria: [`${missionType} complete`],
  });
  return tasks.getTask(task.taskId);
}

async function readProjectJournal() {
  try {
    return await fs.readFile(path.join(projectDirectory, PROJECT_JOURNAL), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function parsedProjectEvents(text) {
  return text.split(/\r?\n/).filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

async function readTaskJournals() {
  const files = (await fs.readdir(taskDirectory)).filter(file => file.endsWith('.jsonl')).sort();
  return (await Promise.all(files.map(file => fs.readFile(path.join(taskDirectory, file), 'utf8')))).join('\n');
}

class Phase5FakeAdapter {
  id = 'worker.phase5';
  nextSession = 0;
  inputs = [];

  constructor(prefix) { this.prefix = prefix; }

  async describe() {
    return {
      id: this.id,
      provider: 'phase5-fake',
      kind: 'api',
      label: 'Phase 5 deterministic fake Worker',
      availability: 'available',
      capabilities: {
        streaming: true,
        reasoning: true,
        capabilityRequests: false,
        imageInput: false,
        checkpoints: false,
        interruption: true,
        persistentContext: true,
      },
    };
  }

  async createSession(options) {
    const at = new Date().toISOString();
    return {
      sessionId: `${this.prefix}-${++this.nextSession}`,
      workerId: this.id,
      state: 'idle',
      model: options.model,
      contextHandle: options.contextHandle,
      createdAt: at,
      lastActiveAt: at,
    };
  }

  async *send(session, input) {
    session.state = 'running';
    this.inputs.push(structuredClone(input));
    try {
      yield { type: 'text_delta', inputId: input.inputId, text: 'phase5-decision-observed' };
      if (input.inputId === 'phase5-unknown-send') throw new Error('INJECTED_PHASE5_UNKNOWN_PROVIDER_SEND');
      yield { type: 'terminal', inputId: input.inputId, status: 'completed' };
    } finally {
      session.state = 'idle';
      session.lastActiveAt = new Date().toISOString();
    }
  }

  async interrupt(session) { session.state = 'interrupted'; }
  async dispose(session) { session.state = 'disposed'; }
  async health() { return { status: 'healthy', checkedAt: new Date().toISOString() }; }
}

try {
  // Legacy ProjectCreated-only journals remain replayable with empty Phase 5 governance.
  const legacyEvent = {
    version: 1,
    eventId: 'legacy-project-created',
    projectId: 'legacy-project',
    at: '2026-09-14T00:00:00.000Z',
    type: 'ProjectCreated',
    payload: { title: 'Legacy Project' },
  };
  await fs.writeFile(path.join(legacyProjectDirectory, 'projects-v1.jsonl'), `${JSON.stringify(legacyEvent)}\n`, 'utf8');
  const legacyProjects = new ProjectStore({ storageDirectory: legacyProjectDirectory });
  await legacyProjects.initialize();
  assert.deepEqual(legacyProjects.getProject('legacy-project')?.proposals, {});
  assert.deepEqual(legacyProjects.getProject('legacy-project')?.humanConfirmations, {});
  assert.deepEqual(legacyProjects.getProject('legacy-project')?.committedDecisions, {});

  // Strict replay-schema regression: malformed durable rows must never become
  // Project governance authority merely because their recognized fields are valid.
  let strictToken = 0;
  let strictTick = 0;
  const strictProjects = new ProjectStore({
    storageDirectory: strictReplayProjectDirectory,
    newId: () => `phase5-strict-token-${++strictToken}`,
    now: () => new Date(Date.UTC(2026, 8, 15, 7, 0, strictTick++)),
  });
  await strictProjects.initialize();
  const strictProject = await strictProjects.createProject({ title: 'Strict replay authority boundary' });
  const strictProposal = await strictProjects.recordProposal(strictProject.projectId, {
    proposalId: 'strict-unconfirmed-proposal',
    content: { kind: 'decision', summary: 'Must require explicit trusted-human confirmation.', scope: { kind: 'project' } },
  });
  const strictReplaceSource = await strictProjects.recordProposal(strictProject.projectId, {
    proposalId: 'strict-replace-source',
    content: { kind: 'change', summary: 'Replacement source remains active unless a canonical replacement event replays.', scope: { kind: 'project' } },
  });
  const strictDecisionSource = await strictProjects.recordProposal(strictProject.projectId, {
    proposalId: 'strict-decision-source',
    content: { kind: 'decision', summary: 'Malformed Decision rows must not become committed authority.', scope: { kind: 'project' } },
  });
  const strictDecisionConfirmation = await strictProjects.confirmProposalHuman(strictProject.projectId, {
    proposalId: strictDecisionSource.proposalId,
    contentDigest: strictDecisionSource.contentDigest,
  });
  const strictJournalPath = path.join(strictReplayProjectDirectory, PROJECT_JOURNAL);
  const strictAt = '2026-09-15T07:30:00.000Z';
  const appendStrictRow = row => fs.appendFile(strictJournalPath, `${JSON.stringify(row)}\n`, 'utf8');
  const proposalShape = (proposalId, content = strictProposal.content) => ({
    proposalId,
    contentDigest: strictProposal.contentDigest,
    content,
    proposedAt: strictAt,
  });

  // ProjectCreated: exact event envelope and exact type-specific payload.
  await appendStrictRow({
    version: 1, eventId: 'strict-created-extra-envelope', projectId: 'strict-rogue-envelope-project', at: strictAt,
    type: 'ProjectCreated', payload: { title: 'must not replay' }, unsupportedEnvelope: true,
  });
  await appendStrictRow({
    version: 1, eventId: 'strict-created-extra-payload', projectId: 'strict-rogue-payload-project', at: strictAt,
    type: 'ProjectCreated', payload: { title: 'must not replay', unsupportedPayload: true },
  });

  // ProposalRecorded: envelope, payload, nested Proposal, missing required shape,
  // and nested Proposal content are independently strict.
  await appendStrictRow({
    version: 1, eventId: 'strict-record-envelope', projectId: strictProject.projectId, at: strictAt,
    type: 'ProjectProposalRecorded', payload: { proposal: proposalShape('strict-record-envelope-proposal') }, unsupportedEnvelope: true,
  });
  await appendStrictRow({
    version: 1, eventId: 'strict-record-payload', projectId: strictProject.projectId, at: strictAt,
    type: 'ProjectProposalRecorded', payload: { proposal: proposalShape('strict-record-payload-proposal'), unsupportedPayload: true },
  });
  await appendStrictRow({
    version: 1, eventId: 'strict-record-nested', projectId: strictProject.projectId, at: strictAt,
    type: 'ProjectProposalRecorded', payload: { proposal: { ...proposalShape('strict-record-nested-proposal'), unsupportedNested: true } },
  });
  await appendStrictRow({
    version: 1, eventId: 'strict-record-missing', projectId: strictProject.projectId, at: strictAt,
    type: 'ProjectProposalRecorded', payload: {},
  });
  await appendStrictRow({
    version: 1, eventId: 'strict-record-content', projectId: strictProject.projectId, at: strictAt,
    type: 'ProjectProposalRecorded',
    payload: { proposal: proposalShape('strict-record-content-proposal', { ...strictProposal.content, transcript: 'STRICT_PROPOSAL_CONTENT_SENTINEL' }) },
  });

  // ProposalReplaced: payload and nested replacement fields cannot be normalized away.
  await appendStrictRow({
    version: 1, eventId: 'strict-replace-payload', projectId: strictProject.projectId, at: strictAt,
    type: 'ProjectProposalReplaced',
    payload: { supersededProposalId: strictReplaceSource.proposalId, replacement: proposalShape('strict-replacement-payload'), unsupportedPayload: true },
  });
  await appendStrictRow({
    version: 1, eventId: 'strict-replace-nested', projectId: strictProject.projectId, at: strictAt,
    type: 'ProjectProposalReplaced',
    payload: { supersededProposalId: strictReplaceSource.proposalId, replacement: { ...proposalShape('strict-replacement-nested'), unsupportedNested: true } },
  });

  // Mandatory verifier regression: this Proposal is real and the digest is exact,
  // but confirmProposalHuman() is NEVER called for it. The row carries unsupported
  // authority/transcript-shaped fields at every layer and therefore must be ignored.
  const MATCHING_DIGEST_REPLAY_SENTINEL = 'PHASE5_MATCHING_DIGEST_MALFORMED_CONFIRMATION_SENTINEL';
  await appendStrictRow({
    version: 1,
    eventId: 'strict-malformed-matching-digest-confirmation-all-layers',
    projectId: strictProject.projectId,
    at: strictAt,
    type: 'ProjectProposalHumanConfirmed',
    payload: {
      confirmation: {
        confirmationId: 'strict-forged-confirmation-all-layers',
        proposalId: strictProposal.proposalId,
        contentDigest: strictProposal.contentDigest,
        confirmedAt: strictAt,
        confirmed: false,
        transcript: MATCHING_DIGEST_REPLAY_SENTINEL,
        unsupportedNestedAuthority: true,
      },
      unsupportedPayloadAuthority: true,
    },
    unsupportedEnvelopeAuthority: true,
  });
  await appendStrictRow({
    version: 1, eventId: 'strict-confirm-payload', projectId: strictProject.projectId, at: strictAt,
    type: 'ProjectProposalHumanConfirmed',
    payload: {
      confirmation: { confirmationId: 'strict-forged-confirmation-payload', proposalId: strictProposal.proposalId, contentDigest: strictProposal.contentDigest, confirmedAt: strictAt },
      unsupportedPayload: true,
    },
  });
  await appendStrictRow({
    version: 1, eventId: 'strict-confirm-confirmed', projectId: strictProject.projectId, at: strictAt,
    type: 'ProjectProposalHumanConfirmed',
    payload: { confirmation: { confirmationId: 'strict-forged-confirmation-confirmed', proposalId: strictProposal.proposalId, contentDigest: strictProposal.contentDigest, confirmedAt: strictAt, confirmed: false } },
  });
  await appendStrictRow({
    version: 1, eventId: 'strict-confirm-transcript', projectId: strictProject.projectId, at: strictAt,
    type: 'ProjectProposalHumanConfirmed',
    payload: { confirmation: { confirmationId: 'strict-forged-confirmation-transcript', proposalId: strictProposal.proposalId, contentDigest: strictProposal.contentDigest, confirmedAt: strictAt, transcript: MATCHING_DIGEST_REPLAY_SENTINEL } },
  });

  // DecisionCommitted: even a fully matching, legitimately confirmed Proposal
  // cannot be committed by a row with unsupported payload/nested fields.
  const strictDecision = {
    decisionId: projectCommittedDecisionId(strictProject.projectId, strictDecisionSource.proposalId, strictDecisionSource.contentDigest),
    projectId: strictProject.projectId,
    proposalId: strictDecisionSource.proposalId,
    contentDigest: strictDecisionSource.contentDigest,
    confirmationId: strictDecisionConfirmation.confirmationId,
    content: strictDecisionSource.content,
    committedAt: strictAt,
  };
  await appendStrictRow({
    version: 1, eventId: 'strict-decision-payload', projectId: strictProject.projectId, at: strictAt,
    type: 'ProjectDecisionCommitted', payload: { decision: strictDecision, unsupportedPayload: true },
  });
  await appendStrictRow({
    version: 1, eventId: 'strict-decision-nested', projectId: strictProject.projectId, at: strictAt,
    type: 'ProjectDecisionCommitted', payload: { decision: { ...strictDecision, unsupportedNested: true } },
  });

  const strictReplayLogs = [];
  const strictReplay = new ProjectStore({ storageDirectory: strictReplayProjectDirectory, log: message => strictReplayLogs.push(message) });
  await strictReplay.initialize();
  assert.ok(strictReplay.getProject(strictProject.projectId), 'valid canonical Project rows still replay');
  assert.equal(strictReplay.getProject('strict-rogue-envelope-project'), undefined, 'extra event-envelope field must invalidate ProjectCreated');
  assert.equal(strictReplay.getProject('strict-rogue-payload-project'), undefined, 'extra ProjectCreated payload field must invalidate the row');
  for (const proposalId of [
    'strict-record-envelope-proposal',
    'strict-record-payload-proposal',
    'strict-record-nested-proposal',
    'strict-record-content-proposal',
  ]) assert.equal(strictReplay.getProposal(strictProject.projectId, proposalId), undefined, `malformed ${proposalId} must not replay`);
  assert.equal(strictReplay.getProposal(strictProject.projectId, strictReplaceSource.proposalId)?.supersededByProposalId, undefined, 'invalid replacement rows must not mutate the earlier valid Proposal');
  assert.equal(strictReplay.getProposal(strictProject.projectId, 'strict-replacement-payload'), undefined);
  assert.equal(strictReplay.getProposal(strictProject.projectId, 'strict-replacement-nested'), undefined);
  assert.equal(
    strictReplay.getHumanConfirmation(strictProject.projectId, strictProposal.proposalId),
    undefined,
    'correct-digest malformed replay confirmation must not become Human Confirmation authority',
  );
  await assert.rejects(
    () => strictReplay.commitProposal(strictProject.projectId, { proposalId: strictProposal.proposalId }),
    /lacks matching durable Human Confirmation/,
    'correct-digest malformed replay row must not authorize Commit after restart',
  );
  assert.equal(strictReplay.getDecision(strictProject.projectId, strictDecision.decisionId), undefined, 'malformed Decision rows must not become committed authority');
  assert.deepEqual(
    strictReplay.getHumanConfirmation(strictProject.projectId, strictDecisionSource.proposalId),
    strictDecisionConfirmation,
    'invalid later rows must not erase earlier valid Human Confirmation authority',
  );
  assert.match(strictReplayLogs.join('\n'), /Project event contains unsupported field: unsupportedEnvelope/);
  assert.match(strictReplayLogs.join('\n'), /ProjectProposalRecorded payload contains unsupported field: unsupportedPayload/);
  assert.match(strictReplayLogs.join('\n'), /Project Proposal contains unsupported field: unsupportedNested/);
  assert.match(strictReplayLogs.join('\n'), /Project Proposal must be an object/);
  assert.match(strictReplayLogs.join('\n'), /Project Proposal content contains unsupported field: transcript/);
  assert.match(strictReplayLogs.join('\n'), /ProjectProposalReplaced payload contains unsupported field: unsupportedPayload/);
  assert.match(strictReplayLogs.join('\n'), /ProjectProposalHumanConfirmed payload contains unsupported field: unsupportedPayload/);
  assert.match(strictReplayLogs.join('\n'), /Project Human Confirmation contains unsupported field: confirmed/);
  assert.match(strictReplayLogs.join('\n'), /Project Human Confirmation contains unsupported field: transcript/);
  assert.match(strictReplayLogs.join('\n'), /ProjectDecisionCommitted payload contains unsupported field: unsupportedPayload/);
  assert.match(strictReplayLogs.join('\n'), /Committed Project Decision contains unsupported field: unsupportedNested/);

  const strictCanonicalDecision = await strictReplay.commitProposal(strictProject.projectId, { proposalId: strictDecisionSource.proposalId });
  assert.equal(strictCanonicalDecision.decisionId, strictDecision.decisionId, 'canonical Commit remains valid after malformed replay rows are ignored');
  await strictReplay.flush();

  // Preserve torn/corrupt-tail isolation and separator recovery semantics.
  await fs.appendFile(strictJournalPath, '{"version":1,"eventId":"strict-torn-tail"', 'utf8');
  const strictAfterTorn = new ProjectStore({ storageDirectory: strictReplayProjectDirectory });
  await strictAfterTorn.initialize();
  assert.ok(strictAfterTorn.getDecision(strictProject.projectId, strictDecision.decisionId), 'torn tail must not erase earlier valid committed authority');
  const postTornProposal = await strictAfterTorn.recordProposal(strictProject.projectId, {
    proposalId: 'strict-post-torn-valid-proposal',
    content: { kind: 'change', summary: 'Valid canonical writes remain appendable after an ignored torn tail.', scope: { kind: 'project' } },
  });
  const strictAfterPostTorn = new ProjectStore({ storageDirectory: strictReplayProjectDirectory });
  await strictAfterPostTorn.initialize();
  assert.deepEqual(strictAfterPostTorn.getProposal(strictProject.projectId, postTornProposal.proposalId), postTornProposal, 'valid row after torn tail must replay normally');

  const projects = new ProjectStore({ storageDirectory: projectDirectory, newId: newProjectToken, now });
  const tasks = new TaskRuntime({ storageDirectory: taskDirectory, newId: newTaskToken, now });
  await Promise.all([projects.initialize(), tasks.initialize()]);
  const project = await projects.createProject({ title: 'Phase 5 Human Commit Boundary' });
  const otherProject = await projects.createProject({ title: 'Other Project' });
  const affected = await configureRootMission(tasks, project.projectId, 'phase5-affected', 'affected-practice');
  const unaffected = await configureRootMission(tasks, project.projectId, 'phase5-unaffected', 'unaffected-practice');
  const finalized = await configureRootMission(tasks, project.projectId, 'phase5-finalized', 'finalized-practice');
  const crossProject = await configureRootMission(tasks, otherProject.projectId, 'phase5-cross-project', 'cross-project-practice');
  const plainTask = await tasks.ensureTask({ kind: 'bridge', key: 'phase5-not-mission' }, 'Not a Mission');
  await tasks.updateContext(affected.taskId, {
    summary: 'Same-Mission durable context survives Worker replacement.',
    constraints: ['Only explicit committed Project Decisions are Project governance authority.'],
    decisions: ['Continue the same unfinished affected Mission after Worker replacement.'],
    relevantFiles: ['src/project-store.ts', 'src/project-decision-service.ts'],
  });
  await tasks.finalizeMissionStrict(finalized.taskId, { handoffRequired: false });

  // Draft/session-local deliberation can reverse opinions without Project mutation.
  const journalBeforeDraft = await readProjectJournal();
  const projectBeforeDraft = projects.getProject(project.projectId);
  const sessionLocalDraft = [
    `brainstorm: broadcast every thought; ${TRANSCRIPT_SENTINEL}`,
    `reversal: route only the final structured decision; ${TRANSCRIPT_SENTINEL}`,
  ];
  assert.equal(sessionLocalDraft.length, 2);
  assert.deepEqual(projects.getProject(project.projectId), projectBeforeDraft);
  assert.equal(await readProjectJournal(), journalBeforeDraft, 'Draft/reversal must not mutate Project durable state');
  await assert.rejects(
    () => projects.recordProposal(project.projectId, {
      proposalId: 'proposal-transcript-rejected',
      content: {
        kind: 'decision',
        summary: 'Bounded summary',
        scope: { kind: 'project' },
        transcript: sessionLocalDraft.join('\n'),
      },
    }),
    /unsupported field: transcript/,
    'Proposal schema must reject accidental full transcript persistence',
  );
  assert.equal(await readProjectJournal(), journalBeforeDraft, 'rejected transcript-shaped Proposal must not append state');

  const mainContent = {
    kind: 'decision',
    summary: 'Adopt the bounded Phase 5 commit boundary and route this update only to the affected Practice Mission.',
    rationale: 'Draft brainstorms and reversals remain session-local; only committed structured authority is durable.',
    scope: { kind: 'missions', missionIds: [affected.taskId] },
  };
  const mainProposal = await projects.recordProposal(project.projectId, { proposalId: 'phase5-main-proposal', content: mainContent });
  assert.doesNotMatch(JSON.stringify(mainProposal), new RegExp(TRANSCRIPT_SENTINEL));
  const linesAfterProposal = parsedProjectEvents(await readProjectJournal()).length;
  const retriedProposal = await projects.recordProposal(project.projectId, { proposalId: mainProposal.proposalId, content: mainContent });
  assert.deepEqual(retriedProposal, mainProposal, 'same Proposal id/content retry must be idempotent');
  assert.equal(parsedProjectEvents(await readProjectJournal()).length, linesAfterProposal, 'Proposal retry must not append');
  await assert.rejects(
    () => projects.recordProposal(project.projectId, { proposalId: mainProposal.proposalId, content: { ...mainContent, summary: 'different content' } }),
    /identity collision/,
  );
  await assert.rejects(
    () => projects.recordProposal(project.projectId, { proposalId: mainProposal.proposalId, content: { ...mainContent, summary: ` ${mainContent.summary}` } }),
    /identity collision/,
    'same Proposal id with whitespace-different content must still fail closed',
  );

  const decisions = new ProjectDecisionService(projects, tasks);
  await assert.rejects(
    () => decisions.commitProposal(project.projectId, { proposalId: mainProposal.proposalId }),
    /lacks matching durable Human Confirmation/,
    'silence/ordinary chat cannot Commit',
  );
  await assert.rejects(
    () => decisions.commitProposal(project.projectId, { proposalId: mainProposal.proposalId, confirmed: true }),
    /unsupported field: confirmed/,
    'Commit-time confirmed=true must not manufacture human authority',
  );

  const otherProposal = await projects.recordProposal(project.projectId, {
    proposalId: 'phase5-other-confirmed-proposal',
    content: { kind: 'decision', summary: 'Different proposal', scope: { kind: 'missions', missionIds: [unaffected.taskId] } },
  });
  await projects.confirmProposalHuman(project.projectId, { proposalId: otherProposal.proposalId, contentDigest: otherProposal.contentDigest });
  await assert.rejects(
    () => decisions.commitProposal(project.projectId, { proposalId: mainProposal.proposalId }),
    /lacks matching durable Human Confirmation/,
    'confirmation for another Proposal cannot authorize this Proposal',
  );
  await assert.rejects(
    () => projects.confirmProposalHuman(project.projectId, { proposalId: mainProposal.proposalId, contentDigest: 'sha256:wrong-digest' }),
    /digest does not match/,
  );

  // Stale Proposal replacement is explicit, immutable, and does not invent committed-decision supersession.
  const stale = await projects.recordProposal(project.projectId, {
    proposalId: 'phase5-stale-proposal',
    content: { kind: 'change', summary: 'Old preference', scope: { kind: 'project' } },
  });
  await projects.confirmProposalHuman(project.projectId, { proposalId: stale.proposalId, contentDigest: stale.contentDigest });
  const replacementInput = {
    supersededProposalId: stale.proposalId,
    proposalId: 'phase5-replacement-proposal',
    content: { kind: 'change', summary: 'Newer replacement preference', scope: { kind: 'project' } },
  };
  const replacement = await projects.replaceProposal(project.projectId, replacementInput);
  const replacementJournalCount = parsedProjectEvents(await readProjectJournal()).length;
  assert.deepEqual(await projects.replaceProposal(project.projectId, replacementInput), replacement, 'same replacement retry must be idempotent');
  assert.equal(parsedProjectEvents(await readProjectJournal()).length, replacementJournalCount);
  await assert.rejects(() => decisions.commitProposal(project.projectId, { proposalId: stale.proposalId }), /Superseded Project Proposal cannot Commit/);
  await assert.rejects(() => projects.confirmProposalHuman(project.projectId, { proposalId: stale.proposalId, contentDigest: stale.contentDigest }), /superseded/);

  // Explicit human confirmation binds the exact Proposal identity+digest.
  const confirmation = await projects.confirmProposalHuman(project.projectId, { proposalId: mainProposal.proposalId, contentDigest: mainProposal.contentDigest });
  assert.equal(confirmation.proposalId, mainProposal.proposalId);
  assert.equal(confirmation.contentDigest, mainProposal.contentDigest);
  const confirmationAgain = await projects.confirmProposalHuman(project.projectId, { proposalId: mainProposal.proposalId, contentDigest: mainProposal.contentDigest });
  assert.deepEqual(confirmationAgain, confirmation);

  // Concurrent Commit calls serialize onto exactly one deterministic authoritative Decision.
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => decisions.commitProposal(project.projectId, { proposalId: mainProposal.proposalId })));
  const mainDecision = concurrent[0].decision;
  assert.ok(concurrent.every(result => result.decision.decisionId === mainDecision.decisionId));
  assert.ok(concurrent.every(result => result.impact.routeableMissionIds.join(',') === affected.taskId));
  const committedEventsAfterConcurrent = parsedProjectEvents(await readProjectJournal())
    .filter(event => event.type === 'ProjectDecisionCommitted' && event.payload?.decision?.proposalId === mainProposal.proposalId);
  assert.equal(committedEventsAfterConcurrent.length, 1, 'concurrent Commit must append one authoritative Decision');
  assert.equal(projects.listDecisions(project.projectId).filter(decision => decision.proposalId === mainProposal.proposalId).length, 1);

  // Inject a caller-visible uncertainty boundary after the Commit has become
  // durable but before its acknowledgement is trusted. Restart/retry must
  // reconstruct exactly that durable Decision rather than append another one.
  const uncertainProposal = await projects.recordProposal(project.projectId, {
    proposalId: 'phase5-persistence-uncertainty-proposal',
    content: {
      kind: 'decision',
      summary: 'Prove retry after durable Commit acknowledgement is lost.',
      scope: { kind: 'missions', missionIds: [affected.taskId] },
    },
  });
  await projects.confirmProposalHuman(project.projectId, {
    proposalId: uncertainProposal.proposalId,
    contentDigest: uncertainProposal.contentDigest,
  });
  let durableUncertainDecision;
  await assert.rejects(
    async () => {
      durableUncertainDecision = (await decisions.commitProposal(project.projectId, { proposalId: uncertainProposal.proposalId })).decision;
      throw new Error('INJECTED_LOST_COMMIT_ACK_AFTER_DURABLE_WRITE');
    },
    /INJECTED_LOST_COMMIT_ACK_AFTER_DURABLE_WRITE/,
  );
  assert.ok(durableUncertainDecision, 'injected uncertainty occurs only after the Decision is already durable');
  assert.equal(
    parsedProjectEvents(await readProjectJournal()).filter(event => event.type === 'ProjectDecisionCommitted' && event.payload?.decision?.proposalId === uncertainProposal.proposalId).length,
    1,
  );

  await Promise.all([projects.flush(), tasks.flush()]);
  const restartBeforeRoutingProjects = new ProjectStore({ storageDirectory: projectDirectory });
  const restartBeforeRoutingTasks = new TaskRuntime({ storageDirectory: taskDirectory });
  const restartBeforeRoutingService = new ProjectDecisionService(restartBeforeRoutingProjects, restartBeforeRoutingTasks);
  const uncertainRetry = await restartBeforeRoutingService.commitProposal(project.projectId, { proposalId: uncertainProposal.proposalId });
  assert.deepEqual(uncertainRetry.decision, durableUncertainDecision, 'retry after lost Commit acknowledgement must recover the exact durable Decision');
  assert.equal(
    parsedProjectEvents(await readProjectJournal()).filter(event => event.type === 'ProjectDecisionCommitted' && event.payload?.decision?.proposalId === uncertainProposal.proposalId).length,
    1,
    'retry after uncertain persistence must not append a second authoritative Decision',
  );
  const retryAfterUncertainty = await restartBeforeRoutingService.commitProposal(project.projectId, { proposalId: mainProposal.proposalId });
  assert.deepEqual(retryAfterUncertainty.decision, mainDecision, 'persistence-uncertainty retry must return durable exact Commit');
  assert.equal(
    parsedProjectEvents(await readProjectJournal()).filter(event => event.type === 'ProjectDecisionCommitted' && event.payload?.decision?.proposalId === mainProposal.proposalId).length,
    1,
    'restart/retry must not append a second Commit',
  );

  const liveAdapter = new Phase5FakeAdapter('phase5-live-provider');
  let managedId = 0;
  const manager = new WorkerSessionManager({ taskBindings: restartBeforeRoutingTasks, newId: () => `phase5-live-managed-${++managedId}` });
  await manager.register(liveAdapter);
  assert.equal(liveAdapter.inputs.length, 0, 'restart after Commit but before routing must cause zero automatic sends');

  const replayedMainDecision = restartBeforeRoutingProjects.getDecision(project.projectId, mainDecision.decisionId);
  const mainImpact = await restartBeforeRoutingService.analyzeImpact(project.projectId, mainDecision.decisionId);
  assert.deepEqual(mainImpact.routeableMissionIds, [affected.taskId]);
  assert.deepEqual(mainImpact.excluded, []);
  await assert.rejects(
    () => restartBeforeRoutingService.analyzeImpact(otherProject.projectId, mainDecision.decisionId),
    /does not exist in Project/,
    'wrong Project cannot claim another Project Decision',
  );

  // Mechanical impact analysis excludes nonexistent, non-Mission, cross-Project, and finalized ids.
  const edgeProposal = await restartBeforeRoutingProjects.recordProposal(project.projectId, {
    proposalId: 'phase5-impact-edge-proposal',
    content: {
      kind: 'change',
      summary: 'Exercise explicit bounded impact filtering.',
      scope: { kind: 'missions', missionIds: [affected.taskId, 'phase5-missing-mission', plainTask.taskId, crossProject.taskId, finalized.taskId] },
    },
  });
  await restartBeforeRoutingProjects.confirmProposalHuman(project.projectId, { proposalId: edgeProposal.proposalId, contentDigest: edgeProposal.contentDigest });
  const edgeCommit = await restartBeforeRoutingService.commitProposal(project.projectId, { proposalId: edgeProposal.proposalId });
  assert.deepEqual(edgeCommit.impact.routeableMissionIds, [affected.taskId]);
  assert.deepEqual(edgeCommit.impact.excluded, [
    { missionId: crossProject.taskId, reason: 'cross-project' },
    { missionId: finalized.taskId, reason: 'finalized' },
    { missionId: 'phase5-missing-mission', reason: 'nonexistent' },
    { missionId: plainTask.taskId, reason: 'not-mission' },
  ].sort((a, b) => a.missionId.localeCompare(b.missionId) || a.reason.localeCompare(b.reason)));

  const affectedSession = await manager.createSession('worker.phase5', { model: 'phase5-fake-model' }, affected.taskId);
  const unaffectedSession = await manager.createSession('worker.phase5', { model: 'phase5-fake-model' }, unaffected.taskId);
  const crossProjectSession = await manager.createSession('worker.phase5', { model: 'phase5-fake-model' }, crossProject.taskId);
  const unboundSession = await manager.createSession('worker.phase5', { model: 'phase5-fake-model' });
  const projectSnapshot = restartBeforeRoutingProjects.getProject(project.projectId);
  const otherProjectSnapshot = restartBeforeRoutingProjects.getProject(otherProject.projectId);

  assert.throws(
    () => buildProjectDecisionWorkerInput({ project: otherProjectSnapshot, decision: replayedMainDecision, impact: mainImpact, mission: restartBeforeRoutingTasks.getTask(affected.taskId), session: affectedSession, inputId: 'wrong-project' }),
    /different Project snapshot/,
  );
  assert.throws(
    () => buildProjectDecisionWorkerInput({ project: projectSnapshot, decision: replayedMainDecision, impact: mainImpact, mission: restartBeforeRoutingTasks.getTask(unaffected.taskId), session: unaffectedSession, inputId: 'unaffected' }),
    /not an affected routeable Mission/,
  );
  assert.throws(
    () => buildProjectDecisionWorkerInput({ project: projectSnapshot, decision: replayedMainDecision, impact: mainImpact, mission: restartBeforeRoutingTasks.getTask('phase5-missing-render-target'), session: affectedSession, inputId: 'missing-mission' }),
    /target Mission does not exist/,
    'renderer must reject a nonexistent Mission instead of relying on caller discipline',
  );
  assert.throws(
    () => buildProjectDecisionWorkerInput({ project: projectSnapshot, decision: replayedMainDecision, impact: mainImpact, mission: restartBeforeRoutingTasks.getTask(crossProject.taskId), session: crossProjectSession, inputId: 'cross-project' }),
    /belongs to a different Project/,
  );
  assert.throws(
    () => buildProjectDecisionWorkerInput({ project: projectSnapshot, decision: replayedMainDecision, impact: { ...mainImpact, routeableMissionIds: [...mainImpact.routeableMissionIds, finalized.taskId] }, mission: restartBeforeRoutingTasks.getTask(finalized.taskId), session: affectedSession, inputId: 'finalized' }),
    /finalized and cannot receive/,
  );
  assert.throws(
    () => buildProjectDecisionWorkerInput({ project: projectSnapshot, decision: replayedMainDecision, impact: mainImpact, mission: restartBeforeRoutingTasks.getTask(affected.taskId), session: unaffectedSession, inputId: 'wrong-session' }),
    /not affected Mission/,
  );
  assert.throws(
    () => buildProjectDecisionWorkerInput({ project: projectSnapshot, decision: replayedMainDecision, impact: mainImpact, mission: restartBeforeRoutingTasks.getTask(affected.taskId), session: unboundSession, inputId: 'unbound-session' }),
    /not bound to a Task\/Mission/,
  );
  assert.throws(
    () => buildProjectDecisionWorkerInput({ project: projectSnapshot, decision: replayedMainDecision, impact: mainImpact, mission: restartBeforeRoutingTasks.getTask(affected.taskId), session: manager.getSession('phase5-missing-worker-session'), inputId: 'missing-worker-session' }),
    /Selected WorkerSession does not exist/,
  );
  assert.throws(
    () => buildProjectDecisionWorkerInput({ project: projectSnapshot, decision: { ...replayedMainDecision, decisionId: 'not-committed' }, impact: mainImpact, mission: restartBeforeRoutingTasks.getTask(affected.taskId), session: affectedSession, inputId: 'not-committed' }),
    /not Committed/,
  );

  const liveInput = buildProjectDecisionWorkerInput({
    project: projectSnapshot,
    decision: replayedMainDecision,
    impact: mainImpact,
    mission: restartBeforeRoutingTasks.getTask(affected.taskId),
    session: affectedSession,
    inputId: 'phase5-live-decision',
  });
  assert.match(liveInput.prompt, /Committed Project Decision/);
  assert.match(liveInput.prompt, /route this update only to the affected Practice Mission/);
  assert.doesNotMatch(liveInput.prompt, new RegExp(TRANSCRIPT_SENTINEL));
  for await (const _event of manager.send(affectedSession.managedSessionId, liveInput)) { /* explicit host delivery */ }
  assert.equal(liveAdapter.inputs.length, 1);
  assert.equal(liveAdapter.inputs[0].inputId, 'phase5-live-decision');
  assert.equal(liveAdapter.inputs.some(input => input.inputId.includes('unaffected')), false, 'unaffected Mission receives nothing');

  // Provider may have observed the update before the send outcome becomes UNKNOWN.
  const unknownInput = buildProjectDecisionWorkerInput({
    project: projectSnapshot,
    decision: replayedMainDecision,
    impact: mainImpact,
    mission: restartBeforeRoutingTasks.getTask(affected.taskId),
    session: manager.getSession(affectedSession.managedSessionId),
    inputId: 'phase5-unknown-send',
  });
  const unknownIterator = manager.send(affectedSession.managedSessionId, unknownInput)[Symbol.asyncIterator]();
  assert.equal((await unknownIterator.next()).value.type, 'text_delta');
  await assert.rejects(() => unknownIterator.next(), /INJECTED_PHASE5_UNKNOWN_PROVIDER_SEND/);
  const sendsAfterUnknown = liveAdapter.inputs.length;
  assert.equal(sendsAfterUnknown, 2);
  assert.deepEqual(await restartBeforeRoutingService.analyzeImpact(project.projectId, mainDecision.decisionId), mainImpact);
  assert.equal(liveAdapter.inputs.length, sendsAfterUnknown, 'impact reconstruction must not resend UNKNOWN provider work');
  const journalAfterUnknown = await readProjectJournal();
  assert.doesNotMatch(journalAfterUnknown, /phase5-unknown-send|"delivered"/i, 'Project authority journal must not persist provider delivery status');

  // Restart + replacement Worker reconstructs from Project Decision + same-Mission Handoff only.
  await Promise.all([restartBeforeRoutingProjects.flush(), restartBeforeRoutingTasks.flush()]);
  const replacementProjects = new ProjectStore({ storageDirectory: projectDirectory });
  const replacementTasks = new TaskRuntime({ storageDirectory: taskDirectory });
  const replacementService = new ProjectDecisionService(replacementProjects, replacementTasks);
  const replacementImpact = await replacementService.analyzeImpact(project.projectId, mainDecision.decisionId);
  assert.equal(liveAdapter.inputs.length, sendsAfterUnknown, 'restart itself must not authorize automatic resend');
  const replacementDecision = replacementProjects.getDecision(project.projectId, mainDecision.decisionId);
  const handoff = buildRenderedContextHandoff(replacementTasks.getTask(affected.taskId), {
    targetWorkerId: 'worker.phase5',
    generatedAt: '2026-09-15T09:00:00.000Z',
    maxChars: 8_000,
    maxWorkerSessions: 0,
  });
  assert.match(handoff.text, /Same-Mission durable context survives Worker replacement/);
  assert.doesNotMatch(JSON.stringify(handoff), new RegExp(TRANSCRIPT_SENTINEL));

  const replacementAdapter = new Phase5FakeAdapter('phase5-replacement-provider');
  let replacementManaged = 0;
  const replacementManager = new WorkerSessionManager({ taskBindings: replacementTasks, newId: () => `phase5-replacement-managed-${++replacementManaged}` });
  await replacementManager.register(replacementAdapter);
  const replacementSession = await replacementManager.createSession('worker.phase5', { model: 'phase5-fake-model' }, affected.taskId);
  const replacementWorkerInput = buildProjectDecisionWorkerInput({
    project: replacementProjects.getProject(project.projectId),
    decision: replacementDecision,
    impact: replacementImpact,
    mission: replacementTasks.getTask(affected.taskId),
    session: replacementSession,
    inputId: 'phase5-replacement-decision',
    contextHandoff: handoff,
  });
  assert.match(replacementWorkerInput.prompt, /Same-Mission Context Handoff/);
  assert.match(replacementWorkerInput.prompt, /Committed Project Decision/);
  assert.match(replacementWorkerInput.prompt, /Same-Mission durable context survives Worker replacement/);
  assert.doesNotMatch(replacementWorkerInput.prompt, new RegExp(TRANSCRIPT_SENTINEL));
  for await (const _event of replacementManager.send(replacementSession.managedSessionId, replacementWorkerInput)) { /* explicit replacement delivery */ }
  assert.equal(replacementAdapter.inputs.length, 1);

  // Final durable boundaries: no transcript, delivery ledger, or Project-owned Mission membership.
  const finalProjectJournal = await readProjectJournal();
  const finalTaskJournals = await readTaskJournals();
  const finalProject = replacementProjects.getProject(project.projectId);
  assert.equal('missionIds' in finalProject, false);
  for (const event of parsedProjectEvents(finalProjectJournal)) {
    assert.equal('missionIds' in event.payload, false, 'Project events must not add a Project-owned Mission membership field');
  }
  assert.doesNotMatch(finalProjectJournal, new RegExp(TRANSCRIPT_SENTINEL));
  assert.doesNotMatch(finalTaskJournals, new RegExp(TRANSCRIPT_SENTINEL));
  assert.doesNotMatch(JSON.stringify(mainDecision), new RegExp(TRANSCRIPT_SENTINEL));
  assert.doesNotMatch(JSON.stringify(replacementAdapter.inputs), new RegExp(TRANSCRIPT_SENTINEL));

  // Directly forged mismatched confirmation journal evidence is ignored on replay.
  const forgedConfirmation = {
    version: 1,
    eventId: 'forged-mismatch-confirmation',
    projectId: project.projectId,
    at: '2026-09-15T09:30:00.000Z',
    type: 'ProjectProposalHumanConfirmed',
    payload: {
      confirmation: {
        confirmationId: 'forged-confirmation',
        proposalId: replacement.proposalId,
        contentDigest: 'sha256:wrong-digest',
        confirmedAt: '2026-09-15T09:30:00.000Z',
      },
    },
  };
  await fs.appendFile(path.join(projectDirectory, PROJECT_JOURNAL), `${JSON.stringify(forgedConfirmation)}\n`, 'utf8');
  const afterForgedReplay = new ProjectStore({ storageDirectory: projectDirectory });
  await afterForgedReplay.initialize();
  assert.equal(afterForgedReplay.getHumanConfirmation(project.projectId, replacement.proposalId), undefined, 'mismatched durable confirmation evidence must fail closed on replay');
  assert.ok(afterForgedReplay.getDecision(project.projectId, mainDecision.decisionId), 'invalid later journal evidence must not erase prior valid authority');

  console.log('[smoke] Phase 5 Project Proposal → Human Confirmed → Commit + selective Decision routing contract ok');
  console.log(`[smoke] project=${project.projectId} decision=${mainDecision.decisionId} affected=${affected.taskId} sends=${liveAdapter.inputs.length} replacementSends=${replacementAdapter.inputs.length}`);
} finally {
  await Promise.all([
    fs.rm(projectDirectory, { recursive: true, force: true }),
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(legacyProjectDirectory, { recursive: true, force: true }),
    fs.rm(strictReplayProjectDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
