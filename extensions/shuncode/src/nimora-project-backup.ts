import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MissionCollaborationStore, MISSION_COLLABORATION_JOURNAL } from "../../../src/mission-collaboration-store.js";
import { ProjectStore, PROJECT_JOURNAL } from "../../../src/project-store.js";
import { TaskRuntime } from "../../../src/task-runtime.js";
import type { ProjectMissionPresentationOwners } from "../../../src/project-mission-presentation.js";

export interface NimoraProjectBackupFile {
  path: string;
  sha256: string;
  content: string;
}

export interface NimoraProjectBackupV1 {
  schema: "nimora-project-backup-v1";
  exportedAt: string;
  projectId: string;
  privacy: {
    containsProjectContent: true;
    containsTaskArgumentsAndResults: true;
    containsProviderTranscript: false;
    containsBrowserProfile: false;
    containsCredentials: false;
  };
  files: NimoraProjectBackupFile[];
}

const PROJECT_FILE = `project-store-v1/${PROJECT_JOURNAL}`;
const COLLAB_FILE = `mission-collaboration-v1/${MISSION_COLLABORATION_JOURNAL}`;
const TASK_PREFIX = "task-runtime-v1/";

function sha256(text: string): string {
  return "sha256:" + createHash("sha256").update(text, "utf8").digest("hex");
}

function safeTaskId(taskId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) throw new Error(`Unsafe task id in Project backup: ${taskId}`);
  return taskId;
}

function filterJsonl(raw: string, predicate: (row: any) => boolean): string {
  const rows = raw.split(/\r?\n/).filter(Boolean);
  const selected: string[] = [];
  for (const line of rows) {
    const row = JSON.parse(line);
    if (predicate(row)) selected.push(line);
  }
  return selected.length ? selected.join("\n") + "\n" : "";
}

async function readText(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function fileRecord(relativePath: string, content: string): NimoraProjectBackupFile {
  return { path: relativePath, sha256: sha256(content), content };
}

async function captureOnce(storageRoot: string, projectId: string, taskIds: readonly string[]): Promise<NimoraProjectBackupFile[]> {
  const projectRaw = await readText(path.join(storageRoot, PROJECT_FILE));
  const collaborationRaw = await readText(path.join(storageRoot, COLLAB_FILE));
  const files: NimoraProjectBackupFile[] = [
    fileRecord(PROJECT_FILE, filterJsonl(projectRaw, row => row?.projectId === projectId)),
    fileRecord(COLLAB_FILE, filterJsonl(collaborationRaw, row => row?.record?.projectId === projectId)),
  ];
  for (const taskId of [...taskIds].sort()) {
    const safeId = safeTaskId(taskId);
    const relative = `${TASK_PREFIX}${safeId}.jsonl`;
    files.push(fileRecord(relative, await readText(path.join(storageRoot, relative))));
  }
  return files;
}

function sameCapture(a: readonly NimoraProjectBackupFile[], b: readonly NimoraProjectBackupFile[]): boolean {
  return a.length === b.length && a.every((file, index) => file.path === b[index]?.path && file.sha256 === b[index]?.sha256);
}

export async function exportNimoraProjectBackup(
  storageRoot: string,
  owners: ProjectMissionPresentationOwners,
  projectId: string,
): Promise<NimoraProjectBackupV1> {
  const project = owners.projects.listProjects().find(row => row.projectId === projectId);
  if (!project) throw new Error("Project does not exist in the canonical ProjectStore.");
  const tasks = owners.tasks.listTasks().filter(task => task.mission?.projectId === projectId);
  if (tasks.length === 0) throw new Error("Project has no canonical Mission tasks to back up.");

  // Read the exact Project slice twice. Unrelated Projects may append to the
  // shared journals without invalidating this capture; only selected rows and
  // exact task files must remain identical.
  const first = await captureOnce(storageRoot, projectId, tasks.map(task => task.taskId));
  await new Promise(resolve => setTimeout(resolve, 25));
  const second = await captureOnce(storageRoot, projectId, tasks.map(task => task.taskId));
  if (!sameCapture(first, second)) {
    throw new Error("Project changed while the backup was being captured. No backup was produced; retry after the current turn settles.");
  }
  if (!second.find(file => file.path === PROJECT_FILE)?.content) {
    throw new Error("Project durable journal slice is empty; refusing to create a non-restorable backup.");
  }
  for (const task of tasks) {
    const relative = `${TASK_PREFIX}${safeTaskId(task.taskId)}.jsonl`;
    if (!second.find(file => file.path === relative)?.content) {
      throw new Error(`Mission journal is missing for ${task.taskId}; refusing an incomplete backup.`);
    }
  }
  return {
    schema: "nimora-project-backup-v1",
    exportedAt: new Date().toISOString(),
    projectId,
    privacy: {
      containsProjectContent: true,
      containsTaskArgumentsAndResults: true,
      containsProviderTranscript: false,
      containsBrowserProfile: false,
      containsCredentials: false,
    },
    files: second,
  };
}

function validateBackupShape(value: unknown): NimoraProjectBackupV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Backup must be a JSON object.");
  const backup = value as NimoraProjectBackupV1;
  if (backup.schema !== "nimora-project-backup-v1" || typeof backup.projectId !== "string" || !backup.projectId.trim() || !Array.isArray(backup.files)) {
    throw new Error("Unsupported or malformed Nimora Project backup.");
  }
  const paths = new Set<string>();
  for (const file of backup.files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string" || typeof file.sha256 !== "string") throw new Error("Malformed backup file entry.");
    const allowed = file.path === PROJECT_FILE || file.path === COLLAB_FILE || /^task-runtime-v1\/[A-Za-z0-9._-]+\.jsonl$/.test(file.path);
    if (!allowed || paths.has(file.path)) throw new Error(`Unsafe or duplicate backup path: ${file.path}`);
    paths.add(file.path);
    if (sha256(file.content) !== file.sha256) throw new Error(`Backup digest mismatch: ${file.path}`);
  }
  if (!paths.has(PROJECT_FILE) || !paths.has(COLLAB_FILE) || ![...paths].some(file => file.startsWith(TASK_PREFIX))) {
    throw new Error("Backup is missing Project, Mission or Collaboration journals.");
  }
  return backup;
}

