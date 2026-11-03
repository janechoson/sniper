import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluateExitSafety,
  validProtection,
  protectiveRetry,
  routeMateriallyChanged,
  securityRecoveryConfirmed,
  exitPriority,
} from "../src/exit-safety.js";
import { JevExitScheduler } from "../src/jev-exit-scheduler.js";
import { Jev, parseJevExit } from "../src/jev.js";
import { env, settingsSchema } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import { Solana } from "../src/solana.js";
import {
  CandidateRejected,
  Blocked,
  ProviderFailure,
  type Position,
  type JevExitDecision,
} from "../src/domain.js";
import {
  position,
  provider,
  info,
  securityRaw,
  MINT,
  WALLET,
  quote,
  settings,
  seedEntryAccounting,
} from "./fixtures.js";
import { normalizeMarket, normalizeSecurity } from "../src/gmgn.js";
import { PositionHistoryMonitor } from "../src/position-history-monitor.js";
import {
  parseMarketHistory,
  type MarketHistory,
} from "../src/market-history.js";
import type { CapitalFlowSummary } from "../src/capital-flow.js";
import type { SolanaExecutionProvider } from "../src/execution-provider.js";
import { positionViews } from "../src/position-view.js";
const S = settingsSchema.parse({ ...settings, smartMoneyExitMode: "OFF" });
const hold = {
  action: "HOLD" as const,
  sellBps: 0,
  confidence: 0.9,
  reason: "UNCHANGED",
};
function raw(price = "10", liquidity = 100, negative = true, at = Date.now()) {
  const x = info(MINT);
  return {
    ...x,
    liquidity,
    price: {
      ...x.price,
      price,
      buy_volume_1m: negative ? 1 : 20,
      sell_volume_1m: negative ? 20 : 1,
    },
    _gmgnSnapshot: { fetchedAt: at },
  };
}
function flow(at = Date.now(), negative = true): CapitalFlowSummary {
  return {
    at,
    signalKey: negative ? "negative" : "positive",
    regime: negative ? "OUTFLOW_ACCELERATING" : "STRONG_INFLOW",
    features: {
      netFlowUsd: negative ? -19 : 19,
      buyPressure: negative ? 0.1 : 0.9,
    },
    quality: { status: "READY", stale: false },
  } as CapitalFlowSummary;
}
function history(recovery = false, at = Date.now()): MarketHistory {
  const end = Math.floor(at / 60000) * 60000;
  const base = Array.from({ length: 8 }, (_, i) => ({
    open: 10 + i * 0.2,
    close: 10 + (i + 1) * 0.2,
    low: 10 + i * 0.2 - 0.02,
    high: 10 + (i + 1) * 0.2 + 0.02,
  }));
  const tail = recovery
    ? [
        { open: 11.6, close: 9, low: 8.8, high: 11.7 },
        { open: 9, close: 11.5, low: 8.9, high: 11.6 },
        { open: 11.5, close: 11.9, low: 11.4, high: 12 },
      ]
    : [
        { open: 11.6, close: 9, low: 8.8, high: 11.7 },
        { open: 9, close: 9.3, low: 8.9, high: 9.6 },
        { open: 9.3, close: 8.6, low: 8.5, high: 9.4 },
      ];
  return parseMarketHistory(
    {
      list: [...base, ...tail].map((c, i) => ({
        ...c,
        time: end - (11 - i) * 60000,
        volume: 1000,
      })),
      _gmgnSnapshot: { fetchedAt: at },
    },
    { mint: MINT, source: "POSITION", discoveredAt: end - 3600000 },
    at,
  );
}
function evidence(recovery = false, negative = true, at = Date.now()) {
  const p = { ...position(), initialLiquidity: 100, flow: flow(at, negative) };
  return evaluateExitSafety(p, S, {
    history: history(recovery, at),
    market: normalizeMarket(raw("10", 100, negative, at)),
    now: at,
  });
}
test("staircase, floor break, failed recovery and fresh outflow create typed independent protection", () => {
  const r = evidence();
  assert(r.components.price.breakdown);
  assert(
    r.authorities.some((a) => a.kind === "MANIPULATION_STRUCTURE_BREAKDOWN"),
  );
  assert.equal(r.authorities[0]?.sellBps, 10000);
  assert(r.authorities[0]?.evidence);
  assert(!JSON.stringify(r).includes("RUG_CONFIRMED"));
});
for (const [name, recovery, negative] of [
  ["healthy pullback recovery", true, true],
  ["single red and immediate recovery with healthy flow", true, false],
  ["downside price without flow confirmation", false, false],
] as const)
  test(name + " cannot independently authorize", () =>
    assert.equal(evidence(recovery, negative).authorities.length, 0),
  );
