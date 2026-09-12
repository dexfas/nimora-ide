/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as fs from 'original-fs';
import * as os from 'node:os';
import { performance } from 'node:perf_hooks';
import { configurePortable } from './bootstrap-node.js';
import { bootstrapESM } from './bootstrap-esm.js';
import { app, protocol, crashReporter, Menu, contentTracing } from 'electron';
import minimist from 'minimist';
import { product } from './bootstrap-meta.js';
import { parse } from './vs/base/common/jsonc.js';
import { getUserDataPath } from './vs/platform/environment/node/userDataPath.js';
import * as perf from './vs/base/common/performance.js';
import { resolveNLSConfiguration } from './vs/base/node/nls.js';
import { getUNCHost, addUNCHostToAllowlist } from './vs/base/node/unc.js';
import { INLSConfiguration } from './vs/nls.js';
import { NativeParsedArgs } from './vs/platform/environment/common/argv.js';

perf.mark('code/didStartMain');

perf.mark('code/willLoadMainBundle', {
	// When built, the main bundle is a single JS file with all
	// dependencies inlined. As such, we mark `willLoadMainBundle`
	// as the start of the main bundle loading process.
	startTime: Math.floor(performance.timeOrigin)
});
perf.mark('code/didLoadMainBundle');

// Enable portable support
const portable = configurePortable(product);

const args = parseCLIArgs();
// Configure static command line arguments
const argvConfig = configureCommandlineSwitchesSync(args);
// Enable sandbox globally unless
// 1) disabled via command line using either
//    `--no-sandbox` or `--disable-chromium-sandbox` argument.
// 2) argv.json contains `disable-chromium-sandbox: true`.
if (args['sandbox'] &&
	!args['disable-chromium-sandbox'] &&
	!argvConfig['disable-chromium-sandbox']) {
	app.enableSandbox();
} else if (app.commandLine.hasSwitch('no-sandbox') &&
	!app.commandLine.hasSwitch('disable-gpu-sandbox')) {
	// Disable GPU sandbox whenever --no-sandbox is used.
	app.commandLine.appendSwitch('disable-gpu-sandbox');
} else {
	app.commandLine.appendSwitch('no-sandbox');
	app.commandLine.appendSwitch('disable-gpu-sandbox');
}

// Set userData path before app 'ready' event
const userDataPath = getUserDataPath(args, product.nameShort ?? 'code-oss-dev');
if (process.platform === 'win32') {
	const userDataUNCHost = getUNCHost(userDataPath);
	if (userDataUNCHost) {
		addUNCHostToAllowlist(userDataUNCHost); // enables to use UNC paths in userDataPath
	}
}
app.setPath('userData', userDataPath);

// Clear stale per-build caches (see `clearStaleBuildCaches` below) before any
// Electron session or window exists so a build change can never start with a
// black window.
clearStaleBuildCaches(userDataPath);

// ShunCode: even with every cache clean, machine-specific GPU failures can
// still leave the first window black on some machines (Windows 10: GPU-process
// crash loops on older Intel/NVIDIA Optimus drivers, GPU sandbox launch
// failures incl. broken folder ACLs, ANGLE D3D11 backend issues on newer
// NVIDIA drivers; Windows 11: the 25H2/Insider GPU-sandbox crash). Detect the
// failure and record a progressively stronger fallback for the next manual
// launch. ShunCode must never restart itself; every step is recorded in
// `shuncode-startup.log` so the cause is always identifiable on the affected
// machine.
appendStartupDiag(userDataPath, `platform ${os.platform()} ${os.release()} electron ${process.versions.electron} chrome ${process.versions.chrome}`);
migrateBrokenPaintWatchdogFallback(userDataPath);
applyGpuCrashFallback(userDataPath);
registerGpuCrashFallbackListeners(userDataPath);
registerFirstFrameWatchdog(userDataPath);

// Resolve code cache path
const codeCachePath = getCodeCachePath();

// Disable default menu (https://github.com/electron/electron/issues/35512)
Menu.setApplicationMenu(null);

// Configure crash reporter
perf.mark('code/willStartCrashReporter');
// If a crash-reporter-directory is specified we store the crash reports
// in the specified directory and don't upload them to the crash server.
//
// Appcenter crash reporting is enabled if
// * enable-crash-reporter runtime argument is set to 'true'
// * --disable-crash-reporter command line parameter is not set
//
// Disable crash reporting in all other cases.
if (args['crash-reporter-directory'] || (argvConfig['enable-crash-reporter'] && !args['disable-crash-reporter'])) {
	configureCrashReporter();
}
perf.mark('code/didStartCrashReporter');

// Set logs path before app 'ready' event if running portable
// to ensure that no 'logs' folder is created on disk at a
// location outside of the portable directory
// (https://github.com/microsoft/vscode/issues/56651)
if (portable.isPortable) {
	app.setAppLogsPath(path.join(userDataPath, 'logs'));
}

// Register custom schemes with privileges
protocol.registerSchemesAsPrivileged([
	{
		scheme: 'vscode-webview',
		privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, allowServiceWorkers: true, codeCache: true }
	},
	{
		scheme: 'vscode-file',
		privileges: { secure: true, standard: true, supportFetchAPI: true, corsEnabled: true, codeCache: true }
	},
	{
		scheme: 'vscode-remote-resource',
		privileges: { secure: true, supportFetchAPI: true, corsEnabled: true }
	},
	{
		scheme: 'vscode-managed-remote-resource',
		privileges: { secure: true, supportFetchAPI: true, corsEnabled: true }
	}
]);

// Global app listeners
registerListeners();

/**
 * We can resolve the NLS configuration early if it is defined
 * in argv.json before `app.ready` event. Otherwise we can only
 * resolve NLS after `app.ready` event to resolve the OS locale.
 */
let nlsConfigurationPromise: Promise<INLSConfiguration> | undefined = undefined;

