import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { promisify } from "node:util";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Core } from "@reelflow/core";
import { paginationSchema } from "@reelflow/types";
import { requireUser } from "../http/auth";
import { parse } from "../http/validate";

const exec = promisify(execFile);

export const systemRoutes =
  (core: Core): FastifyPluginAsync =>
  async (app) => {
    /** Liveness — no auth, no details. */
    app.get("/health/live", async () => ({ ok: true }));

    /** Detailed health for signed-in users (also used by `reelflow health`). */
    app.get("/health", async (req) => {
      requireUser(req, "dashboard:read");
      const check = async (fn: () => Promise<unknown>) => {
        const t = Date.now();
        try {
          const detail = await fn();
          return { ok: true, ms: Date.now() - t, detail };
        } catch (e) {
          return { ok: false, ms: Date.now() - t, error: (e as Error).message };
        }
      };
      const [database, redis, storage, ffmpeg, queues, network] = await Promise.all([
        check(() => core.db.$queryRaw`SELECT 1`),
        check(() => core.redis.ping()),
        check(async () => {
          await access(core.storage.root, constants.W_OK);
          return { freeGb: ((await core.storage.freeBytes()) ?? 0) / 1024 ** 3 };
        }),
        check(async () => (await exec("ffmpeg", ["-version"])).stdout.split("\n")[0]),
        check(() => core.queues.counts()),
        check(() => core.network.status()),
      ]);
      return { ok: database.ok && redis.ok && storage.ok && ffmpeg.ok, database, redis, storage, ffmpeg, queues, network };
    });

    app.get("/dashboard", async (req) => {
      requireUser(req, "dashboard:read");
      return core.analytics.dashboard();
    });

    app.get("/analytics/activity", async (req) => {
      requireUser(req, "dashboard:read");
      const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(90).default(14) }), req.query);
      return core.analytics.activity(days);
    });

    app.get("/analytics/overview", async (req) => {
      requireUser(req, "dashboard:read");
      const [sources, success, activity] = await Promise.all([core.analytics.sourceContribution(), core.analytics.successRate(), core.analytics.activity(30)]);
      return { sources, success, activity };
    });

    app.get("/audit", async (req) => {
      requireUser(req, "logs:read");
      const q = parse(paginationSchema.extend({ text: z.string().max(200).optional(), action: z.string().max(60).optional(), entityType: z.string().max(40).optional(), entityId: z.string().max(60).optional() }), req.query);
      return core.audit.search(q);
    });

    app.get("/jobs", async (req) => {
      requireUser(req, "logs:read");
      const q = parse(paginationSchema.extend({ queue: z.string().max(40).optional(), status: z.string().max(20).optional(), contentId: z.string().uuid().optional() }), req.query);
      const where = { ...(q.queue ? { queue: q.queue } : {}), ...(q.status ? { status: q.status as never } : {}), ...(q.contentId ? { contentId: q.contentId } : {}) };
      const [items, total] = await Promise.all([
        core.db.processingJob.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
        core.db.processingJob.count({ where }),
      ]);
      return { items, total };
    });

    app.get("/queues", async (req) => {
      requireUser(req, "logs:read");
      return core.queues.counts();
    });

    app.get("/notifications", async (req) => {
      requireUser(req, "dashboard:read");
      const { unread } = parse(z.object({ unread: z.coerce.boolean().default(false) }), req.query);
      const [items, unreadCount] = await Promise.all([core.notifications.list(unread), core.notifications.unreadCount()]);
      return { items, unreadCount };
    });

    app.post("/notifications/read", async (req) => {
      requireUser(req, "dashboard:read");
      const body = parse(z.object({ ids: z.union([z.literal("all"), z.array(z.string().uuid()).max(200)]) }), req.body);
      await core.notifications.markRead(body.ids);
      return { ok: true };
    });

    app.post("/cleanup", async (req) => {
      requireUser(req, "settings:write");
      const { dryRun } = parse(z.object({ dryRun: z.boolean().default(true) }), req.body ?? {});
      return core.cleanup.run(dryRun);
    });
  };
