import type { CommitProjectDecisionResult, ProjectDecisionService } from "./project-decision-service.js";
import type { ProjectStore } from "./project-store.js";

export interface HumanAcceptProjectProposalInput {
  projectId: string;
  proposalId: string;
  contentDigest: string;
}

/**
 * Explicit trusted-human application seam for Project governance.
 *
 * This service intentionally owns no Project truth. It re-reads the current
 * canonical Proposal, binds Human Confirmation to the exact digest, then uses
 * the already-verified ProjectDecisionService Commit path. Chat text, Worker
 * output and UI state cannot manufacture confirmation through this API.
 */
export class ProjectGovernanceHumanApplication {
  constructor(
    private readonly projects: Pick<ProjectStore, "initialize" | "getProject" | "confirmProposalHuman">,
    private readonly decisions: Pick<ProjectDecisionService, "commitProposal">,
  ) {}

  async acceptProposal(input: HumanAcceptProjectProposalInput): Promise<CommitProjectDecisionResult> {
    const current = await this.requireCurrentProposal(input);
    await this.projects.confirmProposalHuman(input.projectId, {
      proposalId: current.proposalId,
      contentDigest: current.contentDigest,
    });
    return this.decisions.commitProposal(input.projectId, { proposalId: current.proposalId });
  }

  async commitAlreadyConfirmed(input: HumanAcceptProjectProposalInput): Promise<CommitProjectDecisionResult> {
    const current = await this.requireCurrentProposal(input);
    const project = this.projects.getProject(input.projectId)!;
    const confirmation = project.humanConfirmations[current.proposalId];
    if (!confirmation || confirmation.contentDigest !== current.contentDigest) {
      throw new Error(`Project Proposal ${current.proposalId} lacks matching durable Human Confirmation.`);
    }
    return this.decisions.commitProposal(input.projectId, { proposalId: current.proposalId });
  }

  private async requireCurrentProposal(input: HumanAcceptProjectProposalInput) {
    await this.projects.initialize();
    const project = this.projects.getProject(input.projectId);
    if (!project) throw new Error(`Unknown Project: ${input.projectId}`);
    const proposal = project.proposals[input.proposalId];
    if (!proposal) throw new Error(`Project Proposal does not exist: ${input.proposalId}`);
    if (proposal.supersededByProposalId) throw new Error(`Project Proposal ${input.proposalId} is superseded.`);
    if (proposal.contentDigest !== input.contentDigest) {
      throw new Error(`Project Proposal ${input.proposalId} changed since it was presented.`);
    }
    const committed = Object.values(project.committedDecisions).find(decision => decision.proposalId === input.proposalId);
    if (committed) throw new Error(`Project Proposal ${input.proposalId} is already committed.`);
    return proposal;
  }
}
