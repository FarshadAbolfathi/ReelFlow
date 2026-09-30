/** Typed error codes. Every failed job and API error carries one of these. */
export const ERROR_CODES = [
  "SOURCE_UNAVAILABLE",
  "SOURCE_NOT_APPROVED",
  "MEDIA_INVALID",
  "RIGHTS_NOT_CONFIRMED",
  "DUPLICATE_CONTENT",
  "PROCESSING_FAILED",
  "PUBLISH_FAILED",
  "RATE_LIMITED",
  "AUTH_EXPIRED",
  "PLATFORM_UNSUPPORTED",
  "UNSUPPORTED_SOURCE_OPERATION",
  "NETWORK_UNAVAILABLE",
  "POLICY_LIMIT_EXCEEDED",
  "APPROVAL_REQUIRED",
  "ACCOUNT_PAUSED",
  "URL_BLOCKED",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "CSRF_INVALID",
  "STORAGE_ERROR",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** Errors that may succeed later; the job system retries these with backoff. */
export const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "SOURCE_UNAVAILABLE",
  "RATE_LIMITED",
  "NETWORK_UNAVAILABLE",
  "PUBLISH_FAILED",
  "STORAGE_ERROR",
]);

const HTTP_STATUS: Partial<Record<ErrorCode, number>> = {
  VALIDATION_FAILED: 400,
  URL_BLOCKED: 400,
  MEDIA_INVALID: 400,
  UNAUTHENTICATED: 401,
  AUTH_EXPIRED: 401,
  FORBIDDEN: 403,
  CSRF_INVALID: 403,
  SOURCE_NOT_APPROVED: 403,
  RIGHTS_NOT_CONFIRMED: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  DUPLICATE_CONTENT: 409,
  APPROVAL_REQUIRED: 409,
  POLICY_LIMIT_EXCEEDED: 422,
  UNSUPPORTED_SOURCE_OPERATION: 422,
  PLATFORM_UNSUPPORTED: 422,
  RATE_LIMITED: 429,
  ACCOUNT_PAUSED: 423,
  NETWORK_UNAVAILABLE: 503,
  SOURCE_UNAVAILABLE: 502,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;
  /** For RATE_LIMITED: when the caller may try again. */
  readonly retryAfterMs: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AppError";
    this.code = code;
    this.details = options.details;
    this.retryAfterMs = options.retryAfterMs;
  }

  get retryable(): boolean {
    return RETRYABLE_ERROR_CODES.has(this.code);
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code] ?? 500;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

/** Normalises any thrown value into an AppError without leaking internals. */
export function toAppError(e: unknown, fallback: ErrorCode = "INTERNAL_ERROR"): AppError {
  if (isAppError(e)) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new AppError(fallback, message, { cause: e });
}
