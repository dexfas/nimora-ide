import type { WorkerAssignmentAvailability, WorkerAssignmentHealthObservation } from "../../../src/worker-assignment.js";
import type { ManagedWorkerSession } from "../../../src/worker-session-manager.js";
import type { createMissionWorkProductionComposition } from "./mission-work-production-composition.js";

type Composition = ReturnType<typeof createMissionWorkProductionComposition>;

export interface NimoraProductProviderObservation {
  provider: string;
  workerId: string;
  kind: string;
  availability: WorkerAssignmentAvailability;
  models: string[];
  health?: WorkerAssignmentHealthObservation;
  observedAt: string;
}

export interface NimoraProductOperationalSnapshot {
  generatedAt: string;
  candidateReadState: "available" | "partial" | "unavailable";
  candidateErrors: string[];
  providers: NimoraProductProviderObservation[];
  liveWorkers: ManagedWorkerSession[];
}

export interface NimoraProductOperationalSource {
  read(): Promise<NimoraProductOperationalSnapshot>;
}

/**
 * Read-only product diagnostics over already-owned WorkerSession and candidate
 * observation sources. This creates no durable provider/Worker truth.
 */
export function createNimoraProductOperationalSource(
  composition: Composition,
  ready: Promise<unknown>,
  now: () => Date = () => new Date(),
): NimoraProductOperationalSource {
  let cachedCandidates: Pick<NimoraProductOperationalSnapshot, "candidateReadState" | "candidateErrors" | "providers"> | undefined;
  let cachedAt = 0;
  const CANDIDATE_CACHE_TTL_MS = 10_000;
  return {
    async read(): Promise<NimoraProductOperationalSnapshot> {
      await ready;
      const readAt = now();
      if (!cachedCandidates || readAt.getTime() - cachedAt >= CANDIDATE_CACHE_TTL_MS) {
        const settled = await Promise.allSettled(
          composition.assignmentCandidateSources.map(source => source.enumerateCandidates()),
        );
        const candidateErrors: string[] = [];
        const providers: NimoraProductProviderObservation[] = [];
        for (const result of settled) {
          if (result.status === "rejected") {
            candidateErrors.push(result.reason instanceof Error ? result.reason.message : String(result.reason));
            continue;
          }
          for (const candidate of result.value) {
            providers.push({
              provider: candidate.provider,
              workerId: candidate.workerId,
              kind: candidate.kind,
              availability: candidate.availability,
              models: [...candidate.models],
              health: candidate.health ? structuredClone(candidate.health) : undefined,
              observedAt: candidate.observedAt,
            });
          }
        }
        providers.sort((a, b) => a.provider.localeCompare(b.provider) || a.workerId.localeCompare(b.workerId) || a.observedAt.localeCompare(b.observedAt));
        cachedCandidates = {
          candidateReadState: candidateErrors.length === 0
            ? "available"
            : providers.length > 0
              ? "partial"
              : "unavailable",
          candidateErrors,
          providers,
        };
        cachedAt = readAt.getTime();
      }
      return {
        generatedAt: readAt.toISOString(),
        candidateReadState: cachedCandidates.candidateReadState,
        candidateErrors: [...cachedCandidates.candidateErrors],
        providers: cachedCandidates.providers.map(provider => ({ ...provider, models: [...provider.models], health: provider.health ? structuredClone(provider.health) : undefined })),
        liveWorkers: composition.owners.workers.listSessions(),
      };
    },
  };
}
