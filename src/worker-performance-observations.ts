import type { WorkerAssignmentCandidate } from "./worker-assignment.js";
/** Non-owning, bounded observations. Unknown price/quality/quota stay unknown;
 * no observation can authorize resources, a retry or a tool. */
export interface WorkerTurnObservation {
  workerId: string;
  model?: string;
  durationMs: number;
  status: "completed" | "interrupted" | "cancelled" | "error";
  observedAt: string;
  basis: "managed-provider-turn";
}
export class WorkerPerformanceObservations {
  private readonly rows: WorkerTurnObservation[] = [];
  record(value: WorkerTurnObservation): void {
    if (!Number.isFinite(value.durationMs) || value.durationMs < 0 || value.durationMs > 86_400_000
      || !Number.isFinite(Date.parse(value.observedAt)) || value.basis !== "managed-provider-turn"
      || !["completed", "interrupted", "cancelled", "error"].includes(value.status)) return;
    this.rows.push({ workerId: value.workerId, ...(value.model ? { model: value.model } : {}), durationMs: value.durationMs,
      status: value.status, observedAt: value.observedAt, basis: "managed-provider-turn" });
    if (this.rows.length > 256) this.rows.splice(0, this.rows.length - 256);
  }
  snapshot(): { turns: WorkerTurnObservation[]; cost: "unknown"; quality: "unknown"; quota: "unknown" } {
    return { turns: structuredClone(this.rows), cost: "unknown", quality: "unknown", quota: "unknown" };
  }
  latency(candidate: WorkerAssignmentCandidate, now = Date.now()): number | undefined {
    const samples = this.rows.filter(row => row.workerId === candidate.workerId && row.status === "completed"
      && (!row.model || candidate.models.includes(row.model)) && now - Date.parse(row.observedAt) >= 0 && now - Date.parse(row.observedAt) <= 86_400_000).slice(-8);
    if (samples.length < 2) return undefined;
    const sorted = samples.map(row => row.durationMs).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
}
