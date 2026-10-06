import type { IAgentConnection } from './vs/platform/agentHost/common/agentService.js';
import { CLIENT_TOOL_SCOPE_CONFIG_KEY, type IClientToolScope, assertClientToolScopeTools, supportsClientToolScope } from './vs/platform/agentHost/common/clientToolScope.js';
import { URI } from './vs/base/common/uri.js';
import { generateUuid } from './vs/base/common/uuid.js';
import { ActionType } from './vs/platform/agentHost/common/state/sessionActions.js';
import { StateComponents, ToolResultContentType } from './vs/platform/agentHost/common/state/sessionState.js';
import { AgentHostWorkerAdapter } from './agent-host-worker-adapter.js';
import type { WorkerCapabilityResultInput, WorkerEvent, WorkerInput, WorkerSessionHandle, WorkerSessionOptions } from './worker-contract.js';

export interface ClientToolWorkerOptions extends WorkerSessionOptions { provider: 'copilotcli'; }
interface PendingResult {
	name: string;
	submitted: boolean;
	resolve(): void;
	reject(error: Error): void;
	receipt: Promise<void>;
}
interface Record {
	handle: WorkerSessionHandle;
	options: ClientToolWorkerOptions;
	backend?: WorkerSessionHandle;
	scope?: IClientToolScope;
	usedInputs: Set<string>;
	active?: { inputId: string; calls: Map<string, PendingResult> };
}

