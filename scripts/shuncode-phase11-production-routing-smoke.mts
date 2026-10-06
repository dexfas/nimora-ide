import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p11-routing-bundle-'));
const bundlePath = path.join(bundleDirectory, 'phase11-routing.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { WebMcpCommandTransport } from './extensions/shuncode/src/webmcp-worker-transport.ts';
      export { ChatGptBrowserCommandTransport } from './extensions/shuncode/src/chatgpt-browser-worker-transport.ts';
      export { WebWorkerAdapter } from './src/web-worker-adapter.ts';
      export { resolveWebWorkerReleaseGate, applyWebWorkerReleaseGate } from './src/web-worker-release-gate.ts';
      export { shunCodeMissionCapabilityExecutionRoutes } from './extensions/shuncode/src/bridge-task-tool-definitions.ts';
      export { createMissionWorkProductionComposition } from './extensions/shuncode/src/mission-work-production-composition.ts';
    `,
    resolveDir: root,
    sourcefile: 'phase11-routing-entry.ts',
    loader: 'ts',
  },
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['es2022'],
  logLevel: 'silent',
});

const {
  WebMcpCommandTransport,
  ChatGptBrowserCommandTransport,
  WebWorkerAdapter,
  resolveWebWorkerReleaseGate,
  applyWebWorkerReleaseGate,
  shunCodeMissionCapabilityExecutionRoutes,
  createMissionWorkProductionComposition,
} = require(bundlePath);

class FakeCommands {
  calls = [];
  async executeCommand(command, arg) {
    this.calls.push({ command, arg: structuredClone(arg ?? {}) });
    if (command === '_shuncode.webMcp.workerConnect') {
      return {
        pageId: 'deepseek-page',
        sessionId: 'deepseek-session',
        site: 'deepseek',
        origin: 'https://chat.deepseek.com',
        href: 'https://chat.deepseek.com/a/chat/s/proof',
        status: { enabled: true, composerFound: true, isDeepSeekAuthPage: false },
      };
    }
    if (command === '_shuncode.webMcp.workerSend') {
      return {
        inputId: arg.input.inputId,
        state: 'completed',
        text: 'DONE',
        events: [{ seq: 1, type: 'completed', text: 'DONE' }],
      };
    }
    if (command === '_shuncode.webMcp.workerDisconnect') return { disconnected: true };
    throw new Error(`Unexpected command ${command}`);
  }
}

try {
  const off = resolveWebWorkerReleaseGate(false, true);
  const untrusted = resolveWebWorkerReleaseGate(true, false);
  const on = resolveWebWorkerReleaseGate(true, true);
  assert.equal(off.effective, false);
  assert.equal(untrusted.effective, false);
  assert.equal(on.effective, true);

  const forged = applyWebWorkerReleaseGate({
    inputId: 'forged-input',
    prompt: 'caller tries to forge host ownership',
    extensions: { hostManagedCapabilities: true },
  }, off);
  assert.equal(forged.extensions.hostManagedCapabilities, false, 'caller extension flag must not bypass release gate');

  const commands = new FakeCommands();
  let gate = off;
  const transport = new WebMcpCommandTransport(commands, {
    pollIntervalMs: 1,
    capabilityProjection: () => gate.effective
      ? {
          nativeByName: false,
          externalDefinitions: true,
          executionRoutes: shunCodeMissionCapabilityExecutionRoutes(
            'external-schema',
            'phase11-deepseek-host',
            'Trusted release-gated DeepSeek host-managed route.',
          ),
        }
      : { nativeByName: false, externalDefinitions: false, executionRoutes: [] },
    prepareInput: input => applyWebWorkerReleaseGate(input, gate),
  });
  const adapter = new WebWorkerAdapter(transport, 'nimora.web-worker');

  const descriptorOff = await adapter.describe();
  assert.equal(descriptorOff.capabilityProjection.externalDefinitions, false);
  assert.deepEqual(descriptorOff.capabilityProjection.executionRoutes, []);

  gate = on;
  const descriptorOn = await adapter.describe();
  assert.equal(descriptorOn.capabilityProjection.nativeByName, false);
  assert.equal(descriptorOn.capabilityProjection.externalDefinitions, true);
  assert.ok(descriptorOn.capabilityProjection.executionRoutes.length >= 2);
  assert.ok(descriptorOn.capabilityProjection.executionRoutes.every(route => route.projectionMode === 'external-schema'));

  let chatGptNativeMcpEnabled = false;
  const chatGptTransport = new ChatGptBrowserCommandTransport(commands, {
    capabilityProjection: () => chatGptNativeMcpEnabled
      ? {
          nativeByName: true,
          externalDefinitions: false,
          executionRoutes: shunCodeMissionCapabilityExecutionRoutes(
            'native-by-name',
            'chatgpt-native-mcp',
            'Explicitly enabled ChatGPT Mission-native MCP route.',
          ),
        }
      : { nativeByName: false, externalDefinitions: false, executionRoutes: [] },
  });
  const chatGptAdapter = new WebWorkerAdapter(chatGptTransport, 'nimora.chatgpt-browser-worker');
  const chatGptOff = await chatGptAdapter.describe();
  assert.equal(chatGptOff.capabilityProjection.nativeByName, false);
  assert.equal(chatGptOff.extensions.nativeMcp, false);
  assert.deepEqual(chatGptOff.capabilityProjection.executionRoutes, []);
  chatGptNativeMcpEnabled = true;
  const chatGptOn = await chatGptAdapter.describe();
  assert.equal(chatGptOn.capabilityProjection.nativeByName, true);
  assert.equal(chatGptOn.extensions.nativeMcp, true);
  assert.ok(chatGptOn.capabilityProjection.executionRoutes.length >= 2);
  assert.ok(chatGptOn.capabilityProjection.executionRoutes.every(route => route.projectionMode === 'native-by-name'));

  const session = await adapter.createSession({
    extensions: {
      webMcpTarget: {
        pageId: 'deepseek-page',
        resourceIdentity: 'a'.repeat(64),
        origin: 'https://chat.deepseek.com',
        href: 'https://chat.deepseek.com/a/chat/s/proof',
        site: 'deepseek',
      },
    },
  });
  const externalCapabilities = [{
    name: 'read_files',
    description: 'Exact admitted read schema.',
    inputSchema: {
      type: 'object',
      required: ['files'],
      properties: { files: { type: 'array' } },
      additionalProperties: false,
    },
  }];
  const events = [];
  for await (const event of adapter.send(session, {
    inputId: 'phase11-deepseek-turn',
    prompt: 'Read the exact admitted file.',
    allowedCapabilities: ['read_files'],
    externalCapabilities,
    extensions: { hostManagedCapabilities: false },
  })) events.push(event);
  assert.equal(events.at(-1).type, 'terminal');
  assert.equal(events.at(-1).status, 'completed');
  const sendCall = commands.calls.find(call => call.command === '_shuncode.webMcp.workerSend');
  assert.deepEqual(sendCall.arg.input.allowedCapabilities, ['read_files']);
  assert.deepEqual(sendCall.arg.input.externalCapabilities, externalCapabilities);
  assert.equal(sendCall.arg.input.extensions.hostManagedCapabilities, true, 'trusted configured release gate owns dispatch mode');
  assert.equal(sendCall.arg.input.extensions.releaseGate.ownership, 'host-managed');
  await adapter.dispose(session);

  const fakeOwners = {
    projects: {},
    tasks: {},
    collaboration: {},
    workers: {
      getWorker() { return undefined; },
      listSessions() { return []; },
      listRetiredSessions() { return []; },
    },
  };
  const composition = createMissionWorkProductionComposition(
    fakeOwners,
    { async executeCommand() { return []; } },
    { async executeAndDeliver() { throw new Error('not exercised'); } },
    { async activateTurn() {}, clearTurn() {} },
  );
  assert.deepEqual(
    composition.assignmentCandidateSources.map(source => source.constructor.name),
    ['ChatGptBrowserWorkerCandidateSource', 'WebMcpWorkerAssignmentCandidateSource'],
    'WO#1 automatic production pool must be ChatGPT first, DeepSeek/WebMCP second only',
  );

  const arenaSource = await fs.readFile(path.join(root, 'extensions', 'shuncode-webmcp', 'arena-agent-bridge.js'), 'utf8');
  assert.match(arenaSource, /Host-managed WebMCP capability scope is inconsistent/);
  assert.match(arenaSource, /outside the exact admitted Mission capability scope/);
  assert.match(arenaSource, /pendingHostCapabilities/);
  assert.match(arenaSource, /dispatch: hostManaged \? 'host-requested' : 'observed'/);

  console.log(JSON.stringify({
    result: 'PASS',
    productionPool: ['ChatGPT', 'DeepSeek-WebMCP'],
    apiFallbackInPool: false,
    untrustedHostManagedRoute: false,
    forgedHostManagedAuthority: false,
    trustedExternalSchemaRoute: true,
    exactAllowedNamesForwarded: true,
    exactExternalSchemasForwarded: true,
    pageOutOfScopeGuardPresent: true,
  }, null, 2));
} finally {
  await fs.rm(bundleDirectory, { recursive: true, force: true });
}
