import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { ChainConfig } from "@sniper/core";
import { rugPolicySchema } from "@sniper/core";
const bool = z.preprocess(
  (value) =>
    value === undefined
      ? undefined
      : value === "true"
        ? true
        : value === "false"
          ? false
          : value,
  z.boolean(),
);
const optionalKey = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional(),
);
const optionalWsUrl = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().url().optional(),
);
export const runtimeEnvSchema = z
  .object({
    DATA_MODE: z.enum(["mock", "real"]).default("mock"),
    TRADING_MODE: z.enum(["paper", "live_dry_run", "live"]).default("paper"),
    LIVE_DRY_RUN: bool.default(false),
    LIVE_TRADING_ACK: bool.default(false),
    AI_PROVIDER: z.enum(["mock", "jev"]).optional(),
    OBSERVATION_ONLY: bool.default(false),
    OBSERVATION_AUTO_START: bool.default(false),
    OBSERVATION_AI_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(5000)
      .max(3600000)
      .default(20000),
    IMPORT_LEGACY_JOURNAL: bool.default(false),
    TYPESAFE_API_KEY: optionalKey,
    JEV_MODEL: z.string().min(1).max(80).default("jev-1.14.0"),
    JEV_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(3000),
    SOLANA_RPC_HTTP: z.string().url().optional(),
    SOLANA_RPC_WS: optionalWsUrl,
    BNB_RPC_HTTP: z.string().url().optional(),
    BNB_RPC_WS: optionalWsUrl,
    ROBINHOOD_RPC_HTTP: z.string().url().optional(),
    ROBINHOOD_RPC_WS: optionalWsUrl,
    SOLANA_EXPECTED_GENESIS_HASH: z.string().optional(),
    REAL_CONFIG_PATH: z.string().default("config/real.json"),
    EVM_PRIVATE_KEY: optionalKey,
    SOLANA_PRIVATE_KEY: optionalKey,
    EVM_WALLET_ADDRESS: optionalKey,
    SOLANA_WALLET_ADDRESS: optionalKey,
    JUPITER_API_KEY: z.string().optional(),
    RUN_LIVE_TESTS: bool.default(false),
    RPC_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(7000),
    RPC_REQUESTS_PER_SECOND: z.coerce.number().int().min(1).max(100).default(5),
    RPC_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
    MODE: z.enum(["PAPER", "LIVE_DRY_RUN", "LIVE"]).optional(),
    DATA_SOURCE: z.enum(["MOCK", "RPC"]).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.DATA_MODE === "mock" &&
      (value.TRADING_MODE !== "paper" || value.LIVE_DRY_RUN)
    )
      ctx.addIssue({
        code: "custom",
        message: "Dry-run và LIVE bắt buộc dữ liệu thật",
      });
    if (
      value.OBSERVATION_ONLY &&
      (value.DATA_MODE !== "real" ||
        value.TRADING_MODE !== "paper" ||
        value.LIVE_DRY_RUN ||
        value.LIVE_TRADING_ACK)
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Quan sát chỉ dùng dữ liệu thật/PAPER, không cho phép bật LIVE hoặc dry-run",
      });
    if (value.TRADING_MODE === "live" && !value.LIVE_TRADING_ACK)
      ctx.addIssue({
        code: "custom",
        message: "LIVE yêu cầu LIVE_TRADING_ACK=true",
      });
    if (value.TRADING_MODE === "live" && value.LIVE_DRY_RUN)
      ctx.addIssue({
        code: "custom",
        message: "Không kết hợp LIVE và LIVE_DRY_RUN=true",
      });
    if (value.DATA_MODE === "real" && value.AI_PROVIDER === "mock")
      ctx.addIssue({
        code: "custom",
        message: "Không cho phép AI giả lập trong chế độ dữ liệu thật",
      });
  });
