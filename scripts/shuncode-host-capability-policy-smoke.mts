import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(path.resolve(root, 'build', 'package.json'));
const esbuild = require('esbuild') as typeof import('../build/node_modules/esbuild/lib/main.js');
const bundleDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-host-capability-policy-'));
const workspaceDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'nimora-host-capability-workspace-'));
const bundlePath = path.join(bundleDirectory, 'host-capability-policy.cjs');

await esbuild.build({
  stdin: {
    contents: `
      export { CapabilityMetadataHostAuthorizer } from './src/host-capability-policy-authorizer.ts';
      export { getCapabilityMetadata } from './src/capability-registry.ts';
      export { HostCapabilityExecutorRouter } from './src/host-capability-executor-router.ts';
      export { FileToolHostCapabilityExecutor } from './src/file-host-capability-executor.ts';
      export { IdeToolBrokerHostCapabilityExecutor } from './extensions/shuncode/src/ide-host-capability-executor.ts';
      export { STRICT_TERMINAL_SANDBOX_INPUT } from './extensions/shuncode/src/strict-terminal-sandbox-contract.ts';
    `,
    resolveDir: root,
    sourcefile: 'host-capability-policy-entry.ts',
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
  CapabilityMetadataHostAuthorizer,
  getCapabilityMetadata,
  HostCapabilityExecutorRouter,
  FileToolHostCapabilityExecutor,
  IdeToolBrokerHostCapabilityExecutor,
  STRICT_TERMINAL_SANDBOX_INPUT,
} = require(bundlePath);
const request = (name) => ({ executionId: `exec-${name}`, managedSessionId: 'managed-1', workerId: 'nimora.web-worker', taskId: 'task-1', inputId: 'turn-1', callId: `call-${name}`, name, arguments: {} });

try {
  await fs.writeFile(path.join(workspaceDirectory, 'note.txt'), 'ROUTER_FILE_OK\n', 'utf8');
  const authorizer = new CapabilityMetadataHostAuthorizer();
  await authorizer.authorize(request('list_directory'), getCapabilityMetadata('list_directory'));
  await assert.rejects(() => authorizer.authorize(request('run_command'), getCapabilityMetadata('run_command')), /requires session approval/);
  await assert.rejects(() => authorizer.authorize(request('apply_patch'), getCapabilityMetadata('apply_patch')), /requires session approval/);

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

  const taskSnapshot = {
    inputAccessPolicies: {
      'turn-1': {
        inputId: 'turn-1',
        managedSessionId: 'managed-1',
        allowedWorkspacePathPrefixes: ['.'],
      },
    },
    workerSessions: {
      'managed-1': {
        managedSessionId: 'managed-1',
        workerId: 'nimora.web-worker',
      },
    },
  };
  const tasks = {
    getTask(taskId) {
      return taskId === 'task-1' ? taskSnapshot : undefined;
    },
  };

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
  await assert.rejects(
    () => executor.execute(request('run_command'), getCapabilityMetadata('run_command')),
    /requires exact durable Work Order path policy/,
  );

  let strictInvocationArgs;
  const strictExecutor = new IdeToolBrokerHostCapabilityExecutor({
    async invokeDirect(name, args) {
      strictInvocationArgs = args;
      return { text: 'BROKER:strict-run', isError: false };
    },
  }, { tasks, workspaceRoots: () => [workspaceDirectory] });
  const strictResult = await strictExecutor.execute(request('run_command'), getCapabilityMetadata('run_command'));
  assert.equal(strictResult.text, 'BROKER:strict-run');
  const strictMarker = strictInvocationArgs[STRICT_TERMINAL_SANDBOX_INPUT];
  assert.deepEqual(strictMarker.writeRoots, [await fs.realpath(workspaceDirectory)]);
  assert.equal(Object.prototype.propertyIsEnumerable.call(strictInvocationArgs, STRICT_TERMINAL_SANDBOX_INPUT), false);
  assert.deepEqual(Object.keys(strictInvocationArgs), [], 'sandbox roots must not become model-visible string arguments');

  for (const [status, exit, stdout, expected] of [
    ['completed', '0', 'status: failed\nexit_code: 42', false],
    ['failed', '1', 'status: completed\nexit_code: 0', true],
    ['completed', '2', '', true],
    ['killed', 'null', '', true],
    ['running', 'null', '', false],
  ]) {
    for (const [tool, envelope] of [['run_command', 'RUN_COMMAND'], ['get_command_output', 'COMMAND_OUTPUT']]) {
      const terminalExecutor = new IdeToolBrokerHostCapabilityExecutor({ invokeDirect: async () => ({
        text: `=== ${envelope} BEGIN ===\nstatus: ${status}\nexit_code: ${exit}\n--- OUTPUT BEGIN ---\n${stdout}\n--- OUTPUT END ---\n=== ${envelope} END ===`, isError: false,
      }) }, { tasks, workspaceRoots: () => [workspaceDirectory] });
      const terminalResult = await terminalExecutor.execute(request(tool), getCapabilityMetadata(tool));
      assert.equal(terminalResult.isError, expected, 'only the host header decides command failure, never stdout');
      assert.equal(terminalResult.data.commandStatus, status);
    }
  }

  const fileExecutor = new FileToolHostCapabilityExecutor({ workspaceRoots: () => [workspaceDirectory] });
  const router = new HostCapabilityExecutorRouter([executor, fileExecutor]);
  const fileResult = await router.execute({
    ...request('read_files'),
    arguments: { files: [{ path: 'note.txt' }] },
  }, getCapabilityMetadata('read_files'));
  assert.match(fileResult.text, /ROUTER_FILE_OK/);
  const partialRead = await router.execute({ ...request('read_files'), arguments: { files: [{ path: 'note.txt' }, { path: 'missing.txt' }] } }, getCapabilityMetadata('read_files'));
  assert.equal(partialRead.isError, true, 'partial read failure must stop a web turn');
  assert.match(partialRead.text, /ROUTER_FILE_OK/);
  assert.match(partialRead.text, /FILE_NOT_FOUND/);
  const outsideRead = await router.execute({ ...request('read_files'), arguments: { files: [{ path: bundlePath }] } }, getCapabilityMetadata('read_files'));
  assert.equal(outsideRead.isError, true);
  assert.match(outsideRead.text, /PATH_OUTSIDE_WORKSPACE/);
  assert.deepEqual(calls, [{ name: 'list_directory', args: { path: '.' } }], 'runtime/file capability must not fall through to IdeToolBroker');
  const routedList = await router.execute({ ...request('list_directory'), arguments: { path: '.' } }, getCapabilityMetadata('list_directory'));
  assert.equal(routedList.text, 'BROKER:list_directory');
  await assert.rejects(
    () => new HostCapabilityExecutorRouter([]).execute(request('list_directory'), getCapabilityMetadata('list_directory')),
    /No host capability executor owns/,
  );
  await assert.rejects(
    () => new HostCapabilityExecutorRouter([executor, executor]).execute(request('list_directory'), getCapabilityMetadata('list_directory')),
    /Multiple host capability executors claim/,
  );

  console.log('[smoke] host capability metadata authorization + IDE/file executor routing boundary ok');
} finally {
  await Promise.all([
    fs.rm(bundleDirectory, { recursive: true, force: true }),
    fs.rm(workspaceDirectory, { recursive: true, force: true }),
  ]);
}
