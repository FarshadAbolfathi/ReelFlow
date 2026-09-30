/**
 * Watermark engine.
 *
 * The watermark (text or image) is rendered to a transparent PNG with sharp,
 * with opacity and rotation baked in. FFmpeg then only overlays that PNG at a
 * numeric position — user text never enters an FFmpeg filter string.
 */
import sharp from "sharp";
import { readFile } from "node:fs/promises";
import type { WatermarkConfig, WatermarkPosition } from "@reelflow/types";
import { safeJoin } from "@reelflow/security";

/** Margins in presets are authored against a 1080px-wide frame. */
const REFERENCE_WIDTH = 1080;

export interface Placement {
  x: number;
  y: number;
}

export interface SafeArea {
  top: number;
  bottom: number;
  side: number;
}

const escapeXml = (s: string) =>
  s.replace(/[<>&'"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);

/** Detects right-to-left scripts (Persian/Arabic/Hebrew) to set SVG direction. */
const isRtl = (s: string) => /[\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Syriac}\p{Script=Thaana}]/u.test(s);

/**
 * Renders the watermark as a PNG buffer sized for a frame of `frameWidth` x `frameHeight`.
 * Image watermarks are read only from inside `assetsRoot` (never a user path).
 */
export async function renderWatermarkPng(
  config: WatermarkConfig,
  frameWidth: number,
  frameHeight: number,
  assetsRoot: string,
): Promise<{ png: Buffer; width: number; height: number }> {
  let img: sharp.Sharp;
  if (config.kind === "TEXT") {
    const text = (config.text ?? "").slice(0, 80);
    const fontSize = Math.max(12, Math.round(config.fontSizeRatio * frameHeight));
    const pad = Math.round(fontSize * 0.4);
    // Generous width estimate; trimmed afterwards.
    const w = Math.round(fontSize * 0.75 * Math.max(4, text.length) + pad * 2);
    const h = Math.round(fontSize * 1.6 + pad * 2);
    const dir = isRtl(text) ? "rtl" : "ltr";
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <style>text{font-family:Vazirmatn,'Vazirmatn Variable',Tahoma,Arial,sans-serif;font-weight:700}</style>
      <text x="50%" y="55%" dominant-baseline="middle" text-anchor="middle" direction="${dir}"
        font-size="${fontSize}" fill="${config.color}" stroke="rgba(0,0,0,0.45)" stroke-width="${Math.max(1, Math.round(fontSize / 18))}"
        paint-order="stroke">${escapeXml(text)}</text></svg>`;
    img = sharp(Buffer.from(svg)).trim({ threshold: 1 }).extend({
      top: pad,
      bottom: pad,
      left: pad,
      right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    });
  } else {
    if (!config.imageAssetKey) throw new Error("Image watermark requires an uploaded image");
    const file = safeJoin(assetsRoot, config.imageAssetKey);
    const target = Math.max(8, Math.round(config.scale * frameWidth));
    img = sharp(await readFile(file)).resize({ width: target, withoutEnlargement: false });
  }

  if (config.rotationDeg !== 0) {
    img = sharp(await img.png().toBuffer()).rotate(config.rotationDeg, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
  }

  // Bake opacity into the alpha channel.
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) data[i] = Math.round(data[i]! * config.opacity);
  const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  return { png, width: info.width, height: info.height };
}

/** Top-left pixel position for the watermark, honouring margin and the platform safe area. */
export function computePlacement(
  position: WatermarkPosition,
  frame: { width: number; height: number },
  mark: { width: number; height: number },
  marginPx: number,
  safeArea: SafeArea | null,
): Placement {
  const m = Math.round((marginPx * frame.width) / REFERENCE_WIDTH);
  const insetTop = safeArea ? Math.round(safeArea.top * frame.height) : 0;
  const insetBottom = safeArea ? Math.round(safeArea.bottom * frame.height) : 0;
  const insetSide = safeArea ? Math.round(safeArea.side * frame.width) : 0;

  const left = insetSide + m;
  const right = frame.width - insetSide - m - mark.width;
  const cx = Math.round((frame.width - mark.width) / 2);
  const top = insetTop + m;
  const bottom = frame.height - insetBottom - m - mark.height;
  const cy = Math.round((frame.height - mark.height) / 2);

  const table: Record<WatermarkPosition, Placement> = {
    TOP_LEFT: { x: left, y: top },
    TOP_CENTER: { x: cx, y: top },
    TOP_RIGHT: { x: right, y: top },
    CENTER: { x: cx, y: cy },
    BOTTOM_LEFT: { x: left, y: bottom },
    BOTTOM_CENTER: { x: cx, y: bottom },
    BOTTOM_RIGHT: { x: right, y: bottom },
  };
  const p = table[position];
  // Clamp so the mark is always fully on screen.
  return {
    x: Math.min(Math.max(0, p.x), Math.max(0, frame.width - mark.width)),
    y: Math.min(Math.max(0, p.y), Math.max(0, frame.height - mark.height)),
  };
}

const num = (n: number) => {
  if (!Number.isFinite(n)) throw new Error("Non-finite number in filter graph");
  return (Math.round(n * 1000) / 1000).toString();
};

/**
 * FFmpeg filter segment that overlays input `[wmLabel]` onto `[inLabel]`.
 * Built exclusively from validated numbers.
 */
export function buildOverlayFilter(params: {
  inLabel: string;
  wmLabel: string;
  outLabel: string;
  placement: Placement;
  startSec: number;
  endSec: number | null;
  durationSec: number;
  animation: WatermarkConfig["animation"];
}): string {
  const { placement, startSec, animation } = params;
  const end = Math.min(params.endSec ?? params.durationSec, params.durationSec);
  const fadeDur = Math.min(0.5, Math.max(0.1, (end - startSec) / 4));
  const wmChain = ["format=rgba"];
  if (animation === "FADE_IN" || animation === "FADE_IN_OUT") wmChain.push(`fade=t=in:st=${num(startSec)}:d=${num(fadeDur)}:alpha=1`);
  if (animation === "FADE_IN_OUT") wmChain.push(`fade=t=out:st=${num(Math.max(startSec, end - fadeDur))}:d=${num(fadeDur)}:alpha=1`);
  const alwaysOn = startSec <= 0 && end >= params.durationSec;
  const enable = alwaysOn ? "" : `:enable='between(t,${num(startSec)},${num(end)})'`;
  return (
    `[${params.wmLabel}]${wmChain.join(",")}[wmf];` +
    `[${params.inLabel}][wmf]overlay=x=${Math.round(placement.x)}:y=${Math.round(placement.y)}:eof_action=repeat${enable}[${params.outLabel}]`
  );
}
