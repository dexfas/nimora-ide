import { createHash } from "node:crypto";
import { buildRenderedContextHandoff } from "./context-handoff.js";
import type { TaskArtifactRef, TaskSnapshot } from "./task-contract.js";
import type { TaskRuntime } from "./task-runtime.js";
import type { ManagedWorkerSession, RetiredWorkerSession, WorkerAdapterSessionIdentity, WorkerSessionManager } from "./worker-session-manager.js";

export interface MissionFinalizationPolicy {
  requireHandoff?: boolean;
  maxHandoffChars?: number;
}

export interface MissionFinalizationServiceOptions {
  now?: () => Date;
  defaultMaxHandoffChars?: number;
}

export interface MissionFinalizationResult {
  mission: TaskSnapshot;
  handoff?: TaskArtifactRef;
  retiredWorkers: RetiredWorkerSession[];
  logicallyRetiredOrphans: string[];
  cleanupWarnings: string[];
}

const DEFAULT_FINAL_HANDOFF_CHARS = 12_000;

export function getMissionFinalHandoff(snapshot: TaskSnapshot): TaskArtifactRef | undefined {
  const finalization = snapshot.missionFinalization;
  const artifactId = finalization?.handoffArtifactId;
  if (!artifactId) return undefined;
  const matches = snapshot.artifacts.filter(candidate => candidate.artifactId === artifactId);
  if (matches.length !== 1) return undefined;
  const artifact = matches[0];
  if (artifact.metadata?.missionFinalHandoff !== true) return undefined;
  if (artifact.metadata?.missionId !== snapshot.taskId) return undefined;
  if (snapshot.mission?.projectId && artifact.metadata?.projectId !== snapshot.mission.projectId) return undefined;
  if (typeof finalization.handoffSourceEventId !== "string" || !finalization.handoffSourceEventId) return undefined;
  if (!Number.isInteger(finalization.handoffSourceEventCount) || (finalization.handoffSourceEventCount ?? 0) < 1) return undefined;
  if (artifact.metadata?.sourceTaskEventId !== finalization.handoffSourceEventId) return undefined;
  if (artifact.metadata?.sourceTaskEventCount !== finalization.handoffSourceEventCount) return undefined;
  if (typeof finalization.handoffContentDigest !== "string" || !finalization.handoffContentDigest) return undefined;
  const content = artifact.metadata?.content;
  if (typeof content !== "string") return undefined;
  const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (digest !== finalization.handoffContentDigest || artifact.metadata?.contentDigest !== digest) return undefined;
  return artifact ? structuredClone(artifact) : undefined;
}

export function getMissionFinalHandoffText(snapshot: TaskSnapshot): string | undefined {
  const handoff = getMissionFinalHandoff(snapshot);
  const content = handoff?.metadata?.content;
  return typeof content === "string" && content.trim() ? content : undefined;
}

/**
 * Coordinates the Phase 2 Mission death boundary without becoming a second runtime:
 * TaskRuntime owns durable Mission state, WorkerSessionManager owns live resources,
 * and Context Handoff produces the bounded provider-neutral inheritance package.
 */
export class MissionFinalizationService {
  constructor(
    private readonly tasks: TaskRuntime,
    private readonly workers: WorkerSessionManager,
    private readonly options: MissionFinalizationServiceOptions = {},
  ) {}

