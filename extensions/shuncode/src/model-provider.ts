import { createHmac, randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { getShunCodeModelConfig } from "./config.js";
import {
  CODEX_API_BASE_URL,
  CODEX_BETA_HEADER,
  CODEX_CLIENT_VERSION,
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
  codexAuthManager,
  type CodexRequestContext,
} from "./codex-auth.js";
import {
  DEEPSEEK_CONTEXT_WINDOW_TOKENS,
  DEEPSEEK_DEFAULT_REASONING_EFFORT,
  DEEPSEEK_MAX_OUTPUT_TOKENS,
  DEEPSEEK_REASONING_EFFORTS,
  isOfficialDeepSeekApiBaseUrl,
  normalizeOfficialDeepSeekApiBaseUrl,
  resolveDeepSeekThinkingEffort,
} from "./deepseek-compat.mjs";
import {
  DEFAULT_API_CONTEXT_WINDOW,
  DEFAULT_API_MAX_OUTPUT_TOKENS,
  DEFAULT_CODEX_CONTEXT_WINDOW,
} from "./model-defaults.mjs";
import {
  deleteRuntimeModelsForNamespace,
  encodedModelId,
  MODEL_ID_SEPARATOR,
  normalizeProviderModelId,
} from "./model-provider-identifiers.mjs";
import {
  genericReasoningPickerValues,
  REASONING_EFFORTS,
  resolveGenericReasoningOverride,
  THINKING_MODES,
  type ReasoningEffort,
  type ThinkingMode,
} from "./model-reasoning.mjs";

function normalizeChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("ShunCode model Base URL is empty.");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function normalizeResponsesUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("ShunCode model Base URL is empty.");
  return trimmed.endsWith("/responses") ? trimmed : `${trimmed}/responses`;
}

function normalizeAnthropicMessagesUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("ShunCode provider Base URL is empty.");
  if (trimmed.endsWith("/messages")) return trimmed;
  if (trimmed.endsWith("/v1")) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

function normalizeAnthropicModelsUrl(baseUrl: string): string {
  let normalized = baseUrl.trim().replace(/\/+$/, "");
  if (normalized.endsWith("/v1/messages")) {
    normalized = normalized.slice(0, -"/v1/messages".length).replace(/\/+$/, "");
  } else if (normalized.endsWith("/messages")) {
    normalized = normalized.slice(0, -"/messages".length).replace(/\/+$/, "");
  }
  return normalized.endsWith("/v1") ? `${normalized}/models` : `${normalized}/v1/models`;
}

type ShunCodeProtocol = "openai-chat-completions" | "openai-responses" | "anthropic-messages";

const ANTHROPIC_API_VERSION = "2023-06-01";
const ANTHROPIC_EFFORT_THINKING_BUDGETS: Record<string, number> = {
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 24_576,
  max: 32_768,
  ultra: 32_768,
};
type ReasoningSummary = "auto" | "concise" | "detailed";
type ReasoningContext = "auto" | "current_turn" | "all_turns";
type ReasoningMode = "standard" | "pro";
type Verbosity = "low" | "medium" | "high";
type ServiceTier = "auto" | "default" | "flex" | "scale" | "priority" | "fast";
type TruncationMode = "auto" | "disabled";
type PromptCacheMode = "implicit" | "explicit";
type PromptCacheTtl = "30m";
type PromptCacheRetention = "in_memory" | "24h";
export type ShunCodeProviderMode = "api" | "codex";

interface ShunCodeProviderConfiguration {
  protocol?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  modelIds?: unknown;
  thinking?: unknown;
  description?: unknown;
  timeoutMs?: unknown;
  firstTokenTimeoutMs?: unknown;
  idleTimeoutMs?: unknown;
  totalTimeoutMs?: unknown;
  retries?: unknown;
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
  reasoningEffort?: unknown;
  reasoningEfforts?: unknown;
  reasoningSummary?: unknown;
  reasoningContext?: unknown;
  reasoningMode?: unknown;
  verbosity?: unknown;
  temperature?: unknown;
  topP?: unknown;
  parallelToolCalls?: unknown;
  maxToolCalls?: unknown;
  serviceTier?: unknown;
  store?: unknown;
  truncation?: unknown;
  promptCacheKey?: unknown;
  promptCacheMode?: unknown;
  promptCacheTtl?: unknown;
  promptCacheRetention?: unknown;
  safetyIdentifier?: unknown;
  seed?: unknown;
  presencePenalty?: unknown;
  frequencyPenalty?: unknown;
  stop?: unknown;
  responseFormat?: unknown;
  requestMetadata?: unknown;
  extraBody?: unknown;
  modelSettings?: unknown;
}

export interface ShunCodeRuntimeModelConfig {
  protocol: ShunCodeProtocol;
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  firstTokenTimeoutMs: number;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  retries: number;
  contextWindow: number;
  maxOutputTokens?: number;
  description?: string;
  thinking?: ThinkingMode;
  reasoningEffort?: ReasoningEffort;
  reasoningEfforts: ReasoningEffort[];
  reasoningSummary?: ReasoningSummary;
  reasoningContext?: ReasoningContext;
  reasoningMode?: ReasoningMode;
  verbosity?: Verbosity;
  temperature?: number;
  topP?: number;
  parallelToolCalls?: boolean;
  maxToolCalls?: number;
  serviceTier?: ServiceTier;
  serviceTiers?: ModelServiceTier[];
  store?: boolean;
  truncation?: TruncationMode;
  promptCacheKey?: string;
  promptCacheMode?: PromptCacheMode;
  promptCacheTtl?: PromptCacheTtl;
  promptCacheRetention?: PromptCacheRetention;
  safetyIdentifier?: string;
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  stop?: string[];
  responseFormat?: Record<string, unknown>;
  requestMetadata?: Record<string, string>;
  extraBody?: Record<string, unknown>;
  deepSeek: boolean;
  codex: boolean;
  imageInput: boolean;
  providerKey: string;
  legacy?: boolean;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 90_000;
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 600_000;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 30_000;
const PROVIDER_FINGERPRINT_SALT_SECRET = "shuncode.providerFingerprintSalt";

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integerValue(value: unknown, fallback: number, min: number, max: number): number {
  return Number.isInteger(value) ? Math.max(min, Math.min(max, Number(value))) : fallback;
}

function optionalInteger(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isInteger(numeric) && numeric >= min && numeric <= max ? numeric : undefined;
}

function optionalNumber(value: unknown, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric >= min && numeric <= max ? numeric : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const normalized = stringValue(value);
  return (allowed as readonly string[]).includes(normalized) ? normalized as T : undefined;
}

function reasoningEffortValues(value: unknown, fallback: readonly ReasoningEffort[] = REASONING_EFFORTS): ReasoningEffort[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\n,;]+/)
      : [];
  const normalized = [...new Set(values
    .map(item => typeof item === "string" ? item.trim() : "")
    .filter((item): item is ReasoningEffort => (REASONING_EFFORTS as readonly string[]).includes(item)))];
  return normalized.length ? normalized : [...fallback];
}

function reasoningEffortOptions(value: unknown, defaultEffort: ReasoningEffort | undefined, fallback: readonly ReasoningEffort[] = REASONING_EFFORTS): ReasoningEffort[] {
  const options = reasoningEffortValues(value, fallback);
  if (defaultEffort && !options.includes(defaultEffort)) {
    options.push(defaultEffort);
  }
  return options;
}

function reasoningEffortLabel(value: ReasoningEffort): string {
  switch (value) {
    case "none": return "None";
    case "minimal": return "Minimal";
    case "low": return "Low";
    case "medium": return "Medium";
    case "high": return "High";
    case "xhigh": return "Extra High";
    case "max": return "Max";
    case "ultra": return "Ultra";
  }
}

