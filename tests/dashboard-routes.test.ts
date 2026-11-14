import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { env } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { startServer } from "../src/server.js";
import { ChartKnowledgeRepository } from "../src/chart-knowledge.js";
import { position, provider } from "./fixtures.js";

test("dashboard routes isolate read models and never eagerly aggregate other pages", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dashboard-route-api-"));
  const old = {
    mode: env.TRADING_MODE,
    ack: env.LIVE_TRADING_ACK,
    entries: env.NEW_ENTRIES_ENABLED,
    scanner: env.SCANNER_ENABLED,
    wallet: env.WALLET_PUBLIC_KEY,
    path: env.DATABASE_PATH,
    port: env.PORT,
  };
  const status = t.mock.method(Engine.prototype, "status"),
    analytics = t.mock.method(Engine.prototype, "analytics");
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    Object.assign(env, {
      TRADING_MODE: "demo",
      LIVE_TRADING_ACK: false,
      NEW_ENTRIES_ENABLED: false,
      SCANNER_ENABLED: false,
      WALLET_PUBLIC_KEY: "",
      DATABASE_PATH: join(dir, "fixture.sqlite"),
      PORT: 42000 + Math.floor(Math.random() * 5000),
    });
    t.mock.timers.enable({ apis: ["setInterval"] });
    const g = provider();
    app = await startServer({
      providers: { gmgn: g.gmgn },
    });
    await app.engine.stop();
    const base = "http://127.0.0.1:" + env.PORT;
    for (let n = 0; n < 12; n++)
      for (const state of ["OPEN", "CLOSED"] as const)
        app.engine.store.savePosition({
          ...position(),
          id: state + n,
          mint: state + "-mint-" + n,
          mode: "demo",
          symbol: state + n,
          state,
          quantity: state === "CLOSED" ? "0" : "1000",
          entryAt: Date.now() + n,
        });
    await t.test(
      "only explicit frontend paths serve the SPA; API paths keep JSON 404",
      async () => {
        for (const path of [
          "/",
          "/positions",
          "/history",
          "/settings",
          "/logs",
          "/thongke",
          "/chart-learning",
        ]) {
          const r = await fetch(base + path);
          assert.equal(r.status, 200);
          assert.match(await r.text(), /routeOutlet/);
        }
        for (const path of [
          "/overview",
          "/unknown",
          "/api/unknown",
          "/api/history/unknown",
        ]) {
          const r = await fetch(base + path);
          assert.equal(r.status, 404);
          assert.match(r.headers.get("content-type") ?? "", /json/);
          assert.doesNotMatch(await r.text(), /routeOutlet/);
        }
      },
    );
    await t.test(
      "Chart Learning uses persisted SQLite with honest empty states",
      async () => {
        const result = await (await fetch(base + "/api/chart-learning")).json();
        assert.equal(result.overview.scope.mode, "SHARED");
        assert.equal(result.overview.candleCount, 0);
        assert.equal(result.status.analyzer.mode, "DISABLED");
        assert.equal(result.analysisStatus.automaticEnabled, false);
        assert.deepEqual(result.learningCases, []);
        assert.deepEqual(result.rules, []);
        assert.deepEqual(result.decisions, []);
        const experiences = await (await fetch(base + "/api/chart-learning/experiences")).json();
        assert.deepEqual(experiences.items, []);
        assert.equal(experiences.total, 0);
        const decision = await (
          await fetch(base + "/api/chart-learning/decision?id=FAKE")
        ).json();
        assert.equal(decision.error, "DECISION_NOT_FOUND");
        const denied = await fetch(base + "/api/chart-learning/analyze", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ caseId: "missing" }),
        });
        assert.equal(denied.status, 403);
        const shell = await (await fetch(base + "/api/ui/shell")).json();
        const allowed = await fetch(base + "/api/chart-learning/analyze", {
          method: "POST",
          headers: {
            origin: base,
            "content-type": "application/json",
            "x-csrf-token": shell.csrf,
          },
          body: JSON.stringify({ caseId: "missing" }),
        });
        assert.equal(allowed.status, 409);
        const repo=new ChartKnowledgeRepository(app!.engine.store.learningDb),draft=repo.createDraft({id:"KN-API",title:"API fixture pattern",category:"DISTRIBUTION",applicableStage:"PRE_BUY",description:"Independent dashboard control fixture.",marketContext:"test",observedBehaviors:["fading volume"],variations:[],supportingIndicators:[],counterexamples:[],invalidationConditions:[],supportingCaseIds:[],contradictoryCaseIds:[]});
        const rejected=await fetch(`${base}/api/chart-learning/knowledge/${draft.id}/reject`,{method:"POST",headers:{origin:base,"content-type":"application/json","x-csrf-token":shell.csrf},body:JSON.stringify({version:draft.version,reason:"API lifecycle test"})});
        assert.equal(rejected.status,202);
        const detail=await fetch(`${base}/api/chart-learning/knowledge/${draft.id}`);
        assert.equal(detail.status,200);assert.equal((await detail.json()).knowledge.validationStatus,"REJECTED");
      },
    );
    await t.test(
      "global shell is small and has no Memory/statistics/History payload",
      async () => {
        const data = await (await fetch(base + "/api/ui/shell")).json();
        assert.equal(typeof data.csrf, "string");
        assert.equal(data.capabilities.dashboardRoutes, true);
        for (const key of [
          "overview",
          "learning",
          "analytics",
          "strategyAnalytics",
          "settings",
          "events",
          "flow",
          "trades",
          "positionSummary",
        ])
          assert.equal(key in data, false);
        assert.equal(status.mock.callCount(), 0);
        assert.equal(analytics.mock.callCount(), 0);
      },
    );
    await t.test(
      "Overview preview is capped separately from the full active Positions page",
      async () => {
        const preview = await (await fetch(base + "/api/overview")).json();
        assert.equal(preview.positions.length, 10);
        assert.equal(preview.positionTotal, 12);
        assert.ok(preview.positions.every((p: any) => p.state === "OPEN"));
        const page = await (
          await fetch(base + "/api/positions?view=page")
        ).json();
        assert.equal(page.positions.length, 12);
        assert.ok(page.positions.every((p: any) => p.state === "OPEN"));
        assert.equal(
          page.settings,
          undefined,
          "Retired profit-reference controls are not part of the positions API",
        );
        assert.equal(analytics.mock.callCount(), 0);
      },
    );
    await t.test(
      "History retains server ordering/filter/pagination without requiring Positions",
      async () => {
        const data = await (
          await fetch(base + "/api/history?limit=2&offset=1")
        ).json();
        assert.equal(data.length, 2);
        assert.equal(data[0].state, "CLOSED");
        assert.equal(data[0].entryAt >= data[1].entryAt, true);
        assert.equal(analytics.mock.callCount(), 0);
      },
    );
    await t.test(
      "count API returns only count and does not hydrate page data or call wallet",
      async () => {
        const store = app!.engine.store;
        store.savePosition({
          ...position(),
          id: "unsigned-entry",
          mode: "demo",
          state: "PENDING_ENTRY",
          quantity: "0",
        });
        const reads = [
          t.mock.method(store, "positions", () => {
            throw Error("No page hydration");
          }),
          t.mock.method(store, "executions", () => {
            throw Error("No execution hydration");
          }),
          t.mock.method(app!.engine, "balance", async () => {
            throw Error("No wallet read");
          }),
        ];
        try {
          const response = await fetch(base + "/api/positions/count");
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("cache-control"), "no-store");
          assert.deepEqual(await response.json(), { count: 12 });
          for (const read of reads) assert.equal(read.mock.callCount(), 0);
        } finally {
          for (const read of reads) read.mock.restore();
        }
      },
    );
    await t.test(
      "retired Memory endpoint is absent and statistics aggregate only on request",
      async () => {
        await fetch(base + "/api/settings");
        app!.engine.store.record("events", undefined, {
          type: "ERROR",
          reason: "ROUTE_FIXTURE_SYSTEM_ALERT",
        });
        const logs = await (await fetch(base + "/api/logs")).json();
        assert.ok(
          logs.events.some(
            (row: any) => row.payload.reason === "ROUTE_FIXTURE_SYSTEM_ALERT",
          ),
        );
        assert.equal(analytics.mock.callCount(), 0);
        assert.equal((await fetch(base + "/api/learning")).status, 404);
        assert.equal(analytics.mock.callCount(), 0);
        assert.equal(
          (await fetch(base + "/api/statistics?strategy=KRONOS")).status,
          200,
        );
        assert.equal(analytics.mock.callCount(), 1);
        assert.equal(
          (await fetch(base + "/api/statistics?strategy=INVALID")).status,
          400,
        );
        assert.equal(status.mock.callCount(), 0);
        t.mock.timers.tick(10000);
        await Promise.resolve();
        assert.equal(
          status.mock.callCount(),
          0,
          "No full-status background job without legacy SSE clients",
        );
        assert.equal(analytics.mock.callCount(), 1);
      },
    );
    await t.test("CSRF and Host protections remain in force", async () => {
      const r = await fetch(base + "/api/settings", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: base,
          "x-csrf-token": "wrong",
        },
        body: "{}",
      });
      assert.equal(r.status, 403);
      assert.equal(app!.engine.settings.positionSizePercent, 1);
    });
    assert.ok(
      g.calls.every((a) => a[0] === "token" && a[1] === "info"),
      "Only startup read-only SOL price lookup is permitted",
    );
    assert.equal(app.engine.store.executions().length, 0);
  } finally {
    await app?.stop();
    t.mock.timers.reset();
    Object.assign(env, {
      TRADING_MODE: old.mode,
      LIVE_TRADING_ACK: old.ack,
      NEW_ENTRIES_ENABLED: old.entries,
      SCANNER_ENABLED: old.scanner,
      WALLET_PUBLIC_KEY: old.wallet,
      DATABASE_PATH: old.path,
      PORT: old.port,
    });
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("dashboard-route-api-"));
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});
