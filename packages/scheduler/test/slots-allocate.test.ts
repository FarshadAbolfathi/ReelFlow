import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { allocate, exceedsRollingWindow, formatLocal, generateSlots, type WeeklyPlan } from "../src/index";

const tehran = (iso: string) => DateTime.fromISO(iso, { zone: "Asia/Tehran" }).toJSDate();
const local = (d: Date, tz = "Asia/Tehran") => DateTime.fromJSDate(d).setZone(tz).toFormat("ccc HH:mm");

const plan: WeeklyPlan = {
  timezone: "Asia/Tehran",
  postsPerDay: 3,
  minIntervalMinutes: 60,
  days: {
    MON: { times: ["09:00", "14:00", "20:00"] },
    TUE: { times: ["10:00", "16:00", "21:00"] },
    WED: { times: ["12:00", "18:00"] },
    SAT: { windows: [{ start: "10:00", end: "12:00" }, { start: "18:00", end: "22:00" }], postsInWindows: 3 },
  },
};

describe("generateSlots", () => {
  it("produces the configured local times in Asia/Tehran (UTC+03:30)", () => {
    // 2026-09-28 is a Monday
    const slots = generateSlots(plan, tehran("2026-09-28T00:00"), tehran("2026-10-01T00:00"));
    expect(slots.map((d) => local(d))).toEqual([
      "Mon 09:00", "Mon 14:00", "Mon 20:00",
      "Tue 10:00", "Tue 16:00", "Tue 21:00",
      "Wed 12:00", "Wed 18:00",
    ]);
    // 09:00 Tehran == 05:30 UTC
    expect(slots[0]!.toISOString()).toBe("2026-09-28T05:30:00.000Z");
  });

  it("spreads posts evenly inside windows proportional to their length", () => {
    // 2026-10-03 is a Saturday: 2h + 4h windows, 3 posts → one every 2h of window time
    const slots = generateSlots(plan, tehran("2026-10-03T00:00"), tehran("2026-10-04T00:00"));
    expect(slots.map((d) => local(d))).toEqual(["Sat 11:00", "Sat 19:00", "Sat 21:00"]);
  });

  it("caps at postsPerDay and enforces the minimum interval", () => {
    const tight: WeeklyPlan = {
      timezone: "Asia/Tehran",
      postsPerDay: 2,
      minIntervalMinutes: 90,
      days: { MON: { times: ["09:00", "09:30", "12:00", "15:00"] } },
    };
    const slots = generateSlots(tight, tehran("2026-09-28T00:00"), tehran("2026-09-29T00:00"));
    expect(slots.map((d) => local(d))).toEqual(["Mon 09:00", "Mon 12:00"]);
  });

  it("excludes slots before `from`", () => {
    const slots = generateSlots(plan, tehran("2026-09-28T15:00"), tehran("2026-09-29T00:00"));
    expect(slots.map((d) => local(d))).toEqual(["Mon 20:00"]);
  });

  it("keeps wall-clock times across a DST change (Europe/Berlin, 2026-10-25)", () => {
    const berlin: WeeklyPlan = { timezone: "Europe/Berlin", postsPerDay: 1, minIntervalMinutes: 60, days: { SAT: { times: ["09:00"] }, SUN: { times: ["09:00"] } } };
    const from = DateTime.fromISO("2026-10-24T00:00", { zone: "Europe/Berlin" }).toJSDate();
    const to = DateTime.fromISO("2026-10-26T00:00", { zone: "Europe/Berlin" }).toJSDate();
    const slots = generateSlots(berlin, from, to);
    expect(slots.map((d) => local(d, "Europe/Berlin"))).toEqual(["Sat 09:00", "Sun 09:00"]);
    expect(slots.map((d) => d.toISOString())).toEqual(["2026-10-24T07:00:00.000Z", "2026-10-25T08:00:00.000Z"]);
  });

  it("rejects invalid timezones", () => {
    expect(() => generateSlots({ ...plan, timezone: "Mars/Olympus" }, new Date(), new Date())).toThrow();
  });

  it("formats in the schedule zone", () => {
    expect(formatLocal(new Date("2026-10-03T15:00:00Z"), "Asia/Tehran")).toBe("Sat 18:30");
  });
});

describe("exceedsRollingWindow", () => {
  const m = 60_000;
  it("catches a window that straddles the new slot", () => {
    expect(exceedsRollingWindow([-30 * m, 20 * m], 0, 60 * m, 2)).toBe(true);
    expect(exceedsRollingWindow([-40 * m, 40 * m], 0, 60 * m, 2)).toBe(false);
  });
  it("allows spaced events", () => {
    expect(exceedsRollingWindow([-61 * m, 61 * m], 0, 60 * m, 1)).toBe(false);
  });
});

describe("allocate", () => {
  const limits = { maxPostsPerDay: 10, maxPostsPerHour: 1, minPostIntervalMinutes: 60, maxPostsPerSourcePerDay: 10 };
  const slots = generateSlots(
    { timezone: "Asia/Tehran", postsPerDay: 6, minIntervalMinutes: 60, days: { MON: { times: ["08:00", "10:00", "12:00", "14:00", "16:00", "18:00"] } } },
    tehran("2026-09-28T00:00"),
    tehran("2026-09-29T00:00"),
  );
  const cands = (src: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ contentId: `${src}${i}`, sourceId: src, kind: "REEL" }));

  it("interleaves sources by weight instead of bursting one source", () => {
    const out = allocate({ slots, candidates: [...cands("A", 6), ...cands("B", 6)], existing: [], limits, timezone: "Asia/Tehran", sourceWeights: { A: 2, B: 1 } });
    expect(out.map((a) => a.contentId[0]).join("")).toBe("ABAABA");
  });

  it("respects the per-source daily cap", () => {
    const out = allocate({ slots, candidates: cands("A", 6), existing: [], limits: { ...limits, maxPostsPerSourcePerDay: 2 }, timezone: "Asia/Tehran" });
    expect(out).toHaveLength(2);
  });

  it("counts posts already on the calendar toward the daily cap", () => {
    const existing = [tehran("2026-09-28T07:00"), tehran("2026-09-28T21:00")].map((scheduledAt) => ({ scheduledAt, sourceId: "X" }));
    const out = allocate({ slots, candidates: cands("A", 6), existing, limits: { ...limits, maxPostsPerDay: 4 }, timezone: "Asia/Tehran" });
    expect(out).toHaveLength(2);
  });

  it("skips slots too close to existing posts", () => {
    const existing = [{ scheduledAt: tehran("2026-09-28T10:30"), sourceId: "X" }];
    const out = allocate({ slots, candidates: cands("A", 6), existing, limits, timezone: "Asia/Tehran" });
    expect(out.map((a) => local(a.scheduledAt))).not.toContain("Mon 10:00");
  });

  it("never allocates the same content twice", () => {
    const out = allocate({ slots, candidates: cands("A", 2), existing: [], limits, timezone: "Asia/Tehran" });
    expect(new Set(out.map((o) => o.contentId)).size).toBe(out.length);
    expect(out).toHaveLength(2);
  });

  it("gives zero-weight sources nothing", () => {
    const out = allocate({ slots, candidates: [...cands("A", 3), ...cands("B", 3)], existing: [], limits, timezone: "Asia/Tehran", sourceWeights: { B: 0 } });
    expect(out.every((o) => o.contentId.startsWith("A"))).toBe(true);
  });
});
