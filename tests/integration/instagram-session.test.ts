/**
 * In-app Instagram login (PUBLISHING_ADAPTER_MODE=session), Node side. A small
 * responder stands in for the Python engine on the Redis command stream, so this
 * covers what crosses the boundary: the encrypted session row, the commands and
 * the typed errors. The engine itself is tested in apps/ingestion/tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Redis } from "ioredis";
import { createCore, IG_SESSION, type Core } from "@reelflow/core";
import { decryptSecret, encryptSecret } from "@reelflow/security";
import { AppError } from "@reelflow/types";
import { createWorld, seedReadyContent, type TestWorld } from "./helpers";

type Handler = (cmd: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Answers session commands like reelflow_ingestion/session_control.py does. */
function startEngine(redis: Redis, handle: Handler) {
  let stopped = false;
  const seen: { cmd: string; args: Record<string, unknown> }[] = [];
  const loop = async () => {
    let last = "0";
    while (!stopped) {
      const res = (await redis.xread("COUNT", 10, "BLOCK", 200, "STREAMS", IG_SESSION.commandStream, last)) as [string, [string, string[]][]][] | null;
      for (const [id, fields] of res?.[0]?.[1] ?? []) {
        last = id;
        const f = Object.fromEntries(fields.flatMap((v, i) => (i % 2 ? [] : [[v, fields[i + 1]]]))) as Record<string, string>;
        const args = JSON.parse(f.args ?? "{}") as Record<string, unknown>;
        seen.push({ cmd: f.cmd!, args });
        await redis.set(`${IG_SESSION.replyKeyPrefix}${f.id}`, JSON.stringify(await handle(f.cmd!, args)), "EX", 60);
      }
    }
  };
  const done = loop();
  return {
    seen,
    async stop() {
      stopped = true;
      await done;
      redis.disconnect();
    },
  };
}

let w: TestWorld;
let core: Core;
let engine: ReturnType<typeof startEngine> | undefined;

beforeEach(async () => {
  w = await createWorld({ PUBLISHING_ADAPTER_MODE: "session" });
  core = createCore(w.core.config); // default registry → InstagramSessionAdapter
});
afterEach(async () => {
  await engine?.stop();
  engine = undefined;
  await core.close();
  await w.core.close();
});

const blobOf = (a: { id: string; encryptedToken: string | null }) => JSON.parse(decryptSecret(a.encryptedToken!, core.config.encryptionKey, `account:${a.id}`));