/** Fresh owned AHP sessions only. SDK calls execute exclusively through the host-requested client boundary. */
export class AgentHostClientToolWorker {
	private readonly records = new Map<string, Record>();
	private readonly observed: AgentHostWorkerAdapter;
	constructor(private readonly connection: IAgentConnection, private readonly workerId = 'nimora.agent-host') {
		this.observed = new AgentHostWorkerAdapter(connection, workerId);
	}
	create(options: ClientToolWorkerOptions): WorkerSessionHandle {
		if (!supportsClientToolScope(this.connection.rootState.value)) { throw new Error('Agent host server does not advertise the client tool scope contract'); }
		if (options.provider !== 'copilotcli') { throw new Error('Backend does not support the client tool scope contract'); }
		const now = new Date().toISOString();
		const handle: WorkerSessionHandle = { sessionId: generateUuid(), workerId: this.workerId, state: 'idle', model: options.model, createdAt: now, lastActiveAt: now };
		this.records.set(handle.sessionId, { handle, options: structuredClone(options), usedInputs: new Set() });
		return { ...handle };
	}
	async *send(handle: WorkerSessionHandle, input: WorkerInput): AsyncIterable<WorkerEvent> {
		const record = this.require(handle);
		if (!supportsClientToolScope(this.connection.rootState.value)) { throw new Error('Agent host server tool scope changed; do not replay'); }
		if (record.active || record.usedInputs.has(input.inputId)) { throw new Error('Native input is running or consumed; do not replay'); }
		if (input.images?.length || input.checkpoint || input.history?.length) { throw new Error('Scoped native sessions do not import history, images, or checkpoints'); }
		record.usedInputs.add(input.inputId);
		record.active = { inputId: input.inputId, calls: new Map() };
		record.handle.state = 'running';
		try {
			const tools = (input.externalCapabilities ?? []).map(def => {
				if (def.inputSchema.type !== 'object') { throw new Error('A scoped capability requires an object input schema'); }
				return { name: def.name, description: def.description, inputSchema: def.inputSchema as IClientToolScope['tools'][number]['inputSchema'] };
			});
			if ((input.allowedCapabilities ?? []).length) { throw new Error('Native name-only tools cannot enter a client tool scope'); }
			if (record.scope) { assertClientToolScopeTools(record.scope, tools); }
			else {
				record.scope = { version: 1, scopeId: generateUuid(), clientId: this.connection.clientId, tools };
				record.backend = await this.observed.createSession({
					provider: 'copilotcli', model: record.options.model, workspaceRoot: record.options.workspaceRoot,
					createSession: { config: { [CLIENT_TOOL_SCOPE_CONFIG_KEY]: JSON.stringify(record.scope) },
						activeClient: { clientId: this.connection.clientId, tools } },
				});
			}
			const chatRef = this.connection.getSubscription(StateComponents.Chat, URI.parse(String(record.backend!.extensions?.chatUri)), 'ClientToolWorker.receipts');
			const receiptListener = chatRef.object.onDidApplyAction(envelope => {
				if (envelope.origin || envelope.rejectionReason || envelope.action.type !== ActionType.ChatToolCallComplete) { return; }
				const action = envelope.action;
				const receipt = action._meta?.['clientToolScopeReceipt'] as IClientToolScope | undefined;
				const call = record.active?.calls.get(action.toolCallId);
				if (action.turnId === input.inputId && call?.submitted && receipt?.version === 1
					&& receipt.scopeId === record.scope?.scopeId && receipt.clientId === this.connection.clientId) { call.resolve(); }
			});
			try {
			for await (const event of this.observed.send(record.backend!, { inputId: input.inputId, prompt: [input.modeInstructions, input.prompt].filter(Boolean).join('\n\n') })) {
				if (event.type === 'capability_call') {
					const request = (event.extensions?.meta as { clientToolScopeRequest?: IClientToolScope } | undefined)?.clientToolScopeRequest;
					if (!request || event.extensions?.serverProduced !== true) { continue; }
					if (request.version !== 1 || request.scopeId !== record.scope.scopeId || request.clientId !== this.connection.clientId
						|| !event.callId || !tools.some(tool => tool.name === event.name)) { throw new Error('Native request escaped the frozen client scope'); }
					if (record.active.calls.has(event.callId)) { continue; }
					let resolve!: () => void, reject!: (error: Error) => void;
					const receipt = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
					void receipt.catch(() => undefined);
					record.active.calls.set(event.callId, { name: event.name, submitted: false, resolve, reject, receipt });
					yield { ...event, dispatch: 'host-requested' };
				} else if (event.type === 'capability_result') {
					const receipt = (event.extensions?.meta as { clientToolScopeReceipt?: IClientToolScope } | undefined)?.clientToolScopeReceipt;
					if (!receipt || event.extensions?.serverProduced !== true) { continue; }
					const call = event.callId ? record.active.calls.get(event.callId) : undefined;
					if (!call?.submitted || call.name !== event.name || receipt.scopeId !== record.scope.scopeId
						|| receipt.clientId !== this.connection.clientId || receipt.version !== 1) { throw new Error('Unmatched SDK result receipt'); }
					call.resolve();
					yield event;
				} else { yield event; }
			}
			} finally { receiptListener.dispose(); chatRef.dispose(); }
		} finally {
			for (const call of record.active.calls.values()) { call.reject(new Error('Native turn ended before SDK receipt')); }
			record.active = undefined;
			record.handle.state = 'idle';
		}
	}
	async complete(handle: WorkerSessionHandle, result: WorkerCapabilityResultInput): Promise<void> {
		const record = this.require(handle);
		const call = result.callId ? record.active?.calls.get(result.callId) : undefined;
		if (!record.backend || !record.active || record.active.inputId !== result.inputId || !call || call.name !== result.name || call.submitted) {
			throw new Error('Unknown, stale, or consumed native capability result');
		}
		call.submitted = true;
		this.connection.dispatch(String(record.backend.extensions?.chatUri), {
			type: ActionType.ChatToolCallComplete, turnId: result.inputId, toolCallId: result.callId!,
			result: { success: !result.isError, pastTenseMessage: `${result.name} completed`, content: [{ type: ToolResultContentType.Text, text: result.text ?? JSON.stringify(result.data ?? null) }],
				...(result.isError ? { error: { message: result.text ?? 'Capability failed' } } : {}) },
		});
		// Client-action echoes never confirm delivery. Only the server's SDK completion above resolves this.
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([call.receipt, new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('Native SDK result receipt timed out; delivery is unknown, do not replay')), 30000);
			})]);
		} finally { if (timer) { clearTimeout(timer); } }
	}
	async interrupt(handle: WorkerSessionHandle): Promise<void> {
		const record = this.require(handle);
		if (record.backend) { await this.observed.interrupt(record.backend); }
		for (const call of record.active?.calls.values() ?? []) { call.reject(new Error('Native turn interrupted')); }
	}
	async dispose(handle: WorkerSessionHandle): Promise<void> {
		const record = this.require(handle);
		await this.interrupt(handle);
		if (record.backend) { await this.observed.dispose(record.backend); }
		this.records.delete(handle.sessionId);
	}
	private require(handle: WorkerSessionHandle): Record {
		const record = this.records.get(handle.sessionId);
		if (!record || handle.workerId !== this.workerId) { throw new Error('Unknown scoped native worker handle'); }
		return record;
	}
}
