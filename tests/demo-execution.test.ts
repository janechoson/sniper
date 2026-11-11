import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { env, settingsSchema } from "../src/config.js";
import { DEMO_INITIAL_LAMPORTS, DemoLedger } from "../src/demo-ledger.js";
import type { Intent, Snapshot } from "../src/domain.js";
import type { ExecutionQuote } from "../src/execution-quote.js";
import { Executor } from "../src/executor.js";
import type { Gmgn } from "../src/gmgn.js";
import { SOL } from "../src/gmgn.js";
import type { QuoteSource } from "../src/jupiter-quotes.js";
import { size } from "../src/position-sizing.js";
import type { Solana } from "../src/solana.js";
import { Store } from "../src/store.js";
import { hash } from "../src/util.js";
const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  wallet = "11111111111111111111111111111111";
function fixture(settingsInput: Record<string, unknown> = {}) {
  env.TRADING_MODE = "demo";
  const store = new Store(":memory:"),
    ledger = new DemoLedger(store.db);
  ledger.initialize();
  const settings = settingsSchema.parse(settingsInput);
  store.set("strategyV2", settings);
  const fx = { price: "100", at: Date.now(), source: "FIXTURE_FX" };
  const market = {
    at: Date.now(),
    priceUsd: "1",
    decimals: 6,
    price: { state: "KNOWN", value: 1 },
    liquidity: { state: "KNOWN", value: 100000 },
    marketCap: { state: "KNOWN", value: 1000000 },
  };
  const snapshot = {
    strategy: "KRONOS",
    candidate: { mint },
    market,
  } as Snapshot;
  store.record("snapshots", mint, snapshot);
  store.record("position_market", mint, market);
  let quotesFail = false;
  const quotes: QuoteSource = {
    wallet,
    health: { state: "READY", at: Date.now() },
    quoteBuy: async (m, a, s) => quote(m, a, s, "BUY"),
    quoteSell: async (m, a, s) => quote(m, a, s, "SELL"),
  };
  function quote(
    m: string,
    amount: bigint,
    slippageBps: number,
    side: "BUY" | "SELL",
  ): ExecutionQuote {
    if (quotesFail) throw Error("NO_ROUTE_FIXTURE");
    const output = side === "BUY" ? 1000000n : amount * 1000n;
    return {
      provider: "JUPITER",
      chain: "solana",
      wallet,
      mint: m,
      side,
      routeOnly: true,
      amount: String(amount),
      at: Date.now(),
      maxSlippageBps: slippageBps,
      order: {
        inputMint: side === "BUY" ? SOL : m,
        outputMint: side === "BUY" ? m : SOL,
        inAmount: String(amount),
        outAmount: String(output),
        otherAmountThreshold: String(
          (output * BigInt(10000 - slippageBps)) / 10000n,
        ),
        swapMode: "ExactIn",
        slippageBps,
        router: "metis",
        taker: "",
        transaction: "",
        requestId: "",
        signatureFeePayer: "",
        signatureFeeLamports: 5000,
        prioritizationFeeLamports: 0,
        rentFeeLamports: 0,
        priceImpactPct: 0.1,
        routePlan: [
          {
            swapInfo: {
              label: "fixture",
              inputMint: side === "BUY" ? SOL : m,
              outputMint: side === "BUY" ? m : SOL,
            },
          },
        ],
      },
    };
  }
  const forbidden = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "inspectMint")
          return async () => ({
            decision: "ALLOW",
            decimals: 6,
            tokenProgram: "SPL_TOKEN",
            extensions: [],
            extensionRisk: "NONE",
          });
        throw Error("DEMO_REACHED_SIGNER_OR_BROADCASTER");
      },
    },
  );
  const executor = new Executor(
    store,
    {} as Gmgn,
    forbidden as Solana,
    undefined,
    undefined,
    undefined,
    quotes,
  );
  const amount = size(
    ledger.balance(),
    BigInt(settings.feeReserveLamports),
    0n,
    settings,
  ).amount;
  const intent: Intent = {
    id: randomUUID(),
    key: randomUUID(),
    strategy: "KRONOS",
    provider: "JUPITER",
    mode: "demo",
    side: "BUY",
    mint,
    amount: String(amount),
    positionId: randomUUID(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 45000,
    snapshotHash: hash(snapshot),
    reason: "fixture",
    positionSizeMode: settings.positionSizeMode,
    positionSizePercent: settings.positionSizePercent,
    positionSizeSol: settings.positionSizeSol,
  };
  return {
    store,
    ledger,
    settings,
    fx,
    executor,
    intent,
    setQuotesFail: () => {
      quotesFail = true;
    },
  };
}
test("DEMO uses unchanged configured sizing, actual quotes and atomic holdings without any RPC capability", async () => {
  for (const settingsInput of [
    { positionSizeMode: "SOL", positionSizeSol: 0.2 },
    { positionSizeMode: "PERCENT", positionSizePercent: 2.5 },
  ]) {
    const f = fixture(settingsInput);
    try {
      const expected = size(
        100_000_000_000n,
        BigInt(f.settings.feeReserveLamports),
        0n,
        f.settings,
      ).amount;
      assert.equal(f.intent.amount, String(expected));
      const e = await f.executor.execute(
        f.intent,
        f.settings,
        "100",
        async () => {},
        () => {},
        undefined,
        f.fx,
      );
      assert.equal(e.state, "CONFIRMED");
      assert.equal(e.signature, undefined);
      assert.equal(e.evidence!.simulated, true);
      assert.equal(e.evidence!.slot, undefined);
      assert.equal(f.store.positions("demo")[0]!.quantity, "990000");
      assert.equal(f.store.positions("live").length, 0);
      assert.equal(f.ledger.holdings()[0]!.quantity, "990000");
      assert.equal(f.ledger.account().reserved, 0n);
      assert.ok(f.ledger.account().cash < DEMO_INITIAL_LAMPORTS);
      assert.equal("execute" in f.executor.demo!.quotes, false);
      assert.equal("rpc" in f.executor.demo!, false);
      await assert.rejects(
        f.executor.execute(
          f.intent,
          f.settings,
          "100",
          async () => {},
          undefined,
          undefined,
          f.fx,
        ),
      );
    } finally {
      f.store.close();
    }
  }
});
test("failed quote leaves no holdings, no cash loss, no phantom open position and releases reserve", async () => {
  const f = fixture();
  try {
    f.setQuotesFail();
    await assert.rejects(
      f.executor.execute(
        f.intent,
        f.settings,
        "100",
        async () => {},
        undefined,
        undefined,
        f.fx,
      ),
      /NO_ROUTE/,
    );
    assert.equal(f.ledger.account().cash, DEMO_INITIAL_LAMPORTS);
    assert.equal(f.ledger.account().reserved, 0n);
    assert.equal(f.ledger.holdings().length, 0);
    assert.equal(f.store.positions("demo")[0]!.state, "FAILED");
    assert.equal(f.store.executions()[0]!.state, "FAILED");
  } finally {
    f.store.close();
  }
});
test("mode tampering and legacy STANDARD intents fail before quote or claim", async () => {
  const f = fixture();
  try {
    await assert.rejects(
      f.executor.execute(
        { ...f.intent, strategy: "STANDARD" },
        f.settings,
        "100",
        async () => {},
        undefined,
        undefined,
        f.fx,
      ),
      /KRONOS_ONLY/,
    );
    env.TRADING_MODE = "live";
    await assert.rejects(
      f.executor.execute(
        f.intent,
        f.settings,
        "100",
        async () => {},
        undefined,
        undefined,
        f.fx,
      ),
      /MODE_MISMATCH/,
    );
    assert.equal(f.ledger.account().cash, DEMO_INITIAL_LAMPORTS);
  } finally {
    f.store.close();
    env.TRADING_MODE = "demo";
  }
});
