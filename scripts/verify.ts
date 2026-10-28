import { parseArgs } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import {
  loadEnv,
  loadRuntimeEnv,
  chainsFromEnv,
  applyRpcConfiguration,
  loadRealConfig,
  realConfigSchema,
} from "@sniper/config";
import { ProductionChainAdapter, RecoveringRpcSocket } from "@sniper/chains";
import { TradingWallet, RpcWalletBalanceReader } from "@sniper/wallet";
import { EvmRouterSwapProvider, JupiterSwapProvider } from "@sniper/dex";
import { AtomicRouteEngine } from "@sniper/routing";
import type { SwapProvider } from "@sniper/core";
const command = process.argv[2];
const { values } = parseArgs({
  args: process.argv.slice(3),
  options: {
    "public-rpc": { type: "boolean" },
    chain: { type: "string" },
    input: { type: "string" },
    output: { type: "string" },
    amount: { type: "string" },
    "input-decimals": { type: "string" },
    "output-decimals": { type: "string" },
    save: { type: "string" },
  },
});
const input = {
  ...process.env,
  DATA_MODE: "real",
  TRADING_MODE: "paper",
  LIVE_DRY_RUN: "false",
  LIVE_TRADING_ACK: "false",
  AI_PROVIDER: "jev",
  MODE: undefined,
  DATA_SOURCE: undefined,
};
const env = loadRuntimeEnv(input),
  base = loadEnv(input);
