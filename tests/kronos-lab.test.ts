import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VersionedTransaction, Connection } from "@solana/web3.js";
import { Executor } from "../src/executor.js";
import { Engine } from "../src/engine.js";
import { JupiterExecutionProvider } from "../src/execution-provider.js";
import { KronosLab, type LabInference } from "../src/kronos-lab.js";
import { KronosStore } from "../src/kronos-store.js";
import { KronosMarket, type LabMarket } from "../src/kronos-market.js";
import {
  KRONOS,
  validateCandles,
  decideForecast,
  paperFill,
  markPrice,
  validPrice,
  type Forecast,
  type LabCandle,
  type LabTrial,
} from "../src/kronos-domain.js";
import { kronosWorkerEnvironment } from "../src/kronos-worker.js";
import { candidate, info, securityRaw, settings, MINT } from "./fixtures.js";
import { mintFixture } from "./token-program-fixtures.js";
import { TOKEN_PROGRAM_ID } from "../src/token-program.js";
import {
  parseMarketHistory,
  attemptFlow,
  oneShotStructure,
} from "../src/market-history.js";
import { normalizeMarket } from "../src/gmgn.js";
function bars(tail = Math.floor(Date.now() / 60000) * 60000): LabCandle[] {
  return Array.from({ length: 40 }, (_, i) => ({
    at: tail - (40 - i) * 60000,
    open: 1,
    high: 1.02,
    low: 0.98,
    close: 1,
  }));
}
function forecast(rows: LabCandle[], at: number, direction = 1): Forecast {
  const end = rows.at(-1)!.at + 60000;
  return {
    version: "KRONOS_FORECAST_V1",
    commit: KRONOS.commit,
    model: KRONOS.model,
    tokenizer: KRONOS.tokenizer,
    paths: Array.from({ length: 3 }, () =>
      Array.from({ length: 5 }, (_, i) => 1 + direction * (i + 1) * 0.001),
    ),
    forecastAt: Array.from({ length: 5 }, (_, i) => end + i * 60000),
    inputFrom: rows[0]!.at,
    inputTo: end,
    latestClosedCandleAt: end,
    decisionAt: at,
    volumeMode: "PRICE_ONLY_OPTIONAL_CHANNELS_DISABLED",
    priceScale: 1,
    seed: 1701,
    samples: 3,
    temperature: 1,
    topP: 0.9,
    eval: true,
    inferenceMode: true,
    loadMs: 1,
    latencyMs: 1,
    rssBytes: 1,
    limitations: [],
  };
}
function fixture() {
  const store = new KronosStore(":memory:");
  let direction = 1,
    price: number | undefined = 1,
    tail = Math.floor(Date.now() / 60000) * 60000,
    calls = 0,
    fail = false;
  const market: LabMarket = {
    discover: async () => [candidate()],
    prepare: async (_c, stage) => {
      for (const name of [
        "CHEAP_FILTER",
        "SECURITY",
        "COMPATIBILITY",
        "HISTORY",
        "CAPITAL_FLOW",
      ])
        await stage(name, async () => ({ fixture: true }));
      return { candles: bars(tail), evidence: { structureWouldPass: false } };
    },
    history: async () => ({ candles: bars(tail), evidence: {} }),
    price: async () =>
      price === undefined
        ? undefined
        : { value: price, observedAt: Date.now(), source: "GMGN_TOKEN_INFO" },
  };
  const inference: LabInference = {
    forecast: async (rows, at) => {
      calls++;
      if (fail) throw Error("KRONOS_TIMEOUT");
      return forecast(rows, at, direction);
    },
    status: () => ({}),
    stop: () => {},
  };
  const lab = new KronosLab(store, market, inference);
  const fresh = () => {
    const t = store.trials()[0]!;
    delete t.lastInputTo;
    store.save(t);
  };
  return {
    store,
    market,
    inference,
    lab,
    fresh,
    set: (v: {
      direction?: number;
      price?: number | null;
      fail?: boolean;
      tail?: number;
    }) => {
      direction = v.direction ?? direction;
      price = v.price === null ? undefined : (v.price ?? price);
      fail = v.fail ?? fail;
      tail = v.tail ?? tail;
    },
    calls: () => calls,
  };
}

