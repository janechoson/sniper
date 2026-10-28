import {
  rugSnapshotSchema,
  rugPolicySchema,
  type RugCheckSnapshot,
  type RugPolicy,
  type RugDecision,
  type ExecutionMode,
  type SecurityEvidence,
} from "@sniper/core";
export function decideRugCheck(
  input: RugCheckSnapshot,
  inputPolicy: RugPolicy,
  mode: ExecutionMode,
  stage: RugDecision["stage"] = "FINAL",
  now = Date.now(),
): RugDecision {
  const snapshot = rugSnapshotSchema.parse(input),
    policy = rugPolicySchema.parse(inputPolicy),
    reject: string[] = [],
    watch: string[] = [];
  const field = (path: string): SecurityEvidence | undefined => {
    const [section, name] = path.split(".") as [
      "contract" | "trading" | "liquidity" | "holders" | "creator",
      string,
    ];
    return snapshot[section]?.[name];
  };
  const fresh = (
    e: SecurityEvidence | undefined,
    maxAge = policy.maxEvidenceAgeMs,
  ) =>
    !!e &&
    Date.parse(e.observedAt) <= now + 1000 &&
    now - Date.parse(e.observedAt) <= maxAge &&
    (!e.validUntil || Date.parse(e.validUntil) > now);
  const known = (path: string) => {
    const e = field(path);
    if (e?.state === "NOT_APPLICABLE") {
      const evm = ["bnb", "robinhood"].includes(snapshot.chainId);
      if (
        !evm ||
        !["contract.mintAuthority", "contract.freezeAuthority"].includes(path)
      )
        return undefined;
    }
    return fresh(e) && e?.state !== "UNKNOWN" && e?.origin !== "UNKNOWN"
      ? e
      : undefined;
  };
  const risk = (path: string) => known(path)?.state === "RISK";
  const val = (path: string) => known(path)?.value;
  const limit = (
    path: string,
    threshold: number | undefined,
    reason: string,
    below = false,
  ) => {
    const value = val(path);
    if (
      threshold !== undefined &&
      typeof value === "number" &&
      (below ? value < threshold : value > threshold)
    )
      reject.push(reason);
  };
  if (
    snapshot.source !== "RPC" ||
    snapshot.externalProviders.some((p) =>
      p.findings.some((f) => f.evidence.origin === "MOCK"),
    ) ||
    [
      snapshot.contract,
      snapshot.trading,
      snapshot.holders,
      snapshot.liquidity,
      snapshot.creator,
    ].some((group) => Object.values(group).some((e) => e.origin === "MOCK"))
  )
    reject.push("MOCK_SECURITY_FORBIDDEN");
  if (val("contract.validToken") === false) reject.push("INVALID_TOKEN");
  if (
    val("trading.honeypot") === "FAIL" &&
    known("trading.honeypot")?.origin === "REAL_EXTERNAL"
  )
    reject.push("HONEYPOT_DETECTED");
  if (val("trading.sellability") === "NOT_SELLABLE" && policy.rejectNotSellable)
    reject.push("SELL_SIMULATION_FAILED");
  if (policy.rejectBlacklistCapability && risk("contract.blacklistCapability"))
    reject.push("BLACKLIST_CAPABILITY");
  if (
    policy.rejectTransferRestricted &&
    (risk("contract.transferRestriction") ||
      risk("contract.nonTransferable") ||
      risk("trading.sellRestriction"))
  )
    reject.push("TRANSFER_RESTRICTED");
  if (
    policy.rejectActiveMint &&
    (val("contract.mintAuthority") === "ACTIVE" ||
      risk("contract.mintCapability"))
  )
    reject.push("MINT_AUTHORITY_ACTIVE");
  if (policy.rejectActiveFreeze && val("contract.freezeAuthority") === "ACTIVE")
    reject.push("FREEZE_AUTHORITY_ACTIVE");
  if (risk("contract.pauseCapability")) watch.push("PAUSE_CAPABILITY");
  if (
    policy.rejectCreatorLpControl &&
    typeof val("liquidity.creatorLpPct") === "number" &&
    (val("liquidity.creatorLpPct") as number) > 0
  )
    reject.push("CREATOR_LP_CONTROL");
  if (policy.rejectLiquidityRemoval && risk("liquidity.recentRemovalPct"))
    reject.push("LIQUIDITY_REMOVAL_DETECTED");
  if (
    policy.rejectCriticalCreatorIncidents &&
    [
      "creator.criticalIncidents",
      "creator.liquidityRemovals",
      "creator.sellabilityFailures",
    ].some((path) => {
      const value = val(path);
      return risk(path) && typeof value === "number" && value > 0;
    })
  )
    reject.push("CREATOR_CRITICAL_HISTORY");
  const top1 =
    policy.concentrationBasis === "raw"
      ? "holders.top1Pct"
      : "holders.adjustedTop1Pct";
  const top10 =
    policy.concentrationBasis === "raw"
      ? "holders.top10Pct"
      : "holders.adjustedTop10Pct";
  limit(top1, policy.maxTop1Pct, "TOP1_CONCENTRATION_HIGH");
  limit(top10, policy.maxTop10Pct, "TOP10_CONCENTRATION_HIGH");
  if (
    stage !== "PRECHECK" &&
    stage !== "MONITOR" &&
    ((policy.maxTop1Pct !== undefined && !known(top1)) ||
      (policy.maxTop10Pct !== undefined && !known(top10)))
  )
    (mode === "PAPER" ? watch : reject).push("HOLDER_CONCENTRATION_UNKNOWN");
  limit("trading.buyTaxPct", policy.maxTaxPct, "TOKEN_TAX_HIGH");
  limit("trading.sellTaxPct", policy.maxTaxPct, "TOKEN_TAX_HIGH");
  limit("liquidity.usd", policy.minimumLiquidityUsd, "LIQUIDITY_TOO_LOW", true);
  limit(
    "trading.roundTripLossPct",
    policy.maximumRoundTripLossPct,
    "ROUND_TRIP_LOSS_HIGH",
  );
  if (policy.minimumLockRemainingSec !== undefined) {
    const until = val("liquidity.unlockAt");
    if (typeof until !== "string" || !Number.isFinite(Date.parse(until)))
      watch.push("LIQUIDITY_LOCK_UNKNOWN");
    else if (Date.parse(until) - now < policy.minimumLockRemainingSec * 1000)
      reject.push("LIQUIDITY_UNLOCK_SOON");
  }
  if (snapshot.disagreements.length)
    watch.push("SECURITY_PROVIDER_DISAGREEMENT");
  if (
    snapshot.externalProviders.some((p) =>
      p.findings.some(
        (f) =>
          f.evidence.state === "RISK" && f.evidence.origin === "REAL_EXTERNAL",
      ),
    )
  )
    watch.push("EXTERNAL_PROVIDER_RISK");
  if (stage !== "PRECHECK" && stage !== "MONITOR") {
    const sell = field("trading.sellability");
    const sellable =
      fresh(sell, policy.sellabilityMaxAgeMs) &&
      sell?.value === "SELLABLE" &&
      sell.origin === "REAL_SIMULATION" &&
      sell.state === "SAFE";
    if (!sellable && policy.rejectUnknownSellability)
      reject.push("SELLABILITY_UNKNOWN");
    if (
      policy.requiredFields.some((path) => {
        // Ignore obsolete configs trying to require funding provenance.
        if (path === "creator.knownBadFunding") return false;
        // SPL authorities do not exist on ERC20. EVM mint/blacklist/pause
        // capabilities remain independently required by the legacy hard filter.
        if (
          ["bnb", "robinhood"].includes(snapshot.chainId) &&
          ["contract.mintAuthority", "contract.freezeAuthority"].includes(path)
        )
          return false;
        return !known(path);
      })
    )
      (mode === "PAPER" ? watch : reject).push("SECURITY_DATA_INCOMPLETE");
    if (stage === "FINAL") {
      const ai = snapshot.jev;
      if (
        !ai ||
        ai.status !== "AVAILABLE" ||
        ai.featureSnapshotHash !== snapshot.snapshotHash
      ) {
        if (mode !== "PAPER" && policy.requireJevForLive)
          reject.push("AI_UNAVAILABLE");
        else watch.push("AI_UNAVAILABLE");
      } else {
        if (
          policy.maxJevRugRisk !== undefined &&
          ai.rugRiskScore !== undefined &&
          ai.rugRiskScore > policy.maxJevRugRisk
        )
          reject.push("JEV_RUG_RISK_HIGH");
        if (
          policy.maxJevSuspicious !== undefined &&
          ai.suspiciousProbability !== undefined &&
          ai.suspiciousProbability > policy.maxJevSuspicious
        )
          reject.push("JEV_SUSPICIOUS_HIGH");
        if (
          policy.maxJevInsufficientData !== undefined &&
          ai.insufficientDataProbability !== undefined &&
          ai.insufficientDataProbability > policy.maxJevInsufficientData
        )
          reject.push("JEV_INSUFFICIENT_DATA");
        if (ai.advisoryAction === "SKIP") reject.push("JEV_ADVISORY_SKIP");
        else if (ai.advisoryAction === "WATCH")
          watch.push("JEV_ADVISORY_WATCH");
      }
    }
  }
  // PRECHECK chặn điều kiện thảm họa; cảnh báo không ngăn thu thập thêm bằng chứng.
  const decision = reject.length
    ? "REJECT"
    : stage === "PRECHECK" || stage === "MONITOR"
      ? "ALLOW"
      : watch.length
        ? "WATCH"
        : "ALLOW";
  return {
    decision,
    reasonCodes: [...new Set([...reject, ...watch])],
    stage,
    decidedAt: new Date(now).toISOString(),
  };
}
