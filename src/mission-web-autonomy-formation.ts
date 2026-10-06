/**
 * Web Product autonomous Projects require a durable Cognition owner that
 * survives individual Practice turns. This is an admission guard only; the
 * canonical Formation parser remains the owner of the full schema.
 */
export function assertAutonomousWebFormationOwnership(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("网页版 Cognition 输出必须是对象；没有创建 Project。");
  }
  const row = value as Record<string, unknown>;
  const initialRoot = row.initialRoot;
  if (!initialRoot || typeof initialRoot !== "object" || Array.isArray(initialRoot)
    || (initialRoot as { plane?: unknown }).plane !== "cognition") {
    throw new Error("网页版自主 Project 必须形成 continuing Cognition root；没有创建 Project。");
  }
  if (!Array.isArray(row.requiredCapabilityIds)) {
    throw new Error("网页版 Cognition 缺少 requiredCapabilityIds；没有创建 Project。");
  }
  if (!Array.isArray(row.additionalMissions)) {
    throw new Error("网页版 Cognition 缺少 additionalMissions；没有创建 Project。");
  }
  if (row.requiredCapabilityIds.length > 0
    && !row.additionalMissions.some(mission => mission && typeof mission === "object"
      && !Array.isArray(mission) && (mission as { plane?: unknown }).plane === "practice")) {
    throw new Error("网页版自主 Project 需要真实工具工作时必须规划至少一个 Practice child；没有创建 Project。");
  }
}
