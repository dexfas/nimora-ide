import { defineGatewayProvider } from './provider-registry.mjs';

export function createIntegratedBrowserProvider({
  bridgeUrl,
  fetchImpl = fetch,
  now = Date.now,
  cacheTtlMs = 2000,
} = {}) {
  if (typeof bridgeUrl !== 'string' || !bridgeUrl.trim()) {
    throw new Error('Integrated Browser provider requires bridgeUrl.');
  }

  const baseUrl = bridgeUrl.replace(/\/$/, '');
  let toolsCache = [];
  let toolsCacheAt = 0;

  async function loadTools(force = false) {
    if (!force && now() - toolsCacheAt < cacheTtlMs) return toolsCache;
    try {
      const response = await fetchImpl(`${baseUrl}/tools`, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      toolsCache = Array.isArray(body.tools) ? body.tools : [];
      toolsCacheAt = now();
    } catch {
      toolsCache = [];
      toolsCacheAt = now();
    }
    return toolsCache;
  }

  async function callTool(name, args = {}) {
    const response = await fetchImpl(`${baseUrl}/invoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, input: args }),
      signal: AbortSignal.timeout(120000),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) throw new Error(body.error || `Integrated Browser Bridge HTTP ${response.status}`);
    const content = Array.isArray(body.result?.content) ? body.result.content : [];
    const mcpContent = content.flatMap(part => {
      if (part?.type === 'text') return [{ type: 'text', text: String(part.text ?? '') }];
      if (part?.type === 'data' && part.base64) return [{ type: 'text', text: `[binary browser result omitted: ${String(part.base64).length} base64 chars]` }];
      return [{ type: 'text', text: JSON.stringify(part) }];
    });
    return { content: mcpContent.length ? mcpContent : [{ type: 'text', text: 'Browser tool completed.' }] };
  }

  return defineGatewayProvider({
    id: 'integrated-browser',
    listTools: () => loadTools(false),
    refreshTools: () => loadTools(true),
    owns: async name => (await loadTools(false)).some(tool => tool.name === name),
    callTool,
  });
}
