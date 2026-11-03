import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeManipulationStructure } from "../src/manipulation-structure.js";
import {
  makeFillAccounting,
  receiptRentDelta,
  tradeAccounting,
} from "../src/trade-accounting.js";
import { RiskEngine } from "../src/risk.js";
import { position, snapshot, settings, MINT } from "./fixtures.js";
import { setup } from "./one-shot-fixtures.js";
import type { Candle } from "../src/market-history.js";
import type { Execution, Position } from "../src/domain.js";
import { Store } from "../src/store.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
const T = 1793530800000;
function series(steps: number[], wick = 0.01): Candle[] {
  let price = 20;
  return steps.map((s, i) => {
    const open = price;
    price += s;
    return {
      at: T - (steps.length - i) * 60000,
      open,
      close: price,
      high: Math.max(price, open) + wick,
      low: Math.min(price, open) - wick,
      volumeUsd: 1000,
    };
  });
}
const analyze = (candles: Candle[], at = T) =>
  analyzeManipulationStructure(
    { candles, fetchedAt: at, source: "GMGN_KLINE_1M" },
    at,
  );
test("controlled staircase requires confluence and keeps inspectable relative features", () => {
  const r = analyze(series([8, ...Array(18).fill(0.2), ...Array(8).fill(0.4)]));
  assert.equal(r.status, "STRONG");
  assert(r.evidence?.pathEfficiency);
  assert(r.suspiciousSegments.some((s) => s.initialImpulseDominant));
  assert(r.suspiciousSegments.some((s) => s.lateAccelerationObserved));
  assert(r.reasons.includes("scarceRejection"));
  assert.equal(
    Object.values(r.suspiciousSegments[0]!.confluence).every(Boolean),
    true,
  );
});
test("dump cannot erase a later controlled-markup segment", () => {
  const cs = series([2, -1, 1.5, -1, 2, -4, ...Array(20).fill(0.15)]);
  const r = analyze(cs);
  assert.equal(r.status, "STRONG");
  assert(r.suspiciousSegments.some((s) => s.from > cs[5]!.at));
});
const controlSet = [
  {
    name: "Organic bullish with repeated retests",
    candles: series(
      Array.from(
        { length: 32 },
        (_, i) => [0.9, -0.45, 0.55, -0.2, 0.8, -0.5, 0.4, 0.6][i % 8]!,
      ),
      0.2,
    ),
  },
  {
    name: "Organic bullish/noisy uptrend",
    candles: series(
      Array.from({ length: 30 }, (_, i) => [0.6, 0.4, -0.7, 1.1, -0.4][i % 5]!),
      0.3,
    ),
  },
  {
    name: "Volatile launch",
    candles: series(
      [
        10,
        ...Array.from({ length: 28 }, (_, i) => [0.6, -0.5, 1, -0.6][i % 4]!),
      ],
      0.3,
    ),
  },
  {
    name: "Strong green momentum with rejection/price discovery",
    candles: series(
      Array.from({ length: 25 }, (_, i) => [0.2, 0.7, 0.3, 1.1, 0.4][i % 5]!),
      0.8,
    ),
  },
  {
    name: "Healthy pullback/recovery",
    candles: series(
      [3, -1, -0.6, 0.8, 0.9, -0.5, 1, 0.6, -0.7, 0.9, 1, -0.6, 0.8],
      0.25,
    ),
  },
];
for (const control of controlSet)
  test("control NOT STRONG: " + control.name, () =>
    assert.notEqual(analyze(control.candles).status, "STRONG"),
  );
