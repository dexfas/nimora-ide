import type { WorkerAssignmentCandidate, WorkerAssignmentCapabilityKey } from "./worker-assignment.js";

type UnknownRecord = Record<string, unknown>;

/** Backend evidence from a healthy owned planner; never an assignable page. */
export interface WebPlanningBackendObservation {
  provider: string;
  kind: "web" | "api";
  models: readonly string[];
  capabilities: WorkerAssignmentCandidate["capabilities"];
  status: "healthy" | "degraded" | "offline";
  checkedAt: string;
  basis: "owned-tools-free-planner";
}

const CAPABILITY_KEYS = new Set<WorkerAssignmentCapabilityKey>([
  "streaming", "reasoning", "capabilityRequests", "imageInput",
  "checkpoints", "interruption", "persistentContext",
]);

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as UnknownRecord;
}

function requiredModel(constraints: UnknownRecord, label: string): string | undefined {
  const value = constraints.requiredModel;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}.requiredModel must be a non-empty string.`);
  return value.trim();
}

function requiredCapabilities(constraints: UnknownRecord, label: string): Partial<Record<WorkerAssignmentCapabilityKey, boolean>> {
  const value = constraints.requiredCapabilities;
  if (value === undefined) return {};
  const row = record(value, `${label}.requiredCapabilities`);
  const out: Partial<Record<WorkerAssignmentCapabilityKey, boolean>> = {};
  for (const [key, expected] of Object.entries(row)) {
    if (!CAPABILITY_KEYS.has(key as WorkerAssignmentCapabilityKey) || typeof expected !== "boolean") {
      throw new Error(`${label}.requiredCapabilities contains an invalid requirement: ${key}.`);
    }
    out[key as WorkerAssignmentCapabilityKey] = expected;
  }
  return out;
}

function candidateSatisfies(
  candidate: WorkerAssignmentCandidate,
  provider: string,
  model: string | undefined,
  capabilities: Partial<Record<WorkerAssignmentCapabilityKey, boolean>>,
): boolean {
  if (candidate.provider !== provider || candidate.kind !== "web" || candidate.availability !== "available") return false;
  if (model && !candidate.models.includes(model)) return false;
  for (const [key, expected] of Object.entries(capabilities)) {
    if (candidate.capabilities[key as WorkerAssignmentCapabilityKey] !== expected) return false;
  }
  return true;
}

function backendSatisfies(observation: WebPlanningBackendObservation | undefined, provider: string,
  model: string | undefined, capabilities: Partial<Record<WorkerAssignmentCapabilityKey, boolean>>): boolean {
  return !!observation && observation.basis === "owned-tools-free-planner" && observation.status === "healthy"
    && observation.kind === "web" && observation.provider === provider
    && (!model || observation.models.includes(model))
    && Object.entries(capabilities).every(([key, expected]) => observation.capabilities[key as WorkerAssignmentCapabilityKey] === expected);
}

export function bindHumanSelectedWebProvider(
  value: unknown,
  candidates: readonly WorkerAssignmentCandidate[],
  provider: string,
  selectedBackend?: WebPlanningBackendObservation,
): void {
  const row = record(value, "Web Formation");
  const normalizedProvider = provider.trim();
  if (!normalizedProvider) throw new Error("Selected Web provider is empty.");

  for (const key of ["coordinatorPolicy", "workerPolicy"] as const) {
    const policy = record(row[key], `Web Formation ${key}`);
    const constraints = policy.constraints === undefined ? {} : record(policy.constraints, `Web Formation ${key}.constraints`);
    const preferences = policy.preferences === undefined ? {} : record(policy.preferences, `Web Formation ${key}.preferences`);
    const model = requiredModel(constraints, `Web Formation ${key}.constraints`);
    const capabilities = requiredCapabilities(constraints, `Web Formation ${key}.constraints`);
    const hardRequirements = [
      model ? `requiredModel=${model}` : undefined,
      ...Object.entries(capabilities).map(([capability, expected]) => `${capability}=${String(expected)}`),
    ].filter((item): item is string => !!item);

    // Candidate observations are advisory/preflight data at Formation time and
    // may legitimately be empty before the Product opens the actual Mission
    // pages. Absence of an observation is only blocking when Cognition emitted
    // a genuine model/capability requirement that needs proof before birth.
    if (hardRequirements.length > 0
      && !candidates.some(candidate => candidateSatisfies(candidate, normalizedProvider, model, capabilities))
      && !backendSatisfies(selectedBackend, normalizedProvider, model, capabilities)) {
      throw new Error(
        `Selected ${normalizedProvider} Web Worker cannot prove the hard ${key} requirements before Project birth: ${hardRequirements.join(", ")}.`,
      );
    }

    const forbidden = Array.isArray(constraints.forbiddenProviders)
      ? constraints.forbiddenProviders.filter(item => typeof item === "string" && item !== normalizedProvider)
      : [];
    policy.constraints = {
      ...constraints,
      allowedKinds: ["web"],
      allowedProviders: [normalizedProvider],
      forbiddenProviders: forbidden,
    };
    policy.preferences = {
      ...preferences,
      providerOrder: [normalizedProvider],
    };
  }
}
