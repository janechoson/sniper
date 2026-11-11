import { randomUUID } from "node:crypto";
import { env } from "../src/config.js";
import { DemoLedger } from "../src/demo-ledger.js";
import type { Intent, Position } from "../src/domain.js";
import type { ExecutionQuote } from "../src/execution-quote.js";
import type { QuoteSource } from "../src/jupiter-quotes.js";
import { KRONOS, type LabCandle } from "../src/kronos-domain.js";
import { KronosStrategy, type KronosDecision } from "../src/kronos-strategy.js";
import { Solana } from "../src/solana.js";
import type { Store } from "../src/store.js";
export function fakeKronos(direction = 1.02) {
  return new KronosStrategy({
    async forecast(rows: LabCandle[], at: number) {
      const end = rows.at(-1)!.at + 60000,
        last = rows.at(-1)!.close;
      return {
        version: "KRONOS_FORECAST_V1",
        commit: KRONOS.commit,
        model: KRONOS.model,
        tokenizer: KRONOS.tokenizer,
        paths: Array.from({ length: 3 }, () =>
          Array.from({ length: 5 }, () => last * direction),
        ),
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
        loadMs: 0,
        latencyMs: 0,
        rssBytes: 1,
        limitations: [],
      };
    },
    stop() {},
    status() {
      return {};
    },
  });
}
export function fixtureDecision(
  action: KronosDecision["action"] = "BUY",
): KronosDecision {
  return {
    strategy: "KRONOS",
    action,
    decisionId: randomUUID(),
    decisionAt: Date.now(),
    reason: "FIXTURE_" + action,
    evidence: {
      model: KRONOS.model.id,
      revision: KRONOS.model.revision,
      tokenizerRevision: KRONOS.tokenizer.revision,
      inputFrom: Date.now() - 3600000,
      inputTo: Date.now(),
      candleCount: 60,
      horizon: 5,
      samples: 3,
      terminalPrices: [1.02, 1.02, 1.02],
      terminalRangePct: [2, 2],
      lastObservedClose: 1,
    },
  };
}
/** Unit harnesses own an explicit fixture lease; production starts through ModeManager. */
export function lease(store: Store) {
  const mode = env.TRADING_MODE === "live" ? "LIVE" : "DEMO";
  store.db
    .prepare(
      "INSERT INTO engine_sessions VALUES(1,?,?,?,'RUNNING',?) ON CONFLICT(id) DO UPDATE SET token=excluded.token,pid=excluded.pid,mode=excluded.mode,state=excluded.state",
    )
    .run(randomUUID(), process.pid, mode, Date.now());
  return store;
}
export function bindFixtureClaim(store: Store, intent: Intent): Intent {
  const claim = store.claimMintForBuy(
    {
      mode: intent.mode,
      mint: intent.mint,
      strategy: "KRONOS",
      attemptId: intent.attemptId ?? randomUUID(),
      decisionId: intent.decisionId ?? randomUUID(),
      decisionAt: intent.decisionAt ?? Date.now(),
    },
    intent.entryAuthority,
  );
  if (!claim.claimed) throw Error("FIXTURE_CLAIM_FAILED:" + claim.reason);
  return {
    ...intent,
    strategy: "KRONOS",
    ownershipClaimId: claim.claim.id,
    attemptId: claim.claim.attemptId,
    decisionSource: "KRONOS",
    decisionId: claim.claim.decisionId,
    decisionAt: claim.claim.decisionAt,
  };
}
export function fixtureQuotes(): QuoteSource {
  const wallet = "11111111111111111111111111111111",
    sol = "So11111111111111111111111111111111111111112";
  const quote = async (
    mint: string,
    amount: bigint,
    bps: number,
    side: "BUY" | "SELL",
  ): Promise<ExecutionQuote> => {
    const out = side === "BUY" ? amount / 10n : amount * 10n,
      inputMint = side === "BUY" ? sol : mint,
      outputMint = side === "BUY" ? mint : sol;
    return {
      provider: "JUPITER",
      chain: "solana",
      wallet,
      mint,
      side,
      amount: String(amount),
      at: Date.now(),
      routeOnly: true,
      maxSlippageBps: bps,
      order: {
        inputMint,
        outputMint,
        inAmount: String(amount),
        outAmount: String(out),
        otherAmountThreshold: String((out * BigInt(10000 - bps)) / 10000n),
        swapMode: "ExactIn",
        slippageBps: bps,
        taker: "",
        router: "metis",
        transaction: "",
        requestId: "",
        signatureFeeLamports: 5000,
        prioritizationFeeLamports: 0,
        rentFeeLamports: 0,
        signatureFeePayer: "",
        priceImpactPct: 0.1,
        routePlan: [{ swapInfo: { label: "fixture", inputMint, outputMint } }],
      },
    };
  };
  return {
    wallet,
    health: { state: "READY", at: Date.now() },
    quoteBuy: (m, a, b) => quote(m, a, b, "BUY"),
    quoteSell: (m, a, b) => quote(m, a, b, "SELL"),
  };
}
export function fundFixtureHolding(store: Store, p: Position) {
  const ledger = new DemoLedger(store.db);
  ledger.initialize();
  const fx = { price: "100", at: Date.now(), source: "FIXTURE_FX" },
    id = randomUUID(),
    gross = BigInt(p.remainingCostLamports || "1") || 1n;
  ledger.reserve(id, gross);
  ledger.settle(
    {
      executionId: id,
      idempotencyKey: id,
      positionId: p.id,
      mint: p.mint,
      side: "BUY",
      requestedAmount: String(gross),
      executedAmount: String(gross),
      quantity: p.quantity,
      grossLamports: String(gross),
      feeLamports: "0",
      decimals: p.decimals ?? 6,
      fx,
      quoteAt: Date.now(),
      quoteId: id,
      estimated: true,
    },
    45000,
    () => store.savePosition(p),
  );
}

export function fixtureRpc() {
  const rpc = new Solana();
  rpc.inspectMint = async () =>
    ({
      decision: "ALLOW",
      decimals: 6,
      tokenProgram: "SPL_TOKEN",
      extensions: [],
      extensionRisk: "NONE",
    }) as never;
  return rpc;
}
