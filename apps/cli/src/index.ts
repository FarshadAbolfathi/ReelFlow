#!/usr/bin/env node
/**
 * reelflow — operator CLI. Runs locally with direct DB access, so it acts as
 * the OWNER; every action is audit-logged with actorType CLI.
 */
import { spawn } from "node:child_process";
import { copyFile } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { loadConfig } from "@reelflow/config";
import { createCore, type Core, type UserActor } from "@reelflow/core";
import { detectFileMediaType } from "@reelflow/security";
import { PLATFORMS, RIGHTS_STATUSES, sourceInputSchema, type Platform, type RightsStatus } from "@reelflow/types";

const CLI: UserActor = { type: "CLI", id: null, role: "OWNER" };

async function withCore<T>(fn: (core: Core) => Promise<T>): Promise<void> {
  const core = createCore(loadConfig());
  try {
    await fn(core);
  } catch (e) {
    const err = e as { code?: string; message: string };
    console.error(`✗ ${err.code ? `[${err.code}] ` : ""}${err.message}`);
    process.exitCode = 1;
  } finally {
    await core.close();
  }
}

const table = (rows: Record<string, unknown>[]) => (rows.length ? console.table(rows) : console.log("(none)"));

const program = new Command().name("reelflow").description("ReelFlow operator CLI").version("0.1.0");

// ── source ───────────────────────────────────────────────────────────────
const source = program.command("source").description("Manage content sources");

source
  .command("add")
  .description("Add a source (created by the CLI = owner-approved)")
  .requiredOption("-n, --name <name>", "source name")
  .requiredOption("-p, --platform <platform>", `one of ${PLATFORMS.join(", ")}`)
  .requiredOption("-r, --rights <status>", `one of ${RIGHTS_STATUSES.join(", ")}`)
  .option("-u, --url <url>", "source URL (not needed for LOCAL inbox sources)")
  .option("-a, --attribution <text>", "attribution line added to captions")
  .option("--max-items <n>", "max items per check", "5")
  .option("--every <minutes>", "check interval in minutes", "360")
  .action((o) =>
    withCore(async (core) => {
      const input = sourceInputSchema.parse({
        name: o.name,
        url: o.url ?? null,
        platform: o.platform as Platform,
        rightsStatus: o.rights as RightsStatus,
        attributionText: o.attribution ?? null,
        maxItemsPerInterval: Number(o.maxItems),
        importFrequencyMinutes: Number(o.every),
      });
      const s = await core.sources.create(input, CLI);
      console.log(`✓ Source ${s.id} "${s.name}" — ${s.vettingStatus}`);
      if (s.platform === "LOCAL") console.log(`  Drop files into: ${path.join(core.config.storagePath, "inbox", s.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"))}`);
    }),
  );

source
  .command("list")
  .description("List sources")
  .action(() =>
    withCore(async (core) => {
      const list = await core.sources.list();
      table(list.map((s) => ({ id: s.id.slice(0, 8), name: s.name, platform: s.platform, vetting: s.vettingStatus, rights: s.rightsStatus, active: s.active, items: s.contentCount })));
    }),
  );

source
  .command("approve <id>")
  .description("Approve a source proposed by a manager")
  .action((id) =>
    withCore(async (core) => {
      const s = await core.sources.review(await resolveId(core, "source", id), "APPROVED", "approved via CLI", CLI);
      console.log(`✓ ${s.name} approved`);
    }),
  );

source
  .command("discover <id>")
  .description("Queue discovery for a source now")
  .action((id) =>
    withCore(async (core) => {
      const r = await core.sources.requestDiscovery(await resolveId(core, "source", id), CLI, "cli");
      console.log(`✓ discovery queued (${r.jobId})`);
    }),
  );

// ── content ──────────────────────────────────────────────────────────────
const content = program.command("content").description("Import and process content");

