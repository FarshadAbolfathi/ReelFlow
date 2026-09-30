#!/usr/bin/env node
// Runs the TypeScript CLI through tsx so no build step is needed locally.
import { spawnSync } from "node:child_process";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "../../..");
const r = spawnSync("npx", ["tsx", path.join(root, "apps/cli/src/index.ts"), ...process.argv.slice(2)], { stdio: "inherit", cwd: process.cwd() });
process.exit(r.status ?? 1);
