import type { Db, User } from "@reelflow/database";
import type { Redis } from "ioredis";
import { assertCan, hashPassword, randomToken, sha256Hex, verifyPassword } from "@reelflow/security";
import { AppError, type UserRole } from "@reelflow/types";
import type { AuditService } from "../infra/audit";
import type { UserActor } from "./sources";

export const SESSION_TTL_MS = 7 * 86_400_000;
const LOCKOUT_MAX = 5;
const LOCKOUT_WINDOW_SEC = 15 * 60;

export type SafeUser = Pick<User, "id" | "email" | "name" | "role" | "active" | "lastLoginAt" | "createdAt">;
export const toSafeUser = (u: User): SafeUser => ({ id: u.id, email: u.email, name: u.name, role: u.role, active: u.active, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt });

export interface SessionInfo {
  user: SafeUser;
  sessionId: string;
  csrfToken: string;
}

// Constant-time-ish dummy hash so unknown emails take as long as wrong passwords.
let dummyHash: Promise<string> | null = null;

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly redis: Redis,
    private readonly audit: AuditService,
  ) {}

  private lockKey(email: string, ip: string) {
    return `reelflow:login-fail:${sha256Hex(`${email.toLowerCase()}|${ip}`)}`;
  }

  async login(email: string, password: string, meta: { ip: string; userAgent?: string }): Promise<{ token: string; session: SessionInfo }> {
    const key = this.lockKey(email, meta.ip);
    const fails = Number((await this.redis.get(key)) ?? 0);
    if (fails >= LOCKOUT_MAX) throw new AppError("RATE_LIMITED", "Too many failed sign-in attempts. Try again in 15 minutes.", { retryAfterMs: LOCKOUT_WINDOW_SEC * 1000 });

    const user = await this.db.user.findUnique({ where: { email: email.toLowerCase() } });
    dummyHash ??= hashPassword("dummy-password-for-timing");
    const ok = user && user.active ? await verifyPassword(user.passwordHash, password) : (await verifyPassword(await dummyHash, password), false);
    if (!user || !ok) {
      await this.redis.multi().incr(key).expire(key, LOCKOUT_WINDOW_SEC).exec();
      await this.audit.log("user_login_failed", { type: "SYSTEM" }, `Failed sign-in for ${email.toLowerCase()}`, null, { ip: meta.ip });
      throw new AppError("UNAUTHENTICATED", "Invalid email or password");
    }
    await this.redis.del(key);
    const token = randomToken(32);
    const csrfToken = randomToken(24);
    const session = await this.db.session.create({
      data: { tokenHash: sha256Hex(token), csrfToken, userId: user.id, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300) ?? null, expiresAt: new Date(Date.now() + SESSION_TTL_MS) },
    });
    await this.db.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log("user_login", { type: "USER", id: user.id }, `${user.email} signed in`, null, { ip: meta.ip });
    return { token, session: { user: toSafeUser(user), sessionId: session.id, csrfToken } };
  }

  async resolve(token: string | undefined): Promise<SessionInfo | null> {
    if (!token) return null;
    const session = await this.db.session.findUnique({ where: { tokenHash: sha256Hex(token) }, include: { user: true } });
    if (!session || session.expiresAt < new Date() || !session.user.active) return null;
    // Sliding expiry, at most one write per minute.
    if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
      await this.db.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
    }
    return { user: toSafeUser(session.user), sessionId: session.id, csrfToken: session.csrfToken };
  }

  async logout(sessionId: string, userId: string): Promise<void> {
    await this.db.session.deleteMany({ where: { id: sessionId } });
    await this.audit.log("user_logout", { type: "USER", id: userId }, "Signed out");
  }

  async createUser(input: { email: string; name: string; password: string; role: UserRole }, actor: UserActor): Promise<SafeUser> {
    assertCan(actor.role, "users:manage");
    try {
      const u = await this.db.user.create({ data: { email: input.email.toLowerCase(), name: input.name, role: input.role, passwordHash: await hashPassword(input.password) } });
      await this.audit.log("user_created", actor, `Created ${input.role} user ${u.email}`, { type: "user", id: u.id });
      return toSafeUser(u);
    } catch (e) {
      if ((e as { code?: string }).code === "P2002") throw new AppError("CONFLICT", "A user with this email already exists");
      throw e;
    }
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const u = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(u.passwordHash, current))) throw new AppError("UNAUTHENTICATED", "Current password is incorrect");
    await this.db.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(next) } });
    await this.db.session.deleteMany({ where: { userId } });
  }

  async listUsers(actor: UserActor): Promise<SafeUser[]> {
    assertCan(actor.role, "users:manage");
    return (await this.db.user.findMany({ orderBy: { createdAt: "asc" } })).map(toSafeUser);
  }

  purgeExpiredSessions() {
    return this.db.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  }
}
