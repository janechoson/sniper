import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  readFileSync,
  openSync,
  writeFileSync,
  closeSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { env } from "./config.js";
import { entrySource } from "./sniper-structure.js";
import { Store } from "./store.js";
import { ControlledSession } from "./controlled-session.js";
import { Engine } from "./engine.js";
import { activateNormalLive } from "./normal-live.js";
import { discoveryContext } from "./discovery.js";
import { positionViews } from "./position-view.js";
import { Blocked } from "./domain.js";
import { json, log, safeError, sleep } from "./util.js";
import { TOKEN_IMAGE_CSP } from "./token-metadata.js";
import {
  DASHBOARD_ROUTES,
  DASHBOARD_ASSETS,
  dashboardPositions,
  dashboardPositionCount,
  dashboardLogs,
  dashboardWatch,
  dashboardDeferred,
} from "./dashboard-view.js";
export function acquireLock(path: string) {
  const lock = resolve(path + ".lock");
  mkdirSync(dirname(lock), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    const pid = Number(readFileSync(lock, "utf8"));
    if (!Number.isInteger(pid) || pid < 1)
      throw new Blocked("INVALID_PROCESS_LOCK_REQUIRES_REVIEW");
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (alive) throw new Blocked("BOT_ALREADY_RUNNING");
    unlinkSync(lock);
    fd = openSync(lock, "wx", 0o600);
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  return () => unlinkSync(lock);
}
export async function startServer(
  options: {
    controlledRunId?: string;
    normalLive?: boolean;
    providers?: ConstructorParameters<typeof Engine>[1];
  } = {},
) {
  const release = acquireLock(env.DATABASE_PATH);
  const store = new Store(env.DATABASE_PATH),
    engine = new Engine(store, {
      ...options.providers,
      controlled: options.controlledRunId
        ? new ControlledSession(store, options.controlledRunId)
        : undefined,
    }),
    csrf = randomBytes(32).toString("hex");
  try {
    if (options.normalLive) await activateNormalLive(engine);
  } catch (error) {
    store.close();
    release();
    throw error;
  }
  const streams = new Set<ServerResponse>();
  const unsubscribeAttempts = engine.attempts.subscribe(() => {
    if (!streams.size) return;
    const frame =
      "event: overview\ndata: " + json(engine.overviewStatus()) + "\n\n";
    for (const stream of streams) stream.write(frame);
  });
  let cached: unknown;
  let cachedAt = 0;
  let statusPending: Promise<unknown> | undefined;
  const fullStatus = async () => {
    if (cached && Date.now() - cachedAt < 1000) return cached;
    if (!statusPending)
      statusPending = engine
        .status()
        .then((value) => {
          cached = value;
          cachedAt = Date.now();
          return value;
        })
        .finally(() => {
          statusPending = undefined;
        });
    return statusPending;
  };
  let shellCache: Awaited<ReturnType<Engine["dashboardStatus"]>> | undefined;
  let shellAt = 0;
  let shellPending: ReturnType<Engine["dashboardStatus"]> | undefined;
  const shellStatus = async () => {
    if (shellCache && Date.now() - shellAt < 1000) return shellCache;
    if (!shellPending)
      shellPending = engine
        .dashboardStatus()
        .then((value) => {
          shellCache = value;
          shellAt = Date.now();
          return value;
        })
        .finally(() => {
          shellPending = undefined;
        });
    return shellPending;
  };
  let updating = false;
  const reply = (res: ServerResponse, code: number, value: unknown) => {
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(json(value));
  };
  const body = async (req: IncomingMessage) => {
    let text = "";
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 32768) throw new Blocked("REQUEST_TOO_LARGE");
    }
    return JSON.parse(text || "{}") as unknown;
  };
  const server = createServer(async (req, res) => {
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src ${TOKEN_IMAGE_CSP}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (
        ![`127.0.0.1:${env.PORT}`, `localhost:${env.PORT}`].includes(
          req.headers.host ?? "",
        )
      )
        return reply(res, 403, { error: "HOST_DENIED" });
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${env.PORT}`);
      if (req.method === "POST") {
        if (
          req.headers.origin !== `http://${req.headers.host}` ||
          req.headers["x-csrf-token"] !== csrf ||
          !req.headers["content-type"]?.startsWith("application/json")
        )
          return reply(res, 403, { error: "LOCAL_ORIGIN_AND_CSRF_REQUIRED" });
      }
      if (req.method === "GET" && url.pathname === "/api/status")
        return reply(res, 200, { ...((await fullStatus()) as object), csrf });
      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/ui/shell")
        return reply(res, 200, { ...(await shellStatus()), csrf });
      if (req.method === "GET" && url.pathname === "/api/positions/count")
        return reply(res, 200, dashboardPositionCount(store, env.TRADING_MODE));
      if (req.method === "GET" && url.pathname === "/api/overview")
        return reply(res, 200, engine.overviewStatus());
      if (req.method === "GET" && url.pathname === "/api/settings")
        return reply(res, 200, engine.settings);
      if (req.method === "GET" && url.pathname === "/api/statistics") {
        const strategy = z
          .enum(["ALL", "STANDARD", "KRONOS"])
          .parse(url.searchParams.get("strategy") ?? "ALL");
        const data = engine.analytics(
          strategy === "ALL" ? undefined : strategy,
        );
        return reply(
          res,
          200,
          strategy === "ALL" ? data : data.strategyAccounting,
        );
      }
      if (req.method === "GET" && url.pathname === "/api/logs") {
        const limit = z.coerce
          .number()
          .int()
          .min(1)
          .max(800)
          .parse(url.searchParams.get("limit") ?? 200);
        return reply(res, 200, dashboardLogs(engine, limit));
      }
      if (req.method === "GET" && url.pathname === "/api/watchlist")
        return reply(res, 200, dashboardWatch(engine));
      if (req.method === "GET" && url.pathname === "/api/deferred")
        return reply(res, 200, dashboardDeferred(engine));
      if (req.method === "GET" && url.pathname === "/api/attempt") {
        const id = z.string().min(1).max(100).parse(url.searchParams.get("id"));
        const attempt = store.attempt(id);
        return reply(
          res,
          attempt ? 200 : 404,
          attempt
            ? {
                ...attempt,
                ownershipClaim: store.buyOwnership(
                  attempt.mint,
                  env.TRADING_MODE,
                  id,
                ),
              }
            : { error: "ATTEMPT_NOT_FOUND" },
        );
      }
      if (req.method === "GET" && url.pathname === "/api/kronos/settings")
        return reply(res, 200, engine.settings);
      if (
        (req.method === "GET" && url.pathname === "/api/kronos") ||
        (req.method === "POST" && url.pathname === "/api/kronos/control")
      ) {
        return req.method === "GET"
          ? reply(res, 200, {
              integrated: true,
              entryStrategy: engine.settings.entryStrategy,
              model: engine.kronos.status(),
            })
          : reply(res, 410, { error: "KRONOS_IS_INTEGRATED_USE_SETTINGS" });
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        if (streams.size >= 8)
          return reply(res, 429, { error: "TOO_MANY_STREAMS" });
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        req.once("close", () => streams.delete(res));
        const initial = await fullStatus();
        if (res.destroyed) return;
        res.write("data: " + json(initial) + "\n\n");
        streams.add(res);
        req.on("close", () => streams.delete(res));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/tokens")
        return reply(
          res,
          200,
          store.tokens().map((c) => ({
            ...c,
            market: store.latest("market_snapshots", c.mint),
            holders: store.latest("holder_snapshots", c.mint),
            security: store.latest("security_results", c.mint),
            creator: store.latest("creator_snapshots", c.mint),
            jev: store.latest("jev_decisions", c.mint),
            risk: store.latest("risk_decisions", c.mint),
            history: store.latest("historical_experience", c.mint),
            exitFeasibility: store.latest("exit_feasibility", c.mint),
          })),
        );
      if (req.method === "GET" && url.pathname === "/api/trace")
        return reply(
          res,
          200,
          store.trace(
            z.string().min(32).max(44).parse(url.searchParams.get("mint")),
          ),
        );
      if (req.method === "GET" && url.pathname === "/api/candidate") {
        const mint = z
          .string()
          .min(32)
          .max(44)
          .parse(url.searchParams.get("mint"));
        const c = store.token(mint);
        return reply(
          res,
          c ? 200 : 404,
          c
            ? {
                ...c,
                exitFeasibility: store.latest("exit_feasibility", mint),
                sniperStructure: engine.structure.get(mint),
                entryDiscoverySource: c.discovery?.sources.includes("TRENDING")
                  ? "TRENDING"
                  : entrySource(c, engine.settings),
              }
            : { error: "CANDIDATE_NOT_FOUND" },
        );
      }
      if (req.method === "GET" && url.pathname === "/api/history") {
        const query = z
          .object({
            strategy: z.enum(["STANDARD", "KRONOS"]).optional(),
            state: z
              .enum([
                "OPEN",
                "CLOSED",
                "FAILED",
                "PENDING_ENTRY",
                "PENDING_EXIT",
              ])
              .optional(),
            limit: z.coerce.number().int().min(1).max(1000).optional(),
            offset: z.coerce.number().int().min(0).optional(),
          })
          .strict()
          .parse(Object.fromEntries(url.searchParams));
        return reply(
          res,
          200,
          positionViews(
            store.history(env.TRADING_MODE, query),
            store.executions(),
            (mint) => store.token(mint),
          ),
        );
      }
      if (
        req.method === "GET" &&
        url.pathname === "/api/positions" &&
        url.searchParams.get("view") === "page"
      )
        return reply(res, 200, dashboardPositions(engine));
      if (req.method === "GET" && url.pathname === "/api/positions")
        return reply(
          res,
          200,
          positionViews(
            store.positions(env.TRADING_MODE),
            store.executions(),
            (mint) => store.token(mint),
          ).map((p) => ({
            ...p,
            discovery: discoveryContext(
              store.token(p.mint),
              Date.now(),
              engine.settings.trendingFreshMs,
              engine.discovery.feeds.TRENDING,
            ),
          })),
        );
      if (req.method === "GET" && url.pathname === "/api/learning")
        return reply(res, 200, engine.memory.report(env.TRADING_MODE));
      if (req.method === "GET" && url.pathname === "/api/learning/trade")
        return reply(
          res,
          200,
          engine.memory.detail(
            z.string().min(1).max(100).parse(url.searchParams.get("id")),
          ),
        );
      if (req.method === "POST" && url.pathname === "/api/kill") {
        const v = z
          .object({ enabled: z.boolean() })
          .strict()
          .parse(await body(req));
        if (
          v.enabled &&
          store
            .pending()
            .some((e) =>
              [
                "AMBIGUOUS",
                "SUBMITTED",
                "PENDING_CONFIRMATION",
                "UNKNOWN",
              ].includes(e.state),
            )
        )
          return reply(res, 409, { error: "UNRESOLVED_TRANSACTIONS" });
        if (v.enabled && !env.NEW_ENTRIES_ENABLED)
          return reply(res, 409, {
            error: "NEW_ENTRIES_ENABLED is false in backend environment",
          });
        store.set("newEntriesEnabled", v.enabled);
        if (v.enabled) {
          store.set("haltReason", null);
          store.set("haltScope", null);
        }
        store.event(
          "ENTRY_CONTROL",
          undefined,
          v.enabled
            ? "New entries enabled"
            : "New entries disabled; protective exits continue",
        );
        cached = undefined;
        shellCache = undefined;
        return reply(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/settings") {
        engine.updateSettings(await body(req));
        cached = undefined;
        shellCache = undefined;
        return reply(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/exit") {
        const v = z
          .object({
            positionId: z.string().uuid(),
            sellPercent: z.number().min(0.01).max(100).optional(),
          })
          .strict()
          .parse(await body(req));
        engine.emergency(
          v.positionId,
          Math.round((v.sellPercent ?? 100) * 100),
        );
        return reply(res, 202, { queued: true });
      }
      if (req.method === "POST" && url.pathname === "/api/positions/dismiss") {
        const v = z
          .object({ positionId: z.string().uuid() })
          .strict()
          .parse(await body(req));
        engine.dismissPosition(v.positionId);
        cached = undefined;
        shellCache = undefined;
        return reply(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/watch/dismiss") {
        const v = z
          .object({ mint: z.string().min(32).max(44) })
          .strict()
          .parse(await body(req));
        engine.dismissStructureWatch(v.mint);
        cached = undefined;
        shellCache = undefined;
        return reply(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/scan") {
        if (!engine.scanning) void engine.tick();
        return reply(res, 202, { queued: true });
      }
      if (
        req.method === "GET" &&
        [
          ...DASHBOARD_ROUTES,
          ...DASHBOARD_ASSETS,
          "/app.js",
          "/flow.js",
          "/style.css",
          "/kronos.js",
          "/token-avatar.js",
        ].includes(url.pathname)
      ) {
        const file = (DASHBOARD_ROUTES as readonly string[]).includes(
          url.pathname,
        )
          ? "index.html"
          : url.pathname.slice(1);
        res.writeHead(200, {
          "Content-Type": file.endsWith(".html")
            ? "text/html"
            : file.endsWith(".js")
              ? "text/javascript"
              : "text/css",
          "Cache-Control": "no-cache",
        });
        res.end(readFileSync(resolve("public", file)));
        return;
      }
      reply(res, 404, { error: "NOT_FOUND" });
    } catch (e) {
      reply(res, e instanceof z.ZodError ? 400 : 409, { error: safeError(e) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(env.PORT, "127.0.0.1", resolve);
  }).catch((error) => {
    store.close();
    release();
    throw error;
  });
  await engine.start();
  const timer = setInterval(() => {
    if (!streams.size || updating) return;
    updating = true;
    void engine
      .status()
      .then((status) => {
        cached = status;
        cachedAt = Date.now();
        for (const stream of streams)
          stream.write("data: " + json(status) + "\n\n");
      })
      .catch(() => {})
      .finally(() => (updating = false));
  }, 5000);
  let flowCursor = -1;
  const flowTimer = setInterval(() => {
    if (!streams.size) return;
    try {
      const overviewFrame =
        "event: overview\ndata: " + json(engine.overviewStatus()) + "\n\n";
      for (const stream of streams) stream.write(overviewFrame);
      const cursor = Number(
        store.db.prepare("SELECT coalesce(max(id),0) id FROM records").get()!
          .id,
      );
      if (cursor === flowCursor) return;
      flowCursor = cursor;
      const frame = "event: flow\ndata: " + json(engine.flowStatus()) + "\n\n";
      for (const stream of streams) stream.write(frame);
    } catch {
      /* Full status/health continues; no synthetic transitions are sent. */
    }
  }, 1000);
  log("server_started", {
    url: `http://127.0.0.1:${env.PORT}`,
    mode: env.TRADING_MODE,
    broadcastEnabled: env.TRADING_MODE === "live" && env.LIVE_TRADING_ACK,
  });
  let stopping = false;
  const stop = async () => {
    unsubscribeAttempts();
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    clearInterval(flowTimer);
    await engine.stop();
    while (updating) await sleep(50);
    for (const stream of streams) stream.end();
    await new Promise<void>((resolve) =>
      server.close(() => {
        store.close();
        release();
        resolve();
      }),
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return { server, engine, stop };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
)
  void startServer().catch((e) => {
    log("startup_failed", { reason: safeError(e) });
    process.exitCode = 1;
  });
