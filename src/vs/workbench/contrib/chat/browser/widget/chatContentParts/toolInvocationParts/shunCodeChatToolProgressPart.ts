/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/shunCodeChatToolProgressPart.css';
import * as dom from '../../../../../../../base/browser/dom.js';
import { Codicon } from '../../../../../../../base/common/codicons.js';
import { IMarkdownString } from '../../../../../../../base/common/htmlContent.js';
import { isUriComponents, URI } from '../../../../../../../base/common/uri.js';
import { ThemeIcon } from '../../../../../../../base/common/themables.js';
import { localize } from '../../../../../../../nls.js';
import { ICommandService } from '../../../../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../../../../platform/opener/common/opener.js';
import { IChatSimpleToolInvocationData, IChatToolInvocation, IChatToolInvocationSerialized } from '../../../../common/chatService/chatService.js';
import { IChatCodeBlockInfo } from '../../../chat.js';
import { ChatCollapsibleContentPart } from '../chatCollapsibleContentPart.js';
import { BaseChatToolInvocationSubPart } from './chatToolInvocationSubPart.js';

type ShunCodePresentationKind = NonNullable<IChatSimpleToolInvocationData['presentationKind']>;

function messageText(message: string | IMarkdownString | undefined): string {
	return typeof message === 'string' ? message : message?.value ?? '';
}

