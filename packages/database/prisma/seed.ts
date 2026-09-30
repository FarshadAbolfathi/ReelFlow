/**
 * Idempotent seed: first OWNER account, watermark presets, a caption template.
 * Safe to run repeatedly.
 */
import { loadConfig } from "@reelflow/config";
import { hashPassword } from "@reelflow/security";
import { disconnectDb, getDb } from "../src/index";

const WATERMARK_PRESETS = [
  {
    name: "Default Brand",
    isDefault: true,
    config: { kind: "TEXT", text: "@MyPage", opacity: 0.65, scale: 0.18, position: "BOTTOM_RIGHT", marginPx: 32, fontSizeRatio: 0.035 },
  },
  {
    name: "Small Corner",
    isDefault: false,
    config: { kind: "TEXT", text: "@MyPage", opacity: 0.5, scale: 0.1, position: "TOP_RIGHT", marginPx: 24, fontSizeRatio: 0.025 },
  },
  {
    name: "Large Center",
    isDefault: false,
    config: { kind: "TEXT", text: "@MyPage", opacity: 0.25, scale: 0.4, position: "CENTER", marginPx: 0, fontSizeRatio: 0.08 },
  },
  {
    name: "Story",
    isDefault: false,
    config: { kind: "TEXT", text: "@MyPage", opacity: 0.7, scale: 0.16, position: "TOP_CENTER", marginPx: 180, fontSizeRatio: 0.035 },
  },
];

async function main() {
  const cfg = loadConfig();
  const db = getDb(cfg.databaseUrl);

  if ((await db.user.count()) === 0) {
    const email = process.env.BOOTSTRAP_OWNER_EMAIL ?? "owner@reelflow.local";
    const password = process.env.BOOTSTRAP_OWNER_PASSWORD;
    if (!password || password.length < 12) {
      throw new Error("Set BOOTSTRAP_OWNER_PASSWORD (≥ 12 chars) in .env before seeding");
    }
    await db.user.create({
      data: { email, name: "Owner", role: "OWNER", passwordHash: await hashPassword(password) },
    });
    console.warn(`Created OWNER account ${email}`);
  }

  for (const p of WATERMARK_PRESETS) {
    await db.watermarkPreset.upsert({ where: { name: p.name }, update: {}, create: p });
  }

  await db.captionTemplate.upsert({
    where: { name: "Credit + CTA" },
    update: {},
    create: {
      name: "Credit + CTA",
      isDefault: true,
      body: "{{original_caption}}\n\n{{attribution}}\n\n{{cta}}\n\n{{hashtags}}",
      defaultHashtags: [],
      cta: "Follow {{brand}} for more.",
    },
  });

  await db.auditLog.create({
    data: { action: "system_seeded", actorType: "SYSTEM", summary: "Database seeded (idempotent)" },
  });
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => disconnectDb());
