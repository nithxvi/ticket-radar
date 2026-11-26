import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { env } from "./env.ts";
import type { Store } from "./store.ts";
import type { PollPlanner } from "./poll-planner.ts";
import type { WatchConfig } from "./types.ts";
import type { Logger } from "./log.ts";
import { parseTicketLink } from "./links.ts";
import { monitorIdFor } from "./watch-rules.ts";
import { ensureDefaultProfile } from "./seed.ts";

export async function createServer(
  store: Store,
  planner: PollPlanner,
  config: WatchConfig,
  log: Logger,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true, credentials: true });

  const password = env("TICKET_RADAR_PASSWORD");
  const sessions = new Set<string>();

  // Auth hook for /api (except login/health)
  app.addHook("onRequest", async (req, reply) => {
    if (!password) return;
    if (!req.url.startsWith("/api")) return;
    if (req.url === "/api/login" || req.url === "/api/health") return;
    const cookie = req.headers.cookie ?? "";
    const match = cookie.match(/(?:^|; )tr_session=([^;]+)/);
    const token = match?.[1];
    if (!token || !sessions.has(token)) {
      reply.code(401);
      return reply.send({ error: "unauthorized" });
    }
  });

  app.post("/api/login", async (req, reply) => {
    if (!password) return { ok: true };
    const body = (req.body ?? {}) as { password?: string };
    if (body.password !== password) {
      reply.code(401);
      return { error: "invalid password" };
    }
    const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
    sessions.add(token);
    reply.header("Set-Cookie", `tr_session=${token}; HttpOnly; Path=/; SameSite=Lax`);
    return { ok: true };
  });

  app.post("/api/logout", async (req, reply) => {
    const cookie = req.headers.cookie ?? "";
    const match = cookie.match(/(?:^|; )tr_session=([^;]+)/);
    if (match?.[1]) sessions.delete(match[1]);
    reply.header("Set-Cookie", "tr_session=; HttpOnly; Path=/; Max-Age=0");
    return { ok: true };
  });

  app.get("/api/health", async () => ({ ok: true, time: new Date().toISOString() }));

  app.get("/api/profiles", async () => store.listProfiles());

  app.get("/api/watches", async () => {
    const watches = store.listWatches();
    const statuses = new Map(store.listWatchStatuses().map((s) => [s.watchId, s]));
    return watches.map((w) => ({ ...w, status: statuses.get(w.id) ?? null }));
  });

  app.get("/api/watches/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const watch = store.getWatch(id);
    if (!watch) {
      reply.code(404);
      return { error: "not found" };
    }
    return { ...watch, status: store.getWatchStatus(watch.id) };
  });

  app.post("/api/watches", async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, any>;
    const parsed = body.url ? parseTicketLink(String(body.url)) : null;

    const profileId = body.profileId ?? ensureDefaultProfile(store, config);

    const movie = {
      title: body?.movie?.title ?? parsed?.movieTitle ?? "Untitled",
      districtContentId: body?.movie?.districtContentId ?? parsed?.districtContentId,
      bmsEventCode: body?.movie?.bmsEventCode ?? parsed?.bmsEventCode,
    };

    const city = {
      districtKey: body?.city?.districtKey ?? parsed?.districtCityKey,
      bmsRegion: body?.city?.bmsRegion ?? parsed?.bmsRegion,
      bmsSlug: body?.city?.bmsSlug ?? parsed?.bmsSlug,
      label: body?.city?.label,
    };

    const date = body?.date ?? parsed?.date ?? new Date().toISOString().slice(0, 10);

    const providers =
      body?.providers ??
      (parsed?.provider && parsed.provider !== "unknown" ? [parsed.provider] : ["district", "bms"]);

    const venues = {
      include: body?.venues?.include ?? [],
      exclude: body?.venues?.exclude ?? [],
    };

    const timeWindow = {
      from: body?.timeWindow?.from,
      to: body?.timeWindow?.to,
    };

    const seats = {
      rows: body?.seats?.rows ?? [],
      numbers: body?.seats?.numbers ?? [],
      minSeats: body?.seats?.minSeats ?? 1,
    };

    const watch = store.createWatch({
      id: body?.id,
      name: body?.name ?? movie.title,
      owner: body?.owner ?? "me",
      enabled: body?.enabled !== false,
      profileId,
      movie,
      city,
      date,
      providers,
      venues,
      timeWindow,
      seats,
    });

    reply.code(201);
    return watch;
  });

  app.patch("/api/watches/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as Record<string, any>;
    const updated = store.updateWatch(id, {
      name: body?.name,
      owner: body?.owner,
      enabled: body?.enabled,
      profileId: body?.profileId,
      venues: body?.venues,
      timeWindow: body?.timeWindow,
      seats: body?.seats,
    });
    if (!updated) {
      reply.code(404);
      return { error: "not found" };
    }
    return updated;
  });

  app.delete("/api/watches/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const ok = store.deleteWatch(id, false);
    if (!ok) {
      reply.code(404);
      return { error: "not found" };
    }
    return { ok: true };
  });

  app.post("/api/watches/:id/test", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const watch = store.getWatch(id);
    if (!watch) {
      reply.code(404);
      return { error: "not found" };
    }
    const monitors = planner.listMonitors();
    const group = monitors.find((g) => g.watches.some((w) => w.id === watch.id));
    if (!group) {
      const provider = watch.providers[0] ?? "district";
      const run = await planner.runMonitor(monitorIdFor(watch, provider), provider, [watch], {
        deliver: false,
      });
      return run;
    }
    const run = await planner.runMonitor(group.id, group.provider, group.watches, { deliver: false });
    return run;
  });

  app.post("/api/resolve-link", async (req) => {
    const body = (req.body ?? {}) as Record<string, any>;
    return parseTicketLink(String(body?.url ?? ""));
  });

  app.get("/api/monitors/:id/sessions", async (req) => {
    const id = (req.params as { id: string }).id;
    return store.listSessions(id);
  });

  app.get("/api/watches/:id/sessions", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const watch = store.getWatch(id);
    if (!watch) {
      reply.code(404);
      return { error: "not found" };
    }
    return planner.listSessionsForWatch(watch);
  });

  app.get("/api/monitors/:monitorId/sessions/:sessionId/seatmap", async (req, reply) => {
    const { monitorId, sessionId } = req.params as { monitorId: string; sessionId: string };
    const result = await planner.getSeatMap(monitorId, sessionId);
    if (!result) {
      reply.code(404);
      return { error: "not found" };
    }
    return result;
  });

  app.get("/api/alerts", async (req) => {
    const q = (req.query as { q?: string }).q;
    if (q) return store.searchAlerts(q);
    return store.listAlerts();
  });

  app.get("/api/search", async (req) => {
    const q = ((req.query as { q?: string }).q ?? "").toLowerCase();
    const watches = store.listWatches().filter((w) => {
      if (!q) return true;
      return (
        w.name.toLowerCase().includes(q) ||
        w.movie.title.toLowerCase().includes(q) ||
        (w.city.label ?? "").toLowerCase().includes(q) ||
        (w.city.districtKey ?? "").toLowerCase().includes(q)
      );
    });
    const statuses = new Map(store.listWatchStatuses().map((s) => [s.watchId, s]));
    return watches.map((w) => ({ ...w, status: statuses.get(w.id) ?? null }));
  });

  app.get("/api/events", async (req, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    const send = () => {
      const watches = store.listWatches();
      const statuses = new Map(store.listWatchStatuses().map((s) => [s.watchId, s]));
      const payload = watches.map((w) => ({ ...w, status: statuses.get(w.id) ?? null }));
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    send();
    const iv = setInterval(send, 5000);
    req.raw.on("close", () => clearInterval(iv));
  });

  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "web");
  try {
    await app.register(fastifyStatic, { root: webRoot, prefix: "/" });
  } catch {
    // web assets may not be built yet
  }

  app.setNotFoundHandler(async (req, reply) => {
    if (req.url.startsWith("/api")) {
      reply.code(404);
      return { error: "not found" };
    }
    return reply.sendFile("index.html");
  });

  return app;
}

export async function startServer(
  store: Store,
  planner: PollPlanner,
  config: WatchConfig,
  log: Logger,
  port = 4317,
  host = "127.0.0.1",
): Promise<FastifyInstance> {
  const app = await createServer(store, planner, config, log);
  await app.listen({ port, host });
  log.info(`API listening on http://${host}:${port}`);
  return app;
}
