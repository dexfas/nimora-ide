import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
// Affected local suites only. Live OS certification is a separate host gate.
const names = ['runtime', 'component-integration', 'nimora-later-root', 'autonomy-later-root', 'api-mission-broker', 'api-mission-runtime-e2e',
  'personal-edge-pairing', 'nimora-product-shell', 'nimora-product-ui-host', 'nimora-phase13-productization', 'nimora-web-ai-assembly',
  'worker-adapter', 'agent-host-worker', 'worker-session-manager', 'worker-assignment', 'worker-assignment-coordinator-e2e',
  'mission-autonomy-loop', 'mission-worker-succession', 'mission-parallel-orchestration', 'mission-worker-input-materialization', 'mission-skill-materialization',
  'phase11-native-mcp', 'phase11-production-routing', 'phase11-native-mcp-cancellation', 'gateway-mcp-exposure', 'gateway-upstream-provider',
  'gateway-federation', 'gateway-personal-edge-provider', 'webmcp-gateway-location', 'webmcp-gateway-shared-agent', 'web-worker-release-gate'];
const extra = ['shuncode-nimora-project-completion-smoke.mts', 'shuncode-phase11-native-mcp-delivery-smoke.mts', 'shuncode-worker-conversation-lifecycle-smoke.mts', 'shuncode-agent-host-client-tools-smoke.mts'];
const jobs = [...names.map(name => { const key = 'test-shuncode-' + name; const value = manifest.scripts[key];
  assert.match(value, /^node scripts\/[\w.-]+$/); return { name: key, script: value.slice(5) }; }), ...extra.map(script => ({ name: script, script: 'scripts/' + script }))];
const results = [];
for (const job of jobs) {
  const started = Date.now();
  const result = await new Promise(resolve => {
    const child = spawn(process.execPath, [job.script], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    child.once('error', error => resolve({ exitCode: -1, output: String(error) }));
    child.once('exit', exitCode => resolve({ exitCode, output }));
  });
  results.push({ ...job, ...result, elapsedMs: Date.now() - started });
  console.log(`${result.exitCode === 0 ? 'PASS' : 'FAIL'} ${job.name}`);
  if (result.exitCode !== 0) console.log(result.output.slice(-8000));
}
const directory = path.join(root, '.build/nimora-component-validation'); await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'regression.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.filter(row => row.exitCode === 0).length, total: results.length, results }, null, 2));
if (results.some(row => row.exitCode !== 0)) process.exitCode = 1;
console.log(`${results.filter(row => row.exitCode === 0).length}/${results.length} affected component suites PASS.`);
