import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-product-shell-'));
const bundle = path.join(directory, 'projection.cjs');
const operationsBundle = path.join(directory, 'operations.cjs');

await esbuild.build({
  entryPoints: [path.join(root, 'src', 'nimora-product-shell-projection.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});
await esbuild.build({
  entryPoints: [path.join(root, 'extensions', 'shuncode', 'src', 'nimora-product-operations.ts')],
  outfile: operationsBundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});

const { projectNimoraProductShell } = require(bundle);
const { createNimoraProductOperationalSource } = require(operationsBundle);
try {
  const presentation = {
    version: 1,
    availability: { projects: { status: 'available' }, tasks: { status: 'available' }, collaboration: { status: 'available' } },
    projects: [{
      projectId: 'p1', metadataState: 'available', title: 'Nimora', goal: 'Ship a usable product', decisionsState: 'available',
      committedDecisions: [{ decisionId: 'd1', projectId: 'p1', proposalId: 'x', contentDigest: 'sha256:x', confirmationId: 'c', committedAt: '2026-09-30T01:00:00.000Z', content: { kind: 'architecture', summary: 'Keep Project as the product root', scope: {} } }],
      pendingProposals: [{ proposalId:'proposal-ui', contentDigest:'sha256:proposal-ui', content:{ kind:'change', summary:'Enable Nimora Product Shell', rationale:'Expose existing Project/Mission truth as a product.', scope:{ kind:'project' } }, proposedAt:'2026-09-30T02:30:00.000Z', state:'awaiting-human' }],
      missionIds: ['m1','m2'], collaborationState: 'available',
      hierarchyRelations: [{ relationId:'parent_of:m2', projectId:'p1', sourceMissionId:'m1', targetMissionId:'m2', type:'parent_of', createdAt:'2026-09-30T00:00:00.000Z', derived:true }],
      relations: [{ relationId:'depends-m1-m2', projectId:'p1', sourceMissionId:'m1', targetMissionId:'m2', type:'depends_on', createdAt:'2026-09-30T02:20:00.000Z' }],
      exchanges: [{ exchangeId: 'problem1', projectId: 'p1', sourceMissionId: 'm1', kind: 'Problem', createdAt: '2026-09-30T02:00:00.000Z',
        payload: { currentGoal: 'Ship', previousAssumption: 'ready', observedReality: 'provider drift', preciseQuestion: 'Recover safely?', blocking: true, evidenceExchangeIds: [] } }],
      problems: [{ exchangeId: 'problem1', sourceMissionId: 'm1', answerState: 'Open', blocking: true, answerExchangeIds: [], answers: [], evidence: [], missingEvidenceExchangeIds: [] }],
    }],
    missions: [
      { missionId:'m1',taskId:'m1',projectId:'p1',rootMissionId:'m1',plane:'practice',semanticRole:'理',missionType:'implementation',goal:'Build product shell',
        taskStatus:'active',finalized:false,presentationState:'active',terminal:false,hierarchyDepth:0,
        executions:[{ executionId:'e1', occurrenceId:'o1', toolName:'apply_patch', capabilityId:'workspace.apply-patch', status:'succeeded', deliveryStatus:'delivered', requestedAt:'2026-09-30T03:00:00.000Z' }],
        artifacts:[{ artifactId:'a1',kind:'file',title:'Nimora UI',createdAt:'2026-09-30T03:10:00.000Z' }],
        workers:[{ managedSessionId:'w1',workerId:'chatgpt',adapterSessionId:'a',attachedAt:'2026-09-30T00:00:00.000Z' }] },
      { missionId:'m2',taskId:'m2',projectId:'p1',rootMissionId:'m1',parentMissionId:'m1',plane:'cognition',semanticRole:'文',missionType:'planning',goal:'Product planning',
        taskStatus:'completed',finalization:{state:'finalized',status:'completed',finalizedAt:'2026-09-30T00:30:00.000Z'},finalized:true,presentationState:'completed',terminal:true,hierarchyDepth:1,
        executions:[],artifacts:[],workers:[] },
    ],
    legacyTaskIds: [], integrityIssues: [],
  };
  const state = projectNimoraProductShell(presentation, {}, () => new Date('2026-09-30T04:00:00.000Z'));
  assert.equal(state.system.mode, 'ready');
  assert.equal(state.system.reconstruction, 'ready');
  assert.ok(state.system.owners.every(owner => owner.status === 'available'));
  assert.equal(state.unknownExecutionCount, 0);
  assert.equal(state.totalProjects, 1);
  assert.equal(state.activeProjects, 1);
  assert.equal(state.activeMissions, 1);
  assert.equal(state.attentionCount, 2);
  assert.equal(state.selectedProjectId, 'p1');
  assert.equal(state.projects[0].title, 'Nimora');
  assert.equal(state.projects[0].missionCount, 2);
  assert.equal(state.projects[0].artifactCount, 1);
  assert.equal(state.projects[0].artifacts[0].title, 'Nimora UI');
  assert.equal(state.projects[0].decisions[0].summary, 'Keep Project as the product root');
  assert.equal(state.projects[0].attentions.length, 2);
  assert.ok(state.projects[0].attentions.some(item => item.kind === 'problem' && item.severity === 'blocking'));
  assert.ok(state.projects[0].attentions.some(item => item.kind === 'proposal-awaiting-human' && item.severity === 'blocking'));
  assert.equal(state.projects[0].governance.length, 1);
  assert.equal(state.projects[0].governance[0].summary, 'Enable Nimora Product Shell');
  assert.equal(state.projects[0].progress.percent, 50);
  assert.equal(state.projects[0].progress.completed, 1);
  const working = structuredClone(presentation);
  working.missions[0].todos = [{ id: 't1', title: 'Read requirements', status: 'completed' }, { id: 't2', title: 'Validate output', status: 'in_progress' }];
  working.missions[0].progress = { message: 'Validating actual output', percent: 60, at: '2026-09-30T03:30:00.000Z' };
  const workingState = projectNimoraProductShell(working);
  assert.equal(workingState.projects[0].progress.successfulExecutions, 1);
  assert.equal(workingState.projects[0].progress.completedTodos, 1);
  assert.equal(workingState.projects[0].progress.totalTodos, 2);
  assert.equal(workingState.projects[0].missions[0].progress.message, 'Validating actual output');
  assert.equal(workingState.projects[0].progress.percent, 50, 'reported progress never becomes formal Mission completion');
  assert.equal(state.projects[0].graph.nodes.length, 2);
  assert.equal(state.projects[0].graph.maxDepth, 1);
  assert.ok(state.projects[0].graph.edges.some(edge => edge.type === 'parent_of' && edge.label === '包含'));
  assert.ok(state.projects[0].graph.edges.some(edge => edge.type === 'depends_on' && edge.label === '依赖'));
  assert.deepEqual(state.projects[0].graph.waitingMissionIds, ['m1']);
  assert.equal(state.projects[0].graph.nodes.find(node => node.missionId === 'm1').state, 'attention');
  assert.equal(state.projects[0].missions[0].workerLabel, 'chatgpt');
  assert.equal(state.projects[0].missions[0].executions[0].toolName, '修改文件');
  assert.equal(state.projects[0].missions[0].problems[0].question, 'Recover safely?');
  assert.equal(state.projects[0].missions[0].collaboration[0].title, '阻塞问题');
  assert.equal(state.projects[0].activities[0].title, '产物：Nimora UI');
  assert.equal(state.projects[0].activities[0].tone, 'success');
  assert.ok(state.projects[0].activities.some(item => item.kind === 'problem'));

  const replayedState = projectNimoraProductShell(structuredClone(presentation), { projectId: 'p1', missionId: 'm1' }, () => new Date('2026-09-30T05:00:00.000Z'));
  const { generatedAt: firstGeneratedAt, ...firstStable } = projectNimoraProductShell(presentation, { projectId: 'p1', missionId: 'm1' }, () => new Date('2026-09-30T04:00:00.000Z'));
  const { generatedAt: replayGeneratedAt, ...replayStable } = replayedState;
  assert.notEqual(firstGeneratedAt, replayGeneratedAt);
  assert.deepEqual(replayStable, firstStable, 'durable presentation must reconstruct the same Product Shell semantics after restart/re-read');

  const degradedPresentation = structuredClone(presentation);
  degradedPresentation.availability.projects = { status: 'unavailable', detail: 'ProjectStore unavailable marker' };
  degradedPresentation.availability.collaboration = { status: 'unavailable', detail: 'Collaboration depends on ProjectStore' };
  degradedPresentation.projects[0].metadataState = 'unavailable';
  degradedPresentation.projects[0].decisionsState = 'unavailable';
  degradedPresentation.projects[0].collaborationState = 'unavailable';
  const degraded = projectNimoraProductShell(degradedPresentation);
  assert.equal(degraded.system.mode, 'degraded');
  assert.equal(degraded.system.reconstruction, 'partial');
  assert.equal(degraded.projects[0].sourceState.metadata, 'unavailable');

  const unknownPresentation = structuredClone(presentation);
  unknownPresentation.missions[0].executions[0].status = 'unknown';
  unknownPresentation.missions[0].executions[0].resultSummary = 'settlement unresolved';
  const unknown = projectNimoraProductShell(unknownPresentation);
  assert.equal(unknown.unknownExecutionCount, 1);
  assert.equal(unknown.projects[0].unknownExecutionCount, 1);
  assert.ok(unknown.projects[0].attentions.some(item => item.kind === 'execution-unknown' && item.severity === 'blocking'));

  const missingProjectPresentation = structuredClone(presentation);
  missingProjectPresentation.projects[0].metadataState = 'missing';
  missingProjectPresentation.projects[0].decisionsState = 'missing-project';
  missingProjectPresentation.integrityIssues = [{ code:'missing-project', projectId:'p1', missionId:'m1', detail:'Project metadata missing marker' }];
  const missingProject = projectNimoraProductShell(missingProjectPresentation);
  assert.equal(missingProject.system.mode, 'degraded');
  assert.equal(missingProject.system.integrityIssueCount, 1);
  assert.equal(missingProject.projects[0].sourceState.metadata, 'missing');

  const unavailable = projectNimoraProductShell({
    version:1,
    availability:{ projects:{status:'unavailable',detail:'p down'}, tasks:{status:'unavailable',detail:'t down'}, collaboration:{status:'unavailable',detail:'dependent'} },
    projects:[], missions:[], legacyTaskIds:[], integrityIssues:[],
  });
  assert.equal(unavailable.system.mode, 'unavailable');
  assert.equal(unavailable.system.emptyReason, 'owners-unavailable');
  assert.equal(unavailable.totalProjects, 0);

  const empty = projectNimoraProductShell({
    version:1,
    availability:{ projects:{status:'available'}, tasks:{status:'available'}, collaboration:{status:'available'} },
    projects:[], missions:[], legacyTaskIds:[], integrityIssues:[],
  });
  assert.equal(empty.system.mode, 'empty');
  assert.equal(empty.system.emptyReason, 'no-projects');

  let observedAtMs = Date.parse('2026-09-30T06:00:00.000Z');
  let goodCandidateReads = 0;
  let failedCandidateReads = 0;
  const operationalSource = createNimoraProductOperationalSource({
    assignmentCandidateSources: [
      {
        enumerateCandidates: async () => {
          goodCandidateReads++;
          return [{
            candidateId:'chatgpt-page',workerId:'chatgpt',provider:'ChatGPT',kind:'web',availability:'available',models:['gpt-5'],
            capabilities:{streaming:true,reasoning:true,capabilityRequests:true,imageInput:true,checkpoints:false,interruption:true,persistentContext:true},
            observationId:'obs-1',observedAt:'2026-09-30T05:59:00.000Z',health:{status:'healthy',checkedAt:'2026-09-30T05:59:00.000Z'},
          }];
        },
      },
      {
        enumerateCandidates: async () => {
          failedCandidateReads++;
          throw new Error('DeepSeek observation unavailable marker');
        },
      },
    ],
    owners:{workers:{listSessions:() => [{managedSessionId:'live-1',workerId:'chatgpt',adapterSessionId:'adapter-live',taskId:'m1',model:'gpt-5',state:'idle',createdAt:'2026-09-30T05:00:00.000Z',lastActiveAt:'2026-09-30T05:55:00.000Z'}]}},
  }, Promise.resolve(), () => new Date(observedAtMs));
  const operationalFirst = await operationalSource.read();
  assert.equal(operationalFirst.candidateReadState, 'partial');
  assert.equal(operationalFirst.providers.length, 1);
  assert.equal(operationalFirst.providers[0].provider, 'ChatGPT');
  assert.equal(operationalFirst.liveWorkers[0].taskId, 'm1');
  assert.match(operationalFirst.candidateErrors[0], /DeepSeek observation unavailable marker/);
  const operationalCached = await operationalSource.read();
  assert.equal(operationalCached.providers.length, 1);
  assert.equal(goodCandidateReads, 1, 'candidate observation should be cached inside the 10s UI refresh window');
  assert.equal(failedCandidateReads, 1);
  observedAtMs += 10_001;
  await operationalSource.read();
  assert.equal(goodCandidateReads, 2, 'candidate observation should refresh after cache TTL');
  assert.equal(failedCandidateReads, 2);

  const shellSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'nimora-product-shell.ts'), 'utf8');
  assert.match(shellSource, /正在读取 Nimora 工作区/, 'initial loading state must be explicit and user-facing');
  assert.match(shellSource, /缺失信息不会被误判为空/, 'degraded owner state must not collapse unavailable into empty');
  assert.match(shellSource, /UNKNOWN 不等于失败，也不授予重试权限/, 'UNKNOWN UI must preserve no-retry authority semantics');
  assert.match(shellSource, /class="skip-link" href="#main-content"/, 'Product Shell must expose a keyboard skip link');
  assert.match(shellSource, /data-keyboard-nav="global-navigation"/, 'global navigation must opt into keyboard navigation');
  assert.match(shellSource, /ArrowDown.*ArrowUp.*ArrowLeft.*ArrowRight.*Home.*End/s, 'keyboard navigation must cover arrows, Home and End');
  assert.match(shellSource, /button:focus-visible/, 'visible keyboard focus must be retained');
  assert.match(shellSource, /min-width:0/, 'Product Shell must not force a desktop-only minimum viewport width');
  assert.doesNotMatch(shellSource, /<aside class="context-sidebar"/, 'Product Shell must keep one top-level navigation rail instead of rendering a second Project sidebar');
  assert.match(shellSource, /@media\(max-width:760px\)[\s\S]*grid-template-columns:72px minmax\(0,1fr\)/, 'narrow Product Shell must collapse the single navigation rail without overflowing');
  assert.match(shellSource, /id="action-feedback"[\s\S]*aria-live="polite"/, 'host actions must expose immediate accessible feedback');
  assert.match(shellSource, /dataset\.pending === 'true'/, 'Webview must suppress rapid duplicate host-action clicks');
  assert.match(shellSource, /workbench\.action\.closeSidebar/, 'opening Nimora must reclaim editor width by closing the native Explorer sidebar');
  assert.doesNotMatch(shellSource, /@media\(max-width:1(?:1|2)\d{2}px\).*work-resource-side/s, 'desktop-sized canvases must not move AI resources below the primary work row');
  assert.match(shellSource, /@media\(max-width:1050px\)[\s\S]*work-core-grid[\s\S]*grid-template-columns:1fr/, 'only genuinely constrained canvases may collapse the three primary work panels to one column');
  assert.doesNotMatch(shellSource, /style=\"width:\$\{selected\.progress\.percent\}%/, 'progress bars must not rely on CSP-blocked inline style attributes');
  assert.match(shellSource, /<progress class=\"progress-track\" value=\"\$\{selected\.progress\.percent\}"/, 'progress must use CSP-safe native progress values');
  assert.match(shellSource, /exclusiveActionInFlight/, 'Product host must serialize mutating or execution-starting UI actions');
  assert.match(shellSource, /nonExclusiveMessageTypes/, 'read-only navigation and inspection must remain available while an exclusive action runs');
  assert.match(shellSource, /系统正常/, 'reconstruction readiness must be visible as a concise product health state without claiming a restart occurred');
  assert.match(shellSource, /workbench\.action\.chat\.newLocalChat/, 'new Project must start from a fresh Chat session');
  assert.match(shellSource, /workbench\.action\.chat\.open/, 'new Project must reuse the ordinary production Chat ingress');
  assert.match(shellSource, /@shuncode/, 'new Project must target the existing ShunCode default participant instead of a second Formation implementation');
  assert.match(shellSource, /blockOnResponse: true/, 'new Project ingress should wait for the existing Formation\/execution request to settle before reselecting the Project');
  assert.match(shellSource, /scheme: "nimora-task"/, 'Mission continuation must bind the durable nimora-task resource');
  assert.match(shellSource, /openSessionWithPrompt\.nimora-task/, 'Mission continuation must reuse the existing Task Center session ingress');
  assert.match(shellSource, /mission\.executions\.some\(execution => execution\.status === "unknown"\)/, 'Mission continuation must refuse UNKNOWN before sending');
  assert.match(shellSource, /恢复执行资源/, 'missing live execution resource must be a recovery state, not task death');
  assert.match(shellSource, /开始前检查/, 'first-run Product Shell must expose onboarding readiness');
  assert.match(shellSource, /选择位置并新建项目/, 'first run must expose one obvious primary creation action');
  assert.match(shellSource, /推进 \$\{project\.progress\.percent\}%/, 'Project cards must label task percentage as progress rather than formal completion');
  assert.match(shellSource, /管理 API 模型|API 模型/, 'AI resources/settings must expose model onboarding without creating a second provider config store');
  assert.match(shellSource, /project-management-filter/, 'Project management must retain a local non-authoritative filter');
  assert.match(shellSource, /data-view="work"/, 'Work must be a first-class top-level product view');
  assert.match(shellSource, /<h1>项目管理<\/h1>/, 'Project management must be a first-class top-level product surface');
  assert.match(shellSource, /data-action="newProjectAtLocation"/, 'Project management must expose explicit location-first creation');
  assert.match(shellSource, /ARCHIVED_PROJECTS_KEY/, 'project-list removal must remain presentation state instead of deleting durable Project truth');
  assert.match(shellSource, /project-management-filter/, 'first-class Project management must have its own searchable project list');
  assert.match(shellSource, /app\.global-view/, 'global product views must reclaim the duplicate Project-context sidebar width');
  assert.match(shellSource, /ensureProjectWorkspaceForWork/, 'entering work must verify the Project workspace boundary first');
  assert.match(shellSource, /revealFileInOS/, 'opening a Project location must reveal it without silently switching the editor workspace');
  assert.match(shellSource, /没有显示中的项目/, 'hiding every Project must produce a recoverable empty-visible-list state');
  assert.match(shellSource, /NIMORA LOOP/, 'advanced work structure must preserve the Nimora cognition-practice-evidence loop instead of losing architectural truth');
  assert.match(shellSource, /class="work-status-overview"/, 'ordinary Work view must expose the mock-aligned top status overview');
  assert.match(shellSource, /class="work-tabs"/, 'ordinary Work view must expose the mock-aligned horizontal work tabs');
  assert.match(shellSource, /class="work-core-grid"/, 'ordinary Work view must place workflow and current execution side-by-side on desktop');
  assert.match(shellSource, /class="work-resource-side"/, 'ordinary Work view must expose a dedicated AI resource side panel');
  assert.match(shellSource, /work-core-grid\{display:grid;grid-template-columns:minmax\(0,1\.04fr\) minmax\(0,\.96fr\) clamp\(220px,22vw,280px\)/, 'desktop Work view must render workflow, current execution and AI resources in one bounded three-column grid');
  assert.match(shellSource, /main\{padding:0;min-width:0;overflow-x:hidden;overflow-y:auto\}/, 'Work canvas must own vertical scrolling without clipping a nested resource column');
  assert.match(shellSource, /class="workflow-timeline"/, 'ordinary Work view must foreground a human-readable workflow timeline');
  assert.match(shellSource, /class="live-execution-card"/, 'ordinary Work view must expose current execution as a first-class panel');
  assert.match(shellSource, /class="project-detail-tabs"/, 'Project management must expose mock-aligned overview/task/file/settings tabs');
  assert.match(shellSource, /mission\.plane !== "coordination"/, 'Coordinator missions must stay out of the ordinary work-task list');
  assert.match(shellSource, /AI 是资源，不是项目身份/, 'AI resources must be presented as disposable compute rather than project identity');
  assert.match(shellSource, /selectedManagedAutonomy/, 'legacy web-project membership must be translated into managed-autonomy product semantics');
  assert.match(shellSource, /让 Nimora 继续推进/, 'managed Mission detail must hand control back to project autonomy instead of directly driving one Worker');
  assert.match(shellSource, /整体推进/, 'ordinary progress must be labelled as work progress rather than formal completion');
  assert.match(shellSource, /审核并完成项目/, 'formal Project completion must remain a distinct Human-governed action');
  assert.match(shellSource, /proposal\.content\.summary/, 'Governance confirmation must display the fresh owner-projected Proposal rather than Webview-provided text');
  assert.match(shellSource, /proposal\.contentDigest !== message\.contentDigest/, 'Governance must reject stale Proposal digests before prompting the human');
  const extensionSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'extension.ts'), 'utf8');
  assert.match(extensionSource, /registerNimoraProductLayer\s*\(/, 'after Phase 11 closure the canonical production extension must register the thin Product Layer');
  assert.match(extensionSource, /listener\s*=>\s*taskShadow\.onDidChangeTask/, 'Product Shell refresh must observe the canonical Task owner, not invent a second state store');
  assert.match(extensionSource, /registerNimoraAutonomyEntry\s*\(/, 'production extension must register the bounded Cognition-led autonomy entry');
  assert.match(extensionSource, /formationProgressTitle[\s\S]*Nimora · API 规划与建项[\s\S]*Nimora · 网页 AI 规划与建项/, 'Formation progress must describe the actually authorized planner instead of always claiming DeepSeek Web');
  assert.doesNotMatch(extensionSource, /title: "Nimora · DeepSeek 网页建项与协调"/, 'API-capable Formation must not retain a hard-coded DeepSeek progress label');
  assert.match(extensionSource, /project-completion-review/, 'recovered Web Project completion must route through the current owning Cognition');
  const autonomyEntrySource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'nimora-autonomy-entry.ts'), 'utf8');
  assert.match(autonomyEntrySource, /prepareExactFreshDeepSeekWorkers/, 'missing autonomous Workers must be prepared through exact native fresh-page sharing');
  assert.match(autonomyEntrySource, /composition\.plannedWork\.assignReady/, 'autonomy must reuse the canonical parallel assignment owner');
  assert.match(autonomyEntrySource, /composition\.succession\.reconcile/, 'autonomy must reuse same-Mission lifecycle succession before replacement');
  assert.match(autonomyEntrySource, /composition\.autonomy\.run/, 'Product seam must delegate semantic iteration to the core autonomy owner');
  assert.match(autonomyEntrySource, /execution\.status === "unknown"[\s\S]*execution\.deliveryStatus === "pending"/, 'autonomy ingress must still inspect unresolved execution and delivery state');
  assert.match(autonomyEntrySource, /项目仍有待核实、运行中或未确认投递的执行/, 'autonomy ingress must explain fail-closed behavior in user-facing language');
  const extensionManifest = JSON.parse(await fs.readFile(path.join(root, 'extensions', 'shuncode', 'package.json'), 'utf8'));
  assert.ok(extensionManifest.activationEvents.includes('onCommand:shuncode.nimora.open'), 'Nimora Open must be an activation route');
  assert.ok(extensionManifest.contributes.commands.some(command => command.command === 'shuncode.nimora.open'), 'Nimora Open must be exposed in the command palette');
  console.log('PASS Nimora product shell projection smoke');
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
