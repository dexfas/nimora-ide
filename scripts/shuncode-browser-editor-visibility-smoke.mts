import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserEditorPath = path.join(root, 'src/vs/workbench/contrib/browserView/electron-browser/browserEditor.ts');
const rendererPath = path.join(root, 'src/vs/workbench/contrib/browserView/electron-browser/features/webContentsViewRendererFeature.ts');

const [browserEditor, renderer] = await Promise.all([
  readFile(browserEditorPath, 'utf8'),
  readFile(rendererPath, 'utf8'),
]);

const visibilityOverride = browserEditor.match(
  /protected override setEditorVisible\(visible: boolean\): void \{([\s\S]*?)\n\t\}/,
);
assert.ok(visibilityOverride, 'BrowserEditor must own a setEditorVisible lifecycle override');

const body = visibilityOverride[1];
const superIndex = body.indexOf('super.setEditorVisible(visible);');
const contributionIndex = body.indexOf('c.onPaneVisibilityChanged(visible);');
assert.ok(superIndex >= 0, 'BrowserEditor visibility must synchronize the base EditorPane');
assert.ok(contributionIndex >= 0, 'BrowserEditor visibility must notify renderer contributions');
assert.ok(
  superIndex < contributionIndex,
  'base EditorPane visibility must settle before BrowserView renderer contributions observe the change',
);

assert.match(
  renderer,
  /private _shouldShowPage\(\): boolean \{[\s\S]*?return this\._editorVisible[\s\S]*?&& !this\._overlayObscured/,
  'native BrowserView visibility must remain gated by editor-pane visibility',
);
assert.match(
  renderer,
  /onPaneVisibilityChanged\(visible: boolean\): void \{[\s\S]*?this\._editorVisible = visible;[\s\S]*?this\._refresh\(\);/,
  'renderer must refresh native visibility whenever the BrowserEditor pane becomes visible or hidden',
);
assert.match(
  renderer,
  /if \(this\._model && !this\._shouldShowPage\(\)\) \{[\s\S]*?this\._model\.setVisible\(false\)/,
  'hidden BrowserEditor panes must actively hide their native WebContentsView',
);
assert.doesNotMatch(
  browserEditor + renderer,
  /Nimora|shuncode\.nimora/i,
  'browser visibility lifecycle must remain generic and must not special-case Nimora',
);

console.log('PASS shuncode browser editor visibility lifecycle smoke');