function formatDuration(durationMs: number | undefined): string {
	if (durationMs === undefined) return '';
	if (durationMs < 1000) return `${durationMs} ms`;
	return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function presentationIcon(kind: ShunCodePresentationKind) {
	switch (kind) {
		case 'files': return Codicon.files;
		case 'search': return Codicon.search;
		case 'edit': return Codicon.edit;
		case 'terminal': return Codicon.terminal;
		case 'diagnostics': return Codicon.warning;
		case 'lsp': return Codicon.symbolMethod;
		default: return Codicon.tools;
	}
}

export class ShunCodeChatToolProgressPart extends BaseChatToolInvocationSubPart {
	private static readonly expandedState = new Map<string, boolean>();

	public readonly domNode: HTMLElement;
	public readonly codeblocks: IChatCodeBlockInfo[] = [];

	constructor(
		toolInvocation: IChatToolInvocation | IChatToolInvocationSerialized,
		message: string | IMarkdownString,
		subtitle: string | IMarkdownString | undefined,
		data: IChatSimpleToolInvocationData,
		@IOpenerService private readonly openerService: IOpenerService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(toolInvocation);

		const kind = data.presentationKind ?? 'generic';
		const isComplete = IChatToolInvocation.isComplete(toolInvocation);
		const isError = data.isError === true;
		const state = isError ? 'error' : isComplete ? 'completed' : 'running';
		const activity = dom.$<HTMLDetailsElement>('details.shuncode-chat-activity');
		activity.open = ShunCodeChatToolProgressPart.expandedState.get(toolInvocation.toolCallId) ?? false;
		activity.classList.add(`state-${state}`, `kind-${kind}`);

		const header = dom.append(activity, dom.$('summary.shuncode-chat-activity-header'));
		const icon = dom.append(header, dom.$('span.shuncode-chat-activity-icon'));
		const iconValue = state === 'running' ? ThemeIcon.modify(Codicon.loading, 'spin') : isError ? Codicon.error : presentationIcon(kind);
		icon.classList.add(...ThemeIcon.asClassNameArray(iconValue));

		const labels = dom.append(header, dom.$('.shuncode-chat-activity-labels'));
		const title = messageText(message) || localize('shuncodeChatTool.working', "Working…");
		dom.append(labels, dom.$('span.shuncode-chat-activity-title', undefined, title));
		const secondary = data.summary || messageText(subtitle);
		if (secondary) dom.append(labels, dom.$('span.shuncode-chat-activity-subtitle', undefined, secondary));

		const meta = dom.append(header, dom.$('span.shuncode-chat-activity-meta'));
		meta.textContent = state === 'running'
			? localize('shuncodeChatTool.running', "Running…")
			: state === 'error'
				? localize('shuncodeChatTool.failed', "Failed")
				: formatDuration(data.durationMs) || localize('shuncodeChatTool.completed', "Completed");

		const syncExpandedState = () => {
			header.setAttribute('aria-expanded', String(activity.open));
			ShunCodeChatToolProgressPart.expandedState.set(toolInvocation.toolCallId, activity.open);
		};
		this._register(dom.addDisposableListener(header, dom.EventType.CLICK, event => {
			event.preventDefault();
			// Chat rows are virtualized. Notify the list before changing the details
			// height so it can observe the resize and update the row measurement.
			activity.dispatchEvent(new CustomEvent(ChatCollapsibleContentPart.userToggleEvent, { bubbles: true }));
			activity.open = !activity.open;
			syncExpandedState();
		}));
		this._register(dom.addDisposableListener(activity, 'toggle', syncExpandedState));
		syncExpandedState();

		if (kind === 'edit') this.renderEditSummary(header, data);
		const body = dom.append(activity, dom.$('.shuncode-chat-activity-body'));
		if (kind !== 'edit') this.renderItems(body, data, kind);
		this.renderMiniDiff(body, data);
		this.renderActions(body, data);
		this.renderMetrics(body, data);
		this.renderCodeSection(body, localize('shuncodeChatTool.input', "Input"), data.input);
		this.renderCodeSection(body, localize('shuncodeChatTool.output', "Output"), data.output);

		this.domNode = activity;
	}

	private renderMetrics(parent: HTMLElement, data: IChatSimpleToolInvocationData): void {
		if (!data.metrics?.length) return;
		const metrics = dom.append(parent, dom.$('.shuncode-chat-activity-metrics'));
		metrics.textContent = data.metrics.map(metric => `${metric.label} ${metric.value}`).join(' · ');
	}

	private renderEditSummary(parent: HTMLElement, data: IChatSimpleToolInvocationData): void {
		if (!data.items?.length) return;
		const items = dom.append(parent, dom.$('.shuncode-chat-edit-files'));
		for (const item of data.items.slice(0, 12)) {
			const row = this.createResourceRow(items, item, 'edit');
			row.classList.add('shuncode-chat-edit-file');
		}
	}

	private renderItems(parent: HTMLElement, data: IChatSimpleToolInvocationData, kind: ShunCodePresentationKind): void {
		if (!data.items?.length) return;
		const items = dom.append(parent, dom.$('.shuncode-chat-activity-items'));
		for (const item of data.items.slice(0, 40)) this.createResourceRow(items, item, kind);
		if (data.items.length > 40) {
			dom.append(items, dom.$('span.shuncode-chat-activity-more', undefined, localize('shuncodeChatTool.moreItems', "{0} more items", data.items.length - 40)));
		}
	}

	private createResourceRow(parent: HTMLElement, item: NonNullable<IChatSimpleToolInvocationData['items']>[number], kind: ShunCodePresentationKind): HTMLElement {
		const row = dom.append(parent, item.resource ? dom.$<HTMLAnchorElement>('a.shuncode-chat-activity-item') : dom.$('.shuncode-chat-activity-item'));
		const icon = dom.append(row, dom.$('span.shuncode-chat-activity-item-icon'));
		const itemIcon = kind === 'search' ? Codicon.search : kind === 'diagnostics' ? Codicon.warning : kind === 'lsp' ? Codicon.symbolMethod : Codicon.file;
		icon.classList.add(...ThemeIcon.asClassNameArray(itemIcon));
		const labels = dom.append(row, dom.$('.shuncode-chat-activity-item-labels'));
		dom.append(labels, dom.$('span.shuncode-chat-activity-item-primary', undefined, item.label));
		if (item.description) dom.append(labels, dom.$('span.shuncode-chat-activity-item-secondary', undefined, item.description));
		if (item.added !== undefined || item.removed !== undefined) {
			const diff = dom.append(row, dom.$('span.shuncode-chat-activity-item-diff'));
			if (item.added !== undefined) dom.append(diff, dom.$('span.additions', undefined, `+${item.added}`));
			if (item.removed !== undefined) dom.append(diff, dom.$('span.deletions', undefined, `−${item.removed}`));
		}
		if (item.resource) {
			const resource = URI.isUri(item.resource) ? item.resource : isUriComponents(item.resource) ? URI.revive(item.resource) : URI.revive(item.resource.uri);
			(row as HTMLAnchorElement).href = resource.toString();
			this._register(dom.addDisposableListener(row, dom.EventType.CLICK, event => {
				event.stopPropagation();
				event.preventDefault();
				void this.openerService.open(resource, { fromUserGesture: true });
			}));
		}
		return row;
	}

	private renderMiniDiff(parent: HTMLElement, data: IChatSimpleToolInvocationData): void {
		if (!data.diffPreview?.length || !data.diff) return;
		const preview = dom.append(parent, dom.$('.shuncode-chat-mini-diff'));
		for (const file of data.diffPreview) {
			const fileBlock = dom.append(preview, dom.$('.shuncode-chat-mini-diff-file'));
			const header = dom.append(fileBlock, dom.$('.shuncode-chat-mini-diff-header'));
			const fileButton = dom.append(header, dom.$<HTMLButtonElement>('button.shuncode-chat-mini-diff-file-button'));
			fileButton.type = 'button';
			const fileIcon = dom.append(fileButton, dom.$('span'));
			fileIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.file));
			dom.append(fileButton, dom.$('span.shuncode-chat-mini-diff-path', undefined, file.path));
			this._register(dom.addDisposableListener(fileButton, dom.EventType.CLICK, () => void this.commandService.executeCommand('shuncode.bridge.openResource', { path: file.path })));
			const openDiff = dom.append(header, dom.$<HTMLButtonElement>('button.shuncode-chat-mini-diff-open'));
			openDiff.type = 'button';
			openDiff.title = localize('shuncodeChatTool.openFullDiff', "Open full diff");
			const diffIcon = dom.append(openDiff, dom.$('span'));
			diffIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.diff));
			this._register(dom.addDisposableListener(openDiff, dom.EventType.CLICK, () => void this.commandService.executeCommand('shuncode.bridge.openDiff', { diff: data.diff, path: file.path })));
			for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex += 1) {
				if (hunkIndex > 0) dom.append(fileBlock, dom.$('.shuncode-chat-mini-diff-gap', undefined, '···'));
				const code = dom.append(fileBlock, dom.$('.shuncode-chat-mini-diff-code'));
				for (const line of file.hunks[hunkIndex]!.lines) {
					const row = dom.append(code, dom.$(`.shuncode-chat-mini-diff-line.${line.kind}`));
					const lineNumber = line.kind === 'delete' ? line.oldLine : line.newLine;
					dom.append(row, dom.$('span.shuncode-chat-mini-diff-line-number', undefined, lineNumber === undefined ? '' : String(lineNumber)));
					dom.append(row, dom.$('span.shuncode-chat-mini-diff-marker', undefined, line.kind === 'add' ? '+' : line.kind === 'delete' ? '−' : ''));
					const text = dom.append(row, dom.$('span.shuncode-chat-mini-diff-text', undefined, line.text || ' '));
					text.title = line.text;
				}
				if (file.hunks[hunkIndex]!.truncated) dom.append(code, dom.$('.shuncode-chat-mini-diff-truncated', undefined, localize('shuncodeChatTool.moreChangedLines', "More changed lines…")));
			}
			if (file.truncated) dom.append(fileBlock, dom.$('.shuncode-chat-mini-diff-truncated', undefined, localize('shuncodeChatTool.moreChanges', "More changes in this file…")));
		}
	}

	private renderActions(parent: HTMLElement, data: IChatSimpleToolInvocationData): void {
		if (!data.terminalId) return;
		const actions = dom.append(parent, dom.$('.shuncode-chat-activity-actions'));
		const button = dom.append(actions, dom.$<HTMLButtonElement>('button.shuncode-chat-activity-action'));
		button.type = 'button';
		const icon = dom.append(button, dom.$('span'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.terminal));
		dom.append(button, dom.$('span', undefined, localize('shuncodeChatTool.openTerminal', "Open Terminal")));
		this._register(dom.addDisposableListener(button, dom.EventType.CLICK, () => void this.commandService.executeCommand('shuncode.bridge.openTerminal', data.terminalId)));
	}

	private renderCodeSection(parent: HTMLElement, label: string, value: string): void {
		if (!value) return;
		const section = dom.append(parent, dom.$('.shuncode-chat-activity-section'));
		dom.append(section, dom.$('span.shuncode-chat-activity-section-label', undefined, label));
		const pre = dom.append(section, dom.$('pre'));
		pre.textContent = value;
	}
}
