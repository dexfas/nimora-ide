import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  buildSandboxPayload,
  getAvailableToolsPolicy,
  getPlatformSupport,
  getUserProfilePolicy,
  spawnSandboxFromConfig,
  type SandboxPolicy,
} from '@microsoft/mxc-sdk';

if (process.platform !== 'win32') {
  console.log('[smoke] strict MXC live smoke skipped: Windows-only proof');
  process.exit(0);
}

// Match the production Stable gate before any SDK preparation can rewrite host ACLs.
const currentSupport = getPlatformSupport();
if (!currentSupport.isSupported || !currentSupport.availableMethods.includes('processcontainer')
  || !['base-container', 'appcontainer-bfs'].includes(currentSupport.isolationTier ?? '')) {
  throw new Error(`HOST_PREREQUISITE_BLOCKED: BaseContainer or AppContainer+BFS is required; isolationTier=${currentSupport.isolationTier ?? 'unknown'}. No sandbox process or host preparation was started.`);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-strict-mxc-'));
const allowed = path.join(root, 'allowed');
const outside = path.join(root, 'outside');
const strictTemp = path.join(root, 'strict-temp');
const allowedWrite = path.join(allowed, 'allowed-write.txt');
const outsideWrite = path.join(outside, 'blocked-write.txt');
const fakeSecret = path.join(outside, 'secret.txt');
const probePath = path.join(allowed, 'probe.ps1');
const shell = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const wxcExec = path.join(
  process.cwd(),
  'node_modules',
  '@microsoft',
  'mxc-sdk',
  'bin',
  process.arch === 'arm64' ? 'arm64' : 'x64',
  'wxc-exec.exe',
);

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isWindowsDriveRoot(value: string): boolean {
  const normalized = value.replace(/\//g, '\\').replace(/\\+$/g, '');
  return /^[A-Za-z]:$/.test(normalized);
}

function envValue(name: string): string | undefined {
  const entry = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function selectedSandboxEnv(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ['SystemRoot', 'PATH', 'ComSpec', 'PATHEXT', 'PSModulePath', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) {
    const value = envValue(name);
    if (value) result[name] = value;
  }
  result.PSHOME = path.dirname(shell);
  return result;
}

async function listenLocalProbe(): Promise<{ server: http.Server; port: number; getHits(): number }> {
  let hits = 0;
  const server = http.createServer((_request, response) => {
    hits += 1;
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('NETWORK_SHOULD_HAVE_BEEN_BLOCKED');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, port: address.port, getHits: () => hits };
}

async function runChild(config: ReturnType<typeof buildSandboxPayload>, sandboxEnv: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = spawnSandboxFromConfig(
    config,
    {
      usePty: false,
      executablePath: wxcExec,
      skipPlatformCheck: true,
    },
    allowed,
    sandboxEnv,
  );
  child.stdin?.end();
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', chunk => stdout += chunk);
  child.stderr?.on('data', chunk => stderr += chunk);
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? -1));
  });
  return { stdout, stderr, exitCode };
}

