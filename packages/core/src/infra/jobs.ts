import type { Db, Prisma } from "@reelflow/database";
import { toAppError, type QueueName } from "@reelflow/types";

export interface JobRef {
  queue: QueueName;
  bullJobId?: string | null;
  contentId?: string | null;
  accountId?: string | null;
  sourceId?: string | null;
  scheduledPostId?: string | null;
  retryCount?: number;
  input?: Record<string, unknown>;
  networkMode?: "DIRECT" | "PROXY" | null;
  host?: string | null;
}

/**
 * Records every job execution in `processing_jobs` so each pipeline stage is
 * observable in the UI (job id, content, account, start/finish, status, error).
 */
export class JobRecorder {
  constructor(private readonly db: Db) {}

  async run<T>(ref: JobRef, fn: (jobRowId: string) => Promise<T>, summarize?: (r: T) => Record<string, unknown>): Promise<T> {
    const row = await this.db.processingJob.create({
      data: {
        queue: ref.queue,
        bullJobId: ref.bullJobId ?? null,
        contentId: ref.contentId ?? null,
        accountId: ref.accountId ?? null,
        sourceId: ref.sourceId ?? null,
        scheduledPostId: ref.scheduledPostId ?? null,
        retryCount: ref.retryCount ?? 0,
        input: (ref.input ?? {}) as Prisma.InputJsonValue,
        networkMode: ref.networkMode ?? null,
        host: ref.host ?? null,
        status: "RUNNING",
        startedAt: new Date(),
      },
    });
    const started = Date.now();
    try {
      const result = await fn(row.id);
      const out = summarize ? summarize(result) : {};
      await this.db.processingJob.update({
        where: { id: row.id },
        data: {
          status: (out as { skipped?: boolean }).skipped ? "SKIPPED" : "SUCCEEDED",
          finishedAt: new Date(),
          durationMs: Date.now() - started,
          output: out as Prisma.InputJsonValue,
        },
      });
      return result;
    } catch (e) {
      const err = toAppError(e);
      await this.db.processingJob.update({
        where: { id: row.id },
        data: { status: "FAILED", finishedAt: new Date(), durationMs: Date.now() - started, errorCode: err.code, errorMessage: err.message.slice(0, 2000) },
      });
      throw err;
    }
  }
}
