import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-governance-human-'));
const bundle = path.join(directory, 'application.cjs');

await esbuild.build({
  entryPoints: [path.join(root, 'src', 'project-governance-human-application.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});

const { ProjectGovernanceHumanApplication } = require(bundle);
try {
  const proposal = {
    proposalId: 'proposal-1',
    contentDigest: 'sha256:proposal-1',
    content: { kind: 'decision', summary: 'Use the Project-first product shell', scope: { kind: 'project' } },
    proposedAt: '2026-09-30T00:00:00.000Z',
  };
  const project = {
    projectId: 'project-1', proposals: { [proposal.proposalId]: proposal }, humanConfirmations: {}, committedDecisions: {},
  };
  let confirmationCalls = 0;
  let commitCalls = 0;
  const projects = {
    async initialize() {},
    getProject() { return structuredClone(project); },
    async confirmProposalHuman(projectId, input) {
      assert.equal(projectId, project.projectId);
      assert.deepEqual(input, { proposalId: proposal.proposalId, contentDigest: proposal.contentDigest });
      confirmationCalls += 1;
      project.humanConfirmations[proposal.proposalId] = { confirmationId: 'confirmation-1', proposalId: proposal.proposalId, contentDigest: proposal.contentDigest, confirmedAt: '2026-09-30T00:01:00.000Z' };
      return structuredClone(project.humanConfirmations[proposal.proposalId]);
    },
  };
  const decisions = {
    async commitProposal(projectId, input) {
      assert.equal(projectId, project.projectId);
      assert.equal(input.proposalId, proposal.proposalId);
      assert.ok(project.humanConfirmations[proposal.proposalId], 'Commit must observe durable Human Confirmation first');
      commitCalls += 1;
      return { decision: { decisionId: 'decision-1' }, impact: { routeableMissionIds: ['mission-1'], excluded: [] } };
    },
  };

  const application = new ProjectGovernanceHumanApplication(projects, decisions);
  await assert.rejects(
    () => application.commitAlreadyConfirmed({ projectId: project.projectId, proposalId: proposal.proposalId, contentDigest: proposal.contentDigest }),
    /lacks matching durable Human Confirmation/,
  );
  assert.equal(commitCalls, 0, 'UI cannot Commit before durable Human Confirmation');

  await assert.rejects(
    () => application.acceptProposal({ projectId: project.projectId, proposalId: proposal.proposalId, contentDigest: 'sha256:stale' }),
    /changed since it was presented/,
  );
  assert.equal(confirmationCalls, 0, 'stale UI digest must fail before Human Confirmation');

  const accepted = await application.acceptProposal({ projectId: project.projectId, proposalId: proposal.proposalId, contentDigest: proposal.contentDigest });
  assert.equal(confirmationCalls, 1);
  assert.equal(commitCalls, 1);
  assert.deepEqual(accepted.impact.routeableMissionIds, ['mission-1']);
  console.log('PASS Project governance human application smoke');
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
