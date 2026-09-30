/**
 * Publishing policy ceilings.
 *
 * Three layers, from strongest to weakest:
 *  1. ABSOLUTE_LIMITS  — compiled into the code; nothing can exceed them.
 *  2. PolicyCeilings   — set by the operator via POLICY_* env vars, clamped to (1).
 *  3. User settings    — editable in the UI, must be ≤ (2) or they are rejected.
 *
 * The defaults are deliberately conservative: a small number of posts per day
 * spread out over the day, never bursts.
 */
import { AppError } from "@reelflow/types";

export const ABSOLUTE_LIMITS = Object.freeze({
  maxPostsPerDay: 25,
  maxPostsPerHour: 3,
  minPostIntervalMinutes: 20,
  maxConcurrentPublish: 2,
  maxPostsPerSourcePerDay: 10,
});

export interface PolicyCeilings {
  maxPostsPerDay: number;
  maxPostsPerHour: number;
  minPostIntervalMinutes: number;
  maxConcurrentPublish: number;
  maxPostsPerSourcePerDay: number;
  sourcesRequireOwnerApproval: boolean;
}

export const DEFAULT_CEILINGS: PolicyCeilings = Object.freeze({
  maxPostsPerDay: 10,
  maxPostsPerHour: 2,
  minPostIntervalMinutes: 60,
  maxConcurrentPublish: 1,
  maxPostsPerSourcePerDay: 4,
  sourcesRequireOwnerApproval: true,
});

const clampMax = (v: number | undefined, fallback: number, absolute: number) =>
  Math.min(Number.isFinite(v) && (v as number) >= 0 ? (v as number) : fallback, absolute);

const clampMin = (v: number | undefined, fallback: number, absolute: number) =>
  Math.max(Number.isFinite(v) && (v as number) > 0 ? (v as number) : fallback, absolute);

/** Builds ceilings from raw env values, clamping every number to ABSOLUTE_LIMITS. */
export function resolveCeilings(raw: Partial<PolicyCeilings>): PolicyCeilings {
  return Object.freeze({
    maxPostsPerDay: clampMax(raw.maxPostsPerDay, DEFAULT_CEILINGS.maxPostsPerDay, ABSOLUTE_LIMITS.maxPostsPerDay),
    maxPostsPerHour: clampMax(raw.maxPostsPerHour, DEFAULT_CEILINGS.maxPostsPerHour, ABSOLUTE_LIMITS.maxPostsPerHour),
    minPostIntervalMinutes: clampMin(
      raw.minPostIntervalMinutes,
      DEFAULT_CEILINGS.minPostIntervalMinutes,
      ABSOLUTE_LIMITS.minPostIntervalMinutes,
    ),
    maxConcurrentPublish: Math.max(
      1,
      clampMax(raw.maxConcurrentPublish, DEFAULT_CEILINGS.maxConcurrentPublish, ABSOLUTE_LIMITS.maxConcurrentPublish),
    ),
    maxPostsPerSourcePerDay: clampMax(
      raw.maxPostsPerSourcePerDay,
      DEFAULT_CEILINGS.maxPostsPerSourcePerDay,
      ABSOLUTE_LIMITS.maxPostsPerSourcePerDay,
    ),
    sourcesRequireOwnerApproval: raw.sourcesRequireOwnerApproval ?? true,
  });
}

export interface PublishingLimits {
  maxPostsPerDay: number;
  maxPostsPerHour: number;
  minPostIntervalMinutes: number;
  maxPostsPerSourcePerDay: number;
}

/**
 * Validates user-chosen limits against the ceilings. Throws POLICY_LIMIT_EXCEEDED
 * listing every violation — values are never silently clamped, so the user sees
 * exactly why "20 posts per day" was refused.
 */
export function assertWithinCeilings(limits: PublishingLimits, ceilings: PolicyCeilings): void {
  const violations: string[] = [];
  if (limits.maxPostsPerDay > ceilings.maxPostsPerDay)
    violations.push(`maxPostsPerDay ${limits.maxPostsPerDay} > ceiling ${ceilings.maxPostsPerDay}`);
  if (limits.maxPostsPerHour > ceilings.maxPostsPerHour)
    violations.push(`maxPostsPerHour ${limits.maxPostsPerHour} > ceiling ${ceilings.maxPostsPerHour}`);
  if (limits.minPostIntervalMinutes < ceilings.minPostIntervalMinutes)
    violations.push(
      `minPostIntervalMinutes ${limits.minPostIntervalMinutes} < ceiling ${ceilings.minPostIntervalMinutes}`,
    );
  if (limits.maxPostsPerSourcePerDay > ceilings.maxPostsPerSourcePerDay)
    violations.push(
      `maxPostsPerSourcePerDay ${limits.maxPostsPerSourcePerDay} > ceiling ${ceilings.maxPostsPerSourcePerDay}`,
    );
  if (violations.length > 0) {
    throw new AppError("POLICY_LIMIT_EXCEEDED", "Requested limits exceed the operator policy ceilings", {
      details: { violations, ceilings },
    });
  }
}

/** The effective limit is always the stricter of user setting and ceiling. */
export function effectiveLimits(limits: PublishingLimits, ceilings: PolicyCeilings): PublishingLimits {
  return {
    maxPostsPerDay: Math.min(limits.maxPostsPerDay, ceilings.maxPostsPerDay),
    maxPostsPerHour: Math.min(limits.maxPostsPerHour, ceilings.maxPostsPerHour),
    minPostIntervalMinutes: Math.max(limits.minPostIntervalMinutes, ceilings.minPostIntervalMinutes),
    maxPostsPerSourcePerDay: Math.min(limits.maxPostsPerSourcePerDay, ceilings.maxPostsPerSourcePerDay),
  };
}
