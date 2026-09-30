import type { Db, Prisma } from "@reelflow/database";
import {
  defaultSettings,
  effectiveLimits,
  mergeSettings,
  validateSectionUpdate,
  type AppConfig,
  type PublishingLimits,
} from "@reelflow/config";
import type { Settings, SettingsSection } from "@reelflow/types";
import type { Actor, AuditService } from "../infra/audit";

/**
 * User-editable settings, stored per section in `system_settings`.
 * Policy ceilings come from the environment and are returned read-only.
 */
export class SettingsService {
  private cache: { value: Settings; at: number } | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<Settings> {
    if (this.cache && Date.now() - this.cache.at < 5_000) return this.cache.value;
    const rows = await this.db.systemSetting.findMany({ where: { key: { startsWith: "settings." } } });
    const stored = Object.fromEntries(rows.map((r) => [r.key.slice("settings.".length), r.value]));
    const value = mergeSettings(defaultSettings(this.config.policy, this.config.defaultTimezone), stored);
    this.cache = { value, at: Date.now() };
    return value;
  }

  async update<K extends SettingsSection>(section: K, values: Record<string, unknown>, actor: Actor): Promise<Settings> {
    const current = await this.get();
    const next = validateSectionUpdate(current, section, values, this.config.policy);
    await this.db.systemSetting.upsert({
      where: { key: `settings.${section}` },
      update: { value: next as Prisma.InputJsonValue, updatedById: actor.id ?? null },
      create: { key: `settings.${section}`, value: next as Prisma.InputJsonValue, updatedById: actor.id ?? null },
    });
    this.cache = null;
    const changed = Object.keys(values).filter(
      (k) => JSON.stringify((current[section] as Record<string, unknown>)[k]) !== JSON.stringify((next as Record<string, unknown>)[k]),
    );
    await this.audit.log("settings_changed", actor, `Updated ${section} settings: ${changed.join(", ") || "no changes"}`, null, {
      section,
      changed: Object.fromEntries(changed.map((k) => [k, (next as Record<string, unknown>)[k]])),
    });
    return this.get();
  }

  /** Limits actually applied to publishing: the stricter of settings and ceilings. */
  async limits(): Promise<PublishingLimits> {
    const s = await this.get();
    return effectiveLimits(s.publishing, this.config.policy);
  }

  ceilings() {
    return this.config.policy;
  }

  invalidate(): void {
    this.cache = null;
  }
}
