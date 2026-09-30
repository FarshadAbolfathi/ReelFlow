#!/usr/bin/env node
// Runs API, worker, web and the Python ingestion engine together with prefixed logs.
// Usage: npm run dev            (all)
//        npm run dev -- api web (subset)
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const isProd = process.argv.includes("--prod");
const wanted = process.argv.slice(2).filter((a) => !a.startsWith("--"));

const services = {
  api: { cmd: "npm", args: ["run", isProd ? "start" : "dev", "-w", "@reelflow/api"], color: 35 },
  worker: { cmd: "npm", args: ["run", isProd ? "start" : "dev", "-w", "@reelflow/worker"], color: 33 },
  web: { cmd: "npm", args: ["run", isProd ? "start" : "dev", "-w", "@reelflow/web"], color: 36 },
  ingestion: { cmd: path.join(root, "scripts", "ingestion.sh"), args: [], color: 32 },
};

if (!existsSync(path.join(root, ".env"))) {
  console.error("Missing .env — run `npm run setup` first.");
  process.exit(1);
}

const children = [];
for (const [name, svc] of Object.entries(services)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const child = spawn(svc.cmd, svc.args, { cwd: root, env: { ...process.env, FORCE_COLOR: "1" }, stdio: ["ignore", "pipe", "pipe"] });
  const tag = `\x1b[${svc.color}m${name.padEnd(9)}\x1b[0m│ `;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) out.write(tag + l + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    process.stdout.write(`${tag}exited with code ${code}\n`);
  });
  children.push(child);
}

const stop = () => {
  for (const c of children) c.kill("SIGTERM");
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
