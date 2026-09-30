import type { AppConfig } from "@reelflow/config";
import { getDb, type Db } from "@reelflow/database";
import { createLogger, type Logger } from "@reelflow/logger";
import { createDefaultRegistry, type AdapterRegistry } from "@reelflow/platform-adapters";
import type { Redis } from "ioredis";
import { AuditService, NotificationService } from "./infra/audit";
import { JobRecorder } from "./infra/jobs";
import { QueueBus, createRedis } from "./infra/queues";
import { LocalStorage, type StorageService } from "./infra/storage";
import { AccountsService } from "./services/accounts";
import { AnalyticsService } from "./services/analytics";
import { AuthService } from "./services/auth";
import { CleanupService } from "./services/cleanup";
import { ContentService } from "./services/content";
import { NetworkControl } from "./services/network-control";
import { ProcessingService } from "./services/processing";
import { PublishingService } from "./services/publishing";
import { SchedulingService } from "./services/scheduling";
import { SettingsService } from "./services/settings";
import { SourcesService } from "./services/sources";

/** Everything the API, worker and CLI need, wired once per process. */
export interface Core {
  config: AppConfig;
  db: Db;
  redis: Redis;
  logger: Logger;
  storage: StorageService;
  queues: QueueBus;
  jobs: JobRecorder;
  audit: AuditService;
  notifications: NotificationService;
  adapters: AdapterRegistry;
  settings: SettingsService;
  auth: AuthService;
  sources: SourcesService;
  content: ContentService;
  processing: ProcessingService;
  accounts: AccountsService;
  scheduling: SchedulingService;
  publishing: PublishingService;
  analytics: AnalyticsService;
  cleanup: CleanupService;
  network: NetworkControl;
  close(): Promise<void>;
}

export function createCore(config: AppConfig, overrides: { adapters?: AdapterRegistry; logger?: Logger; redis?: Redis } = {}): Core {
  const db = getDb(config.databaseUrl);
  const redis = overrides.redis ?? createRedis(config.redisUrl);
  const logger = overrides.logger ?? createLogger("core", { level: config.logLevel });
  const storage = new LocalStorage(config.storagePath);
  const queues = new QueueBus(redis);
  const audit = new AuditService(db);
  const notifications = new NotificationService(db);
  const adapters =
    overrides.adapters ?? createDefaultRegistry({ mode: config.publishingAdapterMode, instagram: { graphVersion: config.instagram.graphApiVersion } });
  const settings = new SettingsService(db, config, audit);
  const content = new ContentService(db, audit, queues, storage, settings);
  const processing = new ProcessingService(db, storage, audit, notifications, queues, content, settings);
  const accounts = new AccountsService(db, config, adapters, audit, notifications, settings);
  const scheduling = new SchedulingService(db, audit, settings, content);
  const publishing = new PublishingService(db, config, adapters, accounts, content, processing, scheduling, settings, storage, audit, notifications, queues);

  return {
    config,
    db,
    redis,
    logger,
    storage,
    queues,
    jobs: new JobRecorder(db),
    audit,
    notifications,
    adapters,
    settings,
    auth: new AuthService(db, redis, audit),
    sources: new SourcesService(db, config, audit, queues),
    content,
    processing,
    accounts,
    scheduling,
    publishing,
    analytics: new AnalyticsService(db, config, settings, adapters, accounts),
    cleanup: new CleanupService(db, storage, settings, audit, notifications),
    network: new NetworkControl(redis),
    async close() {
      await queues.close();
      await redis.quit().catch(() => undefined);
      await db.$disconnect();
    },
  };
}
