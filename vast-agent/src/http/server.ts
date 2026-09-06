import express from "express";
import { z } from "zod";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../mcp/server.js";
import { tools } from "../tools/registry.js";
import { config, redact } from "../core/config.js";
import { logger } from "../core/logger.js";
import { isConfigured } from "../core/vastClient.js";
import { requireAgentAuth } from "./auth.js";

export function createHttpApp() {
  const app = express();
  app.use(express.json({ limit: "5mb" }));

  // Railway / load-balancer health check. Never touches the Vast.ai API.
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      vastConfigured: isConfigured(),
      transport: config.transport,
    });
  });

  // Public, read-only discovery document for ChatGPT Actions and other
  // OpenAPI clients. It contains schemas and descriptions, never credentials
  // or Vast account data. Tool execution remains protected below.
  app.get(["/openapi.json", "/api/openapi.json"], (req, res) => {
    const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
    const protocol = forwardedProto || req.protocol;
    const serverUrl = `${protocol}://${req.get("host")}`;
    res.json({
      openapi: "3.1.0",
      info: {
        title: "Vast Agent",
        version: "0.3.0",
        description:
          "Manage Vast.ai compute and serverless inference. Read operations may run immediately. " +
          "Paid or state-changing operations first return confirmation_required unless confirm=true is supplied.",
      },
      servers: [{ url: serverUrl }],
      security: [{ bearerAuth: [] }],
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "VastAgentAccessToken" },
        },
      },
      paths: Object.fromEntries(
        tools.map((tool) => [
          `/api/tools/${tool.name}`,
          {
            post: {
              operationId: tool.name,
              description: tool.description,
              requestBody: {
                required: true,
                content: {
                  "application/json": { schema: z.toJSONSchema(z.object(tool.inputShape)) },
                },
              },
              responses: {
                "200": {
                  description: "Tool result, operation preview, or asynchronous job",
                  content: {
                    "application/json": {
                      schema: { type: "object", properties: { result: {} } },
                    },
                  },
                },
                "400": { description: "Invalid input or tool failure" },
                "401": { description: "Invalid access token" },
              },
            },
          },
        ])
      ),
    });
  });

  // Everything that can inspect or change the Vast account is protected.
  // Health and the OpenAPI discovery document are the only public routes.
  app.use(["/mcp", "/api"], requireAgentAuth);

  // MCP endpoint: stateless Streamable HTTP, one fresh server+transport per
  // request. Cursor / Codex / Claude Code and any MCP-compatible client
  // connect here over plain HTTP.
  app.post("/mcp", async (req, res) => {
    try {
      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        transport.close();
        server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      logger.error("mcp request failed", { error: (err as Error).message });
      if (!res.headersSent) {
        res.status(500).json({ error: "internal_error", message: (err as Error).message });
      }
    }
  });

  // Simple REST fallback for clients that don't speak MCP.
  app.get("/api/tools", (_req, res) => {
    res.json(
      tools.map((t) => ({
        name: t.name,
        description: t.description,
        destructive: Boolean(t.destructive),
        inputSchema: z.toJSONSchema(z.object(t.inputShape)),
        inputShape: Object.fromEntries(
          Object.entries(t.inputShape).map(([k, v]) => [k, (v as z.ZodTypeAny).description ?? v.constructor.name])
        ),
      }))
    );
  });

  app.post("/api/tools/:name", async (req, res) => {
    const tool = tools.find((t) => t.name === req.params.name);
    if (!tool) {
      res.status(404).json({ error: "unknown_tool", name: req.params.name });
      return;
    }
    try {
      const parsed = z.object(tool.inputShape).parse(req.body ?? {});
      const result = await tool.handler(parsed as never);
      res.json(JSON.parse(redact(JSON.stringify({ result }))));
    } catch (err) {
      const message = err instanceof z.ZodError ? err.issues : redact((err as Error).message);
      logger.error(`tool ${tool.name} failed via http`, { error: message });
      res.status(400).json({ error: "tool_failed", message });
    }
  });

  return app;
}

export function startHttpServer() {
  const app = createHttpApp();
  const server = app.listen(config.port, () => {
    logger.info("vast-agent http server listening", { port: config.port });
  });

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return server;
}
