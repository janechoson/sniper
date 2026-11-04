import { existsSync, readFileSync } from "node:fs";
import { record } from "./gmgn.js";
import { hash, json } from "./util.js";
import { RunnerMemory } from "./runner-memory.js";
import { LEARNING_VERSION, learningSettingsSchema, featureVector, pnl, excursions, exitReason, OutcomeAnalyzer, aggregate, similarity, recencyWeight, } from "./learning.js";
export class TradingMemory {
    store;
    runner;
    settings;
    constructor(store, settings) {
        this.store = store;
        this.runner = new RunnerMemory(store);
        this.settings = learningSettingsSchema.parse(settings ??
            (existsSync("config/learning.json")
                ? JSON.parse(readFileSync("config/learning.json", "utf8"))
                : {}));
    }
    rows(table, sampleId) {
        // Table names are internal literals, never user input.
        return this.store.db
            .prepare(`SELECT payload FROM ${table} WHERE sample_id=? ORDER BY at`)
            .all(sampleId)
            .map((r) => JSON.parse(String(r.payload)));
    }
    sample(id) {
        const row = this.store.db
            .prepare("SELECT payload FROM trade_learning_samples WHERE id=?")
            .get(id);
        return row ? JSON.parse(String(row.payload)) : undefined;
    }
    entry(e, snapshot, strategy, now = Date.now()) {
        const i = e.intent;
        if (i.strategy === "KRONOS" || snapshot.strategy === "KRONOS")
            return;
        const sample = {
            exitFeasibility: e.exitFeasibility
                ? structuredClone(e.exitFeasibility)
                : undefined,
            id: i.positionId,
            tradeId: e.id,
            positionId: i.positionId,
            mint: i.mint,
            mode: i.mode,
            at: now,
            snapshot: structuredClone(snapshot),
            snapshotHash: hash(snapshot),
            requestedLamports: i.amount,
            features: featureVector(snapshot),
            jevInput: this.store.latest("jev_inputs", i.mint) ?? null,
            risk: this.store.latest("risk_decisions", i.mint) ?? {
                outcome: "BUY",
                allowed: true,
                reason: i.reason,
                at: i.createdAt,
            },
            strategy: structuredClone(strategy),
            origin: "STRATEGY",
            learningVersion: LEARNING_VERSION,
            learningSettings: structuredClone(this.settings),
        };
        if (sample.snapshotHash !== i.snapshotHash)
            throw new Error("Learning entry does not match approved snapshot");
        this.store.db
            .prepare("INSERT OR IGNORE INTO trade_learning_samples VALUES(?,?,?,?,?,?,?)")
            .run(sample.id, sample.tradeId, sample.positionId, sample.mint, sample.mode, sample.at, json(sample));
    }
    preflight(e, quote) {
        if (!this.sample(e.intent.positionId))
            return;
        const o = quote.order;
        const payload = {
            at: Date.now(),
            executionId: e.id,
            provider: quote.provider,
            side: quote.side,
            amount: quote.amount,
            inputMint: o.inputMint,
            outputMint: o.outputMint,
            outAmount: o.outAmount,
            minimumOutput: o.otherAmountThreshold,
            slippageBps: o.slippageBps,
            router: o.router,
            routePlan: o.routePlan,
            estimatedNetworkFeeLamports: String(o.signatureFeeLamports + o.prioritizationFeeLamports),
            estimatedRentLamports: String(o.rentFeeLamports),
            finalRisk: this.store.latest("final_risk_decisions", e.intent.mint) ?? null,
        };
        this.store.db
            .prepare("INSERT OR IGNORE INTO trade_execution_preflights VALUES(?,?,?,?)")
            .run(e.id, e.intent.positionId, payload.at, json(payload));
    }
    exit(e, position) {
        if (!this.sample(position.id))
            return;
        const observations = this.rows("trade_observations", position.id).filter((o) => o.phase === "OPEN");
        const current = excursions(observations.flatMap((o) => o.pnlPercent === undefined ? [] : [o.pnlPercent]));
        const snapshot = {
            executionId: e.id,
            at: e.intent.createdAt,
            reason: e.intent.reason,
            reasonCode: exitReason(e.intent.reason),
            market: this.store.latest("position_market", position.mint) ?? null,
            security: this.store.latest("position_security", position.mint) ?? null,
            quantity: e.intent.amount,
            holdingDurationMs: Math.max(0, e.intent.createdAt - position.entryAt),
            ...current,
            jev: e.intent.jevExitDecisionId
                ? (this.store.jevExit(e.intent.jevExitDecisionId) ?? null)
                : null,
            authority: e.intent.exitAuthority ??
                (e.intent.manualRequestId
                    ? "MANUAL"
                    : e.intent.jevExitDecisionId
                        ? "JEV"
                        : "SECURITY"),
            capitalFlow: position.flow,
        };
        this.store.db
            .prepare("INSERT OR IGNORE INTO trade_exit_snapshots VALUES(?,?,?,?)")
            .run(e.id, position.id, snapshot.at, json(snapshot));
    }
    confirmed(e) {
        if (e.intent.strategy === "KRONOS")
            return;
        const sample = this.sample(e.intent.positionId);
        if (!sample || e.state !== "CONFIRMED" || !e.evidence)
            return;
        const preflight = this.store.db
            .prepare("SELECT payload FROM trade_execution_preflights WHERE execution_id=?")
            .get(e.id);
        const q = preflight ? JSON.parse(String(preflight.payload)) : null;
        const actualOutput = e.intent.side === "BUY"
            ? BigInt(e.evidence.tokenDelta)
            : BigInt(e.evidence.solDelta);
        const fill = {
            executionId: e.id,
            at: e.at,
            side: e.intent.side,
            signature: e.signature,
            provider: e.intent.provider,
            solDelta: e.evidence.solDelta,
            tokenDelta: e.evidence.tokenDelta,
            networkFeeLamports: e.evidence.feeLamports,
            priorityFeeLamports: null,
            confirmationTimeMs: e.submittedAt
                ? Math.max(0, e.at - e.submittedAt)
                : null,
            outputShortfallBps: e.intent.side === "BUY" && q && BigInt(q.outAmount) > 0n
                ? Number(((BigInt(q.outAmount) - actualOutput) * 10000n) /
                    BigInt(q.outAmount))
                : null,
            simulated: e.intent.mode === "paper",
            ...(e.intent.side === "BUY"
                ? {
                    entryPriceSolAtomicRatio: {
                        lamports: (-BigInt(e.evidence.solDelta)).toString(),
                        tokens: e.evidence.tokenDelta,
                    },
                }
                : {}),
        };
        this.store.db
            .prepare("INSERT OR IGNORE INTO trade_execution_evidence VALUES(?,?,?,?)")
            .run(e.id, sample.id, fill.at, json(fill));
        const current = this.store
            .positions(e.intent.mode)
            .find((p) => p.id === e.intent.positionId);
        if (current) {
            this.runner.fill(e, current);
            const runner = this.runner.state(current.id);
            if (runner) {
                current.runner = this.runner.summary(runner);
                this.store.savePosition(current);
            }
        }
        this.refresh(sample.id);
    }
    failure(e) {
        if (e.intent.strategy === "KRONOS")
            return;
        const payload = {
            executionId: e.id,
            state: e.state,
            error: e.error ?? null,
            side: e.intent.side,
            signature: e.signature ?? null,
            feeLamports: e.failedFeeLamports ?? (e.signature ? null : "0"),
        };
        this.store.db
            .prepare("INSERT OR IGNORE INTO trade_execution_failures VALUES(?,?,?,?)")
            .run(hash(payload), this.sample(e.intent.positionId)?.id ?? null, e.at, json(payload));
        if (this.sample(e.intent.positionId))
            this.refresh(e.intent.positionId);
    }
    observe(position, market, security, value, extras, now = Date.now()) {
        const sample = this.sample(position.id);
        if (!sample)
            return;
        const prior = this.rows("trade_observations", sample.id).filter((o) => o.phase === "OPEN"), last = prior.at(-1);
        const securityChanged = !!last && hash(last.security?.findings) !== hash(security.findings);
        if (last &&
            now - last.at < this.settings.observationIntervalMs &&
            !securityChanged)
            return;
        const fills = this.rows("trade_execution_evidence", sample.id), buy = fills.find((f) => f.side === "BUY");
        if (!buy)
            return;
        const cost = -BigInt(buy.solDelta);
        if (cost <= 0n)
            return;
        const realizedProceeds = fills
            .filter((f) => f.side === "SELL")
            .reduce((sum, f) => sum + BigInt(f.solDelta), 0n);
        const percent = Number(((realizedProceeds + value - cost) * 1000000n) / cost) / 10000;
        const maximum = Math.max(0, ...prior.map((o) => o.pnlPercent ?? 0));
        const age = (now - position.entryAt) / 1000;
        const checkpoint = this.settings.checkpointSeconds
            .filter((t) => age >= t && !prior.some((o) => o.checkpointSeconds === t))
            .at(-1);
        const observation = {
            at: now,
            phase: "OPEN",
            market,
            security,
            valueLamports: value.toString(),
            pnlPercent: percent,
            drawdownPercent: Math.max(0, maximum - percent),
            ...extras,
            checkpointSeconds: checkpoint,
        };
        this.store.db
            .prepare("INSERT OR IGNORE INTO trade_observations VALUES(?,?,?,?,?)")
            .run(sample.id + ":OPEN:" + now, sample.id, now, "OPEN", json(observation));
    }
    outcome(id) {
        const row = this.store.db
            .prepare("SELECT payload FROM trade_outcomes WHERE sample_id=?")
            .get(id);
        return row ? JSON.parse(String(row.payload)) : undefined;
    }
    rebuilding = false;
    refresh(id) {
        const sample = this.sample(id);
        if (!sample)
            return;
        const fills = this.rows("trade_execution_evidence", id), buy = fills.find((f) => f.side === "BUY"), sells = fills.filter((f) => f.side === "SELL");
        if (!buy ||
            !sells.length ||
            BigInt(buy.tokenDelta) <= 0n ||
            sells.reduce((n, f) => n + BigInt(f.tokenDelta), 0n) +
                BigInt(buy.tokenDelta) !==
                0n)
            return;
        const failures = this.rows("trade_execution_failures", id).filter((f) => !fills.some((fill) => fill.executionId === f.executionId));
        const unknownFees = failures.some((f) => f.feeLamports === null);
        const result = pnl(BigInt(buy.solDelta), sells.map((f) => BigInt(f.solDelta)), failures.reduce((n, f) => n + BigInt(f.feeLamports ?? "0"), 0n), BigInt(this.settings.breakevenLamports));
        const observations = this.rows("trade_observations", id), open = observations.filter((o) => o.phase === "OPEN"), post = observations.filter((o) => o.phase === "POST_EXIT");
        const exit = this.rows("trade_exit_snapshots", id), closedAt = Math.max(...sells.map((f) => f.at));
        const coverage = open.length >= 2 && open.at(-1).at - open[0].at >= 30000
            ? "SAMPLED"
            : "EXIT_ONLY";
        const range = excursions([
            ...open.flatMap((o) => o.pnlPercent === undefined ? [] : [o.pnlPercent]),
            result.netPnlPercent,
        ]);
        const analysis = new OutcomeAnalyzer(this.settings).classify({
            ...result,
            ...range,
            coverage,
            exitReasons: exit.map((x) => x.reasonCode),
        }, post);
        if (!sample.snapshot.security.findings.some((f) => f.level === "CRITICAL") &&
            exit.some((x) => x.security?.findings.some((f) => f.level === "CRITICAL" &&
                /RUG|HONEYPOT|LIQUIDITY_REMOVED/.test(f.code)))) {
            analysis.classifications = [
                ...new Set([
                    ...analysis.classifications.filter((c) => c !== "UNKNOWN"),
                    "RUG_AFTER_ENTRY",
                ]),
            ];
            analysis.lessons.push("GMGN_REPORTED_CRITICAL_RUG_OR_SELLABILITY_CHANGE_AFTER_ENTRY");
        }
        const outcome = {
            runner: this.runner.state(id)
                ? this.runner.summary(this.runner.state(id))
                : undefined,
            sampleId: id,
            positionId: sample.positionId,
            tradeId: sample.tradeId,
            mint: sample.mint,
            mode: sample.mode,
            version: LEARNING_VERSION,
            buySignature: buy.signature,
            sellSignatures: sells.flatMap((f) => (f.signature ? [f.signature] : [])),
            closedAt,
            availableAt: Math.max(closedAt, ...post.map((o) => o.at)),
            ...result,
            ...range,
            ...analysis,
            observationCount: open.length,
            coverage,
            exitReasons: exit.map((x) => x.reasonCode),
            holdingDurationMs: Math.max(0, closedAt - buy.at),
            eligibleForStrategy: failures.length === 0 && sample.origin === "STRATEGY",
            accountingComplete: !unknownFees,
            features: featureVector(sample.snapshot),
            counterfactualCount: post.length,
        };
        if (failures.length) {
            outcome.classifications = [
                ...outcome.classifications,
                "EXECUTION_FAILURE",
            ];
            outcome.lessons.push("EXECUTION_FAILURE_EXCLUDED_FROM_STRATEGY_STATISTICS");
        }
        this.store.db
            .prepare("INSERT INTO trade_outcomes VALUES(?,?,?,?,?) ON CONFLICT(sample_id) DO UPDATE SET available_at=excluded.available_at,version=excluded.version,payload=excluded.payload")
            .run(id, sample.mode, outcome.availableAt, LEARNING_VERSION, json(outcome));
        if (!this.rebuilding)
            this.persistPatterns(sample.mode, outcome.availableAt);
    }
    retrieve(current, mode, asOf = Date.now()) {
        const vector = featureVector(current);
        const candidates = this.store.db
            .prepare("SELECT o.payload FROM trade_outcomes o JOIN trade_learning_samples s ON s.id=o.sample_id WHERE o.mode=? AND o.available_at<=? AND s.entry_at<? AND s.mint<>? ORDER BY o.available_at DESC LIMIT 5000")
            .all(mode, asOf, asOf, current.candidate.mint)
            .map((r) => JSON.parse(String(r.payload)));
        const rows = candidates
            .filter((o) => o.eligibleForStrategy && o.accountingComplete && o.closedAt < asOf)
            .map((outcome) => ({
            outcome,
            similarity: similarity(vector, outcome.features, this.settings.minimumSharedFeatures),
        }))
            .filter((r) => r.similarity >= this.settings.minimumSimilarity)
            .map((r) => ({
            ...r,
            weight: r.similarity *
                recencyWeight(r.outcome.closedAt, asOf, this.settings.recencyHalfLifeDays),
        }))
            .sort((a, b) => b.weight - a.weight)
            .slice(0, this.settings.maxSimilarTrades);
        const comparisons = this.patterns(mode, rows.map((r) => r.outcome), asOf);
        const compact = (p) => ({
            profile: p.profile,
            samples: p.similarTrades,
            wins: p.wins,
            losses: p.losses,
            winRate: p.winRate,
            comparisonSamples: p.comparisonSamples,
            comparisonWinRate: p.comparisonWinRate,
        });
        return {
            ...aggregate(rows, this.settings),
            positiveEntryPatterns: comparisons
                .filter((p) => p.comparativeEvidence && p.winRate > p.comparisonWinRate)
                .slice(0, 3)
                .map(compact),
            negativeEntryPatterns: comparisons
                .filter((p) => p.comparativeEvidence && p.winRate < p.comparisonWinRate)
                .slice(0, 3)
                .map(compact),
            learningVersion: LEARNING_VERSION,
            asOf,
            source: "COMPLETED_RECONCILED_TRADES",
            excludesCurrentMint: current.candidate.mint,
        };
    }
    jevContext(currentToken, history) {
        // Whitelist the statistical summary: no raw trades, future observations or model-generated counts.
        const pick = (value, keys) => Object.fromEntries(keys
            .filter((k) => record(value)[k] !== undefined)
            .map((k) => [k, record(value)[k]]));
        const facts = pick(currentToken, [
            "tokenAgeSeconds",
            "bundlePercent",
            "sniperPercent",
            "smartMoney",
            "kol",
        ]);
        const token = record(currentToken);
        facts.entryDiscoverySource = token.entryDiscoverySource;
        facts.discovery = pick(token.discovery, [
            "sources",
            "activePath",
            "trending",
            "sniper",
            "source",
            "fresh",
            "rank",
            "movement",
            "basis",
        ]);
        // Explicit compact contracts: no raw provider responses or observation histories.
        facts.sniperStructureAtEntry = pick(token.sniperStructureAtEntry, [
            "phase",
            "status",
            "reason",
            "quality",
            "confirmedAt",
            "lastObservedAt",
            "structureWatchStartedAt",
            "structureWatchExpiresAt",
            "sellingCount",
            "supportCount",
            "absorptionCount",
            "absorptionDetected",
            "supportConfirmed",
            "evidenceVersion",
            "evidence",
            "context",
            "liveObservationsAccepted",
            "recoveryCount",
            "observationsAccepted",
        ]);
        const flow = record(token.capitalFlow);
        facts.capitalFlow = pick(flow, [
            "regime",
            "confidence",
            "window",
            "quality",
            "features",
            "lookbacks",
        ]);
        facts.gmgnQuality = pick(token.gmgnQuality, [
            "provider",
            "fetchedAt",
            "ageMs",
            "freshness",
        ]);
        facts.marketObservedAt = record(token.market).at;
        facts.securityObservedAt = record(token.security).at;
        facts.flowObservedAt = flow.at;
        facts.structureUpdatedAt = record(token.sniperStructureAtEntry).lastObservedAt;
        facts.tokenExecution = pick(record(currentToken).tokenExecution, [
            "tokenProgram",
            "programId",
            "decimals",
            "extensions",
            "unsupportedExtensions",
            "criticalExtensions",
            "extensionRisk",
            "decision",
        ]);
        facts.market = pick(record(currentToken).market, [
            "at",
            "price",
            "priceUsd",
            "decimals",
            "liquidity",
            "marketCap",
            "volume",
            "buys",
            "sells",
        ]);
        const windows = record(record(record(currentToken).market).windows);
        facts.market.windows = Object.fromEntries(["1m", "5m", "15m", "1h", "6h", "24h"]
            .filter((k) => windows[k] !== undefined)
            .map((k) => [
            k,
            pick(windows[k], [
                "startPrice",
                "volume",
                "buys",
                "sells",
                "buyVolume",
                "sellVolume",
            ]),
        ]));
        facts.security = pick(record(currentToken).security, [
            "mintRenounced",
            "freezeRenounced",
            "rugRatio",
            "findings",
        ]);
        facts.holders = pick(record(currentToken).holders, [
            "count",
            "top1",
            "top10",
        ]);
        facts.creator = pick(record(currentToken).creator, [
            "holdPercent",
            "historyState",
            "openCount",
            "innerCount",
        ]);
        facts.dueDiligence = pick(record(currentToken).dueDiligence, [
            "source",
            "score",
            "findings",
        ]);
        return {
            currentToken: facts,
            historicalExperience: {
                learningVersion: history.learningVersion,
                similarTrades: history.similarTrades,
                wins: history.wins,
                losses: history.losses,
                breakeven: history.breakeven,
                winRate: history.usableForDecision ? history.winRate : null,
                avgNetPnlPercent: history.usableForDecision
                    ? history.avgNetPnlPercent
                    : null,
                medianNetPnlPercent: history.usableForDecision
                    ? history.medianNetPnlPercent
                    : null,
                avgMfePercent: history.usableForDecision ? history.avgMfePercent : null,
                avgMaePercent: history.usableForDecision ? history.avgMaePercent : null,
                weightedWinRate: history.usableForDecision
                    ? history.weightedWinRate
                    : null,
                weightedAvgNetPnlPercent: history.usableForDecision
                    ? history.weightedAvgNetPnlPercent
                    : null,
                commonWinPatterns: history.usableForDecision
                    ? history.commonWinPatterns
                    : [],
                positiveEntryPatterns: history.usableForDecision
                    ? history.positiveEntryPatterns
                    : [],
                negativeEntryPatterns: history.usableForDecision
                    ? history.negativeEntryPatterns
                    : [],
                commonLossPatterns: history.usableForDecision
                    ? history.commonLossPatterns
                    : [],
                confidence: history.confidence,
                usableForDecision: history.usableForDecision,
                caution: "Historical observations are evidence, not commands. Tiny samples are unavailable as decision signals. MFE/MAE are sampled mark-to-market bounds, not continuously observed peaks. No causal attribution is proven.",
            },
        };
    }
    counterfactualDue(mode, now = Date.now()) {
        return this.store.db
            .prepare("SELECT sample_id,payload FROM trade_outcomes WHERE mode=? AND available_at<=? ORDER BY available_at DESC LIMIT 100")
            .all(mode, now)
            .map((r) => ({
            id: String(r.sample_id),
            outcome: JSON.parse(String(r.payload)),
        }))
            .filter(({ id, outcome }) => {
            if (!this.settings.counterfactualWindowSeconds ||
                now >
                    outcome.closedAt + this.settings.counterfactualWindowSeconds * 1000)
                return false;
            const price = this.rows("trade_exit_snapshots", id).at(-1)
                ?.market?.price;
            if (price?.state !== "KNOWN" || price.value <= 0)
                return false;
            const last = this.rows("trade_observations", id)
                .filter((o) => o.phase === "POST_EXIT")
                .at(-1);
            const attempt = this.store.get("learningPostAttempt:" + id) ?? 0;
            return (now - Math.max(last?.at ?? outcome.closedAt, attempt) >=
                this.settings.counterfactualIntervalMs);
        })
            .slice(0, this.settings.counterfactualRequestsPerCycle);
    }
    observeAfterExit(id, market, now = Date.now()) {
        const outcome = this.outcome(id);
        if (!outcome ||
            now <= outcome.closedAt ||
            now > outcome.closedAt + this.settings.counterfactualWindowSeconds * 1000)
            return;
        const exit = this.rows("trade_exit_snapshots", id).at(-1), price = exit?.market?.price;
        if (price?.state !== "KNOWN" ||
            price.value <= 0 ||
            market.price.state !== "KNOWN")
            return;
        const observation = {
            phase: "POST_EXIT",
            at: now,
            market,
            tokenPriceChangeSinceExitPercent: (market.price.value / price.value - 1) * 100,
        };
        this.store.db
            .prepare("INSERT OR IGNORE INTO trade_observations VALUES(?,?,?,?,?)")
            .run(id +
            ":POST_EXIT:" +
            Math.floor(now / this.settings.counterfactualIntervalMs), id, now, "POST_EXIT", json(observation));
        const owned = this.store.positions(outcome.mode).find((p) => p.id === id);
        if (owned)
            this.runner.observe(owned, market, undefined, now, "POST_EXIT");
        this.refresh(id);
    }
    report(mode, now = Date.now()) {
        const outcomes = this.store.db
            .prepare("SELECT payload FROM trade_outcomes WHERE mode=? ORDER BY available_at DESC")
            .all(mode)
            .map((r) => JSON.parse(String(r.payload)));
        const eligible = outcomes.filter((o) => o.eligibleForStrategy && o.accountingComplete);
        const stats = aggregate(eligible.map((outcome) => ({
            outcome,
            weight: recencyWeight(outcome.closedAt, now, this.settings.recencyHalfLifeDays),
        })), this.settings);
        const patterns = this.patterns(mode, eligible, now);
        const failureRows = this.store.db
            .prepare("SELECT payload FROM trade_execution_failures")
            .all()
            .map((r) => JSON.parse(String(r.payload)));
        const executionIds = new Set(this.store
            .executions()
            .filter((e) => e.intent.mode === mode)
            .map((e) => e.id));
        const executionFailures = new Set(failureRows
            .filter((f) => executionIds.has(f.executionId) && f.state === "FAILED")
            .map((f) => f.executionId)).size;
        return {
            title: "BOT B LEARNING REPORT",
            discoveryOutcomes: this.discoveryOutcomes(mode),
            mode,
            learningVersion: LEARNING_VERSION,
            completedTrades: outcomes.length,
            eligibleStrategyTrades: eligible.length,
            executionFailures,
            ...stats,
            patterns,
            suggestions: this.suggestions(stats, patterns),
            classifications: Object.fromEntries([...new Set(outcomes.flatMap((o) => o.classifications))].map((code) => [
                code,
                outcomes.filter((o) => o.classifications.includes(code)).length,
            ])),
            trades: outcomes.slice(0, 50).map((o) => ({
                sampleId: o.sampleId,
                mint: o.mint,
                result: o.result,
                netPnlPercent: o.netPnlPercent,
                coverage: o.coverage,
                accountingComplete: o.accountingComplete,
            })),
        };
    }
    discoveryOutcomes(mode) {
        const rows = this.store.db
            .prepare("SELECT json_object('snapshot',json_object('candidate',json_object('discovery',json_extract(s.payload,'$.snapshot.candidate.discovery'))),'exitFeasibility',json_extract(s.payload,'$.exitFeasibility')) sample,o.payload outcome,json_extract(p.payload,'$.exitLiquidity.status') exitStatus,EXISTS(SELECT 1 FROM trade_execution_evidence e WHERE e.sample_id=s.id AND json_extract(e.payload,'$.side')='BUY') confirmedBuy,(SELECT count(DISTINCT json_extract(f.payload,'$.executionId')) FROM trade_execution_failures f WHERE f.sample_id=s.id AND json_extract(f.payload,'$.state')='FAILED') failures FROM trade_learning_samples s LEFT JOIN trade_outcomes o ON o.sample_id=s.id LEFT JOIN positions p ON p.id=s.id WHERE s.mode=? ORDER BY s.entry_at DESC LIMIT 2000")
            .all(mode);
        const groups = new Map();
        for (const row of rows) {
            const sample = JSON.parse(String(row.sample)), d = sample.snapshot.candidate.discovery;
            const source = d?.sources.slice().sort().join("+") ?? "LEGACY_UNKNOWN";
            const g = groups.get(source) ?? {
                trades: 0,
                entryAttempts: 0,
                deteriorated: 0,
                closed: 0,
                realizedLamports: 0n,
                mfe: [],
                mae: [],
                runner: 0,
                executionFailures: 0,
            };
            g.entryAttempts++;
            g.trades += Number(row.confirmedBuy);
            g.executionFailures += Number(row.failures);
            if (sample.exitFeasibility &&
                ["HEALTHY", "LIMITED"].includes(sample.exitFeasibility.status) &&
                ["POOR", "NO_EXIT"].includes(String(row.exitStatus)))
                g.deteriorated++;
            const o = row.outcome
                ? JSON.parse(String(row.outcome))
                : undefined;
            if (o) {
                g.closed++;
                g.realizedLamports += BigInt(o.netLamports);
                if (o.mfePercent !== undefined)
                    g.mfe.push(o.mfePercent);
                if (o.maePercent !== undefined)
                    g.mae.push(o.maePercent);
                if ((o.runner?.heldPriceMfePercent ?? -1) >= 900)
                    g.runner++;
            }
            groups.set(source, g);
        }
        return {
            basis: "At most 2000 most recent actual learning samples, grouped by immutable entry source; descriptive only, no automatic parameter changes",
            groups: [...groups].map(([source, g]) => ({
                source,
                trades: g.trades,
                entryAttempts: g.entryAttempts,
                exitLiquidityDeteriorated: g.deteriorated,
                closed: g.closed,
                realizedLamports: String(g.realizedLamports),
                averageMfe: g.mfe.length
                    ? g.mfe.reduce((a, b) => a + b, 0) / g.mfe.length
                    : null,
                averageMae: g.mae.length
                    ? g.mae.reduce((a, b) => a + b, 0) / g.mae.length
                    : null,
                observedX10Runners: g.runner,
                failedExecutions: g.executionFailures,
                insufficientSample: g.closed < 10,
            })),
        };
    }
    patterns(mode, outcomes, now) {
        const buckets = new Map();
        for (const o of outcomes)
            for (const key of [
                "age",
                "liquidity",
                "top10",
                "developerHolding",
                "buyRatio",
                "momentum5m",
            ]) {
                const value = o.features[key];
                if (value === null || value === undefined)
                    continue;
                const bucket = key + ":" + (value < 1 / 3 ? "LOW" : value < 2 / 3 ? "MID" : "HIGH");
                buckets.set(bucket, [...(buckets.get(bucket) ?? []), o]);
            }
        return [...buckets]
            .map(([profile, rows]) => {
            const included = new Set(rows.map((o) => o.sampleId));
            const summarize = (items) => aggregate(items.map((outcome) => ({
                outcome,
                weight: recencyWeight(outcome.closedAt, now, this.settings.recencyHalfLifeDays),
            })), this.settings);
            const inside = summarize(rows), outside = summarize(outcomes.filter((o) => !included.has(o.sampleId)));
            return {
                profile,
                mode,
                version: LEARNING_VERSION,
                ...inside,
                comparisonSamples: outside.similarTrades,
                comparisonWinRate: outside.winRate,
                comparativeEvidence: inside.usableForDecision && outside.usableForDecision,
            };
        })
            .sort((a, b) => b.similarTrades - a.similarTrades);
    }
    suggestions(stats, patterns) {
        const suggestions = [];
        if (stats.usableForDecision &&
            stats.avgMfePercent !== null &&
            stats.avgNetPnlPercent !== null &&
            stats.avgMfePercent - stats.avgNetPnlPercent >=
                this.settings.poorCaptureGapPercent)
            suggestions.push({
                code: "REVIEW_PROFIT_CAPTURE",
                reason: "Observed favorable excursions exceed captured net returns; review take-profit/trailing parameters",
                sampleCount: stats.similarTrades,
                confidence: stats.confidence,
                applied: false,
            });
        for (const p of patterns
            .filter((p) => p.comparativeEvidence &&
            p.avgNetPnlPercent !== null &&
            p.avgNetPnlPercent < 0)
            .slice(0, 3))
            suggestions.push({
                code: "REVIEW_PROFILE",
                reason: `${p.profile}: ${p.wins} wins, ${p.losses} losses; compare profile to the full sample before changing strategy`,
                sampleCount: p.similarTrades,
                confidence: p.confidence,
                applied: false,
            });
        return suggestions;
    }
    persistPatterns(mode, now) {
        const report = this.report(mode, now);
        this.store.db
            .prepare("DELETE FROM learning_patterns WHERE mode=?")
            .run(mode);
        for (const pattern of report.patterns)
            this.store.db
                .prepare("INSERT INTO learning_patterns VALUES(?,?,?,?)")
                .run(mode + ":" + pattern.profile, mode, LEARNING_VERSION, json(pattern));
        this.store.db
            .prepare("INSERT INTO learning_patterns VALUES(?,?,?,?)")
            .run(mode + ":suggestions", mode, LEARNING_VERSION, json(report.suggestions));
    }
    rebuild(now = Date.now()) {
        this.rebuilding = true;
        try {
            return this.store.atomic(() => {
                this.store.db.exec("DELETE FROM trade_outcomes; DELETE FROM learning_patterns;");
                for (const row of this.store.db
                    .prepare("SELECT id FROM trade_learning_samples")
                    .all())
                    this.refresh(String(row.id));
                for (const mode of ["paper", "live"]) {
                    const report = this.report(mode, now);
                    for (const pattern of report.patterns)
                        this.store.db
                            .prepare("INSERT INTO learning_patterns VALUES(?,?,?,?)")
                            .run(mode + ":" + pattern.profile, mode, LEARNING_VERSION, json(pattern));
                    this.store.db
                        .prepare("INSERT INTO learning_patterns VALUES(?,?,?,?)")
                        .run(mode + ":suggestions", mode, LEARNING_VERSION, json(report.suggestions));
                }
                const counts = {
                    samples: Number(this.store.db
                        .prepare("SELECT count(*) n FROM trade_learning_samples")
                        .get().n),
                    outcomes: Number(this.store.db
                        .prepare("SELECT count(*) n FROM trade_outcomes")
                        .get().n),
                };
                this.store.db
                    .prepare("INSERT INTO learning_versions(version,at,payload) VALUES(?,?,?)")
                    .run(LEARNING_VERSION, now, json({ settings: this.settings, ...counts }));
                return {
                    learningVersion: LEARNING_VERSION,
                    ...counts,
                    immutableEvidencePreserved: true,
                };
            });
        }
        finally {
            this.rebuilding = false;
        }
    }
    detail(id) {
        const sample = this.sample(id);
        if (!sample)
            return null;
        const outcome = this.outcome(id);
        return {
            entrySnapshot: sample,
            preflights: this.rows("trade_execution_preflights", id),
            executions: this.rows("trade_execution_evidence", id),
            observations: this.rows("trade_observations", id),
            exits: this.rows("trade_exit_snapshots", id),
            executionFailures: this.rows("trade_execution_failures", id),
            outcome: outcome ?? null,
            similarHistoricalGroupAtEntry: sample.jevInput,
            lessons: outcome?.lessons ?? [],
        };
    }
}
