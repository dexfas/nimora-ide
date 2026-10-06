import { createHash } from "node:crypto";
import { buildRenderedContextHandoff } from "./context-handoff.js";
import {
  classifyWorkerConversationCapacity,
  decideWorkerConversationLifecycle,
  type WorkerConversationBudget,
  type WorkerConversationCapacityObservation,
  type WorkerConversationLifecycleDecision,
} from "./worker-conversation-lifecycle.js";
import type { TaskRuntime } from "./task-runtime.js";
import type { TaskSnapshot } from "./task-contract.js";
import {
  type MissionWorkerAssignmentService,
  type WorkerAssignmentRequest,
  type WorkerAssignmentResult,
} from "./worker-assignment.js";
import type { WorkerSessionManager } from "./worker-session-manager.js";

const HANDOFF_SCHEMA = "nimora-worker-succession-handoff-v1";
const MAX_HANDOFF_CHARS = 36_000;

export interface MissionWorkerSuccessionScope {
  projectId: string;
  rootMissionId: string;
  missionId: string;
}
export interface MissionWorkerSuccessionInspection {
  version: 1;
  kind: "mission-worker-succession-inspection";
  scope: MissionWorkerSuccessionScope;
  managedSessionId: string;
  capacity: WorkerConversationCapacityObservation;
  knownSettled: boolean;
  handoffArtifactId?: string;
  decision: WorkerConversationLifecycleDecision;
}
export interface MissionWorkerSuccessionResult extends MissionWorkerSuccessionInspection {
  state: "continued" | "handoff-prepared" | "waiting-for-settlement" | "replacement-needed" | "replaced";
  replacement?: WorkerAssignmentResult;
  providerCleanup: "deferred-not-authoritative";
}

function handoffArtifactId(missionId: string, managedSessionId: string, eventCount: number): string {
  const digest = createHash("sha256").update(JSON.stringify(["worker-succession-v1", missionId, managedSessionId, eventCount])).digest("hex");
  return `worker-succession-handoff:${digest}`;
}

/**
 * Executes only mechanical same-Mission succession. It never decides Mission
 * semantics, retries old work, or treats provider cleanup as business truth.
 */
export class MissionWorkerSuccessionService {
  constructor(
    private readonly tasks: TaskRuntime,
    private readonly workers: WorkerSessionManager,
    private readonly assignments: MissionWorkerAssignmentService,
  ) {}

  async inspect(scope: MissionWorkerSuccessionScope, budget?: Partial<WorkerConversationBudget>): Promise<MissionWorkerSuccessionInspection> {
    await this.tasks.initialize();
    const mission = this.requireMission(scope);
    const sessionId = this.currentSessionId(mission);
    const session = this.workers.getSession(sessionId)!;
    const capacity = classifyWorkerConversationCapacity(this.workers.inspectConversationUsage(sessionId), { budget });
    let knownSettled = false;
    await this.workers.withAdapterSessionRetirementScope(
      [{ workerId: session.workerId, adapterSessionId: session.adapterSessionId }],
      async owner => { knownSettled = owner.isKnownSettled({ workerId: session.workerId, adapterSessionId: session.adapterSessionId }); },
    );
    const handoff = this.findHandoff(mission, sessionId);
    const decision = decideWorkerConversationLifecycle({
      capacity,
      knownSettled,
      handoffReady: !!handoff,
      replacementAttached: false,
      retired: false,
      providerCleanupComplete: false,
    });
    return {
      version: 1,
      kind: "mission-worker-succession-inspection",
      scope: { ...scope },
      managedSessionId: sessionId,
      capacity,
      knownSettled,
      ...(handoff ? { handoffArtifactId: handoff.artifactId } : {}),
      decision,
    };
  }

