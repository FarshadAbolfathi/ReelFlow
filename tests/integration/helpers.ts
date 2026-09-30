import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseConfig } from "@reelflow/config";
import { createCore, type Core, type UserActor } from "@reelflow/core";
import { AdapterRegistry, MockPublishingAdapter } from "@reelflow/platform-adapters";
import { hashPassword } from "@reelflow/security";
import { TEST_DATABASE_URL, TEST_REDIS_URL } from "./env";

export interface TestWorld {
  core: Core;
  mock: MockPublishingAdapter;
  owner: UserActor;
  manager: UserActor;
  viewer: UserActor;
  storageRoot: string;
}

export function testConfig(storageRoot: string, env: Record<string, string> = {}) {
  return parseConfig(
    {
      NODE_ENV: "test",
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: TEST_REDIS_URL,
      STORAGE_PATH: storageRoot,
      SESSION_SECRET: randomBytes(48).toString("base64"),
      ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      LOG_LEVEL: "error",
      ...env,
    },
    storageRoot,
  );
}

const TABLES = [
  "publish_attempts",
  "scheduled_posts",
  "schedules",
  "media_assets",
  "contents",
  "ingestion_requests",
  "source_configs",
  "sources",
  "publishing_accounts",
  "processing_jobs",
  "audit_logs",
  "notifications",
  "analytics_events",
  "system_settings",
  "sessions",
  "users",
  "watermark_presets",
  "caption_templates",
];

export async function createWorld(env: Record<string, string> = {}): Promise<TestWorld> {
  const storageRoot = mkdtempSync(path.join(tmpdir(), "rf-it-"));
  const mock = new MockPublishingAdapter();
  const core = createCore(testConfig(storageRoot, env), { adapters: new AdapterRegistry().register(mock) });
  await core.db.$executeRawUnsafe(`TRUNCATE ${TABLES.map((t) => `"${t}"`).join(", ")} CASCADE`);
  await core.redis.flushdb();
  const pw = await hashPassword("integration-test-password");
  const mk = async (role: "OWNER" | "MANAGER" | "VIEWER") => {
    const u = await core.db.user.create({ data: { email: `${role.toLowerCase()}@test.local`, name: role, role, passwordHash: pw } });
    return { type: "USER" as const, id: u.id, role };
  };
  return { core, mock, owner: await mk("OWNER"), manager: await mk("MANAGER"), viewer: await mk("VIEWER"), storageRoot };
}

/** A READY, APPROVED content item with a processed asset, from an approved source. */
export async function seedReadyContent(w: TestWorld, opts: { sourceId?: string; rights?: "PERMISSION_GRANTED" | "UNKNOWN" | "USER_OWNS"; approved?: boolean } = {}) {
  const c = await w.core.db.content.create({
    data: {
      sourceId: opts.sourceId ?? null,
      platform: "LOCAL",
      mediaType: "VIDEO",
      kind: "REEL",
      durationSec: 20,
      width: 1080,
      height: 1920,
      processingStatus: "READY",
      rightsStatus: opts.rights ?? "PERMISSION_GRANTED",
      approvalStatus: opts.approved === false ? "PENDING" : "APPROVED",
      author: "funnypage",
      originalCaption: "A funny clip",
      checksum: randomBytes(16).toString("hex"),
    },
  });
  await w.core.db.mediaAsset.create({
    data: { contentId: c.id, kind: "PROCESSED", presetKey: "INSTAGRAM_REEL", settingsHash: "x", storageKey: "processed/2026/10/x.mp4", mime: "video/mp4", width: 1080, height: 1920, durationSec: 20, fileSize: BigInt(1_000_000) },
  });
  return c;
}

export async function seedAccount(w: TestWorld) {
  return w.core.accounts.connect({ name: "Main", platform: "INSTAGRAM", externalAccountId: "17841400000000001", accessToken: "EAAtest-token-abcdefghijkl" }, w.owner);
}

export async function approvedSource(w: TestWorld, name = "Funny Page") {
  return w.core.sources.create(
    { name, url: `https://example.com/${encodeURIComponent(name)}/feed.xml`, platform: "GENERIC_FEED", active: true, allowedMediaTypes: ["VIDEO"], importFrequencyMinutes: 360, maxItemsPerInterval: 5, approvalRequired: true, attributionRequired: true, rightsStatus: "PERMISSION_GRANTED", attributionText: `🎬 via ${name}` },
    w.owner,
  );
}
