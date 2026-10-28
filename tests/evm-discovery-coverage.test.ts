import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  encodeEventTopics,
  encodeAbiParameters,
  encodeFunctionResult,
  zeroAddress,
  type AbiEvent,
  type Hex,
} from "viem";
import {
  dexDeploymentSchema,
  loadEnv,
  chainsFromEnv,
  realConfigSchema,
  defaultSettings,
} from "@sniper/config";
import {
  rugPolicySchema,
  type TokenDiscoveryEvent,
  type CandidateRecord,
  type AIProvider,
} from "@sniper/core";
import {
  JsonRpcClient,
  EvmDiscoveryReader,
  EvmLaunchDiscovery,
  evmSourceAbis,
  poolIdentity,
  ProductionChainAdapter,
  verifyEvmDiscoveryAbis,
} from "@sniper/chains";
import { MemoryRepository } from "@sniper/storage";
import { TradingWallet } from "@sniper/wallet";
import { RealTradingEngine } from "../packages/engine/src/real";
import { FeatureEngine, type RugCheckEngine } from "@sniper/features";
import { analyzeObservation } from "../packages/engine/src/observation-analysis";
import {
  DiscoveryMonitor,
  hasRecordedTokenEntry,
  latestUniqueCandidates,
} from "../packages/engine/src/discovery-monitor";

const token = "0x1111111111111111111111111111111111111111",
  quote = "0x2222222222222222222222222222222222222222",
  pool = "0x3333333333333333333333333333333333333333",
  factory = "0x4444444444444444444444444444444444444444",
  curve = "0x5555555555555555555555555555555555555555",
  creator = "0x6666666666666666666666666666666666666666";
