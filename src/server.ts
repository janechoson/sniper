import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  AccountBalanceHistory,
  accountPositionValue,
} from "./account-balance-history.js";
import { env } from "./config.js";
import {
  DASHBOARD_ASSETS,
  DASHBOARD_ROUTES,
  dashboardKronos,
  dashboardLogs,
  dashboardPositionCount,
  dashboardPositions,
} from "./dashboard-view.js";
import { demoAccountView } from "./demo-account-view.js";
import { discoveryContext } from "./discovery.js";
import { Blocked } from "./domain.js";
import { Engine } from "./engine.js";
import { chartLearningCommand, chartLearningView } from "./chart-api.js";
import { DatabaseRegistry } from "./database-registry.js";
import { migrateDatabases } from "./database-migration.js";
import { ChartLearning } from "./chart-learning.js";
import { Gmgn } from "./gmgn.js";
import { kronosMigrationPreflight } from "./kronos-migration-preflight.js";
import { ModeManager, migrationSafetyCodes } from "./mode-manager.js";
import { activateNormalLive } from "./normal-live.js";
import { positionViews } from "./position-view.js";
import { entrySource } from "./sniper-structure.js";

import { TOKEN_IMAGE_CSP } from "./token-metadata.js";
import { json, log, safeError, sleep } from "./util.js";
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
    demoOnly?: boolean;
    verifyLive?: (engine: Engine) => Promise<void>;
    providers?: ConstructorParameters<typeof Engine>[1];
  } = {},
) {
  if (options.controlledRunId)
    throw new Blocked("CONTROLLED_START_REQUIRES_MODE_MANAGER_CONFIRMATION");
  // Inspect authoritative recovery state before writable Store migrations or engine construction.
  if (
    existsSync(env.DATABASE_PATH) &&
    !existsSync(
      join(
        resolve(env.DATABASE_DIRECTORY ?? dirname(resolve(env.DATABASE_PATH))),
        "database-split-manifest.json",
      ),
    )
  ) {
    const readOnly = new DatabaseSync(env.DATABASE_PATH, { readOnly: true });
    try {
      readOnly.exec("PRAGMA query_only=ON; BEGIN");
      const check = kronosMigrationPreflight(readOnly);
      readOnly.exec("COMMIT");
      const legacy = check.blockers.filter((b) =>
        migrationSafetyCodes.has(b.code),
      );
      if (legacy.length)
        throw new Blocked(
          legacy.map((b) => b.code + ":" + (b.id ?? b.reason)).join(";"),
        );
    } finally {
      readOnly.close();
    }
  }
  const directory = resolve(
    env.DATABASE_DIRECTORY ?? dirname(resolve(env.DATABASE_PATH)),
  );
  const release = acquireLock(join(directory, "registry"));
  try {
    await migrateDatabases(env.DATABASE_PATH, directory, {
      lockOwnerPid: process.pid,
    });
  } catch (e) {
    release();
    throw e;
  }
  const registry = new DatabaseRegistry(directory);
  const unsafe = registry.learning
    .prepare(
      "SELECT count(*) n FROM migration_quarantine WHERE table_name IN ('positions','executions','intents','manual_exits','execution_fills','buy_ownership_claims')",
    )
    .get()!.n;
  if (Number(unsafe)) {
    registry.close();
    release();
    throw new Blocked("QUARANTINED_CUSTODY_REQUIRES_REVIEW");
  }
  const store = registry.demo,
    csrf = randomBytes(32).toString("hex");
  const sharedGmgn = options.providers?.gmgn ?? new Gmgn();
  const learning = new ChartLearning(
    store,
    sharedGmgn,
    options.providers?.codex,
    [registry.demo, registry.live],
  );
  const sharedProviders = { ...options.providers, gmgn: sharedGmgn, learning };
  let engine!: Engine;
  let unsubscribeAttempts = () => {};
  const manager = new ModeManager(
    store,
    (mode) => {
      unsubscribeAttempts();
      const context = registry.context(mode);
      engine = new Engine(context.database, {
        ...sharedProviders,
        generation: context.generation,
      });
      unsubscribeAttempts = subscribeAttempts();
      return engine;
    },
    options.verifyLive ?? activateNormalLive,
    async () => {
      await accountHistory.stop();
    },
    undefined,
    registry,
  );
  const streams = new Set<ServerResponse>();
  const executionMarker = () => {
    const pending = Number(
      registry.live.db
        .prepare(
          "SELECT count(*) n FROM executions WHERE json_extract(payload,'$.intent.mode')='live' AND state NOT IN ('CONFIRMED','FAILED')",
        )
        .get()!.n,
    );
    if (pending) throw Error("ACCOUNT_EXECUTION_PENDING");
    return Number(
      registry.live.db
        .prepare(
          "SELECT coalesce(max(rowid),0) n FROM executions WHERE json_extract(payload,'$.intent.mode')='live'",
        )
        .get()!.n,
    );
  };
  const positionMarker = () =>
    registry.live
      .managedPositions("live")
      .filter((p) => !["CLOSED", "FAILED"].includes(p.state))
      .map((p) => [p.id, p.state, p.quantity].join(":"))
      .sort()
      .join("|");
  const accountHistory = new AccountBalanceHistory(
    join(dirname(resolve(env.DATABASE_PATH)), "account-balance-history.json"),
    createHash("sha256")
      .update("live:" + (env.WALLET_PUBLIC_KEY ?? ""))
      .digest("hex"),
    "live",
    async () => {
      if (env.TRADING_MODE !== "live")
        throw Error("LIVE_ACCOUNT_HISTORY_INACTIVE");
      const started = Date.now(),
        execution = executionMarker(),
        positions = positionMarker();
      const wallet = await engine.balance();
      const at = Date.now(),
        value = accountPositionValue(
          registry.live.managedPositions("live"),
          at,
        );
      if (
        Date.now() - started > 5000 ||
        execution !== executionMarker() ||
        positions !== positionMarker() ||
        value.positionLamports === null
      )
        throw Error("ACCOUNT_OBSERVATION_INCOMPLETE");
      registry.live.record("portfolio_snapshots", undefined, {
        at,
        walletLamports: wallet.toString(),
        positionLamports: value.positionLamports,
        totalLamports: (wallet + BigInt(value.positionLamports)).toString(),
        positionCount: value.positionCount,
        source: "RECONCILED_BLOCKCHAIN",
      });
      return {
        at,
        walletLamports: wallet.toString(),
        positionLamports: value.positionLamports,
        totalLamports: (wallet + BigInt(value.positionLamports)).toString(),
        positionCount: value.positionCount,
      };
    },
  );
  const subscribeAttempts = () =>
    engine.attempts.subscribe(() => {
      if (!streams.size) return;
      const frame =
        "event: overview\ndata: " + json(engine.overviewStatus()) + "\n\n";
      for (const stream of streams) stream.write(frame);
    });
  let cached: unknown;
  let cachedAt = 0;
  let statusPending: Promise<unknown> | undefined;
  const scopeStamp = () =>
    env.TRADING_MODE +
    ":" +
    (env.TRADING_MODE === "demo" ? store.demoAccountId() : "live");
  const fullStatus = async () => {
    const stamp = scopeStamp();
    if (cached && Date.now() - cachedAt < 1000) return cached;
    if (!statusPending)
      statusPending = engine
        .status()
        .then((value) => {
          if (stamp !== scopeStamp() || manager.isTransitioning)
            throw new Blocked("MODE_CHANGED_RELOAD_REQUIRED");
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
    const stamp = scopeStamp();
    if (shellCache && Date.now() - shellAt < 1000) return shellCache;
    if (!shellPending)
      shellPending = engine
        .dashboardStatus()
        .then((value) => {
          if (stamp !== scopeStamp() || manager.isTransitioning)
            throw new Blocked("MODE_CHANGED_RELOAD_REQUIRED");
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
    // Capture the request's immutable trading database. A later switch cannot
    // retarget an in-flight read or write into the other financial environment.
    const requestEngine = engine;
    if (!requestEngine) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end('{"error":"ENGINE_INITIALIZING"}');
      return;
    }
    const store = requestEngine.store;
    const readBody = async () => {
      const value = await body(req);
      if (requestEngine !== engine || manager.isTransitioning)
        throw new Blocked("MODE_CHANGED_RELOAD_REQUIRED");
      return value;
    };
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
      if (
        req.method === "POST" &&
        url.pathname.startsWith("/api/") &&
        url.pathname !== "/api/mode" &&
        !url.pathname.startsWith("/api/chart-learning") &&
        manager.isTransitioning
      )
        throw new Blocked("MODE_TRANSITION_IN_PROGRESS");
      if (
        req.method === "GET" &&
        url.pathname.startsWith("/api/") &&
        url.pathname !== "/api/mode" &&
        !url.pathname.startsWith("/api/chart-learning") &&
        manager.isTransitioning
      )
        return reply(res, 409, { error: "MODE_TRANSITION_IN_PROGRESS" });
      if (req.method === "POST") {
        if (
          req.headers.origin !== `http://${req.headers.host}` ||
          req.headers["x-csrf-token"] !== csrf ||
          !req.headers["content-type"]?.startsWith("application/json")
        )
          return reply(res, 403, { error: "LOCAL_ORIGIN_AND_CSRF_REQUIRED" });
      }
      if (
        req.method === "GET" &&
        (url.pathname === "/api/chart-learning" ||
          url.pathname.startsWith("/api/chart-learning/"))
      )
        return reply(res, 200, chartLearningView(engine, url));
      if (req.method === "POST" && url.pathname.startsWith("/api/chart-learning/"))
        return reply(res, 202, chartLearningCommand(requestEngine, url, await readBody()));
      if (req.method === "GET" && url.pathname === "/api/status")
        return reply(res, 200, { ...((await fullStatus()) as object), csrf });
      if (req.method === "GET" && url.pathname === "/favicon.ico") {
        res.writeHead(302, { Location: "/rug-killer-neon.png", "Cache-Control": "no-cache" });
        res.end();
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/ui/shell")
        return reply(res, 200, { ...(await shellStatus()), csrf });
      if (req.method === "GET" && url.pathname === "/api/positions/count")
        return reply(res, 200, dashboardPositionCount(store, env.TRADING_MODE));
      if (req.method === "GET" && url.pathname === "/api/overview")
        return reply(res, 200, requestEngine.overviewStatus());
      if (req.method === "GET" && url.pathname === "/api/mode")
        return reply(res, 200, manager.status());
      if (req.method === "GET" && url.pathname === "/api/demo-account") {
        if (env.TRADING_MODE !== "demo")
          throw new Blocked("DEMO_ACCOUNT_INACTIVE");
        return reply(res, 200, demoAccountView(engine));
      }
      if (req.method === "GET" && url.pathname === "/api/account-balance") {
        z.literal("24h").parse(url.searchParams.get("range") ?? "24h");
        return reply(
          res,
          200,
          env.TRADING_MODE === "demo"
            ? demoAccountView(engine)
            : accountHistory.view(),
        );
      }
      if (req.method === "GET" && url.pathname === "/api/settings")
        return reply(res, 200, requestEngine.settings);
      if (req.method === "GET" && url.pathname === "/api/statistics") {
        const strategy = z
          .enum(["ALL", "KRONOS"])
          .parse(url.searchParams.get("strategy") ?? "ALL");
        const data = requestEngine.analytics(
          strategy === "ALL" ? undefined : strategy,
        );
        return reply(
          res,
          200,
          strategy === "ALL" ? data : data.strategyAccounting,
        );
      }
      if (req.method === "GET" && url.pathname === "/api/kronos/management") {
        const range = z.enum(["all", "24h", "7d"]).parse(url.searchParams.get("range") ?? "all");
        return reply(res, 200, dashboardKronos(requestEngine, range));
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
        return reply(res, 200, requestEngine.settings);
      if (
        (req.method === "GET" && url.pathname === "/api/kronos") ||
        (req.method === "POST" && url.pathname === "/api/kronos/control")
      ) {
        return req.method === "GET"
          ? reply(res, 200, {
              integrated: true,
              strategy: "KRONOS",
              model: requestEngine.kronos.status(),
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
                sniperStructure: requestEngine.structure.get(mint),
                entryDiscoverySource: c.discovery?.sources.includes("TRENDING")
                  ? "TRENDING"
                  : entrySource(c, requestEngine.settings),
              }
            : { error: "CANDIDATE_NOT_FOUND" },
        );
      }
      if (req.method === "GET" && url.pathname === "/api/history") {
        const query = z
          .object({
            strategy: z.enum(["KRONOS"]).optional(),
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
            { preserveOrder: true },
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
              requestEngine.settings.trendingFreshMs,
              requestEngine.discovery.feeds.TRENDING,
            ),
          })),
        );
      if (req.method === "POST" && url.pathname === "/api/mode") {
        const v = z
          .object({
            mode: z.enum(["DEMO", "LIVE"]),
            confirmation: z.string().optional(),
          })
          .strict()
          .parse(await readBody());
        const result = await manager.switch(v.mode, v.confirmation);
        if (env.TRADING_MODE === "live") await accountHistory.start();
        cached = undefined;
        shellCache = undefined;
        return reply(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/mode/stop") {
        if (env.TRADING_MODE === "live" && manager.blockers().length)
          throw new Blocked(manager.blockers().join(";"));
        return reply(res, 200, await manager.stopSafely());
      }
      if (req.method === "POST" && url.pathname === "/api/demo/reset") {
        const v = z
          .object({ confirmation: z.string() })
          .strict()
          .parse(await readBody());
        const result = await manager.resetDemo(v.confirmation);
        cached = undefined;
        shellCache = undefined;
        return reply(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/api/kill") {
        const v = z
          .object({ enabled: z.boolean() })
          .strict()
          .parse(await readBody());
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
        const input = z.record(z.string(), z.unknown()).parse(await readBody());
        // Permission has its own operator command; stale parameter forms must not re-enable BUY.
        requestEngine.updateSettings(input);
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
          .parse(await readBody());
        requestEngine.emergency(
          v.positionId,
          Math.round((v.sellPercent ?? 100) * 100),
        );
        return reply(res, 202, { queued: true });
      }
      if (req.method === "POST" && url.pathname === "/api/positions/dismiss") {
        const v = z
          .object({ positionId: z.string().uuid() })
          .strict()
          .parse(await readBody());
        requestEngine.dismissPosition(v.positionId);
        cached = undefined;
        shellCache = undefined;
        return reply(res, 200, { ok: true });
      }
      if (req.method === "POST" && url.pathname === "/api/scan") {
        if (!manager.status().active)
          throw new Blocked("ENGINE_SESSION_NOT_RUNNING");
        if (!requestEngine.scanning) void requestEngine.tick();
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
              : file.endsWith(".png")
                ? "image/png"
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
    registry.close();
    release();
    throw error;
  });
  try {
    if (options.demoOnly) await manager.switch("DEMO");
    else await manager.startDefault();
  } catch (error) {
    await manager.stop();
    await new Promise<void>((done) => server.close(() => done()));
    registry.close();
    release();
    throw error;
  }
  engine ??= new Engine(registry.forMode(env.TRADING_MODE), sharedProviders); // No automatic LIVE execution.
  learning.startIndependent();
  await accountHistory
    .load()
    .catch(() => accountHistory.unavailable("ACCOUNT_HISTORY_UNAVAILABLE"));
  if (env.TRADING_MODE === "live" && manager.status().active)
    await accountHistory.start().catch(() => {
      accountHistory.unavailable("ACCOUNT_HISTORY_UNAVAILABLE");
      log("account_history_unavailable");
    });
  const timer = setInterval(() => {
    if (!streams.size || updating) return;
    updating = true;
    const stamp = scopeStamp();
    void engine
      .status()
      .then((status) => {
        if (stamp !== scopeStamp() || manager.isTransitioning) return;
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
    await accountHistory.stop();
    await manager.stop();
    await learning.stop();
    await sharedGmgn.coordinator.stop();
    while (updating) await sleep(50);
    for (const stream of streams) stream.end();
    await new Promise<void>((resolve) =>
      server.close(() => {
        registry.close();
        release();
        resolve();
      }),
    );
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  return {
    server,
    registry,
    learning,
    get engine() {
      return engine;
    },
    manager,
    stop,
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
)
  void startServer().catch((e) => {
    log("startup_failed", { reason: safeError(e) });
    process.exitCode = 1;
  });
