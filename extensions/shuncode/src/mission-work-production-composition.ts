import { MissionCapabilityMaterializer } from "../../../src/mission-capability-materializer.js";
import { MissionContextMaterializer } from "../../../src/mission-context-materializer.js";
import { MissionCoordinatorCompletionService } from "../../../src/mission-coordinator-completion-service.js";
import {
  MissionCoordinatorLiveDriver,
  type MissionNativeCapabilityTurnBinding,
} from "../../../src/mission-coordinator-live-driver.js";
import { MissionCoordinatorService } from "../../../src/mission-coordinator-service.js";
import { MissionCognitionPlanService } from "../../../src/mission-cognition-plan.js";
import { MissionAutonomyLoopService } from "../../../src/mission-autonomy-loop.js";
import { MissionParallelAssignmentService, MissionParallelReadinessService } from "../../../src/mission-parallel-orchestration.js";
import { MissionFeedbackService } from "../../../src/mission-feedback-service.js";
import { MissionFinalizationService } from "../../../src/mission-finalization-service.js";
import { NimoraSkillIndex } from "../../../src/mission-skill-index.js";
import { MissionSkillMaterializer } from "../../../src/mission-skill-materializer.js";
import { MissionWorkerInputMaterializer } from "../../../src/mission-worker-input-materializer.js";
import { MissionWorkerSelectionApplication } from "../../../src/mission-worker-selection-application.js";
import { MissionWorkerSuccessionService } from "../../../src/mission-worker-succession-service.js";
import { MissionUserEntryApplication } from "../../../src/mission-user-entry-application.js";
import { ProjectDecisionService } from "../../../src/project-decision-service.js";
import {
  ProjectFormationApplicationService,
  type ProjectFormationApplicationServiceOptions,
} from "../../../src/project-formation-application-service.js";
import { ProjectFormationService } from "../../../src/project-formation-service.js";
import { ProjectRootOperationService } from "../../../src/project-root-operation-service.js";
import type { MissionCollaborationStore } from "../../../src/mission-collaboration-store.js";
import type { HostCapabilityExecutionDelivery } from "../../../src/host-capability-request-dispatcher.js";
import type { ProjectStore } from "../../../src/project-store.js";
import type { TaskRuntime } from "../../../src/task-runtime.js";
import { MissionWorkerAssignmentService } from "../../../src/worker-assignment.js";
import type { WorkerSessionManager } from "../../../src/worker-session-manager.js";
import type { WorkerAssignmentCandidateSource } from "../../../src/worker-assignment.js";
import type { MissionSkillSourceAdapter } from "../../../src/mission-skill-index.js";
import { SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES } from "./bridge-task-tool-definitions.js";
import { ChatGptBrowserWorkerCandidateSource } from "./chatgpt-browser-worker-candidate-source.js";
import { createNimoraFirstPartySkillSource } from "./nimora-first-party-skills.js";
import { WebMcpWorkerAssignmentCandidateSource } from "./webmcp-worker-candidate-source.js";
import type { WebMcpCommandExecutor } from "./webmcp-worker-transport.js";

export interface MissionWorkCanonicalOwners {
  projects: ProjectStore;
  tasks: TaskRuntime;
  collaboration: MissionCollaborationStore;
  workers: WorkerSessionManager;
}

/**
 * One production composition root over already-created canonical owners. This
 * object owns no Project/Mission/Worker state itself; it only wires stateless
 * services and the one truthful current WebMCP Phase 7 candidate source.
 */
