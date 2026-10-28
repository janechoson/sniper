import { z } from "zod";
import {
  toEventSelector,
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  type Hex,
  type AbiEvent,
} from "viem";
import type { DexDeploymentConfig, TrustedQuoteAsset } from "@sniper/config";
import type { TokenDiscoveryEvent } from "@sniper/core";
import type { DiscoveryCursorStore } from "./evm-discovery";
import { evmSourceAbis } from "./evm-source-abis";
import { decodeEvmSourceLog } from "./evm-source-decoder";
import {
  EvmDiscoveryReader,
  evmDiscoveryHex as hex,
  evmDiscoveryLogSchema,
} from "./evm-discovery-reader";

const creations = new Set([
  "PairCreated",
  "PoolCreated",
  "Initialize",
  "TokenCreate",
  "TokenCreated",
  "TokenLaunched",
  "LaunchCreated",
  "Create",
  "LiquidityAdded",
  "MigrateExecuted",
  "PhaseTransition",
  "PoolGraduated",
  "LaunchSwept",
  "Migrate",
]);
const blockSchema = z.object({ hash: hex, timestamp: hex });
const receiptSchema = z.object({
  status: hex,
  blockHash: hex,
  blockNumber: hex,
  transactionHash: hex,
  logs: z.array(evmDiscoveryLogSchema).max(10000),
});
export class EvmLaunchDiscovery {
  private polling = false;
  private stopped = false;
  private readonly seen = new Map<string, number>();
  private readonly tokens = new Set<string>();
  private readonly samples: number[] = [];
  private readonly started = Date.now();
  private readonly counters = {
    detected: 0,
    duplicates: 0,
    errors: 0,
    reconnects: 0,
    rpcRequests: 0,
    candidates: 0,
    invalidEvents: 0,
  };
  private latest?: {
    token: string;
    transactionHash: string;
    block: string;
    observedAt: number;
    onchainAt: number;
    normalizedAt: number;
    stage: string;
  };
  private lastBlock?: string;
  private lastError?: string;
  private rangeBlocks = 200n;
  constructor(
    readonly chainId: string,
    readonly deployment: DexDeploymentConfig,
    private readonly quotes: TrustedQuoteAsset[],
    private readonly cursors: DiscoveryCursorStore,
    private readonly reader: EvmDiscoveryReader,
  ) {
    if (!evmSourceAbis[deployment.family])
      throw new Error("DISCOVERY_ABI_UNVERIFIED");
  }
  stop() {
    this.stopped = true;
  }
  reconnect() {
    this.counters.reconnects++;
  }
  stats() {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const percentile = (p: number) =>
      sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : null;
    const seconds = Math.max(1, (Date.now() - this.started) / 1000);
    return {
      chainId: this.chainId,
      source: this.deployment.id,
      status: this.stopped
        ? "STOPPED"
        : this.lastError
          ? "DEGRADED"
          : this.lastBlock
            ? "SCANNING"
            : "CONNECTING",
      ...this.counters,
      uniqueTokens: this.tokens.size,
      uniqueTokenWindow: 2048,
      latencySamples: sorted.length,
      latencyP50Ms: percentile(0.5),
      latencyP95Ms: percentile(0.95),
      eventsPerSecond: this.counters.detected / seconds,
      candidatesPerSecond: this.counters.candidates / seconds,
      lastBlock: this.lastBlock,
      lastError: this.lastError,
      latest: this.latest,
      metricsSince: this.started,
    };
  }
  private read<T>(method: string, params: unknown[], schema: z.ZodType<T>) {
    this.counters.rpcRequests++;
    return this.reader.request(method, params, schema);
  }
  async poll(callback: (event: TokenDiscoveryEvent) => Promise<void>) {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      const emitter = this.deployment.factoryAddress;
      if (!emitter || !/^0x[\da-fA-F]{40}$/.test(emitter))
        throw new Error("DEX_FACTORY_NOT_CONFIGURED");
      if (
        (await this.read("eth_getCode", [emitter, "latest"], z.string())) ===
        "0x"
      )
        throw new Error("DEX_FACTORY_CODE_MISSING");
      if (this.deployment.registryAddress) {
        const abi = parseAbi(["function openFourCore() view returns(address)"]);
        const result = await this.read(
          "eth_call",
          [
            {
              to: this.deployment.registryAddress,
              data: encodeFunctionData({ abi, functionName: "openFourCore" }),
            },
            "latest",
          ],
          hex,
        );
        if (
          decodeFunctionResult({
            abi,
            functionName: "openFourCore",
            data: result as Hex,
          }).toLowerCase() !== emitter.toLowerCase()
        )
          throw new Error("DISCOVERY_REGISTRY_CHANGED");
      }
      const head = BigInt(await this.read("eth_blockNumber", [], hex));
      const confirmed = head - BigInt(this.deployment.confirmationDepth);
      if (confirmed < 0n) return;
      const key = `discovery:${this.chainId}:${this.deployment.id}`;
      let saved = await this.cursors.readCursor(key);
      const rawCheckpoint = await this.cursors.readCursor(`${key}:checkpoint`);
      if (rawCheckpoint) {
        const cp = z
          .object({ block: z.string().regex(/^\d+$/), hash: hex })
          .parse(JSON.parse(rawCheckpoint));
        if (saved !== undefined && BigInt(cp.block) < BigInt(saved))
          throw new Error("DISCOVERY_CHECKPOINT_REQUIRES_RECONCILIATION");
        this.counters.rpcRequests++;
        const canonical = await this.reader.canonicalBlock(
          `0x${BigInt(cp.block).toString(16)}`,
        );
        if (canonical.hash.toLowerCase() !== cp.hash.toLowerCase())
          throw new Error("DISCOVERY_REORG_REQUIRES_RECONCILIATION");
        saved = cp.block;
      }
      const lookback = BigInt(this.deployment.initialLookbackBlocks);
      const from =
        saved !== undefined
          ? BigInt(saved) + 1n
          : this.deployment.fromBlock
            ? BigInt(this.deployment.fromBlock)
            : confirmed > lookback
              ? confirmed - lookback
              : 0n;
      if (from > confirmed) {
        this.lastBlock = saved;
        return;
      }
      const end = from + this.rangeBlocks - 1n;
      const to = end < confirmed ? end : confirmed;
      const anchor = await this.read(
        "eth_getBlockByNumber",
        [`0x${to.toString(16)}`, false],
        blockSchema,
      );
      const events = evmSourceAbis[this.deployment.family]!.filter(
        (e): e is AbiEvent => e.type === "event" && creations.has(e.name),
      );
      this.counters.rpcRequests++;
      const logs = await this.reader.logs({
        address: emitter,
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${to.toString(16)}`,
        topics: [events.map(toEventSelector)],
      });
      if (logs.length > 256) throw new Error("DISCOVERY_EVENT_BATCH_LIMIT");
      logs.sort((a, b) =>
        BigInt(a.blockNumber) < BigInt(b.blockNumber)
          ? -1
          : BigInt(a.blockNumber) > BigInt(b.blockNumber)
            ? 1
            : Number(BigInt(a.logIndex) - BigInt(b.logIndex)),
      );
      for (const log of logs) {
        const observedAt = Date.now();
        if (this.stopped) return;
        if (log.removed) continue;
        if (BigInt(log.blockNumber) < from || BigInt(log.blockNumber) > to)
          throw new Error("DISCOVERY_LOG_RANGE_INVALID");
        const identity = `${log.transactionHash}:${log.logIndex}:${log.blockHash}`;
        if (this.seen.has(identity)) {
          this.counters.duplicates++;
          continue;
        }
        let normalized: TokenDiscoveryEvent[];
        try {
          const block = await this.read(
            "eth_getBlockByNumber",
            [log.blockNumber, false],
            blockSchema,
          );
          if (block.hash.toLowerCase() !== log.blockHash.toLowerCase())
            throw new Error("DISCOVERY_REORG_RETRY");
          const receipt = await this.read(
            "eth_getTransactionReceipt",
            [log.transactionHash],
            receiptSchema,
          );
          if (BigInt(receipt.status) !== 1n) {
            this.counters.invalidEvents++;
            continue;
          }
          if (
            receipt.transactionHash.toLowerCase() !==
              log.transactionHash.toLowerCase() ||
            receipt.blockHash.toLowerCase() !== log.blockHash.toLowerCase() ||
            BigInt(receipt.blockNumber) !== BigInt(log.blockNumber)
          )
            throw new Error("DISCOVERY_RECEIPT_IDENTITY_MISMATCH");
          if (
            !receipt.logs.some(
              (l) =>
                l.address.toLowerCase() === emitter.toLowerCase() &&
                l.logIndex === log.logIndex &&
                l.data === log.data &&
                l.topics.join(":") === log.topics.join(":"),
            )
          )
            throw new Error("DISCOVERY_RECEIPT_LOG_MISMATCH");
          const timestamp = Number(BigInt(block.timestamp)) * 1000;
          if (
            !Number.isSafeInteger(timestamp) ||
            timestamp > Date.now() + 60000
          )
            throw new Error("DISCOVERY_TIMESTAMP_INVALID");
          normalized = await decodeEvmSourceLog(
            this.chainId,
            this.deployment,
            log,
            receipt.logs,
            timestamp,
            this.reader,
            this.quotes,
            () => {
              this.counters.rpcRequests++;
            },
          );
        } catch (error) {
          // Transient RPC/schema failures never advance a cursor. A malformed ABI log can be skipped explicitly.
          if (
            error instanceof Error &&
            /^(Abi|Decode|DataSize|PositionOutOfBounds)/.test(error.name)
          ) {
            this.counters.invalidEvents++;
            this.counters.errors++;
            continue;
          }
          throw error;
        }
        for (const event of normalized) {
          event.detectedAt = observedAt;
          event.rawEvent = {
            ...(event.rawEvent as Record<string, unknown>),
            observedAt,
            normalizedAt: Date.now(),
          };
          await callback(event);
          this.counters.candidates++;
          this.tokens.add(event.tokenAddress);
          if (this.tokens.size > 2048)
            this.tokens.delete(this.tokens.values().next().value!);
          const latency = Math.max(0, Date.now() - event.chainTimestamp!);
          this.samples.push(latency);
          if (this.samples.length > 256) this.samples.shift();
          const raw = event.rawEvent as Record<string, unknown>;
          this.latest = {
            token: event.tokenAddress,
            transactionHash: event.transactionId!,
            block: BigInt(log.blockNumber).toString(),
            observedAt: event.detectedAt!,
            onchainAt: event.chainTimestamp!,
            normalizedAt: Date.now(),
            stage: String(raw.stage),
          };
        }
        this.counters.detected++;
        this.seen.set(identity, Date.now());
        if (this.seen.size > 2048)
          this.seen.delete(this.seen.keys().next().value!);
      }
      // Fresh uncached anchor read catches a reorg during callbacks; persisted cursors advance only after durable acceptance.
      const final = await this.reader.canonicalBlock(`0x${to.toString(16)}`);
      this.counters.rpcRequests++;
      if (final.hash.toLowerCase() !== anchor.hash.toLowerCase())
        throw new Error("DISCOVERY_REORG_RETRY");
      await this.cursors.writeCursor(
        `${key}:checkpoint`,
        JSON.stringify({ block: to.toString(), hash: final.hash }),
      );
      await this.cursors.writeCursor(key, to.toString());
      this.lastBlock = to.toString();
      this.lastError = undefined;
    } catch (error) {
      this.counters.errors++;
      this.lastError =
        error instanceof Error && /^[A-Z0-9_:-]+$/.test(error.message)
          ? error.message
          : "DISCOVERY_VALIDATION_FAILED";
      if (
        /^(DISCOVERY_EVENT_BATCH_LIMIT|RESPONSE_TOO_LARGE|RPC_CODE_-32005)$/.test(
          this.lastError,
        ) &&
        this.rangeBlocks > 1n
      )
        this.rangeBlocks /= 2n;
      throw error;
    } finally {
      this.polling = false;
    }
  }
}
