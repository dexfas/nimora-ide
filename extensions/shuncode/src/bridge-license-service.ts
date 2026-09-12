import { createPublicKey, randomUUID, verify as verifySignature } from "node:crypto";
import { createServer } from "node:http";
import * as vscode from "vscode";
import { BRIDGE_LICENSE_BUILD_CONFIG } from "./bridge-license-config.js";
import { fetchWithExtensionHostFallbacks, resolveExtensionHostProxy } from "./extension-host-proxy.mjs";

const SESSION_TOKEN_KEY = "shuncode.bridgeLicense.sessionToken";
const LICENSE_TOKEN_KEY = "shuncode.bridgeLicense.licenseToken";
const INSTALLATION_ID_KEY = "shuncode.bridgeLicense.installationId";
const ACCOUNT_STATE_KEY = "shuncode.bridgeLicense.account";
const PAYMENT_ORDER_STATE_KEY = "shuncode.bridgeLicense.paymentOrder";
const PAYMENT_POLL_INTERVAL_MS = 3_000;
const PAYMENT_POLL_MAX_INTERVAL_MS = 15_000;
const PAYMENT_POLL_ERROR_NOTIFY_COUNT = 5;
const PAYMENT_PLAN_CACHE_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const GITHUB_SCOPES = ["read:user"];
const GITEE_SIGNIN_PATH = "/shuncode/gitee/signin";
const GITEE_CALLBACK_PATH = "/shuncode/gitee/callback";
const GITEE_RELAY_PATH = "/v1/auth/gitee/callback";
const GITEE_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const GITEE_CALLBACK_PAGE_PENDING = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ShunCode</title></head><body style="font-family:system-ui;padding:24px;line-height:1.6"><h2 id="title">Gitee 授权已收到</h2><p id="detail">ShunCode 正在完成登录，请保持此页面打开。</p>`;
const GITEE_CALLBACK_PAGE_DENIED = `<!doctype html><html><head><meta charset="utf-8"><title>ShunCode</title></head><body style="font-family: system-ui; padding: 24px;"><h2>Gitee 授权已取消</h2><p>可以关闭此页面并返回 ShunCode。</p></body></html>`;
const GITEE_CALLBACK_PAGE_INVALID = `<!doctype html><html><head><meta charset="utf-8"><title>ShunCode</title></head><body style="font-family: system-ui; padding: 24px;"><h2>Gitee 登录回调无效</h2><p>请返回 ShunCode 后重新登录。</p></body></html>`;

// Licensing is intentionally disabled in the open-source desktop build. Keep
// this behind a function so the dormant licensed path remains type-checkable
// and can still be audited without changing the current runtime behavior.
function isBridgeFreeAccessEnabled(): boolean {
  return true;
}

export interface BridgeLicenseStatusSnapshot {
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
}

export interface BridgePaymentPlanSnapshot {
  readonly id: string;
  readonly name: string;
  readonly amount: string;
  readonly amountCents: number;
  readonly durationDays: number | null;
}

export interface BridgePaymentOrderSnapshot {
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

export interface BridgeAccessSnapshot extends BridgeLicenseStatusSnapshot {
  readonly plans: BridgePaymentPlanSnapshot[];
  readonly paymentTypes: string[];
  readonly plansError: string;
  readonly paymentOrder: BridgePaymentOrderSnapshot;
}

interface AccountState {
  readonly id: string;
  readonly githubUserId: string;
  readonly githubLogin: string;
  readonly giteeUserId: string;
  readonly giteeLogin: string;
  readonly email: string;
  readonly avatarUrl?: string;
}

interface PublicKeyInfo {
  readonly publicKeyPem: string;
  readonly issuer: string;
  readonly audience: string;
}

interface JwtClaims {
  readonly iss?: string;
  readonly aud?: string | string[];
  readonly sub?: string;
  readonly exp?: number;
  readonly nbf?: number;
  readonly kind?: string;
  readonly features?: string[];
  readonly installation_id?: string;
  readonly github_login?: string;
  readonly entitlement_exp?: number | null;
}

interface AuthResponse {
  readonly sessionToken: string;
  readonly user: {
    readonly id: string;
    readonly githubUserId: string | number;
    readonly githubLogin: string;
    readonly giteeUserId?: string | number;
    readonly giteeLogin?: string;
    readonly email?: string;
    readonly avatarUrl?: string;
  };
}

interface LicenseResponse {
  readonly licenseToken: string;
  readonly expiresAt: string;
  readonly entitlementExpiresAt?: string | null;
  readonly user?: AuthResponse["user"];
}

interface PaymentPlansResponse {
  readonly plans?: Array<{
    readonly id?: unknown;
    readonly name?: unknown;
    readonly amount?: unknown;
    readonly amountCents?: unknown;
    readonly durationDays?: unknown;
  }>;
  readonly paymentTypes?: unknown;
}

interface PaymentOrderResponse {
  readonly order: {
    readonly id: string;
    readonly status: string;
    readonly planId: string;
    readonly planName: string;
    readonly amount: string;
    readonly paymentType: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly paidAt?: string;
    readonly entitlementExpiresAt?: string;
  };
  readonly checkoutUrl?: string;
}

class LicenseHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

interface GiteeAuthorizationCode {
  readonly code: string;
  complete(error?: unknown): void;
}

export class BridgeLicenseService implements vscode.Disposable {
  private paymentMonitorGeneration = 0;
  private paymentMonitorTimer: ReturnType<typeof setTimeout> | undefined;
  private plans: BridgePaymentPlanSnapshot[] = [];
  private paymentTypes: string[] = ["alipay"];
  private plansFetchedAt = 0;
  private plansError = "";

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  async initialize(): Promise<void> {
    if (isBridgeFreeAccessEnabled()) {
      this.stopPaymentMonitor();
      this.plans = [];
      this.paymentTypes = [];
      this.plansError = "";
      this.output.appendLine("[bridge] free access enabled; licensing and payments are disabled");
      return;
    }
    const storedOrder = this.context.globalState.get<BridgePaymentOrderSnapshot>(PAYMENT_ORDER_STATE_KEY);
    if (storedOrder?.id && storedOrder.status === "pending") {
      this.startPaymentMonitor(storedOrder.id, 1_000);
    }
    try {
      await this.loadPlans();
    } catch (error) {
      this.output.appendLine(`[bridge-license] failed to preload payment plans: ${this.messageOf(error)}`);
    }
  }

  private get configuration(): PublicKeyInfo & { serverUrl: string; giteeClientId?: string; giteeRedirectUri: string } {
    const allowDevelopmentOverrides = this.context.extensionMode === vscode.ExtensionMode.Development;
    const developmentServerUrl = allowDevelopmentOverrides ? process.env.SHUNCODE_BRIDGE_LICENSE_SERVER_URL : undefined;
    const developmentPublicKey = allowDevelopmentOverrides ? process.env.SHUNCODE_BRIDGE_LICENSE_PUBLIC_KEY_PEM : undefined;
    const developmentIssuer = allowDevelopmentOverrides ? process.env.SHUNCODE_BRIDGE_LICENSE_ISSUER : undefined;
    const developmentAudience = allowDevelopmentOverrides ? process.env.SHUNCODE_BRIDGE_LICENSE_AUDIENCE : undefined;
    const developmentGiteeClientId = allowDevelopmentOverrides ? process.env.SHUNCODE_BRIDGE_LICENSE_GITEE_CLIENT_ID : undefined;
    const developmentGiteeRedirectUri = allowDevelopmentOverrides ? process.env.SHUNCODE_BRIDGE_LICENSE_GITEE_REDIRECT_URI : undefined;
    const serverUrl = (developmentServerUrl || BRIDGE_LICENSE_BUILD_CONFIG.serverUrl).trim().replace(/\/+$/, "");
    return {
      serverUrl,
      publicKeyPem: (developmentPublicKey || BRIDGE_LICENSE_BUILD_CONFIG.publicKeyPem).trim().replace(/\\n/g, "\n"),
      issuer: (developmentIssuer || BRIDGE_LICENSE_BUILD_CONFIG.issuer || serverUrl).trim().replace(/\/+$/, ""),
      audience: (developmentAudience || BRIDGE_LICENSE_BUILD_CONFIG.audience).trim() || "shuncode-desktop",
      giteeClientId: (developmentGiteeClientId || BRIDGE_LICENSE_BUILD_CONFIG.giteeClientId || "").trim(),
      giteeRedirectUri: (developmentGiteeRedirectUri || (serverUrl ? `${serverUrl}${GITEE_RELAY_PATH}` : "")).trim(),
    };
  }

  async getStatus(error = ""): Promise<BridgeAccessSnapshot> {
    if (isBridgeFreeAccessEnabled()) {
      const freeInstallationId = await this.getInstallationId();
      return {
        serverConfigured: true,
        signedIn: true,
        installationId: freeInstallationId,
        githubUserId: "",
        githubLogin: "",
        giteeUserId: "",
        giteeLogin: "",
        email: "",
        avatarUrl: "",
        licensed: true,
        expiresAt: "",
        permanent: true,
        error: "",
        plans: [],
        paymentTypes: [],
        plansError: "",
        paymentOrder: this.emptyPaymentOrder(""),
      };
    }
    const { serverUrl, publicKeyPem, issuer } = this.configuration;
    const account = this.context.globalState.get<AccountState>(ACCOUNT_STATE_KEY);
    const [licenseToken, sessionToken, installationId] = await Promise.all([
      this.context.secrets.get(LICENSE_TOKEN_KEY),
      this.context.secrets.get(SESSION_TOKEN_KEY),
      this.getInstallationId(),
    ]);

    let licensed = false;
    let expiresAt = "";
    let permanent = false;
    let tokenError = "";
    if (licenseToken) {
      try {
        const claims = await this.verifyLicenseToken(licenseToken, "bridge");
        licensed = true;
        permanent = claims.entitlement_exp === null;
        expiresAt = typeof claims.entitlement_exp === "number" ? new Date(claims.entitlement_exp * 1000).toISOString() : "";
      } catch (cause) {
        tokenError = this.messageOf(cause);
      }
    }

    return {
      serverConfigured: Boolean(serverUrl && publicKeyPem && issuer),
      signedIn: Boolean(account && sessionToken),
      installationId,
      githubUserId: account?.githubUserId ?? "",
      githubLogin: account?.githubLogin ?? "",
      giteeUserId: account?.giteeUserId ?? "",
      giteeLogin: account?.giteeLogin ?? "",
      email: account?.email ?? "",
      avatarUrl: account?.avatarUrl ?? "",
      licensed,
      expiresAt,
      permanent,
      error: error || tokenError,
      plans: this.plans.map((plan) => ({ ...plan })),
      paymentTypes: [...this.paymentTypes],
      plansError: this.plansError,
      paymentOrder: this.context.globalState.get<BridgePaymentOrderSnapshot>(PAYMENT_ORDER_STATE_KEY) ?? this.emptyPaymentOrder(""),
    };
  }

  async signIn(): Promise<BridgeAccessSnapshot> {
    return await this.completeSignIn(() => this.exchangeGitHubSession(true));
  }

  /**
   * Signs in with Gitee using the OAuth authorization-code flow. A browser
   * window opens gitee.com/oauth/authorize and the code is delivered to a
   * local loopback callback, then exchanged by the license server (the
   * Gitee client secret never leaves the server).
   */
  async signInWithGitee(): Promise<BridgeAccessSnapshot> {
    return await this.completeSignIn(() => this.exchangeGiteeSession());
  }

  private async completeSignIn(exchange: () => Promise<string>): Promise<BridgeAccessSnapshot> {
    try {
      await exchange();
      try {
        await this.refreshLicense(false);
      } catch (error) {
        const missingEntitlement = error instanceof LicenseHttpError
          && error.status === 403
          && /no active bridge entitlement/i.test(error.message);
        if (this.isNoEntitlementError(error)) {
          await this.context.secrets.delete(LICENSE_TOKEN_KEY);
        } else if (!(error instanceof LicenseHttpError) || (error.status !== 404 && !missingEntitlement)) {
          throw error;
        }
      }
      const status = await this.getStatus();
      void this.loadPlans(true);
      return status;
    } catch (error) {
      return await this.getStatus(await this.describeError(error));
    }
  }

  async refreshSession(): Promise<BridgeAccessSnapshot> {
    try {
      await this.exchangeGitHubSession(false);
      try {
        await this.refreshLicense(false);
      } catch (error) {
        const missingEntitlement = error instanceof LicenseHttpError
          && error.status === 403
          && /no active bridge entitlement/i.test(error.message);
        if (this.isNoEntitlementError(error)) {
          await this.context.secrets.delete(LICENSE_TOKEN_KEY);
        } else if (!(error instanceof LicenseHttpError) || (error.status !== 404 && !missingEntitlement)) {
          throw error;
        }
      }
      return await this.getStatus();
    } catch (error) {
      return await this.getStatus(await this.describeError(error));
    }
  }

  async redeem(activationCode: string): Promise<BridgeAccessSnapshot> {
    const code = activationCode.trim();
    if (!code) return await this.getStatus("Activation code is required.");
    try {
      const sessionToken = await this.ensureSessionToken(true);
      const installationId = await this.getInstallationId();
      const response = await this.request<LicenseResponse>("/v1/licenses/redeem", {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ code, installationId }),
      });
      await this.storeLicenseResponse(response);
      return await this.getStatus();
    } catch (error) {
      return await this.getStatus(await this.describeError(error));
    }
  }

  async reportUsage(toolCalls: number): Promise<boolean> {
    return Number.isFinite(toolCalls) && toolCalls > 0;
    if (!Number.isFinite(toolCalls) || toolCalls <= 0) return false;
    try {
      const sessionToken = await this.ensureSessionToken(false);
      const installationId = await this.getInstallationId();
      await this.request<{ ok?: boolean }>("/v1/usage/report", {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ installationId, toolCalls }),
      });
      return true;
    } catch (error) {
      this.output.appendLine(`[bridge-license] failed to report tool usage: ${this.messageOf(error)}`);
      return false;
    }
  }

  async refresh(): Promise<BridgeAccessSnapshot> {
    let errorMessage = "";
    try {
      await this.refreshLicense(true);
    } catch (error) {
      if (this.isNoEntitlementError(error)) {
        await this.context.secrets.delete(LICENSE_TOKEN_KEY);
      } else {
        errorMessage = await this.describeError(error);
      }
    }
    await this.loadPlans(true);
    return await this.getStatus(errorMessage);
  }

  async signOut(): Promise<BridgeAccessSnapshot> {
    this.stopPaymentMonitor();
    await Promise.all([
      this.context.secrets.delete(SESSION_TOKEN_KEY),
      this.context.secrets.delete(LICENSE_TOKEN_KEY),
      this.context.globalState.update(ACCOUNT_STATE_KEY, undefined),
      this.context.globalState.update(PAYMENT_ORDER_STATE_KEY, undefined),
    ]);
    return await this.getStatus();
  }

  async loadPlans(force = false): Promise<BridgeAccessSnapshot> {
    if (!force && this.plans.length && Date.now() - this.plansFetchedAt < PAYMENT_PLAN_CACHE_MS) {
      return await this.getStatus();
    }
    try {
      const response = await this.request<PaymentPlansResponse>("/v1/payments/plans", { method: "GET" });
      this.plans = this.parsePaymentPlans(response);
      this.paymentTypes = Array.isArray(response.paymentTypes)
        ? response.paymentTypes.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        : ["alipay"];
      if (!this.paymentTypes.length) this.paymentTypes = ["alipay"];
      this.plansFetchedAt = Date.now();
      this.plansError = this.plans.length ? "" : "Payment plans are currently unavailable.";
      return await this.getStatus();
    } catch (error) {
      this.plansError = this.messageOf(error);
      this.output.appendLine(`[bridge-license] failed to load payment plans: ${this.plansError}`);
      return await this.getStatus();
    }
  }

  async createPayment(planId: string, paymentType: string): Promise<BridgeAccessSnapshot> {
    try {
      const sessionToken = await this.ensureSessionToken(true);
      const response = await this.request<PaymentOrderResponse>("/v1/payments/orders", {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ planId: planId.trim(), paymentType: paymentType.trim() || "alipay" }),
      });
      const order = this.toPaymentOrder(response);
      this.validateCheckoutUrl(order.checkoutUrl);
      await this.persistPaymentOrder(order);
      this.startPaymentMonitor(order.id);
      await vscode.env.openExternal(vscode.Uri.parse(order.checkoutUrl));
      return await this.getStatus();
    } catch (error) {
      return await this.getStatus(this.messageOf(error));
    }
  }

  async getPaymentOrder(orderId = ""): Promise<BridgeAccessSnapshot> {
    const storedOrder = this.context.globalState.get<BridgePaymentOrderSnapshot>(PAYMENT_ORDER_STATE_KEY);
    const resolvedOrderId = orderId.trim() || storedOrder?.id || "";
    try {
      const sessionToken = await this.ensureSessionToken(false);
      const path = resolvedOrderId
        ? `/v1/payments/orders/${encodeURIComponent(resolvedOrderId)}`
        : "/v1/payments/orders/latest";
      const response = await this.request<PaymentOrderResponse>(path, {
        method: "GET",
        headers: { Authorization: `Bearer ${sessionToken}` },
      });
      const order = this.toPaymentOrder(response);
      await this.persistPaymentOrder(order);
      if (order.status === "paid") {
        this.stopPaymentMonitor();
        try {
          await this.refreshLicense(true);
        } catch (error) {
          this.output.appendLine(`[bridge-license] payment succeeded but license refresh failed: ${this.messageOf(error)}`);
          if (this.isNoEntitlementError(error)) {
            await this.context.secrets.delete(LICENSE_TOKEN_KEY);
          }
          const detail = await this.describeError(error);
          void vscode.window.showErrorMessage(`Bridge 授权刷新失败：${detail}`);
          return await this.getStatus(detail);
        }
      } else if (["expired", "failed", "refunded"].includes(order.status)) {
        this.stopPaymentMonitor();
      }
      return await this.getStatus();
    } catch (error) {
      if (!resolvedOrderId && error instanceof LicenseHttpError && error.status === 404) {
        return await this.getStatus();
      }
      return await this.getStatus(this.messageOf(error));
    }
  }

  async requireFeature(feature: "bridge"): Promise<void> {
    if (isBridgeFreeAccessEnabled()) {
      void feature;
      return;
    }
    const { serverUrl, publicKeyPem, issuer } = this.configuration;
    if (!serverUrl || !publicKeyPem || !issuer) {
      throw new Error("Bridge licensing trust anchor is not configured in this build.");
    }

    const cachedToken = await this.context.secrets.get(LICENSE_TOKEN_KEY);
    let cachedClaims: JwtClaims | undefined;
    if (cachedToken) {
      try {
        cachedClaims = await this.verifyLicenseToken(cachedToken, feature);
      } catch {
        cachedClaims = undefined;
      }
    }

    try {
      await this.refreshLicense(true);
    } catch (error) {
      if (error instanceof LicenseHttpError && [401, 403, 404].includes(error.status)) {
        await this.context.secrets.delete(LICENSE_TOKEN_KEY);
        throw new Error(await this.describeError(error));
      }
      if (cachedClaims) {
        this.output.appendLine(`[bridge-license] online refresh failed; using still-valid cached license: ${this.messageOf(error)}`);
        return;
      }
      throw new Error(`Bridge is not activated. ${this.messageOf(error)}`);
    }
  }

  private async refreshLicense(retryAuthentication: boolean): Promise<JwtClaims> {
    let sessionToken = await this.ensureSessionToken(false);
    const installationId = await this.getInstallationId();
    try {
      const response = await this.request<LicenseResponse>("/v1/licenses/refresh", {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ installationId }),
      });
      await this.storeLicenseResponse(response);
      return await this.verifyLicenseToken(response.licenseToken, "bridge");
    } catch (error) {
      if (!(error instanceof LicenseHttpError) || error.status !== 401 || !retryAuthentication) throw error;
      sessionToken = await this.exchangeGitHubSession(false);
      const response = await this.request<LicenseResponse>("/v1/licenses/refresh", {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ installationId }),
      });
      await this.storeLicenseResponse(response);
      return await this.verifyLicenseToken(response.licenseToken, "bridge");
    }
  }

  private async ensureSessionToken(interactive: boolean): Promise<string> {
    const stored = await this.context.secrets.get(SESSION_TOKEN_KEY);
    if (stored) return stored;
    return await this.exchangeGitHubSession(interactive);
  }

  private async exchangeGitHubSession(interactive: boolean): Promise<string> {
    const session = await vscode.authentication.getSession("github", GITHUB_SCOPES, interactive
      ? { forceNewSession: true, clearSessionPreference: true }
      : { createIfNone: false, silent: true });
    if (!session) {
      throw new Error("Sign in with GitHub before activating Bridge.");
    }
    return await this.exchangeGitHubToken(session.accessToken);
  }

  private async exchangeGitHubToken(githubToken: string): Promise<string> {
    const installationId = await this.getInstallationId();
    const response = await this.request<AuthResponse>("/v1/auth/github", {
      method: "POST",
      headers: { Authorization: `Bearer ${githubToken}` },
      body: JSON.stringify({ installationId }),
    });
    await this.persistAuthResponse(response);
    return response.sessionToken;
  }

  private async exchangeGiteeSession(): Promise<string> {
    const { giteeClientId: clientId, giteeRedirectUri: redirectUri } = this.configuration;
    if (!clientId) throw new Error("Gitee sign-in is not configured in this ShunCode build.");
    if (!redirectUri) throw new Error("Gitee sign-in redirect is not configured in this ShunCode build.");
    this.output.appendLine(`[bridge-license] gitee sign-in started with clientId ${clientId.slice(0, 8)}…`);
    const authorization = await this.captureGiteeAuthorizationCode(clientId, redirectUri);
    try {
      this.output.appendLine("[bridge-license] gitee authorization code received; exchanging with license service");
      const installationId = await this.getInstallationId();
      const response = await this.request<AuthResponse>("/v1/auth/gitee", {
        method: "POST",
        body: JSON.stringify({ code: authorization.code, redirectUri, installationId }),
      });
      await this.persistAuthResponse(response);
      this.output.appendLine(`[bridge-license] gitee sign-in completed for ${response.user.giteeLogin || response.user.githubLogin || response.user.id}`);
      authorization.complete();
      return response.sessionToken;
    } catch (error) {
      authorization.complete(error);
      throw error;
    }
  }

  private captureGiteeAuthorizationCode(clientId: string, redirectUri: string): Promise<GiteeAuthorizationCode> {
    return new Promise<GiteeAuthorizationCode>((resolve, reject) => {
      let settled = false;
      const nonce = randomUUID();
      let expectedState = "";
      let authorizeUrl = "";
      const closeServerSoon = (): void => {
        const closeTimer = setTimeout(() => server.close(), 5_000);
        closeTimer.unref?.();
      };
      const settleError = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        server.close();
        this.output.appendLine(`[bridge-license] gitee sign-in failed before code exchange: ${error.message}`);
        reject(error);
      };
      const server = createServer((request, response) => {
        const address = server.address();
        const port = address && typeof address !== "string" ? address.port : 0;
        const url = new URL(request.url ?? "/", `http://127.0.0.1:${port || 80}`);
        if (url.pathname === GITEE_SIGNIN_PATH) {
          if (!authorizeUrl || url.searchParams.get("nonce") !== nonce) {
            response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
            response.end("Invalid ShunCode Gitee sign-in request.");
            return;
          }
          response.writeHead(302, { Location: authorizeUrl, "Cache-Control": "no-store" });
          response.end();
          return;
        }
        if (url.pathname !== GITEE_CALLBACK_PATH) {
          response.writeHead(404);
          response.end();
          return;
        }
        const error = url.searchParams.get("error");
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        this.output.appendLine(`[bridge-license] gitee callback received: error=${error ?? ""} hasCode=${Boolean(code)}`);
        if (error === "access_denied") {
          response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          response.end(GITEE_CALLBACK_PAGE_DENIED);
          settleError(new Error("Gitee authorization was cancelled. Try again to sign in."));
          return;
        }
        if (!expectedState || state !== expectedState || !code || settled) {
          response.writeHead(400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
          response.end(GITEE_CALLBACK_PAGE_INVALID);
          if (!settled) settleError(new Error("Gitee returned an invalid authorization callback. Try again."));
          return;
        }

        settled = true;
        clearTimeout(timer);
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store, no-cache, must-revalidate",
          Pragma: "no-cache",
        });
        response.write(GITEE_CALLBACK_PAGE_PENDING);
        resolve({
          code,
          complete: (completionError?: unknown) => {
            const ok = completionError === undefined;
            const title = ok ? "Gitee 登录成功" : "Gitee 授权成功，但 ShunCode 登录失败";
            const detail = ok
              ? "ShunCode 已完成登录，可以关闭此页面。"
              : `请返回 ShunCode 查看错误并重试。${this.messageOf(completionError) ? ` 错误：${this.messageOf(completionError)}` : ""}`;
            const safeTitle = JSON.stringify(title).replace(/</g, "\\u003c");
            const safeDetail = JSON.stringify(detail).replace(/</g, "\\u003c");
            response.end(`<script>document.getElementById("title").textContent=${safeTitle};document.getElementById("detail").textContent=${safeDetail};</script></body></html>`);
            closeServerSoon();
          },
        });
      });
      const timer = setTimeout(() => settleError(new Error("Gitee sign-in timed out. Open the authorization page and complete it within 5 minutes.")), GITEE_LOGIN_TIMEOUT_MS);
      timer.unref?.();
      server.on("error", (error) => {
        settleError(error);
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          settleError(new Error("Gitee sign-in could not determine the local callback port."));
          return;
        }
        const callbackUri = `http://127.0.0.1:${address.port}${GITEE_CALLBACK_PATH}`;
        expectedState = Buffer.from(JSON.stringify({ v: 1, callback: callbackUri, nonce }), "utf8").toString("base64url");
        authorizeUrl = "https://gitee.com/oauth/authorize"
          + `?client_id=${encodeURIComponent(clientId)}`
          + `&redirect_uri=${encodeURIComponent(redirectUri)}`
          + `&response_type=code&state=${encodeURIComponent(expectedState)}`;
        const signinUrl = `http://127.0.0.1:${address.port}${GITEE_SIGNIN_PATH}?nonce=${encodeURIComponent(nonce)}`;
        this.output.appendLine(`[bridge-license] gitee callback server listening on ${callbackUri}; relay=${redirectUri}`);
        void vscode.env.openExternal(vscode.Uri.parse(signinUrl)).then(
          (opened) => {
            if (opened) {
              this.output.appendLine("[bridge-license] gitee authorization page opened in the external browser");
              void vscode.window.showInformationMessage("Gitee 授权页面已在浏览器中打开，请完成授权后返回 ShunCode。");
            } else {
              this.output.appendLine("[bridge-license] openExternal returned false, offering the manual authorization link");
              this.showGiteeManualLink(authorizeUrl);
            }
          },
          (error) => {
            this.output.appendLine(`[bridge-license] openExternal failed: ${this.messageOf(error)}`);
            this.showGiteeManualLink(authorizeUrl);
          },
        );
      });
    });
  }

  private showGiteeManualLink(authorizeUrl: string): void {
    void vscode.window.showInformationMessage("无法自动打开浏览器。请手动在浏览器中打开 Gitee 授权页面完成登录。", "复制授权链接").then((choice) => {
      if (choice === "复制授权链接") void vscode.env.clipboard.writeText(authorizeUrl);
    });
  }

  private async persistAuthResponse(response: AuthResponse): Promise<void> {
    const account = this.toAccountState(response.user);
    await Promise.all([
      this.context.secrets.store(SESSION_TOKEN_KEY, response.sessionToken),
      this.context.globalState.update(ACCOUNT_STATE_KEY, account),
    ]);
  }

  private toAccountState(user: AuthResponse["user"]): AccountState {
    return {
      id: user.id,
      githubUserId: user.githubUserId ? String(user.githubUserId) : "",
      githubLogin: user.githubLogin ?? "",
      giteeUserId: user.giteeUserId ? String(user.giteeUserId) : "",
      giteeLogin: user.giteeLogin ?? "",
      email: user.email ?? "",
      avatarUrl: user.avatarUrl,
    };
  }

  private startPaymentMonitor(orderId: string, initialDelay = PAYMENT_POLL_INTERVAL_MS): void {
    this.stopPaymentMonitor();
    const generation = this.paymentMonitorGeneration;
    let attempts = 0;
    let warnedNetwork = false;
    const poll = async () => {
      if (generation !== this.paymentMonitorGeneration) return;
      const snapshot = await this.getPaymentOrder(orderId);
      if (generation !== this.paymentMonitorGeneration) return;
      if (snapshot.paymentOrder.status === "pending" || snapshot.error) {
        attempts += 1;
        if (snapshot.error && attempts >= PAYMENT_POLL_ERROR_NOTIFY_COUNT && !warnedNetwork) {
          warnedNetwork = true;
          const detail = snapshot.error.length > 120 ? `${snapshot.error.slice(0, 120)}…` : snapshot.error;
          void vscode.window.showWarningMessage(`Bridge 支付状态检查暂时失败（${detail}），将继续自动重试。`);
        }
        const delay = Math.min(PAYMENT_POLL_INTERVAL_MS * 2 ** attempts, PAYMENT_POLL_MAX_INTERVAL_MS);
        this.paymentMonitorTimer = setTimeout(poll, delay);
        this.paymentMonitorTimer.unref?.();
      }
    };
    this.paymentMonitorTimer = setTimeout(poll, initialDelay);
    this.paymentMonitorTimer.unref?.();
  }

  private stopPaymentMonitor(): void {
    this.paymentMonitorGeneration += 1;
    if (this.paymentMonitorTimer) {
      clearTimeout(this.paymentMonitorTimer);
      this.paymentMonitorTimer = undefined;
    }
  }


  private parsePaymentPlans(response: PaymentPlansResponse): BridgePaymentPlanSnapshot[] {
    return (response.plans ?? []).flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const record = value as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      const name = typeof record.name === "string" ? record.name : "";
      if (!id || !name) return [];
      const amountCents = Number(record.amountCents ?? record.amount_cents);
      const rawDuration = record.durationDays === undefined ? record.duration_days : record.durationDays;
      const durationDays = rawDuration === null || rawDuration === undefined ? null : Number(rawDuration);
      if (!Number.isFinite(amountCents) || (durationDays !== null && !Number.isFinite(durationDays))) return [];
      return [{
        id,
        name,
        amount: typeof record.amount === "string" ? record.amount : (amountCents / 100).toFixed(2),
        amountCents,
        durationDays,
      }];
    });
  }

  private async persistPaymentOrder(order: BridgePaymentOrderSnapshot): Promise<void> {
    await this.context.globalState.update(PAYMENT_ORDER_STATE_KEY, order);
  }

  private async storeLicenseResponse(response: LicenseResponse): Promise<void> {
    await this.verifyLicenseToken(response.licenseToken, "bridge");
    await this.context.secrets.store(LICENSE_TOKEN_KEY, response.licenseToken);
    if (response.user) {
      await this.context.globalState.update(ACCOUNT_STATE_KEY, this.toAccountState(response.user));
    }
  }

  private async verifyLicenseToken(token: string, feature: string): Promise<JwtClaims> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Stored Bridge license has an invalid format.");
    let header: { alg?: string; typ?: string };
    let claims: JwtClaims;
    try {
      header = JSON.parse(this.decodeBase64Url(parts[0])) as { alg?: string; typ?: string };
      claims = JSON.parse(this.decodeBase64Url(parts[1])) as JwtClaims;
    } catch {
      throw new Error("Stored Bridge license has invalid encoding.");
    }
    if (header.alg !== "EdDSA") throw new Error("Stored Bridge license uses an unsupported signing algorithm.");
    const keyInfo = await this.getPublicKeyInfo();
    const signatureValid = verifySignature(
      null,
      Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
      createPublicKey(keyInfo.publicKeyPem),
      Buffer.from(parts[2], "base64url"),
    );
    if (!signatureValid) throw new Error("Stored Bridge license signature is invalid.");
    const now = Math.floor(Date.now() / 1000);
    if (claims.kind !== "license") throw new Error("Stored token is not a Bridge license.");
    if (claims.iss !== keyInfo.issuer) throw new Error("Stored Bridge license has an invalid issuer.");
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(keyInfo.audience)) throw new Error("Stored Bridge license has an invalid audience.");
    if (!claims.exp || claims.exp <= now) throw new Error("Stored Bridge license has expired.");
    if (!claims.features?.includes(feature)) throw new Error(`Stored license does not include the ${feature} feature.`);
    if (claims.installation_id !== await this.getInstallationId()) {
      throw new Error("Stored Bridge license belongs to a different installation.");
    }
    return claims;
  }

  private async getPublicKeyInfo(): Promise<PublicKeyInfo> {
    const { publicKeyPem, issuer, audience } = this.configuration;
    if (!publicKeyPem || !issuer || !audience) {
      throw new Error("Bridge licensing trust anchor is not configured in this build.");
    }
    return { publicKeyPem, issuer, audience };
  }

  private async getInstallationId(): Promise<string> {
    let value = await this.context.secrets.get(INSTALLATION_ID_KEY);
    if (!value) {
      value = randomUUID();
      await this.context.secrets.store(INSTALLATION_ID_KEY, value);
    }
    return value;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const { serverUrl } = this.configuration;
    if (!serverUrl) throw new Error("Bridge license server URL is not configured.");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL(`${serverUrl}${path}`);
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "shuncode-bridge-license-client",
        ...(init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {}),
      };
      const httpConfiguration = vscode.workspace.getConfiguration("http");
      const configuredProxy = httpConfiguration.get<string>("proxy")?.trim();
      const proxySupport = httpConfiguration.get<string>("proxySupport");
      const proxyUrl = proxySupport === "off" ? undefined : resolveExtensionHostProxy(url, configuredProxy);
      const response = await fetchWithExtensionHostFallbacks(url, {
        method: init.method ?? "GET",
        headers,
        body: typeof init.body === "string" ? init.body : undefined,
        signal: controller.signal,
        proxyUrl,
        rejectUnauthorized: httpConfiguration.get<boolean>("proxyStrictSSL", true),
        useElectron: proxySupport !== "off",
        attemptTimeoutMs: 8_000,
        log: (message) => this.output.appendLine(`[bridge-license] network ${message}`),
      });
      const body = await response.json().catch(() => ({})) as { error?: string } & T;
      if (!response.ok) {
        throw new LicenseHttpError(body.error || `License server returned HTTP ${response.status}.`, response.status);
      }
      return body;
    } catch (error) {
      if (error instanceof LicenseHttpError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new Error("License server request timed out.");
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private validateCheckoutUrl(value: string): void {
    const checkoutUrl = new URL(value);
    const serverUrl = new URL(this.configuration.serverUrl);
    const isDevelopmentLocalhost = this.context.extensionMode === vscode.ExtensionMode.Development
      && checkoutUrl.protocol === "http:"
      && ["127.0.0.1", "localhost", "::1"].includes(checkoutUrl.hostname);
    if ((checkoutUrl.protocol !== "https:" && !isDevelopmentLocalhost) || checkoutUrl.origin !== serverUrl.origin) {
      throw new Error("Payment server returned an untrusted checkout URL.");
    }
  }

  private toPaymentOrder(response: PaymentOrderResponse): BridgePaymentOrderSnapshot {
    return {
      id: response.order.id,
      status: response.order.status,
      checkoutUrl: response.checkoutUrl ?? "",
      planId: response.order.planId,
      planName: response.order.planName,
      amount: response.order.amount,
      paymentType: response.order.paymentType,
      createdAt: response.order.createdAt,
      expiresAt: response.order.expiresAt,
      paidAt: response.order.paidAt ?? "",
      entitlementExpiresAt: response.order.entitlementExpiresAt ?? "",
      error: "",
    };
  }

  private emptyPaymentOrder(error: string, id = ""): BridgePaymentOrderSnapshot {
    return {
      id,
      status: "",
      checkoutUrl: "",
      planId: "",
      planName: "",
      amount: "",
      paymentType: "",
      createdAt: "",
      expiresAt: "",
      paidAt: "",
      entitlementExpiresAt: "",
      error,
    };
  }

  private decodeBase64Url(value: string): string {
    return Buffer.from(value, "base64url").toString("utf8");
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async describeError(error: unknown): Promise<string> {
    const message = this.messageOf(error);
    if (error instanceof LicenseHttpError && error.status === 401 && /GitHub authentication failed/i.test(message)) {
      return `${message}. The GitHub token was rejected or GitHub is unreachable. Sign in with GitHub again, or paste a fresh GitHub personal access token.`;
    }
    if (error instanceof LicenseHttpError && error.status === 403 && /installation limit reached/i.test(message)) {
      const installationId = await this.getInstallationId();
      return `${message}. This ShunCode installation ID is ${installationId}. In the license admin, unbind one active device, then restore this installation or click Refresh license here.`;
    }
    if (error instanceof LicenseHttpError && error.status === 403 && /installation has been revoked/i.test(message)) {
      const installationId = await this.getInstallationId();
      return `${message}. This ShunCode installation ID is ${installationId}. Restore it in the license admin, then click Refresh license.`;
    }
    return message;
  }

  private isNoEntitlementError(error: unknown): boolean {
    return error instanceof LicenseHttpError
      && error.status === 403
      && /(no active .*entitlement|entitlement has expired)/i.test(error.message);
  }

  dispose(): void {
    this.stopPaymentMonitor();
  }
}
