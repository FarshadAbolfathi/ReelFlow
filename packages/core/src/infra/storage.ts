/**
 * Storage abstraction. Keys are relative, forward-slash paths such as
 * "originals/2026/09/<uuid>.mp4". The local implementation maps keys under
 * STORAGE_PATH; an S3-compatible implementation can be added behind the same interface.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat, statfs } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { safeJoin } from "@reelflow/security";

export type StorageArea = "originals" | "processed" | "thumbnails" | "previews" | "failed" | "incoming" | "inbox" | "watermarks";

export interface StorageService {
  readonly root: string;
  /** Absolute local path for a key (local driver only). Throws on traversal. */
  resolve(key: string): string;
  keyFor(area: StorageArea, fileName: string, date?: Date): string;
  write(key: string, data: Readable): Promise<{ bytes: number }>;
  read(key: string): Readable;
  exists(key: string): Promise<boolean>;
  size(key: string): Promise<number | null>;
  move(fromKey: string, toKey: string): Promise<void>;
  remove(key: string): Promise<void>;
  freeBytes(): Promise<number | null>;
}

export class LocalStorage implements StorageService {
  constructor(readonly root: string) {}

  resolve(key: string): string {
    if (!/^[a-z-]+\/[A-Za-z0-9._/-]+$/.test(key)) throw new Error(`Invalid storage key: ${key}`);
    return safeJoin(this.root, ...key.split("/"));
  }

  keyFor(area: StorageArea, fileName: string, date = new Date()): string {
    const y = String(date.getUTCFullYear());
    const m = String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${area}/${y}/${m}/${fileName}`;
  }

  async write(key: string, data: Readable): Promise<{ bytes: number }> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.part`;
    let bytes = 0;
    data.on("data", (c: Buffer) => (bytes += c.length));
    try {
      await pipeline(data, createWriteStream(tmp, { mode: 0o600 }));
      await rename(tmp, full);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    return { bytes };
  }

  read(key: string): Readable {
    return createReadStream(this.resolve(key));
  }

  async exists(key: string): Promise<boolean> {
    return (await this.size(key)) !== null;
  }

  async size(key: string): Promise<number | null> {
    try {
      return (await stat(this.resolve(key))).size;
    } catch {
      return null;
    }
  }

  async move(fromKey: string, toKey: string): Promise<void> {
    const to = this.resolve(toKey);
    await mkdir(path.dirname(to), { recursive: true });
    await rename(this.resolve(fromKey), to);
  }

  async remove(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }

  async freeBytes(): Promise<number | null> {
    try {
      const s = await statfs(this.root);
      return s.bavail * s.bsize;
    } catch {
      return null;
    }
  }
}
