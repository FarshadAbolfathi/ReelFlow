import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAFETY_POLICY,
  applySafetyEvent,
  computeBackoffMs,
  evaluatePublishGate,
  nextRetryDelayMs,
  parseRetryAfter,
  resolveExpiredPause,
  type GateContext,
  type SafetySnapshot,
} from "../src/index";

const NOW = new Date("2026-10-01T12:00:00Z");
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

function ctx(overrides: Partial<{ [K in keyof GateContext]: Partial<GateContext[K]> }> = {}): GateContext {
  const base: GateContext = {
    now: NOW,
    settings: { approvalMode: "SEMI_AUTO", autoPublishEnabled: true, blockUnknownRights: true, requireAttributionForThirdParty: true },
    limits: { maxPostsPerDay: 10, maxPostsPerHour: 2, minPostIntervalMinutes: 60, maxPostsPerSourcePerDay: 4 },
    account: { status: "CONNECTED", safetyState: "HEALTHY", pausedUntil: null, dailyLimit: null },
    content: { processingStatus: "READY", approvalStatus: "APPROVED", rightsStatus: "PERMISSION_GRANTED", isDuplicate: false, hasPublishableAsset: true },
    source: { active: true, vettingStatus: "APPROVED", attributionRequired: true },
    post: { autoScheduled: false, caption: "Funny clip\n\n🎬 via @funnypage", attributionText: "via @funnypage" },
    recentPublishes: [],
    recentSourcePublishes: 0,
  };
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(overrides)) {
    const b = (base as unknown as Record<string, unknown>)[k];
    out[k] = Array.isArray(v) || v === null || typeof v !== "object" || v instanceof Date ? v : { ...(b as object), ...v };
  }
  return out as unknown as GateContext;
}

const codes = (c: GateContext) => evaluatePublishGate(c).violations.map((v) => v.code);

describe("publish gate", () => {
  it("allows a fully valid post", () => {
    expect(evaluatePublishGate(ctx())).toMatchObject({ allowed: true, violations: [] });
  });

  it("blocks the 11th post in 24h when the limit is 10", () => {
    const recent = Array.from({ length: 10 }, (_, i) => minsAgo(90 + i * 120));
    const r = evaluatePublishGate(ctx({ recentPublishes: recent as never }));
    expect(r.allowed).toBe(false);
    expect(r.violations[0]!.code).toBe("POLICY_LIMIT_EXCEEDED");
    expect(r.retryAt).not.toBeNull();
  });

  it("honours a stricter per-account daily limit", () => {
    const r = evaluatePublishGate(ctx({ account: { dailyLimit: 2 }, recentPublishes: [minsAgo(200), minsAgo(400)] as never }));
    expect(r.allowed).toBe(false);
  });

  it("enforces the minimum interval and computes retryAt", () => {
    const r = evaluatePublishGate(ctx({ recentPublishes: [minsAgo(30)] as never }));
    expect(r.allowed).toBe(false);
    expect(r.retryAt?.toISOString()).toBe(new Date(NOW.getTime() + 30 * 60_000).toISOString());
  });

  it("enforces the per-source daily cap", () => {
    expect(codes(ctx({ recentSourcePublishes: 4 as never }))).toContain("POLICY_LIMIT_EXCEEDED");
  });

  it("blocks sources that the owner has not approved", () => {
    expect(codes(ctx({ source: { vettingStatus: "PENDING_REVIEW" } }))).toContain("SOURCE_NOT_APPROVED");
    expect(codes(ctx({ source: { vettingStatus: "REJECTED" } }))).toContain("SOURCE_NOT_APPROVED");
  });

  it("blocks unknown rights and do-not-import", () => {
    expect(codes(ctx({ content: { rightsStatus: "UNKNOWN" } }))).toContain("RIGHTS_NOT_CONFIRMED");
    expect(codes(ctx({ content: { rightsStatus: "DO_NOT_IMPORT" } }))).toContain("RIGHTS_NOT_CONFIRMED");
  });

  it("never auto-publishes unknown rights even if blocking is switched off", () => {
    const c = ctx({ settings: { blockUnknownRights: false }, content: { rightsStatus: "UNKNOWN" }, post: { autoScheduled: true } });
    expect(codes(c)).toContain("RIGHTS_NOT_CONFIRMED");
  });

  it("requires attribution in the caption for third-party content", () => {
    expect(codes(ctx({ post: { caption: "Funny clip, no credit" } }))).toContain("RIGHTS_NOT_CONFIRMED");
    expect(codes(ctx({ post: { attributionText: null } }))).toContain("RIGHTS_NOT_CONFIRMED");
  });

  it("does not require attribution for owned content", () => {
    expect(evaluatePublishGate(ctx({ content: { rightsStatus: "USER_OWNS" }, post: { caption: "mine", attributionText: null } })).allowed).toBe(true);
  });

  it("blocks auto-scheduled posts when auto-publish is off", () => {
    expect(codes(ctx({ settings: { autoPublishEnabled: false }, post: { autoScheduled: true } }))).toContain("APPROVAL_REQUIRED");
  });

  it("still publishes manually-scheduled posts when auto-publish is off", () => {
    expect(evaluatePublishGate(ctx({ settings: { autoPublishEnabled: false } })).allowed).toBe(true);
  });

  it("MANUAL mode never publishes auto-scheduled posts", () => {
    expect(codes(ctx({ settings: { approvalMode: "MANUAL" }, post: { autoScheduled: true } }))).toContain("APPROVAL_REQUIRED");
  });

  it("requires approval and ready media", () => {
    expect(codes(ctx({ content: { approvalStatus: "PENDING" } }))).toContain("APPROVAL_REQUIRED");
    expect(codes(ctx({ content: { processingStatus: "PROCESSING" } }))).toContain("PROCESSING_FAILED");
    expect(codes(ctx({ content: { isDuplicate: true } }))).toContain("DUPLICATE_CONTENT");
  });

  it("respects a paused account until pausedUntil", () => {
    const paused = ctx({ account: { safetyState: "PAUSED", pausedUntil: new Date(NOW.getTime() + 600_000) } });
    const r = evaluatePublishGate(paused);
    expect(r.violations.map((v) => v.code)).toContain("ACCOUNT_PAUSED");
    expect(r.retryAt?.getTime()).toBe(NOW.getTime() + 600_000);
    const indefinite = ctx({ account: { safetyState: "PAUSED", pausedUntil: null } });
    expect(codes(indefinite)).toContain("ACCOUNT_PAUSED");
  });

  it("maps expired auth to AUTH_EXPIRED", () => {
    expect(codes(ctx({ account: { status: "AUTH_EXPIRED" } }))).toContain("AUTH_EXPIRED");
  });
});

