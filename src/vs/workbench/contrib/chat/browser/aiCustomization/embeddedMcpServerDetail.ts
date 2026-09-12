/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { LocalMcpServerScope } from '../../../../services/mcp/common/mcpWorkbenchManagementService.js';
import { isContributionDisabled } from '../../common/enablement.js';
import { IMcpServer, IMcpService, IMcpTool, IMcpWorkbenchService, IWorkbenchMcpServer, McpConnectionState, McpServerCacheState, McpServerInstallState, McpToolVisibility } from '../../../mcp/common/mcpTypes.js';
import { userIcon, workspaceIcon } from './aiCustomizationIcons.js';

const $ = DOM.$;

/**
 * Detail view for an MCP server inside the AI Customizations management editor. In addition
 * to the server identity, this renders live connection state and the exact model-visible tools
 * discovered from the runtime.
 */
export class EmbeddedMcpServerDetail extends Disposable {

	private readonly root: HTMLElement;
	private readonly headerEl: HTMLElement;
	private readonly leadingSlotEl: HTMLElement;
	private readonly nameEl: HTMLElement;
	private readonly scopeEl: HTMLElement;
	private readonly descriptionEl: HTMLElement;
	private readonly statusEl: HTMLElement;
	private readonly statusIconEl: HTMLElement;
	private readonly statusLabelEl: HTMLElement;
	private readonly statusMetaEl: HTMLElement;
	private readonly actionsEl: HTMLElement;
	private readonly lifecycleButton: Button;
	private readonly outputButton: Button;
	private readonly toolsHeadingEl: HTMLElement;
	private readonly toolsMessageEl: HTMLElement;
	private readonly toolsListEl: HTMLElement;
	private readonly emptyEl: HTMLElement;
	private readonly runtimeDisposables = this._register(new DisposableStore());

	private current: IWorkbenchMcpServer | undefined;
	private currentRuntime: IMcpServer | undefined;
	private currentConnectionState: McpConnectionState | undefined;
	private lifecycleActionRunning = false;

	constructor(
		parent: HTMLElement,
		@IMcpWorkbenchService private readonly mcpWorkbenchService: IMcpWorkbenchService,
		@IMcpService private readonly mcpService: IMcpService,
	) {
		super();

		this.root = DOM.append(parent, $('.ai-customization-embedded-detail.embedded-mcp-detail'));

		this.headerEl = DOM.append(this.root, $('.embedded-detail-header'));
		// Slot at the start of the header for callers to append leading chrome
		// (e.g. a back button) without reaching into private DOM structure.
		this.leadingSlotEl = DOM.append(this.headerEl, $('.embedded-detail-leading-slot'));
		const headerText = DOM.append(this.headerEl, $('.embedded-detail-header-text'));
		this.nameEl = DOM.append(headerText, $('h2.embedded-detail-name'));
		this.nameEl.setAttribute('role', 'heading');
		this.scopeEl = DOM.append(headerText, $('.embedded-detail-scope'));

		this.descriptionEl = DOM.append(this.root, $('.embedded-detail-description'));

		this.statusEl = DOM.append(this.root, $('.embedded-mcp-status'));
		this.statusIconEl = DOM.append(this.statusEl, $('.embedded-mcp-status-icon'));
		const statusText = DOM.append(this.statusEl, $('.embedded-mcp-status-text'));
		this.statusLabelEl = DOM.append(statusText, $('.embedded-mcp-status-label'));
		this.statusMetaEl = DOM.append(statusText, $('.embedded-mcp-status-meta'));

		this.actionsEl = DOM.append(this.root, $('.embedded-mcp-actions'));
		this.lifecycleButton = this._register(new Button(this.actionsEl, {
			...defaultButtonStyles,
			secondary: true,
			small: true,
			supportIcons: true,
		}));
		this.outputButton = this._register(new Button(this.actionsEl, {
			...defaultButtonStyles,
			secondary: true,
			small: true,
			supportIcons: true,
		}));
		this.outputButton.label = `$(${Codicon.output.id}) ${localize('mcpShowOutput', "Show Output")}`;
		this._register(this.lifecycleButton.onDidClick(() => void this.runLifecycleAction()));
		this._register(this.outputButton.onDidClick(() => void this.currentRuntime?.showOutput()));

		const toolsEl = DOM.append(this.root, $('.embedded-detail-tools.embedded-mcp-tools'));
		this.toolsHeadingEl = DOM.append(toolsEl, $('h3.embedded-detail-tools-heading'));
		this.toolsMessageEl = DOM.append(toolsEl, $('.embedded-detail-tools-message'));
		this.toolsListEl = DOM.append(toolsEl, $('.embedded-detail-tools-list'));

		this.emptyEl = DOM.append(this.root, $('.embedded-detail-empty'));
		this.emptyEl.textContent = localize('mcpDetailEmpty', "No MCP server selected.");

		// Refresh when the underlying server changes (install state, enablement, etc.).
		this._register(this.mcpWorkbenchService.onChange(server => {
			if (this.current && server && server.id === this.current.id) {
				this.current = server;
				this.renderItem();
			}
		}));

		this.renderItem();
	}

