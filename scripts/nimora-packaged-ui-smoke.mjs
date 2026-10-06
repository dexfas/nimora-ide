import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const manifestPath = path.resolve(process.argv[2]);
const manifest = JSON.parse((await fs.readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
const extension = path.join(path.dirname(manifest.executable), 'resources/app/extensions/shuncode/dist/extension.js');
async function evaluate(expression) {
  const targets = await (await fetch(`http://127.0.0.1:${manifest.inspector}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
  assert.equal(targets.length, 1, 'exact isolated Extension Host required');
  assert.equal(targets[0].type, 'node');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
    const timer = setTimeout(() => { socket.close(); reject(Error('Public command observation timeout')); }, 15000);
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('open', () => socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })));
    socket.on('message', data => {
      const response = JSON.parse(String(data)); if (response.id !== 1) return;
      clearTimeout(timer); socket.close();
      if (response.error || response.result?.exceptionDetails) reject(Error('Public command failed'));
      else resolve(response.result.result.value);
    });
  });
}
const prefix = `if(process.execPath.toLowerCase()!==${JSON.stringify(manifest.executable.toLowerCase())})throw Error('Wrong package');const v=process.getBuiltinModule('module').createRequire(${JSON.stringify(extension)})('vscode');`;
let ready = false;
for (let attempt = 0; attempt < 60; attempt++) {
  try {
    ready = await evaluate(`(async()=>{${prefix}return (await v.commands.getCommands(true)).includes('shuncode.nimora.open');})()`);
    if (ready) break;
  } catch { /* bounded read-only activation observation */ }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
assert.ok(ready, 'first-party extension must activate in the packaged desktop');
await evaluate(`(async()=>{${prefix}await v.commands.executeCommand('shuncode.nimora.open');return true;})()`);
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${manifest.renderer}`);
try {
  let frame;
  for (let attempt = 0; attempt < 50 && !frame; attempt++) {
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      for (const candidate of page.frames()) {
        if (await candidate.locator('#empty-projects-title').count().catch(() => 0)) { frame = candidate; break; }
      }
      if (frame) break;
    }
    if (!frame) await new Promise(resolve => setTimeout(resolve, 300));
  }
  assert.ok(frame, 'real packaged Product Shell Webview must render first-use onboarding');
  assert.match(await frame.locator('main').innerText(), /从一个真实目标开始/);
  assert.equal(await frame.locator('[data-action="openWorkspace"]').count(), 1);
  await frame.locator('[data-action="selectView"][data-view="connections"]').first().click();
  // Refresh replaces the Webview document. Re-resolve its frame before reading.
  let resources;
  for (let attempt = 0; attempt < 50 && !resources; attempt++) {
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      for (const candidate of page.frames()) {
        if (await candidate.locator('h1').filter({ hasText: 'AI 资源' }).count().catch(() => 0)) { resources = candidate; break; }
      }
    }
    if (!resources) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(resources, 'packaged navigation must reach AI resource setup');
  assert.match(await resources.locator('main').innerText(), /首次使用：选择一种 AI 即可/);
  await resources.evaluate(() => window.scrollTo(0, 350));
  await resources.waitForFunction(() => window.scrollY > 300);
  await new Promise(resolve => setTimeout(resolve, 100));
  await evaluate(`(async()=>{${prefix}await v.commands.executeCommand('shuncode.nimora.open');return true;})()`);
  let restored = false;
  for (let attempt = 0; attempt < 40 && !restored; attempt++) {
    for (const page of browser.contexts().flatMap(context => context.pages())) {
      for (const candidate of page.frames()) {
        if (await candidate.locator('h1').filter({ hasText: 'AI 资源' }).count().catch(() => 0)
          && await candidate.evaluate(() => window.scrollY > 300).catch(() => false)) { resources = candidate; restored = true; break; }
      }
    }
    if (!restored) await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(restored, 'real VS Code Webview state must retain reading position after host re-render');
  await resources.page().screenshot({ path: path.join(path.dirname(manifestPath), 'packaged-ui.png') });
  const state = await evaluate(`(async()=>{${prefix}const s=await v.commands.executeCommand('shuncode.taskCenter.getState');return {taskCount:s.tasks.length,workspaceCount:v.workspace.workspaceFolders?.length??0};})()`);
  assert.equal(state.taskCount, 0, 'UI smoke must not create a Mission or send model requests');
  const report = { result: 'PASS', executable: manifest.executable, packagedExtensionActivated: true,
    realPackagedWebview: true, onboardingAndResourcesNavigation: true, nativeWebviewReadingPositionRestored: true, taskCount: state.taskCount,
    workspaceCount: state.workspaceCount, usedExistingProfile: false, modelRequestSent: false, nativeAuthorizationClicked: false };
  await fs.writeFile(path.join(path.dirname(manifestPath), 'packaged-ui-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close(); // Disconnect from CDP; leave the user's new preview window open.
}
