import path from "node:path";
import { open } from "node:fs/promises";
import { AppError } from "@reelflow/types";

/**
 * Produces a safe filename: ASCII letters/digits/-/_/. only, no leading dots,
 * no path separators, bounded length. The extension is preserved if allowed.
 */
export function sanitizeFilename(name: string, maxLength = 100): string {
  const base = path.basename(name.replace(/\\/g, "/"));
  const ext = path.extname(base).toLowerCase().replace(/[^.a-z0-9]/g, "");
  const stem = base
    .slice(0, base.length - path.extname(base).length)
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^\.+/, "");
  const safeStem = (stem || "file").slice(0, Math.max(1, maxLength - ext.length));
  return `${safeStem}${ext}`;
}

/**
 * Joins `relative` under `root` and guarantees the result stays inside `root`.
 * Rejects absolute paths, `..` traversal, NUL bytes.
 */
export function safeJoin(root: string, ...relative: string[]): string {
  const rootAbs = path.resolve(root);
  for (const part of relative) {
    if (part.includes("\0")) throw new AppError("VALIDATION_FAILED", "Invalid path");
    if (path.isAbsolute(part)) throw new AppError("VALIDATION_FAILED", "Absolute paths are not allowed");
  }
  const full = path.resolve(rootAbs, ...relative);
  if (full !== rootAbs && !full.startsWith(rootAbs + path.sep)) {
    throw new AppError("VALIDATION_FAILED", "Path escapes the storage root");
  }
  return full;
}

export type DetectedMedia =
  | { mediaType: "VIDEO"; mime: "video/mp4" | "video/quicktime" | "video/webm" | "video/x-matroska"; ext: string }
  | { mediaType: "IMAGE"; mime: "image/jpeg" | "image/png" | "image/webp"; ext: string };

/** Magic-byte sniffing. The declared Content-Type / extension is never trusted. */
export function detectMediaType(head: Buffer): DetectedMedia | null {
  if (head.length < 12) return null;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { mediaType: "IMAGE", mime: "image/jpeg", ext: ".jpg" };
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { mediaType: "IMAGE", mime: "image/png", ext: ".png" };
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP")
    return { mediaType: "IMAGE", mime: "image/webp", ext: ".webp" };
  if (head.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = head.subarray(8, 12).toString("latin1");
    if (brand === "qt  ") return { mediaType: "VIDEO", mime: "video/quicktime", ext: ".mov" };
    if (/^(isom|iso[2-9]|mp4[12]|avc1|M4V |dash|mmp4|MSNV|3gp[4-6])/.test(brand))
      return { mediaType: "VIDEO", mime: "video/mp4", ext: ".mp4" };
    return null;
  }
  if (head.readUInt32BE(0) === 0x1a45dfa3) {
    const text = head.toString("latin1");
    return text.includes("webm")
      ? { mediaType: "VIDEO", mime: "video/webm", ext: ".webm" }
      : { mediaType: "VIDEO", mime: "video/x-matroska", ext: ".mkv" };
  }
  return null;
}

export async function detectFileMediaType(filePath: string): Promise<DetectedMedia | null> {
  const fh = await open(filePath, "r");
  try {
    const buf = Buffer.alloc(64);
    const { bytesRead } = await fh.read(buf, 0, 64, 0);
    return detectMediaType(buf.subarray(0, bytesRead));
  } finally {
    await fh.close();
  }
}
