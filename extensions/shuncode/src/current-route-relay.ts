export interface CurrentRouteRelayTransportRequest {
  readonly url: string;
  readonly method: "GET" | "PUT";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
}

export interface CurrentRouteRelayTransportResponse {
  readonly status: number;
  readonly body: string;
}

export type CurrentRouteRelayTransport = (
  request: CurrentRouteRelayTransportRequest,
) => Promise<CurrentRouteRelayTransportResponse>;

export interface CurrentRouteRelaySyncInput {
  readonly targetUrl: string;
  readonly bindingToken?: string;
  readonly bridgeRevision?: number;
  readonly reason?: string;
}

export interface CurrentRouteRelaySyncResult {
  readonly changed: boolean;
  readonly relayUrl: string;
  readonly stableMcpUrl: string;
  readonly targetUrl: string;
  readonly generation?: number;
}

interface RelayRouteRecord {
  readonly targetUrl?: unknown;
  readonly generation?: unknown;
}

function normalizeHttpsUrl(value: string, label: string): URL {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`${label} must be a valid HTTPS URL.`);
  }
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS.`);
  if (url.username || url.password) throw new Error(`${label} must not contain embedded credentials.`);
  if (url.hash) throw new Error(`${label} must not contain a fragment.`);
  return url;
}

export function normalizeCurrentRouteRelayUrl(value: string): string {
  const url = normalizeHttpsUrl(value, "Current Route relay URL");
  url.search = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function normalizeCurrentRouteTargetUrl(value: string): string {
  const url = normalizeHttpsUrl(value, "Current Route target URL");
  if (url.search) throw new Error("Current Route target URL must not contain a query string.");
  return url.toString();
}

/** Constructs a transport address only; the Bridge still admits the current binding. */
export function currentMissionRelayTargetUrl(bridgePublicUrl: string, missionId: string): string {
  if (!missionId || missionId !== missionId.trim() || missionId.includes("/") || missionId.length > 512) {
    throw new Error("Current Route relay requires one exact Mission id path segment.");
  }
  const base = normalizeCurrentRouteTargetUrl(bridgePublicUrl).replace(/\/+$/, "");
  return `${base}/mission-current/${encodeURIComponent(missionId)}`;
}

/** Shared by both user setup and the trusted preparation seam; no assignment/grant. */
export async function publishPreparedMissionRelayRoute(
  binding: { readonly missionId: string; readonly token: string },
  dependencies: {
    selectBinding(binding: { readonly missionId: string; readonly token: string }): Promise<void>;
    prepareUrls(): Promise<{ localUrl?: string; publicUrl?: string }>;
    syncRelay(): Promise<CurrentRouteRelaySyncResult | undefined>;
  },
): Promise<{ localUrl?: string; publicUrl?: string; currentRouteRelay?: CurrentRouteRelaySyncResult }> {
  await dependencies.selectBinding(binding);
  const urls = await dependencies.prepareUrls();
  const relay = await dependencies.syncRelay();
  if (relay && relay.targetUrl !== urls.publicUrl) {
    throw new Error("Current Route relay publication does not match the prepared Mission route.");
  }
  return { localUrl: urls.localUrl, publicUrl: relay?.stableMcpUrl ?? urls.publicUrl, currentRouteRelay: relay };
}

function relayEndpoint(baseUrl: string, suffix: string): string {
  const base = new URL(baseUrl);
  const prefix = base.pathname.replace(/\/+$/, "");
  base.pathname = `${prefix}/${suffix.replace(/^\/+/, "")}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

function parseRelayRecord(body: string, label: string): { targetUrl: string; generation?: number } {
  let value: RelayRouteRecord;
  try {
    value = JSON.parse(body) as RelayRouteRecord;
  } catch {
    throw new Error(`${label} returned invalid JSON.`);
  }
  if (typeof value.targetUrl !== "string") throw new Error(`${label} did not return targetUrl.`);
  const targetUrl = normalizeCurrentRouteTargetUrl(value.targetUrl);
  const generation = typeof value.generation === "number" && Number.isInteger(value.generation) && value.generation >= 0
    ? value.generation
    : undefined;
  return { targetUrl, generation };
}

/**
 * Publishes the current exact Mission-native MCP endpoint behind one stable
 * public URL. The relay is transport-only: it never owns Project, Mission,
 * capability, approval, execution-ledger or WorkerSession truth.
 */
export class CurrentRouteRelayClient {
  private readonly relayUrl: string;
  private readonly stableMcpUrl: string;
  private lastVerifiedTargetUrl: string | undefined;

  constructor(
    relayUrl: string,
    private readonly secret: string,
    private readonly transport: CurrentRouteRelayTransport,
  ) {
    this.relayUrl = normalizeCurrentRouteRelayUrl(relayUrl);
    if (!secret.trim()) throw new Error("Current Route relay update secret is required.");
    this.stableMcpUrl = relayEndpoint(this.relayUrl, "mcp");
  }

  getStableMcpUrl(): string {
    return this.stableMcpUrl;
  }

  async sync(input: CurrentRouteRelaySyncInput): Promise<CurrentRouteRelaySyncResult> {
    const targetUrl = normalizeCurrentRouteTargetUrl(input.targetUrl);
    if (targetUrl === this.lastVerifiedTargetUrl) {
      return {
        changed: false,
        relayUrl: this.relayUrl,
        stableMcpUrl: this.stableMcpUrl,
        targetUrl,
      };
    }

    const adminUrl = relayEndpoint(this.relayUrl, "admin/route");
    const authorization = `Bearer ${this.secret}`;
    const update = await this.transport({
      url: adminUrl,
      method: "PUT",
      headers: {
        authorization,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        targetUrl,
        bindingToken: input.bindingToken,
        bridgeRevision: input.bridgeRevision,
        reason: input.reason,
      }),
    });
    if (update.status < 200 || update.status >= 300) {
      throw new Error(`Current Route relay update failed with HTTP ${update.status}: ${update.body.slice(0, 500)}`);
    }
    const accepted = parseRelayRecord(update.body, "Current Route relay update");
    if (accepted.targetUrl !== targetUrl) {
      throw new Error("Current Route relay acknowledged a different target URL.");
    }

    // Read-after-write is intentional. The supplied relay implementation uses
    // one Durable Object, so this verifies the exact strongly-consistent route
    // state that subsequent /mcp requests will observe.
    const verify = await this.transport({
      url: adminUrl,
      method: "GET",
      headers: { authorization, accept: "application/json" },
    });
    if (verify.status < 200 || verify.status >= 300) {
      throw new Error(`Current Route relay verification failed with HTTP ${verify.status}: ${verify.body.slice(0, 500)}`);
    }
    const verified = parseRelayRecord(verify.body, "Current Route relay verification");
    if (verified.targetUrl !== targetUrl) {
      throw new Error("Current Route relay verification returned a stale or different target URL.");
    }

    this.lastVerifiedTargetUrl = targetUrl;
    return {
      changed: true,
      relayUrl: this.relayUrl,
      stableMcpUrl: this.stableMcpUrl,
      targetUrl,
      generation: verified.generation ?? accepted.generation,
    };
  }
}
