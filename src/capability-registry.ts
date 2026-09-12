export const NIMORA_CAPABILITY_META_KEY = "nimora/capability" as const;

export type CapabilityCategory = "workspace" | "terminal" | "diagnostics" | "browser" | "task" | "os" | string;
export type CapabilityEnvironment = "runtime" | "extension-host" | "gateway" | "personal-browser" | string;
export type CapabilityRisk = "read" | "write" | "execute" | "external-side-effect";
export type CapabilityIdempotency = "safe" | "idempotent" | "non-idempotent" | "unknown";
export type CapabilityRetry = "automatic" | "verify-before-retry" | "never";
export type CapabilityApproval = "none" | "task-grant" | "session" | "always";

/**
 * Stable semantic metadata for an executable Nimora capability.
 *
 * Tool schemas and implementations remain owned by their providers. This
 * registry intentionally describes policy/routing semantics only so transports
 * can expose the same capability without duplicating risk/retry decisions.
 */
export interface CapabilityMetadata {
  readonly id: string;
  readonly version: 1;
  readonly title: string;
  readonly category: CapabilityCategory;
  readonly tags: readonly string[];
  readonly environment: CapabilityEnvironment;
  readonly risk: CapabilityRisk;
  readonly idempotency: CapabilityIdempotency;
  readonly retry: CapabilityRetry;
  readonly approval: CapabilityApproval;
  /** Whether the capability can remove/overwrite user-visible state. */
  readonly destructive: boolean;
  /** Whether the capability can interact with resources outside the workspace/runtime boundary. */
  readonly openWorld: boolean;
}

type CapabilitySeed = Omit<CapabilityMetadata, "id" | "version">;

function capability(id: string, seed: CapabilitySeed): CapabilityMetadata {
  return Object.freeze({ id, version: 1 as const, ...seed, tags: Object.freeze([...seed.tags]) });
}

const readWorkspace = (id: string, title: string, tags: readonly string[] = []): CapabilityMetadata => capability(id, {
  title,
  category: "workspace",
  tags,
  environment: "runtime",
  risk: "read",
  idempotency: "safe",
  retry: "automatic",
  approval: "none",
  destructive: false,
  openWorld: false,
});

const readExtensionHost = (id: string, title: string, category: CapabilityCategory, tags: readonly string[] = []): CapabilityMetadata => capability(id, {
  title,
  category,
  tags,
  environment: "extension-host",
  risk: "read",
  idempotency: "safe",
  retry: "automatic",
  approval: "none",
  destructive: false,
  openWorld: false,
});

export const CAPABILITY_METADATA_BY_TOOL = Object.freeze({
  apply_patch: capability("workspace.apply-patch", {
    title: "Apply Workspace Patch",
    category: "workspace",
    tags: ["workspace", "edit", "patch"],
    environment: "runtime",
    risk: "write",
    idempotency: "non-idempotent",
    retry: "never",
    approval: "session",
    destructive: true,
    openWorld: false,
  }),
  find_files: readWorkspace("workspace.find-files", "Find Workspace Files", ["workspace", "files", "search"]),
  read_files: readWorkspace("workspace.read-files", "Read Workspace Files", ["workspace", "files", "read"]),
  search_files: readWorkspace("workspace.search-files", "Search Workspace Text", ["workspace", "files", "search"]),

  list_directory: readExtensionHost("workspace.list-directory", "List Workspace Directory", "workspace", ["workspace", "files", "read"]),
  run_command: capability("terminal.run-command", {
    title: "Run Command",
    category: "terminal",
    tags: ["terminal", "process", "execute"],
    environment: "extension-host",
    risk: "execute",
    idempotency: "non-idempotent",
    retry: "never",
    approval: "session",
    destructive: true,
    openWorld: true,
  }),
  get_command_output: readExtensionHost("terminal.get-command-output", "Read Command Output", "terminal", ["terminal", "read"]),
  send_command_input: capability("terminal.send-command-input", {
    title: "Send Command Input",
    category: "terminal",
    tags: ["terminal", "input", "execute"],
    environment: "extension-host",
    risk: "execute",
    idempotency: "non-idempotent",
    retry: "never",
    approval: "session",
    destructive: true,
    openWorld: true,
  }),
  wait: capability("terminal.wait", {
    title: "Wait",
    category: "terminal",
    tags: ["terminal", "pacing"],
    environment: "extension-host",
    risk: "read",
    idempotency: "safe",
    retry: "automatic",
    approval: "none",
    destructive: false,
    openWorld: false,
  }),
  get_diagnostics: readExtensionHost("diagnostics.read", "Read Diagnostics", "diagnostics", ["diagnostics", "read"]),
  lsp: readExtensionHost("diagnostics.lsp", "Language Service Navigation", "diagnostics", ["lsp", "symbols", "read"]),

  set_todos: capability("task.set-todos", {
    title: "Set Task Todos",
    category: "task",
    tags: ["task", "progress", "state"],
    environment: "extension-host",
    risk: "write",
    idempotency: "idempotent",
    retry: "verify-before-retry",
    approval: "none",
    destructive: false,
    openWorld: false,
  }),
  report_progress: capability("task.report-progress", {
    title: "Report Task Progress",
    category: "task",
    tags: ["task", "progress", "event"],
    environment: "extension-host",
    risk: "write",
    idempotency: "non-idempotent",
    retry: "never",
    approval: "none",
    destructive: false,
    openWorld: false,
  }),
} satisfies Record<string, CapabilityMetadata>);

export type RegisteredCapabilityToolName = keyof typeof CAPABILITY_METADATA_BY_TOOL;

export function getCapabilityMetadata(toolName: string): CapabilityMetadata | undefined {
  return (CAPABILITY_METADATA_BY_TOOL as Record<string, CapabilityMetadata>)[toolName];
}

export function requireCapabilityMetadata(toolName: string): CapabilityMetadata {
  const metadata = getCapabilityMetadata(toolName);
  if (!metadata) throw new Error(`Missing Nimora capability metadata for tool: ${toolName}`);
  return metadata;
}

/** Project semantic capability metadata into standard MCP hints plus namespaced metadata. */
export function capabilityMcpFields(toolName: string): {
  annotations: {
    title: string;
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  _meta: Record<string, CapabilityMetadata>;
} {
  const capability = requireCapabilityMetadata(toolName);
  return {
    annotations: {
      title: capability.title,
      readOnlyHint: capability.risk === "read",
      destructiveHint: capability.destructive,
      idempotentHint: capability.idempotency === "safe" || capability.idempotency === "idempotent",
      openWorldHint: capability.openWorld,
    },
    _meta: {
      [NIMORA_CAPABILITY_META_KEY]: capability,
    },
  };
}

export function capabilityRegistrySnapshot(): readonly CapabilityMetadata[] {
  return Object.freeze(Object.values(CAPABILITY_METADATA_BY_TOOL).sort((a, b) => a.id.localeCompare(b.id)));
}