content
  .command("import <fileOrUrl>")
  .description("Import a local file or a permitted direct media URL")
  .requiredOption("-r, --rights <status>", "rights status (e.g. USER_OWNS, PERMISSION_GRANTED)")
  .option("-s, --source <id>", "approved source id")
  .option("-a, --attribution <text>")
  .option("-c, --caption <text>")
  .action((target: string, o) =>
    withCore(async (core) => {
      const sourceId = o.source ? await resolveId(core, "source", o.source) : null;
      if (/^https?:\/\//i.test(target)) {
        const r = await core.content.importUrl({ url: target, sourceId, rightsStatus: o.rights, attribution: o.attribution, caption: o.caption }, CLI);
        console.log(`✓ URL import queued (${r.id})`);
        return;
      }
      const file = path.resolve(target);
      const detected = await detectFileMediaType(file);
      if (!detected) throw Object.assign(new Error("Not a supported video/image file"), { code: "MEDIA_INVALID" });
      const key = core.storage.keyFor("incoming", `${crypto.randomUUID()}${detected.ext}`);
      await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(core.storage.resolve(key)), { recursive: true }));
      await copyFile(file, core.storage.resolve(key));
      const r = await core.content.registerUpload({ incomingKey: key, originalName: path.basename(file), rightsStatus: o.rights, attribution: o.attribution ?? null, caption: o.caption ?? null, sourceId }, CLI);
      console.log(`✓ ${detected.mime} queued for ingestion (${r.id}) — the ingestion engine must be running`);
    }),
  );

content
  .command("process <contentId>")
  .description("(Re)process content for a preset")
  .option("-p, --preset <key>", "INSTAGRAM_REEL | INSTAGRAM_FEED | INSTAGRAM_STORY")
  .option("-w, --watermark <presetId>", "watermark preset id, or 'none'")
  .option("-f, --force", "rebuild even if an identical output exists")
  .action((id, o) =>
    withCore(async (core) => {
      const r = await core.content.requestProcessing(await resolveId(core, "content", id), { presetKey: o.preset, watermarkPresetId: o.watermark === "none" ? null : o.watermark, force: !!o.force }, CLI);
      console.log(`✓ processing queued: ${r.preset} (${r.jobId})`);
    }),
  );

content
  .command("approve <contentId>")
  .action((id) =>
    withCore(async (core) => {
      await core.content.decide(await resolveId(core, "content", id), "APPROVED", "approved via CLI", CLI);
      console.log("✓ approved");
    }),
  );

// ── queue & schedule ─────────────────────────────────────────────────────
program
  .command("queue")
  .command("status")
  .description("Queue depths and upcoming posts")
  .action(() =>
    withCore(async (core) => {
      const counts = await core.queues.counts();
      table(Object.entries(counts).map(([queue, c]) => ({ queue, ...c })));
      const posts = await core.scheduling.queue({ from: new Date(), take: 15 });
      table(posts.map((p) => ({ post: p.id.slice(0, 8), at: p.scheduledAt.toISOString(), status: p.status, account: p.account.name, source: p.content.source?.name ?? "upload", retries: p.retryCount })));
      const accounts = await core.accounts.list();
      table(accounts.map((a) => ({ account: a.name, status: a.status, safety: a.safetyState, pausedUntil: a.pausedUntil?.toISOString() ?? "", last24h: a.dailyPublishCount })));
    }),
  );

const schedule = program.command("schedule").description("Schedule content");
schedule
  .command("post <contentId> <accountId>")
  .description("Schedule one item (next free slot unless --at is given)")
  .option("--at <iso>", "ISO datetime, e.g. 2026-10-03T18:30:00+03:30")
  .option("-k, --kind <kind>", "REEL | STORY | FEED", "REEL")
  .action((contentId, accountId, o) =>
    withCore(async (core) => {
      const p = await core.scheduling.schedulePost(
        { contentId: await resolveId(core, "content", contentId), accountId: await resolveId(core, "account", accountId), kind: o.kind, scheduledAt: o.at ? new Date(o.at).toISOString() : undefined },
        CLI,
      );
      console.log(`✓ scheduled ${p.id.slice(0, 8)} at ${p.scheduledAt.toISOString()} (${p.status})`);
    }),
  );
