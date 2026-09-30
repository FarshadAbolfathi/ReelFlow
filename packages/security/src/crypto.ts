import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

// ── Passwords (argon2id) ───────────────────────────────────────────────
const ARGON2_OPTS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12) throw new Error("Password must be at least 12 characters");
  return hash(password, ARGON2_OPTS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

// ── Secrets at rest (AES-256-GCM) ─────────────────────────────────────
// Format: v1.<iv b64url>.<tag b64url>.<ciphertext b64url>
const VERSION = "v1";

export function encryptSecret(plaintext: string, key: Buffer, aad = "reelflow"): string {
  if (key.length !== 32) throw new Error("Encryption key must be 32 bytes");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(payload: string, key: Buffer, aad = "reelflow"): string {
  const [version, ivB64, tagB64, ctB64] = payload.split(".");
  if (version !== VERSION || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error("Unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]).toString("utf8");
}

/** Last 4 chars only — safe for showing "token …a1b2" in the UI. */
export function secretHint(secret: string): string {
  return secret.length <= 8 ? "****" : `…${secret.slice(-4)}`;
}

// ── Tokens ─────────────────────────────────────────────────────────────
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export const sha256Hex = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");

export const hmacHex = (key: Buffer, input: string) => createHmac("sha256", key).update(input).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
