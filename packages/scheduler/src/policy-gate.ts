/**
 * The publishing gate: a pure function evaluated immediately before every
 * publish attempt (and when auto-scheduling). If any check fails the post is
 * not published; the reasons are stored and shown to the user.
 */
import {
  PUBLISHABLE_RIGHTS,
  type AccountStatus,
  type ApprovalMode,
  type ApprovalStatus,
  type ErrorCode,
  type ProcessingStatus,
  type RightsStatus,
  type SafetyState,
  type SourceVettingStatus,
} from "@reelflow/types";

export interface GateContext {
  now: Date;
  settings: {
    approvalMode: ApprovalMode;
    autoPublishEnabled: boolean;
    blockUnknownRights: boolean;
    requireAttributionForThirdParty: boolean;
  };
  limits: {
    maxPostsPerDay: number;
    maxPostsPerHour: number;
    minPostIntervalMinutes: number;
    maxPostsPerSourcePerDay: number;
  };
  account: {
    status: AccountStatus;
    safetyState: SafetyState;
    pausedUntil: Date | null;
    dailyLimit: number | null;
  };
  content: {
    processingStatus: ProcessingStatus;
    approvalStatus: ApprovalStatus;
    rightsStatus: RightsStatus;
    isDuplicate: boolean;
    hasPublishableAsset: boolean;
  };
  source: {
    active: boolean;
    vettingStatus: SourceVettingStatus;
    attributionRequired: boolean;
  } | null;
  post: {
    /** true when the post was placed by the auto-scheduler rather than a person */
    autoScheduled: boolean;
    caption: string;
    attributionText: string | null;
  };
  /** Publish timestamps on this account (successful or in flight) within the last 24h. */
  recentPublishes: Date[];
  /** Publishes from this post's source on this account in the last 24h. */
  recentSourcePublishes: number;
}

export interface GateViolation {
  code: ErrorCode;
  message: string;
}

export interface GateResult {
  allowed: boolean;
  violations: GateViolation[];
  /** When the first time-based limit clears, if that is the only blocker. */
  retryAt: Date | null;
}

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

export function evaluatePublishGate(ctx: GateContext): GateResult {
  const v: GateViolation[] = [];
  const add = (code: ErrorCode, message: string) => v.push({ code, message });
  const now = ctx.now.getTime();
  let retryAt: number | null = null;
  const later = (t: number) => {
    retryAt = retryAt === null ? t : Math.max(retryAt, t);
  };

  // Account & safety
  if (ctx.account.status === "AUTH_EXPIRED") add("AUTH_EXPIRED", "The account's authorization expired — reconnect it");
  else if (ctx.account.status !== "CONNECTED") add("PUBLISH_FAILED", `Account is ${ctx.account.status.toLowerCase()}`);
  if (ctx.account.safetyState === "PAUSED") {
    const until = ctx.account.pausedUntil?.getTime();
    if (until === undefined || until > now) {
      add("ACCOUNT_PAUSED", "Publishing on this account is paused by the safety monitor");
      if (until !== undefined) later(until);
    }
  }

  // Content state
  if (ctx.content.isDuplicate) add("DUPLICATE_CONTENT", "This item is a duplicate of existing content");
  if (ctx.content.processingStatus !== "READY" || !ctx.content.hasPublishableAsset)
    add("PROCESSING_FAILED", "Processed media is not ready");
  if (ctx.content.approvalStatus === "REJECTED") add("APPROVAL_REQUIRED", "Content was rejected");
  else if (ctx.content.approvalStatus !== "APPROVED") add("APPROVAL_REQUIRED", "Content has not been approved");
  if (ctx.settings.approvalMode === "MANUAL" && ctx.post.autoScheduled)
    add("APPROVAL_REQUIRED", "MANUAL mode: automatically scheduled posts are never published");
  if (ctx.post.autoScheduled && !ctx.settings.autoPublishEnabled)
    add("APPROVAL_REQUIRED", "Auto-publish is turned off in settings");

  // Rights & source vetting
  if (ctx.content.rightsStatus === "DO_NOT_IMPORT") add("RIGHTS_NOT_CONFIRMED", "Rights status is 'do not import'");
  else if (ctx.content.rightsStatus === "UNKNOWN") {
    if (ctx.settings.blockUnknownRights || ctx.post.autoScheduled)
      add("RIGHTS_NOT_CONFIRMED", "Rights are unknown — confirm permission before publishing");
  } else if (!PUBLISHABLE_RIGHTS.includes(ctx.content.rightsStatus)) {
    add("RIGHTS_NOT_CONFIRMED", "Rights status does not allow publishing");
  }
  if (ctx.source) {
    if (ctx.source.vettingStatus !== "APPROVED") add("SOURCE_NOT_APPROVED", "The source has not been approved by the owner");
    if (!ctx.source.active) add("SOURCE_NOT_APPROVED", "The source is inactive");
  }

  // Attribution for third-party content — never claim ownership
  const thirdParty = ctx.content.rightsStatus !== "USER_OWNS";
  const needsAttribution =
    thirdParty && (ctx.settings.requireAttributionForThirdParty || (ctx.source?.attributionRequired ?? false));
  if (needsAttribution) {
    const attr = ctx.post.attributionText?.trim();
    if (!attr || !ctx.post.caption.includes(attr))
      add("RIGHTS_NOT_CONFIRMED", "Third-party content must include attribution in the caption");
  }

  // Rate limits (rolling windows)
  const dayLimit = Math.min(ctx.limits.maxPostsPerDay, ctx.account.dailyLimit ?? Number.POSITIVE_INFINITY);
  const inDay = ctx.recentPublishes.filter((d) => now - d.getTime() < DAY).sort((a, b) => a.getTime() - b.getTime());
  const inHour = inDay.filter((d) => now - d.getTime() < HOUR);
  if (inDay.length >= dayLimit) {
    add("POLICY_LIMIT_EXCEEDED", `Daily limit reached (${inDay.length}/${dayLimit} in the last 24h)`);
    const idx = inDay.length - dayLimit;
    later(inDay[idx]!.getTime() + DAY);
  }
  if (inHour.length >= ctx.limits.maxPostsPerHour) {
    add("POLICY_LIMIT_EXCEEDED", `Hourly limit reached (${inHour.length}/${ctx.limits.maxPostsPerHour})`);
    later(inHour[inHour.length - ctx.limits.maxPostsPerHour]!.getTime() + HOUR);
  }
  const last = inDay.at(-1);
  if (last && now - last.getTime() < ctx.limits.minPostIntervalMinutes * 60_000) {
    add("POLICY_LIMIT_EXCEEDED", `Minimum interval of ${ctx.limits.minPostIntervalMinutes} minutes not yet elapsed`);
    later(last.getTime() + ctx.limits.minPostIntervalMinutes * 60_000);
  }
  if (ctx.source && ctx.recentSourcePublishes >= ctx.limits.maxPostsPerSourcePerDay)
    add("POLICY_LIMIT_EXCEEDED", `Per-source daily limit reached (${ctx.limits.maxPostsPerSourcePerDay})`);

  const onlyTimeBased = v.length > 0 && v.every((x) => x.code === "POLICY_LIMIT_EXCEEDED" || x.code === "ACCOUNT_PAUSED");
  return {
    allowed: v.length === 0,
    violations: v,
    retryAt: onlyTimeBased && retryAt !== null ? new Date(retryAt) : null,
  };
}
