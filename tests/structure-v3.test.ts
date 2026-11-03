import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMarketHistory,
  attemptFlow,
  oneShotStructure,
} from "../src/market-history.js";
import {
  normalizeSmartMoney,
  unavailableSmartMoney,
} from "../src/smart-money.js";
import { Gmgn, normalizeMarket } from "../src/gmgn.js";
import { RiskEngine, protectiveExitDecision } from "../src/risk.js";
import {
  candidate,
  info,
  settings,
  MINT,
  position,
  jev,
  snapshot,
} from "./fixtures.js";
import { setup } from "./one-shot-fixtures.js";
import { Jev } from "../src/jev.js";
import { env } from "../src/config.js";
import { typedJevFixture } from "./learning-fixtures.js";

const T = 1793530800000;
const bars = [
  { open: 10, close: 9, high: 10.1, low: 8.8 },
  { open: 9, close: 9.3, high: 9.5, low: 8.9 },
  { open: 9.3, close: 9.6, high: 9.8, low: 9.1 },
  { open: 9.6, close: 10.1, high: 10.2, low: 9.3 },
];
const raw = (values = bars, start = T - values.length * 60000) => ({
  list: values.map((x, i) => ({
    ...x,
    time: start + i * 60000,
    volume: "1000",
    amount: "999999",
  })),
  _gmgnSnapshot: { fetchedAt: T },
});
function fixture(values = bars) {
  const c = { ...candidate(), createdAt: T - 4 * 3600000 };
  const h = parseMarketHistory(raw(values), c, T);
  const market = {
    ...normalizeMarket(info()),
    at: T,
    price: { state: "KNOWN" as const, value: 10.1 },
  };
  const flow = attemptFlow(
    c,
    market,
    info(),
    h,
    settings.flowMeaningfulChangePercent,
  );
  return { c, h, market, flow };
}
const trade = (
  side: string,
  maker = "wallet-A",
  at = T - 10000,
  hash = side + maker + at,
  usd: unknown = 100,
) => ({
  base_address: MINT,
  maker,
  side,
  timestamp: at / 1000,
  amount_usd: usd,
  transaction_hash: hash,
  maker_info: { tags: ["smart_degen"] },
});
const feed = (rows: unknown[], at = T) =>
  normalizeSmartMoney({ list: rows, _gmgnSnapshot: { fetchedAt: at } });
