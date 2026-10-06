import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gatewayDir = path.join(root, 'tools', 'webmcp-gateway');
const require = createRequire(path.join(gatewayDir, 'package.json'));
const { chromium } = require('playwright-core');
const siteSource = await readFile(path.join(root, 'extensions', 'shuncode-webmcp', 'webmcp-site-adapters.js'), 'utf8');

const edgeCandidates = [
  process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);
let edgePath = '';
for (const candidate of edgeCandidates) {
  try { await access(candidate); edgePath = candidate; break; } catch {}
}
assert.ok(edgePath, 'Microsoft Edge executable is required');

const browser = await chromium.launch({ executablePath: edgePath, headless: true });
try {
  const page = await browser.newPage();
  await page.route('https://chat.deepseek.com/**', route => route.fulfill({
    status: 200,
    contentType: 'text/html',
    body: '<!doctype html><html><body><main id="messages"></main></body></html>',
  }));
  await page.goto('https://chat.deepseek.com/a/chat/s/semantic-text-fixture', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(source => {
    const createSiteAdapter = (0, eval)(source);
    const site = createSiteAdapter({
      window, document, location,
      visible: element => !!element,
      storage: sessionStorage,
    });

    const plain = document.createElement('div');
    plain.className = 'ds-assistant-message-main-content';
    plain.textContent = 'plain semantic prose';
    document.querySelector('#messages').appendChild(plain);

    const makeCodeBlock = () => {
      const wrapper = document.createElement('div');
      const toolbar = document.createElement('div');
      toolbar.innerHTML = '<span>text</span><button>复制</button><button>下载</button>';
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = '{"version":1,"kind":"nimora-practice-report"}';
      pre.appendChild(code);
      wrapper.append(toolbar, pre);
      return wrapper;
    };

    const codeOnly = document.createElement('div');
    codeOnly.className = 'ds-assistant-message-main-content';
    codeOnly.appendChild(makeCodeBlock());
    document.querySelector('#messages').appendChild(codeOnly);

    const mixed = document.createElement('div');
    mixed.className = 'ds-assistant-message-main-content';
    const intro = document.createElement('p');
    intro.textContent = 'Here is the bounded result:';
    mixed.append(intro, makeCodeBlock());
    document.querySelector('#messages').appendChild(mixed);

    return {
      plain: site.assistantMessageText(plain),
      codeOnly: site.assistantMessageText(codeOnly),
      mixed: site.assistantMessageText(mixed),
    };
  }, siteSource);

  assert.equal(result.plain, 'plain semantic prose');
  assert.equal(result.codeOnly, '{"version":1,"kind":"nimora-practice-report"}');
  assert.match(result.mixed, /Here is the bounded result:/);
  assert.match(result.mixed, /"nimora-practice-report"/);
  assert.doesNotMatch(result.mixed, /复制|下载/);
  console.log('shuncode-webmcp-deepseek-semantic-text-smoke: PASS');
} finally {
  await browser.close();
}
