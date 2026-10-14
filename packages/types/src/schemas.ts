/**
 * Zod input schemas shared by API (validation) and web (forms).
 * Server-side limits (policy ceilings) are enforced separately in @reelflow/config.
 */
import { z } from "zod";
import {
  APPROVAL_MODES,
  CONTENT_KINDS,
  MEDIA_TYPES,
  PLATFORMS,
  RIGHTS_STATUSES,
  USER_ROLES,
  WATERMARK_ANIMATIONS,
  WATERMARK_POSITIONS,
} from "./enums";

const enumOf = <T extends string>(v: readonly T[]) => z.enum(v as [T, ...T[]]);

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const timeOfDaySchema = z.string().regex(HHMM, "Expected HH:MM (24h)");

export const idSchema = z.string().uuid();

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});

// ── Auth ───────────────────────────────────────────────────────────────
export const loginSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(512),
});

export const createUserSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().min(1).max(120),
  password: z.string().min(12, "At least 12 characters").max(512),
  role: enumOf(USER_ROLES),
});

// ── Sources ────────────────────────────────────────────────────────────
export const sourceInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  url: z.string().trim().max(2048).optional().nullable(),
  platform: enumOf(PLATFORMS),
  active: z.boolean().default(true),
  allowedMediaTypes: z.array(enumOf(MEDIA_TYPES)).min(1).default(["VIDEO"]),
  importFrequencyMinutes: z.number().int().min(15).max(10_080).default(360),
  maxItemsPerInterval: z.number().int().min(1).max(50).default(5),
  approvalRequired: z.boolean().default(true),
  attributionRequired: z.boolean().default(true),
  attributionText: z.string().max(200).optional().nullable(),
  rightsStatus: enumOf(RIGHTS_STATUSES),
  rightsEvidence: z.string().max(2000).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
});
export type SourceInput = z.infer<typeof sourceInputSchema>;

export const sourceReviewSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().max(1000).optional(),
});

// ── Content ────────────────────────────────────────────────────────────
export const contentFilterSchema = paginationSchema.extend({
  sourceId: idSchema.optional(),
  mediaType: enumOf(MEDIA_TYPES).optional(),
  processingStatus: z.string().optional(),
  approvalStatus: z.string().optional(),
  publishStatus: z.string().optional(),
  rightsStatus: z.string().optional(),
  q: z.string().max(200).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  includeDuplicates: z.coerce.boolean().default(false),
});

export const captionUpdateSchema = z.object({
  customCaption: z.string().max(2200).nullable().optional(),
  captionTemplateId: idSchema.nullable().optional(),
  hashtags: z.array(z.string().regex(/^[\p{L}\p{N}_]{1,100}$/u)).max(30).optional(),
  mentions: z.array(z.string().regex(/^[A-Za-z0-9._]{1,30}$/)).max(20).optional(),
  cta: z.string().max(300).nullable().optional(),
  attribution: z.string().max(300).nullable().optional(),
});

export const approvalDecisionSchema = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  note: z.string().max(1000).optional(),
});

// ── Watermark ──────────────────────────────────────────────────────────
export const watermarkConfigSchema = z
  .object({
    kind: z.enum(["TEXT", "IMAGE"]),
    text: z.string().max(80).optional(),
    fontSizeRatio: z.number().min(0.01).max(0.2).default(0.04),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#FFFFFF"),
    /** Stored asset key for image watermarks — never a user-supplied path. */
    imageAssetKey: z.string().max(200).optional(),
    opacity: z.number().min(0.05).max(1).default(0.65),
    scale: z.number().min(0.02).max(0.6).default(0.18),
    position: enumOf(WATERMARK_POSITIONS).default("BOTTOM_RIGHT"),
    marginPx: z.number().int().min(0).max(400).default(32),
    rotationDeg: z.number().min(-45).max(45).default(0),
    startSec: z.number().min(0).max(3600).default(0),
    endSec: z.number().min(0).max(3600).nullable().default(null),
    animation: enumOf(WATERMARK_ANIMATIONS).default("NONE"),
    respectSafeArea: z.boolean().default(true),
  })
  .refine((v) => (v.kind === "TEXT" ? !!v.text : !!v.imageAssetKey), {
    message: "Text watermarks need text; image watermarks need an uploaded image",
  })
  .refine((v) => v.endSec === null || v.endSec > v.startSec, { message: "endSec must be after startSec" });
export type WatermarkConfig = z.infer<typeof watermarkConfigSchema>;

export const watermarkPresetInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  isDefault: z.boolean().default(false),
  config: watermarkConfigSchema,
});

// ── Caption templates ──────────────────────────────────────────────────
export const captionTemplateInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  body: z.string().min(1).max(2200),
  defaultHashtags: z.array(z.string()).max(30).default([]),
  cta: z.string().max(300).optional().nullable(),
  isDefault: z.boolean().default(false),
});

// ── Schedule ───────────────────────────────────────────────────────────
export const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const timeWindowSchema = z
  .object({ start: timeOfDaySchema, end: timeOfDaySchema })
  .refine((w) => w.start < w.end, { message: "Window start must be before end" });

export const dayPlanSchema = z.object({
  /** Exact publishing times for this weekday. */
  times: z.array(timeOfDaySchema).max(24).default([]),
  /** Optional windows; slots are spread evenly inside when `times` is empty. */
  windows: z.array(timeWindowSchema).max(6).default([]),
  postsInWindows: z.number().int().min(0).max(24).default(0),
});