function evaluate(rows: unknown[] = []) {
  const { h, market, flow } = fixture();
  return oneShotStructure(h, flow, market, {
    now: T,
    settings,
    mint: MINT,
    smartMoney: feed(rows),
  });
}
test("V3 recent selling/absorption/floor/recovery retains price provenance and phase timestamps", () => {
  const v = evaluate();
  assert.equal(v.passed, true);
  assert.equal(v.priceStructure.semantics, "PRICE_INFERENCE");
  assert.equal(v.priceStructure.recoveryInferred, true);
  assert.equal(v.priceStructure.sequenceFresh, true);
  assert(v.priceStructure.sellingAt! < v.priceStructure.absorptionAt!);
  assert(v.priceStructure.absorptionAt! < v.priceStructure.floorAt!);
  assert(v.priceStructure.floorAt! < v.priceStructure.recoveryConfirmedAt!);
  assert(!v.reason.includes("CONFIRMED"));
  assert.equal(v.marketFlow.semantics, "CURRENT_MARKET_FLOW");
  assert.equal(v.marketFlow.metrics.netFlowAccelerationUsdPerMinute2, null);
});
test("V3 56 flat bars expire old recovery; a later tiny bounce cannot resurrect it", () => {
  const values = [
    ...bars,
    ...Array.from({ length: 56 }, () => ({
      open: 10.1,
      close: 10.1,
      high: 10.1,
      low: 10.1,
    })),
  ];
  const f = fixture(values);
  const v = oneShotStructure(f.h, f.flow, f.market, { settings, now: T });
  assert.equal(v.passed, false);
  assert.equal(v.priceStructure.status, "STALE");
  assert.equal(v.priceStructure.recoveryInferred, false);
  f.h.candles.at(-1)!.close = 10.11;
  assert.equal(
    oneShotStructure(
      f.h,
      f.flow,
      { ...f.market, price: { state: "KNOWN", value: 10.11 } },
      { settings, now: T },
    ).passed,
    false,
  );
});
test("V3 pump alone cannot fabricate a selling/absorption sequence", () => {
  const f = fixture(
    bars.map((x) => ({ ...x, open: x.close, close: x.high, high: x.high })),
  );
  const v = oneShotStructure(f.h, f.flow, f.market, { settings, now: T });
  assert.equal(v.priceStructure.sellingObserved, false);
  assert.equal(v.passed, false);
});
test("aligned sells followed by later distinct buyers create subset support", () => {
  const v = evaluate([
    trade("sell", "seller", T - 110000, "sell", 50),
    trade("buy", "A", T - 50000),
    trade("buy", "B", T - 10000),
  ]);
  assert.equal(v.smartMoney.status, "BUY_SUPPORT");
  assert.equal(v.smartMoney.distinctBuyers, 2);
  assert.equal(v.smartMoney.computedNetBuyUsd, 150);
  assert.equal(v.conclusion.supportLevel, "STRONG");
  assert.equal(v.smartMoney.buyerCluster.independentOwnersProven, false);
});
test("many buys from one maker stay one distinct buyer; duplicate hash is counted once", () => {
  const a = trade("buy");
  const v = evaluate([a, a, trade("buy", "wallet-A", T - 5000)]);
  assert.equal(v.smartMoney.buys, 2);
  assert.equal(v.smartMoney.distinctBuyers, 1);
  assert.equal(v.smartMoney.duplicates, 1);
  assert.equal(v.smartMoney.buyerCluster.present, false);
});
test("same transaction conflicting representations cannot manufacture directional evidence", () => {
  const a = trade("buy");
  const v = evaluate([a, { ...a, side: "sell" }]);
  assert.equal(v.smartMoney.status, "INSUFFICIENT_COVERAGE");
  assert.equal(v.smartMoney.conflictingTransactions, 1);
});
test("aligned recent smart sells produce conflict, not automatic SELL or BUY authority", () => {
  const v = evaluate([
    trade("buy", "A", T - 50000, "b", 10),
    trade("sell", "S", T - 10000, "s", 100),
  ]);
  assert.equal(v.smartMoney.status, "SELL_PRESSURE");
  assert.equal(v.conclusion.supportLevel, "CONFLICTED");
  assert.equal(
    v.passed,
    true,
    "price/current-flow eligibility remains separate; JEV must consider conflict",
  );
  assert.equal(
    protectiveExitDecision(
      position(),
      1000000n,
      { ...settings, smartMoneyExitMode: "EXIT" },
      { smartMoney: true },
    ),
    undefined,
  );
});
test("token absent and unavailable feed do not fail otherwise valid structure", () => {
  const v = evaluate([{ ...trade("buy"), base_address: "other" }]);
  assert.equal(v.smartMoney.status, "NO_MATCH_IN_RETURNED_FEED");
  assert.equal(v.conclusion.supportLevel, "MODERATE");
  assert.equal(v.passed, true);
  const f = fixture();
  const u = oneShotStructure(f.h, f.flow, f.market, {
    now: T,
    settings,
    smartMoney: unavailableSmartMoney(),
  });
  assert.equal(u.smartMoney.status, "UNAVAILABLE");
  assert.equal(u.smartMoney.buyUsd, null);
  assert.equal(u.passed, true);
});
test("optional provider failure is UNAVAILABLE without throwing or fallback data", async () => {
  const gmgn = new Gmgn(async () => {
    throw Error("fixture failure");
  });
  try {
    assert.equal((await gmgn.smartMoneyFeed()).available, false);
  } finally {
    await gmgn.coordinator.stop();
  }
});
test("optional feed failure reaches JEV as unavailable without global pause or new watcher", async () => {
  const x = setup();
  const run = x.engine.gmgn.run.bind(x.engine.gmgn);
  x.engine.gmgn.run = async (args, ...rest) => {
    if (args[0] === "track") throw Error("fixture-only provider down");
    return run(args, ...rest);
  };
  let observed: any;
  x.j.decide = async (state) => {
    observed = state;
    return { ...jev(), action: "SKIP" };
  };
  try {
    await assert.rejects(x.engine.analyze(MINT));
    assert.equal(observed.structureEvidence.smartMoney.status, "UNAVAILABLE");
    assert.equal(x.engine.attempts.current!.failedStage, "JEV");
    assert.equal(x.store.entriesEnabled(), true);
    assert.equal(x.store.get("haltReason"), undefined);
    assert.equal(x.engine.candidates.list().length, 0);
  } finally {
    await x.engine.stop();
    x.store.close();
  }
});
test("provider cache reuses raw feed, TTL0 fetches again; no unsupported token/side queries", async () => {
  const calls: string[][] = [];
  const g = new Gmgn(async (args) => {
    calls.push(args);
    return { list: [] };
  });
  try {
    await g.smartMoneyFeed(30000);
    await g.smartMoneyFeed(30000);
    await g.smartMoneyFeed(0);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], [
      "track",
      "smartmoney",
      "--chain",
      "sol",
      "--limit",
      "100",
    ]);
  } finally {
    await g.coordinator.stop();
  }
});
test("old/pre-selling/pre-response buys cannot support a later recovery", () => {
  for (const at of [T - 3600000, T - 250000, T - 190000]) {
    const v = evaluate([trade("buy", "A", at)]);
    assert.equal(v.smartMoney.status, "INSUFFICIENT_COVERAGE");
    assert.equal(v.smartMoney.buyerCluster.present, false);
  }
  assert.equal(
    evaluate([trade("buy", "A", T - 50000)]).smartMoney.status,
    "BUY_SUPPORT",
  );
});
test("stale snapshot and missing event identity remain unknown, never counted as support", () => {
  const f = fixture();
  const stale = oneShotStructure(f.h, f.flow, f.market, {
    now: T,
    settings,
    smartMoney: feed(
      [trade("buy", "A"), trade("buy", "B")],
      T - settings.maxSnapshotAgeMs - 1,
    ),
  });
  assert.equal(stale.smartMoney.status, "INSUFFICIENT_COVERAGE");
  assert.equal(stale.smartMoney.buyerCluster.present, false);
  const v = evaluate([
    { ...trade("buy"), maker: null, transaction_hash: null, amount_usd: "   " },
  ]);
  assert.equal(v.smartMoney.events[0]!.maker, null);
  assert.equal(v.smartMoney.events[0]!.amountUsd, null);
  assert.equal(v.smartMoney.status, "INSUFFICIENT_COVERAGE");
});
test("Risk rechecks phase time and underlying history before execution", () => {
  const f = fixture(),
    v = evaluate();
  const s = {
    ...snapshot(),
    entryAuthority: {
      revision: 0,
      path: "TRENDING" as const,
      policy: "TRENDING_ONE_SHOT_V1" as const,
    },
    marketHistory: f.h,
    oneShotStructure: v,
  };
  const result = new RiskEngine().evaluate(
    s,
    settings,
    {
      balance: 1000000000n,
      pending: 0n,
      positions: 0,
      duplicate: false,
      entriesEnabled: true,
    },
    T + settings.structureMaxGapMs + 1,
  );
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "STALE_PRICE_RECOVERY");
});
test("SELL validation expires timestamped smart evidence at apply and pre-sign guard", async () => {
  const x = setup();
  try {
    const changed = (d: unknown) =>
      Boolean((x.engine as any).exitEvidenceChanged(d));
    assert.equal(
      changed({
        mint: MINT,
        action: "FULL_SELL",
        observed: {
          smartMoneyStatus: "SELL_PRESSURE",
          smartMoneyObservedAt: Date.now() - settings.maxSnapshotAgeMs - 1,
        },
      }),
      true,
    );
    assert.equal(
      changed({
        mint: MINT,
        action: "FULL_SELL",
        observed: {
          smartMoneyStatus: "SELL_PRESSURE",
          smartMoneyObservedAt: Date.now(),
        },
      }),
      false,
    );
    assert.equal(
      changed({
        mint: MINT,
        action: "FULL_SELL",
        observed: {
          smartMoneyStatus: "UNAVAILABLE",
          smartMoneyObservedAt: null,
        },
      }),
      false,
      "optional missing evidence does not veto unrelated strategic analysis",
    );
  } finally {
    await x.engine.stop();
    x.store.close();
  }
});
test("each fresh attempt refetches feed and JEV receives full evidence, coverage and timestamps", async () => {
  const x = setup();
  let n = 0;
  const inputs: any[] = [];
  x.engine.gmgn.smartMoneyFeed = async () => {
    const now = Date.now();
    return feed(n++ ? [trade("buy", "A", now - 1000)] : [], now);
  };
  x.j.decide = async (state) => {
    inputs.push(structuredClone(state));
    return { ...jev(), action: "SKIP" };
  };
  try {
    await assert.rejects(x.engine.analyze(MINT));
    const first = x.engine.attempts.current!.attemptId;
    await assert.rejects(x.engine.analyze(MINT));
    assert.notEqual(x.engine.attempts.current!.attemptId, first);
    assert.equal(n, 2);
    assert.equal(
      inputs[0].structureEvidence.smartMoney.status,
      "NO_MATCH_IN_RETURNED_FEED",
    );
    assert.equal(inputs[1].structureEvidence.smartMoney.status, "BUY_SUPPORT");
    assert.equal(
      inputs[1].structureEvidence.priceStructure.semantics,
      "PRICE_INFERENCE",
    );
    assert.equal(
      inputs[1].structureEvidence.marketFlow.historicalDirectionalFlow,
      "UNKNOWN",
    );
    assert(inputs[1].structureEvidence.smartMoney.coverage);
    assert(inputs[1].structureEvidence.conclusion.limitations.length);
    assert.equal(x.store.executions().length, 0);
  } finally {
    await x.engine.stop();
    x.store.close();
  }
});
test("JEV wire retains V3 components and explicitly explains capped subset/missing evidence", async () => {
  const previous = env.TYPESAFE_API_KEY;
  env.TYPESAFE_API_KEY = "fixture-only";
  const j = new Jev();
  let sent: any;
  j.http.request = async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return typedJevFixture("BUY", "UNAVAILABLE", "NONE");
  };
  try {
    const v = evaluate([trade("buy", "A")]);
    await j.decide({ attemptId: "fixture", structureEvidence: v }, true);
    assert.deepEqual(sent.state.structureEvidence, v);
    assert.match(
      sent.questions.action.instructions,
      /absence of records is not proof/,
    );
    assert.equal(sent.state.buyerDefense, undefined);
  } finally {
    env.TYPESAFE_API_KEY = previous;
  }
});
test("slow optional Smart Money and JEV never block A/B/C price collectors", async () => {
  const x = setup();
  let releaseSmart!: () => void, releaseJev!: () => void;
  const smartGate = new Promise<void>((r) => {
    releaseSmart = r;
  });
  const jevGate = new Promise<void>((r) => {
    releaseJev = r;
  });
  x.engine.gmgn.smartMoneyFeed = async () => {
    await smartGate;
    return feed([], Date.now());
  };
  x.j.decideExit = async () => {
    await jevGate;
    return { action: "HOLD", sellBps: 0, confidence: 1, reason: "fixture" };
  };
  for (const id of ["A", "B", "C"])
    x.store.savePosition({ ...position(), id, mode: "paper" });
  try {
    await x.engine.monitor();
    for (const p of x.store.positions("paper"))
      assert(
        p.lastQuoteAt,
        p.id + " price saved before optional feed completes",
      );
    for (const p of x.store.positions("paper")) {
      p.lastQuoteAt = 0;
      x.store.savePosition(p);
    }
    await x.engine.monitor();
    for (const p of x.store.positions("paper"))
      assert((p.marketRevision ?? 0) >= 2);
    assert.equal(x.store.executions().length, 0);
  } finally {
    releaseSmart();
    releaseJev();
    await x.engine.stop();
    x.store.close();
  }
});
