/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatModelsWidget.css';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../../base/common/event.js';
import * as DOM from '../../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { ScrollbarVisibility } from '../../../../../base/common/scrollable.js';
import { Button, IButtonOptions } from '../../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { ILanguageModelsService, ILanguageModelProviderDescriptor, resolveProviderDeprecationLink } from '../../../chat/common/languageModels.js';
import { localize } from '../../../../../nls.js';
import { defaultButtonStyles, defaultInputBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { WorkbenchTable } from '../../../../../platform/list/browser/listService.js';
import { ITableVirtualDelegate, ITableRenderer } from '../../../../../base/browser/ui/table/table.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { IExtensionService } from '../../../../services/extensions/common/extensions.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IAction, toAction, Action, Separator } from '../../../../../base/common/actions.js';
import { ActionBar } from '../../../../../base/browser/ui/actionbar/actionbar.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { ChatModelsViewModel, ILanguageModel, ILanguageModelEntry, ILanguageModelProviderEntry, ILanguageModelGroupEntry, SEARCH_SUGGESTIONS, isLanguageModelProviderEntry, isLanguageModelGroupEntry, IViewModelEntry, isStatusEntry, IStatusEntry } from './chatModelsViewModel.js';
import { HighlightedLabel } from '../../../../../base/browser/ui/highlightedlabel/highlightedLabel.js';
import { Link } from '../../../../../platform/opener/browser/link.js';
import { SuggestEnabledInput } from '../../../codeEditor/browser/suggestEnabledInput/suggestEnabledInput.js';
import { Delayer } from '../../../../../base/common/async.js';
import { settingsTextInputBorder } from '../../../preferences/common/settingsEditorColorRegistry.js';
import { IChatEntitlementService } from '../../../../services/chat/common/chatEntitlementService.js';
import { DropdownMenuActionViewItem } from '../../../../../base/browser/ui/dropdown/dropdownActionViewItem.js';
import { IActionViewItemOptions } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { AnchorAlignment } from '../../../../../base/browser/ui/contextview/contextview.js';
import { ToolBar } from '../../../../../base/browser/ui/toolbar/toolbar.js';
import { preferencesClearInputIcon } from '../../../preferences/browser/preferencesIcons.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IEditorProgressService } from '../../../../../platform/progress/common/progress.js';
import { IContextKey, IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { CONTEXT_MODELS_SEARCH_FOCUS } from '../../common/constants.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import Severity from '../../../../../base/common/severity.js';
import { IJSONSchema } from '../../../../../base/common/jsonSchema.js';
import { formatTokenCount } from '../../../../../base/common/numbers.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { getErrorMessage } from '../../../../../base/common/errors.js';

const $ = DOM.$;

const HEADER_HEIGHT = 30;
const VENDOR_ROW_HEIGHT = 30;
const MODEL_ROW_HEIGHT = 26;

export function getModelHoverContent(model: ILanguageModel): MarkdownString {
	const markdown = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
	markdown.appendMarkdown(`**${model.metadata.name}**`);
	if (model.metadata.id !== model.metadata.version) {
		markdown.appendMarkdown(`&nbsp;<span style="background-color:#8080802B;">&nbsp;_${model.metadata.id}&#64;${model.metadata.version}_&nbsp;</span>`);
	} else {
		markdown.appendMarkdown(`&nbsp;<span style="background-color:#8080802B;">&nbsp;_${model.metadata.id}_&nbsp;</span>`);
	}
	markdown.appendText(`\n`);

	if (model.metadata.statusIcon && model.metadata.tooltip) {
		if (model.metadata.statusIcon) {
			markdown.appendMarkdown(`$(${model.metadata.statusIcon.id})&nbsp;`);
		}
		markdown.appendMarkdown(`${model.metadata.tooltip}`);
		markdown.appendText(`\n`);
	}

	if (model.metadata.pricing) {
		markdown.appendMarkdown(`${localize('models.pricing', 'Pricing')}: `);
		markdown.appendMarkdown(model.metadata.pricing);
		markdown.appendText(`\n`);
	}

	if (model.metadata.inputCost !== undefined || model.metadata.outputCost !== undefined || model.metadata.cacheCost !== undefined || model.metadata.cacheWriteCost !== undefined) {
		if (model.metadata.inputCost !== undefined) {
			markdown.appendMarkdown(model.metadata.inputCost === 1
				? localize('models.inputCost.singular', 'Input Cost: {0} credit per 1M tokens', model.metadata.inputCost)
				: localize('models.inputCost.plural', 'Input Cost: {0} credits per 1M tokens', model.metadata.inputCost));
			markdown.appendText(`\n`);
		}
		if (model.metadata.cacheCost !== undefined) {
			markdown.appendMarkdown(model.metadata.cacheCost === 1
				? localize('models.cacheCost.singular', 'Cache Read Cost: {0} credit per 1M tokens', model.metadata.cacheCost)
				: localize('models.cacheCost.plural', 'Cache Read Cost: {0} credits per 1M tokens', model.metadata.cacheCost));
			markdown.appendText(`\n`);
		}
		if (model.metadata.cacheWriteCost !== undefined) {
			markdown.appendMarkdown(model.metadata.cacheWriteCost === 1
				? localize('models.cacheWriteCost.singular', 'Cache Write Cost: {0} credit per 1M tokens', model.metadata.cacheWriteCost)
				: localize('models.cacheWriteCost.plural', 'Cache Write Cost: {0} credits per 1M tokens', model.metadata.cacheWriteCost));
			markdown.appendText(`\n`);
		}
		if (model.metadata.outputCost !== undefined) {
			markdown.appendMarkdown(model.metadata.outputCost === 1
				? localize('models.outputCost.singular', 'Output Cost: {0} credit per 1M tokens', model.metadata.outputCost)
				: localize('models.outputCost.plural', 'Output Cost: {0} credits per 1M tokens', model.metadata.outputCost));
			markdown.appendText(`\n`);
		}

		if (model.metadata.longContextInputCost !== undefined || model.metadata.longContextOutputCost !== undefined || model.metadata.longContextCacheCost !== undefined || model.metadata.longContextCacheWriteCost !== undefined) {
			markdown.appendText(`\n`);
			markdown.appendMarkdown(`**${localize('models.longContextPricing', 'Long Context Pricing')}**`);
			markdown.appendText(`\n`);
			if (model.metadata.longContextInputCost !== undefined) {
				markdown.appendMarkdown(model.metadata.longContextInputCost === 1
					? localize('models.longContextInputCost.singular', 'Input Cost: {0} credit per 1M tokens', model.metadata.longContextInputCost)
					: localize('models.longContextInputCost.plural', 'Input Cost: {0} credits per 1M tokens', model.metadata.longContextInputCost));
				markdown.appendText(`\n`);
			}
			if (model.metadata.longContextCacheCost !== undefined) {
				markdown.appendMarkdown(model.metadata.longContextCacheCost === 1
					? localize('models.longContextCacheCost.singular', 'Cache Read Cost: {0} credit per 1M tokens', model.metadata.longContextCacheCost)
					: localize('models.longContextCacheCost.plural', 'Cache Read Cost: {0} credits per 1M tokens', model.metadata.longContextCacheCost));
				markdown.appendText(`\n`);
			}
			if (model.metadata.longContextCacheWriteCost !== undefined) {
				markdown.appendMarkdown(model.metadata.longContextCacheWriteCost === 1
					? localize('models.longContextCacheWriteCost.singular', 'Cache Write Cost: {0} credit per 1M tokens', model.metadata.longContextCacheWriteCost)
					: localize('models.longContextCacheWriteCost.plural', 'Cache Write Cost: {0} credits per 1M tokens', model.metadata.longContextCacheWriteCost));
				markdown.appendText(`\n`);
			}
			if (model.metadata.longContextOutputCost !== undefined) {
				markdown.appendMarkdown(model.metadata.longContextOutputCost === 1
					? localize('models.longContextOutputCost.singular', 'Output Cost: {0} credit per 1M tokens', model.metadata.longContextOutputCost)
					: localize('models.longContextOutputCost.plural', 'Output Cost: {0} credits per 1M tokens', model.metadata.longContextOutputCost));
				markdown.appendText(`\n`);
			}
		}
	}

	if (model.metadata.maxInputTokens || model.metadata.maxOutputTokens) {
		const totalTokens = (model.metadata.maxInputTokens ?? 0) + (model.metadata.maxOutputTokens ?? 0);
		markdown.appendMarkdown(`${localize('models.contextSize', 'Context Size')}: `);
		markdown.appendMarkdown(`${formatTokenCount(totalTokens)}`);
		markdown.appendText(`\n`);
	}

	if (model.metadata.capabilities) {
		markdown.appendMarkdown(`${localize('models.capabilities', 'Capabilities')}: `);
		if (model.metadata.capabilities?.toolCalling) {
			markdown.appendMarkdown(`&nbsp;<span style="background-color:#8080802B;">&nbsp;_${localize('models.toolCalling', 'Tools')}_&nbsp;</span>`);
		}
		if (model.metadata.capabilities?.vision) {
			markdown.appendMarkdown(`&nbsp;<span style="background-color:#8080802B;">&nbsp;_${localize('models.vision', 'Vision')}_&nbsp;</span>`);
		}
		if (model.metadata.capabilities?.agentMode) {
			markdown.appendMarkdown(`&nbsp;<span style="background-color:#8080802B;">&nbsp;_${localize('models.agentMode', 'Agent Mode')}_&nbsp;</span>`);
		}
		for (const editTool of model.metadata.capabilities.editTools ?? []) {
			markdown.appendMarkdown(`&nbsp;<span style="background-color:#8080802B;">&nbsp;_${editTool}_&nbsp;</span>`);
		}
		markdown.appendText(`\n`);
	}

	return markdown;
}

/**
 * Pure helper for building the dropdown actions shown by the **Add Models** button.
 *
 * Exposed for unit testing. When `supportsAddingModels` is false, no actions are returned
 * regardless of the other inputs so that the existing entitlement/managed-by-organization
 * restriction is preserved.
 */
export function buildAddModelsDropdownActions(
	configurableVendors: ILanguageModelProviderDescriptor[],
	supportsAddingModels: boolean,
	runVendorAction: (vendor: ILanguageModelProviderDescriptor) => void | Promise<void>,
): IAction[] {
	if (!supportsAddingModels) {
		return [];
	}

	// Sort vendors alphabetically by displayName, but sink deprecated providers (those declaring a
	// `deprecation.link`, e.g. Ollama) to the end of the list. "OpenAI Compatible (Deprecated)" (customoai)
	// is pinned after the sorted list and "Custom Endpoint" (customendpoint) after a separator at the very end.
	const customEndpointVendor = configurableVendors.find(v => v.vendor === 'customendpoint');
	const customOaiVendor = configurableVendors.find(v => v.vendor === 'customoai');
	const sortedVendors = configurableVendors
		.filter(v => v.vendor !== 'customendpoint' && v.vendor !== 'customoai')
		.sort((a, b) => {
			const aDeprecated = a.deprecation?.link ? 1 : 0;
			const bDeprecated = b.deprecation?.link ? 1 : 0;
			if (aDeprecated !== bDeprecated) {
				return aDeprecated - bDeprecated;
			}
			return a.displayName.localeCompare(b.displayName);
		});
	if (customOaiVendor) {
		sortedVendors.push(customOaiVendor);
	}

	const toVendorAction = (vendor: ILanguageModelProviderDescriptor) => toAction({
		id: `enable-${vendor.vendor}`,
		label: vendor.displayName,
		run: async () => {
			await runVendorAction(vendor);
		}
	});

	const actions: IAction[] = sortedVendors.map(toVendorAction);
	if (customEndpointVendor) {
		if (actions.length > 0) {
			actions.push(new Separator());
		}
		actions.push(toVendorAction(customEndpointVendor));
	}

	return actions;
}

export interface IShunCodeProviderImport {
	readonly name: string;
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly modelIds?: string;
	readonly protocol: 'openai-responses' | 'openai-chat-completions';
	readonly settings?: Readonly<Record<string, unknown>>;
	readonly modelSettings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

function importString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	return undefined;
}

function importObject(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function importValue(records: readonly Record<string, unknown>[], keys: readonly string[]): unknown {
	for (const record of records) {
		for (const key of keys) {
			if (record[key] !== undefined && record[key] !== null && record[key] !== '') {
				return record[key];
			}
		}
	}
	return undefined;
}

function importSettingString(records: readonly Record<string, unknown>[], keys: readonly string[]): string | undefined {
	const value = importValue(records, keys);
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function importSettingNumber(records: readonly Record<string, unknown>[], keys: readonly string[], min: number, max: number, integer = false): number | undefined {
	const value = importValue(records, keys);
	if (value === undefined) {
		return undefined;
	}
	const numeric = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(numeric) || (integer && !Number.isInteger(numeric)) || numeric < min || numeric > max) {
		throw new Error(localize('models.importProvidersInvalidNumber', "Invalid {0}: expected {1} from {2} to {3}.", keys[0], integer ? 'an integer' : 'a number', min, max));
	}
	return numeric;
}

function importSettingBoolean(records: readonly Record<string, unknown>[], keys: readonly string[]): boolean | undefined {
	const value = importValue(records, keys);
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'boolean') {
		throw new Error(localize('models.importProvidersInvalidBoolean', "Invalid {0}: expected true or false.", keys[0]));
	}
	return value;
}

function importSettingEnum<T extends string>(records: readonly Record<string, unknown>[], keys: readonly string[], allowed: readonly T[]): T | undefined {
	const value = importValue(records, keys);
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== 'string' || !allowed.includes(value.trim() as T)) {
		throw new Error(localize('models.importProvidersInvalidEnum', "Invalid {0}: expected one of {1}.", keys[0], allowed.join(', ')));
	}
	return value.trim() as T;
}

