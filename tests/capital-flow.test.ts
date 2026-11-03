import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { Keypair } from "@solana/web3.js";
import {
  CapitalFlowEngine,
  evolveFlow,
  normalizeFlowObservation,
  type FlowObservation,
  type CapitalFlowState,
} from "../src/capital-flow.js";
import { Store } from "../src/store.js";
import { Engine } from "../src/engine.js";
import { settingsSchema, env } from "../src/config.js";
import { parseJevExit } from "../src/jev.js";
import { provider, position, info, WALLET, MINT } from "./fixtures.js";
import { normalizeMarket, SOL } from "../src/gmgn.js";
import { CandidateRejected } from "../src/domain.js";
import { completedFixture } from "./learning-fixtures.js";

const settings = settingsSchema.parse({ smartMoneyExitMode: "OFF" });
const hold = {
  action: "HOLD" as const,
  sellBps: 0,
  confidence: 0.99,
  reason: "UNCHANGED",
};
const sell = (bps: number) => ({
  action: bps === 10000 ? ("FULL_SELL" as const) : ("PARTIAL_SELL" as const),
  sellBps: bps,
  confidence: 0.99,
  reason: "ORDER_FLOW",
});
function obs(
  net: number,
  at: number,
  extra: Partial<FlowObservation> = {},
): FlowObservation {
  return {
    at,
    window: "1m",
    priceUsd: 1,
    marketCapUsd: 1000000,
    liquidityUsd: 100000,
    volumeUsd: 300000,
    buyVolumeUsd: (300000 + net) / 2,
    sellVolumeUsd: (300000 - net) / 2,
    buys: 80,
    sells: 20,
    holders: 100,
    smartWallets: 10,
    smartMoneyBuyUsd: null,
    smartMoneySellUsd: null,
    largeBuyUsd: null,
    largeSellUsd: null,
    ...extra,
  };
}
function series(nets: number[], extra: Partial<FlowObservation> = {}) {
  let state: CapitalFlowState | undefined;
  for (const [i, net] of nets.entries())
    state = evolveFlow(
      state,
      "p",
      "mint",
      obs(net, 100000 + i * 60000, extra),
      settings,
    );
  return state!;
}
function harness(count = 1) {
  const db = new Store(":memory:");
  db.set("strategyV2", settings);
  const prices = new Map<string, number>(),
    nets = new Map<string, number>(),
    bad = new Set<string>(),
    critical = new Set<string>();
  const raw = (mint: string) => {
    const data = info(mint);
    const net = nets.get(mint) ?? 180000;
    return mint === SOL
      ? data
      : {
          ...data,
          price: {
            ...data.price,
            price: String(prices.get(mint) ?? 0.1),
            volume_1m: "300000",
            buy_volume_1m: String((300000 + net) / 2),
            sell_volume_1m: String((300000 - net) / 2),
            buys_1m: 80,
            sells_1m: 20,
          },
        };
  };
  const local = provider(async (args) => {
      if (args[0] === "token" && args[1] === "info") {
        const mint = args[args.indexOf("--address") + 1]!;
        if (bad.has(mint)) throw new CandidateRejected("TOKEN_DATA_INCOMPLETE");
        return raw(mint);
      }
    }),
    engine = new Engine(db, { gmgn: local.gmgn });
  // Fixture prices advance without wall-clock delay; explicitly request a fresh snapshot.
  const freshInfo = local.gmgn.info.bind(local.gmgn);
  local.gmgn.info = (mint) => freshInfo(mint, 0);
  const security = engine.gmgn.security.bind(engine.gmgn);
  engine.gmgn.security = async (c, s) => {
    const result = await security(c, s);
    return critical.has(c.mint)
      ? {
          ...result,
          findings: [
            {
              level: "CRITICAL",
              code: "FIXTURE_CRITICAL",
              reason: "Deterministic test",
            },
          ],
        }
      : result;
  };
  engine.jev.decideExit = async () => hold;
  engine.settings.jevExitMinIntervalMs = 0;
  engine.settings.jevExitRecheckMs = 0;
  engine.settings.jevExitTradeCooldownMs = 0;
  engine.settings.flowObservationIntervalMs = 0;
  for (let n = 0; n < count; n++)
    db.savePosition({
      ...position(),
      id: `flow-${n}`,
      mint: Keypair.generate().publicKey.toBase58(),
      mode: "paper",
      quantity: "1000000",
      originalQuantity: "1000000",
      entryAt: Date.now() - 43200000,
    });
  const p = (id = "flow-0") => db.positions("paper").find((p) => p.id === id)!;
  const observe = async () => {
    for (const p of db.positions("paper")) {
      delete p.lastQuoteAt;
      db.savePosition(p);
    }
    await engine.monitor();
    await engine.exitScheduler.idle();
  };
  return {
    db,
    engine,
    prices,
    nets,
    bad,
    critical,
    raw,
    local,
    p,
    observe,
    close: async () => {
      await engine.stop();
      db.close();
    },
  };
}
test("high volume with -140k directional imbalance is not bullish; missing smart-money flow remains unknown", () => {
  const state = series([-100000, -120000, -140000], { priceUsd: 0.9 });
  assert.equal(state.features.netFlowUsd, -140000);
  assert.ok(
    ["DISTRIBUTION", "OUTFLOW", "OUTFLOW_ACCELERATING"].includes(state.regime),
  );
  assert.equal(state.features.smartMoneyNetFlowUsd, null);
  assert.ok(state.quality.missing.includes("smartMoneyBuyUsd"));
  const raw = {
    ...info(),
    price: {
      price: "1",
      volume_1m: "300000",
      buy_volume_1m: "80000",
      sell_volume_1m: "220000",
    },
  };
  const normalized = normalizeFlowObservation(normalizeMarket(raw), raw);
  assert.equal(normalized.window, "1m");
  assert.equal(normalized.buyVolumeUsd, 80000);
  assert.equal(normalized.sellVolumeUsd, 220000);
  assert.equal(normalized.smartMoneyBuyUsd, null);
});
test("20/45/90k inflow accelerates, 100/40/5k decelerates; window changes never compare different horizons", () => {
  assert.equal(series([20000, 45000, 90000]).regime, "INFLOW_ACCELERATING");
  const slow = series([100000, 40000, 5000]);
  assert.notEqual(slow.regime, "STRONG_INFLOW");
  assert.ok(["INFLOW_DECELERATING", "DISTRIBUTION"].includes(slow.regime));
  const a = series([20000, 45000, 90000]),
    b = evolveFlow(
      a,
      "p",
      "mint",
      obs(500, 300000, { window: "24h" }),
      settings,
    );
  assert.equal(b.features.netFlowChangeUsd, null);
  assert.equal(b.regime, "INSUFFICIENT_DATA");
  assert.ok(b.confidence <= 0.4);
});
test("zero is a known observation, absent/invalid data is not zero or a bearish signal", () => {
  const raw = {
    ...info(),
    price: {
      price: "1",
      volume_1m: "0",
      buy_volume_1m: "0",
      sell_volume_1m: "0",
    },
    holder_count: " ",
  };
  const o = normalizeFlowObservation(normalizeMarket(raw), raw);
  assert.equal(o.volumeUsd, 0);
  assert.equal(o.buyVolumeUsd, 0);
  assert.equal(o.holders, null);
  assert.equal(series([0, 0, 0]).regime, "NEUTRAL");
  const state = series([0, 0, 0], {
    buyVolumeUsd: null,
    sellVolumeUsd: null,
    buys: null,
    sells: null,
  });
  assert.equal(state.features.netFlowUsd, null);
  assert.equal(state.regime, "INSUFFICIENT_DATA");
  assert.ok(state.confidence <= 0.4);
  assert.equal(state.quality.status, "DEGRADED");
});
test("hysteresis rejects tiny oscillations but promptly exposes a real negative reversal", () => {
  let state = series([180000, 180000, 180000]);
  assert.equal(state.regime, "STRONG_INFLOW");
  for (let n = 0; n < 30; n++)
    state = evolveFlow(
      state,
      "p",
      "mint",
      obs(90000, 300000 + n * 15000, {
        volumeUsd: n % 2 ? 302000 : 298000,
        buyVolumeUsd: n % 2 ? 194000 : 196000,
        sellVolumeUsd: n % 2 ? 106000 : 104000,
      }),
      settings,
    );
  const before = state.transitions.length;
  state = evolveFlow(state, "p", "mint", obs(-180000, 900000), settings);
  assert.ok(
    ["DISTRIBUTION", "OUTFLOW", "OUTFLOW_ACCELERATING"].includes(state.regime),
  );
  assert.ok(before < 10);
  assert.equal(state.transitions.at(-1)?.reason, "MATERIAL_NEGATIVE_REVERSAL");
});
test("flow retention, lookback evidence, transitions and closed-position cache are bounded", () => {
  const db = new Store(":memory:"),
    flow = new CapitalFlowEngine(db, () => settings),
    p = { ...position(), mode: "paper" as const };
  try {
    for (let n = 0; n < 500; n++) {
      const raw = {
        ...info(),
        price: {
          ...info().price,
          price: String(1 + n / 100),
          volume_1m: "3000",
          buy_volume_1m: "2000",
          sell_volume_1m: "1000",
        },
      };
      flow.observe(p, normalizeMarket(raw), raw, 100000 + n * 15000);
    }
    const state = flow.state(p.id)!;
    assert.equal(state.observations.length, 120);
    assert.ok(state.transitions.length <= 30);
    assert.ok(state.lookbacks?.["5m"]);
    assert.ok(flow.status().retainedPayloadBytes < 200000);
    flow.prune("paper", []);
    assert.equal(flow.state(p.id), undefined);
  } finally {
    db.close();
  }
});
test("structured Jev supports 20/50/75/full with descriptive thesis and no arbitrary malformed fraction", () => {
  const choice = (choice: string) => ({
    type: "choice",
    choice,
    confidence: 0.95,
    probabilities: { [choice]: 1 },
  });
  for (const [fraction, bps] of [
    ["PERCENT_20", 2000],
    ["PERCENT_50", 5000],
    ["PERCENT_75", 7500],
    ["ALL", 10000],
  ] as const) {
    const answer = parseJevExit({
      model: "jev-1.14.0",
      answers: {
        action: choice(bps === 10000 ? "FULL_SELL" : "PARTIAL_SELL"),
        sell_fraction: choice(fraction),
        primary_reason: choice("ORDER_FLOW"),
        data_sufficiency: { type: "noul", noul: 1 },
        thesis: choice("DE_RISK_PRESERVE_RUNNER"),
        flow_assessment: choice("WEAKENING"),
      },
    });
    assert.equal(answer.sellBps, bps);
    assert.equal(answer.thesis, "DE_RISK_PRESERVE_RUNNER");
  }
});
test("strong runner HOLD remains valid through +30/+100/x3/x5/x10/x20 and long negative holds", async () => {
  const h = harness();
  try {
    for (const percent of [30, 100, 200, 400, 900, 1900, -70]) {
      h.prices.set(h.p().mint, (0.1 * (100 + percent)) / 100);
      await h.observe();
      await h.engine.processExits();
      assert.equal(h.p().quantity, "1000000");
      assert.equal(h.db.executions().length, 0);
      assert.equal(h.p().jevExit?.action, "HOLD");
    }
    assert.equal("maxHoldSeconds" in h.engine.settings, false);
  } finally {
    await h.close();
  }
});
test("fresh decisions sell 20%, preserve runner on HOLD, then sell 50% of the remaining and finally full", async () => {
  const h = harness();
  try {
    h.prices.set(h.p().mint, 0.118);
    h.engine.jev.decideExit = async () => sell(2000);
    await h.observe();
    await h.engine.processExits();
    assert.equal(h.p().quantity, "800000");
    assert.equal(h.db.executions()[0]?.intent.amount, "200000");
    assert.equal(h.p().lastValueLamports, "944000");
    assert.equal(h.p().lastQuoteAt, undefined);
    assert.equal(h.p().valuationStatus, "ESTIMATED_AFTER_FILL");
    h.engine.jev.decideExit = async () => hold;
    h.prices.set(h.p().mint, 0.16);
    await h.observe();
    await h.engine.processExits();
    assert.equal(h.p().quantity, "800000");
    h.engine.jev.decideExit = async () => sell(5000);
    await h.observe();
    await h.engine.processExits();
    assert.equal(h.db.executions()[1]?.intent.amount, "400000");
    assert.equal(h.p().quantity, "400000");
    h.prices.set(h.p().mint, 0.25);
    h.engine.jev.decideExit = async () => sell(10000);
    await h.observe();
    await h.engine.processExits();
    assert.equal(h.p().state, "CLOSED");
  } finally {
    await h.close();
  }
});
test("trade cooldown keeps a repeated partial opinion from over-trading unchanged exposure signals", async () => {
  const h = harness();
  try {
    h.engine.settings.jevExitTradeCooldownMs = 60000;
    h.engine.jev.decideExit = async () => sell(2000);
    await h.observe();
    await h.engine.processExits();
    await h.observe();
    await h.engine.processExits();
    assert.equal(h.db.executions().length, 1);
    assert.equal(h.p().quantity, "800000");
    assert.equal(h.p().jevExit?.status, "CANCELLED");
    assert.equal(h.p().jevExit?.action, "PARTIAL_SELL");
  } finally {
    await h.close();
  }
});
test("manual partial has priority; critical protection then precedes older liquidity protection", async () => {
  const h = harness(2);
  try {
    await h.observe();
    const p = h.p();
    p.pendingExits = [
      {
        id: "old",
        kind: "PROTECTIVE",
        reason: "GMGN liquidity removal/collapse",
        sellBps: 10000,
        triggeredAt: 1,
      },
      {
        id: "critical",
        kind: "PROTECTIVE",
        reason: "Critical GMGN security deterioration",
        sellBps: 10000,
        triggeredAt: 2,
      },
    ];
    h.db.savePosition(p);
    h.critical.add(p.mint);
    h.engine.emergency("flow-1", 5000);
    await h.engine.processExits();
    assert.deepEqual(
      h.db.executions().map((e) => e.intent.positionId),
      ["flow-1", "flow-0"],
    );
  } finally {
    await h.close();
  }
});
test("20 mixed positions get independent market/flow work; source failure and Jev outage remain isolated", async () => {
  const h = harness(20);
  try {
    for (let n = 1; n < 20; n++) {
      const p = h.p(`flow-${n}`);
      const history =
        n % 3 === 0
          ? [20000, 45000, 90000]
          : n % 3 === 1
            ? [100000, 40000, 5000]
            : [-100000, -120000, -140000];
      for (const [i, net] of history.entries()) {
        h.nets.set(p.mint, net);
        const raw = h.raw(p.mint);
        h.engine.capitalFlow.observe(
          p,
          normalizeMarket(raw),
          raw,
          Date.now() - 180000 + i * 60000,
        );
      }
    }
    h.bad.add(h.p().mint);
    h.critical.add(h.p("flow-17").mint);
    const back = h.p("flow-18");
    back.attention = {
      status: "NEEDS_ATTENTION",
      issue: {
        code: "TOKEN_SAFETY_FAILED",
        scope: "POSITION",
        mint: back.mint,
        stage: "PRE_SELL",
        reasonCode: "SIMULATED_BALANCE_MISMATCH",
        retryable: true,
        detectedAt: Date.now(),
      },
      lastChecked: Date.now(),
      nextCheckAt: Date.now() + 1800000,
      failureCount: 3,
      protectiveExit: "BACKOFF",
    };
    h.db.savePosition(back);
    h.engine.jev.decideExit = async (state) => {
      const id = (state as { currentPosition: { id: string } }).currentPosition
        .id;
      if (id === "flow-19") throw new Error("fixture Jev unavailable");
      return id === "flow-2"
        ? sell(2000)
        : id === "flow-3"
          ? sell(5000)
          : id === "flow-4"
            ? sell(10000)
            : hold;
    };
    h.engine.rpc.balance = async () => {
      throw Error("Flow must not poll RPC");
    };
    h.engine.rpc.tokenBalance = async () => {
      throw Error("Flow must not poll RPC");
    };
    await h.observe();
    assert.equal(h.db.positions("paper").filter((p) => p.flow).length, 19);
    assert.ok(
      new Set(h.db.positions("paper").map((p) => p.flow?.regime)).size >= 3,
    );
    assert.equal(h.p().monitoring?.status, "DEGRADED");
    assert.equal(h.p("flow-18").monitoring?.status, "ACTIVE");
    assert.equal(h.p("flow-18").attention?.protectiveExit, "BACKOFF");
    assert.ok(h.p("flow-18").flow!.quality.observations >= 4);
    assert.equal(h.p("flow-19").lastAnalystAttempt?.action, "NO_DECISION");
    h.engine.emergency("flow-5", 5000);
    for (let n = 0; n < 5; n++) await h.engine.processExits();
    assert.equal(h.p("flow-2").quantity, "800000");
    assert.equal(h.p("flow-3").quantity, "500000");
    assert.equal(h.p("flow-4").state, "CLOSED");
    assert.equal(h.p("flow-17").state, "CLOSED");
    assert.equal(h.db.get("haltReason"), undefined);
  } finally {
    await h.close();
  }
});
test("runner evidence retains observed milestones, checkpoints, partial exposure and retrievable closed examples", () => {
  const h = harness(0);
  try {
    const f = completedFixture(h.engine.memory, {
        mode: "paper",
        close: false,
        observations: [],
      }),
      p = {
        ...f.position,
        decimals: 6,
        entryMarketCap: 1000000,
        initialLiquidity: 100000,
      };
    let state = series([20000, 45000, 90000]);
    const at = Date.now();
    const market = (price: number) =>
      normalizeMarket({ ...info(p.mint), price: { price: String(price) } });
    h.engine.memory.runner.observe(p, market(2), state, at);
    const decision = {
      id: "runner-hold",
      positionId: p.id,
      mint: p.mint,
      createdAt: at,
      inputAt: at,
      inputPriceUsd: 2,
      model: "jev-1.14.0" as const,
      action: "HOLD" as const,
      sellBps: 0,
      confidence: 0.9,
      reason: "UNCHANGED",
      inputHash: "test",
      quantity: p.quantity,
      inputValueLamports: "2000000000",
      status: "DECIDED" as const,
      observedFlow: state,
    };
    h.engine.memory.runner.decision(decision, p);
    h.engine.memory.runner.observe(p, market(7), state, at + 60000);
    h.engine.memory.runner.observe(
      { ...p, quantity: "800000" },
      market(11),
      state,
      at + 300000,
    );
    const runner = h.engine.memory.runner.state(p.id)!;
    assert.equal(runner.milestones["900"]?.firstObservedAt, at + 300000);
    assert.equal(runner.marketMultiple, 11);
    assert.equal(runner.remainingExposureBps, 8000);
    assert.equal(runner.reviews[0]?.checkpoints["60"]?.state, "OBSERVED");
    assert.equal(runner.reviews[0]?.checkpoints["300"]?.state, "OBSERVED");
    assert.equal(runner.milestones["1900"], undefined);
    h.engine.memory.runner.observe(p, market(9), state, at + 1000000);
    assert.equal(
      h.engine.memory.runner.state(p.id)?.reviews[0]?.checkpoints["900"]?.state,
      "UNAVAILABLE",
    );
    // Complete the same synthetic traded position; historical retrieval is only after a real fill ledger exists in this RAM fixture.
    h.db.savePosition(p);
    const e = h.db.claim(
      h.engine.executor.sellIntent(p, 1000000n, "ORDER_FLOW", settings),
    );
    e.state = "CONFIRMED";
    e.at = at + 1000001;
    e.evidence = {
      solDelta: "1100000000",
      tokenDelta: "-1000000",
      feeLamports: "5000",
      slot: 2,
    };
    h.db.execution(e);
    h.db.savePosition({
      ...p,
      state: "CLOSED",
      quantity: "0",
      realizedLamports: "100000000",
    });
    h.engine.memory.confirmed(e);
    state = { ...state, regime: "INFLOW_ACCELERATING" };
    const similar = h.engine.memory.runner.similar(
      {
        ...position(),
        mode: "paper",
        mint: MINT,
        entryMarketCap: 1000000,
        initialLiquidity: 100000,
        mfePercent: 0,
        flow: state,
      },
      state,
      at + 1001000,
    );
    assert.ok(similar.examples.length > 0);
    assert.equal(similar.confidence, "INSUFFICIENT");
  } finally {
    h.db.close();
  }
});
test("manual revision rejects a delayed full-sell opinion even when quantity has not changed", async () => {
  const h = harness();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  h.engine.jev.decideExit = async () => {
    await gate;
    return sell(10000);
  };
  try {
    await h.engine.monitor();
    h.engine.emergency(h.p().id, 5000);
    release();
    await h.engine.exitScheduler.idle();
    assert.equal(h.db.jevExits()[0]?.status, "SUPERSEDED");
    assert.equal(h.p().quantity, "1000000");
    await h.engine.processExits();
    assert.equal(h.p().quantity, "500000");
    assert.equal(h.db.executions().length, 1);
    assert.ok(h.db.executions()[0]?.intent.manualRequestId);
  } finally {
    release();
    await h.close();
  }
});