// Use the most preferred OS language for language recommendation.
// The API might return an empty array on Linux, such as when
// the 'C' locale is the user's only configured locale.
// No matter the OS, if the array is empty, default back to 'en'.
const osLocale = processZhLocale((app.getPreferredSystemLanguages()?.[0] ?? 'en').toLowerCase());
// SHUNCODE_FORK: default to the bundled Simplified Chinese language pack
// (extensions/vscode-language-pack-zh-hans) when the user has not picked a
// display language via --locale or argv.json. Users can still opt out by
// setting "locale": "en" in argv.json or by passing --locale en.
const userLocale = getUserDefinedLocale(argvConfig) ?? 'zh-cn';
if (userLocale) {
	nlsConfigurationPromise = resolveNLSConfiguration({
		userLocale,
		osLocale,
		commit: getNLSBuildKey(),
		userDataPath,
		nlsMetadataPath: import.meta.dirname
	});
}

// Pass in the locale to Electron so that the
// Windows Control Overlay is rendered correctly on Windows.
// For now, don't pass in the locale on macOS due to
// https://github.com/microsoft/vscode/issues/167543.
// If the locale is `qps-ploc`, the Microsoft
// Pseudo Language Language Pack is being used.
// In that case, use `en` as the Electron locale.

if (process.platform === 'win32' || process.platform === 'linux') {
	const electronLocale = (!userLocale || userLocale === 'qps-ploc') ? 'en' : userLocale;
	app.commandLine.appendSwitch('lang', electronLocale);
}

// Load our code once ready
app.once('ready', function () {
	if (args['trace']) {
		let traceOptions: Electron.TraceConfig | Electron.TraceCategoriesAndOptions;
		if (args['trace-memory-infra']) {
			const customCategories = args['trace-category-filter']?.split(',') || [];
			customCategories.push('disabled-by-default-memory-infra', 'disabled-by-default-memory-infra.v8.code_stats');
			traceOptions = {
				included_categories: customCategories,
				excluded_categories: ['*'],
				memory_dump_config: {
					allowed_dump_modes: ['light', 'detailed'],
					triggers: [
						{
							type: 'periodic_interval',
							mode: 'detailed',
							min_time_between_dumps_ms: 10000
						},
						{
							type: 'periodic_interval',
							mode: 'light',
							min_time_between_dumps_ms: 1000
						}
					]
				}
			};
		} else {
			traceOptions = {
				categoryFilter: args['trace-category-filter'] || '*',
				traceOptions: args['trace-options'] || 'record-until-full,enable-sampling'
			};
		}

		contentTracing.startRecording(traceOptions).finally(() => onReady());
	} else {
		onReady();
	}
});

async function onReady() {
	perf.mark('code/mainAppReady');

	try {
		try {
			appendStartupDiag(userDataPath, 'gpu feature status: ' + JSON.stringify(app.getGPUFeatureStatus()));
		} catch {
			// best effort
		}
		const [, nlsConfig] = await Promise.all([
			mkdirpIgnoreError(codeCachePath),
			resolveNlsConfiguration()
		]);

		await startup(codeCachePath, nlsConfig);
	} catch (error) {
		console.error(error);
	}
}

/**
 * Main startup routine
 */
async function startup(codeCachePath: string | undefined, nlsConfig: INLSConfiguration): Promise<void> {
	process.env['VSCODE_NLS_CONFIG'] = JSON.stringify(nlsConfig);
	process.env['VSCODE_CODE_CACHE_PATH'] = codeCachePath || '';

	// Bootstrap ESM
	await bootstrapESM();

	// Load Main
	await import('./vs/code/electron-main/main.js');
	perf.mark('code/didRunMainBundle');
}

