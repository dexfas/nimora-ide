import * as path from "node:path";
import type { WorkerOwnerProcessObservation } from "../../../src/project-formation-application-service.js";

interface WindowsProcessMetadataAddon {
  observeProcess(processId: number): { liveness?: unknown; creationTimeMs?: unknown };
}

let windowsAddon: WindowsProcessMetadataAddon | undefined;
let windowsAddonUnavailable = false;

function fallbackProcessLiveness(processId: number): WorkerOwnerProcessObservation {
  try {
    process.kill(processId, 0);
    return { liveness: "alive" };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code ?? "")
      : "";
    return { liveness: code === "ESRCH" ? "dead" : "unknown" };
  }
}

function loadWindowsAddon(): WindowsProcessMetadataAddon | undefined {
  if (windowsAddon) return windowsAddon;
  if (windowsAddonUnavailable) return undefined;
  try {
    const addonPath = path.join(__dirname, "..", "runtime", "bin", "shuncode_process_metadata.node");
    windowsAddon = require(addonPath) as WindowsProcessMetadataAddon;
    if (!windowsAddon || typeof windowsAddon.observeProcess !== "function") {
      windowsAddon = undefined;
      windowsAddonUnavailable = true;
    }
  } catch {
    windowsAddonUnavailable = true;
  }
  return windowsAddon;
}

/** Trusted host-only exact-PID observation. Alive PID generation is only
 * available on Windows through the fixed native GetProcessTimes helper.
 * Other platforms retain dead-PID proof and fail closed for alive PID reuse. */
export function observeTrustedHostProcess(processId: number): WorkerOwnerProcessObservation {
  if (!Number.isSafeInteger(processId) || processId <= 0 || processId > 0xFFFFFFFF) return { liveness: "unknown" };
  if (process.platform !== "win32") return fallbackProcessLiveness(processId);

  const addon = loadWindowsAddon();
  if (!addon) return fallbackProcessLiveness(processId);
  try {
    const raw = addon.observeProcess(processId);
    if (!raw || (raw.liveness !== "alive" && raw.liveness !== "dead" && raw.liveness !== "unknown")) return { liveness: "unknown" };
    if (raw.liveness !== "alive") return { liveness: raw.liveness };
    if (typeof raw.creationTimeMs !== "number" || !Number.isFinite(raw.creationTimeMs) || raw.creationTimeMs <= 0) return { liveness: "alive" };
    const startedAt = new Date(raw.creationTimeMs);
    return Number.isFinite(startedAt.getTime()) ? { liveness: "alive", startedAt } : { liveness: "alive" };
  } catch {
    return fallbackProcessLiveness(processId);
  }
}
