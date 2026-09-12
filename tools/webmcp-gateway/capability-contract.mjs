export const NIMORA_CAPABILITY_META_KEY = 'nimora/capability';

const VALID_RISK = new Set(['read', 'write', 'execute', 'external-side-effect']);
const VALID_IDEMPOTENCY = new Set(['safe', 'idempotent', 'non-idempotent', 'unknown']);
const VALID_RETRY = new Set(['automatic', 'verify-before-retry', 'never']);
const VALID_APPROVAL = new Set(['none', 'task-grant', 'session', 'always']);

export function defineGatewayCapability(tool, metadata) {
  if (!tool || typeof tool.name !== 'string' || !tool.name) throw new Error('Gateway capability tool requires a name');
  const capability = normalizeCapabilityMetadata(metadata, tool.name);
  return Object.freeze({
    ...tool,
    annotations: {
      ...(tool.annotations || {}),
      title: capability.title,
      readOnlyHint: capability.risk === 'read',
      destructiveHint: capability.destructive,
      idempotentHint: capability.idempotency === 'safe' || capability.idempotency === 'idempotent',
      openWorldHint: capability.openWorld,
    },
    _meta: {
      ...(tool._meta || {}),
      [NIMORA_CAPABILITY_META_KEY]: capability,
    },
  });
}

export function readCapabilityMetadata(tool) {
  const value = tool?._meta?.[NIMORA_CAPABILITY_META_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    return normalizeCapabilityMetadata(value, tool?.name || 'unknown');
  } catch {
    return undefined;
  }
}

export function retryPolicyForTool(tool) {
  const capability = readCapabilityMetadata(tool);
  if (capability) return capability.retry;
  if (tool?.annotations?.readOnlyHint === true && tool?.annotations?.idempotentHint === true) return 'automatic';
  return undefined;
}

export function isAutomaticallyRetryableTool(tool) {
  return retryPolicyForTool(tool) === 'automatic';
}

function normalizeCapabilityMetadata(value, fallbackId) {
  const metadata = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const id = String(metadata.id || fallbackId || '').trim();
  const title = String(metadata.title || id).trim();
  const category = String(metadata.category || '').trim();
  const environment = String(metadata.environment || '').trim();
  const risk = String(metadata.risk || '').trim();
  const idempotency = String(metadata.idempotency || '').trim();
  const retry = String(metadata.retry || '').trim();
  const approval = String(metadata.approval || '').trim();
  if (!id || !title || !category || !environment) throw new Error('Incomplete capability metadata');
  if (Number(metadata.version) !== 1) throw new Error(`Unsupported capability metadata version for ${id}`);
  if (!VALID_RISK.has(risk)) throw new Error(`Invalid risk metadata for ${id}`);
  if (!VALID_IDEMPOTENCY.has(idempotency)) throw new Error(`Invalid idempotency metadata for ${id}`);
  if (!VALID_RETRY.has(retry)) throw new Error(`Invalid retry metadata for ${id}`);
  if (!VALID_APPROVAL.has(approval)) throw new Error(`Invalid approval metadata for ${id}`);
  return Object.freeze({
    id,
    version: 1,
    title,
    category,
    tags: Object.freeze(Array.isArray(metadata.tags) ? metadata.tags.map(String) : []),
    environment,
    risk,
    idempotency,
    retry,
    approval,
    destructive: metadata.destructive === true,
    openWorld: metadata.openWorld === true,
  });
}