function configureCommandlineSwitchesSync(cliArgs: NativeParsedArgs) {
	const SUPPORTED_ELECTRON_SWITCHES = [

		// alias from us for --disable-gpu
		'disable-hardware-acceleration',

		// override for the color profile to use
		'force-color-profile',

		// disable LCD font rendering, a Chromium flag
		'disable-lcd-text',

		// bypass any specified proxy for the given semi-colon-separated list of hosts
		'proxy-bypass-list',

		'remote-debugging-port'
	];

	if (process.platform === 'linux') {

		// Force enable screen readers on Linux via this flag
		SUPPORTED_ELECTRON_SWITCHES.push('force-renderer-accessibility');

		// override which password-store is used on Linux
		SUPPORTED_ELECTRON_SWITCHES.push('password-store');
	}

	const SUPPORTED_MAIN_PROCESS_SWITCHES = [

		// Persistently enable proposed api via argv.json: https://github.com/microsoft/vscode/issues/99775
		'enable-proposed-api',

		// Log level to use. Default is 'info'. Allowed values are 'error', 'warn', 'info', 'debug', 'trace', 'off'.
		'log-level',

		// Use an in-memory storage for secrets
		'use-inmemory-secretstorage',

		// Enables display tracking to restore maximized windows under RDP: https://github.com/electron/electron/issues/47016
		'enable-rdp-display-tracking',
	];

	// Read argv config
	const argvConfig = readArgvConfigSync();

	Object.keys(argvConfig).forEach(argvKey => {
		const argvValue = argvConfig[argvKey];

		// Append Electron flags to Electron
		if (SUPPORTED_ELECTRON_SWITCHES.indexOf(argvKey) !== -1) {
			if (argvValue === true || argvValue === 'true') {
				if (argvKey === 'disable-hardware-acceleration') {
					app.disableHardwareAcceleration(); // needs to be called explicitly
				} else {
					app.commandLine.appendSwitch(argvKey);
				}
			} else if (typeof argvValue === 'string' && argvValue) {
				if (argvKey === 'password-store') {
					// Password store
					// TODO@TylerLeonhardt: Remove this migration in 3 months
					let migratedArgvValue = argvValue;
					if (argvValue === 'gnome' || argvValue === 'gnome-keyring') {
						migratedArgvValue = 'gnome-libsecret';
					}
					app.commandLine.appendSwitch(argvKey, migratedArgvValue);
				} else {
					app.commandLine.appendSwitch(argvKey, argvValue);
				}
			}
		}

		// Append main process flags to process.argv
		else if (SUPPORTED_MAIN_PROCESS_SWITCHES.indexOf(argvKey) !== -1) {
			switch (argvKey) {
				case 'enable-proposed-api':
					if (Array.isArray(argvValue)) {
						argvValue.forEach(id => id && typeof id === 'string' && process.argv.push('--enable-proposed-api', id));
					} else {
						console.error(`Unexpected value for \`enable-proposed-api\` in argv.json. Expected array of extension ids.`);
					}
					break;

				case 'log-level':
					if (typeof argvValue === 'string') {
						process.argv.push('--log', argvValue);
					} else if (Array.isArray(argvValue)) {
						for (const value of argvValue) {
							process.argv.push('--log', value);
						}
					}
					break;

				case 'use-inmemory-secretstorage':
					if (argvValue) {
						process.argv.push('--use-inmemory-secretstorage');
					}
					break;

				case 'enable-rdp-display-tracking':
					if (argvValue) {
						process.argv.push('--enable-rdp-display-tracking');
					}
					break;
			}
		}
	});

	// Following features are enabled from the runtime:
	// `NetAdapterMaxBufSizeFeature` - Specify the max buffer size for NetToMojoPendingBuffer, refs https://github.com/microsoft/vscode/issues/268800
	// `DocumentPolicyIncludeJSCallStacksInCrashReports` - https://www.electronjs.org/docs/latest/api/web-frame-main#framecollectjavascriptcallstack-experimental
	// `EarlyEstablishGpuChannel` - Refs https://issues.chromium.org/issues/40208065
	// `EstablishGpuChannelAsync` - Refs https://issues.chromium.org/issues/40208065
	// `GlobalShortcutsPortal` - Enables Electron's `globalShortcut` (system-wide keybindings) on Linux Wayland via the XDG global shortcuts portal (no-op elsewhere)
	const featuresToEnable =
		`NetAdapterMaxBufSizeFeature:NetAdapterMaxBufSize/8192,DocumentPolicyIncludeJSCallStacksInCrashReports,EarlyEstablishGpuChannel,EstablishGpuChannelAsync${process.platform === 'linux' ? ',GlobalShortcutsPortal' : ''},${app.commandLine.getSwitchValue('enable-features')}`;
	app.commandLine.appendSwitch('enable-features', featuresToEnable);

	// Following features are disabled from the runtime:
	// `CalculateNativeWinOcclusion` - Disable native window occlusion tracker (https://groups.google.com/a/chromium.org/g/embedder-dev/c/ZF3uHHyWLKw/m/VDN2hDXMAAAJ)
	const featuresToDisable =
		`CalculateNativeWinOcclusion,${app.commandLine.getSwitchValue('disable-features')}`;
	app.commandLine.appendSwitch('disable-features', featuresToDisable);

	// Blink features to configure.
	// `FontMatchingCTMigration` - Siwtch font matching on macOS to Appkit (Refs https://github.com/microsoft/vscode/issues/224496#issuecomment-2270418470).
	// `StandardizedBrowserZoom` - Disable zoom adjustment for bounding box (https://github.com/microsoft/vscode/issues/232750#issuecomment-2459495394)
	const blinkFeaturesToDisable =
		`FontMatchingCTMigration,StandardizedBrowserZoom,${app.commandLine.getSwitchValue('disable-blink-features')}`;
	app.commandLine.appendSwitch('disable-blink-features', blinkFeaturesToDisable);

	// Support JS Flags
	const jsFlags = getJSFlags(cliArgs, argvConfig);
	if (jsFlags) {
		app.commandLine.appendSwitch('js-flags', jsFlags);
	}

	// Use portal version 4 that supports current_folder option
	// to address https://github.com/microsoft/vscode/issues/213780
	// Runtime sets the default version to 3, refs https://github.com/electron/electron/pull/44426
	app.commandLine.appendSwitch('xdg-portal-required-version', '4');

	// Increase the maximum number of active WebGL contexts as each terminal may
	// use up to 2
	app.commandLine.appendSwitch('max-active-webgl-contexts', '32');

	return argvConfig;
}

interface IArgvConfig {
	[key: string]: string | string[] | boolean | undefined;
	readonly locale?: string;
	readonly 'disable-lcd-text'?: boolean;
	readonly 'proxy-bypass-list'?: string;
	readonly 'disable-hardware-acceleration'?: boolean;
	readonly 'force-color-profile'?: string;
	readonly 'enable-crash-reporter'?: boolean;
	readonly 'crash-reporter-id'?: string;
	readonly 'enable-proposed-api'?: string[];
	readonly 'log-level'?: string | string[];
	readonly 'disable-chromium-sandbox'?: boolean;
	readonly 'use-inmemory-secretstorage'?: boolean;
	readonly 'enable-rdp-display-tracking'?: boolean;
	readonly 'remote-debugging-port'?: string;
	readonly 'js-flags'?: string;
}

function readArgvConfigSync(): IArgvConfig {

	// Read or create the argv.json config file sync before app('ready')
	const argvConfigPath = getArgvConfigPath();
	let argvConfig: IArgvConfig | undefined = undefined;
	try {
		argvConfig = parse(fs.readFileSync(argvConfigPath).toString());
	} catch (error) {
		if (error && error.code === 'ENOENT') {
			createDefaultArgvConfigSync(argvConfigPath);
		} else {
			console.warn(`Unable to read argv.json configuration file in ${argvConfigPath}, falling back to defaults (${error})`);
		}
	}

	// Fallback to default
	if (!argvConfig) {
		argvConfig = {};
	}

	return argvConfig;
}

