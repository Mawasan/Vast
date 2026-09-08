import { config } from "./core/config.js";
import { logger } from "./core/logger.js";
import { logConfigStatus } from "./core/vastClient.js";

async function main() {
  logConfigStatus();

  if (config.transport === "stdio") {
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { createMcpServer } = await import("./mcp/server.js");
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("vast-agent mcp server running on stdio");
    return;
  }

  const { startHttpServer } = await import("./http/server.js");
  startHttpServer();
}

main().catch((err) => {
  logger.error("fatal startup error", { error: (err as Error).message });
  process.exit(1);
});
