import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";

/**
 * Codex (ChatGPT subscription) sign-in for ShunCode.
 *
 * Mirrors the OAuth 2.0 Authorization Code + PKCE flow of the official Codex CLI
 * (openai/codex · codex-rs/login/src/server.rs):
 *  - authorize: GET https://auth.openai.com/oauth/authorize with response_type=code,
 *    client_id, redirect_uri=http://localhost:1455/auth/callback, scope, code_challenge
 *    (S256), state, originator=codex_cli_rs and the codex streamlined-login flags.
 *  - exchange:  POST https://auth.openai.com/oauth/token (application/x-www-form-urlencoded,
 *    grant_type=authorization_code + code_verifier).
 *  - refresh:   POST https://auth.openai.com/oauth/token (application/json,
 *    grant_type=refresh_token + client_id), refreshed automatically before expiry
 *    (5-minute lead time, matching the CLI) and on 401.
 *  - revoke:    POST https://auth.openai.com/oauth/revoke (best effort on sign-out).
 *
 * Credentials are persisted in the shared ~/.codex/auth.json (CODEX_HOME override) so the
 * official Codex CLI and ShunCode share one login. The file format matches the CLI:
 * { auth_mode: "chatgpt", tokens: { id_token (parsed claims), access_token, refresh_token,
 * account_id, plan_type }, last_refresh }.
 */

export const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const CODEX_ISSUER = "https://auth.openai.com";
export const CODEX_AUTHORIZE_URL = `${CODEX_ISSUER}/oauth/authorize`;
export const CODEX_TOKEN_URL = `${CODEX_ISSUER}/oauth/token`;
export const CODEX_REVOKE_URL = `${CODEX_ISSUER}/oauth/revoke`;
export const CODEX_API_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const CODEX_REDIRECT_PORT = 1455;
export const CODEX_REDIRECT_URI = `http://localhost:${CODEX_REDIRECT_PORT}/auth/callback`;
export const CODEX_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
export const CODEX_ORIGINATOR = "codex_cli_rs";
// The ChatGPT Codex model catalog requires a client_version query parameter and
// filters models using each entry's minimal_client_version. Keep this compatibility
// version aligned with a currently supported Codex protocol generation.
export const CODEX_CLIENT_VERSION = "0.145.0";
export const CODEX_USER_AGENT = `codex_cli_rs/${CODEX_CLIENT_VERSION}`;
export const CODEX_BETA_HEADER = "responses=experimental";

const CODEX_AUTH_TIMEOUT_MS = 300_000;
const REFRESH_LEAD_TIME_MS = 5 * 60_000;

export interface CodexAccount {
  accountId: string;
  email?: string;
  planType?: string;
}

export interface CodexRequestContext {
  accessToken: string;
  accountId: string;
}

export interface CodexAuthStatus {
  signedIn: boolean;
  account?: CodexAccount;
  /** Access-token expiry as seconds since the epoch (JWT exp claim). */
  expiresAt?: number;
}

interface StoredTokens {
  access_token?: string;
  refresh_token?: string;
  id_token?: string | Record<string, unknown>;
  account_id?: string;
  plan_type?: string;
}

interface CodexAuthFile {
  auth_mode?: string;
  openai_api_key?: string;
  tokens?: StoredTokens;
  last_refresh?: string;
  access_token?: string;
  refresh_token?: string;
  id_token?: string | Record<string, unknown>;
  account_id?: string;
  plan_type?: string;
}

const authChangeEmitter = new vscode.EventEmitter<void>();
const loginStateChangeEmitter = new vscode.EventEmitter<void>();

/** Fires whenever the persisted Codex credentials change (sign-in, refresh, sign-out). */
export const onCodexAuthChange = authChangeEmitter.event;

/**
 * Fires only when the Codex login state itself changes (sign-in or sign-out),
 * never for silent token refreshes. Model re-discovery must react to login-state
 * changes only; reacting to token refreshes would make the model list depend on
 * refresh timing and transient network conditions.
 */
export const onCodexLoginStateChange = loginStateChangeEmitter.event;

function codexHomeDir(): string {
  const home = process.env.CODEX_HOME?.trim();
  return home ? path.resolve(home) : path.join(os.homedir(), ".codex");
}

function authFilePath(): string {
  return path.join(codexHomeDir(), "auth.json");
}

