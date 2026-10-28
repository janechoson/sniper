import { decodeEventLog, parseAbiItem, isAddress } from "viem";
import { z } from "zod";
import type { TokenDiscoveryEvent } from "@sniper/core";
import type { DexDeploymentConfig, TrustedQuoteAsset } from "@sniper/config";
import { JsonRpcClient } from "../rpc/http";
const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const logSchema = z.object({
  address: z.string(),
  topics: z.array(hex).min(1),
  data: z.string(),
  blockNumber: hex,
  blockHash: hex,
  transactionHash: hex,
  logIndex: hex,
  removed: z.boolean().optional(),
});
const v2 = parseAbiItem(
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256 pairCount)",
);
const v3 = parseAbiItem(
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)",
);
export interface DiscoveryCursorStore {
  readCursor(key: string): Promise<string | undefined>;
  writeCursor(key: string, block: string): Promise<void>;
}
export class EvmFactoryDiscovery {
  private polling = false;
  private stopped = false;
  constructor(
    private readonly chainId: string,
    private readonly rpc: JsonRpcClient,
    private readonly deployment: DexDeploymentConfig,
    private readonly quotes: TrustedQuoteAsset[],
    private readonly cursors: DiscoveryCursorStore,
    private readonly options: { currentStateOnly?: boolean } = {},
  ) {}
  stop() {
    this.stopped = true;
  }
  async poll(callback: (event: TokenDiscoveryEvent) => Promise<void>) {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const factory = this.deployment.factoryAddress;
      if (!factory || !isAddress(factory))
        throw new Error("DEX_FACTORY_NOT_CONFIGURED");
      if (
        (await this.rpc.request(
          "eth_getCode",
          [factory, "latest"],
          z.string(),
        )) === "0x"
      )
        throw new Error("DEX_FACTORY_CODE_MISSING");
      const head = BigInt(await this.rpc.request("eth_blockNumber", [], hex));
      const confirmed = head - BigInt(this.deployment.confirmationDepth);
      if (confirmed < 0n) return;
      const key = `discovery:${this.chainId}:${this.deployment.id}`;
      let stored = await this.cursors.readCursor(key);
      const savedCheckpoint = await this.cursors.readCursor(
        `${key}:checkpoint`,
      );
      if (savedCheckpoint) {
        const checkpoint = z
          .object({ block: z.string().regex(/^\d+$/), hash: hex })
          .parse(JSON.parse(savedCheckpoint));
        if (stored !== undefined && BigInt(checkpoint.block) < BigInt(stored))
          throw new Error("DISCOVERY_CHECKPOINT_REQUIRES_RECONCILIATION");
        const canonical = await this.rpc.request(
          "eth_getBlockByNumber",
          [`0x${BigInt(checkpoint.block).toString(16)}`, false],
          z.object({ hash: hex }),
        );
        if (canonical.hash !== checkpoint.hash)
          throw new Error("DISCOVERY_REORG_REQUIRES_RECONCILIATION");
        if (stored !== checkpoint.block) {
          await this.cursors.writeCursor(key, checkpoint.block);
          stored = checkpoint.block;
        }
      }
      // Không tự quét từ genesis. fromBlock chỉ dùng khi người vận hành cấu hình rõ ràng.
      let from =
        stored === undefined
          ? this.deployment.fromBlock
            ? BigInt(this.deployment.fromBlock)
            : confirmed > BigInt(this.deployment.initialLookbackBlocks ?? 0)
              ? confirmed - BigInt(this.deployment.initialLookbackBlocks ?? 0)
              : 0n
          : BigInt(stored) + 1n;
      if (from > confirmed) return;
      const to = from + 199n < confirmed ? from + 199n : confirmed;
      const anchor = await this.rpc.request(
        "eth_getBlockByNumber",
        [`0x${to.toString(16)}`, false],
        z.object({ hash: hex }),
      );
      const abi = this.deployment.family === "uniswap-v3" ? v3 : v2;
      const logs = await this.rpc.request(
        "eth_getLogs",
        [
          {
            address: factory,
            fromBlock: `0x${from.toString(16)}`,
            toBlock: `0x${to.toString(16)}`,
          },
        ],
        z.array(logSchema).max(10000),
      );
      logs.sort((a, b) =>
        BigInt(a.blockNumber) < BigInt(b.blockNumber)
          ? -1
          : BigInt(a.blockNumber) > BigInt(b.blockNumber)
            ? 1
            : Number(BigInt(a.logIndex) - BigInt(b.logIndex)),
      );
      for (const log of logs) {
        if (this.stopped) return;
        if (log.removed || log.address.toLowerCase() !== factory.toLowerCase())
          continue;
        let decoded;
        try {
          decoded = decodeEventLog({
            abi: [abi],
            data: log.data as `0x${string}`,
            topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
          });
        } catch {
          continue;
        }
        const args = decoded.args;
        const token0 = args.token0,
          token1 = args.token1;
        const pool = "pair" in args ? args.pair : args.pool;
        const q0 = this.quotes.find(
            (q) => q.address.toLowerCase() === token0.toLowerCase(),
          ),
          q1 = this.quotes.find(
            (q) => q.address.toLowerCase() === token1.toLowerCase(),
          );
        if (Boolean(q0) === Boolean(q1)) continue;
        const token = q0 ? token1 : token0;
        const quote = q0 ?? q1!;
        const block = await this.rpc.request(
          "eth_getBlockByNumber",
          [log.blockNumber, false],
          z.object({ hash: hex, timestamp: hex }),
        );
        if (block.hash.toLowerCase() !== log.blockHash.toLowerCase())
          throw new Error("DISCOVERY_REORG_RETRY");
        const timestamp = Number(BigInt(block.timestamp)) * 1000;
        if (!Number.isSafeInteger(timestamp))
          throw new Error("INVALID_BLOCK_TIMESTAMP");
        const poolCode = await this.rpc.request(
          "eth_getCode",
          [pool, this.options.currentStateOnly ? "latest" : log.blockNumber],
          z.string(),
        );
        if (poolCode === "0x") continue;
        await callback({
          id: `rpc:${this.chainId}:${this.deployment.id}:${pool.toLowerCase()}`,
          chainId: this.chainId,
          dexId: this.deployment.id,
          tokenAddress: token,
          poolAddress: pool,
          quoteTokenAddress: quote.address,
          timestamp,
          chainTimestamp: timestamp,
          detectedAt: Date.now(),
          transactionId: log.transactionHash,
          source: "RPC",
          pairClassification: "TRUSTED_QUOTE",
          rawEvent: {
            poolCodeVerificationBlock: this.options.currentStateOnly
              ? "latest-observation-only"
              : log.blockNumber,
            blockNumber: BigInt(log.blockNumber).toString(),
            blockHash: log.blockHash,
            logIndex: BigInt(log.logIndex).toString(),
            token0,
            token1,
            ...("fee" in args ? { fee: args.fee } : {}),
          },
        });
      }
      // Sau callback bền vững; crash trước cursor chỉ phát lại cùng id, không mất sự kiện.
      from = to;
      const canonical = await this.rpc.request(
        "eth_getBlockByNumber",
        [`0x${to.toString(16)}`, false],
        z.object({ hash: hex }),
      );
      if (canonical.hash !== anchor.hash)
        throw new Error("DISCOVERY_REORG_RETRY");
      await this.cursors.writeCursor(
        `${key}:checkpoint`,
        JSON.stringify({ block: from.toString(), hash: canonical.hash }),
      );
      await this.cursors.writeCursor(key, from.toString());
    } finally {
      this.polling = false;
    }
  }
}