  async reconcile(input: MissionWorkerSuccessionScope & {
    budget?: Partial<WorkerConversationBudget>;
    assignment?: WorkerAssignmentRequest;
    exactCandidateId?: string;
  }): Promise<MissionWorkerSuccessionResult> {
    let inspected = await this.inspect(input, input.budget);
    if (inspected.capacity.state === "normal" || inspected.capacity.state === "unknown") {
      return { ...inspected, state: "continued", providerCleanup: "deferred-not-authoritative" };
    }
    if (!inspected.knownSettled && (inspected.capacity.state === "rotation-required" || inspected.capacity.state === "exhausted")) {
      return { ...inspected, state: "waiting-for-settlement", providerCleanup: "deferred-not-authoritative" };
    }
    if (!inspected.handoffArtifactId) {
      await this.prepareHandoff(input, inspected.managedSessionId, inspected.capacity);
      inspected = await this.inspect(input, input.budget);
    }
    if (inspected.capacity.state === "approaching-limit") {
      return { ...inspected, state: "handoff-prepared", providerCleanup: "deferred-not-authoritative" };
    }
    if (!input.assignment || !input.exactCandidateId) {
      return { ...inspected, state: "replacement-needed", providerCleanup: "deferred-not-authoritative" };
    }
    if (input.assignment.projectId !== input.projectId || input.assignment.rootMissionId !== input.rootMissionId
      || input.assignment.missionId !== input.missionId) {
      throw new Error("Worker succession assignment does not match the exact Mission scope.");
    }
    const replacement = await this.assignments.replaceSettledRestricted(
      input.assignment,
      inspected.managedSessionId,
      input.exactCandidateId,
    );
    const current = this.requireMission(input);
    const live = this.workers.listSessions({ taskId: input.missionId }).filter(session => session.state !== "disposed");
    if (live.length !== 1 || live[0].managedSessionId !== replacement.managedSessionId
      || !current.workerSessions[replacement.managedSessionId] || current.workerSessions[replacement.managedSessionId].retiredAt) {
      throw new Error("Worker replacement did not converge to one current same-Mission Worker.");
    }
    return {
      ...inspected,
      state: "replaced",
      replacement,
      providerCleanup: "deferred-not-authoritative",
    };
  }

  private async prepareHandoff(scope: MissionWorkerSuccessionScope, sourceManagedSessionId: string,
    capacity: WorkerConversationCapacityObservation): Promise<void> {
    const mission = this.requireMission(scope);
    const existing = this.findHandoff(mission, sourceManagedSessionId);
    if (existing) return;
    const rendered = buildRenderedContextHandoff(mission, {
      sourceManagedSessionId,
      maxChars: MAX_HANDOFF_CHARS,
    });
    const contentDigest = `sha256:${createHash("sha256").update(rendered.text).digest("hex")}`;
    await this.tasks.recordArtifactStrict(scope.missionId, {
      artifactId: handoffArtifactId(scope.missionId, sourceManagedSessionId, mission.eventCount),
      kind: "report",
      title: "Same-Mission Worker succession Handoff",
      metadata: {
        schema: HANDOFF_SCHEMA,
        sourceManagedSessionId,
        sourceEventCount: mission.eventCount,
        contentDigest,
        text: rendered.text,
        truncatedSections: [...rendered.truncatedSections],
        capacity,
      },
    });
  }

  private findHandoff(task: TaskSnapshot, sourceManagedSessionId: string) {
    return task.artifacts.find(artifact => artifact.metadata?.schema === HANDOFF_SCHEMA
      && artifact.metadata.sourceManagedSessionId === sourceManagedSessionId
      && typeof artifact.metadata.contentDigest === "string"
      && typeof artifact.metadata.text === "string");
  }

  private requireMission(scope: MissionWorkerSuccessionScope): TaskSnapshot {
    const task = this.tasks.getTask(scope.missionId);
    if (!task?.mission || task.mission.projectId !== scope.projectId || task.mission.rootMissionId !== scope.rootMissionId
      || task.missionFinalization) {
      throw new Error("Worker succession scope does not identify an active Mission.");
    }
    return task;
  }

  private currentSessionId(task: TaskSnapshot): string {
    const durable = Object.values(task.workerSessions).filter(ref => !ref.detachedAt && !ref.retiredAt);
    const live = this.workers.listSessions({ taskId: task.taskId }).filter(session => session.state !== "disposed");
    if (durable.length !== 1 || live.length !== 1 || durable[0].managedSessionId !== live[0].managedSessionId
      || durable[0].workerId !== live[0].workerId || durable[0].adapterSessionId !== live[0].adapterSessionId) {
      throw new Error("Worker succession requires exactly one coherent current Worker.");
    }
    return live[0].managedSessionId;
  }
}