test("PnL, fees, MAE, age, one red candle and outflow alone are never protective authority", () => {
  const p = {
    ...position(),
    costLamports: "1000000000000",
    realizedLamports: "-99999999999",
    grossMaePercent: -99,
    entryAt: 1,
    flow: flow(),
    initialLiquidity: 100,
  };
  const r = evaluateExitSafety(p, S, { market: normalizeMarket(raw()) });
  assert.equal(r.authorities.length, 0);
  assert.equal(r.components.price.state, "UNAVAILABLE");
  const h = history();
  h.candles = h.candles.slice(-1);
  assert.equal(evaluateExitSafety(p, S, { history: h }).authorities.length, 0);
});
test("stale or gapped M1 and insufficient flow cannot masquerade as fresh collapse", () => {
  const p = { ...position(), flow: flow() },
    h = history();
  h.fetchedAt = Date.now() - 86400000;
  assert.equal(
    evaluateExitSafety(p, S, { history: h }).components.price.state,
    "STALE",
  );
  assert.equal(evaluateExitSafety(p, S, { history: h }).authorities.length, 0);
  const gap = history();
  gap.candles.splice(6, 1);
  assert.equal(
    evaluateExitSafety(p, S, { history: gap }).components.price.state,
    "INSUFFICIENT",
  );
  p.flow.quality.status = "WARMING_UP";
  assert.equal(
    evaluateExitSafety(p, S, { history: history() }).authorities.length,
    0,
  );
});
for (const name of [
  "volatile consolidation",
  "organic bullish retracement",
] as const)
  test(name + " is not structural emergency", () => {
    const at = Date.now(),
      end = Math.floor(at / 60000) * 60000;
    let value = 10;
    const candles = Array.from({ length: 12 }, (_, i) => {
      const open = value;
      value += [0.5, -0.4, 0.3, -0.2][i % 4]!;
      return {
        open,
        close: value,
        high: Math.max(open, value) + 0.3,
        low: Math.min(open, value) - 0.3,
        time: end - (12 - i) * 60000,
        volume: 1000,
      };
    });
    const h = parseMarketHistory(
      { list: candles, _gmgnSnapshot: { fetchedAt: at } },
      { mint: MINT, source: "POSITION", discoveredAt: at - 3600000 },
      at,
    );
    assert.equal(
      evaluateExitSafety({ ...position(), flow: flow(at) }, S, {
        history: h,
        market: normalizeMarket(raw("10", 100, true, at)),
        now: at,
      }).authorities.length,
      0,
    );
  });
test("temporary outflow followed by fresh current inflow, one missing GMGN cycle and route-only degradation do not create emergency", () => {
  const p = { ...position(), flow: flow() };
  assert.equal(
    evaluateExitSafety(p, S, {
      history: history(),
      market: normalizeMarket(raw("10", 100, false)),
    }).authorities.length,
    0,
  );
  assert.equal(evaluateExitSafety(p, S, {}).authorities.length, 0);
});
test("liquidity detection independent of price, FX, decimals and accounting; strict existing boundary", () => {
  const p = { ...position(), initialLiquidity: 100, decimals: undefined };
  for (const liquidity of [49, 50]) {
    const data = raw("", liquidity);
    const r = evaluateExitSafety(p, S, { market: normalizeMarket(data) });
    assert.equal(
      r.authorities.some((a) => a.kind === "LIQUIDITY_COLLAPSE"),
      liquidity === 49,
    );
  }
  assert.equal(
    evaluateExitSafety({ ...p, initialLiquidity: undefined }, S, {
      market: normalizeMarket(raw("", 0)),
    }).authorities.length,
    0,
  );
  const missing = normalizeMarket(raw("", 0));
  missing.liquidity = { state: "UNKNOWN", reason: "fixture" };
  assert.equal(
    evaluateExitSafety(p, S, { market: missing }).authorities.length,
    0,
  );
});
const choice = (v: string) => ({
  type: "choice",
  choice: v,
  confidence: 0.9,
  probabilities: { [v]: 1 },
});
const response = () => ({
  model: "jev-1.14.0",
  answers: {
    action: choice("HOLD"),
    sell_fraction: choice("NONE"),
    primary_reason: choice("UNCHANGED"),
    data_sufficiency: { type: "noul", noul: 0.9 },
  },
});
test("affirmative valid HOLD stays DECIDED_HOLD; insufficient response preserves raw analyst rather than HOLD", () => {
  const r = response();
  assert.equal(parseJevExit(r).decisionState, "DECIDED_HOLD");
  r.answers.data_sufficiency.noul = 0.1;
  const d = parseJevExit(r);
  assert.equal(d.action, "NO_DECISION");
  assert.equal(d.decisionState, "NO_DECISION_INSUFFICIENT_DATA");
  assert.equal(d.analystResponse.answers.action.choice, "HOLD");
});
for (const [name, error, state] of [
  [
    "timeout",
    new ProviderFailure("JEV_EXIT_TIMEOUT", "JEV_EXIT"),
    "NO_DECISION_TIMEOUT",
  ],
  ["network", new Error("network failed"), "NO_DECISION_PROVIDER_FAILURE"],
  [
    "429",
    new ProviderFailure("JEV_EXIT_HTTP_429", "JEV_EXIT"),
    "NO_DECISION_PROVIDER_FAILURE",
  ],
  [
    "500",
    new ProviderFailure("JEV_EXIT_HTTP_500", "JEV_EXIT"),
    "NO_DECISION_PROVIDER_FAILURE",
  ],
  [
    "invalid JSON",
    new ProviderFailure("JEV_EXIT_INVALID_RESPONSE", "JEV_EXIT"),
    "NO_DECISION_INVALID_RESPONSE",
  ],
] as const)
  test(
    "analyst " + name + " is NO_DECISION, never affirmative HOLD",
    async () => {
      const results: JevExitDecision[] = [],
        j = new Jev();
      j.decideExit = async () => {
        throw error;
      };
      const scheduler = new JevExitScheduler(
        j,
        () => S,
        (d) => results.push(d),
      );
      scheduler.schedule({
        positionId: "A",
        mint: MINT,
        quantity: "1",
        value: "100",
        state: {},
        queuedAt: Date.now(),
        priority: 0,
      });
      await scheduler.idle();
      assert.equal(results[0]?.action, "NO_DECISION");
      assert.equal(results[0]?.decisionState, state);
      await scheduler.stop();
    },
  );
