import { z } from "zod";
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  encodeAbiParameters,
  keccak256,
  zeroAddress,
  type Hex,
} from "viem";
import type { DexDeploymentConfig, TrustedQuoteAsset } from "@sniper/config";
import type { TokenDiscoveryEvent } from "@sniper/core";
import { evmSourceAbis } from "./evm-source-abis";
import {
  EvmDiscoveryReader,
  evmDiscoveryHex,
  type EvmDiscoveryLog,
} from "./evm-discovery-reader";

const address = z.string().regex(/^0x[\da-fA-F]{40}$/);
const addr = (v: unknown) => address.parse(v).toLowerCase();
const text = (v: unknown) =>
  typeof v === "string" ? v.slice(0, 100) : undefined;
const nativeSymbol = (chain: string) => (chain === "bnb" ? "BNB" : "ETH");
type Market = {
  token: string;
  quote?: string;
  pool: string;
  stage: string;
  marketKind: string;
  creator?: string;
  extra?: Record<string, unknown>;
};
export const poolIdentity = (
  manager: string,
  args: Record<string, unknown>,
  infinity = false,
) => {
  const currency0 = addr(args.currency0),
    currency1 = addr(args.currency1);
  if (BigInt(currency0) >= BigInt(currency1))
    throw new Error("DISCOVERY_CURRENCY_ORDER_INVALID");
  const types = infinity
    ? [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "bytes32" },
      ]
    : [
        { type: "address" },
        { type: "address" },
        { type: "uint24" },
        { type: "int24" },
        { type: "address" },
      ];
  const values = infinity
    ? [
        currency0,
        currency1,
        addr(args.hooks),
        manager,
        args.fee,
        args.parameters,
      ]
    : [currency0, currency1, args.fee, args.tickSpacing, addr(args.hooks)];
  return keccak256(encodeAbiParameters(types, values as never));
};

