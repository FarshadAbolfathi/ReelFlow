/**
 * Instagram publishing through an in-app login session, for installs that cannot
 * use the Graph API (no Meta developer app is available from Iran).
 *
 * The session itself lives in the Python ingestion engine (instagrapi); this
 * adapter sends it commands over `SessionRpc`. Commands carry only ids, file
 * paths and captions — the password/cookies stay encrypted in the database.
 *
 *   createPost  → picks a stable container id (re-used on retries) and remembers the request
 *   getStatus   → FINISHED (the upload happens in one step)
 *   publishPost → uploads + configures; the engine remembers the result per container id,
 *                 so a retried job returns the earlier post instead of posting twice
 *
 * The policy gate (daily/hourly ceilings, minimum interval, approval, rights)
 * runs before any of this, exactly as for the Graph API adapter.
 */
import { randomUUID } from "node:crypto";
import { AppError, type ContentKind } from "@reelflow/types";
import type {
  AccountIdentity,
  ContainerState,
  CreatePostRequest,
  MediaForValidation,
  PlatformCapabilities,
  PlatformContext,
  PublishingAdapter,
} from "../types";
import { validateInstagramCaption, validateInstagramMedia } from "./rules";

export type SessionCommand = "login" | "identity" | "publish";

/** Request/reply channel to the engine that holds the Instagram sessions. */
export interface SessionRpc {
  call<T>(cmd: SessionCommand, args: Record<string, unknown>, timeoutMs: number): Promise<T>;
}

export const SESSION_CONTAINER_PREFIX = "ig-session:";

export class InstagramSessionAdapter implements PublishingAdapter {
  readonly platform = "INSTAGRAM" as const;
  readonly capabilities: PlatformCapabilities = {
    kinds: ["REEL", "STORY", "FEED"],
    mediaTypes: ["VIDEO", "IMAGE"],
    deletePost: false,
    analytics: false,
    quota: false,
  };
  /** Requests between createPost and publishPost of the same attempt (same process). */
  private readonly pending = new Map<string, CreatePostRequest>();

  constructor(
    private readonly rpc: SessionRpc,
    private readonly opts: { publishTimeoutMs?: number; identityTimeoutMs?: number } = {},
  ) {}

  async authenticate(ctx: PlatformContext): Promise<AccountIdentity> {
    const r = await this.rpc.call<{ userId: string; username: string }>("identity", { externalAccountId: ctx.externalAccountId }, this.opts.identityTimeoutMs ?? 120_000);
    return { externalAccountId: ctx.externalAccountId, username: r.username };
  }

  validateMedia(media: MediaForValidation, kind: ContentKind) {
    return validateInstagramMedia(media, kind);
  }

  async createPost(_ctx: PlatformContext, req: CreatePostRequest): Promise<{ containerId: string }> {
    const captionIssues = validateInstagramCaption(req.caption);
    if (captionIssues.length) throw new AppError("MEDIA_INVALID", captionIssues.map((i) => i.message).join("; "));
    const containerId = req.existingContainerId?.startsWith(SESSION_CONTAINER_PREFIX) ? req.existingContainerId : `${SESSION_CONTAINER_PREFIX}${randomUUID()}`;
    this.pending.set(containerId, req);
    return { containerId };
  }

  async getStatus(): Promise<{ state: ContainerState; detail?: string }> {
    return { state: "FINISHED" };
  }

  async publishPost(ctx: PlatformContext, containerId: string): Promise<{ externalPostId: string; permalink: string | null }> {
    const req = this.pending.get(containerId);
    if (!req) throw new AppError("PUBLISH_FAILED", "Upload request was lost (worker restarted); it will be retried");
    try {
      return await this.rpc.call<{ externalPostId: string; permalink: string | null }>(
        "publish",
        { externalAccountId: ctx.externalAccountId, containerId, kind: req.kind, mediaType: req.mediaType, filePath: req.filePath, caption: req.caption },
        this.opts.publishTimeoutMs ?? 20 * 60_000,
      );
    } finally {
      this.pending.delete(containerId);
    }
  }
}
