import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.join(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-p11-cancellation-'));
const bundle = path.join(temp, 'bridge.cjs');
await esbuild.build({
  stdin: { contents: [
    "export { BridgeManager } from './extensions/shuncode/src/bridge-server.ts';",
    "export { HostCapabilityExecutionCoordinator } from './src/host-capability-execution-coordinator.ts';",
    "export { FileToolHostCapabilityExecutor } from './src/file-host-capability-executor.ts';",
  ].join('\n'), resolveDir: root, sourcefile: 'p11-cancellation-entry.ts', loader: 'ts' },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', target: ['es2022'], logLevel: 'silent',
  plugins: [{ name: 'vscode-test-shell', setup(build) {
    build.onResolve({ filter: /^vscode$/ }, () => ({ path: 'vscode', namespace: 'test-shell' }));
    build.onLoad({ filter: /.*/, namespace: 'test-shell' }, () => ({
      contents: 'export class EventEmitter { event = () => ({ dispose() {} }); fire() {} dispose() {} }', loader: 'js',
    }));
  } }],
});
const { BridgeManager, HostCapabilityExecutionCoordinator, FileToolHostCapabilityExecutor } = require(bundle);
const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
const modes: string[] = [];
const bounded = <T>(promise: Promise<T>, message: string) => Promise.race([
  promise, new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error(message)), 5000); timer.unref(); }),
]);
try {
  for (const mode of ['cloudflare', 'ngrok']) {
    const workspace = path.join(temp, mode);
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, 'README.md'), 'BEFORE\n');
    let entered!: () => void, release!: () => void, settled!: () => void;
    const approvalEntered = new Promise<void>(resolve => { entered = resolve; });
    const approvalHeld = new Promise<void>(resolve => { release = resolve; });
    const cancelledHandlerSettled = new Promise<void>(resolve => { settled = resolve; });
    let writeEntries = 0;
    const signals = new Map<string | number, AbortSignal>();
    const files = new FileToolHostCapabilityExecutor({ workspaceRoots: () => [workspace] });
    const executor = new HostCapabilityExecutionCoordinator({
      authorizer: { authorize: async request => { if (request.callId === '7') { entered(); await approvalHeld; } } },
      executor: { execute: (request, metadata, admission) => {
        if (request.name === 'apply_patch') writeEntries++;
        return files.execute(request, metadata, admission);
      } },
    });
    const native = {
      listTools: async () => [],
      callTool: async (_token, _sessionId, requestId, name, args, signal) => {
        signals.set(requestId, signal);
        try {
          const result = await executor.executeOnce({
            executionId: mode + ':' + requestId, managedSessionId: 'test-managed', workerId: 'test-worker',
            inputId: 'test-input', callId: String(requestId), name, arguments: args,
          }, { signal });
          return { content: [{ type: 'text', text: result.text ?? '' }], ...(result.isError ? { isError: true } : {}) };
        } finally { if (requestId === 7) settled(); }
      },
    };
    const bridge = new BridgeManager({ extension: { packageJSON: { version: '0.0.0-test' } } }, { appendLine() {} }, {}, {}, async () => {}, native);
    bridge.tunnelProvider = mode;
    const http = createServer(async (request, response) => {
      try {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        await bridge.handlePost(request, response, JSON.parse(Buffer.concat(chunks).toString('utf8')), request.headers['mcp-session-id'], 'test-binding');
      } catch (error) {
        if (!response.destroyed && !response.writableEnded) { response.statusCode = 500; response.end(String(error)); }
      }
    });
    http.listen(0, '127.0.0.1');
    await once(http, 'listening');
    const url = 'http://127.0.0.1:' + (http.address() as any).port + '/mcp';
    try {
      const initialized = await fetch(url, {
        method: 'POST', headers, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
          protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' },
        } }),
      });
      assert.equal(initialized.status, 200);
      const sessionHeaders = { ...headers, 'mcp-session-id': initialized.headers.get('mcp-session-id')! };
      await initialized.text();
      const notification = await fetch(url, {
        method: 'POST', headers: sessionHeaders, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      assert.equal(notification.status, 202);
      await notification.text();
      const writeArgs = { patch: '*** Begin Patch\n*** Update File: README.md\n@@\n-BEFORE\n+AFTER\n*** End Patch' };
      const cancel = new AbortController();
      const cancelledClient = fetch(url, {
        method: 'POST', headers: sessionHeaders, signal: cancel.signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'apply_patch', arguments: writeArgs } }),
      }).then(async response => ({ text: await response.text() }), error => ({ error })).catch(error => ({ error }));
      await bounded(approvalEntered, 'approval admission timeout');
      const read = await fetch(url, {
        method: 'POST', headers: sessionHeaders, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'read_files', arguments: { files: [{ path: 'README.md' }] } } }),
      });
      assert.equal(read.status, 200);
      assert.match(await read.text(), /BEFORE/);
      assert.notEqual(signals.get(7), signals.get(8));
      assert.equal(signals.get(8)!.aborted, false, 'normal response finish must not cancel another request');
      const observedCancellation = once(signals.get(7)!, 'abort');
      cancel.abort();
      await bounded(observedCancellation, 'HTTP disconnect did not reach native call');
      release();
      await bounded(cancelledHandlerSettled, 'cancelled handler did not settle');
      await cancelledClient;
      assert.equal(writeEntries, 0, mode + ': disconnected approval must not reach file executor');
      assert.equal(await fs.readFile(path.join(workspace, 'README.md'), 'utf8'), 'BEFORE\n');
      assert.equal(signals.get(8)!.aborted, false, 'cancellation must be request-local');
      const successful = await fetch(url, {
        method: 'POST', headers: sessionHeaders, signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'apply_patch', arguments: writeArgs } }),
      });
      assert.equal(successful.status, 200);
      assert.match(await successful.text(), /status: success/);
      assert.equal(writeEntries, 1);
      assert.equal(await fs.readFile(path.join(workspace, 'README.md'), 'utf8'), 'AFTER\n');
      modes.push(mode === 'cloudflare' ? 'json' : 'sse');
    } finally {
      release();
      for (const session of bridge.sessions.values()) { await session.server.close(); await session.transport.close(); }
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
    }
  }

  // Cancel in final source validation, after preflight/staging. Only the test
  // bundle's fs read is instrumented; production has no test hook.
  const patchSource = await fs.readFile(path.join(root, 'src/apply-patch.ts'), 'utf8');
  const guard = /^        if \(signal\?\.aborted\) throw new DOMException\("Patch application was cancelled\.", "AbortError"\);\r?\n/gm;
  const oldPatchSource = patchSource.replace(guard, '');
  assert.equal(createHash('sha256').update(oldPatchSource).digest('hex'), 'd168decb3e0fcecd02c913a927842796a6d692ef9a4ee515bf7f1b9fdae2ccf3', 'baseline must be exact audited pre-fix source');
  for (const baseline of [true, false]) {
    const patchBundle = path.join(temp, 'patch-' + baseline + '.cjs');
    await esbuild.build({
      stdin: { contents: "export { applyPatch } from './src/apply-patch.ts';", resolveDir: root, loader: 'ts' },
      outfile: patchBundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
      plugins: [{ name: 'cancel-final-source-validation', setup(build) {
        build.onLoad({ filter: /[\\/]apply-patch\.ts$/ }, () => ({ contents: baseline ? oldPatchSource : patchSource, loader: 'ts' }));
        build.onResolve({ filter: /^node:fs\/promises$/ }, args => args.importer.endsWith('apply-patch.ts') ? { path: 'fs', namespace: 'cancel-fs' } : undefined);
        build.onLoad({ filter: /.*/, namespace: 'cancel-fs' }, () => ({ loader: 'js', contents:
          "import * as fs from 'node:fs/promises'; export const {access,link,open,realpath,rename,stat,unlink}=fs; export async function readFile(...args){const result=await fs.readFile(...args); await globalThis.p11FinalSourceRead?.(args[0]); return result;}"
        }));
      } }],
    });
    const { applyPatch } = require(patchBundle);
    for (const action of ['update', 'delete', 'move']) {
      const workspace = path.join(temp, 'patch-' + baseline + '-' + action);
      await fs.mkdir(workspace);
      const sourceFile = path.join(workspace, 'source.txt');
      await fs.writeFile(sourceFile, 'BEFORE\n');
      let sourceReads = 0;
      const cancel = new AbortController();
      (globalThis as any).p11FinalSourceRead = file => { if (String(file) === sourceFile && ++sourceReads === 3) cancel.abort(); };
      const directive = action === 'delete' ? '*** Delete File: source.txt'
        : '*** Update File: source.txt\n' + (action === 'move' ? '*** Move to: moved.txt\n' : '') + '@@\n-BEFORE\n+AFTER';
      const result = await applyPatch({ patch: '*** Begin Patch\n' + directive + '\n*** End Patch' }, { workspaceRoots: [workspace], signal: cancel.signal })
        .then(value => ({ value }), error => ({ error }));
      assert.equal(sourceReads, 3);
      if (baseline) assert.equal((result as any).value?.status, 'success', 'pre-fix code incorrectly mutates after cancellation');
      else {
        assert.equal((result as any).error?.code, 'ABORTED');
        assert.equal(await fs.readFile(sourceFile, 'utf8'), 'BEFORE\n');
        assert.equal((await fs.readdir(workspace)).includes('moved.txt'), false);
      }
      delete (globalThis as any).p11FinalSourceRead;
    }
  }
  console.log(JSON.stringify({ result: 'PASS', actualBridgeHttpModes: modes, lateApprovalWriteEntries: 0, parallelRequestIsolation: true, normalAuthorizedWritesWork: true, exactPreFixCommitFalsifier: true, finalValidationCancellationPreventsMutation: ['update', 'delete', 'move'] }, null, 2));
} finally {
  delete (globalThis as any).p11FinalSourceRead;
  await fs.rm(temp, { recursive: true, force: true });
}
