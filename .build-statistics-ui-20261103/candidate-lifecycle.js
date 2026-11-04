import { env } from "./config.js";
/** Only unconsumed Trending appearances enter. No deferred timers or judgments. */
export class CandidateLifecycle {
    store;
    settings;
    constructor(store, settings) {
        this.store = store;
        this.settings = settings;
        store.db
            .prepare("DELETE FROM candidate_lifecycle WHERE mode=?")
            .run(env.TRADING_MODE);
    }
    list() {
        return this.store.db
            .prepare("SELECT payload FROM candidate_lifecycle WHERE mode=?")
            .all(env.TRADING_MODE)
            .map((r) => JSON.parse(String(r.payload)));
    }
    get(mint) {
        return this.list().find((r) => r.mint === mint);
    }
    save(row) {
        const previous = this.get(row.mint);
        this.store.db
            .prepare("INSERT INTO candidate_lifecycle VALUES(?,?,?) ON CONFLICT(mode,mint) DO UPDATE SET payload=excluded.payload")
            .run(env.TRADING_MODE, row.mint, JSON.stringify(row));
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
        this.store.db
            .prepare("DELETE FROM candidate_lifecycle WHERE mode=? AND mint=?")
            .run(env.TRADING_MODE, mint);
        this.store.db
            .prepare("DELETE FROM candidate_flow_states WHERE mint=?")
            .run(mint);
    }
    refill(candidates, now = Date.now()) {
        this.store.enqueueTrending(candidates);
        const rows = this.store.db
            .prepare("SELECT * FROM trending_appearances WHERE mode=? AND consumed=0 ORDER BY id")
            .all(env.TRADING_MODE);
        for (const r of rows) {
            const c = JSON.parse(String(r.payload));
            if (this.get(c.mint))
                continue;
            if (this.list().length >= this.settings().candidateQueueSize)
                break;
            this.save({
                appearanceId: Number(r.id),
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
            .prepare("DELETE FROM trending_appearances WHERE consumed=1 AND id IN (SELECT id FROM trending_appearances WHERE consumed=1 ORDER BY id DESC LIMIT -1 OFFSET 2000)")
            .run();
        return this.list()
            .filter((r) => r.state === "QUEUED")
            .map((r) => r.mint);
    }
}
