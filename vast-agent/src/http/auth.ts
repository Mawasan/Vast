import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "../core/config.js";

function sameSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function hasValidAgentToken(authorization: string | undefined, expected = config.accessToken): boolean {
  if (!expected) return false;
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) return false;
  return sameSecret(authorization.slice(prefix.length), expected);
}

export function requireAgentAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.accessToken) {
    res.status(503).json({ error: "agent_access_token_not_configured" });
    return;
  }
  if (!hasValidAgentToken(req.header("authorization"))) {
    res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}
