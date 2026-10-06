import path from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { capabilityMcpFields } from "./capability-registry.js";
import { FILE_TOOL_DEFINITIONS, invokeFileTool } from "./file-tool-registry.js";
import { modernMcpTool } from "./mcp-v2-boundary.js";

function getWorkspaceRoots(): string[] {
  const configured = process.env.MCP_WORKSPACE_ROOTS?.trim();
  if (!configured) return [process.cwd()];
  return configured
    .split(path.delimiter)
    .map((root) => root.trim())
    .filter(Boolean);
}

export interface FileToolsServerDependencies {
  getWorkspaceRoots?: () => string[];
  invokeTool?: typeof invokeFileTool;
}

export function createFileToolsServer(dependencies: FileToolsServerDependencies = {}): Server {
  const server = new Server(
    { name: "shuncode-file-tools", version: "0.6.7" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: FILE_TOOL_DEFINITIONS.map((tool) => modernMcpTool({ ...tool, ...capabilityMcpFields(tool.name) })),
  }));

  server.setRequestHandler("tools/call", async (request, extra) => {
    try {
      const result = await (dependencies.invokeTool ?? invokeFileTool)(request.params.name, request.params.arguments, {
        workspaceRoots: (dependencies.getWorkspaceRoots ?? getWorkspaceRoots)(),
        signal: extra.mcpReq.signal,
      });
      return {
        content: [{ type: "text" as const, text: result.text }],
        structuredContent: result.structuredContent as Record<string, unknown>,
      };
    } catch (error) {
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: error instanceof Error ? error.message : `${request.params.name} failed`,
        }],
      };
    }
  });

  return server;
}

async function main(): Promise<void> {
  serveStdio(() => createFileToolsServer());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
