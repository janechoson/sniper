import { Blocked } from "./domain.js";
export const SMOKE_MAX_LAMPORTS = 5000000n;
export const SMOKE_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
// Independently verified with Circle's official USDC contract-address table.
export const SMOKE_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SMOKE_SOL = "So11111111111111111111111111111111111111112";
export const SMOKE_SLIPPAGE_BPS = 100;
export const SMOKE_FEE_RESERVE = 5000000n;
export function smokeAmount(value = "0.005") {
    if (!/^\d+(\.\d{1,9})?$/.test(value))
        throw new Blocked("SMOKE_INVALID_SOL_AMOUNT");
    const [whole, fraction = ""] = value.split(".");
    const amount = BigInt(whole) * 1000000000n + BigInt(fraction.padEnd(9, "0"));
    if (amount <= 0n || amount > SMOKE_MAX_LAMPORTS)
        throw new Blocked("MINIMUM_AMOUNT_EXCEEDS_SMOKE_CAP");
    return amount;
}
export function acquiredOnly(before, after) {
    if (after <= before)
        throw new Blocked("SMOKE_NO_ACQUIRED_TOKENS");
    return after - before;
}
