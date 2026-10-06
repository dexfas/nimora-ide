import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-phase10-formation-'));
const bundlePath = path.join(tempRoot, 'project-formation-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { ProjectStore, PROJECT_JOURNAL } from './src/project-store.ts';
      export {
        buildProjectFormationReceipt,
        normalizeProjectFormationReceipt,
        projectFormationDigest,
      } from './src/project-contract.ts';
      export { ProjectFormationService, projectFormationRootSource, projectFormationRootMetadata } from './src/project-formation-service.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
    `,
    resolveDir: root,
    sourcefile: 'project-formation-smoke-entry.ts',
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
  buildProjectFormationReceipt,
  normalizeProjectFormationReceipt,
  projectFormationDigest,
  ProjectFormationService,
  projectFormationRootSource,
  projectFormationRootMetadata,
  TaskRuntime,
} = require(bundlePath);

let timeTick = 0;
const now = () => new Date(Date.UTC(2026, 8, 17, 12, 0, timeTick++));

function idFactory(prefix) {
  let token = 0;
  return () => `${prefix}-${++token}`;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function directory(name) {
  const value = path.join(tempRoot, name);
  await fs.mkdir(value, { recursive: true });
  return value;
}

async function environment(name) {
  const projectsDirectory = await directory(`${name}-projects`);
  const tasksDirectory = await directory(`${name}-tasks`);
  return {
    projectsDirectory,
    tasksDirectory,
    projects: new ProjectStore({ storageDirectory: projectsDirectory, newId: idFactory(`${name}-project`), now }),
    tasks: new TaskRuntime({ storageDirectory: tasksDirectory, newId: idFactory(`${name}-task`), now }),
  };
}

function semanticResult(overrides = {}) {
  return {
    project: {
      title: 'Static Personal Blog',
      goal: 'Deliver a static personal blog.',
      workspace: '/workspace/static-blog',
      ...(overrides.project ?? {}),
    },
    initialRoot: {
      goal: 'Implement and verify the bounded static personal blog.',
      plane: 'practice',
      missionType: 'automatic-project-root',
      completionCriteria: ['The static blog is implemented.', 'The bounded result is verified.'],
      contextSummary: 'Authorized current understanding: build only the bounded static personal blog.',
      constraints: ['Do not infer unrelated product features.', 'Use the intended workspace only.'],
      ...(overrides.initialRoot ?? {}),
    },
    authorization: {
      kind: 'clear-intent-cognition',
      ...(overrides.authorization ?? {}),
    },
  };
}

function receipt(formationId, overrides = {}) {
  return buildProjectFormationReceipt({ formationId, ...semanticResult(overrides) });
}

async function projectEvents(projectsDirectory) {
  const journal = await fs.readFile(path.join(projectsDirectory, PROJECT_JOURNAL), 'utf8');
  return journal.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function taskJournalEvents(tasksDirectory, taskId) {
  const journal = await fs.readFile(path.join(tasksDirectory, `${taskId}.jsonl`), 'utf8');
  return journal.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

async function withRealTaskAppendUnknownOnce(tasksDirectory, eventType, observeBeforeThrow, operation) {
  const originalAppendFile = fs.appendFile.bind(fs);
  let injected = false;
  fs.appendFile = async (...args) => {
    const result = await originalAppendFile(...args);
    const [file, data] = args;
    if (!injected && path.dirname(path.resolve(String(file))) === path.resolve(tasksDirectory)) {
      let event;
      try { event = JSON.parse(String(data).trim()); } catch { event = undefined; }
      if (event?.type === eventType) {
        injected = true;
        observeBeforeThrow?.(event);
        throw new Error(`INJECTED_REAL_APPEND_UNKNOWN_${eventType}`);
      }
    }
    return result;
  };
  try {
    const value = await operation();
    assert.equal(injected, true, `real append UNKNOWN must be injected for ${eventType}`);
    return value;
  } finally {
    fs.appendFile = originalAppendFile;
  }
}

function exactSourceMatches(task, source) {
  return task.source.kind === source.kind
    && task.source.key === source.key
    && task.source.workspace === source.workspace;
}

try {
  // Exact formation semantics: formationId is operation identity and is not part
  // of the content digest. A new explicit id with identical semantics is distinct.
  const baseReceipt = receipt('formation-base');
  const sameSemanticsNewId = receipt('formation-base-distinct-operation');
  assert.equal(baseReceipt.formationDigest, sameSemanticsNewId.formationDigest);
  assert.equal(projectFormationDigest(semanticResult()), baseReceipt.formationDigest);
  assert.deepEqual(normalizeProjectFormationReceipt(baseReceipt), baseReceipt);
  assert.throws(
    () => normalizeProjectFormationReceipt({ ...baseReceipt, formationDigest: `sha256:${'0'.repeat(64)}` }),
    /digest mismatch/,
  );

  // Strict live admission: unsupported/inherited/accessor/symbol/sparse/malformed
  // payloads never become Formation authority by normalization.
  assert.throws(
    () => buildProjectFormationReceipt({ formationId: 'raw-chat-not-authority', ...semanticResult(), rawUserIntent: '完成一个静态个人博客' }),
    /unsupported field: rawUserIntent/,
  );
  assert.throws(
    () => buildProjectFormationReceipt({
      formationId: 'undefined-field',
      ...semanticResult({ project: { title: undefined } }),
    }),
    /Project Formation title must be a string/,
  );

  const inheritedProject = Object.create({ providerSessionId: 'must-not-be-authority' });
  Object.assign(inheritedProject, semanticResult().project);
  assert.throws(
    () => buildProjectFormationReceipt({ formationId: 'prototype-field', ...semanticResult(), project: inheritedProject }),
    /plain own-data record/,
  );

  const accessorProject = { ...semanticResult().project };
  Object.defineProperty(accessorProject, 'goal', {
    enumerable: true,
    get() { throw new Error('FORMATION_ACCESSOR_MUST_NOT_RUN'); },
  });
  assert.throws(
    () => buildProjectFormationReceipt({ formationId: 'accessor-field', ...semanticResult(), project: accessorProject }),
    /must be an own data property/,
  );

  const symbolRoot = { ...semanticResult().initialRoot };
  symbolRoot[Symbol('hidden-reasoning')] = 'must-not-be-authority';
  assert.throws(
    () => buildProjectFormationReceipt({ formationId: 'symbol-field', ...semanticResult(), initialRoot: symbolRoot }),
    /unsupported symbol field/,
  );

  const sparseCriteria = new Array(2);
  sparseCriteria[0] = 'first criterion';
  assert.throws(
    () => buildProjectFormationReceipt({
      formationId: 'sparse-array',
      ...semanticResult({ initialRoot: { completionCriteria: sparseCriteria } }),
    }),
    /dense own data property/,
  );
  const inheritedCriteria = ['first criterion'];
  Object.setPrototypeOf(inheritedCriteria, { inheritedAuthority: 'must-not-be-used' });
  assert.throws(
    () => buildProjectFormationReceipt({
      formationId: 'array-prototype',
      ...semanticResult({ initialRoot: { completionCriteria: inheritedCriteria } }),
    }),
    /standard Array prototype/,
  );
  assert.throws(
    () => buildProjectFormationReceipt({
      formationId: 'malformed-authorization',
      ...semanticResult({ authorization: { kind: 'human-confirmed', providerSessionId: 'forbidden' } }),
    }),
    /unsupported field: providerSessionId/,
  );

  // Sequential idempotency, same-id changed semantics collision, and explicit
  // new-id same-content distinct Project births over the real Project journal.
  const identityEnv = await environment('identity');
  await identityEnv.projects.initialize();
  const identityReceipt = receipt('formation-identity');
  const identityFirst = await identityEnv.projects.ensureProjectFormation(identityReceipt);
  const identityRetry = await identityEnv.projects.ensureProjectFormation(identityReceipt);
  assert.equal(identityRetry.projectId, identityFirst.projectId);
  assert.equal((await projectEvents(identityEnv.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 1);
  await assert.rejects(
    () => identityEnv.projects.ensureProjectFormation(receipt('formation-identity', {
      initialRoot: { goal: 'Semantically changed root under the same operation identity.' },
    })),
    /identity\/content collision/,
  );
  await assert.rejects(
    () => identityEnv.projects.ensureProjectFormation(receipt('formation-identity', {
      project: { title: 'Semantically changed Project under the same operation identity.' },
    })),
    /identity\/content collision/,
  );
  await assert.rejects(
    () => identityEnv.projects.ensureProjectFormation(receipt('formation-identity', {
      authorization: { kind: 'human-confirmed' },
    })),
    /identity\/content collision/,
  );
  assert.equal(identityEnv.projects.getProjectByFormationId('formation-identity').projectId, identityFirst.projectId);
  assert.equal((await projectEvents(identityEnv.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 1);
  const distinct = await identityEnv.projects.ensureProjectFormation(receipt('formation-distinct-operation'));
  assert.notEqual(distinct.projectId, identityFirst.projectId);
  assert.equal(distinct.formationReceipt.formationDigest, identityFirst.formationReceipt.formationDigest);
  assert.equal(identityEnv.projects.listProjects().length, 2);

  // Concurrent same-id callers are serialized by ProjectStore's canonical
  // operation lane. A gate holds the first commit and proves no second append is
  // even admitted until the first operation releases.
  const concurrentEnv = await environment('concurrent');
  await concurrentEnv.projects.initialize();
  const originalConcurrentCommit = concurrentEnv.projects.commit.bind(concurrentEnv.projects);
  const firstCommitEntered = deferred();
  const releaseFirstCommit = deferred();
  let concurrentCommitCalls = 0;
  concurrentEnv.projects.commit = async event => {
    concurrentCommitCalls += 1;
    if (concurrentCommitCalls === 1) {
      firstCommitEntered.resolve();
      await releaseFirstCommit.promise;
    }
    return originalConcurrentCommit(event);
  };
  const concurrentReceipt = receipt('formation-concurrent');
  const concurrentFirstPromise = concurrentEnv.projects.ensureProjectFormation(concurrentReceipt);
  await firstCommitEntered.promise;
  const concurrentSecondPromise = concurrentEnv.projects.ensureProjectFormation(concurrentReceipt);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(concurrentCommitCalls, 1, 'second same-id formation must remain behind the owner operation lane');
  releaseFirstCommit.resolve();
  const [concurrentFirst, concurrentSecond] = await Promise.all([concurrentFirstPromise, concurrentSecondPromise]);
  assert.equal(concurrentFirst.projectId, concurrentSecond.projectId);
  assert.equal(concurrentCommitCalls, 1);
  assert.equal((await projectEvents(concurrentEnv.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 1);

  // Project persistence UNKNOWN: simulate lost acknowledgement after the durable
  // append. ensureProjectFormation must owner-reread by formationId and return the
  // already-born Project without allocating a replacement.
  const uncertainProjectEnv = await environment('uncertain-project');
  await uncertainProjectEnv.projects.initialize();
  const originalUncertainProjectCommit = uncertainProjectEnv.projects.commit.bind(uncertainProjectEnv.projects);
  let injectProjectUnknown = true;
  uncertainProjectEnv.projects.commit = async event => {
    await originalUncertainProjectCommit(event);
    if (injectProjectUnknown && event.type === 'ProjectCreated') {
      injectProjectUnknown = false;
      throw new Error('INJECTED_PROJECT_WRITE_UNKNOWN_AFTER_DURABLE_APPEND');
    }
  };
  const uncertainProjectReceipt = receipt('formation-project-unknown');
  const uncertainProject = await uncertainProjectEnv.projects.ensureProjectFormation(uncertainProjectReceipt);
  assert.equal(uncertainProject.projectId, uncertainProjectEnv.projects.getProjectByFormationId(uncertainProjectReceipt.formationId).projectId);
  assert.equal((await projectEvents(uncertainProjectEnv.projectsDirectory)).filter(event => event.type === 'ProjectCreated').length, 1);

  // Legacy ProjectCreated remains replay-valid and is not migrated/reinterpreted
  // as a formed Project.
  const legacyDirectory = await directory('legacy-projects');
  const legacyRow = {
    version: 1,
    eventId: 'legacy-created',
    projectId: 'legacy-project',
    at: '2026-09-01T00:00:00.000Z',
    type: 'ProjectCreated',
    payload: { title: 'Historical Project', goal: 'Preserve Phase 1-9 history.' },
  };
  const legacyText = `${JSON.stringify(legacyRow)}\n`;
  await fs.writeFile(path.join(legacyDirectory, PROJECT_JOURNAL), legacyText, 'utf8');
  const legacyProjects = new ProjectStore({ storageDirectory: legacyDirectory });
  await legacyProjects.initialize();
  assert.equal(legacyProjects.getProject('legacy-project').formationReceipt, undefined);
  assert.deepEqual(legacyProjects.listFormedProjects(), []);
  assert.equal(await fs.readFile(path.join(legacyDirectory, PROJECT_JOURNAL), 'utf8'), legacyText);

  // Replay strictness: malformed formation receipts/rows are ignored and cannot
  // create owner authority; a duplicate durable formationId cannot create a
  // second Project even when the second row is internally well-formed.
  const replayDirectory = await directory('strict-replay-projects');
  const replayReceipt = receipt('formation-replay-primary');
  const replayCreated = {
    version: 1,
    eventId: 'replay-primary-created',
    projectId: 'replay-primary-project',
    at: '2026-09-17T10:00:00.000Z',
    type: 'ProjectCreated',
    payload: {
      title: replayReceipt.project.title,
      goal: replayReceipt.project.goal,
      workspace: replayReceipt.project.workspace,
      formationReceipt: replayReceipt,
    },
  };
  const malformedUnsupported = structuredClone(replayCreated);
  malformedUnsupported.eventId = 'replay-malformed-unsupported';
  malformedUnsupported.projectId = 'replay-malformed-unsupported-project';
  malformedUnsupported.payload.formationReceipt = { ...replayReceipt, formationId: 'malformed-unsupported', providerTranscript: 'FORBIDDEN_TRANSCRIPT' };
  const malformedNested = structuredClone(replayCreated);
  malformedNested.eventId = 'replay-malformed-nested';
  malformedNested.projectId = 'replay-malformed-nested-project';
  malformedNested.payload.formationReceipt = {
    ...replayReceipt,
    formationId: 'malformed-nested',
    initialRoot: { ...replayReceipt.initialRoot, completionCriteria: [null] },
  };
  const malformedEnvelope = { ...structuredClone(replayCreated), eventId: 'replay-malformed-envelope', projectId: 'replay-malformed-envelope-project', unsupportedEnvelope: true };
  const duplicateReceipt = receipt('formation-replay-primary', { project: { title: 'Changed duplicate replay Project' } });
  const duplicateCreated = {
    version: 1,
    eventId: 'replay-duplicate-created',
    projectId: 'replay-duplicate-project',
    at: '2026-09-17T10:01:00.000Z',
    type: 'ProjectCreated',
    payload: {
      title: duplicateReceipt.project.title,
      goal: duplicateReceipt.project.goal,
      workspace: duplicateReceipt.project.workspace,
      formationReceipt: duplicateReceipt,
    },
  };
  await fs.writeFile(
    path.join(replayDirectory, PROJECT_JOURNAL),
    [replayCreated, malformedUnsupported, malformedNested, malformedEnvelope, duplicateCreated]
      .map(row => JSON.stringify(row)).join('\n') + '\n',
    'utf8',
  );
  const replayProjects = new ProjectStore({ storageDirectory: replayDirectory });
  await replayProjects.initialize();
  assert.equal(replayProjects.getProjectByFormationId('formation-replay-primary').projectId, 'replay-primary-project');
  assert.equal(replayProjects.getProject('replay-malformed-unsupported-project'), undefined);
  assert.equal(replayProjects.getProject('replay-malformed-nested-project'), undefined);
  assert.equal(replayProjects.getProject('replay-malformed-envelope-project'), undefined);
  assert.equal(replayProjects.getProject('replay-duplicate-project'), undefined);
  assert.equal(replayProjects.listFormedProjects().length, 1);

  // ProjectCreated+receipt / root absent is a legal reconstructible state. Fresh
  // owners after restart recover exactly one deterministic root from the receipt.
  const projectOnlyEnv = await environment('project-only-restart');
  await projectOnlyEnv.projects.initialize();
  const projectOnlyReceipt = receipt('formation-project-only-restart');
  const projectOnly = await projectOnlyEnv.projects.ensureProjectFormation(projectOnlyReceipt);
  assert.deepEqual(await fs.readdir(projectOnlyEnv.tasksDirectory), []);
  const restartedProjectOwner = new ProjectStore({ storageDirectory: projectOnlyEnv.projectsDirectory, newId: idFactory('project-only-restarted-project'), now });
  const restartedTaskOwner = new TaskRuntime({ storageDirectory: projectOnlyEnv.tasksDirectory, newId: idFactory('project-only-restarted-task'), now });
  const restartedService = new ProjectFormationService(restartedProjectOwner, restartedTaskOwner);
  const [recoveredProjectOnly] = await restartedService.recoverFormedProjectRoots();
  assert.equal(recoveredProjectOnly.project.projectId, projectOnly.projectId);
  assert.equal(recoveredProjectOnly.rootMission.mission.projectId, projectOnly.projectId);
  assert.equal(recoveredProjectOnly.rootMission.mission.rootMissionId, recoveredProjectOnly.rootMission.taskId);
  assert.equal(restartedTaskOwner.listTasks().length, 1);

  // Root TaskCreated / Mission metadata absent restart uses the same deterministic
  // source/task and configures it exactly rather than creating a second root.
  const taskOnlyEnv = await environment('task-only-restart');
  await taskOnlyEnv.projects.initialize();
  await taskOnlyEnv.tasks.initialize();
  const taskOnlyReceipt = receipt('formation-task-only-restart');
  const taskOnlyProject = await taskOnlyEnv.projects.ensureProjectFormation(taskOnlyReceipt);
  const taskOnlySource = projectFormationRootSource(taskOnlyProject);
  const preRestartRoot = await taskOnlyEnv.tasks.ensureTask(taskOnlySource, taskOnlyReceipt.initialRoot.goal);
  assert.equal(preRestartRoot.mission, undefined);
  const freshTaskOnlyProjects = new ProjectStore({ storageDirectory: taskOnlyEnv.projectsDirectory, newId: idFactory('task-only-fresh-project'), now });
  const freshTaskOnlyTasks = new TaskRuntime({ storageDirectory: taskOnlyEnv.tasksDirectory, newId: idFactory('task-only-fresh-task'), now });
  const freshTaskOnlyService = new ProjectFormationService(freshTaskOnlyProjects, freshTaskOnlyTasks);
  const [taskOnlyRecovered] = await freshTaskOnlyService.recoverFormedProjectRoots();
  assert.equal(taskOnlyRecovered.rootMission.taskId, preRestartRoot.taskId);
  assert.deepEqual(taskOnlyRecovered.rootMission.mission, projectFormationRootMetadata(taskOnlyRecovered.project, preRestartRoot.taskId));
  assert.equal(freshTaskOnlyTasks.listTasks().length, 1);

  // The normal core proves Project-first ordering and installs only exact root
  // metadata/context. No Coordinator/Worker/assignment/provider state is created.
  const normalEnv = await environment('normal-core');
  await normalEnv.projects.initialize();
  await normalEnv.tasks.initialize();
  const normalReceipt = receipt('formation-normal-core');
  const originalNormalEnsureTask = normalEnv.tasks.ensureTask.bind(normalEnv.tasks);
  normalEnv.tasks.ensureTask = async (...args) => {
    assert.ok(normalEnv.projects.getProjectByFormationId(normalReceipt.formationId), 'Project must already be durable before root ensure');
    const durableProjectRows = await projectEvents(normalEnv.projectsDirectory);
    assert.ok(durableProjectRows.some(event => event.type === 'ProjectCreated'
      && event.payload.formationReceipt?.formationId === normalReceipt.formationId), 'ProjectCreated+receipt must already exist on disk before root ensure');
    return originalNormalEnsureTask(...args);
  };
  const normalService = new ProjectFormationService(normalEnv.projects, normalEnv.tasks);
  const normalResult = await normalService.ensureFormation(normalReceipt);
  assert.equal(normalResult.rootMission.goal, normalReceipt.initialRoot.goal);
  assert.equal(normalResult.rootMission.mission.projectId, normalResult.project.projectId);
  assert.equal(normalResult.rootMission.mission.rootMissionId, normalResult.rootMission.taskId);
  assert.equal(normalResult.rootMission.mission.parentMissionId, undefined);
  assert.equal(normalResult.rootMission.context.summary, normalReceipt.initialRoot.contextSummary);
  assert.deepEqual(normalResult.rootMission.context.constraints, normalReceipt.initialRoot.constraints);
  assert.deepEqual(normalResult.rootMission.workerSessions, {});
  assert.deepEqual(normalResult.rootMission.executions, {});
  assert.equal(normalEnv.tasks.listTasks().length, 1);
  assert.equal('missionIds' in normalResult.project, false, 'formation receipt must not become a second Project→Mission registry');
  const normalJournalText = JSON.stringify(await projectEvents(normalEnv.projectsDirectory));
  for (const forbidden of ['rawUserIntent', 'providerTranscript', 'providerSessionId', 'workerSessionId', 'hiddenReasoning']) {
    assert.equal(normalJournalText.includes(forbidden), false, `durable Formation receipt must not contain ${forbidden}`);
  }

  // REAL append-boundary UNKNOWN: the filesystem append succeeds first, then the
  // same appendFile call throws before TaskRuntime can apply the durable event to
  // its in-memory projection. Each case must recover from canonical Task bytes.
  const createdUnknownEnv = await environment('append-unknown-created');
  await createdUnknownEnv.projects.initialize();
  await createdUnknownEnv.tasks.initialize();
  const createdUnknownReceipt = receipt('formation-append-unknown-created');
  const createdUnknownService = new ProjectFormationService(createdUnknownEnv.projects, createdUnknownEnv.tasks);
  let taskCountAtCreatedThrow = -1;
  let durablyCreatedTaskId;
  const createdUnknownResult = await withRealTaskAppendUnknownOnce(
    createdUnknownEnv.tasksDirectory,
    'TaskCreated',
    event => {
      durablyCreatedTaskId = event.taskId;
      taskCountAtCreatedThrow = createdUnknownEnv.tasks.listTasks().length;
    },
    () => createdUnknownService.ensureFormation(createdUnknownReceipt),
  );
  assert.equal(taskCountAtCreatedThrow, 0, 'TaskCreated bytes must exist before the live Task projection is installed');
  assert.equal(createdUnknownResult.rootMission.taskId, durablyCreatedTaskId, 'append-UNKNOWN must recover the original durable Task id');
  const createdUnknownFiles = (await fs.readdir(createdUnknownEnv.tasksDirectory)).filter(file => file.endsWith('.jsonl'));
  assert.deepEqual(createdUnknownFiles, [`${durablyCreatedTaskId}.jsonl`], 'TaskCreated UNKNOWN must not allocate a replacement Task journal');
  const createdUnknownEvents = await taskJournalEvents(createdUnknownEnv.tasksDirectory, durablyCreatedTaskId);
  assert.equal(createdUnknownEvents.filter(event => event.type === 'TaskCreated').length, 1);
  const createdUnknownSource = projectFormationRootSource(createdUnknownResult.project);
  const createdUnknownRestart = new TaskRuntime({ storageDirectory: createdUnknownEnv.tasksDirectory, newId: idFactory('append-unknown-created-restart'), now });
  await createdUnknownRestart.initialize();
  const createdUnknownRestartMatches = createdUnknownRestart.listTasks().filter(task => exactSourceMatches(task, createdUnknownSource));
  assert.equal(createdUnknownRestartMatches.length, 1, 'fresh owner restart must reconstruct exactly one deterministic source Task');
  assert.equal(createdUnknownRestartMatches[0].taskId, durablyCreatedTaskId, 'fresh restart must preserve the original durable Task id');
  assert.deepEqual(createdUnknownRestartMatches[0].mission, createdUnknownResult.rootMission.mission);
  assert.deepEqual(createdUnknownRestartMatches[0].context, createdUnknownResult.rootMission.context);

  const configureUnknownEnv = await environment('append-unknown-configure');
  await configureUnknownEnv.projects.initialize();
  await configureUnknownEnv.tasks.initialize();
  const configureUnknownReceipt = receipt('formation-append-unknown-configure');
  const configureUnknownProject = await configureUnknownEnv.projects.ensureProjectFormation(configureUnknownReceipt);
  const configureUnknownSource = projectFormationRootSource(configureUnknownProject);
  const configureUnknownRoot = await configureUnknownEnv.tasks.ensureTask(configureUnknownSource, configureUnknownReceipt.initialRoot.goal);
  const configureUnknownService = new ProjectFormationService(configureUnknownEnv.projects, configureUnknownEnv.tasks);
  let missionAtConfigureThrow = 'not-observed';
  const [configureUnknownResult] = await withRealTaskAppendUnknownOnce(
    configureUnknownEnv.tasksDirectory,
    'TaskMissionConfigured',
    () => { missionAtConfigureThrow = configureUnknownEnv.tasks.getTask(configureUnknownRoot.taskId)?.mission; },
    () => configureUnknownService.recoverFormedProjectRoots(),
  );
  assert.equal(missionAtConfigureThrow, undefined, 'TaskMissionConfigured bytes must exist before live Mission metadata is installed');
  const configureUnknownEvents = await taskJournalEvents(configureUnknownEnv.tasksDirectory, configureUnknownRoot.taskId);
  assert.equal(configureUnknownEvents.filter(event => event.type === 'TaskMissionConfigured').length, 1, 'configure UNKNOWN must not append duplicate Mission metadata');
  const configureUnknownRestart = new TaskRuntime({ storageDirectory: configureUnknownEnv.tasksDirectory, newId: idFactory('append-unknown-configure-restart'), now });
  await configureUnknownRestart.initialize();
  assert.deepEqual(configureUnknownRestart.getTask(configureUnknownRoot.taskId)?.mission, configureUnknownResult.rootMission.mission);

  const contextUnknownEnv = await environment('append-unknown-context');
  await contextUnknownEnv.projects.initialize();
  await contextUnknownEnv.tasks.initialize();
  const contextUnknownReceipt = receipt('formation-append-unknown-context');
  const contextUnknownProject = await contextUnknownEnv.projects.ensureProjectFormation(contextUnknownReceipt);
  const contextUnknownSource = projectFormationRootSource(contextUnknownProject);
  const contextUnknownRoot = await contextUnknownEnv.tasks.ensureTask(contextUnknownSource, contextUnknownReceipt.initialRoot.goal);
  await contextUnknownEnv.tasks.configureMission(
    contextUnknownRoot.taskId,
    projectFormationRootMetadata(contextUnknownProject, contextUnknownRoot.taskId),
  );
  const contextUnknownService = new ProjectFormationService(contextUnknownEnv.projects, contextUnknownEnv.tasks);
  let contextAtThrow;
  const [contextUnknownResult] = await withRealTaskAppendUnknownOnce(
    contextUnknownEnv.tasksDirectory,
    'TaskContextUpdated',
    () => { contextAtThrow = structuredClone(contextUnknownEnv.tasks.getTask(contextUnknownRoot.taskId)?.context); },
    () => contextUnknownService.recoverFormedProjectRoots(),
  );
  assert.equal(contextAtThrow?.summary, undefined, 'TaskContextUpdated bytes must exist before live initial context is installed');
  assert.deepEqual(contextAtThrow?.constraints, []);
  const contextUnknownEvents = await taskJournalEvents(contextUnknownEnv.tasksDirectory, contextUnknownRoot.taskId);
  assert.equal(contextUnknownEvents.filter(event => event.type === 'TaskContextUpdated').length, 1, 'context UNKNOWN must not append duplicate initial context');
  const contextUnknownRestart = new TaskRuntime({ storageDirectory: contextUnknownEnv.tasksDirectory, newId: idFactory('append-unknown-context-restart'), now });
  await contextUnknownRestart.initialize();
  assert.deepEqual(contextUnknownRestart.getTask(contextUnknownRoot.taskId)?.context, contextUnknownResult.rootMission.context);

  // Durable ambiguity under the deterministic source is corruption, not an
  // invitation to select one Task or mint a third replacement root.
  const ambiguousTaskDirectory = await directory('append-unknown-ambiguous-source-tasks');
  const ambiguousSource = { kind: 'mission', key: 'project-root:v1:ambiguous-project', workspace: '/workspace/static-blog' };
  const ambiguousRuntime = new TaskRuntime({ storageDirectory: ambiguousTaskDirectory, newId: idFactory('ambiguous-runtime'), now });
  await ambiguousRuntime.initialize();
  const ambiguousRows = ['ambiguous-root-a', 'ambiguous-root-b'].map((taskId, index) => ({
    version: 1,
    eventId: `ambiguous-created-${index + 1}`,
    taskId,
    at: `2026-09-17T11:0${index}:00.000Z`,
    type: 'TaskCreated',
    payload: { source: ambiguousSource, goal: 'Ambiguous deterministic root must fail closed.' },
  }));
  await Promise.all(ambiguousRows.map(row => fs.writeFile(path.join(ambiguousTaskDirectory, `${row.taskId}.jsonl`), `${JSON.stringify(row)}\n`, 'utf8')));
  await assert.rejects(
    () => ambiguousRuntime.rereadTaskBySource(ambiguousSource),
    /Durable Task source ambiguity/,
    'owner reread must fail closed on two durable Tasks claiming one deterministic source',
  );

  // Conflicting root Project membership/metadata cannot be overwritten by retry.
  const wrongMembershipEnv = await environment('wrong-membership');
  await wrongMembershipEnv.projects.initialize();
  await wrongMembershipEnv.tasks.initialize();
  const wrongMembershipReceipt = receipt('formation-wrong-membership');
  const wrongMembershipProject = await wrongMembershipEnv.projects.ensureProjectFormation(wrongMembershipReceipt);
  const wrongMembershipSource = projectFormationRootSource(wrongMembershipProject);
  const wrongMembershipTask = await wrongMembershipEnv.tasks.ensureTask(wrongMembershipSource, wrongMembershipReceipt.initialRoot.goal);
  await wrongMembershipEnv.tasks.configureMission(wrongMembershipTask.taskId, {
    ...projectFormationRootMetadata(wrongMembershipProject, wrongMembershipTask.taskId),
    projectId: 'different-project',
  });
  const wrongMembershipService = new ProjectFormationService(wrongMembershipEnv.projects, wrongMembershipEnv.tasks);
  await assert.rejects(() => wrongMembershipService.recoverFormedProjectRoots(), /different Project/);
  assert.equal(wrongMembershipEnv.tasks.getTask(wrongMembershipTask.taskId).mission.projectId, 'different-project');
  assert.equal(wrongMembershipEnv.tasks.listTasks().length, 1);

  // Conflicting root context likewise fails closed and remains untouched.
  const wrongContextEnv = await environment('wrong-context');
  await wrongContextEnv.projects.initialize();
  await wrongContextEnv.tasks.initialize();
  const wrongContextReceipt = receipt('formation-wrong-context');
  const wrongContextProject = await wrongContextEnv.projects.ensureProjectFormation(wrongContextReceipt);
  const wrongContextSource = projectFormationRootSource(wrongContextProject);
  const wrongContextTask = await wrongContextEnv.tasks.ensureTask(wrongContextSource, wrongContextReceipt.initialRoot.goal);
  await wrongContextEnv.tasks.configureMission(wrongContextTask.taskId, projectFormationRootMetadata(wrongContextProject, wrongContextTask.taskId));
  await wrongContextEnv.tasks.updateContext(wrongContextTask.taskId, {
    summary: 'Conflicting context that must not be overwritten.',
    constraints: ['Conflicting constraint'],
  });
  const wrongContextService = new ProjectFormationService(wrongContextEnv.projects, wrongContextEnv.tasks);
  await assert.rejects(() => wrongContextService.recoverFormedProjectRoots(), /initial context conflicts/);
  assert.equal(wrongContextEnv.tasks.getTask(wrongContextTask.taskId).context.summary, 'Conflicting context that must not be overwritten.');

  // Losing caller-side pre-Project state/formationId creates nothing. Recovery
  // has authority only from already-durable receipts and accepts no raw-text key.
  const lostIdentityEnv = await environment('lost-identity');
  const lostIdentityService = new ProjectFormationService(lostIdentityEnv.projects, lostIdentityEnv.tasks);
  assert.deepEqual(await lostIdentityService.recoverFormedProjectRoots(), []);
  assert.deepEqual(lostIdentityEnv.projects.listProjects(), []);
  assert.deepEqual(lostIdentityEnv.tasks.listTasks(), []);

  console.log(JSON.stringify({
    result: 'PASS',
    formationIdentity: 'same-id exact semantics converges; changed semantics rejects; new id is distinct',
    strictAdmission: 'unsupported/prototype/accessor/symbol/sparse/malformed live and replay inputs fail closed',
    recovery: 'Project-first deterministic root converges across restart/partial/UNKNOWN outcomes',
    ownership: 'ProjectStore receipt/index; TaskRuntime sole Mission membership/context/lifecycle',
    outOfScopeStateCreated: false,
  }, null, 2));
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
