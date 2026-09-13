import assert from 'node:assert/strict';
import { createIntegratedBrowserProvider } from '../tools/webmcp-gateway/integrated-browser-provider.mjs';
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

let clock = 10_000;
let toolFetches = 0;
const invokeBodies = [];
const integratedProvider = createIntegratedBrowserProvider({
  bridgeUrl: 'http://127.0.0.1:49999/',
  now: () => clock,
  fetchImpl: async (url, options = {}) => {
    if (String(url).endsWith('/tools')) {
      toolFetches += 1;
      return new Response(JSON.stringify({ tools: [{ name: `integrated-${toolFetches}` }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).endsWith('/invoke')) {
      invokeBodies.push(JSON.parse(String(options.body || '{}')));
      return new Response(JSON.stringify({
        ok: true,
        result: {
          content: [
            { type: 'text', text: 'INTEGRATED_OK' },
            { type: 'data', base64: 'YWJjZA==' },
            { type: 'unknown', value: 42 },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`Unexpected integrated provider URL: ${url}`);
  },
});
assert.equal(integratedProvider.id, 'integrated-browser');
assert.deepEqual((await integratedProvider.listTools()).map(tool => tool.name), ['integrated-1']);
assert.deepEqual((await integratedProvider.listTools()).map(tool => tool.name), ['integrated-1']);
assert.equal(toolFetches, 1, 'integrated provider should reuse its short-lived tool cache');
clock += 2501;
assert.deepEqual((await integratedProvider.listTools()).map(tool => tool.name), ['integrated-2']);
assert.equal(toolFetches, 2);
assert.deepEqual((await integratedProvider.refreshTools()).map(tool => tool.name), ['integrated-3']);
assert.equal(toolFetches, 3, 'health refresh must bypass the tool cache');

const integratedResult = await integratedProvider.callTool('integrated-3', { value: 7 });
assert.deepEqual(invokeBodies, [{ name: 'integrated-3', input: { value: 7 } }]);
assert.equal(integratedResult.content[0].text, 'INTEGRATED_OK');
assert.match(integratedResult.content[1].text, /binary browser result omitted: 8 base64 chars/);
assert.equal(integratedResult.content[2].text, JSON.stringify({ type: 'unknown', value: 42 }));

console.log('[smoke] Gateway provider registry + Integrated Browser provider cache/refresh/invoke contract ok');
