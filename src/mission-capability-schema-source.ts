import { FILE_TOOL_DEFINITIONS } from "./file-tool-registry.js";
import { IDE_TOOL_DEFINITIONS } from "./ide-tool-definitions.js";
import {
  FILE_MISSION_CAPABILITY_SCHEMA_SOURCE_ID,
  IDE_MISSION_CAPABILITY_SCHEMA_SOURCE_ID,
} from "./mission-capability-schema-ids.js";
import type { WorkerCapabilityDefinition } from "./worker-contract.js";

export { FILE_MISSION_CAPABILITY_SCHEMA_SOURCE_ID, IDE_MISSION_CAPABILITY_SCHEMA_SOURCE_ID } from "./mission-capability-schema-ids.js";

export interface MissionCapabilitySchemaDefinition {
  /** Semantic-registry implementation locator this concrete definition claims to implement. */
  toolName: string;
  definition: WorkerCapabilityDefinition;
}

export interface MissionCapabilitySchemaSource {
  sourceId: string;
  listDefinitions(): readonly MissionCapabilitySchemaDefinition[];
}

interface ConcreteToolDefinitionLike {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * Owner-preserving adapter: references the existing concrete definitions and
 * projects only the WorkerCapabilityDefinition shape. It owns no schema copy.
 */
export function missionCapabilitySchemaSourceFromDefinitions(
  sourceId: string,
  definitions: readonly ConcreteToolDefinitionLike[],
): MissionCapabilitySchemaSource {
  return {
    sourceId,
    listDefinitions: () => definitions.map(definition => ({
      toolName: definition.name,
      definition: {
        name: definition.name,
        ...(definition.description === undefined ? {} : { description: definition.description }),
        inputSchema: definition.inputSchema,
      },
    })),
  };
}

export const FILE_MISSION_CAPABILITY_SCHEMA_SOURCE = missionCapabilitySchemaSourceFromDefinitions(
  FILE_MISSION_CAPABILITY_SCHEMA_SOURCE_ID,
  FILE_TOOL_DEFINITIONS,
);

export const IDE_MISSION_CAPABILITY_SCHEMA_SOURCE = missionCapabilitySchemaSourceFromDefinitions(
  IDE_MISSION_CAPABILITY_SCHEMA_SOURCE_ID,
  IDE_TOOL_DEFINITIONS,
);

export const CORE_MISSION_CAPABILITY_SCHEMA_SOURCES: readonly MissionCapabilitySchemaSource[] = Object.freeze([
  FILE_MISSION_CAPABILITY_SCHEMA_SOURCE,
  IDE_MISSION_CAPABILITY_SCHEMA_SOURCE,
]);
