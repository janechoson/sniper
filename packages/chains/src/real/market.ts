import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  isAddress,
  type Address,
} from "viem";
import { z } from "zod";
import type {
  NormalizedTokenState,
  TokenDiscoveryEvent,
  FeatureEvidence,
} from "@sniper/core";
import type { TrustedQuoteAsset } from "@sniper/config";
import { parseUnitsSafe, ratioToNumber, toDisplayNumber } from "@sniper/shared";
import { JsonRpcClient } from "../rpc/http";
import { hexSchema, EvmTokenAnalyzer } from "../security/evm";
import type { QuoteUsdPriceProvider } from "./prices";
export interface MarketObservation {
  at: number;
  priceUsd?: number;
  liquidityUsd?: number;
  trade?: {
    id: string;
    side: "BUY" | "SELL";
    volumeUsd?: number;
    quoteAmount?: string;
    wallet?: string;
  };
}
export class RollingMarketBook {
  reset(key: string) {
    this.pools.delete(key);
    this.completeSince.delete(key);
    this.completeThrough.delete(key);
  }
  hasCompleteStream(key: string) {
    return this.completeSince.has(key);
  }
  lastObservedAt(key: string) {
    const values = this.pools.get(key) ?? [];
    return (
      [...values].reverse().find((item) => item.priceUsd !== undefined)?.at ??
      values.at(-1)?.at
    );
  }
  private pools = new Map<string, MarketObservation[]>();
  private completeSince = new Map<string, number>();
  private completeThrough = new Map<string, number>();
  advanceStream(key: string, through: number) {
    if (this.completeSince.has(key)) this.completeThrough.set(key, through);
  }
  constructor(
    private readonly maxPools = 300,
    private readonly maxObservations = 2000,
  ) {}
  startCompleteStream(key: string, at: number) {
    this.completeSince.set(key, at);
  }
  invalidateStream(key: string) {
    this.completeSince.delete(key);
    this.completeThrough.delete(key);
  }
  observe(key: string, observation: MarketObservation) {
    if (!this.pools.has(key) && this.pools.size >= this.maxPools) {
      const oldest = this.pools.keys().next().value!;
      this.pools.delete(oldest);
      this.completeSince.delete(oldest);
      this.completeThrough.delete(oldest);
    }
    const values = this.pools.get(key) ?? [];
    if (
      observation.trade &&
      values.some((item) => item.trade?.id === observation.trade!.id)
    )
      return;
    values.push(structuredClone(observation));
    values.sort((a, b) => a.at - b.at);
    const recent = values
      .filter((item) => item.at >= values.at(-1)!.at - 310000)
      .slice(-this.maxObservations);
    if (values.length > this.maxObservations) this.invalidateStream(key);
    this.pools.set(key, recent);
  }
  features(key: string, now = Date.now()): NormalizedTokenState["market"] {
    const observations = this.pools.get(key) ?? [];
    const latest = [...observations]
      .reverse()
      .find((item) => item.priceUsd !== undefined && now - item.at <= 15000);
    if (!observations.at(-1) || now - observations.at(-1)!.at > 15000)
      return {};
    const output: NormalizedTokenState["market"] = {
      priceUsd: latest?.priceUsd,
      liquidityUsd: latest?.liquidityUsd,
    };
    for (const seconds of [5, 15, 60, 300] as const) {
      const previous = [...observations]
        .reverse()
        .find(
          (item) =>
            item.at <= now - seconds * 1000 && item.priceUsd !== undefined,
        );
      if (
        seconds !== 300 &&
        previous?.priceUsd &&
        latest?.priceUsd &&
        now - seconds * 1000 - previous.at <= 2000
      )
        output[`priceChange${seconds}s`] =
          (latest.priceUsd / previous.priceUsd - 1) * 100;
      if (
        seconds === 15 &&
        previous?.liquidityUsd !== undefined &&
        previous.liquidityUsd > 0 &&
        latest?.liquidityUsd !== undefined &&
        now - seconds * 1000 - previous.at <= 2000
      )
        output.liquidityChange15s =
          (latest.liquidityUsd / previous.liquidityUsd - 1) * 100;
      const since = this.completeSince.get(key);
      const through = this.completeThrough.get(key);
      if (
        since === undefined ||
        through === undefined ||
        through > now + 1000 ||
        now - through > 15000 ||
        since > through - seconds * 1000
      )
        continue;
      output.windowEndAt = through;
      const trades = observations
        .filter(
          (item) =>
            item.at > through - seconds * 1000 &&
            item.at <= through &&
            item.trade,
        )
        .map((item) => item.trade!);
      const sum = (items: typeof trades) =>
        items.every((t) => t.volumeUsd !== undefined)
          ? items.reduce((total, t) => total + t.volumeUsd!, 0)
          : undefined;
      output[`volume${seconds}s`] = sum(trades);
      if (seconds === 5 || seconds === 15) {
        output[`buys${seconds}s`] = trades.filter(
          (t) => t.side === "BUY",
        ).length;
        output[`sells${seconds}s`] = trades.filter(
          (t) => t.side === "SELL",
        ).length;
      }
      if (seconds === 15) {
        output.buyVolume15s = sum(trades.filter((t) => t.side === "BUY"));
        output.sellVolume15s = sum(trades.filter((t) => t.side === "SELL"));
        if (
          output.sellVolume15s !== undefined &&
          output.sellVolume15s > 0 &&
          output.buyVolume15s !== undefined
        )
          output.buySellRatio = output.buyVolume15s / output.sellVolume15s;
        if (trades.every((t) => t.wallet !== undefined)) {
          output.uniqueBuyers = new Set(
            trades.filter((t) => t.side === "BUY").map((t) => t.wallet),
          ).size;
          output.uniqueSellers = new Set(
            trades.filter((t) => t.side === "SELL").map((t) => t.wallet),
          ).size;
        }
      }
    }
    return output;
  }
}
const pairAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
]);
export class EvmV2MarketReader {
  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly analyzer: EvmTokenAnalyzer,
    private readonly quotes: TrustedQuoteAsset[],
    private readonly book: RollingMarketBook,
    private readonly prices?: QuoteUsdPriceProvider,
  ) {}
  async refresh(
    event: TokenDiscoveryEvent,
  ): Promise<NormalizedTokenState["market"]> {
    if (!isAddress(event.poolAddress) || !isAddress(event.tokenAddress))
      throw new Error("INVALID_POOL");
    const pool = event.poolAddress as Address;
    const call = async (name: "token0" | "token1" | "getReserves") =>
      decodeFunctionResult({
        abi: pairAbi,
        functionName: name,
        data: await this.rpc.request(
          "eth_call",
          [
            {
              to: pool,
              data: encodeFunctionData({ abi: pairAbi, functionName: name }),
            },
            "latest",
          ],
          hexSchema,
        ),
      });
    const [zero, one, reserves, token] = await Promise.all([
      call("token0"),
      call("token1"),
      call("getReserves"),
      this.analyzer.analyze(event.tokenAddress),
    ]);
    if (
      typeof zero !== "string" ||
      typeof one !== "string" ||
      !Array.isArray(reserves) ||
      token.info.decimals === undefined
    )
      return {};
    const is0 = zero.toLowerCase() === event.tokenAddress.toLowerCase();
    if (!is0 && one.toLowerCase() !== event.tokenAddress.toLowerCase())
      throw new Error("POOL_TOKEN_MISMATCH");
    const configuredQuote = this.quotes.find(
      (q) => q.address.toLowerCase() === (is0 ? one : zero).toLowerCase(),
    );
    const quote =
      configuredQuote && this.prices
        ? await this.prices.resolve(event.chainId, configuredQuote)
        : configuredQuote;
    if (
      !quote?.usdPrice ||
      !quote.priceSource ||
      quote.priceVerifiedAt === undefined ||
      Date.now() - quote.priceVerifiedAt > 60000
    )
      return {};
    const rawToken = z.bigint().parse(reserves[is0 ? 0 : 1]),
      rawQuote = z.bigint().parse(reserves[is0 ? 1 : 0]);
    if (rawToken === 0n) return {};
    const price = ratioToNumber(
      rawQuote *
        10n ** BigInt(token.info.decimals) *
        parseUnitsSafe(quote.usdPrice, 18),
      rawToken * 10n ** BigInt(quote.decimals) * 10n ** 18n,
    );
    const liquidity = toDisplayNumber(
      rawQuote * 2n * parseUnitsSafe(quote.usdPrice, 18),
      quote.decimals + 18,
    );
    this.book.observe(event.id, {
      at: Date.now(),
      priceUsd: price,
      liquidityUsd: liquidity,
    });
    return this.book.features(event.id);
  }
  evidence(): Record<string, FeatureEvidence> {
    return {
      "market.priceUsd": {
        quality: "REAL",
        source: "RPC getReserves + configured fresh USD quote",
        observedAt: Date.now(),
      },
      "market.liquidityUsd": {
        quality: "ESTIMATED",
        source:
          "2 × quote reserve; excludes transfer fees and executable depth",
        observedAt: Date.now(),
      },
    };
  }
}
