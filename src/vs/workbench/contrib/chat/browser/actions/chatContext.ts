/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { Codicon } from '../../../../../base/common/codicons.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { isElectron } from '../../../../../base/common/platform.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { agentHostAuthority } from '../../../../../platform/agentHost/common/agentHostUri.js';
import { IRemoteAgentHostService } from '../../../../../platform/agentHost/common/remoteAgentHostService.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../../common/editor.js';
import { DiffEditorInput } from '../../../../common/editor/diffEditorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { UntitledTextEditorInput } from '../../../../services/untitled/common/untitledTextEditorInput.js';
import { FileEditorInput } from '../../../files/browser/editors/fileEditorInput.js';
import { NotebookEditorInput } from '../../../notebook/common/notebookEditorInput.js';
import { CHAT_CONTEXT_TERMINAL_ID, IChatContextPickService, IChatContextValueItem, IChatContextPickerItem, IChatContextPickerPickItem, IChatContextPicker } from '../attachments/chatContextPickService.js';
import { IChatRequestToolEntry, IChatRequestToolSetEntry, IChatRequestVariableEntry, IImageVariableEntry, toToolSetVariableEntry, toToolVariableEntry } from '../../common/attachments/chatVariableEntries.js';
import { isToolSet, ToolDataSource } from '../../common/tools/languageModelToolsService.js';
import { ChatAgentLocation } from '../../common/constants.js';
import { IChatWidget } from '../chat.js';
import { imageToHash, isImage } from '../widget/input/editor/chatPasteProviders.js';
import { convertBufferToScreenshotVariable } from '../attachments/chatScreenshotContext.js';
import { ChatInstructionsPickerPick } from '../promptSyntax/attachInstructionsAction.js';
import { IChatSessionsService, isAgentHostTarget } from '../../common/chatSessionsService.js';
import { getAgentSessionProviderIcon, AgentSessionProviders } from '../agentSessions/agentSessions.js';
import { ITerminalService } from '../../../terminal/browser/terminal.js';
import { URI } from '../../../../../base/common/uri.js';
import { ITerminalCommand, TerminalCapability } from '../../../../../platform/terminal/common/capabilities/capabilities.js';
import { getChatSessionType } from '../../common/model/chatUri.js';
import { buildHostLocalEventsPath } from '../copilotCliEventsUri.js';

/**
 * Command ID that extensions can call to enable debug tools for the current
 * chat session. Sets the context key and immediately flushes tool updates so
 * that newly-enabled tools are visible on the next `vscode.lm.tools` read.
 */
export const EnableChatDebugToolsCommandId = 'chat.enableDebugTools';

export function shouldShowOpenEditorsContext(widget: Pick<IChatWidget, 'viewModel' | 'lockedAgentId'>, hasEligibleOpenEditors: boolean): boolean {
	if (!hasEligibleOpenEditors) {
		return false;
	}

	const sessionResource = widget.viewModel?.sessionResource;
	if (sessionResource && isAgentHostTarget(getChatSessionType(sessionResource))) {
		return false;
	}

	if (widget.lockedAgentId && isAgentHostTarget(widget.lockedAgentId)) {
		return false;
	}

	return true;
}

export class ChatContextContributions extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'chat.contextContributions';

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@IChatContextPickService contextPickService: IChatContextPickService,
	) {
		super();

		// ###############################################################################################
		//
		// Default context picks/values which are "native" to chat. This is NOT the complete list
		// and feature area specific context, like for notebooks, problems, etc, should be contributed
		// by the feature area.
		//
		// ###############################################################################################

		this._store.add(contextPickService.registerChatContextItem(instantiationService.createInstance(ToolsContextPickerPick)));
		this._store.add(contextPickService.registerChatContextItem(instantiationService.createInstance(ChatInstructionsPickerPick)));
		this._store.add(contextPickService.registerChatContextItem(instantiationService.createInstance(OpenEditorContextValuePick)));
		this._store.add(contextPickService.registerChatContextItem(instantiationService.createInstance(ClipboardImageContextValuePick)));
		this._store.add(contextPickService.registerChatContextItem(instantiationService.createInstance(ScreenshotContextValuePick)));
		this._store.add(contextPickService.registerChatContextItem(instantiationService.createInstance(SessionReferenceContextPickerPick)));
	}
}

class ToolsContextPickerPick implements IChatContextPickerItem {

	readonly type = 'pickerPick';
	readonly label: string = localize('chatContext.tools', 'Tools...');
	readonly icon: ThemeIcon = Codicon.tools;
	readonly ordinal = -500;

	isEnabled(widget: IChatWidget): boolean {
		return !!widget.attachmentCapabilities.supportsToolAttachments;
	}

