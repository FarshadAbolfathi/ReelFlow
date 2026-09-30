/**
 * Safety monitor state machine for a publishing account.
 * Platform limits are respected, never worked around: a 429 pauses the account.
 */
import type { ErrorCode, SafetyState } from "@reelflow/types";
import { nextRetryDelayMs } from "./backoff";

export interface SafetySnapshot {
  safetyState: SafetyState;
  pausedUntil: Date | null;
  pauseReason: string | null;
  consecutiveFailures: number;
  /** How many times in a row the account was paused for rate limiting (drives backoff). */
  rateLimitStrikes: number;
}

export interface SafetyPolicy {
  baseBackoffMinutes: number;
  maxBackoffMinutes: number;
  warnAfterFailures: number;
  pauseAfterFailures: number;
}

export const DEFAULT_SAFETY_POLICY: SafetyPolicy = {
  baseBackoffMinutes: 15,
  maxBackoffMinutes: 24 * 60,
  warnAfterFailures: 2,
  pauseAfterFailures: 4,
};

export type SafetyEvent =
  | { type: "success" }
  | { type: "failure"; code: ErrorCode; retryAfterMs?: number | null };

export function applySafetyEvent(
  s: SafetySnapshot,
  e: SafetyEvent,
  policy: SafetyPolicy,
  now: Date = new Date(),
  random?: () => number,
): SafetySnapshot {
  if (e.type === "success") {
    return { safetyState: "HEALTHY", pausedUntil: null, pauseReason: null, consecutiveFailures: 0, rateLimitStrikes: 0 };
  }
  const failures = s.consecutiveFailures + 1;
  const backoff = { baseMs: policy.baseBackoffMinutes * 60_000, maxMs: policy.maxBackoffMinutes * 60_000 };

  if (e.code === "RATE_LIMITED") {
    const strikes = s.rateLimitStrikes + 1;
    const delay = nextRetryDelayMs(strikes, e.retryAfterMs ?? null, backoff, random);
    return {
      safetyState: "PAUSED",
      pausedUntil: new Date(now.getTime() + delay),
      pauseReason: "Platform rate limit (429) — publishing paused, not retried early",
      consecutiveFailures: failures,
      rateLimitStrikes: strikes,
    };
  }
  if (e.code === "AUTH_EXPIRED") {
    // No automatic resume: a person must reconnect the account.
    return { ...s, safetyState: "PAUSED", pausedUntil: null, pauseReason: "Authorization expired — reconnect the account", consecutiveFailures: failures };
  }
  if (failures >= policy.pauseAfterFailures) {
    const delay = nextRetryDelayMs(failures - policy.pauseAfterFailures + 1, null, backoff, random);
    return {
      ...s,
      safetyState: "PAUSED",
      pausedUntil: new Date(now.getTime() + delay),
      pauseReason: `${failures} consecutive failures (${e.code})`,
      consecutiveFailures: failures,
    };
  }
  return {
    ...s,
    safetyState: failures >= policy.warnAfterFailures ? "WARNING" : s.safetyState === "PAUSED" ? "PAUSED" : "HEALTHY",
    consecutiveFailures: failures,
  };
}

/** A timed pause that has expired returns the account to WARNING (not straight to HEALTHY). */
export function resolveExpiredPause(s: SafetySnapshot, now: Date = new Date()): SafetySnapshot {
  if (s.safetyState === "PAUSED" && s.pausedUntil && s.pausedUntil.getTime() <= now.getTime()) {
    return { ...s, safetyState: "WARNING", pausedUntil: null, pauseReason: null };
  }
  return s;
}
