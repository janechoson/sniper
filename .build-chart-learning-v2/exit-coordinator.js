import { randomUUID } from "node:crypto";
import { KRONOS } from "./kronos-domain.js";
/** Submission side of Engine.processExits. Store.claim is the atomic execution
 * owner; existing reconciliation handles pending/signed orders after restart. */
export class ExitCoordinator {
    store;
    constructor(store) {
        this.store = store;
    }
    submitCodex(d, now = Date.now()) {
        return this.store.atomic(() => {
            const p = this.store
                .managedPositions(d.mode)
                .find((p) => p.id === d.positionId);
            if (!p ||
                p.mint !== d.mint ||
                (p.demoAccountId && p.demoAccountId !== d.accountId) ||
                p.state !== "OPEN" ||
                p.strategy !== "KRONOS" ||
                p.quantity !== d.quantity ||
                d.action !== "SELL" ||
                d.at > now ||
                d.expiresAt < now ||
                now - d.at > 15000)
                throw Error("CODEX_EXIT_STALE_OR_WRONG_POSITION");
            const persisted = this.store.learningDb
                .prepare("SELECT payload FROM chart_decisions WHERE id=? AND action='SELL'")
                .get(d.id);
            if (!persisted || String(persisted.payload) !== JSON.stringify(d))
                throw Error("CODEX_EXIT_DECISION_NOT_PERSISTED");
            if (p.pendingExits?.some((o) => o.decisionSource === "CODEX" && o.decisionId === d.id))
                return false;
            p.codexDecision = d;
            p.pendingExits = (p.pendingExits ?? []).filter((o) => o.decisionSource !== "CODEX");
            p.pendingExits.push({
                id: randomUUID(),
                kind: "STRATEGIC",
                strategy: p.strategy,
                decisionSource: "CODEX",
                decisionId: d.id,
                reason: d.reason,
                sellBps: 10000,
                triggeredAt: d.at,
            });
            this.store.savePosition(p);
            this.store.pipelineEvent("CODEX_EXIT_AUTHORIZED", p.mint, {
                positionId: p.id,
                decisionId: d.id,
            });
            return true;
        });
    }
    /** A HOLD/error from one source cannot cancel another source's SELL. */
    static clearSource(p, source) {
        p.pendingExits = (p.pendingExits ?? []).filter((o) => o.kind !== "STRATEGIC" || o.decisionSource !== source);
    }
    static strategic(p, now = Date.now()) {
        return p.pendingExits
            ?.filter((o) => {
            if (o.kind !== "STRATEGIC" || p.strategy !== "KRONOS")
                return false;
            if (o.decisionSource === "KRONOS") {
                const d = p.kronosDecision;
                return (d?.action === "SELL" &&
                    d.decisionId === o.decisionId &&
                    d.quantity === p.quantity &&
                    d.decisionAt <= now &&
                    now - d.decisionAt <= KRONOS.priceMaxAgeMs);
            }
            if (o.decisionSource === "CODEX") {
                const d = p.codexDecision;
                return (d?.action === "SELL" &&
                    d.id === o.decisionId &&
                    d.quantity === p.quantity &&
                    d.positionId === p.id &&
                    d.at <= now &&
                    now - d.at <= 15000 &&
                    d.expiresAt >= now);
            }
            return false;
        })
            .sort((a, b) => Number(b.decisionSource === "KRONOS") -
            Number(a.decisionSource === "KRONOS"))[0];
    }
}
