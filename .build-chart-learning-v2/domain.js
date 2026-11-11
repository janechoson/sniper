export const known = (value) => ({ state: "KNOWN", value });
export const unknown = (reason = "GMGN did not supply this field") => ({ state: "UNKNOWN", reason });
export class Blocked extends Error {
    code;
    classification;
    scope = "SYSTEM";
    constructor(code, classification = "BLOCKED_INFRASTRUCTURE") {
        super(code);
        this.code = code;
        this.classification = classification;
    }
}
export class CandidateRejected extends Blocked {
    details;
    scope = "CANDIDATE";
    constructor(reason, details = {}) {
        super(reason, "CANDIDATE_REJECTED");
        this.details = details;
    }
}
export class ProviderFailure extends Blocked {
    provider;
    retryable;
    constructor(code, provider, retryable = true) {
        super(code, "PROVIDER_FAILURE");
        this.provider = provider;
        this.retryable = retryable;
    }
}
