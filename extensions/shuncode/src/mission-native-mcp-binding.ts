import { randomUUID } from "node:crypto";
import { capabilityMcpFields, requireCapabilityMetadata } from "../../../src/capability-registry.js";
import { HostCapabilityAuthorizationError } from "../../../src/host-capability-policy-authorizer.js";
import type { HostCapabilityExecutionRequest } from "../../../src/host-capability-execution-coordinator.js";
import {
  canonicalizeWorkerCapabilityDefinition,
  type MissionCapabilityMaterializationResult,
} from "../../../src/mission-capability-materializer.js";
import type { MissionCapabilitySchemaSource } from "../../../src/mission-capability-schema-source.js";
import { taskArgumentsDigest, type TaskRuntime } from "../../../src/task-runtime.js";
import type { WorkerCapabilityDefinition, WorkerCapabilityResultInput } from "../../../src/worker-contract.js";
import type { WorkerSessionManager } from "../../../src/worker-session-manager.js";
import type { HostCapabilityExecutionService } from "./host-capability-execution-service.js";

export interface MissionNativeMcpBindingDescriptor {
  token: string;
  projectId: string;
  rootMissionId: string;
  missionId: string;
  managedSessionId: string;
  workerId: string;
  adapterSessionId: string;
  activeInputId?: string;
  advertisedCapabilities: string[];
  allowedCapabilities: string[];
}

interface ActiveBindingTurn {
  inputId: string;
  definitions: Map<string, WorkerCapabilityDefinition>;
  abort: AbortController;
  retryNeverOccurrences: Map<string, string>;
  rejectedOccurrences: Set<string>;
}

export interface MissionNativeMcpToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

/** The HTTP transport observes submission; this is not provider receipt. */
export type MissionNativeMcpSubmissionObserver = (
  result: MissionNativeMcpToolResult,
  confirmSubmission: () => Promise<void>,
) => void;

interface MissionNativeMcpBindingRecord {
  token: string;
  projectId: string;
  rootMissionId: string;
  missionId: string;
  managedSessionId: string;
  workerId: string;
  adapterSessionId: string;
  advertisedDefinitions: Map<string, WorkerCapabilityDefinition>;
  activeTurn?: ActiveBindingTurn;
}

function publicBinding(binding: MissionNativeMcpBindingRecord): MissionNativeMcpBindingDescriptor {
  return {
    token: binding.token,
    projectId: binding.projectId,
    rootMissionId: binding.rootMissionId,
    missionId: binding.missionId,
    managedSessionId: binding.managedSessionId,
    workerId: binding.workerId,
    adapterSessionId: binding.adapterSessionId,
    activeInputId: binding.activeTurn?.inputId,
    advertisedCapabilities: [...binding.advertisedDefinitions.keys()].sort(),
    allowedCapabilities: binding.activeTurn ? [...binding.activeTurn.definitions.keys()].sort() : [],
  };
}

/**
 * Ephemeral protocol binding only. Canonical Mission/Worker identity remains in
 * TaskRuntime + WorkerSessionManager; capability semantics, grants and execution
 * remain in the existing Phase-8/host-execution owners.
 */
export class MissionNativeMcpBindingService {
  private readonly byToken = new Map<string, MissionNativeMcpBindingRecord>();
  private readonly byManagedSession = new Map<string, string>();
  private readonly byMission = new Map<string, string>();

  constructor(
    private readonly tasks: TaskRuntime,
    private readonly workers: WorkerSessionManager,
    private readonly execution: HostCapabilityExecutionService,
    private readonly schemaSources: readonly MissionCapabilitySchemaSource[],
    private readonly workerId = "nimora.chatgpt-browser-worker",
    private readonly newToken: () => string = randomUUID,
  ) {}

