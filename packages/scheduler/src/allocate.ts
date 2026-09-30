/**
 * Assigns approved, ready content to free slots.
 *
 * - Source distribution: smooth weighted round-robin (nginx-style), so weights
 *   2:1 produce A,B,A,A,B,A… rather than bursts from one source.
 * - Respects per-source per-day caps, daily/hourly caps and min interval,
 *   counting posts already on the calendar.
 */
import { DateTime } from "luxon";

export interface Candidate {
  contentId: string;
  sourceId: string | null;
  kind: string;
}

export interface ExistingPost {
  scheduledAt: Date;
  sourceId: string | null;
}

export interface AllocationLimits {
  maxPostsPerDay: number;
  maxPostsPerHour: number;
  minPostIntervalMinutes: number;
  maxPostsPerSourcePerDay: number;
}

export interface Allocation {
  contentId: string;
  scheduledAt: Date;
}

/**
 * True if adding `t` would put more than `max` events inside ANY window of
 * length `windowMs` (a true sliding window, not just the hour before/after).
 */
export function exceedsRollingWindow(times: number[], t: number, windowMs: number, max: number): boolean {
  const pts = [...times.filter((x) => Math.abs(x - t) < windowMs), t].sort((a, b) => a - b);
  let i = 0;
  for (let j = 0; j < pts.length; j++) {
    while (pts[j]! - pts[i]! >= windowMs) i++;
    const containsT = pts[i]! <= t && t <= pts[j]!;
    if (containsT && j - i + 1 > max) return true;
  }
  return false;
}

export function allocate(params: {
  slots: Date[];
  candidates: Candidate[];
  existing: ExistingPost[];
  limits: AllocationLimits;
  timezone: string;
  sourceWeights?: Record<string, number>;
}): Allocation[] {
  const { slots, limits, timezone } = params;
  const weights = params.sourceWeights ?? {};
  const dayKey = (d: Date) => DateTime.fromJSDate(d).setZone(timezone).toISODate()!;

  const queues = new Map<string, Candidate[]>();
  for (const c of params.candidates) {
    const key = c.sourceId ?? "__none__";
    if (!queues.has(key)) queues.set(key, []);
    queues.get(key)!.push(c);
  }
  const current = new Map<string, number>([...queues.keys()].map((k) => [k, 0]));
  const weightOf = (k: string) => Math.max(0, weights[k] ?? 1);

  const taken: ExistingPost[] = [...params.existing].sort((a, b) => a.scheduledAt.getTime() - b.scheduledAt.getTime());
  const out: Allocation[] = [];

  const fits = (slot: Date, sourceId: string | null): boolean => {
    const day = dayKey(slot);
    const sameDay = taken.filter((p) => dayKey(p.scheduledAt) === day);
    if (sameDay.length >= limits.maxPostsPerDay) return false;
    if (exceedsRollingWindow(taken.map((p) => p.scheduledAt.getTime()), slot.getTime(), 60 * 60_000, limits.maxPostsPerHour))
      return false;
    const tooClose = taken.some(
      (p) => Math.abs(p.scheduledAt.getTime() - slot.getTime()) < limits.minPostIntervalMinutes * 60_000,
    );
    if (tooClose) return false;
    if (sourceId && sameDay.filter((p) => p.sourceId === sourceId).length >= limits.maxPostsPerSourcePerDay) return false;
    return true;
  };

  for (const slot of slots) {
    // Smooth weighted round-robin over sources that still have candidates and fit this slot.
    const eligible = [...queues.entries()].filter(
      ([k, q]) => q.length > 0 && weightOf(k) > 0 && fits(slot, k === "__none__" ? null : k),
    );
    if (eligible.length === 0) continue;
    const total = eligible.reduce((acc, [k]) => acc + weightOf(k), 0);
    for (const [k] of eligible) current.set(k, (current.get(k) ?? 0) + weightOf(k));
    const [bestKey] = eligible.reduce((best, e) => ((current.get(e[0]) ?? 0) > (current.get(best[0]) ?? 0) ? e : best));
    current.set(bestKey, (current.get(bestKey) ?? 0) - total);
    const candidate = queues.get(bestKey)!.shift()!;
    out.push({ contentId: candidate.contentId, scheduledAt: slot });
    taken.push({ scheduledAt: slot, sourceId: candidate.sourceId });
  }
  return out;
}
