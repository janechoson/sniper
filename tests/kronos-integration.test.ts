import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Intent, Position, Strategy } from "../src/domain.js";
import { Engine } from "../src/engine.js";
import { evaluateExitSafety } from "../src/exit-safety.js";
import { normalizeMarket } from "../src/gmgn.js";
import {
  KRONOS,
  decideForecast,
  type Forecast,
  type LabCandle,
} from "../src/kronos-domain.js";
import {
  KronosStrategy,
  type KronosInference,
} from "../src/kronos-strategy.js";
import {
  kronosWorkerEnvironment,
  kronosWorkerErrorCode,
} from "../src/kronos-worker.js";
import { parseMarketHistory } from "../src/market-history.js";
import { positionViews } from "../src/position-view.js";
import { RiskEngine } from "../src/risk.js";
import { Store } from "../src/store.js";
import { assertStrategySell } from "../src/strategy-authority.js";
import {
  MINT,
  info,
  position,
  provider,
  settings,
  snapshot,
} from "./fixtures.js";
import {
  bindFixtureClaim,
  fixtureQuotes,
  fixtureRpc,
  fundFixtureHolding,
} from "./kronos-fixtures.js";
import {
  candles,
  mockExecutionCase,
  recentCandidate,
} from "./one-shot-fixtures.js";

