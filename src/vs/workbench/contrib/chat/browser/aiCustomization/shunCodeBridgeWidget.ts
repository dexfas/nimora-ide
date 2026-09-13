/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/shunCodeBridgeWidget.css';
import * as dom from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { AICustomizationManagementSection } from '../../common/aiCustomizationWorkspaceService.js';
import { aiCustomizationManagementSectionRegistry, IAICustomizationManagementSectionWidget } from './aiCustomizationManagementSectionRegistry.js';
import { localizeBridge } from './shunCodeBridgeLocalization.js';

interface BridgeStatus {
	readonly state: 'stopped' | 'starting' | 'running' | 'error';
	readonly transport: 'streamable-http';
	readonly tunnelProvider: 'cloudflare' | 'cloudflare-named' | 'ngrok';
	readonly domain: string;
	readonly configuredDomain: string;
	readonly configuredNamedDomain: string;
	readonly namedTunnelTokenConfigured: boolean;
	readonly namedTunnelLocalPort: number;
	readonly namedTunnelOriginUrl: string;
	readonly localUrl?: string;
	readonly publicUrl?: string;
	readonly localPort?: number;
	readonly tunnelInstalled?: boolean;
	readonly tunnelVersion?: string;
	readonly tunnelConfigValid?: boolean;
	readonly lastError?: string;
	readonly toolNames: string[];
	readonly toolCount: number;
	readonly activeRequests: number;
	readonly health?: BridgeHealthReport;
}

interface BridgeHealthProbe {
	readonly ok: boolean;
	readonly url?: string;
	readonly latencyMs?: number;
	readonly error?: string;
}

interface BridgeHealthReport {
	readonly at: string;
	readonly ok: boolean;
	readonly state: BridgeStatus['state'];
	readonly durationMs: number;
	readonly local: BridgeHealthProbe;
	readonly public?: BridgeHealthProbe;
	readonly tunnelProcessAlive: boolean;
	readonly sessions: number;
	readonly activeRequests: number;
	readonly lastSessionActivityAt?: string;
	readonly summary: string;
}

interface BridgePaymentPlan {
	readonly id: string;
	readonly name: string;
	readonly amount: string;
	readonly amountCents: number;
	readonly durationDays: number | null;
}

interface BridgePaymentOrder {
	readonly id: string;
	readonly status: string;
	readonly checkoutUrl: string;
	readonly planId: string;
	readonly planName: string;
	readonly amount: string;
	readonly paymentType: string;
	readonly createdAt: string;
	readonly expiresAt: string;
	readonly paidAt: string;
	readonly entitlementExpiresAt: string;
	readonly error: string;
}

interface BridgeAccessStatus {
	readonly serverConfigured: boolean;
	readonly signedIn: boolean;
	readonly installationId: string;
	readonly githubUserId: string;
	readonly githubLogin: string;
	readonly giteeUserId: string;
	readonly giteeLogin: string;
	readonly email: string;
	readonly avatarUrl: string;
	readonly licensed: boolean;
	readonly expiresAt: string;
	readonly permanent: boolean;
	readonly error: string;
	readonly plans: BridgePaymentPlan[];
	readonly paymentTypes: string[];
	readonly plansError?: string;
	readonly paymentOrder: BridgePaymentOrder;
}

interface BridgeQuickLink {
	readonly name: string;
	readonly url: string;
}

const BRIDGE_GET_STATUS = 'shuncode.bridge.getStatus';
const BRIDGE_CONFIGURE = 'shuncode.bridge.configure';
const BRIDGE_CONFIGURE_NAMED_TUNNEL = 'shuncode.bridge.configureNamedTunnel';
const BRIDGE_CLEAR_NAMED_TUNNEL_TOKEN = 'shuncode.bridge.clearNamedTunnelToken';
const BRIDGE_SET_TUNNEL_PROVIDER = 'shuncode.bridge.setTunnelProvider';
const BRIDGE_START = 'shuncode.bridge.start';
const BRIDGE_STOP = 'shuncode.bridge.stop';
const BRIDGE_CHECK_TUNNEL = 'shuncode.bridge.checkTunnel';
const BRIDGE_CHECK_HEALTH = 'shuncode.bridge.checkHealth';
const BRIDGE_INSTALL_CLOUDFLARED = 'shuncode.bridge.installCloudflared';
const BRIDGE_ROTATE_ENDPOINT = 'shuncode.bridge.rotateEndpoint';
const BRIDGE_OPEN_SESSION = 'shuncode.bridge.openSession';
const TASK_CENTER_OPEN = 'shuncode.taskCenter.open';
const BRIDGE_PERSISTENT_MODE = 'shuncode.bridge.persistentMode';
const BRIDGE_ACCESS_GET_STATUS = 'shuncode.bridge.access.getStatus';
const BRIDGE_LICENSE_SIGN_IN = 'shuncode.bridge.license.signIn';
const BRIDGE_LICENSE_SIGN_IN_GITEE = 'shuncode.bridge.license.signInWithGitee';
const BRIDGE_LICENSE_REFRESH_SESSION = 'shuncode.bridge.license.refreshSession';
const BRIDGE_LICENSE_REFRESH = 'shuncode.bridge.license.refresh';
const BRIDGE_LICENSE_SIGN_OUT = 'shuncode.bridge.license.signOut';
const BRIDGE_LICENSE_REDEEM = 'shuncode.bridge.license.redeem';
const BRIDGE_PAYMENT_GET_PLANS = 'shuncode.bridge.payment.getPlans';
const BRIDGE_PAYMENT_CREATE_ORDER = 'shuncode.bridge.payment.createOrder';
const BRIDGE_PAYMENT_GET_ORDER = 'shuncode.bridge.payment.getOrder';

const BRIDGE_ACCESS_CARD_OPEN_STORAGE_KEY = 'shuncode.bridge.accessCard.open';
const BRIDGE_CONNECTION_CARD_OPEN_STORAGE_KEY = 'shuncode.bridge.connectionCard.open';
const BRIDGE_QUICK_LINKS_SETTING = 'shuncode.bridge.quickLinks';
const BRIDGE_QUICK_LINKS_CARD_OPEN_STORAGE_KEY = 'shuncode.bridge.quickLinksCard.open';
const QUICK_LINK_MAX_NAME_LENGTH = 40;
const QUICK_LINK_MAX_URL_LENGTH = 500;

const ARENA_URL = 'https://arena.ai/agent';
const ARENA_PROMPT = '快速连接这个 MCP（URL），明确使用规则，熟悉可用工具，做好处理接下来一系列工作的准备。';

class ShunCodeBridgeWidget extends Disposable implements IAICustomizationManagementSectionWidget {
	private readonly root: HTMLElement;
	private readonly cloudflareProviderButton: HTMLButtonElement;
	private readonly cloudflareNamedProviderButton: HTMLButtonElement;
	private readonly ngrokProviderButton: HTMLButtonElement;
	private readonly domainField: HTMLElement;
	private readonly domainInput: HTMLInputElement;
	private readonly namedTunnelConfiguration: HTMLElement;
	private readonly namedTunnelDomainInput: HTMLInputElement;
	private readonly namedTunnelTokenInput: HTMLInputElement;
	private readonly namedTunnelPortInput: HTMLInputElement;
	private readonly namedTunnelOriginValue: HTMLInputElement;
	private readonly namedTunnelTokenStatus: HTMLElement;
	private readonly saveNamedTunnelButton: Button;
	private readonly clearNamedTunnelTokenButton: Button;
	private readonly accessCard: HTMLDetailsElement;
	private readonly connectionCard: HTMLDetailsElement;
	private readonly connectionDetails: HTMLElement;
	private readonly connectionBadge: HTMLElement;
	private readonly accessBadge: HTMLElement;
	private readonly accessDetails: HTMLElement;
	private readonly accessMessage: HTMLElement;
	private readonly installationSection: HTMLElement;
	private readonly installationIdValue: HTMLInputElement;
	private readonly signInButton: Button;
	private readonly giteeSignInButton: Button;
	private readonly refreshSessionButton: Button;
	private readonly refreshLicenseButton: Button;
	private readonly signOutButton: Button;
	private readonly purchaseSection: HTMLElement;
	private readonly purchaseTitle: HTMLElement;
	private readonly planSelect: HTMLSelectElement;
	private readonly paymentTypeSelect: HTMLSelectElement;
	private readonly purchaseButton: Button;
	private readonly paymentDetails: HTMLElement;
	private readonly checkPaymentButton: Button;
	private readonly activationSection: HTMLElement;
	private readonly activationInput: HTMLInputElement;
	private readonly redeemButton: Button;
	private readonly stateBadge: HTMLElement;
	private readonly stateDetails: HTMLElement;
	private readonly publicUrlSection: HTMLElement;
	private readonly publicUrlValue: HTMLInputElement;
	private readonly addressNotice: HTMLElement;
	private readonly tunnelSetupPanel: HTMLElement;
	private readonly tunnelState: HTMLElement;
	private readonly healthState: HTMLElement;
	private readonly cloudflareSetupDetails: HTMLDetailsElement;
	private readonly cloudflareSetupSummary: HTMLElement;
	private readonly cloudflareNamedSetupDetails: HTMLDetailsElement;
	private readonly cloudflareNamedSetupSummary: HTMLElement;
	private readonly ngrokSetupDetails: HTMLDetailsElement;
	private readonly ngrokSetupSummary: HTMLElement;
	private readonly toolsContainer: HTMLElement;
	private readonly startStopButton: Button;
	private readonly checkButton: Button;
	private readonly healthButton: Button;
	private readonly installCloudflaredButton: Button;
	private readonly rotateButton: Button;
	private readonly persistentModeToggle: HTMLButtonElement;
	private readonly quickLinkButtonsContainer: HTMLElement;
	private readonly quickLinksCard: HTMLDetailsElement;
	private readonly quickLinkNameInput: HTMLInputElement;
	private readonly quickLinkUrlInput: HTMLInputElement;
	private readonly quickLinkAddButton: Button;
	private readonly quickLinkMessage: HTMLElement;
	private readonly quickLinkList: HTMLElement;
	private quickLinkButtons: Button[] = [];
	private quickLinkRowButtons: Button[] = [];
	private busy = false;
	private checkingHealth = false;
	private healthError = '';
	private domainInputDirty = false;
	private namedTunnelInputDirty = false;
	private tunnelNeedsSetup: boolean | undefined;
	private tunnelSetupProvider: BridgeStatus['tunnelProvider'] | undefined;
	private autoCheckedTunnelProvider: 'cloudflare' | 'cloudflare-named' | 'ngrok' | undefined;
	private installingCloudflared = false;
	private lastCopiedQuickTunnelUrl = '';
	private lastStatus: BridgeStatus | undefined;
	private lastAccessStatus: BridgeAccessStatus | undefined;
	private paymentPlansFetchAttempted = false;
	private disposed = false;

