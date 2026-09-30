import type { Db, Prisma } from "@reelflow/database";
import type { NotificationLevel } from "@reelflow/types";

export type AuditAction =
  | "source_created"
  | "source_updated"
  | "source_reviewed"
  | "source_deleted"
  | "discovery_requested"
  | "content_imported"
  | "content_duplicate"
  | "content_processed"
  | "processing_failed"
  | "watermark_applied"
  | "content_approved"
  | "content_rejected"
  | "caption_updated"
  | "post_scheduled"
  | "post_rescheduled"
  | "post_cancelled"
  | "post_paused"
  | "post_resumed"
  | "post_retried"
  | "post_blocked"
  | "post_published"
  | "post_failed"
  | "account_connected"
  | "account_disconnected"
  | "account_validated"
  | "account_paused"
  | "account_resumed"
  | "settings_changed"
  | "schedule_changed"
  | "user_login"
  | "user_login_failed"
  | "user_logout"
  | "user_created"
  | "network_command"
  | "cleanup_run"
  | "system_seeded";

export interface Actor {
  type: "USER" | "SYSTEM" | "WORKER" | "INGESTION" | "CLI";
  id?: string | null;
}

export const SYSTEM: Actor = { type: "SYSTEM" };
export const WORKER: Actor = { type: "WORKER" };

export class AuditService {
  constructor(private readonly db: Db) {}

  async log(
    action: AuditAction,
    actor: Actor,
    summary: string,
    entity?: { type: string; id: string } | null,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.db.auditLog.create({
      data: {
        action,
        actorType: actor.type,
        actorId: actor.id ?? null,
        entityType: entity?.type ?? null,
        entityId: entity?.id ?? null,
        summary: summary.slice(0, 1000),
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }

  async search(q: { text?: string; action?: string; entityType?: string; entityId?: string; page: number; pageSize: number }) {
    const where: Prisma.AuditLogWhereInput = {
      ...(q.action ? { action: q.action } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.text ? { summary: { contains: q.text, mode: "insensitive" as const } } : {}),
    };
    const [items, total] = await Promise.all([
      this.db.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      this.db.auditLog.count({ where }),
    ]);
    return { items, total };
  }
}

/** Internal notification centre. External channels (email, Telegram, webhook) plug in via NotificationChannel. */
export interface NotificationChannel {
  readonly name: string;
  send(n: { level: NotificationLevel; type: string; title: string; body: string }): Promise<void>;
}

export class NotificationService {
  private readonly channels: NotificationChannel[] = [];

  constructor(private readonly db: Db) {}

  addChannel(c: NotificationChannel): void {
    this.channels.push(c);
  }

  async notify(n: { level: NotificationLevel; type: string; title: string; body: string; entity?: { type: string; id: string } }): Promise<void> {
    await this.db.notification.create({
      data: { level: n.level, type: n.type, title: n.title, body: n.body, entityType: n.entity?.type ?? null, entityId: n.entity?.id ?? null },
    });
    await Promise.allSettled(this.channels.map((c) => c.send(n)));
  }

  list(unreadOnly: boolean, take = 50) {
    return this.db.notification.findMany({ where: unreadOnly ? { readAt: null } : {}, orderBy: { createdAt: "desc" }, take });
  }

  unreadCount() {
    return this.db.notification.count({ where: { readAt: null } });
  }

  markRead(ids: string[] | "all") {
    return this.db.notification.updateMany({ where: ids === "all" ? { readAt: null } : { id: { in: ids } }, data: { readAt: new Date() } });
  }
}
