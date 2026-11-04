import { env } from "./config.js";
import { discoveryBoost } from "./discovery.js";
import { currentStructureEvidence, evolveLocalStructure, recentStructureContext, revalidateLegacyStructure, seedStructureContext, } from "./structure-evidence.js";
export const ENTRY_WATCH_POLICY = "TRENDING_FINAL_STRUCTURE_V1";
export function hasEntryWatchEligibility(r) {
    return r?.eligibility?.policy === ENTRY_WATCH_POLICY;
}
export function hasEligibleStructurePass(r, now = Date.now()) {
    return hasEntryWatchEligibility(r) && hasTimelyStructurePass(r, now);
}
export function entrySource(c, s, now = Date.now()) {
    return discoveryBoost(c, s, now) > 0 ? "TRENDING" : "SNIPER";
}
/** The deadline bounds confirmation, not a mandatory wait or a renewed entry approval. */
export function hasTimelyStructurePass(r, now = Date.now()) {
    return (!!r &&
        currentStructureEvidence(r) &&
        r.status === "PASSED" &&
        r.confirmedAt !== undefined &&
        r.confirmedAt >= r.structureWatchStartedAt &&
        r.confirmedAt < r.structureWatchExpiresAt &&
        r.confirmedAt <= now);
}
/** Local buyer-defense evidence; no token-age or universal recovery-% rule. */
export function evolveStructure(old, mint, o, s, now = Date.now()) {
    return evolveLocalStructure(old, mint, o, s, now);
}
export class SniperStructure {
    store;
    settings;
    constructor(store, settings) {
        this.store = store;
        this.settings = settings;
        this.reconcileTtl();
    }
    table(row) {
        return hasEntryWatchEligibility(row)
            ? "entry_structure_watch"
            : "sniper_structure_watch";
    }
    // Admission records eligibility, never an executable intent or capital reservation.
    admit(c, approval, now = Date.now()) {
        const old = this.get(c.mint);
        if (hasEntryWatchEligibility(old))
            return old;
        if (this.store.candidateAuthority(c.mint, env.TRADING_MODE)
            .entryWatchDismissedAt)
            return undefined;
        if (this.list().filter((r) => hasEntryWatchEligibility(r) && r.status === "ACTIVE").length >= this.settings().structureWatchMaxSize)
            return undefined;
        let row = evolveStructure(undefined, c.mint, undefined, this.settings(), now);
        const flowRow = this.store.db
            .prepare("SELECT payload FROM candidate_flow_states WHERE mint=?")
            .get(c.mint);
        let context = [];
        if (flowRow) {
            try {
                const flow = JSON.parse(String(flowRow.payload));
                if (flow.mint === c.mint && Array.isArray(flow.observations))
                    context = recentStructureContext(flow.observations, c.mint, now, this.settings());
            }
            catch {
                /* Untrusted historical context does not grant authority. */
            }
        }
        row = seedStructureContext(row, context, this.settings());
        row.eligibility = {
            policy: ENTRY_WATCH_POLICY,
            approvedAt: now,
            ...approval,
        };
        this.store.db
            .prepare("INSERT INTO entry_structure_watch VALUES(?,?,?,?)")
            .run(env.TRADING_MODE, c.mint, now, JSON.stringify(row));
        this.store.record("pre_watch_approvals", c.mint, row.eligibility);
        return row;
    }
    reconcileTtl(now = Date.now()) {
        for (let row of this.list()) {
            if (!hasEntryWatchEligibility(row))
                continue;
            if (["ACTIVE", "PASSED"].includes(row.status) &&
                !currentStructureEvidence(row))
                row = revalidateLegacyStructure(row);
            row.structureWatchExpiresAt = Math.min(row.structureWatchExpiresAt, row.structureWatchStartedAt + this.settings().structureWatchTtlMs);
            if (["ACTIVE", "PASSED"].includes(row.status) &&
                now >= row.structureWatchExpiresAt &&
                !hasTimelyStructurePass(row, now)) {
                row.status = "EXPIRED";
                row.reason = "NO_CONFIRMED_BUYER_DEFENSE_WITHIN_10M";
            }
            this.store.db
                .prepare("UPDATE entry_structure_watch SET payload=? WHERE mode=? AND mint=?")
                .run(JSON.stringify(row), env.TRADING_MODE, row.mint);
            this.store.db
                .prepare("UPDATE candidate_lifecycle SET payload=json_set(payload,'$.structureWatchExpiresAt',?,'$.expiresAt',?) WHERE mode=? AND mint=? AND json_extract(payload,'$.structureWatchExpiresAt') IS NOT NULL AND json_extract(payload,'$.state')!='BOUGHT'")
                .run(row.structureWatchExpiresAt, row.structureWatchExpiresAt, env.TRADING_MODE, row.mint);
        }
    }
    dismiss(mint) {
        return this.store.atomic(() => {
            const row = this.get(mint);
            const persisted = this.store.candidateAuthority(mint, env.TRADING_MODE);
            // A pruned new-policy row may reveal a legacy row for the same mint.
            // The tombstone must win without modifying that historical record.
            if (persisted.entryWatchDismissedAt && !hasEntryWatchEligibility(row))
                return {
                    mint,
                    status: "USER_REMOVED",
                    dismissedAt: persisted.entryWatchDismissedAt,
                    dismissedBy: "USER",
                    dismissalReason: "USER_MANUAL",
                };
            if (!row) {
                const prior = this.store.candidateAuthority(mint, env.TRADING_MODE);
                if (prior.entryWatchDismissedAt || prior.sniperDismissedAt)
                    return {
                        mint,
                        status: "USER_REMOVED",
                        dismissedAt: prior.entryWatchDismissedAt ?? prior.sniperDismissedAt,
                        dismissedBy: "USER",
                        dismissalReason: "USER_MANUAL",
                    };
                throw new Error("STRUCTURE_WATCH_NOT_FOUND");
            }
            if (row.status === "USER_REMOVED")
                return row;
            this.store.record("structure_dismissals", mint, {
                previousStatus: row.status,
                previousReason: row.reason,
                dismissedBy: "USER",
                reason: "USER_MANUAL",
                mode: env.TRADING_MODE,
            });
            const authority = this.store.dismissCandidate(mint, env.TRADING_MODE, hasEntryWatchEligibility(row));
            row.status = "USER_REMOVED";
            row.reason = "USER_MANUAL";
            row.dismissedAt =
                authority.entryWatchDismissedAt ?? authority.sniperDismissedAt;
            row.dismissedBy = "USER";
            row.dismissalReason = "USER_MANUAL";
            this.store.db
                .prepare(`UPDATE ${this.table(row)} SET payload=? WHERE mode=? AND mint=?`)
                .run(JSON.stringify(row), env.TRADING_MODE, mint);
            return row;
        });
    }
    get(mint) {
        const current = this.store.db
            .prepare("SELECT payload FROM entry_structure_watch WHERE mode=? AND mint=?")
            .get(env.TRADING_MODE, mint);
        if (current)
            return JSON.parse(String(current.payload));
        const r = this.store.db
            .prepare("SELECT payload FROM sniper_structure_watch WHERE mode=? AND mint=?")
            .get(env.TRADING_MODE, mint);
        return r ? JSON.parse(String(r.payload)) : undefined;
    }
    list() {
        return this.store.db
            .prepare("SELECT payload FROM (SELECT mint,updated_at,payload FROM entry_structure_watch WHERE mode=? UNION ALL SELECT mint,updated_at,payload FROM sniper_structure_watch WHERE mode=? AND mint NOT IN (SELECT mint FROM entry_structure_watch WHERE mode=?)) ORDER BY updated_at DESC LIMIT 500")
            .all(env.TRADING_MODE, env.TRADING_MODE, env.TRADING_MODE)
            .map((r) => JSON.parse(String(r.payload)));
    }
    observe(c, o, now = Date.now()) {
        const old = this.get(c.mint);
        if (hasEntryWatchEligibility(old)
            ? this.store.candidateAuthority(c.mint, env.TRADING_MODE)
                .entryWatchDismissedAt
            : this.store.candidateAuthority(c.mint, env.TRADING_MODE)
                .sniperDismissedAt)
            return old;
        if (!old &&
            this.list().filter((r) => r.status === "ACTIVE" &&
                entrySource(this.store.token(r.mint) ?? {
                    mint: r.mint,
                    source: "SNIPER",
                    discoveredAt: r.structureWatchStartedAt,
                }, this.settings(), now) === "SNIPER").length >= this.settings().structureWatchMaxSize)
            return undefined;
        const next = evolveStructure(old, c.mint, hasEntryWatchEligibility(old) && o && o.at < old.structureWatchStartedAt
            ? undefined
            : o, this.settings(), now);
        this.store.db
            .prepare(`INSERT INTO ${this.table(next)} VALUES(?,?,?,?) ON CONFLICT(mode,mint) DO UPDATE SET updated_at=excluded.updated_at,payload=excluded.payload`)
            .run(env.TRADING_MODE, c.mint, now, JSON.stringify(next));
        if (old?.phase !== next.phase || old?.status !== next.status)
            this.store.record("structure_transitions", c.mint, {
                from: old?.phase,
                to: next.phase,
                status: next.status,
                reason: next.reason,
                at: now,
                mode: env.TRADING_MODE,
            });
        this.store.db
            .prepare(`DELETE FROM ${this.table(next)} WHERE mode=? AND mint IN (SELECT mint FROM ${this.table(next)} WHERE mode=? AND json_extract(payload,'$.status') NOT IN ('ACTIVE','PASSED') ORDER BY updated_at DESC LIMIT -1 OFFSET 250)`)
            .run(env.TRADING_MODE, env.TRADING_MODE);
        return next;
    }
    invalidate(mint, reason) {
        const r = this.get(mint);
        if (r) {
            r.status = "INVALIDATED";
            r.reason = reason;
            this.store.db
                .prepare(`UPDATE ${this.table(r)} SET payload=? WHERE mode=? AND mint=?`)
                .run(JSON.stringify(r), env.TRADING_MODE, mint);
        }
    }
    expire(now = Date.now()) {
        for (const r of this.list())
            if (hasEntryWatchEligibility(r) &&
                r.status === "ACTIVE" &&
                now >= r.structureWatchExpiresAt)
                this.observe({
                    mint: r.mint,
                    source: "SNIPER",
                    discoveredAt: r.structureWatchStartedAt,
                }, undefined, now);
    }
}
