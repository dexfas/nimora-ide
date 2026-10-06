import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-current-route-relay-'));
const bundlePath = path.join(bundleDirectory, 'relay-client.cjs');

await esbuild.build({
  stdin: {
    contents: `export * from './extensions/shuncode/src/current-route-relay.ts';`,
    resolveDir: root,
    sourcefile: 'current-route-relay-smoke-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});

const { CurrentRouteRelayClient, normalizeCurrentRouteTargetUrl, currentMissionRelayTargetUrl, publishPreparedMissionRelayRoute } = require(bundlePath);

try {
  const extensionSource = await fs.readFile(path.join(root, 'extensions', 'shuncode', 'src', 'extension.ts'), 'utf8');
  assert.match(
    extensionSource,
    /if \(!strict\) return resultPromise\.catch\(\(\) => undefined\);\s*return resultPromise;/,
    'non-strict relay sync must resolve undefined so direct Mission MCP URLs remain usable when the relay is unavailable',
  );
  assert.match(
    extensionSource,
    /enqueueCurrentRouteRelaySync\("mission-native-mcp-prepared"\)(?!,\s*true)/,
    'Mission MCP preparation must treat stable-relay publication as optional and fall back to the current direct public URL',
  );
  assert.match(
    extensionSource,
    /enqueueCurrentRouteRelaySync\("relay-configured", true\)/,
    'explicit relay configuration must remain strict',
  );
  assert.match(extensionSource, /context\.workspaceState\.get<string>\(CURRENT_ROUTE_RELAY_MISSION_KEY\)/,
    'restart must recover the workspace transport Mission selection rather than an ephemeral token');
  assert.match(extensionSource, /currentMissionRelayTargetUrl\(status\.publicUrl, missionId\)/,
    'automatic publication must use the current Mission alias');
  assert.match(extensionSource, /enqueueCurrentRouteRelaySync\("runtime-ready"\)/,
    'restored selection must be published when the Bridge becomes ready');

  let storedTarget = '';
  let generation = 0;
  let puts = 0;
  const transport = async (request) => {
    assert.equal(request.headers.authorization, 'Bearer relay-secret');
    if (request.method === 'PUT') {
      puts += 1;
      const input = JSON.parse(request.body);
      storedTarget = input.targetUrl;
      generation += 1;
      return { status: 200, body: JSON.stringify({ targetUrl: storedTarget, generation }) };
    }
    return { status: storedTarget ? 200 : 404, body: JSON.stringify({ targetUrl: storedTarget, generation }) };
  };

  const client = new CurrentRouteRelayClient('https://nimora-route.example.workers.dev/r/stable-capability/', 'relay-secret', transport);
  assert.equal(client.getStableMcpUrl(), 'https://nimora-route.example.workers.dev/r/stable-capability/mcp');

  const firstTarget = currentMissionRelayTargetUrl('https://first-random.trycloudflare.com/mcp/bridge-token/', 'mission-a');
  assert.equal(firstTarget, 'https://first-random.trycloudflare.com/mcp/bridge-token/mission-current/mission-a');
  const first = await client.sync({ targetUrl: firstTarget, bindingToken: 'mission-a', bridgeRevision: 1, reason: 'startup' });
  assert.equal(first.changed, true);
  assert.equal(first.targetUrl, firstTarget);
  assert.equal(first.generation, 1);
  assert.equal(puts, 1);

  const duplicate = await client.sync({ targetUrl: firstTarget, reason: 'duplicate-event' });
  assert.equal(duplicate.changed, false);
  assert.equal(puts, 1, 'same verified target must not republish');

  const secondTarget = currentMissionRelayTargetUrl('https://second-random.trycloudflare.com/mcp/new-bridge-token', 'mission-a');
  const second = await client.sync({ targetUrl: secondTarget, bindingToken: 'mission-a', bridgeRevision: 2, reason: 'tunnel-recovery' });
  assert.equal(second.changed, true);
  assert.equal(second.generation, 2);
  assert.equal(storedTarget, secondTarget);
  assert.equal(puts, 2);

  assert.throws(() => normalizeCurrentRouteTargetUrl('http://127.0.0.1/mcp/x/mission/y'), /must use HTTPS/);
  assert.throws(() => currentMissionRelayTargetUrl('https://fresh.trycloudflare.com/mcp/x', 'other/mission'), /exact Mission/);
  assert.throws(() => currentMissionRelayTargetUrl('https://fresh.trycloudflare.com/mcp/x?other=1', 'mission-a'), /query string/);

  const staleClient = new CurrentRouteRelayClient('https://nimora-route.example.workers.dev/r/stable-capability', 'relay-secret', async request => {
    if (request.method === 'PUT') return { status: 200, body: JSON.stringify({ targetUrl: firstTarget, generation: 3 }) };
    return { status: 200, body: JSON.stringify({ targetUrl: secondTarget, generation: 2 }) };
  });
  await assert.rejects(
    () => staleClient.sync({ targetUrl: firstTarget }),
    /stale or different target URL/,
    'read-after-write mismatch must fail closed',
  );

  let selectedMission: string | undefined;
  let persistedMission: string | undefined;
  const preparedConnection = async (missionId: string) => publishPreparedMissionRelayRoute(
    { missionId, token: `fresh-${missionId}` }, {
      selectBinding: async binding => { selectedMission = binding.missionId; persistedMission = binding.missionId; },
      prepareUrls: async () => ({ publicUrl: currentMissionRelayTargetUrl('https://fresh.trycloudflare.com/mcp/bridge', missionId) }),
      syncRelay: async () => {
        assert.equal(persistedMission, missionId, 'persist selection before sync');
        return client.sync({ targetUrl: currentMissionRelayTargetUrl('https://fresh.trycloudflare.com/mcp/bridge', selectedMission) });
      },
    },
  );
  const fresh = await preparedConnection('mission-a');
  assert.equal(fresh.publicUrl, client.getStableMcpUrl(), 'fresh setup returns stable URL without waiting for another public-URL event');
  const switched = await preparedConnection('mission-b');
  assert.equal(switched.publicUrl, fresh.publicUrl, 'Mission switch keeps connector address');
  assert.equal(storedTarget, 'https://fresh.trycloudflare.com/mcp/bridge/mission-current/mission-b', 'both callers must publish the freshly selected Mission rather than old A');
  assert.match(extensionSource, /return publishMissionMcpConnection\(binding, true\)/, 'public setup uses shared tested publisher');
  assert.match(extensionSource, /const connection = await publishMissionMcpConnection\(binding, startBridge === true\)/, 'trusted preparation uses same tested publisher');
  const direct = await publishPreparedMissionRelayRoute({missionId:'mission-b',token:'fresh-b'}, {
    selectBinding: async () => {}, prepareUrls: async () => ({publicUrl:secondTarget}), syncRelay: async () => undefined,
  });
  assert.equal(direct.publicUrl, secondTarget, 'failed optional relay returns exact direct alias');
  await assert.rejects(() => publishPreparedMissionRelayRoute({missionId:'mission-b',token:'fresh-b'}, {
    selectBinding: async () => {}, prepareUrls: async () => ({publicUrl:secondTarget}),
    syncRelay: async () => ({changed:true,relayUrl:'https://stable.example',stableMcpUrl:'https://stable.example/mcp',targetUrl:firstTarget}),
  }), /does not match/, 'never advertise a stable route for a different Mission');

  console.log('ShunCode Current Route relay smoke: PASS');
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