function importSettingEnumList<T extends string>(records: readonly Record<string, unknown>[], keys: readonly string[], allowed: readonly T[]): T[] | undefined {
	const value = importValue(records, keys);
	if (value === undefined) {
		return undefined;
	}
	const values = typeof value === 'string' ? value.split(/[\n,;]+/) : Array.isArray(value) ? value : undefined;
	if (!values) {
		throw new Error(localize('models.importProvidersInvalidEnumList', "Invalid {0}: expected an array or comma/newline-separated list using {1}.", keys[0], allowed.join(', ')));
	}
	const result: T[] = [];
	for (const item of values) {
		const normalized = typeof item === 'string' ? item.trim() : '';
		if (!normalized || !allowed.includes(normalized as T)) {
			throw new Error(localize('models.importProvidersInvalidEnumListValue', "Invalid {0}: expected only {1}.", keys[0], allowed.join(', ')));
		}
		if (!result.includes(normalized as T)) {
			result.push(normalized as T);
		}
	}
	if (!result.length) {
		throw new Error(localize('models.importProvidersEmptyEnumList', "Invalid {0}: at least one value is required.", keys[0]));
	}
	return result;
}

function importSettingObject(records: readonly Record<string, unknown>[], keys: readonly string[]): Record<string, unknown> | undefined {
	const value = importValue(records, keys);
	if (value === undefined) {
		return undefined;
	}
	const result = importObject(value);
	if (!result) {
		throw new Error(localize('models.importProvidersInvalidObject', "Invalid {0}: expected a JSON object.", keys[0]));
	}
	return { ...result };
}

function importStopSequences(records: readonly Record<string, unknown>[]): string[] | undefined {
	const value = importValue(records, ['stop']);
	if (value === undefined) {
		return undefined;
	}
	const values = typeof value === 'string' ? [value] : Array.isArray(value) ? value : undefined;
	if (!values || values.some(item => typeof item !== 'string') || values.length > 4) {
		throw new Error(localize('models.importProvidersInvalidStop', "Invalid stop: expected a string or an array of up to 4 strings."));
	}
	return values.map(item => (item as string).trim()).filter(Boolean);
}

function normalizeShunCodeImportSettings(primary: Record<string, unknown>, fallback?: Record<string, unknown>): Record<string, unknown> | undefined {
	const sources = [primary, ...(fallback ? [fallback] : [])];
	const reasoningSources = sources.flatMap(source => {
		const nested = importObject(source.reasoning);
		return nested ? [source, nested] : [source];
	});
	const thinkingSources = sources.flatMap(source => {
		const nested = importObject(source.thinking);
		return nested ? [nested, source] : [source];
	});
	const textSources = sources.flatMap(source => {
		const nested = importObject(source.text);
		return nested ? [source, nested] : [source];
	});
	const cacheSources = sources.flatMap(source => {
		const nested = importObject(source.promptCacheOptions ?? source.prompt_cache_options);
		return nested ? [source, nested] : [source];
	});
	const settings: Record<string, unknown> = {};
	const assign = (key: string, value: unknown) => { if (value !== undefined) { settings[key] = value; } };

	assign('description', importSettingString(sources, ['description', 'note']));
	assign('timeoutMs', importSettingNumber(sources, ['timeoutMs', 'timeout_ms', 'timeout'], 1_000, 300_000, true));
	assign('retries', importSettingNumber(sources, ['retries', 'retry', 'retryCount'], 0, 5, true));
	assign('contextWindow', importSettingNumber(sources, ['contextWindow', 'context_window', 'contextSize', 'maxContext'], 1_024, 10_000_000, true));
	assign('maxOutputTokens', importSettingNumber(sources, ['maxOutputTokens', 'max_output_tokens', 'max_completion_tokens'], 1, 1_000_000, true));
	assign('thinking', importSettingEnum(thinkingSources, ['type', 'thinking'], ['enabled', 'disabled'] as const));
	assign('reasoningEffort', importSettingEnum(reasoningSources, ['reasoningEffort', 'reasoning_effort', 'effort'], ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const));
	assign('reasoningEfforts', importSettingEnumList(reasoningSources, ['reasoningEfforts', 'reasoning_efforts', 'supportedReasoningEfforts', 'supported_reasoning_efforts', 'efforts'], ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const));
	assign('reasoningSummary', importSettingEnum(reasoningSources, ['reasoningSummary', 'reasoning_summary', 'summary'], ['auto', 'concise', 'detailed'] as const));
	assign('reasoningContext', importSettingEnum(reasoningSources, ['reasoningContext', 'reasoning_context', 'context'], ['auto', 'current_turn', 'all_turns'] as const));
	assign('reasoningMode', importSettingEnum(reasoningSources, ['reasoningMode', 'reasoning_mode', 'mode'], ['standard', 'pro'] as const));
	assign('verbosity', importSettingEnum(textSources, ['verbosity'], ['low', 'medium', 'high'] as const));
	assign('temperature', importSettingNumber(sources, ['temperature'], 0, 2));
	assign('topP', importSettingNumber(sources, ['topP', 'top_p'], 0, 1));
	assign('parallelToolCalls', importSettingBoolean(sources, ['parallelToolCalls', 'parallel_tool_calls']));
	assign('maxToolCalls', importSettingNumber(sources, ['maxToolCalls', 'max_tool_calls'], 1, 128, true));
	assign('serviceTier', importSettingEnum(sources, ['serviceTier', 'service_tier'], ['auto', 'default', 'flex', 'scale', 'priority', 'fast'] as const));
	assign('store', importSettingBoolean(sources, ['store']));
	assign('truncation', importSettingEnum(sources, ['truncation'], ['auto', 'disabled'] as const));
	assign('promptCacheKey', importSettingString(sources, ['promptCacheKey', 'prompt_cache_key']));
	assign('promptCacheMode', importSettingEnum(cacheSources, ['promptCacheMode', 'prompt_cache_mode', 'mode'], ['implicit', 'explicit'] as const));
	assign('promptCacheTtl', importSettingEnum(cacheSources, ['promptCacheTtl', 'prompt_cache_ttl', 'ttl'], ['30m'] as const));
	assign('promptCacheRetention', importSettingEnum(sources, ['promptCacheRetention', 'prompt_cache_retention'], ['in_memory', '24h'] as const));
	assign('safetyIdentifier', importSettingString(sources, ['safetyIdentifier', 'safety_identifier']));
	assign('seed', importSettingNumber(sources, ['seed'], -2_147_483_648, 2_147_483_647, true));
	assign('presencePenalty', importSettingNumber(sources, ['presencePenalty', 'presence_penalty'], -2, 2));
	assign('frequencyPenalty', importSettingNumber(sources, ['frequencyPenalty', 'frequency_penalty'], -2, 2));
	assign('stop', importStopSequences(sources));
	assign('responseFormat', importSettingObject(sources, ['responseFormat', 'response_format']));
	assign('requestMetadata', importSettingObject(sources, ['requestMetadata', 'metadata']));
	assign('extraBody', importSettingObject(sources, ['extraBody', 'extra_body']));
	return Object.keys(settings).length ? settings : undefined;
}

function importProtocol(record: Record<string, unknown>, fallback: 'openai-responses' | 'openai-chat-completions'): 'openai-responses' | 'openai-chat-completions' {
	const value = importString(record, 'protocol', 'apiProtocol', 'api_protocol');
	if (!value) {
		return fallback;
	}
	if (value === 'openai-responses' || value === 'responses') {
		return 'openai-responses';
	}
	if (value === 'openai-chat-completions' || value === 'chat-completions' || value === 'chat_completions') {
		return 'openai-chat-completions';
	}
	throw new Error(localize('models.importProvidersInvalidProtocolName', "Invalid API protocol '{0}'. Use openai-responses or openai-chat-completions.", value));
}

function importModelSettings(value: unknown): Record<string, Readonly<Record<string, unknown>>> | undefined {
	if (value === undefined) {
		return undefined;
	}
	const source = importObject(value);
	if (!source) {
		throw new Error(localize('models.importProvidersInvalidModelSettings', "modelSettings must be a JSON object keyed by model ID."));
	}
	const result: Record<string, Readonly<Record<string, unknown>>> = {};
	for (const [modelId, rawSettings] of Object.entries(source)) {
		const settings = importObject(rawSettings);
		if (!modelId.trim() || !settings) {
			throw new Error(localize('models.importProvidersInvalidModelSetting', "Each modelSettings entry must have a model ID and a JSON object value."));
		}
		result[modelId.trim()] = normalizeShunCodeImportSettings(settings) ?? {};
	}
	return Object.keys(result).length ? result : undefined;
}

function importModelIds(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value.trim() || undefined;
	}
	if (Array.isArray(value)) {
		const modelIds = value
			.map(item => typeof item === 'string' ? item.trim() : '')
			.filter(Boolean);
		return modelIds.length ? [...new Set(modelIds)].join('\n') : undefined;
	}
	return undefined;
}

function deriveProviderName(baseUrl: string, index: number): string {
	try {
		const hostname = new URL(baseUrl).hostname.replace(/^api\./i, '');
		const firstLabel = hostname.split('.')[0]?.trim();
		if (firstLabel) {
			return firstLabel;
		}
	} catch {
		// Validation reports the invalid URL later with a provider index.
	}
	return `Provider ${index + 1}`;
}

function validateProviderImport(item: IShunCodeProviderImport, index: number): IShunCodeProviderImport {
	let parsed: URL;
	try {
		parsed = new URL(item.baseUrl);
	} catch {
		throw new Error(localize('models.importProvidersInvalidUrl', "Provider {0} has an invalid Base URL.", index + 1));
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(localize('models.importProvidersInvalidProtocol', "Provider {0} Base URL must use http:// or https://.", index + 1));
	}
	if (!item.name.trim()) {
		throw new Error(localize('models.importProvidersMissingName', "Provider {0} is missing a name.", index + 1));
	}
	return { ...item, name: item.name.trim(), baseUrl: item.baseUrl.trim().replace(/\/+$/, '') };
}

/**
 * Parses ShunCode provider definitions copied from password managers, spreadsheets,
 * notes, or another ShunCode installation. API keys are only returned in-memory;
 * persistence is delegated to LanguageModelsService so secret:true fields still go
 * through the workbench SecretStorage implementation.
 */
export function parseShunCodeProviderImports(text: string): IShunCodeProviderImport[] {
	const normalized = text.trim()
		.replace(/^```(?:json)?\s*/i, '')
		.replace(/\s*```$/, '');
	if (!normalized) {
		throw new Error(localize('models.importProvidersClipboardEmpty', "The clipboard is empty."));
	}

	const curlImport = parseShunCodeCurlImport(normalized);
	if (curlImport) {
		return [curlImport];
	}

	let parsedJson: unknown;
	try {
		parsedJson = JSON.parse(normalized);
	} catch {
		parsedJson = undefined;
	}

	const imports: IShunCodeProviderImport[] = [];
	if (parsedJson !== undefined) {
		let records: unknown[];
		if (Array.isArray(parsedJson)) {
			records = parsedJson;
		} else if (parsedJson && typeof parsedJson === 'object') {
			const root = parsedJson as Record<string, unknown>;
			const nested = root.providers ?? root.configs ?? root.endpoints;
			records = Array.isArray(nested) ? nested : [root];
		} else {
			throw new Error(localize('models.importProvidersJsonShape', "Provider JSON must be an object or an array of objects."));
		}

		for (let index = 0; index < records.length; index++) {
			const value = records[index];
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				throw new Error(localize('models.importProvidersJsonEntry', "Provider {0} must be a JSON object.", index + 1));
			}
			const record = value as Record<string, unknown>;
			const baseUrl = importString(record, 'baseUrl', 'baseURL', 'base_url', 'url', 'endpoint');
			if (!baseUrl) {
				throw new Error(localize('models.importProvidersMissingUrl', "Provider {0} is missing Base URL.", index + 1));
			}
			const modelValue = record.modelIds ?? record.models ?? record.model_ids ?? record.model;
			const defaults = importObject(record.defaults);
			imports.push(validateProviderImport({
				name: importString(record, 'name', 'provider', 'providerName', 'configName', 'label') ?? deriveProviderName(baseUrl, index),
				baseUrl,
				apiKey: importString(record, 'apiKey', 'api_key', 'key', 'token'),
				modelIds: importModelIds(modelValue),
				protocol: importProtocol(record, 'openai-chat-completions'),
				settings: normalizeShunCodeImportSettings(record, defaults),
				modelSettings: importModelSettings(record.modelSettings ?? record.model_settings),
			}, index));
		}
	} else {
		const lines = normalized.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
		for (let index = 0; index < lines.length; index++) {
			const parts = lines[index].includes('|')
				? lines[index].split('|').map(part => part.trim())
				: lines[index].split('\t').map(part => part.trim());
			if (parts.length < 2) {
				throw new Error(localize('models.importProvidersLineFormat', "Line {0} must be 'name | Base URL | API Key' (API Key may be empty).", index + 1));
			}

			let name: string;
			let baseUrl: string;
			let apiKey: string | undefined;
			let modelIds: string | undefined;
			if (/^https?:\/\//i.test(parts[0])) {
				baseUrl = parts[0];
				name = deriveProviderName(baseUrl, index);
				apiKey = parts[1] || undefined;
				modelIds = parts[2] || undefined;
			} else {
				name = parts[0];
				baseUrl = parts[1];
				apiKey = parts[2] || undefined;
				modelIds = parts[3] || undefined;
			}
			imports.push(validateProviderImport({ name, baseUrl, apiKey, modelIds, protocol: 'openai-chat-completions' }, index));
		}
	}

	if (imports.length === 0) {
		throw new Error(localize('models.importProvidersNoEntries', "No provider entries were found in the clipboard."));
	}
	const names = new Set<string>();
	for (const item of imports) {
		const normalizedName = item.name.toLocaleLowerCase();
		if (names.has(normalizedName)) {
			throw new Error(localize('models.importProvidersDuplicateName', "The clipboard contains more than one provider named '{0}'.", item.name));
		}
		names.add(normalizedName);
	}
	return imports;
}

