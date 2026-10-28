import type {
  CandidateRecord,
  DashboardSnapshot,
  TokenDiscoveryEvent,
} from "@sniper/core";
type SourceStats = NonNullable<
  DashboardSnapshot["discovery"]
>["sources"][string];
const names = ["pump-fun", "pump-swap", "raydium-cpmm", "meteora-dlmm"];
export function latestUniqueCandidates(
  records: readonly CandidateRecord[],
  limit = 100,
) {
  const result: CandidateRecord[] = [],
    seen = new Set<string>();
  for (let i = records.length - 1; i >= 0 && result.length < limit; i--) {
    const record = records[i]!;
    if (record.event.chainId !== "solana") {
      const key = `${record.event.chainId}:${record.event.tokenAddress.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
    }
    result.push(record);
  }
  return result;
}
export function hasRecordedTokenEntry(
  event: TokenDiscoveryEvent,
  executions: readonly { intentId: string; state: string }[],
  lookup: (
    id: string,
  ) => { side: string; chainId: string; tokenOut: string } | undefined,
) {
  return executions.some((execution) => {
    if (
      ["FAILED", "REVERTED", "EXPIRED", "CANCELLED"].includes(execution.state)
    )
      return false;
    const intent = lookup(execution.intentId);
    return (
      intent?.side === "BUY" &&
      intent.chainId === event.chainId &&
      (event.chainId === "solana"
        ? intent.tokenOut === event.tokenAddress
        : intent.tokenOut.toLowerCase() === event.tokenAddress.toLowerCase())
    );
  });
}
export class DiscoveryMonitor {
  private readonly sources: Record<string, SourceStats> = Object.fromEntries(
    names.map((name) => [
      name,
      {
        detected: 0,
        cheapGuardPass: 0,
        cheapRejected: 0,
        cheapDeferred: 0,
        deepAnalyzed: 0,
        rugRejected: 0,
        sellabilityPass: 0,
        jevAnalyzed: 0,
        riskApproved: 0,
        paperBought: 0,
        reasons: {},
      },
    ]),
  );
  private readonly tokens = new Map<
    string,
    NonNullable<CandidateRecord["lifecycle"]>
  >();
  private readonly started = Date.now();
  private runtimeEvents = 0;
  private runtimeCandidates = 0;
  private discoveryMs = 0;
  private discoverySamples = 0;
  private analysisMs = 0;
  private analysisSamples = 0;
  duplicates = 0;
  backpressure = 0;
  constructor(
    private readonly capacity: number,
    deployments: readonly {
      chainId: string;
      id: string;
      enabled: boolean;
    }[] = [],
  ) {
    for (const d of deployments)
      if (d.enabled && d.chainId !== "solana")
        this.ensure(`${d.chainId}:${d.id}`);
  }
  private ensure(source: string) {
    return (
      this.sources[source] ??
      (this.sources[source] = {
        detected: 0,
        cheapGuardPass: 0,
        cheapRejected: 0,
        cheapDeferred: 0,
        deepAnalyzed: 0,
        rugRejected: 0,
        sellabilityPass: 0,
        jevAnalyzed: 0,
        riskApproved: 0,
        paperBought: 0,
        reasons: {},
      })
    );
  }
  private identity(event: TokenDiscoveryEvent) {
    return `${event.chainId}:${event.chainId === "solana" ? event.tokenAddress : event.tokenAddress.toLowerCase()}`;
  }
  source(event: TokenDiscoveryEvent) {
    if (event.chainId !== "solana") return `${event.chainId}:${event.dexId}`;
    return event.chainId === "solana" && names.includes(event.dexId)
      ? event.dexId
      : undefined;
  }
  observe(event: TokenDiscoveryEvent, restoring = false) {
    const source = this.source(event);
    if (!source) return;
    this.ensure(source).detected++;
    this.attach(event);
    if (!restoring) {
      this.runtimeEvents++;
      if (
        event.chainTimestamp !== undefined &&
        event.detectedAt !== undefined &&
        event.detectedAt >= event.chainTimestamp
      ) {
        this.discoveryMs += event.detectedAt - event.chainTimestamp;
        this.discoverySamples++;
      }
    }
  }
  attach(event: TokenDiscoveryEvent) {
    const source = this.source(event);
    if (!source) return;
    const identity = this.identity(event);
    const old = this.tokens.get(identity) ?? {
      identity,
      firstSeenAt: event.chainTimestamp ?? event.timestamp,
      sources: [],
      pools: [],
    };
    old.firstSeenAt = Math.min(
      old.firstSeenAt,
      event.chainTimestamp ?? event.timestamp,
    );
    if (!old.sources.includes(source)) old.sources.push(source);
    if (!old.pools.includes(event.poolAddress))
      old.pools = [...old.pools, event.poolAddress].slice(-8);
    const stage = String(
      (event.rawEvent as Record<string, unknown> | undefined)?.stage ??
        "DISCOVERED",
    );
    const chainAt = event.chainTimestamp ?? event.timestamp;
    if (["CURVE_CREATED", "LAUNCH_CREATED", "INSTANT_LAUNCHED"].includes(stage))
      old.launchedAt = Math.min(old.launchedAt ?? chainAt, chainAt);
    if (stage === "GRADUATED")
      old.graduatedAt = Math.min(old.graduatedAt ?? chainAt, chainAt);
    const creator = (event.rawEvent as Record<string, unknown> | undefined)
      ?.creator;
    const observations = old.observations ?? [];
    if (
      !observations.some(
        (o) =>
          o.transactionId === event.transactionId &&
          o.source === source &&
          o.stage === stage &&
          o.pool === event.poolAddress,
      )
    )
      old.observations = [
        ...observations,
        {
          source,
          stage,
          pool: event.poolAddress,
          transactionId: event.transactionId,
          creator: typeof creator === "string" ? creator : undefined,
          observedAt: event.detectedAt ?? event.timestamp,
          onchainAt: event.chainTimestamp ?? event.timestamp,
          quoteAsset: event.quoteAsset,
        },
      ].slice(-16);
    this.tokens.delete(identity);
    this.tokens.set(identity, old);
    if (this.tokens.size > this.capacity)
      this.tokens.delete(this.tokens.keys().next().value!);
  }
  lifecycle(event: TokenDiscoveryEvent) {
    const value = this.tokens.get(this.identity(event));
    return value ? structuredClone(value) : undefined;
  }
  analyzed(record: CandidateRecord, restoring = false) {
    const source = this.source(record.event);
    if (!source) return;
    const stats = this.ensure(source);
    if (record.discoveryGuard?.passed) stats.cheapGuardPass++;
    else if (record.discoveryGuard?.deferred) stats.cheapDeferred++;
    else if (record.discoveryGuard) stats.cheapRejected++;
    if (record.state) stats.deepAnalyzed++;
    if (record.rugCheck?.decision?.decision === "REJECT") stats.rugRejected++;
    if (
      record.observation?.sellability === "SELLABLE" ||
      record.rugCheck?.trading.sellability?.value === "SELLABLE"
    )
      stats.sellabilityPass++;
    if (record.aiAttempted) stats.jevAnalyzed++;
    if (record.risk?.passed) stats.riskApproved++;
    if (record.observation?.stage === "VIRTUAL_OPEN") stats.paperBought++;
    for (const code of record.reasons) {
      const safe = /^[A-Z][A-Z0-9_:-]{0,120}$/.test(code) ? code : "OTHER";
      if (
        stats.reasons[safe] !== undefined ||
        Object.keys(stats.reasons).length < 128
      )
        stats.reasons[safe] = (stats.reasons[safe] ?? 0) + 1;
    }
    if (!restoring) {
      this.runtimeCandidates++;
      if (record.analysisLatencyMs !== undefined) {
        this.analysisMs += record.analysisLatencyMs;
        this.analysisSamples++;
      }
    }
  }
  summary() {
    const seconds = Math.max(1, (Date.now() - this.started) / 1000);
    return {
      sources: structuredClone(this.sources),
      duplicates: this.duplicates,
      backpressure: this.backpressure,
      eventsPerSecond: this.runtimeEvents / seconds,
      candidatesPerSecond: this.runtimeCandidates / seconds,
      averageDiscoveryLatencyMs: this.discoverySamples
        ? this.discoveryMs / this.discoverySamples
        : null,
      averageAnalysisLatencyMs: this.analysisSamples
        ? this.analysisMs / this.analysisSamples
        : null,
    };
  }
}
