/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/shunCodeMultiModelWidget.css';
import * as dom from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Checkbox } from '../../../../../base/browser/ui/toggle/toggle.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { defaultButtonStyles, defaultCheckboxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { AICustomizationManagementSection } from '../../common/aiCustomizationWorkspaceService.js';
import { aiCustomizationManagementSectionRegistry, IAICustomizationManagementSectionWidget } from './aiCustomizationManagementSectionRegistry.js';
import { localizeMultiModel } from './shunCodeMultiModelLocalization.js';

const SETTING_ENABLED = 'shuncode.multiModel.enabled';
const SETTING_MERGE_MODEL = 'shuncode.multiModel.mergeModel';
const SETTING_MERGE_READ_TOOLS = 'shuncode.multiModel.mergeReadTools';
const SETTING_MAX_BRANCHES = 'shuncode.multiModel.maxBranches';
const SETTING_MERGE_REASONING = 'shuncode.multiModel.mergeReasoningEffort';
const PICK_MERGE_MODEL_COMMAND = 'shuncode.pickMergeModel';
const MERGE_REASONING_OPTIONS = ['disabled', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

function mergeReasoningOptionLabel(option: string): string {
	switch (option) {
		case 'disabled': return localizeMultiModel('shuncodeMultiModel.mergeReasoningOptionDisabled', 'Off');
		case 'none': return localizeMultiModel('shuncodeMultiModel.mergeReasoningOptionNone', 'None');
		case 'minimal': return localizeMultiModel('shuncodeMultiModel.mergeReasoningOptionMinimal', 'Minimal');
		case 'low': return localizeMultiModel('shuncodeMultiModel.mergeReasoningOptionLow', 'Low');
		case 'medium': return localizeMultiModel('shuncodeMultiModel.mergeReasoningOptionMedium', 'Medium');
		case 'high': return localizeMultiModel('shuncodeMultiModel.mergeReasoningOptionHigh', 'High');
		case 'xhigh': return localizeMultiModel('shuncodeMultiModel.mergeReasoningOptionXHigh', 'XHigh');
		case 'max': return localizeMultiModel('shuncodeMultiModel.mergeReasoningOptionMax', 'Max');
		case 'ultra': return localizeMultiModel('shuncodeMultiModel.mergeReasoningOptionUltra', 'Ultra');
		default: return option;
	}
}

/**
 * ShunCode multi-model rounds settings rendered as a section of the Agent
 * Customizations management editor. Values live in the `shuncode.multiModel.*`
 * configuration keys read by the native chat runtime and the branch UI.
 */
class ShunCodeMultiModelWidget extends Disposable implements IAICustomizationManagementSectionWidget {

	private readonly mergeModelValue: HTMLElement;
	private readonly enabledToggle: HTMLButtonElement;
	private readonly mergeReadToolsCheckbox: Checkbox;
	private readonly maxBranchesSelect: HTMLSelectElement;
	private readonly mergeReasoningSelect: HTMLSelectElement;

	constructor(
		container: HTMLElement,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
		const root = dom.append(container, dom.$('.shuncode-multimodel'));

		// --- Hero card --------------------------------------------------------
		const heroCard = dom.append(root, dom.$('.shuncode-multimodel-card.shuncode-multimodel-hero'));
		const heroHeader = dom.append(heroCard, dom.$('.shuncode-multimodel-card-header'));
		dom.append(heroHeader, dom.$('h2', undefined, localizeMultiModel('shuncodeMultiModel.title', 'Multi-Model Rounds')));
		const heroBody = dom.append(heroCard, dom.$('.shuncode-multimodel-body'));
		dom.append(heroBody, dom.$('p.shuncode-multimodel-description', undefined,
			localizeMultiModel('shuncodeMultiModel.description', 'In Plan mode, different models each answer the same question from the context before the previous round. The merge model then reads all branches and, when necessary, performs read-only file verification, producing consensus, disagreements, and the final plan. Only adopted branches continue into subsequent context.')));

		const rules = dom.append(heroBody, dom.$('ul.shuncode-multimodel-rules'));
		for (const rule of [
			localizeMultiModel('shuncodeMultiModel.rule1', 'After asking a question in Plan mode and receiving an answer, clear the input box; the send button becomes the branch send button (accent color).'),
			localizeMultiModel('shuncodeMultiModel.rule2', 'Switch models and send an empty input again to create a new branch; branches are generated serially, and the send button is disabled until the previous branch finishes.'),
			localizeMultiModel('shuncodeMultiModel.rule3', 'Once there are 2 branches, the answer action row shows ◀ ▶ and “Merge & Summarize”.'),
			localizeMultiModel('shuncodeMultiModel.rule4', 'The merged result becomes a new branch and the main line by default; before merging you can manually adopt a branch.'),
		]) {
			dom.append(rules, dom.$('li', undefined, rule));
		}

		// --- Settings card ----------------------------------------------------
		const settingsCard = dom.append(root, dom.$('.shuncode-multimodel-card'));
		const settingsHeader = dom.append(settingsCard, dom.$('.shuncode-multimodel-card-header'));
		dom.append(settingsHeader, dom.$('h3', undefined, localizeMultiModel('shuncodeMultiModel.settingsTitle', 'Settings')));
		const settingsBody = dom.append(settingsCard, dom.$('.shuncode-multimodel-body'));

		// Enabled toggle
		const enabledRow = dom.append(settingsBody, dom.$('.shuncode-multimodel-persistent-row'));
		const enabledText = dom.append(enabledRow, dom.$('.shuncode-multimodel-persistent-text'));
		const enabledLabel = dom.append(enabledText, dom.$('label.shuncode-multimodel-persistent-label'));
		enabledLabel.textContent = localizeMultiModel('shuncodeMultiModel.enabledLabel', 'Enable Multi-Model Rounds');
		dom.append(enabledText, dom.$('.shuncode-multimodel-hint', undefined,
			localizeMultiModel('shuncodeMultiModel.enabledHint', 'When disabled, an empty input no longer triggers branch sending.')));
		this.enabledToggle = dom.append(enabledRow, dom.$<HTMLButtonElement>('button.shuncode-multimodel-switch'));
		this.enabledToggle.type = 'button';
		this.enabledToggle.setAttribute('role', 'switch');
		this.enabledToggle.setAttribute('aria-label', localizeMultiModel('shuncodeMultiModel.enabledLabel', 'Enable Multi-Model Rounds'));
		dom.append(this.enabledToggle, dom.$('span.shuncode-multimodel-switch-track'));
		this.renderEnabledToggle(this.readEnabled());
		this._register(dom.addDisposableListener(this.enabledToggle, 'click', () => {
			const enabled = this.enabledToggle.getAttribute('aria-checked') !== 'true';
			this.renderEnabledToggle(enabled);
			void this.configurationService.updateValue(SETTING_ENABLED, enabled, ConfigurationTarget.USER).catch(() => {
				this.renderEnabledToggle(this.readEnabled());
			});
		}));

		// Merge model field
		const mergeModelField = dom.append(settingsBody, dom.$('.shuncode-multimodel-field'));
		dom.append(mergeModelField, dom.$('span.shuncode-multimodel-field-label', undefined,
			localizeMultiModel('shuncodeMultiModel.mergeModelLabel', 'Merge model')));
		const mergeModelRow = dom.append(mergeModelField, dom.$('.shuncode-multimodel-merge-row'));
		this.mergeModelValue = dom.append(mergeModelRow, dom.$('code.shuncode-multimodel-value'));
		const mergeModelActions = dom.append(mergeModelRow, dom.$('.shuncode-multimodel-actions'));
		const pickButton = this._register(new Button(mergeModelActions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		pickButton.label = `$(${Codicon.gitMerge.id}) ${localizeMultiModel('shuncodeMultiModel.pick', 'Select…')}`;
		pickButton.setTitle(localizeMultiModel('shuncodeMultiModel.pickTitle', 'Choose the merge model from the configured models'));
		this._register(pickButton.onDidClick(() => void this.commandService.executeCommand(PICK_MERGE_MODEL_COMMAND)));
		const clearButton = this._register(new Button(mergeModelActions, { ...defaultButtonStyles, secondary: true }));
		clearButton.label = localizeMultiModel('shuncodeMultiModel.useCurrent', 'Use current conversation model');
		clearButton.setTitle(localizeMultiModel('shuncodeMultiModel.useCurrentTitle', 'Clear the merge model setting; the model selected in the current conversation will be used when merging'));
		this._register(clearButton.onDidClick(() => void this.configurationService.updateValue(SETTING_MERGE_MODEL, '', ConfigurationTarget.USER)));
		dom.append(mergeModelField, dom.$('p.shuncode-multimodel-help', undefined,
			localizeMultiModel('shuncodeMultiModel.mergeModelHelp', 'Leave empty to use the model selected in the current conversation when merging. Format: vendor/modelId.')));

		// Merge reasoning effort field
		const mergeReasoningField = dom.append(settingsBody, dom.$('.shuncode-multimodel-field'));
		dom.append(mergeReasoningField, dom.$('span.shuncode-multimodel-field-label', undefined,
			localizeMultiModel('shuncodeMultiModel.mergeReasoningLabel', 'Merge thinking effort')));
		this.mergeReasoningSelect = dom.append(mergeReasoningField, dom.$<HTMLSelectElement>('select.shuncode-multimodel-select'));
		this.mergeReasoningSelect.setAttribute('aria-label', localizeMultiModel('shuncodeMultiModel.mergeReasoningLabel', 'Merge thinking effort'));
		for (const option of MERGE_REASONING_OPTIONS) {
			const element = dom.append(this.mergeReasoningSelect, dom.$<HTMLOptionElement>('option'));
			element.value = option;
			element.textContent = mergeReasoningOptionLabel(option);
		}
		this._register(dom.addDisposableListener(this.mergeReasoningSelect, 'change', () => {
			void this.configurationService.updateValue(SETTING_MERGE_REASONING, this.mergeReasoningSelect.value, ConfigurationTarget.USER);
		}));
		dom.append(mergeReasoningField, dom.$('p.shuncode-multimodel-help', undefined,
			localizeMultiModel('shuncodeMultiModel.mergeReasoningHelp', 'Thinking effort used when the merge model summarizes branches. Only applies when a separate merge model is configured above; otherwise merging follows the thinking setting of the current conversation. If the merge model does not support the selected effort (DeepSeek supports low/high/max only; Codex models cannot disable thinking), the merge model default is used.')));

		// Merge read tools toggle
		const readToolsRow = dom.append(settingsBody, dom.$('.shuncode-multimodel-row'));
		this.mergeReadToolsCheckbox = this._register(new Checkbox(
			localizeMultiModel('shuncodeMultiModel.readToolsLabel', 'Allow read-only file verification when merging'),
			this.readMergeReadTools(),
			defaultCheckboxStyles,
		));
		readToolsRow.appendChild(this.mergeReadToolsCheckbox.domNode);
		dom.append(readToolsRow, dom.$('span.shuncode-multimodel-check-label', undefined,
			localizeMultiModel('shuncodeMultiModel.readToolsLabel', 'Allow read-only file verification when merging')));
		dom.append(readToolsRow, dom.$('span.shuncode-multimodel-hint', undefined,
			localizeMultiModel('shuncodeMultiModel.readToolsHint', 'Files are read only when branches disagree or the conclusion lacks evidence.')));
		this._register(this.mergeReadToolsCheckbox.onChange(() => {
			void this.configurationService.updateValue(SETTING_MERGE_READ_TOOLS, this.mergeReadToolsCheckbox.checked, ConfigurationTarget.USER);
		}));

		// Max branches field
		const maxBranchesField = dom.append(settingsBody, dom.$('.shuncode-multimodel-field'));
		dom.append(maxBranchesField, dom.$('span.shuncode-multimodel-field-label', undefined,
			localizeMultiModel('shuncodeMultiModel.maxBranchesLabel', 'Max branches per round')));
		this.maxBranchesSelect = dom.append(maxBranchesField, dom.$<HTMLSelectElement>('select.shuncode-multimodel-select'));
		this.maxBranchesSelect.setAttribute('aria-label', localizeMultiModel('shuncodeMultiModel.maxBranchesLabel', 'Max branches per round'));
		for (let value = 2; value <= 6; value++) {
			const option = dom.append(this.maxBranchesSelect, dom.$<HTMLOptionElement>('option'));
			option.value = String(value);
			option.textContent = localizeMultiModel('shuncodeMultiModel.maxBranchesOption', '{0} branches', value);
		}
		this._register(dom.addDisposableListener(this.maxBranchesSelect, 'change', () => {
			void this.configurationService.updateValue(SETTING_MAX_BRANCHES, Number(this.maxBranchesSelect.value), ConfigurationTarget.USER);
		}));
		dom.append(maxBranchesField, dom.$('p.shuncode-multimodel-help', undefined,
			localizeMultiModel('shuncodeMultiModel.maxBranchesHelp', 'When the limit is reached, merge or adopt a branch before generating more branches for the same question.')));

		// React to configuration changes from anywhere (including the
		// ShunCode: Pick Multi-Model Merge Model command).
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('shuncode.multiModel')) {
				this.refreshValues();
			}
		}));

		this.refreshValues();
	}

	private readEnabled(): boolean {
		return this.configurationService.getValue<boolean>(SETTING_ENABLED) ?? true;
	}

	private readMergeReadTools(): boolean {
		return this.configurationService.getValue<boolean>(SETTING_MERGE_READ_TOOLS) ?? true;
	}

	private renderEnabledToggle(enabled: boolean): void {
		this.enabledToggle.setAttribute('aria-checked', String(enabled));
		this.enabledToggle.title = enabled
			? localizeMultiModel('shuncodeMultiModel.enabledOn', 'Multi-model rounds are enabled. An empty input triggers branch sending.')
			: localizeMultiModel('shuncodeMultiModel.enabledOff', 'Multi-model rounds are disabled. An empty input no longer triggers branch sending.');
	}

	private refreshValues(): void {
		this.renderEnabledToggle(this.readEnabled());
		this.mergeReadToolsCheckbox.checked = this.readMergeReadTools();

		const mergeModel = (this.configurationService.getValue<string>(SETTING_MERGE_MODEL) ?? '').trim();
		this.mergeModelValue.textContent = mergeModel
			|| localizeMultiModel('shuncodeMultiModel.mergeModelEmpty', 'Model selected in current conversation');

		const maxBranches = this.configurationService.getValue<number>(SETTING_MAX_BRANCHES) ?? 3;
		const clamped = Number.isInteger(maxBranches) && maxBranches >= 2 && maxBranches <= 6 ? maxBranches : 3;
		this.maxBranchesSelect.value = String(clamped);

		const mergeReasoning = this.configurationService.getValue<string>(SETTING_MERGE_REASONING) ?? 'high';
		this.mergeReasoningSelect.value = (MERGE_REASONING_OPTIONS as readonly string[]).includes(mergeReasoning)
			? mergeReasoning
			: 'high';
	}

	override dispose(): void {
		super.dispose();
	}
}

aiCustomizationManagementSectionRegistry.register({
	id: AICustomizationManagementSection.MultiModel,
	label: localizeMultiModel('shuncodeMultiModel.navigationLabel', 'Multi-Model Rounds'),
	icon: Codicon.gitMerge,
	description: localizeMultiModel('shuncodeMultiModel.navigationDescription', 'Merge model, read-only verification, and branch limits for multi-model rounds.'),
	supportsHarness: () => true,
	create: (instantiationService, container) => instantiationService.createInstance(ShunCodeMultiModelWidget, container),
});