test("Kronos lifecycle PAPER BUY→HOLD→SELL invokes zero production capabilities; Structure V3 is not a gate", async () => {
  const guards = [
    mock.method(Executor.prototype, "execute", () => {
      throw Error("EXECUTOR_FORBIDDEN");
    }),
    mock.method(JupiterExecutionProvider.prototype, "execute", () => {
      throw Error("JUPITER_FORBIDDEN");
    }),
    mock.method(VersionedTransaction.prototype, "sign", () => {
      throw Error("SIGN_FORBIDDEN");
    }),
    mock.method(Connection.prototype, "sendTransaction", () => {
      throw Error("SUBMIT_FORBIDDEN");
    }),
    mock.method(Engine.prototype, "analyze", () => {
      throw Error("PRODUCTION_BUY_FORBIDDEN");
    }),
    mock.method(Engine.prototype, "processExits", () => {
      throw Error("PRODUCTION_SELL_FORBIDDEN");
    }),
  ];
  const h = fixture();
  try {
    const rows = bars(),
      c = { ...candidate(), createdAt: Date.now() - 50 * 60000 };
    const history = parseMarketHistory(
      {
        list: rows.map((x) => ({ ...x, time: x.at, volume: 1000 })),
        _gmgnSnapshot: { fetchedAt: Date.now() },
      },
      c,
    );
    const market = normalizeMarket(info()),
      flow = attemptFlow(
        c,
        market,
        info(),
        history,
        settings.flowMeaningfulChangePercent,
      );
    assert.equal(
      oneShotStructure(history, flow, market).passed,
      false,
      "Actual production Structure V3 rejects flat bars",
    );
    await h.lab.discover();
    const id = h.store.trials()[0]!.id;
    await h.lab.step(id);
    let t = h.store.trials()[0]!;
    assert.equal((t as LabTrial).entry?.value, 1);
    assert.equal(t.status, "OPEN");
    assert.equal(
      t.evidence && "structureWouldPass" in (t.evidence as object),
      true,
    );
    h.fresh();
    h.set({ direction: 0, price: 0.9 });
    await h.lab.step(id);
    t = h.store.trials()[0]!;
    assert.equal(t.status, "OPEN");
    assert.equal(t.latest?.action, "HOLD");
    assert.equal(t.exit, undefined);
    assert.equal(t.entry?.value, 1);
    h.fresh();
    h.set({ direction: -1, price: 1.1 });
    await h.lab.step(id);
    t = h.store.trials()[0]!;
    assert.equal(t.status, "CLOSED");
    assert(Math.abs(t.pnlPct! - 10) < 1e-8);
    assert.equal(t.outcome, "WIN");
    assert.equal(h.store.decisions(id).length, 3);
    for (const g of guards) assert.equal(g.mock.callCount(), 0);
  } finally {
    h.store.close();
    for (const g of guards) g.mock.restore();
  }
});
test("300 record cap counts rejects/errors, never evicts; duplicate active mint and repeated appearance rejected", () => {
  const db = new KronosStore(":memory:");
  try {
    for (let i = 0; i < 310; i++) {
      const t = db.add({
        mint: "mint" + i,
        appearance: "a" + i,
        discoveredAt: Date.now(),
      });
      if (t && i % 2) {
        t.status = i % 3 ? "REJECTED" : "ERROR";
        db.save(t);
      }
    }
    assert.equal(db.trials().length, 300);
    assert.equal(db.summary().limit, 300);
    assert.equal(
      db.add({
        mint: "overflow",
        appearance: "overflow",
        discoveredAt: Date.now(),
      }),
      undefined,
    );
    assert.equal(
      db.add({ mint: "mint0", appearance: "new", discoveredAt: Date.now() }),
      undefined,
    );
    assert.throws(() => db.reset("yes"), /CONFIRMATION/);
    db.reset("RESET KRONOS PAPER EXPERIMENT");
    assert.equal(db.trials().length, 0);
    const t = db.add({
      mint: "same",
      appearance: "a",
      discoveredAt: Date.now(),
    })!;
    assert.equal(
      db.add({ mint: "same", appearance: "b", discoveredAt: Date.now() }),
      undefined,
    );
    t.status = "CLOSED";
    db.save(t);
    assert.equal(
      db.add({ mint: "same", appearance: "a", discoveredAt: Date.now() }),
      undefined,
    );
    assert(db.add({ mint: "same", appearance: "b", discoveredAt: Date.now() }));
  } finally {
    db.close();
  }
});
test("trials 51–300 run unchanged paper gates; preserve first 50, deduplicate, monitor OPEN at full cap without rediscovery or real trading", async () => {
  const guards = [
    mock.method(Executor.prototype, "execute", () => {
      throw Error("EXECUTOR_FORBIDDEN");
    }),
    mock.method(JupiterExecutionProvider.prototype, "execute", () => {
      throw Error("JUPITER_FORBIDDEN");
    }),
    mock.method(VersionedTransaction.prototype, "sign", () => {
      throw Error("SIGN_FORBIDDEN");
    }),
    mock.method(Connection.prototype, "sendTransaction", () => {
      throw Error("SUBMIT_FORBIDDEN");
    }),
    mock.method(Engine.prototype, "analyze", () => {
      throw Error("PRODUCTION_BUY_FORBIDDEN");
    }),
    mock.method(Engine.prototype, "processExits", () => {
      throw Error("PRODUCTION_SELL_FORBIDDEN");
    }),
  ];
  const h = fixture();
  try {
    const now = Date.now();
    for (let i = 0; i < 50; i++) {
      const t = h.store.add({
        mint: "old" + i,
        appearance: "old" + i,
        discoveredAt: now,
      })!;
      if (i < 2) {
        paperFill(
          t,
          { at: now, inputAt: now, action: "PAPER_BUY", reason: "fixture" },
          { value: 1, observedAt: now, source: "GMGN_TOKEN_INFO" },
          now,
        );
        if (i === 1)
          paperFill(
            t,
            { at: now, inputAt: now, action: "PAPER_SELL", reason: "fixture" },
            { value: 1.1, observedAt: now, source: "GMGN_TOKEN_INFO" },
            now,
          );
      } else t.status = "REJECTED";
      h.store.save(t);
    }
    const oldRows = h.store.db
      .prepare("SELECT * FROM lab_trials ORDER BY rowid")
      .all();
    let discoveryCalls = 0;
    for (let start = 50; start < 300; start += 50) {
      const rows = Array.from({ length: 50 }, (_, i) => ({
        ...candidate(),
        mint: "new" + (start + i),
      }));
      h.market.discover = async () => {
        discoveryCalls++;
        return rows;
      };
      await h.lab.discover();
      await h.lab.discover();
      assert.equal(
        h.store.trials().length,
        start + 50,
        "same appearances never duplicate",
      );
    }
    assert.deepEqual(
      h.store.db
        .prepare("SELECT * FROM lab_trials ORDER BY rowid LIMIT 50")
        .all(),
      oldRows,
    );
    for (const t of h.store.trials().slice(50)) {
      await h.lab.step(t.id);
      const processed = h.store.trials().find((x) => x.id === t.id)!;
      assert.equal(processed.status, "OPEN");
      assert.equal(processed.latest?.action, "PAPER_BUY");
      assert.equal(processed.entry?.value, 1);
      assert.deepEqual(Object.keys(processed.gates), [
        "CHEAP_FILTER",
        "SECURITY",
        "COMPATIBILITY",
        "HISTORY",
        "CAPITAL_FLOW",
      ]);
      assert(Object.values(processed.gates).every((g) => g.status === "PASS"));
    }
    assert.equal(h.calls(), 250);
    assert.deepEqual(
      h.store.db
        .prepare("SELECT * FROM lab_trials ORDER BY rowid LIMIT 50")
        .all(),
      oldRows,
    );
    h.market.discover = async () => {
      discoveryCalls++;
      return [{ ...candidate(), mint: "overflow" }];
    };
    await h.lab.discover();
    assert.equal(h.store.trials().length, 300);
    assert.deepEqual(
      h.store.db
        .prepare("SELECT * FROM lab_trials ORDER BY rowid LIMIT 50")
        .all(),
      oldRows,
    );
    const open = h.store.trials()[0]!;
    for (const t of h.store.trials()) {
      t.nextAt = t.id === open.id ? 0 : Date.now() + 600000;
      h.store.save(t);
    }
    const discoveriesBeforeTick = discoveryCalls;
    h.set({ price: 1.2 });
    h.lab.setEnabled(true);
    await h.lab.tick();
    h.lab.setEnabled(false);
    const monitored = h.store.trials()[0]!;
    assert.equal(monitored.status, "OPEN");
    assert.deepEqual(monitored.entry, open.entry);
    assert.equal(monitored.current?.value, 1.2);
    assert(Math.abs(monitored.pnlPct! - 20) < 1e-8);
    assert.equal(
      discoveryCalls,
      discoveriesBeforeTick,
      "full cap stops discovery, not monitoring",
    );
    assert.equal(h.lab.status().summary.limit, 300);
    assert.equal(h.lab.status().concurrency, 1);
    for (const g of guards) assert.equal(g.mock.callCount(), 0);
  } finally {
    h.store.close();
    for (const g of guards) g.mock.restore();
  }
});

