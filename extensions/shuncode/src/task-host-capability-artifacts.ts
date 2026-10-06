import type { HostCapabilityArtifactProjector } from "../../../src/task-host-capability-execution-store.js";
import { taskChangesetArtifact } from "./task-changeset-artifacts.js";
import { taskDiagnosticsArtifact, taskDirectoryArtifact, taskFileNavigationArtifact, taskLspArtifact } from "./task-file-artifacts.js";
import { taskTerminalArtifact } from "./task-terminal-artifacts.js";

/** Mission execution uses its existing Task and execution identity, never a shadow Task. */
export const projectHostCapabilityArtifacts: HostCapabilityArtifactProjector = (request, result) => {
  if (result.isError) return [];
  const resultText = result.text ?? "";
  const artifact = request.name === "apply_patch" ? taskChangesetArtifact(result.data)
    : request.name === "get_diagnostics" ? taskDiagnosticsArtifact(request.arguments, resultText)
    : request.name === "list_directory" ? taskDirectoryArtifact(request.arguments, resultText)
    : request.name === "lsp" ? taskLspArtifact(request.arguments, resultText)
    : request.name === "run_command" || request.name === "get_command_output" || request.name === "send_command_input"
      ? taskTerminalArtifact(request.name, request.arguments, resultText)
      : taskFileNavigationArtifact(request.name, result.data);
  return artifact ? [artifact] : [];
};
