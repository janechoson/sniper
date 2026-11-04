/** Public GMGN participant evidence only. No decision cache or execution authority. */
const obj = (x) => x && typeof x === "object" && !Array.isArray(x)
    ? x
    : {};
const str = (x, max = 256) => typeof x === "string" && x.trim() ? x.trim().slice(0, max) : null;
const numeric = (x) => {
    if ((typeof x !== "number" && typeof x !== "string") ||
        (typeof x === "string" && x.trim() === ""))
        return null;
    const n = Number(x);
    return Number.isFinite(n) && n >= 0 ? n : null;
};
export function normalizeSmartMoney(raw, requestedLimit = 100) {
    const envelope = obj(raw), body = obj(envelope.data ?? raw);
    const rows = Array.isArray(body.list) ? body.list : [];
    const observedAt = numeric(obj(envelope._gmgnSnapshot).fetchedAt);
    const events = [], byHash = new Map();
    let duplicates = 0, conflictingTransactions = 0;
    for (const value of rows.slice(0, requestedLimit)) {
        const r = obj(value), t = numeric(r.timestamp);
        const event = {
            mint: str(r.base_address),
            maker: str(r.maker),
            side: r.side === "buy" || r.side === "sell" ? r.side : null,
            timestamp: t && t > 0 ? (t < 1e12 ? t * 1000 : t) : null,
            amountUsd: numeric(r.amount_usd),
            transactionHash: str(r.transaction_hash),
            tags: Array.isArray(obj(r.maker_info).tags)
                ? obj(r.maker_info).tags
                    .flatMap((t) => (str(t, 64) ? [str(t, 64)] : []))
                    .slice(0, 20)
                : [],
        };
        const key = event.transactionHash
            ? event.mint + ":" + event.transactionHash
            : null;
        const prior = key ? byHash.get(key) : undefined;
        if (prior) {
            duplicates++;
            if (prior.side !== event.side ||
                prior.maker !== event.maker ||
                prior.amountUsd !== event.amountUsd ||
                prior.timestamp !== event.timestamp) {
                // Ambiguous multiple legs cannot safely be counted as a directional trade.
                prior.side = null;
                prior.amountUsd = null;
                conflictingTransactions++;
            }
            continue;
        }
        events.push(event);
        if (key)
            byHash.set(key, event);
    }
    events.sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
    const times = events.flatMap((e) => e.timestamp === null ? [] : [e.timestamp]);
    return {
        source: "GMGN_SMART_MONEY_SUBSET",
        available: Array.isArray(body.list),
        observedAt,
        requestedLimit,
        returnedCount: rows.length,
        oldestTimestamp: times.length ? Math.min(...times) : null,
        newestTimestamp: times.length ? Math.max(...times) : null,
        coverageSeconds: times.length
            ? (Math.max(...times) - Math.min(...times)) / 1000
            : null,
        events,
        duplicates,
        conflictingTransactions,
    };
}
export const unavailableSmartMoney = () => normalizeSmartMoney(null);
export function smartMoneySupport(snapshot, mint, window) {
    const matches = snapshot.events.filter((e) => e.mint === mint);
    const fresh = snapshot.observedAt !== null &&
        snapshot.observedAt <= window.to &&
        window.to - snapshot.observedAt <= window.maxAgeMs;
    const events = matches.filter((e) => e.timestamp !== null &&
        window.from !== null &&
        e.timestamp >= window.from &&
        e.timestamp <= window.to);
    // Unknown hashes/makers/side/time/USD remain visible, but cannot create support or clusters.
    const usable = events.filter((e) => e.transactionHash &&
        e.maker &&
        e.side &&
        e.timestamp !== null &&
        e.amountUsd !== null &&
        (window.eventMaxAgeMs === undefined ||
            window.to - e.timestamp <= window.eventMaxAgeMs));
    const buySupportFrom = window.buySupportFrom === undefined ? window.from : window.buySupportFrom;
    const buys = usable.filter((e) => e.side === "buy" &&
        buySupportFrom !== null &&
        e.timestamp >= buySupportFrom), sells = usable.filter((e) => e.side === "sell");
    const distinctBuyers = new Set(buys.map((e) => e.maker)).size;
    const distinctSellers = new Set(sells.map((e) => e.maker)).size;
    const sum = (xs) => xs.reduce((s, e) => s + e.amountUsd, 0);
    const totalsKnown = Number.isFinite(sum(buys)) &&
        Number.isFinite(sum(sells)) &&
        Number.isFinite(sum(buys) - sum(sells));
    const buyUsd = buys.length && totalsKnown ? sum(buys) : null, sellUsd = sells.length && totalsKnown ? sum(sells) : null;
    const computedNetBuyUsd = (buys.length || sells.length) && totalsKnown
        ? sum(buys) - sum(sells)
        : null;
    const lastBuyAt = buys.at(-1)?.timestamp ?? null, lastSellAt = sells.at(-1)?.timestamp ?? null;
    const buyingResponse = buys.length > 0 &&
        (lastSellAt === null || lastBuyAt > lastSellAt) &&
        (computedNetBuyUsd ?? 0) > 0;
    const sellingResponse = sells.length > 0 &&
        (lastBuyAt === null || lastSellAt > lastBuyAt) &&
        (computedNetBuyUsd ?? 0) < 0;
    const status = !snapshot.available
        ? "UNAVAILABLE"
        : !fresh
            ? "INSUFFICIENT_COVERAGE"
            : !matches.length
                ? "NO_MATCH_IN_RETURNED_FEED"
                : (!buys.length && !sells.length) || !totalsKnown
                    ? "INSUFFICIENT_COVERAGE"
                    : buyingResponse
                        ? "BUY_SUPPORT"
                        : sellingResponse
                            ? "SELL_PRESSURE"
                            : "MIXED";
    const cluster = (xs, distinct) => ({
        present: snapshot.available && fresh && distinct > 1,
        distinctMakers: distinct,
        from: xs[0]?.timestamp ?? null,
        to: xs.at(-1)?.timestamp ?? null,
        groupingWindow: { from: window.from, to: window.to },
        independentOwnersProven: false,
    });
    return {
        source: snapshot.source,
        semantics: "TIMESTAMPED_PARTICIPANT_FLOW",
        status,
        available: snapshot.available,
        freshness: fresh ? "FRESH" : "UNKNOWN_OR_STALE",
        observedAt: snapshot.observedAt,
        alignment: {
            from: window.from,
            to: window.to,
            buySupportFrom,
            lastBuyAt,
            lastSellAt,
        },
        coverage: {
            requestedLimit: snapshot.requestedLimit,
            returnedCount: snapshot.returnedCount,
            oldestTimestamp: snapshot.oldestTimestamp,
            newestTimestamp: snapshot.newestTimestamp,
            coverageSeconds: snapshot.coverageSeconds,
            tokenMatchedCount: matches.length,
            alignedCount: events.length,
            usableCount: usable.length,
            distinctMakerCount: new Set(matches.flatMap((e) => (e.maker ? [e.maker] : []))).size,
            completeness: "UNKNOWN_CAPPED_FEED",
        },
        buys: fresh && snapshot.available ? buys.length : null,
        sells: fresh && snapshot.available ? sells.length : null,
        distinctBuyers: fresh && snapshot.available ? distinctBuyers : null,
        distinctSellers: fresh && snapshot.available ? distinctSellers : null,
        buyUsd: fresh ? buyUsd : null,
        sellUsd: fresh ? sellUsd : null,
        computedNetBuyUsd: fresh ? computedNetBuyUsd : null,
        buyerCluster: cluster(buys, distinctBuyers),
        sellerCluster: cluster(sells, distinctSellers),
        events,
        observedFrom: events[0]?.timestamp ?? null,
        observedTo: events.at(-1)?.timestamp ?? null,
        duplicates: snapshot.duplicates,
        conflictingTransactions: snapshot.conflictingTransactions,
        limitations: [
            "Capped Smart Money subset; not market-wide flow",
            "Missing records are not proof of absence of buyers",
            "Distinct makers do not prove independent owners",
            "Unknown fields excluded from metrics",
            "Zero counts describe returned aligned sample only; missing-side USD remains unknown",
        ],
    };
}
