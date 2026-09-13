import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-host-capability-policy-'));
const bundlePath = path.join(bundleDirectory, 'host-capability-policy.mjs');

await esbuild.build({
  stdin: {
    contents: `
      export { CapabilityMetadataHostAuthorizer } from './src/host-capability-policy-authorizer.ts';
      export { getCapabilityMetadata } from './src/capability-registry.ts';
      export { IdeToolBrokerHostCapabilityExecutor } from './extensions/shuncode/src/ide-host-capability-executor.ts';
    `,
    resolveDir: root,
    sourcefile: 'host-capability-policy-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['es2022'],
  logLevel: 'silent',
});

const { CapabilityMetadataHostAuthorizer, getCapabilityMetadata, IdeToolBrokerHostCapabilityExecutor } = await import(`${pathToFileURL(bundlePath).href}?v=${Date.now()}`);
const request = (name) => ({ executionId: `exec-${name}`, managedSessionId: 'managed-1', workerId: 'nimora.web-worker', taskId: 'task-1', inputId: 'turn-1', callId: `call-${name}`, name, arguments: {} });

try {
  const authorizer = new CapabilityMetadataHostAuthorizer();
  await authorizer.authorize(request('list_directory'), getCapabilityMetadata('list_directory'));
  await assert.rejects(() => authorizer.authorize(request('run_command'), getCapabilityMetadata('run_command')), /requires session approval/);

  let grantChecks = 0;
  const granted = new CapabilityMetadataHostAuthorizer({
    async isGranted(_request, capability) {
      grantChecks += 1;
      return capability.id === 'terminal.run-command';
    },
  });
  await granted.authorize(request('run_command'), getCapabilityMetadata('run_command'));
  assert.equal(grantChecks, 1);

  const denied = new CapabilityMetadataHostAuthorizer({ async isGranted() { return false; } });
  await assert.rejects(() => denied.authorize(request('run_command'), getCapabilityMetadata('run_command')), /was not granted/);

  const calls = [];
  const executor = new IdeToolBrokerHostCapabilityExecutor({
    async invokeDirect(name, args) {
      calls.push({ name, args });
      return { text: `BROKER:${name}`, isError: false };
    },
  });
  const listResult = await executor.execute({ ...request('list_directory'), arguments: { path: '.' } }, getCapabilityMetadata('list_directory'));
  assert.equal(listResult.text, 'BROKER:list_directory');
  assert.deepEqual(calls, [{ name: 'list_directory', args: { path: '.' } }]);
  await assert.rejects(() => executor.execute(request('read_files'), getCapabilityMetadata('read_files')), /not owned by IdeToolBroker/);

  console.log('[smoke] host capability metadata authorization + IdeToolBroker executor boundary ok');
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
