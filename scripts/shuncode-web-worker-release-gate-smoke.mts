import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-web-worker-release-gate-'));
const bundlePath = path.join(bundleDirectory, 'release-gate-smoke.cjs');

await esbuild.build({
  stdin: {
    contents: `export { resolveWebWorkerReleaseGate, applyWebWorkerReleaseGate } from './src/web-worker-release-gate.ts';`,
    resolveDir: root,
    sourcefile: 'web-worker-release-gate-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});

try {
  const { resolveWebWorkerReleaseGate, applyWebWorkerReleaseGate } = require(bundlePath);
  const extensionManifest = JSON.parse(await fs.readFile(path.join(root, 'extensions', 'shuncode', 'package.json'), 'utf8'));
  const releaseSetting = extensionManifest.contributes?.configuration?.properties?.['shuncode.webWorker.hostManagedCapabilities'];
  assert.equal(releaseSetting?.type, 'boolean');
  assert.equal(releaseSetting?.default, false, 'release gate must remain disabled by default');
  assert.equal(releaseSetting?.scope, 'application', 'workspace files must not be able to opt the user into host-managed ownership');
  assert.ok(extensionManifest.contributes?.commands?.some(command => command.command === 'shuncode.webWorker.releaseStatus'));
  assert.ok(extensionManifest.activationEvents?.includes('onCommand:shuncode.webWorker.releaseStatus'));

  const disabled = resolveWebWorkerReleaseGate(false, true);
  assert.deepEqual(disabled, {
    configured: false,
    workspaceTrusted: true,
    effective: false,
    ownership: 'page-local',
    reason: 'disabled',
  });

  const untrusted = resolveWebWorkerReleaseGate(true, false);
  assert.deepEqual(untrusted, {
    configured: true,
    workspaceTrusted: false,
    effective: false,
    ownership: 'page-local',
    reason: 'untrusted-workspace',
  });

  const enabled = resolveWebWorkerReleaseGate(true, true);
  assert.deepEqual(enabled, {
    configured: true,
    workspaceTrusted: true,
    effective: true,
    ownership: 'host-managed',
  });

  const baseInput = {
    inputId: 'release-turn',
    prompt: 'continue task',
    extensions: { hostManagedCapabilities: true, callerMarker: 'preserved' },
  };
  const forcedFallback = applyWebWorkerReleaseGate(baseInput, disabled);
  assert.equal(forcedFallback.extensions.hostManagedCapabilities, false, 'caller must not bypass a disabled release gate');
  assert.equal(forcedFallback.extensions.callerMarker, 'preserved');
  assert.deepEqual(forcedFallback.extensions.releaseGate, {
    configured: false,
    workspaceTrusted: true,
    ownership: 'page-local',
  });

  const forcedUntrustedFallback = applyWebWorkerReleaseGate({
    ...baseInput,
    extensions: { hostManagedCapabilities: true },
  }, untrusted);
  assert.equal(forcedUntrustedFallback.extensions.hostManagedCapabilities, false, 'untrusted workspace must force page-local ownership');

  const enabledInput = applyWebWorkerReleaseGate({
    ...baseInput,
    extensions: { hostManagedCapabilities: false },
  }, enabled);
  assert.equal(enabledInput.extensions.hostManagedCapabilities, true, 'trusted enabled gate must be authoritative even if caller requested page-local');
  assert.deepEqual(enabledInput.extensions.releaseGate, {
    configured: true,
    workspaceTrusted: true,
    ownership: 'host-managed',
  });

  console.log('[smoke] Web Worker release gate default/trust/authoritative ownership ok');
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
