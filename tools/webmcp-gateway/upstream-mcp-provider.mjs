import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { retryPolicyForTool } from './capability-contract.mjs';
import { defineGatewayProvider } from './provider-registry.mjs';

const legacyRetryableReadOnlyTools = new Set([
  'find_files', 'read_files', 'search_files', 'list_directory', 'get_diagnostics', 'lsp', 'get_command_output',
]);

async function defaultConnectClient(url) {
  const client = new Client({ name: 'shuncode-browser-gateway', version: '0.1.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { 'ngrok-skip-browser-warning': '1' } },
  });
  await client.connect(transport);
  return client;
}

function isTransportError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNRESET|ECONNREFUSED|EPIPE|socket|network|terminated|aborted/i.test(message);
}

export function createUpstreamMcpProvider({
  url,
  connectClient = defaultConnectClient,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now,
  logger = console,
  listRetryDelays = [0, 250, 700, 1500],
  callRetryDelay = 180,
} = {}) {
  let client;
  let connectPromise;
  let toolsCache = [];
  let toolsCacheAt = 0;

  async function getClient() {
    if (!url) {
      throw new Error('SHUNCODE_MCP_URL is not configured. Set it to the ShunCode Bridge MCP endpoint before using upstream tools.');
    }
    if (client) return client;
    if (!connectPromise) {
      connectPromise = Promise.resolve(connectClient(url))
        .then(value => {
          client = value;
          return value;
        })
        .finally(() => { connectPromise = undefined; });
    }
    return connectPromise;
  }

  async function reset() {
    const previous = client;
    client = undefined;
    connectPromise = undefined;
    try { await previous?.close?.(); } catch {}
  }

  async function listToolsStable() {
    const load = async () => {
      const response = await (await getClient()).listTools();
      const tools = Array.isArray(response?.tools) ? response.tools : [];
      if (tools.length) {
        toolsCache = tools;
        toolsCacheAt = now();
      }
      return tools;
    };

    let lastError;
    for (let attempt = 0; attempt < listRetryDelays.length; attempt += 1) {
      if (attempt > 0) {
        await reset();
        await sleep(listRetryDelays[attempt]);
      }
      try {
        return await load();
      } catch (error) {
        lastError = error;
        logger.warn?.(`[web-mcp] upstream listTools attempt ${attempt + 1}/${listRetryDelays.length} failed:`, error instanceof Error ? error.message : String(error));
      }
    }

    if (toolsCache.length) {
      logger.warn?.(`[web-mcp] using cached upstream tool list (${toolsCache.length} tools, age=${now() - toolsCacheAt}ms)`);
      return toolsCache;
    }
    throw lastError || new Error('upstream listTools failed');
  }

  async function toolDefinition(name) {
    let found = toolsCache.find(tool => tool.name === name);
    if (found) return found;
    try {
      const tools = await listToolsStable();
      found = tools.find(tool => tool.name === name);
    } catch {}
    return found;
  }

  async function callToolStable(name, args = {}) {
    const definition = await toolDefinition(name);
    try {
      return await (await getClient()).callTool({ name, arguments: args });
    } catch (error) {
      if (!isTransportError(error)) throw error;
      await reset();
      const retryPolicy = definition ? retryPolicyForTool(definition) : undefined;
      if (retryPolicy === 'automatic' || (retryPolicy === undefined && legacyRetryableReadOnlyTools.has(name))) {
        await sleep(callRetryDelay);
        return await (await getClient()).callTool({ name, arguments: args });
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Upstream MCP transport failed and was reset: ${message}. This side-effect-capable tool was NOT automatically retried; verify state before retrying to avoid duplicate effects.`);
    }
  }

  return defineGatewayProvider({
    id: 'upstream-mcp',
    fallback: true,
    listTools: listToolsStable,
    callTool: callToolStable,
    probeTools: async () => {
      const response = await (await getClient()).listTools();
      return Array.isArray(response?.tools) ? response.tools : [];
    },
    reset,
  });
}
