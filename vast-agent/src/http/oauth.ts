import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Express, Request, Response } from "express";
import { config } from "../core/config.js";

const scopes = ["vast:read", "vast:write"];
const accessTokenLifetimeSeconds = 60 * 60;
const refreshTokenLifetimeSeconds = 60 * 60 * 24 * 180;

type OAuthClient = {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: number;
};

type AuthorizationCode = {
  hash: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  expiresAt: number;
};

type OAuthStore = {
  clients: OAuthClient[];
  codes: AuthorizationCode[];
};

type TokenPayload = {
  type: "access" | "refresh";
  clientId: string;
  resource: string;
  scope: string;
  exp: number;
  nonce: string;
};

const storePath = () => join(config.dataDir, "oauth-store.json");
let mutationQueue: Promise<void> = Promise.resolve();

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function sameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function loadStore(): Promise<OAuthStore> {
  try {
    const parsed = JSON.parse(await readFile(storePath(), "utf8")) as OAuthStore;
    return {
      clients: Array.isArray(parsed.clients) ? parsed.clients : [],
      codes: Array.isArray(parsed.codes) ? parsed.codes.filter((code) => code.expiresAt > Date.now()) : [],
    };
  } catch {
    return { clients: [], codes: [] };
  }
}

async function saveStore(store: OAuthStore): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  const path = storePath();
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  await rename(temp, path);
}

async function mutateStore<T>(fn: (store: OAuthStore) => T | Promise<T>): Promise<T> {
  let resolveResult!: (value: T) => void;
  let rejectResult!: (reason: unknown) => void;
  const result = new Promise<T>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  mutationQueue = mutationQueue.then(async () => {
    try {
      const store = await loadStore();
      const value = await fn(store);
      await saveStore(store);
      resolveResult(value);
    } catch (error) {
      rejectResult(error);
    }
  });
  await mutationQueue;
  return result;
}

export function requestOrigin(req: Request): string {
  const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  return `${protocol}://${req.get("host")}`;
}

export function protectedResource(req: Request): string {
  return `${requestOrigin(req)}/mcp`;
}

export function resourceMetadataUrl(req: Request): string {
  return `${requestOrigin(req)}/.well-known/oauth-protected-resource`;
}

function signingSecret(): string | undefined {
  return config.accessToken;
}

function signToken(payload: TokenPayload): string {
  const secret = signingSecret();
  if (!secret) throw new Error("VAST_AGENT_ACCESS_TOKEN is not configured");
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `vat_${body}.${signature}`;
}

