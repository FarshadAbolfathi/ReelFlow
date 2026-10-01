import { AppError, type Platform } from "@reelflow/types";
import { InstagramPublishingAdapter, type InstagramAdapterOptions } from "./instagram/adapter";
import { InstagramSessionAdapter, type SessionRpc } from "./instagram/session-adapter";
import { MockPublishingAdapter } from "./mock";
import type { PublishingAdapter } from "./types";

export * from "./types";
export * from "./mock";
export * from "./instagram/adapter";
export * from "./instagram/errors";
export * from "./instagram/rules";
export * from "./instagram/session-adapter";

/**
 * Registry of publishing adapters. Adding TikTok/YouTube/… means registering a
 * new PublishingAdapter here — nothing else in the system changes.
 */
export class AdapterRegistry {
  private readonly adapters = new Map<Platform, PublishingAdapter>();

  register(adapter: PublishingAdapter): this {
    this.adapters.set(adapter.platform, adapter);
    return this;
  }

  get(platform: Platform): PublishingAdapter {
    const a = this.adapters.get(platform);
    if (!a) throw new AppError("PLATFORM_UNSUPPORTED", `No publishing adapter for ${platform}`);
    return a;
  }

  has(platform: Platform): boolean {
    return this.adapters.has(platform);
  }
}

export type PublishingAdapterMode = "mock" | "live" | "session";

export function createDefaultRegistry(opts: { mode: PublishingAdapterMode; instagram: InstagramAdapterOptions; sessionRpc?: SessionRpc }): AdapterRegistry {
  const registry = new AdapterRegistry();
  if (opts.mode === "session") {
    if (!opts.sessionRpc) throw new Error("PUBLISHING_ADAPTER_MODE=session needs the ingestion engine session channel");
    registry.register(new InstagramSessionAdapter(opts.sessionRpc));
  } else {
    registry.register(opts.mode === "live" ? new InstagramPublishingAdapter(opts.instagram) : new MockPublishingAdapter());
  }
  return registry;
}
