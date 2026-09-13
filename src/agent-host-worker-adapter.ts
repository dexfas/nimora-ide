/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IDisposable } from './vs/base/common/lifecycle.js';
import { URI } from './vs/base/common/uri.js';
import type {
	WorkerAdapter,
	WorkerDescriptor,
	WorkerEvent,
	WorkerHealth,
	WorkerInput,
	WorkerSessionHandle,
	WorkerSessionOptions,
} from './worker-contract.js';
import type { IAgentConnection, IAgentCreateSessionConfig } from './vs/platform/agentHost/common/agentService.js';
import type { IAgentSubscription } from './vs/platform/agentHost/common/state/agentSubscription.js';
import {
	ActionType,
	type ActionEnvelope,
	type ChatAction,
	type ChatToolCallCompleteAction,
	type ChatToolCallReadyAction,
	type ChatTurnStartedAction,
} from './vs/platform/agentHost/common/state/sessionActions.js';
import {
	buildDefaultChatUri,
	MessageKind,
	ResponsePartKind,
	StateComponents,
	ToolResultContentType,
	type ChatState,
	type SessionState,
} from './vs/platform/agentHost/common/state/sessionState.js';

export interface AgentHostWorkerSessionOptions extends WorkerSessionOptions {
	provider: string;
	model?: string;
	/** Existing AHP session to attach to instead of creating a new one. */
	backendSession?: URI;
	/** Passed through to IAgentConnection.createSession when creating a new session. */
	createSession?: Omit<IAgentCreateSessionConfig, 'provider' | 'model' | 'session' | 'workingDirectories'>;
}

interface AgentHostSessionRecord {
	handle: WorkerSessionHandle;
	backendSession: URI;
	ownsBackendSession: boolean;
	chatUri: URI;
	subscription: IAgentSubscription<ChatState>;
	subscriptionRef: IDisposable;
	active?: {
		inputId: string;
		turnId: string;
		queue: WorkerEventQueue;
		listener: IDisposable;
		seenTerminal: boolean;
		toolNames: Map<string, string>;
		startedAtMs: number;
	};
}

class WorkerEventQueue implements AsyncIterable<WorkerEvent> {
	private readonly values: WorkerEvent[] = [];
	private readonly waiters: Array<(result: IteratorResult<WorkerEvent>) => void> = [];
	private finished = false;

	push(value: WorkerEvent): void {
		if (this.finished) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter({ value, done: false });
		else this.values.push(value);
	}

	close(): void {
		if (this.finished) return;
		this.finished = true;
		for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
	}

	[Symbol.asyncIterator](): AsyncIterator<WorkerEvent> {
		return {
			next: async () => {
				const value = this.values.shift();
				if (value) return { value, done: false };
				if (this.finished) return { value: undefined, done: true };
				return await new Promise<IteratorResult<WorkerEvent>>(resolve => this.waiters.push(resolve));
			},
		};
	}
}

function stringOrMarkdown(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (value && typeof value === 'object' && typeof (value as { markdown?: unknown }).markdown === 'string') {
		return (value as { markdown: string }).markdown;
	}
	return undefined;
}