function verifyToken(token: string, expectedType: TokenPayload["type"]): TokenPayload | null {
  const secret = signingSecret();
  if (!secret || !token.startsWith("vat_")) return null;
  const [body, signature] = token.slice(4).split(".");
  if (!body || !signature) return null;
  const expected = createHmac("sha256", secret).update(body).digest("base64url");
  if (!sameSecret(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
    if (payload.type !== expectedType || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (!payload.clientId || !payload.resource || !payload.scope) return null;
    return payload;
  } catch {
    return null;
  }
}

export function verifyOAuthAccessToken(token: string): boolean {
  return verifyToken(token, "access") !== null;
}

function validRedirectUri(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
  } catch {
    return false;
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parameter(req: Request, name: string): string {
  const value = req.method === "POST" ? req.body?.[name] : req.query[name];
  return typeof value === "string" ? value : "";
}

async function resolveAuthorizationRequest(req: Request): Promise<{
  client: OAuthClient;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string;
  scope: string;
  state: string;
}> {
  const clientId = parameter(req, "client_id");
  const redirectUri = parameter(req, "redirect_uri");
  const responseType = parameter(req, "response_type");
  const codeChallenge = parameter(req, "code_challenge");
  const codeChallengeMethod = parameter(req, "code_challenge_method");
  const resource = parameter(req, "resource") || protectedResource(req);
  const requestedScope = parameter(req, "scope") || scopes.join(" ");
  const state = parameter(req, "state");
  const store = await loadStore();
  const client = store.clients.find((candidate) => candidate.clientId === clientId);
  if (!client) throw new Error("unknown_client");
  if (!client.redirectUris.includes(redirectUri)) throw new Error("invalid_redirect_uri");
  if (responseType !== "code") throw new Error("unsupported_response_type");
  if (codeChallengeMethod !== "S256" || !codeChallenge) throw new Error("pkce_s256_required");
  if (resource !== protectedResource(req)) throw new Error("invalid_resource");
  const requestedScopes = requestedScope.split(/\s+/).filter(Boolean);
  if (requestedScopes.some((scope) => !scopes.includes(scope))) throw new Error("invalid_scope");
  return { client, clientId, redirectUri, codeChallenge, resource, scope: requestedScopes.join(" "), state };
}

function authorizationPage(values: Awaited<ReturnType<typeof resolveAuthorizationRequest>>, error = ""): string {
  const redirectHost = new URL(values.redirectUri).host;
  const hidden = Object.entries({
    client_id: values.clientId,
    redirect_uri: values.redirectUri,
    response_type: "code",
    code_challenge: values.codeChallenge,
    code_challenge_method: "S256",
    resource: values.resource,
    scope: values.scope,
    state: values.state,
  })
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Vast Agent</title><style>body{margin:0;background:#141a12;color:#f4f1e8;font:16px system-ui;min-height:100vh;display:grid;place-items:center}.card{width:min(430px,calc(100% - 32px));box-sizing:border-box;background:#1d251a;border:1px solid #596146;border-radius:18px;padding:28px}h1{margin:0 0 10px;font-size:26px}p{color:#c7cbb7;line-height:1.5}.scope{background:#11160f;border-radius:12px;padding:12px;margin:18px 0}.error{color:#ff9a9a}label{display:block;margin:18px 0 8px}input[type=password]{width:100%;box-sizing:border-box;background:#0f140d;color:#fff;border:1px solid #7d8960;border-radius:10px;padding:13px;font-size:16px}button{width:100%;margin-top:16px;background:#b8c47e;color:#11160f;border:0;border-radius:10px;padding:13px;font-weight:700;font-size:16px}</style></head><body><main class="card"><h1>Connect Vast Agent</h1><p><strong>${escapeHtml(values.client.clientName || "ChatGPT")}</strong> wants to use your private Vast Agent. After connecting, it can inspect and change your Vast.ai resources.</p><div class="scope">Connection returns to <strong>${escapeHtml(redirectHost)}</strong><br>Paid and destructive tools still require confirmation.</div>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<form method="post" action="/oauth/authorize">${hidden}<label for="secret">Vast Agent access token</label><input id="secret" name="secret" type="password" required autocomplete="current-password"><button type="submit">Connect securely</button></form></main></body></html>`;
}

function jsonError(res: Response, status: number, error: string, description?: string): void {
  res.status(status).json({ error, ...(description ? { error_description: description } : {}) });
}

export function registerOAuthRoutes(app: Express): void {
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (req, res) => {
    const origin = requestOrigin(req);
    res.json({
      resource: protectedResource(req),
      authorization_servers: [origin],
      scopes_supported: scopes,
      resource_documentation: `${origin}/docs`,
    });
  });

  app.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"], (req, res) => {
    const origin = requestOrigin(req);
    res.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      authorization_response_iss_parameter_supported: false,
      token_endpoint_auth_methods_supported: ["none"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: scopes,
    });
  });

  app.post("/oauth/register", async (req, res) => {
    const redirectUris = req.body?.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 || !redirectUris.every(validRedirectUri)) {
      jsonError(res, 400, "invalid_client_metadata", "redirect_uris must contain valid HTTPS URLs");
      return;
    }
    if (req.body?.token_endpoint_auth_method && req.body.token_endpoint_auth_method !== "none") {
      jsonError(res, 400, "invalid_client_metadata", "Only public PKCE clients are supported");
      return;
    }
    const client: OAuthClient = {
      clientId: `vac_${randomBytes(24).toString("base64url")}`,
      clientName: typeof req.body?.client_name === "string" ? req.body.client_name.slice(0, 120) : undefined,
      redirectUris,
      createdAt: Math.floor(Date.now() / 1000),
    };
    await mutateStore((store) => {
      store.clients.push(client);
    });
    res.status(201).json({
      client_id: client.clientId,
      client_id_issued_at: client.createdAt,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  app.get("/oauth/authorize", async (req, res) => {
    try {
      const values = await resolveAuthorizationRequest(req);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      res.type("html").send(authorizationPage(values));
    } catch (error) {
      jsonError(res, 400, "invalid_request", (error as Error).message);
    }
  });

  app.post("/oauth/authorize", async (req, res) => {
    let values: Awaited<ReturnType<typeof resolveAuthorizationRequest>>;
    try {
      values = await resolveAuthorizationRequest(req);
    } catch (error) {
      jsonError(res, 400, "invalid_request", (error as Error).message);
      return;
    }
    const secret = parameter(req, "secret");
    if (!config.accessToken || !sameSecret(secret, config.accessToken)) {
      res.setHeader("Cache-Control", "no-store");
      res.status(401).type("html").send(authorizationPage(values, "The access token was not accepted."));
      return;
    }
    const code = randomBytes(32).toString("base64url");
    await mutateStore((store) => {
      store.codes.push({
        hash: sha256(code),
        clientId: values.clientId,
        redirectUri: values.redirectUri,
        codeChallenge: values.codeChallenge,
        resource: values.resource,
        scope: values.scope,
        expiresAt: Date.now() + 5 * 60 * 1000,
      });
    });
    const callback = new URL(values.redirectUri);
    callback.searchParams.set("code", code);
    if (values.state) callback.searchParams.set("state", values.state);
    res.redirect(303, callback.toString());
  });

  app.post("/oauth/token", async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const grantType = parameter(req, "grant_type");
    const clientId = parameter(req, "client_id");
    const resource = parameter(req, "resource") || protectedResource(req);
    if (resource !== protectedResource(req)) {
      jsonError(res, 400, "invalid_target");
      return;
    }

    let scope = scopes.join(" ");
    if (grantType === "authorization_code") {
      const code = parameter(req, "code");
      const redirectUri = parameter(req, "redirect_uri");
      const codeVerifier = parameter(req, "code_verifier");
      const record = await mutateStore((store) => {
        const index = store.codes.findIndex((candidate) => candidate.hash === sha256(code));
        if (index < 0) return undefined;
        const [found] = store.codes.splice(index, 1);
        return found;
      });
      if (
        !record ||
        record.expiresAt <= Date.now() ||
        record.clientId !== clientId ||
        record.redirectUri !== redirectUri ||
        record.resource !== resource ||
        base64url(createHash("sha256").update(codeVerifier).digest()) !== record.codeChallenge
      ) {
        jsonError(res, 400, "invalid_grant");
        return;
      }
      scope = record.scope;
    } else if (grantType === "refresh_token") {
      const refresh = verifyToken(parameter(req, "refresh_token"), "refresh");
      if (!refresh || refresh.clientId !== clientId || refresh.resource !== resource) {
        jsonError(res, 400, "invalid_grant");
        return;
      }
      scope = refresh.scope;
    } else {
      jsonError(res, 400, "unsupported_grant_type");
      return;
    }

    const now = Math.floor(Date.now() / 1000);
    res.json({
      access_token: signToken({ type: "access", clientId, resource, scope, exp: now + accessTokenLifetimeSeconds, nonce: randomBytes(12).toString("base64url") }),
      token_type: "Bearer",
      expires_in: accessTokenLifetimeSeconds,
      refresh_token: signToken({ type: "refresh", clientId, resource, scope, exp: now + refreshTokenLifetimeSeconds, nonce: randomBytes(12).toString("base64url") }),
      scope,
    });
  });

  app.get("/docs", (_req, res) => {
    res.type("text").send("Vast Agent is a private MCP tool server for managing Vast.ai resources. Paid and destructive operations require explicit confirmation.");
  });
}
