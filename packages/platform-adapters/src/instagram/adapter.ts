/**
 * Instagram publishing via the official Instagram Graph API content-publishing flow:
 *
 *   1. POST /{ig-user-id}/media  (media_type=REELS|STORIES, upload_type=resumable) → container id + upload uri
 *   2. POST {rupload uri} with the file bytes (Authorization: OAuth <token>)
 *   3. GET  /{container-id}?fields=status_code  until FINISHED
 *   4. POST /{ig-user-id}/media_publish?creation_id={container-id}
 *
 * Requires a professional (Business/Creator) account and a user access token
 * granted through Meta's OAuth flow. No passwords, no browser automation.
 *
 * Image posts need a publicly reachable image_url, which a local-first install
 * does not have; they are reported as PLATFORM_UNSUPPORTED unless
 * `publicMediaBaseUrl` is configured (TODO: signed public media endpoint).
 */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { AppError, type ContentKind } from "@reelflow/types";
import type {
  AccountIdentity,
  ContainerState,
  CreatePostRequest,
  MediaForValidation,
  PlatformCapabilities,
  PlatformContext,
  PublishingAdapter,
  PublishingQuota,
  AnalyticsAdapter,
  MetricValue,
} from "../types";
import { mapGraphError, type GraphError } from "./errors";
import { validateInstagramCaption, validateInstagramMedia } from "./rules";

export interface InstagramAdapterOptions {
  graphVersion: string;
  graphHost?: string;
  uploadHost?: string;
}

const parseRetryAfter = (v: string | null): number | null => (v && /^\d+$/.test(v) ? Number(v) * 1000 : null);

export class InstagramPublishingAdapter implements PublishingAdapter, AnalyticsAdapter {
  readonly platform = "INSTAGRAM" as const;
  readonly capabilities: PlatformCapabilities = {
    kinds: ["REEL", "STORY", "FEED"],
    mediaTypes: ["VIDEO"],
    deletePost: false, // not offered by the content-publishing API
    analytics: true,
    quota: true,
  };
  private readonly base: string;
  private readonly upload: string;

  constructor(private readonly opts: InstagramAdapterOptions) {
    this.base = `https://${opts.graphHost ?? "graph.facebook.com"}/${opts.graphVersion}`;
    this.upload = `https://${opts.uploadHost ?? "rupload.facebook.com"}/ig-api-upload/${opts.graphVersion}`;
  }

