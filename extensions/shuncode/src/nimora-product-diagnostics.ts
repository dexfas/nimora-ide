import type { NimoraProductShellState } from "../../../src/nimora-product-shell-projection.js";
import type { NimoraProductOperationalSnapshot } from "./nimora-product-operations.js";

export interface NimoraProductDiagnosticsInput {
  state: NimoraProductShellState;
  operations?: NimoraProductOperationalSnapshot;
  extensionVersion: string;
  workspaceTrusted: boolean;
  platform: NodeJS.Platform;
  arch: string;
  autonomyOutcomes?: Readonly<Record<string, { state: string; reason?: string; recordedAt: string }>>;
}

export interface NimoraProductDiagnosticsReport {
  schema: "nimora-product-diagnostics-v1";
  generatedAt: string;
  privacy: {
    projectContentIncluded: false;
    providerTranscriptIncluded: false;
    credentialsIncluded: false;
    workspacePathsIncluded: false;
  };
  product: {
    extensionVersion: string;
    platform: NodeJS.Platform;
    arch: string;
  };
  safety: {
    workspaceTrusted: boolean;
    capabilityApprovalRequiredForTerminal: true;
    terminalInvocationCwdBoundedToWorkspace: true;
    durablePerInputWorkspacePathPolicy: true;
    workspaceFileToolsEnforceInputPolicy: true;
    workspaceScopedIdeTargetAdmissionEnforcesInputPolicy: true;
    osSandboxIntegratedWithNimoraTerminalCapability: true;
    osSandboxExactWorkOrderWriteRoots: true;
    osSandboxNetworkDefaultDeny: true;
    osSandboxUnsandboxedFallbackDisabled: true;
    osSandboxLiveCertifiedOnCurrentHost: false;
    unattendedStableSafetyReady: false;
    note: string;
  };
  system: {
    mode: NimoraProductShellState["system"]["mode"];
    reconstruction: NimoraProductShellState["system"]["reconstruction"];
    owners: NimoraProductShellState["system"]["owners"];
    integrityIssueCount: number;
    integrityIssueCodes: string[];
    legacyTaskCount: number;
    totalProjects: number;
    activeProjects: number;
    activeMissions: number;
    attentionCount: number;
    unknownExecutionCount: number;
  };
  projects: Array<{
    projectId: string;
    status: string;
    missionCount: number;
    activeMissionCount: number;
    completedMissionCount: number;
    attentionCount: number;
    unknownExecutionCount: number;
    progressPercent: number;
    sourceState: unknown;
    autonomyOutcome?: { state: string; reason?: string; recordedAt: string };
    missions: Array<{
      missionId: string;
      role: string;
      plane: string;
      status: string;
      terminal: boolean;
      activeWorkerCount: number;
      executionCount: number;
      failedExecutionCount: number;
      artifactCount: number;
      openProblemCount: number;
    }>;
  }>;
  operations: {
    state: "available" | "partial" | "unavailable" | "not-read";
    candidateErrorCount: number;
    providers: Array<{ provider: string; kind: string; availability: string; models: string[]; observedAt: string }>;
    liveWorkers: Array<{ managedSessionId: string; taskId?: string; workerId: string; model?: string; state: string }>;
  };
}

/**
 * Builds a deliberately content-redacted diagnostic report. Project goals,
 * workspace paths, provider conversations, tool outputs and credentials are
 * omitted by construction.
 */
export function buildNimoraProductDiagnostics(input: NimoraProductDiagnosticsInput): NimoraProductDiagnosticsReport {
  const outcomes = input.autonomyOutcomes ?? {};
  return {
    schema: "nimora-product-diagnostics-v1",
    generatedAt: new Date().toISOString(),
    privacy: {
      projectContentIncluded: false,
      providerTranscriptIncluded: false,
      credentialsIncluded: false,
      workspacePathsIncluded: false,
    },
    product: {
      extensionVersion: input.extensionVersion,
      platform: input.platform,
      arch: input.arch,
    },
    safety: {
      workspaceTrusted: input.workspaceTrusted,
      capabilityApprovalRequiredForTerminal: true,
      terminalInvocationCwdBoundedToWorkspace: true,
      durablePerInputWorkspacePathPolicy: true,
      workspaceFileToolsEnforceInputPolicy: true,
      workspaceScopedIdeTargetAdmissionEnforcesInputPolicy: true,
      osSandboxIntegratedWithNimoraTerminalCapability: true,
      osSandboxExactWorkOrderWriteRoots: true,
      osSandboxNetworkDefaultDeny: true,
      osSandboxUnsandboxedFallbackDisabled: true,
      osSandboxLiveCertifiedOnCurrentHost: false,
      unattendedStableSafetyReady: false,
      note: "Nimora now routes host-managed run_command through a fail-closed OS sandbox using exact durable Work Order write roots, default-deny network policy, isolated sandbox temp storage and no unsandboxed fallback. Canonical path admission also resolves existing symlink/junction ancestors and rejects multi-root ambiguity. This source integration is not yet live-certified on the current Windows host, so unattended Stable mode remains gated.",
    },
    system: {
      mode: input.state.system.mode,
      reconstruction: input.state.system.reconstruction,
      owners: input.state.system.owners.map(owner => ({ ...owner })),
      integrityIssueCount: input.state.system.integrityIssueCount,
      integrityIssueCodes: [...new Set(input.state.system.integrityIssues.map(issue => issue.code))].sort(),
      legacyTaskCount: input.state.system.legacyTaskCount,
      totalProjects: input.state.totalProjects,
      activeProjects: input.state.activeProjects,
      activeMissions: input.state.activeMissions,
      attentionCount: input.state.attentionCount,
      unknownExecutionCount: input.state.unknownExecutionCount,
    },
    projects: input.state.projects.map(project => ({
      projectId: project.projectId,
      status: project.status,
      missionCount: project.missionCount,
      activeMissionCount: project.activeMissionCount,
      completedMissionCount: project.completedMissionCount,
      attentionCount: project.attentionCount,
      unknownExecutionCount: project.unknownExecutionCount,
      progressPercent: project.progress.percent,
      sourceState: structuredClone(project.sourceState),
      autonomyOutcome: outcomes[project.projectId] ? { ...outcomes[project.projectId] } : undefined,
      missions: project.missions.map(mission => ({
        missionId: mission.missionId,
        role: mission.role,
        plane: mission.plane,
        status: mission.status,
        terminal: mission.terminal,
        activeWorkerCount: mission.activeWorkerCount,
        executionCount: mission.executionCount,
        failedExecutionCount: mission.failedExecutionCount,
        artifactCount: mission.artifactCount,
        openProblemCount: mission.problems.filter(problem => problem.state === "Open").length,
      })),
    })),
    operations: input.operations ? {
      state: input.operations.candidateReadState,
      candidateErrorCount: input.operations.candidateErrors.length,
      providers: input.operations.providers.map(provider => ({
        provider: provider.provider,
        kind: provider.kind,
        availability: provider.availability,
        models: [...provider.models],
        observedAt: provider.observedAt,
      })),
      liveWorkers: input.operations.liveWorkers.map(worker => ({
        managedSessionId: worker.managedSessionId,
        taskId: worker.taskId,
        workerId: worker.workerId,
        model: worker.model,
        state: worker.state,
      })),
    } : {
      state: "not-read",
      candidateErrorCount: 0,
      providers: [],
      liveWorkers: [],
    },
  };
}