	constructor(
		container: HTMLElement,
		@ICommandService private readonly commandService: ICommandService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IDialogService private readonly dialogService: IDialogService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.root = dom.append(container, dom.$('.shuncode-bridge'));

		const heroCard = dom.append(this.root, dom.$('.shuncode-bridge-card.shuncode-bridge-hero'));
		const heroHeader = dom.append(heroCard, dom.$('.shuncode-bridge-card-header'));
		dom.append(heroHeader, dom.$('h2', undefined, localizeBridge('shuncodeBridge.title', "ShunCode Bridge")));
		this.stateBadge = dom.append(heroHeader, dom.$('.shuncode-bridge-state state-stopped'));
		dom.append(heroCard, dom.$('p.shuncode-bridge-hero-description', undefined,
			localizeBridge('shuncodeBridge.descriptionShort', "Connect the current workspace tools to ChatGPT or another remote MCP client.")));
		this.stateDetails = dom.append(heroCard, dom.$('.shuncode-bridge-status-details', undefined,
			localizeBridge('shuncodeBridge.loadingStatus', "Checking Bridge status…")));

		this.publicUrlSection = dom.append(heroCard, dom.$('.shuncode-bridge-url-section'));
		this.publicUrlSection.style.display = 'none';
		dom.append(this.publicUrlSection, dom.$('.shuncode-bridge-url-label', undefined, localizeBridge('shuncodeBridge.publicUrl', "MCP address")));
		const urlRow = dom.append(this.publicUrlSection, dom.$('.shuncode-bridge-url-row'));
		this.publicUrlValue = dom.append(urlRow, dom.$<HTMLInputElement>('input.shuncode-bridge-url-value'));
		this.publicUrlValue.type = 'text';
		this.publicUrlValue.readOnly = true;
		this.publicUrlValue.spellcheck = false;
		this.publicUrlValue.setAttribute('aria-label', localizeBridge('shuncodeBridge.publicUrl', "MCP address"));
		this._register(dom.addDisposableListener(this.publicUrlValue, 'focus', () => this.publicUrlValue.select()));
		const copyUrlButton = dom.append(urlRow, dom.$<HTMLButtonElement>('button.shuncode-bridge-copy-url'));
		copyUrlButton.type = 'button';
		copyUrlButton.textContent = localizeBridge('copy', "Copy");
		copyUrlButton.title = localizeBridge('shuncodeBridge.copyUrl', "Copy MCP address");
		this._register(dom.addDisposableListener(copyUrlButton, 'click', async () => {
			if (this.lastStatus?.publicUrl) await this.clipboardService.writeText(this.lastStatus.publicUrl);
		}));
		this.addressNotice = dom.append(this.publicUrlSection, dom.$('.shuncode-bridge-address-notice'));
		this.addressNotice.style.display = 'none';

		const heroControls = dom.append(heroCard, dom.$('.shuncode-bridge-controls.shuncode-bridge-hero-actions'));
		this.startStopButton = this._register(new Button(heroControls, { ...defaultButtonStyles, supportIcons: true }));
		this.startStopButton.label = `$(${Codicon.play.id}) ${localizeBridge('shuncodeBridge.start', "Start Bridge")}`;
		this._register(this.startStopButton.onDidClick(() => this.toggleBridge()));

		const copyPromptButton = this._register(new Button(heroControls, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		copyPromptButton.label = `$(${Codicon.copy.id}) ${localizeBridge('shuncodeBridge.copyPrompt', "Copy prompt")}`;
		copyPromptButton.setTitle(localizeBridge('shuncodeBridge.copyPromptTitle', "Copy the current MCP address and connection prompt to the clipboard"));
		this._register(copyPromptButton.onDidClick(() => this.copyArenaPrompt()));

		const openChatGptButton = this._register(new Button(heroControls, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		openChatGptButton.label = `$(${Codicon.globe.id}) ${localizeBridge('shuncodeBridge.openChatGpt', "Open ChatGPT")}`;
		openChatGptButton.setTitle(localizeBridge('shuncodeBridge.openChatGptInBrowser', "Open chatgpt.com in the ShunCode built-in browser"));
		this._register(openChatGptButton.onDidClick(() => this.commandService.executeCommand('simpleBrowser.show', 'https://chatgpt.com/')));

		const openArenaButton = this._register(new Button(heroControls, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		openArenaButton.label = `$(${Codicon.linkExternal.id}) ${localizeBridge('shuncodeBridge.openArena', "Open Arena")}`;
		openArenaButton.setTitle(localizeBridge('shuncodeBridge.openArenaInBrowser', "Open arena.ai in the ShunCode built-in browser"));
		this._register(openArenaButton.onDidClick(() => this.commandService.executeCommand('simpleBrowser.show', ARENA_URL)));

		this.addDefaultOpenSiteButton(heroControls, 'shuncodeBridge.openWorkBuddy', "Open WorkBuddy", 'shuncodeBridge.openWorkBuddyInBrowser', "Open workbuddy.cn in the ShunCode built-in browser", 'https://www.workbuddy.cn/app');
		this.addDefaultOpenSiteButton(heroControls, 'shuncodeBridge.openTraeWork', "Open Trae", 'shuncodeBridge.openTraeWorkInBrowser', "Open work.trae.cn in the ShunCode built-in browser", 'https://work.trae.cn');
		this.addDefaultOpenSiteButton(heroControls, 'shuncodeBridge.openQwenWork', "Open Qwen", 'shuncodeBridge.openQwenWorkInBrowser', "Open qwenwork.cn in the ShunCode built-in browser", 'https://qwenwork.cn/app/chat');
		this.addDefaultOpenSiteButton(heroControls, 'shuncodeBridge.openManus', "Open Manus", 'shuncodeBridge.openManusInBrowser', "Open manus.im in the ShunCode built-in browser", 'https://manus.im/app');
		this.addDefaultOpenSiteButton(heroControls, 'shuncodeBridge.openShunova', "Open Shunova", 'shuncodeBridge.openShunovaInBrowser', "Open shunova.cc in the ShunCode built-in browser", 'https://shunova.cc/');

		this.quickLinkButtonsContainer = dom.append(heroControls, dom.$('.shuncode-bridge-quick-links'));
		this.renderQuickLinkButtons();
		const securityNote = dom.append(heroCard, dom.$('.shuncode-bridge-security-note'));
		const warningIcon = dom.append(securityNote, dom.$('span'));
		warningIcon.classList.add(...ThemeIcon.asClassNameArray(Codicon.warning));
		dom.append(securityNote, dom.$('span', undefined,
			localizeBridge('shuncodeBridge.securityWarningShort', "Bridge can edit files and run terminal commands. Keep the MCP address private.")));

		this.accessCard = dom.append(this.root, dom.$<HTMLDetailsElement>('details.shuncode-bridge-card.shuncode-bridge-access-card'));
		this.accessCard.open = this.storageService.getBoolean(BRIDGE_ACCESS_CARD_OPEN_STORAGE_KEY, StorageScope.PROFILE, true);
		this._register(dom.addDisposableListener(this.accessCard, 'toggle', () => {
			this.storageService.store(BRIDGE_ACCESS_CARD_OPEN_STORAGE_KEY, this.accessCard.open, StorageScope.PROFILE, StorageTarget.MACHINE);
		}));
		const accessSummary = dom.append(this.accessCard, dom.$<HTMLElement>('summary'));
		const accessSummaryMain = dom.append(accessSummary, dom.$('.shuncode-bridge-access-summary-main'));
		dom.append(accessSummaryMain, dom.$('h3', undefined, localizeBridge('shuncodeBridge.accountAccess', "Account & access")));
		this.accessDetails = dom.append(accessSummaryMain, dom.$('.shuncode-bridge-access-details', undefined,
			localizeBridge('shuncodeBridge.accessLoading', "Checking your GitHub account and Bridge license…")));
		this.accessBadge = dom.append(accessSummary, dom.$('.shuncode-bridge-state state-stopped'));

		const accessBody = dom.append(this.accessCard, dom.$('.shuncode-bridge-access-body'));
		this.accessMessage = dom.append(accessBody, dom.$('.shuncode-bridge-access-message'));

		this.installationSection = dom.append(accessBody, dom.$('.shuncode-bridge-installation'));
		dom.append(this.installationSection, dom.$('.shuncode-bridge-label', undefined,
			localizeBridge('shuncodeBridge.installationId', "This installation ID")));
		const installationIdRow = dom.append(this.installationSection, dom.$('.shuncode-bridge-url-row'));
		this.installationIdValue = dom.append(installationIdRow, dom.$<HTMLInputElement>('input.shuncode-bridge-url-value'));
		this.installationIdValue.type = 'text';
		this.installationIdValue.readOnly = true;
		this.installationIdValue.spellcheck = false;
		this.installationIdValue.setAttribute('aria-label', localizeBridge('shuncodeBridge.installationId', "This installation ID"));
		this._register(dom.addDisposableListener(this.installationIdValue, 'focus', () => this.installationIdValue.select()));
		const copyInstallationIdButton = dom.append(installationIdRow, dom.$<HTMLButtonElement>('button.shuncode-bridge-copy-url'));
		copyInstallationIdButton.type = 'button';
		copyInstallationIdButton.textContent = localizeBridge('copy', "Copy");
		copyInstallationIdButton.title = localizeBridge('shuncodeBridge.copyInstallationId', "Copy installation ID");
		this._register(dom.addDisposableListener(copyInstallationIdButton, 'click', async () => {
			if (this.lastAccessStatus?.installationId) await this.clipboardService.writeText(this.lastAccessStatus.installationId);
		}));
		dom.append(this.installationSection, dom.$('.shuncode-bridge-help', undefined,
			localizeBridge('shuncodeBridge.installationIdHelp', "Use this ID to identify this device in the license administration console.")));

		const accessActions = dom.append(accessBody, dom.$('.shuncode-bridge-controls.shuncode-bridge-access-actions'));
		this.signInButton = this._register(new Button(accessActions, { ...defaultButtonStyles, supportIcons: true }));
		this.signInButton.label = `$(${Codicon.github.id}) ${localizeBridge('shuncodeBridge.githubSignIn', "Sign in with GitHub")}`;
		this._register(this.signInButton.onDidClick(() => this.runAccessCommand(BRIDGE_LICENSE_SIGN_IN)));

		this.giteeSignInButton = this._register(new Button(accessActions, { ...defaultButtonStyles, supportIcons: true }));
		this.giteeSignInButton.label = `$(${Codicon.cloud.id}) ${localizeBridge('shuncodeBridge.giteeSignIn', "Sign in with Gitee")}`;
		this._register(this.giteeSignInButton.onDidClick(() => this.runAccessCommand(BRIDGE_LICENSE_SIGN_IN_GITEE)));

		this.refreshSessionButton = this._register(new Button(accessActions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.refreshSessionButton.label = `$(${Codicon.sync.id}) ${localizeBridge('shuncodeBridge.refreshLoginStatus', "Refresh login status")}`;
		this._register(this.refreshSessionButton.onDidClick(() => this.runAccessCommand(BRIDGE_LICENSE_REFRESH_SESSION)));

		this.refreshLicenseButton = this._register(new Button(accessActions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.refreshLicenseButton.label = `$(${Codicon.refresh.id}) ${localizeBridge('shuncodeBridge.refreshLicense', "Refresh license")}`;
		this._register(this.refreshLicenseButton.onDidClick(() => this.refreshAccessAndPlans()));

		this.signOutButton = this._register(new Button(accessActions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.signOutButton.label = `$(${Codicon.signOut.id}) ${localizeBridge('shuncodeBridge.signOut', "Sign out")}`;
		this._register(this.signOutButton.onDidClick(() => this.signOut()));

		this.purchaseSection = dom.append(accessBody, dom.$('.shuncode-bridge-purchase'));
		this.purchaseTitle = dom.append(this.purchaseSection, dom.$('h4', undefined, localizeBridge('shuncodeBridge.purchaseTitle', "Purchase Bridge access")));
		dom.append(this.purchaseSection, dom.$('p.shuncode-bridge-help', undefined,
			localizeBridge('shuncodeBridge.purchaseHelp', "Select a server-provided plan. Checkout opens in your browser and ShunCode activates Bridge automatically after payment is confirmed.")));
		const purchaseGrid = dom.append(this.purchaseSection, dom.$('.shuncode-bridge-purchase-grid'));
		const planField = this.createField(purchaseGrid, localizeBridge('shuncodeBridge.paymentPlan', "Plan"));
		this.planSelect = dom.append(planField, dom.$<HTMLSelectElement>('select.shuncode-bridge-select'));
		const paymentField = this.createField(purchaseGrid, localizeBridge('shuncodeBridge.paymentType', "Payment method"));
		this.paymentTypeSelect = dom.append(paymentField, dom.$<HTMLSelectElement>('select.shuncode-bridge-select'));
		const purchaseControls = dom.append(this.purchaseSection, dom.$('.shuncode-bridge-controls'));
		this.purchaseButton = this._register(new Button(purchaseControls, { ...defaultButtonStyles, supportIcons: true }));
		this.purchaseButton.label = `$(${Codicon.creditCard.id}) ${localizeBridge('shuncodeBridge.purchase', "Purchase")}`;
		this._register(this.purchaseButton.onDidClick(() => this.createPayment()));
		this.checkPaymentButton = this._register(new Button(purchaseControls, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.checkPaymentButton.label = `$(${Codicon.sync.id}) ${localizeBridge('shuncodeBridge.checkPayment', "Check payment")}`;
		this._register(this.checkPaymentButton.onDidClick(() => this.runAccessCommand(BRIDGE_PAYMENT_GET_ORDER, this.lastAccessStatus?.paymentOrder.id ?? '')));
		this.paymentDetails = dom.append(this.purchaseSection, dom.$('.shuncode-bridge-payment-details'));

		this.activationSection = dom.append(accessBody, dom.$('.shuncode-bridge-activation'));
		dom.append(this.activationSection, dom.$('.shuncode-bridge-label', undefined, localizeBridge('shuncodeBridge.activationCode', "Activation code")));
		const activationRow = dom.append(this.activationSection, dom.$('.shuncode-bridge-activation-row'));
		this.activationInput = dom.append(activationRow, dom.$<HTMLInputElement>('input.shuncode-bridge-input'));
		this.activationInput.type = 'text';
		this.activationInput.spellcheck = false;
		this.activationInput.autocomplete = 'off';
		this.activationInput.placeholder = 'SHUN-XXXXX-XXXXX-XXXXX-XXXXX';
		this.redeemButton = this._register(new Button(activationRow, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.redeemButton.label = `$(${Codicon.key.id}) ${localizeBridge('shuncodeBridge.redeem', "Redeem")}`;
		this._register(this.redeemButton.onDidClick(() => this.redeemActivationCode()));
		this._register(dom.addDisposableListener(this.activationInput, 'input', () => this.updateControls()));
		this._register(dom.addDisposableListener(this.activationInput, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				void this.redeemActivationCode();
			}
		}));

		this.connectionCard = dom.append(this.root, dom.$<HTMLDetailsElement>('details.shuncode-bridge-card.shuncode-bridge-connection-card'));
		this.connectionCard.open = this.storageService.getBoolean(BRIDGE_CONNECTION_CARD_OPEN_STORAGE_KEY, StorageScope.PROFILE, true);
		this._register(dom.addDisposableListener(this.connectionCard, 'toggle', () => {
			this.storageService.store(BRIDGE_CONNECTION_CARD_OPEN_STORAGE_KEY, this.connectionCard.open, StorageScope.PROFILE, StorageTarget.MACHINE);
		}));
		const connectionSummary = dom.append(this.connectionCard, dom.$<HTMLElement>('summary'));
		const connectionSummaryMain = dom.append(connectionSummary, dom.$('.shuncode-bridge-connection-summary-main'));
		dom.append(connectionSummaryMain, dom.$('h3', undefined, localizeBridge('shuncodeBridge.connectionSettings', "Connection settings")));
		this.connectionDetails = dom.append(connectionSummaryMain, dom.$('.shuncode-bridge-connection-details', undefined,
			localizeBridge('shuncodeBridge.connectionChecking', "Checking tunnel settings…")));
		this.connectionBadge = dom.append(connectionSummary, dom.$('.shuncode-bridge-state state-stopped', undefined,
			localizeBridge('shuncodeBridge.checking', "Checking")));
		const configurationCard = dom.append(this.connectionCard, dom.$('.shuncode-bridge-connection-body'));

		const providerField = this.createField(configurationCard, localizeBridge('shuncodeBridge.tunnelProvider', "Tunnel mode"));
		const providerChoices = dom.append(providerField, dom.$('.shuncode-bridge-provider-choices'));
		providerChoices.setAttribute('role', 'radiogroup');
		this.cloudflareProviderButton = this.createTunnelProviderChoice(
			providerChoices,
			'cloudflare',
			localizeBridge('shuncodeBridge.cloudflareQuickTunnel', "Cloudflare Quick Tunnel (no account or domain)"),
			localizeBridge('shuncodeBridge.cloudflareRecommended', "Default · zero configuration"),
			localizeBridge('shuncodeBridge.cloudflareModeSummary', "A new address is created after every Bridge restart. Best when setup simplicity matters more than keeping one permanent URL."),
			[
				localizeBridge('shuncodeBridge.cloudflareModeAddress', "Address: temporary; changes after restart"),
				localizeBridge('shuncodeBridge.cloudflareModeLimits', "Limits: no listed monthly request quota; 200 concurrent requests; no SLA"),
				localizeBridge('shuncodeBridge.cloudflareModeSetup', "Setup: install cloudflared only; no account or domain"),
			],
		);
		this.cloudflareNamedProviderButton = this.createTunnelProviderChoice(
			providerChoices,
			'cloudflare-named',
			localizeBridge('shuncodeBridge.cloudflareNamedTunnel', "Cloudflare Named Tunnel"),
			localizeBridge('shuncodeBridge.cloudflareNamedStableAddress', "Stable address"),
			localizeBridge('shuncodeBridge.cloudflareNamedModeSummary', "Use a Cloudflare-managed hostname that remains unchanged after ShunCode restarts."),
			[
				localizeBridge('shuncodeBridge.cloudflareNamedModeAddress', "Address: stable hostname on your Cloudflare-managed domain"),
				localizeBridge('shuncodeBridge.cloudflareNamedModeLimits', "Limits: no ngrok-style 20,000 monthly request quota"),
				localizeBridge('shuncodeBridge.cloudflareNamedModeSetup', "Setup: Cloudflare account, domain, Tunnel Token, and published application route"),
			],
		);
		this.ngrokProviderButton = this.createTunnelProviderChoice(
			providerChoices,
			'ngrok',
			localizeBridge('shuncodeBridge.ngrokReservedTunnel', "ngrok development domain"),
			localizeBridge('shuncodeBridge.ngrokStableAddress', "Stable address"),
			localizeBridge('shuncodeBridge.ngrokModeSummary', "The account-assigned development domain can be reused after restart, so the ChatGPT MCP address normally stays unchanged."),
			[
				localizeBridge('shuncodeBridge.ngrokModeAddress', "Address: stable; reusable after restart"),
				localizeBridge('shuncodeBridge.ngrokModeLimits', "Free limits: 20,000 HTTP/S requests and 1 GB outbound data per month"),
				localizeBridge('shuncodeBridge.ngrokModeSetup', "Setup: ngrok account, Authtoken, and assigned development domain"),
			],
		);
		dom.append(providerField, dom.$('.shuncode-bridge-help', undefined,
			localizeBridge('shuncodeBridge.tunnelProviderHelp', "Select a mode above. Stop Bridge before switching tunnel modes.")));

		this.domainField = this.createField(configurationCard, localizeBridge('shuncodeBridge.domain', "ngrok domain"));
		this.domainInput = dom.append(this.domainField, dom.$<HTMLInputElement>('input.shuncode-bridge-input'));
		this.domainInput.type = 'text';
		this.domainInput.spellcheck = false;
		this.domainInput.placeholder = 'your-name.ngrok-free.dev';
		this._register(dom.addDisposableListener(this.domainInput, 'input', () => {
			this.domainInputDirty = true;
		}));
		this._register(dom.addDisposableListener(this.domainInput, 'blur', () => void this.persistDomain()));
		this._register(dom.addDisposableListener(this.domainInput, 'keydown', (event: KeyboardEvent) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				void this.persistDomain();
				this.domainInput.blur();
			}
		}));
		dom.append(this.domainField, dom.$('.shuncode-bridge-help', undefined,
			localizeBridge('shuncodeBridge.domainHelpShort', "Enter the reserved hostname from your ngrok dashboard.")));

		this.namedTunnelConfiguration = dom.append(configurationCard, dom.$('.shuncode-bridge-named-configuration'));
		dom.append(this.namedTunnelConfiguration, dom.$('h4', undefined,
			localizeBridge('shuncodeBridge.cloudflareNamedConfiguration', "Cloudflare Named Tunnel configuration")));
		const namedGrid = dom.append(this.namedTunnelConfiguration, dom.$('.shuncode-bridge-named-grid'));
		const namedDomainField = this.createField(namedGrid, localizeBridge('shuncodeBridge.cloudflareNamedHostname', "Public hostname"));
		this.namedTunnelDomainInput = dom.append(namedDomainField, dom.$<HTMLInputElement>('input.shuncode-bridge-input'));
		this.namedTunnelDomainInput.type = 'text';
		this.namedTunnelDomainInput.spellcheck = false;
		this.namedTunnelDomainInput.placeholder = 'mcp.example.com';
		const namedTokenField = this.createField(namedGrid, localizeBridge('shuncodeBridge.cloudflareTunnelToken', "Tunnel Token"));
		this.namedTunnelTokenInput = dom.append(namedTokenField, dom.$<HTMLInputElement>('input.shuncode-bridge-input'));
		this.namedTunnelTokenInput.type = 'password';
		this.namedTunnelTokenInput.spellcheck = false;
		this.namedTunnelTokenInput.autocomplete = 'off';
		this.namedTunnelTokenInput.placeholder = localizeBridge('shuncodeBridge.cloudflareTunnelTokenPlaceholder', "Paste token to set or replace it");
		this.namedTunnelTokenStatus = dom.append(namedTokenField, dom.$('.shuncode-bridge-help'));
		const namedPortField = this.createField(namedGrid, localizeBridge('shuncodeBridge.cloudflareNamedLocalPort', "Fixed local port"));
		this.namedTunnelPortInput = dom.append(namedPortField, dom.$<HTMLInputElement>('input.shuncode-bridge-input'));
		this.namedTunnelPortInput.type = 'number';
		this.namedTunnelPortInput.min = '1024';
		this.namedTunnelPortInput.max = '65535';
		this.namedTunnelPortInput.step = '1';
		const namedOriginField = this.createField(namedGrid, localizeBridge('shuncodeBridge.cloudflareNamedServiceUrl', "Cloudflare Service URL"));
		const namedOriginRow = dom.append(namedOriginField, dom.$('.shuncode-bridge-named-origin-row'));
		this.namedTunnelOriginValue = dom.append(namedOriginRow, dom.$<HTMLInputElement>('input.shuncode-bridge-input'));
		this.namedTunnelOriginValue.type = 'text';
		this.namedTunnelOriginValue.readOnly = true;
		const copyNamedOriginButton = dom.append(namedOriginRow, dom.$<HTMLButtonElement>('button.shuncode-bridge-copy-url'));
		copyNamedOriginButton.type = 'button';
		copyNamedOriginButton.textContent = localizeBridge('copy', "Copy");
		this._register(dom.addDisposableListener(copyNamedOriginButton, 'click', () => this.clipboardService.writeText(this.namedTunnelOriginValue.value)));
		dom.append(this.namedTunnelConfiguration, dom.$('.shuncode-bridge-help', undefined,
			localizeBridge('shuncodeBridge.cloudflareNamedServiceHelp', "In Cloudflare Tunnels, the published application hostname must match the public hostname above and the Service URL must exactly match this local URL.")));
		const namedActions = dom.append(this.namedTunnelConfiguration, dom.$('.shuncode-bridge-controls'));
		this.saveNamedTunnelButton = this._register(new Button(namedActions, { ...defaultButtonStyles, supportIcons: true }));
		this.saveNamedTunnelButton.label = `$(${Codicon.save.id}) ${localizeBridge('shuncodeBridge.saveNamedTunnel', "Save Named Tunnel")}`;
		this._register(this.saveNamedTunnelButton.onDidClick(() => this.saveNamedTunnel()));
		this.clearNamedTunnelTokenButton = this._register(new Button(namedActions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.clearNamedTunnelTokenButton.label = `$(${Codicon.clearAll.id}) ${localizeBridge('shuncodeBridge.clearTunnelToken', "Clear token")}`;
		this._register(this.clearNamedTunnelTokenButton.onDidClick(() => this.clearNamedTunnelToken()));
		for (const input of [this.namedTunnelDomainInput, this.namedTunnelTokenInput, this.namedTunnelPortInput]) {
			this._register(dom.addDisposableListener(input, 'input', () => {
				this.namedTunnelInputDirty = true;
				this.updateNamedTunnelOriginPreview();
				this.updateControls();
			}));
		}

		this.tunnelSetupPanel = dom.append(configurationCard, dom.$('.shuncode-bridge-tunnel-panel'));
		const tunnelStatusRow = dom.append(this.tunnelSetupPanel, dom.$('.shuncode-bridge-tunnel-status-row'));
		const tunnelStatusText = dom.append(tunnelStatusRow, dom.$('.shuncode-bridge-tunnel-status-text'));
		dom.append(tunnelStatusText, dom.$('.shuncode-bridge-label', undefined,
			localizeBridge('shuncodeBridge.tunnelStatus', "Tunnel status")));
		this.tunnelState = dom.append(tunnelStatusText, dom.$('.shuncode-bridge-tunnel-state', undefined,
			localizeBridge('shuncodeBridge.tunnelUnchecked', "The tunnel client has not been checked yet.")));
		const tunnelStatusActions = dom.append(tunnelStatusRow, dom.$('.shuncode-bridge-controls.shuncode-bridge-tunnel-actions'));
		this.checkButton = this._register(new Button(tunnelStatusActions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.checkButton.label = `$(${Codicon.check.id}) ${localizeBridge('shuncodeBridge.checkTunnel', "Check tunnel")}`;
		this._register(this.checkButton.onDidClick(() => this.runCommand(BRIDGE_CHECK_TUNNEL)));
		this.installCloudflaredButton = this._register(new Button(tunnelStatusActions, { ...defaultButtonStyles, supportIcons: true }));
		this.installCloudflaredButton.label = `$(${Codicon.cloudDownload.id}) ${localizeBridge('shuncodeBridge.installCloudflaredNow', "Install cloudflared")}`;
		this._register(this.installCloudflaredButton.onDidClick(() => this.installCloudflared()));

		const healthStatusRow = dom.append(configurationCard, dom.$('.shuncode-bridge-health-status-row'));
		const healthStatusText = dom.append(healthStatusRow, dom.$('.shuncode-bridge-health-status-text'));
		dom.append(healthStatusText, dom.$('.shuncode-bridge-label', undefined,
			localizeBridge('shuncodeBridge.mcpHealth', "MCP health")));
		this.healthState = dom.append(healthStatusText, dom.$('.shuncode-bridge-health-state', undefined,
			localizeBridge('shuncodeBridge.healthUnchecked', "No end-to-end health check has been run yet.")));
		const healthStatusActions = dom.append(healthStatusRow, dom.$('.shuncode-bridge-controls.shuncode-bridge-health-actions'));
		this.healthButton = this._register(new Button(healthStatusActions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.healthButton.label = `$(${Codicon.pulse.id}) ${localizeBridge('shuncodeBridge.checkHealth', "Check health")}`;
		this.healthButton.setTitle(localizeBridge('shuncodeBridge.checkHealthTitle', "Probe local MCP, public tunnel, tunnel process, and MCP sessions"));
		this._register(this.healthButton.onDidClick(() => this.checkHealth()));
		const cloudflareSetup = this.createCloudflareSetupSection(this.tunnelSetupPanel);
		this.cloudflareSetupDetails = cloudflareSetup.details;
		this.cloudflareSetupSummary = cloudflareSetup.summary;
		const cloudflareNamedSetup = this.createCloudflareNamedSetupSection(this.tunnelSetupPanel);
		this.cloudflareNamedSetupDetails = cloudflareNamedSetup.details;
		this.cloudflareNamedSetupSummary = cloudflareNamedSetup.summary;
		const ngrokSetup = this.createNgrokSetupSection(this.tunnelSetupPanel);
		this.ngrokSetupDetails = ngrokSetup.details;
		this.ngrokSetupSummary = ngrokSetup.summary;

		const persistentRow = dom.append(configurationCard, dom.$('.shuncode-bridge-persistent-row'));
		const persistentText = dom.append(persistentRow, dom.$('.shuncode-bridge-persistent-text'));
		const persistentLabel = dom.append(persistentText, dom.$('label.shuncode-bridge-label'));
		persistentLabel.textContent = localizeBridge('shuncodeBridge.persistentMode', "Start Bridge automatically");
		dom.append(persistentText, dom.$('.shuncode-bridge-help', undefined,
			localizeBridge('shuncodeBridge.persistentModeHelpShort', "Start Bridge after the app is ready without opening Chat.")));
		this.persistentModeToggle = dom.append(persistentRow, dom.$<HTMLButtonElement>('button.shuncode-bridge-switch'));
		this.persistentModeToggle.type = 'button';
		this.persistentModeToggle.setAttribute('role', 'switch');
		this.persistentModeToggle.setAttribute('aria-label', localizeBridge('shuncodeBridge.persistentMode', "Start Bridge automatically"));
		dom.append(this.persistentModeToggle, dom.$('span.shuncode-bridge-switch-track'));
		this.renderPersistentModeToggle(this.configurationService.getValue<boolean>(BRIDGE_PERSISTENT_MODE) === true);
		this._register(dom.addDisposableListener(this.persistentModeToggle, 'click', () => {
			const enabled = this.persistentModeToggle.getAttribute('aria-checked') !== 'true';
			if (enabled && !this.lastAccessStatus?.licensed) {
				this.renderAccessError(localizeBridge('shuncodeBridge.persistentLicenseRequired', "Activate Bridge access before enabling startup mode."));
				return;
			}
			this.renderPersistentModeToggle(enabled);
			void this.configurationService.updateValue(BRIDGE_PERSISTENT_MODE, enabled, ConfigurationTarget.USER).catch(error => {
				this.renderPersistentModeToggle(this.configurationService.getValue<boolean>(BRIDGE_PERSISTENT_MODE) === true);
				this.renderLocalError(error instanceof Error ? error.message : String(error));
			});
		}));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(BRIDGE_PERSISTENT_MODE)) {
				this.renderPersistentModeToggle(this.configurationService.getValue<boolean>(BRIDGE_PERSISTENT_MODE) === true);
			}
		}));

		this.quickLinksCard = dom.append(this.root, dom.$<HTMLDetailsElement>('details.shuncode-bridge-card.shuncode-bridge-quick-links-card'));
		this.quickLinksCard.open = this.storageService.getBoolean(BRIDGE_QUICK_LINKS_CARD_OPEN_STORAGE_KEY, StorageScope.PROFILE, false);
		this._register(dom.addDisposableListener(this.quickLinksCard, 'toggle', () => {
			this.storageService.store(BRIDGE_QUICK_LINKS_CARD_OPEN_STORAGE_KEY, this.quickLinksCard.open, StorageScope.PROFILE, StorageTarget.MACHINE);
		}));
		const quickLinksSummary = dom.append(this.quickLinksCard, dom.$<HTMLElement>('summary'));
		dom.append(quickLinksSummary, dom.$('h3', undefined, localizeBridge('shuncodeBridge.quickLinks', "Quick open")));
		const quickLinksBody = dom.append(this.quickLinksCard, dom.$('.shuncode-bridge-quick-links-body'));
		dom.append(quickLinksBody, dom.$('p.shuncode-bridge-help', undefined,
			localizeBridge('shuncodeBridge.quickLinksHelp', "Shortcuts you add here appear as buttons at the top of this page and open in the ShunCode built-in browser.")));
		const quickLinkForm = dom.append(quickLinksBody, dom.$('.shuncode-bridge-quick-link-form'));
		this.quickLinkNameInput = dom.append(quickLinkForm, dom.$<HTMLInputElement>('input.shuncode-bridge-input.shuncode-bridge-quick-link-name-input'));
		this.quickLinkNameInput.type = 'text';
		this.quickLinkNameInput.spellcheck = false;
		this.quickLinkNameInput.placeholder = localizeBridge('shuncodeBridge.quickLinkNamePlaceholder', "Name");
		this.quickLinkUrlInput = dom.append(quickLinkForm, dom.$<HTMLInputElement>('input.shuncode-bridge-input.shuncode-bridge-quick-link-url-input'));
		this.quickLinkUrlInput.type = 'text';
		this.quickLinkUrlInput.spellcheck = false;
		this.quickLinkUrlInput.placeholder = localizeBridge('shuncodeBridge.quickLinkUrlPlaceholder', "https://…");
		this.quickLinkAddButton = this._register(new Button(quickLinkForm, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.quickLinkAddButton.label = `$(${Codicon.add.id}) ${localizeBridge('shuncodeBridge.quickLinkAdd', "Add")}`;
		this._register(this.quickLinkAddButton.onDidClick(() => this.addQuickLink()));
		for (const input of [this.quickLinkNameInput, this.quickLinkUrlInput]) {
			this._register(dom.addDisposableListener(input, 'input', () => this.updateControls()));
			this._register(dom.addDisposableListener(input, 'keydown', (event: KeyboardEvent) => {
				if (event.key === 'Enter') {
				event.preventDefault();
				void this.addQuickLink();
				}
			}));
		}
		this.quickLinkMessage = dom.append(quickLinksBody, dom.$('.shuncode-bridge-quick-link-message'));
		this.quickLinkList = dom.append(quickLinksBody, dom.$('.shuncode-bridge-quick-link-list'));
		this.renderQuickLinksList();
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(BRIDGE_QUICK_LINKS_SETTING)) {
				this.renderQuickLinkButtons();
				this.renderQuickLinksList();
			}
		}));

		const advanced = dom.append(this.root, dom.$<HTMLDetailsElement>('details.shuncode-bridge-card.shuncode-bridge-advanced-card'));
		const advancedSummary = dom.append(advanced, dom.$<HTMLElement>('summary'));
		dom.append(advancedSummary, dom.$('h3', undefined, localizeBridge('shuncodeBridge.advancedSettings', "Advanced settings")));
		const advancedBody = dom.append(advanced, dom.$('.shuncode-bridge-advanced-body'));

		const transportRow = dom.append(advancedBody, dom.$('.shuncode-bridge-static-row'));
		dom.append(transportRow, dom.$('.shuncode-bridge-label', undefined, localizeBridge('shuncodeBridge.transport', "Transport protocol")));
		dom.append(transportRow, dom.$('.shuncode-bridge-static-value', undefined,
			localizeBridge('shuncodeBridge.streamableHttp', "Streamable HTTP")));

		const diagnosticsSection = dom.append(advancedBody, dom.$('.shuncode-bridge-advanced-section'));
		dom.append(diagnosticsSection, dom.$('h4', undefined, localizeBridge('shuncodeBridge.connectionDiagnostics', "Connection diagnostics")));
		const diagnosticControls = dom.append(diagnosticsSection, dom.$('.shuncode-bridge-controls.shuncode-bridge-diagnostic-actions'));
		const openSessionButton = this._register(new Button(diagnosticControls, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		openSessionButton.label = `$(${Codicon.openPreview.id}) ${localizeBridge('shuncodeBridge.openSession', "Open Bridge Session")}`;
		this._register(openSessionButton.onDidClick(() => this.commandService.executeCommand(BRIDGE_OPEN_SESSION)));
		const openWorkSessionsButton = this._register(new Button(diagnosticControls, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		openWorkSessionsButton.label = `$(${Codicon.tasklist.id}) ${localizeBridge('shuncodeBridge.openWorkSessions', "Open Work Sessions")}`;
		this._register(openWorkSessionsButton.onDidClick(() => this.commandService.executeCommand(TASK_CENTER_OPEN)));

		const securitySection = dom.append(advancedBody, dom.$('.shuncode-bridge-advanced-section.shuncode-bridge-security-section'));
		dom.append(securitySection, dom.$('h4', undefined, localizeBridge('shuncodeBridge.securityAccess', "Security & access")));
		dom.append(securitySection, dom.$('p.shuncode-bridge-help', undefined,
			localizeBridge('shuncodeBridge.resetAddressHelp', "Reset the secret path if the MCP address was exposed. Every client using the old address will stop working.")));
		const securityControls = dom.append(securitySection, dom.$('.shuncode-bridge-controls'));
		this.rotateButton = this._register(new Button(securityControls, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		this.rotateButton.label = `$(${Codicon.key.id}) ${localizeBridge('shuncodeBridge.resetMcpAddress', "Reset MCP address")}`;
		this._register(this.rotateButton.onDidClick(() => this.resetMcpAddress()));

		const toolsSection = dom.append(advancedBody, dom.$('.shuncode-bridge-advanced-section'));
		dom.append(toolsSection, dom.$('h4', undefined, localizeBridge('shuncodeBridge.exposedTools', "Exposed tools")));
		this.toolsContainer = dom.append(toolsSection, dom.$('.shuncode-bridge-tools'));

		const timer = setInterval(() => void this.refresh(), 1_000);
		this._register(toDisposable(() => clearInterval(timer)));
		void this.refresh();
	}

	private addDefaultOpenSiteButton(parent: HTMLElement, labelKey: string, label: string, titleKey: string, title: string, url: string): void {
		const button = this._register(new Button(parent, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
		button.label = `$(${Codicon.linkExternal.id}) ${localizeBridge(labelKey, label)}`;
		button.setTitle(localizeBridge(titleKey, title));
		this._register(button.onDidClick(() => this.commandService.executeCommand('simpleBrowser.show', url)));
	}

	private createField(parent: HTMLElement, label: string): HTMLElement {
		const field = dom.append(parent, dom.$('.shuncode-bridge-field'));
		dom.append(field, dom.$('label.shuncode-bridge-label', undefined, label));
		return field;
	}

	private createTunnelProviderChoice(
		parent: HTMLElement,
		provider: 'cloudflare' | 'cloudflare-named' | 'ngrok',
		title: string,
		badge: string,
		summary: string,
		facts: readonly string[],
	): HTMLButtonElement {
		const button = dom.append(parent, dom.$<HTMLButtonElement>('button.shuncode-bridge-provider-choice'));
		button.type = 'button';
		button.dataset.provider = provider;
		button.setAttribute('role', 'radio');
		button.setAttribute('aria-checked', 'false');
		const header = dom.append(button, dom.$('.shuncode-bridge-provider-header'));
		dom.append(header, dom.$('.shuncode-bridge-provider-title', undefined, title));
		dom.append(header, dom.$('.shuncode-bridge-provider-badge', undefined, badge));
		dom.append(button, dom.$('.shuncode-bridge-provider-summary', undefined, summary));
		const factList = dom.append(button, dom.$('ul.shuncode-bridge-provider-facts'));
		for (const fact of facts) dom.append(factList, dom.$('li', undefined, fact));
		this._register(dom.addDisposableListener(button, 'click', () => void this.selectTunnelProvider(provider)));
		return button;
	}

	private async selectTunnelProvider(provider: 'cloudflare' | 'cloudflare-named' | 'ngrok'): Promise<void> {
		if (this.busy || this.lastStatus?.state === 'running' || this.lastStatus?.state === 'starting' || this.lastStatus?.tunnelProvider === provider) return;
		await this.runCommand(BRIDGE_SET_TUNNEL_PROVIDER, provider);
	}

	private createCloudflareSetupSection(parent: HTMLElement): { details: HTMLDetailsElement; summary: HTMLElement } {
		const details = dom.append(parent, dom.$<HTMLDetailsElement>('details.shuncode-bridge-setup'));
		const summary = dom.append(details, dom.$<HTMLElement>('summary'));
		summary.textContent = localizeBridge('shuncodeBridge.configureCloudflare', "Install cloudflared");
		const body = dom.append(details, dom.$('.shuncode-bridge-setup-body'));
		dom.append(body, dom.$('p', undefined,
			localizeBridge('shuncodeBridge.cloudflareSetupIntro', "Install cloudflared once. No Cloudflare account, token, or domain is required for Quick Tunnel.")));

		this.createSetupStep(body, '1', localizeBridge('shuncodeBridge.installCloudflared', "Install or update cloudflared"), [
			'winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements',
			'winget upgrade --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements',
		], localizeBridge('shuncodeBridge.downloadCloudflared', "Open official download page"), 'https://developers.cloudflare.com/tunnel/downloads/');

		this.createSetupStep(body, '2', localizeBridge('shuncodeBridge.verifyCloudflared', "Verify cloudflared"), [
			'cloudflared --version',
		]);
		dom.append(body, dom.$('p.shuncode-bridge-help', undefined,
			localizeBridge('shuncodeBridge.cloudflareAddressHelp', "Each Bridge start creates a new temporary MCP address. ShunCode copies it automatically; update the address in ChatGPT.")));
		return { details, summary };
	}

	private createCloudflareNamedSetupSection(parent: HTMLElement): { details: HTMLDetailsElement; summary: HTMLElement } {
		const details = dom.append(parent, dom.$<HTMLDetailsElement>('details.shuncode-bridge-setup'));
		const summary = dom.append(details, dom.$<HTMLElement>('summary'));
		summary.textContent = localizeBridge('shuncodeBridge.configureCloudflareNamed', "Configure Cloudflare Named Tunnel");
		const body = dom.append(details, dom.$('.shuncode-bridge-setup-body'));
		dom.append(body, dom.$('p', undefined,
			localizeBridge('shuncodeBridge.cloudflareNamedSetupIntro', "Create a remotely managed Cloudflare Tunnel, copy its token, and publish your hostname to the fixed ShunCode Service URL shown above.")));

		this.createSetupStep(body, '1', localizeBridge('shuncodeBridge.installCloudflared', "Install or update cloudflared"), [
			'winget install --id Cloudflare.cloudflared --exact --accept-package-agreements --accept-source-agreements',
		], localizeBridge('shuncodeBridge.downloadCloudflared', "Open official download page"), 'https://developers.cloudflare.com/tunnel/downloads/');

		this.createSetupStep(body, '2', localizeBridge('shuncodeBridge.createCloudflareTunnel', "Create or open a Cloudflare Tunnel and copy its token"), [],
			localizeBridge('shuncodeBridge.openCloudflareTunnels', "Open Cloudflare Tunnels"), 'https://dash.cloudflare.com/?to=%2F%3Aaccount%2Ftunnels');

		this.createSetupStep(body, '3', localizeBridge('shuncodeBridge.publishCloudflareHostname', "Add a published application route"), []);
		dom.append(body, dom.$('p.shuncode-bridge-help', undefined,
			localizeBridge('shuncodeBridge.publishCloudflareHostnameHelp', "Set the public hostname to the value saved above and set the Service URL to the exact http://127.0.0.1:<port> value shown by ShunCode.")));

		this.createSetupStep(body, '4', localizeBridge('shuncodeBridge.reviewCloudflareDns', "Review the hostname DNS record"), [],
			localizeBridge('shuncodeBridge.openCloudflareDns', "Open Cloudflare DNS"), 'https://dash.cloudflare.com/?to=%2F%3Aaccount%2F%3Azone%2Fdns%2Frecords');
		return { details, summary };
	}

	private createNgrokSetupSection(parent: HTMLElement): { details: HTMLDetailsElement; summary: HTMLElement } {
		const details = dom.append(parent, dom.$<HTMLDetailsElement>('details.shuncode-bridge-setup'));
		const summary = dom.append(details, dom.$<HTMLElement>('summary'));
		summary.textContent = localizeBridge('shuncodeBridge.configureNgrok', "Configure ngrok");
		const body = dom.append(details, dom.$('.shuncode-bridge-setup-body'));
		dom.append(body, dom.$('p', undefined,
			localizeBridge('shuncodeBridge.setupIntro', "Run the following once in Windows PowerShell. After installation, restart ShunCode so ngrok is available to the Extension Host.")));

		this.createSetupStep(body, '1', localizeBridge('shuncodeBridge.installNgrok', "Install or update ngrok"), [
			'winget install --id 9MVS1J51GMK6 --source msstore --accept-package-agreements --accept-source-agreements',
			'winget upgrade --id 9MVS1J51GMK6 --source msstore --accept-package-agreements --accept-source-agreements',
		], localizeBridge('shuncodeBridge.downloadNgrok', "Open official download page"), 'https://ngrok.com/download/windows');

		this.createSetupStep(body, '2', localizeBridge('shuncodeBridge.addAuthtoken', "Add your ngrok Authtoken"), [
			'ngrok config add-authtoken <YOUR_AUTHTOKEN>',
		], localizeBridge('shuncodeBridge.openAuthtoken', "Open Authtoken page"), 'https://dashboard.ngrok.com/get-started/your-authtoken');

		this.createSetupStep(body, '3', localizeBridge('shuncodeBridge.verifyNgrok', "Verify installation and configuration"), [
			'ngrok version; ngrok config check',
		]);

		this.createSetupStep(body, '4', localizeBridge('shuncodeBridge.reserveDomain', "Choose your free reserved domain"), [],
			localizeBridge('shuncodeBridge.openDomains', "Open Domains page"), 'https://dashboard.ngrok.com/domains');
		return { details, summary };
	}

	private createSetupStep(parent: HTMLElement, number: string, title: string, commands: string[], linkLabel?: string, link?: string): void {
		const step = dom.append(parent, dom.$('.shuncode-bridge-setup-step'));
		dom.append(step, dom.$('h4', undefined, `${number}. ${title}`));
		for (const command of commands) {
			const row = dom.append(step, dom.$('.shuncode-bridge-command-row'));
			dom.append(row, dom.$('code', undefined, command));
			const copy = this._register(new Button(row, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
			copy.label = `$(${Codicon.copy.id})`;
			copy.setTitle(localizeBridge('copy', "Copy"));
			this._register(copy.onDidClick(() => this.clipboardService.writeText(command)));
		}
		if (linkLabel && link) {
			const open = this._register(new Button(step, { ...defaultButtonStyles, secondary: true }));
			open.label = linkLabel;
			this._register(open.onDidClick(() => this.openerService.open(URI.parse(link))));
		}
	}

	private async persistDomain(): Promise<void> {
		if (this.busy || this.lastStatus?.tunnelProvider !== 'ngrok' || this.lastStatus?.state === 'running' || this.lastStatus?.state === 'starting') return;
		const domain = this.domainInput.value.trim();
		if (!domain) {
			this.domainInputDirty = false;
			this.domainInput.value = this.lastStatus?.configuredDomain ?? '';
			return;
		}
		if (domain === this.lastStatus?.configuredDomain) {
			this.domainInputDirty = false;
			return;
		}
		const status = await this.runCommand(BRIDGE_CONFIGURE, domain);
		if (status) {
			this.domainInputDirty = false;
			this.domainInput.value = status.configuredDomain;
		}
	}

	private updateNamedTunnelOriginPreview(): void {
		const port = Number(this.namedTunnelPortInput.value) || this.lastStatus?.namedTunnelLocalPort || 48271;
		this.namedTunnelOriginValue.value = `http://127.0.0.1:${port}`;
		this.namedTunnelOriginValue.title = this.namedTunnelOriginValue.value;
	}

	private async saveNamedTunnel(): Promise<void> {
		if (this.busy || this.lastStatus?.state === 'running' || this.lastStatus?.state === 'starting') return;
		const domain = this.namedTunnelDomainInput.value.trim();
		const token = this.namedTunnelTokenInput.value.trim();
		const localPort = Number(this.namedTunnelPortInput.value);
		if (!domain) {
			this.renderLocalError(localizeBridge('shuncodeBridge.cloudflareNamedHostnameRequired', "Enter the Cloudflare public hostname."));
			this.namedTunnelDomainInput.focus();
			return;
		}
		if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) {
			this.renderLocalError(localizeBridge('shuncodeBridge.cloudflareNamedPortRequired', "Enter a local port from 1024 to 65535."));
			this.namedTunnelPortInput.focus();
			return;
		}
		if (!token && !this.lastStatus?.namedTunnelTokenConfigured) {
			this.renderLocalError(localizeBridge('shuncodeBridge.cloudflareTunnelTokenRequired', "Paste the Cloudflare Tunnel Token before saving."));
			this.namedTunnelTokenInput.focus();
			return;
		}
		const status = await this.runCommand(BRIDGE_CONFIGURE_NAMED_TUNNEL, {
			domain,
			localPort,
			...(token ? { token } : {}),
		});
		if (status) {
			this.namedTunnelInputDirty = false;
			this.namedTunnelTokenInput.value = '';
		}
	}

	private async clearNamedTunnelToken(): Promise<void> {
		if (this.busy || !this.lastStatus?.namedTunnelTokenConfigured) return;
		const result = await this.dialogService.confirm({
			type: 'warning',
			message: localizeBridge('shuncodeBridge.clearTunnelTokenConfirm', "Clear the Cloudflare Tunnel Token?"),
			detail: localizeBridge('shuncodeBridge.clearTunnelTokenConfirmDetail', "Cloudflare Named Tunnel cannot start until a new token is saved."),
			primaryButton: localizeBridge('shuncodeBridge.clearTunnelToken', "Clear token"),
		});
		if (!result.confirmed) return;
		await this.runCommand(BRIDGE_CLEAR_NAMED_TUNNEL_TOKEN);
	}

	private async toggleBridge(): Promise<void> {
		if (this.busy) return;
		if (this.lastStatus?.state === 'running') {
			await this.runCommand(BRIDGE_STOP);
			return;
		}
		if (!this.lastAccessStatus?.licensed) {
			this.renderAccessError(this.lastAccessStatus?.signedIn
				? localizeBridge('shuncodeBridge.purchaseRequired', "Purchase or activate Bridge access before starting the Bridge.")
				: localizeBridge('shuncodeBridge.signInRequired', "Sign in with GitHub before starting the Bridge."));
			return;
		}
		const provider = this.lastStatus?.tunnelProvider ?? 'cloudflare';
		const domain = this.domainInput.value.trim();
		if (provider === 'ngrok' && !domain) {
			this.connectionCard.open = true;
			this.renderLocalError(localizeBridge('shuncodeBridge.domainRequired', "Enter your ngrok reserved domain before starting the Bridge."));
			this.domainInput.focus();
			return;
		}
		if (provider === 'cloudflare-named' && (!this.lastStatus?.configuredNamedDomain || !this.lastStatus.namedTunnelTokenConfigured)) {
			this.connectionCard.open = true;
			this.renderLocalError(localizeBridge('shuncodeBridge.namedTunnelConfigurationRequired', "Save the Cloudflare hostname and Tunnel Token before starting Bridge."));
			(this.lastStatus?.configuredNamedDomain ? this.namedTunnelTokenInput : this.namedTunnelDomainInput).focus();
			return;
		}
		await this.runCommand(BRIDGE_START, provider === 'ngrok' ? domain : undefined);
	}

	private async installCloudflared(): Promise<void> {
		if (this.busy) return;
		this.installingCloudflared = true;
		this.tunnelState.textContent = localizeBridge('shuncodeBridge.installingCloudflared', "Installing cloudflared with Winget…");
		this.updateControls();
		try {
			await this.runCommand(BRIDGE_INSTALL_CLOUDFLARED);
		} finally {
			this.installingCloudflared = false;
			await this.refresh();
			this.updateControls();
		}
	}

	private async signOut(): Promise<void> {
		if (this.busy) return;
		const result = await this.dialogService.confirm({
			type: 'warning',
			message: localizeBridge('shuncodeBridge.signOutConfirm', "Sign out of Bridge?"),
			detail: localizeBridge('shuncodeBridge.signOutConfirmDetail', "A running Bridge will stop. Your paid entitlement remains attached to this GitHub account."),
			primaryButton: localizeBridge('shuncodeBridge.signOut', "Sign out"),
		});
		if (!result.confirmed) return;
		await this.runAccessCommand(BRIDGE_LICENSE_SIGN_OUT);
	}

	private async createPayment(): Promise<void> {
		const planId = this.planSelect.value;
		if (!planId) {
			this.renderAccessError(localizeBridge('shuncodeBridge.planRequired', "Select a Bridge payment plan."));
			return;
		}
		await this.runAccessCommand(BRIDGE_PAYMENT_CREATE_ORDER, planId, this.paymentTypeSelect.value || 'alipay');
	}

	private async redeemActivationCode(): Promise<void> {
		const code = this.activationInput.value.trim();
		if (!code) {
			this.renderAccessError(localizeBridge('shuncodeBridge.activationRequired', "Enter a Bridge activation code."));
			this.activationInput.focus();
			return;
		}
		const status = await this.runAccessCommand(BRIDGE_LICENSE_REDEEM, code);
		if (status?.licensed) this.activationInput.value = '';
	}

	private async copyArenaPrompt(): Promise<void> {
		const url = this.lastStatus?.publicUrl?.trim();
		const text = url ? `${url}\n\n${ARENA_PROMPT}` : ARENA_PROMPT;
		await this.clipboardService.writeText(text);
	}

	private async resetMcpAddress(): Promise<void> {
		if (this.busy || this.lastStatus?.state === 'running' || this.lastStatus?.state === 'starting') return;
		const result = await this.dialogService.confirm({
			type: 'warning',
			message: localizeBridge('shuncodeBridge.resetAddressConfirm', "Reset the MCP address?"),
			detail: localizeBridge('shuncodeBridge.resetAddressConfirmDetail', "The current MCP address will stop working immediately. Update the address in ChatGPT and every other connected client."),
			primaryButton: localizeBridge('shuncodeBridge.resetMcpAddress', "Reset MCP address"),
		});
		if (!result.confirmed) return;
		await this.runCommand(BRIDGE_ROTATE_ENDPOINT);
	}

	private async checkHealth(): Promise<void> {
		if (this.busy || this.checkingHealth) return;
		this.busy = true;
		this.checkingHealth = true;
		this.healthError = '';
		this.renderHealth(this.lastStatus?.health);
		this.updateControls();
		try {
			const status = await this.commandService.executeCommand<BridgeStatus>(BRIDGE_CHECK_HEALTH);
			if (status) this.render(status);
		} catch (error) {
			this.connectionCard.open = true;
			this.healthError = error instanceof Error ? error.message : String(error);
			this.renderLocalError(this.healthError);
		} finally {
			this.busy = false;
			this.checkingHealth = false;
			this.renderHealth(this.lastStatus?.health);
			this.updateControls();
			void this.refresh();
		}
	}

	private async runCommand(command: string, ...args: unknown[]): Promise<BridgeStatus | undefined> {
		if (this.busy) return undefined;
		this.busy = true;
		this.updateControls();
		try {
			const status = await this.commandService.executeCommand<BridgeStatus>(command, ...args);
			if (status) this.render(status);
			return status;
		} catch (error) {
			if (command === BRIDGE_START || command === BRIDGE_CHECK_TUNNEL || command === BRIDGE_INSTALL_CLOUDFLARED || command === BRIDGE_CONFIGURE || command === BRIDGE_CONFIGURE_NAMED_TUNNEL || command === BRIDGE_CLEAR_NAMED_TUNNEL_TOKEN || command === BRIDGE_SET_TUNNEL_PROVIDER) {
				this.connectionCard.open = true;
			}
			this.renderLocalError(error instanceof Error ? error.message : String(error));
			return undefined;
		} finally {
			this.busy = false;
			this.updateControls();
			void this.refresh();
		}
	}

	private async refreshAccessAndPlans(): Promise<void> {
		this.paymentPlansFetchAttempted = false;
		const status = await this.runAccessCommand(BRIDGE_LICENSE_REFRESH);
		if (status && !status.plans.length) {
			await this.fetchPaymentPlans(true);
		}
	}

	private async fetchPaymentPlans(force: boolean): Promise<void> {
		if (this.disposed) {
			return;
		}
		try {
			const status = await this.commandService.executeCommand<BridgeAccessStatus>(BRIDGE_PAYMENT_GET_PLANS, force);
			if (status) {
				this.renderAccess(status);
			}
		} catch (error) {
			this.renderAccessError(error instanceof Error ? error.message : String(error));
		}
	}

	private accessErrorOverride = '';

	private async runAccessCommand(command: string, ...args: unknown[]): Promise<BridgeAccessStatus | undefined> {
		if (this.busy) {
			this.renderAccessError(localizeBridge('shuncodeBridge.signInInProgress', "A Bridge sign-in is already in progress. Finish or cancel it, then try again."));
			return undefined;
		}
		this.busy = true;
		this.accessErrorOverride = '';
		if (command === BRIDGE_LICENSE_SIGN_IN_GITEE) {
			this.accessDetails.textContent = localizeBridge('shuncodeBridge.giteeWaitingTitle', "Waiting for Gitee authorization…");
			this.accessMessage.textContent = localizeBridge('shuncodeBridge.giteeWaiting', "The Gitee authorization page should open in your browser. Complete it to finish signing in.");
		}
		this.updateControls();
		try {
			const status = await this.commandService.executeCommand<BridgeAccessStatus>(command, ...args);
			if (status) this.renderAccess(status);
			if (status && (command === BRIDGE_LICENSE_SIGN_IN || command === BRIDGE_LICENSE_SIGN_IN_GITEE || command === BRIDGE_LICENSE_SIGN_OUT)) {
				this.paymentPlansFetchAttempted = false;
			}
			return status;
		} catch (error) {
			this.renderAccessError(error instanceof Error ? error.message : String(error));
			return undefined;
		} finally {
			this.busy = false;
			this.updateControls();
			void this.refresh();
		}
	}

	private async refresh(): Promise<void> {
		if (this.disposed || this.busy) return;
		try {
			const [status, accessStatus] = await Promise.all([
				this.commandService.executeCommand<BridgeStatus>(BRIDGE_GET_STATUS),
				this.commandService.executeCommand<BridgeAccessStatus>(BRIDGE_ACCESS_GET_STATUS),
			]);
			if (status) this.render(status);
			if (accessStatus) this.renderAccess(accessStatus);
		} catch (error) {
			this.renderLocalError(error instanceof Error ? error.message : String(error));
		}
	}

	private renderAccess(status: BridgeAccessStatus): void {
		const previousStatus = this.lastAccessStatus;
		const needsAttention = !status.serverConfigured || Boolean(status.error) || !status.signedIn || !status.licensed;
		const previouslyNeededAttention = previousStatus
			? !previousStatus.serverConfigured || Boolean(previousStatus.error) || !previousStatus.signedIn || !previousStatus.licensed
			: true;
		this.lastAccessStatus = status;
		if (needsAttention) {
			this.accessCard.open = true;
		} else if (!previousStatus || previouslyNeededAttention) {
			this.accessCard.open = false;
		}
		this.installationIdValue.value = status.installationId;
		this.installationIdValue.title = status.installationId;
		if (status.error) this.accessErrorOverride = status.error;
		else if (status.signedIn) this.accessErrorOverride = '';
		const error = status.error || this.accessErrorOverride;
		const badgeState = !status.serverConfigured || error ? 'error' : status.licensed ? 'running' : 'stopped';
		this.accessBadge.className = `shuncode-bridge-state state-${badgeState}`;
		this.accessBadge.textContent = !status.serverConfigured || error
			? localizeBridge('shuncodeBridge.actionRequired', "Action required")
			: status.licensed
				? localizeBridge('shuncodeBridge.authorized', "Authorized")
				: status.signedIn
					? localizeBridge('shuncodeBridge.notActive', "Not active")
					: localizeBridge('shuncodeBridge.signInRequiredBadge', "Sign in");

		const accountLabel = this.accessAccountLabel(status);
		if (!status.serverConfigured) {
			this.accessDetails.textContent = localizeBridge('shuncodeBridge.serviceUnavailableSummary', "Bridge license service unavailable");
			this.accessMessage.textContent = localizeBridge('shuncodeBridge.notConfigured', "This ShunCode build does not contain a Bridge licensing trust anchor.");
		} else if (error) {
			this.accessDetails.textContent = status.signedIn && accountLabel
				? localizeBridge('shuncodeBridge.accountNeedsAttention', "{0} · access needs attention", accountLabel)
				: localizeBridge('shuncodeBridge.accessNeedsAttention', "Bridge access needs attention");
			this.accessMessage.textContent = error;
		} else if (!status.signedIn) {
			this.accessDetails.textContent = localizeBridge('shuncodeBridge.accountNotConnected', "Account not connected");
			this.accessMessage.textContent = localizeBridge('shuncodeBridge.signedOutDetailShort', "Sign in with GitHub or Gitee to check or purchase Bridge access.");
		} else if (status.licensed) {
			const entitlement = status.permanent
				? localizeBridge('shuncodeBridge.lifetimeAccess', "shunlimited access")
				: status.expiresAt
					? localizeBridge('shuncodeBridge.expiresAt', "access through {0}", new Date(status.expiresAt).toLocaleString())
					: localizeBridge('shuncodeBridge.activeAccess', "active access");
			this.accessDetails.textContent = localizeBridge('shuncodeBridge.accountLicensedCompact', "{0} · {1} · current device authorized", accountLabel, entitlement);
			this.accessMessage.textContent = localizeBridge('shuncodeBridge.accountManagement', "Manage the installation ID, refresh the license, or sign out.");
		} else {
			this.accessDetails.textContent = localizeBridge('shuncodeBridge.accountUnlicensedCompact', "{0} · Bridge access not active", accountLabel);
			this.accessMessage.textContent = localizeBridge('shuncodeBridge.accountUnlicensed', "Purchase a plan or redeem an activation code to enable Bridge.");
		}

		this.installationSection.style.display = status.signedIn ? '' : 'none';
		this.signInButton.element.style.display = status.signedIn ? 'none' : '';
		this.giteeSignInButton.element.style.display = status.signedIn ? 'none' : '';
		this.refreshSessionButton.element.style.display = status.signedIn ? 'none' : '';
		this.refreshLicenseButton.element.style.display = status.signedIn ? '' : 'none';
		this.signOutButton.element.style.display = status.signedIn ? '' : 'none';
		const showPurchaseOptions = status.signedIn && !error;
		const showActivationOptions = status.signedIn && !status.licensed && !error;
		this.purchaseSection.style.display = showPurchaseOptions ? '' : 'none';
		this.activationSection.style.display = showActivationOptions ? '' : 'none';
		this.purchaseTitle.textContent = status.licensed
			? localizeBridge('shuncodeBridge.renewTitle', "Renew Bridge access")
			: localizeBridge('shuncodeBridge.purchaseTitle', "Purchase Bridge access");
		this.purchaseButton.label = `$(${Codicon.creditCard.id}) ${status.licensed
			? localizeBridge('shuncodeBridge.renew', "Renew")
			: localizeBridge('shuncodeBridge.purchase', "Purchase")}`;

		const selectedPlan = this.planSelect.value;
		dom.clearNode(this.planSelect);
		for (const plan of status.plans) {
			const option = dom.append(this.planSelect, dom.$<HTMLOptionElement>('option'));
			option.value = plan.id;
			option.text = `${plan.name} · ¥${plan.amount}`;
		}
		if (status.plans.some(plan => plan.id === selectedPlan)) this.planSelect.value = selectedPlan;

		const selectedPaymentType = this.paymentTypeSelect.value;
		dom.clearNode(this.paymentTypeSelect);
		for (const paymentType of status.paymentTypes) {
			const option = dom.append(this.paymentTypeSelect, dom.$<HTMLOptionElement>('option'));
			option.value = paymentType;
			option.text = paymentType === 'alipay' ? localizeBridge('shuncodeBridge.alipay', "Alipay") : paymentType;
		}
		if (status.paymentTypes.includes(selectedPaymentType)) this.paymentTypeSelect.value = selectedPaymentType;

		const order = status.paymentOrder;
		if (!order.id) {
			this.paymentDetails.textContent = status.plans.length
				? ''
				: (status.plansError
					? localizeBridge('shuncodeBridge.plansLoadFailed', "Could not load payment plans: {0}", status.plansError)
					: localizeBridge('shuncodeBridge.plansUnavailable', "Payment plans are currently unavailable. Refresh the license service and try again."));
		} else if (order.status === 'pending') {
			this.paymentDetails.textContent = localizeBridge('shuncodeBridge.paymentPending', "Payment pending · {0} · ¥{1}. Complete checkout in your browser; this page checks the order automatically.", order.planName, order.amount);
		} else if (order.status === 'paid') {
			this.paymentDetails.textContent = localizeBridge('shuncodeBridge.paymentPaid', "Payment confirmed. Refreshing your Bridge license…");
		} else {
			const paymentStatus = order.status
				? localizeBridge(`shuncodeBridge.paymentOrderStatus.${order.status}`, order.status)
				: localizeBridge('shuncodeBridge.unknown', "unknown");
			this.paymentDetails.textContent = localizeBridge('shuncodeBridge.paymentStatus', "Last payment: {0} · {1}.", order.planName || order.id, paymentStatus);
		}
		this.checkPaymentButton.element.style.display = order.status === 'pending' ? '' : 'none';
		this.updateControls();
		if (status.signedIn && !status.plans.length && !this.paymentPlansFetchAttempted && !this.busy) {
			this.paymentPlansFetchAttempted = true;
			void this.fetchPaymentPlans(true);
		}
	}

	private errorDetailText(status: BridgeStatus): string {
		const lastError = status.lastError ?? localizeBridge('shuncodeBridge.bridgeErrorDetail', "Bridge could not start.");
		if (!status.lastError) {
			return lastError;
		}
		if (/trycloudflare\.com URL/i.test(status.lastError)
			|| (/cloudflared/i.test(status.lastError) && /edge|quic|unable to establish/i.test(status.lastError))) {
			return `${lastError} ${localizeBridge('shuncodeBridge.cloudflaredEdgeBlockedHint', "cloudflared could not reach the Cloudflare edge (QUIC/UDP 7844). HTTP proxies do not affect cloudflared; use a system/global (TUN) proxy and retry.")}`;
		}
		if (/health check timed out/i.test(status.lastError)) {
			return `${lastError} ${localizeBridge('shuncodeBridge.healthCheckTimedOutHint', "The public health check timed out. This machine may not be able to reach the endpoint directly. Configure http.proxy or a system/global (TUN) proxy and retry.")}`;
		}
		if (/health endpoint unreachable/i.test(status.lastError)) {
			return `${lastError} ${localizeBridge('shuncodeBridge.healthCheckUnreachableHint', "This machine cannot reach the public Bridge endpoint (possibly blocked by the network). Configure http.proxy or a system/global (TUN) proxy and retry.")}`;
		}
		return lastError;
	}

	private render(status: BridgeStatus): void {
		const previousStatus = this.lastStatus;
		this.lastStatus = status;
		const isQuick = status.tunnelProvider === 'cloudflare';
		const isNamed = status.tunnelProvider === 'cloudflare-named';
		const isNgrok = status.tunnelProvider === 'ngrok';
		this.cloudflareProviderButton.classList.toggle('selected', isQuick);
		this.cloudflareProviderButton.setAttribute('aria-checked', String(isQuick));
		this.cloudflareNamedProviderButton.classList.toggle('selected', isNamed);
		this.cloudflareNamedProviderButton.setAttribute('aria-checked', String(isNamed));
		this.ngrokProviderButton.classList.toggle('selected', isNgrok);
		this.ngrokProviderButton.setAttribute('aria-checked', String(isNgrok));
		if (status.tunnelInstalled === undefined && this.autoCheckedTunnelProvider !== status.tunnelProvider && !this.busy) {
			this.autoCheckedTunnelProvider = status.tunnelProvider;
			void this.runCommand(BRIDGE_CHECK_TUNNEL);
		}
		this.domainField.style.display = isNgrok ? '' : 'none';
		this.namedTunnelConfiguration.style.display = isNamed ? '' : 'none';
		if (this.domainInputDirty && this.domainInput.value.trim().toLowerCase() === status.configuredDomain) {
			this.domainInputDirty = false;
		}
		if (!this.domainInputDirty && this.domainInput.value !== status.configuredDomain) {
			this.domainInput.value = status.configuredDomain;
		}
		if (!this.namedTunnelInputDirty) {
			this.namedTunnelDomainInput.value = status.configuredNamedDomain;
			this.namedTunnelPortInput.value = String(status.namedTunnelLocalPort);
		}
		this.namedTunnelTokenStatus.textContent = status.namedTunnelTokenConfigured
			? localizeBridge('shuncodeBridge.cloudflareTunnelTokenSaved', "Token saved securely. Leave the field blank to keep it.")
			: localizeBridge('shuncodeBridge.cloudflareTunnelTokenMissing', "No token saved.");
		this.updateNamedTunnelOriginPreview();

		this.stateBadge.className = `shuncode-bridge-state state-${status.state}`;
		this.stateBadge.textContent = status.state === 'running'
			? localizeBridge('shuncodeBridge.running', "Running")
			: status.state === 'starting'
				? localizeBridge('shuncodeBridge.starting', "Starting…")
				: status.state === 'error'
					? localizeBridge('shuncodeBridge.error', "Error")
					: localizeBridge('shuncodeBridge.stopped', "Stopped");

		this.stateDetails.textContent = status.state === 'running'
			? localizeBridge('shuncodeBridge.runningDetailCompact', "Remote endpoint active · {0} active request(s)", status.activeRequests)
			: status.state === 'starting'
				? isQuick
					? localizeBridge('shuncodeBridge.quickTunnelStartingDetail', "Generating a new temporary Cloudflare MCP address…")
					: isNamed
						? localizeBridge('shuncodeBridge.namedTunnelStartingDetail', "Connecting the fixed Cloudflare hostname…")
						: localizeBridge('shuncodeBridge.startingDetail', "Opening the secure MCP endpoint…")
				: status.state === 'error'
					? this.errorDetailText(status)
					: isQuick
						? localizeBridge('shuncodeBridge.quickTunnelStoppedDetail', "Start Bridge to generate a temporary Cloudflare MCP address.")
						: isNamed
							? status.configuredNamedDomain
								? localizeBridge('shuncodeBridge.namedTunnelStoppedDetail', "Bridge is stopped. The fixed Cloudflare hostname is not connected.")
								: localizeBridge('shuncodeBridge.namedHostnameRequiredSummary', "Configure the Cloudflare hostname and Tunnel Token before starting.")
							: status.configuredDomain
							? localizeBridge('shuncodeBridge.stoppedDetailCompact', "Bridge is stopped. No public endpoint is open.")
							: localizeBridge('shuncodeBridge.domainRequiredSummary', "Enter an ngrok domain in Connection settings before starting.");

		const providerDomainMissing = isNgrok
			? !status.configuredDomain
			: isNamed
				? !status.configuredNamedDomain
				: false;
		const connectionNeedsAttention = status.state === 'error'
			|| status.tunnelInstalled !== true
			|| status.tunnelConfigValid !== true
			|| providerDomainMissing;
		if (connectionNeedsAttention) {
			this.connectionCard.open = true;
		}

		const connectionState = status.state === 'error'
			? 'error'
			: connectionNeedsAttention
				? 'stopped'
				: 'running';
		this.connectionBadge.className = `shuncode-bridge-state state-${connectionState}`;
		if (status.state === 'error') {
			this.connectionBadge.textContent = localizeBridge('shuncodeBridge.actionRequired', "Action required");
			this.connectionDetails.textContent = localizeBridge('shuncodeBridge.connectionErrorSummary', "Bridge connection needs attention");
		} else if (status.tunnelInstalled === undefined) {
			this.connectionBadge.textContent = localizeBridge('shuncodeBridge.checking', "Checking");
			this.connectionDetails.textContent = localizeBridge('shuncodeBridge.connectionChecking', "Checking tunnel settings…");
		} else if (!status.tunnelInstalled) {
			this.connectionBadge.textContent = localizeBridge('shuncodeBridge.setupRequired', "Setup required");
			this.connectionDetails.textContent = isQuick || isNamed
				? localizeBridge('shuncodeBridge.cloudflareNotInstalledSummary', "cloudflared is not installed")
				: localizeBridge('shuncodeBridge.ngrokNotInstalledSummary', "ngrok is not installed");
		} else if (!status.tunnelConfigValid) {
			this.connectionBadge.textContent = localizeBridge('shuncodeBridge.actionRequired', "Action required");
			this.connectionDetails.textContent = isNamed
				? localizeBridge('shuncodeBridge.cloudflareNamedConfigAttentionSummary', "Cloudflare Named Tunnel configuration needs attention")
				: localizeBridge('shuncodeBridge.ngrokConfigAttentionSummary', "ngrok configuration needs attention");
		} else if (providerDomainMissing) {
			this.connectionBadge.textContent = localizeBridge('shuncodeBridge.setupRequired', "Setup required");
			this.connectionDetails.textContent = isNamed
				? localizeBridge('shuncodeBridge.namedHostnameMissingSummary', "Cloudflare hostname not set")
				: localizeBridge('shuncodeBridge.domainMissingSummary', "Reserved domain not set");
		} else {
			this.connectionBadge.textContent = localizeBridge('shuncodeBridge.ready', "Ready");
			this.connectionDetails.textContent = isQuick
				? localizeBridge('shuncodeBridge.cloudflareReadySummary', "Cloudflare Quick Tunnel ready · temporary address changes after restart")
				: isNamed
					? localizeBridge('shuncodeBridge.cloudflareNamedReadySummary', "Cloudflare Named Tunnel ready · {0}", status.configuredNamedDomain)
					: localizeBridge('shuncodeBridge.connectionReadySummary', "ngrok ready · {0}", status.configuredDomain);
		}

		if (status.tunnelInstalled === undefined) {
			this.tunnelState.textContent = localizeBridge('shuncodeBridge.tunnelUnchecked', "The tunnel client has not been checked yet.");
		} else if (!status.tunnelInstalled) {
			this.tunnelState.textContent = isQuick || isNamed
				? localizeBridge('shuncodeBridge.cloudflareMissingAction', "cloudflared is not installed. Complete the one-time setup below.")
				: localizeBridge('shuncodeBridge.ngrokMissingAction', "ngrok is not installed. Complete the setup below.");
		} else if (!status.tunnelConfigValid) {
			this.tunnelState.textContent = isNamed
				? localizeBridge('shuncodeBridge.cloudflareNamedInvalidAction', "cloudflared is installed, but the hostname, Tunnel Token, or Service URL needs attention.")
				: localizeBridge('shuncodeBridge.ngrokInvalidAction', "ngrok is installed, but its Authtoken or configuration needs attention.");
		} else if (providerDomainMissing) {
			this.tunnelState.textContent = localizeBridge('shuncodeBridge.ngrokDomainMissing', "ngrok is ready. Add your reserved domain above.");
		} else {
			this.tunnelState.textContent = `${status.tunnelVersion ?? (isQuick || isNamed ? 'cloudflared' : 'ngrok')} · ${localizeBridge('shuncodeBridge.tunnelReady', "ready")}`;
		}

		const needsTunnelSetup = status.tunnelInstalled === false || status.tunnelConfigValid === false || providerDomainMissing;
		this.tunnelSetupPanel.classList.toggle('needs-attention', needsTunnelSetup);
		this.cloudflareSetupDetails.style.display = isQuick ? '' : 'none';
		this.cloudflareNamedSetupDetails.style.display = isNamed ? '' : 'none';
		this.ngrokSetupDetails.style.display = isNgrok ? '' : 'none';
		this.installCloudflaredButton.element.style.display = (isQuick || isNamed) ? '' : 'none';
		this.cloudflareSetupSummary.textContent = needsTunnelSetup
			? localizeBridge('shuncodeBridge.configureCloudflare', "Install cloudflared")
			: localizeBridge('shuncodeBridge.cloudflareConfigurationHelp', "cloudflared setup help");
		this.ngrokSetupSummary.textContent = needsTunnelSetup
			? localizeBridge('shuncodeBridge.configureNgrok', "Configure ngrok")
			: localizeBridge('shuncodeBridge.ngrokConfigurationHelp', "ngrok configuration help");
		this.cloudflareNamedSetupSummary.textContent = needsTunnelSetup
			? localizeBridge('shuncodeBridge.configureCloudflareNamed', "Configure Cloudflare Named Tunnel")
			: localizeBridge('shuncodeBridge.cloudflareNamedConfigurationHelp', "Cloudflare Named Tunnel setup help");
		const activeSetupDetails = isQuick
			? this.cloudflareSetupDetails
			: isNamed
				? this.cloudflareNamedSetupDetails
				: this.ngrokSetupDetails;
		const tunnelProviderChanged = this.tunnelSetupProvider !== status.tunnelProvider;
		if (needsTunnelSetup && (this.tunnelNeedsSetup !== true || tunnelProviderChanged)) {
			activeSetupDetails.open = true;
		}
		this.tunnelNeedsSetup = needsTunnelSetup;
		this.tunnelSetupProvider = status.tunnelProvider;
		this.renderHealth(status.health);

		this.publicUrlSection.style.display = status.state === 'running' && status.publicUrl ? '' : 'none';
		this.publicUrlValue.value = status.publicUrl ?? '';
		this.publicUrlValue.title = status.publicUrl ?? '';
		if (isQuick && status.state === 'running' && status.publicUrl) {
			this.addressNotice.style.display = '';
			this.addressNotice.textContent = localizeBridge('shuncodeBridge.quickTunnelAddressCopied', "Temporary MCP address copied. Replace the MCP address in ChatGPT after each Bridge restart.");
			if (status.publicUrl !== this.lastCopiedQuickTunnelUrl) {
				this.lastCopiedQuickTunnelUrl = status.publicUrl;
				void this.clipboardService.writeText(status.publicUrl);
			}
		} else {
			this.addressNotice.style.display = 'none';
		}
		if (isQuick && previousStatus?.publicUrl && previousStatus.publicUrl !== status.publicUrl && status.state === 'starting') {
			this.stateDetails.textContent = localizeBridge('shuncodeBridge.quickTunnelRecoveryDetail', "The previous temporary address expired. Generating and copying a replacement address…");
		}

		dom.clearNode(this.toolsContainer);
		for (const tool of status.toolNames) {
			const badge = dom.append(this.toolsContainer, dom.$('.shuncode-bridge-tool', undefined, tool));
			if (tool === 'report_progress' || tool === 'set_todos') {
				badge.classList.add('bridge-only');
				badge.title = tool === 'set_todos'
					? localizeBridge('shuncodeBridge.bridgeOnlyTodos', "Bridge-only durable task-state tool")
					: localizeBridge('shuncodeBridge.bridgeOnly', "Bridge-only progress reporting tool");
			}
		}

		this.updateControls();
	}

	private renderPersistentModeToggle(enabled: boolean): void {
		this.persistentModeToggle.setAttribute('aria-checked', String(enabled));
		this.persistentModeToggle.title = enabled
			? localizeBridge('shuncodeBridge.persistentModeOn', "Bridge will start automatically after restart without opening Chat")
			: localizeBridge('shuncodeBridge.persistentModeOff', "Bridge starts only when you choose Start");
	}

	private renderHealth(health: BridgeHealthReport | undefined): void {
		if (this.checkingHealth) {
			this.healthState.textContent = localizeBridge('shuncodeBridge.healthChecking', "Checking end-to-end MCP health…");
			this.healthState.title = '';
			return;
		}
		if (this.healthError) {
			this.healthState.textContent = localizeBridge('shuncodeBridge.healthFailed', "Health check failed: {0}", this.healthError);
			this.healthState.title = this.healthError;
			return;
		}
		if (!health) {
			this.healthState.textContent = localizeBridge('shuncodeBridge.healthUnchecked', "No end-to-end health check has been run yet.");
			this.healthState.title = '';
			return;
		}
		const checkedAt = new Date(health.at);
		const checkedLabel = Number.isNaN(checkedAt.getTime()) ? '' : checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
		this.healthState.textContent = checkedLabel ? `${health.summary} · ${checkedLabel}` : health.summary;
		const details = [health.summary];
		if (health.local.url) details.push(`Local: ${health.local.url}${health.local.latencyMs === undefined ? '' : ` (${health.local.latencyMs} ms)`}`);
		if (health.public?.url) details.push(`Public: ${health.public.url}${health.public.latencyMs === undefined ? '' : ` (${health.public.latencyMs} ms)`}`);
		details.push(`MCP sessions: ${health.sessions} · active requests: ${health.activeRequests}`);
		if (health.lastSessionActivityAt) details.push(`Last MCP activity: ${health.lastSessionActivityAt}`);
		this.healthState.title = details.join('\n');
	}

	private renderLocalError(message: string): void {
		this.stateBadge.className = 'shuncode-bridge-state state-error';
		this.stateBadge.textContent = localizeBridge('shuncodeBridge.error', "Error");
		this.stateDetails.textContent = message;
	}

	private renderAccessError(message: string): void {
		this.accessCard.open = true;
		this.accessErrorOverride = message;
		this.accessBadge.className = 'shuncode-bridge-state state-error';
		this.accessBadge.textContent = localizeBridge('shuncodeBridge.actionRequired', "Action required");
		const previous = this.lastAccessStatus;
		const accountLabel = previous ? this.accessAccountLabel(previous) : '';
		this.accessDetails.textContent = (previous?.signedIn && accountLabel)
			? localizeBridge('shuncodeBridge.accountNeedsAttention', "{0} · access needs attention", accountLabel)
			: localizeBridge('shuncodeBridge.accessNeedsAttention', "Bridge access needs attention");
		this.accessMessage.textContent = message;
	}

	private accessAccountLabel(status: BridgeAccessStatus): string {
		return status.githubLogin ? `GitHub @${status.githubLogin}` : status.giteeLogin ? `Gitee @${status.giteeLogin}` : '';
	}

	private updateControls(): void {
		const running = this.lastStatus?.state === 'running';
		const starting = this.lastStatus?.state === 'starting';
		const signedIn = this.lastAccessStatus?.signedIn === true;
		const isNgrok = this.lastStatus?.tunnelProvider === 'ngrok';
		const isQuick = this.lastStatus?.tunnelProvider === 'cloudflare';
		const isNamed = this.lastStatus?.tunnelProvider === 'cloudflare-named';
		this.cloudflareProviderButton.disabled = this.busy || running || starting;
		this.cloudflareNamedProviderButton.disabled = this.busy || running || starting;
		this.ngrokProviderButton.disabled = this.busy || running || starting;
		this.domainInput.disabled = this.busy || running || starting || !isNgrok;
		this.namedTunnelDomainInput.disabled = this.busy || running || starting || !isNamed;
		this.namedTunnelTokenInput.disabled = this.busy || running || starting || !isNamed;
		this.namedTunnelPortInput.disabled = this.busy || running || starting || !isNamed;
		this.saveNamedTunnelButton.enabled = !this.busy && !running && !starting && isNamed
			&& Boolean(this.namedTunnelDomainInput.value.trim())
			&& Number.isInteger(Number(this.namedTunnelPortInput.value));
		this.clearNamedTunnelTokenButton.enabled = !this.busy && !running && !starting && isNamed && this.lastStatus?.namedTunnelTokenConfigured === true;
		this.checkButton.enabled = !this.busy && !starting;
		this.healthButton.enabled = !this.busy && !starting;
		this.healthButton.label = this.checkingHealth
			? `$(${Codicon.loading.id}) ${localizeBridge('shuncodeBridge.checkingHealth', "Checking…")}`
			: `$(${Codicon.pulse.id}) ${localizeBridge('shuncodeBridge.checkHealth', "Check health")}`;
		this.installCloudflaredButton.enabled = !this.busy && !running && !starting && (isQuick || isNamed) && this.lastStatus?.tunnelInstalled !== true;
		this.installCloudflaredButton.label = this.installingCloudflared
			? `$(${Codicon.loading.id}) ${localizeBridge('shuncodeBridge.installingCloudflaredShort', "Installing…")}`
			: this.lastStatus?.tunnelInstalled
				? `$(${Codicon.check.id}) ${localizeBridge('shuncodeBridge.cloudflaredInstalled', "Installed")}`
				: `$(${Codicon.cloudDownload.id}) ${localizeBridge('shuncodeBridge.installCloudflaredNow', "Install cloudflared")}`;
		this.rotateButton.enabled = !this.busy && !running && !starting;
		this.startStopButton.enabled = !this.busy && !starting;
		this.signInButton.enabled = !this.busy;
		this.giteeSignInButton.enabled = !this.busy;
		this.refreshSessionButton.enabled = !this.busy;
		this.refreshLicenseButton.enabled = !this.busy;
		this.signOutButton.enabled = !this.busy;
		this.planSelect.disabled = this.busy;
		this.paymentTypeSelect.disabled = this.busy;
		this.purchaseButton.enabled = !this.busy && signedIn && Boolean(this.planSelect.value);
		this.checkPaymentButton.enabled = !this.busy;
		this.activationInput.disabled = this.busy;
		this.redeemButton.enabled = !this.busy && Boolean(this.activationInput.value.trim());
		this.persistentModeToggle.disabled = this.busy;
		this.quickLinkAddButton.enabled = !this.busy && Boolean(this.quickLinkNameInput.value.trim()) && Boolean(this.quickLinkUrlInput.value.trim());
		this.startStopButton.label = running
			? `$(${Codicon.debugStop.id}) ${localizeBridge('shuncodeBridge.stop', "Stop Bridge")}`
			: starting
				? `$(${Codicon.loading.id}) ${localizeBridge('shuncodeBridge.starting', "Starting…")}`
				: `$(${Codicon.play.id}) ${localizeBridge('shuncodeBridge.start', "Start Bridge")}`;
	}

	focus(): void {
		if (this.lastStatus?.tunnelProvider === 'ngrok') this.domainInput.focus();
		else if (this.lastStatus?.tunnelProvider === 'cloudflare-named') this.namedTunnelDomainInput.focus();
		else this.cloudflareProviderButton.focus();
	}

	private readQuickLinks(): BridgeQuickLink[] {
		const value = this.configurationService.getValue<unknown>(BRIDGE_QUICK_LINKS_SETTING);
		if (!Array.isArray(value)) return [];
		const links: BridgeQuickLink[] = [];
		for (const item of value) {
			if (!item || typeof item !== 'object') continue;
			const record = item as Record<string, unknown>;
			const name = typeof record.name === 'string' ? record.name.trim() : '';
			const url = typeof record.url === 'string' ? record.url.trim() : '';
			if (!name || !url) continue;
			links.push({ name: name.slice(0, QUICK_LINK_MAX_NAME_LENGTH), url: url.slice(0, QUICK_LINK_MAX_URL_LENGTH) });
		}
		return links;
	}

	private isValidQuickLinkUrl(value: string): boolean {
		return /^https?:\/\/\S+$/i.test(value);
	}

	private renderQuickLinkButtons(): void {
		dom.clearNode(this.quickLinkButtonsContainer);
		this.quickLinkButtons.forEach(button => button.dispose());
		this.quickLinkButtons = [];
		for (const link of this.readQuickLinks()) {
			if (!this.isValidQuickLinkUrl(link.url)) continue;
			const button = this._register(new Button(this.quickLinkButtonsContainer, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
			button.label = `$(${Codicon.linkExternal.id}) ${link.name}`;
			button.setTitle(link.url);
			this._register(button.onDidClick(() => this.commandService.executeCommand('simpleBrowser.show', link.url)));
			this.quickLinkButtons.push(button);
		}
	}

	private renderQuickLinksList(): void {
		dom.clearNode(this.quickLinkList);
		this.quickLinkRowButtons.forEach(button => button.dispose());
		this.quickLinkRowButtons = [];
		const links = this.readQuickLinks();
		if (!links.length) {
			this.quickLinkList.classList.add('empty');
			this.quickLinkList.textContent = localizeBridge('shuncodeBridge.quickLinksEmpty', "No custom shortcuts yet.");
			return;
		}
		this.quickLinkList.classList.remove('empty');
		for (const link of links) {
			const row = dom.append(this.quickLinkList, dom.$('.shuncode-bridge-quick-link-row'));
			const text = dom.append(row, dom.$('.shuncode-bridge-quick-link-text'));
			dom.append(text, dom.$('.shuncode-bridge-quick-link-name-text', undefined, link.name));
			dom.append(text, dom.$('.shuncode-bridge-quick-link-url-text', undefined, link.url));
			const actions = dom.append(row, dom.$('.shuncode-bridge-quick-link-actions'));
			const openButton = this._register(new Button(actions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
			openButton.label = `$(${Codicon.linkExternal.id}) ${localizeBridge('shuncodeBridge.quickLinkOpen', "Open")}`;
			this._register(openButton.onDidClick(() => this.commandService.executeCommand('simpleBrowser.show', link.url)));
			this.quickLinkRowButtons.push(openButton);
			const deleteButton = this._register(new Button(actions, { ...defaultButtonStyles, secondary: true, supportIcons: true }));
			deleteButton.label = `$(${Codicon.trash.id}) ${localizeBridge('shuncodeBridge.quickLinkDelete', "Delete")}`;
			this._register(deleteButton.onDidClick(() => this.removeQuickLink(link)));
			this.quickLinkRowButtons.push(deleteButton);
		}
	}

	private async addQuickLink(): Promise<void> {
		const name = this.quickLinkNameInput.value.trim();
		const url = this.quickLinkUrlInput.value.trim();
		if (!name) {
			this.renderQuickLinkMessage(localizeBridge('shuncodeBridge.quickLinkNameRequired', "Enter a name for the shortcut."));
			this.quickLinkNameInput.focus();
			return;
		}
		if (!this.isValidQuickLinkUrl(url)) {
			this.renderQuickLinkMessage(localizeBridge('shuncodeBridge.quickLinkUrlInvalid', "Enter a valid http:// or https:// address."));
			this.quickLinkUrlInput.focus();
			return;
		}
		const normalizedUrl = url.slice(0, QUICK_LINK_MAX_URL_LENGTH);
		const links = this.readQuickLinks();
		if (links.some(link => link.url.toLowerCase() === normalizedUrl.toLowerCase())) {
			this.renderQuickLinkMessage(localizeBridge('shuncodeBridge.quickLinkUrlDuplicate', "This address is already in the list."));
			this.quickLinkUrlInput.focus();
			return;
		}
		const next = [...links, { name: name.slice(0, QUICK_LINK_MAX_NAME_LENGTH), url: normalizedUrl }];
		try {
			await this.configurationService.updateValue(BRIDGE_QUICK_LINKS_SETTING, next, ConfigurationTarget.USER);
			this.quickLinkNameInput.value = '';
			this.quickLinkUrlInput.value = '';
			this.renderQuickLinkMessage('');
			this.updateControls();
		} catch (error) {
			this.renderQuickLinkMessage(error instanceof Error ? error.message : String(error));
		}
	}

	private async removeQuickLink(link: BridgeQuickLink): Promise<void> {
		const result = await this.dialogService.confirm({
			type: 'warning',
			message: localizeBridge('shuncodeBridge.quickLinkDeleteConfirm', "Delete the quick open shortcut “{0}”?", link.name),
			detail: localizeBridge('shuncodeBridge.quickLinkDeleteConfirmDetail', "The button is removed from the top of this page."),
			primaryButton: localizeBridge('shuncodeBridge.quickLinkDelete', "Delete"),
		});
		if (!result.confirmed) return;
		const next = this.readQuickLinks().filter(candidate => candidate.url !== link.url || candidate.name !== link.name);
		try {
			await this.configurationService.updateValue(BRIDGE_QUICK_LINKS_SETTING, next, ConfigurationTarget.USER);
		} catch (error) {
			this.renderQuickLinkMessage(error instanceof Error ? error.message : String(error));
		}
	}

	private renderQuickLinkMessage(message: string): void {
		this.quickLinkMessage.textContent = message;
		this.quickLinkMessage.classList.toggle('visible', Boolean(message));
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}
}

aiCustomizationManagementSectionRegistry.register({
	id: AICustomizationManagementSection.Bridge,
	label: localizeBridge('shuncodeBridge.navigationLabel', "Bridge"),
	icon: Codicon.radioTower,
	description: localizeBridge('shuncodeBridge.navigationDescription', "Expose ShunCode tools as a remote Streamable HTTP MCP endpoint."),
	supportsHarness: () => true,
	create: (instantiationService, container) => instantiationService.createInstance(ShunCodeBridgeWidget, container),
});

