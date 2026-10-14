import type { Db } from "@reelflow/database";
import type { AppConfig } from "@reelflow/config";
import type { AdapterRegistry, PublishingAdapter, PlatformContext } from "@reelflow/platform-adapters";
import { computeBackoffMs, evaluatePublishGate, type GateResult } from "@reelflow/scheduler";
import { assertCan } from "@reelflow/security";
import { AppError, QUEUES, jobIds, toAppError, type ErrorCode } from "@reelflow/types";
import { WORKER, type AuditService, type NotificationService } from "../infra/audit";
import type { QueueBus } from "../infra/queues";
import type { StorageService } from "../infra/storage";
import { createNetworkClient, type AccountsService } from "./accounts";
import { attributionFor, type ContentService } from "./content";
import type { ProcessingService } from "./processing";
import type { SchedulingService } from "./scheduling";
import type { SettingsService } from "./settings";
import type { UserActor } from "./sources";

/** Errors caused by the account/platform (count toward the safety monitor). */
const ACCOUNT_FAULTS: ReadonlySet<ErrorCode> = new Set(["RATE_LIMITED", "AUTH_EXPIRED", "PUBLISH_FAILED"]);
const RETRYABLE: ReadonlySet<ErrorCode> = new Set(["RATE_LIMITED", "PUBLISH_FAILED", "NETWORK_UNAVAILABLE"]);

export interface PublishOutcome {
  postId: string;
  result: "published" | "deferred" | "blocked" | "failed" | "retry" | "skipped";
  detail?: string;
}

