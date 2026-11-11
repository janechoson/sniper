import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CapitalFlowEngine,
  evolveFlow,
  normalizeFlowObservation,
  type CapitalFlowState,
  type FlowObservation,
} from "../src/capital-flow.js";
import { env, settingsSchema } from "../src/config.js";
import { Engine } from "../src/engine.js";
import { normalizeMarket } from "../src/gmgn.js";
import { Store } from "../src/store.js";
import { info, position, provider, WALLET } from "./fixtures.js";
import { fakeKronos } from "./kronos-fixtures.js";

const settings = settingsSchema.parse({ smartMoneyExitMode: "OFF" });
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
    p = { ...position(), mode: "demo" as const };
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
    flow.prune("demo", []);
    assert.equal(flow.state(p.id), undefined);
  } finally {
    db.close();
  }
});

test("overlapping exit reconciliation and recovery share one receipt request and preserve confirmed manual consumption", async () => {
  const old = { mode: env.TRADING_MODE, wallet: env.WALLET_PUBLIC_KEY };
  env.TRADING_MODE = "live";
  env.WALLET_PUBLIC_KEY = WALLET;
  const db = new Store(":memory:"),
    engine = new Engine(db, { gmgn: provider().gmgn, kronos: fakeKronos() });
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
