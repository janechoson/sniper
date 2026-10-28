import { randomUUID } from "node:crypto";
import type {
  CandidateRecord,
  OutcomeRecord,
  TokenDiscoveryEvent,
  NormalizedTokenState,
} from "@sniper/core";
import type { ProductionChainAdapter } from "@sniper/chains";
import type { Repository } from "@sniper/storage";
import { outcomeSchema } from "./schemas";
import { observeOutcome } from "./outcomes";
const outcomeHorizons = [60, 300, 900, 3600, 21600, 86400];
interface TrackedPool {
  event: TokenDiscoveryEvent;
  candidateIds: string[];
  lastSampledAt: number;
}
export class RealObservationService {
  private pools = new Map<string, TrackedPool>();
  private outcomes = new Map<string, OutcomeRecord>();
  private sampling = false;
  private stopping = false;
  constructor(
    private readonly repository: Repository,
    private readonly adapters: Map<string, ProductionChainAdapter>,
    private readonly maxPools: number,
    private readonly onObservation: (
      event: TokenDiscoveryEvent,
      market: NormalizedTokenState["market"],
    ) => Promise<void>,
  ) {}
  async restore() {
    for (const entry of await this.repository.read())
      if (entry.kind === "real.outcome") {
        const outcome = outcomeSchema.parse(entry.payload);
        this.outcomes.set(outcome.candidateId, outcome);
        if (this.outcomes.size > this.maxPools * 20)
          this.outcomes.delete(this.outcomes.keys().next().value!);
      }
  }
  async track(record: CandidateRecord) {
    let pool = this.pools.get(record.event.id);
    if (!pool) {
      if (this.pools.size >= this.maxPools)
        this.pools.delete(this.pools.keys().next().value!);
      pool = { event: record.event, candidateIds: [], lastSampledAt: 0 };
      this.pools.set(record.event.id, pool);
    }
    if (!pool.candidateIds.includes(record.id))
      pool.candidateIds = [...pool.candidateIds, record.id].slice(-20);
    if (!this.outcomes.has(record.id)) {
      const outcome: OutcomeRecord = {
        candidateId: record.id,
        chainId: record.event.chainId,
        tokenAddress: record.event.tokenAddress,
        createdAt: record.state?.observedAt ?? record.createdAt,
        initialPriceUsd: record.state?.market.priceUsd,
        initialLiquidityUsd: record.state?.market.liquidityUsd,
        prices: {},
        completedHorizons: [],
      };
      await this.put(outcome);
    }
  }
  private async put(outcome: OutcomeRecord) {
    await this.repository.append({
      id: randomUUID(),
      kind: "real.outcome",
      chainId: outcome.chainId,
      tokenAddress: outcome.tokenAddress,
      payload: outcome,
      createdAt: Date.now(),
    });
    this.outcomes.set(outcome.candidateId, outcome);
    if (this.outcomes.size > this.maxPools * 20)
      this.outcomes.delete(this.outcomes.keys().next().value!);
  }
  all() {
    return [...this.outcomes.values()].map((v) => structuredClone(v));
  }
  async sample() {
    if (this.sampling || this.stopping) return;
    this.sampling = true;
    try {
      const pools = [...this.pools.values()]
        .filter((p) => Date.now() - p.lastSampledAt >= 3000)
        .sort((a, b) => a.lastSampledAt - b.lastSampledAt)
        .slice(0, 3);
      await Promise.allSettled(
        pools.map(async (pool) => {
          pool.lastSampledAt = Date.now();
          const adapter = this.adapters.get(pool.event.chainId);
          const market = await adapter
            ?.market(pool.event)
            .catch(() => undefined);
          const now = Date.now();
          if (market) {
            await this.repository.append({
              id: randomUUID(),
              kind: "real.market",
              chainId: pool.event.chainId,
              tokenAddress: pool.event.tokenAddress,
              payload: {
                discoveryId: pool.event.id,
                poolAddress: pool.event.poolAddress,
                observedAt: adapter?.book.lastObservedAt(pool.event.id) ?? now,
                market,
              },
              createdAt: now,
            });
          }
          for (const id of pool.candidateIds) {
            const old = this.outcomes.get(id);
            if (!old) continue;
            let next: OutcomeRecord | undefined;
            if (market?.priceUsd !== undefined) {
              if (old.initialPriceUsd === undefined)
                next = {
                  ...old,
                  createdAt: now,
                  initialPriceUsd: market.priceUsd,
                  initialLiquidityUsd: market.liquidityUsd,
                };
              else
                next = observeOutcome(
                  old,
                  {
                    identity: {
                      chainId: pool.event.chainId,
                      address: pool.event.tokenAddress,
                      source: "RPC",
                    },
                    observedAt: now,
                    market,
                    holders: {},
                    creator: {},
                    security: { evidence: [] },
                  },
                  now,
                  30000,
                  outcomeHorizons,
                );
            } else {
              const missed = outcomeHorizons.filter(
                (seconds) =>
                  now > old.createdAt + seconds * 1000 + 15000 &&
                  !old.completedHorizons.includes(seconds) &&
                  !old.missedHorizons?.includes(seconds),
              );
              if (missed.length)
                next = {
                  ...old,
                  missedHorizons: [...(old.missedHorizons ?? []), ...missed],
                };
            }
            if (next) await this.put(next);
          }
          if (market) await this.onObservation(pool.event, market);
        }),
      );
    } finally {
      this.sampling = false;
    }
  }
  async stop() {
    this.stopping = true;
    while (this.sampling)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
