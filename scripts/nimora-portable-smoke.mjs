import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const packageRoot = path.resolve(process.argv[2] ?? '');
assert.ok(process.argv[2], 'provide the exact desktop package root');
const app = path.join(packageRoot, 'resources/app');
const executable = path.join(packageRoot, 'ShunCode.exe');
const gatewayDirectory = path.join(app, 'extensions/shuncode-webmcp/gateway');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'nimora-portable-smoke-'));
let gateway;
try {
  const manifest = JSON.parse(await readFile(path.join(app, 'extensions/shuncode/package.json'), 'utf8'));
  assert.equal(manifest.publisher, 'shuncode');
  await readFile(path.join(app, 'extensions/shuncode/runtime/bin/rg.exe'));
  await readFile(path.join(app, 'extensions/shuncode/runtime/bin/shuncode_process_metadata.node'));
  const sdk = JSON.parse(await readFile(path.join(gatewayDirectory, 'node_modules/@modelcontextprotocol/sdk/package.json'), 'utf8'));
  assert.ok(sdk.version);
  await readFile(path.join(packageRoot, 'Start-Nimora.cmd'));
  const certificateBinary = path.join(app, 'node_modules.asar.unpacked/@vscode/windows-ca-certs/build/Release/crypt32.node');
  await readFile(certificateBinary);
  // Load the ASAR package through the shipped Electron Node, not the development
  // Node or an unpacked manifest. No certificates or account data are printed.
  const certificateProbe = await promisify(execFile)(executable, ['-e',
    'const {Crypt32}=require(process.argv[1]); if(typeof Crypt32!=="function") throw Error("Missing Crypt32 export"); console.log("CERT_NATIVE_LOAD_PASS");',
    path.join(app, 'node_modules.asar/@vscode/windows-ca-certs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, timeout: 10_000,
  });
  assert.match(certificateProbe.stdout, /CERT_NATIVE_LOAD_PASS/);
  const listener = net.createServer();
  await new Promise((resolve, reject) => listener.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  let errors = '';
  gateway = spawn(executable, ['server.mjs'], {
    cwd: gatewayDirectory,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port),
      SHUNCODE_INTEGRATED_BROWSER_BRIDGE: 'http://127.0.0.1:1',
      BROWSER_PROFILE: path.join(temporary, 'profile'), SHUNCODE_WEBMCP_SCREENSHOT_DIR: path.join(temporary, 'screenshots') },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  gateway.stderr.on('data', chunk => { errors += String(chunk); });
  gateway.on('error', error => { errors += error.message; });
  let health;
  for (let i = 0; i < 300; i++) {
    if (gateway.exitCode !== null) throw new Error(`Packaged gateway exited: ${errors}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/control/healthz`, { signal: AbortSignal.timeout(250) });
      if (response.ok) { health = await response.json(); break; }
    } catch { /* bounded process startup observation */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(health?.integratedWebMcp, true, errors);
  assert.equal(health?.controlVersion, 3);
  console.log(JSON.stringify({ result: 'PASS', executable, sha256: createHash('sha256').update(await readFile(executable)).digest('hex'),
    gatewayUsesPackagedElectronNode: true, gatewayDepsIncluded: true, firstPartyNativeAssetsIncluded: true,
    windowsCertificateNativeLoad: 'PASS',
    sourceCheckoutNotUsedByGateway: true, providerAcceptance: 'NOT_TESTED' }, null, 2));
} finally {
  if (gateway && gateway.exitCode === null) {
    gateway.kill();
    await Promise.race([new Promise(resolve => gateway.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 2000))]);
  }
  assert.equal(path.dirname(temporary), os.tmpdir());
  assert.ok(path.basename(temporary).startsWith('nimora-portable-smoke-'));
  await rm(temporary, { recursive: true, force: true });
}
