import { randomUUID } from "node:crypto";
import type { Db, Prisma } from "@reelflow/database";
import { assertCan, normalizeUrl, validatePublicUrl } from "@reelflow/security";
import { PRESETS, isPresetKey, settingsHash, type PresetKey } from "@reelflow/media";
import {
  AppError,
  PUBLISHABLE_RIGHTS,
  QUEUES,
  jobIds,
  watermarkConfigSchema,
  type RightsStatus,
  type Settings,
  type WatermarkConfig,
} from "@reelflow/types";
import { SYSTEM, type Actor, type AuditService } from "../infra/audit";
import type { QueueBus } from "../infra/queues";
import type { StorageService } from "../infra/storage";
import type { SettingsService } from "./settings";
import { SourcesService, type UserActor } from "./sources";
import { buildFinalCaption } from "./captions";

export interface ContentFilter {
  page: number;
  pageSize: number;
  sourceId?: string;
  mediaType?: string;
  processingStatus?: string;
  approvalStatus?: string;
  publishStatus?: string;
  rightsStatus?: string;
  q?: string;
  from?: string;
  to?: string;
  includeDuplicates?: boolean;
}

/** BigInt is not JSON-serialisable; the API always returns content through this. */
export function serializeContent<T extends { fileSize?: bigint | null }>(c: T): Omit<T, "fileSize"> & { fileSize: number | null } {
  return { ...c, fileSize: c.fileSize === null || c.fileSize === undefined ? null : Number(c.fileSize) };
}

