import { z } from "zod";
import { Blocked, CandidateRejected } from "./domain.js";
const SOL = "So11111111111111111111111111111111111111112";
const atomic = z.string().regex(/^[1-9]\d*$/);
export const orderSchema = z.object({
    priceImpactPct: z.preprocess((v) => {
        if ((typeof v !== "number" && typeof v !== "string") || v === "")
            return undefined;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : undefined;
    }, z.coerce.number().finite().nonnegative().optional()),
    inputMint: z.string(),
    outputMint: z.string(),
    inAmount: atomic,
    outAmount: atomic,
    otherAmountThreshold: atomic,
    swapMode: z.literal("ExactIn"),
    slippageBps: z.number().int().min(0).max(10000),
    taker: z
        .string()
        .nullish()
        .transform((v) => v ?? ""),
    router: z.literal("metis"),
    transaction: z
        .string()
        .nullish()
        .transform((v) => v ?? ""),
    requestId: z.string().default(""),
    signatureFeeLamports: z.number().int().nonnegative().safe().default(0),
    prioritizationFeeLamports: z.number().int().nonnegative().safe().default(0),
    rentFeeLamports: z.number().int().nonnegative().safe().default(0),
    signatureFeePayer: z
        .string()
        .nullish()
        .transform((v) => v ?? ""),
    lastValidBlockHeight: z.string().optional(),
    expireAt: z.string().optional(),
    routePlan: z
        .array(z.object({
        swapInfo: z.object({
            label: z.string(),
            inputMint: z.string(),
            outputMint: z.string(),
        }),
    }))
        .min(1),
});
export function validateQuote(q, expected, now = Date.now()) {
    const o = orderSchema.parse(q.order);
    const buy = expected.side === "BUY";
    if (q.chain !== "solana" ||
        q.provider !== "JUPITER" ||
        q.wallet !== expected.wallet ||
        !!q.routeOnly !== !!expected.routeOnly ||
        (!expected.routeOnly &&
            (o.taker !== expected.wallet ||
                o.signatureFeePayer !== expected.wallet ||
                !o.transaction ||
                !o.requestId)))
        throw new Blocked("QUOTE_CHAIN_OR_WALLET_MISMATCH");
    if (q.mint !== expected.mint ||
        q.side !== expected.side ||
        o.inputMint !== (buy ? SOL : expected.mint) ||
        o.outputMint !== (buy ? expected.mint : SOL) ||
        expected.mint === SOL)
        throw new Blocked("QUOTE_MINT_OR_DIRECTION_MISMATCH");
    if (q.amount !== expected.amount.toString() ||
        o.inAmount !== q.amount ||
        expected.amount <= 0n)
        throw new Blocked("QUOTE_AMOUNT_MISMATCH");
    if (o.slippageBps > expected.slippageBps ||
        q.maxSlippageBps !== expected.slippageBps ||
        BigInt(o.otherAmountThreshold) > BigInt(o.outAmount) ||
        BigInt(o.otherAmountThreshold) <
            (BigInt(o.outAmount) * BigInt(10000 - expected.slippageBps)) / 10000n)
        throw new Blocked("QUOTE_SLIPPAGE_MISMATCH");
    if (now - q.at > 20000 ||
        q.at > now + 1000 ||
        (o.expireAt &&
            (!Number.isFinite(Date.parse(o.expireAt)) ||
                Date.parse(o.expireAt) <= now)))
        throw new CandidateRejected("QUOTE_STALE");
    if (!o.routePlan.some((r) => r.swapInfo.inputMint === o.inputMint) ||
        !o.routePlan.some((r) => r.swapInfo.outputMint === o.outputMint))
        throw new Blocked("QUOTE_ROUTE_MISMATCH");
}
