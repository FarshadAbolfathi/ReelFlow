import { randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Core } from "@reelflow/core";
import { detectMediaType, sanitizeFilename } from "@reelflow/security";
import { AppError, RIGHTS_STATUSES, approvalDecisionSchema, captionUpdateSchema, contentFilterSchema } from "@reelflow/types";
import { requireUser } from "../http/auth";
import { sendFile } from "../http/files";
import { parse, uuidParam } from "../http/validate";

const uploadFieldsSchema = z.object({
  rightsStatus: z.enum(RIGHTS_STATUSES as unknown as [string, ...string[]]),
  attribution: z.string().max(300).optional(),
  caption: z.string().max(2200).optional(),
  sourceId: z.string().uuid().optional(),
});

export const contentRoutes =
  (core: Core): FastifyPluginAsync =>
  async (app) => {
    app.get("/content", async (req) => {
      requireUser(req, "content:read");
      return core.content.list(parse(contentFilterSchema, req.query));
    });

    app.get("/content/kanban", async (req) => {
      requireUser(req, "content:read");
      return core.content.kanban();
    });

    app.get("/content/:id", async (req) => {
      requireUser(req, "content:read");
      return core.content.get(uuidParam(req.params));
    });

    /** Everything the final preview needs: media, caption as it will be published, target posts. */
    app.get("/content/:id/preview", async (req) => {
      requireUser(req, "content:read");
      const id = uuidParam(req.params);
      const [item, caption] = await Promise.all([core.content.get(id), core.content.finalCaption(id)]);
      const posts = await Promise.all(
        item.scheduledPosts
          .filter((p) => ["SCHEDULED", "WAITING_APPROVAL", "READY", "PAUSED"].includes(p.status))
          .map(async (p) => ({ ...p, gate: await core.publishing.check(p.id) })),
      );
      return { item, caption, posts };
    });

    app.patch("/content/:id/caption", async (req) => core.content.updateCaption(uuidParam(req.params), parse(captionUpdateSchema, req.body), requireUser(req, "content:write")));

    app.post("/content/:id/decision", async (req) => {
      const body = parse(approvalDecisionSchema, req.body);
      return core.content.decide(uuidParam(req.params), body.decision, body.note, requireUser(req, "content:approve"));
    });

    app.post("/content/:id/process", async (req) => {
      const body = parse(z.object({ presetKey: z.string().optional(), watermarkPresetId: z.string().uuid().nullable().optional(), force: z.boolean().optional() }), req.body ?? {});
      return core.content.requestProcessing(uuidParam(req.params), body, requireUser(req, "content:write"));
    });

    app.post("/content/import-url", async (req, reply) => {
      const body = parse(
        z.object({ url: z.string().url().max(2048), sourceId: z.string().uuid().nullable().optional(), rightsStatus: z.enum(RIGHTS_STATUSES as unknown as [string, ...string[]]), attribution: z.string().max(300).optional(), caption: z.string().max(2200).optional() }),
        req.body,
      );
      const r = await core.content.importUrl(body as Parameters<Core["content"]["importUrl"]>[0], requireUser(req, "content:write"));
      return reply.code(202).send({ ingestionRequestId: r.id });
    });

    /**
     * Streaming upload: size-limited by multipart config, written to storage/incoming,
     * then verified by magic bytes. The client-supplied name/type are never trusted.
     */
    app.post("/content/upload", async (req, reply) => {
      const actor = requireUser(req, "content:upload");
      const part = await req.file();
      if (!part) throw new AppError("VALIDATION_FAILED", "No file uploaded");
      const fields = parse(
        uploadFieldsSchema,
        Object.fromEntries(Object.entries(part.fields).flatMap(([k, v]) => (v && !Array.isArray(v) && "value" in v ? [[k, v.value]] : []))),
      );
      const originalName = sanitizeFilename(part.filename || "upload");
      const incomingKey = core.storage.keyFor("incoming", `${randomUUID()}.bin`);
      await core.storage.write(incomingKey, part.file);
      const fullPath = core.storage.resolve(incomingKey);
      if (part.file.truncated) {
        await rm(fullPath, { force: true });
        throw new AppError("MEDIA_INVALID", "File exceeds the upload size limit");
      }
      const fh = await open(fullPath, "r");
      const head = Buffer.alloc(64);
      await fh.read(head, 0, 64, 0);
      await fh.close();
      const detected = detectMediaType(head);
      if (!detected) {
        await rm(fullPath, { force: true });
        throw new AppError("MEDIA_INVALID", "Unsupported file type — upload MP4/MOV/WebM video or JPEG/PNG/WebP images");
      }
      const req2 = await core.content.registerUpload(
        { incomingKey, originalName, rightsStatus: fields.rightsStatus as never, attribution: fields.attribution ?? null, caption: fields.caption ?? null, sourceId: fields.sourceId ?? null },
        actor,
      );
      return reply.code(202).send({ ingestionRequestId: req2.id, detected: detected.mime });
    });

    app.get("/ingestion/:id", async (req) => {
      requireUser(req, "content:read");
      const r = await core.db.ingestionRequest.findUnique({ where: { id: uuidParam(req.params) } });
      if (!r) throw new AppError("NOT_FOUND", "Ingestion request not found");
      return r;
    });

    app.get("/ingestion", async (req) => {
      requireUser(req, "content:read");
      return core.db.ingestionRequest.findMany({ orderBy: { createdAt: "desc" }, take: 100, include: { source: { select: { name: true } } } });
    });

    // ── Media files (authorised, range-enabled) ────────────────────────
    app.get("/media/thumbnail/:id", async (req, reply) => {
      requireUser(req, "content:read");
      const c = await core.db.content.findUnique({ where: { id: uuidParam(req.params) }, select: { thumbnailKey: true } });
      if (!c?.thumbnailKey) throw new AppError("NOT_FOUND", "No thumbnail");
      return sendFile(req, reply, core.storage.resolve(c.thumbnailKey), "image/jpeg");
    });

    app.get("/media/asset/:id", async (req, reply) => {
      requireUser(req, "content:read");
      const a = await core.db.mediaAsset.findUnique({ where: { id: uuidParam(req.params) } });
      if (!a) throw new AppError("NOT_FOUND", "Asset not found");
      return sendFile(req, reply, core.storage.resolve(a.storageKey), a.mime);
    });

    app.get("/media/original/:id", async (req, reply) => {
      requireUser(req, "content:read");
      const c = await core.db.content.findUnique({ where: { id: uuidParam(req.params) }, select: { originalKey: true, mediaType: true } });
      if (!c?.originalKey) throw new AppError("NOT_FOUND", "Original no longer stored");
      const mime = c.mediaType === "IMAGE" ? "image/jpeg" : c.originalKey.endsWith(".webm") ? "video/webm" : "video/mp4";
      return sendFile(req, reply, core.storage.resolve(c.originalKey), mime);
    });
  };
