import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { SESSION_TTL_MS, type Core } from "@reelflow/core";
import { AppError, createUserSchema, loginSchema } from "@reelflow/types";
import { clearSessionCookie, requireUser, setSessionCookie } from "../http/auth";
import { parse } from "../http/validate";

export const authRoutes =
  (core: Core): FastifyPluginAsync =>
  async (app) => {
    const secure = core.config.env === "production";

    app.post("/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
      const body = parse(loginSchema, req.body);
      const { token, session } = await core.auth.login(body.email, body.password, { ip: req.ip, userAgent: req.headers["user-agent"] });
      setSessionCookie(reply, token, secure, SESSION_TTL_MS);
      return { user: session.user, csrfToken: session.csrfToken };
    });

    app.post("/auth/logout", async (req, reply) => {
      if (req.session) await core.auth.logout(req.session.sessionId, req.session.user.id);
      clearSessionCookie(reply);
      return { ok: true };
    });

    /** Current user + CSRF token (the SPA calls this on load). */
    app.get("/auth/me", async (req) => {
      if (!req.session) throw new AppError("UNAUTHENTICATED", "Sign in required");
      return { user: req.session.user, csrfToken: req.session.csrfToken };
    });

    app.post("/auth/password", async (req, reply) => {
      const actor = requireUser(req, "dashboard:read");
      const body = parse(z.object({ current: z.string().min(1), next: z.string().min(12).max(512) }), req.body);
      await core.auth.changePassword(actor.id!, body.current, body.next);
      clearSessionCookie(reply);
      return { ok: true };
    });

    app.get("/users", async (req) => core.auth.listUsers(requireUser(req, "users:manage")));

    app.post("/users", async (req) => core.auth.createUser(parse(createUserSchema, req.body), requireUser(req, "users:manage")));
  };
