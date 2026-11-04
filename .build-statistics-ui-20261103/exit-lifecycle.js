import { randomUUID } from "node:crypto";
import { exitDecision } from "./risk.js";
export function detectExits(p, value, s, signals, now = Date.now()) {
    const existing = (p.pendingExits ?? []).filter((x) => x.takeProfitIndex === undefined ||
        !p.takenProfits.includes(x.takeProfitIndex));
    const prior = new Set(existing.map((x) => x.id));
    const detected = [];
    const add = (kind, reason, sellBps, takeProfitIndex) => {
        let opportunity = existing.find((x) => x.kind === kind &&
            (kind === "TAKE_PROFIT"
                ? x.takeProfitIndex === takeProfitIndex
                : x.reason === reason));
        if (!opportunity) {
            opportunity = {
                id: randomUUID(),
                kind,
                reason,
                sellBps,
                takeProfitIndex,
                triggeredAt: now,
                triggeredValueLamports: value.toString(),
            };
            existing.push(opportunity);
            detected.push(opportunity);
        }
        return opportunity;
    };
    const current = exitDecision({ ...p, state: "OPEN" }, value, s, signals, now);
    let protective, trailing;
    if (current && current.reason !== "Take profit") {
        if (current.reason === "Trailing profit")
            trailing = add("TRAILING", current.reason, current.sellBps);
        else
            protective = add("PROTECTIVE", current.reason, current.sellBps);
    }
    for (let index = 0; p.strategy !== "KRONOS" && index < s.takeProfits.length; index++) {
        const tp = s.takeProfits[index];
        if (!p.takenProfits.includes(index) &&
            BigInt(p.remainingCostLamports) > 0n &&
            value * 10000n >=
                BigInt(p.remainingCostLamports) * BigInt(10000 + tp.gainBps))
            add("TAKE_PROFIT", "Take profit", tp.sellBps, index);
    }
    p.pendingExits = existing;
    const byAge = (a, b) => a.triggeredAt - b.triggeredAt;
    const pendingProtective = existing
        .filter((x) => x.kind === "PROTECTIVE")
        .sort(byAge)[0];
    const tps = existing
        .filter((x) => x.kind === "TAKE_PROFIT")
        .sort((a, b) => (a.takeProfitIndex ?? 0) - (b.takeProfitIndex ?? 0));
    const pendingTp = tps.find((x) => prior.has(x.id));
    const pendingTrailing = existing.find((x) => x.kind === "TRAILING");
    return {
        detected,
        selected: protective ??
            pendingProtective ??
            pendingTp ??
            trailing ??
            pendingTrailing ??
            tps[0],
    };
}