function reasoningEffortDescription(value: ReasoningEffort): string {
  switch (value) {
    case "none": return "No reasoning where supported.";
    case "minimal": return "Minimal reasoning for compatible models.";
    case "low": return "Low reasoning effort for faster responses.";
    case "medium": return "Balanced reasoning effort.";
    case "high": return "High reasoning effort.";
    case "xhigh": return "Extra-high reasoning effort.";
    case "max": return "Maximum reasoning effort for models that support it.";
    case "ultra": return "Maximum reasoning with automatic task delegation where supported.";
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : undefined;
}

function stringRecordValue(value: unknown): Record<string, string> | undefined {
  const record = objectValue(value);
  if (!record) return undefined;
  const entries = Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function stringArrayValue(value: unknown, maxItems: number): string[] | undefined {
  if (typeof value === "string") return value.trim() ? [value.trim()] : undefined;
  if (!Array.isArray(value)) return undefined;
  const values = value.map(item => typeof item === "string" ? item.trim() : "").filter(Boolean).slice(0, maxItems);
  return values.length ? values : undefined;
}

function normalizeApiBaseUrl(baseUrl: string): string {
  let normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("ShunCode provider Base URL is empty.");
  if (normalized.endsWith("/chat/completions")) {
    normalized = normalized.slice(0, -"/chat/completions".length).replace(/\/+$/, "");
  } else if (normalized.endsWith("/responses")) {
    normalized = normalized.slice(0, -"/responses".length).replace(/\/+$/, "");
  } else if (normalized.endsWith("/v1/messages")) {
    normalized = normalized.slice(0, -"/v1/messages".length).replace(/\/+$/, "");
  } else if (normalized.endsWith("/messages")) {
    normalized = normalized.slice(0, -"/messages".length).replace(/\/+$/, "");
  }
  return normalizeOfficialDeepSeekApiBaseUrl(normalized);
}

function normalizeModelsUrl(baseUrl: string, clientVersion?: string): string {
  const url = new URL(`${normalizeApiBaseUrl(baseUrl)}/models`);
  if (clientVersion) url.searchParams.set("client_version", clientVersion);
  return url.toString();
}

function parseManualModelIds(value: unknown): string[] {
  const text = stringValue(value);
  if (!text) return [];
  return [...new Set(text.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean))];
}

function providerFingerprint(config: Omit<ShunCodeRuntimeModelConfig, "model" | "providerKey">, salt: string): string {
  return createHmac("sha256", salt)
    .update(JSON.stringify([
      config.protocol,
      normalizeApiBaseUrl(config.baseUrl),
      config.apiKey ?? "",
    ]))
    .digest("hex")
    .slice(0, 16);
}

interface DiscoveredModel {
  id: string;
  name: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  imageInput?: boolean;
  reasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
  serviceTiers?: ModelServiceTier[];
  defaultServiceTier?: ServiceTier;
}

interface ModelServiceTier {
  id: ServiceTier;
  name: string;
  description?: string;
}

function parseDiscoveredModelIds(payload: any): string[] {
  return parseDiscoveredModels(payload).map(model => model.id);
}

function parseDiscoveredModels(payload: any, codex = false): DiscoveredModel[] {
  const source = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload?.results)
          ? payload.results
          : [];
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const item of source as any[]) {
    if (typeof item === "string") {
      const id = item.trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        models.push({ id, name: id });
      }
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (codex && item.supported_in_api === false) continue;
    if (codex && typeof item.visibility === "string" && item.visibility !== "list") continue;
    if (codex && Array.isArray(item.output_modalities) && !item.output_modalities.includes("text")) continue;
    const id = stringValue(item.slug) || stringValue(item.id) || stringValue(item.name) || stringValue(item.model);
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const supportedReasoning = Array.isArray(item.supported_reasoning_levels)
      ? [...new Set<ReasoningEffort>(item.supported_reasoning_levels
          .map((level: unknown) => typeof level === "string"
            ? level
            : level && typeof level === "object"
              ? stringValue((level as Record<string, unknown>).effort)
              : "")
          .filter((level: string): level is ReasoningEffort => (REASONING_EFFORTS as readonly string[]).includes(level)))]
      : [];
    const defaultReasoningEffort = enumValue(item.default_reasoning_level, REASONING_EFFORTS);
    if (defaultReasoningEffort && !supportedReasoning.includes(defaultReasoningEffort)) supportedReasoning.push(defaultReasoningEffort);
    const inputModalities = Array.isArray(item.input_modalities)
      ? item.input_modalities.map((modality: unknown) => stringValue(modality).toLowerCase()).filter(Boolean)
      : undefined;
    const serviceTiers: ModelServiceTier[] = [];
    let serviceTierMetadataPresent = false;
    if (codex && Array.isArray(item.service_tiers)) {
      serviceTierMetadataPresent = true;
      for (const tier of item.service_tiers) {
        if (!tier || typeof tier !== "object") continue;
        const id = enumValue((tier as Record<string, unknown>).id, ["priority", "fast"] as const);
        const name = stringValue((tier as Record<string, unknown>).name);
        if (!id || (name && name.toLowerCase() !== "fast")) continue;
        serviceTiers.push({
          id,
          name: name || "Fast",
          description: stringValue((tier as Record<string, unknown>).description) || undefined,
        });
      }
    }
    if (codex && Array.isArray(item.additional_speed_tiers)) {
      serviceTierMetadataPresent = true;
      if (serviceTiers.length === 0 && item.additional_speed_tiers.some((tier: unknown) => {
        const value = typeof tier === "string"
          ? tier
          : tier && typeof tier === "object"
            ? (tier as Record<string, unknown>).id ?? (tier as Record<string, unknown>).name
            : undefined;
        return stringValue(value).toLowerCase() === "fast";
      })) {
        serviceTiers.push({ id: "priority", name: "Fast", description: "Faster responses with increased usage." });
      }
    }
    const defaultServiceTier = serviceTiers.length
      ? enumValue(item.default_service_tier, ["default", ...serviceTiers.map(tier => tier.id)] as ServiceTier[]) ?? "default"
      : undefined;
    models.push({
      id,
      name: stringValue(item.display_name) || id,
      description: stringValue(item.description) || undefined,
      contextWindow: optionalInteger(item.context_window ?? item.max_context_window, 1_024, 10_000_000),
      maxOutputTokens: optionalInteger(item.max_output_tokens, 1, 1_000_000),
      imageInput: inputModalities ? inputModalities.includes("image") : undefined,
      reasoningEfforts: supportedReasoning.length ? supportedReasoning : undefined,
      defaultReasoningEffort,
      serviceTiers: serviceTierMetadataPresent ? serviceTiers : undefined,
      defaultServiceTier,
    });
  }
  return models;
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function delayForRetry(attempt: number, token: vscode.CancellationToken): Promise<void> {
  if (token.isCancellationRequested) throw new vscode.CancellationError();
  await new Promise<void>((resolve) => setTimeout(resolve, Math.min(2_000, 250 * 2 ** attempt)));
  if (token.isCancellationRequested) throw new vscode.CancellationError();
}

