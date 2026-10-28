import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  isAddress,
  type Address,
} from "viem";
import type { TokenDiscoveryEvent, NormalizedTokenState } from "@sniper/core";
import type { TrustedQuoteAsset } from "@sniper/config";
import { parseUnitsSafe, ratioToNumber, toDisplayNumber } from "@sniper/shared";
import { JsonRpcClient } from "../rpc/http";
import { EvmTokenAnalyzer, hexSchema } from "../security/evm";
import { RollingMarketBook } from "./market";
import type { QuoteUsdPriceProvider } from "./prices";
const abi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)",
  "function balanceOf(address) view returns (uint256)",
]);
export class EvmV3MarketReader {
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
    const call = async (name: "token0" | "token1" | "slot0") =>
      decodeFunctionResult({
        abi,
        functionName: name,
        data: await this.rpc.request(
          "eth_call",
          [
            { to: pool, data: encodeFunctionData({ abi, functionName: name }) },
            "latest",
          ],
          hexSchema,
        ),
      });
    const [zero, one, slot, token] = await Promise.all([
      call("token0"),
      call("token1"),
      call("slot0"),
      this.analyzer.analyze(event.tokenAddress),
    ]);
    if (
      typeof zero !== "string" ||
      typeof one !== "string" ||
      !Array.isArray(slot) ||
      typeof slot[0] !== "bigint" ||
      token.info.decimals === undefined
    )
      return {};
    const is0 = zero.toLowerCase() === event.tokenAddress.toLowerCase();
    if (!is0 && one.toLowerCase() !== event.tokenAddress.toLowerCase())
      throw new Error("POOL_TOKEN_MISMATCH");
    const configured = this.quotes.find(
      (q) => q.address.toLowerCase() === (is0 ? one : zero).toLowerCase(),
    );
    if (!configured) return {};
    const quote = this.prices
      ? await this.prices.resolve(event.chainId, configured)
      : configured;
    if (
      !quote?.usdPrice ||
      !quote.priceVerifiedAt ||
      Date.now() - quote.priceVerifiedAt > 60000
    )
      return {};
    const square = slot[0] * slot[0];
    if (square === 0n) return {};
    const numerator = is0 ? square : 2n ** 192n,
      denominator = is0 ? 2n ** 192n : square;
    const rawPrice18 =
      (numerator *
        10n ** BigInt(token.info.decimals) *
        parseUnitsSafe(quote.usdPrice, 18)) /
      (denominator * 10n ** BigInt(quote.decimals));
    const price = toDisplayNumber(rawPrice18, 18);
    const balances = await Promise.all(
      [event.tokenAddress, quote.address].map(async (address) =>
        BigInt(
          await this.rpc.request(
            "eth_call",
            [
              {
                to: address,
                data: encodeFunctionData({
                  abi,
                  functionName: "balanceOf",
                  args: [pool],
                }),
              },
              "latest",
            ],
            hexSchema,
          ),
        ),
      ),
    );
    const quantity = toDisplayNumber(balances[0]!, token.info.decimals),
      quoteValue = ratioToNumber(
        balances[1]! * parseUnitsSafe(quote.usdPrice, 18),
        10n ** BigInt(quote.decimals) * 10n ** 18n,
      );
    const liquidity =
      quantity !== undefined && price !== undefined && quoteValue !== undefined
        ? quantity * price + quoteValue
        : undefined;
    this.book.observe(event.id, {
      at: Date.now(),
      priceUsd: price,
      liquidityUsd: liquidity,
    });
    return this.book.features(event.id);
  }
}