	get element(): HTMLElement {
		return this.root;
	}

	get headerElement(): HTMLElement {
		return this.headerEl;
	}

	/**
	 * Header slot reserved for leading chrome (e.g. a back button).
	 * Prefer this over reaching into the header element directly.
	 */
	get leadingSlot(): HTMLElement {
		return this.leadingSlotEl;
	}

	setInput(server: IWorkbenchMcpServer): void {
		this.current = server;
		this.renderItem();
	}

	clearInput(): void {
		this.current = undefined;
		this.renderItem();
	}

	private renderItem(): void {
		const server = this.current;
		const hasItem = !!server;
		this.emptyEl.style.display = hasItem ? 'none' : '';
		this.root.classList.toggle('is-empty', !hasItem);
		if (!server) {
			this.nameEl.textContent = '';
			this.scopeEl.textContent = '';
			this.descriptionEl.textContent = '';
			this.bindRuntime();
			return;
		}

		this.nameEl.textContent = server.label || server.name;

		// Scope label
		const scope = server.local?.scope;
		const scopeInfo = describeMcpScope(scope);
		if (scopeInfo) {
			this.scopeEl.textContent = scopeInfo.label;
			this.scopeEl.style.display = '';
		} else {
			this.scopeEl.replaceChildren();
			this.scopeEl.style.display = 'none';
		}

		// Description (single line, but allow wrapping in CSS)
		const description = (server.description || '').trim();
		this.descriptionEl.textContent = description;
		this.descriptionEl.style.display = description ? '' : 'none';
		this.bindRuntime();
	}

	private bindRuntime(): void {
		this.runtimeDisposables.clear();
		this.currentRuntime = undefined;
		this.currentConnectionState = undefined;

		const selected = this.current;
		if (!selected) {
			this.renderRuntime(undefined);
			return;
		}

		this.runtimeDisposables.add(autorun(reader => {
			const runtime = findMcpRuntimeServer(selected, this.mcpService.servers.read(reader));
			this.currentRuntime = runtime;
			if (!runtime) {
				this.currentConnectionState = undefined;
				this.renderRuntime(undefined);
				return;
			}

			const disabled = isContributionDisabled(runtime.enablement.read(reader));
			const connectionState = runtime.connectionState.read(reader);
			const cacheState = runtime.cacheState.read(reader);
			const tools = runtime.tools.read(reader).filter(tool => (tool.visibility & McpToolVisibility.Model) !== 0);
			this.currentConnectionState = connectionState;
			this.renderRuntime({ disabled, connectionState, cacheState, tools });
		}));
	}

