/**
 * Single-pass processing: probe → (fit/crop/resize + fps cap + watermark + encode) → faststart MP4.
 * One encode per output; stream-copy when the input already conforms and nothing is overlaid.
 */
import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { AppError, type WatermarkConfig } from "@reelflow/types";
import { runMediaTool } from "./exec";
import { probeMedia, type MediaMetadata } from "./probe";
import { PRESETS, type FitMode, type MediaPreset, type PresetKey } from "./presets";
import { buildOverlayFilter, computePlacement, renderWatermarkPng } from "./watermark";

export const PIPELINE_VERSION = 1;

export interface ProcessOptions {
  presetKey: PresetKey;
  fit?: FitMode;
  watermark?: WatermarkConfig | null;
  normalizeAudio?: boolean;
}

/** Deterministic hash of everything that affects the output — the processing idempotency key. */
export function settingsHash(opts: ProcessOptions): string {
  const canonical = JSON.stringify({
    v: PIPELINE_VERSION,
    preset: opts.presetKey,
    fit: opts.fit ?? PRESETS[opts.presetKey].defaultFit,
    wm: opts.watermark ?? null,
    na: !!opts.normalizeAudio,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export interface ValidationIssue {
  field: string;
  message: string;
}

/** Validates the input against the preset before spending CPU on it. */
export function validateInput(meta: MediaMetadata, preset: MediaPreset): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (meta.mediaType === "VIDEO") {
    const d = meta.durationSec ?? 0;
    if (d < preset.minDurationSec) issues.push({ field: "duration", message: `Video is shorter than ${preset.minDurationSec}s` });
    if (d > preset.maxDurationSec) issues.push({ field: "duration", message: `Video is longer than ${preset.maxDurationSec}s` });
  }
  if (meta.displayWidth < 240 || meta.displayHeight < 240) issues.push({ field: "dimensions", message: "Media is too small (< 240px)" });
  return issues;
}

function scaleChain(preset: MediaPreset, fit: FitMode, inLabel: string, outLabel: string): string {
  const { width: W, height: H } = preset;
  switch (fit) {
    case "fill":
      return `[${inLabel}]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},setsar=1[${outLabel}]`;
    case "fit":
      return `[${inLabel}]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[${outLabel}]`;
    case "blur":
      return (
        `[${inLabel}]split=2[bgsrc][fgsrc];` +
        `[bgsrc]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20:2[bg];` +
        `[fgsrc]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];` +
        `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[${outLabel}]`
      );
  }
}

export function canStreamCopy(meta: MediaMetadata, preset: MediaPreset, opts: ProcessOptions): boolean {
  return (
    !opts.watermark &&
    !opts.normalizeAudio &&
    meta.mediaType === "VIDEO" &&
    meta.formatName.includes("mp4") &&
    meta.videoCodec === "h264" &&
    meta.pixelFormat === "yuv420p" &&
    meta.rotation === 0 &&
    meta.width === preset.width &&
    meta.height === preset.height &&
    (meta.fps ?? 0) <= preset.maxFps &&
    (!meta.hasAudio || meta.audioCodec === "aac")
  );
}

export interface BuildArgsInput {
  input: string;
  output: string;
  meta: MediaMetadata;
  preset: MediaPreset;
  fit: FitMode;
  watermarkPngPath?: string;
  watermarkFilter?: string;
  normalizeAudio: boolean;
  streamCopy: boolean;
}

/** Builds the ffmpeg argument array. Exported for tests. */
export function buildFfmpegArgs(i: BuildArgsInput): string[] {
  const args = ["-hide_banner", "-nostdin", "-y", "-i", i.input];
  if (i.streamCopy) {
    return [...args, "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy", "-movflags", "+faststart", "-map_metadata", "-1", i.output];
  }
  const dur = i.meta.durationSec ?? 0;
  if (i.watermarkPngPath) args.push("-loop", "1", "-framerate", String(i.preset.maxFps), "-t", dur.toFixed(3), "-i", i.watermarkPngPath);

  const parts: string[] = [scaleChain(i.preset, i.fit, "0:v", "scaled")];
  let last = "scaled";
  if ((i.meta.fps ?? 0) > i.preset.maxFps) {
    parts.push(`[${last}]fps=${i.preset.maxFps}[fpsd]`);
    last = "fpsd";
  }
  if (i.watermarkFilter) {
    parts.push(i.watermarkFilter);
    last = "wmout";
  }
  parts.push(`[${last}]format=yuv420p[vout]`);

  args.push("-filter_complex", parts.join(";"), "-map", "[vout]");
  if (i.meta.hasAudio) {
    args.push("-map", "0:a:0", "-c:a", "aac", "-b:a", `${i.preset.audioBitrateK}k`, "-ar", String(i.preset.audioSampleRate), "-ac", "2");
    if (i.normalizeAudio) args.push("-af", "loudnorm=I=-14:TP=-1.5:LRA=11");
  } else {
    args.push("-an");
  }
  args.push(
    "-c:v", "libx264",
    "-preset", "medium",
    "-profile:v", "high",
    "-pix_fmt", "yuv420p",
    "-b:v", `${i.preset.videoBitrateK}k`,
    "-maxrate", `${Math.round(i.preset.videoBitrateK * 1.25)}k`,
    "-bufsize", `${i.preset.videoBitrateK * 2}k`,
    "-movflags", "+faststart",
    "-map_metadata", "-1",
    "-shortest",
    i.output,
  );
  return args;
}

export interface ProcessResult {
  outputPath: string;
  meta: MediaMetadata;
  streamCopied: boolean;
  settingsHash: string;
}

/**
 * Processes a video or image into `outputPath` (written atomically).
 * `workDir` holds temporary files (watermark PNG); `assetsRoot` holds uploaded watermark images.
 */
export async function processMedia(params: {
  input: string;
  outputPath: string;
  workDir: string;
  assetsRoot: string;
  options: ProcessOptions;
  meta?: MediaMetadata;
}): Promise<ProcessResult> {
  const preset = PRESETS[params.options.presetKey];
  const fit = params.options.fit ?? preset.defaultFit;
  const meta = params.meta ?? (await probeMedia(params.input));
  const issues = validateInput(meta, preset);
  if (issues.length) throw new AppError("MEDIA_INVALID", issues.map((x) => x.message).join("; "), { details: { issues } });
  await mkdir(path.dirname(params.outputPath), { recursive: true });
  await mkdir(params.workDir, { recursive: true });
  const hash = settingsHash(params.options);
  const tmpOut = `${params.outputPath}.tmp${path.extname(params.outputPath)}`;

  try {
    if (meta.mediaType === "IMAGE") {
      await processImage(params.input, tmpOut, preset, fit, params.options.watermark ?? null, params.assetsRoot);
    } else {
      const streamCopy = canStreamCopy(meta, preset, params.options);
      let watermarkPngPath: string | undefined;
      let watermarkFilter: string | undefined;
      const wm = params.options.watermark;
      if (wm && !streamCopy) {
        const r = await renderWatermarkPng(wm, preset.width, preset.height, params.assetsRoot);
        watermarkPngPath = path.join(params.workDir, `wm-${hash}.png`);
        await writeFile(watermarkPngPath, r.png);
        const placement = computePlacement(wm.position, preset, r, wm.marginPx, wm.respectSafeArea ? preset.safeArea : null);
        watermarkFilter = buildOverlayFilter({
          inLabel: (meta.fps ?? 0) > preset.maxFps ? "fpsd" : "scaled",
          wmLabel: "1:v",
          outLabel: "wmout",
          placement,
          startSec: wm.startSec,
          endSec: wm.endSec,
          durationSec: meta.durationSec ?? 0,
          animation: wm.animation,
        });
      }
      const args = buildFfmpegArgs({
        input: params.input,
        output: tmpOut,
        meta,
        preset,
        fit,
        watermarkPngPath,
        watermarkFilter,
        normalizeAudio: !!params.options.normalizeAudio,
        streamCopy,
      });
      await runMediaTool("ffmpeg", args);
      await rename(tmpOut, params.outputPath);
      return { outputPath: params.outputPath, meta: await probeMedia(params.outputPath), streamCopied: streamCopy, settingsHash: hash };
    }
    await rename(tmpOut, params.outputPath);
    return { outputPath: params.outputPath, meta: await probeMedia(params.outputPath), streamCopied: false, settingsHash: hash };
  } catch (e) {
    await rm(tmpOut, { force: true });
    throw e;
  }
}

async function processImage(
  input: string,
  output: string,
  preset: MediaPreset,
  fit: FitMode,
  wm: WatermarkConfig | null,
  assetsRoot: string,
): Promise<void> {
  const { width: W, height: H } = preset;
  let base: Buffer;
  if (fit === "blur") {
    const bg = await sharp(input).rotate().resize(W, H, { fit: "cover" }).blur(30).toBuffer();
    const fg = await sharp(input).rotate().resize(W, H, { fit: "inside" }).toBuffer();
    base = await sharp(bg).composite([{ input: fg, gravity: "center" }]).toBuffer();
  } else {
    base = await sharp(input)
      .rotate()
      .resize(W, H, { fit: fit === "fill" ? "cover" : "contain", background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .toBuffer();
  }
  const composites: sharp.OverlayOptions[] = [];
  if (wm) {
    const r = await renderWatermarkPng(wm, W, H, assetsRoot);
    const p = computePlacement(wm.position, preset, r, wm.marginPx, wm.respectSafeArea ? preset.safeArea : null);
    composites.push({ input: r.png, left: p.x, top: p.y });
  }
  // Instagram image publishing accepts JPEG; strip metadata (GPS etc.).
  await sharp(base).composite(composites).jpeg({ quality: 90, mozjpeg: true }).toFile(output);
}

/** Poster frame (JPEG, 540px wide) for the library and previews. */
export async function generateThumbnail(input: string, output: string, meta: MediaMetadata): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  if (meta.mediaType === "IMAGE") {
    await sharp(input).rotate().resize({ width: 540 }).jpeg({ quality: 80 }).toFile(output);
    return;
  }
  const at = Math.min(1, (meta.durationSec ?? 0) * 0.1);
  await runMediaTool("ffmpeg", [
    "-hide_banner", "-nostdin", "-y", "-ss", at.toFixed(2), "-i", input, "-frames:v", "1", "-vf", "scale=540:-2", "-q:v", "4", output,
  ]);
}

/** Lightweight preview clip (540px) for the side-by-side comparison view. */
export async function generatePreview(input: string, output: string): Promise<void> {
  await mkdir(path.dirname(output), { recursive: true });
  await runMediaTool("ffmpeg", [
    "-hide_banner", "-nostdin", "-y", "-i", input, "-vf", "scale=540:-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
    "-c:a", "aac", "-b:a", "64k", "-movflags", "+faststart", output,
  ]);
}
