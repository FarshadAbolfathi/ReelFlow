/**
 * Bridges ingestion events from the Python engine (Redis Stream) into the
 * BullMQ processing queue. Acknowledged only after the job is enqueued, so a
 * crash re-delivers the event; enqueueing is idempotent by jobId.
 */
import type { Redis } from "ioredis";
import type { Core } from "@reelflow/core";
import type { Logger } from "@reelflow/logger";
import { STREAMS, type IngestionEvent } from "@reelflow/types";

export async function ensureGroup(redis: Redis, stream: string, group: string): Promise<void> {
  try {
    await redis.xgroup("CREATE", stream, group, "0", "MKSTREAM");
  } catch (e) {
    if (!String((e as Error).message).includes("BUSYGROUP")) throw e;
  }
}

export async function handleIngestionEvent(core: Core, ev: IngestionEvent): Promise<void> {
  if (ev.type === "content_ingested" && ev.contentId) {
    await core.content.requestProcessing(ev.contentId, {}, { type: "WORKER" });
  }
}

export function startIngestionBridge(core: Core, redis: Redis, log: Logger, consumer = `worker-${process.pid}`) {
  let stopped = false;
  const loop = async () => {
    await ensureGroup(redis, STREAMS.events, STREAMS.eventsGroup);
    // First drain anything this consumer left pending, then read new events.
    let cursor = "0";
    while (!stopped) {
      try {
        const res = (await redis.xreadgroup("GROUP", STREAMS.eventsGroup, consumer, "COUNT", 20, "BLOCK", 5000, "STREAMS", STREAMS.events, cursor)) as
          | [string, [string, string[]][]][]
          | null;
        const entries = res?.[0]?.[1] ?? [];
        if (cursor === "0" && entries.length === 0) cursor = ">";
        for (const [id, fields] of entries) {
          const payload = fields[fields.indexOf("event") + 1];
          try {
            if (payload) await handleIngestionEvent(core, JSON.parse(payload) as IngestionEvent);
            await redis.xack(STREAMS.events, STREAMS.eventsGroup, id);
          } catch (e) {
            log.warn({ err: e, id }, "ingestion event failed; will be retried");
          }
        }
      } catch (e) {
        if (!stopped) {
          log.error({ err: e }, "ingestion bridge error");
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}

/** Recovery sweep: content that was ingested but never queued for processing. */
export async function sweepUnprocessed(core: Core): Promise<number> {
  const stale = await core.db.content.findMany({
    where: { processingStatus: "PENDING", duplicateOfId: null, originalKey: { not: null }, importedAt: { lt: new Date(Date.now() - 2 * 60_000) } },
    select: { id: true },
    take: 50,
  });
  for (const c of stale) await core.content.requestProcessing(c.id, {}, { type: "WORKER" });
  return stale.length;
}