	private renderRuntime(snapshot: IMcpRuntimeSnapshot | undefined): void {
		const server = this.current;
		this.statusIconEl.className = 'embedded-mcp-status-icon';
		this.statusEl.className = 'embedded-mcp-status';
		DOM.clearNode(this.toolsListEl);

		if (!snapshot) {
			const installed = server?.installState === McpServerInstallState.Installed;
			this.setStatus(
				installed ? localize('mcpRuntimeUnavailable', "Runtime unavailable") : localize('mcpNotInstalled', "Not installed"),
				installed ? localize('mcpRuntimeUnavailableDetail', "The server is configured, but no matching MCP runtime is currently available.") : localize('mcpNotInstalledDetail', "Install this server to connect and discover its tools."),
				'stopped',
				Codicon.circleOutline,
			);
			this.actionsEl.style.display = 'none';
			this.toolsHeadingEl.textContent = localize('mcpToolsAvailableHeading', "Tools available to AI ({0})", 0);
			this.toolsMessageEl.textContent = installed
				? localize('mcpToolsRuntimeUnavailable', "Tools cannot be listed until the MCP runtime is available.")
				: localize('mcpToolsInstallFirst', "Install the server to see its tools.");
			this.toolsMessageEl.style.display = '';
			this.toolsListEl.style.display = 'none';
			return;
		}

		const { disabled, connectionState, cacheState, tools } = snapshot;
		const presentation = getRuntimeStatusPresentation(disabled, connectionState);
		this.setStatus(presentation.label, getRuntimeStatusMeta(disabled, connectionState, cacheState, tools.length), presentation.className, presentation.icon);

		this.actionsEl.style.display = '';
		this.lifecycleButton.element.style.display = disabled ? 'none' : '';
		this.outputButton.element.style.display = '';
		this.lifecycleButton.enabled = !this.lifecycleActionRunning;
		this.outputButton.enabled = !this.lifecycleActionRunning;
		const shouldStop = McpConnectionState.isRunning(connectionState);
		this.lifecycleButton.label = shouldStop
			? `$(${Codicon.debugStop.id}) ${localize('mcpStopServer', "Stop Server")}`
			: `$(${Codicon.debugStart.id}) ${connectionState.state === McpConnectionState.Kind.Error ? localize('mcpRetryServer', "Retry Server") : localize('mcpStartServer', "Start Server")}`;

		this.toolsHeadingEl.textContent = localize('mcpToolsAvailableHeading', "Tools available to AI ({0})", tools.length);
		if (tools.length > 0) {
			this.toolsMessageEl.style.display = 'none';
			this.toolsListEl.style.display = '';
			for (const tool of tools) {
				this.renderTool(tool);
			}
		} else {
			this.toolsMessageEl.textContent = getNoToolsMessage(disabled, connectionState, cacheState);
			this.toolsMessageEl.style.display = '';
			this.toolsListEl.style.display = 'none';
		}
	}

	private setStatus(label: string, meta: string, className: string, icon: ThemeIcon): void {
		this.statusEl.classList.add(className);
		this.statusIconEl.classList.add(...ThemeIcon.asClassNameArray(icon));
		this.statusLabelEl.textContent = label;
		this.statusMetaEl.textContent = meta;
	}

	private renderTool(tool: IMcpTool): void {
		const item = DOM.append(this.toolsListEl, $('.embedded-detail-tool'));
		const name = DOM.append(item, $('.embedded-detail-tool-name'));
		name.textContent = tool.definition.title || tool.definition.annotations?.title || tool.definition.name;
		if (tool.referenceName !== tool.definition.name) {
			const referenceName = DOM.append(item, $('.embedded-mcp-tool-reference'));
			referenceName.textContent = tool.referenceName;
		}
		const description = DOM.append(item, $('.embedded-detail-tool-description'));
		description.textContent = tool.definition.description?.trim() || localize('mcpToolNoDescription', "No description provided by the server.");
	}

	private async runLifecycleAction(): Promise<void> {
		const runtime = this.currentRuntime;
		const connectionState = this.currentConnectionState;
		if (!runtime || !connectionState || this.lifecycleActionRunning) {
			return;
		}

		this.lifecycleActionRunning = true;
		this.lifecycleButton.enabled = false;
		this.outputButton.enabled = false;
		try {
			if (McpConnectionState.isRunning(connectionState)) {
				await runtime.stop();
			} else {
				await runtime.start();
			}
		} finally {
			this.lifecycleActionRunning = false;
			this.lifecycleButton.enabled = true;
			this.outputButton.enabled = true;
		}
	}
}

interface IMcpRuntimeSnapshot {
	readonly disabled: boolean;
	readonly connectionState: McpConnectionState;
	readonly cacheState: McpServerCacheState;
	readonly tools: readonly IMcpTool[];
}

