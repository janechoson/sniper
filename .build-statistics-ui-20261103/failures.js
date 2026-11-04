import { CandidateRejected, ProviderFailure, } from "./domain.js";
import { safeError } from "./util.js";
const permanent = new Set([
    "UNSUPPORTED_TOKEN_PROGRAM",
    "INVALID_MINT_LAYOUT",
    "UNSUPPORTED_TOKEN_EXTENSION",
    "INVALID_TOKEN_ACCOUNT_LAYOUT",
    "TOKEN_ALREADY_OWNED",
    "CRITICAL_TOKEN_EXTENSION",
    "TOKEN_MARKET_INVALID",
    "CANDIDATE_EXPIRED",
]);
export function failureInfo(error, context, now = Date.now()) {
    const code = safeError(error);
    const details = error instanceof CandidateRejected ? error.details : undefined;
    const scope = context.submitted
        ? "TRANSACTION"
        : error instanceof CandidateRejected || error instanceof ProviderFailure
            ? context.position
                ? "POSITION"
                : "CANDIDATE"
            : "SYSTEM";
    return {
        code,
        scope,
        mint: context.mint,
        symbol: context.symbol,
        stage: context.stage,
        reasonCode: typeof details?.reason === "string" ? details.reason : code,
        retryable: scope !== "TRANSACTION" &&
            scope !== "SYSTEM" &&
            !permanent.has(code) &&
            !(error instanceof ProviderFailure && !error.retryable),
        detectedAt: now,
        details,
    };
}
/** Bounded evidence window: a single token timeout is not proof of a provider outage. */
export class ProviderFailures {
    failures = [];
    observe(error, mint, now = Date.now()) {
        if (error.provider === "GMGN" &&
            error.retryable &&
            error.code === "GMGN_RATE_LIMIT_COOLDOWN")
            return false;
        this.failures = this.failures.filter((f) => now - f.at < 300000).slice(-49);
        this.failures.push({ provider: error.provider, mint, at: now });
        const matching = this.failures.filter((f) => f.provider === error.provider);
        return (!error.retryable ||
            new Set(matching.map((f) => f.mint)).size >= 3 ||
            (mint === "DISCOVERY" &&
                matching.filter((f) => f.mint === "DISCOVERY").length >= 3));
    }
}
