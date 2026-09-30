/**
 * Output presets. Values follow Meta's published Instagram content-publishing
 * media specs; they are conservative so files are accepted on the first try.
 * Verify against current Meta docs when updating.
 */
export type PresetKey = "INSTAGRAM_REEL" | "INSTAGRAM_FEED" | "INSTAGRAM_STORY";
export type FitMode = "fit" | "fill" | "blur";

export interface MediaPreset {
  key: PresetKey;
  label: string;
  width: number;
  height: number;
  maxFps: number;
  videoBitrateK: number;
  audioBitrateK: number;
  audioSampleRate: number;
  maxDurationSec: number;
  minDurationSec: number;
  defaultFit: FitMode;
  /** Fractions of height/width covered by platform UI (captions, buttons). */
  safeArea: { top: number; bottom: number; side: number };
  imageMaxBytes: number;
}

export const PRESETS: Record<PresetKey, MediaPreset> = {
  INSTAGRAM_REEL: {
    key: "INSTAGRAM_REEL",
    label: "Instagram Reel (9:16)",
    width: 1080,
    height: 1920,
    maxFps: 30,
    videoBitrateK: 5000,
    audioBitrateK: 128,
    audioSampleRate: 48_000,
    maxDurationSec: 15 * 60,
    minDurationSec: 3,
    defaultFit: "blur",
    safeArea: { top: 0.13, bottom: 0.2, side: 0.06 },
    imageMaxBytes: 8 * 1024 * 1024,
  },
  INSTAGRAM_FEED: {
    key: "INSTAGRAM_FEED",
    label: "Instagram Feed (4:5)",
    width: 1080,
    height: 1350,
    maxFps: 30,
    videoBitrateK: 4500,
    audioBitrateK: 128,
    audioSampleRate: 48_000,
    maxDurationSec: 15 * 60,
    minDurationSec: 3,
    defaultFit: "blur",
    safeArea: { top: 0.04, bottom: 0.04, side: 0.04 },
    imageMaxBytes: 8 * 1024 * 1024,
  },
  INSTAGRAM_STORY: {
    key: "INSTAGRAM_STORY",
    label: "Instagram Story (9:16)",
    width: 1080,
    height: 1920,
    maxFps: 30,
    videoBitrateK: 4500,
    audioBitrateK: 128,
    audioSampleRate: 48_000,
    maxDurationSec: 60,
    minDurationSec: 3,
    defaultFit: "blur",
    safeArea: { top: 0.14, bottom: 0.18, side: 0.06 },
    imageMaxBytes: 8 * 1024 * 1024,
  },
};

export const isPresetKey = (k: string): k is PresetKey => k in PRESETS;
