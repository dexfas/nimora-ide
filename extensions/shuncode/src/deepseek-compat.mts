export const DEEPSEEK_CONTEXT_WINDOW_TOKENS = 1_000_000;
export const DEEPSEEK_MAX_OUTPUT_TOKENS = 384_000;
export const DEEPSEEK_REASONING_EFFORTS = ["low", "high", "max"] as const;
export const DEEPSEEK_DEFAULT_REASONING_EFFORT = "max" as const;

export function resolveDeepSeekThinkingEffort(value: unknown) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "disabled") return { thinking: "disabled" as const };
  const reasoningEffort = DEEPSEEK_REASONING_EFFORTS.find((effort) => effort === normalized);
  return reasoningEffort ? { thinking: "enabled" as const, reasoningEffort } : undefined;
}

export function isOfficialDeepSeekApiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase() === "api.deepseek.com"
      && !/^\/anthropic(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function normalizeOfficialDeepSeekApiBaseUrl(value: string): string {
  if (!isOfficialDeepSeekApiBaseUrl(value)) return value;
  const url = new URL(value);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (pathname === "/v1") url.pathname = "";
  else if (pathname === "/v1/chat/completions") url.pathname = "/chat/completions";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}
