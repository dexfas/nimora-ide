import * as vscode from "vscode";

/**
 * Metadata attached to a chat response that participates in a multi-model
 * branch group. Each branch answer and the merge summary carry this block
 * under result.metadata, keyed by SHUNCODE_BRANCH_GROUP_METADATA_KEY.
 */
export const SHUNCODE_BRANCH_GROUP_METADATA_KEY = "shuncodeBranchGroup";

export interface ShunCodeBranchGroupMetadata {
  groupId: string;
  variantId: string;
  kind: "branch" | "merge";
}

export interface ShunCodeBranchGroupState {
  canonicalVariantId?: string;
  mergedVariantId?: string;
  adoptedVariantId?: string;
  activeVariantId?: string;
}

export function branchGroupMetadata(metadata: unknown): ShunCodeBranchGroupMetadata | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const row = (metadata as Record<string, unknown>)[SHUNCODE_BRANCH_GROUP_METADATA_KEY];
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  const group = row as Record<string, unknown>;
  if (typeof group.groupId !== "string" || typeof group.variantId !== "string") return undefined;
  if (group.kind !== "branch" && group.kind !== "merge") return undefined;
  return { groupId: group.groupId, variantId: group.variantId, kind: group.kind };
}

/**
 * Durable per-group state for multi-model branch rounds. Canonical variant
 * (the only variant that continues into later context) and merge bookkeeping
 * live here so they survive reloads and are shared by the chat handler.
 */
export class BranchStateStore implements vscode.Disposable {
  private state: Record<string, ShunCodeBranchGroupState> = {};
  private loaded = false;
  private saveChain: Promise<void> = Promise.resolve();
  private readonly file: vscode.Uri;

  constructor(
    context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {
    this.file = vscode.Uri.joinPath(context.globalStorageUri, "shuncode-branch-state.json");
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await vscode.workspace.fs.readFile(this.file);
      const parsed: unknown = JSON.parse(Buffer.from(raw).toString("utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        this.state = parsed as Record<string, ShunCodeBranchGroupState>;
      }
    } catch {
      // Missing or corrupt file: start with empty state.
    }
    this.loaded = true;
  }

  getState(groupId: string): ShunCodeBranchGroupState {
    return this.state[groupId] ?? {};
  }

  setCanonical(groupId: string, variantId: string): void {
    const current = this.getState(groupId);
    if (current.canonicalVariantId === variantId) return;
    this.state[groupId] = { ...current, canonicalVariantId: variantId };
    this.queueSave(groupId, variantId);
  }

  setMerged(groupId: string, variantId: string): void {
    const current = this.getState(groupId);
    if (current.mergedVariantId === variantId && current.canonicalVariantId === variantId) return;
    this.state[groupId] = { ...current, mergedVariantId: variantId, canonicalVariantId: variantId };
    this.queueSave(groupId, variantId);
  }

  /**
   * Records which variant the user is currently viewing in the branch
   * container, so a reload restores the same variant.
   */
  setActiveVariant(groupId: string, variantId: string): void {
    const current = this.getState(groupId);
    if (current.activeVariantId === variantId) return;
    this.state[groupId] = { ...current, activeVariantId: variantId };
    this.queueSave(groupId, variantId);
  }

  /**
   * Records an explicit user adoption. Adoption both selects the canonical
   * variant and closes the round, so later branch sends open a new group.
   */
  adopt(groupId: string, variantId: string): void {
    const current = this.getState(groupId);
    if (current.canonicalVariantId === variantId && current.adoptedVariantId === variantId) return;
    this.state[groupId] = { ...current, canonicalVariantId: variantId, adoptedVariantId: variantId };
    this.queueSave(groupId, variantId);
  }

  private queueSave(groupId: string, variantId: string): void {
    this.saveChain = this.saveChain.then(async () => {
      try {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.file, ".."));
        const payload = JSON.stringify(this.state, null, 2);
        await vscode.workspace.fs.writeFile(this.file, Buffer.from(payload, "utf8"));
        this.output.appendLine(`[branch-state] saved group=${groupId} variant=${variantId}`);
      } catch (error) {
        this.output.appendLine(`[branch-state] failed to save ${groupId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  dispose(): void {
    // Nothing to release; saves are queued promises.
  }
}
