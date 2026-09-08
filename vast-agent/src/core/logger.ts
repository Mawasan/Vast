import { redact } from "./config.js";

type Level = "info" | "warn" | "error" | "debug";

function line(level: Level, msg: string, meta?: Record<string, unknown>) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: redact(msg),
    ...(meta ? { meta: JSON.parse(redact(JSON.stringify(meta))) } : {}),
  };
  // Always write to stderr: stdout is reserved for the MCP JSON-RPC stream
  // when running under the stdio transport, and must never carry log noise.
  console.error(JSON.stringify(entry));
}

export const logger = {
  info: (msg: string, meta?: Record<string, unknown>) => line("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => line("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => line("error", msg, meta),
  debug: (msg: string, meta?: Record<string, unknown>) => {
    if (process.env.VAST_AGENT_DEBUG === "1") line("debug", msg, meta);
  },
};
