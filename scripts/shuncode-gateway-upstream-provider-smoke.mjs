import assert from 'node:assert/strict';
import { createUpstreamMcpProvider } from '../tools/webmcp-gateway/upstream-mcp-provider.mjs';

function capabilityMeta(id, retry, risk = 'read', idempotency = 'safe') {
  return {
    'nimora/capability': {
      id,
      version: 1,
      title: id,
      category: 'workspace',
      tags: [],
      environment: 'extension-host',
      risk,
      idempotency,
      retry,
      approval: risk === 'read' ? 'none' : 'session',
      destructive: risk !== 'read',
      openWorld: false,
    },
  };
}

const tools = [
  { name: 'read_files', inputSchema: { type: 'object' }, _meta: capabilityMeta('workspace.read-files', 'automatic') },
  { name: 'apply_patch', inputSchema: { type: 'object' }, _meta: capabilityMeta('workspace.apply-patch', 'never', 'write', 'non-idempotent') },
  { name: 'search_files', inputSchema: { type: 'object' } },
];

let connectionNumber = 0;
let closeCount = 0;
const callLog = [];
const sleepLog = [];
const warnings = [];

function clientFor(connection) {
  return {
    async listTools() {
      if (connection === 1) throw new Error('ECONNRESET list');
      return { tools };
    },
    async callTool(request) {
      callLog.push({ connection, name: request.name });
      if (request.name === 'read_files' && connection === 2) throw new Error('socket terminated');
      if (request.name === 'apply_patch') throw new Error('ECONNRESET during apply');
      if (request.name === 'search_files' && connection === 4) throw new Error('EPIPE legacy read');
      return { content: [{ type: 'text', text: `connection-${connection}:${request.name}` }] };
    },
    async close() {
      closeCount += 1;
    },
  };
}

const provider = createUpstreamMcpProvider({
  url: 'http://127.0.0.1:49998/mcp',
  connectClient: async () => clientFor(++connectionNumber),
  sleep: async ms => { sleepLog.push(ms); },
  listRetryDelays: [0, 11, 22, 33],
  callRetryDelay: 44,
  logger: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
});

assert.equal(provider.id, 'upstream-mcp');
assert.equal(provider.fallback, true);
assert.deepEqual((await provider.listTools()).map(tool => tool.name), ['read_files', 'apply_patch', 'search_files']);
assert.equal(connectionNumber, 2, 'listTools transport failure must reconnect');
assert.deepEqual(sleepLog, [11]);
assert.ok(warnings.some(message => /listTools attempt 1\/4 failed/.test(message)));

const readResult = await provider.callTool('read_files', {});
assert.match(readResult.content[0].text, /connection-3:read_files/);
assert.deepEqual(callLog.slice(0, 2), [
  { connection: 2, name: 'read_files' },
  { connection: 3, name: 'read_files' },
]);
assert.deepEqual(sleepLog, [11, 44], 'automatic capability retry must use call retry delay exactly once');

await assert.rejects(
  () => provider.callTool('apply_patch', {}),
  /NOT automatically retried/,
);
assert.equal(callLog.filter(call => call.name === 'apply_patch').length, 1, 'side-effect capability must never be retried after transport failure');

const legacyResult = await provider.callTool('search_files', {});
assert.match(legacyResult.content[0].text, /connection-5:search_files/);
assert.deepEqual(callLog.filter(call => call.name === 'search_files'), [
  { connection: 4, name: 'search_files' },
  { connection: 5, name: 'search_files' },
], 'legacy read-only allowlist must retain one compatibility retry');
assert.deepEqual(sleepLog, [11, 44, 44]);
assert.ok(closeCount >= 3, 'transport resets should close stale upstream clients');

const probe = await provider.probeTools();
assert.equal(probe.length, 3);

await provider.reset();
assert.ok(closeCount >= 4);

const missing = createUpstreamMcpProvider({
  url: '',
  connectClient: async () => { throw new Error('should not connect'); },
  listRetryDelays: [0],
  logger: { warn() {} },
});
await assert.rejects(() => missing.listTools(), /SHUNCODE_MCP_URL is not configured/);

console.log('[smoke] Upstream MCP provider reconnect/metadata retry/side-effect guard/legacy fallback ok');
