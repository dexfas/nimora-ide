export const REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export const THINKING_MODES = ["enabled", "disabled"] as const;

export type ReasoningEffort = typeof REASONING_EFFORTS[number];
export type ThinkingMode = typeof THINKING_MODES[number];
export type GenericReasoningSelection = "inherit" | "enabled" | "disabled" | ReasoningEffort;

export interface GenericReasoningOverride {
  thinking: ThinkingMode;
  reasoningEffort?: ReasoningEffort;
}

export function genericReasoningPickerValues(reasoningEfforts: readonly ReasoningEffort[]): GenericReasoningSelection[] {
  return ["inherit", "enabled", "disabled", ...new Set(reasoningEfforts)];
}

export function resolveGenericReasoningOverride(
  value: unknown,
  allowedReasoningEfforts: readonly ReasoningEffort[],
  fallbackEffort: ReasoningEffort | undefined,
): GenericReasoningOverride | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "enabled") {
    return { thinking: "enabled", reasoningEffort: fallbackEffort ?? "medium" };
  }
  if (normalized === "disabled") {
    return { thinking: "disabled" };
  }
  if ((allowedReasoningEfforts as readonly string[]).includes(normalized)) {
    return { thinking: "enabled", reasoningEffort: normalized as ReasoningEffort };
  }
  return undefined;
}

export type MergeReasoningEffort = "disabled" | ReasoningEffort;

export interface MergeReasoningModelProfile {
  deepSeek: boolean;
  codex: boolean;
  reasoningEfforts: readonly ReasoningEffort[];
}

export interface MergeReasoningOverride {
  thinking?: ThinkingMode;
  reasoningEffort?: ReasoningEffort;
}

/**
 * Resolve a multi-model merge thinking effort selection against the actual
 * merge model capabilities. Returns undefined when the selection is not
 * supported (unknown value, effort outside the model's effort set, or disabled
 * thinking on a Codex model), so callers can fall back to the model default
 * instead of silently sending an invalid effort.
 */
export function resolveMergeReasoningOverride(
  value: unknown,
  profile: MergeReasoningModelProfile,
): MergeReasoningOverride | undefined {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "disabled") {
    if (profile.codex) return undefined;
    return { thinking: "disabled" };
  }
  if ((profile.reasoningEfforts as readonly string[]).includes(normalized)) {
    return profile.codex
      ? { reasoningEffort: normalized as ReasoningEffort }
      : { thinking: "enabled", reasoningEffort: normalized as ReasoningEffort };
  }
  return undefined;
}
