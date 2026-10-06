import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const esbuild = require('esbuild');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-project-completion-'));
const bundle = path.join(directory, 'entry.cjs');
await esbuild.build({ entryPoints: [path.join(root, 'extensions/shuncode/src/nimora-project-completion.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const { NimoraProjectCompletionEntry, parseProjectCompletionReview, projectCompletionMissionFacts } = require(bundle);
const identity = { projectId: 'p', managedRootMissionId: 'r', coordinationMissionId: 'c', completionKey: 'k' };
for (const raw of [
  { verdict: 'ready', summary: 'all criteria verified' },
  { verdict: 'ready', summary: 'ok', instruction: { ...identity, projectId: 'other' } },
  { verdict: 'ready', summary: 'ok', instruction: { ...identity, replay: true } },
  { verdict: 'blocked', summary: 'no evidence', instruction: identity },
  { verdict: 'ready', summary: 'ok', instruction: identity, tool: 'apply_patch' },
]) assert.throws(() => parseProjectCompletionReview(JSON.stringify(raw), identity));
function harness(options: any = {}) {
  let reads = 0, sends = 0, reviews = 0, confirmations = 0;
  let saved: any;
  const ports = {
    previous: () => saved,
    read: async (projectId: string, completionKey: string) => {
      reads++;
      const tasks = structuredClone(options.tasks ?? []);
      if (options.contextDrift && reads > 1) tasks[0].context.constraints.push('new acceptance requirement');
      return { instruction: { ...identity, projectId, completionKey, managedRootMissionId: options.root ?? identity.managedRootMissionId },
        facts: { revision: options.stale && reads > 1 ? 2 : 1, missions: tasks.map(projectCompletionMissionFacts) } };
    },
    interpret: async (_: string, prompt: string) => {
      reviews++;
      if (options.wait) await options.wait;
      const evidence = JSON.parse(prompt.split('EVIDENCE:\n')[1]);
      const example = JSON.parse(prompt.split('this complete JSON response:\n')[1].split('\n')[0]);
      assert.deepEqual(example.instruction, evidence.instruction, 'the valid ready example must echo this review identity, including its new completion key');
      options.inspectReview?.(evidence, prompt);
      if (options.omitInstruction) return JSON.stringify({ verdict: 'ready', summary: 'all criteria verified' });
      return JSON.stringify(options.blocked ? { verdict: 'blocked', summary: 'missing proof' } : { verdict: 'ready', summary: 'all criteria verified', instruction: evidence.instruction });
    },
    confirm: async () => { confirmations++; return !options.cancel; },
    save: async (_: string, attempt: any) => { if (options.storageFailure) throw new Error('storage unavailable'); saved = attempt; },
    execute: async (attempt: any) => {
      assert.equal(saved.phase, 'consumed');
      assert.equal(saved.inputId, attempt.inputId);
      assert.notEqual(attempt.inputId, attempt.instruction.completionKey);
      sends++;
      if (options.unknown) throw new Error('provider outcome unknown');
      return options.noCompletion ? {} : { commandExecuted: true, postTurnCompletion: {
        ...attempt.instruction, kind: 'managed-scope-completion-result', projectId: options.wrongScope ? 'other' : attempt.instruction.projectId,
        root: { state: 'archived' }, coordinator: { state: options.partial ? 'completed' : 'archived' },
      } };
    },
  };
  const entry = new NimoraProjectCompletionEntry(ports);
  return { entry, stats: () => ({ sends, reviews, confirmations, saved }) };
}
try {
  const omitted = harness({ omitInstruction: true });
  await assert.rejects(omitted.entry.review('p'), /完成指令/);
  assert.equal(omitted.stats().reviews, 1, 'an omitted instruction never triggers an automatic review retry');
  assert.equal(omitted.stats().confirmations, 0, 'invalid ready replies cannot enter Human completion confirmation');
  assert.equal(omitted.stats().saved, undefined, 'invalid ready replies consume no completion command');
  assert.equal(omitted.stats().sends, 0, 'the host cannot fill in a missing completion instruction');
  const currentTask = {
    taskId: 'r', goal: 'Verify a result against the seed actually read', status: 'ready',
    mission: { projectId: 'p', rootMissionId: 'r', plane: 'cognition', completionCriteria: ['Two exact LF-terminated lines'] },
    context: { summary: 'This round uses the existing fixture', constraints: ['First line: ROOT_A_OK', 'Second line: seed=<exact first line of SEED.txt>'], decisions: [], relevantFiles: [] },
    eventCount: 6, lastEventId: 'root-context-event', inputAccessPolicies: {
      work: { inputId: 'read-patch-read', managedSessionId: 'practice-worker', allowedWorkspacePathPrefixes: ['SEED.txt', 'ROOT_A_RESULT.txt'], recordedAt: '2026-10-06T00:00:00.000Z' },
    }, executions: {}, artifacts: [],
  };
  const evidenceOptions: any = { tasks: [currentTask], inspectReview: (evidence: any, prompt: string) => {
    const facts = evidence.facts.missions[0];
    assert.deepEqual(facts.context.constraints, currentTask.context.constraints, 'data-dependent contents must reach the reviewer instead of being inferred from a run ID');
    assert.deepEqual(facts.inputAccessPolicies[0].allowedWorkspacePathPrefixes, ['SEED.txt', 'ROOT_A_RESULT.txt']);
    assert.match(prompt, /Prior conversation and Project titles\/identifiers are not additional criteria/);
  } };
  assert.equal((await harness(evidenceOptions).entry.review('p')).state, 'completed');
  const laterTask = structuredClone(currentTask);
  laterTask.taskId = 'root-b'; laterTask.mission.rootMissionId = 'root-b';
  laterTask.context.constraints = ['First line: ROOT_B_OK', 'Second line: seed=<exact first line of SEED.txt>'];
  laterTask.inputAccessPolicies.work.allowedWorkspacePathPrefixes = ['SEED.txt', 'ROOT_B_RESULT.txt'];
  const later = harness({ root: 'root-b', tasks: [laterTask], inspectReview: (evidence: any) => {
    assert.equal(evidence.instruction.managedRootMissionId, 'root-b');
    assert.deepEqual(evidence.facts.missions[0].context.constraints, laterTask.context.constraints);
    assert.deepEqual(evidence.facts.missions[0].inputAccessPolicies[0].allowedWorkspacePathPrefixes, ['SEED.txt', 'ROOT_B_RESULT.txt']);
  } });
  assert.equal((await later.entry.review('p')).state, 'completed', 'later-root evidence comes from its current Mission, not initial formation');
  const contextDrift = harness({ tasks: [currentTask], contextDrift: true });
  await assert.rejects(contextDrift.entry.review('p'), /记录已变化/);
  assert.equal(contextDrift.stats().sends, 0, 'changed content constraints invalidate the approved review before completion');
  const oversized = structuredClone(currentTask);
  oversized.context.summary = 'x'.repeat(48_000);
  const bounded = harness({ tasks: [oversized] });
  await assert.rejects(bounded.entry.review('p'), /超过有界上限/);
  assert.equal(bounded.stats().reviews, 0, 'context is never silently truncated to make a completion review fit');
  assert.equal(bounded.stats().sends, 0);
  for (const options of [{ cancel: true }, { blocked: true }]) {
    const h = harness(options);
    assert.equal((await h.entry.review('p')).state, options.cancel ? 'cancelled' : 'blocked');
    assert.equal(h.stats().sends, 0); assert.equal(h.stats().saved, undefined);
  }
  for (const options of [{ stale: true }, { storageFailure: true }]) {
    const h = harness(options); await assert.rejects(h.entry.review('p')); assert.equal(h.stats().sends, 0);
  }
  for (const options of [{ unknown: true }, { noCompletion: true }, { wrongScope: true }, { partial: true }, {}]) {
    const h = harness(options);
    if (options.unknown || options.noCompletion || options.wrongScope || options.partial) await assert.rejects(h.entry.review('p'));
    else assert.equal((await h.entry.review('p')).state, 'completed');
    assert.equal(h.stats().sends, 1);
    await assert.rejects(h.entry.review('p'), /已消费/);
    assert.equal(h.stats().sends, 1);
    assert.equal(h.stats().reviews, 1);
  }
  let release!: () => void;
  const rounds: any = {};
  const successive = harness(rounds);
  await successive.entry.review('p');
  rounds.root = 'root-b';
  assert.equal((await successive.entry.review('p')).state, 'completed');
  assert.equal(successive.stats().sends, 2, 'Project-level legacy latch must not block a different root');
  await assert.rejects(successive.entry.review('p'), /已消费/);
  assert.equal(successive.stats().sends, 2);
  const h = harness({ wait: new Promise<void>(done => { release = done; }) });
  const first = h.entry.review('p');
  await assert.rejects(h.entry.review('p'), /已有完成审核/);
  release(); await first; assert.equal(h.stats().sends, 1);
  console.log('Nimora Project completion ingress PASS: current-root context/path evidence, later-root criteria, context drift/size refusal, exact instruction, cancel, blocked, storage failure, single-flight and consumed-no-replay.');
} finally {
  assert.equal(path.dirname(directory), os.tmpdir());
  assert.ok(path.basename(directory).startsWith('nimora-project-completion-'));
  await fs.rm(directory, { recursive: true, force: true });
}
