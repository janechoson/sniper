import { env, type Settings } from "./config.js";
import type { Candidate } from "./domain.js";
import type { Gmgn } from "./gmgn.js";
import type { Store } from "./store.js";
import { safeError } from "./util.js";
import { tokenLogo } from "./token-metadata.js";

export type DiscoverySource = "TRENDING" | "SNIPER";
export interface DiscoveryEvidence {
  sources: DiscoverySource[];
  firstSeenAt: number;
  lastSeenAt: number;
  sniper?: { firstSeenAt: number; lastSeenAt: number };
  trending?: {
    firstSeenAt: number;
    lastSeenAt: number;
    sequenceStartedAt: number;
    consecutiveObservations: number;
    rank?: number;
    basis: string;
    history: Array<{ at: number; rank: number }>;
    movement:
      | "RISING_FAST"
      | "RISING"
      | "STABLE"
      | "FALLING"
      | "FALLING_FAST"
      | "UNKNOWN";
  };
}
export function mergeDiscovery(
  old: Candidate | undefined,
  incoming: Candidate,
): Candidate {
  const a = old?.discovery,
    b = incoming.discovery;
  if (!b)
    return {
      ...old,
      ...incoming,
      logo: tokenLogo(incoming) ?? tokenLogo(old),
      discoveredAt: old?.discoveredAt ?? incoming.discoveredAt,
      discovery: a,
    };
  let trending = a?.trending;
  if (b.trending) {
    const n = b.trending,
      prior = trending?.basis === n.basis ? trending : undefined;
    const history = [...(prior?.history ?? [])];
    if (n.rank !== undefined && history.at(-1)?.rank !== n.rank)
      history.push({ at: n.lastSeenAt, rank: n.rank });
    const previous = history.at(-2),
      delta = previous && n.rank !== undefined ? previous.rank - n.rank : null;
    const continuous = prior && n.lastSeenAt - prior.lastSeenAt <= 180000;
    trending = {
      ...n,
      firstSeenAt: prior?.firstSeenAt ?? n.firstSeenAt,
      sequenceStartedAt: continuous ? prior.sequenceStartedAt : n.lastSeenAt,
      consecutiveObservations: continuous
        ? prior.consecutiveObservations +
          Number(n.lastSeenAt > prior.lastSeenAt)
        : 1,
      history: history.slice(-20),
      movement:
        delta === null
          ? "UNKNOWN"
          : delta >= 10
            ? "RISING_FAST"
            : delta > 0
              ? "RISING"
              : delta <= -10
                ? "FALLING_FAST"
                : delta < 0
                  ? "FALLING"
                  : "STABLE",
    };
    if (prior && prior.rank === n.rank)
      trending.movement = prior.history.length < 2 ? "STABLE" : prior.movement;
  }
  return {
    ...old,
    ...incoming,
    logo: tokenLogo(incoming) ?? tokenLogo(old),
    discoveredAt: old?.discoveredAt ?? incoming.discoveredAt,
    listing: { ...old?.listing, ...incoming.listing },
    discovery: {
      sources: [...new Set([...(a?.sources ?? []), ...b.sources])],
      firstSeenAt: a?.firstSeenAt ?? b.firstSeenAt,
      lastSeenAt: Math.max(a?.lastSeenAt ?? 0, b.lastSeenAt),
      trending,
      sniper: b.sniper
        ? {
            ...b.sniper,
            firstSeenAt: a?.sniper?.firstSeenAt ?? b.sniper.firstSeenAt,
          }
        : a?.sniper,
    },
  };
}
export function discoveryContext(
  c: Candidate | undefined,
  now = Date.now(),
  freshMs = 180000,
  feed?: { state: string; lastAttemptAt: number },
) {
  if (!c?.discovery)
    return {
      sources: ["SNIPER"],
      provenance: "LEGACY_SOURCE_ONLY",
      trending: null,
    };
  const d = c.discovery,
    t = d.trending;
  return {
    ...d,
    trending: t
      ? {
          ...t,
          stale: now - t.lastSeenAt > freshMs,
          presentInLatestSuccessfulPoll:
            feed?.state === "READY" ? t.lastSeenAt >= feed.lastAttemptAt : null,
          observedDurationMs: t.lastSeenAt - t.sequenceStartedAt,
          rankMeaning:
            "Provider rank within configured interval/order/filter; not a global immutable rank",
        }
      : null,
  };
}
export function discoveryBoost(
  c: Candidate | undefined,
  s: Settings,
  now = Date.now(),
) {
  const d = c?.discovery;
  const trending =
    !!d?.trending && now - d.trending.lastSeenAt <= s.trendingFreshMs;
  return trending
    ? s.trendingPriorityBoost +
        (d?.sources.includes("SNIPER") ? s.multiSourcePriorityBoost : 0)
    : 0;
}
export class DiscoveryCoordinator {
  private active = new Map<DiscoverySource, Promise<void>>();
  private stopped = false;
  readonly feeds = {
    TRENDING: {
      state: "UNKNOWN",
      lastAttemptAt: 0,
      lastSuccessAt: 0,
      nextAt: 0,
      reason: null as string | null,
      count: 0,
      calls: [] as number[],
    },
    SNIPER: {
      state: "DISABLED",
      lastAttemptAt: 0,
      lastSuccessAt: 0,
      nextAt: 0,
      reason: "TRENDING_ONLY_NORMAL_DISCOVERY" as string | null,
      count: 0,
      calls: [] as number[],
    },
  };
  readonly counters = {
    trendingDiscovered: 0,
    sniperDiscovered: 0,
    duplicateMerged: 0,
    multiSourceCandidates: 0,
  };
  constructor(
    private store: Store,
    private gmgn: Gmgn,
    private settings: () => Settings,
    private analysisBusy: () => boolean = () => false,
  ) {}
  async poll(now = Date.now()) {
    if (this.stopped) return;
    // This gate applies only to discovery of a NEW list, never shared GMGN
    // reads, dashboard polling, candidate evidence or Position/SELL monitoring.
    if (this.analysisBusy() || this.store.trendingWorkPending()) {
      this.feeds.TRENDING.state = "BACKPRESSURE";
      this.feeds.TRENDING.reason = "CANDIDATE_QUEUE_DRAINING";
      return;
    }
    this.feeds.SNIPER.state = "DISABLED";
    this.feeds.SNIPER.reason = "TRENDING_ONLY_NORMAL_DISCOVERY";
    await Promise.all(
      (["TRENDING"] as const).map((source) => {
        const old = this.active.get(source);
        if (old) return old;
        if (now < this.feeds[source].nextAt) return Promise.resolve();
        const work = this.pollSource(source, now).finally(() =>
          this.active.delete(source),
        );
        this.active.set(source, work);
        return work;
      }),
    );
  }
  private async pollSource(source: DiscoverySource, now: number) {
    const f = this.feeds[source],
      s = this.settings();
    f.lastAttemptAt = now;
    f.state = "FETCHING";
    f.reason = null;
    f.calls = [...f.calls.filter((t) => now - t < 60000), now].slice(-120);
    const interval = source === "TRENDING" ? s.trendingPollMs : s.sniperPollMs;
    f.nextAt = now + interval;
    try {
      const candidates =
        source === "TRENDING"
          ? await this.gmgn.trending(s.trendingInterval, s.trendingLimit)
          : await this.gmgn.discover();
      for (const c of candidates) {
        const old = this.store.token(c.mint);
        if (old) this.counters.duplicateMerged++;
        this.store.discover(c);
        if (
          old?.discovery?.sources.length !== 2 &&
          this.store.token(c.mint)?.discovery?.sources.length === 2
        )
          this.counters.multiSourceCandidates++;
      }
      if (source === "TRENDING")
        this.store.enqueueTrending(
          candidates,
          env.TRADING_MODE,
          this.gmgn.feedFetchedAt[source] ?? Date.now(),
        );
      if (source === "TRENDING")
        this.counters.trendingDiscovered += candidates.length;
      else this.counters.sniperDiscovered += candidates.length;
      f.state = "READY";
      f.reason = null;
      f.lastSuccessAt = this.gmgn.feedFetchedAt[source] ?? Date.now();
      f.count = candidates.length;
    } catch (error) {
      f.state = "DEGRADED";
      f.reason = safeError(error);
      f.nextAt = Date.now() + Math.max(interval, 60000);
      this.store.event(
        "DISCOVERY_SOURCE_DEGRADED",
        undefined,
        source + ": " + f.reason,
      );
    }
  }
  status() {
    return {
      feeds: Object.fromEntries(
        Object.entries(this.feeds).map(([k, v]) => [
          k,
          {
            ...v,
            calls: undefined,
            callsLastMinute: v.calls.filter((t) => Date.now() - t < 60000)
              .length,
          },
        ]),
      ),
      ...this.counters,
      mode: env.TRADING_MODE,
      batch: this.store.trendingBatchProgress(),
    };
  }
  async stop() {
    this.stopped = true;
    await Promise.allSettled(this.active.values());
  }
}