	asPicker(widget: IChatWidget): IChatContextPicker {

		type Pick = IChatContextPickerPickItem & { toolInfo: { ordinal: number; label: string } };
		const items: Pick[] = [];

		for (const [entry, enabled] of widget.input.selectedToolsModel.entriesMap.get()) {
			if (enabled) {
				if (isToolSet(entry)) {
					items.push({
						toolInfo: ToolDataSource.classify(entry.source),
						label: entry.referenceName,
						description: entry.description,
						asAttachment: (): IChatRequestToolSetEntry => toToolSetVariableEntry(entry)
					});
				} else {
					items.push({
						toolInfo: ToolDataSource.classify(entry.source),
						label: entry.toolReferenceName ?? entry.displayName,
						description: entry.userDescription ?? entry.modelDescription,
						asAttachment: (): IChatRequestToolEntry => toToolVariableEntry(entry)
					});
				}
			}
		}

		items.sort((a, b) => {
			let res = a.toolInfo.ordinal - b.toolInfo.ordinal;
			if (res === 0) {
				res = a.toolInfo.label.localeCompare(b.toolInfo.label);
			}
			if (res === 0) {
				res = a.label.localeCompare(b.label);
			}
			return res;
		});

		let lastGroupLabel: string | undefined;
		const picks: (IQuickPickSeparator | Pick)[] = [];

		for (const item of items) {
			if (lastGroupLabel !== item.toolInfo.label) {
				picks.push({ type: 'separator', label: item.toolInfo.label });
				lastGroupLabel = item.toolInfo.label;
			}
			picks.push(item);
		}

		return {
			placeholder: localize('chatContext.tools.placeholder', 'Select a tool'),
			picks: Promise.resolve(picks)
		};
	}


}



class OpenEditorContextValuePick implements IChatContextValueItem {

	readonly type = 'valuePick';
	readonly label: string = localize('chatContext.editors', 'Open Editors');
	readonly icon: ThemeIcon = Codicon.file;
	readonly ordinal = 800;

	constructor(
		@IEditorService private _editorService: IEditorService,
		@ILabelService private _labelService: ILabelService,
	) { }

	isEnabled(widget: IChatWidget): Promise<boolean> | boolean {
		const hasEligibleOpenEditors = this._editorService.editors.some(e => e instanceof FileEditorInput || e instanceof DiffEditorInput || e instanceof UntitledTextEditorInput);
		return shouldShowOpenEditorsContext(widget, hasEligibleOpenEditors);
	}

	async asAttachment(): Promise<IChatRequestVariableEntry[]> {
		const result: IChatRequestVariableEntry[] = [];
		for (const editor of this._editorService.editors) {
			if (!(editor instanceof FileEditorInput || editor instanceof DiffEditorInput || editor instanceof UntitledTextEditorInput || editor instanceof NotebookEditorInput)) {
				continue;
			}
			const uri = EditorResourceAccessor.getOriginalUri(editor, { supportSideBySide: SideBySideEditor.PRIMARY });
			if (!uri) {
				continue;
			}
			result.push({
				kind: 'file',
				id: uri.toString(),
				value: uri,
				name: this._labelService.getUriBasenameLabel(uri),
			});
		}
		return result;
	}

}


class ClipboardImageContextValuePick implements IChatContextValueItem {
	readonly type = 'valuePick';
	readonly label = localize('imageFromClipboard', 'Image from Clipboard');
	readonly icon = Codicon.fileMedia;

	constructor(
		@IClipboardService private readonly _clipboardService: IClipboardService,
	) { }

	async isEnabled(widget: IChatWidget) {
		if (!widget.attachmentCapabilities.supportsImageAttachments) {
			return false;
		}
		if (!widget.input.selectedLanguageModel.get()?.metadata.capabilities?.vision) {
			return false;
		}
		const imageData = await this._clipboardService.readImage();
		return isImage(imageData);
	}

	async asAttachment(): Promise<IImageVariableEntry> {
		const fileBuffer = await this._clipboardService.readImage();
		return {
			id: await imageToHash(fileBuffer),
			name: localize('pastedImage', 'Pasted Image'),
			fullName: localize('pastedImage', 'Pasted Image'),
			value: fileBuffer,
			kind: 'image',
		};
	}
}

const TERMINAL_SELECTION_MAX_CHARS = 64_000;
const TERMINAL_SELECTION_MAX_LINES = 400;
const TERMINAL_COMMAND_MAX_CHARS = 48_000;
const TERMINAL_COMMAND_MAX_LINES = 300;
const TERMINAL_TAB_MAX_CHARS = 32_000;
const TERMINAL_TAB_MAX_LINES = 200;
const TERMINAL_TAB_MAX_COMMANDS = 6;

