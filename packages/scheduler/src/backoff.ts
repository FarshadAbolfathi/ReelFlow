/** Exponential backoff with full jitter, capped. attempt is 1-based. */
export function computeBackoffMs(
  attempt: number,
  opts: { baseMs: number; maxMs: number; jitter?: boolean },
  random: () => number = Math.random,
): number {
  const exp = Math.min(opts.maxMs, opts.baseMs * 2 ** Math.max(0, attempt - 1));
  if (opts.jitter === false) return exp;
  // "Equal jitter": at least half the exponential delay, so retries never bunch at ~0.
  return Math.round(exp / 2 + random() * (exp / 2));
}

/**
 * Parses an HTTP Retry-After header (seconds or HTTP date). Returns ms or null.
 */
export function parseRetryAfter(value: string | null | undefined, now: Date = new Date()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now.getTime());
}

/** The platform's Retry-After always wins if it asks us to wait longer than our own backoff. */
export function nextRetryDelayMs(attempt: number, retryAfterMs: number | null, opts: { baseMs: number; maxMs: number }, random?: () => number): number {
  const own = computeBackoffMs(attempt, opts, random);
  return retryAfterMs === null ? own : Math.max(own, retryAfterMs);
}
