export function rateLimitMetadata(response) {
    const timing = (value) => {
        if (!value)
            return undefined;
        if (/^\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value)))
            return String(Number(value));
        const at = Date.parse(value);
        return Number.isFinite(at) ? new Date(at).toUTCString() : undefined;
    };
    return {
        status: response.status,
        retryAfter: timing(response.headers.get("retry-after")),
        reset: timing(response.headers.get("x-ratelimit-reset")),
        type: "HTTP_RATE_LIMIT",
    };
}
export function transportRetryDelay(stderr, now = Date.now()) {
    const values = [];
    for (const match of stderr.matchAll(/GMGN_RATE_METADATA:([^\r\n]+)/g)) {
        try {
            const m = JSON.parse(match[1]);
            if (m.status !== 429)
                continue;
            if (m.retryAfter) {
                const n = /^\d+(\.\d+)?$/.test(m.retryAfter)
                    ? Number(m.retryAfter) * 1000
                    : Date.parse(m.retryAfter) - now;
                if (Number.isFinite(n) && n >= 0)
                    values.push(n);
            }
            if (m.reset) {
                const n = /^\d+(\.\d+)?$/.test(m.reset)
                    ? Number(m.reset) * 1000 - now
                    : Date.parse(m.reset) - now;
                if (Number.isFinite(n) && n >= 0)
                    values.push(n);
            }
        }
        catch {
            /* Untrusted CLI text cannot become provider authority. */
        }
    }
    return values.length ? Math.max(...values) : undefined;
}
