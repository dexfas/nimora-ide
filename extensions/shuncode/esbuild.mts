/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import esbuild, { type BuildOptions, type Plugin } from 'esbuild';

const extensionDir = import.meta.dirname;
const repoRoot = path.resolve(extensionDir, '..', '..');
const extensionSrcDir = path.join(extensionDir, 'src');
const distDir = path.join(extensionDir, 'dist');
const runtimeDir = path.join(extensionDir, 'runtime');
const runtimeBinDir = path.join(runtimeDir, 'bin');

const require = createRequire(import.meta.url);
const { rgPath: sourceRipgrepPath } = require('@vscode/ripgrep') as { rgPath: string };
const ripgrepFileName = path.basename(sourceRipgrepPath);
const watch = process.argv.includes('--watch');

function packagedRipgrepPlugin(relativePath: readonly string[]): Plugin {
	const namespace = `shuncode-packaged-ripgrep-${relativePath.slice(0, -1).join('-') || 'bin'}`;
	return {
		name: namespace,
		setup(build) {
			build.onResolve({ filter: /^@vscode\/ripgrep$/ }, () => ({ path: namespace, namespace }));
			build.onLoad({ filter: /.*/, namespace }, () => ({
				contents: `export const rgPath = require("node:path").join(__dirname, ${relativePath.map(value => JSON.stringify(value)).join(', ')});`,
				loader: 'js',
			}));
		},
	};
}

const commonOptions: BuildOptions = {
	bundle: true,
	platform: 'node',
	format: 'cjs',
	target: ['es2022'],
	treeShaking: true,
	minify: false,
	sourcemap: true,
	sourcesContent: true,
	logLevel: 'info',
};

const extensionOptions: BuildOptions = {
	...commonOptions,
	entryPoints: [path.join(extensionSrcDir, 'extension.ts')],
	outfile: path.join(distDir, 'extension.js'),
	external: ['vscode'],
	plugins: [packagedRipgrepPlugin(['..', 'runtime', 'bin', ripgrepFileName])],
};

const runtimeOptions: BuildOptions = {
	...commonOptions,
	entryPoints: {
		'agent-host': path.join(repoRoot, 'src', 'agent-host.ts'),
		'mcp-server': path.join(repoRoot, 'src', 'mcp-server.ts'),
	},
	outdir: runtimeDir,
	banner: {
		js: 'const __shuncodeImportMetaUrl = require("node:url").pathToFileURL(__filename).href;',
	},
	define: {
		'import.meta.url': '__shuncodeImportMetaUrl',
	},
	plugins: [packagedRipgrepPlugin(['bin', ripgrepFileName])],
};

async function copyRipgrep(): Promise<void> {
	await fs.mkdir(runtimeBinDir, { recursive: true });
	const target = path.join(runtimeBinDir, ripgrepFileName);
	await fs.copyFile(sourceRipgrepPath, target);
	if (process.platform !== 'win32') {
		await fs.chmod(target, 0o755);
	}
}

async function cleanOutputs(): Promise<void> {
	await Promise.all([
		fs.rm(distDir, { recursive: true, force: true }),
		fs.rm(runtimeDir, { recursive: true, force: true }),
	]);
}

async function main(): Promise<void> {
	if (!watch) {
		await cleanOutputs();
	}
	await copyRipgrep();

	if (watch) {
		const [extensionContext, runtimeContext] = await Promise.all([
			esbuild.context(extensionOptions),
			esbuild.context(runtimeOptions),
		]);
		await Promise.all([extensionContext.watch(), runtimeContext.watch()]);
		console.log('[shuncode] watching extension and runtime bundles');
		return;
	}

	await Promise.all([
		esbuild.build(extensionOptions),
		esbuild.build(runtimeOptions),
	]);
	console.log(`[shuncode] built extension and runtime (${path.relative(repoRoot, sourceRipgrepPath)} -> extensions/shuncode/runtime/bin/${ripgrepFileName})`);
}

await main();
