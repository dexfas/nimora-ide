import { createHash } from "node:crypto";
import type { MissionPlane } from "./task-contract.js";

export type MissionSkillSourceKind = "builtin" | "workspace" | "user" | "extension" | "plugin" | "provider" | "unknown";
export type MissionSkillStorage = "local" | "user" | "extension" | "plugin" | "builtin" | "provider" | "unknown";

export interface MissionSkillObservation {
  sourceId: string;
  sourceKind: MissionSkillSourceKind;
  canonicalLocator: string;
  skillId: string;
  name: string;
  title?: string;
  description?: string;
  storage: MissionSkillStorage;
  platformSource?: string;
  enabled: boolean;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  plugin?: { uri: string; label?: string };
  extension?: { id: string; displayName?: string };
  sessionTypes?: string[];
  sourceVersion?: string;
  observedContentDigest?: string;
  eligibleMissionPlanes?: MissionPlane[];
  missionTypes?: string[];
  relevanceTags?: string[];
  requiredCapabilityIds?: string[];
}

export interface MissionSkillContentRecord {
  content: string;
  sourceVersion?: string;
}

export interface MissionSkillLoadTarget {
  skillId: string;
  sourceId: string;
  canonicalLocator: string;
}

/**
 * Provider/platform lifecycle remains outside Nimora. Adapters only expose a
 * bounded discovery snapshot and a fresh content read for an already-observed
 * skill. No adapter is a trust, Project-truth or execution authority owner.
 */
export interface MissionSkillSourceAdapter {
  adapterId: string;
  /**
   * Host-wired source authority for first-party bundled Skills. This is not a
   * field discoverable Skill records may self-assert. Adapters without this
   * explicit code-level authority can report builtin provenance, but that fact
   * alone never becomes automatic Nimora trust.
   */
  firstPartyBuiltInAuthority?: boolean;
  listSkills(): Promise<readonly unknown[]>;
  loadContent(target: MissionSkillLoadTarget): Promise<unknown>;
}

export interface IndexedMissionSkill extends MissionSkillObservation {
  provenanceLocator: string;
  firstPartyBuiltIn: boolean;
}

export interface NimoraSkillContentSnapshot {
  content: string;
  contentDigest: string;
  contentChars: number;
  sourceVersion?: string;
}

export interface NimoraSkillIndexSnapshot {
  version: 1;
  skills: readonly IndexedMissionSkill[];
  loadContent(skillId: string): Promise<NimoraSkillContentSnapshot>;
}

export interface PlatformAgentSkillProjectionInput {
  uri: string;
  storage: "local" | "user" | "extension" | "plugin" | "builtin";
  name: string;
  description?: string;
  /** Exact host observation from current disabled-Skill state; not an IAgentSkill field. */
  enabled: boolean;
  disableModelInvocation: boolean;
  userInvocable: boolean;
  pluginUri?: string;
  pluginLabel?: string;
  extensionId?: string;
  extensionDisplayName?: string;
  sessionTypes?: string[];
  source?: string;
  sourceVersion?: string;
  observedContentDigest?: string;
}

export interface PlatformAgentSkillRoutingProjection {
  eligibleMissionPlanes?: MissionPlane[];
  missionTypes?: string[];
  relevanceTags?: string[];
  requiredCapabilityIds?: string[];
}

const MAX_ID_CHARS = 240;
const MAX_LOCATOR_CHARS = 1_024;
const MAX_NAME_CHARS = 240;
const MAX_DESCRIPTION_CHARS = 4_096;
const MAX_SOURCE_VERSION_CHARS = 240;
const MAX_LIST_ITEMS = 128;
const MAX_CONTENT_CHARS = 500_000;
const MAX_ADAPTERS = 32;
const PLATFORM_PROMPT_FILE_SOURCES = new Set([
  "github-workspace",
  "copilot-personal",
  "claude-personal",
  "claude-workspace",
  "claude-workspace-local",
  "agents-workspace",
  "agents-personal",
  "config-workspace",
  "config-personal",
  "user-data",
  "extension-contribution",
  "extension-api",
  "plugin",
]);

function ownRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactOwnDataKeys(row: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(row)) {
    if (typeof key !== "string") throw new Error(`${label} contains unsupported symbol field.`);
    if (!allowedSet.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label}.${key} must be an own data property.`);
  }
}

function ownValue(row: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function boundedString(value: unknown, label: string, maximum: number, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(`${label} must be at most ${maximum} characters.`);
  if (/\p{C}/u.test(normalized)) throw new Error(`${label} contains unsupported control characters.`);
  return normalized;
}

function boundedId(value: unknown, label: string): string {
  return boundedString(value, label, MAX_ID_CHARS)!;
}

function denseStrings(value: unknown, label: string, maximumItems = MAX_LIST_ITEMS): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  if (value.length > maximumItems) throw new Error(`${label} must contain at most ${maximumItems} values.`);
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) throw new Error(`${label}[${index}] must be explicitly present in a dense array.`);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor)) throw new Error(`${label}[${index}] must be an own data property.`);
    result.push(boundedId(descriptor.value, `${label}[${index}]`));
  }
  if (new Set(result).size !== result.length) throw new Error(`${label} must not contain duplicates.`);
  return result;
}

function densePlanes(value: unknown, label: string): MissionPlane[] | undefined {
  const values = denseStrings(value, label, 3);
  if (!values) return undefined;
  for (const value of values) {
    if (value !== "coordination" && value !== "cognition" && value !== "practice") throw new Error(`${label} contains unsupported Mission plane: ${value}`);
  }
  return values as MissionPlane[];
}

function optionalBoolean(value: unknown, label: string, required = false): boolean | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean.`);
  return value;
}