test("invalid schema/action and low confidence have explicit non-HOLD states", async () => {
  const j = new Jev(),
    results: JevExitDecision[] = [],
    scheduler = new JevExitScheduler(
      j,
      () => S,
      (d) => results.push(d),
    );
  for (const kind of ["schema", "unknown", "low"]) {
    j.decideExit = async () => {
      if (kind === "schema") {
        const r = response();
        delete (r.answers.action as any).confidence;
        return parseJevExit(r);
      }
      return {
        action: kind === "unknown" ? "SELL_NOW" : "FULL_SELL",
        sellBps: 10000,
        confidence: kind === "low" ? 0.1 : 0.9,
        reason: "ORDER_FLOW",
      } as any;
    };
    scheduler.schedule({
      positionId: kind,
      mint: MINT,
      quantity: "1",
      value: "100",
      state: { kind },
      queuedAt: Date.now(),
      priority: 0,
    });
    await scheduler.idle();
  }
  assert.deepEqual(
    results.map((d) => d.decisionState),
    [
      "NO_DECISION_SCHEMA_FAILURE",
      "NO_DECISION_SCHEMA_FAILURE",
      "NO_DECISION_LOW_CONFIDENCE",
    ],
  );
  assert(results.every((d) => d.action === "NO_DECISION"));
  await scheduler.stop();
});
test("A active with B/C material events yields one coalesced latest C rerun, bounded per-position", async () => {
  const j = new Jev(),
    s = { ...S, jevExitConcurrency: 1 },
    seen: number[] = [],
    results: JevExitDecision[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  j.decideExit = async (state) => {
    const n = (state as any).n;
    seen.push(n);
    if (n === 1) await gate;
    return hold;
  };
  const scheduler = new JevExitScheduler(
    j,
    () => s,
    (d) => results.push(d),
  );
  const job = (n: number) => ({
    positionId: "A",
    mint: MINT,
    quantity: "1",
    value: "100",
    state: { n },
    materialKey: String(n),
    queuedAt: Date.now(),
    priority: 0,
  });
  try {
    scheduler.schedule(job(1));
    assert(scheduler.schedule(job(2)));
    assert(scheduler.schedule(job(3)));
    assert.equal(scheduler.status().dirty, 1);
    release();
    await scheduler.idle();
    assert.deepEqual(seen, [1, 3]);
    assert.equal(results.length, 2);
  } finally {
    release();
    await scheduler.stop();
  }
});
test("dirty state that returns to active material state cannot leave an obsolete collapse rerun", async () => {
  const j = new Jev(),
    seen: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  j.decideExit = async (state) => {
    seen.push((state as any).n);
    await gate;
    return hold;
  };
  const scheduler = new JevExitScheduler(
    j,
    () => ({ ...S, jevExitConcurrency: 1 }),
    () => {},
  );
  const job = (n: number) => ({
    positionId: "A",
    mint: MINT,
    quantity: "1",
    value: "100",
    state: { n },
    materialKey: String(n),
    queuedAt: Date.now(),
    priority: 0,
  });
  try {
    scheduler.schedule(job(1));
    scheduler.schedule(job(2));
    scheduler.schedule(job(1));
    assert.equal(scheduler.status().dirty, 0);
    release();
    await scheduler.idle();
    assert.deepEqual(seen, [1]);
  } finally {
    release();
    await scheduler.stop();
  }
});
test("bounded M1 monitor caps 100 queued Positions, one active, global 15s cadence and cache60s", async () => {
  const g = provider().gmgn;
  let calls = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  g.marketHistory = async (_p, cache) => {
    calls++;
    assert.equal(cache, 60000);
    await gate;
    return { list: [], _gmgnSnapshot: { fetchedAt: Date.now() } };
  };
  const lane = new PositionHistoryMonitor(
      g,
      () => {},
      () => true,
    ),
    now = Date.now();
  try {
    for (let i = 0; i < 1000; i++)
      lane.schedule({ ...position(), id: String(i) }, now);
    assert.equal(lane.status().queued, 100);
    lane.pump(now);
    lane.pump(now + 15000);
    assert.equal(calls, 1);
    release();
    await new Promise<void>((r) => setImmediate(r));
    lane.pump(now + 1000);
    assert.equal(calls, 1);
    lane.pump(now + 15000);
    assert.equal(calls, 2);
  } finally {
    release();
    await lane.stop();
  }
});
test("security recovery needs explicit disproof of the critical fact; omitted rug field is not recovery; typed priority ignores labels", () => {
  const p = position(),
    at = Date.now(),
    old = normalizeSecurity(
      { ...securityRaw, rug_ratio: 0.9, _gmgnSnapshot: { fetchedAt: at } },
      { mint: MINT, source: "POSITION", discoveredAt: at },
      S,
    );
  const proof = evaluateExitSafety(p, S, { security: old, now: at })
    .authorities[0]!;
  const missing = normalizeSecurity(
    { ...securityRaw, rug_ratio: undefined },
    { mint: MINT, source: "POSITION", discoveredAt: at },
    S,
  );
  const recovered = normalizeSecurity(
    { ...securityRaw, rug_ratio: 0.1 },
    { mint: MINT, source: "POSITION", discoveredAt: at },
    S,
  );
  assert.equal(securityRecoveryConfirmed(proof, missing, S), false);
  assert.equal(securityRecoveryConfirmed(proof, recovered, S), true);
  const liquidity = evaluateExitSafety({ ...p, initialLiquidity: 100 }, S, {
    market: normalizeMarket(raw("", 10)),
  }).authorities[0]!;
  const o = {
    id: "x",
    kind: "PROTECTIVE" as const,
    reason: "irrelevant lower-case",
    sellBps: 10000,
    triggeredAt: at,
  };
  assert(
    exitPriority(undefined, { ...o, protection: proof }) <
      exitPriority(undefined, {
        ...o,
        reason: "Critical fake label",
        protection: liquidity,
      }),
  );
});

function harness(count = 1) {
  const db = new Store(":memory:");
  db.set("strategyV2", S);
  let liquidity = 100,
    price = "0.1",
    auth = false,
    critical = false;
  const g = provider(async (args) => {
    if (args[1] === "security") {
      if (auth)
        throw new ProviderFailure("GMGN_AUTHORIZATION_FAILED", "GMGN", false);
      return { ...securityRaw, renounced_freeze_account: !critical };
    }
    if (args[1] === "info")
      return {
        ...raw(price, liquidity),
        address: args[args.indexOf("--address") + 1],
      };
  }).gmgn;
  const e = new Engine(db, { gmgn: g });
  e.jev.decideExit = async () => hold;
  (e as any).solPrice = "100";
  for (let i = 0; i < count; i++) {
    const p = {
      ...position(),
      id: "safety-" + i,
      mint: i ? WALLET : MINT,
      mode: "paper" as const,
      initialLiquidity: 100,
      quantity: "1000000",
      originalQuantity: "1000000",
    };
    db.savePosition(p);
    seedEntryAccounting(db, p);
  }
  return {
    db,
    e,
    g,
    p: () => db.positions("paper")[0]!,
    set: (v: {
      liquidity?: number;
      price?: string;
      auth?: boolean;
      critical?: boolean;
    }) => {
      liquidity = v.liquidity ?? liquidity;
      price = v.price ?? price;
      auth = v.auth ?? auth;
      critical = v.critical ?? critical;
    },
    close: async () => {
      await e.stop();
      db.close();
    },
  };
}
test("known collapsed liquidity survives missing token price or unavailable SOL valuation", async () => {
  for (const kind of ["price", "FX"]) {
    const h = harness();
    try {
      h.set({ liquidity: 10, price: kind === "price" ? "" : "0.1" });
      if (kind === "FX")
        h.e.solUsd = async () => {
          throw new Error("fixture FX unavailable");
        };
      await h.e.monitor();
      assert(
        h
          .p()
          .pendingExits?.some(
            (o) => o.protection?.kind === "LIQUIDITY_COLLAPSE",
          ),
      );
    } finally {
      await h.close();
    }
  }
});
test("failed analyst alone preserves still-valid unsigned strategic SELL and records failure separately", async () => {
  const h = harness();
  try {
    h.e.jev.decideExit = async () => ({
      ...hold,
      action: "FULL_SELL",
      sellBps: 10000,
      reason: "ORDER_FLOW",
    });
    await h.e.monitor();
    await h.e.exitScheduler.idle();
    const p = h.p(),
      old = p.jevExit!;
    assert(p.pendingExits?.some((o) => o.kind === "STRATEGIC"));
    const failed = {
      ...old,
      id: "failed",
      action: "NO_DECISION",
      decisionState: "NO_DECISION_TIMEOUT",
      status: "FAILED",
      error: "TIMEOUT",
    };
    (h.e as any).applyExitDecision(failed, { queuedAt: Date.now() });
    assert.equal(h.p().jevExit?.id, old.id);
    assert(h.p().pendingExits?.some((o) => o.decisionId === old.id));
    assert.equal(h.p().lastAnalystAttempt?.action, "NO_DECISION");
  } finally {
    await h.close();
  }
});
test("old HOLD after fresh structural confluence is superseded while protective authority remains", async () => {
  const h = harness();
  try {
    await h.e.monitor();
    await h.e.exitScheduler.idle();
    const old = h.p().jevExit!;
    const p = h.p();
    p.flow = flow();
    h.db.savePosition(p);
    const m = normalizeMarket(raw("8.6", 100, true));
    h.db.record("position_market", MINT, m);
    (h.e as any).updateExitSafety(p.id, {
      market: m,
      replaceHistory: true,
      history: history(),
    });
    (h.e as any).applyExitDecision(
      { ...old, id: "old-hold", action: "HOLD" },
      { queuedAt: old.createdAt },
    );
    assert.equal(h.db.jevExit("old-hold")?.status, "SUPERSEDED");
    assert(h.p().pendingExits?.some((o) => o.kind === "PROTECTIVE"));
  } finally {
    await h.close();
  }
});
test("liquidity recovered before pre-sign revokes transient protection; unavailable revalidation keeps recent proof only", async () => {
  const h = harness();
  try {
    h.set({ liquidity: 10, price: "" });
    await h.e.monitor();
    const p = h.p(),
      o = p.pendingExits![0]!;
    assert(o.protection);
    h.g.info = async () => {
      throw new ProviderFailure("GMGN_AUTHORIZATION_FAILED", "GMGN", false);
    };
    await (h.e as any).revalidateProtection(p.id, o.id);
    assert(validProtection(h.p().pendingExits?.[0]?.protection, h.p()));
    h.g.info = async () => raw("", 100);
    await assert.rejects((h.e as any).revalidateProtection(p.id, o.id));
    assert.equal(h.p().pendingExits?.length, 0);
  } finally {
    await h.close();
  }
});
test("expired recoverable predicate cannot execute during unavailable revalidation", async () => {
  const h = harness();
  try {
    h.set({ liquidity: 10, price: "" });
    await h.e.monitor();
    const p = h.p(),
      o = p.pendingExits![0]!;
    o.protection!.expiresAt = Date.now() - 1;
    h.db.savePosition(p);
    h.g.info = async () => {
      throw new ProviderFailure("GMGN_AUTHORIZATION_FAILED", "GMGN", false);
    };
    await assert.rejects((h.e as any).revalidateProtection(p.id, o.id));
    assert(h.p().pendingExits?.length);
  } finally {
    await h.close();
  }
});
for (const failedManual of [false, true])
  test(`new critical protection bypasses 30min PRE_SELL attention (failed manual=${failedManual}), retaining bounded NO_ROUTE retry`, async () => {
    const h = harness();
    try {
      const p = h.p();
      p.attention = {
        status: "NEEDS_ATTENTION",
        issue: {
          code: "X",
          reasonCode: "X",
          scope: "POSITION",
          stage: "PRE_SELL",
          retryable: true,
          detectedAt: Date.now(),
        },
        lastChecked: Date.now(),
        nextCheckAt: Date.now() + 1800000,
        failureCount: 3,
        protectiveExit: "BACKOFF",
      };
      h.db.savePosition(p);
      if (failedManual)
        h.db.saveManual({
          id: "backed-off-manual",
          mode: "paper",
          positionId: p.id,
          state: "FAILED_RETRYABLE",
          sellBps: 5000,
          createdAt: Date.now() - 1000,
        });
      h.set({ critical: true });
      await h.e.monitor();
      let calls = 0;
      h.e.executor.execute = async () => {
        calls++;
        throw new CandidateRejected("NO_SELL_ROUTE");
      };
      await h.e.processExits();
      assert.equal(calls, 1);
      const retry = h
        .p()
        .pendingExits?.find((o) => o.kind === "PROTECTIVE")?.retry;
      assert.equal(retry?.classification, "NO_ROUTE");
      assert(retry!.nextAt - Date.now() <= 60000);
      await h.e.processExits();
      assert.equal(calls, 1);
    } finally {
      await h.close();
    }
  });
test("route deterioration is decision-critical; small output noise and route alone are not protective", () => {
  const a = {
    quantity: "100",
    status: "HEALTHY",
    levels: [{ sellBps: 10000, minimumSolOut: "10000" }],
  } as Position["exitLiquidity"];
  assert.equal(
    routeMateriallyChanged(
      a,
      { ...a!, levels: [{ ...a!.levels[0]!, minimumSolOut: "9900" }] },
      S,
    ),
    false,
  );
  assert.equal(
    routeMateriallyChanged(
      a,
      { ...a!, levels: [{ ...a!.levels[0]!, minimumSolOut: "5000" }] },
      S,
    ),
    true,
  );
  const r = evaluateExitSafety(
    { ...position(), exitLiquidity: { ...a!, status: "NO_EXIT" } },
    S,
    {},
  );
  assert.equal(r.authorities.length, 0);
});
test("protective retry classifies failures with bounded dedicated intervals, never entry reject TTL", () => {
  for (const [code, kind] of [
    ["NO_SELL_ROUTE", "NO_ROUTE"],
    ["RPC_TIMEOUT", "RPC_TEMPORARY"],
    ["JUPITER_HTTP_500", "JUPITER_TEMPORARY"],
    ["TOKEN_SIMULATION_FAILED", "SIMULATION_FAILURE"],
    ["INSUFFICIENT_BALANCE", "INSUFFICIENT_BALANCE"],
    ["UNSUPPORTED_TOKEN_EXTENSION", "TOKEN_INCOMPATIBLE"],
    ["SIGNED_UNKNOWN", "SIGNED_UNKNOWN"],
    ["GMGN_AUTHORIZATION_FAILED", "PROVIDER_INTELLIGENCE_FAILURE"],
  ]) {
    const retry = protectiveRetry(new Blocked(code!), undefined, 1000);
    assert.equal(retry.classification, kind);
    if (kind === "SIGNED_UNKNOWN")
      assert.equal(retry.nextAt, Number.MAX_SAFE_INTEGER);
    else assert(retry.nextAt - 1000 <= 60000);
  }
});
test("legacy smart-money protective is revoked once; typed manual priority and protective state survive real temp DB reopen", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "sell-safety-restart-")),
    "fixture.sqlite",
  );
  let db = new Store(path);
  try {
    const p = { ...position(), mode: "paper" as const };
    p.pendingExits = [
      {
        id: "smart",
        kind: "PROTECTIVE",
        reason: "Smart-money exit",
        sellBps: 10000,
        triggeredAt: Date.now(),
      },
      {
        id: "liquidity",
        kind: "PROTECTIVE",
        reason: "GMGN liquidity removal/collapse",
        sellBps: 10000,
        triggeredAt: Date.now(),
      },
      {
        id: "strategy",
        kind: "STRATEGIC",
        reason: "ORDER_FLOW",
        sellBps: 5000,
        triggeredAt: Date.now(),
      },
    ];
    db.savePosition(p);
    db.saveManual({
      id: "manual",
      mode: "paper",
      positionId: p.id,
      state: "REQUESTED",
      sellBps: 5000,
      createdAt: Date.now(),
    });
    db.migrateSellSafetyV2(S.maxSnapshotAgeMs);
    assert.equal(
      db.positions("paper")[0]?.pendingExits?.some((o) => o.id === "smart"),
      false,
    );
    db.close();
    db = new Store(path);
    const e = new Engine(db, { gmgn: provider().gmgn });
    const restored = db.positions("paper")[0]!;
    assert(
      restored.pendingExits?.some(
        (o) => o.protection?.kind === "LIQUIDITY_COLLAPSE",
      ),
    );
    assert(!restored.pendingExits?.some((o) => o.kind === "STRATEGIC"));
    assert.equal(db.activeManual("paper").length, 1);
    assert.equal(e.exitScheduler.status().dirty, 0);
    assert(
      exitPriority(5000, undefined) <
        exitPriority(undefined, restored.pendingExits?.[0]),
    );
  } finally {
    db.close();
  }
});