  private async graph<T>(ctx: PlatformContext, method: "GET" | "POST", path: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.base}/${path}`);
    const body = new URLSearchParams({ ...params, access_token: ctx.accessToken });
    let res;
    if (method === "GET") {
      for (const [k, v] of body) url.searchParams.set(k, v);
      res = await ctx.network.get(url.toString(), { jobId: ctx.jobId, timeoutMs: 60_000 });
    } else {
      res = await ctx.network.post(url.toString(), {
        jobId: ctx.jobId,
        timeoutMs: 60_000,
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
    }
    const text = await res.text();
    let json: { error?: GraphError } & Record<string, unknown>;
    try {
      json = JSON.parse(text);
    } catch {
      throw new AppError("PUBLISH_FAILED", `Instagram returned non-JSON (HTTP ${res.status})`);
    }
    if (!res.ok || json.error) throw mapGraphError(res.status, json.error, parseRetryAfter(res.headers.get("retry-after")));
    return json as T;
  }

  async authenticate(ctx: PlatformContext): Promise<AccountIdentity> {
    const r = await this.graph<{ id: string; username?: string }>(ctx, "GET", ctx.externalAccountId, { fields: "id,username" });
    if (r.id !== ctx.externalAccountId) throw new AppError("AUTH_EXPIRED", "Token does not belong to this Instagram account");
    return { externalAccountId: r.id, username: r.username ?? null };
  }

  validateMedia(media: MediaForValidation, kind: ContentKind) {
    const issues = validateInstagramMedia(media, kind);
    if (media.mediaType === "IMAGE")
      issues.push({ field: "mediaType", message: "Image publishing needs a public media URL, which local mode does not provide yet" });
    return issues;
  }

  async createPost(ctx: PlatformContext, req: CreatePostRequest): Promise<{ containerId: string }> {
    if (req.mediaType !== "VIDEO") throw new AppError("PLATFORM_UNSUPPORTED", "Instagram image publishing requires a public image URL (not available in local mode)");
    const captionIssues = validateInstagramCaption(req.caption);
    if (captionIssues.length) throw new AppError("MEDIA_INVALID", captionIssues.map((i) => i.message).join("; "));

    // Idempotency: an earlier attempt already created (and possibly uploaded) a container.
    if (req.existingContainerId) {
      const s = await this.getStatus(ctx, req.existingContainerId);
      if (s.state !== "ERROR" && s.state !== "EXPIRED") return { containerId: req.existingContainerId };
    }

    const mediaType = req.kind === "STORY" ? "STORIES" : "REELS";
    const params: Record<string, string> = { media_type: mediaType, upload_type: "resumable" };
    if (req.kind !== "STORY") params.caption = req.caption;
    if (req.kind === "REEL" || req.kind === "FEED") params.share_to_feed = "true";
    const created = await this.graph<{ id: string; uri?: string }>(ctx, "POST", `${ctx.externalAccountId}/media`, params);
    const uploadUri = created.uri ?? `${this.upload}/${created.id}`;

    const res = await ctx.network.post(uploadUri, {
      jobId: ctx.jobId,
      timeoutMs: 15 * 60_000,
      headers: {
        authorization: `OAuth ${ctx.accessToken}`,
        offset: "0",
        file_size: String(req.fileSize),
        "content-type": "application/octet-stream",
      },
      body: Readable.toWeb(createReadStream(req.filePath)) as unknown as ReadableStream,
      duplex: "half",
    } as never);
    const text = await res.text();
    if (!res.ok) {
      let err: GraphError | undefined;
      try {
        err = (JSON.parse(text) as { error?: GraphError; debug_info?: { message?: string } }).error;
      } catch {
        /* non-JSON upload error */
      }
      throw mapGraphError(res.status, err ?? { message: `upload failed (HTTP ${res.status})` }, parseRetryAfter(res.headers.get("retry-after")));
    }
    return { containerId: created.id };
  }

  async getStatus(ctx: PlatformContext, containerId: string): Promise<{ state: ContainerState; detail?: string }> {
    const r = await this.graph<{ status_code?: string; status?: string }>(ctx, "GET", containerId, { fields: "status_code,status" });
    const code = (r.status_code ?? "IN_PROGRESS").toUpperCase();
    const state: ContainerState = ["FINISHED", "ERROR", "EXPIRED", "PUBLISHED", "IN_PROGRESS"].includes(code) ? (code as ContainerState) : "IN_PROGRESS";
    return { state, ...(r.status ? { detail: r.status } : {}) };
  }

  async publishPost(ctx: PlatformContext, containerId: string): Promise<{ externalPostId: string; permalink: string | null }> {
    const r = await this.graph<{ id: string }>(ctx, "POST", `${ctx.externalAccountId}/media_publish`, { creation_id: containerId });
    let permalink: string | null = null;
    try {
      permalink = (await this.graph<{ permalink?: string }>(ctx, "GET", r.id, { fields: "permalink" })).permalink ?? null;
    } catch {
      // Permalink is cosmetic; the post is already published.
    }
    return { externalPostId: r.id, permalink };
  }

  async getPublishingQuota(ctx: PlatformContext): Promise<PublishingQuota> {
    const r = await this.graph<{ data?: { quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }[] }>(
      ctx,
      "GET",
      `${ctx.externalAccountId}/content_publishing_limit`,
      { fields: "quota_usage,config" },
    );
    const d = r.data?.[0];
    return { used: d?.quota_usage ?? 0, total: d?.config?.quota_total ?? 0, windowHours: Math.round((d?.config?.quota_duration ?? 86_400) / 3600) };
  }

  async getPostMetrics(ctx: PlatformContext, externalPostId: string): Promise<MetricValue[]> {
    // Only metrics the API returns are stored; unavailable ones are simply absent.
    const r = await this.graph<{ data?: { name: string; values?: { value: number }[]; total_value?: { value: number } }[] }>(
      ctx,
      "GET",
      `${externalPostId}/insights`,
      { metric: "reach,likes,comments,shares,saved,total_interactions,views" },
    );
    return (r.data ?? []).flatMap((m) => {
      const v = m.total_value?.value ?? m.values?.[0]?.value;
      return typeof v === "number" ? [{ name: m.name, value: v }] : [];
    });
  }
}
