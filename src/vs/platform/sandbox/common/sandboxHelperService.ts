/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../instantiation/common/instantiation.js';

export const ISandboxHelperService = createDecorator<ISandboxHelperService>('sandboxHelperService');

export interface ISandboxDependencyStatus {
	readonly bubblewrapInstalled: boolean;
	readonly bubblewrapUsable: boolean;
	readonly socatInstalled: boolean;
	readonly bubblewrapError?: string;
	readonly dependencyInstallCommand?: string;
	readonly apparmorRestrictsUnprivilegedUserNamespaces?: boolean;
}

export interface IWindowsMxcFilesystemPolicy {
	readonly readonlyPaths: string[];
	readonly readwritePaths: string[];
}

export interface IWindowsMxcPlatformSupport {
	readonly isSupported: boolean;
	readonly availableMethods: string[];
	readonly isolationTier?: 'base-container' | 'appcontainer-bfs' | 'appcontainer-dacl';
	readonly isolationWarnings?: string[];
}

/**
 * Stable unattended execution refuses MXC's DACL-mutation fallback. The caller
 * must have a process-container backend whose isolation is provided by
 * BaseContainer or AppContainer+BFS instead of host ACL rewriting.
 */
export function assertWindowsMxcStableIsolationSupport(support: IWindowsMxcPlatformSupport | undefined): void {
	if (!support?.isSupported || !support.availableMethods.includes('processcontainer') || !support.isolationTier) {
		throw new Error('Strict terminal sandbox requires a verified Windows MXC process-container isolation tier');
	}
	if (support.isolationTier === 'appcontainer-dacl') {
		const detail = support.isolationWarnings?.length ? ` ${support.isolationWarnings.join(' | ')}` : '';
		throw new Error(`Strict terminal sandbox rejects the AppContainer+DACL fallback; BaseContainer or AppContainer+BFS is required for Stable execution.${detail}`);
	}
}

/** Sandbox policy passed to the Windows MXC helper process. */
export interface IWindowsMxcSandboxPolicy {
	version: string;
	filesystem?: {
		readwritePaths?: string[];
		readonlyPaths?: string[];
		deniedPaths?: string[];
		clearPolicyOnExit?: boolean;
	};
	network?: {
		allowOutbound?: boolean;
		allowLocalNetwork?: boolean;
		allowedHosts?: string[];
		blockedHosts?: string[];
		proxy?: { builtinTestServer: true } | { localhost: number } | { url: string };
	};
	ui?: {
		allowWindows?: boolean;
		clipboard?: 'none' | 'read' | 'write' | 'all';
		allowInputInjection?: boolean;
	};
	timeoutMs?: number;
}

/** MXC payload returned by the Windows sandbox helper. */
export interface IWindowsMxcConfig {
	version: string;
	containerId?: string;
	containment?: IWindowsMxcPolicyContainment;
	lifecycle?: {
		destroyOnExit?: boolean;
		preservePolicy?: boolean;
	};
	process?: {
		commandLine: string;
		cwd?: string;
		env?: string[];
		timeout?: number;
	};
	processContainer?: {
		leastPrivilege?: boolean;
		capabilities?: string[];
		ui?: {
			isolation: 'desktop' | 'handles' | 'atoms' | 'container';
			desktopSystemControl: boolean;
			systemSettings: string;
			ime: boolean;
		};
	};
	filesystem?: {
		readwritePaths?: string[];
		readonlyPaths?: string[];
		deniedPaths?: string[];
		clearPolicyOnExit?: boolean;
	};
	network?: {
		enforcementMode?: 'capabilities' | 'firewall' | 'both';
		defaultPolicy?: 'allow' | 'block';
		allowLocalNetwork?: boolean;
		allowedHosts?: string[];
		blockedHosts?: string[];
		proxy?: { builtinTestServer: true } | { localhost: number } | { url: string };
		removeRulesOnExit?: boolean;
	};
	ui?: {
		disable: boolean;
		clipboard: 'none' | 'read' | 'write' | 'all';
		injection: boolean;
	};
}

export type IWindowsMxcPolicyContainment = 'process' | 'vm' | 'microvm' | 'processcontainer' | 'windows_sandbox' | 'wslc' | 'lxc' | 'hyperlight' | 'seatbelt' | 'isolation_session' | 'bubblewrap';

export interface ISandboxHelperService {
	readonly _serviceBrand: undefined;
	checkSandboxDependencies(): Promise<ISandboxDependencyStatus | undefined>;
	getWindowsMxcPlatformSupport?(): Promise<IWindowsMxcPlatformSupport | undefined>;
	getWindowsMxcFilesystemPolicy(): Promise<IWindowsMxcFilesystemPolicy | undefined>;
	getWindowsMxcEnvironment(): Promise<string[] | undefined>;
	buildWindowsMxcSandboxPayload(commandLine: string, policy: IWindowsMxcSandboxPolicy, workingDirectory?: string, containerName?: string, containment?: IWindowsMxcPolicyContainment): Promise<IWindowsMxcConfig | undefined>;
}
