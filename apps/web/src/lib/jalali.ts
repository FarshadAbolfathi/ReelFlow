import type { DateTime } from "luxon";

/** Jalali (Solar Hijri) parts of a date, via the platform's Intl persian calendar. */
const partsFmt = new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn", { year: "numeric", month: "numeric", day: "numeric", timeZone: "UTC" });

export function jalaliParts(d: DateTime): { year: number; month: number; day: number } {
  // Use the wall-clock date in the DateTime's zone.
  const utc = Date.UTC(d.year, d.month - 1, d.day, 12);
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(utc)).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

/** First day of the Jalali month containing `d` (walks back day by day; ≤ 30 steps). */
export function startOfJalaliMonth(d: DateTime): DateTime {
  let cur = d.startOf("day");
  while (jalaliParts(cur).day > 1) cur = cur.minus({ days: 1 });
  return cur;
}

export function jalaliMonthTitle(d: DateTime): string {
  const utc = Date.UTC(d.year, d.month - 1, d.day, 12);
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { year: "numeric", month: "long", timeZone: "UTC" }).format(new Date(utc));
}

export function jalaliDayLabel(d: DateTime, opts: Intl.DateTimeFormatOptions): string {
  const utc = Date.UTC(d.year, d.month - 1, d.day, 12);
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", { ...opts, timeZone: "UTC" }).format(new Date(utc));
}
