import pino, { type DestinationStream, type Logger, type LoggerOptions } from "pino";

export type { Logger } from "pino";

/**
 * Keys whose values are always replaced with "********" in logs.
 * Matches nested keys too (pino redact paths with wildcards).
 */
export const SECRET_KEYS = [
  "password",
  "passwordHash",
  "token",
  "accessToken",
  "access_token",
  "refreshToken",
  "encryptedToken",
  "authorization",
  "Authorization",
  "cookie",
  "Cookie",
  "set-cookie",
  "secret",
  "clientSecret",
  "client_secret",
  "sessionSecret",
  "encryptionKey",
  "proxyPassword",
  "proxy_password",
  "apiKey",
  "api_key",
  "csrfToken",
] as const;

const redactPaths = SECRET_KEYS.flatMap((k) => {
  const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : `["${k}"]`;
  const join = (prefix: string) => (key.startsWith("[") ? `${prefix}${key}` : `${prefix}.${key}`);
  return [key.startsWith("[") ? key.slice(2, -2) : key, join("*"), join("*.*"), join("req.headers"), join("headers")];
});

const SECRET_PATTERNS: [RegExp, string][] = [
  // access_token=..., password=... in URLs or strings
  [/((?:access_token|token|password|secret|client_secret|api_key|sig)=)[^&\s"']+/gi, "$1********"],
  // Bearer tokens
  [/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, "$1********"],
  // user:pass@ in URLs
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, "$1********@"],
];

/** Redacts secrets embedded in free-form strings (error messages, URLs). */
export function redactString(input: string): string {
  let out = input;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

export function createLogger(name: string, options: LoggerOptions = {}, destination?: DestinationStream): Logger {
  const level = options.level ?? process.env.LOG_LEVEL ?? "info";
  const opts: LoggerOptions = {
    name,
    level,
    redact: { paths: redactPaths, censor: "********" },
    formatters: {
      level: (label) => ({ level: label }),
    },
    hooks: {
      logMethod(args, method) {
        const redacted = args.map((a) => (typeof a === "string" ? redactString(a) : a)) as typeof args;
        method.apply(this, redacted);
      },
    },
    serializers: {
      err: (err: Error) => ({
        type: err.name,
        message: redactString(err.message),
        code: (err as { code?: string }).code,
        stack: process.env.NODE_ENV === "production" ? undefined : err.stack && redactString(err.stack),
      }),
    },
    ...options,
  };
  return destination ? pino(opts, destination) : pino(opts);
}
