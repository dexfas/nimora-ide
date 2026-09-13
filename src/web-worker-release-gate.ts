import type { WorkerInput } from "./worker-contract.js";

export interface WebWorkerReleaseGateState {
  configured: boolean;
  workspaceTrusted: boolean;
  effective: boolean;
  ownership: "host-managed" | "page-local";
  reason?: "disabled" | "untrusted-workspace";
}

export function resolveWebWorkerReleaseGate(configured: boolean, workspaceTrusted: boolean): WebWorkerReleaseGateState {
  if (!configured) {
    return { configured: false, workspaceTrusted, effective: false, ownership: "page-local", reason: "disabled" };
  }
  if (!workspaceTrusted) {
    return { configured: true, workspaceTrusted: false, effective: false, ownership: "page-local", reason: "untrusted-workspace" };
  }
  return { configured: true, workspaceTrusted: true, effective: true, ownership: "host-managed" };
}

/** The release gate is authoritative; caller-provided ownership flags cannot bypass it. */
export function applyWebWorkerReleaseGate(input: WorkerInput, state: WebWorkerReleaseGateState): WorkerInput {
  return {
    ...input,
    extensions: {
      ...(input.extensions ?? {}),
      hostManagedCapabilities: state.effective,
      releaseGate: {
        configured: state.configured,
        workspaceTrusted: state.workspaceTrusted,
        ownership: state.ownership,
      },
    },
  };
}
