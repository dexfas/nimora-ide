/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { joinPath } from '../../../../base/common/resources.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPlaywrightService, type IInvokeFunctionResult } from '../../../../platform/browserView/common/playwrightService.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { BrowserViewSharingState, IBrowserViewWorkbenchService } from '../common/browserView.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

export const WebMcpInternalBrowserOperationCommandId = '_workbench.browser.webMcpInternalOperation';

const WEB_MCP_EXTENSION_ID = 'shuncode.shuncode-integrated-browser-bridge';
const INTERNAL_SESSION_ID = 'workbench.browser.webmcp-internal-operation';
const MAX_OBSERVE_TIMEOUT_MS = 5_000;
const MAX_CONNECT_TIMEOUT_MS = 20_000;
const MAX_CONTROL_TIMEOUT_MS = 20_000;

type OperationId = 'listSharedPages' | 'observe' | 'chatgptObserveComposer' | 'chatgptObserveProviderUsers' | 'connect' | 'control';
type ControlAction = 'send' | 'poll' | 'interrupt' | 'resolve' | 'health' | 'disconnect';

interface IExactTarget {
	pageId: string;
	resourceIdentity: string;
	origin: string;
	href: string;
	site: string;
	pageSessionId?: string;
}

interface IWebMcpInternalBrowserOperationRequest {
	operationId: OperationId;
	pageId?: string;
	expectedHref?: string;
	target?: IExactTarget;
	prime?: boolean;
	bridgePort?: number;
	token?: string;
	control?: {
		action: ControlAction;
		sessionId: string;
		expectedOrigin: string;
		expectedHref: string;
		expectedSite: string;
		input?: unknown;
		inputId?: string;
		result?: unknown;
	};
	deferredResultId?: string;
	timeoutMs?: number;
}

interface IWebMcpOperationAssets {
	operationSource: string;
	siteAdapterSource: string;
	pageCoreSource: string;
	agentBridgeSource: string;
	nativeMcpBypassHosts: readonly string[];
}

interface IDeferredOwner {
	operationId: Exclude<OperationId, 'listSharedPages'>;
	pageId: string;
	expectedHref?: string;
	controlIdentity?: string;
}

let assetsPromise: Promise<IWebMcpOperationAssets> | undefined;
const deferredOwners = new Map<string, IDeferredOwner>();

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`${label} must be an object.`);
	}
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key)) throw new Error(`${label} contains unsupported field: ${key}`);
	}
}

function assertStructuredData(value: unknown, label: string, depth = 0): void {
	if (depth > 32) throw new Error(`${label} exceeds the supported structured-data depth.`);
	if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return;
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`);
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) assertStructuredData(item, label, depth + 1);
		return;
	}
	if (!value || typeof value !== 'object') throw new Error(`${label} must contain structured data only.`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must contain plain structured objects only.`);
	for (const item of Object.values(value as Record<string, unknown>)) assertStructuredData(item, label, depth + 1);
}

function controlIdentity(control: IWebMcpInternalBrowserOperationRequest['control']): string {
	if (!control) throw new Error('Fixed Worker control payload is required.');
	assertStructuredData(control, 'Fixed Worker control payload');
	const identity = JSON.stringify(control);
	if (!identity || identity.length > 1_000_000) throw new Error('Fixed Worker control payload is too large.');
	return identity;
}