function parseShunCodeCurlImport(text: string): IShunCodeProviderImport | undefined {
	if (!/^curl(?:\.exe)?\b/i.test(text.trim())) {
		return undefined;
	}

	const compact = text
		.replace(/\\\r?\n/g, ' ')
		.replace(/`\r?\n/g, ' ')
		.replace(/\^\r?\n/g, ' ');
	const url = compact.match(/https?:\/\/[^\s'"\\]+/i)?.[0];
	if (!url) {
		throw new Error(localize('models.importProvidersCurlMissingUrl', "The curl command does not contain an http:// or https:// API URL."));
	}

	const authorization = compact.match(/(?:-H|--header)\s+["']Authorization:\s*Bearer\s+([^"']+)["']/i)?.[1]?.trim();
	const apiKey = authorization && !/^\$\{?[A-Z0-9_]+\}?$/i.test(authorization) ? authorization : undefined;
	let requestBody: Record<string, unknown> | undefined;
	const singleQuotedBody = compact.match(/(?:-d|--data(?:-raw)?)\s+'([\s\S]*?)'\s*(?=$|--?[A-Za-z])/i)?.[1];
	const doubleQuotedBody = compact.match(/(?:-d|--data(?:-raw)?)\s+"([\s\S]*?)"\s*(?=$|--?[A-Za-z])/i)?.[1];
	const rawBody = singleQuotedBody ?? doubleQuotedBody;
	if (rawBody) {
		try {
			requestBody = JSON.parse(rawBody.replace(/\\"/g, '"')) as Record<string, unknown>;
		} catch {
			throw new Error(localize('models.importProvidersCurlInvalidBody', "The curl request body after -d/--data is not valid JSON."));
		}
	}

	const thinkingValue = importObject(requestBody?.thinking)?.type ?? requestBody?.thinking;
	const thinking = typeof thinkingValue === 'string' && (thinkingValue === 'enabled' || thinkingValue === 'disabled') ? thinkingValue : undefined;
	const reasoningValue = requestBody?.reasoning_effort ?? requestBody?.reasoningEffort;
	const reasoningEffort = typeof reasoningValue === 'string' && ['low', 'medium', 'high'].includes(reasoningValue) ? reasoningValue : undefined;
	const model = typeof requestBody?.model === 'string' ? requestBody.model.trim() : undefined;
	return validateProviderImport({
		name: deriveProviderName(url, 0),
		baseUrl: url,
		apiKey,
		modelIds: model || undefined,
		protocol: 'openai-chat-completions',
		settings: {
			...(thinking ? { thinking } : {}),
			...(reasoningEffort ? { reasoningEffort } : {}),
		},
	}, 0);
}

class ModelsFilterAction extends Action {
	constructor() {
		super('workbench.models.filter', localize('filter', "Filter"), ThemeIcon.asClassName(Codicon.filter));
	}
	override async run(): Promise<void> {
	}
}

interface IFilterQuery {
	/** The primary filter query string */
	query: string;
	/** Alternative query strings that are treated as synonyms of the primary query */
	synonyms?: string[];
	/** Query strings that should be removed when adding this filter (mutually exclusive filters) */
	excludes?: string[];
}

function toggleFilter(currentQuery: string, filter: IFilterQuery): string {
	const { query, synonyms = [], excludes = [] } = filter;
	const allSynonyms = [query, ...synonyms];
	const isChecked = allSynonyms.some(q => currentQuery.includes(q));
	const hasExcludedQuery = excludes.some(q => currentQuery.includes(q));

	if (isChecked) {
		// Query or synonym is already set, remove all of them (toggle off)
		let queryWithRemovedFilter = currentQuery;
		for (const q of allSynonyms) {
			queryWithRemovedFilter = queryWithRemovedFilter.replace(q, '');
		}
		return queryWithRemovedFilter.replace(/\s+/g, ' ').trim();
	} else if (hasExcludedQuery) {
		// An excluded query is set, replace it with the new query
		let newQuery = currentQuery;
		for (const q of excludes) {
			newQuery = newQuery.replace(q, '');
		}
		newQuery = newQuery.replace(/\s+/g, ' ').trim();
		return newQuery ? `${newQuery} ${query}` : query;
	} else {
		// No filter is set, add the new query
		const trimmedQuery = currentQuery.trim();
		return trimmedQuery ? `${trimmedQuery} ${query}` : query;
	}
}

class ModelsSearchFilterDropdownMenuActionViewItem extends DropdownMenuActionViewItem {

	constructor(
		action: IAction,
		options: IActionViewItemOptions,
		private readonly search: {
			getValue(): string;
			setValue(newValue: string): void;
		},
		private readonly viewModel: ChatModelsViewModel,
		@IContextMenuService contextMenuService: IContextMenuService
	) {
		super(action,
			{ getActions: () => this.getActions() },
			contextMenuService,
			{
				...options,
				classNames: action.class,
				anchorAlignmentProvider: () => AnchorAlignment.RIGHT,
				menuAsChild: true
			}
		);
	}

	private createProviderAction(vendor: string, displayName: string): IAction {
		const query = `@provider:"${displayName}"`;
		const currentQuery = this.search.getValue();
		const isChecked = currentQuery.includes(query) || currentQuery.includes(`@provider:${vendor}`);

		return {
			id: `provider-${vendor}`,
			label: displayName,
			tooltip: localize('filterByProvider', "Filter by {0}", displayName),
			class: undefined,
			enabled: true,
			checked: isChecked,
			run: () => this.toggleFilterAndSearch({ query, synonyms: [`@provider:${vendor}`] })
		};
	}

	private createCapabilityAction(capability: string, label: string): IAction {
		const query = `@capability:${capability}`;
		const currentQuery = this.search.getValue();
		const isChecked = currentQuery.includes(query);

		return {
			id: `capability-${capability}`,
			label,
			tooltip: localize('filterByCapability', "Filter by {0}", label),
			class: undefined,
			enabled: true,
			checked: isChecked,
			run: () => this.toggleFilterAndSearch({ query })
		};
	}

	private toggleFilterAndSearch(filter: IFilterQuery): void {
		const currentQuery = this.search.getValue();
		const newQuery = toggleFilter(currentQuery, filter);
		this.search.setValue(newQuery);
	}

	private getActions(): IAction[] {
		const actions: IAction[] = [];

		// Capability filters
		actions.push(
			this.createCapabilityAction('tools', localize('capability.tools', "Tools")),
			this.createCapabilityAction('vision', localize('capability.vision', "Vision")),
			this.createCapabilityAction('agent', localize('capability.agent', "Agent Mode"))
		);

		// Provider filters - only show providers with configured models
		const configuredVendors = this.viewModel.getConfiguredVendors();
		if (configuredVendors.length > 1) {
			actions.push(new Separator());
			actions.push(...configuredVendors.map(vendor => this.createProviderAction(vendor.vendor.vendor, vendor.group.name)));
		}

		return actions;
	}
}

class Delegate implements ITableVirtualDelegate<IViewModelEntry> {
	readonly headerRowHeight = HEADER_HEIGHT;
	getHeight(element: IViewModelEntry): number {
		return isLanguageModelProviderEntry(element) || isLanguageModelGroupEntry(element) ? VENDOR_ROW_HEIGHT : MODEL_ROW_HEIGHT;
	}
}

interface IModelTableColumnTemplateData {
	readonly container: HTMLElement;
	readonly disposables: DisposableStore;
	readonly elementDisposables: DisposableStore;
}

abstract class ModelsTableColumnRenderer<T extends IModelTableColumnTemplateData> implements ITableRenderer<IViewModelEntry, T> {
	abstract readonly templateId: string;
	abstract renderTemplate(container: HTMLElement): T;

	renderElement(element: IViewModelEntry, index: number, templateData: T): void {
		templateData.elementDisposables.clear();
		const isVendor = isLanguageModelProviderEntry(element);
		const isGroup = isLanguageModelGroupEntry(element);
		const isStatus = isStatusEntry(element);
		templateData.container.classList.add('models-table-column');
		const row = templateData.container.parentElement!;
		row.classList.toggle('models-vendor-row', isVendor || isGroup);
		row.classList.toggle('models-model-row', !isVendor && !isGroup);
		row.classList.toggle('models-status-row', isStatus);
		const isHidden = (isVendor && element.hidden) || (!isVendor && !isGroup && !isStatus && (element as ILanguageModelEntry).model?.hidden);
		row.classList.toggle('models-row-hidden', !!isHidden);
		if (isVendor) {
			this.renderVendorElement(element, index, templateData);
		} else if (isGroup) {
			this.renderGroupElement(element, index, templateData);
		} else if (isStatus) {
			this.renderStatusElement(element, index, templateData);
		} else {
			this.renderModelElement(element, index, templateData);
		}
	}

	abstract renderVendorElement(element: ILanguageModelProviderEntry, index: number, templateData: T): void;
	abstract renderGroupElement(element: ILanguageModelGroupEntry, index: number, templateData: T): void;
	abstract renderModelElement(element: ILanguageModelEntry, index: number, templateData: T): void;

	protected renderStatusElement(element: IStatusEntry, index: number, templateData: T): void { }

	disposeTemplate(templateData: T): void {
		templateData.elementDisposables.dispose();
		templateData.disposables.dispose();
	}
}

interface IToggleCollapseColumnTemplateData extends IModelTableColumnTemplateData {
	readonly listRowElement: HTMLElement | null;
	readonly container: HTMLElement;
	readonly actionBar: ActionBar;
}

class GutterColumnRenderer extends ModelsTableColumnRenderer<IToggleCollapseColumnTemplateData> {

	static readonly TEMPLATE_ID = 'gutter';

	readonly templateId: string = GutterColumnRenderer.TEMPLATE_ID;

	constructor(
		private readonly viewModel: ChatModelsViewModel,
	) {
		super();
	}

	renderTemplate(container: HTMLElement): IToggleCollapseColumnTemplateData {
		const disposables = new DisposableStore();
		const elementDisposables = new DisposableStore();
		container.classList.add('models-gutter-column');
		const actionBar = disposables.add(new ActionBar(container));
		return {
			listRowElement: container.parentElement?.parentElement ?? null,
			container,
			actionBar,
			disposables,
			elementDisposables
		};
	}

	override renderElement(entry: IViewModelEntry, index: number, templateData: IToggleCollapseColumnTemplateData): void {
		templateData.actionBar.clear();
		super.renderElement(entry, index, templateData);
	}

	override renderVendorElement(entry: ILanguageModelProviderEntry, index: number, templateData: IToggleCollapseColumnTemplateData): void {
		this.renderCollapsableElement(entry, templateData);
		this.renderGroupVisibilityElement(entry, templateData);
	}

	override renderGroupElement(entry: ILanguageModelGroupEntry, index: number, templateData: IToggleCollapseColumnTemplateData): void {
		this.renderCollapsableElement(entry, templateData);
	}

	private renderCollapsableElement(entry: ILanguageModelProviderEntry | ILanguageModelGroupEntry, templateData: IToggleCollapseColumnTemplateData): void {
		if (templateData.listRowElement) {
			templateData.listRowElement.setAttribute('aria-expanded', entry.collapsed ? 'false' : 'true');
		}

		const label = entry.collapsed ? localize('expand', 'Expand') : localize('collapse', 'Collapse');
		const toggleCollapseAction = {
			id: 'toggleCollapse',
			label,
			tooltip: label,
			enabled: true,
			class: ThemeIcon.asClassName(entry.collapsed ? Codicon.chevronRight : Codicon.chevronDown),
			run: () => this.viewModel.toggleCollapsed(entry)
		};
		templateData.actionBar.push(toggleCollapseAction, { icon: true, label: false });
	}

	override renderModelElement(entry: ILanguageModelEntry, index: number, templateData: IToggleCollapseColumnTemplateData): void {
		this.renderModelVisibilityElement(entry, templateData);
	}

	private renderGroupVisibilityElement(entry: ILanguageModelProviderEntry, templateData: IToggleCollapseColumnTemplateData): void {
		const hidden = entry.hidden;
		templateData.actionBar.push({
			id: hidden ? 'showGroup' : 'hideGroup',
			label: hidden
				? localize('models.showGroup', "Show All Models")
				: localize('models.hideGroup', "Hide All Models"),
			tooltip: hidden
				? localize('models.showGroup', "Show All Models")
				: localize('models.hideGroup', "Hide All Models"),
			class: `model-visibility-toggle ${ThemeIcon.asClassName(hidden ? Codicon.eyeClosed : Codicon.eye)}`,
			enabled: true,
			run: () => this.viewModel.toggleGroupHidden(entry),
		}, { icon: true, label: false });
	}

	private renderModelVisibilityElement(entry: ILanguageModelEntry, templateData: IToggleCollapseColumnTemplateData): void {
		const hidden = entry.model.hidden;
		templateData.actionBar.push({
			id: hidden ? 'showModel' : 'hideModel',
			label: hidden
				? localize('models.showModel', "Show Model")
				: localize('models.hideModel', "Hide Model"),
			tooltip: hidden
				? localize('models.showModel', "Show Model")
				: localize('models.hideModel', "Hide Model"),
			class: `model-visibility-toggle ${ThemeIcon.asClassName(hidden ? Codicon.eyeClosed : Codicon.eye)}`,
			enabled: true,
			run: () => this.viewModel.toggleModelHidden(entry),
		}, { icon: true, label: false });
	}
}

interface IModelNameColumnTemplateData extends IModelTableColumnTemplateData {
	readonly statusIcon: HTMLElement;
	readonly nameLabel: HighlightedLabel;
	readonly modelStatusIcon: HTMLElement;
	readonly deprecationLinkContainer: HTMLElement;
	readonly deprecationLink: Link;
}

class ModelNameColumnRenderer extends ModelsTableColumnRenderer<IModelNameColumnTemplateData> {
	static readonly TEMPLATE_ID = 'modelName';

	readonly templateId: string = ModelNameColumnRenderer.TEMPLATE_ID;

	constructor(
		@IHoverService private readonly hoverService: IHoverService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IProductService private readonly productService: IProductService
	) {
		super();
	}

	renderTemplate(container: HTMLElement): IModelNameColumnTemplateData {
		const disposables = new DisposableStore();
		const elementDisposables = new DisposableStore();
		const nameContainer = DOM.append(container, $('.model-name-container'));
		const statusIcon = DOM.append(nameContainer, $('.status-icon'));
		const nameLabel = disposables.add(new HighlightedLabel(DOM.append(nameContainer, $('.model-name'))));
		const deprecationLinkContainer = DOM.append(nameContainer, $('.model-deprecation-link'));
		deprecationLinkContainer.style.display = 'none';
		const deprecationLink = disposables.add(this.instantiationService.createInstance(Link, deprecationLinkContainer, { label: '', href: '' }, {}));
		const modelStatusIcon = DOM.append(nameContainer, $('.model-status-icon'));
		return {
			container,
			statusIcon,
			nameLabel,
			modelStatusIcon,
			deprecationLinkContainer,
			deprecationLink,
			disposables,
			elementDisposables
		};
	}

	override renderElement(entry: IViewModelEntry, index: number, templateData: IModelNameColumnTemplateData): void {
		DOM.clearNode(templateData.modelStatusIcon);
		templateData.nameLabel.element.classList.remove('error-status', 'warning-status', 'info-status');
		templateData.deprecationLinkContainer.style.display = 'none';
		super.renderElement(entry, index, templateData);
	}

	override renderVendorElement(entry: ILanguageModelProviderEntry, index: number, templateData: IModelNameColumnTemplateData): void {
		templateData.nameLabel.set(entry.vendorEntry.group.name, undefined);

		const deprecationLink = entry.vendorEntry.vendor.deprecation?.link;
		if (deprecationLink) {
			const icon = $('span');
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.linkExternal));
			icon.setAttribute('aria-hidden', 'true');
			const label = $('span.model-deprecation-link-label', undefined, localize('models.deprecation.link.label', "Migrate"), icon);
			templateData.deprecationLink.link = {
				label,
				href: resolveProviderDeprecationLink(deprecationLink, this.productService.urlProtocol).toString(),
				title: localize('models.deprecation.link.tooltip', "The Ollama model provider is deprecated. Please migrate to the official extension.")
			};
			templateData.deprecationLinkContainer.style.display = '';
		}
	}

	override renderGroupElement(entry: ILanguageModelGroupEntry, index: number, templateData: IModelNameColumnTemplateData): void {
		templateData.nameLabel.set(entry.label, undefined);
	}

	override renderModelElement(entry: ILanguageModelEntry, index: number, templateData: IModelNameColumnTemplateData): void {
		const { model: modelEntry, modelNameMatches } = entry;

		templateData.statusIcon.style.display = 'none';
		templateData.modelStatusIcon.className = 'model-status-icon';
		if (modelEntry.metadata.statusIcon) {
			templateData.modelStatusIcon.classList.add(...ThemeIcon.asClassNameArray(modelEntry.metadata.statusIcon));
			templateData.modelStatusIcon.style.display = '';
		} else {
			templateData.modelStatusIcon.style.display = 'none';
		}

		templateData.nameLabel.set(modelEntry.metadata.name, modelNameMatches);

		const markdown = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
		markdown.appendMarkdown(`**${entry.model.metadata.name}**`);
		if (entry.model.metadata.id !== entry.model.metadata.version) {
			markdown.appendMarkdown(`&nbsp;<span style="background-color:#8080802B;">&nbsp;_${entry.model.metadata.id}&#64;${entry.model.metadata.version}_&nbsp;</span>`);
		} else {
			markdown.appendMarkdown(`&nbsp;<span style="background-color:#8080802B;">&nbsp;_${entry.model.metadata.id}_&nbsp;</span>`);
		}
		markdown.appendText(`\n`);

		if (entry.model.metadata.statusIcon && entry.model.metadata.tooltip) {
			if (entry.model.metadata.statusIcon) {
				markdown.appendMarkdown(`$(${entry.model.metadata.statusIcon.id})&nbsp;`);
			}
			markdown.appendMarkdown(`${entry.model.metadata.tooltip}`);
			markdown.appendText(`\n`);
		}

		templateData.elementDisposables.add(this.hoverService.setupDelayedHoverAtMouse(templateData.container!, () => ({
			content: markdown,
			appearance: {
				compact: true,
				skipFadeInAnimation: true,
			}
		})));
	}

	protected override renderStatusElement(entry: IStatusEntry, index: number, templateData: IModelNameColumnTemplateData): void {
		templateData.statusIcon.style.display = '';
		templateData.statusIcon.className = 'status-icon';
		switch (entry.severity) {
			case Severity.Error:
				templateData.nameLabel.element.classList.add('error-status');
				templateData.statusIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.error));
				break;
			case Severity.Warning:
				templateData.nameLabel.element.classList.add('warning-status');
				templateData.statusIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.warning));
				break;
			case Severity.Info:
				templateData.nameLabel.element.classList.add('info-status');
				templateData.statusIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.info));
				break;
		}
		templateData.nameLabel.set(entry.message, undefined, entry.message);
	}
}