describe("backoff", () => {
  it("grows exponentially and caps", () => {
    const o = { baseMs: 1000, maxMs: 10_000, jitter: false };
    expect([1, 2, 3, 4, 5, 6].map((a) => computeBackoffMs(a, o))).toEqual([1000, 2000, 4000, 8000, 10_000, 10_000]);
  });
  it("jitter stays within [exp/2, exp]", () => {
    for (let i = 0; i < 50; i++) {
      const v = computeBackoffMs(3, { baseMs: 1000, maxMs: 60_000 });
      expect(v).toBeGreaterThanOrEqual(2000);
      expect(v).toBeLessThanOrEqual(4000);
    }
  });
  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    expect(parseRetryAfter(new Date(NOW.getTime() + 5000).toUTCString(), NOW)).toBe(5000);
    expect(parseRetryAfter("garbage")).toBeNull();
  });
  it("never retries sooner than the platform asks", () => {
    expect(nextRetryDelayMs(1, 3_600_000, { baseMs: 1000, maxMs: 60_000 }, () => 0)).toBe(3_600_000);
  });
});

describe("safety monitor", () => {
  const healthy: SafetySnapshot = { safetyState: "HEALTHY", pausedUntil: null, pauseReason: null, consecutiveFailures: 0, rateLimitStrikes: 0 };

  it("pauses immediately on 429 and backs off exponentially", () => {
    const one = applySafetyEvent(healthy, { type: "failure", code: "RATE_LIMITED" }, DEFAULT_SAFETY_POLICY, NOW, () => 1);
    expect(one.safetyState).toBe("PAUSED");
    expect(one.pausedUntil!.getTime() - NOW.getTime()).toBe(15 * 60_000);
    const two = applySafetyEvent(one, { type: "failure", code: "RATE_LIMITED" }, DEFAULT_SAFETY_POLICY, NOW, () => 1);
    expect(two.pausedUntil!.getTime() - NOW.getTime()).toBe(30 * 60_000);
  });

  it("uses Retry-After when longer than the backoff", () => {
    const s = applySafetyEvent(healthy, { type: "failure", code: "RATE_LIMITED", retryAfterMs: 4 * 3_600_000 }, DEFAULT_SAFETY_POLICY, NOW);
    expect(s.pausedUntil!.getTime() - NOW.getTime()).toBe(4 * 3_600_000);
  });

  it("pauses indefinitely on expired auth", () => {
    const s = applySafetyEvent(healthy, { type: "failure", code: "AUTH_EXPIRED" }, DEFAULT_SAFETY_POLICY, NOW);
    expect(s).toMatchObject({ safetyState: "PAUSED", pausedUntil: null });
  });

  it("goes HEALTHY → WARNING → PAUSED on repeated failures", () => {
    let s = healthy;
    const states: string[] = [];
    for (let i = 0; i < 4; i++) {
      s = applySafetyEvent(s, { type: "failure", code: "PUBLISH_FAILED" }, DEFAULT_SAFETY_POLICY, NOW);
      states.push(s.safetyState);
    }
    expect(states).toEqual(["HEALTHY", "WARNING", "WARNING", "PAUSED"]);
  });

  it("recovers on success and resumes to WARNING after a timed pause", () => {
    const paused = applySafetyEvent(healthy, { type: "failure", code: "RATE_LIMITED" }, DEFAULT_SAFETY_POLICY, NOW);
    expect(resolveExpiredPause(paused, new Date(NOW.getTime() + 2 * 3_600_000)).safetyState).toBe("WARNING");
    expect(applySafetyEvent(paused, { type: "success" }, DEFAULT_SAFETY_POLICY).safetyState).toBe("HEALTHY");
  });
});
