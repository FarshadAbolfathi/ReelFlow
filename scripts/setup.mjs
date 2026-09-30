#!/usr/bin/env node
// Creates .env from .env.example with freshly generated secrets.
// Never overwrites an existing .env. Prints nothing secret.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const envPath = path.join(root, ".env");

for (const d of ["originals", "processed", "thumbnails", "previews", "failed", "inbox", "incoming", "watermarks", "browser-profile"]) {
  mkdirSync(path.join(root, "storage", d), { recursive: true });
}

if (existsSync(envPath)) {
  console.log(".env already exists — leaving it untouched.");
  process.exit(0);
}

const b64 = (n) => randomBytes(n).toString("base64");
const password = randomBytes(18).toString("base64url");
const generated = {
  SESSION_SECRET: b64(48),
  ENCRYPTION_KEY: b64(32),
  BOOTSTRAP_OWNER_PASSWORD: password,
};

let text = readFileSync(path.join(root, ".env.example"), "utf8");
for (const [k, v] of Object.entries(generated)) {
  text = text.replace(new RegExp(`^${k}=.*$`, "m"), `${k}=${v}`);
}
writeFileSync(envPath, text, { mode: 0o600 });
console.log("Created .env with random SESSION_SECRET, ENCRYPTION_KEY and BOOTSTRAP_OWNER_PASSWORD.");
console.log("The first owner password is in .env (BOOTSTRAP_OWNER_PASSWORD). Change it after first login.");