function bars(): LabCandle[] {
  const end = Math.floor(Date.now() / 60000) * 60000;
  return Array.from({ length: 40 }, (_, i) => ({
    at: end - (40 - i) * 60000,
    open: 1,
    high: 1.02,
    low: 0.98,
    close: 1,
  }));
}
function forecast(
  rows: LabCandle[],
  at: number,
  ends = [1.01, 1.02, 1.03],
): Forecast {
  const end = rows.at(-1)!.at + 60000,
    last = rows.at(-1)!.close;
  return {
    version: "KRONOS_FORECAST_V1",
    commit: KRONOS.commit,
    model: KRONOS.model,
    tokenizer: KRONOS.tokenizer,
    paths: ends.map((e) => Array.from({ length: 5 }, () => e * last)),
    forecastAt: Array.from({ length: 5 }, (_, i) => end + i * 60000),
    inputFrom: rows[0]!.at,
    inputTo: end,
    latestClosedCandleAt: end,
    decisionAt: at,
    volumeMode: "PRICE_ONLY_OPTIONAL_CHANNELS_DISABLED",
    priceScale: last,
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
function strategy(ends = [1.01, 1.02, 1.03]) {
  let calls = 0,
    fail = false;
  const inputs: LabCandle[][] = [];
  const inference: KronosInference = {
    forecast: async (rows, at) => {
      calls++;
      inputs.push(rows);
      if (fail) throw Error("sensitive-provider-error");
      return forecast(rows, at, ends);
    },
    stop() {},
    status() {
      return {};
    },
  };
  return {
    model: new KronosStrategy(inference),
    inputs,
    calls: () => calls,
    fail(v: boolean) {
      fail = v;
    },
  };
}
function sell(p: Position): Intent {
  return {
    id: randomUUID(),
    key: randomUUID(),
    provider: "JUPITER",
    mode: p.mode,
    mint: p.mint,
    side: "SELL",
    positionId: p.id,
    amount: p.quantity,
    createdAt: Date.now(),
    expiresAt: Date.now() + 45000,
    reason: "fixture",
    snapshotHash: "fixture",
    strategy: p.strategy ?? "STANDARD",
  };
}

test("strategy decisions preserve reference unanimous-terminal BUY/WAIT/HOLD/SELL semantics", async () => {
  const rows = bars();
  for (const ends of [
    [1.01, 1.02, 1.03],
    [0.99, 0.98, 0.97],
    [1, 1, 1],
    [1.01, 0.99, 1],
  ]) {
    const f = strategy(ends);
    for (const open of [false, true]) {
      const expected = decideForecast(
        forecast(rows, Date.now(), ends),
        rows,
        open,
        Date.now(),
      ).action.replace("PAPER_", "");
      const actual = await (open
        ? f.model.evaluatePosition({ candles: rows })
        : f.model.evaluateEntry({ candles: rows }));
      assert.equal(actual.action, expected);
      assert.equal(actual.evidence.samples, 3);
      assert.equal(actual.evidence.horizon, 5);
    }
    f.model.stop();
  }
});

test("secret allowlist and strategy dependency graph contain no custody/config/environment access", () => {
  const child = kronosWorkerEnvironment(join(tmpdir(), "kronos-fixture"));
  for (const key of [
    "SOLANA_PRIVATE_KEY",
    "KRONOS_PRIVATE_KEY",
    "WALLET_PRIVATE_KEY",
    "MNEMONIC",
    "JUPITER_API_KEY",
    "KRONOS_JUPITER_API_KEY",
    "GMGN_API_KEY",
    "GMGN_PRIVATE_KEY",
    "GMGN_PRIVATE_KEY_PATH",
    "SOLANA_KEYPAIR_PATH",
    "TYPESAFE_API_KEY",
  ])
    assert.equal(child[key], undefined, key);
  for (const file of [
    "src/kronos-strategy.ts",
    "src/kronos-worker.ts",
    "src/kronos-domain.ts",
  ]) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(
      text,
      /process\.env|dotenv|from ["']\.\/(?:config|executor|solana|execution-provider|store|jev)\.js/,
    );
  }
});

test("worker receives OHLC only; malicious outputs and errors cannot create decisions or leak raw text", async () => {
  const rows = bars().map((c) => ({
    ...c,
    privateKey: "fixture-secret",
    transaction: "forbidden",
  }));
  let sent: unknown;
  for (const bad of [
    { transaction: "evil" },
    { privateKey: "evil" },
    { action: "BUY" },
    { amount: "1000000" },
    { paths: [[Infinity]] },
    { model: { id: "wrong", revision: "wrong" } },
  ]) {
    const m = new KronosStrategy({
      forecast: async (input, at) => {
        sent = input;
        return { ...forecast(input, at), ...bad };
      },
      status() {
        return {};
      },
      stop() {},
    });
    await assert.rejects(
      m.evaluateEntry({ candles: rows }),
      /^Error: KRONOS_INFERENCE_FAILED$/,
    );
    assert.deepEqual(Object.keys((sent as LabCandle[])[0]!).sort(), [
      "at",
      "close",
      "high",
      "low",
      "open",
    ]);
    m.stop();
  }
  const m = new KronosStrategy({
    forecast: async () => {
      throw Error("secret raw error");
    },
    status() {
      return {};
    },
    stop() {},
  });
  await assert.rejects(
    m.evaluateEntry({ candles: rows }),
    /^Error: KRONOS_INFERENCE_FAILED$/,
  );
  m.stop();
});

test("worker errors retain only safe, stable reason codes", () => {
  assert.equal(
    kronosWorkerErrorCode("ValueError:FUTURE_PARTIAL_OR_GAPPED_CANDLE"),
    "KRONOS_WORKER_FUTURE_PARTIAL_OR_GAPPED_CANDLE",
  );
  assert.equal(
    kronosWorkerErrorCode("RuntimeError:secret path and model details"),
    "KRONOS_WORKER_RUNTIMEERROR",
  );
  assert.equal(kronosWorkerErrorCode({ leaked: "secret" }), "KRONOS_WORKER_ERROR");
});

test("KRONOS strategy propagates safe worker error codes instead of replacing them", async () => {
  const m = new KronosStrategy({
    forecast: async () => { throw Error("KRONOS_WORKER_FUTURE_PARTIAL_OR_GAPPED_CANDLE"); },
    status() { return {}; },
    stop() {},
  });
  try {
    await assert.rejects(
      m.evaluateEntry({ candles: bars() }),
      /^Error: KRONOS_WORKER_FUTURE_PARTIAL_OR_GAPPED_CANDLE$/,
    );
  } finally { m.stop(); }
});

test("inference is serial and queued position jobs precede queued entries", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((r) => (release = r)),
    order: number[] = [];
  let count = 0,
    active = 0,
    max = 0;
  const m = new KronosStrategy({
    forecast: async (rows, at) => {
      const n = ++count;
      active++;
      max = Math.max(max, active);
      order.push(n);
      if (n === 1) await barrier;
      active--;
      return forecast(rows, at);
    },
    stop() {},
    status() {
      return {};
    },
  });
  const a = m.evaluateEntry({ candles: bars() }),
    b = m.evaluateEntry({ candles: bars() }),
    c = m.evaluatePosition({ candles: bars() });
  const completed: string[] = [];
  void b.then(() => completed.push("ENTRY"));
  void c.then(() => completed.push("POSITION"));
  release();
  await Promise.all([a, b, c]);
  assert.equal(max, 1);
  assert.deepEqual(completed, ["POSITION", "ENTRY"]);
  assert.equal(order.length, 3);
  m.stop();
});

test("KRONOS uses shared gates without legacy model evidence", async () => {
  const secretNames = [
    "SOLANA_PRIVATE_KEY",
    "KRONOS_PRIVATE_KEY",
    "WALLET_PRIVATE_KEY",
    "MNEMONIC",
    "JUPITER_API_KEY",
    "GMGN_API_KEY",
    "GMGN_PRIVATE_KEY",
    "SOLANA_KEYPAIR_PATH",
    "TYPESAFE_API_KEY",
  ];
  const savedSecrets = secretNames.map(
    (name) => [name, process.env[name]] as const,
  );
  for (const name of secretNames)
    process.env[name] = "SYNTHETIC_SECRET_" + name;
  const k = strategy(),
    f = mockExecutionCase(undefined, {
      strategy: "KRONOS",
      kronos: k.model,
      historyMinutes: 60,
    });
  try {
    await f.e.analyze(MINT);
    await f.e.settleEntryEvaluations();
    assert.equal(
      f.e.attempts.current!.result,
      "BOUGHT",
      JSON.stringify(f.e.attempts.current),
    );
    assert.equal(k.calls(), 1);
    assert.equal(k.inputs[0]!.length, 60);
    const winningSnapshot = f.store.latest<any>("snapshots", MINT)!;
    assert.equal(winningSnapshot.strategy, "KRONOS");
    assert.equal(winningSnapshot.jev, undefined);
    assert.equal(winningSnapshot.oneShotStructure, undefined);
    assert.equal(winningSnapshot.manipulationStructure, undefined);
    assert.equal(f.store.count("jev_inputs"), 0, "No legacy inference branch");
    assert.equal(f.store.count("jev_decisions"), 0);
    const p = f.store.positions("live")[0]!,
      e = f.store.executions()[0]!;
    assert.equal(p.strategy, "KRONOS");
    assert.equal(p.state, "OPEN");
    assert.equal(e.intent.strategy, "KRONOS");
    assert.equal(e.intent.amount, "9800000");
    assert.equal(e.intent.decisionSource, "KRONOS");
    assert.ok(e.intent.decisionId);
    const fill = f.store.db
      .prepare("SELECT payload FROM execution_fills")
      .get();
    assert.equal(JSON.parse(String(fill!.payload)).strategy, "KRONOS");
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM trade_learning_samples").get()!
        .n,
      0,
    );
    assert.deepEqual(f.probes, [200000n, 500000n, 1000000n]);
    const serialized = JSON.stringify({
      input: k.inputs,
      trace: f.store.trace(MINT),
      executions: f.store.executions(),
      positions: f.store.positions("live"),
      status: k.model.status(),
    });
    for (const name of secretNames)
      assert.equal(serialized.includes(process.env[name]!), false);
    assert.deepEqual(f.stats(), { signed: 1, simulated: 1 });
  } finally {
    await f.close();
    for (const [name, value] of savedSecrets)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
  }
});

