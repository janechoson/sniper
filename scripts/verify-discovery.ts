import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { parseArgs } from "node:util";
import { loadEnv, loadRealConfig } from "@sniper/config";
import {
  EvmDiscoveryReader,
  EvmLaunchDiscovery,
  JsonRpcClient,
  isEvmDiscoveryFamily,
  verifyEvmDiscoveryAbis,
} from "@sniper/chains";

// This module only imports RPC discovery. No wallet, signer, executor or writable journal.
const chain = process.argv[2];
if (chain !== "bnb" && chain !== "robinhood") throw new Error("CHAIN_REQUIRED");
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    blocks: { type: "string", default: "400" },
    source: { type: "string" },
  },
});
const blocks = z.coerce.number().int().min(1).max(2000).parse(values.blocks);
const env = loadEnv();
const config = await loadRealConfig(env.REAL_CONFIG_PATH);
verifyEvmDiscoveryAbis();
const url = chain === "bnb" ? env.BNB_RPC_HTTP : env.ROBINHOOD_RPC_HTTP;
if (!url) throw new Error("RPC_NOT_CONFIGURED");
const rpc = new JsonRpcClient(`verify-discovery-${chain}`, url, {
  rps: 3,
  concurrency: 2,
});
const archiveUrl = config.discoveryArchiveRpcByChain[chain];
const archiveRpc = archiveUrl
  ? new JsonRpcClient(`verify-discovery-archive-${chain}`, archiveUrl, {
      rps: 3,
      concurrency: 2,
    })
  : undefined;
const cursors = new Map<string, string>();
const reader = new EvmDiscoveryReader(
  rpc,
  archiveRpc,
  chain === "bnb" ? 56 : 4663,
);
try {
  const actual = Number(
    BigInt(await rpc.request("eth_chainId", [], z.string())),
  );
  if (actual !== (chain === "bnb" ? 56 : 4663))
    throw new Error("CHAIN_ID_MISMATCH");
  const head = BigInt(await rpc.request("eth_blockNumber", [], z.string()));
  const deployments = config.deployments.filter(
    (d) =>
      d.enabled &&
      d.chainId === chain &&
      isEvmDiscoveryFamily(d.family) &&
      (!values.source || d.id === values.source),
  );
  if (!deployments.length) throw new Error("NO_CONFIGURED_DISCOVERY_SOURCES");
  const scanners = deployments.map(
    (d) =>
      new EvmLaunchDiscovery(
        chain,
        { ...d, fromBlock: undefined, initialLookbackBlocks: blocks },
        config.quotes[chain] ?? [],
        {
          readCursor: async (key) => cursors.get(key),
          writeCursor: async (key, value) => {
            cursors.set(key, value);
          },
        },
        reader,
      ),
  );
  const samples: Record<string, unknown[]> = {};
  for (let turn = 0; turn < Math.ceil(blocks / 200) + 1; turn++) {
    await Promise.allSettled(
      scanners.map((scanner) =>
        scanner.poll(async (event) => {
          const values = samples[event.dexId] ?? [];
          values.push({
            token: event.tokenAddress,
            poolOrCurve: event.poolAddress,
            transactionHash: event.transactionId,
            quoteAsset: event.quoteAsset,
            block: (event.rawEvent as Record<string, unknown>).blockNumber,
            stage: (event.rawEvent as Record<string, unknown>).stage,
            onchainAt: event.chainTimestamp,
            observedAt: event.detectedAt,
            normalizedAt: Date.now(),
          });
          samples[event.dexId] = values.slice(-3);
        }),
      ),
    );
  }
  const report = {
    checkedAt: new Date().toISOString(),
    chainId: actual,
    chain,
    broadcast: false,
    signing: false,
    requestedLookbackBlocks: blocks,
    initialHead: head.toString(),
    metricsScope:
      "runtime; latency last 256 samples; unique token window 2048; source RPC requests logical before shared cache/batching",
    sources: scanners.map((s) => ({
      ...s.stats(),
      verification: s.stats().lastError
        ? "FAILED"
        : s.stats().detected
          ? "REAL_EVENT_DECODED"
          : "NO_EVENTS_IN_WINDOW",
      samples: samples[s.deployment.id] ?? [],
    })),
    rpc: rpc.stats(),
    archiveRpc: archiveRpc?.stats(),
  };
  await writeFile(
    `data/discovery-${chain}${values.source ? `-${encodeURIComponent(values.source)}` : ""}-verification.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
  if (report.sources.some((s) => s.lastError)) process.exitCode = 1;
} finally {
  rpc.close();
  archiveRpc?.close();
}
