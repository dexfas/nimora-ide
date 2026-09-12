import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.TEST_MCP_URL || 'http://127.0.0.1:48321/mcp';
const client = new Client({ name: 'gateway-smoke-test', version: '0.1.0' }, { capabilities: {} });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
const listed = await client.listTools();
console.log(`TOOLS=${listed.tools.length}`);
for (const name of ['list_directory', 'run_command', 'browser_open', 'browser_click', 'browser_fill', 'browser_dom', 'browser_screenshot']) {
  console.log(`${name}=${listed.tools.some(t => t.name === name)}`);
}
const pages = await client.callTool({ name: 'browser_pages', arguments: {} });
console.log(JSON.stringify(pages));
await client.close();