  async finalizeMission(taskId: string, policy: MissionFinalizationPolicy = {}): Promise<MissionFinalizationResult> {
    await this.tasks.initialize();
    const requireHandoff = policy.requireHandoff ?? true;
    return this.tasks.withMissionFinalizationStabilization(taskId, async initialMission => {
      // The task-level stabilization fence makes this identity snapshot closed:
      // attach/create/rebind/send continuation for this Mission now fails closed.
      // Provider barriers are acquired only after the task lock has been
      // released, so the global ordering remains provider barrier -> task lock.
      const identities = this.ownedAdapterIdentities(initialMission);

      while (true) {
        let waitForSendLeases: WorkerAdapterSessionIdentity[] = [];
        const attempt = await this.workers.withAdapterSessionRetirementScope<MissionFinalizationResult | undefined>(identities, async scope => {
          const activeSendIdentities = identities.filter(identity => scope.hasActiveSendLease(identity));
          if (activeSendIdentities.length) {
            // Never wait while holding the provider-native barriers: send lease
            // cleanup needs the same barrier. Release this scope, wait for the
            // active turn(s), then reacquire every identity and revalidate.
            waitForSendLeases = activeSendIdentities;
            return undefined;
          }

          let mission = this.requireMission(taskId);
          if (mission.missionFinalization) {
            if (mission.missionFinalization.handoffRequired !== requireHandoff) {
              throw new Error(`Mission ${taskId} is already finalized with a different Handoff policy.`);
            }
            if (mission.missionFinalization.handoffRequired && !getMissionFinalHandoff(mission)) {
              throw new Error(`Mission ${taskId} is missing or has an invalid required final Handoff artifact.`);
            }
          } else {
            const activeSessions = identities
              .map(identity => scope.getSession(identity))
              .filter((session): session is ManagedWorkerSession => !!session);
            const unmanagedRunning = activeSessions.filter(session => session.state === "running");
            if (unmanagedRunning.length) {
              throw new Error(`Mission ${taskId} still has ${unmanagedRunning.length} running WorkerSession(s) without a releasable send lease and cannot be finalized.`);
            }

            mission = await this.tasks.finalizeMissionStrict(taskId, {
              handoffRequired: requireHandoff,
              handoffFactory: requireHandoff
                ? (snapshot, completedAt) => this.buildFinalHandoff(snapshot, policy, activeSessions.map(session => session.managedSessionId), completedAt)
                : undefined,
            });
          }

          mission = this.requireMission(taskId);
          const exactLiveSessions = new Map(
            Object.values(mission.workerSessions).flatMap(workerRef => {
              const session = scope.getSession({ workerId: workerRef.workerId, adapterSessionId: workerRef.adapterSessionId });
              return session
                && session.managedSessionId === workerRef.managedSessionId
                ? [[workerRef.managedSessionId, session] as const]
                : [];
            }),
          );
          const logicallyRetiredOrphans: string[] = [];
          for (const worker of Object.values(mission.workerSessions)) {
            if (worker.retiredAt) continue;
            const exactLive = exactLiveSessions.get(worker.managedSessionId);
            const orphaned = !worker.detachedAt && !exactLive;
            const reason = exactLive?.taskId === taskId
              ? "mission-finalized"
              : orphaned
                ? "mission-finalized-orphaned"
                : "mission-finalized-history";
            await this.tasks.retireWorkerSessionStrict(taskId, worker.managedSessionId, { reason });
            if (orphaned) logicallyRetiredOrphans.push(worker.managedSessionId);
          }

          mission = this.requireMission(taskId);
          const retiredWorkers: RetiredWorkerSession[] = [];
          for (const identity of identities) {
            const session = scope.getSession(identity);
            if (session?.state === "running") {
              throw new Error(`Finalized Mission ${taskId} still has a running WorkerSession ${session.managedSessionId}.`);
            }
            const retired = await scope.retire(identity, { reason: "mission-finalized" });
            if (retired) retiredWorkers.push(retired);
          }

          mission = await this.tasks.archiveMissionStrict(taskId);
          const cleanupWarnings = retiredWorkers.flatMap(worker => [
            worker.ownershipPersistenceError ? `${worker.managedSessionId}: ${worker.ownershipPersistenceError}` : undefined,
            worker.disposeError ? `${worker.managedSessionId}: ${worker.disposeError}` : undefined,
          ].filter((warning): warning is string => !!warning));
          return {
            mission,
            handoff: getMissionFinalHandoff(mission),
            retiredWorkers,
            logicallyRetiredOrphans,
            cleanupWarnings,
          };
        });

        if (attempt) return attempt;
        await this.workers.waitForAdapterSessionSendLeases(waitForSendLeases);
      }
    });
  }

  private ownedAdapterIdentities(mission: TaskSnapshot): WorkerAdapterSessionIdentity[] {
    const identities = new Map<string, WorkerAdapterSessionIdentity>();
    for (const workerRef of Object.values(mission.workerSessions)) {
      const key = `${workerRef.workerId}\u0000${workerRef.adapterSessionId}`;
      if (!identities.has(key)) {
        identities.set(key, { workerId: workerRef.workerId, adapterSessionId: workerRef.adapterSessionId });
      }
    }
    return [...identities.values()];
  }

  private buildFinalHandoff(
    mission: TaskSnapshot,
    policy: MissionFinalizationPolicy,
    activeManagedSessionIds: readonly string[],
    generatedAt: string,
  ): Omit<TaskArtifactRef, "artifactId" | "createdAt"> & { createdAt?: string } {
    const rendered = buildRenderedContextHandoff(mission, {
      generatedAt,
      sourceManagedSessionId: activeManagedSessionIds.length === 1 ? activeManagedSessionIds[0] : undefined,
      maxChars: Math.max(256, Math.floor(policy.maxHandoffChars ?? this.options.defaultMaxHandoffChars ?? DEFAULT_FINAL_HANDOFF_CHARS)),
    });
    return {
      kind: "report",
      title: "Mission final Handoff",
      createdAt: generatedAt,
      metadata: {
        missionFinalHandoff: true,
        handoffVersion: 1,
        projectId: mission.mission!.projectId,
        missionId: mission.taskId,
        content: rendered.text,
        contentLanguage: "markdown",
        contentTruncated: rendered.truncatedSections.length > 0,
        truncatedSections: [...rendered.truncatedSections],
        omitted: [...rendered.package.omitted],
      },
    };
  }

  private requireMission(taskId: string): TaskSnapshot {
    const task = this.tasks.getTask(taskId);
    if (!task) throw new Error(`Unknown task: ${taskId}`);
    if (!task.mission) throw new Error(`Task ${taskId} is not configured as a Mission.`);
    return task;
  }

}
