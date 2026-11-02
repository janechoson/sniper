import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import {
  normalizeMarket,
  normalizeSecurity,
  record,
  numberEvidence,
  parseTrending,
} from "./gmgn.js";
import { cheapGuard } from "./risk.js";
import { defaultSettings, type Settings } from "./config.js";
import type { Candidate } from "./domain.js";
import { parseMarketHistory, attemptFlow } from "./market-history.js";
import { inspectMint, requireCompatibleToken } from "./token-program.js";
import {
  validateCandles,
  type LabCandle,
  type LabPrice,
} from "./kronos-domain.js";
export interface LabMarket {
  discover(): Promise<Candidate[]>;
  discoveryMetadata?():
    | { fetchedAt: number; rawReceivedCount: number }
    | undefined;
  retryAt?(): number;
  prepare(
    c: Candidate,
    stage: (name: string, work: () => Promise<unknown>) => Promise<unknown>,
  ): Promise<{ candles: LabCandle[]; evidence: unknown }>;
  history(c: Candidate): Promise<{ candles: LabCandle[]; evidence: unknown }>;
  price(mint: string): Promise<LabPrice | undefined>;
}
/** Fixed GET-only GMGN routes and a single read-only RPC method. No CLI/signing. */
export class KronosMarket implements LabMarket {
  private next = 0;
  private tail: Promise<void> = Promise.resolve();
  private requests = 0;
  private cooldown = 0;
  private lastDiscovery?: { fetchedAt: number; rawReceivedCount: number };
  private gmgnHealth: { state: string; at: number; error?: string } = {
    state: "UNKNOWN",
    at: 0,
  };
  private rpcHealth: { state: string; at: number; error?: string } = {
    state: "UNKNOWN",
    at: 0,
  };