export const scheduleInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  accountId: idSchema,
  timezone: z.string().min(1).max(64),
  active: z.boolean().default(true),
  postsPerDay: z.number().int().min(1).max(50),
  days: z.partialRecord(z.enum(WEEKDAYS), dayPlanSchema),
  minIntervalMinutes: z.number().int().min(1).max(1440),
  maxIntervalMinutes: z.number().int().min(1).max(10_080).nullable().default(null),
  /** Relative weights per source id; missing sources get weight 1. */
  sourceWeights: z.record(z.string(), z.number().min(0).max(100)).default({}),
  contentKindWeights: z.partialRecord(enumOf(CONTENT_KINDS), z.number().min(0).max(100)).default({}),
});
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export const reschedulePostSchema = z.object({
  scheduledAt: z.string().datetime(),
});

export const schedulePostSchema = z.object({
  contentId: idSchema,
  accountId: idSchema,
  kind: enumOf(CONTENT_KINDS).default("REEL"),
  scheduledAt: z.string().datetime().optional(),
});

// ── Settings (user-editable; ceilings enforced server-side) ────────────
export const settingsSchema = z.object({
  general: z.object({
    brandName: z.string().max(80).default("ReelFlow"),
    locale: z.enum(["fa", "en"]).default("fa"),
    timezone: z.string().default("Asia/Tehran"),
  }),
  approval: z.object({
    mode: enumOf(APPROVAL_MODES).default("SEMI_AUTO"),
  }),
  publishing: z.object({
    autoPublishEnabled: z.boolean().default(false),
    maxPostsPerDay: z.number().int().min(0).default(6),
    maxPostsPerHour: z.number().int().min(0).default(1),
    minPostIntervalMinutes: z.number().int().min(1).default(90),
    maxPostsPerSourcePerDay: z.number().int().min(0).default(3),
    requireAttributionForThirdParty: z.boolean().default(true),
  }),
  safety: z.object({
    blockUnknownRights: z.boolean().default(true),
    pauseOnRateLimit: z.boolean().default(true),
    baseBackoffMinutes: z.number().int().min(1).max(1440).default(15),
    maxBackoffMinutes: z.number().int().min(15).max(10_080).default(24 * 60),
    maxPublishRetries: z.number().int().min(0).max(10).default(3),
  }),
  queue: z.object({
    maxConcurrentJobs: z.number().int().min(1).max(8).default(2),
  }),
  media: z.object({
    defaultPreset: z.enum(["INSTAGRAM_REEL", "INSTAGRAM_FEED", "INSTAGRAM_STORY"]).default("INSTAGRAM_REEL"),
    normalizeAudio: z.boolean().default(false),
    defaultWatermarkPresetId: z.string().uuid().nullable().default(null),
  }),
  storage: z.object({
    originalsRetentionDays: z.number().int().min(1).max(3650).default(30),
    processedRetentionDays: z.number().int().min(1).max(3650).default(90),
    failedRetentionDays: z.number().int().min(1).max(3650).default(30),
    warnFreeSpaceGb: z.number().min(1).max(10_000).default(10),
  }),
  notifications: z.object({
    onPublishSuccess: z.boolean().default(true),
    onPublishFailure: z.boolean().default(true),
    onQueuePaused: z.boolean().default(true),
  }),
});
export type Settings = z.infer<typeof settingsSchema>;
export type SettingsSection = keyof Settings;
export const settingsPatchSchema = z.object({
  section: z.enum(Object.keys(settingsSchema.shape) as [SettingsSection, ...SettingsSection[]]),
  values: z.record(z.string(), z.unknown()),
});

// ── Accounts ───────────────────────────────────────────────────────────
export const connectAccountSchema = z.object({
  name: z.string().trim().min(1).max(80),
  platform: z.literal("INSTAGRAM"),
  /** Instagram professional account id (IG user id). */
  externalAccountId: z.string().regex(/^\d{5,32}$/),
  /** User access token from the official OAuth flow. Encrypted at rest; never returned. */
  accessToken: z.string().min(20).max(4096),
  tokenExpiresAt: z.string().datetime().optional(),
});

/** In-app Instagram login (PUBLISHING_ADAPTER_MODE=session). Password/sessionid are encrypted at rest; never returned. */
export const connectSessionSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    username: z.string().trim().regex(/^@?[A-Za-z0-9._]{1,30}$/, "Invalid Instagram username"),
    password: z.string().min(1).max(256).optional(),
    /** `sessionid` cookie of a logged-in browser — an alternative when Instagram keeps asking to confirm logins. */
    sessionId: z.string().trim().min(30).max(512).optional(),
    /** Two-factor code, when Instagram asks for one. */
    verificationCode: z.string().trim().regex(/^\d{6,8}$/).optional(),
  })
  .refine((v) => !!v.password || !!v.sessionId, { message: "Enter the password or a sessionid", path: ["password"] });
export type ConnectSessionInput = z.infer<typeof connectSessionSchema>;

// ── Network servers (Settings → Network: user-added SSH/SOCKS5 proxies) ────
export const networkServerCreateSchema = z.object({
  name: z.string().trim().min(1).max(80),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(512),
});
export type NetworkServerCreateInput = z.infer<typeof networkServerCreateSchema>;

export const networkSelectSchema = z.object({
  /** "direct" disables the proxy entirely; "builtin" uses the .env-configured
   * VPS proxy; anything else is a NetworkServer id. */
  target: z.string().trim().min(1).max(80),
});
