/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getNLSLanguage } from '../../../../../nls.js';

const simplifiedChineseMessages: Readonly<Record<string, string>> = Object.freeze({
	'shuncodeMultiModel.title': '多模型博弈',
	'shuncodeMultiModel.description': '在 Plan 模式下，用不同模型从上一轮之前的上下文各自作答同一问题，再由合并主模型读取全部分支、必要时只读文件验证，产出共识、分歧与最终方案。只有被采纳的分支进入后续上下文。',
	'shuncodeMultiModel.rule1': 'Plan 模式提问并得到回答后，清空输入框，发送按钮变为分支发送按钮（主题色）。',
	'shuncodeMultiModel.rule2': '切换模型再次空发即为新分支；串行生成，前一个完成前发送按钮禁用。',
	'shuncodeMultiModel.rule3': '分支达到 2 个后，回答动作行出现 ◀ ▶ 与「合并总结」。',
	'shuncodeMultiModel.rule4': '合并结果成为新分支并默认作为主线；未合并时可手动「采纳」某一分支。',
	'shuncodeMultiModel.settingsTitle': '设置',
	'shuncodeMultiModel.enabledLabel': '启用多模型博弈',
	'shuncodeMultiModel.enabledHint': '关闭后空输入不再触发分支发送。',
	'shuncodeMultiModel.enabledOn': '多模型博弈已启用，空输入将触发分支发送。',
	'shuncodeMultiModel.enabledOff': '多模型博弈已关闭，空输入不再触发分支发送。',
	'shuncodeMultiModel.mergeModelLabel': '合并主模型',
	'shuncodeMultiModel.pick': '选择…',
	'shuncodeMultiModel.pickTitle': '从已配置的模型中选择合并主模型',
	'shuncodeMultiModel.useCurrent': '使用当前对话模型',
	'shuncodeMultiModel.useCurrentTitle': '清空合并主模型设置，合并时使用对话当前选中的模型',
	'shuncodeMultiModel.mergeModelHelp': '留空表示合并时使用当前对话选中的模型；格式 vendor/modelId。',
	'shuncodeMultiModel.readToolsLabel': '合并时允许只读文件验证',
	'shuncodeMultiModel.readToolsHint': '仅在分支意见不统一或结论缺乏依据时读取文件。',
	'shuncodeMultiModel.maxBranchesLabel': '每回合最大分支数',
	'shuncodeMultiModel.maxBranchesOption': '{0} 个分支',
	'shuncodeMultiModel.maxBranchesHelp': '达到上限后需先合并或采纳，才能继续为同一问题生成分支。',
	'shuncodeMultiModel.mergeModelEmpty': '当前对话选中的模型',
	'shuncodeMultiModel.mergeReasoningLabel': '合并思考强度',
	'shuncodeMultiModel.mergeReasoningHelp': '合并主模型总结分支时使用的思考强度。仅当上方配置了独立合并主模型时生效，否则合并跟随当前对话的思考设置。若合并模型不支持所选档位（DeepSeek 仅支持 low/high/max；Codex 模型不支持“关闭思考”），将改用该合并模型的默认档位。',
	'shuncodeMultiModel.mergeReasoningOptionDisabled': '关闭思考',
	'shuncodeMultiModel.mergeReasoningOptionNone': '无',
	'shuncodeMultiModel.mergeReasoningOptionMinimal': '极少',
	'shuncodeMultiModel.mergeReasoningOptionLow': '低',
	'shuncodeMultiModel.mergeReasoningOptionMedium': '中',
	'shuncodeMultiModel.mergeReasoningOptionHigh': '高',
	'shuncodeMultiModel.mergeReasoningOptionXHigh': '极高',
	'shuncodeMultiModel.mergeReasoningOptionMax': '最大',
	'shuncodeMultiModel.mergeReasoningOptionUltra': '极致',
	'shuncodeMultiModel.navigationLabel': '多模型博弈',
	'shuncodeMultiModel.navigationDescription': '合并主模型、只读验证与分支上限等多模型回合设置。',
});

function isSimplifiedChinese(): boolean {
	const language = getNLSLanguage()?.toLowerCase();
	return language === 'zh-cn' || language === 'zh-hans' || language?.startsWith('zh-hans-') === true;
}

export function localizeMultiModel(key: string, message: string, ...args: (string | number | boolean | undefined | null)[]): string {
	const translated = isSimplifiedChinese() ? simplifiedChineseMessages[key] ?? message : message;
	return translated.replace(/\{(\d+)\}/g, (match, index: string) => {
		const value = args[Number(index)];
		return value === undefined || value === null ? String(value) : String(value);
	});
}
