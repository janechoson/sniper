import { randomUUID } from "node:crypto";
import { address } from "./gmgn.js";
import type { Settings } from "./config.js";
import {
  Blocked,
  CandidateRejected,
  type Candidate,
  type Market,
  type Snapshot,
  type RiskResult,
  type Mode,
  type Intent,
  type Position,
} from "./domain.js";
import { deepFreeze, hash } from "./util.js";
import { size } from "./position-sizing.js";
export { size } from "./position-sizing.js";
export function decision(
  outcome: RiskResult["outcome"],
  reason: string,
): RiskResult {
  return { allowed: outcome === "BUY", outcome, reason, at: Date.now() };
}
export function cheapGuard(c: Candidate, m: Market, s: Settings) {
  if (s.tokenBlacklist.includes(c.mint))
    return decision("SKIP_RISK", "TOKEN_BLACKLISTED");
  try {
    address(c.mint);
  } catch {
    return decision("SKIP_MARKET", "Invalid Solana mint");
  }
  if (
    c.createdAt &&
    (Date.now() - c.createdAt >
      (c.discovery?.sources.includes("TRENDING")
        ? s.trendingMaxAgeSeconds
        : s.maxAgeSeconds) *
        1000 ||
      c.createdAt > Date.now() + 5000)
  )
    return decision(
      "SKIP_MARKET",
      "Candidate age is outside the configured strategy window",
    );
  if (
    m.price.state !== "KNOWN" ||
    m.price.value <= 0 ||
    m.liquidity.state !== "KNOWN"
  )
    return decision(
      "SKIP_MISSING_CRITICAL_DATA",
      "GMGN price or liquidity is unavailable",
    );
  if (m.liquidity.value <= 0)
    return decision("SKIP_MARKET", "GMGN reports no usable liquidity");
  return decision("BUY", "Cheap filter passed");
}
export class RiskEngine {
  evaluate(
    snap: Snapshot,
    s: Settings,
    ctx: {
      balance: bigint;
      pending: bigint;
      positions: number;
      duplicate: boolean;
      entriesEnabled: boolean;
    },
    now = Date.now(),
    phase: "COMMON" | "PRE_WATCH" | "QUALIFICATION" | "EXECUTION" = "EXECUTION",
  ): RiskResult {
    if (s.tokenBlacklist.includes(snap.candidate.mint))
      return decision("SKIP_RISK", "TOKEN_BLACKLISTED");
    const kronos = snap.strategy === "KRONOS";
    if (phase !== "COMMON" && !kronos)
      return decision("SKIP_RISK", "KRONOS_ONLY");
    if (snap.gmgnQuality && snap.gmgnQuality.freshness !== "FRESH")
      return decision("SKIP_RISK", "Fresh GMGN evidence is required");
    if (!ctx.entriesEnabled)
      return decision("SKIP_RISK", "New entries are disabled");
    if (ctx.duplicate)
      return decision(
        "SKIP_RISK",
        "This mint already has a position or durable BUY intent",
      );
    if (snap.tokenExecution?.decision === "SKIP")
      return decision(
        snap.tokenExecution.extensionRisk === "CRITICAL"
          ? "SKIP_RUG"
          : "SKIP_MARKET",
        "On-chain token execution policy rejects mint/extensions",
      );
    const cheap = cheapGuard(snap.candidate, snap.market, s);
    if (!cheap.allowed) return cheap;
    const critical = snap.security.findings.find((f) => f.level === "CRITICAL");
    if (critical) return decision("SKIP_RUG", critical.reason);
    if (
      snap.security.mintRenounced.state !== "KNOWN" ||
      snap.security.freezeRenounced.state !== "KNOWN"
    )
      return decision(
        "SKIP_MISSING_CRITICAL_DATA",
        "GMGN mint/freeze control evidence is unavailable",
      );
    if (
      now - snap.market.at > s.maxSnapshotAgeMs ||
      now - snap.security.at > s.maxSnapshotAgeMs ||
      (phase !== "COMMON" &&
        (!snap.kronos ||
          now - snap.kronos.decisionAt > s.maxSnapshotAgeMs ||
          snap.kronos.decisionAt > now))
    )
      return decision("SKIP_RISK", "Decision evidence is stale");
    if (
      snap.market.liquidity.state === "KNOWN" &&
      snap.market.liquidity.value < s.minLiquidityUsd
    )
      return decision(
        "SKIP_MARKET",
        "Liquidity is below the configured entry policy",
      );
    for (const [field, limit, label] of [
      [snap.intelligence.holders.top1, s.maxTop1Percent, "Top holder"],
      [snap.intelligence.holders.top10, s.maxTop10Percent, "Top ten holders"],
      [snap.intelligence.creator.holdPercent, s.maxCreatorPercent, "Creator"],
    ] as const)
      if (field.state === "KNOWN" && field.value > limit)
        return decision(
          "SKIP_RISK",
          `${label} concentration exceeds configured policy`,
        );
    const evidence = snap.intelligence.riskEvidence;
    if (
      !evidence ||
      (evidence &&
        (evidence.freshness !== "FRESH" ||
          evidence.fetchedAt > now ||
          now - evidence.fetchedAt > s.maxSnapshotAgeMs))
    )
      return decision(
        "SKIP_MISSING_CRITICAL_DATA",
        "Authoritative holder evidence is stale or unavailable",
      );
    if (kronos && phase !== "COMMON") {
      if (
        !snap.kronos ||
        snap.kronos.action !== "BUY" ||
        snap.jev ||
        !snap.attemptId ||
        !snap.entryAuthority ||
        snap.entryAuthority.policy !== "TRENDING_ONE_SHOT_V1" ||
        !snap.marketHistory ||
        now - snap.marketHistory.fetchedAt > s.maxSnapshotAgeMs ||
        snap.marketHistory.fetchedAt > now ||
        !snap.capitalFlow ||
        snap.capitalFlow.regime === "INSUFFICIENT_DATA" ||
        now - snap.capitalFlow.at > s.maxSnapshotAgeMs ||
        snap.capitalFlow.at > now
      )
        return decision(
          "SKIP_RISK",
          "Fresh Kronos BUY, common history/flow and bound authority required",
        );
    }
    if (
      size(ctx.balance, BigInt(s.feeReserveLamports), ctx.pending, s).amount <=
      0n
    )
      return decision(
        "SKIP_RISK",
        "WAITING_FOR_CAPITAL: INSUFFICIENT_SPENDABLE_BALANCE after operational and pending reserves",
      );
    return decision(
      "BUY",
      "GMGN evidence, Kronos and deterministic policy allow entry",
    );
  }
  approve(
    snap: Snapshot,
    s: Settings,
    ctx: Parameters<RiskEngine["evaluate"]>[2],
    mode: Mode,
  ): Readonly<Intent> {
    const r = this.evaluate(snap, s, ctx);
    if (!r.allowed)
      throw new CandidateRejected("TEMPORARY_RISK_CHANGE", {
        reason: "CURRENT_RISK_REJECTED",
        riskReason: r.reason,
      });
    return deepFreeze({
      id: randomUUID(),
      attemptId: snap.attemptId,
      ownershipClaimId: snap.ownershipClaimId,
      strategy: "KRONOS",
      decisionSource: "KRONOS",
      decisionId: snap.kronos!.decisionId,
      decisionAt: snap.kronos!.decisionAt,
      entryAuthority: snap.entryAuthority,
      provider: "JUPITER",
      key: `${mode}:BUY:${snap.candidate.mint}`,
      mint: snap.candidate.mint,
      side: "BUY",
      mode,
      positionSizeMode: s.positionSizeMode,
      positionSizePercent: s.positionSizePercent,
      positionSizeSol: s.positionSizeSol,
      amount: size(
        ctx.balance,
        BigInt(s.feeReserveLamports),
        ctx.pending,
        s,
      ).amount.toString(),
      createdAt: Date.now(),
      expiresAt: Date.now() + s.maxSnapshotAgeMs,
      snapshotHash: hash(snap),
      positionId: randomUUID(),
      reason: r.reason,
    });
  }
}
export function exitDecision(
  p: Position,
  value: bigint,
  s: Settings,
  signals: {
    manual?: boolean;
    critical?: boolean;
    liquidity?: number;
    smartMoney?: boolean;
  },
  _now = Date.now(),
): { reason: string; sellBps: number; takeProfitIndex?: number } | undefined {
  if (p.state !== "OPEN" || BigInt(p.quantity) <= 0n) return;
  if (signals.manual)
    return { reason: "Manual emergency exit", sellBps: 10000 };
  if (signals.critical)
    return { reason: "Critical GMGN security deterioration", sellBps: 10000 };
  if (
    signals.liquidity !== undefined &&
    p.initialLiquidity &&
    signals.liquidity * 10000 <
      p.initialLiquidity * (10000 - s.liquidityCollapseBps)
  )
    return { reason: "GMGN liquidity removal/collapse", sellBps: 10000 };
  // KRONOS owns strategic exits. Shared protection never adds a profit policy.
  return;
}
/** Shared security and liquidity protection, unchanged for KRONOS. */
export function protectiveExitDecision(
  p: Position,
  value: bigint,
  s: Settings,
  signals: Parameters<typeof exitDecision>[3],
) {
  return exitDecision(p, value, s, signals);
}

