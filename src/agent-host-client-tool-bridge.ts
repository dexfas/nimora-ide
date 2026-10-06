import { AgentHostClientToolWorker, type ClientToolWorkerOptions } from './agent-host-client-tool-worker.js';
import type { IAgentConnection } from './vs/platform/agentHost/common/agentService.js';
import type { WorkerCapabilityResultInput, WorkerEvent, WorkerInput, WorkerSessionHandle } from './worker-contract.js';

interface BridgeRecord {
	handle: WorkerSessionHandle;
	queue: WorkerEvent[];
	waiter?: () => void;
	active: boolean;
	bytes: number;
}
/** Bounded DTO bridge to the host-owned worker. It carries no Mission state or execution authority. */
export class AgentHostClientToolBridge {
	private readonly worker: AgentHostClientToolWorker;
	private readonly records = new Map<string, BridgeRecord>();
	constructor(connection: IAgentConnection) { this.worker = new AgentHostClientToolWorker(connection); }
	create(options: ClientToolWorkerOptions): WorkerSessionHandle {
		if (this.records.size >= 32) { throw new Error('Scoped worker capacity exceeded'); }
		const handle = this.worker.create(options);
		this.records.set(handle.sessionId, { handle, queue: [], active: false, bytes: 0 });
		return handle;
	}
	start(handle: WorkerSessionHandle, input: WorkerInput): void {
		const record = this.require(handle);
		if (record.active || record.queue.length) { throw new Error('Worker has an active or undrained input'); }
		record.active = true;
		void (async () => {
			try {
				for await (const event of this.worker.send(handle, input)) {
					const bytes = JSON.stringify(event).length;
					if (record.queue.length >= 512 || record.bytes + bytes > 4194304) { throw new Error('Worker event buffer overflow'); }
					record.queue.push(event); record.bytes += bytes;
					record.waiter?.();
				}
			} catch (error) {
				await this.worker.interrupt(handle).catch(() => undefined);
				record.queue.push({ type: 'terminal', inputId: input.inputId, status: 'error', error: String(error) });
			} finally { record.active = false; record.waiter?.(); }
		})();
	}
	async poll(handle: WorkerSessionHandle): Promise<{ events: WorkerEvent[]; active: boolean }> {
		const record = this.require(handle);
		if (record.waiter) { throw new Error('Concurrent worker poll rejected'); }
		if (!record.queue.length && record.active) {
			await new Promise<void>(resolve => {
				const timer = setTimeout(() => { record.waiter = undefined; resolve(); }, 1000);
				record.waiter = () => { clearTimeout(timer); record.waiter = undefined; resolve(); };
			});
		}
		const events = record.queue.splice(0); record.bytes = 0;
		return { events, active: record.active };
	}
	async complete(handle: WorkerSessionHandle, result: WorkerCapabilityResultInput): Promise<void> { this.require(handle); await this.worker.complete(handle, result); }
	interrupt(handle: WorkerSessionHandle): Promise<void> { this.require(handle); return this.worker.interrupt(handle); }
	async dispose(handle: WorkerSessionHandle): Promise<void> {
		const record = this.require(handle); await this.worker.dispose(handle);
		record.waiter?.(); this.records.delete(handle.sessionId);
	}
	private require(handle: WorkerSessionHandle): BridgeRecord {
		const record = this.records.get(handle.sessionId);
		if (!record || record.handle.workerId !== handle.workerId) { throw new Error('Unknown scoped worker bridge handle'); }
		return record;
	}
}