function createDefaultArgvConfigSync(argvConfigPath: string): void {
	try {

		// Ensure argv config parent exists
		const argvConfigPathDirname = path.dirname(argvConfigPath);
		if (!fs.existsSync(argvConfigPathDirname)) {
			fs.mkdirSync(argvConfigPathDirname);
		}

		// Default argv content
		const defaultArgvConfigContent = [
			'// This configuration file allows you to pass permanent command line arguments to VS Code.',
			'// Only a subset of arguments is currently supported to reduce the likelihood of breaking',
			'// the installation.',
			'//',
			'// PLEASE DO NOT CHANGE WITHOUT UNDERSTANDING THE IMPACT',
			'//',
			'// NOTE: Changing this file requires a restart of VS Code.',
			'{',
			'	// Use software rendering instead of hardware accelerated rendering.',
			'	// This can help in cases where you see rendering issues in VS Code.',
			'	// "disable-hardware-acceleration": true',
			'}'
		];

		// Create initial argv.json with default content
		fs.writeFileSync(argvConfigPath, defaultArgvConfigContent.join('\n'));
	} catch (error) {
		console.error(`Unable to create argv.json configuration file in ${argvConfigPath}, falling back to defaults (${error})`);
	}
}

function getArgvConfigPath(): string {
	const vscodePortable = process.env['VSCODE_PORTABLE'];
	if (vscodePortable) {
		return path.join(vscodePortable, 'argv.json');
	}

	let dataFolderName = product.dataFolderName;
	if (process.env['VSCODE_DEV']) {
		dataFolderName = `${dataFolderName}-dev`;
	}

	return path.join(os.homedir(), dataFolderName!, 'argv.json');
}

function configureCrashReporter(): void {
	let crashReporterDirectory = args['crash-reporter-directory'];
	let submitURL = '';
	if (crashReporterDirectory) {
		crashReporterDirectory = path.normalize(crashReporterDirectory);

		if (!path.isAbsolute(crashReporterDirectory)) {
			console.error(`The path '${crashReporterDirectory}' specified for --crash-reporter-directory must be absolute.`);
			app.exit(1);
		}

		if (!fs.existsSync(crashReporterDirectory)) {
			try {
				fs.mkdirSync(crashReporterDirectory, { recursive: true });
			} catch (error) {
				console.error(`The path '${crashReporterDirectory}' specified for --crash-reporter-directory does not seem to exist or cannot be created.`);
				app.exit(1);
			}
		}

		// Crashes are stored in the crashDumps directory by default, so we
		// need to change that directory to the provided one
		console.log(`Found --crash-reporter-directory argument. Setting crashDumps directory to be '${crashReporterDirectory}'`);
		app.setPath('crashDumps', crashReporterDirectory);
	}

	// Otherwise we configure the crash reporter from product.json
	else {
		const appCenter = product.appCenter;
		if (appCenter) {
			const isWindows = (process.platform === 'win32');
			const isLinux = (process.platform === 'linux');
			const isDarwin = (process.platform === 'darwin');
			const crashReporterId = argvConfig['crash-reporter-id'];
			const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
			if (crashReporterId && uuidPattern.test(crashReporterId)) {
				if (isWindows) {
					switch (process.arch) {
						case 'x64':
							submitURL = appCenter['win32-x64'];
							break;
						case 'arm64':
							submitURL = appCenter['win32-arm64'];
							break;
					}
				} else if (isDarwin) {
					if (product.darwinUniversalAssetId) {
						submitURL = appCenter['darwin-universal'];
					} else {
						switch (process.arch) {
							case 'x64':
								submitURL = appCenter['darwin'];
								break;
							case 'arm64':
								submitURL = appCenter['darwin-arm64'];
								break;
						}
					}
				} else if (isLinux) {
					submitURL = appCenter['linux-x64'];
				}
				submitURL = submitURL.concat('&uid=', crashReporterId, '&iid=', crashReporterId, '&sid=', crashReporterId);
				// Send the id for child node process that are explicitly starting crash reporter.
				// For vscode this is ExtensionHost process currently.
				const argv = process.argv;
				const endOfArgsMarkerIndex = argv.indexOf('--');
				if (endOfArgsMarkerIndex === -1) {
					argv.push('--crash-reporter-id', crashReporterId);
				} else {
					// if the we have an argument "--" (end of argument marker)
					// we cannot add arguments at the end. rather, we add
					// arguments before the "--" marker.
					argv.splice(endOfArgsMarkerIndex, 0, '--crash-reporter-id', crashReporterId);
				}
			}
		}
	}

	// Start crash reporter for all processes
	const productName = (product.crashReporter ? product.crashReporter.productName : undefined) || product.nameShort;
	const companyName = (product.crashReporter ? product.crashReporter.companyName : undefined) || 'Microsoft';
	const uploadToServer = Boolean(!process.env['VSCODE_DEV'] && submitURL && !crashReporterDirectory);
	crashReporter.start({
		companyName,
		productName: process.env['VSCODE_DEV'] ? `${productName} Dev` : productName,
		submitURL,
		uploadToServer,
		compress: true,
		ignoreSystemCrashHandler: true
	});
}

function getJSFlags(cliArgs: NativeParsedArgs, argvConfig: IArgvConfig): string | null {
	const jsFlags: string[] = [];

	// Add any existing JS flags we already got from the command line
	if (cliArgs['js-flags']) {
		jsFlags.push(cliArgs['js-flags']);
	}

	// Add JS flags from runtime arguments (argv.json)
	if (typeof argvConfig['js-flags'] === 'string' && argvConfig['js-flags']) {
		jsFlags.push(argvConfig['js-flags']);
	}

	return jsFlags.length > 0 ? jsFlags.join(' ') : null;
}

function parseCLIArgs(): NativeParsedArgs {
	return minimist(process.argv, {
		string: [
			'user-data-dir',
			'locale',
			'js-flags',
			'crash-reporter-directory'
		],
		boolean: [
			'disable-chromium-sandbox',
		],
		default: {
			'sandbox': true
		},
		alias: {
			'no-sandbox': 'sandbox'
		}
	});
}

