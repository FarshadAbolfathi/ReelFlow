import { AppError, type ErrorCode } from "@reelflow/types";

/** Graph API error envelope. */
export interface GraphError {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
  fbtrace_id?: string;
}

// Throttling codes documented by Meta: app/user/page-level rate limits and publishing limit.
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80001, 80002, 80006]);
const RATE_LIMIT_SUBCODES = new Set([2207042]); // "maximum number of posts reached"
const AUTH_CODES = new Set([190, 102, 10, 200]);
const MEDIA_SUBCODES_PREFIX = 2207;

/**
 * Maps a Graph API error to a typed AppError. A rate-limit response is always
 * RATE_LIMITED so the safety monitor pauses the account; ReelFlow never retries
 * early or routes around it.
 */
export function mapGraphError(httpStatus: number, err: GraphError | undefined, retryAfterMs: number | null): AppError {
  const code = err?.code;
  const sub = err?.error_subcode;
  const message = err?.message ?? `HTTP ${httpStatus}`;
  const details = { httpStatus, graphCode: code, graphSubcode: sub, fbtraceId: err?.fbtrace_id };
  let appCode: ErrorCode;
  if (httpStatus === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code)) || (sub !== undefined && RATE_LIMIT_SUBCODES.has(sub))) {
    appCode = "RATE_LIMITED";
  } else if (code !== undefined && AUTH_CODES.has(code) && (code === 190 || httpStatus === 401 || httpStatus === 403)) {
    appCode = "AUTH_EXPIRED";
  } else if (sub !== undefined && Math.floor(sub / 1000) === MEDIA_SUBCODES_PREFIX) {
    appCode = "MEDIA_INVALID";
  } else if (httpStatus === 503 || httpStatus === 502 || httpStatus === 504 || err?.is_transient || code === 1 || code === 2) {
    appCode = "PUBLISH_FAILED"; // transient → retryable with backoff
  } else {
    appCode = "PUBLISH_FAILED";
  }
  return new AppError(appCode, `Instagram: ${message}`, {
    details,
    ...(retryAfterMs !== null ? { retryAfterMs } : {}),
  });
}