schedule
  .command("fill <scheduleId>")
  .description("Fill upcoming slots of a schedule with approved content")
  .option("-d, --days <n>", "horizon in days", "3")
  .action((id, o) =>
    withCore(async (core) => {
      const r = await core.scheduling.autoFill(await resolveId(core, "schedule", id), { horizonDays: Number(o.days), actor: CLI });
      console.log(`✓ ${r.created} post(s) scheduled`);
    }),
  );

// ── worker & health ──────────────────────────────────────────────────────
program
  .command("worker")
  .command("start")
  .description("Start the Node worker (processing, approval, publishing, scheduler tick)")
  .option("--with-ingestion", "also start the Python ingestion engine")
  .action((o) => {
    const root = loadConfig().repoRoot;
    const procs = [spawn("npx", ["tsx", "apps/worker/src/main.ts"], { cwd: root, stdio: "inherit" })];
    if (o.withIngestion) procs.push(spawn(path.join(root, "scripts/ingestion.sh"), [], { cwd: root, stdio: "inherit" }));
    const stop = () => procs.forEach((p) => p.kill("SIGTERM"));
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });

program
  .command("health")
  .description("Check database, Redis, storage, FFmpeg, queues and network")
  .action(() =>
    withCore(async (core) => {
      const checks: [string, () => Promise<string>][] = [
        ["database", async () => (await core.db.$queryRaw`SELECT 1`, "ok")],
        ["redis", async () => core.redis.ping()],
        ["storage", async () => `${(((await core.storage.freeBytes()) ?? 0) / 1024 ** 3).toFixed(1)} GB free at ${core.storage.root}`],
        ["ffmpeg", () => new Promise((res, rej) => { const p = spawn("ffmpeg", ["-version"]); p.on("exit", (c) => (c === 0 ? res("ok") : rej(new Error(`exit ${c}`)))); p.on("error", rej); })],
        ["network", async () => {
          const s = await core.network.status();
          return s ? `${s.mode} · proxy ${s.health} · engine heartbeat ${s.engineHeartbeatAt ?? "none"}` : "ingestion engine has not reported status (is it running?)";
        }],
        ["policy", async () => { const p = core.config.policy; return `≤${p.maxPostsPerDay}/day, ≤${p.maxPostsPerHour}/h, ≥${p.minPostIntervalMinutes}min apart, owner approval ${p.sourcesRequireOwnerApproval ? "required" : "off"}`; }],
      ];
      let ok = true;
      for (const [name, fn] of checks) {
        try {
          console.log(`✓ ${name.padEnd(9)} ${await fn()}`);
        } catch (e) {
          ok = false;
          console.log(`✗ ${name.padEnd(9)} ${(e as Error).message}`);
        }
      }
      if (!ok) process.exitCode = 1;
    }),
  );

/** Accepts a full UUID or a unique 8+ char prefix (as printed by `list`). */
async function resolveId(core: Core, kind: "source" | "content" | "account" | "schedule", id: string): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(id)) return id;
  if (!/^[0-9a-f]{4,}$/i.test(id)) throw Object.assign(new Error(`Invalid ${kind} id`), { code: "VALIDATION_FAILED" });
  const table = { source: "sources", content: "contents", account: "publishing_accounts", schedule: "schedules" }[kind];
  const rows = await core.db.$queryRawUnsafe<{ id: string }[]>(`SELECT id::text FROM ${table} WHERE id::text LIKE $1 LIMIT 2`, `${id.toLowerCase()}%`);
  if (rows.length !== 1) throw Object.assign(new Error(`${rows.length ? "Ambiguous" : "Unknown"} ${kind} id ${id}`), { code: "NOT_FOUND" });
  return rows[0]!.id;
}

program.parseAsync().catch((e) => {
  console.error(e);
  process.exit(1);
});
