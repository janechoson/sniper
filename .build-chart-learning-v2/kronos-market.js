import { randomUUID } from "node:crypto";
import { tokenLogo } from "./token-metadata.js";
import { PublicKey } from "@solana/web3.js";
import { normalizeMarket, normalizeSecurity, record, numberEvidence, address, parseTrending, } from "./gmgn.js";
import { cheapGuard } from "./risk.js";
import { settingsSchema } from "./config.js";
import { parseMarketHistory, attemptFlow } from "./market-history.js";
import { inspectMint, requireCompatibleToken } from "./token-program.js";
import { validateCandles, } from "./kronos-domain.js";
/** Fixed GET-only GMGN routes and a single read-only RPC method. No CLI/signing. */
export class KronosMarket {
    apiKey;
    rpcUrl;
    botPort;
    next = 0;
    requests = 0;
    cooldown = 0;
    settings = settingsSchema.parse({});
    constructor(apiKey, rpcUrl = "https://api.mainnet-beta.solana.com", botPort = 3000) {
        this.apiKey = apiKey;
        this.rpcUrl = rpcUrl;
        this.botPort = botPort;
    }
    async json(url, init = {}) {
        const r = await fetch(url, {
            ...init,
            signal: AbortSignal.timeout(20000),
            redirect: "error",
        });
        if (!r.ok) {
            if (r.status === 429)
                this.cooldown = Date.now() + 120000;
            throw Error("LAB_PUBLIC_PROVIDER_HTTP_" + r.status);
        }
        const text = await r.text();
        if (text.length > 4 * 1024 * 1024)
            throw Error("LAB_PROVIDER_RESPONSE_TOO_LARGE");
        return JSON.parse(text);
    }
    async gmgn(route, query) {
        if (![
            "/v1/token/info",
            "/v1/token/security",
            "/v1/market/token_kline",
            "/v1/market/rank",
        ].includes(route))
            throw Error("LAB_READ_ROUTE_DENIED");
        if (!this.apiKey)
            throw Error("KRONOS_GMGN_API_KEY_REQUIRED");
        if (Date.now() < this.cooldown)
            throw Error("LAB_PROVIDER_COOLDOWN");
        await new Promise((r) => setTimeout(r, Math.max(0, this.next - Date.now())));
        this.next = Date.now() + 3000;
        this.requests++;
        const url = new URL("https://openapi.gmgn.ai" + route);
        for (const [k, v] of Object.entries({
            ...query,
            chain: "sol",
            timestamp: Math.floor(Date.now() / 1000),
            client_id: randomUUID(),
        }))
            url.searchParams.set(k, String(v));
        const response = await this.json(url.href, {
            headers: { "X-APIKEY": this.apiKey, "User-Agent": "gmgn-cli/1.6.9" },
        });
        if (response.code !== 0)
            throw Error("LAB_GMGN_RESPONSE_REJECTED");
        return {
            ...record(response.data),
            _gmgnSnapshot: { fetchedAt: Date.now(), freshness: "FRESH" },
        };
    }
    async discover() {
        // Reuse cached production discovery; never launch another broad scanner.
        const rows = await this.json(`http://127.0.0.1:${this.botPort}/api/tokens`);
        if (!Array.isArray(rows))
            throw Error("DISCOVERY_BRIDGE_SCHEMA");
        const candidates = rows
            .filter((x) => x.discovery?.sources.includes("TRENDING") &&
            !!x.discovery.trending &&
            Date.now() - x.discovery.trending.lastSeenAt <= 180000)
            .slice(0, 50)
            .map((x) => ({
            mint: address(x.mint),
            symbol: x.symbol,
            name: x.name,
            logo: tokenLogo(x),
            source: "gmgn:trending",
            discoveredAt: x.discoveredAt,
            createdAt: x.createdAt,
            discovery: x.discovery,
        }));
        if (candidates.length)
            return candidates;
        // Production can stop discovery while its trading queue drains. One bounded
        // read-only snapshot per Lab discovery cycle keeps the experiment independent.
        const raw = await this.gmgn("/v1/market/rank", {
            interval: "5m",
            order_by: "volume",
            direction: "desc",
            limit: 50,
        });
        return parseTrending(raw, "5m").slice(0, 50);
    }
    async history(c) {
        const now = Date.now(), raw = await this.gmgn("/v1/market/token_kline", {
            address: c.mint,
            resolution: "1m",
            from: now - 3600000,
            to: now,
        });
        const h = parseMarketHistory(raw, c), candles = h.candles.slice(-60).map(({ at, open, high, low, close }) => ({
            at,
            open,
            high,
            low,
            close,
        }));
        validateCandles(candles, Date.now());
        if (Date.now() - h.fetchedAt > this.settings.maxSnapshotAgeMs)
            throw Error("LAB_HISTORY_STALE");
        return { candles, evidence: h };
    }
    async prepare(c, stage) {
        // Older running BOT versions already expose public settings in /api/status.
        // Compatibility fallback avoids restarting a live trading process for Lab.
        let settings;
        try {
            settings = await this.json(`http://127.0.0.1:${this.botPort}/api/kronos/settings`);
        }
        catch (error) {
            if (!(error instanceof Error) ||
                error.message !== "LAB_PUBLIC_PROVIDER_HTTP_404")
                throw error;
            const status = await this.json(`http://127.0.0.1:${this.botPort}/api/status`);
            settings = record(status).settings;
        }
        this.settings = settingsSchema.parse(settings);
        let info = {};
        await stage("CHEAP_FILTER", async () => {
            info = await this.gmgn("/v1/token/info", { address: c.mint });
            const created = numberEvidence(info.creation_timestamp);
            if (!c.createdAt && created.state === "KNOWN")
                c = { ...c, createdAt: created.value * 1000 };
            const result = cheapGuard(c, normalizeMarket(info), this.settings);
            if (!result.allowed)
                throw Error(result.reason);
            const liquidity = normalizeMarket(info).liquidity;
            if (liquidity.state !== "KNOWN" ||
                liquidity.value < this.settings.minLiquidityUsd)
                throw Error("Liquidity is below the configured entry policy");
            return result;
        });
        await stage("SECURITY", async () => {
            const sec = normalizeSecurity(await this.gmgn("/v1/token/security", { address: c.mint }), c, this.settings);
            if (sec.findings.some((f) => f.level === "CRITICAL") ||
                sec.mintRenounced.state !== "KNOWN" ||
                !sec.mintRenounced.value ||
                sec.freezeRenounced.state !== "KNOWN" ||
                !sec.freezeRenounced.value)
                throw Error("LAB_SECURITY_REJECT");
            return { ...sec, raw: undefined };
        });
        await stage("COMPATIBILITY", async () => {
            const u = new URL(this.rpcUrl);
            if (!["https:", "http:"].includes(u.protocol))
                throw Error("RPC_URL_INVALID");
            const raw = await this.json(this.rpcUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "getAccountInfo",
                    params: [c.mint, { encoding: "base64", commitment: "confirmed" }],
                }),
            });
            const a = raw.result?.value;
            if (!a || raw.error)
                throw Error("LAB_RPC_MINT_UNAVAILABLE");
            const report = inspectMint(c.mint, {
                data: Buffer.from(a.data[0], "base64"),
                executable: a.executable,
                owner: new PublicKey(a.owner),
                lamports: a.lamports,
                rentEpoch: a.rentEpoch,
            });
            requireCompatibleToken(report);
            if (report.decimals !== normalizeMarket(info).decimals)
                throw Error("LAB_DECIMALS_MISMATCH");
            return report;
        });
        let h;
        await stage("HISTORY", async () => {
            h = await this.history(c);
            return h.evidence;
        });
        await stage("CAPITAL_FLOW", async () => {
            const f = attemptFlow(c, normalizeMarket(info), info, h.evidence, this.settings.flowMeaningfulChangePercent);
            if (f.quality.status !== "READY")
                throw Error("LAB_FLOW_INPUT_UNAVAILABLE");
            return f;
        });
        return h;
    }
    async price(mint) {
        const m = normalizeMarket(await this.gmgn("/v1/token/info", { address: mint }));
        return m.price.state === "KNOWN" && m.price.value > 0
            ? {
                value: m.price.value,
                observedAt: m.at,
                source: "GMGN_TOKEN_INFO",
            }
            : undefined;
    }
    status() {
        return {
            requests: this.requests,
            cooldownUntil: this.cooldown,
            spacingMs: 3000,
            discovery: "EXISTING_BOT_FIRST_BOUNDED_GMGN_FALLBACK_50_PER_120S",
        };
    }
}