function boundTerminalContextText(value: string, maxLines: number, maxChars: number, strategy: 'middle' | 'tail'): { text: string; truncated: boolean } {
	let text = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	let truncated = false;
	const lines = text.split('\n');
	if (lines.length > maxLines) {
		truncated = true;
		if (strategy === 'tail') {
			text = `[terminal context truncated: showing most recent ${maxLines} lines]\n${lines.slice(-maxLines).join('\n')}`;
		} else {
			const headLines = Math.floor(maxLines / 2);
			const tailLines = maxLines - headLines;
			text = `${lines.slice(0, headLines).join('\n')}\n[terminal context truncated: omitted middle lines]\n${lines.slice(-tailLines).join('\n')}`;
		}
	}
	if (text.length > maxChars) {
		truncated = true;
		if (strategy === 'tail') {
			const marker = `[terminal context truncated: showing most recent ${maxChars} characters]\n`;
			text = marker + text.slice(-(maxChars - marker.length));
		} else {
			const marker = '\n[terminal context truncated: omitted middle characters]\n';
			const available = Math.max(0, maxChars - marker.length);
			const headChars = Math.floor(available * 0.45);
			const tailChars = available - headChars;
			text = text.slice(0, headChars) + marker + text.slice(-tailChars);
		}
	}
	return { text, truncated };
}

export class TerminalContext implements IChatContextValueItem {

	readonly id = CHAT_CONTEXT_TERMINAL_ID;
	readonly type = 'valuePick';
	readonly icon = Codicon.terminal;
	readonly label = localize('terminal', 'Terminal');
	constructor(private readonly _resource: URI, @ITerminalService private readonly _terminalService: ITerminalService) {

	}
	isEnabled(widget: IChatWidget) {
		const terminal = this._terminalService.getInstanceFromResource(this._resource);
		return !!widget.attachmentCapabilities.supportsTerminalAttachments && terminal?.isDisposed === false;
	}
	async asAttachment(widget: IChatWidget): Promise<IChatRequestVariableEntry | undefined> {
		const terminal = this._terminalService.getInstanceFromResource(this._resource);
		if (!terminal) {
			return;
		}
		const params = new URLSearchParams(this._resource.query);
		const commandId = params.get('command');
		const command = commandId
			? terminal.capabilities.get(TerminalCapability.CommandDetection)?.commands.find(cmd => cmd.id === commandId)
			: undefined;

		let attachment: IChatRequestVariableEntry;
		if (command) {
			const boundedOutput = boundTerminalContextText(command.getOutput() ?? '', TERMINAL_COMMAND_MAX_LINES, TERMINAL_COMMAND_MAX_CHARS, 'middle').text;
			attachment = {
				kind: 'terminalCommand',
				id: `terminalCommand:${Date.now()}`,
				value: this.asValue(command, boundedOutput),
				name: command.command,
				command: command.command,
				output: boundedOutput || undefined,
				exitCode: command.exitCode,
				resource: this._resource
			};
		} else {
			const selection = terminal.selection?.trim();
			if (selection) {
				const bounded = boundTerminalContextText(selection, TERMINAL_SELECTION_MAX_LINES, TERMINAL_SELECTION_MAX_CHARS, 'middle');
				attachment = {
					kind: 'terminalCommand',
					id: `terminalSelection:${Date.now()}`,
					value: `Terminal: ${terminal.title}\nSelection:\n${bounded.text}`,
					name: `${terminal.title} selection`,
					command: 'Terminal selection',
					output: bounded.text,
					resource: this._resource
				};
			} else {
				const detectedCommands = terminal.capabilities.get(TerminalCapability.CommandDetection)?.commands
					.filter(cmd => cmd.command?.trim())
					.slice(-TERMINAL_TAB_MAX_COMMANDS) ?? [];
				let snapshot = '';
				if (detectedCommands.length > 0) {
					snapshot = detectedCommands.map(cmd => {
						const parts = [`Command: ${cmd.command}`];
						const output = cmd.getOutput();
						if (output) parts.push(`Output:\n${output}`);
						if (typeof cmd.exitCode === 'number') parts.push(`Exit Code: ${cmd.exitCode}`);
						return parts.join('\n');
					}).join('\n\n---\n\n');
				} else {
					const xterm = await terminal.xtermReadyPromise;
					if (xterm) {
						const recentLines = [...xterm.getBufferReverseIterator()].slice(0, TERMINAL_TAB_MAX_LINES * 2).reverse();
						snapshot = recentLines.join('\n');
					}
				}
				const bounded = boundTerminalContextText(snapshot.trim(), TERMINAL_TAB_MAX_LINES, TERMINAL_TAB_MAX_CHARS, 'tail');
				if (!bounded.text.trim()) {
					return;
				}
				attachment = {
					kind: 'terminalCommand',
					id: `terminalContext:${Date.now()}`,
					value: `Terminal: ${terminal.title}\nRecent context snapshot:\n${bounded.text}`,
					name: terminal.title,
					command: `Terminal context: ${terminal.title}`,
					output: bounded.text,
					resource: this._resource
				};
			}
		}
		const cleanup = new DisposableStore();
		let disposed = false;
		const disposeCleanup = () => {
			if (disposed) {
				return;
			}
			disposed = true;
			cleanup.dispose();
		};
		cleanup.add(widget.attachmentModel.onDidChange(e => {
			if (e.deleted.includes(attachment.id)) {
				disposeCleanup();
			}
		}));
		cleanup.add(terminal.onDisposed(() => {
			widget.attachmentModel.delete(attachment.id);
			widget.refreshParsedInput();
			disposeCleanup();
		}));
		return attachment;
	}