test("revoking candidate authority during concurrent evaluation prevents both unsigned entries", async () => {
  const k = strategy(),
    f = mockExecutionCase(undefined, {
      strategy: "KRONOS",
      kronos: k.model,
      historyMinutes: 60,
    });
  const evaluate = f.e.kronos.evaluateEntry.bind(f.e.kronos);
  f.e.kronos.evaluateEntry = async (input) => {
    const d = await evaluate(input);
    f.store.dismissCandidate(MINT, "live");
    return d;
  };
  try {
    await assert.rejects(f.e.analyze(MINT));
    assert.equal(f.stats().signed, 0);
    assert.equal(f.store.executions().length, 0);
  } finally {
    await f.close();
  }
});

test("Kronos global safety retains only critical security and liquidity collapse; forged manual/protection cannot claim", async () => {
  const store = new Store(":memory:"),
    e = new Engine(store, {
      rpc: fixtureRpc(),
      demoQuotes: fixtureQuotes(),
      gmgn: provider().gmgn,
      kronos: strategy().model,
    });
  const p = {
    ...position(),
    mode: "demo" as const,
    strategy: "KRONOS" as const,
    initialLiquidity: 100000,
    quantity: "1000000",
    originalQuantity: "1000000",
  };
  fundFixtureHolding(store, p);
  try {
    const security = snapshot().security;
    security.findings.push({
      code: "MINT_CONTROL",
      level: "CRITICAL",
      reason: "fixture active authority",
    });
    const market = normalizeMarket(info());
    market.liquidity = { state: "KNOWN", value: 1000 };
    const evidence = evaluateExitSafety(p, settings, { security, market });
    assert.deepEqual(
      evidence.authorities.map((a) => a.kind),
      ["SECURITY_CRITICAL", "LIQUIDITY_COLLAPSE"],
    );
    for (const proof of evidence.authorities) {
      const op = {
        id: randomUUID(),
        kind: "PROTECTIVE" as const,
        reason: proof.reason,
        sellBps: 10000,
        triggeredAt: Date.now(),
        protection: proof,
      };
      p.pendingExits = [op];
      store.savePosition(p);
      const i = {
        ...sell(p),
        exitAuthority: "PROTECTIVE" as const,
        exitOpportunityId: op.id,
      };
      assert.doesNotThrow(() => assertStrategySell(i, p));
      assert.throws(
        () => assertStrategySell({ ...i, amount: "1" }, p),
        /SAFETY/,
      );
      assert.throws(
        () => assertStrategySell(i, p, Date.now() + 1000000),
        /SAFETY/,
      );
    }
    assert.throws(
      () =>
        store.claim({
          ...sell(p),
          exitAuthority: "MANUAL",
          manualRequestId: "fake-request",
        }),
      /TEMPORARY_RISK_CHANGE/,
    );
    p.pendingExits = [];
    store.savePosition(p);
    assert.throws(
      () =>
        store.claim({
          ...sell(p),
          exitAuthority: "SECURITY",
          exitOpportunityId: "fake-proof",
        }),
      /SAFETY/,
    );
    (e as any).solPrice = "100";
    (e as any).solPriceAt = Date.now();
    store.record("position_market", p.mint, normalizeMarket(info()));
    e.emergency(p.id, 5000);
    await e.processExits();
    assert.equal(store.executions().length, 1);
    assert.equal(store.executions()[0]!.intent.exitAuthority, "MANUAL");
    assert.equal(store.positions("demo")[0]!.quantity, "500000");
  } finally {
    await e.stop();
    store.close();
  }
});

