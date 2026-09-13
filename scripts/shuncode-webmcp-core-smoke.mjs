import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webMcpDir = path.join(root, 'extensions', 'shuncode-webmcp');
const [coreSource, siteSource, agentSource] = await Promise.all([
  readFile(path.join(webMcpDir, 'webmcp-page-core.js'), 'utf8'),
  readFile(path.join(webMcpDir, 'webmcp-site-adapters.js'), 'utf8'),
  readFile(path.join(webMcpDir, 'arena-agent-bridge.js'), 'utf8'),
]);

function loadFactory(source, name) {
  const factory = vm.runInNewContext(source.trim(), {}, { filename: name });
  assert.equal(typeof factory, 'function', `${name} must evaluate to a function expression`);
  return factory;
}

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.has(key) ? this.values.get(key) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
}

const createCore = loadFactory(coreSource, 'webmcp-page-core.js');
const storage = new MemoryStorage();
const core = createCore({ storage, seenStorageKey: 'seen' });

const jsonCalls = core.extractCalls(`before
[SHUNCODE_TOOL]
{"id":"json-1","name":"read_files","arguments":{"files":[{"path":"README.md"}]}}
[/SHUNCODE_TOOL]
after`);
assert.equal(jsonCalls.length, 1);
assert.equal(jsonCalls[0].arguments.files[0].path, 'README.md');

const lineCalls = core.extractCalls(`[SHUNCODE_TOOL]
id=line-1
name=apply_patch
arg.files.0.path=README.md
arg.depth=2
arg.enabled=true
arg.patch<<SHUNCODE_EOF
line one
line two
SHUNCODE_EOF
[/SHUNCODE_TOOL]`);
assert.equal(lineCalls.length, 1);
assert.equal(JSON.stringify(lineCalls[0].arguments.files), JSON.stringify([{ path: 'README.md' }]));
assert.equal(lineCalls[0].arguments.depth, 2);
assert.equal(lineCalls[0].arguments.enabled, true);
assert.equal(lineCalls[0].arguments.patch, 'line one\nline two');

const incomplete = core.extractCalls('[SHUNCODE_TOOL]\nid=incomplete\nname=run_command\narg.command=echo hi');
assert.equal(incomplete.length, 0, 'streaming/incomplete calls must never execute before the closing marker');

const repaired = core.extractCalls('[SHUNCODE_TOOL]\n{"id":"repair-1","name":"read_files","arguments":{"files":[{"path":"README.md"}]\n[/SHUNCODE_TOOL]');
assert.equal(repaired.length, 1, 'completed marker may repair bounded missing trailing object braces');
assert.equal(repaired[0].id, 'repair-1');

core.rememberSeen('call-a::occurrence:1');
assert.equal(core.hasSeen('call-a::occurrence:1'), true);
assert.match(storage.getItem('seen'), /call-a::occurrence:1/);
core.setPendingDelivery('delivery-1', { attempts: 0 });
assert.equal(core.pendingDeliveryCount(), 1);
assert.equal(core.pendingDeliveryEntries()[0][0], 'delivery-1');
core.deletePendingDelivery('delivery-1');
assert.equal(core.pendingDeliveryCount(), 0);

storage.setItem('seen', JSON.stringify(['legacy-call']));
const replayCore = createCore({ storage, seenStorageKey: 'seen' });
replayCore.seedSeenFromHistory([
  { baseKey: 'legacy-call', ordinal: 1, key: 'legacy-call::occurrence:1' },
  { baseKey: 'completed-call', ordinal: 1, key: 'completed-call::occurrence:1' },
], new Map([['completed-call', 1]]));
assert.equal(replayCore.hasSeen('legacy-call::occurrence:1'), true, 'legacy dedupe keys must migrate to occurrence identity');
assert.equal(replayCore.hasSeen('completed-call::occurrence:1'), true, 'completed result history must seed dedupe state');

const createSiteAdapter = loadFactory(siteSource, 'webmcp-site-adapters.js');
const emptyDocument = { querySelectorAll: () => [] };
const visible = () => true;
const deepSeekStorage = new MemoryStorage();
const deepSeek = createSiteAdapter({
  window: { innerHeight: 1000 },
  document: emptyDocument,
  location: { hostname: 'chat.deepseek.com', pathname: '/chat', origin: 'https://chat.deepseek.com' },
  visible,
  storage: deepSeekStorage,
});
assert.equal(deepSeek.id, 'deepseek');
assert.equal(deepSeek.isDeepSeekAuthPage, false);
assert.match(deepSeek.transportRule(), /Do NOT use JSON/);
assert.equal(deepSeek.pacingMode, 'disabled-user-preference');
await deepSeek.beforeAutomaticSend();
assert.equal(deepSeek.captureRateLimitNotices().size, 0);
deepSeek.onAutomaticSendAttempt();
const persistedDeepSeekSendState = JSON.parse(deepSeekStorage.getItem('shuncode-webmcp-send-state:https://chat.deepseek.com'));
assert.ok(persistedDeepSeekSendState.lastAutomaticSendAt > 0, 'DeepSeek send attempt state must remain persisted after moving into the site adapter');
await deepSeek.verifyAcceptedSend(new Set());

const deepSeekAuth = createSiteAdapter({
  window: { innerHeight: 1000 },
  document: emptyDocument,
  location: { hostname: 'chat.deepseek.com', pathname: '/sign_in', origin: 'https://chat.deepseek.com' },
  visible,
});
assert.equal(deepSeekAuth.isDeepSeekAuthPage, true);
assert.equal(deepSeekAuth.findComposer(), null);

const generic = createSiteAdapter({
  window: { innerHeight: 1000 },
  document: emptyDocument,
  location: { hostname: 'example.ai', pathname: '/chat', origin: 'https://example.ai' },
  visible,
});
assert.equal(generic.id, 'generic');
assert.match(generic.transportRule(), /FOUR-BACKTICK/);
assert.equal(generic.pacingMode, 'not-applicable');

const composedSource = `(function shunCodeWebMcpComposedAgent(config) {
  const createCore = (${coreSource.trim()});
  const createSiteAdapter = (${siteSource.trim()});
  const agent = (${agentSource.trim()});
  return agent(config, { createCore, createSiteAdapter });
})`;
const composedFactory = vm.runInNewContext(composedSource, {}, { filename: 'webmcp-composed-agent.js' });
assert.equal(typeof composedFactory, 'function', 'extension-side composed source must remain a single callable function expression');

console.log('[smoke] WebMCP Core parser/dedupe/delivery state + Site Adapter + composed source ok');