test("reopen existing 50 persisted trial rows and decisions, extend to 300 without rewriting original history", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "kronos-cap-300-")),
    "lab.sqlite",
  );
  let db = new KronosStore(path);
  try {
    for (let i = 0; i < 50; i++) {
      const t = db.add({
        mint: "persisted" + i,
        appearance: "persisted" + i,
        discoveredAt: Date.now(),
      })!;
      t.status = i % 2 ? "ERROR" : "REJECTED";
      db.commitDecision(t, {
        action: "UNAVAILABLE",
        reason: "old fixture",
        at: Date.now(),
        inputAt: Date.now(),
      });
    }
    const original = db.db
      .prepare("SELECT * FROM lab_trials ORDER BY rowid")
      .all();
    const decisions = db.db
      .prepare("SELECT * FROM lab_decisions ORDER BY id")
      .all();
    db.close();
    db = new KronosStore(path);
    for (let i = 50; i < 300; i++)
      assert(
        db.add({
          mint: "persisted" + i,
          appearance: "persisted" + i,
          discoveredAt: Date.now(),
        }),
      );
    assert.equal(
      db.add({ mint: "301", appearance: "301", discoveredAt: Date.now() }),
      undefined,
    );
    db.close();
    db = new KronosStore(path);
    assert.equal(db.trials().length, 300);
    assert.deepEqual(
      db.db.prepare("SELECT * FROM lab_trials ORDER BY rowid LIMIT 50").all(),
      original,
    );
    assert.deepEqual(
      db.db.prepare("SELECT * FROM lab_decisions ORDER BY id").all(),
      decisions,
    );
  } finally {
    db.close();
  }
});

