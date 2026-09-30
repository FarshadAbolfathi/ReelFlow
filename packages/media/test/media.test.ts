import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { beforeAll, describe, expect, it } from "vitest";
import { watermarkConfigSchema, type WatermarkConfig } from "@reelflow/types";
import {
  PRESETS,
  buildFfmpegArgs,
  buildOverlayFilter,
  canStreamCopy,
  computePlacement,
  generateThumbnail,
  probeMedia,
  processMedia,
  renderWatermarkPng,
  runMediaTool,
  settingsHash,
  validateInput,
  type MediaMetadata,
} from "../src/index";

const dir = mkdtempSync(path.join(tmpdir(), "rf-media-"));
const clip = path.join(dir, "black-4s.mov");
const wm = (over: Partial<WatermarkConfig> = {}): WatermarkConfig =>
  watermarkConfigSchema.parse({ kind: "TEXT", text: "@MyPage", position: "BOTTOM_RIGHT", opacity: 1, ...over });

beforeAll(async () => {
  // 4s 640x360 black video @ 50fps with a 440Hz tone — deliberately non-conforming (wrong AR, fps, container).
  await runMediaTool("ffmpeg", [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=640x360:r=50:d=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", clip,
  ]);
}, 60_000);

describe("probe", () => {
  it("extracts video metadata", async () => {
    const m = await probeMedia(clip);
    expect(m).toMatchObject({ mediaType: "VIDEO", width: 640, height: 360, fps: 50, videoCodec: "h264", hasAudio: true, audioCodec: "aac" });
    expect(m.durationSec).toBeCloseTo(4, 0);
  });

  it("rejects non-media files", async () => {
    const bogus = path.join(dir, "bogus.mp4");
    await import("node:fs/promises").then((fs) => fs.writeFile(bogus, "not a video"));
    await expect(probeMedia(bogus)).rejects.toMatchObject({ code: "MEDIA_INVALID" });
  });
});

describe("placement & filters (pure)", () => {
  const frame = { width: 1080, height: 1920 };
  const mark = { width: 200, height: 60 };

  it("places bottom-right inside margin and safe area", () => {
    const p = computePlacement("BOTTOM_RIGHT", frame, mark, 32, PRESETS.INSTAGRAM_REEL.safeArea);
    expect(p.x).toBe(1080 - Math.round(0.06 * 1080) - 32 - 200);
    expect(p.y).toBe(1920 - Math.round(0.2 * 1920) - 32 - 60);
  });

  it("centers correctly and clamps on-screen", () => {
    expect(computePlacement("CENTER", frame, mark, 0, null)).toEqual({ x: 440, y: 930 });
    const huge = computePlacement("BOTTOM_RIGHT", frame, { width: 2000, height: 3000 }, 32, null);
    expect(huge).toEqual({ x: 0, y: 0 });
  });

  it("scales margins with frame width", () => {
    const small = computePlacement("TOP_LEFT", { width: 540, height: 960 }, mark, 32, null);
    expect(small).toEqual({ x: 16, y: 16 });
  });

  it("builds a numeric-only overlay filter with timing and fades", () => {
    const f = buildOverlayFilter({ inLabel: "scaled", wmLabel: "1:v", outLabel: "wmout", placement: { x: 10, y: 20 }, startSec: 1, endSec: 3, durationSec: 4, animation: "FADE_IN_OUT" });
    expect(f).toContain("overlay=x=10:y=20");
    expect(f).toContain("between(t,1,3)");
    expect(f).toContain("fade=t=in:st=1");
    expect(f).toContain("fade=t=out");
  });

  it("omits the enable clause when the mark is always visible", () => {
    const f = buildOverlayFilter({ inLabel: "a", wmLabel: "1:v", outLabel: "b", placement: { x: 0, y: 0 }, startSec: 0, endSec: null, durationSec: 4, animation: "NONE" });
    expect(f).not.toContain("enable");
  });

  it("settingsHash is stable and sensitive to settings", () => {
    expect(settingsHash({ presetKey: "INSTAGRAM_REEL" })).toBe(settingsHash({ presetKey: "INSTAGRAM_REEL" }));
    expect(settingsHash({ presetKey: "INSTAGRAM_REEL" })).not.toBe(settingsHash({ presetKey: "INSTAGRAM_REEL", watermark: wm() }));
  });

  it("builds an argument array (no shell) and never puts watermark text into args", () => {
    const meta = { durationSec: 4, fps: 50, hasAudio: true } as MediaMetadata;
    const args = buildFfmpegArgs({ input: "in.mp4", output: "out.mp4", meta, preset: PRESETS.INSTAGRAM_REEL, fit: "blur", watermarkPngPath: "wm.png", watermarkFilter: "[1:v]format=rgba[wmf];[fpsd][wmf]overlay=x=1:y=2[wmout]", normalizeAudio: false, streamCopy: false });
    expect(Array.isArray(args)).toBe(true);
    expect(args.join(" ")).toContain("fps=30");
    expect(args).toContain("+faststart");
    expect(args.join(" ")).not.toContain("@MyPage");
  });

  it("chooses stream copy only for already-conforming inputs without overlays", () => {
    const conforming = { mediaType: "VIDEO", formatName: "mov,mp4,m4a", videoCodec: "h264", pixelFormat: "yuv420p", rotation: 0, width: 1080, height: 1920, fps: 30, hasAudio: true, audioCodec: "aac" } as MediaMetadata;
    expect(canStreamCopy(conforming, PRESETS.INSTAGRAM_REEL, { presetKey: "INSTAGRAM_REEL" })).toBe(true);
    expect(canStreamCopy(conforming, PRESETS.INSTAGRAM_REEL, { presetKey: "INSTAGRAM_REEL", watermark: wm() })).toBe(false);
    expect(canStreamCopy({ ...conforming, fps: 60 }, PRESETS.INSTAGRAM_REEL, { presetKey: "INSTAGRAM_REEL" })).toBe(false);
  });

  it("validates duration limits", () => {
    const short = { mediaType: "VIDEO", durationSec: 1, displayWidth: 1080, displayHeight: 1920 } as MediaMetadata;
    expect(validateInput(short, PRESETS.INSTAGRAM_REEL)[0]?.field).toBe("duration");
    const long = { ...short, durationSec: 120 };
    expect(validateInput(long, PRESETS.INSTAGRAM_STORY)[0]?.field).toBe("duration");
  });
});