function normalizeRequest(value: unknown): IWebMcpInternalBrowserOperationRequest {
	assertPlainObject(value, 'Internal browser operation request');
	assertOnlyKeys(value, ['operationId', 'pageId', 'expectedHref', 'target', 'prime', 'bridgePort', 'token', 'control', 'deferredResultId', 'timeoutMs'], 'Internal browser operation request');
	const operationId = String(value.operationId || '') as OperationId;
	if (!['listSharedPages', 'observe', 'chatgptObserveComposer', 'chatgptObserveProviderUsers', 'connect', 'control'].includes(operationId)) throw new Error(`Unsupported fixed internal browser operation: ${String(value.operationId || '')}`);
	if (value.target !== undefined) {
		assertPlainObject(value.target, 'Internal browser exact target');
		assertOnlyKeys(value.target, ['pageId', 'resourceIdentity', 'origin', 'href', 'site', 'pageSessionId'], 'Internal browser exact target');
	}
	if (value.control !== undefined) {
		assertPlainObject(value.control, 'Internal browser Worker control');
		assertOnlyKeys(value.control, ['action', 'sessionId', 'expectedOrigin', 'expectedHref', 'expectedSite', 'input', 'inputId', 'result'], 'Internal browser Worker control');
		const action = String(value.control.action || '') as ControlAction;
		if (!['send', 'poll', 'interrupt', 'resolve', 'health', 'disconnect'].includes(action)) throw new Error(`Unsupported fixed WebMCP Worker control action: ${String(value.control.action || '')}`);
		if (!String(value.control.sessionId || '').trim()) throw new Error('Fixed WebMCP Worker control requires sessionId.');
		if (!String(value.control.expectedOrigin || '').trim()) throw new Error('Fixed WebMCP Worker control requires expectedOrigin.');
		const expectedHref = String(value.control.expectedHref || '').trim();
		if (!expectedHref) throw new Error('Fixed WebMCP Worker control requires expectedHref.');
		if (expectedHref.length > 2048) throw new Error('Fixed WebMCP Worker control expectedHref is too large.');
		if (!String(value.control.expectedSite || '').trim()) throw new Error('Fixed WebMCP Worker control requires expectedSite.');
		controlIdentity(value.control as IWebMcpInternalBrowserOperationRequest['control']);
	}
	return value as unknown as IWebMcpInternalBrowserOperationRequest;
}

async function loadAssets(extensionService: IExtensionService, fileService: IFileService): Promise<IWebMcpOperationAssets> {
	if (!assetsPromise) {
		assetsPromise = (async () => {
			const extension = await extensionService.getExtension(WEB_MCP_EXTENSION_ID);
			if (!extension) throw new Error(`Required first-party WebMCP extension is unavailable: ${WEB_MCP_EXTENSION_ID}`);
			const read = async (name: string) => (await fileService.readFile(joinPath(extension.extensionLocation, name))).value.toString();
			const [operationSource, siteAdapterSource, pageCoreSource, agentBridgeSource, policySource] = await Promise.all([
				read('webmcp-internal-browser-operations.js'),
				read('webmcp-site-adapters.js'),
				read('webmcp-page-core.js'),
				read('arena-agent-bridge.js'),
				read('webmcp-internal-browser-policy.json'),
			]);
			const policy = JSON.parse(policySource) as { schemaVersion?: unknown; nativeMcpBypassHosts?: unknown };
			if (policy.schemaVersion !== 1 || !Array.isArray(policy.nativeMcpBypassHosts) || policy.nativeMcpBypassHosts.length > 16) {
				throw new Error('First-party WebMCP internal browser policy is invalid.');
			}
			const nativeMcpBypassHosts = policy.nativeMcpBypassHosts.map(value => String(value).trim().toLowerCase());
			if (nativeMcpBypassHosts.some(host => !/^[a-z0-9.-]+$/.test(host) || !host.includes('.'))) {
				throw new Error('First-party WebMCP internal browser policy contains an invalid host.');
			}
			return { operationSource, siteAdapterSource, pageCoreSource, agentBridgeSource, nativeMcpBypassHosts };
		})();
		assetsPromise.catch(() => { assetsPromise = undefined; });
	}
	return assetsPromise;
}

function isNativeMcpBypassUrl(value: string, nativeMcpBypassHosts: readonly string[]): boolean {
	try {
		const host = new URL(value).hostname.toLowerCase();
		return nativeMcpBypassHosts.includes(host);
	} catch {
		return false;
	}
}

