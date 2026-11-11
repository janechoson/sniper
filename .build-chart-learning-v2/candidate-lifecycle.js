/** Only unconsumed Trending appearances enter. No deferred timers or judgments. */
export class CandidateLifecycle {
    store;
    settings;
    constructor(store, settings) {
        this.store = store;
        this.settings = settings;
        store.db
            .prepare(`DELETE FROM candidate_lifecycle WHERE mode=? AND (
        COALESCE(json_extract(payload,'$.state'),'')!='QUEUED'
        OR COALESCE(json_extract(payload,'$.batchId'),'')!=?
        OR NOT EXISTS (SELECT 1 FROM trending_appearances a
          WHERE a.mode=candidate_lifecycle.mode AND a.consumed=0
            AND a.id=CAST(json_extract(candidate_lifecycle.payload,'$.appearanceId') AS INTEGER))
      )`)
            .run(this.store.mode, store.trendingBatch()?.id ?? "__NO_BATCH__");
    }
    list() {
        return this.store.db
            .prepare("SELECT payload FROM candidate_lifecycle WHERE mode=? ORDER BY CAST(json_extract(payload,'$.appearanceId') AS INTEGER) ASC,mint ASC")
            .all(this.store.mode)
            .map((r) => JSON.parse(String(r.payload)));
    }
    get(mint) {
        return this.list().find((r) => r.mint === mint);
    }
    save(row) {
        const previous = this.get(row.mint);
        this.store.db
            .prepare("INSERT INTO candidate_lifecycle VALUES(?,?,?) ON CONFLICT(mode,mint) DO UPDATE SET payload=excluded.payload")
            .run(this.store.mode, row.mint, JSON.stringify(row));
        if (previous?.state !== row.state) {
            const names = {
                QUEUED: "CANDIDATE_QUEUED",
                ANALYZING: "CANDIDATE_CHECKING",
                QUALIFIED: "CANDIDATE_QUALIFIED",
                APPROVED: "RISK_APPROVED",
                REJECTED: "CANDIDATE_REJECTED",
                BOUGHT: "CANDIDATE_TRADED",
            };
            this.store.pipelineEvent(names[row.state] ?? row.state, row.mint, {
                from: previous?.state ?? "DISCOVERY",
                to: row.state,
                reason: row.issue?.reasonCode,
            });
        }
    }
    setState(mint, state, now = Date.now()) {
        const row = this.get(mint);
        if (!row)
            return;
        row.state = ["WATCH", "STRUCTURE_WATCH", "DEFERRED"].includes(state)
            ? "REJECTED"
            : state;
        row.lastChecked = now;
        this.save(row);
        if (state === "ANALYZING" && row.appearanceId)
            this.store.db
                .prepare("UPDATE trending_appearances SET consumed=1 WHERE id=?")
                .run(row.appearanceId);
    }
    dismiss(mint) {
        this.setState(mint, "USER_REMOVED");
    }
    promoteStructure(mint, _now, _reason) {
        this.setState(mint, "REJECTED");
    }
    structureWait(mint, _expiresAt, _now) {
        this.setState(mint, "REJECTED");
    }
    providerWait(mint, _now) {
        this.setState(mint, "REJECTED");
    }
    recovered(_mint) { }
    fail(issue, _now) {
        const row = this.get(issue.mint ?? "");
        if (!row)
            return;
        row.issue = issue;
        row.state = "REJECTED";
        this.save(row);
        this.store.record("token_failures", row.mint, {
            ...issue,
            disposition: "REJECTED",
        });
    }
    decision(mint, r, _now) {
        this.setState(mint, r.allowed ? "APPROVED" : "REJECTED");
    }
    finish(mint) {
        const row = this.get(mint);
        if (row?.appearanceId)
            this.store.finishUnboundTrendingAppearance(row.appearanceId);
        this.store.db
            .prepare("DELETE FROM candidate_lifecycle WHERE mode=? AND mint=?")
            .run(this.store.mode, mint);
        this.store.db
            .prepare("DELETE FROM candidate_flow_states WHERE mint=?")
            .run(this.store.candidateFlowKey(mint));
    }
    refill(candidates, now = Date.now()) {
        this.store.enqueueTrending(candidates);
        const blacklist = new Set(this.settings().tokenBlacklist);
        const priorBatch = this.store.trendingBatch();
        for (const mint of blacklist) {
            this.store.db
                .prepare("UPDATE trending_appearances SET consumed=1 WHERE mode=? AND mint=? AND consumed=0")
                .run(this.store.mode, mint);
            const row = this.get(mint);
            if (row?.state === "QUEUED")
                this.finish(mint);
            for (const entry of priorBatch?.entries ?? [])
                if (entry.mint === mint && entry.status === "WAITING") {
                    entry.status = "COMPLETE";
                    entry.result = "TOKEN_BLACKLISTED";
                    entry.endedAt = now;
                }
        }
        if (priorBatch && blacklist.size)
            this.store.set("trendingBatchV1:" + this.store.mode, priorBatch);
        const batch = this.store.prepareTrendingBatch();
        if (!batch)
            return [];
        const rows = this.store.db
            .prepare("SELECT * FROM trending_appearances WHERE mode=? AND consumed=0 AND seen_at=? ORDER BY id")
            .all(this.store.mode, batch.fetchedAt);
        for (const r of rows) {
            const c = JSON.parse(String(r.payload));
            if (this.get(c.mint))
                continue;
            if (this.list().length >= this.settings().candidateQueueSize)
                break;
            this.save({
                appearanceId: Number(r.id),
                batchId: batch.id,
                mint: c.mint,
                symbol: c.symbol,
                state: "QUEUED",
                score: 0,
                failureCount: 0,
                rechecks: 0,
                lastChecked: now,
                nextCheckAt: now,
                expiresAt: 0,
            });
        }
        this.store.db
            .prepare("DELETE FROM trending_appearances WHERE mode=? AND consumed=1 AND id IN (SELECT id FROM trending_appearances WHERE mode=? AND consumed=1 ORDER BY id DESC LIMIT -1 OFFSET 2000)")
            .run(this.store.mode, this.store.mode);
        return this.list()
            .filter((r) => r.state === "QUEUED" && r.batchId === batch.id)
            .map((r) => r.mint);
    }
}
