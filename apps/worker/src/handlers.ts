import type { Job } from "bullmq";
import { sweepUnprocessed } from "./bridge";
import type { Core } from "@reelflow/core";
import {
  QUEUES,
  type AnalyticsJob,
  type ApprovalJob,
  type CleanupJob,
  type ProcessingJob,
  type PublishingJob,
  type QueueName,
  type ThumbnailJob,
  type WatermarkJob,
} from "@reelflow/types";

export type Handler = (job: Job) => Promise<unknown>;

/**
 * One handler per queue. Each is idempotent: running the same job twice
 * re-uses existing assets/containers instead of duplicating work.
 */
export function createHandlers(core: Core): Partial<Record<QueueName, Handler>> {
  const ref = (job: Job, queue: QueueName, extra: Record<string, unknown> = {}) => ({
    queue,
    bullJobId: job.id ?? null,
    retryCount: job.attemptsMade,
    input: job.data as Record<string, unknown>,
    ...extra,
  });

  return {
    [QUEUES.mediaProcessing]: (job) => {
      const d = job.data as ProcessingJob;
      return core.jobs.run(ref(job, QUEUES.mediaProcessing, { contentId: d.contentId }), () => core.processing.process(d), (r) => ({ ...r }));
    },

    // Re-watermarking = reprocessing with a different preset; same idempotent pipeline.
    [QUEUES.watermark]: (job) => {
      const d = job.data as WatermarkJob;
      return core.jobs.run(ref(job, QUEUES.watermark, { contentId: d.contentId }), () =>
        core.processing.process({ contentId: d.contentId, presetKey: d.presetKey, watermarkPresetId: d.watermarkPresetId }),
      );
    },

    [QUEUES.thumbnail]: (job) => {
      const d = job.data as ThumbnailJob;
      return core.jobs.run(ref(job, QUEUES.thumbnail, { contentId: d.contentId }), async () => {
        const s = await core.settings.get();
        return core.content.requestProcessing(d.contentId, { presetKey: s.media.defaultPreset }, { type: "WORKER" });
      });
    },

    [QUEUES.approval]: (job) => {
      const d = job.data as ApprovalJob;
      return core.jobs.run(ref(job, QUEUES.approval, { contentId: d.contentId }), async () => ({ decision: await core.content.evaluateAutoApproval(d.contentId) }), (r) => r);
    },

    [QUEUES.publishing]: async (job) => {
      const d = job.data as PublishingJob;
      const post = await core.db.scheduledPost.findUnique({ where: { id: d.scheduledPostId }, select: { accountId: true, contentId: true } });
      return core.jobs.run(
        ref(job, QUEUES.publishing, { scheduledPostId: d.scheduledPostId, accountId: post?.accountId, contentId: post?.contentId, networkMode: core.config.network.mode === "proxy" ? "PROXY" : "DIRECT" }),
        () => core.publishing.publish(d.scheduledPostId),
        (r) => ({ ...r, skipped: r.result === "skipped" }),
      );
    },

    [QUEUES.analytics]: (job) => {
      const d = job.data as AnalyticsJob;
      return core.jobs.run(ref(job, QUEUES.analytics), async () => (d.kind === "platform-metrics" ? { stored: await core.analytics.collectPlatformMetrics() } : { ok: true }), (r) => r);
    },

    [QUEUES.cleanup]: (job) => {
      const d = job.data as CleanupJob;
      return core.jobs.run(ref(job, QUEUES.cleanup), () => core.cleanup.run(!!d.dryRun), (r) => ({ originals: r.originals.length, processed: r.processed.length, failedJobs: r.failedJobs }));
    },

    [QUEUES.schedulerTick]: (job) => core.jobs.run(ref(job, QUEUES.schedulerTick), () => tick(core, new Date(job.timestamp)), (r) => r),
  };
}

/** Runs every minute. Each step is independently safe to repeat. */
export async function tick(core: Core, now: Date): Promise<Record<string, number>> {
  const released = await core.accounts.releaseExpiredPauses(now);
  const discoveries = await core.sources.enqueueDueDiscoveries(now);
  let autoScheduled = 0;
  // Auto-fill hourly, and only when enabled (autoFill itself re-checks settings).
  if (now.getUTCMinutes() === 0) {
    const schedules = await core.db.schedule.findMany({ where: { active: true }, select: { id: true } });
    for (const s of schedules) autoScheduled += (await core.scheduling.autoFill(s.id)).created;
    await core.auth.purgeExpiredSessions();
  }
  const recovered = now.getUTCMinutes() % 5 === 0 ? await sweepUnprocessed(core) : 0;
  const dispatched = await core.publishing.dispatchDue(now);
  return { released, discoveries, autoScheduled, recovered, dispatched };
}
