import { execFileSync } from "node:child_process";
import http, { type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { HttpsProxyAgent } from "https-proxy-agent";

const WINDOWS_INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const SYSTEM_PROXY_CACHE_MS = 5_000;

export interface ExtensionHostFetchOptions {
  method?: string;
  headers?: HeadersInit;
  body?: string;
  signal?: AbortSignal;
  proxyUrl?: string;
  rejectUnauthorized?: boolean;
  useElectron?: boolean;
  attemptTimeoutMs?: number;
  log?: (message: string) => void;
}

let cachedWindowsProxy: { expiresAt: number; value?: string } | undefined;
let cachedElectronFetch: typeof fetch | null | undefined;

function registryValue(name: string): string | undefined {
  try {
    const output = execFileSync("reg.exe", ["query", WINDOWS_INTERNET_SETTINGS, "/v", name], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = output.match(new RegExp(`^\\s*${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, "mi"));
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function windowsSystemProxy(): string | undefined {
  if (process.platform !== "win32") return undefined;
  const now = Date.now();
  if (cachedWindowsProxy && cachedWindowsProxy.expiresAt > now) return cachedWindowsProxy.value;
  const enabled = registryValue("ProxyEnable");
  const value = enabled && Number.parseInt(enabled.replace(/^0x/i, ""), enabled.startsWith("0x") ? 16 : 10) !== 0
    ? registryValue("ProxyServer")
    : undefined;
  cachedWindowsProxy = { expiresAt: now + SYSTEM_PROXY_CACHE_MS, value };
  return value;
}

function proxyRuleValue(value: string, targetProtocol: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (!trimmed.includes("=")) return trimmed;
  const rules = new Map<string, string>();
  for (const part of trimmed.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const key = part.slice(0, separator).trim().toLowerCase();
    const endpoint = part.slice(separator + 1).trim();
    if (key && endpoint) rules.set(key, endpoint);
  }
  const scheme = targetProtocol.replace(/:$/, "").toLowerCase();
  return rules.get(scheme) ?? rules.get("http") ?? rules.get("proxy");
}

export function normalizeProxyUrl(value: string | undefined, targetProtocol: string): string | undefined {
  if (!value?.trim()) return undefined;
  const endpoint = proxyRuleValue(value, targetProtocol);
  if (!endpoint || /^socks/i.test(endpoint)) return undefined;
  const normalized = /^[a-z][a-z\d+.-]*:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`;
  try {
    const parsed = new URL(normalized);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function resolveExtensionHostProxy(target: URL, configuredProxy?: string): string | undefined {
  const candidates = [
    configuredProxy,
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy,
    windowsSystemProxy(),
  ];
  for (const candidate of candidates) {
    const normalized = normalizeProxyUrl(candidate, target.protocol);
    if (normalized) return normalized;
  }
  return undefined;
}

function electronNetFetch(): typeof fetch | undefined {
  if (cachedElectronFetch !== undefined) return cachedElectronFetch ?? undefined;
  try {
    // Keep this require dynamic so esbuild does not try to bundle the Electron
    // runtime module. VS Code's own GitHub Authentication extension uses the
    // same Electron net.fetch path because it inherits Chromium's system proxy,
    // PAC and authenticated-proxy handling.
    const electronModuleName = "electron";
    const electron = require(electronModuleName) as { net?: { fetch?: typeof fetch } };
    cachedElectronFetch = typeof electron.net?.fetch === "function"
      ? electron.net.fetch.bind(electron.net)
      : null;
  } catch {
    cachedElectronFetch = null;
  }
  return cachedElectronFetch ?? undefined;
}

function attemptSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function requestInit(init: ExtensionHostFetchOptions, signal: AbortSignal): RequestInit {
  return {
    method: init.method ?? "GET",
    headers: init.headers,
    body: init.body,
    signal,
    cache: "no-store",
  };
}

function proxyAuthorization(proxy: URL): string | undefined {
  if (!proxy.username && !proxy.password) return undefined;
  const username = decodeURIComponent(proxy.username);
  const password = decodeURIComponent(proxy.password);
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function requestHeaders(init: ExtensionHostFetchOptions, target: URL): Record<string, string> {
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  if (!headers.host) headers.host = target.host;
  if (init.body !== undefined && !headers["content-length"] && !headers["transfer-encoding"]) {
    headers["content-length"] = String(Buffer.byteLength(init.body));
  }
  return headers;
}

function responseHeaders(input: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(input)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else if (value !== undefined) {
      headers.set(key, String(value));
    }
  }
  return headers;
}

function toFetchResponse(response: IncomingMessage): Response {
  const status = response.statusCode ?? 500;
  const body = Readable.toWeb(response) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status,
    statusText: response.statusMessage ?? "",
    headers: responseHeaders(response.headers),
  });
}

function writeBody(request: http.ClientRequest, body: string | undefined): void {
  if (body !== undefined) request.write(body);
  request.end();
}

function directRequest(target: URL, init: ExtensionHostFetchOptions): Promise<Response> {
  return new Promise((resolve, reject) => {
    const client = target.protocol === "https:" ? https : http;
    const request = client.request(target, {
      method: init.method ?? "GET",
      headers: requestHeaders(init, target),
      signal: init.signal,
      ...(target.protocol === "https:" ? { rejectUnauthorized: init.rejectUnauthorized !== false } : {}),
    }, response => resolve(toFetchResponse(response)));
    request.once("error", reject);
    writeBody(request, init.body);
  });
}

function requestHttpTargetThroughProxy(target: URL, proxy: URL, init: ExtensionHostFetchOptions): Promise<Response> {
  return new Promise((resolve, reject) => {
    const client = proxy.protocol === "https:" ? https : http;
    const headers = requestHeaders(init, target);
    const authorization = proxyAuthorization(proxy);
    if (authorization) headers["proxy-authorization"] = authorization;
    const request = client.request({
      protocol: proxy.protocol,
      hostname: proxy.hostname,
      port: proxy.port || (proxy.protocol === "https:" ? 443 : 80),
      method: init.method ?? "GET",
      path: target.toString(),
      headers,
      signal: init.signal,
      ...(proxy.protocol === "https:" ? { rejectUnauthorized: init.rejectUnauthorized !== false } : {}),
    }, response => resolve(toFetchResponse(response)));
    request.once("error", reject);
    writeBody(request, init.body);
  });
}

function requestHttpsTargetThroughProxy(target: URL, proxy: URL, init: ExtensionHostFetchOptions): Promise<Response> {
  return new Promise((resolve, reject) => {
    const agent = new HttpsProxyAgent(proxy, {
      rejectUnauthorized: init.rejectUnauthorized !== false,
    });
    const request = https.request(target, {
      method: init.method ?? "GET",
      headers: requestHeaders(init, target),
      signal: init.signal,
      agent,
      rejectUnauthorized: init.rejectUnauthorized !== false,
    }, result => resolve(toFetchResponse(result)));
    request.once("error", reject);
    writeBody(request, init.body);
  });
}

export function fetchThroughExtensionHostProxy(target: URL, init: ExtensionHostFetchOptions): Promise<Response> {
  const proxyUrl = normalizeProxyUrl(init.proxyUrl, target.protocol);
  if (!proxyUrl) return directRequest(target, init);
  const proxy = new URL(proxyUrl);
  return target.protocol === "https:"
    ? requestHttpsTargetThroughProxy(target, proxy, init)
    : requestHttpTargetThroughProxy(target, proxy, init);
}

/**
 * Desktop extension-host fetch with the same primary transport strategy as
 * VS Code's GitHub Authentication extension: use Electron's network stack
 * first, then fall back to an explicitly resolved proxy and finally Node.
 *
 * Electron net.fetch is important on Windows because Chromium owns the full
 * proxy configuration (including PAC/WPAD and authenticated proxies). The
 * manual proxy path remains as a fallback for environments where Electron is
 * unavailable or its request fails before reaching the origin.
 */
export async function fetchWithExtensionHostFallbacks(target: URL, init: ExtensionHostFetchOptions): Promise<Response> {
  const timeoutMs = Math.max(1_000, Math.min(init.attemptTimeoutMs ?? 8_000, 60_000));
  const failures: string[] = [];

  const run = async (name: string, operation: (signal: AbortSignal) => Promise<Response>): Promise<Response | undefined> => {
    if (init.signal?.aborted) throw init.signal.reason;
    try {
      init.log?.(`${name} -> ${target.origin}`);
      const response = await operation(attemptSignal(init.signal, timeoutMs));
      init.log?.(`${name} <- HTTP ${response.status}`);
      return response;
    } catch (error) {
      if (init.signal?.aborted) throw init.signal.reason;
      const detail = `${name}: ${errorMessage(error)}`;
      failures.push(detail);
      init.log?.(`${detail}; trying fallback`);
      return undefined;
    }
  };

  if (init.useElectron !== false) {
    const electronFetch = electronNetFetch();
    if (electronFetch) {
      const response = await run("Electron net.fetch", signal => electronFetch(target.toString(), requestInit(init, signal)));
      if (response) return response;
    } else {
      init.log?.("Electron net.fetch unavailable; trying fallback");
    }
  }

  if (init.proxyUrl) {
    const response = await run("Explicit/system proxy", signal => fetchThroughExtensionHostProxy(target, {
      ...init,
      signal,
    }));
    if (response) return response;
  }

  const response = await run("Node fetch", signal => fetch(target, requestInit(init, signal)));
  if (response) return response;

  throw new Error(`Network request failed after all transports. ${failures.join(" | ")}`);
}