function sanitizeLocator(value: unknown, label: string): string {
  const raw = boundedString(value, label, MAX_LOCATOR_CHARS)!;
  try {
    const parsed = new URL(raw);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    const sanitized = parsed.toString();
    if (sanitized.length > MAX_LOCATOR_CHARS) throw new Error(`${label} is too long after sanitization.`);
    return sanitized;
  } catch (error) {
    if (error instanceof Error && /after sanitization/.test(error.message)) throw error;
    const sanitized = raw.split(/[?#]/, 1)[0].trim();
    if (!sanitized) throw new Error(`${label} must remain non-empty after sanitization.`);
    return sanitized.slice(0, MAX_LOCATOR_CHARS);
  }
}

function normalizeDigest(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(value)) throw new Error(`${label} must be a sha256 digest.`);
  return value.toLowerCase();
}

function normalizePlatformSource(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const source = boundedString(value, "Platform Agent Skill source", MAX_NAME_CHARS)!;
  if (!PLATFORM_PROMPT_FILE_SOURCES.has(source)) throw new Error(`Unsupported Platform PromptFileSource: ${source}`);
  return source;
}

function adapterFirstPartyBuiltInAuthority(adapter: MissionSkillSourceAdapter, adapterId: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(adapter, "firstPartyBuiltInAuthority");
  if (!descriptor) return false;
  if (!("value" in descriptor)) throw new Error(`Mission Skill source adapter ${adapterId} firstPartyBuiltInAuthority must be an own data property.`);
  if (typeof descriptor.value !== "boolean") throw new Error(`Mission Skill source adapter ${adapterId} firstPartyBuiltInAuthority must be a boolean.`);
  return descriptor.value;
}

function normalizeSourceKind(value: unknown, label: string): MissionSkillSourceKind {
  if (value === "builtin" || value === "workspace" || value === "user" || value === "extension" || value === "plugin" || value === "provider" || value === "unknown") return value;
  throw new Error(`${label} is unsupported.`);
}

function normalizeStorage(value: unknown, label: string): MissionSkillStorage {
  if (value === "local" || value === "user" || value === "extension" || value === "plugin" || value === "builtin" || value === "provider" || value === "unknown") return value;
  throw new Error(`${label} is unsupported.`);
}

function normalizePlugin(value: unknown): MissionSkillObservation["plugin"] {
  if (value === undefined) return undefined;
  const row = ownRecord(value, "Skill plugin provenance");
  exactOwnDataKeys(row, ["uri", "label"], "Skill plugin provenance");
  const uri = sanitizeLocator(ownValue(row, "uri"), "Skill plugin URI");
  const label = boundedString(ownValue(row, "label"), "Skill plugin label", MAX_NAME_CHARS, true);
  return { uri, ...(label === undefined ? {} : { label }) };
}

function normalizeExtension(value: unknown): MissionSkillObservation["extension"] {
  if (value === undefined) return undefined;
  const row = ownRecord(value, "Skill extension provenance");
  exactOwnDataKeys(row, ["id", "displayName"], "Skill extension provenance");
  const id = boundedId(ownValue(row, "id"), "Skill extension id");
  const displayName = boundedString(ownValue(row, "displayName"), "Skill extension display name", MAX_NAME_CHARS, true);
  return { id, ...(displayName === undefined ? {} : { displayName }) };
}

function enforceSourceStorageCoherence(sourceKind: MissionSkillSourceKind, storage: MissionSkillStorage, plugin: MissionSkillObservation["plugin"], extension: MissionSkillObservation["extension"]): void {
  if (sourceKind === "builtin" && storage !== "builtin") throw new Error("Built-in Skill source must use builtin storage.");
  if (sourceKind === "workspace" && storage !== "local") throw new Error("Workspace Skill source must use local storage.");
  if (sourceKind === "user" && storage !== "user") throw new Error("User Skill source must use user storage.");
  if (sourceKind === "extension" && (storage !== "extension" || !extension)) throw new Error("Extension Skill source requires extension storage/provenance.");
  if (sourceKind === "plugin" && (storage !== "plugin" || !plugin)) throw new Error("Plugin Skill source requires plugin storage/provenance.");
}

function normalizeObservation(value: unknown, index: number, firstPartyBuiltInAuthority: boolean): IndexedMissionSkill {
  const label = `Mission Skill observation ${index}`;
  const row = ownRecord(value, label);
  exactOwnDataKeys(row, [
    "sourceId", "sourceKind", "canonicalLocator", "skillId", "name", "title", "description", "storage", "platformSource",
    "enabled", "disableModelInvocation", "userInvocable", "plugin", "extension", "sessionTypes", "sourceVersion", "observedContentDigest",
    "eligibleMissionPlanes", "missionTypes", "relevanceTags", "requiredCapabilityIds",
  ], label);
  const sourceId = boundedId(ownValue(row, "sourceId"), `${label} sourceId`);
  const sourceKind = normalizeSourceKind(ownValue(row, "sourceKind"), `${label} sourceKind`);
  const canonicalLocator = sanitizeLocator(ownValue(row, "canonicalLocator"), `${label} canonicalLocator`);
  const skillId = boundedId(ownValue(row, "skillId"), `${label} skillId`);
  const name = boundedString(ownValue(row, "name"), `${label} name`, MAX_NAME_CHARS)!;
  const title = boundedString(ownValue(row, "title"), `${label} title`, MAX_NAME_CHARS, true);
  const description = boundedString(ownValue(row, "description"), `${label} description`, MAX_DESCRIPTION_CHARS, true);
  const storage = normalizeStorage(ownValue(row, "storage"), `${label} storage`);
  const platformSource = boundedString(ownValue(row, "platformSource"), `${label} platformSource`, MAX_NAME_CHARS, true);
  const enabled = optionalBoolean(ownValue(row, "enabled"), `${label} enabled`, true)!;
  const disableModelInvocation = optionalBoolean(ownValue(row, "disableModelInvocation"), `${label} disableModelInvocation`, true)!;
  const userInvocable = optionalBoolean(ownValue(row, "userInvocable"), `${label} userInvocable`, true)!;
  const plugin = normalizePlugin(ownValue(row, "plugin"));
  const extension = normalizeExtension(ownValue(row, "extension"));
  enforceSourceStorageCoherence(sourceKind, storage, plugin, extension);
  if (firstPartyBuiltInAuthority && sourceKind !== "builtin") {
    throw new Error(`${label} came from a first-party built-in authority adapter but is not builtin provenance.`);
  }
  const sessionTypes = denseStrings(ownValue(row, "sessionTypes"), `${label} sessionTypes`);
  const sourceVersion = boundedString(ownValue(row, "sourceVersion"), `${label} sourceVersion`, MAX_SOURCE_VERSION_CHARS, true);
  const observedContentDigest = normalizeDigest(ownValue(row, "observedContentDigest"), `${label} observedContentDigest`);
  const eligibleMissionPlanes = densePlanes(ownValue(row, "eligibleMissionPlanes"), `${label} eligibleMissionPlanes`);
  const missionTypes = denseStrings(ownValue(row, "missionTypes"), `${label} missionTypes`);
  const relevanceTags = denseStrings(ownValue(row, "relevanceTags"), `${label} relevanceTags`);
  const requiredCapabilityIds = denseStrings(ownValue(row, "requiredCapabilityIds"), `${label} requiredCapabilityIds`);
  return {
    sourceId,
    sourceKind,
    canonicalLocator,
    provenanceLocator: canonicalLocator,
    firstPartyBuiltIn: firstPartyBuiltInAuthority && sourceKind === "builtin",
    skillId,
    name,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    storage,
    ...(platformSource === undefined ? {} : { platformSource }),
    enabled,
    disableModelInvocation,
    userInvocable,
    ...(plugin === undefined ? {} : { plugin }),
    ...(extension === undefined ? {} : { extension }),
    ...(sessionTypes === undefined ? {} : { sessionTypes }),
    ...(sourceVersion === undefined ? {} : { sourceVersion }),
    ...(observedContentDigest === undefined ? {} : { observedContentDigest }),
    ...(eligibleMissionPlanes === undefined ? {} : { eligibleMissionPlanes }),
    ...(missionTypes === undefined ? {} : { missionTypes }),
    ...(relevanceTags === undefined ? {} : { relevanceTags }),
    ...(requiredCapabilityIds === undefined ? {} : { requiredCapabilityIds }),
  };
}

function normalizeContentRecord(value: unknown, skill: IndexedMissionSkill): NimoraSkillContentSnapshot {
  const row = ownRecord(value, `Skill content record ${skill.skillId}`);
  exactOwnDataKeys(row, ["content", "sourceVersion"], `Skill content record ${skill.skillId}`);
  const content = ownValue(row, "content");
  if (typeof content !== "string") throw new Error(`Skill content ${skill.skillId} must be a string.`);
  if (content.length > MAX_CONTENT_CHARS) throw new Error(`Skill content ${skill.skillId} exceeds ${MAX_CONTENT_CHARS} characters.`);
  const sourceVersion = boundedString(ownValue(row, "sourceVersion"), `Skill content ${skill.skillId} sourceVersion`, MAX_SOURCE_VERSION_CHARS, true);
  const contentDigest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  if (skill.observedContentDigest && skill.observedContentDigest !== contentDigest) {
    throw new Error(`Skill content digest changed for ${skill.skillId}: observed ${skill.observedContentDigest}, loaded ${contentDigest}.`);
  }
  if (skill.sourceVersion && sourceVersion !== skill.sourceVersion) {
    throw new Error(`Skill source version changed for ${skill.skillId}: observed ${skill.sourceVersion}, loaded ${sourceVersion ?? "<missing>"}.`);
  }
  return { content, contentDigest, contentChars: content.length, ...(sourceVersion === undefined ? {} : { sourceVersion }) };
}

export class NimoraSkillIndex {
  constructor(private readonly adapters: readonly MissionSkillSourceAdapter[]) {}

  async snapshot(): Promise<NimoraSkillIndexSnapshot> {
    if (!Array.isArray(this.adapters)) throw new Error("Mission Skill source adapters must be an array.");
    if (this.adapters.length > MAX_ADAPTERS) throw new Error(`Mission Skill source adapters must contain at most ${MAX_ADAPTERS} entries.`);
    const adapterIds = new Set<string>();
    const loadedBySkillId = new Map<string, { skill: IndexedMissionSkill; adapter: MissionSkillSourceAdapter }>();
    const nameOwners = new Map<string, string>();
    const locatorOwners = new Map<string, string>();
    const sourceOwners = new Map<string, string>();
    let observedCount = 0;

    for (let adapterIndex = 0; adapterIndex < this.adapters.length; adapterIndex += 1) {
      if (!Object.prototype.hasOwnProperty.call(this.adapters, adapterIndex)) throw new Error(`Mission Skill source adapters must be dense; index ${adapterIndex} is missing.`);
      const adapterDescriptor = Object.getOwnPropertyDescriptor(this.adapters, String(adapterIndex));
      if (!adapterDescriptor || !("value" in adapterDescriptor)) throw new Error(`Mission Skill source adapter ${adapterIndex} must be an own data property.`);
      const adapter = adapterDescriptor.value;
      const adapterId = boundedId(adapter.adapterId, `Mission Skill source adapter ${adapterIndex} id`);
      if (adapterIds.has(adapterId)) throw new Error(`Duplicate Mission Skill source adapter id: ${adapterId}`);
      adapterIds.add(adapterId);
      const firstPartyBuiltInAuthority = adapterFirstPartyBuiltInAuthority(adapter, adapterId);
      const raw = await adapter.listSkills();
      if (!Array.isArray(raw)) throw new Error(`Mission Skill source adapter ${adapterId} must return an array.`);
      if (observedCount + raw.length > MAX_LIST_ITEMS) throw new Error(`Mission Skill Index supports at most ${MAX_LIST_ITEMS} discovered Skills.`);
      for (let index = 0; index < raw.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(raw, index)) throw new Error(`Mission Skill source adapter ${adapterId} must return a dense array; index ${index} is missing.`);
        const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
        if (!descriptor || !("value" in descriptor)) throw new Error(`Mission Skill source adapter ${adapterId} record ${index} must be an own data property.`);
        const skill = normalizeObservation(descriptor.value, observedCount, firstPartyBuiltInAuthority);
        observedCount += 1;
        if (loadedBySkillId.has(skill.skillId)) throw new Error(`Duplicate Nimora Skill id: ${skill.skillId}`);
        const nameKey = skill.name.toLocaleLowerCase("en-US");
        const nameOwner = nameOwners.get(nameKey);
        if (nameOwner) throw new Error(`Ambiguous Skill name ${skill.name}: ${nameOwner} and ${skill.skillId}`);
        nameOwners.set(nameKey, skill.skillId);
        const locatorOwner = locatorOwners.get(skill.canonicalLocator);
        if (locatorOwner) throw new Error(`Ambiguous Skill canonical locator ${skill.canonicalLocator}: ${locatorOwner} and ${skill.skillId}`);
        locatorOwners.set(skill.canonicalLocator, skill.skillId);
        const sourceOwner = sourceOwners.get(skill.sourceId);
        if (sourceOwner) throw new Error(`Duplicate Skill source id ${skill.sourceId}: ${sourceOwner} and ${skill.skillId}`);
        sourceOwners.set(skill.sourceId, skill.skillId);
        loadedBySkillId.set(skill.skillId, { skill, adapter });
      }
    }

    const skills = [...loadedBySkillId.values()].map(entry => entry.skill).sort((a, b) => a.skillId.localeCompare(b.skillId));
    return Object.freeze({
      version: 1 as const,
      skills: Object.freeze(skills.map(skill => structuredClone(skill))),
      loadContent: async (skillId: string) => {
        const entry = loadedBySkillId.get(skillId);
        if (!entry) throw new Error(`Unknown indexed Skill: ${skillId}`);
        const rawContent = await entry.adapter.loadContent({
          skillId: entry.skill.skillId,
          sourceId: entry.skill.sourceId,
          canonicalLocator: entry.skill.canonicalLocator,
        });
        return normalizeContentRecord(rawContent, entry.skill);
      },
    });
  }
}

