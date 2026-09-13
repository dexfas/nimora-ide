/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/shunCodeBridgeSessionView.css';
import { $, addDisposableListener, append, clearNode, setVisibility } from '../../../../../../base/browser/dom.js';
import { Button } from '../../../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../../../base/common/codicons.js';
import { Disposable, toDisposable } from '../../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../../base/common/themables.js';
import { localize } from '../../../../../../nls.js';
import { ICommandService } from '../../../../../../platform/commands/common/commands.js';
import { defaultButtonStyles } from '../../../../../../platform/theme/browser/defaultStyles.js';

interface BridgeActivityPresentation {
	readonly kind: 'files' | 'search' | 'edit' | 'terminal' | 'diagnostics' | 'lsp' | 'generic';
	readonly title: string;
	readonly subtitle?: string;
	readonly input?: string;
	readonly output?: string;
	readonly files?: string[];
	readonly items?: BridgeActivityItem[];
	readonly diff?: string;
	readonly diffPreview?: BridgeDiffFilePreview[];
	readonly terminalId?: string;
	readonly commandId?: string;
	readonly exitCode?: number | null;
}

interface BridgeDiffFilePreview {
	readonly path: string;
	readonly oldPath?: string;
	readonly newPath?: string;
	readonly hunks: BridgeDiffHunkPreview[];
	readonly truncated?: boolean;
}

interface BridgeDiffHunkPreview {
	readonly oldStart: number;
	readonly newStart: number;
	readonly lines: BridgeDiffLinePreview[];
	readonly truncated?: boolean;
}

interface BridgeDiffLinePreview {
	readonly kind: 'context' | 'add' | 'delete';
	readonly oldLine?: number;
	readonly newLine?: number;
	readonly text: string;
}

interface BridgeActivityItem {
	readonly kind: 'file' | 'folder' | 'match' | 'diagnostic' | 'symbol';
	readonly path: string;
	readonly line?: number;
	readonly column?: number;
	readonly label?: string;
	readonly description?: string;
	readonly severity?: 'error' | 'warning' | 'information' | 'hint';
	readonly additions?: number;
	readonly deletions?: number;
}

interface BridgeActivity {
	readonly id: number;
	readonly at: string;
	readonly tool: string;
	readonly status: 'running' | 'completed' | 'error';
	readonly durationMs?: number;
	readonly message?: string;
	readonly presentation?: BridgeActivityPresentation;
}

interface BridgeStatus {
	readonly state: 'stopped' | 'starting' | 'running' | 'error';
	readonly transport: 'streamable-http';
	readonly publicUrl?: string;
	readonly lastError?: string;
	readonly activeRequests: number;
	readonly connected: boolean;
	readonly revision: number;
	readonly stats: {
		readonly toolCalls: number;
		readonly completedToolCalls: number;
		readonly failedToolCalls: number;
		readonly averageDurationMs: number;
		readonly successRate: number;
		readonly lastTool?: string;
		readonly lastToolAt?: string;
	};
	readonly activities: BridgeActivity[];
}

const BRIDGE_GET_STATUS = 'shuncode.bridge.getStatus';
const BRIDGE_OPEN_VIEW = 'shuncode.bridge.openView';
const BRIDGE_CLEAR_ACTIVITY_LOG = 'shuncode.bridge.clearActivityLog';
const BRIDGE_OPEN_RESOURCE = 'shuncode.bridge.openResource';
const BRIDGE_OPEN_DIFF = 'shuncode.bridge.openDiff';
const BRIDGE_OPEN_TERMINAL = 'shuncode.bridge.openTerminal';
const TASK_CENTER_OPEN = 'shuncode.taskCenter.open';

