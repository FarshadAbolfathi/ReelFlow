import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { QUEUES, jobIds } from "@reelflow/types";
import { approvedSource, createWorld, seedAccount, seedReadyContent, type TestWorld } from "./helpers";

let w: TestWorld;
beforeEach(async () => {
  w = await createWorld();
});
afterEach(async () => {
  await w.core.close();
});

const inMinutes = (m: number) => new Date(Date.now() + m * 60_000).toISOString();
const sourceInput = (name: string) => ({
  name,
  url: `https://example.com/${name}.xml`,
  platform: "GENERIC_FEED" as const,
  active: true,
  allowedMediaTypes: ["VIDEO" as const],
  importFrequencyMinutes: 360,
  maxItemsPerInterval: 5,
  approvalRequired: true,
  attributionRequired: true,
  rightsStatus: "PERMISSION_GRANTED" as const,
});

describe("source vetting (owner approves pages, not the employer)", () => {
  it("a MANAGER's source waits for OWNER review and cannot be imported", async () => {
    const s = await w.core.sources.create(sourceInput("mgr"), w.manager);
    expect(s.vettingStatus).toBe("PENDING_REVIEW");
    await expect(w.core.sources.requestDiscovery(s.id, w.manager, "user")).rejects.toMatchObject({ code: "SOURCE_NOT_APPROVED" });
  });

  it("only an OWNER can approve", async () => {
    const s = await w.core.sources.create(sourceInput("mgr2"), w.manager);
    await expect(w.core.sources.review(s.id, "APPROVED", undefined, w.manager)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const approved = await w.core.sources.review(s.id, "APPROVED", "checked the page", w.owner);
    expect(approved.vettingStatus).toBe("APPROVED");
    await expect(w.core.sources.requestDiscovery(s.id, w.manager, "user")).resolves.toHaveProperty("jobId");
  });

  it("a MANAGER changing the URL of an approved source sends it back to review", async () => {
    const s = await approvedSource(w, "owner-page");
    expect(s.vettingStatus).toBe("APPROVED");
    const changed = await w.core.sources.update(s.id, { ...sourceInput("other-page") }, w.manager);
    expect(changed.vettingStatus).toBe("PENDING_REVIEW");
  });

  it("rejects SSRF-style source URLs", async () => {
    await expect(w.core.sources.create({ ...sourceInput("x"), url: "http://169.254.169.254/latest" }, w.owner)).rejects.toMatchObject({ code: "URL_BLOCKED" });
  });

  it("VIEWERs cannot propose sources", async () => {
    await expect(w.core.sources.create(sourceInput("v"), w.viewer)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("records source_created in the audit log", async () => {
    await approvedSource(w, "audited");
    const { items } = await w.core.audit.search({ action: "source_created", page: 1, pageSize: 10 });
    expect(items).toHaveLength(1);
  });
});

describe("settings & policy ceilings", () => {
  it("refuses 20 posts/day when the operator ceiling is 10", async () => {
    await expect(w.core.settings.update("publishing", { maxPostsPerDay: 20 }, w.manager)).rejects.toMatchObject({ code: "POLICY_LIMIT_EXCEEDED" });
  });

  it("allows turning on auto-publish and logs settings_changed", async () => {
    const s = await w.core.settings.update("publishing", { autoPublishEnabled: true, maxPostsPerDay: 10 }, w.manager);
    expect(s.publishing.autoPublishEnabled).toBe(true);
    const { items } = await w.core.audit.search({ action: "settings_changed", page: 1, pageSize: 5 });
    expect(items[0]?.summary).toContain("autoPublishEnabled");
  });

  it("an operator can lower the ceiling via env", async () => {
    await w.core.close();
    w = await createWorld({ POLICY_MAX_POSTS_PER_DAY: "3" });
    await expect(w.core.settings.update("publishing", { maxPostsPerDay: 5 }, w.owner)).rejects.toMatchObject({ code: "POLICY_LIMIT_EXCEEDED" });
  });
});

describe("accounts", () => {
  it("encrypts the token and never exposes it", async () => {
    const a = await seedAccount(w);
    expect(a).not.toHaveProperty("encryptedToken");
    expect(JSON.stringify(a)).not.toContain("EAAtest-token");
    const row = await w.core.db.publishingAccount.findUniqueOrThrow({ where: { id: a.id } });
    expect(row.encryptedToken).toMatch(/^v1\./);
    expect(row.encryptedToken).not.toContain("EAAtest");
    expect((await w.core.accounts.token(a.id)).accessToken).toBe("EAAtest-token-abcdefghijkl");
  });
});

describe("manual scheduling respects limits", () => {
  it("prevents double-scheduling the same content on the same account", async () => {
    const a = await seedAccount(w);
    const c = await seedReadyContent(w);
    await w.core.scheduling.schedulePost({ contentId: c.id, accountId: a.id, kind: "REEL", scheduledAt: inMinutes(120) }, w.manager);
    await expect(w.core.scheduling.schedulePost({ contentId: c.id, accountId: a.id, kind: "REEL", scheduledAt: inMinutes(300) }, w.manager)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects posts closer than the minimum interval", async () => {
    const a = await seedAccount(w);
    const [c1, c2] = [await seedReadyContent(w), await seedReadyContent(w)];
    await w.core.scheduling.schedulePost({ contentId: c1.id, accountId: a.id, kind: "REEL", scheduledAt: inMinutes(120) }, w.manager);
    await expect(w.core.scheduling.schedulePost({ contentId: c2.id, accountId: a.id, kind: "REEL", scheduledAt: inMinutes(150) }, w.manager)).rejects.toMatchObject({ code: "POLICY_LIMIT_EXCEEDED" });
  });

  it("caps the number of posts per day even when scheduled by hand", async () => {
    await w.core.close();
    w = await createWorld({ POLICY_MAX_POSTS_PER_DAY: "3", POLICY_MIN_POST_INTERVAL_MINUTES: "30", POLICY_MAX_POSTS_PER_HOUR: "3" });
    await w.core.settings.update("publishing", { maxPostsPerDay: 3, minPostIntervalMinutes: 30, maxPostsPerHour: 1 }, w.owner);
    const a = await seedAccount(w);
    const day = DateTime.now().setZone("Asia/Tehran").plus({ days: 2 }).startOf("day");
    for (let i = 0; i < 3; i++) {
      const c = await seedReadyContent(w);
      await w.core.scheduling.schedulePost({ contentId: c.id, accountId: a.id, kind: "REEL", scheduledAt: day.plus({ hours: 9 + i * 3 }).toUTC().toISO()! }, w.manager);
    }
    const fourth = await seedReadyContent(w);
    await expect(
      w.core.scheduling.schedulePost({ contentId: fourth.id, accountId: a.id, kind: "REEL", scheduledAt: day.plus({ hours: 21 }).toUTC().toISO()! }, w.manager),
    ).rejects.toMatchObject({ code: "POLICY_LIMIT_EXCEEDED" });
  });

  it("unapproved content waits for approval, then becomes SCHEDULED on approval", async () => {
    const a = await seedAccount(w);
    const c = await seedReadyContent(w, { approved: false });
    const post = await w.core.scheduling.schedulePost({ contentId: c.id, accountId: a.id, kind: "REEL", scheduledAt: inMinutes(120) }, w.manager);
    expect(post.status).toBe("WAITING_APPROVAL");
    await w.core.content.decide(c.id, "APPROVED", undefined, w.manager);
    expect((await w.core.db.scheduledPost.findUniqueOrThrow({ where: { id: post.id } })).status).toBe("SCHEDULED");
  });
});

async function duePost(world: TestWorld, opts: Parameters<typeof seedReadyContent>[1] = {}) {
  const a = (await world.core.db.publishingAccount.findFirst()) ?? (await seedAccount(world));
  const c = await seedReadyContent(world, opts);
  const post = await world.core.scheduling.schedulePost({ contentId: c.id, accountId: a.id, kind: "REEL", scheduledAt: inMinutes(5 + Math.floor(Math.random() * 1000) * 0) }, world.manager);
  // Make it due without waiting.
  await world.core.db.scheduledPost.update({ where: { id: post.id }, data: { scheduledAt: new Date(Date.now() - 1000) } });
  return { post, account: a, content: c };
}

describe("publishing flow (mock platform adapter)", () => {
  it("publishes, records the attempt, and is idempotent", async () => {
    const { post, content } = await duePost(w);
    const r = await w.core.publishing.publish(post.id);
    expect(r.result).toBe("published");
    const saved = await w.core.db.scheduledPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved.status).toBe("PUBLISHED");
    expect(saved.finalCaption).toContain("funnypage"); // attribution kept
    expect((await w.core.db.content.findUniqueOrThrow({ where: { id: content.id } })).publishStatus).toBe("PUBLISHED");
    expect(await w.core.db.publishAttempt.count({ where: { scheduledPostId: post.id, status: "SUCCEEDED" } })).toBe(1);

    const again = await w.core.publishing.publish(post.id);
    expect(again.result).toBe("skipped");
    expect(w.mock.published.size).toBe(1);
  });

  it("on 429: pauses the account, schedules a retry, and defers other posts", async () => {
    w.mock.failNext({ step: "publishPost", code: "RATE_LIMITED", retryAfterMs: 3_600_000 });
    const { post, account } = await duePost(w);
    const r = await w.core.publishing.publish(post.id);
    expect(r.result).toBe("retry");
    const acc = await w.core.db.publishingAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(acc.safetyState).toBe("PAUSED");
    expect(acc.pausedUntil!.getTime()).toBeGreaterThanOrEqual(Date.now() + 3_500_000);
    const saved = await w.core.db.scheduledPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(saved.status).toBe("SCHEDULED");
    expect(saved.nextAttemptAt!.getTime()).toBeGreaterThanOrEqual(acc.pausedUntil!.getTime());
    expect(saved.containerId).not.toBeNull(); // re-used on retry — no duplicate upload

    // Another due post on the same account must not publish while paused.
    const other = await seedReadyContent(w, { rights: "USER_OWNS" });
    const p2 = await w.core.db.scheduledPost.create({ data: { contentId: other.id, accountId: account.id, scheduledAt: new Date(Date.now() - 1000), status: "SCHEDULED", dedupeKey: `${other.id}:${account.id}` } });
    const r2 = await w.core.publishing.publish(p2.id);
    expect(r2.result).toBe("deferred");
    expect(w.mock.published.size).toBe(0);
  });

  it("expired auth pauses the account until someone reconnects", async () => {
    w.mock.failNext({ step: "createPost", code: "AUTH_EXPIRED" });
    const { post, account } = await duePost(w);
    expect((await w.core.publishing.publish(post.id)).result).toBe("failed");
    const acc = await w.core.db.publishingAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(acc).toMatchObject({ safetyState: "PAUSED", pausedUntil: null, status: "AUTH_EXPIRED" });
    expect(await w.core.notifications.unreadCount()).toBeGreaterThan(0);
  });

  it("never publishes content with unknown rights", async () => {
    const { post } = await duePost(w, { rights: "UNKNOWN" });
    const r = await w.core.publishing.publish(post.id);
    expect(r.result).toBe("blocked");
    expect(w.mock.published.size).toBe(0);
  });

  it("the gate enforces the daily cap at publish time", async () => {
    await w.core.close();
    w = await createWorld({ POLICY_MAX_POSTS_PER_DAY: "1", POLICY_MIN_POST_INTERVAL_MINUTES: "20" });
    await w.core.settings.update("publishing", { maxPostsPerDay: 1, minPostIntervalMinutes: 20 }, w.owner);
    const first = await duePost(w);
    expect((await w.core.publishing.publish(first.post.id)).result).toBe("published");
    const other = await seedReadyContent(w);
    const p2 = await w.core.db.scheduledPost.create({ data: { contentId: other.id, accountId: first.account.id, scheduledAt: new Date(Date.now() - 1000), status: "SCHEDULED", dedupeKey: "x" } });
    const r = await w.core.publishing.publish(p2.id);
    expect(r.result).toBe("deferred");
    expect(w.mock.published.size).toBe(1);
  });

  it("auto-scheduled posts are not published while auto-publish is off", async () => {
    const { post } = await duePost(w);
    await w.core.db.scheduledPost.update({ where: { id: post.id }, data: { autoScheduled: true } });
    expect((await w.core.publishing.publish(post.id)).result).toBe("blocked");
  });

  it("retries transient failures with backoff, then fails after the retry budget", async () => {
    w.mock.failAlways({ step: "createPost", code: "PUBLISH_FAILED" });
    const { post } = await duePost(w);
    const outcomes: string[] = [];
    for (let i = 0; i < 5; i++) {
      await w.core.db.scheduledPost.update({ where: { id: post.id }, data: { nextAttemptAt: null } });
      await w.core.db.publishingAccount.updateMany({ data: { safetyState: "HEALTHY", pausedUntil: null } });
      outcomes.push((await w.core.publishing.publish(post.id)).result);
      if (outcomes.at(-1) === "failed") break;
    }
    expect(outcomes).toEqual(["retry", "retry", "retry", "failed"]);
  });
});

describe("auto-scheduling", () => {
  it("fills slots only when auto-publish is enabled, respecting the daily cap", async () => {
    const a = await seedAccount(w);
    for (let i = 0; i < 8; i++) await seedReadyContent(w);
    const schedule = await w.core.scheduling.upsertSchedule(
      null,
      {
        name: "Daily",
        accountId: a.id,
        timezone: "Asia/Tehran",
        active: true,
        postsPerDay: 3,
        minIntervalMinutes: 90,
        maxIntervalMinutes: null,
        days: Object.fromEntries(["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"].map((d) => [d, { times: ["09:00", "14:00", "20:00"], windows: [], postsInWindows: 0 }])),
        sourceWeights: {},
        contentKindWeights: {},
      },
      w.owner,
    );
    expect((await w.core.scheduling.autoFill(schedule.id)).created).toBe(0); // auto-publish off
    await w.core.settings.update("publishing", { autoPublishEnabled: true }, w.owner);
    const r = await w.core.scheduling.autoFill(schedule.id, { horizonDays: 2 });
    expect(r.created).toBeGreaterThan(0);
    const posts = await w.core.db.scheduledPost.findMany({ where: { accountId: a.id } });
    const perDay = new Map<string, number>();
    for (const p of posts) {
      const d = DateTime.fromJSDate(p.scheduledAt).setZone("Asia/Tehran").toISODate()!;
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    expect(Math.max(...perDay.values())).toBeLessThanOrEqual(3);
    expect(posts.every((p) => p.autoScheduled)).toBe(true);
    // Running again creates nothing new for the same slots (idempotent).
    const again = await w.core.scheduling.autoFill(schedule.id, { horizonDays: 2 });
    expect(again.created).toBe(0);
  });
});

describe("queue idempotency", () => {
  it("adding a job with the same id twice yields one job", async () => {
    const id = jobIds.processing("test", "INSTAGRAM_REEL", "abc");
    await w.core.queues.add(QUEUES.mediaProcessing, { contentId: "x", presetKey: "INSTAGRAM_REEL" }, { jobId: id, delay: 60_000 });
    await w.core.queues.add(QUEUES.mediaProcessing, { contentId: "x", presetKey: "INSTAGRAM_REEL" }, { jobId: id, delay: 60_000 });
    const counts = await w.core.queues.queue(QUEUES.mediaProcessing).getJobCounts("delayed");
    expect(counts.delayed).toBe(1);
  });

  it("dispatchDue does not enqueue the same post twice", async () => {
    const { post } = await duePost(w);
    await w.core.publishing.dispatchDue();
    await w.core.publishing.dispatchDue();
    const jobs = await w.core.queues.queue(QUEUES.publishing).getJobs(["waiting", "delayed", "prioritized"]);
    expect(jobs.filter((j) => j.data.scheduledPostId === post.id)).toHaveLength(1);
  });
});

describe("authentication", () => {
  it("logs in, resolves the session, and locks out after repeated failures", async () => {
    const { token, session } = await w.core.auth.login("owner@test.local", "integration-test-password", { ip: "127.0.0.1" });
    expect(session.user.role).toBe("OWNER");
    expect((await w.core.auth.resolve(token))?.user.email).toBe("owner@test.local");
    expect(await w.core.auth.resolve("forged-token")).toBeNull();
    for (let i = 0; i < 5; i++) await expect(w.core.auth.login("manager@test.local", "wrong-password!!", { ip: "10.0.0.9" })).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(w.core.auth.login("manager@test.local", "integration-test-password", { ip: "10.0.0.9" })).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("stores only a hash of the session token", async () => {
    const { token } = await w.core.auth.login("owner@test.local", "integration-test-password", { ip: "127.0.0.1" });
    const rows = await w.core.db.session.findMany();
    expect(rows.every((r) => r.tokenHash !== token)).toBe(true);
  });
});
