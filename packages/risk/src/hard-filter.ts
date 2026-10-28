import type { Decision, NormalizedTokenState } from "@sniper/core";
import type { Settings } from "@sniper/config";
import { chainSecurityPolicies, type SecurityPolicy } from "@sniper/config";
export function hardFilter(
  state: NormalizedTokenState,
  settings: Settings,
  policy: SecurityPolicy | undefined = chainSecurityPolicies[
    state.identity.chainId
  ],
): Decision {
  const reasons: string[] = [];
  if (!policy)
    return { passed: false, reasons: ["UNKNOWN_CHAIN_SECURITY_POLICY"] };
  if (state.market.liquidityUsd === undefined)
    reasons.push("UNKNOWN_LIQUIDITY");
  else if (state.market.liquidityUsd < settings.minLiquidityUsd)
    reasons.push("LOW_LIQUIDITY");
  if (state.market.priceUsd === undefined || state.market.priceUsd <= 0)
    reasons.push("INVALID_PRICE");
  if (state.holders.top1Pct === undefined)
    reasons.push("UNKNOWN_HOLDER_CONCENTRATION");
  else if (state.holders.top1Pct > settings.maxTop1Pct)
    reasons.push("HOLDER_CONCENTRATION");
  if (state.security.validToken !== true)
    reasons.push(
      state.security.validToken === false
        ? "INVALID_TOKEN"
        : "UNKNOWN_TOKEN_VALIDITY",
    );
  const checks = {
    mintRisk: "MINT_CAPABILITY",
    freezeRisk: "FREEZE_CAPABILITY",
    blacklistRisk: "BLACKLIST",
    upgradeRisk: "UPGRADEABILITY",
    pauseRisk: "PAUSABLE",
    transferRestrictionRisk: "TRANSFER_RESTRICTION",
    sellRestrictionRisk: "SELL_RESTRICTION",
  } as const;
  for (const [key, code] of Object.entries(checks) as [
    keyof typeof checks,
    string,
  ][]) {
    if (state.security[key] === undefined && policy.requiredFlags.includes(key))
      reasons.push(`UNKNOWN_${code}`);
    else if (state.security[key]) reasons.push(code);
  }
  if (state.security.overallRisk === undefined)
    reasons.push("UNKNOWN_SECURITY_RISK");
  else if (state.security.overallRisk > settings.maxSecurityRisk)
    reasons.push("SECURITY_RISK");
  // Cấu hình EVM bắt buộc có thuế; bộ phân tích Solana cũng có thể cung cấp bằng chứng phí.
  if (
    policy.requireTaxes &&
    (state.security.buyTaxPct === undefined ||
      state.security.sellTaxPct === undefined)
  )
    reasons.push("UNKNOWN_TAXES");
  if (
    (state.security.buyTaxPct ?? 0) > settings.maxTaxPct ||
    (state.security.sellTaxPct ?? 0) > settings.maxTaxPct
  )
    reasons.push("EXTREME_TAX");
  if (
    (state.creator.suspiciousLaunches ?? 0) > 0 ||
    (state.creator.liquidityRemovals ?? 0) > 0
  )
    reasons.push("MALICIOUS_CREATOR");
  // Funding provenance is research evidence only, including true and UNKNOWN.
  return { passed: reasons.length === 0, reasons };
}
