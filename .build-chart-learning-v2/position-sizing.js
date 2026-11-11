import { Blocked } from "./domain.js";
/** SOL settings must represent an exact, positive, safely representable lamport amount. */
export function fixedSolLamports(sol) {
    if (!Number.isFinite(sol) ||
        sol <= 0 ||
        sol > Number.MAX_SAFE_INTEGER / 1e9 ||
        Number(sol.toFixed(9)) !== sol)
        throw new Blocked("INVALID_POSITION_SIZE_SOL");
    const [whole, fraction] = sol.toFixed(9).split(".");
    const amount = BigInt(whole) * 1000000000n + BigInt(fraction);
    if (amount <= 0n || amount > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Blocked("INVALID_POSITION_SIZE_SOL");
    return amount;
}
export function positionSizeMatches(intent, settings) {
    const mode = settings.positionSizeMode ?? "PERCENT";
    if ((intent.positionSizeMode ?? "PERCENT") !== mode)
        return false;
    return mode === "SOL"
        ? intent.positionSizeSol === (settings.positionSizeSol ?? 0.2)
        : intent.positionSizePercent === undefined ||
            intent.positionSizePercent === (settings.positionSizePercent ?? 1);
}
/** A zero amount means insufficient capital; a fixed order is never resized to fit. */
export function size(balance, reserve, pending = 0n, sizing = 1) {
    const settings = typeof sizing === "number" ? { positionSizePercent: sizing } : sizing;
    const available = balance - reserve - pending;
    const spendable = available > 0n ? available : 0n;
    if (settings.positionSizeMode === "SOL") {
        const amount = fixedSolLamports(settings.positionSizeSol ?? 0.2);
        return { available: spendable, amount: amount <= spendable ? amount : 0n };
    }
    if (settings.positionSizeMode !== undefined &&
        settings.positionSizeMode !== "PERCENT")
        throw new Blocked("INVALID_POSITION_SIZE_MODE");
    const percent = settings.positionSizePercent ?? 1;
    const basisPoints = Math.round(percent * 100);
    if (!Number.isFinite(percent) ||
        percent < 0.01 ||
        percent > 100 ||
        Math.abs(percent * 100 - basisPoints) > 1e-8)
        throw new Blocked("INVALID_POSITION_SIZE_PERCENT");
    return {
        available: spendable,
        amount: (spendable * BigInt(basisPoints)) / 10000n,
    };
}
