/**
 * Node side of the network control plane. The Python engine owns the proxy
 * process (ProxyManager) and publishes its status to Redis; the API sends
 * commands over a Redis stream and waits for the reply key.
 */
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { AppError, NETWORK_CONTROL, type NetworkCommand } from "@reelflow/types";

export interface NetworkStatus {
  mode: "direct" | "proxy";
  provider: string;
  proxyAddress: string | null;
  ownership: "external" | "managed" | "none";
  processRunning: boolean;
  health: "HEALTHY" | "DEGRADED" | "UNAVAILABLE" | "DISABLED";
  lastCheckAt: string | null;
  latencyMs: number | null;
  lastError: string | null;
  runtimeValid: boolean;
  runtimeProblems: string[];
  engineHeartbeatAt: string | null;
}

export class NetworkControl {
  constructor(private readonly redis: Redis) {}

  async status(): Promise<NetworkStatus | null> {
    const raw = await this.redis.get(NETWORK_CONTROL.statusKey);
    return raw ? (JSON.parse(raw) as NetworkStatus) : null;
  }

  /** Sends a command to the ingestion engine; rejects if it does not answer in time. */
  async command(cmd: NetworkCommand, requestedBy: string, timeoutMs = 45_000): Promise<{ ok: boolean; status: NetworkStatus | null; message: string }> {
    const id = randomUUID();
    await this.redis.xadd(NETWORK_CONTROL.commandStream, "MAXLEN", "~", "1000", "*", "id", id, "cmd", cmd, "by", requestedBy);
    const replyKey = `${NETWORK_CONTROL.replyKeyPrefix}${id}`;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const reply = await this.redis.get(replyKey);
      if (reply) {
        await this.redis.del(replyKey);
        return JSON.parse(reply);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new AppError("NETWORK_UNAVAILABLE", "The ingestion engine did not respond — is `npm run dev:ingestion` running?");
  }
}
