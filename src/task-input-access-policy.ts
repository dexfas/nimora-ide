import { promises as fs } from "node:fs";
import path from "node:path";
import type { HostCapabilityExecutionRequest } from "./host-capability-execution-coordinator.js";
import type { TaskRuntime } from "./task-runtime.js";

function normalizedRelative(root: string, absolutePath: string): string | undefined {
  const relative = path.relative(root, absolutePath);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return undefined;
  const slash = relative.replace(/\\/g, "/");
  return slash || ".";
}

function matchesPrefix(relativePath: string, prefix: string): boolean {
  if (prefix === ".") return true;
  const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const relative = fold(relativePath);
  const expected = fold(prefix);
  return relative === expected || relative.startsWith(expected + "/");
}

/**
 * Canonicalize a path even when its final component does not exist yet. Resolve
 * the nearest existing ancestor first so an existing symlink/junction in a
 * parent cannot make a lexically in-workspace create/write escape the durable
 * Work Order prefix.
 */
async function resolveThroughExistingAncestor(absolutePath: string): Promise<string> {
  let cursor = path.resolve(absolutePath);
  const missing: string[] = [];
  for (;;) {
    try {
      const existing = await fs.realpath(cursor);
      return path.resolve(existing, ...missing);
    } catch {
      const parent = path.dirname(cursor);
      if (parent === cursor) return path.resolve(absolutePath);
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

function requireInputPolicy(tasks: TaskRuntime, request: HostCapabilityExecutionRequest) {
  if (!request.taskId) throw new Error("Exact Work Order path policy requires taskId.");
  const task = tasks.getTask(request.taskId);
  const policy = task?.inputAccessPolicies[request.inputId];
  if (!task || !policy || policy.managedSessionId !== request.managedSessionId) {
    throw new Error("Exact Work Order path policy is missing or stale.");
  }
  const worker = task.workerSessions[request.managedSessionId];
  if (!worker || worker.detachedAt || worker.retiredAt || worker.workerId !== request.workerId) {
    throw new Error("Exact Work Order path policy does not belong to the active WorkerSession.");
  }
  return { task, policy };
}

/**
 * Exact durable policy check for one Worker input. Missing policy, stale
 * WorkerSession identity, or a path outside the declared prefixes fails closed.
 */
export async function isTaskInputAbsolutePathAllowed(
  tasks: TaskRuntime,
  request: HostCapabilityExecutionRequest,
  absolutePath: string,
  workspaceRoots: readonly string[],
): Promise<boolean> {
  let policy: ReturnType<typeof requireInputPolicy>["policy"];
  try {
    ({ policy } = requireInputPolicy(tasks, request));
  } catch {
    return false;
  }

  const target = await resolveThroughExistingAncestor(absolutePath);
  for (const workspaceRoot of workspaceRoots) {
    const root = await resolveThroughExistingAncestor(workspaceRoot);
    const relative = normalizedRelative(root, target);
    if (relative !== undefined && policy.allowedWorkspacePathPrefixes.some(prefix => matchesPrefix(relative, prefix))) {
      return true;
    }
  }
  return false;
}

/**
 * Resolve the exact durable workspace prefixes for one active Worker input into
 * host filesystem roots suitable for an OS sandbox. Existing symlinks are
 * realpathed before admission so a prefix cannot escape through a link.
 */
export async function resolveTaskInputWorkspaceAccessRoots(
  tasks: TaskRuntime,
  request: HostCapabilityExecutionRequest,
  workspaceRoots: readonly string[],
): Promise<string[]> {
  const { policy } = requireInputPolicy(tasks, request);
  if (workspaceRoots.length !== 1) throw new Error("Exact Work Order path policy requires exactly one workspace root.");
  const resolved: string[] = [];
  for (const workspaceRoot of workspaceRoots) {
    const root = await resolveThroughExistingAncestor(workspaceRoot);
    for (const prefix of policy.allowedWorkspacePathPrefixes) {
      const candidate = prefix === "." ? root : path.resolve(root, ...prefix.split("/"));
      const target = await resolveThroughExistingAncestor(candidate);
      const relative = normalizedRelative(root, target);
      if (relative === undefined || !matchesPrefix(relative, prefix)) continue;
      resolved.push(target);
    }
  }
  const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  const unique = [...new Map(resolved.map(value => [key(value), value])).values()];
  if (!unique.length) throw new Error("Exact Work Order path policy resolved to no safe filesystem roots.");
  return unique;
}
