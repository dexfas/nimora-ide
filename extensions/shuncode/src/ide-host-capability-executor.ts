import path from "node:path";
import type { CapabilityMetadata } from "../../../src/capability-registry.js";
import type {
  HostCapabilityExecutionRequest,
  HostCapabilityExecutorResult,
} from "../../../src/host-capability-execution-coordinator.js";
import type { RoutableHostCapabilityExecutor } from "../../../src/host-capability-executor-router.js";
import { getIdeToolDefinition } from "../../../src/ide-tool-definitions.js";
import { isTaskInputAbsolutePathAllowed, resolveTaskInputWorkspaceAccessRoots } from "../../../src/task-input-access-policy.js";
import type { TaskRuntime } from "../../../src/task-runtime.js";
import { STRICT_TERMINAL_SANDBOX_INPUT } from "./strict-terminal-sandbox-contract.js";

export interface DirectIdeToolBroker {
  invokeDirect(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

export interface IdeToolBrokerHostCapabilityExecutorOptions {
  tasks?: TaskRuntime;
  workspaceRoots?: () => readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Read only the host envelope; command stdout must never forge settlement. */
function commandSettlement(name: string, text: string): { status: string; exitCode: number | null } | undefined {
  const marker = name === "run_command" ? "RUN_COMMAND" : name === "get_command_output" ? "COMMAND_OUTPUT" : undefined;
  if (!marker || !text.startsWith(`=== ${marker} BEGIN ===`)) return undefined;
  const outputStart = text.indexOf("\n--- OUTPUT BEGIN ---");
  if (outputStart < 0) return undefined;
  const header = text.slice(0, outputStart).replace(/\r/g, "");
  const statuses = [...header.matchAll(/^status: (running|completed|failed|killed)$/gm)];
  const exits = [...header.matchAll(/^exit_code: (null|-?\d+)$/gm)];
  if (statuses.length !== 1 || exits.length !== 1) return undefined;
  const exitCode = exits[0][1] === "null" ? null : Number(exits[0][1]);
  if (exitCode !== null && !Number.isSafeInteger(exitCode)) return undefined;
  return { status: statuses[0][1], exitCode };
}

/** Host executor backed by the same IdeToolBroker providers used by Chat/Bridge. */
export class IdeToolBrokerHostCapabilityExecutor implements RoutableHostCapabilityExecutor {
  constructor(private readonly broker: DirectIdeToolBroker, private readonly options: IdeToolBrokerHostCapabilityExecutorOptions = {}) {}

  supports(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): boolean {
    return capability.environment === "extension-host" && !!getIdeToolDefinition(request.name);
  }

  async execute(request: HostCapabilityExecutionRequest, capability: CapabilityMetadata): Promise<HostCapabilityExecutorResult> {
    if (!this.supports(request, capability)) throw new Error(`Capability ${request.name} is not owned by IdeToolBroker.`);
    const args = asRecord(request.arguments);
    await this.assertWorkspaceReadPolicy(request, capability, args);
    if (request.name === "run_command") {
      if (!this.options.tasks || !this.options.workspaceRoots) {
        throw new Error("Host-managed run_command requires exact durable Work Order path policy.");
      }
      const roots = [...this.options.workspaceRoots()].filter(Boolean);
      const writeRoots = await resolveTaskInputWorkspaceAccessRoots(this.options.tasks, request, roots);
      Object.defineProperty(args, STRICT_TERMINAL_SANDBOX_INPUT, {
        value: { writeRoots },
        configurable: false,
        enumerable: false,
        writable: false,
      });
    }
    const result = await this.broker.invokeDirect(request.name, args);
    const settlement = commandSettlement(request.name, result.text);
    if (!settlement) return result;
    return {
      ...result,
      isError: result.isError || settlement.status === "failed" || settlement.status === "killed"
        || (settlement.exitCode !== null && settlement.exitCode !== 0),
      data: { commandStatus: settlement.status, exitCode: settlement.exitCode },
    };
  }

  private async assertWorkspaceReadPolicy(
    request: HostCapabilityExecutionRequest,
    capability: CapabilityMetadata,
    args: Record<string, unknown>,
  ): Promise<void> {
    if (capability.category !== "workspace" && request.name !== "get_diagnostics" && request.name !== "lsp") return;
    if (!this.options.tasks || !this.options.workspaceRoots) return;
    const roots = [...this.options.workspaceRoots()].filter(Boolean);
    if (!roots.length) throw new Error(`Capability ${request.name} requires an open workspace root.`);
    const rawPath = typeof args.path === "string" && args.path.trim() ? args.path.trim() : ".";
    let target: string | undefined;
    if (path.isAbsolute(rawPath)) {
      target = rawPath;
    } else {
      for (const root of roots) {
        const candidate = path.resolve(root, rawPath);
        if (await isTaskInputAbsolutePathAllowed(this.options.tasks, request, candidate, roots)) {
          target = candidate;
          break;
        }
      }
    }
    if (!target || !(await isTaskInputAbsolutePathAllowed(this.options.tasks, request, target, roots))) {
      throw new Error(`Capability ${request.name} attempted workspace access outside the exact Work Order path policy.`);
    }
  }
}