async function fetchJsonWithRetries(
  url: string,
  init: RequestInit,
  token: vscode.CancellationToken,
  timeoutMs: number,
  retries: number,
  label: string,
): Promise<any> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const raw = await response.text();
      let payload: any;
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        throw new Error(`${label} returned non-JSON (${response.status}): ${raw.slice(0, 1000)}`);
      }
      if (!response.ok) {
        const message = payload?.error?.message ?? payload?.message ?? `${label} failed with HTTP ${response.status}`;
        const error = new Error(String(message));
        if (attempt < retries && isTransientStatus(response.status)) {
          lastError = error;
        } else {
          throw error;
        }
      } else {
        return payload;
      }
    } catch (error) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      lastError = error;
      if (attempt >= retries) throw error;
    } finally {
      clearTimeout(timeout);
      cancellation.dispose();
    }
    await delayForRetry(attempt, token);
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed.`);
}

async function fetchStreamWithRetries(
  url: string,
  init: RequestInit,
  token: vscode.CancellationToken,
  timeoutMs: number,
  retries: number,
  label: string,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const controller = new AbortController();
    const cancellation = token.onCancellationRequested(() => controller.abort());
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok) return response;

      const raw = await response.text();
      let payload: any;
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        payload = undefined;
      }
      const message = payload?.error?.message ?? payload?.message ?? `${label} failed with HTTP ${response.status}`;
      const error = Object.assign(new Error(String(message)), { status: response.status });
      if (!isTransientStatus(response.status) || attempt >= retries) throw error;
      lastError = error;
    } catch (error) {
      if (token.isCancellationRequested) throw new vscode.CancellationError();
      const status = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status?: unknown }).status)
        : undefined;
      if (status !== undefined && Number.isFinite(status) && !isTransientStatus(status)) throw error;
      lastError = error;
      if (attempt >= retries) throw error;
    } finally {
      clearTimeout(timeout);
      cancellation.dispose();
    }
    await delayForRetry(attempt, token);
  }
  throw lastError instanceof Error ? lastError : new Error(`${label} failed.`);
}

function emitChatCompletionMessage(message: any, progress: vscode.Progress<any>): void {
  if (!message) return;
  const reasoningText = typeof message.reasoning_content === "string"
    ? message.reasoning_content
    : typeof message.reasoning === "string"
      ? message.reasoning
      : undefined;
  if (reasoningText) progress.report(new vscode.LanguageModelThinkingPart(reasoningText));
  if (typeof message.content === "string" && message.content) {
    progress.report(new vscode.LanguageModelTextPart(message.content));
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    const name = call?.function?.name;
    if (!name) continue;
    let input: object = {};
    try {
      input = JSON.parse(call?.function?.arguments ?? "{}");
    } catch {
      input = {};
    }
    progress.report(new vscode.LanguageModelToolCallPart(call.id ?? `tool-${Date.now()}`, name, input));
  }
}

async function emitChatCompletionStream(
  response: Response,
  progress: vscode.Progress<any>,
  token: vscode.CancellationToken,
): Promise<void> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    const raw = await response.text();
    let payload: any;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(`Chat Completions endpoint returned non-JSON: ${raw.slice(0, 1000)}`);
    }
    if (payload?.error) throw new Error(String(payload.error?.message ?? payload.error));
    emitChatCompletionMessage(payload?.choices?.[0]?.message, progress);
    return;
  }

  if (!response.body) throw new Error("Chat Completions endpoint returned an empty stream.");
  const reader = response.body.getReader();
  const cancellation = token.onCancellationRequested(() => { void reader.cancel(); });
  const decoder = new TextDecoder();
  let buffer = "";
  const toolCalls = new Map<number, { id?: string; name?: string; arguments: string }>();

  const processEvent = (event: string): boolean => {
    const data = event
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) return false;
    if (data === "[DONE]") return true;

    let payload: any;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error(`Chat Completions stream returned invalid JSON: ${data.slice(0, 1000)}`);
    }
    if (payload?.error) throw new Error(String(payload.error?.message ?? payload.error));

    for (const choice of Array.isArray(payload?.choices) ? payload.choices : []) {
      const delta = choice?.delta ?? choice?.message;
      if (!delta) continue;
      const reasoningText = typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : undefined;
      if (reasoningText) progress.report(new vscode.LanguageModelThinkingPart(reasoningText));
      if (typeof delta.content === "string" && delta.content) {
        progress.report(new vscode.LanguageModelTextPart(delta.content));
      }
      for (const [fallbackIndex, call] of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).entries()) {
        const index = Number.isInteger(call?.index) ? call.index : fallbackIndex;
        const current = toolCalls.get(index) ?? { arguments: "" };
        if (typeof call?.id === "string" && call.id) current.id = call.id;
        if (typeof call?.function?.name === "string" && call.function.name) current.name = call.function.name;
        if (typeof call?.function?.arguments === "string") current.arguments += call.function.arguments;
        toolCalls.set(index, current);
      }
    }
    return false;
  };

  try {
    let done = false;
    while (!done) {
      if (token.isCancellationRequested) {
        await reader.cancel();
        throw new vscode.CancellationError();
      }
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) {
        if (processEvent(event)) {
          done = true;
          break;
        }
      }
    }
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    buffer += decoder.decode();
    if (buffer.trim()) processEvent(buffer);
  } finally {
    cancellation.dispose();
    reader.releaseLock();
  }

  for (const [index, call] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    if (!call.name) continue;
    let input: object = {};
    try {
      input = JSON.parse(call.arguments || "{}");
    } catch {
      input = {};
    }
    progress.report(new vscode.LanguageModelToolCallPart(call.id ?? `tool-${Date.now()}-${index}`, call.name, input));
  }
}

function textFromPart(part: any): string | undefined {
  if (!part) return undefined;
  if (typeof part === "string") return part;
  if (typeof part.value === "string") return part.value;
  if (part.value && typeof part.value.value === "string") return part.value.value;
  return undefined;
}

function thinkingTextFromPart(part: any): string | undefined {
  if (!(part instanceof vscode.LanguageModelThinkingPart)) return undefined;
  if (typeof part.value === "string") return part.value;
  return Array.isArray(part.value) ? part.value.filter((value: unknown): value is string => typeof value === "string").join("") : undefined;
}

function estimatedTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  let estimate = 0;
  for (const character of text) estimate += (character.codePointAt(0) ?? 0) <= 0x7f ? 0.25 : 1;
  return Math.max(1, Math.ceil(estimate));
}

function imageFromPart(part: any): { type: "image_url"; image_url: { url: string } } | undefined {
  if (!part || typeof part.mimeType !== "string" || !part.mimeType.startsWith("image/") || !part.data) return undefined;
  const bytes = part.data instanceof Uint8Array ? part.data : new Uint8Array(part.data);
  if (bytes.byteLength === 0) return undefined;
  return {
    type: "image_url",
    image_url: { url: `data:${part.mimeType};base64,${Buffer.from(bytes).toString("base64")}` },
  };
}

function responsesImageFromPart(part: any): { type: "input_image"; image_url: string } | undefined {
  const image = imageFromPart(part);
  return image ? { type: "input_image", image_url: image.image_url.url } : undefined;
}

function toOpenAIMessages(
  messages: readonly any[],
  options: { preserveReasoningContent: boolean },
): any[] {
  const result: any[] = [];
  for (const message of messages) {
    const isAssistant = message.role === vscode.LanguageModelChatMessageRole.Assistant;
    const texts: string[] = [];
    const userContent: any[] = [];
    const toolCalls: any[] = [];
    const toolResults: any[] = [];
    const reasoningTexts: string[] = [];
    for (const part of message.content ?? []) {
      if (part instanceof vscode.LanguageModelToolCallPart || (part && typeof part.callId === "string" && typeof part.name === "string" && part.input !== undefined)) {
        toolCalls.push({
          id: part.callId,
          type: "function",
          function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
        });
        continue;
      }
      if (part instanceof vscode.LanguageModelToolResultPart || (part && typeof part.callId === "string" && Array.isArray(part.content))) {
        const content = (part.content ?? []).map((value: any) => textFromPart(value) ?? JSON.stringify(value)).join("\n");
        toolResults.push({ role: "tool", tool_call_id: part.callId, content });
        continue;
      }
      const thinkingText = thinkingTextFromPart(part);
      if (thinkingText !== undefined && isAssistant) {
        if (options.preserveReasoningContent) reasoningTexts.push(thinkingText);
        else if (thinkingText) texts.push(thinkingText);
        continue;
      }
      const image = imageFromPart(part);
      if (image) {
        userContent.push(image);
        continue;
      }
      const text = textFromPart(part);
      if (text) {
        texts.push(text);
        userContent.push({ type: "text", text });
      }
    }

    if (isAssistant) {
      result.push({
        role: "assistant",
        content: texts.join("\n") || (options.preserveReasoningContent && toolCalls.length ? "" : null),
        ...(options.preserveReasoningContent && (reasoningTexts.length || toolCalls.length) ? { reasoning_content: reasoningTexts.join("") } : {}),
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      if (userContent.length) {
        const hasImage = userContent.some((part) => part.type === "image_url");
        result.push({ role: "user", content: hasImage ? userContent : texts.join("\n") });
      }
      result.push(...toolResults);
    }
  }
  return result;
}

function anthropicSourceFromImageUrl(url: string): Record<string, unknown> | undefined {
  const trimmed = url.trim();
  const dataUrl = /^data:([^;,]+);base64,(.*)$/s.exec(trimmed);
  if (dataUrl) return { type: "base64", media_type: dataUrl[1], data: dataUrl[2] };
  if (/^https?:\/\//i.test(trimmed)) return { type: "url", url: trimmed };
  return undefined;
}

/**
 * Converts VS Code language-model chat messages into the Anthropic Messages
 * shape. Tool results for one assistant turn are merged into a single user
 * message, matching the Anthropic roles-must-alternate contract.
 */
function toAnthropicChatMessages(messages: readonly any[]): { messages: { role: string; content: unknown[] }[] } {
  const output: { role: string; content: unknown[] }[] = [];

  const pushUserBlocks = (blocks: unknown[]): void => {
    if (!blocks.length) return;
    const previous = output[output.length - 1];
    if (previous && previous.role === "user") {
      previous.content = [...previous.content, ...blocks];
      return;
    }
    output.push({ role: "user", content: blocks });
  };

  for (const message of messages) {
    const isAssistant = message.role === vscode.LanguageModelChatMessageRole.Assistant;
    const blocks: any[] = [];
    const toolResults: any[] = [];
    for (const part of message.content ?? []) {
      if (part instanceof vscode.LanguageModelToolCallPart || (part && typeof part.callId === "string" && typeof part.name === "string" && part.input !== undefined)) {
        blocks.push({ type: "tool_use", id: part.callId, name: part.name, input: part.input ?? {} });
        continue;
      }
      if (part instanceof vscode.LanguageModelToolResultPart || (part && typeof part.callId === "string" && Array.isArray(part.content))) {
        const content = (part.content ?? []).map((value: any) => textFromPart(value) ?? JSON.stringify(value)).join("\n");
        toolResults.push({ type: "tool_result", tool_use_id: part.callId, content });
        continue;
      }
      const image = imageFromPart(part);
      if (image) {
        const source = anthropicSourceFromImageUrl(image.image_url?.url ?? "");
        if (source) blocks.push({ type: "image", source });
        continue;
      }
      const text = textFromPart(part);
      if (text) blocks.push({ type: "text", text });
    }
    if (isAssistant) {
      if (blocks.length) output.push({ role: "assistant", content: blocks });
      continue;
    }
    if (toolResults.length) {
      pushUserBlocks(toolResults);
      pushUserBlocks(blocks);
      continue;
    }
    pushUserBlocks(blocks);
  }
  return { messages: output };
}

function toResponsesInput(messages: readonly any[]): any[] {
  const result: any[] = [];
  for (const message of messages) {
    const isAssistant = message.role === vscode.LanguageModelChatMessageRole.Assistant;
    const content: any[] = [];
    const toolCalls: any[] = [];
    const toolResults: any[] = [];
    for (const part of message.content ?? []) {
      if (part instanceof vscode.LanguageModelToolCallPart || (part && typeof part.callId === "string" && typeof part.name === "string" && part.input !== undefined)) {
        toolCalls.push({
          type: "function_call",
          call_id: part.callId,
          name: part.name,
          arguments: JSON.stringify(part.input ?? {}),
        });
        continue;
      }
      if (part instanceof vscode.LanguageModelToolResultPart || (part && typeof part.callId === "string" && Array.isArray(part.content))) {
        const output = (part.content ?? []).map((value: any) => textFromPart(value) ?? JSON.stringify(value)).join("\n");
        toolResults.push({ type: "function_call_output", call_id: part.callId, output });
        continue;
      }
      const image = responsesImageFromPart(part);
      if (image) {
        if (!isAssistant) content.push(image);
        continue;
      }
      const text = textFromPart(part);
      if (text) content.push({ type: isAssistant ? "output_text" : "input_text", text });
    }

    if (content.length) {
      result.push({ role: isAssistant ? "assistant" : "user", content });
    }
    result.push(...toolCalls, ...toolResults);
  }
  return result;
}

function toCodexResponsesInput(messages: readonly any[]): any[] {
  return toResponsesInput(messages).map((message: any) => {
    if (message.type === "function_call" || message.type === "function_call_output") return message;
    const content = typeof message.content === "string"
      ? [{ type: message.role === "assistant" ? "output_text" : "input_text", text: message.content }]
      : Array.isArray(message.content)
        ? message.content
        : [];
    return { type: "message", role: message.role, content };
  });
}

function codexReasoningEffort(effort: ReasoningEffort | undefined): string | undefined {
  if (!effort || effort === "none") return undefined;
  return effort;
}

function extractResponsesOutputText(response: any): string {
  const texts: string[] = [];
  for (const item of Array.isArray(response?.output) ? response.output : []) {
    if (item?.type !== "message") continue;
    for (const content of Array.isArray(item.content) ? item.content : []) {
      if (content?.type === "output_text" && typeof content.text === "string") texts.push(content.text);
      if (content?.type === "refusal" && typeof content.refusal === "string") texts.push(content.refusal);
    }
  }
  return texts.join("");
}

async function emitResponsesStream(
  response: Response,
  progress: vscode.Progress<any>,
  token: vscode.CancellationToken,
): Promise<void> {
  if (!response.body) throw new Error("Codex Responses endpoint returned an empty stream.");
  const reader = response.body.getReader();
  const cancellation = token.onCancellationRequested(() => { void reader.cancel(); });
  const decoder = new TextDecoder();
  let buffer = "";
  let emittedText = false;
  const callArguments = new Map<string, { name?: string; callId?: string; arguments: string }>();
  const emittedCalls = new Set<string>();

  const emitCall = (key: string): void => {
    const call = callArguments.get(key);
    if (!call || !call.name || emittedCalls.has(key)) return;
    emittedCalls.add(key);
    let input: object = {};
    try {
      input = JSON.parse(call.arguments || "{}");
    } catch {
      input = {};
    }
    progress.report(new vscode.LanguageModelToolCallPart(call.callId ?? key, call.name, input));
  };

  const handleEvent = (payload: any): void => {
    const type = typeof payload?.type === "string" ? payload.type : "";
    switch (type) {
      case "response.output_text.delta": {
        if (typeof payload.delta === "string" && payload.delta) {
          emittedText = true;
          progress.report(new vscode.LanguageModelTextPart(payload.delta));
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        if (typeof payload.delta === "string" && payload.delta) {
          progress.report(new vscode.LanguageModelThinkingPart(payload.delta));
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const key = typeof payload.item_id === "string" ? payload.item_id : `fc-${payload.output_index ?? 0}`;
        const current = callArguments.get(key) ?? { arguments: "" };
        if (typeof payload.delta === "string") current.arguments += payload.delta;
        callArguments.set(key, current);
        break;
      }
      case "response.output_item.done": {
        const item = payload?.item;
        if (item?.type === "function_call" && typeof item.name === "string") {
          const key = typeof item.id === "string" ? item.id
            : typeof item.call_id === "string" ? item.call_id
              : `fc-${callArguments.size}`;
          const current = callArguments.get(key) ?? { arguments: "" };
          current.name = item.name;
          current.callId = typeof item.call_id === "string" ? item.call_id : current.callId;
          if (typeof item.arguments === "string") current.arguments = item.arguments;
          callArguments.set(key, current);
          emitCall(key);
        }
        break;
      }
      case "response.completed": {
        // Final snapshot: emit text from the output when the stream did not already deliver it.
        if (!emittedText) {
          const snapshotText = extractResponsesOutputText(payload?.response ?? payload);
          if (snapshotText) {
            emittedText = true;
            progress.report(new vscode.LanguageModelTextPart(snapshotText));
          }
        }
        break;
      }
      case "error": {
        throw new Error(typeof payload?.message === "string" ? payload.message : "Codex Responses stream error.");
      }
    }
  };

  const processEvent = (event: string): void => {
    const data = event
      .split(/\r?\n/)
      .filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) return;
    let payload: any;
    try {
      payload = JSON.parse(data);
    } catch {
      throw new Error(`Codex Responses stream returned invalid JSON: ${data.slice(0, 1000)}`);
    }
    handleEvent(payload);
  };

  try {
    while (true) {
      if (token.isCancellationRequested) {
        await reader.cancel();
        throw new vscode.CancellationError();
      }
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      for (const event of events) processEvent(event);
    }
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    buffer += decoder.decode();
    if (buffer.trim()) processEvent(buffer);
  } finally {
    cancellation.dispose();
    reader.releaseLock();
  }

  // Emit tool calls whose arguments completed without an output_item.done snapshot.
  for (const [key, call] of callArguments) emitCall(key);
}

function modelConfigurationSchema(config: ShunCodeRuntimeModelConfig): vscode.LanguageModelConfigurationSchema {
  const reasoningOptions = config.deepSeek || config.codex
    ? [...config.reasoningEfforts]
    : [...new Set([...REASONING_EFFORTS, ...config.reasoningEfforts])];
  if (config.deepSeek) {
    const defaultEffort = config.thinking === "disabled"
      ? "disabled"
      : config.reasoningEffort ?? DEEPSEEK_DEFAULT_REASONING_EFFORT;
    return {
      properties: {
        reasoningEffort: {
          type: "string",
          title: "Thinking Effort",
          group: "navigation",
          enum: ["disabled", ...reasoningOptions],
          enumItemLabels: ["Disabled", ...reasoningOptions.map(reasoningEffortLabel)],
          enumDescriptions: ["Disable thinking mode.", ...reasoningOptions.map(reasoningEffortDescription)],
          default: defaultEffort,
        },
      },
    };
  }
  if (config.codex) {
    const properties: Record<string, Record<string, any>> = {
      reasoningEffort: {
        type: "string",
        title: "Thinking Effort",
        group: "navigation",
        enum: ["inherit", ...reasoningOptions],
        enumItemLabels: ["Account Default", ...reasoningOptions.map(reasoningEffortLabel)],
        enumDescriptions: ["Use the default thinking effort for this Codex model.", ...reasoningOptions.map(reasoningEffortDescription)],
        default: "inherit",
      },
    };
    if (config.serviceTiers?.length) {
      properties.serviceTier = {
        type: "string",
        title: "Speed",
        group: "speed",
        enum: ["default", ...config.serviceTiers.map(tier => tier.id)],
        enumItemLabels: ["Standard", ...config.serviceTiers.map(tier => tier.name)],
        enumDescriptions: ["Use standard Codex processing.", ...config.serviceTiers.map(tier => tier.description ?? "Use the faster Codex service tier with increased usage.")],
        default: config.serviceTier ?? "default",
      };
    }
    return {
      properties,
    };
  }
  const genericReasoningValues = genericReasoningPickerValues(reasoningOptions);
  const properties: Record<string, Record<string, any>> = {
    reasoningEffort: {
      type: "string",
      title: "Thinking Effort",
      group: "navigation",
      enum: genericReasoningValues,
      enumItemLabels: ["Provider Default", "Enabled", "Disabled", ...reasoningOptions.map(reasoningEffortLabel)],
      enumDescriptions: [
        "Use the provider's configured thinking mode and effort.",
        "Enable thinking while keeping the provider's configured effort.",
        "Disable reasoning parameters for this request.",
        ...reasoningOptions.map(reasoningEffortDescription),
      ],
      default: "inherit",
    },
  };
  return { properties };
}

function inheritedEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T | undefined): T | undefined {
  const normalized = stringValue(value);
  if (!normalized || normalized === "inherit") return fallback;
  return enumValue(normalized, allowed) ?? fallback;
}

function resolveRequestConfig(base: ShunCodeRuntimeModelConfig, modelConfiguration: Record<string, unknown> | undefined): ShunCodeRuntimeModelConfig {
  if (!modelConfiguration) return base;
  const allowedReasoningEfforts: readonly ReasoningEffort[] = base.reasoningEfforts;
  const deepSeekSelection = base.deepSeek ? resolveDeepSeekThinkingEffort(modelConfiguration.reasoningEffort) : undefined;
  const genericSelection = !base.deepSeek && !base.codex
    ? resolveGenericReasoningOverride(modelConfiguration.reasoningEffort, allowedReasoningEfforts, base.reasoningEffort)
    : undefined;
  let resolvedThinking: ThinkingMode | undefined;
  let reasoningEffort: ReasoningEffort | undefined;
  if (deepSeekSelection) {
    resolvedThinking = deepSeekSelection.thinking;
    reasoningEffort = deepSeekSelection.reasoningEffort;
  } else if (genericSelection) {
    resolvedThinking = genericSelection.thinking;
    reasoningEffort = genericSelection.reasoningEffort;
  } else {
    resolvedThinking = inheritedEnum(modelConfiguration.thinking, THINKING_MODES, base.thinking);
    reasoningEffort = inheritedEnum(modelConfiguration.reasoningEffort, allowedReasoningEfforts, base.reasoningEffort);
  }
  // Non-DeepSeek endpoints default to thinking enabled with a balanced effort so
  // newly added APIs immediately offer multi-level thinking without extra setup.
  if (!base.deepSeek && resolvedThinking === "enabled" && !reasoningEffort) {
    reasoningEffort = "medium";
  }
  const allowedServiceTiers: readonly ServiceTier[] = base.codex && base.serviceTiers?.length
    ? ["default", ...base.serviceTiers.map(tier => tier.id)]
    : ["auto", "default", "flex", "scale", "priority", "fast"];
  return {
    ...base,
    thinking: resolvedThinking,
    contextWindow: optionalInteger(modelConfiguration.contextSize ?? modelConfiguration.contextWindow, 1_024, 10_000_000) ?? base.contextWindow,
    maxOutputTokens: optionalInteger(modelConfiguration.maxOutputTokens, 1, 1_000_000) ?? base.maxOutputTokens,
    firstTokenTimeoutMs: optionalInteger(modelConfiguration.firstTokenTimeoutMs, 1_000, 1_800_000) ?? base.firstTokenTimeoutMs,
    idleTimeoutMs: optionalInteger(modelConfiguration.idleTimeoutMs, 1_000, 1_800_000) ?? base.idleTimeoutMs,
    totalTimeoutMs: optionalInteger(modelConfiguration.totalTimeoutMs, 1_000, 1_800_000) ?? base.totalTimeoutMs,
    reasoningEffort,
    reasoningEfforts: reasoningEffortOptions(modelConfiguration.reasoningEfforts, reasoningEffort, allowedReasoningEfforts),
    reasoningSummary: inheritedEnum(modelConfiguration.reasoningSummary, ["auto", "concise", "detailed"] as const, base.reasoningSummary),
    reasoningContext: inheritedEnum(modelConfiguration.reasoningContext, ["auto", "current_turn", "all_turns"] as const, base.reasoningContext),
    reasoningMode: inheritedEnum(modelConfiguration.reasoningMode, ["standard", "pro"] as const, base.reasoningMode),
    verbosity: inheritedEnum(modelConfiguration.verbosity, ["low", "medium", "high"] as const, base.verbosity),
    temperature: optionalNumber(modelConfiguration.temperature, 0, 2) ?? base.temperature,
    topP: optionalNumber(modelConfiguration.topP, 0, 1) ?? base.topP,
    parallelToolCalls: optionalBoolean(modelConfiguration.parallelToolCalls) ?? base.parallelToolCalls,
    maxToolCalls: optionalInteger(modelConfiguration.maxToolCalls, 1, 128) ?? base.maxToolCalls,
    serviceTier: inheritedEnum(modelConfiguration.serviceTier, allowedServiceTiers, base.serviceTier),
    store: optionalBoolean(modelConfiguration.store) ?? base.store,
    truncation: inheritedEnum(modelConfiguration.truncation, ["auto", "disabled"] as const, base.truncation),
    promptCacheKey: stringValue(modelConfiguration.promptCacheKey) || base.promptCacheKey,
    promptCacheMode: inheritedEnum(modelConfiguration.promptCacheMode, ["implicit", "explicit"] as const, base.promptCacheMode),
    promptCacheTtl: inheritedEnum(modelConfiguration.promptCacheTtl, ["30m"] as const, base.promptCacheTtl),
    promptCacheRetention: inheritedEnum(modelConfiguration.promptCacheRetention, ["in_memory", "24h"] as const, base.promptCacheRetention),
    safetyIdentifier: stringValue(modelConfiguration.safetyIdentifier) || base.safetyIdentifier,
    seed: optionalInteger(modelConfiguration.seed, -2_147_483_648, 2_147_483_647) ?? base.seed,
    presencePenalty: optionalNumber(modelConfiguration.presencePenalty, -2, 2) ?? base.presencePenalty,
    frequencyPenalty: optionalNumber(modelConfiguration.frequencyPenalty, -2, 2) ?? base.frequencyPenalty,
    stop: stringArrayValue(modelConfiguration.stop, 4) ?? base.stop,
    responseFormat: objectValue(modelConfiguration.responseFormat) ?? base.responseFormat,
    requestMetadata: stringRecordValue(modelConfiguration.requestMetadata) ?? base.requestMetadata,
    extraBody: { ...(base.extraBody ?? {}), ...(objectValue(modelConfiguration.extraBody) ?? {}) },
  };
}

const PROTECTED_REQUEST_KEYS = new Set(["model", "messages", "input", "instructions", "tools", "tool_choice", "stream", "background", "service_tier"]);

function safeExtraBody(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PROTECTED_REQUEST_KEYS.has(key)));
}

export class ShunCodeLanguageModelProvider implements vscode.LanguageModelChatProvider<any>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly runtimeModels = new Map<string, ShunCodeRuntimeModelConfig>();
  /**
   * Last successful model discovery per provider fingerprint. A failed or empty
   * re-discovery falls back to this list so a transient network/auth failure can
   * never wipe the model picker (VS Code clears the vendor's cached models when
   * the provider rejects or returns nothing).
   */
  private readonly discoveredModelCache = new Map<string, DiscoveredModel[]>();
  readonly onDidChangeLanguageModelChatInformation = this.changeEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly providerMode: ShunCodeProviderMode = "api",
  ) {}

  refresh(): void {
    this.changeEmitter.fire();
  }

  private async getProviderFingerprintSalt(): Promise<string> {
    const existing = await this.context.secrets.get(PROVIDER_FINGERPRINT_SALT_SECRET);
    if (existing?.trim()) return existing;
    const generated = randomBytes(32).toString("hex");
    await this.context.secrets.store(PROVIDER_FINGERPRINT_SALT_SECRET, generated);
    return generated;
  }

  private async legacyRuntimeModel(modelOverride?: string): Promise<ShunCodeRuntimeModelConfig> {
    const legacy = await getShunCodeModelConfig(this.context);
    const baseUrl = normalizeApiBaseUrl(legacy.baseUrl);
    const deepSeek = isOfficialDeepSeekApiBaseUrl(baseUrl);
    return {
      protocol: "openai-chat-completions",
      baseUrl,
      apiKey: legacy.apiKey,
      model: modelOverride || legacy.model,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      firstTokenTimeoutMs: DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      totalTimeoutMs: DEFAULT_TOTAL_TIMEOUT_MS,
      retries: 0,
      contextWindow: deepSeek ? DEEPSEEK_CONTEXT_WINDOW_TOKENS : DEFAULT_CONTEXT_WINDOW,
      maxOutputTokens: deepSeek ? DEEPSEEK_MAX_OUTPUT_TOKENS : undefined,
      thinking: "enabled",
      reasoningEffort: deepSeek ? DEEPSEEK_DEFAULT_REASONING_EFFORT : "medium",
      reasoningEfforts: deepSeek ? [...DEEPSEEK_REASONING_EFFORTS] : [...REASONING_EFFORTS],
      deepSeek,
      codex: false,
      imageInput: true,
      providerKey: "legacy",
      legacy: true,
    };
  }

  private configuredRuntimeBase(configuration: ShunCodeProviderConfiguration): Omit<ShunCodeRuntimeModelConfig, "model" | "providerKey"> {
    const protocol = enumValue(configuration.protocol, ["openai-chat-completions", "openai-responses", "anthropic-messages"] as const) ?? "openai-chat-completions";
    const baseUrl = normalizeApiBaseUrl(stringValue(configuration.baseUrl));
    const deepSeek = protocol === "openai-chat-completions" && isOfficialDeepSeekApiBaseUrl(baseUrl);
    const defaultReasoningEfforts: readonly ReasoningEffort[] = deepSeek ? DEEPSEEK_REASONING_EFFORTS : REASONING_EFFORTS;
    const reasoningEffort = enumValue(configuration.reasoningEffort, defaultReasoningEfforts)
      ?? (deepSeek ? DEEPSEEK_DEFAULT_REASONING_EFFORT : "medium");
    const legacyTimeoutMs = integerValue(configuration.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 300_000);
    return {
      protocol,
      baseUrl,
      apiKey: stringValue(configuration.apiKey) || undefined,
      timeoutMs: legacyTimeoutMs,
      firstTokenTimeoutMs: integerValue(configuration.firstTokenTimeoutMs, Math.min(DEFAULT_FIRST_TOKEN_TIMEOUT_MS, legacyTimeoutMs), 1_000, 1_800_000),
      idleTimeoutMs: integerValue(configuration.idleTimeoutMs, Math.min(DEFAULT_IDLE_TIMEOUT_MS, legacyTimeoutMs), 1_000, 1_800_000),
      totalTimeoutMs: integerValue(configuration.totalTimeoutMs, Math.max(DEFAULT_TOTAL_TIMEOUT_MS, legacyTimeoutMs), 1_000, 1_800_000),
      retries: integerValue(configuration.retries, 2, 0, 5),
      contextWindow: integerValue(configuration.contextWindow, DEFAULT_API_CONTEXT_WINDOW, 1_024, 10_000_000),
      maxOutputTokens: optionalInteger(configuration.maxOutputTokens, 1, 1_000_000) ?? DEFAULT_API_MAX_OUTPUT_TOKENS,
      description: stringValue(configuration.description) || undefined,
      thinking: enumValue(configuration.thinking, THINKING_MODES) ?? "enabled",
      reasoningEffort,
      reasoningEfforts: reasoningEffortOptions(configuration.reasoningEfforts, reasoningEffort, defaultReasoningEfforts),
      deepSeek,
      codex: false,
      imageInput: true,
    };
  }

  private codexRuntimeBase(): Omit<ShunCodeRuntimeModelConfig, "model" | "providerKey"> {
    return {
      protocol: "openai-responses",
      baseUrl: CODEX_API_BASE_URL,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      firstTokenTimeoutMs: DEFAULT_FIRST_TOKEN_TIMEOUT_MS,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      totalTimeoutMs: DEFAULT_TOTAL_TIMEOUT_MS,
      retries: 2,
      contextWindow: DEFAULT_CODEX_CONTEXT_WINDOW,
      reasoningEffort: "medium",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      serviceTier: "default",
      serviceTiers: [{ id: "priority", name: "Fast", description: "Faster responses with increased usage." }],
      deepSeek: false,
      codex: true,
      imageInput: true,
      description: "ChatGPT subscription",
    };
  }

  private async discoverModels(
    base: Omit<ShunCodeRuntimeModelConfig, "model" | "providerKey">,
    token: vscode.CancellationToken,
    manualModelIds: string[] = [],
  ): Promise<DiscoveredModel[]> {
    if (manualModelIds.length > 0) {
      // Endpoints that do not expose GET /models can opt into a manual model ID
      // list in the provider configuration (modelIds). Discovery is skipped.
      return manualModelIds.map(id => ({ id, name: id }));
    }
    if (base.codex) {
      let auth: CodexRequestContext;
      try {
        auth = await codexAuthManager.getRequestContext();
      } catch {
        // Not signed in yet: expose no models until the user completes Codex sign-in.
        return [];
      }
      const headers: Record<string, string> = {
        accept: "application/json",
        authorization: `Bearer ${auth.accessToken}`,
        "ChatGPT-Account-ID": auth.accountId,
        originator: CODEX_ORIGINATOR,
        "User-Agent": CODEX_USER_AGENT,
        "OpenAI-Beta": CODEX_BETA_HEADER,
      };
      const payload = await fetchJsonWithRetries(
        normalizeModelsUrl(base.baseUrl, CODEX_CLIENT_VERSION),
        { method: "GET", headers },
        token,
        Math.min(base.timeoutMs, MODEL_DISCOVERY_TIMEOUT_MS),
        base.retries,
        "Codex model discovery",
      );
      const models = parseDiscoveredModels(payload, true);
      if (models.length === 0) {
        throw new Error("Codex model discovery returned no compatible text model IDs.");
      }
      return models;
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (base.apiKey?.trim()) headers.authorization = `Bearer ${base.apiKey.trim()}`;
    if (base.protocol === "anthropic-messages") {
      if (base.apiKey?.trim()) headers["x-api-key"] = base.apiKey.trim();
      headers["anthropic-version"] = ANTHROPIC_API_VERSION;
    }
    const payload = await fetchJsonWithRetries(
      base.protocol === "anthropic-messages" ? normalizeAnthropicModelsUrl(base.baseUrl) : normalizeModelsUrl(base.baseUrl),
      { method: "GET", headers },
      token,
      Math.min(base.timeoutMs, MODEL_DISCOVERY_TIMEOUT_MS),
      base.retries,
      "Model discovery",
    );
    const models = parseDiscoveredModels(payload);
    if (models.length === 0) {
      throw new Error("Model discovery succeeded but returned no model IDs. Enter Model IDs manually for endpoints that do not expose GET /models.");
    }
    return models;
  }

  public async resolveRuntimeModel(modelId?: string, modelConfiguration?: Record<string, unknown>): Promise<ShunCodeRuntimeModelConfig | undefined> {
    let resolved: ShunCodeRuntimeModelConfig | undefined;
    if (modelId) {
      const normalizedId = normalizeProviderModelId(modelId, this.providerMode === "codex" ? "shuncode-codex" : "shuncode");
      resolved = this.runtimeModels.get(normalizedId);
      if (!resolved && normalizedId !== modelId) {
        // Fall back to the raw id in case a caller already passed the bare id.
        resolved = this.runtimeModels.get(modelId);
      }
      if (!resolved) {
        if (normalizedId.includes(MODEL_ID_SEPARATOR)) return undefined;
        resolved = await this.legacyRuntimeModel(normalizedId);
      }
    } else if (this.providerMode === "api") {
      resolved = await this.legacyRuntimeModel();
    } else {
      return undefined;
    }
    return resolveRequestConfig({ ...resolved }, modelConfiguration);
  }

  async provideLanguageModelChatInformation(options: any, token: vscode.CancellationToken): Promise<any[]> {
    const configuration = options?.configuration as ShunCodeProviderConfiguration | undefined;
    if (this.providerMode === "api" && (!configuration || !stringValue(configuration.baseUrl))) {
      // The unconfigured provider slot is queried alongside the configured API
      // Provider group. Returning the legacy settings model here duplicates the
      // first discovered model in the picker. Keep legacy resolution below for
      // existing sessions, but do not advertise it as a selectable model.
      return [];
    }

    const base = this.providerMode === "codex"
      ? this.codexRuntimeBase()
      : this.configuredRuntimeBase(configuration!);
    const providerKey = providerFingerprint(base, await this.getProviderFingerprintSalt());
    // The extension host keeps each configured API Provider in a separate external
    // group, but that group is not exposed through PrepareLanguageModelChatModelOptions.
    // Use the provider fingerprint as the internal namespace so refreshing a later
    // configuration cannot evict runtime models belonging to an earlier one.
    const modelNamespace = providerKey;
    const manualModelIds = parseManualModelIds(configuration?.modelIds);
    let discoveredModels: DiscoveredModel[];
    try {
      discoveredModels = await this.discoverModels(base, token, manualModelIds);
    } catch (error) {
      // Discovery failed (timeout, HTTP 5xx/429, or auth rejection). Keep serving
      // the last successfully discovered models instead of surfacing the failure:
      // a rejected provideLanguageModelChatInformation makes VS Code clear the
      // vendor's entire cached model list. Only rethrow when this provider
      // fingerprint has never succeeded, so the management page can still show a
      // first-time configuration error.
      const cached = this.discoveredModelCache.get(modelNamespace);
      if (!cached) throw error;
      discoveredModels = cached;
    }
    if (discoveredModels.length === 0) {
      // e.g. Codex is not signed in. Keep the previous models so the picker does
      // not empty out on a transient auth state; requests fail with a clear auth
      // error at send time instead.
      const cached = this.discoveredModelCache.get(modelNamespace);
      if (!cached?.length) return [];
      discoveredModels = cached;
    } else {
      this.discoveredModelCache.set(modelNamespace, discoveredModels);
      // Bound the cache to recent provider fingerprints so long-lived sessions
      // with many configuration changes cannot grow it without limit.
      if (this.discoveredModelCache.size > 64) {
        const oldestKey = this.discoveredModelCache.keys().next().value;
        if (oldestKey !== undefined) {
          this.discoveredModelCache.delete(oldestKey);
        }
      }
    }

    deleteRuntimeModelsForNamespace(this.runtimeModels, modelNamespace);

    return discoveredModels.map((discoveredModel, index) => {
      const rawModelId = discoveredModel.id;
      let id = encodedModelId(modelNamespace, rawModelId);
      let suffix = 2;
      while (this.runtimeModels.has(id)) {
        id = encodedModelId(`${modelNamespace}-${suffix}`, rawModelId);
        suffix += 1;
      }
      const reasoningEfforts = discoveredModel.reasoningEfforts?.length
        ? [...discoveredModel.reasoningEfforts]
        : [...base.reasoningEfforts];
      const reasoningEffort = discoveredModel.defaultReasoningEffort
        ?? (base.reasoningEffort && reasoningEfforts.includes(base.reasoningEffort) ? base.reasoningEffort : reasoningEfforts[0]);
      const serviceTiers = discoveredModel.serviceTiers !== undefined
        ? discoveredModel.serviceTiers
        : base.serviceTiers;
      const config = {
        ...base,
        model: rawModelId,
        providerKey,
        contextWindow: discoveredModel.contextWindow ?? base.contextWindow,
        maxOutputTokens: discoveredModel.maxOutputTokens ?? base.maxOutputTokens,
        reasoningEffort,
        reasoningEfforts,
        serviceTier: serviceTiers?.length ? discoveredModel.defaultServiceTier ?? "default" : undefined,
        serviceTiers,
        imageInput: true,
        description: discoveredModel.description ?? base.description,
      };
      this.runtimeModels.set(id, config);
      return {
        id,
        name: discoveredModel.name,
        family: rawModelId,
        version: "configured",
        tooltip: discoveredModel.description || `${rawModelId} · ${base.baseUrl}`,
        detail: discoveredModel.description || base.description || `${base.codex ? "Codex" : "Chat Completions"} · ${base.baseUrl}`,
        maxInputTokens: config.contextWindow,
        // Generic API providers always carry an explicit output budget from
        // DEFAULT_API_MAX_OUTPUT_TOKENS; this fallback only covers Codex models.
        maxOutputTokens: config.maxOutputTokens ?? Math.min(32_768, Math.max(4_096, Math.floor(config.contextWindow / 4))),
        capabilities: { toolCalling: true, imageInput: config.imageInput },
        configurationSchema: modelConfigurationSchema(config),
        isBYOK: true,
        isDefault: false,
        isUserSelectable: true,
        _shuncodeRuntimeConfig: config,
        _shuncodeProviderOrder: index,
      };
    });
  }

  async provideTokenCount(_model: any, input: string | any, token: vscode.CancellationToken): Promise<number> {
    if (token.isCancellationRequested) throw new vscode.CancellationError();
    const text = typeof input === "string"
      ? input
      : Array.isArray(input?.content)
        ? input.content.map((part: any) => textFromPart(part) ?? JSON.stringify(part)).join("\n")
        : String(input ?? "");
    // This count is intentionally approximate. The configured endpoint may expose arbitrary
    // OpenAI-compatible models with different tokenizers; VS Code uses this primarily for UI/context budgeting.
    return Math.max(1, Math.ceil(text.length / 4));
  }

  async provideLanguageModelChatResponse(
    model: any,
    messages: readonly any[],
    options: any,
    progress: vscode.Progress<any>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const baseConfig = model?._shuncodeRuntimeConfig as ShunCodeRuntimeModelConfig | undefined
      ?? await this.resolveRuntimeModel(typeof model?.id === "string" ? model.id : undefined);
    if (!baseConfig) {
      throw new Error("The selected ShunCode API provider is no longer available. Refresh the provider or select another model.");
    }
    const config = resolveRequestConfig(baseConfig, objectValue(options?.modelConfiguration));

    if (config.codex) {
      await this.provideCodexChatResponse(config, messages, options, progress, token);
      return;
    }

    const headers: Record<string, string> = { "content-type": "application/json", accept: "text/event-stream" };
    if (config.apiKey?.trim()) headers.authorization = `Bearer ${config.apiKey.trim()}`;
    const rawTools = Array.isArray(options?.tools) ? options.tools : [];
    const toolChoice = rawTools.length
      ? options?.toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto"
      : undefined;

    if (config.protocol === "openai-responses") {
      const reasoning = config.thinking === "disabled" ? {} : {
        ...(config.reasoningEffort ? { effort: config.reasoningEffort } : {}),
        ...(config.reasoningSummary ? { summary: config.reasoningSummary } : {}),
        ...(config.reasoningContext ? { context: config.reasoningContext } : {}),
        ...(config.reasoningMode ? { mode: config.reasoningMode } : {}),
      };
      const promptCacheOptions = {
        ...(config.promptCacheMode ? { mode: config.promptCacheMode } : {}),
        ...(config.promptCacheTtl ? { ttl: config.promptCacheTtl } : {}),
      };
      const responseTools = rawTools.map((tool: any) => ({
        type: "function",
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
      }));
      const extra = safeExtraBody(config.extraBody);
      const extraText = objectValue(extra.text);
      delete extra.text;
      const body = {
        ...extra,
        model: config.model,
        input: toResponsesInput(messages),
        ...(config.maxOutputTokens !== undefined ? { max_output_tokens: config.maxOutputTokens } : {}),
        ...(Object.keys(reasoning).length ? { reasoning } : {}),
        ...(config.verbosity || extraText ? { text: { ...(extraText ?? {}), ...(config.verbosity ? { verbosity: config.verbosity } : {}) } } : {}),
        ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
        ...(config.topP !== undefined ? { top_p: config.topP } : {}),
        ...(config.parallelToolCalls !== undefined ? { parallel_tool_calls: config.parallelToolCalls } : {}),
        ...(config.maxToolCalls !== undefined ? { max_tool_calls: config.maxToolCalls } : {}),
        ...(config.serviceTier ? { service_tier: config.serviceTier } : {}),
        ...(config.store !== undefined ? { store: config.store } : {}),
        ...(config.truncation ? { truncation: config.truncation } : {}),
        ...(config.promptCacheKey ? { prompt_cache_key: config.promptCacheKey } : {}),
        ...(Object.keys(promptCacheOptions).length ? { prompt_cache_options: promptCacheOptions } : {}),
        ...(config.promptCacheRetention ? { prompt_cache_retention: config.promptCacheRetention } : {}),
        ...(config.safetyIdentifier ? { safety_identifier: config.safetyIdentifier } : {}),
        ...(config.requestMetadata ? { metadata: config.requestMetadata } : {}),
        ...(responseTools.length ? { tools: responseTools, tool_choice: toolChoice } : {}),
      };
      const payload = await fetchJsonWithRetries(
        normalizeResponsesUrl(config.baseUrl),
        { method: "POST", headers, body: JSON.stringify(body) },
        token,
        config.timeoutMs,
        config.retries,
        "Responses endpoint",
      );
      if (payload?.status === "failed") {
        throw new Error(payload?.error?.message ?? "ShunCode Responses API request failed.");
      }

      let emittedText = false;
      for (const item of Array.isArray(payload?.output) ? payload.output : []) {
        if (item?.type === "reasoning") {
          const summaries = (Array.isArray(item.summary) ? item.summary : [])
            .map((entry: any) => typeof entry?.text === "string" ? entry.text : "")
            .filter(Boolean);
          if (summaries.length) {
            progress.report(new vscode.LanguageModelThinkingPart(summaries, item.id, {
              context: payload?.reasoning?.context,
              mode: payload?.reasoning?.mode,
            }));
          }
          continue;
        }
        if (item?.type === "message") {
          for (const content of Array.isArray(item.content) ? item.content : []) {
            const text = content?.type === "output_text" && typeof content.text === "string"
              ? content.text
              : content?.type === "refusal" && typeof content.refusal === "string"
                ? content.refusal
                : undefined;
            if (text) {
              emittedText = true;
              progress.report(new vscode.LanguageModelTextPart(text));
            }
          }
          continue;
        }
        if (item?.type === "function_call" && typeof item.name === "string") {
          let input: object = {};
          try {
            input = JSON.parse(typeof item.arguments === "string" ? item.arguments : "{}");
          } catch {
            input = {};
          }
          progress.report(new vscode.LanguageModelToolCallPart(item.call_id ?? item.id ?? `tool-${Date.now()}`, item.name, input));
        }
      }
      if (!emittedText && typeof payload?.output_text === "string" && payload.output_text) {
        progress.report(new vscode.LanguageModelTextPart(payload.output_text));
      }
      return;
    }

    if (config.protocol === "anthropic-messages") {
      if (config.apiKey?.trim()) headers["x-api-key"] = config.apiKey.trim();
      headers["anthropic-version"] = ANTHROPIC_API_VERSION;
      const anthropicTools = rawTools.map((tool: any) => ({
        name: tool.name,
        description: tool.description ?? "",
        input_schema: tool.inputSchema ?? { type: "object", properties: {} },
      }));
      const maxOutputTokens = config.maxOutputTokens ?? 8_192;
      const effort = config.thinking !== "disabled" && config.reasoningEffort
        && config.reasoningEffort !== "none" && config.reasoningEffort !== "minimal"
        ? config.reasoningEffort
        : undefined;
      const thinkingBudget = effort
        ? Math.max(1_024, Math.min(ANTHROPIC_EFFORT_THINKING_BUDGETS[effort] ?? 8_192, maxOutputTokens - 1_024))
        : 0;
      const extra = safeExtraBody(config.extraBody);
      const body = {
        ...extra,
        model: config.model,
        messages: toAnthropicChatMessages(messages).messages,
        max_tokens: maxOutputTokens,
        ...(thinkingBudget >= 1_024 && thinkingBudget < maxOutputTokens
          ? { thinking: { type: "enabled", budget_tokens: thinkingBudget } }
          : {}),
        ...(anthropicTools.length
          ? { tools: anthropicTools, tool_choice: { type: toolChoice === "required" ? "any" : "auto" } }
          : {}),
      };
      const payload = await fetchJsonWithRetries(
        normalizeAnthropicMessagesUrl(config.baseUrl),
        { method: "POST", headers, body: JSON.stringify(body) },
        token,
        config.timeoutMs,
        config.retries,
        "Anthropic Messages endpoint",
      );
      if (payload?.type === "error" || payload?.error) {
        throw new Error(String(payload?.error?.message ?? "ShunCode Anthropic Messages request failed."));
      }
      for (const block of Array.isArray(payload?.content) ? payload.content : []) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          progress.report(new vscode.LanguageModelThinkingPart(block.thinking, block.id));
          continue;
        }
        if (block.type === "text" && typeof block.text === "string" && block.text) {
          progress.report(new vscode.LanguageModelTextPart(block.text));
          continue;
        }
        if (block.type === "tool_use" && typeof block.name === "string") {
          progress.report(new vscode.LanguageModelToolCallPart(
            typeof block.id === "string" && block.id ? block.id : `tool-${Date.now()}`,
            block.name,
            block.input && typeof block.input === "object" ? block.input : {},
          ));
        }
      }
      return;
    }

    const chatTools = rawTools.map((tool: any) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
      },
    }));
    const deepSeekThinking = config.deepSeek && config.thinking !== "disabled";
    const extra = safeExtraBody(config.extraBody);
    const chatMessages = toOpenAIMessages(messages, { preserveReasoningContent: deepSeekThinking });
    const availableOutputTokens = config.deepSeek
      ? config.contextWindow - estimatedTokens({ messages: chatMessages, tools: chatTools }) - 1_024
      : undefined;
    if (availableOutputTokens !== undefined && availableOutputTokens < 1) {
      throw new Error("The DeepSeek request exceeds the configured context window after reserving response space.");
    }
    const requestMaxOutputTokens = config.maxOutputTokens !== undefined
      ? availableOutputTokens === undefined ? config.maxOutputTokens : Math.min(config.maxOutputTokens, availableOutputTokens)
      : undefined;
    const body = {
      ...extra,
      model: config.model,
      messages: chatMessages,
      ...(requestMaxOutputTokens !== undefined ? { max_tokens: requestMaxOutputTokens } : {}),
      ...(config.deepSeek && config.thinking ? { thinking: { type: config.thinking } } : {}),
      ...(config.reasoningEffort && (config.deepSeek ? deepSeekThinking : config.thinking !== "disabled") ? { reasoning_effort: config.reasoningEffort } : {}),
      ...(!deepSeekThinking && config.temperature !== undefined ? { temperature: config.temperature } : {}),
      ...(!deepSeekThinking && config.topP !== undefined ? { top_p: config.topP } : {}),
      ...(config.responseFormat ? { response_format: config.responseFormat } : {}),
      ...(config.stop ? { stop: config.stop } : {}),
      ...(config.seed !== undefined ? { seed: config.seed } : {}),
      ...(!deepSeekThinking && config.presencePenalty !== undefined ? { presence_penalty: config.presencePenalty } : {}),
      ...(!deepSeekThinking && config.frequencyPenalty !== undefined ? { frequency_penalty: config.frequencyPenalty } : {}),
      ...(chatTools.length ? { tools: chatTools, ...(!deepSeekThinking ? { tool_choice: toolChoice } : {}) } : {}),
      stream: true,
    };
    const response = await fetchStreamWithRetries(
      normalizeChatCompletionsUrl(config.baseUrl),
      { method: "POST", headers, body: JSON.stringify(body) },
      token,
      config.timeoutMs,
      config.retries,
      "Chat Completions endpoint",
    );
    await emitChatCompletionStream(response, progress, token);
  }

  private async provideCodexChatResponse(
    config: ShunCodeRuntimeModelConfig,
    messages: readonly any[],
    options: any,
    progress: vscode.Progress<any>,
    token: vscode.CancellationToken,
  ): Promise<void> {
    const auth = await codexAuthManager.getRequestContext();
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${auth.accessToken}`,
      "ChatGPT-Account-ID": auth.accountId,
      originator: CODEX_ORIGINATOR,
      "User-Agent": CODEX_USER_AGENT,
      "OpenAI-Beta": CODEX_BETA_HEADER,
    };
    const rawTools = Array.isArray(options?.tools) ? options.tools : [];
    const toolChoice = rawTools.length
      ? options?.toolMode === vscode.LanguageModelChatToolMode.Required ? "required" : "auto"
      : undefined;
    const effort = codexReasoningEffort(config.reasoningEffort);
    const serviceTier = config.serviceTier === "default" ? undefined : config.serviceTier;
    const reasoning = {
      ...(effort ? { effort } : {}),
      ...(config.reasoningSummary ? { summary: config.reasoningSummary } : {}),
      ...(config.reasoningContext ? { context: config.reasoningContext } : {}),
      ...(config.reasoningMode ? { mode: config.reasoningMode } : {}),
    };
    const responseTools = rawTools.map((tool: any) => ({
      type: "function",
      name: tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    }));
    const extra = safeExtraBody(config.extraBody);
    const extraText = objectValue(extra.text);
    delete extra.text;
    const body = {
      ...extra,
      model: config.model,
      instructions: "You are Codex, OpenAI's coding agent.",
      input: toCodexResponsesInput(messages),
      store: false,
      stream: true,
      ...(Object.keys(reasoning).length ? { reasoning } : {}),
      ...(config.verbosity || extraText ? { text: { ...(extraText ?? {}), ...(config.verbosity ? { verbosity: config.verbosity } : {}) } } : {}),
      ...(config.parallelToolCalls !== undefined ? { parallel_tool_calls: config.parallelToolCalls } : {}),
      ...(serviceTier ? { service_tier: serviceTier } : {}),
      ...(config.promptCacheKey ? { prompt_cache_key: config.promptCacheKey } : {}),
      ...(responseTools.length ? { tools: responseTools, tool_choice: toolChoice } : {}),
    };

    const url = normalizeResponsesUrl(config.baseUrl);
    const attempt = (): Promise<Response> => fetchStreamWithRetries(
      url,
      { method: "POST", headers, body: JSON.stringify(body) },
      token,
      config.timeoutMs,
      config.retries,
      "Codex Responses endpoint",
    );

    let response: Response;
    try {
      response = await attempt();
    } catch (error) {
      const status = typeof error === "object" && error !== null && "status" in error
        ? Number((error as { status?: unknown }).status)
        : undefined;
      if (status !== 401) throw error;
      // The access token expired between refresh and request: refresh once and retry.
      await codexAuthManager.forceRefresh();
      response = await attempt();
    }

    await emitResponsesStream(response, progress, token);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}

