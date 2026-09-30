import net from "node:net";
import { ProxyAgent, fetch } from "undici";
import type { ProxyHealth } from "@reelflow/types";

export interface ProxyHealthResult {
  status: ProxyHealth;
  checkedAt: Date;
  latencyMs: number | null;
  /** Step that failed: "tcp" (nothing listening) or "http" (tunnel broken). */
  failedStep: "tcp" | "http" | null;
  error: string | null;
}

/** HTTP proxy URL for undici. sing-box "mixed" inbounds serve HTTP and SOCKS5 on one port. */
export function toHttpProxyUrl(proxyUrl: string): string {
  const u = new URL(proxyUrl);
  // WHATWG URL cannot switch a non-special scheme to http, so rebuild the string.
  if (!["http:", "socks5:", "socks5h:"].includes(u.protocol)) throw new Error(`Unsupported proxy scheme ${u.protocol}`);
  const auth = u.username ? `${u.username}:${u.password}@` : "";
  return `http://${auth}${u.host}`;
}

export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const done = (err?: Error) => {
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };
    socket.setTimeout(timeoutMs, () => done(new Error(`TCP connect to ${host}:${port} timed out`)));
    socket.once("connect", () => done());
    socket.once("error", (e) => done(e));
  });
}

/**
 * Two-step health check: (1) is anything listening on the proxy port,
 * (2) does a request through the proxy actually reach the internet.
 */
export async function checkProxyHealth(opts: {
  proxyUrl: string;
  healthUrl: string;
  timeoutMs: number;
  /** HTTP probes before declaring the tunnel unavailable (flaky tunnels). */
  attempts?: number;
}): Promise<ProxyHealthResult> {
  const u = new URL(opts.proxyUrl);
  try {
    await tcpProbe(u.hostname, Number(u.port), Math.min(opts.timeoutMs, 5_000));
  } catch (e) {
    return { status: "UNAVAILABLE", checkedAt: new Date(), latencyMs: null, failedStep: "tcp", error: (e as Error).message };
  }
  const agent = new ProxyAgent({ uri: toHttpProxyUrl(opts.proxyUrl) });
  const attempts = Math.max(1, opts.attempts ?? 3);
  const errors: string[] = [];
  try {
    for (let i = 0; i < attempts; i++) {
      const t = Date.now();
      try {
        const res = await fetch(opts.healthUrl, { dispatcher: agent, method: "GET", signal: AbortSignal.timeout(opts.timeoutMs), redirect: "manual" });
        await res.body?.cancel();
        if (res.status === 204 || res.status === 200) {
          const latencyMs = Date.now() - t;
          const degraded = errors.length > 0 || latencyMs > opts.timeoutMs / 2;
          return { status: degraded ? "DEGRADED" : "HEALTHY", checkedAt: new Date(), latencyMs, failedStep: null, error: errors.length ? `${errors.length} failed probe(s): ${errors.at(-1)}` : null };
        }
        errors.push(`Health URL returned ${res.status}`);
      } catch (e) {
        errors.push((e as Error).message);
      }
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
    return { status: "UNAVAILABLE", checkedAt: new Date(), latencyMs: null, failedStep: "http", error: `${errors.length}/${attempts} probes failed: ${errors.at(-1)}` };
  } finally {
    await agent.close().catch(() => undefined);
  }
}
