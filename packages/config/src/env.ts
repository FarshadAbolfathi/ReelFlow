import { existsSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import { resolveCeilings, type PolicyCeilings } from "./policy";

/** Walks up from cwd to find the monorepo root (the directory with .env.example). */
export function findRepoRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, ".env.example")) && existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");
const optNum = z.coerce.number().optional();
const base64Key = (bytes: number) =>
  z
    .string()
    .min(1, "is required — run `npm run setup`")
    .refine((v) => Buffer.from(v, "base64").length >= bytes, `must be at least ${bytes} bytes, base64-encoded`);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3100"),
  API_PORT: z.coerce.number().int().default(4000),
  API_HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default("redis://127.0.0.1:6380"),
  STORAGE_PATH: z.string().default("./storage"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  DEFAULT_TIMEZONE: z.string().default("Asia/Tehran"),
  DEFAULT_LOCALE: z.enum(["fa", "en"]).default("fa"),
  SESSION_SECRET: base64Key(32),
  ENCRYPTION_KEY: base64Key(32),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(500 * 1024 * 1024),

  POLICY_MAX_POSTS_PER_DAY: optNum,
  POLICY_MAX_POSTS_PER_HOUR: optNum,
  POLICY_MIN_POST_INTERVAL_MINUTES: optNum,
  POLICY_MAX_CONCURRENT_PUBLISH: optNum,
  POLICY_MAX_POSTS_PER_SOURCE_PER_DAY: optNum,
  POLICY_SOURCES_REQUIRE_OWNER_APPROVAL: bool.default(true),

  NETWORK_MODE: z.enum(["direct", "proxy"]).default("direct"),
  PROXY_SCHEME: z.enum(["http", "socks5"]).default("http"),
  PROXY_HOST: z.string().default("127.0.0.1"),
  PROXY_PORT: z.coerce.number().int().min(1).max(65535).default(10808),
  PROXY_HEALTH_URL: z.string().url().default("https://www.gstatic.com/generate_204"),
  PROXY_HEALTH_TIMEOUT_SECONDS: z.coerce.number().positive().default(20),

  INSTAGRAM_GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v23.0"),
  /** mock: nothing is posted · live: official Graph API token · session: in-app Instagram login */
  PUBLISHING_ADAPTER_MODE: z.enum(["mock", "live", "session"]).default("mock"),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface AppConfig {
  env: RawEnv["NODE_ENV"];
  repoRoot: string;
  appUrl: string;
  api: { host: string; port: number };
  databaseUrl: string;
  redisUrl: string;
  storagePath: string;
  logLevel: RawEnv["LOG_LEVEL"];
  defaultTimezone: string;
  defaultLocale: "fa" | "en";
  sessionSecret: Buffer;
  encryptionKey: Buffer;
  uploadMaxBytes: number;
  policy: PolicyCeilings;
  network: {
    mode: "direct" | "proxy";
    proxyUrl: string;
    healthUrl: string;
    healthTimeoutMs: number;
  };
  instagram: { graphApiVersion: string };
  publishingAdapterMode: "mock" | "live" | "session";
}

/** Parses and validates configuration. Throws a readable error listing every problem. */
export function parseConfig(source: NodeJS.ProcessEnv, repoRoot: string): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new Error(`Invalid ReelFlow configuration:\n${lines.join("\n")}`);
  }
  const e = parsed.data;
  const encryptionKey = Buffer.from(e.ENCRYPTION_KEY, "base64");
  if (encryptionKey.length !== 32) throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");

  return {
    env: e.NODE_ENV,
    repoRoot,
    appUrl: e.APP_URL,
    api: { host: e.API_HOST, port: e.API_PORT },
    databaseUrl: e.DATABASE_URL,
    redisUrl: e.REDIS_URL,
    storagePath: path.resolve(repoRoot, e.STORAGE_PATH),
    logLevel: e.LOG_LEVEL,
    defaultTimezone: e.DEFAULT_TIMEZONE,
    defaultLocale: e.DEFAULT_LOCALE,
    sessionSecret: Buffer.from(e.SESSION_SECRET, "base64"),
    encryptionKey,
    uploadMaxBytes: e.UPLOAD_MAX_BYTES,
    policy: resolveCeilings({
      maxPostsPerDay: e.POLICY_MAX_POSTS_PER_DAY,
      maxPostsPerHour: e.POLICY_MAX_POSTS_PER_HOUR,
      minPostIntervalMinutes: e.POLICY_MIN_POST_INTERVAL_MINUTES,
      maxConcurrentPublish: e.POLICY_MAX_CONCURRENT_PUBLISH,
      maxPostsPerSourcePerDay: e.POLICY_MAX_POSTS_PER_SOURCE_PER_DAY,
      sourcesRequireOwnerApproval: e.POLICY_SOURCES_REQUIRE_OWNER_APPROVAL,
    }),
    network: {
      mode: e.NETWORK_MODE,
      proxyUrl: `${e.PROXY_SCHEME}://${e.PROXY_HOST}:${e.PROXY_PORT}`,
      healthUrl: e.PROXY_HEALTH_URL,
      healthTimeoutMs: e.PROXY_HEALTH_TIMEOUT_SECONDS * 1000,
    },
    instagram: { graphApiVersion: e.INSTAGRAM_GRAPH_API_VERSION },
    publishingAdapterMode: e.PUBLISHING_ADAPTER_MODE,
  };
}

let cached: AppConfig | undefined;

/** Loads .env from the repo root (real env vars win) and returns validated config. */
export function loadConfig(): AppConfig {
  if (cached) return cached;
  const repoRoot = findRepoRoot();
  loadDotenv({ path: path.join(repoRoot, ".env"), quiet: true });
  cached = parseConfig(process.env, repoRoot);
  return cached;
}

/** For tests only. */
export function resetConfigCache(): void {
  cached = undefined;
}
