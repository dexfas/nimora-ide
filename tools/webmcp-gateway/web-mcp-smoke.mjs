import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = process.env.TEST_MCP_URL || 'http://127.0.0.1:48321/mcp';
const client = new Client({ name: 'web-mcp-smoke', version: '0.1.0' }, { capabilities: {} });

await client.connect(new StreamableHTTPClientTransport(new URL(url)));
try {
  await client.callTool({
    name: 'browser_evaluate',
    arguments: {
      page_id: 0,
      expression: `(() => {
        const node = document.createElement('div');
        node.className = 'assistant-message';
        node.textContent = '[SHUNCODE_TOOL]\\n{"id":"smoke-list-directory","name":"list_directory","arguments":{"path":".","depth":1,"max_entries":3}}\\n[/SHUNCODE_TOOL]';
        document.getElementById('messages').appendChild(node);
        return true;
      })()`,
    },
  });

  await new Promise(resolve => setTimeout(resolve, 3500));
  const result = await client.callTool({
    name: 'browser_get_text',
    arguments: { page_id: 0, selector: '#messages', max_chars: 20000 },
  });
  const text = (result.content || []).map(part => part.text || '').join('\n');
  const ok = text.includes('[SHUNCODE_TOOL_RESULT]')
    && text.includes('smoke-list-directory')
    && text.includes('"ok": true');
  console.log(ok ? 'WEB_MCP_ROUNDTRIP_OK' : 'WEB_MCP_ROUNDTRIP_FAILED');
  if (!ok) console.log(text.slice(-12000));
  process.exitCode = ok ? 0 : 1;
} finally {
  await client.close();
}