function registerListeners(): void {

	/**
	 * macOS: when someone drops a file to the not-yet running VSCode, the open-file event fires even before
	 * the app-ready event. We listen very early for open-file and remember this upon startup as path to open.
	 */
	const macOpenFiles: string[] = [];
	(globalThis as { macOpenFiles?: string[] }).macOpenFiles = macOpenFiles;
	app.on('open-file', function (event, path) {
		macOpenFiles.push(path);
	});

	/**
	 * macOS: react to open-url requests.
	 */
	const openUrls: string[] = [];
	const onOpenUrl =
		function (event: { preventDefault: () => void }, url: string) {
			event.preventDefault();

			openUrls.push(url);
		};

	app.on('will-finish-launching', function () {
		app.on('open-url', onOpenUrl);
	});

	(globalThis as { getOpenUrls?: () => string[] }).getOpenUrls = function () {
		app.removeListener('open-url', onOpenUrl);

		return openUrls;
	};
}

/**
 * ShunCode keeps the upstream carrier commit pinned while shipping local
 * workbench changes. Keying cached V8 data by commit alone can therefore load
 * bytecode from an older overwrite installation and leave the renderer blank.
 * The package step injects a hash of the built workbench bundle
 * (`product.shuncodeBuildId`); combined with the Electron version this forms a
 * build identity that changes whenever the shipped code or the runtime
 * changes, so every materially different package receives an isolated cache.
 */
function getShunCodeCacheIdentity(): string | undefined {
	const buildIdentity = product.shuncodeBuildId ?? product.date?.replace(/[^a-zA-Z0-9]/g, '') ?? product.commit;
	if (!buildIdentity) {
		return undefined;
	}
	return `${buildIdentity}-${process.versions.electron ?? ''}`;
}

/**
 * Key used for the language-pack NLS cache (`clp/<langpack>.<locale>/<key>`).
 * Upstream keys this by `product.commit`, which for ShunCode is a pinned
 * carrier commit that never changes between packages. The workbench bundle,
 * however, is rebuilt from local sources on every package, so its `localize`
 * id sequence drifts. An old NLS cache then keeps matching the new bundle and
 * the renderer throws `NLS MISSING: <id>` at module load time, leaving the
 * window black. Keying by `shuncodeBuildId` (the workbench bundle hash
 * injected at package time) makes the cache invalidate with every package.
 */
function getNLSBuildKey(): string | undefined {
	return product.shuncodeBuildId ?? product.commit;
}

function getCodeCacheKey(): string | undefined {
	const commit = product.commit;
	if (!commit) {
		return undefined;
	}
	const identity = getShunCodeCacheIdentity();
	return identity ? `${commit}-${identity}` : commit;
}

function getCodeCachePath(): string | undefined {

	// explicitly disabled via CLI args
	if (process.argv.indexOf('--no-cached-data') > 0) {
		return undefined;
	}

	// running out of sources
	if (process.env['VSCODE_DEV']) {
		return undefined;
	}

	// require commit id
	const cacheKey = getCodeCacheKey();
	return cacheKey ? path.join(userDataPath, 'CachedData', cacheKey) : undefined;
}

/**
 * ShunCode keeps the upstream carrier commit pinned while shipping local
 * workbench changes. An overwrite install can therefore leave Chromium/Electron
 * caches produced by a different build in the user data folder, and a stale GPU
 * cache or renderer bytecode cache makes the new window render black until the
 * folder is wiped manually. Whenever the build identity changes, delete the
 * regenerable cache folders before the first window opens. User settings,
 * extensions, workspace state, and authentication are preserved.
 */
function clearStaleBuildCaches(userDataPath: string): void {
	const buildIdentity = getShunCodeCacheIdentity();
	if (!buildIdentity) {
		return;
	}

	const markerPath = path.join(userDataPath, 'shuncode-cache-build');
	let lastBuild: string | undefined;
	try {
		lastBuild = fs.readFileSync(markerPath, 'utf8');
	} catch {
		// marker missing or unreadable: treat as build change and clean up
	}

	appendStartupDiag(userDataPath, `cache identity=${buildIdentity} lastMarker=${lastBuild ?? '(none)'}`);

	if (lastBuild !== buildIdentity) {
		// Regenerable Chromium/Electron caches only. Never touch `User`, `storage.json`,
		// `Local Storage`, `IndexedDB`, `logs`, `backup`, or anything else that holds
		// user-authored state.
		let allSucceeded = true;
		for (const dir of [
			'CachedData',
			'Code Cache',
			'Cache',
			'GPUCache',
			'DawnGraphiteCache',
			'DawnWebGPUCache',
			'Service Worker',
			'blob_storage',
			'CachedProfilesData',
			'GrShaderCache',
			'ShaderCache',
			// Language-pack NLS cache. It is derived from the language pack plus
			// the current bundle's nls.keys.json and is regenerated on the next
			// start, so deleting it is safe. See getNLSBuildKey() for the
			// stale-cache mechanism that causes `NLS MISSING` black screens
			// after an overwrite install.
			'clp'
		]) {
			try {
				fs.rmSync(path.join(userDataPath, dir), { recursive: true, force: true });
			} catch {
				// Locked (e.g. another instance is still running) or already gone.
				// Keep the stale marker so cleanup is retried on the next start
				// instead of being skipped forever.
				allSucceeded = false;
			}
		}

		appendStartupDiag(userDataPath, `cache cleanup ${allSucceeded ? 'complete' : 'partial (will retry next start)'}`);

		if (allSucceeded) {
			try {
				fs.mkdirSync(userDataPath, { recursive: true });
				fs.writeFileSync(markerPath, buildIdentity);
				appendStartupDiag(userDataPath, 'cache marker written');
			} catch {
				// if the marker cannot be persisted, cleanup runs again next start
			}
		}
	}

	// Self-heal: drop CachedData variants that do not match the current key.
	// Covers leftovers from builds that predate the marker and deletions that
	// failed while another instance was still running, without depending on
	// the marker having been written.
	sweepStaleCachedData(userDataPath);
}

