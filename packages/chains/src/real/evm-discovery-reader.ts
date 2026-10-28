import { z } from "zod";
import { JsonRpcClient } from "../rpc/http";

export const evmDiscoveryHex = z.string().regex(/^0x[\da-fA-F]+$/);
export const evmDiscoveryLogSchema = z.object({
  address: z.string().regex(/^0x[\da-fA-F]{40}$/),
  topics: z.array(evmDiscoveryHex).min(1).max(4),
  data: z.string().regex(/^0x[\da-fA-F]*$/),
  blockNumber: evmDiscoveryHex,
  blockHash: evmDiscoveryHex,
  transactionHash: evmDiscoveryHex,
  logIndex: evmDiscoveryHex,
  removed: z.boolean().optional(),
});
export type EvmDiscoveryLog = z.infer<typeof evmDiscoveryLogSchema>;
type PendingLog = {
  filter: {
    address: string;
    fromBlock: string;
    toBlock: string;
    topics: string[][];
  };
  resolve: (logs: EvmDiscoveryLog[]) => void;
  reject: (reason: unknown) => void;
};

/** Shared, bounded reads across sources; one getLogs for matching block ranges. */
export class EvmDiscoveryReader {
  private readonly cache = new Map<
    string,
    { expires: number; pending: boolean; value: Promise<unknown> }
  >();
  private logQueue: PendingLog[] = [];
  private scheduled = false;
  private readonly canonicalReads = new Map<
    string,
    Promise<{ hash: string; timestamp: string }>
  >();
  private archiveChainCheck?: Promise<void>;
  constructor(
    readonly rpc: JsonRpcClient,
    private readonly archiveRpc?: JsonRpcClient,
    private readonly expectedChainId?: number,
  ) {}
  private async checkedArchive() {
    if (!this.archiveRpc || !this.expectedChainId)
      throw new Error("DISCOVERY_ARCHIVE_CHAIN_NOT_CONFIGURED");
    this.archiveChainCheck ??= this.archiveRpc
      .request("eth_chainId", [], evmDiscoveryHex)
      .then((id) => {
        if (Number(BigInt(id)) !== this.expectedChainId)
          throw new Error("DISCOVERY_ARCHIVE_CHAIN_MISMATCH");
      });
    await this.archiveChainCheck;
    return this.archiveRpc;
  }
  canonicalBlock(number: string) {
    const old = this.canonicalReads.get(number);
    if (old) return old;
    if (this.canonicalReads.size >= 60)
      return Promise.reject(new Error("DISCOVERY_READ_BACKPRESSURE"));
    const pending = this.rpc
      .request(
        "eth_getBlockByNumber",
        [number, false],
        z.object({ hash: evmDiscoveryHex, timestamp: evmDiscoveryHex }),
      )
      .finally(() => this.canonicalReads.delete(number));
    this.canonicalReads.set(number, pending);
    return pending;
  }
  async request<T>(
    method: string,
    params: unknown[],
    schema: z.ZodType<T>,
  ): Promise<T> {
    const key = JSON.stringify([method, params]);
    const old = this.cache.get(key);
    if (old && (old.pending || old.expires > Date.now()))
      return schema.parse(await old.value);
    if (this.cache.size >= 1024) {
      for (const [key, item] of this.cache) {
        if (!item.pending) {
          this.cache.delete(key);
          break;
        }
      }
      if (this.cache.size >= 1024)
        throw new Error("DISCOVERY_READ_BACKPRESSURE");
    }
    const ttl =
      method === "eth_blockNumber" ? 750 : method === "eth_call" ? 3000 : 30000;
    const entry = {
      pending: true,
      expires: Infinity,
      value: Promise.resolve<unknown>(undefined),
    };
    const run = async () => {
      const client =
        method === "eth_getTransactionReceipt" && this.archiveRpc
          ? this.archiveRpc
          : this.rpc;
      if (client === this.archiveRpc) {
        await this.checkedArchive();
      }
      return client.request(method, params, z.unknown());
    };
    entry.value = run().then(
      (value) => {
        entry.pending = false;
        entry.expires = Date.now() + ttl;
        if (value === null) this.cache.delete(key);
        return value;
      },
      (error) => {
        this.cache.delete(key);
        throw error;
      },
    );
    this.cache.set(key, entry);
    return schema.parse(await entry.value);
  }
  logs(filter: PendingLog["filter"]): Promise<EvmDiscoveryLog[]> {
    if (this.logQueue.length >= 60)
      return Promise.reject(new Error("DISCOVERY_READ_BACKPRESSURE"));
    return new Promise((resolve, reject) => {
      this.logQueue.push({ filter, resolve, reject });
      if (!this.scheduled) {
        this.scheduled = true;
        queueMicrotask(() => {
          void this.flush();
        });
      }
    });
  }
  private async flush() {
    this.scheduled = false;
    const jobs = this.logQueue.splice(0);
    const groups = new Map<string, PendingLog[]>();
    for (const job of jobs) {
      const key = job.filter.fromBlock + ":" + job.filter.toBlock;
      groups.set(key, [...(groups.get(key) ?? []), job]);
    }
    await Promise.all(
      [...groups.values()].map(async (group) => {
        try {
          const params = [
            {
              address: [...new Set(group.map((j) => j.filter.address))],
              fromBlock: group[0]!.filter.fromBlock,
              toBlock: group[0]!.filter.toBlock,
              topics: [
                [...new Set(group.flatMap((j) => j.filter.topics[0] ?? []))],
              ],
            },
          ];
          const schema = z.array(evmDiscoveryLogSchema).max(10000);
          let logs: EvmDiscoveryLog[];
          try {
            logs = await this.rpc.request("eth_getLogs", params, schema);
          } catch (error) {
            // Explicit archive provider only; never skip old cursor data.
            if (
              !this.archiveRpc ||
              !(error instanceof Error) ||
              !["HTTP_403", "RPC_CODE_-32602"].includes(error.message)
            )
              throw error;
            logs = await (
              await this.checkedArchive()
            ).request("eth_getLogs", params, schema);
          }
          for (const job of group)
            job.resolve(
              logs.filter(
                (log) =>
                  log.address.toLowerCase() ===
                    job.filter.address.toLowerCase() &&
                  job.filter.topics[0]!.includes(log.topics[0]!),
              ),
            );
        } catch (error) {
          for (const job of group) job.reject(error);
        }
      }),
    );
  }
}
