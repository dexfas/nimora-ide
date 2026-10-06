import type { TaskSnapshot } from "./task-contract.js";

/** Historical roots stay in TaskRuntime. Only canonical finalization determines
 * whether a root is active; UI status and creation order confer no authority. */
export function requireActiveProjectRoot(tasks: readonly TaskSnapshot[], projectId: string): TaskSnapshot {
  const roots = tasks.filter(task => task.mission?.projectId === projectId
    && task.mission.rootMissionId === task.taskId && !task.mission.parentMissionId
    && !task.missionFinalization);
  if (roots.length !== 1 || roots[0].mission?.plane !== "cognition") {
    throw new Error("需要唯一、活动的 Cognition root；历史 root 不参与本轮选择。");
  }
  return roots[0];
}