function sweepStaleCachedData(userDataPath: string): void {
	const currentKey = getCodeCacheKey();
	if (!currentKey) {
		return;
	}

	const cachedDataRoot = path.join(userDataPath, 'CachedData');
	let entries: string[] = [];
	let removed = 0;
	try {
		entries = fs.readdirSync(cachedDataRoot);
	} catch {
		return; // no CachedData directory yet
	}

	for (const entry of entries) {
		if (entry === currentKey) {
			continue;
		}
		try {
			fs.rmSync(path.join(cachedDataRoot, entry), { recursive: true, force: true });
			removed++;
		} catch {
			// locked: retried on the next start
		}
	}
	if (removed > 0) {
		appendStartupDiag(userDataPath, `swept ${removed} stale CachedData dir(s)`);
	}
}

/**
 * Machine-specific GPU failures are the remaining black-window source after
 * cache cleanup. Windows 10 cases: GPU-process crash loops on older
 * Intel/NVIDIA Optimus drivers (electron#32440), GPU sandbox launch failures
 * including corrupt folder ACLs / zombie SIDs (electron#51761, vscode#146464),
 * and ANGLE D3D11 backend problems on newer NVIDIA drivers (electron#43122).
 * Windows 11 case: the 25H2/Insider GPU-sandbox crash (desktop/desktop#22424).
 * A previous session records the fallback stage in `shuncode-gpu-fallback`;
 * apply the matching switches before the first window exists.
 */
function applyGpuCrashFallback(userDataPath: string): void {
	const stage = getGpuFallbackStage(userDataPath);
	if (stage >= 1 && !app.commandLine.hasSwitch('disable-gpu-sandbox')) {
		app.commandLine.appendSwitch('disable-gpu-sandbox');
		appendStartupDiag(userDataPath, `gpu fallback stage=${stage}: disable-gpu-sandbox`);
	}
	if (stage >= 2 && app.commandLine.getSwitchValue('use-angle') !== 'gl') {
		app.commandLine.appendSwitch('use-angle', 'gl');
		appendStartupDiag(userDataPath, `gpu fallback stage=${stage}: use-angle=gl`);
	}
	if (stage >= 3 && !app.commandLine.hasSwitch('disable-gpu')) {
		app.commandLine.appendSwitch('disable-gpu');
		appendStartupDiag(userDataPath, `gpu fallback stage=${stage}: disable-gpu`);
	}
}

/**
 * Builds that listened for `webContents.paint` on a normal BrowserWindow
 * incorrectly escalated every healthy startup after 45 seconds. Undo only a
 * fallback whose most recent recorded cause is that exact false positive. A
 * fallback caused by a real GPU or renderer crash remains untouched.
 */
function migrateBrokenPaintWatchdogFallback(userDataPath: string): void {
	const migrationMarker = path.join(userDataPath, 'shuncode-gpu-watchdog-ready-to-show');
	if (fs.existsSync(migrationMarker)) {
		return;
	}

	try {
		const startupLog = fs.readFileSync(path.join(userDataPath, 'shuncode-startup.log'), 'utf8');
		const escalations = [...startupLog.matchAll(/escalating gpu fallback to stage \d+ \(cause=([^)]+)\)/g)];
		const lastCause = escalations.length ? escalations[escalations.length - 1][1] : undefined;
		if (lastCause === 'no-first-paint') {
			fs.rmSync(path.join(userDataPath, 'shuncode-gpu-fallback'), { force: true });
			appendStartupDiag(userDataPath, 'cleared false GPU fallback from legacy paint watchdog');
		}
	} catch {
		// No previous startup log means there is nothing to migrate.
	}

	try {
		fs.mkdirSync(userDataPath, { recursive: true });
		fs.writeFileSync(migrationMarker, 'ready-to-show');
	} catch {
		// Migration is best-effort and must never block startup.
	}
}

/**
 * Record GPU/renderer process failures in the startup log. A renderer that
 * crashes within the first minute of startup - the "black window" signature -
 * persists the next fallback stage and relaunches with it applied.
 */
function registerGpuCrashFallbackListeners(userDataPath: string): void {
	const startedAt = Date.now();
	app.on('child-process-gone', (_event, details) => {
		if (details.type === 'GPU' && (details.reason === 'crashed' || details.reason === 'killed')) {
			appendStartupDiag(userDataPath, `gpu process gone: ${details.reason} (exit=${details.exitCode})`);
			// A GPU process crash before the first frame is the classic
			// black-window signature on Windows 10 (driver / ANGLE / sandbox
			// ACL failures). Record the next fallback immediately instead of waiting for the
			// first-frame watchdog.
			if (!firstWindowPainted && Date.now() - startedAt < 60_000) {
				recordGpuFallback(userDataPath, 'gpu-process-crash-at-startup');
			}
		}
	});
	app.on('web-contents-created', (_event, contents) => {
		contents.on('render-process-gone', (_event, details) => {
			appendStartupDiag(userDataPath, `renderer gone: ${details.reason} (exit=${details.exitCode})`);
			if (Date.now() - startedAt < 60_000 && details.reason === 'crashed') {
				recordGpuFallback(userDataPath, 'renderer-crash-at-startup');
			}
		});
		// Capture renderer console errors during the first 2 minutes of startup
		// so silent workbench-load failures become visible in shuncode-startup.log.
		contents.on('console-message', (_event, level, message, _line, _sourceId) => {
			if (level >= 2 && Date.now() - startedAt < 120_000) { // 2 = warning, 3 = error
				const tag = level >= 3 ? 'renderer:error' : 'renderer:warn';
				appendStartupDiag(userDataPath, `[${tag}] ${message.slice(0, 500)}`);
			}
		});
	});
}

