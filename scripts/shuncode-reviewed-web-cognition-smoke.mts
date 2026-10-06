import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-reviewed-cognition-'));
try {
  const file = path.join(temp, 'reviewed.cjs');
  await esbuild.build({
    entryPoints: [path.join(root, 'extensions', 'shuncode', 'src', 'nimora-reviewed-web-cognition.ts')],
    outfile: file, bundle: true, platform: 'node', format: 'cjs', target: 'es2022', logLevel: 'silent',
  });
  const { validateReviewedWebCognition } = require(file);
  const workspace = '/workspace/test';
  const candidate = {
    classification: 'requires-human-confirmation',
    project: { title: '个人任务管理器项目', goal: '在当前测试文件夹中完成个人任务管理器' },
    initialRoot: {
      goal: '读取需求.txt 并确认需求范围', plane: 'cognition', missionType: 'requirements-analysis',
      completionCriteria: ['阅读需求', '确认范围'], contextSummary: '只能在本地测试文件夹中工作',
      constraints: ['不能删除其他文件'],
    },
    coordinatorPolicy: { constraints: {}, preferences: {} },
    workerPolicy: { constraints: {}, preferences: {} },
    instruction: '先读取文件并获得确认，不写代码。',
    requiredCapabilityIds: ['workspace.list-directory', 'workspace.read-files'],
  };
  const raw = JSON.stringify(candidate);
  const accepted = validateReviewedWebCognition(raw, workspace);
  assert.equal(accepted.projectTitle, '个人任务管理器项目');
  assert.equal(accepted.digest.length, 64);
  const admitted = JSON.parse(accepted.json);
  assert.deepEqual(admitted.coordinatorPolicy.constraints.allowedProviders, ['deepseek']);
  assert.deepEqual(admitted.workerPolicy.constraints.allowedKinds, ['web']);
  assert.deepEqual(admitted.requiredCapabilityIds, candidate.requiredCapabilityIds);
  const mutate = (change) => validateReviewedWebCognition(JSON.stringify(change), workspace);
  assert.throws(() => mutate({ ...candidate, classification: 'clear-intent' }), /人工恢复/);
  assert.throws(() => mutate({ ...candidate, project: { ...candidate.project, workspace: '/another' } }), /工作区/);
  assert.throws(() => mutate({ ...candidate, initialRoot: { ...candidate.initialRoot, plane: 'practice' } }), /只允许.*Cognition/);
  assert.throws(() => mutate({ ...candidate, requiredCapabilityIds: ['workspace.apply-patch'] }), /只能请求列目录和读文件/);
  assert.throws(() => mutate({ ...candidate, coordinatorPolicy: { constraints: { allowedProviders: ['openai-chatgpt'] } } }), /冲突/);
  assert.throws(() => mutate({ ...candidate, arbitrary: 'unreviewed' }), /七项字段/);
  if (process.argv[2]) {
    const original = await fs.readFile(process.argv[2], 'utf8');
    const recovered = validateReviewedWebCognition(original, process.argv[3] || workspace);
    assert.equal(recovered.projectTitle, '个人任务管理器项目');
    assert.deepEqual(JSON.parse(recovered.json).requiredCapabilityIds, candidate.requiredCapabilityIds);
    console.log('ACTUAL_USER_PROVIDED_JSON_VALIDATED', JSON.stringify({ title: recovered.projectTitle,
      sha256: recovered.digest, firstMissionGoal: recovered.firstMissionGoal }));
  }
  console.log('PASS reviewed Web Cognition: strict canonical preflight, read-only capabilities, DeepSeek-only policy, workspace isolation, rejection fixtures');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