function classifyPlatformSource(storage: PlatformAgentSkillProjectionInput["storage"], source: string | undefined): MissionSkillSourceKind {
  if (storage === "builtin") return "builtin";
  if (storage === "extension") return "extension";
  if (storage === "plugin") return "plugin";
  if (storage === "user") return "user";
  if (source && /(?:personal|user-data)$/i.test(source)) return "user";
  return "workspace";
}

function platformSourceId(
  kind: MissionSkillSourceKind,
  input: Pick<PlatformAgentSkillProjectionInput, "uri" | "storage" | "name" | "pluginUri" | "extensionId" | "source">,
): string {
  const skillIdentity = createHash("sha256").update(`${input.uri}\n${input.name}`).digest("hex").slice(0, 24);
  if (kind === "builtin") return `platform-prompts:builtin:${skillIdentity}`;
  if (kind === "extension") return `platform-extension:${input.extensionId}:${skillIdentity}`;
  if (kind === "plugin") return `platform-plugin:${createHash("sha256").update(input.pluginUri ?? "unknown").digest("hex").slice(0, 16)}:${skillIdentity}`;
  return `platform-prompts:${kind}:${input.source ?? input.storage}:${skillIdentity}`;
}

/**
 * Narrow projection of current Code-OSS IAgentSkill/PromptFileSource-shaped
 * observations. Discovery/provenance facts are preserved; this helper never
 * grants Nimora trust or capability authority.
 */