  constructor(
    private apiKey: string,
    private rpcUrl = "https://api.mainnet-beta.solana.com",
    private settings: Settings = defaultSettings(),
  ) {}
  private async json(url: string, init: RequestInit = {}) {
    const r = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(20000),
      redirect: "error",
    });
    if (!r.ok) {
      if (r.status === 429) this.cooldown = Date.now() + 120000;
      throw Error("LAB_PUBLIC_PROVIDER_HTTP_" + r.status);
    }
    const text = await r.text();
    if (text.length > 4 * 1024 * 1024)
      throw Error("LAB_PROVIDER_RESPONSE_TOO_LARGE");
    return JSON.parse(text);
  }
  private async gmgn(route: string, query: Record<string, string | number>) {
    const prior = this.tail;
    let unlock!: () => void;
    this.tail = new Promise<void>((r) => {
      unlock = r;
    });
    await prior;
    try {
      const result = await this.readGmgn(route, query);
      this.gmgnHealth = { state: "OK", at: Date.now() };
      return result;
    } catch (error) {
      this.gmgnHealth = {
        state: Date.now() < this.cooldown ? "RATE_LIMITED" : "ERROR",
        at: Date.now(),
        error:
          error instanceof Error
            ? error.message.replace(/[^A-Z0-9_]/g, "").slice(0, 80)
            : "PROVIDER_ERROR",
      };
      throw error;
    } finally {
      unlock();
    }
  }
  private async readGmgn(
    route: string,
    query: Record<string, string | number>,
  ) {
    if (
      ![
        "/v1/token/info",
        "/v1/token/security",
        "/v1/market/token_kline",
        "/v1/market/rank",
      ].includes(route)
    )
      throw Error("LAB_READ_ROUTE_DENIED");
    if (!this.apiKey) throw Error("KRONOS_GMGN_API_KEY_REQUIRED");
    if (Date.now() < this.cooldown) throw Error("LAB_PROVIDER_COOLDOWN");
    await new Promise((r) =>
      setTimeout(r, Math.max(0, this.next - Date.now())),
    );
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
    if (response.code !== 0) throw Error("LAB_GMGN_RESPONSE_REJECTED");
    return {
      ...record(response.data),
      _gmgnSnapshot: { fetchedAt: Date.now(), freshness: "FRESH" },
    };
  }
  async discover() {
    // Independent bounded GMGN discovery; no BOT bridge or shared runtime.
    const raw = await this.gmgn("/v1/market/rank", {
      interval: "5m",
      order_by: "volume",
      direction: "desc",
      limit: 50,
    });
    const fetchedAt = Number(record(raw._gmgnSnapshot).fetchedAt);
    const rank = record(raw).rank;
    this.lastDiscovery = {
      fetchedAt,
      rawReceivedCount: Array.isArray(rank) ? rank.length : 0,
    };
    const candidates = parseTrending(raw, "5m").slice(0, 50);
    for (const c of candidates) {
      const listing = record(c.listing),
        value = listing.sequenceStartedAt ?? listing.sequence_started_at;
      const n = typeof value === "number" ? value : NaN;
      const sequence = n > 0 && n < 1e12 ? n * 1000 : n;
      const t = c.discovery!.trending!;
      if (Number.isFinite(sequence) && sequence > 0 && sequence <= fetchedAt) {
        t.sequenceStartedAt = sequence;
        t.sequenceOrigin = "PROVIDER";
      } else t.sequenceOrigin = "LOCAL_SNAPSHOT";
    }
    return candidates;
  }
  discoveryMetadata() {
    return this.lastDiscovery;
  }
  retryAt() {
    return this.cooldown;
  }
  async history(c: Candidate) {
    const now = Date.now(),
      raw = await this.gmgn("/v1/market/token_kline", {
        address: c.mint,
        resolution: "1m",
        from: now - 3600000,
        to: now,
      });
    const h = parseMarketHistory(raw, c),
      candles = h.candles.slice(-60).map(({ at, open, high, low, close }) => ({
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
  async prepare(
    c: Candidate,
    stage: (name: string, work: () => Promise<unknown>) => Promise<unknown>,
  ) {
    let info: Record<string, unknown> = {};
    await stage("CHEAP_FILTER", async () => {
      info = await this.gmgn("/v1/token/info", { address: c.mint });
      const created = numberEvidence(info.creation_timestamp);
      if (!c.createdAt && created.state === "KNOWN")
        c = { ...c, createdAt: created.value * 1000 };
      const result = cheapGuard(c, normalizeMarket(info), this.settings);
      if (!result.allowed) throw Error(result.reason);
      const liquidity = normalizeMarket(info).liquidity;
      if (
        liquidity.state !== "KNOWN" ||
        liquidity.value < this.settings.minLiquidityUsd
      )
        throw Error("Liquidity is below the configured entry policy");
      return {
        ...result,
        market: normalizeMarket(info),
        metadata: {
          holders: numberEvidence(info.holder_count),
          createdAt: c.createdAt,
        },
      };
    });
    await stage("SECURITY", async () => {
      const sec = normalizeSecurity(
        await this.gmgn("/v1/token/security", { address: c.mint }),
        c,
        this.settings,
      );
      if (
        sec.findings.some((f) => f.level === "CRITICAL") ||
        sec.mintRenounced.state !== "KNOWN" ||
        !sec.mintRenounced.value ||
        sec.freezeRenounced.state !== "KNOWN" ||
        !sec.freezeRenounced.value
      )
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
      }).catch((error) => {
        this.rpcHealth = { state: "ERROR", at: Date.now() };
        throw error;
      });
      const a = raw.result?.value;
      if (!a || raw.error) {
        this.rpcHealth = { state: "ERROR", at: Date.now() };
        throw Error("LAB_RPC_MINT_UNAVAILABLE");
      }
      this.rpcHealth = { state: "OK", at: Date.now() };
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
    let h: Awaited<ReturnType<KronosMarket["history"]>> | undefined;
    await stage("HISTORY", async () => {
      h = await this.history(c);
      return h.evidence;
    });
    await stage("CAPITAL_FLOW", async () => {
      const f = attemptFlow(
        c,
        normalizeMarket(info),
        info,
        h!.evidence as ReturnType<typeof parseMarketHistory>,
        this.settings.flowMeaningfulChangePercent,
      );
      if (f.quality.status !== "READY")
        throw Error("LAB_FLOW_INPUT_UNAVAILABLE");
      return f;
    });
    return h!;
  }
  async price(mint: string) {
    const m = normalizeMarket(
      await this.gmgn("/v1/token/info", { address: mint }),
    );
    return m.price.state === "KNOWN" && m.price.value > 0
      ? {
          value: m.price.value,
          observedAt: m.at,
          source: "GMGN_TOKEN_INFO" as const,
        }
      : undefined;
  }
  status() {
    return {
      requests: this.requests,
      gmgn: {
        ...this.gmgnHealth,
        state:
          Date.now() < this.cooldown ? "RATE_LIMITED" : this.gmgnHealth.state,
      },
      rpc: this.rpcHealth,
      cooldownUntil: this.cooldown,
      spacingMs: 3000,
      discovery: "INDEPENDENT_GMGN_TRENDING_50_BATCH_EXHAUSTED_OR_5M",
    };
  }
}