for (const failure of [
  "SECURITY",
  "COMPATIBILITY",
  "OWNERSHIP",
  "CAPITAL",
  "EXIT",
  "SIMULATE",
  "PRE_SIGN",
] as const)
  test(`KRONOS does not bypass common ${failure} safety`, async () => {
    const k = strategy(),
      f = mockExecutionCase(failure, {
        strategy: "KRONOS",
        kronos: k.model,
        historyMinutes: 60,
      });
    try {
      await assert.rejects(f.e.analyze(MINT));
      assert.equal(f.stats().signed, 0);
      assert.equal(
        f.store.positions("live").some((p) => p.state === "OPEN"),
        failure === "OWNERSHIP",
      );
    } finally {
      await f.close();
    }
  });

for (const mode of ["WAIT", "FAIL"])
  test(`KRONOS ${mode} creates no intent on its own non-BUY outcome`, async () => {
    const k = strategy([0.9, 0.91, 0.92]);
    k.fail(mode === "FAIL");
    const f = mockExecutionCase(undefined, {
      strategy: "KRONOS",
      kronos: k.model,
      historyMinutes: 60,
    });
    try {
      await assert.rejects(f.e.analyze(MINT));
      assert.equal(f.store.executions().length, 0);
      assert.equal(f.stats().signed, 0);
      assert.equal(f.store.count("jev_inputs"), 0);
      assert.equal(k.calls(), 1);
    } finally {
      await f.close();
    }
  });

