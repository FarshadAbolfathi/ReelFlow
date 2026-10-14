import type { Db, PublishingAccount } from "@reelflow/database";
import type { AppConfig } from "@reelflow/config";
import { NetworkClient } from "@reelflow/http";
import type { AdapterRegistry, SessionRpc } from "@reelflow/platform-adapters";
import { applySafetyEvent, resolveExpiredPause, DEFAULT_SAFETY_POLICY, type SafetyEvent, type SafetySnapshot } from "@reelflow/scheduler";
import { assertCan, decryptSecret, encryptSecret, secretHint } from "@reelflow/security";
import { AppError, toAppError, type ConnectSessionInput } from "@reelflow/types";
import { WORKER, type AuditService, type NotificationService } from "../infra/audit";
import type { SettingsService } from "./settings";
import type { UserActor } from "./sources";

/** Public view of an account — the token (and its ciphertext) never leave the server. */
export type AccountView = Omit<PublishingAccount, "encryptedToken"> & { hasToken: boolean; dailyPublishCount: number };

export function createNetworkClient(config: AppConfig): NetworkClient {
  return new NetworkClient({
    mode: config.network.mode === "proxy" ? "PROXY" : "DIRECT",
    proxyUrl: config.network.proxyUrl,
    healthUrl: config.network.healthUrl,
    healthTimeoutMs: config.network.healthTimeoutMs,
  });
}

