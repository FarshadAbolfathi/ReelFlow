import { describe, expect, it } from "vitest";
import {
  ABSOLUTE_LIMITS,
  assertWithinCeilings,
  defaultSettings,
  effectiveLimits,
  mergeSettings,
  resolveCeilings,
  validateSectionUpdate,
} from "../src/index";

describe("policy ceilings", () => {
  it("defaults to 10 posts/day", () => {
    expect(resolveCeilings({}).maxPostsPerDay).toBe(10);
  });

  it("clamps operator env values to absolute limits", () => {
    const c = resolveCeilings({ maxPostsPerDay: 500, maxPostsPerHour: 50, minPostIntervalMinutes: 1 });
    expect(c.maxPostsPerDay).toBe(ABSOLUTE_LIMITS.maxPostsPerDay);
    expect(c.maxPostsPerHour).toBe(ABSOLUTE_LIMITS.maxPostsPerHour);
    expect(c.minPostIntervalMinutes).toBe(ABSOLUTE_LIMITS.minPostIntervalMinutes);
  });

  it("rejects a MANAGER asking for 20 posts/day when the ceiling is 10", () => {
    const ceilings = resolveCeilings({ maxPostsPerDay: 10 });
    expect(() =>
      assertWithinCeilings(
        { maxPostsPerDay: 20, maxPostsPerHour: 1, minPostIntervalMinutes: 90, maxPostsPerSourcePerDay: 2 },
        ceilings,
      ),
    ).toThrow(expect.objectContaining({ code: "POLICY_LIMIT_EXCEEDED" }));
  });

  it("accepts limits at or below the ceiling", () => {
    const ceilings = resolveCeilings({});
    expect(() =>
      assertWithinCeilings(
        { maxPostsPerDay: 10, maxPostsPerHour: 2, minPostIntervalMinutes: 60, maxPostsPerSourcePerDay: 4 },
        ceilings,
      ),
    ).not.toThrow();
  });

  it("effective limits are the stricter of the two", () => {
    const e = effectiveLimits(
      { maxPostsPerDay: 50, maxPostsPerHour: 1, minPostIntervalMinutes: 5, maxPostsPerSourcePerDay: 99 },
      resolveCeilings({}),
    );
    expect(e).toEqual({ maxPostsPerDay: 10, maxPostsPerHour: 1, minPostIntervalMinutes: 60, maxPostsPerSourcePerDay: 4 });
  });
});

describe("settings", () => {
  const ceilings = resolveCeilings({});

  it("defaults: SEMI_AUTO, auto-publish off, Asia/Tehran", () => {
    const s = defaultSettings(ceilings);
    expect(s.approval.mode).toBe("SEMI_AUTO");
    expect(s.publishing.autoPublishEnabled).toBe(false);
    expect(s.general.timezone).toBe("Asia/Tehran");
    expect(s.safety.blockUnknownRights).toBe(true);
  });

  it("enables auto-publish through a validated update", () => {
    const s = defaultSettings(ceilings);
    const pub = validateSectionUpdate(s, "publishing", { autoPublishEnabled: true }, ceilings);
    expect(pub.autoPublishEnabled).toBe(true);
  });

  it("refuses publishing limits above the ceiling", () => {
    const s = defaultSettings(ceilings);
    expect(() => validateSectionUpdate(s, "publishing", { maxPostsPerDay: 20 }, ceilings)).toThrow(
      expect.objectContaining({ code: "POLICY_LIMIT_EXCEEDED" }),
    );
  });

  it("ignores corrupt stored sections instead of crashing", () => {
    const d = defaultSettings(ceilings);
    const merged = mergeSettings(d, { approval: { mode: "YOLO" }, general: { brandName: "Mine" } });
    expect(merged.approval.mode).toBe("SEMI_AUTO");
    expect(merged.general.brandName).toBe("Mine");
  });
});
