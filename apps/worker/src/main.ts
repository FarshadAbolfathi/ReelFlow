import { Worker } from "bullmq";
import { loadConfig } from "@reelflow/config";
import { createCore, createRedis } from "@reelflow/core";
import { createLogger } from "@reelflow/logger";
import { PYTHON_QUEUES, QUEUES, type QueueName } from "@reelflow/types";
import { startIngestionBridge } from "./bridge";
import { createHandlers, type Handler } from "./handlers";

async function main() {
  const config = loadConfig();
  const log = createLogger("worker", { level: config.logLevel });
  const core = createCore(config, { logger: log });
  const settings = await core.settings.get();
  const handlers = createHandlers(core);

  const concurrency: Partial<Record<QueueName, number>> = {
    [QUEUES.mediaProcessing]: settings.queue.maxConcurrentJobs,
    [QUEUES.watermark]: 1,
    [QUEUES.publishing]: config.policy.maxConcurrentPublish, // never above the policy ceiling
    [QUEUES.schedulerTick]: 1,
    [QUEUES.cleanup]: 1,
  };

  const workers: Worker[] = [];
  for (const [queue, handler] of Object.entries(handlers) as [QueueName, Handler][]) {
    if (PYTHON_QUEUES.includes(queue)) continue; // consumed by the Python ingestion engine
    const w = new Worker(queue, handler, { connection: createRedis(config.redisUrl), concurrency: concurrency[queue] ?? 2 });
    w.on("completed", (job) => log.info({ queue, jobId: job.id }, "job completed"));
    w.on("failed", (job, err) => log.warn({ queue, jobId: job?.id, err }, "job failed"));
    workers.push(w);
  }

  // Repeatable jobs (idempotent: upsertJobScheduler replaces, never duplicates).
  await core.queues.queue(QUEUES.schedulerTick).upsertJobScheduler("tick", { every: 60_000 }, { name: "tick", data: {} });
  await core.queues.queue(QUEUES.cleanup).upsertJobScheduler("daily-cleanup", { pattern: "30 3 * * *", tz: settings.general.timezone }, { name: "cleanup", data: { dryRun: false } });
  await core.queues.queue(QUEUES.analytics).upsertJobScheduler("metrics", { pattern: "15 */6 * * *" }, { name: "metrics", data: { kind: "platform-metrics" } });

  const stopBridge = startIngestionBridge(core, createRedis(config.redisUrl), log);

  log.info({ queues: workers.map((w) => w.name), publishConcurrency: concurrency[QUEUES.publishing], networkMode: config.network.mode }, "worker started");

  const shutdown = async () => {
    log.info("worker shutting down (waiting for active jobs)");
    stopBridge();
    await Promise.all(workers.map((w) => w.close()));
    await core.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
