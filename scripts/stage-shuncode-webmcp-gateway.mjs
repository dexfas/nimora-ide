import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'tools', 'webmcp-gateway');
const destination = path.join(root, 'extensions', 'shuncode-webmcp', 'gateway');
// Explicit allowlist: never copy local browser profiles, upstream secrets,
// screenshots, project workspaces or incidental files into the extension.
const assets = [
  'server.mjs', 'package.json', 'package-lock.json',
  'arena-agent-bridge.js', 'capability-contract.mjs', 'generic-chat-agent.js',
  'integrated-browser-provider.mjs', 'managed-browser-provider.mjs',
  'mcp-exposure-adapter.mjs', 'personal-edge-provider.mjs',
  'provider-registry.mjs', 'upstream-mcp-provider.mjs', 'webmcp-page-host.mjs', 'canonical-page-assets.mjs',
];

assert.equal(JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')).name,
  'shuncode-browser-mcp-gateway', 'only the explicitly trusted in-repo gateway may be staged');
await mkdir(destination, { recursive: true });
for (const file of assets) await copyFile(path.join(source, file), path.join(destination, file));
const pageRuntime = path.join(destination, 'page-runtime');
await mkdir(pageRuntime, { recursive: true });
for (const file of ['webmcp-page-core.js', 'webmcp-site-adapters.js', 'arena-agent-bridge.js']) {
  await copyFile(path.join(root, 'extensions/shuncode-webmcp', file), path.join(pageRuntime, file));
}

const production = process.argv.includes('--production');
if (production) {
  // Production packaging must provide gateway-local dependencies: release
  // installations cannot rely on the source checkout's node_modules.
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'],
    { cwd: destination, stdio: 'inherit', shell: process.platform === 'win32' });
  assert.equal(result.status, 0, 'gateway production dependencies could not be installed');
}

console.log(`Staged ${assets.length} trusted WebMCP gateway assets in extension-local gateway${production ? ' with production dependencies' : ''}.`);
