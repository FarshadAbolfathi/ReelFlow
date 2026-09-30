-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'MANAGER', 'VIEWER');

-- CreateEnum
CREATE TYPE "Platform" AS ENUM ('INSTAGRAM', 'GENERIC_FEED', 'DIRECT_URL', 'LOCAL', 'TIKTOK', 'YOUTUBE', 'FACEBOOK', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "RightsStatus" AS ENUM ('UNKNOWN', 'USER_OWNS', 'PERMISSION_GRANTED', 'LICENSED', 'PUBLIC_DOMAIN', 'DO_NOT_IMPORT');

-- CreateEnum
CREATE TYPE "SourceVettingStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MediaType" AS ENUM ('VIDEO', 'IMAGE');

-- CreateEnum
CREATE TYPE "ContentKind" AS ENUM ('REEL', 'FEED', 'STORY');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "PublishStatus" AS ENUM ('UNSCHEDULED', 'SCHEDULED', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('WAITING_APPROVAL', 'READY', 'SCHEDULED', 'PROCESSING', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED', 'PAUSED');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'AUTH_EXPIRED', 'ERROR');

-- CreateEnum
CREATE TYPE "SafetyState" AS ENUM ('HEALTHY', 'WARNING', 'PAUSED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IngestOutcome" AS ENUM ('IMPORTED', 'DUPLICATE', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "IngestKind" AS ENUM ('DISCOVERED', 'LOCAL_FILE', 'DIRECT_URL');

-- CreateEnum
CREATE TYPE "NetworkMode" AS ENUM ('DIRECT', 'PROXY');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('ORIGINAL', 'PROCESSED', 'THUMBNAIL', 'PREVIEW', 'WATERMARK_IMAGE');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'SYSTEM', 'WORKER', 'INGESTION', 'CLI');

-- CreateEnum
CREATE TYPE "NotificationLevel" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'ERROR');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'MANAGER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "userId" UUID NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sources" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT,
    "normalizedUrl" TEXT,
    "platform" "Platform" NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "vettingStatus" "SourceVettingStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "vettedById" UUID,
    "vettedAt" TIMESTAMP(3),
    "vettingNote" TEXT,
    "rightsStatus" "RightsStatus" NOT NULL DEFAULT 'UNKNOWN',
    "rightsEvidence" TEXT,
    "approvalRequired" BOOLEAN NOT NULL DEFAULT true,
    "attributionRequired" BOOLEAN NOT NULL DEFAULT true,
    "attributionText" TEXT,
    "notes" TEXT,
    "createdById" UUID,
    "lastDiscoveryAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_configs" (
    "id" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "allowedMediaTypes" "MediaType"[] DEFAULT ARRAY['VIDEO']::"MediaType"[],
    "importFrequencyMinutes" INTEGER NOT NULL DEFAULT 360,
    "maxItemsPerInterval" INTEGER NOT NULL DEFAULT 5,
    "adapterOptions" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingestion_requests" (
    "id" UUID NOT NULL,
    "kind" "IngestKind" NOT NULL,
    "sourceId" UUID,
    "url" TEXT,
    "normalizedUrl" TEXT,
    "externalId" TEXT,
    "localKey" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "outcome" "IngestOutcome",
    "contentId" UUID,
    "duplicateOfId" UUID,
    "networkMode" "NetworkMode" NOT NULL DEFAULT 'DIRECT',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "requestedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingestion_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contents" (
    "id" UUID NOT NULL,
    "sourceId" UUID,
    "ingestionRequestId" UUID,
    "originalUrl" TEXT,
    "normalizedUrl" TEXT,
    "externalId" TEXT,
    "platform" "Platform" NOT NULL,
    "author" TEXT,
    "originalCaption" TEXT,
    "mediaType" "MediaType" NOT NULL,
    "kind" "ContentKind" NOT NULL DEFAULT 'REEL',
    "durationSec" DOUBLE PRECISION,
    "width" INTEGER,
    "height" INTEGER,
    "fps" DOUBLE PRECISION,
    "videoCodec" TEXT,
    "audioCodec" TEXT,
    "fileSize" BIGINT,
    "checksum" TEXT,
    "perceptualHash" TEXT,
    "videoFingerprint" JSONB,
    "originalCreatedAt" TIMESTAMP(3),
    "importedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingStatus" "ProcessingStatus" NOT NULL DEFAULT 'PENDING',
    "rightsStatus" "RightsStatus" NOT NULL DEFAULT 'UNKNOWN',
    "approvalStatus" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "approvedById" UUID,
    "approvedAt" TIMESTAMP(3),
    "approvalNote" TEXT,
    "publishStatus" "PublishStatus" NOT NULL DEFAULT 'UNSCHEDULED',
    "duplicateOfId" UUID,
    "originalKey" TEXT,
    "thumbnailKey" TEXT,
    "customCaption" TEXT,
    "processedCaption" TEXT,
    "captionTemplateId" UUID,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mentions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cta" TEXT,
    "attribution" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastErrorCode" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "contentId" UUID NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "presetKey" TEXT NOT NULL DEFAULT '',
    "settingsHash" TEXT NOT NULL DEFAULT '',
    "storageKey" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationSec" DOUBLE PRECISION,
    "fileSize" BIGINT,
    "checksum" TEXT,
    "watermarkPresetId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_jobs" (
    "id" UUID NOT NULL,
    "queue" TEXT NOT NULL,
    "bullJobId" TEXT,
    "contentId" UUID,
    "accountId" UUID,
    "sourceId" UUID,
    "scheduledPostId" UUID,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "networkMode" "NetworkMode",
    "proxyStatus" TEXT,
    "host" TEXT,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processing_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watermark_presets" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "watermark_presets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "caption_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "defaultHashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cta" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "caption_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publishing_accounts" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "username" TEXT,
    "status" "AccountStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "encryptedToken" TEXT,
    "tokenHint" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "safetyState" "SafetyState" NOT NULL DEFAULT 'HEALTHY',
    "pausedUntil" TIMESTAMP(3),
    "pauseReason" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "lastSuccessAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastError" TEXT,
    "dailyLimit" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "publishing_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "accountId" UUID NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Tehran',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "postsPerDay" INTEGER NOT NULL,
    "minIntervalMinutes" INTEGER NOT NULL,
    "maxIntervalMinutes" INTEGER,
    "config" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_posts" (
    "id" UUID NOT NULL,
    "contentId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "scheduleId" UUID,
    "kind" "ContentKind" NOT NULL DEFAULT 'REEL',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "PostStatus" NOT NULL DEFAULT 'WAITING_APPROVAL',
    "dedupeKey" TEXT,
    "finalCaption" TEXT,
    "assetId" UUID,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "containerId" TEXT,
    "externalPostId" TEXT,
    "permalink" TEXT,
    "publishedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "autoScheduled" BOOLEAN NOT NULL DEFAULT false,
    "createdById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publish_attempts" (
    "id" UUID NOT NULL,
    "scheduledPostId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "JobStatus" NOT NULL,
    "step" TEXT,
    "httpStatus" INTEGER,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "rateLimited" BOOLEAN NOT NULL DEFAULT false,
    "retryAfterSec" INTEGER,
    "containerId" TEXT,
    "externalPostId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "publish_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "entityType" TEXT,
    "entityId" TEXT,
    "summary" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" UUID,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "level" "NotificationLevel" NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analytics_events" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "contentId" UUID,
    "sourceId" UUID,
    "accountId" UUID,
    "value" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analytics_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_tokenHash_key" ON "sessions"("tokenHash");

-- CreateIndex
CREATE INDEX "sessions_userId_idx" ON "sessions"("userId");

-- CreateIndex
CREATE INDEX "sessions_expiresAt_idx" ON "sessions"("expiresAt");

-- CreateIndex
CREATE INDEX "sources_platform_idx" ON "sources"("platform");

-- CreateIndex
CREATE INDEX "sources_vettingStatus_idx" ON "sources"("vettingStatus");

-- CreateIndex
CREATE INDEX "sources_active_idx" ON "sources"("active");

-- CreateIndex
CREATE INDEX "sources_createdAt_idx" ON "sources"("createdAt");

-- CreateIndex
CREATE INDEX "sources_normalizedUrl_idx" ON "sources"("normalizedUrl");

-- CreateIndex
CREATE UNIQUE INDEX "source_configs_sourceId_key" ON "source_configs"("sourceId");

-- CreateIndex
CREATE INDEX "ingestion_requests_status_idx" ON "ingestion_requests"("status");

-- CreateIndex
CREATE INDEX "ingestion_requests_sourceId_idx" ON "ingestion_requests"("sourceId");

-- CreateIndex
CREATE INDEX "ingestion_requests_normalizedUrl_idx" ON "ingestion_requests"("normalizedUrl");

-- CreateIndex
CREATE INDEX "ingestion_requests_createdAt_idx" ON "ingestion_requests"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ingestion_requests_sourceId_externalId_key" ON "ingestion_requests"("sourceId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "contents_ingestionRequestId_key" ON "contents"("ingestionRequestId");

-- CreateIndex
CREATE UNIQUE INDEX "contents_checksum_key" ON "contents"("checksum");

-- CreateIndex
CREATE INDEX "contents_sourceId_idx" ON "contents"("sourceId");

-- CreateIndex
CREATE INDEX "contents_processingStatus_idx" ON "contents"("processingStatus");

-- CreateIndex
CREATE INDEX "contents_approvalStatus_idx" ON "contents"("approvalStatus");

-- CreateIndex
CREATE INDEX "contents_publishStatus_idx" ON "contents"("publishStatus");

-- CreateIndex
CREATE INDEX "contents_rightsStatus_idx" ON "contents"("rightsStatus");

-- CreateIndex
CREATE INDEX "contents_createdAt_idx" ON "contents"("createdAt");

-- CreateIndex
CREATE INDEX "contents_importedAt_idx" ON "contents"("importedAt");

-- CreateIndex
CREATE INDEX "contents_perceptualHash_idx" ON "contents"("perceptualHash");

-- CreateIndex
CREATE INDEX "contents_normalizedUrl_idx" ON "contents"("normalizedUrl");

-- CreateIndex
CREATE INDEX "contents_sourceId_externalId_idx" ON "contents"("sourceId", "externalId");

-- CreateIndex
CREATE INDEX "media_assets_contentId_idx" ON "media_assets"("contentId");

-- CreateIndex
CREATE INDEX "media_assets_createdAt_idx" ON "media_assets"("createdAt");

-- CreateIndex
CREATE INDEX "media_assets_checksum_idx" ON "media_assets"("checksum");

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_contentId_kind_presetKey_settingsHash_key" ON "media_assets"("contentId", "kind", "presetKey", "settingsHash");

-- CreateIndex
CREATE INDEX "processing_jobs_queue_status_idx" ON "processing_jobs"("queue", "status");

-- CreateIndex
CREATE INDEX "processing_jobs_status_idx" ON "processing_jobs"("status");

-- CreateIndex
CREATE INDEX "processing_jobs_contentId_idx" ON "processing_jobs"("contentId");

-- CreateIndex
CREATE INDEX "processing_jobs_sourceId_idx" ON "processing_jobs"("sourceId");

-- CreateIndex
CREATE INDEX "processing_jobs_accountId_idx" ON "processing_jobs"("accountId");

-- CreateIndex
CREATE INDEX "processing_jobs_createdAt_idx" ON "processing_jobs"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "watermark_presets_name_key" ON "watermark_presets"("name");

-- CreateIndex
CREATE UNIQUE INDEX "caption_templates_name_key" ON "caption_templates"("name");

-- CreateIndex
CREATE INDEX "publishing_accounts_status_idx" ON "publishing_accounts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "publishing_accounts_platform_externalAccountId_key" ON "publishing_accounts"("platform", "externalAccountId");

-- CreateIndex
CREATE INDEX "schedules_accountId_idx" ON "schedules"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_posts_dedupeKey_key" ON "scheduled_posts"("dedupeKey");

-- CreateIndex
CREATE INDEX "scheduled_posts_status_idx" ON "scheduled_posts"("status");

-- CreateIndex
CREATE INDEX "scheduled_posts_scheduledAt_idx" ON "scheduled_posts"("scheduledAt");

-- CreateIndex
CREATE INDEX "scheduled_posts_accountId_scheduledAt_idx" ON "scheduled_posts"("accountId", "scheduledAt");

-- CreateIndex
CREATE INDEX "scheduled_posts_contentId_idx" ON "scheduled_posts"("contentId");

-- CreateIndex
CREATE INDEX "scheduled_posts_createdAt_idx" ON "scheduled_posts"("createdAt");

-- CreateIndex
CREATE INDEX "publish_attempts_accountId_startedAt_idx" ON "publish_attempts"("accountId", "startedAt");

-- CreateIndex
CREATE INDEX "publish_attempts_status_idx" ON "publish_attempts"("status");

-- CreateIndex
CREATE UNIQUE INDEX "publish_attempts_scheduledPostId_attempt_key" ON "publish_attempts"("scheduledPostId", "attempt");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "audit_logs_entityType_entityId_idx" ON "audit_logs"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "audit_logs_createdAt_idx" ON "audit_logs"("createdAt");

-- CreateIndex
CREATE INDEX "notifications_readAt_idx" ON "notifications"("readAt");

-- CreateIndex
CREATE INDEX "notifications_createdAt_idx" ON "notifications"("createdAt");

-- CreateIndex
CREATE INDEX "analytics_events_type_occurredAt_idx" ON "analytics_events"("type", "occurredAt");

-- CreateIndex
CREATE INDEX "analytics_events_sourceId_idx" ON "analytics_events"("sourceId");

-- CreateIndex
CREATE INDEX "analytics_events_accountId_idx" ON "analytics_events"("accountId");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_vettedById_fkey" FOREIGN KEY ("vettedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sources" ADD CONSTRAINT "sources_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_configs" ADD CONSTRAINT "source_configs_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingestion_requests" ADD CONSTRAINT "ingestion_requests_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contents" ADD CONSTRAINT "contents_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "sources"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contents" ADD CONSTRAINT "contents_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "contents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contents" ADD CONSTRAINT "contents_captionTemplateId_fkey" FOREIGN KEY ("captionTemplateId") REFERENCES "caption_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "contents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_watermarkPresetId_fkey" FOREIGN KEY ("watermarkPresetId") REFERENCES "watermark_presets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "publishing_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "contents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "publishing_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_posts" ADD CONSTRAINT "scheduled_posts_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_scheduledPostId_fkey" FOREIGN KEY ("scheduledPostId") REFERENCES "scheduled_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publish_attempts" ADD CONSTRAINT "publish_attempts_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "publishing_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