const localProbe = await listenLocalProbe();
try {
  await Promise.all([
    fs.mkdir(allowed, { recursive: true }),
    fs.mkdir(outside, { recursive: true }),
    fs.mkdir(strictTemp, { recursive: true }),
    fs.access(wxcExec),
    fs.access(shell),
  ]);
  await fs.writeFile(fakeSecret, 'NIMORA_FAKE_SECRET_FOR_SANDBOX_TEST\n', 'utf8');

  const probeScript = [
    "$ErrorActionPreference = 'Stop'",
    "Set-Content -LiteralPath " + psQuote(allowedWrite) + " -Value 'ALLOWED_WRITE_OK'",
    "Write-Output 'ALLOWED_WRITE_OK'",
    'try {',
    "  Set-Content -LiteralPath " + psQuote(outsideWrite) + " -Value 'OUTSIDE_WRITE_BUG'",
    "  Write-Output 'OUTSIDE_WRITE_UNEXPECTED'",
    '} catch {',
    "  Write-Output 'OUTSIDE_WRITE_BLOCKED'",
    '}',
    'try {',
    "  $value = Get-Content -LiteralPath " + psQuote(fakeSecret) + " -Raw",
    "  Write-Output ('OUTSIDE_READ_UNEXPECTED:' + $value.Trim())",
    '} catch {',
    "  Write-Output 'OUTSIDE_READ_BLOCKED'",
    '}',
    'try {',
    `  Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri 'http://127.0.0.1:${localProbe.port}/nimora-strict-probe' | Out-Null`,
    "  Write-Output 'LOCAL_NETWORK_UNEXPECTED'",
    '} catch {',
    "  Write-Output 'LOCAL_NETWORK_BLOCKED'",
    '}',
  ].join('\r\n');
  await fs.writeFile(probePath, probeScript, 'utf8');

  const availableTools = getAvailableToolsPolicy(process.env, { containerType: 'processcontainer' });
  const userProfile = getUserProfilePolicy();
  const readonlyPaths = [...new Set([
    ...availableTools.readonlyPaths,
    ...userProfile.readonlyPaths,
    path.dirname(shell),
  ].filter(value => !isWindowsDriveRoot(value)))];
  const policy: SandboxPolicy = {
    version: '0.6.0-alpha',
    filesystem: {
      readwritePaths: [allowed, strictTemp],
      readonlyPaths,
      deniedPaths: [],
    },
    network: {
      allowOutbound: false,
      allowLocalNetwork: false,
    },
    ui: {
      allowWindows: true,
      clipboard: 'none',
      allowInputInjection: false,
    },
    timeoutMs: 15_000,
  };
  const commandLine = `${psQuote(shell)} -NoProfile -ExecutionPolicy Bypass -File ${psQuote(probePath)}`;
  const config = buildSandboxPayload(commandLine, policy, allowed, undefined, 'process');
  const result = await runChild(config, selectedSandboxEnv());
  const combined = `${result.stdout}\n${result.stderr}`;

  if (result.exitCode !== 0) {
    const support = getPlatformSupport();
    const prerequisiteBlocked = /BaseContainer is unavailable|WRITE_DAC not granted|prepare-system-drive|prepare-null-device/i.test(combined);
    if (prerequisiteBlocked) {
      throw new Error(`HOST_PREREQUISITE_BLOCKED: strict MXC cannot be certified on this Windows host yet. isolationTier=${support.isolationTier ?? 'unknown'}; availableMethods=${support.availableMethods.join(',')}; warnings=${(support.isolationWarnings ?? []).join(' | ')}\n${combined}`);
    }
    assert.equal(result.exitCode, 0, `MXC probe must complete successfully.\n${combined}`);
  }
  assert.match(combined, /ALLOWED_WRITE_OK/, combined);
  assert.match(combined, /OUTSIDE_WRITE_BLOCKED/, combined);
  assert.match(combined, /OUTSIDE_READ_BLOCKED/, combined);
  assert.match(combined, /LOCAL_NETWORK_BLOCKED/, combined);
  assert.doesNotMatch(combined, /OUTSIDE_WRITE_UNEXPECTED/, combined);
  assert.doesNotMatch(combined, /OUTSIDE_READ_UNEXPECTED/, combined);
  assert.doesNotMatch(combined, /LOCAL_NETWORK_UNEXPECTED/, combined);
  assert.equal((await fs.readFile(allowedWrite, 'utf8')).trim(), 'ALLOWED_WRITE_OK');
  await assert.rejects(() => fs.access(outsideWrite));
  assert.equal(localProbe.getHits(), 0, 'Sandboxed process must not reach the host loopback listener.');

  console.log('[smoke] strict MXC exact-root live proof PASS: allowed write ok; sibling write/read blocked; local network blocked');
} finally {
  await new Promise<void>(resolve => localProbe.server.close(() => resolve()));
  await fs.rm(root, { recursive: true, force: true });
}
