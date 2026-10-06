/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type BoundedAwaitResult<T> =
	| { readonly completed: true; readonly value: T }
	| { readonly completed: false };

/**
 * Wait for a promise only until an absolute wall-clock deadline. The promise is
 * intentionally not cancelled: callers may preserve it as deferred work.
 */
export async function awaitUntilDeadline<T>(promise: Promise<T>, deadline: number, now: () => number = Date.now): Promise<BoundedAwaitResult<T>> {
	const remaining = Math.max(0, deadline - now());
	if (remaining === 0) {
		return { completed: false };
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then(value => ({ completed: true as const, value })),
			new Promise<BoundedAwaitResult<T>>(resolve => {
				timer = setTimeout(() => resolve({ completed: false }), remaining);
			}),
		]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

export function remainingDeadlineMs(deadline: number, now: () => number = Date.now): number {
	return Math.max(0, deadline - now());
}
