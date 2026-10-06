import {
  CORE_MISSION_CAPABILITY_SCHEMA_SOURCES,
  missionCapabilitySchemaSourceFromDefinitions,
} from "../../../src/mission-capability-schema-source.js";
import type { WorkerCapabilityExecutionRoute, WorkerCapabilityProjectionMode } from "../../../src/worker-contract.js";

export const MAX_BRIDGE_TODOS = 24;

export const SET_TODOS_TOOL = {
  name: "set_todos",
  description: "Set the complete durable task list for the current remote-agent job in ShunCode. Use this for multi-step work so the local user can see what is done, in progress, and still pending. Send the full list whenever the plan changes; keep at most one item in_progress. Use report_progress for transient details about the current step instead of creating tool-call-sized todos. Send an empty list to clear task state.",
  inputSchema: {
    type: "object",
    required: ["todos"],
    properties: {
      todos: {
        type: "array",
        maxItems: MAX_BRIDGE_TODOS,
        description: "Complete ordered todo snapshot for the current job.",
        items: {
          type: "object",
          required: ["id", "title", "status"],
          properties: {
            id: { type: "string", minLength: 1, maxLength: 80, description: "Stable id reused across later set_todos updates." },
            title: { type: "string", minLength: 1, maxLength: 400, description: "Goal-level task title, not an individual tool call." },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
} as const;

export const REPORT_PROGRESS_TOOL = {
  name: "report_progress",
  description: "Report concise transient progress for the current Task. Progress is durably owned by Task Runtime and shown in Nimora Work Sessions. For multi-step work, maintain durable task state with set_todos and use report_progress for what you are doing right now. todo_id is optional: when omitted, ShunCode automatically associates progress with the sole in_progress todo. This tool does not modify workspace files.",
  inputSchema: {
    type: "object",
    required: ["message"],
    properties: {
      message: { type: "string", minLength: 1, maxLength: 2000, description: "Human-readable progress update." },
      phase: { type: "string", maxLength: 160, description: "Optional short phase label, such as Reading, Editing, Testing, or Done." },
      percent: { type: "integer", minimum: 0, maximum: 100, description: "Optional completion estimate from 0 to 100 for the current activity/todo." },
      todo_id: { type: "string", minLength: 1, maxLength: 80, description: "Optional todo id from set_todos. Omit when there is exactly one in_progress todo; ShunCode will link it automatically." },
    },
    additionalProperties: false,
  },
} as const;

export const BRIDGE_TASK_TOOL_DEFINITIONS = [SET_TODOS_TOOL, REPORT_PROGRESS_TOOL] as const;

export const BRIDGE_TASK_MISSION_CAPABILITY_SCHEMA_SOURCE = missionCapabilitySchemaSourceFromDefinitions(
  "bridge-task-tool-definitions",
  BRIDGE_TASK_TOOL_DEFINITIONS,
);

/** Exact current ShunCode schema-owner environment for Phase 8 materialization. */
export const SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES = Object.freeze([
  ...CORE_MISSION_CAPABILITY_SCHEMA_SOURCES,
  BRIDGE_TASK_MISSION_CAPABILITY_SCHEMA_SOURCE,
]);

/** Owner-preserving concrete route facts for the exact current schema sources. */
export function shunCodeMissionCapabilityExecutionRoutes(
  projectionMode: WorkerCapabilityProjectionMode,
  routePrefix: string,
  basis: string,
): readonly WorkerCapabilityExecutionRoute[] {
  return Object.freeze(SHUNCODE_MISSION_CAPABILITY_SCHEMA_SOURCES.map(source => Object.freeze({
    routeId: `${routePrefix}:${source.sourceId}`,
    projectionMode,
    schemaSourceId: source.sourceId,
    toolNames: Object.freeze(source.listDefinitions().map(item => item.toolName)),
    basis,
  })));
}
