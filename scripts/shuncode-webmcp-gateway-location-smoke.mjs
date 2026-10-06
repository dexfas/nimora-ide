import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'extensions', 'shuncode-webmcp');
const { findExtensionGatewayDirectory } = createRequire(import.meta.url)(path.join(extensionDirectory, 'gateway-location.js'));
const staging = path.join(extensionDirectory, 'gateway');
if (process.argv.includes('--production-dependencies')) {
  const localRequire = createRequire(path.join(staging, 'package.json'));
  const manifest = JSON.parse(await readFile(path.join(staging, 'package.json'), 'utf8'));
  for (const dependency of Object.keys(manifest.dependencies)) {
    const entry = dependency === '@modelcontextprotocol/sdk' ? dependency + '/client/index.js' : dependency;
    assert.ok(localRequire.resolve(entry).startsWith(path.join(staging, 'node_modules') + path.sep),
      `production gateway must own ${dependency}, not borrow checkout dependencies`);
  }
}
const fixture = await mkdtemp(path.join(os.tmpdir(), 'nimora-workspace-independent-gateway-'));
let gateway;
try {
  const workspace = path.join(fixture, 'user-owned-project');
  await mkdir(path.join(workspace, 'ShunCode-Browser-MCP'), { recursive: true });
  await writeFile(path.join(workspace, 'ShunCode-Browser-MCP', 'server.mjs'), 'throw new Error("user project must not execute");');
  assert.equal(findExtensionGatewayDirectory(extensionDirectory), staging,
    'extension-owned packaged gateway takes priority over any workspace content');
  assert.equal(findExtensionGatewayDirectory(workspace), null,
    'arbitrary project directories never become executable gateway roots');
  const stagedFiles = await readdir(staging);
  for (const secretOrRuntime of ['browser-profile', 'screenshots', '.env']) {
    assert.equal(stagedFiles.includes(secretOrRuntime), false, `staging must not include ${secretOrRuntime}`);
  }
  assert.equal(JSON.parse(await readFile(path.join(staging, 'package.json'), 'utf8')).name,
    'shuncode-browser-mcp-gateway');
  const fallbackRoot = path.join(fixture, 'checkout');
  const fallbackExtension = path.join(fallbackRoot, 'extensions', 'shuncode-webmcp');
  const fallbackGateway = path.join(fallbackRoot, 'tools', 'webmcp-gateway');
  await mkdir(fallbackExtension, { recursive: true });
  await mkdir(fallbackGateway, { recursive: true });
  await writeFile(path.join(fallbackGateway, 'package.json'), JSON.stringify({ name: 'shuncode-browser-mcp-gateway' }));
  for (const file of ['server.mjs', 'integrated-browser-provider.mjs', 'webmcp-page-host.mjs']) await writeFile(path.join(fallbackGateway, file), '');
  assert.equal(findExtensionGatewayDirectory(fallbackExtension), fallbackGateway,
    'only a structurally verified repository checkout supports the source fallback');

  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  let errors = '';
  gateway = spawn(process.execPath, ['server.mjs'], {
    cwd: staging,
    env: { ...process.env, PORT: String(port), SHUNCODE_INTEGRATED_BROWSER_BRIDGE: 'http://127.0.0.1:1',
      BROWSER_PROFILE: path.join(fixture, 'browser-profile'),
      SHUNCODE_WEBMCP_SCREENSHOT_DIR: path.join(fixture, 'screenshots') },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  gateway.stderr.on('data', chunk => { errors += String(chunk); });
  let health;
  for (let attempt = 0; attempt < 45; attempt += 1) {
    if (gateway.exitCode !== null) throw new Error(`Gateway exited before health check: ${errors}`);
    try {
      const result = await fetch(`http://127.0.0.1:${port}/control/healthz`, { signal: AbortSignal.timeout(350) });
      if (result.ok) { health = await result.json(); break; }
    } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 140));
  }
  assert.equal(health?.integratedWebMcp, true,
    `bundled gateway must start without the source or any project workspace: ${errors}`);
  assert.equal(health?.controlVersion, 3);
  assert.equal(health?.personalEdgePairing, 'private-token');
  console.log(JSON.stringify({ result: 'PASS', packagedGatewayOwnedByExtension: true,
    arbitraryWorkspaceExecutableIgnored: true, sourceCheckoutFallbackBounded: true,
    stagedFilesNoSecretOrRuntimeState: true, realStagedGatewayStartedWithoutSourceWorkspace: true }, null, 2));
} finally {
  if (gateway && gateway.exitCode === null) {
    gateway.kill();
    await Promise.race([new Promise(resolve => gateway.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 1800))]);
  }
  await rm(fixture, { recursive: true, force: true });
}
