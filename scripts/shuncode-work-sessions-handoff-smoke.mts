import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const bridgeSessionPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'chat', 'browser', 'widgetHosts', 'viewPane', 'shunCodeBridgeSessionView.ts');
const bridgeSessionCssPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'chat', 'browser', 'widgetHosts', 'viewPane', 'media', 'shunCodeBridgeSessionView.css');
const bridgeWidgetPath = path.join(root, 'src', 'vs', 'workbench', 'contrib', 'chat', 'browser', 'aiCustomization', 'shunCodeBridgeWidget.ts');

const [bridgeSessionSource, bridgeSessionCss, bridgeWidgetSource] = await Promise.all([
  fs.readFile(bridgeSessionPath, 'utf8'),
  fs.readFile(bridgeSessionCssPath, 'utf8'),
  fs.readFile(bridgeWidgetPath, 'utf8'),
]);

assert.match(bridgeSessionSource, /const TASK_CENTER_OPEN = 'shuncode\.taskCenter\.open';/);
assert.match(
  bridgeSessionSource,
  /workSessionsButton[\s\S]{0,900}executeCommand\(TASK_CENTER_OPEN\)/,
  'Bridge Session compatibility UI must expose a direct handoff to Task-owned Work Sessions',
);
assert.match(
  bridgeSessionSource,
  /Task progress is tracked in Work Sessions\.[\s\S]{0,300}Bridge remains output-only here/,
  'Bridge Session copy must identify Work Sessions as the Task progress surface',
);
assert.doesNotMatch(bridgeSessionSource, /interface BridgeTodo|renderTodos\(|renderProgress\(|status: 'running' \| 'completed' \| 'error' \| 'progress'/, 'legacy Bridge coordination rendering must be removed after Work Sessions takes over');
assert.doesNotMatch(bridgeSessionCss, /shuncode-bridge-(?:todos|todo|progress)/, 'dead todo/progress Bridge CSS must be removed with the renderer');

assert.match(bridgeWidgetSource, /const TASK_CENTER_OPEN = 'shuncode\.taskCenter\.open';/);
assert.match(
  bridgeWidgetSource,
  /Open Work Sessions[\s\S]{0,300}executeCommand\(TASK_CENTER_OPEN\)/,
  'Bridge configuration/diagnostics UI must expose the same Work Sessions handoff',
);
assert.match(
  bridgeWidgetSource,
  /Open Bridge Session[\s\S]{0,300}executeCommand\(BRIDGE_OPEN_SESSION\)/,
  'Bridge compatibility session entry remains available until rich artifact/tool presentation has migrated',
);

console.log('[smoke] Bridge compatibility surfaces hand off to Task-owned Work Sessions and retain only connection/tool diagnostics');
