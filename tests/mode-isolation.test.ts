import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../src/config.js";
import { dashboardLogs } from "../src/dashboard-view.js";
import { DemoLedger } from "../src/demo-ledger.js";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import { candidate, position, provider } from "./fixtures.js";
import { fakeKronos, fixtureQuotes, fixtureRpc } from "./kronos-fixtures.js";

test("history, statistics, evidence and discovery isolate modes and reset generations while preserving LIVE payloads", async () => {
  const saved = env.TRADING_MODE;
  env.TRADING_MODE = "demo";
  const store = new Store(":memory:");
  const engine = new Engine(store, {
    gmgn: provider().gmgn,
    kronos: fakeKronos(),
    rpc: fixtureRpc(),
    demoQuotes: fixtureQuotes(),
  });
  try {
    store.discover(candidate());
    store.record("security_results", candidate().mint, { source: "DEMO" });
    store.record("events", candidate().mint, { type: "DEMO_ONLY" });
    store.savePosition({
      ...position(),
      id: "demo-only",
      mode: "demo",
      strategy: "KRONOS",
      state: "CLOSED",
      quantity: "0",
    });
    const demoId = store.demoAccountId();
    env.TRADING_MODE = "live";
    assert.equal(store.tokenCount(), 0);
    assert.equal(store.count("security_results"), 0);
    assert.equal(store.latest("security_results", candidate().mint), undefined);
    assert.equal(dashboardLogs(engine, 100).events.length, 0);
    store.discover(candidate());
    store.record("security_results", candidate().mint, { source: "LIVE" });
    store.savePosition({
      ...position(),
      id: "live-only",
      mode: "live",
      strategy: "KRONOS",
      state: "CLOSED",
      quantity: "0",
    });
    const livePayload = store.db
      .prepare("SELECT payload FROM positions WHERE id='live-only'")
      .get()!.payload;
    assert.equal(engine.analytics().closed, 1);
    assert.equal(store.history("live")[0]!.id, "live-only");
    env.TRADING_MODE = "demo";
    assert.equal(store.history("demo")[0]!.id, "demo-only");
    assert.equal(engine.analytics().closed, 1);
    assert.equal(
      store.latest<{ source: string }>("security_results", candidate().mint)!
        .source,
      "DEMO",
    );
    assert.ok(
      dashboardLogs(engine, 100).events.some(
        (e) => e.payload.type === "DEMO_ONLY",
      ),
    );
    new DemoLedger(store.db).reset("RESET DEMO");
    assert.notEqual(store.demoAccountId(), demoId);
    assert.equal(store.history("demo").length, 0);
    assert.equal(engine.analytics().closed, 0);
    assert.equal(store.count("security_results"), 0);
    assert.equal(store.tokenCount(), 0);
    assert.equal(store.latest("security_results", candidate().mint), undefined);
    assert.equal(
      store.db
        .prepare("SELECT payload FROM positions WHERE id='live-only'")
        .get()!.payload,
      livePayload,
    );
    assert.equal(
      store.db
        .prepare("SELECT count(*) n FROM positions WHERE id='demo-only'")
        .get()!.n,
      1,
    );
    env.TRADING_MODE = "live";
    assert.equal(store.count("security_results"), 1);
    assert.equal(store.tokenCount(), 1);
  } finally {
    env.TRADING_MODE = "demo";
    await engine.stop();
    store.close();
    env.TRADING_MODE = saved;
  }
});
