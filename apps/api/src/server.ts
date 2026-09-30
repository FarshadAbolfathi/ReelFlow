import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import type { Core } from "@reelflow/core";
import { redactString } from "@reelflow/logger";
import { AppError, isAppError } from "@reelflow/types";
import { SESSION_COOKIE, verifyCsrf } from "./http/auth";
import { registerRoutes } from "./routes";

export async function buildServer(core: Core): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: core.config.logLevel,
      redact: { paths: ["req.headers.cookie", "req.headers.authorization", 'req.headers["x-csrf-token"]', "res.headers['set-cookie']"], censor: "********" },
    },
    trustProxy: "127.0.0.1",
    bodyLimit: 1024 * 1024,
    disableRequestLogging: false,
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-origin" } });
  await app.register(cookie);
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
    redis: core.redis,
    nameSpace: "reelflow:api-rl:",
    keyGenerator: (req) => req.ip,
  });
  await app.register(multipart, {
    limits: { fileSize: core.config.uploadMaxBytes, files: 1, fields: 10, fieldSize: 10_000 },
  });

  app.decorateRequest("session", null);
  app.addHook("onRequest", async (req) => {
    req.session = await core.auth.resolve(req.cookies[SESSION_COOKIE]);
    verifyCsrf(req);
  });

  app.setErrorHandler((error, req, reply) => {
    const e = error as Error & { statusCode?: number; validation?: unknown; code?: string };
    if (isAppError(e)) {
      if (e.httpStatus >= 500) req.log.error({ err: e }, "request failed");
      if (e.retryAfterMs) reply.header("retry-after", Math.ceil(e.retryAfterMs / 1000));
      return reply.code(e.httpStatus).send({ error: e.toJSON() });
    }
    if (e.statusCode === 429) return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
    if (e.code === "FST_REQ_FILE_TOO_LARGE" || e.statusCode === 413)
      return reply.code(413).send({ error: { code: "MEDIA_INVALID", message: "File is too large" } });
    if (e.code === "P2025") return reply.code(404).send({ error: { code: "NOT_FOUND", message: "Not found" } });
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: { code: "VALIDATION_FAILED", message: redactString(e.message) } });
    req.log.error({ err: e }, "unhandled error");
    return reply.code(500).send({ error: new AppError("INTERNAL_ERROR", "Internal error").toJSON() });
  });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } }));

  await app.register(registerRoutes(core), { prefix: "/api" });
  return app;
}
