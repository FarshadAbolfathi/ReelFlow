import type { Db } from "@reelflow/database";
import { WORKER, type AuditService, type NotificationService } from "../infra/audit";
import type { StorageService } from "../infra/storage";
import { ACTIVE_POST_STATUSES } from "./scheduling";
import type { SettingsService } from "./settings";

export interface CleanupReport {
  dryRun: boolean;
  originals: string[];
  processed: string[];
  failedJobs: number;
  freeBytes: number | null;
}

/**
 * Retention-based cleanup. Never deletes media referenced by an active
 * scheduled post (waiting, scheduled, paused, publishing).
 */
export class CleanupService {
  constructor(
    private readonly db: Db,
    private readonly storage: StorageService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
  ) {}

  async run(dryRun = false): Promise<CleanupReport> {
    const s = (await this.settings.get()).storage;
    const days = (n: number) => new Date(Date.now() - n * 86_400_000);
    const activeContent = { scheduledPosts: { none: { status: { in: ACTIVE_POST_STATUSES } } } };

    const oldOriginals = await this.db.content.findMany({
      where: { originalKey: { not: null }, importedAt: { lt: days(s.originalsRetentionDays) }, ...activeContent },
      select: { id: true, originalKey: true, processingStatus: true },
      take: 500,
    });
    // Keep originals whose processed version is not ready yet — they are still needed.
    const originals = oldOriginals.filter((c) => c.processingStatus === "READY" || c.processingStatus === "FAILED");

    const oldAssets = await this.db.mediaAsset.findMany({
      where: { kind: { in: ["PROCESSED", "PREVIEW"] }, createdAt: { lt: days(s.processedRetentionDays) }, content: activeContent },
      select: { id: true, storageKey: true },
      take: 500,
    });

    const failedJobs = await this.db.processingJob.count({ where: { status: "FAILED", createdAt: { lt: days(s.failedRetentionDays) } } });

    if (!dryRun) {
      for (const c of originals) {
        await this.storage.remove(c.originalKey!);
        await this.db.content.update({ where: { id: c.id }, data: { originalKey: null } });
      }
      for (const a of oldAssets) {
        await this.storage.remove(a.storageKey);
        await this.db.mediaAsset.delete({ where: { id: a.id } });
      }
      await this.db.processingJob.deleteMany({ where: { status: "FAILED", createdAt: { lt: days(s.failedRetentionDays) } } });
      await this.audit.log("cleanup_run", WORKER, `Cleanup removed ${originals.length} originals, ${oldAssets.length} processed files, ${failedJobs} failed job records`);
    }

    const freeBytes = await this.storage.freeBytes();
    if (freeBytes !== null && freeBytes < s.warnFreeSpaceGb * 1024 ** 3) {
      await this.notifications.notify({ level: "WARNING", type: "storage_warning", title: "Low disk space", body: `${(freeBytes / 1024 ** 3).toFixed(1)} GB free in storage` });
    }
    return { dryRun, originals: originals.map((c) => c.originalKey!), processed: oldAssets.map((a) => a.storageKey), failedJobs, freeBytes };
  }
}
