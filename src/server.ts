import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  openSync,
  writeFileSync,
  closeSync,
  unlinkSync,
  appendFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, localPath, runtimeConfig, defaultSettings } from "./config.js";
import { KronosStore } from "./kronos-store.js";
import { KronosLab, type LabInference } from "./kronos-lab.js";
import { KronosMarket, type LabMarket } from "./kronos-market.js";
import { KronosWorker } from "./kronos-worker.js";
import { TOKEN_IMAGE_CSP } from "./token-metadata.js";
import { startupErrorCode } from "./startup-error.js";
import { WalletBalance } from "./wallet-balance.js";
import { LiveStore } from "./live-store.js";
import { LiveExecutor } from "./live-executor.js";
import { Solana } from "./solana.js";
import { JupiterExecutionProvider, localWallet } from "./execution-provider.js";
import {
  requireLiveConfiguration,
  SOL,
  LIVE_SIZING_POLICY,
  requireMainnetGenesis,
} from "./live-config.js";

export async function startKronos(
  configuration = runtimeConfig(),
  fixtures: {
    market?: LabMarket;
    inference?: LabInference;
    timer?: boolean;
  } = {},
) {
  const live = configuration.mode === "live";
  if (live) {
    if (!configuration.execution) throw Error("LIVE_CONFIGURATION_INCOMPLETE");
    requireLiveConfiguration(
      configuration.execution,
      configuration.apiKey,
      configuration.rpcUrl,
    );
    const wallet = localWallet(configuration.execution);
    wallet.secretKey.fill(0);
  } else if (configuration.realExecutionEnabled !== false)
    throw Error("LIVE_MODE_MISMATCH");
  for (const p of [
    configuration.database,
    configuration.runtime,
    configuration.logs,
  ])
    localPath(p);
  mkdirSync(configuration.logs, { recursive: true });
  mkdirSync(configuration.runtime, { recursive: true });
  const lock = join(configuration.runtime, "kronos.lock");
  let fd: number;
  try {
    fd = openSync(lock, "wx");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST"
    )
      throw Error("KRONOS_LOCK_EXISTS_CHECK_PID");
    throw error;
  }
  writeFileSync(fd, String(process.pid));
  closeSync(fd);
  const store = new KronosStore(configuration.database);
  const market =
    fixtures.market ??
    new KronosMarket(
      configuration.apiKey,
      configuration.rpcUrl,
      defaultSettings(),
    );
  const inference =
    fixtures.inference ?? new KronosWorker(configuration.runtime);
  const lab = new KronosLab(store, market, inference, live ? "LIVE" : "PAPER"),
    csrf = randomBytes(32).toString("hex");
  const ledger = new LiveStore(store);
  let executor: LiveExecutor | undefined;
  let rpc: Solana | undefined;
  if (live) {
    rpc = new Solana(configuration.rpcUrl);
    executor = new LiveExecutor(
      store,
      new JupiterExecutionProvider(rpc, configuration.execution!),
      rpc,
      configuration.execution!,
      () => lab.assertLiveAuthority(),
      async (t) => {
        const c = store.get("candidate:" + t.id) ?? {
          mint: t.mint,
          source: "gmgn:trending",
          discoveredAt: t.discoveredAt,
        };
        await market.prepare(c, async (name, work) => {
          const result = await work();
          t.gates[name] = { status: "PASS", at: Date.now(), evidence: result };
          store.save(t);
          return result;
        });
        for (const name of [
          "CHEAP_FILTER",
          "SECURITY",
          "COMPATIBILITY",
          "HISTORY",
          "CAPITAL_FLOW",
        ])
          if (!t.gates[name] || Date.now() - t.gates[name].at > 45000)
            throw Error("PRE_BUY_ELIGIBILITY_EXPIRED");
      },
      async () => {
        const p = await market.price(SOL);
        return p
          ? { price: String(p.value), at: p.observedAt, source: "GMGN_SOL_USD" }
          : null;
      },
    );
    lab.attachExecution(executor, configuration.dryRun);
  }
  const walletBalance = new WalletBalance(
    live && rpc
      ? () => rpc!.balance(configuration.execution!.WALLET_PUBLIC_KEY)
      : undefined,
  );
  async function livePreflight() {
    if (!live) {
      if (ledger.pending().length || ledger.openCount())
        throw Error("LIVE_STATE_REQUIRES_LIVE_RECOVERY");
      return;
    }
    requireLiveConfiguration(
      configuration.execution!,
      configuration.apiKey,
      configuration.rpcUrl,
    );
    requireMainnetGenesis(await rpc!.connection.getGenesisHash());
    await executor!.recover();
    if (ledger.pending().length) throw Error("PENDING_TRANSACTION");
    for (const p of ledger.positions(
      configuration.execution!.WALLET_PUBLIC_KEY,
    ))
      if ((await rpc!.tokenBalance(p.wallet, p.mint)) !== BigInt(p.quantity))
        throw Error("OPEN_POSITION_BALANCE_MISMATCH");
    if (
      (await rpc!.balance(configuration.execution!.WALLET_PUBLIC_KEY)) <
      BigInt(configuration.execution!.reserveLamports)
    )
      throw Error("INSUFFICIENT_FEE_RESERVE");
  }
  const settings = defaultSettings();
  const event = (kind: string) =>
    appendFileSync(
      join(configuration.logs, "kronos.log"),
      JSON.stringify({
        at: new Date().toISOString(),
        bot: "BOT KRONOS",
        mode: configuration.mode.toUpperCase(),
        kind,
      }) + "\n",
    );
  const server = createServer(async (req, res) => {
    const host = req.headers.host;
    const hosts = [
      `127.0.0.1:${configuration.port}`,
      `localhost:${configuration.port}`,
    ];
    const reply = (code: number, value: unknown) => {
      res.writeHead(code, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(JSON.stringify(value));
    };
    if (!host || !hosts.includes(host))
      return reply(403, { error: "HOST_DENIED" });
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);
      if (req.method === "GET") {
        const files: Record<string, string> = {
          "/": "index.html",
          "/style.css": "style.css",
          "/kronos.js": "kronos.js",
          "/overview.js": "overview.js",
          "/token-avatar.js": "token-avatar.js",
        };
        const file = files[url.pathname];
        if (file) {
          res.writeHead(200, {
            "Content-Type": file.endsWith(".html")
              ? "text/html"
              : file.endsWith(".css")
                ? "text/css"
                : "text/javascript",
            "Cache-Control": "no-store",
            "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src ${TOKEN_IMAGE_CSP}; frame-ancestors 'none'`,
            "X-Content-Type-Options": "nosniff",
          });
          return res.end(readFileSync(join(ROOT, "public", file)));
        }
        if (url.pathname === "/api/status")
          return reply(200, {
            name: "K1ll of BOT — Kronos",
            mode: configuration.mode,
            paperOnly: !live,
            realExecutionEnabled: live,
            pid: process.pid,
            csrf,
            settings,
            sizing: LIVE_SIZING_POLICY,
            discovery: lab.discovery.view(),
            wallet: walletBalance.view(),
            credentials: {
              gmgn: configuration.apiKey ? "configured" : "not configured",
              wallet: live ? "configured" : "not configured",
              rpc: configuration.rpcUrl ? "configured" : "not configured",
              jupiter: configuration.execution?.JUPITER_API_KEY
                ? "configured"
                : "not configured",
            },
          });
        if (url.pathname === "/api/kronos")
          return reply(200, {
            ...lab.status(),
            csrf,
            name: "K1ll of BOT — Kronos",
          });
        const integer = (key: string, fallback: number) => {
          const raw = url.searchParams.get(key);
          if (raw === null) return fallback;
          if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)))
            throw Error("INVALID_PAGINATION");
          return Number(raw);
        };
        const page = {
          cursor: integer("cursor", 0),
          limit: integer("limit", 50),
          state: url.searchParams.get("state") ?? "ALL",
          mode: url.searchParams.get("mode") ?? "ALL",
        };
        if (url.pathname === "/api/overview")
          return reply(200, {
            ...lab.overview(),
            marketData: "REAL",
            tradingMode: live ? "LIVE" : "PAPER",
            liveExecution: executor?.status(),
            providers: market instanceof KronosMarket ? market.status() : {},
            wallet: walletBalance.view(),
          });
        if (url.pathname === "/api/history")
          return reply(200, store.page(page));
        if (url.pathname === "/api/positions")
          return reply(200, store.page({ ...page, openOnly: true }));
        if (url.pathname === "/api/statistics")
          return reply(
            200,
            url.searchParams.get("mode") === "LIVE"
              ? ledger.summary()
              : { ...store.summary(), mode: "PAPER" },
          );
        if (url.pathname === "/api/logs")
          return reply(200, {
            rows: store.events(
              url.searchParams.get("trialId") ?? undefined,
              page.cursor,
              page.limit,
            ),
          });
        if (url.pathname === "/api/trial")
          return reply(200, {
            trial: store.trial(url.searchParams.get("id") ?? ""),
            decisions: store.decisions(url.searchParams.get("id") ?? ""),
            executions: store.db
              .prepare(
                "SELECT payload FROM live_executions WHERE json_extract(payload,'$.trialId')=? ORDER BY rowid DESC LIMIT 50",
              )
              .all(url.searchParams.get("id") ?? "")
              .map((r) => {
                const e = JSON.parse(String(r.payload));
                return {
                  id: e.id,
                  side: e.intent.side,
                  state: e.state,
                  requestedAmount: e.intent.amount,
                  decisionAt: e.intent.decisionAt,
                  at: e.at,
                  signature: e.signature ?? null,
                  accounting: e.accounting ?? null,
                  failedFeeLamports: e.failedFeeLamports ?? null,
                  error: e.error ?? null,
                };
              }),
          });
        return reply(404, { error: "NOT_FOUND" });
      }
      if (req.method !== "POST" || url.pathname !== "/api/kronos/control")
        return reply(404, { error: "NOT_FOUND" });
      if (
        req.headers.origin !== `http://${host}` ||
        req.headers["x-csrf-token"] !== csrf ||
        !req.headers["content-type"]?.startsWith("application/json")
      )
        return reply(403, { error: "LOCAL_CSRF_REQUIRED" });
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2048) throw Error("BODY_TOO_LARGE");
      }
      const data = JSON.parse(body);
      if (data.csrf !== csrf)
        return reply(403, { error: "LOCAL_CSRF_REQUIRED" });
      if (data.action === "enable") {
        if (!configuration.apiKey && !fixtures.market)
          throw Error("KRONOS_GMGN_API_KEY_REQUIRED");
        await livePreflight();
        lab.setEnabled(true);
        event(live ? "LIVE_COLLECTION_ENABLED" : "PAPER_COLLECTION_ENABLED");
      } else if (data.action === "pause") {
        lab.setEnabled(false);
        event("PAPER_COLLECTION_PAUSED");
      } else if (data.action === "detail" && typeof data.id === "string")
        return reply(200, { decisions: store.decisions(data.id) });
      else if (data.action === "reset") {
        lab.reset(data.confirmation);
        event("PAPER_RESET");
      } else throw Error("ACTION_DENIED");
      reply(200, { ok: true });
    } catch (e) {
      const message =
        e instanceof Error && /^[A-Z0-9_]+$/.test(e.message)
          ? e.message
          : "REQUEST_FAILED";
      reply(400, { error: message });
    }
  });
  try {
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(configuration.port, "127.0.0.1", accept);
    });
  } catch (error) {
    store.close();
    unlinkSync(lock);
    throw error;
  }
  event("READY_COLLECTION_PAUSED");
  const timer =
    fixtures.timer === false
      ? undefined
      : setInterval(() => {
          void lab.tick().catch(() => event("PAPER_TICK_FAILED"));
        }, 1000);
  let stopped = false;
  return {
    server,
    store,
    lab,
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearInterval(timer);
      await lab.stop();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
      unlinkSync(lock);
      event("STOPPED");
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.title = "BOT KRONOS";
  void startKronos()
    .then((app) => {
      console.log(
        `BOT KRONOS — ${runtimeConfig().mode.toUpperCase()} ready at http://127.0.0.1:${runtimeConfig().port}; collection PAUSED`,
      );
      process.once("SIGINT", () => {
        void app.stop();
      });
      process.once("SIGTERM", () => {
        void app.stop();
      });
    })
    .catch((error) => {
      console.error("KRONOS_STARTUP_FAILED: " + startupErrorCode(error));
      process.exitCode = 1;
    });
}
