/**
 * Default context budget for newly configured OpenAI-compatible API providers.
 * Aligned with the official DeepSeek capability profile (1M input + 384K output
 * ≈ 1.3M total) so a freshly added API advertises a DeepSeek-class window until
 * the endpoint publishes its own limits through model discovery
 * (context_window / max_output_tokens) or the user overrides them in the
 * provider or per-model configuration. The legacy single-model path keeps its
 * own smaller default in model-provider.ts.
 */
export const DEFAULT_API_CONTEXT_WINDOW = 1_000_000;
export const DEFAULT_API_MAX_OUTPUT_TOKENS = 384_000;

/**
 * Default context window for Codex models. Set to 1M regardless of the actual
 * service-side limit; model discovery payloads and user overrides still win
 * when present.
 */
export const DEFAULT_CODEX_CONTEXT_WINDOW = 1_000_000;
