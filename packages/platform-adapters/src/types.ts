import type { NetworkClient } from "@reelflow/http";
import type { ContentKind, MediaType, Platform } from "@reelflow/types";

/** Everything an adapter needs for one call. Tokens are decrypted just-in-time and never logged. */
export interface PlatformContext {
  externalAccountId: string;
  accessToken: string;
  network: NetworkClient;
  /** Correlates network logs with the job. */
  jobId?: string;
}

export interface MediaForValidation {
  mediaType: MediaType;
  durationSec: number | null;
  width: number;
  height: number;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  audioSampleRate: number | null;
  fileSize: number;
  mime: string;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface CreatePostRequest {
  kind: ContentKind;
  mediaType: MediaType;
  filePath: string;
  fileSize: number;
  caption: string;
  /** Re-use a container created by a previous attempt (idempotency). */
  existingContainerId?: string | null;
}

export type ContainerState = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";

export interface PublishingQuota {
  used: number;
  total: number;
  windowHours: number;
}

export interface AccountIdentity {
  externalAccountId: string;
  username: string | null;
}

export interface PlatformCapabilities {
  kinds: ContentKind[];
  mediaTypes: MediaType[];
  deletePost: boolean;
  analytics: boolean;
  quota: boolean;
}

/**
 * The only way ReelFlow talks to a publishing platform.
 * New platforms (TikTok, YouTube, …) implement this interface.
 */
export interface PublishingAdapter {
  readonly platform: Platform;
  readonly capabilities: PlatformCapabilities;
  authenticate(ctx: PlatformContext): Promise<AccountIdentity>;
  validateMedia(media: MediaForValidation, kind: ContentKind): ValidationIssue[];
  /** Creates (or resumes) a media container and uploads the file. Returns the container id. */
  createPost(ctx: PlatformContext, req: CreatePostRequest): Promise<{ containerId: string }>;
  getStatus(ctx: PlatformContext, containerId: string): Promise<{ state: ContainerState; detail?: string }>;
  publishPost(ctx: PlatformContext, containerId: string): Promise<{ externalPostId: string; permalink: string | null }>;
  getPublishingQuota?(ctx: PlatformContext): Promise<PublishingQuota>;
  deletePost?(ctx: PlatformContext, externalPostId: string): Promise<void>;
}

export interface MetricValue {
  name: string;
  value: number;
}

/** Reads metrics the platform actually provides. Never fabricates missing values. */
export interface AnalyticsAdapter {
  readonly platform: Platform;
  getPostMetrics(ctx: PlatformContext, externalPostId: string): Promise<MetricValue[]>;
}