interface ICombinedCostColumnTemplateData extends IModelTableColumnTemplateData {
	readonly inputCell: HTMLElement;
	readonly outputCell: HTMLElement;
	readonly cacheReadCell: HTMLElement;
	readonly cacheWriteCell: HTMLElement;
}

class CombinedCostColumnRenderer extends ModelsTableColumnRenderer<ICombinedCostColumnTemplateData> {
	static readonly TEMPLATE_ID = 'combinedCost';

	readonly templateId: string = CombinedCostColumnRenderer.TEMPLATE_ID;

	constructor(
		@IHoverService private readonly hoverService: IHoverService,
	) {
		super();
	}

	renderTemplate(container: HTMLElement): ICombinedCostColumnTemplateData {
		const disposables = new DisposableStore();
		const elementDisposables = new DisposableStore();
		const grid = DOM.append(container, $('.model-cost-grid'));
		const inputCell = DOM.append(grid, $('span.model-cost-cell'));
		const outputCell = DOM.append(grid, $('span.model-cost-cell'));
		const cacheReadCell = DOM.append(grid, $('span.model-cost-cell'));
		const cacheWriteCell = DOM.append(grid, $('span.model-cost-cell'));
		return {
			container,
			inputCell,
			outputCell,
			cacheReadCell,
			cacheWriteCell,
			disposables,
			elementDisposables
		};
	}

	override renderElement(entry: IViewModelEntry, index: number, templateData: ICombinedCostColumnTemplateData): void {
		templateData.inputCell.textContent = '';
		templateData.outputCell.textContent = '';
		templateData.cacheReadCell.textContent = '';
		templateData.cacheWriteCell.textContent = '';
		super.renderElement(entry, index, templateData);
	}

	override renderGroupElement(_element: ILanguageModelGroupEntry, _index: number, _templateData: ICombinedCostColumnTemplateData): void {
	}

	override renderVendorElement(_element: ILanguageModelProviderEntry, _index: number, _templateData: ICombinedCostColumnTemplateData): void {
	}

	override renderModelElement(entry: ILanguageModelEntry, index: number, templateData: ICombinedCostColumnTemplateData): void {
		const { inputCost, outputCost, cacheCost, cacheWriteCost } = entry.model.metadata;
		const hasCost = inputCost !== undefined || outputCost !== undefined || cacheCost !== undefined || cacheWriteCost !== undefined;

		if (hasCost) {
			templateData.inputCell.textContent = inputCost !== undefined ? localize('cost.input', "In: {0}", inputCost) : '';
			templateData.outputCell.textContent = outputCost !== undefined ? localize('cost.output', "Out: {0}", outputCost) : '';
			templateData.cacheReadCell.textContent = cacheCost !== undefined ? localize('cost.cacheRead', "Cache Read: {0}", cacheCost) : '';
			templateData.cacheWriteCell.textContent = cacheWriteCost !== undefined ? localize('cost.cacheWrite', "Cache Write: {0}", cacheWriteCost) : '';

			const parts: string[] = [];
			if (inputCost !== undefined) {
				parts.push(inputCost === 1
					? localize('cost.inputHover.singular', "Input: {0} credit per 1M tokens", inputCost)
					: localize('cost.inputHover.plural', "Input: {0} credits per 1M tokens", inputCost));
			}
			if (outputCost !== undefined) {
				parts.push(outputCost === 1
					? localize('cost.outputHover.singular', "Output: {0} credit per 1M tokens", outputCost)
					: localize('cost.outputHover.plural', "Output: {0} credits per 1M tokens", outputCost));
			}
			if (cacheCost !== undefined) {
				parts.push(cacheCost === 1
					? localize('cost.cacheHover.singular', "Cache Read: {0} credit per 1M tokens", cacheCost)
					: localize('cost.cacheHover.plural', "Cache Read: {0} credits per 1M tokens", cacheCost));
			}
			if (cacheWriteCost !== undefined) {
				parts.push(cacheWriteCost === 1
					? localize('cost.cacheWriteHover.singular', "Cache Write: {0} credit per 1M tokens", cacheWriteCost)
					: localize('cost.cacheWriteHover.plural', "Cache Write: {0} credits per 1M tokens", cacheWriteCost));
			}
			templateData.elementDisposables.add(this.hoverService.setupDelayedHoverAtMouse(templateData.container, () => ({
				content: parts.join('\n'),
				appearance: {
					compact: true,
					skipFadeInAnimation: true
				}
			})));
		} else {
			// Fallback for non-token-based billing (premium requests users)
			const pricingText = entry.model.metadata.pricing;
			if (pricingText) {
				templateData.inputCell.textContent = pricingText;
				templateData.elementDisposables.add(this.hoverService.setupDelayedHoverAtMouse(templateData.container, () => ({
					content: localize('pricing.tooltip', "Pricing: {0}", pricingText),
					appearance: {
						compact: true,
						skipFadeInAnimation: true
					}
				})));
			}
		}
	}
}

interface ITokenLimitsColumnTemplateData extends IModelTableColumnTemplateData {
	readonly tokenLimitsElement: HTMLElement;
}

class TokenLimitsColumnRenderer extends ModelsTableColumnRenderer<ITokenLimitsColumnTemplateData> {
	static readonly TEMPLATE_ID = 'tokenLimits';

	readonly templateId: string = TokenLimitsColumnRenderer.TEMPLATE_ID;

	constructor(
		@IHoverService private readonly hoverService: IHoverService
	) {
		super();
	}

	renderTemplate(container: HTMLElement): ITokenLimitsColumnTemplateData {
		const disposables = new DisposableStore();
		const elementDisposables = new DisposableStore();
		const tokenLimitsElement = DOM.append(container, $('.model-token-limits'));
		return {
			container,
			tokenLimitsElement,
			disposables,
			elementDisposables
		};
	}

	override renderElement(entry: IViewModelEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
		DOM.clearNode(templateData.tokenLimitsElement);
		super.renderElement(entry, index, templateData);
	}

	override renderVendorElement(entry: ILanguageModelProviderEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
	}

	override renderGroupElement(entry: ILanguageModelGroupEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
	}

	override renderModelElement(entry: ILanguageModelEntry, index: number, templateData: ITokenLimitsColumnTemplateData): void {
		const { model: modelEntry } = entry;
		const markdown = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
		if (modelEntry.metadata.maxInputTokens || modelEntry.metadata.maxOutputTokens) {
			const totalTokens = (modelEntry.metadata.maxInputTokens ?? 0) + (modelEntry.metadata.maxOutputTokens ?? 0);
			const tokenDiv = DOM.append(templateData.tokenLimitsElement, $('.token-limit-item'));
			const tokenText = DOM.append(tokenDiv, $('span'));
			tokenText.textContent = formatTokenCount(totalTokens);

			markdown.appendMarkdown(`${localize('models.contextSize', 'Context Size')}: `);
			markdown.appendMarkdown(`${formatTokenCount(totalTokens)}`);
		}

		templateData.elementDisposables.add(this.hoverService.setupDelayedHoverAtMouse(templateData.container, () => ({
			content: markdown,
			appearance: {
				compact: true,
				skipFadeInAnimation: true,
			}
		})));
	}
}

interface ICapabilitiesColumnTemplateData extends IModelTableColumnTemplateData {
	readonly metadataRow: HTMLElement;
}

class CapabilitiesColumnRenderer extends ModelsTableColumnRenderer<ICapabilitiesColumnTemplateData> implements IDisposable {
	static readonly TEMPLATE_ID = 'capabilities';

	readonly templateId: string = CapabilitiesColumnRenderer.TEMPLATE_ID;

