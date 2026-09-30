/**
 * In-memory publishing adapter for development and tests. Makes no network
 * calls. Failure modes can be scripted to exercise retries and the safety monitor.
 */
import { randomUUID } from "node:crypto";
import { AppError, type ContentKind, type ErrorCode } from "@reelflow/types";
import type {
  AccountIdentity,
  ContainerState,
  CreatePostRequest,
  MediaForValidation,
  PlatformCapabilities,
  PlatformContext,
  PublishingAdapter,
  PublishingQuota,
} from "./types";
import { validateInstagramCaption, validateInstagramMedia } from "./instagram/rules";

export type MockStep = "authenticate" | "createPost" | "getStatus" | "publishPost";

export interface MockFailure {
  step: MockStep;
  code: ErrorCode;
  retryAfterMs?: number;
  /** Fail this many times, then succeed. Default: forever. */
  times?: number;
}

export class MockPublishingAdapter implements PublishingAdapter {
  readonly platform = "INSTAGRAM" as const;
  readonly capabilities: PlatformCapabilities = { kinds: ["REEL", "STORY", "FEED"], mediaTypes: ["VIDEO", "IMAGE"], deletePost: true, analytics: false, quota: true };
  readonly calls: { step: MockStep; containerId?: string }[] = [];
  readonly published = new Map<string, { containerId: string; caption: string }>();
  private readonly containers = new Map<string, { caption: string; polls: number; published: boolean }>();
  private failures: MockFailure[] = [];

  constructor(private readonly opts: { pollsUntilFinished?: number; quotaTotal?: number } = {}) {}

  failNext(f: MockFailure): this {
    this.failures.push({ times: 1, ...f });
    return this;
  }

  failAlways(f: Omit<MockFailure, "times">): this {
    this.failures.push({ ...f, times: Number.POSITIVE_INFINITY });
    return this;
  }

  reset(): void {
    this.failures = [];
    this.calls.length = 0;
  }

  private maybeFail(step: MockStep) {
    const f = this.failures.find((x) => x.step === step && (x.times ?? 0) > 0);
    if (!f) return;
    f.times = (f.times ?? 1) - 1;
    throw new AppError(f.code, `mock ${step} failure: ${f.code}`, f.retryAfterMs !== undefined ? { retryAfterMs: f.retryAfterMs } : {});
  }

  async authenticate(ctx: PlatformContext): Promise<AccountIdentity> {
    this.calls.push({ step: "authenticate" });
    this.maybeFail("authenticate");
    return { externalAccountId: ctx.externalAccountId, username: "mock_account" };
  }

  validateMedia(media: MediaForValidation, kind: ContentKind) {
    return validateInstagramMedia(media, kind);
  }

  async createPost(_ctx: PlatformContext, req: CreatePostRequest): Promise<{ containerId: string }> {
    this.calls.push({ step: "createPost", containerId: req.existingContainerId ?? undefined });
    this.maybeFail("createPost");
    const issues = validateInstagramCaption(req.caption);
    if (issues.length) throw new AppError("MEDIA_INVALID", issues.map((i) => i.message).join("; "));
    if (req.existingContainerId && this.containers.has(req.existingContainerId)) return { containerId: req.existingContainerId };
    const id = `mock-container-${randomUUID()}`;
    this.containers.set(id, { caption: req.caption, polls: 0, published: false });
    return { containerId: id };
  }

  async getStatus(_ctx: PlatformContext, containerId: string): Promise<{ state: ContainerState }> {
    this.calls.push({ step: "getStatus", containerId });
    this.maybeFail("getStatus");
    const c = this.containers.get(containerId);
    if (!c) return { state: "EXPIRED" };
    if (c.published) return { state: "PUBLISHED" };
    c.polls += 1;
    return { state: c.polls >= (this.opts.pollsUntilFinished ?? 1) ? "FINISHED" : "IN_PROGRESS" };
  }

  async publishPost(_ctx: PlatformContext, containerId: string): Promise<{ externalPostId: string; permalink: string | null }> {
    this.calls.push({ step: "publishPost", containerId });
    this.maybeFail("publishPost");
    const c = this.containers.get(containerId);
    if (!c) throw new AppError("PUBLISH_FAILED", "Unknown container");
    if (c.published) {
      const existing = [...this.published.entries()].find(([, v]) => v.containerId === containerId);
      return { externalPostId: existing![0], permalink: null };
    }
    c.published = true;
    const id = `mock-post-${this.published.size + 1}`;
    this.published.set(id, { containerId, caption: c.caption });
    return { externalPostId: id, permalink: `https://instagram.com/p/${id}` };
  }

  async getPublishingQuota(): Promise<PublishingQuota> {
    return { used: this.published.size, total: this.opts.quotaTotal ?? 50, windowHours: 24 };
  }

  async deletePost(_ctx: PlatformContext, externalPostId: string): Promise<void> {
    this.published.delete(externalPostId);
  }
}