test("6 real loss snapshots replay only persisted pre-BUY candles, without hindsight", () => {
  const data = JSON.parse(
    readFileSync("tests/fixtures/controlled-markup-prebuy.json", "utf8"),
  );
  assert.equal(data.cases.length, 6);
  const replay = data.cases.map((c: any) => {
    assert(c.snapshotAt <= c.entryAt);
    assert(c.fetchedAt <= c.entryAt);
    assert(c.candles.every((x: Candle) => x.at + 60000 <= c.snapshotAt));
    const input = {
      candles: c.candles,
      fetchedAt: c.fetchedAt,
      source: "GMGN_KLINE_1M" as const,
    };
    const r = analyzeManipulationStructure(input, c.snapshotAt);
    assert.deepEqual(r, analyzeManipulationStructure(input, c.snapshotAt));
    return {
      symbol: c.symbol,
      snapshotAt: c.snapshotAt,
      entryAt: c.entryAt,
      detectedPreBuy: r.status === "STRONG",
      status: r.status,
      result: r,
    };
  });
  // Record honest capability, rather than tuning to the future loss label.
  assert.equal(replay.filter((r: any) => r.detectedPreBuy).length, 5);
  assert.equal(
    replay.find((r: any) => r.symbol === "tipr").detectedPreBuy,
    false,
  );
  const future = [
    ...data.cases[0].candles,
    {
      ...data.cases[0].candles.at(-1),
      at: data.cases[0].entryAt,
      close: 0.00000001,
    },
  ];
  assert.deepEqual(
    analyze(future, data.cases[0].snapshotAt),
    analyze(data.cases[0].candles, data.cases[0].snapshotAt),
  );
  if (process.env.KEEP_TEST_ARTIFACTS === "true")
    writeFileSync(
      "docs/controlled-markup-replay-results.json",
      JSON.stringify(
        {
          futureCandlesUsed: false,
          replay,
          controls: controlSet.map((c) => ({
            name: c.name,
            status: analyze(c.candles).status,
          })),
        },
        null,
        2,
      ),
    );
});
test("bullish JEV cannot override deterministic STRONG controlled-markup veto", () => {
  const s = {
    ...snapshot(),
    manipulationStructure: analyze(series(Array(20).fill(0.2))),
  };
  assert.equal(s.jev!.action, "BUY");
  const result = new RiskEngine().evaluate(s, settings, {
    balance: 1000000000n,
    pending: 0n,
    positions: 0,
    duplicate: false,
    entriesEnabled: true,
  });
  assert.equal(result.reason, "CONTROLLED_MARKUP_STRUCTURE");
});

function execution(
  id: string,
  side: "BUY" | "SELL",
  sol: bigint,
  quantity: bigint,
  fee: bigint,
  principal: string,
  at: number,
): Execution {
  const e = {
    id,
    intent: {
      id,
      positionId: "accounting-test",
      side,
      amount: principal,
      mode: "paper",
      mint: MINT,
    },
    signature: id,
    at,
    state: "CONFIRMED",
    evidence: {
      solDelta: String(sol),
      tokenDelta: String(quantity),
      feeLamports: String(fee),
      slot: 0,
    },
    fx: { price: "100", at, source: "FIXTURE_SOL_PRICE" },
  } as Execution;
  e.accounting = makeFillAccounting(
    e,
    sol,
    quantity,
    fee,
    0n,
    0,
    e.fx!,
    at,
    "RECONCILIATION_TIME",
  );
  return e;
}
function accountingPosition(): Position {
  return {
    ...position(),
    id: "accounting-test",
    mode: "paper",
    decimals: 0,
    quantity: "100",
    originalQuantity: "100",
    lastValueLamports: "1100000000",
  };
}
for (const fee of [0n, 20000000n])
  test("gross PnL independent of incurred fee " + fee, () => {
    const p = accountingPosition();
    const a = tradeAccounting(p, [
      execution("entry", "BUY", -1000000000n - fee, 100n, fee, "1000000000", T),
    ]);
    assert.equal(a.grossPnlLamports, "100000000");
    assert.equal(a.grossPnlPct, 10);
    assert.equal(a.feesPaidLamports, fee.toString());
    assert.equal(a.netPnlLamports, (100000000n - fee).toString());
    assert.equal(a.feesPaidUsd, fee ? "2" : "0");
  });
