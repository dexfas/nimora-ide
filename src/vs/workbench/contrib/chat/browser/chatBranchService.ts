/*---------------------------------------------------------------------------------------------
 *  Copyright (c) ShunCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * Workbench-side view state for ShunCode multi-model branch groups.
 *
 * The extension (shuncode native chat) is the source of truth for what a
 * branch group is: each branch answer and the merge summary carry a
 * `shuncodeBranchGroup` metadata block (groupId / variantId / kind). This
 * service mirrors that information for the UI: per-row footer actions
 * (◀ ▶ / 合并总结 / 采纳) and the canonical (adopted) variant bookkeeping.
 */

export interface IChatBranchVariant {
	/** The request (question) row id. */
	requestId: string;
	/** The response row id. */
	responseId: string;
	kind: 'branch' | 'merge';
	/** The model that produced this variant (from `shuncodeBranchModel` metadata). */
	modelId?: string;
	/** Whether the user paused (canceled) this answer; a canceled variant is not a complete branch. */
	canceled?: boolean;
}

export interface IChatBranchGroup {
	id: string;
	/** First registered variant request id. */
	baseRequestId: string;
	variants: IChatBranchVariant[];
	/** The variant that continues into later context. Defaults to the first variant, then to the merge summary. */
	canonicalRequestId: string;
	mergedRequestId?: string;
	/** Canonical variant id fetched from the extension's durable state, applied once its row registers. */
	pendingCanonicalRequestId?: string;
	/** The variant currently displayed inside the group's container. Newly registered variants become active automatically. */
	activeRequestId: string;
	/** Active variant id fetched from the extension's durable state, applied once its row registers. */
	pendingActiveRequestId?: string;
}

export interface IChatBranchRowInfo {
	group: IChatBranchGroup;
	/** Index of this row's variant in group.variants. */
	variantIndex: number;
	/** Kind of this row's variant. */
	variantKind: 'branch' | 'merge';
	/** Total number of variants in the group. */
	variantCount: number;
	/** The model that produced this variant (from `shuncodeBranchModel` metadata). */
	modelId?: string;
	isCanonical: boolean;
	isMerged: boolean;
	/** The 合并总结 (merge summary) action is available for this row. */
	canMerge: boolean;
	/** The 采纳 (adopt) action is available for this row. */
	canAdopt: boolean;
	/** The 删除分支 (delete) action is available for this row. */
	canDelete: boolean;
	hasPrev: boolean;
	hasNext: boolean;
}

export const IChatBranchService = createDecorator<IChatBranchService>('chatBranchService');

export interface IChatBranchService {
	readonly _serviceBrand: undefined;
	onDidChange: Event<URI>;
	registerVariant(sessionResource: URI, variant: { groupId: string; requestId: string; responseId: string; kind: 'branch' | 'merge'; modelId?: string; canceled?: boolean }): void;
	synchronize(sessionResource: URI, variants: readonly { groupId: string; requestId: string; responseId: string; kind: 'branch' | 'merge'; modelId?: string; canceled?: boolean }[]): void;
	removeRequest(sessionResource: URI, requestId: string): void;
	removeSession(sessionResource: URI): void;
	getGroup(sessionResource: URI, groupId: string): IChatBranchGroup | undefined;
	getGroups(sessionResource: URI): IChatBranchGroup[];
	getActiveGroupId(sessionResource: URI): string | undefined;
	getRowInfo(sessionResource: URI, rowId: string): IChatBranchRowInfo | undefined;
	adoptVariant(sessionResource: URI, requestId: string): void;
	setActiveVariant(sessionResource: URI, groupId: string, requestId: string): void;
}

