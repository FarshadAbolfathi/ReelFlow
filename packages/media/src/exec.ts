import { execFile } from "node:child_process";
import { AppError } from "@reelflow/types";

export interface ExecResult {
  stdout: string;
  stderr: string;
}

const BINARIES = { ffmpeg: process.env.FFMPEG_PATH ?? "ffmpeg", ffprobe: process.env.FFPROBE_PATH ?? "ffprobe" };

/**
 * Runs ffmpeg/ffprobe with an argument ARRAY — never through a shell — so no
 * user-controlled string can be interpreted as a command. Only the two known
 * binaries can be executed.
 */
export function runMediaTool(tool: "ffmpeg" | "ffprobe", args: string[], opts: { timeoutMs?: number } = {}): Promise<ExecResult> {
  for (const a of args) {
    if (typeof a !== "string" || a.includes("\0")) throw new AppError("VALIDATION_FAILED", "Invalid media tool argument");
  }
  return new Promise((resolve, reject) => {
    execFile(
      BINARIES[tool],
      args,
      { timeout: opts.timeoutMs ?? 15 * 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: false },
      (err, stdout, stderr) => {
        if (err) {
          const tail = String(stderr).split("\n").filter(Boolean).slice(-6).join("\n");
          reject(
            new AppError(tool === "ffprobe" ? "MEDIA_INVALID" : "PROCESSING_FAILED", `${tool} failed: ${tail || err.message}`, {
              cause: err,
            }),
          );
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
