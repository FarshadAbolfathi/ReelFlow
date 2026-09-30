import { AppError, settingsSchema, type Settings, type SettingsSection } from "@reelflow/types";
import { assertWithinCeilings, type PolicyCeilings } from "./policy";

/** Default settings, derived from the schema defaults and capped by the ceilings. */
export function defaultSettings(ceilings: PolicyCeilings, timezone = "Asia/Tehran"): Settings {
  const s = settingsSchema.parse({
    general: { timezone },
    approval: {},
    publishing: {},
    safety: {},
    queue: {},
    media: {},
    storage: {},
    notifications: {},
  });
  s.publishing.maxPostsPerDay = Math.min(s.publishing.maxPostsPerDay, ceilings.maxPostsPerDay);
  s.publishing.maxPostsPerHour = Math.min(s.publishing.maxPostsPerHour, ceilings.maxPostsPerHour);
  s.publishing.minPostIntervalMinutes = Math.max(s.publishing.minPostIntervalMinutes, ceilings.minPostIntervalMinutes);
  s.publishing.maxPostsPerSourcePerDay = Math.min(
    s.publishing.maxPostsPerSourcePerDay,
    ceilings.maxPostsPerSourcePerDay,
  );
  s.queue.maxConcurrentJobs = Math.max(1, s.queue.maxConcurrentJobs);
  return s;
}

/**
 * Merges stored partial sections over defaults, validating each section.
 * Invalid stored values fall back to defaults instead of crashing the app.
 */
export function mergeSettings(defaults: Settings, stored: Partial<Record<SettingsSection, unknown>>): Settings {
  const out = structuredClone(defaults) as Record<SettingsSection, unknown>;
  for (const key of Object.keys(settingsSchema.shape) as SettingsSection[]) {
    const value = stored[key];
    if (value && typeof value === "object") {
      const merged = { ...(out[key] as object), ...(value as object) };
      const r = settingsSchema.shape[key].safeParse(merged);
      if (r.success) out[key] = r.data;
    }
  }
  return out as Settings;
}

/** Validates one section update and enforces policy ceilings for publishing limits. */
export function validateSectionUpdate<K extends SettingsSection>(
  current: Settings,
  section: K,
  values: Record<string, unknown>,
  ceilings: PolicyCeilings,
): Settings[K] {
  const merged = { ...(current[section] as object), ...values };
  const r = settingsSchema.shape[section].safeParse(merged);
  if (!r.success) {
    throw new AppError("VALIDATION_FAILED", `Invalid ${section} settings`, {
      details: { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    });
  }
  const data = r.data as Settings[K];
  if (section === "publishing") assertWithinCeilings(data as Settings["publishing"], ceilings);
  if (section === "queue") {
    const q = data as Settings["queue"];
    if (q.maxConcurrentJobs < 1) throw new AppError("VALIDATION_FAILED", "maxConcurrentJobs must be ≥ 1");
  }
  return data;
}
