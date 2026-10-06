import assert from 'node:assert/strict';
import { NimoraCurrentRouteRelay } from '../tools/nimora-current-route-relay/worker.mjs';

class FakeStorage {
  value;
  async get() { return this.value; }
  async put(_key, value) { this.value = structuredClone(value); }
}

const storage = new FakeStorage();
const relay = new NimoraCurrentRouteRelay({ storage }, {
  ROUTE_PATH_TOKEN: 'stable-capability',
  ROUTE_UPDATE_SECRET: 'relay-secret',
});
const origin = 'https://stable-relay.example.workers.dev';
const relayBase = `${origin}/r/stable-capability`;
const target = 'https://fresh.trycloudflare.com/mcp/bridge/mission/binding';

const hidden = await relay.fetch(new Request(`${origin}/mcp`));
assert.equal(hidden.status, 404, 'relay must not expose a guessable root /mcp route');

const unauthorized = await relay.fetch(new Request(`${relayBase}/admin/route`));
assert.equal(unauthorized.status, 401);

const update = await relay.fetch(new Request(`${relayBase}/admin/route`, {
  method: 'PUT',
  headers: {
    authorization: 'Bearer relay-secret',
    'content-type': 'application/json',
  },
  body: JSON.stringify({ targetUrl: target, bindingToken: 'binding', bridgeRevision: 7 }),
}));
assert.equal(update.status, 200);
const updateBody = await update.json();
assert.equal(updateBody.targetUrl, target);
assert.equal(updateBody.generation, 1);

const verify = await relay.fetch(new Request(`${relayBase}/admin/route`, {
  headers: { authorization: 'Bearer relay-secret' },
}));
assert.equal(verify.status, 200);
assert.equal((await verify.json()).targetUrl, target);

const originalFetch = globalThis.fetch;
try {
  let forwarded;
  let upstreamResponse;
  globalThis.fetch = async request => {
    forwarded = request;
    assert.equal(request.url, target);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('mcp-session-id'), 'session-1');
    assert.equal(await request.text(), '{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    const payload = new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}');
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    });
    upstreamResponse = new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'mcp-session-id': 'session-1',
      },
    });
    return upstreamResponse;
  };

  const proxied = await relay.fetch(new Request(`${relayBase}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': 'session-1',
    },
    body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  }));
  assert.ok(forwarded);
  assert.equal(upstreamResponse?.bodyUsed, true, 'relay must fully consume the short MCP upstream body before returning the Durable Object response');
  assert.equal(proxied.status, 200);
  assert.equal(proxied.headers.get('mcp-session-id'), 'session-1');
  assert.equal(proxied.headers.get('x-nimora-route-generation'), '1');
  assert.match(await proxied.text(), /"tools"/);
} finally {
  globalThis.fetch = originalFetch;
}

console.log('ShunCode Current Route relay worker smoke: PASS');
