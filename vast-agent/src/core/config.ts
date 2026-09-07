import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Parses `KEY=value` lines, ignoring blanks and comments. */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

/**
 * Applies parsed values, letting a real environment variable win but treating
 * an empty one as unset. That distinction matters: an MCP client launching
 * this agent passes keys through as empty strings when the user's shell has
 * none, and Node's own `process.loadEnvFile` would then consider the variable
 * "already set" and skip the file — silently ignoring the user's .env.
 */
export function applyEnv(
  parsed: Record<string, string>,
  target: Record<string, string | undefined> = process.env
): void {
  for (const [key, value] of Object.entries(parsed)) {
    const current = target[key];
    if (current === undefined || current === "") target[key] = value;
  }
}

/**
 * Loads a `.env` next to the package (or in the working directory) so keys are
 * written down once instead of being exported every session. Resolved relative
 * to this module, not the process's working directory, because MCP clients
 * launch the agent from wherever they happen to be. A missing file is normal:
 * on Railway the platform supplies the variables and no .env exists.
 */
function loadEnvFile(): void {
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  for (const candidate of [join(packageRoot, ".env"), join(process.cwd(), ".env")]) {
    let contents: string;
    try {
      contents = readFileSync(candidate, "utf8");
    } catch {
      continue;
    }
    applyEnv(parseEnvFile(contents));
    return;
  }
}

loadEnvFile();

function env(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true";
}

export const config = {
  vastApiKey: env("VAST_API_KEY"),
  accessToken: env("VAST_AGENT_ACCESS_TOKEN"),
  vastUrl: env("VAST_URL", "https://console.vast.ai") as string,
  hfToken: env("HF_TOKEN"),
  // CIVITAI_TOKEN is Vast's own name for it and CIVIT is what this account
  // uses; accept all three so the agent and its workers read the same token.
  civitaiToken: env("CIVITAI_API_TOKEN") ?? env("CIVITAI_TOKEN") ?? env("CIVIT"),
  port: Number(env("PORT", "8080")),
  dataDir: env("VAST_AGENT_DATA_DIR", "./data") as string,
  transport: (env("VAST_AGENT_TRANSPORT", "http") as string).toLowerCase(),
  requireConfirmation: envBool("VAST_AGENT_REQUIRE_CONFIRMATION", true),
};

/** Secret values that must never appear in logs or tool output. */
export function secretValues(): string[] {
  return [config.vastApiKey, config.accessToken, config.hfToken, config.civitaiToken].filter(
    (v): v is string => Boolean(v && v.length >= 6)
  );
}

export function redact(input: string): string {
  let out = input;
  for (const secret of secretValues()) {
    out = out.split(secret).join("***REDACTED***");
  }
  return out;
}
