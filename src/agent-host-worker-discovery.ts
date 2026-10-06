/** Read-only projection of the platform AHP root. No session, transcript,
 * credential, dispatch or permission state crosses this discovery hook. */
export function agentHostWorkerDiscovery(value: unknown): { state: "connected" | "offline" | "starting"; providers: { id: string; label: string; models: string[] }[]; missionToolPolicy: false } {
  if (value instanceof Error) return { state: "offline", providers: [], missionToolPolicy: false };
  if (!value || typeof value !== "object" || !Array.isArray((value as { agents?: unknown }).agents)) return { state: "starting", providers: [], missionToolPolicy: false };
  const providers = ((value as { agents: unknown[] }).agents).slice(0, 16).flatMap(raw => {
    if (!raw || typeof raw !== "object") return [];
    const agent = raw as { provider?: unknown; displayName?: unknown; models?: unknown };
    if (typeof agent.provider !== "string" || !agent.provider.trim() || agent.provider.length > 120 || !Array.isArray(agent.models)) return [];
    const models = agent.models.slice(0, 256).flatMap(raw => {
      const id = raw && typeof raw === "object" ? (raw as { id?: unknown }).id : undefined;
      return typeof id === "string" && id.trim() && id.length <= 240 ? [id] : [];
    });
    return [{ id: agent.provider, label: typeof agent.displayName === "string" ? agent.displayName.slice(0, 240) : agent.provider, models }];
  });
  // Ordinary AHP tool ready/result events remain observations. The scoped
  // client-tool bridge advertises its separate execution contract explicitly.
  return { state: "connected", providers, missionToolPolicy: false };
}
