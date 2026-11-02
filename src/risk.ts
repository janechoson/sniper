import { address } from "./gmgn.js";
import type { Settings } from "./config.js";
import type { Candidate, Market, RiskResult } from "./domain.js";

export function decision(
  outcome: RiskResult["outcome"],
  reason: string,
): RiskResult {
  return { allowed: outcome === "BUY", outcome, reason, at: Date.now() };
}

export function cheapGuard(c: Candidate, m: Market, s: Settings) {
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
