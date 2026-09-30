/** Shapes returned by the API (serialized Prisma rows). */

export interface SourceDTO {
  id: string;
  name: string;
  url: string | null;
  platform: string;
  active: boolean;
  vettingStatus: "PENDING_REVIEW" | "APPROVED" | "REJECTED";
  vettingNote: string | null;
  rightsStatus: string;
  rightsEvidence: string | null;
  approvalRequired: boolean;
  attributionRequired: boolean;
  attributionText: string | null;
  notes: string | null;
  lastDiscoveryAt: string | null;
  lastErrorCode: string | null;
  lastError: string | null;
  createdAt: string;
  contentCount?: number;
  config: { allowedMediaTypes: string[]; importFrequencyMinutes: number; maxItemsPerInterval: number } | null;
}

export interface AssetDTO {
  id: string;
  kind: "ORIGINAL" | "PROCESSED" | "THUMBNAIL" | "PREVIEW" | "WATERMARK_IMAGE";
  presetKey: string;
  mime: string;
  width: number | null;
  height: number | null;
  durationSec: number | null;
  fileSize: number | null;
  createdAt: string;
}

export interface PostDTO {
  id: string;
  contentId: string;
  accountId: string;
  kind: string;
  scheduledAt: string;
  status: string;
  retryCount: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  permalink: string | null;
  publishedAt: string | null;
  autoScheduled: boolean;
  finalCaption: string | null;
  account?: { id: string; name: string; username: string | null; safetyState?: string };
  content?: {
    id: string;
    thumbnailKey: string | null;
    mediaType: string;
    durationSec: number | null;
    originalCaption: string | null;
    approvalStatus: string;
    source: { id: string; name: string } | null;
  };
}

export interface ContentDTO {
  id: string;
  sourceId: string | null;
  source: { id: string; name: string; platform: string } | null;
  originalUrl: string | null;
  platform: string;
  author: string | null;
  originalCaption: string | null;
  customCaption: string | null;
  mediaType: "VIDEO" | "IMAGE";
  kind: string;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fileSize: number | null;
  checksum: string | null;
  perceptualHash: string | null;
  importedAt: string;
  processingStatus: string;
  rightsStatus: string;
  approvalStatus: string;
  publishStatus: string;
  duplicateOfId: string | null;
  thumbnailKey: string | null;
  originalKey: string | null;
  hashtags: string[];
  mentions: string[];
  cta: string | null;
  attribution: string | null;
  captionTemplateId: string | null;
  lastError: string | null;
  scheduledPosts: PostDTO[];
  assets?: AssetDTO[];
}

export interface AccountDTO {
  id: string;
  name: string;
  platform: string;
  externalAccountId: string;
  username: string | null;
  status: string;
  tokenHint: string | null;
  tokenExpiresAt: string | null;
  safetyState: string;
  pausedUntil: string | null;
  pauseReason: string | null;
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  dailyLimit: number | null;
  hasToken: boolean;
  dailyPublishCount: number;
}

export interface WatermarkConfig {
  kind: "TEXT" | "IMAGE";
  text?: string;
  fontSizeRatio: number;
  color: string;
  imageAssetKey?: string;
  opacity: number;
  scale: number;
  position: "TOP_LEFT" | "TOP_CENTER" | "TOP_RIGHT" | "CENTER" | "BOTTOM_LEFT" | "BOTTOM_CENTER" | "BOTTOM_RIGHT";
  marginPx: number;
  rotationDeg: number;
  startSec: number;
  endSec: number | null;
  animation: "NONE" | "FADE_IN" | "FADE_IN_OUT";
  respectSafeArea: boolean;
}

export interface WatermarkPresetDTO {
  id: string;
  name: string;
  isDefault: boolean;
  config: WatermarkConfig;
}

export interface TemplateDTO {
  id: string;
  name: string;
  body: string;
  defaultHashtags: string[];
  cta: string | null;
  isDefault: boolean;
}

export interface Limits {
  maxPostsPerDay: number;
  maxPostsPerHour: number;
  minPostIntervalMinutes: number;
  maxPostsPerSourcePerDay: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
}
