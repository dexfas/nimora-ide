/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../../../../../base/common/cancellation.js';
import { localize } from '../../../../../nls.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { CountTokensCallback, IToolData, IToolImpl, IToolInvocation, IToolResult, ToolDataSource, ToolProgress } from '../../../chat/common/tools/languageModelToolsService.js';
import { BrowserViewSharingState, IBrowserViewWorkbenchService } from '../../common/browserView.js';

export const ActivateBrowserPageToolData: IToolData = {
	id: 'activate_browser_page',
	displayName: localize('activateBrowserPageTool.displayName', 'Activate Browser Page'),
	userDescription: localize('activateBrowserPageTool.userDescription', 'Activate an already-shared browser page'),
	modelDescription: 'Makes an already-shared integrated browser page visible without navigating or creating a page.',
	source: ToolDataSource.Internal,
	canBeReferencedInPrompt: false,
	inputSchema: {
		type: 'object',
		properties: {
			pageId: {
				type: 'string',
				description: 'The exact already-shared browser page ID to activate.'
			},
		},
		required: ['pageId'],
	},
};

interface IActivateBrowserPageToolParams {
	pageId: string;
}

export class ActivateBrowserPageTool implements IToolImpl {
	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IBrowserViewWorkbenchService private readonly browserViewService: IBrowserViewWorkbenchService,
	) { }

	async invoke(invocation: IToolInvocation, _countTokens: CountTokensCallback, _progress: ToolProgress, _token: CancellationToken): Promise<IToolResult> {
		const params = invocation.parameters as IActivateBrowserPageToolParams;
		const pageId = String(params.pageId || '').trim();
		if (!pageId) throw new Error('Browser page ID is required.');
		const activeSessionId = invocation.context?.sessionResource.toString();
		const page = this.browserViewService.getContextualBrowserViews({ activeSessionId }).get(pageId);
		if (!page) throw new Error(`Browser page is not open: ${pageId}`);
		const model = await page.resolve();
		if (model.sharingState !== BrowserViewSharingState.Shared) {
			throw new Error(`Browser page is not shared with the agent: ${pageId}`);
		}
		await this.editorService.openEditor(page);
		return {
			content: [{ kind: 'text', value: `Activated shared browser page: ${pageId}` }],
		};
	}
}
