/**
 * Instagram content-publishing media requirements (Meta developer docs,
 * "Content Publishing" — Reels/Stories video & image specs). Kept conservative.
 */
import type { ContentKind } from "@reelflow/types";
import type { MediaForValidation, ValidationIssue } from "../types";

export const INSTAGRAM_LIMITS = {
  captionMaxChars: 2200,
  maxHashtags: 30,
  maxMentions: 20,
  reel: { minSec: 3, maxSec: 15 * 60, maxBytes: 300 * 1024 * 1024, minFps: 23, maxFps: 60, maxWidth: 1920 },
  story: { minSec: 3, maxSec: 60, maxBytes: 100 * 1024 * 1024 },
  image: { maxBytes: 8 * 1024 * 1024, minWidth: 320, maxWidth: 1440, minAspect: 4 / 5, maxAspect: 1.91 },
  videoCodecs: ["h264", "hevc"],
  audioCodecs: ["aac"],
  maxAudioSampleRate: 48_000,
} as const;

export function validateInstagramMedia(m: MediaForValidation, kind: ContentKind): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });

  if (m.mediaType === "IMAGE") {
    if (m.mime !== "image/jpeg") add("format", "Instagram accepts JPEG images only");
    if (m.fileSize > INSTAGRAM_LIMITS.image.maxBytes) add("fileSize", "Image exceeds 8 MB");
    if (kind !== "STORY") {
      const ar = m.width / m.height;
      if (ar < INSTAGRAM_LIMITS.image.minAspect - 0.01 || ar > INSTAGRAM_LIMITS.image.maxAspect + 0.01)
        add("aspectRatio", "Feed images must be between 4:5 and 1.91:1");
    }
    if (m.width < INSTAGRAM_LIMITS.image.minWidth) add("width", "Image is narrower than 320px");
    return issues;
  }

  const spec = kind === "STORY" ? INSTAGRAM_LIMITS.story : INSTAGRAM_LIMITS.reel;
  const d = m.durationSec ?? 0;
  if (d < spec.minSec) add("duration", `Video must be at least ${spec.minSec}s`);
  if (d > spec.maxSec) add("duration", `Video must be at most ${spec.maxSec}s for ${kind.toLowerCase()}`);
  if (m.fileSize > spec.maxBytes) add("fileSize", `Video exceeds ${Math.round(spec.maxBytes / 1024 / 1024)} MB`);
  if (!m.videoCodec || !(INSTAGRAM_LIMITS.videoCodecs as readonly string[]).includes(m.videoCodec))
    add("videoCodec", "Video must be H.264 or HEVC");
  if (m.audioCodec && !(INSTAGRAM_LIMITS.audioCodecs as readonly string[]).includes(m.audioCodec)) add("audioCodec", "Audio must be AAC");
  if (m.audioSampleRate && m.audioSampleRate > INSTAGRAM_LIMITS.maxAudioSampleRate) add("audioSampleRate", "Audio sample rate must be ≤ 48 kHz");
  if (m.fps !== null && (m.fps < INSTAGRAM_LIMITS.reel.minFps || m.fps > INSTAGRAM_LIMITS.reel.maxFps)) add("fps", "Frame rate must be 23–60 fps");
  if (m.width > INSTAGRAM_LIMITS.reel.maxWidth) add("width", "Video width must be ≤ 1920px");
  return issues;
}

/** Caption rules: length, hashtag and mention counts. */
export function validateInstagramCaption(caption: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if ([...caption].length > INSTAGRAM_LIMITS.captionMaxChars) issues.push({ field: "caption", message: "Caption exceeds 2,200 characters" });
  const hashtags = caption.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  if (hashtags.length > INSTAGRAM_LIMITS.maxHashtags) issues.push({ field: "hashtags", message: "More than 30 hashtags" });
  const mentions = caption.match(/(^|\s)@[A-Za-z0-9._]+/g) ?? [];
  if (mentions.length > INSTAGRAM_LIMITS.maxMentions) issues.push({ field: "mentions", message: "More than 20 @mentions" });
  return issues;
}
