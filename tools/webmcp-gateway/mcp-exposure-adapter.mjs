import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

export function createGatewayMcpExposureAdapter({
  listTools,
  callTool,
  serverName = 'shuncode-browser-gateway',
  serverVersion = '0.1.0',
  instructions = 'ShunCode tools plus persistent browser DOM/click/fill automation.',
  newSessionId = randomUUID,
} = {}) {
  if (typeof listTools !== 'function') throw new Error('Gateway MCP exposure requires listTools().');
  if (typeof callTool !== 'function') throw new Error('Gateway MCP exposure requires callTool().');

  const sessions = new Map();

  function createProtocolServer() {
    const server = new Server(
      { name: serverName, version: serverVersion },
      { capabilities: { tools: {}, logging: {} }, instructions },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await listTools() }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
      const { name, arguments: args = {} } = request.params;
      return await callTool(name, args);
    });
    return server;
  }

  async function handlePost(request, response, body = request.body) {
    const sid = request.headers['mcp-session-id'];
    let transport = typeof sid === 'string' ? sessions.get(sid) : undefined;
    if (!transport && !sid && isInitializeRequest(body)) {
      const server = createProtocolServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => newSessionId(),
        onsessioninitialized: id => sessions.set(id, transport),
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
    } else if (!transport) {
      response.status(400).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Invalid or missing MCP session ID' }, id: null });
      return;
    }
    await transport.handleRequest(request, response, body);
  }

  async function handleSessionRequest(request, response) {
    const sid = request.headers['mcp-session-id'];
    const transport = typeof sid === 'string' ? sessions.get(sid) : undefined;
    if (!transport) {
      response.status(400).send('Invalid or missing MCP session ID');
      return;
    }
    await transport.handleRequest(request, response);
  }

  return {
    handlePost,
    handleSessionRequest,
    sessionCount: () => sessions.size,
  };
}
