import { AppError, type Platform } from "@reelflow/types";
import { InstagramPublishingAdapter, type InstagramAdapterOptions } from "./instagram/adapter";
import { MockPublishingAdapter } from "./mock";
import type { PublishingAdapter } from "./types";

export * from "./types";
export * from "./mock";
export * from "./instagram/adapter";
export * from "./instagram/errors";
export * from "./instagram/rules";

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

export function createDefaultRegistry(opts: { mode: "mock" | "live"; instagram: InstagramAdapterOptions }): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(opts.mode === "live" ? new InstagramPublishingAdapter(opts.instagram) : new MockPublishingAdapter());
  return registry;
}
