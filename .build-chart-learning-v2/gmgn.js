import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GmgnProviderState } from "./gmgn-provider-state.js";
import { normalizeSmartMoney, unavailableSmartMoney } from "./smart-money.js";
import { transportRetryDelay } from "./gmgn-rate-metadata.js";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { env, gmgnSigningKey } from "./config.js";
import { Blocked, CandidateRejected, ProviderFailure, known, unknown, } from "./domain.js";
import { normalizeTokenLogo } from "./token-metadata.js";
import { GmgnCoordinator, gmgnRequestKey, GmgnRateLimited, retryDelay, } from "./gmgn-coordinator.js";
const require = createRequire(import.meta.url);
export const SOL = "So11111111111111111111111111111111111111112";
const object = z.record(z.string(), z.unknown());
export const record = (v) => object.safeParse(v).success ? v : {};
export function address(value) {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value))
        throw new Blocked("Invalid Solana public address");
    return new PublicKey(value).toBase58();
}
export function numberEvidence(v) {
    if ((typeof v !== "number" && typeof v !== "string") ||
        (typeof v === "string" && v.trim() === ""))
        return unknown();
    const n = Number(v);
    return Number.isFinite(n) && n >= 0
        ? known(n)
        : unknown("Invalid GMGN numeric value");
}
export function percent(v) {
    const n = numberEvidence(v);
    return n.state === "KNOWN" && n.value <= 1
        ? known(n.value * 100)
        : unknown("Percentage unavailable or outside GMGN fractional units");
}
const bool = (v) => typeof v === "boolean"
    ? known(v)
    : unknown("GMGN did not verify this authority");
