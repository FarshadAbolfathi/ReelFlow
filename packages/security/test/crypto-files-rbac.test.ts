import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertCan,
  can,
  decryptSecret,
  detectFileMediaType,
  detectMediaType,
  encryptSecret,
  hashPassword,
  safeJoin,
  sanitizeFilename,
  secretHint,
  verifyPassword,
} from "../src/index";

describe("password hashing", () => {
  it("hashes with argon2id and verifies", async () => {
    const h = await hashPassword("correct horse battery staple");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "correct horse battery staple")).toBe(true);
    expect(await verifyPassword(h, "wrong password!!")).toBe(false);
  });
  it("rejects short passwords", async () => {
    await expect(hashPassword("short")).rejects.toThrow();
  });
  it("returns false for malformed hashes instead of throwing", async () => {
    expect(await verifyPassword("not-a-hash", "whatever")).toBe(false);
  });
});

describe("secret encryption", () => {
  const key = randomBytes(32);
  it("round-trips and never contains the plaintext", () => {
    const token = "EAAG-very-secret-token-123456";
    const enc = encryptSecret(token, key);
    expect(enc).not.toContain(token);
    expect(decryptSecret(enc, key)).toBe(token);
  });
  it("uses a fresh IV each time", () => {
    expect(encryptSecret("x", key)).not.toBe(encryptSecret("x", key));
  });
  it("detects tampering", () => {
    const enc = encryptSecret("hello", key);
    const parts = enc.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."), key)).toThrow();
  });
  it("fails with the wrong key", () => {
    expect(() => decryptSecret(encryptSecret("hello", key), randomBytes(32))).toThrow();
  });
  it("hints only the last 4 chars", () => {
    expect(secretHint("abcdefghijkl")).toBe("…ijkl");
    expect(secretHint("short")).toBe("****");
  });
});

describe("filenames and paths", () => {
  it("sanitizes hostile filenames", () => {
    expect(sanitizeFilename("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("my video (final).MP4")).toBe("my-video-final.mp4");
    expect(sanitizeFilename(".hidden")).toBe("hidden");
    expect(sanitizeFilename("a;rm -rf $(x).mov")).toBe("a-rm-rf-x.mov");
    expect(sanitizeFilename("ویدیو.mp4")).toBe("file.mp4");
  });
  it("blocks path traversal", () => {
    const root = "/srv/storage";
    expect(safeJoin(root, "originals", "a.mp4")).toBe("/srv/storage/originals/a.mp4");
    expect(() => safeJoin(root, "../etc/passwd")).toThrow();
    expect(() => safeJoin(root, "originals/../../x")).toThrow();
    expect(() => safeJoin(root, "/etc/passwd")).toThrow();
    expect(() => safeJoin(root, "a\0b")).toThrow();
  });
});

describe("media type sniffing", () => {
  it("detects mp4 by ftyp box, ignoring extension", () => {
    const head = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.alloc(8)]);
    expect(detectMediaType(head)?.mime).toBe("video/mp4");
  });
  it("detects jpeg and png", () => {
    expect(detectMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))?.mime).toBe("image/jpeg");
    expect(
      detectMediaType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]))?.mime,
    ).toBe("image/png");
  });
  it("rejects scripts disguised as video", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rf-"));
    const f = path.join(dir, "evil.mp4");
    writeFileSync(f, "#!/bin/sh\necho pwned\n");
    expect(await detectFileMediaType(f)).toBeNull();
  });
});

describe("RBAC", () => {
  it("only OWNER can review sources and control the network", () => {
    expect(can("OWNER", "sources:review")).toBe(true);
    expect(can("MANAGER", "sources:review")).toBe(false);
    expect(can("MANAGER", "network:control")).toBe(false);
    expect(can("MANAGER", "sources:propose")).toBe(true);
  });
  it("VIEWER is read-only", () => {
    expect(can("VIEWER", "content:read")).toBe(true);
    expect(can("VIEWER", "content:write")).toBe(false);
    expect(() => assertCan("VIEWER", "queue:control")).toThrow(/cannot/);
  });
  it("requires authentication", () => {
    expect(() => assertCan(undefined, "content:read")).toThrow(/Sign in/);
  });
});