test("common Risk denies concentration, missing authority, stale evidence, disabled entries and duplicates before inference", () => {
  const risk = new RiskEngine(),
    ctx = {
      balance: 1000000000n,
      pending: 0n,
      positions: 0,
      duplicate: false,
      entriesEnabled: true,
    };
  const s = { ...settings, entryStrategy: "FIRST_BUY_WINS" as const },
    base = {
      ...snapshot(),
      strategy: "KRONOS" as const,
      jev: undefined,
      kronos: undefined,
    };
  assert.equal(risk.evaluate(base, s, ctx, Date.now(), "COMMON").allowed, true);
  for (const mutate of [
    (x: typeof base) => {
      x.security.mintRenounced = {
        state: "UNKNOWN",
        reason: "fixture missing",
      };
    },
    (x: typeof base) => {
      x.intelligence.holders.top1 = { state: "KNOWN", value: 99 };
    },
    (x: typeof base) => {
      x.security.at -= 1000000;
    },
  ]) {
    const x = structuredClone(base);
    mutate(x);
    assert.equal(risk.evaluate(x, s, ctx, Date.now(), "COMMON").allowed, false);
  }
  assert.equal(
    risk.evaluate(base, s, { ...ctx, duplicate: true }, Date.now(), "COMMON")
      .allowed,
    false,
  );
  assert.equal(
    risk.evaluate(
      base,
      s,
      { ...ctx, entriesEnabled: false },
      Date.now(),
      "COMMON",
    ).allowed,
    false,
  );
  assert.equal(
    risk.evaluate(base, s, ctx).allowed,
    false,
    "COMMON cannot authorize a missing model decision",
  );
});

test("KRONOS bearish decision closes actual remaining quantity through common DEMO Executor and accounting", async () => {
  const store = new Store(":memory:"),
    g = provider(),
    k = strategy([0.9, 0.91, 0.92]),
    e = new Engine(store, {
      rpc: fixtureRpc(),
      demoQuotes: fixtureQuotes(),
      gmgn: g.gmgn,
      kronos: k.model,
    });
  const p = {
    ...position(),
    mode: "demo" as const,
    strategy: "KRONOS" as const,
    quantity: "123456",
    originalQuantity: "999999",
  };
  fundFixtureHolding(store, p);
  store.record("position_market", p.mint, normalizeMarket(info()));
  const h = parseMarketHistory(candles(60), {
    ...recentCandidate(),
    createdAt: Date.now() - 2 * 3600000,
  });
  try {
    (e as any).scheduleKronosPosition(p, h);
    await Promise.all((e as any).kronosJobs.values());
    const current = store.positions("demo")[0]!;
    assert.equal(current.kronosDecision?.action, "SELL");
    (e as any).solPrice = "100";
    (e as any).solPriceAt = Date.now();
    await e.processExits();
    const result = store.executions()[0]!;
    assert.ok(result, JSON.stringify(store.positions("demo")[0]!.attention));
    assert.equal(result.state, "CONFIRMED");
    assert.equal(result.intent.amount, "123456");
    assert.equal(store.positions("demo")[0]!.state, "CLOSED");
    assert.equal(store.history("demo", { strategy: "KRONOS" }).length, 1);
    assert.equal(store.history("demo", { strategy: "STANDARD" }).length, 0);
  } finally {
    await e.stop();
    store.close();
  }
});

test("strategy statistics count only their owner and preserve unknown gross/net/fees", async () => {
  const store = new Store(":memory:"),
    e = new Engine(store, {
      rpc: fixtureRpc(),
      demoQuotes: fixtureQuotes(),
      gmgn: provider().gmgn,
      kronos: strategy().model,
    });
  try {
    for (const owner of ["STANDARD", "KRONOS"] as const)
      for (let n = 0; n < (owner === "STANDARD" ? 2 : 3); n++)
        store.savePosition({
          ...position(),
          mode: "demo",
          strategy: owner,
          state: "CLOSED",
          quantity: "0",
        });
    const kronos = e.analytics("KRONOS").strategyAccounting;
    assert.equal(e.analytics().strategyAccounting.closed, 5);
    assert.equal(kronos.closed, 3);
    for (const s of [kronos]) {
      assert.equal(s.grossPnlLamports, null);
      assert.equal(s.netPnlLamports, null);
      assert.equal(s.feesPaidLamports, null);
      assert.equal(s.feesComplete, false);
      assert.equal(s.wins, 0);
      assert.equal(s.losses, 0);
    }
  } finally {
    await e.stop();
    store.close();
  }
});

