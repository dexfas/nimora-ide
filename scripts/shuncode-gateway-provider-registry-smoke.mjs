import assert from 'node:assert/strict';
import { defineGatewayProvider, GatewayProviderRegistry } from '../tools/webmcp-gateway/provider-registry.mjs';

const calls = [];
const upstream = defineGatewayProvider({
  id: 'upstream',
  fallback: true,
  listTools: async () => [{ name: 'read_files' }, { name: 'shared_name' }],
  callTool: async (name, args) => {
    calls.push({ provider: 'upstream', name, args });
    return { provider: 'upstream', name };
  },
});
const integrated = defineGatewayProvider({
  id: 'integrated',
  listTools: async () => [{ name: 'open_browser_page' }, { name: 'shared_name' }],
  owns: async name => name === 'open_browser_page' || name === 'shared_name',
  callTool: async (name, args) => {
    calls.push({ provider: 'integrated', name, args });
    return { provider: 'integrated', name };
  },
});
const managed = defineGatewayProvider({
  id: 'managed',
  listTools: async () => [{ name: 'browser_pages' }],
  owns: name => name === 'browser_pages',
  callTool: async (name, args) => {
    calls.push({ provider: 'managed', name, args });
    return { provider: 'managed', name };
  },
});

const registry = new GatewayProviderRegistry([upstream, integrated, managed]);
assert.deepEqual(registry.listProviders(), [
  { id: 'upstream', fallback: true },
  { id: 'integrated', fallback: false },
  { id: 'managed', fallback: false },
]);

assert.deepEqual((await registry.listTools()).map(tool => tool.name), [
  'read_files', 'shared_name', 'open_browser_page', 'shared_name', 'browser_pages',
], 'presentation order must preserve provider registration order');

assert.deepEqual((await registry.listTools({ filter: (_tool, provider) => provider.id !== 'integrated' })).map(tool => tool.name), [
  'read_files', 'shared_name', 'browser_pages',
]);

assert.equal((await registry.resolve('shared_name')).id, 'integrated', 'explicit local owner must beat fallback upstream provider');
assert.equal((await registry.resolve('browser_pages')).id, 'managed');
assert.equal((await registry.resolve('unknown_upstream_tool')).id, 'upstream', 'unknown names must retain historical upstream fallback behavior');

assert.deepEqual(await registry.callTool('browser_pages', { page_id: 1 }), { provider: 'managed', name: 'browser_pages' });
assert.deepEqual(await registry.callTool('read_files', { path: 'README.md' }), { provider: 'upstream', name: 'read_files' });
assert.deepEqual(calls.map(call => call.provider), ['managed', 'upstream']);

assert.throws(() => registry.register(upstream), /already registered/);
await assert.rejects(
  () => new GatewayProviderRegistry([defineGatewayProvider({ id: 'bad', listTools: async () => null, callTool: async () => ({}) })]).listTools(),
  /non-array tool list/,
);

console.log('[smoke] Gateway provider registry ordering/local-owner/fallback/filter contract ok');
