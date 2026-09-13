import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const bridgeSessionPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'chat', 'browser', 'widgetHosts', 'viewPane', 'shunCodeBridgeSessionView.ts');
const bridgeSessionCssPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'chat', 'browser', 'widgetHosts', 'viewPane', 'media', 'shunCodeBridgeSessionView.css');
const bridgeWidgetPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'chat', 'browser', 'aiCustomization', 'shunCodeBridgeWidget.ts');
const extensionPath = path.join(root, 'extensions', 'shuncode', 'src', 'extension.ts');
const chatViewPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'chat', 'browser', 'widgetHosts', 'viewPane', 'chatViewPane.ts');
const chatActionsPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'chat', 'browser', 'actions', 'chatActions.ts');
const chatContextKeysPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'chat', 'common', 'actions', 'chatContextKeys.ts');
const packagePath = path.join(root, 'extensions', 'shuncode', 'package.json');

const [bridgeWidgetSource, extensionSource, chatViewSource, chatActionsSource, chatContextKeysSource, extensionPackageText] = await Promise.all([
  fs.readFile(bridgeWidgetPath, 'utf8'),
  fs.readFile(extensionPath, 'utf8'),
  fs.readFile(chatViewPath, 'utf8'),
  fs.readFile(chatActionsPath, 'utf8'),
  fs.readFile(chatContextKeysPath, 'utf8'),
  fs.readFile(packagePath, 'utf8'),
]);

await assert.rejects(fs.access(bridgeSessionPath), { code: 'ENOENT' }, 'legacy Bridge Session view must be deleted after all rich presentation migrates');
await assert.rejects(fs.access(bridgeSessionCssPath), { code: 'ENOENT' }, 'legacy Bridge Session stylesheet must be deleted with the view');

assert.match(
  extensionSource,
  /registerCommand\("shuncode\.bridge\.openView"[\s\S]{0,220}executeCommand\("aiCustomization\.openManagementEditor", "bridge"\)/,
  'first-party Bridge navigation must deep-link to the native AI Customization Bridge section',
);

assert.match(bridgeWidgetSource, /const TASK_CENTER_OPEN = 'shuncode\.taskCenter\.open';/);
assert.match(bridgeWidgetSource, /const BRIDGE_START = 'shuncode\.bridge\.start';/);
assert.match(bridgeWidgetSource, /const BRIDGE_STOP = 'shuncode\.bridge\.stop';/);
assert.match(bridgeWidgetSource, /const BRIDGE_CHECK_HEALTH = 'shuncode\.bridge\.checkHealth';/);
assert.match(bridgeWidgetSource, /startStopButton[\s\S]{0,300}toggleBridge\(\)/, 'Bridge Settings remains the owner of start/stop controls');
assert.match(bridgeWidgetSource, /MCP health[\s\S]{0,1200}healthButton[\s\S]{0,500}checkHealth\(\)/, 'Bridge Settings must own end-to-end MCP health diagnostics');
assert.match(
  bridgeWidgetSource,
  /Open Work Sessions[\s\S]{0,300}executeCommand\(TASK_CENTER_OPEN\)/,
  'Bridge configuration/diagnostics UI must expose the same Work Sessions handoff',
);
assert.doesNotMatch(bridgeWidgetSource, /BRIDGE_OPEN_SESSION|Open Bridge Session/, 'Bridge Settings must not link back to a deleted compatibility session');
assert.doesNotMatch(extensionSource, /shuncode\.bridge\.openSession|_shuncode\.bridge\.showSession/, 'first-party extension must not register the deleted Bridge Session entry');
assert.doesNotMatch(chatViewSource, /ShunCodeBridgeSessionView|bridgeMode|_shuncode\.bridge\.showSession|_shuncode\.bridge\.showChat|shuncode-bridge-mode/, 'ChatViewPane must have no Bridge mode or compatibility view wiring');
assert.doesNotMatch(chatActionsSource, /openShunCodeBridgeSession|returnFromShunCodeBridgeSession|shuncode\.bridge\.openSession|_shuncode\.bridge\.showChat/, 'Chat title actions must not expose Bridge mode switching');
assert.doesNotMatch(chatContextKeysSource, /shunCodeBridgeMode|shuncodeBridgeMode/, 'Chat context keys must not retain a dead Bridge mode flag');

const extensionPackage = JSON.parse(extensionPackageText);
assert.ok(!extensionPackage.activationEvents.includes('onCommand:shuncode.bridge.openSession'));
assert.ok(!extensionPackage.contributes.commands.some((item: { command: string }) => item.command === 'shuncode.bridge.openSession'));

console.log('[smoke] legacy Bridge Session removed; Work Sessions and Bridge Settings own the migrated surfaces');
