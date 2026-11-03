import { randomUUID } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import { TradingMemory } from "../src/trading-memory.js";
import { hash } from "../src/util.js";
import {
  known,
  type Intent,
  type Position,
  type Candidate,
} from "../src/domain.js";
import { settings, snapshot } from "./fixtures.js";
/** Synthetic evidence for isolated in-memory tests ONLY; never connects to a chain or production DB. */
export function completedFixture(
  memory: TradingMemory,
  options: {
    mint?: string;
    netPercent?: number;
    observations?: number[];
    base?: number;
    exitReason?: string;
    mode?: "paper" | "live";
    fail?: boolean;
    close?: boolean;
    discovery?: Candidate["discovery"];
  } = {},
) {
  const base = options.base ?? Date.now() - 3600000,
    mint = options.mint ?? Keypair.generate().publicKey.toBase58(),
    snap = snapshot();
  snap.candidate = {
    ...snap.candidate,
    mint,
    createdAt: base - 60000,
    discoveredAt: base,
    discovery: options.discovery,
  };
  snap.market.at = base;
  snap.security.at = base;
  snap.jev!.at = base;
  const intent: Intent = {
    id: randomUUID(),
    key: `${options.mode ?? "paper"}:BUY:${mint}`,
    provider: "JUPITER",
    mint,
    side: "BUY",
    mode: options.mode ?? "paper",
    amount: "1000000000",
    createdAt: base,
    expiresAt: base + 45000,
    snapshotHash: hash(snap),
    positionId: randomUUID(),
    reason: "TEST FIXTURE deterministic approval",
  };
  memory.store.record("jev_inputs", mint, {
    state: {
      currentToken: { market: snap.market },
      historicalExperience: { similarTrades: 0, confidence: "INSUFFICIENT" },
    },
  });
  const buy = memory.store.claim(intent);
  memory.entry(buy, snap, settings, base);
  buy.state = "CONFIRMED";
  buy.at = base + 1000;
  buy.signature = "fixture-buy-" + intent.id;
  buy.evidence = {
    solDelta: "-1000000000",
    tokenDelta: "1000000",
    feeLamports: "5000",
    slot: 1,
  };
  memory.store.execution(buy);
  memory.confirmed(buy);
  const p: Position = {
    ...memory.store
      .positions(intent.mode)
      .find((p) => p.id === intent.positionId)!,
    state: "OPEN",
    quantity: "1000000",
    originalQuantity: "1000000",
    costLamports: "1000000000",
    remainingCostLamports: "1000000000",
    entryAt: base + 1000,
    entryPriceUsd: "1",
    signature: buy.signature,
  };
  memory.store.savePosition(p);
  for (const [i, percent] of (options.observations ?? [5, 35]).entries()) {
    const at = base + 31000 + i * 31000,
      market = {
        ...snap.market,
        at,
        price: known(1 + percent / 100),
        priceUsd: String(1 + percent / 100),
      };
    memory.observe(
      p,
      market,
      snap.security,
      1_000_000_000n + BigInt(Math.round(percent * 10000000)),
      undefined,
      at,
    );
  }
  if (options.close === false)
    return { buy, position: p, snapshot: snap, sell: undefined, base };
  const exitAt = base + 120000,
    market = {
      ...snap.market,
      at: exitAt,
      price: known(1 + (options.netPercent ?? 20) / 100),
    };
  memory.store.record("position_market", mint, market);
  memory.store.record("position_security", mint, snap.security);
  const sellIntent: Intent = {
    ...intent,
    id: randomUUID(),
    key: randomUUID(),
    side: "SELL",
    amount: "1000000",
    createdAt: exitAt,
    reason: options.exitReason ?? "Take profit",
  };
  if (options.fail) {
    const failed = memory.store.claim({
      ...sellIntent,
      id: randomUUID(),
      key: randomUUID(),
    });
    failed.state = "FAILED";
    failed.error = "FIXTURE_RPC_TIMEOUT";
    memory.store.execution(failed);
    memory.failure(failed);
    memory.store.savePosition(p);
  }
  const sell = memory.store.claim(sellIntent);
  memory.exit(sell, p);
  sell.state = "CONFIRMED";
  sell.at = exitAt + 1000;
  sell.signature = "fixture-sell-" + sell.id;
  sell.evidence = {
    solDelta: String(
      1_000_000_000 + Math.round((options.netPercent ?? 20) * 10000000),
    ),
    tokenDelta: "-1000000",
    feeLamports: "5000",
    slot: 2,
  };
  memory.store.execution(sell);
  memory.confirmed(sell);
  memory.store.savePosition({ ...p, state: "CLOSED", quantity: "0" });
  return { buy, sell, position: p, snapshot: snap, base };
}
export function typedJevFixture(
  action = "BUY",
  history = "SUPPORTS",
  strength = "LOW",
) {
  const choice = (value: string) => ({
    type: "choice",
    choice: value,
    confidence: 0.8,
    probabilities: { [value]: 1 },
  });
  return {
    model: "jev-1.14.0",
    answers: {
      action: choice(action),
      risk: choice("MEDIUM"),
      suspicious: { type: "noul", noul: 0 },
      data_sufficiency: { type: "noul", noul: 1 },
      momentum_quality: choice("STRONG"),
      historical_assessment: choice(history),
      historical_strength: choice(strength),
      primary_reason: choice("CURRENT_MOMENTUM"),
    },
  };
}