  async ensureBinding(managedSessionId: string): Promise<MissionNativeMcpBindingDescriptor> {
    await this.tasks.initialize();
    const session = this.workers.getSession(managedSessionId);
    if (!session) throw new Error(`Native MCP binding requires an active managed WorkerSession: ${managedSessionId}`);
    if (session.workerId !== this.workerId) throw new Error(`Native MCP binding is only valid for ${this.workerId}, not ${session.workerId}.`);
    if (!session.taskId) throw new Error("Native MCP binding requires a Mission-bound WorkerSession.");
    const task = this.tasks.getTask(session.taskId);
    if (!task?.mission || task.missionFinalization) throw new Error(`Native MCP binding requires an active Mission: ${session.taskId}`);
    const durable = task.workerSessions[managedSessionId];
    if (!durable
      || durable.workerId !== session.workerId
      || durable.adapterSessionId !== session.adapterSessionId
      || durable.detachedAt
      || durable.retiredAt) {
      throw new Error(`Native MCP binding requires the exact active TaskRuntime WorkerSession generation: ${managedSessionId}`);
    }

    const existingToken = this.byManagedSession.get(managedSessionId);
    const existing = existingToken ? this.byToken.get(existingToken) : undefined;
    if (existing
      && existing.adapterSessionId === session.adapterSessionId
      && existing.missionId === session.taskId
      && existing.projectId === task.mission.projectId
      && existing.rootMissionId === task.mission.rootMissionId) {
      return publicBinding(existing);
    }
    if (existingToken) this.retireBinding(managedSessionId);

    const existingMissionToken = this.byMission.get(session.taskId);
    if (existingMissionToken) {
      const existingMissionBinding = this.byToken.get(existingMissionToken);
      if (existingMissionBinding?.managedSessionId !== managedSessionId
        && this.hasBindingToken(existingMissionToken)) {
        throw new Error(`Native MCP Mission ${session.taskId} already has a different active WorkerSession binding.`);
      }
    }

    const binding: MissionNativeMcpBindingRecord = {
      token: this.newToken(),
      projectId: task.mission.projectId,
      rootMissionId: task.mission.rootMissionId,
      missionId: session.taskId,
      managedSessionId,
      workerId: session.workerId,
      adapterSessionId: session.adapterSessionId,
      advertisedDefinitions: new Map(),
    };
    this.byToken.set(binding.token, binding);
    this.byManagedSession.set(managedSessionId, binding.token);
    this.byMission.set(binding.missionId, binding.token);
    return publicBinding(binding);
  }

  async activateTurn(input: {
    projectId: string;
    rootMissionId: string;
    missionId: string;
    managedSessionId: string;
    inputId: string;
    capability: MissionCapabilityMaterializationResult;
  }): Promise<MissionNativeMcpBindingDescriptor> {
    const binding = this.requireBinding((await this.ensureBinding(input.managedSessionId)).token);
    if (binding.projectId !== input.projectId
      || binding.rootMissionId !== input.rootMissionId
      || binding.missionId !== input.missionId) {
      throw new Error("Native MCP turn scope does not match the exact bound Project/Mission.");
    }
    const definitions = this.definitionsForCapability(binding, input.capability);
    binding.advertisedDefinitions = new Map(definitions);
    binding.activeTurn?.abort.abort();
    binding.activeTurn = {
      inputId: input.inputId, definitions, abort: new AbortController(),
      retryNeverOccurrences: new Map(), rejectedOccurrences: new Set(),
    };
    return publicBinding(binding);
  }

  async prepareAdvertisement(input: {
    projectId: string;
    rootMissionId: string;
    missionId: string;
    managedSessionId: string;
    capability: MissionCapabilityMaterializationResult;
  }): Promise<MissionNativeMcpBindingDescriptor> {
    const binding = this.requireBinding((await this.ensureBinding(input.managedSessionId)).token);
    if (binding.projectId !== input.projectId
      || binding.rootMissionId !== input.rootMissionId
      || binding.missionId !== input.missionId) {
      throw new Error("Native MCP advertisement scope does not match the exact bound Project/Mission.");
    }
    binding.advertisedDefinitions = this.definitionsForCapability(binding, input.capability);
    return publicBinding(binding);
  }

  private definitionsForCapability(
    binding: MissionNativeMcpBindingRecord,
    capability: MissionCapabilityMaterializationResult,
  ): Map<string, WorkerCapabilityDefinition> {
    if (capability.projectId !== binding.projectId
      || capability.rootMissionId !== binding.rootMissionId
      || capability.missionId !== binding.missionId
      || capability.managedSessionId !== binding.managedSessionId
      || capability.workerId !== binding.workerId) {
      throw new Error("Native MCP capability materialization does not match the exact binding.");
    }
    const definitions = new Map<string, WorkerCapabilityDefinition>();
    for (const toolName of capability.allowedCapabilities) {
      const mapping = capability.inspector.mappings.find(item => item.toolName === toolName);
      if (!mapping || mapping.projectionMode !== "native-by-name") {
        throw new Error(`Native MCP tool ${toolName} lacks an exact native-by-name Phase-8 mapping.`);
      }
      const source = this.schemaSources.find(item => item.sourceId === mapping.schemaSourceId);
      if (!source) throw new Error(`Native MCP schema source disappeared: ${mapping.schemaSourceId}`);
      const matches = source.listDefinitions().filter(item => item.toolName === toolName);
      if (matches.length !== 1) throw new Error(`Native MCP schema source ${source.sourceId} no longer has exactly one definition for ${toolName}.`);
      const canonical = canonicalizeWorkerCapabilityDefinition(matches[0].definition, `Native MCP ${source.sourceId}/${toolName}`);
      if (canonical.schemaIdentity !== mapping.schemaIdentity || canonical.definition.name !== toolName) {
        throw new Error(`Native MCP schema identity drifted for ${toolName}.`);
      }
      definitions.set(toolName, canonical.definition);
    }
    return definitions;
  }

