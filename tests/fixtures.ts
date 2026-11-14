import { Keypair } from "@solana/web3.js";
import { randomUUID } from "node:crypto";
import { env, settingsSchema } from "../src/config.js";
import type {
  Candidate,
  Execution,
  Position,
  Snapshot,
} from "../src/domain.js";
import {
  Gmgn,
  SOL,
  normalizeIntelligence,
  normalizeMarket,
  normalizeSecurity,
  type CliRunner,
} from "../src/gmgn.js";
import { attemptFlow, parseMarketHistory } from "../src/market-history.js";
import type { Store } from "../src/store.js";
import type { ReasoningRuntime, ReasoningResult } from "../src/codex-runtime.js";
import { makeFillAccounting } from "../src/trade-accounting.js";
import { fixtureDecision } from "./kronos-fixtures.js";

export function fixtureCodex(): ReasoningRuntime {
  return {
    status: () => ({ state: "READY", model: "FIXTURE_ONLY", promptVersion: "fixture" }),
    analyze: async () => ({ action: "REVIEW", reason: "Fixture review", ruleIds: [], supportingEventIds: [], contradictoryEventIds: [], uncertainty: "Fixture only", hypothesis: null, knowledgeHypothesis: null, experienceReview: null } satisfies ReasoningResult),
    analyzeGuard: async (input: any) => ({ action: "PASS", riskLevel: "LOW", confidence: 0.8, summary: "Fixture mock pass; not evidence of semantic quality.", matchedKnowledge: [], marketObservations: [{ evidenceId: "MARKET-1", explanation: "Fixture market snapshot supplied." }], uncertaintyReasons: ["Fixture runtime"], evidenceCutoffAt: input.evidenceCutoffAt }),
  };
}

