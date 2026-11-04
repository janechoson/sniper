const exposure = (p) => BigInt(p.originalQuantity) > 0n
    ? Number((BigInt(p.quantity) * 10000n) / BigInt(p.originalQuantity))
    : 0;
/** Bounded observed runner evidence, only for positions with a confirmed BUY learning sample. */
export class RunnerMemory {
    store;
    constructor(store) {
        this.store = store;
    }
    state(id) {
        const row = this.store.db
            .prepare("SELECT payload FROM position_runner_memory WHERE position_id=?")
            .get(id);
        return row ? JSON.parse(String(row.payload)) : undefined;
    }
    hasTrade(p) {
        return !!this.store.db
            .prepare("SELECT s.id FROM trade_learning_samples s JOIN trade_execution_evidence e ON e.sample_id=s.id WHERE s.id=? AND s.mode=? AND json_extract(e.payload,'$.side')='BUY' AND CAST(json_extract(e.payload,'$.tokenDelta') AS REAL)>0 AND (?='paper' OR (json_extract(e.payload,'$.simulated')=0 AND json_extract(e.payload,'$.signature') IS NOT NULL)) LIMIT 1")
            .get(p.id, p.mode, p.mode);
    }
    initialize(p) {
        if (!this.hasTrade(p))
            return;
        const entry = Number(p.entryPriceUsd);
        return {
            positionId: p.id,
            mint: p.mint,
            mode: p.mode,
            entryAt: p.entryAt,
            entryPriceUsd: Number.isFinite(entry) && entry > 0 ? entry : null,
            lastPriceUsd: null,
            lastObservedAt: null,
            marketMultiple: null,
            heldPriceMfePercent: null,
            heldPriceMaePercent: null,
            positionMfePercent: p.mfePercent ?? null,
            positionMaePercent: p.maePercent ?? null,
            remainingExposureBps: exposure(p),
            milestones: {},
            flowBeforeExpansion: null,
            flowAtObservedPeak: null,
            flowBeforeObservedCollapse: null,
            regimesSeen: [],
            lastLiquidityUsd: null,
            lastMarketCapUsd: null,
            partialExits: [],
            reviews: [],
        };
    }
    save(p, state, at) {
        this.store.db
            .prepare("INSERT INTO position_runner_memory VALUES(?,?,?,?,?) ON CONFLICT(position_id) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload")
            .run(p.id, p.mode, p.mint, at, JSON.stringify(state));
    }
    observe(p, market, flow, now = Date.now(), phase = "OPEN") {
        const state = this.state(p.id) ?? this.initialize(p);
        if (!state ||
            state.mint !== p.mint ||
            market.price.state !== "KNOWN" ||
            market.price.value <= 0)
            return;
        const price = market.price.value, regime = flow?.regime ?? null;
        if (phase === "OPEN") {
            state.lastObservedAt = now;
            state.lastPriceUsd = price;
            state.marketMultiple = state.entryPriceUsd
                ? price / state.entryPriceUsd
                : null;
            if (state.marketMultiple !== null) {
                const gain = (state.marketMultiple - 1) * 100, previousPeak = state.heldPriceMfePercent;
                state.heldPriceMfePercent = Math.max(0, previousPeak ?? 0, gain);
                state.heldPriceMaePercent = Math.min(0, state.heldPriceMaePercent ?? 0, gain);
                if (previousPeak === null || gain > previousPeak)
                    state.flowAtObservedPeak = regime;
                if (gain >= 20 && state.flowBeforeExpansion === null)
                    state.flowBeforeExpansion = state.regimesSeen.at(-1) ?? regime;
                if (previousPeak !== null && gain <= previousPeak - 30)
                    state.flowBeforeObservedCollapse = state.regimesSeen.at(-1) ?? regime;
                for (const threshold of [20, 50, 100, 200, 400, 900, 1900])
                    if (gain >= threshold && !state.milestones[String(threshold)])
                        state.milestones[String(threshold)] = {
                            firstObservedAt: now,
                            elapsedMs: Math.max(0, now - p.entryAt),
                            observedReturnPercent: gain,
                            regime,
                        };
            }
            state.positionMfePercent = p.mfePercent ?? null;
            state.positionMaePercent = p.maePercent ?? null;
            state.remainingExposureBps = exposure(p);
            if (regime && !state.regimesSeen.includes(regime))
                state.regimesSeen.push(regime);
            state.lastLiquidityUsd =
                market.liquidity.state === "KNOWN" ? market.liquidity.value : null;
            state.lastMarketCapUsd =
                market.marketCap.state === "KNOWN" ? market.marketCap.value : null;
        }
        for (const review of state.reviews) {
            const elapsed = now - review.at;
            if (elapsed > 930000) {
                for (const key of ["60", "300", "900"])
                    review.checkpoints[key] ??= {
                        state: "UNAVAILABLE",
                        reason: "NO_OBSERVATION_IN_CHECKPOINT_WINDOW",
                    };
                continue;
            }
            if (elapsed < 0 || review.priceUsd === null)
                continue;
            const change = (price / review.priceUsd - 1) * 100;
            review.observedMfePercent = Math.max(0, review.observedMfePercent ?? 0, change);
            review.observedMaePercent = Math.min(0, review.observedMaePercent ?? 0, change);
            review.lastObservedAt = now;
            for (const seconds of [60, 300, 900]) {
                const key = String(seconds);
                if (review.checkpoints[key])
                    continue;
                if (elapsed >= seconds * 1000 && elapsed <= (seconds + 30) * 1000)
                    review.checkpoints[key] = {
                        state: "OBSERVED",
                        observedAt: now,
                        priceChangePercent: change,
                        phase,
                    };
                else if (elapsed > (seconds + 30) * 1000)
                    review.checkpoints[key] = {
                        state: "UNAVAILABLE",
                        reason: "NO_OBSERVATION_IN_CHECKPOINT_WINDOW",
                    };
            }
            if (regime && review.transitions.at(-1)?.regime !== regime)
                review.transitions = [...review.transitions, { at: now, regime }].slice(-16);
        }
        this.save(p, state, now);
        return this.summary(state);
    }
    decision(d, p) {
        const state = this.state(p.id) ?? this.initialize(p);
        if (!state || state.reviews.some((r) => r.decisionId === d.id))
            return;
        state.reviews = [
            ...state.reviews,
            {
                decisionId: d.id,
                at: d.inputAt ?? d.createdAt,
                action: d.action,
                status: d.status,
                reason: d.reason,
                error: d.error,
                sellBps: d.sellBps,
                flowRegime: d.observedFlow?.regime ?? null,
                priceUsd: d.inputPriceUsd ?? null,
                pnlAtDecision: d.observed?.pnlPercent ?? null,
                observedMfePercent: null,
                observedMaePercent: null,
                checkpoints: {},
                transitions: [],
            },
        ].slice(-128);
        this.save(p, state, d.createdAt);
    }
    fill(e, p) {
        if (e.intent.side !== "SELL" || !e.evidence)
            return;
        const state = this.state(p.id) ?? this.initialize(p);
        if (!state)
            return;
        if (!state.partialExits.some((x) => x.executionId === e.id))
            state.partialExits = [
                ...state.partialExits,
                {
                    executionId: e.id,
                    decisionId: e.intent.jevExitDecisionId,
                    at: e.at,
                    tokensSold: (-BigInt(e.evidence.tokenDelta)).toString(),
                    remainingQuantity: p.quantity,
                    remainingExposureBps: exposure(p),
                    walletSolDelta: e.evidence.solDelta,
                    authority: e.intent.exitAuthority ??
                        (e.intent.manualRequestId
                            ? "MANUAL"
                            : e.intent.jevExitDecisionId
                                ? "JEV"
                                : "SECURITY"),
                },
            ].slice(-64);
        state.remainingExposureBps = exposure(p);
        if (p.state === "CLOSED") {
            state.closedAt = e.at;
            state.finalRealizedLamports = p.realizedLamports;
        }
        this.save(p, state, e.at);
    }
    summary(state) {
        return {
            ...state,
            reviews: state.reviews.slice(-3),
            partialExits: state.partialExits.slice(-8),
        };
    }
    similar(p, flow, now = Date.now()) {
        const candidates = this.store.db
            .prepare("SELECT r.payload runner,o.payload outcome FROM position_runner_memory r JOIN trade_outcomes o ON o.sample_id=r.position_id WHERE r.mode=? AND r.mint!=? AND json_extract(o.payload,'$.closedAt')<=? AND o.available_at<=? AND json_extract(o.payload,'$.accountingComplete')=1 AND json_extract(o.payload,'$.eligibleForStrategy')=1 ORDER BY o.available_at DESC LIMIT 200")
            .all(p.mode, p.mint, now, now);
        const rows = candidates
            .map((row) => {
            const r = JSON.parse(String(row.runner));
            let score = 0, shared = 0;
            if (flow && r.regimesSeen.includes(flow.regime)) {
                score += 0.4;
                shared++;
            }
            if (p.flow &&
                r.lastLiquidityUsd &&
                p.initialLiquidity &&
                Math.max(r.lastLiquidityUsd / p.initialLiquidity, p.initialLiquidity / r.lastLiquidityUsd) <= 3) {
                score += 0.2;
                shared++;
            }
            if (p.entryMarketCap &&
                r.lastMarketCapUsd &&
                Math.max(p.entryMarketCap / r.lastMarketCapUsd, r.lastMarketCapUsd / p.entryMarketCap) <= 3) {
                score += 0.2;
                shared++;
            }
            if (p.mfePercent !== undefined &&
                r.positionMfePercent !== null &&
                Math.abs(p.mfePercent - r.positionMfePercent) <=
                    Math.max(20, Math.abs(p.mfePercent) * 0.5)) {
                score += 0.2;
                shared++;
            }
            return { r, score, shared };
        })
            .filter((x) => x.shared >= 2 && x.score >= 0.4)
            .sort((a, b) => b.score - a.score)
            .slice(0, 5);
        return {
            similarTrades: rows.length,
            usableForDecision: rows.length >= 3,
            confidence: rows.length >= 3 ? "LOW" : "INSUFFICIENT",
            basis: "Observed closed trades in the same mode only; correlations, not predictions; checkpoints not observed remain unavailable",
            examples: rows.map((x) => ({
                similarity: x.score,
                ...this.summary(x.r),
            })),
        };
    }
}