const hash = (char: string) => `0x${char.repeat(64)}` as Hex;
const clients: JsonRpcClient[] = [];
afterEach(() => clients.splice(0).forEach((c) => c.close()));
const fixture = (handler: (m: string, p: unknown[]) => unknown) => {
  const rpc = new JsonRpcClient("fixture", "https://fixture.invalid", {
    rps: 100000,
    concurrency: 64,
    timeoutMs: 1000,
    fetcher: async (_u, init) => {
      const req = JSON.parse(String(init?.body));
      return Response.json({
        jsonrpc: "2.0",
        id: req.id,
        result: await handler(req.method, req.params),
      });
    },
  });
  clients.push(rpc);
  return rpc;
};
const args = (over: Record<string, unknown> = {}) => ({
  token,
  base: token,
  asset: token,
  token0: token,
  token1: quote,
  currency0: token,
  currency1: quote,
  quote,
  quoteAsset: quote,
  pairToken: quote,
  numeraire: quote,
  creator,
  deployer: creator,
  pair: pool,
  pool,
  curve,
  vault: curve,
  requestId: 1n,
  presetId: 1n,
  name: "Fixture only",
  symbol: "TEST",
  meta: "",
  tokenMetaUri: "",
  metadataURI: "",
  nonce: 1n,
  ts: 100n,
  pairCount: 1n,
  totalSupply: 1000n,
  maxSupply: 1000n,
  saleAmount: 500n,
  raiseAmount: 10n,
  initialPrice: 1n,
  launchTime: 100n,
  launchFee: 1n,
  offers: 1n,
  funds: 1n,
  launchConfigId: 1n,
  graduationThreshold: 1n,
  feeShare: curve,
  partner: zeroAddress,
  poolId: hash("a"),
  fee: 3000,
  tickSpacing: 60,
  hooks: zeroAddress,
  parameters: hash("0"),
  sqrtPriceX96: 1n << 96n,
  tick: 0,
  activeId: 8388608,
  poolOrHook: pool,
  poolInitializer: creator,
  initializer: creator,
  launcher: creator,
  tickerKey: hash("b"),
  deployedAt: 100,
  reservedUntil: 200,
  normalizedTicker: "TEST",
  finalPositionRecipient: creator,
  curveModule: creator,
  tradeModule: creator,
  migrateModule: creator,
  customData: zeroAddress,
  tokenModule: creator,
  flags: 0n,
  encodedTags: "0x",
  caller: creator,
  migrateTagId: "0x1111111111111111",
  totalRaised: 10n,
  remainingForSale: 10n,
  hookDataHash: hash("a"),
  migratedDataVersion: 1,
  encodedMigratedData: "0x",
  from: 1,
  to: 2,
  operator: creator,
  positionId: 1n,
  tokenAmount: 10n,
  pairTokenAmount: 10n,
  quoteOut: 10n,
  tokenOut: 10n,
  ...over,
});
const cases: [string, string][] = [
  ["pancakeswap", "PairCreated"],
  ["uniswap-v2", "PairCreated"],
  ["uniswap-v3", "PoolCreated"],
  ["uniswap-v4", "Initialize"],
  ["pancakeswap-infinity-cl", "Initialize"],
  ["pancakeswap-infinity-bin", "Initialize"],
  ["four-meme", "TokenCreate"],
  ["openfour", "TokenCreated"],
  ["flap", "TokenCreated"],
  ["pons-v2", "TokenLaunched"],
  ["bags", "TokenCreated"],
  ["doppler", "Create"],
  ["long", "LaunchCreated"],
  ["pools-trade", "TokenLaunched"],
];
function encoded(
  family: string,
  name: string,
  fields: Record<string, unknown>,
  index = 0,
) {
  const abi = evmSourceAbis[family]!;
  const event = abi.find(
    (a): a is AbiEvent => a.type === "event" && a.name === name,
  )!;
  const inputs = event.inputs.filter((a) => !a.indexed);
  return {
    address: factory,
    topics: encodeEventTopics({
      abi: [event],
      eventName: name,
      args: fields as never,
    }) as string[],
    data: encodeAbiParameters(
      inputs,
      inputs.map((i) => fields[i.name!]) as never,
    ),
    blockNumber: "0x64",
    blockHash: hash("a"),
    transactionHash: hash("b"),
    logIndex: `0x${index.toString(16)}`,
  };
}
function setup(
  family: string,
  name: string,
  chain = "bnb",
  over: Record<string, unknown> = {},
) {
  const a: Record<string, unknown> = args(over);
  if (name === "Initialize")
    a.id = poolIdentity(factory, a, family.includes("infinity"));
  if (family === "pools-trade") {
    a.key = {
      currency0: token,
      currency1: quote,
      fee: 3000,
      tickSpacing: 60,
      hooks: zeroAddress,
    };
    a.poolId = poolIdentity(factory, a.key as Record<string, unknown>);
  }
  const log = encoded(family, name, a);
  const state = {
    status: "0x1",
    head: "0x66",
    canonical: hash("a"),
    logs: [log],
    receiptLogs: [log],
    badReceipt: false,
    reads: 0,
    receiptReads: 0,
  };
  const abi = evmSourceAbis[family]!;
  const rpc = fixture((m) => {
    state.reads++;
    if (m === "eth_getCode") return "0x1234";
    if (m === "eth_blockNumber") return state.head;
    if (m === "eth_getBlockByNumber")
      return { hash: state.canonical, timestamp: "0x64" };
    if (m === "eth_getLogs") return state.logs;
    if (m === "eth_getTransactionReceipt") {
      state.receiptReads++;
      return {
        status: state.status,
        transactionHash: hash("b"),
        blockHash: state.badReceipt ? hash("f") : hash("a"),
        blockNumber: "0x64",
        logs: state.receiptLogs,
      };
    }
    if (m === "eth_call") {
      if (family === "pons-v2")
        return encodeFunctionResult({
          abi,
          functionName: "getLaunchedToken",
          result: {
            token,
            curve,
            deployer: creator,
            creatorFeeRecipient: creator,
            pairToken: quote,
            graduationThreshold: 1n,
            poolFee: 3000,
            tickSpacing: 60,
            creatorTaxBps: 0,
            buybackEnabled: false,
            phase: 2,
            sweptQuote: 1n,
            sweptTokens: 1n,
            sweptAt: 100n,
            exists: true,
          },
        });
      if (family === "four-meme")
        return encodeFunctionResult({
          abi,
          functionName: "_tokenInfos",
          result: {
            base: token,
            quote,
            template: 1n,
            totalSupply: 1000n,
            maxOffers: 100n,
            maxRaising: 100n,
            launchTime: 100n,
            offers: 100n,
            funds: 1n,
            lastPrice: 1n,
            K: 1n,
            T: 1n,
            status: 0n,
          },
        });
      if (family === "bags")
        return encodeFunctionResult({
          abi,
          functionName: "curveForToken",
          result: curve,
        });
      if (family === "doppler")
        return encodeFunctionResult({
          abi,
          functionName: "getAssetData",
          result: [quote, creator, creator, creator, creator, pool],
        });
    }
    throw new Error("UNEXPECTED_FIXTURE_METHOD");
  });
  const cursors = new Map<string, string>();
  const deployment = dexDeploymentSchema.parse({
    id: "fixture-" + family,
    chainId: chain,
    family,
    factoryAddress: factory,
    poolManagerAddress: factory,
    fromBlock: "100",
    verifiedSource: "https://example.com/fixture-only",
  });
  const reader = new EvmDiscoveryReader(rpc);
  const store = {
    readCursor: async (k: string) => cursors.get(k),
    writeCursor: async (k: string, v: string) => {
      cursors.set(k, v);
    },
  };
  return {
    a,
    log,
    state,
    cursors,
    rpc,
    reader,
    deployment,
    scanner: new EvmLaunchDiscovery(
      chain,
      deployment,
      [{ address: quote, symbol: "Q", decimals: 18, type: "WRAPPED_NATIVE" }],
      store,
      reader,
    ),
    store,
  };
}

