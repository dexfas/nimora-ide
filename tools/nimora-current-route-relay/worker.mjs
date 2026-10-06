const ROUTE_STORAGE_KEY = "current-route-v1";

function jsonResponse(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function normalizedTargetUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("targetUrl is required.");
  const url = new URL(value.trim());
  if (url.protocol !== "https:") throw new Error("targetUrl must use HTTPS.");
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("targetUrl must not contain credentials, query parameters, or fragments.");
  }
  return url.toString();
}

function authorized(request, env) {
  const secret = typeof env.ROUTE_UPDATE_SECRET === "string" ? env.ROUTE_UPDATE_SECRET : "";
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

function routePrefix(env) {
  const token = typeof env.ROUTE_PATH_TOKEN === "string" ? env.ROUTE_PATH_TOKEN.trim() : "";
  if (!token) return undefined;
  return `/r/${encodeURIComponent(token)}`;
}

async function forwardedRequest(request, targetUrl) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("content-length");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ray");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-proto");
  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : await request.arrayBuffer();
  return new Request(targetUrl, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });
}

export class NimoraCurrentRouteRelay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async routeRecord() {
    return await this.state.storage.get(ROUTE_STORAGE_KEY);
  }

  async handleAdmin(request) {
    if (!authorized(request, this.env)) return jsonResponse({ error: "unauthorized" }, { status: 401 });
    if (request.method === "GET") {
      const record = await this.routeRecord();
      return record
        ? jsonResponse(record)
        : jsonResponse({ error: "route-not-configured" }, { status: 404 });
    }
    if (request.method !== "PUT") return jsonResponse({ error: "method-not-allowed" }, { status: 405 });

    let input;
    try {
      input = await request.json();
    } catch {
      return jsonResponse({ error: "invalid-json" }, { status: 400 });
    }
    let targetUrl;
    try {
      targetUrl = normalizedTargetUrl(input?.targetUrl);
    } catch (error) {
      return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
    const previous = await this.routeRecord();
    const generation = (Number.isInteger(previous?.generation) ? previous.generation : 0) + 1;
    const record = {
      targetUrl,
      generation,
      updatedAt: new Date().toISOString(),
      bindingToken: typeof input?.bindingToken === "string" ? input.bindingToken : undefined,
      bridgeRevision: Number.isInteger(input?.bridgeRevision) ? input.bridgeRevision : undefined,
      reason: typeof input?.reason === "string" ? input.reason.slice(0, 200) : undefined,
    };
    await this.state.storage.put(ROUTE_STORAGE_KEY, record);
    return jsonResponse(record);
  }

  async handleMcp(request) {
    const record = await this.routeRecord();
    if (!record?.targetUrl) return jsonResponse({ error: "route-not-configured" }, { status: 503 });
    let response;
    try {
      response = await fetch(await forwardedRequest(request, record.targetUrl));
    } catch (error) {
      return jsonResponse({
        error: "upstream-unavailable",
        detail: error instanceof Error ? error.message : String(error),
      }, { status: 502 });
    }
    const headers = new Headers(response.headers);
    headers.set("cache-control", "no-store");
    headers.set("x-nimora-route-generation", String(record.generation ?? 0));
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const bodyless = request.method === "HEAD" || response.status === 204 || response.status === 205 || response.status === 304;
    const body = bodyless
      ? null
      : contentType.includes("application/json")
        ? await response.arrayBuffer()
        : response.body;
    if (contentType.includes("application/json")) headers.delete("content-length");
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const prefix = routePrefix(this.env);
    if (!prefix) return jsonResponse({ error: "relay-path-token-not-configured" }, { status: 503 });
    if (url.pathname === `${prefix}/healthz`) {
      const record = await this.routeRecord();
      return jsonResponse({ ok: true, configured: Boolean(record?.targetUrl), generation: record?.generation ?? 0 });
    }
    if (url.pathname === `${prefix}/admin/route`) return await this.handleAdmin(request);
    if (url.pathname === `${prefix}/mcp`) return await this.handleMcp(request);
    return jsonResponse({ error: "not-found" }, { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const id = env.ROUTE_RELAY.idFromName("nimora-current-route");
    return await env.ROUTE_RELAY.get(id).fetch(request);
  },
};