async function materializeBackup(root: string, backup: NimoraProjectBackupV1): Promise<void> {
  for (const file of backup.files) {
    const target = path.join(root, file.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, file.content, "utf8");
  }
}

export async function verifyNimoraProjectBackup(value: unknown): Promise<NimoraProjectBackupV1> {
  const backup = validateBackupShape(value);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "nimora-backup-verify-"));
  try {
    await materializeBackup(temp, backup);
    const projects = new ProjectStore({ storageDirectory: path.join(temp, "project-store-v1") });
    const tasks = new TaskRuntime({ storageDirectory: path.join(temp, "task-runtime-v1") });
    const collaboration = new MissionCollaborationStore({
      storageDirectory: path.join(temp, "mission-collaboration-v1"),
      projects,
      tasks,
    });
    await Promise.all([projects.initialize(), tasks.initialize(), collaboration.initialize()]);
    const loadedProjects = projects.listProjects();
    if (loadedProjects.length !== 1 || loadedProjects[0]?.projectId !== backup.projectId) {
      throw new Error("Backup replay did not produce exactly the declared Project.");
    }
    const loadedTasks = tasks.listTasks();
    if (loadedTasks.length === 0 || loadedTasks.some(task => task.mission?.projectId !== backup.projectId)) {
      throw new Error("Backup contains missing or foreign Mission task state.");
    }
    collaboration.listExchanges(backup.projectId);
    collaboration.listRelations(backup.projectId);
    return backup;
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

export async function prepareNimoraProjectRestore(
  storageRoot: string,
  owners: ProjectMissionPresentationOwners,
  value: unknown,
): Promise<NimoraProjectBackupV1> {
  const backup = await verifyNimoraProjectBackup(value);
  if (owners.projects.listProjects().length !== 0 || owners.tasks.listTasks().length !== 0) {
    throw new Error("Project restore is allowed only in an empty Nimora profile. Existing Project/Task truth was not changed.");
  }
  const existingRoots = ["project-store-v1", "task-runtime-v1", "mission-collaboration-v1"];
  for (const relative of existingRoots) {
    const target = path.join(storageRoot, relative);
    const entries = await fs.readdir(target).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
      throw error;
    });
    if (entries.length) throw new Error(`Restore target is not empty: ${relative}. Nothing was overwritten.`);
  }
  await materializeBackup(storageRoot, backup);
  return backup;
}
