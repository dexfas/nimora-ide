/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Event ordering cannot identify pages: contexts and IPC arrive independently. */
export function findBrowserViewPagePair(
	views: readonly { targetId: string }[],
	pages: readonly { targetId?: string }[],
): { viewIndex: number; pageIndex: number } | undefined {
	for (let viewIndex = 0; viewIndex < views.length; viewIndex++) {
		const targetId = views[viewIndex].targetId;
		if (!targetId) throw new Error('Browser view add event has no CDP target identity.');
		if (views.some((view, index) => index !== viewIndex && view.targetId === targetId)) {
			throw new Error('Browser views have ambiguous CDP target identities.');
		}
		const matchingPages = pages.map((page, index) => page.targetId === targetId ? index : -1).filter(index => index >= 0);
		if (matchingPages.length > 1) throw new Error('Playwright pages have ambiguous CDP target identities.');
		if (matchingPages.length === 1) return { viewIndex, pageIndex: matchingPages[0] };
	}
	return undefined;
}