export function missionSkillObservationFromPlatformAgentSkill(
  inputValue: PlatformAgentSkillProjectionInput,
  routingValue: PlatformAgentSkillRoutingProjection = {},
): MissionSkillObservation {
  const input = ownRecord(inputValue, "Platform Agent Skill projection input");
  exactOwnDataKeys(input, [
    "uri", "storage", "name", "description", "enabled", "disableModelInvocation", "userInvocable", "pluginUri", "pluginLabel",
    "extensionId", "extensionDisplayName", "sessionTypes", "source", "sourceVersion", "observedContentDigest",
  ], "Platform Agent Skill projection input");
  const routing = ownRecord(routingValue, "Platform Agent Skill routing projection");
  exactOwnDataKeys(routing, ["eligibleMissionPlanes", "missionTypes", "relevanceTags", "requiredCapabilityIds"], "Platform Agent Skill routing projection");
  const storage = normalizeStorage(ownValue(input, "storage"), "Platform Agent Skill storage") as PlatformAgentSkillProjectionInput["storage"];
  const source = normalizePlatformSource(ownValue(input, "source"));
  const sourceKind = classifyPlatformSource(storage, source);
  const pluginUri = boundedString(ownValue(input, "pluginUri"), "Platform Agent Skill pluginUri", MAX_LOCATOR_CHARS, true);
  const extensionId = boundedString(ownValue(input, "extensionId"), "Platform Agent Skill extensionId", MAX_ID_CHARS, true);
  if (sourceKind === "plugin" && !pluginUri) throw new Error("Platform plugin Skill requires pluginUri provenance.");
  if (sourceKind === "extension" && !extensionId) throw new Error("Platform extension Skill requires extensionId provenance.");
  const sourceId = platformSourceId(sourceKind, {
    uri: String(ownValue(input, "uri")),
    storage,
    name: String(ownValue(input, "name")),
    ...(pluginUri === undefined ? {} : { pluginUri }),
    ...(extensionId === undefined ? {} : { extensionId }),
    ...(source === undefined ? {} : { source }),
  });
  const name = boundedString(ownValue(input, "name"), "Platform Agent Skill name", MAX_NAME_CHARS)!;
  const enabled = optionalBoolean(ownValue(input, "enabled"), "Platform Agent Skill enabled", true)!;
  const record: MissionSkillObservation = {
    sourceId,
    sourceKind,
    canonicalLocator: sanitizeLocator(ownValue(input, "uri"), "Platform Agent Skill uri"),
    skillId: boundedId(`${sourceId}:${name}`, "Platform Agent Skill derived skillId"),
    name,
    description: boundedString(ownValue(input, "description"), "Platform Agent Skill description", MAX_DESCRIPTION_CHARS, true),
    storage,
    ...(source === undefined ? {} : { platformSource: source }),
    enabled,
    disableModelInvocation: optionalBoolean(ownValue(input, "disableModelInvocation"), "Platform Agent Skill disableModelInvocation", true)!,
    userInvocable: optionalBoolean(ownValue(input, "userInvocable"), "Platform Agent Skill userInvocable", true)!,
    ...(pluginUri === undefined ? {} : { plugin: {
      uri: sanitizeLocator(pluginUri, "Platform Agent Skill plugin URI"),
      ...(boundedString(ownValue(input, "pluginLabel"), "Platform Agent Skill pluginLabel", MAX_NAME_CHARS, true) === undefined ? {} : { label: boundedString(ownValue(input, "pluginLabel"), "Platform Agent Skill pluginLabel", MAX_NAME_CHARS, true)! }),
    } }),
    ...(extensionId === undefined ? {} : { extension: {
      id: extensionId,
      ...(boundedString(ownValue(input, "extensionDisplayName"), "Platform Agent Skill extensionDisplayName", MAX_NAME_CHARS, true) === undefined ? {} : { displayName: boundedString(ownValue(input, "extensionDisplayName"), "Platform Agent Skill extensionDisplayName", MAX_NAME_CHARS, true)! }),
    } }),
    ...(denseStrings(ownValue(input, "sessionTypes"), "Platform Agent Skill sessionTypes") === undefined ? {} : { sessionTypes: denseStrings(ownValue(input, "sessionTypes"), "Platform Agent Skill sessionTypes")! }),
    ...(boundedString(ownValue(input, "sourceVersion"), "Platform Agent Skill sourceVersion", MAX_SOURCE_VERSION_CHARS, true) === undefined ? {} : { sourceVersion: boundedString(ownValue(input, "sourceVersion"), "Platform Agent Skill sourceVersion", MAX_SOURCE_VERSION_CHARS, true)! }),
    ...(normalizeDigest(ownValue(input, "observedContentDigest"), "Platform Agent Skill observedContentDigest") === undefined ? {} : { observedContentDigest: normalizeDigest(ownValue(input, "observedContentDigest"), "Platform Agent Skill observedContentDigest")! }),
    ...(densePlanes(ownValue(routing, "eligibleMissionPlanes"), "Platform Agent Skill eligibleMissionPlanes") === undefined ? {} : { eligibleMissionPlanes: densePlanes(ownValue(routing, "eligibleMissionPlanes"), "Platform Agent Skill eligibleMissionPlanes")! }),
    ...(denseStrings(ownValue(routing, "missionTypes"), "Platform Agent Skill missionTypes") === undefined ? {} : { missionTypes: denseStrings(ownValue(routing, "missionTypes"), "Platform Agent Skill missionTypes")! }),
    ...(denseStrings(ownValue(routing, "relevanceTags"), "Platform Agent Skill relevanceTags") === undefined ? {} : { relevanceTags: denseStrings(ownValue(routing, "relevanceTags"), "Platform Agent Skill relevanceTags")! }),
    ...(denseStrings(ownValue(routing, "requiredCapabilityIds"), "Platform Agent Skill requiredCapabilityIds") === undefined ? {} : { requiredCapabilityIds: denseStrings(ownValue(routing, "requiredCapabilityIds"), "Platform Agent Skill requiredCapabilityIds")! }),
  };
  return record;
}
