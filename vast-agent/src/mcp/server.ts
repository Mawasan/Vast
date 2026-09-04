import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tools } from "../tools/registry.js";
import { logger } from "../core/logger.js";

/**
 * Builds a fresh MCP server with every VAST Agent tool registered. Called
 * once for the stdio transport, and once per request for the stateless
 * Streamable HTTP transport.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "vast-agent", version: "0.1.0" });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputShape,
        annotations: tool.destructive
          ? { destructiveHint: true, idempotentHint: false }
          : { readOnlyHint: tool.name.startsWith("vast_list") || tool.name.startsWith("vast_get") },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(args as never);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          logger.error(`tool ${tool.name} failed`, { error: (err as Error).message });
          return {
            isError: true,
            content: [{ type: "text" as const, text: (err as Error).message }],
          };
        }
      }
    );
  }

  return server;
}