	private readonly _onDidClickCapability = new Emitter<string>();
	readonly onDidClickCapability = this._onDidClickCapability.event;

	dispose(): void {
		this._onDidClickCapability.dispose();
	}

	renderTemplate(container: HTMLElement): ICapabilitiesColumnTemplateData {
		const disposables = new DisposableStore();
		const elementDisposables = new DisposableStore();
		container.classList.add('model-capability-column');
		const metadataRow = DOM.append(container, $('.model-capabilities'));
		return {
			container,
			metadataRow,
			disposables,
			elementDisposables
		};
	}

	override renderElement(entry: IViewModelEntry, index: number, templateData: ICapabilitiesColumnTemplateData): void {
		DOM.clearNode(templateData.metadataRow);
		super.renderElement(entry, index, templateData);
	}

	override renderVendorElement(entry: ILanguageModelProviderEntry, index: number, templateData: ICapabilitiesColumnTemplateData): void {
	}

	override renderGroupElement(entry: ILanguageModelGroupEntry, index: number, templateData: ICapabilitiesColumnTemplateData): void {
	}

	override renderModelElement(entry: ILanguageModelEntry, index: number, templateData: ICapabilitiesColumnTemplateData): void {
		const { model: modelEntry, capabilityMatches } = entry;

		if (modelEntry.metadata.capabilities?.toolCalling) {
			templateData.elementDisposables.add(this.createCapabilityButton(
				templateData.metadataRow,
				capabilityMatches?.includes('toolCalling') || false,
				localize('models.tools', 'Tools'),
				'tools'
			));
		}

		if (modelEntry.metadata.capabilities?.vision) {
			templateData.elementDisposables.add(this.createCapabilityButton(
				templateData.metadataRow,
				capabilityMatches?.includes('vision') || false,
				localize('models.vision', 'Vision'),
				'vision'
			));
		}
	}

	private createCapabilityButton(container: HTMLElement, isActive: boolean, label: string, capability: string): IDisposable {
		const disposables = new DisposableStore();
		const buttonContainer = DOM.append(container, $('.model-badge-container'));
		const button = disposables.add(new Button(buttonContainer, { secondary: true }));
		button.element.classList.add('model-capability');
		button.element.classList.toggle('active', isActive);
		button.label = label;
		disposables.add(button.onDidClick(() => this._onDidClickCapability.fire(capability)));
		return disposables;
	}
}

interface IActionsColumnTemplateData extends IModelTableColumnTemplateData {
	readonly actionBar: ToolBar;
}

function deriveProviderNameFromUrl(endpoint: string): string | undefined {
	let host: string;
	try {
		host = new URL(endpoint).hostname.replace(/^www\./i, '');
	} catch {
		return undefined;
	}
	const segments = host.split('.');
	if (segments.every(segment => /^\d+$/.test(segment))) {
		return host; // IP addresses like 127.0.0.1
	}
	if (segments.length >= 2) {
		return segments[segments.length - 2];
	}
	return host;
}

function createProviderGroupActions(
	viewModel: ChatModelsViewModel,
	vendor: ILanguageModelProviderDescriptor,
	groupName: string,
	languageModelsService: ILanguageModelsService,
	dialogService: IDialogService,
	onEditProvider: (groupName: string) => void,
): IAction[] {
	const configuration = vendor.configuration as IJSONSchema | undefined;
	if (!configuration) {
		return [];
	}

	const actions: IAction[] = [];
	const configurationProperties = configuration.properties;
	if (vendor.vendor === 'shuncode') {
		actions.push(toAction({
			id: 'editProviderAction',
			label: localize('models.editProvider', "Edit API"),
			class: ThemeIcon.asClassName(Codicon.edit),
			run: () => onEditProvider(groupName)
		}));
		actions.push(toAction({
			id: 'fetchProviderModelsAction',
			label: localize('models.fetchProviderModels', "Refresh Models"),
			class: ThemeIcon.asClassName(Codicon.refresh),
			run: async () => {
				await languageModelsService.selectLanguageModels({ vendor: vendor.vendor });
				await viewModel.refresh();
			}
		}));
		actions.push(new Separator());
	}
	actions.push(toAction({
		id: 'goToSettingsAction',
		label: localize('models.goToSettings', "Open in Language Models (JSON)"),
		run: () => languageModelsService.openLanguageModelsProviderGroupSettings(vendor.vendor, groupName)
	}));
	actions.push(new Separator());
	actions.push(toAction({
		id: 'renameGroupAction',
		label: localize('models.renameGroup', 'Rename Group'),
		run: () => languageModelsService.renameLanguageModelsProviderGroup(vendor.vendor, groupName)
	}));
	if (configurationProperties?.apiKey) {
		actions.push(toAction({
			id: 'updateApiKeyAction',
			label: localize('models.updateApiKey', "Update API Key"),
			run: () => languageModelsService.updateLanguageModelsProviderGroupApiKey(vendor.vendor, groupName)
		}));
	}
	if (configurationProperties?.models?.defaultSnippets?.[0]) {
		actions.push(toAction({
			id: 'addModelAction',
			label: localize('models.addModel', "Add Model"),
			run: () => languageModelsService.addLanguageModelsProviderGroupModel(vendor.vendor, groupName)
		}));
	}
	actions.push(new Separator());
	actions.push(toAction({
		id: 'deleteAction',
		label: localize('models.deleteAction', 'Delete'),
		class: ThemeIcon.asClassName(Codicon.trash),
		run: async () => {
			const result = await dialogService.confirm({
				type: 'info',
				message: localize('models.deleteConfirmation', "Would you like to delete {0}?", groupName)
			});
			if (!result.confirmed) {
				return;
			}
			await languageModelsService.removeLanguageModelsProviderGroup(vendor.vendor, groupName);
			viewModel.refresh();
		}
	}));
	return actions;
}

class ActionsColumnRenderer extends ModelsTableColumnRenderer<IActionsColumnTemplateData> {
	static readonly TEMPLATE_ID = 'actions';

	readonly templateId: string = ActionsColumnRenderer.TEMPLATE_ID;

	constructor(
		private readonly viewModel: ChatModelsViewModel,
		private readonly onEditProvider: (groupName: string) => void,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IDialogService private readonly dialogService: IDialogService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService
	) {
		super();
	}

	renderTemplate(container: HTMLElement): IActionsColumnTemplateData {
		const disposables = new DisposableStore();
		const elementDisposables = new DisposableStore();
		container.classList.add('models-actions-column');
		const parent = DOM.append(container, $('.actions-container'));
		const actionBar = disposables.add(this.instantiationService.createInstance(ToolBar,
			parent,
			this.contextMenuService,
			{
				icon: true,
				label: false,
				moreIcon: Codicon.gear,
				anchorAlignmentProvider: () => AnchorAlignment.RIGHT
			}
		));
		return {
			container,
			actionBar,
			disposables,
			elementDisposables
		};
	}

	override renderElement(entry: IViewModelEntry, index: number, templateData: IActionsColumnTemplateData): void {
		templateData.actionBar.setActions([]);
		super.renderElement(entry, index, templateData);
	}

	override renderVendorElement(entry: ILanguageModelProviderEntry, index: number, templateData: IActionsColumnTemplateData): void {
		const { vendorEntry } = entry;
		const primaryActions: IAction[] = [];
		const secondaryActions: IAction[] = [];
		if (vendorEntry.vendor.configuration) {
			secondaryActions.push(...createProviderGroupActions(this.viewModel, vendorEntry.vendor, vendorEntry.group.name, this.languageModelsService, this.dialogService, this.onEditProvider));
		} else if (vendorEntry.vendor.managementCommand) {
			primaryActions.push(toAction({
				id: 'manageVendor',
				label: localize('models.manageProvider', 'Manage {0}...', vendorEntry.group.name),
				class: ThemeIcon.asClassName(Codicon.gear),
				run: async () => {
					await this.commandService.executeCommand(vendorEntry.vendor.managementCommand!, vendorEntry.vendor.vendor);
					this.viewModel.refresh();
				}
			}));
		}
		templateData.actionBar.setActions(primaryActions, secondaryActions);
	}

	override renderGroupElement(entry: ILanguageModelGroupEntry, index: number, templateData: IActionsColumnTemplateData): void {
	}

	override renderModelElement(entry: ILanguageModelEntry, index: number, templateData: IActionsColumnTemplateData): void {
		const primaryActions: IAction[] = [];

		// Auto model cannot be pinned
		if (entry.model.metadata.id !== 'auto') {
			primaryActions.push(this.createPinAction(entry.model.identifier));
		}

		const configActions = this.languageModelsService.getModelConfigurationActions(entry.model.identifier);
		const secondaryActions: IAction[] = [...configActions];

		// Only offer the JSON-based "Configure..." entry for non-default vendors that are
		// configured via the language models JSON file. The default vendor (Copilot) and
		// vendors with a `managementCommand` are configured elsewhere, so this entry would
		// do nothing useful for their models.
		const vendor = entry.model.provider.vendor;
		if (!vendor.isDefault && !vendor.managementCommand && (configActions.length > 0 || entry.model.metadata.configurationSchema)) {
			secondaryActions.push(toAction({
				id: 'configureModel',
				label: localize('models.configureModel', 'Configure...'),
				run: () => this.languageModelsService.configureModel(entry.model.identifier)
			}));
		}

		templateData.actionBar.setActions(primaryActions, secondaryActions);
	}

	private createPinAction(modelIdentifier: string): IAction {
		const isPinned = this.languageModelsService.isModelPinned(modelIdentifier);
		return toAction({
			id: isPinned ? `unpin.${modelIdentifier}` : `pin.${modelIdentifier}`,
			label: isPinned
				? localize('models.unpinModel', "Unpin Model")
				: localize('models.pinModel', "Pin Model"),
			class: ThemeIcon.asClassName(isPinned ? Codicon.pinned : Codicon.pin),
			run: () => {
				if (isPinned) {
					this.languageModelsService.unpinModel(modelIdentifier);
				} else {
					this.languageModelsService.pinModel(modelIdentifier);
				}
				this.viewModel.refresh();
			}
		});
	}
}

interface IProviderColumnTemplateData extends IModelTableColumnTemplateData {
	readonly providerElement: HTMLElement;
}

class ProviderColumnRenderer extends ModelsTableColumnRenderer<IProviderColumnTemplateData> {
	static readonly TEMPLATE_ID = 'provider';

	readonly templateId: string = ProviderColumnRenderer.TEMPLATE_ID;

	renderTemplate(container: HTMLElement): IProviderColumnTemplateData {
		const disposables = new DisposableStore();
		const elementDisposables = new DisposableStore();
		const providerElement = DOM.append(container, $('.model-provider'));
		return {
			container,
			providerElement,
			disposables,
			elementDisposables
		};
	}

	override renderVendorElement(entry: ILanguageModelProviderEntry, index: number, templateData: IProviderColumnTemplateData): void {
		templateData.providerElement.textContent = '';
	}

	override renderGroupElement(entry: ILanguageModelGroupEntry, index: number, templateData: IProviderColumnTemplateData): void {
		templateData.providerElement.textContent = '';
	}

	override renderModelElement(entry: ILanguageModelEntry, index: number, templateData: IProviderColumnTemplateData): void {
		templateData.providerElement.textContent = entry.model.provider.vendor.displayName;
	}
}





export interface IChatModelsWidgetOptions {
	readonly vendor: string;
	readonly presentation: 'api' | 'codex';
}

interface ICodexAccountStatus {
	readonly signedIn: boolean;
	readonly account?: {
		readonly accountId?: string;
		readonly email?: string;
		readonly planType?: string;
	};
	readonly expiresAt?: number;
}

export class ChatModelsWidget extends Disposable {

	private static NUM_INSTANCES: number = 0;

	readonly element: HTMLElement;

	private readonly _onDidChangeItemCount = this._register(new Emitter<number>());
	readonly onDidChangeItemCount = this._onDidChangeItemCount.event;

	private searchWidget!: SuggestEnabledInput;
	private searchActionsContainer!: HTMLElement;
	private searchAndButtonContainer!: HTMLElement;
	private providerConfigurationContainer!: HTMLElement;
	private endpointInput!: InputBox;
	private apiKeyInput!: InputBox;
	private refreshProviderButton!: Button;
	private addProviderButton!: Button;
	private testProviderButton!: Button;
	private providerStatusElement!: HTMLElement;
	private providerFormHeading!: HTMLElement;
	private editingGroupName: string | undefined;
	private codexAccountDetailsElement: HTMLElement | undefined;
	private codexSignInButton: Button | undefined;
	private codexSignOutButton: Button | undefined;
	private codexReloginButton: Button | undefined;
	private apiKeyConfigured = false;
	private table!: WorkbenchTable<IViewModelEntry>;
	private tableContainer!: HTMLElement;
	private tableViewport!: HTMLElement;
	private tableInner!: HTMLElement;
	private tableScrollable: DomScrollableElement | undefined;
	private tableMinWidth: number = 0;
	private addButtonContainer!: HTMLElement;
	private addButton!: Button;
	private viewModel: ChatModelsViewModel;
	private delayedFiltering: Delayer<void>;

	private readonly searchFocusContextKey: IContextKey<boolean>;

	private readonly tableDisposables = this._register(new DisposableStore());

