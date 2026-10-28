import type {
  RugCheckSnapshot,
  RugAnalytics,
  SecurityReadinessRow,
  OutcomeRecord,
} from "@sniper/core";
export function rugAnalytics(
  snapshots: RugCheckSnapshot[],
  outcomes: OutcomeRecord[],
  candidateSnapshot: Map<string, RugCheckSnapshot>,
): RugAnalytics {
  const count = (items: string[]) =>
    Object.fromEntries(
      [...new Set(items)].map((k) => [k, items.filter((x) => x === k).length]),
    );
  const keys = [...new Set(snapshots.flatMap((s) => Object.keys(s.latencies)))],
    latency: RugAnalytics["latency"] = {};
  for (const key of keys) {
    const values = snapshots
      .flatMap((s) =>
        s.latencies[key] === undefined ? [] : [s.latencies[key]!],
      )
      .sort((a, b) => a - b);
    const q = (p: number) =>
      values.length >= (p >= 0.99 ? 100 : p >= 0.95 ? 20 : 5)
        ? values[Math.max(0, Math.ceil(values.length * p) - 1)]!
        : null;
    latency[key] = {
      samples: values.length,
      p50: q(0.5),
      p95: q(0.95),
      p99: q(0.99),
    };
  }
  // Sụt liquidity >=90% trong mẫu là collapse quan sát, không tự gán rug/scammer.
  const collapsed = outcomes.filter(
    (o) =>
      o.initialLiquidityUsd !== undefined &&
      o.initialLiquidityUsd > 0 &&
      Object.values(o.liquidityByHorizon ?? {}).some(
        (value) => value / o.initialLiquidityUsd! <= 0.1,
      ),
  );
  const allowed = collapsed.filter(
    (o) => candidateSnapshot.get(o.candidateId)?.decision?.decision === "ALLOW",
  ).length;
  const rejected = collapsed.filter(
    (o) =>
      candidateSnapshot.get(o.candidateId)?.decision?.decision === "REJECT",
  ).length;
  const recovered = outcomes.filter(
    (o) =>
      o.completedHorizons.includes(3600) &&
      o.initialLiquidityUsd !== undefined &&
      o.initialLiquidityUsd > 0 &&
      o.liquidityByHorizon?.["3600"] !== undefined &&
      o.liquidityByHorizon["3600"]! / o.initialLiquidityUsd > 0.9 &&
      candidateSnapshot.get(o.candidateId)?.decision?.decision === "REJECT",
  ).length;
  return {
    tokensScanned: snapshots.length,
    tokensRejected: snapshots.filter((s) => s.decision?.decision === "REJECT")
      .length,
    reasons: count(snapshots.flatMap((s) => s.decision?.reasonCodes ?? [])),
    jevActions: count(
      snapshots.flatMap((s) =>
        s.jev?.advisoryAction ? [s.jev.advisoryAction] : [],
      ),
    ),
    providerDisagreements: snapshots.filter((s) => s.disagreements.length > 0)
      .length,
    jevDeterministicDisagreements: snapshots.filter(
      (s) =>
        (s.jev?.advisoryAction === "PASS" &&
          s.decision?.decision !== "ALLOW") ||
        (s.jev?.advisoryAction === "SKIP" && s.decision?.decision === "ALLOW"),
    ).length,
    sellabilityFailures: snapshots.filter(
      (s) => s.trading.sellability?.value === "NOT_SELLABLE",
    ).length,
    liquidityRemovals: snapshots.filter(
      (s) =>
        s.liquidity.recentRemovalPct?.state === "RISK" &&
        s.liquidity.recentRemovalPct.origin === "REAL_ONCHAIN",
    ).length,
    creatorIncidents: snapshots.filter(
      (s) => s.creator.criticalIncidents?.state === "RISK",
    ).length,
    latency,
    outcomeEvents: {
      liquidityCollapse: collapsed.length,
      rejectedThenCollapsed: rejected,
      allowedThenCollapsed: allowed,
      falsePositiveCandidates: recovered,
      falseNegativeCandidates: allowed,
    },
    definitions: {
      liquidityCollapse:
        "Liquidity USD quan sát giảm >=90%, có initial sample và horizon; chưa chứng minh rút LP hay rug",
      falsePositiveCandidates:
        "Bị từ chối nhưng còn liquidity >90% mức ban đầu tại mẫu1h; chỉ là ứng viên cần review",
      falseNegativeCandidates:
        "Được cho phép nhưng liquidity collapse theo định nghĩa; không tự gán nhãn rug",
      scope:
        "Latest snapshot mỗi token trong bộ nhớ; outcome theo từng decision, không phải toàn bộ lịch sử",
    },
  };
}
export function securityReadiness(
  chains: string[],
  snapshots: RugCheckSnapshot[],
  maxAgeMs: number,
  now = Date.now(),
): SecurityReadinessRow[] {
  return chains.map((chainId) => {
    const s = [...snapshots].reverse().find((s) => s.chainId === chainId);
    const group = (
      section: "contract" | "trading" | "liquidity" | "holders" | "creator",
      fields: string[],
    ): "READY" | "PARTIAL" | "NOT_READY" | "UNKNOWN" => {
      if (!s) return "UNKNOWN";
      const entries = fields.map((f) => s[section][f]);
      if (entries.some((e) => e?.state === "RISK")) return "NOT_READY";
      const known = entries.filter(
        (e) =>
          e &&
          e.state !== "UNKNOWN" &&
          now - Date.parse(e.observedAt) <= maxAgeMs &&
          (!e.validUntil || Date.parse(e.validUntil) > now),
      );
      return known.length === fields.length
        ? "READY"
        : known.length
          ? "PARTIAL"
          : "UNKNOWN";
    };
    const components: SecurityReadinessRow["components"] = {
      tokenSecurity: group(
        "contract",
        chainId === "solana"
          ? ["validToken", "mintAuthority", "freezeAuthority"]
          : ["validToken", "bytecodeHash"],
      ),
      holders: group("holders", ["count", "top1Pct", "top10Pct"]),
      creator: group("creator", ["history", "criticalIncidents"]),
      liquidity: group("liquidity", ["usd"]),
      buyQuote: group("trading", ["buyQuote"]),
      sellQuote: group("trading", ["sellQuote"]),
      sellSimulation:
        s?.trading.sellability?.origin === "REAL_SIMULATION"
          ? group("trading", ["sellability"])
          : "UNKNOWN",
      jev:
        s?.jev?.status === "AVAILABLE" &&
        now - Date.parse(s.jev.timestamp) <= maxAgeMs
          ? "READY"
          : "UNKNOWN",
      riskEngine:
        s?.decision?.stage === "FINAL" && s.decision.decision === "ALLOW"
          ? "READY"
          : s?.decision
            ? "NOT_READY"
            : "UNKNOWN",
    };
    return {
      chainId,
      scope: "LATEST_OBSERVED_TOKEN" as const,
      tokenAddress: s?.tokenAddress,
      components,
      // Creator history coverage is research, not execution safety. Proven
      // critical creator incidents still affect the deterministic rug decision.
      ready: Object.entries(components)
        .filter(([key]) => key !== "creator")
        .every(([, v]) => v === "READY"),
    };
  });
}