export class AccountsService {
  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly adapters: AdapterRegistry,
    private readonly audit: AuditService,
    private readonly notifications: NotificationService,
    private readonly settings: SettingsService,
    private readonly sessions?: SessionRpc,
  ) {}

  private aad(accountId: string) {
    return `account:${accountId}`;
  }

  private async view(a: PublishingAccount): Promise<AccountView> {
    const { encryptedToken, ...rest } = a;
    const since = new Date(Date.now() - 24 * 3_600_000);
    const dailyPublishCount = await this.db.scheduledPost.count({ where: { accountId: a.id, status: "PUBLISHED", publishedAt: { gte: since } } });
    return { ...rest, hasToken: !!encryptedToken, dailyPublishCount };
  }

  async list(): Promise<AccountView[]> {
    const rows = await this.db.publishingAccount.findMany({ orderBy: { createdAt: "asc" } });
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(id: string): Promise<AccountView> {
    const a = await this.db.publishingAccount.findUnique({ where: { id } });
    if (!a) throw new AppError("NOT_FOUND", "Account not found");
    return this.view(a);
  }

  /** Decrypts the token just-in-time for an adapter call. Never log the result. */
  async token(id: string): Promise<{ account: PublishingAccount; accessToken: string }> {
    const account = await this.db.publishingAccount.findUnique({ where: { id } });
    if (!account) throw new AppError("NOT_FOUND", "Account not found");
    if (!account.encryptedToken) throw new AppError("AUTH_EXPIRED", "Account is not connected");
    return { account, accessToken: decryptSecret(account.encryptedToken, this.config.encryptionKey, this.aad(account.id)) };
  }

  async connect(
    input: { name: string; platform: "INSTAGRAM"; externalAccountId: string; accessToken: string; tokenExpiresAt?: string },
    actor: UserActor,
  ): Promise<AccountView> {
    assertCan(actor.role, "accounts:write");
    const adapter = this.adapters.get(input.platform);
    const network = createNetworkClient(this.config);
    try {
      const identity = await adapter.authenticate({ externalAccountId: input.externalAccountId, accessToken: input.accessToken, network });
      const existing = await this.db.publishingAccount.findUnique({
        where: { platform_externalAccountId: { platform: input.platform, externalAccountId: input.externalAccountId } },
      });
      const id = existing?.id ?? crypto.randomUUID();
      const data = {
        name: input.name,
        username: identity.username,
        status: "CONNECTED" as const,
        encryptedToken: encryptSecret(input.accessToken, this.config.encryptionKey, this.aad(id)),
        tokenHint: secretHint(input.accessToken),
        tokenExpiresAt: input.tokenExpiresAt ? new Date(input.tokenExpiresAt) : null,
        safetyState: "HEALTHY" as const,
        pausedUntil: null,
        pauseReason: null,
        consecutiveFailures: 0,
        lastError: null,
        lastErrorCode: null,
      };
      const account = existing
        ? await this.db.publishingAccount.update({ where: { id }, data })
        : await this.db.publishingAccount.create({ data: { id, platform: input.platform, externalAccountId: input.externalAccountId, ...data } });
      await this.audit.log("account_connected", actor, `Connected ${input.platform} account ${identity.username ?? input.externalAccountId}`, { type: "account", id: account.id });
      return this.view(account);
    } finally {
      await network.close();
    }
  }

  /**
   * Connects an Instagram account by logging in inside the app (PUBLISHING_ADAPTER_MODE=session).
   * The password/sessionid is encrypted before it is stored; the ingestion engine decrypts it,
   * logs in and keeps the refreshed session encrypted in the same row.
   */
  async connectSession(input: ConnectSessionInput, actor: UserActor): Promise<AccountView> {
    assertCan(actor.role, "accounts:write");
    if (this.config.publishingAdapterMode !== "session" || !this.sessions)
      throw new AppError("VALIDATION_FAILED", "Instagram login is only available with PUBLISHING_ADAPTER_MODE=session");
    const username = input.username.trim().replace(/^@/, "").toLowerCase();
    const existing = await this.db.publishingAccount.findUnique({ where: { platform_externalAccountId: { platform: "INSTAGRAM", externalAccountId: username } } });
    const id = existing?.id ?? crypto.randomUUID();
    const blob = {
      kind: "ig-session",
      username,
      password: input.password ?? null,
      sessionid: input.sessionId ?? null,
      // Keep the device identity of an earlier session so a reconnect looks like the
      // same phone refreshing its cookie, not a brand-new device presenting a borrowed
      // one — true for a sessionid reconnect too (instagram_session.py's `_open` applies
      // the sessionid on top of these restored settings rather than skipping it).
      settings: this.previousSessionSettings(existing, username),
    };
    const data = {
      name: input.name,
      status: "DISCONNECTED" as const,
      encryptedToken: encryptSecret(JSON.stringify(blob), this.config.encryptionKey, this.aad(id)),
      tokenHint: "session",
      tokenExpiresAt: null,
      safetyState: "HEALTHY" as const,
      pausedUntil: null,
      pauseReason: null,
      consecutiveFailures: 0,
      lastError: null,
      lastErrorCode: null,
    };
    if (existing) await this.db.publishingAccount.update({ where: { id }, data });
    else await this.db.publishingAccount.create({ data: { id, platform: "INSTAGRAM", externalAccountId: username, ...data } });

    const identity = await this.sessions.call<{ userId: string; username: string }>("login", { accountId: id, verificationCode: input.verificationCode ?? null }, 180_000);
    await this.audit.log("account_connected", actor, `Logged in to Instagram as @${identity.username}`, { type: "account", id }, { method: input.sessionId ? "sessionid" : "password" });
    return this.get(id);
  }

  private previousSessionSettings(existing: PublishingAccount | null, username: string): unknown {
    if (!existing?.encryptedToken) return null;
    try {
      const old = JSON.parse(decryptSecret(existing.encryptedToken, this.config.encryptionKey, this.aad(existing.id))) as { kind?: string; username?: string; settings?: unknown };
      return old.kind === "ig-session" && old.username === username ? (old.settings ?? null) : null;
    } catch {
      return null; // a Graph API token, or unreadable — start a fresh session
    }
  }

  async disconnect(id: string, actor: UserActor): Promise<AccountView> {
    assertCan(actor.role, "accounts:write");
    const a = await this.db.publishingAccount.update({
      where: { id },
      data: { status: "DISCONNECTED", encryptedToken: null, tokenHint: null, tokenExpiresAt: null },
    });
    // Nothing can publish to a disconnected account.
    await this.db.scheduledPost.updateMany({ where: { accountId: id, status: { in: ["SCHEDULED", "READY"] } }, data: { status: "PAUSED", lastErrorMessage: "Account disconnected" } });
    await this.audit.log("account_disconnected", actor, `Disconnected account ${a.name}`, { type: "account", id });
    return this.view(a);
  }

  async validate(id: string, actor: UserActor): Promise<{ ok: boolean; message: string; quota?: { used: number; total: number } }> {
    assertCan(actor.role, "accounts:read");
    const network = createNetworkClient(this.config);
    try {
      const { account, accessToken } = await this.token(id);
      const adapter = this.adapters.get(account.platform);
      const ctx = { externalAccountId: account.externalAccountId, accessToken, network };
      await adapter.authenticate(ctx);
      const quota = adapter.getPublishingQuota ? await adapter.getPublishingQuota(ctx) : undefined;
      await this.db.publishingAccount.update({ where: { id }, data: { status: "CONNECTED" } });
      await this.audit.log("account_validated", actor, `Validated account ${account.name}`, { type: "account", id });
      return { ok: true, message: "Connection is valid", ...(quota ? { quota: { used: quota.used, total: quota.total } } : {}) };
    } catch (e) {
      const err = toAppError(e);
      if (err.code === "AUTH_EXPIRED") await this.db.publishingAccount.update({ where: { id }, data: { status: "AUTH_EXPIRED", lastError: err.message, lastErrorCode: err.code, lastErrorAt: new Date() } });
      return { ok: false, message: err.message };
    } finally {
      await network.close();
    }
  }

  async setDailyLimit(id: string, dailyLimit: number | null, actor: UserActor) {
    assertCan(actor.role, "accounts:write");
    if (dailyLimit !== null && dailyLimit > this.config.policy.maxPostsPerDay)
      throw new AppError("POLICY_LIMIT_EXCEEDED", `Daily limit cannot exceed the policy ceiling of ${this.config.policy.maxPostsPerDay}`);
    return this.view(await this.db.publishingAccount.update({ where: { id }, data: { dailyLimit } }));
  }

  /** Manual resume of a paused account (e.g. after reconnecting). */
  async resume(id: string, actor: UserActor) {
    assertCan(actor.role, "queue:control");
    const a = await this.db.publishingAccount.update({ where: { id }, data: { safetyState: "WARNING", pausedUntil: null, pauseReason: null } });
    await this.audit.log("account_resumed", actor, `Publishing resumed on ${a.name}`, { type: "account", id });
    return this.view(a);
  }

  // ── Safety monitor ───────────────────────────────────────────────────
  private snapshot(a: PublishingAccount): SafetySnapshot {
    return {
      safetyState: a.safetyState,
      pausedUntil: a.pausedUntil,
      pauseReason: a.pauseReason,
      consecutiveFailures: a.consecutiveFailures,
      rateLimitStrikes: a.rateLimitStrikes,
    };
  }

  async recordSafetyEvent(accountId: string, event: SafetyEvent): Promise<SafetySnapshot> {
    const a = await this.db.publishingAccount.findUniqueOrThrow({ where: { id: accountId } });
    const s = await this.settings.get();
    const next = applySafetyEvent(this.snapshot(a), event, {
      ...DEFAULT_SAFETY_POLICY,
      baseBackoffMinutes: s.safety.baseBackoffMinutes,
      maxBackoffMinutes: s.safety.maxBackoffMinutes,
    });
    const becamePaused = next.safetyState === "PAUSED" && a.safetyState !== "PAUSED";
    await this.db.publishingAccount.update({
      where: { id: accountId },
      data: {
        safetyState: next.safetyState,
        pausedUntil: next.pausedUntil,
        pauseReason: next.pauseReason,
        consecutiveFailures: next.consecutiveFailures,
        rateLimitStrikes: next.rateLimitStrikes,
        ...(event.type === "success"
          ? { lastSuccessAt: new Date() }
          : { lastErrorAt: new Date(), lastErrorCode: event.code, ...(event.code === "AUTH_EXPIRED" ? { status: "AUTH_EXPIRED" as const } : {}) }),
      },
    });
    if (becamePaused) {
      await this.audit.log("account_paused", WORKER, `Publishing paused on ${a.name}: ${next.pauseReason}`, { type: "account", id: accountId }, { until: next.pausedUntil });
      if (s.notifications.onQueuePaused)
        await this.notifications.notify({ level: "WARNING", type: event.type === "failure" && event.code === "AUTH_EXPIRED" ? "auth_expired" : "queue_paused", title: `Publishing paused: ${a.name}`, body: next.pauseReason ?? "", entity: { type: "account", id: accountId } });
    }
    return next;
  }

  /** Clears timed pauses that have expired (called by the scheduler tick). */
  async releaseExpiredPauses(now = new Date()): Promise<number> {
    const paused = await this.db.publishingAccount.findMany({ where: { safetyState: "PAUSED", pausedUntil: { lte: now } } });
    for (const a of paused) {
      const next = resolveExpiredPause(this.snapshot(a), now);
      await this.db.publishingAccount.update({ where: { id: a.id }, data: { safetyState: next.safetyState, pausedUntil: next.pausedUntil, pauseReason: next.pauseReason } });
      await this.audit.log("account_resumed", WORKER, `Pause expired on ${a.name}; resuming cautiously (WARNING)`, { type: "account", id: a.id });
    }
    return paused.length;
  }
}