/** Pure event identity plus bounded on-chain reads. Never resolves wallet balances. */
export async function decodeEvmSourceLog(
  chain: string,
  deployment: DexDeploymentConfig,
  log: EvmDiscoveryLog,
  transactionLogs: EvmDiscoveryLog[],
  timestamp: number,
  reader: EvmDiscoveryReader,
  quotes: TrustedQuoteAsset[],
  onRead: () => void = () => {},
): Promise<TokenDiscoveryEvent[]> {
  const abi = evmSourceAbis[deployment.family];
  if (!abi) throw new Error("DISCOVERY_ABI_UNVERIFIED");
  const decoded = decodeEventLog({
    abi,
    data: log.data as Hex,
    topics: log.topics as [Hex, ...Hex[]],
    strict: true,
  });
  const a = decoded.args as unknown as Record<string, unknown>;
  const name = decoded.eventName;
  const emitter = log.address.toLowerCase();
  const read = async (functionName: string, token: string) => {
    onRead();
    return decodeFunctionResult({
      abi,
      functionName,
      data: (await reader.request(
        "eth_call",
        [
          {
            to: emitter,
            data: encodeFunctionData({ abi, functionName, args: [token] }),
          },
          "latest",
        ],
        evmDiscoveryHex,
      )) as Hex,
    });
  };
  const pair = (
    token0: unknown,
    token1: unknown,
    pool: string,
    extra: Record<string, unknown>,
  ): Market[] => {
    const t0 = addr(token0),
      t1 = addr(token1);
    if (BigInt(t0) >= BigInt(t1))
      throw new Error("DISCOVERY_CURRENCY_ORDER_INVALID");
    const q0 = quotes.find((q) => q.address.toLowerCase() === t0),
      q1 = quotes.find((q) => q.address.toLowerCase() === t1);
    const orientations =
      q0 && !q1
        ? [[t1, t0]]
        : q1 && !q0
          ? [[t0, t1]]
          : [
              [t0, t1],
              [t1, t0],
            ];
    return orientations
      .filter(([token]) => token !== zeroAddress)
      .map(([token, quote]) => ({
        token: token!,
        quote,
        pool,
        stage: "DEX_POOL_CREATED",
        marketKind:
          deployment.family.includes("infinity") ||
          deployment.family === "uniswap-v4"
            ? "SINGLETON_POOL"
            : "DEX_POOL",
        extra: { token0: t0, token1: t1, ...extra },
      }));
  };
  let markets: Market[] = [];
  if (name === "PairCreated" || name === "PoolCreated") {
    markets = pair(a.token0, a.token1, addr(a.pair ?? a.pool), {
      fee: a.fee,
      tickSpacing: a.tickSpacing,
    });
  } else if (name === "Initialize") {
    const id = z
      .string()
      .regex(/^0x[\da-fA-F]{64}$/)
      .parse(a.id)
      .toLowerCase();
    if (poolIdentity(emitter, a, deployment.family.includes("infinity")) !== id)
      throw new Error("DISCOVERY_POOL_ID_MISMATCH");
    markets = pair(a.currency0, a.currency1, id, {
      poolId: id,
      manager: emitter,
      hooks: addr(a.hooks),
      fee: a.fee,
      tickSpacing: a.tickSpacing,
      parameters: a.parameters,
      activeId: a.activeId,
    });
  } else if (deployment.family === "four-meme") {
    const token = addr(a.token ?? a.base);
    if (name === "TokenCreate") {
      const info = (await read("_tokenInfos", token)) as Record<
        string,
        unknown
      >;
      if (addr(info.base) !== token)
        throw new Error("DISCOVERY_TOKEN_REGISTRY_MISMATCH");
      markets = [
        {
          token,
          quote: addr(info.quote),
          pool: token,
          creator: addr(a.creator),
          stage: "CURVE_CREATED",
          marketKind: "CURVE_SINGLETON",
          extra: {
            name: a.name,
            symbol: a.symbol,
            launchTime: a.launchTime,
            controller: emitter,
          },
        },
      ];
    } else if (name === "LiquidityAdded")
      markets = [
        {
          token,
          quote: addr(a.quote),
          pool: token,
          stage: "GRADUATED",
          marketKind: "CURVE_SINGLETON",
          extra: { controller: emitter, destinationPool: "UNKNOWN" },
        },
      ];
  } else if (deployment.family === "openfour") {
    if (name === "TokenCreated")
      markets = [
        {
          token: addr(a.token),
          quote: addr(a.quoteAsset),
          pool: addr(a.vault),
          creator: addr(a.creator),
          stage: "LAUNCH_CREATED",
          marketKind: "MODULAR_LAUNCH",
          extra: {
            name: a.name,
            symbol: a.symbol,
            curveModule: a.curveModule,
            tradeModule: a.tradeModule,
            migrateModule: a.migrateModule,
            presetId: a.presetId,
          },
        },
      ];
    else if (name === "MigrateExecuted" || name === "PhaseTransition")
      markets = [
        {
          token: addr(a.token),
          pool: typeof a.vault === "string" ? addr(a.vault) : addr(a.token),
          stage: name === "MigrateExecuted" ? "GRADUATED" : "PHASE_CHANGED",
          marketKind: "MODULAR_LAUNCH",
          extra: {
            from: a.from,
            to: a.to,
            migrateModule: a.migrateModule,
            migrateTagId: a.migrateTagId,
            migratedDataVersion: a.migratedDataVersion,
            encodedMigratedData: a.encodedMigratedData,
          },
        },
      ];
  } else if (deployment.family === "flap" && name === "TokenCreated") {
    const token = addr(a.token);
    let quote = zeroAddress as string,
      migrator: unknown;
    for (const extra of transactionLogs.filter(
      (l) => l.address.toLowerCase() === emitter,
    )) {
      try {
        const event = decodeEventLog({
          abi,
          data: extra.data as Hex,
          topics: extra.topics as [Hex, ...Hex[]],
          strict: true,
        });
        const fields = event.args as unknown as Record<string, unknown>;
        if (typeof fields.token !== "string" || addr(fields.token) !== token)
          continue;
        if (event.eventName === "TokenQuoteSet")
          quote = addr(fields.quoteToken);
        if (event.eventName === "TokenMigratorSet")
          migrator = fields.migratorType;
      } catch {
        /* Other proxy events are not part of this creation profile. */
      }
    }
    markets = [
      {
        token,
        quote,
        pool: token,
        creator: addr(a.creator),
        stage: "CURVE_CREATED",
        marketKind: "CURVE_SINGLETON",
        extra: {
          name: a.name,
          symbol: a.symbol,
          migratorType: migrator,
          controller: emitter,
        },
      },
    ];
  } else if (deployment.family === "pons-v2") {
    if (name === "TokenLaunched")
      markets = [
        {
          token: addr(a.token),
          quote: addr(a.pairToken),
          pool: addr(a.curve),
          creator: addr(a.deployer),
          stage: "CURVE_CREATED",
          marketKind: "BONDING_CURVE",
          extra: {
            launchConfigId: a.launchConfigId,
            graduationThreshold: a.graduationThreshold,
          },
        },
      ];
    else if (name === "PoolGraduated" || name === "LaunchSwept") {
      const token = addr(a.token),
        state = (await read("getLaunchedToken", token)) as Record<
          string,
          unknown
        >;
      if (state.exists !== true || addr(state.token) !== token)
        throw new Error("DISCOVERY_TOKEN_REGISTRY_MISMATCH");
      markets = [
        {
          token,
          quote: addr(state.pairToken),
          pool: addr(state.curve),
          creator: addr(state.deployer),
          stage: name === "PoolGraduated" ? "GRADUATED" : "SWEPT",
          marketKind: "BONDING_CURVE",
          extra: { destination: "uniswap-v4", positionId: a.positionId },
        },
      ];
    }
  } else if (deployment.family === "bags" && name === "TokenCreated") {
    const token = addr(a.token),
      curve = addr(a.curve);
    if (addr(await read("curveForToken", token)) !== curve)
      throw new Error("DISCOVERY_TOKEN_REGISTRY_MISMATCH");
    markets = [
      {
        token,
        quote: zeroAddress,
        pool: curve,
        creator: addr(a.creator),
        stage: "CURVE_CREATED",
        marketKind: "BONDING_CURVE",
        extra: {
          name: a.name,
          symbol: a.symbol,
          poolId: a.poolId,
          destination: "uniswap-v4",
        },
      },
    ];
  } else if (deployment.family === "doppler") {
    const token = addr(a.asset);
    const data = (await read("getAssetData", token)) as readonly unknown[];
    if (
      name === "Create" &&
      (addr(a.numeraire) !== addr(data[0]) ||
        addr(a.poolOrHook) !== addr(data[5]))
    )
      throw new Error("DISCOVERY_TOKEN_REGISTRY_MISMATCH");
    markets = [
      {
        token,
        quote: addr(data[0]),
        pool: addr(a.poolOrHook ?? a.pool),
        stage: name === "Migrate" ? "GRADUATED" : "LAUNCH_CREATED",
        marketKind: "HOOK_LAUNCH",
        extra: { initializer: a.initializer, frontend: "UNKNOWN" },
      },
    ];
  } else if (deployment.family === "long" && name === "LaunchCreated") {
    markets = [
      {
        token: addr(a.asset),
        quote: addr(a.numeraire),
        pool: addr(a.poolOrHook),
        stage: "LAUNCH_CREATED",
        marketKind: "HOOK_LAUNCH",
        extra: {
          initializer: a.poolInitializer,
          launcher: a.launcher,
          ticker: a.normalizedTicker,
          deployedAt: a.deployedAt,
          reservedUntil: a.reservedUntil,
        },
      },
    ];
  } else if (deployment.family === "pools-trade" && name === "TokenLaunched") {
    const key = a.key as Record<string, unknown>,
      token = addr(a.token),
      id = z
        .string()
        .regex(/^0x[\da-fA-F]{64}$/)
        .parse(a.poolId)
        .toLowerCase();
    if (poolIdentity(deployment.poolManagerAddress!, key) !== id)
      throw new Error("DISCOVERY_POOL_ID_MISMATCH");
    const t0 = addr(key.currency0),
      t1 = addr(key.currency1);
    if (token !== t0 && token !== t1)
      throw new Error("DISCOVERY_POOL_TOKEN_MISMATCH");
    markets = [
      {
        token,
        quote: token === t0 ? t1 : t0,
        pool: id,
        stage: "INSTANT_LAUNCHED",
        marketKind: "SINGLETON_POOL",
        extra: { poolId: id, manager: deployment.poolManagerAddress, ...key },
      },
    ];
  }
  const result: TokenDiscoveryEvent[] = [];
  for (const m of markets) {
    if (m.token === zeroAddress || m.quote === m.token)
      throw new Error("DISCOVERY_TOKEN_IDENTITY_INVALID");
    onRead();
    const code = await reader.request(
      "eth_getCode",
      [m.token, "latest"],
      z.string(),
    );
    if (code === "0x") throw new Error("DISCOVERY_TOKEN_CODE_MISSING");
    if (m.marketKind === "DEX_POOL" || m.marketKind === "BONDING_CURVE") {
      onRead();
      if (
        (await reader.request(
          "eth_getCode",
          [m.pool, "latest"],
          z.string(),
        )) === "0x"
      )
        throw new Error("DISCOVERY_MARKET_CODE_MISSING");
    }
    const quote = quotes.find((q) => q.address.toLowerCase() === m.quote);
    const native = m.quote === zeroAddress;
    const trusted = !!quote && quote.type !== "UNKNOWN";
    const stringify = JSON.parse(
      JSON.stringify(m.extra ?? {}, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ),
    ) as Record<string, unknown>;
    result.push({
      id: `rpc:${chain}:${deployment.id}:${m.pool}:${m.token}`,
      chainId: chain,
      dexId: deployment.id,
      tokenAddress: m.token,
      poolAddress: m.pool,
      quoteTokenAddress: quote?.address ?? m.quote,
      timestamp,
      chainTimestamp: timestamp,
      detectedAt: Date.now(),
      transactionId: log.transactionHash,
      source: "RPC",
      pairClassification: trusted ? "TRUSTED_QUOTE" : "UNKNOWN_PAIR",
      quoteAsset: {
        address: m.quote,
        symbol: quote?.symbol ?? (native ? nativeSymbol(chain) : "UNKNOWN"),
        type: quote?.type ?? (native ? "NATIVE" : "UNKNOWN"),
        trusted,
      },
      rawEvent: {
        ...stringify,
        name: text(m.extra?.name),
        symbol: text(m.extra?.symbol),
        protocol: deployment.family,
        sourceId: `${chain}:${deployment.id}`,
        marketKind: m.marketKind,
        stage: m.stage,
        creator: m.creator,
        creatorRole: m.creator ? "TOKEN_CREATOR" : undefined,
        controller: emitter,
        blockNumber: BigInt(log.blockNumber).toString(),
        blockHash: log.blockHash,
        logIndex: BigInt(log.logIndex).toString(),
        onchainEventAt: timestamp,
        observedAt: Date.now(),
        verifiedSource: deployment.verifiedSource,
      },
    });
  }
  return result;
}
