import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDir = path.join(repoRoot, 'extensions', 'shuncode', 'runtime');

async function smokeAgentHost(): Promise<void> {
	const entry = path.join(runtimeDir, 'agent-host.js');
	const child = spawn(process.execPath, [entry], {
		cwd: repoRoot,
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');

	let stderr = '';
	child.stderr.on('data', chunk => stderr += chunk);
	const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
	const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error(`Agent host smoke test timed out. stderr=${stderr}`)), 10_000);
		lines.once('line', line => {
			clearTimeout(timeout);
			try {
				resolve(JSON.parse(line) as Record<string, unknown>);
			} catch (error) {
				reject(error);
			}
		});
		child.once('error', error => {
			clearTimeout(timeout);
			reject(error);
		});
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'runtime/hello', params: {} })}\n`);
	});

	const result = response.result as Record<string, unknown> | undefined;
	assert.equal(response.jsonrpc, '2.0');
	assert.equal(response.id, 1);
	assert.equal(result?.name, 'shuncode-agent-host');
	assert.ok(Array.isArray(result?.tools) && result.tools.includes('read_files'), 'agent host should expose read_files');

	child.stdin.end();
	await Promise.race([
		once(child, 'exit'),
		new Promise<void>(resolve => setTimeout(() => {
			child.kill();
			resolve();
		}, 2_000)),
	]);
	lines.close();
	console.log('[smoke] agent-host runtime/hello ok');
}

async function smokeMcpServer(): Promise<void> {
	const entry = path.join(runtimeDir, 'mcp-server.js');
	const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
	env.MCP_WORKSPACE_ROOTS = repoRoot;
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: [entry],
		cwd: repoRoot,
		env,
	});
	const client = new Client({ name: 'shuncode-runtime-smoke', version: '1.0.0' });
	try {
		await client.connect(transport);
		const listed = await client.listTools();
		const names = new Set(listed.tools.map(tool => tool.name));
		for (const expected of ['apply_patch', 'find_files', 'read_files', 'search_files']) {
			assert.ok(names.has(expected), `MCP server should expose ${expected}`);
		}
		const readTool = listed.tools.find(tool => tool.name === 'read_files');
		const patchTool = listed.tools.find(tool => tool.name === 'apply_patch');
		assert.equal(readTool?.annotations?.readOnlyHint, true, 'read_files should advertise read-only MCP semantics');
		assert.equal(patchTool?.annotations?.destructiveHint, true, 'apply_patch should advertise destructive MCP semantics');
		assert.equal((readTool?._meta?.['nimora/capability'] as { retry?: unknown } | undefined)?.retry, 'automatic');
		assert.equal((patchTool?._meta?.['nimora/capability'] as { retry?: unknown } | undefined)?.retry, 'never');

		const searched = await client.callTool({
			name: 'search_files',
			arguments: {
				pattern: 'Nimora IDE',
				path: '.',
				include: ['README.md'],
				max_results: 5,
			},
		});
		assert.notEqual(searched.isError, true, 'search_files smoke call should succeed');
		const text = searched.content
			.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
			.map(part => part.text)
			.join('\n');
		assert.match(text, /README\.md/);
		assert.match(text, /Nimora IDE/);
	} finally {
		await client.close();
	}
	console.log('[smoke] MCP listTools + search_files ok');
}

await smokeAgentHost();
await smokeMcpServer();
console.log('[smoke] ShunCode runtime smoke test passed');
