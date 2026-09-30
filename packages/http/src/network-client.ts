/**
 * Centralized outbound HTTP for the Node side (publisher, analytics).
 *
 * Rules:
 *  - Every client is created with an explicit NetworkMode. Environment proxy
 *    variables are never consulted (an explicit dispatcher is always passed).
 *  - PROXY mode fails closed: if the proxy is unhealthy, requests throw
 *    NETWORK_UNAVAILABLE. There is no fallback to a direct connection.
 *  - DIRECT mode pins connections to DNS answers that passed the SSRF check.
 *  - Redirects are followed manually and every hop is re-validated.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { LookupFunction } from "node:net";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { Agent, ProxyAgent, fetch, type Dispatcher, type RequestInit, type Response } from "undici";
import { AppError, type NetworkMode } from "@reelflow/types";
import { assertPublicDestination, isBlockedIp, validatePublicUrl, type Resolver } from "@reelflow/security";
import { createLogger, redactString, type Logger } from "@reelflow/logger";
import { checkProxyHealth, toHttpProxyUrl, type ProxyHealthResult } from "./proxy-health";

export interface NetworkClientOptions {
  mode: NetworkMode;
  /** Required for PROXY mode, e.g. http://127.0.0.1:10808 */
  proxyUrl?: string;
  healthUrl?: string;
  healthTimeoutMs?: number;
  /** How long a successful health check is trusted. */
  healthCacheMs?: number;
  /** Enforce SSRF rules (on by default; off only for trusted fixed API hosts in tests). */
  ssrfProtection?: boolean;
  defaultTimeoutMs?: number;
  maxRedirects?: number;
  resolver?: Resolver;
  logger?: Logger;
  /** Injected in tests to observe or stub the health check. */
  healthCheck?: () => Promise<ProxyHealthResult>;
  /** Tests only: replace the transport (e.g. undici MockAgent). Mode rules still apply. */
  dispatcher?: Dispatcher;
}

export interface RequestOptions extends Omit<RequestInit, "dispatcher" | "redirect" | "signal"> {
  timeoutMs?: number;
  /** Job id for network observability logs. */
  jobId?: string;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  sha256: string;
  contentType: string | null;
  finalUrl: string;
}

export class NetworkClient {
  readonly mode: NetworkMode;
  private readonly opts: Required<Omit<NetworkClientOptions, "mode" | "proxyUrl" | "resolver" | "logger" | "healthCheck" | "dispatcher">> & {
    proxyUrl: string | undefined;
  };
  private readonly dispatcher: Dispatcher;
  private readonly log: Logger;
  private readonly healthCheck: () => Promise<ProxyHealthResult>;
  private lastHealth: ProxyHealthResult | null = null;

