import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { KronosStore } from "../src/kronos-store.js";
import { KronosMarket } from "../src/kronos-market.js";
import { startKronos } from "../src/server.js";
import { ROOT, runtimeConfig } from "../src/config.js";
import { fixture } from "./fixtures.js";

function seed(store: KronosStore, n: number) {
  const at = Date.now();
  for (let i = 0; i < n; i++) {
    const t = store.add({
      mint: "synthetic" + i,
      appearance: "synthetic" + i,
      discoveredAt: at,
    })!;
    t.status = "CLOSED";
    t.checkedAt = at;
    t.entry = { value: 1, observedAt: at - 60000, source: "GMGN_TOKEN_INFO" };
    t.exit = {
      value: i % 3 === 0 ? 1 : i % 3 === 1 ? 1.1 : 0.9,
      observedAt: at,
      source: "GMGN_TOKEN_INFO",
    };
    t.pnlPct = i % 3 === 0 ? 0 : i % 3 === 1 ? 10 : -10;
    t.outcome = t.pnlPct === 0 ? "FLAT" : t.pnlPct > 0 ? "WIN" : "LOSS";
    t.mfePct = 15;
    t.maePct = -12;
    for (const g of [
      "CHEAP_FILTER",
      "SECURITY",
      "COMPATIBILITY",
      "HISTORY",
      "CAPITAL_FLOW",
    ])
      t.gates[g] = { status: "PASS", at };
    store.save(t);
  }
}

test("10001 trials persist beyond 201/250/300/1000/10000 without replacing existing history", () => {
  const s = new KronosStore(":memory:");
  try {
    seed(s, 10001);
    assert.equal(s.count(), 10001);
    for (const n of [201, 250, 300, 1000, 10000])
      assert.equal(
        s.db
          .prepare("SELECT count(*) n FROM lab_trials WHERE appearance=?")
          .get("synthetic" + (n - 1))!.n,
        1,
      );
    assert.equal(s.page({ limit: 10000 }).rows.length, 100);
    const first = s.page({ limit: 50 }),
      second = s.page({ limit: 50, cursor: first.nextCursor! });
    assert(!second.rows.some((t) => first.rows.some((x) => x.id === t.id)));
    assert.equal(s.page({ openOnly: true }).rows.length, 0);
  } finally {
    s.close();
  }
});

test("statistics use persisted trial boundaries, separate breakeven and no repeated UI/event inflation", () => {
  const s = new KronosStore(":memory:");
  try {
    seed(s, 3);
    s.event("UI_REFRESH");
    s.event("UI_REFRESH");
    const a = s.summary(),
      b = s.summary();
    assert.deepEqual(a, b);
    assert.equal(a.tokensChecked, 3);
    assert.equal(a.kronosPass, 3);
    assert.equal(a.wins, 1);
    assert.equal(a.losses, 1);
    assert.equal(a.flats, 1);
    assert.equal(a.winRate, 1 / 3);
    assert.equal(a.medianPnlPct, 0);
    assert.equal(a.rolling20, null);
    assert.equal(a.selectionRate, 1);
  } finally {
    s.close();
  }
});

test("decisions and events keep accumulating beyond previous 720/50000 storage caps", () => {
  const s = new KronosStore(":memory:");
  try {
    const t = s.add({
      mint: "storage",
      appearance: "storage",
      discoveredAt: Date.now(),
    })!;
    t.decisionCount = 720;
    s.commitDecision(t, {
      action: "WAIT",
      at: Date.now(),
      inputAt: Date.now(),
      reason: "fixture",
    });
    assert.equal(s.trial(t.id)!.decisionCount, 721);
    s.set("eventCount", 50000);
    s.event("NEW_EVENT", t);
    assert.equal(s.events(t.id).length, 1);
  } finally {
    s.close();
  }
});

