import { DateTime } from "luxon";
import type { Locale } from "./i18n";

export const DEFAULT_TZ = "Asia/Tehran";

const intl = (locale: Locale) => (locale === "fa" ? "fa-IR" : "en-GB");

/** "شنبه ۱۸:۳۰" — weekday + time in the configured timezone. */
export function formatSlot(iso: string | Date, locale: Locale, tz = DEFAULT_TZ): string {
  const d = typeof iso === "string" ? DateTime.fromISO(iso) : DateTime.fromJSDate(iso);
  return d.setZone(tz).setLocale(intl(locale)).toFormat("cccc HH:mm");
}

export function formatDateTime(iso: string | Date | null | undefined, locale: Locale, tz = DEFAULT_TZ): string {
  if (!iso) return "—";
  const d = typeof iso === "string" ? DateTime.fromISO(iso) : DateTime.fromJSDate(iso);
  return d.setZone(tz).setLocale(intl(locale)).toLocaleString({ month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatRelative(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return "—";
  return DateTime.fromISO(iso).setLocale(intl(locale)).toRelative() ?? "—";
}

export function formatDuration(sec: number | null | undefined): string {
  if (!sec && sec !== 0) return "—";
  const s = Math.round(sec);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function formatNumber(n: number | null | undefined, locale: Locale): string {
  return n === null || n === undefined ? "—" : new Intl.NumberFormat(intl(locale)).format(n);
}

export function formatBytes(n: number | null | undefined): string {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

/** datetime-local input value (in tz) ⇄ ISO. */
export const toLocalInput = (iso: string, tz = DEFAULT_TZ) => DateTime.fromISO(iso).setZone(tz).toFormat("yyyy-MM-dd'T'HH:mm");
export const fromLocalInput = (v: string, tz = DEFAULT_TZ) => DateTime.fromISO(v, { zone: tz }).toUTC().toISO()!;
