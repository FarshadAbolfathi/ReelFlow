import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MockAgent } from "undici";
import { describe, expect, it } from "vitest";
import { NetworkClient } from "@reelflow/http";
import {
  InstagramPublishingAdapter,
  MockPublishingAdapter,
  mapGraphError,
  validateInstagramCaption,
  validateInstagramMedia,
  type MediaForValidation,
  type PlatformContext,
} from "../src/index";

const V = "v23.0";
const IG = "17841400000000000";
const TOKEN = "EAAtest-token-value-123456";
const file = path.join(mkdtempSync(path.join(tmpdir(), "rf-ig-")), "reel.mp4");
writeFileSync(file, Buffer.alloc(1024, 1));

function setup() {
  const mock = new MockAgent();
  mock.disableNetConnect();
  const graph = mock.get("https://graph.facebook.com");
  const rupload = mock.get("https://rupload.facebook.com");
  const network = new NetworkClient({ mode: "DIRECT", dispatcher: mock });
  const ctx: PlatformContext = { externalAccountId: IG, accessToken: TOKEN, network };
  return { mock, graph, rupload, ctx, adapter: new InstagramPublishingAdapter({ graphVersion: V }) };
}

const json = (o: unknown) => JSON.stringify(o);
const req = { kind: "REEL" as const, mediaType: "VIDEO" as const, filePath: file, fileSize: 1024, caption: "Hello #funny\n\nvia @page" };