test("a claimed 20% SELL stays frozen while UNKNOWN and fresh flow cannot enqueue a replacement", async () => {
  const h = harness();
  h.engine.jev.decideExit = async () => sell(2000);
  try {
    await h.observe();
    // Stop at the persisted transaction boundary. No signer/network is involved.
    h.engine.executor.execute = async (intent) => {
      const e = h.db.claim(intent);
      e.state = "UNKNOWN";
      e.signature = "fixture-unknown-frozen-20";
      e.before = { sol: "1000", tokens: "1000000" };
      h.db.execution(e);
      return e;
    };
    await h.engine.processExits();
    const frozen = h.db.executions()[0]!;
    assert.equal(frozen.intent.amount, "200000");
    assert.equal(h.p().state, "PENDING_EXIT");
    h.nets.set(h.p().mint, -200000);
    await h.observe();
    assert.equal(h.db.executions().length, 1);
    assert.equal(h.db.executions()[0]!.intent.amount, "200000");
    assert.equal(h.db.jevExits().length, 1);
    assert.equal(h.p().quantity, "1000000");
    assert.ok(h.p().flow);
  } finally {
    await h.close();
  }
});

test("three unsigned SELL failures are execution diagnostics, never three losses or reduced exposure", async () => {
  const h = harness(0);
  try {
    const f = completedFixture(h.engine.memory, {
      mode: "paper",
      close: false,
      observations: [],
    });
    const p = f.position;
    for (let n = 0; n < 3; n++) {
      const e = h.db.claim(
        h.engine.executor.sellIntent(p, 200000n, "ORDER_FLOW", settings),
      );
      e.state = "FAILED";
      e.error = "TOKEN_SAFETY_FAILED";
      h.db.execution(e);
      h.engine.memory.failure(e);
      h.db.savePosition({ ...p, state: "OPEN" });
    }
    assert.equal(
      Number(
        h.db.db
          .prepare("SELECT count(*) n FROM trade_execution_failures")
          .get()!.n,
      ),
      3,
    );
    assert.equal(
      Number(h.db.db.prepare("SELECT count(*) n FROM trade_outcomes").get()!.n),
      0,
    );
    assert.equal(
      Number(
        h.db.db
          .prepare(
            "SELECT count(*) n FROM trade_execution_evidence WHERE json_extract(payload,'$.side')='SELL'",
          )
          .get()!.n,
      ),
      0,
    );
    assert.equal(h.db.positions("paper")[0]!.quantity, "1000000");
    assert.equal(h.db.positions("paper")[0]!.realizedLamports, "0");
  } finally {
    await h.close();
  }
});