export function createMissionWorkProductionComposition(
  owners: MissionWorkCanonicalOwners,
  webMcpCommands: WebMcpCommandExecutor,
  hostCapabilityExecution?: HostCapabilityExecutionDelivery,
  nativeCapabilityTurnBinding?: MissionNativeCapabilityTurnBinding,
  applicationOptions: ProjectFormationApplicationServiceOptions = {},
  integrations: { candidateSources?: readonly WorkerAssignmentCandidateSource[]; skillSources?: readonly MissionSkillSourceAdapter[];
    approvedSkills?: (scope: { projectId: string; rootMissionId: string; missionId: string }) => Promise<readonly string[]>;
    softLatency?: (candidate: import("../../../src/worker-assignment.js").WorkerAssignmentCandidate) => number | undefined } = {},
) {
  const formation = new ProjectFormationService(owners.projects, owners.tasks);
  const feedback = new MissionFeedbackService(owners.projects, owners.tasks, owners.collaboration);
  const decisions = new ProjectDecisionService(owners.projects, owners.tasks);
  const coordinator = new MissionCoordinatorService(owners.projects, owners.tasks, owners.collaboration, feedback);
  const finalization = new MissionFinalizationService(owners.tasks, owners.workers);
  const completion = new MissionCoordinatorCompletionService(
    owners.tasks,
    owners.collaboration,
    coordinator,
    owners.workers,
    finalization,
  );
  const laterRoots = new ProjectRootOperationService(owners.projects, owners.tasks, coordinator);
  const chatGptCandidates = new ChatGptBrowserWorkerCandidateSource(owners.workers, webMcpCommands);
  const webCandidates = new WebMcpWorkerAssignmentCandidateSource(owners.workers, webMcpCommands);
  const assignmentCandidateSources = Object.freeze([chatGptCandidates, webCandidates, ...(integrations.candidateSources ?? [])]);
  const assignments = new MissionWorkerAssignmentService(owners.tasks, owners.workers, assignmentCandidateSources, integrations.softLatency);
  const succession = new MissionWorkerSuccessionService(owners.tasks, owners.workers, assignments);
  const parallelReadiness = new MissionParallelReadinessService(owners.projects, owners.tasks, owners.collaboration, owners.workers);
  const parallelAssignments = new MissionParallelAssignmentService(parallelReadiness, assignments);
  const plannedWork = new MissionCognitionPlanService(coordinator, owners.collaboration, parallelReadiness, parallelAssignments);
  const context = new MissionContextMaterializer(owners.projects, owners.tasks, owners.collaboration, owners.workers);
  const capability = new MissionCapabilityMaterializer(
    owners.projects,
    owners.tasks,
    owners.workers,
    SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES,
  );
  // Code-authorized first-party Skills are bounded workflow guidance only. They
  // cannot own Project truth, grant capabilities or weaken approval semantics.
  const skills = new MissionSkillMaterializer(
    owners.projects, owners.tasks, owners.workers,
    new NimoraSkillIndex([createNimoraFirstPartySkillSource(), ...(integrations.skillSources ?? [])]),
    integrations.approvedSkills,
  );
  const workerInput = new MissionWorkerInputMaterializer(context, capability, skills, owners.tasks, owners.workers);
  const liveDriver = new MissionCoordinatorLiveDriver(
    owners.projects,
    owners.tasks,
    owners.collaboration,
    coordinator,
    feedback,
    decisions,
    owners.workers,
    completion,
    workerInput,
    hostCapabilityExecution,
    nativeCapabilityTurnBinding,
  );
  const autonomy = new MissionAutonomyLoopService(
    owners.tasks,
    owners.collaboration,
    owners.workers,
    coordinator,
    liveDriver,
    plannedWork,
    parallelReadiness,
    finalization,
  );
  const application = new ProjectFormationApplicationService(
    owners.projects,
    owners.tasks,
    owners.workers,
    formation,
    coordinator,
    assignments,
    liveDriver,
    laterRoots,
    finalization,
    completion,
    applicationOptions,
  );
  return {
    workerSelection: new MissionWorkerSelectionApplication(assignments, workerInput, application),
    userEntry: new MissionUserEntryApplication(application, owners.tasks, owners.workers, liveDriver),
    owners,
    application,
    formation,
    feedback,
    decisions,
    coordinator,
    finalization,
    completion,
    laterRoots,
    assignments,
    succession,
    parallelReadiness,
    parallelAssignments,
    plannedWork,
    chatGptCandidates,
    webCandidates,
    context,
    capability,
    skills,
    workerInput,
    liveDriver,
    autonomy,
    assignmentCandidateSources,
  };
}
