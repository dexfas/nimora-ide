import assert from 'node:assert/strict';
import {
  createPersonalEdgeProvider,
  PersonalEdgeControlError,
  PersonalEdgePollAbortedError,
} from '../tools/webmcp-gateway/personal-edge-provider.mjs';

let nowValue = 1_000;
let idSequence = 0;
const provider = createPersonalEdgeProvider({
  token: 'test-token',
  now: () => nowValue,
  newId: () => `cmd-${++idSequence}`,
  commandTimeoutMs: 40,
  pollTimeoutMs: 40,
});

assert.equal(provider.id, 'personal-edge');
assert.deepEqual(provider.status(), { connected: false, shared: false, lastSeen: null, tab: null });
const tools = await provider.listTools();
assert.deepEqual(tools.map(tool => tool.name), [
  'personal_edge_status', 'personal_edge_read', 'personal_edge_elements',
  'personal_edge_click', 'personal_edge_fill', 'personal_edge_navigate', 'personal_edge_reload',
]);
assert.equal(tools.find(tool => tool.name === 'personal_edge_read')?._meta?.['nimora/capability']?.retry, 'automatic');
assert.equal(tools.find(tool => tool.name === 'personal_edge_click')?._meta?.['nimora/capability']?.approval, 'session');
assert.equal(tools.find(tool => tool.name === 'personal_edge_click')?._meta?.['nimora/capability']?.idempotency, 'non-idempotent');
assert.equal(provider.owns('personal_edge_read'), true);
assert.equal(provider.owns('browser_pages'), false);

assert.throws(
  () => provider.register({ token: 'wrong', clientId: 'edge-1' }),
  error => error instanceof PersonalEdgeControlError && error.statusCode === 403,
);
assert.throws(
  () => provider.register({ token: 'test-token', clientId: '' }),
  error => error instanceof PersonalEdgeControlError && error.statusCode === 400,
);

const registered = provider.register({
  token: 'test-token',
  clientId: 'edge-1',
  shared: true,
  tab: { id: 7, url: 'https://example.test/page', title: 'Example' },
});
assert.equal(registered.connected, true);
assert.equal(registered.shared, true);
assert.equal(registered.tab.id, 7);

const statusResult = await provider.callTool('personal_edge_status');
assert.equal(statusResult.structuredContent.connected, true);

const readPromise = provider.callTool('personal_edge_read', { max_chars: 999999 });
const readCommand = await provider.poll({ token: 'test-token', clientId: 'edge-1' });
assert.deepEqual(readCommand, { id: 'cmd-1', op: 'read', tabId: 7, maxChars: 50000 });
provider.submitResult({
  token: 'test-token',
  clientId: 'edge-1',
  id: readCommand.id,
  result: { title: 'Example', text: 'hello' },
});
const readResult = await readPromise;
assert.deepEqual(readResult.structuredContent, { title: 'Example', text: 'hello' });

const clickPromise = provider.callTool('personal_edge_click', { selector: '  #go  ' });
const clickCommand = await provider.poll({ token: 'test-token', clientId: 'edge-1' });
assert.deepEqual(clickCommand, { id: 'cmd-2', op: 'click', tabId: 7, selector: '#go' });
provider.submitResult({ token: 'test-token', clientId: 'edge-1', id: clickCommand.id, result: { clicked: true } });
assert.equal((await clickPromise).structuredContent.clicked, true);

assert.throws(
  () => provider.submitResult({ token: 'test-token', clientId: 'other', id: 'cmd-2', result: {} }),
  error => error instanceof PersonalEdgeControlError && error.statusCode === 409,
);
assert.throws(
  () => provider.submitResult({ token: 'test-token', clientId: 'edge-1', id: 'missing', result: {} }),
  error => error instanceof PersonalEdgeControlError && error.statusCode === 410,
);
assert.throws(
  () => provider.poll({ token: 'wrong', clientId: 'edge-1' }),
  error => error instanceof PersonalEdgeControlError && error.statusCode === 403,
);

const abortController = new AbortController();
const abortedPoll = provider.poll({ token: 'test-token', clientId: 'edge-1', signal: abortController.signal });
abortController.abort();
await assert.rejects(() => abortedPoll, error => error instanceof PersonalEdgePollAbortedError);

// A disconnected poll only removes the waiter; a later capability request must
// still queue normally and complete when a new poll arrives.
const fillPromise = provider.callTool('personal_edge_fill', { selector: '#name', value: 'Nimora' });
const fillCommand = await provider.poll({ token: 'test-token', clientId: 'edge-1' });
assert.equal(fillCommand.op, 'fill');
provider.submitResult({ token: 'test-token', clientId: 'edge-1', id: fillCommand.id, result: { filled: true } });
assert.equal((await fillPromise).structuredContent.filled, true);

await assert.rejects(
  () => provider.callTool('personal_edge_navigate', { url: 'file:///tmp/nope' }),
  /only accepts absolute http\/https URLs/,
);
await assert.rejects(() => provider.callTool('personal_edge_click', { selector: '   ' }), /requires selector/);

const timeoutPromise = provider.callTool('personal_edge_read', { max_chars: 1 });
await assert.rejects(() => timeoutPromise, /timed out waiting for the shared tab extension/);
// The timed-out queued command must be discarded, so a poll waits and returns null.
assert.equal(await provider.poll({ token: 'test-token', clientId: 'edge-1' }), null);

nowValue = 92_000;
assert.equal(provider.status().connected, false, 'client must become stale after 90 seconds without registration heartbeat');
await assert.rejects(() => provider.callTool('personal_edge_read'), /not connected/);

nowValue = 93_000;
provider.register({ token: 'test-token', clientId: 'edge-1', shared: true, tab: { id: 9, url: 'edge://settings' } });
await assert.rejects(() => provider.callTool('personal_edge_read'), /privileged\/non-web page/);

console.log('[smoke] Personal Edge provider auth/status/poll/result/timeout/abort/tool contract ok');