export class PublishingService {
  /** Poll interval/timeout for container processing on the platform. */
  pollIntervalMs = 5_000;
  pollTimeoutMs = 15 * 60_000;

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly adapters: AdapterRegistry,
    private readonly accounts: AccountsService,
    private readonly content: ContentService,
    private readonly processing: ProcessingService,
    private readonly scheduling: SchedulingService,
    private readonly settings: SettingsService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly queues: QueueBus,
  ) {}

  /** Scheduler tick: enqueue posts that are due. The jobId makes re-enqueueing a no-op. */
  async dispatchDue(now = new Date()): Promise<number> {
    const due = await this.db.scheduledPost.findMany({
      where: { status: "SCHEDULED", scheduledAt: { lte: now }, OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      select: { id: true, retryCount: true, nextAttemptAt: true },
      orderBy: { scheduledAt: "asc" },
      take: 50,
    });
    for (const p of due) {
      const attemptKey = p.nextAttemptAt ? `${p.retryCount}-${p.nextAttemptAt.getTime()}` : String(p.retryCount);
      await this.queues.add(QUEUES.publishing, { scheduledPostId: p.id }, { jobId: jobIds.publishing(p.id, attemptKey) });
    }
    return due.length;
  }

  /**
   * Manual override: publish a queued post right now instead of waiting for its
   * scheduled time. Skips the scheduling ceilings used when *placing* a slot
   * (`assertSlotAllowed`) — this is an explicit one-off action, not a new slot —
   * but the real-time policy gate in `publish()` (rate limits, account health,
   * rights, approval) still applies, so it can still come back "blocked".
   */
  async publishNow(postId: string, actor: UserActor): Promise<void> {
    assertCan(actor.role, "queue:control");
    const post = await this.db.scheduledPost.findUniqueOrThrow({ where: { id: postId } });
    if (!["SCHEDULED", "PAUSED", "FAILED"].includes(post.status)) {
      throw new AppError("CONFLICT", `A ${post.status.toLowerCase()} post cannot be published now`);
    }
    await this.db.scheduledPost.update({ where: { id: postId }, data: { status: "SCHEDULED", scheduledAt: new Date(), nextAttemptAt: null } });
    await this.audit.log("post_publish_now", actor, "Publish requested immediately (manual override)", { type: "post", id: postId });
    // Must be unique per call: BullMQ remembers a jobId forever (even once
    // completed), so a fixed id would make every click after the first a
    // silent no-op. The status check above (fresh DB read) is what actually
    // guards against a genuine double-submit.
    await this.queues.add(QUEUES.publishing, { scheduledPostId: postId }, { jobId: jobIds.publishing(postId, `manual-${Date.now()}`) });
  }

  private async gate(postId: string): Promise<{ result: GateResult; caption: string }> {
    const post = await this.db.scheduledPost.findUniqueOrThrow({ where: { id: postId }, include: { content: { include: { source: true } }, account: true } });
    const s = await this.settings.get();
    const limits = await this.settings.limits();
    const since = new Date(Date.now() - 24 * 3_600_000);
    const recent = await this.db.scheduledPost.findMany({
      where: { accountId: post.accountId, id: { not: post.id }, OR: [{ status: "PUBLISHED", publishedAt: { gte: since } }, { status: "PUBLISHING" }] },
      select: { publishedAt: true, updatedAt: true, content: { select: { sourceId: true } } },
    });
    const asset = await this.processing.publishableAsset(post.contentId);
    const caption = post.finalCaption ?? (await this.content.finalCaption(post.contentId));
    const result = evaluatePublishGate({
      now: new Date(),
      settings: {
        approvalMode: s.approval.mode,
        autoPublishEnabled: s.publishing.autoPublishEnabled,
        blockUnknownRights: s.safety.blockUnknownRights,
        requireAttributionForThirdParty: s.publishing.requireAttributionForThirdParty,
      },
      limits,
      account: { status: post.account.status, safetyState: post.account.safetyState, pausedUntil: post.account.pausedUntil, dailyLimit: post.account.dailyLimit },
      content: {
        processingStatus: post.content.processingStatus,
        approvalStatus: post.content.approvalStatus,
        rightsStatus: post.content.rightsStatus,
        isDuplicate: !!post.content.duplicateOfId,
        hasPublishableAsset: !!asset,
      },
      source: post.content.source
        ? { active: post.content.source.active && !post.content.source.deletedAt, vettingStatus: post.content.source.vettingStatus, attributionRequired: post.content.source.attributionRequired }
        : null,
      post: { autoScheduled: post.autoScheduled, caption, attributionText: attributionFor(post.content) },
      recentPublishes: recent.map((r) => r.publishedAt ?? r.updatedAt),
      recentSourcePublishes: post.content.sourceId ? recent.filter((r) => r.content.sourceId === post.content.sourceId).length : 0,
    });
    return { result, caption };
  }

  /** Dry-run for the preview screen: would this post be allowed right now? */
  async check(postId: string) {
    return (await this.gate(postId)).result;
  }

  async publish(postId: string): Promise<PublishOutcome> {
    const post = await this.db.scheduledPost.findUnique({ where: { id: postId }, include: { account: true, content: true } });
    if (!post) return { postId, result: "skipped", detail: "post not found" };
    if (post.status === "PUBLISHED" || post.externalPostId) return { postId, result: "skipped", detail: "already published" };
    if (!["SCHEDULED", "READY", "PUBLISHING"].includes(post.status)) return { postId, result: "skipped", detail: `status ${post.status}` };
    if (post.scheduledAt.getTime() > Date.now() + 60_000) return { postId, result: "skipped", detail: "not due yet" };

    // 1. Policy gate — re-evaluated immediately before publishing.
    const { result: gate, caption } = await this.gate(postId);
    if (!gate.allowed) return this.handleBlocked(post.id, post.contentId, gate);

    // 2. Mark in-flight and record the attempt.
    const attemptNo = post.retryCount + 1;
    await this.db.scheduledPost.update({ where: { id: post.id }, data: { status: "PUBLISHING", finalCaption: caption } });
    const attempt = await this.db.publishAttempt.upsert({
      where: { scheduledPostId_attempt: { scheduledPostId: post.id, attempt: attemptNo } },
      update: { status: "RUNNING", startedAt: new Date() },
      create: { scheduledPostId: post.id, accountId: post.accountId, attempt: attemptNo, status: "RUNNING" },
    });

    const network = createNetworkClient(this.config);
    let step = "gate";
    try {
      const adapter: PublishingAdapter = this.adapters.get(post.account.platform);
      const asset = await this.processing.publishableAsset(post.contentId);
      if (!asset) throw new AppError("PROCESSING_FAILED", "No processed media");
      step = "network";
      // Session-mode publishing never touches this client — the Python engine owns
      // its own (independently live-managed) proxy and fails closed on its own.
      // Checking this static, Node-side proxy config here would be a stale, unrelated
      // gate that can block a publish for a proxy the adapter never actually uses.
      if (this.config.publishingAdapterMode !== "session") await network.assertAvailable(); // fail closed in proxy mode
      const { accessToken } = await this.accounts.token(post.accountId);
      const ctx: PlatformContext = { externalAccountId: post.account.externalAccountId, accessToken, network, jobId: attempt.id };

      step = "validate";
      const issues = adapter.validateMedia(
        {
          mediaType: post.content.mediaType,
          durationSec: asset.durationSec,
          width: asset.width ?? 0,
          height: asset.height ?? 0,
          fps: null,
          videoCodec: asset.mime === "video/mp4" ? "h264" : null,
          audioCodec: asset.mime === "video/mp4" ? "aac" : null,
          audioSampleRate: null,
          fileSize: Number(asset.fileSize ?? 0),
          mime: asset.mime,
        },
        post.kind,
      );
      if (issues.length) throw new AppError("MEDIA_INVALID", issues.map((i) => i.message).join("; "));

      step = "create";
      const { containerId } = await adapter.createPost(ctx, {
        kind: post.kind,
        mediaType: post.content.mediaType,
        filePath: this.storage.resolve(asset.storageKey),
        fileSize: Number(asset.fileSize ?? 0),
        caption,
        existingContainerId: post.containerId,
      });
      await this.db.scheduledPost.update({ where: { id: post.id }, data: { containerId } });
      await this.db.publishAttempt.update({ where: { id: attempt.id }, data: { containerId, step } });

      step = "status";
      const deadline = Date.now() + this.pollTimeoutMs;
      for (;;) {
        const st = await adapter.getStatus(ctx, containerId);
        if (st.state === "FINISHED") break;
        if (st.state === "PUBLISHED") {
          // A previous attempt published but crashed before recording it: never publish twice.
          return this.markPublished(post.id, post.contentId, post.accountId, attempt.id, null, null, "container already published");
        }
        if (st.state === "ERROR") throw new AppError("MEDIA_INVALID", `Platform rejected the media: ${st.detail ?? "processing error"}`);
        if (st.state === "EXPIRED") {
          await this.db.scheduledPost.update({ where: { id: post.id }, data: { containerId: null } });
          throw new AppError("PUBLISH_FAILED", "Media container expired before publishing");
        }
        if (Date.now() > deadline) throw new AppError("PUBLISH_FAILED", "Timed out waiting for the platform to process the media");
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      }

      step = "publish";
      const published = await adapter.publishPost(ctx, containerId);
      return this.markPublished(post.id, post.contentId, post.accountId, attempt.id, published.externalPostId, published.permalink);
    } catch (e) {
      return this.handleFailure(post.id, post.contentId, post.accountId, attempt.id, attemptNo, step, toAppError(e, "PUBLISH_FAILED"));
    } finally {
      await network.close();
    }
  }

  private async markPublished(postId: string, contentId: string, accountId: string, attemptId: string, externalPostId: string | null, permalink: string | null, note?: string): Promise<PublishOutcome> {
    const now = new Date();
    await this.db.scheduledPost.update({
      where: { id: postId },
      data: { status: "PUBLISHED", publishedAt: now, externalPostId, permalink, lastErrorCode: null, lastErrorMessage: note ?? null, nextAttemptAt: null },
    });
    await this.db.publishAttempt.update({ where: { id: attemptId }, data: { status: "SUCCEEDED", finishedAt: now, externalPostId, step: "publish" } });
    await this.scheduling.refreshPublishStatus(contentId);
    await this.accounts.recordSafetyEvent(accountId, { type: "success" });
    await this.db.analyticsEvent.create({ data: { type: "post_published", contentId, accountId } });
    await this.audit.log("post_published", WORKER, `Published${permalink ? ` → ${permalink}` : ""}${note ? ` (${note})` : ""}`, { type: "post", id: postId }, { externalPostId });
    if ((await this.settings.get()).notifications.onPublishSuccess)
      await this.notifications.notify({ level: "SUCCESS", type: "publish_success", title: "Post published", body: permalink ?? "Published successfully", entity: { type: "post", id: postId } });
    return { postId, result: "published", detail: externalPostId ?? note ?? undefined };
  }

  private async handleBlocked(postId: string, contentId: string, gate: GateResult): Promise<PublishOutcome> {
    const reasons = gate.violations.map((v) => v.message).join("; ");
    const post = await this.db.scheduledPost.findUniqueOrThrow({ where: { id: postId } });
    if (gate.retryAt) {
      await this.db.scheduledPost.update({ where: { id: postId }, data: { nextAttemptAt: gate.retryAt, lastErrorCode: gate.violations[0]!.code, lastErrorMessage: reasons } });
      if (post.lastErrorMessage !== reasons) await this.audit.log("post_blocked", WORKER, `Deferred until ${gate.retryAt.toISOString()}: ${reasons}`, { type: "post", id: postId });
      return { postId, result: "deferred", detail: reasons };
    }
    const waitingApproval = gate.violations.every((v) => v.code === "APPROVAL_REQUIRED");
    const pendingContent = (await this.db.content.findUniqueOrThrow({ where: { id: contentId } })).approvalStatus === "PENDING";
    const status = waitingApproval && pendingContent ? "WAITING_APPROVAL" : "PAUSED";
    await this.db.scheduledPost.update({ where: { id: postId }, data: { status, lastErrorCode: gate.violations[0]!.code, lastErrorMessage: reasons } });
    await this.audit.log("post_blocked", WORKER, `Not published (${status.toLowerCase()}): ${reasons}`, { type: "post", id: postId }, { violations: gate.violations });
    await this.notifications.notify({ level: "WARNING", type: "publish_blocked", title: "Post held back", body: reasons.slice(0, 300), entity: { type: "post", id: postId } });
    return { postId, result: "blocked", detail: reasons };
  }

  private async handleFailure(postId: string, contentId: string, accountId: string, attemptId: string, attemptNo: number, step: string, err: AppError): Promise<PublishOutcome> {
    const s = await this.settings.get();
    const rateLimited = err.code === "RATE_LIMITED";
    await this.db.publishAttempt.update({
      where: { id: attemptId },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        step,
        errorCode: err.code,
        errorMessage: err.message.slice(0, 2000),
        rateLimited,
        retryAfterSec: err.retryAfterMs ? Math.round(err.retryAfterMs / 1000) : null,
        httpStatus: (err.details?.httpStatus as number | undefined) ?? null,
      },
    });
    let pausedUntil: Date | null = null;
    if (ACCOUNT_FAULTS.has(err.code)) {
      const snap = await this.accounts.recordSafetyEvent(accountId, { type: "failure", code: err.code, retryAfterMs: err.retryAfterMs ?? null });
      pausedUntil = snap.pausedUntil;
    }
    await this.db.analyticsEvent.create({ data: { type: "post_failed", contentId, accountId, metadata: { code: err.code } } });

    const canRetry = RETRYABLE.has(err.code) && attemptNo <= s.safety.maxPublishRetries;
    if (canRetry) {
      const backoff = computeBackoffMs(attemptNo, { baseMs: s.safety.baseBackoffMinutes * 60_000, maxMs: s.safety.maxBackoffMinutes * 60_000 });
      const next = new Date(Math.max(Date.now() + backoff, pausedUntil?.getTime() ?? 0, Date.now() + (err.retryAfterMs ?? 0)));
      await this.db.scheduledPost.update({
        where: { id: postId },
        data: { status: "SCHEDULED", retryCount: attemptNo, nextAttemptAt: next, lastErrorCode: err.code, lastErrorMessage: err.message.slice(0, 1000) },
      });
      await this.audit.log("post_failed", WORKER, `Attempt ${attemptNo} failed at ${step} (${err.code}); retry at ${next.toISOString()}`, { type: "post", id: postId }, { code: err.code });
      return { postId, result: "retry", detail: `${err.code} → retry at ${next.toISOString()}` };
    }
    await this.db.scheduledPost.update({
      where: { id: postId },
      data: { status: "FAILED", retryCount: attemptNo, lastErrorCode: err.code, lastErrorMessage: err.message.slice(0, 1000), nextAttemptAt: null },
    });
    await this.scheduling.refreshPublishStatus(contentId);
    await this.audit.log("post_failed", WORKER, `Publishing failed at ${step}: ${err.message.slice(0, 200)}`, { type: "post", id: postId }, { code: err.code });
    if (s.notifications.onPublishFailure)
      await this.notifications.notify({ level: "ERROR", type: "publish_failed", title: "Publishing failed", body: `${err.code}: ${err.message.slice(0, 250)}`, entity: { type: "post", id: postId } });
    return { postId, result: "failed", detail: err.code };
  }
}
