import * as vscode from "vscode";
import type { RuntimeAgentCheckpoint } from "./runtime-client.js";

const CHECKPOINT_INDEX_KEY = "shuncode.agentCheckpoints.v1";
const CHECKPOINT_DIRECTORY = "agent-checkpoints";
const MAX_CHECKPOINTS = 8;
const MAX_CHECKPOINT_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;

export const SHUNCODE_CHECKPOINT_ID_METADATA_KEY = "agentCheckpointId";
export const SHUNCODE_CHECKPOINT_RECOVERABLE_METADATA_KEY = "agentCheckpointRecoverable";
export const SHUNCODE_CHECKPOINT_REASON_METADATA_KEY = "agentCheckpointReason";

interface CheckpointIndexEntry {
  id: string;
  model: string;
  workspaceRoot: string;
  savedAt: number;
}

interface PersistedCheckpointEnvelope extends CheckpointIndexEntry {
  version: 1;
  checkpoint: RuntimeAgentCheckpoint;
}

export interface LoadedAgentCheckpoint {
  id: string;
  checkpoint: RuntimeAgentCheckpoint;
}

function validId(id: string): boolean {
  return /^[A-Za-z0-9_-]{8,128}$/.test(id);
}

function asIndex(value: unknown): CheckpointIndexEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is CheckpointIndexEntry => Boolean(
    entry
    && typeof entry === "object"
    && !Array.isArray(entry)
    && typeof (entry as CheckpointIndexEntry).id === "string"
    && validId((entry as CheckpointIndexEntry).id)
    && typeof (entry as CheckpointIndexEntry).model === "string"
    && typeof (entry as CheckpointIndexEntry).workspaceRoot === "string"
    && typeof (entry as CheckpointIndexEntry).savedAt === "number",
  ));
}

function validCheckpoint(value: unknown): value is RuntimeAgentCheckpoint {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as RuntimeAgentCheckpoint;
  return row.version === 1
    && typeof row.model === "string"
    && typeof row.workspaceRoot === "string"
    && Number.isInteger(row.nextStep)
    && row.nextStep >= 1
    && Array.isArray(row.toolNames)
    && row.toolNames.every(name => typeof name === "string")
    && Array.isArray(row.messages)
    && row.messages.every(message => Boolean(message) && typeof message === "object" && !Array.isArray(message))
    && typeof row.createdAt === "string";
}

export class AgentCheckpointStore {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  async save(id: string, checkpoint: RuntimeAgentCheckpoint): Promise<void> {
    if (!validId(id) || !validCheckpoint(checkpoint)) throw new Error("Invalid ShunCode agent checkpoint.");
    const savedAt = Date.now();
    const envelope: PersistedCheckpointEnvelope = {
      version: 1,
      id,
      model: checkpoint.model,
      workspaceRoot: checkpoint.workspaceRoot,
      savedAt,
      checkpoint,
    };
    const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
    if (bytes.byteLength > MAX_CHECKPOINT_BYTES) {
      throw new Error(`Agent checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes.`);
    }

    const directory = vscode.Uri.joinPath(this.context.globalStorageUri, CHECKPOINT_DIRECTORY);
    const target = vscode.Uri.joinPath(directory, `${id}.json`);
    const temporary = vscode.Uri.joinPath(directory, `${id}.${process.pid}.tmp`);
    await vscode.workspace.fs.createDirectory(directory);
    try {
      await vscode.workspace.fs.writeFile(temporary, bytes);
      await vscode.workspace.fs.rename(temporary, target, { overwrite: true });
    } catch (error) {
      try { await vscode.workspace.fs.delete(temporary); } catch {}
      throw error;
    }

    const cutoff = savedAt - MAX_CHECKPOINT_AGE_MS;
    const current = asIndex(this.context.workspaceState.get(CHECKPOINT_INDEX_KEY));
    const expired = current.filter(entry => entry.id !== id && entry.savedAt < cutoff);
    const ordered = [
      { id, model: checkpoint.model, workspaceRoot: checkpoint.workspaceRoot, savedAt },
      ...current.filter(entry => entry.id !== id && entry.savedAt >= cutoff),
    ].sort((a, b) => b.savedAt - a.savedAt);
    const retained = ordered.slice(0, MAX_CHECKPOINTS);
    await this.context.workspaceState.update(CHECKPOINT_INDEX_KEY, retained);
    for (const stale of [...expired, ...ordered.slice(MAX_CHECKPOINTS)]) {
      await this.deleteFile(stale.id);
    }
  }

  async load(id: string, model: string, workspaceRoot: string): Promise<LoadedAgentCheckpoint | undefined> {
    if (!validId(id)) return undefined;
    const envelope = await this.readEnvelope(id);
    if (!envelope || envelope.model !== model || envelope.workspaceRoot !== workspaceRoot) return undefined;
    if (Date.now() - envelope.savedAt > MAX_CHECKPOINT_AGE_MS) {
      await this.delete(id);
      return undefined;
    }
    return { id, checkpoint: envelope.checkpoint };
  }

  async delete(id: string): Promise<void> {
    if (!validId(id)) return;
    await this.deleteFile(id);
    const current = asIndex(this.context.workspaceState.get(CHECKPOINT_INDEX_KEY));
    const next = current.filter(entry => entry.id !== id);
    if (next.length !== current.length) {
      try {
        await this.context.workspaceState.update(CHECKPOINT_INDEX_KEY, next);
      } catch (error) {
        this.output.appendLine(`[checkpoint] failed to update index after deleting ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async readEnvelope(id: string): Promise<PersistedCheckpointEnvelope | undefined> {
    try {
      const uri = vscode.Uri.joinPath(this.context.globalStorageUri, CHECKPOINT_DIRECTORY, `${id}.json`);
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > MAX_CHECKPOINT_BYTES) return undefined;
      const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      const row = value as PersistedCheckpointEnvelope;
      if (row.version !== 1 || row.id !== id || !validCheckpoint(row.checkpoint)) return undefined;
      if (typeof row.model !== "string" || typeof row.workspaceRoot !== "string" || typeof row.savedAt !== "number") return undefined;
      return row;
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return undefined;
      this.output.appendLine(`[checkpoint] failed to read ${id}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  private async deleteFile(id: string): Promise<void> {
    try {
      const uri = vscode.Uri.joinPath(this.context.globalStorageUri, CHECKPOINT_DIRECTORY, `${id}.json`);
      await vscode.workspace.fs.delete(uri);
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return;
      this.output.appendLine(`[checkpoint] failed to delete ${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