async function requireOpenSharedPage(browserViewService: IBrowserViewWorkbenchService, playwrightService: IPlaywrightService, pageId: string, expectedHref: string | undefined, nativeMcpBypassHosts: readonly string[], nativeMcpMode: 'reject' | 'require' = 'reject') {
	const input = browserViewService.getKnownBrowserViews().get(pageId);
	if (!input) throw new Error(`Browser page is not open: ${pageId}`);
	const model = await input.resolve();
	if (model.sharingState !== BrowserViewSharingState.Shared || !(await playwrightService.isPageTracked(pageId))) {
		throw new Error(`Browser page is not shared with the agent: ${pageId}`);
	}
	const currentHref = String(input.url || model.url || '');
	const nativeMcpBypass = isNativeMcpBypassUrl(currentHref, nativeMcpBypassHosts);
	if (nativeMcpMode === 'reject' && nativeMcpBypass) throw new Error(`Browser page is a native-MCP bypass target: ${currentHref}`);
	if (nativeMcpMode === 'require' && !nativeMcpBypass) throw new Error(`Browser page is not an approved native-MCP observation target: ${currentHref}`);
	if (expectedHref && currentHref !== expectedHref) throw new Error(`Browser page identity changed before fixed internal operation: ${pageId}`);
	return { input, model, currentHref };
}

async function listSharedPages(browserViewService: IBrowserViewWorkbenchService, playwrightService: IPlaywrightService, editorService: IEditorService) {
	const visibleEditors = new Set(editorService.visibleEditors);
	const result: Array<{ pageId: string; title: string; url: string; visible: boolean }> = [];
	for (const [pageId, input] of browserViewService.getKnownBrowserViews()) {
		const model = await input.resolve();
		if (model.sharingState !== BrowserViewSharingState.Shared || !(await playwrightService.isPageTracked(pageId))) continue;
		// An open editor can still have its native page hidden by a notification
		// or dialog. Provider submission needs both editor and renderer visibility.
		result.push({ pageId, title: input.title || '', url: input.url || '', visible: visibleEditors.has(input) && model.visible });
	}
	return result;
}

function boundedTimeout(operationId: Exclude<OperationId, 'listSharedPages'>, requested: unknown): number {
	const maximum = operationId === 'observe' || operationId === 'chatgptObserveComposer' || operationId === 'chatgptObserveProviderUsers' ? MAX_OBSERVE_TIMEOUT_MS : operationId === 'control' ? MAX_CONTROL_TIMEOUT_MS : MAX_CONNECT_TIMEOUT_MS;
	const numeric = Number(requested);
	if (!Number.isFinite(numeric) || numeric <= 0) return maximum;
	return Math.max(1, Math.min(maximum, Math.floor(numeric)));
}

