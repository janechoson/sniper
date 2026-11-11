import { Blocked, CandidateRejected } from "./domain.js";
export const UNSIGNED_EXECUTION_TIMEOUT_MS = 60_000;
/** Cancels the unsigned continuation, not merely the caller's wait. */
export class UnsignedExecutionDeadline {
    timer;
    deadline;
    expired = false;
    signing = false;
    finished = false;
    reject;
    timeout = new Promise((_, reject) => {
        this.reject = reject;
    });
    constructor() {
        void this.timeout.catch(() => { });
    }
    start(at) {
        this.deadline = at + UNSIGNED_EXECUTION_TIMEOUT_MS;
        this.timer = setTimeout(() => this.expire(), Math.max(0, this.deadline - Date.now()));
    }
    error() {
        return new CandidateRejected("EXECUTION_UNSIGNED_TIMEOUT", {
            timeoutMs: UNSIGNED_EXECUTION_TIMEOUT_MS,
        });
    }
    expire() {
        if (this.signing || this.finished || this.expired)
            return;
        this.expired = true;
        this.reject(this.error());
    }
    assertActive() {
        if (!this.signing &&
            this.deadline !== undefined &&
            Date.now() >= this.deadline)
            this.expire();
        if (this.expired)
            throw this.error();
        if (this.finished)
            throw new Blocked("EXECUTION_ATTEMPT_FINISHED");
    }
    async wait(work) {
        this.assertActive();
        const result = await Promise.race([work(), this.timeout]);
        this.assertActive();
        return result;
    }
    beginSigning() {
        this.assertActive();
        // The real provider signs and durably persists the signature synchronously after this hook.
        this.signing = true;
        clearTimeout(this.timer);
    }
    finish() {
        this.finished = true;
        clearTimeout(this.timer);
    }
}
