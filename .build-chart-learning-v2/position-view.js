import { tradeAccounting } from "./trade-accounting.js";
import { tokenLogo } from "./token-metadata.js";
export function positionViews(positions, executions, metadata, options = {}) {
    const views = positions.map((p) => {
        const accounting = tradeAccounting(p, executions);
        const identity = metadata?.(p.mint);
        const unresolved = executions.some((e) => e.intent.positionId === p.id &&
            !!e.signature &&
            ["SUBMITTED", "PENDING_CONFIRMATION", "UNKNOWN", "AMBIGUOUS"].includes(e.state));
        const relevant = !p.dismissal &&
            !["CLOSED", "FAILED"].includes(p.state) &&
            (BigInt(p.quantity) > 0n ||
                unresolved ||
                p.attention?.status === "UNKNOWN");
        const displayState = unresolved
            ? "UNKNOWN"
            : (p.attention?.status ??
                (p.state === "PENDING_EXIT" ? "EXIT_PENDING" : p.state));
        const signedPending = executions.some((e) => e.intent.mode === p.mode &&
            !!e.signature &&
            ["SUBMITTED", "PENDING_CONFIRMATION", "UNKNOWN", "AMBIGUOUS"].includes(e.state));
        const exitState = unresolved
            ? "UNKNOWN"
            : p.state === "PENDING_EXIT"
                ? "PENDING"
                : signedPending
                    ? "WAITING_RECONCILIATION"
                    : p.attention?.issue.stage === "PRE_SELL" &&
                        p.attention.nextCheckAt > Date.now()
                        ? "BACKOFF"
                        : p.pendingExits?.length
                            ? "PENDING"
                            : "READY";
        const blocker = executions.find((e) => e.intent.mode === p.mode &&
            !!e.signature &&
            ["SUBMITTED", "PENDING_CONFIRMATION", "UNKNOWN", "AMBIGUOUS"].includes(e.state));
        const protections = (p.pendingExits ?? []).filter((x) => x.kind === "PROTECTIVE");
        return {
            ...p,
            strategy: p.strategy ?? "STANDARD",
            strategicExitAuthority: p.strategy === "KRONOS" ? "KRONOS" : "HISTORICAL_READ_ONLY",
            logo: tokenLogo(identity) ?? tokenLogo(p),
            name: identity?.name ?? p.name,
            accounting,
            safetyState: {
                strategic: p.strategy === "KRONOS"
                    ? (p.kronosDecision?.action ?? "NO_DECISION")
                    : p.pendingExits?.some((o) => o.kind === "STRATEGIC")
                        ? (p.jevExit?.action ?? "NO_DECISION")
                        : (p.lastAnalystAttempt?.action ??
                            p.jevExit?.action ??
                            "NO_DECISION"),
                latestAnalyst: p.strategy === "KRONOS"
                    ? null
                    : (p.lastAnalystAttempt?.action ?? null),
                analystState: p.strategy === "KRONOS"
                    ? null
                    : (p.lastAnalystAttempt?.decisionState ??
                        p.jevExit?.decisionState ??
                        null),
                protective: protections.length
                    ? protections.some((x) => x.lifecycle === "BLOCKED")
                        ? "BLOCKED"
                        : "PENDING"
                    : "NONE",
                execution: blocker
                    ? ["UNKNOWN", "AMBIGUOUS"].includes(blocker.state)
                        ? "EXECUTION_BLOCKED_BY_UNKNOWN_TX"
                        : blocker.intent.positionId === p.id
                            ? "SUBMITTED"
                            : "WAITING_WALLET_TRANSACTION"
                    : p.state === "PENDING_EXIT"
                        ? "PREPARING"
                        : "IDLE",
                blocker: blocker
                    ? {
                        signature: blocker.signature,
                        positionId: blocker.intent.positionId,
                        mode: blocker.intent.mode,
                        submittedAt: blocker.submittedAt,
                        investigation: blocker.investigation,
                    }
                    : null,
                protections: protections.map((o) => ({
                    kind: o.protection?.kind ?? "LEGACY_REVALIDATION_REQUIRED",
                    state: o.lifecycle,
                    observedAt: o.protection?.observedAt,
                    expiresAt: o.protection?.expiresAt,
                    retry: o.retry,
                })),
            },
            entryPriceUsd: accounting.entryPriceUsd ?? undefined,
            mfePercent: p.grossMfePercent,
            maePercent: p.grossMaePercent,
            managementStatus: p.dismissal ? "MANUALLY_REMOVED" : "MANAGED",
            removalBlocked: p.state !== "OPEN" ||
                executions.some((e) => e.intent.positionId === p.id &&
                    [
                        "CREATED",
                        "SUBMITTED",
                        "PENDING_CONFIRMATION",
                        "UNKNOWN",
                        "AMBIGUOUS",
                    ].includes(e.state)),
            valuationStale: !p.lastQuoteAt ||
                Date.now() - p.lastQuoteAt > 60000 ||
                p.state === "PENDING_EXIT" ||
                p.valuationStatus === "ESTIMATED_AFTER_FILL" ||
                (p.valuationQuantity !== undefined &&
                    p.valuationQuantity !== p.quantity),
            relevant,
            displayState,
            exitState,
            monitoringStatus: p.monitoring?.status ?? "UNKNOWN",
            requiresAttention: relevant && (displayState !== "OPEN" || !!p.attention),
        };
    });
    return options.preserveOrder
        ? views
        : views.sort((a, b) => Number(b.requiresAttention) - Number(a.requiresAttention) ||
            b.entryAt - a.entryAt);
}
