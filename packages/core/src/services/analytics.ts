import type { Db } from "@reelflow/database";
import type { AppConfig } from "@reelflow/config";
import type { AdapterRegistry } from "@reelflow/platform-adapters";
import { DateTime } from "luxon";
import { createNetworkClient, type AccountsService } from "./accounts";
import type { SettingsService } from "./settings";

export class AnalyticsService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly settings: SettingsService,
    private readonly adapters: AdapterRegistry,
    private readonly accounts: AccountsService,
  ) {}

  async dashboard() {
    const s = await this.settings.get();
    const zone = s.general.timezone;
    const startOfDay = DateTime.now().setZone(zone).startOf("day").toJSDate();
    const since24h = new Date(Date.now() - 86_400_000);
    const [importedToday, processed, pendingApproval, scheduled, publishedToday, publishedTotal, failedPosts, failedJobs, nextPost, accounts] = await Promise.all([
      this.db.content.count({ where: { importedAt: { gte: startOfDay }, duplicateOfId: null } }),
      this.db.content.count({ where: { processingStatus: "READY" } }),
      this.db.content.count({ where: { approvalStatus: "PENDING", processingStatus: "READY", duplicateOfId: null } }),
      this.db.scheduledPost.count({ where: { status: { in: ["SCHEDULED", "WAITING_APPROVAL", "READY"] } } }),
      this.db.scheduledPost.count({ where: { status: "PUBLISHED", publishedAt: { gte: startOfDay } } }),
      this.db.scheduledPost.count({ where: { status: "PUBLISHED" } }),
      this.db.scheduledPost.count({ where: { status: "FAILED" } }),
      this.db.processingJob.count({ where: { status: "FAILED", createdAt: { gte: since24h } } }),
      this.db.scheduledPost.findFirst({
        where: { status: "SCHEDULED", scheduledAt: { gte: new Date() } },
        orderBy: { scheduledAt: "asc" },
        include: { content: { select: { id: true, thumbnailKey: true, source: { select: { name: true } } } }, account: { select: { name: true } } },
      }),
      this.db.publishingAccount.findMany({ select: { id: true, name: true, safetyState: true, status: true, pausedUntil: true, pauseReason: true } }),
    ]);
    return {
      counts: { importedToday, processed, pendingApproval, scheduled, publishedToday, publishedTotal, failedPosts, failedJobs },
      nextPost,
      safety: accounts,
      limits: await this.settings.limits(),
      ceilings: this.settings.ceilings(),
      autoPublishEnabled: s.publishing.autoPublishEnabled,
      approvalMode: s.approval.mode,
    };
  }

  /** Daily series over the last `days` days in the configured timezone. */
  async activity(days = 14) {
    const s = await this.settings.get();
    const tz = s.general.timezone;
    const since = DateTime.now().setZone(tz).minus({ days: days - 1 }).startOf("day").toJSDate();
    const [imports, published, failed] = await Promise.all([
      this.db.$queryRaw<{ day: string; n: bigint }[]>`
        SELECT to_char(("importedAt" AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day, count(*) AS n
        FROM contents WHERE "importedAt" >= ${since} AND "duplicateOfId" IS NULL GROUP BY 1`,
      this.db.$queryRaw<{ day: string; n: bigint }[]>`
        SELECT to_char(("publishedAt" AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day, count(*) AS n
        FROM scheduled_posts WHERE status = 'PUBLISHED' AND "publishedAt" >= ${since} GROUP BY 1`,
      this.db.$queryRaw<{ day: string; n: bigint }[]>`
        SELECT to_char(("startedAt" AT TIME ZONE ${tz})::date, 'YYYY-MM-DD') AS day, count(*) AS n
        FROM publish_attempts WHERE status = 'FAILED' AND "startedAt" >= ${since} GROUP BY 1`,
    ]);
    const index = (rows: { day: string; n: bigint }[]) => new Map(rows.map((r) => [r.day, Number(r.n)]));
    const [im, pu, fa] = [index(imports), index(published), index(failed)];
    const series = [];
    for (let i = 0; i < days; i++) {
      const day = DateTime.fromJSDate(since).setZone(tz).plus({ days: i }).toISODate()!;
      series.push({ day, imported: im.get(day) ?? 0, published: pu.get(day) ?? 0, failed: fa.get(day) ?? 0 });
    }
    return series;
  }

  async sourceContribution(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.db.$queryRaw<{ id: string; name: string; imported: bigint; published: bigint }[]>`
      SELECT s.id, s.name,
        (SELECT count(*) FROM contents c WHERE c."sourceId" = s.id AND c."importedAt" >= ${since} AND c."duplicateOfId" IS NULL) AS imported,
        (SELECT count(*) FROM scheduled_posts p JOIN contents c ON c.id = p."contentId"
          WHERE c."sourceId" = s.id AND p.status = 'PUBLISHED' AND p."publishedAt" >= ${since}) AS published
      FROM sources s WHERE s."deletedAt" IS NULL ORDER BY imported DESC LIMIT 20`;
    return rows.map((r) => ({ id: r.id, name: r.name, imported: Number(r.imported), published: Number(r.published) }));
  }

  async successRate(days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const grouped = await this.db.publishAttempt.groupBy({ by: ["status"], _count: { _all: true }, where: { startedAt: { gte: since } } });
    const ok = grouped.find((g) => g.status === "SUCCEEDED")?._count._all ?? 0;
    const failed = grouped.find((g) => g.status === "FAILED")?._count._all ?? 0;
    return { succeeded: ok, failed, rate: ok + failed === 0 ? null : ok / (ok + failed) };
  }

  /** Stores only metrics the platform returns; missing metrics stay missing. */
  async collectPlatformMetrics(): Promise<number> {
    const posts = await this.db.scheduledPost.findMany({
      where: { status: "PUBLISHED", externalPostId: { not: null }, publishedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } },
      include: { account: true },
      take: 100,
    });
    let stored = 0;
    const network = createNetworkClient(this.config);
    try {
      for (const p of posts) {
        const adapter = this.adapters.get(p.account.platform) as unknown as { getPostMetrics?: (c: unknown, id: string) => Promise<{ name: string; value: number }[]> };
        if (!adapter.getPostMetrics || !p.externalPostId) continue;
        const { accessToken } = await this.accounts.token(p.accountId);
        const metrics = await adapter.getPostMetrics({ externalAccountId: p.account.externalAccountId, accessToken, network }, p.externalPostId);
        for (const m of metrics) {
          await this.db.analyticsEvent.create({ data: { type: "platform_metric", contentId: p.contentId, accountId: p.accountId, value: m.value, metadata: { metric: m.name, postId: p.id } } });
          stored++;
        }
      }
    } finally {
      await network.close();
    }
    return stored;
  }
}
