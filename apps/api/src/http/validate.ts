import type { z } from "zod";
import { AppError } from "@reelflow/types";

/** Parses untrusted input with a zod schema, producing a VALIDATION_FAILED AppError on failure. */
export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError("VALIDATION_FAILED", "Invalid request", {
      details: { issues: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    });
  }
  return r.data;
}

export const uuidParam = (params: unknown, key = "id"): string => {
  const v = (params as Record<string, unknown>)[key];
  if (typeof v !== "string" || !/^[0-9a-f-]{36}$/i.test(v)) throw new AppError("VALIDATION_FAILED", `Invalid ${key}`);
  return v;
};