/**
 * If the first window never paints its first frame the user may be looking at
 * a black window. Persist the next GPU fallback stage and relaunch so the
 * fallback switches take effect immediately; slow-but-healthy starts relaunch
 * without escalating until they repeat.
 */
function registerFirstFrameWatchdog(userDataPath: string): void {
	let handled = false;
	app.on('browser-window-created', (_event, window) => {
		if (handled) {
			return;
		}
		handled = true;
		const contents = window.webContents;
		let readyToShow = false;
		let watchdog: ReturnType<typeof setTimeout> | undefined;
		const markReadyToShow = () => {
			readyToShow = true;
			firstWindowPainted = true;
			clearNoPaintHits(userDataPath);
			if (watchdog) {
				clearTimeout(watchdog);
				watchdog = undefined;
			}
			appendStartupDiag(userDataPath, 'first window ready to show');
		};

		// `webContents.paint` is only emitted for offscreen rendering. Listening
		// for it on a normal BrowserWindow makes every healthy startup look like a
		// black window and causes a relaunch every 45 seconds. `ready-to-show` is
		// the BrowserWindow signal that the renderer has produced its first frame.
		window.once('ready-to-show', markReadyToShow);
		window.once('closed', () => {
			if (watchdog) {
				clearTimeout(watchdog);
				watchdog = undefined;
			}
		});

		// Secondary watchdog: detect when the splash renders (ready-to-show) but
		// the workbench JS never finishes loading. In this state the primary
		// 45 s watchdog is cleared but the user sees only the dark splash forever.
		// The 'did-navigate-in-page' or IPC messages signal that workbench
		// initialization progressed past the import(). If none arrives within
		// 30 s after ready-to-show, the workbench import likely failed silently.
		let workbenchLoaded = false;
		const ipcHandler = () => { workbenchLoaded = true; };
		contents.ipc.once('vscode:startupTimers', ipcHandler);
		contents.ipc.once('vscode:extensionLog', ipcHandler);
		// The renderer sends 'vscode:toggleDevTools' or various ipc when workbench is alive;
		// Also watch for the "did-finish-load" (DOM ready + scripts executed)
		contents.once('did-finish-load', () => { workbenchLoaded = true; });

		window.once('ready-to-show', () => {
			setTimeout(() => {
				if (workbenchLoaded || window.isDestroyed()) {
					return;
				}
				appendStartupDiag(userDataPath, 'workbench did not initialize within 30s after ready-to-show (splash-only black screen)');
				// Unlike GPU fallback, this is a workbench-load failure that won't be
				// fixed by GPU switches. Log it and let the user know via a dialog.
				const { dialog } = require('electron') as typeof import('electron');
				dialog.showErrorBox(
					'ShunCode',
					'The application window failed to initialize. This may be caused by a corrupted installation or extension conflict.\n\n'
					+ 'Try launching with extensions disabled:\n'
					+ '  ShunCode.exe --disable-extensions\n\n'
					+ 'If the problem persists, delete the cache:\n'
					+ `  ${userDataPath}\\CachedData\n`
					+ `  ${userDataPath}\\Code Cache`
				);
			}, 30_000);
		});

		appendStartupDiag(userDataPath, 'first window created');
		watchdog = setTimeout(() => {
			watchdog = undefined;
			if (readyToShow || window.isDestroyed()) {
				return;
			}
			if (contents.isCrashed()) {
				appendStartupDiag(userDataPath, 'first window renderer crashed before first paint');
				recordGpuFallback(userDataPath, 'no-first-paint-crashed');
			} else {
				appendStartupDiag(userDataPath, 'first window did not paint within 45s');
				recordGpuFallback(userDataPath, 'no-first-paint');
			}
		}, 45_000);
	});
}

let firstWindowPainted = false;
let gpuFallbackRecorded = false;

/**
 * Automatic relaunches are the recovery path for the black-window session
 * itself: after the next fallback stage is persisted, restart with the new
 * switches instead of waiting for a manual relaunch that may never come. The
 * per-calendar-day budget (persisted in the user data folder, surviving
 * overwrite installs) guarantees a machine that fails every time cannot end
 * up in an endless restart loop.
 */
const SHUNCODE_AUTO_RELAUNCH_LIMIT_PER_DAY = 3;

interface ShunCodeNoPaintState {
	stage: number;
	hits: number;
}

function recordNoPaintHit(userDataPath: string, stage: number): number {
	const markerPath = path.join(userDataPath, 'shuncode-gpu-fallback-hits');
	let state: ShunCodeNoPaintState = { stage, hits: 0 };
	try {
		const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
		if (parsed && typeof parsed === 'object') {
			state = { stage: Number(parsed.stage) || 0, hits: Number(parsed.hits) || 0 };
		}
	} catch {
		// no state recorded yet
	}
	if (state.stage !== stage) {
		// stage changed since the last hit: start counting again
		state = { stage, hits: 0 };
	}
	state.hits += 1;
	try {
		fs.mkdirSync(userDataPath, { recursive: true });
		fs.writeFileSync(markerPath, JSON.stringify(state));
	} catch {
		// best effort; a failed write only makes escalation more conservative
	}
	return state.hits;
}

function clearNoPaintHits(userDataPath: string): void {
	try {
		fs.rmSync(path.join(userDataPath, 'shuncode-gpu-fallback-hits'), { force: true });
	} catch {
		// best effort
	}
}

function tryAutoRelaunchAfterGpuFailure(userDataPath: string, cause: string, fallbackStage: number): void {
	const today = new Date().toISOString().slice(0, 10);
	const markerPath = path.join(userDataPath, 'shuncode-auto-relaunch');
	let day = '';
	let count = 0;
	try {
		const state = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
		day = typeof state.day === 'string' ? state.day : '';
		count = Number(state.count) || 0;
	} catch {
		// no state recorded yet
	}
	if (day !== today) {
		day = today;
		count = 0;
	}
	if (count >= SHUNCODE_AUTO_RELAUNCH_LIMIT_PER_DAY) {
		appendStartupDiag(userDataPath, `auto relaunch budget exhausted for ${today} (cause=${cause}, stage=${fallbackStage})`);
		return;
	}
	count += 1;
	try {
		fs.mkdirSync(userDataPath, { recursive: true });
		fs.writeFileSync(markerPath, JSON.stringify({ day, count }));
	} catch {
		return; // cannot persist the budget; stay conservative and keep running
	}
	appendStartupDiag(userDataPath, `auto relaunching with gpu fallback stage ${fallbackStage} (cause=${cause}, budgetUsed=${count})`);
	setTimeout(() => {
		app.relaunch();
		app.exit(0);
	}, 500);
}

