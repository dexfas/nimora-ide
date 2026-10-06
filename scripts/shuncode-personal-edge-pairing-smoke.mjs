import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
const root = path.resolve(import.meta.dirname, '..');
const local = new Map([['shuncodeEdgeClientId', 'client'], ['shuncodeSharedTabId', 999]]), session = new Map();
const area = store => ({ get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, store.get(key)])),
  set: async values => { for (const [key, value] of Object.entries(values)) store.set(key, value); }, remove: async key => { store.delete(key); } });
const listeners = new Map(), posts = [];
const event = name => ({ addListener: fn => listeners.set(name, fn), removeListener() {} });
let injected = 0, getTab = async id => ({ id, url: 'https://example.test', status: 'complete' });
const chrome = { storage: { local: area(local), session: area(session), onChanged: event('storage') },
  action: { onClicked: event('click'), setBadgeText: async () => {}, setTitle: async () => {} },
  tabs: { get: id => getTab(id), onRemoved: event('remove'), onUpdated: event('updated') },
  alarms: { onAlarm: event('alarm'), create: async () => {} }, runtime: { openOptionsPage: async () => {} },
  scripting: { executeScript: async request => { injected++; assert.equal(request.target.tabId, 7); return [{ result: { filled: true } }]; } } };
const fetch = async (url, request) => { posts.push({ url, body: request?.body ? JSON.parse(request.body) : undefined }); return { ok: true, json: async () => ({ ok: true }) }; };
const context = vm.createContext({ chrome, fetch, crypto: { randomUUID: () => 'generated-client' }, setTimeout, clearTimeout, URL, AbortSignal });
vm.runInContext(await readFile(path.join(root, 'extensions/shuncode-personal-edge-bridge/background.js'), 'utf8'), context);
await new Promise(resolve => setImmediate(resolve));
assert.equal(vm.runInContext('sharedTabId', context), null, 'legacy local shared-tab state cannot silently restore consent');
assert.equal(posts.length, 0, 'unpaired background sends no requests');
local.set('shuncodeEdgePairingV1', { endpoint: 'http://127.0.0.1:1234', token: 'a'.repeat(43) });
await vm.runInContext('loadPairing()', context);
vm.runInContext('sharedTabId = 7', context);
let resolveTab;
getTab = () => new Promise(resolve => { resolveTab = resolve; });
const pending = vm.runInContext('executeCommand({id:"old",tabId:7,op:"fill",selector:"#name",value:"once"})', context);
vm.runInContext('sharedTabId = 8; shareGeneration++', context);
resolveTab({ id: 7, url: 'https://example.test' }); await pending;
assert.equal(injected, 0, 'share drift during asynchronous tab lookup blocks DOM mutation');
assert.match(posts.at(-1).body.error, /changed/);
getTab = async id => ({ id, url: 'https://example.test', status: 'complete' });
vm.runInContext('sharedTabId = 7; shareGeneration++', context);
await vm.runInContext('executeCommand({id:"new",tabId:7,op:"fill",selector:"#name",value:"once"})', context);
assert.equal(injected, 1); assert.equal(posts.at(-1).body.result.filled, true);

const elements = new Map(['status', 'pair', 'endpoint', 'token', 'forget'].map(key => [key, { value: '', textContent: '', addEventListener: (name, fn) => listeners.set(`${key}:${name}`, fn) }]));
const options = vm.createContext({ chrome, fetch, document: { querySelector: selector => elements.get(selector.slice(1)) }, crypto: { randomUUID: () => 'generated-client' }, URL, AbortSignal });
vm.runInContext(await readFile(path.join(root, 'extensions/shuncode-personal-edge-bridge/options.js'), 'utf8'), options);
await new Promise(resolve => setImmediate(resolve));
elements.get('endpoint').value = 'https://outside.example'; elements.get('token').value = 'b'.repeat(43);
const before = posts.length; await listeners.get('pair:submit')({ preventDefault() {} }); assert.equal(posts.length, before);
elements.get('endpoint').value = 'http://127.0.0.1:1234'; session.set('shuncodeSharedTabId', 7);
await listeners.get('pair:submit')({ preventDefault() {} });
assert.equal(posts.at(-1).body.shared, false); assert.equal(session.has('shuncodeSharedTabId'), false);
assert.equal(elements.get('token').value, ''); assert.equal(local.get('shuncodeEdgePairingV1').token.length, 43);
await listeners.get('forget:click')(); assert.equal(local.has('shuncodeEdgePairingV1'), false); assert.equal(posts.at(-1).body.shared, false);
assert.doesNotMatch(elements.get('status').textContent, /bbbb/);
console.log('Personal Edge pairing PASS: private local pairing, strict loopback endpoint, no implicit restart sharing, asynchronous share drift blocks side effects, exact tab dispatch, unpair revokes consent.');