  clearTurn(managedSessionId: string, inputId: string): void {
    const token = this.byManagedSession.get(managedSessionId);
    const binding = token ? this.byToken.get(token) : undefined;
    if (binding?.activeTurn?.inputId === inputId) {
      binding.activeTurn.abort.abort();
      binding.activeTurn = undefined;
    }
  }

  retireBinding(managedSessionId: string): void {
    const token = this.byManagedSession.get(managedSessionId);
    if (!token) return;
    const binding = this.byToken.get(token);
    binding?.activeTurn?.abort.abort();
    this.byManagedSession.delete(managedSessionId);
    this.byToken.delete(token);
    if (binding && this.byMission.get(binding.missionId) === token) {
      this.byMission.delete(binding.missionId);
    }
  }

  getBindingForSession(managedSessionId: string): MissionNativeMcpBindingDescriptor | undefined {
    const token = this.byManagedSession.get(managedSessionId);
    if (!token || !this.hasBindingToken(token)) return undefined;
    const binding = this.byToken.get(token);
    return binding ? publicBinding(binding) : undefined;
  }

  getBindingForMission(missionId: string): MissionNativeMcpBindingDescriptor | undefined {
    const token = this.byMission.get(missionId);
    if (!token || !this.hasBindingToken(token)) return undefined;
    const binding = this.byToken.get(token);
    return binding ? publicBinding(binding) : undefined;
  }

  hasBindingToken(token: string): boolean {
    const binding = this.byToken.get(token);
    if (!binding) return false;
    const session = this.workers.getSession(binding.managedSessionId);
    const task = this.tasks.getTask(binding.missionId);
    const durable = task?.workerSessions[binding.managedSessionId];
    const current = !!session
      && session.workerId === binding.workerId
      && session.adapterSessionId === binding.adapterSessionId
      && session.taskId === binding.missionId
      && session.state !== "disposed"
      && !!task?.mission
      && !task.missionFinalization
      && !!durable
      && durable.workerId === binding.workerId
      && durable.adapterSessionId === binding.adapterSessionId
      && !durable.detachedAt && !durable.retiredAt;
    if (!current) this.retireBinding(binding.managedSessionId);
    return current;
  }

  async listTools(token: string): Promise<Array<{
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
    annotations: ReturnType<typeof capabilityMcpFields>["annotations"];
    _meta: ReturnType<typeof capabilityMcpFields>["_meta"];
  }>> {
    const binding = await this.requireCurrentBinding(token);
    return [...binding.advertisedDefinitions.values()].map(definition => ({
      ...structuredClone(definition),
      ...capabilityMcpFields(definition.name),
    }));
  }