	private asValue(command: ITerminalCommand, output: string): string {
		let value = `Command: ${command.command}`;
		if (output) {
			value += `\nOutput:\n${output}`;
		}
		if (typeof command.exitCode === 'number') {
			value += `\nExit Code: ${command.exitCode}`;
		}
		return value;
	}
}

class ScreenshotContextValuePick implements IChatContextValueItem {

	readonly type = 'valuePick';
	readonly icon = Codicon.deviceCamera;
	readonly label = (isElectron
		? localize('chatContext.attachScreenshot.labelElectron.Window', 'Screenshot Window')
		: localize('chatContext.attachScreenshot.labelWeb', 'Screenshot'));

	constructor(
		@IHostService private readonly _hostService: IHostService,
	) { }

	async isEnabled(widget: IChatWidget) {
		return !!widget.attachmentCapabilities.supportsImageAttachments && !!widget.input.selectedLanguageModel.get()?.metadata.capabilities?.vision;
	}

	async asAttachment(): Promise<IChatRequestVariableEntry | undefined> {
		const blob = await this._hostService.getScreenshot();
		return blob && convertBufferToScreenshotVariable(blob);
	}
}

class SessionReferenceContextPickerPick implements IChatContextPickerItem {

	readonly type = 'pickerPick';
	readonly icon = Codicon.comment;
	readonly label = localize('chatContext.sessions', 'Sessions...');
	readonly ordinal = -400;

	constructor(
		@IChatSessionsService private readonly _chatSessionsService: IChatSessionsService,
		@IPathService private readonly _pathService: IPathService,
		@IRemoteAgentHostService private readonly _remoteAgentHostService: IRemoteAgentHostService,
	) { }

	isEnabled(widget: IChatWidget): boolean {
		return widget.location === ChatAgentLocation.Chat;
	}

	asPicker(widget: IChatWidget): IChatContextPicker {
		const currentSessionResource = widget.viewModel?.sessionResource;
		const onlyShowAttachableCopilotCliSessions = !!currentSessionResource && isAgentHostTarget(getChatSessionType(currentSessionResource));
		return {
			placeholder: localize('chatContext.sessions.placeholder', 'Select a session'),
			picks: (async () => {
				const picks: IChatContextPickerPickItem[] = [];
				const sessionProviderFilter = [AgentSessionProviders.Local, AgentSessionProviders.Background, AgentSessionProviders.Claude, AgentSessionProviders.AgentHostCopilot];
				for await (const group of this._chatSessionsService.getChatSessionItems(sessionProviderFilter, CancellationToken.None)) {
					const providerIcon = getAgentSessionProviderIcon(group.chatSessionType);
					for (const item of group.items) {
						if (currentSessionResource && item.resource.toString() === currentSessionResource.toString()) {
							continue;
						}
						const sessionResource = item.resource;
						if (onlyShowAttachableCopilotCliSessions && !this._canAttachCopilotCliSession(sessionResource)) {
							continue;
						}
						const icon = item.iconPath ?? providerIcon;
						picks.push({
							label: item.label,
							description: new Date(item.timing.lastRequestEnded ?? item.timing.created).toLocaleString(),
							asAttachment: (): IChatRequestVariableEntry => ({
								kind: 'sessionReference',
								id: sessionResource.toString(),
								name: item.label,
								value: sessionResource,
								icon,
							})
						});
					}
				}
				picks.sort((a, b) => (b.description ?? '').localeCompare(a.description ?? ''));
				return picks;
			})()
		};
	}

	private _canAttachCopilotCliSession(sessionResource: URI): boolean {
		// For now, attachments while in an Agent Host Copilot harness are attachable when backed by Copilot CLI events.jsonl.
		return !!buildHostLocalEventsPath(
			sessionResource,
			this._pathService.userHome({ preferLocal: true }),
			authority => this._remoteAgentHostService.connections.find(connection => agentHostAuthority(connection.address) === authority),
		);
	}
}
