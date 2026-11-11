import assert from "node:assert/strict";
import test from "node:test";
import { env } from "../src/config.js";
import {
  demoAccountView,
  captureDemoBalance,
} from "../src/demo-account-view.js";
import type { Engine } from "../src/engine.js";
import { Store } from "../src/store.js";
import { position, settings } from "./fixtures.js";
import { fundFixtureHolding } from "./kronos-fixtures.js";

test("DEMO account and chart show native 100 SOL without a USD quote", () => {
  env.TRADING_MODE = "demo";
  const store = new Store(":memory:");
  const engine = {
    store,
    settings,
    solUsdEvidence() {
      throw Error("USD_MUST_NOT_CONTROL_SOL_BALANCE");
    },
  } as unknown as Engine;
  try {
    captureDemoBalance(engine);
    const view = demoAccountView(engine);
    assert.equal(view.currency, "SOL");
    assert.equal(view.initialCapitalSol, "100.000000000");
    assert.equal(view.availableCashLamports, "100000000000");
    assert.equal(view.equitySol, "100.000000000");
    assert.equal(view.realizedPnlSol, "0.000000000");
    assert.equal(view.unrealizedPnlSol, "0.000000000");
    assert.equal(view.history.at(-1)!.cashSol, "100.000000000");
  } finally {
    store.close();
  }
});
test("SOL equity marks use current native position value and remain unknown when stale", () => {
  env.TRADING_MODE = "demo";
  const store = new Store(":memory:"),
    engine = { store, settings } as Engine;
  try {
    const held = {
      ...position(),
      mode: "demo" as const,
      strategy: "KRONOS" as const,
    };
    fundFixtureHolding(store, held);
    assert.equal(demoAccountView(engine).equitySol, null);
    store.savePosition({
      ...held,
      lastQuoteAt: Date.now(),
      valuationQuantity: held.quantity,
      lastValueLamports: "2000000",
    });
    const view = demoAccountView(engine);
    assert.equal(view.unrealizedPnlLamports, "1000000");
    assert.equal(view.equityLamports, "100001000000");
    store.savePosition({
      ...held,
      lastQuoteAt: Date.now() - settings.maxSnapshotAgeMs - 1,
      valuationQuantity: held.quantity,
      lastValueLamports: "2000000",
    });
    assert.equal(demoAccountView(engine).unrealizedPnlSol, null);
  } finally {
    store.close();
  }
});
