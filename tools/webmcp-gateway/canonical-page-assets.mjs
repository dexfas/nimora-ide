import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** One canonical source tree, or its explicitly staged byte-identical assets.
 * Never silently select the historical generic chat agent in production. */
export function canonicalPageAssets(env = process.env, directory = path.dirname(fileURLToPath(import.meta.url))) {
  const packaged = path.join(directory, 'page-runtime');
  const source = path.resolve(directory, '../../extensions/shuncode-webmcp');
  const root = existsSync(path.join(packaged, 'webmcp-page-core.js')) ? packaged : source;
  const result = {
    sharedPageCorePath: env.SHUNCODE_WEBMCP_PAGE_CORE_PATH || path.join(root, 'webmcp-page-core.js'),
    sharedSiteAdaptersPath: env.SHUNCODE_WEBMCP_SITE_ADAPTERS_PATH || path.join(root, 'webmcp-site-adapters.js'),
    sharedPageAgentPath: env.SHUNCODE_WEBMCP_PAGE_AGENT_PATH || path.join(root, 'arena-agent-bridge.js'),
  };
  if (Object.values(result).some(file => !existsSync(file))) throw new Error('Canonical WebMCP assets are missing; stage the gateway before launch. Legacy fallback is disabled.');
  return result;
}
