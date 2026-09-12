/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ShunCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { isRequestVM, isResponseVM } from '../../common/model/chatViewModel.js';
import { ChatTreeItem, IChatWidget, IChatWidgetService } from '../chat.js';
import { IChatBranchService } from '../chatBranchService.js';
import { CHAT_CATEGORY } from './chatActions.js';
import { IChatService } from '../../common/chatService/chatService.js';

/**
 * ShunCode multi-model footer actions: navigate between branch variants
 * (◀ ▶), start the merge summary round (合并总结) and adopt the current
 * variant as the canonical one (采纳).
 */

function getBranchRowContext(accessor: ServicesAccessor, args: unknown[]): { widget: IChatWidget; rowId: string } | undefined {
	const element = args[0] as ChatTreeItem | undefined;
	const widgetService = accessor.get(IChatWidgetService);
	const widget = widgetService.lastFocusedWidget;
	if (!widget?.viewModel) {
		return undefined;
	}
	const item = (element && (isRequestVM(element) || isResponseVM(element))) ? element : widget.getFocus();
	if (!item) {
		return undefined;
	}
	return { widget, rowId: item.id };
}

class ChatBranchNavigateAction extends Action2 {
	constructor(private readonly direction: 'next' | 'previous') {
		const isNext = direction === 'next';
		super({
			id: isNext ? 'workbench.action.chat.shuncode.branchNext' : 'workbench.action.chat.shuncode.branchPrev',
			title: isNext ? localize2('shuncode.branch.next', "▶") : localize2('shuncode.branch.prev', "◀"),
			f1: false,
			category: CHAT_CATEGORY,
			menu: {
				id: MenuId.ChatMessageFooter,
				group: 'navigation',
				order: direction === 'next' ? 0.55 : 0.5,
				when: ContextKeyExpr.and(
					ChatContextKeys.isResponse,
					isNext ? ChatContextKeys.shunCodeBranchHasNext : ChatContextKeys.shunCodeBranchHasPrev
				),
			}
		});
	}

	override run(accessor: ServicesAccessor, ...args: unknown[]): void {
		const context = getBranchRowContext(accessor, args);
		if (!context) {
			return;
		}
		const branchService = accessor.get(IChatBranchService);
		const viewModel = context.widget.viewModel;
		if (!viewModel) {
			return;
		}
		const sessionResource = viewModel.sessionResource;
		if (!sessionResource) {
			return;
		}
		const info = branchService.getRowInfo(sessionResource, context.rowId);
		if (!info) {
			return;
		}
		// Strictly serial: no variant switching while a request is in flight.
		const model = viewModel.model;
		if (model.requestInProgress.get() || model.hasActiveRequest.get()) {
			return;
		}
		const targetIndex = info.variantIndex + (this.direction === 'next' ? 1 : -1);
		const target = info.group.variants[targetIndex];
		if (!target) {
			return;
		}
		// Switch the variant shown inside the group's container; the list
		// re-renders that row in place (no question rows are revealed).
		branchService.setActiveVariant(sessionResource, info.group.id, target.requestId);
	}
}

class ChatBranchMergeAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.shuncode.branchMerge',
			title: localize2('shuncode.branch.merge', "合并总结"),
			f1: false,
			category: CHAT_CATEGORY,
			icon: Codicon.gitMerge,
			menu: {
				id: MenuId.ChatMessageFooter,
				group: 'navigation',
				order: 1.2,
				when: ContextKeyExpr.and(ChatContextKeys.isResponse, ChatContextKeys.shunCodeBranchCanMerge),
			}
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const context = getBranchRowContext(accessor, args);
		if (!context) {
			return;
		}
		const { widget, rowId } = context;
		const sessionResource = widget.viewModel?.sessionResource;
		if (!sessionResource) {
			return;
		}
		const model = widget.viewModel.model;
		// Strictly serial: never start a merge while a request is in flight.
		if (model.requestInProgress.get() || model.hasActiveRequest.get()) {
			return;
		}
		// Only offer merges while the multi-model feature is enabled.
		if (!(accessor.get(IConfigurationService).getValue<boolean>('shuncode.multiModel.enabled') ?? true)) {
			return;
		}
		const branchService = accessor.get(IChatBranchService);
		const info = branchService.getRowInfo(sessionResource, rowId);
		if (!info || info.canMerge === false) {
			return;
		}
		await widget.acceptInput(undefined, {
			shunCodeBranchIntent: { kind: 'merge', groupId: info.group.id },
			forceEmptyInput: true,
			isSystemInitiated: true,
			systemInitiatedLabel: '合并总结',
		});
	}
}

class ChatBranchAdoptAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.shuncode.branchAdopt',
			title: localize2('shuncode.branch.adopt', "采纳"),
			f1: false,
			category: CHAT_CATEGORY,
			icon: Codicon.check,
			menu: {
				id: MenuId.ChatMessageFooter,
				group: 'navigation',
				order: 1.4,
				when: ContextKeyExpr.and(ChatContextKeys.isResponse, ChatContextKeys.shunCodeBranchCanAdopt),
			}
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const context = getBranchRowContext(accessor, args);
		if (!context) {
			return;
		}
		const { widget, rowId } = context;
		const sessionResource = widget.viewModel?.sessionResource;
		if (!sessionResource) {
			return;
		}
		const branchService = accessor.get(IChatBranchService);
		const info = branchService.getRowInfo(sessionResource, rowId);
		if (!info) {
			return;
		}
		const variant = info.group.variants[info.variantIndex];
		branchService.adoptVariant(sessionResource, variant.requestId);
		// Persist the canonical choice in the extension's durable branch state.
		await accessor.get(ICommandService).executeCommand('shuncode.branch.adoptVariant', info.group.id, variant.requestId);
	}
}


class ChatBranchDeleteAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.chat.shuncode.branchDelete',
			title: localize2('shuncode.branch.delete', "删除分支"),
			f1: false,
			category: CHAT_CATEGORY,
			icon: Codicon.trash,
			menu: {
				id: MenuId.ChatMessageFooter,
				group: 'navigation',
				order: 1.6,
				when: ContextKeyExpr.and(ChatContextKeys.isResponse, ChatContextKeys.shunCodeBranchCanDelete),
			}
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const context = getBranchRowContext(accessor, args);
		if (!context) {
			return;
		}
		const { widget, rowId } = context;
		const sessionResource = widget.viewModel?.sessionResource;
		if (!sessionResource) {
			return;
		}
		const model = widget.viewModel.model;
		// Strictly serial: never remove a variant while a request is in flight.
		if (model.requestInProgress.get() || model.hasActiveRequest.get()) {
			return;
		}
		const branchService = accessor.get(IChatBranchService);
		const info = branchService.getRowInfo(sessionResource, rowId);
		if (!info || info.canDelete === false) {
			return;
		}
		const variant = info.group.variants[info.variantIndex];
		await accessor.get(IChatService).removeRequest(sessionResource, variant.requestId);
		branchService.removeRequest(sessionResource, variant.requestId);
	}
}
export function registerChatBranchActions(): void {
	registerAction2(class ChatBranchPrevAction extends ChatBranchNavigateAction {
		constructor() { super('previous'); }
	});
	registerAction2(class ChatBranchNextAction extends ChatBranchNavigateAction {
		constructor() { super('next'); }
	});
	registerAction2(ChatBranchMergeAction);
	registerAction2(ChatBranchAdoptAction);
	registerAction2(ChatBranchDeleteAction);
}
