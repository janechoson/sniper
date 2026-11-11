import { randomUUID } from "node:crypto";
import { Blocked, CandidateRejected, } from "./domain.js";
export const CONTROLLED_BUY_CAP = 5000000n;
export class ControlledSession {
    store;
    id;
    static resume(store) {
        const run = store.get("controlledLiveRunV1");
        if (!run?.buySignature || !run.positionId || run.status === "COMPLETE")
            throw new Blocked("NO_CONTROLLED_POSITION_TO_RESUME");
        if (store.pending().length)
            throw new Blocked("PENDING_TRANSACTION_REQUIRES_RECONCILIATION");
        const open = store
            .positions("live")
            .filter((p) => ["OPEN", "PENDING_EXIT", "PENDING_ENTRY"].includes(p.state));
        if (open.length !== 1 ||
            open[0]?.id !== run.positionId ||
            open[0]?.state !== "OPEN")
            throw new Blocked("CONTROLLED_RESUME_POSITION_MISMATCH");
        run.status = "OPEN";
        delete run.finishedAt;
        delete run.reason;
        delete run.sellError;
        store.set("controlledLiveRunV1", run);
        store.set("newEntriesEnabled", false);
        store.event("CONTROLLED_RESUMED", run.mint, "Original one-BUY allowance remains consumed; existing position only");
        return new ControlledSession(store, run.id);
    }
    static create(store) {
        const prior = store.get("controlledLiveRunV1");
        if (prior?.buySignature && prior.status !== "COMPLETE")
            throw new Blocked("PREVIOUS_CONTROLLED_BUY_REQUIRES_RECONCILIATION");
        if (store.pending().length ||
            store
                .positions("live")
                .some((p) => ["OPEN", "PENDING_ENTRY", "PENDING_EXIT"].includes(p.state)))
            throw new Blocked("CONTROLLED_RUN_REQUIRES_NO_OPEN_OR_PENDING_TRADES");
        const run = {
            id: randomUUID(),
            startedAt: Date.now(),
            startRecordId: Number(store.db.prepare("SELECT coalesce(max(id),0) id FROM records").get()
                .id),
            status: "WAITING",
            principalCapLamports: CONTROLLED_BUY_CAP.toString(),
            maxOpenPositions: 1,
            maxCompletedTrades: 1,
        };
        store.set("controlledLiveRunV1", run);
        return new ControlledSession(store, run.id);
    }
    constructor(store, id) {
        this.store = store;
        this.id = id;
        this.read();
    }
    read() {
        const value = this.store.get("controlledLiveRunV1");
        if (!value || value.id !== this.id)
            throw new Blocked("CONTROLLED_RUN_ID_MISMATCH");
        return value;
    }
    save(run) {
        this.store.set("controlledLiveRunV1", run);
    }
    validate(intent) {
        const run = this.read();
        if (intent.mode !== "live")
            throw new Blocked("CONTROLLED_RUN_LIVE_ONLY");
        if (intent.side === "BUY") {
            if (BigInt(intent.amount) <= 0n ||
                BigInt(intent.amount) > CONTROLLED_BUY_CAP)
                throw new CandidateRejected("CONTROLLED_PRINCIPAL_CAP", {
                    amount: intent.amount,
                    cap: CONTROLLED_BUY_CAP.toString(),
                });
            if (run.buySignature ||
                ["COMPLETE", "UNKNOWN", "POSITION_OPEN_FAILURE", "BLOCKED"].includes(run.status))
                throw new Blocked("CONTROLLED_BUY_ALREADY_CONSUMED");
            if (run.buyIntentId && run.buyIntentId !== intent.id)
                throw new Blocked("CONTROLLED_DUPLICATE_BUY_INVARIANT");
        }
        else if (intent.positionId !== run.positionId ||
            intent.mint !== run.mint ||
            !run.buySignature)
            throw new Blocked("CONTROLLED_SELL_POSITION_MISMATCH");
    }
    reserve(intent) {
        this.validate(intent);
        if (intent.side !== "BUY")
            return;
        const run = this.read();
        run.buyIntentId = intent.id;
        run.positionId = intent.positionId;
        run.mint = intent.mint;
        run.status = "ENTRY_RESERVED";
        this.save(run);
    }
    submitted(e) {
        if (e.intent.side !== "BUY")
            return;
        this.validate(e.intent);
        if (!e.signature)
            throw new Blocked("CONTROLLED_SIGNATURE_REQUIRED");
        const run = this.read();
        run.buySignature = e.signature;
        run.status = "SUBMITTED";
        this.save(run);
        this.store.set("newEntriesEnabled", false);
        this.store.event("CONTROLLED_BUY_LOCKED", e.intent.mint, "One BUY submitted; all further entries disabled while exits continue");
    }
    confirmed(e) {
        const run = this.read();
        if (e.intent.positionId !== run.positionId)
            throw new Blocked("CONTROLLED_POSITION_MISMATCH");
        if (e.intent.side === "BUY")
            run.status = "OPEN";
        else {
            const position = this.store
                .positions("live")
                .find((p) => p.id === run.positionId);
            if (position?.state === "CLOSED") {
                if (position.quantity !== "0" ||
                    !e.signature ||
                    !this.store.db
                        .prepare("SELECT signature FROM execution_fills WHERE execution_id=? AND signature=?")
                        .get(e.id, e.signature))
                    throw new Blocked("CONTROLLED_SETTLEMENT_EVIDENCE_MISSING");
                run.status = "COMPLETE";
                run.finishedAt = Date.now();
            }
        }
        this.save(run);
    }
    failed(e) {
        const run = this.read();
        if (e.intent.side === "BUY" && !e.signature) {
            if (run.buyIntentId === e.intent.id) {
                delete run.buyIntentId;
                delete run.positionId;
                delete run.mint;
                run.status = "WAITING";
                this.save(run);
            }
        }
        else {
            run.status =
                e.state === "UNKNOWN" || e.state === "AMBIGUOUS"
                    ? "UNKNOWN"
                    : e.intent.side === "SELL"
                        ? "POSITION_OPEN_FAILURE"
                        : "BLOCKED";
            run.reason = e.error;
            if (e.intent.side === "SELL")
                run.sellError = e.error;
            this.save(run);
            this.store.set("newEntriesEnabled", false);
        }
    }
    block(reason) {
        const run = this.read();
        run.reason = reason;
        if (!run.buySignature)
            run.status = "BLOCKED";
        run.finishedAt = Date.now();
        this.save(run);
        this.store.set("newEntriesEnabled", false);
    }
}
