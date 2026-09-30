/**
 * Node side of the Instagram session channel (mirrors
 * apps/ingestion/reelflow_ingestion/session_control.py). The Python engine holds
 * the sessions; commands go over a Redis stream and the reply lands in a key.
 * Commands never contain passwords or cookies — only ids, paths and captions.
 */
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import type { SessionCommand, SessionRpc } from "@reelflow/platform-adapters";
import { AppError, ERROR_CODES, type ErrorCode } from "@reelflow/types";

export const IG_SESSION = {
  commandStream: "reelflow:igsession:commands",
  replyKeyPrefix: "reelflow:igsession:reply:",
} as const;

interface Reply {
  ok: boolean;
  result?: unknown;
  code?: string;
  message?: string;
  reason?: string;
  retryAfterMs?: number;
}

export class InstagramSessionBridge implements SessionRpc {
  constructor(
    private readonly redis: Redis,
    private readonly pollMs = 500,
  ) {}

  async call<T>(cmd: SessionCommand, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const id = randomUUID();
    const deadline = Date.now() + timeoutMs;
    await this.redis.xadd(IG_SESSION.commandStream, "MAXLEN", "~", "1000", "*", "id", id, "cmd", cmd, "args", JSON.stringify(args), "deadline", String(deadline / 1000));
    const replyKey = `${IG_SESSION.replyKeyPrefix}${id}`;
    while (Date.now() < deadline) {
      const raw = await this.redis.get(replyKey);
      if (raw) {
        await this.redis.del(replyKey);
        const reply = JSON.parse(raw) as Reply;
        if (reply.ok) return reply.result as T;
        const code = (ERROR_CODES as readonly string[]).includes(reply.code ?? "") ? (reply.code as ErrorCode) : "PUBLISH_FAILED";
        throw new AppError(code, reply.message ?? "Instagram session command failed", {
          ...(reply.reason ? { details: { reason: reply.reason } } : {}),
          ...(reply.retryAfterMs ? { retryAfterMs: reply.retryAfterMs } : {}),
        });
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
    throw new AppError("NETWORK_UNAVAILABLE", "The ingestion engine did not answer — is `npm run dev:ingestion` running?");
  }
}