test("recoverable ATA rent is not a fee; actual effective fill captures impact once", () => {
  const e = execution(
    "entry",
    "BUY",
    -1003000000n,
    80n,
    1000000n,
    "1000000000",
    T,
  );
  e.accounting = makeFillAccounting(
    e,
    -1003000000n,
    80n,
    1000000n,
    2000000n,
    0,
    e.fx!,
    T,
    "BLOCK_TIME",
  );
  const p = {
    ...accountingPosition(),
    quantity: "80",
    originalQuantity: "80",
    lastValueLamports: "1000000000",
  };
  const a = tradeAccounting(p, [e]);
  assert.equal(a.entry?.priceSol, "0.0125");
  assert.equal(a.feesPaidLamports, "1000000");
  assert.equal(a.recoverableRentDeltaLamports, "2000000");
  assert.equal(a.grossPnlLamports, "0");
  assert.equal(a.netPnlLamports, "-1000000");
  assert.equal(a.entry?.platformFeeLamports, null);
  assert.equal(a.entry?.routeFeeLamports, null);
});
test("receipt rent ownership and wSOL principal are separated from rent", () => {
  const keys = [
    "owner",
    "ATA1",
    "WSOL2",
    ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    TOKEN_PROGRAM_ID.toBase58(),
    MINT,
  ];
  const r = {
    transaction: {
      message: {
        getAccountKeys: () => ({
          get: (i: number) => ({ toBase58: () => keys[i] }),
        }),
        compiledInstructions: [
          {
            programIdIndex: 3,
            accountKeyIndexes: [0, 1, 0, 5],
            data: new Uint8Array([1]),
          },
          {
            programIdIndex: 4,
            accountKeyIndexes: [2, 0, 0],
            data: new Uint8Array([9]),
          },
        ],
      },
    },
    meta: {
      preBalances: [1000000000, 0, 502000000],
      postBalances: [0, 2000000, 0],
      preTokenBalances: [
        {
          accountIndex: 2,
          owner: "owner",
          mint: "So11111111111111111111111111111111111111112",
          uiTokenAmount: { amount: "500000000" },
        },
      ],
      postTokenBalances: [
        {
          accountIndex: 1,
          owner: "owner",
          mint: MINT,
          uiTokenAmount: { amount: "100" },
        },
      ],
    },
  } as never;
  assert.equal(
    receiptRentDelta(r, "owner"),
    0n,
    "2m locked ATA offsets 2m released wSOL rent, not 502m",
  );
  assert.equal(receiptRentDelta({ meta: {} } as never, "owner"), null);
});
test("single final exit persists actual entry, exit, fee/net and duration", () => {
  const p = {
    ...accountingPosition(),
    quantity: "0",
    state: "CLOSED" as const,
    sellSignature: "exit",
  };
  const es = [
    execution("entry", "BUY", -1010000000n, 100n, 10000000n, "1000000000", T),
    execution("exit", "SELL", 1190000000n, -100n, 10000000n, "100", T + 120000),
  ];
  const a = tradeAccounting(p, es);
  assert.equal(a.entry?.signature, "entry");
  assert.equal(a.finalExit?.signature, "exit");
  assert.equal(a.grossPnlLamports, "200000000");
  assert.equal(a.netPnlLamports, "180000000");
  assert.equal(a.finalExit?.priceSol, "0.012");
  assert.equal(a.holdMs, 120000);
});
test("three partial/final sells preserve quantities, weighted exit price and fees across restart", () => {
  const es = [
    execution("entry", "BUY", -1010000000n, 100n, 10000000n, "1000000000", T),
    execution("p1", "SELL", 290000000n, -25n, 10000000n, "25", T + 60000),
    execution("p2", "SELL", 390000000n, -25n, 10000000n, "25", T + 120000),
    execution("final", "SELL", 790000000n, -50n, 10000000n, "50", T + 180000),
  ];
  const path = join(
    mkdtempSync(join(tmpdir(), "gmgn-lifecycle-restart-")),
    "fixture.sqlite",
  );
  let store = new Store(path);
  try {
    for (const e of es.slice(0, -1)) store.execution(e);
    const open = {
      ...accountingPosition(),
      quantity: "50",
      state: "OPEN" as const,
    };
    const partial = tradeAccounting(
      open,
      store.executions().filter((e) => e.id !== "final"),
    );
    assert.equal(partial.finalExit, null);
    assert.equal(partial.exits.length, 2);
    store.savePosition(open);
    store.close();
    store = new Store(path);
    assert.equal(store.positions("paper").length, 1);
    store.execution(es.at(-1)!);
    const restored = JSON.parse(
      JSON.stringify({
        ...open,
        quantity: "0",
        state: "CLOSED",
        sellSignature: "final",
      }),
    );
    const a = tradeAccounting(
      restored,
      JSON.parse(JSON.stringify(store.executions())),
    );
    assert.equal(a.exits.length, 3);
    assert.equal(a.finalExit?.signature, "final");
    assert.equal(a.averageExitPriceSol, "0.015");
    assert.equal(a.grossPnlLamports, "500000000");
    assert.equal(a.feesPaidLamports, "40000000");
    assert.equal(a.netPnlLamports, "460000000");
    assert.deepEqual(a, tradeAccounting(restored, store.executions()));
  } finally {
    store.close();
  }
});
test("UNKNOWN submitted SELL cannot finalize history; legacy fields stay unknown", () => {
  const es = [
    execution("entry", "BUY", -1010000000n, 100n, 10000000n, "1000000000", T),
    {
      ...execution(
        "exit",
        "SELL",
        1190000000n,
        -100n,
        10000000n,
        "100",
        T + 120000,
      ),
      state: "UNKNOWN" as const,
    },
  ];
  assert.equal(tradeAccounting(accountingPosition(), es).finalExit, null);
  const legacy = execution("old", "SELL", 1000000000n, -100n, 1n, "100", T);
  delete legacy.accounting;
  delete legacy.fx;
  const a = tradeAccounting(
    { ...accountingPosition(), quantity: "0", state: "CLOSED" },
    [es[0]!, legacy],
  );
  assert.equal(a.grossPnlLamports, null);
  assert.equal(a.netPnlLamports, null);
  assert.equal(a.finalExit?.priceUsd, null);
});
test("paper reconciliation persists lifecycle and gross MFE/MAE independently of entry fees", async () => {
  const x = setup();
  try {
    let buyInput: any, exitInput: any;
    const decide = x.j.decide.bind(x.j);
    x.j.decide = async (state, fresh) => {
      buyInput = state;
      return decide(state, fresh);
    };
    x.j.decideExit = async (state) => {
      exitInput = state;
      return {
        action: "HOLD",
        sellBps: 0,
        confidence: 0.9,
        reason: "UNCHANGED",
      };
    };
    await x.engine.analyze(MINT);
    assert(Object.hasOwn(buyInput.manipulationStructure, "evidence"));
    assert.equal(
      buyInput.manipulationStructure.policy.version,
      "CONTROLLED_MARKUP_V1",
    );
    const p = x.store.positions("paper")[0]!;
    assert(p.accounting?.entry);
    assert.equal(p.grossMaePercent, 0);
    assert.notEqual(p.entryPriceUsd, p.signalPriceUsd);
    delete p.lastQuoteAt;
    x.store.savePosition(p);
    await x.engine.monitor();
    await x.engine.settleExitWork();
    assert(exitInput?.currentPosition.accounting);
    const cp = exitInput.currentPosition;
    assert.equal(cp.grossPnlPct, cp.accounting.grossPnlPct);
    assert.equal(cp.feesPaidSol, Number(cp.accounting.feesPaidLamports) / 1e9);
    assert.equal(cp.netPnlSol, Number(cp.accounting.netPnlLamports) / 1e9);
    assert.equal(
      x.store.positions("paper")[0]!.state,
      "OPEN",
      "incurred fees do not trigger SELL",
    );
    x.engine.emergency(p.id);
    await x.engine.monitor();
    await x.engine.settleExitWork();
    const closed = x.store.positions("paper")[0]!;
    assert(closed.accounting?.finalExit);
    assert(closed.closedAt);
    assert.equal(closed.accounting.exits.length, 1);
    assert.equal(
      closed.accounting.finalExit.signature,
      closed.sellSignature ?? null,
    );
  } finally {
    await x.engine.stop();
    x.store.close();
  }
});