export function findMcpRuntimeServer(server: IWorkbenchMcpServer, candidates: readonly IMcpServer[]): IMcpServer | undefined {
	const workbenchKeys = [server.id, server.name, server.label]
		.map(value => value.trim().toLowerCase())
		.filter(Boolean);
	for (const key of workbenchKeys) {
		const matches = candidates.filter(candidate => candidate.definition.id.trim().toLowerCase() === key || candidate.definition.label.trim().toLowerCase() === key);
		if (matches.length === 1) {
			return matches[0];
		}
	}
	return undefined;
}

function getRuntimeStatusPresentation(disabled: boolean, state: McpConnectionState): { label: string; className: string; icon: ThemeIcon } {
	if (disabled) {
		return { label: localize('mcpDisabled', "Disabled"), className: 'disabled', icon: Codicon.circleSlash };
	}
	switch (state.state) {
		case McpConnectionState.Kind.Running:
			return { label: localize('mcpConnected', "Connected"), className: 'running', icon: Codicon.check };
		case McpConnectionState.Kind.Starting:
			return { label: localize('mcpConnecting', "Connecting"), className: 'starting', icon: ThemeIcon.modify(Codicon.loading, 'spin') };
		case McpConnectionState.Kind.Error:
			return { label: localize('mcpConnectionError', "Connection error"), className: 'error', icon: Codicon.error };
		case McpConnectionState.Kind.Stopped:
		default:
			return { label: localize('mcpStopped', "Stopped"), className: 'stopped', icon: Codicon.circleOutline };
	}
}

function getRuntimeStatusMeta(disabled: boolean, state: McpConnectionState, cacheState: McpServerCacheState, toolCount: number): string {
	if (disabled) {
		return localize('mcpDisabledDetail', "This server is not available to chat.");
	}
	if (state.state === McpConnectionState.Kind.Error) {
		return state.message;
	}
	if (cacheState === McpServerCacheState.Live) {
		return localize('mcpLiveToolsDetail', "Live tool list · {0} available to AI", toolCount);
	}
	if (cacheState === McpServerCacheState.Cached) {
		return localize('mcpCachedToolsDetail', "Showing cached tool information · {0} available to AI", toolCount);
	}
	if (cacheState === McpServerCacheState.Outdated) {
		return localize('mcpOutdatedToolsDetail', "Tool information may be outdated · {0} available to AI", toolCount);
	}
	if (cacheState === McpServerCacheState.RefreshingFromUnknown || cacheState === McpServerCacheState.RefreshingFromCached) {
		return localize('mcpRefreshingToolsDetail', "Discovering tools from the server…");
	}
	return state.state === McpConnectionState.Kind.Starting
		? localize('mcpStartingDetail', "Starting the server and discovering tools…")
		: localize('mcpToolsUnknownDetail', "Tools have not been discovered yet.");
}

function getNoToolsMessage(disabled: boolean, state: McpConnectionState, cacheState: McpServerCacheState): string {
	if (disabled) {
		return localize('mcpNoToolsDisabled', "Enable this server to discover the tools it provides.");
	}
	if (state.state === McpConnectionState.Kind.Error) {
		return localize('mcpNoToolsError', "Tools could not be loaded. Check the server output for details.");
	}
	if (state.state === McpConnectionState.Kind.Starting || cacheState === McpServerCacheState.RefreshingFromUnknown || cacheState === McpServerCacheState.RefreshingFromCached) {
		return localize('mcpNoToolsRefreshing', "Discovering tools…");
	}
	if (state.state === McpConnectionState.Kind.Stopped && cacheState === McpServerCacheState.Unknown) {
		return localize('mcpNoToolsStartServer', "Start the server to discover its tools.");
	}
	return localize('mcpNoModelTools', "The server reported no tools that are available to AI.");
}

function describeMcpScope(scope: LocalMcpServerScope | undefined): { label: string; icon: ThemeIcon } | undefined {
	switch (scope) {
		case LocalMcpServerScope.Workspace:
			return { label: localize('mcpScopeWorkspace', "Workspace"), icon: workspaceIcon };
		case LocalMcpServerScope.User:
		case LocalMcpServerScope.RemoteUser:
			return { label: localize('mcpScopeUser', "User"), icon: userIcon };
		default:
			return undefined;
	}
}