test("security gate failure creates reject, no inference or paper BUY", async () => {
  const h = fixture();
  try {
    h.market.prepare = async (_c, stage) => {
      await stage("SECURITY", async () => {
        throw Error("HONEYPOT_REPORTED");
      });
      throw Error("unreachable");
    };
    await h.lab.discover();
    await h.lab.step(h.store.trials()[0]!.id);
    assert.equal(h.store.trials()[0]!.status, "REJECTED");
    assert.equal(h.calls(), 0);
    assert.equal(h.store.summary().paperBuys, 0);
  } finally {
    h.store.close();
  }
});
test("native model is forecast, transparent policy requires unanimous terminal direction; disagreement not an opaque score", () => {
  const rows = bars(),
    at = Date.now(),
    f = forecast(rows, at);
  assert.equal(decideForecast(f, rows, false, at).action, "PAPER_BUY");
  assert.equal(decideForecast(f, rows, true, at).action, "HOLD");
  f.paths[0] = Array(5).fill(0.99);
  assert.equal(decideForecast(f, rows, false, at).action, "WAIT");
  assert.equal(decideForecast(f, rows, true, at).action, "HOLD");
  assert.equal(
    decideForecast(forecast(rows, at, -1), rows, true, at).action,
    "PAPER_SELL",
  );
});
test("input rejects future/partial/gapped/duplicate/unordered/NaN/nonpositive/short candles and mismatched model output", () => {
  const rows = bars(),
    at = Date.now();
  for (const modify of [
    (a: LabCandle[]) =>
      a.push({ ...a.at(-1)!, at: Math.floor(at / 60000) * 60000 }),
    (a: LabCandle[]) => (a[3]!.at += 1),
    (a: LabCandle[]) => (a[3]!.close = NaN),
    (a: LabCandle[]) => (a[3]!.low = 0),
    (a: LabCandle[]) => a.reverse(),
    (a: LabCandle[]) => a.splice(2, 1),
  ]) {
    const changed = structuredClone(rows);
    modify(changed);
    assert.throws(() => validateCandles(changed, at));
  }
  assert.throws(() => validateCandles(rows.slice(-10), at));
  assert.throws(() =>
    decideForecast(
      { ...forecast(rows, at), model: { id: "fake", revision: "HEAD" } },
      rows,
      false,
      at,
    ),
  );
});
test("model failure does not fabricate entry or exit; negative PnL does not override forecast HOLD", async () => {
  for (const open of [false, true]) {
    const h = fixture();
    try {
      await h.lab.discover();
      const id = h.store.trials()[0]!.id;
      if (open) await h.lab.step(id);
      h.fresh();
      h.set({ fail: true, price: 0.8 });
      await h.lab.step(id);
      const t = h.store.trials()[0]!;
      assert.equal(t.latest?.action, "UNAVAILABLE");
      assert.equal(t.exit, undefined);
      assert.equal(t.status, open ? "OPEN" : "ERROR");
      assert.equal(!!t.entry, open);
    } finally {
      h.store.close();
    }
  }
});
test("entry/exit require post-decision price; missing/stale/future prices cannot fill; price returns and MFE/MAE have no fake fees", async () => {
  const h = fixture();
  try {
    await h.lab.discover();
    const t = h.store.trials()[0]!,
      at = Date.now(),
      buy = {
        at,
        inputAt: at,
        action: "PAPER_BUY" as const,
        reason: "fixture",
      };
    paperFill(
      t,
      buy,
      { value: 1, observedAt: at - 1, source: "GMGN_TOKEN_INFO" },
      at,
    );
    assert.equal(t.entry, undefined);
    paperFill(
      t,
      buy,
      { value: 1, observedAt: at, source: "GMGN_TOKEN_INFO" },
      at,
    );
    assert.equal((t as LabTrial).entry?.value, 1);
    markPrice(t, { value: 1.2, observedAt: at, source: "GMGN_TOKEN_INFO" }, at);
    paperFill(t, { ...buy, action: "PAPER_SELL" }, undefined, at);
    assert.equal(t.status, "SELL_DECIDED_PRICE_PENDING");
    assert.equal(t.exit, undefined);
    paperFill(
      t,
      { ...buy, action: "PAPER_SELL" },
      { value: 0.8, observedAt: at, source: "GMGN_TOKEN_INFO" },
      at,
    );
    assert.equal(t.outcome, "LOSS");
    assert(Math.abs(t.pnlPct! + 20) < 1e-8);
    assert(Math.abs(t.mfePct! - 20) < 1e-8);
    assert(Math.abs(t.maePct! + 20) < 1e-8);
    assert.equal(
      validPrice(
        { value: 1, observedAt: at + 1, source: "GMGN_TOKEN_INFO" },
        at,
      ),
      false,
    );
    assert.equal(
      validPrice(
        { value: 1, observedAt: at - 45001, source: "GMGN_TOKEN_INFO" },
        at,
      ),
      false,
    );
  } finally {
    h.store.close();
  }
});
test("unavailable entry is retained as error; pending sell retries observable price without a second forecast", async () => {
  const h = fixture();
  try {
    await h.lab.discover();
    const id = h.store.trials()[0]!.id;
    await h.lab.step(id);
    h.fresh();
    h.set({ direction: -1, price: null });
    await h.lab.step(id);
    assert.equal(h.store.trials()[0]!.status, "SELL_DECIDED_PRICE_PENDING");
    const count = h.calls();
    h.set({ price: 1.1 });
    await h.lab.step(id);
    assert.equal(h.store.trials()[0]!.status, "CLOSED");
    assert.equal(h.calls(), count);
  } finally {
    h.store.close();
  }
});
test("restart preserves entry and closed records without duplicate paper BUY; reset is isolated and confirmation required", async () => {
  const h = fixture(),
    directory = mkdtempSync(join(tmpdir(), "kronos-restart-")),
    path = join(directory, "lab.sqlite");
  try {
    await h.lab.discover();
    await h.lab.step(h.store.trials()[0]!.id);
    const original = h.store.trials()[0]!;
    let db = new KronosStore(path);
    db.db
      .prepare("INSERT INTO lab_trials VALUES(?,?,?,?)")
      .run(
        original.id,
        original.mint,
        original.appearance,
        JSON.stringify(original),
      );
    db.close();
    db = new KronosStore(path);
    const resumed = new KronosLab(db, h.market, h.inference);
    await resumed.discover();
    assert.equal(db.trials().length, 1);
    await resumed.step(original.id);
    assert.deepEqual(db.trials()[0]!.entry, original.entry);
    assert.equal(db.trials()[0]!.status, "OPEN");
    assert.throws(() => resumed.reset("no"), /CONFIRMATION/);
    db.close();
  } finally {
    h.store.close();
  }
});
test("300 jobs are bounded to one active model call, event loop remains responsive, duplicate current-candle inference skipped", async () => {
  const h = fixture();
  try {
    for (let i = 0; i < 300; i++)
      h.store.add({
        mint: "m" + i,
        appearance: "a" + i,
        discoveredAt: Date.now(),
      });
    let release!: () => void,
      active = 0,
      maximum = 0;
    h.inference.forecast = async (rows, at) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((r) => (release = r));
      active--;
      return forecast(rows, at);
    };
    h.lab.setEnabled(true);
    const first = h.lab.tick();
    for (let i = 0; i < 100 && !release; i++)
      await new Promise((r) => setTimeout(r, 1));
    await Promise.all(Array.from({ length: 300 }, () => h.lab.tick()));
    let heartbeat = false;
    await new Promise<void>((r) =>
      setImmediate(() => {
        heartbeat = true;
        r();
      }),
    );
    assert(heartbeat);
    assert.equal(maximum, 1);
    release();
    await first;
    assert.equal(h.store.trials().length, 300);
    h.lab.setEnabled(false);
  } finally {
    h.store.close();
  }
});
test("child environment contains no BOT/GMGN/JEV/wallet secrets, no PATH/PYTHONPATH forwarding; pins match manifest", () => {
  const e = kronosWorkerEnvironment(join(tmpdir(), "kronos-env"));
  for (const name of Object.keys(e))
    assert(
      name === "PYTHONHASHSEED" ||
        !/PRIVATE|MNEMONIC|SEED|WALLET|API_KEY|GMGN|JEV|JUPITER|SOLANA|PATH$/.test(
          name,
        ),
      name,
    );
  assert.equal(e.HF_HUB_OFFLINE, "1");
  const pins = JSON.parse(readFileSync("lab/kronos/pins.json", "utf8"));
  assert.equal(pins.commit, KRONOS.commit);
  assert.deepEqual(pins.model, KRONOS.model);
  assert.deepEqual(pins.tokenizer, KRONOS.tokenizer);
});
test("real reusable pre-Kronos gates: fresh security + RPC mint compatibility + history + flow; critical token stops before inference", async () => {
  const previous = globalThis.fetch;
  let critical = false,
    legacySettings = false;
  const calls: string[] = [];
  const rows = bars();
  globalThis.fetch = async (input, init) => {
    const u = new URL(String(input));
    calls.push(u.pathname);
    let result: unknown;
    if (u.pathname === "/api/kronos/settings") {
      if (legacySettings)
        return new Response(JSON.stringify({ error: "NOT_FOUND" }), {
          status: 404,
        });
      result = settings;
    } else if (u.pathname === "/api/status") result = { settings };
    else if (u.pathname === "/v1/token/info")
      result = { code: 0, data: { ...info(), address: MINT } };
    else if (u.pathname === "/v1/token/security")
      result = { code: 0, data: { ...securityRaw, is_honeypot: critical } };
    else if (u.pathname === "/v1/market/token_kline")
      result = {
        code: 0,
        data: { list: rows.map((c) => ({ ...c, time: c.at, volume: 1000 })) },
      };
    else {
      const rpc = JSON.parse(String(init?.body));
      assert.equal(rpc.method, "getAccountInfo");
      const m = mintFixture(TOKEN_PROGRAM_ID);
      result = {
        result: {
          value: {
            owner: m.owner.toBase58(),
            data: [m.data.toString("base64"), "base64"],
            lamports: m.lamports,
            executable: false,
            rentEpoch: 0,
          },
        },
      };
    }
    return new Response(JSON.stringify(result), { status: 200 });
  };
  try {
    const market = new KronosMarket("fixture-only", "http://127.0.0.1/rpc");
    Object.defineProperty(market, "next", { get: () => 0, set: () => {} });
    const gates: string[] = [];
    const run = async (n: string, w: () => Promise<unknown>) => {
      gates.push(n);
      return w();
    };
    const c = { ...candidate(), createdAt: Date.now() - 50 * 60000 };
    const out = await market.prepare(c, run);
    assert.equal(out.candles.length, 40);
    assert.deepEqual(gates, [
      "CHEAP_FILTER",
      "SECURITY",
      "COMPATIBILITY",
      "HISTORY",
      "CAPITAL_FLOW",
    ]);
    assert(calls.every((p) => !p.includes("trade") && !p.includes("swap")));
    legacySettings = true;
    await market.prepare(c, run);
    assert(
      calls.includes("/api/status"),
      "Older BOT settings fallback is read-only",
    );
    critical = true;
    gates.length = 0;
    await assert.rejects(market.prepare(c, run), /SECURITY_REJECT/);
    assert.deepEqual(gates, ["CHEAP_FILTER", "SECURITY"]);
  } finally {
    globalThis.fetch = previous;
  }
});

test("Lab reuses fresh discovery; stale BOT backpressure gets only one bounded GMGN Trending snapshot", async () => {
  const previous = globalThis.fetch;
  let fresh = true,
    rankCalls = 0;
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    if (u.pathname === "/api/tokens")
      return new Response(JSON.stringify(fresh ? [candidate()] : []));
    assert.equal(u.pathname, "/v1/market/rank");
    assert.equal(u.searchParams.get("limit"), "50");
    assert.equal(u.searchParams.get("order_by"), "volume");
    rankCalls++;
    return new Response(
      JSON.stringify({
        code: 0,
        data: {
          rank: Array.from({ length: 60 }, () => ({
            address: MINT,
            symbol: "FIXTURE",
          })),
        },
      }),
    );
  };
  try {
    const market = new KronosMarket("fixture-only");
    assert.equal((await market.discover()).length, 1);
    assert.equal(rankCalls, 0);
    fresh = false;
    assert.equal((await market.discover()).length, 50);
    assert.equal(rankCalls, 1);
  } finally {
    globalThis.fetch = previous;
  }
});