export type RuntimeEnv = z.infer<typeof runtimeEnvSchema>;
export function loadRuntimeEnv(
  input: Record<string, string | undefined> = process.env,
): RuntimeEnv {
  const key = input.TYPESAFE_API_KEY?.trim()
      ? input.TYPESAFE_API_KEY
      : undefined,
    legacy = input.JEV_API_KEY?.trim() ? input.JEV_API_KEY : undefined;
  if (key && legacy && key !== legacy)
    throw new Error(
      "TYPESAFE_API_KEY và JEV_API_KEY xung đột; chỉ giữ TYPESAFE_API_KEY",
    );
  const real = input.DATA_MODE === "real";
  const value = runtimeEnvSchema.parse({
    ...input,
    TYPESAFE_API_KEY: key ?? legacy,
    AI_PROVIDER: input.AI_PROVIDER ?? (real ? "jev" : "mock"),
  });
  if (input.MODE && input.MODE !== "PAPER" && input.TRADING_MODE === undefined)
    throw new Error(
      "Dùng TRADING_MODE để bật chế độ thực thi mới một cách rõ ràng",
    );
  if (real && input.DATA_SOURCE && input.DATA_SOURCE !== "RPC")
    throw new Error(
      "DATA_MODE=real không tương thích DATA_SOURCE=MOCK; bỏ biến cũ hoặc đặt RPC",
    );
  if (!real && input.DATA_SOURCE === "RPC")
    throw new Error("DATA_SOURCE=RPC yêu cầu DATA_MODE=real");
  if (input.MODE && input.TRADING_MODE && input.MODE !== operationalMode(value))
    throw new Error("MODE cũ xung đột TRADING_MODE; bỏ biến MODE");
  return value;
}
export const operationalMode = (
  env: RuntimeEnv,
): "PAPER" | "LIVE_DRY_RUN" | "LIVE" =>
  env.LIVE_DRY_RUN || env.TRADING_MODE === "live_dry_run"
    ? "LIVE_DRY_RUN"
    : env.TRADING_MODE === "live"
      ? "LIVE"
      : "PAPER";
