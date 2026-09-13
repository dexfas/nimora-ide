import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gatewayDir = path.join(root, 'tools', 'webmcp-gateway');
const require = createRequire(path.join(gatewayDir, 'package.json'));
const { chromium } = require('playwright-core');
const webMcpDir = path.join(root, 'extensions', 'shuncode-webmcp');

const edgeCandidates = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

let edgePath = '';
for (const candidate of edgeCandidates) {
  try {
    await access(candidate);
    edgePath = candidate;
    break;
  } catch {}
}
assert.ok(edgePath, 'Microsoft Edge executable is required for the WebMCP browser smoke');

const [coreSource, siteSource, agentSource] = await Promise.all([
  readFile(path.join(webMcpDir, 'webmcp-page-core.js'), 'utf8'),
  readFile(path.join(webMcpDir, 'webmcp-site-adapters.js'), 'utf8'),
  readFile(path.join(webMcpDir, 'arena-agent-bridge.js'), 'utf8'),
]);

const composedSource = `(function shunCodeWebMcpComposedAgent(config) {
  const createCore = (${coreSource.trim()});
  const createSiteAdapter = (${siteSource.trim()});
  const agent = (${agentSource.trim()});
  return agent(config, { createCore, createSiteAdapter });
})`;

const html = `<!doctype html>
<html>
  <body>
    <main id="messages"></main>
    <form id="composer-form">
      <textarea aria-label="Ask anything"></textarea>
      <button type="submit" aria-label="Send">Send</button>
    </form>
    <script>
      window.__submittedMessages = [];
      const form = document.getElementById('composer-form');
      const composer = form.querySelector('textarea');
      form.addEventListener('submit', event => {
        event.preventDefault();
        const text = composer.value;
        window.__submittedMessages.push(text);
        const message = document.createElement('div');
        message.className = 'user-message';
        message.textContent = text;
        document.getElementById('messages').appendChild(message);
        composer.value = '';
        composer.dispatchEvent(new Event('input', { bubbles: true }));
      });
    </script>
  </body>
</html>`;