describe("InstagramPublishingAdapter (official Graph API flow)", () => {
  it("creates a resumable REELS container, uploads, polls and publishes", async () => {
    const { graph, rupload, ctx, adapter } = setup();
    let createBody = "";
    graph
      .intercept({ path: `/${V}/${IG}/media`, method: "POST", body: (b) => ((createBody = b), true) })
      .reply(200, json({ id: "C1", uri: `https://rupload.facebook.com/ig-api-upload/${V}/C1` }));
    let uploadHeaders: Record<string, string> = {};
    rupload
      .intercept({ path: `/ig-api-upload/${V}/C1`, method: "POST", headers: (h) => ((uploadHeaders = h as Record<string, string>), true) })
      .reply(200, json({ success: true }));
    graph.intercept({ path: (p) => p.startsWith(`/${V}/C1?`), method: "GET" }).reply(200, json({ status_code: "FINISHED" }));
    graph.intercept({ path: `/${V}/${IG}/media_publish`, method: "POST" }).reply(200, json({ id: "M1" }));
    graph.intercept({ path: (p) => p.startsWith(`/${V}/M1?`), method: "GET" }).reply(200, json({ permalink: "https://instagram.com/reel/M1" }));

    const { containerId } = await adapter.createPost(ctx, req);
    expect(containerId).toBe("C1");
    const params = new URLSearchParams(createBody);
    expect(params.get("media_type")).toBe("REELS");
    expect(params.get("upload_type")).toBe("resumable");
    expect(params.get("caption")).toBe(req.caption);
    expect(uploadHeaders.authorization).toBe(`OAuth ${TOKEN}`);
    expect(uploadHeaders.file_size).toBe("1024");

    expect((await adapter.getStatus(ctx, "C1")).state).toBe("FINISHED");
    expect(await adapter.publishPost(ctx, "C1")).toEqual({ externalPostId: "M1", permalink: "https://instagram.com/reel/M1" });
  });

  it("re-uses an existing container instead of creating a duplicate", async () => {
    const { graph, ctx, adapter } = setup();
    graph.intercept({ path: (p) => p.startsWith(`/${V}/C9?`), method: "GET" }).reply(200, json({ status_code: "FINISHED" }));
    const r = await adapter.createPost(ctx, { ...req, existingContainerId: "C9" });
    expect(r.containerId).toBe("C9");
  });

  it("maps HTTP 429 with Retry-After to RATE_LIMITED", async () => {
    const { graph, ctx, adapter } = setup();
    graph
      .intercept({ path: `/${V}/${IG}/media`, method: "POST" })
      .reply(429, json({ error: { message: "Application request limit reached", code: 4 } }), { headers: { "retry-after": "600" } });
    await expect(adapter.createPost(ctx, req)).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 600_000 });
  });

  it("maps the content-publishing limit subcode to RATE_LIMITED", async () => {
    const { graph, ctx, adapter } = setup();
    graph
      .intercept({ path: `/${V}/${IG}/media_publish`, method: "POST" })
      .reply(400, json({ error: { message: "The maximum number of posts has been reached", code: 9, error_subcode: 2207042 } }));
    await expect(adapter.publishPost(ctx, "C1")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("maps an invalid token (190) to AUTH_EXPIRED", async () => {
    const { graph, ctx, adapter } = setup();
    graph.intercept({ path: (p) => p.startsWith(`/${V}/${IG}?`), method: "GET" }).reply(400, json({ error: { message: "Error validating access token", code: 190 } }));
    await expect(adapter.authenticate(ctx)).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
  });

  it("refuses captions over Instagram's limits before calling the API", async () => {
    const { ctx, adapter } = setup();
    const caption = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
    await expect(adapter.createPost(ctx, { ...req, caption })).rejects.toMatchObject({ code: "MEDIA_INVALID" });
  });

  it("reports image publishing as unsupported in local mode (no public URL)", async () => {
    const { ctx, adapter } = setup();
    await expect(adapter.createPost(ctx, { ...req, mediaType: "IMAGE" })).rejects.toMatchObject({ code: "PLATFORM_UNSUPPORTED" });
  });

  it("does not put the access token in error messages", () => {
    const e = mapGraphError(400, { message: "bad", code: 100 }, null);
    expect(e.message).not.toContain(TOKEN);
  });
});

describe("Instagram media rules", () => {
  const good: MediaForValidation = { mediaType: "VIDEO", durationSec: 27, width: 1080, height: 1920, fps: 30, videoCodec: "h264", audioCodec: "aac", audioSampleRate: 48_000, fileSize: 20e6, mime: "video/mp4" };
  it("accepts a conforming reel", () => expect(validateInstagramMedia(good, "REEL")).toEqual([]));
  it("rejects too-short, wrong codec, too-long stories", () => {
    expect(validateInstagramMedia({ ...good, durationSec: 2 }, "REEL")[0]?.field).toBe("duration");
    expect(validateInstagramMedia({ ...good, videoCodec: "vp9" }, "REEL")[0]?.field).toBe("videoCodec");
    expect(validateInstagramMedia({ ...good, durationSec: 75 }, "STORY")[0]?.field).toBe("duration");
  });
  it("counts hashtags and mentions", () => {
    expect(validateInstagramCaption("ok #a #b @c")).toEqual([]);
    expect(validateInstagramCaption("x".repeat(2201))[0]?.field).toBe("caption");
  });
});

describe("MockPublishingAdapter", () => {
  it("scripts failures then recovers", async () => {
    const m = new MockPublishingAdapter().failNext({ step: "publishPost", code: "RATE_LIMITED", retryAfterMs: 1000 });
    const ctx = { externalAccountId: "1", accessToken: "t", network: undefined as never };
    const { containerId } = await m.createPost(ctx, req);
    await expect(m.publishPost(ctx, containerId)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect((await m.publishPost(ctx, containerId)).externalPostId).toBe("mock-post-1");
  });
  it("publishing the same container twice returns the same post (idempotent)", async () => {
    const m = new MockPublishingAdapter();
    const ctx = { externalAccountId: "1", accessToken: "t", network: undefined as never };
    const { containerId } = await m.createPost(ctx, req);
    const a = await m.publishPost(ctx, containerId);
    const b = await m.publishPost(ctx, containerId);
    expect(a.externalPostId).toBe(b.externalPostId);
    expect(m.published.size).toBe(1);
  });
});