	constructor(
		private readonly options: IChatModelsWidgetOptions,
		@ILanguageModelsService private readonly languageModelsService: ILanguageModelsService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IExtensionService private readonly extensionService: IExtensionService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IChatEntitlementService private readonly chatEntitlementService: IChatEntitlementService,
		@IEditorProgressService private readonly editorProgressService: IEditorProgressService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IDialogService private readonly dialogService: IDialogService,
		@INotificationService private readonly notificationService: INotificationService,
	) {
		super();

		this.searchFocusContextKey = CONTEXT_MODELS_SEARCH_FOCUS.bindTo(this.contextKeyService);
		this.delayedFiltering = this._register(new Delayer<void>(200));
		this.viewModel = this._register(this.instantiationService.createInstance(ChatModelsViewModel));
		this.element = DOM.$('.models-widget');
		this.create(this.element);

		const loadingPromise = this.extensionService.whenInstalledExtensionsRegistered().then(async () => {
			if (this.options.presentation === 'codex') {
				await Promise.all([this.refreshCodexModels(false), this.loadCodexAccountStatus()]);
			} else {
				await Promise.all([this.viewModel.refresh(), this.loadShunCodeProviderConfiguration()]);
			}
		});
		this.editorProgressService.showWhile(loadingPromise, 300);
	}

	private create(container: HTMLElement): void {
		this.createProviderConfiguration(container);

		this.searchAndButtonContainer = DOM.append(container, $('.models-search-and-button-container'));

		const placeholder = localize('Search.FullTextSearchPlaceholder', "Type to search...");
		const searchContainer = DOM.append(this.searchAndButtonContainer, $('.models-search-container'));
		this.searchWidget = this._register(this.instantiationService.createInstance(
			SuggestEnabledInput,
			'chatModelsWidget.searchbox',
			searchContainer,
			{
				triggerCharacters: ['@', ':'],
				provideResults: (query: string) => {
					const providerSuggestions = this.viewModel.getVendors().map(v => `@provider:"${v.displayName}"`);
					const allSuggestions = [
						...providerSuggestions,
						...SEARCH_SUGGESTIONS.CAPABILITIES,
					];
					if (!query.trim()) {
						return allSuggestions;
					}
					const queryParts = query.split(/\s/g);
					const lastPart = queryParts[queryParts.length - 1];
					if (lastPart.startsWith('@provider:')) {
						return providerSuggestions;
					} else if (lastPart.startsWith('@capability:')) {
						return SEARCH_SUGGESTIONS.CAPABILITIES;
					} else if (lastPart.startsWith('@')) {
						return allSuggestions;
					}
					return [];
				}
			},
			placeholder,
			`chatModelsWidget:searchinput:${ChatModelsWidget.NUM_INSTANCES++}`,
			{
				placeholderText: placeholder,
				styleOverrides: {
					inputBorder: settingsTextInputBorder
				},
				focusContextKey: this.searchFocusContextKey,
			},
		));

		const filterAction = this._register(new ModelsFilterAction());
		const clearSearchAction = this._register(new Action(
			'workbench.models.clearSearch',
			localize('clearSearch', "Clear Search"),
			ThemeIcon.asClassName(preferencesClearInputIcon),
			false,
			() => this.clearSearch()
		));
		const collapseAllAction = this._register(new Action(
			'workbench.models.collapseAll',
			localize('collapseAll', "Collapse All"),
			ThemeIcon.asClassName(Codicon.collapseAll),
			false,
			() => {
				this.viewModel.collapseAll();
			}
		));
		collapseAllAction.enabled = this.viewModel.viewModelEntries.some(e => isLanguageModelGroupEntry(e) || isLanguageModelProviderEntry(e));
		this._register(this.viewModel.onDidChange(() => collapseAllAction.enabled = this.viewModel.viewModelEntries.some(e => isLanguageModelProviderEntry(e) || isLanguageModelGroupEntry(e))));

		this._register(this.searchWidget.onInputDidChange(() => {
			clearSearchAction.enabled = !!this.searchWidget.getValue();
			this.filterModels();
		}));

		this.searchActionsContainer = DOM.append(searchContainer, $('.models-search-actions'));
		const actions = [clearSearchAction, collapseAllAction, filterAction];
		const toolBar = this._register(new ToolBar(this.searchActionsContainer, this.contextMenuService, {
			actionViewItemProvider: (action: IAction, options: IActionViewItemOptions) => {
				if (action.id === filterAction.id) {
					return this.instantiationService.createInstance(ModelsSearchFilterDropdownMenuActionViewItem, action, options, {
						getValue: () => this.searchWidget.getValue(),
						setValue: (searchValue) => this.search(searchValue)
					}, this.viewModel);
				}
				return undefined;
			},
			getKeyBinding: () => undefined
		}));
		toolBar.setActions(actions);

		// Add padding to input box for toolbar
		this.searchWidget.inputWidget.getContainerDomNode().style.paddingRight = `${DOM.getTotalWidth(this.searchActionsContainer) + 12}px`;

		this.addButtonContainer = DOM.append(this.searchAndButtonContainer, $('.section-title-actions'));
		const buttonOptions: IButtonOptions = {
			...defaultButtonStyles,
			supportIcons: true,
		};

		this.addButton = this._register(new Button(this.addButtonContainer, buttonOptions));
		this.addButton.label = `$(${Codicon.settingsGear.id}) ${localize('models.configureApiProvider', 'Configure API')}`;
		this.addButton.element.classList.add('models-add-model-button');
		if (this.options.presentation === 'codex') {
			this.addButtonContainer.style.display = 'none';
		} else {
			this.updateAddModelsButton();
			this._register(this.addButton.onDidClick(() => this.configureShunCodeProvider()));
		}

		// Table container
		this.tableContainer = DOM.append(container, $('.models-table-container'));

		// Create table
		this.createTable();
		this._register(this.viewModel.onDidChangeGrouping(() => this.createTable()));
		this._register(this.chatEntitlementService.onDidChangeEntitlement(() => {
			this.updateAddModelsButton();
			this.createTable();
		}));
		this._register(this.chatEntitlementService.onDidChangeUsageBasedBilling(() => this.createTable()));
		this._register(this.languageModelsService.onDidChangeLanguageModelVendors(() => this.updateAddModelsButton()));
		this._register(this.languageModelsService.onDidChangePinnedModels(() => this.viewModel.refresh()));
		this._register(this.contextKeyService.onDidChangeContext(e => {
			if (e.affectsSome(new Set(['github.copilot.clientByokEnabled']))) {
				this.updateAddModelsButton();
			}
		}));
	}

