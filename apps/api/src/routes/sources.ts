import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Core } from "@reelflow/core";
import { sourceInputSchema, sourceReviewSchema } from "@reelflow/types";
import { requireUser } from "../http/auth";
import { parse, uuidParam } from "../http/validate";

export const sourceRoutes =
  (core: Core): FastifyPluginAsync =>
  async (app) => {
    app.get("/sources", async (req) => {
      requireUser(req, "sources:read");
      const q = parse(z.object({ vettingStatus: z.string().optional(), platform: z.string().optional(), q: z.string().max(200).optional() }), req.query);
      return core.sources.list(q);
    });

    app.get("/sources/:id", async (req) => {
      requireUser(req, "sources:read");
      return core.sources.get(uuidParam(req.params));
    });

    app.post("/sources", async (req, reply) => {
      const source = await core.sources.create(parse(sourceInputSchema, req.body), requireUser(req, "sources:propose"));
      return reply.code(201).send(source);
    });

    app.put("/sources/:id", async (req) => core.sources.update(uuidParam(req.params), parse(sourceInputSchema, req.body), requireUser(req, "sources:edit")));

    /** OWNER-only approval of a source. */
    app.post("/sources/:id/review", async (req) => {
      const body = parse(sourceReviewSchema, req.body);
      return core.sources.review(uuidParam(req.params), body.decision, body.note, requireUser(req, "sources:review"));
    });

    app.post("/sources/:id/discover", async (req) => core.sources.requestDiscovery(uuidParam(req.params), requireUser(req, "content:write"), "user"));

    app.delete("/sources/:id", async (req, reply) => {
      await core.sources.remove(uuidParam(req.params), requireUser(req, "sources:delete"));
      return reply.code(204).send();
    });
  };
