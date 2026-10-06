import { createMissionObservationEvent, observeMissionExchange, observeProjectEvent, observeTaskRuntimeEvent,
  type MissionObservationEvent } from "./mission-observation-event.js";
import { browserWorkerObservationFacts, deriveBrowserWorkerOperationalObservation, type BrowserWorkerObservationInput } from "./browser-worker-observation.js";
import type { ProjectEvent } from "./project-contract.js";
import type { TaskEvent, TaskSnapshot } from "./task-contract.js";
import type { MissionExchange } from "./mission-collaboration-contract.js";

/** Bounded ephemeral diagnostics, never a journal, scheduler or retry owner. */
export class MissionObservationBuffer {
  private readonly rows: MissionObservationEvent[] = [];
  private readonly pendingProjects = new Map<string, ProjectEvent>();
  constructor(private readonly limit = 256) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 2048) throw new Error("Observation limit must be 1..2048.");
  }
  private append(row: MissionObservationEvent): void {
    this.rows.push(structuredClone(row));
    if (this.rows.length > this.limit) this.rows.splice(0, this.rows.length - this.limit);
  }
  recordTask(task: TaskSnapshot, event: TaskEvent): void {
    if (!task.mission) return;
    const scope = { projectId: task.mission.projectId, rootMissionId: task.mission.rootMissionId, missionId: task.taskId };
    const pending = this.pendingProjects.get(scope.projectId);
    if (pending) { this.append(observeProjectEvent(scope, pending)); this.pendingProjects.delete(scope.projectId); }
    this.append(observeTaskRuntimeEvent(scope, event));
  }
  recordProject(event: ProjectEvent, tasks: readonly TaskSnapshot[]): void {
    const roots = tasks.filter(task => task.mission?.projectId === event.projectId
      && task.mission.rootMissionId === task.taskId && !task.mission.parentMissionId && !task.missionFinalization);
    if (!roots.length) {
      if (event.type === "ProjectCreated") {
        this.pendingProjects.set(event.projectId, structuredClone(event));
        if (this.pendingProjects.size > 64) this.pendingProjects.delete(this.pendingProjects.keys().next().value!);
      }
      return;
    }
    for (const root of roots) this.append(observeProjectEvent({ projectId: event.projectId, rootMissionId: root.taskId, missionId: root.taskId }, event));
  }
  recordExchange(exchange: MissionExchange, tasks: readonly TaskSnapshot[]): void {
    const source = tasks.find(task => task.taskId === exchange.sourceMissionId && task.mission?.projectId === exchange.projectId);
    if (source?.mission) this.append(observeMissionExchange(source.mission.rootMissionId, exchange));
  }
  recordBrowser(task: TaskSnapshot, worker: { workerId: string; managedSessionId: string; adapterSessionId: string }, input: BrowserWorkerObservationInput): void {
    if (!task.mission) return;
    const observation = deriveBrowserWorkerOperationalObservation(input);
    this.append(createMissionObservationEvent({ kind: "operational", name: "browser.worker-observed", at: observation.checkedAt,
      scope: { projectId: task.mission.projectId, rootMissionId: task.mission.rootMissionId, missionId: task.taskId },
      source: { owner: "browser-worker-runtime", component: "WorkerHealth" }, worker,
      facts: browserWorkerObservationFacts(observation) }));
  }
  snapshot(): readonly MissionObservationEvent[] { return structuredClone(this.rows); }
}
