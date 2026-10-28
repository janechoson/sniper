import { parseAbiItem, decodeEventLog, encodeEventTopics } from "viem";
import { z } from "zod";
import type { TokenDiscoveryEvent } from "@sniper/core";
import type { DexDeploymentConfig, TrustedQuoteAsset } from "@sniper/config";
import { parseUnitsSafe, toDisplayNumber } from "@sniper/shared";
import { JsonRpcClient } from "../rpc/http";
import { hexSchema } from "../security/evm";
import { RollingMarketBook } from "./market";
import type { DiscoveryCursorStore } from "./evm-discovery";
const v2 = parseAbiItem(
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
);
const v3 = parseAbiItem(
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
);
const logsSchema = z
  .array(
    z.object({
      address: z.string(),
      data: hexSchema,
      topics: z.array(hexSchema).min(1),
      transactionHash: hexSchema,
      blockNumber: hexSchema,
      blockHash: hexSchema,
      logIndex: hexSchema,
      removed: z.boolean().optional(),
    }),
  )
  .max(2000);
export class EvmSwapObserver {
  private active = new Map<string, Promise<void>>();
  constructor(
    private readonly rpc: JsonRpcClient,
    private readonly book: RollingMarketBook,
    private readonly cursors: DiscoveryCursorStore,
  ) {}
  async poll(
    event: TokenDiscoveryEvent,
    deployment: DexDeploymentConfig,
    quote: TrustedQuoteAsset,
  ) {
    const existing = this.active.get(event.id);
    if (existing) return existing;
    const work = this.collect(event, deployment, quote).finally(() =>
      this.active.delete(event.id),
    );
    this.active.set(event.id, work);
    return work;
  }
  private async collect(
    event: TokenDiscoveryEvent,
    deployment: DexDeploymentConfig,
    quote: TrustedQuoteAsset,
  ) {
    if (!quote.usdPrice) throw new Error("QUOTE_USD_PRICE_UNKNOWN");
    const block = async (number: bigint) =>
      this.rpc.request(
        "eth_getBlockByNumber",
        [`0x${number.toString(16)}`, false],
        z.object({ hash: hexSchema, timestamp: hexSchema }),
      );
    const head =
      BigInt(await this.rpc.request("eth_blockNumber", [], hexSchema)) -
      BigInt(deployment.confirmationDepth);
    if (head < 0n) return;
    const key = `swaps:${event.chainId}:${event.dexId}:${event.poolAddress}`;
    const saved = await this.cursors.readCursor(key);
    const discovery = z
      .object({
        blockNumber: z.string().optional(),
        token0: z.string(),
        token1: z.string(),
      })
      .safeParse(event.rawEvent);
    if (!discovery.success) throw new Error("POOL_ORIENTATION_UNVERIFIED");
    const token0 = discovery.data.token0.toLowerCase();
    const is0 = event.tokenAddress.toLowerCase() === token0;
    const quoteAddress = is0 ? discovery.data.token1 : discovery.data.token0;
    if (quoteAddress.toLowerCase() !== quote.address.toLowerCase())
      throw new Error("POOL_QUOTE_MISMATCH");
    let from =
      saved === undefined ? (head > 32n ? head - 32n : 0n) : BigInt(saved) + 1n;
    const created = discovery.data.blockNumber
      ? BigInt(discovery.data.blockNumber)
      : undefined;
    if (created !== undefined && from < created) from = created;
    if (saved !== undefined) {
      const expected = await this.cursors.readCursor(key + ":hash");
      if (expected && (await block(BigInt(saved))).hash !== expected) {
        this.book.reset(event.id);
        from = head > 32n ? head - 32n : 0n;
      }
    }
    if (from > head) return;
    const to = from + 31n < head ? from + 31n : head;
    const first = await block(from);
    if (!this.book.hasCompleteStream(event.id))
      this.book.startCompleteStream(
        event.id,
        Number(BigInt(first.timestamp)) * 1000,
      );
    const abi = deployment.family === "uniswap-v3" ? v3 : v2;
    const logs = await this.rpc.request(
      "eth_getLogs",
      [
        {
          address: event.poolAddress,
          fromBlock: `0x${from.toString(16)}`,
          toBlock: `0x${to.toString(16)}`,
          topics: encodeEventTopics({ abi: [abi], eventName: "Swap" }),
        },
      ],
      logsSchema,
    );
    if (logs.length === 2000) {
      this.book.invalidateStream(event.id);
      throw new Error("SWAP_RANGE_LIMIT_REQUIRES_SMALLER_WINDOW");
    }
    const blocks = new Map<
      string,
      { hash: `0x${string}`; timestamp: `0x${string}` }
    >([[`0x${from.toString(16)}`, first]]);
    let complete = true;
    for (const log of logs) {
      if (
        log.removed ||
        log.address.toLowerCase() !== event.poolAddress.toLowerCase()
      ) {
        complete = false;
        continue;
      }
      let decoded;
      try {
        decoded = decodeEventLog({
          abi: [abi],
          data: log.data,
          topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
        });
      } catch {
        complete = false;
        continue;
      }
      let side: "BUY" | "SELL" | undefined, quoteAmount: bigint | undefined;
      if ("amount0In" in decoded.args) {
        const a = decoded.args;
        const baseIn = is0 ? a.amount0In : a.amount1In,
          baseOut = is0 ? a.amount0Out : a.amount1Out,
          qIn = is0 ? a.amount1In : a.amount0In,
          qOut = is0 ? a.amount1Out : a.amount0Out;
        if (baseOut > 0n && qIn > 0n && baseIn === 0n && qOut === 0n) {
          side = "BUY";
          quoteAmount = qIn;
        } else if (baseIn > 0n && qOut > 0n && baseOut === 0n && qIn === 0n) {
          side = "SELL";
          quoteAmount = qOut;
        }
      } else {
        const a = decoded.args;
        const base = is0 ? a.amount0 : a.amount1,
          q = is0 ? a.amount1 : a.amount0;
        if (base < 0n && q > 0n) {
          side = "BUY";
          quoteAmount = q;
        } else if (base > 0n && q < 0n) {
          side = "SELL";
          quoteAmount = -q;
        }
      }
      if (!side || quoteAmount === undefined) {
        complete = false;
        continue;
      }
      const volume = toDisplayNumber(
        quoteAmount * parseUnitsSafe(quote.usdPrice, 18),
        quote.decimals + 18,
      );
      if (volume === undefined) {
        complete = false;
        continue;
      }
      let metadata = blocks.get(log.blockNumber);
      if (!metadata) {
        metadata = await block(BigInt(log.blockNumber));
        blocks.set(log.blockNumber, metadata);
      }
      if (metadata.hash !== log.blockHash) {
        this.book.reset(event.id);
        throw new Error("SWAP_BLOCK_REORG_RETRY");
      }
      const at = Number(BigInt(metadata.timestamp)) * 1000;
      if (!Number.isSafeInteger(at) || at > Date.now() + 15000) {
        complete = false;
        continue;
      }
      this.book.observe(event.id, {
        at,
        trade: {
          id: `${log.transactionHash}:${log.logIndex}`,
          side,
          volumeUsd: volume,
          quoteAmount: quoteAmount.toString(),
        },
      });
    }
    const last = await block(to);
    const through = Number(BigInt(last.timestamp)) * 1000;
    if (!complete) {
      this.book.invalidateStream(event.id);
      this.book.startCompleteStream(event.id, through);
    }
    this.book.advanceStream(event.id, through);
    await this.cursors.writeCursor(key + ":hash", last.hash);
    await this.cursors.writeCursor(key, to.toString());
  }
}