const publicSources = {
  solana: {
    url: "https://api.mainnet.solana.com",
    source: "https://solana.com/docs/references/clusters",
  },
  bnb: {
    url: "https://bsc-dataseed.bnbchain.org",
    source:
      "https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/json-rpc-endpoint/",
  },
  robinhood: {
    url: "https://rpc.mainnet.chain.robinhood.com",
    source: "https://docs.robinhood.com/chain/connecting/",
  },
};
const config = await loadRealConfig(env.REAL_CONFIG_PATH).catch((error) => {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT")
    throw new Error("REAL_CONFIG_INVALID");
  return realConfigSchema.parse({ version: 1 });
});
const memoryCursors = new Map<string, string>();
const adapters = new Map(
  applyRpcConfiguration(chainsFromEnv(base), env).map((chain) => {
    const publicEndpoint =
      publicSources[chain.id as keyof typeof publicSources];
    const configured =
      values["public-rpc"] && publicEndpoint
        ? { ...chain, rpcHttpUrl: publicEndpoint.url, rpcWsUrl: undefined }
        : chain;
    return [
      chain.id,
      new ProductionChainAdapter(configured, config, env, {
        readCursor: async (key) => memoryCursors.get(key),
        writeCursor: async (key, value) => {
          memoryCursors.set(key, value);
        },
      }),
    ] as const;
  }),
);
const providers: SwapProvider[] = [];
let report: Record<string, unknown> = {
  verificationOnly: true,
  broadcast: false,
  source: "RPC",
  checkedAt: new Date().toISOString(),
};
try {
  if (["solana", "bnb", "robinhood"].includes(command ?? "")) {
    const chainId = command!;
    const adapter = adapters.get(chainId)!;
    const health = await adapter.healthCheck();
    const details: Record<string, unknown> = {};
    if (adapter.rpc) {
      if (chainId === "solana") {
        details.slot = await adapter.rpc.request(
          "getSlot",
          [{ commitment: "confirmed" }],
          z.number().int(),
        );
        details.observedGenesisHash = await adapter.rpc.request(
          "getGenesisHash",
          [],
          z.string(),
        );
        details.expectedGenesisConfigured =
          !!adapter.config.expectedGenesisHash;
      } else {
        details.evmChainId = Number(
          BigInt(await adapter.rpc.request("eth_chainId", [], z.string())),
        );
        details.block = BigInt(
          await adapter.rpc.request("eth_blockNumber", [], z.string()),
        ).toString();
      }
    }
    let websocket = { status: "NOT_CONFIGURED", reasons: ["WS_UNCONFIGURED"] };
    if (adapter.config.rpcWsUrl) {
      const socket = new RecoveringRpcSocket(
        "verify-ws",
        adapter.config.rpcWsUrl,
        5000,
      );
      try {
        await socket.connect();
        const off = await socket.subscribe(
          chainId === "solana" ? "slotSubscribe" : "eth_subscribe",
          chainId === "solana" ? [] : ["newHeads"],
          chainId === "solana" ? "slotNotification" : "eth_subscription",
          chainId === "solana" ? "slotUnsubscribe" : "eth_unsubscribe",
          async () => {},
        );
        websocket = {
          status: socket.health().status,
          reasons: socket.health().reasons,
        };
        await off();
      } catch {
        websocket = { status: "FAIL", reasons: ["WS_VERIFICATION_FAILED"] };
      } finally {
        await socket.close();
      }
    }
    report = {
      ...report,
      chainId,
      publicReference: values["public-rpc"]
        ? publicSources[chainId as keyof typeof publicSources].source
        : undefined,
      rpc: health,
      ...details,
      websocket,
      dexDeploymentsConfigured: config.deployments.filter(
        (d) => d.enabled && d.chainId === chainId,
      ).length,
      liveReady: false,
    };
    if (health.status !== "healthy") process.exitCode = 2;
  } else if (command === "wallets") {
    const manager = new TradingWallet(chainsFromEnv(loadEnv()), process.env);
    const wallets = await manager.list();
    const reader = new RpcWalletBalanceReader(
      new Map(
        [...adapters].flatMap(([id, a]) =>
          a.rpc ? [[id, a.rpc] as const] : [],
        ),
      ),
    );
    const checks = [];
    for (const wallet of wallets) {
      for (const chainId of wallet.chains) {
        const health = await manager.health(wallet.id, chainId);
        let balance;
        try {
          balance = await reader.read(wallet, chainId);
        } catch {
          balance = {
            quality: "UNKNOWN",
            reason: "RPC_OR_BALANCE_UNAVAILABLE",
          };
        }
        checks.push({ wallet, chainId, health, balance });
      }
    }
    report = {
      ...report,
      wallets: checks,
      status: wallets.length ? "CHECKED" : "NOT_CONFIGURED",
    };
    if (!wallets.length) process.exitCode = 2;
  } else if (command === "quotes") {
    const request = z
      .object({
        chainId: z.enum(["solana", "bnb", "robinhood"]),
        tokenIn: z.string().min(1),
        tokenOut: z.string().min(1),
        amountIn: z.string().regex(/^[1-9]\d*$/),
        decimalsIn: z.coerce.number().int().min(0).max(255),
        decimalsOut: z.coerce.number().int().min(0).max(255),
      })
      .parse({
        chainId: values.chain,
        tokenIn: values.input,
        tokenOut: values.output,
        amountIn: values.amount,
        decimalsIn: values["input-decimals"],
        decimalsOut: values["output-decimals"],
      });
    const adapter = adapters.get(request.chainId)!;
    if ((await adapter.healthCheck()).status !== "healthy" || !adapter.rpc)
      throw new Error("RPC_NOT_READY");
    if (request.chainId === "solana")
      providers.push(
        new JupiterSwapProvider(adapter.rpc, {
          apiKey: env.JUPITER_API_KEY,
          allowedPrograms: config.solana.allowedPrograms,
          quoteTtlMs: config.quoteTtlMs,
          maxPriorityFeeLamports: config.solana.maxPriorityFeeLamports,
        }),
      );
    else
      for (const d of config.deployments.filter(
        (d) => d.enabled && d.chainId === request.chainId,
      )) {
        if (
          !d.routerAddress ||
          !d.factoryAddress ||
          !["uniswap-v2", "uniswap-v3", "pancakeswap"].includes(d.family)
        )
          continue;
        providers.push(
          new EvmRouterSwapProvider(adapter.rpc, {
            id: d.id,
            chainId: d.chainId,
            evmChainId: adapter.config.evmChainId!,
            family: d.family === "uniswap-v3" ? "v3" : "v2",
            router: d.routerAddress as `0x${string}`,
            factory: d.factoryAddress as `0x${string}`,
            quoter: d.quoterAddress as `0x${string}` | undefined,
            quoteTtlMs: config.quoteTtlMs,
          }),
        );
      }
    const trip = await new AtomicRouteEngine(providers).roundTrip(
      { ...request, slippageBps: config.maxSlippageBps },
      10,
    );
    report = {
      ...report,
      chainId: request.chainId,
      buy: trip.buy,
      sell: trip.sell,
      sellability: trip.sellability,
      evidence: trip.evidence,
      roundTripLossPct: trip.roundTripLossPct,
      reasons: trip.reasons,
      liveReady: false,
    };
  } else throw new Error("VERIFY_COMMAND_REQUIRED");
} catch (error) {
  const reason =
    error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : error instanceof z.ZodError
        ? "VERIFY_ARGUMENTS_REQUIRED"
        : "READ_ONLY_VERIFICATION_FAILED";
  report = {
    ...report,
    status: "FAIL",
    reason,
    requiredArguments:
      command === "quotes"
        ? "--chain --input --output --amount --input-decimals --output-decimals"
        : undefined,
  };
  process.exitCode = 2;
} finally {
  for (const adapter of adapters.values()) await adapter.disconnect();
  for (const provider of providers)
    if (provider instanceof JupiterSwapProvider) provider.close();
}
const output = JSON.stringify(report, null, 2) + "\n";
process.stdout.write(output);
if (values.save) {
  const path = values.save;
  if (!/^data[\\/][a-zA-Z0-9_-]+\.json$/.test(path))
    throw new Error("VERIFY_OUTPUT_PATH_NOT_ALLOWED");
  await mkdir("data", { recursive: true });
  await writeFile(path, output);
}