function readAuthFile(): CodexAuthFile | undefined {
  try {
    const file = authFilePath();
    if (!fs.existsSync(file)) return undefined;
    return JSON.parse(fs.readFileSync(file, "utf8")) as CodexAuthFile;
  } catch {
    return undefined;
  }
}

function writeAuthFile(auth: CodexAuthFile): void {
  const file = authFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(auth, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function storedTokens(auth: CodexAuthFile | undefined): StoredTokens {
  const tokens = auth?.tokens ?? {};
  return {
    access_token: tokens.access_token ?? auth?.access_token,
    refresh_token: tokens.refresh_token ?? auth?.refresh_token,
    id_token: tokens.id_token ?? auth?.id_token,
    account_id: tokens.account_id ?? auth?.account_id,
    plan_type: tokens.plan_type ?? auth?.plan_type,
  };
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    const segment = token.split(".")[1];
    if (!segment) return undefined;
    const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function tokenExpirySeconds(accessToken: string): number | undefined {
  const claims = decodeJwtPayload(accessToken);
  return typeof claims?.exp === "number" && Number.isFinite(claims.exp) ? claims.exp : undefined;
}

function authClaim(claims: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const value = claims?.["https://api.openai.com/auth"];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function accountFromAuth(auth: CodexAuthFile | undefined): CodexAccount | undefined {
  if (!auth) return undefined;
  const tokens = storedTokens(auth);
  if (!tokens.access_token) return undefined;
  const claims = typeof tokens.id_token === "string" ? decodeJwtPayload(tokens.id_token) : undefined;
  const authInfo = authClaim(claims);
  const accountId = tokens.account_id
    ?? (typeof authInfo?.chatgpt_account_id === "string" ? authInfo.chatgpt_account_id : undefined)
    ?? (typeof authInfo?.account_id === "string" ? authInfo.account_id : undefined);
  if (!accountId) return undefined;
  return {
    accountId,
    email: typeof authInfo?.email === "string" ? authInfo.email : typeof claims?.email === "string" ? claims.email : undefined,
    planType: tokens.plan_type ?? (typeof authInfo?.chatgpt_plan_type === "string" ? authInfo.chatgpt_plan_type : undefined),
  };
}

async function postTokenEndpoint(body: string, contentType: string, label: string): Promise<any> {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
  const raw = await response.text();
  let payload: any = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    // Keep the empty payload so the status-based error below reports the HTTP status.
  }
  if (!response.ok) {
    const detail = typeof payload?.error_description === "string" ? payload.error_description
      : typeof payload?.error === "string" ? payload.error
        : typeof payload?.detail === "string" ? payload.detail
          : raw.slice(0, 300);
    throw new Error(`${label}: ${detail || `HTTP ${response.status}`}`);
  }
  if (typeof payload?.access_token !== "string") throw new Error(`${label}: the token endpoint returned no access token.`);
  return payload;
}

async function exchangeCode(code: string, codeVerifier: string): Promise<{ access_token: string; refresh_token?: string; id_token?: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: CODEX_REDIRECT_URI,
    client_id: CODEX_CLIENT_ID,
    code_verifier: codeVerifier,
  }).toString();
  const payload = await postTokenEndpoint(body, "application/x-www-form-urlencoded", "Codex sign-in failed");
  return {
    access_token: payload.access_token,
    refresh_token: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
    id_token: typeof payload.id_token === "string" ? payload.id_token : undefined,
  };
}

async function refreshTokens(tokens: StoredTokens, auth: CodexAuthFile | undefined): Promise<CodexRequestContext> {
  if (!tokens.refresh_token) {
    throw new Error("Codex session has no refresh token. Sign in again with 'ShunCode: Sign in with Codex'.");
  }
  const body = JSON.stringify({ client_id: CODEX_CLIENT_ID, grant_type: "refresh_token", refresh_token: tokens.refresh_token });
  const refreshed = await postTokenEndpoint(body, "application/json", "Codex session refresh failed");
  const nextIdToken = typeof refreshed.id_token === "string" ? refreshed.id_token : tokens.id_token;
  const claims = typeof nextIdToken === "string" ? decodeJwtPayload(nextIdToken) : undefined;
  const authInfo = authClaim(claims);
  const accountId = tokens.account_id
    ?? (typeof authInfo?.chatgpt_account_id === "string" ? authInfo.chatgpt_account_id : undefined);
  if (!accountId) {
    throw new Error("Codex session refresh succeeded but the account ID could not be determined. Sign in again.");
  }
  writeAuthFile({
    ...(auth ?? {}),
    auth_mode: auth?.auth_mode ?? "chatgpt",
    tokens: {
      access_token: refreshed.access_token,
      refresh_token: typeof refreshed.refresh_token === "string" ? refreshed.refresh_token : tokens.refresh_token,
      id_token: claims ?? nextIdToken,
      account_id: accountId,
      plan_type: tokens.plan_type ?? (typeof authInfo?.chatgpt_plan_type === "string" ? authInfo.chatgpt_plan_type : undefined),
    },
    last_refresh: new Date().toISOString(),
  });
  authChangeEmitter.fire();
  return { accessToken: refreshed.access_token, accountId };
}

let refreshInFlight: Promise<CodexRequestContext> | undefined;

async function getRequestContext(forceRefresh = false): Promise<CodexRequestContext> {
  if (forceRefresh && refreshInFlight) return refreshInFlight;
  const auth = readAuthFile();
  const tokens = storedTokens(auth);
  if (!tokens.access_token) {
    throw new Error("Not signed in to Codex. Run 'ShunCode: Sign in with Codex' first.");
  }
  const account = accountFromAuth(auth);
  if (!account) {
    throw new Error("Codex credentials are missing the account ID. Sign in again with 'ShunCode: Sign in with Codex'.");
  }
  const expiresAt = tokenExpirySeconds(tokens.access_token);
  const needsRefresh = forceRefresh || expiresAt === undefined || expiresAt * 1000 < Date.now() + REFRESH_LEAD_TIME_MS;
  if (!needsRefresh) return { accessToken: tokens.access_token, accountId: account.accountId };
  if (!refreshInFlight) {
    refreshInFlight = refreshTokens(tokens, auth).finally(() => { refreshInFlight = undefined; });
  }
  return refreshInFlight;
}

async function getStatus(): Promise<CodexAuthStatus> {
  const auth = readAuthFile();
  const account = accountFromAuth(auth);
  if (!account) return { signedIn: false };
  const tokens = storedTokens(auth);
  return { signedIn: true, account, expiresAt: tokenExpirySeconds(tokens.access_token ?? "") };
}

async function revokeTokensBestEffort(tokens: StoredTokens): Promise<void> {
  const token = tokens.refresh_token ?? tokens.access_token;
  if (!token) return;
  try {
    await fetch(CODEX_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CODEX_CLIENT_ID, token }).toString(),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // Best effort: the local session is removed regardless of revoke success.
  }
}

