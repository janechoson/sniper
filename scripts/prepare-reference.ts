import { writeFile, mkdir } from "node:fs/promises";
import {
  parseAbi,
  encodeFunctionData,
  decodeFunctionResult,
  keccak256,
  type Address,
} from "viem";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { z } from "zod";
import { realConfigSchema, dexDeploymentSchema } from "@sniper/config";
import { JsonRpcClient, EvmFactoryDiscovery, RpcFailure } from "@sniper/chains";
import { EvmRouterSwapProvider } from "@sniper/dex";
const source = "https://developer.pancakeswap.finance/contracts/v2/addresses";
const deployments = [
  {
    chainId: "bnb",
    evmChainId: 56,
    rpc: "https://bsc-dataseed.bnbchain.org",
    factory: "0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73",
    router: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
  },
  {
    chainId: "robinhood",
    evmChainId: 4663,
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    factory: "0x02a84c1b3BBD7401a5f7fa98a384EBC70bB5749E",
    router: "0x8cFe327CEc66d1C090Dd72bd0FF11d690C33a2Eb",
  },
];
const abi = parseAbi([
  "function WETH() view returns (address)",
  "function factory() view returns (address)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function getReserves() view returns (uint112,uint112,uint32)",
]);
const hex = z
  .string()
  .regex(/^0x[\da-fA-F]*$/)
  .transform((s) => s as `0x${string}`);