export class ContentService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly queues: QueueBus,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
  ) {}

  async list(f: ContentFilter) {
    const q = f.q?.trim();
    const where: Prisma.ContentWhereInput = {
      ...(f.includeDuplicates ? {} : { duplicateOfId: null }),
      ...(f.sourceId ? { sourceId: f.sourceId } : {}),
      ...(f.mediaType ? { mediaType: f.mediaType as never } : {}),
      ...(f.processingStatus ? { processingStatus: f.processingStatus as never } : {}),
      ...(f.approvalStatus ? { approvalStatus: f.approvalStatus as never } : {}),
      ...(f.publishStatus ? { publishStatus: f.publishStatus as never } : {}),
      ...(f.rightsStatus ? { rightsStatus: f.rightsStatus as never } : {}),
      ...(f.from || f.to ? { importedAt: { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(f.to) } : {}) } } : {}),
      ...(q
        ? {
            OR: [
              { originalCaption: { contains: q, mode: "insensitive" } },
              { customCaption: { contains: q, mode: "insensitive" } },
              { originalUrl: { contains: q, mode: "insensitive" } },
              { author: { contains: q, mode: "insensitive" } },
              { source: { name: { contains: q, mode: "insensitive" } } },
              { hashtags: { has: q.replace(/^#/, "") } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.db.content.findMany({
        where,
        include: { source: { select: { id: true, name: true, platform: true } }, scheduledPosts: { where: { status: { notIn: ["CANCELLED"] } }, orderBy: { scheduledAt: "asc" }, take: 1 } },
        orderBy: { importedAt: "desc" },
        skip: (f.page - 1) * f.pageSize,
        take: f.pageSize,
      }),
      this.db.content.count({ where }),
    ]);
    return { items: items.map(serializeContent), total, page: f.page, pageSize: f.pageSize };
  }

  async get(id: string) {
    const c = await this.db.content.findUnique({
      where: { id },
      include: {
        source: true,
        assets: { orderBy: { createdAt: "desc" } },
        scheduledPosts: { orderBy: { scheduledAt: "desc" }, include: { account: { select: { id: true, name: true, username: true } } } },
        duplicateOf: { select: { id: true, originalUrl: true, importedAt: true } },
        duplicates: { select: { id: true, originalUrl: true, importedAt: true } },
        captionTemplate: true,
      },
    });
    if (!c) throw new AppError("NOT_FOUND", "Content not found");
    // Duplicates never get their own content row; they are recorded on the ingest.
    const duplicateIngests = await this.db.ingestionRequest.findMany({
      where: { duplicateOfId: id },
      select: { id: true, url: true, createdAt: true, errorMessage: true },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return {
      ...serializeContent(c),
      duplicateIngests,
      assets: c.assets.map((a) => ({ ...a, fileSize: a.fileSize === null ? null : Number(a.fileSize) })),
    };
  }

  /** Final caption as it would be published now (used by preview and scheduling). */
  async finalCaption(contentId: string): Promise<string> {
    const c = await this.db.content.findUnique({ where: { id: contentId }, include: { source: true, captionTemplate: true } });
    if (!c) throw new AppError("NOT_FOUND", "Content not found");
    const s = await this.settings.get();
    const template = c.captionTemplate ?? (await this.db.captionTemplate.findFirst({ where: { isDefault: true } }));
    return buildFinalCaption({
      customCaption: c.customCaption,
      template,
      thirdParty: c.rightsStatus !== "USER_OWNS",
      inputs: {
        source: c.source?.name ?? null,
        originalCaption: c.originalCaption,
        hashtags: c.hashtags,
        cta: c.cta,
        brand: s.general.brandName,
        attribution: attributionFor(c),
        timezone: s.general.timezone,
        locale: s.general.locale,
      },
    });
  }

  async updateCaption(
    id: string,
    patch: { customCaption?: string | null; captionTemplateId?: string | null; hashtags?: string[]; mentions?: string[]; cta?: string | null; attribution?: string | null },
    actor: UserActor,
  ) {
    assertCan(actor.role, "content:write");
    const c = await this.db.content.update({ where: { id }, data: patch });
    // Unpublished posts re-render their caption at publish time.
    await this.db.scheduledPost.updateMany({
      where: { contentId: id, status: { in: ["WAITING_APPROVAL", "READY", "SCHEDULED", "PAUSED"] } },
      data: { finalCaption: null },
    });
    await this.audit.log("caption_updated", actor, "Caption updated", { type: "content", id });
    return serializeContent(c);
  }

  async decide(id: string, decision: "APPROVED" | "REJECTED", note: string | undefined, actor: UserActor) {
    assertCan(actor.role, "content:approve");
    const c = await this.db.content.findUnique({ where: { id }, include: { source: true } });
    if (!c) throw new AppError("NOT_FOUND", "Content not found");
    if (decision === "APPROVED") {
      if (c.duplicateOfId) throw new AppError("DUPLICATE_CONTENT", "Duplicates cannot be approved; approve the original");
      if (c.rightsStatus === "DO_NOT_IMPORT") throw new AppError("RIGHTS_NOT_CONFIRMED", "Content is marked 'do not import'");
      if (c.source && c.source.vettingStatus !== "APPROVED") throw new AppError("SOURCE_NOT_APPROVED", "The source has not been approved by the owner");
    }
    const updated = await this.db.content.update({
      where: { id },
      data: { approvalStatus: decision, approvedById: actor.id, approvedAt: new Date(), approvalNote: note ?? null },
    });
    // Posts waiting on approval become schedulable (or are cancelled on rejection).
    if (decision === "APPROVED") {
      await this.db.scheduledPost.updateMany({ where: { contentId: id, status: "WAITING_APPROVAL" }, data: { status: "SCHEDULED" } });
    } else {
      await this.db.scheduledPost.updateMany({
        where: { contentId: id, status: { in: ["WAITING_APPROVAL", "SCHEDULED", "READY", "PAUSED"] } },
        data: { status: "CANCELLED", dedupeKey: null },
      });
    }
    await this.audit.log(decision === "APPROVED" ? "content_approved" : "content_rejected", actor, `Content ${decision.toLowerCase()}`, { type: "content", id }, { note });
    return serializeContent(updated);
  }

  /**
   * Automatic approval after processing, according to the approval mode.
   * AUTO approves only if the source is owner-vetted, does not demand manual approval,
   * and rights are confirmed. Everything automatic is audit-logged.
   */
  async evaluateAutoApproval(id: string): Promise<"APPROVED" | "PENDING"> {
    const c = await this.db.content.findUnique({ where: { id }, include: { source: true } });
    if (!c) throw new AppError("NOT_FOUND", "Content not found");
    if (c.approvalStatus !== "PENDING" || c.duplicateOfId) return c.approvalStatus === "APPROVED" ? "APPROVED" : "PENDING";
    const s: Settings = await this.settings.get();
    const reasons: string[] = [];
    if (s.approval.mode !== "AUTO") reasons.push(`approval mode is ${s.approval.mode}`);
    if (c.source?.approvalRequired) reasons.push("source requires manual approval");
    if (c.source && c.source.vettingStatus !== "APPROVED") reasons.push("source not owner-approved");
    if (!PUBLISHABLE_RIGHTS.includes(c.rightsStatus as RightsStatus)) reasons.push(`rights are ${c.rightsStatus}`);
    if (c.processingStatus !== "READY") reasons.push("processing not finished");
    if (reasons.length) {
      await this.audit.log("content_imported", SYSTEM, `Waiting for approval: ${reasons.join("; ")}`, { type: "content", id });
      return "PENDING";
    }
    await this.db.content.update({ where: { id }, data: { approvalStatus: "APPROVED", approvedAt: new Date(), approvalNote: "Auto-approved (AUTO mode)" } });
    await this.audit.log("content_approved", SYSTEM, "Auto-approved (AUTO mode, vetted source, confirmed rights)", { type: "content", id });
    return "APPROVED";
  }

  /** Registers an uploaded file (already written to storage/incoming) for ingestion by the Python engine. */
  async registerUpload(p: { incomingKey: string; originalName: string; rightsStatus: RightsStatus; attribution?: string | null; caption?: string | null; sourceId?: string | null }, actor: UserActor) {
    assertCan(actor.role, "content:upload");
    if (p.rightsStatus === "DO_NOT_IMPORT") throw new AppError("RIGHTS_NOT_CONFIRMED", "Cannot import content marked 'do not import'");
    if (p.sourceId) SourcesService.assertImportable(await this.db.source.findUniqueOrThrow({ where: { id: p.sourceId } }));
    const req = await this.db.ingestionRequest.create({
      data: {
        kind: "LOCAL_FILE",
        sourceId: p.sourceId ?? null,
        localKey: p.incomingKey,
        requestedById: actor.id,
        metadata: { originalName: p.originalName, rightsStatus: p.rightsStatus, attribution: p.attribution ?? null, caption: p.caption ?? null },
      },
    });
    await this.queues.add(QUEUES.mediaDownload, { ingestionRequestId: req.id }, { jobId: jobIds.download(req.id) });
    return req;
  }

  /** Imports a directly supplied, permitted media URL (SSRF-validated here and again in Python). */
  async importUrl(p: { url: string; sourceId?: string | null; rightsStatus: RightsStatus; attribution?: string | null; caption?: string | null }, actor: UserActor) {
    assertCan(actor.role, "content:write");
    if (p.rightsStatus === "UNKNOWN" || p.rightsStatus === "DO_NOT_IMPORT")
      throw new AppError("RIGHTS_NOT_CONFIRMED", "Confirm you have the right to use this media before importing it");
    const url = validatePublicUrl(p.url).toString();
    if (p.sourceId) SourcesService.assertImportable(await this.db.source.findUniqueOrThrow({ where: { id: p.sourceId } }));
    const normalizedUrl = normalizeUrl(url);
    const existing = await this.db.content.findFirst({ where: { normalizedUrl } });
    if (existing) throw new AppError("DUPLICATE_CONTENT", "This URL was already imported", { details: { contentId: existing.id } });
    const req = await this.db.ingestionRequest.create({
      data: {
        kind: "DIRECT_URL",
        sourceId: p.sourceId ?? null,
        url,
        normalizedUrl,
        requestedById: actor.id,
        metadata: { rightsStatus: p.rightsStatus, attribution: p.attribution ?? null, caption: p.caption ?? null },
      },
    });
    await this.queues.add(QUEUES.mediaDownload, { ingestionRequestId: req.id }, { jobId: jobIds.download(req.id) });
    return req;
  }

  async resolveWatermark(watermarkPresetId: string | null | undefined): Promise<{ id: string; config: WatermarkConfig } | null> {
    const s = await this.settings.get();
    const id = watermarkPresetId === undefined ? s.media.defaultWatermarkPresetId : watermarkPresetId;
    const preset = id
      ? await this.db.watermarkPreset.findUnique({ where: { id } })
      : watermarkPresetId === null
        ? null
        : await this.db.watermarkPreset.findFirst({ where: { isDefault: true } });
    if (!preset) return null;
    return { id: preset.id, config: watermarkConfigSchema.parse(preset.config) };
  }

  /** Enqueues processing; the job id embeds the settings hash so identical requests collapse. */
  async requestProcessing(contentId: string, opts: { presetKey?: string; watermarkPresetId?: string | null; force?: boolean }, actor: Actor & { role?: UserActor["role"] }) {
    if (actor.role) assertCan(actor.role, "content:write");
    const s = await this.settings.get();
    const presetKey = (opts.presetKey ?? s.media.defaultPreset) as PresetKey;
    if (!isPresetKey(presetKey)) throw new AppError("VALIDATION_FAILED", `Unknown preset ${presetKey}`);
    const wm = await this.resolveWatermark(opts.watermarkPresetId);
    const hash = settingsHash({ presetKey, watermark: wm?.config ?? null, normalizeAudio: s.media.normalizeAudio });
    const jobId = jobIds.processing(contentId, presetKey, opts.force ? `${hash}-${randomUUID().slice(0, 8)}` : hash);
    await this.queues.add(QUEUES.mediaProcessing, { contentId, presetKey, watermarkPresetId: wm?.id ?? null, force: !!opts.force }, { jobId });
    return { jobId, presetKey, settingsHash: hash, preset: PRESETS[presetKey].label };
  }

  /** Grouped by pipeline stage for the Kanban view. */
  async kanban() {
    const select = { id: true, mediaType: true, durationSec: true, thumbnailKey: true, originalCaption: true, importedAt: true, source: { select: { name: true } } } as const;
    const take = 50;
    const [processing, waiting, approved, scheduled, published, failed] = await Promise.all([
      this.db.content.findMany({ where: { duplicateOfId: null, processingStatus: { in: ["PENDING", "PROCESSING"] } }, select, take, orderBy: { importedAt: "desc" } }),
      this.db.content.findMany({ where: { duplicateOfId: null, processingStatus: "READY", approvalStatus: "PENDING" }, select, take, orderBy: { importedAt: "desc" } }),
      this.db.content.findMany({ where: { duplicateOfId: null, approvalStatus: "APPROVED", publishStatus: "UNSCHEDULED" }, select, take, orderBy: { importedAt: "desc" } }),
      this.db.content.findMany({ where: { publishStatus: "SCHEDULED" }, select, take, orderBy: { importedAt: "desc" } }),
      this.db.content.findMany({ where: { publishStatus: "PUBLISHED" }, select, take, orderBy: { importedAt: "desc" } }),
      this.db.content.findMany({ where: { OR: [{ processingStatus: "FAILED" }, { publishStatus: "FAILED" }] }, select, take, orderBy: { importedAt: "desc" } }),
    ]);
    return { processing, waiting, approved, scheduled, published, failed };
  }

  storageKeyPath(key: string): string {
    return this.storage.resolve(key);
  }
}

/**
 * Attribution line for third-party content: explicit per-content override →
 * explicit per-source setting. Never derived from the original page's own
 * handle (`c.author`) — captions never credit the source account, only
 * whatever this operator has explicitly configured.
 */
export function attributionFor(c: { attribution: string | null; author: string | null; source?: { attributionText: string | null; name: string } | null }): string | null {
  if (c.attribution?.trim()) return c.attribution.trim();
  if (c.source?.attributionText?.trim()) return c.source.attributionText.trim();
  return null;
}
