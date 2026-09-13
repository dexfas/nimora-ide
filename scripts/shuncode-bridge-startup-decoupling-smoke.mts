import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const extensionSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'extension.ts'), 'utf8');
const chatViewSource = await fs.readFile(path.join(root, 'src', 'vs', 'workbench', 'contrib', 'chat', 'browser', 'widgetHosts', 'viewPane', 'chatViewPane.ts'), 'utf8');
const bridgeWidgetSource = await fs.readFile(path.join(root, 'src', 'vs', 'workbench', 'contrib', 'chat', 'browser', 'aiCustomization', 'shunCodeBridgeWidget.ts'), 'utf8');

assert.match(
  extensionSource,
  /registerCommand\("shuncode\.bridge\.start"[\s\S]{0,350}return bridgeAccess\.start\(domain as string \| undefined\)/,
  'Bridge start command must own only Bridge startup',
);
assert.doesNotMatch(
  extensionSource,
  /registerCommand\("shuncode\.bridge\.start"[\s\S]{0,450}workbench\.action\.chat\.open/,
  'Bridge start must not open Chat as a side effect',
);
assert.match(
  extensionSource,
  /get<boolean>\("persistentMode", false\)[\s\S]{0,500}Promise\.all\(\[bridgeReady, bridgeLicenseReady\]\)\.then\(\(\) => bridgeAccess\.start\(\)\)/,
  'Persistent Bridge mode must start directly from the extension after dependencies are ready',
);
assert.match(extensionSource, /persistent Bridge startup enabled; starting Bridge without opening Chat/);
assert.doesNotMatch(
  extensionSource,
  /get<boolean>\("persistentMode", false\)[\s\S]{0,700}executeCommand\("workbench\.action\.chat\.open"\)/,
  'Persistent startup must not use Chat as a bootstrapping surface',
);
assert.doesNotMatch(extensionSource, /shuncode\.bridge\.openSession|_shuncode\.bridge\.showSession/, 'Bridge startup must not retain the deleted legacy Chat Session entry');

assert.doesNotMatch(chatViewSource, /persistentBridgeStartupScheduled/);
assert.doesNotMatch(chatViewSource, /schedulePersistentBridgeStartup/);
assert.doesNotMatch(chatViewSource, /shuncode\.bridge\.persistentMode/, 'Chat Core must no longer know about Bridge startup configuration');
assert.doesNotMatch(chatViewSource, /bridgeMode|ShunCodeBridgeSessionView|_shuncode\.bridge\.showSession/, 'Chat Core must no longer know about a Bridge display mode');

assert.match(bridgeWidgetSource, /Start Bridge after the app is ready without opening Chat\./);
assert.match(bridgeWidgetSource, /Bridge will start automatically after restart without opening Chat/);

console.log('[smoke] Bridge automatic startup is extension-owned and no longer bootstraps through Chat Core');
