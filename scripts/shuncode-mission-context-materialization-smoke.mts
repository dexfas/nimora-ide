import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild');
const projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p8-project-'));
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p8-task-'));
const collaborationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p8-collaboration-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p8-bundle-'));
const bundlePath = path.join(bundleDirectory, 'mission-context-materialization-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { ProjectStore } from './src/project-store.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
      export { MissionCollaborationStore } from './src/mission-collaboration-store.ts';
      export { WorkerSessionManager } from './src/worker-session-manager.ts';
      export { MissionContextMaterializer, MissionContextMaterializationError } from './src/mission-context-materializer.ts';
    `,
    resolveDir: root,
    sourcefile: 'mission-context-materialization-smoke-entry.ts',
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
  MissionContextMaterializer,
  MissionContextMaterializationError,
} = require(bundlePath);

const PROVIDER_TRANSCRIPT_SENTINEL = 'P8_PROVIDER_TRANSCRIPT_MUST_NOT_LEAK';
const PROVIDER_CONTEXT_SENTINEL = 'P8_PAGE_TOKEN_DOM_NATIVE_CONTEXT_MUST_NOT_LEAK';
const FIXED_GENERATED_AT = '2026-09-16T13:00:00.000Z';
let tick = 0;
const now = () => new Date(Date.UTC(2026, 8, 16, 12, 0, tick++));
let id = 0;
const newId = () => `p8-id-${++id}`;

class FakeAdapter {
  nextNative = 0;
  providerTranscript = PROVIDER_TRANSCRIPT_SENTINEL;

  constructor(id) { this.id = id; }

  async describe() {
    return {
      id: this.id,
      provider: 'phase8-fake-provider',
      kind: 'api',
      label: `Phase 8 fake ${this.id}`,
      availability: 'available',
      models: ['fake-model'],
      capabilities: {
        streaming: true,
        reasoning: true,
        capabilityRequests: true,
        imageInput: false,
        checkpoints: false,
        interruption: true,
        persistentContext: true,
      },
    };
  }

  async createSession(options) {
    const at = FIXED_GENERATED_AT;
    return {
      sessionId: `${this.id}-native-${++this.nextNative}`,
      workerId: this.id,
      state: 'idle',
      model: options.model,
      contextHandle: options.contextHandle,
      createdAt: at,
      lastActiveAt: at,
    };
  }

  async *send(_session, input) { yield { type: 'terminal', inputId: input.inputId, status: 'completed' }; }
  async interrupt(session) { session.state = 'interrupted'; }
  async dispose(session) { session.state = 'disposed'; }
  async health() { return { status: 'healthy', checkedAt: FIXED_GENERATED_AT }; }
}

const ids = values => {
  const queue = [...values];
  return () => {
    const value = queue.shift();
    if (!value) throw new Error('Managed WorkerSession id fixture exhausted.');
    return value;
  };
};

async function configureMission(tasks, projectId, key, plane, missionType, rootMissionId, parentMissionId) {
  const task = await tasks.ensureTask({ kind: 'mission', key }, `${missionType} goal`);
  const root = rootMissionId ?? task.taskId;
  await tasks.configureMission(task.taskId, {
    projectId,
    rootMissionId: root,
    ...(parentMissionId ? { parentMissionId } : {}),
    plane,
    missionType,
    completionCriteria: [`${missionType} complete without authority expansion`],
  });
  return tasks.getTask(task.taskId);
}

async function commitDecision(projects, projectId, proposalId, summary, scope) {
  const proposal = await projects.recordProposal(projectId, {
    proposalId,
    content: { kind: 'decision', summary, scope },
  });
  await projects.confirmProposalHuman(projectId, { proposalId, contentDigest: proposal.contentDigest });
  return projects.commitProposal(projectId, { proposalId });
}

function selected(result, itemId) {
  return result.package.items.find(item => item.itemId === itemId);
}

async function expectContextError(promise, code) {
  try {
    await promise;
    assert.fail(`Expected MissionContextMaterializationError(${code})`);
  } catch (error) {
    assert.ok(error instanceof MissionContextMaterializationError, `expected structured materialization error, got ${error}`);
    assert.equal(error.code, code);
    assert.equal(error.inspector.incompatibility?.code, code);
    return error;
  }
}

async function expectInvalidRequestNoSelection(promise) {
  const error = await expectContextError(promise, 'invalid-request');
  assert.equal(error.inspector.selected.count, 0, 'malformed runtime request must fail before semantic selection');
  assert.deepEqual(error.inspector.selected.itemIds, []);
  assert.equal(error.inspector.profile, undefined, 'malformed runtime request must fail before profile resolution can widen context');
  return error;
}

function poisonOwner(label) {
  return new Proxy({}, {
    get(_target, property) {
      throw new Error(`${label} semantic owner accessed during runtime request normalization: ${String(property)}`);
    },
  });
}

try {
  const projects = new ProjectStore({ storageDirectory: projectDirectory, now, newId });
  const tasks = new TaskRuntime({ storageDirectory: taskDirectory, now, newId });
  await Promise.all([projects.initialize(), tasks.initialize()]);

  const project = await projects.createProject({ title: 'Phase 8 context project', goal: 'Materialize exact Mission truth without hidden provider memory.' });
  const otherProject = await projects.createProject({ title: 'Other project' });
  const practice = await configureMission(tasks, project.projectId, 'practice-root', 'practice', 'phase8-practice');
  const cognitionA = await configureMission(tasks, project.projectId, 'cognition-a', 'cognition', 'phase8-cognition-a', practice.taskId, practice.taskId);
  const cognitionB = await configureMission(tasks, project.projectId, 'cognition-b', 'cognition', 'phase8-cognition-b', practice.taskId, practice.taskId);
  const cognitionUnrelated = await configureMission(tasks, project.projectId, 'cognition-unrelated', 'cognition', 'phase8-cognition-unrelated', practice.taskId, practice.taskId);
  const siblingPractice = await configureMission(tasks, project.projectId, 'practice-sibling', 'practice', 'phase8-practice-sibling', practice.taskId, practice.taskId);
  const otherRoot = await configureMission(tasks, otherProject.projectId, 'other-root', 'practice', 'other-root');
  const terminalMission = await configureMission(tasks, project.projectId, 'terminal-child', 'practice', 'terminal-child', practice.taskId, practice.taskId);

  await tasks.updateContext(practice.taskId, {
    summary: 'Phase 8 WO#1 current Work Order context.',
    constraints: [
      'Do not silently replace the already-bound Worker.',
      'UNKNOWN is not success and old does not mean stale.',
    ],
    decisions: ['Materialization is provider-neutral read/derive work only.'],
    relevantFiles: ['src/mission-context-materializer.ts', 'src/context-handoff.ts'],
  });
  await tasks.setTodos(practice.taskId, [
    { id: 'materialize', title: 'Materialize bounded Mission context', status: 'in_progress' },
    { id: 'wo2', title: 'Do not start WO#2', status: 'pending' },
  ]);
  await tasks.reportProgress(practice.taskId, { message: 'WO#1 adversarial proof', phase: 'Phase 8 Practice', percent: 80 });
  const artifact = await tasks.recordArtifact(practice.taskId, {
    artifactId: 'artifact-current-proof', kind: 'report', title: 'Current Phase 8 proof', uri: 'file:///phase8-proof.md',
    metadata: { providerTranscript: PROVIDER_TRANSCRIPT_SENTINEL, dom: PROVIDER_CONTEXT_SENTINEL },
  });
  await tasks.beginExecution(practice.taskId, { executionId: 'exec-unknown', toolName: 'external_side_effect', capabilityId: 'host.side-effect' });
  await tasks.finishExecution(practice.taskId, 'exec-unknown', 'unknown', { resultSummary: 'Outcome could not be proven.' });
  await tasks.markResultPrepared(practice.taskId, 'exec-unknown');
  const revokedGrant = await tasks.grantCapabilityStrict(practice.taskId, { capabilityId: 'workspace.write', capabilityVersion: 1, scope: 'task' });
  await tasks.revokeCapabilityGrantStrict(practice.taskId, revokedGrant.grantId);

  const oldDecision = await commitDecision(projects, project.projectId, 'decision-old', 'Older applicable committed decision must survive.', { kind: 'project' });
  const newerDecision = await commitDecision(projects, project.projectId, 'decision-new', 'Newer peer decision does not silently supersede the old one.', { kind: 'project' });
  const targetDecision = await commitDecision(projects, project.projectId, 'decision-target', 'Mission-scoped decision for exact target Mission.', { kind: 'missions', missionIds: [practice.taskId] });
  const otherMissionDecision = await commitDecision(projects, project.projectId, 'decision-other-mission', 'Must not leak into target Mission.', { kind: 'missions', missionIds: [siblingPractice.taskId] });
  const superseded = await projects.recordProposal(project.projectId, {
    proposalId: 'draft-superseded',
    content: { kind: 'change', summary: 'Superseded draft must not be current authority.', scope: { kind: 'project' } },
  });
  await projects.replaceProposal(project.projectId, {
    supersededProposalId: superseded.proposalId,
    proposalId: 'draft-replacement',
    content: { kind: 'change', summary: 'Current draft remains explicitly non-authoritative research.', scope: { kind: 'project' } },
  });

  const collaboration = new MissionCollaborationStore({ storageDirectory: collaborationDirectory, projects, tasks, now });
  await collaboration.initialize();
  await collaboration.recordExchange({
    exchangeId: 'evidence-current', projectId: project.projectId, sourceMissionId: cognitionA.taskId, targetMissionId: practice.taskId, kind: 'Evidence',
    payload: { summary: 'Current task-relevant evidence.', references: [{ type: 'artifact', missionId: practice.taskId, artifactId: artifact.artifactId }] },
  });
  await collaboration.recordExchange({
    exchangeId: 'finding-old', projectId: project.projectId, sourceMissionId: cognitionA.taskId, targetMissionId: practice.taskId, kind: 'Finding',
    payload: { summary: 'Older relevant finding; age alone must not make this stale.', evidenceExchangeIds: ['evidence-current'] },
  });
  await collaboration.recordExchange({
    exchangeId: 'problem-current', projectId: project.projectId, sourceMissionId: practice.taskId, targetMissionId: cognitionA.taskId, kind: 'Problem',
    payload: {
      currentGoal: 'Materialize correct context.', previousAssumption: 'A broad history dump would be sufficient.',
      observedReality: 'Current Problem/Answer relevance must outrank unrelated or lower-priority history.',
      preciseQuestion: 'Which exact current facts belong in bounded context?', blocking: false, evidenceExchangeIds: ['evidence-current'],
    },
  });
  await collaboration.recordExchange({
    exchangeId: 'answer-current', projectId: project.projectId, sourceMissionId: cognitionA.taskId, targetMissionId: practice.taskId, kind: 'Answer', replyToExchangeId: 'problem-current',
    payload: { answer: 'Use exact owner-backed current facts and explicit provenance.', evidenceExchangeIds: ['evidence-current'] },
  });
  await collaboration.recordRelation({
    relationId: 'relation-cognition-b-practice', projectId: project.projectId, sourceMissionId: cognitionB.taskId, targetMissionId: practice.taskId, type: 'informs',
  });
  await collaboration.recordExchange({
    exchangeId: 'research-neighbor-only', projectId: project.projectId, sourceMissionId: cognitionB.taskId, kind: 'Finding',
    payload: { summary: 'Related Cognition research corpus admitted only by research profile.', evidenceExchangeIds: [] },
  });
  await collaboration.recordExchange({
    exchangeId: 'research-neighbor-other', projectId: project.projectId, sourceMissionId: cognitionB.taskId, kind: 'Finding',
    payload: { summary: 'Second related research fact used to prove requiredItemIds does not widen the whole related corpus.', evidenceExchangeIds: [] },
  });
  await collaboration.recordExchange({
    exchangeId: 'research-unrelated-project-history', projectId: project.projectId, sourceMissionId: cognitionUnrelated.taskId, kind: 'Finding',
    payload: { summary: 'Unrelated Project history must remain outside the bounded relevance universe.', evidenceExchangeIds: [] },
  });

  const adapter = new FakeAdapter('worker.practice');
  const workers = new WorkerSessionManager({ taskBindings: tasks, newId: ids(['managed-practice', 'managed-unbound']), now });
  await workers.register(adapter);
  const bound = await workers.createSession('worker.practice', { model: 'fake-model', contextHandle: PROVIDER_CONTEXT_SENTINEL }, practice.taskId);
  assert.equal(bound.managedSessionId, 'managed-practice');
  const unbound = await workers.createSession('worker.practice', { model: 'fake-model', contextHandle: PROVIDER_CONTEXT_SENTINEL });
  const materializer = new MissionContextMaterializer(projects, tasks, collaboration, workers);
  const preSemanticMaterializer = new MissionContextMaterializer(
    poisonOwner('ProjectStore'),
    poisonOwner('TaskRuntime'),
    poisonOwner('MissionCollaborationStore'),
    poisonOwner('WorkerSessionManager'),
  );
  const request = {
    projectId: project.projectId,
    rootMissionId: practice.taskId,
    missionId: practice.taskId,
    managedSessionId: bound.managedSessionId,
    generatedAt: FIXED_GENERATED_AT,
    budget: { maxChars: 60_000 },
  };

  const beforeFiles = {
    project: await fs.readdir(projectDirectory),
    task: await fs.readdir(taskDirectory),
    collaboration: await fs.readdir(collaborationDirectory),
  };
  const baseline = await materializer.materialize(request);
  assert.equal(baseline.package.profile, 'practice-v1');
  assert.equal(baseline.package.workerId, 'worker.practice');
  assert.equal(baseline.inspector.scope.projectId, project.projectId);
  assert.equal(baseline.inspector.scope.rootMissionId, practice.taskId);
  assert.equal(baseline.inspector.scope.missionId, practice.taskId);
  assert.equal(baseline.inspector.scope.managedSessionId, 'managed-practice');
  assert.equal(baseline.inspector.budget.sections.skills.budgetSource, 'unimplemented');
  assert.equal(baseline.inspector.budget.sections['tool-schemas'].selectedCount, 0);
  assert.equal(baseline.inspector.durableRoutingJournalCreated, false);
  assert.ok(baseline.text.length <= request.budget.maxChars);
  assert.equal(new Set(baseline.package.items.map(item => item.itemId)).size, baseline.package.items.length, 'materialized semantic items must be unique');

  for (const decision of [oldDecision, newerDecision, targetDecision]) {
    assert.ok(selected(baseline, `project-decision:${decision.decisionId}`), `expected applicable committed Decision ${decision.decisionId}`);
  }
  assert.equal(selected(baseline, `project-decision:${otherMissionDecision.decisionId}`), undefined, 'different-Mission Decision must not leak');
  assert.ok(baseline.inspector.ambiguities.some(entry => entry.kind === 'committed-decision-peer-authority' && entry.decisionIds.includes(oldDecision.decisionId)));
  const unknownExecution = selected(baseline, 'execution:exec-unknown');
  assert.equal(unknownExecution.content.status, 'unknown');
  assert.equal(unknownExecution.content.deliveryStatus, 'pending');
  assert.ok(baseline.inspector.exclusions.items.some(entry => entry.itemId === `capability-grant:${revokedGrant.grantId}` && entry.reason === 'revoked-grant-not-current-approval'));
  assert.equal(selected(baseline, 'exchange:research-neighbor-only'), undefined, 'Practice profile must not inherit related Cognition research corpus');
  assert.ok(baseline.inspector.omitted.items.some(entry => entry.itemId === 'exchange:research-neighbor-only' && entry.reason === 'profile-excluded'), 'known related research withheld by Practice profile must be inspectable');
  assert.equal(baseline.text.includes('research-neighbor-only'), false, 'profile-excluded related research must not enter Worker text');
  assert.ok(baseline.inspector.omitted.items.some(entry => entry.itemId === 'exchange:research-neighbor-other' && entry.reason === 'profile-excluded'));
  assert.equal(baseline.inspector.omitted.items.some(entry => entry.itemId === 'exchange:research-unrelated-project-history'), false, 'unrelated Project history must not be scanned into profile omission accounting');
  assert.equal(selected(baseline, 'exchange:research-unrelated-project-history'), undefined);
  assert.ok(selected(baseline, 'exchange:finding-old'), 'old but relevant Finding remains eligible');
  assert.equal(baseline.inspector.exclusions.items.some(entry => entry.itemId === 'exchange:finding-old'), false, 'age alone must not mark Finding stale');

  const requiredAcrossProfile = await materializer.materialize({
    ...request,
    constraints: { requiredItemIds: ['exchange:research-neighbor-only'] },
  });
  const promotedRelated = selected(requiredAcrossProfile, 'exchange:research-neighbor-only');
  assert.ok(promotedRelated, 'explicit requiredItemIds must be able to promote a known bounded related fact across profile pruning');
  assert.equal(promotedRelated.required, true);
  assert.equal(promotedRelated.authority, 'durable-fact', 'required promotion must not increase semantic authority');
  assert.equal(requiredAcrossProfile.inspector.omitted.items.some(entry => entry.itemId === 'exchange:research-neighbor-only'), false);
  assert.equal(selected(requiredAcrossProfile, 'exchange:research-neighbor-other'), undefined, 'requiredItemIds must not widen the rest of the related research corpus');
  assert.ok(requiredAcrossProfile.inspector.omitted.items.some(entry => entry.itemId === 'exchange:research-neighbor-other' && entry.reason === 'profile-excluded'));

  const malformedStringBoolean = await expectInvalidRequestNoSelection(materializer.materialize({
    ...request,
    constraints: { includeRelatedResearch: 'false' },
  }));
  assert.match(malformedStringBoolean.message, /includeRelatedResearch must be a boolean/);
  await expectInvalidRequestNoSelection(materializer.materialize({
    ...request,
    constraints: { includeDraftProposals: 'false' },
  }));
  const malformedProfile = await expectInvalidRequestNoSelection(materializer.materialize({
    ...request,
    constraints: { profile: 'not-a-profile' },
  }));
  assert.match(malformedProfile.message, /Unsupported Mission context profile/);
  const malformedSection = await expectInvalidRequestNoSelection(materializer.materialize({
    ...request,
    budget: { maxChars: 60_000, sectionChars: { 'unknown-section': 0 } },
  }));
  assert.match(malformedSection.message, /sectionChars contains unsupported field: unknown-section/);
  await expectInvalidRequestNoSelection(materializer.materialize({ ...request, unexpectedTopLevel: true }));
  await expectInvalidRequestNoSelection(materializer.materialize({ ...request, budget: { maxChars: 60_000, unsupportedBudgetField: 1 } }));
  await expectInvalidRequestNoSelection(materializer.materialize({ ...request, budget: { maxChars: 60_000, sectionChars: { instructions: '64' } } }));
  await expectInvalidRequestNoSelection(materializer.materialize({ ...request, budget: { maxChars: 60_000, outputReserveChars: -1 } }));
  await expectInvalidRequestNoSelection(materializer.materialize({ ...request, constraints: { unsupportedConstraintField: true } }));
  await expectInvalidRequestNoSelection(materializer.materialize({ ...request, constraints: { requiredItemIds: 'exchange:research-neighbor-only' } }));
  await expectInvalidRequestNoSelection(materializer.materialize({ ...request, constraints: { requiredItemIds: [''] } }));
  await expectInvalidRequestNoSelection(materializer.materialize({ ...request, constraints: { requiredItemIds: Array.from({ length: 129 }, (_, index) => `required-${index}`) } }));
  await expectInvalidRequestNoSelection(materializer.materialize({ ...request, budget: { maxChars: 1_000_001 } }));
  await expectInvalidRequestNoSelection(materializer.materialize({ ...request, generatedAt: 'not-an-iso-timestamp' }));

  const inheritedResearchConstraints = Object.create({ includeRelatedResearch: true });
  const inheritedResearchResult = await materializer.materialize({ ...request, constraints: inheritedResearchConstraints });
  assert.equal(inheritedResearchResult.package.profile, 'practice-v1');
  assert.equal(selected(inheritedResearchResult, 'exchange:research-neighbor-only'), undefined, 'prototype-inherited includeRelatedResearch must be semantically inert');
  assert.ok(inheritedResearchResult.inspector.omitted.items.some(entry => entry.itemId === 'exchange:research-neighbor-only' && entry.reason === 'profile-excluded'));

  const inheritedProfileConstraints = Object.create({ profile: 'research' });
  const inheritedProfileResult = await materializer.materialize({ ...request, constraints: inheritedProfileConstraints });
  assert.equal(inheritedProfileResult.package.profile, 'practice-v1', 'prototype-inherited profile must not switch the resolved profile');
  assert.equal(selected(inheritedProfileResult, 'exchange:research-neighbor-only'), undefined);

  const mixedPrototypeConstraints = Object.create({ includeRelatedResearch: true, profile: 'research' });
  Object.defineProperty(mixedPrototypeConstraints, 'includeRelatedResearch', { value: false, enumerable: true });
  const mixedPrototypeResult = await materializer.materialize({ ...request, constraints: mixedPrototypeConstraints });
  assert.equal(mixedPrototypeResult.package.profile, 'practice-v1', 'custom-prototype records must be canonicalized from own data properties only');
  assert.equal(selected(mixedPrototypeResult, 'exchange:research-neighbor-only'), undefined);

  const inheritedTopLevelRequest = Object.create(request);
  await expectInvalidRequestNoSelection(preSemanticMaterializer.materialize(inheritedTopLevelRequest));

  const inheritedBudget = Object.create({ maxChars: 60_000 });
  await expectInvalidRequestNoSelection(preSemanticMaterializer.materialize({ ...request, budget: inheritedBudget }));

  const inheritedSectionChars = Object.create({ instructions: 1 });
  const inheritedSectionBudgetResult = await materializer.materialize({ ...request, budget: { maxChars: 60_000, sectionChars: inheritedSectionChars } });
  assert.equal(inheritedSectionBudgetResult.inspector.budget.sections.instructions.budgetSource, 'profile', 'prototype-inherited section budget must be ignored rather than becoming a hard budget');
  assert.ok(selected(inheritedSectionBudgetResult, 'mission:scope'));

  const inheritedGeneratedAtRequest = Object.create({ generatedAt: '1900-01-01T00:00:00.000Z' });
  Object.assign(inheritedGeneratedAtRequest, {
    projectId: request.projectId,
    rootMissionId: request.rootMissionId,
    missionId: request.missionId,
    managedSessionId: request.managedSessionId,
    budget: request.budget,
  });
  const inheritedGeneratedAtResult = await materializer.materialize(inheritedGeneratedAtRequest);
  assert.notEqual(inheritedGeneratedAtResult.package.generatedAt, '1900-01-01T00:00:00.000Z', 'prototype-inherited generatedAt must be semantically inert');

  const sparseRequiredIds = Array(1);
  await expectInvalidRequestNoSelection(preSemanticMaterializer.materialize({ ...request, constraints: { requiredItemIds: sparseRequiredIds } }));
  const inheritedIndexPrototype = Object.create(Array.prototype);
  Object.defineProperty(inheritedIndexPrototype, '0', { value: 'exchange:research-neighbor-only', enumerable: true });
  const inheritedIndexRequiredIds = Array(1);
  Object.setPrototypeOf(inheritedIndexRequiredIds, inheritedIndexPrototype);
  await expectInvalidRequestNoSelection(preSemanticMaterializer.materialize({ ...request, constraints: { requiredItemIds: inheritedIndexRequiredIds } }));
  await expectInvalidRequestNoSelection(preSemanticMaterializer.materialize({ ...request, constraints: { requiredItemIds: [123] } }));

  const draftPolicyError = await expectContextError(materializer.materialize({
    ...request,
    constraints: { requiredItemIds: ['project-proposal:draft-replacement'] },
  }), 'invalid-request');
  assert.equal(draftPolicyError.inspector.selected.count, 0);
  assert.match(draftPolicyError.message, /excluded by current authority\/policy/);

  const research = await materializer.materialize({ ...request, constraints: { profile: 'research', includeDraftProposals: true } });
  assert.equal(research.package.profile, 'research-v1');
  assert.ok(selected(research, 'exchange:research-neighbor-only'), 'research profile may admit more related research');
  assert.ok(selected(research, 'exchange:research-neighbor-other'));
  assert.equal(selected(research, 'exchange:research-unrelated-project-history'), undefined, 'research profile still must not scan unrelated Project history');
  assert.equal(selected(research, 'exchange:research-neighbor-only').authority, 'durable-fact', 'profile inclusion must not promote authority');
  assert.ok(research.inspector.exclusions.items.some(entry => entry.itemId === 'project-proposal:draft-superseded' && entry.reason === 'superseded-project-proposal'));
  assert.equal(selected(research, 'project-proposal:draft-superseded'), undefined);
  assert.equal(selected(research, 'project-proposal:draft-replacement')?.authority, 'non-authoritative-research');

  const serialized = JSON.stringify({ baseline, research });
  assert.ok(baseline.inspector.providerSpecificFieldsRejected.includes('adapterSessionId'));
  for (const forbidden of [PROVIDER_TRANSCRIPT_SENTINEL, PROVIDER_CONTEXT_SENTINEL, 'worker.practice-native-1']) {
    assert.equal(serialized.includes(forbidden), false, `provider-specific state leaked: ${forbidden}`);
  }

  await expectContextError(materializer.materialize({ ...request, projectId: otherProject.projectId }), 'scope-mismatch');
  await expectContextError(materializer.materialize({ ...request, rootMissionId: otherRoot.taskId }), 'scope-mismatch');
  await expectContextError(materializer.materialize({ ...request, missionId: cognitionA.taskId }), 'session-mismatch');
  await expectContextError(materializer.materialize({ ...request, managedSessionId: unbound.managedSessionId }), 'session-mismatch');
  await tasks.withMissionFinalizationStabilization(practice.taskId, async () => {
    await expectContextError(materializer.materialize(request), 'finalizing-mission');
  });
  await tasks.finalizeMissionStrict(terminalMission.taskId, { handoffRequired: false });
  await expectContextError(materializer.materialize({ ...request, missionId: terminalMission.taskId, managedSessionId: 'does-not-matter-for-terminal' }), 'terminal-mission');

  const mandatoryOverflow = await expectContextError(materializer.materialize({ ...request, budget: { maxChars: 128 } }), 'budget-incompatibility');
  assert.ok(mandatoryOverflow.inspector.incompatibility?.itemId, 'mandatory overflow must identify the incompatible item');
  const sectionOverflow = await expectContextError(materializer.materialize({ ...request, budget: { maxChars: 60_000, sectionChars: { instructions: 64 } } }), 'budget-incompatibility');
  assert.equal(sectionOverflow.inspector.incompatibility?.section, 'instructions');

  let prioritized;
  for (let budget = baseline.text.length - 1; budget >= 1_000; budget -= 100) {
    try {
      const candidate = await materializer.materialize({ ...request, budget: { maxChars: budget } });
      if (selected(candidate, 'exchange:problem-current') && selected(candidate, 'exchange:answer-current') && !selected(candidate, 'exchange:finding-old')) {
        prioritized = candidate;
        break;
      }
    } catch (error) {
      if (!(error instanceof MissionContextMaterializationError) || error.code !== 'budget-incompatibility') throw error;
    }
  }
  assert.ok(prioritized, 'tight deterministic budget should retain current Problem/Answer before lower-priority old Finding');
  assert.ok(prioritized.inspector.omitted.items.some(entry => entry.itemId === 'exchange:finding-old'));
  assert.equal(prioritized.inspector.exclusions.items.some(entry => entry.itemId === 'exchange:finding-old'), false);

  const afterFiles = {
    project: await fs.readdir(projectDirectory),
    task: await fs.readdir(taskDirectory),
    collaboration: await fs.readdir(collaborationDirectory),
  };
  assert.deepEqual(afterFiles, beforeFiles, 'materialization must not create a context/skill/capability routing journal');

  // Restart from durable owners and reconstruct the exact same materialization.
  const restartedProjects = new ProjectStore({ storageDirectory: projectDirectory });
  const restartedTasks = new TaskRuntime({ storageDirectory: taskDirectory });
  await Promise.all([restartedProjects.initialize(), restartedTasks.initialize()]);
  const restartedCollaboration = new MissionCollaborationStore({ storageDirectory: collaborationDirectory, projects: restartedProjects, tasks: restartedTasks });
  await restartedCollaboration.initialize();
  const restartedWorkers = new WorkerSessionManager({ taskBindings: restartedTasks, newId: ids(['managed-practice', 'managed-replacement']) });
  await restartedWorkers.register(new FakeAdapter('worker.practice'));
  const restartedBound = await restartedWorkers.createSession('worker.practice', { model: 'fake-model', contextHandle: PROVIDER_CONTEXT_SENTINEL }, practice.taskId);
  assert.equal(restartedBound.managedSessionId, 'managed-practice');
  const restartedMaterializer = new MissionContextMaterializer(restartedProjects, restartedTasks, restartedCollaboration, restartedWorkers);
  const replayed = await restartedMaterializer.materialize(request);
  assert.deepEqual(replayed.package, baseline.package);
  assert.equal(replayed.text, baseline.text);
  assert.deepEqual(replayed.inspector, baseline.inspector);

  // Replacement goes through existing Worker lifecycle/Task binding, then fresh materialization.
  await restartedWorkers.retire(restartedBound.managedSessionId, { reason: 'phase8-replacement-proof' });
  await expectContextError(restartedMaterializer.materialize(request), 'session-mismatch');
  await restartedWorkers.register(new FakeAdapter('worker.replacement'));
  const replacement = await restartedWorkers.createSession('worker.replacement', { model: 'fake-model', contextHandle: PROVIDER_CONTEXT_SENTINEL }, practice.taskId);
  assert.equal(replacement.managedSessionId, 'managed-replacement');
  const replacementResult = await restartedMaterializer.materialize({ ...request, managedSessionId: replacement.managedSessionId });
  assert.equal(replacementResult.package.workerId, 'worker.replacement');
  assert.ok(selected(replacementResult, `project-decision:${oldDecision.decisionId}`));
  const replacementSerialized = JSON.stringify(replacementResult);
  assert.equal(replacementSerialized.includes(PROVIDER_TRANSCRIPT_SENTINEL), false);
  assert.equal(replacementSerialized.includes(PROVIDER_CONTEXT_SENTINEL), false);
  assert.equal(replacementSerialized.includes('worker.practice-native-1'), false, 'replacement must not require old provider-native conversation identity');

  // Contract-level replay fixture: current TaskRuntime schema permits an exact
  // UNKNOWN/UNKNOWN execution projection even though today's public writer does
  // not expose a delivery-unknown transition. Materialization must preserve it.
  const taskJournal = path.join(taskDirectory, `${practice.taskId}.jsonl`);
  await fs.appendFile(taskJournal, `${JSON.stringify({
    version: 1,
    eventId: 'phase8-replay-unknown-delivery',
    taskId: practice.taskId,
    at: '2026-09-16T13:30:00.000Z',
    type: 'TaskExecutionRequested',
    payload: {
      execution: {
        executionId: 'exec-unknown-delivery',
        toolName: 'future-execution-owner',
        status: 'unknown',
        deliveryStatus: 'unknown',
        requestedAt: '2026-09-16T13:30:00.000Z',
        duplicateObservations: 0,
      },
    },
  })}\n`, 'utf8');
  const unknownProjects = new ProjectStore({ storageDirectory: projectDirectory });
  const unknownTasks = new TaskRuntime({ storageDirectory: taskDirectory });
  await Promise.all([unknownProjects.initialize(), unknownTasks.initialize()]);
  const unknownCollaboration = new MissionCollaborationStore({ storageDirectory: collaborationDirectory, projects: unknownProjects, tasks: unknownTasks });
  await unknownCollaboration.initialize();
  const unknownWorkers = new WorkerSessionManager({ taskBindings: unknownTasks, newId: ids(['managed-replacement']) });
  await unknownWorkers.register(new FakeAdapter('worker.replacement'));
  await unknownWorkers.createSession('worker.replacement', { model: 'fake-model', contextHandle: PROVIDER_CONTEXT_SENTINEL }, practice.taskId);
  const unknownResult = await new MissionContextMaterializer(unknownProjects, unknownTasks, unknownCollaboration, unknownWorkers)
    .materialize({ ...request, managedSessionId: 'managed-replacement' });
  const unknownDelivery = selected(unknownResult, 'execution:exec-unknown-delivery');
  assert.equal(unknownDelivery.content.status, 'unknown');
  assert.equal(unknownDelivery.content.deliveryStatus, 'unknown');

  console.log('[smoke] Phase 8 Mission Context Materializer scope/budget/staleness/profile/restart/provider-neutral proofs ok');
} finally {
  await Promise.all([
    fs.rm(projectDirectory, { recursive: true, force: true }),
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(collaborationDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