async function signOut(): Promise<void> {
  const auth = readAuthFile();
  const tokens = storedTokens(auth);
  if (auth?.openai_api_key && !tokens.access_token) {
    throw new Error("~/.codex/auth.json contains an API-key login. ShunCode only manages ChatGPT sign-in; sign out with the Codex CLI instead.");
  }
  await revokeTokensBestEffort(tokens);
  const file = authFilePath();
  if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  authChangeEmitter.fire();
  loginStateChangeEmitter.fire();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}

async function startLogin(cancellationToken?: vscode.CancellationToken): Promise<CodexAccount> {
  const existing = await getStatus();
  if (existing.signedIn) {
    throw new Error(`Already signed in to Codex as ${existing.account?.email ?? existing.account?.accountId}. Sign out first to switch accounts.`);
  }

  const codeVerifier = randomBytes(48).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(16).toString("hex");
  const authorizeParams = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_REDIRECT_URI,
    scope: CODEX_SCOPE,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: CODEX_ORIGINATOR,
  });
  const authorizeUrl = `${CODEX_AUTHORIZE_URL}?${authorizeParams.toString()}`;

  let server: http.Server | undefined;
  let settled = false;
  let resolveCode: ((code: string) => void) | undefined;
  let rejectLogin: ((error: Error) => void) | undefined;

  const settle = (result: string | Error): void => {
    if (settled) return;
    settled = true;
    if (server) {
      try { server.close(); } catch { /* already closed */ }
      server = undefined;
    }
    if (typeof result === "string") resolveCode?.(result);
    else rejectLogin?.(result);
  };

  server = http.createServer((request, response) => {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", CODEX_REDIRECT_URI);
    } catch {
      response.writeHead(400);
      response.end("Bad request");
      return;
    }
    if (url.pathname !== "/auth/callback") {
      response.writeHead(404);
      response.end("Not found");
      return;
    }
    const errorCode = url.searchParams.get("error");
    if (errorCode) {
      const description = url.searchParams.get("error_description") ?? "The authorization request was denied.";
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><meta charset="utf-8"><h3>Codex sign-in failed</h3><p>${escapeHtml(description)}</p><p>You can close this window and try again.</p>`);
      settle(new Error(`Codex sign-in was not completed: ${description}`));
      return;
    }
    const returnedState = url.searchParams.get("state");
    if (returnedState !== state) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end('<!doctype html><meta charset="utf-8"><h3>Codex sign-in failed</h3><p>The callback state did not match. You can close this window and try again.</p>');
      settle(new Error("Codex sign-in callback state mismatch."));
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" });
      response.end('<!doctype html><meta charset="utf-8"><h3>Codex sign-in failed</h3><p>Missing authorization code. You can close this window and try again.</p>');
      settle(new Error("Codex sign-in callback was missing the authorization code."));
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end('<!doctype html><meta charset="utf-8"><h3>Signed in to Codex</h3><p>You can close this window and return to ShunCode.</p>');
    settle(code);
  });

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectLogin = reject;
  });
  const timeout = setTimeout(() => settle(new Error(`Codex sign-in timed out after ${CODEX_AUTH_TIMEOUT_MS / 1000} seconds.`)), CODEX_AUTH_TIMEOUT_MS);
  const cancellation = cancellationToken?.onCancellationRequested(() => settle(new vscode.CancellationError()));
  const cleanup = (): void => {
    clearTimeout(timeout);
    cancellation?.dispose();
  };

  try {
    await new Promise<void>((resolveListen, rejectListen) => {
      server?.once("error", (error) => {
        if ((error as { code?: string }).code === "EADDRINUSE") {
          rejectListen(new Error(`Port ${CODEX_REDIRECT_PORT} is already in use. Free it (it is the Codex OAuth callback port) and try again.`));
        } else {
          rejectListen(error);
        }
      });
      // The registered redirect URI uses `localhost`. Bind using the same host name
      // rather than forcing IPv4 so systems that resolve localhost to ::1 do not send
      // the browser callback to an address where this server is not listening.
      server?.listen(CODEX_REDIRECT_PORT, "localhost", resolveListen);
    });
  } catch (error) {
    cleanup();
    try { server?.close(); } catch { /* not listening */ }
    throw error;
  }

  const opened = await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl));
  if (!opened) {
    cleanup();
    throw new Error("Could not open the browser for Codex sign-in. Run 'ShunCode: Show Codex Account Status' for help.");
  }

  let code: string;
  try {
    code = await codePromise;
  } finally {
    cleanup();
  }

  const tokens = await exchangeCode(code, codeVerifier);
  const claims = typeof tokens.id_token === "string" ? decodeJwtPayload(tokens.id_token) : undefined;
  const authInfo = authClaim(claims);
  const accountId = typeof authInfo?.chatgpt_account_id === "string" ? authInfo.chatgpt_account_id : "";
  if (!accountId) {
    throw new Error("Codex sign-in succeeded but the account ID could not be read from the token. Try signing in again.");
  }
  const account: CodexAccount = {
    accountId,
    email: typeof authInfo?.email === "string" ? authInfo.email : typeof claims?.email === "string" ? claims.email : undefined,
    planType: typeof authInfo?.chatgpt_plan_type === "string" ? authInfo.chatgpt_plan_type : undefined,
  };
  writeAuthFile({
    auth_mode: "chatgpt",
    tokens: {
      id_token: claims ?? tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      account_id: accountId,
      plan_type: account.planType,
    },
    last_refresh: new Date().toISOString(),
  });
  authChangeEmitter.fire();
  loginStateChangeEmitter.fire();
  return account;
}

export const codexAuthManager = {
  getStatus,
  getRequestContext,
  forceRefresh: (): Promise<CodexRequestContext> => getRequestContext(true),
  startLogin,
  signOut,
};