test("50 positions finish monitoring while Jev waits; flow storage and work remain bounded over 130 observations", async () => {
  const h = harness(50);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let active = 0,
    peakActive = 0;
  h.engine.jev.decideExit = async () => {
    active++;
    peakActive = Math.max(peakActive, active);
    await gate;
    active--;
    return hold;
  };
  const bytes = () =>
    Number(h.db.db.prepare("PRAGMA page_count").get()!.page_count) *
    Number(h.db.db.prepare("PRAGMA page_size").get()!.page_size);
  const beforeBytes = bytes(),
    beforeHeap = process.memoryUsage().heapUsed;
  const started = performance.now();
  try {
    await h.engine.monitor();
    const monitorMs = performance.now() - started;
    assert.equal(
      h.db.positions("paper").filter((p) => p.lastQuoteAt).length,
      50,
    );
    assert.equal(h.engine.exitScheduler.status().active, 2);
    assert.equal(h.engine.exitScheduler.status().queued, 48);
    const gmgnCalls = h.local.calls.length;
    release();
    await h.engine.exitScheduler.idle();
    assert.equal(peakActive, 2);
    assert.equal(h.engine.exitScheduler.status().completed, 50);
    const flowStarted = performance.now(),
      positions = h.db.positions("paper"),
      now = Date.now();
    for (let tick = 1; tick <= 130; tick++)
      for (const p of positions) {
        const raw = h.raw(p.mint);
        h.engine.capitalFlow.observe(
          p,
          normalizeMarket(raw),
          raw,
          now + tick * 15000,
        );
      }
    const flowMs = performance.now() - flowStarted;
    assert.equal(
      h.local.calls.length,
      gmgnCalls,
      "Flow calculation itself makes no provider calls",
    );
    assert.ok(
      positions.every(
        (p) => h.engine.capitalFlow.state(p.id)!.observations.length === 120,
      ),
    );
    const fullBytes = bytes();
    for (let tick = 131; tick <= 150; tick++)
      for (const p of positions) {
        const raw = h.raw(p.mint);
        h.engine.capitalFlow.observe(
          p,
          normalizeMarket(raw),
          raw,
          now + tick * 15000,
        );
      }
    assert.ok(
      bytes() - fullBytes < 1024 * 1024,
      "Replacing bounded rows does not grow with every observation",
    );
    if (process.env.KEEP_TEST_ARTIFACTS === "true")
      writeFileSync(
        "data/capital-flow-performance.json",
        JSON.stringify(
          {
            basis:
              "Deterministic RAM SQLite and fixture GMGN/Jev; no network, signing or live execution. Wall time is host-specific, not provider latency.",
            at: new Date().toISOString(),
            positions: 50,
            monitorMs,
            gmgnCalls,
            gmgnCallsByCommand: Object.fromEntries(
              [
                ...new Set(h.local.calls.map((c) => c.slice(0, 2).join(" "))),
              ].map((k) => [
                k,
                h.local.calls.filter((c) => c.slice(0, 2).join(" ") === k)
                  .length,
              ]),
            ),
            flowObservationsMeasured: 6500,
            flowMs,
            peakJevConcurrency: peakActive,
            jev: h.engine.exitScheduler.status(),
            flow: h.engine.capitalFlow.status(),
            databaseBeforeBytes: beforeBytes,
            databaseAtRetentionBytes: fullBytes,
            databaseFinalBytes: bytes(),
            heapDeltaBytes: process.memoryUsage().heapUsed - beforeHeap,
          },
          null,
          2,
        ),
      );
  } finally {
    release();
    await h.close();
  }
});