function recordGpuFallback(userDataPath: string, cause: string): void {
	if (gpuFallbackRecorded || process.env['VSCODE_DEV']) {
		return;
	}
	const stage = getGpuFallbackStage(userDataPath);
	if (stage >= 3) {
		gpuFallbackRecorded = true;
		appendStartupDiag(userDataPath, `gpu fallback already at final stage (cause=${cause}); automatic restart disabled`);
		return;
	}

	// Crashes are hard evidence and escalate immediately. A first window that
	// simply did not paint in time can also be a slow cold start (antivirus
	// scan, cache rebuild right after an overwrite install), so it only
	// escalates after two consecutive hits; the first hit relaunches with the
	// same stage and gives the machine another chance without degrading it.
	const crashEvidence = cause === 'gpu-process-crash-at-startup' || cause === 'renderer-crash-at-startup' || cause === 'no-first-paint-crashed';
	const escalate = crashEvidence || recordNoPaintHit(userDataPath, stage) >= 2;

	if (!escalate) {
		gpuFallbackRecorded = true;
		appendStartupDiag(userDataPath, `slow first start without crash evidence (cause=${cause}); keeping stage ${stage} and relaunching`);
		tryAutoRelaunchAfterGpuFailure(userDataPath, cause, stage);
		return;
	}

	const nextStage = stage + 1;
	try {
		fs.mkdirSync(userDataPath, { recursive: true });
		fs.writeFileSync(path.join(userDataPath, 'shuncode-gpu-fallback'), String(nextStage));
	} catch {
		return; // cannot persist the fallback flag; leave the current process running
	}
	gpuFallbackRecorded = true;
	appendStartupDiag(userDataPath, `recorded gpu fallback stage ${nextStage} (cause=${cause})`);
	tryAutoRelaunchAfterGpuFailure(userDataPath, cause, nextStage);
}

function appendStartupDiag(userDataPath: string, line: string): void {
	try {
		fs.mkdirSync(userDataPath, { recursive: true });
		fs.appendFileSync(path.join(userDataPath, 'shuncode-startup.log'), `${new Date().toISOString()} ${line}\n`);
	} catch {
		// diagnostics are best-effort; never block startup
	}
}

function getGpuFallbackStage(userDataPath: string): number {
	try {
		return Number(fs.readFileSync(path.join(userDataPath, 'shuncode-gpu-fallback'), 'utf8')) || 0;
	} catch {
		return 0;
	}
}

async function mkdirpIgnoreError(dir: string | undefined): Promise<string | undefined> {
	if (typeof dir === 'string') {
		try {
			await fs.promises.mkdir(dir, { recursive: true });

			return dir;
		} catch (error) {
			// ignore
		}
	}

	return undefined;
}

//#region NLS Support

function processZhLocale(appLocale: string): string {
	if (appLocale.startsWith('zh')) {
		const region = appLocale.split('-')[1];

		// On Windows and macOS, Chinese languages returned by
		// app.getPreferredSystemLanguages() start with zh-hans
		// for Simplified Chinese or zh-hant for Traditional Chinese,
		// so we can easily determine whether to use Simplified or Traditional.
		// However, on Linux, Chinese languages returned by that same API
		// are of the form zh-XY, where XY is a country code.
		// For China (CN), Singapore (SG), and Malaysia (MY)
		// country codes, assume they use Simplified Chinese.
		// For other cases, assume they use Traditional.
		if (['hans', 'cn', 'sg', 'my'].includes(region)) {
			return 'zh-cn';
		}

		return 'zh-tw';
	}

	return appLocale;
}

/**
 * Resolve the NLS configuration
 */
async function resolveNlsConfiguration(): Promise<INLSConfiguration> {

	// First, we need to test a user defined locale.
	// If it fails we try the app locale.
	// If that fails we fall back to English.

	const nlsConfiguration = nlsConfigurationPromise ? await nlsConfigurationPromise : undefined;
	if (nlsConfiguration) {
		return nlsConfiguration;
	}

	// Try to use the app locale which is only valid
	// after the app ready event has been fired.

	let userLocale = app.getLocale();
	if (!userLocale) {
		return {
			userLocale: 'en',
			osLocale,
			resolvedLanguage: 'en',
			defaultMessagesFile: path.join(import.meta.dirname, 'nls.messages.json'),

			// NLS: below 2 are a relic from old times only used by vscode-nls and deprecated
			locale: 'en',
			availableLanguages: {}
		};
	}

	// See above the comment about the loader and case sensitiveness
	userLocale = processZhLocale(userLocale.toLowerCase());

	return resolveNLSConfiguration({
		userLocale,
		osLocale,
		commit: getNLSBuildKey(),
		userDataPath,
		nlsMetadataPath: import.meta.dirname
	});
}

/**
 * Language tags are case insensitive however an ESM loader is case sensitive
 * To make this work on case preserving & insensitive FS we do the following:
 * the language bundles have lower case language tags and we always lower case
 * the locale we receive from the user or OS.
 */
function getUserDefinedLocale(argvConfig: IArgvConfig): string | undefined {
	const locale = args['locale'];
	if (locale) {
		return locale.toLowerCase(); // a directly provided --locale always wins
	}

	return typeof argvConfig?.locale === 'string' ? argvConfig.locale.toLowerCase() : undefined;
}

//#endregion
