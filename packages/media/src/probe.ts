import { stat } from "node:fs/promises";
import { AppError, type MediaType } from "@reelflow/types";
import { runMediaTool } from "./exec";

export interface MediaMetadata {
  mediaType: MediaType;
  formatName: string;
  durationSec: number | null;
  width: number;
  height: number;
  /** Display dimensions after applying rotation metadata. */
  displayWidth: number;
  displayHeight: number;
  rotation: number;
  fps: number | null;
  videoCodec: string | null;
  pixelFormat: string | null;
  audioCodec: string | null;
  audioSampleRate: number | null;
  hasAudio: boolean;
  bitRate: number | null;
  fileSize: number;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  sample_rate?: string;
  duration?: string;
  tags?: Record<string, string>;
  side_data_list?: { rotation?: number }[];
  disposition?: { attached_pic?: number };
}

const parseRate = (r?: string): number | null => {
  if (!r) return null;
  const [n, d] = r.split("/").map(Number);
  if (!n || !d) return null;
  return Math.round((n / d) * 1000) / 1000;
};

const IMAGE_FORMATS = new Set(["image2", "png_pipe", "jpeg_pipe", "webp_pipe", "mjpeg"]);

export async function probeMedia(filePath: string): Promise<MediaMetadata> {
  const { stdout } = await runMediaTool(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", "--", filePath],
    { timeoutMs: 60_000 },
  );
  let data: { streams?: FfprobeStream[]; format?: { format_name?: string; duration?: string; bit_rate?: string } };
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new AppError("MEDIA_INVALID", "ffprobe returned unreadable output");
  }
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === "audio");
  if (!video || !video.width || !video.height) throw new AppError("MEDIA_INVALID", "No video/image stream found");

  const formatName = data.format?.format_name ?? "unknown";
  const isImage =
    formatName.split(",").some((f) => IMAGE_FORMATS.has(f)) || ["png", "mjpeg", "webp"].includes(video.codec_name ?? "");
  const rotationRaw = video.side_data_list?.find((s) => typeof s.rotation === "number")?.rotation ?? Number(video.tags?.rotate ?? 0);
  const rotation = ((Math.round(rotationRaw) % 360) + 360) % 360;
  const swapped = rotation === 90 || rotation === 270;
  const durationStr = data.format?.duration ?? video.duration;
  const size = (await stat(filePath)).size;

  return {
    mediaType: isImage ? "IMAGE" : "VIDEO",
    formatName,
    durationSec: isImage ? null : durationStr ? Number(durationStr) : null,
    width: video.width,
    height: video.height,
    displayWidth: swapped ? video.height : video.width,
    displayHeight: swapped ? video.width : video.height,
    rotation,
    fps: isImage ? null : parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate),
    videoCodec: video.codec_name ?? null,
    pixelFormat: video.pix_fmt ?? null,
    audioCodec: audio?.codec_name ?? null,
    audioSampleRate: audio?.sample_rate ? Number(audio.sample_rate) : null,
    hasAudio: !!audio,
    bitRate: data.format?.bit_rate ? Number(data.format.bit_rate) : null,
    fileSize: size,
  };
}