describe("Instagram login session", () => {
  it("stores the login encrypted and lets the engine log in", async () => {
    engine = startEngine(core.redis.duplicate(), async (cmd, args) => {
      expect(cmd).toBe("login");
      const row = await core.db.publishingAccount.findUniqueOrThrow({ where: { id: String(args.accountId) } });
      expect(blobOf(row)).toMatchObject({ kind: "ig-session", username: "mypage", password: "secret pass", sessionid: null });
      await core.db.publishingAccount.update({ where: { id: row.id }, data: { status: "CONNECTED", username: "mypage" } });
      return { ok: true, result: { userId: "4242", username: "mypage" } };
    });
    const view = await core.accounts.connectSession({ name: "My page", username: "@MyPage", password: "secret pass" }, w.owner);
    expect(view).toMatchObject({ externalAccountId: "mypage", username: "mypage", status: "CONNECTED", tokenHint: "session", hasToken: true });
    expect(JSON.stringify(view)).not.toContain("secret pass");
    // Commands never carry the password.
    expect(JSON.stringify(engine.seen)).not.toContain("secret pass");
    expect(await core.db.auditLog.count({ where: { action: "account_connected" } })).toBe(1);
  });

  it("keeps the device identity when reconnecting and asks for the 2FA code", async () => {
    let first = true;
    engine = startEngine(core.redis.duplicate(), async (_cmd, args) => {
      const id = String(args.accountId);
      if (first) {
        first = false;
        const row = await core.db.publishingAccount.findUniqueOrThrow({ where: { id } });
        // The engine saves its session (device ids, cookies) back into the row.
        const blob = { ...blobOf(row), settings: { uuids: { phone_id: "phone-1" } } };
        await core.db.publishingAccount.update({ where: { id }, data: { encryptedToken: encryptSecret(JSON.stringify(blob), core.config.encryptionKey, `account:${id}`), status: "CONNECTED" } });
        return { ok: true, result: { userId: "1", username: "mypage" } };
      }
      if (!args.verificationCode) return { ok: false, code: "AUTH_EXPIRED", message: "Two-factor authentication is on", reason: "TWO_FACTOR_REQUIRED" };
      return { ok: true, result: { userId: "1", username: "mypage" } };
    });
    await core.accounts.connectSession({ name: "My page", username: "mypage", password: "pw-1" }, w.owner);
    const err = await core.accounts.connectSession({ name: "My page", username: "mypage", password: "pw-2" }, w.owner).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: "AUTH_EXPIRED", details: { reason: "TWO_FACTOR_REQUIRED" } });
    const row = await core.db.publishingAccount.findFirstOrThrow();
    expect(blobOf(row)).toMatchObject({ password: "pw-2", settings: { uuids: { phone_id: "phone-1" } } });
    await core.accounts.connectSession({ name: "My page", username: "mypage", password: "pw-2", verificationCode: "123456" }, w.owner);
    expect(engine.seen.at(-1)!.args.verificationCode).toBe("123456");
  });

  it("is refused in other modes", async () => {
    const other = await createWorld();
    try {
      await expect(other.core.accounts.connectSession({ name: "x", username: "x", password: "y" }, other.owner)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    } finally {
      await other.core.close();
    }
  });

  it("publishes through the engine, and a retry re-uses the same upload id", async () => {
    const id = crypto.randomUUID();
    const token = encryptSecret(JSON.stringify({ kind: "ig-session", username: "mypage", password: "pw", sessionid: null, settings: {} }), core.config.encryptionKey, `account:${id}`);
    const account = await core.db.publishingAccount.create({ data: { id, name: "My page", platform: "INSTAGRAM", externalAccountId: "mypage", status: "CONNECTED", encryptedToken: token, tokenHint: "session" } });
    let calls = 0;
    engine = startEngine(core.redis.duplicate(), async (cmd) => {
      expect(cmd).toBe("publish");
      calls += 1;
      if (calls === 1) return { ok: false, code: "RATE_LIMITED", message: "Instagram asked to slow down", retryAfterMs: 60_000 };
      return { ok: true, result: { externalPostId: "91", permalink: "https://www.instagram.com/reel/C91/" } };
    });
    const c = await seedReadyContent(w);
    const post = await core.db.scheduledPost.create({ data: { contentId: c.id, accountId: account.id, scheduledAt: new Date(Date.now() - 1000), status: "SCHEDULED", dedupeKey: `${c.id}:${account.id}` } });

    expect((await core.publishing.publish(post.id)).result).toBe("retry");
    const paused = await core.db.publishingAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(paused.safetyState).toBe("PAUSED");
    const first = await core.db.scheduledPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(first.containerId).toMatch(/^ig-session:/);

    // Pause and backoff over: the retry must use the same container id.
    await core.db.publishingAccount.update({ where: { id: account.id }, data: { safetyState: "HEALTHY", pausedUntil: null } });
    await core.db.scheduledPost.update({ where: { id: post.id }, data: { nextAttemptAt: null } });
    expect((await core.publishing.publish(post.id)).result).toBe("published");
    const saved = await core.db.scheduledPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved).toMatchObject({ status: "PUBLISHED", externalPostId: "91", permalink: "https://www.instagram.com/reel/C91/" });
    const [a1, a2] = engine.seen;
    expect(a1!.args.containerId).toBe(first.containerId);
    expect(a2!.args.containerId).toBe(first.containerId);
    expect(a2!.args).toMatchObject({ externalAccountId: "mypage", kind: "REEL", mediaType: "VIDEO", filePath: core.storage.resolve("processed/2026/10/x.mp4") });
    expect(String(a2!.args.caption)).toContain("funnypage");
  });
});
