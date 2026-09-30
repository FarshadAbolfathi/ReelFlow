import type { FastifyPluginAsync } from "fastify";
import type { Core } from "@reelflow/core";
import { authRoutes } from "./auth";
import { contentRoutes } from "./content";
import { publishingRoutes } from "./publishing";
import { settingsRoutes } from "./settings";
import { sourceRoutes } from "./sources";
import { systemRoutes } from "./system";

export const registerRoutes =
  (core: Core): FastifyPluginAsync =>
  async (app) => {
    await app.register(authRoutes(core));
    await app.register(systemRoutes(core));
    await app.register(sourceRoutes(core));
    await app.register(contentRoutes(core));
    await app.register(publishingRoutes(core));
    await app.register(settingsRoutes(core));
  };