function parseToolInput(raw: string | undefined): unknown {
	if (!raw) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

function toolResultText(action: ChatToolCallCompleteAction): string | undefined {
	const blocks = action.result.content?.flatMap(item => {
		if (item.type === ToolResultContentType.Text) return [item.text];
		return [];
	}) ?? [];
	if (blocks.length) return blocks.join('\n');
	if (!action.result.success) return action.result.error?.message;
	return stringOrMarkdown(action.result.pastTenseMessage);
}

/**
 * Semantic adapter over the existing AHP state protocol. It intentionally does
 * not duplicate AgentHost session/state ownership: send/interrupt are AHP chat
 * actions and output is projected from the existing chat subscription.
 */
export class AgentHostWorkerAdapter implements WorkerAdapter<AgentHostWorkerSessionOptions> {
	private readonly sessions = new Map<string, AgentHostSessionRecord>();

	constructor(
		private readonly connection: IAgentConnection,
		private readonly workerId = 'nimora.agent-host',
	) { }

	async describe(): Promise<WorkerDescriptor> {
		const rootValue = this.connection.rootState.value;
		const root = rootValue instanceof Error ? undefined : rootValue;
		return {
			id: this.workerId,
			provider: 'agent-host',
			kind: 'agent-host',
			label: 'Nimora Agent Host',
			availability: root ? 'available' : 'degraded',
			models: root?.agents.flatMap(agent => agent.models.map(model => model.id)),
			capabilities: {
				streaming: true,
				reasoning: true,
				capabilityRequests: true,
				imageInput: false,
				checkpoints: false,
				interruption: true,
				persistentContext: true,
				extensions: {
					capabilityPolicyInput: false,
					providers: root?.agents.map(agent => ({
						id: agent.provider,
						label: agent.displayName,
						models: agent.models.map(model => model.id),
					})) ?? [],
				},
			},
		};
	}

	async createSession(options: AgentHostWorkerSessionOptions): Promise<WorkerSessionHandle> {
		const workingDirectories = options.workspaceRoot ? [URI.file(options.workspaceRoot)] : undefined;
		const ownsBackendSession = !options.backendSession;
		const backendSession = options.backendSession ?? await this.connection.createSession({
			...options.createSession,
			provider: options.provider,
			model: options.model ? { id: options.model } : undefined,
			workingDirectories,
		});
		const sessionState = await this.waitForSessionState(backendSession);
		const chatUri = URI.parse(sessionState.defaultChat?.toString() ?? buildDefaultChatUri(backendSession));
		const subscriptionRef = this.connection.getSubscription(StateComponents.Chat, chatUri, 'AgentHostWorkerAdapter');
		const subscription = subscriptionRef.object;
		await this.waitForChatState(subscription);

		const now = new Date().toISOString();
		const handle: WorkerSessionHandle = {
			sessionId: backendSession.toString(),
			workerId: this.workerId,
			state: 'idle',
			model: options.model,
			contextHandle: options.contextHandle,
			createdAt: now,
			lastActiveAt: now,
			extensions: {
				provider: options.provider,
				backendSession: backendSession.toString(),
				chatUri: chatUri.toString(),
			},
		};
		this.sessions.set(handle.sessionId, { handle, backendSession, ownsBackendSession, chatUri, subscription, subscriptionRef });
		return handle;
	}

	send(session: WorkerSessionHandle, input: WorkerInput): AsyncIterable<WorkerEvent> {
		const record = this.requireSession(session);
		if (record.active) throw new Error(`Worker session ${session.sessionId} already has an active input.`);

		const turnId = input.inputId;
		const queue = new WorkerEventQueue();
		const listener = record.subscription.onDidApplyAction(envelope => this.handleEnvelope(record, input.inputId, turnId, envelope));
		record.active = { inputId: input.inputId, turnId, queue, listener, seenTerminal: false, toolNames: new Map(), startedAtMs: Date.now() };
		this.touch(record, 'running');

		const action: ChatTurnStartedAction = {
			type: ActionType.ChatTurnStarted,
			turnId,
			startedAt: new Date().toISOString(),
			message: {
				text: input.prompt,
				origin: { kind: MessageKind.User },
				...(session.model ? { model: { id: session.model } } : {}),
			},
		};
		this.connection.dispatch(record.chatUri.toString(), action);
		return queue;
	}

	async interrupt(session: WorkerSessionHandle): Promise<void> {
		const record = this.requireSession(session);
		const active = record.active;
		if (!active) return;
		this.connection.dispatch(record.chatUri.toString(), {
			type: ActionType.ChatTurnCancelled,
			turnId: active.turnId,
			duration: Math.max(0, Date.now() - active.startedAtMs),
		});
		this.touch(record, 'interrupted');
	}

	async dispose(session: WorkerSessionHandle): Promise<void> {
		const record = this.requireSession(session);
		record.active?.listener.dispose();
		record.active?.queue.close();
		record.subscriptionRef.dispose();
		try {
			if (record.ownsBackendSession) await this.connection.disposeSession(record.backendSession);
		} finally {
			this.touch(record, 'disposed');
			this.sessions.delete(session.sessionId);
		}
	}

	async health(session?: WorkerSessionHandle): Promise<WorkerHealth> {
		if (session) {
			const record = this.requireSession(session);
			if (record.subscription.value instanceof Error) {
				return { status: 'offline', checkedAt: new Date().toISOString(), message: record.subscription.value.message };
			}
		}
		return {
			status: this.connection.rootState ? 'healthy' : 'degraded',
			checkedAt: new Date().toISOString(),
		};
	}

	private handleEnvelope(record: AgentHostSessionRecord, inputId: string, turnId: string, envelope: ActionEnvelope): void {
		const active = record.active;
		if (!active || active.inputId !== inputId || active.turnId !== turnId || active.seenTerminal || envelope.rejectionReason) return;
		const action = envelope.action as ChatAction;
		if ('turnId' in action && action.turnId !== turnId) return;

		switch (action.type) {
			case ActionType.ChatDelta:
				active.queue.push({ type: 'text_delta', inputId, text: action.content });
				break;
			case ActionType.ChatReasoning:
				active.queue.push({ type: 'reasoning_delta', inputId, text: action.content });
				break;
			case ActionType.ChatResponsePart:
				if (action.part.kind === ResponsePartKind.Markdown && action.part.content) {
					active.queue.push({ type: 'text_delta', inputId, text: action.part.content });
				} else if (action.part.kind === ResponsePartKind.Reasoning && action.part.content) {
					active.queue.push({ type: 'reasoning_delta', inputId, text: action.part.content });
				} else {
					active.queue.push({ type: 'provider_event', inputId, name: action.type, data: action.part });
				}
				break;
			case ActionType.ChatToolCallStart:
				active.toolNames.set(action.toolCallId, action.toolName);
				active.queue.push({ type: 'provider_event', inputId, name: action.type, data: action });
				break;
			case ActionType.ChatToolCallReady:
				this.emitToolCallReady(active.queue, active.toolNames, inputId, action);
				break;
			case ActionType.ChatToolCallComplete:
				this.emitToolCallComplete(active.queue, active.toolNames, inputId, action);
				break;
			case ActionType.ChatUsage:
				active.queue.push({ type: 'usage', inputId, usage: { ...action.usage } });
				break;
			case ActionType.ChatTurnComplete:
				this.finish(record, {
					type: 'terminal', inputId, status: 'completed', result: action,
				});
				break;
			case ActionType.ChatTurnCancelled:
				this.finish(record, { type: 'terminal', inputId, status: 'cancelled', result: action });
				break;
			case ActionType.ChatError:
				this.finish(record, { type: 'terminal', inputId, status: 'error', error: action.error.message });
				break;
			default:
				active.queue.push({ type: 'provider_event', inputId, name: action.type, data: action });
		}
	}

	private emitToolCallReady(queue: WorkerEventQueue, toolNames: ReadonlyMap<string, string>, inputId: string, action: ChatToolCallReadyAction): void {
		queue.push({
			type: 'capability_call',
			inputId,
			callId: action.toolCallId,
			name: toolNames.get(action.toolCallId) ?? 'unknown',
			arguments: parseToolInput(action.toolInput),
			extensions: { phase: 'ready', invocationMessage: stringOrMarkdown(action.invocationMessage), meta: action._meta },
		});
	}

	private emitToolCallComplete(queue: WorkerEventQueue, toolNames: ReadonlyMap<string, string>, inputId: string, action: ChatToolCallCompleteAction): void {
		queue.push({
			type: 'capability_result',
			inputId,
			callId: action.toolCallId,
			name: toolNames.get(action.toolCallId) ?? 'unknown',
			text: toolResultText(action),
			isError: !action.result.success,
			extensions: { structuredContent: action.result.structuredContent, meta: action._meta },
		});
	}

	private finish(record: AgentHostSessionRecord, event: Extract<WorkerEvent, { type: 'terminal' }>): void {
		const active = record.active;
		if (!active || active.seenTerminal) return;
		active.seenTerminal = true;
		active.queue.push(event);
		active.listener.dispose();
		active.queue.close();
		record.active = undefined;
		this.touch(record, event.status === 'cancelled' || event.status === 'interrupted' ? 'interrupted' : 'idle');
	}

	private requireSession(session: WorkerSessionHandle): AgentHostSessionRecord {
		if (session.workerId !== this.workerId) throw new Error(`Worker session ${session.sessionId} belongs to ${session.workerId}, not ${this.workerId}.`);
		const record = this.sessions.get(session.sessionId);
		if (!record) throw new Error(`Unknown or disposed worker session: ${session.sessionId}`);
		return record;
	}

	private touch(record: AgentHostSessionRecord, state: WorkerSessionHandle['state']): void {
		record.handle.state = state;
		record.handle.lastActiveAt = new Date().toISOString();
	}

	private async waitForSessionState(session: URI): Promise<SessionState> {
		const ref = this.connection.getSubscription(StateComponents.Session, session, 'AgentHostWorkerAdapter.session');
		try {
			const current = ref.object.value;
			if (current instanceof Error) throw current;
			if (current) return current;
			return await new Promise<SessionState>((resolve, reject) => {
				const change = ref.object.onDidChange(value => { change.dispose(); error?.dispose(); resolve(value); });
				const error = ref.object.onDidError?.(err => { change.dispose(); error?.dispose(); reject(err); });
			});
		} finally {
			ref.dispose();
		}
	}

	private async waitForChatState(subscription: IAgentSubscription<ChatState>): Promise<ChatState> {
		const current = subscription.value;
		if (current instanceof Error) throw current;
		if (current) return current;
		return await new Promise<ChatState>((resolve, reject) => {
			const change = subscription.onDidChange(value => { change.dispose(); error?.dispose(); resolve(value); });
			const error = subscription.onDidError?.(err => { change.dispose(); error?.dispose(); reject(err); });
		});
	}
}
