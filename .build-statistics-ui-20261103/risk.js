import { randomUUID } from "node:crypto";
import { address } from "./gmgn.js";
import { Blocked, CandidateRejected, } from "./domain.js";
import { deepFreeze, hash, log } from "./util.js";
import { validRecoveryBypass } from "./recovery-guard.js";
import { hasTimelyStructurePass, hasEligibleStructurePass, ENTRY_WATCH_POLICY, } from "./sniper-structure.js";
export function size(balance, reserve, pending = 0n, percent = 1) {
    const basisPoints = Math.round(percent * 100);
    if (!Number.isFinite(percent) ||
        percent < 0.01 ||
        percent > 100 ||
        Math.abs(percent * 100 - basisPoints) > 1e-8)
        throw new Blocked("INVALID_POSITION_SIZE_PERCENT");
    const available = balance - reserve - pending;
    return {
        available: available > 0n ? available : 0n,
        amount: available > 0n ? (available * BigInt(basisPoints)) / 10000n : 0n,
    };
}
export function decision(outcome, reason) {
    return { allowed: outcome === "BUY", outcome, reason, at: Date.now() };
}
export function cheapGuard(c, m, s) {
    try {
        address(c.mint);
    }
    catch {
        return decision("SKIP_MARKET", "Invalid Solana mint");
    }
    if (c.createdAt &&
        (Date.now() - c.createdAt >
            (c.discovery?.sources.includes("TRENDING")
                ? s.trendingMaxAgeSeconds
                : s.maxAgeSeconds) *
                1000 ||
            c.createdAt > Date.now() + 5000))
        return decision("SKIP_MARKET", "Candidate age is outside the configured strategy window");
    if (m.price.state !== "KNOWN" ||
        m.price.value <= 0 ||
        m.liquidity.state !== "KNOWN")
        return decision("SKIP_MISSING_CRITICAL_DATA", "GMGN price or liquidity is unavailable");
    if (m.liquidity.value <= 0)
        return decision("SKIP_MARKET", "GMGN reports no usable liquidity");
    return decision("BUY", "Cheap filter passed");
}
export class RiskEngine {
    evaluate(snap, s, ctx, now = Date.now(), phase = "EXECUTION") {
        const kronos = snap.strategy === "KRONOS";
        if (!kronos && snap.manipulationStructure?.status === "STRONG")
            return decision("SKIP_RISK", "CONTROLLED_MARKUP_STRUCTURE");
        const recoveryBypassed = !kronos &&
            phase === "EXECUTION" &&
            snap.entryDiscoverySource === "TRENDING" &&
            validRecoveryBypass(snap.sniperStructureAtEntry, s, snap.entryAuthority, now);
        if (snap.gmgnQuality && snap.gmgnQuality.freshness !== "FRESH")
            return decision("SKIP_RISK", "Fresh GMGN evidence is required");
        if (!kronos &&
            snap.entryAuthority?.policy === "TRENDING_ONE_SHOT_V1" &&
            snap.oneShotStructure?.version === "STRUCTURE_EVIDENCE_V3") {
            const v3 = snap.oneShotStructure;
            const relevantAt = v3.priceStructure.latestRelevantAt;
            if (!v3.passed ||
                relevantAt === null ||
                relevantAt > now ||
                now - relevantAt > s.structureMaxGapMs ||
                !snap.marketHistory ||
                snap.marketHistory.fetchedAt > now ||
                now - snap.marketHistory.fetchedAt > s.maxSnapshotAgeMs ||
                snap.marketHistory.historyTo === null ||
                now - snap.marketHistory.historyTo > s.maxSnapshotAgeMs + 60000)
                return decision("SKIP_RISK", !v3.passed ? v3.reason : "STALE_PRICE_RECOVERY");
        }
        if (!kronos &&
            snap.entryAuthority?.policy === "TRENDING_ONE_SHOT_V1" &&
            phase === "EXECUTION" &&
            (!snap.attemptId ||
                !snap.oneShotStructure?.passed ||
                now - snap.oneShotStructure.at > s.maxSnapshotAgeMs ||
                snap.oneShotStructure.at > now ||
                !snap.capitalFlow ||
                snap.capitalFlow.regime === "INSUFFICIENT_DATA" ||
                now - snap.capitalFlow.at > s.maxSnapshotAgeMs))
            return decision("SKIP_RISK", "Fresh one-shot structure and flow required");
        if (!kronos &&
            snap.entryAuthority?.policy !== "TRENDING_ONE_SHOT_V1" &&
            phase === "EXECUTION" &&
            (snap.entryDiscoverySource === "SNIPER" ||
                snap.entryDiscoverySource === "TRENDING") &&
            (!(hasTimelyStructurePass(snap.sniperStructureAtEntry, now) ||
                recoveryBypassed) ||
                (snap.entryDiscoverySource === "TRENDING" &&
                    (!(hasEligibleStructurePass(snap.sniperStructureAtEntry, now) ||
                        recoveryBypassed) ||
                        snap.entryAuthority?.policy !== ENTRY_WATCH_POLICY ||
                        snap.sniperStructureAtEntry?.eligibility?.authorityRevision !==
                            snap.entryAuthority.revision)) ||
                !snap.sniperStructureAtEntry ||
                snap.sniperStructureAtEntry.quality !== "FRESH" ||
                !snap.sniperStructureAtEntry.lastObservedAt ||
                now - snap.sniperStructureAtEntry.lastObservedAt >
                    s.structureMaxGapMs ||
                snap.sniperStructureAtEntry.lastObservedAt > now))
            return decision("SKIP_RISK", "Entry buyer defense is not freshly confirmed");
        if (recoveryBypassed)
            log("temp_recovery_guard_bypassed", {
                message: "[TEMP] Risk EXECUTION Recovery guard bypassed",
                mint: snap.candidate.mint,
            });
        if (!ctx.entriesEnabled)
            return decision("SKIP_RISK", "New entries are disabled");
        if (ctx.duplicate)
            return decision("SKIP_RISK", "This mint already has a position or durable BUY intent");
        if (snap.tokenExecution?.decision === "SKIP")
            return decision(snap.tokenExecution.extensionRisk === "CRITICAL"
                ? "SKIP_RUG"
                : "SKIP_MARKET", "On-chain token execution policy rejects mint/extensions");
        const cheap = cheapGuard(snap.candidate, snap.market, s);
        if (!cheap.allowed)
            return cheap;
        const critical = snap.security.findings.find((f) => f.level === "CRITICAL");
        if (critical)
            return decision("SKIP_RUG", critical.reason);
        if (snap.security.mintRenounced.state !== "KNOWN" ||
            snap.security.freezeRenounced.state !== "KNOWN")
            return decision("SKIP_MISSING_CRITICAL_DATA", "GMGN mint/freeze control evidence is unavailable");
        if (now - snap.market.at > s.maxSnapshotAgeMs ||
            now - snap.security.at > s.maxSnapshotAgeMs ||
            (phase !== "COMMON" &&
                (kronos
                    ? !snap.kronos ||
                        now - snap.kronos.decisionAt > s.maxSnapshotAgeMs ||
                        snap.kronos.decisionAt > now
                    : !snap.jev || now - snap.jev.at > s.maxSnapshotAgeMs)))
            return decision("SKIP_RISK", "Decision evidence is stale");
        if (snap.market.liquidity.state === "KNOWN" &&
            snap.market.liquidity.value < s.minLiquidityUsd)
            return decision("SKIP_MARKET", "Liquidity is below the configured entry policy");
        for (const [field, limit, label] of [
            [snap.intelligence.holders.top1, s.maxTop1Percent, "Top holder"],
            [snap.intelligence.holders.top10, s.maxTop10Percent, "Top ten holders"],
            [snap.intelligence.creator.holdPercent, s.maxCreatorPercent, "Creator"],
        ])
            if (field.state === "KNOWN" && field.value > limit)
                return decision("SKIP_RISK", `${label} concentration exceeds configured policy`);
        const evidence = snap.intelligence.riskEvidence;
        if (!evidence ||
            (evidence &&
                (evidence.freshness !== "FRESH" ||
                    evidence.fetchedAt > now ||
                    now - evidence.fetchedAt > s.maxSnapshotAgeMs)))
            return decision("SKIP_MISSING_CRITICAL_DATA", "Authoritative holder evidence is stale or unavailable");
        if (kronos && phase !== "COMMON") {
            if (!snap.kronos ||
                snap.kronos.action !== "BUY" ||
                snap.jev ||
                !snap.attemptId ||
                !snap.entryAuthority ||
                snap.entryAuthority.policy !== "TRENDING_ONE_SHOT_V1" ||
                !snap.marketHistory ||
                now - snap.marketHistory.fetchedAt > s.maxSnapshotAgeMs ||
                snap.marketHistory.fetchedAt > now ||
                !snap.capitalFlow ||
                snap.capitalFlow.regime === "INSUFFICIENT_DATA" ||
                now - snap.capitalFlow.at > s.maxSnapshotAgeMs ||
                snap.capitalFlow.at > now)
                return decision("SKIP_RISK", "Fresh Kronos BUY, common history/flow and bound authority required");
        }
        const j = snap.jev;
        if (phase !== "COMMON" &&
            !kronos &&
            (!j || j.model !== "jev-1.14.0" || j.insufficientData))
            return decision("SKIP_JEV", "Jev could not make a sufficiently supported pinned-model decision");
        if (phase !== "COMMON" &&
            !kronos &&
            (!j || j.action !== "BUY" || j.risk === "HIGH" || j.suspicious))
            return decision("SKIP_JEV", "Jev did not approve this entry");
        if (size(ctx.balance, BigInt(s.feeReserveLamports), ctx.pending, s.positionSizePercent).amount <= 0n)
            return decision("SKIP_RISK", "WAITING_FOR_CAPITAL: INSUFFICIENT_SPENDABLE_BALANCE after operational and pending reserves");
        return decision("BUY", (kronos
            ? "GMGN evidence, Kronos and deterministic policy allow entry"
            : "GMGN evidence, Jev and deterministic policy allow entry") +
            (snap.jev?.historicalAssessment
                ? `; historical context ${snap.jev.historicalAssessment.strength}, ${snap.jev.historicalAssessment.similarTradeCount} supplied samples (advisory only)`
                : ""));
    }
    approve(snap, s, ctx, mode) {
        const r = this.evaluate(snap, s, ctx);
        if (!r.allowed)
            throw new CandidateRejected("TEMPORARY_RISK_CHANGE", {
                reason: "CURRENT_RISK_REJECTED",
                riskReason: r.reason,
            });
        return deepFreeze({
            id: randomUUID(),
            attemptId: snap.attemptId,
            ownershipClaimId: snap.ownershipClaimId,
            strategy: snap.strategy ?? "STANDARD",
            decisionSource: snap.strategy === "KRONOS" ? "KRONOS" : "JEV",
            decisionId: snap.kronos?.decisionId ?? snap.jev?.inputHash,
            decisionAt: snap.kronos?.decisionAt ?? snap.jev?.at,
            entryAuthority: snap.entryAuthority,
            provider: "JUPITER",
            key: `${mode}:BUY:${snap.candidate.mint}`,
            mint: snap.candidate.mint,
            side: "BUY",
            mode,
            positionSizePercent: s.positionSizePercent,
            amount: size(ctx.balance, BigInt(s.feeReserveLamports), ctx.pending, s.positionSizePercent).amount.toString(),
            createdAt: Date.now(),
            expiresAt: Date.now() + s.maxSnapshotAgeMs,
            snapshotHash: hash(snap),
            positionId: randomUUID(),
            reason: r.reason,
        });
    }
}
export function exitDecision(p, value, s, signals, _now = Date.now()) {
    if (p.state !== "OPEN" || BigInt(p.quantity) <= 0n)
        return;
    if (signals.manual)
        return { reason: "Manual emergency exit", sellBps: 10000 };
    if (signals.critical)
        return { reason: "Critical GMGN security deterioration", sellBps: 10000 };
    if (signals.liquidity !== undefined &&
        p.initialLiquidity &&
        signals.liquidity * 10000 <
            p.initialLiquidity * (10000 - s.liquidityCollapseBps))
        return { reason: "GMGN liquidity removal/collapse", sellBps: 10000 };
    // Smart-money participant trades are advisory evidence for JEV, never
    // direct SELL authority (including legacy smartMoneyExitMode=EXIT).
    if (p.strategy === "KRONOS")
        return;
    const cost = BigInt(p.remainingCostLamports);
    if (cost > 0n &&
        BigInt(p.highWaterLamports) * 10000n >=
            cost * BigInt(10000 + s.trailingActivationBps) &&
        value > cost &&
        value * 10000n <=
            BigInt(p.highWaterLamports) * BigInt(10000 - s.trailingStopBps))
        return { reason: "Trailing profit", sellBps: 10000 };
    for (let i = 0; i < s.takeProfits.length; i++) {
        const t = s.takeProfits[i];
        if (!p.takenProfits.includes(i) &&
            value * 10000n >= cost * BigInt(10000 + t.gainBps))
            return { reason: "Take profit", sellBps: t.sellBps, takeProfitIndex: i };
    }
    return;
}
/** Security-only decision path for the normal Jev-managed strategy. */
export function protectiveExitDecision(p, value, s, signals) {
    const result = exitDecision(p, value, s, signals);
    return result && !["Take profit", "Trailing profit"].includes(result.reason)
        ? result
        : undefined;
}
function fraction(value) {
    const match = /^(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value);
    if (!match || value.length > 128)
        throw new Blocked("Invalid decimal price");
    const exp = Number(match[3] ?? 0) - (match[2]?.length ?? 0);
    if (Math.abs(exp) > 128)
        throw new Blocked("Price exponent is unsupported");
    const n = BigInt(match[1] + (match[2] ?? ""));
    return exp >= 0
        ? { n: n * 10n ** BigInt(exp), d: 1n }
        : { n, d: 10n ** BigInt(-exp) };
}
export function paperQuantity(lamports, solUsd, tokenUsd, decimals) {
    const sol = fraction(solUsd), token = fraction(tokenUsd);
    if (token.n <= 0n || sol.n <= 0n)
        throw new Blocked("GMGN prices must be positive");
    return ((lamports * sol.n * token.d * 10n ** BigInt(decimals)) /
        (1000000000n * sol.d * token.n));
}
export function paperValue(quantity, solUsd, tokenUsd, decimals) {
    const sol = fraction(solUsd), token = fraction(tokenUsd);
    if (sol.n <= 0n)
        throw new Blocked("SOL price unavailable");
    return ((quantity * token.n * sol.d * 1000000000n) /
        (10n ** BigInt(decimals) * token.d * sol.n));
}