test("OPEN monitor prioritized over large candidate backlog without full history decoding", async () => {
  const h = fixture();
  try {
    await h.lab.discover();
    const id = h.store.trials()[0]!.id;
    await h.lab.step(id);
    h.fresh();
    h.set({ price: 1.2 });
    for (let i = 0; i < 300; i++)
      h.store.add({
        mint: "queued" + i,
        appearance: "queued" + i,
        discoveredAt: Date.now(),
      });
    const guard = mock.method(h.store, "trials", () => {
      throw Error("FULL_HISTORY_READ_FORBIDDEN");
    });
    h.market.discover = async () => [];
    h.lab.setEnabled(true);
    await h.lab.tick();
    h.lab.setEnabled(false);
    assert.equal(h.store.trial(id)!.current?.value, 1.2);
    assert.equal(guard.mock.callCount(), 0);
    guard.mock.restore();
    await h.lab.stop();
  } finally {
    h.store.close();
  }
});

test("GMGN 429 cooldown remains in force during unlimited collection", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("{}", { status: 429 });
  };
  try {
    const market = new KronosMarket("fixture-only");
    await assert.rejects(market.discover(), /HTTP_429/);
    await assert.rejects(market.discover(), /COOLDOWN/);
    assert.equal(calls, 1);
    assert.equal(market.status().gmgn.state, "RATE_LIMITED");
    assert.equal(market.status().spacingMs, 3000);
  } finally {
    globalThis.fetch = previous;
  }
});

test("5000-row actual HTTP pages stay bounded; overview does not return all history or calculate full stats", async () => {
  mkdirSync(join(ROOT, "data"), { recursive: true });
  const dir = mkdtempSync(join(ROOT, "data", "test-continuous-"));
  const cfg = runtimeConfig({
    KRONOS_PORT: String(48000 + Math.floor(Math.random() * 1000)),
    KRONOS_DATABASE_PATH: join(dir, "lab.sqlite"),
    KRONOS_RUNTIME: join(dir, "runtime"),
    KRONOS_LOG_DIR: join(dir, "logs"),
  });
  const h = fixture(),
    app = await startKronos(cfg, {
      market: h.market,
      inference: h.inference,
      timer: false,
    });
  try {
    seed(app.store, 5000);
    const base = "http://127.0.0.1:" + cfg.port;
    const guard = mock.method(app.store, "trials", () => {
      throw Error("FULL_HISTORY_READ_FORBIDDEN");
    });
    const started = performance.now();
    const o = await fetch(base + "/api/overview").then((r) => r.json());
    const ms = performance.now() - started;
    assert(o.queue.length <= 8);
    assert(o.positions.rows.length <= 50);
    assert(o.logs.length <= 100);
    assert(JSON.stringify(o).length < 100000);
    const history = await fetch(base + "/api/history?limit=50").then((r) =>
      r.json(),
    );
    assert.equal(history.rows.length, 50);
    assert.equal(history.hasMore, true);
    const second = await fetch(
      base + "/api/history?limit=50&cursor=" + history.nextCursor,
    ).then((r) => r.json());
    assert.notEqual(second.rows[0].id, history.rows[0].id);
    const stats = await fetch(base + "/api/statistics").then((r) => r.json());
    assert.equal(stats.records, 5000);
    assert(stats.distribution.length <= 5);
    assert.equal(guard.mock.callCount(), 0);
    guard.mock.restore();
    const plan = app.store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT payload FROM lab_trials WHERE json_extract(payload,'$.status')='OPEN' LIMIT 50",
      )
      .all();
    assert(JSON.stringify(plan).includes("lab_trials_"));
    writeFileSync(
      join(ROOT, "evidence/continuous-large-data.json"),
      JSON.stringify(
        {
          records: 5000,
          overviewMs: ms,
          overviewBytes: JSON.stringify(o).length,
          historyPage: history.rows.length,
          statsBytes: JSON.stringify(stats).length,
          plan,
        },
        null,
        2,
      ),
    );
  } finally {
    await app.stop();
    h.store.close();
  }
});