const reference = realConfigSchema.parse({
  version: 1,
  quotes: {
    solana: [
      {
        address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        symbol: "USDC",
        decimals: 6,
      },
      { address: NATIVE_MINT.toBase58(), symbol: "WSOL", decimals: 9 },
    ],
  },
  deployments: [
    {
      id: "raydium-cpmm",
      chainId: "solana",
      family: "raydium-cpmm",
      programId: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
      verifiedSource: "https://github.com/raydium-io/raydium-idl",
    },
    {
      id: "meteora-dlmm",
      chainId: "solana",
      family: "meteora-dlmm",
      programId: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
      verifiedSource: "https://github.com/MeteoraAg/dlmm-sdk",
    },
  ],
  solana: {
    allowedPrograms: [
      SystemProgram.programId.toBase58(),
      ComputeBudgetProgram.programId.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
    ],
  },
});
const checks: unknown[] = [];
for (const d of deployments) {
  const rpc = new JsonRpcClient(`reference-${d.chainId}`, d.rpc, {
    rps: 5,
    timeoutMs: 5000,
  });
  try {
    if (
      BigInt(await rpc.request("eth_chainId", [], hex)) !== BigInt(d.evmChainId)
    )
      throw new Error("CHAIN_ID_MISMATCH");
    const router = d.router as Address,
      factory = d.factory as Address;
    const call = async (
      to: Address,
      name:
        | "WETH"
        | "factory"
        | "decimals"
        | "symbol"
        | "allPairsLength"
        | "token0"
        | "token1"
        | "getReserves",
    ) =>
      decodeFunctionResult({
        abi,
        functionName: name,
        data: await rpc.request(
          "eth_call",
          [
            { to, data: encodeFunctionData({ abi, functionName: name }) },
            "latest",
          ],
          hex,
        ),
      });
    const wrapped = z
      .string()
      .regex(/^0x[\da-fA-F]{40}$/)
      .parse(await call(router, "WETH"));
    const decimals = z
      .number()
      .int()
      .min(0)
      .max(255)
      .parse(await call(wrapped as Address, "decimals"));
    const symbol = z
      .string()
      .max(32)
      .parse(await call(wrapped as Address, "symbol"));
    const deployment = dexDeploymentSchema.parse({
      id: "pancakeswap-v2",
      chainId: d.chainId,
      family: "pancakeswap",
      factoryAddress: factory,
      routerAddress: router,
      verifiedSource: source,
    });
    const provider = new EvmRouterSwapProvider(rpc, {
      id: deployment.id,
      chainId: d.chainId,
      evmChainId: d.evmChainId,
      router,
      factory,
      family: "v2",
      quoteTtlMs: 30000,
    });
    const health = await provider.healthCheck();
    if (health.status !== "READY") throw new Error("DEPLOYMENT_NOT_VERIFIED");
    reference.deployments.push(deployment);
    reference.quotes[d.chainId] = [{ address: wrapped, symbol, decimals }];
    reference.execution.nativeUsdQuoteByChain[d.chainId] = wrapped;
    const code = await rpc.request("eth_getCode", [router, "latest"], hex);
    const head = BigInt(await rpc.request("eth_blockNumber", [], hex));
    const events: unknown[] = [];
    const cursors = new Map<string, string>();
    let discovery: unknown = { status: "CHECKED" };
    try {
      await new EvmFactoryDiscovery(
        d.chainId,
        rpc,
        {
          ...deployment,
          fromBlock: (head > 128n ? head - 128n : 0n).toString(),
        },
        reference.quotes[d.chainId]!,
        {
          readCursor: async (key) => cursors.get(key),
          writeCursor: async (key, value) => {
            cursors.set(key, value);
          },
        },
      ).poll(async (event) => {
        events.push(event);
      });
    } catch (error) {
      discovery = {
        status: "FAIL",
        reason:
          error instanceof RpcFailure
            ? error.reason
            : "DISCOVERY_VERIFICATION_FAILED",
      };
    }
    const length = z.bigint().parse(await call(factory, "allPairsLength"));
    let quoteCheck: unknown = {
      status: length === 0n ? "NO_PAIRS" : "NO_LIQUID_PAIR_IN_BOUNDED_SAMPLE",
    };
    for (let i = 0n; i < 10n && i < length; i++) {
      try {
        const pair = decodeFunctionResult({
          abi,
          functionName: "allPairs",
          data: await rpc.request(
            "eth_call",
            [
              {
                to: factory,
                data: encodeFunctionData({
                  abi,
                  functionName: "allPairs",
                  args: [i < 5n ? i : length - 1n - (i - 5n)],
                }),
              },
              "latest",
            ],
            hex,
          ),
        });
        const zero = z.string().parse(await call(pair, "token0")),
          one = z.string().parse(await call(pair, "token1"));
        const reserves = await call(pair, "getReserves");
        if (
          !Array.isArray(reserves) ||
          typeof reserves[0] !== "bigint" ||
          reserves[0] === 0n
        )
          continue;
        const amount = reserves[0] / 10000n;
        if (amount <= 0n) continue;
        const da = z
            .number()
            .int()
            .parse(await call(zero as Address, "decimals")),
          db = z
            .number()
            .int()
            .parse(await call(one as Address, "decimals"));
        const buy = await provider.getQuote({
          chainId: d.chainId,
          tokenIn: zero,
          tokenOut: one,
          amountIn: amount.toString(),
          decimalsIn: da,
          decimalsOut: db,
          slippageBps: 100,
        });
        const sell = await provider.getQuote({
          chainId: d.chainId,
          tokenIn: one,
          tokenOut: zero,
          amountIn: buy.minimumAmountOut,
          decimalsIn: db,
          decimalsOut: da,
          slippageBps: 100,
        });
        quoteCheck = {
          status: "REAL_QUOTES_RECEIVED",
          pool: pair,
          buy,
          sell,
          sellability: "UNKNOWN",
          evidence: "QUOTE_ONLY",
        };
        break;
      } catch {
        quoteCheck = { status: "NO_VALID_QUOTE_IN_BOUNDED_SAMPLE" };
      }
    }
    checks.push({
      chainId: d.chainId,
      status: "DEPLOYMENT_VERIFIED",
      source,
      health,
      routerCodeHash: keccak256(code),
      wrappedNative: { address: wrapped, symbol, decimals },
      factoryPairCount: length.toString(),
      events,
      discovery,
      quoteCheck,
      broadcast: false,
    });
  } catch (error) {
    checks.push({
      chainId: d.chainId,
      status: "FAIL",
      reason:
        error instanceof Error && /^[A-Z_]+$/.test(error.message)
          ? error.message
          : "REFERENCE_VERIFICATION_FAILED",
      broadcast: false,
    });
    process.exitCode = 2;
  } finally {
    rpc.close();
  }
}
await mkdir("config", { recursive: true });
await mkdir("data", { recursive: true });
await writeFile(
  "config/real.reference.json",
  JSON.stringify(reference, null, 2) + "\n",
);
await writeFile(
  "data/verify-deployments.json",
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      verificationOnly: true,
      broadcast: false,
      checks,
    },
    null,
    2,
  ) + "\n",
);
process.stdout.write(
  JSON.stringify(
    checks.map((check) =>
      z.object({ chainId: z.string(), status: z.string() }).parse(check),
    ),
    null,
    2,
  ) + "\n",
);