async function executeFixedOperation(browserViewService: IBrowserViewWorkbenchService, playwrightService: IPlaywrightService, extensionService: IExtensionService, fileService: IFileService, request: IWebMcpInternalBrowserOperationRequest): Promise<IInvokeFunctionResult> {
	const operationId = request.operationId as Exclude<OperationId, 'listSharedPages'>;
	const pageId = String(request.pageId || '').trim();
	if (!pageId) throw new Error('Fixed internal browser operation requires pageId.');
	const timeoutMs = boundedTimeout(operationId, request.timeoutMs);
	const assets = await loadAssets(extensionService, fileService);

	if (request.deferredResultId) {
		const deferredResultId = String(request.deferredResultId).trim();
		const owner = deferredOwners.get(deferredResultId);
		if (!owner || owner.operationId !== operationId || owner.pageId !== pageId) throw new Error('Deferred internal browser operation identity does not match this page/operation.');
		if (operationId === 'control' && owner.controlIdentity !== controlIdentity(request.control)) throw new Error('Deferred Worker control identity does not match the original page/session/control request.');
		await requireOpenSharedPage(browserViewService, playwrightService, pageId, owner.expectedHref, assets.nativeMcpBypassHosts, operationId === 'chatgptObserveComposer' || operationId === 'chatgptObserveProviderUsers' ? 'require' : 'reject');
		const resumed = await playwrightService.waitForDeferredResult(INTERNAL_SESSION_ID, deferredResultId, timeoutMs);
		if (!resumed.deferredResultId) deferredOwners.delete(deferredResultId);
		return resumed;
	}

	if (operationId === 'observe' || operationId === 'chatgptObserveComposer' || operationId === 'chatgptObserveProviderUsers') {
		if (request.target !== undefined || request.prime !== undefined || request.bridgePort !== undefined || request.token !== undefined) throw new Error('Read-only observation accepts no connect payload.');
		if (!request.expectedHref || typeof request.expectedHref !== 'string') throw new Error('Read-only observation requires expectedHref.');
		if (request.control !== undefined) throw new Error('Read-only observation accepts no Worker control payload.');
	} else if (operationId === 'connect') {
		if (!request.target || request.target.pageId !== pageId) throw new Error('Exact connect target pageId must match pageId.');
		if (!Number.isInteger(request.bridgePort) || Number(request.bridgePort) < 1 || Number(request.bridgePort) > 65535) throw new Error('Exact connect requires a valid loopback bridge port.');
		if (!request.token || typeof request.token !== 'string' || request.token.length > 512) throw new Error('Exact connect requires a bounded page token.');
		if (request.control !== undefined) throw new Error('Exact connect accepts no Worker control payload.');
	} else {
		if (!request.control) throw new Error('Fixed Worker control requires a structured control payload.');
		if (request.target !== undefined || request.prime !== undefined || request.bridgePort !== undefined || request.token !== undefined || request.expectedHref !== undefined) throw new Error('Fixed Worker control accepts no discovery/connect payload.');
	}
	const expectedHref = operationId === 'observe' || operationId === 'chatgptObserveComposer' || operationId === 'chatgptObserveProviderUsers' ? String(request.expectedHref) : operationId === 'connect' ? String(request.target?.href || '') : undefined;
	const page = await requireOpenSharedPage(browserViewService, playwrightService, pageId, expectedHref, assets.nativeMcpBypassHosts, operationId === 'chatgptObserveComposer' || operationId === 'chatgptObserveProviderUsers' ? 'require' : 'reject');
	if (operationId === 'control' && request.control?.action === 'send' && !page.model.visible) {
		throw new Error(`Browser page is hidden before provider submission: ${pageId}`);
	}

	const payload = {
		operationId,
		input: operationId === 'connect'
			? { target: request.target, prime: request.prime === true, bridgePort: request.bridgePort, token: request.token }
			: operationId === 'control' ? { control: request.control } : {},
		siteAdapterSource: assets.siteAdapterSource,
		pageCoreSource: assets.pageCoreSource,
		agentBridgeSource: assets.agentBridgeSource,
		operationSource: assets.operationSource,
	};
	const result = await playwrightService.invokeFunction(
		INTERNAL_SESSION_ID,
		pageId,
		`async (page, payload) => {
			return page.evaluate(async payload => {
			const executeOperation = (0, eval)(payload.operationSource);
			return await executeOperation({ ...payload, window, document, location, sessionStorage });
			}, payload);
		}`,
		[payload],
		timeoutMs,
	);
	if (result.deferredResultId) deferredOwners.set(result.deferredResultId, {
		operationId,
		pageId,
		expectedHref,
		...(operationId === 'control' ? { controlIdentity: controlIdentity(request.control) } : {}),
	});
	return result;
}

export function registerWebMcpInternalBrowserOperationCommand() {
	return CommandsRegistry.registerCommand(WebMcpInternalBrowserOperationCommandId, async (accessor, rawRequest: unknown) => {
		const request = normalizeRequest(rawRequest);
		if (request.operationId === 'listSharedPages') {
			assertOnlyKeys(rawRequest as Record<string, unknown>, ['operationId'], 'Shared-page list request');
			const browserViewService = accessor.get(IBrowserViewWorkbenchService);
			const playwrightService = accessor.get(IPlaywrightService);
			const editorService = accessor.get(IEditorService);
			return listSharedPages(browserViewService, playwrightService, editorService);
		}
		const browserViewService = accessor.get(IBrowserViewWorkbenchService);
		const playwrightService = accessor.get(IPlaywrightService);
		const extensionService = accessor.get(IExtensionService);
		const fileService = accessor.get(IFileService);
		return executeFixedOperation(browserViewService, playwrightService, extensionService, fileService, request);
	});
}
