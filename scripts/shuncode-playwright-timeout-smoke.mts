import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-playwright-timeout-'));
const bundlePath = path.join(tempDirectory, 'playwright-timeout.cjs');

try {
  await esbuild.build({
    entryPoints: [path.join(root, 'src/vs/platform/browserView/node/playwrightTimeout.ts')],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: ['es2022'],
    logLevel: 'silent',
  });
  const { awaitUntilDeadline, remainingDeadlineMs } = require(bundlePath);

  const neverStarted = Date.now();
  const never = await awaitUntilDeadline(new Promise(() => {}), Date.now() + 30);
  const neverElapsed = Date.now() - neverStarted;
  assert.deepEqual(never, { completed: false });
  assert.ok(neverElapsed < 1000, `never-settling work must return within bounded time; elapsed=${neverElapsed}`);

  const completed = await awaitUntilDeadline(Promise.resolve('CORE_TIMEOUT_OK'), Date.now() + 100);
  assert.deepEqual(completed, { completed: true, value: 'CORE_TIMEOUT_OK' });
  await assert.rejects(
    () => awaitUntilDeadline(Promise.reject(new Error('CORE_REJECTION')), Date.now() + 100),
    /CORE_REJECTION/,
  );
  assert.equal(remainingDeadlineMs(Date.now() - 1), 0);

  const serviceSource = await fs.readFile(path.join(root, 'src/vs/platform/browserView/node/playwrightService.ts'), 'utf8');
  assert.match(serviceSource, /const deadline = timeoutMs === undefined \? undefined : Date\.now\(\) \+ Math\.max\(0, timeoutMs\)/);
  assert.match(serviceSource, /awaitUntilDeadline\(this\._compileFunction\(fnDef\), deadline\)/);
  assert.match(serviceSource, /raceTimeout\(wrappedPromise, remainingDeadlineMs\(deadline\)/);
  assert.match(serviceSource, /awaitUntilDeadline\(this\._getSummary\(pageId\), deadline\)/);
  assert.match(serviceSource, /TIMED_SUMMARY_UNAVAILABLE/);
  assert.match(serviceSource, /Date\.now\(\) \+ Math\.max\(0, timeoutMs\), deferredResultId/);
  const deferralBody = serviceSource.slice(serviceSource.indexOf('private async _runWithDeferral'), serviceSource.indexOf('/**\n\t * Emit completion telemetry'));
  assert.equal(/const summary = await this\._getSummary\(pageId\)/.test(deferralBody), false, 'timed deferral must never perform an unbounded post-timeout summary');

  console.log(JSON.stringify({
    result: 'PASS',
    neverSettlingPromiseBounded: true,
    nonTimeoutCompletionCompatible: true,
    rejectionCompatible: true,
    compileUsesObservableDeadline: true,
    executionUsesRemainingDeadline: true,
    summaryUsesSameDeadline: true,
    deferredWaitUsesFreshObservableDeadline: true,
  }, null, 2));
} finally {
  await fs.rm(tempDirectory, { recursive: true, force: true });
}
