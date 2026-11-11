import { parseMarketHistory } from "./market-history.js";
import { exitSafetyPolicy } from "./exit-safety.js";
import { safeError } from "./util.js";
/** Bounded independent M1 lane. One request per 15s globally, per-position 60s;
 * no monitor awaits, coalesced mint/minute provider keys, no synthetic candles. */
export class PositionHistoryMonitor {
    gmgn;
    apply;
    eligible;
    queue = new Map();
    due = new Map();
    active;
    next = 0;
    stopped = false;
    failures = 0;
    lastError;
    constructor(gmgn, apply, eligible) {
        this.gmgn = gmgn;
        this.apply = apply;
        this.eligible = eligible;
    }
    schedule(p, now = Date.now()) {
        if (this.stopped ||
            this.queue.has(p.id) ||
            this.queue.size >= exitSafetyPolicy.historyQueue ||
            now < (this.due.get(p.id) ?? 0))
            return;
        this.due.set(p.id, now + exitSafetyPolicy.historyIntervalMs);
        this.queue.set(p.id, structuredClone(p));
    }
    pump(now = Date.now()) {
        if (this.stopped || this.active || now < this.next)
            return;
        const p = this.queue.values().next().value;
        if (!p)
            return;
        this.queue.delete(p.id);
        if (!this.eligible(p))
            return;
        this.next = now + exitSafetyPolicy.historySpacingMs;
        this.active = (async () => {
            try {
                const raw = await this.gmgn.marketHistory({
                    mint: p.mint,
                    source: p.source ?? "POSITION",
                    discoveredAt: p.entryAt,
                }, 60000, { priority: 1, consumer: "position-safety-history" });
                if (!this.stopped && this.eligible(p))
                    this.apply(p, parseMarketHistory(raw, {
                        mint: p.mint,
                        source: "POSITION",
                        discoveredAt: p.entryAt,
                    }));
            }
            catch (error) {
                this.failures++;
                this.lastError = safeError(error);
                if (!this.stopped && this.eligible(p))
                    this.apply(p, undefined, error);
            }
        })()
            .catch((error) => {
            this.failures++;
            this.lastError = safeError(error);
        })
            .finally(() => {
            this.active = undefined;
        });
    }
    status() {
        return {
            queued: this.queue.size,
            active: !!this.active,
            globalSpacingMs: exitSafetyPolicy.historySpacingMs,
            failures: this.failures,
            lastError: this.lastError ?? null,
        };
    }
    prune(ids) {
        const keep = new Set(ids);
        for (const id of this.due.keys())
            if (!keep.has(id)) {
                this.due.delete(id);
                this.queue.delete(id);
            }
    }
    async stop() {
        this.stopped = true;
        this.queue.clear();
        await this.active;
    }
}
