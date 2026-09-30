import type { FastifyReply, FastifyRequest } from "fastify";
import { assertCan, safeEqual, type Permission } from "@reelflow/security";
import { AppError } from "@reelflow/types";
import type { SessionInfo, UserActor } from "@reelflow/core";

export const SESSION_COOKIE = "rf_session";
export const CSRF_HEADER = "x-csrf-token";

declare module "fastify" {
  interface FastifyRequest {
    session: SessionInfo | null;
  }
}

/** Returns the signed-in user as an audit actor, enforcing the permission. */
export function requireUser(req: FastifyRequest, permission: Permission): UserActor {
  if (!req.session) throw new AppError("UNAUTHENTICATED", "Sign in required");
  assertCan(req.session.user.role, permission);
  return { type: "USER", id: req.session.user.id, role: req.session.user.role };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF protection for cookie-authenticated requests: every state-changing
 * request must echo the per-session token in a header (not readable cross-site).
 */
export function verifyCsrf(req: FastifyRequest): void {
  if (SAFE_METHODS.has(req.method) || !req.session) return;
  const header = req.headers[CSRF_HEADER];
  const token = Array.isArray(header) ? header[0] : header;
  if (!token || !safeEqual(token, req.session.csrfToken)) throw new AppError("CSRF_INVALID", "Missing or invalid CSRF token");
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean, maxAgeMs: number): void {
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure, sameSite: "strict", path: "/", maxAge: Math.floor(maxAgeMs / 1000) });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
}