describe("watermark rendering", () => {
  it("renders text (including Persian and hostile strings) to a transparent PNG", async () => {
    for (const text of ["@MyPage", "پیج من", "'; rm -rf / #<script>", "a:b=c,d[e]"]) {
      const r = await renderWatermarkPng(wm({ text, opacity: 0.65 }), 1080, 1920, dir);
      const meta = await sharp(r.png).metadata();
      expect(meta.format).toBe("png");
      expect(meta.hasAlpha).toBe(true);
      expect(r.width).toBeGreaterThan(20);
    }
  });

  it("bakes opacity into alpha", async () => {
    const full = await renderWatermarkPng(wm({ opacity: 1 }), 1080, 1920, dir);
    const half = await renderWatermarkPng(wm({ opacity: 0.5 }), 1080, 1920, dir);
    const maxAlpha = async (png: Buffer) => (await sharp(png).stats()).channels[3]!.max;
    expect(await maxAlpha(half.png)).toBeLessThanOrEqual(Math.ceil((await maxAlpha(full.png)) * 0.5) + 1);
  });

  it("refuses image watermarks outside the assets root", async () => {
    await expect(renderWatermarkPng(wm({ kind: "IMAGE", imageAssetKey: "../../etc/passwd" }), 1080, 1920, dir)).rejects.toThrow();
  });
});

describe("processMedia (real ffmpeg)", () => {
  it("converts to a Reel: 1080x1920, h264/yuv420p, ≤30fps, aac, watermark visible bottom-right", async () => {
    const out = path.join(dir, "out", "reel.mp4");
    const r = await processMedia({ input: clip, outputPath: out, workDir: path.join(dir, "work"), assetsRoot: dir, options: { presetKey: "INSTAGRAM_REEL", fit: "fit", watermark: wm({ respectSafeArea: false, marginPx: 32 }) } });
    expect(r.streamCopied).toBe(false);
    expect(r.meta).toMatchObject({ width: 1080, height: 1920, videoCodec: "h264", pixelFormat: "yuv420p", audioCodec: "aac" });
    expect(r.meta.fps).toBeLessThanOrEqual(30);

    const frame = path.join(dir, "frame.png");
    await runMediaTool("ffmpeg", ["-y", "-ss", "2", "-i", out, "-frames:v", "1", frame]);
    // stats() must run on a materialized crop — sharp does not apply extract() before stats().
    const region = async (left: number, top: number) =>
      (await sharp(await sharp(frame).extract({ left, top, width: 300, height: 120 }).png().toBuffer()).stats()).channels[0]!.mean;
    const bottomRight = await region(1080 - 300 - 10, 1920 - 120 - 10);
    const topLeft = await region(10, 10);
    expect(bottomRight).toBeGreaterThan(topLeft + 10); // white text on black
  }, 120_000);

  it("is atomic: no partial output on failure", async () => {
    const out = path.join(dir, "out", "fail.mp4");
    await expect(
      processMedia({ input: path.join(dir, "missing.mp4"), outputPath: out, workDir: dir, assetsRoot: dir, options: { presetKey: "INSTAGRAM_REEL" } }),
    ).rejects.toBeTruthy();
    expect(existsSync(out)).toBe(false);
  });

  it("processes images to JPEG at the feed preset", async () => {
    const img = path.join(dir, "in.png");
    await sharp({ create: { width: 800, height: 600, channels: 3, background: "#224466" } }).png().toFile(img);
    const out = path.join(dir, "out", "feed.jpg");
    const r = await processMedia({ input: img, outputPath: out, workDir: dir, assetsRoot: dir, options: { presetKey: "INSTAGRAM_FEED", watermark: wm() } });
    const m = await sharp(r.outputPath).metadata();
    expect(m).toMatchObject({ format: "jpeg", width: 1080, height: 1350 });
  });

  it("generates a thumbnail", async () => {
    const thumb = path.join(dir, "thumbs", "t.jpg");
    await generateThumbnail(clip, thumb, await probeMedia(clip));
    expect((await sharp(thumb).metadata()).width).toBe(540);
  });
});