export class ChatBranchService extends Disposable implements IChatBranchService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
	}

	private readonly _onDidChange = this._register(new Emitter<URI>());
	readonly onDidChange: Event<URI> = this._onDidChange.event;

	/** sessionResource.toString() -> groupId -> group */
	private readonly groups = new Map<string, Map<string, IChatBranchGroup>>();
	/** sessionResource.toString() -> rowId (request or response) -> { groupId, requestId } */
	private readonly rowIndex = new Map<string, Map<string, { groupId: string; requestId: string }>>();
	/** sessionResource.toString() -> groupId of the most recently extended branch group (the only group that can be merged). */
	private readonly activeGroup = new Map<string, string>();

	private sessionKey(sessionResource: URI): string {
		return sessionResource.toString();
	}

	registerVariant(sessionResource: URI, variant: { groupId: string; requestId: string; responseId: string; kind: 'branch' | 'merge'; modelId?: string; canceled?: boolean }): void {
		if (this.registerVariantInternal(sessionResource, variant)) {
			this._onDidChange.fire(sessionResource);
		}
	}

	/**
	 * Registers a batch of variants (mirrored from response metadata) and fires
	 * a single change event when anything changed. Variants that disappeared
	 * from the model (for example the old request row of a branch/merge answer
	 * that was retried and removed) are pruned so stale entries do not inflate
	 * counts or keep dead rows mapped. Used by the chat list widget so variant
	 * bookkeeping no longer depends on row rendering.
	 */
	synchronize(sessionResource: URI, variants: readonly { groupId: string; requestId: string; responseId: string; kind: 'branch' | 'merge'; modelId?: string; canceled?: boolean }[]): void {
		const key = this.sessionKey(sessionResource);
		let changed = false;
		for (const variant of variants) {
			changed = this.registerVariantInternal(sessionResource, variant) || changed;
		}
		const keepRequestIds = new Set(variants.map(variant => variant.requestId));
		const sessionGroups = this.groups.get(key);
		if (sessionGroups) {
			for (const group of sessionGroups.values()) {
				const stale = group.variants.filter(variant => !keepRequestIds.has(variant.requestId));
				for (const variant of stale) {
					changed = this.removeVariantInternal(sessionResource, variant.requestId) || changed;
				}
			}
		}
		if (changed) {
			this._onDidChange.fire(sessionResource);
		}
	}

	private registerVariantInternal(sessionResource: URI, variant: { groupId: string; requestId: string; responseId: string; kind: 'branch' | 'merge'; modelId?: string; canceled?: boolean }): boolean {
		const key = this.sessionKey(sessionResource);
		let sessionGroups = this.groups.get(key);
		if (!sessionGroups) {
			sessionGroups = new Map();
			this.groups.set(key, sessionGroups);
		}
		let group = sessionGroups.get(variant.groupId);
		if (!group) {
			group = {
				id: variant.groupId,
				baseRequestId: variant.requestId,
				variants: [],
				canonicalRequestId: variant.requestId,
				activeRequestId: variant.requestId,
			};
			sessionGroups.set(variant.groupId, group);
			this.hydrateCanonical(sessionResource, group);
		}
		const existing = group.variants.find(v => v.requestId === variant.requestId);
		if (existing) {
			// Refresh response id / kind in place.
			existing.responseId = variant.responseId;
			existing.kind = variant.kind;
			existing.canceled = variant.canceled;
			if (variant.modelId) {
				existing.modelId = variant.modelId;
			}
			if (variant.kind === 'merge') {
				group.mergedRequestId = variant.requestId;
				group.canonicalRequestId = variant.requestId;
				group.pendingCanonicalRequestId = undefined;
			}
			this.applyPendingCanonical(sessionResource, group);
			return false;
		}
		group.variants.push({ requestId: variant.requestId, responseId: variant.responseId, kind: variant.kind, modelId: variant.modelId, canceled: variant.canceled });
		// The newest variant becomes the one displayed inside the container.
		group.activeRequestId = variant.requestId;
		group.pendingActiveRequestId = undefined;
		this.activeGroup.set(key, variant.groupId);
		if (variant.kind === 'merge') {
			group.mergedRequestId = variant.requestId;
			group.canonicalRequestId = variant.requestId;
			group.pendingCanonicalRequestId = undefined;
		}
		this.applyPendingCanonical(sessionResource, group);
		let sessionRows = this.rowIndex.get(key);
		if (!sessionRows) {
			sessionRows = new Map();
			this.rowIndex.set(key, sessionRows);
		}
		sessionRows.set(variant.requestId, { groupId: variant.groupId, requestId: variant.requestId });
		sessionRows.set(variant.responseId, { groupId: variant.groupId, requestId: variant.requestId });
		return true;
	}

	private hydrateCanonical(sessionResource: URI, group: IChatBranchGroup): void {
		void (async () => {
			try {
				const state = await this.commandService.executeCommand('shuncode.branch.getGroupState', group.id) as { canonicalVariantId?: unknown; activeVariantId?: unknown } | undefined;
				const canonical = state?.canonicalVariantId;
				if (typeof canonical === 'string' && canonical) {
					// The canonical row may render after this fetch resolves (for example
					// the adopted variant appears later in the list); apply it once it registers.
					group.pendingCanonicalRequestId = canonical;
					this.applyPendingCanonical(sessionResource, group);
				}
				const active = state?.activeVariantId;
				if (typeof active === 'string' && active) {
					group.pendingActiveRequestId = active;
					this.applyPendingActive(sessionResource, group);
				}
			} catch {
				// The extension or its command is unavailable: keep the default canonical (first variant).
			}
		})();
	}

	private applyPendingActive(sessionResource: URI, group: IChatBranchGroup): void {
		const target = group.pendingActiveRequestId;
		if (!target || group.activeRequestId === target) {
			return;
		}
		if (group.variants.some(v => v.requestId === target)) {
			group.activeRequestId = target;
			this._onDidChange.fire(sessionResource);
		}
	}

	private applyPendingCanonical(sessionResource: URI, group: IChatBranchGroup): void {
		const target = group.pendingCanonicalRequestId;
		if (!target || group.canonicalRequestId === target) {
			return;
		}
		if (group.variants.some(v => v.requestId === target)) {
			group.canonicalRequestId = target;
			this._onDidChange.fire(sessionResource);
		}
	}

	removeRequest(sessionResource: URI, requestId: string): void {
		if (this.removeVariantInternal(sessionResource, requestId)) {
			this._onDidChange.fire(sessionResource);
		}
	}

	private removeVariantInternal(sessionResource: URI, requestId: string): boolean {
		const key = this.sessionKey(sessionResource);
		const sessionRows = this.rowIndex.get(key);
		if (!sessionRows) {
			return false;
		}
		const row = sessionRows.get(requestId);
		if (!row) {
			return false;
		}
		const sessionGroups = this.groups.get(key);
		const group = sessionGroups?.get(row.groupId);
		if (!group) {
			return false;
		}
		const index = group.variants.findIndex(v => v.requestId === requestId);
		if (index < 0) {
			return false;
		}
		const [removed] = group.variants.splice(index, 1);
		sessionRows.delete(removed.responseId);
		sessionRows.delete(removed.requestId);
		if (group.canonicalRequestId === requestId) {
			group.canonicalRequestId = group.variants[0]?.requestId ?? '';
		}
		if (group.mergedRequestId === requestId) {
			group.mergedRequestId = undefined;
		}
		if (group.activeRequestId === requestId) {
			group.activeRequestId = group.canonicalRequestId || group.variants[0]?.requestId || '';
		}
		if (!group.variants.length) {
			sessionGroups?.delete(row.groupId);
			this.activeGroup.delete(key);
		}
		return true;
	}

	removeSession(sessionResource: URI): void {
		const key = this.sessionKey(sessionResource);
		this.groups.delete(key);
		this.rowIndex.delete(key);
		this.activeGroup.delete(key);
		this._onDidChange.fire(sessionResource);
	}

	getGroup(sessionResource: URI, groupId: string): IChatBranchGroup | undefined {
		return this.groups.get(this.sessionKey(sessionResource))?.get(groupId);
	}

	getGroups(sessionResource: URI): IChatBranchGroup[] {
		const sessionGroups = this.groups.get(this.sessionKey(sessionResource));
		return sessionGroups ? [...sessionGroups.values()] : [];
	}

	getActiveGroupId(sessionResource: URI): string | undefined {
		return this.activeGroup.get(this.sessionKey(sessionResource));
	}

	setActiveVariant(sessionResource: URI, groupId: string, requestId: string): void {
		const group = this.getGroup(sessionResource, groupId);
		if (!group || group.activeRequestId === requestId) {
			return;
		}
		if (!group.variants.some(v => v.requestId === requestId)) {
			return;
		}
		group.activeRequestId = requestId;
		group.pendingActiveRequestId = undefined;
		this._onDidChange.fire(sessionResource);
		// Persist the displayed variant in the extension's durable branch state.
		void this.commandService.executeCommand('shuncode.branch.setActiveVariant', groupId, requestId).catch(() => {
			// The extension or its command is unavailable: the view state still holds.
		});
	}

	getRowInfo(sessionResource: URI, rowId: string): IChatBranchRowInfo | undefined {
		const sessionRows = this.rowIndex.get(this.sessionKey(sessionResource));
		const row = sessionRows?.get(rowId);
		if (!row) {
			return undefined;
		}
		const group = this.groups.get(this.sessionKey(sessionResource))?.get(row.groupId);
		if (!group) {
			return undefined;
		}
		const variantIndex = group.variants.findIndex(v => v.requestId === row.requestId);
		if (variantIndex < 0) {
			return undefined;
		}
		const variant = group.variants[variantIndex];
		const isMerged = group.mergedRequestId === row.requestId && variant.kind === 'merge';
		const isCanonical = group.canonicalRequestId === row.requestId;
		const branchCount = group.variants.filter(v => v.kind === 'branch' && !v.canceled).length;
		const isActiveGroup = this.activeGroup.get(this.sessionKey(sessionResource)) === group.id;
		return {
			group,
			variantIndex,
			variantKind: variant.kind,
			variantCount: group.variants.length,
			modelId: variant.modelId,
			isCanonical,
			isMerged,
			canMerge: variant.kind === 'branch' && branchCount >= 2 && !group.mergedRequestId && isActiveGroup,
			canAdopt: !isCanonical,
			canDelete: variant.kind === 'branch' && !isCanonical,
			hasPrev: variantIndex > 0,
			hasNext: variantIndex < group.variants.length - 1,
		};
	}

	adoptVariant(sessionResource: URI, requestId: string): void {
		const sessionRows = this.rowIndex.get(this.sessionKey(sessionResource));
		const row = sessionRows?.get(requestId);
		if (!row) {
			return;
		}
		const group = this.groups.get(this.sessionKey(sessionResource))?.get(row.groupId);
		if (!group || !group.variants.some(v => v.requestId === requestId)) {
			return;
		}
		if (group.canonicalRequestId === requestId) {
			return;
		}
		group.canonicalRequestId = requestId;
		group.pendingCanonicalRequestId = undefined;
		this._onDidChange.fire(sessionResource);
	}
}

