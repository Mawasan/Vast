import { config } from "./config.js";
import { logger } from "./logger.js";

/**
 * Thin HTTP client for the Vast.ai REST API, modeled directly on the request
 * shapes used by the official `vastai` Python SDK (PyPI package, v1.6.x):
 * Bearer-token auth, `/api/v0` path prefix unless the path already starts
 * with `/api/vN`, and JSON bodies on POST/PUT/DELETE.
 */

export class VastApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, url: string) {
    super(`Vast.ai API error ${status} for ${url}: ${safeStringify(body)}`);
    this.name = "VastApiError";
    this.status = status;
    this.body = body;
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v).slice(0, 2000);
  } catch {
    return String(v);
  }
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

function buildUrl(path: string, query?: Record<string, unknown>): string {
  const prefixed = /^\/api\/v\d+\//.test(path) ? path : `/api/v0${path}`;
  const url = new URL(prefixed, config.vastUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v));
    }
  }
  return url.toString();
}

async function request(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  opts: { query?: Record<string, unknown>; json?: unknown } = {}
): Promise<unknown> {
  if (!config.vastApiKey) {
    throw new Error(
      "VAST_API_KEY is not set. Configure it as an environment variable before calling the Vast.ai API."
    );
  }
  const url = buildUrl(path, opts.query);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.vastApiKey}`,
    "User-Agent": "vast-agent/0.1.0",
  };
  const hasBody = method === "POST" || method === "PUT" || method === "DELETE";
  if (hasBody) headers["Content-Type"] = "application/json";

  const maxAttempts = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: hasBody ? JSON.stringify(opts.json ?? {}) : undefined,
      });
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) {
        await sleep(300 * attempt);
        continue;
      }
      throw err;
    }

    if (RETRYABLE_STATUS.has(res.status) && attempt < maxAttempts) {
      await sleep(300 * attempt);
      continue;
    }

    const text = await res.text();
    const body = text ? safeJsonParse(text) : null;
    if (!res.ok) {
      throw new VastApiError(res.status, body ?? text, url);
    }
    return body;
  }
  throw lastErr instanceof Error ? lastErr : new Error("Vast.ai request failed");
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const vastClient = {
  get: (path: string, query?: Record<string, unknown>) => request("GET", path, { query }),
  post: (path: string, json?: unknown, query?: Record<string, unknown>) =>
    request("POST", path, { json, query }),
  put: (path: string, json?: unknown, query?: Record<string, unknown>) =>
    request("PUT", path, { json, query }),
  delete: (path: string, json?: unknown, query?: Record<string, unknown>) =>
    request("DELETE", path, { json, query }),
};

export function isConfigured(): boolean {
  return Boolean(config.vastApiKey);
}

export function logConfigStatus() {
  logger.info("vast client configured", {
    hasApiKey: Boolean(config.vastApiKey),
    vastUrl: config.vastUrl,
  });
}
