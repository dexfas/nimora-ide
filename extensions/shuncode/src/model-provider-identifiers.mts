export const MODEL_ID_SEPARATOR = "::";

export function encodedModelId(namespace: string, rawModelId: string): string {
  return `${namespace.replaceAll(MODEL_ID_SEPARATOR, "-")}${MODEL_ID_SEPARATOR}${encodeURIComponent(rawModelId)}`;
}

/**
 * Normalizes a model identifier coming from a Chat request back to the bare
 * ShunCode model id stored in the provider's runtime model cache.
 */
export function normalizeProviderModelId(modelId: string, vendorId: string): string {
  let id = modelId;
  const vendorPrefix = `${vendorId}/`;
  if (id.startsWith(vendorPrefix)) {
    id = id.slice(vendorPrefix.length);
  }
  const slash = id.indexOf("/");
  if (slash > 0) {
    const rest = id.slice(slash + 1);
    if (rest.includes(MODEL_ID_SEPARATOR)) {
      id = rest;
    }
  }
  return id;
}

export function deleteRuntimeModelsForNamespace<T>(runtimeModels: Map<string, T>, namespace: string): void {
  const prefix = encodedModelId(namespace, "");
  for (const id of [...runtimeModels.keys()]) {
    if (id.startsWith(prefix)) runtimeModels.delete(id);
  }
}
