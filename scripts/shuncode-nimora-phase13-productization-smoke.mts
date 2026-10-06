import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-phase13-'));

async function bundle(entry: string, name: string): Promise<any> {
  const outfile = path.join(directory, name + '.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['es2022'],
    logLevel: 'silent',
  });
  return require(outfile);
}

try {
  const { projectHumanExperience } = await bundle('src/nimora-human-attention.ts', 'attention');
  const { createNimoraFirstPartySkillSource } = await bundle('extensions/shuncode/src/nimora-first-party-skills.ts', 'skills');
  const { buildNimoraProductDiagnostics } = await bundle('extensions/shuncode/src/nimora-product-diagnostics.ts', 'diagnostics');
  const { exportNimoraProjectBackup, verifyNimoraProjectBackup, prepareNimoraProjectRestore } = await bundle('extensions/shuncode/src/nimora-project-backup.ts', 'backup');
  const { ProjectStore } = await bundle('src/project-store.ts', 'project-store');
  const { TaskRuntime } = await bundle('src/task-runtime.ts', 'task-runtime');
  const { FileToolHostCapabilityExecutor } = await bundle('src/file-host-capability-executor.ts', 'file-host-executor');
  const { getCapabilityMetadata } = await bundle('src/capability-registry.ts', 'capability-registry');
  const { isTaskInputAbsolutePathAllowed, resolveTaskInputWorkspaceAccessRoots } = await bundle('src/task-input-access-policy.ts', 'input-access-policy');
  const { assertWindowsMxcStableIsolationSupport } = await bundle('src/vs/platform/sandbox/common/sandboxHelperService.ts', 'sandbox-support');
  const { assertAutonomousWebFormationOwnership } = await bundle('src/mission-web-autonomy-formation.ts', 'web-autonomy-formation');
  const { bindHumanSelectedWebProvider } = await bundle('src/mission-web-provider-selection.ts', 'web-provider-selection');
  const { normalizeMissionWorkspaceAccessPolicy } = await bundle('src/mission-worker-input-materialization-contract.ts', 'workspace-policy');

  const baseProject: any = {
    projectId: 'project-1',
    title: 'SECRET PROJECT TITLE',
    goal: 'SECRET PROJECT GOAL',
    workspace: 'C:/secret/workspace',
    status: 'active',
    sourceState: { metadata: 'available', decisions: 'available', collaboration: 'available' },
    missionCount: 1,
    activeMissionCount: 1,
    completedMissionCount: 0,
    attentionCount: 0,
    artifactCount: 0,
    decisionCount: 0,
    unknownExecutionCount: 0,
    progress: { completed: 0, total: 1, percent: 20, running: 1, ready: 0, waiting: 0, failed: 0, cancelled: 0, successfulExecutions: 1, failedExecutions: 0, completedTodos: 0, totalTodos: 0 },
    graph: { nodes: [], edges: [], maxDepth: 0, activeMissionIds: ['mission-1'], waitingMissionIds: [] },
    attentions: [],
    artifacts: [],
    decisions: [],
    governance: [],
    missions: [{
      missionId: 'mission-1', projectId: 'project-1', goal: 'SECRET MISSION GOAL',
      role: '理', plane: 'practice', status: 'active', terminal: false, activeWorkerCount: 1,
      executionCount: 1, failedExecutionCount: 0, artifactCount: 0, todos: [], executions: [], artifacts: [], problems: [], collaboration: [],
    }],
    activities: [],
  };

  const working = projectHumanExperience(baseProject, {
    managedAutonomy: true, recoveredOnly: false, completionCandidate: false, providerObservationAvailable: true,
  });
  assert.equal(working.state, 'working');
  assert.equal(working.action, 'continue-project');

  const completion = projectHumanExperience(baseProject, {
    managedAutonomy: true, recoveredOnly: false, completionCandidate: true, providerObservationAvailable: true,
  });
  assert.equal(completion.state, 'needs-human');
  assert.equal(completion.action, 'review-completion');

  const unknown = projectHumanExperience({ ...baseProject, unknownExecutionCount: 1 }, {
    managedAutonomy: true, recoveredOnly: false, completionCandidate: false, providerObservationAvailable: true,
  });
  assert.equal(unknown.action, 'open-work-sessions');
  assert.match(unknown.detail, /避免重复/);
  const staleCompletion = projectHumanExperience({ ...baseProject, unknownExecutionCount: 1 }, {
    managedAutonomy: true, recoveredOnly: false, completionCandidate: true, providerObservationAvailable: true,
  });
  assert.equal(staleCompletion.action, 'open-work-sessions', 'canonical UNKNOWN takes priority over a retained completion candidate');

  const source = createNimoraFirstPartySkillSource();
  assert.equal(source.firstPartyBuiltInAuthority, true);
  const skills = await source.listSkills();
  assert.equal(skills.length, 3);
  assert.deepEqual(skills.map((skill: any) => skill.eligibleMissionPlanes?.[0]).sort(), ['cognition', 'coordination', 'practice']);
  assert.ok(skills.every((skill: any) => !skill.requiredCapabilityIds?.length));
  const loaded = await source.loadContent({
    skillId: skills[0].skillId, sourceId: skills[0].sourceId, canonicalLocator: skills[0].canonicalLocator,
  });
  assert.match(loaded.content, /canonical Project\/Mission facts/);
  await assert.rejects(() => source.loadContent({
    skillId: skills[0].skillId, sourceId: 'wrong', canonicalLocator: skills[0].canonicalLocator,
  }));

  const state: any = {
    version: 1, generatedAt: '2026-10-04T13:00:00.000Z', selectedProjectId: 'project-1',
    system: {
      mode: 'ready', reconstruction: 'ready',
      owners: [{ owner: 'projects', label: 'Projects', status: 'available' }, { owner: 'tasks', label: 'Tasks', status: 'available' }, { owner: 'collaboration', label: 'Collaboration', status: 'available' }],
      integrityIssueCount: 0, integrityIssues: [], legacyTaskCount: 0,
    },
    projects: [baseProject], totalProjects: 1, activeProjects: 1, activeMissions: 1, attentionCount: 0, unknownExecutionCount: 0,
  };
  const report = buildNimoraProductDiagnostics({
    state,
    extensionVersion: '1.0.0',
    workspaceTrusted: true,
    platform: 'win32',
    arch: 'x64',
    autonomyOutcomes: { 'project-1': { state: 'quiescent', reason: 'test', recordedAt: '2026-10-04T13:01:00.000Z' } },
  });
  assert.equal(report.privacy.credentialsIncluded, false);
  assert.equal(report.safety.terminalInvocationCwdBoundedToWorkspace, true);
  assert.equal(report.safety.durablePerInputWorkspacePathPolicy, true);
  assert.equal(report.safety.workspaceFileToolsEnforceInputPolicy, true);
  assert.equal(report.safety.workspaceScopedIdeTargetAdmissionEnforcesInputPolicy, true);
  assert.equal(report.safety.osSandboxIntegratedWithNimoraTerminalCapability, true);
  assert.equal(report.safety.osSandboxExactWorkOrderWriteRoots, true);
  assert.equal(report.safety.osSandboxNetworkDefaultDeny, true);
  assert.equal(report.safety.osSandboxUnsandboxedFallbackDisabled, true);
  assert.equal(report.safety.osSandboxLiveCertifiedOnCurrentHost, false);
  assert.equal(report.safety.unattendedStableSafetyReady, false);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('SECRET PROJECT TITLE'), false);
  assert.equal(serialized.includes('SECRET PROJECT GOAL'), false);
  assert.equal(serialized.includes('SECRET MISSION GOAL'), false);
  assert.equal(serialized.includes('C:/secret/workspace'), false);
  assert.deepEqual(normalizeMissionWorkspaceAccessPolicy({ allowedPathPrefixes: ['./src/exact-area/', 'src/exact-area'] }),
    { allowedPathPrefixes: ['src/exact-area'] });
  assert.throws(() => normalizeMissionWorkspaceAccessPolicy({ allowedPathPrefixes: ['../secret'] }), /relative to the workspace/);

  const [compositionSource, shellSource, terminalSource, webFormationSource, extensionSource, autonomyEntrySource] = await Promise.all([
    fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'mission-work-production-composition.ts'), 'utf8'),
    fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'nimora-product-shell.ts'), 'utf8'),
    fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'terminal-command-manager.ts'), 'utf8'),
    fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'mission-user-entry.ts'), 'utf8'),
    fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'extension.ts'), 'utf8'),
    fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'nimora-autonomy-entry.ts'), 'utf8'),
  ]);
  assert.match(compositionSource, /createNimoraFirstPartySkillSource/);
  assert.match(shellSource, /NOW/);
  assert.match(shellSource, /continueProject/);
  assert.match(shellSource, /高级操作与诊断/);
  assert.match(shellSource, /exportDiagnostics/);
  assert.match(terminalSource, /resolveWorkspacePath\([\s\S]*?input\.cwd[\s\S]*?"\."/);
  assert.match(webFormationSource, /durable initialRoot MUST be the continuing Cognition owner/);
  assert.match(webFormationSource, /additionalMissions MUST contain at least one "practice" child/);
  assert.match(extensionSource, /assertAutonomousWebFormationOwnership\(row\)/);
  assert.match(extensionSource, /deferInitialExecution: true/);
  assert.match(extensionSource, /result\.state === "ready-for-autonomy"/);
  assert.match(extensionSource, /executeCommand<\{ state\?: string \}>\("shuncode\.nimora\.runWebAutonomy"/);
  assert.match(autonomyEntrySource, /location: vscode\.ProgressLocation\.Window/);
  assert.doesNotMatch(autonomyEntrySource, /title: "Nimora · 文理有界自主协作"[\s\S]{0,160}ProgressLocation\.Notification/,
    'Provider-driving autonomy must not keep a Notification overlay over the integrated browser');

  const sourceRoot = path.join(directory, 'backup-source');
  const projects = new ProjectStore({ storageDirectory: path.join(sourceRoot, 'project-store-v1'), newId: (() => {
    let i = 0; return () => 'backup-project-event-' + (++i);
  })() });
  const tasks = new TaskRuntime({ storageDirectory: path.join(sourceRoot, 'task-runtime-v1'), newId: (() => {
    let i = 0; return () => 'backup-task-event-' + (++i);
  })() });
  await Promise.all([projects.initialize(), tasks.initialize()]);
  const portableProject = await projects.createProject({ title: 'Portable truth', goal: 'Survive profile migration.' });
  const portableTask = await tasks.ensureTask({ kind: 'mission', key: 'portable-root' }, 'Portable root');
  await tasks.configureMission(portableTask.taskId, {
    projectId: portableProject.projectId,
    rootMissionId: portableTask.taskId,
    plane: 'cognition',
    missionType: 'portable-root',
    completionCriteria: ['Replay exactly'],
  });
  const backup = await exportNimoraProjectBackup(sourceRoot, { projects, tasks } as any, portableProject.projectId);
  const verifiedBackup = await verifyNimoraProjectBackup(backup);
  assert.equal(verifiedBackup.projectId, portableProject.projectId);
  assert.ok(verifiedBackup.files.every((file: any) => file.sha256.startsWith('sha256:')));
  const tampered = structuredClone(backup);
  tampered.files.find((file: any) => file.path.startsWith('task-runtime-v1/')).content += 'tamper';
  await assert.rejects(() => verifyNimoraProjectBackup(tampered), /digest mismatch/);

  const restoreRoot = path.join(directory, 'backup-restore');
  const emptyProjects = new ProjectStore({ storageDirectory: path.join(restoreRoot, 'project-store-v1') });
  const emptyTasks = new TaskRuntime({ storageDirectory: path.join(restoreRoot, 'task-runtime-v1') });
  await Promise.all([emptyProjects.initialize(), emptyTasks.initialize()]);
  await prepareNimoraProjectRestore(restoreRoot, { projects: emptyProjects, tasks: emptyTasks } as any, backup);
  const restoredProjects = new ProjectStore({ storageDirectory: path.join(restoreRoot, 'project-store-v1') });
  const restoredTasks = new TaskRuntime({ storageDirectory: path.join(restoreRoot, 'task-runtime-v1') });
  await Promise.all([restoredProjects.initialize(), restoredTasks.initialize()]);
  assert.equal(restoredProjects.listProjects()[0]?.projectId, portableProject.projectId);
  assert.equal(restoredTasks.listTasks()[0]?.mission?.projectId, portableProject.projectId);
  await assert.rejects(() => prepareNimoraProjectRestore(restoreRoot, { projects: restoredProjects, tasks: restoredTasks } as any, backup), /empty Nimora profile/);

  const policyRoot = path.join(directory, 'policy-workspace');
  await fs.mkdir(path.join(policyRoot, 'allowed'), { recursive: true });
  await fs.writeFile(path.join(policyRoot, 'allowed', 'readme.txt'), 'allowed\n', 'utf8');
  await fs.writeFile(path.join(policyRoot, 'secret.txt'), 'secret\n', 'utf8');
  const policyStore = path.join(directory, 'policy-task-store');
  const policyTasks = new TaskRuntime({ storageDirectory: policyStore, newId: (() => {
    let i = 0; return () => 'policy-event-' + (++i);
  })() });
  await policyTasks.initialize();
  const policyTask = await policyTasks.ensureTask({ kind: 'mission', key: 'policy-mission' }, 'Bound one Work Order');
  await policyTasks.configureMission(policyTask.taskId, {
    projectId: 'policy-project',
    rootMissionId: policyTask.taskId,
    plane: 'practice',
    missionType: 'bounded-practice',
    completionCriteria: ['Read only the authorized path'],
  });
  await policyTasks.attachWorkerSession(policyTask.taskId, {
    managedSessionId: 'policy-session',
    workerId: 'nimora.web-worker',
    adapterSessionId: 'policy-adapter-session',
    model: 'policy-model',
  });
  await policyTasks.recordInputAccessPolicyStrict(policyTask.taskId, {
    inputId: 'policy-input',
    managedSessionId: 'policy-session',
    allowedWorkspacePathPrefixes: ['allowed'],
  });
  await assert.rejects(() => policyTasks.recordInputAccessPolicyStrict(policyTask.taskId, {
    inputId: 'policy-input',
    managedSessionId: 'policy-session',
    allowedWorkspacePathPrefixes: ['.'],
  }), /identity mismatch/);

  const fileExecutor = new FileToolHostCapabilityExecutor({ workspaceRoots: () => [policyRoot], tasks: policyTasks });
  const requestBase = {
    executionId: 'policy-execution',
    managedSessionId: 'policy-session',
    workerId: 'nimora.web-worker',
    taskId: policyTask.taskId,
    inputId: 'policy-input',
    callId: 'policy-call',
  };
  const readCapability = getCapabilityMetadata('read_files');
  const allowedRead = await fileExecutor.execute({
    ...requestBase,
    name: 'read_files',
    arguments: { files: [{ path: 'allowed/readme.txt' }] },
  }, readCapability);
  assert.equal(allowedRead.isError, false);
  assert.match(String(allowedRead.text), /allowed/);
  const deniedRead = await fileExecutor.execute({
    ...requestBase,
    executionId: 'policy-execution-denied',
    callId: 'policy-call-denied',
    name: 'read_files',
    arguments: { files: [{ path: 'secret.txt' }] },
  }, readCapability);
  assert.equal(deniedRead.isError, true);
  assert.match(String(deniedRead.text), /PERMISSION_DENIED/);
  assert.equal(await isTaskInputAbsolutePathAllowed(policyTasks, {
    ...requestBase, name: 'read_files',
  }, path.join(policyRoot, 'allowed', 'readme.txt'), [policyRoot]), true);
  assert.equal(await isTaskInputAbsolutePathAllowed(policyTasks, {
    ...requestBase, name: 'read_files',
  }, path.join(policyRoot, 'secret.txt'), [policyRoot]), false);

  const policyOutside = path.join(directory, 'policy-outside');
  await fs.mkdir(policyOutside, { recursive: true });
  const policyEscape = path.join(policyRoot, 'allowed', 'escape');
  await fs.symlink(policyOutside, policyEscape, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await isTaskInputAbsolutePathAllowed(policyTasks, {
    ...requestBase, name: 'apply_patch',
  }, path.join(policyEscape, 'not-created-yet.txt'), [policyRoot]), false,
  'A create beneath an existing symlink/junction must not escape the exact Work Order prefix');
  assert.deepEqual(await resolveTaskInputWorkspaceAccessRoots(policyTasks, {
    ...requestBase, name: 'run_command',
  }, [policyRoot]), [await fs.realpath(path.join(policyRoot, 'allowed'))]);
  await assert.rejects(() => resolveTaskInputWorkspaceAccessRoots(policyTasks, {
    ...requestBase, name: 'run_command',
  }, [policyRoot, path.join(directory, 'second-workspace')]), /exactly one workspace root/);

  assert.doesNotThrow(() => assertWindowsMxcStableIsolationSupport({
    isSupported: true, availableMethods: ['processcontainer'], isolationTier: 'base-container',
  }));
  assert.doesNotThrow(() => assertWindowsMxcStableIsolationSupport({
    isSupported: true, availableMethods: ['processcontainer'], isolationTier: 'appcontainer-bfs',
  }));
  assert.throws(() => assertWindowsMxcStableIsolationSupport({
    isSupported: true, availableMethods: ['processcontainer'], isolationTier: 'appcontainer-dacl',
    isolationWarnings: ['host ACL mutation fallback'],
  }), /rejects the AppContainer\+DACL fallback/);
  assert.throws(() => assertWindowsMxcStableIsolationSupport(undefined), /verified Windows MXC process-container isolation tier/);
  const autonomousFormation = {
    initialRoot: { plane: 'cognition' },
    requiredCapabilityIds: ['workspace.read-files'],
    additionalMissions: [{ key: 'practice', plane: 'practice' }],
  };
  assert.doesNotThrow(() => assertAutonomousWebFormationOwnership(autonomousFormation));
  assert.throws(() => assertAutonomousWebFormationOwnership({
    ...autonomousFormation, initialRoot: { plane: 'practice' },
  }), /continuing Cognition root/);
  assert.throws(() => assertAutonomousWebFormationOwnership({
    ...autonomousFormation, additionalMissions: [],
  }), /at least one Practice child|至少一个 Practice child/);
  assert.doesNotThrow(() => assertAutonomousWebFormationOwnership({
    initialRoot: { plane: 'cognition' }, requiredCapabilityIds: [], additionalMissions: [],
  }), 'tools-free Web Project may remain Cognition-only');
  const deepSeekCandidate = {
    candidateId: 'deepseek-page-1',
    workerId: 'nimora.web-worker',
    provider: 'deepseek',
    kind: 'web',
    availability: 'available',
    models: ['deepseek-chat'],
    capabilities: {
      streaming: true,
      reasoning: true,
      capabilityRequests: true,
      imageInput: false,
      checkpoints: false,
      interruption: true,
      persistentContext: true,
    },
    observationId: 'obs-1',
    observedAt: '2026-10-05T00:00:00.000Z',
  };
  const providerBoundFormation: any = {
    coordinatorPolicy: {
      constraints: {
        allowedKinds: ['api'],
        allowedProviders: ['other-provider'],
        forbiddenProviders: ['deepseek'],
        requiredCapabilities: { capabilityRequests: true },
      },
      preferences: { providerOrder: ['other-provider'] },
    },
    workerPolicy: {
      constraints: {
        allowedKinds: ['local'],
        allowedProviders: ['other-provider'],
        forbiddenProviders: ['deepseek'],
      },
      preferences: {},
    },
  };
  assert.doesNotThrow(() => bindHumanSelectedWebProvider(providerBoundFormation, [deepSeekCandidate], 'deepseek'));
  for (const key of ['coordinatorPolicy', 'workerPolicy']) {
    assert.deepEqual(providerBoundFormation[key].constraints.allowedKinds, ['web']);
    assert.deepEqual(providerBoundFormation[key].constraints.allowedProviders, ['deepseek']);
    assert.equal(providerBoundFormation[key].constraints.forbiddenProviders.includes('deepseek'), false);
    assert.deepEqual(providerBoundFormation[key].preferences.providerOrder, ['deepseek']);
  }
  assert.deepEqual(providerBoundFormation.coordinatorPolicy.constraints.requiredCapabilities, { capabilityRequests: true },
    'Human provider selection must not erase genuine capability requirements');
  const noObservedCandidateFormation: any = {
    coordinatorPolicy: { constraints: {}, preferences: {} },
    workerPolicy: { constraints: {}, preferences: {} },
  };
  assert.doesNotThrow(() => bindHumanSelectedWebProvider(noObservedCandidateFormation, [], 'deepseek'),
    'empty Formation candidate observations must not block an explicit Human provider selection when there are no hard model/capability requirements');
  assert.deepEqual(noObservedCandidateFormation.coordinatorPolicy.constraints.allowedProviders, ['deepseek']);
  assert.deepEqual(noObservedCandidateFormation.workerPolicy.constraints.allowedKinds, ['web']);
  assert.throws(() => bindHumanSelectedWebProvider({
    coordinatorPolicy: { constraints: { requiredCapabilities: { imageInput: true } }, preferences: {} },
    workerPolicy: { constraints: {}, preferences: {} },
  }, [deepSeekCandidate], 'deepseek'), /cannot prove the hard coordinatorPolicy requirements before Project birth: imageInput=true/);
  assert.throws(() => bindHumanSelectedWebProvider({
    coordinatorPolicy: { constraints: { requiredCapabilities: { capabilityRequests: true } }, preferences: {} },
    workerPolicy: { constraints: {}, preferences: {} },
  }, [], 'deepseek'), /capabilityRequests=true/,
  'a genuine hard capability requirement still fails closed when Formation has no candidate proof');
  const backendProof = { provider: 'deepseek', kind: 'web', models: [], capabilities: { ...deepSeekCandidate.capabilities, reasoning: false },
    status: 'healthy', checkedAt: '2026-10-06T00:00:00.000Z', basis: 'owned-tools-free-planner' };
  const requireRequests = () => ({ coordinatorPolicy: { constraints: { requiredCapabilities: { capabilityRequests: true } }, preferences: {} },
    workerPolicy: { constraints: {}, preferences: {} } });
  const proven = requireRequests();
  assert.doesNotThrow(() => bindHumanSelectedWebProvider(proven, [], 'deepseek', backendProof),
    'healthy reserved planner proves selected backend shape without becoming an assignment candidate');
  assert.deepEqual(proven.coordinatorPolicy.constraints.requiredCapabilities, { capabilityRequests: true });
  assert.throws(() => bindHumanSelectedWebProvider(requireRequests(), [], 'deepseek', { ...backendProof, status: 'offline' }), /cannot prove/);
  assert.throws(() => bindHumanSelectedWebProvider(requireRequests(), [], 'deepseek', { ...backendProof, provider: 'another' }), /cannot prove/);
  assert.throws(() => bindHumanSelectedWebProvider({ coordinatorPolicy: { constraints: {}, preferences: {} },
    workerPolicy: { constraints: { requiredCapabilities: { reasoning: true } }, preferences: {} } }, [], 'deepseek', backendProof), /reasoning=true/,
    'actual unsupported reasoning requirement must remain rejected');
  assert.throws(() => bindHumanSelectedWebProvider({ coordinatorPolicy: { constraints: {}, preferences: {} },
    workerPolicy: { constraints: { requiredModel: 'unobserved-model' }, preferences: {} } }, [], 'deepseek', backendProof), /requiredModel=unobserved-model/);

  const restartedPolicyTasks = new TaskRuntime({ storageDirectory: policyStore });
  await restartedPolicyTasks.initialize();
  assert.deepEqual(restartedPolicyTasks.getTask(policyTask.taskId)?.inputAccessPolicies['policy-input']?.allowedWorkspacePathPrefixes, ['allowed']);

  console.log('PASS Phase13 human attention, product Skills, diagnostics/privacy, portable backup/restore, durable per-input workspace path enforcement, resource UX and terminal cwd hardening smoke');
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
