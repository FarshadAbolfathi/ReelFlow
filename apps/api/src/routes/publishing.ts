import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Core } from "@reelflow/core";
import { POST_STATUSES, connectAccountSchema, connectSessionSchema, reschedulePostSchema, scheduleInputSchema, schedulePostSchema, type PostStatus } from "@reelflow/types";
import { requireUser } from "../http/auth";
import { parse, uuidParam } from "../http/validate";

export const publishingRoutes =
  (core: Core): FastifyPluginAsync =>
  async (app) => {
    // ── Accounts ───────────────────────────────────────────────────────
    app.get("/accounts", async (req) => {
      requireUser(req, "accounts:read");
      return core.accounts.list();
    });

    app.post("/accounts", async (req, reply) => {
      const account = await core.accounts.connect(parse(connectAccountSchema, req.body), requireUser(req, "accounts:write"));
      return reply.code(201).send(account);
    });

    // In-app Instagram login (PUBLISHING_ADAPTER_MODE=session).
    app.post("/accounts/session", async (req, reply) => {
      const account = await core.accounts.connectSession(parse(connectSessionSchema, req.body), requireUser(req, "accounts:write"));
      return reply.code(201).send(account);
    });

    app.post("/accounts/:id/disconnect", async (req) => core.accounts.disconnect(uuidParam(req.params), requireUser(req, "accounts:write")));
    app.post("/accounts/:id/validate", async (req) => core.accounts.validate(uuidParam(req.params), requireUser(req, "accounts:read")));
    app.post("/accounts/:id/resume", async (req) => core.accounts.resume(uuidParam(req.params), requireUser(req, "queue:control")));
    app.patch("/accounts/:id/limit", async (req) => {
      const { dailyLimit } = parse(z.object({ dailyLimit: z.number().int().min(0).max(100).nullable() }), req.body);
      return core.accounts.setDailyLimit(uuidParam(req.params), dailyLimit, requireUser(req, "accounts:write"));
    });

    // ── Schedules ──────────────────────────────────────────────────────
    app.get("/schedules", async (req) => {
      requireUser(req, "content:read");
      return core.scheduling.listSchedules();
    });
    app.post("/schedules", async (req, reply) => reply.code(201).send(await core.scheduling.upsertSchedule(null, parse(scheduleInputSchema, req.body), requireUser(req, "schedule:write"))));
    app.put("/schedules/:id", async (req) => core.scheduling.upsertSchedule(uuidParam(req.params), parse(scheduleInputSchema, req.body), requireUser(req, "schedule:write")));
    app.delete("/schedules/:id", async (req, reply) => {
      await core.scheduling.deleteSchedule(uuidParam(req.params), requireUser(req, "schedule:write"));
      return reply.code(204).send();
    });
    app.post("/schedules/:id/fill", async (req) => {
      const { horizonDays } = parse(z.object({ horizonDays: z.number().int().min(1).max(14).default(3) }), req.body ?? {});
      return core.scheduling.autoFill(uuidParam(req.params), { horizonDays, actor: requireUser(req, "schedule:write") });
    });

    // ── Queue ──────────────────────────────────────────────────────────
    app.get("/queue", async (req) => {
      requireUser(req, "content:read");
      const q = parse(
        z.object({
          status: z.enum(POST_STATUSES as unknown as [PostStatus, ...PostStatus[]]).optional(),
          accountId: z.string().uuid().optional(),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
        }),
        req.query,
      );
      return core.scheduling.queue({ ...q, from: q.from ? new Date(q.from) : undefined, to: q.to ? new Date(q.to) : undefined });
    });

    app.post("/posts", async (req, reply) => reply.code(201).send(await core.scheduling.schedulePost(parse(schedulePostSchema, req.body), requireUser(req, "schedule:write"))));
    app.patch("/posts/:id/schedule", async (req) => core.scheduling.reschedule(uuidParam(req.params), parse(reschedulePostSchema, req.body).scheduledAt, requireUser(req, "queue:control")));
    app.post("/posts/:id/cancel", async (req) => core.scheduling.cancel(uuidParam(req.params), requireUser(req, "queue:control")));
    app.post("/posts/:id/pause", async (req) => core.scheduling.pause(uuidParam(req.params), requireUser(req, "queue:control")));
    app.post("/posts/:id/resume", async (req) => core.scheduling.resume(uuidParam(req.params), requireUser(req, "queue:control")));
    app.post("/posts/:id/retry", async (req) => core.scheduling.retry(uuidParam(req.params), requireUser(req, "queue:control")));
    app.post("/posts/:id/publish-now", async (req, reply) => {
      await core.publishing.publishNow(uuidParam(req.params), requireUser(req, "queue:control"));
      return reply.code(202).send({ ok: true });
    });
    app.get("/posts/:id/check", async (req) => {
      requireUser(req, "content:read");
      return core.publishing.check(uuidParam(req.params));
    });
    app.get("/posts/:id/attempts", async (req) => {
      requireUser(req, "logs:read");
      return core.db.publishAttempt.findMany({ where: { scheduledPostId: uuidParam(req.params) }, orderBy: { attempt: "desc" } });
    });
  };
