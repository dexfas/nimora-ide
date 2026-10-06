/* Copyright (c) Microsoft Corporation. Licensed under the MIT License. */
/** Historical completions wire DTOs, retained for the legacy translation helper.
 * Native BYOK production uses the Responses contract in agentHostByokLm.ts. */

export interface IByokLmToolCall {
	/** Stable id correlating the call with its later `tool` result message. */
	readonly id: string;
	/** Tool/function name. */
	readonly name: string;
	/** JSON-encoded tool input, which may be an object or a freeform string. */
	readonly argumentsJson: string;
}

export interface IByokLmTool {
	readonly name: string;
	readonly description?: string;
	/** JSON schema for the tool parameters. */
	readonly parametersSchema?: object;
}

export interface IByokLmChatMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	/** Flattened text content. Empty string when the message carries only tool calls/results. */
	readonly content: string;
	/** Present on `assistant` messages that requested tool calls. */
	readonly toolCalls?: IByokLmToolCall[];
	/** Present on `tool` messages: the {@link IByokLmToolCall.id} this result answers. */
	readonly toolCallId?: string;
}

export interface IByokLmChatRequest {
	/** Provider/vendor name (the LM API vendor that registered the model). */
	readonly vendor: string;
	/** Provider-local model id (the wire id the runtime sent on the OpenAI request). */
	readonly modelId: string;
	readonly messages: IByokLmChatMessage[];
	readonly tools?: IByokLmTool[];
	/** Opaque per-request model options forwarded to the LM provider. */
	readonly modelOptions?: Record<string, unknown>;
}

export interface IByokLmChatResult {
	/** Concatenated assistant text. */
	readonly content: string;
	/** Tool calls the assistant requested, if any. */
	readonly toolCalls?: IByokLmToolCall[];
	/** Best-effort token usage, when the provider reports it. */
	readonly usage?: {
		readonly promptTokens?: number;
		readonly completionTokens?: number;
	};
	/** Set when the LM call failed; `content` is then empty. */
	readonly error?: string;
}
