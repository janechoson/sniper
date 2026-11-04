import { env } from "./config.js";
import { safeError } from "./util.js";
import { tokenLogo } from "./token-metadata.js";
export function mergeDiscovery(old, incoming) {
    const a = old?.discovery, b = incoming.discovery;
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
        const n = b.trending, prior = trending?.basis === n.basis ? trending : undefined;
        const history = [...(prior?.history ?? [])];
        if (n.rank !== undefined && history.at(-1)?.rank !== n.rank)
            history.push({ at: n.lastSeenAt, rank: n.rank });
        const previous = history.at(-2), delta = previous && n.rank !== undefined ? previous.rank - n.rank : null;
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
            movement: delta === null
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
export function discoveryContext(c, now = Date.now(), freshMs = 180000, feed) {
    if (!c?.discovery)
        return {
            sources: ["SNIPER"],
            provenance: "LEGACY_SOURCE_ONLY",
            trending: null,
        };
    const d = c.discovery, t = d.trending;
    return {
        ...d,
        trending: t
            ? {
                ...t,
                stale: now - t.lastSeenAt > freshMs,
                presentInLatestSuccessfulPoll: feed?.state === "READY" ? t.lastSeenAt >= feed.lastAttemptAt : null,
                observedDurationMs: t.lastSeenAt - t.sequenceStartedAt,
                rankMeaning: "Provider rank within configured interval/order/filter; not a global immutable rank",
            }
            : null,
    };
}
export function discoveryBoost(c, s, now = Date.now()) {
    const d = c?.discovery;
    const trending = !!d?.trending && now - d.trending.lastSeenAt <= s.trendingFreshMs;
    return trending
        ? s.trendingPriorityBoost +
            (d?.sources.includes("SNIPER") ? s.multiSourcePriorityBoost : 0)
        : 0;
}
export class DiscoveryCoordinator {
    store;
    gmgn;
    settings;
    active = new Map();
    stopped = false;
    feeds = {
        TRENDING: {
            state: "UNKNOWN",
            lastAttemptAt: 0,
            lastSuccessAt: 0,
            nextAt: 0,
            reason: null,
            count: 0,
            calls: [],
        },
        SNIPER: {
            state: "DISABLED",
            lastAttemptAt: 0,
            lastSuccessAt: 0,
            nextAt: 0,
            reason: "TRENDING_ONLY_NORMAL_DISCOVERY",
            count: 0,
            calls: [],
        },
    };
    counters = {
        trendingDiscovered: 0,
        sniperDiscovered: 0,
        duplicateMerged: 0,
        multiSourceCandidates: 0,
    };
    constructor(store, gmgn, settings) {
        this.store = store;
        this.gmgn = gmgn;
        this.settings = settings;
    }
    async poll(now = Date.now()) {
        if (this.stopped)
            return;
        const waiting = Number(this.store.db
            .prepare("SELECT count(*) n FROM trending_appearances WHERE mode=? AND consumed=0")
            .get(env.TRADING_MODE).n);
        // Backpressure the source instead of dropping appearances or accumulating
        // an unbounded retry backlog. Every fetched appearance is still attempted.
        if (waiting >= this.settings().candidateQueueSize) {
            this.feeds.TRENDING.state = "BACKPRESSURE";
            this.feeds.TRENDING.reason = "CANDIDATE_QUEUE_DRAINING";
            return;
        }
        this.feeds.SNIPER.state = "DISABLED";
        this.feeds.SNIPER.reason = "TRENDING_ONLY_NORMAL_DISCOVERY";
        await Promise.all(["TRENDING"].map((source) => {
            const old = this.active.get(source);
            if (old)
                return old;
            if (now < this.feeds[source].nextAt)
                return Promise.resolve();
            const work = this.pollSource(source, now).finally(() => this.active.delete(source));
            this.active.set(source, work);
            return work;
        }));
    }
    async pollSource(source, now) {
        const f = this.feeds[source], s = this.settings();
        f.lastAttemptAt = now;
        f.calls = [...f.calls.filter((t) => now - t < 60000), now].slice(-120);
        const interval = source === "TRENDING" ? s.trendingPollMs : s.sniperPollMs;
        f.nextAt = now + interval;
        try {
            const candidates = source === "TRENDING"
                ? await this.gmgn.trending(s.trendingInterval, s.trendingLimit)
                : await this.gmgn.discover();
            for (const c of candidates) {
                const old = this.store.token(c.mint);
                if (old)
                    this.counters.duplicateMerged++;
                this.store.discover(c);
                if (old?.discovery?.sources.length !== 2 &&
                    this.store.token(c.mint)?.discovery?.sources.length === 2)
                    this.counters.multiSourceCandidates++;
            }
            if (source === "TRENDING")
                this.store.enqueueTrending(candidates);
            if (source === "TRENDING")
                this.counters.trendingDiscovered += candidates.length;
            else
                this.counters.sniperDiscovered += candidates.length;
            f.state = "READY";
            f.reason = null;
            f.lastSuccessAt = this.gmgn.feedFetchedAt[source] ?? Date.now();
            f.count = candidates.length;
        }
        catch (error) {
            f.state = "DEGRADED";
            f.reason = safeError(error);
            f.nextAt = Date.now() + Math.max(interval, 60000);
            this.store.event("DISCOVERY_SOURCE_DEGRADED", undefined, source + ": " + f.reason);
        }
    }
    status() {
        return {
            feeds: Object.fromEntries(Object.entries(this.feeds).map(([k, v]) => [
                k,
                {
                    ...v,
                    calls: undefined,
                    callsLastMinute: v.calls.filter((t) => Date.now() - t < 60000)
                        .length,
                },
            ])),
            ...this.counters,
            mode: env.TRADING_MODE,
        };
    }
    async stop() {
        this.stopped = true;
        await Promise.allSettled(this.active.values());
    }
}