/** Explicit fee-free reconciled entry for monitoring fixtures. */
export function seedEntryAccounting(store: Store, p: Position) {
  const id = "fixture-entry-" + p.id;
  const e: Execution = {
    id,
    state: "CONFIRMED",
    signature: id,
    at: p.entryAt,
    intent: {
      id,
      key: id,
      positionId: p.id,
      provider: "JUPITER",
      mode: p.mode,
      mint: p.mint,
      side: "BUY",
      amount: p.costLamports,
      createdAt: p.entryAt,
      expiresAt: p.entryAt + 60000,
      snapshotHash: "fixture-only",
      reason: "fixture-entry",
    },
    evidence: {
      solDelta: "-" + p.costLamports,
      tokenDelta: p.originalQuantity,
      feeLamports: "0",
      slot: 0,
    },
  };
  e.accounting = makeFillAccounting(
    e,
    -BigInt(p.costLamports),
    BigInt(p.originalQuantity),
    0n,
    0n,
    p.decimals,
    { price: "100", at: p.entryAt, source: "FIXTURE_FX" },
    p.entryAt,
    "RECONCILIATION_TIME",
  );
  store.execution(e);
}
export const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WALLET = Keypair.generate().publicKey.toBase58();
export const settings = settingsSchema.parse({});
export function candidate(): Candidate {
  const now = Date.now();
  return {
    mint: MINT,
    symbol: "TEST",
    source: "gmgn:TRENDING",
    discovery: {
      sources: ["TRENDING"],
      firstSeenAt: now,
      lastSeenAt: now,
      trending: {
        firstSeenAt: now,
        lastSeenAt: now,
        sequenceStartedAt: now,
        consecutiveObservations: 1,
        rank: 1,
        basis: "fixture",
        history: [],
        movement: "STABLE",
      },
    },
    createdAt: Date.now() - 45 * 60000,
    discoveredAt: Date.now(),
    listing: {
      rug_ratio: 0,
      renounced_mint: true,
      renounced_freeze_account: true,
    },
  };
}
export function legacyCandidate(): Candidate {
  return { ...candidate(), source: "gmgn:Pump.fun", discovery: undefined };
}
// Downstream execution tests seed a qualified gate; admission itself is exercised
// end-to-end in trending-final-gate.test.ts, never bypassed in application code.
export function qualifiedWatch(
  e: import("../src/engine.js").Engine,
  c = candidate(),
  passed = true,
  now = Date.now(),
) {
  const r = e.structure.admit(
    c,
    {
      authorityRevision: e.store.candidateAuthority(c.mint, env.TRADING_MODE)
        .revision,
      snapshotHash: "downstream-fixture",
    },
    now,
  )!;
  if (passed) {
    Object.assign(r, {
      status: "PASSED",
      phase: "ENTRY_ELIGIBLE",
      quality: "FRESH",
      lastObservedAt: now,
      confirmedAt: now,
      absorptionDetected: true,
      supportConfirmed: true,
      sellingSeen: true,
      supportCount: settings.structureConfirmations,
      recoveryCount: settings.structureConfirmations + 1,
    });
    e.store.db
      .prepare("UPDATE entry_structure_watch SET payload=? WHERE mint=?")
      .run(JSON.stringify(r), c.mint);
  }
  return r;
}
export function info(mint = MINT) {
  return {
    address: mint,
    symbol: mint === SOL ? "SOL" : "TEST",
    name: "Test fixture",
    decimals: mint === SOL ? 9 : 6,
    price: {
      price: mint === SOL ? "100" : "1",
      price_1m: ".95",
      buys_1m: 10,
      sells_1m: 5,
      buy_volume_1m: "200",
      sell_volume_1m: "100",
      volume_24h: "100000",
    },
    liquidity: "100000",
    circulating_supply: "1000000",
    creation_timestamp: Math.floor(Date.now() / 1000) - 15 * 60,
    holder_count: 20,
    stat: { top_10_holder_rate: 0.1, creator_hold_rate: 0.01 },
    wallet_tags_stat: { smart_wallets: 10, renowned_wallets: 2 },
    dev: { creator_address: WALLET },
  };
}
export const securityRaw = {
  renounced_mint: true,
  renounced_freeze_account: true,
  is_honeypot: null,
  buy_tax: "0",
  sell_tax: "0",
};
export function snapshot(): Snapshot {
  const c = candidate(),
    raw = info(),
    security = normalizeSecurity(securityRaw, c, settings);
  return {
    candidate: c,
    market: normalizeMarket(raw),
    security,
    intelligence: {
      ...normalizeIntelligence(raw, security, c),
      riskEvidence: {
        fetchedAt: Date.now(),
        freshness: "FRESH",
        authority: "BUY_AUTHORIZING",
      },
    },
    strategy: "KRONOS",
    kronos: fixtureDecision(),
    attemptId: "fixture-attempt",
    entryAuthority: {
      revision: 0,
      path: "TRENDING",
      policy: "TRENDING_ONE_SHOT_V1",
    },
    marketHistory: parseMarketHistory({ list: [] }, c),
    capitalFlow: {
      ...attemptFlow(
        c,
        normalizeMarket(raw),
        raw,
        parseMarketHistory({ list: [] }, c),
        settings.flowMeaningfulChangePercent,
      ),
      regime: "NEUTRAL" as const,
    },
  };
}
export function position(): Position {
  return {
    id: randomUUID(),
    provider: "JUPITER",
    mint: MINT,
    symbol: "TEST",
    mode: "live",
    state: "OPEN",
    quantity: "1000",
    originalQuantity: "1000",
    costLamports: "1000000",
    remainingCostLamports: "1000000",
    realizedLamports: "0",
    entryAt: Date.now() - 60000,
    decimals: 6,
    highWaterLamports: "1000000",
    takenProfits: [],
    signature: "open-hash",
  };
}
export function provider(extra?: CliRunner) {
  const calls: string[][] = [];
  const gmgn = new Gmgn(async (args, write) => {
    calls.push(args);
    if (extra) {
      const v = await extra(args, write);
      if (v !== undefined) return v;
    }
    if (args[0] === "market" && args[1] === "kline") {
      const end = Math.floor(Date.now() / 60000) * 60000;
      return {
        list: Array.from({ length: 60 }, (_, i) => {
          const [open, close, low, high] =
            i < 11
              ? [0.94, 0.94, 0.93, 1]
              : [
                  [0.97, 0.9, 0.88, 0.98],
                  [0.9, 0.93, 0.89, 0.95],
                  [0.93, 0.96, 0.91, 0.98],
                  [0.96, 0.99, 0.93, 1],
                ][i - 11]!;
          return {
            time: end - (60 - i) * 60000,
            open: String(open),
            close: String(close),
            low: String(low),
            high: String(high),
            amount: "12345",
            volume: "1000",
          };
        }),
      };
    }
    if (args[0] === "market" && args[1] === "trending")
      return {
        code: 0,
        data: {
          rank: [{ ...info(), rank: 1, liquidity: "100000", volume: "100000" }],
        },
      };
    if (args[0] === "market")
      return {
        new_creation: [
          {
            ...info(),
            created_timestamp: Math.floor(Date.now() / 1000) - 60,
            launchpad_platform: "Pump.fun",
            renounced_mint: true,
            renounced_freeze_account: true,
          },
        ],
        pump: [],
        completed: [],
      };
    if (args[0] === "token" && args[1] === "info")
      return info(args[args.indexOf("--address") + 1]);
    if (args[0] === "token" && args[1] === "security") return securityRaw;
    if (args[0] === "token" && args[1] === "holders")
      return {
        list: Array.from({ length: 10 }, (_, n) => ({
          address: Keypair.generate().publicKey.toBase58(),
          addr_type: 0,
          amount_percentage: 0.01,
          index: n,
        })),
      };
    if (args[0] === "portfolio" && args[1] === "created-tokens")
      return { inner_count: 2, open_count: 3, tokens: [] };
    if (args[0] === "portfolio" && args[1] === "activity")
      return { activities: [], next: "" };
    if (
      args[0] === "track" ||
      args[0] === "portfolio" ||
      (args[0] === "order" && args[1] === "strategy")
    )
      return { list: [] };
    throw Error("Unhandled test fixture command " + args.join(" "));
  });
  return { gmgn, calls };
}

import type { ExecutionQuote } from "../src/execution-provider.js";
export function quote(
  side: "BUY" | "SELL",
  amount: bigint,
  wallet = WALLET,
  routeOnly = false,
): ExecutionQuote {
  const inputMint = side === "BUY" ? SOL : MINT,
    outputMint = side === "BUY" ? MINT : SOL;
  return {
    provider: "JUPITER",
    chain: "solana",
    side,
    mint: MINT,
    wallet,
    amount: amount.toString(),
    routeOnly,
    at: Date.now(),
    maxSlippageBps: 100,
    order: {
      inputMint,
      outputMint,
      inAmount: amount.toString(),
      outAmount: "1000000",
      otherAmountThreshold: "990000",
      swapMode: "ExactIn",
      slippageBps: 100,
      taker: wallet,
      router: "metis",
      transaction: "fixture-only",
      requestId: "fixture",
      signatureFeeLamports: 5000,
      prioritizationFeeLamports: 0,
      rentFeeLamports: 0,
      signatureFeePayer: wallet,
      routePlan: [{ swapInfo: { label: "Fixture", inputMint, outputMint } }],
    },
  };
}
