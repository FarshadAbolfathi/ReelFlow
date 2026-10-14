import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import type { FastifyPluginAsync } from "fastify";
import sharp from "sharp";
import { z } from "zod";
import { renderCaption, type Core } from "@reelflow/core";
import { PRESETS, computePlacement, renderWatermarkPng } from "@reelflow/media";
import { detectMediaType } from "@reelflow/security";
import {
  AppError,
  captionTemplateInputSchema,
  networkSelectSchema,
  networkServerCreateSchema,
  settingsPatchSchema,
  watermarkConfigSchema,
  watermarkPresetInputSchema,
  type NetworkCommand,
} from "@reelflow/types";
import type { Prisma } from "@reelflow/database";
import { requireUser } from "../http/auth";
import { parse, uuidParam } from "../http/validate";

export const settingsRoutes =
  (core: Core): FastifyPluginAsync =>
  async (app) => {
    // ── Settings ───────────────────────────────────────────────────────
    app.get("/settings", async (req) => {
      requireUser(req, "settings:read");
      return {
        settings: await core.settings.get(),
        ceilings: core.settings.ceilings(),
        effectiveLimits: await core.settings.limits(),
        environment: {
          networkMode: core.config.network.mode,
          publishingAdapterMode: core.config.publishingAdapterMode,
          storagePath: core.config.storagePath,
          timezone: core.config.defaultTimezone,
        },
      };
    });

    app.patch("/settings", async (req) => {
      const body = parse(settingsPatchSchema, req.body);
      return core.settings.update(body.section, body.values, requireUser(req, "settings:write"));
    });

    // ── Network (owner-only control; status readable by all) ──────────
    app.get("/network/status", async (req) => {
      requireUser(req, "settings:read");
      return { status: await core.network.status(), configuredMode: core.config.network.mode };
    });

    app.post("/network/:command", async (req) => {
      const actor = requireUser(req, "network:control");
      const { command } = parse(z.object({ command: z.enum(["status", "test", "start", "stop", "restart"]) }), req.params);
      const r = await core.network.command(command as NetworkCommand, actor.id ?? "unknown");
      await core.audit.log("network_command", actor, `Network ${command}: ${r.message}`, null, { ok: r.ok });
      return r;
    });

    /** Switches the live network target: "direct", "builtin" (the .env-configured
     * VPS proxy), or a NetworkServer id — takes effect immediately, no restart. */
    app.post("/network/select", async (req) => {
      const actor = requireUser(req, "network:control");
      const { target } = parse(networkSelectSchema, req.body);
      const mode = target === "direct" ? "direct" : "proxy";
      await core.network.command("set_mode", actor.id ?? "unknown", 20_000, { mode });
      const r = mode === "proxy" ? await core.network.command("select_server", actor.id ?? "unknown", 20_000, { serverId: target }) : { ok: true, message: "Direct mode", status: await core.network.status() };
      await core.audit.log("network_command", actor, `Network target set to ${target}: ${r.message}`, null, { ok: r.ok, target });
      return r;
    });

    // ── SSH servers (Settings → Network) ────────────────────────────────
    app.get("/network/servers", async (req) => {
      requireUser(req, "settings:read");
      return core.networkServers.list();
    });

    app.post("/network/servers", async (req, reply) => {
      const actor = requireUser(req, "network:control");
      const input = parse(networkServerCreateSchema, req.body);
      reply.code(201);
      return core.networkServers.create(input, actor);
    });

    app.delete("/network/servers/:id", async (req, reply) => {
      const actor = requireUser(req, "network:control");
      await core.networkServers.remove(uuidParam(req.params), actor);
      return reply.code(204).send();
    });

    app.post("/network/servers/:id/test", async (req) => {
      const actor = requireUser(req, "network:control");
      return core.networkServers.test(uuidParam(req.params), actor);
    });

    // ── Watermark presets ──────────────────────────────────────────────
    app.get("/watermarks", async (req) => {
      requireUser(req, "content:read");
      return core.db.watermarkPreset.findMany({ orderBy: { createdAt: "asc" } });
    });

    const saveWatermark = async (id: string | null, raw: unknown, actorId: string) => {
      const input = parse(watermarkPresetInputSchema, raw);
      const data = { name: input.name, isDefault: input.isDefault, config: input.config as Prisma.InputJsonValue };
      return core.db.$transaction(async (tx) => {
        if (input.isDefault) await tx.watermarkPreset.updateMany({ data: { isDefault: false } });
        const preset = id ? await tx.watermarkPreset.update({ where: { id }, data }) : await tx.watermarkPreset.create({ data });
        await tx.auditLog.create({ data: { action: "settings_changed", actorType: "USER", actorId, entityType: "watermark", entityId: preset.id, summary: `Watermark preset "${preset.name}" saved` } });
        return preset;
      });
    };
    app.post("/watermarks", async (req, reply) => reply.code(201).send(await saveWatermark(null, req.body, requireUser(req, "settings:write").id!)));
    app.put("/watermarks/:id", async (req) => saveWatermark(uuidParam(req.params), req.body, requireUser(req, "settings:write").id!));
    app.delete("/watermarks/:id", async (req, reply) => {
      requireUser(req, "settings:write");
      await core.db.watermarkPreset.delete({ where: { id: uuidParam(req.params) } });
      return reply.code(204).send();
    });

    /** Upload a logo for image watermarks (PNG/WebP/JPEG, max 5 MB). */
    app.post("/watermarks/image", async (req) => {
      requireUser(req, "settings:write");
      const part = await req.file({ limits: { fileSize: 5 * 1024 * 1024 } });
      if (!part) throw new AppError("VALIDATION_FAILED", "No file uploaded");
      const key = core.storage.keyFor("watermarks", `${randomUUID()}.png`);
      await core.storage.write(key, part.file);
      const full = core.storage.resolve(key);
      const buf = await readFile(full);
      if (part.file.truncated || detectMediaType(buf.subarray(0, 64))?.mediaType !== "IMAGE") {
        await rm(full, { force: true });
        throw new AppError("MEDIA_INVALID", "Upload a PNG, WebP or JPEG image under 5 MB");
      }
      // Re-encode to PNG: strips metadata and anything that isn't pixels.
      await sharp(buf).png().toFile(`${full}.tmp`);
      await import("node:fs/promises").then((fs) => fs.rename(`${full}.tmp`, full));
      return { imageAssetKey: key };
    });

    /** Renders a JPEG preview of a watermark on a content thumbnail (or a neutral frame). */
    app.post("/watermarks/preview", async (req, reply) => {
      requireUser(req, "content:read");
      const body = parse(z.object({ config: watermarkConfigSchema, contentId: z.string().uuid().optional(), presetKey: z.enum(["INSTAGRAM_REEL", "INSTAGRAM_FEED", "INSTAGRAM_STORY"]).default("INSTAGRAM_REEL") }), req.body);
      const preset = PRESETS[body.presetKey];
      const scale = 0.5;
      const W = Math.round(preset.width * scale);
      const H = Math.round(preset.height * scale);
      let base = sharp({ create: { width: W, height: H, channels: 3, background: { r: 38, g: 44, b: 58 } } });
      if (body.contentId) {
        const c = await core.db.content.findUnique({ where: { id: body.contentId }, select: { thumbnailKey: true } });
        if (c?.thumbnailKey) base = sharp(core.storage.resolve(c.thumbnailKey)).resize(W, H, { fit: "cover" });
      }
      const wm = await renderWatermarkPng(body.config, W, H, core.storage.root);
      const p = computePlacement(body.config.position, { width: W, height: H }, wm, body.config.marginPx * scale, body.config.respectSafeArea ? preset.safeArea : null);
      const jpeg = await base.composite([{ input: wm.png, left: p.x, top: p.y }]).jpeg({ quality: 80 }).toBuffer();
      return reply.header("content-type", "image/jpeg").header("cache-control", "no-store").send(jpeg);
    });

    // ── Caption templates ──────────────────────────────────────────────
    app.get("/templates", async (req) => {
      requireUser(req, "content:read");
      return core.db.captionTemplate.findMany({ orderBy: { createdAt: "asc" } });
    });

    const saveTemplate = async (id: string | null, raw: unknown) => {
      const input = parse(captionTemplateInputSchema, raw);
      return core.db.$transaction(async (tx) => {
        if (input.isDefault) await tx.captionTemplate.updateMany({ data: { isDefault: false } });
        return id ? tx.captionTemplate.update({ where: { id }, data: input }) : tx.captionTemplate.create({ data: input });
      });
    };
    app.post("/templates", async (req, reply) => {
      requireUser(req, "settings:write");
      return reply.code(201).send(await saveTemplate(null, req.body));
    });
    app.put("/templates/:id", async (req) => {
      requireUser(req, "settings:write");
      return saveTemplate(uuidParam(req.params), req.body);
    });
    app.delete("/templates/:id", async (req, reply) => {
      requireUser(req, "settings:write");
      await core.db.captionTemplate.delete({ where: { id: uuidParam(req.params) } });
      return reply.code(204).send();
    });
    app.post("/templates/render", async (req) => {
      requireUser(req, "content:read");
      const body = parse(z.object({ body: z.string().max(2200), sample: z.record(z.string(), z.string()).default({}) }), req.body);
      const s = await core.settings.get();
      return {
        caption: renderCaption(body.body, {
          originalCaption: body.sample.original_caption ?? "متن اصلی ویدیو",
          source: body.sample.source ?? "Funny Page",
          attribution: body.sample.attribution ?? "🎬 @funnypage",
          hashtags: (body.sample.hashtags ?? "funny reels").split(/\s+/),
          cta: body.sample.cta ?? "Follow {{brand}} for more",
          brand: s.general.brandName,
          timezone: s.general.timezone,
          locale: s.general.locale,
        }),
      };
    });
  };
