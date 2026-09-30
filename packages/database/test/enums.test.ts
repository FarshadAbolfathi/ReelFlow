/** Fails if the TS enums in @reelflow/types drift from the Prisma schema. */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as T from "@reelflow/types";

const schema = readFileSync(path.resolve(import.meta.dirname, "../prisma/schema.prisma"), "utf8");
const prismaEnum = (name: string) => {
  const m = new RegExp(`enum ${name} \\{([^}]+)\\}`).exec(schema);
  if (!m) throw new Error(`enum ${name} not found`);
  return m[1]!.split("\n").map((l) => l.trim()).filter(Boolean);
};

const PAIRS: [string, readonly string[]][] = [
  ["UserRole", T.USER_ROLES],
  ["Platform", T.PLATFORMS],
  ["RightsStatus", T.RIGHTS_STATUSES],
  ["SourceVettingStatus", T.SOURCE_VETTING_STATUSES],
  ["MediaType", T.MEDIA_TYPES],
  ["ContentKind", T.CONTENT_KINDS],
  ["ProcessingStatus", T.PROCESSING_STATUSES],
  ["ApprovalStatus", T.APPROVAL_STATUSES],
  ["PublishStatus", T.PUBLISH_STATUSES],
  ["PostStatus", T.POST_STATUSES],
  ["AccountStatus", T.ACCOUNT_STATUSES],
  ["SafetyState", T.SAFETY_STATES],
  ["JobStatus", T.JOB_STATUSES],
  ["IngestOutcome", T.INGEST_OUTCOMES],
  ["NetworkMode", T.NETWORK_MODES],
  ["NotificationLevel", T.NOTIFICATION_LEVELS],
];

describe("enum parity (TS ↔ Prisma)", () => {
  for (const [name, values] of PAIRS) {
    it(name, () => expect([...values].sort()).toEqual(prismaEnum(name).sort()));
  }
});