  constructor(options: NetworkClientOptions) {
    this.mode = options.mode;
    this.opts = {
      proxyUrl: options.proxyUrl,
      healthUrl: options.healthUrl ?? "https://www.gstatic.com/generate_204",
      healthTimeoutMs: options.healthTimeoutMs ?? 20_000,
      healthCacheMs: options.healthCacheMs ?? 30_000,
      ssrfProtection: options.ssrfProtection ?? true,
      defaultTimeoutMs: options.defaultTimeoutMs ?? 60_000,
      maxRedirects: options.maxRedirects ?? 5,
    };
    this.log = options.logger ?? createLogger("network-client");

    if (this.mode === "PROXY" && !options.proxyUrl) {
      throw new AppError("NETWORK_UNAVAILABLE", "PROXY mode requires a proxy URL");
    }
    if (options.dispatcher) {
      this.dispatcher = options.dispatcher;
    } else if (this.mode === "PROXY") {
      this.dispatcher = new ProxyAgent({ uri: toHttpProxyUrl(options.proxyUrl!) });
    } else {
      const resolver = options.resolver;
      const ssrf = this.opts.ssrfProtection;
      // Pin DNS: the socket connects only to an address that passed the SSRF check.
      const lookup: LookupFunction = (hostname, lookupOpts, callback) => {
        const resolve = resolver
          ? resolver(hostname)
          : assertPublicDestination(new URL(`http://${hostname.includes(":") ? `[${hostname}]` : hostname}/`));
        resolve
          .then((addrs) => {
            const safe = ssrf ? addrs.filter((a) => !isBlockedIp(a)) : addrs;
            const first = safe[0];
            if (!first) throw new AppError("URL_BLOCKED", `No public address for ${hostname}`);
            const family = first.includes(":") ? 6 : 4;
            if ((lookupOpts as { all?: boolean }).all) {
              (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, safe.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));
            } else callback(null, first, family);
          })
          .catch((e: Error) => callback(e as NodeJS.ErrnoException, "", 4));
      };
      this.dispatcher = new Agent({ connect: { lookup } });
    }
    this.healthCheck =
      options.healthCheck ??
      (() =>
        checkProxyHealth({
          proxyUrl: this.opts.proxyUrl!,
          healthUrl: this.opts.healthUrl,
          timeoutMs: this.opts.healthTimeoutMs,
        }));
  }

  /** Throws NETWORK_UNAVAILABLE if this client's declared mode cannot be used right now. */
  async assertAvailable(): Promise<void> {
    if (this.mode === "DIRECT") return;
    const fresh = this.lastHealth && Date.now() - this.lastHealth.checkedAt.getTime() < this.opts.healthCacheMs;
    if (!fresh || this.lastHealth?.status === "UNAVAILABLE") {
      this.lastHealth = await this.healthCheck();
    }
    if (this.lastHealth!.status === "UNAVAILABLE") {
      throw new AppError("NETWORK_UNAVAILABLE", `Proxy unavailable (${this.lastHealth!.failedStep}): ${this.lastHealth!.error}`, {
        details: { mode: this.mode, failedStep: this.lastHealth!.failedStep },
      });
    }
  }

  get proxyStatus(): ProxyHealthResult | null {
    return this.lastHealth;
  }

  private validate(url: URL): void {
    if (!this.opts.ssrfProtection) return;
    validatePublicUrl(url.toString());
  }

  /** Low-level request with manual, re-validated redirects. */
  async request(rawUrl: string, options: RequestOptions = {}): Promise<Response> {
    await this.assertAvailable();
    let url = new URL(rawUrl);
    const { timeoutMs, jobId, ...init } = options;
    const started = Date.now();
    for (let hop = 0; hop <= this.opts.maxRedirects; hop++) {
      this.validate(url);
      let res: Response;
      try {
        res = await fetch(url, {
          ...init,
          dispatcher: this.dispatcher,
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs ?? this.opts.defaultTimeoutMs),
        });
      } catch (e) {
        const err = e as Error & { cause?: unknown };
        if (err.cause instanceof AppError) throw err.cause;
        const code = this.mode === "PROXY" ? "NETWORK_UNAVAILABLE" : "SOURCE_UNAVAILABLE";
        this.log.warn({ jobId, mode: this.mode, host: url.host, err }, "network request failed");
        throw new AppError(code, redactString(`Request to ${url.host} failed: ${err.message}`), { cause: e });
      }
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel();
        url = new URL(location, url);
        continue;
      }
      this.log.info(
        { jobId, mode: this.mode, host: url.host, status: res.status, durationMs: Date.now() - started },
        "network request",
      );
      return res;
    }
    throw new AppError("SOURCE_UNAVAILABLE", `Too many redirects for ${new URL(rawUrl).host}`);
  }

  get(url: string, options: RequestOptions = {}) {
    return this.request(url, { ...options, method: "GET" });
  }

  post(url: string, options: RequestOptions = {}) {
    return this.request(url, { ...options, method: "POST" });
  }

  /** Streams the response body (caller must consume or cancel it). */
  async stream(url: string, options: RequestOptions = {}): Promise<Readable> {
    const res = await this.get(url, options);
    if (!res.ok || !res.body) throw new AppError("SOURCE_UNAVAILABLE", `GET ${new URL(url).host} returned ${res.status}`);
    return Readable.fromWeb(res.body as NodeReadableStream);
  }

  /** Downloads to `destPath` atomically, enforcing a byte limit and computing SHA-256 on the fly. */
  async download(url: string, destPath: string, opts: RequestOptions & { maxBytes: number }): Promise<DownloadResult> {
    const res = await this.get(url, opts);
    if (!res.ok || !res.body) throw new AppError("SOURCE_UNAVAILABLE", `Download returned ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > opts.maxBytes) {
      await res.body.cancel();
      throw new AppError("MEDIA_INVALID", `File is larger than the ${opts.maxBytes} byte limit`);
    }
    const hash = createHash("sha256");
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > opts.maxBytes) return cb(new AppError("MEDIA_INVALID", "Download exceeded the size limit"));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const tmp = `${destPath}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body as NodeReadableStream), limiter, createWriteStream(tmp, { mode: 0o600 }));
      await rename(tmp, destPath);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    return { path: destPath, bytes, sha256: hash.digest("hex"), contentType: res.headers.get("content-type"), finalUrl: res.url || url };
  }

  async close(): Promise<void> {
    await this.dispatcher.close();
  }
}
