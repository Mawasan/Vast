import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tools } from "../tools/registry.js";
import { logger } from "../core/logger.js";
import { redact } from "../core/config.js";

/**
 * Builds a fresh MCP server with every VAST Agent tool registered. Called
 * once for the stdio transport, and once per request for the stateless
 * Streamable HTTP transport.
 */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "vast-agent", version: "0.3.0" });

  for (const tool of tools) {
    const readOnly = /(^|_)(list|get|search|check|inspect|validate|whoami|memory)(_|$)/.test(tool.name);
    const idempotent = readOnly || /(^|_)(set|sync|start|stop|generate_image|serverless_request)(_|$)/.test(tool.name);
    const openWorld = !tool.name.startsWith("comfyui_") && tool.name !== "vast_validate_template_config";
    server.registerTool(
      tool.name,
      {
        title: tool.name
          .split("_")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join(" "),
        description: tool.description,
        inputSchema: tool.inputShape,
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: Boolean(tool.destructive),
          idempotentHint: idempotent,
          openWorldHint: openWorld,
        },
      },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(args as never);
          return {
            content: [{ type: "text" as const, text: redact(JSON.stringify(result, null, 2)) }],
          };
        } catch (err) {
          logger.error(`tool ${tool.name} failed`, { error: (err as Error).message });
          return {
            isError: true,
            content: [{ type: "text" as const, text: redact((err as Error).message) }],
          };
        }
      }
    );
  }

  return server;
}
