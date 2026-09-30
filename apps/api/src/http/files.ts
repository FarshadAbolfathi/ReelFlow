import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "@reelflow/types";

/** Streams a local file with HTTP Range support (needed for video seeking). */
export async function sendFile(req: FastifyRequest, reply: FastifyReply, filePath: string, mime: string) {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    throw new AppError("NOT_FOUND", "File not found");
  }
  reply.header("accept-ranges", "bytes").header("content-type", mime).header("cache-control", "private, max-age=300").header("x-content-type-options", "nosniff");
  const range = req.headers.range;
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    if (!m[1]) end = size - 1;
    start = Math.max(0, start);
    end = Math.min(end, size - 1);
    if (start > end) return reply.code(416).header("content-range", `bytes */${size}`).send();
    reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", end - start + 1);
    return reply.send(createReadStream(filePath, { start, end }));
  }
  reply.header("content-length", size);
  return reply.send(createReadStream(filePath));
}
