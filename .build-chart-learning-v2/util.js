import { createHash } from "node:crypto";
import { Blocked, ProviderFailure } from "./domain.js";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const hash = (v) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export function deepFreeze(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value))
            deepFreeze(child);
    }
    return value;
}
export function json(v) {
    const secrets = Object.entries(process.env)
        .filter(([name, secret]) => /(?:PRIVATE_KEY|SECRET|MNEMONIC|API_KEY)/.test(name) &&
        secret &&
        secret.length >= 8)
        .map(([, secret]) => secret);
    return JSON.stringify(v, (key, value) => {
        if (/(?:private.?key|secret|mnemonic|seed.?phrase|api.?key|authorization|signedTransaction)/i.test(key))
            return "[REDACTED]";
        if (typeof value === "bigint")
            return value.toString();
        if (typeof value === "string") {
            for (const secret of secrets)
                value = value.split(secret).join("[REDACTED]");
        }
        return value;
    });
}
export function log(event, fields = {}) {
    process.stdout.write(json({ at: new Date().toISOString(), event, ...fields }) + "\n");
}
export function safeError(e) {
    if (e instanceof Blocked)
        return e.code;
    if (e &&
        typeof e === "object" &&
        "code" in e &&
        typeof e.code === "string" &&
        /^[A-Z][A-Z0-9_]{1,60}$/.test(e.code))
        return e.code;
    return "OPERATION_FAILED";
}
export class Http {
    name;
    interval;
    totalTimeoutMs;
    health = { state: "UNKNOWN", at: 0 };
    next = 0;
    tail = Promise.resolve();
    constructor(name, interval = 1000, totalTimeoutMs) {
        this.name = name;
        this.interval = interval;
        this.totalTimeoutMs = totalTimeoutMs;
    }
    async request(url, init = {}, retry = true) {
        const prior = this.tail;
        let unlock;
        this.tail = new Promise((r) => {
            unlock = r;
        });
        let started = Date.now();
        let acquired = false;
        const controller = this.totalTimeoutMs ? new AbortController() : undefined;
        const expired = new ProviderFailure(this.name + "_REQUEST_TIMEOUT", this.name);
        let timer;
        const timeout = controller
            ? new Promise((_, reject) => {
                timer = setTimeout(() => {
                    controller.abort(expired);
                    reject(expired);
                }, this.totalTimeoutMs);
            })
            : undefined;
        const wait = (work) => timeout ? Promise.race([work, timeout]) : work;
        try {
            await wait(prior);
            acquired = true;
            if (!controller)
                started = Date.now();
            await wait(sleep(Math.max(0, this.next - Date.now())));
            for (let n = 0; n < (retry ? 3 : 1); n++) {
                this.next = Date.now() + this.interval;
                let response;
                try {
                    response = await wait(fetch(url, {
                        ...init,
                        signal: controller
                            ? AbortSignal.any([
                                AbortSignal.timeout(15000),
                                controller.signal,
                                ...(init.signal ? [init.signal] : []),
                            ])
                            : AbortSignal.timeout(15000),
                    }));
                }
                catch (error) {
                    const timeout = error instanceof Error &&
                        (["TimeoutError", "AbortError"].includes(error.name) ||
                            /timeout/i.test(error.message));
                    throw new ProviderFailure(this.name + (timeout ? "_TIMEOUT" : "_UNAVAILABLE"), this.name);
                }
                if ((response.status === 429 || response.status >= 500) &&
                    retry &&
                    n < 2) {
                    await wait(sleep(Math.min(10000, Math.max(1000, Number(response.headers.get("retry-after") || 0) * 1000, 1000 * 2 ** n))));
                    continue;
                }
                if (!response.ok) {
                    throw new ProviderFailure(this.name + "_HTTP_" + response.status, this.name, ![401, 403].includes(response.status));
                }
                let data;
                try {
                    data = await wait(response.json());
                }
                catch {
                    throw new ProviderFailure(this.name + "_INVALID_RESPONSE", this.name);
                }
                this.health = {
                    state: "READY",
                    at: Date.now(),
                    latencyMs: Date.now() - started,
                };
                return data;
            }
            throw new ProviderFailure(this.name + "_RETRIES_EXHAUSTED", this.name);
        }
        catch (e) {
            const error = controller?.signal.aborted ? expired : e;
            this.health = {
                state: "BLOCKED",
                at: Date.now(),
                reason: safeError(error),
            };
            throw error;
        }
        finally {
            clearTimeout(timer);
            // A queued timeout must not let followers overtake an active predecessor.
            if (acquired)
                unlock();
            else
                void prior.then(unlock, unlock);
        }
    }
}