const optionalText = (v, max = 128) => typeof v === "string" ? v.slice(0, max) : undefined;
const firstPositive = (...values) => values.find((v) => {
    const n = numberEvidence(v);
    return n.state === "KNOWN" && n.value > 0;
});
export function parseDiscovery(raw) {
    const r = object.parse(raw);
    const now = typeof record(r._gmgnSnapshot).fetchedAt === "number"
        ? Number(record(r._gmgnSnapshot).fetchedAt)
        : Date.now();
    const result = [];
    for (const category of ["new_creation", "pump", "completed"]) {
        const rows = z
            .array(object)
            .parse(category === "pump" ? (r.near_completion ?? r.pump) : r[category]);
        for (const row of rows) {
            try {
                const mint = address(z.string().parse(row.address));
                const created = numberEvidence(row.created_timestamp ?? row.creation_timestamp);
                const listing = Object.fromEntries([
                    "rug_ratio",
                    "renounced_mint",
                    "renounced_freeze_account",
                    "top_10_holder_rate",
                    "creator_balance_rate",
                    "bundler_trader_amount_rate",
                    "smart_degen_count",
                    "renowned_count",
                    "liquidity",
                    "usd_market_cap",
                ]
                    .filter((k) => row[k] !== undefined)
                    .map((k) => [k, row[k]]));
                result.push({
                    discovery: {
                        sources: ["SNIPER"],
                        firstSeenAt: now,
                        lastSeenAt: now,
                        sniper: { firstSeenAt: now, lastSeenAt: now },
                    },
                    mint,
                    symbol: optionalText(row.symbol, 32),
                    name: optionalText(row.name),
                    logo: normalizeTokenLogo(row.logo),
                    source: "gmgn:" + String(row.launchpad_platform ?? category),
                    discoveredAt: now,
                    createdAt: created.state === "KNOWN" && created.value > 0
                        ? created.value * 1000
                        : undefined,
                    listing: { ...listing, logo: normalizeTokenLogo(row.logo) },
                });
            }
            catch {
                /* A malformed individual row is not a candidate. */
            }
        }
    }
    return result;
}
export function parseTrending(raw, interval = "5m", now = Date.now()) {
    const envelope = record(raw), data = record(envelope.data ?? envelope);
    if (typeof record(envelope._gmgnSnapshot).fetchedAt === "number")
        now = Number(record(envelope._gmgnSnapshot).fetchedAt);
    if (envelope.code !== undefined && envelope.code !== 0)
        throw new ProviderFailure("GMGN_TRENDING_RESPONSE_ERROR", "GMGN_TRENDING");
    if (!Array.isArray(data.rank))
        throw new ProviderFailure("GMGN_TRENDING_SCHEMA_INVALID", "GMGN_TRENDING");
    const candidates = [];
    for (const value of data.rank.slice(0, 100)) {
        const row = record(value);
        try {
            const mint = address(z.string().parse(row.address)), created = numberEvidence(row.creation_timestamp);
            const rank = typeof row.rank === "number" &&
                Number.isInteger(row.rank) &&
                row.rank > 0
                ? row.rank
                : undefined;
            candidates.push({
                mint,
                symbol: optionalText(row.symbol, 32),
                name: optionalText(row.name),
                logo: normalizeTokenLogo(row.logo),
                source: "gmgn:trending",
                discoveredAt: now,
                createdAt: created.state === "KNOWN" && created.value > 0
                    ? created.value * 1000
                    : undefined,
                listing: {
                    ...row,
                    logo: normalizeTokenLogo(row.logo),
                    price: {
                        price: row.price,
                        ["volume_" + interval]: row.volume,
                        ["buys_" + interval]: row.buys,
                        ["sells_" + interval]: row.sells,
                    },
                },
                discovery: {
                    sources: ["TRENDING"],
                    firstSeenAt: now,
                    lastSeenAt: now,
                    trending: {
                        firstSeenAt: now,
                        lastSeenAt: now,
                        sequenceStartedAt: now,
                        consecutiveObservations: 1,
                        rank,
                        basis: `sol:${interval}:volume:desc:renounced,frozen`,
                        history: rank === undefined ? [] : [{ at: now, rank }],
                        movement: "UNKNOWN",
                    },
                },
            });
        }
        catch {
            /* malformed individual mint never enters discovery */
        }
    }
    return candidates;
}
export function normalizeMarket(raw) {
    const i = object.parse(raw), p = record(i.price), pool = record(i.pool);
    const price = numberEvidence(p.price), supply = numberEvidence(i.circulating_supply);
    return {
        at: typeof record(i._gmgnSnapshot).fetchedAt === "number"
            ? Number(record(i._gmgnSnapshot).fetchedAt)
            : Date.now(),
        price,
        priceUsd: price.state === "KNOWN" ? String(p.price) : undefined,
        decimals: typeof i.decimals === "number" &&
            Number.isInteger(i.decimals) &&
            i.decimals >= 0 &&
            i.decimals <= 18
            ? i.decimals
            : undefined,
        liquidity: numberEvidence(i.liquidity ?? pool.liquidity),
        marketCap: numberEvidence(i.usd_market_cap ?? i.market_cap).state === "KNOWN"
            ? numberEvidence(i.usd_market_cap ?? i.market_cap)
            : price.state === "KNOWN" && supply.state === "KNOWN"
                ? known(price.value * supply.value)
                : unknown(),
        volume: numberEvidence(p.volume_24h),
        buys: numberEvidence(p.buys_24h),
        sells: numberEvidence(p.sells_24h),
        windows: Object.fromEntries(["1m", "5m", "1h", "6h", "24h"]
            .filter((w) => [
            "price_",
            "volume_",
            "buy_volume_",
            "sell_volume_",
            "buys_",
            "sells_",
        ].some((prefix) => p[prefix + w] !== undefined))
            .map((w) => [
            w,
            {
                startPrice: numberEvidence(p["price_" + w]),
                volume: numberEvidence(p["volume_" + w]),
                buys: numberEvidence(p["buys_" + w]),
                sells: numberEvidence(p["sells_" + w]),
                buyVolume: numberEvidence(p["buy_volume_" + w]),
                sellVolume: numberEvidence(p["sell_volume_" + w]),
            },
        ])),
    };
}
export function normalizeSecurity(raw, c, s) {
    const r = object.parse(raw), listing = c.listing ?? {};
    const listingAt = c.discovery?.lastSeenAt ?? c.discoveredAt;
    const endpointAt = Number(record(r._gmgnSnapshot).fetchedAt ?? Date.now());
    const currentListing = Date.now() - listingAt >= 0 && Date.now() - listingAt <= s.maxSnapshotAgeMs;
    const mintRenounced = bool(r.renounced_mint ?? (currentListing ? listing.renounced_mint : undefined)), freezeRenounced = bool(r.renounced_freeze_account ??
        (currentListing ? listing.renounced_freeze_account : undefined));
    // A known security endpoint supersedes advisory listing evidence. UNKNOWN
    // cannot erase a still-current listing warning; expired listings authorize nothing.
    const endpointRug = numberEvidence(r.rug_ratio);
    const suppliedRugRatio = endpointRug.state === "KNOWN" &&
        endpointRug.value <= 1 &&
        (!currentListing ||
            endpointAt >= listingAt ||
            endpointRug.value >= s.criticalRugRatio)
        ? endpointRug
        : currentListing
            ? numberEvidence(listing.rug_ratio)
            : unknown("Listing rug evidence has expired");
    const rugRatio = suppliedRugRatio.state === "KNOWN" && suppliedRugRatio.value <= 1
        ? suppliedRugRatio
        : unknown("GMGN rug-risk ratio is unavailable");
    const findings = [];
    for (const [code, evidence, label] of [
        ["MINT_CONTROL", mintRenounced, "mint supply"],
        ["FREEZE_CONTROL", freezeRenounced, "token transfers"],
    ]) {
        if (evidence.state === "KNOWN" && !evidence.value)
            findings.push({
                level: "CRITICAL",
                code,
                reason: `GMGN reports active control over ${label}`,
            });
        else if (evidence.state === "UNKNOWN")
            findings.push({
                level: "UNKNOWN",
                code,
                reason: `GMGN has not verified control over ${label}`,
            });
    }
    // Solana's null/empty honeypot field is explicitly not applicable in the installed skill.
    if ([r.is_honeypot, r.honeypot, r.can_not_sell].some((v) => [true, 1, "1", "true", "yes"].includes(v)))
        findings.push({
            level: "CRITICAL",
            code: "HONEYPOT_REPORTED",
            reason: "GMGN explicitly reports an inability to sell",
        });
    if (rugRatio.state === "KNOWN" && rugRatio.value <= 1) {
        if (rugRatio.value >= s.criticalRugRatio)
            findings.push({
                level: "CRITICAL",
                code: "GMGN_RUG_RISK",
                reason: "GMGN rug-risk label exceeds the configured critical threshold",
            });
        else if (rugRatio.value > s.warningRugRatio)
            findings.push({
                level: "WARNING",
                code: "GMGN_RUG_WARNING",
                reason: "GMGN reports elevated rug risk",
            });
    }
    for (const field of ["buy_tax", "sell_tax"]) {
        const tax = percent(r[field]);
        if (tax.state === "KNOWN" && tax.value > s.maxTaxPercent)
            findings.push({
                level: "CRITICAL",
                code: "EXCESSIVE_TAX",
                reason: `GMGN ${field} exceeds the configured tax limit`,
            });
    }
    const safe = Object.fromEntries([
        "renounced_mint",
        "renounced_freeze_account",
        "is_honeypot",
        "rug_ratio",
        "buy_tax",
        "sell_tax",
        "top_10_holder_rate",
        "creator_balance_rate",
        "dev_team_hold_rate",
        "burn_status",
        "is_wash_trading",
    ]
        .filter((k) => r[k] !== undefined)
        .map((k) => [k, r[k]]));
    return {
        at: typeof record(r._gmgnSnapshot).fetchedAt === "number"
            ? Number(record(r._gmgnSnapshot).fetchedAt)
            : Date.now(),
        findings,
        mintRenounced,
        freezeRenounced,
        rugRatio,
        raw: {
            ...safe,
            rugEvidence: {
                source: suppliedRugRatio === endpointRug ? "token-security" : "listing",
                fetchedAt: suppliedRugRatio === endpointRug
                    ? Number(record(r._gmgnSnapshot).fetchedAt ?? Date.now())
                    : listingAt,
                policy: "KNOWN_ENDPOINT_SUPERSEDES_LISTING_UNKNOWN_RETAINS_CURRENT_WARNING",
            },
        },
    };
}
export function normalizeIntelligence(info, security, c, holderRaw, history) {
    const i = record(info), stat = record(i.stat), dev = record(i.dev), tags = record(i.wallet_tags_stat), listing = c.listing ?? {};
    const populated = [
        "creator_hold_rate",
        "top_bundler_trader_percentage",
        "top70_sniper_hold_rate",
        "top_rat_trader_percentage",
        "top_entrapment_trader_percentage",
        "bot_degen_rate",
        "fresh_wallet_rate",
        "private_vault_hold_rate",
        "creator_created_count",
        "top_10_holder_rate",
    ].some((k) => Number(stat[k]) > 0);
    const rows = Array.isArray(record(holderRaw).list)
        ? record(holderRaw).list
        : [];
    const normal = rows
        .map(record)
        .filter((r) => r.addr_type === 0 && r.address !== c.mint)
        .map((r) => percent(r.amount_percentage))
        .filter((r) => r.state === "KNOWN")
        .sort((a, b) => b.value - a.value);
    const top10 = percent(firstPositive(security.raw.top_10_holder_rate, listing.top_10_holder_rate, populated ? stat.top_10_holder_rate : undefined));
    const findings = [...security.findings];
    const count = numberEvidence(i.holder_count);
    const holderCount = count.state === "KNOWN" && count.value > 0 ? count : unknown();
    const creatorPercent = percent(firstPositive(listing.creator_balance_rate, security.raw.creator_balance_rate, populated ? stat.creator_hold_rate : undefined));
    return {
        riskEvidence: record(info)._gmgnSnapshot || record(holderRaw)._gmgnSnapshot
            ? {
                fetchedAt: Number(record(record(holderRaw)._gmgnSnapshot).fetchedAt ?? 0),
                freshness: String(record(record(holderRaw)._gmgnSnapshot).freshness ?? "UNKNOWN"),
                authority: "BUY_AUTHORIZING",
            }
            : undefined,
        holders: {
            count: holderCount,
            top1: normal.length ? normal[0] : unknown(),
            top10: top10.state === "KNOWN"
                ? top10
                : normal.length >= 10
                    ? known(normal.slice(0, 10).reduce((n, r) => n + r.value, 0))
                    : unknown(),
            rows: rows.slice(0, 20).map((v) => {
                const r = record(v);
                return {
                    address: r.address,
                    addr_type: r.addr_type,
                    amount_percentage: r.amount_percentage,
                    maker_token_tags: r.maker_token_tags,
                };
            }),
        },
        creator: {
            address: optionalText(dev.creator_address, 44),
            holdPercent: creatorPercent,
            history: history === undefined ? unknown() : known(history),
        },
        bundlePercent: percent(populated
            ? stat.top_bundler_trader_percentage
            : listing.bundler_trader_amount_rate),
        sniperPercent: percent(populated ? stat.top70_sniper_hold_rate : undefined),
        smartMoney: numberEvidence(tags.smart_wallets ?? listing.smart_degen_count),
        kol: numberEvidence(tags.renowned_wallets ?? listing.renowned_count),
        dueDiligence: {
            source: "Installed gmgn-contract-dd evidence; no composite score endpoint exists",
            score: unknown("The installed score is an agent-derived report, not an API response"),
            findings,
        },
    };
}
export class Gmgn {
    runner;
    feedObservations = new Map();
    rememberFeed(rows, source, fetchedAt) {
        for (const value of rows) {
            const row = record(value);
            if (typeof row.address !== "string")
                continue;
            const price = record(row.price);
            const snapshot = Object.fromEntries([
                "address",
                "symbol",
                "liquidity",
                "market_cap",
                "usd_market_cap",
                "holder_count",
            ]
                .filter((k) => row[k] !== undefined)
                .map((k) => [k, row[k]]));
            snapshot.price = Object.fromEntries([
                "price",
                ...["1m", "5m", "1h", "6h", "24h"].flatMap((w) => [
                    "price_",
                    "volume_",
                    "buy_volume_",
                    "sell_volume_",
                    "buys_",
                    "sells_",
                ].map((k) => k + w)),
            ]
                .filter((k) => price[k] !== undefined)
                .map((k) => [k, price[k]]));
            snapshot._gmgnSnapshot = {
                provider: "GMGN",
                source,
                fetchedAt,
                freshness: "FRESH",
                ageMs: 0,
            };
            const oldAt = Number(record(this.feedObservations.get(row.address)?._gmgnSnapshot)
                .fetchedAt ?? 0);
            if (oldAt > fetchedAt)
                continue;
            // Replace the whole snapshot; never merge an old directional field into a new missing field.
            this.feedObservations.delete(row.address);
            this.feedObservations.set(row.address, snapshot);
        }
        while (this.feedObservations.size > 300)
            this.feedObservations.delete(this.feedObservations.keys().next().value);
    }
    feedObservation(mint) {
        const value = this.feedObservations.get(mint);
        return value ? structuredClone(value) : undefined;
    }
    feedFetchedAt = {};
    feedCacheMs = { SNIPER: 15000, TRENDING: 30000 };
    health = { state: "UNKNOWN", at: 0 };
    unavailable = new Set();
    policy = {
        concurrency: 3,
        intervalMs: 2000,
        baseBackoffMs: 10000,
        maxBackoffMs: 300000,
        maxQueue: 200,
    };
    coordinator;
    constructor(runner) {
        this.runner = runner;
        this.coordinator = new GmgnCoordinator(() => ({
            ...this.policy,
            intervalMs: this.runner ? 0 : this.policy.intervalMs,
        }), undefined, undefined, undefined, this.runner
            ? undefined
            : new GmgnProviderState(fileURLToPath(new URL("../data/gmgn-provider.sqlite", import.meta.url))));
    }
    configure(s) {
        this.feedCacheMs = {
            SNIPER: Math.floor(s.sniperPollMs / 2),
            TRENDING: Math.floor(s.trendingPollMs / 2),
        };
        this.policy = {
            concurrency: s.gmgnReadConcurrency,
            intervalMs: s.gmgnRequestIntervalMs,
            baseBackoffMs: s.gmgnBackoffBaseMs,
            maxBackoffMs: s.gmgnBackoffMaxMs,
            maxQueue: s.gmgnQueueMaxSize,
        };
    }
    async run(args, cacheMs = 0, options = {}) {
        const command = args
            .slice(0, args[0] === "order" && args[1] === "strategy"
            ? 3
            : args[0] === "swap"
                ? 1
                : 2)
            .join(":");
        if (![
            "market:trenches",
            "market:search",
            "market:trending",
            "market:kline",
            "token:info",
            "token:security",
            "token:holders",
            "portfolio:created-tokens",
            "portfolio:activity",
            "portfolio:holdings",
            "track:smartmoney",
        ].includes(command))
            throw new Blocked("Unsupported GMGN command; this bot is single-wallet Solana only");
        const write = false;
        if (args.includes("--chain") && args[args.indexOf("--chain") + 1] !== "sol")
            throw new Blocked("Only Solana is supported");
        const capability = args.slice(0, 2).join(":");
        if (this.unavailable.has(capability))
            throw new Blocked("GMGN_PLAN_UPGRADE_REQUIRED");
        const key = capability + ":" + gmgnRequestKey(args);
        return this.coordinator.read(key, cacheMs, async () => {
            const at = Date.now();
            try {
                if (!this.runner && !env.GMGN_API_KEY)
                    throw new Blocked("MISSING_GMGN_API_KEY");
                const data = this.runner
                    ? await this.runner(args, write)
                    : await new Promise((resolve, reject) => {
                        execFile(process.execPath, [
                            ...(!existsSync(new URL("./gmgn-fetch-metadata.js", import.meta.url))
                                ? ["--import", "tsx"]
                                : []),
                            "--import",
                            new URL(existsSync(new URL("./gmgn-fetch-metadata.js", import.meta.url))
                                ? "./gmgn-fetch-metadata.js"
                                : "./gmgn-fetch-metadata.ts", import.meta.url).href,
                            require.resolve("gmgn-cli"),
                            ...args,
                            "--raw",
                        ], {
                            env: {
                                PATH: process.env.PATH,
                                SystemRoot: process.env.SystemRoot,
                                USERPROFILE: process.env.USERPROFILE,
                                HOME: process.env.HOME,
                                TEMP: process.env.TEMP,
                                TMP: process.env.TMP,
                                GMGN_API_KEY: env.GMGN_API_KEY,
                                GMGN_PRIVATE_KEY: gmgnSigningKey(),
                                GMGN_DEBUG: "",
                                GMGN_ALLOW_AUTOMATED_TRADES: "0",
                                GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS: "0",
                            },
                            timeout: 20000,
                            maxBuffer: 4 * 1024 * 1024,
                            windowsHide: true,
                        }, (err, stdout, stderr) => {
                            if (err) {
                                const code = [
                                    "PLAN_UPGRADE_REQUIRED",
                                    "ERROR_RATE_LIMIT_BLOCKED",
                                    "RATE_LIMIT_BANNED_MAX",
                                    "RATE_LIMIT_BANNED",
                                    "RATE_LIMIT_EXCEEDED",
                                ].find((c) => stderr.includes(c));
                                if (code === "PLAN_UPGRADE_REQUIRED") {
                                    this.unavailable.add(capability);
                                    reject(new ProviderFailure("GMGN_PLAN_UPGRADE_REQUIRED", "GMGN", false));
                                }
                                else if (code?.includes("RATE_LIMIT") ||
                                    stderr.includes("GMGN_RATE_METADATA:") ||
                                    /status[=: ]+429|HTTP 429/.test(stderr)) {
                                    const delays = [
                                        transportRetryDelay(stderr),
                                        retryDelay(stderr),
                                    ].filter((v) => v !== undefined);
                                    const delay = delays.length
                                        ? Math.max(...delays)
                                        : undefined;
                                    reject(new GmgnRateLimited(code === "RATE_LIMIT_BANNED_MAX"
                                        ? Math.max(300000, delay ?? 0)
                                        : delay));
                                }
                                else if (/status[=: ]+(401|403)|HTTP (401|403)/.test(stderr))
                                    reject(new ProviderFailure("GMGN_AUTHORIZATION_FAILED", "GMGN", false));
                                else
                                    reject(new ProviderFailure("GMGN_COMMAND_FAILED", "GMGN"));
                                return;
                            }
                            try {
                                resolve(JSON.parse(stdout));
                            }
                            catch {
                                reject(new ProviderFailure("GMGN_INVALID_JSON", "GMGN"));
                            }
                        });
                    });
                const raw = record(data);
                if (["market:trending", "market:trenches", "token:security"].includes(capability) &&
                    Array.isArray(data))
                    throw new ProviderFailure("GMGN_INVALID_RESPONSE", "GMGN");
                if (capability === "market:trending")
                    parseTrending(data);
                if (capability === "market:trenches")
                    parseDiscovery(data);
                if (capability === "token:info" &&
                    (raw.address !== args[args.indexOf("--address") + 1] || !raw.symbol))
                    throw new CandidateRejected("TOKEN_DATA_INCOMPLETE", {
                        reason: "GMGN_TOKEN_RECORD_UNAVAILABLE",
                    });
                if (data === null ||
                    typeof data !== "object" ||
                    raw.error ||
                    (typeof raw.code === "number" && raw.code !== 0))
                    throw new ProviderFailure("GMGN_INVALID_RESPONSE", "GMGN");
                this.health = {
                    state: "READY",
                    at: Date.now(),
                    latencyMs: Date.now() - at,
                };
                return data;
            }
            catch (error) {
                this.health = {
                    state: "BLOCKED",
                    at: Date.now(),
                    reason: error instanceof Blocked ? error.code : "GMGN_UNAVAILABLE",
                };
                throw error;
            }
        }, options);
    }
    async discover() {
        const raw = await this.run(["market", "trenches", "--chain", "sol"], this.feedCacheMs.SNIPER, {
            priority: 4,
            consumer: "sniper-discovery",
        });
        this.feedFetchedAt.SNIPER =
            Number(record(record(raw)._gmgnSnapshot).fetchedAt) || Date.now();
        const result = parseDiscovery(raw), r = record(raw);
        this.rememberFeed(["new_creation", "near_completion", "pump", "completed"].flatMap((k) => Array.isArray(r[k]) ? r[k] : []), "SNIPER", this.feedFetchedAt.SNIPER);
        return result;
    }
    async trending(interval = "5m", limit = 100) {
        const raw = await this.run([
            "market",
            "trending",
            "--chain",
            "sol",
            "--interval",
            interval,
            "--order-by",
            "volume",
            "--direction",
            "desc",
            "--limit",
            String(limit),
        ], this.feedCacheMs.TRENDING, { priority: 2, consumer: "trending-discovery" });
        this.feedFetchedAt.TRENDING =
            Number(record(record(raw)._gmgnSnapshot).fetchedAt) || Date.now();
        const result = parseTrending(raw, interval);
        const rows = record(record(raw).data).rank;
        this.rememberFeed(Array.isArray(rows) ? rows : [], "TRENDING", this.feedFetchedAt.TRENDING);
        return result;
    }
    async info(mint, cacheMs = 10000, options = {}) {
        const data = await this.run(["token", "info", "--chain", "sol", "--address", address(mint)], cacheMs, options);
        const i = record(data);
        if (i.address !== mint || !i.symbol)
            throw new CandidateRejected("TOKEN_DATA_INCOMPLETE", {
                mint,
                reason: "GMGN_TOKEN_RECORD_UNAVAILABLE",
            });
        return data;
    }
    async marketHistory(c, cacheMs = 0, options = { priority: 4, consumer: "candidate-history" }) {
        const now = cacheMs ? Math.floor(Date.now() / 60000) * 60000 : Date.now();
        return this.run([
            "market",
            "kline",
            "--chain",
            "sol",
            "--address",
            address(c.mint),
            "--resolution",
            "1m",
            "--from",
            String(Math.floor((now - 3600000) / 1000)),
            "--to",
            String(Math.floor(now / 1000)),
        ], cacheMs, options);
    }
    async security(c, s, options = {}, fresh = false) {
        return normalizeSecurity(await this.run(["token", "security", "--chain", "sol", "--address", address(c.mint)], fresh || options.consumer === "pre-buy" ? 0 : 10000, { priority: 1, consumer: "security", ...options }), c, s);
    }
    async intelligence(c, info, sec, s, authoritative = false) {
        let holders, history;
        try {
            holders = await this.run([
                "token",
                "holders",
                "--chain",
                "sol",
                "--address",
                c.mint,
                "--limit",
                "20",
            ], authoritative ? 0 : s.intelligenceCacheMs, {
                priority: authoritative ? 1 : 5,
                consumer: "holder-enrichment",
                staleMs: authoritative ? 0 : s.intelligenceCacheMs * 2,
            });
        }
        catch (error) {
            if (authoritative)
                throw error;
            /* Optional account coverage is retained as UNKNOWN. */
        }
        const creator = record(record(info).dev).creator_address;
        if (!authoritative && typeof creator === "string") {
            try {
                history = await this.run([
                    "portfolio",
                    "created-tokens",
                    "--chain",
                    "sol",
                    "--wallet",
                    address(creator),
                ], s.intelligenceCacheMs, {
                    priority: 5,
                    consumer: "creator-enrichment",
                    staleMs: s.intelligenceCacheMs * 2,
                });
            }
            catch {
                /* Creator history is optional. */
            }
        }
        return normalizeIntelligence(info, sec, c, holders, history);
    }
    advisoryIntelligence(c, info, sec, s) {
        const args = [
            "token",
            "holders",
            "--chain",
            "sol",
            "--address",
            c.mint,
            "--limit",
            "20",
        ];
        return normalizeIntelligence(info, sec, c, this.coordinator.peek("token:holders:" + gmgnRequestKey(args), s.intelligenceCacheMs));
    }
    async smartMoneyFeed(cacheMs = 0, options = {}) {
        // Same bounded provider snapshot for all tokens; token filtering is local.
        // Candidate calls use TTL0. Position cache is provider data, never a verdict.
        try {
            return normalizeSmartMoney(await this.run(["track", "smartmoney", "--chain", "sol", "--limit", "100"], cacheMs, { priority: 5, consumer: "smart-money-evidence", ...options }), 100);
        }
        catch {
            // Shared coordinator still enforces cooldown; optional absence cannot halt entry.
            return unavailableSmartMoney();
        }
    }
    async smartMoneyExits(mint, since) {
        const data = await this.smartMoneyFeed(30000);
        return data.events
            .filter((r) => r.mint === mint &&
            r.side === "sell" &&
            r.timestamp !== null &&
            r.timestamp >= since)
            .map((r) => ({
            signature: r.transactionHash,
            at: r.timestamp,
            side: "sell",
            amountUsd: numberEvidence(r.amountUsd),
        }));
    }
    holdings(wallet) {
        return this.run([
            "portfolio",
            "holdings",
            "--chain",
            "sol",
            "--wallet",
            address(wallet),
            "--limit",
            "50",
        ]);
    }
}