for (const owner of ["KRONOS"] as Strategy[])
  for (const state of ["SUBMITTED", "UNKNOWN", "OPEN"] as const)
    test(`${owner} ${state} owns mint and blocks the other strategy`, () => {
      const store = new Store(":memory:"),
        risk = new RiskEngine(),
        snap = snapshot(),
        ctx = {
          balance: 1000000000n,
          pending: 0n,
          positions: 0,
          duplicate: false,
          entriesEnabled: true,
        };
      try {
        const base = {
            ...risk.approve(snap, settings, ctx, "demo"),
            strategy: owner,
          },
          execution = store.claim(bindFixtureClaim(store, base));
        if (state === "OPEN") {
          const p = store.positions("demo")[0]!;
          p.state = "OPEN";
          p.quantity = p.originalQuantity = "1000";
          store.savePosition(p);
          execution.state = "CONFIRMED";
        } else {
          execution.state = state;
          execution.signature = "fake-durable-signature";
        }
        store.execution(execution);
        const other = {
          ...base,
          id: randomUUID(),
          key: randomUUID(),
          positionId: randomUUID(),
          strategy: "KRONOS" as const,
        };
        assert.throws(
          () => store.claim(other),
          /Duplicate BUY|Unresolved|BUY_OWNERSHIP/,
        );
        assert.equal(store.positions("demo").length, 1);
        assert.equal(store.positions("demo")[0]!.strategy, owner);
      } finally {
        store.close();
      }
    });

test("restart preserves strategy owner; model failure leaves OPEN without JEV and recovers on new eligible input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kronos-owner-")),
    path = join(dir, "fixture.sqlite");
  const k = strategy([0.9, 0.91, 0.92]);
  let store = new Store(path),
    e: Engine | undefined;
  const p = {
    ...position(),
    mode: "demo" as const,
    strategy: "KRONOS" as const,
  };
  try {
    store.savePosition(p);
    store.close();
    store = new Store(path);
    e = new Engine(store, {
      rpc: fixtureRpc(),
      demoQuotes: fixtureQuotes(),
      gmgn: provider().gmgn,
      kronos: k.model,
    });
    assert.equal(store.positions("demo")[0]!.strategy, "KRONOS");
    const h = parseMarketHistory(candles(60), {
      ...recentCandidate(),
      createdAt: Date.now() - 2 * 3600000,
    });
    k.fail(true);
    (e as any).scheduleKronosPosition(store.positions("demo")[0], h);
    await Promise.all((e as any).kronosJobs.values());
    assert.equal(store.positions("demo")[0]!.state, "OPEN");
    assert.equal(store.executions().length, 0);
    assert.equal(
      Number(
        store.db.prepare("SELECT count(*) n FROM jev_exit_decisions").get()!.n,
      ),
      0,
    );
    k.fail(false);
    (e as any).kronosAttempts.clear();
    (e as any).scheduleKronosPosition(store.positions("demo")[0], h);
    await Promise.all((e as any).kronosJobs.values());
    assert.equal(store.positions("demo")[0]!.kronosDecision?.action, "SELL");
    assert.throws(
      () =>
        store.savePosition({
          ...store.positions("demo")[0]!,
          strategy: "STANDARD",
        }),
      /STRATEGY/,
    );
    assert.equal(
      positionViews(store.positions("demo"), [])[0]!.strategicExitAuthority,
      "KRONOS",
    );
  } finally {
    await e?.stop();
    store.close();
    assert.equal(join(dir, "fixture.sqlite"), path);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history strategy filter precedes pagination and legacy rows default to STANDARD", () => {
  const store = new Store(":memory:");
  try {
    for (let n = 0; n < 6; n++) {
      const p = {
        ...position(),
        id: String(n),
        mode: "demo" as const,
        state: "CLOSED" as const,
        quantity: "0",
        entryAt: n,
        strategy: n % 2 ? ("KRONOS" as const) : ("STANDARD" as const),
      };
      store.savePosition(p);
    }
    assert.deepEqual(
      store
        .history("demo", { strategy: "KRONOS", limit: 2, offset: 1 })
        .map((p) => p.id),
      ["3", "1"],
    );
    const legacy = position();
    legacy.mode = "demo";
    legacy.state = "CLOSED";
    store.savePosition(legacy);
    store.db
      .prepare(
        "UPDATE positions SET payload=json_remove(payload,'$.strategy') WHERE id=?",
      )
      .run(legacy.id);
    assert.equal(
      store
        .history("demo", { strategy: "STANDARD" })
        .some((p) => p.id === legacy.id),
      true,
    );
  } finally {
    store.close();
  }
});
