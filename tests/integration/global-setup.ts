/**
 * Creates an isolated `reelflow_test` database and applies migrations to it.
 * The development database is never touched by tests.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import pg from "pg";
import { TEST_DATABASE_URL } from "./env";

export default async function setup() {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL.replace(/\/reelflow_test$/, "/postgres") });
  await admin.connect();
  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = 'reelflow_test'");
  if (exists.rowCount === 0) await admin.query("CREATE DATABASE reelflow_test");
  await admin.end();
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: path.resolve(import.meta.dirname, "../../packages/database"),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: "pipe",
  });
}
