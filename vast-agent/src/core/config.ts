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
  vastUrl: env("VAST_URL", "https://console.vast.ai") as string,
  hfToken: env("HF_TOKEN"),
  civitaiToken: env("CIVITAI_API_TOKEN"),
  port: Number(env("PORT", "8080")),
  dataDir: env("VAST_AGENT_DATA_DIR", "./data") as string,
  transport: (env("VAST_AGENT_TRANSPORT", "http") as string).toLowerCase(),
  requireConfirmation: envBool("VAST_AGENT_REQUIRE_CONFIRMATION", true),
};

/** Secret values that must never appear in logs or tool output. */
export function secretValues(): string[] {
  return [config.vastApiKey, config.hfToken, config.civitaiToken].filter(
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
