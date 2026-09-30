import path from "node:path";
import type { Db } from "@reelflow/database";
import { PRESETS, generatePreview, generateThumbnail, isPresetKey, probeMedia, processMedia, settingsHash } from "@reelflow/media";
import { AppError, QUEUES, jobIds, toAppError, type ProcessingJob } from "@reelflow/types";
import { sha256File } from "../util/hash";
import { WORKER, type AuditService, type NotificationService } from "../infra/audit";
import type { QueueBus } from "../infra/queues";
import type { StorageService } from "../infra/storage";
import type { ContentService } from "./content";
import type { SettingsService } from "./settings";

export interface ProcessingOutcome {
  contentId: string;
  assetId: string;
  skipped: boolean;
  streamCopied: boolean;
}

export class ProcessingService {
  constructor(
    private readonly db: Db,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly queues: QueueBus,
    private readonly content: ContentService,
    private readonly settings: SettingsService,
  ) {}

  async process(job: ProcessingJob): Promise<ProcessingOutcome> {
    if (!isPresetKey(job.presetKey)) throw new AppError("VALIDATION_FAILED", `Unknown preset ${job.presetKey}`);
    const c = await this.db.content.findUnique({ where: { id: job.contentId } });
    if (!c) throw new AppError("NOT_FOUND", "Content not found");
    if (c.duplicateOfId) throw new AppError("DUPLICATE_CONTENT", "Duplicates are not processed");
    if (!c.originalKey) throw new AppError("MEDIA_INVALID", "Content has no original file");

    const s = await this.settings.get();
    const wm = job.watermarkPresetId ? await this.content.resolveWatermark(job.watermarkPresetId) : null;
    const options = { presetKey: job.presetKey, watermark: wm?.config ?? null, normalizeAudio: s.media.normalizeAudio };
    const hash = settingsHash(options);

    // Idempotency: identical settings → re-use the existing asset.
    const existing = await this.db.mediaAsset.findUnique({
      where: { contentId_kind_presetKey_settingsHash: { contentId: c.id, kind: "PROCESSED", presetKey: job.presetKey, settingsHash: hash } },
    });
    if (existing && !job.force && (await this.storage.exists(existing.storageKey))) {
      if (c.processingStatus !== "READY") await this.db.content.update({ where: { id: c.id }, data: { processingStatus: "READY" } });
      return { contentId: c.id, assetId: existing.id, skipped: true, streamCopied: false };
    }

    await this.db.content.update({ where: { id: c.id }, data: { processingStatus: "PROCESSING", lastError: null, lastErrorCode: null } });
    try {
      const input = this.storage.resolve(c.originalKey);
      const meta = await probeMedia(input);
      const ext = meta.mediaType === "IMAGE" ? "jpg" : "mp4";
      const outKey = this.storage.keyFor("processed", `${c.id}-${job.presetKey.toLowerCase()}-${hash}.${ext}`);
      const outPath = this.storage.resolve(outKey);
      const result = await processMedia({
        input,
        outputPath: outPath,
        workDir: path.join(this.storage.root, "processed", ".work"),
        assetsRoot: this.storage.root,
        options,
        meta,
      });

      const asset = await this.db.mediaAsset.upsert({
        where: { contentId_kind_presetKey_settingsHash: { contentId: c.id, kind: "PROCESSED", presetKey: job.presetKey, settingsHash: hash } },
        update: { storageKey: outKey, fileSize: BigInt(result.meta.fileSize), checksum: await sha256File(outPath), createdAt: new Date() },
        create: {
          contentId: c.id,
          kind: "PROCESSED",
          presetKey: job.presetKey,
          settingsHash: hash,
          storageKey: outKey,
          mime: meta.mediaType === "IMAGE" ? "image/jpeg" : "video/mp4",
          width: result.meta.width,
          height: result.meta.height,
          durationSec: result.meta.durationSec,
          fileSize: BigInt(result.meta.fileSize),
          checksum: await sha256File(outPath),
          watermarkPresetId: wm?.id ?? null,
        },
      });

      let thumbnailKey = c.thumbnailKey;
      if (!thumbnailKey || !(await this.storage.exists(thumbnailKey))) {
        thumbnailKey = this.storage.keyFor("thumbnails", `${c.id}.jpg`);
        await generateThumbnail(input, this.storage.resolve(thumbnailKey), meta);
      }
      if (meta.mediaType === "VIDEO") {
        const previewKey = this.storage.keyFor("previews", `${c.id}-${hash}.mp4`);
        await generatePreview(outPath, this.storage.resolve(previewKey));
        await this.db.mediaAsset.upsert({
          where: { contentId_kind_presetKey_settingsHash: { contentId: c.id, kind: "PREVIEW", presetKey: job.presetKey, settingsHash: hash } },
          update: { storageKey: previewKey },
          create: { contentId: c.id, kind: "PREVIEW", presetKey: job.presetKey, settingsHash: hash, storageKey: previewKey, mime: "video/mp4" },
        });
      }

      await this.db.content.update({ where: { id: c.id }, data: { processingStatus: "READY", thumbnailKey } });
      await this.audit.log("content_processed", WORKER, `Processed for ${PRESETS[job.presetKey].label}${result.streamCopied ? " (stream copy)" : ""}`, { type: "content", id: c.id }, {
        assetId: asset.id,
        settingsHash: hash,
      });
      if (wm) await this.audit.log("watermark_applied", WORKER, `Watermark preset applied`, { type: "content", id: c.id }, { watermarkPresetId: wm.id });
      await this.queues.add(QUEUES.approval, { contentId: c.id }, { jobId: jobIds.approval(c.id) });
      return { contentId: c.id, assetId: asset.id, skipped: false, streamCopied: result.streamCopied };
    } catch (e) {
      const err = toAppError(e, "PROCESSING_FAILED");
      await this.db.content.update({ where: { id: c.id }, data: { processingStatus: "FAILED", lastErrorCode: err.code, lastError: err.message.slice(0, 1000) } });
      await this.audit.log("processing_failed", WORKER, `Processing failed: ${err.message.slice(0, 200)}`, { type: "content", id: c.id }, { code: err.code });
      await this.notifications.notify({ level: "ERROR", type: "processing_failed", title: "Processing failed", body: err.message.slice(0, 300), entity: { type: "content", id: c.id } });
      throw err;
    }
  }

  /** The processed asset used for publishing (latest READY one for the preset). */
  async publishableAsset(contentId: string, presetKey?: string) {
    return this.db.mediaAsset.findFirst({
      where: { contentId, kind: "PROCESSED", ...(presetKey ? { presetKey } : {}) },
      orderBy: { createdAt: "desc" },
    });
  }
}
