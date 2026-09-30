#!/usr/bin/env node
// Production start: expects `npm run build` first.
process.argv.push("--prod");
await import("./dev.mjs");