test("overlapping exit reconciliation and recovery share one receipt request and preserve confirmed manual consumption", async () => {
  const old = { mode: env.TRADING_MODE, wallet: env.WALLET_PUBLIC_KEY };
  env.TRADING_MODE = "live";
  env.WALLET_PUBLIC_KEY = WALLET;
  const db = new Store(":memory:"),
    engine = new Engine(db, { gmgn: provider().gmgn });
  let release!: (value: unknown) => void;
  let calls = 0;
  try {
    const p = position();
    db.savePosition(p);
    engine.emergency(p.id, 5000);
    const r = db.manualRequests()[0]!,
      e = db.claim({
        ...engine.executor.sellIntent(
          p,
          500n,
          "Manual emergency exit",
          settings,
        ),
        manualRequestId: r.id,
      });
    e.signature = "fixture-signed-unknown";
    e.before = { sol: "1000", tokens: "1000" };
    e.state = "UNKNOWN";
    db.execution(e);
    engine.rpc.receipt = async () => {
      calls++;
      return (await new Promise<unknown>(
        (resolve) => (release = resolve),
      )) as never;
    };
    engine.rpc.deltas = () => ({
      sol: 100n,
      tokens: -500n,
      beforeSol: 1000n,
      afterSol: 1100n,
      beforeTokens: 1000n,
      afterTokens: 500n,
    });
    engine.rpc.balance = async () => 1100n;
    engine.rpc.tokenBalance = async () => 500n;
    const a = engine.processExits(),
      b = engine.executor.recover(settings);
    assert.equal(calls, 1);
    release({
      transaction: { signatures: [e.signature] },
      meta: { err: null, fee: 5 },
      slot: 10,
    });
    await Promise.all([a, b]);
    assert.equal(db.executions()[0]?.state, "CONFIRMED");
    assert.equal(db.manualRequests()[0]?.state, "CONFIRMED");
    assert.equal(db.positions()[0]?.quantity, "500");
    await engine.executor.reconcile(structuredClone(e), settings);
    assert.equal(calls, 1);
    assert.equal(
      Number(db.db.prepare("SELECT count(*) n FROM execution_fills").get()!.n),
      1,
    );
  } finally {
    await engine.stop();
    db.close();
    env.TRADING_MODE = old.mode;
    env.WALLET_PUBLIC_KEY = old.wallet;
  }
});