function liveHarness() {
  const saved = {
    mode: env.TRADING_MODE,
    ack: env.LIVE_TRADING_ACK,
    wallet: env.WALLET_PUBLIC_KEY,
  };
  env.TRADING_MODE = "live";
  env.LIVE_TRADING_ACK = true;
  env.WALLET_PUBLIC_KEY = WALLET;
  const db = new Store(":memory:");
  db.set("strategyV2", S);
  const rpc = new Solana();
  let auth = true,
    securityCritical = false,
    unsafeQuote = false,
    receiptMissing = false,
    simulationFailure = false,
    sol = 1000000000n,
    tokens = 1000n,
    signature = "",
    beforeSol = sol,
    beforeTokens = tokens,
    sold = 0n;
  const calls = { quote: 0, simulation: 0, execute: 0 };
  const g = provider(async (args) => {
    if (args[1] === "security") {
      if (auth)
        throw new ProviderFailure("GMGN_AUTHORIZATION_FAILED", "GMGN", false);
      return { ...securityRaw, renounced_freeze_account: !securityCritical };
    }
    return undefined;
  }).gmgn;
  const execution: SolanaExecutionProvider = {
    health: { state: "READY", at: Date.now() },
    getWalletBalance: async () => sol,
    quoteBuy: async () => {
      throw Error("NO_BUY_FIXTURE");
    },
    quoteSell: async (_m, n) => {
      calls.quote++;
      const q = quote("SELL", n, WALLET);
      if (unsafeQuote) q.order.inputMint = WALLET;
      return q;
    },
    simulate: async () => {
      calls.simulation++;
      if (simulationFailure)
        throw new CandidateRejected("TOKEN_SIMULATION_FAILED");
    },
    execute: async (_q, persist, check) => {
      check?.();
      calls.execute++;
      signature = "fixture-sell-" + calls.execute;
      beforeSol = sol;
      beforeTokens = tokens;
      sold = BigInt(_q.amount);
      persist(signature);
      sol += 995000n;
      tokens -= sold;
      return signature;
    },
    confirm: async () => "CONFIRMED",
  };
  rpc.balance = async () => sol;
  rpc.tokenBalance = async () => tokens;
  rpc.connection.getParsedAccountInfo = async () =>
    ({
      value: { data: { parsed: { type: "mint", info: { decimals: 6 } } } },
    }) as never;
  rpc.receipt = async () =>
    receiptMissing
      ? null
      : ({
          slot: 1,
          meta: { fee: 5000, err: null },
          transaction: { signatures: [signature] },
        } as never);
  rpc.deltas = () => ({
    sol: 995000n,
    tokens: -sold,
    beforeSol,
    afterSol: sol,
    beforeTokens,
    afterTokens: tokens,
  });
  rpc.investigate = async () => ({
    signatureStatus: "NOT_ESTABLISHED",
    currentBlockHeight: 999999,
    blockhashValid: false,
  });
  const e = new Engine(db, { gmgn: g, rpc, execution });
  const p = {
    ...position(),
    id: "live-safety",
    mode: "live" as const,
    quantity: "1000",
    originalQuantity: "1000",
    decimals: 6,
    initialLiquidity: 100,
  };
  db.savePosition(p);
  seedEntryAccounting(db, p);
  return {
    db,
    e,
    rpc,
    g,
    calls,
    p: () => db.positions("live").find((x) => x.id === p.id)!,
    set: (x: {
      auth?: boolean;
      critical?: boolean;
      unsafeQuote?: boolean;
      receiptMissing?: boolean;
      simulationFailure?: boolean;
    }) => {
      auth = x.auth ?? auth;
      securityCritical = x.critical ?? securityCritical;
      unsafeQuote = x.unsafeQuote ?? unsafeQuote;
      receiptMissing = x.receiptMissing ?? receiptMissing;
      simulationFailure = x.simulationFailure ?? simulationFailure;
    },
    close: async () => {
      await e.stop();
      db.close();
      env.TRADING_MODE = saved.mode;
      env.LIVE_TRADING_ACK = saved.ack;
      env.WALLET_PUBLIC_KEY = saved.wallet;
    },
  };
}
for (const kind of ["manual", "protective"] as const)
  test(
    "GMGN auth failure cannot veto valid " +
      kind +
      "; exact quote, simulation, pre-sign and receipt still required",
    async () => {
      const h = liveHarness();
      try {
        if (kind === "manual") h.e.emergency(h.p().id);
        else
          (h.e as any).updateExitSafety(h.p().id, {
            security: {
              at: Date.now(),
              findings: [
                {
                  level: "CRITICAL",
                  code: "CONTROL",
                  reason: "fixture current critical",
                },
              ],
            },
          });
        await h.e.processExits();
        assert.equal(h.calls.quote, 1);
        assert.equal(h.calls.simulation, 1);
        assert.equal(h.calls.execute, 1);
        assert.equal(h.p().state, "CLOSED");
        assert.equal(h.p().quantity, "0");
        assert(h.p().accounting?.finalExit);
      } finally {
        await h.close();
      }
    },
  );
