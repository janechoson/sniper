import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  type Address,
} from "viem";
import type { TrustedQuoteAsset } from "@sniper/config";
import { formatUnitsSafe, parseUnitsSafe } from "@sniper/shared";
import { JsonRpcClient } from "../rpc/http";
import { hexSchema } from "../security/evm";
import { resolveCoinbase } from "./coinbase";
export interface QuoteUsdPriceProvider {
  resolve(
    chainId: string,
    asset: TrustedQuoteAsset,
  ): Promise<TrustedQuoteAsset | undefined>;
}
const abi = parseAbi([
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
]);
export class RpcQuoteUsdPriceProvider implements QuoteUsdPriceProvider {
  private cache = new Map<
    string,
    { at: number; expiresAt: number; value: TrustedQuoteAsset }
  >();
  constructor(
    private readonly clients: Map<
      string,
      { rpc: JsonRpcClient; evmChainId: number }
    >,
  ) {}
  async resolve(
    chainId: string,
    asset: TrustedQuoteAsset,
  ): Promise<TrustedQuoteAsset | undefined> {
    if (asset.coinbaseOracle) {
      const key = `coinbase:${chainId}:${asset.address}:${JSON.stringify(asset.coinbaseOracle)}`;
      const prior = this.cache.get(key);
      if (prior && Date.now() - prior.at < 5000 && Date.now() < prior.expiresAt)
        return structuredClone(prior.value);
      try {
        const value = await resolveCoinbase(asset);
        if (!value) return;
        this.cache.set(key, {
          at: Date.now(),
          expiresAt:
            value.priceVerifiedAt + asset.coinbaseOracle.maxAgeSec * 1000,
          value,
        });
        return structuredClone(value);
      } catch {
        return;
      }
    }
    if (!asset.usdOracle) {
      if (
        !asset.usdPrice ||
        !asset.priceSource ||
        asset.priceVerifiedAt === undefined ||
        asset.priceVerifiedAt > Date.now() + 1000 ||
        Date.now() - asset.priceVerifiedAt > 60000 ||
        parseUnitsSafe(asset.usdPrice, 18) <= 0n
      )
        return;
      return structuredClone(asset);
    }
    const oracle = asset.usdOracle;
    const key = `${chainId}:${asset.address}:${JSON.stringify(oracle)}`;
    const cached = this.cache.get(key);
    if (
      cached &&
      Date.now() - cached.at < 10000 &&
      Date.now() <= cached.expiresAt
    )
      return structuredClone(cached.value);
    const client = this.clients.get(oracle.chainId);
    if (!client) return;
    try {
      if (
        BigInt(await client.rpc.request("eth_chainId", [], hexSchema)) !==
        BigInt(client.evmChainId)
      )
        return;
      const address = oracle.address as Address;
      if (
        (await client.rpc.request(
          "eth_getCode",
          [address, "latest"],
          hexSchema,
        )) === "0x"
      )
        return;
      const read = async (
        name: "decimals" | "description" | "latestRoundData",
      ) =>
        decodeFunctionResult({
          abi,
          functionName: name,
          data: await client.rpc.request(
            "eth_call",
            [
              {
                to: address,
                data: encodeFunctionData({ abi, functionName: name }),
              },
              "latest",
            ],
            hexSchema,
          ),
        });
      const [decimals, description, round] = await Promise.all([
        read("decimals"),
        read("description"),
        read("latestRoundData"),
      ]);
      if (
        typeof decimals !== "number" ||
        decimals < 0 ||
        decimals > 18 ||
        description !== oracle.expectedDescription ||
        !Array.isArray(round)
      )
        return;
      const id = round[0],
        answer = round[1],
        updatedAt = round[3],
        answeredInRound = round[4];
      if (
        typeof answer !== "bigint" ||
        answer <= 0n ||
        typeof id !== "bigint" ||
        typeof updatedAt !== "bigint" ||
        typeof answeredInRound !== "bigint" ||
        answeredInRound < id
      )
        return;
      const timestamp = Number(updatedAt) * 1000;
      if (
        !Number.isSafeInteger(timestamp) ||
        timestamp <= 0 ||
        timestamp > Date.now() + 1000 ||
        Date.now() - timestamp > oracle.maxAgeSec * 1000
      )
        return;
      const value = {
        ...asset,
        usdPrice: formatUnitsSafe(answer, decimals),
        priceVerifiedAt: Date.now(),
        priceSource: `REAL_ONCHAIN:${oracle.chainId}:${oracle.address}:round=${id}:updatedAt=${timestamp}`,
        priceObservation: {
          asset: oracle.expectedDescription,
          source: "REAL_ONCHAIN:CHAINLINK",
          sourceChain: oracle.chainId,
          observedAt: timestamp,
          maxAgeMs: oracle.maxAgeSec * 1000,
          status: "VALID" as const,
        },
      };
      if (this.cache.size >= 500)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, {
        at: Date.now(),
        expiresAt: timestamp + oracle.maxAgeSec * 1000,
        value,
      });
      return structuredClone(value);
    } catch {
      return;
    }
  }
}