export const trustedQuoteSchema = z
  .object({
    address: z.string().min(1),
    symbol: z.string().min(1).max(32),
    decimals: z.number().int().min(0).max(255),
    type: z
      .enum([
        "NATIVE",
        "WRAPPED_NATIVE",
        "STABLECOIN",
        "TOKENIZED_ASSET",
        "ERC20",
        "UNKNOWN",
      ])
      .optional(),
    usdPrice: z
      .string()
      .regex(/^\d+(\.\d{1,18})?$/)
      .optional(),
    priceSource: z.string().optional(),
    priceVerifiedAt: z.number().optional(),
    priceObservation: z
      .object({
        asset: z.string(),
        source: z.string(),
        sourceChain: z.string().optional(),
        observedAt: z.number().int(),
        maxAgeMs: z.number().positive(),
        status: z.literal("VALID"),
        confidenceBps: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
    coinbaseOracle: z
      .object({
        product: z.enum(["SOL-USD", "ETH-USD", "USDC-USD"]),
        maxAgeSec: z.number().int().min(1).max(60),
        maxSpreadBps: z.number().int().positive().max(100),
      })
      .strict()
      .optional(),
    usdOracle: z
      .object({
        chainId: z.string().min(1),
        address: z.string().regex(/^0x[\da-fA-F]{40}$/),
        expectedDescription: z.string().min(1).max(100),
        maxAgeSec: z.number().int().min(1).max(86400),
        verifiedSource: z.string().url(),
      })
      .strict()
      .optional(),
  })
  .strict();
export const dexDeploymentSchema = z
  .object({
    id: z.string().min(1),
    chainId: z.string().min(1),
    family: z.enum([
      "uniswap-v2",
      "uniswap-v3",
      "pancakeswap",
      "raydium-cpmm",
      "meteora-dlmm",
      "pump-fun",
      "pump-swap",
      "uniswap-v4",
      "pancakeswap-infinity-cl",
      "pancakeswap-infinity-bin",
      "four-meme",
      "openfour",
      "flap",
      "pons-v2",
      "bags",
      "doppler",
      "long",
      "pools-trade",
    ]),
    factoryAddress: z.string().optional(),
    poolManagerAddress: z
      .string()
      .regex(/^0x[\da-fA-F]{40}$/)
      .optional(),
    discoveryOnly: z.boolean().default(false),
    registryAddress: z
      .string()
      .regex(/^0x[\da-fA-F]{40}$/)
      .optional(),
    routerAddress: z.string().optional(),
    quoterAddress: z.string().optional(),
    programId: z.string().optional(),
    idlPath: z.string().optional(),
    poolEvent: z.string().optional(),
    poolField: z.string().optional(),
    tokenAField: z.string().optional(),
    tokenBField: z.string().optional(),
    tokenVaultAField: z.string().optional(),
    tokenVaultBField: z.string().optional(),
    accountType: z.string().optional(),
    fromBlock: z.string().regex(/^\d+$/).optional(),
    initialLookbackBlocks: z.number().int().min(0).max(2000).default(0),
    confirmationDepth: z.number().int().min(0).max(100).default(2),
    verifiedSource: z.string().url(),
    enabled: z.boolean().default(true),
  })
  .strict();
export const realConfigSchema = z
  .object({
    discoveryArchiveRpcByChain: z
      .record(z.string(), z.string().url())
      .default({}),
    rugCheck: z
      .object({
        enabled: z.boolean().default(true),
        policy: rugPolicySchema.default(() => rugPolicySchema.parse({})),
        policyByChain: z
          .record(
            z.string(),
            z.partialRecord(rugPolicySchema.keyof(), z.unknown()),
          )
          .default({}),
        external: z
          .object({
            goplus: z.boolean().default(false),
            honeypot: z.boolean().default(false),
            rugcheck: z.boolean().default(false),
          })
          .default({ goplus: false, honeypot: false, rugcheck: false }),
        providerTimeoutMs: z.number().int().min(500).max(15000).default(5000),
        exclusions: z
          .array(
            z.object({
              chainId: z.string(),
              address: z.string().max(150),
              kind: z.enum(["POOL", "BURN", "ROUTER", "SYSTEM", "PROTOCOL"]),
              verifiedSource: z.string().url(),
            }),
          )
          .max(100)
          .default([]),
        monitorIntervalMs: z
          .number()
          .int()
          .min(5000)
          .max(300000)
          .default(15000),
      })
      .strict()
      .superRefine((value, ctx) => {
        for (const [chain, override] of Object.entries(value.policyByChain)) {
          const parsed = rugPolicySchema.safeParse({
            ...value.policy,
            ...override,
          });
          if (!parsed.success)
            for (const issue of parsed.error.issues)
              ctx.addIssue({
                code: "custom",
                path: ["policyByChain", chain, ...issue.path],
                message: issue.message,
              });
        }
      })
      .default(() => ({
        enabled: true,
        policy: rugPolicySchema.parse({}),
        policyByChain: {},
        external: { goplus: false, honeypot: false, rugcheck: false },
        providerTimeoutMs: 5000,
        exclusions: [],
        monitorIntervalMs: 15000,
      })),
    version: z.literal(1),
    quotes: z
      .record(z.string(), z.array(trustedQuoteSchema).max(30))
      .default({}),
    deployments: z.array(dexDeploymentSchema).max(30).default([]),
    solana: z
      .object({
        jupiterBaseUrl: z
          .literal("https://api.jup.ag/swap/v2")
          .default("https://api.jup.ag/swap/v2"),
        allowedPrograms: z.array(z.string()).max(100).default([]),
        allowedDexes: z.array(z.string().min(1)).max(30).default([]),
        maxPriorityFeeLamports: z.string().regex(/^\d+$/).default("0"),
      })
      .default({
        jupiterBaseUrl: "https://api.jup.ag/swap/v2",
        allowedPrograms: [],
        allowedDexes: [],
        maxPriorityFeeLamports: "0",
      }),
    maxPools: z.number().int().min(1).max(5000).default(300),
    maxObservationsPerPool: z.number().int().min(10).max(20000).default(2000),
    maxSlippageBps: z.number().int().min(0).max(2000).default(100),
    quoteTtlMs: z.number().int().min(1000).max(30000).default(10000),
    maxRoundTripLossPct: z.number().min(0).max(100).default(5),
    requireSellSimulation: z.boolean().default(true),
    execution: z
      .object({
        requireWebsocketForLive: z.boolean().default(false),
        liveChains: z.array(z.enum(["solana", "bnb", "robinhood"])).default([]),
        maxGasWeiByChain: z
          .record(z.string(), z.string().regex(/^[1-9]\d*$/))
          .default({}),
        // Base units of native coin; explicit policy, no implicit USD reserve.
        nativeFeeReserveByChain: z
          .record(z.string(), z.string().regex(/^[1-9]\d*$/))
          .default({}),
        nativeUsdQuoteByChain: z
          .record(z.string(), z.string().min(1))
          .default({}),
        solanaMaxFeeLamports: z
          .string()
          .regex(/^[1-9]\d*$/)
          .optional(),
        solanaMaxNativeDebitLamports: z
          .string()
          .regex(/^[1-9]\d*$/)
          .optional(),
        solanaAllowedAccountOwners: z.array(z.string()).default([]),
      })
      .default({
        requireWebsocketForLive: false,
        liveChains: [],
        maxGasWeiByChain: {},
        nativeFeeReserveByChain: {},
        nativeUsdQuoteByChain: {},
        solanaAllowedAccountOwners: [],
      }),
  })
  .strict();
export type RealConfig = z.infer<typeof realConfigSchema>;
export type DexDeploymentConfig = z.infer<typeof dexDeploymentSchema>;
export type TrustedQuoteAsset = z.infer<typeof trustedQuoteSchema>;
export function productionPriceAllowed(
  chainId: string,
  asset: TrustedQuoteAsset,
) {
  const p = asset.priceObservation;
  return (
    !!p &&
    p.status === "VALID" &&
    p.observedAt <= Date.now() + 1000 &&
    Date.now() - p.observedAt <= p.maxAgeMs &&
    !!asset.usdPrice &&
    Number(asset.usdPrice) > 0 &&
    (asset.coinbaseOracle !== undefined
      ? p.source === "EXTERNAL:COINBASE_EXCHANGE" &&
        p.asset === asset.coinbaseOracle.product
      : asset.usdOracle?.chainId === chainId &&
        p.source === "REAL_ONCHAIN:CHAINLINK" &&
        p.sourceChain === chainId)
  );
}
export async function loadRealConfig(path: string): Promise<RealConfig> {
  const content = await readFile(path, "utf8");
  if (content.length > 2_000_000)
    throw new Error("Cấu hình dữ liệu thật quá lớn");
  return realConfigSchema.parse(JSON.parse(content));
}
export function applyRpcConfiguration(
  chains: ChainConfig[],
  env: RuntimeEnv,
): ChainConfig[] {
  const urls: Record<string, { http?: string; ws?: string }> = {
    solana: { http: env.SOLANA_RPC_HTTP, ws: env.SOLANA_RPC_WS },
    bnb: { http: env.BNB_RPC_HTTP, ws: env.BNB_RPC_WS },
    robinhood: { http: env.ROBINHOOD_RPC_HTTP, ws: env.ROBINHOOD_RPC_WS },
  };
  return chains.map((chain) => ({
    ...chain,
    rpcHttpUrl: urls[chain.id]?.http ?? chain.rpcHttpUrl,
    rpcWsUrl: urls[chain.id]?.ws ?? chain.rpcWsUrl,
    ...(chain.id === "robinhood"
      ? { evmChainId: chain.evmChainId ?? 4663, nativeSymbol: "ETH" }
      : {}),
    ...(chain.id === "solana"
      ? { expectedGenesisHash: env.SOLANA_EXPECTED_GENESIS_HASH }
      : {}),
  }));
}
