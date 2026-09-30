"""SQLAlchemy Core mapping of the tables the ingestion engine touches.

Prisma (packages/database/prisma/schema.prisma) owns the schema. Column names
are Prisma's camelCase. tests/test_db_contract.py verifies these columns exist.
"""

from __future__ import annotations

from sqlalchemy import BigInteger, Boolean, Column, DateTime, Float, Integer, MetaData, Table, Text
from sqlalchemy.dialects.postgresql import ARRAY, ENUM, JSONB, UUID
from sqlalchemy.ext.asyncio import AsyncEngine, create_async_engine

metadata = MetaData()


def _enum(name: str, *values: str) -> ENUM:
    return ENUM(*values, name=name, create_type=False)


Platform = _enum("Platform", "INSTAGRAM", "GENERIC_FEED", "DIRECT_URL", "LOCAL", "TIKTOK", "YOUTUBE", "FACEBOOK", "TELEGRAM")
RightsStatus = _enum("RightsStatus", "UNKNOWN", "USER_OWNS", "PERMISSION_GRANTED", "LICENSED", "PUBLIC_DOMAIN", "DO_NOT_IMPORT")
Vetting = _enum("SourceVettingStatus", "PENDING_REVIEW", "APPROVED", "REJECTED")
MediaType = _enum("MediaType", "VIDEO", "IMAGE")
ContentKind = _enum("ContentKind", "REEL", "FEED", "STORY")
ProcessingStatus = _enum("ProcessingStatus", "PENDING", "PROCESSING", "READY", "FAILED")
ApprovalStatus = _enum("ApprovalStatus", "PENDING", "APPROVED", "REJECTED")
JobStatus = _enum("JobStatus", "QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "SKIPPED", "CANCELLED")
IngestOutcome = _enum("IngestOutcome", "IMPORTED", "DUPLICATE", "REJECTED", "FAILED")
IngestKind = _enum("IngestKind", "DISCOVERED", "LOCAL_FILE", "DIRECT_URL")
NetworkModeE = _enum("NetworkMode", "DIRECT", "PROXY")
ActorType = _enum("ActorType", "USER", "SYSTEM", "WORKER", "INGESTION", "CLI")
NotificationLevel = _enum("NotificationLevel", "INFO", "SUCCESS", "WARNING", "ERROR")

U = UUID(as_uuid=False)
TS = DateTime(timezone=False)

sources = Table(
    "sources",
    metadata,
    Column("id", U, primary_key=True),
    Column("name", Text),
    Column("url", Text),
    Column("normalizedUrl", Text),
    Column("platform", Platform),
    Column("active", Boolean),
    Column("vettingStatus", Vetting),
    Column("rightsStatus", RightsStatus),
    Column("approvalRequired", Boolean),
    Column("attributionRequired", Boolean),
    Column("attributionText", Text),
    Column("lastDiscoveryAt", TS),
    Column("lastErrorCode", Text),
    Column("lastError", Text),
    Column("deletedAt", TS),
    Column("updatedAt", TS),
)

source_configs = Table(
    "source_configs",
    metadata,
    Column("id", U, primary_key=True),
    Column("sourceId", U),
    Column("allowedMediaTypes", ARRAY(MediaType)),
    Column("importFrequencyMinutes", Integer),
    Column("maxItemsPerInterval", Integer),
    Column("adapterOptions", JSONB),
)

ingestion_requests = Table(
    "ingestion_requests",
    metadata,
    Column("id", U, primary_key=True),
    Column("kind", IngestKind),
    Column("sourceId", U),
    Column("url", Text),
    Column("normalizedUrl", Text),
    Column("externalId", Text),
    Column("localKey", Text),
    Column("metadata", JSONB),
    Column("status", JobStatus),
    Column("outcome", IngestOutcome),
    Column("contentId", U),
    Column("duplicateOfId", U),
    Column("networkMode", NetworkModeE),
    Column("errorCode", Text),
    Column("errorMessage", Text),
    Column("attempts", Integer),
    Column("requestedById", U),
    Column("createdAt", TS),
    Column("updatedAt", TS),
)

contents = Table(
    "contents",
    metadata,
    Column("id", U, primary_key=True),
    Column("sourceId", U),
    Column("ingestionRequestId", U),
    Column("originalUrl", Text),
    Column("normalizedUrl", Text),
    Column("externalId", Text),
    Column("platform", Platform),
    Column("author", Text),
    Column("originalCaption", Text),
    Column("mediaType", MediaType),
    Column("kind", ContentKind),
    Column("durationSec", Float),
    Column("width", Integer),
    Column("height", Integer),
    Column("fps", Float),
    Column("videoCodec", Text),
    Column("audioCodec", Text),
    Column("fileSize", BigInteger),
    Column("checksum", Text),
    Column("perceptualHash", Text),
    Column("videoFingerprint", JSONB),
    Column("originalCreatedAt", TS),
    Column("importedAt", TS),
    Column("processingStatus", ProcessingStatus),
    Column("rightsStatus", RightsStatus),
    Column("approvalStatus", ApprovalStatus),
    Column("duplicateOfId", U),
    Column("originalKey", Text),
    Column("hashtags", ARRAY(Text)),
    Column("attribution", Text),
    Column("createdAt", TS),
    Column("updatedAt", TS),
)

processing_jobs = Table(
    "processing_jobs",
    metadata,
    Column("id", U, primary_key=True),
    Column("queue", Text),
    Column("bullJobId", Text),
    Column("contentId", U),
    Column("sourceId", U),
    Column("status", JobStatus),
    Column("errorCode", Text),
    Column("errorMessage", Text),
    Column("retryCount", Integer),
    Column("networkMode", NetworkModeE),
    Column("proxyStatus", Text),
    Column("host", Text),
    Column("input", JSONB),
    Column("output", JSONB),
    Column("startedAt", TS),
    Column("finishedAt", TS),
    Column("durationMs", Integer),
    Column("createdAt", TS),
)

audit_logs = Table(
    "audit_logs",
    metadata,
    Column("id", U, primary_key=True),
    Column("action", Text),
    Column("actorType", ActorType),
    Column("actorId", U),
    Column("entityType", Text),
    Column("entityId", Text),
    Column("summary", Text),
    Column("metadata", JSONB),
    Column("createdAt", TS),
)

notifications = Table(
    "notifications",
    metadata,
    Column("id", U, primary_key=True),
    Column("level", NotificationLevel),
    Column("type", Text),
    Column("title", Text),
    Column("body", Text),
    Column("entityType", Text),
    Column("entityId", Text),
    Column("createdAt", TS),
)

analytics_events = Table(
    "analytics_events",
    metadata,
    Column("id", U, primary_key=True),
    Column("type", Text),
    Column("contentId", U),
    Column("sourceId", U),
    Column("value", Float),
    Column("metadata", JSONB),
    Column("occurredAt", TS),
)

def make_engine(url: str) -> AsyncEngine:
    return create_async_engine(url, pool_size=5, max_overflow=5, pool_pre_ping=True)