function fraction(value: string) {
  const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!match || value.length > 128) throw new Blocked("Invalid decimal price");
  const exp = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
  if (Math.abs(exp) > 128) throw new Blocked("Price exponent is unsupported");
  const n = BigInt(match[1]! + (match[2] ?? ""));
  return exp >= 0
    ? { n: n * 10n ** BigInt(exp), d: 1n }
    : { n, d: 10n ** BigInt(-exp) };
}
export function paperQuantity(
  lamports: bigint,
  solUsd: string,
  tokenUsd: string,
  decimals: number,
) {
  const sol = fraction(solUsd),
    token = fraction(tokenUsd);
  if (token.n <= 0n || sol.n <= 0n)
    throw new Blocked("GMGN prices must be positive");
  return (
    (lamports * sol.n * token.d * 10n ** BigInt(decimals)) /
    (1000000000n * sol.d * token.n)
  );
}
export function paperValue(
  quantity: bigint,
  solUsd: string,
  tokenUsd: string,
  decimals: number,
) {
  const sol = fraction(solUsd),
    token = fraction(tokenUsd);
  if (sol.n <= 0n) throw new Blocked("SOL price unavailable");
  return (
    (quantity * token.n * sol.d * 1000000000n) /
    (10n ** BigInt(decimals) * token.d * sol.n)
  );
}
