import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build/package.json'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-api-broker-'));
await require('esbuild').build({ stdin: { contents: `export { ApiWorkerAdapter } from './extensions/shuncode/src/api-worker-adapter.ts';`, resolveDir: root, loader: 'ts' }, outfile: path.join(temp, 'entry.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const { ApiWorkerAdapter } = require(path.join(temp, 'entry.cjs'));
const deferred = () => { let resolve: any; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
try {
  for (const mode of ['ok', 'pipe-error', 'cancel', 'ended', 'duplicate', 'forbidden']) {
    const ack = deferred(), called = deferred(); let invocation: any, toolReturned: any;
    const runtime = {
      hello: async () => ({ tools: ['read_files'], capabilities: { missionToolBroker: true } }),
      runAgent: async (params: any, trace: any, _checkpoint: any, context: any) => {
        assert.equal(params.hostManagedTools, true); invocation = context;
        trace({ type: 'tool_call', data: { name: 'read_files' } });
        const request = context.invokeMissionTool(42, mode === 'forbidden' ? 'apply_patch' : 'read_files', { files: [{ path: 'README.md' }] });
        called.resolve();
        if (mode === 'ended') { void request.then(value => { toolReturned = value; }); return { status: 'completed' }; }
        if (mode === 'forbidden') { await assert.rejects(request, /exact active Mission/); return { status: 'completed' }; }
        toolReturned = await request;
        if (mode === 'cancel') return { status: 'interrupted' };
        await ack.promise;
        context.missionToolSubmitted(42, mode === 'pipe-error' ? new Error('pipe failed') : undefined);
        return { status: 'completed' };
      },
    };
    const adapter = new ApiWorkerAdapter(runtime, 'api', 'configured', true);
    const descriptor = await adapter.describe();
    assert.ok(descriptor.capabilityProjection.executionRoutes.some(r => r.schemaSourceId === 'bridge-task-tool-definitions'),
      'API host broker must project all production schema owners, not only runtime hello file names');
    const session = await adapter.createSession({ model: 'test', workspaceRoot: temp, runtime: {} });
    const stream = adapter.send(session, { inputId: mode, prompt: 'bounded', allowedCapabilities: ['read_files'], externalCapabilities: [] });
    await called.promise;
    if (mode === 'forbidden' || mode === 'ended') {
      const events = []; for await (const event of stream) events.push(event);
      assert.equal(events.filter(e => e.type === 'capability_call').length, mode === 'ended' ? 1 : 0);
      if (mode === 'ended') { await new Promise(done => setImmediate(done)); assert.equal(toolReturned.isError, true); }
      await adapter.dispose(session); continue;
    }
    const iterator = stream[Symbol.asyncIterator](); const call = (await iterator.next()).value;
    assert.equal(call.dispatch, 'host-requested'); assert.equal(call.callId, 'api-rpc:42');
    await assert.rejects(adapter.submitCapabilityResult(session, { inputId: 'wrong', callId: call.callId, name: call.name, text: 'no' }), /exact active/);
    await assert.rejects(adapter.submitCapabilityResult(session, { inputId: mode, callId: call.callId, name: 'wrong', text: 'no' }), /exact pending call/);
    const result = { inputId: mode, callId: call.callId, name: call.name, text: 'canonical-result', isError: false };
    if (mode === 'cancel') {
      await adapter.interrupt(session);
      const rest = []; for (;;) { const next = await iterator.next(); if (next.done) break; rest.push(next.value); }
      assert.equal(rest.at(-1).status, 'cancelled');
      await assert.rejects(adapter.submitCapabilityResult(session, result));
    } else {
      let delivered = false; const delivery = adapter.submitCapabilityResult(session, result).then(() => { delivered = true; });
      await new Promise(done => setImmediate(done)); assert.equal(delivered, false, 'delivery needs pipe ACK');
      if (mode === 'duplicate') await assert.rejects(adapter.submitCapabilityResult(session, result), /already submitted/);
      ack.resolve();
      if (mode === 'pipe-error') await assert.rejects(delivery, /pipe failed/); else await delivery;
      for (;;) { const next = await iterator.next(); if (next.done) break; }
      assert.equal(toolReturned.text, 'canonical-result');
      await assert.rejects(adapter.submitCapabilityResult(session, result), /exact active|no pending/);
    }
    await assert.rejects(invocation.invokeMissionTool(43, 'read_files', {}), /exact active/);
    await adapter.dispose(session);
  }
  // A dotted semantic name must survive provider-safe aliasing without gaining
  // an alternate spelling at the canonical broker/result authority boundary.
  const semanticName = 'nimora.coordinator.inspect-managed-scope';
  let wireName: string;
  const runtimeAliases = {
    hello: async () => ({ capabilities: { missionToolBroker: true } }),
    runAgent: async (params: any, _trace: any, _checkpoint: any, context: any) => {
      wireName = params.externalTools[0].name;
      assert.match(wireName, /^[A-Za-z0-9_-]{1,64}$/); assert.notEqual(wireName, semanticName);
      assert.deepEqual(params.allowedTools, [wireName]); assert.match(params.prompt, /Provider function wire names/);
      await assert.rejects(context.invokeMissionTool(1, semanticName, {}), /exact active Mission/);
      await assert.rejects(context.invokeMissionTool(1, 'nimora_tool_unknown', {}), /exact active Mission/);
      const value = await context.invokeMissionTool(2, wireName, {});
      context.missionToolSubmitted(2); assert.equal(value.text, 'inspection');
      return { status: 'completed' };
    },
  };
  const aliasAdapter = new ApiWorkerAdapter(runtimeAliases, 'api', 'configured', true);
  const aliasSession = await aliasAdapter.createSession({ model: 'test', workspaceRoot: temp, runtime: {} });
  const aliasEvents = [];
  for await (const event of aliasAdapter.send(aliasSession, { inputId: 'aliases', prompt: 'inspect', allowedCapabilities: [semanticName],
    externalCapabilities: [{ name: semanticName, inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] })) {
    aliasEvents.push(event);
    if (event.type === 'capability_call') {
      assert.equal(event.name, semanticName); assert.deepEqual(event.arguments, {});
      await assert.rejects(aliasAdapter.submitCapabilityResult(aliasSession, { inputId: 'aliases', callId: event.callId, name: wireName, text: 'wrong' }), /exact pending call/);
      await aliasAdapter.submitCapabilityResult(aliasSession, { inputId: 'aliases', callId: event.callId, name: semanticName, text: 'inspection' });
    }
  }
  assert.equal(aliasEvents.at(-1).status, 'completed'); await aliasAdapter.dispose(aliasSession);
  let accessorReads = 0;
  const accessor = Object.defineProperty({}, 'invocation_id', { enumerable: true, get() { accessorReads++; return 'encoded'; } });
  const invalidWireArguments = [null, [], {}, { dummy: true }, { invocation_id: 'wrong' },
    { invocation_id: 'encoded', dummy: true }, Object.create({ invocation_id: 'encoded' }),
    Object.assign(Object.create(null), { invocation_id: 'encoded' }), accessor,
    Object.defineProperty({}, 'invocation_id', { value: 'encoded' })];
  for (const [index, argumentsValue] of invalidWireArguments.entries()) {
    const wireRuntime = { hello: async () => ({ capabilities: { missionToolBroker: true } }),
      runAgent: async (params, _trace, _checkpoint, context) => {
        assert.deepEqual(params.externalTools[0].inputSchema, { type: 'object', properties: { invocation_id: { type: 'string', enum: ['encoded'] } }, required: ['invocation_id'], additionalProperties: false });
        await assert.rejects(context.invokeMissionTool(index, params.externalTools[0].name, argumentsValue), /wire envelope|wire invocation_id/);
        return { answer: 'rejected without host invocation', status: 'completed' };
      } };
    const adapter = new ApiWorkerAdapter(wireRuntime, 'wire-api', 'configured', true);
    const session = await adapter.createSession({ model: 'test', workspaceRoot: temp, runtime: {} });
    const events = [];
    for await (const event of adapter.send(session, { inputId: 'encoded', prompt: 'exact command only', allowedCapabilities: [semanticName],
      externalCapabilities: [{ name: semanticName, inputSchema: { type: 'object', properties: {}, additionalProperties: false, const: {} } }],
      extensions: { terminalAfterHostCapabilityResult: true } })) events.push(event);
    assert.equal(events.filter(e => e.type === 'capability_call').length, 0, 'invalid API encoding must cause zero owning host calls');
    await adapter.dispose(session);
  }
  assert.equal(accessorReads, 0, 'wire admission cannot execute argument accessors');
  const legacy = new ApiWorkerAdapter({ hello: async () => ({ tools: ['read_files'], capabilities: { ideToolBroker: true } }) }, 'old', 'old', true);
  assert.equal((await legacy.describe()).availability, 'unavailable');
  assert.deepEqual((await legacy.describe()).capabilityProjection.executionRoutes, []);
  console.log('API Mission broker PASS: canonical schemas, exact occurrence/input, pipe ACK, cancellation, runtime death, duplicate and forbidden call refusal, no observed double execution.');
} finally { assert.equal(path.dirname(temp), os.tmpdir()); assert.ok(path.basename(temp).startsWith('nimora-api-broker-')); await fs.rm(temp, { recursive: true, force: true }); }