  async callTool(token: string, protocolSessionId: string, requestId: string | number, name: string, args: unknown,
    requestSignal?: AbortSignal, observeSubmission?: MissionNativeMcpSubmissionObserver): Promise<MissionNativeMcpToolResult> {
    const binding = await this.requireCurrentBinding(token);
    const activeTurn = binding.activeTurn;
    if (!activeTurn) throw new Error("Mission-native MCP has no active Phase-8 capability turn.");
    const definition = activeTurn.definitions.get(name);
    if (!definition) throw new Error(`Capability ${name} is outside the exact active Mission-native MCP scope.`);
    const metadata = requireCapabilityMetadata(definition.name);
    const retryNeverDigest = metadata.retry === "never"
      ? taskArgumentsDigest({ name: definition.name, arguments: args })
      : undefined;
    if (!protocolSessionId.trim()) throw new Error("Mission-native MCP requires exact protocol session identity.");
    // JSON-RPC ids are session-local, including their number/string type.
    // Equal arguments never prove that two protocol occurrences share intent.
    const callId = `${protocolSessionId}:${JSON.stringify(requestId)}`;
    const signal = requestSignal
      ? AbortSignal.any([activeTurn.abort.signal, requestSignal])
      : activeTurn.abort.signal;
    const assertCurrent = () => {
      if (this.byToken.get(token) !== binding || binding.activeTurn !== activeTurn
        || !this.hasBindingToken(token) || activeTurn.definitions.get(name) !== definition) {
        throw new Error("Mission-native MCP admission revoked: exact Worker binding or active turn ended.");
      }
    };
    signal.throwIfAborted();
    assertCurrent();
    if (activeTurn.rejectedOccurrences.has(callId)) throw new Error("Mission-native MCP occurrence was rejected; replay is forbidden.");
    if (retryNeverDigest) {
      const prior = activeTurn.retryNeverOccurrences.get(retryNeverDigest);
      const durablePrior = Object.values(this.tasks.getTask(binding.missionId)!.executions).find(execution =>
        execution.origin?.managedSessionId === binding.managedSessionId
        && execution.origin.inputId === activeTurn.inputId
        && execution.toolName === name
        && execution.argumentsDigest === (args === undefined ? undefined : taskArgumentsDigest(args))
        && execution.origin.callId !== callId);
      if ((prior && prior !== callId) || durablePrior) {
        throw new Error("Mission-native MCP retry-never call has a distinct occurrence with the same arguments; intent is ambiguous and replay is forbidden.");
      }
      // Synchronous admission fence for overlapping calls; TaskRuntime remains
      // the only execution/result owner. Also consult its ledger after restart.
      activeTurn.retryNeverOccurrences.set(retryNeverDigest, callId);
    }
    const executionRequest: HostCapabilityExecutionRequest = {
      executionId: `native-mcp:${binding.managedSessionId}:${activeTurn.inputId}:${callId}`,
      managedSessionId: binding.managedSessionId,
      workerId: binding.workerId,
      taskId: binding.missionId,
      inputId: activeTurn.inputId,
      callId,
      name: definition.name,
      arguments: args,
    };
    let result: WorkerCapabilityResultInput;
    try {
      result = await this.execution.executeOnce(executionRequest, { signal, assertCurrent });
    } catch (error) {
      activeTurn.rejectedOccurrences.add(callId);
      if (!(error instanceof HostCapabilityAuthorizationError)) throw error;
      result = {
        inputId: activeTurn.inputId,
        callId,
        name,
        text: `Permission was not granted for ${name}.`,
        isError: true,
      };
    }
    const response: MissionNativeMcpToolResult = {
      content: [{ type: "text", text: result.text ?? "" }],
      ...(result.isError ? { isError: true } : {}),
      ...(result.data && typeof result.data === "object" && !Array.isArray(result.data)
        ? { structuredContent: structuredClone(result.data as Record<string, unknown>) }
        : {}),
    };
    const prepared = this.execution.getState(executionRequest.executionId);
    if (observeSubmission && (prepared?.phase === "executed" || prepared?.phase === "delivered")) {
      observeSubmission(response, async () => {
        // Do not await here: the SDK cannot send until callTool returns.
        const current = this.execution.getState(executionRequest.executionId);
        if (current?.phase !== "executed" && current?.phase !== "delivered") {
          throw new Error("Native MCP submission confirmation requires an existing prepared result.");
        }
        await this.execution.executeAndDeliver(executionRequest, {
          submitCapabilityResult: async (managedSessionId, submitted) => {
            if (managedSessionId !== executionRequest.managedSessionId
              || taskArgumentsDigest(submitted) !== taskArgumentsDigest(result)) {
              throw new Error("Native MCP submitted result identity changed.");
            }
          },
        });
      });
    }
    return response;
  }

  private requireBinding(token: string): MissionNativeMcpBindingRecord {
    const binding = this.byToken.get(token);
    if (!binding) throw new Error("Unknown or retired Mission-native MCP binding.");
    return binding;
  }

  private async requireCurrentBinding(token: string): Promise<MissionNativeMcpBindingRecord> {
    const binding = this.requireBinding(token);
    const current = await this.ensureBinding(binding.managedSessionId);
    if (current.token !== token) throw new Error("Mission-native MCP binding generation was retired.");
    return this.requireBinding(token);
  }
}
