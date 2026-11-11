import assert from "node:assert/strict";
import { test } from "node:test";
import type { CapitalFlowSummary } from "../src/capital-flow.js";
import { env, settingsSchema } from "../src/config.js";
import {
  Blocked,
  CandidateRejected,
  ProviderFailure,
  type Position,
} from "../src/domain.js";
import { Engine } from "../src/engine.js";
import type { SolanaExecutionProvider } from "../src/execution-provider.js";
import {
  evaluateExitSafety,
  exitPriority,
  protectiveRetry,
  routeMateriallyChanged,
  securityRecoveryConfirmed,
} from "../src/exit-safety.js";
import { normalizeMarket, normalizeSecurity } from "../src/gmgn.js";
import {
  parseMarketHistory,
  type MarketHistory,
} from "../src/market-history.js";
import { PositionHistoryMonitor } from "../src/position-history-monitor.js";
import { positionViews } from "../src/position-view.js";
import { Solana } from "../src/solana.js";
import { Store } from "../src/store.js";
import {
  MINT,
  WALLET,
  info,
  position,
  provider,
  quote,
  securityRaw,
  seedEntryAccounting,
  settings,
} from "./fixtures.js";
import { fakeKronos } from "./kronos-fixtures.js";
const S = settingsSchema.parse({ ...settings, smartMoneyExitMode: "OFF" });
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
  const e = new Engine(db, { gmgn: g, rpc, execution, kronos: fakeKronos() });
  const p = {
    ...position(),
    id: "live-safety",
    strategy: "KRONOS" as const,
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
