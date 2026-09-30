import type { Db, Prisma } from "@reelflow/database";
import { allocate, exceedsRollingWindow, generateSlots, isValidTimezone, type WeeklyPlan } from "@reelflow/scheduler";
import { assertCan } from "@reelflow/security";
import { AppError, PUBLISHABLE_RIGHTS, scheduleInputSchema, type ContentKind, type PostStatus, type ScheduleInput } from "@reelflow/types";
import { DateTime } from "luxon";
import { SYSTEM, type Actor, type AuditService } from "../infra/audit";
import type { ContentService } from "./content";
import type { SettingsService } from "./settings";
import type { UserActor } from "./sources";

/** Statuses that occupy a calendar slot and count toward limits. */
export const ACTIVE_POST_STATUSES: PostStatus[] = ["WAITING_APPROVAL", "READY", "SCHEDULED", "PROCESSING", "PUBLISHING", "PAUSED"];
const MIN_LEAD_MS = 2 * 60_000;

export class SchedulingService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly content: ContentService,
  ) {}

  // ── Schedules ────────────────────────────────────────────────────────
  async upsertSchedule(id: string | null, raw: ScheduleInput, actor: UserActor) {
    assertCan(actor.role, "schedule:write");
    const input = scheduleInputSchema.parse(raw);
    if (!isValidTimezone(input.timezone)) throw new AppError("VALIDATION_FAILED", `Unknown timezone ${input.timezone}`);
    const limits = await this.settings.limits();
    if (input.postsPerDay > limits.maxPostsPerDay)
      throw new AppError("POLICY_LIMIT_EXCEEDED", `postsPerDay ${input.postsPerDay} exceeds the limit of ${limits.maxPostsPerDay}`);
    if (input.minIntervalMinutes < limits.minPostIntervalMinutes)
      throw new AppError("POLICY_LIMIT_EXCEEDED", `minIntervalMinutes must be at least ${limits.minPostIntervalMinutes}`);
    const data = {
      name: input.name,
      accountId: input.accountId,
      timezone: input.timezone,
      active: input.active,
      postsPerDay: input.postsPerDay,
      minIntervalMinutes: input.minIntervalMinutes,
      maxIntervalMinutes: input.maxIntervalMinutes,
      config: { days: input.days, sourceWeights: input.sourceWeights, contentKindWeights: input.contentKindWeights } as Prisma.InputJsonValue,
    };
    const schedule = id ? await this.db.schedule.update({ where: { id }, data }) : await this.db.schedule.create({ data });
    await this.audit.log("schedule_changed", actor, `Schedule "${schedule.name}" saved`, { type: "schedule", id: schedule.id });
    return schedule;
  }

  listSchedules() {
    return this.db.schedule.findMany({ include: { account: { select: { id: true, name: true, username: true } } }, orderBy: { createdAt: "asc" } });
  }

  async deleteSchedule(id: string, actor: UserActor) {
    assertCan(actor.role, "schedule:write");
    await this.db.schedule.delete({ where: { id } });
    await this.audit.log("schedule_changed", actor, "Schedule deleted", { type: "schedule", id });
  }

  // ── Limit checks shared by manual scheduling and rescheduling ────────
  private async assertSlotAllowed(accountId: string, at: Date, sourceId: string | null, excludePostId?: string) {
    if (at.getTime() < Date.now() + MIN_LEAD_MS) throw new AppError("VALIDATION_FAILED", "Scheduled time must be at least 2 minutes in the future");
    const limits = await this.settings.limits();
    const s = await this.settings.get();
    const account = await this.db.publishingAccount.findUniqueOrThrow({ where: { id: accountId } });
    const dayLimit = Math.min(limits.maxPostsPerDay, account.dailyLimit ?? Number.POSITIVE_INFINITY);
    const zone = s.general.timezone;
    const day = DateTime.fromJSDate(at).setZone(zone);
    const around = await this.db.scheduledPost.findMany({
      where: {
        accountId,
        id: excludePostId ? { not: excludePostId } : undefined,
        OR: [{ status: { in: ACTIVE_POST_STATUSES } }, { status: "PUBLISHED" }],
        scheduledAt: { gte: day.startOf("day").minus({ hours: 1 }).toJSDate(), lte: day.endOf("day").plus({ hours: 1 }).toJSDate() },
      },
      select: { scheduledAt: true, content: { select: { sourceId: true } } },
    });
    const sameDay = around.filter((p) => DateTime.fromJSDate(p.scheduledAt).setZone(zone).hasSame(day, "day"));
    const problems: string[] = [];
    if (sameDay.length >= dayLimit) problems.push(`${sameDay.length}/${dayLimit} posts already on ${day.toISODate()}`);
    if (exceedsRollingWindow(around.map((p) => p.scheduledAt.getTime()), at.getTime(), 3_600_000, limits.maxPostsPerHour))
      problems.push(`more than ${limits.maxPostsPerHour} post(s) within an hour`);
    const close = around.find((p) => Math.abs(p.scheduledAt.getTime() - at.getTime()) < limits.minPostIntervalMinutes * 60_000);
    if (close) problems.push(`less than ${limits.minPostIntervalMinutes} min from another post`);
    if (sourceId && sameDay.filter((p) => p.content.sourceId === sourceId).length >= limits.maxPostsPerSourcePerDay)
      problems.push(`per-source limit of ${limits.maxPostsPerSourcePerDay}/day reached`);
    if (problems.length) throw new AppError("POLICY_LIMIT_EXCEEDED", `Cannot schedule here: ${problems.join("; ")}`, { details: { problems } });
  }

  async schedulePost(p: { contentId: string; accountId: string; kind: ContentKind; scheduledAt?: string }, actor: UserActor) {
    assertCan(actor.role, "schedule:write");
    const c = await this.db.content.findUnique({ where: { id: p.contentId }, include: { source: true } });
    if (!c) throw new AppError("NOT_FOUND", "Content not found");
    if (c.duplicateOfId) throw new AppError("DUPLICATE_CONTENT", "Schedule the original item, not the duplicate");
    if (c.rightsStatus === "DO_NOT_IMPORT") throw new AppError("RIGHTS_NOT_CONFIRMED", "Content is marked 'do not import'");
    if (c.source && c.source.vettingStatus !== "APPROVED") throw new AppError("SOURCE_NOT_APPROVED", "The owner has not approved this source");
    const account = await this.db.publishingAccount.findUnique({ where: { id: p.accountId } });
    if (!account || account.status !== "CONNECTED") throw new AppError("VALIDATION_FAILED", "Account is not connected");

    const at = p.scheduledAt ? new Date(p.scheduledAt) : await this.nextFreeSlot(p.accountId, c.sourceId);
    if (!at) throw new AppError("VALIDATION_FAILED", "No free slot in the next 14 days — pick a time or add an active schedule");
    await this.assertSlotAllowed(p.accountId, at, c.sourceId);

    try {
      const post = await this.db.scheduledPost.create({
        data: {
          contentId: c.id,
          accountId: p.accountId,
          kind: p.kind,
          scheduledAt: at,
          status: c.approvalStatus === "APPROVED" ? "SCHEDULED" : "WAITING_APPROVAL",
          dedupeKey: `${c.id}:${p.accountId}`,
          finalCaption: await this.content.finalCaption(c.id),
          createdById: actor.id,
        },
      });
      await this.db.content.update({ where: { id: c.id }, data: { publishStatus: "SCHEDULED" } });
      await this.audit.log("post_scheduled", actor, `Scheduled for ${at.toISOString()}`, { type: "post", id: post.id }, { contentId: c.id, accountId: p.accountId });
      return post;
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw new AppError("CONFLICT", "This content is already scheduled or published on this account");
      throw e;
    }
  }

  async reschedule(postId: string, scheduledAt: string, actor: UserActor) {
    assertCan(actor.role, "queue:control");
    const post = await this.db.scheduledPost.findUniqueOrThrow({ where: { id: postId }, include: { content: true } });
    if (!["SCHEDULED", "WAITING_APPROVAL", "PAUSED", "FAILED", "READY"].includes(post.status))
      throw new AppError("CONFLICT", `A ${post.status.toLowerCase()} post cannot be rescheduled`);
    const at = new Date(scheduledAt);
    await this.assertSlotAllowed(post.accountId, at, post.content.sourceId, post.id);
    const updated = await this.db.scheduledPost.update({ where: { id: postId }, data: { scheduledAt: at, nextAttemptAt: null } });
    await this.audit.log("post_rescheduled", actor, `Rescheduled to ${at.toISOString()}`, { type: "post", id: postId }, { from: post.scheduledAt });
    return updated;
  }

  private async setStatus(postId: string, from: PostStatus[], to: PostStatus, action: "post_cancelled" | "post_paused" | "post_resumed" | "post_retried", actor: Actor, extra: Prisma.ScheduledPostUpdateInput = {}) {
    const post = await this.db.scheduledPost.findUniqueOrThrow({ where: { id: postId } });
    if (!from.includes(post.status)) throw new AppError("CONFLICT", `Cannot change a ${post.status.toLowerCase()} post to ${to.toLowerCase()}`);
    const updated = await this.db.scheduledPost.update({ where: { id: postId }, data: { status: to, ...extra } });
    await this.refreshPublishStatus(post.contentId);
    await this.audit.log(action, actor, `Post ${to.toLowerCase()}`, { type: "post", id: postId });
    return updated;
  }

  cancel(postId: string, actor: UserActor) {
    assertCan(actor.role, "queue:control");
    return this.setStatus(postId, ["WAITING_APPROVAL", "READY", "SCHEDULED", "PAUSED", "FAILED"], "CANCELLED", "post_cancelled", actor, { dedupeKey: null });
  }

  pause(postId: string, actor: UserActor) {
    assertCan(actor.role, "queue:control");
    return this.setStatus(postId, ["SCHEDULED", "READY", "WAITING_APPROVAL"], "PAUSED", "post_paused", actor);
  }

  async resume(postId: string, actor: UserActor) {
    assertCan(actor.role, "queue:control");
    const post = await this.db.scheduledPost.findUniqueOrThrow({ where: { id: postId }, include: { content: true } });
    return this.setStatus(postId, ["PAUSED"], post.content.approvalStatus === "APPROVED" ? "SCHEDULED" : "WAITING_APPROVAL", "post_resumed", actor);
  }

  async retry(postId: string, actor: UserActor) {
    assertCan(actor.role, "queue:control");
    const post = await this.db.scheduledPost.findUniqueOrThrow({ where: { id: postId } });
    const at = post.scheduledAt.getTime() < Date.now() ? new Date(Date.now() + MIN_LEAD_MS) : post.scheduledAt;
    return this.setStatus(postId, ["FAILED"], "SCHEDULED", "post_retried", actor, { scheduledAt: at, nextAttemptAt: null, lastErrorCode: null, lastErrorMessage: null });
  }

  async refreshPublishStatus(contentId: string) {
    const posts = await this.db.scheduledPost.findMany({ where: { contentId }, select: { status: true } });
    const status = posts.some((p) => p.status === "PUBLISHED")
      ? "PUBLISHED"
      : posts.some((p) => ACTIVE_POST_STATUSES.includes(p.status))
        ? "SCHEDULED"
        : posts.some((p) => p.status === "FAILED")
          ? "FAILED"
          : "UNSCHEDULED";
    await this.db.content.update({ where: { id: contentId }, data: { publishStatus: status } });
  }

  // ── Queue & calendar views ───────────────────────────────────────────
  async queue(filter: { status?: PostStatus; accountId?: string; from?: Date; to?: Date; take?: number }) {
    return this.db.scheduledPost.findMany({
      where: {
        ...(filter.status ? { status: filter.status } : {}),
        ...(filter.accountId ? { accountId: filter.accountId } : {}),
        ...(filter.from || filter.to ? { scheduledAt: { ...(filter.from ? { gte: filter.from } : {}), ...(filter.to ? { lte: filter.to } : {}) } } : {}),
      },
      include: {
        content: { select: { id: true, thumbnailKey: true, mediaType: true, durationSec: true, originalCaption: true, approvalStatus: true, source: { select: { id: true, name: true } } } },
        account: { select: { id: true, name: true, username: true, safetyState: true } },
      },
      orderBy: { scheduledAt: "asc" },
      take: filter.take ?? 500,
    });
  }

  // ── Auto-fill ────────────────────────────────────────────────────────
  private plan(schedule: { timezone: string; postsPerDay: number; minIntervalMinutes: number; config: unknown }): WeeklyPlan & { sourceWeights: Record<string, number> } {
    const cfg = schedule.config as { days?: WeeklyPlan["days"]; sourceWeights?: Record<string, number> };
    return { timezone: schedule.timezone, postsPerDay: schedule.postsPerDay, minIntervalMinutes: schedule.minIntervalMinutes, days: cfg.days ?? {}, sourceWeights: cfg.sourceWeights ?? {} };
  }

  async nextFreeSlot(accountId: string, sourceId: string | null): Promise<Date | null> {
    const schedule = await this.db.schedule.findFirst({ where: { accountId, active: true } });
    if (!schedule) return null;
    const plan = this.plan(schedule);
    const limits = await this.settings.limits();
    const from = new Date(Date.now() + 10 * 60_000);
    const to = new Date(Date.now() + 14 * 86_400_000);
    const existing = await this.existingPosts(accountId, from, to);
    const [first] = allocate({
      slots: generateSlots(plan, from, to),
      candidates: [{ contentId: "probe", sourceId, kind: "REEL" }],
      existing,
      limits: { ...limits, maxPostsPerDay: Math.min(limits.maxPostsPerDay, plan.postsPerDay) },
      timezone: plan.timezone,
    });
    return first?.scheduledAt ?? null;
  }

  private async existingPosts(accountId: string, from: Date, to: Date) {
    const posts = await this.db.scheduledPost.findMany({
      where: {
        accountId,
        OR: [
          { status: { in: ACTIVE_POST_STATUSES }, scheduledAt: { gte: new Date(from.getTime() - 86_400_000), lte: to } },
          { status: "PUBLISHED", publishedAt: { gte: new Date(from.getTime() - 86_400_000) } },
        ],
      },
      select: { scheduledAt: true, publishedAt: true, content: { select: { sourceId: true } } },
    });
    return posts.map((p) => ({ scheduledAt: p.publishedAt ?? p.scheduledAt, sourceId: p.content.sourceId }));
  }

  /**
   * Fills upcoming slots of a schedule with approved, ready content.
   * Posts created by the periodic tick are marked autoScheduled — the publish gate
   * only lets those through when auto-publish is enabled in settings.
   */
  async autoFill(scheduleId: string, opts: { horizonDays?: number; actor?: Actor & { role?: UserActor["role"] } } = {}) {
    const actor = opts.actor ?? SYSTEM;
    if (opts.actor?.role) assertCan(opts.actor.role, "schedule:write");
    const s = await this.settings.get();
    const schedule = await this.db.schedule.findUniqueOrThrow({ where: { id: scheduleId }, include: { account: true } });
    if (!schedule.active || schedule.account.status !== "CONNECTED") return { created: 0 };
    const autoScheduled = actor.type === "SYSTEM" || actor.type === "WORKER";
    if (autoScheduled && (!s.publishing.autoPublishEnabled || s.approval.mode === "MANUAL")) return { created: 0 };

    const plan = this.plan(schedule);
    const limits = await this.settings.limits();
    const from = new Date(Date.now() + 10 * 60_000);
    const to = new Date(Date.now() + (opts.horizonDays ?? 3) * 86_400_000);
    const candidates = await this.db.content.findMany({
      where: {
        approvalStatus: "APPROVED",
        processingStatus: "READY",
        duplicateOfId: null,
        rightsStatus: { in: [...PUBLISHABLE_RIGHTS] },
        OR: [{ sourceId: null }, { source: { vettingStatus: "APPROVED", active: true, deletedAt: null } }],
        scheduledPosts: { none: { accountId: schedule.accountId, status: { notIn: ["CANCELLED"] } } },
      },
      select: { id: true, sourceId: true, kind: true },
      orderBy: { importedAt: "asc" },
      take: 200,
    });
    const allocations = allocate({
      slots: generateSlots(plan, from, to),
      candidates: candidates.map((c) => ({ contentId: c.id, sourceId: c.sourceId, kind: c.kind })),
      existing: await this.existingPosts(schedule.accountId, from, to),
      limits: { ...limits, maxPostsPerDay: Math.min(limits.maxPostsPerDay, plan.postsPerDay, schedule.account.dailyLimit ?? Infinity) },
      timezone: plan.timezone,
      sourceWeights: plan.sourceWeights,
    });

    let created = 0;
    for (const a of allocations) {
      try {
        const post = await this.db.scheduledPost.create({
          data: {
            contentId: a.contentId,
            accountId: schedule.accountId,
            scheduleId: schedule.id,
            kind: candidates.find((c) => c.id === a.contentId)?.kind ?? "REEL",
            scheduledAt: a.scheduledAt,
            status: "SCHEDULED",
            dedupeKey: `${a.contentId}:${schedule.accountId}`,
            finalCaption: await this.content.finalCaption(a.contentId),
            autoScheduled,
            createdById: actor.id ?? null,
          },
        });
        await this.db.content.update({ where: { id: a.contentId }, data: { publishStatus: "SCHEDULED" } });
        await this.audit.log("post_scheduled", actor, `${autoScheduled ? "Auto-scheduled" : "Scheduled"} for ${a.scheduledAt.toISOString()} by "${schedule.name}"`, { type: "post", id: post.id }, { contentId: a.contentId });
        created++;
      } catch (e) {
        if ((e as { code?: string }).code !== "P2002") throw e; // raced with another fill — idempotent skip
      }
    }
    return { created };
  }
}
