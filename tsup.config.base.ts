import type { Options } from "tsup";

/** Bundles workspace packages (@reelflow/*) into one ESM file; native/runtime deps stay external. */
export const serviceBundle: Options = {
  entry: ["src/main.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  noExternal: [/^@reelflow\//],
  external: [/^@prisma\//, "sharp", "@node-rs/argon2", "pg", "bullmq", "ioredis", "fastify", /^@fastify\//, "pino", "undici", "luxon", "zod", "dotenv", "ipaddr.js"],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
};
