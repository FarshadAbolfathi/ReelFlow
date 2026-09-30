/**
 * Queue names and job payload contracts.
 * The Python ingestion engine mirrors these in reelflow_ingestion/queues.py.
 */
export const QUEUES = {
  contentDiscovery: "content-discovery",
  mediaDownload: "media-download",
  mediaProcessing: "media-processing",
  watermark: "watermark",
  thumbnail: "thumbnail",
  approval: "approval",
  publishing: "publishing",
  analytics: "analytics",
  cleanup: "cleanup",
  schedulerTick: "scheduler-tick",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/**
 * Queues consumed by the Python engine. These cross the language boundary via
 * Redis Streams (consumer groups) instead of BullMQ, so neither side depends on
 * the other's BullMQ wire format. See docs/ARCHITECTURE.md §1.
 */
export const PYTHON_QUEUES: readonly QueueName[] = [QUEUES.contentDiscovery, QUEUES.mediaDownload];

export const STREAMS = {
  /** Node → Python work streams (one per Python queue). */
  work: (queue: QueueName) => `reelflow:stream:${queue}`,
  consumerGroup: "reelflow-ingestion",
  /** Python → Node events (content ingested, ready for processing). */
  events: "reelflow:events:ingestion",
  eventsGroup: "reelflow-worker",
  dedupePrefix: "reelflow:stream-dedupe:",
} as const;

export interface IngestionEvent {
  type: "content_ingested" | "ingest_failed" | "discovery_finished";
  contentId?: string;
  ingestionRequestId?: string;
  sourceId?: string;
}

export interface DiscoveryJob {
  sourceId: string;
  triggeredBy: "schedule" | "user" | "cli";
  requestedByUserId?: string;
}

export interface DownloadJob {
  ingestionRequestId: string;
}

export interface ProcessingJob {
  contentId: string;
  presetKey: string;
  watermarkPresetId?: string | null;
  /** Force a rebuild even if an asset with the same settings hash exists. */
  force?: boolean;
}

export interface WatermarkJob {
  contentId: string;
  watermarkPresetId: string;
  presetKey: string;
}

export interface ThumbnailJob {
  contentId: string;
}

export interface ApprovalJob {
  contentId: string;
}

export interface PublishingJob {
  scheduledPostId: string;
}

export interface AnalyticsJob {
  kind: "daily-rollup" | "platform-metrics";
  date?: string;
}

export interface CleanupJob {
  dryRun?: boolean;
}

/**
 * BullMQ jobId helpers — the jobId is the idempotency key.
 * BullMQ forbids ":" in custom ids (it is its key separator), so "." is used.
 */
const jid = (...parts: (string | number)[]) => parts.map((p) => String(p).replace(/[:\s]/g, "_")).join(".");
export const jobIds = {
  discovery: (sourceId: string, bucket: string) => jid("discover", sourceId, bucket),
  download: (ingestionRequestId: string) => jid("download", ingestionRequestId),
  processing: (contentId: string, presetKey: string, settingsHash: string) => jid("process", contentId, presetKey, settingsHash),
  approval: (contentId: string) => jid("approve", contentId),
  publishing: (scheduledPostId: string, attemptKey: string | number) => jid("publish", scheduledPostId, attemptKey),
} as const;

/** Redis channel/key names for the network control plane (Python owns the proxy). */
export const NETWORK_CONTROL = {
  commandStream: "reelflow:network:commands",
  statusKey: "reelflow:network:status",
  replyKeyPrefix: "reelflow:network:reply:",
} as const;

export type NetworkCommand = "status" | "test" | "start" | "stop" | "restart";