const browser = await chromium.launch({ executablePath: edgePath, headless: true });
let invokeCount = 0;
let lastInvoke = null;

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('https://chat.deepseek.com/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/localbridge/webmcp/tools') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          tools: [{
            name: 'read_files',
            description: 'Read files',
            inputSchema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] },
          }],
        }),
      });
      return;
    }
    if (url.pathname === '/localbridge/webmcp/invoke') {
      invokeCount += 1;
      lastInvoke = request.postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, result: { content: [{ type: 'text', text: 'SYNTHETIC_READ_OK' }] } }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });

  await page.goto('https://chat.deepseek.com/chat', { waitUntil: 'domcontentloaded' });
  const status = await page.evaluate(({ source }) => {
    const factory = (0, eval)(source);
    return factory({ bridge: 'https://chat.deepseek.com/localbridge', token: 'synthetic-token' });
  }, { source: composedSource });
  assert.equal(status.version, 25);
  assert.equal(status.coreVersion, 1);
  assert.equal(status.siteAdapter, 'deepseek');
  assert.equal(status.isDeepSeek, true);

  const prime = await page.evaluate(async () => await window.__shuncodeWebMcp.prime());
  assert.equal(prime.ok, true);
  assert.equal(prime.toolCount, 1);

  await page.evaluate(() => {
    const response = document.createElement('div');
    response.className = 'ds-assistant-message-main-content';
    response.innerText = `[SHUNCODE_TOOL]\nid=synthetic-call-1\nname=read_files\narg.files.0.path=README.md\n[/SHUNCODE_TOOL]`;
    document.getElementById('messages').appendChild(response);
  });

  await page.waitForFunction(() => window.__submittedMessages.some(text => text.includes('[SHUNCODE_TOOL_RESULT]') && text.includes('SYNTHETIC_READ_OK')), null, { timeout: 10000 });
  await page.waitForFunction(() => window.__shuncodeWebMcp?.status?.().pendingDeliveries === 0, null, { timeout: 10000 });
  assert.equal(invokeCount, 1);
  assert.equal(lastInvoke.name, 'read_files');
  assert.equal(lastInvoke.arguments.files[0].path, 'README.md');
  assert.equal(lastInvoke.page.origin, 'https://chat.deepseek.com');

  const afterDelivery = await page.evaluate(() => window.__shuncodeWebMcp.status());
  assert.equal(afterDelivery.pendingDeliveries, 0);
  assert.equal(afterDelivery.seen, 1);

  await page.evaluate(() => {
    document.getElementById('messages').appendChild(document.createTextNode('mutation-after-delivery'));
    window.__shuncodeWebMcp.scan();
  });
  await page.waitForTimeout(700);
  assert.equal(invokeCount, 1, 'repeated DOM scans must never re-run a completed tool occurrence');

  const submitted = await page.evaluate(() => [...window.__submittedMessages]);
  assert.ok(submitted[0].includes('SHUNCODE_WEBMCP_CONTEXT_V25'));
  assert.match(submitted[0], /DEEPSEEK TRANSPORT RULE/);
  assert.ok(submitted.some(text => text.includes('SYNTHETIC_READ_OK')));

  await context.close();

  const bindingContext = await browser.newContext();
  const bindingPage = await bindingContext.newPage();
  const bindingListName = '__shuncodeListTools_smoke';
  const bindingInvokeName = '__shuncodeInvokeTool_smoke';
  let bindingInvokeCount = 0;
  let bindingInvokeArgs = null;
  await bindingPage.exposeFunction(bindingListName, async token => {
    assert.equal(token, 'binding-token');
    return [{
      name: 'read_files',
      description: 'Read files',
      inputSchema: { type: 'object', properties: { files: { type: 'array' } }, required: ['files'] },
    }];
  });
  await bindingPage.exposeFunction(bindingInvokeName, async (token, name, args) => {
    assert.equal(token, 'binding-token');
    bindingInvokeCount += 1;
    bindingInvokeArgs = { name, args };
    return { content: [{ type: 'text', text: 'BINDING_READ_OK' }] };
  });
  await bindingPage.route('https://chat.deepseek.com/**', async route => {
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await bindingPage.goto('https://chat.deepseek.com/chat', { waitUntil: 'domcontentloaded' });
  const bindingStatus = await bindingPage.evaluate(({ source, listBinding, invokeBinding }) => {
    const factory = (0, eval)(source);
    return factory({ token: 'binding-token', listBinding, invokeBinding });
  }, { source: composedSource, listBinding: bindingListName, invokeBinding: bindingInvokeName });
  assert.equal(bindingStatus.version, 25);
  assert.equal(bindingStatus.siteAdapter, 'deepseek');
  assert.equal(bindingStatus.transport, 'binding');
  const bindingPrime = await bindingPage.evaluate(async () => await window.__shuncodeWebMcp.prime());
  assert.equal(bindingPrime.toolCount, 1);
  await bindingPage.evaluate(() => {
    const response = document.createElement('div');
    response.className = 'ds-assistant-message-main-content';
    response.innerText = `[SHUNCODE_TOOL]\nid=binding-call-1\nname=read_files\narg.files.0.path=README.md\n[/SHUNCODE_TOOL]`;
    document.getElementById('messages').appendChild(response);
  });
  await bindingPage.waitForFunction(() => window.__submittedMessages.some(text => text.includes('[SHUNCODE_TOOL_RESULT]') && text.includes('BINDING_READ_OK')), null, { timeout: 10000 });
  await bindingPage.waitForFunction(() => window.__shuncodeWebMcp?.status?.().pendingDeliveries === 0, null, { timeout: 10000 });
  assert.equal(bindingInvokeCount, 1);
  assert.equal(bindingInvokeArgs.name, 'read_files');
  assert.equal(bindingInvokeArgs.args.files[0].path, 'README.md');
  await bindingContext.close();

  console.log('[smoke] WebMCP v25 synthetic DeepSeek HTTP+binding roundtrip/dedupe/result delivery ok');
} finally {
  await browser.close();
}