	private createProviderConfiguration(container: HTMLElement): void {
		this.providerConfigurationContainer = DOM.append(container, $('.models-provider-configuration'));
		if (this.options.presentation === 'codex') {
			this.createCodexAccountConfiguration();
			return;
		}
		const header = DOM.append(this.providerConfigurationContainer, $('.models-provider-configuration-header'));
		this.providerFormHeading = DOM.append(header, $('div.models-provider-configuration-heading'));
		this.updateProviderFormHeader();
		const description = DOM.append(header, $('div.models-provider-configuration-description'));
		description.textContent = localize('models.apiConnectionDescription', "Enter an endpoint URL and API key. Test verifies the connection; Add API creates a new provider group. Use a group's gear menu to edit, rename or delete it.");

		const fields = DOM.append(this.providerConfigurationContainer, $('.models-provider-configuration-fields'));
		const endpointField = DOM.append(fields, $('.models-provider-configuration-field'));
		const endpointLabel = DOM.append(endpointField, $('label.models-provider-configuration-label'));
		endpointLabel.textContent = localize('models.apiEndpoint', "API Endpoint URL");
		const endpointInputContainer = DOM.append(endpointField, $('.models-provider-configuration-input'));
		this.endpointInput = this._register(new InputBox(endpointInputContainer, undefined, {
			placeholder: localize('models.apiEndpointPlaceholder', "https://api.example.com/v1"),
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this.endpointInput.setAriaLabel(localize('models.apiEndpointAriaLabel', "API endpoint URL"));

		const apiKeyField = DOM.append(fields, $('.models-provider-configuration-field'));
		const apiKeyLabel = DOM.append(apiKeyField, $('label.models-provider-configuration-label'));
		apiKeyLabel.textContent = localize('models.apiKey', "API Key");
		const apiKeyInputContainer = DOM.append(apiKeyField, $('.models-provider-configuration-input'));
		this.apiKeyInput = this._register(new InputBox(apiKeyInputContainer, undefined, {
			placeholder: localize('models.apiKeyPlaceholder', "Paste your API key"),
			inputBoxStyles: defaultInputBoxStyles,
		}));
		this.apiKeyInput.setAriaLabel(localize('models.apiKeyAriaLabel', "API key"));
		this.apiKeyInput.inputElement.type = 'password';
		this.apiKeyInput.inputElement.autocomplete = 'off';

		const footer = DOM.append(this.providerConfigurationContainer, $('.models-provider-configuration-footer'));
		this.providerStatusElement = DOM.append(footer, $('div.models-provider-configuration-status'));
		const actions = DOM.append(footer, $('.models-provider-configuration-actions'));
		this.testProviderButton = this._register(new Button(actions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.testProviderButton.label = `$(${Codicon.debugStart.id}) ${localize('models.testProvider', "Test")}`;
		this._register(this.testProviderButton.onDidClick(() => this.testProviderConnection()));
		this.addProviderButton = this._register(new Button(actions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.addProviderButton.label = `$(${Codicon.add.id}) ${localize('models.addApiProvider', "Add API")}`;
		this._register(this.addProviderButton.onDidClick(() => this.addShunCodeProvider()));
	}

	private createCodexAccountConfiguration(): void {
		const header = DOM.append(this.providerConfigurationContainer, $('.models-provider-configuration-header'));
		const heading = DOM.append(header, $('div.models-provider-configuration-heading'));
		heading.textContent = localize('models.codexAccount', "Codex Account");
		const description = DOM.append(header, $('div.models-provider-configuration-description'));
		description.textContent = localize('models.codexAccountDescription', "Sign in with your ChatGPT subscription. Discovered Codex models become available in the Chat model picker.");

		this.codexAccountDetailsElement = DOM.append(this.providerConfigurationContainer, $('div.models-codex-account-details'));
		const footer = DOM.append(this.providerConfigurationContainer, $('.models-provider-configuration-footer'));
		this.providerStatusElement = DOM.append(footer, $('div.models-provider-configuration-status'));
		const actions = DOM.append(footer, $('.models-provider-configuration-actions'));

		this.refreshProviderButton = this._register(new Button(actions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.refreshProviderButton.label = `$(${Codicon.refresh.id}) ${localize('models.refreshModels', "Refresh Models")}`;
		this._register(this.refreshProviderButton.onDidClick(() => this.refreshCodexModels(true)));

		this.codexReloginButton = this._register(new Button(actions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.codexReloginButton.label = `$(${Codicon.sync.id}) ${localize('models.codexSignInAgain', "Sign In Again")}`;
		this._register(this.codexReloginButton.onDidClick(() => this.runCodexAccountCommand('shuncode.codex.relogin')));

		this.codexSignOutButton = this._register(new Button(actions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.codexSignOutButton.label = `$(${Codicon.signOut.id}) ${localize('models.codexSignOut', "Sign Out")}`;
		this._register(this.codexSignOutButton.onDidClick(() => this.runCodexAccountCommand('shuncode.codex.logout')));

		this.codexSignInButton = this._register(new Button(actions, { ...defaultButtonStyles, supportIcons: true }));
		this.codexSignInButton.label = `$(${Codicon.account.id}) ${localize('models.codexSignIn', "Sign In")}`;
		this._register(this.codexSignInButton.onDidClick(() => this.runCodexAccountCommand('shuncode.codex.login')));
	}

	private createTable(): void {
		this.tableDisposables.clear();
		DOM.clearNode(this.tableContainer);

		this.tableViewport = $('.models-table-viewport');
		this.tableInner = DOM.append(this.tableViewport, $('.models-table-inner'));
		this.tableScrollable = this.tableDisposables.add(new DomScrollableElement(this.tableViewport, {
			horizontal: ScrollbarVisibility.Auto,
			vertical: ScrollbarVisibility.Hidden,
			useShadows: false,
			scrollYToX: true,
		}));
		this.tableContainer.appendChild(this.tableScrollable.getDomNode());

		const gutterColumnRenderer = this.instantiationService.createInstance(GutterColumnRenderer, this.viewModel);
		const modelNameColumnRenderer = this.instantiationService.createInstance(ModelNameColumnRenderer);
		const combinedCostColumnRenderer = this.instantiationService.createInstance(CombinedCostColumnRenderer);
		const tokenLimitsColumnRenderer = this.instantiationService.createInstance(TokenLimitsColumnRenderer);
		const capabilitiesColumnRenderer = this.instantiationService.createInstance(CapabilitiesColumnRenderer);
		const actionsColumnRenderer = this.instantiationService.createInstance(ActionsColumnRenderer, this.viewModel, (groupName: string) => this.editProviderInForm(groupName));
		const providerColumnRenderer = this.instantiationService.createInstance(ProviderColumnRenderer);

		this.tableDisposables.add(capabilitiesColumnRenderer);
		this.tableDisposables.add(capabilitiesColumnRenderer.onDidClickCapability(capability => {
			const currentQuery = this.searchWidget.getValue();
			const query = `@capability:${capability}`;
			const newQuery = toggleFilter(currentQuery, { query });
			this.search(newQuery);
		}));

		const columns = [
			{
				label: '',
				tooltip: '',
				weight: 0.05,
				minimumWidth: 64,
				maximumWidth: 64,
				templateId: GutterColumnRenderer.TEMPLATE_ID,
				project(row: IViewModelEntry): IViewModelEntry { return row; }
			},
			{
				label: localize('modelName', 'Name'),
				tooltip: '',
				weight: 0.35,
				minimumWidth: 200,
				templateId: ModelNameColumnRenderer.TEMPLATE_ID,
				project(row: IViewModelEntry): IViewModelEntry { return row; }
			}
		];

		const isUBB = this.chatEntitlementService.quotas.usageBasedBilling === true;
		columns.push(
			{
				label: localize('tokenLimits', 'Context Size'),
				tooltip: '',
				weight: 0.1,
				minimumWidth: 140,
				templateId: TokenLimitsColumnRenderer.TEMPLATE_ID,
				project(row: IViewModelEntry): IViewModelEntry { return row; }
			},
			{
				label: localize('capabilities', 'Capabilities'),
				tooltip: '',
				weight: 0.15,
				minimumWidth: 180,
				templateId: CapabilitiesColumnRenderer.TEMPLATE_ID,
				project(row: IViewModelEntry): IViewModelEntry { return row; }
			},
			{
				label: isUBB ? localize('cost', 'Cost (Credits per 1M Tokens)') : localize('pricing', 'Pricing'),
				tooltip: '',
				weight: isUBB ? 0.24 : 0.15,
				minimumWidth: isUBB ? 240 : 200,
				templateId: CombinedCostColumnRenderer.TEMPLATE_ID,
				project(row: IViewModelEntry): IViewModelEntry { return row; }
			},
			{
				label: '',
				tooltip: '',
				weight: 0.05,
				minimumWidth: 64,
				maximumWidth: 64,
				templateId: ActionsColumnRenderer.TEMPLATE_ID,
				project(row: IViewModelEntry): IViewModelEntry { return row; }
			}
		);

		this.tableMinWidth = columns.reduce((sum, c) => sum + c.minimumWidth, 0);
		this.tableInner.style.minWidth = `${this.tableMinWidth}px`;

		this.table = this.tableDisposables.add(this.instantiationService.createInstance(
			WorkbenchTable,
			'ModelsWidget',
			this.tableInner,
			new Delegate(),
			columns,
			[
				gutterColumnRenderer,
				modelNameColumnRenderer,
				combinedCostColumnRenderer,
				tokenLimitsColumnRenderer,
				capabilitiesColumnRenderer,
				actionsColumnRenderer,
				providerColumnRenderer
			],
			{
				identityProvider: { getId: (e: IViewModelEntry) => e.id },
				horizontalScrolling: false,
				accessibilityProvider: {
					getAriaLabel: (e: IViewModelEntry) => {
						if (isLanguageModelProviderEntry(e)) {
							return e.hidden
								? localize('vendor.hidden.ariaLabel', '{0} Models (hidden)', e.vendorEntry.group.name)
								: localize('vendor.ariaLabel', '{0} Models', e.vendorEntry.group.name);
						} else if (isLanguageModelGroupEntry(e)) {
							return e.id === 'visible' ? localize('visible.ariaLabel', 'Visible Models') : localize('hidden.ariaLabel', 'Hidden Models');
						} else if (isStatusEntry(e)) {
							return localize('status.ariaLabel', 'Status: {0}', e.message);
						}
						const ariaLabels = [];
						ariaLabels.push(e.model.hidden
							? localize('model.name.hidden', '{0} from {1} (hidden)', e.model.metadata.name, e.model.provider.vendor.displayName)
							: localize('model.name', '{0} from {1}', e.model.metadata.name, e.model.provider.vendor.displayName));
						if (e.model.metadata.maxInputTokens || e.model.metadata.maxOutputTokens) {
							const totalTokens = (e.model.metadata.maxInputTokens ?? 0) + (e.model.metadata.maxOutputTokens ?? 0);
							ariaLabels.push(localize('model.contextSize.totalTokens', 'Context size: {0} tokens', formatTokenCount(totalTokens)));
						}
						if (e.model.metadata.capabilities) {
							ariaLabels.push(localize('model.capabilities', 'Capabilities: {0}', Object.keys(e.model.metadata.capabilities).join(', ')));
						}
						const pricingText = e.model.metadata.pricing ?? '-';
						if (pricingText !== '-') {
							ariaLabels.push(localize('pricing.ariaLabel', "Pricing: {0}", pricingText));
						}
						if (e.model.metadata.inputCost !== undefined) {
							ariaLabels.push(e.model.metadata.inputCost === 1
								? localize('inputCost.ariaLabel.singular', "Input cost: {0} credit per 1M tokens", e.model.metadata.inputCost)
								: localize('inputCost.ariaLabel.plural', "Input cost: {0} credits per 1M tokens", e.model.metadata.inputCost));
						}
						if (e.model.metadata.cacheCost !== undefined) {
							ariaLabels.push(e.model.metadata.cacheCost === 1
								? localize('cacheCost.ariaLabel.singular', "Cache read cost: {0} credit per 1M tokens", e.model.metadata.cacheCost)
								: localize('cacheCost.ariaLabel.plural', "Cache read cost: {0} credits per 1M tokens", e.model.metadata.cacheCost));
						}
						if (e.model.metadata.cacheWriteCost !== undefined) {
							ariaLabels.push(e.model.metadata.cacheWriteCost === 1
								? localize('cacheWriteCost.ariaLabel.singular', "Cache write cost: {0} credit per 1M tokens", e.model.metadata.cacheWriteCost)
								: localize('cacheWriteCost.ariaLabel.plural', "Cache write cost: {0} credits per 1M tokens", e.model.metadata.cacheWriteCost));
						}
						if (e.model.metadata.outputCost !== undefined) {
							ariaLabels.push(e.model.metadata.outputCost === 1
								? localize('outputCost.ariaLabel.singular', "Output cost: {0} credit per 1M tokens", e.model.metadata.outputCost)
								: localize('outputCost.ariaLabel.plural', "Output cost: {0} credits per 1M tokens", e.model.metadata.outputCost));
						}
						return ariaLabels.join('. ');
					},
					getWidgetAriaLabel: () => localize('modelsTable.ariaLabel', 'Language Models')
				},
				multipleSelectionSupport: true,
				setRowLineHeight: false,
				openOnSingleClick: true,
				alwaysConsumeMouseWheel: false,
			}
		)) as WorkbenchTable<IViewModelEntry>;

		this.tableDisposables.add(this.table.onContextMenu(e => {
			if (!e.element) {
				return;
			}

			const selection = this.table.getSelection();
			const selectedEntries = selection.every(i => i !== e.index) ? [e.element] : selection.map(i => this.viewModel.viewModelEntries[i]).filter(e => !!e);

			// Get model entries from selection (filter out vendor/group/status entries)
			const selectedModelEntries = selectedEntries.filter((entry): entry is ILanguageModelEntry =>
				!isLanguageModelProviderEntry(entry) && !isLanguageModelGroupEntry(entry) && !isStatusEntry(entry)
			);

			const actions: IAction[] = [];
			let configureGroup: string | undefined;
			let configureVendor: ILanguageModelProviderDescriptor | undefined;

			if (selectedModelEntries.length) {
				// Pin/unpin action — single action for all selected models
				const pinnableEntries = selectedModelEntries.filter(e => e.model.metadata.id !== 'auto');
				if (pinnableEntries.length > 0) {
					const allPinned = pinnableEntries.every(e => this.languageModelsService.isModelPinned(e.model.identifier));
					actions.push(toAction({
						id: allPinned ? 'unpinModels' : 'pinModels',
						label: allPinned
							? localize('models.unpinModel', "Unpin Model")
							: localize('models.pinModel', "Pin Model"),
						class: ThemeIcon.asClassName(allPinned ? Codicon.pinned : Codicon.pin),
						run: () => {
							for (const entry of pinnableEntries) {
								if (allPinned) {
									this.languageModelsService.unpinModel(entry.model.identifier);
								} else {
									this.languageModelsService.pinModel(entry.model.identifier);
								}
							}
						}
					}));
				}

				// Hide/show action — single action for all selected models
				const allHidden = selectedModelEntries.every(e => e.model.hidden);
				actions.push(toAction({
					id: allHidden ? 'showModels' : 'hideModels',
					label: allHidden
						? (selectedModelEntries.length === 1
							? localize('models.showModel', "Show Model")
							: localize('models.showModelsPlural', "Show Models"))
						: (selectedModelEntries.length === 1
							? localize('models.hideModel', "Hide Model")
							: localize('models.hideModelsPlural', "Hide Models")),
					class: ThemeIcon.asClassName(allHidden ? Codicon.eyeClosed : Codicon.eye),
					run: () => this.viewModel.setModelsHidden(selectedModelEntries, !allHidden),
				}));

				// Show per-model configuration actions for a single model
				if (selectedModelEntries.length === 1) {
					const configActions = this.languageModelsService.getModelConfigurationActions(selectedModelEntries[0].model.identifier);
					if (configActions.length) {
						actions.push(new Separator());
						actions.push(...configActions);
					}
				}

				// Show configure action if all models are from the same group
				configureGroup = selectedModelEntries[0].model.provider.group.name;
				configureVendor = selectedModelEntries[0].model.provider.vendor;
				if (selectedModelEntries.some(entry => entry.model.provider.vendor.isDefault || entry.model.provider.group.name !== configureGroup)) {
					configureGroup = undefined;
					configureVendor = undefined;
				}
			} else if (selectedEntries.length === 1) {
				const entry = e.element;
				if (isLanguageModelProviderEntry(entry)) {
					configureGroup = entry.vendorEntry.group.name;
					configureVendor = entry.vendorEntry.vendor;

					actions.push(toAction({
						id: entry.hidden ? 'showGroup' : 'hideGroup',
						label: entry.hidden
							? localize('models.showGroup', "Show All Models")
							: localize('models.hideGroup', "Hide All Models"),
						class: ThemeIcon.asClassName(entry.hidden ? Codicon.eyeClosed : Codicon.eye),
						run: () => this.viewModel.toggleGroupHidden(entry),
					}));
				}
			}

			if (configureGroup && configureVendor) {
				const groupActions = configureVendor.managementCommand
					? [toAction({
						id: 'manageVendor',
						label: localize('models.manageProvider', 'Manage {0}...', configureGroup),
						run: async () => {
							await this.commandService.executeCommand(configureVendor.managementCommand!, configureVendor.vendor);
							await this.viewModel.refresh();
						}
					})]
					: createProviderGroupActions(this.viewModel, configureVendor, configureGroup, this.languageModelsService, this.dialogService, (groupName: string) => this.editProviderInForm(groupName));
				if (groupActions.length) {
					if (actions.length) {
						actions.push(new Separator());
					}
					actions.push(...groupActions);
				}
			}

			if (actions.length > 0) {
				this.contextMenuService.showContextMenu({
					getAnchor: () => e.anchor,
					getActions: () => actions
				});
			}
		}));

		this.table.splice(0, this.table.length, this.getDisplayedModelEntries());
		this._onDidChangeItemCount.fire(this.itemCount);
		this.tableDisposables.add(this.viewModel.onDidChange(() => {
			const displayedEntries = this.getDisplayedModelEntries();
			this.table.splice(0, this.table.length, displayedEntries);
			this._onDidChangeItemCount.fire(this.itemCount);
			if (this.viewModel.selectedEntry) {
				const selectedEntryIndex = displayedEntries.findIndex(entry => entry.id === this.viewModel.selectedEntry?.id);
				if (selectedEntryIndex >= 0) {
					this.table.setFocus([selectedEntryIndex]);
					this.table.setSelection([selectedEntryIndex]);
				}
			}
		}));

		this.tableDisposables.add(this.table.onDidOpen(async ({ element, browserEvent }) => {
			if (!element) {
				return;
			}
			if (isStatusEntry(element)) {
				return;
			}
			if (isLanguageModelProviderEntry(element) || isLanguageModelGroupEntry(element)) {
				this.viewModel.toggleCollapsed(element);
			}
		}));

		this.tableDisposables.add(this.table.onDidChangeSelection(e => this.viewModel.selectedEntry = e.elements[0]));

		this.tableDisposables.add(this.table.onDidBlur(() => {
			if (this.viewModel.shouldRefilter()) {
				this.viewModel.filter(this.searchWidget.getValue());
			}
		}));

		this.layout(this.element.clientHeight, this.element.clientWidth);
	}

	private getDisplayedModelEntries(): IViewModelEntry[] {
		return this.viewModel.viewModelEntries.filter(entry => {
			if (entry.type === 'model') {
				return entry.model.provider.vendor.vendor === this.options.vendor;
			}
			if (entry.type === 'vendor') {
				return entry.vendorEntry.vendor.vendor === this.options.vendor;
			}
			if (entry.type === 'status') {
				return entry.id.startsWith(`status.${this.options.vendor}-`);
			}
			return false;
		});
	}

	private updateAddModelsButton(): void {
		if (this.options.presentation === 'codex') {
			return;
		}
		const configurableVendors = this.languageModelsService.getVendors().filter(vendor => vendor.managementCommand || vendor.configuration);
		const provider = configurableVendors.find(vendor => vendor.vendor === this.options.vendor);
		this.addButton.enabled = !!provider;
		this.addButton.setTitle(provider
			? localize('models.configureApiProviderTitle', "Set the API endpoint and API key. Models are discovered automatically.")
			: localize('models.apiProviderUnavailable', "API provider is unavailable."));
	}

	private setProviderStatus(message: string, state: 'normal' | 'success' | 'error' = 'normal'): void {
		this.providerStatusElement.textContent = message;
		this.providerStatusElement.classList.toggle('success', state === 'success');
		this.providerStatusElement.classList.toggle('error', state === 'error');
	}

	private setCodexButtonsEnabled(enabled: boolean): void {
		this.refreshProviderButton.enabled = enabled;
		if (this.codexSignInButton) {
			this.codexSignInButton.enabled = enabled;
		}
		if (this.codexSignOutButton) {
			this.codexSignOutButton.enabled = enabled;
		}
		if (this.codexReloginButton) {
			this.codexReloginButton.enabled = enabled;
		}
	}

	private async loadCodexAccountStatus(): Promise<void> {
		if (this.options.presentation !== 'codex' || !this.codexAccountDetailsElement) {
			return;
		}
		try {
			const status = await this.commandService.executeCommand<ICodexAccountStatus>('shuncode.codex.getStatus');
			const signedIn = status?.signedIn === true;
			this.codexSignInButton?.element.classList.toggle('hidden', signedIn);
			this.codexSignOutButton?.element.classList.toggle('hidden', !signedIn);
			this.codexReloginButton?.element.classList.toggle('hidden', !signedIn);
			if (!signedIn) {
				this.codexAccountDetailsElement.textContent = localize('models.codexSignedOutDetails', "No Codex account is signed in.");
				this.setProviderStatus(localize('models.codexSignedOut', "Sign in to discover Codex models."));
				return;
			}
			const account = status?.account;
			const identity = account?.email || account?.accountId || localize('models.codexAccountFallback', "Codex account");
			const details = [identity];
			if (account?.planType) {
				details.push(localize('models.codexPlan', "Plan: {0}", account.planType));
			}
			if (status?.expiresAt) {
				details.push(localize('models.codexTokenExpiry', "Access token expires: {0}", new Date(status.expiresAt * 1000).toLocaleString()));
			}
			this.codexAccountDetailsElement.textContent = details.join(' · ');
			this.setProviderStatus(localize('models.codexSignedIn', "Signed in. Refresh models after changing accounts."), 'success');
		} catch (error) {
			this.codexAccountDetailsElement.textContent = localize('models.codexStatusUnavailable', "Codex account status is unavailable.");
			this.setProviderStatus(getErrorMessage(error), 'error');
		}
	}

	private async runCodexAccountCommand(command: 'shuncode.codex.login' | 'shuncode.codex.logout' | 'shuncode.codex.relogin'): Promise<void> {
		this.setCodexButtonsEnabled(false);
		try {
			await this.commandService.executeCommand(command);
			await this.refreshCodexModels(false);
			await this.loadCodexAccountStatus();
		} catch (error) {
			const message = getErrorMessage(error);
			this.setProviderStatus(message, 'error');
			this.notificationService.error(message);
		} finally {
			this.setCodexButtonsEnabled(true);
		}
	}

	private async refreshCodexModels(showSuccess: boolean): Promise<void> {
		if (this.options.presentation !== 'codex') {
			return;
		}
		this.setCodexButtonsEnabled(false);
		this.setProviderStatus(localize('models.loadingCodexModels', "Loading Codex models…"));
		try {
			const models = await this.languageModelsService.selectLanguageModels({ vendor: this.options.vendor });
			await this.viewModel.refresh();
			if (showSuccess) {
				this.setProviderStatus(localize('models.codexModelsRefreshedWithCount', "{0} Codex models loaded.", models.length), 'success');
			}
		} catch (error) {
			const message = getErrorMessage(error);
			this.setProviderStatus(message, 'error');
			if (showSuccess) {
				this.notificationService.error(message);
			}
		} finally {
			this.setCodexButtonsEnabled(true);
		}
	}

	private async loadShunCodeProviderConfiguration(): Promise<void> {
		const getConfiguration = this.languageModelsService.getLanguageModelsProviderConfiguration;
		if (!getConfiguration) {
			this.setProviderStatus(localize('models.inlineConfigurationUnavailable', "Use Configure API to edit this provider."));
			return;
		}

		try {
			const configuration = await getConfiguration.call(this.languageModelsService, this.options.vendor);
			this.editingGroupName = undefined;
			this.updateProviderFormHeader();
			this.endpointInput.value = '';
			this.apiKeyConfigured = configuration?.configuredSecretKeys.includes('apiKey') ?? false;
			this.apiKeyInput.value = '';
			this.apiKeyInput.setPlaceHolder(this.apiKeyConfigured
				? localize('models.savedApiKeyPlaceholder', "Saved securely — leave blank to keep it")
				: localize('models.apiKeyPlaceholder', "Paste your API key"));
			this.setProviderStatus(localize('models.providerFormHint', "Enter an endpoint URL and API key, then click Add API. Use a provider's gear menu to edit it."), 'normal');
		} catch (error) {
			this.setProviderStatus(getErrorMessage(error), 'error');
		}
	}

	private async testProviderConnection(): Promise<boolean> {
		const endpoint = this.endpointInput.value.trim();
		const apiKey = this.apiKeyInput.value.trim();
		if (!endpoint) {
			this.endpointInput.focus();
			this.setProviderStatus(localize('models.enterApiEndpoint', "Enter an API endpoint URL."), 'error');
			return false;
		}

		try {
			const parsed = new URL(endpoint);
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				throw new Error(localize('models.invalidApiEndpointProtocol', "The API endpoint must use http or https."));
			}
		} catch (error) {
			this.endpointInput.focus();
			this.setProviderStatus(error instanceof Error ? error.message : localize('models.invalidApiEndpoint', "Enter a valid API endpoint URL."), 'error');
			return false;
		}

		this.setProviderStatus(localize('models.testingProvider', "Testing connection…"));
		try {
			const result = await this.commandService.executeCommand<{ ok: boolean; count?: number; error?: string }>('shuncode.testApiEndpoint', { baseUrl: endpoint, apiKey });
			if (!result?.ok) {
				this.setProviderStatus(localize('models.testFailed', "Connection failed: {0}", result?.error ?? 'Unknown error'), 'error');
				return false;
			}
			this.setProviderStatus(localize('models.testSucceededWithCount', "Connection OK. {0} models available.", result.count ?? 0), 'success');
			return true;
		} catch (error) {
			this.setProviderStatus(localize('models.testFailed', "Connection failed: {0}", getErrorMessage(error)), 'error');
			return false;
		}
	}

	private filterModels(): void {
		this.delayedFiltering.trigger(() => {
			this.viewModel.filter(this.searchWidget.getValue());
		});
	}

	private configureShunCodeProvider(): void {
		this.editingGroupName = undefined;
		this.updateProviderFormHeader();
		this.endpointInput.value = '';
		this.apiKeyInput.value = '';
		this.apiKeyInput.setPlaceHolder(this.apiKeyConfigured
			? localize('models.savedApiKeyPlaceholder', "Saved securely — leave blank to keep it")
			: localize('models.apiKeyPlaceholder', "Paste your API key"));
		this.setProviderStatus(localize('models.enterNewProvider', "Enter an endpoint URL and API key, then click Add API."), 'normal');
		this.endpointInput.focus();
	}

	private updateProviderFormHeader(): void {
		if (!this.providerFormHeading) {
			return;
		}
		this.providerFormHeading.textContent = this.editingGroupName
			? localize('models.editApiConnection', "Edit API Provider: {0}", this.editingGroupName)
			: localize('models.addApiConnection', "Add API Provider");
		if (this.addProviderButton) {
			this.addProviderButton.label = this.editingGroupName
				? `$(${Codicon.save.id}) ${localize('models.saveChanges', "Save Changes")}`
				: `$(${Codicon.add.id}) ${localize('models.addApiProvider', "Add API")}`;
		}
	}

	private ensureUniqueProviderName(baseName: string): string {
		const existingNames = new Set<string>();
		for (const group of this.languageModelsService.getLanguageModelGroups(this.options.vendor)) {
			if (group.group?.name) {
				existingNames.add(group.group.name);
			}
		}
		let name = baseName;
		let index = 2;
		while (existingNames.has(name)) {
			name = `${baseName}-${index++}`;
		}
		return name;
	}

	private async addShunCodeProvider(): Promise<void> {
		const endpoint = this.endpointInput.value.trim();
		const apiKey = this.apiKeyInput.value.trim();
		if (!endpoint) {
			this.endpointInput.focus();
			this.setProviderStatus(localize('models.enterApiEndpoint', "Enter an API endpoint URL."), 'error');
			return;
		}

		try {
			const parsed = new URL(endpoint);
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				throw new Error(localize('models.invalidApiEndpointProtocol', "The API endpoint must use http or https."));
			}
		} catch (error) {
			this.endpointInput.focus();
			this.setProviderStatus(error instanceof Error ? error.message : localize('models.invalidApiEndpoint', "Enter a valid API endpoint URL."), 'error');
			return;
		}

		let name = this.editingGroupName;
		if (!name) {
			const baseName = deriveProviderNameFromUrl(endpoint);
			if (!baseName) {
				this.endpointInput.focus();
				this.setProviderStatus(localize('models.unableToDeriveProviderName', "Could not derive a provider name from the endpoint URL."), 'error');
				return;
			}
			name = this.ensureUniqueProviderName(baseName);
		}

		this.addProviderButton.enabled = false;
		this.testProviderButton.enabled = false;
		try {
			// The first connection test happens right here: only add or update the
			// provider when the endpoint actually answers with a model list.
			if (!await this.testProviderConnection()) {
				return;
			}
			this.setProviderStatus(this.editingGroupName
				? localize('models.savingProvider', "Saving {0} and loading models…", this.editingGroupName)
				: localize('models.addingProvider', "Adding {0} and loading models…", name));
			const values: Record<string, unknown> = { baseUrl: endpoint };
			if (apiKey) {
				values.apiKey = apiKey;
			}
			if (this.editingGroupName) {
				const setConfiguration = this.languageModelsService.setLanguageModelsProviderConfiguration;
				if (!setConfiguration) {
					this.setProviderStatus(localize('models.inlineConfigurationUnavailable', "Use Configure API to edit this provider."), 'error');
					return;
				}
				await setConfiguration.call(this.languageModelsService, this.options.vendor, values, this.editingGroupName);
			} else {
				await this.languageModelsService.addLanguageModelsProviderGroup(name, this.options.vendor, values);
			}
			const models = await this.languageModelsService.selectLanguageModels({ vendor: this.options.vendor });
			await this.viewModel.refresh();
			this.apiKeyConfigured = this.apiKeyConfigured || !!apiKey;
			this.apiKeyInput.value = '';
			this.endpointInput.value = '';
			this.editingGroupName = undefined;
			this.updateProviderFormHeader();
			this.setProviderStatus(localize('models.providerAddedWithCount', "Added {0}. {1} models loaded.", name, models.length), 'success');
		} catch (error) {
			const message = getErrorMessage(error);
			this.setProviderStatus(message, 'error');
			this.notificationService.error(message);
		} finally {
			this.addProviderButton.enabled = true;
			this.testProviderButton.enabled = true;
		}
	}

	private async editProviderInForm(groupName: string): Promise<void> {
		const getConfiguration = this.languageModelsService.getLanguageModelsProviderConfiguration;
		if (!getConfiguration) {
			this.setProviderStatus(localize('models.inlineConfigurationUnavailable', "Use Configure API to edit this provider."));
			return;
		}

		try {
			const configuration = await getConfiguration.call(this.languageModelsService, this.options.vendor, groupName);
			if (!configuration) {
				this.setProviderStatus(localize('models.providerConfigurationMissing', "No configuration found for {0}.", groupName), 'error');
				return;
			}
			this.editingGroupName = groupName;
			this.endpointInput.value = typeof configuration.values.baseUrl === 'string' ? configuration.values.baseUrl : '';
			this.apiKeyConfigured = configuration.configuredSecretKeys.includes('apiKey');
			this.apiKeyInput.value = '';
			this.apiKeyInput.setPlaceHolder(this.apiKeyConfigured
				? localize('models.savedApiKeyPlaceholder', "Saved securely — leave blank to keep it")
				: localize('models.apiKeyPlaceholder', "Paste your API key"));
			this.updateProviderFormHeader();
			this.setProviderStatus(localize('models.editingProvider', "Editing {0}. Change the URL or API key, then click Save Changes.", groupName), 'normal');
		} catch (error) {
			this.setProviderStatus(getErrorMessage(error), 'error');
		}
	}

	public layout(height: number, width: number): void {
		const style = DOM.getWindow(this.element).getComputedStyle(this.element);
		const horizontalPadding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
		width = Math.max(0, width - horizontalPadding);
		const searchWidth = Math.max(0, width - this.searchActionsContainer.clientWidth - this.addButtonContainer.clientWidth - 8);
		this.searchWidget.layout(new DOM.Dimension(searchWidth, 22));
		const fixedHeight = DOM.getTotalHeight(this.providerConfigurationContainer) + DOM.getTotalHeight(this.searchAndButtonContainer);
		const tableHeight = Math.max(0, height - fixedHeight);
		this.tableContainer.style.height = `${tableHeight}px`;
		const tableWidth = Math.max(width, this.tableMinWidth);
		this.table.layout(tableHeight, tableWidth);
		this.tableScrollable?.scanDomNode();
	}

	public focusSearch(): void {
		this.searchWidget.focus();
	}

	public search(filter: string): void {
		this.focusSearch();
		this.searchWidget.setValue(filter);
		this.viewModel.filter(filter);
	}

	public clearSearch(): void {
		this.focusSearch();
		this.searchWidget.setValue('');
	}

	public render(): void {
		if (this.options.presentation === 'codex') {
			void this.loadCodexAccountStatus();
		}
		if (this.viewModel.shouldRefilter()) {
			this.viewModel.filter(this.searchWidget.getValue());
		}
	}

	/**
	 * Gets the total model count (excluding vendor/group/status headers).
	 */
	get itemCount(): number {
		return this.getDisplayedModelEntries().filter((entry): entry is ILanguageModelEntry => entry.type === 'model').length;
	}

	/**
	 * Re-fires the current item count. Call after subscribing to onDidChangeItemCount
	 * to ensure the subscriber receives the latest count.
	 */
	fireItemCount(): void {
		this._onDidChangeItemCount.fire(this.itemCount);
	}

}