function formatDuration(durationMs: number | undefined): string {
	if (durationMs === undefined) {
		return '';
	}
	if (durationMs < 1000) {
		return `${durationMs} ms`;
	}
	return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function formatTime(value: string | undefined): string {
	if (!value) {
		return '';
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) {
		return '';
	}
	return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function activityIcon(activity: BridgeActivity): ThemeIcon {
	if (activity.status === 'error') {
		return Codicon.error;
	}
	if (activity.status === 'running') {
		return ThemeIcon.modify(Codicon.loading, 'spin');
	}
	switch (activity.presentation?.kind) {
		case 'files': return Codicon.files;
		case 'search': return Codicon.search;
		case 'edit': return Codicon.edit;
		case 'terminal': return Codicon.terminal;
		case 'diagnostics': return Codicon.warning;
		case 'lsp': return Codicon.symbolMethod;
		default: return Codicon.tools;
	}
}

export class ShunCodeBridgeSessionView extends Disposable {
	private static readonly NEAR_BOTTOM_SCROLL_THRESHOLD_PX = 72;
	private static readonly USER_SCROLL_RENDER_COOLDOWN_MS = 500;

	private readonly root: HTMLElement;
	private readonly timelineScroll: HTMLElement;
	private readonly timeline: HTMLElement;
	private readonly connectionDot: HTMLElement;
	private readonly connectionTitle: HTMLElement;
	private readonly connectionDescription: HTMLElement;
	private readonly footerDetails: HTMLElement;
	private readonly statsContainer: HTMLElement;
	private readonly footerMeta: HTMLElement;
	private readonly footerHint: HTMLElement;
	private readonly bridgeSettingsButton: Button;
	private readonly clearLogButton: Button;
	private readonly workSessionsButton: Button;
	private readonly collapseButton: Button;
	private visible = false;
	private refreshing = false;
	private busy = false;
	private footerCollapsed = false;
	private readonly expandedToolActivities = new Set<number>();
	private lastRevision = -1;
	private lastStatus: BridgeStatus | undefined;
	private followTimeline = true;
	private suppressScrollTracking = false;
	private userScrollActiveUntil = 0;

	constructor(
		parent: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();

		this.root = append(parent, $('.shuncode-bridge-session-view'));
		this.root.style.display = 'none';

		this.timelineScroll = append(this.root, $('.shuncode-bridge-session-scroll'));
		this.timeline = append(this.timelineScroll, $('.shuncode-bridge-session-timeline'));
		this._register(addDisposableListener(this.timelineScroll, 'scroll', () => this.onTimelineScroll()));

		// The ChatWidget registers a wheel listener on its parent (the shared
		// controls wrapper) that forwards wheel events originating outside its
		// own container to the chat list, which prevents default and swallows
		// them. The Bridge session view lives in that same wrapper, so wheel
		// events over this view would reach that listener and be consumed by
		// the hidden chat list, leaving the native scrollbar draggable but the
		// wheel dead. Stop the propagation at the session view boundary so the
		// browser's native scrolling of `.shuncode-bridge-session-scroll`
		// keeps working.
		this._register(addDisposableListener(this.root, 'wheel', (event) => {
			event.stopPropagation();
		}));

		const footer = append(this.root, $('.shuncode-bridge-session-footer'));
		const connectionRow = append(footer, $('.shuncode-bridge-session-connection-row'));
		const connectionInfo = append(connectionRow, $('.shuncode-bridge-session-connection-info'));
		const connectionHeading = append(connectionInfo, $('.shuncode-bridge-session-connection-heading'));
		this.connectionDot = append(connectionHeading, $('span.shuncode-bridge-session-dot'));
		this.connectionTitle = append(connectionHeading, $('strong'));
		this.connectionDescription = append(connectionInfo, $('span.shuncode-bridge-session-connection-description'));
		const connectionActions = append(connectionRow, $('.shuncode-bridge-session-connection-actions'));
		this.collapseButton = this._register(new Button(connectionActions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.collapseButton.element.classList.add('shuncode-bridge-session-collapse-button');
		this._register(this.collapseButton.onDidClick(() => this.toggleFooterCollapsed()));

		// Action buttons live on their own row below the status text so the
		// narrow sidebar never has to squeeze controls next to the heading.
		const actionRow = append(footer, $('.shuncode-bridge-session-action-row'));
		this.bridgeSettingsButton = this._register(new Button(actionRow, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.bridgeSettingsButton.element.classList.add('shuncode-bridge-session-action-button', 'shuncode-bridge-session-settings-button');
		this.bridgeSettingsButton.label = `$(${Codicon.settingsGear.id}) ${localize('shuncodeBridgeSession.bridgeSettingsShort', "Bridge Settings")}`;
		const bridgeSettingsTitle = localize('shuncodeBridgeSession.bridgeSettings', "Open Bridge connection settings");
		this.bridgeSettingsButton.setTitle(bridgeSettingsTitle);
		this.bridgeSettingsButton.element.setAttribute('aria-label', bridgeSettingsTitle);
		this._register(this.bridgeSettingsButton.onDidClick(() => void this.commandService.executeCommand(BRIDGE_OPEN_VIEW)));
		this.workSessionsButton = this._register(new Button(actionRow, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.workSessionsButton.element.classList.add('shuncode-bridge-session-action-button', 'shuncode-bridge-session-work-sessions-button');
		this.workSessionsButton.label = `$(${Codicon.tasklist.id}) ${localize('shuncodeBridgeSession.workSessionsShort', "Work Sessions")}`;
		const workSessionsTitle = localize('shuncodeBridgeSession.workSessions', "Open Task-owned Work Sessions");
		this.workSessionsButton.setTitle(workSessionsTitle);
		this.workSessionsButton.element.setAttribute('aria-label', workSessionsTitle);
		this._register(this.workSessionsButton.onDidClick(() => void this.commandService.executeCommand(TASK_CENTER_OPEN)));
		this.clearLogButton = this._register(new Button(actionRow, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.clearLogButton.element.classList.add('shuncode-bridge-session-action-button', 'shuncode-bridge-session-clear-button');
		this._register(this.clearLogButton.onDidClick(() => void this.clearActivityLog()));

		this.footerDetails = append(footer, $('.shuncode-bridge-session-footer-details'));
		this.statsContainer = append(this.footerDetails, $('.shuncode-bridge-session-stats'));
		this.footerMeta = append(this.footerDetails, $('.shuncode-bridge-session-meta'));
		this.footerHint = append(this.footerDetails, $('.shuncode-bridge-session-hint'));
		this.renderFooterCollapsedState();

		const timer = setInterval(() => void this.refresh(), 350);
		this._register(toDisposable(() => clearInterval(timer)));
	}

	setVisible(visible: boolean): void {
		this.visible = visible;
		setVisibility(visible, this.root);
		if (visible) {
			// Re-showing starts pinned to the latest activity again.
			this.followTimeline = true;
			void this.refresh(true);
		}
	}

	private toggleFooterCollapsed(): void {
		this.footerCollapsed = !this.footerCollapsed;
		this.renderFooterCollapsedState();
		if (this.lastStatus) {
			this.renderStatus(this.lastStatus);
		}
	}

	private async clearActivityLog(): Promise<void> {
		if (this.busy) {
			return;
		}
		this.busy = true;
		this.renderControls();
		try {
			const status = await this.commandService.executeCommand<BridgeStatus>(BRIDGE_CLEAR_ACTIVITY_LOG);
			this.expandedToolActivities.clear();
			this.followTimeline = true;
			if (status) {
				this.lastStatus = status;
				this.render(status, true);
			}
		} catch (error) {
			this.connectionDescription.textContent = error instanceof Error ? error.message : String(error);
		} finally {
			this.busy = false;
			this.renderControls();
		}
	}

	private renderFooterCollapsedState(): void {
		this.root.classList.toggle('footer-collapsed', this.footerCollapsed);
		setVisibility(!this.footerCollapsed, this.footerDetails);
		this.collapseButton.label = `$(${this.footerCollapsed ? Codicon.chevronUp.id : Codicon.chevronDown.id})`;
		const title = this.footerCollapsed
			? localize('shuncodeBridgeSession.expandStatus', "Expand Bridge status")
			: localize('shuncodeBridgeSession.collapseStatus', "Collapse Bridge status");
		this.collapseButton.setTitle(title);
		this.collapseButton.element.setAttribute('aria-label', title);
		this.collapseButton.element.setAttribute('aria-expanded', String(!this.footerCollapsed));
	}

	private async refresh(force = false): Promise<void> {
		if (!this.visible || this.refreshing || this.busy) {
			return;
		}
		this.refreshing = true;
		try {
			const status = await this.commandService.executeCommand<BridgeStatus>(BRIDGE_GET_STATUS);
			if (status) {
				this.lastStatus = status;
				this.render(status, force);
			}
		} catch (error) {
			this.connectionTitle.textContent = localize('shuncodeBridgeSession.unavailable', "Bridge unavailable");
			this.connectionDescription.textContent = error instanceof Error ? error.message : String(error);
			this.connectionDot.className = 'shuncode-bridge-session-dot state-error';
		} finally {
			this.refreshing = false;
		}
	}

	private render(status: BridgeStatus, force: boolean): void {
		// Rebuilding the timeline replaces every DOM node and would interrupt a
		// native scrollbar drag in progress; defer it while the user is actively
		// scrolling and let the next refresh cycle render once idle.
		if (force || (status.revision !== this.lastRevision && Date.now() >= this.userScrollActiveUntil)) {
			this.renderTimeline(status.activities);
			this.lastRevision = status.revision;
		}
		this.renderStatus(status);
		this.renderControls();
	}

	private renderTimeline(activities: readonly BridgeActivity[]): void {
		clearNode(this.timeline);

		if (!activities.length) {
			const empty = append(this.timeline, $('.shuncode-bridge-session-empty'));
			const icon = append(empty, $('span'));
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.radioTower));
			append(empty, $('strong', undefined, localize('shuncodeBridgeSession.waiting', "Waiting for the remote Agent")));
			append(empty, $('span', undefined, localize('shuncodeBridgeSession.waitingDetail', "Tool calls made by the connected MCP client will appear here. Input stays in the external client.")));
			return;
		}

		for (const activity of activities) {
			this.renderToolCard(activity);
		}

		// Pin to the latest activity only while the user has not scrolled away.
		// The previous `status === 'running'` clause yanked the scroll position
		// to the bottom on every poll and made the scrollbar unusable.
		if (this.followTimeline) {
			this.scrollTimelineToBottom();
		}
	}

	private onTimelineScroll(): void {
		if (this.suppressScrollTracking) {
			return;
		}
		this.userScrollActiveUntil = Date.now() + ShunCodeBridgeSessionView.USER_SCROLL_RENDER_COOLDOWN_MS;
		const distanceFromBottom = this.timelineScroll.scrollHeight - this.timelineScroll.scrollTop - this.timelineScroll.clientHeight;
		this.followTimeline = distanceFromBottom < ShunCodeBridgeSessionView.NEAR_BOTTOM_SCROLL_THRESHOLD_PX;
	}

	private scrollTimelineToBottom(): void {
		queueMicrotask(() => {
			this.suppressScrollTracking = true;
			this.timelineScroll.scrollTop = this.timelineScroll.scrollHeight;
			// Programmatic scrolls dispatch scroll events asynchronously; release the
			// suppression afterwards so user-initiated scrolling is tracked again.
			setTimeout(() => {
				this.suppressScrollTracking = false;
				this.followTimeline = true;
			}, 0);
		});
	}

	private renderToolCard(activity: BridgeActivity): void {
		const presentation = activity.presentation ?? { kind: 'generic' as const, title: activity.tool };
		const card = append(this.timeline, $<HTMLDetailsElement>('details.shuncode-bridge-tool-card'));
		card.open = this.expandedToolActivities.has(activity.id);
		card.classList.add(`state-${activity.status}`, `kind-${presentation.kind}`);

		const summary = append(card, $('summary.shuncode-bridge-tool-summary'));
		this.bindDetailsToggle(card, summary, expanded => {
			if (expanded) {
				this.expandedToolActivities.add(activity.id);
			} else {
				this.expandedToolActivities.delete(activity.id);
			}
		});
		const icon = append(summary, $('span.shuncode-bridge-tool-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(activityIcon(activity)));
		const labels = append(summary, $('.shuncode-bridge-tool-labels'));
		append(labels, $('span.shuncode-bridge-tool-title', undefined, presentation.title));
		if (presentation.subtitle) append(labels, $('span.shuncode-bridge-tool-subtitle', undefined, presentation.subtitle));
		const meta = append(summary, $('span.shuncode-bridge-tool-meta'));
		meta.textContent = activity.status === 'running'
			? localize('shuncodeBridgeSession.running', "Running…")
			: activity.status === 'error'
				? localize('shuncodeBridgeSession.failed', "Failed")
				: formatDuration(activity.durationMs) || localize('shuncodeBridgeSession.completed', "Completed");
		if (presentation.kind === 'edit') {
			this.renderEditSummaryItems(summary, presentation);
		}

		const body = append(card, $('.shuncode-bridge-tool-body'));
		if (presentation.kind !== 'edit') {
			this.renderToolItems(body, presentation);
		}
		if (presentation.kind === 'edit') {
			this.renderMiniDiff(body, presentation);
		}
		if (presentation.terminalId) {
			const actions = append(body, $('.shuncode-bridge-tool-actions'));
			const openTerminal = append(actions, $('button.shuncode-bridge-tool-action'));
			const terminalIcon = append(openTerminal, $('span'));
			terminalIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.terminal));
			append(openTerminal, $('span', undefined, localize('shuncodeBridgeSession.openTerminal', "Open Terminal")));
			openTerminal.addEventListener('click', () => void this.commandService.executeCommand(BRIDGE_OPEN_TERMINAL, presentation.terminalId));
		}

		const showRawInput = presentation.kind === 'generic' || activity.tool === 'send_command_input';
		this.renderCodeSection(body, localize('shuncodeBridgeSession.input', "Input"), showRawInput ? presentation.input : undefined);
		this.renderCodeSection(body, localize('shuncodeBridgeSession.output', "Output"), presentation.output);
		if (activity.message && activity.status === 'error' && activity.message !== presentation.output) {
			const error = append(body, $('.shuncode-bridge-tool-error'));
			error.textContent = activity.message;
		}
	}

	private bindDetailsToggle(card: HTMLDetailsElement, summary: HTMLElement, onDidToggle: (expanded: boolean) => void): void {
		const syncExpandedState = () => {
			summary.setAttribute('aria-expanded', String(card.open));
			onDidToggle(card.open);
		};

		summary.addEventListener('click', event => {
			event.preventDefault();
			card.open = !card.open;
			syncExpandedState();
		});
		card.addEventListener('toggle', syncExpandedState);
		syncExpandedState();
	}

	private renderEditSummaryItems(parent: HTMLElement, presentation: BridgeActivityPresentation): void {
		const items = (presentation.items ?? []).filter(item => item.kind === 'file');
		if (!items.length) {
			return;
		}
		const list = append(parent, $('.shuncode-bridge-edit-summary-files'));
		for (const item of items.slice(0, 8)) {
			const row = append(list, $<HTMLButtonElement>('button.shuncode-bridge-edit-summary-file'));
			row.type = 'button';
			const icon = append(row, $('span.shuncode-bridge-edit-summary-file-icon'));
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.file));
			append(row, $('span.shuncode-bridge-edit-summary-file-path', undefined, item.path));
			if (item.additions !== undefined || item.deletions !== undefined) {
				const stats = append(row, $('span.shuncode-bridge-edit-summary-file-stats'));
				append(stats, $('span.additions', undefined, `+${item.additions ?? 0}`));
				append(stats, $('span.deletions', undefined, `−${item.deletions ?? 0}`));
			}
			row.addEventListener('click', event => {
				event.preventDefault();
				event.stopPropagation();
				void this.commandService.executeCommand(BRIDGE_OPEN_RESOURCE, { path: item.path });
			});
		}
		if (items.length > 8) {
			append(list, $('span.shuncode-bridge-edit-summary-more', undefined, localize('shuncodeBridgeSession.moreEditedFiles', "{0} more files", items.length - 8)));
		}
	}

	private renderMiniDiff(parent: HTMLElement, presentation: BridgeActivityPresentation): void {
		if (!presentation.diffPreview?.length || !presentation.diff) {
			return;
		}
		const preview = append(parent, $('.shuncode-bridge-mini-diff'));
		for (const file of presentation.diffPreview) {
			const fileBlock = append(preview, $('.shuncode-bridge-mini-diff-file'));
			const header = append(fileBlock, $('.shuncode-bridge-mini-diff-header'));
			const fileButton = append(header, $<HTMLButtonElement>('button.shuncode-bridge-mini-diff-file-button'));
			fileButton.type = 'button';
			const fileIcon = append(fileButton, $('span'));
			fileIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.file));
			append(fileButton, $('span.shuncode-bridge-mini-diff-path', undefined, file.path));
			fileButton.addEventListener('click', () => void this.commandService.executeCommand(BRIDGE_OPEN_RESOURCE, { path: file.path }));

			const openDiff = append(header, $<HTMLButtonElement>('button.shuncode-bridge-mini-diff-open'));
			openDiff.type = 'button';
			openDiff.setAttribute('title', localize('shuncodeBridgeSession.openFullDiff', "Open full diff"));
			const diffIcon = append(openDiff, $('span'));
			diffIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.diff));
			openDiff.addEventListener('click', () => void this.commandService.executeCommand(BRIDGE_OPEN_DIFF, { diff: presentation.diff, path: file.path }));

			for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex += 1) {
				if (hunkIndex > 0) {
					append(fileBlock, $('div.shuncode-bridge-mini-diff-gap', undefined, '···'));
				}
				const hunk = file.hunks[hunkIndex];
				const code = append(fileBlock, $('.shuncode-bridge-mini-diff-code'));
				for (const line of hunk.lines) {
					const row = append(code, $(`div.shuncode-bridge-mini-diff-line.${line.kind}`));
					const lineNumber = line.kind === 'delete' ? line.oldLine : line.newLine;
					append(row, $('span.shuncode-bridge-mini-diff-line-number', undefined, lineNumber === undefined ? '' : String(lineNumber)));
					append(row, $('span.shuncode-bridge-mini-diff-marker', undefined, line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ''));
					const text = append(row, $('span.shuncode-bridge-mini-diff-text', undefined, line.text || ' '));
					text.setAttribute('title', line.text);
				}
				if (hunk.truncated) {
					append(code, $('div.shuncode-bridge-mini-diff-truncated', undefined, localize('shuncodeBridgeSession.diffMoreLines', "More changed lines…")));
				}
			}
			if (file.truncated) {
				append(fileBlock, $('div.shuncode-bridge-mini-diff-truncated', undefined, localize('shuncodeBridgeSession.diffMoreHunks', "More changes in this file…")));
			}
		}
	}

	private renderToolItems(parent: HTMLElement, presentation: BridgeActivityPresentation): void {
		const items: BridgeActivityItem[] = presentation.items ?? (presentation.files ?? []).map(path => ({ kind: 'file' as const, path }));
		if (!items.length) return;
		const container = append(parent, $('.shuncode-bridge-tool-items'));
		for (const item of items.slice(0, 40)) {
			const row = append(container, $('div.shuncode-bridge-tool-item'));
			if (item.severity) row.classList.add(`severity-${item.severity}`);
			row.tabIndex = 0;
			row.setAttribute('role', 'button');
			row.setAttribute('title', item.line ? `${item.path}:${item.line}:${item.column ?? 1}` : item.path);
			const icon = append(row, $('span.shuncode-bridge-tool-item-icon'));
			const itemIcon = item.kind === 'folder' ? Codicon.folder
				: item.kind === 'match' ? Codicon.search
					: item.kind === 'diagnostic' ? (item.severity === 'error' ? Codicon.error : item.severity === 'warning' ? Codicon.warning : Codicon.info)
						: item.kind === 'symbol' ? Codicon.symbolMethod : Codicon.file;
			icon.classList.add(...ThemeIcon.asClassNameArray(itemIcon));
			const labels = append(row, $('.shuncode-bridge-tool-item-labels'));
			append(labels, $('span.shuncode-bridge-tool-item-primary', undefined, item.label || item.path));
			const location = item.line ? `${item.path}:${item.line}${item.column ? `:${item.column}` : ''}` : (item.label ? item.path : undefined);
			const change = item.additions !== undefined || item.deletions !== undefined ? `+${item.additions ?? 0} -${item.deletions ?? 0}` : undefined;
			const secondary = [location, item.description, change].filter(Boolean).join(' · ');
			if (secondary) append(labels, $('span.shuncode-bridge-tool-item-secondary', undefined, secondary));

			const openResource = () => void this.commandService.executeCommand(BRIDGE_OPEN_RESOURCE, { path: item.path, line: item.line, column: item.column, folder: item.kind === 'folder' });
			row.addEventListener('click', openResource);
			row.addEventListener('keydown', event => {
				if (event.key === 'Enter' || event.key === ' ') {
					event.preventDefault();
					openResource();
				}
			});

			if (presentation.kind === 'edit' && presentation.diff && item.kind === 'file') {
				const diffButton = append(row, $<HTMLButtonElement>('button.shuncode-bridge-tool-item-action'));
				diffButton.type = 'button';
				diffButton.setAttribute('title', localize('shuncodeBridgeSession.openFileDiff', "Open file diff"));
				const diffIcon = append(diffButton, $('span'));
				diffIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.diff));
				diffButton.addEventListener('click', event => {
					event.stopPropagation();
					void this.commandService.executeCommand(BRIDGE_OPEN_DIFF, { diff: presentation.diff, path: item.path });
				});
			}
		}
		if (items.length > 40) append(container, $('span.shuncode-bridge-tool-more', undefined, localize('shuncodeBridgeSession.moreItems', "{0} more items", items.length - 40)));
	}

	private renderCodeSection(parent: HTMLElement, label: string, value: string | undefined): void {
		if (!value) {
			return;
		}
		const section = append(parent, $('.shuncode-bridge-tool-section'));
		append(section, $('span.shuncode-bridge-tool-section-label', undefined, label));
		const pre = append(section, $('pre'));
		pre.textContent = value;
	}

	private renderStatus(status: BridgeStatus): void {
		this.connectionDot.className = `shuncode-bridge-session-dot state-${status.connected ? 'connected' : status.state}`;
		this.connectionTitle.textContent = localize('shuncodeBridgeSession.mcpSession', "MCP session");
		if (this.footerCollapsed) {
			const compact: string[] = [status.connected
				? localize('shuncodeBridgeSession.connectedCompact', "Connected")
				: status.state === 'running'
					? localize('shuncodeBridgeSession.waitingCompact', "Waiting for MCP")
					: localize('shuncodeBridgeSession.disconnectedCompact', "Not connected")];
			compact.push(localize('shuncodeBridgeSession.toolCallsCompact', "{0} tool calls", status.stats.toolCalls));
			if (status.stats.completedToolCalls > 0) {
				compact.push(formatDuration(status.stats.averageDurationMs));
			}
			compact.push(`${status.stats.successRate.toFixed(status.stats.successRate === 100 ? 0 : 1)}%`);
			this.connectionDescription.textContent = compact.join(' · ');
		} else {
			this.connectionDescription.textContent = status.connected
				? localize('shuncodeBridgeSession.connected', "Connected · the external Agent can call ShunCode tools")
				: status.state === 'running'
					? localize('shuncodeBridgeSession.waitingConnection', "Bridge is running and waiting for the external MCP client")
					: status.lastError ?? localize('shuncodeBridgeSession.notRunning', "Bridge is not running");
		}

		clearNode(this.statsContainer);
		this.appendStat(localize('shuncodeBridgeSession.toolCalls', "Tool calls"), String(status.stats.toolCalls));
		this.appendStat(localize('shuncodeBridgeSession.averageResponse', "Average response"), formatDuration(status.stats.averageDurationMs));
		this.appendStat(localize('shuncodeBridgeSession.failures', "Failures"), String(status.stats.failedToolCalls));
		this.appendStat(localize('shuncodeBridgeSession.successRate', "Success rate"), `${status.stats.successRate.toFixed(status.stats.successRate === 100 ? 0 : 1)}%`);

		const pieces = [localize('shuncodeBridgeSession.transport', "Streamable HTTP")];
		if (status.activeRequests > 0) {
			pieces.push(localize('shuncodeBridgeSession.activeRequests', "{0} active", status.activeRequests));
		}
		if (status.stats.lastTool) {
			pieces.push(localize('shuncodeBridgeSession.lastTool', "Last tool: {0}", status.stats.lastTool));
		}
		const lastTime = formatTime(status.stats.lastToolAt);
		if (lastTime) {
			pieces.push(lastTime);
		}
		this.footerMeta.textContent = pieces.join(' · ');
		this.footerHint.textContent = status.connected
			? localize('shuncodeBridgeSession.outputOnlyHint', "Task progress is tracked in Work Sessions. Bridge remains output-only here; continue the conversation in the external client.")
			: localize('shuncodeBridgeSession.connectHint', "Open Bridge Settings to start or configure the Bridge, then connect the MCP URL from the external client. Task progress appears in Work Sessions.");
	}

	private appendStat(label: string, value: string): void {
		const stat = append(this.statsContainer, $('.shuncode-bridge-session-stat'));
		append(stat, $('span', undefined, label));
		append(stat, $('strong', undefined, value || '—'));
	}

	private renderControls(): void {
		const hasLog = (this.lastStatus?.activities.length ?? 0) > 0 || (this.lastStatus?.stats.toolCalls ?? 0) > 0;
		this.clearLogButton.enabled = !this.busy && hasLog;
		this.clearLogButton.label = `$(${Codicon.clearAll.id}) ${localize('shuncodeBridgeSession.clearLogShort', "Clear log")}`;
		const clearTitle = localize('shuncodeBridgeSession.clearLog', "Clear tool call log");
		this.clearLogButton.setTitle(clearTitle);
		this.clearLogButton.element.setAttribute('aria-label', clearTitle);
		this.renderFooterCollapsedState();
	}
}
