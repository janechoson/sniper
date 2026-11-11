import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../src/config.js";
import type { Position, TradingMode } from "../src/domain.js";
import { ModeManager } from "../src/mode-manager.js";
import { Store } from "../src/store.js";
class FakeEngine {
  running = false;
  constructor(
    readonly mode: TradingMode,
    readonly observed: string[],
  ) {}
  async start() {
    this.observed.push("start:" + this.mode);
    this.running = true;
  }
  async stop() {
    this.observed.push("stop:" + this.mode);
    this.running = false;
  }
}
test("safe stop restores LIVE monitoring when an accepted BUY settles during shutdown", async () => {
  const store = new Store(":memory:"),
    events: string[] = [];
  let settle = false;
  const manager = new ModeManager(
    store,
    (mode) => {
      const engine = new FakeEngine(mode, events),
        stop = engine.stop.bind(engine);
      engine.stop = async () => {
        await stop();
        if (settle) {
          settle = false;
          store.savePosition({
            id: "late-fill",
            mode: "live",
            strategy: "KRONOS",
            mint: "mint",
            state: "OPEN",
            quantity: "1",
          } as Position);
        }
      };
      return engine;
    },
    async () => {},
  );
  try {
    await manager.switch("LIVE", "START LIVE");
    settle = true;
    await assert.rejects(
      manager.stopSafely(),
      /LIVE_POSITION_REQUIRES_MONITORING/,
    );
    assert.equal(manager.engine!.running, true);
    assert.equal(manager.status().recoveryOnly, true);
    assert.equal(store.entriesEnabled(), false);
  } finally {
    await manager.stop();
    store.close();
  }
});
test("factory failure releases the session so a corrected startup can retry", async () => {
  const store = new Store(":memory:"),
    events: string[] = [];
  let fail = true;
  const manager = new ModeManager(
    store,
    (mode) => {
      if (fail) throw Error("FIXTURE_FACTORY_FAILURE");
      return new FakeEngine(mode, events);
    },
    async () => {},
  );
  try {
    await assert.rejects(manager.startDefault(), /FACTORY_FAILURE/);
    fail = false;
    await manager.startDefault();
    assert.equal(manager.engine!.running, true);
  } finally {
    await manager.stop();
    store.close();
  }
});
function fixture() {
  const store = new Store(":memory:"),
    events: string[] = [];
  const manager = new ModeManager(
    store,
    (m) => new FakeEngine(m, events),
    async () => {
      events.push("verify:LIVE");
    },
  );
  return { store, events, manager };
}
test("defaults to DEMO even with legacy LIVE environment and funds only once through switches", async () => {
  env.TRADING_MODE = "live";
  const f = fixture();
  try {
    await f.manager.startDefault();
    const id = f.store.db.prepare("SELECT id FROM demo_accounts").get()!.id;
    await assert.rejects(f.manager.switch("LIVE"), /CONFIRMATION/);
    await f.manager.switch("LIVE", "START LIVE");
    await f.manager.switch("DEMO");
    assert.equal(
      f.store.db.prepare("SELECT id FROM demo_accounts").get()!.id,
      id,
    );
    assert.deepEqual(f.events, [
      "start:DEMO",
      "stop:DEMO",
      "verify:LIVE",
      "start:LIVE",
      "stop:LIVE",
      "start:DEMO",
    ]);
    await f.manager.stop();
  } finally {
    f.store.close();
  }
});
test("simultaneous requests serialize; same-mode start cannot duplicate engine", async () => {
  const f = fixture();
  try {
    await Promise.all([
      f.manager.switch("DEMO"),
      f.manager.switch("LIVE", "START LIVE"),
      f.manager.switch("LIVE", "START LIVE"),
    ]);
    assert.equal(f.events.filter((s) => s === "start:LIVE").length, 1);
    assert.equal(f.manager.status().mode, "LIVE");
    await f.manager.stop();
  } finally {
    f.store.close();
  }
});
test("LIVE positions, pending exits and UNKNOWN executions block switch and preserve monitoring", async () => {
  const f = fixture();
  try {
    await f.manager.switch("LIVE", "START LIVE");
    f.store.savePosition({
      id: "live-p",
      mode: "live",
      strategy: "KRONOS",
      mint: "mint",
      state: "OPEN",
      quantity: "1",
    } as Position);
    await assert.rejects(
      f.manager.switch("DEMO"),
      /LIVE_POSITION_REQUIRES_MONITORING/,
    );
    assert.equal(f.manager.engine!.running, true);
    assert.equal(env.TRADING_MODE, "live");
    const p = f.store.positions("live")[0]!;
    p.state = "CLOSED";
    p.quantity = "0";
    f.store.savePosition(p);
    f.store.db
      .prepare("INSERT INTO executions VALUES('e','i','UNKNOWN','sig',?)")
      .run(
        JSON.stringify({
          id: "e",
          state: "UNKNOWN",
          signature: "sig",
          intent: { mode: "live", strategy: "KRONOS" },
        }),
      );
    await assert.rejects(f.manager.switch("DEMO"), /RECONCILIATION/);
    assert.equal(f.manager.engine!.running, true);
    f.store.db.exec("DELETE FROM executions");
    await f.manager.stop();
  } finally {
    f.store.close();
  }
});
test("persisted LIVE never restarts real trading without fresh confirmation", async () => {
  const f = fixture();
  try {
    await f.manager.switch("LIVE", "START LIVE");
    await f.manager.stop();
    const resumed = new ModeManager(
      f.store,
      (m) => new FakeEngine(m, f.events),
      async () => {},
    );
    await resumed.startDefault();
    assert.equal(resumed.engine, undefined);
    assert.equal(resumed.status().liveConfirmationRequired, true);
  } finally {
    f.store.close();
  }
});
test("another session/process cannot start and stale sessions require a dead PID", async () => {
  const f = fixture();
  try {
    await f.manager.startDefault();
    const other = new ModeManager(
      f.store,
      (m) => new FakeEngine(m, f.events),
      async () => {},
    );
    await assert.rejects(other.switch("DEMO"), /ALREADY_ACTIVE/);
    await f.manager.stop();
    f.store.db
      .prepare("UPDATE engine_sessions SET state='RUNNING',pid=999999")
      .run();
    const recovered = new ModeManager(
      f.store,
      (m) => new FakeEngine(m, f.events),
      async () => {},
      async () => {},
      () => false,
    );
    await recovered.startDefault();
    assert.equal(recovered.engine!.running, true);
    await recovered.stop();
  } finally {
    f.store.close();
  }
});
test("reset requires a stopped engine and preserves archived DEMO data", async () => {
  const f = fixture();
  try {
    await f.manager.startDefault();
    await assert.rejects(f.manager.resetDemo("RESET DEMO"), /STOPPED/);
    await f.manager.stop();
    await assert.rejects(f.manager.resetDemo("yes"), /CONFIRMATION/);
    await f.manager.resetDemo("RESET DEMO");
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM demo_accounts").get()!.n,
      2,
    );
  } finally {
    f.store.close();
  }
});
test("startup with real holdings recovers LIVE monitoring with entries disabled instead of starting DEMO", async () => {
  const f = fixture();
  try {
    f.store.savePosition({
      id: "p",
      mode: "live",
      strategy: "KRONOS",
      mint: "mint",
      state: "OPEN",
      quantity: "1",
    } as Position);
    const status = await f.manager.startDefault();
    assert.equal(status.mode, "LIVE");
    assert.equal(status.recoveryOnly, true);
    assert.equal(f.store.get("newEntriesEnabled"), false);
    assert.equal(f.events.includes("verify:LIVE"), false);
    await assert.rejects(f.manager.switch("DEMO"), /REQUIRES_MONITORING/);
    await f.manager.stop();
  } finally {
    f.store.close();
  }
});

test("legacy USD rejection releases session ownership without funding SOL", async () => {
  env.TRADING_MODE = "demo";
  const f = fixture();
  try {
    f.store.db
      .prepare(
        "UPDATE demo_account_units SET currency='USD',atomic_decimals=12",
      )
      .run();
    await assert.rejects(
      f.manager.startDefault(),
      /LEGACY_CURRENCY_REQUIRES_RESET/,
    );
    assert.equal(
      f.store.db.prepare("SELECT state FROM engine_sessions").get()!.state,
      "STOPPED",
    );
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM demo_ledger WHERE kind='FUNDING'")
        .get()!.n,
      1,
    );
  } finally {
    await f.manager.stop();
    f.store.close();
  }
});
