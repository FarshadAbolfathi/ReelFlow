import { loadConfig } from "@reelflow/config";
import { createCore } from "@reelflow/core";
import { buildServer } from "./server";

async function main() {
  const config = loadConfig();
  const core = createCore(config);
  const app = await buildServer(core);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await core.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Loopback by default: the API is reached through the Next.js same-origin proxy.
  await app.listen({ host: config.api.host, port: config.api.port });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
