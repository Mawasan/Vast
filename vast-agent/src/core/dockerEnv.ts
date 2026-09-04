/**
 * Vast.ai templates store environment variables and port mappings as a
 * Docker-options flag string, e.g. `-e HF_TOKEN=xxx -e MODEL_ID=foo -p 8000:8000`.
 * These helpers parse that string into a structured form so a single env var
 * or port can be added/changed/removed without touching the rest of the
 * string (the "surgical edit" requirement for template updates).
 */
export interface ParsedDockerEnv {
  envVars: Record<string, string>;
  ports: Array<{ host: string; container: string }>;
  /** Any other flag tokens we don't specifically model, kept verbatim and re-emitted last. */
  other: string[];
}

/** Simple whitespace tokenizer that respects single/double quoted spans. */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  const re = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  const matches = input.match(re);
  return matches ?? tokens;
}

function stripQuotes(v: string): string {
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

export function parseDockerEnv(envString: string | undefined | null): ParsedDockerEnv {
  const result: ParsedDockerEnv = { envVars: {}, ports: [], other: [] };
  if (!envString) return result;
  const tokens = tokenize(envString.trim());
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok === "-e" || tok === "--env") {
      const kv = stripQuotes(tokens[++i] ?? "");
      const eq = kv.indexOf("=");
      if (eq === -1) {
        result.other.push(`-e ${kv}`);
      } else {
        result.envVars[kv.slice(0, eq)] = kv.slice(eq + 1);
      }
    } else if (tok === "-p" || tok === "--publish") {
      const mapping = stripQuotes(tokens[++i] ?? "");
      const parts = mapping.split(":");
      if (parts.length >= 2) {
        result.ports.push({ host: parts[0], container: parts.slice(1).join(":") });
      } else {
        result.other.push(`-p ${mapping}`);
      }
    } else {
      result.other.push(tok);
    }
  }
  return result;
}

export function serializeDockerEnv(parsed: ParsedDockerEnv): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(parsed.envVars)) {
    const needsQuotes = /\s/.test(value);
    parts.push(`-e ${key}=${needsQuotes ? `"${value}"` : value}`);
  }
  for (const { host, container } of parsed.ports) {
    parts.push(`-p ${host}:${container}`);
  }
  parts.push(...parsed.other);
  return parts.join(" ");
}

export function setEnvVar(envString: string | undefined, key: string, value: string): string {
  const parsed = parseDockerEnv(envString);
  parsed.envVars[key] = value;
  return serializeDockerEnv(parsed);
}

export function removeEnvVar(envString: string | undefined, key: string): string {
  const parsed = parseDockerEnv(envString);
  delete parsed.envVars[key];
  return serializeDockerEnv(parsed);
}

export function setPort(envString: string | undefined, host: string, container: string): string {
  const parsed = parseDockerEnv(envString);
  const existing = parsed.ports.find((p) => p.host === host);
  if (existing) existing.container = container;
  else parsed.ports.push({ host, container });
  return serializeDockerEnv(parsed);
}
