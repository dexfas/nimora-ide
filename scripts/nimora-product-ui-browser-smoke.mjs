import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

// Render only the isolated fixtures emitted by the real Product Shell host
// test. No account, Provider request or production user profile is opened.
const directory = path.resolve(process.argv[2] ?? '.build/nimora-ui-closeout-20261007/preview');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const width of [1440, 900, 390]) {
    for (const theme of ['dark', 'light']) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, reducedMotion: 'reduce' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(() => {
        window.__messages = [];
        let state = JSON.parse(sessionStorage.getItem('nimora-ui-fixture-state') || '{}');
        window.acquireVsCodeApi = () => ({
          postMessage: message => window.__messages.push(message),
          getState: () => state,
          setState: value => { state = value; sessionStorage.setItem('nimora-ui-fixture-state', JSON.stringify(value)); },
        });
      });
      const applyTheme = () => page.evaluate(theme => {
          const dark = theme === 'dark';
          const variables = {
            'editor-background': dark ? '#181b22' : '#ffffff', 'editor-foreground': dark ? '#e5e8ef' : '#202530',
            'descriptionForeground': dark ? '#a4abba' : '#596270', 'panel-border': dark ? '#343945' : '#d6dce5',
            'sideBar-background': dark ? '#21252e' : '#f3f5f8', 'button-background': '#176bd1', 'button-foreground': '#ffffff',
            'list-hoverBackground': dark ? '#303642' : '#e7edf5', 'editorWarning-foreground': dark ? '#eebd67' : '#845100',
            'focusBorder': '#2684ff', 'testing-iconPassed': dark ? '#47c989' : '#187c49',
            'input-background': dark ? '#181b22' : '#ffffff', 'input-foreground': dark ? '#e5e8ef' : '#202530',
            'textLink-foreground': dark ? '#7bb4ff' : '#145dab', 'editorInfo-foreground': '#2684ff',
            'list-activeSelectionBackground': dark ? '#283e59' : '#dceaff', 'list-activeSelectionForeground': dark ? '#ffffff' : '#182b49',
            'font-family': '"Segoe UI", "Microsoft YaHei", sans-serif',
          };
          for (const [key, value] of Object.entries(variables)) document.documentElement.style.setProperty('--vscode-' + key, value);
      }, theme);
      for (const name of ['empty', 'connections', 'ready-work', 'running-work', 'completed-work', 'projects', 'degraded', 'action-error']) {
        await page.goto(pathToFileURL(path.join(directory, name + '.html')).href);
        await applyTheme();
        const metrics = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, hasMain: !!document.querySelector('main') }));
        assert.equal(metrics.hasMain, true, name);
        assert.ok(metrics.scrollWidth <= width + 2, `${name}/${theme}/${width} has horizontal overflow: ${metrics.scrollWidth}`);
        if (name === 'connections') {
          const configure = page.locator('[data-action="configureResources"]').first();
          await configure.click();
          assert.equal(await configure.isDisabled(), true, 'executing buttons stay disabled until host settlement');
          const before = await page.evaluate(() => window.__messages.length);
          await page.locator('[data-action="selectView"][data-view="settings"]').click();
          assert.equal(await page.evaluate(() => window.__messages.length), before + 1, 'navigation still works');
          await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'nimoraActionState', busy: false } })));
          assert.equal(await configure.isDisabled(), false, 'settlement re-enables buttons');
          assert.equal(await page.locator('#action-feedback').textContent(), '');
        }
        if (name === 'action-error') assert.match(await page.locator('#action-feedback').textContent(), /UI_TEST_FAILURE <\/script>/);
        if (name === 'connections' && width === 390) {
          const details = page.locator('details').last();
          await details.evaluate(element => { element.open = true; });
          await page.evaluate(() => window.scrollTo(0, 350));
          await page.waitForFunction(() => JSON.parse(sessionStorage.getItem('nimora-ui-fixture-state') || '{}').readingPosition?.scrollY > 300);
          await page.reload();
          await applyTheme();
          await page.waitForFunction(() => window.scrollY > 300);
          assert.equal(await details.evaluate(element => element.open), true, 'auto-render must preserve expanded diagnostics and reading position');
        }
        await page.screenshot({ path: path.join(directory, `${name}-${theme}-${width}.png`) });
        results.push({ name, theme, ...metrics });
      }
      assert.deepEqual(errors, [], 'rendered client JavaScript must not throw');
      await page.close();
    }
  }
  await fs.writeFile(path.join(directory, 'browser-report.json'), JSON.stringify({ result: 'PASS', cases: results, realProviderCalls: 0 }, null, 2));
  console.log(`PASS ${results.length} real-browser UI renders, dark/light, narrow/desktop, pending/settlement/navigation/error feedback; no Provider calls`);
} finally {
  await browser.close();
}
