import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-coordinator-live-task-'));
const projectDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-coordinator-live-project-'));
const collaborationDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-coordinator-live-collaboration-'));
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-coordinator-live-bundle-'));
const bundlePath = path.join(bundleDirectory, 'mission-coordinator-live-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { ProjectStore } from './src/project-store.ts';
      export { TaskRuntime } from './src/task-runtime.ts';
      export { MissionCollaborationStore } from './src/mission-collaboration-store.ts';
      export {
        MissionFeedbackService,
        missionFeedbackCognitionSource,
        missionFeedbackSpawnedByRelationId,
      } from './src/mission-feedback-service.ts';
      export {
        MissionCoordinatorService,
        missionCoordinatorBootstrapSource,
        missionCoordinatorEnsureMissionSource,
      } from './src/mission-coordinator-service.ts';
      export { MissionCoordinatorLiveDriver } from './src/mission-coordinator-live-driver.ts';
      export { missionCoordinatorCommandCapabilityName, buildMissionCoordinatorWorkerInput } from './src/mission-coordinator-worker-input.ts';
      export { WorkerSessionManager } from './src/worker-session-manager.ts';
      export { buildRenderedContextHandoff } from './src/context-handoff.ts';
      export { ProjectDecisionService } from './src/project-decision-service.ts';
      export { HostCapabilityAuthorizationError } from './src/host-capability-policy-authorizer.ts';
    `,
    resolveDir: root,
    sourcefile: 'mission-coordinator-live-smoke-entry.ts',
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
  MissionFeedbackService,
  missionFeedbackCognitionSource,
  missionFeedbackSpawnedByRelationId,
  MissionCoordinatorService,
  missionCoordinatorBootstrapSource,
  missionCoordinatorEnsureMissionSource,
  MissionCoordinatorLiveDriver,
  missionCoordinatorCommandCapabilityName,
  buildMissionCoordinatorWorkerInput,
  WorkerSessionManager,
  buildRenderedContextHandoff,
  ProjectDecisionService,
  HostCapabilityAuthorizationError,
} = require(bundlePath);

const OLD_TRANSCRIPT_SENTINEL = 'PHASE6_OLD_COORDINATOR_PROVIDER_TRANSCRIPT_MUST_NOT_REPLAY';
const OLD_MODEL_SENTINEL = 'phase6-old-coordinator-model-must-not-reconstruct';
const OLD_PROVIDER_SESSION_SENTINEL = 'phase6-old-provider-session-1';
const TARGET_OUTPUT_SENTINEL = 'PHASE6_TARGET_PROVIDER_RAW_OUTPUT_MUST_NOT_REACH_COORDINATOR';
const createWebMcpPageCore = runInNewContext(
  await fs.readFile(path.resolve(root, 'extensions', 'shuncode-webmcp', 'webmcp-page-core.js'), 'utf8'),
  Object.create(null),
);
let projectId = 0;
let taskId = 0;
let tick = 0;
let managedId = 0;
const newProjectId = () => `phase6-live-project-${++projectId}`;
const newTaskId = () => `phase6-live-task-${++taskId}`;
const newManagedId = () => `phase6-live-managed-${++managedId}`;
const now = () => new Date(Date.UTC(2026, 8, 15, 14, 0, tick++));

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function durableSnapshot(directories) {
  const snapshot = {};
  for (const directory of directories) {
    const entries = (await fs.readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
      .sort();
    for (const file of entries) snapshot[`${path.basename(directory)}/${file}`] = await fs.readFile(path.join(directory, file), 'utf8');
  }
  return snapshot;
}

class Phase6LiveFakeAdapter {
  constructor(id, prefix) {
    this.id = id;
    this.prefix = prefix;
  }

  nextSession = 0;
  inputs = [];
  submittedResults = [];
  plans = new Map();
  providerTranscripts = new Map();
  providerTexts = new Map();
  providerParsedCallCounts = new Map();
  pendingResults = new Map();
  forcedSessionId = undefined;
  interrupts = 0;
  continuedAfterDenial = 0;

  async describe() {
    return {
      id: this.id,
      provider: `fake:${this.id}`,
      kind: 'api',
      label: `Phase 6 fake ${this.id}`,
      availability: 'available',
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
    const sessionId = this.forcedSessionId ?? `${this.prefix}-${++this.nextSession}`;
    this.forcedSessionId = undefined;
    const at = new Date().toISOString();
    return {
      sessionId,
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
    session.lastActiveAt = new Date().toISOString();
    this.inputs.push(structuredClone(input));
    const plan = this.plans.get(input.inputId) ?? (input.externalCapabilities?.length ? { mode: 'exact-command' } : { mode: 'plain-complete' });
    try {
      if (plan.mode === 'terminal-error-before-command') {
        yield { type: 'terminal', inputId: input.inputId, status: 'error', error: plan.error };
        return;
      }
      if (plan.mode === 'preapproval-denied') {
        const gate = deferred();
        this.pendingResults.set(`${input.inputId}\u0000denied-call`, gate);
        yield { type: 'capability_call', inputId: input.inputId, callId: 'denied-call', name: 'send_command_input',
          arguments: { command_id: 'not-approved', input: 'write again' }, dispatch: 'host-requested',
          extensions: { executionId: 'denied-execution' } };
        await gate.promise;
        if (session.state === 'interrupted') {
          yield { type: 'terminal', inputId: input.inputId, status: 'cancelled' };
          return;
        }
        this.continuedAfterDenial++;
        yield { type: 'capability_call', inputId: input.inputId, callId: 'must-not-execute', name: 'run_command',
          arguments: { command: 'must-not-execute', background: false }, dispatch: 'host-requested',
          extensions: { executionId: 'must-not-execute' } };
      }
      if (plan.mode === 'unknown-before-command') {
        yield { type: 'text_delta', inputId: input.inputId, text: 'provider-may-have-observed-command' };
        throw new Error('INJECTED_PHASE6_UNKNOWN_COORDINATOR_SEND');
      }
      if (plan.mode === 'plain-unknown') {
        yield { type: 'text_delta', inputId: input.inputId, text: 'provider-may-have-observed-input' };
        throw new Error('INJECTED_PHASE6_UNKNOWN_TARGET_SEND');
      }
      if (input.externalCapabilities?.length) {
        const exposed = input.externalCapabilities[0];
        const callId = `call-${input.inputId}`;
        const expectedArguments = structuredClone(exposed.inputSchema?.const);
        let callName = plan.callName ?? (plan.mode === 'wrong-kind' ? 'nimora.coordinator.routePracticeProblem' : exposed.name);
        let callArguments = Object.prototype.hasOwnProperty.call(plan, 'argumentsOverride')
          ? plan.argumentsOverride
          : (plan.mode === 'mutated-args'
              ? { ...expectedArguments, goal: 'MUTATED BY WORKER' }
              : expectedArguments);
        const callInputId = plan.inputIdOverride ?? input.inputId;
        const callDispatch = plan.dispatch ?? 'host-requested';
        if (
          plan.mode === 'deepseek-text-roundtrip'
          || plan.mode === 'deepseek-text-cross-realm-roundtrip'
          || plan.mode === 'deepseek-text-extra-semantic-args'
          || plan.mode === 'deepseek-text-proto-path'
          || plan.mode === 'deepseek-text-constructor-prototype-path'
        ) {
          const providerSemanticText = [
            'header',
            '',
            'step one',
            '',
            'step two',
            '',
            'step three',
          ].join('\n');
          const toolLines = [
            '[SHUNCODE_TOOL]',
            `id=${callId}`,
            `name=${exposed.name}`,
          ];
          if (plan.mode === 'deepseek-text-extra-semantic-args') {
            toolLines.push(
              'arg.instruction<<EOF',
              providerSemanticText,
              'EOF',
            );
          } else if (plan.mode === 'deepseek-text-proto-path') {
            toolLines.push('arg.__proto__.phase11R17Polluted=yes');
          } else if (plan.mode === 'deepseek-text-constructor-prototype-path') {
            toolLines.push('arg.constructor.prototype.phase11R17Polluted=yes');
          }
          toolLines.push('[/SHUNCODE_TOOL]');
          const providerText = [providerSemanticText, '', ...toolLines].join('\n');
          this.providerTexts.set(input.inputId, providerText);
          const parsedCalls = createWebMcpPageCore().extractCalls(providerText);
          this.providerParsedCallCounts.set(input.inputId, parsedCalls.length);
          if (
            plan.mode === 'deepseek-text-proto-path'
            || plan.mode === 'deepseek-text-constructor-prototype-path'
          ) {
            if (!parsedCalls.length) {
              yield { type: 'terminal', inputId: input.inputId, status: 'completed' };
              return;
            }
          } else {
            assert.equal(parsedCalls.length, 1, 'DeepSeek-style text boundary must expose exactly one parsed invocation');
          }
          callName = parsedCalls[0].name;
          callArguments = plan.mode === 'deepseek-text-roundtrip' || plan.mode === 'deepseek-text-extra-semantic-args'
            ? structuredClone(parsedCalls[0].arguments)
            : parsedCalls[0].arguments;
        }
        const gate = deferred();
        this.pendingResults.set(`${input.inputId}\u0000${callId}`, gate);
        yield {
          type: 'capability_call',
          inputId: callInputId,
          callId,
          name: callName,
          arguments: callArguments,
          dispatch: callDispatch,
          ...(plan.occurrenceId ? { extensions: { occurrenceId: plan.occurrenceId } } : {}),
        };
        const result = await gate.promise;
        yield {
          type: 'capability_result',
          inputId: input.inputId,
          callId,
          name: callName,
          text: result.text,
          isError: result.isError,
          ...(result.extensions ? { extensions: structuredClone(result.extensions) } : {}),
        };
        if (plan.mode === 'second-command') {
          const secondCallId = `${callId}-second`;
          const secondGate = deferred();
          this.pendingResults.set(`${input.inputId}\u0000${secondCallId}`, secondGate);
          yield {
            type: 'capability_call',
            inputId: input.inputId,
            callId: secondCallId,
            name: callName,
            arguments: structuredClone(callArguments),
            dispatch: 'host-requested',
          };
          const secondResult = await secondGate.promise;
          yield {
            type: 'capability_result',
            inputId: input.inputId,
            callId: secondCallId,
            name: callName,
            text: secondResult.text,
            isError: secondResult.isError,
            ...(secondResult.extensions ? { extensions: structuredClone(secondResult.extensions) } : {}),
          };
        }
        yield { type: 'terminal', inputId: input.inputId, status: 'completed' };
        return;
      }
      if (plan.mode === 'plain-transcript-sentinel') {
        yield { type: 'text_delta', inputId: input.inputId, text: `target text ${TARGET_OUTPUT_SENTINEL}` };
        yield { type: 'reasoning_delta', inputId: input.inputId, text: `target reasoning ${TARGET_OUTPUT_SENTINEL}` };
        yield { type: 'provider_event', inputId: input.inputId, name: 'raw-target-provider-event', data: { sentinel: TARGET_OUTPUT_SENTINEL } };
      } else {
        yield { type: 'text_delta', inputId: input.inputId, text: 'explicit-live-input-observed' };
      }
      if (plan.mode === 'terminal-error') {
        yield { type: 'terminal', inputId: input.inputId, status: 'error', error: plan.error ?? 'INJECTED_TARGET_TERMINAL_ERROR' };
      } else {
        yield { type: 'terminal', inputId: input.inputId, status: plan.mode === 'terminal-interrupted' ? 'interrupted' : 'completed' };
      }
    } finally {
      session.state = 'idle';
      session.lastActiveAt = new Date().toISOString();
      for (const key of [...this.pendingResults.keys()]) {
        if (key.startsWith(`${input.inputId}\u0000`)) this.pendingResults.delete(key);
      }
    }
  }

  async submitCapabilityResult(session, result) {
    this.submittedResults.push({ sessionId: session.sessionId, result: structuredClone(result) });
    if (this.plans.get(result.inputId)?.mode === 'fail-result-delivery') throw new Error('INJECTED_COORDINATOR_RESULT_DELIVERY_FAILURE');
    const key = `${result.inputId}\u0000${result.callId}`;
    const gate = this.pendingResults.get(key);
    if (!gate) throw new Error(`Missing fake provider capability gate: ${key}`);
    this.pendingResults.delete(key);
    gate.resolve(structuredClone(result));
  }

  async interrupt(session) { this.interrupts++; session.state = 'interrupted'; }
  async dispose(session) { session.state = 'disposed'; }
  async health() { return { status: 'healthy', checkedAt: new Date().toISOString() }; }
}

async function configureManagedRoot(tasks, project) {
  const task = await tasks.ensureTask({ kind: 'mission', key: 'phase6-live-managed-root' }, 'Own Phase 6 explicit bridge semantics.');
  return tasks.configureMission(task.taskId, {
    projectId: project.projectId,
    rootMissionId: task.taskId,
    plane: 'cognition',
    missionType: 'phase6-live-cognition-root',
    completionCriteria: ['Explicit Coordinator bridge behavior is decided by Cognition.'],
  });
}

try {
  const projectsA = new ProjectStore({ storageDirectory: projectDirectory, newId: newProjectId, now });
  const tasksA = new TaskRuntime({ storageDirectory: taskDirectory, newId: newTaskId, now });
  await Promise.all([projectsA.initialize(), tasksA.initialize()]);
  const project = await projectsA.createProject({ title: 'Phase 6 live explicit bridge Worker transport' });
  const rootMission = await configureManagedRoot(tasksA, project);
  const scope = { projectId: project.projectId, managedRootMissionId: rootMission.taskId };
  const collaborationA = new MissionCollaborationStore({ storageDirectory: collaborationDirectory, projects: projectsA, tasks: tasksA, now });
  await collaborationA.initialize();
  const feedbackA = new MissionFeedbackService(projectsA, tasksA, collaborationA);
  const coordinatorA = new MissionCoordinatorService(projectsA, tasksA, collaborationA, feedbackA);
  const decisionsA = new ProjectDecisionService(projectsA, tasksA);
  const coordinatorMission = await coordinatorA.ensureCoordinatorMission(scope);
  assert.equal(coordinatorMission.mission?.plane, 'coordination');
  assert.deepEqual(coordinatorMission.source, missionCoordinatorBootstrapSource(scope));

  const coordinatorAdapterA = new Phase6LiveFakeAdapter('worker.phase6.coordinator-a', 'phase6-coordinator-a-provider');
  coordinatorAdapterA.forcedSessionId = OLD_PROVIDER_SESSION_SENTINEL;
  coordinatorAdapterA.providerTranscripts.set(OLD_PROVIDER_SESSION_SENTINEL, OLD_TRANSCRIPT_SENTINEL);
  const practiceAdapterA = new Phase6LiveFakeAdapter('worker.phase6.practice-a', 'phase6-practice-a-provider');
  const cognitionAdapterA = new Phase6LiveFakeAdapter('worker.phase6.cognition-a', 'phase6-cognition-a-provider');
  const managerA = new WorkerSessionManager({ taskBindings: tasksA, newId: newManagedId, now });
  await managerA.register(coordinatorAdapterA);
  await managerA.register(practiceAdapterA);
  await managerA.register(cognitionAdapterA);
  const coordinatorSessionA = await managerA.createSession(coordinatorAdapterA.id, { model: OLD_MODEL_SENTINEL }, coordinatorMission.taskId);
  assert.equal(coordinatorSessionA.adapterSessionId, OLD_PROVIDER_SESSION_SENTINEL);
  const rootCognitionSessionA = await managerA.createSession(cognitionAdapterA.id, { model: 'phase6-root-cognition-model-a' }, rootMission.taskId);
  const driverA = new MissionCoordinatorLiveDriver(projectsA, tasksA, collaborationA, coordinatorA, feedbackA, decisionsA, managerA);

  const practiceInstruction = {
    ...scope,
    operationKey: 'phase6-live-practice-v1',
    goal: 'Execute the exact Cognition-authored live bridge Practice Work Order.',
    parentMissionId: rootMission.taskId,
    plane: 'practice',
    missionType: 'phase6-live-practice',
    completionCriteria: ['Return bounded durable Reality facts without transcript inheritance.'],
  };
  const ensureCommand = { kind: 'ensureMission', arguments: practiceInstruction };
  const practiceSource = missionCoordinatorEnsureMissionSource(practiceInstruction);

  // Wrong Coordinator identity/session/scope all fail before provider send.
  const coordinatorInputsBeforePreflight = coordinatorAdapterA.inputs.length;
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: rootMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'wrong-coordinator-mission',
      command: ensureCommand,
    }),
    /not the exact managed Coordinator Mission/,
  );
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: rootCognitionSessionA.managedSessionId,
      inputId: 'wrong-coordinator-session',
      command: ensureCommand,
    }),
    /not Mission .*Coordinator|not Mission|bound to/,
  );
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      projectId: 'wrong-project',
      managedRootMissionId: rootMission.taskId,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'wrong-project-scope',
      command: ensureCommand,
    }),
    /Unknown Project|exact Project root/,
  );
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      projectId: scope.projectId,
      managedRootMissionId: coordinatorMission.taskId,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'wrong-root-scope',
      command: { ...ensureCommand, arguments: { ...practiceInstruction, managedRootMissionId: coordinatorMission.taskId } },
    }),
    /exact Project root|Managed root Mission/,
  );
  assert.equal(coordinatorAdapterA.inputs.length, coordinatorInputsBeforePreflight, 'preflight identity failures must happen before send');

  const coordinatorInputsBeforeUnsupported = coordinatorAdapterA.inputs.length;
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'unsupported-runtime-command',
      command: { kind: 'unsupported-live-command', arguments: scope },
    }),
    /Unsupported Coordinator semantic command kind: unsupported-live-command/,
    'unsupported runtime command kind must fail closed before provider send',
  );
  assert.equal(coordinatorAdapterA.inputs.length, coordinatorInputsBeforeUnsupported);
  assert.equal(missionCoordinatorCommandCapabilityName({ kind: 'deliverExplicitMissionInput', arguments: {} }), 'nimora.coordinator.deliverExplicitMissionInput');
  assert.equal(missionCoordinatorCommandCapabilityName({ kind: 'deliverMissionExchange', arguments: {} }), 'nimora.coordinator.deliverMissionExchange');
  assert.equal(missionCoordinatorCommandCapabilityName({ kind: 'deliverFeedbackContinuation', arguments: {} }), 'nimora.coordinator.deliverFeedbackContinuation');
  assert.equal(missionCoordinatorCommandCapabilityName({ kind: 'deliverCommittedDecision', arguments: {} }), 'nimora.coordinator.deliverCommittedDecision');
  assert.throws(
    () => missionCoordinatorCommandCapabilityName({ kind: 'definitely-unsupported', arguments: {} }),
    /Unsupported Coordinator semantic command kind/,
  );

  // Worker command-kind, turn, dispatch, or invocation-envelope mutation is
  // rejected before semantic mutation. Semantic arguments never come from the
  // provider invocation envelope.
  await Promise.all([projectsA.flush(), tasksA.flush(), collaborationA.flush()]);
  const durableBeforeWorkerMutation = await durableSnapshot([projectDirectory, taskDirectory, collaborationDirectory]);
  coordinatorAdapterA.plans.set('worker-wrong-command-kind', { mode: 'wrong-kind' });
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'worker-wrong-command-kind',
      command: ensureCommand,
    }),
    /unauthorized command kind/,
  );
  assert.equal(tasksA.findTaskBySource(practiceSource), undefined, 'wrong command kind must not create the Practice Mission');
  coordinatorAdapterA.plans.set('worker-wrong-input-turn', { inputIdOverride: 'different-provider-turn' });
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'worker-wrong-input-turn',
      command: ensureCommand,
    }),
    /different input turn/,
  );
  assert.equal(tasksA.findTaskBySource(practiceSource), undefined, 'wrong input turn must not create the Practice Mission');
  coordinatorAdapterA.plans.set('worker-non-host-requested', { dispatch: 'observed' });
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'worker-non-host-requested',
      command: ensureCommand,
    }),
    /must be host-requested/,
  );
  assert.equal(tasksA.findTaskBySource(practiceSource), undefined, 'non-host-requested semantic call must not create the Practice Mission');
  coordinatorAdapterA.plans.set('worker-mutated-command-args', { mode: 'mutated-args' });
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'worker-mutated-command-args',
      command: ensureCommand,
    }),
    /mutate the host-bound invocation envelope/,
  );
  assert.equal(tasksA.findTaskBySource(practiceSource), undefined, 'non-empty provider invocation arguments must not create the Practice Mission');
  await Promise.all([projectsA.flush(), tasksA.flush(), collaborationA.flush()]);
  assert.deepEqual(
    await durableSnapshot([projectDirectory, taskDirectory, collaborationDirectory]),
    durableBeforeWorkerMutation,
    'unauthorized Worker semantic calls must cause zero durable mutation',
  );

  // A second provider invocation in the same explicit Coordinator turn must not
  // receive the already-computed semantic result again. WebMCP occurrence
  // deduplication owns true transport replay; a fresh capability_call after the
  // first confirmed result is a new provider request and fails closed. This keeps
  // semantic execution exactly-once and also caps provider result sends at one.
  const oneSemanticInstruction = {
    ...practiceInstruction,
    operationKey: 'phase11-r9-one-semantic-only',
    goal: 'Prove the explicit Coordinator turn executes at most one exact semantic command.',
    missionType: 'phase11-r9-one-semantic-only',
  };
  const oneSemanticCommand = { kind: 'ensureMission', arguments: oneSemanticInstruction };
  const oneSemanticSource = missionCoordinatorEnsureMissionSource(oneSemanticInstruction);
  const submittedBeforeSecondSemantic = coordinatorAdapterA.submittedResults.length;
  coordinatorAdapterA.plans.set('coordinator-r9-second-semantic', { mode: 'second-command' });
  await assert.rejects(() => driverA.executeCoordinatorCommandTurn({
    ...scope,
    coordinationMissionId: coordinatorMission.taskId,
    managedSessionId: coordinatorSessionA.managedSessionId,
    inputId: 'coordinator-r9-second-semantic',
    command: oneSemanticCommand,
  }), /repeated explicit semantic command after confirmed result/);
  assert.ok(tasksA.findTaskBySource(oneSemanticSource), 'the exact semantic command must execute once across provider redelivery');
  assert.equal(
    coordinatorAdapterA.submittedResults.length,
    submittedBeforeSecondSemantic + 1,
    'a second provider invocation must not cause another provider result send',
  );
  assert.notEqual(
    managerA.getSession(coordinatorSessionA.managedSessionId)?.state,
    'running',
    'duplicate provider invocation failure must still release the running Worker lease',
  );

  // Worker A performs a real live semantic turn through the real Manager and
  // exact host-requested Coordinator capability.
  const ensuredTurnA = await driverA.executeCoordinatorCommandTurn({
    ...scope,
    coordinationMissionId: coordinatorMission.taskId,
    managedSessionId: coordinatorSessionA.managedSessionId,
    inputId: 'coordinator-a-ensure-practice',
    command: ensureCommand,
  });
  assert.equal(ensuredTurnA.commandExecuted, true);
  assert.ok(ensuredTurnA.events.some(event => event.type === 'capability_call'));
  assert.ok(ensuredTurnA.events.some(event => event.type === 'capability_result'));
  const legacyCoordinatorResult = coordinatorAdapterA.submittedResults.at(-1).result;
  assert.equal(
    legacyCoordinatorResult.extensions,
    undefined,
    'genuine legacy Coordinator capability routes must remain valid without fabricated occurrence authority',
  );
  const practiceMission = tasksA.findTaskBySource(practiceSource);
  assert.ok(practiceMission?.mission, 'exact live ensure command must create the explicitly authored Practice Mission');
  const practiceConfiguredEventCount = practiceMission.eventCount;
  assert.equal(coordinatorAdapterA.inputs.at(-1).externalCapabilities.length, 1, 'one command turn exposes exactly one semantic capability');
  assert.equal(coordinatorAdapterA.inputs.at(-1).history, undefined, 'Coordinator Worker input must not inject provider history');
  assert.match(coordinatorAdapterA.inputs.at(-1).prompt, /Fresh bounded managed-scope inspection/);
  const hugeInspection = {
    ...(await coordinatorA.inspectManagedScope(scope)),
    exchanges: Array.from({ length: 600 }, (_, index) => ({
      exchangeId: `historical-exchange-${index}-${'x'.repeat(120)}`,
      kind: 'Finding', sourceMissionId: rootMission.taskId, targetMissionId: practiceMission.taskId,
    })),
    relations: Array.from({ length: 600 }, (_, index) => ({
      relationId: `historical-relation-${index}-${'y'.repeat(120)}`,
      type: 'informs', sourceMissionId: rootMission.taskId, targetMissionId: practiceMission.taskId,
      basisExchangeId: `historical-exchange-${index}-${'x'.repeat(120)}`, derived: false,
    })),
  };
  const boundedCoordinatorInput = buildMissionCoordinatorWorkerInput({
    ...scope,
    coordinationMission: coordinatorMission,
    session: managerA.getSession(coordinatorSessionA.managedSessionId),
    inspection: hugeInspection,
    command: ensureCommand,
    inputId: 'coordinator-bounded-history-pressure',
  });
  assert(boundedCoordinatorInput.prompt.length < 48_000, 'historical collaboration growth must not overflow a fresh Coordinator command turn');
  assert.match(boundedCoordinatorInput.prompt, /"exchanges": 600/);
  assert.doesNotMatch(boundedCoordinatorInput.prompt, /historical-exchange-599/, 'unreferenced historical exchange ids stay in durable storage, not Coordinator prompt');

  // Transport helpers are no longer host-callable API. The canonical Work Order
  // path is Cognition-authored command -> Coordinator Worker capability -> exact
  // runtime validation -> explicitly supplied target WorkerSession.
  const practiceSessionA = await managerA.createSession(practiceAdapterA.id, { model: 'phase6-practice-model-a' }, practiceMission.taskId);
  const workOrderText = 'Cognition-authored WO: inspect Reality, implement only the bounded authorized slice, and return Evidence/Problem facts.';
  for (const hostDirectMethod of ['deliverExplicitMissionInput', 'deliverMissionExchange', 'deliverFeedbackContinuation', 'deliverCommittedDecision']) {
    assert.equal(typeof driverA[hostDirectMethod], 'undefined', `${hostDirectMethod} must not remain a host-direct public API`);
  }
  const workOrderArguments = {
    ...scope,
    coordinationMissionId: coordinatorMission.taskId,
    targetMissionId: practiceMission.taskId,
    managedSessionId: practiceSessionA.managedSessionId,
    inputId: 'practice-work-order-a',
    instructionKind: 'work-order',
    instruction: workOrderText,
    referenceIds: ['phase6-wo3-authority'],
  };
  const workOrderCommand = { kind: 'deliverExplicitMissionInput', arguments: workOrderArguments };
  const targetInputsBeforeTransportMutation = practiceAdapterA.inputs.length;

  for (const [turnId, plan] of [
    ['transport-wrong-command-kind', { mode: 'wrong-kind' }],
    ['transport-changed-session', { argumentsOverride: { ...workOrderArguments, managedSessionId: rootCognitionSessionA.managedSessionId } }],
    ['transport-changed-target', { argumentsOverride: { ...workOrderArguments, targetMissionId: rootMission.taskId } }],
    ['transport-changed-instruction', { argumentsOverride: { ...workOrderArguments, instruction: 'WORKER MUTATED THE COGNITION-AUTHORED INSTRUCTION' } }],
  ]) {
    coordinatorAdapterA.plans.set(turnId, plan);
    await assert.rejects(
      () => driverA.executeCoordinatorCommandTurn({
        ...scope,
        coordinationMissionId: coordinatorMission.taskId,
        managedSessionId: coordinatorSessionA.managedSessionId,
        inputId: turnId,
        command: workOrderCommand,
      }),
      /unauthorized command kind|mutate the host-bound invocation envelope/,
      `${turnId} must fail before target send`,
    );
    assert.equal(practiceAdapterA.inputs.length, targetInputsBeforeTransportMutation, `${turnId} must cause no target send`);
  }

  // R17 live falsifier regression: a DeepSeek-style text boundary may reformat
  // explanatory semantic text, but that text is never semantic authority. A
  // valid empty invocation envelope executes the exact host-authored command.
  const r17HostInstruction = [
    'header',
    '1. step one',
    '2. step two',
    '3. step three',
  ].join('\n');
  const r17TargetInputId = 'r17-host-authored-argument-authority';
  const r17Command = {
    kind: 'deliverExplicitMissionInput',
    arguments: {
      ...workOrderArguments,
      inputId: r17TargetInputId,
      instructionKind: 'r17-regression',
      instruction: r17HostInstruction,
    },
  };
  const r17TargetInputsBefore = practiceAdapterA.inputs.length;
  coordinatorAdapterA.plans.set('r17-deepseek-text-extra-semantic', { mode: 'deepseek-text-extra-semantic-args' });
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'r17-deepseek-text-extra-semantic',
      command: r17Command,
    }),
    /mutate the host-bound invocation envelope/,
    'DeepSeek text must not gain semantic authority by re-emitting reformatted command arguments',
  );
  assert.equal(practiceAdapterA.inputs.length, r17TargetInputsBefore, 'provider semantic arguments must be rejected before target send');
  const rejectedProviderText = coordinatorAdapterA.providerTexts.get('r17-deepseek-text-extra-semantic');
  assert.match(rejectedProviderText, /header\n\nstep one\n\nstep two\n\nstep three/);
  assert.doesNotMatch(rejectedProviderText, /1\. step one|2\. step two|3\. step three/);

  coordinatorAdapterA.plans.set('r17-deepseek-text-argumentless', { mode: 'deepseek-text-roundtrip' });
  const r17Turn = await driverA.executeCoordinatorCommandTurn({
    ...scope,
    coordinationMissionId: coordinatorMission.taskId,
    managedSessionId: coordinatorSessionA.managedSessionId,
    inputId: 'r17-deepseek-text-argumentless',
    command: r17Command,
  });
  assert.equal(r17Turn.commandExecuted, true, 'argumentless provider invocation must execute the host-bound command exactly once');
  assert.equal(practiceAdapterA.inputs.length, r17TargetInputsBefore + 1, 'valid argumentless invocation must send the exact target once');
  const r17ProviderCall = r17Turn.events.find(event => event.type === 'capability_call');
  assert.deepEqual(r17ProviderCall?.arguments, {}, 'provider-visible Coordinator invocation envelope must be exactly empty');
  const r17CoordinatorInput = coordinatorAdapterA.inputs.find(input => input.inputId === 'r17-deepseek-text-argumentless');
  assert.deepEqual(r17CoordinatorInput.externalCapabilities[0].inputSchema, { type: 'object', properties: {}, additionalProperties: false, const: {} }, 'Coordinator capability schema must expose no semantic command arguments and declare a provider-compatible object envelope');
  const r17TargetInput = practiceAdapterA.inputs.find(input => input.inputId === r17TargetInputId);
  assert.equal(
    r17TargetInput.prompt.includes(JSON.stringify(r17HostInstruction)),
    true,
    'target must receive the exact original host-authored multiline instruction without provider transcription',
  );
  const acceptedProviderText = coordinatorAdapterA.providerTexts.get('r17-deepseek-text-argumentless');
  assert.match(acceptedProviderText, /header\n\nstep one\n\nstep two\n\nstep three/);
  assert.doesNotMatch(acceptedProviderText, /1\. step one|2\. step two|3\. step three/);
  assert.equal(
    acceptedProviderText.includes(r17HostInstruction),
    false,
    'provider text may reformat the semantic explanation without becoming command authority',
  );

  const crossRealmTargetInputId = 'r17-host-authored-cross-realm-must-not-send';
  coordinatorAdapterA.plans.set('r17-deepseek-cross-realm-argumentless', { mode: 'deepseek-text-cross-realm-roundtrip' });
  const targetInputsBeforeCrossRealm = practiceAdapterA.inputs.length;
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'r17-deepseek-cross-realm-argumentless',
      command: {
        ...r17Command,
        arguments: { ...r17Command.arguments, inputId: crossRealmTargetInputId },
      },
    }),
    /mutate the host-bound invocation envelope/,
    'an uncanonicalized foreign-Realm empty object must not carry invocation authority into the host driver',
  );
  assert.equal(practiceAdapterA.inputs.length, targetInputsBeforeCrossRealm, 'uncanonicalized foreign-Realm invocation must cause zero Target sends');

  for (const [turnId, mode] of [
    ['r17-deepseek-proto-path', 'deepseek-text-proto-path'],
    ['r17-deepseek-constructor-prototype-path', 'deepseek-text-constructor-prototype-path'],
  ]) {
    const targetInputsBeforePrototypePath = practiceAdapterA.inputs.length;
    coordinatorAdapterA.plans.set(turnId, { mode });
    await assert.rejects(
      () => driverA.executeCoordinatorCommandTurn({
        ...scope,
        coordinationMissionId: coordinatorMission.taskId,
        managedSessionId: coordinatorSessionA.managedSessionId,
        inputId: turnId,
        command: r17Command,
      }),
      /without executing the explicit semantic command|mutate the host-bound invocation envelope/,
      `${mode} must reject before semantic execution`,
    );
    assert.equal(coordinatorAdapterA.providerParsedCallCounts.get(turnId), 0, `${mode} must be rejected by the real WebMCP line parser`);
    assert.equal(practiceAdapterA.inputs.length, targetInputsBeforePrototypePath, `${mode} must cause zero Target sends`);
  }

  let providerAccessorReads = 0;
  const symbolArguments = {};
  symbolArguments[Symbol('provider-semantic-argument')] = 'forbidden';
  const nonEnumerableArguments = {};
  Object.defineProperty(nonEnumerableArguments, 'hidden', { value: 'forbidden', enumerable: false });
  const inheritedArguments = Object.create({ polluted: 'forbidden' });
  const nullPrototypeArguments = Object.create(null);
  const foreignEmptyArguments = runInNewContext('({})', Object.create(null));
  const mutatedForeignArguments = runInNewContext(
    'Object.prototype.phase11R17ForeignPolluted = "forbidden"; ({})',
    Object.create(null),
  );
  const spoofPrototype = Object.create(null);
  for (const key of Reflect.ownKeys(Object.prototype)) {
    const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, key);
    const clone = {
      enumerable: descriptor.enumerable,
      configurable: descriptor.configurable,
    };
    if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      clone.writable = descriptor.writable;
      if (typeof descriptor.value === 'function') {
        clone.value = key === 'constructor'
          ? function Object() {}
          : function spoofedIntrinsicMethod() {};
      } else {
        clone.value = descriptor.value;
      }
    } else {
      clone.get = typeof descriptor.get === 'function'
        ? function spoofedIntrinsicGetter() { return undefined; }
        : undefined;
      clone.set = typeof descriptor.set === 'function'
        ? function spoofedIntrinsicSetter(_value) {}
        : undefined;
    }
    Object.defineProperty(spoofPrototype, key, clone);
  }
  const spoofPrototypeArguments = Object.create(spoofPrototype);
  const accessorArguments = {};
  Object.defineProperty(accessorArguments, 'semantic', {
    enumerable: true,
    get() {
      providerAccessorReads += 1;
      return 'must-not-run';
    },
  });
  for (const [suffix, argumentsOverride] of [
    ['null', null],
    ['undefined', undefined],
    ['primitive', 'not-an-object'],
    ['array', []],
    ['own-string-key', { instruction: 'provider semantic authority forbidden' }],
    ['own-symbol-key', symbolArguments],
    ['non-enumerable-own-key', nonEnumerableArguments],
    ['inherited-state', inheritedArguments],
    ['null-prototype-object', nullPrototypeArguments],
    ['foreign-realm-empty-object', foreignEmptyArguments],
    ['mutated-foreign-intrinsic-state', mutatedForeignArguments],
    ['descriptor-shape-spoof-prototype', spoofPrototypeArguments],
    ['own-accessor', accessorArguments],
  ]) {
    const turnId = `r17-envelope-shape-${suffix}`;
    const targetInputsBeforeInvalidEnvelope = practiceAdapterA.inputs.length;
    coordinatorAdapterA.plans.set(turnId, { argumentsOverride });
    await assert.rejects(
      () => driverA.executeCoordinatorCommandTurn({
        ...scope,
        coordinationMissionId: coordinatorMission.taskId,
        managedSessionId: coordinatorSessionA.managedSessionId,
        inputId: turnId,
        command: r17Command,
      }),
      /mutate the host-bound invocation envelope/,
      `${suffix} must not satisfy the exact empty invocation envelope`,
    );
    assert.equal(practiceAdapterA.inputs.length, targetInputsBeforeInvalidEnvelope, `${suffix} must cause zero Target sends`);
  }
  assert.equal(providerAccessorReads, 0, 'exact-envelope validation must reject own accessors without executing provider getters');
  console.log('[smoke] R17 exact-empty provenance negatives ok: foreign/spoof/mutated-prototype Target send delta=0; provider accessor reads=0');

  const coordinatorInputsBeforeWrongTransportCoordinator = coordinatorAdapterA.inputs.length;
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'transport-wrong-coordination-mission',
      command: { ...workOrderCommand, arguments: { ...workOrderArguments, coordinationMissionId: rootMission.taskId } },
    }),
    /transport command targets Coordination Mission/,
  );
  assert.equal(coordinatorAdapterA.inputs.length, coordinatorInputsBeforeWrongTransportCoordinator, 'wrong transport Coordinator identity must fail before Coordinator provider send');

  practiceAdapterA.plans.set(workOrderArguments.inputId, { mode: 'plain-transcript-sentinel' });
  const occurrenceAwareCoordinatorInputId = 'coordinator-a-deliver-work-order';
  const occurrenceAuthority = 'phase11-coordinator-occurrence-a';
  const coordinatorResultsBeforeOccurrenceAwareTurn = coordinatorAdapterA.submittedResults.length;
  const targetInputsBeforeOccurrenceAwareTurn = practiceAdapterA.inputs.length;
  coordinatorAdapterA.plans.set(occurrenceAwareCoordinatorInputId, {
    mode: 'exact-command',
    occurrenceId: occurrenceAuthority,
  });
  const workOrderTurn = await driverA.executeCoordinatorCommandTurn({
    ...scope,
    coordinationMissionId: coordinatorMission.taskId,
    managedSessionId: coordinatorSessionA.managedSessionId,
    inputId: occurrenceAwareCoordinatorInputId,
    command: workOrderCommand,
  });
  assert.equal(workOrderTurn.commandExecuted, true, 'occurrence-aware deliverExplicitMissionInput must execute its semantic command exactly once');
  assert.equal(
    practiceAdapterA.inputs.length,
    targetInputsBeforeOccurrenceAwareTurn + 1,
    'occurrence-aware deliverExplicitMissionInput semantic command must send the Target exactly once',
  );
  assert.equal(
    coordinatorAdapterA.submittedResults.length,
    coordinatorResultsBeforeOccurrenceAwareTurn + 1,
    'occurrence-aware Coordinator turn must submit exactly one capability result',
  );
  const occurrenceAwareCall = workOrderTurn.events.find(event => event.type === 'capability_call');
  assert.equal(occurrenceAwareCall?.extensions?.occurrenceId, occurrenceAuthority);
  const occurrenceAwareResult = coordinatorAdapterA.submittedResults.at(-1).result;
  assert.equal(occurrenceAwareResult.inputId, occurrenceAwareCoordinatorInputId, 'result inputId must preserve the original Coordinator input');
  assert.equal(occurrenceAwareResult.callId, `call-${occurrenceAwareCoordinatorInputId}`, 'result callId must preserve the original provider callId');
  assert.equal(occurrenceAwareResult.name, 'nimora.coordinator.deliverExplicitMissionInput', 'result capability name must preserve the original provider capability');
  assert.deepEqual(
    occurrenceAwareResult.extensions,
    { occurrenceId: occurrenceAuthority },
    'Driver must propagate only the exact admitted occurrence authority into the Coordinator capability result',
  );
  assert.ok(
    workOrderTurn.events.some(event => event.type === 'terminal' && event.status === 'completed'),
    'occurrence-aware Coordinator turn must reach a trustworthy completed terminal',
  );
  assert.deepEqual(workOrderTurn.commandResult, {
    version: 1,
    kind: 'coordinator-live-transport-observation',
    targetMissionId: practiceMission.taskId,
    inputId: workOrderArguments.inputId,
    terminalStatus: 'completed',
    observedEventKinds: ['provider_event', 'reasoning_delta', 'terminal', 'text_delta'],
    eventCount: 4,
  });
  assert.equal(coordinatorAdapterA.inputs.at(-1).externalCapabilities.length, 1);
  assert.equal(coordinatorAdapterA.inputs.at(-1).externalCapabilities[0].name, 'nimora.coordinator.deliverExplicitMissionInput');
  assert.match(practiceAdapterA.inputs.at(-1).prompt, new RegExp(workOrderText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(practiceAdapterA.inputs.at(-1).history, undefined);
  assert.doesNotMatch(JSON.stringify(workOrderTurn.commandResult), new RegExp(TARGET_OUTPUT_SENTINEL));
  assert.doesNotMatch(JSON.stringify(coordinatorAdapterA.submittedResults.at(-1)), new RegExp(TARGET_OUTPUT_SENTINEL));
  assert.doesNotMatch(JSON.stringify(coordinatorAdapterA.inputs), new RegExp(TARGET_OUTPUT_SENTINEL));

  // A Coordinator acknowledgement failure must not erase a trustworthy Target
  // terminal. The caller checkpoint happens first, exactly once, with no replay.
  const targetCountBeforeAckFailure = practiceAdapterA.inputs.length;
  const targetCheckpoints = [];
  coordinatorAdapterA.plans.set('coordinator-ack-fails-after-target', { mode: 'fail-result-delivery' });
  await assert.rejects(() => driverA.executeCoordinatorCommandTurn({
    ...scope, coordinationMissionId: coordinatorMission.taskId, managedSessionId: coordinatorSessionA.managedSessionId,
    inputId: 'coordinator-ack-fails-after-target', command: { ...workOrderCommand,
      arguments: { ...workOrderArguments, inputId: 'target-completed-before-ack-failure' } },
  }, undefined, async observation => {
    assert.equal(coordinatorAdapterA.submittedResults.some(row => row.result.inputId === 'coordinator-ack-fails-after-target'), false);
    targetCheckpoints.push(structuredClone(observation));
  }), /INJECTED_COORDINATOR_RESULT_DELIVERY_FAILURE/);
  assert.equal(targetCheckpoints.length, 1);
  assert.equal(targetCheckpoints[0].terminalStatus, 'completed');
  assert.equal(targetCheckpoints[0].inputId, 'target-completed-before-ack-failure');
  assert.equal(targetCheckpoints[0].targetMissionId, practiceMission.taskId);
  assert.equal(practiceAdapterA.inputs.length, targetCountBeforeAckFailure + 1);

  const onceCheckpoints = [];
  coordinatorAdapterA.plans.set('coordinator-checkpoint-duplicate', { mode: 'second-command' });
  const targetCountBeforeDuplicate = practiceAdapterA.inputs.length;
  await assert.rejects(() => driverA.executeCoordinatorCommandTurn({
    ...scope, coordinationMissionId: coordinatorMission.taskId, managedSessionId: coordinatorSessionA.managedSessionId,
    inputId: 'coordinator-checkpoint-duplicate', command: { ...workOrderCommand,
      arguments: { ...workOrderArguments, inputId: 'target-checkpoint-duplicate' } },
  }, undefined, async observation => { onceCheckpoints.push(observation); }), /repeated explicit semantic command after confirmed result/);
  assert.equal(onceCheckpoints.length, 1, 'duplicate invocation does not checkpoint or execute the Target twice');
  assert.equal(practiceAdapterA.inputs.length, targetCountBeforeDuplicate + 1);

  await assert.rejects(() => driverA.executeCoordinatorCommandTurn({
    ...scope, coordinationMissionId: coordinatorMission.taskId, managedSessionId: coordinatorSessionA.managedSessionId,
    inputId: 'coordinator-checkpoint-storage-fails', command: { ...workOrderCommand,
      arguments: { ...workOrderArguments, inputId: 'target-completed-checkpoint-storage-fails' } },
  }, undefined, async () => { throw new Error('TARGET_CHECKPOINT_STORAGE_FAILED'); }), /TARGET_CHECKPOINT_STORAGE_FAILED/);
  assert.equal(coordinatorAdapterA.submittedResults.some(row => row.result.inputId === 'coordinator-checkpoint-storage-fails'), false,
    'checkpoint failure cannot claim result delivery or replay the Target');

  const noCommandTargetCount = practiceAdapterA.inputs.length;
  for (const [suffix, providerError] of [['exact', 'DeepSeek admission failed: no-new-provider-user-identity'], ['bounded', 'X'.repeat(5000)]]) {
    const inputId = `coordinator-error-before-command-${suffix}`;
    coordinatorAdapterA.plans.set(inputId, { mode: 'terminal-error-before-command', error: providerError });
    await assert.rejects(() => driverA.executeCoordinatorCommandTurn({
      ...scope, coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId, inputId, command: workOrderCommand,
    }), error => {
      assert.match(error.message, /without executing the explicit semantic command \(terminal=error\)/);
      assert.ok(error.message.endsWith(providerError.slice(0, 4000)), 'Coordinator retains the bounded root transport error');
      assert.ok(error.message.length < 4200);
      return true;
    });
  }
  assert.equal(practiceAdapterA.inputs.length, noCommandTargetCount, 'diagnostics must not execute or resend the Target command');

  const terminalErrorTargetInputId = 'practice-terminal-error-observation';
  const terminalErrorCoordinatorInputId = 'coordinator-terminal-error-observation';
  practiceAdapterA.plans.set(terminalErrorTargetInputId, {
    mode: 'terminal-error',
    error: 'TARGET_TRANSPORT_EXACT_ERROR_FOR_COORDINATOR',
  });
  coordinatorAdapterA.plans.set(terminalErrorCoordinatorInputId, { mode: 'exact-command' });
  const terminalErrorTurn = await driverA.executeCoordinatorCommandTurn({
    ...scope,
    coordinationMissionId: coordinatorMission.taskId,
    managedSessionId: coordinatorSessionA.managedSessionId,
    inputId: terminalErrorCoordinatorInputId,
    command: {
      ...workOrderCommand,
      arguments: { ...workOrderArguments, inputId: terminalErrorTargetInputId },
    },
  });
  assert.equal(terminalErrorTurn.commandResult.terminalStatus, 'error');
  assert.equal(
    terminalErrorTurn.commandResult.terminalError,
    'TARGET_TRANSPORT_EXACT_ERROR_FOR_COORDINATOR',
    'Target terminal errors must survive the Coordinator transport observation instead of collapsing to status=error only',
  );
  assert.equal(
    coordinatorAdapterA.submittedResults.at(-1).result.data.terminalError,
    'TARGET_TRANSPORT_EXACT_ERROR_FOR_COORDINATOR',
    'Coordinator capability result must expose the exact bounded Target terminal error to the provider',
  );

  const targetInputsBeforeReject = practiceAdapterA.inputs.length;
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'coordinator-a-wrong-target-session',
      command: {
        kind: 'deliverExplicitMissionInput',
        arguments: { ...workOrderArguments, managedSessionId: rootCognitionSessionA.managedSessionId, inputId: 'wrong-target-session' },
      },
    }),
    /bound to .*not Mission|bound to/,
  );
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      projectId: 'wrong-project',
      managedRootMissionId: rootMission.taskId,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'coordinator-a-wrong-target-project',
      command: {
        kind: 'deliverExplicitMissionInput',
        arguments: { ...workOrderArguments, projectId: 'wrong-project', inputId: 'wrong-target-project' },
      },
    }),
    /Unknown Project|exact Project root/,
  );
  assert.equal(practiceAdapterA.inputs.length, targetInputsBeforeReject, 'wrong target/session/scope must reject before send');

  const terminalInstruction = {
    ...scope,
    operationKey: 'phase6-live-terminal-target',
    goal: 'Terminal target used only for live-delivery admission proof.',
    parentMissionId: rootMission.taskId,
    plane: 'practice',
    missionType: 'phase6-terminal-target',
    completionCriteria: ['Become terminal before attempted live delivery.'],
  };
  const terminalTarget = await coordinatorA.ensureMission(terminalInstruction);
  await tasksA.finalizeMissionStrict(terminalTarget.taskId, { handoffRequired: false });
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'coordinator-a-terminal-target-send',
      command: {
        kind: 'deliverExplicitMissionInput',
        arguments: {
          ...scope,
          coordinationMissionId: coordinatorMission.taskId,
          targetMissionId: terminalTarget.taskId,
          managedSessionId: practiceSessionA.managedSessionId,
          inputId: 'terminal-target-send',
          instructionKind: 'work-order',
          instruction: 'Must never send to terminal target.',
        },
      },
    }),
    /terminal \(completed\).*cannot receive live bridge work/,
  );
  assert.equal(practiceAdapterA.inputs.length, targetInputsBeforeReject, 'terminal target rejection must occur before send');

  // Practice returns bounded durable facts. Delivering them to the explicitly
  // designated owning Cognition Worker transports facts only; Problem observation
  // must not create feedback Cognition.
  const evidence = await collaborationA.recordExchange({
    exchangeId: 'phase6-live-evidence',
    projectId: project.projectId,
    sourceMissionId: practiceMission.taskId,
    kind: 'Evidence',
    payload: {
      summary: 'Practice observed the bounded live transport Reality.',
      references: [{ type: 'file', path: 'src/mission-coordinator-live-driver.ts', detail: 'Explicit session transport only.' }],
    },
  });
  const finding = await collaborationA.recordExchange({
    exchangeId: 'phase6-live-finding',
    projectId: project.projectId,
    sourceMissionId: practiceMission.taskId,
    targetMissionId: rootMission.taskId,
    kind: 'Finding',
    payload: { summary: 'Live bridge can carry bounded durable facts without transcript inheritance.', evidenceExchangeIds: [evidence.exchangeId] },
  });
  const problem = await collaborationA.recordExchange({
    exchangeId: 'phase6-live-problem',
    projectId: project.projectId,
    sourceMissionId: practiceMission.taskId,
    kind: 'Problem',
    payload: {
      currentGoal: practiceInstruction.goal,
      previousAssumption: 'Problem observation could authorize orchestration.',
      observedReality: 'Problem observation is transport-only until Cognition explicitly commands routePracticeProblem.',
      preciseQuestion: 'Should the existing deterministic feedback route be invoked?',
      blocking: true,
      evidenceExchangeIds: [evidence.exchangeId],
    },
  });
  const practiceInputsBeforeProblemMisroute = practiceAdapterA.inputs.length;
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'coordinator-a-problem-misroute',
      command: {
        kind: 'deliverMissionExchange',
        arguments: {
          ...scope,
          coordinationMissionId: coordinatorMission.taskId,
          exchangeId: problem.exchangeId,
          targetMissionId: practiceMission.taskId,
          managedSessionId: practiceSessionA.managedSessionId,
          inputId: 'problem-must-return-to-cognition',
        },
      },
    }),
    /must be transported back to an in-scope Cognition Mission/,
    'Problem transport must return to Cognition rather than becoming an arbitrary bridge message',
  );
  assert.equal(practiceAdapterA.inputs.length, practiceInputsBeforeProblemMisroute, 'Problem misroute must reject before send');
  const problemTransportArguments = {
    ...scope,
    coordinationMissionId: coordinatorMission.taskId,
    exchangeId: problem.exchangeId,
    targetMissionId: rootMission.taskId,
    managedSessionId: rootCognitionSessionA.managedSessionId,
    inputId: 'deliver-problem-to-cognition',
  };
  const cognitionInputsBeforeChangedExchange = cognitionAdapterA.inputs.length;
  coordinatorAdapterA.plans.set('transport-changed-exchange', {
    argumentsOverride: { ...problemTransportArguments, exchangeId: 'worker-mutated-exchange-id' },
  });
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'transport-changed-exchange',
      command: { kind: 'deliverMissionExchange', arguments: problemTransportArguments },
    }),
    /mutate the host-bound invocation envelope/,
  );
  assert.equal(cognitionAdapterA.inputs.length, cognitionInputsBeforeChangedExchange, 'changed exchangeId must cause no target send');

  for (const [turnId, exchangeId, targetInputId] of [
    ['coordinator-a-deliver-evidence', evidence.exchangeId, 'deliver-evidence-to-cognition'],
    ['coordinator-a-deliver-finding', finding.exchangeId, 'deliver-finding-to-cognition'],
    ['coordinator-a-deliver-problem', problem.exchangeId, 'deliver-problem-to-cognition'],
  ]) {
    const turn = await driverA.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: turnId,
      command: {
        kind: 'deliverMissionExchange',
        arguments: {
          ...scope,
          coordinationMissionId: coordinatorMission.taskId,
          exchangeId,
          targetMissionId: rootMission.taskId,
          managedSessionId: rootCognitionSessionA.managedSessionId,
          inputId: targetInputId,
        },
      },
    });
    assert.equal(turn.commandResult.kind, 'coordinator-live-transport-observation');
    assert.equal(turn.commandResult.targetMissionId, rootMission.taskId);
  }
  assert.match(cognitionAdapterA.inputs.at(-1).prompt, /phase6-live-problem/);
  assert.match(cognitionAdapterA.inputs.at(-1).prompt, /Problem observation is transport-only/);
  const feedbackIdentity = { projectId: project.projectId, practiceMissionId: practiceMission.taskId, problemExchangeId: problem.exchangeId };
  assert.equal(tasksA.findTaskBySource(missionFeedbackCognitionSource(feedbackIdentity)), undefined, 'Problem delivery alone must not create feedback Cognition');
  assert.equal(collaborationA.getRelation(missionFeedbackSpawnedByRelationId(feedbackIdentity)), undefined, 'Problem delivery alone must not create spawned_by provenance');

  // UNKNOWN is exercised on the repaired Coordinator-Worker -> target transport
  // path. Target provider may have observed input, but there is no durable ack or
  // automatic retry authority.
  await Promise.all([projectsA.flush(), tasksA.flush(), collaborationA.flush()]);
  const durableBeforeUnknown = await durableSnapshot([projectDirectory, taskDirectory, collaborationDirectory]);
  practiceAdapterA.plans.set('phase6-target-unknown-send', { mode: 'plain-unknown' });
  const targetSendsBeforeUnknown = practiceAdapterA.inputs.length;
  let unknownTargetCheckpoints = 0;
  await assert.rejects(
    () => driverA.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionA.managedSessionId,
      inputId: 'coordinator-a-target-unknown-command',
      command: {
        kind: 'deliverExplicitMissionInput',
        arguments: {
          ...workOrderArguments,
          inputId: 'phase6-target-unknown-send',
          instruction: 'Potentially observed target input; transport outcome must remain UNKNOWN.',
        },
      },
    }, undefined, async () => { unknownTargetCheckpoints++; }),
    /INJECTED_PHASE6_UNKNOWN_TARGET_SEND/,
  );
  assert.equal(unknownTargetCheckpoints, 0, 'unobserved terminal remains UNKNOWN; no invented checkpoint');
  assert.equal(practiceAdapterA.inputs.length, targetSendsBeforeUnknown + 1, 'UNKNOWN proof must actually reach the explicitly selected target Worker');
  await Promise.all([projectsA.flush(), tasksA.flush(), collaborationA.flush()]);
  assert.deepEqual(
    await durableSnapshot([projectDirectory, taskDirectory, collaborationDirectory]),
    durableBeforeUnknown,
    'UNKNOWN target transport command must not invent durable delivery acknowledgement or queue state',
  );
  const oldProviderSendCount = coordinatorAdapterA.inputs.length;
  const oldTargetSendCount = practiceAdapterA.inputs.length;
  assert.equal(coordinatorAdapterA.inputs.at(-1).inputId, 'coordinator-a-target-unknown-command');
  assert.equal(
    coordinatorAdapterA.submittedResults.some(row => row.result.inputId === 'coordinator-a-target-unknown-command'),
    false,
    'UNKNOWN target transport must not invent a Coordinator capability result',
  );

  // Flush durable owners, then reconstruct all semantic services and a fresh
  // WorkerSessionManager. Old Manager/driver/provider transcript objects are not
  // consulted by the replacement path.
  await Promise.all([projectsA.flush(), tasksA.flush(), collaborationA.flush()]);
  const projectsB = new ProjectStore({ storageDirectory: projectDirectory });
  const tasksB = new TaskRuntime({ storageDirectory: taskDirectory });
  const collaborationB = new MissionCollaborationStore({ storageDirectory: collaborationDirectory, projects: projectsB, tasks: tasksB });
  await Promise.all([projectsB.initialize(), tasksB.initialize(), collaborationB.initialize()]);
  const feedbackB = new MissionFeedbackService(projectsB, tasksB, collaborationB);
  const coordinatorB = new MissionCoordinatorService(projectsB, tasksB, collaborationB, feedbackB);
  const decisionsB = new ProjectDecisionService(projectsB, tasksB);
  const replayedCoordinator = await coordinatorB.ensureCoordinatorMission(scope);
  assert.equal(replayedCoordinator.taskId, coordinatorMission.taskId, 'Worker replacement must retain the exact same Coordination Mission identity');
  assert.equal(
    tasksB.listTasks().filter(task => task.source.kind === 'mission' && task.source.key === coordinatorMission.source.key).length,
    1,
    'replacement must not create Coordinator Mission 2',
  );

  const coordinatorAdapterB = new Phase6LiveFakeAdapter('worker.phase6.coordinator-b', 'phase6-coordinator-b-provider');
  const practiceAdapterB = new Phase6LiveFakeAdapter('worker.phase6.practice-b', 'phase6-practice-b-provider');
  const cognitionAdapterB = new Phase6LiveFakeAdapter('worker.phase6.cognition-b', 'phase6-cognition-b-provider');
  const managerB = new WorkerSessionManager({ taskBindings: tasksB, newId: newManagedId, now });
  await managerB.register(coordinatorAdapterB);
  await managerB.register(practiceAdapterB);
  await managerB.register(cognitionAdapterB);
  const coordinatorSessionB = await managerB.createSession(coordinatorAdapterB.id, { model: 'phase6-new-coordinator-model-b' }, coordinatorMission.taskId);
  const driverB = new MissionCoordinatorLiveDriver(projectsB, tasksB, collaborationB, coordinatorB, feedbackB, decisionsB, managerB);
  assert.equal(coordinatorAdapterB.inputs.length, 0, 'fresh Manager/replacement Worker must not auto-resend the previous UNKNOWN turn');
  assert.equal(practiceAdapterB.inputs.length, 0, 'fresh target Worker must not auto-resend the previous UNKNOWN target input');
  assert.equal(coordinatorAdapterA.inputs.length, oldProviderSendCount, 'reconstruction must not touch old provider memory');
  assert.equal(practiceAdapterA.inputs.length, oldTargetSendCount, 'reconstruction must not touch old target provider memory');

  const coordinatorHandoffB = buildRenderedContextHandoff(tasksB.getTask(coordinatorMission.taskId), {
    targetWorkerId: coordinatorAdapterB.id,
    generatedAt: '2026-09-15T14:30:00.000Z',
    maxWorkerSessions: 0,
  });
  assert.equal(coordinatorHandoffB.package.workerSessions.length, 0, 'replacement handoff excludes old Worker identity details');
  for (const sentinel of [OLD_TRANSCRIPT_SENTINEL, OLD_MODEL_SENTINEL, OLD_PROVIDER_SESSION_SENTINEL, TARGET_OUTPUT_SENTINEL]) {
    assert.doesNotMatch(coordinatorHandoffB.text, new RegExp(sentinel));
  }

  // A newly explicit retry converges on the same deterministic Practice Mission;
  // it is not an automatic replay of the uncertain turn.
  const replayedPracticeBeforeRetry = tasksB.findTaskBySource(practiceSource);
  assert.equal(replayedPracticeBeforeRetry.taskId, practiceMission.taskId);
  const retryEventCountBefore = replayedPracticeBeforeRetry.eventCount;
  const ensureRetryB = await driverB.executeCoordinatorCommandTurn({
    ...scope,
    coordinationMissionId: coordinatorMission.taskId,
    managedSessionId: coordinatorSessionB.managedSessionId,
    inputId: 'coordinator-b-explicit-ensure-retry',
    command: ensureCommand,
    contextHandoff: coordinatorHandoffB,
  });
  assert.equal(ensureRetryB.commandExecuted, true);
  assert.equal(tasksB.findTaskBySource(practiceSource).taskId, practiceMission.taskId);
  assert.equal(tasksB.findTaskBySource(practiceSource).eventCount, retryEventCountBefore, 'explicit deterministic ensure retry must not duplicate TaskMissionConfigured');
  assert.equal(coordinatorAdapterB.inputs.length, 1, 'replacement Worker receives only the newly explicit command');
  const replacementPrompt = coordinatorAdapterB.inputs[0].prompt;
  assert.match(replacementPrompt, /Same-Mission Context Handoff/);
  assert.match(replacementPrompt, /Fresh bounded managed-scope inspection/);
  for (const sentinel of [OLD_TRANSCRIPT_SENTINEL, OLD_MODEL_SENTINEL, OLD_PROVIDER_SESSION_SENTINEL, TARGET_OUTPUT_SENTINEL, 'coordinator-a-target-unknown-command']) {
    assert.doesNotMatch(replacementPrompt, new RegExp(sentinel));
  }

  // Only the later explicit Cognition command may establish the Phase 4 feedback
  // route. Retry must converge on the same feedback Cognition/provenance.
  const routeCommand = {
    kind: 'routePracticeProblem',
    arguments: { ...scope, practiceMissionId: practiceMission.taskId, problemExchangeId: problem.exchangeId },
  };
  await driverB.executeCoordinatorCommandTurn({
    ...scope,
    coordinationMissionId: coordinatorMission.taskId,
    managedSessionId: coordinatorSessionB.managedSessionId,
    inputId: 'coordinator-b-route-problem',
    command: routeCommand,
  });
  const feedbackCognition = tasksB.findTaskBySource(missionFeedbackCognitionSource(feedbackIdentity));
  assert.ok(feedbackCognition?.mission);
  const feedbackCognitionId = feedbackCognition.taskId;
  await driverB.executeCoordinatorCommandTurn({
    ...scope,
    coordinationMissionId: coordinatorMission.taskId,
    managedSessionId: coordinatorSessionB.managedSessionId,
    inputId: 'coordinator-b-route-problem-retry',
    command: routeCommand,
  });
  assert.equal(tasksB.findTaskBySource(missionFeedbackCognitionSource(feedbackIdentity)).taskId, feedbackCognitionId);
  assert.equal(
    collaborationB.listRelations(project.projectId, { includeDerivedParent: false })
      .filter(relation => relation.type === 'spawned_by' && relation.basisExchangeId === problem.exchangeId).length,
    1,
    'explicit feedback route retry must not duplicate feedback provenance',
  );

  // Cognition authors a durable Answer through the existing Phase 4 owner. The
  // replacement Coordinator Worker B itself invokes the feedback transport
  // command, proving Worker replacement != Mission replacement for live bridge
  // transport rather than merely for ensure-Mission retry.
  const answered = await feedbackB.recordAnswer({
    ...feedbackIdentity,
    answerExchangeId: 'phase6-live-feedback-answer',
    answer: 'Cognition explicitly authorizes continuing the same Practice Mission using the bounded Answer.',
    evidenceExchangeIds: [evidence.exchangeId],
  });
  const practiceSessionB = await managerB.createSession(practiceAdapterB.id, { model: 'phase6-practice-model-b' }, practiceMission.taskId);
  const practiceHandoffB = buildRenderedContextHandoff(tasksB.getTask(practiceMission.taskId), {
    targetWorkerId: practiceAdapterB.id,
    generatedAt: '2026-09-15T14:31:00.000Z',
    maxWorkerSessions: 0,
  });
  const feedbackTransportTurn = await driverB.executeCoordinatorCommandTurn({
    ...scope,
    coordinationMissionId: coordinatorMission.taskId,
    managedSessionId: coordinatorSessionB.managedSessionId,
    inputId: 'coordinator-b-deliver-feedback-continuation',
    contextHandoff: coordinatorHandoffB,
    command: {
      kind: 'deliverFeedbackContinuation',
      arguments: {
        ...scope,
        ...feedbackIdentity,
        coordinationMissionId: coordinatorMission.taskId,
        answerExchangeId: answered.answer.exchangeId,
        managedSessionId: practiceSessionB.managedSessionId,
        inputId: 'phase6-practice-feedback-continuation-b',
        contextHandoff: practiceHandoffB,
      },
    },
  });
  assert.equal(feedbackTransportTurn.commandResult.kind, 'coordinator-live-transport-observation');
  assert.equal(feedbackTransportTurn.commandResult.targetMissionId, practiceMission.taskId);
  assert.equal(feedbackTransportTurn.commandResult.terminalStatus, 'completed');
  assert.equal(coordinatorAdapterB.inputs.at(-1).externalCapabilities[0].name, 'nimora.coordinator.deliverFeedbackContinuation');
  assert.match(coordinatorAdapterB.inputs.at(-1).prompt, /Same-Mission Context Handoff/);
  assert.match(practiceAdapterB.inputs.at(-1).prompt, /Cross-Mission Revised Cognition/);
  assert.match(practiceAdapterB.inputs.at(-1).prompt, /phase6-live-feedback-answer/);
  assert.equal(managerB.getSession(practiceSessionB.managedSessionId).taskId, practiceMission.taskId, 'replacement Practice Worker remains bound to the original Practice Mission');
  assert.equal(tasksB.findTaskBySource(practiceSource).taskId, practiceMission.taskId, 'feedback continuation must not replace the Practice Mission');

  // Decision delivery can consume only already-Committed authority. Uncommitted,
  // stale/superseded and unaffected targets fail before provider send.
  const uncommitted = await projectsB.recordProposal(project.projectId, {
    proposalId: 'phase6-live-uncommitted-proposal',
    content: { kind: 'decision', summary: 'Must never route before explicit Human Confirmation + Commit.', scope: { kind: 'missions', missionIds: [practiceMission.taskId] } },
  });
  const decisionInputsBeforeReject = practiceAdapterB.inputs.length;
  await assert.rejects(
    () => driverB.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionB.managedSessionId,
      inputId: 'coordinator-b-uncommitted-decision',
      command: {
        kind: 'deliverCommittedDecision',
        arguments: {
          ...scope,
          coordinationMissionId: coordinatorMission.taskId,
          decisionId: uncommitted.proposalId,
          targetMissionId: practiceMission.taskId,
          managedSessionId: practiceSessionB.managedSessionId,
          inputId: 'uncommitted-decision-must-not-send',
        },
      },
    }),
    /Committed Project Decision does not exist/,
  );
  const stale = await projectsB.recordProposal(project.projectId, {
    proposalId: 'phase6-live-stale-proposal',
    content: { kind: 'change', summary: 'Old stale preference.', scope: { kind: 'missions', missionIds: [practiceMission.taskId] } },
  });
  await projectsB.confirmProposalHuman(project.projectId, { proposalId: stale.proposalId, contentDigest: stale.contentDigest });
  await projectsB.replaceProposal(project.projectId, {
    supersededProposalId: stale.proposalId,
    proposalId: 'phase6-live-stale-replacement',
    content: { kind: 'change', summary: 'Replacement preference remains uncommitted.', scope: { kind: 'missions', missionIds: [practiceMission.taskId] } },
  });
  await assert.rejects(
    () => driverB.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionB.managedSessionId,
      inputId: 'coordinator-b-stale-decision',
      command: {
        kind: 'deliverCommittedDecision',
        arguments: {
          ...scope,
          coordinationMissionId: coordinatorMission.taskId,
          decisionId: stale.proposalId,
          targetMissionId: practiceMission.taskId,
          managedSessionId: practiceSessionB.managedSessionId,
          inputId: 'stale-decision-must-not-send',
        },
      },
    }),
    /Committed Project Decision does not exist/,
  );
  assert.equal(practiceAdapterB.inputs.length, decisionInputsBeforeReject, 'uncommitted/stale Decision attempts must reject before send');

  const committedProposal = await projectsB.recordProposal(project.projectId, {
    proposalId: 'phase6-live-committed-proposal',
    content: {
      kind: 'decision',
      summary: 'Route this already-Committed bounded decision only to the affected Practice Mission.',
      scope: { kind: 'missions', missionIds: [practiceMission.taskId] },
    },
  });
  await projectsB.confirmProposalHuman(project.projectId, { proposalId: committedProposal.proposalId, contentDigest: committedProposal.contentDigest });
  const committed = await decisionsB.commitProposal(project.projectId, { proposalId: committedProposal.proposalId });
  const rootCognitionSessionB = await managerB.createSession(cognitionAdapterB.id, { model: 'phase6-root-cognition-model-b' }, rootMission.taskId);
  const cognitionInputsBeforeUnaffected = cognitionAdapterB.inputs.length;
  await assert.rejects(
    () => driverB.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionB.managedSessionId,
      inputId: 'coordinator-b-unaffected-decision',
      command: {
        kind: 'deliverCommittedDecision',
        arguments: {
          ...scope,
          coordinationMissionId: coordinatorMission.taskId,
          decisionId: committed.decision.decisionId,
          targetMissionId: rootMission.taskId,
          managedSessionId: rootCognitionSessionB.managedSessionId,
          inputId: 'unaffected-decision-must-not-send',
        },
      },
    }),
    /not an affected routeable Mission|outside the explicit Decision scope/,
  );
  assert.equal(cognitionAdapterB.inputs.length, cognitionInputsBeforeUnaffected, 'unaffected Decision target must reject before send');

  const committedDecisionArguments = {
    ...scope,
    coordinationMissionId: coordinatorMission.taskId,
    decisionId: committed.decision.decisionId,
    targetMissionId: practiceMission.taskId,
    managedSessionId: practiceSessionB.managedSessionId,
    inputId: 'committed-decision-live-send',
  };
  const practiceInputsBeforeChangedDecision = practiceAdapterB.inputs.length;
  coordinatorAdapterB.plans.set('transport-changed-decision-id', {
    argumentsOverride: { ...committedDecisionArguments, decisionId: 'worker-mutated-decision-id' },
  });
  await assert.rejects(
    () => driverB.executeCoordinatorCommandTurn({
      ...scope,
      coordinationMissionId: coordinatorMission.taskId,
      managedSessionId: coordinatorSessionB.managedSessionId,
      inputId: 'transport-changed-decision-id',
      command: { kind: 'deliverCommittedDecision', arguments: committedDecisionArguments },
    }),
    /mutate the host-bound invocation envelope/,
  );
  assert.equal(practiceAdapterB.inputs.length, practiceInputsBeforeChangedDecision, 'changed Decision id must cause no target send');

  const committedDecisionTurn = await driverB.executeCoordinatorCommandTurn({
    ...scope,
    coordinationMissionId: coordinatorMission.taskId,
    managedSessionId: coordinatorSessionB.managedSessionId,
    inputId: 'coordinator-b-deliver-committed-decision',
    command: { kind: 'deliverCommittedDecision', arguments: committedDecisionArguments },
  });
  assert.equal(committedDecisionTurn.commandResult.kind, 'coordinator-live-transport-observation');
  assert.equal(committedDecisionTurn.commandResult.targetMissionId, practiceMission.taskId);
  assert.match(practiceAdapterB.inputs.at(-1).prompt, /Committed Project Decision/);
  assert.match(practiceAdapterB.inputs.at(-1).prompt, /already-Committed bounded decision/);

  // The live driver remains a trusted-host transport seam: no Human authority,
  // Worker creation/registration/selection, scheduling, or self-finalization API.
  for (const forbiddenMethod of [
    'confirmProposalHuman',
    'commitProposal',
    'createSession',
    'register',
    'selectWorker',
    'selectProvider',
    'selectModel',
    'finalizeMission',
    'archiveMission',
    'markDelivered',
    'deliverExplicitMissionInput',
    'deliverMissionExchange',
    'deliverFeedbackContinuation',
    'deliverCommittedDecision',
  ]) {
    assert.equal(typeof driverB[forbiddenMethod], 'undefined', `live driver must not expose ${forbiddenMethod}`);
  }
  const driverSource = await fs.readFile(path.join(root, 'src', 'mission-coordinator-live-driver.ts'), 'utf8');
  assert.doesNotMatch(driverSource, /\.createSession\s*\(|\.register\s*\(|listWorkers\s*\(|selectWorker|selectProvider|selectModel/);
  assert.doesNotMatch(driverSource, /confirmProposalHuman\s*\(|commitProposal\s*\(|finalizeMission\s*\(|archiveMission\s*\(/);

  const targetSendsAfterExplicitReplacementWork = practiceAdapterB.inputs.length;
  await coordinatorB.inspectManagedScope(scope);
  assert.equal(practiceAdapterB.inputs.length, targetSendsAfterExplicitReplacementWork, 'fresh inspection must never trigger target transport');

  const stopDriver = new MissionCoordinatorLiveDriver(projectsB, tasksB, collaborationB, coordinatorB, feedbackB, decisionsB, managerB,
    undefined, undefined, { executeAndDeliver: async () => {
      throw new HostCapabilityAuthorizationError('Not preapproved', 'terminal.send-command-input', 'session', true);
    } });
  practiceAdapterB.plans.set('preapproval-denial-target', { mode: 'preapproval-denied' });
  const interruptsBeforeDenial = practiceAdapterB.interrupts;
  const deniedTurn = await stopDriver.executeCoordinatorCommandTurn({ ...scope, coordinationMissionId: coordinatorMission.taskId,
    managedSessionId: coordinatorSessionB.managedSessionId, inputId: 'preapproval-denial-coordinator', command: {
      kind: 'deliverExplicitMissionInput', arguments: { ...workOrderArguments, managedSessionId: practiceSessionB.managedSessionId,
        inputId: 'preapproval-denial-target' },
    } });
  assert.equal(deniedTurn.commandResult.terminalStatus, 'error', 'host permission stop is never provider completion');
  assert.match(deniedTurn.commandResult.terminalError, /预授权/);
  assert.equal(deniedTurn.commandResult.hostStopReason, 'authorization-denied');
  assert.equal(practiceAdapterB.continuedAfterDenial, 0, 'no next capability call after preapproval denial');
  assert.equal(practiceAdapterB.interrupts, interruptsBeforeDenial + 1, 'canonical abandonment interrupts once');
  assert.equal(practiceAdapterB.submittedResults.at(-1).result.extensions.hostAuthorizationStoppedTurn, true);

  const failedToolDriver = new MissionCoordinatorLiveDriver(projectsB, tasksB, collaborationB, coordinatorB, feedbackB, decisionsB, managerB,
    undefined, undefined, { executeAndDeliver: async (request, sink) => {
      const result = { inputId: request.inputId, callId: request.callId, name: request.name, text: 'Actual tool failure', isError: true };
      await sink.submitCapabilityResult(request.managedSessionId, result);
      return result;
    } });
  practiceAdapterB.plans.set('failed-tool-target', { mode: 'preapproval-denied' });
  const interruptsBeforeFailure = practiceAdapterB.interrupts;
  const failedToolTurn = await failedToolDriver.executeCoordinatorCommandTurn({ ...scope, coordinationMissionId: coordinatorMission.taskId,
    managedSessionId: coordinatorSessionB.managedSessionId, inputId: 'failed-tool-coordinator', command: {
      kind: 'deliverExplicitMissionInput', arguments: { ...workOrderArguments, managedSessionId: practiceSessionB.managedSessionId,
        inputId: 'failed-tool-target' },
    } });
  assert.equal(failedToolTurn.commandResult.terminalStatus, 'error');
  assert.match(failedToolTurn.commandResult.terminalError, /工具错误/);
  assert.equal(failedToolTurn.commandResult.hostStopReason, 'capability-error');
  assert.equal(practiceAdapterB.continuedAfterDenial, 0, 'no next capability call after any delivered tool error');
  assert.equal(practiceAdapterB.interrupts, interruptsBeforeFailure + 1);
  assert.equal(practiceAdapterB.submittedResults.at(-1).result.text, 'Actual tool failure', 'preserve actual error before stopping');
  await managerB.withAdapterSessionRetirementScope([
    { workerId: practiceSessionB.workerId, adapterSessionId: practiceSessionB.adapterSessionId },
  ], async owner => {
    assert.equal(owner.isKnownSettled({ workerId: practiceSessionB.workerId, adapterSessionId: practiceSessionB.adapterSessionId }), true,
      'a successfully interrupted and cleanly closed stopped turn must admit a fresh Work Order');
  });

  const allDurable = JSON.stringify(await durableSnapshot([projectDirectory, taskDirectory, collaborationDirectory]));
  assert.doesNotMatch(allDurable, /coordinator-a-target-unknown-command|phase6-target-unknown-send/);
  assert.doesNotMatch(allDurable, new RegExp(OLD_TRANSCRIPT_SENTINEL));
  assert.doesNotMatch(allDurable, new RegExp(TARGET_OUTPUT_SENTINEL));
  assert.doesNotMatch(JSON.stringify(coordinatorAdapterA.inputs), new RegExp(TARGET_OUTPUT_SENTINEL));
  assert.doesNotMatch(JSON.stringify(coordinatorAdapterA.submittedResults), new RegExp(TARGET_OUTPUT_SENTINEL));
  assert.doesNotMatch(JSON.stringify(coordinatorAdapterB.inputs), new RegExp(TARGET_OUTPUT_SENTINEL));
  assert.doesNotMatch(JSON.stringify(coordinatorAdapterB.submittedResults), new RegExp(TARGET_OUTPUT_SENTINEL));

  console.log('[smoke] Phase 6 live explicit Coordinator Worker transport/replacement/feedback/Decision boundaries ok');
  console.log(`[smoke] root=${rootMission.taskId} coordinator=${coordinatorMission.taskId} practice=${practiceMission.taskId} feedbackCognition=${feedbackCognitionId}`);
} finally {
  await Promise.all([
    fs.rm(taskDirectory, { recursive: true, force: true }),
    fs.rm(projectDirectory, { recursive: true, force: true }),
    fs.rm(collaborationDirectory, { recursive: true, force: true }),
    fs.rm(bundleDirectory, { recursive: true, force: true }),
  ]);
}
