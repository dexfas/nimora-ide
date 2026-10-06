/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { equals } from '../../../base/common/objects.js';
import type { ToolDefinition } from './state/sessionState.js';

/** Generic create-time client-tool boundary. It conveys transport policy, never tool authorization. */
export const CLIENT_TOOL_SCOPE_CONFIG_KEY = 'clientToolScope';
export const CLIENT_TOOL_SCOPE_VERSION_CONFIG_KEY = 'clientToolScopeProtocolVersion';

/** Server schema advertisement, independent of the workbench bridge version. */
export function supportsClientToolScope(value: unknown): boolean {
	if (!value || value instanceof Error || typeof value !== 'object') { return false; }
	const property = (value as { config?: { schema?: { properties?: Record<string, { readOnly?: boolean; enum?: unknown[] }> } } }).config?.schema?.properties?.[CLIENT_TOOL_SCOPE_VERSION_CONFIG_KEY];
	return property?.readOnly === true && property.enum?.length === 1 && property.enum[0] === 1;
}
export interface IClientToolScope {
	readonly version: 1;
	readonly scopeId: string;
	readonly clientId: string;
	readonly tools: readonly ToolDefinition[];
}

export function readClientToolScope(value: unknown): IClientToolScope | undefined {
	if (value === undefined) { return undefined; }
	if (typeof value !== 'string' || value.length > 262144) { throw new Error('Invalid client tool scope'); }
	const raw: unknown = JSON.parse(value);
	if (!raw || typeof raw !== 'object') { throw new Error('Invalid client tool scope'); }
	const scope = raw as IClientToolScope;
	if (scope.version !== 1 || typeof scope.scopeId !== 'string' || !/^[a-zA-Z0-9-]{16,128}$/.test(scope.scopeId)
		|| typeof scope.clientId !== 'string' || !scope.clientId || !Array.isArray(scope.tools) || scope.tools.length > 128) {
		throw new Error('Invalid client tool scope');
	}
	const names = new Set<string>();
	for (const tool of scope.tools) {
		if (!tool || typeof tool.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/.test(tool.name)
			|| names.has(tool.name) || tool.name === 'tool_search' || tool.name === 'toolSearch'
			|| !tool.inputSchema || tool.inputSchema.type !== 'object'
			|| (tool.description !== undefined && typeof tool.description !== 'string')) {
			throw new Error('Invalid or duplicate scoped client tool');
		}
		names.add(tool.name);
	}
	return scope;
}

export function assertClientToolScopeTools(scope: IClientToolScope, tools: readonly ToolDefinition[]): void {
	if (!equals(scope.tools, tools)) { throw new Error('Client tools changed after the execution scope was frozen'); }
}
