/**
 * Turns a weekly schedule into concrete UTC publishing slots, in the schedule's timezone.
 * DST and non-DST zones (e.g. Asia/Tehran, which has no DST since 2022) are handled by Luxon.
 */
import { DateTime, Interval } from "luxon";
import type { Weekday } from "@reelflow/types";

export interface DayPlan {
  times?: string[];
  windows?: { start: string; end: string }[];
  postsInWindows?: number;
}

export interface WeeklyPlan {
  timezone: string;
  postsPerDay: number;
  minIntervalMinutes: number;
  days: Partial<Record<Weekday, DayPlan>>;
}

const LUXON_WEEKDAY: Record<number, Weekday> = { 1: "MON", 2: "TUE", 3: "WED", 4: "THU", 5: "FRI", 6: "SAT", 7: "SUN" };

export function isValidTimezone(tz: string): boolean {
  return DateTime.now().setZone(tz).isValid;
}

const parseHHMM = (s: string) => {
  const [h, m] = s.split(":").map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
};

/** Evenly distributes `count` slots inside windows, proportional to window length. */
function spreadInWindows(day: DateTime, windows: { start: string; end: string }[], count: number): DateTime[] {
  if (count <= 0 || windows.length === 0) return [];
  const intervals = windows
    .map((w) => Interval.fromDateTimes(day.set(parseHHMM(w.start)), day.set(parseHHMM(w.end))))
    .filter((i) => i.isValid && i.length("minutes") > 0);
  const total = intervals.reduce((acc, i) => acc + i.length("minutes"), 0);
  if (total === 0) return [];
  const step = total / count;
  const out: DateTime[] = [];
  for (let k = 0; k < count; k++) {
    let offset = step * k + step / 2; // centre of each segment
    for (const i of intervals) {
      const len = i.length("minutes");
      if (offset < len) {
        out.push(i.start!.plus({ minutes: Math.round(offset) }));
        break;
      }
      offset -= len;
    }
  }
  return out;
}

/** Candidate local times for one calendar day (before interval/limit filtering). */
export function slotsForDay(plan: WeeklyPlan, localDay: DateTime): DateTime[] {
  const weekday = LUXON_WEEKDAY[localDay.weekday]!;
  const dp = plan.days[weekday];
  if (!dp) return [];
  const day = localDay.startOf("day");
  const fixed = (dp.times ?? []).map((t) => day.set(parseHHMM(t)));
  const windowed = fixed.length > 0 ? [] : spreadInWindows(day, dp.windows ?? [], dp.postsInWindows ?? 0);
  return [...fixed, ...windowed].sort((a, b) => a.toMillis() - b.toMillis());
}

/** Drops slots closer than `minIntervalMinutes` to the previous kept slot (or to `after`). */
export function enforceMinInterval(slots: DateTime[], minIntervalMinutes: number, after?: DateTime): DateTime[] {
  const out: DateTime[] = [];
  let last = after;
  for (const s of slots) {
    if (!last || s.diff(last, "minutes").minutes >= minIntervalMinutes) {
      out.push(s);
      last = s;
    }
  }
  return out;
}

/**
 * All slots in [from, to), as UTC JS Dates, honouring postsPerDay and min interval.
 */
export function generateSlots(plan: WeeklyPlan, from: Date, to: Date): Date[] {
  if (!isValidTimezone(plan.timezone)) throw new Error(`Invalid timezone ${plan.timezone}`);
  const start = DateTime.fromJSDate(from).setZone(plan.timezone);
  const end = DateTime.fromJSDate(to).setZone(plan.timezone);
  const result: DateTime[] = [];
  for (let day = start.startOf("day"); day < end; day = day.plus({ days: 1 })) {
    const perDay = enforceMinInterval(slotsForDay(plan, day), plan.minIntervalMinutes, result.at(-1)).slice(
      0,
      plan.postsPerDay,
    );
    for (const s of perDay) if (s >= start && s < end) result.push(s);
  }
  return result.map((d) => d.toUTC().toJSDate());
}

/** Formats a UTC date in the schedule's zone — e.g. "Sat 18:30". */
export function formatLocal(date: Date, timezone: string, format = "ccc HH:mm"): string {
  return DateTime.fromJSDate(date).setZone(timezone).toFormat(format);
}
