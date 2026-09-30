import { describe, expect, it } from "vitest";
import { NetworkClient } from "@reelflow/http";
import { AppError } from "@reelflow/types";
import { InstagramSessionAdapter, createDefaultRegistry, type PlatformContext, type SessionCommand, type SessionRpc } from "../src/index";

class FakeRpc implements SessionRpc {
  calls: { cmd: SessionCommand; args: Record<string, unknown>; timeoutMs: number }[] = [];
  constructor(private readonly answer: (cmd: SessionCommand, args: Record<string, unknown>) => unknown) {}
  async call<T>(cmd: SessionCommand, args: Record<string, unknown>, timeoutMs: number): Promise<T> {
    this.calls.push({ cmd, args, timeoutMs });
    return this.answer(cmd, args) as T;
  }
}

const ctx: PlatformContext = { externalAccountId: "mypage", accessToken: "{}", network: new NetworkClient({ mode: "DIRECT" }) };
const req = { kind: "REEL" as const, mediaType: "VIDEO" as const, filePath: "/storage/processed/x.mp4", fileSize: 10, caption: "hello #x" };

describe("InstagramSessionAdapter", () => {
  it("uploads through the session channel with only ids, path and caption", async () => {
    const rpc = new FakeRpc((cmd) => (cmd === "publish" ? { externalPostId: "91", permalink: "https://www.instagram.com/reel/C91/" } : null));
    const adapter = new InstagramSessionAdapter(rpc);
    const { containerId } = await adapter.createPost(ctx, req);
    expect(containerId).toMatch(/^ig-session:/);
    expect((await adapter.getStatus()).state).toBe("FINISHED");
    const r = await adapter.publishPost(ctx, containerId);
    expect(r).toEqual({ externalPostId: "91", permalink: "https://www.instagram.com/reel/C91/" });
    expect(rpc.calls).toHaveLength(1);
    expect(rpc.calls[0]!.args).toEqual({ externalAccountId: "mypage", containerId, kind: "REEL", mediaType: "VIDEO", filePath: req.filePath, caption: "hello #x" });
    expect(JSON.stringify(rpc.calls[0]!.args)).not.toContain("accessToken");
  });

  it("re-uses the container id of an earlier attempt so a retry cannot post twice", async () => {
    const adapter = new InstagramSessionAdapter(new FakeRpc(() => null));
    expect((await adapter.createPost(ctx, { ...req, existingContainerId: "ig-session:abc" })).containerId).toBe("ig-session:abc");
    // A Graph API container id from another mode is not re-used.
    expect((await adapter.createPost(ctx, { ...req, existingContainerId: "17900000000" })).containerId).toMatch(/^ig-session:/);
  });

  it("fails retryably when the request was lost between steps", async () => {
    const adapter = new InstagramSessionAdapter(new FakeRpc(() => null));
    await expect(adapter.publishPost(ctx, "ig-session:unknown")).rejects.toMatchObject({ code: "PUBLISH_FAILED" });
  });

  it("rejects captions Instagram would reject before contacting the engine", async () => {
    const rpc = new FakeRpc(() => null);
    const adapter = new InstagramSessionAdapter(rpc);
    const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
    await expect(adapter.createPost(ctx, { ...req, caption: tags })).rejects.toBeInstanceOf(AppError);
    expect(rpc.calls).toHaveLength(0);
  });

  it("allows JPEG feed images (the session uploads files directly)", () => {
    const adapter = new InstagramSessionAdapter(new FakeRpc(() => null));
    const img = { mediaType: "IMAGE" as const, durationSec: null, width: 1080, height: 1350, fps: null, videoCodec: null, audioCodec: null, audioSampleRate: null, fileSize: 500_000, mime: "image/jpeg" };
    expect(adapter.validateMedia(img, "FEED")).toEqual([]);
    expect(adapter.capabilities.mediaTypes).toContain("IMAGE");
  });

  it("authenticates by asking the engine who is logged in", async () => {
    const rpc = new FakeRpc(() => ({ userId: "4242", username: "mypage" }));
    expect(await new InstagramSessionAdapter(rpc).authenticate(ctx)).toEqual({ externalAccountId: "mypage", username: "mypage" });
    expect(rpc.calls[0]).toMatchObject({ cmd: "identity", args: { externalAccountId: "mypage" } });
  });

  it("is what the registry uses in session mode", () => {
    const rpc = new FakeRpc(() => null);
    expect(createDefaultRegistry({ mode: "session", instagram: { graphVersion: "v23.0" }, sessionRpc: rpc }).get("INSTAGRAM")).toBeInstanceOf(InstagramSessionAdapter);
    expect(() => createDefaultRegistry({ mode: "session", instagram: { graphVersion: "v23.0" } })).toThrow();
  });
});