describe("EVM discovery coverage; fixtures only, no real RPC", () => {
  it("all 14 ABI profiles match the pinned integrity manifest", () => {
    expect(verifyEvmDiscoveryAbis()).toEqual({ verified: true, profiles: 14 });
  });
  it.each(cases)(
    "%s: valid %s keeps wrapped quote, no wallet requirement",
    async (family, name) => {
      const { scanner } = setup(family, name);
      const events: TokenDiscoveryEvent[] = [];
      await scanner.poll(async (e) => {
        events.push(e);
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        tokenAddress: token,
        source: "RPC",
        chainId: "bnb",
      });
      expect(events[0]!.rawEvent).toMatchObject({
        protocol: family,
        blockNumber: "100",
        verifiedSource: "https://example.com/fixture-only",
      });
      if (!["flap", "bags"].includes(family))
        expect(events[0]!.quoteTokenAddress).toBe(quote);
      else expect(events[0]!.quoteAsset?.type).toBe("NATIVE");
      expect(scanner.stats()).toMatchObject({
        detected: 1,
        uniqueTokens: 1,
        lastBlock: "100",
        errors: 0,
      });
    },
  );
  it.each(cases)(
    "%s: failed transaction never emits %s",
    async (family, name) => {
      const { scanner, state } = setup(family, name);
      state.status = "0x0";
      const fn = async () => {
        throw new Error("MUST_NOT_EMIT");
      };
      await scanner.poll(fn);
      expect(scanner.stats().candidates).toBe(0);
      expect(scanner.stats().invalidEvents).toBe(1);
    },
  );
  it.each(cases)(
    "%s: malformed %s cannot become candidate",
    async (family, name) => {
      const { scanner, state, log } = setup(family, name);
      state.logs = [{ ...log, data: "0x12" }];
      state.receiptLogs = state.logs;
      await scanner.poll(async () => {
        throw new Error("MUST_NOT_EMIT");
      });
      expect(scanner.stats().candidates).toBe(0);
      expect(scanner.stats().invalidEvents).toBe(1);
    },
  );
  it.each(cases)(
    "%s: duplicate %s and restart preserve cursor",
    async (family, name) => {
      const f = setup(family, name);
      f.state.logs.push(f.log);
      const events: TokenDiscoveryEvent[] = [];
      await f.scanner.poll(async (e) => {
        events.push(e);
      });
      expect(events).toHaveLength(1);
      expect(f.scanner.stats().duplicates).toBe(1);
      const restored = new EvmLaunchDiscovery(
        "bnb",
        f.deployment,
        [{ address: quote, symbol: "Q", decimals: 18 }],
        f.store,
        new EvmDiscoveryReader(f.rpc),
      );
      await restored.poll(async (e) => {
        events.push(e);
      });
      expect(events).toHaveLength(1);
      expect(restored.stats().lastBlock).toBe("100");
    },
  );
  it("receipt mismatch does not advance checkpoint", async () => {
    const f = setup("uniswap-v3", "PoolCreated");
    f.state.badReceipt = true;
    await expect(f.scanner.poll(async () => {})).rejects.toThrow(
      "DISCOVERY_RECEIPT_IDENTITY_MISMATCH",
    );
    expect(f.cursors.size).toBe(0);
  });
  it("callback storage failure does not advance checkpoint; replay after retry", async () => {
    const f = setup("uniswap-v3", "PoolCreated");
    await expect(
      f.scanner.poll(async () => {
        throw new Error("DISK_FAILURE");
      }),
    ).rejects.toThrow("DISK_FAILURE");
    expect(f.cursors.size).toBe(0);
    let emitted = 0;
    await f.scanner.poll(async () => {
      emitted++;
    });
    expect(emitted).toBe(1);
  });
  it("canonical checkpoint reorg fails closed after restart", async () => {
    const f = setup("uniswap-v3", "PoolCreated");
    await f.scanner.poll(async () => {});
    f.state.canonical = hash("f");
    const restored = new EvmLaunchDiscovery(
      "bnb",
      f.deployment,
      [],
      f.store,
      new EvmDiscoveryReader(f.rpc),
    );
    await expect(restored.poll(async () => {})).rejects.toThrow(
      "DISCOVERY_REORG_REQUIRES_RECONCILIATION",
    );
  });
  it("wrong singleton PoolId fails identity validation", async () => {
    const f = setup("uniswap-v4", "Initialize");
    f.state.logs = [
      encoded("uniswap-v4", "Initialize", { ...f.a, id: hash("f") }),
    ];
    f.state.receiptLogs = f.state.logs;
    await expect(f.scanner.poll(async () => {})).rejects.toThrow(
      "DISCOVERY_POOL_ID_MISMATCH",
    );
    expect(f.cursors.size).toBe(0);
  });
  it("Robinhood non-WETH numeraire stays visible and untrusted", async () => {
    const f = setup("long", "LaunchCreated", "robinhood", {
      numeraire: creator,
    });
    const events: TokenDiscoveryEvent[] = [];
    await f.scanner.poll(async (e) => {
      events.push(e);
    });
    expect(events[0]).toMatchObject({
      chainId: "robinhood",
      quoteTokenAddress: creator,
      quoteAsset: { type: "UNKNOWN", trusted: false },
      pairClassification: "UNKNOWN_PAIR",
    });
  });
  it("Flap quote override comes from same receipt and same token", async () => {
    const f = setup("flap", "TokenCreated", "robinhood");
    f.state.receiptLogs.push(
      encoded("flap", "TokenQuoteSet", { token, quoteToken: quote }, 1),
    );
    const events: TokenDiscoveryEvent[] = [];
    await f.scanner.poll(async (e) => {
      events.push(e);
    });
    expect(events[0]!.quoteTokenAddress).toBe(quote);
  });
  it("unknown pair emits both token observations instead of discarding them", async () => {
    const f = setup("uniswap-v3", "PoolCreated");
    const s = new EvmLaunchDiscovery(
      "bnb",
      f.deployment,
      [],
      f.store,
      f.reader,
    );
    const events: TokenDiscoveryEvent[] = [];
    await s.poll(async (e) => {
      events.push(e);
    });
    expect(events.map((e) => e.tokenAddress)).toEqual([token, quote]);
    expect(events.every((e) => e.quoteAsset?.trusted === false)).toBe(true);
  });
  it("shared reader batches range-compatible sources and shares receipts", async () => {
    let requests = 0;
    const rpc = fixture((m, p) => {
      requests++;
      if (m === "eth_getLogs") {
        expect((p[0] as { address: string[] }).address).toHaveLength(2);
        return [];
      }
      return { status: "0x1" };
    });
    const r = new EvmDiscoveryReader(rpc);
    const f = { fromBlock: "0x1", toBlock: "0x64", topics: [[hash("a")]] };
    await Promise.all([
      r.logs({ ...f, address: factory }),
      r.logs({ ...f, address: pool }),
    ]);
    expect(requests).toBe(1);
    await Promise.all([
      r.request("eth_getTransactionReceipt", [hash("b")], z.unknown()),
      r.request("eth_getTransactionReceipt", [hash("b")], z.unknown()),
    ]);
    expect(requests).toBe(2);
  });
  it("batch overload is bounded, does not advance cursor", async () => {
    const f = setup("flap", "TokenCreated");
    f.state.logs = Array.from({ length: 257 }, () => f.log);
    await expect(f.scanner.poll(async () => {})).rejects.toThrow(
      "DISCOVERY_EVENT_BATCH_LIMIT",
    );
    expect(f.cursors.size).toBe(0);
  });
  it("lifecycle merges case-insensitive EVM token across launchpad and migrated pool", () => {
    const monitor = new DiscoveryMonitor(100);
    const base = {
      id: "fixture",
      chainId: "bnb",
      dexId: "four-meme",
      tokenAddress: token,
      poolAddress: curve,
      timestamp: 1000,
      source: "RPC" as const,
      transactionId: hash("a"),
      rawEvent: { stage: "CURVE_CREATED" },
    };
    monitor.observe(base);
    monitor.attach({
      ...base,
      transactionId: hash("b"),
      rawEvent: { stage: "GRADUATED" },
    });
    monitor.observe({
      ...base,
      dexId: "pancakeswap-v3",
      poolAddress: pool,
      transactionId: hash("b"),
      rawEvent: { stage: "DEX_POOL_CREATED" },
    });
    expect(monitor.lifecycle(base)).toMatchObject({
      identity: `bnb:${token}`,
      sources: ["bnb:four-meme", "bnb:pancakeswap-v3"],
    });
    expect(monitor.lifecycle(base)!.observations).toHaveLength(3);
    expect(
      hasRecordedTokenEntry(
        base,
        [{ intentId: "i", state: "CONFIRMED" }],
        () => ({ side: "BUY", chainId: "bnb", tokenOut: token.toUpperCase() }),
      ),
    ).toBe(true);
  });
  it("reconnect metric and stop are explicit per source", async () => {
    const f = setup("flap", "TokenCreated");
    f.scanner.reconnect();
    f.scanner.stop();
    await f.scanner.poll(async () => {
      throw new Error("MUST_NOT_EMIT");
    });
    expect(f.scanner.stats()).toMatchObject({
      reconnects: 1,
      status: "STOPPED",
      rpcRequests: 0,
    });
  });
  it.each([
    ["four-meme", "LiquidityAdded", "GRADUATED"],
    ["openfour", "MigrateExecuted", "GRADUATED"],
    ["openfour", "PhaseTransition", "PHASE_CHANGED"],
    ["pons-v2", "LaunchSwept", "SWEPT"],
    ["pons-v2", "PoolGraduated", "GRADUATED"],
    ["doppler", "Migrate", "GRADUATED"],
  ])(
    "%s lifecycle %s is normalized from verified fields",
    async (family, name, stage) => {
      const f = setup(family, name);
      const events: TokenDiscoveryEvent[] = [];
      await f.scanner.poll(async (e) => {
        events.push(e);
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.rawEvent).toMatchObject({ stage });
    },
  );
  it("configured tokenized quote is generic; no WETH special case", async () => {
    const f = setup("long", "LaunchCreated", "robinhood");
    const source = new EvmLaunchDiscovery(
      "robinhood",
      f.deployment,
      [
        {
          address: quote,
          symbol: "NVDA",
          decimals: 18,
          type: "TOKENIZED_ASSET",
        },
      ],
      f.store,
      f.reader,
    );
    const events: TokenDiscoveryEvent[] = [];
    await source.poll(async (e) => {
      events.push(e);
    });
    expect(events[0]!.quoteAsset).toMatchObject({
      type: "TOKENIZED_ASSET",
      trusted: true,
      symbol: "NVDA",
    });
  });
  it("configured quote casing remains compatible with existing route lookup", async () => {
    const configured = "0x" + "Aa".repeat(20);
    const f = setup("uniswap-v3", "PoolCreated", "bnb", {
      token1: configured.toLowerCase(),
    });
    const source = new EvmLaunchDiscovery(
      "bnb",
      f.deployment,
      [{ address: configured, symbol: "Q", decimals: 18 }],
      f.store,
      f.reader,
    );
    const events: TokenDiscoveryEvent[] = [];
    await source.poll(async (e) => {
      events.push(e);
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.quoteTokenAddress).toBe(configured);
  });
  it("dedicated receipt provider rejects the wrong chain before reading a receipt", async () => {
    let receipts = 0;
    const primary = fixture(() => null),
      other = fixture((m) => {
        if (m === "eth_getTransactionReceipt") receipts++;
        return "0x1";
      });
    const reader = new EvmDiscoveryReader(primary, other, 56);
    await expect(
      reader.request("eth_getTransactionReceipt", [hash("a")], z.unknown()),
    ).rejects.toThrow("DISCOVERY_ARCHIVE_CHAIN_MISMATCH");
    expect(receipts).toBe(0);
  });
  it("archive log fallback preserves filters and validates the chain once", async () => {
    const primary = fixture(() => null),
      methods: string[] = [];
    vi.spyOn(primary, "request").mockRejectedValue(new Error("HTTP_403"));
    const archive = fixture((method, params) => {
      methods.push(method);
      if (method === "eth_chainId") return "0x38";
      expect(params).toEqual([
        {
          address: [factory],
          fromBlock: "0x1",
          toBlock: "0x2",
          topics: [[hash("a")]],
        },
      ]);
      return [];
    });
    const reader = new EvmDiscoveryReader(primary, archive, 56);
    const filter = {
      address: factory,
      fromBlock: "0x1",
      toBlock: "0x2",
      topics: [[hash("a")]],
    };
    expect(await reader.logs(filter)).toEqual([]);
    expect(await reader.logs(filter)).toEqual([]);
    expect(methods).toEqual(["eth_chainId", "eth_getLogs", "eth_getLogs"]);
  });
  it("archive log fallback rejects the wrong chain without reading logs", async () => {
    const primary = fixture(() => null),
      methods: string[] = [];
    vi.spyOn(primary, "request").mockRejectedValue(new Error("HTTP_403"));
    const archive = fixture((method) => {
      methods.push(method);
      return "0x1";
    });
    const reader = new EvmDiscoveryReader(primary, archive, 56);
    await expect(
      reader.logs({
        address: factory,
        fromBlock: "0x1",
        toBlock: "0x2",
        topics: [[hash("a")]],
      }),
    ).rejects.toThrow("DISCOVERY_ARCHIVE_CHAIN_MISMATCH");
    expect(methods).toEqual(["eth_chainId"]);
  });
  it("does not replace primary log timeouts with an archive request", async () => {
    const primary = fixture(() => null),
      archive = fixture(() => "0x38");
    vi.spyOn(primary, "request").mockRejectedValue(
      new Error("RPC_TIMEOUT_OR_NETWORK"),
    );
    const archiveRead = vi.spyOn(archive, "request");
    const reader = new EvmDiscoveryReader(primary, archive, 56);
    await expect(
      reader.logs({
        address: factory,
        fromBlock: "0x1",
        toBlock: "0x2",
        topics: [[hash("a")]],
      }),
    ).rejects.toThrow("RPC_TIMEOUT_OR_NETWORK");
    expect(archiveRead).not.toHaveBeenCalled();
  });
  it("intake merges launch and migration into one queue slot and keeps durable observations", async () => {
    const env = loadEnv({
        DATA_MODE: "real",
        AI_PROVIDER: "jev",
        OBSERVATION_ONLY: "true",
      }),
      repository = new MemoryRepository();
    const engine = new RealTradingEngine({
      repository,
      chains: chainsFromEnv(env),
      env,
      config: realConfigSchema.parse({ version: 1, maxPools: 12 }),
      wallets: new TradingWallet(chainsFromEnv(env), {}),
      configurationLoaded: true,
    });
    try {
      await engine.initialize();
      const boundary = engine as unknown as {
        acceptDiscovery(e: TokenDiscoveryEvent): Promise<void>;
      };
      const event: TokenDiscoveryEvent = {
        id: "fixture-only",
        chainId: "bnb",
        tokenAddress: token,
        poolAddress: token,
        dexId: "four-meme",
        timestamp: 1000,
        source: "RPC",
        transactionId: hash("a"),
        rawEvent: { marketKind: "CURVE_SINGLETON", stage: "CURVE_CREATED" },
      };
      await boundary.acceptDiscovery(event);
      await boundary.acceptDiscovery({
        ...event,
        transactionId: hash("b"),
        rawEvent: { marketKind: "CURVE_SINGLETON", stage: "GRADUATED" },
      });
      await boundary.acceptDiscovery({
        ...event,
        id: "fixture-pool",
        dexId: "pancakeswap-v3",
        poolAddress: pool,
        transactionId: hash("b"),
        rawEvent: { marketKind: "DEX_POOL", stage: "DEX_POOL_CREATED" },
      });
      const snapshot = await engine.snapshot();
      expect(snapshot.discovery?.queueDepth).toBe(1);
      expect(snapshot.metrics.aiCalls).toBe(0);
      expect(snapshot.executions).toHaveLength(0);
      const rows = await repository.read();
      expect(rows.filter((r) => r.kind === "real.discovery")).toHaveLength(3);
      const lifecycle = new DiscoveryMonitor(100);
      for (const row of rows.filter((r) => r.kind === "real.discovery"))
        lifecycle.attach(row.payload as TokenDiscoveryEvent);
      expect(lifecycle.lifecycle(event)!.observations).toHaveLength(3);
    } finally {
      await engine.shutdown();
    }
  });
  it("latest candidate selection is one row per EVM token across sources", () => {
    const base = {
      id: "old",
      event: {
        id: "e",
        chainId: "bnb",
        tokenAddress: token,
        poolAddress: curve,
        dexId: "four-meme",
        timestamp: 1,
        source: "RPC",
      },
      action: "SKIP",
      reasons: [],
      createdAt: 1,
    } as CandidateRecord;
    expect(
      latestUniqueCandidates([
        base,
        {
          ...base,
          id: "migrated",
          event: { ...base.event, dexId: "pancakeswap-v3", poolAddress: pool },
        },
      ]).map((r) => r.id),
    ).toEqual(["migrated"]);
  });
  it("full source analysis queue keeps discovery durable and visible without calling AI", async () => {
    const env = loadEnv({
        DATA_MODE: "real",
        AI_PROVIDER: "jev",
        OBSERVATION_ONLY: "true",
      }),
      repository = new MemoryRepository();
    const engine = new RealTradingEngine({
      repository,
      chains: chainsFromEnv(env),
      env,
      config: realConfigSchema.parse({ version: 1, maxPools: 6 }),
      wallets: new TradingWallet(chainsFromEnv(env), {}),
      configurationLoaded: true,
    });
    try {
      await engine.initialize();
      const boundary = engine as unknown as {
        acceptDiscovery(e: TokenDiscoveryEvent): Promise<void>;
      };
      for (let n = 1; n <= 10; n++) {
        const address = "0x" + n.toString(16).padStart(40, "0");
        await boundary.acceptDiscovery({
          id: "fixture-" + n,
          chainId: "bnb",
          tokenAddress: address,
          poolAddress: address,
          dexId: "four-meme",
          timestamp: 1000,
          source: "RPC",
          transactionId: hash("a"),
          rawEvent: { stage: "CURVE_CREATED", marketKind: "CURVE_SINGLETON" },
        });
      }
      const snapshot = await engine.snapshot();
      expect(snapshot.discovery?.queueDepth).toBe(1);
      expect(snapshot.discovery?.backpressure).toBe(9);
      expect(snapshot.candidates).toHaveLength(9);
      expect(
        snapshot.candidates.every((c) =>
          c.reasons.includes("DISCOVERY_ANALYSIS_SOURCE_CAP"),
        ),
      ).toBe(true);
      expect(snapshot.metrics.aiCalls).toBe(0);
      expect(snapshot.executions).toHaveLength(0);
      expect(
        (await repository.read()).filter((r) => r.kind === "real.discovery"),
      ).toHaveLength(10);
    } finally {
      await engine.shutdown();
    }
  });
  it("unsupported EVM market stops before Features/Rug/Jev", async () => {
    const env = loadEnv({
      DATA_MODE: "real",
      AI_PROVIDER: "jev",
      OBSERVATION_ONLY: "true",
    });
    const chain = chainsFromEnv(env).find((c) => c.id === "bnb")!;
    const d = dexDeploymentSchema.parse({
      id: "four-meme",
      chainId: "bnb",
      family: "four-meme",
      factoryAddress: factory,
      verifiedSource: "https://example.com/fixture-only",
    });
    const adapter = new ProductionChainAdapter(
      { ...chain, rpcHttpUrl: undefined },
      realConfigSchema.parse({ version: 1, deployments: [d] }),
      env,
      { readCursor: async () => undefined, writeCursor: async () => {} },
    );
    const event: TokenDiscoveryEvent = {
      id: "fixture",
      chainId: "bnb",
      tokenAddress: token,
      poolAddress: token,
      dexId: "four-meme",
      timestamp: 1,
      source: "RPC",
      pairClassification: "TRUSTED_QUOTE",
    };
    const features = new FeatureEngine([]),
      collect = vi.spyOn(features, "collect"),
      rug = { collect: vi.fn() } as unknown as RugCheckEngine,
      classify = vi.fn();
    const record = await analyzeObservation(event, {
      features,
      rug,
      ai: { id: "fixture", classify } as AIProvider,
      settings: defaultSettings(),
      policy: rugPolicySchema.parse({}),
      aiTimeoutMs: 100,
      claimAiSlot: () => true,
      stage: () => {},
      discoveryGuard: () => adapter.discoveryGuard(event),
    });
    expect(record.reasons).toEqual(["DISCOVERY_MARKET_ADAPTER_UNAVAILABLE"]);
    expect(collect).not.toHaveBeenCalled();
    expect(rug.collect).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });
});
