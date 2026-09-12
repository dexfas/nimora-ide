/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// SHUNCODE_FORK: Sync bundled language packs into `languagepacks.json` so locales
// that ship inside `extensions/` already work on the very first launch.
//
// Stock Code-OSS only (re)writes `languagepacks.json` from the extension
// management service, which runs long after the main process resolved its NLS
// configuration; a bundled language pack therefore only became effective from
// the second start. This bootstrap mirrors the stock writer's exact data format
// (see `vs/platform/languagePacks/node/languagePacks.ts`) so the entry exists
// before `resolveNLSConfiguration` reads it, and later stock rewrites of the
// file are content-identical no-ops.

interface ILanguagePackTranslationContribution {
	readonly id: string;
	readonly path: string;
}

interface ILanguagePackLocalization {
	readonly languageId: string;
	readonly languageName?: string;
	readonly localizedLanguageName?: string;
	readonly translations: readonly ILanguagePackTranslationContribution[];
}

interface ILanguagePackManifest {
	readonly publisher: string;
	readonly name: string;
	readonly version: string;
	readonly contributes?: { readonly localizations?: readonly ILanguagePackLocalization[] };
}

interface ISyncedLanguagePack {
	readonly hash: string;
	readonly extensions: readonly { readonly extensionIdentifier: { readonly id: string }; readonly version: string }[];
	readonly translations: { readonly [id: string]: string };
	readonly label: string | undefined;
}

const BUILT_IN_LANGUAGE_PACK_PREFIX = 'vscode-language-pack-';

/**
 * Register every bundled `vscode-language-pack-*` extension in the user data
 * `languagepacks.json`, preserving entries of user-installed packs of other
 * languages. Idempotent: the file is only rewritten when content changes.
 */
export async function syncBuiltInLanguagePacks(userDataPath: string, nlsMetadataPath: string): Promise<void> {
	const extensionsRoot = await findExtensionsRoot(nlsMetadataPath);
	if (!extensionsRoot) {
		return;
	}

	const synced = await readBuiltInLanguagePacks(extensionsRoot);
	const languages = Object.keys(synced);
	if (!languages.length) {
		return;
	}

	const configFile = path.join(userDataPath, 'languagepacks.json');
	let current: Record<string, unknown>;
	try {
		current = JSON.parse(await fs.readFile(configFile, 'utf-8'));
	} catch {
		current = {};
	}

	let changed = false;
	for (const language of languages) {
		if (JSON.stringify(current[language]) !== JSON.stringify(synced[language])) {
			current[language] = synced[language];
			changed = true;
		}
	}
	if (!changed) {
		return;
	}

	await fs.mkdir(path.dirname(configFile), { recursive: true });
	await fs.writeFile(configFile, JSON.stringify(current), 'utf-8');
}

async function findExtensionsRoot(nlsMetadataPath: string): Promise<string | undefined> {
	// Packaged builds resolve NLS metadata in `<app>/out` with extensions in
	// `<app>/extensions`; fall back to flat layouts for robustness.
	for (const candidate of [path.join(nlsMetadataPath, '..', 'extensions'), path.join(nlsMetadataPath, 'extensions')]) {
		try {
			if ((await fs.stat(candidate)).isDirectory()) {
				return candidate;
			}
		} catch {
			// try the next candidate
		}
	}
	return undefined;
}

async function readBuiltInLanguagePacks(extensionsRoot: string): Promise<Record<string, ISyncedLanguagePack>> {
	const result: Record<string, ISyncedLanguagePack> = {};
	let directories: string[];
	try {
		directories = (await fs.readdir(extensionsRoot, { withFileTypes: true }))
			.filter(entry => entry.isDirectory() && entry.name.startsWith(BUILT_IN_LANGUAGE_PACK_PREFIX))
			.map(entry => entry.name);
	} catch {
		return result;
	}

	for (const directory of directories) {
		const packRoot = path.join(extensionsRoot, directory);
		let manifest: ILanguagePackManifest;
		try {
			manifest = JSON.parse(await fs.readFile(path.join(packRoot, 'package.json'), 'utf-8'));
		} catch {
			continue;
		}
		if (typeof manifest.publisher !== 'string' || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
			continue;
		}

		const extensionId = `${manifest.publisher}.${manifest.name}`;
		for (const localization of manifest.contributes?.localizations ?? []) {
			if (!isValidLocalization(localization)) {
				continue;
			}
			const translations: { [id: string]: string } = {};
			for (const translation of localization.translations) {
				translations[translation.id] = path.join(packRoot, translation.path);
			}
			// The stock NLS resolution requires the core `vscode` translation file
			// to exist; skip packs that cannot satisfy it.
			if (typeof translations['vscode'] !== 'string' || !(await fileExists(translations['vscode']))) {
				continue;
			}

			// Mirror `updateHash` in the stock language pack service so the NLS
			// cache folders match the ones computed later by the extension scanner.
			const md5 = createHash('md5');
			md5.update(extensionId).update(manifest.version);
			result[localization.languageId] = {
				hash: md5.digest('hex'),
				extensions: [{ extensionIdentifier: { id: extensionId }, version: manifest.version }],
				translations,
				label: localization.localizedLanguageName ?? localization.languageName
			};
		}
	}
	return result;
}

function isValidLocalization(localization: ILanguagePackLocalization): boolean {
	if (typeof localization.languageId !== 'string' || !localization.languageId) {
		return false;
	}
	if (!Array.isArray(localization.translations) || localization.translations.length === 0) {
		return false;
	}
	return localization.translations.every(translation =>
		typeof translation.id === 'string' && !!translation.id
		&& typeof translation.path === 'string' && !!translation.path
		&& !path.isAbsolute(translation.path)
	);
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}
