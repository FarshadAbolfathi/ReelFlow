import type { Db, Prisma } from "@reelflow/database";
import { assertCan, normalizeUrl, validatePublicUrl } from "@reelflow/security";
import { AppError, QUEUES, jobIds, type SourceInput, type UserRole } from "@reelflow/types";
import type { AppConfig } from "@reelflow/config";
import type { Actor, AuditService } from "../infra/audit";
import type { QueueBus } from "../infra/queues";

export interface UserActor extends Actor {
  type: "USER" | "CLI";
  id: string | null;
  role: UserRole;
}

/** Platforms whose sources are fetched over the network and therefore need a URL. */
const URL_PLATFORMS = new Set(["INSTAGRAM", "GENERIC_FEED", "DIRECT_URL", "TIKTOK", "YOUTUBE", "FACEBOOK", "TELEGRAM"]);

/** Changing any of these on an approved source sends it back for owner review. */
const REVIEW_SENSITIVE_FIELDS = ["url", "platform", "rightsStatus"] as const;

export class SourcesService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
    private readonly queues: QueueBus,
  ) {}

  private normalize(input: SourceInput): { url: string | null; normalizedUrl: string | null } {
    if (!URL_PLATFORMS.has(input.platform)) return { url: null, normalizedUrl: null };
    if (!input.url) throw new AppError("VALIDATION_FAILED", "This platform requires a source URL");
    const url = validatePublicUrl(input.url).toString();
    return { url, normalizedUrl: normalizeUrl(url) };
  }

  async create(input: SourceInput, actor: UserActor) {
    assertCan(actor.role, "sources:propose");
    const { url, normalizedUrl } = this.normalize(input);
    if (normalizedUrl) {
      const dup = await this.db.source.findFirst({ where: { normalizedUrl, deletedAt: null } });
      if (dup) throw new AppError("CONFLICT", `A source with this URL already exists: ${dup.name}`, { details: { sourceId: dup.id } });
    }
    // Owners vet their own sources on creation; everyone else's wait for an owner.
    const ownerCreated = actor.role === "OWNER" || !this.config.policy.sourcesRequireOwnerApproval;
    const vetted = ownerCreated && input.rightsStatus !== "DO_NOT_IMPORT";
    const source = await this.db.source.create({
      data: {
        name: input.name,
        url,
        normalizedUrl,
        platform: input.platform,
        active: input.active,
        rightsStatus: input.rightsStatus,
        rightsEvidence: input.rightsEvidence ?? null,
        approvalRequired: input.approvalRequired,
        attributionRequired: input.attributionRequired,
        attributionText: input.attributionText ?? null,
        notes: input.notes ?? null,
        createdById: actor.id,
        vettingStatus: vetted ? "APPROVED" : "PENDING_REVIEW",
        vettedById: vetted ? actor.id : null,
        vettedAt: vetted ? new Date() : null,
        config: {
          create: {
            allowedMediaTypes: input.allowedMediaTypes,
            importFrequencyMinutes: input.importFrequencyMinutes,
            maxItemsPerInterval: input.maxItemsPerInterval,
          },
        },
      },
      include: { config: true },
    });
    await this.audit.log("source_created", actor, `Source "${source.name}" created (${source.vettingStatus})`, { type: "source", id: source.id }, {
      platform: source.platform,
      rightsStatus: source.rightsStatus,
    });
    return source;
  }

  async update(id: string, input: SourceInput, actor: UserActor) {
    assertCan(actor.role, "sources:edit");
    const existing = await this.get(id);
    const { url, normalizedUrl } = this.normalize(input);
    const sensitiveChanged = REVIEW_SENSITIVE_FIELDS.some((f) =>
      f === "url" ? (normalizedUrl ?? null) !== (existing.normalizedUrl ?? null) : (input as Record<string, unknown>)[f] !== (existing as Record<string, unknown>)[f],
    );
    const resetVetting = sensitiveChanged && actor.role !== "OWNER" && this.config.policy.sourcesRequireOwnerApproval;
    const source = await this.db.source.update({
      where: { id },
      data: {
        name: input.name,
        url,
        normalizedUrl,
        platform: input.platform,
        active: input.active,
        rightsStatus: input.rightsStatus,
        rightsEvidence: input.rightsEvidence ?? null,
        approvalRequired: input.approvalRequired,
        attributionRequired: input.attributionRequired,
        attributionText: input.attributionText ?? null,
        notes: input.notes ?? null,
        ...(resetVetting ? { vettingStatus: "PENDING_REVIEW" as const, vettedById: null, vettedAt: null } : {}),
        ...(input.rightsStatus === "DO_NOT_IMPORT" ? { active: false } : {}),
        config: {
          upsert: {
            create: { allowedMediaTypes: input.allowedMediaTypes, importFrequencyMinutes: input.importFrequencyMinutes, maxItemsPerInterval: input.maxItemsPerInterval },
            update: { allowedMediaTypes: input.allowedMediaTypes, importFrequencyMinutes: input.importFrequencyMinutes, maxItemsPerInterval: input.maxItemsPerInterval },
          },
        },
      },
      include: { config: true },
    });
    await this.audit.log(
      "source_updated",
      actor,
      `Source "${source.name}" updated${resetVetting ? " — returned to owner review" : ""}`,
      { type: "source", id },
      { resetVetting },
    );
    return source;
  }

  /** OWNER-only: approve or reject a source. */
  async review(id: string, decision: "APPROVED" | "REJECTED", note: string | undefined, actor: UserActor) {
    assertCan(actor.role, "sources:review");
    const existing = await this.get(id);
    if (decision === "APPROVED" && existing.rightsStatus === "DO_NOT_IMPORT")
      throw new AppError("RIGHTS_NOT_CONFIRMED", "A source marked 'do not import' cannot be approved");
    const source = await this.db.source.update({
      where: { id },
      data: { vettingStatus: decision, vettedById: actor.id, vettedAt: new Date(), vettingNote: note ?? null, ...(decision === "REJECTED" ? { active: false } : {}) },
    });
    await this.audit.log("source_reviewed", actor, `Source "${source.name}" ${decision.toLowerCase()}`, { type: "source", id }, { note });
    return source;
  }

  async remove(id: string, actor: UserActor) {
    assertCan(actor.role, "sources:delete");
    const s = await this.db.source.update({ where: { id }, data: { deletedAt: new Date(), active: false } });
    await this.audit.log("source_deleted", actor, `Source "${s.name}" deleted`, { type: "source", id });
  }

  async get(id: string) {
    const s = await this.db.source.findFirst({ where: { id, deletedAt: null }, include: { config: true } });
    if (!s) throw new AppError("NOT_FOUND", "Source not found");
    return s;
  }

  async list(filter: { vettingStatus?: string; platform?: string; q?: string } = {}) {
    const where: Prisma.SourceWhereInput = {
      deletedAt: null,
      ...(filter.vettingStatus ? { vettingStatus: filter.vettingStatus as never } : {}),
      ...(filter.platform ? { platform: filter.platform as never } : {}),
      ...(filter.q ? { OR: [{ name: { contains: filter.q, mode: "insensitive" } }, { url: { contains: filter.q, mode: "insensitive" } }] } : {}),
    };
    const sources = await this.db.source.findMany({ where, include: { config: true }, orderBy: { createdAt: "desc" } });
    const counts = await this.db.content.groupBy({ by: ["sourceId"], _count: { _all: true }, where: { sourceId: { in: sources.map((s) => s.id) } } });
    const byId = new Map(counts.map((c) => [c.sourceId, c._count._all]));
    return sources.map((s) => ({ ...s, contentCount: byId.get(s.id) ?? 0 }));
  }

  /**
   * Guard used by every import path (API, scheduler, CLI) — and again by the Python
   * engine — so unvetted or forbidden sources are never fetched.
   */
  static assertImportable(s: { active: boolean; vettingStatus: string; rightsStatus: string; deletedAt: Date | null }): void {
    if (s.deletedAt) throw new AppError("NOT_FOUND", "Source was deleted");
    if (s.vettingStatus !== "APPROVED") throw new AppError("SOURCE_NOT_APPROVED", "The owner has not approved this source yet");
    if (s.rightsStatus === "DO_NOT_IMPORT") throw new AppError("RIGHTS_NOT_CONFIRMED", "Source is marked 'do not import'");
    if (!s.active) throw new AppError("SOURCE_NOT_APPROVED", "Source is inactive");
  }

  async requestDiscovery(id: string, actor: Actor & { role?: UserRole }, trigger: "user" | "schedule" | "cli") {
    if (actor.role) assertCan(actor.role, "content:write");
    const s = await this.get(id);
    SourcesService.assertImportable(s);
    const bucket = trigger === "schedule" ? new Date().toISOString().slice(0, 13) : String(Date.now());
    const jobId = await this.queues.add(QUEUES.contentDiscovery, { sourceId: id, triggeredBy: trigger, requestedByUserId: actor.id ?? undefined }, {
      jobId: jobIds.discovery(id, bucket),
    });
    await this.audit.log("discovery_requested", actor, `Discovery requested for "${s.name}"`, { type: "source", id }, { jobId, trigger });
    return { jobId };
  }

  /** Called by the scheduler tick: enqueue discovery for sources whose interval elapsed. */
  async enqueueDueDiscoveries(now = new Date()): Promise<number> {
    const sources = await this.db.source.findMany({
      where: { deletedAt: null, active: true, vettingStatus: "APPROVED", rightsStatus: { not: "DO_NOT_IMPORT" }, platform: { in: ["GENERIC_FEED", "INSTAGRAM", "LOCAL"] } },
      include: { config: true },
    });
    let n = 0;
    for (const s of sources) {
      const every = (s.config?.importFrequencyMinutes ?? 360) * 60_000;
      if (s.lastDiscoveryAt && now.getTime() - s.lastDiscoveryAt.getTime() < every) continue;
      const bucket = String(Math.floor(now.getTime() / every));
      await this.queues.add(QUEUES.contentDiscovery, { sourceId: s.id, triggeredBy: "schedule" }, { jobId: jobIds.discovery(s.id, bucket) });
      n++;
    }
    return n;
  }
}
