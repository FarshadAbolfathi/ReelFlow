import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import { PYTHON_QUEUES, QUEUES, STREAMS, type QueueName } from "@reelflow/types";

export function createRedis(url: string): Redis {
  // BullMQ requires maxRetriesPerRequest=null for blocking connections.
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
}

/** Default retry policy per queue. Publishing retries are driven by the safety monitor instead. */
const DEFAULTS: Record<QueueName, JobsOptions> = {
  "content-discovery": { attempts: 3, backoff: { type: "exponential", delay: 60_000 } },
  "media-download": { attempts: 4, backoff: { type: "exponential", delay: 30_000 } },
  "media-processing": { attempts: 2, backoff: { type: "exponential", delay: 30_000 } },
  watermark: { attempts: 2, backoff: { type: "exponential", delay: 30_000 } },
  thumbnail: { attempts: 2, backoff: { type: "exponential", delay: 10_000 } },
  approval: { attempts: 3, backoff: { type: "exponential", delay: 5_000 } },
  publishing: { attempts: 1 },
  analytics: { attempts: 3, backoff: { type: "exponential", delay: 60_000 } },
  cleanup: { attempts: 1 },
  "scheduler-tick": { attempts: 1 },
};

/**
 * Thin wrapper over BullMQ queues. The jobId passed to `add` is the idempotency
 * key: BullMQ ignores a second add with the same id while the first exists.
 */
export class QueueBus {
  private readonly queues = new Map<QueueName, Queue>();

  constructor(private readonly connection: Redis) {}

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: { removeOnComplete: { age: 7 * 86_400, count: 5000 }, removeOnFail: { age: 30 * 86_400 }, ...DEFAULTS[name] },
      });
      this.queues.set(name, q);
    }
    return q;
  }

  async add<T extends object>(name: QueueName, data: T, opts: JobsOptions & { jobId: string }): Promise<string> {
    if (this.isPythonQueue(name)) return this.addToStream(name, data, opts.jobId);
    const job = await this.queue(name).add(name, data, opts);
    return job.id ?? opts.jobId;
  }

  /** Python-bound work: XADD once per jobId (7-day dedupe window). */
  private async addToStream(name: QueueName, data: object, jobId: string): Promise<string> {
    const fresh = await this.connection.set(`${STREAMS.dedupePrefix}${jobId}`, "1", "EX", 7 * 86_400, "NX");
    if (fresh === "OK") {
      await this.connection.xadd(STREAMS.work(name), "MAXLEN", "~", "10000", "*", "jobId", jobId, "data", JSON.stringify(data), "attempt", "1");
    }
    return jobId;
  }

  async streamLength(name: QueueName): Promise<number> {
    return this.connection.xlen(STREAMS.work(name));
  }

  async counts(): Promise<Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, number>> = {};
    for (const name of Object.values(QUEUES)) {
      if (this.isPythonQueue(name)) {
        const pending = await this.connection
          .xpending(STREAMS.work(name), STREAMS.consumerGroup)
          .catch(() => [0]);
        out[name] = { stream: await this.streamLength(name), pending: Number((pending as unknown[])[0] ?? 0) };
        continue;
      }
      out[name] = await this.queue(name).getJobCounts("waiting", "active", "delayed", "failed", "completed", "paused");
    }
    return out;
  }

  isPythonQueue(name: QueueName): boolean {
    return PYTHON_QUEUES.includes(name);
  }

  async close(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}
