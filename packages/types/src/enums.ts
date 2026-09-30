/**
 * Domain enums shared by API, worker, web and CLI.
 * These mirror the Prisma enums in packages/database/prisma/schema.prisma;
 * packages/database/test/enums.test.ts fails if the two drift apart.
 */

const values = <T extends string>(...v: T[]) => Object.freeze(v) as readonly T[];

export const USER_ROLES = values("OWNER", "MANAGER", "VIEWER");
export type UserRole = (typeof USER_ROLES)[number];

export const PLATFORMS = values("INSTAGRAM", "GENERIC_FEED", "DIRECT_URL", "LOCAL", "TIKTOK", "YOUTUBE", "FACEBOOK", "TELEGRAM");
export type Platform = (typeof PLATFORMS)[number];

/** Platforms that currently have a publishing adapter. */
export const PUBLISH_PLATFORMS = values("INSTAGRAM");
export type PublishPlatform = (typeof PUBLISH_PLATFORMS)[number];

export const RIGHTS_STATUSES = values(
  "UNKNOWN",
  "USER_OWNS",
  "PERMISSION_GRANTED",
  "LICENSED",
  "PUBLIC_DOMAIN",
  "DO_NOT_IMPORT",
);
export type RightsStatus = (typeof RIGHTS_STATUSES)[number];

/** Rights statuses that allow content to be published at all. */
export const PUBLISHABLE_RIGHTS: readonly RightsStatus[] = [
  "USER_OWNS",
  "PERMISSION_GRANTED",
  "LICENSED",
  "PUBLIC_DOMAIN",
];

export const SOURCE_VETTING_STATUSES = values("PENDING_REVIEW", "APPROVED", "REJECTED");
export type SourceVettingStatus = (typeof SOURCE_VETTING_STATUSES)[number];

export const MEDIA_TYPES = values("VIDEO", "IMAGE");
export type MediaType = (typeof MEDIA_TYPES)[number];

export const CONTENT_KINDS = values("REEL", "FEED", "STORY");
export type ContentKind = (typeof CONTENT_KINDS)[number];

export const PROCESSING_STATUSES = values("PENDING", "PROCESSING", "READY", "FAILED");
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

export const APPROVAL_STATUSES = values("PENDING", "APPROVED", "REJECTED");
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export const PUBLISH_STATUSES = values("UNSCHEDULED", "SCHEDULED", "PUBLISHED", "FAILED");
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

export const POST_STATUSES = values(
  "WAITING_APPROVAL",
  "READY",
  "SCHEDULED",
  "PROCESSING",
  "PUBLISHING",
  "PUBLISHED",
  "FAILED",
  "CANCELLED",
  "PAUSED",
);
export type PostStatus = (typeof POST_STATUSES)[number];

export const APPROVAL_MODES = values("AUTO", "SEMI_AUTO", "MANUAL");
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

export const ACCOUNT_STATUSES = values("CONNECTED", "DISCONNECTED", "AUTH_EXPIRED", "ERROR");
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const SAFETY_STATES = values("HEALTHY", "WARNING", "PAUSED");
export type SafetyState = (typeof SAFETY_STATES)[number];

export const JOB_STATUSES = values("QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED", "CANCELLED");
export type JobStatus = (typeof JOB_STATUSES)[number];

export const INGEST_OUTCOMES = values("IMPORTED", "DUPLICATE", "REJECTED", "FAILED");
export type IngestOutcome = (typeof INGEST_OUTCOMES)[number];

export const NETWORK_MODES = values("DIRECT", "PROXY");
export type NetworkMode = (typeof NETWORK_MODES)[number];

export const PROXY_HEALTH = values("HEALTHY", "DEGRADED", "UNAVAILABLE", "DISABLED");
export type ProxyHealth = (typeof PROXY_HEALTH)[number];

export const NOTIFICATION_LEVELS = values("INFO", "SUCCESS", "WARNING", "ERROR");
export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

export const WATERMARK_POSITIONS = values(
  "TOP_LEFT",
  "TOP_CENTER",
  "TOP_RIGHT",
  "CENTER",
  "BOTTOM_LEFT",
  "BOTTOM_CENTER",
  "BOTTOM_RIGHT",
);
export type WatermarkPosition = (typeof WATERMARK_POSITIONS)[number];

export const WATERMARK_ANIMATIONS = values("NONE", "FADE_IN", "FADE_IN_OUT");
export type WatermarkAnimation = (typeof WATERMARK_ANIMATIONS)[number];