for (const failure of ["quote", "simulation"] as const)
  test(
    "manual GMGN fallback never bypasses " + failure + " transaction gate",
    async () => {
      const h = liveHarness();
      try {
        h.set({
          unsafeQuote: failure === "quote",
          simulationFailure: failure === "simulation",
        });
        h.e.emergency(h.p().id);
        await h.e.processExits();
        assert.equal(h.calls.execute, 0);
        assert.equal(h.p().quantity, "1000");
      } finally {
        await h.close();
      }
    },
  );
test("signed UNKNOWN remains wallet-wide locked despite expiry hints; B protective continues observation and exposes blocker", async () => {
  const h = liveHarness();
  try {
    h.set({ receiptMissing: true });
    h.e.emergency(h.p().id);
    await h.e.processExits();
    const unresolved = h.db.pending().find((e) => e.signature)!;
    assert.equal(unresolved.state, "UNKNOWN");
    assert.equal(unresolved.investigation?.result, "UNRESOLVED");
    const other = {
      ...h.p(),
      id: "other",
      mint: WALLET,
      state: "OPEN" as const,
      quantity: "1000",
      originalQuantity: "1000",
      pendingExits: [],
    };
    h.db.savePosition(other);
    (h.e as any).updateExitSafety(other.id, {
      security: {
        at: Date.now(),
        findings: [{ level: "CRITICAL", code: "CONTROL", reason: "fixture" }],
      },
    });
    await h.e.processExits();
    assert.equal(h.calls.execute, 1);
    assert.equal(
      h.db.positions("live").find((p) => p.id === "other")?.quantity,
      "1000",
    );
    const view = positionViews([other], h.db.executions())[0]!;
    assert.equal(view.safetyState.execution, "EXECUTION_BLOCKED_BY_UNKNOWN_TX");
    assert.equal(view.safetyState.blocker?.signature, unresolved.signature);
    // Only a chain receipt proving failure releases this lock; wall-clock/height never does.
    h.rpc.receipt = async () =>
      ({
        meta: { err: { InstructionError: 1 }, fee: 5000 },
        transaction: { signatures: [unresolved.signature] },
      }) as never;
    await h.e.executor.recover(S);
    assert.equal(h.db.pending().filter((e) => e.signature).length, 0);
    assert.equal(h.p().state, "OPEN");
  } finally {
    await h.close();
  }
});
test("receipt unavailable and still valid blockhash remain locked with explicit investigation", async () => {
  const h = liveHarness();
  try {
    h.set({ receiptMissing: true });
    h.rpc.investigate = async () => ({
      signatureStatus: "PROCESSED",
      currentBlockHeight: 10,
      blockhashValid: true,
    });
    h.e.emergency(h.p().id);
    await h.e.processExits();
    const pending = h.db.pending().find((e) => e.signature)!;
    assert.equal(pending.investigation?.result, "STILL_POSSIBLY_LIVE");
    await h.e.processExits();
    assert.equal(h.calls.execute, 1);
  } finally {
    await h.close();
  }
});
test("three Positions: A analyst pending does not block B protection or C observations", async () => {
  const h = harness(3);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  try {
    h.e.jev.decideExit = async (state) => {
      if ((state as any).currentPosition.id === "safety-0") await gate;
      return hold;
    };
    await h.e.monitor();
    assert(h.e.exitScheduler.status().active >= 1);
    const b = h.db.positions("paper").find((p) => p.id === "safety-1")!;
    (h.e as any).updateExitSafety(b.id, {
      security: {
        at: Date.now(),
        findings: [{ level: "CRITICAL", code: "CONTROL", reason: "fixture" }],
      },
    });
    h.g.security = async () => ({
      raw: {},
      at: Date.now(),
      findings: [{ level: "CRITICAL", code: "CONTROL", reason: "fixture" }],
      mintRenounced: { state: "KNOWN", value: true },
      freezeRenounced: { state: "KNOWN", value: false },
      rugRatio: { state: "UNKNOWN", reason: "fixture" },
    });
    let executed: string | undefined;
    h.e.executor.execute = async (intent) => {
      executed = intent.positionId;
      throw new CandidateRejected("NO_SELL_ROUTE");
    };
    await h.e.processExits();
    assert.equal(executed, b.id);
    assert(
      h.db.positions("paper").find((p) => p.id === "safety-2")?.lastQuoteAt,
    );
    assert(h.e.exitScheduler.status().active >= 1);
  } finally {
    release();
    await h.close();
  }
});
test("real JEV HTTP/parser path distinguishes errors and affirmative HOLD with mocked fetch only", async () => {
  const savedFetch = globalThis.fetch,
    savedKey = env.TYPESAFE_API_KEY;
  env.TYPESAFE_API_KEY = "fixture-only";
  try {
    for (const kind of ["429", "500", "json", "timeout", "network", "hold"]) {
      globalThis.fetch = async () => {
        if (kind === "timeout")
          throw new DOMException("fixture", "TimeoutError");
        if (kind === "network") throw new TypeError("fixture network");
        if (kind === "json") return new Response("not-json");
        return new Response(JSON.stringify(response()), {
          status: kind === "429" ? 429 : kind === "500" ? 500 : 200,
        });
      };
      const j = new Jev(),
        results: JevExitDecision[] = [],
        scheduler = new JevExitScheduler(
          j,
          () => S,
          (d) => results.push(d),
        );
      scheduler.schedule({
        positionId: kind,
        mint: MINT,
        quantity: "1",
        value: "100",
        state: {},
        queuedAt: Date.now(),
        priority: 0,
      });
      await scheduler.idle();
      await scheduler.stop();
      assert.equal(
        results[0]?.action,
        kind === "hold" ? "HOLD" : "NO_DECISION",
      );
      if (kind === "timeout")
        assert.equal(results[0]?.decisionState, "NO_DECISION_TIMEOUT");
      if (kind === "network")
        assert.equal(results[0]?.decisionState, "NO_DECISION_PROVIDER_FAILURE");
      if (kind === "json")
        assert.equal(results[0]?.decisionState, "NO_DECISION_INVALID_RESPONSE");
    }
  } finally {
    globalThis.fetch = savedFetch;
    env.TYPESAFE_API_KEY = savedKey;
  }
});
for (const code of ["GMGN_PLAN_UPGRADE_REQUIRED", "MISSING_GMGN_API_KEY"])
  for (const kind of ["manual", "protective"] as const)
    test(
      code + " respects narrow " + kind + " intelligence fallback",
      async () => {
        const h = liveHarness();
        try {
          h.g.security = async () => {
            throw new Blocked(code);
          };
          if (kind === "manual") h.e.emergency(h.p().id);
          else
            (h.e as any).updateExitSafety(h.p().id, {
              security: {
                at: Date.now(),
                findings: [
                  { level: "CRITICAL", code: "CONTROL", reason: "fixture" },
                ],
              },
            });
          await h.e.processExits();
          assert.equal(h.calls.execute, 1);
          assert.equal(h.p().state, "CLOSED");
        } finally {
          await h.close();
        }
      },
    );
test("RPC receipt errors remain explicit UNKNOWN investigation, not HOLD or duplicate execution", async () => {
  const h = liveHarness();
  try {
    h.rpc.receipt = async () => {
      throw new ProviderFailure("RPC_TIMEOUT", "RPC");
    };
    h.e.emergency(h.p().id);
    await h.e.processExits();
    const pending = h.db.pending().find((e) => e.signature)!;
    assert.equal(pending.state, "UNKNOWN");
    assert.equal(pending.investigation?.error, "RPC_TIMEOUT");
    await h.e.processExits();
    assert.equal(h.calls.execute, 1);
  } finally {
    await h.close();
  }
});
